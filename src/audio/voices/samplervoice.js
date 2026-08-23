import { SAMPLER_DEFAULTS } from '../../core/model.js';
import { clamp } from '../../core/util.js';
const num = (v, dflt) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
function reverseBuffer(ctx, buffer) {
  const reversed = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = new Float32Array(src.length);
    for (let i = 0, n = src.length; i < n; i++) {
      dst[i] = src[n - 1 - i];
    }
    reversed.copyToChannel(dst, ch);
  }
  return reversed;
}
export function createSamplerVoice(ctx, destination) {
  const out = destination || ctx.destination;
  let buffer = null;
  let reversedBuffer = null;
  const active = new Set();
  function setBuffer(next) {
    if (!next || typeof next.getChannelData !== 'function') {
      buffer = null;
      reversedBuffer = null;
      return;
    }
    buffer = next;
    reversedBuffer = reverseBuffer(ctx, next);
  }
  function hasBuffer() {
    return !!buffer;
  }
  function trigger(event, params, prng) {
    void prng;
    if (!buffer) return;
    if (!params || typeof params !== 'object') return;
    if (!event || typeof event.time !== 'number' || !Number.isFinite(event.time)) return;
    const gain = clamp(num(params.gain, SAMPLER_DEFAULTS.gain), 0, 4);
    const tune = clamp(num(params.tune, SAMPLER_DEFAULTS.tune), -48, 48);
    const start = clamp(num(params.start, SAMPLER_DEFAULTS.start), 0, 1);
    const end = clamp(num(params.end, SAMPLER_DEFAULTS.end), 0, 1);
    const reverse = !!params.reverse;
    if (start >= end) return;
    const sourceBuffer = reverse ? reversedBuffer : buffer;
    const duration = sourceBuffer.duration;
    const offset = start * duration;
    const dur = Math.max(0.001, end - start) * duration;
    const t0 = event.time;
    const source = ctx.createBufferSource();
    source.buffer = sourceBuffer;
    source.playbackRate.value = Math.pow(2, tune / 12);
    const amp = ctx.createGain();
    const vel = clamp(num(event.velocity, 1), 0, 1);
    amp.gain.value = Math.pow(vel, 1.5) * gain;
    source.connect(amp);
    amp.connect(out);
    const entry = { source, amp };
    active.add(entry);
    source.onended = () => {
      active.delete(entry);
      try { source.disconnect(); } catch (err) {}
      try { amp.disconnect(); } catch (err) {}
    };
    try {
      source.start(t0, offset, dur);
      source.stop(t0 + dur + 0.005);
    } catch (err) {
      active.delete(entry);
      try { source.disconnect(); } catch (e) {}
      try { amp.disconnect(); } catch (e) {}
    }
  }
  function dispose() {
    for (const entry of Array.from(active)) {
      try { entry.source.stop(); } catch (err) {}
      try { entry.source.disconnect(); } catch (err) {}
      try { entry.amp.disconnect(); } catch (err) {}
    }
    active.clear();
    buffer = null;
    reversedBuffer = null;
  }
  return { setBuffer, hasBuffer, trigger, dispose };
}
