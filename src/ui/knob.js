// Rotary knob control (36px hardware idiom per DESIGN.md "Controls").
//
// Visuals come from components.css: JS drives two custom props on .gp-knob —
//   --knob  0..1  arc fill from 7 o'clock (300deg sweep)
//   --rot   deg   pointer notch angle (-150deg .. +150deg)
// The wrapper is .gp-param; while a user adjustment is live (and for 1s after
// release) it gets .is-readout so .gp-value replaces .gp-label.
//
// Pure presentation + intent: the component never touches project data.
export function createKnob({
  label,
  min,
  max,
  step = 0.01,
  value,
  format = (v) => v.toFixed(2),
  defaultValue
} = {}) {
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) ? max : 1;
  const stp = Number(step) > 0 ? Number(step) : 0.01;
  const decimals = (String(stp).split('.')[1] || '').length;
  const fmt = typeof format === 'function' ? format : (v) => v.toFixed(2);
  const resetTo = Number.isFinite(defaultValue) ? defaultValue
    : (Number.isFinite(value) ? value : lo);

  let val = clamp(Number.isFinite(value) ? value : lo);
  let cb = null;

  const ac = new AbortController();
  const sig = { signal: ac.signal };

  const wrap = document.createElement('div');
  wrap.className = 'gp-param';

  const knob = document.createElement('button');
  knob.type = 'button';
  knob.className = 'gp-knob';
  knob.setAttribute('role', 'slider');
  knob.setAttribute('aria-label', String(label ?? 'knob'));
  knob.setAttribute('aria-valuemin', String(lo));
  knob.setAttribute('aria-valuemax', String(hi));
  knob.tabIndex = 0;
  knob.style.touchAction = 'none';

  const labelEl = document.createElement('span');
  labelEl.className = 'gp-label';
  labelEl.textContent = String(label ?? '');

  const valueEl = document.createElement('span');
  valueEl.className = 'gp-value';

  wrap.append(knob, labelEl, valueEl);

  let hideTimer = 0;
  let drag = null;

  function clamp(v) {
    if (!Number.isFinite(v)) return lo;
    return Math.min(hi, Math.max(lo, v));
  }

  function quantize(v) {
    const q = lo + Math.round((v - lo) / stp) * stp;
    return clamp(Number(q.toFixed(decimals + 4)));
  }

  function paint() {
    const t = hi > lo ? (val - lo) / (hi - lo) : 0;
    const tc = Math.min(1, Math.max(0, t));
    wrap.style.setProperty('--knob', tc.toFixed(4));
    knob.style.setProperty('--rot', `${(-150 + 300 * tc).toFixed(2)}deg`);
    knob.setAttribute('aria-valuenow', String(val));
    knob.setAttribute('aria-valuetext', String(fmt(val)));
    valueEl.textContent = String(fmt(val));
  }

  // Readout shows while adjusting and holds 1s after the last change.
  function flashReadout() {
    wrap.classList.add('is-readout');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => wrap.classList.remove('is-readout'), 1000);
  }

  function commit(raw) {
    const next = quantize(raw);
    if (next === val) return;
    val = next;
    paint();
    flashReadout();
    if (cb) cb(val);
  }

  knob.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { id: e.pointerId, y: e.clientY, v: val };
    try { knob.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    e.preventDefault();
  }, sig);

  knob.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const fine = e.shiftKey ? 0.1 : 1;
    const dy = drag.y - e.clientY;            // up = increase, full range/150px
    commit(drag.v + (dy / 150) * (hi - lo) * fine);
  }, sig);

  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    try { knob.releasePointerCapture(e.pointerId); } catch { /* already up */ }
    drag = null;
  };
  knob.addEventListener('pointerup', endDrag, sig);
  knob.addEventListener('pointercancel', endDrag, sig);

  knob.addEventListener('dblclick', () => {
    commit(resetTo);
  }, sig);

  knob.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    const fine = e.shiftKey ? 0.1 : 1;
    commit(val + dir * stp * fine);
  }, { ...sig, passive: false });

  knob.addEventListener('keydown', (e) => {
    const fine = e.shiftKey ? 0.1 : 1;
    let next = null;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight': next = val + stp * fine; break;
      case 'ArrowDown':
      case 'ArrowLeft': next = val - stp * fine; break;
      case 'Home': next = lo; break;
      case 'End': next = hi; break;
      default: return;
    }
    e.preventDefault();
    commit(next);
  }, sig);

  paint();

  return {
    el: wrap,
    set(v) { val = clamp(Number(v)); paint(); },
    get() { return val; },
    onChange(fn) { cb = typeof fn === 'function' ? fn : null; },
    dispose() {
      ac.abort();
      clearTimeout(hideTimer);
      wrap.remove();
    }
  };
}
