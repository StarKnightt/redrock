/* Two loose ends.
 *
 * 1. What is the boost pad worth? The same approach driven twice on the same
 *    seed and the same ramp — once as shipped, once with padCrossed() stubbed
 *    out so the timer never arms and nothing else changes — reporting speed at
 *    the lip, air, distance and apex both ways. A pad that cannot be measured
 *    is a decal.
 * 2. Where does the biggest air on the stage actually come from? Records the
 *    station of every launch in a full race so a ramp's apex can be compared
 *    against whatever else the terrain is doing.
 *
 *   node tools/padgain.mjs [--seeds 22,40]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22').split(',').map(Number);

for (const SEED of SEEDS) {
await run({ width: 640, height: 360, hash: `manual&tier=low&seed=${SEED}&cap=0&hud=0` },
  async ({ page }) => {
  const out = await page.evaluate(() => {
    const g = window.__game, p = g.player, track = g.track, L = track.length;
    g.setPaused(true);
    if (g.race?.entries) g.race.entries.length = 0;

    const fly = (r) => {
      g.autopilot(true, 0.85);
      g.driveTo(r.pad0 / L, { runUp: 300, maxSec: 40 });
      let lip = 0, air = 0, apex = 0, up = 0, down = 0, wasAir = false, boosted = 0;
      for (let i = 0; i < 60 * 6; i++) {
        const b = p.s;
        g.step(1 / 60);
        if (p.boostTimer > 0) boosted = 1;
        if (b < r.lip && p.s >= r.lip) lip = p.kmh;
        if (p.airborne && !wasAir) { wasAir = true; up = p.s; }
        if (wasAir && p.airborne) { air = p.airTime; apex = Math.max(apex, p.height); }
        if (wasAir && !p.airborne && !down) { down = p.s; break; }
      }
      g.autopilot(false);
      return { lip: +lip.toFixed(0), air: +air.toFixed(2), apex: +apex.toFixed(2),
        dist: +(down - up).toFixed(1), boosted };
    };

    const rows = [];
    for (const r of track.ramps) {
      const withPad = fly(r);
      const real = track.padCrossed.bind(track);
      track.padCrossed = () => null;
      const without = fly(r);
      track.padCrossed = real;
      rows.push({ lip: r.lip, withPad, without });
    }

    /* Where the air on this stage comes from, ramps and everything else. */
    g.goTo(0.004); g.race.reset(); g.resetSimClock(); g.autopilot(true, 0.85);
    const launches = [];
    let wasAir = false, cur = null;
    for (let i = 0; i < 60 * 260; i++) {
      g.step(1 / 60);
      if (p.airborne && !wasAir) cur = { s: p.s, apex: 0, air: 0 };
      if (p.airborne && cur) { cur.apex = Math.max(cur.apex, p.height); cur.air = p.airTime; }
      if (!p.airborne && cur) {
        if (cur.apex > 0.25) launches.push({ s: +cur.s.toFixed(0), apex: +cur.apex.toFixed(2), air: +cur.air.toFixed(2) });
        cur = null;
      }
      wasAir = !!p.airborne;
      if (p.s > L - 40) break;
    }
    g.autopilot(false);
    return { seed: track.seed, rows, launches, lips: track.ramps.map(r => r.lip) };
  });

  console.log(`\n  seed ${out.seed} — what the pad is worth`);
  console.log('    lip      with pad: lip km/h  air   apex   dist      no pad: lip km/h  air   apex   dist');
  for (const r of out.rows) {
    const a = r.withPad, b = r.without;
    console.log(`    ${String(r.lip).padStart(5)}  ${String(a.lip).padStart(20)} ${a.air.toFixed(2)} ${a.apex.toFixed(2).padStart(6)} ${a.dist.toFixed(1).padStart(6)}`
      + `  ${String(b.lip).padStart(20)} ${b.air.toFixed(2)} ${b.apex.toFixed(2).padStart(6)} ${b.dist.toFixed(1).padStart(6)}`
      + `   Δ lip ${(a.lip - b.lip >= 0 ? '+' : '') + (a.lip - b.lip)} km/h, Δ apex ${((a.apex - b.apex) * 100).toFixed(0)} cm`);
  }
  const big = [...out.launches].sort((x, y) => y.apex - x.apex).slice(0, 6);
  console.log(`    every launch over 25 cm in one race, biggest first (ramp lips: ${out.lips.join(', ')}):`);
  for (const l of big) {
    const onRamp = out.lips.some(v => Math.abs(l.s - v) < 30);
    console.log(`      s ${String(l.s).padStart(5)}  apex ${l.apex.toFixed(2)} m  air ${l.air.toFixed(2)} s${onRamp ? '   <- a ramp' : ''}`);
  }
});
}
finish(process.exitCode || 0);
