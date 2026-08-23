import {
  DRUM_PIECES, UNDO_DEPTH, UndoStack,
  applyStepRange, makeStep, patternSteps, serializeStepRange, uid
} from '../core/model.js';
import { validateProject } from '../core/schema.js';
import { quantizeSteps } from '../core/scales.js';

const STEP_BOUNDS = { vel: [0, 1], prob: [0, 1], ratchet: [1, 8], nudge: [-40, 40] };
const CYCLES = {
  vel: [0, 0.25, 0.5, 0.75, 1],
  prob: [0, 0.25, 0.5, 0.75, 1],
  ratchet: [1, 2, 3, 4, 5, 6, 7, 8],
  nudge: [-40, -30, -20, -10, 0, 10, 20, 30, 40],
};
const FX_SPEC = {
  drive: { amount: [0, 1] },
  filter: { cutoff: [30, 18000], q: [0.0001, 24] },
  comp: { threshold: [-60, 0], ratio: [1, 20], attack: [0, 1], release: [0.01, 2] },
  delay: { division: [1, 16, true], feedback: [0, 0.95], mix: [0, 1] },
  reverb: { size: [0, 1], mix: [0, 1] },
};
const FX_ENUMS = { filter: { type: ['lowpass', 'highpass', 'bandpass'] } };

class CustomEventShim extends Event {
  constructor(type, opts = {}) { super(type, opts); this.detail = opts.detail; }
}
const CtorEvt = typeof CustomEvent === 'function' ? CustomEvent : CustomEventShim;

const clone = (v) => JSON.parse(JSON.stringify(v));

