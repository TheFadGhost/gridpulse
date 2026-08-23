import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppStore } from '../src/app/store.js';
import { defaultProject, makeStep, patternSteps } from '../src/core/model.js';
import { mulberry32 } from '../src/core/rng.js';

const fresh = () => new AppStore(defaultProject());
const stepsOf = (store, ti) => {
  const p = store.getProject();
  return patternSteps(p.patterns.find(q => q.id === store.selectedPatternId), p.tracks[ti].id, 16);
};
function changes(store) {
  const out = [];
  store.addEventListener('change', e => out.push(e.detail));
  return out;
}

test('constructor deep-clones input; getJSON is detached', () => {
  const proj = defaultProject();
  proj.bpm = 99;
  const s = new AppStore(proj);
  proj.bpm = 333;
  assert.equal(s.getProject().bpm, 99);
  const j = s.getJSON();
  j.bpm = 1;
  j.tracks[0].name = 'x';
  assert.equal(s.getProject().bpm, 99);
  assert.equal(s.getProject().tracks[0].name, 'Kick');
});

test('toggleStep flips exactly the targeted step and nothing else', () => {
  const s = fresh();
  const before = JSON.stringify(stepsOf(s, 0));
  s.toggleStep(s.getProject().tracks[0].id, 3);
  const after = stepsOf(s, 0);
  assert.equal(after[3].on, true);
  const prev = JSON.parse(before);
  for (let i = 0; i < 16; i++) if (i !== 3) assert.deepEqual(after[i], prev[i]);
  s.toggleStep(s.getProject().tracks[0].id, 3);
  assert.equal(stepsOf(s, 0)[3].on, false);
  assert.throws(() => s.toggleStep(s.getProject().tracks[0].id, 16), RangeError);
  assert.throws(() => s.toggleStep('ghost', 0), /unknown track/);
});

test('setStepParam: explicit values, cycle dir, nudge delta, range throws', () => {
  const s = fresh();
  const tid = s.getProject().tracks[0].id;
  s.setStepParam(tid, 0, 'vel', 0.31);
  assert.equal(stepsOf(s, 0)[0].vel, 0.31);
  s.setStepParam(tid, 0, 'prob', 0.42);
  s.setStepParam(tid, 0, 'ratchet', 2);
  assert.equal(stepsOf(s, 0)[0].prob, 0.42);
  assert.equal(stepsOf(s, 0)[0].ratchet, 2);
  s.setStepParam(tid, 0, 'nudge', { value: -17 });
  assert.equal(stepsOf(s, 0)[0].nudge, -17);
  s.setStepParam(tid, 4, 'vel', { dir: 1 });
  assert.equal(stepsOf(s, 0)[4].vel, 1);
  s.setStepParam(tid, 0, 'ratchet', { dir: -1 });
  assert.equal(stepsOf(s, 0)[0].ratchet, 1);
  s.setStepParam(tid, 1, 'nudge', 50);
  assert.equal(stepsOf(s, 0)[1].nudge, 40);
  s.setStepParam(tid, 1, 'nudge', -100);
  assert.equal(stepsOf(s, 0)[1].nudge, -40);
  s.setStepParam(tid, 2, 'nudge', { value: -17 });
  s.setStepParam(tid, 2, 'nudge', 50);
  assert.equal(stepsOf(s, 0)[2].nudge, 33);
  assert.throws(() => s.setStepParam(tid, 0, 'vel', 1.5), RangeError);
  assert.throws(() => s.setStepParam(tid, 0, 'vel', -0.01), RangeError);
  assert.throws(() => s.setStepParam(tid, 0, 'prob', 2), RangeError);
  assert.throws(() => s.setStepParam(tid, 0, 'ratchet', 9), RangeError);
  assert.throws(() => s.setStepParam(tid, 0, 'wobble', 1), /unknown step param/);
});

