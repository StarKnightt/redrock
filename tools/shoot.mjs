/* Capture the descent.
 *
 * The same viewpoints every run, so two builds can be put side by side and
 * actually compared: the start gate, the first fast sweeper, the early
 * hairpin, the exposed traverse, the mid-stage drop, the canyon floor and the
 * finish.
 *
 *   node tools/shoot.mjs [tag] [--t 0.02,0.5] [--w 1600] [--h 900]
 *                        [--js "g.camera.fov=30"] [--cpu] [--over]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = (args[0] && !args[0].startsWith('--')) ? args[0] : 'run';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const has = k => args.includes('--' + k);

const STOPS = flag('t', '0.01,0.13,0.28,0.44,0.60,0.76,0.92,0.995').split(',').map(Number);
const W = +flag('w', 1600), H = +flag('h', 900);
const JS = flag('js', '');

const outDir = path.join(ROOT, 'shots', tag);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const HASH = `manual&tier=${flag('tier', 'high')}&seed=${flag('seed', 22)}&cap=${flag('cap', 60)}`
  + `&ink=${flag('ink', 1)}`;

await run({ width: W, height: H, hash: HASH }, async ({ page, errs, gl }) => {
  if (JS) await page.evaluate(js => new Function('g', js)(window.__game), JS);

  const results = [];

  if (has('over')) {
    /* One look at the whole basin from above. The single most useful frame
       when the question is "is this stage a shape or a scribble". */
    await page.evaluate(() => window.__game.overview());
    await page.waitForTimeout(160);
    await capture(page, path.join(outDir, 'overview.png'));
    const box = await page.evaluate(() => {
      const t = window.__game.track;
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (const f of t.frames) {
        x0 = Math.min(x0, f.pos.x); x1 = Math.max(x1, f.pos.x);
        z0 = Math.min(z0, f.pos.z); z1 = Math.max(z1, f.pos.z);
      }
      return { spanX: Math.round(x1 - x0), spanZ: Math.round(z1 - z0) };
    });
    console.log(`  overview   basin ${box.spanX} x ${box.spanZ} m`);
    // Every later stop is a chase shot; put the camera back the way it was.
    await page.evaluate(() => { window.__game.camera.up.set(0, 1, 0); window.__game.camera.far = 4000; });
  }

  const view = has('top') ? 'top' : has('hero') ? 'hero' : 'chase';
  if (view !== 'chase') await page.evaluate(v => window.__game.setView(v), view);

  for (const t of STOPS) {
    /* Drive in rather than teleport. A parked car shows none of the dust,
       drift or speed response the shot is meant to be judging. --parked is
       kept for geometry work, where a still car is easier to compare. */
    await page.evaluate(([t, parked]) => {
      const g = window.__game;
      if (parked) { g.goTo(t); g.warp(1.2); } else g.driveTo(t);
    }, [t, has('parked')]);
    await page.waitForTimeout(140);
    const st = await page.evaluate(() => {
      const g = window.__game;
      const p = g.camera.position;
      return { fps: +g.fps.toFixed(1), pos: [+p.x.toFixed(0), +p.y.toFixed(1), +p.z.toFixed(0)], ...g.info() };
    });
    const file = path.join(outDir, `${String(Math.round(t * 100)).padStart(3, '0')}.png`);
    await capture(page, file);
    results.push({ t, file: path.basename(file), ...st });
    console.log(`  t=${t.toFixed(3)}  y=${st.pos[1]}  calls=${String(st.calls).padStart(4)}  tris=${(st.triangles / 1000).toFixed(0)}k`);
  }

  const perf = await page.evaluate(async () => {
    const g = window.__game;
    g.setPaused(false);
    await new Promise(r => setTimeout(r, 2200));
    return { fps: +g.fps.toFixed(1), cap: g.fpsCap };
  });
  const meta = await page.evaluate(() => window.__game.info());
  console.log(`\n  stage: ${meta.len} m, ${meta.drop} m drop`);
  console.log(`  steady: ${perf.fps} fps (cap ${perf.cap})  ${gl.renderer}`);

  fs.writeFileSync(path.join(outDir, 'report.json'),
    JSON.stringify({ tag, gl, perf, meta, results, errors: errs }, null, 2));
  console.log(`  → shots/${tag}`);
});

finish(process.exitCode || 0);
