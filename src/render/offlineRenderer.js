import { validateProject } from '../core/schema.js';
import { STEP_BEATS } from '../core/musictime.js';
import { eventPrng } from '../core/eventrng.js';
import { Scheduler } from '../audio/scheduler.js';
import { buildSchedulerView } from '../audio/view.js';
import { createSharedReturns, createTrackFX } from '../audio/fx.js';
import { createDrumVoice } from '../audio/voices/kit.js';
import { createSynthVoice } from '../audio/voices/synthvoice.js';
import { createSamplerVoice } from '../audio/voices/samplervoice.js';
import { createMetroVoice } from '../audio/voices/metrovoice.js';
import { encodeWav } from './wavenc.js';

const START_AT = 0.05;
const TAIL_SEC = 1.5;

function patternById(project, id) {
  return project.patterns.find((p) => p.id === id) || null;
}

export function activePatternId(project) {
  const chain = project.song && project.song.chain;
  if (chain && chain.length) return chain[0];
  return project.patterns[0] ? project.patterns[0].id : null;
}

export function projectDurationSec(project) {
  const stepSec = STEP_BEATS * (60 / project.bpm);
  const dur = (p) => (p ? p.length * stepSec : 0);
  if (project.song && project.song.mode === 'song') {
    const chain = (project.song.chain || []);
    let total = 0;
    for (const id of chain) total += dur(patternById(project, id));
    return total;
  }
  return dur(patternById(project, activePatternId(project)));
}

function isKickTrack(t) {
  return t.type === 'drum' && t.params != null && t.params.piece === 'kick';
}

function buildView(project) {
  return buildSchedulerView(project, activePatternId(project));
}

function applyMasterState(returns, project) {
  returns.setBpm(project.bpm);
  const withDelay = project.tracks.find((t) => t.fx && t.fx.delay && t.fx.delay.on);
  if (withDelay) {
    returns.setDelayDivision(withDelay.fx.delay.division);
    returns.setDelay(withDelay.fx.delay.feedback, withDelay.fx.delay.mix);
  }
  const withReverb = project.tracks.find((t) => t.fx && t.fx.reverb && t.fx.reverb.on);
  if (withReverb) {
    returns.setReverb(withReverb.fx.reverb.size, withReverb.fx.reverb.mix);
  }
}

function fxActive(t) {
  const fx = t.fx || {};
  return ['drive', 'filter', 'comp', 'delay', 'reverb'].some((k) => fx[k] && fx[k].on);
}

function createLiteChannel(ctx, returns) {
  // Minimal identity channel for tracks with all FX disabled: fewer nodes in
  // the offline graph, identical audio, and it avoids a Chromium headless
  // OfflineAudioContext stall triggered by the full TrackFX composite.
  const input = ctx.createGain();
  const panner = ctx.createStereoPanner();
  const fader = ctx.createGain();
  let volume = 0.85;
  let mute = false;
  let solo = false;
  let anySolo = false;
  function apply() {
    fader.gain.value = mute || (!solo && anySolo) ? 0 : volume;
  }
  input.connect(panner);
  panner.connect(fader);
  fader.connect(returns.masterIn);
  return {
    input,
    out: fader,
    setFX() {},
    setMixer(m = {}) {
      volume = m.volume != null ? m.volume : volume;
      mute = !!m.mute;
      solo = !!m.solo;
      panner.pan.value = m.pan || 0;
      apply();
    },
    applySolo(a) {
      anySolo = !!a;
      apply();
    },
    meter() { return { peak: 0, rms: 0 }; },
    dispose() {
      try { input.disconnect(); } catch (_) {}
      try { panner.disconnect(); } catch (_) {}
      try { fader.disconnect(); } catch (_) {}
    }
  };
}

function buildGraph(ctx, project) {
  const returns = createSharedReturns(ctx);
  returns.output.connect(ctx.destination);
  applyMasterState(returns, project);

  const anySolo = project.tracks.some((t) => t.mixer && t.mixer.solo);
  const channels = new Map();
  const voices = new Map();
  const trackById = new Map();

  for (const t of project.tracks) {
    trackById.set(t.id, t);
    const active = fxActive(t);
    const lite = !active;
    const ch = lite ? createLiteChannel(ctx, returns) : createTrackFX(ctx, returns);
    if (!lite) ch.out.connect(returns.masterIn);
    ch.setFX(t.fx);
    ch.setMixer(t.mixer);
    ch.applySolo(anySolo);
    channels.set(t.id, ch);

    let voice;
    if (t.type === 'drum') voice = createDrumVoice(ctx, ch.input, t.params.piece);
    else if (t.type === 'synth') voice = createSynthVoice(ctx, ch.input);
    else voice = createSamplerVoice(ctx, ch.input);
    voices.set(t.id, voice);
  }

  let metroVoice = null;
  if (project.metronome.enabled) {
    metroVoice = createMetroVoice(ctx, returns.masterIn);
  }
  return { returns, channels, voices, trackById, metroVoice };
}

function makeDelivery(project, graph) {
  const counters = new Map();
  return function deliver(ev) {
    const key = `${ev.patternId}|${ev.trackId}|${ev.stepIndex}`;
    const idx = counters.get(key) || 0;
    counters.set(key, idx + 1);
    const repeat = ev.trackId === '__metro__' ? ev.stepIndex : idx;
    const prng = eventPrng(project.seed, ev.patternId, ev.trackId, ev.stepIndex, repeat);
    if (ev.trackId === '__metro__') {
      if (graph.metroVoice) graph.metroVoice.trigger(ev, null, prng);
      return;
    }
    const ch = graph.channels.get(ev.trackId);
    const voice = graph.voices.get(ev.trackId);
    if (!ch || !voice) return;
    const track = graph.trackById.get(ev.trackId);
    voice.trigger(ev, track && track.params, prng);
  };
}

