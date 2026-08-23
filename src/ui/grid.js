// Step sequencer grid. Rows = tracks, columns = 16th steps.
//
// DOM contract (styles/grid.css is authoritative — selectors matched exactly):
//   .gp-grid[role=grid] > .gp-row[role=row][data-track="1..8"]
//     > .gp-trackhead[role=rowheader] (name + M/S buttons, aria-pressed)
//     > .gp-cell[role=gridcell] with data-on / data-accent / data-lowprob /
//       data-ratchet(+.r2..r8) / data-nudge-dir(-1|1) / data-nudge-ms,
//       inline --cell-fill = color-mix(in srgb, var(--track-c) X%, transparent)
//       where X maps velocity 0->35%, 1->100%, plus .gp-beat-start (i%4==0),
//       .gp-bar-start (i%16==0), .is-playing / .gp-col-active / .is-selected.
//   .gp-playhead absolute 2px line, moved via transform translateX only.
//
// The component NEVER mutates project data: it renders the state it is given
// and emits intents through `handlers`. The host applies them and calls back
// updateCell/updateTrack/setLengths.
//
// Reduced motion: CSS hides .gp-playhead; setPlayheadBeat then drives the
// discrete column highlight (.gp-col-active + .is-playing via setActiveStep).
const STYLE_ID = 'gp-grid-styles';

const VEL_PRESETS = [0.4, 0.7, 1];
const PROB_PRESETS = [1, 0.5, 0.25]; // high -> low; '{' goes down, '}' up
const RAT_PRESETS = [1, 2, 3, 4];
const NUDGE_DELTA = 10;

const DEF_STEP = { on: false, vel: 0.8, prob: 1, ratchet: 1, nudge: 0 };
const RATCHET_CLASSES = ['r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'];

const STYLE_TEXT = `
.gp-grid { user-select: none; -webkit-user-select: none; }
.gp-grid .gp-cell { cursor: pointer; }
.gp-grid .gp-cell[data-ph="1"] { cursor: default; opacity: 0.3; }
.gp-grid .gp-cell:focus { outline: none; }
.gp-cap {
  position: absolute;
  top: -3px;
  bottom: -3px;
  right: -6px;
  width: 2px;
  border-radius: 1px;
  background-color: var(--track-c);
  pointer-events: none;
  z-index: 1;
}
.gp-trackhead { gap: var(--sp-1); }
.gp-headname {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-ui);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--fg);
}
.gp-msbtn {
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: var(--radius-1);
  font-family: var(--font-ui);
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
}
`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = STYLE_TEXT;
  document.head.appendChild(el);
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function near(a, b) { return Math.abs(a - b) < 1e-6; }

// Next entry of a preset cycle relative to the current value.
function cycleNext(list, cur, dir = 1) {
  const idx = list.findIndex((v) => near(v, cur));
  if (idx === -1) return dir > 0 ? list[0] : list[list.length - 1];
  return list[(idx + dir + list.length) % list.length];
}

