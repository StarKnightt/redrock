/* The start-line squad, measured on the grid frame the player actually sees.
 *
 * The disclosed pushback says the squad at CROWD_START_S = 46 measures 8208 px
 * of footprint and a 104 px tallest figure, against 3509 px and 87 px at 40,
 * and that the original complaint was 44 px. The grid capture shows three
 * cheerleaders that look nothing like 104 px tall, so this measures the same
 * thing from the frame rather than from a note.
 *
 * Ablation, clock pinned, frame 0 discarded, 1600x900 through the pipeline.
 * Two camera states, because they are different pictures and the pushback does
 * not say which one it used:
 *   grid   the car set down on the grid the way main.js starts a race
 *   count  the same with the countdown's uHype driven to 1
 *
 *   node tools/kqgrid.mjs [--seeds 22,1,40]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');

for (const SEED of SEEDS) {
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    page.setDefaultTimeout(600_000);
    const out = await page.evaluate(() => {
      const g = window.__game;
      if (!g.crowd) return { none: true };
      const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
      const gl = g.renderer.getContext();
      const mesh = g.scene.getObjectByName('crowd-figures');
      const place = mesh.geometry.getAttribute('aPlace');

      /* The squad is the group the scheduler files as 'start line'. Taken from
         the site rather than by station, so a figure jittered a couple of
         metres either way is still counted. */
      const site = g.crowd.sites.find(s => s.kind === 'start line');
      if (!site) return { noSquad: true };
      const mine = [];
      for (let i = 0; i < place.count; i++) {
        if (Math.hypot(place.getX(i) - site.at.x, place.getZ(i) - site.at.z) > 26) continue;
        mine.push(i);
      }

      const grab = () => {
        const px = new Uint8Array(W * H * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      const box = (a, b) => {
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
        for (let i = 0, p = 0; i < a.length; i += 4, p++) {
          if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i + 1] - b[i + 1]) > 6
            || Math.abs(a[i + 2] - b[i + 2]) > 6) {
            n++;
            const x = p % W, yy = H - 1 - ((p / W) | 0);
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
          }
        }
        return n ? { n, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null;
      };

      const rows = [];
      for (const hype of [0, 1]) {
        g.setPaused(true);
        g.goTo(34 / g.track.length);
        g.warp(0.5);
        g.crowd.setHype(hype);
        g.crowd.update(g.player.pos, 0.4);

        const real = performance.now.bind(performance);
        const pinned = real();
        performance.now = () => pinned;
        g.renderOnce();          // frame 0, discarded
        g.renderOnce();
        const A = grab();

        // The whole squad at once.
        const ys = mine.map(i => place.getY(i));
        mine.forEach(i => place.setY(i, ys[mine.indexOf(i)] - 5000));
        place.needsUpdate = true;
        g.renderOnce();
        const all = grab();
        mine.forEach((i, k) => place.setY(i, ys[k]));
        place.needsUpdate = true;
        g.renderOnce();
        const whole = box(A, all);

        // And each figure alone, for the tallest.
        const each = [];
        for (let k = 0; k < mine.length; k++) {
          const i = mine[k];
          place.setY(i, ys[k] - 5000); place.needsUpdate = true;
          g.renderOnce();
          const B = grab();
          place.setY(i, ys[k]); place.needsUpdate = true;
          g.renderOnce();
          const bb = box(A, B);
          const cam = g.renderer.__lastCam || null;
          each.push({
            i, h: bb ? bb.h : 0, w: bb ? bb.w : 0, n: bb ? bb.n : 0,
            x0: bb ? bb.x0 : null, x1: bb ? bb.x1 : null,
            dist: +Math.hypot(place.getX(i) - g.player.pos.x,
              place.getZ(i) - g.player.pos.z).toFixed(1),
          });
        }
        performance.now = real;
        rows.push({
          hype,
          carS: +g.player.s.toFixed(1),
          siteS: +site.s.toFixed(1),
          footprint: whole ? whole.n : 0,
          box: whole ? [whole.x0, whole.y0, whole.x1, whole.y1] : null,
          tallest: Math.max(0, ...each.map(e => e.h)),
          each,
        });
      }
      g.crowd.setHype(0);
      return { rows, n: mine.length };
    });

    if (out.none || out.noSquad) { console.log(`  seed ${SEED}: no squad`); return; }
    console.log(`\n══ seed ${SEED} — start-line squad, ${out.n} figures`);
    for (const r of out.rows) {
      console.log(`   hype ${r.hype}  car at s=${r.carS}, squad site s=${r.siteS}`
        + `   whole-squad footprint ${r.footprint} px, tallest figure ${r.tallest} px`
        + `   box ${JSON.stringify(r.box)}`);
      for (const e of r.each) {
        console.log(`       fig ${String(e.i).padStart(3)}  ${String(e.h).padStart(4)} px tall`
          + `  ${String(e.w).padStart(4)} px wide  ${String(e.n).padStart(6)} px`
          + `   ${String(e.dist).padStart(6)} m from the car`
          + `   x ${e.x0}..${e.x1}`);
      }
    }
  });
}
finish(process.exitCode || 0);
