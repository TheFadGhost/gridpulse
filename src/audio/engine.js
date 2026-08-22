import { createSharedReturns, createTrackFX } from './fx.js';

const IDLE_SUSPEND_MS = 30000;
const MASTER_GAIN = 0.9;

let instance = null;

export function createEngine() {
  if (instance) return instance.promise;

  let disposed = false;
  let ctx = null;
  let returns = null;
  const channels = new Map();
  const listeners = new Set();
  let idleTimer = null;
  let lastState = 'created';

  function ensure() {
    if (ctx) return;
    ctx = new AudioContext();

    returns = createSharedReturns(ctx);
    returns.output.connect(masterComp());

    lastState = 'suspended';
    emit(lastState);
    ctx.onstatechange = () => {
      const s = state();
      if (s !== lastState) {
        lastState = s;
        emit(s);
      }
    };
  }

  const masterComp_ = { node: null };
  const masterGain_ = { node: null };
  const masterAnalyser_ = { node: null };

  function masterComp() {
    if (!masterComp_.node) {
      masterComp_.node = ctx.createDynamicsCompressor();
      masterComp_.node.threshold.value = -6;
      masterComp_.node.ratio.value = 12;
      masterComp_.node.knee.value = 6;
      masterComp_.node.attack.value = 0.003;
      masterComp_.node.release.value = 0.1;
      masterGain_.node = ctx.createGain();
      masterGain_.node.gain.value = MASTER_GAIN;
      masterAnalyser_.node = ctx.createAnalyser();
      masterAnalyser_.node.fftSize = 512;
      masterAnalyser_.node.smoothingTimeConstant = 0;
      masterComp_.node.connect(masterGain_.node);
      masterGain_.node.connect(masterAnalyser_.node);
      masterAnalyser_.node.connect(ctx.destination);
    }
    return masterComp_.node;
  }

  function emit(s) {
    listeners.forEach((cb) => {
      try { cb(s); } catch (_) {}
    });
  }

  function clearIdle() {
    if (idleTimer != null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function notifyTransportStopped() {
    clearIdle();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
    }, IDLE_SUSPEND_MS);
  }

  function notifyTransportStarted() {
    clearIdle();
  }

  async function suspend() {
    clearIdle();
    if (ctx && ctx.state === 'running') await ctx.suspend();
  }

  async function resume() {
    clearIdle();
    if (ctx && ctx.state === 'suspended') await ctx.resume();
  }

  function state() {
    if (!ctx) return 'created';
    switch (ctx.state) {
      case 'running': return 'running';
      case 'suspended': return 'suspended';
      case 'closed': return 'closed';
      default: return 'created';
    }
  }

  function onStateChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    instance = null;
    clearIdle();
    channels.forEach((fx) => fx.dispose());
    channels.clear();
    if (returns) returns.dispose();
    if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => {});
    ctx = null;
    returns = null;
  }

  const promise = (async () => {
    ensure();
    return {
      get ctx() { return ctx; },
      get returns() { return returns; },
      channels,
      addChannel(trackId) {
        if (!returns) throw new Error('engine: not initialized');
        if (channels.has(trackId)) return channels.get(trackId);
        const fx = createTrackFX(ctx, returns);
        fx.out.connect(returns.masterIn);
        channels.set(trackId, fx);
        return fx;
      },
      removeChannel(trackId) {
        const fx = channels.get(trackId);
        if (!fx) return;
        try { fx.out.disconnect(); } catch (_) {}
        fx.dispose();
        channels.delete(trackId);
      },
      channelFor(trackId) {
        return channels.get(trackId) || null;
      },
      masterMeter() {
        if (!masterAnalyser_.node) return { peak: 0, rms: 0 };
        const buf = new Float32Array(masterAnalyser_.node.fftSize);
        masterAnalyser_.node.getFloatTimeDomainData(buf);
        let peak = 0;
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const x = buf[i];
          const a = Math.abs(x);
          if (a > peak) peak = a;
          sum += x * x;
        }
        return { peak, rms: Math.sqrt(sum / buf.length) };
      },
      notifyTransportStarted,
      notifyTransportStopped,
      suspend,
      resume,
      state,
      onStateChange,
      dispose
    };
  })();

  instance = { promise };
  return promise;
}
