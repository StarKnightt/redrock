/* CRITIC PROBE — do the billboards swim as you go past?
 *
 * The classic failure of a y-locked billboard is that the bearing from the
 * figure to the camera sweeps through ninety degrees in the last few metres
 * of a close pass, and the sprite counter-rotates to match. Two things can
 * then be seen, and they are different faults:
 *
 *   spin    the figure visibly pivots about its own feet. A y-locked sprite
 *           that is symmetric about its own centreline cannot show this — but
 *           a flag-waver is NOT symmetric, and its flag stays pinned to the
 *           same side of the screen through a pass where a real person's flag
 *           would swap sides. Measured as the screen-space offset of the held
 *           item from the figure's own feet, signed, through the pass.
 *   width   the figure never foreshortens. A real cutout seen at eighty
 *           degrees off-axis would narrow to nothing; a billboard holds full
 *           width. Measured as projected width in pixels against the width a
 *           fixed-orientation cutout at the same distance would have.
 *
 * Everything is measured by ablation against the real pipeline, one figure at
 * a time, so "width" is the width the compositor drew and not a number out of
 * a projection matrix. Frames are stepped at the simulation rate, so the
 * per-frame rate columns are what a player at 60 Hz would actually see.
 *
 *   node tools/zzswim.mjs [--seed 22] [--site ramp] [--from 45] [--to -12]
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
const FROM = Number(flag('from', '45'));
const TO = Number(flag('to', '-12'));
const STRIP = args.includes('--strip');

const outDir = path.join(ROOT, 'shots', 'zzswim');
fs.mkdirSync(outDir, { recursive: true });

let out = null;
await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  out = await page.evaluate(([site, from, to, strip]) => {
    const g = window.__game;
    const THREE = g.THREE;
    const t = g.track;
    const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
    const gl = g.renderer.getContext();
    const mesh = g.scene.getObjectByName('crowd-figures');
    const place = mesh.geometry.getAttribute('aPlace');
    const bodyA = mesh.geometry.getAttribute('aBody');
    const limbA = mesh.geometry.getAttribute('aLimb');

    const grab = () => {
      const px = new Uint8Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const box = (a, b) => {
      let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let i = 0, p = 0; i < a.length; i += 4, p++) {
        if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i + 1] - b[i + 1]) > 6
          || Math.abs(a[i + 2] - b[i + 2]) > 6) {
          n++;
          const x = p % W, y = H - 1 - ((p / W) | 0);
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      return n ? { n, x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null;
    };

    const target = g.crowd.sites.find(s => s.kind.includes(site)) || g.crowd.sites[0];
    let closest = Infinity, atS = target.s;
    for (let s = Math.max(0, target.s - 250); s <= Math.min(t.length, target.s + 250); s += 2) {
      const f = t.frameAt(s);
      const d = Math.hypot(target.at.x - f.pos.x, target.at.z - f.pos.z);
      if (d < closest) { closest = d; atS = s; }
    }
    // Prefer a flag-waver: the asymmetric figure is the one that can betray spin.
    let pick = -1, pickPose = -1;
    for (let i = 0; i < place.count; i++) {
      if (Math.hypot(place.getX(i) - target.at.x, place.getZ(i) - target.at.z) > 26) continue;
      const pose = bodyA.getY(i);
      if (pick < 0 || (pose === 1 && pickPose !== 1)) { pick = i; pickPose = pose; }
    }
    const origin = new THREE.Vector3(place.getX(pick), place.getY(pick), place.getZ(pick));

    g.setPaused(true);
    g.autopilot(true, 0.85);
    g.goTo(Math.max(0, atS - from - 60) / t.length);
    g.warp(0.75);
    for (let k = 0; k < 300 && g.player.s < atS - from; k++) g.step(1 / 60);

    const rows = [];
    const shots = [];
    let prevYaw = null, prevS = null;
    const proj = new THREE.Vector3();

    while (g.player.s < atS - to) {
      const real = performance.now.bind(performance);
      const pinned = real();
      performance.now = () => pinned;
      g.renderOnce();
      const A = grab();
      const y0 = place.getY(pick);
      place.setY(pick, y0 - 5000); place.needsUpdate = true;
      g.renderOnce();
      const B = grab();
      place.setY(pick, y0); place.needsUpdate = true;
      g.renderOnce();
      performance.now = real;

      const bb = box(A, B);
      const cam = g.camera.position;
      // The bearing the shader turns the plane to, in world degrees.
      const yaw = Math.atan2(cam.x - origin.x, cam.z - origin.z) * 180 / Math.PI;
      let dYaw = 0;
      if (prevYaw !== null) {
        dYaw = yaw - prevYaw;
        while (dYaw > 180) dYaw -= 360;
        while (dYaw < -180) dYaw += 360;
      }
      // Screen position of the figure's own feet — the pivot the plane spins about.
      proj.copy(origin).project(g.camera);
      const footX = (proj.x * 0.5 + 0.5) * W;

      const dist = Math.hypot(cam.x - origin.x, cam.z - origin.z);
      rows.push({
        s: +g.player.s.toFixed(1), d: +dist.toFixed(1),
        yaw: +yaw.toFixed(1), dYaw: +dYaw.toFixed(2),
        w: bb ? bb.w : 0, h: bb ? bb.h : 0, n: bb ? bb.n : 0,
        footX: +footX.toFixed(0),
        itemDx: bb ? +(bb.x0 + bb.w / 2 - footX).toFixed(0) : 0,
      });
      if (strip && bb) {
        shots.push({ s: rows[rows.length - 1].s, d: rows[rows.length - 1].d,
          png: g.renderer.domElement.toDataURL('image/png'),
          box: [bb.x0, bb.y0, bb.w, bb.h] });
      }
      prevYaw = yaw; prevS = g.player.s;
      for (let k = 0; k < 4; k++) g.step(1 / 60);   // 15 Hz sampling of a 60 Hz sim
    }

    return {
      site: target.kind, s: Math.round(target.s), closest: +closest.toFixed(1),
      pick, pose: pickPose, height: +place.getW(pick).toFixed(2),
      itemL: limbA.getX(pick), itemR: limbA.getY(pick),
      rows, shots,
    };
  }, [SITE, FROM, TO, STRIP]);
});

if (out) {
  const POSE = ['cheer', 'flag', 'sit', 'pom'];
  console.log(`\n  ${out.site} s=${out.s} — tracking one ${POSE[out.pose]} figure`
    + ` (${out.height} m), closest approach ${out.closest} m`);
  console.log('\n     s      dist   bearing  Δbearing   Δbearing   figure px   item off');
  console.log('                       deg    /sample     /frame     w  x  h    centre');
  let peakFrame = 0, peakSample = 0;
  for (const r of out.rows) {
    const perFrame = r.dYaw / 4;
    if (Math.abs(perFrame) > Math.abs(peakFrame)) peakFrame = perFrame;
    if (Math.abs(r.dYaw) > Math.abs(peakSample)) peakSample = r.dYaw;
    console.log(`   ${String(r.s).padStart(6)}  ${String(r.d).padStart(6)} m`
      + `  ${String(r.yaw).padStart(7)}  ${String(r.dYaw.toFixed(2)).padStart(8)}`
      + `  ${String(perFrame.toFixed(2)).padStart(9)}`
      + `   ${String(r.w).padStart(3)} x ${String(r.h).padStart(3)}`
      + `  ${String(r.itemDx).padStart(7)} px`);
  }
  console.log(`\n  peak bearing rate: ${peakSample.toFixed(1)} deg per 1/15 s`
    + `  =  ${peakFrame.toFixed(2)} deg per 60 Hz frame`);

  const strip = out.shots || [];
  if (strip.length) {
    for (const sh of strip) {
      const f = path.join(outDir, `s${SEED}-${SITE}-d${String(Math.round(sh.d)).padStart(3, '0')}.png`);
      fs.writeFileSync(f, Buffer.from(sh.png.split(',')[1], 'base64'));
    }
    console.log(`  → ${strip.length} frames in shots/zzswim/`);
  }
}
finish(process.exitCode || 0);
