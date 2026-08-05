/* Why the car does not come back.
 *
 * tools/rlline.mjs says the AI spends hundreds of metres pinned at exactly
 * 1.05 m past the road edge — the physics containment wall — at around
 * 100 km/h. That is not a car wandering across a hillside and it is not
 * obviously a car that arrived too fast either: the same probe says it reached
 * those corners at 84–91% of the speed the radius will hold.
 *
 * So this traces one excursion frame by frame and prints the four things that
 * decide whether the car gets back:
 *
 *   what the steering is ASKING for, decomposed — pure pursuit, countersteer,
 *   yaw damping, edge containment — against the lock actually available at
 *   that speed. A car at full inward lock that is still going straight on has
 *   a grip problem, not a planner problem.
 *
 *   the speed the planner WANTS versus the speed the car is doing, and the
 *   pedal it is applying to close the gap.
 *
 *   the grip the car actually has where it is standing, which off the road is
 *   MU_BASE x 0.72 x 0.8 — 42% less than the planner assumed.
 *
 *   the radius the car could hold on that grip at that speed, against the
 *   radius of the road it is trying to rejoin.
 *
 *   node tools/rlgrind.mjs [--seed 22] [--from 3300] [--to 3900]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', 22);
const FROM = +flag('from', 3300);
const TO = +flag('to', 3900);
const SKILL = +flag('skill', 0.85);
const TAG = flag('tag', 'run');

const PROBE = ([from, to, skill]) => {
  const g = window.__game;
  const p = g.player;
  const t = g.track;
  const H = 1 / 120;

  g.restart();
  g.autopilot(true, skill);
  g.botInput = null;
  p.placeAt(34, 0);
  p.vx = 0; p.vy = 0; p.r = 0;
  p.raceTime = 0; p.finished = false;

  const rows = [];
  for (let i = 0; i < 400 * 120 && !p.finished; i++) {
    p.lastImpact = 0;
    g.step(H);
    if (p.strandedFor > 2.5) p.recover();
    if (p.s < from || p.s > to) continue;
    const f = t.frameAt(p.s);
    const hw = f.width * 0.5;
    const d = g.bot._dbg || {};
    const over = Math.abs(p.lat) - hw;
    /* Grip where the car is standing, in g, using the same terms physics.js
       uses: the off-road multiplier and the berm multiplier. MU_BASE is not
       exported, so this is expressed as a FRACTION of on-road grip and the
       absolute number is taken from the car's measured 1.08 g. */
    const offRoad = p.offRoad;
    const gripFrac = (1 - 0.28 * offRoad) * (over > 0 ? 0.8 : 1);
    const gAvail = 1.08 * gripFrac;
    const v = p.speed;
    rows.push({
      s: +p.s.toFixed(0),
      t: +p.raceTime.toFixed(2),
      lat: +p.lat.toFixed(2),
      over: +over.toFixed(2),
      hw: +hw.toFixed(1),
      kmh: +(v * 3.6).toFixed(0),
      want: +((d.want ?? 0) * 3.6).toFixed(0),
      R: +(1 / Math.max(Math.abs(f.curv), 1e-4)).toFixed(0),
      Rcan: +(v * v / Math.max(gAvail * 9.81, 0.1)).toFixed(0),
      gAvail: +gAvail.toFixed(2),
      offRoad: +offRoad.toFixed(2),
      pursuit: +(d.pursuit ?? 0).toFixed(3),
      slipT: +(d.slipTerm ?? 0).toFixed(3),
      yawT: +(d.yawTerm ?? 0).toFixed(3),
      contT: +(d.contTerm ?? 0).toFixed(3),
      dampT: +(d.dampTerm ?? 0).toFixed(3),
      angle: +(d.angle ?? 0).toFixed(3),
      lock: +(d.lock ?? 0).toFixed(3),
      steer: +(d.steer ?? 0).toFixed(2),
      tgtLat: +(d.tgtLat ?? 0).toFixed(2),
      thr: +p.throttle.toFixed(2),
      brk: +p.brake.toFixed(2),
      hb: +p.handbrake.toFixed(2),
      slip: +(p.slipAngle * 180 / Math.PI).toFixed(1),
      air: p.airborne ? 1 : 0,
      airT: +p.airTime.toFixed(2),
      h: +p.height.toFixed(2),
      vv: +p.vertVel.toFixed(1),
    });
  }
  return rows;
};

