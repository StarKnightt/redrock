/* Where the harness autopilot leaves the road, and for how long.
 *
 * "The autopilot cannot use the ramp at 3648" is only a statement about the
 * ramp if the car is on the road when it arrives at the corner before it. If
 * the car has been in the grass since a kilometre earlier, the ramp is not what
 * it failed at. So: every contiguous off-road excursion of a whole lap, with
 * where it started, where it ended, and which ramps are inside it.
 *
 *   node tools/qtoff.mjs [--seeds 22,1,40] [--skills 0.75,0.85]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',').map(Number);
const SKILLS = flag('skills', '0.75,0.85').split(',').map(Number);

const PROBE = ([skills]) => {
  const g = window.__game, t = g.track;
  const ramps = (t.ramps || []).slice().sort((a, b) => a.lip - b.lip);
  const laps = [];
  for (const skill of skills) {
    g.restart(); g.resetSimClock(); g.setPaused(true);
    g.autopilot(true, skill);
    g.countdown.skip(); g.ending.skip();
    const p = g.player;
    const tr = [];
    for (let i = 0; i < 300 * 60 && p.s < t.finishS - 20; i++) {
      g.step(1 / 60);
      tr.push({ s: p.s, off: p.offRoad, f: i });
    }
    /* Fully off, not partly: offRoad is a fraction and a car clipping a verge
       reads 0.2 for a frame. The complaint is about a car that is IN the grass,
       so the excursion threshold is 0.99 and it has to hold for a quarter of a
       second before it counts. */
    const runs = [];
    let cur = null;
    for (const r of tr) {
      if (r.off >= 0.99) { if (!cur) cur = { i0: r.f, s0: r.s, i1: r.f, s1: r.s }; else { cur.i1 = r.f; cur.s1 = r.s; } }
      else if (cur) { if (cur.i1 - cur.i0 >= 15) runs.push(cur); cur = null; }
    }
    if (cur && cur.i1 - cur.i0 >= 15) runs.push(cur);
    laps.push({
      skill, totalFrames: tr.length,
      offFrac: +(tr.filter(r => r.off >= 0.99).length / tr.length).toFixed(3),
      runs: runs.map(r => ({
        s0: +r.s0.toFixed(0), s1: +r.s1.toFixed(0),
        m: +(r.s1 - r.s0).toFixed(0), sec: +((r.i1 - r.i0) / 60).toFixed(2),
        ramps: ramps.filter(x => x.lip >= r.s0 - 5 && x.lip <= r.s1 + 5).map(x => x.lip),
      })),
    });
  }
  return { seed: t.seed, ramps: ramps.map(r => r.lip), laps };
};

for (const seed of SEEDS) {
  await run({ width: 320, height: 200, hash: `manual&tier=high&seed=${seed}&cap=0&hud=0` },
    async ({ page }) => {
      const r = await page.evaluate(PROBE, [SKILLS]);
      console.log(`\n─── seed ${r.seed}   ramps at ${r.ramps.join(' / ')}`);
      for (const lap of r.laps) {
        const longest = lap.runs.slice().sort((a, b) => b.m - a.m).slice(0, 8);
        console.log(`\n  skill ${lap.skill}   fully off the road for ${(lap.offFrac * 100).toFixed(0)}%`
          + ` of the lap, in ${lap.runs.length} excursions`);
        console.log('   the eight longest:');
        for (const e of longest) {
          console.log(`     s ${String(e.s0).padStart(4)} → ${String(e.s1).padStart(4)}`
            + `  ${String(e.m).padStart(4)} m  ${e.sec.toFixed(1).padStart(5)} s`
            + (e.ramps.length ? `   contains ramp ${e.ramps.join(',')}` : ''));
        }
      }
    });
}
finish(process.exitCode || 0);
