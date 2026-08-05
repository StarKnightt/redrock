/* CRITIC PROBE — does the ink actually reach the spectators?
 *
 * "Thick black ink outlines" is the first clause of the art direction, and
 * the crowd takes an unusual route to get one: it opts out of the override
 * prepass and registers a bespoke prepass material that re-runs the billboard
 * expansion. The implementer's own comment says forking those two shaders is
 * "the one change that cannot be caught by looking at a frame". So look at it
 * with something other than a frame.
 *
 * Three measurements, all by ablation against the real pipeline:
 *
 *   footprint   crowd visible vs crowd hidden, ink on. The pixels the crowd
 *               owns. outline.js mirrors mesh.visible onto its prepass proxy,
 *               so hiding removes the figures and their ink together.
 *   ink         ink on vs ink off (pipeline.inkEnabled), crowd visible. The
 *               pixels the outline pass darkens.
 *   coverage    of the crowd's own silhouette boundary, what fraction has ink
 *               within two pixels of it, and how many display levels darker
 *               the inked boundary is than the same pixel unlinked.
 *
 * Two controls, because a percentage on its own means nothing:
 *
 *   car         the same statistic for the player car, which is a hero object
 *               on the ordinary override path. This is what "inked" looks
 *               like on this stage.
 *   disposed    the same statistic for the crowd after crowd.dispose(), which
 *               calls unregisterPrepassMesh and leaves the mesh in no prepass
 *               at all. This is what the bespoke registration is worth: if
 *               shipped and disposed score the same, the registration is
 *               buying nothing.
 *
 *   node tools/zzink.mjs [--seed 22] [--site ramp] [--back 8]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const SITE = flag('site', 'ramp');
const BACK = Number(flag('back', '8'));

const outDir = path.join(ROOT, 'shots', 'zzink');
fs.mkdirSync(outDir, { recursive: true });

let out = null;
await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  out = await page.evaluate(([site, back]) => {
    const g = window.__game;
    const t = g.track;
    const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
    const gl = g.renderer.getContext();
    const mesh = g.scene.getObjectByName('crowd-figures');
    const rails = g.scene.getObjectByName('crowd-barriers');
    const carRoot = g.playerView && g.playerView.root;

    const grab = () => {
      const px = new Uint8Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const mask = (a, b, thr = 6) => {
      const m = new Uint8Array(W * H);
      let n = 0;
      for (let i = 0, p = 0; i < a.length; i += 4, p++) {
        if (Math.abs(a[i] - b[i]) > thr || Math.abs(a[i + 1] - b[i + 1]) > thr
          || Math.abs(a[i + 2] - b[i + 2]) > thr) { m[p] = 1; n++; }
      }
      return { m, n };
    };
    const lum = (px, p) => 0.2126 * px[p * 4] + 0.7152 * px[p * 4 + 1] + 0.0722 * px[p * 4 + 2];

    /* Boundary of a mask: a set pixel with at least one unset 4-neighbour.
       That is the silhouette the ink pass is supposed to be drawing. */
    const boundary = m => {
      const b = [];
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const p = y * W + x;
          if (!m[p]) continue;
          if (!m[p - 1] || !m[p + 1] || !m[p - W] || !m[p + W]) b.push(p);
        }
      }
      return b;
    };

    /* For a set of boundary pixels, what fraction has an ink-darkened pixel
       within R, and how many levels darker is it. "Inked" means the frame with
       outlines on is at least DARK levels darker than the same frame with
       outlines off — a positive darkening, not just any difference. */
    const inkStat = (bnd, withInk, noInk, R = 2, DARK = 10) => {
      let hit = 0, sum = 0, peak = 0;
      for (const p of bnd) {
        const x = p % W, y = (p / W) | 0;
        let best = 0;
        for (let dy = -R; dy <= R; dy++) {
          for (let dx = -R; dx <= R; dx++) {
            const q = (y + dy) * W + (x + dx);
            if (q < 0 || q >= W * H) continue;
            const d = lum(noInk, q) - lum(withInk, q);
            if (d > best) best = d;
          }
        }
        if (best >= DARK) { hit++; sum += best; }
        if (best > peak) peak = best;
      }
      return {
        n: bnd.length,
        covered: bnd.length ? +(100 * hit / bnd.length).toFixed(1) : 0,
        meanDarken: hit ? +(sum / hit).toFixed(1) : 0,
        peakDarken: +peak.toFixed(1),
      };
    };

    // ── get to the site ───────────────────────────────────────────────
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

    const real = performance.now.bind(performance);
    const pinned = real();
    performance.now = () => pinned;

    const setCrowd = v => { mesh.visible = v; if (rails) rails.visible = v; };
    const shot = () => { g.renderOnce(); return grab(); };

    g.renderOnce();                       // frame 0, discarded

    // ink on
    g.pipeline.inkEnabled = true;
    setCrowd(true);  const A = shot();
    const drift = mask(A, shot()).n;      // pinned-clock sanity
    setCrowd(false); const B = shot();
    // ink off
    g.pipeline.inkEnabled = false;
    setCrowd(true);  const C = shot();
    setCrowd(false); const D = shot();
    g.pipeline.inkEnabled = true;
    setCrowd(true);

    const foot = mask(C, D);              // colour footprint, ink out of it
    const bnd = boundary(foot.m);
    const crowdShipped = inkStat(bnd, A, C);

    /* The two frames to look at, taken here and not at the foot of this
       function: the dispose() control below unregisters the crowd's prepass
       and never puts it back, so a PNG grabbed after it shows the crowd with
       no ink whatever the shipped build does. Grabbing them late is exactly
       the mistake this pair exists to rule out. */
    const png = () => g.renderer.domElement.toDataURL('image/png');
    g.pipeline.inkEnabled = true;  g.renderOnce(); const pngInk = png();
    g.pipeline.inkEnabled = false; g.renderOnce(); const pngNo = png();
    g.pipeline.inkEnabled = true;  g.renderOnce();

    // ── control: the car ──────────────────────────────────────────────
    let car = null;
    if (carRoot) {
      g.pipeline.inkEnabled = true;
      const A2 = shot();
      carRoot.visible = false; const B2 = shot();
      g.pipeline.inkEnabled = false;
      carRoot.visible = true;  const C2 = shot();
      carRoot.visible = false; const D2 = shot();
      carRoot.visible = true;  g.pipeline.inkEnabled = true;
      const cf = mask(C2, D2);
      car = { ...inkStat(boundary(cf.m), A2, C2), area: cf.n };
    }

    // ── control: the same crowd with its prepass registration removed ──
    g.crowd.dispose();
    g.pipeline.inkEnabled = true;
    setCrowd(true);  const A3 = shot();
    g.pipeline.inkEnabled = false;
    const C3 = shot();
    setCrowd(false); const D3 = shot();
    g.pipeline.inkEnabled = true; setCrowd(true);
    const f3 = mask(C3, D3);
    const disposed = { ...inkStat(boundary(f3.m), A3, C3), area: f3.n };

    performance.now = real;

    /* Bounding box of the crowd, so the crops can be aimed at it rather than
       at wherever the critic guessed. */
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let p = 0; p < foot.m.length; p++) {
      if (!foot.m[p]) continue;
      const x = p % W, y = H - 1 - ((p / W) | 0);
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }

    return {
      site: target.kind, s: Math.round(target.s), atS: Math.round(atS),
      back, closest: +closest.toFixed(1), drift,
      area: foot.n, box: [x0, y0, x1 - x0 + 1, y1 - y0 + 1],
      crowdShipped, disposed, car,
      pngInk, pngNo,
    };
  }, [SITE, BACK]);
});

