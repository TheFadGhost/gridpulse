import { makeBeatMap, swingDelaySeconds, STEP_BEATS } from '../core/musictime.js';
import { cycleLength } from '../core/model.js';
import { seededFor } from '../core/rng.js';

export class Scheduler {
  constructor({ getNow, getView, onEvent, lookahead = 0.18 }) {
    this.getNow = getNow;
    this.getView = getView;
    this.onEvent = onEvent;
    this.lookahead = lookahead;
    this.playing = false;
    this.cursorStep = 0;
    this.anchors = null;
    this.map = null;
    this.pendingBpm = null;
    this._rngCache = new Map();
  }

  start(atTime) {
    const v = this.getView();
    if (!(v.bpm > 0)) throw new Error('scheduler.start: view.bpm must be > 0');
    this.anchors = [{ beat: 0, time: atTime, bpm: v.bpm }];
    this.map = makeBeatMap(this.anchors);
    this.cursorStep = 0;
    this._rngCache.clear();
    this.playing = true;
  }

  stop() {
    this.playing = false;
    this.pendingBpm = null;
  }

  requestTempo(bpm) {
    if (!(bpm > 0)) return;
    this.pendingBpm = bpm;
  }

  _applyPendingTempo() {
    if (this.pendingBpm == null) return;
    const boundaryBeat = this.cursorStep * STEP_BEATS;
    const t = this.map.beatToSec(boundaryBeat);
    this.anchors.push({ beat: boundaryBeat, time: t, bpm: this.pendingBpm });
    this.map = makeBeatMap(this.anchors);
    this.pendingBpm = null;
  }

  stepBaseTime(step) {
    return this.map.beatToSec(step * STEP_BEATS);
  }

  tick() {
    if (!this.playing) return;
    this._applyPendingTempo();
    const now = this.getNow();
    const horizon = now + this.lookahead;
    let guard = 0;
    while (guard++ < 100000) {
      const t0 = this.stepBaseTime(this.cursorStep);
      if (!Number.isFinite(t0)) { this.playing = false; throw new Error('scheduler: non-finite event time'); }
      if (t0 > horizon) break;
      this._emitStep(this.cursorStep, t0);
      this.cursorStep++;
      if (!this.playing) break;
    }
  }

  _rngFor(patternId, cycle, seed) {
    const key = patternId + ':' + cycle;
    let r = this._rngCache.get(key);
    if (!r) { r = seededFor(seed ^ 0x9e3779b9, 'prob:' + key); this._rngCache.set(key, r); }
    return r;
  }

  _emitStep(s, t0) {
    const v = this.getView();
    const cyc = cycleLength(v.tracks.map(t => t.length));
    const cycleIdx = Math.floor(s / Math.max(1, cyc));
    const chainLen = (v.chain && v.chain.length) || 1;
    const patternId = v.songMode ? v.chain[cycleIdx % chainLen] : v.patternId;
    const pattern = v.patterns[patternId];
    if (!pattern) return;

    if (v.metronome && v.metronome.enabled && s % Math.max(1, v.metronome.division) === 0) {
      const accent = s % (v.stepsPerBeat * v.beatsPerBar) === 0;
      this.onEvent({
        trackId: '__metro__', patternId, stepIndex: s, note: accent ? 1 : 0,
        velocity: v.metronome.gain * (accent ? 1 : 0.6),
        ratchet: 1, nudgeMs: 0, time: t0
      });
    }

    const bpmNow = this.anchors[this.anchors.length - 1].bpm;
    for (const tr of v.tracks) {
      const L = Math.max(1, Math.min(tr.length, pattern.length));
      const li = ((s % L) + L) % L;
      const st = pattern.steps[tr.id] ? pattern.steps[tr.id][li] : null;
      if (!st || !st.on) continue;
      const swing = swingDelaySeconds(s, bpmNow, v.swing);
      const base = t0 + swing + (st.nudge || 0) / 1000;
      if (st.prob < 1) {
        const rng = this._rngFor(patternId, cycleIdx, v.seed);
        if (rng() > st.prob) continue;
      }
      const reps = Math.max(1, st.ratchet | 0);
      const nextT = this.stepBaseTime(s + 1);
      const span = Math.max(0.001, nextT - t0);
      for (let r = 0; r < reps; r++) {
        this.onEvent({
          trackId: tr.id, patternId, stepIndex: s,
          note: (tr.type !== 'drum' && typeof st.note === 'number') ? st.note : null,
          velocity: st.vel, ratchet: reps, nudgeMs: st.nudge || 0,
          repeat: r,
          time: base + r * (span / reps)
        });
      }
    }
  }

  playheadBeat(now, compensation = 0) {
    if (!this.playing) return null;
    return this.map.secToBeat(Math.max(this.anchors[0].time, now - compensation));
  }
}
