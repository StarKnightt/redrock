/* What are the pale blotches inside the bore?
 *
 * Names the object behind every bright, low-saturation pixel in an interior
 * frame, so "there is snow on the tunnel floor" becomes a mesh name and a
 * lateral offset. Same shape as tools/tgreen.mjs, different predicate.
 *
 *   node tools/tpale.mjs [--at 0.25]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const AT = Number(flag('at', '0.25'));

await run({ width: 1024, height: 576, hash: 'manual&tier=high&seed=22&cap=60&ink=1' }, async ({ page }) => {
  const out = await page.evaluate(async at => {
    const g = window.__game, THREE = g.THREE;
    const span = g.field.tunnel;
    g.driveTo((span.s0 + (span.s1 - span.s0) * at) / g.track.length);
    g.setPaused(true);
    g.renderOnce();
    const cv = g.renderer.domElement, w = cv.width, h = cv.height;
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(cv, 0, 0);
    const px = ctx.getImageData(0, 0, w, h).data;
    const ray = new THREE.Raycaster();
    const found = new Map();
    let pale = 0;
    for (let y = 0; y < h; y += 3) {
      for (let x = 0; x < w; x += 3) {
        const i = (y * w + x) * 4;
        const r = px[i], gg = px[i + 1], b = px[i + 2];
        const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
        if (mx < 190 || mx - mn > 34) continue;
        pale++;
        ray.setFromCamera(new THREE.Vector2((x / w) * 2 - 1, -((y / h) * 2 - 1)), g.camera);
        const hit = ray.intersectObjects(g.scene.children, true).find(q => q.object.visible);
        if (!hit) continue;
        let f = null, bd = Infinity;
        for (const q of g.track.frames) {
          const e = (q.pos.x - hit.point.x) ** 2 + (q.pos.z - hit.point.z) ** 2;
          if (e < bd) { bd = e; f = q; }
        }
        const d = hit.point.clone().sub(f.pos);
        const key = hit.object.name || 'unnamed';
        const rec = found.get(key) || { n: 0, lat: 0, up: 0, dist: 0, box: [1e9, 1e9, -1e9, -1e9], lum: 0 };
        rec.box[0] = Math.min(rec.box[0], x); rec.box[1] = Math.min(rec.box[1], y);
        rec.box[2] = Math.max(rec.box[2], x); rec.box[3] = Math.max(rec.box[3], y);
        rec.lum += (0.2126 * r + 0.7152 * gg + 0.0722 * b) / 255;
        rec.n++;
        rec.lat += d.dot(f.flatRight);
        rec.up += hit.point.y - f.pos.y;
        rec.dist += hit.distance;
        found.set(key, rec);
      }
    }
    return {
      s: g.player.s, pale, total: Math.ceil(w / 3) * Math.ceil(h / 3),
      rows: [...found].sort((a, b) => b[1].n - a[1].n).map(([k, v]) =>
        `${k.padEnd(22)} n=${String(v.n).padStart(5)}`
        + `  mean lat ${(v.lat / v.n).toFixed(2)}  up ${(v.up / v.n).toFixed(2)}`
        + `  d ${(v.dist / v.n).toFixed(0)}  luma ${(v.lum / v.n).toFixed(2)}`
        + `  screen x${v.box[0]}-${v.box[2]} y${v.box[1]}-${v.box[3]}`),
    };
  }, AT);
  console.log(`\n  s=${out.s.toFixed(0)}  pale ${out.pale}/${out.total}`
    + ` (${(100 * out.pale / out.total).toFixed(1)}%)`);
  out.rows.forEach(r => console.log('  ' + r));
});
finish(process.exitCode || 0);
