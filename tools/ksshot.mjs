/* Capture named frames from the lap tools/kslap.mjs measured.
 *
 * The lap is only reproducible if the procedure is: rendering perturbs the
 * simulation, so a capture pass has to repeat the sweep's renders sample for
 * sample or it arrives somewhere else (311 m out by frame 11085, measured).
 * So this re-runs kslap's own sweep at the same rate in a fresh page and
 * photographs the wanted frames on the way past, checking the station against
 * the sweep's record.
 *
 * Frames come from .meas/r2/kslap-<seed>.json: by default the sample with the
 * largest crowd screen coverage, which is a different frame from the one with
 * the most legible figures and the other half of the "wall-to-wall" question.
 *
 *   node tools/ksshot.mjs [--seed 22] [--what cover] [--frames 1234,5678]
 */
import fs from 'node:fs';
import path from 'node:path';
import { run } from './harness.mjs';
import { freeze } from './kssnap.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const WHAT = flag('what', 'cover');
const FRAMES = flag('frames', '');

const OUT = path.resolve('.meas/r2');
const SHOTS = path.resolve(`shots/r2s-${SEED}`);
fs.mkdirSync(SHOTS, { recursive: true });

const lap = JSON.parse(fs.readFileSync(path.join(OUT, `kslap-${SEED}.json`), 'utf8'));
const SAMPLE = lap.sample, MINPX = lap.minpx;

/* Sample index -> frame number. kslap's rows carry t, and the sweep samples
   every round multiple of SAMPLE seconds, so the frame is exact. */
const rowFrame = r => Math.round(r.t * 60);

let targets = [];
if (FRAMES) {
  targets = FRAMES.split(',').map(x => Number(x.trim())).filter(Boolean)
    .map(f => ({ frame: f, tag: 'asked', row: lap.rows.find(r => rowFrame(r) === f) }));
} else if (WHAT === 'cover') {
  const best = lap.rows.slice().sort((a, b) => b.maskN - a.maskN)[0];
  targets = [{ frame: rowFrame(best), tag: 'maxcover', row: best }];
} else if (WHAT === 'sites') {
  /* The most separate groups in one frame — the count the brief's
     "wall-to-wall" is about, whether or not they are legible. */
  const best = lap.rows.slice().sort((a, b) =>
    b.nSiteAny - a.nSiteAny || b.nSiteLeg - a.nSiteLeg || b.maskN - a.maskN)[0];
  targets = [{ frame: rowFrame(best), tag: `maxsites${best.nSiteAny}`, row: best }];
}

console.log(`seed ${SEED}: ${targets.length} target(s) — `
  + targets.map(t => `f=${t.frame} t=${t.row ? t.row.t : '?'} s=${t.row ? t.row.s : '?'}`).join(', '));

/* The sweep, verbatim from tools/kslap.mjs — the render cadence is the part
   that has to match, so it is the whole thing rather than a lighter version. */
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
    if (behind) { x0 = 0; x1 = W; y0 = 0; y1 = H; }
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
  const diff = (a, i, b, j) => Math.abs(a[i] - b[j]) > 6
    || Math.abs(a[i + 1] - b[j + 1]) > 6 || Math.abs(a[i + 2] - b[j + 2]) > 6;
  let threw = 0;
  const step = dt => { try { g.step(dt); } catch (e) { threw++; } };

  const measure = () => {
    const real = performance.now.bind(performance);
    const pinned = real();
    performance.now = () => pinned;
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    mesh.visible = true; if (rails) rails.visible = true;
    g.renderOnce(); g.renderOnce();
    const base = full();
    mesh.visible = false; if (rails) rails.visible = false;
    g.renderOnce();
    const none = full();
    mesh.visible = true; if (rails) rails.visible = true;
    const mask = new Uint8Array(W * H);
    let maskN = 0;
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      if (diff(base, i, none, i)) { mask[p] = 1; maskN++; }
    }
    if (maskN && rails) {
      rails.visible = false; g.renderOnce(); full(); rails.visible = true;
    }
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
        const y = P[k * 4 + 1];
        P[k * 4 + 1] = -1e5; A.aPlace.needsUpdate = true;
        g.renderOnce();
        const sub = new Uint8Array(b.w * b.h * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(b.x0, b.y0, b.w, b.h, gl.RGBA, gl.UNSIGNED_BYTE, sub);
        P[k * 4 + 1] = y; A.aPlace.needsUpdate = true;
      }
    }
    performance.now = real;
    return maskN;
  };

  window.__ks = {
    shoot(sample, want) {
      g.setPaused(true); g.goTo(0.0005); g.autopilot(true, 0.85); g.warp(0.5);
      const wanted = new Set(want);
      const every = Math.max(1, Math.round(sample * 60));
      const shots = [];
      let frames = 0;
      while (g.player.s < g.track.length - 3 && frames < 60 * 60 * 8) {
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
        measure();
      }
      return { shots, frames, threw };
    },
  };
  return { W, H, N };
}

const snap = await freeze();
console.log(`code snapshot ${snap.stamp}`);

await run({
  width: 1600, height: 900,
  url: `${snap.base}/#manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(1_800_000);
  await page.evaluate(install);
  const out = await page.evaluate(([sm, w]) => window.__ks.shoot(sm, w),
    [SAMPLE, targets.map(t => t.frame)]);
  const written = [];
  for (const tg of targets) {
    const got = out.shots.find(s => s.f === tg.frame);
    if (!got) { console.log(`  MISSED f=${tg.frame}`); continue; }
    const r = tg.row;
    const name = `${tg.tag}-t${r ? r.t.toFixed(2) : '?'}s-s${r ? Math.round(r.s) : '?'}`
      + `-${r ? (100 * r.maskN / lap.frame.px).toFixed(3) : '?'}pct-${r ? r.nLeg : '?'}legible`
      + `-${r ? r.nSiteAny : '?'}sites.png`;
    const file = path.join(SHOTS, name);
    fs.writeFileSync(file, Buffer.from(got.url.split(',')[1], 'base64'));
    written.push({ file, frame: tg.frame, wantS: r ? r.s : null, gotS: got.s });
    console.log(`  ${tg.tag}: f=${tg.frame} s sweep ${r ? r.s : '?'} / capture ${got.s}`
      + `  -> ${file}`);
  }
  fs.writeFileSync(path.join(OUT, `ksshot-${SEED}.json`), JSON.stringify({
    seed: SEED, snapshot: snap.stamp, targets: targets.map(t => ({
      frame: t.frame, tag: t.tag, t: t.row ? t.row.t : null, s: t.row ? t.row.s : null,
      maskN: t.row ? t.row.maskN : null, nLeg: t.row ? t.row.nLeg : null,
      coverPct: t.row ? +(100 * t.row.maskN / lap.frame.px).toFixed(3) : null,
    })), written,
  }, null, 1));
});
snap.close();
finish(process.exitCode || 0);
