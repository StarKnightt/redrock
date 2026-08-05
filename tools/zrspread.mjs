/* How far apart is the field, in MINIMAP PIXELS?
 *
 * The question this tool exists to settle is the one the brief put first: does
 * a whole-track elevation card have the resolution to separate four cars, or
 * does it render the field as one dot with three dots hiding under it?
 *
 * Arc length is the wrong unit for that question and it is the unit every
 * existing instrument reports in. tools/kwgrid.mjs says the nearest rival is
 * inside 60 m for about two thirds of the race, which sounds close and says
 * nothing at all about legibility until it is divided by the card's own scale.
 * So this samples every car's station through whole races and converts, using
 * the HUD's OWN layout arithmetic — copied from src/ui/hud.js resize() and
 * _buildMap() rather than approximated — at every size the game supports.
 *
 * THE CAR IS PUT BACK ON THE GRID WITH g.restart(). The page has been running
 * its own rAF loop since it booted and how far the car got before this took the
 * wheel is a function of browser start-up time; a census on this project
 * disagreed with itself by a factor of ten over exactly that. tools/zjdet.mjs
 * is the detector.
 *
 * A seed here is a FIELD seed, not a track seed — the convention
 * tools/kwgrid.mjs and tools/race.mjs use. The stage is whatever the page was
 * booted with, so N seeds is N different fields down one road.
 *
 *   node tools/zrspread.mjs [--seeds 1..12] [--secs 420] [--skill 0.85]
 *                           [--hz 4] [--json out.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const parseSeeds = (spec) => {
  const m = /^(\d+)\.\.(\d+)$/.exec(spec);
  if (!m) return spec.split(',').map(Number);
  const out = [];
  for (let i = +m[1]; i <= +m[2]; i++) out.push(i);
  return out;
};
const SEEDS = parseSeeds(flag('seeds', '1..12'));
const SECS = +flag('secs', 420);
const SKILL = +flag('skill', 0.85);
const HZ = +flag('hz', 4);
const JSON_OUT = flag('json', null);

/* The card's geometry, lifted from the HUD.
 *
 *   u      = min(w, h) / 720
 *   map.w  = min(330u, w * 0.30)
 *   padX   = 16u
 *   iw     = map.w - 2 * padX          the ridge's drawable width
 *   x(s)   = padX + (s / length) * iw
 *
 * So metres per CSS pixel is length / iw, and per DEVICE pixel it is that over
 * dpr. Device pixels are what the eye gets, which is the unit this whole
 * project keeps being wrong in. */
const SIZES = [
  [1280, 720, 1], [1600, 900, 1], [1920, 1080, 1],
  [2560, 1080, 1], [2560, 1440, 1], [1280, 720, 2],
];
const ridgeWidth = (w, h) => {
  const u = Math.min(w, h) / 720;
  return Math.min(330 * u, w * 0.30) - 32 * u;
};

const SIM = async ([seed, secs, skill, hz]) => {
  const { Race } = await import('/src/race/index.js');
  const g = window.__game;
  const p = g.player;

  if (g.race) g.race.dispose();
  const race = new Race(g.track, g.scene, { seed });
  g.race = race;

  /* Is main.js stepping the field, or must this tool? Stepping it twice gives
     every rival double time against the player. Probe, then undo with the
     restart below. */
  g.botInput = { steer: 0, throttle: 0, brake: 1, handbrake: 0 };
  g.step(1 / 60);
  const wired = race._clock > 0;
  g.botInput = null;

  g.restart();                    // the whole reset, in one call
  g.autopilot(true, skill);
  g.bot.wobble = 5;               // Driver seeds this from Math.random; pin it
  g.bot.boost = 1;

  const cars = race.entries.map(e => e.car);
  const every = Math.max(1, Math.round(60 / hz));

  /* Per sample: the player's station, and each rival's signed offset from it.
     Signed, because "ahead" and "behind" are different readings and the
     reversed grid makes the first half of every race all-ahead. */
  const samples = [];
  const DT = 1 / 60;
  for (let i = 0; i < secs * 60; i++) {
    g.step(DT);
    if (!wired) race.step(DT, p);
    if (i % every === 0 && !p.finished) {
      samples.push([
        +p.s.toFixed(2),
        ...cars.map(c => +(c.s - p.s).toFixed(2)),
      ]);
    }
    if (p.finished && cars.every(c => c.finished)) break;
  }
  g.autopilot(false);

  return {
    seed, wired, length: g.track.length,
    hz, samples,
    order: race.standings().map(x => (x.isPlayer ? 'PLAYER' : x.name)),
  };
};

const all = [];
await run({ width: 640, height: 360, hash: 'manual&tier=low&hud=0&cap=0' }, async ({ page }) => {
  page.setDefaultTimeout(900_000);
  for (const seed of SEEDS) {
    const o = await page.evaluate(SIM, [seed, SECS, SKILL, HZ]);
    all.push(o);
    console.log(`  seed ${String(seed).padStart(2)}  ${o.samples.length} samples`
      + `  ${o.wired ? '' : '(field stepped by this tool) '}`
      + `finish order ${o.order.join(' ')}`);
  }
});

if (!all.length) finish(1);

const L = all[0].length;
const flat = [];                  // every |Δs| between the player and a rival
const spreads = [];               // whole-field extent, metres
const nearest = [];
for (const o of all) {
  for (const s of o.samples) {
    const d = s.slice(1);
    for (const x of d) flat.push(Math.abs(x));
    const lo = Math.min(0, ...d), hi = Math.max(0, ...d);
    spreads.push(hi - lo);
    nearest.push(Math.min(...d.map(Math.abs)));
  }
}
const q = (arr, p) => {
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
};
const pct = (arr, f) => (arr.filter(f).length / arr.length * 100);

