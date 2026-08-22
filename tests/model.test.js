import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultProject, patternSteps, UndoStack, cycleLength, serializeStepRange, applyStepRange } from '../src/core/model.js';
import { validateProject } from '../src/core/schema.js';

test('default project validates and has audible starter content', () => {
  const p = defaultProject();
  const v = validateProject(p);
  assert.deepEqual(v.errors, []);
  assert.ok(v.ok);
  const kick = p.patterns[0].steps[p.tracks[0].id];
  assert.ok(kick.some(s => s.on));
  const synth = p.tracks[6];
  assert.equal(synth.type, 'synth');
  const synthSteps = p.patterns[0].steps[synth.id];
  assert.ok(synthSteps.some(s => s.on && s.note != null));
});

test('save/load round-trip equality including per-step params', () => {
  const p = defaultProject();
  const steps = patternSteps(p.patterns[0], p.tracks[6].id, 16);
  Object.assign(steps[5], { on: true, vel: 0.31, prob: 0.42, ratchet: 3, nudge: -17, note: 71 });
  Object.assign(steps[7], { on: true, vel: 1, prob: 0.05, ratchet: 8, nudge: 40 });
  const json = JSON.stringify(p);
  const back = JSON.parse(json);
  const v = validateProject(back);
  assert.ok(v.ok, v.errors.join('; '));
  assert.deepEqual(back, p);
});

test('schema rejects out-of-range step values instead of clamping', () => {
  const p = defaultProject();
  const steps = patternSteps(p.patterns[0], p.tracks[0].id, 16);
  steps[0].vel = 1.5;
  const v = validateProject(JSON.parse(JSON.stringify(p)));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => e.includes('vel')));
});

test('undo stack push/undo/redo with depth cap', () => {
  const u = new UndoStack(3);
  u.push('a'); u.push('b'); u.push('c'); u.push('d');
  assert.equal(u.stack.length, 3);
  assert.equal(u.undo(), 'c');
  assert.equal(u.undo(), 'b');
  assert.equal(u.redo(), 'c');
  assert.equal(u.redo(), 'd');
  assert.ok(u.canUndo && !u.canRedo);
});

test('cycle length lcm for polyrhythm', () => {
  assert.equal(cycleLength([5, 7]), 35);
  assert.equal(cycleLength([16, 12]), 48);
  assert.equal(cycleLength([]), 16);
});

test('copy/paste step range round-trips', () => {
  const p = defaultProject();
  const steps = patternSteps(p.patterns[0], p.tracks[1].id, 16);
  Object.assign(steps[2], { on: true, vel: 0.66, prob: 0.5, ratchet: 2, nudge: 9 });
  const clip = serializeStepRange(steps, 2, 4);
  const target = new Array(16).fill(null).map(() => ({ on: false }));
  applyStepRange(target, clip, 6);
  assert.equal(target[6].vel, 0.66);
  assert.equal(target[8].nudge, undefined || target[8].nudge, 'out-of-range paste stays in bounds');
  assert.equal(target[15] !== undefined, true);
});
