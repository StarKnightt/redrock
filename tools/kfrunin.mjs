/* R2 / D1 (B)(C)(D) — the run-in to the finish LINE, measured by ablation.
 *
 * Stations are metres short of the FINISH LINE (s = L - back), not metres short
 * of the group: the claim under test is "the crowd is at the finish", so the
 * line is the only origin that can settle it.
 *
 * At each station, with the car driven in by the autopilot and its arrival
 * verified:
 *   - performance.now() pinned across every render in the station,
 *   - frame 0 after the drive-in discarded, and a repeat render diffed against
 *     the base as a drift check (must be 0),
 *   - all finish-site instances dropped 5000 m and diffed  -> crowd footprint,
 *   - each finish-site instance dropped alone and diffed   -> tallest figure,
 *   - 'gate-finish' hidden and diffed                      -> gate footprint,
 *   - a native 1600x900 PNG of the un-ablated frame.
 *
 *   node tools/kfrunin.mjs [--seeds 22,1,40] [--backs 110,90,...] [--tag r2f]
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
const BACKS = flag('backs', '110,90,80,70,60,50,40,30,20,12,6,0').split(',').map(Number);
const TAG = flag('tag', 'r2f');
const OUT = flag('out', 'kfrunin');

const measDir = path.join(ROOT, '.meas', 'r2');
fs.mkdirSync(measDir, { recursive: true });
const lines = [];
const say = s => { console.log(s); lines.push(s); };
const all = [];

/* Our own capture: harness.capture() flips the pause state, which would let
   the game loop advance the car between the measurement and the picture. */
