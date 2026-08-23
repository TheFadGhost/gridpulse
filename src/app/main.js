import { AppStore } from './store.js';
import { defaultProject, makePattern, patternSteps } from '../core/model.js';
import { Scheduler } from '../audio/scheduler.js';
import { createEngine } from '../audio/engine.js';
import { createDrumVoice, KIT_PIECES } from '../audio/voices/kit.js';
import { createSynthVoice } from '../audio/voices/synthvoice.js';
import { createSamplerVoice } from '../audio/voices/samplervoice.js';
import { createMetroVoice } from '../audio/voices/metrovoice.js';
import { eventPrng } from '../core/eventrng.js';
import { mulberry32 } from '../core/rng.js';
import { createStepGrid } from '../ui/grid.js';
import { createPianoRoll } from '../ui/pianoroll.js';
import { createMixer } from '../ui/mixer.js';
import { createSoundBay } from '../ui/soundbay.js';
import { createTransport } from '../ui/transport.js';
import { THEMES, applyTheme, currentTheme, initTheme } from '../ui/theme.js';
import { SCALES, NOTE_NAMES } from '../core/scales.js';
import { MidiManager } from '../midi/midiManager.js';
import { ClockEstimator, ClockSender } from '../midi/clocksync.js';
import { writePatternSMF, PPQ } from '../midi/smf.js';
import {
  projectDurationSec, renderProjectToWavBlob
} from '../render/offlineRenderer.js';
import {
  sanitizeSlotName, listLocalSlots, saveToLocalSlot, loadFromLocalSlot,
  deleteLocalSlot, downloadProjectJSON, readProjectFile,
  embedSamples, extractEmbeddedSamples
} from '../io/projectio.js';
import { loadSampleFile, decodeSampleBytes } from '../audio/samplelib.js';
import { buildSchedulerView } from '../audio/view.js';
import { downloadBlob as dl } from '../ui/download.js';
import { base64ToBytes } from '../core/b64.js';
import { snapToScale } from '../core/scales.js';


function stepsPerBeatOf(den) { return Math.max(1, Math.round(16 / den)); }
function beatsPerBarOf(num, den) { return num * den / 4; }

function schedulerView() {
  const v = buildSchedulerView(store.getProject(), store.selectedPatternId);
  if (stepRepeat.enabled) {
    for (const t of v.tracks) {
      const ov = stepRepeat.overrides.get(t.id);
      if (ov) t.repeatOverride = ov;
    }
  }
  return v;
}



const $ = id => document.getElementById(id);

const store = new AppStore(defaultProject());
let engine = null;
let scheduler = null;
let tickerWorker = null;
let voices = new Map();
let metroVoice = null;
let sampleBuffers = new Map();
let rafId = 0;
let meterTimer = 0;
let playing = false;
let selectedTrackId = store.getProject().tracks[0].id;
let key = 9;
let scaleName = 'minor';
let clipboardRange = null;
let midi = null;
let estimator = new ClockEstimator();
let clockSender = null;
let sendClockEnabled = false;
let extSyncEnabled = false;
let recQuantize = false;
let embedSamplesOnSave = false;
let seedCounter = store.getProject().seed;
let tapTimes = [];
let headroom = { ema: 0, max: 0 };
const stepRepeat = { enabled: false, overrides: new Map() };
let ui = {};

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'gp-toast';
  el.dataset.kind = kind;
  el.textContent = msg;
  $('toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-shown'));
  setTimeout(() => { el.classList.remove('is-shown'); setTimeout(() => el.remove(), 220); }, 4200);
}
function announce(text) { $('live-region').textContent = text; }

function buildHelp() {
  $('help').innerHTML = `
  <h2 class="gp-title">Gridpulse key map</h2>
  <table>
    <tr><td>Space</td><td>play / stop</td></tr>
    <tr><td>T</td><td>tap tempo</td></tr>
    <tr><td>M</td><td>metronome on/off</td></tr>
    <tr><td>? (shift+/)</td><td>this help</td></tr>
    <tr><td>Ctrl+Z / Ctrl+Y</td><td>undo / redo</td></tr>
    <tr><td>G</td><td>focus step grid</td></tr>
    <tr><td>P</td><td>focus piano roll</td></tr>
<tr><td colspan="2">- grid -</td></tr>
    <tr><td>arrows</td><td>move cell cursor</td></tr>
    <tr><td>Space / Enter</td><td>toggle step</td></tr>
    <tr><td>[ ]</td><td>nudge -/+ 10 ms</td></tr>
    <tr><td>{ }</td><td>probability down / up</td></tr>
    <tr><td>r</td><td>cycle ratchet 1..4</td></tr>
    <tr><td>c / v</td><td>copy / paste steps</td></tr>
    <tr><td>Esc</td><td>clear selection</td></tr>
<tr><td colspan="2">- mouse modifiers -</td></tr>
    <tr><td>Shift+click</td><td>cycle velocity 40/70/100%</td></tr>
    <tr><td>Alt+click</td><td>cycle probability 100/50/25%</td></tr>
    <tr><td>Ctrl+click</td><td>cycle ratchet 1-4</td></tr>
  </table>
  <p class="gp-label" style="margin-top:12px">Close: Esc</p>`;
}

