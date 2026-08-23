// Standard MIDI File (format 0) export conformance: header chunk layout,
// tempo meta encoding, exact delta-time bytes for a known pattern, stable
// event merge order at equal ticks, write determinism, and parse round-trips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PPQ, vlq, writePatternSMF, parseSMF } from '../src/midi/smf.js';

const hex = (s) => s.trim().split(/\s+/).map((h) => parseInt(h, 16));

test('PPQ constant is 480', () => {
  assert.equal(PPQ, 480);
});

test('vlq encodes boundary values and rejects invalid input', () => {
  assert.deepEqual(vlq(0), [0x00]);
  assert.deepEqual(vlq(0x7f), [0x7f]);
  assert.deepEqual(vlq(0x80), [0x81, 0x00]);
  assert.deepEqual(vlq(480), [0x83, 0x60]);
  assert.deepEqual(vlq(8192), [0xc0, 0x00]);
  assert.deepEqual(vlq(200000), [0x8c, 0x9a, 0x40]);
  assert.deepEqual(vlq(0x1fffff), [0xff, 0xff, 0x7f]);
  assert.deepEqual(vlq(0x0fffffff), [0xff, 0xff, 0xff, 0x7f]);
  assert.throws(() => vlq(-1), RangeError);
  assert.throws(() => vlq(1.5), RangeError);
  assert.throws(() => vlq(0x10000000), RangeError);
});

test('header chunk: MThd magic, length 6, format 0, one track, division PPQ', () => {
  const buf = writePatternSMF({ tempoBpm: 120, tracks: [{ channel: 0, events: [] }] });
  assert.equal(String.fromCharCode(...buf.slice(0, 4)), 'MThd');
  assert.deepEqual(Array.from(buf.slice(4, 8)), [0x00, 0x00, 0x00, 0x06]);
  assert.deepEqual(Array.from(buf.slice(8, 10)), [0x00, 0x00], 'format 0');
  assert.deepEqual(Array.from(buf.slice(10, 12)), [0x00, 0x01], 'ntrks 1');
  assert.deepEqual(Array.from(buf.slice(12, 14)), [(PPQ >> 8) & 0xff, PPQ & 0xff], 'division 480');
  // Multiple input tracks still collapse into one MTrk under format 0.
  const multi = writePatternSMF({
    tempoBpm: 120,
    tracks: [
      { channel: 0, events: [] },
      { channel: 1, events: [] }
    ]
  });
  assert.deepEqual(Array.from(multi.slice(8, 12)), [0x00, 0x00, 0x00, 0x01]);
});

test('tempo meta is first track event with delta 0 and encodes 60000000/bpm', () => {
  const buf = writePatternSMF({ tempoBpm: 120, tracks: [{ channel: 0, events: [] }] });
  // Track body starts after 22 bytes (MThd 14 + MTrk id/length 8).
  assert.equal(buf[22], 0x00, 'tempo meta delta time is zero');
  assert.deepEqual(Array.from(buf.slice(23, 29)), [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20]);
  assert.equal(parseSMF(buf).tracks[0].tempoUs, 500000);

  for (const bpm of [60, 90, 140, 240, 333]) {
    const parsed = parseSMF(writePatternSMF({ tempoBpm: bpm, tracks: [{ channel: 0, events: [] }] }));
    assert.equal(parsed.tracks[0].tempoUs, Math.round(60000000 / bpm));
  }
});

test('known two-note pattern emits exact bytes and tick deltas', () => {
  const spec = {
    tempoBpm: 120,
    tracks: [{
      channel: 0,
      events: [
        { tick: 0, type: 'noteOn', note: 60, velocity: 100 },
        { tick: 240, type: 'noteOff', note: 60, velocity: 64 },
        { tick: 360, type: 'noteOn', note: 62, velocity: 90 },
        { tick: 480, type: 'noteOff', note: 62, velocity: 64 }
      ]
    }]
  };
  const expected = hex(`
    4D 54 68 64 00 00 00 06 00 00 00 01 01 E0
    4D 54 72 6B 00 00 00 1C
    00 FF 51 03 07 A1 20
    00 90 3C 64
    81 70 80 3C 40
    78 90 3E 5A
    78 80 3E 40
    00 FF 2F 00
  `);
  assert.deepEqual(Array.from(writePatternSMF(spec)), expected);
  const parsed = parseSMF(writePatternSMF(spec));
  assert.deepEqual(parsed.tracks[0].events.map((e) => e.tick), [0, 240, 360, 480]);
});

test('noteOff sorts before noteOn at equal ticks; tracks merge in index order', () => {
  const spec = {
    tempoBpm: 120,
    tracks: [
      {
        channel: 0,
        events: [
          { tick: 0, type: 'noteOn', note: 60, velocity: 90 },
          { tick: 480, type: 'noteOff', note: 60, velocity: 0 },
          { tick: 480, type: 'noteOn', note: 60, velocity: 100 }
        ]
      },
      {
        channel: 0,
        events: [
          { tick: 480, type: 'noteOff', note: 62, velocity: 0 }
        ]
      }
    ]
  };
  const buf = writePatternSMF(spec);
  // Track body after tempo meta: on@0, then at 480 track 0's off-before-on
  // pair, followed by track 1's off (track index outranks event type).
  assert.deepEqual(
    Array.from(buf.slice(29)),
    hex(`
      00 90 3C 5A
      83 60 80 3C 00
      00 90 3C 64
      00 80 3E 00
      00 FF 2F 00
    `)
  );
  const evs = parseSMF(buf).tracks[0].events;
  assert.deepEqual(evs.map((e) => e.tick), [0, 480, 480, 480]);
  assert.deepEqual(evs.map((e) => e.status & 0xf0), [0x90, 0x80, 0x90, 0x80]);
});

