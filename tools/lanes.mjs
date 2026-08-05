/* Can two cars race side by side?
 *
 * Width in metres is not the question the user asked. The question is whether
 * there is room for two cars abreast with enough air between them that neither
 * driver is thinking about the other's door — on a straight, and again through
 * a corner, where the racing line has already eaten most of the road.
 *
 * So this measures capacity, not tape. For every frame it works out how many
 * car widths fit inside the band the AI will actually use, and reports the
 * fraction of the stage that clears the bar. The bar itself is stated in car
 * widths rather than metres so it survives anyone changing the car.
 *
 *   node tools/lanes.mjs [--seeds 32] [--gap 1.0]
 *
 * --gap is the air between the two cars, in car widths. 1.0 reads
 * "comfortably" as a whole car of daylight, which is the reading the request
 * suggests and the one the defaults use.
 */
import { Track } from '../src/world/track.js';
import { CAR } from '../src/car/mesh.js';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = +flag('seeds', 32);
const GAP_CARS = +flag('gap', 1.0);
const VERBOSE = args.includes('--list');

/* The AI's own margin, from Driver.targetLat. `usable` is the half-band the
   racing line is clamped into; containment starts biting 0.4 m outside it.
   These are read as the definition of "on the road" because they are what the
   cars actually obey — the tarmac outside them is scenery the bot declines to
   use. Kept in one place here so a change to the driver shows up as a changed
   measurement rather than as a stale one. */
const USABLE_INSET = 2.6;

const W = CAR.width;
/* Two cars plus the air between them. */
const NEED = 2 * W + GAP_CARS * W;

/** Straight, corner or tight, by curvature — the three regimes width means
    different things in. Radius, not curvature, because radius is legible. */
function regime(curv) {
  const R = 1 / Math.max(Math.abs(curv), 1e-6);
  if (R > 400) return 'straight';
  if (R > 110) return 'corner';
  return 'tight';
}

const rows = [];
const perSeed = [];

for (let k = 0; k < SEEDS; k++) {
  const seed = 7 + k;
  const track = new Track(seed);
  const buckets = {
    straight: { n: 0, ok: 0, w: [], u: [] },
    corner: { n: 0, ok: 0, w: [], u: [] },
    tight: { n: 0, ok: 0, w: [], u: [] },
  };
  let minW = Infinity, maxW = -Infinity, sumW = 0, n = 0;

  for (const f of track.frames) {
    const usable = 2 * (f.width * 0.5 - USABLE_INSET);   // full band, not half
    const b = buckets[regime(f.curv)];
    b.n++;
    if (usable >= NEED) b.ok++;
    b.w.push(f.width);
    b.u.push(usable);
    minW = Math.min(minW, f.width);
    maxW = Math.max(maxW, f.width);
    sumW += f.width; n++;
    rows.push({ seed, s: f.s, width: f.width, usable, reg: regime(f.curv) });
  }
  perSeed.push({ seed, minW, maxW, meanW: sumW / n, buckets });
}

const q = (a, p) => {
  const b = [...a].sort((x, y) => x - y);
  return b[Math.min(b.length - 1, Math.floor(p * b.length))];
};

const all = rows.map(r => r.width);
const allU = rows.map(r => r.usable);

console.log(`car ${W.toFixed(2)} m wide; "comfortable" = 2 cars + ${GAP_CARS.toFixed(2)}`
  + ` car of air = ${NEED.toFixed(2)} m of usable band needed`);
console.log(`AI usable band = width - ${(2 * USABLE_INSET).toFixed(1)} m`
  + ` (Driver.targetLat inset ${USABLE_INSET} m per side)\n`);

console.log(`across ${SEEDS} seeds, ${rows.length} frames`);
console.log(`  width   min ${q(all, 0).toFixed(2)}  p05 ${q(all, 0.05).toFixed(2)}`
  + `  median ${q(all, 0.5).toFixed(2)}  mean ${(all.reduce((a, b) => a + b, 0) / all.length).toFixed(2)}`
  + `  p95 ${q(all, 0.95).toFixed(2)}  max ${q(all, 0.999).toFixed(2)}`);
console.log(`  usable  min ${q(allU, 0).toFixed(2)}  p05 ${q(allU, 0.05).toFixed(2)}`
  + `  median ${q(allU, 0.5).toFixed(2)}  mean ${(allU.reduce((a, b) => a + b, 0) / allU.length).toFixed(2)}`
  + `  p95 ${q(allU, 0.95).toFixed(2)}  max ${q(allU, 0.999).toFixed(2)}\n`);

console.log('  regime      frames   two-abreast   median w   median usable');
for (const key of ['straight', 'corner', 'tight']) {
  let n = 0, ok = 0, w = [], u = [];
  for (const p of perSeed) {
    n += p.buckets[key].n; ok += p.buckets[key].ok;
    w.push(...p.buckets[key].w); u.push(...p.buckets[key].u);
  }
  if (!n) { console.log(`  ${key.padEnd(10)}       0`); continue; }
  console.log(`  ${key.padEnd(10)} ${String(n).padStart(7)}   ${(100 * ok / n).toFixed(1).padStart(9)}%`
    + `   ${q(w, 0.5).toFixed(2).padStart(8)}   ${q(u, 0.5).toFixed(2).padStart(13)}`);
}

const totalOk = rows.filter(r => r.usable >= NEED).length;
console.log(`\n  whole stage: ${(100 * totalOk / rows.length).toFixed(1)}% of frames take two abreast comfortably`);

/* The worst seed is the one that decides whether the feature exists, since the
   player only ever drives one. */
const worst = perSeed.map(p => {
  let n = 0, ok = 0;
  for (const key of ['straight', 'corner', 'tight']) { n += p.buckets[key].n; ok += p.buckets[key].ok; }
  return { seed: p.seed, pct: 100 * ok / n, minW: p.minW, meanW: p.meanW };
}).sort((a, b) => a.pct - b.pct);
console.log(`  worst seed ${worst[0].seed}: ${worst[0].pct.toFixed(1)}%`
  + ` (min width ${worst[0].minW.toFixed(2)} m, mean ${worst[0].meanW.toFixed(2)} m)`);
console.log(`  best  seed ${worst[worst.length - 1].seed}: ${worst[worst.length - 1].pct.toFixed(1)}%`);

if (VERBOSE) {
  console.log('\n  narrowest 15 straights:');
  for (const r of rows.filter(r => r.reg === 'straight').sort((a, b) => a.usable - b.usable).slice(0, 15)) {
    console.log(`    seed ${r.seed} s=${r.s.toFixed(0).padStart(5)}  width ${r.width.toFixed(2)}  usable ${r.usable.toFixed(2)}`);
  }
}
