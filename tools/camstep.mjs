/* Camera response to a steering step, which is the manoeuvre the AI never
 * performs and therefore the one a lap replay cannot measure.
 *
 * The bot tracks a racing line with a continuously varying wheel, so its yaw
 * rate is set by road curvature and grip and barely notices how quickly the
 * steering filter can move. A player flicks to full lock. That is where a
 * faster steering rise shows up, so that is what this drives: hold a straight
 * at a set speed, snap to full lock, hold, release.
 *
 * Records the steering filter's output, the yaw rate it produces, the lateral
 * load, body roll, and what the camera does with all of it.
 *
 *   node tools/camstep.mjs [--speeds 60,100,150,200] [--lock 1]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SPEEDS = flag('speeds', '60,100,150,200').split(',').map(Number);
const LOCK = +flag('lock', 1);

await run({ width: 960, height: 540, hash: 'manual&tier=high&seed=22&cap=0&hud=0' }, async ({ page }) => {
  const out = await page.evaluate(([speeds, lock]) => {
    const g = window.__game;
    const p = g.player;
    const THREE = g.THREE;
    g.setPaused(true);

    /* A long, flat, straight piece of road to do this on, found rather than
       assumed — the stage is being edited by someone else and a hard-coded
       station would quietly start measuring a corner. */
    const L = g.track.length;
    let bestS = 0, bestRun = 0, runStart = 0;
    for (let s = 0; s < L; s += 5) {
      if (Math.abs(g.track.frameAt(s).curv) < 0.0007) {
        if (s - runStart > bestRun) { bestRun = s - runStart; bestS = runStart; }
      } else runStart = s + 5;
    }

    const wrapPi = a => {
      const t = (a + Math.PI) % (Math.PI * 2);
      return (t < 0 ? t + Math.PI * 2 : t) - Math.PI;
    };
    const dutchOf = () => {
      /* The camera's roll is baked into the object's quaternion by the time
         update() returns, so it is recovered here rather than recomputed —
         that way this measures what is on screen, not what the source says
         should be. Roll about the view axis is the z of the Euler taken in
         the camera's own yaw-pitch-roll order. */
      const e = new THREE.Euler().setFromQuaternion(g.camera.quaternion, 'YXZ');
      return e.z * 180 / Math.PI;
    };

    const runOne = (kmh, lag) => {
      g.chase.yawLagEnabled = lag;
      g.chase.started = false;
      g.goTo((bestS + 30) / L);
      p.vertVel = 0;

      // Get up to speed on a straight wheel and let the camera settle.
      g.botInput = { steer: 0, throttle: 1, brake: 0, handbrake: false };
      let guard = 0;
      while (p.kmh < kmh && guard++ < 60 * 40) g.step(1 / 60);
      if (guard >= 60 * 40) return null;
      for (let i = 0; i < 45; i++) { g.botInput.throttle = 0.35; g.step(1 / 60); }

      const rows = [];
      let prevYaw = Math.atan2(p.forward.x, p.forward.z);
      let prevRate = 0;
      for (let i = 0; i < 150; i++) {
        // 0.25 s straight, 1.25 s at full lock, then released.
        const t = i / 60;
        g.botInput = {
          steer: t < 0.25 || t > 1.5 ? 0 : lock,
          throttle: 0.35, brake: 0, handbrake: false,
        };
        g.step(1 / 60);
        const yaw = Math.atan2(p.forward.x, p.forward.z);
        const rate = wrapPi(yaw - prevYaw) * 60;
        prevYaw = yaw;

        const boomX = p.pos.x - g.camera.position.x, boomZ = p.pos.z - g.camera.position.z;
        const travel = new THREE.Vector3().copy(p.forward).multiplyScalar(p.vx).addScaledVector(p.right, p.vy);
        if (travel.lengthSq() < 4) travel.copy(p.forward); else travel.normalize();
        travel.lerp(p.forward, 0.22).normalize();

        rows.push({
          t: +t.toFixed(3),
          cmd: g.botInput.steer,
          steer: +(p.steer * 180 / Math.PI).toFixed(2),
          rate: +(rate * 180 / Math.PI).toFixed(2),
          jerk: +((rate - prevRate) * 60 * 180 / Math.PI).toFixed(1),   // deg/s²
          kmh: +p.kmh.toFixed(1),
          gLat: +(Math.abs(rate * p.speed) / 9.81).toFixed(3),
          roll: +(p.roll * 180 / Math.PI).toFixed(2),
          slip: +(p.slipAngle * 180 / Math.PI).toFixed(1),
          lag: +(g.chase.yawLag * 180 / Math.PI).toFixed(2),
          /* Absolute direction the boom points, which is the only rotation the
             player can actually see. `yawLag` is measured against a moving
             reference and jumps whenever the car's velocity direction does —
             that is the reference moving, not the camera. */
          boom: +(Math.atan2(boomX, boomZ) * 180 / Math.PI).toFixed(3),
          err: +(wrapPi(Math.atan2(boomX, boomZ) - Math.atan2(travel.x, travel.z)) * 180 / Math.PI).toFixed(2),
          dutch: +dutchOf().toFixed(2),
        });
        prevRate = rate;
      }
      return rows;
    };

    const res = {};
    for (const kmh of speeds) {
      res[kmh] = { on: runOne(kmh, true), off: runOne(kmh, false) };
    }
    g.botInput = null;
    g.chase.yawLagEnabled = true;
    return { straight: { s: bestS, len: bestRun }, res, cap: 0.26 * 180 / Math.PI };
  }, [SPEEDS, LOCK]);

  console.log(`  straight used: s ${out.straight.s}, ${out.straight.len} m long\n`);
  console.log(`  full-lock step at 0.25 s, released at 1.50 s\n`);

  for (const kmh of SPEEDS) {
    const r = out.res[kmh];
    if (!r || !r.on) { console.log(`  ${kmh} km/h — could not reach speed on this straight\n`); continue; }
    const on = r.on, off = r.off;
    const peakRate = Math.max(...on.map(x => Math.abs(x.rate)));
    const peakG = Math.max(...on.map(x => x.gLat));
    const peakLag = Math.max(...on.map(x => Math.abs(x.lag)));
    const peakErr = Math.max(...on.map(x => Math.abs(x.err)));
    const peakErrOff = Math.max(...off.map(x => Math.abs(x.err)));
    const capped = on.filter(x => Math.abs(x.lag) > out.cap - 0.02).length;
    const peakRoll = Math.max(...on.map(x => Math.abs(x.roll)));
    const peakDutch = Math.max(...on.map(x => Math.abs(x.dutch)));
    /* How fast the shot itself swings, with and without the lag. The lag is
       supposed to make this smaller than the car's own yaw rate, never
       larger — a lag that overshoots or snaps shows up here as a boom rate
       above the car's. */
    const swing = rows => {
      let m = 0;
      for (let i = 1; i < rows.length; i++) {
        const d = ((rows[i].boom - rows[i - 1].boom + 540) % 360) - 180;
        m = Math.max(m, Math.abs(d) * 60);
      }
      return m;
    };
    const boomRate = swing(on), boomRateOff = swing(off);

    console.log(`  ${String(kmh).padStart(3)} km/h entry`);
    console.log(`    peak yaw rate ${peakRate.toFixed(1)}°/s   peak lateral ${peakG.toFixed(2)} g   peak body roll ${peakRoll.toFixed(2)}°   peak slip ${Math.max(...on.map(x => Math.abs(x.slip))).toFixed(1)}°`);
    console.log(`    boom yaw error   peak ${peakErr.toFixed(2)}° with lag, ${peakErrOff.toFixed(2)}° without`
      + `   lag state peak ${peakLag.toFixed(2)}° of a ${out.cap.toFixed(2)}° cap`
      + (capped ? `   ON THE CAP for ${(capped / 60).toFixed(2)} s` : '   never reaches the cap'));
    console.log(`    fastest the shot swings  ${boomRate.toFixed(1)}°/s with lag, ${boomRateOff.toFixed(1)}°/s without,`
      + ` against the car's own ${peakRate.toFixed(1)}°/s`);
    console.log(`    peak on-screen horizon tilt ${peakDutch.toFixed(2)}°`);

    const marks = [0.25, 0.32, 0.40, 0.50, 0.65, 0.85, 1.10, 1.45, 1.55, 1.70, 1.90, 2.20];
    const at = (rows, m, k) => rows.reduce((b, x) => Math.abs(x.t - m) < Math.abs(b.t - m) ? x : b)[k];
    const line = (label, rows, k, dp = 1) => console.log(`      ${label.padEnd(15)}` + marks.map(m => at(rows, m, k).toFixed(dp).padStart(7)).join(''));
    console.log('      t (s)          ' + marks.map(m => m.toFixed(2).padStart(7)).join(''));
    line('road wheel °', on, 'steer');
    line('yaw rate °/s', on, 'rate');
    line('body roll °', on, 'roll');
    line('boom err, lag', on, 'err', 2);
    line('boom err, none', off, 'err', 2);
    line('camera dutch °', on, 'dutch', 2);
    console.log('');
  }

  fs.mkdirSync(path.join(ROOT, 'shots', 'camstep'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'shots', 'camstep', 'step.json'), JSON.stringify(out, null, 1));
  console.log('  → shots/camstep/step.json');
});

finish(process.exitCode || 0);