console.log(`\n═══ ${all.length} fields, ${flat.length / 3} samples at ${HZ} Hz,`
  + ` stage ${L.toFixed(0)} m ═══`);
console.log('\n  player-to-rival gap, metres of arc');
console.log(`    p10 ${q(flat, 0.1).toFixed(0)}   p25 ${q(flat, 0.25).toFixed(0)}`
  + `   median ${q(flat, 0.5).toFixed(0)}   p75 ${q(flat, 0.75).toFixed(0)}`
  + `   p90 ${q(flat, 0.9).toFixed(0)}   max ${Math.max(...flat).toFixed(0)}`);
console.log('  nearest rival, metres');
console.log(`    p10 ${q(nearest, 0.1).toFixed(0)}   median ${q(nearest, 0.5).toFixed(0)}`
  + `   p90 ${q(nearest, 0.9).toFixed(0)}`);
console.log('  whole-field extent, metres');
console.log(`    p10 ${q(spreads, 0.1).toFixed(0)}   median ${q(spreads, 0.5).toFixed(0)}`
  + `   p90 ${q(spreads, 0.9).toFixed(0)}   max ${Math.max(...spreads).toFixed(0)}`);
console.log(`  as a fraction of the stage: median ${(q(spreads, 0.5) / L * 100).toFixed(1)}%`
  + `   p90 ${(q(spreads, 0.9) / L * 100).toFixed(1)}%`);

/* And the whole point: the same numbers in the pixels the card actually has.
 *
 * SEP is the centre-to-centre distance at which two markers are separate marks
 * rather than one blob. The player's disc is r = 5.5u with a 3u ink stroke, so
 * its inked radius is 7u — two of those touch at 14u and are clearly two marks
 * at about 16u. Reported in device pixels alongside, since that is what the eye
 * is given. */
console.log('\n  the same gaps in MINIMAP pixels, whole-track scale');
console.log('   size            ridge px   m/device px   median gap   p25 gap   '
  + 'nearest rival');
const table = [];
for (const [w, h, dpr] of SIZES) {
  const u = Math.min(w, h) / 720;
  const iw = ridgeWidth(w, h);
  const mPerCss = L / iw;
  const mPerDev = mPerCss / dpr;
  const toDev = m => m / mPerDev;
  const sep = 16 * u * dpr;              // two 7u-inked discs, clearly apart
  const row = {
    size: `${w}x${h}@${dpr}`, u, ridgeDev: +(iw * dpr).toFixed(0),
    mPerDev: +mPerDev.toFixed(2),
    medianGapPx: +toDev(q(flat, 0.5)).toFixed(1),
    p25GapPx: +toDev(q(flat, 0.25)).toFixed(1),
    nearestMedianPx: +toDev(q(nearest, 0.5)).toFixed(1),
    sepPx: +sep.toFixed(1),
    /* How often a rival marker would be merged into the player's. */
    mergedPct: +pct(flat, m => toDev(m) < sep).toFixed(0),
    /* And how often ALL THREE are merged into it — the "one dot" failure. */
    allMergedPct: 0,
  };
  let allMerged = 0, n = 0;
  for (const o of all) {
    for (const s of o.samples) {
      n++;
      if (s.slice(1).every(x => toDev(Math.abs(x)) < sep)) allMerged++;
    }
  }
  row.allMergedPct = +(allMerged / n * 100).toFixed(0);
  table.push(row);
  console.log(`   ${row.size.padEnd(15)} ${String(row.ridgeDev).padStart(8)}`
    + `   ${String(row.mPerDev).padStart(11)}`
    + `   ${String(row.medianGapPx).padStart(10)}`
    + `   ${String(row.p25GapPx).padStart(7)}`
    + `   ${String(row.nearestMedianPx).padStart(13)}`);
}
console.log('\n  and how often a marker is merged into the player\'s');
console.log('   size            separation needed   a rival merged   ALL THREE merged');
for (const r of table) {
  console.log(`   ${r.size.padEnd(15)} ${String(r.sepPx).padStart(14)} px`
    + `   ${String(r.mergedPct).padStart(13)}%`
    + `   ${String(r.allMergedPct).padStart(16)}%`);
}

/* Relative motion. The brief's worry is markers that "never move perceptibly",
   which is a claim about the rate the gap changes, not about its size. */
const rates = [];
for (const o of all) {
  for (let i = 1; i < o.samples.length; i++) {
    const a = o.samples[i - 1], b = o.samples[i];
    for (let k = 1; k < a.length; k++) rates.push(Math.abs(b[k] - a[k]) * o.hz);
  }
}
console.log('\n  rate the player-to-rival gap changes, m/s');
console.log(`    median ${q(rates, 0.5).toFixed(1)}   p90 ${q(rates, 0.9).toFixed(1)}`
  + `   max ${Math.max(...rates).toFixed(0)}`);
for (const [w, h, dpr] of [[1280, 720, 1], [1600, 900, 1]]) {
  const mPerDev = (L / ridgeWidth(w, h)) / dpr;
  console.log(`    at ${w}x${h}@${dpr}: median ${(q(rates, 0.5) / mPerDev).toFixed(2)}`
    + ` device px/s, p90 ${(q(rates, 0.9) / mPerDev).toFixed(2)} px/s`);
}

const out = JSON_OUT || path.join(ROOT, '.meas', 'zrspread.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ seeds: SEEDS, secs: SECS, skill: SKILL, hz: HZ, table, races: all }, null, 1));
console.log(`\n  → ${path.relative(ROOT, out)}`);
finish(process.exitCode || 0);
