/* ROUND-2 RE-CHECK — the crowd's ink, and the ink on a SMALL figure.
 *
 * tools/zzink.mjs is sound on the two things that matter most: it pins
 * performance.now() before the first measured render and it throws frame 0
 * away. What it does not do is separate the figures from the rails. Its
 * `setCrowd` toggles `crowd-figures` AND `crowd-barriers` together, so
 *
 *   - the footprint mask, and therefore the "silhouette boundary", is the
 *     boundary of figures-plus-rails, not of the figures; and
 *   - the prepass-removed control still has the rails in it, and the rails are
 *     an ordinary environment mesh on the shared override path, so they keep
 *     their ink after crowd.dispose() and the control reads well above zero on
 *     any seed that has sitters.
 *
 * This measures three ablations at one station so the difference is visible:
 *
 *   rails-with     zzink's own recipe, figures and rails toggled together
 *   rails-kept     only the figures toggled, rails left standing
 *   rails-gone     rails hidden for every frame of the measurement, so no
 *                  rail ink is in either the inked or the uninked frame
 *
 * and then the part round 1 never did: ONE figure, ablated on its own, with
 * its own silhouette boundary and its own ink coverage, sampled all the way in
 * from about seventy metres so the same figure is measured at 40-60 px tall as
 * well as at its largest. Native 1:1 crops of the winners are written out,
 * plus a 4x nearest-neighbour blow-up of each for looking at.
 *
 *   node tools/krink.mjs [--seed 22] [--site ramp] [--back 8]
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
const HYPE = Number(flag('hype', '0'));

const outDir = path.join(ROOT, 'shots', `r2r-${SEED}`);
fs.mkdirSync(outDir, { recursive: true });

let out = null;
await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  out = await page.evaluate(([site, back]) => {
    const g = window.__game;
    const THREE = g.THREE;
    const t = g.track;
    const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
    const gl = g.renderer.getContext();
    const mesh = g.scene.getObjectByName('crowd-figures');
    const rails = g.scene.getObjectByName('crowd-barriers');
    const place = mesh.geometry.getAttribute('aPlace');
    const carRoot = g.playerView && g.playerView.root;

    const grab = () => {
      const px = new Uint8Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    /* Same 6-level difference threshold, same 4-neighbour boundary, same
       "at least 10 levels darker within 2 px" ink test as zzink, so the
       numbers are directly comparable to round 1's. */
    const mask = (a, b, thr = 6) => {
      const m = new Uint8Array(W * H);
      let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let i = 0, p = 0; i < a.length; i += 4, p++) {
        if (Math.abs(a[i] - b[i]) > thr || Math.abs(a[i + 1] - b[i + 1]) > thr
          || Math.abs(a[i + 2] - b[i + 2]) > thr) {
          m[p] = 1; n++;
          const x = p % W, y = (p / W) | 0;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      return { m, n, x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    };
    const lum = (px, p) => 0.2126 * px[p * 4] + 0.7152 * px[p * 4 + 1] + 0.0722 * px[p * 4 + 2];
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
    /* R = 2 is zzink's test and is kept for comparability. R = 0 — reported as
       `onPixel` — asks the stricter question: is THIS silhouette pixel darker,
       which is what separates the crowd's own stroke from an edge two pixels
       away belonging to whatever stands behind it. */
    const inkStat = (bnd, withInk, noInk, R = 2, DARK = 10) => {
      let hit = 0, sum = 0, peak = 0, hit0 = 0;
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
        if (lum(noInk, p) - lum(withInk, p) >= DARK) hit0++;
      }
      return {
        n: bnd.length,
        covered: bnd.length ? +(100 * hit / bnd.length).toFixed(1) : 0,
        onPixel: bnd.length ? +(100 * hit0 / bnd.length).toFixed(1) : 0,
        meanDarken: hit ? +(sum / hit).toFixed(1) : 0,
        peakDarken: +peak.toFixed(1),
      };
    };

    /* A 1:1 crop out of the live drawing buffer, plus a 4x nearest blow-up.
       readPixels is bottom-up, so the rows are flipped on the way in. */
    const cropPng = (px, x0, y0, w, h, zoom = 1) => {
      x0 = Math.max(0, x0); y0 = Math.max(0, y0);
      w = Math.min(w, W - x0); h = Math.min(h, H - y0);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        const srcY = H - 1 - (y0 + y);
        for (let x = 0; x < w; x++) {
          const s = (srcY * W + x0 + x) * 4, d = (y * w + x) * 4;
          img.data[d] = px[s]; img.data[d + 1] = px[s + 1];
          img.data[d + 2] = px[s + 2]; img.data[d + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      if (zoom === 1) return c.toDataURL('image/png');
      const z = document.createElement('canvas');
      z.width = w * zoom; z.height = h * zoom;
      const zc = z.getContext('2d');
      zc.imageSmoothingEnabled = false;
      zc.drawImage(c, 0, 0, w * zoom, h * zoom);
      return z.toDataURL('image/png');
    };

    // ── to the site, exactly as zzink gets there ──────────────────────
    const target = g.crowd.sites.find(s => s.kind.includes(site)) || g.crowd.sites[0];
    let closest = Infinity, atS = target.s;
    for (let s = Math.max(0, target.s - 250); s <= Math.min(t.length, target.s + 250); s += 2) {
      const f = t.frameAt(s);
      const d = Math.hypot(target.at.x - f.pos.x, target.at.z - f.pos.z);
      if (d < closest) { closest = d; atS = s; }
    }

    /* Which figure to follow: the tallest one within 26 m of the site, so it
       is one of the group the lens is actually pointed at. */
    let pick = -1, pickH = -1;
    for (let i = 0; i < place.count; i++) {
      if (Math.hypot(place.getX(i) - target.at.x, place.getZ(i) - target.at.z) > 26) continue;
      if (place.getW(i) > pickH) { pickH = place.getW(i); pick = i; }
    }

    const shot = () => { g.renderOnce(); return grab(); };
    const showFigs = v => { mesh.visible = v; };
    const showRails = v => { if (rails) rails.visible = v; };
    const hideOne = i => { const y = place.getY(i); place.setY(i, y - 5000); place.needsUpdate = true; return y; };
    const restore = (i, y) => { place.setY(i, y); place.needsUpdate = true; };

    /* One ablation quartet: ink on / ink off crossed with subject in / out.
       `sub` is a function taking a boolean. */
    const quartet = sub => {
      g.pipeline.inkEnabled = true;
      sub(true);  const A = shot();
      sub(false); const B = shot();
      g.pipeline.inkEnabled = false;
      sub(true);  const C = shot();
      sub(false); const D = shot();
      g.pipeline.inkEnabled = true;
      sub(true);
      const foot = mask(C, D);
      const bnd = boundary(foot.m);
      return { A, B, C, D, foot, bnd,
        stat: inkStat(bnd, A, C),
        /* What the SAME silhouette boundary would collect from the ink of
           whatever stands behind the subject, with the subject removed. Any
           residual in an ablated control has to clear this to mean anything. */
        bg: inkStat(bnd, B, D) };
    };

    // ══ PART 1: the whole crowd at the round-1 station ════════════════
    g.setPaused(true);
    g.autopilot(true, 0.85);
    g.goTo(Math.max(0, atS - back - 55) / t.length);
    g.warp(0.75);
    for (let k = 0; k < 260 && g.player.s < atS - back; k++) g.step(1 / 60);

    const real = performance.now.bind(performance);
    let pinned = real();
    performance.now = () => pinned;
    g.renderOnce();                        // frame 0, discarded

    // drift check: two renders of the same pinned state must be identical
    const p0 = shot(), p1 = shot();
    const drift = mask(p0, p1).n;

    showRails(true);
    const railsWith = quartet(v => { showFigs(v); showRails(v); });
    const railsKept = quartet(v => showFigs(v));
    showRails(false);
    const railsGone = quartet(v => showFigs(v));
    showRails(true);

    /* ── the fork the module's own comment says cannot be caught by looking
       at a frame ──────────────────────────────────────────────────────────
     * outline.js keeps its opt-ins in a module-private Map, but the pipeline
     * builds a proxy Mesh per registered mesh and keeps those in
     * `pipeline.prepassProxies`, which is reachable. The proxy's material IS
     * the registered prepass material, so replacing its vertex shader here
     * forks the two strings at run time without touching src/. The
     * replacement is the classic fork: the prepass draws the unexpanded source
     * quad — no billboard turn, no pose, no instance origin — so the ink is
     * computed for a figure standing at the model origin.
     */
    let forked = null;
    const proxy = g.pipeline.prepassProxies && g.pipeline.prepassProxies.get(mesh);
    if (proxy) {
      const keepVS = proxy.material.vertexShader;
      proxy.material.vertexShader = `
varying vec3 vCrowdView;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vCrowdView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;
      proxy.material.needsUpdate = true;
      showRails(false);
      const q = quartet(v => showFigs(v));
      showRails(true);
      forked = { ...q.stat, bg: q.bg, area: q.foot.n };
      proxy.material.vertexShader = keepVS;
      proxy.material.needsUpdate = true;
      g.renderOnce();
    }

    // the pictures, taken before dispose() can strip the prepass
    const png = () => g.renderer.domElement.toDataURL('image/png');
    g.pipeline.inkEnabled = true;  g.renderOnce(); const pngInk = png();
    g.pipeline.inkEnabled = false; g.renderOnce(); const pngNo = png();
    g.pipeline.inkEnabled = true;  g.renderOnce();

    // the car, for scale
    let car = null;
    if (carRoot) {
      const q = quartet(v => { carRoot.visible = v; });
      car = { ...q.stat, area: q.foot.n };
    }

    // ── the same three ablations with the prepass registration gone ───
    g.crowd.dispose();
    showRails(true);
    const dWith = quartet(v => { showFigs(v); showRails(v); });
    const dKept = quartet(v => showFigs(v));
    showRails(false);
    const dGone = quartet(v => showFigs(v));
    showRails(true);
    performance.now = real;

    /* dispose() only unregisters; there is no way back from the page, so the
       single-figure work below has to run in a fresh page. This run reports
       the whole-crowd half and a caller-driven flag decides the other. */
    return {
      site: target.kind, s: Math.round(target.s), atS: Math.round(atS),
      closest: +closest.toFixed(1), back, drift,
      pick, pickH: +pickH.toFixed(2),
      railsPresent: !!rails,
      shipped: {
        railsWith: { ...railsWith.stat, bg: railsWith.bg, area: railsWith.foot.n,
          box: [railsWith.foot.x0, railsWith.foot.y0, railsWith.foot.w, railsWith.foot.h] },
        railsKept: { ...railsKept.stat, bg: railsKept.bg, area: railsKept.foot.n },
        railsGone: { ...railsGone.stat, bg: railsGone.bg, area: railsGone.foot.n },
      },
      forked,
      disposed: {
        railsWith: { ...dWith.stat, bg: dWith.bg, area: dWith.foot.n },
        railsKept: { ...dKept.stat, bg: dKept.bg, area: dKept.foot.n },
        railsGone: { ...dGone.stat, bg: dGone.bg, area: dGone.foot.n },
      },
      car, pngInk, pngNo,
    };
  }, [SITE, BACK]);
});

/* ── PART 2, in its own page: one figure, all the way in ────────────── */
let small = null;
await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  small = await page.evaluate(([site, pickIn, hype]) => {
    const g = window.__game;
    const t = g.track;
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
    const mask = (a, b, thr = 6) => {
      const m = new Uint8Array(W * H);
      let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let i = 0, p = 0; i < a.length; i += 4, p++) {
        if (Math.abs(a[i] - b[i]) > thr || Math.abs(a[i + 1] - b[i + 1]) > thr
          || Math.abs(a[i + 2] - b[i + 2]) > thr) {
          m[p] = 1; n++;
          const x = p % W, y = (p / W) | 0;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      return { m, n, x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    };
    const lum = (px, p) => 0.2126 * px[p * 4] + 0.7152 * px[p * 4 + 1] + 0.0722 * px[p * 4 + 2];
    const boundary = (m, bb) => {
      const b = [];
      const yl = Math.max(1, bb.y0 - 2), yh = Math.min(H - 2, bb.y0 + bb.h + 2);
      const xl = Math.max(1, bb.x0 - 2), xh = Math.min(W - 2, bb.x0 + bb.w + 2);
      for (let y = yl; y <= yh; y++) {
        for (let x = xl; x <= xh; x++) {
          const p = y * W + x;
          if (!m[p]) continue;
          if (!m[p - 1] || !m[p + 1] || !m[p - W] || !m[p + W]) b.push(p);
        }
      }
      return b;
    };
    /* R = 2 is zzink's test and is kept for comparability. R = 0 asks the
       stricter question — is THIS pixel of the silhouette darker — which is
       what separates the crowd's own stroke from an edge two pixels away that
       belongs to whatever is standing behind it. */
    const inkStat = (bnd, withInk, noInk, R = 2, DARK = 10) => {
      let hit = 0, sum = 0, peak = 0, hit0 = 0;
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
        if (lum(noInk, p) - lum(withInk, p) >= DARK) hit0++;
      }
      return {
        n: bnd.length,
        covered: bnd.length ? +(100 * hit / bnd.length).toFixed(1) : 0,
        onPixel: bnd.length ? +(100 * hit0 / bnd.length).toFixed(1) : 0,
        meanDarken: hit ? +(sum / hit).toFixed(1) : 0,
        peakDarken: +peak.toFixed(1),
      };
    };
    const cropPng = (px, x0, y0, w, h, zoom = 1) => {
      x0 = Math.max(0, x0); y0 = Math.max(0, y0);
      w = Math.min(w, W - x0); h = Math.min(h, H - y0);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        const srcY = H - 1 - (y0 + y);
        for (let x = 0; x < w; x++) {
          const s = (srcY * W + x0 + x) * 4, d = (y * w + x) * 4;
          img.data[d] = px[s]; img.data[d + 1] = px[s + 1];
          img.data[d + 2] = px[s + 2]; img.data[d + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      if (zoom === 1) return c.toDataURL('image/png');
      const z = document.createElement('canvas');
      z.width = w * zoom; z.height = h * zoom;
      const zc = z.getContext('2d');
      zc.imageSmoothingEnabled = false;
      zc.drawImage(c, 0, 0, w * zoom, h * zoom);
      return z.toDataURL('image/png');
    };

    const target = g.crowd.sites.find(s => s.kind.includes(site)) || g.crowd.sites[0];
    let closest = Infinity, atS = target.s;
    for (let s = Math.max(0, target.s - 250); s <= Math.min(t.length, target.s + 250); s += 2) {
      const f = t.frameAt(s);
      const d = Math.hypot(target.at.x - f.pos.x, target.at.z - f.pos.z);
      if (d < closest) { closest = d; atS = s; }
    }
    /* Chosen here rather than handed in from part 1: part 1 runs in another
       page and may not have run at all. Tallest figure within 26 m of the
       site, which is one of the group the lens is pointed at. */
    let pick = -1, pickH = -1;
    for (let i = 0; i < place.count; i++) {
      if (Math.hypot(place.getX(i) - target.at.x, place.getZ(i) - target.at.z) > 26) continue;
      if (place.getW(i) > pickH) { pickH = place.getW(i); pick = i; }
    }
    if (pick < 0) pick = pickIn;

    g.setPaused(true);
    g.autopilot(true, 0.85);
    g.goTo(Math.max(0, atS - 140) / t.length);
    g.warp(0.75);
    for (let k = 0; k < 400 && g.player.s < atS - 88; k++) g.step(1 / 60);

    /* The countdown's hype, forced on. It is the one new input to the crowd
       vertex shader since round 1, it is read by both the beauty material and
       the ink prepass out of the same uniform block, and a figure at 24-180 m
       is the only one whose pose it changes at all (closer than that,
       proximity has already taken the excitement to 1). Every figure in the
       sweep below starts well outside 24 m, so this is where a fork between
       the two shaders under hype would show. */
    if (hype > 0 && g.crowd.setHype) { g.crowd.setHype(hype); g.step(0); }

    const THREE = g.THREE;
    const pFoot = new THREE.Vector3(), pHead = new THREE.Vector3();
    const rows = [];
    const keep = [];
    while (g.player.s < atS + 16) {
      const real = performance.now.bind(performance);
      const pinned = real();
      performance.now = () => pinned;
      g.renderOnce();                       // frame 0 at this station, discarded

      g.pipeline.inkEnabled = true;
      g.renderOnce(); const A = grab();
      const y0 = place.getY(pick);
      place.setY(pick, y0 - 5000); place.needsUpdate = true;
      g.renderOnce(); const B = grab();
      g.pipeline.inkEnabled = false;
      g.renderOnce(); const D = grab();
      place.setY(pick, y0); place.needsUpdate = true;
      g.renderOnce(); const C = grab();
      g.pipeline.inkEnabled = true;
      performance.now = real;

      const foot = mask(C, D);              // the figure's colour footprint
      const cam = g.camera.position;
      const dist = Math.hypot(cam.x - place.getX(pick), cam.z - place.getZ(pick));
      /* What the figure's height would be on screen if nothing were in front
         of it. Compared against the ablation footprint's height, this says how
         much of the figure the frame is actually showing — a footprint well
         under the projection is an occluded figure, not a small one. */
      pFoot.set(place.getX(pick), place.getY(pick), place.getZ(pick));
      pHead.copy(pFoot).setY(pFoot.y + place.getW(pick));
      pFoot.project(g.camera); pHead.project(g.camera);
      const projH = Math.abs((pHead.y - pFoot.y) * 0.5 * H);
      if (foot.n > 20) {
        const st = inkStat(boundary(foot.m, foot), A, C);
        const row = {
          s: +g.player.s.toFixed(1), d: +dist.toFixed(1),
          px: foot.n, w: foot.w, h: foot.h, projH: +projH.toFixed(0),
          box: [foot.x0, foot.y0, foot.w, foot.h],
          ...st,
        };
        rows.push(row);
        keep.push({ row, A, C });
      } else {
        rows.push({ s: +g.player.s.toFixed(1), d: +dist.toFixed(1), px: foot.n,
          w: 0, h: 0, projH: +projH.toFixed(0), n: 0, covered: 0, onPixel: 0,
          meanDarken: 0, peakDarken: 0 });
      }
      for (let k = 0; k < 5; k++) g.step(1 / 60);
    }

    /* Crops at the sample nearest 40, 50, 60 and at the largest, all from the
       frames already in hand so the picture is the frame that was measured. */
    const wants = [['h40', 40], ['h50', 50], ['h60', 60]];
    const crops = [];
    for (const [tag, want] of wants) {
      let best = null;
      for (const k of keep) {
        if (!best || Math.abs(k.row.h - want) < Math.abs(best.row.h - want)) best = k;
      }
      if (!best) continue;
      const [x, y, w, h] = best.row.box;
      const pad = 8;
      // readPixels rows are bottom-up; cropPng flips, so pass a top-down y.
      const ty = H - (y + h);
      crops.push({ tag, want, row: best.row,
        ink1: cropPng(best.A, x - pad, ty - pad, w + pad * 2, h + pad * 2, 1),
        ink4: cropPng(best.A, x - pad, ty - pad, w + pad * 2, h + pad * 2, 4),
        no1: cropPng(best.C, x - pad, ty - pad, w + pad * 2, h + pad * 2, 1),
        no4: cropPng(best.C, x - pad, ty - pad, w + pad * 2, h + pad * 2, 4) });
    }
    let big = keep[keep.length - 1];
    for (const k of keep) if (k.row.h > big.row.h) big = k;
    if (big) {
      const [x, y, w, h] = big.row.box, pad = 8, ty = H - (y + h);
      crops.push({ tag: 'largest', want: big.row.h, row: big.row,
        ink1: cropPng(big.A, x - pad, ty - pad, w + pad * 2, h + pad * 2, 1),
        ink4: cropPng(big.A, x - pad, ty - pad, w + pad * 2, h + pad * 2, 4),
        no1: cropPng(big.C, x - pad, ty - pad, w + pad * 2, h + pad * 2, 1),
        no4: cropPng(big.C, x - pad, ty - pad, w + pad * 2, h + pad * 2, 4) });
    }

    return { site: target.kind, pick, height: +place.getW(pick).toFixed(2),
      closest: +closest.toFixed(1), rows, crops };
  }, [SITE, out ? out.pick : 0, HYPE]);
});

const write = (name, dataUrl) => {
  const f = path.join(outDir, name);
  fs.writeFileSync(f, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return f;
};
const written = [];

if (out) {
  written.push(write(`krink-s${SEED}-${SITE}-ink-on.png`, out.pngInk));
  written.push(write(`krink-s${SEED}-${SITE}-ink-off.png`, out.pngNo));
  console.log(`\n  ══ WHOLE CROWD, ${out.site} s=${out.s}, lens ${out.back} m before`
    + ` closest approach (${out.closest} m off the road) ══`);
  console.log(`  pinned-clock drift between two renders: ${out.drift} px`
    + `${out.drift ? '   ◀── NOT CLEAN' : '   (clean)'}`);
  console.log(`  crowd-barriers on this seed: ${out.railsPresent ? 'present' : 'ABSENT'}`);
  const row = (label, s) => console.log(`    ${label.padEnd(30)}`
    + ` footprint ${String(s.area ?? '-').padStart(5)} px`
    + `  boundary ${String(s.n).padStart(5)} px`
    + `  inked ${String(s.covered).padStart(5)}%`
    + `  on-pixel ${String(s.onPixel).padStart(5)}%`
    + `  mean ${String(s.meanDarken).padStart(5)} levels`
    + `  peak ${String(s.peakDarken).padStart(5)}`);
  console.log('\n  as shipped');
  row('figures+rails ablated (zzink)', out.shipped.railsWith);
  row('figures only, rails standing', out.shipped.railsKept);
  row('figures only, rails hidden', out.shipped.railsGone);
  console.log('\n  the floor: ink the BACKGROUND puts on the same boundary with the crowd removed');
  row('figures+rails ablated', out.shipped.railsWith.bg);
  row('figures only, rails hidden', out.shipped.railsGone.bg);
  if (out.forked) {
    console.log('\n  prepass vertex shader FORKED at run time (unexpanded source quad)');
    row('figures only, rails hidden', out.forked);
    row('  its background floor', out.forked.bg);
  }
  console.log('\n  after crowd.dispose() — prepass registration removed');
  row('figures+rails ablated (zzink)', out.disposed.railsWith);
  row('figures only, rails standing', out.disposed.railsKept);
  row('figures only, rails hidden', out.disposed.railsGone);
  row('  its background floor', out.disposed.railsGone.bg);
  if (out.car) { console.log('\n  control'); row('player car (hero ink)', out.car); }
}

if (small) {
  console.log(`\n  ══ ONE FIGURE, followed in — ${small.site}, uHype=${HYPE},`
    + ` instance #${small.pick}, ${small.height} m tall ══`);
  console.log('\n      s     range     px     w x  h  proj h   boundary   inked  on-px    mean    peak');
  for (const r of small.rows) {
    console.log(`   ${String(r.s).padStart(6)} ${String(r.d).padStart(7)} m`
      + ` ${String(r.px).padStart(6)}  ${String(r.w).padStart(3)} x ${String(r.h).padStart(3)}`
      + ` ${String(r.projH).padStart(7)}`
      + ` ${String(r.n).padStart(10)} ${String(r.covered).padStart(7)}%`
      + ` ${String(r.onPixel).padStart(6)}%`
      + ` ${String(r.meanDarken).padStart(7)} ${String(r.peakDarken).padStart(7)}`);
  }
  const band = small.rows.filter(r => r.h >= 40 && r.h <= 60 && r.n > 0);
  if (band.length) {
    const mean = k => (band.reduce((a, b) => a + b[k], 0) / band.length).toFixed(1);
    console.log(`\n  in the 40-60 px band: ${band.length} samples,`
      + ` inked ${mean('covered')}% mean, darkening ${mean('meanDarken')} levels mean`);
    console.log(`    worst sample: ${Math.min(...band.map(b => b.covered))}% inked`);
  } else {
    console.log('\n  no sample landed in the 40-60 px band');
  }
  const hy = HYPE > 0 ? `-hype${HYPE}` : '';
  for (const c of small.crops) {
    written.push(write(`krink-s${SEED}-fig${hy}-${c.tag}-${c.row.h}px-ink-on.png`, c.ink1));
    written.push(write(`krink-s${SEED}-fig${hy}-${c.tag}-${c.row.h}px-ink-off.png`, c.no1));
    written.push(write(`krink-s${SEED}-fig${hy}-${c.tag}-${c.row.h}px-ink-on-x4.png`, c.ink4));
    written.push(write(`krink-s${SEED}-fig${hy}-${c.tag}-${c.row.h}px-ink-off-x4.png`, c.no4));
    console.log(`    crop ${c.tag}: ${c.row.h} px tall at ${c.row.d} m — ${c.row.covered}% inked,`
      + ` ${c.row.meanDarken} levels`);
  }
}

const j = path.join(ROOT, '.meas', 'r2',
  `krink-${SEED}${HYPE > 0 ? `-hype${HYPE}` : ''}.json`);
fs.mkdirSync(path.dirname(j), { recursive: true });
const dump = { whole: out, small };
if (dump.whole) { delete dump.whole.pngInk; delete dump.whole.pngNo; }
if (dump.small) dump.small = { ...small, crops: small.crops.map(c => ({ tag: c.tag, want: c.want, row: c.row })) };
fs.writeFileSync(j, JSON.stringify(dump, null, 1));
console.log(`\n  → ${j}`);
for (const f of written) console.log(`  → ${f}`);
finish(process.exitCode || 0);
