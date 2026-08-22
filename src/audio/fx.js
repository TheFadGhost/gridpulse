import { mulberry32 } from '../core/rng.js';

const REVERB_SEED = 0x5eed;
const SMOOTH_TC = 0.01;
const DELAY_MAX = 2;
const DELAY_MIN = 0.01;
const FEEDBACK_MAX = 0.95;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function buildDriveCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = amount * 6;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x);
  }
  return curve;
}

function smooth(param, value, ctx) {
  param.setTargetAtTime(value, ctx.currentTime, SMOOTH_TC);
}

function gainNode(ctx, g) {
  const n = ctx.createGain();
  n.gain.value = g;
  return n;
}

export function createSharedReturns(ctx) {
  let disposed = false;

  const masterIn = gainNode(ctx, 1);
  const output = gainNode(ctx, 1);

  const delayIn = gainNode(ctx, 1);
  const delayNode = ctx.createDelay(DELAY_MAX);
  const delayFb = gainNode(ctx, 0);
  const delayWet = gainNode(ctx, 0);

  const reverbIn = gainNode(ctx, 1);
  const convolver = ctx.createConvolver();
  convolver.normalize = true;
  const reverbWet = gainNode(ctx, 0);

  delayIn.connect(delayNode);
  delayNode.connect(delayFb);
  delayFb.connect(delayNode);
  delayNode.connect(delayWet);
  delayWet.connect(output);

  reverbIn.connect(convolver);
  convolver.connect(reverbWet);
  reverbWet.connect(output);

  masterIn.connect(output);

  let bpm = 120;
  let div16ths = 3;
  let irSize = null;

  function delaySeconds() {
    return clamp((div16ths * (60 / bpm)) / 4, DELAY_MIN, DELAY_MAX);
  }

  function applyDelayTime() {
    smooth(delayNode.delayTime, delaySeconds(), ctx);
  }

  function makeIR(size) {
    const lengthSec = 0.3 + size * 2.7;
    const sampleRate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(lengthSec * sampleRate));
    const buf = ctx.createBuffer(2, len, sampleRate);
    const rngL = mulberry32(REVERB_SEED);
    const rngR = mulberry32((REVERB_SEED ^ 0x9e3779b9) >>> 0);
    const earlyEnd = len * 0.1;
    const tau = lengthSec / 6;
    for (let ch = 0; ch < 2; ch++) {
      const rng = ch === 0 ? rngL : rngR;
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / sampleRate;
        let env = Math.exp(-t / tau);
        if (i < earlyEnd) env *= 1 + 1.5 * (1 - i / earlyEnd);
        data[i] = (rng() * 2 - 1) * env;
      }
      let peak = 0;
      for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(data[i]));
      if (peak > 0) {
        const s = 0.5 / peak;
        for (let i = 0; i < len; i++) data[i] *= s;
      }
    }
    return buf;
  }

  function applyIR(size) {
    if (irSize === size && convolver.buffer) return;
    irSize = size;
    convolver.buffer = makeIR(size);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    [
      masterIn, output,
      delayIn, delayNode, delayFb, delayWet,
      reverbIn, convolver, reverbWet
    ].forEach((n) => { try { n.disconnect(); } catch (_) {} });
  }

  applyDelayTime();

  return {
    masterIn,
    output,
    delayIn,
    reverbIn,
    setBpm(value) {
      bpm = clamp(Number(value) || 120, 20, 333);
      applyDelayTime();
    },
    setDelayDivision(divs) {
      div16ths = clamp(Number(divs) || 0, DELAY_MIN, 64);
      applyDelayTime();
    },
    setDelay(feedback, mix) {
      smooth(delayFb.gain, clamp(feedback, 0, FEEDBACK_MAX), ctx);
      smooth(delayWet.gain, clamp(mix, 0, 1), ctx);
    },
    setReverb(size, mix) {
      applyIR(clamp(size, 0, 1));
      smooth(reverbWet.gain, clamp(mix, 0, 1), ctx);
    },
    dispose
  };
}

