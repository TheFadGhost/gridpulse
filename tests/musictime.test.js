import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBeatMap, swingDelaySeconds } from '../src/core/musictime.js';

test('constant tempo mapping', () => {
  const m = makeBeatMap([{ beat: 0, time: 10, bpm: 120 }]);
  assert.equal(m.beatToSec(0), 10);
  assert.equal(m.beatToSec(4), 12);
  assert.ok(Math.abs(m.secToBeat(11.5) - 3) < 1e-12);
});

test('tempo change anchor is continuous', () => {
  const m = makeBeatMap([
    { beat: 0, time: 0, bpm: 60 },
    { beat: 8, time: 8, bpm: 120 }
  ]);
  assert.equal(m.beatToSec(8), 8);
  assert.equal(m.beatToSec(10), 9);
  assert.equal(m.beatToSec(4), 4);
  assert.equal(m.secToBeat(8), 8);
});

test('beat<->sec round trip across anchors', () => {
  const m = makeBeatMap([
    { beat: 0, time: 5, bpm: 137.5 },
    { beat: 16, time: 5 + 16 * (60 / 137.5), bpm: 90 }
  ]);
  for (const b of [0, 3.25, 16, 17.5, 40]) {
    assert.ok(Math.abs(m.secToBeat(m.beatToSec(b)) - b) < 1e-9, `beat ${b}`);
  }
});

test('swing formula matches contract exactly', () => {
  assert.equal(swingDelaySeconds(0, 120, 0.6), 0);
  assert.equal(swingDelaySeconds(1, 120, 0.6), 0.6 * 0.5 / 4);
  assert.equal(swingDelaySeconds(2, 120, 0.6), 0);
  assert.equal(swingDelaySeconds(63, 120, 0), 0);
});
