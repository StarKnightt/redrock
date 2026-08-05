/* How long the car is actually in the air off each ramp, and how high it gets.
 *
 * DEFINITION, because three different numbers are in circulation and they are
 * not all measuring the same thing:
 *
 *   AIR   the number of consecutive 1/60 s frames on which the car is not in
 *         contact with the road, divided by 60. The car is a single rigid body
 *         with one suspension height — there are no per-wheel contacts in
 *         physics.js — so "no wheel in contact" is `player.airborne`, which is
 *         true exactly when the body is above its droop travel. First airborne
 *         frame to the last one before contact is restored, inclusive.
 *
 *   WALL  that count at true 60 Hz: the harness calls `g.step(1/60)` and
 *         `step` takes WALL dt and scales it internally, so frames/60 is what a
 *         viewer's clock reads.
 *
 *   SIM   the simulation time those same frames were worth. Slow motion makes
 *         these differ by up to the depth of the envelope, and the ballistic
 *         prediction in `pickRamps` (2*v0*RAMP_LIP_SLOPE/g) is a SIM figure —
 *         comparing it against a wall-clock measurement is a category error and
 *         is one of the ways the numbers in circulation drifted apart.
 *
 *   APEX  max `player.height`, which is metres of the body above the road
 *         surface under it, over the same frames.
 *
 * `restart()` before every run and the sim clock reset with it, per
 * tools/zjdet.mjs — stepping from wherever the page's own loop left the car
 * inherits browser-start-dependent state and a census disagreed with itself
 * ten times over exactly that.
 *
 *   node tools/qtair.mjs [--seeds 22,1,40] [--skill 0.85] [--repeat 1]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',').map(Number);
const SKILL = Number(flag('skill', '0.85'));
const REPEAT = Number(flag('repeat', '1'));

const PROBE = ([skill, repeat]) => {
  const g = window.__game;
  const t = g.track;
  const ramps = (t.ramps || []).slice().sort((a, b) => a.lip - b.lip);
  const out = [];

  for (let ri = 0; ri < ramps.length; ri++) {
    const ramp = ramps[ri];
    for (let rep = 0; rep < repeat; rep++) {
      g.restart();
      g.resetSimClock();
      g.setPaused(true);
      g.autopilot(true, skill);
      g.countdown.skip();
      g.ending.skip();
      /* Dropped onto the run-up and driven in, not teleported onto the lip: a
         parked car cannot jump, and the entry speed is the whole of the flight. */
      g.goTo(Math.max(6, ramp.lip - 320) / t.length);
      const p = g.player;
      for (let i = 0; i < 60 * 60 && p.s < ramp.lip - 300; i++) g.step(1 / 60);

      /* Frame-by-frame from 300 m out to 200 m past the landing. Everything
         needed to classify the flight is captured per frame; nothing is decided
         inside the loop. */
      const trace = [];
      const stop = ramp.land + 200;
      for (let i = 0; i < 90 * 60 && p.s < stop; i++) {
        const before = g.timeScale();
        g.step(1 / 60);
        trace.push({
          f: i, s: p.s, air: p.airborne ? 1 : 0, h: p.height,
          v: Math.hypot(p.vx, p.vy), off: p.offRoad, ts: before,
          launched: p.launched ? p.launchId : -1,
        });
      }

      /* The flight is the airborne run that starts nearest the lip. Contiguous
         with a one-frame tolerance: the launch impulse can put the body inside
         droop travel for a single frame on the up-face without the car having
         landed, and splitting the flight there would report two short hops. */
      const runs = [];
      let cur = null;
      for (const r of trace) {
        if (r.air) { if (!cur) cur = { i0: r.f, i1: r.f }; else cur.i1 = r.f; }
        else if (cur && r.f - cur.i1 > 1) { runs.push(cur); cur = null; }
      }
      if (cur) runs.push(cur);
      let best = null;
      for (const rn of runs) {
        const startS = trace[rn.i0].s;
        const d = Math.abs(startS - ramp.lip);
        if (d < 40 && (!best || d < best.d)) best = { ...rn, d };
      }
      if (!best) { out.push({ ramp: ri, lip: ramp.lip, rep, miss: 1 }); continue; }

      const seg = trace.slice(best.i0, best.i1 + 1);
      const frames = seg.length;
      let apex = 0, simT = 0, minTs = 1, offMax = 0, offMin = 1;
      for (const r of seg) {
        apex = Math.max(apex, r.h);
        simT += r.ts / 60;
        minTs = Math.min(minTs, r.ts);
      }
      /* Off-road over approach, flight and landing separately: a ramp the
         racing line never reaches is a different defect from a ramp that is
         landed badly, and one number for the pass cannot tell them apart. */
      const band = (a, b) => {
        let n = 0, sum = 0, mx = 0;
        for (const r of trace) {
          if (r.s < a || r.s > b) continue;
          n++; sum += r.off; mx = Math.max(mx, r.off);
        }
        return n ? { mean: +(sum / n).toFixed(2), max: +mx.toFixed(2) } : null;
      };
      for (const r of seg) { offMax = Math.max(offMax, r.off); offMin = Math.min(offMin, r.off); }

      out.push({
        ramp: ri, lip: ramp.lip, rep,
        entryV: +trace[best.i0].v.toFixed(1),
        entryKmh: +(trace[best.i0].v * 3.6).toFixed(0),
        frames,
        wall: +(frames / 60).toFixed(3),
        sim: +simT.toFixed(3),
        apex: +apex.toFixed(2),
        minScale: +minTs.toFixed(3),
        predAir: ramp.air,
        s0: +trace[best.i0].s.toFixed(1),
        s1: +trace[best.i1].s.toFixed(1),
        span: +(trace[best.i1].s - trace[best.i0].s).toFixed(1),
        offFlight: { mean: +(seg.reduce((a, r) => a + r.off, 0) / seg.length).toFixed(2), max: +offMax.toFixed(2), min: +offMin.toFixed(2) },
        offApproach: band(ramp.lip - 120, ramp.lip),
        offLanding: band(ramp.land - 10, ramp.land + 80),
      });
    }
  }
  return { seed: t.seed, ramps: ramps.map(r => ({ lip: r.lip, land: r.land, pred: r.air, speed: r.speed })), out };
};

