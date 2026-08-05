/* The held finish shot over the ENSEMBLE of poses it can actually be, not one.
 *
 * zwhold measures the held frame the autopilot happened to produce on the run it
 * did. That is one sample of a two-parameter family: `src/race/ending.js` is
 * explicit that the stop misses its mark, and measured over ten seeds at two
 * skills the car comes to rest 0.9–34 m past the line with a lateral of
 * −6.1 to +5.8 m. Both feed the held camera — the lens station is clamped off
 * the car's station and the AIM includes the car's lateral — so the axis of the
 * shot swings about ±22 degrees run to run against a half-width of 45.
 *
 * A finish group composed against one pose is therefore composed against
 * nothing. This walks the family: for every standing place near the line it
 * counts how many of the poses have the chest in frame and unhidden, and reports
 * the stations that survive most of them.
 *
 * The camera is rebuilt here from main.js's rule and CHECKED against the real
 * one on the run's own rest and lateral before the sweep, so a replica that has
 * drifted from the game says so instead of grading itself.
 *
 *   node tools/zwens.mjs [--seeds 22,1,40] [--lo -30] [--hi 34]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');
const LO = +flag('lo', -30);
const HI = +flag('hi', 34);
const STEP = +flag('step', 4);
const OUTS = flag('outs', '5,7.4,10').split(',').map(Number);
const TAG = flag('tag', 'zwens');

const lines = [];
const say = s => { console.log(s); lines.push(s); };
const all = [];

for (const SEED of SEEDS) {
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ending=1`,
  }, async ({ page }) => {
    const r = await page.evaluate(({ LO, HI, STEP, OUTS }) => {
      const THREE = window.__game.THREE;
      const g = window.__game, t = g.track;
      const P = g.scene.getObjectByName('environment').userData.crowdProbe;
      const L = t.length, LINE = P.line, GATE = P.gate;
      const blockers = P.blockers();

      /* main.js's holdCamera, rebuilt. Both stations off the car, the lens
         station clamped to a band around the line so the arch stays between
         lens and subject, the aim on the car's own lateral. */
      const BEHIND = 26, PAST_MIN = -10, PAST_MAX = 6, LAT = 3.0, HIGH = 5.5;
      const AIM_HIGH = 7.6, FOV = 62;
      const pose = (rest, lat) => {
        const camS = LINE + Math.max(PAST_MIN, Math.min(PAST_MAX, rest - BEHIND));
        const fc = t.frameAt(camS);
        const pos = fc.pos.clone()
          .addScaledVector(fc.flatRight, LAT).addScaledVector(fc.up, HIGH);
        const fa = t.frameAt(LINE + rest);
        const aim = fa.pos.clone()
          .addScaledVector(fa.flatRight, lat).addScaledVector(fa.up, AIM_HIGH);
        return { pos, aim };
      };

      g.setPaused(true);
      g.restart();
      g.autopilot(true, 0.85);
      for (let i = 0; i < 60 * 400 && g.player.s < LINE - 120; i++) g.step(1 / 60);
      g.ending.enabled = true;
      g.ending.arm();
      for (let i = 0; i < 60 * 40; i++) {
        g.step(1 / 60);
        if (g.ending.camera > 0.999 && g.player.speed < 0.3) break;
      }
      const realRest = g.player.s - LINE, realLat = g.player.lat;
      const cam = g.camera;
      cam.updateMatrixWorld();
      const mine = pose(realRest, realLat);
      const check = {
        pos: +mine.pos.distanceTo(cam.position).toFixed(3),
        rest: +realRest.toFixed(1), lat: +realLat.toFixed(2),
        fov: +cam.fov.toFixed(1),
      };
      /* Aim is checked as an angle, because the aim POINT is only defined up to
         where along the axis it sits. */
      const realFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      const myFwd = mine.aim.clone().sub(mine.pos).normalize();
      check.aimDeg = +(Math.acos(Math.min(1, realFwd.dot(myFwd))) * 180 / Math.PI).toFixed(2);

      const RESTS = [2, 8, 15, 22, 28, 34];
      const LATS = [-6, -3, 0, 3, 6];
      const poses = [];
      for (const rest of RESTS) for (const lat of LATS) poses.push({ rest, lat, ...pose(rest, lat) });

      const ray = new THREE.Raycaster();
      const tanV = Math.tan(FOV * Math.PI / 360), tanH = tanV * (16 / 9);
      const sees = (p, at) => {
        const fwd = p.aim.clone().sub(p.pos).normalize();
        const right = fwd.clone().cross(new THREE.Vector3(0, 1, 0)).normalize();
        const up = right.clone().cross(fwd).normalize();
        const to = at.clone().sub(p.pos);
        const z = to.dot(fwd);
        if (z < 3) return 0;
        if (Math.abs(to.dot(right)) > tanH * z) return 0;
        if (Math.abs(to.dot(up)) > tanV * z) return 0;
        const d = to.length();
        ray.set(p.pos, to.clone().normalize());
        ray.near = 0.3; ray.far = d - 0.4;
        return ray.intersectObjects(blockers, false).length ? 0 : 1;
      };

      const rows = [];
      for (let rel = LO; rel <= HI; rel += STEP) {
        const s = LINE + rel;
        if (s < 40 || s > L - 4) continue;
        for (const side of [-1, 1]) {
          const stand = P.stand(s, side);
          const wall = P.wallDist(s, side);
          for (const outM of OUTS) {
            const u = outM / wall;
            if (u > 0.95) continue;
            const at = P.point(s, side, u);
            const chest = new THREE.Vector3(at.x, P.drawnY(s, side, u) + 0.95, at.z);
            let n = 0;
            for (const p of poses) n += sees(p, chest);
            rows.push({
              rel, side, outM, n, of: poses.length,
              lat: +t.project(at, s).lat.toFixed(1),
              stand: stand !== null,
              standOut: stand === null ? null : +(stand * wall).toFixed(1),
            });
          }
        }
      }
      return { L: +L.toFixed(0), LINE, GATE, check, poses: poses.length, rows,
        halfWidth: +(t.frameAt(LINE + 20).width * 0.5).toFixed(1) };
    }, { LO, HI, STEP, OUTS });

    say(`\n══ seed ${SEED} ══  line=${r.LINE} gate=${r.GATE}`
      + `  road half-width past the line ${r.halfWidth} m`);
    say(`  replica check against the live camera at rest ${r.check.rest} m /`
      + ` lat ${r.check.lat} m: position off by ${r.check.pos} m,`
      + ` axis off by ${r.check.aimDeg}°, live fov ${r.check.fov}`);
    const best = r.rows.filter(x => x.stand).sort((a, b) => b.n - a.n || b.rel - a.rel);
    say(`  standable places near the line, best first, out of ${r.poses} poses`
      + ' (6 rest marks x 5 laterals):');
    say('    rel side   out  lat   in shot');
    for (const x of best.slice(0, 14)) {
      say(`    ${String(x.rel).padStart(3)} ${String(x.side).padStart(4)}`
        + ` ${String(x.outM).padStart(5)} ${String(x.lat).padStart(5)}`
        + `   ${String(x.n).padStart(2)}/${x.of}`
        + `${x.n === 0 ? '  ◀ never' : ''}`);
    }
    if (!best.length) say('    NONE — nothing stands anywhere in this window');
    const top = best[0];
    say(`  best standable station sees ${top ? top.n : 0} of ${r.poses} poses`
      + ` (${top ? (100 * top.n / r.poses).toFixed(0) : 0}%)`);
    all.push({ seed: +SEED, ...r });
  });
}

const dir = path.join(ROOT, '.meas', 'r3');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${TAG}.json`), JSON.stringify(all, null, 2));
fs.writeFileSync(path.join(dir, `${TAG}.txt`), lines.join('\n') + '\n');
console.log(`\n  → ${path.join(dir, TAG + '.txt')}`);
finish(process.exitCode || 0);
