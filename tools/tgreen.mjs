/* Scratch: what is still green inside the tunnel? */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

await run({ width: 1024, height: 576, hash: 'manual&tier=high&seed=22&cap=60&ink=1' }, async ({ page }) => {
  const out = await page.evaluate(() => {
    const g = window.__game, THREE = g.THREE;
    const span = g.field.tunnel;
    g.driveTo((span.s0 + (span.s1 - span.s0) * 0.5) / g.track.length);
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
    let green = 0;
    for (let y = 0; y < h; y += 4) {
      for (let x = 0; x < w; x += 4) {
        const i = (y * w + x) * 4;
        const r = px[i], gg = px[i + 1], b = px[i + 2];
        if (!(gg > r * 1.28 && gg > b * 1.12 && gg > 40)) continue;
        green++;
        ray.setFromCamera(new THREE.Vector2((x / w) * 2 - 1, -((y / h) * 2 - 1)), g.camera);
        const hits = ray.intersectObjects(g.scene.children, true);
        const hit = hits.find(q => q.object.visible);
        if (!hit) continue;
        let f = null, bd = Infinity;
        for (const q of g.track.frames) {
          const e = (q.pos.x - hit.point.x) ** 2 + (q.pos.z - hit.point.z) ** 2;
          if (e < bd) { bd = e; f = q; }
        }
        const d = hit.point.clone().sub(f.pos);
        const key = hit.object.name || 'unnamed';
        const rec = found.get(key) || { n: 0, lat: 0, up: 0, dist: 0, box: [1e9, 1e9, -1e9, -1e9] };
        rec.box[0] = Math.min(rec.box[0], x); rec.box[1] = Math.min(rec.box[1], y);
        rec.box[2] = Math.max(rec.box[2], x); rec.box[3] = Math.max(rec.box[3], y);
        rec.n++;
        rec.lat += d.dot(f.right);
        rec.up += d.dot(f.up);
        rec.dist += hit.distance;
        found.set(key, rec);
      }
    }
    return {
      s: g.player.s, green, total: (w / 4) * (h / 4),
      rows: [...found].map(([k, v]) => `${k.padEnd(22)} n=${String(v.n).padStart(5)}`
        + `  mean lat ${(v.lat / v.n).toFixed(2)}  up ${(v.up / v.n).toFixed(2)}`
        + `  d ${(v.dist / v.n).toFixed(0)}`
        + `  screen x${v.box[0]}-${v.box[2]} y${v.box[1]}-${v.box[3]}`),
    };
  });
  console.log(`\n  s=${out.s.toFixed(0)}  green ${out.green}/${out.total} samples`
    + ` (${(100 * out.green / out.total).toFixed(1)}%)`);
  out.rows.forEach(r => console.log('  ' + r));
});
finish(process.exitCode || 0);