function buildTransportBar() {
  const bar = $('transport-bar');
  bar.innerHTML = '';
  ui.transportMount = document.createElement('div');
  bar.appendChild(ui.transportMount);

  const tools = document.createElement('div');
  tools.className = 'gp-label';
  tools.style.cssText = 'display:flex;align-items:center;gap:6px;';
  tools.innerHTML = `<span>Track tools</span>`;
  const mkBtn = (txt, title) => {
    const b = document.createElement('button');
    b.className = 'gp-mini'; b.textContent = txt; b.title = title;
    return b;
  };
  const bRnd = mkBtn('RND', 'Randomize selected track (bounded ranges)');
  const bHum = mkBtn('HUM', 'Humanize selected track');
  const bUndo = mkBtn('UNDO', 'Undo (Ctrl+Z)');
  const bRedo = mkBtn('REDO', 'Redo (Ctrl+Y)');
  bRnd.onclick = () => { store.randomizeTrack(selectedTrackId, mulberry32((seedCounter += 0x9e37) >>> 0)); };
  bHum.onclick = () => { store.humanizeTrack(selectedTrackId, mulberry32((seedCounter += 0x9e37) >>> 0)); announce('track humanized'); };
  bUndo.onclick = () => store.undo();
  bRedo.onclick = () => store.redo();
  tools.append(bRnd, bHum, bUndo, bRedo);

  const presetWrap = document.createElement('div');
  presetWrap.className = 'gp-label';
  presetWrap.style.cssText = 'display:flex;align-items:center;gap:6px;';
  const sel = document.createElement('select');
  sel.setAttribute('aria-label', 'Preset patterns');
  sel.style.cssText = 'font-family:var(--font-mono);font-size:11px;background:var(--bg-sunken);color:var(--fg);border:1px solid var(--line);border-radius:2px;padding:2px 4px;';
  sel.innerHTML = `<option value="">preset...</option>
    <option value="starter">Starter</option>
    <option value="firstlight">First Light</option>
    <option value="copperwires">Copper Wires</option>`;
  sel.onchange = () => { if (sel.value) { applyPreset(sel.value); sel.value = ''; } };
  presetWrap.append('Preset', sel);

  const projWrap = document.createElement('div');
  projWrap.className = 'gp-label';
  projWrap.style.cssText = 'display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap;';
  const themeSel = document.createElement('select');
  themeSel.setAttribute('aria-label', 'Theme');
  themeSel.style.cssText = sel.style.cssText;
  for (const t of THEMES) {
    const o = document.createElement('option'); o.value = t; o.textContent = t; themeSel.appendChild(o);
  }
  themeSel.value = currentTheme();
  themeSel.onchange = () => applyTheme(themeSel.value);
  const bSettings = mkBtn('SET', 'Settings: projects, samples, MIDI');
  bSettings.onclick = openSettings;
  projWrap.append('Project', bSettings, themeSel);

  bar.append(tools, presetWrap, projWrap);
}

function applyPreset(id) {
  const p = defaultProject();
  p.patterns = [makePattern('p1', 'A', 16)];
  const put = (ti, idx, over) => {
    const steps = patternSteps(p.patterns[0], p.tracks[ti].id, 16);
    steps[idx] = { ...steps[idx], on: true, ...over };
  };
  if (id === 'starter') {
    for (let i = 0; i < 16; i += 4) put(0, i, { vel: i % 16 === 0 ? 1 : 0.85 });
    put(1, 4, {}); put(1, 12, {});
    for (let i = 2; i < 16; i += 4) put(2, i, { vel: 0.45 });
    put(3, 14, { vel: 0.5 });
    [[0, 57], [3, 60], [6, 64], [10, 62], [12, 60], [14, 55]].forEach(([s, n]) =>
      put(6, s, { vel: 0.7, note: n }));
  } else if (id === 'firstlight') {
    Object.assign(p, { name: 'First Light', bpm: 96, swing: 0.22 });
    [[0, 1], [7, .8], [10, .9]].forEach(([s, v]) => put(0, s, { vel: v }));
    [[4], [12]].forEach(([s]) => put(1, s, { vel: 0.75 }));
    [[2, .5], [6, .4], [10, .5], [14, .35]].forEach(([s, v]) => put(2, s, { vel: v }));
    put(4, 11, { vel: 0.45 }); put(4, 15, { vel: 0.5, prob: 0.5 });
    [[0, 57], [4, 60], [7, 64], [11, 62], [14, 59]].forEach(([s, n]) =>
      put(6, s, { vel: 0.65, note: n, prob: s === 14 ? 0.75 : 1 }));
    p.tracks[6].params.wave = 'triangle';
    p.tracks[6].fx.reverb = { on: true, size: 0.6, mix: 0.28 };
  } else if (id === 'copperwires') {
    Object.assign(p, { name: 'Copper Wires', bpm: 128, swing: 0 });
    [[0, 1], [3, .7], [6, .85], [10, .9]].forEach(([s, v]) => put(0, s, { vel: v }));
    [[4], [12], [13, .5]].forEach(([s, v]) => put(1, s, { vel: v || 0.8 }));
    for (let i = 2; i < 16; i += 2) put(2, i, { vel: i % 4 === 2 ? 0.5 : 0.3 });
    [[8], [15]].forEach(([s]) => put(3, s, { vel: 0.5 }));
    [[7, .6], [9, .45], [15, .55]].forEach(([s, v]) => put(4, s, { vel: v }));
    put(5, 11, { vel: 0.6, prob: 0.5, ratchet: 2 });
    [[0, 50], [6, 53], [10, 55], [13, 57]].forEach(([s, n]) =>
      put(6, s, { vel: 0.6, note: n, ratchet: s === 13 ? 3 : 1 }));
    p.tracks[6].params.cutoff = 1800;
    p.tracks[6].fx.drive = { on: true, amount: 0.35 };
  }
  store.replaceProject(p);
  announce(`preset loaded: ${p.name}`);
}

function currentPattern() {
  const p = store.getProject();
  return p.patterns.find(x => x.id === store.selectedPatternId) || p.patterns[0];
}

