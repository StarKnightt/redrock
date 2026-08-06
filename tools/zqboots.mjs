/* Is the pixel under this spectator's boots the SEA?
 *
 * D2 is written as a look: "they read as standing on the sea at native
 * resolution". tools/zzfoot.mjs answers a proxy for that — whether the depth
 * a few rows below the feet is close to the figure's own depth — and it is a
 * good proxy for the case it was built for. It is not the same question, and
 * on this build the difference is most of the answer: of the 44 figures it
 * calls floating, 21 are "foreground occluder", meaning the pixel below the
 * boots is NEARER than the figure. A figure whose feet are tucked behind a
 * grass verge two metres in front of them has no visible contact by that
 * test and reads as perfectly grounded to a player, because what meets its
 * boots is more grass. Validated against the frame: seed 22's start-line
 * squad is 3/3 "floating" and the capture shows three cheerleaders standing
 * on a green bank.
 *
 * So ask the question the defect is written in. Under the boots there are
 * two things it can be:
 *
 *   sea      the ocean mesh, found by ablation — hide the water and see
 *            which pixels change. This is the defect: a figure over water.
 *   ground   anything else — landform, road, berm, verge, near or far. A
 *            figure standing against ground reads as standing on it.
 *
 * THE SKY CHANNEL IS RETIRED. It used to be a third answer here — "no geometry
 * at all, read off the prepass depth target" — classified by
 *
 *     !isFinite(dep) || dep <= 0 || dep > 4000
 *
 * That condition cannot be true. Both of its thresholds sit outside the range of
 * the value they test, which makes it the same shape as a check that cannot fail:
 * it looked like coverage of the cliff-lip case and provided none. Measured over
 * seeds 22, 1 and 40, sampling three rows under every judged figure's boots and
 * one row forty pixels above its head as a positive control for open sky:
 *
 *   under boots   2430 samples, all finite, 11.83 .. 583.42 m
 *   open sky       810 samples, all finite, 16.75 .. 3649.19 m
 *   dep <= 0            0 of 3240
 *   dep > 4000          0 of 3240
 *
 * The premise is what is wrong, not the constant. The branch tests for "nothing
 * was written here", but the sky is DRAWN — `sky-dome` is real geometry — so the
 * prepass writes a finite positive depth at every pixel and there is no such
 * thing as an unwritten one.
 *
 * Nor can it be rescued by re-calibrating 4000 down, which was the obvious
 * repair and is why the range above was measured on more than one seed. Far
 * ground and sky share a band: legitimate ground under a figure's boots reaches
 * 583 m on seed 40 — the headland rings put painted terrain 1.5 km out — while
 * open sky reads as little as 2765 m on seed 1. Any single constant either misses
 * the sky it is for or calls a distant hillside sky, and the boundary moves per
 * seed. Separating them honestly would need the same ablation the sea test uses,
 * hiding the dome and seeing which pixels move — a redesign, not a threshold.
 *
 * Retired rather than repaired because `sea` already answers the defect this file
 * is named for, and a dead branch that looks like coverage is worse than an
 * absent one. `floating` is unchanged in behaviour: it was `(sea + sky) > half`
 * with `sky` provably always 0, so dropping the term cannot move a verdict.
 *
 * Same discipline as the rest: performance.now() pinned across every render
 * in a station, frame 0 discarded, 1600x900 through g.pipeline.render(), the
 * car driven in by the autopilot, every mask taken by ablation against the
 * real frame rather than by asking the scene graph what it thinks is where.
 *
 *   node tools/zqboots.mjs [--seeds 22,1,40] [--backs 20,12,6]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');
const BACKS = flag('backs', '20,12,6').split(',').map(Number);

let seen = 0, bad = 0;
const worst = [];

for (const SEED of SEEDS) {
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    page.setDefaultTimeout(600_000);
    const out = await page.evaluate(([backs]) => {
      const g = window.__game;
      const t = g.track;
      if (!g.crowd) return { none: true };
      const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
      const gl = g.renderer.getContext();
      const mesh = g.scene.getObjectByName('crowd-figures');
      const place = mesh.geometry.getAttribute('aPlace');

      /* Everything that draws water. Named rather than typed because the
         ocean is several meshes — the bands, the foam at the shore — and a
         figure over any of them is over the sea. */
      const water = [];
      g.stage.traverse(o => {
        if (o.isMesh && /ocean|water|shore-foam|sea/i.test(o.name || '')) water.push(o);
      });

      const grab = () => {
        const px = new Uint8Array(W * H * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      const changed = (a, b, x, y) => {
        const p = ((H - 1 - y) * W + x) * 4;
        return Math.abs(a[p] - b[p]) > 6 || Math.abs(a[p + 1] - b[p + 1]) > 6
          || Math.abs(a[p + 2] - b[p + 2]) > 6;
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
        const verdict = [];

        for (const back of backs) {
          g.setPaused(true);
          g.goTo(Math.max(0, atS - back - 55) / t.length);
          g.warp(0.75);
          const stop = Math.max(1, atS - back);
          for (let k = 0; k < 260 && g.player.s < stop; k++) g.step(1 / 60);

          const real = performance.now.bind(performance);
          const pinned = real();
          performance.now = () => pinned;
          g.renderOnce();                  // frame 0, discarded
          g.renderOnce();
          const A = grab();

          // The sea mask for this exact frame.
          const wasVisible = water.map(o => o.visible);
          water.forEach(o => { o.visible = false; });
          g.renderOnce();
          const noWater = grab();
          water.forEach((o, i) => { o.visible = wasVisible[i]; });
          g.renderOnce();

          for (let k = 0; k < mine.length; k++) {
            const i = mine[k];
            const y0 = place.getY(i);
            place.setY(i, y0 - 5000); place.needsUpdate = true;
            g.renderOnce();
            const B = grab();
            place.setY(i, y0); place.needsUpdate = true;
            const bb = box(A, B);
            if (!bb || bb.h < 10) continue;
            g.renderOnce();

            /* A band just under the boots, five columns across the figure.
               Three rows down and not one: the ink outline is two pixels of
               black that belongs to the figure, not to what it stands on. */
            const xs = [];
            for (let q = -2; q <= 2; q++) xs.push(Math.round(bb.x0 + bb.w * (0.5 + q * 0.12)));
            let sea = 0, ground = 0;
            for (const dy of [3, 5, 8]) {
              const y = bb.y1 + dy;
              for (const x of xs) {
                if (x < 0 || x >= W || y < 0 || y >= H) continue;
                if (changed(A, noWater, x, y)) sea++;
                else ground++;
              }
            }
            const total = sea + ground || 1;
            const rec = {
              h: bb.h, sea, ground,
              /* Half the band is the bar: a boot with more sea than ground
                 under it is a boot on the sea. */
              floating: sea > total * 0.5,
              kind: sea > ground ? 'STANDING ON THE SEA' : 'ground',
            };
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
      const bads = judged.filter(v => v.floating);
      seen += judged.length; bad += bads.length;
      if (bads.length) worst.push(`seed ${SEED} ${r.kind} s=${r.s} — ${bads.length}/${judged.length}`);
      console.log(`   ${r.kind.padEnd(14)} s=${String(r.s).padStart(5)}  ${judged.length}/${r.n} judged`
        + (bads.length ? `   ◀── ${bads.length} OVER SEA OR SKY` : ''));
      for (const v of judged) {
        console.log(`       ${v.floating ? 'BAD  ' : '  ok '} ${String(v.h).padStart(4)} px tall`
          + `   under the boots: sea ${v.sea} / ground ${v.ground}   ${v.kind}`);
      }
    }
  });
}

console.log(`\n  TOTAL: ${bad} of ${seen} judged figures stand on the sea`
  + ` (${(100 * bad / Math.max(seen, 1)).toFixed(0)}%)`);
for (const w of worst) console.log('    ' + w);

/* A headline computed from an empty tally is not a clean result.
 *
 * `Math.max(seen, 1)` above keeps the percentage from being NaN, and the cost of
 * that is that zero figures judged prints as "0 of 0 ... (0%)", which reads
 * exactly like a stage with no spectator over water. Measured, on a build with a
 * deliberate syntax error in src/core/util.js: all three seeds printed
 * "parse errors — not launching a browser", nothing was rendered or sampled at
 * all, and this tool printed that 0% headline and exited 0.
 *
 * Every way of reaching an empty tally is a reason to fail rather than a result:
 * the build did not parse, the page threw, `g.crowd` was absent, or every
 * ablation box came out under the 10 px floor so nothing was judged. */
if (!seen) {
  console.log('  FAIL nothing was judged — the 0% above is an empty tally,'
    + ' not a clean stage');
  process.exitCode = 1;
}

/* Never a bare finish(). `finish` defaults its argument to 0, so `finish()` is
   `finish(0)` — the same discarded exit code the 67-tool repair removed, in a
   spelling a grep for "finish(0)" cannot match. harness.run() raises
   process.exitCode on a parse error, a page error, a renderer crash or a probe
   throw, and this is the line that either reports that or hides it. */
finish(process.exitCode || 0);