if (out) {
  const [bx, by, bw, bh] = out.box;
  const write = (name, dataUrl) => {
    const f = path.join(outDir, name);
    fs.writeFileSync(f, Buffer.from(dataUrl.split(',')[1], 'base64'));
    return f;
  };
  write(`s${SEED}-${SITE}-${BACK}m-ink-on.png`, out.pngInk);
  write(`s${SEED}-${SITE}-${BACK}m-ink-off.png`, out.pngNo);

  console.log(`\n  ${out.site} s=${out.s}, lens ${out.back} m before closest approach`
    + ` (${out.closest} m off the road)`);
  console.log(`  pinned-clock drift: ${out.drift} px${out.drift ? '  ◀── NOT CLEAN' : '  (clean)'}`);
  console.log(`  crowd footprint ${out.area} px, bounding box ${bw}x${bh} at ${bx},${by}`);

  const row = (label, s) => console.log(`    ${label.padEnd(26)}`
    + ` boundary ${String(s.n).padStart(5)} px`
    + `   inked ${String(s.covered).padStart(5)}%`
    + `   mean darkening ${String(s.meanDarken).padStart(5)} levels`
    + `   peak ${String(s.peakDarken).padStart(5)}`);

  console.log('\n  SILHOUETTE INK COVERAGE');
  row('crowd, as shipped', out.crowdShipped);
  row('crowd, prepass removed', out.disposed);
  if (out.car) row('car (control, hero ink)', out.car);
  console.log(`\n  → shots/zzink/`);
}
finish(process.exitCode || 0);
