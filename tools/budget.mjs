/* Where the triangles actually went.
   `shoot` reports one number for the whole stage, which tells you that you are
   over budget but not what to cut. This walks the built scene and attributes
   every triangle to the mesh that owns it, instance counts included. */
import { run } from './harness.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');

let rows = [], drawn = null, odd = [];
await run({ width: 320, height: 200, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0` },
  async ({ page }) => {
  ({ rows, drawn, odd } = await page.evaluate(() => {
    const game = window.__game;
    game.setPaused(true);
    const out = [], bad = [];
    game.scene.traverse((o) => {
      const g = o.geometry;
      if (!g || !g.attributes || !g.attributes.position) return;
      /* Only meshes. A LineSegments or a Points draws the same buffer with no
         triangles in it at all, and dividing its vertex count by three is a
         triangle count for something that has none. */
      if (!o.isMesh) { bad.push(`${o.name || o.type}: ${o.type}, not a mesh — skipped`); return; }
      /* drawRange, because a geometry can be allocated large and drawn short,
         and three obeys the range. Infinity means "all of it". */
      const full = g.index ? g.index.count : g.attributes.position.count;
      const range = g.drawRange && Number.isFinite(g.drawRange.count)
        ? Math.min(g.drawRange.count, full - g.drawRange.start) : full;
      const tris = range / 3;
      /* An InstancedMesh carries its own count; an InstancedBufferGeometry
         keeps it on the geometry and is drawn by a plain Mesh, which this
         used to score as a single instance. The crowd is the first mesh on
         the stage built that way and it was reading as 18 triangles instead
         of 504.
         InstancedBufferGeometry.instanceCount defaults to Infinity, and three
         then draws min(instanceCount, geometry._maxInstanceCount) — so taking
         the property at face value can score a mesh as infinite triangles.
         The clamp is the renderer's own rule, reproduced. */
      let n = 1;
      if (o.isInstancedMesh) n = o.count;
      else if (g.isInstancedBufferGeometry) {
        const cap = g._maxInstanceCount;
        n = Math.min(g.instanceCount, Number.isFinite(cap) ? cap : Infinity);
        if (!Number.isFinite(n)) {
          bad.push(`${o.name || o.type}: instanceCount is ${g.instanceCount}`
            + ` and no _maxInstanceCount — counted as 1`);
          n = 1;
        }
      }
      let vis = o.visible;
      for (let q = o.parent; vis && q; q = q.parent) vis = q.visible;
      if (!vis) bad.push(`${o.name || o.type}: hidden — counted anyway`);
      out.push({ name: o.name || o.type, tris: tris * n, each: tris, n });
    });

    /* What the renderer actually drew, so the walk above is checked against
       the thing it is modelling rather than against itself. pipeline.stats is
       the beauty pass alone — snapshotted inside the pipeline before the
       composite resets renderer.info, which is why reading renderer.info here
       would report one triangle. It counts only what survived frustum
       culling, so it sits a little under the walk; a walk that reads far
       BELOW it is miscounting instances, which is the defect this line
       exists to catch. */
    game.renderOnce();
    return { rows: out, drawn: { ...game.pipeline.stats }, odd: bad };
  }));
});

const total = rows.reduce((a, b) => a + b.tris, 0);
rows.sort((a, b) => b.tris - a.tris);
for (const row of rows) {
  if (row.tris < total * 0.004) continue;
  const share = ((row.tris / total) * 100).toFixed(1).padStart(5);
  console.log(
    `  ${row.name.padEnd(26)} ${String(Math.round(row.tris)).padStart(7)}  ${share}%`
    + (row.n > 1 ? `   ${row.n} x ${row.each}` : ''),
  );
}
console.log(`\n  ${'total'.padEnd(26)} ${String(Math.round(total)).padStart(7)}`);
if (drawn) {
  const delta = total - drawn.triangles;
  console.log(`  ${'renderer, beauty pass'.padEnd(26)} ${String(drawn.triangles).padStart(7)}`
    + `  in ${drawn.calls} calls  — the walk is ${delta >= 0 ? '+' : ''}${Math.round(delta)}`
    + ` (${(delta / Math.max(1, drawn.triangles) * 100).toFixed(1)}%),`
    + ` which should be a small surplus from frustum culling.`);
  if (delta < -drawn.triangles * 0.02) {
    console.log('  ✗ the walk is UNDER what was drawn — instances are being missed.');
    process.exitCode = 1;
  }
}
for (const o of odd) console.log(`  ! ${o}`);
