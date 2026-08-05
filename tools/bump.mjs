/* Does the field still race each other, and does it do it cleanly?
 *
 * Car-to-car contact is a gameplay feature, so a change to the resolver can
 * fail in two opposite directions and finish-rate catches neither. Too soft
 * and the cars pass through each other; too stiff, or self-re-arming, and
 * they buzz against each other at the frame rate. Both are measured here:
 *
 *   - depth: how far into each other the boxes ever get, in metres. The
 *     resolver pushes half the overlap per frame, so a steady rub sits at a
 *     few centimetres; a spike means the resolver was skipped.
 *   - flips: how often the sign of a pair's lateral separation reverses while
 *     they are in contact. Cars trading paint hold a side; cars being hammered
 *     apart and pulled back swap sides several times a second.
 *   - lift: how much air a car gains on the frame it is shoved. A shove that
 *     ignores the road crown sets the car down above the surface, and the
 *     car's own step then reads that as the ground falling away.
 *
 *   node tools/bump.mjs [--seeds 1,4,20] [--secs 150]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '1,4,20').split(',').map(Number);
const SECS = +flag('secs', 150);

const all = {};

for (const seed of SEEDS) {
  await run({
    width: 640, height: 360,
    hash: 'manual',
  }, async ({ page }) => {
    const out = await page.evaluate(async ([secs, seed]) => {
      /* Same setup as race.mjs, so the numbers here describe the same races
         the sweep scores. */
      const { Race } = await import('/src/race/index.js');
      const g = window.__game;
      const p = g.player;
      if (g.race) g.race.dispose();
      const race = new Race(g.track, g.scene, { seed });
      g.race = race;
      g.botInput = { steer: 0, throttle: 0, brake: 1, handbrake: 0 };
      g.step(1 / 60);
      const wired = race._clock > 0;
      race.reset();
      g.botInput = null;
      g.autopilot(true, 0.85);
      g.bot.wobble = 5; g.bot.boost = 1;
      p.placeAt(34, 0); p.vx = 0; p.vy = 0; p.r = 0;
      p.raceTime = 0; p.finished = false; p.rpm = 1050; p.gear = 0;

      const cars = [p, ...race.entries.map(e => e.car)];

      /* The shove itself, measured either side of the call. A resolver that
         translates in the frame plane leaves the car above a crowned road;
         one that re-derives from the surface leaves the air it found. */
      let shoveN = 0, liftMax = 0, liftSum = 0, latMax = 0;
      const V = g.THREE.Vector3;
      const tmp = new V(), tmp2 = new V();
      /* How far pos sits above the surface under it. The ride-height offset
         is constant, so the change in this across the call is exactly the air
         the shove invented. */
      const gap = (c) => {
        c.surfaceAt(c.s, c.lat, tmp);
        return tmp2.copy(c.pos).sub(tmp).dot(g.track.frameAt(c.s).up);
      };
      const rawResolve = race._resolve.bind(race);
      race._resolve = (a, b, ds, dl, overS, overL, fresh) => {
        const g0a = gap(a), g0b = gap(b);
        const l0a = a.lat, l0b = b.lat;
        rawResolve(a, b, ds, dl, overS, overL, fresh);
        for (const [c, g0, l0] of [[a, g0a, l0a], [b, g0b, l0b]]) {
          const gained = gap(c) - g0;
          shoveN++;
          liftSum += Math.abs(gained);
          if (gained > liftMax) liftMax = gained;
          latMax = Math.max(latMax, Math.abs(c.lat - l0));
        }
      };

      const C_LEN = 3.9, C_WID = 1.85;
      const st = new Map();
      let deepest = 0, deepAt = null, flips = 0, touching = 0, frames = 0;
      let pairsSeen = 0;

      for (let i = 0; i < 60 * secs; i++) {
        g.step(1 / 60);
        if (p.strandedFor > 2.5) p.recover();
        if (!wired) race.step(1 / 60, p);
        frames++;
        for (let a = 0; a < cars.length - 1; a++) {
          for (let b = a + 1; b < cars.length; b++) {
            const A = cars[a], B = cars[b];
            const overS = C_LEN - Math.abs(A.s - B.s);
            const overL = C_WID - Math.abs(A.lat - B.lat);
            const key = a * 8 + b;
            if (overS <= 0 || overL <= 0) { st.delete(key); continue; }
            touching++;
            const depth = Math.min(overS, overL);
            if (depth > deepest) {
              deepest = depth;
              deepAt = { s: +A.s.toFixed(0), overS: +overS.toFixed(3), overL: +overL.toFixed(3) };
            }
            const side = Math.sign(A.lat - B.lat) || 1;
            const was = st.get(key);
            if (was === undefined) pairsSeen++;
            else if (was !== side) flips++;
            st.set(key, side);
          }
        }
        if (cars.every(c => c.finished)) break;
      }
      g.autopilot(false);

      return {
        seed, frames,
        secs: +(frames / 60).toFixed(0),
        touchFrames: touching,
        touchPct: +(touching / frames * 100).toFixed(1),
        episodes: pairsSeen,
        deepest: +deepest.toFixed(3), deepAt,
        flips, flipsPerTouchSec: +(flips / Math.max(1, touching / 60)).toFixed(2),
        shoveN,
        liftMax: +liftMax.toFixed(4),
        liftAvg: +(liftSum / Math.max(1, shoveN)).toFixed(4),
        latMax: +latMax.toFixed(3),
        collisions: race.collisions,
      };
    }, [SECS, seed]);

    all[seed] = out;
    if (out.error) { console.log(`  seed ${seed}: ${out.error}`); return; }
    console.log(`\n═══ seed ${out.seed} — ${out.secs}s of racing ═══`);
    console.log(`  frames with two cars overlapping   ${out.touchFrames} (${out.touchPct}%), ${out.episodes} episodes, ${out.collisions} scored collisions`);
    console.log(`  deepest interpenetration           ${out.deepest} m` + (out.deepAt ? `  at s=${out.deepAt.s} (overS ${out.deepAt.overS}, overL ${out.deepAt.overL})` : ''));
    console.log(`  side reversals while in contact    ${out.flips}  (${out.flipsPerTouchSec}/s of contact)`);
    console.log(`  resolver shoves                    ${out.shoveN}, biggest ${out.latMax} m`);
    console.log(`  air the shove invented             worst ${out.liftMax} m, mean |Δ| ${out.liftAvg} m`);
  });
}

fs.mkdirSync(path.join(ROOT, 'shots', 'turns'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'shots', 'turns', 'bump.json'), JSON.stringify(all, null, 1));
console.log('\n  → shots/turns/bump.json');
finish(process.exitCode || 0);
