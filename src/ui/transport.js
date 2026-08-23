// Transport bar (DESIGN.md layout top-left): play/pause, stop, BPM + TAP,
// swing, time signature, metronome (LED + division + gain).
//
// State flows in through the setters (they never fire handlers); user intent
// flows out through handlers only. Icons are inline SVG paths — no emoji, no
// font icons. TAP pulses by flashing .is-active (components.css accent state),
// 120 ms, cleared on dispose.
import { createKnob } from './knob.js';

const ICON_PLAY =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M4 2 L13 8 L4 14 Z" fill="currentColor"/></svg>';
const ICON_PAUSE =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<rect x="3" y="2" width="3.5" height="12" fill="currentColor"/>' +
  '<rect x="9.5" y="2" width="3.5" height="12" fill="currentColor"/></svg>';
const ICON_STOP =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<rect x="3" y="3" width="10" height="10" fill="currentColor"/></svg>';

const BPM_MIN = 20;
const BPM_MAX = 333;
const TIME_DENOMS = [2, 4, 8, 16];

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

export function createTransport(container, handlers) {
  const h = handlers || {};
  const ac = new AbortController();
  const sig = { signal: ac.signal };
  /** @type {ReturnType<typeof createKnob>[]} */
  const knobs = [];

  container.classList.add('gp-transport');

  function btn(icon, label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'gp-btn';
    b.innerHTML = icon;
    b.setAttribute('aria-label', label);
    return b;
  }

  function col(caption, ...children) {
    const wrapCol = document.createElement('div');
    wrapCol.style.display = 'flex';
    wrapCol.style.flexDirection = 'column';
    wrapCol.style.alignItems = 'center';
    wrapCol.style.gap = 'var(--sp-1)';
    const cap = document.createElement('span');
    cap.className = 'gp-label';
    cap.textContent = caption;
    wrapCol.append(cap, ...children);
    return wrapCol;
  }

  function mkSelect(label, options, value) {
    const s = document.createElement('select');
    s.setAttribute('aria-label', label);
    s.style.fontFamily = 'var(--font-mono)';
    s.style.fontSize = 'var(--fs-label)';
    s.style.backgroundColor = 'var(--bg-sunken)';
    s.style.color = 'var(--fg)';
    s.style.border = '1px solid var(--line)';
    s.style.borderRadius = 'var(--radius-1)';
    s.style.padding = '2px 4px';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = String(o.value);
      opt.textContent = String(o.text ?? o.value);
      s.appendChild(opt);
    }
    s.value = String(value);
    return s;
  }

  // ---- play / pause / stop -------------------------------------------------

  const playBtn = btn(ICON_PLAY, 'Play');
  playBtn.addEventListener('click', () => { if (h.onPlayPause) h.onPlayPause(); }, sig);

  const stopBtn = btn(ICON_STOP, 'Stop');
  stopBtn.addEventListener('click', () => { if (h.onStop) h.onStop(); }, sig);

  // ---- BPM + TAP ------------------------------------------------------------

  const bpmInput = document.createElement('input');
  bpmInput.type = 'number';
  bpmInput.min = String(BPM_MIN);
  bpmInput.max = String(BPM_MAX);
  bpmInput.step = '0.1';
  bpmInput.value = '120.0';
  bpmInput.setAttribute('aria-label', 'Tempo BPM');
  bpmInput.style.width = '76px';
  bpmInput.style.fontFamily = 'var(--font-mono)';
  bpmInput.style.fontSize = 'var(--fs-value)';
  bpmInput.style.backgroundColor = 'var(--bg-sunken)';
  bpmInput.style.color = 'var(--fg)';
  bpmInput.style.border = '1px solid var(--line)';
  bpmInput.style.borderRadius = 'var(--radius-1)';
  bpmInput.style.padding = '4px 6px';
  bpmInput.addEventListener('input', () => {
    if (bpmInput.value === '') return;
    if (h.onBpm) h.onBpm(clampNum(bpmInput.value, BPM_MIN, BPM_MAX, 120));
  }, sig);

  const tapBtn = document.createElement('button');
  tapBtn.type = 'button';
  tapBtn.className = 'gp-btn';
  tapBtn.textContent = 'TAP';
  tapBtn.setAttribute('aria-label', 'Tap tempo');
  tapBtn.style.width = 'auto';
  tapBtn.style.padding = '0 var(--sp-2)';
  tapBtn.addEventListener('click', () => { if (h.onTap) h.onTap(); }, sig);

  let tapTimer = 0;
  container.append(playBtn, stopBtn, col('BPM', bpmInput), tapBtn);

  // ---- swing ------------------------------------------------------------------

  const swingKnob = createKnob({
    label: 'swing',
    min: 0,
    max: 0.6,
    step: 0.01,
    value: 0,
    defaultValue: 0,
    format: (v) => `${Math.round((v / 0.6) * 100)}%`
  });
  knobs.push(swingKnob);
  swingKnob.onChange((v) => { if (h.onSwing) h.onSwing(v); });
  container.appendChild(col('SWING', swingKnob.el));

  // ---- time signature -----------------------------------------------------------

  const numOpts = [];
  for (let n = 2; n <= 16; n++) numOpts.push({ value: n });
  const denOpts = TIME_DENOMS.map((d) => ({ value: d }));
  const numSel = mkSelect('Beats per bar', numOpts, 4);
  const denSel = mkSelect('Beat division', denOpts, 4);
  const fireSig = () => {
    if (h.onTimeSig) {
      h.onTimeSig(parseInt(numSel.value, 10), parseInt(denSel.value, 10));
    }
  };
  numSel.addEventListener('change', fireSig, sig);
  denSel.addEventListener('change', fireSig, sig);
  const sigWrap = document.createElement('div');
  sigWrap.style.display = 'flex';
  sigWrap.style.alignItems = 'flex-end';
  sigWrap.style.gap = 'var(--sp-1)';
  sigWrap.append(numSel, denSel);
  container.appendChild(col('SIG', sigWrap));

  // ---- metronome ---------------------------------------------------------------

  const metroBtn = document.createElement('button');
  metroBtn.type = 'button';
  metroBtn.className = 'gp-btn';
  metroBtn.title = 'Metronome';
  metroBtn.setAttribute('aria-label', 'Toggle metronome');
  metroBtn.setAttribute('aria-pressed', 'false');
  const metroDot = document.createElement('span');
  metroDot.className = 'gp-led';
  metroBtn.appendChild(metroDot);
  metroBtn.addEventListener('click', () => { if (h.onMetroToggle) h.onMetroToggle(); }, sig);

  const divOpts = [];
  for (let d = 1; d <= 16; d++) divOpts.push({ value: d });
  const metroDiv = mkSelect('Metronome division', divOpts, 4);
  metroDiv.addEventListener('change', () => {
    if (h.onMetroDivision) h.onMetroDivision(parseInt(metroDiv.value, 10));
  }, sig);

  const metroGain = createKnob({
    label: 'metro',
    min: 0,
    max: 1,
    step: 0.01,
    value: 0.5,
    defaultValue: 0.5,
    format: (v) => `${Math.round(v * 100)}%`
  });
  knobs.push(metroGain);
  metroGain.onChange((v) => { if (h.onMetroGain) h.onMetroGain(v); });

  const metroRow = document.createElement('div');
  metroRow.className = 'gp-ledtag';
  metroRow.append(metroBtn, metroDiv);
  container.appendChild(col('METRO', metroRow, metroGain.el));

  // ---- state setters -------------------------------------------------------------

  function setPlaying(playing) {
    const on = !!playing;
    playBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    playBtn.innerHTML = on ? ICON_PAUSE : ICON_PLAY;
    playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
  }

  function setBlocked(blocked) {
    const b = !!blocked;
    for (const el of [playBtn, stopBtn]) {
      el.disabled = b;
      el.setAttribute('aria-disabled', b ? 'true' : 'false');
      el.title = b ? 'Start audio first (click anywhere)' : el.getAttribute('data-title') || '';
      if (!b) el.removeAttribute('aria-disabled');
    }
  }

  function setBpm(bpm) {
    const v = clampNum(bpm, BPM_MIN, BPM_MAX, 120);
    bpmInput.value = v.toFixed(1);
  }

  function setSwing(v) {
    swingKnob.set(clampNum(v, 0, 0.6, 0));
  }

  function setTimeSig(num, den) {
    const n = Math.round(clampNum(num, 2, 16, 4));
    const d = TIME_DENOMS.includes(Math.round(den)) ? Math.round(den) : 4;
    numSel.value = String(n);
    denSel.value = String(d);
  }

  function setMetronome(enabled, division, gain) {
    metroBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    const dv = Math.round(clampNum(division, 1, 16, 4));
    metroDiv.value = String(dv);
    if (Number.isFinite(gain)) metroGain.set(clampNum(gain, 0, 1, 0.5));
  }

  function setTapPulse() {
    tapBtn.classList.add('is-active');
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => tapBtn.classList.remove('is-active'), 120);
  }

  function dispose() {
    ac.abort();
    clearTimeout(tapTimer);
    for (const k of knobs) k.dispose();
    container.replaceChildren();
  }

  return {
    setPlaying, setBlocked, setBpm, setSwing, setTimeSig, setMetronome, setTapPulse, dispose
  };
}