export function createStepGrid(container, handlers = {}) {
  injectStyles();

  const h = {};
  for (const k of ['onToggle', 'onStepParam', 'onCopy', 'onPaste', 'onSelect',
    'onTrackMute', 'onTrackSolo', 'onAnnounce']) {
    h[k] = typeof handlers[k] === 'function' ? handlers[k] : () => {};
  }

  const ac = new AbortController();
  const sig = { signal: ac.signal };

  // ---- state -------------------------------------------------------------
  let project = null;
  let pattern = null;
  let cols = 0;                       // total columns == pattern.length
  let spb = 4;                        // steps (16ths) per beat
  const refs = new Map();             // trackId -> row record
  let order = [];                     // trackIds in display order
  let roving = null;                  // { tid, i } — the one tabbable cell
  let activeCol = -1;                 // column carrying play-state classes
  let lastBeat = null;                // last beatFloat given to setPlayheadBeat
  let xs = [];                        // cached cell offsetLeft per column
  let cellW = 28;
  let cacheDirty = true;
  let drag = null;                    // pointer paint state
  let suppressClick = false;

  const reducedMQ = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false, addEventListener() {} };

  // ---- DOM skeleton ------------------------------------------------------
  const grid = document.createElement('div');
  grid.className = 'gp-grid';
  grid.setAttribute('role', 'grid');
  grid.setAttribute('aria-label', 'Step sequencer grid');
  container.appendChild(grid);

  const playhead = document.createElement('div');
  playhead.className = 'gp-playhead';
  playhead.style.display = 'none';

  let resizeObs = null;
  if (typeof ResizeObserver === 'function') {
    resizeObs = new ResizeObserver(() => { cacheDirty = true; });
    resizeObs.observe(grid);
  }

  // ---- read-only project mirroring ----------------------------------------
  function stepAt(tid, i) {
    const arr = pattern && pattern.steps ? pattern.steps[tid] : null;
    const s = arr ? arr[i] : null;
    return s && typeof s === 'object' ? s : DEF_STEP;
  }

  function trackRef(tid) { return refs.get(tid) || null; }

  function activeLenOf(tid) {
    const R = refs.get(tid);
    return R ? R.activeLen : cols;
  }

  // ---- painting ------------------------------------------------------------
  function clearDynamic(cell) {
    delete cell.dataset.on;
    delete cell.dataset.accent;
    delete cell.dataset.lowprob;
    delete cell.dataset.nudgeDir;
    delete cell.dataset.nudgeMs;
    cell.removeAttribute('data-ratchet');
    cell.classList.remove(...RATCHET_CLASSES);
    cell.style.removeProperty('--cell-fill');
  }

  function paintCell(cell, tid, i) {
    const R = refs.get(tid);
    if (!R || !cell) return;
    const name = R.track.name;
    const ph = i >= R.activeLen;
    clearDynamic(cell);

    if (ph) {
      cell.setAttribute('data-ph', '1');
      cell.setAttribute('aria-disabled', 'true');
      cell.setAttribute('aria-label', `${name}, step ${i + 1}: off, beyond track length`);
      return;
    }
    cell.removeAttribute('data-ph');
    cell.removeAttribute('aria-disabled');

    const s = stepAt(tid, i);
    const vel = clamp01(s.vel != null ? s.vel : DEF_STEP.vel);
    const prob = clamp01(s.prob != null ? s.prob : DEF_STEP.prob);
    const rat = clampInt(s.ratchet != null ? s.ratchet : 1, 1, 8);
    const nudge = Math.round(Number(s.nudge) || 0);

    let label = `${name}, step ${i + 1}: ${s.on ? 'on' : 'off'}`;
    if (s.on) {
      cell.dataset.on = '1';
      const pct = Math.round(35 + 65 * vel);          // 0 -> 35%, 1 -> 100%
      cell.style.setProperty('--cell-fill',
        `color-mix(in srgb, var(--track-c) ${pct}%, transparent)`);
      if (vel >= 0.75) cell.dataset.accent = '1';
      if (prob < 1) cell.dataset.lowprob = '1';
      if (nudge < 0) cell.dataset.nudgeDir = '-1';
      else if (nudge > 0) cell.dataset.nudgeDir = '1';
      if (nudge !== 0) cell.dataset.nudgeMs = String(nudge);
      if (rat > 1) {
        cell.setAttribute('data-ratchet', '');
        cell.classList.add(`r${rat}`);
      }
      label += `, velocity ${Math.round(vel * 100)} percent`;
      label += `, probability ${Math.round(prob * 100)} percent`;
      if (rat > 1) label += `, ratchet ${rat}`;
      if (nudge !== 0) label += `, nudged ${nudge < 0 ? 'minus' : 'plus'} ${Math.abs(nudge)} ms`;
    }
    cell.setAttribute('aria-label', label);
  }

  function paintRow(tid) {
    const R = refs.get(tid);
    if (!R) return;
    for (let i = 0; i < cols; i++) paintCell(R.cells[i], tid, i);
    R.muteBtn.setAttribute('aria-pressed', R.track.mixer.mute ? 'true' : 'false');
    R.soloBtn.setAttribute('aria-pressed', R.track.mixer.solo ? 'true' : 'false');
  }

  // ---- focus (roving tabindex) ---------------------------------------------
  function applyRoving(emit) {
    for (const R of refs.values()) {
      for (const c of R.cells) {
        c.tabIndex = -1;
        c.classList.remove('is-selected');
        c.removeAttribute('aria-selected');
      }
    }
    if (!roving) return;
    const R = refs.get(roving.tid);
    if (!R) { roving = null; return; }
    const i = clampInt(roving.i, 0, R.activeLen - 1);
    roving.i = i;
    const cell = R.cells[i];
    cell.tabIndex = 0;
    cell.classList.add('is-selected');
    cell.setAttribute('aria-selected', 'true');
    if (emit) h.onSelect(roving.tid, i);
  }

  function focusCell(tid, i, opts = {}) {
    const R = refs.get(tid);
    if (!R) return;
    const emit = opts.emit !== false;
    roving = { tid, i: clampInt(i, 0, R.activeLen - 1) };
    applyRoving(emit);
    const cell = R.cells[roving.i];
    if (cell && opts.domFocus !== false) {
      try { cell.focus({ preventScroll: true }); } catch { cell.focus(); }
      try { cell.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* jsdom */ }
    }
  }

  function moveFocus(dRow, dCol) {
    if (!roving || !order.length) return;
    const ti = order.indexOf(roving.tid);
    let tid = roving.tid;
    let i = roving.i;
    if (dCol !== 0) {
      const L = activeLenOf(tid);
      i = ((i + dCol) % L + L) % L;                 // wrap within track length
    }
    if (dRow !== 0) {
      const nt = ((ti + dRow) % order.length + order.length) % order.length;
      tid = order[nt];
      i = Math.min(i, activeLenOf(tid) - 1);        // stay inside target length
    }
    focusCell(tid, i, { emit: true });
  }

  // ---- intent helpers -------------------------------------------------------
  function announce(text) { h.onAnnounce(text); }

  function emitToggle(tid, i) {
    h.onToggle(tid, i);
    announce(`${refs.get(tid).track.name} step ${i + 1} toggled`);
  }

  function emitParam(tid, i, param, v) {
    h.onStepParam(tid, i, param, v);
    const name = refs.get(tid).track.name;
    if (param === 'vel') announce(`${name} step ${i + 1} velocity ${Math.round(clamp01(v) * 100)} percent`);
    else if (param === 'prob') announce(`${name} step ${i + 1} probability ${Math.round(clamp01(v) * 100)} percent`);
    else if (param === 'ratchet') announce(`${name} step ${i + 1} ratchet ${clampInt(v, 1, 8)}`);
    else if (param === 'nudge') announce(`${name} step ${i + 1} nudge ${v > 0 ? 'plus' : 'minus'} ${Math.abs(v)} ms`);
    else announce(`${name} step ${i + 1} ${param}`);
  }

  function modParamFromEvent(e, tid, i) {
    if (e.shiftKey) return ['vel', cycleNext(VEL_PRESETS, clamp01(stepAt(tid, i).vel))];
    if (e.altKey) return ['prob', cycleNext(PROB_PRESETS, clamp01(stepAt(tid, i).prob))];
    if (e.ctrlKey || e.metaKey) return ['ratchet', cycleNext(RAT_PRESETS, clampInt(stepAt(tid, i).ratchet || 1, 1, 8))];
    return null;
  }

  // ---- build -----------------------------------------------------------------
  function buildAll() {
    grid.textContent = '';
    refs.clear();
    order = [];

    if (!pattern) {
      grid.appendChild(playhead);
      roving = null;
      activeCol = -1;
      hideLine();
      return;
    }

    grid.setAttribute('aria-label', 'Step sequencer grid');
    project.tracks.forEach((track, tIdx) => {
      const slot = clampInt(track.colorSlot || tIdx + 1, 1, 8);
      const row = document.createElement('div');
      row.className = 'gp-row';
      row.setAttribute('role', 'row');
      row.dataset.track = String(slot);

      const head = document.createElement('div');
      head.className = 'gp-trackhead';
      head.setAttribute('role', 'rowheader');

      const nameEl = document.createElement('span');
      nameEl.className = 'gp-headname';
      nameEl.textContent = String(track.name ?? '');

      const muteBtn = document.createElement('button');
      muteBtn.type = 'button';
      muteBtn.className = 'gp-btn gp-msbtn';
      muteBtn.textContent = 'M';
      muteBtn.setAttribute('aria-pressed', track.mixer.mute ? 'true' : 'false');
      muteBtn.setAttribute('aria-label', `Mute ${track.name}`);

      const soloBtn = document.createElement('button');
      soloBtn.type = 'button';
      soloBtn.className = 'gp-btn gp-msbtn';
      soloBtn.textContent = 'S';
      soloBtn.setAttribute('aria-pressed', track.mixer.solo ? 'true' : 'false');
      soloBtn.setAttribute('aria-label', `Solo ${track.name}`);

      head.append(nameEl, muteBtn, soloBtn);
      row.appendChild(head);

      const cells = new Array(cols);
      for (let i = 0; i < cols; i++) {
        const cell = document.createElement('div');
        cell.className = 'gp-cell';
        cell.setAttribute('role', 'gridcell');
        cell.tabIndex = -1;
        cell.dataset.tid = track.id;
        cell.dataset.i = String(i);
        if (i % 4 === 0) cell.classList.add('gp-beat-start');
        if (i % 16 === 0) cell.classList.add('gp-bar-start');
        cells[i] = cell;
        row.appendChild(cell);
      }

      grid.appendChild(row);
      order.push(track.id);
      refs.set(track.id, {
        track,
        row,
        cells,
        nameEl,
        muteBtn,
        soloBtn,
        cap: null,
        activeLen: clampInt(track.length || cols, 1, cols)
      });

      muteBtn.addEventListener('click', () => {
        h.onTrackMute(track.id);
        announce(`${track.name} mute`);
      }, sig);
      soloBtn.addEventListener('click', () => {
        h.onTrackSolo(track.id);
        announce(`${track.name} solo`);
      }, sig);
    });

    grid.appendChild(playhead);

    // Lengths/placeholders from the tracks as rendered.
    const map = new Map();
    for (const t of project.tracks) map.set(t.id, t.length);
    applyMap(map);

    cacheDirty = true;

    const first = order.length ? order[0] : null;
    roving = first ? { tid: first, i: 0 } : null;
    applyRoving(false);
    activeCol = -1;
    hideLine();
  }

  // ---- lengths & placeholders -------------------------------------------------
  // Per-track pass: end-cap after the track's last active column, dimmed
  // placeholder columns beyond it. Total columns never change here, so no
  // layout shift occurs.
  function applyMap(map) {
    for (const [tid, R] of refs) {
      const raw = map instanceof Map && map.has(tid) ? map.get(tid) : R.activeLen;
      R.activeLen = Math.min(cols, Math.max(1, clampInt(raw, 1, cols)));
      for (let i = 0; i < cols; i++) paintCell(R.cells[i], tid, i);
      if (R.cap && R.cap.parentNode) R.cap.remove();
      const cap = document.createElement('i');
      cap.className = 'gp-cap';
      cap.setAttribute('aria-hidden', 'true');
      R.cells[R.activeLen - 1].appendChild(cap);
      R.cap = cap;
    }
    if (roving) {
      const R = refs.get(roving.tid);
      if (!R) roving = null;
      else if (roving.i > R.activeLen - 1) roving.i = R.activeLen - 1;
    }
    if (activeCol >= cols) applyActive(null);
    else if (activeCol >= 0) {
      const keep = activeCol;
      applyActive(null);
      applyActive(keep);
    }
    cacheDirty = true;
  }

  function applyLengths(map, patternLength) {
    if (!pattern) return;
    const pl = clampInt(patternLength, 1, 64);
    if (pl !== cols) {                    // defensive: total column count changed
      cols = pl;                          // -> full rebuild, caller's map wins
      buildAll();
    }
    applyMap(map);
  }

  // ---- playhead ---------------------------------------------------------------
  function ensureXs() {
    if (!cacheDirty && xs.length === cols && cols > 0) return xs.length > 0;
    const first = order.length ? refs.get(order[0]) : null;
    if (!first || !first.cells.length) { xs = []; return false; }
    xs = first.cells.map((c) => c.offsetLeft);
    cellW = first.cells[0].offsetWidth || 28;
    cacheDirty = false;
    return xs.length > 0;
  }

  function hideLine() {
    playhead.style.display = 'none';
  }

  function showLine(px) {
    playhead.style.display = 'block';
    playhead.style.transform = `translateX(${px}px)`;
  }

  function applyActive(idxOrNull) {
    if (activeCol >= 0) {
      for (const R of refs.values()) {
        const c = R.cells[activeCol];
        if (c) c.classList.remove('is-playing', 'gp-col-active');
      }
    }
    activeCol = -1;
    if (idxOrNull == null || !Number.isFinite(idxOrNull)) return;
    const idx = clampInt(idxOrNull, 0, Math.max(0, cols - 1));
    for (const R of refs.values()) {
      const c = R.cells[idx];
      if (c) c.classList.add('is-playing', 'gp-col-active');
    }
    activeCol = idx;
  }

  // ---- pointer interactions ------------------------------------------------------
  function cellFromElement(el) {
    const cell = el && el.closest ? el.closest('.gp-cell') : null;
    if (!cell || !grid.contains(cell)) return null;
    const tid = cell.dataset.tid;
    const R = refs.get(tid);
    if (!R) return null;
    const i = Number(cell.dataset.i);
    if (!Number.isInteger(i) || i < 0 || i >= cols) return null;
    return { cell, tid, i, ph: i >= R.activeLen };
  }

  function paintApply(tid, i) {
    const d = drag;
    if (!d || d.visited.has(i)) return;
    d.visited.add(i);
    if (d.param) { emitParam(tid, i, d.param, d.value); return; }
    if (!!stepAt(tid, i).on !== d.target) emitToggle(tid, i);
  }

  grid.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const hit = cellFromElement(e.target);
    if (!hit || hit.ph) return;
    focusCell(hit.tid, hit.i, { emit: true });
    const mod = modParamFromEvent(e, hit.tid, hit.i);
    if (mod) {
      drag = { id: e.pointerId, tid: hit.tid, param: mod[0], value: mod[1], visited: new Set(), pendingStart: false };
      paintApply(hit.tid, hit.i);           // modifier acts immediately on press
    } else {
      drag = { id: e.pointerId, tid: hit.tid, target: !stepAt(hit.tid, hit.i).on, visited: new Set(), pendingStart: true, startI: hit.i };
    }
    try { hit.cell.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    e.preventDefault();
  }, sig);

  grid.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const hit = cellFromElement(el);
    if (!hit || hit.ph || hit.tid !== drag.tid) return;
    if (drag.pendingStart) {                 // drag began: commit start cell too
      drag.pendingStart = false;
      paintApply(drag.tid, drag.startI);
    }
    paintApply(hit.tid, hit.i);
  }, sig);

  const endPaint = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = !drag.pendingStart;        // modifier presses apply at down
    try { e.target.releasePointerCapture(e.pointerId); } catch { /* already up */ }
    drag = null;
    // Swallow the click that follows a completed drag/modifier press so the
    // action is not applied twice to the starting cell.
    if (moved) suppressClick = true;
  };
  grid.addEventListener('pointerup', endPaint, sig);
  grid.addEventListener('pointercancel', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
  }, sig);

  grid.addEventListener('click', (e) => {
    const hit = cellFromElement(e.target);
    if (!hit || hit.ph) return;
    if (suppressClick) { suppressClick = false; return; }
    const mod = modParamFromEvent(e, hit.tid, hit.i);
    if (mod) {
      emitParam(hit.tid, hit.i, mod[0], mod[1]);
      return;
    }
    emitToggle(hit.tid, hit.i);
  }, sig);

  // ---- keyboard ----------------------------------------------------------------------
  grid.addEventListener('keydown', (e) => {
    const hit = cellFromElement(e.target);
    if (!hit || hit.ph) return;
    const tid = hit.tid;
    const i = hit.i;
    const L = activeLenOf(tid);
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': moveFocus(0, -1); break;
      case 'ArrowRight': moveFocus(0, 1); break;
      case 'ArrowUp': moveFocus(-1, 0); break;
      case 'ArrowDown': moveFocus(1, 0); break;
      case 'Home': focusCell(tid, 0); break;
      case 'End': focusCell(tid, L - 1); break;
      case ' ':
      case 'Enter':
        emitToggle(tid, i);
        break;
      case '[':
        emitParam(tid, i, 'nudge', -NUDGE_DELTA);
        break;
      case ']':
        emitParam(tid, i, 'nudge', NUDGE_DELTA);
        break;
      case '{':
        emitParam(tid, i, 'prob', cycleNext(PROB_PRESETS, clamp01(stepAt(tid, i).prob), -1));
        break;
      case '}':
        emitParam(tid, i, 'prob', cycleNext(PROB_PRESETS, clamp01(stepAt(tid, i).prob), 1));
        break;
      case 'r':
      case 'R':
        emitParam(tid, i, 'ratchet', cycleNext(RAT_PRESETS, clampInt(stepAt(tid, i).ratchet || 1, 1, 8), 1));
        break;
      case 'c':
      case 'C':
        h.onCopy(tid, i, i);
        announce(`${refs.get(tid).track.name} step ${i + 1} copied`);
        break;
      case 'v':
      case 'V':
        h.onPaste(tid, i);
        announce(`Pasted at ${refs.get(tid).track.name} step ${i + 1}`);
        break;
      case 'Escape':
        h.onSelect(tid, null);
        announce('Selection cleared');
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }, sig);

  reducedMQ.addEventListener?.('change', () => {
    if (lastBeat != null) setPlayheadBeat(lastBeat);
  }, sig);

  // ---- public API ------------------------------------------------------------------------
  function render(projectArg, patternId) {
    project = projectArg || null;
    pattern = project && Array.isArray(project.patterns)
      ? project.patterns.find((p) => p.id === patternId) || null
      : null;
    cols = pattern ? clampInt(pattern.length, 1, 64) : 0;
    const den = Number(project?.timeSig?.den);
    spb = Number.isFinite(den) && den > 0 ? 16 / den : 4;
    lastBeat = null;
    drag = null;
    suppressClick = false;
    buildAll();
  }

  function updateTrack(trackId) {
    if (refs.has(trackId)) paintRow(trackId);
  }

  function updateCell(trackId, i) {
    const R = refs.get(trackId);
    if (!R || !Number.isInteger(i) || i < 0 || i >= cols) return;
    paintCell(R.cells[i], trackId, i);
  }

  // Continuous playhead position in beats (quarter notes). Under reduced
  // motion this drives the discrete column highlight instead of the line.
  function setPlayheadBeat(beatFloat) {
    lastBeat = (typeof beatFloat === 'number' && Number.isFinite(beatFloat)) ? beatFloat : null;
    if (lastBeat == null || cols <= 0) {
      hideLine();
      if (reducedMQ.matches) applyActive(null);
      return;
    }
    if (reducedMQ.matches) {
      hideLine();
      applyActive(Math.floor(lastBeat * spb));
      return;
    }
    if (!ensureXs()) return;
    const sf = lastBeat * spb;
    const i = clampInt(Math.floor(sf), 0, cols - 1);
    const f = sf - Math.floor(sf);
    const seg = i + 1 < xs.length ? xs[i + 1] - xs[i] : cellW + 3;
    showLine(xs[i] + seg * f);
  }

  // Discrete current-step marker (exact-cell outline + column wash). Also the
  // reduced-motion playhead path. Pass null to clear.
  function setActiveStep(stepIndexOrNull) {
    applyActive(stepIndexOrNull);
  }

  function getFocused() {
    if (!roving || !refs.has(roving.tid)) return null;
    return { trackId: roving.tid, step: roving.i };
  }

  function dispose() {
    ac.abort();
    if (resizeObs) resizeObs.disconnect();
    grid.remove();
    refs.clear();
    order = [];
    project = null;
    pattern = null;
    roving = null;
    activeCol = -1;
    drag = null;
    xs = [];
  }

  return {
    render,
    updateTrack,
    updateCell,
    setPlayheadBeat,
    setActiveStep,
    setLengths: applyLengths,
    getFocused,
    focusCell: (trackId, i) => focusCell(trackId, i, { emit: true }),
    dispose
  };
}
