/* The other half of the complaint: "turns AND airbornes".
 *
 * Three questions, none of which the suite currently asks.
 *
 *   J. IN THE AIR. Physics gives an airborne car `r += steer * 0.9 * dt`,
 *      where `steer` is the ROAD-WHEEL angle — a quantity steerLockAt has
 *      already shrunk by a factor of four between a hairpin and a straight.
 *      Nothing about pointing a car that has left the ground has anything to
 *      do with how much lock the front tyres would want at that speed, so
 *      this measures what authority the player is actually left with, at the
 *      speeds the ramps are taken at.
 *
 *   L. THE LANDING. How far off the road the car is pointing when it touches
 *      down, and how long it takes to be driveable again.
 *
 *   W. THE ROAD. Whether width is the binding constraint in a corner or
 *      whether the car is. The user believes it is width. That is a
 *      measurable claim: compare the radius the car can hold at the speed it
 *      arrives with the radius the corner asks for, and the lateral room the
 *      corner actually consumes with the room it has.
 *
 *   node tools/zxair.mjs [--seeds 22] [--pass J,L,W]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22').split(',').map(Number);
const PASSES = flag('pass', 'J,L,W').split(',');

const PROBE = ([passes]) => {
  const g = window.__game;
  const p = g.player;
  const t = g.track;
  const DEG = 180 / Math.PI;
  const H = 1 / 120;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  g.freeCam = true;
  g.setPaused(true);
  const res = { seed: t.seed };

  /* ---- J / L: fly each ramp, with and without the wheel held ----------- */
  if (passes.includes('J') || passes.includes('L')) {
    const flights = [];
    const ramps = (t.ramps || []).slice();
    for (const ramp of ramps) {
      for (const hold of [0, 1]) {
        /* Arrive at the lip at racing pace on the racing line rather than
           teleported onto it — a parked car cannot jump and a car dropped on
           the up-face is not the same event. */
        g.restart();
        g.autopilot(true, 0.9);
        g.countdown.skip(); g.ending.skip();
        const lipS = ramp.lip ?? ramp.s ?? 0;
        g.goTo(Math.max(6, lipS - 210) / t.length);
        let guard = 0;
        while (p.s < lipS - 12 && guard++ < 40 * 120) g.step(H);
        g.autopilot(false);
        const launchKmh = p.kmh;

        /* From here the player has the wheel: full lock held for the whole
           flight, or nothing, and no pedals — which is what a jump is. */
        const trace = [];
        let armed = false, airT = 0, wallT = 0, peakH = 0;
        let yawAtLift = 0, rAtLand = 0, headingErrLand = 0, landKmh = 0;
        let landed = false, landSlip = 0, recoverT = null, latAtLand = 0;
        let peakSlipAfter = 0, latWorstAfter = 0, sinceLand = 0;
        let impactsAfter = 0;
        for (let i = 0; i < 9 * 120; i++) {
          g.botInput = { steer: hold, throttle: 0, brake: 0, handbrake: 0 };
          const scale = g.timeScale();
          g.step(H);
          if (p.airborne && !armed) {
            armed = true;
            yawAtLift = p.yaw;
          }
          if (armed && p.airborne) {
            airT += H; wallT += H / Math.max(scale, 1e-3);
            peakH = Math.max(peakH, p.height);
            trace.push([+airT.toFixed(3), +(p.r * DEG).toFixed(2),
              +(p.steer * DEG).toFixed(2), +p.height.toFixed(2)]);
          }
          if (armed && !p.airborne && !landed) {
            landed = true;
            const f = t.frameAt(p.s);
            rAtLand = p.r;
            /* Heading error against the road at the moment of contact. This
               is what the tyres have to resolve, and they resolve it as slip. */
            headingErrLand = Math.atan2(p.right.dot(f.tan), p.forward.dot(f.tan));
            landKmh = p.kmh;
            landSlip = Math.abs(p.slipAngle);
            latAtLand = p.lat;
          }
          if (landed) {
            sinceLand += H;
            peakSlipAfter = Math.max(peakSlipAfter, Math.abs(p.slipAngle));
            latWorstAfter = Math.max(latWorstAfter, Math.abs(p.lat));
            if (p.lastImpact > 0.06) impactsAfter++;
            if (recoverT === null && sinceLand > 0.1
              && Math.abs(p.slipAngle) < 0.09 && !p.airborne) recoverT = sinceLand;
            if (sinceLand > 3.0) break;
          }
        }
        g.botInput = null;
        /* Degrees the car was turned through during the flight. The trace is
           already in degrees per second, so this integrates and stops — the
           first version multiplied by 180/pi a second time and reported six
           full rotations for a 41° swing. */
        const yawSwept = trace.reduce((a, x, i) => a + (i ? Math.abs(x[1]) * H : 0), 0);
        flights.push({
          lipS: +lipS.toFixed(0), hold, launchKmh: +launchKmh.toFixed(0),
          airSimSec: +airT.toFixed(2), airWallSec: +wallT.toFixed(2),
          peakHeightM: +peakH.toFixed(2),
          lockInAirDeg: trace.length
            ? +Math.max(...trace.map(x => Math.abs(x[2]))).toFixed(2) : 0,
          peakAirYawDegSec: trace.length
            ? +Math.max(...trace.map(x => Math.abs(x[1]))).toFixed(2) : 0,
          /* The whole point: how many degrees the player was able to turn the
             car through, over the entire flight, by holding the wheel. */
          yawSweptDeg: +yawSwept.toFixed(1),
          headingErrLandDeg: +(headingErrLand * DEG).toFixed(1),
          rAtLand: +rAtLand.toFixed(3),
          landKmh: +landKmh.toFixed(0),
          landSlipDeg: +(landSlip * DEG).toFixed(1),
          peakSlipAfterDeg: +(peakSlipAfter * DEG).toFixed(1),
          recoverSec: recoverT === null ? null : +recoverT.toFixed(2),
          latAtLand: +latAtLand.toFixed(2),
          latWorstAfter: +latWorstAfter.toFixed(2),
          impactsAfter,
        });
      }
    }
    res.flights = flights;
  }

  /* ---- W: is width the constraint, or the car? -------------------------- */
  if (passes.includes('W')) {
    /* Corners as runs of same-signed curvature past a threshold, taken off
       the frames rather than the plan so what is measured is where the road
       actually is. */
    const corners = [];
    let cur = null;
    for (let i = 0; i < t.count; i++) {
      const f = t.frames[i];
      const c = f.curv;
      if (Math.abs(c) > 0.005) {
        const hand = Math.sign(c);
        if (!cur || cur.hand !== hand) {
          cur = { hand, i0: i, i1: i, peak: c, wmin: f.width, wmax: f.width };
          corners.push(cur);
        } else {
          cur.i1 = i;
          if (Math.abs(c) > Math.abs(cur.peak)) cur.peak = c;
          cur.wmin = Math.min(cur.wmin, f.width);
          cur.wmax = Math.max(cur.wmax, f.width);
        }
      } else if (Math.abs(c) < 0.002) cur = null;
    }
    for (const c of corners) {
      c.s0 = +t.frames[c.i0].s.toFixed(0);
      c.s1 = +t.frames[c.i1].s.toFixed(0);
      c.radius = +Math.abs(1 / c.peak).toFixed(0);
      c.lenM = +(c.s1 - c.s0).toFixed(0);
      c.wmin = +c.wmin.toFixed(1);
      delete c.i0; delete c.i1; delete c.peak;
    }

    /* Now drive the stage and record, per corner, the room used and the
       curvature achieved against the curvature asked for. */
    g.restart();
    g.autopilot(true, 0.85);
    g.countdown.skip(); g.ending.skip();
    const seen = new Map();
    let prevBeta = 0;
    /* Path curvature needs the rate of change of body slip, and a one-substep
       difference of that is violent — a kerb strike puts a single 200 g sample
       in the trace and any peak-of-raw metric reports it. Median of a 75 ms
       window keeps the shape of the corner and drops the spikes. */
    const ring = [];
    const median = a => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
    for (let i = 0; i < 300 * 120 && !p.finished; i++) {
      g.step(H);
      const beta = Math.atan2(p.vy, Math.abs(p.vx) + 0.5);
      ring.push(p.r + (beta - prevBeta) / H);
      if (ring.length > 9) ring.shift();
      prevBeta = beta;
      const pathRate = median(ring);
      if (p.airborne || p.speed < 6) continue;
      const c = corners.find(x => p.s >= x.s0 && p.s <= x.s1);
      if (!c) continue;
      let e = seen.get(c);
      if (!e) {
        e = { latMin: 9, latMax: -9, kmhIn: p.kmh, needSum: 0, gotSum: 0, n: 0,
          worstShort: 0, gs: [], offRoad: 0, wmin: 99 };
        seen.set(c, e);
      }
      const f = t.frameAt(p.s);
      e.latMin = Math.min(e.latMin, p.lat); e.latMax = Math.max(e.latMax, p.lat);
      e.wmin = Math.min(e.wmin, f.width);
      const need = Math.abs(f.curv), got = Math.abs(pathRate) / Math.max(p.speed, 1);
      e.needSum += need; e.gotSum += got; e.n++;
      e.worstShort = Math.max(e.worstShort, need > 1e-4 ? 1 - got / need : 0);
      e.gs.push(Math.abs(p.speed * pathRate) / 9.81);
      if (p.offRoad > 0.5) e.offRoad++;
    }
    g.autopilot(false);
    res.corners = corners.map(c => {
      const e = seen.get(c);
      if (!e || e.n < 10) return { ...c, driven: false };
      /* The radius the car could hold at the speed it arrived, taken from the
         grip it actually demonstrated in the corner. */
      const v = e.kmhIn / 3.6;
      /* Sustained grip, not the single best sample: the 90th percentile of the
         corner's lateral g. A peak flatters the car and a mean understates it. */
      const sorted = e.gs.slice().sort((a, b) => a - b);
      const gHeld = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
      return {
        ...c, driven: true,
        kmhIn: +e.kmhIn.toFixed(0),
        roomUsedM: +(e.latMax - e.latMin).toFixed(1),
        roomAvailM: +(e.wmin - 2.02).toFixed(1),
        roomUsedPct: +(((e.latMax - e.latMin) / (e.wmin - 2.02)) * 100).toFixed(0),
        meanShortfall: +(1 - e.gotSum / Math.max(e.needSum, 1e-6)).toFixed(3),
        worstShortfall: +e.worstShort.toFixed(3),
        peakG: +gHeld.toFixed(2),
        gripRadiusM: +((v * v) / Math.max(gHeld * 9.81, 0.1)).toFixed(0),
        offRoadFrames: e.offRoad,
      };
    });
  }

  g.setPaused(false);
  return res;
};

