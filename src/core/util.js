export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential approach. `rate` is roughly "how much of
    the gap closes per second", so 8 is snappy and 1.5 is lazy. */
export const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
export const damp = approach;
export const sign = v => (v < 0 ? -1 : v > 0 ? 1 : 0);
export const wrap01 = t => t - Math.floor(t);
export const moveTowards = (cur, target, maxStep) => {
  const d = target - cur;
  return Math.abs(d) <= maxStep ? target : cur + Math.sign(d) * maxStep;
};
/** Format 87.412 as "1:27.41" — the HUD timer wants this and so do split logs. */
export function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return '--:--.--';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}
