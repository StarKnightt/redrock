/* Is there a frame hitch in the corners?
 *
 * "Lags ... like it goes up" has two readings and this checks the other one.
 * A stage average hides a spike, so this times simulation and render
 * separately on every frame of a full stage run and buckets the results by how
 * tight the road is at that moment. If corners cost more, it shows up as a
 * difference between the straight bucket and the hairpin bucket; if something
 * allocates or compiles mid-race, it shows up as an outlier with a location.
 *
 *   node tools/hitch.mjs [--secs 200]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SECS = +flag('secs', 200);

await run({ width: 1280, height: 720, hash: 'manual&seed=22' }, async ({ page }) => {
  const r = await page.evaluate(async (secs) => {
    const g = window.__game;
    const p = g.player;
    g.botInput = null;
    g.autopilot(true, 0.85);
    p.placeAt(34, 0); p.raceTime = 0; p.finished = false;
    g.setPaused(true);          // we drive the loop ourselves, at 60 Hz

    const H = 1 / 60;
    const rows = [];
    /* A few hundred frames of warm-up first: the first pass through any code
       path compiles it, and the first draw with a new material compiles a
       shader. Those are real costs but they are boot costs, and leaving them
       in the sample makes every run look like it hitches at the start line. */
    for (let i = 0; i < 240; i++) { g.step(H); g.pipeline.render(); }

    for (let i = 0; i < secs * 60 && !p.finished; i++) {
      const t0 = performance.now();
      g.step(H);
      const t1 = performance.now();
      g.pipeline.render();
      const t2 = performance.now();
      rows.push({
        s: p.s,
        curv: Math.abs(g.track.frameAt(p.s).curv),
        kmh: p.kmh,
        sim: t1 - t0,
        draw: t2 - t1,
      });
      // Let the GPU drain occasionally so the readback is not all queued work.
      if (i % 120 === 0) await new Promise(res => setTimeout(res, 0));
    }

    const pct = (a, q) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * q)];
    const stat = (list) => {
      const total = list.map(r => r.sim + r.draw);
      return {
        n: list.length,
        sim: +(list.reduce((a, b) => a + b.sim, 0) / list.length).toFixed(3),
        draw: +(list.reduce((a, b) => a + b.draw, 0) / list.length).toFixed(3),
        p50: +pct(total, 0.5).toFixed(3),
        p99: +pct(total, 0.99).toFixed(3),
        max: +Math.max(...total).toFixed(2),
      };
    };

    /* Straight, open corner, tight corner. The thresholds are the ones the
       stage stats already use to call something straight or tight. */
    const buckets = {
      straight: rows.filter(r => r.curv < 0.0015),
      easy: rows.filter(r => r.curv >= 0.0015 && r.curv < 0.012),
      tight: rows.filter(r => r.curv >= 0.012),
    };

    const all = rows.map(r => r.sim + r.draw);
    const thresh = pct(all, 0.5) * 3;
    const spikes = rows
      .map((r, i) => ({ ...r, total: r.sim + r.draw, i }))
      .filter(r => r.total > Math.max(thresh, 8))
      .sort((a, b) => b.total - a.total)
      .slice(0, 12)
      .map(r => ({
        s: +r.s.toFixed(0), curv: +r.curv.toFixed(4), kmh: +r.kmh.toFixed(0),
        sim: +r.sim.toFixed(2), draw: +r.draw.toFixed(2),
      }));

    return {
      overall: stat(rows),
      buckets: Object.fromEntries(Object.entries(buckets)
        .filter(([, v]) => v.length).map(([k, v]) => [k, stat(v)])),
      spikes,
      spikeCount: rows.filter(r => r.sim + r.draw > Math.max(thresh, 8)).length,
      finished: p.finished,
    };
  }, SECS);

  const line = (name, s) => console.log(
    `    ${name.padEnd(10)} ${String(s.n).padStart(6)} frames   ` +
    `sim ${String(s.sim).padStart(6)} ms   draw ${String(s.draw).padStart(6)} ms   ` +
    `p50 ${String(s.p50).padStart(6)}   p99 ${String(s.p99).padStart(6)}   max ${s.max}`);

  console.log(`\n  frame cost over a full stage (${r.finished ? 'finished' : 'timed out'})`);
  line('overall', r.overall);
  for (const [k, v] of Object.entries(r.buckets)) line(k, v);
  console.log('\n  (draw above is measured in a tight loop with nothing presenting, so the' +
    '\n   GPU queue backs up and the numbers are drain time, not frame time. The' +
    '\n   sim column is real, and it is what the curvature buckets are for.)');

  /* Real presented frames. The only honest way to answer "does it stutter in
     corners" is to let the page run its own loop at its own cap and look at
     the gaps between frames it actually put on screen. */
  const live = await page.evaluate(async (secs) => {
    const g = window.__game;
    g.setPaused(false);
    g.autopilot(true, 0.85);
    g.player.placeAt(34, 0);
    g.player.finished = false;

    const marks = [];
    let last = performance.now();
    await new Promise(done => {
      const tick = () => {
        const now = performance.now();
        marks.push({ dt: now - last, s: g.player.s, curv: Math.abs(g.track.frameAt(g.player.s).curv) });
        last = now;
        if (marks.length < secs * 60) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });

    const body = marks.slice(30);         // drop the first half second
    const sorted = body.map(m => m.dt).sort((a, b) => a - b);
    const q = f => +sorted[Math.floor(sorted.length * f)].toFixed(2);
    const bucket = (lo, hi) => {
      const b = body.filter(m => m.curv >= lo && m.curv < hi);
      if (!b.length) return null;
      const s = b.map(m => m.dt).sort((x, y) => x - y);
      return {
        n: b.length, p50: +s[Math.floor(s.length * 0.5)].toFixed(2),
        p99: +s[Math.floor(s.length * 0.99)].toFixed(2), max: +Math.max(...s).toFixed(1),
        over33: b.filter(m => m.dt > 33).length,
      };
    };
    return {
      frames: body.length, p50: q(0.5), p90: q(0.9), p99: q(0.99),
      max: +Math.max(...sorted).toFixed(1),
      over33: body.filter(m => m.dt > 33).length,
      over50: body.filter(m => m.dt > 50).length,
      straight: bucket(0, 0.0015), easy: bucket(0.0015, 0.012), tight: bucket(0.012, 9),
      worst: body.map((m, i) => ({ ...m, i })).sort((a, b) => b.dt - a.dt).slice(0, 6)
        .map(m => ({ dt: +m.dt.toFixed(1), s: +m.s.toFixed(0), curv: +m.curv.toFixed(4) })),
    };
  }, 25);

  console.log(`\n  live frames at the 60 fps cap — ${live.frames} presented frames`);
  console.log(`    p50 ${live.p50} ms   p90 ${live.p90} ms   p99 ${live.p99} ms   max ${live.max} ms`);
  console.log(`    frames over 33 ms (a dropped frame): ${live.over33}   over 50 ms: ${live.over50}`);
  for (const k of ['straight', 'easy', 'tight']) {
    const b = live[k];
    if (b) {
      console.log(`    ${k.padEnd(9)} ${String(b.n).padStart(5)} frames   ` +
        `p50 ${String(b.p50).padStart(6)}   p99 ${String(b.p99).padStart(6)}   ` +
        `max ${String(b.max).padStart(6)}   dropped ${b.over33}`);
    }
  }
  console.log('    worst: ' + live.worst.map(w => `${w.dt}ms@s${w.s}(curv ${w.curv})`).join('  '));

  console.log(`\n  frames over 3x median (or 8 ms) in the synthetic loop: ${r.spikeCount}`);
  for (const s of r.spikes.slice(0, 6)) {
    console.log(`    s=${String(s.s).padStart(5)}  curv ${String(s.curv).padStart(7)}  ` +
      `${String(s.kmh).padStart(4)} km/h   sim ${s.sim} ms  draw ${s.draw} ms`);
  }
});

finish(process.exitCode || 0);
