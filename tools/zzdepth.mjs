/* CRITIC PROBE — validate the depth instrument before believing anything it says.
 *
 * Two footing probes have now been thrown away. The first asked Three's
 * raycaster what was under each figure and answered a question about a berm
 * eleven metres in front of the lens. The second read render/outline.js's
 * float normals target — linear metres in alpha — and called all 28 figures
 * floating, including three the capture plainly shows standing in grass with
 * tufts in front of their shoes.
 *
 * So: validate the instrument first, and only then use it.
 *
 *   size      is the normals target the same resolution as the canvas? If it
 *             is not, every pixel this probe has read was the wrong pixel.
 *   identity  depth sampled at a figure's own pixels must equal that figure's
 *             distance from the lens. If it does not, the read is wrong and
 *             nothing built on it counts.
 *   gradient  how fast depth changes per pixel row just below the feet, on a
 *             figure known from the captures to be standing on grass. That is
 *             the scale a "floating" test has to beat, and the reason the
 *             fixed 0.85–1.15 ratio band was meaningless: on ground seen at a
 *             grazing angle, ten pixels down the screen is many metres nearer.
 *
 *   node tools/zzdepth.mjs [--seed 22] [--site ramp] [--back 8]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const SITE = flag('site', 'ramp');
const BACK = Number(flag('back', '8'));

await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  const out = await page.evaluate(([site, back]) => {
    const g = window.__game;
    const THREE = g.THREE;
    const t = g.track;
    const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
    const gl = g.renderer.getContext();
    const mesh = g.scene.getObjectByName('crowd-figures');
    const place = mesh.geometry.getAttribute('aPlace');
    const nt = g.pipeline.normals;

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
          const x = p % W, y = H - 1 - ((p / W) | 0);
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      return n ? { n, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null;
    };
    /* Read a whole column strip once rather than a pixel at a time. */
    const readCol = (x, yTop0, rows) => {
      const buf = new Float32Array(rows * 4);
      g.renderer.readRenderTargetPixels(nt, x, H - 1 - (yTop0 + rows - 1), 1, rows, buf);
      // Returned bottom-up; flip to top-down.
      const out = [];
      for (let r = rows - 1; r >= 0; r--) out.push(buf[r * 4 + 3]);
      return out;
    };

    const target = g.crowd.sites.find(s => s.kind.includes(site)) || g.crowd.sites[0];
    let closest = Infinity, atS = target.s;
    for (let s = Math.max(0, target.s - 250); s <= Math.min(t.length, target.s + 250); s += 2) {
      const f = t.frameAt(s);
      const d = Math.hypot(target.at.x - f.pos.x, target.at.z - f.pos.z);
      if (d < closest) { closest = d; atS = s; }
    }
    g.setPaused(true);
    g.autopilot(true, 0.85);
    g.goTo(Math.max(0, atS - back - 55) / t.length);
    g.warp(0.75);
    for (let k = 0; k < 260 && g.player.s < atS - back; k++) g.step(1 / 60);
    const eye = g.camera.position.clone();

    const real = performance.now.bind(performance);
    const pinned = real();
    performance.now = () => pinned;
    g.renderOnce();
    g.renderOnce();
    const A = grab();

    const figs = [];
    for (let i = 0; i < place.count; i++) {
      if (Math.hypot(place.getX(i) - target.at.x, place.getZ(i) - target.at.z) > 26) continue;
      const y0 = place.getY(i);
      place.setY(i, y0 - 5000); place.needsUpdate = true;
      g.renderOnce();
      const B = grab();
      place.setY(i, y0); place.needsUpdate = true;
      g.renderOnce();
      const bb = box(A, B);
      if (!bb || bb.h < 12) continue;
      const dFig = eye.distanceTo(new THREE.Vector3(place.getX(i), y0, place.getZ(i)));
      const cx = Math.round(bb.x0 + bb.w * 0.5);
      /* Identity check: depth on the figure's own torso. Sampled a third of
         the way down the box, which is body rather than the gap between the
         legs or the ink at the crown. */
      const onFig = readCol(cx, Math.round(bb.y0 + bb.h * 0.45), 3);
      // Depth walking down from the feet.
      const belowRows = 20;
      const below = readCol(cx, bb.y1 + 1, belowRows);
      figs.push({
        i, dFig: +dFig.toFixed(1), h: bb.h, cx, yFeet: bb.y1,
        onFig: onFig.map(v => +v.toFixed(1)),
        below: below.map(v => +v.toFixed(1)),
      });
    }
    performance.now = real;

    return {
      site: target.kind, back,
      canvas: [W, H],
      targetSize: [nt.width, nt.height],
      pixelRatio: g.renderer.getPixelRatio(),
      figs,
    };
  }, [SITE, BACK]);

  console.log(`\n  ${out.site}, lens ${out.back} m before closest approach`);
  console.log(`  canvas ${out.canvas[0]}x${out.canvas[1]}`
    + `   normals target ${out.targetSize[0]}x${out.targetSize[1]}`
    + `   pixelRatio ${out.pixelRatio}`);
  const sizeOk = out.canvas[0] === out.targetSize[0] && out.canvas[1] === out.targetSize[1];
  console.log(`  SIZE CHECK: ${sizeOk ? 'target matches canvas — reads are aligned'
    : '◀── MISMATCH, every depth read so far was the wrong pixel'}`);

  console.log('\n  IDENTITY CHECK — depth on the figure vs the figure\'s true distance');
  for (const f of out.figs) {
    const d = f.onFig[1];
    const err = d ? (100 * (d - f.dFig) / f.dFig) : null;
    console.log(`    figure ${f.i}  ${String(f.h).padStart(3)} px tall`
      + `   true ${String(f.dFig).padStart(6)} m`
      + `   depth buffer ${String(d).padStart(7)} m`
      + `   ${err === null ? '' : (err >= 0 ? '+' : '') + err.toFixed(1) + '%'}`
      + `   ${Math.abs(err) < 5 ? 'ok' : '◀── INSTRUMENT WRONG'}`);
  }

  console.log('\n  GRADIENT BELOW THE FEET — metres per pixel row, walking down');
  for (const f of out.figs) {
    const b = f.below;
    const steps = [];
    for (let k = 1; k < b.length; k++) steps.push(b[k] - b[k - 1]);
    const biggest = steps.reduce((a, v) => Math.abs(v) > Math.abs(a) ? v : a, 0);
    console.log(`    figure ${f.i}  feet at y=${f.yFeet}, ${f.dFig} m`);
    console.log(`      depth: ${b.slice(0, 14).join(' ')}`);
    console.log(`      largest single-row jump ${biggest.toFixed(1)} m`
      + `  = ${(100 * Math.abs(biggest) / f.dFig).toFixed(0)}% of the figure's range`);
  }
  console.log();
});
finish(process.exitCode || 0);
