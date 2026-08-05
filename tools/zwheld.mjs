/* The held finish shot, RENDERED, over the range of stops it can be.
 *
 * zwshot renders one held frame — the one the autopilot happened to produce.
 * zwens sweeps the whole family of poses but scores them analytically. This does
 * the expensive thing: it settles the real ending, then walks the car's rest
 * station and lateral over the measured range, letting main.js rebuild its own
 * held camera each time, and counts crowd pixels by ablation in every frame.
 *
 * `holdCamera` is stateless and reads the car fresh every frame, so moving the
 * car and stepping once gives the genuine composition for that stop rather than
 * an approximation of it. The clock is pinned by the harness and frame 0 of each
 * differencing pair is discarded, both for the reason the round-2 audit found:
 * a shader uniform fed from `performance.now()` makes two renders of a static
 * scene genuinely different images.
 *
 *   node tools/zwheld.mjs [--seeds 22,1,40]
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
const RESTS = flag('rests', '2,8,15,22,28,34').split(',').map(Number);
const LATS = flag('lats', '-6,-3,0,3,6').split(',').map(Number);
const TAG = flag('tag', 'zwheld');

const lines = [];
const say = s => { console.log(s); lines.push(s); };
const all = [];

for (const SEED of SEEDS) {
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ending=1`,
  }, async ({ page }) => {
    const r = await page.evaluate(({ RESTS, LATS }) => {
      const g = window.__game, t = g.track;
      const P = g.scene.getObjectByName('environment').userData.crowdProbe;
      const LINE = P.line;
      const mesh = g.scene.getObjectByName('crowd-figures');
      const rails = g.scene.getObjectByName('crowd-barriers');

      /* zwshot's measurement, to the byte, so the two tools' numbers can be put
         in the same table: the clock pinned across every render, frame 0 of each
         pair discarded, the tallest figure taken as the tallest COLUMN of
         changed pixels rather than the height of the bounding box (a box over
         two separate groups is as tall as the gap between them), and the same
         6-per-channel threshold. */
      const gl = g.renderer.getContext();
      const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
      const grab = () => {
        const px = new Uint8Array(W * H * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      const foot = (a, b) => {
        let n = 0, x0 = W, x1 = -1, tall = 0;
        const colTop = new Int32Array(W).fill(-1), colBot = new Int32Array(W).fill(-1);
        for (let i = 0, p = 0; i < a.length; i += 4, p++) {
          if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i + 1] - b[i + 1]) > 6
            || Math.abs(a[i + 2] - b[i + 2]) > 6) {
            n++;
            const x = p % W, y = H - 1 - ((p / W) | 0);
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (colTop[x] < 0 || y < colTop[x]) colTop[x] = y;
            if (y > colBot[x]) colBot[x] = y;
          }
        }
        for (let x = 0; x < W; x++) {
          if (colTop[x] >= 0) tall = Math.max(tall, colBot[x] - colTop[x] + 1);
        }
        return { px: n, tall, x0: x1 < 0 ? null : x0, x1: x1 < 0 ? null : x1 };
      };
      const measure = () => {
        const real = performance.now.bind(performance);
        const pinned = real();
        performance.now = () => pinned;
        mesh.visible = true; if (rails) rails.visible = true;
        g.renderOnce(); g.renderOnce();
        const withC = grab();
        g.renderOnce();
        const drift = foot(withC, grab()).px;
        mesh.visible = false; if (rails) rails.visible = false;
        g.renderOnce();
        const without = grab();
        mesh.visible = true; if (rails) rails.visible = true;
        g.renderOnce();
        performance.now = real;
        return { ...foot(withC, without), drift };
      };

      g.setPaused(true);
      g.restart();
      g.autopilot(true, 0.85);
      for (let i = 0; i < 60 * 400 && g.player.s < LINE - 120; i++) g.step(1 / 60);
      g.ending.enabled = true;
      g.ending.arm();
      for (let i = 0; i < 60 * 60; i++) {
        g.step(1 / 60);
        if (g.ending.camera > 0.999 && g.player.speed < 0.3) break;
      }
      const rows = [];
      for (const rest of RESTS) {
        for (const lat of LATS) {
          g.player.s = LINE + rest;
          g.player.lat = lat;
          /* Two steps: one to let holdCamera read the moved car, one so the
             frame being measured is not the first after a state change. */
          g.step(1 / 60); g.step(1 / 60);
          rows.push({ rest, lat, ...measure() });
        }
      }
      return { LINE, gate: P.gate, rows, W, H };
    }, { RESTS, LATS });

    const legible = r.rows.filter(x => x.tall >= 12);
    const seen = r.rows.filter(x => x.px > 0);
    say(`\n══ seed ${SEED} ══  ${r.W}x${r.H}, ${r.rows.length} stops`
      + ` (${RESTS.length} rest marks x ${LATS.length} laterals)`);
    say(`  crowd in the held frame at all : ${seen.length}/${r.rows.length}`);
    say(`  crowd legible (>=12 px tall)   : ${legible.length}/${r.rows.length}`);
    if (legible.length) {
      const px = legible.map(x => x.px), tall = legible.map(x => x.tall);
      say(`  footprint over those frames    : ${Math.min(...px)}–${Math.max(...px)} px,`
        + ` tallest figure ${Math.min(...tall)}–${Math.max(...tall)} px`);
    }
    say('    rest  lat     px  tallest  drift');
    for (const x of r.rows) {
      say(`    ${String(x.rest).padStart(4)} ${String(x.lat).padStart(4)}`
        + ` ${String(x.px).padStart(6)}  ${String(x.tall).padStart(4)} px`
        + `  ${String(x.drift).padStart(5)}`
        + `${x.px === 0 ? '   ◀ nobody' : ''}`);
    }
    all.push({ seed: +SEED, ...r });
  });
}

const dir = path.join(ROOT, '.meas', 'r3');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${TAG}.json`), JSON.stringify(all, null, 2));
fs.writeFileSync(path.join(dir, `${TAG}.txt`), lines.join('\n') + '\n');
console.log(`\n  → ${path.join(dir, TAG + '.txt')}`);
finish(process.exitCode || 0);