function rebuildPatternTabs() {
  const wrap = $('pattern-tabs');
  wrap.innerHTML = '';
  const p = store.getProject();
  for (const pat of p.patterns) {
    const b = document.createElement('button');
    b.className = 'gp-tab';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-current', String(pat.id === (store.selectedPatternId || p.patterns[0].id)));
    b.textContent = pat.name;
    b.title = `${pat.name} - ${pat.length} steps`;
    b.onclick = () => { store.selectPattern(pat.id); };
    b.ondblclick = () => {
      const name = prompt('Pattern name', pat.name);
      if (name) store.renamePattern(pat.id, name);
    };
    wrap.appendChild(b);
  }
  const addB = document.createElement('button');
  addB.className = 'gp-mini';
  addB.textContent = '+';
  addB.title = 'Add pattern';
  addB.onclick = () => store.addPattern();
  const dupB = document.createElement('button');
  dupB.className = 'gp-mini';
  dupB.textContent = '=';
  dupB.title = 'Duplicate selected pattern';
  dupB.onclick = () => store.duplicatePattern(store.selectedPatternId || p.patterns[0].id);
  const delB = document.createElement('button');
  delB.className = 'gp-mini';
  delB.textContent = 'x';
  delB.title = 'Delete selected pattern';
  delB.onclick = () => { if (p.patterns.length > 1) store.deletePattern(store.selectedPatternId || p.patterns[0].id); };
  wrap.append(addB, dupB, delB);

  const songEd = document.createElement('div');
  songEd.id = 'song-editor';
  const modeSel = document.createElement('select');
  modeSel.setAttribute('aria-label', 'Playback mode');
  modeSel.style.cssText = 'font-family:var(--font-mono);font-size:11px;background:var(--bg-sunken);color:var(--fg);border:1px solid var(--line);border-radius:2px;padding:2px;';
  modeSel.innerHTML = '<option value="pattern">PATTERN</option><option value="song">SONG</option>';
  modeSel.value = p.song.mode;
  modeSel.onchange = () => store.setSongMode(modeSel.value);
  songEd.appendChild(modeSel);
  if (p.song.mode === 'song') {
    p.song.chain.forEach((pid, i) => {
      const chip = document.createElement('span');
      chip.className = 'gp-chip';
      chip.textContent = (p.patterns.find(x => x.id === pid) || { name: '?' }).name;
      chip.onclick = () => store.selectPattern(pid);
      songEd.appendChild(chip);
      if (i < p.song.chain.length - 1) {
        const rm = document.createElement('button');
        rm.className = 'gp-mini'; rm.textContent = '-';
        rm.title = 'Remove from chain';
        rm.onclick = () => { const c = [...p.song.chain]; c.splice(i, 1); store.setSongChain(c); };
        songEd.appendChild(rm);
      }
    });
    const addC = document.createElement('button');
    addC.className = 'gp-mini'; addC.textContent = '+a';
    addC.title = 'Append selected pattern to chain';
    addC.onclick = () => store.setSongChain([...p.song.chain, store.selectedPatternId || p.patterns[0].id]);
    songEd.appendChild(addC);
  }
  wrap.appendChild(songEd);
}

function latencyCompensation() {
  if (!engine || !engine.ctx) return 0;
  const c = engine.ctx;
  return Math.max(0, (c.baseLatency || 0) + (c.outputLatency || 0));
}

function paintPlayhead() {
  if (!scheduler || !playing || !engine) return;
  const beat = scheduler.playheadBeat(engine.ctx.currentTime, latencyCompensation());
  ui.grid.setPlayheadBeat(beat);
  const v = schedulerView();
  const sf = beat * v.stepsPerBeat;
  const len = currentPattern().length;
  const local = sf >= 0 ? Math.floor(sf) % len : ((Math.ceil(-sf)) % len);
  ui.grid.setActiveStep(local);
  const selTrack = store.getProject().tracks.find(t => t.id === selectedTrackId);
  if (selTrack && selTrack.type !== 'drum') ui.roll.setPlayhead(local);
  rafId = requestAnimationFrame(paintPlayhead);
}

function play() {
  ensureEngine().then(() => {
    if (playing) return;
    playing = true;
    const t0 = engine.ctx.currentTime + 0.06;
    engine.returns.setBpm(store.getProject().bpm);
    syncSharedReturns();
    scheduler.start(t0);
    tickerWorker.postMessage('start');
    engine.notifyTransportStarted();
    if (sendClockEnabled && midi) startClockSend(t0);
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(paintPlayhead);
    ui.transport.setPlaying(true);
    updateStatus();
  });
}

function stop() {
  playing = false;
  if (scheduler) scheduler.stop();
  if (tickerWorker) tickerWorker.postMessage('stop');
  if (engine) engine.notifyTransportStopped();
  if (sendClockEnabled && midi) midi.stopSending();
  for (const v of voices.values()) if (v.releaseAll) v.releaseAll();
  cancelAnimationFrame(rafId);
  ui.grid.setPlayheadBeat(null);
  ui.grid.setActiveStep(null);
  ui.roll.setPlayhead(null);
  ui.transport.setPlaying(false);
  updateStatus();
}

function doTick() {
  const t0 = performance.now();
  try { scheduler.tick(); }
  catch (e) { console.error(e); stop(); toast(`scheduler error: ${e.message}`, 'error'); return; }
  const dt = performance.now() - t0;
  headroom.ema = headroom.ema * 0.9 + dt * 0.1;
  headroom.max = Math.max(headroom.max * 0.995, dt);
}

function deliver(event) {
  if (event.trackId === '__metro__') {
    metroVoice.trigger(event);
    return;
  }
  const v = voices.get(event.trackId);
  if (!v) return;
  const track = store.getProject().tracks.find(t => t.id === event.trackId);
  if (!track) return;
  const repeatTag = Math.round(event.time * 1e6) % 99991;
  const prng = eventPrng(store.getProject().seed, event.patternId, event.trackId, event.stepIndex, repeatTag);
  try { v.trigger(event, track.params, prng); }
  catch (e) { console.error('voice trigger failed', e); }
}

function syncSharedReturns() {
  if (!engine) return;
  const p = store.getProject();
  const dT = p.tracks.find(t => t.fx.delay.on) || p.tracks[0];
  engine.returns.setDelayDivision(dT.fx.delay.division);
  engine.returns.setDelay(dT.fx.delay.feedback, dT.fx.delay.mix);
  const rT = p.tracks.find(t => t.fx.reverb.on) || p.tracks[0];
  engine.returns.setReverb(rT.fx.reverb.size, rT.fx.reverb.mix);
}

