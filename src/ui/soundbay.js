// Sound bay: voice params for the selected track + its FX chain, always shown,
// under a static signal-flow diagram (DESIGN.md "Mixer & FX layout").
//
// Every control emits intents through handlers ONLY — paths are dotted strings
// into the project shape (PROJECT_SCHEMA.md):
//   'params.wave' | 'params.cutoff' | 'params.start' | ...
//   'fx.drive.amount' | 'fx.filter.type' | 'fx.delay.on' | ...
// Key/scale changes go through onKeyScale(key, scaleName), not onParam.
//
// render() disposes the previous control set (registry) and rebuilds, so live
// knob objects never leak between renders. The component never mutates
// project data.
import { createKnob } from './knob.js';

const FLOW_TEXT =
  'voice > drive > filter > comp > [delay send] [reverb send] > pan > fader > master';

const WAVES = ['sine', 'triangle', 'sawtooth', 'square', 'supersaw'];
const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass'];

// Per-piece drum param ranges; unknown params fall back to 0..1.
const DRUM_PARAM_SPECS = {
  pitch: { min: 20, max: 500, step: 1, format: fmtHz },
  tone: { min: 100, max: 12000, step: 10, format: fmtHz },
  decay: { min: 0.01, max: 2, step: 0.005, format: fmtSec },
  punch: { min: 0, max: 1, step: 0.01 },
  snap: { min: 0, max: 1, step: 0.01 },
  spread: { min: 0, max: 1, step: 0.01 },
  drop: { min: 0, max: 1, step: 0.01 }
};

