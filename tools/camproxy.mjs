/* What the camera's collision proxy can and cannot see.
 *
 * SolidWorld flattens the stage into a triangle grid once, at boot, selecting
 * meshes by a name pattern. That is a standing hazard in a project where
 * another agent is reshaping the world: a mesh that gets renamed, wrapped in a
 * new parent, or converted to an InstancedMesh silently drops out of the proxy,
 * and the camera stops being protected from the exact geometry that just
 * changed — with no error anywhere.
 *
 * This lists every mesh in the stage, says whether the proxy took it and why,
 * and totals the triangles on each side of the line, so a regression in the
 * selection shows up as a number rather than as a navy frame.
 *
 *   node tools/camproxy.mjs [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

await run({ width: 960, height: 540, hash: 'manual&tier=high&seed=22&cap=0&hud=0' }, async ({ page }) => {
  const out = await page.evaluate(() => {
    const g = window.__game;
    /* Read from the live proxy, never restated here. A tool that keeps its own
       copy of the selection rule agrees with itself and tells you nothing. */
    const include = g.solid.include;
    const rows = [];

    g.stage.updateMatrixWorld(true);
    g.stage.traverse(o => {
      if (!o.isMesh) return;
      let name = o.name, from = 'self';
      for (let p = o.parent; !name && p; p = p.parent) { name = p.name; from = 'ancestor'; }
      const geo = o.geometry;
      const tris = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
      const inst = !!o.isInstancedMesh;
      const matched = include.test(name || '');
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      rows.push({
        name: name || '(unnamed)',
        from,
        tris: inst ? tris * o.count : tris,
        baseTris: tris,
        instances: inst ? o.count : 0,
        inst,
        taken: matched && !inst,
        why: !matched ? 'name does not match' : inst ? 'instanced, skipped by design' : 'taken',
        size: [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z].map(v => +v.toFixed(1)),
        visible: o.visible,
        obj: o,
      });
    });

    /* Whether a mesh belongs in the proxy is not a matter of taste, it is a
       matter of whether the camera can ever get near it. So each excluded body
       is measured against the road: how close it comes to the centreline, and
       whether any of it stands high enough to swallow a lens that flies three
       metres up and nine metres back. Anything reaching into that envelope and
       not in the proxy is a hole in the protection. */
    const THREE = g.THREE;
    const line = [];
    for (let s = 0; s < g.track.length; s += 8) line.push(g.track.pointAt(s, 0, new THREE.Vector3()));
    const box = new THREE.Box3();
    for (const r of rows) {
      if (r.taken || !r.obj) continue;
      box.setFromObject(r.obj);
      let near = Infinity, nearY = 0;
      for (const q of line) {
        const d = Math.hypot(
          Math.max(box.min.x - q.x, 0, q.x - box.max.x),
          Math.max(box.min.z - q.z, 0, q.z - box.max.z),
        );
        if (d < near) { near = d; nearY = box.max.y - q.y; }
      }
      r.nearRoad = +near.toFixed(1);
      r.topAboveRoad = +nearY.toFixed(1);
    }
    for (const r of rows) delete r.obj;

    const w = g.solid;
    return {
      rows,
      proxy: { count: w.count, entries: w.entries, nx: w.nx, nz: w.nz, names: w.names },
    };
  });

  const agg = new Map();
  for (const r of out.rows) {
    const k = `${r.name}|${r.why}`;
    const a = agg.get(k) || { ...r, n: 0, tris: 0, instances: 0 };
    a.n++; a.tris += r.tris; a.instances += r.instances;
    agg.set(k, a);
  }
  const list = [...agg.values()].sort((a, b) => b.tris - a.tris);

  const taken = list.filter(r => r.taken);
  const skipped = list.filter(r => !r.taken);
  const sum = rs => rs.reduce((a, r) => a + r.tris, 0);

  console.log(`  ${out.rows.length} meshes in the stage,`
    + ` ${taken.reduce((a, r) => a + r.n, 0)} taken into the proxy\n`);
  console.log(`  proxy: ${out.proxy.count.toLocaleString()} triangles,`
    + ` ${out.proxy.entries.toLocaleString()} grid entries, ${out.proxy.nx}x${out.proxy.nz} cells\n`);

  console.log('  TAKEN');
  for (const r of taken) {
    console.log(`    ${r.name.padEnd(26)} ${String(r.n).padStart(3)}x`
      + ` ${String(Math.round(r.tris)).padStart(7)} tris   ${r.size.join(' x ')} m`
      + `   (matched on ${r.from})`);
  }
  console.log(`    ${''.padEnd(26)}     ${String(Math.round(sum(taken))).padStart(7)} total`);

  console.log('\n  NOT TAKEN');
  for (const r of skipped) {
    if (!VERBOSE && r.tris < 200 && !r.inst) continue;
    console.log(`    ${r.name.padEnd(26)} ${String(r.n).padStart(3)}x`
      + ` ${String(Math.round(r.tris)).padStart(7)} tris`
      + (r.instances ? ` (${r.instances} instances of ${r.baseTris})` : '')
      + `   ${r.size.join(' x ')} m   — ${r.why}`);
  }
  console.log(`    ${''.padEnd(26)}     ${String(Math.round(sum(skipped))).padStart(7)} total`);

  /* The check that actually matters: solid geometry the lens can reach that the
     proxy is not looking at. Reach, not size — the sky dome is enormous and
     irrelevant, a ten-metre rock beside an apex is small and decisive. */
  const near = r => (r.nearRoad === undefined ? Infinity : r.nearRoad);
  const risky = skipped.filter(r => !r.inst && near(r) <= 14 && r.topAboveRoad >= -1);
  console.log('\n  solid, not instanced, within 14 m of the road, and NOT in the proxy:');
  if (!risky.length) console.log('    none');
  for (const r of risky.sort((a, b) => near(a) - near(b))) {
    console.log(`    ${r.name.padEnd(26)} within ${(near(r) + ' m').padStart(7)} of the centreline,`
      + ` top ${(r.topAboveRoad + ' m').padStart(8)} above it,`
      + ` ${String(Math.round(r.tris)).padStart(6)} tris`);
  }
  const rest = skipped.filter(r => !r.inst && near(r) > 14 && near(r) < Infinity);
  console.log(`\n  ${rest.length} other excluded solid bodies, none closer than 14 m to the road:`);
  console.log('    ' + rest.sort((a, b) => near(a) - near(b))
    .map(r => `${r.name} (${near(r)} m)`).join(', '));

  fs.mkdirSync(path.join(ROOT, 'shots', 'camproxy'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'shots', 'camproxy', 'meshes.json'), JSON.stringify(out, null, 1));
  console.log('\n  → shots/camproxy/meshes.json');
});

finish(process.exitCode || 0);
