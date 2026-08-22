// Scale engine conformance: every scale x every key (12 keys x 12 scales,
// 144 combos), snap round-trips incl. downward tie resolution, and
// quantizeSteps mutation/count semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCALES, NOTE_NAMES, scaleNotes, snapToScale, quantizeSteps } from '../src/core/scales.js';

const SCALE_NAMES = Object.keys(SCALES);
const KEYS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

function relClass(midiNote, key) {
  return (((midiNote % 12) - key) % 12 + 12) % 12;
}

function makeStep(note) {
  return { on: note != null, vel: 0.8, prob: 1, ratchet: 1, nudge: 0, note };
}

// Brute-force reference: nearest scale note, ties resolve downward.
function refSnap(target, notes) {
  let best = notes[0];
  for (const s of notes) {
    const dBest = Math.abs(best - target);
    const dS = Math.abs(s - target);
    if (dS < dBest || (dS === dBest && s < best)) best = s;
  }
  return best;
}

test('SCALES table matches the spec verbatim', () => {
  assert.deepEqual(SCALES, {
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    phrygian: [0, 1, 3, 5, 7, 8, 10],
    lydian: [0, 2, 4, 6, 7, 9, 11],
    mixolydian: [0, 2, 4, 5, 7, 9, 10],
    locrian: [0, 1, 3, 5, 6, 8, 10],
    pentatonicMajor: [0, 2, 4, 7, 9],
    pentatonicMinor: [0, 3, 5, 7, 10],
    blues: [0, 3, 5, 6, 7, 10],
    chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  });
});

test('NOTE_NAMES are twelve chromatic names starting at C', () => {
  assert.deepEqual(NOTE_NAMES, ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']);
});

test('scaleNotes: every scale x every key yields sorted unique in-range notes with correct classes', () => {
  for (const name of SCALE_NAMES) {
    const intervals = new Set(SCALES[name]);
    for (const key of KEYS) {
      const notes = scaleNotes(key, name);
      const seen = new Set();
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        assert.ok(Number.isInteger(n), `${name}/${key}: non-integer ${n}`);
        assert.ok(n >= 0 && n <= 127, `${name}/${key}: out of range ${n}`);
        assert.ok(!seen.has(n), `${name}/${key}: duplicate ${n}`);
        seen.add(n);
        if (i > 0) assert.ok(notes[i - 1] < n, `${name}/${key}: not ascending at index ${i}`);
        assert.ok(
          intervals.has(relClass(n, key)),
          `${name}/key ${key}: note ${n} has class ${relClass(n, key)} not in intervals`
        );
      }
    }
  }
});

test('scaleNotes: complete — no MIDI note whose class is in the scale is missing', () => {
  for (const name of SCALE_NAMES) {
    const intervals = new Set(SCALES[name]);
    for (const key of KEYS) {
      const set = new Set(scaleNotes(key, name));
      for (let n = 0; n < 128; n++) {
        assert.equal(set.has(n), intervals.has(relClass(n, key)), `${name}/${key} n=${n}`);
      }
    }
  }
});

test('scaleNotes sizes per octave match interval counts across range', () => {
  // e.g. C major spans 0..127 with a full octave count except truncated ends
  for (const name of SCALE_NAMES) {
    const perOctave = SCALES[name].length;
    const notes = scaleNotes(0, name);
    const octaves = Math.floor(128 / 12); // 10 full + 8 leftover semitones
    assert.ok(notes.length >= octaves * perOctave, `${name}: too few notes`);
    assert.ok(notes.length <= (octaves + 1) * perOctave, `${name}: too many notes`);
  }
  assert.equal(scaleNotes(0, 'chromatic').length, 128);
  assert.equal(scaleNotes(0, 'pentatonicMajor').length, 54); // 10*5 + 4 truncated-edge notes
});

