/* Does the crowd's placement model predict what the player sees?
 *
 * `crowdStand` accepts or rejects a spot using `crowdSeen`, a sightline
 * marched in the road's own coordinates, and a footing gate. Everything the
 * crowd does rests on those two predicates being right, and neither has ever
 * been held against a frame — the evidence for them is other model output.
 *
 * This grades them against pixels, which cannot be argued with. For each
 * candidate station one live crowd instance is borrowed, moved to the spot the
 * model would put a figure at, and then measured by ablation from the real
 * chase lens on the real approach: render, drop that instance five kilometres
 * below the stage, render again, count what changed. Everything else in the
 * frame is untouched, so the difference is that figure and its ink.
 *
 * Discipline, as everywhere else here: 1600x900 through g.pipeline.render(),
 * the car driven in on autopilot, performance.now() pinned across each
 * station, frame 0 after each drive-in discarded.
 *
 *   node tools/zqoracle.mjs [--seed 22] [--from 5508] [--to 5578] [--step 10]
 *                           [--backs 45,30,20,12] [--minpx 20]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const FROM = flag('from', '');
const TO = flag('to', '');
const STEP = Number(flag('step', '10'));
const BACKS = flag('backs', '45,30,20,12').split(',').map(Number);
const MINPX = Number(flag('minpx', '20'));

await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(600_000);
  const out = await page.evaluate(([from, to, step, backs, minpx]) => {
    const g = window.__game;
    const THREE = g.THREE;
    const t = g.track;
    const env = g.scene.getObjectByName('environment') || g.stage.getObjectByName('environment');
    const probe = env?.userData?.crowdProbe;
    if (!probe) return { none: 'no crowdProbe on the environment' };
    const mesh = g.scene.getObjectByName('crowd-figures');
    if (!mesh) return { none: 'no crowd mesh' };
    const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
    const gl = g.renderer.getContext();
    const place = mesh.geometry.getAttribute('aPlace');

    const grab = () => {
      const px = new Uint8Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const diff = (a, b) => {
      let n = 0, y0 = 1e9, y1 = -1;
      for (let i = 0, p = 0; i < a.length; i += 4, p++) {
        if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i + 1] - b[i + 1]) > 6
          || Math.abs(a[i + 2] - b[i + 2]) > 6) {
          n++;
          const y = H - 1 - ((p / W) | 0);
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      return { n, h: n ? y1 - y0 + 1 : 0 };
    };

    const L = t.length;
    const s0 = from === '' ? L - 90 : Number(from);
    const s1 = to === '' ? L - 20 : Number(to);
    if (s1 < s0) return { none: 'empty window' };

    /* One instance is borrowed for the whole run and put back at the end. The
       rest of the crowd stays exactly where it is, so the frame the candidate
       is measured against is the shipped frame. */
    const IX = 0;
    const keep = [place.getX(IX), place.getY(IX), place.getZ(IX), place.getW(IX)];

    g.setPaused(true);
    g.autopilot(true, 0.85);
    const rows = [];

    for (let sc = s0; sc <= s1 + 1e-6; sc += step) {
      for (const side of [1, -1]) {
        const u = probe.stand(sc, side);
        const model = u !== null;
        /* When the model rejects a spot there is still a question worth
           asking — how visible is it REALLY — so the candidate is measured
           either way, from the standing distance the model would have used. */
        const uUse = u !== null
          ? u
          : Math.min(0.86, probe.stand_m / Math.max(probe.wallDist(sc, side), 1));
        const p = probe.point(sc, side, uUse);
        if (!isFinite(p.x)) continue;

        place.setX(IX, p.x); place.setY(IX, p.y - 0.06); place.setZ(IX, p.z);
        place.setW(IX, 1.82);
        place.needsUpdate = true;

        let bestPx = 0, bestTall = 0, bestBack = null;
        const trace = [];
        for (const back of backs) {
          g.goTo(Math.max(0, sc - back - 60) / L);
          g.warp(0.75);
          const stop = Math.max(1, sc - back);
          for (let k = 0; k < 320 && g.player.s < stop; k++) g.step(1 / 60);

          const real = performance.now.bind(performance);
          const pinned = real();
          performance.now = () => pinned;
          g.renderOnce();                    // frame 0, discarded
          g.renderOnce();
          const A = grab();
          const y = place.getY(IX);
          place.setY(IX, y - 5000); place.needsUpdate = true;
          g.renderOnce();
          const d = diff(A, grab());
          place.setY(IX, y); place.needsUpdate = true;
          g.renderOnce();
          performance.now = real;

          trace.push(`${back}m:${d.n}px/${d.h}t`);
          if (d.h > bestTall) { bestTall = d.h; bestBack = back; }
          if (d.n > bestPx) bestPx = d.n;
        }
        rows.push({
          s: +sc.toFixed(0), side, model, u: u === null ? null : +u.toFixed(3),
          off: +(uUse * probe.wallDist(sc, side)).toFixed(1),
          px: bestPx, tall: bestTall, at: bestBack, trace,
          real: bestTall >= minpx,
        });
      }
    }

    place.setX(IX, keep[0]); place.setY(IX, keep[1]);
    place.setZ(IX, keep[2]); place.setW(IX, keep[3]);
    place.needsUpdate = true;
    g.autopilot(false);
    return { rows, L: +L.toFixed(0) };
  }, [FROM, TO, STEP, BACKS, MINPX]);

  if (out.none) { console.log('  ' + out.none); return; }

  console.log(`\n  seed ${SEED} — one test figure walked over the window, graded by ablation`);
  console.log(`  "real" = tallest ablation box >= ${MINPX} px at one of ${BACKS.join('/')} m back\n`);
  console.log('       s   side   model   off kerb    peak px   tallest    verdict');
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of out.rows) {
    const v = r.model && r.real ? 'agree (place, seen)'
      : !r.model && !r.real ? 'agree (reject, unseen)'
        : r.model && !r.real ? 'MODEL SAYS YES, PIXELS SAY NO'
          : 'model says no, pixels say YES';
    if (r.model && r.real) tp++; else if (r.model) fp++;
    else if (r.real) fn++; else tn++;
    console.log(`   ${String(r.s).padStart(5)}   ${String(r.side).padStart(3)}`
      + `   ${(r.model ? 'yes' : 'no').padStart(5)}`
      + `   ${(r.off + ' m').padStart(8)}`
      + `   ${String(r.px).padStart(7)}   ${String(r.tall).padStart(5)} px`
      + `   ${v}`);
    console.log(`                 ${r.trace.join('  ')}`);
  }
  const n = out.rows.length;
  console.log(`\n  model vs pixels over ${n} candidates:`);
  console.log(`    placed and visible        ${tp}`);
  console.log(`    placed and NOT visible    ${fp}   ◀── the failure that ships`);
  console.log(`    rejected but visible      ${fn}   (missed opportunity, not a defect)`);
  console.log(`    rejected and not visible  ${tn}`);
  console.log(`    agreement ${(100 * (tp + tn) / n).toFixed(0)}%\n`);
});
finish(process.exitCode || 0);
