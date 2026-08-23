// Mixer: one .gp-strip per track (components.css) — name button, volume fader
// (0..1.2, post-fader meter), pan knob (bipolar, centred at 12 o'clock),
// M/S LED toggles.
//
// The component never mutates project data: render(tracks) snapshots the
// track references it is given; updateTrack(trackId) re-reads that track's
// current mixer fields and repaints its strip. Selection is tracked
// internally (click = immediate), but a `selected: true` field on any track
// passed to render() wins — the host can drive selection declaratively.
import { createFader } from './fader.js';
import { createKnob } from './knob.js';

function fmtPan(v) {
  const pct = Math.round(Math.abs(v) * 100);
  if (pct === 0) return 'C';
  return `${v < 0 ? 'L' : 'R'} ${pct}%`;
}

export function createMixer(container, handlers) {
  const h = handlers || {};
  let tracks = [];
  let selectedId = null;
  /** @type {{ id: string, strip: HTMLDivElement, nameBtn: HTMLButtonElement,
               fader: ReturnType<typeof createFader>, pan: ReturnType<typeof createKnob>,
               muteBtn: HTMLButtonElement, soloBtn: HTMLButtonElement } | null>} */
  let strips = [];

  function find(tid) {
    for (const s of strips) if (s && s.id === tid) return s;
    return null;
  }

  function paintSelection() {
    for (const s of strips) {
      if (!s) continue;
      const sel = s.id === selectedId;
      s.strip.classList.toggle('is-selected', sel);
      s.nameBtn.setAttribute('aria-current', sel ? 'true' : 'false');
    }
  }

  // Repaint one strip's controls from live track data (no callbacks fired).
  function paintStrip(s) {
    const t = tracks.find((tr) => tr.id === s.id);
    if (!t) return;
    s.nameBtn.textContent = String(t.name ?? s.id);
    s.fader.set(t.mixer.volume);
    s.pan.set(t.mixer.pan);
    s.muteBtn.setAttribute('aria-pressed', t.mixer.mute ? 'true' : 'false');
    s.soloBtn.setAttribute('aria-pressed', t.mixer.solo ? 'true' : 'false');
  }

  function buildStrip(t) {
    const strip = document.createElement('div');
    strip.className = 'gp-strip';
    strip.dataset.trackId = t.id;

    const nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.className = 'gp-btn gp-strip-name';
    nameBtn.style.width = 'auto';
    nameBtn.style.height = 'auto';
    nameBtn.style.padding = '0 var(--sp-2)';
    nameBtn.textContent = String(t.name ?? t.id);
    nameBtn.setAttribute('aria-label', `Select ${t.name}`);
    nameBtn.addEventListener('click', () => {
      selectedId = t.id;
      paintSelection();
      if (h.onSelect) h.onSelect(t.id);
    });
    strip.appendChild(nameBtn);

    const controls = document.createElement('div');
    controls.className = 'gp-strip-controls';

    const vol = createFader({ label: 'vol', value: t.mixer.volume, meter: true });
    vol.onChange((v) => { if (h.onVolume) h.onVolume(t.id, v); });

    const pan = createKnob({
      label: 'pan',
      min: -1,
      max: 1,
      step: 0.01,
      value: t.mixer.pan,
      defaultValue: 0,
      format: fmtPan
    });
    pan.onChange((v) => { if (h.onPan) h.onPan(t.id, v); });

    controls.append(vol.el, pan.el);
    strip.appendChild(controls);

    const toggles = document.createElement('div');
    toggles.className = 'gp-strip-toggles';

    const mkToggle = (letter, title, fire) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'gp-btn';
      b.title = title;
      b.setAttribute('aria-label', `${title} ${t.name}`);
      b.setAttribute('aria-pressed', 'false');
      const dot = document.createElement('span');
      dot.className = 'gp-led';
      const txt = document.createElement('span');
      txt.textContent = letter;
      b.append(dot, txt);
      b.addEventListener('click', () => { fire(); });
      return b;
    };
    const muteBtn = mkToggle('M', 'Mute', () => { if (h.onMute) h.onMute(t.id); });
    const soloBtn = mkToggle('S', 'Solo', () => { if (h.onSolo) h.onSolo(t.id); });
    toggles.append(muteBtn, soloBtn);
    strip.appendChild(toggles);

    return { id: t.id, strip, nameBtn, fader: vol, pan, muteBtn, soloBtn };
  }

  function disposeStrips() {
    for (const s of strips) {
      if (!s) continue;
      s.fader.dispose();
      s.pan.dispose();
    }
    strips = [];
    container.replaceChildren();
  }

  function render(nextTracks) {
    disposeStrips();
    tracks = Array.isArray(nextTracks) ? nextTracks : [];
    const declared = tracks.find((t) => t && t.selected === true);
    selectedId = declared ? declared.id : (tracks[0] ? tracks[0].id : null);
    for (const t of tracks) {
      if (!t) continue;
      const s = buildStrip(t);
      strips.push(s);
      container.appendChild(s.strip);
    }
    paintSelection();
  }

  function updateTrack(trackId) {
    const s = find(trackId);
    if (s) paintStrip(s);
  }

  function setMeter(trackId, levels) {
    const s = find(trackId);
    if (s) s.fader.setMeter(levels);
  }

  function dispose() {
    disposeStrips();
    tracks = [];
    selectedId = null;
  }

  return { render, updateTrack, setMeter, dispose };
}