test('writePatternSMF is deterministic and does not mutate its input', () => {
  const spec = {
    tempoBpm: 137.5,
    tracks: [
      { channel: 3, events: [{ tick: 240, type: 'noteOn', note: 45, velocity: 77 }] },
      { channel: 9, events: [{ tick: 120, type: 'noteOff', note: 38, velocity: 0 }] }
    ]
  };
  const snapshot = JSON.stringify(spec);
  const a = Array.from(writePatternSMF(spec));
  const b = Array.from(writePatternSMF(spec));
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(spec), snapshot, 'spec must not be mutated');
});

test('parseSMF round-trips every written note event', () => {
  const bpm = 137.5;
  const spec = {
    tempoBpm: bpm,
    tracks: [
      {
        channel: 0,
        events: [
          { tick: 0, type: 'noteOn', note: 60, velocity: 100 },
          { tick: 200000, type: 'noteOff', note: 60, velocity: 0 },
          { tick: 200000, type: 'noteOn', note: 127, velocity: 1 }
        ]
      },
      {
        channel: 9,
        events: [
          { tick: 96, type: 'noteOn', note: 0, velocity: 115 },
          { tick: 192, type: 'noteOff', note: 0, velocity: 0 }
        ]
      },
      {
        channel: 15,
        events: [
          { tick: 480, type: 'noteOn', note: 72, velocity: 80 },
          { tick: 960, type: 'noteOff', note: 72, velocity: 32 }
        ]
      }
    ]
  };
  const parsed = parseSMF(writePatternSMF(spec));
  assert.equal(parsed.format, 0);
  assert.equal(parsed.ntrks, 1);
  assert.equal(parsed.division, PPQ);
  assert.equal(parsed.tracks.length, 1);
  assert.equal(parsed.tracks[0].tempoUs, Math.round(60000000 / bpm));

  const want = new Map();
  for (const tr of spec.tracks) {
    for (const e of tr.events) want.set(`${e.type}:${tr.channel}:${e.note}:${e.velocity}:${e.tick}`, 0);
  }
  const got = new Map();
  let prevTick = -1;
  for (const e of parsed.tracks[0].events) {
    assert.ok(e.tick >= prevTick, `ticks not monotonic at ${e.tick}`);
    prevTick = e.tick;
    const type = (e.status & 0xf0) === 0x90 ? 'noteOn' : 'noteOff';
    assert.ok((e.status & 0xf0) === 0x90 || (e.status & 0xf0) === 0x80, `unexpected status ${e.status}`);
    const key = `${type}:${e.status & 0x0f}:${e.note}:${e.velocity}:${e.tick}`;
    got.set(key, (got.get(key) ?? 0) + 1);
  }
  assert.equal(got.size, want.size);
  for (const [key] of want) {
    assert.ok(got.has(key), `missing event ${key}`);
    assert.equal(got.get(key), 1, `duplicated event ${key}`);
  }
});

test('writePatternSMF validates its inputs', () => {
  const base = { channel: 0, events: [] };
  const ok = { tempoBpm: 120, tracks: [] };
  assert.throws(() => writePatternSMF(null), TypeError);
  assert.throws(() => writePatternSMF({ ...ok, tempoBpm: 0 }), TypeError);
  assert.throws(() => writePatternSMF({ ...ok, tempoBpm: 'fast' }), TypeError);
  assert.throws(() => writePatternSMF({ ...ok, tempoBpm: NaN }), TypeError);
  assert.throws(() => writePatternSMF({ tempoBpm: 120 }), TypeError);
  assert.throws(() => writePatternSMF({ tempoBpm: 120, tracks: [{ ...base, channel: 16 }] }), RangeError);
  assert.throws(() => writePatternSMF({ tempoBpm: 120, tracks: [{ ...base, channel: -1 }] }), RangeError);
  assert.throws(
    () => writePatternSMF({ tempoBpm: 120, tracks: [{ channel: 0, events: [{ tick: -1, type: 'noteOn', note: 60, velocity: 1 }] }] }),
    RangeError
  );
  assert.throws(
    () => writePatternSMF({ tempoBpm: 120, tracks: [{ channel: 0, events: [{ tick: 0, type: 'noteHold', note: 60, velocity: 1 }] }] }),
    TypeError
  );
  assert.throws(
    () => writePatternSMF({ tempoBpm: 120, tracks: [{ channel: 0, events: [{ tick: 0, type: 'noteOn', note: 128, velocity: 1 }] }] }),
    RangeError
  );
  assert.throws(
    () => writePatternSMF({ tempoBpm: 120, tracks: [{ channel: 0, events: [{ tick: 0, type: 'noteOn', note: 60, velocity: 999 }] }] }),
    RangeError
  );
});
