/* Which surfaces are sharing a rung inside the bore?
 *
 * A modal-bucket percentage says the interior is collapsing but not what is
 * collapsing into what, and the fix is different depending on the answer:
 * a ceiling and a road in the same bucket is a palette problem, a wall and its
 * own ribs in the same bucket is a banding problem. Raycasts every sampled
 * pixel, buckets it by luma, and reports the mix of objects in each rung.
 *
 *   node tools/trung.mjs [--at 0.5] [--seed 22]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const AT = Number(flag('at', '0.5'));
const SEED = flag('seed', '22');

await run({ width: 640, height: 360, hash: `manual&tier=high&seed=${SEED}&cap=60&ink=1` }, async ({ page }) => {
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
    const rungs = Array.from({ length: 8 }, () => ({ n: 0, by: new Map() }));
    for (let y = 0; y < h; y += 3) {
      for (let x = 0; x < w; x += 3) {
        const i = (y * w + x) * 4;
        const v = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
        const r = rungs[Math.min(7, Math.floor(v * 8))];
        r.n++;
        ray.setFromCamera(new THREE.Vector2((x / w) * 2 - 1, -((y / h) * 2 - 1)), g.camera);
        const hit = ray.intersectObjects(g.scene.children, true).find(q => q.object.visible);
        const key = hit ? (hit.object.name || 'unnamed') : 'sky';
        r.by.set(key, (r.by.get(key) || 0) + 1);
      }
    }
    const total = rungs.reduce((s, r) => s + r.n, 0);
    return {
      s: g.player.s, total,
      rows: rungs.map((r, i) => ({
        i,
        pct: (100 * r.n) / total,
        mix: [...r.by].sort((a, b) => b[1] - a[1]).slice(0, 4)
          .map(([k, n]) => `${k} ${((100 * n) / r.n).toFixed(0)}%`).join(', '),
      })),
    };
  }, AT);
  console.log(`\n  s=${out.s.toFixed(0)}  ${out.total} samples\n`);
  for (const r of out.rows) {
    const bar = '#'.repeat(Math.round(r.pct / 2)).padEnd(35);
    console.log(`  rung ${r.i} ${String(r.pct.toFixed(1)).padStart(5)}%  ${bar} ${r.mix}`);
  }
  console.log();
});
finish(process.exitCode || 0);
