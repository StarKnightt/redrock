/* What the crowd costs on the frame timeline.
 *
 * The same argument tools/camfps.mjs makes: reported fps is worthless here,
 * because headless Chromium's compositor pins presentation to 60 Hz whatever
 * `cap=0` says. What matters on a 4060 is main-thread time inside the frame
 * callback and how much of the 16.67 ms budget is left, so that is what is
 * timed — with the crowd shown and hidden, alternating, so a thermal drift
 * over the run cannot be read as a cost.
 *
 * Driven past a crowd site rather than parked anywhere: the whole system is
 * one draw of one instanced mesh plus one more in the ink prepass, and both
 * of those only exist while the mesh is visible.
 *
 *   node tools/crowdperf.mjs [--seed 22] [--sec 5]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const SEC = +flag('sec', 5);

await run({
  width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page, gl }) => {
  const site = await page.evaluate(() => {
    const g = window.__game;
    const s = g.crowd?.sites || [];
    // The busiest site, which is the worst case and also the finish.
    let best = s[0];
    for (const c of s) {
      const n = c.groups.reduce((a, b) => a + b.n, 0);
      if (!best || n > best.groups.reduce((a, b) => a + b.n, 0)) best = c;
    }
    const raf = window.requestAnimationFrame.bind(window);
    window.__ms = [];
    window.requestAnimationFrame = cb => raf(ts => {
      const t0 = performance.now();
      cb(ts);
      window.__ms.push(performance.now() - t0);
    });
    return { s: best.s, n: best.groups.reduce((a, b) => a + b.n, 0), kind: best.kind };
  });

  const measure = async shown => page.evaluate(async ([shown, sec, s]) => {
    const g = window.__game;
    const mesh = g.scene.getObjectByName('crowd-figures');
    const rail = g.scene.getObjectByName('crowd-barriers');
    mesh.visible = shown;
    if (rail) rail.visible = shown;
    g.autopilot(true, 0.85);
    g.goTo(Math.max(0, s - 260) / g.track.length);
    g.setPaused(false);
    await new Promise(r => setTimeout(r, 1000));
    window.__ms.length = 0;
    const calls = [];
    const tick = setInterval(() => calls.push(g.pipeline.stats?.calls || 0), 100);
    await new Promise(r => setTimeout(r, sec * 1000));
    clearInterval(tick);
    const v = window.__ms.slice().sort((a, b) => a - b);
    return {
      n: v.length,
      med: v[v.length >> 1], p95: v[Math.floor(v.length * 0.95)],
      calls: Math.round(calls.reduce((a, b) => a + b, 0) / Math.max(calls.length, 1)),
    };
  }, [shown, SEC, site.s]);

  console.log(`\n  1600x900, high tier, AI driving past the ${site.kind} `
    + `(${site.n} figures)  —  ${gl.renderer}`);
  console.log('  main-thread ms inside the frame callback, budget 16.67 for 60 fps\n');
  console.log(`    ${'crowd'.padEnd(22)} ${'median'.padStart(8)} ${'p95'.padStart(8)}`
    + ` ${'draws'.padStart(7)}`);
  const runs = [['hidden', false], ['shown', true], ['hidden, repeat', false], ['shown, repeat', true]];
  const got = [];
  for (const [label, shown] of runs) {
    const r = await measure(shown);
    got.push({ label, shown, ...r });
    console.log(`    ${label.padEnd(22)} ${r.med.toFixed(2).padStart(8)}`
      + ` ${r.p95.toFixed(2).padStart(8)} ${String(r.calls).padStart(7)}   (${r.n} frames)`);
  }
  const mean = f => {
    const v = got.filter(f).map(x => x.med);
    return v.reduce((a, b) => a + b, 0) / v.length;
  };
  const on = mean(x => x.shown), off = mean(x => !x.shown);
  console.log(`\n  crowd costs ${(on - off).toFixed(3)} ms of the median frame `
    + `(${(100 * (on - off) / 16.67).toFixed(1)}% of the 60 fps budget)`);
  console.log();
  await page.evaluate(() => {
    const g = window.__game;
    for (const n of ['crowd-figures', 'crowd-barriers']) {
      const m = g.scene.getObjectByName(n);
      if (m) m.visible = true;
    }
  });
});

finish(process.exitCode || 0);
