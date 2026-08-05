/* Round-4 critic's own capture. Native 1600x900 PNGs of the landing, frame by
 * frame from touchdown, with a matched burst-hidden control for every frame.
 *
 * Written rather than reused because the verdict is about what reaches the
 * screen, and every existing probe returns numbers. This returns pictures.
 *
 * Discipline carried over from the rounds that were burned by not having it:
 *   - the pool is emptied and re-seeded before the drive, because the page runs
 *     its own loop until evaluate() arrives and those frames draw from the
 *     particle RNG;
 *   - one throwaway render after the drive, because the first grab() after a
 *     long driveTo carries an edge artifact;
 *   - performance.now() is pinned to a synthetic 60 Hz clock, because
 *     src/world/environment.js drives a shader uniform off it inside
 *     onBeforeRender and an unpinned pair of renders of a static scene are
 *     genuinely different images.
 *
 *   node tools/x4shot.mjs --seed 22 --n 24 --out shots/x4-22
 */
import fs from 'node:fs';
import path from 'node:path';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', 22);
const RAMP = +flag('ramp', 1);
const N = +flag('n', 24);
const OUT = flag('out', `shots/x4-${SEED}`);
const PAIR = args.includes('--pair');
const PRE = +flag('pre', 0);          // frames captured BEFORE touchdown

fs.mkdirSync(OUT, { recursive: true });

await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
  async ({ page }) => {
    const info = await page.evaluate(([idx, pre]) => {
      const g = window.__game, p = g.player;
      const pool = g.effects.particles;
      g.setPaused(true);
      if (g.race?.entries) g.race.entries.length = 0;
      for (let i = 0; i < pool.max; i++) {
        pool.active[i] = 0; pool.scales[i * 2] = pool.scales[i * 2 + 1] = 0;
      }
      pool.live = 0; pool.cursor = 0; pool._resetRandom();

      const r = g.track.ramps[Math.min(idx, g.track.ramps.length - 1)];
      g.autopilot(true, 0.85);
      g.driveTo((r.pad0 - 60) / g.track.length, { runUp: 320, maxSec: 45 });
      let k = 0, wasAir = false;
      const hist = [];
      while (k++ < 900) {
        g.step(1 / 60);
        if (p.airborne) wasAir = true;
        if (wasAir && !p.airborne) break;
      }
      g.setPaused(true);
      /* Rewind is not available, so `pre` is spent by stepping the world on
         from touchdown is impossible — instead the caller asks for pre=0 and
         gets the landing frame first. Kept for the signature only. */
      window.__x4 = {
        t0: performance.now(),
        f: 0,
        real: performance.now.bind(performance),
        pool,
      };
      /* Throwaway: the first render after the drive carries the artifact. */
      g.renderOnce();
      return { seed: g.track.seed, lip: r.lip, kmh: Math.round(p.speed * 3.6), pre };
    }, [RAMP, PRE]);

    console.log(`  seed ${info.seed}, ramp lip ${info.lip}, touchdown at ${info.kmh} km/h`);

    const dump = async (hideBurst) => await page.evaluate((hide) => {
      const g = window.__game, s = window.__x4, pool = s.pool;
      const t = s.t0 + s.f * (1000 / 60);
      performance.now = () => t;
      let kept = null;
      if (hide) {
        kept = [];
        for (let i = 0; i < pool.max; i++) {
          if (pool.kind[i] < 4.5) continue;
          kept.push([i, pool.scales[i * 2], pool.scales[i * 2 + 1]]);
          pool.scales[i * 2] = pool.scales[i * 2 + 1] = 0;
        }
        pool.scaleAttr.needsUpdate = true;
      }
      g.renderOnce();
      const url = g.renderer.domElement.toDataURL('image/png');
      if (kept) {
        for (const [i, sx, sy] of kept) { pool.scales[i * 2] = sx; pool.scales[i * 2 + 1] = sy; }
        pool.scaleAttr.needsUpdate = true;
      }
      performance.now = s.real;
      return url;
    }, hideBurst);

    const write = (url, file) =>
      fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));

    for (let f = 0; f < N; f++) {
      write(await dump(false), path.join(OUT, `f${String(f).padStart(2, '0')}.png`));
      if (PAIR) write(await dump(true), path.join(OUT, `f${String(f).padStart(2, '0')}-no.png`));
      await page.evaluate(() => {
        const g = window.__game, s = window.__x4;
        s.f++;
        g.setPaused(false);
        g.step(1 / 60);
        g.setPaused(true);
      });
    }
    console.log(`  wrote ${N}${PAIR ? ' pairs of' : ''} frames to ${OUT}`);
  });

finish(process.exitCode || 0);
