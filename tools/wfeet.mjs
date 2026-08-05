/* Is there mesh under every spectator's boots?
 *
 * tools/zzfoot.mjs answers the question the player asks — can I SEE ground
 * under them — off the depth buffer. This answers the cruder one underneath
 * it: is there any geometry there at all. A downward ray from just above each
 * figure's origin, against the drawn stage, and the drop to the first hit.
 *
 * The two are different and both are needed. A figure can have solid ground
 * under it and still read as floating because a berm hides the contact; and a
 * figure can be fifteen metres above the basin and read as fine at eighty
 * metres and absurd at fifteen. This one is the placement gate's own
 * question, in the placement gate's own terms, so a failure here is a bug in
 * the gate rather than a judgement about the frame.
 *
 *   node tools/wfeet.mjs [--seeds 22,1,40]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');

let air = 0, all = 0;
for (const SEED of SEEDS) {
  await run({
    width: 640, height: 360,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    page.setDefaultTimeout(600_000);
    const out = await page.evaluate(() => {
      const g = window.__game;
      const THREE = g.THREE;
      if (!g.crowd) return { none: true };
      const mesh = g.scene.getObjectByName('crowd-figures');
      const place = mesh.geometry.getAttribute('aPlace');

      const skip = /sky-dome|sun-disc|ocean-bands|shore-foam|block-clouds|bird|beam|foam|crowd/i;
      const targets = [];
      g.stage.updateMatrixWorld(true);
      g.stage.traverse(o => {
        if (!o.isMesh) return;
        let nm = o.name;
        for (let q = o.parent; !nm && q; q = q.parent) nm = q.name;
        if (skip.test(nm || '')) return;
        o.userData.__probeName = nm || '(unnamed)';
        targets.push(o);
      });
      const ray = new THREE.Raycaster();
      const down = new THREE.Vector3(0, -1, 0);

      const rows = [];
      for (const site of g.crowd.sites) {
        const drops = [];
        for (let i = 0; i < place.count; i++) {
          const x = place.getX(i), y = place.getY(i), z = place.getZ(i);
          if (Math.hypot(x - site.at.x, z - site.at.z) > 26) continue;
          ray.far = 600;
          ray.set(new THREE.Vector3(x, y + 1.2, z), down);
          const hit = ray.intersectObjects(targets, false)[0];
          drops.push({
            drop: hit ? +(y - hit.point.y).toFixed(2) : 999,
            what: hit ? hit.object.userData.__probeName : 'nothing',
          });
        }
        rows.push({ kind: site.kind, s: Math.round(site.s), side: site.side, drops });
      }
      return { rows };
    });

    if (out.none) { console.log(`  seed ${SEED}: no crowd`); return; }
    console.log(`\n══ seed ${SEED}`);
    for (const r of out.rows) {
      const bad = r.drops.filter(d => d.drop > 0.6);
      all += r.drops.length; air += bad.length;
      const worst = r.drops.reduce((a, d) => Math.max(a, d.drop), 0);
      console.log(`   ${r.kind.padEnd(14)} s=${String(r.s).padStart(5)} side ${String(r.side).padStart(2)}`
        + `   ${r.drops.length} figures, worst drop ${worst.toFixed(2)} m`
        + `${bad.length ? `   ◀── ${bad.length} STANDING ON AIR` : ''}`);
      if (bad.length) {
        const what = [...new Set(bad.map(d => d.what))].join(', ');
        console.log(`        drops: ${bad.map(d => d.drop).join(' ')}   onto ${what}`);
      }
    }
  });
}
console.log(`\n  TOTAL: ${air} of ${all} figures stand more than 0.6 m above the nearest mesh`
  + ` (${all ? (100 * air / all).toFixed(0) : 0}%)\n`);
finish(process.exitCode || 0);
