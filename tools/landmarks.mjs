/* Every scheduled landmark, framed from the road on the approach.
 *
 * The schedule says what was placed and when it is reached; this checks that
 * each one is actually in shot from the seat rather than behind a hill or
 * below the verge. Captures from roughly ninety metres short of each, which is
 * where the driver first has it.
 *
 *   node tools/landmarks.mjs [--kind lighthouse]
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const KIND = flag('kind', '');
const LEAD = Number(flag('lead', '105'));

await run({ width: 800, height: 450, hash: 'manual&tier=high&seed=22&cap=60&hud=0&ink=1' }, async ({ page }) => {
  const outDir = path.join(ROOT, 'shots', 'landmarks');
  fs.mkdirSync(outDir, { recursive: true });

  const schedule = await page.evaluate(() => {
    let s = null;
    window.__game.scene.traverse(o => { if (o.userData && o.userData.schedule) s = o.userData.schedule; });
    return s;
  });
  const wanted = schedule.filter(e => (KIND ? e.kind === KIND : true)
    && !/gate|shelf|arch|stack/.test(e.kind));
  const seen = {};
  for (const e of wanted) {
    seen[e.kind] = (seen[e.kind] || 0) + 1;
    /* driveTo overshoots its target by a car length or two, so aim short and
       let the run-up land the lens where the driver would first see it. */
    /* Where a thing stands and where its slot sits are different stations —
       a lighthouse is on a sea rock four hundred metres up the road from the
       moment it was scheduled for. Drive to whichever is nearer the object,
       then say in pixels where it ended up, because "is it in shot" is a
       question with a number for an answer. */
    const r = await page.evaluate(([e, lead0]) => { let lead = lead0;
      const g = window.__game, THREE = g.THREE;
      g.setPaused(true);
      let target = e.s;
      if (e.at) {
        /* Not the nearest station — that is the one where the object is square
           off the driver's shoulder and out of frame. The station wanted is the
           one where it sits ahead down the road, so scan for the smallest angle
           between the tangent and the line to the object at a scenic range. */
        const p = new THREE.Vector3(...e.at);
        let best = Infinity;
        const lo = Math.max(10, e.s - 250), hi = Math.min(g.track.length - 10, e.s + 950);
        for (let s = lo; s < hi; s += 10) {
          const f = g.track.frameAt(s);
          const dx = p.x - f.pos.x, dz = p.z - f.pos.z;
          const dist = Math.hypot(dx, dz);
          if (dist < 45 || dist > 700) continue;
          const ang = Math.abs(Math.atan2(
            f.tan.x * dz - f.tan.z * dx, f.tan.x * dx + f.tan.z * dz));
          const score = ang + dist / 700;
          if (score < best) { best = score; target = s; }
        }
        lead = 0;
      }
      g.driveTo(Math.max(0.001, (target - lead) / g.track.length));
      g.renderOnce();
      const out = { at: g.player.s, target };
      if (e.at) {
        const v = new THREE.Vector3(...e.at).project(g.camera);
        out.px = Math.round((v.x * 0.5 + 0.5) * 100);
        out.py = Math.round((0.5 - v.y * 0.5) * 100);
        out.behind = v.z > 1;
        out.range = Math.round(new THREE.Vector3(...e.at).distanceTo(g.camera.position));
      }
      return out;
    }, [e, LEAD]);
    const name = `${e.kind}-${seen[e.kind]}-s${Math.round(r.target)}.png`;
    await capture(page, path.join(outDir, name));
    const where = r.px === undefined ? ''
      : `   screen ${r.px}%,${r.py}% ${r.range}m${r.behind ? ' BEHIND' : ''}`;
    console.log(`  ${e.kind.padEnd(11)} slot s=${Math.round(e.s)}`
      + `  stands s=${Math.round(r.target)}  lens s=${r.at.toFixed(0)}${where}`);
  }
});

finish(process.exitCode || 0);
