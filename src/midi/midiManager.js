// Browser-only Web MIDI bridge for Gridpulse. Import-safe anywhere (including
// Node): nothing touches `navigator` at module scope, only inside init().

const CLOCK = 0xf8; // timing clock pulse
const START = 0xfa; // transport start
const STOP = 0xfc;  // transport stop

// TIMING CAVEAT (read before changing): setTimeout here is a MESSAGE-EMISSION
// scheduler only, never musical timing. Browsers clamp timers (~4ms+ active,
// far coarser in background tabs), so emitted 0xF8 pulses carry small arrival
// jitter. Receivers are expected to tolerate this: they derive tempo from
// pulse-gap statistics (ClockEstimator medians over 24 gaps) and must anchor
// musical time on their own transport, not on absolute arrival times.
export class MidiManager {
  constructor(handlers = {}) {
    this._h = {
      onNoteOn: typeof handlers.onNoteOn === 'function' ? handlers.onNoteOn : () => {},
      onNoteOff: typeof handlers.onNoteOff === 'function' ? handlers.onNoteOff : () => {},
      onClockPulse: typeof handlers.onClockPulse === 'function' ? handlers.onClockPulse : () => {},
      onStart: typeof handlers.onStart === 'function' ? handlers.onStart : () => {},
      onStop: typeof handlers.onStop === 'function' ? handlers.onStop : () => {},
      onStateChange: typeof handlers.onStateChange === 'function' ? handlers.onStateChange : () => {},
    };
    this._access = null;
    this._input = null;
    this._inputId = null;
    this._output = null;
    this._outputId = null;
    this._inputs = new Map();
    this._outputs = new Map();
    // Every listener registration is tracked as {obj, prop, prev} so stopAll()
    // restores exactly the pre-binding state: zero dangling references.
    this._bindings = [];
    this._timers = new Set();
    this._sendInterval = null;
    this._sending = false;
    this._getPlan = null;
    this._senderBpm = 120;
    this._windowSec = 0.15;
    this._tickMs = 50;
    this._horizonSec = 0;
  }

