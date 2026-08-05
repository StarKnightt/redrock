/* One uninterrupted autopilot lap, and what happens at each ramp during it.
 *
 * tools/qtair.mjs drops the car 320 m before each lip and drives it in. That is
 * the right way to isolate a flight, but it cannot answer whether the racing
 * line actually ARRIVES at a ramp — the car is placed on the centreline and has
 * three hundred metres of clean road to sort itself out. A lap cannot be
 * cheated that way: whatever state the car is in at the lip is the state the
 * corner before it left the car in.
 *
 * Run at several skills, because "the autopilot cannot use this ramp" and "the
 * autopilot is bad at the corner before this ramp" produce the same reading at
 * one skill and different readings across a sweep.
 *
 *   node tools/qtlap.mjs [--seeds 22,1,40] [--skills 0.75,0.85,0.95]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',').map(Number);
const SKILLS = flag('skills', '0.75,0.85,0.95').split(',').map(Number);

const PROBE = ([skills]) => {
  const g = window.__game;
  const t = g.track;
  const ramps = (t.ramps || []).slice().sort((a, b) => a.lip - b.lip);
  const laps = [];

  for (const skill of skills) {
    g.restart();
    g.resetSimClock();
    g.setPaused(true);
    g.autopilot(true, skill);
    g.countdown.skip();
    g.ending.skip();
    const p = g.player;
    const trace = [];
    for (let i = 0; i < 300 * 60 && p.s < t.finishS - 20; i++) {
      const ts = g.timeScale();
      g.step(1 / 60);
      trace.push({ f: i, s: p.s, air: p.airborne ? 1 : 0, h: p.height, off: p.offRoad, ts,
        v: Math.hypot(p.vx, p.vy) });
    }

    const runs = [];
    let cur = null;
    for (const r of trace) {
      if (r.air) { if (!cur) cur = { i0: r.f, i1: r.f }; else cur.i1 = r.f; }
      else if (cur && r.f - cur.i1 > 1) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);

    const band = (a, b) => {
      let n = 0, sum = 0, mx = 0;
      for (const r of trace) { if (r.s < a || r.s > b) continue; n++; sum += r.off; mx = Math.max(mx, r.off); }
      return n ? { mean: +(sum / n).toFixed(2), max: +mx.toFixed(2) } : null;
    };

    const hits = ramps.map((ramp, ri) => {
      let best = null;
      for (const rn of runs) {
        const d = Math.abs(trace[rn.i0].s - ramp.lip);
        if (d < 40 && (!best || d < best.d)) best = { ...rn, d };
      }
      const row = {
        ramp: ri, lip: ramp.lip,
        approach: band(ramp.lip - 120, ramp.lip),
        landing: band(ramp.land - 10, ramp.land + 80),
        far: band(ramp.lip - 400, ramp.lip - 120),
      };
      if (!best) return { ...row, flew: 0 };
      const seg = trace.slice(best.i0, best.i1 + 1);
      let apex = 0, sim = 0;
      for (const r of seg) { apex = Math.max(apex, r.h); sim += r.ts / 60; }
      return {
        ...row, flew: 1, frames: seg.length,
        wall: +(seg.length / 60).toFixed(3), sim: +sim.toFixed(3),
        apex: +apex.toFixed(2),
        entryKmh: +(trace[best.i0].v * 3.6).toFixed(0),
      };
    });

    laps.push({
      skill, frames: trace.length, wallSec: +(trace.length / 60).toFixed(1),
      endS: +p.s.toFixed(0),
      offMean: +(trace.reduce((a, r) => a + r.off, 0) / trace.length).toFixed(3),
      hits,
    });
  }
  return { seed: t.seed, length: t.length, laps };
};

const all = [];
for (const seed of SEEDS) {
  await run({ width: 320, height: 200, hash: `manual&tier=high&seed=${seed}&cap=0&hud=0` },
    async ({ page }) => {
      const r = await page.evaluate(PROBE, [SKILLS]);
      all.push(r);
      console.log(`\n─── seed ${r.seed}   lap on the autopilot, start to flag`);
      for (const lap of r.laps) {
        console.log(`\n  skill ${lap.skill}   lap ${lap.wallSec}s wall   mean offRoad ${lap.offMean}`);
        console.log('   lip    flew   wall s   apex m   entry     far(-400..-120)  approach(-120..0)  landing');
        for (const h of lap.hits) {
          console.log(`  ${String(h.lip).padStart(5)}  ${h.flew ? ' yes' : '  NO'}`
            + `  ${h.flew ? h.wall.toFixed(3).padStart(6) : '     —'}`
            + `  ${h.flew ? h.apex.toFixed(2).padStart(6) : '     —'}`
            + `  ${h.flew ? String(h.entryKmh).padStart(4) + ' km/h' : '        '}`
            + `   ${JSON.stringify(h.far).padEnd(22)} ${JSON.stringify(h.approach).padEnd(22)} ${JSON.stringify(h.landing)}`);
        }
      }
    });
}
console.log('\n' + JSON.stringify(all));
finish(process.exitCode || 0);