test('setNote validates 0..127|null; clearStep resets to defaults', () => {
  const s = fresh();
  const tid = s.getProject().tracks[6].id;
  s.setNote(tid, 0, 71);
  assert.equal(stepsOf(s, 6)[0].note, 71);
  s.setNote(tid, 0, null);
  assert.equal(stepsOf(s, 6)[0].note, null);
  s.setNote(tid, 0, undefined);
  assert.equal(stepsOf(s, 6)[0].note, null);
  s.setStepParam(tid, 1, 'note', { dir: 1 });
  assert.equal(stepsOf(s, 6)[1].note, 61);
  s.setStepParam(tid, 1, 'note', { dir: -1 });
  assert.equal(stepsOf(s, 6)[1].note, 60);
  assert.throws(() => s.setNote(tid, 0, 128), RangeError);
  assert.throws(() => s.setNote(tid, 0, -1), RangeError);
  assert.throws(() => s.setNote(tid, 0, 3.5), RangeError);
  const st = stepsOf(s, 6);
  Object.assign(st[2], { on: true, vel: 0.11, prob: 0.2, ratchet: 4, nudge: 22, note: 40 });
  s.clearStep(tid, 2);
  assert.deepEqual(st[2], makeStep());
});

test('undo/redo restores exact JSON equality; flags and change events correct', () => {
  const s = fresh();
  const evs = changes(s);
  const tid = s.getProject().tracks[0].id;
  assert.equal(s.canUndo, false);
  assert.equal(s.canRedo, false);
  assert.equal(s.undo(), false);
  assert.equal(s.redo(), false);
  const j0 = s.getJSON();
  s.toggleStep(tid, 5);
  const s1 = s.getJSON();
  assert.notDeepEqual(s1, j0);
  s.setMixer(tid, { volume: 0.5, mute: true, solo: true });
  const s2 = s.getJSON();
  assert.notDeepEqual(s2, s1);
  assert.equal(s.canUndo, true);
  assert.equal(s.undo(), true);
  assert.deepEqual(s.getJSON(), s1);
  assert.equal(s.canUndo, true);
  assert.equal(s.undo(), true);
  assert.deepEqual(s.getJSON(), j0);
  assert.equal(s.canUndo, false);
  assert.equal(s.undo(), false);
  assert.equal(s.canRedo, true);
  assert.equal(s.redo(), true);
  assert.deepEqual(s.getJSON(), s1);
  assert.equal(s.redo(), true);
  assert.deepEqual(s.getJSON(), s2);
  assert.equal(s.canRedo, false);
  assert.deepEqual(evs.map(e => e.reason), ['toggleStep', 'setMixer', 'undo', 'undo', 'redo', 'redo']);
});

test('step clipboard copy/paste across patterns with edge truncation', () => {
  const s = fresh();
  const tid = s.getProject().tracks[1].id;
  const steps = stepsOf(s, 1);
  Object.assign(steps[2], { on: true, vel: 0.66, prob: 0.5, ratchet: 2, nudge: 9 });
  Object.assign(steps[3], { on: false, vel: 0.66, prob: 0.5, ratchet: 2, nudge: 9 });
  Object.assign(steps[4], { on: true, vel: 0.2, prob: 1, ratchet: 3, nudge: -5 });
  const srcSnap = JSON.stringify([steps[2], steps[3], steps[4]]);
  assert.equal(s.copySteps(tid, 2, 4), 3);
  const p2 = s.addPattern();
  const patEvts = [];
  s.addEventListener('pattern', e => patEvts.push(e.detail.id));
  s.selectPattern(p2);
  assert.deepEqual(patEvts, [p2]);
  assert.equal(s.selectedPatternId, p2);
  s.pasteSteps(tid, 8);
  const dst = stepsOf(s, 1);
  for (let k = 0; k < 3; k++) assert.deepEqual(dst[8 + k], JSON.parse(srcSnap)[k]);
  assert.equal(JSON.stringify([steps[2], steps[3], steps[4]]), srcSnap);
  s.pasteSteps(tid, 15);
  assert.equal(dst.length, 16);
  assert.deepEqual(dst[15], JSON.parse(srcSnap)[0]);
  assert.equal(stepsOf(s, 1).length, 16);
  assert.throws(() => s.pasteSteps(tid, 16), RangeError);
  const empty = fresh();
  assert.throws(() => empty.pasteSteps(empty.getProject().tracks[0].id, 0), /clipboard empty/);
});

