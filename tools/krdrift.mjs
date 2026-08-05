/* ROUND-2 — how much of a paused frame is not actually still.
 *
 * Every ablation probe in tools/ differences two renders of a paused scene, so
 * the whole family is only as good as the claim that two renders of a paused
 * scene are the same image. They are not: src/world/environment.js sets a
 * shader uniform from performance.now() inside onBeforeRender, so the grass
 * sways between renders — and tools/wheelnear.mjs once reported 26.7% ink
 * because of it, against 3.5% with the clock pinned.
 *
 * Two things are new in this build and both could add to that: the car is now
 * drawn by extrapolating the last physics substep against the wall clock, and
 * the frame cap counts vsyncs. So this measures, on a paused game:
 *
 *   unpinned drift   two renders, real clock. Every pixel that moves.
 *   pinned drift     two renders, performance.now() pinned. Should be zero.
 *   frame 0          the first render after the pin against the second, which
 *                    is the frame every probe is told to throw away.
 *   where            the drifting pixels attributed by ablation — car, crowd,
 *                    or the rest of the stage — so a probe author can see
 *                    which of them is moving under them.
 *
 *   node tools/krdrift.mjs [--seed 22]
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

let out = null;
await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  out = await page.evaluate(() => {
    const g = window.__game;
    const t = g.track;
    const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
    const glc = g.renderer.getContext();
    const mesh = g.scene.getObjectByName('crowd-figures');
    const rails = g.scene.getObjectByName('crowd-barriers');
    const carRoot = g.playerView && g.playerView.root;

    const grab = () => {
      const px = new Uint8Array(W * H * 4);
      glc.bindFramebuffer(glc.FRAMEBUFFER, null);
      glc.readPixels(0, 0, W, H, glc.RGBA, glc.UNSIGNED_BYTE, px);
      return px;
    };
    const diff = (a, b, thr = 6) => {
      const m = new Uint8Array(W * H);
      let n = 0;
      for (let i = 0, p = 0; i < a.length; i += 4, p++) {
        if (Math.abs(a[i] - b[i]) > thr || Math.abs(a[i + 1] - b[i + 1]) > thr
          || Math.abs(a[i + 2] - b[i + 2]) > thr) { m[p] = 1; n++; }
      }
      return { m, n };
    };
    const overlap = (m, n2) => {
      let both = 0;
      for (let p = 0; p < m.length; p++) if (m[p] && n2[p]) both++;
      return both;
    };
    const shot = () => { g.renderOnce(); return grab(); };
    const pause = ms => new Promise(r => setTimeout(r, ms));

    // A crowd site, driven in exactly as the ink and swim probes arrive.
    const site = g.crowd.sites.find(s => s.kind.includes('ramp')) || g.crowd.sites[0];
    let closest = Infinity, atS = site.s;
    for (let s = Math.max(0, site.s - 250); s <= Math.min(t.length, site.s + 250); s += 2) {
      const f = t.frameAt(s);
      const d = Math.hypot(site.at.x - f.pos.x, site.at.z - f.pos.z);
      if (d < closest) { closest = d; atS = s; }
    }
    g.setPaused(true);
    g.autopilot(true, 0.85);
    g.goTo(Math.max(0, atS - 65) / t.length);
    g.warp(0.75);
    for (let k = 0; k < 300 && g.player.s < atS - 8; k++) g.step(1 / 60);

    const real = performance.now.bind(performance);

    // ── unpinned: two renders 120 ms of wall clock apart ──────────────
    g.renderOnce();
    const u0 = shot();
    return (async () => {
      await pause(120);
      const u1 = shot();
      const un = diff(u0, u1);

      // ── pinned ───────────────────────────────────────────────────────
      const pinned = real();
      performance.now = () => pinned;
      const f0 = shot();                    // the frame every probe discards
      const f1 = shot();
      await pause(120);
      const f2 = shot();
      const zeroToOne = diff(f0, f1);
      const oneToTwo = diff(f1, f2);
      performance.now = real;

      /* Attribute the unpinned drift. Each subject is hidden and the frame
         differenced against the shown one; overlap with the drift mask says how
         much of the drift lives on that subject's pixels. */
      const attribute = (hide) => {
        const pin = real();
        performance.now = () => pin;
        g.renderOnce();
        const A = shot();
        hide(false);
        const B = shot();
        hide(true);
        performance.now = real;
        return diff(A, B).m;
      };
      const crowdMask = attribute(v => { mesh.visible = v; if (rails) rails.visible = v; });
      const carMask = carRoot ? attribute(v => { carRoot.visible = v; }) : null;

      return {
        site: site.kind, atS: Math.round(atS), s: +g.player.s.toFixed(1),
        pixels: W * H,
        unpinned: un.n,
        unpinnedPct: +(100 * un.n / (W * H)).toFixed(2),
        pinnedFrame0to1: zeroToOne.n,
        pinnedFrame1to2: oneToTwo.n,
        driftOnCrowd: overlap(un.m, crowdMask),
        driftOnCar: carMask ? overlap(un.m, carMask) : null,
        crowdArea: crowdMask.reduce((a, b) => a + b, 0),
        carArea: carMask ? carMask.reduce((a, b) => a + b, 0) : null,
      };
    })();
  });
});

if (out) {
  console.log(`\n  seed ${SEED} — ${out.site}, car paused at s=${out.s} (${out.pixels} px frame)`);
  console.log(`\n  two renders of the PAUSED scene, 120 ms of wall clock apart, real clock`);
  console.log(`    pixels that changed        ${String(out.unpinned).padStart(8)}`
    + `   ${out.unpinnedPct}% of the frame`);
  console.log(`      of those, on the crowd   ${String(out.driftOnCrowd).padStart(8)}`
    + `   (crowd footprint ${out.crowdArea} px)`);
  if (out.driftOnCar !== null) {
    console.log(`      of those, on the car     ${String(out.driftOnCar).padStart(8)}`
      + `   (car footprint ${out.carArea} px)`);
  }
  console.log(`\n  the same two renders with performance.now() pinned`);
  console.log(`    frame 0 vs frame 1         ${String(out.pinnedFrame0to1).padStart(8)}`
    + `   ← the frame the discipline says to discard`);
  console.log(`    frame 1 vs frame 2         ${String(out.pinnedFrame1to2).padStart(8)}`
    + `   (120 ms of wall clock in between)`);
  const f = path.join(ROOT, '.meas', 'r2', `krdrift-${SEED}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(out, null, 1));
  console.log(`\n  → ${f}`);
}
finish(process.exitCode || 0);