  // Request Web MIDI access. Never throws; resolves to:
  //   { ok: true, inputId, inputs, outputs }
  //   { ok: false, reason } with reason in ['unsupported', 'permission-denied', 'error']
  async init() {
    try {
      if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
        return { ok: false, reason: 'unsupported' };
      }
      const access = await navigator.requestMIDIAccess({ sysex: false });
      if (!access) return { ok: false, reason: 'error' };
      this._access = access;
      this.refreshPorts();
      this._bindFirstInput();
      const accessRef = access;
      this._track(accessRef, 'onstatechange', ev => this._handleStateChange(ev));
      return { ok: true, inputId: this._inputId, inputs: this.listInputs(), outputs: this.listOutputs() };
    } catch (err) {
      const name = err && err.name;
      const reason = name === 'NotAllowedError' || name === 'SecurityError' ? 'permission-denied' : 'error';
      this._h.onStateChange(`midi init failed: ${reason}`);
      return { ok: false, reason };
    }
  }

  _track(obj, prop, fn) {
    this._bindings.push({ obj, prop, prev: obj[prop] });
    try {
      obj[prop] = fn;
    } catch (err) {
      this._bindings.pop();
      throw err;
    }
  }

  refreshPorts() {
    this._inputs.clear();
    this._outputs.clear();
    if (!this._access) return;
    for (const port of this._access.inputs.values()) this._inputs.set(port.id, port);
    for (const port of this._access.outputs.values()) this._outputs.set(port.id, port);
  }

  listInputs() {
    return [...this._inputs.values()].map(p => ({ id: p.id, name: p.name, state: p.state }));
  }

  listOutputs() {
    return [...this._outputs.values()].map(p => ({ id: p.id, name: p.name, state: p.state }));
  }

  setOutput(id) {
    const port = this._outputs.get(id);
    if (!port) return false;
    this._output = port;
    this._outputId = id;
    return true;
  }

  get outputId() {
    return this._outputId;
  }

  get inputId() {
    return this._inputId;
  }

  _bindFirstInput() {
    if (this._input) return true;
    for (const port of this._inputs.values()) {
      if (port.state !== 'connected') continue;
      this._input = port;
      this._inputId = port.id;
      this._track(port, 'onmidimessage', ev => this._onMessage(ev));
      this._h.onStateChange(`bound input: ${port.name || port.id}`);
      return true;
    }
    return false;
  }

  _handleStateChange(ev) {
    try {
      this.refreshPorts();
      const port = ev && ev.port;
      if (!this._input && port && port.type === 'input' && port.state === 'connected') {
        this._bindFirstInput();
      }
      if (this._input && !this._inputs.has(this._inputId)) {
        this._input = null;
        this._inputId = null;
        this._h.onStateChange('input lost');
      }
      const label = port && (port.name || port.id) || 'midi';
      this._h.onStateChange(`${label}: ${port && port.state || 'statechange'}`);
    } catch (err) {
      this._h.onStateChange(`statechange handler error: ${err && err.message}`);
    }
  }

  _onMessage(ev) {
    try {
      const data = ev.data;
      if (!data || data.length < 1) return;
      const status = data[0];
      if (status === CLOCK) return this._h.onClockPulse();
      if (status === START) return this._h.onStart();
      if (status === STOP) return this._h.onStop();
      const kind = status & 0xf0;
      if (kind === 0x90 && data.length >= 3) {
        const note = data[1], velocity = data[2];
        if (velocity > 0) return this._h.onNoteOn(note, velocity / 127);
        return this._h.onNoteOff(note);
      }
      if (kind === 0x80 && data.length >= 3) return this._h.onNoteOff(data[1]);
    } catch (err) {
      this._h.onStateChange(`message handler error: ${err && err.message}`);
    }
  }

  sendBytes(bytes) {
    if (!this._output) return false;
    try {
      this._output.send(bytes);
      return true;
    } catch (err) {
      this._h.onStateChange(`send failed: ${err && err.message}`);
      return false;
    }
  }

  // ---- Send-clock mode ----------------------------------------------------
  //
  // startSending(getPlan) begins emitting FA + a stream of 0xF8 pulses.
  // `getPlan({ windowStartSec, windowEndSec, bpm })` is called once per window
  // and MUST return delay-ms offsets relative to "now" (performance.now()
  // domain) for the pulses falling in that half-open window; the caller maps
  // its audio-clock seconds to delays via its own transport anchor, treating
  // windowStartSec as seconds since startSending() was invoked.
  startSending(getPlan, opts = {}) {
    if (typeof getPlan !== 'function') throw new TypeError('startSending: getPlan must be a function');
    this.stopSending();
    this._getPlan = getPlan;
    if (opts.bpm > 0) this._senderBpm = opts.bpm;
    if (opts.windowSec > 0.001) this._windowSec = opts.windowSec;
    if (opts.tickMs >= 4) this._tickMs = opts.tickMs;
    this._horizonSec = 0;
    this._sending = true;
    this.sendBytes([START]);
    this._scheduleWindow(); // prime immediately so pulses start promptly
    this._sendInterval = setInterval(() => this._scheduleWindow(), this._tickMs);
  }

  setSenderBpm(bpm) {
    if (Number.isFinite(bpm) && bpm > 0) this._senderBpm = bpm;
  }

  get sending() {
    return this._sending;
  }

  _scheduleWindow() {
    if (!this._sending || !this._getPlan) return;
    const wStart = this._horizonSec;
    const wEnd = wStart + this._windowSec;
    let delays;
    try {
      delays = this._getPlan({ windowStartSec: wStart, windowEndSec: wEnd, bpm: this._senderBpm }) || [];
    } catch (err) {
      this._h.onStateChange(`getPlan error: ${err && err.message}`);
      return;
    }
    this._horizonSec = wEnd; // horizon advances additively: interval jitter cannot duplicate windows
    for (const raw of delays) {
      const delay = Math.max(0, Number(raw) || 0);
      const id = setTimeout(() => {
        this._timers.delete(id);
        this.sendBytes([CLOCK]);
      }, delay);
      this._timers.add(id);
    }
  }

  stopSending() {
    this._sending = false;
    this._getPlan = null;
    if (this._sendInterval != null) {
      clearInterval(this._sendInterval);
      this._sendInterval = null;
    }
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    if (this._access) this.sendBytes([STOP]);
  }

  // ---- Teardown -----------------------------------------------------------

  stopAll() {
    this._sending = false;
    this._getPlan = null;
    if (this._sendInterval != null) {
      clearInterval(this._sendInterval);
      this._sendInterval = null;
    }
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    while (this._bindings.length) {
      const b = this._bindings.pop();
      try {
        b.obj[b.prop] = b.prev;
      } catch {
        // port/access already gone; nothing to restore
      }
    }
    this._input = null;
    this._inputId = null;
    this._output = null;
    this._outputId = null;
    this._inputs.clear();
    this._outputs.clear();
    this._access = null;
  }

  dispose() {
    this.stopAll();
  }
}
