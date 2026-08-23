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
  const reverbPre = ctx.createDelay(0.2);
  reverbPre.delayTime.value = 0.02;
  const reverbWet = gainNode(ctx, 0);

  delayIn.connect(delayNode);
  delayNode.connect(delayFb);
  delayFb.connect(delayNode);
  delayNode.connect(delayWet);
  delayWet.connect(output);

  masterIn.connect(output);

  const COMB_BASE = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const ALLPASS_BASE = [556, 441, 341, 225];
  const srScale = ctx.sampleRate / 44100;
  reverbIn.connect(reverbPre);
  const combFbs = [];
  const combDamps = [];
  const combSum = gainNode(ctx, 1 / COMB_BASE.length);
  for (let i = 0; i < COMB_BASE.length; i++) {
    const d = ctx.createDelay(0.2);
    d.delayTime.value = Math.min(0.19, (COMB_BASE[i] * srScale) / ctx.sampleRate);
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 4500;
    const fb = gainNode(ctx, 0.82);
    reverbPre.connect(d);
    d.connect(damp);
    damp.connect(fb);
    fb.connect(d);
    damp.connect(combSum);
    combFbs.push(fb);
    combDamps.push(damp);
  }
  let apTail = combSum;
  for (let i = 0; i < ALLPASS_BASE.length; i++) {
    const d = ctx.createDelay(0.05);
    d.delayTime.value = Math.min(0.049, (ALLPASS_BASE[i] * srScale) / ctx.sampleRate);
    const g = gainNode(ctx, 0.7);
    apTail.connect(d);
    d.connect(g);
    g.connect(apTail);
    apTail = d;
  }
  const apOut = gainNode(ctx, 1);
  apTail.connect(apOut);
  const widthL = gainNode(ctx, 1);
  const widthRD = ctx.createDelay(0.05);
  widthRD.delayTime.value = Math.min(0.049, (23 * srScale) / ctx.sampleRate);
  apOut.connect(widthL);
  apOut.connect(widthRD);
  widthL.connect(reverbWet);
  widthRD.connect(reverbWet);
  reverbWet.connect(output);

  let bpm = 120;
  let div16ths = 3;

  function delaySeconds() {
    return clamp((div16ths * (60 / bpm)) / 4, DELAY_MIN, DELAY_MAX);
  }

  function applyDelayTime() {
    smooth(delayNode.delayTime, delaySeconds(), ctx);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    [
      masterIn, output,
      delayIn, delayNode, delayFb, delayWet,
      reverbIn, reverbPre, combSum, apOut, widthL, reverbWet
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
      const s = clamp(size, 0, 1);
      const fb = 0.72 + s * 0.18;
      const dampHz = 5200 - s * 3400;
      for (let i = 0; i < combFbs.length; i++) smooth(combFbs[i].gain, fb - i * 0.004, ctx);
      for (let i = 0; i < combDamps.length; i++) combDamps[i].frequency.value = dampHz;
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
        comp.threshold.value = -10;
        comp.ratio.value = 1;
        comp.knee.value = 24;
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
