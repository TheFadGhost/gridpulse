import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOCK_PPQ, ClockEstimator, ClockSender, TransportMapper } from '../src/midi/clocksync.js';

const PULSE_MS_120 = 60000 / (120 * CLOCK_PPQ);

test('CLOCK_PPQ is 24', () => {
  assert.equal(CLOCK_PPQ, 24);
});

test('estimator derives 120bpm from pulses with deterministic jitter', () => {
  // Arrival jitter alternates early/late (bounded +/-3ms, magnitude slowly
  // varying). Gaps become symmetric around the ideal, so the median of any
  // even-sized window is exactly the ideal gap.
  const est = new ClockEstimator();
  const jit = i => (i % 2 === 0 ? 1 : -1) * (2 + Math.sin(i * 0.7));
  let t = 1000;
  for (let i = 0; i < 64; i++) {
    est.push(t);
    t += PULSE_MS_120 + jit(i + 1) - jit(i);
  }
  assert.equal(est.isStable(), true);
  assert.ok(Math.abs(est.bpm() - 120) < 0.01, `got ${est.bpm()} bpm`);
});

test('median robustness: dropped-pulse double gaps do not skew estimate', () => {
  const est = new ClockEstimator();
  const droppedAfter = new Set([7, 19, 31, 43]); // 4 double-gaps among 59 gaps
  let t = 0;
  for (let i = 0; i < 60; i++) {
    est.push(t);
    t += droppedAfter.has(i) ? 2 * PULSE_MS_120 : PULSE_MS_120;
  }
  assert.ok(Math.abs(est.bpm() - 120) < 0.01, `got ${est.bpm()} bpm`);
});

test('stability gating and reset', () => {
  const est = new ClockEstimator();
  assert.equal(est.isStable(), false);
  assert.equal(est.bpm(), null);
  for (let i = 1; i <= 23; i++) {
    est.push(i * PULSE_MS_120);
    assert.equal(est.isStable(), false, `pulse ${i + 1}`);
  }
  est.push(24 * PULSE_MS_120);
  assert.equal(est.isStable(), true);
  assert.ok(Math.abs(est.bpm() - 120) < 1e-9);
  est.reset();
  assert.equal(est.isStable(), false);
  assert.equal(est.bpm(), null);
});

test('sender plans exact pulse counts in windows, strictly increasing, on grid', () => {
  const sender = new ClockSender();
  for (const bpm of [120, 128, 137.5]) {
    const step = 60 / (bpm * CLOCK_PPQ);

    // Full minute: exactly PPQ*bpm pulses (integer pulse-per-minute tempos).
    const minute = sender.plan({ startSec: 0, endSec: 60, bpm });
    assert.equal(minute.length, Math.round(24 * bpm), `${bpm} pulses/min`);
    for (let i = 0; i < minute.length; i++) {
      assert.ok(minute[i] >= 0 && minute[i] < 60, `tick ${i} inside window`);
      if (i) assert.ok(minute[i] > minute[i - 1], `tick ${i} strictly increasing`);
      assert.ok(Math.abs(minute[i] / step - Math.round(minute[i] / step)) < 1e-6, `tick ${i} on grid`);
    }

    // Off-grid interior windows built as tick-grid fractions (FP-stable).
    for (const [kA, kB] of [[67.5, 300.25], [0, 48.5], [1000.25, 1000.75]]) {
      const s = kA * step, e = kB * step;
      const plan = sender.plan({ startSec: s, endSec: e, bpm });
      const expected = Math.ceil(kB) - Math.ceil(kA);
      assert.equal(plan.length, expected, `${bpm} [${s},${e}) count`);
      for (let i = 0; i < plan.length; i++) {
        assert.ok(plan[i] >= s && plan[i] < e, `tick ${i} in [start,end)`);
        if (i) assert.ok(plan[i] > plan[i - 1]);
      }
      if (plan.length) {
        assert.ok(plan[0] >= s, 'first tick at or after start');
        assert.ok(e - plan[plan.length - 1] <= step && e - plan[plan.length - 1] > 0);
      }
    }
  }
});

