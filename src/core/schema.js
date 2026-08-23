const ERR = [];
function err(msg) { ERR.push(msg); }

const STEP_RANGES = {
  vel: [0, 1], prob: [0, 1], ratchet: [1, 8], nudge: [-40, 40]
};

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function num(v) { return typeof v === 'number' && Number.isFinite(v); }
function inRange(v, r) { return num(v) && v >= r[0] && v <= r[1]; }

export function validateProject(input) {
  ERR.length = 0;
  const p = input;
  if (!isObj(p)) { return { ok: false, errors: ['root: not an object'], project: null }; }
  if (p.format !== 'gridpulse-project') err('format: expected "gridpulse-project"');
  if (!num(p.version) || p.version !== 1) err('version: only 1 supported');

  if (!inRange(p.bpm, [20, 333])) err('bpm: out of range 20..333');
  if (!inRange(p.swing, [0, 0.6])) err('swing: out of range 0..0.6');
  if (!isObj(p.timeSig)) err('timeSig: missing');
  else {
    if (!Number.isInteger(p.timeSig.num) || p.timeSig.num < 2 || p.timeSig.num > 16) err('timeSig.num: 2..16');
    if (![2, 4, 8, 16].includes(p.timeSig.den)) err('timeSig.den: must be 2|4|8|16');
  }
  if (!isObj(p.metronome)) err('metronome: missing');
  else {
    if (typeof p.metronome.enabled !== 'boolean') err('metronome.enabled: boolean');
    if (!Number.isInteger(p.metronome.division) || p.metronome.division < 1 || p.metronome.division > 16) err('metronome.division: 1..16');
    if (!inRange(p.metronome.gain, [0, 1])) err('metronome.gain: 0..1');
  }
  if (!Number.isInteger(p.seed) || p.seed < 0 || p.seed > 0xFFFFFFFF) err('seed: uint32 required');

  const ids = new Set();
  if (!Array.isArray(p.tracks) || p.tracks.length === 0) err('tracks: non-empty array required');
  else for (const t of p.tracks) validateTrack(t, ids);

  if (!Array.isArray(p.patterns) || p.patterns.length === 0) err('patterns: non-empty array required');
  else for (const pat of p.patterns) validatePattern(pat, ids);

  if (!isObj(p.song)) err('song: missing');
  else {
    if (!Array.isArray(p.song.chain) || !p.song.chain.every(id => typeof id === 'string')) err('song.chain: string[]');
    else if (p.patterns && p.song.chain.some(id => !p.patterns.some(pt => pt.id === id))) err(`song.chain: unknown pattern id`);
    if (!['pattern', 'song'].includes(p.song.mode)) err('song.mode: pattern|song');
  }

  if (ERR.length) return { ok: false, errors: ERR.slice(), project: null };
  return { ok: true, errors: [], project: p };
}

function validateTrack(t, ids) {
  if (!isObj(t)) { err('track: not an object'); return; }
  if (typeof t.id !== 'string' || !t.id) err('track.id: string required');
  else if (ids.has(t.id)) err(`track.id: duplicate ${t.id}`);
  else ids.add(t.id);
  if (!['drum', 'synth', 'sampler'].includes(t.type)) err(`${t.id}.type`);
  if (!Number.isInteger(t.colorSlot) || t.colorSlot < 1 || t.colorSlot > 8) err(`${t.id}.colorSlot: 1..8`);
  if (!Number.isInteger(t.length) || t.length < 1 || t.length > 64) err(`${t.id}.length: 1..64`);
  if (!isObj(t.mixer)) err(`${t.id}.mixer`);
  else {
    const m = t.mixer;
    if (!inRange(m.volume, [0, 1.2])) err(`${t.id}.mixer.volume: 0..1.2`);
    if (!inRange(m.pan, [-1, 1])) err(`${t.id}.mixer.pan: -1..1`);
    if (typeof m.mute !== 'boolean') err(`${t.id}.mixer.mute`);
    if (typeof m.solo !== 'boolean') err(`${t.id}.mixer.solo`);
  }
  if (!isObj(t.fx)) err(`${t.id}.fx`); else validateFX(t.id, t.fx);
  if (t.type === 'drum') {
    const pieces = ['kick', 'snare', 'hatClosed', 'hatOpen', 'clap', 'tom'];
    if (!isObj(t.params) || !pieces.includes(t.params.piece)) err(`${t.id}.params.piece`);
  }
  if (t.type === 'synth') validateSynthParams(t.id, t.params);
  if (t.type === 'sampler') validateSamplerParams(t.id, t.params);
}

