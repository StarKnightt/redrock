/* What the new held finish camera actually looks at, and whether the crowd is
 * in it.
 *
 * src/race/ending.js landed while this audit was running: the chase camera
 * stops at the line and glides to a composed "photo finish under the bunting"
 * pose. That is the frame the finish crowd now has to work in, and it is not
 * the frame any existing probe measures — every finish tool here stops at the
 * line. So: drive the lap in, cross, let the ending settle, and ablate.
 *
 * Clock pinned, frame 0 discarded, 1600x900 through the pipeline.
 *
 *   node tools/kqend.mjs [--seeds 22,1,40]
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

for (const SEED of SEEDS) {
  const outDir = path.join(ROOT, 'shots', `r2end-${SEED}`);
  fs.mkdirSync(outDir, { recursive: true });

  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    page.setDefaultTimeout(600_000);

    const shots = await page.evaluate(async () => {
      const g = window.__game;
      if (!g.crowd) return { none: true };
      const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
      const gl = g.renderer.getContext();
      const mesh = g.scene.getObjectByName('crowd-figures');
      const place = mesh.geometry.getAttribute('aPlace');
      const L = g.track.length;

      const site = g.crowd.sites.find(s => s.kind === 'finish');
      const mine = [];
      if (site) {
        for (let i = 0; i < place.count; i++) {
          if (Math.hypot(place.getX(i) - site.at.x, place.getZ(i) - site.at.z) > 30) continue;
          mine.push(i);
        }
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

      /* Drive in on the autopilot from well before the line, then keep
         stepping past it so the ending arms, the car stops and the held
         camera finishes its move. */
      g.autopilot(true, 0.85);
      g.setPaused(true);
      g.goTo(Math.max(0, L - 320) / L);
      g.warp(0.75);
      for (let k = 0; k < 3000 && g.player.s < L - 4; k++) g.step(1 / 60);
      const crossedAt = g.player.s;
      const rows = [];
      const files = [];

      /* Samples through the ending: as it arms, mid-glide, and settled. */
      let t = 0;
      for (const wantT of [0.0, 0.6, 1.4, 2.6, 4.0]) {
        while (t < wantT) { g.step(1 / 60); t += 1 / 60; }
        const real = performance.now.bind(performance);
        const pinned = real();
        performance.now = () => pinned;
        g.renderOnce();                 // frame 0, discarded
        g.renderOnce();
        const A = grab();

        let crowd = null;
        if (mine.length) {
          const ys = mine.map(i => place.getY(i));
          mine.forEach((i, k) => place.setY(i, ys[k] - 5000));
          place.needsUpdate = true;
          g.renderOnce();
          crowd = box(A, grab());
          mine.forEach((i, k) => place.setY(i, ys[k]));
          place.needsUpdate = true;
          g.renderOnce();
        }

        const gate = g.stage.getObjectByName('gate-finish');
        let gateBox = null;
        if (gate) {
          const was = gate.visible;
          gate.visible = false;
          g.renderOnce();
          gateBox = box(A, grab());
          gate.visible = was;
          g.renderOnce();
        }

        // The frame itself, read back off the same pinned render.
        g.renderOnce();
        const url = g.renderer.domElement.toDataURL('image/png');
        performance.now = real;

        rows.push({
          t: +wantT.toFixed(1),
          s: +g.player.s.toFixed(1), kmh: +g.player.kmh.toFixed(0),
          crowdPx: crowd ? crowd.n : 0,
          crowdBox: crowd ? [crowd.x0, crowd.y0, crowd.x1, crowd.y1] : null,
          crowdTall: crowd ? crowd.h : 0,
          gatePx: gateBox ? gateBox.n : 0,
          gateBox: gateBox ? [gateBox.x0, gateBox.y0, gateBox.x1, gateBox.y1] : null,
        });
        files.push({ t: wantT, url });
      }
      g.autopilot(false);
      return {
        rows, files,
        siteS: site ? +site.s.toFixed(0) : null,
        L: +L.toFixed(0), crossedAt: +crossedAt.toFixed(1),
        nFinish: mine.length,
        hasEnding: !!(g.race && (g.race.ending || g.race.end)),
      };
    });

    if (shots.none) { console.log(`  seed ${SEED}: no crowd`); return; }
    for (const f of shots.files) {
      fs.writeFileSync(path.join(outDir, `end-t${f.t.toFixed(1)}.png`),
        Buffer.from(f.url.split(',')[1], 'base64'));
    }
    console.log(`\n══ seed ${SEED}  L=${shots.L}  finish site s=${shots.siteS}`
      + ` (${shots.L - shots.siteS} m before the line), ${shots.nFinish} figures`
      + `   crossed at s=${shots.crossedAt}`);
    for (const r of shots.rows) {
      console.log(`   t=${String(r.t).padStart(4)} s  s=${String(r.s).padStart(7)}`
        + `  ${String(r.kmh).padStart(4)} km/h`
        + `   crowd ${String(r.crowdPx).padStart(7)} px (tallest ${String(r.crowdTall).padStart(4)})`
        + `   gate ${String(r.gatePx).padStart(7)} px`
        + `   crowd box ${JSON.stringify(r.crowdBox)}`);
    }
    console.log(`   → shots/r2end-${SEED}`);
  });
}
finish(process.exitCode || 0);