function reqNum(v, lo, hi, label) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) {
    throw new RangeError(`${label}: expected ${lo}..${hi}, got ${v}`);
  }
}
function reqInt(v, lo, hi, label) {
  if (!Number.isInteger(v) || v < lo || v > hi) {
    throw new RangeError(`${label}: expected int ${lo}..${hi}, got ${v}`);
  }
}
function base26(n) {
  let s = '';
  while (true) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    if (n < 26) break;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

export class AppStore extends EventTarget {
  constructor(project) {
    super();
    this.project = clone(project);
    if (!this.project.patterns || !this.project.patterns.length) throw new Error('project requires at least one pattern');
    this._undoStack = new UndoStack(UNDO_DEPTH);
    const us = this._undoStack;
    // callable so store.undo() works; carries the UndoStack surface so
    // store.undo.canUndo / store.undo.push(...) keep functioning
    this.undo = Object.assign(() => this._doUndo(), {
      push: (snapJson) => us.push(snapJson),
      redo: () => this._doRedo(),
      get canUndo() { return us.canUndo; },
      get canRedo() { return us.canRedo; },
      get depth() { return us.depth; },
    });
    this.clipboard = [];
    this.currentPatternId = this.project.patterns[0].id;
    this._undoStack.push(JSON.stringify(this.project));
  }

  getProject() { return this.project; }
  getJSON() { return clone(this.project); }
  get selectedPatternId() { return this.currentPatternId; }
  get canUndo() { return this._undoStack.canUndo; }
  get canRedo() { return this._undoStack.canRedo; }

  emit(type, detail) { this.dispatchEvent(new CtorEvt(type, { detail })); }

  _mutate(reason, fn) {
    fn();
    this._undoStack.push(JSON.stringify(this.project));
    this.emit('change', { reason });
  }

  _track(trackId) {
    const t = this.project.tracks.find(t => t.id === trackId);
    if (!t) throw new Error(`unknown track ${trackId}`);
    return t;
  }
  _pattern(id) {
    const p = this.project.patterns.find(p => p.id === id);
    if (!p) throw new Error(`unknown pattern ${id}`);
    return p;
  }
  _cur() {
    return this.project.patterns.find(p => p.id === this.currentPatternId) || this.project.patterns[0];
  }
  _steps(trackId) {
    this._track(trackId);
    const pat = this._cur();
    return patternSteps(pat, trackId, pat.length);
  }
  _idx(i, len) { reqInt(i, 0, len - 1, 'step index'); }

  replaceProject(project, { validate = true } = {}) {
    if (validate) {
      const v = validateProject(project);
      if (!v.ok) throw new Error(`invalid project: ${v.errors.join('; ')}`);
    }
    this._mutate('replace', () => {
      this.project = clone(project);
      if (!this.project.patterns.some(p => p.id === this.currentPatternId)) {
        this.currentPatternId = this.project.patterns[0].id;
      }
    });
  }

  toggleStep(trackId, i) {
    const arr = this._steps(trackId);
    this._idx(i, arr.length);
    this._mutate('toggleStep', () => { arr[i] = { ...arr[i], on: !arr[i].on }; });
  }

  setStepParam(trackId, i, param, valueOrDir) {
    const arr = this._steps(trackId);
    this._idx(i, arr.length);
    if (param === 'note') {
      return this.setNote(trackId, i, this._resolveNote(valueOrDir, arr[i].note));
    }
    const b = STEP_BOUNDS[param];
    if (!b) throw new Error(`unknown step param ${param}`);
    const cur = arr[i][param];
    let next;
    if (valueOrDir !== null && typeof valueOrDir === 'object') {
      if ('dir' in valueOrDir) {
        const ladder = CYCLES[param];
        let k = 0, best = Infinity;
        for (let j = 0; j < ladder.length; j++) {
          const d = Math.abs(ladder[j] - cur);
          if (d < best) { best = d; k = j; }
        }
        k = Math.max(0, Math.min(ladder.length - 1, k + Math.sign(valueOrDir.dir)));
        next = ladder[k];
      } else if ('value' in valueOrDir) {
        next = valueOrDir.value;
        if (param === 'ratchet') reqInt(next, b[0], b[1], param); else reqNum(next, b[0], b[1], param);
      } else {
        throw new TypeError('valueOrDir: object must be {dir} or {value}');
      }
    } else if (typeof valueOrDir === 'number') {
      if (param === 'nudge') {
        next = Math.max(b[0], Math.min(b[1], Math.round(cur) + Math.round(valueOrDir)));
      } else {
        if (param === 'ratchet') reqInt(valueOrDir, b[0], b[1], param); else reqNum(valueOrDir, b[0], b[1], param);
        next = valueOrDir;
      }
    } else {
      throw new TypeError('valueOrDir: number or {dir}|{value} required');
    }
    this._mutate(`setStepParam.${param}`, () => { arr[i][param] = next; });
  }

  _checkNote(n) {
    if (n === null || n === undefined) return null;
    reqInt(n, 0, 127, 'note');
    return n;
  }
  _resolveNote(valueOrDir, cur) {
    if (valueOrDir !== null && typeof valueOrDir === 'object') {
      if ('dir' in valueOrDir) {
        const base = cur == null ? 60 : cur;
        return Math.max(0, Math.min(127, base + Math.sign(valueOrDir.dir)));
      }
      if ('value' in valueOrDir) return this._checkNote(valueOrDir.value);
      throw new TypeError('note: object must be {dir} or {value}');
    }
    return this._checkNote(valueOrDir);
  }

  setNote(trackId, i, midiOrNull) {
    const arr = this._steps(trackId);
    this._idx(i, arr.length);
    const note = this._checkNote(midiOrNull);
    this._mutate('setNote', () => { arr[i].note = note; });
  }

  clearStep(trackId, i) {
    const arr = this._steps(trackId);
    this._idx(i, arr.length);
    this._mutate('clearStep', () => { arr[i] = makeStep(); });
  }

  copySteps(trackId, from, to) {
    const arr = this._steps(trackId);
    reqInt(from, 0, arr.length - 1, 'from');
    reqInt(to, from, arr.length - 1, 'to');
    this.clipboard = serializeStepRange(arr, from, to);
    return this.clipboard.length;
  }

  pasteSteps(trackId, at) {
    if (!this.clipboard.length) throw new Error('clipboard empty');
    const arr = this._steps(trackId);
    reqInt(at, 0, arr.length - 1, 'at');
    this._mutate('pasteSteps', () => { applyStepRange(arr, this.clipboard, at); });
  }

  copyTrackToPattern(trackId, targetPatternId) {
    this._track(trackId);
    const srcPat = this._cur();
    const src = patternSteps(srcPat, trackId, srcPat.length);
    const dstPat = this._pattern(targetPatternId);
    const dst = patternSteps(dstPat, trackId, dstPat.length);
    const n = Math.min(src.length, dst.length);
    this._mutate('copyTrackToPattern', () => {
      for (let i = 0; i < n; i++) dst[i] = { ...makeStep(), ...src[i] };
    });
  }

  setMixer(trackId, patch = {}) {
    const t = this._track(trackId);
    const p = patch || {};
    if ('volume' in p) reqNum(p.volume, 0, 1.2, 'mixer.volume');
    if ('pan' in p) reqNum(p.pan, -1, 1, 'mixer.pan');
    if ('mute' in p && typeof p.mute !== 'boolean') throw new TypeError('mixer.mute: boolean');
    if ('solo' in p && typeof p.solo !== 'boolean') throw new TypeError('mixer.solo: boolean');
    this._mutate('setMixer', () => {
      for (const k of ['volume', 'pan', 'mute', 'solo']) if (k in p) t.mixer[k] = p[k];
    });
  }

  setFX(trackId, fxPatch = {}) {
    const t = this._track(trackId);
    const merged = {};
    for (const [unit, partial] of Object.entries(fxPatch || {})) {
      const spec = FX_SPEC[unit];
      if (!spec || !t.fx[unit]) throw new Error(`unknown fx unit ${unit}`);
      const u = { ...t.fx[unit], ...partial };
      if ('on' in u && typeof u.on !== 'boolean') throw new TypeError(`${unit}.on: boolean`);
      for (const [k, r] of Object.entries(spec)) {
        if (!(k in u)) continue;
        if (r.length === 3) reqInt(u[k], r[0], r[1], `${unit}.${k}`);
        else reqNum(u[k], r[0], r[1], `${unit}.${k}`);
      }
      for (const [k, vals] of Object.entries(FX_ENUMS[unit] || {})) {
        if (k in u && !vals.includes(u[k])) throw new Error(`${unit}.${k}: expected ${vals.join('|')}`);
      }
      merged[unit] = u;
    }
    this._mutate('setFX', () => {
      for (const [unit, u] of Object.entries(merged)) t.fx[unit] = u;
    });
  }

  setTrackParams(trackId, patch) {
    const t = this._track(trackId);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('patch: object required');
    if (t.type === 'drum' && 'piece' in patch && !DRUM_PIECES.includes(patch.piece)) {
      throw new Error(`params.piece: expected ${DRUM_PIECES.join('|')}`);
    }
    this._mutate('setTrackParams', () => { t.params = { ...t.params, ...clone(patch) }; });
  }

  setTrackLength(trackId, len) {
    const t = this._track(trackId);
    reqInt(len, 1, 64, 'track.length');
    this._mutate('setTrackLength', () => { t.length = len; });
  }

  setTrackName(trackId, name) {
    const t = this._track(trackId);
    if (typeof name !== 'string' || !name.trim()) throw new TypeError('name: non-empty string required');
    this._mutate('setTrackName', () => { t.name = name; });
  }

  addPattern() {
    const id = uid('p');
    this._mutate('addPattern', () => {
      this.project.patterns.push({
        id,
        name: this._nextPatternName(),
        length: this._cur().length,
        steps: {},
      });
    });
    return id;
  }

  _nextPatternName() {
    const used = new Set(this.project.patterns.map(p => p.name));
    for (let n = this.project.patterns.length; ; n++) {
      const cand = base26(n);
      if (!used.has(cand)) return cand;
    }
  }

  duplicatePattern(id) {
    const src = this._pattern(id);
    const nid = uid('p');
    this._mutate('duplicatePattern', () => {
      const copy = clone(src);
      copy.id = nid;
      copy.name = this._uniqueCopyName(src.name);
      this.project.patterns.splice(this.project.patterns.indexOf(src) + 1, 0, copy);
    });
    return nid;
  }

  _uniqueCopyName(base) {
    const used = new Set(this.project.patterns.map(p => p.name));
    if (!used.has(`${base} copy`)) return `${base} copy`;
    for (let n = 2; ; n++) if (!used.has(`${base} copy ${n}`)) return `${base} copy ${n}`;
  }

  deletePattern(id) {
    const idx = this.project.patterns.findIndex(p => p.id === id);
    if (idx < 0) throw new Error(`unknown pattern ${id}`);
    if (this.project.patterns.length <= 1) throw new Error('cannot delete the last pattern');
    this._mutate('deletePattern', () => {
      this.project.patterns.splice(idx, 1);
      this.project.song.chain = this.project.song.chain.filter(cid => cid !== id);
      if (this.currentPatternId === id) this.currentPatternId = this.project.patterns[0].id;
    });
  }

  selectPattern(id) {
    this._pattern(id);
    this.currentPatternId = id;
    this.emit('pattern', { id });
  }

  renamePattern(id, name) {
    const pat = this._pattern(id);
    if (typeof name !== 'string' || !name.trim()) throw new TypeError('name: non-empty string required');
    this._mutate('renamePattern', () => { pat.name = name; });
  }

  setSongChain(chain) {
    if (!Array.isArray(chain)) throw new TypeError('chain: string[] required');
    for (const c of chain) {
      if (typeof c !== 'string') throw new TypeError('chain: string[] required');
      if (!this.project.patterns.some(p => p.id === c)) throw new Error(`song.chain: unknown pattern id ${c}`);
    }
    this._mutate('setSongChain', () => { this.project.song.chain = [...chain]; });
  }

  setSongMode(mode) {
    if (mode !== 'pattern' && mode !== 'song') throw new Error("song.mode: expected 'pattern'|'song'");
    this._mutate('setSongMode', () => { this.project.song.mode = mode; });
  }

  setTransport(patch = {}) {
    const p = patch || {};
    if ('bpm' in p) reqNum(p.bpm, 20, 333, 'bpm');
    if ('swing' in p) reqNum(p.swing, 0, 0.6, 'swing');
    if ('seed' in p && !Number.isInteger(p.seed)) throw new RangeError('seed: integer required');
    if ('timeSig' in p) {
      const ts = p.timeSig;
      if (!ts || !Number.isInteger(ts.num) || ts.num < 2 || ts.num > 16) throw new RangeError('timeSig.num: expected 2..16');
      if (![2, 4, 8, 16].includes(ts.den)) throw new RangeError('timeSig.den: expected 2|4|8|16');
    }
    if ('metronome' in p) {
      const m = p.metronome || {};
      if ('enabled' in m && typeof m.enabled !== 'boolean') throw new TypeError('metronome.enabled: boolean');
      if ('division' in m) reqInt(m.division, 1, 16, 'metronome.division');
      if ('gain' in m) reqNum(m.gain, 0, 1, 'metronome.gain');
    }
    this._mutate('setTransport', () => {
      if ('bpm' in p) this.project.bpm = p.bpm;
      if ('swing' in p) this.project.swing = p.swing;
      if ('seed' in p) this.project.seed = p.seed;
      if ('timeSig' in p) this.project.timeSig = { num: p.timeSig.num, den: p.timeSig.den };
      if ('metronome' in p) this.project.metronome = { ...this.project.metronome, ...clone(p.metronome) };
    });
  }

  randomizeTrack(trackId, rng, opts = {}) {
    const { density = 0.4, velRange = [0.5, 1], probable = false } = opts;
    const t = this._track(trackId);
    reqNum(density, 0, 1, 'density');
    const [vlo, vhi] = velRange;
    reqNum(vlo, 0, 1, 'velRange[0]');
    reqNum(vhi, 0, 1, 'velRange[1]');
    if (vlo > vhi) throw new RangeError('velRange: min > max');
    const arr = this._steps(trackId);
    const len = Math.min(t.length, arr.length);
    this._mutate('randomizeTrack', () => {
      for (let i = 0; i < arr.length; i++) Object.assign(arr[i], makeStep());
      for (let i = 0; i < len; i++) {
        if (rng() >= density) continue;
        const vel = vlo + rng() * (vhi - vlo);
        const prob = probable ? 0.25 + 0.75 * rng() : 1;
        Object.assign(arr[i], { on: true, vel, prob, ratchet: 1, nudge: 0, note: null });
      }
    });
  }

  humanizeTrack(trackId, rng, opts = {}) {
    const { nudgeMs = 8, velSpread = 0.12 } = opts;
    reqNum(nudgeMs, 0, 40, 'nudgeMs');
    reqNum(velSpread, 0, 1, 'velSpread');
    const arr = this._steps(trackId);
    this._mutate('humanizeTrack', () => {
      for (const s of arr) {
        if (!s.on) continue;
        s.vel = Math.max(0, Math.min(1, s.vel + (rng() * 2 - 1) * velSpread));
        s.nudge = Math.max(-40, Math.min(40, Math.round(s.nudge + (rng() * 2 - 1) * nudgeMs)));
      }
    });
  }

  quantizeTrack(trackId, key, scaleName) {
    const arr = this._steps(trackId);
    let changed = 0;
    this._mutate('quantizeTrack', () => {
      changed = quantizeSteps(arr, key, scaleName);
    });
    return changed;
  }

  _doUndo() {
    const snap = this._undoStack.undo();
    if (snap == null) return false;
    this._restore(snap, 'undo');
    return true;
  }

  _doRedo() {
    const snap = this._undoStack.redo();
    if (snap == null) return false;
    this._restore(snap, 'redo');
    return true;
  }

  redo() { return this._doRedo(); }

  _restore(snapJson, reason) {
    this.project = JSON.parse(snapJson);
    if (!this.project.patterns.some(p => p.id === this.currentPatternId)) {
      this.currentPatternId = this.project.patterns[0].id;
    }
    this.emit('change', { reason });
  }
}