await run({ width: 480, height: 270, hash: `manual&tier=low&seed=${SEED}&cap=0&hud=0` },
  async ({ page }) => {
    const rows = await page.evaluate(PROBE, [FROM, TO, SKILL]);
    console.log(`\n═══ seed ${SEED} [${TAG}]  s ${FROM}..${TO}  ${rows.length} frames ═══\n`);
    console.log('    s   over    hw  kmh   R  Rcan  gAv  off | pursu  slip   yaw  cont  damp'
      + ' | angle  lock steer | tgtL  thr  brk  hb  slipdeg');
    // Every 12th frame: 10 Hz, which is fast enough to see a transient.
    for (let i = 0; i < rows.length; i += 12) {
      const r = rows[i];
      const pin = r.over > 1.0 ? '*' : ' ';
      const sat = Math.abs(r.steer) > 0.99 ? '!' : ' ';
      console.log(
        `${pin}${String(r.s).padStart(5)} ${String(r.over.toFixed(2)).padStart(6)}`
        + ` ${String(r.hw).padStart(5)} ${String(r.kmh).padStart(4)}`
        + ` ${String(r.R).padStart(4)} ${String(r.Rcan).padStart(5)}`
        + ` ${String(r.gAvail).padStart(4)} ${String(r.offRoad).padStart(4)} |`
        + ` ${String(r.pursuit).padStart(6)} ${String(r.slipT).padStart(5)}`
        + ` ${String(r.yawT).padStart(5)} ${String(r.contT).padStart(5)}`
        + ` ${String(r.dampT).padStart(5)} |`
        + ` ${String(r.angle).padStart(6)} ${String(r.lock).padStart(5)}`
        + `${String(r.steer).padStart(6)}${sat} |`
        + ` ${String(r.tgtLat).padStart(5)} ${String(r.thr).padStart(4)}`
        + ` ${String(r.brk).padStart(4)} ${String(r.hb).padStart(3)}`
        + ` ${String(r.slip).padStart(7)}`);
    }

    /* Airborne runs. A car that is off the ground has no tyres, so no steering
       and no brakes: if the excursion is mostly air then it is not a driving
       error being held by a wall, it is a flight, and the place to fix it is
       before the launch. */
    const flights = [];
    let fl = null;
    for (const r of rows) {
      if (r.air) { if (!fl) fl = { s0: r.s, t0: r.t, maxH: 0 }; fl.s1 = r.s; fl.t1 = r.t; fl.maxH = Math.max(fl.maxH, r.h); }
      else if (fl) { flights.push(fl); fl = null; }
    }
    if (fl) flights.push(fl);
    const big = flights.filter(f => f.t1 - f.t0 > 0.25).sort((a, b) => (b.t1 - b.t0) - (a.t1 - a.t0));
    console.log(`\n  ─── airborne runs over 0.25 s ───`);
    for (const f of big.slice(0, 10)) {
      console.log(`    s=${String(f.s0).padStart(5)}→${String(f.s1).padStart(5)}`
        + `  ${String((f.s1 - f.s0).toFixed(0)).padStart(4)} m`
        + `  ${(f.t1 - f.t0).toFixed(2)} s   peak height ${f.maxH.toFixed(2)} m`);
    }
    console.log(`    ${flights.length} airborne runs, ${big.length} over 0.25 s,`
      + ` ${((rows.filter(r => r.air).length / rows.length) * 100).toFixed(0)}% of the window in the air`);

    const off = rows.filter(r => r.over > 0);
    if (off.length) {
      const mean = (k) => +(off.reduce((a, r) => a + r[k], 0) / off.length).toFixed(2);
      const pinned = off.filter(r => r.over > 1.0);
      const satur = off.filter(r => Math.abs(r.steer) > 0.99);
      /* Is the wheel pointed back at the road? contTerm's sign is already
         "away from the edge the car is on", so a negative product means the
         total command opposes the containment term. */
      const fighting = off.filter(r => r.contT !== 0 && r.angle * r.contT < 0);
      const cannot = off.filter(r => r.Rcan > r.R);
      console.log(`\n  ─── while past the true edge (${off.length} frames) ───`);
      console.log(`  mean speed ${(mean('kmh'))} km/h   mean over ${mean('over')} m`
        + `   pinned at the wall ${((pinned.length / off.length) * 100).toFixed(0)}%`);
      console.log(`  steering saturated at full lock ${((satur.length / off.length) * 100).toFixed(0)}%`
        + `   total command opposes containment ${((fighting.length / off.length) * 100).toFixed(0)}%`);
      console.log(`  mean grip available ${mean('gAvail')} g (on road 1.08)`
        + `   mean brake ${mean('brk')}   mean throttle ${mean('thr')}`);
      console.log(`  radius the car COULD hold ${mean('Rcan')} m against road radius ${mean('R')} m`
        + `   — physically cannot rejoin on ${((cannot.length / off.length) * 100).toFixed(0)}% of frames`);
      console.log(`  planner wanted ${mean('want')} km/h while doing ${mean('kmh')} km/h`);
      console.log(`  AIRBORNE on ${((off.filter(r => r.air).length / off.length) * 100).toFixed(0)}%`
        + ` of frames past the edge — a car with no tyres has no steering and no brakes`);
    }
    fs.writeFileSync(path.join(ROOT, '.fix', `rlgrind-${TAG}-s${SEED}.json`),
      JSON.stringify(rows, null, 1));
  });

finish(process.exitCode || 0);
