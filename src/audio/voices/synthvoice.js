import { SYNTH_DEFAULTS } from '../../core/model.js';
import { clamp } from '../../core/util.js';
export const SYNTH_WAVES = ['sine', 'triangle', 'sawtooth', 'square', 'supersaw'];
const SUPERSAW_SPREAD_CENTS = [0, -7, 7, -12, 12, -19, 19];
const SUPER_OSC_GAIN = 1 / Math.sqrt(7);
const DEFAULT_GATE_SECONDS = 0.25;
const num = (v, dflt) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}
function envValueAt(g, t) {
  if (!(t > g.t0)) return 0;
  const aEnd = g.t0 + g.attack;
  if (t < aEnd) return g.peak * ((t - g.t0) / g.attack);
  const tauD = Math.max(g.decay / 3, 1e-3);
  let v = g.susPeak + (g.peak - g.susPeak) * Math.exp(-(t - aEnd) / tauD);
  if (t <= g.gateEnd) return v;
  const tauR = Math.max(g.release / 3, 1e-3);
  return v * Math.exp(-(t - g.gateEnd) / tauR);
}
export function createSynthVoice(ctx, destination) {
  const out = destination || ctx.destination;
  const active = new Set();
  let lastFreq = 0;
  let lastGateEnd = -Infinity;
  function fastFadeAtNow(g, now) {
    const gain = g.amp.gain;
    try {
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(clamp(envValueAt(g, now), 0, 2), now);
      gain.setTargetAtTime(0, now, 0.01);
    } catch (err) {}
    g.gateEnd = Math.min(g.gateEnd, now);
  }
  function stealAt(g, t) {
    if (g.gateEnd <= t) return;
    const gain = g.amp.gain;
    try {
      gain.cancelScheduledValues(t);
      gain.setValueAtTime(clamp(envValueAt(g, t), 0, 2), t);
      gain.setTargetAtTime(0, t, 0.012);
    } catch (err) {}
    g.gateEnd = Math.min(g.gateEnd, t);
  }
  function trigger(event, params, prng) {
    if (!event || typeof event.time !== 'number' || !Number.isFinite(event.time)) return;
    if (event.note == null) return;
    const note = clamp(Math.round(event.note), 0, 127);
    if (!Number.isFinite(note)) return;
    const t0 = Math.max(event.time, 0);
    const p = { ...SYNTH_DEFAULTS, ...(params || {}) };
    const wave = SYNTH_WAVES.indexOf(p.wave) >= 0 ? p.wave : SYNTH_DEFAULTS.wave;
    const detune = clamp(num(p.detune, SYNTH_DEFAULTS.detune), 0, 50);
    const glide = clamp(num(p.glide, SYNTH_DEFAULTS.glide), 0, 0.3);
    const attack = clamp(num(p.attack, SYNTH_DEFAULTS.attack), 0.001, 2);
    const decay = clamp(num(p.decay, SYNTH_DEFAULTS.decay), 0.001, 4);
    const sustain = clamp(num(p.sustain, SYNTH_DEFAULTS.sustain), 0, 1);
    const release = clamp(num(p.release, SYNTH_DEFAULTS.release), 0.01, 4);
    const nyquist = ctx.sampleRate * 0.45;
    const cutoff = clamp(num(p.cutoff, SYNTH_DEFAULTS.cutoff), 30, Math.min(20000, nyquist));
    const resonance = clamp(num(p.resonance, SYNTH_DEFAULTS.resonance), 0, 24);
    const envMod = clamp(num(p.envMod, SYNTH_DEFAULTS.envMod), 0, 8);
    const fEnvDecay = clamp(num(p.fEnvDecay, SYNTH_DEFAULTS.fEnvDecay), 0.005, 4);
    const vel = clamp(num(event.velocity, 0.8), 0, 1);
    const peak = Math.pow(vel, 1.5) * 0.5;
    const susPeak = sustain * peak;
    const gateEnd = Math.max(
      t0 + attack + 0.002,
      t0 + Math.max(num(event.gateSeconds, DEFAULT_GATE_SECONDS), 0.005)
    );
    const freq = midiToFreq(note);
    const legato = glide > 0 && lastFreq > 0 && lastGateEnd > t0;
    if (glide > 0) {
      for (const g of Array.from(active)) stealAt(g, t0);
    }
    const startFreq = legato ? lastFreq : freq;
    const tauD = Math.max(decay / 3, 1e-3);
    const tauR = Math.max(release / 3, 1e-3);
    const endTime = gateEnd + release * 3 + 0.02;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = resonance;
    filter.frequency.setValueAtTime(clamp(cutoff * envMod, cutoff, nyquist), t0);
    filter.frequency.exponentialRampToValueAtTime(cutoff, t0 + fEnvDecay);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t0);
    amp.gain.linearRampToValueAtTime(peak, t0 + attack);
    amp.gain.setTargetAtTime(susPeak, t0 + attack, tauD);
    amp.gain.setTargetAtTime(0, gateEnd, tauR);
    filter.connect(amp);
    amp.connect(out);
    const group = { oscs: [], amp, t0, attack, decay, release, peak, susPeak, gateEnd };
    let bus = filter;
    if (wave === 'supersaw') {
      bus = ctx.createGain();
      bus.gain.value = SUPER_OSC_GAIN;
      bus.connect(filter);
    }
    const specs = [];
    if (wave === 'supersaw') {
      for (const c of SUPERSAW_SPREAD_CENTS) {
        specs.push({ type: 'sawtooth', detune: c === 0 ? 0 : Math.sign(c) * (Math.abs(c) + detune) });
      }
    } else {
      specs.push({ type: wave, detune });
    }
    for (const spec of specs) {
      const osc = ctx.createOscillator();
      osc.type = spec.type;
      osc.detune.value = spec.detune;
      osc.frequency.setValueAtTime(startFreq, t0);
      if (legato && startFreq !== freq) {
        osc.frequency.exponentialRampToValueAtTime(freq, t0 + glide);
      }
      osc.connect(bus);
      osc.start(t0);
      osc.stop(endTime);
      osc.onended = () => {
        try { osc.disconnect(); } catch (err) {}
      };
      group.oscs.push(osc);
    }
    group.oscs[0].addEventListener('ended', () => {
      try { if (bus !== filter) bus.disconnect(); } catch (err) {}
      try { filter.disconnect(); } catch (err) {}
      try { amp.disconnect(); } catch (err) {}
      active.delete(group);
    });
    lastFreq = freq;
    lastGateEnd = gateEnd;
    active.add(group);
  }
  function releaseAll() {
    const now = ctx.currentTime;
    for (const g of Array.from(active)) fastFadeAtNow(g, now);
  }
  function dispose() {
    const now = ctx.currentTime;
    for (const g of Array.from(active)) {
      fastFadeAtNow(g, now);
      try { g.amp.disconnect(); } catch (err) {}
    }
    active.clear();
    lastFreq = 0;
    lastGateEnd = -Infinity;
  }
  return { trigger, releaseAll, dispose };
}