function syncChannel(trackId) {
  if (!engine) return;
  const ch = engine.channelFor(trackId);
  const t = store.getProject().tracks.find(x => x.id === trackId);
  if (!ch || !t) return;
  ch.setFX(t.fx);
  ch.setMixer(t.mixer);
  applySoloAll();
}

function applySoloAll() {
  if (!engine) return;
  const any = store.getProject().tracks.some(t => t.mixer.solo);
  for (const t of store.getProject().tracks) {
    const ch = engine.channelFor(t.id);
    if (ch) ch.applySolo(any);
  }
}

function buildAudioForProject() {
  if (!engine) return;
  const p = store.getProject();
  const alive = new Set(p.tracks.map(t => t.id));
  for (const [id, v] of voices) {
    if (!alive.has(id)) {
      if (v.dispose) v.dispose();
      engine.removeChannel(id);
      voices.delete(id);
    }
  }
  for (const t of p.tracks) {
    let ch = engine.channelFor(t.id);
    if (!ch) { engine.addChannel(t.id); ch = engine.channelFor(t.id); }
    if (!voices.has(t.id)) {
      let v = null;
      if (t.type === 'drum') v = createDrumVoice(engine.ctx, ch.input, t.params.piece);
      else if (t.type === 'synth') v = createSynthVoice(engine.ctx, ch.input);
      else v = createSamplerVoice(engine.ctx, ch.input);
      const buf = sampleBuffers.get(t.id);
      if (v.setBuffer && buf) v.setBuffer(buf.buffer);
      voices.set(t.id, v);
    } else if (t.type === 'drum' && !voices.get(t.id).__piece) {
      // piece changes are rare; handled at param time by full audio rebuild
    }
    syncChannel(t.id);
  }
  if (!metroVoice) metroVoice = createMetroVoice(engine.ctx, engine.returns.masterIn);
}

function ensureEngine() {
  if (engine) return Promise.resolve(engine);
  return createEngine().then(e => {
    engine = e;
    e.onStateChange(updateStatus);
    buildAudioForProject();
    scheduler = new Scheduler({
      getNow: () => engine.ctx.currentTime,
      getView: schedulerView,
      onEvent: deliver,
      lookahead: 0.18
    });
    startMeterLoop();
    updateStatus();
    return e;
  }).catch(err => {
    toast(`audio init failed: ${err.message}`, 'error');
    throw err;
  });
}

function startMeterLoop() {
  if (meterTimer) clearInterval(meterTimer);
  meterTimer = setInterval(() => {
    if (!engine || document.hidden) return;
    const p = store.getProject();
    for (const t of p.tracks) {
      const ch = engine.channelFor(t.id);
      if (!ch) continue;
      try { ui.mixer.setMeter(t.id, ch.meter()); } catch {}
    }
    const frac = Math.min(1, headroom.max / 30);
    const fill = $('headroom-fill');
    if (fill) {
      fill.style.transform = `scaleX(${frac.toFixed(3)})`;
      fill.style.background = frac > 0.6 ? 'var(--danger)' : 'var(--ok)';
    }
  }, 66);
}
window.addEventListener('beforeunload', () => { if (meterTimer) clearInterval(meterTimer); });

function mountComponents() {
  ui.grid = createStepGrid($('grid'), {
    onToggle: (tid, i) => { store.toggleStep(tid, i); setStepRepeatFromSelection(tid, i); },
    onStepParam: (tid, i, param, val) => {
      if (param === 'nudge') store.setStepParam(tid, i, 'nudge', val);
      else store.setStepParam(tid, i, param, { value: val });
    },
    onCopy: (tid, a, b) => { clipboardRange = { tid, a, b }; },
    onPaste: (tid, at) => { try { store.pasteSteps(tid, at); } catch (e) { toast(e.message, 'error'); } },
    onSelect: (tid) => { selectTrack(tid); },
    onTrackMute: (tid) => { const t = store.getProject().tracks.find(x => x.id === tid); store.setMixer(tid, { mute: !t.mixer.mute }); },
    onTrackSolo: (tid) => { const t = store.getProject().tracks.find(x => x.id === tid); store.setMixer(tid, { solo: !t.mixer.solo }); },
    onAnnounce: announce
  });

  ui.mixer = createMixer($('mixer-panel'), {
    onVolume: (tid, v) => { store.setMixer(tid, { volume: v }); },
    onPan: (tid, v) => { store.setMixer(tid, { pan: v }); },
    onMute: (tid) => { const t = store.getProject().tracks.find(x => x.id === tid); store.setMixer(tid, { mute: !t.mixer.mute }); },
    onSolo: (tid) => { const t = store.getProject().tracks.find(x => x.id === tid); store.setMixer(tid, { solo: !t.mixer.solo }); },
    onSelect: (tid) => { selectTrack(tid); }
  });

  ui.soundbay = createSoundBay($('sound-bay'), {
    onParam: (path, value) => {
      applyParamPath(selectedTrackId, path, value);
    },
    onSampleFile: (file) => loadSampleInto(selectedTrackId, file),
    onQuantize: () => quantizeSelected(),
    onKeyScale: (k, s) => { key = k; scaleName = s; refreshRoll(); },
    onAnnounce: announce
  });

  ui.transport = createTransport(ui.transportMount, {
    onPlayPause: () => { playing ? stop() : play(); },
    onStop: () => stop(),
    onBpm: (v) => { setBpm(v); },
    onTap: () => tapTempo(),
    onSwing: (v) => { store.setTransport({ swing: v }); },
    onTimeSig: (num, den) => { store.setTransport({ timeSig: { num, den } }); fullRefresh(); },
    onMetroToggle: () => { const m = store.getProject().metronome; store.setTransport({ metronome: { ...m, enabled: !m.enabled } }); },
    onMetroDivision: (d) => { const m = store.getProject().metronome; store.setTransport({ metronome: { ...m, division: d } }); },
    onMetroGain: (g) => { const m = store.getProject().metronome; store.setTransport({ metronome: { ...m, gain: g } }); }
  });

  ui.roll = createPianoRoll($('pianoroll'), {
    onSetNote: (tid, i, midiNote) => { store.setNote(tid, i, midiNote); },
    onSelect: (tid, i) => {},
    onAnnounce: announce
  });

  const rollHead = $('roll-head');
  rollHead.innerHTML = '<span class="gp-label">PIANO ROLL</span><span class="gp-label" id="roll-track"></span>';
}

