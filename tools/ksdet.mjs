/* Is a lap on autopilot reproducible frame for frame?
 *
 * tools/kslap.mjs measures the lap once and then re-drives it to capture the
 * densest moments, which only works if the same number of steps from the same
 * start lands in the same place. The first run of it was 118 m out after 2475
 * frames, so this asks what breaks it: two bare re-drives against each other,
 * then a re-drive with a render every 15 frames, then one with the clock
 * pinned across those renders.
 *
 *   node tools/ksdet.mjs [--seed 22] [--frames 2475]
 */
import { run } from './harness.mjs';
import { freeze } from './kssnap.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const FRAMES = Number(flag('frames', '2475'));

const snap = await freeze();

await run({
  width: 1600, height: 900,
  url: `${snap.base}/#manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(1_200_000);
  const out = await page.evaluate((F) => {
    const g = window.__game;
    let threw = 0;
    const step = dt => { try { g.step(dt); } catch (e) { threw++; } };
    const start = () => {
      g.setPaused(true); g.goTo(0.0005); g.autopilot(true, 0.85); g.warp(0.5);
    };
    const drive = (mode) => {
      start();
      const marks = [];
      for (let i = 1; i <= F; i++) {
        step(1 / 60);
        if (mode === 'render' && i % 15 === 0) { g.renderOnce(); g.renderOnce(); }
        if (mode === 'pinned' && i % 15 === 0) {
          const real = performance.now.bind(performance);
          const p = real(); performance.now = () => p;
          g.renderOnce(); g.renderOnce();
          performance.now = real;
        }
        if (i % 300 === 0) marks.push(+g.player.s.toFixed(2));
      }
      return { s: +g.player.s.toFixed(2), kmh: +g.player.kmh.toFixed(2), marks };
    };
    const a = drive('bare');
    const b = drive('bare');
    const c = drive('render');
    const d = drive('pinned');
    return { a, b, c, d, threw, hasRandom: typeof Math.random };
  }, FRAMES);

  const show = (k, r, ref) => console.log(`  ${k.padEnd(8)} s=${String(r.s).padStart(9)}`
    + `  kmh=${String(r.kmh).padStart(7)}`
    + (ref ? `   delta vs bare#1 = ${(r.s - ref.s).toFixed(2)} m` : '')
    + `\n           marks ${r.marks.join(' ')}`);
  console.log(`\n  ${FRAMES} frames, seed ${SEED}, step() threw ${out.threw}`);
  show('bare#1', out.a, null);
  show('bare#2', out.b, out.a);
  show('render', out.c, out.a);
  show('pinned', out.d, out.a);
  console.log();
});
snap.close();
finish(process.exitCode || 0);
