import { makeBeatMap } from '../core/musictime.js';

// MIDI beat clock: 24 pulses per quarter note.
export const CLOCK_PPQ = 24;

// Pure math only: no Web MIDI, no AudioContext, no navigator. Runs in Node tests.
export class ClockEstimator {
  constructor(windowSize = CLOCK_PPQ) {
    this.windowSize = windowSize;
    this.gaps = [];
    this.pulseCount = 0;
    this.lastMs = null;
  }

  push(timestampMs) {
    if (!Number.isFinite(timestampMs)) return;
    this.pulseCount++;
    if (this.lastMs != null) {
      const gap = timestampMs - this.lastMs;
      if (gap > 0) {
        this.gaps.push(gap);
        if (this.gaps.length > this.windowSize) this.gaps.shift();
      }
    }
    this.lastMs = timestampMs;
  }

  // Median of the last `windowSize` inter-pulse gaps -> ms/pulse -> bpm.
  // Median (not mean) so dropped/duplicated pulses cannot skew the estimate.
  bpm() {
    if (!this.gaps.length) return null;
    const sorted = [...this.gaps].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return 60000 / (median * CLOCK_PPQ);
  }

  isStable() {
    return this.pulseCount >= CLOCK_PPQ;
  }

  reset() {
    this.gaps.length = 0;
    this.pulseCount = 0;
    this.lastMs = null;
  }
}

// Plans the audio-clock seconds at which 0xF8 pulses fall, assuming the
// transport started at second 0 aligned to tick 0.
export class ClockSender {
  // plan({startSec, endSec, bpm}) -> [t0, t1, ...] with startSec <= t < endSec.
  // Half-open windows tile the timeline without duplicates or gaps: a tick
  // landing exactly on a window boundary belongs to the LATER window. The tau
  // slack absorbs float64 noise (well above ulp, far below musical relevance),
  // so adjacent windows produced by this method never double-emit a tick.
  // Precondition: window length is sane for the bpm (caller's responsibility).
  plan({ startSec, endSec, bpm }) {
    if (!Number.isFinite(bpm) || !(bpm > 0)) throw new Error('clocksync.plan: bpm must be > 0');
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || !(endSec > startSec)) return [];
    const step = 60 / (bpm * CLOCK_PPQ);
    const tau = 1e-9;
    let k = Math.ceil((startSec - tau) / step);
    const out = [];
    while (k * step < endSec - tau) {
      out.push(k * step);
      k++;
    }
    return out;
  }
}

// Beat <-> seconds mapping under tempo changes, using Gridpulse's append-only
// anchor model ({beat, time, bpm}); see src/core/musictime.js makeBeatMap and
// TIMING_CONTRACT.md. setBpm appends an anchor instead of overwriting state,
// so the mapping stays continuous and already-mapped positions never move.
export class TransportMapper {
  constructor(bpm) {
    if (!Number.isFinite(bpm) || !(bpm > 0)) throw new Error('clocksync.TransportMapper: bpm must be > 0');
    this._anchors = [{ beat: 0, time: 0, bpm }];
    this._map = makeBeatMap(this._anchors);
  }

  get bpm() {
    return this._anchors[this._anchors.length - 1].bpm;
  }

  get anchors() {
    return this._anchors.map(a => ({ ...a }));
  }

  // New tempo takes effect immediately at `atBeat` (default: the current
  // frontier, i.e. the last anchor's beat). Continuity: beatToSec(atBeat) is
  // identical before and after; positions before atBeat are untouched.
  setBpm(bpm, atBeat) {
    if (!Number.isFinite(bpm) || !(bpm > 0)) throw new Error('clocksync.TransportMapper: bpm must be > 0');
    const last = this._anchors[this._anchors.length - 1];
    if (atBeat === undefined) atBeat = last.beat;
    if (!Number.isFinite(atBeat) || atBeat < 0) throw new Error('clocksync.TransportMapper: atBeat must be a finite number >= 0');
    if (atBeat < last.beat) throw new Error('clocksync.TransportMapper: anchors must be non-decreasing in beat');
    if (bpm === last.bpm) return this;
    this._anchors.push({ beat: atBeat, time: this._map.beatToSec(atBeat), bpm });
    this._map = makeBeatMap(this._anchors);
    return this;
  }

  beatToSec(beat) {
    return this._map.beatToSec(beat);
  }

  secToBeat(sec) {
    return this._map.secToBeat(sec);
  }
}