const all = {};
for (const seed of SEEDS) {
  await run({ width: 480, height: 270, hash: `manual&tier=low&seed=${seed}&cap=0&hud=0` },
    async ({ page }) => {
      const out = await page.evaluate(PROBE, [PASSES]);
      all[seed] = out;
      console.log(`\n═══ seed ${out.seed} ═══`);

      if (out.flights) {
        console.log('\n  PASS J/L — every ramp, flown with the wheel released and held');
        console.log('   lip   hold  launch   air(sim/wall)  apex   lock    peak yaw' +
          '   swept   heading@land  slip@land  peak slip  recover');
        for (const f of out.flights) {
          console.log(`  ${String(f.lipS).padStart(5)}  ${f.hold ? 'FULL' : ' off'} ` +
            `${String(f.launchKmh).padStart(5)} km/h  ${String(f.airSimSec).padStart(4)}/` +
            `${String(f.airWallSec).padStart(4)}s ${String(f.peakHeightM).padStart(6)} m ` +
            `${String(f.lockInAirDeg).padStart(6)}° ${String(f.peakAirYawDegSec).padStart(7)}°/s` +
            ` ${String(f.yawSweptDeg).padStart(6)}° ` +
            `${String(f.headingErrLandDeg).padStart(9)}° ` +
            `${String(f.landSlipDeg).padStart(9)}° ${String(f.peakSlipAfterDeg).padStart(9)}° ` +
            `${String(f.recoverSec ?? 'never').padStart(7)}`);
        }
        const held = out.flights.filter(f => f.hold);
        const free = out.flights.filter(f => !f.hold);
        const mean = (a, k) => a.length ? a.reduce((s, x) => s + (x[k] ?? 0), 0) / a.length : 0;
        console.log(`\n    holding full lock for a whole flight turns the car ` +
          `${mean(held, 'yawSweptDeg').toFixed(1)}° ` +
          `(released: ${mean(free, 'yawSweptDeg').toFixed(1)}°)`);
        console.log(`    mean air time ${mean(held, 'airSimSec').toFixed(2)} s sim / ` +
          `${mean(held, 'airWallSec').toFixed(2)} s of the player's, at ` +
          `${mean(held, 'launchKmh').toFixed(0)} km/h, apex ${mean(held, 'peakHeightM').toFixed(2)} m`);
        console.log(`    road-wheel lock available in the air: ` +
          `${mean(held, 'lockInAirDeg').toFixed(2)}° of the 35.5° the car has at rest`);
        console.log(`    slip on touchdown ${mean(held, 'landSlipDeg').toFixed(1)}°, ` +
          `peaks at ${mean(held, 'peakSlipAfterDeg').toFixed(1)}° after it`);
      }

      if (out.corners) {
        const d = out.corners.filter(c => c.driven);
        console.log('\n  PASS W — is the road the constraint, or the car?');
        console.log('     s0   len   R    width  kmh   room used / avail   peak g' +
          '   grip R   shortfall');
        for (const c of d.sort((a, b) => a.radius - b.radius).slice(0, 16)) {
          console.log(`  ${String(c.s0).padStart(5)} ${String(c.lenM).padStart(5)} ` +
            `${String(c.radius).padStart(4)} ${String(c.wmin).padStart(6)} m ` +
            `${String(c.kmhIn).padStart(4)}  ${String(c.roomUsedM).padStart(5)} / ` +
            `${String(c.roomAvailM).padStart(4)} m = ${String(c.roomUsedPct).padStart(3)}%  ` +
            `${String(c.peakG).padStart(5)}  ${String(c.gripRadiusM).padStart(5)} m  ` +
            `${String(c.meanShortfall).padStart(6)}`);
        }
        const tightest = d.filter(c => c.radius <= 60);
        const mean = (a, k) => a.length ? a.reduce((s, x) => s + x[k], 0) / a.length : 0;
        console.log(`\n    ${d.length} corners driven, ${tightest.length} tighter than 60 m`);
        console.log(`    mean room used ${mean(d, 'roomUsedPct').toFixed(0)}% of what the ` +
          `road gives (${mean(d, 'roomUsedM').toFixed(1)} of ${mean(d, 'roomAvailM').toFixed(1)} m)`);
        console.log(`    worst room use: ${Math.max(...d.map(c => c.roomUsedPct))}%`);
        const binding = d.filter(c => c.gripRadiusM > c.radius * 1.05);
        console.log(`    corners where the car could NOT hold the radius at the speed it ` +
          `arrived: ${binding.length} of ${d.length}`);
        if (binding.length) {
          console.log('      ' + binding.slice(0, 8).map(c =>
            `s=${c.s0} R=${c.radius} needs ${c.gripRadiusM}`).join('; '));
        }
      }
    });
}
fs.mkdirSync(path.join(ROOT, 'shots', 'zxturn'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'shots', 'zxturn', 'air.json'), JSON.stringify(all, null, 1));
console.log('\n  → shots/zxturn/air.json');
finish(process.exitCode || 0);
