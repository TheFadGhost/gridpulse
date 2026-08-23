// Vertical mixer fader (96px groove, components.css) + optional post-fader
// meter. JS drives:
//   --fader  0..1  on .gp-fader   (thumb bottom: calc(var(--fader) * 86px))
//   --rms / --peak 0..1 on .gp-meter (call setMeter; refresh <= 30fps)
//
// ARIA slider pattern (vertical). Click on the track jumps the thumb there,
// then drags. The component never touches project data.
const FADER_MAX = 1.2;
const FADER_STEP = 0.01;

export function createFader({ label, value = 0.85, meter = true } = {}) {
  let val = clamp(Number.isFinite(value) ? value : 0);

  const ac = new AbortController();
  const sig = { signal: ac.signal };

  const wrap = document.createElement('div');
  wrap.className = 'gp-param';

  const fader = document.createElement('div');
  fader.className = 'gp-fader';
  fader.setAttribute('role', 'slider');
  fader.setAttribute('aria-orientation', 'vertical');
  fader.setAttribute('aria-label', String(label ?? 'volume'));
  fader.setAttribute('aria-valuemin', '0');
  fader.setAttribute('aria-valuemax', String(FADER_MAX));
  fader.tabIndex = 0;

  const track = document.createElement('div');
  track.className = 'gp-fader-track';
  const thumb = document.createElement('div');
  thumb.className = 'gp-fader-thumb';
  fader.append(track, thumb);
  wrap.appendChild(fader);

  let meterEl = null;
  if (meter) {
    meterEl = document.createElement('div');
    meterEl.className = 'gp-meter';
    const rms = document.createElement('div');
    rms.className = 'gp-meter-rms';
    const peak = document.createElement('div');
    peak.className = 'gp-meter-peak';
    meterEl.append(rms, peak);
    wrap.appendChild(meterEl);
  }

  const labelEl = document.createElement('span');
  labelEl.className = 'gp-label';
  labelEl.textContent = String(label ?? '');
  wrap.appendChild(labelEl);

  let cb = null;
  let dragId = null;

  function clamp(v) {
    if (!Number.isFinite(v)) return 0;
    return Math.min(FADER_MAX, Math.max(0, v));
  }

  function valueFromY(clientY) {
    const r = fader.getBoundingClientRect();
    if (r.height <= 0) return val;
    const t = 1 - (clientY - r.top) / r.height;
    return clamp(Math.min(1, Math.max(0, t)) * FADER_MAX);
  }

  function paint() {
    const t = val / FADER_MAX;
    fader.style.setProperty('--fader', t.toFixed(4));
    fader.setAttribute('aria-valuenow', val.toFixed(2));
    fader.setAttribute('aria-valuetext', `${Math.round(t * 100)} percent`);
  }

  function commit(v) {
    const next = clamp(v);
    if (next === val) { paint(); return; }
    val = next;
    paint();
    if (cb) cb(val);
  }

  fader.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragId = e.pointerId;
    try { fader.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    e.preventDefault();
    commit(valueFromY(e.clientY));
  }, sig);

  fader.addEventListener('pointermove', (e) => {
    if (dragId !== e.pointerId) return;
    commit(valueFromY(e.clientY));
  }, sig);

  const endDrag = (e) => {
    if (dragId !== e.pointerId) return;
    try { fader.releasePointerCapture(e.pointerId); } catch { /* already up */ }
    dragId = null;
  };
  fader.addEventListener('pointerup', endDrag, sig);
  fader.addEventListener('pointercancel', endDrag, sig);

  fader.addEventListener('keydown', (e) => {
    const fine = e.shiftKey ? 0.1 : 1;
    let next = null;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight': next = val + FADER_STEP * fine; break;
      case 'ArrowDown':
      case 'ArrowLeft': next = val - FADER_STEP * fine; break;
      case 'Home': next = 0; break;
      case 'End': next = FADER_MAX; break;
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
    // Ballistics belong to the host (measurement, not decoration); this only
    // maps 0..1 into the two custom props the meter CSS reads.
    setMeter({ peak = 0, rms = 0 } = {}) {
      if (!meterEl) return;
      const p = Math.min(1, Math.max(0, Number(peak) || 0));
      const r = Math.min(1, Math.max(0, Number(rms) || 0));
      meterEl.style.setProperty('--peak', p.toFixed(4));
      meterEl.style.setProperty('--rms', r.toFixed(4));
    },
    dispose() {
      ac.abort();
      wrap.remove();
    }
  };
}