const SYNTH_RANGES = {
  detune: [-50, 50], glide: [0, 0.5], attack: [0, 2], decay: [0, 2],
  sustain: [0, 1], release: [0, 4], cutoff: [30, 18000], resonance: [0.0001, 24],
  envMod: [0, 10], fEnvDecay: [0, 4]
};

function validateSynthParams(id, params) {
  if (!isObj(params)) { err(`${id}.params: object required`); return; }
  if (!['sine', 'triangle', 'sawtooth', 'square', 'supersaw'].includes(params.wave)) {
    err(`${id}.params.wave`);
  }
  for (const [k, r] of Object.entries(SYNTH_RANGES)) {
    if (params[k] !== undefined && !inRange(params[k], r)) err(`${id}.params.${k}: out of range`);
  }
}

const SAMPLER_RANGES = { gain: [0, 4], tune: [-48, 48], start: [0, 1], end: [0, 1] };

function validateSamplerParams(id, params) {
  if (!isObj(params)) { err(`${id}.params: object required`); return; }
  if (typeof params.reverse !== 'undefined' && typeof params.reverse !== 'boolean') {
    err(`${id}.params.reverse: boolean`);
  }
  for (const [k, r] of Object.entries(SAMPLER_RANGES)) {
    if (params[k] !== undefined && !inRange(params[k], r)) err(`${id}.params.${k}: out of range`);
  }
  if ([params.start, params.end].every(num) && params.start > params.end) {
    err(`${id}.params.start/end: start must be <= end`);
  }
}

function validateFX(id, fx) {  const spec = {
    drive: o => inRange(o.amount, [0, 1]),
    filter: o => ['lowpass', 'highpass', 'bandpass'].includes(o.type) && inRange(o.cutoff, [30, 18000]) && inRange(o.q, [0.0001, 24]),
    comp: o => inRange(o.threshold, [-60, 0]) && inRange(o.ratio, [1, 20]) && inRange(o.attack, [0, 1]) && inRange(o.release, [0.01, 2]),
    delay: o => Number.isInteger(o.division) && o.division >= 1 && o.division <= 16 && inRange(o.feedback, [0, 0.95]) && inRange(o.mix, [0, 1]),
    reverb: o => inRange(o.size, [0, 1]) && inRange(o.mix, [0, 1])
  };
  for (const [k, check] of Object.entries(spec)) {
    if (!isObj(fx[k])) { err(`${id}.fx.${k}`); continue; }
    if (typeof fx[k].on !== 'boolean') err(`${id}.fx.${k}.on`);
    if (!check(fx[k])) err(`${id}.fx.${k}: param out of range`);
  }
}

function validatePattern(pat, trackIds) {
  if (!isObj(pat)) { err('pattern: not an object'); return; }
  if (typeof pat.id !== 'string' || !pat.id) err('pattern.id');
  if (!Number.isInteger(pat.length) || pat.length < 1 || pat.length > 64) err(`${pat.id}.length: 1..64`);
  if (!isObj(pat.steps)) { err(`${pat.id}.steps`); return; }
  for (const [tid, arr] of Object.entries(pat.steps)) {
    if (!Array.isArray(arr)) { err(`${pat.id}.steps.${tid}: array`); continue; }
    if (arr.length !== pat.length) err(`${pat.id}.steps.${tid}: length ${arr.length} != pattern length ${pat.length}`);
    for (let i = 0; i < arr.length; i++) validateStep(pat.id, tid, i, arr[i]);
    if (trackIds.size && !trackIds.has(tid)) err(`${pat.id}: steps reference unknown track ${tid}`);
  }
}

function validateStep(pid, tid, i, s) {
  if (!isObj(s)) { err(`${pid}.${tid}[${i}]: step not object`); return; }
  if (typeof s.on !== 'boolean') err(`${pid}.${tid}[${i}].on`);
  for (const [k, r] of Object.entries(STEP_RANGES)) {
    if (!inRange(s[k], r)) err(`${pid}.${tid}[${i}].${k}: out of range`);
  }
  if (s.note !== null && s.note !== undefined && !(Number.isInteger(s.note) && s.note >= 0 && s.note <= 127)) {
    err(`${pid}.${tid}[${i}].note: 0..127|null`);
  }
}