function applyParamPath(tid, path, value) {
  const p = store.getProject();
  const t = p.tracks.find(x => x.id === tid);
  if (!t) return;
  if (path === 'track.length') {
    store.setTrackLength(tid, value);
    syncLengths();
    return;
  }
  if (path.startsWith('params.')) {
    const k = path.slice(7);
    if (k === 'reverse') store.setTrackParams(tid, { reverse: !!value });
    else store.setTrackParams(tid, { [k]: value });
  } else if (path.startsWith('fx.')) {
    const [, unit, key2] = path.split('.');
    store.setFX(tid, { [unit]: { [key2]: value } });
  }
  syncChannel(tid);
  syncSharedReturns();
}

async function loadSampleInto(tid, file) {
  try {
    await ensureEngine();
    const { buffer, name } = await loadSampleFile(file, engine.ctx);
    sampleBuffers.set(tid, { buffer, name });
    const v = voices.get(tid);
    if (v && v.setBuffer) v.setBuffer(buffer);
    const t = store.getProject().tracks.find(x => x.id === tid);
    if (t) t.sampleData = { name };
    ui.soundbay.render(t, { key, scaleName: scaleLabel(), scaleNames: Object.keys(SCALES), keyNames: NOTE_NAMES });
    toast(`sample loaded: ${name}`);
    announce(`sample loaded: ${name}`);
  } catch (e) {
    toast(`${e.message}`, 'error');
    announce(`sample failed: ${e.message}`);
  }
}

function scaleLabel() { return scaleName; }

function quantizeSelected() {
  const t = store.getProject().tracks.find(x => x.id === selectedTrackId);
  if (!t || t.type === 'drum') return;
  const changed = store.quantizeTrack(t.id, key, scaleName);
  toast(`quantized ${changed} notes to ${NOTE_NAMES[key]} ${scaleName}`);
  announce(`quantized to ${NOTE_NAMES[key]} ${scaleName}`);
}

function selectTrack(tid) {
  selectedTrackId = tid;
  const p = store.getProject();
  const t = p.tracks.find(x => x.id === tid);
  ui.soundbay.render(t, { key, scaleName, scaleNames: Object.keys(SCALES), keyNames: NOTE_NAMES });
  refreshRoll();
  announce(`selected track ${t.name}`);
}

function refreshRoll() {
  const p = store.getProject();
  const t = p.tracks.find(x => x.id === selectedTrackId);
  const host = $('pianoroll');
  if (!t || t.type === 'drum') {
    $('roll-track').textContent = '- select a melodic track';
    ui.roll.dispose();
    host.innerHTML = '<p class="gp-label" style="color:var(--fg-dim)">Select a synth or sampler track to edit notes.</p>';
    ui.roll = createPianoRoll(host, {
      onSetNote: (tid, i, midiNote) => { store.setNote(tid, i, midiNote); },
      onSelect: () => {},
      onAnnounce: announce
    });
    return;
  }
  $('roll-track').textContent = `- ${t.name} (${NOTE_NAMES[key]} ${scaleName})`;
  ui.roll.render(p, currentPattern().id, t.id, key, scaleName);
}

function setBpm(v) {
  const bpm = Math.min(333, Math.max(20, Math.round(v * 10) / 10));
  store.setTransport({ bpm });
  if (engine) engine.returns.setBpm(bpm);
  if (playing && scheduler) scheduler.requestTempo(bpm);
  if (midi && sendClockEnabled && midi.setSenderBpm) midi.setSenderBpm(bpm);
}

function setStepRepeatFromSelection(tid, stepIndex) {
  if (!stepRepeat.enabled) return;
  const t = store.getProject().tracks.find(x => x.id === tid);
  if (!t) return;
  const len = Math.min(t.length, currentPattern().length);
  const s = ((stepIndex % len) + len) % len;
  stepRepeat.overrides.set(tid, { step: s });
  announce(`step repeat target: ${t.name} step ${s + 1}`);
}

function toggleStepRepeat() {
  stepRepeat.enabled = !stepRepeat.enabled;
  if (!stepRepeat.enabled) {
    stepRepeat.overrides.clear();
    announce('step repeat off');
  } else {
    announce('step repeat on - click cells to set repeat targets');
  }
  updateStatus();
}

function tapTempo() {  const now = performance.now();
  tapTimes = tapTimes.filter(t => now - t < 2500);
  tapTimes.push(now);
  ui.transport.setTapPulse();
  if (tapTimes.length >= 2) {
    const gaps = [];
    for (let i = 1; i < tapTimes.length; i++) gaps.push(tapTimes[i] - tapTimes[i - 1]);
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const bpm = Math.min(333, Math.max(20, Math.round((60000 / avg) * 10) / 10));
    setBpm(bpm);
    announce(`tap tempo ${bpm}`);
  }
}

