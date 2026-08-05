/* Rotational lag, measured.
 *
 * One AI lap is driven and recorded, then replayed through two cameras — lag
 * on and lag off — so the comparison is the same car on the same line and the
 * only variable is the thing under test. Per frame:
 *
 *   yawErr   — angle in plan between the boom (car → lens, reversed) and the
 *              car's actual direction of travel. This is the lag, measured on
 *              the lens rather than read out of the camera's own state, so a
 *              bookkeeping bug cannot hide in it.
 *   carNdc   — where the car ends up on screen. Positive x is right, and ±1 is
 *              the edge of the frame. This is the legibility budget.
 *   aheadNdc — where the road forty metres ahead lands. If this leaves the
 *              frame the camera has stopped showing the player the corner.
 *
 *   node tools/camyaw.mjs [--skill 0.85]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const skill = +flag('skill', 0.85);
const DEG = 180 / Math.PI;

await run({ width: 1600, height: 900, hash: 'manual&tier=high&seed=22&cap=0&hud=0' }, async ({ page }) => {
  const out = await page.evaluate(skill => {
    const g = window.__game;
    const THREE = g.THREE;
    const V = v => [v.x, v.y, v.z];

    g.setPaused(true);

    /* Fingerprint of the car build this lap was driven on, so a stale bundle
       or a mid-edit stage cannot quietly be mistaken for a result. Snap the
       wheel to full lock from rest and time the rise to 90% of where it
       settles. */
    const riseTime = (() => {
      g.goTo(0.05);
      g.botInput = { steer: 0, throttle: 0, brake: 0, handbrake: false };
      for (let i = 0; i < 30; i++) g.step(1 / 60);
      g.botInput = { steer: 1, throttle: 0, brake: 0, handbrake: false };
      const trace = [];
      for (let i = 0; i < 120; i++) { g.step(1 / 240); trace.push(g.player.steer); }
      g.botInput = null;
      const settled = trace[trace.length - 1];
      const i90 = trace.findIndex(v => v >= settled * 0.9);
      return { ms: i90 < 0 ? -1 : (i90 + 1) * 1000 / 240, lock: settled * 180 / Math.PI };
    })();

    g.autopilot(true, skill);
    g.goTo(0.002);
    const tape = [];
    const len = g.track.length;
    let guard = 0;
    let prevSteer = 0;
    const steerRates = [];
    while (g.player.s < len - 45 && guard++ < 60 * 60 * 6) {
      g.step(1 / 60);
      const p = g.player;
      /* p99 rather than max: one respawn or sign flip in fifteen thousand
         frames otherwise sets this number by itself. */
      steerRates.push(Math.abs(p.steer - prevSteer) * 60);
      prevSteer = p.steer;
      const f = g.track.frameAt(Math.min(len, p.s + 40));
      tape.push({
        pos: V(p.pos), up: V(p.up), forward: V(p.forward), right: V(p.right),
        vx: p.vx, vy: p.vy, speed: p.speed, r: p.r, roll: p.roll,
        slip: p.slipAngle, throttle: p.throttle, s: p.s, kmh: p.kmh,
        curv: g.track.frameAt(p.s).curv,
        ahead: V(f.pos),
      });
    }
    g.autopilot(false);

    const ChaseCamera = Object.getPrototypeOf(g.chase).constructor;
    const stub = () => ({
      pos: new THREE.Vector3(), up: new THREE.Vector3(), forward: new THREE.Vector3(),
      right: new THREE.Vector3(), vx: 0, vy: 0, speed: 0, r: 0, roll: 0, throttle: 0,
    });
    const wrapPi = a => {
      const t = (a + Math.PI) % (Math.PI * 2);
      return (t < 0 ? t + Math.PI * 2 : t) - Math.PI;
    };

    const replay = lag => {
      const cam3 = new THREE.PerspectiveCamera(62, 16 / 9, 0.4, 4000);
      const cam = new ChaseCamera(cam3);
      cam.world = g.solid;
      cam.collideEnabled = true;
      cam.yawLagEnabled = lag;
      cam.shakeEnabled = false;          // shake is noise here and is unchanged
      const car = stub();
      const travel = new THREE.Vector3();
      const boom = new THREE.Vector3();
      const v = new THREE.Vector3();
      const rows = [];
      for (const f of tape) {
        car.pos.fromArray(f.pos); car.up.fromArray(f.up);
        car.forward.fromArray(f.forward); car.right.fromArray(f.right);
        car.vx = f.vx; car.vy = f.vy; car.speed = f.speed;
        car.r = f.r; car.roll = f.roll; car.throttle = f.throttle;
        cam.update(car, 1 / 60, {});
        cam3.updateMatrixWorld(true);
        cam3.updateProjectionMatrix();

        /* Direction of travel, reconstructed the same way the camera does it,
           so the measurement is of the lag and not of a definition mismatch. */
        travel.copy(car.forward).multiplyScalar(car.vx).addScaledVector(car.right, car.vy);
        if (travel.lengthSq() < 4) travel.copy(car.forward); else travel.normalize();
        travel.lerp(car.forward, 0.22).normalize();
        boom.copy(car.pos).sub(cam3.position);      // lens → car, i.e. where the boom points
        const yawErr = wrapPi(Math.atan2(boom.x, boom.z) - Math.atan2(travel.x, travel.z));

        /* project() on a point behind the near plane returns a mirrored value
           with a huge magnitude, and averaging those in makes the screen
           statistics meaningless. Depth is checked in view space first. */
        const behind = p => { v.copy(p).applyMatrix4(cam3.matrixWorldInverse); return v.z > -0.4; };
        const carBehind = behind(car.pos);
        v.copy(car.pos).project(cam3);
        const carNdc = [v.x, v.y];
        const aheadV = new THREE.Vector3().fromArray(f.ahead);
        const aheadBehind = behind(aheadV);
        v.copy(aheadV).project(cam3);
        const aheadNdc = [v.x, v.y];

        rows.push({
          s: +f.s.toFixed(1), t: +(f.s / len).toFixed(4), kmh: +f.kmh.toFixed(0),
          curv: +f.curv.toFixed(5),
          yawErr: +(yawErr * (180 / Math.PI)).toFixed(2),
          state: +(cam.yawLag * (180 / Math.PI)).toFixed(2),
          occl: +cam.occl.toFixed(3),
          /* Total roll of the horizon on screen, recovered from the camera
             rather than recomputed: it is the explicit dutch plus whatever the
             blended up-vector contributes on a banked road, and the sum is
             what a player's inner ear is offered. */
          tilt: +(new THREE.Euler().setFromQuaternion(cam3.quaternion, 'YXZ').z * (180 / Math.PI)).toFixed(3),
          roll: +(f.roll * (180 / Math.PI)).toFixed(2),
          yawRate: +(f.r * (180 / Math.PI)).toFixed(2),
          slip: +(f.slip * (180 / Math.PI)).toFixed(1),
          carX: +carNdc[0].toFixed(3), carY: +carNdc[1].toFixed(3), carBehind,
          aheadX: +aheadNdc[0].toFixed(3), aheadY: +aheadNdc[1].toFixed(3),
          aheadOn: !aheadBehind && Math.abs(aheadNdc[0]) <= 1 && Math.abs(aheadNdc[1]) <= 1,
        });
      }
      return rows;
    };

    const off = replay(false);
    const on = replay(true);

    /* Cost of the lag itself. */
    const cam3 = new THREE.PerspectiveCamera(62, 16 / 9, 0.4, 4000);
    const cam = new ChaseCamera(cam3);
    cam.world = g.solid; cam.collideEnabled = true; cam.shakeEnabled = false;
    const car = stub();
    /* Interleaved, best-of-nine. A single before/after pair swings by tens of
       percent run to run, which is many times the size of the thing being
       measured, so the two configurations alternate and the least-interrupted
       pass of each is the one reported. */
    const onePass = lag => {
      cam.yawLagEnabled = lag; cam.started = false;
      const t0 = performance.now();
      for (const f of tape) {
        car.pos.fromArray(f.pos); car.up.fromArray(f.up);
        car.forward.fromArray(f.forward); car.right.fromArray(f.right);
        car.vx = f.vx; car.vy = f.vy; car.speed = f.speed;
        car.r = f.r; car.roll = f.roll; car.throttle = f.throttle;
        cam.update(car, 1 / 60, {});
      }
      return (performance.now() - t0) / tape.length;
    };
    const timeIt = lag => {
      let best = Infinity;
      for (let i = 0; i < 9; i++) best = Math.min(best, onePass(lag));
      return best;
    };
    onePass(false); onePass(true);
    /* Settling, on a synthetic straight rather than on a filtered lap. The lap
       has no section long enough to be sure a residual is a residual and not
       the tail of the last corner: this drives a hard step of yaw into the
       camera and then holds the car perfectly straight, so whatever is left
       after a second is genuinely a permanent offset. */
    const settle = hz => {
      const cam3 = new THREE.PerspectiveCamera(62, 16 / 9, 0.4, 4000);
      const c = new ChaseCamera(cam3);
      c.world = null; c.shakeEnabled = false; c.yawLagEnabled = true;
      const car = stub();
      const dt = 1 / hz;
      const rows = [];
      let yaw = 0;
      for (let i = 0; i < 5 * hz; i++) {
        // 0.0–1.0 s: 60 deg/s of yaw. After that, dead straight at 150 km/h.
        const turning = i < hz;
        if (turning) yaw += (Math.PI / 3) * dt;
        car.forward.set(Math.sin(yaw), 0, Math.cos(yaw));
        car.right.set(Math.cos(yaw), 0, -Math.sin(yaw));
        car.up.set(0, 1, 0);
        car.vx = 41.7; car.vy = 0; car.speed = 41.7;
        car.r = turning ? Math.PI / 3 : 0; car.roll = 0; car.throttle = 1;
        car.pos.addScaledVector(car.forward, 41.7 * dt);
        c.update(car, dt, {});
        const bx = car.pos.x - cam3.position.x, bz = car.pos.z - cam3.position.z;
        rows.push({
          sec: +(i * dt).toFixed(4),
          err: +(wrapPi(Math.atan2(bx, bz) - yaw) * (180 / Math.PI)).toFixed(3),
        });
      }
      return rows;
    };

    /* The seam. A car spinning at 300 deg/s crosses ±180° five times in two
       seconds, and a lag that subtracts absolute angles anywhere will send the
       camera the long way round on every crossing — which shows up here as an
       error near 360° rather than near the cap. */
    const spin = (() => {
      const cam3 = new THREE.PerspectiveCamera(62, 16 / 9, 0.4, 4000);
      const c = new ChaseCamera(cam3);
      c.world = null; c.shakeEnabled = false; c.yawLagEnabled = true;
      const car = stub();
      let yaw = 0, worst = 0, worstStep = 0, prev = null;
      const rows = [];
      for (let i = 0; i < 240; i++) {
        yaw += (300 * Math.PI / 180) / 60;
        car.forward.set(Math.sin(yaw), 0, Math.cos(yaw));
        car.right.set(Math.cos(yaw), 0, -Math.sin(yaw));
        car.up.set(0, 1, 0);
        car.vx = 25; car.vy = 0; car.speed = 25;
        car.r = 300 * Math.PI / 180; car.roll = 0; car.throttle = 0;
        car.pos.addScaledVector(car.forward, 25 / 60);
        c.update(car, 1 / 60, {});
        const e = Math.abs(c.yawLag) * 180 / Math.PI;
        if (e > worst) worst = e;
        /* How far the boom swung in one frame. A seam bug is a single frame
           with hundreds of degrees in it. */
        const bx = car.pos.x - cam3.position.x, bz = car.pos.z - cam3.position.z;
        const b = Math.atan2(bx, bz);
        if (prev !== null) worstStep = Math.max(worstStep, Math.abs(wrapPi(b - prev)) * 180 / Math.PI);
        prev = b;
        rows.push(+(c.yawLag * 180 / Math.PI).toFixed(2));
      }
      return { worst, worstStep, rows };
    })();

    return {
      off, on, spin, frames: tape.length,
      riseTime,
      steerRate: steerRates.sort((a, b) => a - b)[Math.floor(steerRates.length * 0.99)] * 180 / Math.PI,
      settle: settle(60),
      rates: [24, 30, 60, 120, 144].map(hz => ({ hz, rows: settle(hz) })),
      costOff: timeIt(false), costOn: timeIt(true),
    };
  }, skill);

  const abs = rows => rows.map(r => Math.abs(r.yawErr));
  const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

  const straight = out.on.filter(r => Math.abs(r.curv) < 0.0008 && r.kmh > 60);
  const corners = out.on.filter(r => Math.abs(r.curv) > 0.008);
  const fastSweep = out.on.filter(r => Math.abs(r.curv) > 0.003 && Math.abs(r.curv) < 0.009 && r.kmh > 110);
  const slow = out.on.filter(r => r.kmh < 25);

  console.log(`  ${out.frames} frames`);
  console.log(`  car build: steering rises to 90% of ${out.riseTime.lock.toFixed(1)}° lock in ${out.riseTime.ms.toFixed(0)} ms`
    + `  (400 ms was the old filter, 167 ms the new one)`);
  console.log(`  bot's wheel moves at up to ${out.steerRate.toFixed(0)}°/s against the`
    + ` ${(out.riseTime.lock * 0.9 / (out.riseTime.ms / 1000)).toFixed(0)}°/s the filter can deliver\n`);
  console.log('  yaw error of the boom against the car\'s direction of travel, degrees');
  console.log(`  ${''.padEnd(34)} ${'LAG OFF'.padStart(9)}  ${'LAG ON'.padStart(9)}`);
  const cmp = (label, filter) => {
    const a = abs(out.off.filter(filter)), b = abs(out.on.filter(filter));
    if (!a.length) return;
    console.log(`  ${label.padEnd(34)} ${(pct(a, 0.5)).toFixed(2).padStart(9)}  ${(pct(b, 0.5)).toFixed(2).padStart(9)}   median`
      + `   (p95 ${pct(a, 0.95).toFixed(2)} / ${pct(b, 0.95).toFixed(2)},  max ${Math.max(...a).toFixed(2)} / ${Math.max(...b).toFixed(2)})`);
  };
  cmp('everywhere', () => true);
  cmp('straight, over 60 km/h', r => Math.abs(r.curv) < 0.0008 && r.kmh > 60);
  cmp('fast sweeper, over 110 km/h', r => Math.abs(r.curv) > 0.003 && Math.abs(r.curv) < 0.009 && r.kmh > 110);
  cmp('tight corner', r => Math.abs(r.curv) > 0.008);
  cmp('under 25 km/h', r => r.kmh < 25);

  /* Filtering the lap by road curvature is not a test for a residual offset:
     the road being straight does not mean the car is, and the AI corrects
     constantly at 200 km/h. The honest filter is the un-lagged camera itself —
     wherever *it* sits dead astern the car is genuinely not turning, so
     whatever the lagged camera shows at those same frames is a real standing
     offset and not the lag doing its job on real motion. */
  console.log('\n  residual offset, at the frames where the un-lagged camera is already dead astern');
  for (const thr of [0.5, 0.25, 0.1]) {
    const idx = [];
    for (let i = 0; i < out.on.length; i++) if (Math.abs(out.off[i].yawErr) < thr && out.on[i].kmh > 60) idx.push(i);
    const a = idx.map(i => Math.abs(out.on[i].yawErr));
    console.log(`    lag-off within ${thr.toFixed(2)}°  ${String(idx.length).padStart(5)} frames`
      + `   lag-on median ${pct(a, 0.5).toFixed(2)}°`
      + `   signed mean ${(idx.reduce((s, i) => s + out.on[i].yawErr, 0) / idx.length).toFixed(3)}°`
      + `   p95 ${pct(a, 0.95).toFixed(2)}° (the catch-up tail)`);
  }
  console.log(`\n  for contrast, filtered by road curvature instead (|curv| < 0.0008, over 60 km/h):`
    + ` ${straight.length} frames, median ${pct(abs(straight), 0.5).toFixed(2)}°`
    + ` — the road is straight there but the car is not`);

  console.log('\n  settling: 60 deg/s of yaw for one second, then dead straight');
  const marks = [0.0, 0.5, 0.98, 1.05, 1.2, 1.4, 1.7, 2.0, 2.5, 3.0, 4.0, 4.98];
  console.log('    t (s)  ' + marks.map(m => m.toFixed(2).padStart(7)).join(''));
  console.log('    err    ' + marks.map(m => {
    const r = out.settle.reduce((b, x) => Math.abs(x.sec - m) < Math.abs(b.sec - m) ? x : b);
    return r.err.toFixed(2).padStart(7);
  }).join(''));
  const tail = out.settle.filter(r => r.sec > 3);
  console.log(`    residual after three seconds of straight: max |err| ${Math.max(...tail.map(r => Math.abs(r.err))).toFixed(4)}°`);

  console.log('\n  seam: two seconds of 300 deg/s spin, five crossings of ±180°');
  console.log(`    largest lag reached    ${out.spin.worst.toFixed(2)}°  (cap is 14.90°)`);
  console.log(`    largest one-frame boom swing  ${out.spin.worstStep.toFixed(2)}°`
    + `  — a wrap bug puts a near-360° step here`);

  console.log('\n  the same manoeuvre at five frame rates — the curves must coincide');
  console.log('    fps    ' + marks.map(m => m.toFixed(2).padStart(7)).join(''));
  const at = (rows, m) => rows.reduce((b, x) => Math.abs(x.sec - m) < Math.abs(b.sec - m) ? x : b).err;
  for (const { hz, rows } of out.rates) {
    console.log(`    ${String(hz).padStart(3)}    ` + marks.map(m => at(rows, m).toFixed(2).padStart(7)).join(''));
  }
  const spread = marks.map(m => {
    const v = out.rates.map(({ rows }) => at(rows, m));
    return Math.max(...v) - Math.min(...v);
  });
  console.log(`    widest disagreement between 24 fps and 144 fps: ${Math.max(...spread).toFixed(3)}°`);

  const legible = (label, rows) => {
    const vis = rows.filter(r => !r.carBehind);
    const cx = vis.map(r => Math.abs(r.carX)), cy = vis.map(r => Math.abs(r.carY));
    const offAhead = rows.filter(r => !r.aheadOn).length;
    const lost = rows.filter(r => r.carBehind || Math.abs(r.carX) > 1 || Math.abs(r.carY) > 1).length;
    console.log(`    ${label.padEnd(10)} car |x| p99 ${pct(cx, 0.99).toFixed(3)} max ${Math.max(...cx).toFixed(3)}`
      + `   |y| max ${Math.max(...cy).toFixed(3)}`
      + `   car off-frame ${lost}`
      + `   road 40 m ahead off-frame ${offAhead} (${(offAhead / rows.length * 100).toFixed(2)}%)`);
  };
  console.log('\n  legibility — normalised screen coordinates, 1.0 is the frame edge');
  legible('lag off', out.off);
  legible('lag on', out.on);
  console.log('\n  legibility through tight corners only');
  legible('lag off', out.off.filter(r => Math.abs(r.curv) > 0.008));
  legible('lag on', corners);

  /* The dutch. The question is not how big it gets but how much of the time it
     is saturated: a term that spends a corner pinned at its limit is not
     reporting anything about that corner, it is just on. */
  const DEG = 180 / Math.PI;
  const raw = r => -(r.yawRate / DEG) * 0.11 - (r.roll / DEG) * 0.35;
  const CLAMP = 0.075;
  const all = out.on, hard = out.on.filter(r => Math.abs(r.roll) > 4);
  const rawAbs = all.map(r => Math.abs(raw(r)));
  const pinned = all.filter(r => Math.abs(raw(r)) >= CLAMP - 1e-4);
  const pinnedHard = hard.filter(r => Math.abs(raw(r)) >= CLAMP - 1e-4);
  /* The expression is a sum of two corner signals, and whether they reinforce
     or partially cancel decides whether re-weighting them is a tuning change
     or a repair. */
  const rateTerm = r => -(r.yawRate / DEG) * 0.11;
  const rollTerm = r => -(r.roll / DEG) * 0.35;
  const moving = all.filter(r => r.kmh > 25);
  const agree = moving.filter(r => rateTerm(r) * rollTerm(r) > 0).length;
  console.log('\n  the two halves of the dutch expression, over the lap, above 25 km/h');
  console.log(`    from yaw rate   p50 ${(pct(moving.map(r => Math.abs(rateTerm(r))), 0.5) * DEG).toFixed(2)}°`
    + `  p95 ${(pct(moving.map(r => Math.abs(rateTerm(r))), 0.95) * DEG).toFixed(2)}°`);
  console.log(`    from body roll  p50 ${(pct(moving.map(r => Math.abs(rollTerm(r))), 0.5) * DEG).toFixed(2)}°`
    + `  p95 ${(pct(moving.map(r => Math.abs(rollTerm(r))), 0.95) * DEG).toFixed(2)}°`);
  console.log(`    they pull the same way on ${(agree / moving.length * 100).toFixed(1)}% of those frames`);

  console.log('\n  camera dutch, over the lap');
  console.log(`    body roll                       p50 ${pct(all.map(r => Math.abs(r.roll)), 0.5).toFixed(2)}°`
    + `  p95 ${pct(all.map(r => Math.abs(r.roll)), 0.95).toFixed(2)}°`
    + `  peak ${Math.max(...all.map(r => Math.abs(r.roll))).toFixed(2)}°`);
  console.log(`    dutch the formula asks for      p50 ${(pct(rawAbs, 0.5) * DEG).toFixed(2)}°`
    + `  p95 ${(pct(rawAbs, 0.95) * DEG).toFixed(2)}°`
    + `  peak ${(Math.max(...rawAbs) * DEG).toFixed(2)}°`
    + `   — the old hard clamp sat at ${(CLAMP * DEG).toFixed(2)}°`);
  const runs = [];
  let n = 0;
  for (const r of all) {
    if (Math.abs(raw(r)) >= CLAMP - 1e-4) n++;
    else { if (n) runs.push(n); n = 0; }
  }
  if (n) runs.push(n);
  runs.sort((a, b) => b - a);
  console.log(`    which that clamp flattened on  ${pinned.length} of ${all.length} frames`
    + ` (${(pinned.length / all.length * 100).toFixed(1)}% of the lap,`
    + ` ${(pinnedHard.length / Math.max(1, hard.length) * 100).toFixed(1)}% of those with over 4° of body roll),`);
  console.log(`      for as long as ${(runs[0] / 60).toFixed(2)} s unbroken`
    + `   (${runs.filter(x => x > 30).length} stretches over half a second)`);
  console.log(`    horizon tilt now on screen      p95 ${pct(all.map(r => Math.abs(r.tilt)), 0.95).toFixed(2)}°`
    + `  peak ${Math.max(...all.map(r => Math.abs(r.tilt))).toFixed(2)}°`
    + `   (the shipped dutch plus the banked-road up-vector)`);

  /* Candidate replacements, scored on the recorded lap. What is being bought
     is not a bigger number but a live one: `spread` is the interquartile range
     of the dutch across the frames that are actually cornering hard, and a
     term pinned at its limit scores zero there however large the limit is. */
  const DUTCH_KNEE = 0.058, DUTCH_LIMIT = 0.098;    // must match src/car/camera.js
  const soft = (x, knee, limit) => {
    const a = Math.abs(x);
    if (a <= knee) return x;
    return Math.sign(x) * (knee + (limit - knee) * (1 - Math.exp(-(a - knee) / (limit - knee))));
  };
  const score = (label, rateW, rollW, knee, limit) => {
    const f = r => soft(-(r.yawRate / DEG) * rateW - (r.roll / DEG) * rollW, knee, limit);
    const v = all.map(r => Math.abs(f(r)));
    const h = hard.map(r => Math.abs(f(r)));
    const near = v.filter(x => x >= (limit || CLAMP) * 0.97).length;
    /* A clamp suppresses jitter by flattening, so anything that un-flattens it
       has to be checked for the shimmer it lets back through. */
    const step = [];
    for (let i = 1; i < all.length; i++) step.push(Math.abs(f(all[i]) - f(all[i - 1])) * 60);
    step.sort((a, b) => a - b);
    // Crawling speed, where yaw rate is high but there is no load to lean on.
    const crawl = all.filter(r => r.kmh < 25).map(r => Math.abs(f(r)));
    console.log(`    ${label.padEnd(30)} p50 ${(pct(v, 0.5) * DEG).toFixed(2)}°`
      + `  p95 ${(pct(v, 0.95) * DEG).toFixed(2)}°`
      + `  peak ${(Math.max(...v) * DEG).toFixed(2)}°`
      + `   pinned ${(near / all.length * 100).toFixed(1)}%`
      + `   spread ${((pct(h, 0.75) - pct(h, 0.25)) * DEG).toFixed(2)}°`
      + `   jitter ${(step[Math.floor(step.length * 0.99)] * DEG).toFixed(1)}°/s`
      + `   under 25 km/h p95 ${(pct(crawl, 0.95) * DEG).toFixed(2)}°`);
  };
  console.log('\n  candidate dutch curves, scored on this lap');
  score('today: 0.11/0.35, hard clamp', 0.11, 0.35, CLAMP, CLAMP);
  score('soft knee, same weights', 0.11, 0.35, 0.058, 0.098);
  score('soft knee, leaning on roll', 0.085, 0.46, 0.058, 0.098);
  score('  ... limit 0.088', 0.085, 0.46, 0.058, 0.088);
  score('  ... limit 0.108', 0.085, 0.46, 0.058, 0.108);
  score('  ... knee 0.045', 0.085, 0.46, 0.045, 0.098);
  score('  ... knee 0.070', 0.085, 0.46, 0.070, 0.098);
    score('roll only, 0.60', 0.0, 0.60, 0.058, 0.098);

  /* The reference load the physics agent quotes: 8.2° of body roll at 1.17 g.
     What the camera actually does there is the question behind "does it read
     well", so it gets its own readout rather than being inferred off a curve. */
  const ref = all.filter(r => Math.abs(r.roll) > 7.7 && Math.abs(r.roll) < 8.7);
  if (ref.length) {
    const was = ref.map(r => Math.min(CLAMP, Math.abs(raw(r))));
    const now = ref.map(r => Math.abs(soft(raw(r), DUTCH_KNEE, DUTCH_LIMIT)));
    console.log(`\n  at the reference load — 8.2° of body roll, ${ref.length} frames of this lap`);
    console.log(`    old hard clamp   p50 ${(pct(was, 0.5) * DEG).toFixed(2)}°  p95 ${(pct(was, 0.95) * DEG).toFixed(2)}°`
      + `   range across those frames ${((Math.max(...was) - Math.min(...was)) * DEG).toFixed(2)}°`);
    console.log(`    shipped curve    p50 ${(pct(now, 0.5) * DEG).toFixed(2)}°  p95 ${(pct(now, 0.95) * DEG).toFixed(2)}°`
      + `   range across those frames ${((Math.max(...now) - Math.min(...now)) * DEG).toFixed(2)}°`);
  }

  console.log(`\n  chase camera update, best of nine passes over the lap:`
    + ` ${(out.costOff * 1000).toFixed(2)} us without lag, ${(out.costOn * 1000).toFixed(2)} us with`
    + `  (+${((out.costOn - out.costOff) * 1000).toFixed(2)} us of a 16667 us frame)`);

  /* The tightest corner on the stage, frame by frame. */
  let best = null;
  for (const r of out.on) if (!best || Math.abs(r.curv) > Math.abs(best.curv)) best = r;
  const lo = best.s - 60, hi = best.s + 90;
  console.log(`\n  trace through the tightest corner on the stage (s=${best.s.toFixed(0)}, radius ${(1 / Math.abs(best.curv)).toFixed(0)} m)`);
  console.log('       s   km/h   radius | yawErr off   yawErr on |  car x   road-ahead x  boom');
  for (let i = 0; i < out.on.length; i++) {
    const r = out.on[i];
    if (r.s < lo || r.s > hi || i % 9) continue;
    const rad = Math.abs(r.curv) > 1e-4 ? (1 / Math.abs(r.curv)).toFixed(0) : '  -';
    console.log(`  ${r.s.toFixed(0).padStart(6)} ${String(r.kmh).padStart(6)} ${String(rad).padStart(8)} |`
      + `${out.off[i].yawErr.toFixed(2).padStart(11)} ${r.yawErr.toFixed(2).padStart(12)} |`
      + `${r.carX.toFixed(3).padStart(7)} ${r.aheadX.toFixed(3).padStart(14)}  ${(r.occl * 100).toFixed(0).padStart(3)}%`);
  }

  fs.mkdirSync(path.join(ROOT, 'shots', 'camyaw'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'shots', 'camyaw', 'trace.json'), JSON.stringify(out, null, 1));
  console.log('\n  → shots/camyaw/trace.json');
});

finish(process.exitCode || 0);
