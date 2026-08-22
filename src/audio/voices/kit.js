import { mulberry32 } from '../../core/rng.js';
import { makeNoiseBuffer } from '../noise.js';

export const KIT_PIECES = ['kick', 'snare', 'hatClosed', 'hatOpen', 'clap', 'tom'];

const NOISE_SEED = 0x6b6974;
const NOISE_SECONDS = 2;
const EPS = 0.0006;
const RELEASE = 0.01;
const PAD = 0.012;
const NYQ_MARGIN = 0.45;

const HAT_RATIOS = [1, 1.4471, 1.617, 1.9265, 2.5028, 2.6637];

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function pos(v, dflt) {
  return Math.max(1e-4, num(v, dflt));
}
function clamp01(v, dflt) {
  return Math.min(1, Math.max(0, num(v, dflt)));
}

export function createDrumVoice(ctx, destination, piece) {
  if (!KIT_PIECES.includes(piece)) throw new Error(`createDrumVoice: unknown piece "${piece}"`);
  if (!destination) throw new Error('createDrumVoice: destination node required');

  const noiseBuf = makeNoiseBuffer(ctx, NOISE_SECONDS, mulberry32(NOISE_SEED));
  const nyq = ctx.sampleRate * NYQ_MARGIN;
  const live = new Set();

  function trackNode(hit, n) {
    hit.nodes.push(n);
    return n;
  }

  function biquad(hit, type, freq, q) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = Math.min(Math.max(10, freq), nyq);
    if (q != null) f.Q.value = q;
    return trackNode(hit, f);
  }

  function gainNode(hit, v) {
    const g = ctx.createGain();
    g.gain.value = v;
    return trackNode(hit, g);
  }

  function expEnv(param, t0, peak, decay) {
    param.setValueAtTime(Math.max(EPS, peak), t0);
    param.exponentialRampToValueAtTime(EPS, t0 + decay);
    param.linearRampToValueAtTime(0, t0 + decay + RELEASE);
    return t0 + decay + RELEASE + PAD;
  }

  function noiseOffset(prng, needSec) {
    const room = noiseBuf.duration - needSec - PAD;
    return room > 0 ? prng() * room : 0;
  }

  function buildKick(hit, out, t0, p, amp, prng) {
    const pitch = pos(p.pitch, 48);
    const decay = pos(p.decay, 0.42);
    const punch = clamp01(p.punch, 0.7);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(Math.max(20, pitch * (2 + punch * 2)), t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, pitch), t0 + 0.06);
    trackNode(hit, osc);
    const g = gainNode(hit, 0);
    osc.connect(g);
    g.connect(out);
    const end = expEnv(g.gain, t0, 0.95 * amp, decay);
    hit.sources.push(osc);
    hit.stops.push({ node: osc, t: end });

    const hp = biquad(hit, 'highpass', 2000);
    const cg = gainNode(hit, 0);
    const clickEnd = expEnv(cg.gain, t0, Math.max(EPS, 0.5 * punch * amp), 0.008);
    const ns = ctx.createBufferSource();
    ns.buffer = noiseBuf;
    trackNode(hit, ns);
    ns.connect(hp);
    hp.connect(cg);
    cg.connect(out);
    ns.start(t0, noiseOffset(prng, clickEnd - t0));
    hit.sources.push(ns);
    hit.stops.push({ node: ns, t: clickEnd });
    osc.start(t0);

    return Math.max(end, clickEnd);
  }

  function buildSnare(hit, out, t0, p, amp, prng) {
    const tone = pos(p.tone, 180);
    const decay = pos(p.decay, 0.22);
    const snap = clamp01(p.snap, 0.6);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = Math.max(20, tone);
    trackNode(hit, osc);
    const tg = gainNode(hit, 0);
    osc.connect(tg);
    tg.connect(out);
    const toneEnd = expEnv(tg.gain, t0, Math.max(EPS, (1 - snap) * 0.9 * amp), decay * 0.6);
    hit.sources.push(osc);
    hit.stops.push({ node: osc, t: toneEnd });

    const bp = biquad(hit, 'bandpass', 1800, 0.8);
    const ng = gainNode(hit, 0);
    const noiseEnd = expEnv(ng.gain, t0, Math.max(EPS, snap * 0.9 * amp), decay);
    const ns = ctx.createBufferSource();
    ns.buffer = noiseBuf;
    trackNode(hit, ns);
    ns.connect(bp);
    bp.connect(ng);
    ng.connect(out);
    ns.start(t0, noiseOffset(prng, noiseEnd - t0));
    hit.sources.push(ns);
    hit.stops.push({ node: ns, t: noiseEnd });

    osc.start(t0);
    return Math.max(toneEnd, noiseEnd);
  }

  function buildHat(hit, out, t0, p, amp, prng) {
    const tone = pos(p.tone, piece === 'hatOpen' ? 7000 : 8000);
    const decay = pos(p.decay, piece === 'hatOpen' ? 0.32 : 0.05);
    const base = Math.max(30, tone / 40);

    const mix = gainNode(hit, 0.18);
    for (let i = 0; i < HAT_RATIOS.length; i++) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = Math.max(20, base * HAT_RATIOS[i] * (1 + (prng() * 2 - 1) * 0.003));
      trackNode(hit, o);
      o.connect(mix);
      hit.sources.push(o);
      hit.stops.push({ node: o, t: 0 });
    }
    const hp = biquad(hit, 'highpass', tone * 0.6);
    const bp = biquad(hit, 'bandpass', tone * 0.35, 1);
    const g = gainNode(hit, 0);
    mix.connect(hp);
    hp.connect(bp);
    bp.connect(g);
    g.connect(out);
    const end = expEnv(g.gain, t0, 0.9 * amp, decay);
    for (const s of hit.stops) s.t = end;
    for (const src of hit.sources) src.start(t0);
    return end;
  }

  function buildClap(hit, out, t0, p, amp, prng) {
    const tone = pos(p.tone, 1100);
    const decay = pos(p.decay, 0.24);
    const spread = clamp01(p.spread, 0.5);

    const bp = biquad(hit, 'bandpass', tone, 1.5);
    const g = gainNode(hit, 0);
    const ns = ctx.createBufferSource();
    ns.buffer = noiseBuf;
    trackNode(hit, ns);
    ns.connect(bp);
    bp.connect(g);
    g.connect(out);

    const gap = spread * 0.03;
    const pk = Math.max(EPS, 0.85 * amp);
    const gp = g.gain;
    let t = t0;
    for (let i = 0; i < 3; i++) {
      gp.setValueAtTime(pk, t);
      gp.exponentialRampToValueAtTime(Math.max(EPS, pk * 0.12), t + Math.max(0.004, gap * 0.8));
      t += gap;
    }
    gp.setValueAtTime(pk * 0.9, t);
    gp.exponentialRampToValueAtTime(EPS, t + decay);
    gp.linearRampToValueAtTime(0, t + decay + RELEASE);
    const end = t + decay + RELEASE + PAD;

    ns.start(t0, noiseOffset(prng, end - t0));
    hit.sources.push(ns);
    hit.stops.push({ node: ns, t: end });
    return end;
  }

  function buildTom(hit, out, t0, p, amp) {
    const pitch = pos(p.pitch, 120);
    const decay = pos(p.decay, 0.3);
    const drop = Math.max(0, num(p.drop, 0.4));

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(Math.max(20, pitch * Math.pow(2, drop)), t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, pitch), t0 + decay * 0.7);
    trackNode(hit, osc);
    const g = gainNode(hit, 0);
    osc.connect(g);
    g.connect(out);
    const end = expEnv(g.gain, t0, 0.9 * amp, decay);
    hit.sources.push(osc);
    hit.stops.push({ node: osc, t: end });
    osc.start(t0);
    return end;
  }

  function release(hit) {
    if (hit.released) return;
    hit.released = true;
    live.delete(hit);
    for (const n of hit.nodes) {
      try { n.disconnect(); } catch { /* already detached */ }
    }
  }

  function trigger(event, params, prng) {
    if (typeof prng !== 'function') throw new Error('kit.trigger: seeded prng function required');
    const t0 = num(event && event.time, NaN);
    if (!Number.isFinite(t0)) throw new Error('kit.trigger: event.time (absolute audio seconds) required');
    const velRaw = num(event && event.velocity, 0.8);
    const vel = Math.min(1, Math.max(0, velRaw));
    const amp = Math.pow(vel, 1.5);
    const p = params || {};

    const hit = { nodes: [], sources: [], stops: [], released: false };
    live.add(hit);

    const bus = ctx.createGain();
    bus.gain.value = 1;
    hit.nodes.push(bus);
    bus.connect(destination);

    switch (piece) {
      case 'kick': buildKick(hit, bus, t0, p, amp, prng); break;
      case 'snare': buildSnare(hit, bus, t0, p, amp, prng); break;
      case 'hatClosed':
      case 'hatOpen': buildHat(hit, bus, t0, p, amp, prng); break;
      case 'clap': buildClap(hit, bus, t0, p, amp, prng); break;
      case 'tom': buildTom(hit, bus, t0, p, amp); break;
    }

    let lastT = t0;
    let lastSrc = null;
    for (const s of hit.stops) {
      try { s.node.stop(s.t); } catch { /* already stopped */ }
      if (s.t > lastT) {
        lastT = s.t;
        lastSrc = s.node;
      }
    }
    if (lastSrc) lastSrc.onended = () => release(hit);
    else release(hit);

    return { end: lastT };
  }

  function dispose() {
    for (const hit of Array.from(live)) {
      hit.released = true;
      for (const s of hit.stops) {
        s.node.onended = null;
        try { s.node.stop(0); } catch { /* already stopped */ }
      }
      for (const n of hit.nodes) {
        try { n.disconnect(); } catch { /* already detached */ }
      }
    }
    live.clear();
  }

  return { trigger, dispose };
}
