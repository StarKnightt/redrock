/* Paired before/after captures of the chase camera, from identical state.
 *
 * Two shoot.mjs runs are not a fair comparison: the AI takes a slightly
 * different line every session, so half of any difference in the frame is the
 * car being somewhere else. Here each stop is driven once and photographed
 * twice — the occlusion test is a post-process on an unchanged camera, so
 * turning it off and re-running update with dt = 0 reproduces exactly the
 * frame the old build would have made, with the car in the same place.
 *
 *   node tools/campair.mjs [--t 0.01,...] [--w 1024] [--h 576]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const tag = flag('tag', 'camfix');
const STOPS = flag('t', '0.01,0.28,0.44,0.60,0.76,0.7773,0.92,0.9298,0.9895,0.995').split(',').map(Number);
const W = +flag('w', 1024), H = +flag('h', 576);

const outDir = path.join(ROOT, 'shots', tag);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'before'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'after'), { recursive: true });

await run({ width: W, height: H, hash: 'manual&tier=high&seed=22&cap=60&ink=1' }, async ({ page, errs, gl }) => {
  const rows = [];
  for (const t of STOPS) {
    const name = `${String(Math.round(t * 10000)).padStart(5, '0')}.png`;

    const after = await page.evaluate(t => {
      const g = window.__game;
      g.driveTo(t);
      /* capture() pauses, renders and un-pauses, and an un-paused frame
         between the two shots would move the car. Freeze the world and make
         setPaused a no-op so the pair really is the same instant. */
      g.paused = true;
      g.__setPaused = g.setPaused;
      g.setPaused = () => {};
      g.chase.collideEnabled = true;
      g.chase.update(g.player, 0, {});
      const c = g.camera.position;
      return { s: +g.player.s.toFixed(1), occl: +g.chase.occl.toFixed(3), y: +c.y.toFixed(2), pos: [c.x, c.y, c.z] };
    }, t);
    await capture(page, path.join(outDir, 'after', name));

    const before = await page.evaluate(() => {
      const g = window.__game;
      g.chase.collideEnabled = false;
      g.chase.update(g.player, 0, {});
      const c = g.camera.position;
      return { y: +c.y.toFixed(2), pos: [c.x, c.y, c.z] };
    });
    await capture(page, path.join(outDir, 'before', name));
    await page.evaluate(() => {
      const g = window.__game;
      g.chase.collideEnabled = true;
      g.setPaused = g.__setPaused;
      g.setPaused(false);
    });

    const moved = Math.hypot(
      after.pos[0] - before.pos[0], after.pos[1] - before.pos[1], after.pos[2] - before.pos[2]);
    rows.push({ t, file: name, s: after.s, occl: after.occl, moved: +moved.toFixed(3) });
    console.log(`  t=${t.toFixed(4)}  s=${String(after.s).padStart(6)}  boom ${(after.occl * 100).toFixed(0).padStart(3)}%  `
      + `lens moved ${moved.toFixed(2)} m${moved > 0.01 ? '  ← the fix acted here' : ''}`);
  }

  const perf = await page.evaluate(async () => {
    const g = window.__game;
    g.setPaused(false);
    await new Promise(r => setTimeout(r, 2500));
    return { fps: +g.fps.toFixed(1), cap: g.fpsCap };
  });
  console.log(`\n  steady: ${perf.fps} fps (cap ${perf.cap})  ${gl.renderer}`);
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ tag, gl, perf, rows, errors: errs }, null, 2));
  console.log(`  → shots/${tag}/{before,after}`);
});

finish(process.exitCode || 0);
