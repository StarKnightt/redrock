/* CRITIC PROBE — are the spectators standing on anything the player can see?
 *
 * A billboard has no contact shadow: the shadow map cannot run the crowd's
 * vertex shader, so castShadow is off by design, and the build compensates by
 * sinking the feet six centimetres into the ground. That works only while the
 * ground the figure stands on is itself visible under its feet. Put a group on
 * the lip of a cliff and the lip hides its own apron — the pixel below the
 * feet then belongs to whatever is three hundred metres beyond, and the figure
 * reads as standing on the sea.
 *
 * A first version of this asked Three's raycaster what was under each figure.
 * It reported every figure sound, including a group the capture plainly shows
 * floating over open water: the ray, aimed a few pixels below the feet, was
 * skimming a berm eleven metres in front of the lens and answering a question
 * about the foreground. It has been thrown away. What follows reads the
 * pipeline's own depth instead — render/outline.js keeps linear view distance
 * in metres in the alpha channel of its float normals target, which is per
 * pixel, is exactly aligned with the frame, and cannot skim anything.
 *
 *   figure box   by ablation against the real frame, as everywhere else here.
 *   contact      median depth in a band a few pixels below the feet, against
 *                the figure's own distance. Ground the figure is standing on
 *                is at essentially the figure's range. Much further is a
 *                different landform seen past the edge it stands on — or open
 *                water. Much nearer is a foreground occluder, which is not a
 *                floating figure but is equally a figure with no visible
 *                contact.
 *
 *   node tools/zzfoot.mjs [--seeds 22,1,40] [--backs 20,12,6]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');
const BACKS = flag('backs', '20,12,6').split(',').map(Number);

let bad = 0, seen = 0;
const worstSites = [];

for (const SEED of SEEDS) {
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    const out = await page.evaluate(([backs]) => {
      const g = window.__game;
      const THREE = g.THREE;
      const t = g.track;
      if (!g.crowd) return { none: true };
      const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
      const gl = g.renderer.getContext();
      const mesh = g.scene.getObjectByName('crowd-figures');
      const place = mesh.geometry.getAttribute('aPlace');

      const grab = () => {
        const px = new Uint8Array(W * H * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      const box = (a, b) => {
        let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let i = 0, p = 0; i < a.length; i += 4, p++) {
          if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i + 1] - b[i + 1]) > 6
            || Math.abs(a[i + 2] - b[i + 2]) > 6) {
            n++;
            const x = p % W, y = H - 1 - ((p / W) | 0);   // top-down
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
        return n ? { n, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null;
      };
      /* Linear view distance in metres, straight out of the ink prepass. The
         target is bottom-up, so a top-down row y reads at H-1-y. */
      const depthAt = (xs, yTop) => {
        const buf = new Float32Array(4);
        const out = [];
        for (const x of xs) {
          if (x < 0 || x >= W || yTop < 0 || yTop >= H) continue;
          g.renderer.readRenderTargetPixels(g.pipeline.normals, x, H - 1 - yTop, 1, 1, buf);
          out.push(buf[3]);
        }
        return out;
      };
      const median = a => {
        if (!a.length) return null;
        const s = a.slice().sort((p, q) => p - q);
        return s[s.length >> 1];
      };

      g.setPaused(true);
      g.autopilot(true, 0.85);
      const rows = [];

      for (const site of g.crowd.sites) {
        let closest = Infinity, atS = site.s;
        for (let s = Math.max(0, site.s - 250); s <= Math.min(t.length, site.s + 250); s += 2) {
          const f = t.frameAt(s);
          const d = Math.hypot(site.at.x - f.pos.x, site.at.z - f.pos.z);
          if (d < closest) { closest = d; atS = s; }
        }
        const mine = [];
        for (let i = 0; i < place.count; i++) {
          if (Math.hypot(place.getX(i) - site.at.x, place.getZ(i) - site.at.z) > 26) continue;
          mine.push(i);
        }

        const verdict = mine.map(() => null);
        for (const back of backs) {
          g.goTo(Math.max(0, atS - back - 55) / t.length);
          g.warp(0.75);
          for (let k = 0; k < 260 && g.player.s < atS - back; k++) g.step(1 / 60);
          const eye = g.camera.position.clone();

          const real = performance.now.bind(performance);
          const pinned = real();
          performance.now = () => pinned;
          g.renderOnce();                 // frame 0, discarded
          g.renderOnce();
          const A = grab();

          for (let k = 0; k < mine.length; k++) {
            const i = mine[k];
            const y0 = place.getY(i);
            place.setY(i, y0 - 5000); place.needsUpdate = true;
            g.renderOnce();
            const B = grab();
            place.setY(i, y0); place.needsUpdate = true;
            const bb = box(A, B);
            if (!bb || bb.h < 10) continue;    // too small on screen to judge

            /* Re-render with the figure BACK so the depth target holds the
               shipped frame, then read under its feet. */
            g.renderOnce();
            /* View-space z, NOT distance from the eye. The prepass writes
               -vViewPos.z, which is depth along the camera's forward axis; a
               figure thirty degrees off-axis is a good ten per cent nearer in
               z than in range, and comparing the two called every grounded
               figure on the stage a floater. Validated in tools/zzdepth.mjs. */
            const vp = new THREE.Vector3(place.getX(i), place.getY(i), place.getZ(i))
              .applyMatrix4(g.camera.matrixWorldInverse);
            const zFig = -vp.z;
            const xs = [];
            for (let q = -2; q <= 2; q++) xs.push(Math.round(bb.x0 + bb.w * (0.5 + q * 0.12)));
            const under = [];
            for (const dy of [3, 5, 8]) under.push(...depthAt(xs, bb.y1 + dy));
            const dOn = median(under.filter(v => isFinite(v) && v > 0));
            const ratio = dOn ? dOn / zFig : null;
            /* On a grounded figure the row below the feet reads within a few
               per cent of the figure's own z and then falls away smoothly —
               measured at 0.96–0.97x with per-row steps around 0.2 m. So the
               contact window is generous at 0.80–1.10, and the discriminator
               that actually matters is a CLIFF: a single-row jump in depth
               within a dozen rows of the feet, which is the near lip giving
               way to whatever lies beyond it. */
            const walk = [];
            for (let dy = 1; dy <= 14; dy++) {
              const v = depthAt([Math.round(bb.x0 + bb.w * 0.5)], bb.y1 + dy)[0];
              if (isFinite(v) && v > 0) walk.push(v);
            }
            let jump = 0;
            for (let q = 1; q < walk.length; q++) {
              const d = walk[q] - walk[q - 1];
              if (Math.abs(d) > Math.abs(jump)) jump = d;
            }
            const jumpFrac = zFig ? Math.abs(jump) / zFig : 0;
            const floating = !dOn || ratio > 1.10 || ratio < 0.80 || jumpFrac > 0.25;
            const rec = {
              back, dFig: +zFig.toFixed(1), h: bb.h,
              dOn: dOn ? +dOn.toFixed(1) : null,
              ratio: ratio ? +ratio.toFixed(2) : null,
              jump: +jump.toFixed(1), jumpFrac: +(100 * jumpFrac).toFixed(0),
              floating,
              kind: !dOn ? 'nothing (sky/water)'
                : jumpFrac > 0.25 ? `cliff edge under the feet (${(100 * jumpFrac).toFixed(0)}% jump)`
                  : ratio > 1.10 ? 'far surface beyond the edge'
                    : ratio < 0.80 ? 'foreground occluder' : 'ground',
            };
            // Keep the verdict from the station where the figure is biggest.
            if (!verdict[k] || bb.h > verdict[k].h) verdict[k] = rec;
          }
          performance.now = real;
        }
        rows.push({ kind: site.kind, s: Math.round(site.s), n: mine.length, verdict });
      }
      g.autopilot(false);
      return { rows };
    }, [BACKS]);

    if (out.none) { console.log(`  seed ${SEED}: no crowd`); return; }
    console.log(`\n══ seed ${SEED}`);
    for (const r of out.rows) {
      const judged = r.verdict.filter(Boolean);
      const float = judged.filter(v => v.floating);
      seen += judged.length; bad += float.length;
      if (float.length) worstSites.push(`seed ${SEED} ${r.kind} s=${r.s} — ${float.length}/${judged.length}`);
      console.log(`   ${r.kind.padEnd(14)} s=${String(r.s).padStart(5)}`
        + `  ${judged.length}/${r.n} judged`
        + `${float.length ? `   ◀── ${float.length} WITH NO GROUND UNDER THEM` : ''}`);
      for (const v of judged) {
        console.log(`       ${v.floating ? 'FLOAT' : '  ok '}`
          + `  ${String(v.h).padStart(3)} px tall, ${String(v.dFig).padStart(6)} m away`
          + `   below the feet: ${v.dOn === null ? '—' : v.dOn + ' m'}`
          + ` (${v.ratio === null ? '—' : v.ratio + 'x'})  ${v.kind}`);
      }
    }
  });
}
console.log(`\n  TOTAL: ${bad} of ${seen} judged figures have no visible ground at their feet`
  + ` (${seen ? (100 * bad / seen).toFixed(0) : 0}%)`);
for (const w of worstSites) console.log(`    ${w}`);
console.log();
finish(process.exitCode || 0);