test('copyTrackToPattern duplicates whole track into target pattern', () => {
  const s = fresh();
  const tid = s.getProject().tracks[0].id;
  const p1steps = JSON.parse(JSON.stringify(stepsOf(s, 0)));
  const p2 = s.addPattern();
  s.copyTrackToPattern(tid, p2);
  const dst = stepsOf(s, 0);
  assert.deepEqual(dst, p1steps);
  assert.throws(() => s.copyTrackToPattern(tid, 'nope'), /unknown pattern/);
  assert.throws(() => s.copyTrackToPattern('ghost', p2), /unknown track/);
});

test('deletePattern fixes song.chain, falls back selection, guards last pattern', () => {
  const s = fresh();
  const p2 = s.addPattern();
  const p3 = s.addPattern();
  assert.notEqual(p2, p3);
  s.setSongChain(['p1', p2, 'p1', p3]);
  s.selectPattern(p2);
  s.deletePattern(p2);
  const proj = s.getProject();
  assert.equal(proj.patterns.length, 2);
  assert.deepEqual(proj.song.chain, ['p1', 'p1', p3]);
  assert.equal(s.selectedPatternId, proj.patterns[0].id);
  s.deletePattern(p3);
  assert.deepEqual(s.getProject().song.chain, ['p1', 'p1']);
  assert.throws(() => s.deletePattern('p1'), /last pattern/);
  assert.throws(() => s.deletePattern('nope'), /unknown pattern/);
});

test('setMixer sets mute/solo flags without exclusivity logic; validates ranges', () => {
  const s = fresh();
  const tid = s.getProject().tracks[0].id;
  s.setMixer(tid, { mute: true, solo: true });
  const m = s.getProject().tracks[0].mixer;
  assert.equal(m.mute, true);
  assert.equal(m.solo, true);
  s.setMixer(tid, { pan: -0.5 });
  const m2 = s.getProject().tracks[0].mixer;
  assert.equal(m2.pan, -0.5);
  assert.equal(m2.volume, 0.85);
  assert.equal(m2.mute, true);
  assert.throws(() => s.setMixer(tid, { volume: 2 }), RangeError);
  assert.throws(() => s.setMixer(tid, { pan: -1.5 }), RangeError);
  assert.throws(() => s.setMixer(tid, { mute: 'yes' }), TypeError);
  assert.throws(() => s.setMixer(tid, { solo: 1 }), TypeError);
});

test('setFX merges partials per unit and rejects bad units/values', () => {
  const s = fresh();
  const tid = s.getProject().tracks[0].id;
  s.setFX(tid, { drive: { on: true, amount: 0.9 }, delay: { division: 6 } });
  const fx = s.getProject().tracks[0].fx;
  assert.equal(fx.drive.on, true);
  assert.equal(fx.drive.amount, 0.9);
  assert.equal(fx.delay.division, 6);
  assert.equal(fx.delay.feedback, 0.35);
  assert.equal(fx.delay.mix, 0.25);
  assert.equal(fx.filter.on, false);
  assert.equal(fx.filter.cutoff, 8000);
  assert.throws(() => s.setFX(tid, { drive: { amount: 1.5 } }), RangeError);
  assert.throws(() => s.setFX(tid, { nope: {} }), /unknown fx unit/);
  assert.throws(() => s.setFX(tid, { comp: { ratio: 0.5 } }), RangeError);
  assert.throws(() => s.setFX(tid, { reverb: { mix: 2 } }), RangeError);
  assert.throws(() => s.setFX(tid, { filter: { type: 'notch' } }), /lowpass\|highpass\|bandpass/);
  assert.throws(() => s.setFX(tid, { delay: { division: 0 } }), RangeError);
});

