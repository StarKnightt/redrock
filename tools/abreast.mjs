/* How much racing side by side actually happens?
 *
 * tools/lanes.mjs measures the road. This measures the race, which is the only
 * thing that can answer "there's no room to overtake or race side by side" —
 * a road can be wide enough on paper and still never produce two cars abreast,
 * because the width that matters is the width the drivers are willing to use.
 *
 * Every frame, every pair of cars whose bodies overlap along the road is an
 * abreast moment. For each one it records the flank-to-flank gap and where on
 * the stage it happened. The headline numbers:
 *
 *   abreast %      fraction of race time with at least one pair overlapping
 *   roomy %        of those, the fraction with a full car of air between them
 *   pass attempts  abreast moments that ended with the order swapped
 *
 *   node tools/abreast.mjs [tag] [--seeds 1,2,3] [--secs 420]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = (args[0] && !args[0].startsWith('--')) ? args[0] : 'abreast';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '1,2,3').split(',').map(Number);
const SECS = +flag('secs', 420);

const SIM = async ([seed, secs]) => {
  const { Race } = await import('/src/race/index.js');
  const { CAR } = await import('/src/car/mesh.js');
  const g = window.__game;
  const p = g.player;

  if (g.race) g.race.dispose();
  const race = new Race(g.track, g.scene, { seed });
  g.race = race;
  g.botInput = null;
  g.autopilot(true, 0.85);
  g.bot.wobble = 5;
  g.bot.boost = 1;
  p.placeAt(34, 0); p.vx = 0; p.vy = 0; p.r = 0;
  p.raceTime = 0; p.finished = false; p.rpm = 1050; p.gear = 0;
  g.resetSimClock();
  g.step(1 / 60);
  const wired = race._clock > 0;
  race.reset();
  p.placeAt(34, 0); p.vx = 0; p.vy = 0; p.r = 0;
  p.raceTime = 0; p.finished = false;
  g.resetSimClock();

  const W = CAR.width, L = CAR.length;
  const DT = 1 / 60;
  let frames = 0, abreastFrames = 0, playerAbreastFrames = 0;
  const gaps = [];              // flank-to-flank metres, per abreast pair-frame
  const byRegime = { straight: [], corner: [], tight: [] };
  /* An overtake is an order swap between two cars that were abreast within the
     last second — which is what distinguishes a pass from someone simply
     driving away up the road. */
  const lastAbreast = new Map();
  let passes = 0;
  const order = new Map();

  const regimeAt = (s) => {
    const R = 1 / Math.max(Math.abs(g.track.frameAt(s).curv), 1e-6);
    return R > 400 ? 'straight' : R > 110 ? 'corner' : 'tight';
  };

  for (let i = 0; i < secs * 60; i++) {
    g.step(DT);
    if (p.strandedFor > 2.5) p.recover();
    if (!wired) race.step(DT, p);
    frames++;

    const cars = [p, ...race.cars];
    let anyAbreast = false, playerAbreast = false;
    for (let a = 0; a < cars.length; a++) {
      for (let b = a + 1; b < cars.length; b++) {
        const ca = cars[a], cb = cars[b];
        if (ca.finished || cb.finished) continue;
        const ds = Math.abs(ca.s - cb.s);
        if (ds > L) continue;                       // not overlapping: not abreast
        const gap = Math.abs(ca.lat - cb.lat) - W;  // flank to flank
        if (gap < -W * 0.5) continue;               // interpenetrating; not a pair
        anyAbreast = true;
        if (ca === p || cb === p) playerAbreast = true;
        gaps.push(gap);
        byRegime[regimeAt((ca.s + cb.s) * 0.5)].push(gap);
        const key = a + ':' + b;
        lastAbreast.set(key, i);
        const sign = Math.sign(ca.s - cb.s);
        if (order.has(key) && order.get(key) !== sign && sign !== 0) passes++;
        if (sign !== 0) order.set(key, sign);
      }
    }
    if (anyAbreast) abreastFrames++;
    if (playerAbreast) playerAbreastFrames++;
    if (race.standings().every(x => x.finished)) break;
  }

  const q = (arr, t) => {
    if (!arr.length) return null;
    const s = [...arr].sort((x, y) => x - y);
    return +s[Math.min(s.length - 1, Math.floor(t * s.length))].toFixed(2);
  };
  const roomy = (arr) => arr.length
    ? +(100 * arr.filter(x => x >= W).length / arr.length).toFixed(1) : null;

  return {
    seed, frames,
    abreastPct: +(100 * abreastFrames / frames).toFixed(1),
    playerAbreastPct: +(100 * playerAbreastFrames / frames).toFixed(1),
    pairFrames: gaps.length,
    gap: { p10: q(gaps, 0.1), median: q(gaps, 0.5), p90: q(gaps, 0.9) },
    roomyPct: roomy(gaps),
    straight: { n: byRegime.straight.length, median: q(byRegime.straight, 0.5), roomy: roomy(byRegime.straight) },
    corner: { n: byRegime.corner.length, median: q(byRegime.corner, 0.5), roomy: roomy(byRegime.corner) },
    tight: { n: byRegime.tight.length, median: q(byRegime.tight, 0.5), roomy: roomy(byRegime.tight) },
    passes,
    collisions: race.collisions,
  };
};

await run({ width: 640, height: 360, hash: 'manual' }, async ({ page }) => {
  const all = [];
  for (const seed of SEEDS) {
    const r = await page.evaluate(SIM, [seed, SECS]);
    all.push(r);
    console.log(`\n  seed ${r.seed}`);
    console.log(`    abreast ${r.abreastPct}% of race (player in it ${r.playerAbreastPct}%)`
      + `   pair-frames ${r.pairFrames}   passes ${r.passes}   collisions ${r.collisions}`);
    console.log(`    flank gap  p10 ${r.gap.p10}  median ${r.gap.median}  p90 ${r.gap.p90} m`
      + `   a full car of air: ${r.roomyPct}%`);
    for (const k of ['straight', 'corner', 'tight']) {
      console.log(`      ${k.padEnd(9)} n=${String(r[k].n).padStart(6)}  median gap ${String(r[k].median).padStart(6)} m  roomy ${String(r[k].roomy).padStart(5)}%`);
    }
  }

  const mean = (f) => +(all.reduce((a, x) => a + (f(x) ?? 0), 0) / all.length).toFixed(1);
  console.log(`\n  ═══ ${all.length} seeds ═══`);
  console.log(`    abreast ${mean(x => x.abreastPct)}% of race, player ${mean(x => x.playerAbreastPct)}%`);
  console.log(`    median flank gap ${mean(x => x.gap.median)} m, a full car of air ${mean(x => x.roomyPct)}% of the time`);
  console.log(`    on straights: median ${mean(x => x.straight.median)} m, roomy ${mean(x => x.straight.roomy)}%`);
  console.log(`    passes ${all.reduce((a, x) => a + x.passes, 0)}  collisions ${all.reduce((a, x) => a + x.collisions, 0)}`);

  const outDir = path.join(ROOT, 'shots', tag);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ tag, seeds: all }, null, 2));
  console.log(`\n  → shots/${tag}`);
});

finish(process.exitCode || 0);
