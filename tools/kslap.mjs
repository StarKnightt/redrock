/* MEASUREMENT PROBE (round-2 audit) — in-frame crowd density over a whole lap.
 *
 * The question is not how many groups the scheduler placed. It is how much
 * crowd is on the screen at once, and for how long, because "sparse" and
 * "wall-to-wall" are both claims about the frame.
 *
 * Method, per sample (every SAMPLE seconds of simulated time, car on
 * autopilot at 0.85 throttle):
 *
 *   1  pin performance.now() — src/world/environment.js drives a grass uniform
 *      off it inside onBeforeRender, so two renders of one static scene are
 *      otherwise different images. Restored after every sample; the drift
 *      column reports a spot check of the guarantee rather than assuming it.
 *   2  render twice, discard the first, read the frame       -> base
 *   3  hide crowd-figures and crowd-barriers, render, read   -> none
 *      base vs none is the crowd's whole footprint, ink included (outline.js
 *      mirrors mesh.visible onto its prepass proxy).
 *   4  for every figure whose projected box contains footprint pixels, push
 *      that ONE instance's aPlace under the world, render, and read back only
 *      its box. base vs that is the figure's own visible pixels: its area and,
 *      from the extent of the columns, its pixel height. A figure's pixels are
 *      a subset of the whole-mesh footprint, so figures whose box holds no
 *      footprint pixels contribute nothing and are skipped exactly.
 *
 * Each figure is attributed to the site that built it by build order, not by
 * projecting it back onto the road — see tools/ksinv.mjs for why that matters
 * through the switchbacks.
 *
 * Then captures: the densest moment of the lap by legible figure count, the
 * next two densest more than SPREAD seconds from any already chosen, and one
 * from inside every overlap between adjacent sites' in-frame windows.
 *
 *   node tools/kslap.mjs [--seed 22] [--sample 0.25] [--minpx 12] [--maxsec 0]
 *
 * Writes .meas/r2/kslap-<seed>.json and shots/r2s-<seed>/*.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { run } from './harness.mjs';
import { freeze } from './kssnap.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const SAMPLE = Number(flag('sample', '0.25'));
const MINPX = Number(flag('minpx', '12'));
const MAXSEC = Number(flag('maxsec', '0'));       // 0 = whole lap
const SPREAD = Number(flag('spread', '10'));

const OUT = path.resolve('.meas/r2');
const SHOTS = path.resolve(`shots/r2s-${SEED}`);
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

/* ── everything that runs in the page ─────────────────────────────────────── */
function install() {
  const g = window.__game;
  const T = g.THREE;
  const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
  const gl = g.renderer.getContext();
  const mesh = g.scene.getObjectByName('crowd-figures');
  const rails = g.scene.getObjectByName('crowd-barriers');
  const A = mesh.geometry.attributes;
  const P = A.aPlace.array;
  const N = A.aPlace.count;
  const cam = g.camera;

  /* Build-order attribution: buildCrowd walks its sites in ascending station
     and pushes each site's figures in turn, then appends the start-line squad
     last. Exact when the declared counts add up to the instance count. */
  const sites = g.crowd.sites.map((p, i) => ({
    i, kind: p.kind, s: p.s, side: p.side,
    declared: (p.groups || []).reduce((a, b) => a + b.n, 0),
    nGroups: (p.groups || []).length,
  }));
  const owner = new Int32Array(N).fill(-1);
  {
    const ordered = sites.filter(p => p.kind !== 'start line');
    const start = sites.find(p => p.kind === 'start line');
    let at = 0;
    for (const p of ordered) for (let k = 0; k < p.declared; k++) owner[at++] = p.i;
    if (start) for (let k = 0; k < start.declared; k++) owner[at++] = start.i;
    if (at !== N) for (let i = 0; i < N; i++) owner[i] = -2;   // flagged below
  }

  /* The billboard is expanded in the vertex shader, so the world box has to
     cover the widest thing it can become: a flag arm at armL 1.45 with a cloth
     at itemScale 2.3, rotated 2.55 rad about the shoulder, plus the hop.
     Worked out from crowdFigureGeometry and CROWD_VERT_BODY that comes to
     ±1.05 figure widths across and 1.83 figure heights up, which at the top of
     CROWD_HEIGHT is 2.3 m and 3.6 m. Rounded out, and the residual footprint
     that lands outside every box is reported per sample so a box that is too
     tight cannot pass unnoticed. */
  const R = 2.6, TOP = 3.9, BOT = 0.35;
  const v = new T.Vector3(), v4 = new T.Vector4();
  const boxOf = (i) => {
    const x = P[i * 4], y = P[i * 4 + 1], z = P[i * 4 + 2];
    if (y < -1000) return null;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, front = 0, behind = 0;
    for (const dx of [-R, R]) for (const dz of [-R, R]) for (const dy of [-BOT, TOP]) {
      v.set(x + dx, y + dy, z + dz).applyMatrix4(cam.matrixWorldInverse);
      if (-v.z < 0.5) { behind++; continue; }
      front++;
      v4.set(v.x, v.y, v.z, 1).applyMatrix4(cam.projectionMatrix);
      const sx = (v4.x / v4.w * 0.5 + 0.5) * W, sy = (v4.y / v4.w * 0.5 + 0.5) * H;
      if (sx < x0) x0 = sx; if (sx > x1) x1 = sx;
      if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
    }
    if (!front) return null;
    if (behind) { x0 = 0; x1 = W; y0 = 0; y1 = H; }     // straddling the near plane
    const PAD = 4;
    x0 = Math.max(0, Math.floor(x0) - PAD); x1 = Math.min(W - 1, Math.ceil(x1) + PAD);
    y0 = Math.max(0, Math.floor(y0) - PAD); y1 = Math.min(H - 1, Math.ceil(y1) + PAD);
    if (x1 < x0 || y1 < y0) return null;
    return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  };

  const full = () => {
    const px = new Uint8Array(W * H * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const readRect = (b) => {
    const px = new Uint8Array(b.w * b.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(b.x0, b.y0, b.w, b.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const diff = (a, i, b, j) => Math.abs(a[i] - b[j]) > 6
    || Math.abs(a[i + 1] - b[j + 1]) > 6 || Math.abs(a[i + 2] - b[j + 2]) > 6;

  const hide = (i) => {
    const y = P[i * 4 + 1];
    P[i * 4 + 1] = -1e5; A.aPlace.needsUpdate = true;
    return () => { P[i * 4 + 1] = y; A.aPlace.needsUpdate = true; };
  };

  let threw = 0;
  const step = dt => { try { g.step(dt); } catch (e) { threw++; } };

  /* One sample. Returns the whole-mesh footprint, every figure that owns any
     of it, and how much of it no figure's box claimed. */
  const measure = (minpx, wantDrift) => {
    const real = performance.now.bind(performance);
    const pinned = real();
    performance.now = () => pinned;

    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

    mesh.visible = true; if (rails) rails.visible = true;
    g.renderOnce();                 // frame 0, discarded
    g.renderOnce();
    const base = full();
    let drift = -1;
    if (wantDrift) {
      g.renderOnce();
      const again = full();
      drift = 0;
      for (let i = 0; i < base.length; i += 4) if (diff(base, i, again, i)) drift++;
    }
    mesh.visible = false; if (rails) rails.visible = false;
    g.renderOnce();
    const none = full();
    mesh.visible = true; if (rails) rails.visible = true;

    const mask = new Uint8Array(W * H);
    let maskN = 0;
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      if (diff(base, i, none, i)) { mask[p] = 1; maskN++; }
    }

    /* The rails the sitters sit on are part of the crowd's footprint and are
       not any figure's pixels, so they would otherwise show up as an
       unattributed residual. Measured separately for exactly that reason. */
    let railN = 0;
    if (maskN && rails) {
      rails.visible = false;
      g.renderOnce();
      const noRail = full();
      rails.visible = true;
      for (let i = 0; i < base.length; i += 4) if (diff(base, i, noRail, i)) railN++;
    }

    const figs = [];
    /* Two totals, because they are not the same number. `sumPx` adds the
       per-figure footprints and double counts: removing a figure that stands
       just behind another changes the depth buffer under the front figure's
       silhouette, so the outline pass redraws its ink and those pixels answer
       to both. `unionPx` is the set of pixels some figure owns, which is the
       one that can be held against the whole-mesh footprint. */
    const union = maskN ? new Uint8Array(W * H) : null;
    let sumPx = 0;
    if (maskN) {
      for (let k = 0; k < N; k++) {
        const b = boxOf(k);
        if (!b) continue;
        let any = 0;
        for (let yy = b.y0; yy < b.y0 + b.h && !any; yy++) {
          const row = yy * W;
          for (let xx = b.x0; xx < b.x0 + b.w; xx++) if (mask[row + xx]) { any = 1; break; }
        }
        if (!any) continue;
        const back = hide(k);
        g.renderOnce();
        const sub = readRect(b);
        back();
        let n = 0, top = -1, bot = -1;
        for (let yy = 0; yy < b.h; yy++) {
          for (let xx = 0; xx < b.w; xx++) {
            const j = (yy * b.w + xx) * 4;
            const i2 = (((b.y0 + yy) * W) + (b.x0 + xx)) * 4;
            if (diff(base, i2, sub, j)) {
              n++;
              union[((b.y0 + yy) * W) + (b.x0 + xx)] = 1;
              if (top < 0) top = yy;
              bot = yy;
            }
          }
        }
        if (n) {
          figs.push({ i: k, site: owner[k], px: n, h: bot - top + 1 });
          sumPx += n;
        }
      }
    }
    let unionPx = 0;
    if (union) for (let p = 0; p < union.length; p++) if (union[p]) unionPx++;
    performance.now = real;
    return { maskN, figs, sumPx, unionPx, drift, railN };
  };

  const startLap = () => {
    g.setPaused(true);
    g.goTo(0.0005);
    g.autopilot(true, 0.85);
    g.warp(0.5);
  };

  window.__ks = {
    W, H, N, sites, owner: Array.from(owner),
    threw: () => threw,
    /* `want` is a list of frame numbers to photograph on the way past.
     *
     * The shots have to be taken inside a sweep and not by re-driving to a
     * frame afterwards, because rendering perturbs the simulation: measured,
     * a lap driven with the sweep's renders and a lap driven without them are
     * 21 m apart by frame 2475 and 311 m apart by frame 11085. Two runs of the
     * IDENTICAL procedure agree, so the capture pass is a second sweep with
     * the same sample rate that also calls toDataURL at the wanted frames, and
     * the station at each is checked against the first sweep's. */
    sweep(sample, minpx, maxsec, want) {
      startLap();
      const wanted = new Set(want || []);
      const shots = [];
      const every = Math.max(1, Math.round(sample * 60));
      const LIMIT = maxsec > 0 ? Math.round(maxsec * 60) : 60 * 60 * 8;
      const samples = [];
      let frames = 0, driftMax = 0, unclaimed = 0;
      const t0 = performance.now();
      while (g.player.s < g.track.length - 3 && frames < LIMIT) {
        step(1 / 60);
        frames++;
        if (wanted.has(frames)) {
          const real = performance.now.bind(performance);
          const p = real(); performance.now = () => p;
          g.renderOnce(); g.renderOnce();
          shots.push({
            f: frames, s: +g.player.s.toFixed(1), kmh: +g.player.kmh.toFixed(1),
            url: g.renderer.domElement.toDataURL('image/png'),
          });
          performance.now = real;
        }
        if (frames % every) continue;
        const m = measure(minpx, samples.length % 40 === 0);
        if (m.drift > driftMax) driftMax = m.drift;
        unclaimed += Math.max(0, m.maskN - m.unionPx - m.railN);
        samples.push({
          f: frames, t: +(frames / 60).toFixed(3), s: +g.player.s.toFixed(1),
          kmh: +g.player.kmh.toFixed(1), maskN: m.maskN,
          sumPx: m.sumPx, unionPx: m.unionPx,
          railN: m.railN, figs: m.figs,
        });
      }
      return {
        samples, frames, lap: +(frames / 60).toFixed(2), driftMax, unclaimed,
        wallSec: +((performance.now() - t0) / 1000).toFixed(1),
        threw, length: +g.track.length.toFixed(1), shots,
      };
    },
    /* Re-drive the same lap and stop at a frame. Deterministic: the sweep only
       ever renders, and rendering does not advance the simulation. */
    seek(frame) {
      startLap();
      for (let i = 0; i < frame; i++) step(1 / 60);
      return { s: +g.player.s.toFixed(1), kmh: +g.player.kmh.toFixed(1) };
    },
    advance(n) {
      for (let i = 0; i < n; i++) step(1 / 60);
      return { s: +g.player.s.toFixed(1), kmh: +g.player.kmh.toFixed(1) };
    },
    shot() {
      const real = performance.now.bind(performance);
      const pinned = real();
      performance.now = () => pinned;
      g.renderOnce(); g.renderOnce();
      const url = g.renderer.domElement.toDataURL('image/png');
      performance.now = real;
      return url;
    },
    /* A native-resolution crop: the pixels as rendered, put into a canvas of
       the crop's own size. No filtering and no scaling anywhere. */
    crop(x0, y0, w, h) {
      const real = performance.now.bind(performance);
      const pinned = real();
      performance.now = () => pinned;
      g.renderOnce(); g.renderOnce();
      const src = g.renderer.domElement;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(src, x0, y0, w, h, 0, 0, w, h);
      performance.now = real;
      return c.toDataURL('image/png');
    },
    /* Where a set of figures lands on screen right now, for a tight crop. */
    boxes(list) {
      cam.updateMatrixWorld();
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
      return list.map(i => boxOf(i));
    },
  };
  return { W, H, N, ok: owner[0] !== -2 };
}

/* ── analysis helpers, in node ────────────────────────────────────────────── */
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(p / 100 * a.length) - 1))];
};
const runsOf = (samples, pred, sample) => {
  const out = [];
  let cur = null;
  for (const sm of samples) {
    if (pred(sm)) {
      if (!cur) cur = { t0: sm.t, t1: sm.t, n: 0 };
      cur.t1 = sm.t; cur.n++;
    } else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  /* Length of a run of k consecutive samples is k intervals of `sample`
     seconds, counted inclusively at both ends: a single sample is one sample
     period of the lap, not zero. */
  return out.map(r => ({ ...r, dt: +(r.n * sample).toFixed(2) }))
    .sort((a, b) => b.dt - a.dt);
};

const snap = await freeze();
console.log(`code snapshot ${snap.stamp}`);

await run({
  width: 1600, height: 900,
  url: `${snap.base}/#manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(3_600_000);
  const boot = await page.evaluate(install);
  console.log(`  ${boot.W}x${boot.H}, ${boot.N} instances,`
    + ` build-order attribution ${boot.ok ? 'exact' : 'FAILED'}`);

  const sw = await page.evaluate(([a, b, c]) => window.__ks.sweep(a, b, c),
    [SAMPLE, MINPX, MAXSEC]);
  const meta = await page.evaluate(() => ({ sites: window.__ks.sites }));
  const sites = meta.sites;

  console.log(`  lap ${sw.lap} s over ${sw.length} m, ${sw.samples.length} samples`
    + ` every ${SAMPLE} s, ${sw.wallSec} s of wall clock`);
  console.log(`  pinned-clock drift, worst spot check: ${sw.driftMax} px`
    + `${sw.driftMax > 0 ? '   ◀── NOT CLEAN' : '  (clean)'}`);
  console.log(`  step() threw ${sw.threw} times`);
  const totMask = sw.samples.reduce((a, s) => a + s.maskN, 0);
  const totRail = sw.samples.reduce((a, s) => a + s.railN, 0);
  const totUnion = sw.samples.reduce((a, s) => a + s.unionPx, 0);
  console.log(`  crowd footprint summed over the lap: ${totMask} px;`
    + ` ${totUnion} px owned by a figure, ${totRail} px the sitters' rails,`
    + ` ${sw.unclaimed} px (${(100 * sw.unclaimed / Math.max(totMask, 1)).toFixed(1)}%)`
    + ' neither');

  /* ── per sample ── */
  const FRAME = boot.W * boot.H;
  const rows = sw.samples.map(sm => {
    const legible = sm.figs.filter(f => f.h >= MINPX);
    const sitesAny = new Set(sm.figs.map(f => f.site));
    const sitesLeg = new Set(legible.map(f => f.site));
    return {
      f: sm.f, t: sm.t, s: sm.s, kmh: sm.kmh,
      maskN: sm.maskN, cover: sm.maskN / FRAME,
      nFig: sm.figs.length, nLeg: legible.length,
      nSiteAny: sitesAny.size, nSiteLeg: sitesLeg.size,
      sitesAny: [...sitesAny].sort((a, b) => a - b),
      sitesLeg: [...sitesLeg].sort((a, b) => a - b),
      heights: legible.map(f => f.h),
      figs: sm.figs,
    };
  });

  const nS = rows.length;
  const frac = (pred) => +(100 * rows.filter(pred).length / nS).toFixed(1);
  const dist = {
    sitesAny: {
      0: frac(r => r.nSiteAny === 0), 1: frac(r => r.nSiteAny === 1),
      2: frac(r => r.nSiteAny === 2), '3+': frac(r => r.nSiteAny >= 3),
    },
    sitesLeg: {
      0: frac(r => r.nSiteLeg === 0), 1: frac(r => r.nSiteLeg === 1),
      2: frac(r => r.nSiteLeg === 2), '3+': frac(r => r.nSiteLeg >= 3),
    },
    legFigs: {
      0: frac(r => r.nLeg === 0), '1-3': frac(r => r.nLeg >= 1 && r.nLeg <= 3),
      '4-8': frac(r => r.nLeg >= 4 && r.nLeg <= 8),
      '9-15': frac(r => r.nLeg >= 9 && r.nLeg <= 15),
      '16+': frac(r => r.nLeg >= 16),
    },
  };
  const P = (key) => ({
    p50: pct(rows.map(r => r[key]), 50), p90: pct(rows.map(r => r[key]), 90),
    p99: pct(rows.map(r => r[key]), 99), max: Math.max(...rows.map(r => r[key])),
  });
  const stat = {
    sitesAny: P('nSiteAny'), sitesLeg: P('nSiteLeg'),
    legFigs: P('nLeg'), allFigs: P('nFig'),
    coverMaxPct: +(100 * Math.max(...rows.map(r => r.cover))).toFixed(3),
    coverP50Pct: +(100 * pct(rows.map(r => r.cover), 50)).toFixed(3),
    coverP90Pct: +(100 * pct(rows.map(r => r.cover), 90)).toFixed(3),
    coverP99Pct: +(100 * pct(rows.map(r => r.cover), 99)).toFixed(3),
  };
  const stretch = {
    sites2any: runsOf(rows, r => r.nSiteAny >= 2, SAMPLE),
    sites2leg: runsOf(rows, r => r.nSiteLeg >= 2, SAMPLE),
    leg9: runsOf(rows, r => r.nLeg >= 9, SAMPLE),
    leg1: runsOf(rows, r => r.nLeg >= 1, SAMPLE),
  };

  /* ── figure pixel heights across the lap ── */
  const heights = [];
  rows.forEach(r => r.heights.forEach(h => heights.push(h)));
  const hStat = {
    n: heights.length,
    p10: pct(heights, 10), p50: pct(heights, 50), p90: pct(heights, 90),
    max: heights.length ? Math.max(...heights) : 0,
    under40: +(100 * heights.filter(h => h < 40).length / Math.max(heights.length, 1)).toFixed(1),
    band: +(100 * heights.filter(h => h >= 40 && h <= 125).length / Math.max(heights.length, 1)).toFixed(1),
    over125: +(100 * heights.filter(h => h > 125).length / Math.max(heights.length, 1)).toFixed(1),
  };

  /* ── per-site in-frame windows, on legible pixels ── */
  const windows = {};
  for (const p of sites) {
    const w = runsOf(rows, r => r.sitesLeg.includes(p.i), SAMPLE)
      .sort((a, b) => a.t0 - b.t0);
    windows[p.i] = w;
  }
  const ordered = [...sites].sort((a, b) => a.s - b.s);
  /* One row per adjacent pair, not one per pair of windows.
   *
   * A site's legible window is not one interval: it flickers as the road bends
   * and as the tallest figure crosses the 12 px line, so seed 22's roadside at
   * s=1040 has five separate windows in forty seconds. Enumerating every
   * window against every window turned two neighbouring sites into eight
   * "pairs", which counts the flicker rather than the thing being asked about.
   * So the relationship between two neighbours is summarised once: whether
   * there is ANY sample with both legible, how many such samples there are,
   * and if there are none, the smallest gap between any of their windows. */
  const pairs = [];
  for (let k = 1; k < ordered.length; k++) {
    const a = ordered[k - 1], b = ordered[k];
    const both = rows.filter(r => r.sitesLeg.includes(a.i) && r.sitesLeg.includes(b.i));
    let minGap = Infinity;
    for (const wa of windows[a.i]) for (const wb of windows[b.i]) {
      const g2 = (wa.t0 <= wb.t1 && wb.t0 <= wa.t1) ? 0
        : (wb.t0 > wa.t1 ? wb.t0 - wa.t1 : wa.t0 - wb.t1);
      if (g2 < minGap) minGap = g2;
    }
    const overlap = both.length > 0;
    if (!overlap && !(minGap < 3)) continue;
    const pick = overlap
      ? both.slice().sort((x, y) => y.nLeg - x.nLeg || y.maskN - x.maskN)[0]
      : (() => {
        /* The join itself: the last sample of the earlier window or the first
           of the later, whichever is nearer the midpoint of the gap. */
        const wa = windows[a.i], wb = windows[b.i];
        let best = null, bestG = Infinity, mid = 0;
        for (const x of wa) for (const y of wb) {
          const g2 = (x.t1 < y.t0) ? y.t0 - x.t1 : (y.t1 < x.t0 ? x.t0 - y.t1 : 0);
          if (g2 < bestG) { bestG = g2; mid = (x.t1 < y.t0) ? (x.t1 + y.t0) / 2 : (y.t1 + x.t0) / 2; }
        }
        best = rows.reduce((bst, r) =>
          (!bst || Math.abs(r.t - mid) < Math.abs(bst.t - mid)) ? r : bst, null);
        return best;
      })();
    pairs.push({
      a: a.i, b: b.i, aKind: a.kind, bKind: b.kind,
      aS: a.s, bS: b.s, dS: +(b.s - a.s).toFixed(1),
      overlap, overlapSamples: both.length,
      overlapSec: +(both.length * SAMPLE).toFixed(2),
      minGap: overlap ? 0 : +minGap.toFixed(2),
      aWindows: windows[a.i].length, bWindows: windows[b.i].length,
      at: pick ? { f: pick.f, t: pick.t, s: pick.s, nLeg: pick.nLeg } : null,
    });
  }
  /* A site's windows again with flicker under 1 s bridged, for reading. */
  const merged = {};
  for (const p of sites) {
    const w = windows[p.i].slice().sort((x, y) => x.t0 - y.t0);
    const out = [];
    for (const x of w) {
      const last = out[out.length - 1];
      if (last && x.t0 - last.t1 <= 1.0) { last.t1 = x.t1; last.dt = +(x.t1 - last.t0 + SAMPLE).toFixed(2); }
      else out.push({ t0: x.t0, t1: x.t1, dt: x.dt });
    }
    merged[p.i] = out;
  }

  /* ── the densest moments ── */
  const byDense = [...rows].sort((a, b) =>
    b.nLeg - a.nLeg || b.maskN - a.maskN);
  const dense = [];
  for (const r of byDense) {
    if (dense.length >= 3) break;
    if (dense.every(d => Math.abs(d.t - r.t) > SPREAD)) dense.push(r);
  }

  /* ── captures ── */
  const shots = [];
  const targets = [];
  dense.forEach((r, k) => targets.push({
    frame: r.f, file: path.join(SHOTS,
      `dense${k + 1}-t${r.t.toFixed(2)}s-s${Math.round(r.s)}-${r.nLeg}legible.png`),
    tag: `densest #${k + 1}`, row: r,
  }));
  pairs.forEach((pr, k) => {
    if (!pr.at) return;
    targets.push({
      frame: pr.at.f, file: path.join(SHOTS,
        `pair${String(k + 1).padStart(2, '0')}-${pr.overlap ? 'overlap' : 'join'}`
        + `-site${pr.a}+${pr.b}-t${pr.at.t.toFixed(2)}s-s${Math.round(pr.at.s)}.png`),
      tag: `pair ${pr.a}+${pr.b}`, row: rows.find(r => r.f === pr.at.f),
    });
  });
  targets.sort((x, y) => x.frame - y.frame);

  /* A fresh page, then the same sweep again with the wanted frames
     photographed on the way past.
     *
     * goTo does not reset everything a lap touches — measured with
     * tools/ksdet.mjs, the first lap after a page load reaches s=1041.5 at
     * frame 2475 and every lap after it in the same page ends up stuck at
     * s=1159.6 and 3 km/h — so the capture pass needs its own page load, and
     * it has to repeat the sweep's renders too, because rendering perturbs the
     * simulation by 311 m over a lap. */
  if (targets.length) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__game, null, { timeout: 300_000 });
    await page.evaluate(() => window.__game.begin());
    await page.evaluate(install);
    const shoot = await page.evaluate(([a, b, c, w]) => window.__ks.sweep(a, b, c, w),
      [SAMPLE, MINPX, MAXSEC, [...new Set(targets.map(t => t.frame))]]);
    const byFrame = new Map(shoot.shots.map(s => [s.f, s]));
    for (const tg of targets) {
      const got = byFrame.get(tg.frame);
      if (!got) { console.log(`   MISSED frame ${tg.frame}`); continue; }
      fs.writeFileSync(tg.file, Buffer.from(got.url.split(',')[1], 'base64'));
      shots.push({
        tag: tg.tag, frame: tg.frame, file: tg.file,
        wantS: tg.row ? tg.row.s : null, gotS: got.s,
        driftM: tg.row ? +(got.s - tg.row.s).toFixed(2) : null,
        kmh: got.kmh,
        nLeg: tg.row ? tg.row.nLeg : null,
        nSiteLeg: tg.row ? tg.row.nSiteLeg : null,
      });
      console.log(`   shot ${tg.tag.padEnd(14)} f=${tg.frame}`
        + ` s: sweep ${tg.row ? tg.row.s : '?'} / capture ${got.s}`
        + ` (${tg.row ? (got.s - tg.row.s).toFixed(2) : '?'} m)`
        + `  -> ${path.basename(tg.file)}`);
    }
  }

  const result = {
    seed: SEED, sample: SAMPLE, minpx: MINPX, spread: SPREAD,
    codeSnapshot: snap.stamp,
    frame: { w: boot.W, h: boot.H, px: FRAME },
    lap: sw.lap, length: sw.length, nSamples: nS,
    driftMax: sw.driftMax, threw: sw.threw, unclaimed: sw.unclaimed,
    totalMaskPx: totMask, totalRailPx: totRail, totalUnionPx: totUnion,
    sites, dist, stat, hStat,
    stretch: {
      sites2any: stretch.sites2any.slice(0, 8),
      sites2leg: stretch.sites2leg.slice(0, 8),
      leg9: stretch.leg9.slice(0, 8),
      leg1: stretch.leg1.slice(0, 12),
      totalLeg1: +stretch.leg1.reduce((a, r) => a + r.dt, 0).toFixed(2),
    },
    windows, merged, pairs, shots,
    rows: rows.map(r => ({
      t: r.t, s: r.s, kmh: r.kmh, maskN: r.maskN,
      nFig: r.nFig, nLeg: r.nLeg, nSiteAny: r.nSiteAny, nSiteLeg: r.nSiteLeg,
      sitesLeg: r.sitesLeg, heights: r.heights,
    })),
  };
  fs.writeFileSync(path.join(OUT, `kslap-${SEED}.json`), JSON.stringify(result));

  /* ── report ── */
  const nm = i => { const p = sites.find(q => q.i === i); return p ? `${i}:${p.kind}@${Math.round(p.s)}` : `${i}`; };
  console.log(`\n=== SEED ${SEED} — in-frame density, ${nS} samples over ${sw.lap} s ===`);
  console.log('\n  SITES IN FRAME AT ONCE (any crowd pixel):  '
    + Object.entries(dist.sitesAny).map(([k, v]) => `${k}: ${v}%`).join('   '));
  console.log('  SITES IN FRAME AT ONCE (>=1 legible figure): '
    + Object.entries(dist.sitesLeg).map(([k, v]) => `${k}: ${v}%`).join('   '));
  console.log(`  percentiles, sites any:  p50 ${stat.sitesAny.p50}  p90 ${stat.sitesAny.p90}`
    + `  p99 ${stat.sitesAny.p99}  max ${stat.sitesAny.max}`);
  console.log(`  percentiles, sites leg:  p50 ${stat.sitesLeg.p50}  p90 ${stat.sitesLeg.p90}`
    + `  p99 ${stat.sitesLeg.p99}  max ${stat.sitesLeg.max}`);
  console.log('\n  LEGIBLE FIGURES AT ONCE (>= ' + MINPX + ' px tall):  '
    + Object.entries(dist.legFigs).map(([k, v]) => `${k}: ${v}%`).join('   '));
  console.log(`  percentiles, legible figures: p50 ${stat.legFigs.p50}`
    + `  p90 ${stat.legFigs.p90}  p99 ${stat.legFigs.p99}  max ${stat.legFigs.max}`);
  console.log(`  percentiles, figures with any pixel: p50 ${stat.allFigs.p50}`
    + `  p90 ${stat.allFigs.p90}  p99 ${stat.allFigs.p99}  max ${stat.allFigs.max}`);
  console.log(`\n  CROWD SCREEN COVERAGE of ${FRAME} px: p50 ${stat.coverP50Pct}%`
    + `  p90 ${stat.coverP90Pct}%  p99 ${stat.coverP99Pct}%  MAX ${stat.coverMaxPct}%`);

  console.log('\n  LONGEST STRETCHES:');
  const showRuns = (label, list) => {
    console.log(`    ${label}`);
    if (!list.length) { console.log('       (none)'); return; }
    list.slice(0, 5).forEach(r => console.log(`       ${String(r.dt).padStart(6)} s`
      + `   t ${r.t0}–${r.t1} s`));
  };
  showRuns('>= 2 sites with any crowd pixel:', stretch.sites2any);
  showRuns('>= 2 sites with a legible figure:', stretch.sites2leg);
  showRuns('>= 9 legible figures:', stretch.leg9);
  showRuns('>= 1 legible figure (the events themselves):', stretch.leg1);
  console.log(`    total time with >=1 legible figure: ${result.stretch.totalLeg1} s`
    + ` of ${sw.lap} s (${(100 * result.stretch.totalLeg1 / sw.lap).toFixed(1)}%)`);

  console.log('\n  PER-SITE IN-FRAME WINDOWS (legible; raw, and with <=1 s flicker bridged):');
  for (const p of ordered) {
    const w = windows[p.i], m2 = merged[p.i];
    console.log(`    ${nm(p.i).padEnd(24)} ${String(w.length).padStart(2)} raw ->`
      + ` ${String(m2.length).padStart(2)} merged: `
      + (m2.map(x => `${x.t0}–${x.t1} s (${x.dt} s)`).join(', ') || 'never legible'));
  }

  console.log(`\n  ADJACENT-SITE PAIRS THAT OVERLAP OR JOIN INSIDE 3 s: ${pairs.length}`
    + ` of ${ordered.length - 1} adjacent pairs`);
  pairs.forEach((pr, k) => console.log(`    ${String(k + 1).padStart(2)}  ${nm(pr.a)}`
    + ` + ${nm(pr.b)}  ${pr.dS} m apart  —  `
    + (pr.overlap
      ? `BOTH LEGIBLE IN ${pr.overlapSamples} sample(s) = ${pr.overlapSec} s`
      + `, worst at t=${pr.at.t} s (${pr.at.nLeg} legible)`
      : `never both legible; closest windows ${pr.minGap} s apart`)));

  console.log('\n  FIGURE PIXEL HEIGHTS when legible, over the whole lap'
    + ` (${hStat.n} figure-samples):`);
  console.log(`    p10 ${hStat.p10}  p50 ${hStat.p50}  p90 ${hStat.p90}  max ${hStat.max} px`);
  console.log(`    below 40 px: ${hStat.under40}%   40–125 px: ${hStat.band}%`
    + `   above 125 px: ${hStat.over125}%`);

  console.log('\n  DENSEST MOMENTS:');
  dense.forEach((r, k) => console.log(`    #${k + 1}  t=${r.t} s  s=${r.s} m`
    + `  ${r.nLeg} legible of ${r.nFig} with pixels,  ${r.nSiteLeg} site(s) legible`
    + ` [${r.sitesLeg.map(nm).join(' ')}],  ${r.maskN} px`
    + ` (${(100 * r.cover).toFixed(3)}% of frame)`));
  console.log('\n  captures in ' + SHOTS);
  console.log();
});
snap.close();
finish(process.exitCode || 0);
