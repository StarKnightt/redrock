/* AUDIT PROBE (round 2) — the scheduler's model against the drawn frame, site
 * by site.
 *
 * The scheduler stores, on every site it places, `seen`: how many of five
 * approach stations `crowdSightScore` believes can see the spot, out of five.
 * That number is what chose the spot. This asks the frame the same question by
 * ablation and prints the two side by side.
 *
 * Method, per site:
 *   - closest approach found by walking the ribbon against the site's own
 *     world position, the same window tools/zzseen.mjs uses;
 *   - the car driven in by autopilot from 150 m short of that station and
 *     measured at every STRIDE metres of station down to closest approach, so
 *     every reading is from the moving chase lens and not a parked one;
 *   - at each station the whole site is ablated first (one render) and the
 *     per-figure ablation is only paid for when the site has any pixels at
 *     all, which is what makes nineteen stations x eighteen sites affordable;
 *   - performance.now() pinned across every render in a station, frame 0 after
 *     the drive discarded, 1600x900 through g.pipeline.render().
 *
 * Also recorded per figure per station, from the real camera and not from a
 * model of it: the projection of the figure's centre in NDC, its range, and
 * the pixel height it would subtend if nothing were in the way. Those three
 * are what separate "occluded", "outside the frame" and "too small to see".
 *
 *   node tools/kcsites.mjs [--seed 40] [--stride 8] [--from 150] [--json p]
 */
import fs from 'node:fs';
import path from 'node:path';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '40');
const STRIDE = Number(flag('stride', '8'));
const FROM = Number(flag('from', '150'));
/* Which station the run-in is measured back from. `closest` is the station of
   closest approach, which is what tools/zzseen.mjs uses and is right for every
   site on a road that does not double back. Through a hairpin it is wrong: on
   seed 1 the site at s=2143 has its closest approach at s=1893, on the other
   leg, 250 m of station away — so a run-in anchored there drives the wrong leg
   entirely. `site` anchors on the site's own station, which is what
   `crowdSightScore` scores (CROWD_BACKS are metres short of the group). */
const ANCHOR = flag('anchor', 'closest');
const JSONP = flag('json', '');

