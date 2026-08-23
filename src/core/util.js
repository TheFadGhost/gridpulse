export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
