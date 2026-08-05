/* The distribution of the paint noise, measured rather than assumed.
   `fbm2` sums `noise2`, and `noise2` is built from `rng()`, which returns
   [0, 1) — so three octaves land in [0, 0.875] with a mean near 0.44, not in
   [-1, 1] with a mean of zero. Every threshold in the landform painter was set
   against the wrong distribution, which is why whole hillsides come back as a
   single palette entry. This prints the quantiles the thresholds should be
   placed on. */
import { fbm2 } from '../src/core/rng.js';

const paint = fbm2(73 * 22 + 17, 3);
const cases = {
  'wallPatch  a + 0.40b': (s, c) =>
    paint(s / 41 + 31, c * 0.85 + 13) + paint(s / 17 + 7, c * 1.9 + 41) * 0.4,
  'backSlope  a + 0.45b': (s, c) =>
    paint(s / 96 + 23, c * 0.5 + 61) + paint(s / 31 + 41, c * 1.3 + 7) * 0.45,
  'single fbm2': (s, c) => paint(s / 38 + 19, c * 0.61 + 7),
};

for (const [name, f] of Object.entries(cases)) {
  const xs = [];
  for (let s = 0; s < 5600; s += 3) for (let c = 6; c < 16; c++) xs.push(f(s, c));
  xs.sort((a, b) => a - b);
  const q = p => xs[Math.floor(p * (xs.length - 1))].toFixed(3);
  console.log(`  ${name.padEnd(22)} min ${q(0)}  p20 ${q(0.2)}  p40 ${q(0.4)}`
    + `  p50 ${q(0.5)}  p60 ${q(0.6)}  p80 ${q(0.8)}  max ${q(1)}`);
}
