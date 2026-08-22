// Pure music-theory helpers for Gridpulse.
// No DOM, no WebAudio: safe to import in node tests and workers alike.
//
// Conventions:
//   key       : pitch class of the tonic, integer 0..11 (0 = C)
//   midi note : integer 0..127
//   note class: pitch class of a note, (midi % 12), relative interval to key
//               is ((noteClass - key) + 12) % 12

export const SCALES = {
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
};

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Memoized expansion of a key/scale pair into sorted MIDI notes over 0..127.
const scaleCache = new Map();

function normalizeKey(key) {
  const k = Math.round(Number(key));
  if (!Number.isFinite(k)) return 0;
  return ((k % 12) + 12) % 12;
}

function resolveScale(scaleName) {
  return Object.prototype.hasOwnProperty.call(SCALES, scaleName) ? SCALES[scaleName] : null;
}

function scaleSet(key, scaleName) {
  const k = normalizeKey(key);
  const cacheKey = k + ':' + String(scaleName);
  let entry = scaleCache.get(cacheKey);
  if (entry) return entry;
  const intervals = resolveScale(scaleName);
  if (!intervals) throw new Error('Unknown scale: ' + String(scaleName));
  const classes = intervals.map(i => (k + i) % 12);
  const classSet = new Set(classes);
  const notes = [];
  for (let n = 0; n <= 127; n++) {
    if (classSet.has(n % 12)) notes.push(n);
  }
  entry = { notes, classSet };
  scaleCache.set(cacheKey, entry);
  return entry;
}

export function isInScale(midiNote, key, scaleName) {
  const { classSet } = scaleSet(key, scaleName);
  return classSet.has(((Math.round(Number(midiNote)) % 12) + 12) % 12);
}

// Sorted array of all MIDI notes 0..127 belonging to key/scaleName.
export function scaleNotes(key, scaleName) {
  return scaleSet(key, scaleName).notes.slice();
}

// Nearest MIDI note in the scale. Ties resolve downward (lower wins).
// Inputs outside 0..127 are clamped into range first.
export function snapToScale(midiNote, key, scaleName) {
  const { notes } = scaleSet(key, scaleName);
  let n = Math.round(Number(midiNote));
  if (!Number.isFinite(n)) n = 0;
  if (n < 0) n = 0;
  if (n > 127) n = 127;

  // Binary search for the rightmost scale note <= n.
  let lo = 0;
  let hi = notes.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid] <= n) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
  }

  const below = idx >= 0 ? notes[idx] : -1;
  const above = idx + 1 < notes.length ? notes[idx + 1] : -1;

  if (below === -1) return above;      // nothing at/below: nearest is above
  if (above === -1) return below;      // nothing above: nearest is at/below

  const dDown = n - below;
  const dUp = above - n;
  // Tie (dUp === dDown) resolves downward.
  return dUp < dDown ? above : below;
}

// Mutates `steps` in place: every step whose `note` is non-null has its note
// snapped to the scale. Returns how many steps changed value.
export function quantizeSteps(steps, key, scaleName) {
  if (!Array.isArray(steps)) throw new TypeError('quantizeSteps expects an array of steps');
  let changed = 0;
  for (const s of steps) {
    if (!s || s.note == null) continue;
    const snapped = snapToScale(s.note, key, scaleName);
    if (snapped !== s.note) {
      s.note = snapped;
      changed++;
    }
  }
  return changed;
}