test('setTransport merges patches; setSongChain/setSongMode validate', () => {
  const s = fresh();
  const seed0 = s.getProject().seed;
  s.setTransport({ bpm: 137.5, swing: 0.3, metronome: { enabled: true } });
  const p = s.getProject();
  assert.equal(p.bpm, 137.5);
  assert.equal(p.swing, 0.3);
  assert.deepEqual(p.timeSig, { num: 4, den: 4 });
  assert.equal(p.metronome.enabled, true);
  assert.equal(p.metronome.division, 4);
  assert.equal(p.metronome.gain, 0.5);
  assert.equal(p.seed, seed0);
  s.setTransport({ timeSig: { num: 7, den: 8 }, seed: 42 });
  assert.deepEqual(s.getProject().timeSig, { num: 7, den: 8 });
  assert.equal(s.getProject().seed, 42);
  assert.throws(() => s.setTransport({ bpm: 400 }), RangeError);
  assert.throws(() => s.setTransport({ bpm: 10 }), RangeError);
  assert.throws(() => s.setTransport({ swing: 0.7 }), RangeError);
  assert.throws(() => s.setTransport({ timeSig: { num: 4, den: 3 } }), RangeError);
  assert.throws(() => s.setTransport({ metronome: { gain: 1.5 } }), RangeError);
  assert.throws(() => s.setTransport({ metronome: { division: 17 } }), RangeError);
  assert.throws(() => s.setTransport({ seed: 1.5 }), RangeError);
  s.setSongMode('song');
  assert.equal(s.getProject().song.mode, 'song');
  assert.throws(() => s.setSongMode('jelly'));
  s.setSongChain(['p1', 'p1']);
  assert.deepEqual(s.getProject().song.chain, ['p1', 'p1']);
  assert.throws(() => s.setSongChain(['zzz']), /unknown pattern id/);
  assert.throws(() => s.setSongChain('p1'), TypeError);
});

test('randomizeTrack is deterministic per seeded rng and clears first', () => {
  const run = (seed, opts) => {
    const s = fresh();
    const tid = s.getProject().tracks[0].id;
    s.randomizeTrack(tid, mulberry32(seed), opts);
    return JSON.stringify(stepsOf(s, 0));
  };
  const a = run(1234, { density: 0.5, velRange: [0.5, 1] });
  const b = run(1234, { density: 0.5, velRange: [0.5, 1] });
  const c = run(4321, { density: 0.5, velRange: [0.5, 1] });
  assert.equal(a, b);
  assert.notEqual(a, c);
  const s = fresh();
  const tid = s.getProject().tracks[0].id;
  assert.ok(stepsOf(s, 0).some(st => st.on));
  s.randomizeTrack(tid, mulberry32(7), { density: 0 });
  for (const st of stepsOf(s, 0)) assert.equal(st.on, false);
  s.randomizeTrack(tid, mulberry32(9), { density: 1, probable: true });
  for (const st of stepsOf(s, 0)) {
    assert.equal(st.on, true);
    assert.ok(st.vel >= 0.5 && st.vel <= 1);
    assert.ok(st.prob >= 0.25 && st.prob <= 1);
    assert.equal(st.ratchet, 1);
    assert.equal(st.nudge, 0);
    assert.equal(st.note, null);
  }
  assert.throws(() => s.randomizeTrack(tid, mulberry32(1), { velRange: [0.9, 0.1] }), RangeError);
});

