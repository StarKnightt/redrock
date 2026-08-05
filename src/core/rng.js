/* Deterministic noise. Every world in this game is a pure function of a seed,
   so a screenshot taken today can be reproduced tomorrow. */

/** mulberry32 — small, fast, good enough distribution for scattering rocks. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Range helpers built on a generator, so call sites read as intent. */
export function rand(r) {
  return {
    f: (lo = 0, hi = 1) => lo + r() * (hi - lo),
    i: (lo, hi) => Math.floor(lo + r() * (hi - lo + 1)),
    sign: () => (r() < 0.5 ? -1 : 1),
    pick: arr => arr[Math.floor(r() * arr.length) % arr.length],
    chance: p => r() < p,
    /* Sum of three uniforms — a cheap bell curve. Scattering with this puts
       most rocks near the median size instead of an even spread, which is what
       a real talus field looks like. */
    bell: (lo, hi) => lo + ((r() + r() + r()) / 3) * (hi - lo),
  };
}

/** Classic value noise in 1D — smooth, seeded, cheap. For grade and width
    profiles where Perlin would be overkill. */
export function noise1(seed = 1) {
  const r = rng(seed);
  const tab = new Float32Array(512);
  for (let i = 0; i < 512; i++) tab[i] = r() * 2 - 1;
  return x => {
    const i = Math.floor(x), f = x - i;
    const s = f * f * (3 - 2 * f);
    const a = tab[((i % 512) + 512) % 512];
    const b = tab[(((i + 1) % 512) + 512) % 512];
    return a + (b - a) * s;
  };
}

/** Fractal sum of noise1 — used for canyon wall silhouettes. */
export function fbm1(seed = 1, octaves = 4) {
  const n = noise1(seed);
  return x => {
    let v = 0, amp = 0.5, f = 1;
    for (let o = 0; o < octaves; o++) { v += n(x * f) * amp; f *= 2.03; amp *= 0.5; }
    return v;
  };
}

/** 2D value noise. Wall displacement and ground colour variation. */
export function noise2(seed = 1) {
  const r = rng(seed);
  const N = 256;
  const tab = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) tab[i] = r();
  const at = (x, y) => tab[(((y % N) + N) % N) * N + (((x % N) + N) % N)];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
  };
}

export function fbm2(seed = 1, octaves = 4) {
  const n = noise2(seed);
  return (x, y) => {
    let val = 0, amp = 0.5, f = 1;
    for (let o = 0; o < octaves; o++) { val += n(x * f, y * f) * amp; f *= 2.07; amp *= 0.5; }
    return val;
  };
}