function fullRefresh() {
  const p = store.getProject();
  if (!p.tracks.some(t => t.id === selectedTrackId)) selectedTrackId = p.tracks[0].id;
  rebuildPatternTabs();
  ui.grid.render(p, currentPattern().id);
  syncLengths();
  ui.mixer.render(p.tracks);
  const t = p.tracks.find(x => x.id === selectedTrackId);
  ui.soundbay.render(t, { key, scaleName, scaleNames: Object.keys(SCALES), keyNames: NOTE_NAMES });
  refreshRoll();
  ui.transport.setBpm(p.bpm);
  ui.transport.setSwing(p.swing);
  ui.transport.setTimeSig(p.timeSig.num, p.timeSig.den);
  ui.transport.setMetronome(p.metronome.enabled, p.metronome.division, p.metronome.gain);
  ui.transport.setPlaying(playing);
  syncSharedReturns();
  buildAudioForProject();
}

function syncLengths() {
  const p = store.getProject();
  const map = {};
  for (const t of p.tracks) map[t.id] = t.length;
  ui.grid.setLengths(map, currentPattern().length);
}

function softRefresh(reason) {
  const structural = ['addPattern', 'duplicatePattern', 'deletePattern', 'renamePattern', 'selectPattern',
    'undo', 'redo', 'replace', 'setSongChain', 'setSongMode', 'setTrackLength'];
  if (structural.some(s => reason.startsWith(s))) { fullRefresh(); return; }
  const p = store.getProject();
  for (const t of p.tracks) ui.grid.updateTrack(t.id);
  syncLengths();
  if (reason.startsWith('setMixer')) {
    applySoloAll();
    for (const t of p.tracks) { ui.mixer.updateTrack(t.id); syncChannel(t.id); }
    return;
  }
  if (reason.startsWith('setFX') || reason.startsWith('setTrackParams')) {
    for (const t of p.tracks) syncChannel(t.id);
    syncSharedReturns();
    return;
  }
  if (reason.startsWith('setTransport')) {
    const pr = store.getProject();
    ui.transport.setBpm(pr.bpm);
    ui.transport.setSwing(pr.swing);
    ui.transport.setMetronome(pr.metronome.enabled, pr.metronome.division, pr.metronome.gain);
    return;
  }
  const pat = currentPattern();
  for (const t of p.tracks) {
    if (pat.steps[t.id]) ui.grid.updateTrack(t.id);
  }
  refreshRoll();
}

function updateStatus() {
  const bar = $('status-bar');
  let stateText = 'AUDIO OFF - interact to start';
  if (engine) stateText = `audio ${engine.state()}`;
  const blocked = !engine || engine.state() !== 'running';
  bar.classList.toggle('is-audio-blocked', blocked);
  if (!bar.querySelector('.st-state')) buildStatusSkeleton();
  bar.querySelector('.st-state').textContent = stateText;
  bar.querySelector('.st-midi').textContent = midiStatusText;
  bar.querySelector('.st-hint').textContent = playing
    ? `${store.getProject().bpm} bpm${stepRepeat.enabled ? ' - STEP REPEAT' : ''} - space stops`
    : `space plays - click cells to program${stepRepeat.enabled ? ' - STEP REPEAT: click sets repeat target' : ''} - ? for keys`;
  ui.transport && ui.transport.setBlocked(blocked);
}

let midiStatusText = 'midi off';

async function initMidi() {
  if (!midi) {
    midi = new MidiManager({
      onNoteOn: (note, vel) => recordNote(note, vel),
      onNoteOff: () => {},
      onClockPulse: () => {
        if (!extSyncEnabled) return;
        estimator.push(performance.now());
        if (estimator.isStable()) {
          const b = estimator.bpm();
          const cur = store.getProject().bpm;
          if (b && Math.abs(b - cur) > 0.5 && b >= 20 && b <= 333) setBpm(b);
        }
      },
      onStart: () => { if (extSyncEnabled) play(); },
      onStop: () => { if (extSyncEnabled) stop(); },
      onStateChange: (s) => { midiStatusText = `midi: ${s}`; updateStatus(); }
    });
  }
  const r = await midi.init();
  if (r.ok) {
    midiStatusText = `midi: ${r.inputs.length} in / ${r.outputs.length} out`;
    return true;
  }
  midiStatusText = r.reason === 'unsupported'
    ? 'midi: unsupported in this browser'
    : r.reason === 'permission-denied' ? 'midi: permission denied' : 'midi: unavailable';
  return false;
}

function startClockSend(t0) {
  clockSender = new ClockSender();
  midi.startSending(({ windowStartSec, windowEndSec, bpm }) => {
    return clockSender.plan({ startSec: t0 + windowStartSec, endSec: t0 + windowEndSec, bpm })
      .map(s => Math.max(0, (s - engine.ctx.currentTime) * 1000));
  }, { bpm: store.getProject().bpm });
}

function recordNote(note, vel) {
  if (!playing || !scheduler || !engine) return;
  const p = store.getProject();
  const t = p.tracks.find(x => x.id === selectedTrackId);
  if (!t || t.type === 'drum') { announce('select a melodic track to record notes'); return; }
  const beat = scheduler.playheadBeat(engine.ctx.currentTime, latencyCompensation());
  if (beat == null) return;
  const spb = stepsPerBeatOf(p.timeSig.den);
  const sf = beat * spb;
  const len = Math.min(t.length, currentPattern().length);
  let local = Math.floor(sf) % len;
  if (local < 0) local += len;
  const noteOut = recQuantize ? snapToScale(note, key, scaleName) : Math.max(0, Math.min(127, Math.round(note)));
  store.setNote(t.id, local, noteOut);
  store.setStepParam(t.id, local, 'vel', { value: Math.max(0.05, Math.min(1, vel)) });
  announce(`recorded ${NOTE_NAMES[noteOut % 12]}${Math.floor(noteOut / 12) - 1} at step ${local + 1}`);
}

