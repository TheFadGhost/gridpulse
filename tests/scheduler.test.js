import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/audio/scheduler.js';

const TICK_MS = 30;

function mockClock() {
  let t = 100;
  return {
    getNow: () => t,
    advance(ms) { t += ms / 1000; },
    set(v) { t = v; },
    now: () => t
  };
}

function stepView({ tracks, length = 16, seed = 42, swing = 0, metro = null, bpm = 120 }) {
  const patterns = { p1: { id: 'p1', length, steps: {} } };
  for (const tr of tracks) patterns.p1.steps[tr.id] = tr.steps;
  return {
    tracks,
    patterns,
    patternId: 'p1',
    chain: ['p1'],
    songMode: false,
    seed,
    swing,
    metronome: metro,
    bpm,
    stepsPerBeat: 4,
    beatsPerBar: 4
  };
}

function runFor(sched, clock, seconds) {
  const end = clock.now() + seconds;
  while (clock.now() < end) {
    sched.tick();
    clock.advance(TICK_MS);
  }
  sched.tick();
}

function track(id, length, onSteps, type = 'drum') {
  const steps = Array.from({ length }, (_, i) => ({
    on: onSteps.includes(i), vel: 0.8, prob: 1, ratchet: 1, nudge: 0, note: null
  }));
  return { id, type, length, steps };
}

test('zero cumulative drift over a simulated hour', () => {
  const clock = mockClock();
  const view = stepView({ tracks: [track('a', 16, [...Array(16).keys()])] });
  const events = [];
  const sched = new Scheduler({
    getNow: clock.getNow,
    getView: () => view,
    onEvent: e => events.push(e)
  });
  sched.start(clock.now() + 0.06);
  runFor(sched, clock, 3600);

  const expectedCount = Math.floor((3600 * 2) / 1) * 16 / 16;
  assert.ok(events.length > 3800 * 16 / 16 - 64, `expected many events, got ${events.length}`);
  assert.ok(expectedCount > 0);
  for (const e of events) {
    const ideal = sched.stepBaseTime(e.stepIndex);
    assert.ok(
      Math.abs(e.time - ideal) < 1e-12,
      `drift at step ${e.stepIndex}: ${e.time} vs ${ideal}`
    );
  }
  const lastStep = Math.floor((clock.now() + 0.18 - (sched.anchors[0].time)) * 2);
  assert.ok(lastStep > 7000, 'an hour of 16ths at 120bpm should pass 7000 steps');
});

test('swing shifts odd steps by the exact contracted amount', () => {
  const clock = mockClock();
  const view = stepView({ tracks: [track('a', 16, [...Array(16).keys()])], swing: 0.45 });
  const events = [];
  const sched = new Scheduler({ getNow: clock.getNow, getView: () => view, onEvent: e => events.push(e) });
  sched.start(clock.now());
  sched.tick();
  for (const e of events) {
    const base = sched.stepBaseTime(e.stepIndex);
    const expected = base + (e.stepIndex % 2 === 1 ? 0.45 * (60 / 120) / 4 : 0);
    assert.ok(Math.abs(e.time - expected) < 1e-12, `step ${e.stepIndex}`);
  }
});

test('nudge and ratchet produce exact event times', () => {
  const clock = mockClock();
  const tr = track('a', 16, []);
  tr.steps[0] = { on: true, vel: 0.9, prob: 1, ratchet: 4, nudge: 12, note: null };
  tr.steps[2] = { on: true, vel: 0.5, prob: 1, ratchet: 1, nudge: -40, note: null };
  const view = stepView({ tracks: [tr] });
  const events = [];
  const sched = new Scheduler({ getNow: clock.getNow, getView: () => view, onEvent: e => events.push(e) });
  sched.start(clock.now());
  while (!events.some(e => e.stepIndex === 2)) { sched.tick(); clock.advance(TICK_MS); }

  const s0 = events.filter(e => e.stepIndex === 0);
  assert.equal(s0.length, 4);
  const span = sched.stepBaseTime(1) - sched.stepBaseTime(0);
  for (let r = 0; r < 4; r++) {
    const expected = sched.stepBaseTime(0) + 0.012 + r * span / 4;
    assert.ok(Math.abs(s0[r].time - expected) < 1e-12, `ratchet ${r}`);
    assert.equal(s0[r].ratchet, 4);
  }
  const s2 = events.filter(e => e.stepIndex === 2);
  assert.equal(s2.length, 1);
  assert.ok(Math.abs(s2[0].time - (sched.stepBaseTime(2) - 0.04)) < 1e-12);
});

