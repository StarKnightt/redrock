/* Survey seeds for the showcase reel, and record enough per-frame telemetry
 * that shot windows can be chosen offline instead of by re-running a browser
 * once per candidate.
 *
 * CAPTURE-ONLY TOOL. It reads the world and never writes to it beyond the
 * control surface main.js already exposes.
 *
 * The rules this file exists to obey:
 *
 *   restart() before anything is stepped. The page has its own rAF loop and
 *   how far it carried the car before the first evaluate arrived is a
 *   function of browser start time — tools/zjdet.mjs is the detector. The
 *   harness is also asked for begin:false here, so the loop never starts at
 *   all and there is nothing to inherit.
 *
 *   The same restart + autopilot + fixed 1/60 sequence the capture pass uses,
 *   so a window chosen here lands on the same frames there. Nothing in this
 *   file renders, which is the only difference, and rendering does not feed
 *   back into the simulation.
 *
 *   node tools/reelscout.mjs [--seeds 22,1,40] [--sec 240] [--skill 0.9]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',').map(Number);
const SEC = +flag('sec', 260);
const SKILL = +flag('skill', 0.9);
const OUT = path.join(ROOT, 'out', 'reel', 'scout');

fs.mkdirSync(OUT, { recursive: true });

const SCOUT = ([sec, skill]) => {
  const g = window.__game;
  const p = g.player;
  g.setPaused(true);
  /* The suite-wide leak. Unconditional, before a single step. */
  g.restart();
  g.autopilot(true, skill);
  g.countdown.skip();

  const rivals = (g.race?.entries || []).map(e => e.car).filter(c => c && c !== p);
  const stop = g.track.length - 260;   // well short of the line; the finish is fenced
  const rows = [];
  let n = 0;
  for (; n < 60 * sec; n++) {
    g.step(1 / 60);
    const gaps = rivals.map(c => c.s - p.s);
    /* Nearest rival ahead and nearest behind, separately: a car filling the
       frame ahead of you and one you have just left are different shots. */
    let ahead = 1e9, behind = -1e9, airRival = 0;
    for (let i = 0; i < gaps.length; i++) {
      if (gaps[i] >= 0 && gaps[i] < ahead) ahead = gaps[i];
      if (gaps[i] < 0 && gaps[i] > behind) behind = gaps[i];
      if (rivals[i].airborne) airRival = 1;
    }
    rows.push([
      +p.s.toFixed(2),
      +p.kmh.toFixed(1),
      +p.offRoad.toFixed(3),
      +p.height.toFixed(2),
      +((p.slipAngle * 180) / Math.PI).toFixed(1),
      +p.lat.toFixed(2),
      p.airborne ? 1 : 0,
      ahead > 1e8 ? -1 : +ahead.toFixed(1),
      behind < -1e8 ? -1 : +(-behind).toFixed(1),
      +(p.strandedFor || 0).toFixed(2),
      airRival,
      +(p.wheelSlip ? Math.max(...p.wheelSlip) : 0).toFixed(2),
    ]);
    if (p.s >= stop || p.finished) { n++; break; }
  }
  g.autopilot(false);

  const num = o => {
    if (!o) return null;
    const out = {};
    for (const k of Object.keys(o)) if (typeof o[k] === 'number') out[k] = +o[k].toFixed(2);
    return out;
  };

  return {
    frames: n,
    length: +g.track.length.toFixed(1),
    ramps: (g.track.ramps || []).map(num),
    tunnel: num(g.field?.tunnel),
    fieldSize: g.race.fieldSize,
    rows,
  };
};

for (const SEED of SEEDS) {
  console.log(`\n─── seed ${SEED} ───`);
  await run({
    width: 640, height: 360, begin: false,
    hash: `manual&tier=low&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    const t0 = Date.now();
    const d = await page.evaluate(SCOUT, [SEC, SKILL]);
    const file = path.join(OUT, `seed-${SEED}.json`);
    fs.writeFileSync(file, JSON.stringify(d));
    const secs = d.frames / 60;
    const off = d.rows.filter(r => r[2] > 0.25).length / d.rows.length;
    const slow = d.rows.filter(r => r[1] < 60).length / d.rows.length;
    const air = d.rows.filter(r => r[6]).length;
    console.log(`  lap ${secs.toFixed(1)} s over ${d.length} m   ${(Date.now() - t0) / 1000 | 0}s wall`);
    console.log(`  off-road ${(off * 100).toFixed(1)}%   under 60 km/h ${(slow * 100).toFixed(1)}%`
      + `   airborne ${air} frames`);
    console.log(`  ramps  ${d.ramps.map(r => `${r.lip ?? r.foot}`).join(', ')}`);
    console.log(`  tunnel ${d.tunnel ? JSON.stringify(d.tunnel) : 'none'}`);
    console.log(`  → ${path.relative(ROOT, file)}`);
  });
}

finish(process.exitCode || 0);