export function createTrackFX(ctx, returns) {
  let disposed = false;

  const input = gainNode(ctx, 1);

  const driveDry = gainNode(ctx, 0);
  const driveWet = gainNode(ctx, 0);
  const shaper = ctx.createWaveShaper();
  shaper.curve = buildDriveCurve(0.5);
  shaper.oversample = '2x';

  input.connect(driveDry);
  input.connect(shaper);
  shaper.connect(driveWet);

  const filter = ctx.createBiquadFilter();
  driveDry.connect(filter);
  driveWet.connect(filter);

  const comp = ctx.createDynamicsCompressor();
  filter.connect(comp);

  const makeup = gainNode(ctx, 1);
  comp.connect(makeup);

  const delaySend = gainNode(ctx, 0);
  const reverbSend = gainNode(ctx, 0);
  makeup.connect(delaySend);
  makeup.connect(reverbSend);
  delaySend.connect(returns.delayIn);
  reverbSend.connect(returns.reverbIn);

  const panner = ctx.createStereoPanner();
  makeup.connect(panner);

  const fader = gainNode(ctx, 1);
  panner.connect(fader);

  const out = gainNode(ctx, 1);
  fader.connect(out);

  const meterAn = ctx.createAnalyser();
  meterAn.fftSize = 512;
  meterAn.smoothingTimeConstant = 0;
  fader.connect(meterAn);

  const meterBuf = new Float32Array(meterAn.fftSize);

  let volume = 0.8;
  let mute = false;
  let solo = false;
  let anySolo = false;

  function applyFader() {
    const eff = mute || (!solo && anySolo) ? 0 : volume;
    smooth(fader.gain, clamp(eff, 0, 1.2), ctx);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    [
      input, driveDry, driveWet, shaper, filter, comp, makeup,
      delaySend, reverbSend, panner, fader, out, meterAn
    ].forEach((n) => { try { n.disconnect(); } catch (_) {} });
  }

  return {
    input,
    out,
    setFX(fx = {}) {
      const drive = fx.drive || {};
      const amt = clamp(Number(drive.amount) || 0, 0, 1);
      if (drive.on) {
        shaper.curve = buildDriveCurve(amt);
        smooth(driveDry.gain, 0, ctx);
        smooth(driveWet.gain, 1, ctx);
      } else {
        smooth(driveDry.gain, 1, ctx);
        smooth(driveWet.gain, 0, ctx);
      }

      const flt = fx.filter || {};
      if (flt.on) {
        filter.type = ['lowpass', 'highpass', 'bandpass'].includes(flt.type)
          ? flt.type
          : 'lowpass';
        smooth(filter.frequency, clamp(Number(flt.cutoff) || 8000, 30, 18000), ctx);
        smooth(filter.Q, Number(flt.q) || 0.7, ctx);
      } else {
        filter.type = 'allpass';
      }

      const cp = fx.comp || {};
      if (cp.on) {
        const ratio = clamp(Number(cp.ratio) || 3, 1, 20);
        comp.threshold.value = clamp(Number(cp.threshold) || -18, -100, 0);
        comp.ratio.value = ratio;
        comp.knee.value = 12;
        comp.attack.value = clamp(Number(cp.attack) || 0.006, 0, 1);
        comp.release.value = clamp(Number(cp.release) || 0.12, 0, 1);
        smooth(makeup.gain, 1 + (ratio - 1) * 0.08, ctx);
      } else {
        comp.threshold.value = 0;
        comp.ratio.value = 1;
        comp.knee.value = 0;
        smooth(makeup.gain, 1, ctx);
      }

      const dl = fx.delay || {};
      const dMix = dl.on ? clamp(Number(dl.mix) || 0, 0, 1) : 0;
      smooth(delaySend.gain, dMix, ctx);

      const rv = fx.reverb || {};
      const rMix = rv.on ? clamp(Number(rv.mix) || 0, 0, 1) : 0;
      smooth(reverbSend.gain, rMix, ctx);
    },
    setMixer({ volume: v = 0.8, pan = 0, mute: m = false, solo: s = false } = {}) {
      volume = clamp(v, 0, 1.2);
      mute = !!m;
      solo = !!s;
      smooth(panner.pan, clamp(pan, -1, 1), ctx);
      applyFader();
    },
    applySolo(anySoloActive) {
      anySolo = !!anySoloActive;
      applyFader();
    },
    meter() {
      meterAn.getFloatTimeDomainData(meterBuf);
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < meterBuf.length; i++) {
        const x = meterBuf[i];
        const a = Math.abs(x);
        if (a > peak) peak = a;
        sum += x * x;
      }
      return { peak, rms: Math.sqrt(sum / meterBuf.length) };
    },
    dispose
  };
}
