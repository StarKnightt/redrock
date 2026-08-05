/* What the ramp launches in the reel actually measure, so the shot list can
 * state it rather than repeat a figure from a brief.
 *
 * CAPTURE-ONLY, and no rendering at all — this is the same restart +
 * autopilot + fixed 1/60 sequence tools/reelshoot.mjs uses, with
 * `g.timeScale()` and the car's flight state sampled every frame.
 *
 *   node tools/reelair.mjs [--seed 22]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', 22);

const AIR = ([skill]) => {
  const g = window.__game, p = g.player;
  g.setPaused(true);
  g.restart();
  g.autopilot(true, skill);
  g.countdown.skip();
  const lips = (g.track.ramps || []).map(r => r.lip ?? r.foot);
  const out = [];
  let cur = null;
  for (let n = 0; n < 60 * 300; n++) {
    g.step(1 / 60);
    const ts = g.timeScale();
    if (p.airborne && !cur) cur = { n0: n, s0: p.s, kmh: p.kmh, apex: 0, slowFrames: 0, minTs: 1, simSec: 0 };
    if (cur) {
      cur.apex = Math.max(cur.apex, p.height);
      cur.minTs = Math.min(cur.minTs, ts);
      if (ts < 0.999) cur.slowFrames++;
      cur.simSec += ts / 60;
      if (!p.airborne && p.height < 0.05) {
        cur.wallSec = (n - cur.n0) / 60;
        cur.s1 = p.s;
        if (cur.apex > 1.0) out.push(cur);
        cur = null;
      }
    }
    if (p.s > g.track.length - 260) break;
  }
  g.autopilot(false);
  return { lips, flights: out };
};

await run({ width: 640, height: 360, begin: false, hash: `manual&tier=low&seed=${SEED}&cap=0&hud=0` },
  async ({ page }) => {
    const d = await page.evaluate(AIR, [0.9]);
    console.log(`\n  seed ${SEED} — ramp lips at ${d.lips.map(x => x | 0).join(', ')}`);
    console.log('\n  station    entry     apex    wall-clock   sim time   slow-mo   min scale');
    for (const f of d.flights) {
      console.log(`  ${String(f.s0 | 0).padStart(6)} m  ${f.kmh.toFixed(0).padStart(4)} km/h`
        + `  ${f.apex.toFixed(2).padStart(5)} m`
        + `  ${f.wallSec.toFixed(2).padStart(8)} s`
        + `  ${f.simSec.toFixed(2).padStart(8)} s`
        + `  ${(f.slowFrames / 60).toFixed(2).padStart(7)} s`
        + `  ${f.minTs.toFixed(2).padStart(9)}`);
    }
  });

finish(process.exitCode || 0);
