/* CRITIC PROBE — who is actually on screen, in pixels.
 *
 * tools/crowdaudit.mjs answers "is this figure visible" with Three's
 * raycaster. The crowd implementer reports that its finish-line answer (4 of
 * 8) disagrees with what the captures show, and blames the ray grazing the
 * berm crest. That is a testable claim and this is the test.
 *
 * The method is ablation, which cannot be argued with: render the frame,
 * then render it again with one figure's instance origin dropped five
 * kilometres below the stage, and diff. Pixels that changed are pixels that
 * figure owned. It sees exactly what the compositor sees — through the
 * outline pass, through fog, behind every occluder in the scene — because it
 * IS the frame.
 *
 * Both instruments run at the SAME eye point in the same evaluate, so
 * "the capture rig does not reproduce the lens" is not available as an
 * explanation for a disagreement. Whichever way it falls, it falls cleanly.
 *
 * Discipline:
 *   - performance.now() pinned to a constant across every render in a
 *     station, so the grass and the turbines cannot contribute a diff.
 *   - frame 0 after each drive-in discarded.
 *   - 1600x900 through g.pipeline.render(), car driven in by the AI.
 *
 *   node tools/zzseen.mjs [--seed 22] [--site finish] [--backs 80,55,35,22,12]
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
const ONLY = flag('site', '');
const BACKS = flag('backs', '80,55,35,22,12').split(',').map(Number);
const SHOT = args.includes('--shots');

const outDir = path.join(ROOT, 'shots', `zzseen${SEED}`);
if (SHOT) { fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true }); }

await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  const res = await page.evaluate(([backs, only]) => {
    const g = window.__game;
    const THREE = g.THREE;
    const t = g.track;
    const crowd = g.crowd;
    if (!crowd) return { none: true };
    const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
    const gl = g.renderer.getContext();

    const mesh = g.scene.getObjectByName('crowd-figures');
    const place = mesh.geometry.getAttribute('aPlace');
    const bodyA = mesh.geometry.getAttribute('aBody');

    /* Pixel readback of whatever the pipeline just put on the default
       framebuffer. Has to happen in the same task as the render — the
       drawing buffer is not preserved. */
    const grab = () => {
      const px = new Uint8Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    /* Threshold of 6 per channel: below that is the grade's dither and the
       ink pass's edge antialiasing wobbling by a code value, which is not a
       figure. Returns count and bounding box in image coordinates with y
       already flipped to top-down. */
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
      return n ? { n, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { n: 0 };
    };

    // Raycast targets, copied from crowdaudit so the comparison is exact.
    const skip = /sky-dome|sun-disc|ocean-bands|shore-foam|block-clouds|bird|beam|foam|crowd/i;
    const targets = [];
    g.stage.updateMatrixWorld(true);
    g.stage.traverse(o => {
      if (!o.isMesh) return;
      let nm = o.name;
      for (let q = o.parent; !nm && q; q = q.parent) nm = q.name;
      if (skip.test(nm || '')) return;
      o.userData.__probeName = nm || '(unnamed)';
      targets.push(o);
    });
    const ray = new THREE.Raycaster();
    const dir = new THREE.Vector3();

    g.autopilot(true, 0.85);
    const rows = [];
    const shots = [];

    for (const site of crowd.sites) {
      if (only && !site.kind.includes(only)) continue;
      // Station of closest approach, the same window crowdaudit uses.
      let closest = Infinity, atS = site.s;
      for (let s = Math.max(0, site.s - 250); s <= Math.min(t.length, site.s + 250); s += 2) {
        const f = t.frameAt(s);
        const d = Math.hypot(site.at.x - f.pos.x, site.at.z - f.pos.z);
        if (d < closest) { closest = d; atS = s; }
      }
      // Which instances belong to this site.
      const mine = [];
      for (let i = 0; i < place.count; i++) {
        const ox = place.getX(i), oy = place.getY(i), oz = place.getZ(i);
        if (Math.hypot(ox - site.at.x, oz - site.at.z) > 26) continue;
        mine.push({ i, x: ox, y: oy, z: oz, h: place.getW(i), pose: bodyA.getY(i) });
      }

      const everPx = mine.map(() => 0);
      const everRay = mine.map(() => false);
      const stations = [];

      for (const back of backs) {
        g.setPaused(true);
        g.goTo(Math.max(0, atS - back - 55) / t.length);
        g.warp(0.75);
        const stop = Math.max(1, atS - back);
        for (let k = 0; k < 260 && g.player.s < stop; k++) g.step(1 / 60);

        const eye = g.camera.position.clone();

        // ── raycast, exactly as crowdaudit does it ──────────────────────
        const rayN = [];
        for (const m of mine) {
          const target = new THREE.Vector3(m.x, m.y + m.h * 0.55, m.z);
          dir.copy(target).sub(eye);
          const len = dir.length();
          ray.far = len - 0.35;
          ray.set(eye, dir.clone().normalize());
          const hit = ray.intersectObjects(targets, false)[0];
          rayN.push(hit ? hit.object.userData.__probeName : null);
        }

        // ── pixels, by ablation ────────────────────────────────────────
        const real = performance.now.bind(performance);
        const pinned = real();
        performance.now = () => pinned;
        g.renderOnce();          // frame 0, discarded
        g.renderOnce();
        const base = grab();
        // sanity: a second identical render must be bit-identical once pinned
        g.renderOnce();
        const again = grab();
        const drift = diff(base, again).n;

        const pxN = [];
        for (let k = 0; k < mine.length; k++) {
          const i = mine[k].i;
          const y0 = place.getY(i);
          place.setY(i, y0 - 5000);
          place.needsUpdate = true;
          g.renderOnce();
          const d = diff(base, grab());
          place.setY(i, y0);
          place.needsUpdate = true;
          pxN.push(d);
          if (d.n > everPx[k]) everPx[k] = d.n;
          if (!rayN[k]) everRay[k] = true;
        }
        g.renderOnce();
        performance.now = real;

        stations.push({
          back, s: +g.player.s.toFixed(0), drift,
          px: pxN.map(d => d.n),
          boxes: pxN.map(d => d.n ? [d.x0, d.y0, d.w, d.h] : null),
          rayBlocked: rayN.map(v => v || ''),
          eye: [+eye.x.toFixed(1), +eye.y.toFixed(1), +eye.z.toFixed(1)],
        });
      }

      rows.push({
        kind: site.kind, s: Math.round(site.s), atS: Math.round(atS),
        closest: +closest.toFixed(1),
        n: mine.length,
        heights: mine.map(m => +m.h.toFixed(2)),
        poses: mine.map(m => m.pose),
        seenPx: everPx.filter(v => v > 0).length,
        seenRay: everRay.filter(Boolean).length,
        everPx, stations,
      });
    }
    g.autopilot(false);
    return { rows, W, H, fov: g.camera.fov };
  }, [BACKS, ONLY]);

  if (res.none) { console.log('  no crowd'); return; }
  const POSE = ['cheer', 'flag', 'sit', 'pom'];

  console.log(`\n  seed ${SEED} — pixel truth vs raycast, ${res.W}x${res.H}\n`);
  for (const r of res.rows) {
    const agree = r.seenPx === r.seenRay ? '' : '   ◀── INSTRUMENTS DISAGREE';
    console.log(`  ${r.kind}  s=${r.s}  closest ${r.closest} m  ${r.n} figures`);
    console.log(`    ever visible — PIXELS ${r.seenPx}/${r.n}    RAYCAST ${r.seenRay}/${r.n}${agree}`);
    console.log(`    poses: ${r.poses.map(p => POSE[p]).join(' ')}`);
    for (const st of r.stations) {
      const vis = st.px.filter(v => v > 0).length;
      const rvis = st.rayBlocked.filter(v => !v).length;
      const tall = st.boxes.filter(Boolean).map(b => b[3]);
      console.log(`      ${String(st.back).padStart(3)} m back (s=${st.s})`
        + `  px ${String(vis).padStart(2)}/${r.n}`
        + `  ray ${String(rvis).padStart(2)}/${r.n}`
        + `  drift ${st.drift}`
        + `  heights ${tall.length ? Math.min(...tall) + '–' + Math.max(...tall) + ' px' : '—'}`);
      const blocked = [...new Set(st.rayBlocked.filter(Boolean))];
      if (blocked.length) console.log(`            ray blockers: ${blocked.join(', ')}`);
      console.log(`            px per figure: ${st.px.join(' ')}`);
    }
    console.log();
  }
});
finish(process.exitCode || 0);
