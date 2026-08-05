/* Where should the cheerleaders stand on the grid?
 *
 * The countdown work recommends moving the start-line squad from s = 56 to
 * about s = 40, on the inside, on the grounds that three figures 44 px tall
 * at 22 m ahead are not what the eye goes to while the lights are counting.
 * That is a claim about pixels and it should be settled in pixels rather
 * than accepted.
 *
 * The car is set down at s = 34 and held there for the countdown, so this
 * measures the frame the player is actually looking at during it: the car
 * parked on the grid, the countdown running, the squad walked along the road
 * and across both shoulders. For each candidate the squad is measured by
 * ablation — render, drop the three instances five kilometres down, render
 * again, diff — which counts only pixels those three figures own, through
 * the ink and behind every occluder.
 *
 * Reported per candidate: total footprint, the tallest figure, and how far
 * off the centre of frame the group sits, because a big group at the edge of
 * the frame is not where the eye goes either.
 *
 *   node tools/zqgrid.mjs [--seeds 22,1,40] [--at 30,36,40,46,56,66,80]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');
const AT = flag('at', '30,36,40,46,52,56,62,70,80').split(',').map(Number);
const SHOT = args.includes('--shots');

const outDir = path.join(ROOT, 'shots', 'zqgrid');
if (SHOT) fs.mkdirSync(outDir, { recursive: true });

for (const SEED of SEEDS) {
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    page.setDefaultTimeout(600_000);
    const out = await page.evaluate(([at]) => {
      const g = window.__game;
      const env = g.scene.getObjectByName('environment') || g.stage.getObjectByName('environment');
      const probe = env?.userData?.crowdProbe;
      const mesh = g.scene.getObjectByName('crowd-figures');
      if (!probe || !mesh || !g.crowd) return { none: true };
      const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
      const gl = g.renderer.getContext();
      const place = mesh.geometry.getAttribute('aPlace');

      const grab = () => {
        const px = new Uint8Array(W * H * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      const diff = (a, b) => {
        let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let i = 0, p = 0; i < a.length; i += 4, p++) {
          if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i + 1] - b[i + 1]) > 6
            || Math.abs(a[i + 2] - b[i + 2]) > 6) {
            n++;
            const x = p % W, y = H - 1 - ((p / W) | 0);
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
        return n ? { n, x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1, cx: (x0 + x1) / 2 } : { n: 0 };
      };

      /* The squad, found by proximity to the start-line site rather than by
         index, so this keeps working if the build order changes. */
      const site = g.crowd.sites.find(s => s.kind === 'start line');
      if (!site) return { none: true, why: 'no start-line squad on this build' };
      const squad = [];
      for (let i = 0; i < place.count; i++) {
        if (Math.hypot(place.getX(i) - site.at.x, place.getZ(i) - site.at.z) > 26) continue;
        squad.push({ i, h: place.getW(i) });
      }
      const keep = squad.map(q => [place.getX(q.i), place.getY(q.i), place.getZ(q.i)]);

      /* The grid, exactly as the player sees it: the car set down where the
         race starts it and the countdown held on screen. */
      g.setPaused(true);
      g.goTo(34 / g.track.length);
      g.crowd.setHype(1);
      const rows = [];

      for (const s of at) {
        for (const side of [1, -1]) {
          const u = probe.stand(s, side);
          const model = u !== null;
          const uUse = u !== null
            ? u
            : Math.min(0.86, probe.stand_m / Math.max(probe.wallDist(s, side), 1));
          // Three abreast down the road, the spacing the build uses.
          for (let k = 0; k < squad.length; k++) {
            const p = probe.point(s + (k - 1) * squad[k].h * 1.6, side, uUse);
            place.setX(squad[k].i, p.x);
            place.setY(squad[k].i, p.y - 0.06);
            place.setZ(squad[k].i, p.z);
          }
          place.needsUpdate = true;

          const real = performance.now.bind(performance);
          const pinned = real();
          performance.now = () => pinned;
          g.renderOnce();               // frame 0, discarded
          g.renderOnce();
          const A = grab();
          g.renderOnce();
          const drift = diff(A, grab()).n;
          const ys = squad.map(q => place.getY(q.i));
          squad.forEach(q => place.setY(q.i, -5000));
          place.needsUpdate = true;
          g.renderOnce();
          const d = diff(A, grab());
          squad.forEach((q, k) => place.setY(q.i, ys[k]));
          place.needsUpdate = true;
          g.renderOnce();
          performance.now = real;

          rows.push({
            s, side, model, drift,
            off: +(uUse * probe.wallDist(s, side)).toFixed(1),
            px: d.n, tall: d.h || 0,
            fromCentre: d.n ? Math.round(Math.abs(d.cx - W / 2)) : null,
          });
        }
      }
      squad.forEach((q, k) => {
        place.setX(q.i, keep[k][0]); place.setY(q.i, keep[k][1]); place.setZ(q.i, keep[k][2]);
      });
      place.needsUpdate = true;
      g.crowd.setHype(0);
      return { rows, shipped: Math.round(site.s), shippedSide: site.side, n: squad.length, W };
    }, [AT]);

    if (out.none) { console.log(`  seed ${SEED}: ${out.why || 'no crowd'}`); return; }
    console.log(`\n══ seed ${SEED} — ${out.n} in the squad, currently at s=${out.shipped}`
      + ` side ${out.shippedSide}, car on the grid at s=34`);
    console.log('      s   side   stands   off kerb    squad px   tallest   from frame centre');
    for (const r of out.rows) {
      const mark = r.s === out.shipped && r.side === out.shippedSide ? '  ← shipped' : '';
      console.log(`   ${String(r.s).padStart(4)}   ${String(r.side).padStart(3)}`
        + `   ${(r.model ? 'yes' : 'NO').padStart(5)}`
        + `   ${(r.off + ' m').padStart(8)}`
        + `   ${String(r.px).padStart(9)}   ${String(r.tall).padStart(5)} px`
        + `   ${r.fromCentre === null ? '   —' : String(r.fromCentre).padStart(6) + ' px'}`
        + `${r.drift ? '   drift ' + r.drift : ''}${mark}`);
    }
  });
}
console.log();
finish(process.exitCode || 0);
