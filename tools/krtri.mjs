/* ROUND-2 RE-CHECK — the triangle count, from three independent routes.
 *
 * tools/boot.mjs's triangle column and tools/budget.mjs's instancing fix have
 * both been repaired recently, so neither is trusted here. Everything below is
 * counted from the geometry buffers in the page, and the renderer's own
 * snapshot is printed beside it as a fourth, dependent, opinion.
 *
 *   crowd.triangles   what the module computes for itself
 *   direct            crowd-figures position.count/3 x instanceCount, plus the
 *                     crowd-barriers geometry, counted here from the buffers
 *   walk(stage)       every drawn mesh under g.stage, tris x instances,
 *                     drawRange honoured, hidden subtrees excluded
 *   walk(scene)       the same over the whole scene, which is what
 *                     tools/budget.mjs actually walks (it includes the car,
 *                     the sky dome and the fx pools)
 *   pipeline.stats    the beauty pass as the renderer counted it, after
 *                     frustum culling — a lower bound on the walk
 *
 * 1600x900, car driven in by the autopilot to the busiest crowd site, through
 * the real pipeline. Clock pinned for the render so the figure is repeatable.
 *
 *   node tools/krtri.mjs [--seed 22]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');

let out = null;
await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  out = await page.evaluate(() => {
    const g = window.__game;
    const t = g.track;

    /* three's own rule for how many instances a plain Mesh with an
       InstancedBufferGeometry draws: min(instanceCount, _maxInstanceCount),
       and instanceCount defaults to Infinity. */
    const instancesOf = (o, geo) => {
      if (o.isInstancedMesh) return { n: o.count, how: 'InstancedMesh.count' };
      if (geo.isInstancedBufferGeometry) {
        const cap = geo._maxInstanceCount;
        const n = Math.min(geo.instanceCount, Number.isFinite(cap) ? cap : Infinity);
        return Number.isFinite(n)
          ? { n, how: `instanceCount=${geo.instanceCount} cap=${cap}` }
          : { n: 1, how: 'UNBOUNDED — counted as 1' };
      }
      return { n: 1, how: 'single' };
    };
    const trisOf = geo => {
      const full = geo.index ? geo.index.count : geo.attributes.position.count;
      const range = geo.drawRange && Number.isFinite(geo.drawRange.count)
        ? Math.min(geo.drawRange.count, full - geo.drawRange.start) : full;
      return range / 3;
    };
    const walk = (rootObj) => {
      const rows = [];
      let total = 0, hidden = 0, notMesh = [];
      rootObj.traverse(o => {
        const geo = o.geometry;
        if (!geo || !geo.attributes || !geo.attributes.position) return;
        if (!o.isMesh) { notMesh.push(`${o.name || o.type} (${o.type})`); return; }
        let vis = o.visible;
        for (let q = o.parent; vis && q; q = q.parent) vis = q.visible;
        const { n, how } = instancesOf(o, geo);
        const each = trisOf(geo);
        const tris = each * n;
        if (!vis) { hidden += tris; return; }
        total += tris;
        rows.push({ name: o.name || o.type, tris, each, n, how });
      });
      rows.sort((a, b) => b.tris - a.tris);
      return { total, rows, hidden, notMesh };
    };

    // ── drive in to the busiest crowd site ────────────────────────────
    const sites = g.crowd ? g.crowd.sites : [];
    let site = sites[0];
    for (const c of sites) {
      const n = c.groups.reduce((a, b) => a + b.n, 0);
      if (!site || n > site.groups.reduce((a, b) => a + b.n, 0)) site = c;
    }
    g.setPaused(true);
    g.autopilot(true, 0.85);
    if (site) {
      g.goTo(Math.max(0, site.s - 200) / t.length);
      g.warp(0.75);
      for (let k = 0; k < 400 && g.player.s < site.s - 26; k++) g.step(1 / 60);
    } else {
      g.driveTo(0.5);
    }

    const real = performance.now.bind(performance);
    const pinned = real();
    performance.now = () => pinned;
    g.renderOnce();                     // frame 0, discarded
    g.renderOnce();
    const beauty = { ...g.pipeline.stats };
    performance.now = real;

    const fig = g.scene.getObjectByName('crowd-figures');
    const rail = g.scene.getObjectByName('crowd-barriers');
    const figGeo = fig.geometry;
    const figInst = instancesOf(fig, figGeo);
    const figEach = trisOf(figGeo);
    const railTris = rail ? trisOf(rail.geometry) : 0;

    const stage = walk(g.stage);
    const scene = walk(g.scene);

    return {
      seed: g.track.seed,
      site: site ? { kind: site.kind, s: Math.round(site.s),
        n: site.groups.reduce((a, b) => a + b.n, 0) } : null,
      atS: Math.round(g.player.s), kmh: Math.round(g.player.kmh),
      module: { triangles: g.crowd.triangles, figures: g.crowd.figures,
        sites: sites.length,
        totalInSites: sites.reduce((a, s) => a + s.groups.reduce((x, y) => x + y.n, 0), 0) },
      direct: {
        vertsPerFigure: figGeo.attributes.position.count,
        trisPerFigure: figEach,
        instances: figInst.n, how: figInst.how,
        figureTris: figEach * figInst.n,
        railPresent: !!rail,
        railTris,
        /* The module computes its own total as position.count / 3 for the
           rails. If the rail geometry is indexed, that is not the triangle
           count — index.count / 3 is — and the two are printed side by side. */
        railIndexed: rail ? !!rail.geometry.index : false,
        railPosCount: rail ? rail.geometry.attributes.position.count : 0,
        railIndexCount: rail && rail.geometry.index ? rail.geometry.index.count : 0,
        railTrisModuleWay: rail ? rail.geometry.attributes.position.count / 3 : 0,
        total: figEach * figInst.n + railTris,
      },
      beauty,
      stage: { total: stage.total, hidden: stage.hidden, top: stage.rows.slice(0, 16),
        notMesh: stage.notMesh, meshes: stage.rows.length },
      scene: { total: scene.total, hidden: scene.hidden, meshes: scene.rows.length,
        top: scene.rows.slice(0, 8) },
      crowdInWalk: scene.rows.filter(r => /crowd/.test(r.name)),
    };
  });
});