async function snap(page, file) {
  const url = await page.evaluate(() => {
    const g = window.__game;
    g.renderOnce();
    return g.renderer.domElement.toDataURL('image/png');
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  return file;
}

for (const SEED of SEEDS) {
  const shotDir = path.join(ROOT, 'shots', `${TAG}-${SEED}`);
  fs.mkdirSync(shotDir, { recursive: true });

  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    const head = await page.evaluate(() => {
      const g = window.__game, t = g.track;
      const crowd = g.crowd;
      if (!crowd) return { none: true, why: 'no crowd' };
      const site = crowd.sites.find(s => s.kind === 'finish');
      if (!site) return { none: true, why: 'no finish site' };
      const mesh = g.scene.getObjectByName('crowd-figures');
      const gate = g.stage.getObjectByName('gate-finish');
      if (!mesh || !gate) return { none: true, why: !gate ? 'no gate-finish' : 'no crowd mesh' };
      const place = mesh.geometry.getAttribute('aPlace');
      const mine = [];
      for (let i = 0; i < place.count; i++) {
        if (Math.hypot(place.getX(i) - site.at.x, place.getZ(i) - site.at.z) > 26) continue;
        mine.push(i);
      }
      window.__kf = { site, mesh, gate, place, mine };
      return {
        L: t.length, siteS: site.s, n: mine.length,
        W: g.renderer.domElement.width, H: g.renderer.domElement.height,
      };
    });
    if (head.none) { say(`  seed ${SEED}: ${head.why}`); return; }

    say(`\n══ seed ${SEED} ══  L=${head.L.toFixed(0)} m,`
      + ` finish site s=${head.siteS.toFixed(0)} (${(head.L - head.siteS).toFixed(0)} m before the line),`
      + ` ${head.n} figures,  frame ${head.W}x${head.H}`);
    say('    m-before-line   s reached  km/h  reached   crowd px  tallest fig px  gate px'
      + '   crowd box x[..]  y[..]   gate box x[..]   drift');

    const rows = [];
    for (const back of BACKS) {
      const drive = await page.evaluate((back) => {
        const g = window.__game, t = g.track;
        const target = t.length - back;
        g.setPaused(true);
        g.autopilot(true, 0.85);
        g.driveTo(target / t.length, { runUp: 230, maxSec: 45 });
        /* driveTo stops the moment it is past the target OR out of time; keep
           stepping a little if it fell short, then say so either way. */
        let extra = 0;
        while (g.player.s < target - 0.5 && extra++ < 1200) g.step(1 / 60);
        return {
          target: +target.toFixed(1), s: +g.player.s.toFixed(1),
          kmh: +g.player.kmh.toFixed(1),
          reached: g.player.s >= target - 2,
          over: +(g.player.s - target).toFixed(1),
        };
      }, back);

      if (!drive.reached) {
        say(`    ${String(back).padStart(6)} m       ${String(drive.s).padStart(7)}`
          + `  ${String(drive.kmh).padStart(5)}   ✗ NOT REACHED (${(drive.target - drive.s).toFixed(1)} m short) — no frame filed`);
        rows.push({ back, reached: false, s: drive.s, kmh: drive.kmh });
        continue;
      }

      const m = await page.evaluate(() => {
        const g = window.__game;
        const { mesh, gate, place, mine } = window.__kf;
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

        /* Pinned for the whole station and left pinned, so the PNG taken in
           the next evaluate is the same frame these numbers describe. */
        window.__realNow = performance.now.bind(performance);
        const t0 = window.__realNow();
        performance.now = () => t0;

        g.renderOnce();               // frame 0 after the drive-in, discarded
        g.renderOnce();
        const base = grab();
        g.renderOnce();
        const drift = diff(base, grab()).n;

        // all finish figures at once
        const ys = mine.map(i => place.getY(i));
        mine.forEach((i, k) => place.setY(i, ys[k] - 5000));
        place.needsUpdate = true;
        g.renderOnce();
        const dAll = diff(base, grab());
        mine.forEach((i, k) => place.setY(i, ys[k]));
        place.needsUpdate = true;

        // one at a time, for the tallest single figure
        const per = [];
        for (let k = 0; k < mine.length; k++) {
          const i = mine[k];
          place.setY(i, ys[k] - 5000);
          place.needsUpdate = true;
          g.renderOnce();
          const d = diff(base, grab());
          place.setY(i, ys[k]);
          place.needsUpdate = true;
          per.push(d.n ? { n: d.n, h: d.h, w: d.w, x0: d.x0, x1: d.x1, y0: d.y0, y1: d.y1 } : { n: 0, h: 0 });
        }

        gate.visible = false;
        g.renderOnce();
        const dGate = diff(base, grab());
        gate.visible = true;
        g.renderOnce();

        const tall = per.reduce((a, b) => Math.max(a, b.h || 0), 0);
        return {
          W, H, drift,
          crowd: dAll.n, crowdBox: dAll.n ? [dAll.x0, dAll.y0, dAll.x1, dAll.y1] : null,
          tallest: tall,
          visible: per.filter(p => p.n > 0).length,
          per,
          gate: dGate.n, gateBox: dGate.n ? [dGate.x0, dGate.y0, dGate.x1, dGate.y1] : null,
          eye: g.camera.position.toArray().map(v => +v.toFixed(1)),
        };
      });

      const file = path.join(shotDir, `s${SEED}-line-${String(back).padStart(3, '0')}m.png`);
      await snap(page, file);
      await page.evaluate(() => { performance.now = window.__realNow; });

      const cb = m.crowdBox, gb = m.gateBox;
      say(`    ${String(back).padStart(6)} m       ${String(drive.s).padStart(7)}`
        + `  ${String(drive.kmh).padStart(5)}   yes     `
        + `${String(m.crowd).padStart(8)}  ${String(m.tallest).padStart(10)} px`
        + `  ${String(m.gate).padStart(7)}`
        + `   ${cb ? `x[${cb[0]}..${cb[2]}] y[${cb[1]}..${cb[3]}]` : '        —        '}`
        + `  ${gb ? `x[${gb[0]}..${gb[2]}]` : '     —     '}`
        + `   ${m.drift}`);
      say(`             figures seen ${m.visible}/${head.n}`
        + `   per-figure px ${m.per.map(p => p.n).join(' ')}`
        + `   per-figure h ${m.per.map(p => p.h).join(' ')}`);
      rows.push({ back, reached: true, ...drive, ...m, file });
    }
    all.push({ seed: +SEED, L: head.L, siteS: head.siteS, n: head.n, rows });
    say(`    → ${shotDir}`);
  });
}

fs.writeFileSync(path.join(measDir, `${OUT}.json`), JSON.stringify(all, null, 2));
fs.writeFileSync(path.join(measDir, `${OUT}.txt`), lines.join('\n') + '\n');
console.log(`\n  → ${path.join(measDir, OUT + '.txt')}`);
finish(process.exitCode || 0);
