/* kb* probe — name the mesh under the boots, pixel by pixel.
 *
 * tools/kbfoot.mjs labels the band under each figure by ablation into four
 * buckets, and "other" is the bucket for anything that is neither terrain,
 * water nor sky. This resolves it: for every sample pixel it fires a ray from
 * the camera through that pixel and reports the first mesh hit — and it only
 * trusts that answer when the hit distance agrees with the prepass depth the
 * frame actually shipped, so a raycast skimming a foreground berm cannot pass
 * itself off as the pixel.
 *
 *   node tools/kbwhat.mjs [--seeds 22,1,40] [--backs 20,12,6] [--only finish]
 *                         [--figs 22:19,40:21,40:41,40:10]
 */
import fs from 'node:fs';
import path from 'node:path';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');
const BACKS = flag('backs', '20,12,6').split(',').map(Number);
const ONLY = flag('only', '');
const FIGS = flag('figs', '').split(',').filter(Boolean);

for (const SEED of SEEDS) {
  const want = FIGS.filter(f => f.startsWith(SEED + ':')).map(f => +f.split(':')[1]);
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    page.setDefaultTimeout(900_000);
    const out = await page.evaluate(([backs, only, want]) => {
      const g = window.__game;
      const THREE = g.THREE;
      const t = g.track;
      if (!g.crowd) return { none: true };
      const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
      const gl = g.renderer.getContext();
      const mesh = g.scene.getObjectByName('crowd-figures');
      const place = mesh.geometry.getAttribute('aPlace');

      const targets = [];
      g.stage.traverse(o => { if (o.isMesh && o.visible) targets.push(o); });
      const rc = new THREE.Raycaster();
      rc.far = 6000;

      const grab = () => {
        const px = new Uint8Array(W * H * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      const moved = (a, b, p) => Math.abs(a[p * 4] - b[p * 4]) > 6
        || Math.abs(a[p * 4 + 1] - b[p * 4 + 1]) > 6
        || Math.abs(a[p * 4 + 2] - b[p * 4 + 2]) > 6;
      const at = (x, yTop) => (H - 1 - yTop) * W + x;
      const boxOf = (a, b) => {
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
        for (let p = 0; p < W * H; p++) {
          if (!moved(a, b, p)) continue;
          n++;
          const x = p % W, y = H - 1 - ((p / W) | 0);
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        return n ? { n, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null;
      };

      const rows = [];
      g.setPaused(true);
      g.autopilot(true, 0.85);
      for (const site of g.crowd.sites) {
        if (only && site.kind !== only && !want.length) continue;
        let closest = Infinity, atS = site.s;
        for (let s = Math.max(0, site.s - 250); s <= Math.min(t.length, site.s + 250); s += 2) {
          const f = t.frameAt(s);
          const d = Math.hypot(site.at.x - f.pos.x, site.at.z - f.pos.z);
          if (d < closest) { closest = d; atS = s; }
        }
        const mine = [];
        for (let i = 0; i < place.count; i++) {
          if (Math.hypot(place.getX(i) - site.at.x, place.getZ(i) - site.at.z) > 26) continue;
          if (want.length && !want.includes(i) && site.kind !== only) continue;
          mine.push(i);
        }
        if (!mine.length) continue;

        for (const back of backs) {
          g.goTo(Math.max(0, atS - back - 55) / t.length);
          g.warp(0.75);
          const stop = Math.max(1, atS - back);
          for (let k = 0; k < 260 && g.player.s < stop; k++) g.step(1 / 60);

          const real = performance.now.bind(performance);
          const pinned = real();
          performance.now = () => pinned;
          g.renderOnce();
          g.renderOnce();
          const A = grab();
          const depth = new Float32Array(W * H * 4);
          g.renderer.readRenderTargetPixels(g.pipeline.normals, 0, 0, W, H, depth);
          g.camera.updateMatrixWorld();

          for (const i of mine) {
            const y0 = place.getY(i);
            place.setY(i, y0 - 5000); place.needsUpdate = true;
            g.renderOnce();
            const B = grab();
            place.setY(i, y0); place.needsUpdate = true;
            g.renderOnce();
            const bb = boxOf(A, B);
            if (!bb) continue;
            const xs = [];
            for (let q = -2; q <= 2; q++) xs.push(Math.round(bb.x0 + bb.w * (0.5 + q * 0.12)));
            const hits = [];
            for (const dy of [3, 5, 8]) {
              const y = bb.y1 + dy;
              for (const x of xs) {
                if (x < 0 || x >= W || y < 0 || y >= H) continue;
                const dep = depth[at(x, y) * 4 + 3];
                const ndc = new THREE.Vector3(x / W * 2 - 1, -(y / H * 2 - 1), 0.5).unproject(g.camera);
                const dir = ndc.sub(g.camera.position).normalize();
                rc.set(g.camera.position, dir);
                const hh = rc.intersectObjects(targets, false);
                const first = hh.length ? hh[0] : null;
                /* The prepass writes -viewZ, not range, so the ray distance is
                   converted before it is compared: a pixel forty degrees off
                   axis is a tenth further in range than in depth. */
                let viewZ = null;
                if (first) {
                  const vp = first.point.clone().applyMatrix4(g.camera.matrixWorldInverse);
                  viewZ = -vp.z;
                }
                hits.push({
                  dy, x, y, dep: +dep.toFixed(1),
                  name: first ? (first.object.name || '(unnamed)') : null,
                  viewZ: viewZ === null ? null : +viewZ.toFixed(1),
                  agrees: viewZ !== null && Math.abs(viewZ - dep) < Math.max(0.6, 0.03 * dep),
                });
              }
            }
            const tally = {};
            for (const hh of hits) {
              const k = hh.agrees ? (hh.name || 'nothing') : `?${hh.name || 'nothing'}`;
              tally[k] = (tally[k] || 0) + 1;
            }
            rows.push({
              kind: site.kind, siteS: Math.round(site.s), i, back, h: bb.h,
              tally, hits,
              agree: hits.filter(hh => hh.agrees).length, n: hits.length,
            });
          }
          performance.now = real;
        }
      }
      g.autopilot(false);
      return { rows };
    }, [BACKS, ONLY, want]);

    if (out.none) { console.log(`seed ${SEED}: no crowd`); return; }
    console.log(`\n══ seed ${SEED}`);
    for (const r of out.rows) {
      const tal = Object.entries(r.tally).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${v}x ${k}`).join(', ');
      console.log(`   i=${String(r.i).padStart(3)} ${r.kind}/${r.siteS} back=${String(r.back).padStart(2)}`
        + ` ${String(r.h).padStart(3)}px   under the boots: ${tal}`
        + `   (ray agrees with prepass on ${r.agree}/${r.n})`);
    }
    fs.mkdirSync(path.resolve('.meas/r2'), { recursive: true });
    fs.writeFileSync(path.resolve(`.meas/r2/kb-what-${SEED}.json`), JSON.stringify(out.rows, null, 0));
  });
}
finish(process.exitCode || 0);
