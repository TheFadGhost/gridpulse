import { seededFor } from './rng.js';

export const MAX_STEPS = 64;
export const UNDO_DEPTH = 100;

let idCounter = 0;
export function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;
}

export function makeStep() {
  return { on: false, vel: 0.8, prob: 1, ratchet: 1, nudge: 0, note: null };
}

export const DRUM_PIECES = ['kick', 'snare', 'hatClosed', 'hatOpen', 'clap', 'tom'];

export const SYNTH_DEFAULTS = {
  wave: 'sawtooth',
  detune: 0,
  glide: 0,
  attack: 0.005, decay: 0.18, sustain: 0.5, release: 0.2,
  cutoff: 3200, resonance: 2, envMod: 2.5, fEnvDecay: 0.25
};

export const SAMPLER_DEFAULTS = {
  gain: 0.9, tune: 0, start: 0, end: 1, reverse: false
};

export const FX_DEFAULTS = {
  drive: { on: false, amount: 0.3 },
  filter: { on: false, type: 'lowpass', cutoff: 8000, q: 0.7 },
  comp: { on: false, threshold: -18, ratio: 3, attack: 0.006, release: 0.12 },
  delay: { on: false, division: 3, feedback: 0.35, mix: 0.25 },
  reverb: { on: false, size: 0.5, mix: 0.2 }
};

export function makeTrack({ type, name, colorSlot, piece }) {
  return {
    id: uid('t'),
    name,
    type,
    colorSlot,
    length: 16,
    ...(type === 'drum' ? { params: { piece, ...pieceParams(piece) } } : {}),
    ...(type === 'synth' ? { params: { ...SYNTH_DEFAULTS } } : {}),
    ...(type === 'sampler' ? { params: { ...SAMPLER_DEFAULTS } } : {}),
    mixer: { volume: 0.85, pan: 0, mute: false, solo: false },
    fx: JSON.parse(JSON.stringify(FX_DEFAULTS))
  };
}

function pieceParams(piece) {
  switch (piece) {
    case 'kick': return { pitch: 48, decay: 0.42, punch: 0.7 };
    case 'snare': return { tone: 180, decay: 0.22, snap: 0.6 };
    case 'hatClosed': return { tone: 8000, decay: 0.05 };
    case 'hatOpen': return { tone: 7000, decay: 0.32 };
    case 'clap': return { tone: 1100, decay: 0.24, spread: 0.5 };
    case 'tom': return { pitch: 120, decay: 0.3, drop: 0.4 };
    default: return {};
  }
}

export function makePattern(id, name, length = 16) {
  return { id, name, length, steps: {} };
}

export function patternSteps(pattern, trackId, fillLength) {
  let arr = pattern.steps[trackId];
  if (!arr || arr.length !== fillLength) {
    const next = new Array(fillLength);
    for (let i = 0; i < fillLength; i++) next[i] = (arr && arr[i]) ? { ...arr[i] } : makeStep();
    pattern.steps[trackId] = arr = next;
  }
  return arr;
}

export function lcm(a, b) { return a * b / gcd(a, b); }
export function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }

export function cycleLength(trackLengths) {
  if (!trackLengths.length) return 16;
  return trackLengths.reduce((acc, l) => lcm(acc, l || 1), 1);
}

export function serializeStepRange(steps, from, to) {
  return JSON.parse(JSON.stringify(steps.slice(from, to + 1)));
}
export function applyStepRange(steps, data, at) {
  for (let i = 0; i < data.length; i++) {
    const idx = at + i;
    if (idx >= 0 && idx < steps.length) steps[idx] = { ...makeStep(), ...data[i] };
  }
}

export class UndoStack {
  constructor(depth = UNDO_DEPTH) { this.depth = depth; this.stack = []; this.index = -1; }
  push(snapshotJson) {
    if (this.stack[this.index] === snapshotJson) return false;
    this.stack.length = this.index + 1;
    this.stack.push(snapshotJson);
    if (this.stack.length > this.depth) this.stack.shift();
    this.index = this.stack.length - 1;
    return true;
  }
  undo() { if (this.index > 0) return this.stack[--this.index]; return null; }
  redo() { if (this.index < this.stack.length - 1) return this.stack[++this.index]; return null; }
  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.stack.length - 1; }
}

const STARTER_SYNTH_RIFF = [
  { s: 0, n: 57 }, { s: 3, n: 60 }, { s: 6, n: 64 }, { s: 10, n: 62 },
  { s: 12, n: 60 }, { s: 14, n: 55 }
];

export function defaultProject() {
  const tracks = [
    makeTrack({ type: 'drum', name: 'Kick', colorSlot: 1, piece: 'kick' }),
    makeTrack({ type: 'drum', name: 'Snare', colorSlot: 2, piece: 'snare' }),
    makeTrack({ type: 'drum', name: 'Hat Cl', colorSlot: 3, piece: 'hatClosed' }),
    makeTrack({ type: 'drum', name: 'Hat Op', colorSlot: 4, piece: 'hatOpen' }),
    makeTrack({ type: 'drum', name: 'Clap', colorSlot: 5, piece: 'clap' }),
    makeTrack({ type: 'drum', name: 'Tom', colorSlot: 6, piece: 'tom' }),
    makeTrack({ type: 'synth', name: 'Synth', colorSlot: 7 }),
    makeTrack({ type: 'sampler', name: 'Sample', colorSlot: 8 })
  ];
  tracks[7].mixer.volume = 0;
  const p = makePattern('p1', 'A', 16);
  const put = (ti, idx, over) => {
    const steps = patternSteps(p, tracks[ti].id, p.length);
    steps[idx] = { ...steps[idx], on: true, ...over };
  };
  for (let i = 0; i < 16; i += 4) put(0, i, { vel: i % 16 === 0 ? 1 : 0.85 });
  put(1, 4, { vel: 0.9 }); put(1, 12, { vel: 0.9 });
  for (let i = 2; i < 16; i += 4) put(2, i, { vel: 0.45 });
  for (let i = 0; i < 16; i += 2) put(2, i, { vel: 0.28 });
  put(3, 14, { vel: 0.5 });
  put(4, 12, { vel: 0.55 }); put(4, 13, { vel: 0.4 });
  for (const { s, n } of STARTER_SYNTH_RIFF) {
    put(6, s, { vel: 0.7, note: n, ratchet: s === 10 ? 2 : 1 });
  }
  return {
    format: 'gridpulse-project',
    version: 1,
    name: 'Untitled',
    seed: 305419896,
    bpm: 120,
    swing: 0,
    timeSig: { num: 4, den: 4 },
    metronome: { enabled: false, division: 4, gain: 0.5 },
    tracks,
    patterns: [p],
    song: { chain: ['p1'], mode: 'pattern' }
  };
}

export function projectRngFor(project, label) {
  return seededFor(project.seed | 0, label);
}
