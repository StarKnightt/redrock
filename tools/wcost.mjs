/* What does a build-time raycast against the real stage cost?
 *
 * Every gate in the crowd build reasons about `field.point`, an analytic
 * corridor surface. Near the finish on seed 22 that surface is fifteen metres
 * above the mesh that is actually drawn, so the gates are grading a ground
 * plane the frame does not have. The honest fix is to ask the geometry, and
 * the only question is whether a few hundred rays fit in a world build.
 *
 * Times three shapes of query against the meshes that matter: a short
 * downward ray for footing, a long sightline, and the same two with the
 * target list trimmed to the big terrain meshes only.
 *
 *   node tools/wcost.mjs [--seed 22]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');

await run({
  width: 640, height: 360,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  const out = await page.evaluate(() => {
    const g = window.__game;
    const THREE = g.THREE;
    const t = g.track;

    const all = [], terrain = [];
    const skip = /sky-dome|sun-disc|ocean-bands|shore-foam|block-clouds|bird|beam|foam|crowd/i;
    const big = /^(landform-|basin-floor|road-supports|road$|berm|tunnel)/;
    g.stage.updateMatrixWorld(true);
    g.stage.traverse(o => {
      if (!o.isMesh) return;
      let nm = o.name;
      for (let q = o.parent; !nm && q; q = q.parent) nm = q.name;
      if (skip.test(nm || '')) return;
      all.push(o);
      if (big.test(nm || '')) terrain.push(o);
    });
    const tris = list => list.reduce((a, o) => {
      const gm = o.geometry;
      const n = gm.index ? gm.index.count / 3 : gm.getAttribute('position').count / 3;
      return a + n * (o.isInstancedMesh ? o.count : 1);
    }, 0);

    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const time = (label, list, n, make) => {
      // warm
      for (let i = 0; i < 5; i++) { const q = make(i); ray.set(q.o, q.d); ray.far = q.far; ray.intersectObjects(list, false); }
      const t0 = performance.now();
      let hits = 0;
      for (let i = 0; i < n; i++) {
        const q = make(i);
        ray.set(q.o, q.d); ray.far = q.far;
        if (ray.intersectObjects(list, false).length) hits++;
      }
      const dt = performance.now() - t0;
      return { label, n, ms: +dt.toFixed(1), per: +(dt / n).toFixed(3), hits };
    };

    const at = i => {
      const s = 200 + (i * 37) % Math.max(1, t.length - 400);
      const f = t.frameAt(s);
      return { f, s };
    };
    const rows = [];
    rows.push(time('down ray, whole stage', all, 200, i => {
      const { f } = at(i);
      return { o: new THREE.Vector3(f.pos.x + 9 * f.right.x, f.pos.y + 6, f.pos.z + 9 * f.right.z), d: down, far: 60 };
    }));
    rows.push(time('down ray, terrain only', terrain, 200, i => {
      const { f } = at(i);
      return { o: new THREE.Vector3(f.pos.x + 9 * f.right.x, f.pos.y + 6, f.pos.z + 9 * f.right.z), d: down, far: 60 };
    }));
    rows.push(time('60 m sightline, terrain only', terrain, 200, i => {
      const { f, s } = at(i);
      const b = t.frameAt(Math.min(t.length, s + 60));
      const o = new THREE.Vector3(f.pos.x, f.pos.y + 2.5, f.pos.z);
      const d = new THREE.Vector3(b.pos.x + 9 * b.right.x, b.pos.y + 1, b.pos.z + 9 * b.right.z).sub(o);
      const far = d.length(); d.normalize();
      return { o, d, far };
    }));
    rows.push(time('60 m sightline, whole stage', all, 200, i => {
      const { f, s } = at(i);
      const b = t.frameAt(Math.min(t.length, s + 60));
      const o = new THREE.Vector3(f.pos.x, f.pos.y + 2.5, f.pos.z);
      const d = new THREE.Vector3(b.pos.x + 9 * b.right.x, b.pos.y + 1, b.pos.z + 9 * b.right.z).sub(o);
      const far = d.length(); d.normalize();
      return { o, d, far };
    }));

    return {
      rows,
      nAll: all.length, nTerrain: terrain.length,
      triAll: Math.round(tris(all)), triTerrain: Math.round(tris(terrain)),
      names: terrain.map(o => o.name),
    };
  });

  console.log(`\n  seed ${SEED}`);
  console.log(`  whole stage: ${out.nAll} meshes, ${out.triAll} triangles`);
  console.log(`  terrain set: ${out.nTerrain} meshes, ${out.triTerrain} triangles  [${out.names.join(', ')}]`);
  console.log();
  for (const r of out.rows) {
    console.log(`    ${r.label.padEnd(30)} ${String(r.n).padStart(4)} rays`
      + `  ${String(r.ms).padStart(8)} ms   ${String(r.per).padStart(7)} ms/ray   ${r.hits} hit`);
  }
  console.log();
});
finish(process.exitCode || 0);