await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(1_800_000);
  const out = await page.evaluate(([stride, from, anchor]) => {
    const g = window.__game;
    const THREE = g.THREE;
    const t = g.track;
    if (!g.crowd) return { none: true };
    const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
    const gl = g.renderer.getContext();
    const mesh = g.scene.getObjectByName('crowd-figures');
    const place = mesh.geometry.getAttribute('aPlace');
    const bodyA = mesh.geometry.getAttribute('aBody');
    const L = t.length;

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
          const x = p % W, yy = H - 1 - ((p / W) | 0);
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
        }
      }
      return n ? { n, x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { n: 0, h: 0, w: 0 };
    };

    const sites = g.crowd.sites;
    /* Every instance to its nearest site, so nothing is double counted and
       nothing is lost to a fixed radius. */
    const owner = new Int32Array(place.count).fill(-1);
    for (let i = 0; i < place.count; i++) {
      let bestD = Infinity, bestK = -1;
      for (let k = 0; k < sites.length; k++) {
        const a = sites[k].at;
        if (!a) continue;
        const d = Math.hypot(place.getX(i) - a.x, place.getZ(i) - a.z);
        if (d < bestD) { bestD = d; bestK = k; }
      }
      owner[i] = bestK;
    }

    const rows = [];
    for (let k = 0; k < sites.length; k++) {
      const site = sites[k];
      const mine = [];
      for (let i = 0; i < place.count; i++) {
        if (owner[i] !== k) continue;
        mine.push({
          i, x: place.getX(i), y: place.getY(i), z: place.getZ(i),
          h: place.getW(i), pose: bodyA.getY(i),
        });
      }
      let closest = Infinity, closeS = site.s;
      for (let s = Math.max(0, site.s - 250); s <= Math.min(L, site.s + 250); s += 1) {
        const f = t.frameAt(s);
        const d = Math.hypot(site.at.x - f.pos.x, site.at.z - f.pos.z);
        if (d < closest) { closest = d; closeS = s; }
      }
      const atS = anchor === 'site' ? site.s : closeS;

      const stationsWanted = [];
      for (let b = from; b >= 0; b -= stride) stationsWanted.push(Math.max(2, atS - b));

      const start = Math.max(2, stationsWanted[0] - 120);
      g.setPaused(true);
      g.goTo(start / L);
      g.autopilot(true, 0.85);
      /* Up to speed before the first reading, so no station is measured from a
         car that is still accelerating out of a teleport. */
      for (let q = 0; q < 60 * 8 && g.player.s < stationsWanted[0]; q++) g.step(1 / 60);

      const peakFig = mine.map(() => 0);
      const peakSite = { n: 0, h: 0 };
      const stations = [];
      let guard = 0;
      for (const want of stationsWanted) {
        while (g.player.s < want && guard++ < 60 * 240) g.step(1 / 60);
        const cam = g.camera;
        const real = performance.now.bind(performance);
        const pinned = real();
        performance.now = () => pinned;
        g.renderOnce();              // frame 0, discarded
        g.renderOnce();
        const base = grab();
        g.renderOnce();
        const drift = diff(base, grab()).n;

        // whole site, one ablation
        const saved = mine.map(m => place.getY(m.i));
        for (const m of mine) place.setY(m.i, m.y - 5000);
        place.needsUpdate = true;
        g.renderOnce();
        const all = diff(base, grab());
        for (let q = 0; q < mine.length; q++) place.setY(mine[q].i, saved[q]);
        place.needsUpdate = true;

        const per = [];
        if (all.n > 0) {
          for (const m of mine) {
            const y0 = place.getY(m.i);
            place.setY(m.i, y0 - 5000);
            place.needsUpdate = true;
            g.renderOnce();
            per.push(diff(base, grab()));
            place.setY(m.i, y0);
            place.needsUpdate = true;
          }
        } else for (const _m of mine) per.push({ n: 0, h: 0, w: 0 });
        g.renderOnce();
        performance.now = real;

        // where the real lens says each figure is, whatever the pixels say
        cam.updateMatrixWorld(true);
        const proj = mine.map(m => {
          const c = new THREE.Vector3(m.x, m.y + m.h * 0.5, m.z);
          const range = c.distanceTo(cam.position);
          const nd = c.clone().project(cam);
          const subtend = H * m.h / (2 * Math.max(range, 0.01)
            * Math.tan(cam.fov * Math.PI / 360));
          return {
            ndc: [+nd.x.toFixed(3), +nd.y.toFixed(3), +nd.z.toFixed(4)],
            range: +range.toFixed(1), subtend: +subtend.toFixed(1),
          };
        });

        for (let q = 0; q < mine.length; q++) if (per[q].h > peakFig[q]) peakFig[q] = per[q].h;
        if (all.n > peakSite.n) peakSite.n = all.n;
        if (all.h > peakSite.h) peakSite.h = all.h;

        stations.push({
          want: Math.round(want), s: +g.player.s.toFixed(0),
          kmh: +g.player.kmh.toFixed(0), drift,
          cam: [+cam.position.x.toFixed(1), +cam.position.y.toFixed(1), +cam.position.z.toFixed(1)],
          allN: all.n, allH: all.h,
          px: per.map(d => d.n), h: per.map(d => d.h),
          box: per.map(d => d.n ? [d.x0, d.y0, d.w, d.h] : null),
          proj,
        });
      }
      g.autopilot(false);

      rows.push({
        kind: site.kind, s: Math.round(site.s), side: site.side,
        seen: site.seen ?? null,
        u: site.u ?? null, rise: site.rise != null ? +site.rise.toFixed(2) : null,
        groups: (site.groups || []).map(gr => ({ cheer: gr.cheer, n: gr.n, s: Math.round(gr.s) })),
        nFig: mine.length, atS: Math.round(atS), closeS: Math.round(closeS),
        closest: +closest.toFixed(1),
        heights: mine.map(m => +m.h.toFixed(2)),
        peakFig, peakTall: Math.max(0, ...peakFig), peakSite,
        stations,
      });
    }
    return { rows, W, H, fov: g.camera.fov, length: Math.round(L) };
  }, [STRIDE, FROM, ANCHOR]);

  if (out.none) { console.log('  no crowd'); return; }
  console.log(`\n  seed ${SEED} — model seen/5 against the frame, ${out.W}x${out.H},`
    + ` stations every ${STRIDE} m from ${FROM} m out,`
    + ` run-in anchored on ${ANCHOR === 'site' ? "the site's own station" : 'closest approach'}\n`);
  console.log('   site                s   side  model   figs   site peak   tallest figure   verdict');
  const flags = [];
  for (const r of out.rows) {
    const tall = r.peakTall;
    let bad = '';
    if (r.seen !== null && r.seen >= 2 && tall < 20) bad = 'MODEL>=2, FRAME<20px';
    if (r.seen !== null && r.seen >= 4 && tall < 12) bad = 'MODEL>=4, FRAME<12px';
    if (bad) flags.push({ ...r, bad });
    console.log(`   ${r.kind.padEnd(14)} ${String(r.s).padStart(6)}`
      + `  ${String(r.side).padStart(4)}`
      + `  ${String(r.seen === null ? '—' : r.seen).padStart(5)}`
      + `  ${String(r.nFig).padStart(5)}`
      + `  ${String(r.peakSite.n).padStart(7)} px`
      + `  ${String(tall).padStart(9)} px    ${bad}`);
  }
  console.log('\n  per-figure peak bounding-box height (px), by site:');
  for (const r of out.rows) {
    console.log(`    ${r.kind.padEnd(14)} s=${String(r.s).padStart(5)}`
      + `  seen ${r.seen === null ? '—' : r.seen}/5  closest ${r.closest} m`
      + `  → ${r.peakFig.join(' ')}`);
  }
  if (flags.length) {
    console.log(`\n  DISAGREEING SITES: ${flags.length}`);
    for (const f of flags) {
      console.log(`    ${f.kind} s=${f.s} side ${f.side} — model ${f.seen}/5,`
        + ` frame peak ${f.peakTall} px over ${f.nFig} figures  [${f.bad}]`);
    }
  } else console.log('\n  no site disagrees at the audit thresholds.');
  const drifts = out.rows.flatMap(r => r.stations.map(s => s.drift));
  console.log(`\n  worst pinned-clock drift across any static pair: ${Math.max(...drifts)} px`);
  console.log();

  if (JSONP) {
    fs.mkdirSync(path.dirname(JSONP), { recursive: true });
    fs.writeFileSync(JSONP, JSON.stringify(out, null, 1));
    console.log('  json → ' + JSONP);
  }
});
finish(process.exitCode || 0);