const all = [];
for (const seed of SEEDS) {
  await run({ width: 320, height: 200, hash: `manual&tier=high&seed=${seed}&cap=0&hud=0` },
    async ({ page }) => {
      const r = await page.evaluate(PROBE, [SKILL, REPEAT]);
      all.push(r);
      console.log(`\n─── seed ${r.seed}   skill ${SKILL}`);
      console.log('  lip     entry     frames   WALL s   sim s   apex m   minScale   predicted sim s');
      for (const f of r.out) {
        if (f.miss) { console.log(`  ${String(f.lip).padStart(5)}   — no airborne run within 40 m of the lip —`); continue; }
        console.log(`  ${String(f.lip).padStart(5)}  ${String(f.entryKmh).padStart(4)} km/h`
          + `  ${String(f.frames).padStart(6)}  ${f.wall.toFixed(3).padStart(7)}`
          + ` ${f.sim.toFixed(3).padStart(7)} ${f.apex.toFixed(2).padStart(8)}`
          + `   ${f.minScale.toFixed(2).padStart(6)}   ${String(f.predAir).padStart(14)}`);
      }
      console.log('  off-road (0 = on the road, 1 = fully off)');
      for (const f of r.out) {
        if (f.miss) continue;
        console.log(`  ${String(f.lip).padStart(5)}  approach ${JSON.stringify(f.offApproach)}`
          + `  flight mean ${f.offFlight.mean}  landing ${JSON.stringify(f.offLanding)}`);
      }
    });
}

const flights = all.flatMap(r => r.out.filter(f => !f.miss));
if (flights.length) {
  const w = flights.map(f => f.wall).sort((a, b) => a - b);
  const s = flights.map(f => f.sim).sort((a, b) => a - b);
  const a = flights.map(f => f.apex).sort((a, b) => a - b);
  const med = arr => arr[Math.floor(arr.length / 2)];
  console.log(`\n  ${flights.length} flights over ${SEEDS.length} seeds`);
  console.log(`  WALL-CLOCK air   min ${w[0].toFixed(2)}  median ${med(w).toFixed(2)}  max ${w[w.length - 1].toFixed(2)} s`);
  console.log(`  SIM air          min ${s[0].toFixed(2)}  median ${med(s).toFixed(2)}  max ${s[s.length - 1].toFixed(2)} s`);
  console.log(`  APEX             min ${a[0].toFixed(2)}  median ${med(a).toFixed(2)}  max ${a[a.length - 1].toFixed(2)} m`);
}
console.log('\n' + JSON.stringify(all));

finish(process.exitCode || 0);
