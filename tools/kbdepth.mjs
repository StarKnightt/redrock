/* kb* probe — what does g.pipeline.normals.a actually contain?
 *
 * zqboots calls a pixel "sky" when that alpha is non-finite, <= 0 or > 4000.
 * That is an assertion about the prepass, and the prepass renders the WHOLE
 * scene with an override material (render/outline.js ~1035), so the sky dome,
 * the sun disc and the ocean are all in it. This probe does not reason about
 * that; it labels pixels by ablation (hide a group of meshes, see which pixels
 * changed in the beauty frame) and then reports the prepass alpha for each
 * label.
 *
 * Clock pinned across every render in a station, frame 0 discarded.
 *
 *   node tools/kbdepth.mjs [--seeds 22,1,40] [--at 0.3]
 */
import fs from 'node:fs';
import path from 'node:path';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');
const ATS = flag('at', '0.12,0.3,0.55,0.985').split(',').map(Number);

for (const SEED of SEEDS) {
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    page.setDefaultTimeout(600_000);
    const out = await page.evaluate(([ats]) => {
      const g = window.__game;
      const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
      const gl = g.renderer.getContext();

      const tree = [];
      g.stage.traverse(o => {
        if (o.isMesh) {
          tree.push({ name: o.name || '(unnamed)', visible: o.visible,
            parent: o.parent?.name || '', tris: o.geometry?.index
              ? o.geometry.index.count / 3
              : (o.geometry?.attributes?.position?.count ?? 0) / 3 });
        }
      });

      const byName = re => {
        const out2 = [];
        g.stage.traverse(o => { if (o.isMesh && re.test(o.name || '')) out2.push(o); });
        return out2;
      };
      const GROUPS = {
        sky: byName(/^sky-dome$|^sun-disc$/),
        paintedSky: (() => { const a = []; g.stage.traverse(o => { if (o.name === 'painted-sky') a.push(o); }); return a; })(),
        water: byName(/ocean|water|shore-foam|sea/i),
        landform: byName(/^landform-|^basin-floor$/),
        road: byName(/^road$|^berm/),
      };

      const grab = () => {
        const px = new Uint8Array(W * H * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      const diffMask = (a, b) => {
        const m = new Uint8Array(W * H);
        for (let i = 0, p = 0; i < a.length; i += 4, p++) {
          if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i + 1] - b[i + 1]) > 6
            || Math.abs(a[i + 2] - b[i + 2]) > 6) m[p] = 1;
        }
        return m;
      };

      const stats = arr => {
        if (!arr.length) return null;
        const s = arr.slice().sort((p, q) => p - q);
        return {
          n: s.length, min: +s[0].toFixed(2),
          p05: +s[(s.length * 0.05) | 0].toFixed(2),
          med: +s[s.length >> 1].toFixed(2),
          p95: +s[(s.length * 0.95) | 0].toFixed(2),
          max: +s[s.length - 1].toFixed(2),
        };
      };

      const results = [];
      for (const at of ats) {
        g.setPaused(true);
        g.autopilot(true, 0.85);
        g.driveTo(at, { runUp: 200, maxSec: 30 });

        const real = performance.now.bind(performance);
        const pinned = real();
        performance.now = () => pinned;

        g.renderOnce();          // frame 0 discarded
        g.renderOnce();
        const A = grab();

        // Whole prepass alpha in one read (bottom-up target).
        const dep = new Float32Array(W * H * 4);
        g.renderer.readRenderTargetPixels(g.pipeline.normals, 0, 0, W, H, dep);
        /* p indexes the readPixels buffer, which is bottom-up, and the render
           target read is bottom-up with the same origin and size, so the two
           share an index and no flip belongs here. */
        const alphaAt = p => dep[p * 4 + 3];

        // Ablation masks
        const masks = {};
        for (const [k, list] of Object.entries(GROUPS)) {
          if (!list.length) { masks[k] = null; continue; }
          const was = list.map(o => o.visible);
          list.forEach(o => { o.visible = false; });
          g.renderOnce();
          const B = grab();
          list.forEach((o, i) => { o.visible = was[i]; });
          g.renderOnce();
          masks[k] = diffMask(A, B);
        }

        const per = {};
        for (const [k, m] of Object.entries(masks)) {
          if (!m) { per[k] = null; continue; }
          const vals = [];
          let nonFinite = 0, nonPos = 0, over4000 = 0, sane = 0;
          for (let p = 0; p < m.length; p++) {
            if (!m[p]) continue;
            const v = alphaAt(p);
            vals.push(v);
            if (!isFinite(v)) nonFinite++;
            else if (v <= 0) nonPos++;
            else if (v > 4000) over4000++;
            else sane++;
          }
          per[k] = {
            stats: stats(vals), nonFinite, nonPos, over4000, sane,
            zqCallsSky: nonFinite + nonPos + over4000,
            pct: +(100 * (nonFinite + nonPos + over4000) / Math.max(1, vals.length)).toFixed(1),
          };
        }

        // Explicit named pixel probes: topmost row centre (sky), bottom row
        // centre (road right under the car).
        const probe = (x, y, label) => {         // y is top-down, like a screenshot
          const p = (H - 1 - y) * W + x;
          return {
            label, x, y, alpha: alphaAt(p),
            rgb: [A[p * 4], A[p * 4 + 1], A[p * 4 + 2]],
            isSkyMask: masks.sky ? !!masks.sky[p] : null,
            isWaterMask: masks.water ? !!masks.water[p] : null,
            isLandMask: masks.landform ? !!masks.landform[p] : null,
            isRoadMask: masks.road ? !!masks.road[p] : null,
          };
        };
        const probes = [probe(800, 5, 'top row centre'), probe(800, 880, 'bottom centre'),
          probe(40, 40, 'top-left'), probe(1560, 40, 'top-right')];

        // Also: the global histogram of alpha over the whole frame.
        let zeroCount = 0, negCount = 0, nfCount = 0, big = 0;
        for (let p = 0; p < W * H; p++) {
          const v = alphaAt(p);
          if (!isFinite(v)) nfCount++;
          else if (v === 0) zeroCount++;
          else if (v < 0) negCount++;
          else if (v > 4000) big++;
        }
        performance.now = real;
        results.push({
          at, s: +g.player.s.toFixed(1), kmh: +g.player.kmh.toFixed(0),
          per, probes,
          frame: { zeroCount, negCount, nfCount, over4000: big, total: W * H },
        });
      }
      g.autopilot(false);
      return { tree, results, camFar: g.camera.far, camNear: g.camera.near };
    }, [ATS]);

    console.log(`\n══ seed ${SEED}   camera near=${out.camNear} far=${out.camFar}`);
    console.log('   stage meshes: ' + out.tree.map(t => t.name).join(', '));
    for (const r of out.results) {
      console.log(`\n   ── at ${r.at} (s=${r.s}, ${r.kmh} km/h)`);
      console.log(`      whole frame: alpha==0 ${r.frame.zeroCount}  <0 ${r.frame.negCount}`
        + `  non-finite ${r.frame.nfCount}  >4000 ${r.frame.over4000}  of ${r.frame.total}`);
      for (const [k, v] of Object.entries(r.per)) {
        if (!v) { console.log(`      ${k.padEnd(11)} : no meshes`); continue; }
        if (!v.stats) { console.log(`      ${k.padEnd(11)} : 0 px visible`); continue; }
        console.log(`      ${k.padEnd(11)} : ${String(v.stats.n).padStart(7)} px`
          + `  alpha min ${v.stats.min} p05 ${v.stats.p05} med ${v.stats.med} p95 ${v.stats.p95} max ${v.stats.max}`);
        console.log(`      ${''.padEnd(11)}   zqboots would call ${v.zqCallsSky} of them SKY (${v.pct}%)`
          + `   [nonFinite ${v.nonFinite}, <=0 ${v.nonPos}, >4000 ${v.over4000}, sane ${v.sane}]`);
      }
      for (const p of r.probes) {
        console.log(`      probe ${p.label.padEnd(16)} (${p.x},${p.y}) alpha=${p.alpha}`
          + `  rgb=${p.rgb}  masks: sky=${p.isSkyMask} water=${p.isWaterMask} land=${p.isLandMask} road=${p.isRoadMask}`);
      }
    }
    const dir = path.resolve('.meas/r2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `kb-depth-${SEED}.json`), JSON.stringify(out, null, 1));
    console.log(`   json: ${path.join(dir, `kb-depth-${SEED}.json`)}`);
  });
}
finish(process.exitCode || 0);
