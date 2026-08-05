/* What the chase camera costs on the frame timeline.
 *
 * Reported fps is not the measurement here: headless Chromium's compositor
 * pins presentation to the display's 60 Hz whatever `cap=0` says, so fps sits
 * at 60 for every configuration and tells you nothing. What matters on a 4060
 * is main-thread time inside the frame callback, and how much of the 16.67 ms
 * budget is left, so that is what is measured — by timing the animation
 * callback itself rather than the interval between callbacks.
 *
 *   node tools/camfps.mjs [--sec 6] [--t 0.55]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEC = +flag('sec', 6);
const T = +flag('t', 0.55);

await run({ width: 1920, height: 1080, hash: 'manual&tier=high&seed=22&cap=0' }, async ({ page, gl }) => {
  await page.evaluate(t => {
    const g = window.__game;
    g.autopilot(true, 0.85);
    g.goTo(t);
    /* Time spent inside the frame callback, which is every piece of
       main-thread work the game does in a frame. */
    const raf = window.requestAnimationFrame.bind(window);
    window.__ms = [];
    window.requestAnimationFrame = cb => raf(ts => {
      const t0 = performance.now();
      cb(ts);
      window.__ms.push(performance.now() - t0);
    });
  }, T);

  const measure = async (collide, lag) => page.evaluate(async ([collide, lag, sec]) => {
    const g = window.__game;
    g.chase.collideEnabled = collide;
    g.chase.yawLagEnabled = lag;
    g.setPaused(false);
    await new Promise(r => setTimeout(r, 1200));
    window.__ms.length = 0;
    await new Promise(r => setTimeout(r, sec * 1000));
    const v = window.__ms.slice().sort((a, b) => a - b);
    return {
      fps: +g.fps.toFixed(1), n: v.length,
      med: v[v.length >> 1], p95: v[Math.floor(v.length * 0.95)], max: v[v.length - 1],
    };
  }, [collide, lag, SEC]);

  console.log(`\n  1920x1080, high tier, AI driving  —  ${gl.renderer}`);
  console.log(`  main-thread milliseconds inside the frame callback, budget 16.67 for 60 fps\n`);
  console.log(`    ${'configuration'.padEnd(26)} ${'fps'.padStart(6)} ${'median'.padStart(8)} ${'p95'.padStart(8)} ${'max'.padStart(8)}`);
  const rows = [
    ['neither', false, false],
    ['occlusion only', true, false],
    ['yaw lag only', false, true],
    ['both (shipped)', true, true],
    ['both (shipped), repeat', true, true],
  ];
  for (const [label, c, l] of rows) {
    const r = await measure(c, l);
    console.log(`    ${label.padEnd(26)} ${r.fps.toFixed(1).padStart(6)} ${r.med.toFixed(2).padStart(8)}`
      + ` ${r.p95.toFixed(2).padStart(8)} ${r.max.toFixed(2).padStart(8)}   (${r.n} frames)`);
  }
  await page.evaluate(() => { window.__game.chase.collideEnabled = true; window.__game.chase.yawLagEnabled = true; });
});

finish(process.exitCode || 0);
