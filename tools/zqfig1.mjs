/* One figure, three answers: where the model puts the ground under it, where
 * `drawnGroundY` puts it, and where a ray finds it.
 *
 * wfeet reports which figures stand on air but not why, and "why" is the whole
 * question once the placement gates have been moved onto the drawn surface: a
 * survivor is either a hole in that surface's model of the mesh or a hole in the
 * mesh itself, and those want opposite fixes.
 *
 *   node tools/zqfig1.mjs --seed 1 --near 1475 --side 1
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '1');
const NEAR = Number(flag('near', '1475'));

await run({
  width: 640, height: 360,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(600_000);
  const res = await page.evaluate((near) => {
    const g = window.__game;
    const THREE = g.THREE;
    const t = g.track;
    const env = g.scene.getObjectByName('environment') || g.stage.getObjectByName('environment');
    const probe = env?.userData?.crowdProbe;
    const mesh = g.scene.getObjectByName('crowd-figures');
    if (!probe || !mesh) return { none: true };
    const place = mesh.geometry.getAttribute('aPlace');

    const named = [];
    g.stage.updateMatrixWorld(true);
    g.stage.traverse(o => {
      if (!o.isMesh) return;
      let nm = o.name;
      for (let q = o.parent; !nm && q; q = q.parent) nm = q.name;
      if (/sky-dome|sun-disc|ocean-bands|shore-foam|block-clouds|bird|beam|foam|crowd/i.test(nm || '')) return;
      o.userData.__n = nm || '(unnamed)';
      named.push(o);
    });
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);

    const rows = [];
    for (let i = 0; i < place.count; i++) {
      const x = place.getX(i), y = place.getY(i), z = place.getZ(i);
      if (y < -1e4) continue;
      const pr = t.project(new THREE.Vector3(x, y, z));
      if (Math.abs(pr.s - near) > 60) continue;
      const side = pr.lat >= 0 ? 1 : -1;
      const wall = probe.wallDist(pr.s, side);
      const off = Math.max(0, Math.abs(pr.lat) - pr.width * 0.5);
      const u = Math.min(1, off / wall);
      ray.far = 900;
      ray.set(new THREE.Vector3(x, y + 300, z), down);
      const hits = ray.intersectObjects(named, false);
      const under = hits.filter(h => h.point.y <= y + 0.5);
      rows.push({
        s: +pr.s.toFixed(1), side, off: +off.toFixed(2),
        u: +u.toFixed(3),
        figY: +y.toFixed(2),
        model: +probe.point(pr.s, side, u).y.toFixed(2),
        drawn: +probe.drawnY(pr.s, side, u).toFixed(2),
        ray: under.length ? +under[0].point.y.toFixed(2) : null,
        what: under.length ? under[0].object.userData.__n : 'nothing under it',
        above: hits.length - under.length,
      });
    }
    return { rows };
  }, NEAR);

  if (res.none) { console.log('  no probe'); return; }
  console.log(`\n══ seed ${SEED}, figures within 60 m of s=${NEAR}`);
  for (const r of res.rows) {
    console.log(`   s=${String(r.s).padStart(7)} side ${String(r.side).padStart(2)}`
      + ` off ${String(r.off).padStart(7)} m (u ${r.u})`
      + `   feet ${String(r.figY).padStart(8)}`
      + `   model ${String(r.model).padStart(8)}`
      + `   drawn ${String(r.drawn).padStart(8)}`
      + `   ray ${String(r.ray).padStart(8)}  ${r.what}`);
  }
  console.log();
});
finish(process.exitCode || 0);