function fmtHz(v) {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`;
}

function fmtSec(v) {
  return `${Number(v).toFixed(2)}s`;
}

function fmtPct(v) {
  return `${Math.round(v * 100)}%`;
}

function fmtMs(v) {
  return `${(v * 1000).toFixed(0)}ms`;
}

export function createSoundBay(container, handlers) {
  const h = handlers || {};
  /** @type {ReturnType<typeof createKnob>[]} */
  let controls = [];

  function reg(c) {
    controls.push(c);
    return c;
  }

  function clear() {
    for (const c of controls) c.dispose();
    controls = [];
    container.replaceChildren();
  }

  function emit(path, value) {
    if (h.onParam) h.onParam(path, value);
  }

  function announce(text) {
    if (h.onAnnounce) h.onAnnounce(text);
  }

  // ---- builders -----------------------------------------------------------

  function addPanel() {
    const p = document.createElement('div');
    p.className = 'gp-panel';
    container.appendChild(p);
    return p;
  }

  function addGrid(parent) {
    const g = document.createElement('div');
    g.className = 'gp-bay';
    parent.appendChild(g);
    return g;
  }

  function addRow(parent) {
    const r = document.createElement('div');
    r.style.display = 'flex';
    r.style.alignItems = 'center';
    r.style.flexWrap = 'wrap';
    r.style.columnGap = 'var(--sp-3)';
    r.style.rowGap = 'var(--sp-2)';
    parent.appendChild(r);
    return r;
  }

  function addLabel(parent, text) {
    const el = document.createElement('span');
    el.className = 'gp-label';
    el.textContent = String(text);
    parent.appendChild(el);
    return el;
  }

  // Captioned select in a .gp-param-style column (caption on top).
  function addSelect(parent, caption, options, value, onChange) {
    const wrapCol = document.createElement('div');
    wrapCol.style.display = 'flex';
    wrapCol.style.flexDirection = 'column';
    wrapCol.style.alignItems = 'center';
    wrapCol.style.gap = 'var(--sp-1)';
    const cap = document.createElement('span');
    cap.className = 'gp-label';
    cap.textContent = String(caption);
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', String(caption));
    sel.style.fontFamily = 'var(--font-mono)';
    sel.style.fontSize = 'var(--fs-label)';
    sel.style.backgroundColor = 'var(--bg-sunken)';
    sel.style.color = 'var(--fg)';
    sel.style.border = '1px solid var(--line)';
    sel.style.borderRadius = 'var(--radius-1)';
    sel.style.padding = '2px 4px';
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = String(opt.value);
      o.textContent = String(opt.text ?? opt.value);
      sel.appendChild(o);
    }
    sel.value = String(value);
    sel.addEventListener('change', () => onChange(sel.value));
    wrapCol.append(cap, sel);
    parent.appendChild(wrapCol);
    return sel;
  }

  function addKnob(parent, path, spec, value) {
    const k = reg(createKnob({
      label: spec.label,
      min: spec.min,
      max: spec.max,
      step: spec.step,
      value,
      defaultValue: Number.isFinite(spec.defaultValue) ? spec.defaultValue : value,
      format: spec.format
    }));
    k.onChange((v) => emit(path, v));
    parent.appendChild(k.el);
    return k;
  }

  // FX-block toggle: lit LED dot next to its unit name (.gp-ledtag row head).
  function addLedToggle(parent, name, on, onToggle) {
    const tag = document.createElement('span');
    tag.className = 'gp-ledtag';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'gp-btn';
    b.title = `Toggle ${name}`;
    b.setAttribute('aria-label', `Toggle ${name}`);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    const dot = document.createElement('span');
    dot.className = 'gp-led';
    b.appendChild(dot);
    b.addEventListener('click', () => onToggle());
    const lbl = document.createElement('span');
    lbl.className = 'gp-label';
    lbl.textContent = name.toUpperCase();
    tag.append(b, lbl);
    parent.appendChild(tag);
    return b;
  }

  // ---- voice section --------------------------------------------------------

  function renderDrum(grid, p) {
    for (const key of Object.keys(p)) {
      if (key === 'piece') continue;
      const spec = DRUM_PARAM_SPECS[key] || { min: 0, max: 1, step: 0.01 };
      addKnob(grid, `params.${key}`, { ...spec, label: key }, p[key]);
    }
  }

  function renderSynth(grid, p) {
    addSelect(grid, 'wave',
      WAVES.map((w) => ({ value: w })),
      p.wave ?? 'sawtooth',
      (v) => emit('params.wave', v));
    addKnob(grid, 'params.detune', { label: 'detune', min: -50, max: 50, step: 1, format: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}ct` }, p.detune);
    addKnob(grid, 'params.glide', { label: 'glide', min: 0, max: 0.5, step: 0.005, format: fmtSec }, p.glide);
    addKnob(grid, 'params.attack', { label: 'A', min: 0.001, max: 2, step: 0.001, format: fmtSec }, p.attack);
    addKnob(grid, 'params.decay', { label: 'D', min: 0.005, max: 2, step: 0.005, format: fmtSec }, p.decay);
    addKnob(grid, 'params.sustain', { label: 'S', min: 0, max: 1, step: 0.01, format: fmtPct }, p.sustain);
    addKnob(grid, 'params.release', { label: 'R', min: 0.005, max: 4, step: 0.005, format: fmtSec }, p.release);
    addKnob(grid, 'params.cutoff', { label: 'cutoff', min: 30, max: 18000, step: 10, format: fmtHz }, p.cutoff);
    addKnob(grid, 'params.resonance', { label: 'reso', min: 0.1, max: 18, step: 0.05, format: (v) => v.toFixed(1) }, p.resonance);
    addKnob(grid, 'params.envMod', { label: 'env mod', min: 0, max: 10, step: 0.05, format: (v) => v.toFixed(1) }, p.envMod);
    addKnob(grid, 'params.fEnvDecay', { label: 'f dec', min: 0.005, max: 4, step: 0.005, format: fmtSec }, p.fEnvDecay);
  }

  function renderSampler(panel, grid, t, p) {
    const row = addRow(panel);

    const fileBtn = document.createElement('button');
    fileBtn.type = 'button';
    fileBtn.className = 'gp-btn';
    fileBtn.style.width = 'auto';
    fileBtn.style.padding = '0 var(--sp-2)';
    fileBtn.textContent = 'LOAD SAMPLE';
    fileBtn.setAttribute('aria-label', 'Load sample audio file');

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.hidden = true;
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      announce(`sample: ${file.name}`);
      if (h.onSampleFile) h.onSampleFile(file);
    });
    fileBtn.addEventListener('click', () => input.click());

    const nameLabel = document.createElement('span');
    nameLabel.className = 'gp-label';
    nameLabel.title = 'Current sample';
    nameLabel.textContent = String((t.sample && t.sample.name) || 'no sample');

    row.append(fileBtn, input, nameLabel);

    addKnob(grid, 'params.gain', { label: 'gain', min: 0, max: 1.5, step: 0.01 }, p.gain);
    addKnob(grid, 'params.tune', { label: 'tune', min: -12, max: 12, step: 0.1, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}st` }, p.tune);
    addKnob(grid, 'params.start', { label: 'start', min: 0, max: 1, step: 0.005, format: fmtPct }, p.start);
    addKnob(grid, 'params.end', { label: 'end', min: 0, max: 1, step: 0.005, format: fmtPct }, p.end);

    // Reverse LED toggle lives with the other voice params.
    const revTag = document.createElement('span');
    revTag.className = 'gp-ledtag';
    const revBtn = document.createElement('button');
    revBtn.type = 'button';
    revBtn.className = 'gp-btn';
    revBtn.title = 'Reverse';
    revBtn.setAttribute('aria-label', 'Reverse sample playback');
    revBtn.setAttribute('aria-pressed', p.reverse ? 'true' : 'false');
    const dot = document.createElement('span');
    dot.className = 'gp-led';
    revBtn.appendChild(dot);
    revBtn.addEventListener('click', () => {
      const next = revBtn.getAttribute('aria-pressed') !== 'true';
      revBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
      emit('params.reverse', next);
    });
    const revLbl = document.createElement('span');
    revLbl.className = 'gp-label';
    revLbl.textContent = 'REV';
    revTag.append(revBtn, revLbl);
    panel.appendChild(revTag);
  }

  function renderKeyScale(panel, context) {
    const ctx = context || {};
    const keyNames = Array.isArray(ctx.keyNames) ? ctx.keyNames : [];
    const scaleNames = Array.isArray(ctx.scaleNames) ? ctx.scaleNames : [];

    const row = addRow(panel);
    let keyVal = Number.isFinite(ctx.key) ? ctx.key : 0;
    let scaleVal = ctx.scale ?? scaleNames[0] ?? '';

    const keySel = addSelect(row, 'key',
      keyNames.map((n, i) => ({ value: i, text: n })),
      keyVal,
      (v) => {
        keyVal = Number(v);
        fire();
      });
    const scaleSel = addSelect(row, 'scale',
      scaleNames.map((s) => ({ value: s })),
      scaleVal,
      (v) => {
        scaleVal = v;
        fire();
      });

    const qBtn = document.createElement('button');
    qBtn.type = 'button';
    qBtn.className = 'gp-btn';
    qBtn.style.width = 'auto';
    qBtn.style.padding = '0 var(--sp-2)';
    qBtn.textContent = 'QUANTIZE';
    qBtn.setAttribute('aria-label', 'Quantize steps to key and scale');
    qBtn.addEventListener('click', () => {
      announce(`quantized to ${keyNames[keyVal] ?? keyVal} ${scaleVal}`);
      if (h.onQuantize) h.onQuantize();
    });
    row.appendChild(qBtn);

    function fire() {
      announce(`${keyNames[keyVal] ?? keyVal} ${scaleVal}`);
      if (h.onKeyScale) h.onKeyScale(keyVal, String(scaleVal));
    }
  }

  // ---- fx section (always shown, fixed order) ---------------------------------

  function renderFx(panel, fx) {
    const src = fx || {};

    // drive -----------------------------------------------------------------
    let row = addRow(panel);
    addLedToggle(row, 'drive', !!(src.drive && src.drive.on),
      () => emit('fx.drive.on', !(src.drive && src.drive.on)));
    addKnob(row, 'fx.drive.amount', { label: 'amount', min: 0, max: 1, step: 0.01, format: fmtPct },
      src.drive ? src.drive.amount : 0);

    // filter ------------------------------------------------------------------
    row = addRow(panel);
    addLedToggle(row, 'filter', !!(src.filter && src.filter.on),
      () => emit('fx.filter.on', !(src.filter && src.filter.on)));
    addSelect(row, 'type',
      FILTER_TYPES.map((x) => ({ value: x })),
      src.filter ? src.filter.type : 'lowpass',
      (v) => emit('fx.filter.type', v));
    addKnob(row, 'fx.filter.cutoff', { label: 'cutoff', min: 30, max: 18000, step: 10, format: fmtHz },
      src.filter ? src.filter.cutoff : 8000);
    addKnob(row, 'fx.filter.q', { label: 'Q', min: 0.1, max: 18, step: 0.05, format: (v) => v.toFixed(1) },
      src.filter ? src.filter.q : 0.7);

    // comp ----------------------------------------------------------------------
    row = addRow(panel);
    addLedToggle(row, 'comp', !!(src.comp && src.comp.on),
      () => emit('fx.comp.on', !(src.comp && src.comp.on)));
    addKnob(row, 'fx.comp.threshold', { label: 'thresh', min: -60, max: 0, step: 0.5, format: (v) => `${Math.round(v)}dB` },
      src.comp ? src.comp.threshold : -18);
    addKnob(row, 'fx.comp.ratio', { label: 'ratio', min: 1, max: 20, step: 0.1, format: (v) => `${v.toFixed(1)}:1` },
      src.comp ? src.comp.ratio : 3);
    addKnob(row, 'fx.comp.attack', { label: 'att', min: 0, max: 0.2, step: 0.001, format: fmtMs },
      src.comp ? src.comp.attack : 0.006);
    addKnob(row, 'fx.comp.release', { label: 'rel', min: 0.01, max: 1, step: 0.005, format: fmtMs },
      src.comp ? src.comp.release : 0.12);

    // delay ------------------------------------------------------------------------
    row = addRow(panel);
    addLedToggle(row, 'delay', !!(src.delay && src.delay.on),
      () => emit('fx.delay.on', !(src.delay && src.delay.on)));
    addKnob(row, 'fx.delay.division', { label: 'div', min: 1, max: 16, step: 1, format: (v) => `${Math.round(v)}/16` },
      src.delay ? src.delay.division : 3);
    addKnob(row, 'fx.delay.feedback', { label: 'fdbk', min: 0, max: 0.95, step: 0.01, format: fmtPct },
      src.delay ? src.delay.feedback : 0.35);
    addKnob(row, 'fx.delay.mix', { label: 'mix', min: 0, max: 1, step: 0.01, format: fmtPct },
      src.delay ? src.delay.mix : 0.25);

    // reverb -------------------------------------------------------------------------
    row = addRow(panel);
    addLedToggle(row, 'reverb', !!(src.reverb && src.reverb.on),
      () => emit('fx.reverb.on', !(src.reverb && src.reverb.on)));
    addKnob(row, 'fx.reverb.size', { label: 'size', min: 0, max: 1, step: 0.01, format: fmtPct },
      src.reverb ? src.reverb.size : 0.5);
    addKnob(row, 'fx.reverb.mix', { label: 'mix', min: 0, max: 1, step: 0.01, format: fmtPct },
      src.reverb ? src.reverb.mix : 0.2);
  }

  // ---- render / dispose -----------------------------------------------------------

  function render(track, context) {
    clear();
    if (!track) return;

    const head = addPanel();
    const ttl = document.createElement('span');
    ttl.className = 'gp-label';
    ttl.textContent = `${String(track.name ?? '')} · ${String(track.type ?? '')}`;
    head.appendChild(ttl);

    const voicePanel = addPanel();
    const grid = addGrid(voicePanel);

    const lenRow = addRow(voicePanel);
    const lenLabel = document.createElement('span');
    lenLabel.className = 'gp-label';
    lenLabel.textContent = 'LENGTH';
    const lenMinus = document.createElement('button');
    lenMinus.type = 'button';
    lenMinus.className = 'gp-mini';
    lenMinus.textContent = '-';
    lenMinus.setAttribute('aria-label', `Decrease ${track.name} pattern length`);
    const lenVal = document.createElement('span');
    lenVal.className = 'gp-value';
    lenVal.textContent = `${track.length} steps`;
    lenVal.id = 'sb-len-val';
    lenMinus.setAttribute('aria-controls', 'sb-len-val');
    const lenPlus = document.createElement('button');
    lenPlus.type = 'button';
    lenPlus.className = 'gp-mini';
    lenPlus.textContent = '+';
    lenPlus.setAttribute('aria-label', `Increase ${track.name} pattern length`);
    lenPlus.setAttribute('aria-controls', 'sb-len-val');
    const clampLen = (v) => Math.max(1, Math.min(64, v | 0));
    lenMinus.addEventListener('click', () => {
      const next = clampLen(track.length - 1);
      if (next !== track.length) { lenVal.textContent = `${next} steps`; emit('track.length', next); }
    });
    lenPlus.addEventListener('click', () => {
      const next = clampLen(track.length + 1);
      if (next !== track.length) { lenVal.textContent = `${next} steps`; emit('track.length', next); }
    });
    lenRow.append(lenLabel, lenMinus, lenVal, lenPlus);

    if (track.type === 'drum') {
      renderDrum(grid, track.params || {});
    } else if (track.type === 'synth') {
      renderSynth(grid, track.params || {});
    } else if (track.type === 'sampler') {
      renderSampler(voicePanel, grid, track, track.params || {});
    }
    if (track.type !== 'drum') {
      renderKeyScale(voicePanel, context);
    }

    const flow = document.createElement('div');
    flow.className = 'gp-flow';
    flow.textContent = FLOW_TEXT;
    container.appendChild(flow);

    renderFx(addPanel(), track.fx);
  }

  function dispose() {
    clear();
  }

  return { render, dispose };
}
