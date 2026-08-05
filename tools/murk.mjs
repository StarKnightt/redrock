/* Why a frame goes dark, as numbers.
 *
 * Two questions this answers that a screenshot cannot:
 *   1. Where every pixel of a frame lands on the value ladder, split by what
 *      object is under it — so "the road, the cliff and the grass are all the
 *      same value" stops being an opinion.
 *   2. What object is actually under a given pixel, with its world position and
 *      vertex colour, which is the only way to name a stray facet.
 *
 *   node tools/murk.mjs [--t 0.92] [--px 360,160]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const TS = flag('t', '0.92').split(',').map(Number);
const PX = flag('px', '');

const W = 1024, H = 576;

await run({ width: W, height: H, hash: 'manual&tier=high&seed=22&cap=60&ink=1' }, async ({ page }) => {
 for (const T of TS) {
  const out = await page.evaluate(async ([t, pxs, js]) => {
    const g = window.__game;
    const THREE = g.THREE;
    if (js) new Function('g', 'THREE', js)(g, THREE);
    g.driveTo(t);
    g.setPaused(true);
    g.renderOnce();

    const cv = g.renderer.domElement;
    const w = cv.width, h = cv.height;
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(cv, 0, 0);
    const px = ctx.getImageData(0, 0, w, h).data;

    /* Raycast a coarse grid and bucket the frame's luma by the object the ray
       hits. Sky is whatever the ray misses. */
    const ray = new THREE.Raycaster();
    ray.far = 4000;
    const hitName = (nx, ny) => {
      ray.setFromCamera(new THREE.Vector2(nx, ny), g.camera);
      const hits = ray.intersectObjects(g.scene.children, true);
      for (const hit of hits) {
        if (!hit.object.visible) continue;
        let o = hit.object;
        if (o.name === 'sky-dome' || o.name === 'sun-disc') break;
        return { name: o.name || o.parent?.name || 'unnamed', d: hit.distance, p: hit.point };
      }
      return { name: 'sky', d: Infinity, p: null };
    };

    const luma = (i) => (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
    const buckets = new Map();
    const STEP = 16;
    for (let y = 0; y < h; y += STEP) {
      for (let x = 0; x < w; x += STEP) {
        const i = (y * w + x) * 4;
        const nx = (x / w) * 2 - 1, ny = -((y / h) * 2 - 1);
        const { name, d } = hitName(nx, ny);
        let b = buckets.get(name);
        if (!b) buckets.set(name, b = { n: 0, sum: 0, min: 9, max: -9, sr: 0, sg: 0, sb: 0, dsum: 0 });
        const L = luma(i);
        b.n++; b.sum += L; b.min = Math.min(b.min, L); b.max = Math.max(b.max, L);
        b.sr += px[i]; b.sg += px[i + 1]; b.sb += px[i + 2];
        if (Number.isFinite(d)) b.dsum += d;
      }
    }
    const rows = [...buckets].map(([name, b]) => ({
      name,
      pct: +(100 * b.n / ((w / STEP) * (h / STEP))).toFixed(1),
      luma: +b.sum.toFixed(4) / b.n,
      min: +b.min.toFixed(3), max: +b.max.toFixed(3),
      rgb: [Math.round(b.sr / b.n), Math.round(b.sg / b.n), Math.round(b.sb / b.n)],
      dist: Math.round(b.dsum / b.n),
    })).sort((a, b) => b.pct - a.pct);
    for (const r of rows) r.luma = +r.luma.toFixed(4);

    /* Whole-frame histogram on the ladder's own rungs. */
    const rungs = new Array(8).fill(0);
    let tot = 0;
    for (let i = 0; i < px.length; i += 4) {
      const L = luma(i);
      rungs[Math.min(7, Math.round(Math.pow(L, 1 / 3) * 7))]++;
      tot++;
    }

    /* Named pixel probes. */
    const probes = [];
    for (const spec of pxs) {
      const [x, y] = spec;
      const nx = (x / w) * 2 - 1, ny = -((y / h) * 2 - 1);
      ray.setFromCamera(new THREE.Vector2(nx, ny), g.camera);
      const hits = ray.intersectObjects(g.scene.children, true).filter(o => o.object.visible);
      const list = [];
      for (const hit of hits.slice(0, 4)) {
        const o = hit.object;
        let col = null;
        const geo = o.geometry;
        if (geo?.attributes?.color && hit.face) {
          const c = geo.attributes.color;
          col = '#' + [c.getX(hit.face.a), c.getY(hit.face.a), c.getZ(hit.face.a)]
            .map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
        }
        /* Landform faces decode straight back to the generator's own
           coordinates: the grid is 16 stations wide and rows are one
           TERRAIN_STEP apart, two triangles per cell, emitted in order. */
        let cell = null;
        if (/^landform-/.test(o.name) && hit.faceIndex != null) {
          const row = Math.floor(hit.faceIndex / 30);
          const col = Math.floor((hit.faceIndex % 30) / 2);
          cell = { s: row * 9, station: col, p: +(row * 9 / g.track.length).toFixed(3) };
        }
        list.push({
          cell,
          name: o.name || o.parent?.name || 'unnamed',
          d: +hit.distance.toFixed(1),
          at: [+hit.point.x.toFixed(1), +hit.point.y.toFixed(1), +hit.point.z.toFixed(1)],
          vcol: col,
          faceIndex: hit.faceIndex,
          instanceId: hit.instanceId ?? null,
        });
      }
      const i = (y * w + x) * 4;
      probes.push({ px: [x, y], rgb: [px[i], px[i + 1], px[i + 2]], hits: list });
    }

    return {
      w, h,
      cam: [+g.camera.position.x.toFixed(1), +g.camera.position.y.toFixed(1), +g.camera.position.z.toFixed(1)],
      s: +g.player.s.toFixed(1),
      rungs: rungs.map(v => +(100 * v / tot).toFixed(2)),
      rows, probes,
      info: g.info(),
    };
  }, [T, PX ? PX.split(';').map(p => p.split(',').map(Number)) : [], flag('js', '')]);

  const shot = path.join(ROOT, 'shots', flag('tag', 'murk'),
    `${String(Math.round(T * 100)).padStart(3, '0')}.png`);
  await capture(page, shot);
  console.log(`  → ${path.relative(ROOT, shot)}`);

  console.log(`\n  t=${T}  s=${out.s} m  cam ${out.cam.join(', ')}  ${out.w}x${out.h}`);
  console.log(`  tris ${(out.info.triangles / 1000).toFixed(0)}k  calls ${out.info.calls}`);
  console.log('\n  ladder rung occupancy (%):');
  console.log('   ' + out.rungs.map((v, i) => `${i}:${v.toFixed(1)}`).join('  '));
  console.log('\n  object              %frame   luma    min    max   avg rgb        dist');
  for (const r of out.rows) {
    if (r.pct < 0.4) continue;
    console.log(`  ${r.name.padEnd(20)}${String(r.pct).padStart(5)}  ${r.luma.toFixed(4)}  `
      + `${r.min.toFixed(3)}  ${r.max.toFixed(3)}  ${JSON.stringify(r.rgb).padEnd(16)} ${r.dist}`);
  }
  for (const p of out.probes) {
    console.log(`\n  pixel ${p.px.join(',')}  rgb ${p.rgb.join(',')}`);
    for (const hit of p.hits) {
      console.log(`    ${hit.name.padEnd(22)} d=${String(hit.d).padStart(7)}  at ${hit.at.join(', ')}`
        + `  vcol=${hit.vcol || '-'}  face=${hit.faceIndex} inst=${hit.instanceId}`
        + (hit.cell ? `  cell s=${hit.cell.s} p=${hit.cell.p} station=${hit.cell.station}` : ''));
    }
  }
 }
});

finish(process.exitCode || 0);