async function loadEmbeddedAfterImport(project) {
  try {
    await ensureEngine();
    const embedded = extractEmbeddedSamples(project);
    for (const [tid, info] of embedded) {
      try {
        const bytes = base64ToBytes(info.base64);
        const { buffer } = await decodeSampleBytes(bytes, info.name || tid, engine.ctx);
        sampleBuffers.set(tid, { buffer, name: info.name });
        const v = voices.get(tid);
        if (v && v.setBuffer) v.setBuffer(buffer);
      } catch (e) {
        toast(`${e.message}`, 'error');
      }
    }
  } catch (e) {
    toast(`embedded sample load failed: ${e.message}`, 'error');
  }
}

function exportMidiFile() {
  const p = store.getProject();
  const pat = currentPattern();
  const PPQ_STEP = PPQ / 4;
  let chIdx = 0;
  const tracks = [];
  for (const t of p.tracks) {
    const steps = pat.steps[t.id];
    if (!steps) continue;
    const channel = t.type === 'drum' ? 9 : (chIdx < 9 ? chIdx++ : ++chIdx);
    const events = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (!s.on) continue;
      const isDrum = t.type === 'drum';
      const note = isDrum ? drumMidiForPiece(t.params.piece) : (s.note != null ? s.note : 60);
      const reps = Math.max(1, s.ratchet | 0);
      const spanTicks = PPQ_STEP / reps;
      for (let r = 0; r < reps; r++) {
        const tick = Math.round(i * PPQ_STEP + r * spanTicks);
        events.push({ tick, type: 'noteOn', note, velocity: Math.max(1, Math.round(s.vel * 127)) });
        events.push({ tick: tick + Math.max(1, Math.round(spanTicks * 0.9)), type: 'noteOff', note, velocity: 0 });
      }
    }
    tracks.push({ channel, events });
  }
  const bytes = writePatternSMF({ tempoBpm: p.bpm, tracks });
  dl(new Blob([bytes], { type: 'audio/midi' }), `${sanitizeSlotName(pat.name)}.mid`);
  toast(`exported ${pat.name}.mid`);
}

function drumMidiForPiece(piece) {
  return { kick: 36, snare: 38, hatClosed: 42, hatOpen: 46, clap: 39, tom: 45 }[piece] || 36;
}

function openSettings() {
  let dlg = $('settings-dlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'settings-dlg';
    document.body.appendChild(dlg);
  }
  const slots = listLocalSlots();
  dlg.innerHTML = `
    <h2 class="gp-title">Settings</h2>
    <div class="gp-label" style="display:grid;gap:10px;min-width:380px;">
      <fieldset style="border:1px solid var(--line);border-radius:3px;">
        <legend>Project slots</legend>
        <div style="display:flex;gap:6px;align-items:center;">
          <input id="slot-name" value="${sanitizeSlotName(store.getProject().name)}" style="flex:1;font-family:var(--font-mono);background:var(--bg-sunken);color:var(--fg);border:1px solid var(--line);padding:3px;">
          <button class="gp-mini" id="s-save">SAVE</button>
          <button class="gp-mini" id="s-export">JSON</button>
          <button class="gp-mini" id="s-import">IMPORT</button>
          <label style="white-space:nowrap;"><input type="checkbox" id="s-embed"> embed samples</label>
        </div>
        <div id="slot-list" style="margin-top:8px;display:grid;gap:4px;"></div>
      </fieldset>
      <fieldset style="border:1px solid var(--line);border-radius:3px;">
        <legend>MIDI</legend>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
          <button class="gp-mini" id="s-midi-init">${midi ? 'RECONNECT' : 'CONNECT'}</button>
          <span id="s-midi-status">${midiStatusText}</span>
        </div>
        <div style="display:grid;gap:4px;margin-top:6px;">
          <label><input type="checkbox" id="s-send-clock" ${sendClockEnabled ? 'checked' : ''}> send MIDI clock while playing</label>
          <label><input type="checkbox" id="s-ext-sync" ${extSyncEnabled ? 'checked' : ''}> follow external MIDI clock</label>
          <label><input type="checkbox" id="s-recq" ${recQuantize ? 'checked' : ''}> quantize recorded notes to key/scale</label>
        </div>
        <p style="color:var(--fg-dim);margin:6px 0 0;">MIDI notes record into the selected melodic track at the playhead during playback. No thru-monitoring: recorded notes sound on the next cycle.</p>
      </fieldset>
      <fieldset style="border:1px solid var(--line);border-radius:3px;">
        <legend>Render</legend>
        <div style="display:flex;gap:6px;align-items:center;">
          <button class="gp-mini" id="s-wav">RENDER WAV</button>
          <button class="gp-mini" id="s-midifile">EXPORT .MID</button>
          <span style="color:var(--fg-dim)">offline, faster than realtime</span>
        </div>
      </fieldset>
      <div style="text-align:right;"><button class="gp-mini" id="s-close">CLOSE</button></div>
    </div>`;
  const slotList = dlg.querySelector('#slot-list');
  if (slots.length) {
    for (const s of slots) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;align-items:center;';
      const label = document.createElement('span');
      label.style.flex = '1';
      label.textContent = `${s.name} `;
      const when = document.createElement('span');
      when.style.color = 'var(--fg-dim)';
      when.textContent = new Date(s.savedAt).toLocaleString();
      label.appendChild(when);
      const bLoad = document.createElement('button');
      bLoad.className = 'gp-mini'; bLoad.textContent = 'LOD';
      bLoad.onclick = async () => {
        try {
          const { project } = loadFromLocalSlot(s.name);
          store.replaceProject(project);
          await loadEmbeddedAfterImport(project);
          toast(`loaded slot: ${s.name}`);
          close();
        } catch (e) { toast(e.message, 'error'); }
      };
      const bDel = document.createElement('button');
      bDel.className = 'gp-mini'; bDel.textContent = 'DEL';
      bDel.onclick = () => { deleteLocalSlot(s.name); toast(`deleted slot: ${s.name}`); openSettings(); };
      row.append(label, bLoad, bDel);
      slotList.appendChild(row);
    }
  } else {
    const empty = document.createElement('span');
    empty.style.color = 'var(--fg-dim)';
    empty.textContent = 'no saved slots';
    slotList.appendChild(empty);
  }
  const close = () => dlg.close();
  dlg.querySelector('#s-close').onclick = close;
  dlg.querySelector('#s-save').onclick = async () => {
    try {
      const name = sanitizeSlotName(dlg.querySelector('#slot-name').value);
      let proj = JSON.parse(JSON.stringify(store.getProject()));
      if (embedSamplesOnSave || dlg.querySelector('#s-embed').checked) {
        proj = await embedSamples(proj, sampleBuffers);
      }
      saveToLocalSlot(name, proj);
      toast(`saved slot: ${name}`);
    } catch (e) { toast(e.message, 'error'); }
  };
  dlg.querySelector('#s-export').onclick = () => downloadProjectJSON(store.getProject());
  dlg.querySelector('#s-import').onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = async () => {
      try {
        const proj = await readProjectFile(inp.files[0]);
        store.replaceProject(proj);
        await loadEmbeddedAfterImport(proj);
        toast(`imported: ${proj.name}`);
        close();
      } catch (e) { toast(e.message, 'error'); }
    };
    inp.click();
  };
  dlg.querySelector('#s-embed').onchange = e => { embedSamplesOnSave = e.target.checked; };
  dlg.querySelector('#s-recq').onchange = e => { recQuantize = e.target.checked; };
  dlg.querySelector('#s-send-clock').onchange = e => { sendClockEnabled = e.target.checked; if (!sendClockEnabled && midi) midi.stopSending(); };
  dlg.querySelector('#s-ext-sync').onchange = e => { extSyncEnabled = e.target.checked; };
  dlg.querySelector('#s-midi-init').onclick = async () => {
    const ok = await initMidi();
    dlg.querySelector('#s-midi-status').textContent = midiStatusText;
    updateStatus();
    if (!ok) toast(midiStatusText, 'error');
  };
  dlg.querySelector('#s-wav').onclick = async () => {
    const btn = dlg.querySelector('#s-wav');
    btn.disabled = true; btn.textContent = '...';
    try {
      const blob = await renderProjectToWavBlob(store.getProject());
      dl(blob, `gridpulse-${sanitizeSlotName(store.getProject().name)}.wav`);
      toast(`rendered ${(blob.size / 1048576).toFixed(1)} MB WAV offline`);
    } catch (e) { toast(`render failed: ${e.message}`, 'error'); }
    btn.disabled = false; btn.textContent = 'RENDER WAV';
  };
  dlg.querySelector('#s-midifile').onclick = () => {
    try { exportMidiFile(); }
    catch (e) { toast(`MIDI export failed: ${e.message}`, 'error'); }
  };
  dlg.showModal();
}

