// Piano-roll editor for the selected melodic track.
//
// Rows = pitches (descending) across a visible MIDI range (default 36..84),
// columns = steps of the current pattern. Visual language reuses .gp-cell
// tokens exactly as grid.css defines them: data-on="1" + inline --cell-fill
// for velocity, data-accent/data-lowprob/data-ratchet(+.rN)/data-nudge-dir
// overlays, .is-playing/.gp-col-active playhead states, .is-selected focus,
// .gp-beat-start/.gp-bar-start column grouping.
//
// SCALE CONTRACT (absolute): every mutation path routes pitches through
// scales.snapToScale before committing, so no interaction can produce an
// off-scale note. Off-scale rows render inert markers and reject placement;
// vertical drags snap each hover row to its nearest scale degree.
//
// The component never mutates the project itself: it calls
// handlers.onSetNote(trackId, stepIndex, midi|null, sourceLabel); the host
// applies the change and calls back updateCell(trackId, stepIndex).
import { patternSteps } from '../core/model.js';
import { NOTE_NAMES, scaleNotes, snapToScale } from '../core/scales.js';
import { clamp } from '../core/util.js';
const STYLE_ID = 'gp-pr-styles';
const DEFAULT_LOW = 36;
const DEFAULT_HIGH = 84;
const STYLE_TEXT = `
.gp-pr-scroll {
  overflow: auto;
  max-height: min(60vh, 520px);
  border: 1px solid var(--line);
  border-radius: var(--radius-2);
  background-color: var(--bg-sunken);
}
.gp-pr-grid { row-gap: 1px; }
.gp-pr-row { height: 16px; }
@media (pointer: coarse) { .gp-pr-row { height: 22px; } }
.gp-pr-row[data-black="1"] {
  background-color: color-mix(in srgb, var(--fg) 4%, transparent);
}
.gp-pr-label {
  flex: none;
  width: 44px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.04em;
  color: var(--fg-dim);
  text-align: right;
  padding-right: 6px;
  user-select: none;
}
.gp-pr-label[data-c="1"] { color: var(--fg); }
.gp-pr-cell {
  height: 100%;
  border-radius: 1px;
  cursor: pointer;
}
@media (pointer: coarse) { .gp-pr-cell { width: var(--cell-size-coarse); } }
.gp-pr-cell:focus:not(:focus-visible) { outline: none; }
.gp-pr-cell[data-offscale="1"] {
  border-color: color-mix(in srgb, var(--cell-off-border) 50%, transparent);
}
.gp-pr-cell[data-offscale="1"]::before {
  content: "";
  position: absolute;
  inset: 0;
  margin: auto;
  width: 2px;
  height: 2px;
  border-radius: 50%;
  background-color: var(--fg-dim);
  opacity: 0.35;
  pointer-events: none;
}
.gp-pr-cell[data-on="1"][data-offscale="1"]::before { display: none; }
.gp-pr-preview {
  outline: 2px solid var(--accent);
  outline-offset: 0;
}
`;
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = STYLE_TEXT;
  document.head.appendChild(el);
}
function midiLabel(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}
function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
export function createPianoRoll(container, handlers) {
  injectStyles();
  const h = {
    onSetNote: typeof handlers?.onSetNote === 'function' ? handlers.onSetNote : () => {},
    onSelect: typeof handlers?.onSelect === 'function' ? handlers.onSelect : () => {},
    onAnnounce: typeof handlers?.onAnnounce === 'function' ? handlers.onAnnounce : () => {}
  };
  const st = {
    project: null,
    patternId: null,
    pattern: null,
    track: null,
    steps: null,
    key: 0,
    scaleName: 'major',
    low: DEFAULT_LOW,
    high: DEFAULT_HIGH,
    focusStep: 0,
    focusMidi: 64,
    playheadStep: -1,
    drag: null,
    suppressClick: false
  };
  const root = document.createElement('div');
  root.className = 'gp-pr';
  const scroller = document.createElement('div');
  scroller.className = 'gp-pr-scroll';
  const grid = document.createElement('div');
  grid.className = 'gp-grid gp-pr-grid';
  grid.setAttribute('role', 'grid');
  grid.tabIndex = -1;
  scroller.appendChild(grid);
  root.appendChild(scroller);
  container.appendChild(root);
  let scaleArr = [];          // ascending MIDI notes of key/scale over 0..127
  let scaleSetPc = new Set(); // pitch classes of the scale relative to key 0
  const rowEls = new Map();   // midi -> row element
  const cells = new Map();    // `${step}:${midi}` -> cell element
  const ac = new AbortController();
  // ---------- geometry helpers ----------
  function rebuildScale() {
    scaleArr = scaleNotes(st.key, st.scaleName);
    scaleSetPc = new Set(scaleArr.map(n => n % 12));
  }
  function isScaleRow(midi) {
    return scaleSetPc.has(((midi % 12) + 12) % 12);
  }
  function nextDegree(midi, dir) {
    // Nearest scale pitch strictly above/below `midi`, clamped to visible range.
    if (dir > 0) {
      let lo = 0, hi = scaleArr.length - 1, found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (scaleArr[mid] > midi) { found = scaleArr[mid]; hi = mid - 1; } else { lo = mid + 1; }
      }
      return found !== -1 && found <= st.high ? found : -1;
    }
    let lo = 0, hi = scaleArr.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (scaleArr[mid] < midi) { found = scaleArr[mid]; lo = mid + 1; } else { hi = mid - 1; }
    }
    return found !== -1 && found >= st.low ? found : -1;
  }
  function trackColorVar(slot) {
    const n = clampInt(slot || 7, 1, 8);
    return `var(--track-${n})`;
  }
  // ---------- painting ----------
  function paintCell(cell, stepIndex) {
    const s = st.steps ? st.steps[stepIndex] : null;
    const pitch = Number(cell.dataset.pitch);
    const hasNote = !!(s && s.on && s.note != null && s.note === pitch);
    cell.dataset.step = String(stepIndex);
    if (!hasNote) {
      delete cell.dataset.on;
      delete cell.dataset.accent;
      delete cell.dataset.lowprob;
      delete cell.dataset.nudgeDir;
      cell.removeAttribute('data-ratchet');
      cell.classList.remove('r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8');
      cell.style.removeProperty('--cell-fill');
      cell.removeAttribute('aria-selected');
      cell.classList.toggle('is-selected', st.focusStep === stepIndex && Number(cell.dataset.pitch) === st.focusMidi);
      return;
    }
    cell.dataset.on = '1';
    const vel = Math.min(1, Math.max(0, s.vel != null ? s.vel : 0.8));
    cell.style.setProperty('--cell-fill',
      `color-mix(in srgb, var(--track-c) ${Math.round(30 + 70 * vel)}%, var(--bg-sunken))`);
    if (vel >= 0.75) cell.dataset.accent = '1'; else delete cell.dataset.accent;
    if ((s.prob != null ? s.prob : 1) < 1) cell.dataset.lowprob = '1'; else delete cell.dataset.lowprob;
    if ((s.nudge || 0) < 0) cell.dataset.nudgeDir = '-1';
    else if ((s.nudge || 0) > 0) cell.dataset.nudgeDir = '1';
    else delete cell.dataset.nudgeDir;
    const rat = clampInt(s.ratchet || 1, 1, 8);
    cell.classList.remove('r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8');
    if (rat > 1) {
      cell.setAttribute('data-ratchet', '');
      cell.classList.add('r' + rat);
    } else {
      cell.removeAttribute('data-ratchet');
    }
  }
  function refreshFocusClasses() {
    for (const cell of cells.values()) {
      const sel = Number(cell.dataset.step) === st.focusStep &&
                  Number(cell.dataset.pitch) === st.focusMidi;
      cell.classList.toggle('is-selected', sel);
      if (sel) cell.setAttribute('aria-selected', 'true');
      else cell.removeAttribute('aria-selected');
      cell.tabIndex = sel ? 0 : -1;
    }
  }
  function setFocus(step, midi, opts = {}) {
    st.focusStep = clampInt(step, 0, Math.max(0, st.pattern ? st.pattern.length - 1 : 0));
    st.focusMidi = clampInt(midi, st.low, st.high);
    refreshFocusClasses();
    const cell = cells.get(`${st.focusStep}:${st.focusMidi}`);
    if (cell) {
      if (opts.focusElement !== false) {
        try { cell.focus({ preventScroll: true }); } catch { cell.focus(); }
      }
      try { cell.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* jsdom */ }
    }
    h.onSelect(st.track ? st.track.id : null, st.focusStep);
  }
  // ---------- build ----------
  function buildGrid() {
    grid.textContent = '';
    grid.setAttribute('aria-label',
      `Piano roll${st.track ? ': ' + st.track.name : ''}, key ${NOTE_NAMES[st.key % 12]} ${st.scaleName}`);
    rowEls.clear();
    cells.clear();
    const len = st.pattern ? st.pattern.length : 0;
    for (let midi = st.high; midi >= st.low; midi--) {
      const row = document.createElement('div');
      row.className = 'gp-row gp-pr-row';
      row.setAttribute('role', 'row');
      row.dataset.pitch = String(midi);
      if (((midi % 12) + 12) % 12 !== 0 && [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12)) {
        row.dataset.black = '1';
      }
      const label = document.createElement('div');
      label.className = 'gp-pr-label';
      label.setAttribute('role', 'rowheader');
      if (midi % 12 === 0) {
        label.dataset.c = '1';
        label.textContent = midiLabel(midi);
      }
      row.appendChild(label);
      for (let step = 0; step < len; step++) {
        const cell = document.createElement('div');
        cell.className = 'gp-cell gp-pr-cell';
        cell.setAttribute('role', 'gridcell');
        cell.tabIndex = -1;
        cell.dataset.pitch = String(midi);
        if (step % 4 === 0) cell.classList.add('gp-beat-start');
        if (step % 16 === 0) cell.classList.add('gp-bar-start');
        if (!isScaleRow(midi)) cell.dataset.offscale = '1';
        paintCell(cell, step);
        row.appendChild(cell);
        cells.set(`${step}:${midi}`, cell);
      }
      grid.appendChild(row);
      rowEls.set(midi, row);
    }
    refreshFocusClasses();
  }
  // ---------- public API ----------
  function render(project, patternId, trackId, key, scaleName) {
    st.project = project || null;
    st.patternId = patternId;
    st.pattern = project && Array.isArray(project.patterns)
      ? project.patterns.find(p => p.id === patternId) || null
      : null;
    st.track = project && Array.isArray(project.tracks)
      ? project.tracks.find(t => t.id === trackId) || null
      : null;
    st.key = ((Math.round(Number(key)) || 0) % 12 + 12) % 12;
    st.scaleName = String(scaleName || 'major');
    st.steps = st.pattern && st.track
      ? patternSteps(st.pattern, trackId, st.pattern.length)
      : null;
    root.style.setProperty('--track-c', trackColorVar(st.track?.colorSlot));
    clearPlayhead();
    rebuildScale();
    buildGrid();
    // Park focus near C4 on the first scale degree at or below it.
    let startMidi = Math.min(60, st.high);
    while (!isScaleRow(startMidi) && startMidi > st.low) startMidi--;
    st.focusStep = 0;
    st.focusMidi = clampInt(startMidi, st.low, st.high);
    refreshFocusClasses();
  }
  function updateCell(trackId, stepIndex) {
    if (!st.steps || !st.track || st.track.id !== trackId) return;
    const len = st.pattern ? st.pattern.length : 0;
    const idx = clampInt(stepIndex, 0, len - 1);
    if (Number.isInteger(stepIndex) && (stepIndex < 0 || stepIndex >= len)) return;
    for (let midi = st.high; midi >= st.low; midi--) {
      const cell = cells.get(`${idx}:${midi}`);
      if (cell) paintCell(cell, idx);
    }
  }
  function setVisibleRange(lowMidi, highMidi) {
    let lo = clampInt(lowMidi, 0, 127);
    let hi = clampInt(highMidi, 0, 127);
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    st.low = lo;
    st.high = hi;
    if (st.project) {
      rebuildScale();
      buildGrid();
      st.focusMidi = clampInt(st.focusMidi, lo, hi);
      refreshFocusClasses();
    }
  }
  function clearPlayhead() {
    if (st.playheadStep < 0) return;
    for (let midi = st.high; midi >= st.low; midi--) {
      const cell = cells.get(`${st.playheadStep}:${midi}`);
      if (cell) cell.classList.remove('is-playing', 'gp-col-active');
    }
    st.playheadStep = -1;
  }
  function setPlayhead(stepIndexOrNull) {
    clearPlayhead();
    if (stepIndexOrNull == null || !st.pattern) return;
    const idx = clampInt(stepIndexOrNull, 0, st.pattern.length - 1);
    st.playheadStep = idx;
    for (let midi = st.high; midi >= st.low; midi--) {
      const cell = cells.get(`${idx}:${midi}`);
      if (cell) {
        cell.classList.add('gp-col-active');
        if (cell.dataset.on === '1') cell.classList.add('is-playing');
      }
    }
  }
  function dispose() {
    ac.abort();
    endDrag(false);
    root.remove();
    rowEls.clear();
    cells.clear();
    st.project = null;
    st.pattern = null;
    st.track = null;
    st.steps = null;
  }
  // ---------- interactions ----------
  function announce(text) {
    h.onAnnounce(text);
  }
  function commitSet(stepIndex, midi, sourceLabel, verb) {
    if (!st.track) return;
    h.onSetNote(st.track.id, stepIndex, midi, sourceLabel);
    announce(`${st.track.name} step ${stepIndex + 1} ${verb} ${midiLabel(midi)}`);
  }
  function commitClear(stepIndex, sourceLabel) {
    if (!st.track) return;
    h.onSetNote(st.track.id, stepIndex, null, sourceLabel);
    announce(`${st.track.name} step ${stepIndex + 1} removed`);
  }
  function noteAt(stepIndex) {
    const s = st.steps ? st.steps[stepIndex] : null;
    return s && s.on && s.note != null ? s.note : null;
  }
  function toggleAt(stepIndex, rowMidi, sourceLabel) {
    // Same cell as the live note -> remove. Any other row -> place/move,
    // always snapped: the committed pitch can never leave the scale.
    const cur = noteAt(stepIndex);
    if (cur != null && cur === rowMidi) {
      commitClear(stepIndex, sourceLabel);
      return;
    }
    const target = snapToScale(clampInt(rowMidi, 0, 127), st.key, st.scaleName);
    commitSet(stepIndex, target, sourceLabel, cur != null ? 'moved to' : 'set to');
  }
  // Vertical drag: preview moves through scale degrees only; single commit.
  function beginDrag(e) {
    const cell = e.target.closest('.gp-pr-cell');
    if (!cell || !grid.contains(cell)) return false;
    const stepIndex = Number(cell.dataset.step);
    const midi = noteAt(stepIndex);
    if (midi == null) return false;
    try { cell.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    st.drag = { pointerId: e.pointerId, stepIndex, from: midi, cur: midi, moved: false, previewCell: null };
    return true;
  }
  function dragPreview(pitch) {
    const d = st.drag;
    if (!d) return;
    const target = snapToScale(clampInt(pitch, 0, 127), st.key, st.scaleName);
    if (target === d.cur) return;
    if (d.previewCell) d.previewCell.classList.remove('gp-pr-preview');
    d.cur = target;
    const pc = cells.get(`${d.stepIndex}:${target}`);
    if (pc) {
      pc.classList.add('gp-pr-preview');
      d.previewCell = pc;
    }
    d.moved = true;
  }
  function endDrag(commit) {
    const d = st.drag;
    if (!d) return;
    if (d.previewCell) d.previewCell.classList.remove('gp-pr-preview');
    st.drag = null;
    if (commit && d.moved && d.cur !== d.from) {
      st.suppressClick = true;
      commitSet(d.stepIndex, d.cur, 'pianoroll:drag', 'moved to');
    }
  }
  function shiftOctave(dir) {
    const midi = noteAt(st.focusStep);
    if (midi == null) return;
    const next = snapToScale(clampInt(midi + dir * 12, 0, 127), st.key, st.scaleName);
    if (next === midi) {
      announce(`${st.track.name} step ${st.focusStep + 1}: no scale note ${dir > 0 ? 'above' : 'below'} in range`);
      return;
    }
    commitSet(st.focusStep, next, 'pianoroll:kbd-octave', dir > 0 ? 'octave up to' : 'octave down to');
  }
  grid.addEventListener('click', (e) => {
    if (st.suppressClick) { st.suppressClick = false; return; }
    const cell = e.target.closest('.gp-pr-cell');
    if (!cell || !grid.contains(cell)) return;
    const stepIndex = Number(cell.dataset.step);
    setFocus(stepIndex, Number(cell.dataset.pitch));
    toggleAt(stepIndex, Number(cell.dataset.pitch), 'pianoroll:click');
  }, { signal: ac.signal });
  grid.addEventListener('contextmenu', (e) => {
    const cell = e.target.closest('.gp-pr-cell');
    if (!cell || !grid.contains(cell)) return;
    e.preventDefault();
    const stepIndex = Number(cell.dataset.step);
    setFocus(stepIndex, Number(cell.dataset.pitch));
    if (noteAt(stepIndex) != null) commitClear(stepIndex, 'pianoroll:rightclick');
  }, { signal: ac.signal });
  grid.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    beginDrag(e);
  }, { signal: ac.signal });
  grid.addEventListener('pointermove', (e) => {
    if (!st.drag || e.pointerId !== st.drag.pointerId) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el && el.closest ? el.closest('.gp-pr-cell') : null;
    if (!cell || !grid.contains(cell)) return;
    if (Number(cell.dataset.step) !== st.drag.stepIndex) return; // horizontal moves ignored
    dragPreview(Number(cell.dataset.pitch));
  }, { signal: ac.signal });
  const finishDrag = (commit) => (e) => {
    if (!st.drag || e.pointerId !== st.drag.pointerId) return;
    try { e.target.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    endDrag(commit);
  };
  grid.addEventListener('pointerup', finishDrag(true), { signal: ac.signal });
  grid.addEventListener('pointercancel', finishDrag(false), { signal: ac.signal });
  grid.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const len = st.pattern ? st.pattern.length : 0;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft':
        if (st.focusStep > 0) setFocus(st.focusStep - 1, st.focusMidi);
        break;
      case 'ArrowRight':
        if (st.focusStep < len - 1) setFocus(st.focusStep + 1, st.focusMidi);
        break;
      case 'ArrowUp': {
        const up = nextDegree(st.focusMidi, 1);
        if (up !== -1) setFocus(st.focusStep, up);
        break;
      }
      case 'ArrowDown': {
        const down = nextDegree(st.focusMidi, -1);
        if (down !== -1) setFocus(st.focusStep, down);
        break;
      }
      case 'Enter':
        toggleAt(st.focusStep, st.focusMidi, 'pianoroll:key');
        break;
      case '+': case '=':
        shiftOctave(1);
        break;
      case '-': case '_':
        shiftOctave(-1);
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }, { signal: ac.signal });
  return {
    render,
    updateCell,
    setVisibleRange,
    setPlayhead,
    dispose
  };
}
