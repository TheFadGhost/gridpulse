export function makeNoiseBuffer(ctx, seconds, prng) {
  if (!ctx || typeof ctx.sampleRate !== 'number' || !(ctx.sampleRate > 0)) {
    throw new TypeError('makeNoiseBuffer: ctx with numeric sampleRate required');
  }
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new TypeError('makeNoiseBuffer: seconds must be a finite number > 0');
  }
  if (typeof prng !== 'function') {
    throw new TypeError('makeNoiseBuffer: prng function required');
  }
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.ceil(sampleRate * seconds));
  let channels = 1;
  try {
    const dest = ctx.destination;
    const cap = dest && (dest.maxChannelCount != null ? dest.maxChannelCount : dest.channelCount);
    channels = Math.min(2, Math.max(1, cap || 1));
  } catch {
    channels = 1;
  }
  const buf = ctx.createBuffer(channels, length, sampleRate);
  for (let c = 0; c < channels; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < length; i++) {
      data[i] = prng() * 2 - 1;
    }
  }
  return buf;
}