test('snapToScale round-trip: result always in scale, scale notes fixed, matches reference (all combos)', () => {
  for (const name of SCALE_NAMES) {
    for (const key of KEYS) {
      const notes = scaleNotes(key, name);
      const set = new Set(notes);
      for (const s of notes) {
        assert.equal(snapToScale(s, key, name), s, `${name}/${key}: scale note ${s} moved`);
      }
      for (let n = 0; n < 128; n++) {
        const snapped = snapToScale(n, key, name);
        assert.ok(set.has(snapped), `${name}/${key}: snap(${n})=${snapped} off-scale`);
        assert.equal(snapped, refSnap(n, notes), `${name}/${key}: snap(${n}) wrong nearest/tie`);
      }
    }
  }
});

test('snapToScale ties resolve downward (lower neighbour wins)', () => {
  // C major gaps of two semitones put odd midpoints equidistant.
  assert.equal(snapToScale(61, 0, 'major'), 60); // C#4 -> C4 (not D4)
  assert.equal(snapToScale(63, 0, 'major'), 62); // D#4 -> D4
  assert.equal(snapToScale(66, 0, 'major'), 65); // F#4 -> F4
  assert.equal(snapToScale(68, 0, 'major'), 67); // G#4 -> G4
  assert.equal(snapToScale(70, 0, 'major'), 69); // A#4 -> A4
  assert.equal(snapToScale(1, 0, 'pentatonicMajor'), 0);
  assert.equal(snapToScale(3, 0, 'pentatonicMajor'), 2);
  assert.equal(snapToScale(6, 0, 'blues'), 6); // blue note itself is in-scale
});

test('snapToScale clamps inputs outside 0..127 to the nearest boundary note', () => {
  assert.equal(snapToScale(-1, 0, 'major'), 0);
  assert.equal(snapToScale(-50, 0, 'major'), 0);
  const top = scaleNotes(0, 'major').at(-1);
  assert.equal(snapToScale(200, 0, 'major'), top);
  // A key whose tonic is high still snaps into range, never out of it.
  for (const key of KEYS) {
    for (const name of SCALE_NAMES) {
      const s = snapToScale(127, key, name);
      assert.ok(s >= 0 && s <= 127);
    }
  }
});

test('quantizeSteps mutates only non-null notes and returns the change count', () => {
  const steps = [
    makeStep(60), // in C major -> unchanged
    makeStep(61), // C#4 -> snaps down to C4 (tie)
    null,         // defensive: hole in array ignored
    makeStep(null), // null note skipped
    makeStep(66), // F#4 -> snaps down to F4
    makeStep(67)  // G4 unchanged
  ];
  const before = steps.map(s => (s ? s.note : undefined));
  const changed = quantizeSteps(steps, 0, 'major');
  assert.equal(changed, 2);
  assert.equal(steps[0].note, 60);
  assert.equal(steps[1].note, 60);
  assert.equal(steps[4].note, 65);
  assert.equal(steps[5].note, 67);
  assert.equal(steps[3].note, null);
  assert.deepEqual(steps.map(s => (s ? s.note : undefined)), before.map((n, i) => (i === 1 ? 60 : i === 4 ? 65 : n)));
  // Idempotent: second pass changes nothing.
  assert.equal(quantizeSteps(steps, 0, 'major'), 0);
});

test('quantizeSteps works for every key/scale combo on a chromatic run', () => {
  const run = Array.from({ length: 24 }, (_, i) => makeStep(48 + i));
  const changed = quantizeSteps(run, 7, 'dorian');
  const kept = run.filter(s => s.note != null);
  assert.equal(kept.length, 24);
  for (const s of kept) {
    const pc = relClass(s.note, 7);
    assert.ok(new Set(SCALES.dorian).has(pc), `note ${s.note} off-scale after quantize`);
  }
  assert.ok(changed > 0 && changed <= 24);
  // After quantizing, everything is already in scale: zero further changes.
  assert.equal(quantizeSteps(run, 7, 'dorian'), 0);
});

test('quantizeSteps rejects non-array input', () => {
  assert.throws(() => quantizeSteps(undefined, 0, 'major'), TypeError);
});

test('unknown scale name throws', () => {
  assert.throws(() => scaleNotes(0, 'nope'));
  assert.throws(() => snapToScale(60, 0, 'nope'));
});