test('sender adjacent windows tile without duplicates or gaps (on-grid seam)', () => {
  const sender = new ClockSender();
  const bpm = 120;
  const step = 60 / (bpm * CLOCK_PPQ);
  const B = 96 * step; // boundary lands exactly on a tick
  const w1 = sender.plan({ startSec: 0, endSec: B, bpm });
  const w2 = sender.plan({ startSec: B, endSec: 2 * B, bpm });
  assert.ok(w1.length > 0 && w2.length > 0);
  assert.ok(w1[w1.length - 1] < B, 'first window excludes its end');
  assert.ok(Math.abs(w2[0] - w1[w1.length - 1] - step) < 1e-9, `seam gap ${w2[0] - w1[w1.length - 1]} vs step ${step}`);
  const union = [...w1, ...w2];
  for (let i = 1; i < union.length; i++) {
    assert.ok(Math.abs(union[i] - union[i - 1] - step) < 1e-9, `spacing at ${i}`);
  }
});

test('sender degenerate windows and invalid input', () => {
  const sender = new ClockSender();
  assert.deepEqual(sender.plan({ startSec: 5, endSec: 5, bpm: 120 }), []);
  assert.deepEqual(sender.plan({ startSec: 5, endSec: 4, bpm: 120 }), []);
  assert.deepEqual(sender.plan({ startSec: NaN, endSec: 10, bpm: 120 }), []);
  assert.throws(() => sender.plan({ startSec: 0, endSec: 1, bpm: 0 }), /bpm must be > 0/);
  assert.throws(() => sender.plan({ startSec: 0, endSec: 1, bpm: Infinity }));
});

test('mapper constant-tempo mapping', () => {
  const m = new TransportMapper(120);
  assert.equal(m.beatToSec(0), 0);
  assert.ok(Math.abs(m.beatToSec(2) - 1) < 1e-12);
  assert.ok(Math.abs(m.secToBeat(3) - 6) < 1e-12);
});

test('mapper setBpm keeps anchor continuity across tempo change', () => {
  const m = new TransportMapper(120);
  const before = m.beatToSec(4); // 2s
  m.setBpm(60, 4); // new tempo takes effect AT beat 4
  assert.equal(m.beatToSec(4), before, 'boundary position unmoved');
  assert.equal(m.beatToSec(2), 1, 'past region unchanged');
  assert.ok(Math.abs(m.beatToSec(8) - 6) < 1e-12, '2s + 4 beats @60bpm');
  assert.ok(Math.abs(m.secToBeat(5) - 7) < 1e-12);
  assert.equal(m.secToBeat(before), 4, 'boundary inverse');
  for (const b of [0, 1.5, 4, 4.25, 9, 30]) {
    assert.ok(Math.abs(m.secToBeat(m.beatToSec(b)) - b) < 1e-9, `round trip beat ${b}`);
  }
});

test('mapper default setBpm re-anchors at frontier continuously', () => {
  const m = new TransportMapper(90);
  m.setBpm(180); // no explicit beat -> frontier (beat 0 here)
  assert.equal(m.bpm, 180);
  assert.equal(m.beatToSec(0), 0);
  assert.ok(Math.abs(m.beatToSec(1) - 1 / 3) < 1e-12);
  assert.ok(Math.abs(m.secToBeat(m.beatToSec(3.75)) - 3.75) < 1e-9);
  // chained changes keep working
  m.setBpm(90, 2);
  assert.ok(Math.abs(m.secToBeat(m.beatToSec(6)) - 6) < 1e-9);
});

test('mapper rejects invalid bpm and backwards anchors', () => {
  assert.throws(() => new TransportMapper(0));
  assert.throws(() => new TransportMapper(-5));
  assert.throws(() => new TransportMapper(NaN));
  const m = new TransportMapper(120);
  assert.throws(() => m.setBpm(0));
  assert.throws(() => m.setBpm(Infinity));
  m.setBpm(60, 8);
  assert.throws(() => m.setBpm(90, 4)); // earlier than existing anchor
});
