import { mulberry32, fnv1a } from './rng.js';

export function eventPrng(seed, patternId, trackId, stepIndex, repeat) {
  const label = `ev:${patternId}:${trackId}:${stepIndex}:${repeat}`;
  return mulberry32((seed ^ fnv1a(label)) >>> 0);
}
