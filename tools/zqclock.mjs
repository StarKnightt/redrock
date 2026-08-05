/* Is the point-mass speed model worth spending seconds on?
 *
 * D3 converts the crowd's spacing constant from metres to seconds, and the
 * seconds come from the cornering-limited speed model tools/crowdaudit.mjs
 * carries. That model has never been checked against the car. If it runs
 * fast or slow by a constant it is harmless — the thresholds absorb it — but
 * if it runs fast on the straights and slow through the switchbacks then a
 * spacing quoted in its seconds is the pinned-partner bug all over again:
 * two quantities agreeing at the tuning point and diverging everywhere else,
 * which is exactly the defect D3 is supposed to be fixing.
 *
 * So: drive a lap on autopilot, log the real speed against station, and hold
 * the model beside it — overall, and separately over the slow third and the
 * fast third, which is where a shape error would show.
 *
 *   node tools/zqclock.mjs [--seeds 22,1,40]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');

for (const SEED of SEEDS) {
  await run({
    width: 640, height: 360,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    page.setDefaultTimeout(600_000);
    const out = await page.evaluate(() => {
      const g = window.__game;
      const t = g.track;
      const L = t.length;

      const speedAt = (s) => {
        let peak = 0;
        for (let d = -20; d <= 40; d += 5) {
          const c = t.frameAt(Math.max(0, Math.min(L, s + d))).curv;
          if (Math.abs(c) > Math.abs(peak)) peak = c;
        }
        const R = 1 / Math.max(Math.abs(peak), 1e-4);
        return Math.min(Math.sqrt(0.86 * 9.81 * Math.min(R, 900)), 52);
      };

      // Model lap: integrate ds / v at 5 m.
      let modelLap = 0;
      for (let s = 5; s <= L; s += 5) modelLap += 5 / (0.5 * (speedAt(s - 5) + speedAt(s)));

      /* The same cornering ceiling with a longitudinal limit on top: a car
         cannot be at the hairpin speed one metre before the hairpin, and the
         approach and the exit are where the lap time actually goes. Backward
         pass for braking, forward pass for drive. */
      const DS = 5;
      const N = Math.ceil(L / DS) + 1;
      const ceil = new Float64Array(N);
      for (let i = 0; i < N; i++) ceil[i] = speedAt(i * DS);
      const paced = (aDrive, aBrake) => {
        const v = ceil.slice();
        for (let i = N - 2; i >= 0; i--) {
          v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * aBrake * DS));
        }
        for (let i = 1; i < N; i++) {
          v[i] = Math.min(v[i], Math.sqrt(v[i - 1] * v[i - 1] + 2 * aDrive * DS));
        }
        let lap = 0;
        for (let i = 1; i < N; i++) lap += DS / (0.5 * (v[i - 1] + v[i]));
        return { lap, v };
      };
      const sweep = [];
      for (const aD of [2.5, 3, 3.5, 4, 5]) {
        for (const aB of [4, 6, 8, 12]) {
          sweep.push({ aD, aB, lap: +paced(aD, aB).lap.toFixed(1) });
        }
      }

      /* The residual is not in the longitudinal limit, it is in the ceiling:
         0.86 g and a 52 m/s cap are both quicker than this autopilot drives.
         Sweep the ceiling too, and report the pair that lands the lap. */
      const grip = [];
      for (const G of [0.42, 0.48, 0.52, 0.56, 0.62, 0.7]) {
        for (const CAP of [40, 44, 47, 52]) {
          for (let i = 0; i < N; i++) {
            let peak = 0;
            const s = i * DS;
            for (let d = -20; d <= 40; d += 5) {
              const c = t.frameAt(Math.max(0, Math.min(L, s + d))).curv;
              if (Math.abs(c) > Math.abs(peak)) peak = c;
            }
            const R = 1 / Math.max(Math.abs(peak), 1e-4);
            ceil[i] = Math.min(Math.sqrt(G * 9.81 * Math.min(R, 900)), CAP);
          }
          const p = paced(3, 6);
          // Speed shape at the same 25 m bins, against the real trace.
          grip.push({ G, CAP, lap: +p.lap.toFixed(1), v: p.v });
        }
      }

      // Real lap, and the real speed sampled onto a 25 m ladder.
      g.setPaused(true);
      g.goTo(0.0005);
      g.autopilot(true, 0.85);
      g.warp(0.5);
      const BIN = 25;
      const nb = Math.ceil(L / BIN);
      const sum = new Float64Array(nb), cnt = new Float64Array(nb);
      let frames = 0;
      while (g.player.s < L - 3 && frames < 60 * 60 * 8) {
        g.step(1 / 60); frames++;
        const b = Math.min(nb - 1, Math.floor(g.player.s / BIN));
        sum[b] += g.player.speed ?? (g.player.kmh / 3.6); cnt[b]++;
      }
      const realLap = frames / 60;
      g.autopilot(false);

      const pairs = [];
      for (let b = 0; b < nb; b++) {
        if (!cnt[b]) continue;
        pairs.push({ s: b * BIN + BIN / 2, real: sum[b] / cnt[b], model: speedAt(b * BIN + BIN / 2) });
      }
      const band = (a, b) => {
        const p = pairs.filter(q => q.s >= a && q.s < b);
        const rm = p.reduce((x, q) => x + q.real, 0) / p.length;
        const mm = p.reduce((x, q) => x + q.model, 0) / p.length;
        return { n: p.length, real: rm, model: mm, ratio: mm / rm };
      };
      // Slow third and fast third by the REAL speed, not by station.
      const bySpeed = pairs.slice().sort((a, b) => a.real - b.real);
      const third = Math.max(1, Math.floor(pairs.length / 3));
      const grp = arr => ({
        real: arr.reduce((x, q) => x + q.real, 0) / arr.length,
        model: arr.reduce((x, q) => x + q.model, 0) / arr.length,
      });
      const slow = grp(bySpeed.slice(0, third));
      const fast = grp(bySpeed.slice(-third));

      /* Lap time is one number and can be hit by two wrongs cancelling, so
         score the ceiling sweep on the speed CURVE as well: mean absolute
         error against the real per-bin speed. */
      const scored = grip.map(q => {
        let e = 0, n = 0;
        for (let b = 0; b < nb; b++) {
          if (!cnt[b]) continue;
          const s = b * BIN + BIN / 2;
          const i = Math.min(N - 1, Math.round(s / DS));
          e += Math.abs(q.v[i] - sum[b] / cnt[b]); n++;
        }
        return { G: q.G, CAP: q.CAP, lap: q.lap, mae: +(e / n).toFixed(2) };
      });

      return {
        grip: scored.sort((a, b) => a.mae - b.mae).slice(0, 8),
        sweep,
        L: +L.toFixed(0), modelLap: +modelLap.toFixed(1), realLap: +realLap.toFixed(1),
        thirds: [band(0, L / 3), band(L / 3, 2 * L / 3), band(2 * L / 3, L)],
        slow: { real: +slow.real.toFixed(1), model: +slow.model.toFixed(1), ratio: +(slow.model / slow.real).toFixed(2) },
        fast: { real: +fast.real.toFixed(1), model: +fast.model.toFixed(1), ratio: +(fast.model / fast.real).toFixed(2) },
      };
    });

    console.log(`\n══ seed ${SEED}  (${out.L} m)`);
    console.log(`   lap:  model ${out.modelLap} s   real ${out.realLap} s`
      + `   model runs ${(100 * (out.realLap / out.modelLap - 1)).toFixed(0)}% quick`
      + `   (real / model = ${(out.realLap / out.modelLap).toFixed(2)})`);
    out.thirds.forEach((b, i) => console.log(
      `   third ${i + 1}:  real ${b.real.toFixed(1)} m/s   model ${b.model.toFixed(1)} m/s`
      + `   ratio ${b.ratio.toFixed(2)}`));
    console.log(`   slowest third of the road by real speed:  real ${out.slow.real} m/s`
      + `  model ${out.slow.model}  ratio ${out.slow.ratio}`);
    console.log(`   fastest third of the road by real speed:  real ${out.fast.real} m/s`
      + `  model ${out.fast.model}  ratio ${out.fast.ratio}`);
    console.log(`   SHAPE ERROR (fast ratio / slow ratio): `
      + `${(out.fast.ratio / out.slow.ratio).toFixed(2)}  — 1.00 is a pure scale factor`);
    console.log('   with a longitudinal limit — lap time, and error against the real lap:');
    const byErr = out.sweep.slice().sort((a, b) =>
      Math.abs(a.lap - out.realLap) - Math.abs(b.lap - out.realLap));
    for (const q of byErr.slice(0, 6)) {
      console.log(`      drive ${q.aD} m/s², brake ${q.aB} m/s²  →  ${String(q.lap).padStart(6)} s`
        + `   ${((100 * (q.lap / out.realLap - 1))).toFixed(1).padStart(6)}%`);
    }
    console.log('   ceiling sweep at drive 3 / brake 6, best by speed-curve error:');
    for (const q of out.grip) {
      console.log(`      grip ${q.G} g, cap ${q.CAP} m/s  →  lap ${String(q.lap).padStart(6)} s`
        + `  (${((100 * (q.lap / out.realLap - 1))).toFixed(1).padStart(6)}%)`
        + `   mean speed error ${q.mae} m/s`);
    }
  });
}
console.log();
finish(process.exitCode || 0);