function isTyping(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable;
}

function wireGlobalKeys() {
  document.addEventListener('keydown', e => {
    if (e.key === '?' || (e.shiftKey && e.key === '/')) {
      if (!isTyping(e.target)) { e.preventDefault(); $('help').open ? $('help').close() : $('help').showModal(); }
      return;
    }
    if (e.key === 'Escape') {
      for (const d of ['help', 'settings-dlg']) { const el = $(d); if (el && el.open) el.close(); }
      return;
    }
    if (isTyping(e.target) || e.metaKey && !e.ctrlKey) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); store.undo(); return; }
    if (ctrl && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); store.redo(); return; }
    if (ctrl) return;
    switch (e.key) {
      case ' ': e.preventDefault(); playing ? stop() : play(); break;
      case 't': case 'T': tapTempo(); break;
      case 'm': case 'M': { const m = store.getProject().metronome; store.setTransport({ metronome: { ...m, enabled: !m.enabled } }); announce(`metronome ${m.enabled ? 'off' : 'on'}`); break; }
      case '.': toggleStepRepeat(); break;
      case 'g': case 'G': ui.grid.focusCell(selectedTrackId, 0); break;
      case 'p': case 'P': { const t = store.getProject().tracks.find(x => x.id === selectedTrackId); if (t && t.type !== 'drum') $('pianoroll').focus(); break; }
    }
  });
}

function wireFirstGesture() {
  const kick = () => {
    ensureEngine()
      .then(() => engine.resume())
      .then(() => updateStatus())
      .catch(() => updateStatus());
    document.removeEventListener('pointerdown', kick, true);
    document.removeEventListener('keydown', kick, true);
  };
  document.addEventListener('pointerdown', kick, true);
  document.addEventListener('keydown', kick, true);
}

function boot() {
  initTheme();
  buildHelp();
  buildTransportBar();
  mountComponents();
  buildStatusSkeleton();

  scheduler = new Scheduler({
    getNow: () => (engine ? engine.ctx.currentTime : 0),
    getView: schedulerView,
    onEvent: deliver,
    lookahead: 0.18
  });

  tickerWorker = new Worker(new URL('../workers/ticker.worker.js', import.meta.url), { type: 'module' });
  tickerWorker.onmessage = e => { if (e.data === 'tick') doTick(); };

  store.addEventListener('change', e => softRefresh(e.detail.reason));
  store.addEventListener('pattern', () => fullRefresh());

  document.getElementById('transport-bar').addEventListener('dblclick', e => {
    if (e.target.id === 'transport-bar') openSettings();
  });

  wireGlobalKeys();
  wireFirstGesture();
  fullRefresh();
  updateStatus();
}

function buildStatusSkeleton() {
  const bar = document.getElementById('status-bar');
  bar.innerHTML = `<span class="st-state"></span>
    <button id="status-unblock">CLICK TO START AUDIO</button>
    <span class="st-midi"></span>
    <span class="st-grow"></span>
    <span class="gp-label">CPU</span><div id="headroom-bar"><div id="headroom-fill"></div></div>
    <span class="st-hint"></span>`;
  bar.querySelector('#status-unblock').onclick = () =>
    ensureEngine().then(() => engine.resume()).then(updateStatus).catch(updateStatus);
}

boot();
