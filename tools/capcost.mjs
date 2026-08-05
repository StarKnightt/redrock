/* What a frame costs, and therefore what the cap is buying.
 *
 * The pacing fix (tools/vsync.mjs) turns the cap into something that actually
 * lands near its target, which makes the target worth arguing about: on a
 * 200 Hz panel a 60 fps cap now means 66.7 fps, and uncapping would mean 200.
 * The physics is fixed at 120 Hz either way, so the only thing more frames buy
 * is presentation — and the only thing they cost is the machine.
 *
 * Two measurements, because either alone is misleading:
 *
 *   cost   the wall time one frame's work takes, as the loop does it —
 *          step, render, HUD. Median and p95 over a few hundred frames at the
 *          real resolution and tier. This is CPU-side submit time and is a
 *          floor on the true cost, not the whole of it.
 *   rate   what the loop sustains with the cap off and nothing throttling it,
 *          which bounds the same thing from the other side: a loop that tops
 *          out at 140 fps cannot be handed 200 whatever the panel says.
 *
 * Together they give the busy fraction at each candidate rate, which is the
 * number the decision actually turns on.
 *
 *   node tools/capcost.mjs [--tier high] [--w 1920] [--h 1080] [--secs 3]
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const TIER = flag('tier', 'high');
const W = +flag('w', '1920');
const H = +flag('h', '1080');
const SECS = +flag('secs', '3');

/* The rates the decision is between, on the reported 200 Hz panel. */
const RATES = [50, 60, 66.67, 100, 200];

const out = {};

await run({
  width: W, height: H,
  hash: `manual&tier=${TIER}&seed=22&cap=0&hud=1`,
}, async ({ page }) => {
  const res = await page.evaluate(async ([secs, rates]) => {
    const g = window.__game;

    /* Somewhere representative rather than the start line: mid-stage, moving,
       with the field on the road and dust running, which is when the frame is
       at its most expensive. */
    g.setPaused(true);
    g.autopilot(true, 0.85);
    g.bot.wobble = 5;
    g.goTo(0.42);
    for (let i = 0; i < 120; i++) g.step(1 / 60);

    /* ---- cost: one frame's work, timed as the loop does it ------------ */
    const times = [], stepT = [], drawT = [];
    for (let i = 0; i < 300; i++) {
      const a = performance.now();
      g.step(1 / 60);
      const b = performance.now();
      g.renderOnce();
      if (g.hudOn) g.hud.draw();
      const c = performance.now();
      times.push(c - a); stepT.push(b - a); drawT.push(c - b);
    }
    /* GPU throughput, which is the number that matters and is not the same as
       submit time: WebGL commands return long before the GPU has run them.
       A whole batch is submitted and drained ONCE at the end, so the cost of
       the stall is paid a single time and divided away. Draining every frame
       instead measures a synchronous round trip through the driver — worth
       69 ms a frame here, which is 30x the truth and the first version of
       this tool reported it as the answer.
       The queue only holds a few frames, so past the first handful the driver
       back-pressures and the loop runs at exactly the rate the GPU retires
       work: throughput, which is what a frame rate is. */
    const gl = g.renderer.getContext();
    const px = new Uint8Array(4);
    const M = 240;
    g.renderOnce(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t0 = performance.now();
    for (let i = 0; i < M; i++) g.renderOnce();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const gpuFrame = (performance.now() - t0) / M;

    const pick = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * q)]; };

    /* What the real loop sustains with the cap off — which in headless is NOT
       a GPU limit. rAF here is driven by a virtual 60 Hz clock and not by a
       panel (tools/vsync.mjs measures the callback gap at 16.6 ms), so this
       can only ever report ~60 and is recorded to make that explicit rather
       than to be used as a ceiling. The throughput figure above is the one
       that bounds the frame rate. */
    g.autopilot(false);
    g.setPaused(false);
    g.fpsCap = 0;
    await new Promise(r => setTimeout(r, secs * 1000));
    const uncapped = g.fps;

    const cost = pick(times, 0.5);
    return {
      tier: g.tier, w: innerWidth, h: innerHeight,
      frameMed: cost, frameP95: pick(times, 0.95),
      stepMed: pick(stepT, 0.5), drawMed: pick(drawT, 0.5),
      gpuFrame, uncapped,
      load: rates.map(r => ({
        fps: r,
        busy: Math.min(1, gpuFrame * r / 1000),
        reachable: 1000 / r >= gpuFrame,
      })),
    };
  }, [SECS, RATES]);

  out.result = res;
  console.log(`\n  ${res.w}x${res.h}, tier ${res.tier}, mid-stage with the field on the road\n`);
  console.log(`  step (physics + field + fx)      ${res.stepMed.toFixed(2)} ms`);
  console.log(`  render + HUD, submit only        ${res.drawMed.toFixed(2)} ms`);
  console.log(`  whole frame, submit only         ${res.frameMed.toFixed(2)} ms median,`
    + ` ${res.frameP95.toFixed(2)} ms p95`);
  console.log(`  whole frame, GPU throughput      ${res.gpuFrame.toFixed(2)} ms   <- the real cost`);
  console.log(`  ceiling that implies             ${(1000 / res.gpuFrame).toFixed(0)} fps`);
  console.log(`  loop with cap off (headless rAF) ${res.uncapped.toFixed(1)} fps`
    + '  — a virtual 60 Hz clock, not a ceiling\n');
  console.log('  rate      frame budget   GPU busy    reachable');
  for (const l of res.load) {
    const bar = '#'.repeat(Math.round(l.busy * 24)).padEnd(24, '.');
    console.log(`  ${String(l.fps).padStart(6)} fps ${(1000 / l.fps).toFixed(1).padStart(9)} ms`
      + `   ${(l.busy * 100).toFixed(0).padStart(3)}%  ${bar}  ${l.reachable ? 'yes' : 'NO'}`);
  }
});

fs.mkdirSync(path.join(ROOT, 'shots'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'shots', 'capcost.json'), JSON.stringify(out, null, 1));
console.log('\n  → shots/capcost.json');
finish(process.exitCode || 0);