test('polyrhythmic track lengths cycle correctly (5 vs 7)', () => {
  const clock = mockClock();
  const a = track('a', 5, [0]);
  const b = track('b', 7, [0]);
  const view = stepView({ tracks: [a, b], length: 70 });
  const events = [];
  const sched = new Scheduler({ getNow: clock.getNow, getView: () => view, onEvent: e => events.push(e) });
  sched.start(clock.now());
  runFor(sched, clock, 240);

  const ea = events.filter(e => e.trackId === 'a');
  const eb = events.filter(e => e.trackId === 'b');
  assert.ok(ea.length > 200 && eb.length > 140);
  for (const e of ea) assert.equal(((e.stepIndex % 5) + 5) % 5, 0, `track a fires off-length at ${e.stepIndex}`);
  for (const e of eb) assert.equal(((e.stepIndex % 7) + 7) % 7, 0, `track b fires off-length at ${e.stepIndex}`);
  const sa = new Set(ea.map(e => e.stepIndex));
  assert.ok([...sa].some(s => s % 35 === 0), 'cycle realigns every lcm(5,7)=35 steps');
});

test('probability: deterministic under fixed seed and ~correct distribution', () => {
  const mkSteps = () => track('a', 16, [...Array(16).keys()]);
  function collect(seed) {
    const clock = mockClock();
    const tr = mkSteps();
    for (const st of tr.steps) { st.prob = 0.25; }
    const view = stepView({ tracks: [tr], seed });
    const events = [];
    const sched = new Scheduler({ getNow: clock.getNow, getView: () => view, onEvent: e => events.push(e) });
    sched.start(clock.now());
    runFor(sched, clock, 900);
    return { stream: events.map(e => `${e.stepIndex % 16}`).join(','), attempts: Math.floor(sched.cursorStep / 16) * 16 };
  }
  const r1 = collect(1234);
  const r2 = collect(1234);
  assert.equal(r1.stream, r2.stream, 'same seed must give identical event stream');

  const fired = r1.stream.split(',').length;
  assert.ok(fired > 1000, 'enough samples for statistics');
  const rate = fired / r1.attempts;
  assert.ok(rate > 0.22 && rate < 0.28, `firing rate ${rate.toFixed(3)}, want ~0.25`);

  const counts = {};
  for (const k of r1.stream.split(',')) counts[k] = (counts[k] || 0) + 1;
  for (let s = 0; s < 16; s++) {
    const c = counts[s] || 0;
    const cycles = r1.attempts / 16;
    const frac = c / cycles;
    assert.ok(frac > 0.17 && frac < 0.33, `step ${s} fired ${frac.toFixed(3)} of cycles, want ~0.25`);
  }
});

test('tempo change mid-playback drops nothing and duplicates nothing', () => {
  const clock = mockClock();
  const view = stepView({ tracks: [track('a', 16, [...Array(16).keys()])] });
  const events = [];
  const sched = new Scheduler({ getNow: clock.getNow, getView: () => view, onEvent: e => events.push(e) });
  sched.start(clock.now());

  const end = clock.now() + 20;
  while (clock.now() < end) {
    sched.tick();
    clock.advance(TICK_MS);
    if (!sched.pendingBpm && sched.cursorStep >= 40 && sched.cursorStep < 41) sched.requestTempo(90);
  }

  const seen = events.map(e => e.stepIndex);
  const uniq = new Set(seen);
  assert.equal(seen.length, uniq.size, 'no duplicated step indices');
  const sorted = [...uniq].sort((x, y) => x - y);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1] >= 20 && sorted[i] < sorted[sorted.length - 1]) {
      assert.equal(sorted[i], sorted[i - 1] + 1, `gap between ${sorted[i - 1]} and ${sorted[i]}`);
      break;
    }
  }
  for (const e of events) {
    const ideal = sched.stepBaseTime(e.stepIndex);
    assert.ok(Math.abs(e.time - ideal) < 1e-12, `event ${e.stepIndex} moved after tempo change`);
  }
  const pre = events.find(e => e.stepIndex === 39);
  const post = events.find(e => e.stepIndex === 41);
  assert.ok(post.time - pre.time > (41 - 39) * (60 / 120) / 4, 'post-change spacing reflects 90bpm');
});

test('metronome emits per division with bar accents', () => {
  const clock = mockClock();
  const view = stepView({
    tracks: [], metro: { enabled: true, division: 4, gain: 0.5 }
  });
  const events = [];
  const sched = new Scheduler({ getNow: clock.getNow, getView: () => view, onEvent: e => events.push(e) });
  sched.start(clock.now());
  runFor(sched, clock, 8);
  const metroEvents = events.filter(e => e.trackId === '__metro__');
  assert.deepEqual(metroEvents.slice(0, 8).map(e => e.stepIndex), [0, 4, 8, 12, 16, 20, 24, 28]);
  assert.equal(metroEvents[0].note, 1, 'bar start accented');
  assert.equal(metroEvents[1].note, 0, 'intra-bar unaccented');
});

