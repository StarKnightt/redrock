/* From how far back can you see the hole?
 *
 * "The portal should be visible and legible as an opening well before you
 * reach it" needs a distance and a duration behind it, not an opinion about a
 * screenshot. Walks the chase camera back up the approach and, at each
 * station, fires a fan of rays at the portal mouth to find the first point
 * from which the opening is not hidden by the headland in front of it. Reports
 * that distance and what it is worth in seconds at the speed cars actually
 * arrive at.
 *
 *   node tools/tsight.mjs [--seeds 22,1,12]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,7,12,14,16,20,23,26,27,28,34,36,40').split(',');

const rows = [];
for (const seed of SEEDS) {
  await run({ width: 320, height: 200, hash: `manual&tier=high&seed=${seed}&cap=60&hud=0` }, async ({ page }) => {
    const out = await page.evaluate(async () => {
      const g = window.__game, THREE = g.THREE;
      const span = g.field.tunnel;
      const L = g.track.length;
      const mouth = g.track.frameAt(span.s0);
      /* A fan across the opening rather than a single ray at its centre: a
         portal whose centre is behind a spur but whose left half is in clear
         view is visible, and the eye finds it. */
      const targets = [];
      for (const u of [-0.55, -0.28, 0, 0.28, 0.55]) {
        for (const h of [1.6, 4.2]) {
          targets.push(new THREE.Vector3(
            mouth.pos.x + mouth.flatRight.x * u * mouth.width,
            mouth.pos.y + h,
            mouth.pos.z + mouth.flatRight.z * u * mouth.width,
          ));
        }
      }
      const ray = new THREE.Raycaster();
      const eye = new THREE.Vector3();
      let firstSeen = 0, speedAt = 0;
      for (let back = 260; back >= 8; back -= 4) {
        const s = span.s0 - back;
        if (s < 6) continue;
        const f = g.track.frameAt(s);
        /* Where the chase lens sits, near enough: behind and above the car. */
        eye.set(f.pos.x - f.tan.x * 9, f.pos.y + 4.2, f.pos.z - f.tan.z * 9);
        let visible = 0;
        for (const t of targets) {
          const dir = t.clone().sub(eye);
          const dist = dir.length();
          ray.set(eye, dir.normalize());
          ray.far = dist - 0.4;
          const hit = ray.intersectObjects(g.scene.children, true)
            .find(q => q.object.visible
              && !/^(sky|ocean|foam|block-clouds|sun-|fx-|tunnel)/.test(q.object.name || ''));
          if (!hit) visible++;
        }
        /* Three of ten sightlines clear is the point at which the mouth stops
           being a sliver and starts being a shape. */
        if (visible >= 3) { firstSeen = back; break; }
      }
      /* When it is hidden, by what. Sampled at a distance the mouth ought to
         be readable from, because "you cannot see it" and "a hillside is in
         the way" call for different fixes. */
      const blockers = new Map();
      {
        const s = Math.max(6, span.s0 - 150);
        const f = g.track.frameAt(s);
        eye.set(f.pos.x - f.tan.x * 9, f.pos.y + 4.2, f.pos.z - f.tan.z * 9);
        for (const t of targets) {
          const dir = t.clone().sub(eye);
          const dist = dir.length();
          ray.set(eye, dir.normalize());
          ray.far = dist - 0.4;
          const hit = ray.intersectObjects(g.scene.children, true)
            .find(q => q.object.visible
              && !/^(sky|ocean|foam|block-clouds|sun-|fx-|tunnel)/.test(q.object.name || ''));
          const key = hit
            ? `${hit.object.name || 'unnamed'}@${hit.distance.toFixed(0)}m of ${dist.toFixed(0)}`
            : 'clear';
          blockers.set(key, (blockers.get(key) || 0) + 1);
        }
      }
      /* What the field is actually doing when it gets there. */
      g.driveTo(Math.max(0, span.s0 - 40) / L);
      speedAt = g.player.speed !== undefined ? g.player.speed : 0;
      return {
        seed: g.seed, firstSeen, speedAt,
        bore: [Math.round(span.s0), Math.round(span.s1)],
        sight: span.sight === undefined ? null : span.sight,
        bend: span.bend,
        blockers: [...blockers].sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${k} ${n}`).join(', '),
      };
    });
    rows.push(out);
  });
}
console.log('\n  how far back the mouth reads as an opening\n');
console.log('  seed        bore   approach bend   first seen   at 130 km/h');
for (const r of rows) {
  const secs = r.firstSeen / (130 / 3.6);
  console.log(`  ${String(r.seed).padStart(4)}  ${String(r.bore[0]).padStart(5)}-${String(r.bore[1]).padStart(5)}`
    + ` ${(r.sight === null ? '—' : r.sight.toFixed(1) + ' m').padStart(14)}`
    + ` ${(r.firstSeen ? r.firstSeen + ' m' : 'never').padStart(12)}`
    + ` ${(secs.toFixed(1) + ' s').padStart(13)}   ${r.blockers}`);
}
const seen = rows.filter(r => r.firstSeen);
const worst = seen.reduce((a, r) => Math.min(a, r.firstSeen), 1e9);
console.log(`\n  worst ${worst} m = ${(worst / (130 / 3.6)).toFixed(1)} s of approach`
  + `, ${seen.length}/${rows.length} seeds visible at all\n`);
finish(process.exitCode || 0);
