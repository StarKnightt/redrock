/* No-op proof for the one approved edit to src/render/outline.js.
 *
 * The composite gained a single gate: a depth step between two fragments that
 * both carry the burst class raises no line. The claim to be proved is that
 * every other line in the game comes out unchanged, not "looks the same" but
 * byte for byte.
 *
 * So: eight scenarios with no burst anywhere on screen, two raw buffers hashed
 * in each — the shipping composite, and the same frame with the pen switched
 * off, which pins the beauty pass independently of the pen — plus, in every
 * scenario, the ink share on the car's own pixels, because the one line that
 * must survive is the hero's contour and a hash that matches proves nothing if
 * the contour was never there.
 *
 * performance.now() is pinned to a CONSTANT for the whole measurement, not to
 * whatever the clock read when the probe started: src/world/environment.js
 * drives a shader uniform off it, so pinning to wall-clock makes two runs of
 * this tool differ in the grass and no hash would ever match. Every scenario
 * is reached by a fixed number of fixed-length steps, so the state hashed is a
 * pure function of the code.
 *
 * Run once with the file as it shipped and once with the edit in place, and
 * diff the two outputs.
 *
 *   node tools/b5hash.mjs [--seeds 22,40] [--tag before]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,40').split(',').map(Number);
const TAG = flag('tag', 'run');
const DUMP = args.includes('--dump');
const PINNED = 1234567.0;
const DIR = path.join(ROOT, 'shots', 'pxid');

for (const SEED of SEEDS) {
  await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
    async ({ page }) => {
      const out = await page.evaluate(([pinned, dump]) => {
        const g = window.__game, p = g.player;
        const pool = g.effects.particles;
        const cv = g.renderer.domElement, w = cv.width, h = cv.height;
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const tc = tmp.getContext('2d');
        const grab = () => { g.renderOnce(); tc.drawImage(cv, 0, 0); return tc.getImageData(0, 0, w, h).data; };
        const real = performance.now.bind(performance);
        /* FNV-1a over the whole RGBA buffer, in two 32-bit halves so a
           collision needs both to agree. */
        const hash = (a) => {
          let h1 = 0x811c9dc5, h2 = 0x01000193;
          for (let i = 0; i < a.length; i++) {
            h1 ^= a[i]; h1 = Math.imul(h1, 0x01000193);
            h2 = Math.imul(h2 ^ a[i], 0x85ebca6b);
          }
          return ((h1 >>> 0).toString(16).padStart(8, '0')
            + (h2 >>> 0).toString(16).padStart(8, '0'));
        };

        const carParts = [];
        g.scene.traverse(o => { if (/^(shell|wheel\d)/.test(o.name)) carParts.push(o); });

        const rows = [];
        const station = (name) => {
          g.setPaused(true);
          performance.now = () => pinned;
          const shown = grab();
          g.pipeline.inkEnabled = false;
          const noink = grab();
          g.pipeline.inkEnabled = true;
          const was = carParts.map(o => o.visible);
          carParts.forEach(o => { o.visible = false; });
          const noCar = grab();
          carParts.forEach((o, i) => { o.visible = was[i]; });
          /* The drawing buffer is not preserved, so the shipping frame is
             rendered once more, still pinned, to be read out losslessly. */
          let png = null;
          if (dump) { g.renderOnce(); png = cv.toDataURL('image/png'); }
          performance.now = real;

          let carPx = 0, carInk = 0;
          for (let q = 0; q < shown.length; q += 4) {
            const dr = Math.abs(shown[q] - noCar[q]) + Math.abs(shown[q + 1] - noCar[q + 1])
              + Math.abs(shown[q + 2] - noCar[q + 2]);
            if (dr <= 12) continue;
            carPx++;
            const drop = (0.2126 * (noink[q] - shown[q]) + 0.7152 * (noink[q + 1] - shown[q + 1])
              + 0.0722 * (noink[q + 2] - shown[q + 2])) / 255;
            if (drop > 0.02) carInk++;
          }
          /* Live instances of every class, so "no burst on screen" is a
             recorded fact and not an assumption. dust>0 also records that a
             volumetric surface IS in frame, which is the other path the gate
             sits next to. */
          let burst = 0, dust = 0;
          for (let i = 0; i < pool.max; i++) {
            if (!pool.active[i]) continue;
            if (pool.kind[i] > 2.5) burst++; else dust++;
          }
          rows.push({
            name, burst, dust,
            ink: hash(shown), bare: hash(noink),
            carPx, carInk: +(carInk / Math.max(carPx, 1) * 100).toFixed(2),
            png,
          });
          g.setPaused(false);
        };

        g.setPaused(true);
        if (g.race?.entries) g.race.entries.length = 0;
        /* The page runs its own loop for however long it takes this evaluate
           to arrive, and those frames draw from the pool's RNG. That offset is
           wall-clock dependent, so without this two runs of the same build
           disagree on a couple of stations — which is indistinguishable from
           the edit having done something, and would make the whole table
           worthless. The pool is emptied and its stream re-seeded, so
           everything below is a pure function of the code. */
        for (let i = 0; i < pool.max; i++) {
          pool.active[i] = 0; pool.scales[i * 2] = pool.scales[i * 2 + 1] = 0;
        }
        pool.live = 0; pool.cursor = 0; pool._resetRandom();
        g.autopilot(true, 1.0);

        /* 1-2. Two places on the lap at racing speed, with the wheel veil
                running, which is the volumetric class in frame. */
        g.driveTo(0.42, { runUp: 420, maxSec: 60 });
        for (let k = 0; k < 90; k++) g.step(1 / 60);
        station('straight, racing speed, veil running');
        for (let k = 0; k < 60; k++) g.step(1 / 60);
        station('same, one second later');

        g.driveTo(0.15, { runUp: 420, maxSec: 60 });
        for (let k = 0; k < 60; k++) g.step(1 / 60);
        station('another quarter of the lap');

        /* 3. Stopped, so no dust at all: the pen with nothing volumetric in
              the frame anywhere. */
        g.autopilot(false);
        for (let k = 0; k < 360; k++) g.step(1 / 60);
        station('rolled to a stop, no dust in frame');

        /* 4-6. The ramp: the approach, the lip, and mid-flight. The landing is
                deliberately not sampled — that is the one frame allowed to
                change. */
        g.autopilot(true, 0.85);
        const r = g.track.ramps[Math.min(1, g.track.ramps.length - 1)];
        g.driveTo((r.pad0 - 90) / g.track.length, { runUp: 320, maxSec: 45 });
        station('90 m short of the ramp');
        let k2 = 0;
        while (k2++ < 900 && !p.airborne) g.step(1 / 60);
        station('the frame it leaves the lip');
        for (let f = 0; f < 12 && p.airborne; f++) g.step(1 / 60);
        station('mid-flight');

        /* 7. Off the road, where the surface class and the dust colour both
              change and the near landform fills the frame. */
        g.autopilot(true, 1.0);
        g.driveTo(0.70, { runUp: 420, maxSec: 60 });
        for (let k = 0; k < 150; k++) g.step(1 / 60);
        station('seven tenths of the lap');

        /* And one station where the burst IS on screen. This row is expected
           to differ between the two builds, and if it does not the whole table
           above is a table of hashes of something the edit cannot reach. */
        g.autopilot(true, 0.85);
        g.driveTo((r.pad0 - 60) / g.track.length, { runUp: 320, maxSec: 45 });
        let k3 = 0, wasAir = false;
        while (k3++ < 900) { g.step(1 / 60); if (p.airborne) wasAir = true; if (wasAir && !p.airborne) break; }
        for (let f = 0; f < 6; f++) g.step(1 / 60);
        station('SIGNAL CHECK — landing burst on screen');

        g.autopilot(false);
        return { seed: g.track.seed, rows };
      }, [PINNED, DUMP]);

      if (DUMP) {
        fs.mkdirSync(DIR, { recursive: true });
        out.rows.forEach((r, i) => {
          fs.writeFileSync(path.join(DIR, `${TAG}-s${out.seed}-${String(i).padStart(2, '0')}.png`),
            Buffer.from(r.png.split(',')[1], 'base64'));
        });
      }
      console.log(`\n  [${TAG}] seed ${out.seed} — composite buffer hashes, clock pinned to a constant`);
      console.log('   burst  dust   ink-on hash        pen-off hash       car px   ink on car   scenario');
      for (const r of out.rows) {
        console.log(`   ${String(r.burst).padStart(5)} ${String(r.dust).padStart(5)}`
          + `   ${r.ink}   ${r.bare}   ${String(r.carPx).padStart(6)}`
          + `   ${(r.carInk + '%').padStart(9)}   ${r.name}`);
      }
    });
}

finish(process.exitCode || 0);