test('humanizeTrack keeps nudges integer within ±40 and vel within 0..1', () => {
  const s = fresh();
  const tid = s.getProject().tracks[0].id;
  for (let i = 0; i < 16; i++) {
    s.toggleStep(tid, i);
    s.setStepParam(tid, i, 'vel', 1);
    s.setStepParam(tid, i, 'nudge', 0);
  }
  s.humanizeTrack(tid, mulberry32(31337), { nudgeMs: 40, velSpread: 1 });
  for (const st of stepsOf(s, 0)) {
    assert.ok(Number.isInteger(st.nudge), `nudge not int: ${st.nudge}`);
    assert.ok(st.nudge >= -40 && st.nudge <= 40, `nudge out of range: ${st.nudge}`);
    assert.ok(st.vel >= 0 && st.vel <= 1, `vel out of range: ${st.vel}`);
  }
  s.humanizeTrack(tid, mulberry32(777));
  for (const st of stepsOf(s, 0)) {
    assert.ok(Number.isInteger(st.nudge) && st.nudge >= -40 && st.nudge <= 40);
    assert.ok(st.vel >= 0 && st.vel <= 1);
  }
  const s2 = fresh();
  const hatId = s2.getProject().tracks[3].id;
  const hatSteps = stepsOf(s2, 3);
  const offBefore = JSON.stringify(hatSteps.slice(0, 14));
  s2.humanizeTrack(hatId, mulberry32(55), { nudgeMs: 20, velSpread: 0.5 });
  assert.equal(JSON.stringify(hatSteps.slice(0, 14)), offBefore);
  const on = hatSteps[14];
  assert.ok(Number.isInteger(on.nudge) && on.nudge >= -40 && on.nudge <= 40);
  assert.ok(on.vel >= 0 && on.vel <= 1);
});

test('replaceProject validates by default, rejects invalid, supports validate:false', () => {
  const s = fresh();
  const next = defaultProject();
  next.name = 'Remix';
  s.replaceProject(next);
  assert.equal(s.getProject().name, 'Remix');
  assert.equal(s.selectedPatternId, 'p1');
  const bad = defaultProject();
  bad.bpm = 999;
  assert.throws(() => s.replaceProject(bad), /bpm/);
  assert.equal(s.getProject().name, 'Remix');
  const bad2 = defaultProject();
  bad2.patterns[0].steps.ghost = new Array(16).fill(makeStep());
  assert.throws(() => s.replaceProject(bad2), /unknown track/);
  s.replaceProject(bad, { validate: false });
  assert.equal(s.getProject().bpm, 999);
  const evs = changes(s);
  s.undo();
  assert.equal(evs[0].reason, 'undo');
});

test('track params, length and name merge/validate correctly', () => {
  const s = fresh();
  const synth = s.getProject().tracks[6];
  const kick = s.getProject().tracks[0];
  s.setTrackParams(synth.id, { cutoff: 1200, glide: 0.05 });
  assert.equal(synth.params.cutoff, 1200);
  assert.equal(synth.params.glide, 0.05);
  assert.equal(synth.params.wave, 'sawtooth');
  assert.equal(synth.params.detune, 0);
  assert.throws(() => s.setTrackParams(kick.id, { piece: 'cowbell' }), /params\.piece/);
  s.setTrackParams(kick.id, { decay: 0.5 });
  assert.equal(kick.params.decay, 0.5);
  assert.equal(kick.params.pitch, 48);
  s.setTrackLength(kick.id, 24);
  assert.equal(kick.length, 24);
  assert.throws(() => s.setTrackLength(kick.id, 0), RangeError);
  assert.throws(() => s.setTrackLength(kick.id, 65), RangeError);
  assert.throws(() => s.setTrackLength(kick.id, 2.5), RangeError);
  s.setTrackName(kick.id, 'Boom');
  assert.equal(kick.name, 'Boom');
  assert.throws(() => s.setTrackName(kick.id, ''), TypeError);
  assert.throws(() => s.setTrackParams('ghost', {}), /unknown track/);
});