if (out) {
  const n = v => String(Math.round(v)).padStart(8);
  console.log(`\n  seed ${out.seed} — ${out.site ? out.site.kind : 'no site'}`
    + ` s=${out.site ? out.site.s : '-'} (${out.site ? out.site.n : 0} figures at the site),`
    + ` car at s=${out.atS}, ${out.kmh} km/h`);
  console.log('\n  CROWD');
  console.log(`    module g.crowd.triangles      ${n(out.module.triangles)}`
    + `   for ${out.module.figures} figures over ${out.module.sites} sites`
    + ` (site tally ${out.module.totalInSites})`);
  console.log(`    direct from the buffers       ${n(out.direct.total)}`
    + `   = ${out.direct.trisPerFigure} tri/figure (${out.direct.vertsPerFigure} verts)`
    + ` x ${out.direct.instances} instances [${out.direct.how}]`
    + ` + ${out.direct.railTris} rail`);
  console.log(`    crowd-barriers geometry       indexed=${out.direct.railIndexed}`
    + `  position.count=${out.direct.railPosCount}  index.count=${out.direct.railIndexCount}`
    + `  →  ${out.direct.railTris} triangles, but the module counts`
    + ` ${out.direct.railTrisModuleWay}`);
  for (const r of out.crowdInWalk) {
    console.log(`    walk row ${r.name.padEnd(20)} ${n(r.tris)}   ${r.n} x ${r.each}`);
  }
  console.log('\n  STAGE');
  console.log(`    walk of g.stage               ${n(out.stage.total)}`
    + `   over ${out.stage.meshes} drawn meshes (${Math.round(out.stage.hidden)} tri hidden, excluded)`);
  console.log(`    walk of g.scene               ${n(out.scene.total)}`
    + `   over ${out.scene.meshes} drawn meshes (${Math.round(out.scene.hidden)} tri hidden, excluded)`);
  console.log(`    pipeline.stats, beauty pass   ${n(out.beauty.triangles)}`
    + `   in ${out.beauty.calls} calls — frustum-culled, so below the walk`);
  console.log(`    stage walk - beauty           ${n(out.stage.total - out.beauty.triangles)}`);
  console.log('\n  biggest contributors to the g.stage walk');
  for (const r of out.stage.top) {
    console.log(`    ${r.name.padEnd(26)} ${n(r.tris)}  ${(100 * r.tris / out.stage.total).toFixed(1).padStart(5)}%`
      + (r.n > 1 ? `   ${r.n} x ${r.each}` : ''));
  }
  if (out.stage.notMesh.length) {
    console.log('\n  non-mesh drawables under g.stage, excluded:');
    for (const s of [...new Set(out.stage.notMesh)]) console.log(`    ! ${s}`);
  }
  const f = path.join(ROOT, '.meas', 'r2', `krtri-${SEED}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(out, null, 1));
  console.log(`\n  → ${f}`);
}
finish(process.exitCode || 0);