function runScheduler(project, duration, onEvent) {
  const view = buildView(project);
  const sched = new Scheduler({
    getNow: () => 0,
    getView: () => view,
    onEvent,
    lookahead: duration + 1
  });
  sched.start(START_AT);
  sched.tick();
}

export async function renderProjectToBuffer(project, { sampleRate = 44100 } = {}) {
  const res = validateProject(project);
  if (!res.ok) throw new Error(res.errors.join('; '));
  const duration = projectDurationSec(project);
  const frames = Math.ceil((duration + TAIL_SEC) * sampleRate);
  const offctx = new OfflineAudioContext(2, frames, sampleRate);
  const graph = buildGraph(offctx, project);
  runScheduler(project, duration, makeDelivery(project, graph));
  return offctx.startRendering();
}

function collectChannels(buffer) {
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  return chans;
}

function bytesEqual(a, b) {
  const ua = new Uint8Array(a);
  const ub = new Uint8Array(b);
  if (ua.length !== ub.length) return false;
  for (let i = 0; i < ua.length; i++) {
    if (ua[i] !== ub[i]) return false;
  }
  return true;
}

export async function renderProjectToWavBlob(project, opts) {
  const o = opts || {};
  const buffer = await renderProjectToBuffer(project, o);
  const ab = encodeWav(collectChannels(buffer), buffer.sampleRate, o.bitDepth);
  return new Blob([ab], { type: 'audio/wav' });
}

function monoMix(buffer) {
  const n = buffer.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i];
  }
  const k = 1 / buffer.numberOfChannels;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

const ONSET_WINDOW = 64;
const ONSET_THRESHOLD = 0.05;
const ONSET_JUMP = 4;
const ONSET_EXIT_RATIO = 0.2;
const SILENCE_LEAD_SEC = 0.05;

function detectOnsets(x, sr) {
  const onsets = [];
  const n = x.length;
  const skip = Math.min(n, Math.ceil(sr * SILENCE_LEAD_SEC));
  const sq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sq[i + 1] = sq[i] + x[i] * x[i];
  const rmsEnd = (end) => {
    const start = Math.max(0, end - ONSET_WINDOW);
    const m = end - start;
    return Math.sqrt((sq[end] - sq[start]) / m);
  };
  let inOnset = false;
  let ref = 0;
  for (let i = skip; i < n; i++) {
    const cur = rmsEnd(i + 1);
    if (!inOnset) {
      const prev = rmsEnd(Math.max(0, i + 1 - ONSET_WINDOW));
      if (Math.abs(x[i]) > ONSET_THRESHOLD && cur > prev * ONSET_JUMP) {
        onsets.push(i / sr);
        inOnset = true;
        ref = cur;
      }
    } else if (cur < ref * ONSET_EXIT_RATIO) {
      inOnset = false;
    }
  }
  return onsets;
}

export async function measureAlignmentMs(project, { sampleRate = 44100 } = {}) {
  const res = validateProject(project);
  if (!res.ok) throw new Error(res.errors.join('; '));

  const kickIds = new Set(project.tracks.filter(isKickTrack).map((t) => t.id));
  const variant = {
    ...project,
    tracks: project.tracks.map((t) =>
      kickIds.has(t.id) ? t : { ...t, mixer: { ...t.mixer, volume: 0 } }
    ),
    metronome: { ...project.metronome, enabled: false }
  };

  const duration = projectDurationSec(variant);
  const scheduled = [];
  const view = buildView(variant);
  const sched = new Scheduler({
    getNow: () => 0,
    getView: () => view,
    onEvent: (e) => { if (kickIds.has(e.trackId)) scheduled.push(e.time); },
    lookahead: duration + 1
  });
  sched.start(START_AT);
  sched.tick();
  scheduled.sort((a, b) => a - b);

  const buffer = await renderProjectToBuffer(variant, { sampleRate });
  const detected = detectOnsets(monoMix(buffer), buffer.sampleRate);

  const devs = [];
  const used = new Array(scheduled.length).fill(false);
  for (const d of detected) {
    let best = -1;
    let bestDist = Infinity;
    for (let j = 0; j < scheduled.length; j++) {
      if (used[j]) continue;
      const dist = Math.abs(scheduled[j] - d);
      if (dist < bestDist) { bestDist = dist; best = j; }
    }
    if (best >= 0) {
      used[best] = true;
      devs.push(((d - SILENCE_LEAD_SEC) - (scheduled[best] - START_AT)) * 1000);
    }
  }

  const maxAbsDeviationMs = devs.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const meanDeviationMs = devs.length ? devs.reduce((a, v) => a + v, 0) / devs.length : 0;
  return { scheduled, detected, maxAbsDeviationMs, meanDeviationMs };
}

export async function renderTwiceByteIdentical(project, opts) {
  const o = opts || {};
  const a = await renderProjectToBuffer(project, o);
  const b = await renderProjectToBuffer(project, o);
  const ea = encodeWav(collectChannels(a), a.sampleRate);
  const eb = encodeWav(collectChannels(b), b.sampleRate);
  return bytesEqual(ea, eb);
}
