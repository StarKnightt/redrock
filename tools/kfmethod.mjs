/* R2 / D1 — the same stations measured two ways.
 *
 * tools/zqfinframe.mjs reports the finish crowd and the finish gate on screen
 * together at 7 of 7 stations on all three seeds. tools/kfsweep.mjs, driving
 * the car in with the autopilot, does not agree. The two differ in exactly one
 * thing: how the car gets to the station.
 *
 *   teleport — goTo(s - 55), warp(0.75), then step until p.s >= s. This is
 *              zqfinframe's method verbatim. goTo calls placeAt, which zeroes
 *              the velocity and puts the car on the centreline, and resets the
 *              chase camera; three-quarters of a second of simulation is not
 *              enough to get either back to racing values.
 *   driven   — one autopilot run-in from 250 m further back, stopping at each
 *              station on the way past.
 *
 * Both measure the same thing at the same station in the same frame: crowd
 * footprint by instance ablation, gate footprint by hiding 'gate-finish'.
 * Stations are zqfinframe's, i.e. metres before the GROUP, and the metres
 * before the LINE are printed beside them.
 *
 *   node tools/kfmethod.mjs [--seeds 22,1,40] [--backs 90,70,55,40,28,18,10]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');
const BACKS = flag('backs', '90,70,55,40,28,18,10').split(',').map(Number);

const measDir = path.join(ROOT, '.meas', 'r2');
fs.mkdirSync(measDir, { recursive: true });
const lines = [];
const say = s => { console.log(s); lines.push(s); };
const all = [];

for (const SEED of SEEDS) {
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    const res = await page.evaluate(([backs]) => {
      const g = window.__game, t = g.track;
      if (!g.crowd) return { none: true };
      const site = g.crowd.sites.find(s => s.kind === 'finish');
      const mesh = g.scene.getObjectByName('crowd-figures');
      const gate = g.stage.getObjectByName('gate-finish');
      if (!site || !mesh || !gate) return { none: true };
      const place = mesh.geometry.getAttribute('aPlace');
      const mine = [];
      for (let i = 0; i < place.count; i++) {
        if (Math.hypot(place.getX(i) - site.at.x, place.getZ(i) - site.at.z) > 26) continue;
        mine.push(i);
      }
      const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
      const gl = g.renderer.getContext();
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
        return n ? { n, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { n: 0 };
      };
      const measure = () => {
        const real = performance.now.bind(performance);
        const t0 = real();
        performance.now = () => t0;
        g.renderOnce();
        g.renderOnce();
        const base = grab();
        g.renderOnce();
        const drift = diff(base, grab()).n;
        const ys = mine.map(i => place.getY(i));
        mine.forEach((i, k) => place.setY(i, ys[k] - 5000));
        place.needsUpdate = true;
        g.renderOnce();
        const dAll = diff(base, grab());
        mine.forEach((i, k) => place.setY(i, ys[k]));
        place.needsUpdate = true;
        const per = [];
        for (let k = 0; k < mine.length; k++) {
          place.setY(mine[k], ys[k] - 5000);
          place.needsUpdate = true;
          g.renderOnce();
          const d = diff(base, grab());
          place.setY(mine[k], ys[k]);
          place.needsUpdate = true;
          per.push(d.n ? d.h : 0);
        }
        gate.visible = false;
        g.renderOnce();
        const dGate = diff(base, grab());
        gate.visible = true;
        g.renderOnce();
        performance.now = real;
        return {
          drift,
          crowd: dAll.n, crowdBox: dAll.n ? [dAll.x0, dAll.y0, dAll.x1, dAll.y1] : null,
          tallest: per.reduce((a, b) => Math.max(a, b), 0),
          seen: per.filter(x => x > 0).length,
          gate: dGate.n, gateBox: dGate.n ? [dGate.x0, dGate.y0, dGate.x1, dGate.y1] : null,
          kmh: +g.player.kmh.toFixed(1), lat: +g.player.lat.toFixed(2),
          s: +g.player.s.toFixed(1),
          eye: g.camera.position.toArray().map(v => +v.toFixed(1)),
        };
      };

      g.setPaused(true);
      g.autopilot(true, 0.85);

      // ── teleport, exactly as tools/zqfinframe.mjs does it ────────────────
      const tele = [];
      for (const back of backs) {
        const s = site.s - back;
        if (s < 30) continue;
        g.goTo(Math.max(0, s - 55) / t.length);
        g.warp(0.75);
        for (let k = 0; k < 260 && g.player.s < s; k++) g.step(1 / 60);
        tele.push({ back, want: +s.toFixed(1), ...measure() });
      }

      // ── one driven run-in past all of them ───────────────────────────────
      const first = site.s - Math.max(...backs);
      g.driveTo((first - 250) / t.length, { runUp: 460, skill: 0.85, maxSec: 70 });
      const driven = [];
      for (const back of backs) {
        const s = site.s - back;
        if (s < 30) continue;
        let n = 0, stall = 0, best = g.player.s;
        while (g.player.s < s && n++ < 5400) {
          g.step(1 / 60);
          if (g.player.s > best + 1e-4) { best = g.player.s; stall = 0; }
          else if (++stall >= 420) break;
        }
        driven.push({ back, want: +s.toFixed(1), reached: g.player.s >= s - 2, ...measure() });
      }
      g.autopilot(false);
      return { L: t.length, siteS: site.s, n: mine.length, W, tele, driven };
    }, [BACKS]);

    if (res.none) { say(`  seed ${SEED}: no crowd/gate`); return; }
    say(`\n══ seed ${SEED} ══  L=${res.L}  site s=${res.siteS}`
      + ` (${(res.L - res.siteS).toFixed(0)} m before the line)  ${res.n} figures`);
    say('    back  m-before   method      km/h   lat    crowd px  tallest  gate px'
      + '     crowd box x       gate box x     both');
    for (let i = 0; i < res.tele.length; i++) {
      for (const [name, r] of [['teleport', res.tele[i]], ['driven  ', res.driven[i]]]) {
        if (!r) continue;
        const cb = r.crowdBox, gb = r.gateBox;
        say(`   ${String(r.back).padStart(4)} m ${String((res.L - r.want).toFixed(0)).padStart(6)} m`
          + `   ${name}  ${String(r.kmh).padStart(6)} ${String(r.lat).padStart(6)}`
          + `  ${String(r.crowd).padStart(8)}  ${String(r.tallest).padStart(5)}px`
          + `  ${String(r.gate).padStart(7)}`
          + `  ${(cb ? `[${cb[0]}..${cb[2]}]` : '—').padStart(14)}`
          + `  ${(gb ? `[${gb[0]}..${gb[2]}]` : '—').padStart(14)}`
          + `   ${r.crowd > 0 && r.gate > 0 ? 'YES' : 'no '}`
          + (r.reached === false ? '  ✗ not reached' : ''));
      }
    }
    const tb = res.tele.filter(r => r.crowd > 0 && r.gate > 0).length;
    const db = res.driven.filter(r => r.crowd > 0 && r.gate > 0).length;
    say(`    both on screen — teleport ${tb}/${res.tele.length}   driven ${db}/${res.driven.length}`);
    all.push({ seed: +SEED, ...res });
  });
}

fs.writeFileSync(path.join(measDir, 'kfmethod.json'), JSON.stringify(all, null, 2));
fs.writeFileSync(path.join(measDir, 'kfmethod.txt'), lines.join('\n') + '\n');
console.log(`\n  → ${path.join(measDir, 'kfmethod.txt')}`);
finish(process.exitCode || 0);
