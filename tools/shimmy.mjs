/* Does the car vibrate on screen, and at what frequency and amplitude?
 *
 * Every other instrument in tools/ drives the game with `g.step(1/60)`. That
 * is the one frame time at which the simulation clock in main.js is exact:
 * 1/60 is two whole 1/120 substeps, halving is exact in binary, and the
 * accumulator lands on zero every frame. So the entire suite is blind to what
 * the accumulator does at any OTHER frame time — which is every frame time a
 * real browser on a real panel actually produces.
 *
 * This tool drives the same loop with realistic wall-clock frame sequences and
 * measures what the PLAYER SEES: the car's position in camera space, frame by
 * frame. Not the car's world position — the car and the camera are on two
 * different clocks (the cars advance by `ran`, a whole number of substeps; the
 * camera advances by the frame's wall `dt`) and it is the difference between
 * them that lands on the screen.
 *
 * The statistic is the second difference of the on-screen position. Smooth
 * motion of any speed, on any curve, has a second difference near zero.
 * Motion that alternates between two step sizes has a large one that changes
 * sign every frame, and the sign-flip rate says the frequency directly.
 *
 *   node tools/shimmy.mjs [--seed 22] [--secs 12] [--rows 0]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', '22');
const SECS = +flag('secs', '12');
const ROWS = +flag('rows', '0');
/* Reproduce the behaviour before the render phase existed, for the A/B.
   Forcing alpha to zero is exactly it and not an approximation of it: at
   alpha zero applyTo writes renderPos = pos, so the mesh is drawn on the
   simulation clock and the camera, which follows renderPos, follows the
   simulation clock with it. */
const RAW = args.includes('--raw');

/* The frame sequences worth testing, as (name, generator of dt in seconds).
 *
 * `cap60` is what main.js does by default: it drops rAF ticks until 15.47 ms
 * have passed. On a 60 Hz panel every tick survives and dt is ~16.67 ms. On a
 * 144 Hz panel two ticks (13.9 ms) are short and three (20.8 ms) are not, so
 * the cap emits 48 fps — and 20.833 ms is 2.5 substeps exactly. */
const CASES = [
  ['tool 1/60 exact', () => 1 / 60],
  ['60 Hz panel, real jitter', i => 1 / 60 + (Math.sin(i * 2.399) + Math.sin(i * 5.71)) * 0.00018],
  /* What the cap used to deliver, kept so the rows do not move under the
     pacing fix — the frame time is the input to this measurement and these
     are the ones the earlier round was scored on. */
  ['144 Hz, OLD cap (48 fps)', () => 1 / 48],
  ['200 Hz, OLD cap (50 fps)', () => 4 / 200],
  ['165 Hz, OLD cap (55 fps)', () => 3 / 165],
  /* And what it delivers now (tools/vsync.mjs). Changing which frames run a
     substep changes the alpha distribution, so every one of these is a frame
     time the extrapolation had not previously been scored at. */
  ['200 Hz, NEW cap (66.7 fps)', () => 3 / 200],
  ['144 Hz, NEW cap (72 fps)', () => 2 / 144],
  ['100 Hz, NEW cap (50 fps)', () => 2 / 100],
  ['75 Hz, NEW cap (75 fps)', () => 1 / 75],
  ['144 Hz uncapped', () => 1 / 144],
  ['200 Hz uncapped', () => 1 / 200],
  ['120 Hz uncapped', () => 1 / 120],
];

const out = {};

const raw = RAW;
await run({
  width: 640, height: 360,
  hash: `manual&tier=low&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  console.log(raw ? '\n  [--raw] render phase disabled — the old behaviour.' : '');
  const res = await page.evaluate(async ([secs, cases, rowsWanted, raw]) => {
    const g = window.__game;
    const p = g.player;
    const THREE = g.THREE;

    /* Count substeps per frame without touching main.js: every Car.step is
       one substep, and the player's are the ones the accumulator gates. */
    const Car = p.constructor;
    const rawStep = Car.prototype.step;
    let subN = 0;
    /* The car's own trajectory at full substep resolution. This is the truth
       the drawn pose is graded against: it is what the simulation actually
       did, sampled 120 times a second, and it exists independently of how
       any frame happened to land on it. */
    let truth = [], simT = 0;
    Car.prototype.step = function (dt, input) {
      rawStep.call(this, dt, input);
      if (this !== p) return;
      subN++; simT += dt;
      truth.push(simT, this.pos.x, this.pos.y, this.pos.z);
    };

    const rawApply = Car.prototype.applyTo;
    if (raw) Car.prototype.applyTo = function (view) { rawApply.call(this, view, 0); };

    const results = [];
    const local = new THREE.Vector3();

    for (const [name, src] of cases) {
      /* Same start state for every case, so the cases are comparable. The
         bot supplies the pace; we are measuring the clock, not the driving. */
      g.setPaused(true);
      g.autopilot(true, 0.8);
      g.bot.wobble = 5;
      g.goTo(0.10);
      g.resetSimClock();
      const rivals = g.race ? g.race.cars : [];

      // Let the camera spring settle before anything is measured.
      for (let i = 0; i < 90; i++) g.step(1 / 60);
      truth = []; simT = 0;

      const fn = new Function('return (' + src + ')')();
      const rows = [];
      /* The scene graph, not the physics state. What reaches the screen is
         whatever applyTo last wrote onto the view root, and once anything
         interpolates those two stop being the same thing. */
      const proot = g.playerView.root;
      const rroot = g.race?.entries?.[0]?.view?.root || null;
      let t = 0, i = 0;
      while (t < secs && !p.finished) {
        subN = 0;
        const dt = fn(i);
        g.step(dt);
        t += dt; i++;
        g.camera.updateMatrixWorld(true);
        const row = {
          dt, n: subN, t,
          v: p.speed,
          // What is on the screen: the drawn car in the camera's own frame.
          cam: g.camera.worldToLocal(local.copy(proot.position)).toArray()
            .map(x => +x.toFixed(5)),
          // And the same for the nearest rival, to see whether it is common mode.
          riv: rroot
            ? g.camera.worldToLocal(local.copy(rroot.position)).toArray()
              .map(x => +x.toFixed(5))
            : null,
          // The drawn heading, so rotational shimmer can be told from linear.
          q: proot.quaternion.toArray().map(x => +x.toFixed(6)),
          // World-space step, for separating "the car moved oddly" from
          // "the camera and the car disagree".
          ws: proot.position.toArray().map(x => +x.toFixed(5)),
        };
        rows.push(row);
      }

      /* ---- statistics -------------------------------------------------
         Second difference of the on-screen position. Units are metres of
         camera-space displacement, which for a car about 7 m from the lens
         is very close to what the eye reads as movement. */
      const stat = key => {
        const seq = rows.map(r => (key === 'cam' ? r.cam : r.riv));
        if (!seq[0]) return null;
        let sum2 = 0, peak = 0, flips = 0, prevSign = 0, nn = 0;
        for (let k = 1; k < seq.length - 1; k++) {
          // Along the view axis, which is where longitudinal jitter lands.
          const d2 = seq[k + 1][2] - 2 * seq[k][2] + seq[k - 1][2];
          sum2 += d2 * d2; nn++;
          peak = Math.max(peak, Math.abs(d2));
          const s = Math.sign(d2);
          if (s && prevSign && s !== prevSign) flips++;
          if (s) prevSign = s;
        }
        const secsRan = rows[rows.length - 1].t - rows[0].t;
        /* Normalised by dt², which turns the second difference into an
           acceleration. A trajectory that is genuinely smooth gives the SAME
           number at every frame rate — the car is doing the same driving —
           so anything that rises as the frame time stops dividing the
           substep is aliasing and not driving. Without this the raw
           millimetres cannot be compared across the rows of this table at
           all: 20.8 ms frames carry 1.6x the second difference of 16.7 ms
           ones for no reason but their length. */
        const meanDt = secsRan / Math.max(rows.length - 1, 1);
        return {
          rms: Math.sqrt(sum2 / Math.max(nn, 1)),
          accel: Math.sqrt(sum2 / Math.max(nn, 1)) / (meanDt * meanDt),
          peak,
          // A sign change every frame is a jitter at half the frame rate.
          flipHz: flips / Math.max(secsRan, 1e-6) / 2,
          flipFrac: flips / Math.max(nn, 1),
        };
      };

      /* ---- the decisive one: drawn pose against the true trajectory ----
       *
       * At wall time T the car really is at truth(T). The renderer cannot
       * know that at the time — the simulation has only got as far as the
       * last whole substep — but this pass can, because it runs afterwards
       * with the whole record in hand.
       *
       * This is what separates the two candidate explanations completely. If
       * the car's own motion were oscillating, the error against its own
       * trajectory would be zero and the second differences above would be
       * real. If the trajectory is clean and only the sampling of it is
       * uneven, the error is exactly the judder, in millimetres, with no
       * driving content in it at all — a straight, a hairpin and a kerb
       * strike all read zero if they are drawn at the right moment. */
      const trueAt = T => {
        let lo = 0, hi = truth.length / 4 - 1;
        if (hi < 1) return null;
        while (lo < hi - 1) {
          const mid = (lo + hi) >> 1;
          if (truth[mid * 4] <= T) lo = mid; else hi = mid;
        }
        const t0 = truth[lo * 4], t1 = truth[hi * 4];
        const u = t1 > t0 ? (T - t0) / (t1 - t0) : 0;
        return [
          truth[lo * 4 + 1] + (truth[hi * 4 + 1] - truth[lo * 4 + 1]) * u,
          truth[lo * 4 + 2] + (truth[hi * 4 + 2] - truth[lo * 4 + 2]) * u,
          truth[lo * 4 + 3] + (truth[hi * 4 + 3] - truth[lo * 4 + 3]) * u,
        ];
      };
      let lagSum = 0, lagPeak = 0, lagN = 0;
      for (const r of rows) {
        const tr = trueAt(r.t);
        if (!tr || r.t > truth[truth.length - 4]) continue;
        const e = Math.hypot(r.ws[0] - tr[0], r.ws[1] - tr[1], r.ws[2] - tr[2]);
        lagSum += e; lagPeak = Math.max(lagPeak, e); lagN++;
      }
      const lagMean = lagSum / Math.max(lagN, 1);

      /* Rotational shimmer, so it can be told apart from linear. The angle
         swept between consecutive drawn frames should be smooth; the metric
         is how much that per-frame angle jumps about, in degrees. */
      let rotRms = 0, rotPeak = 0, rn = 0;
      const ang = (a, b) => {
        const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
        return 2 * Math.acos(Math.min(1, d));
      };
      for (let k = 1; k < rows.length - 1; k++) {
        const d = ang(rows[k].q, rows[k + 1].q) - ang(rows[k - 1].q, rows[k].q);
        rotRms += d * d; rotPeak = Math.max(rotPeak, Math.abs(d)); rn++;
      }
      rotRms = Math.sqrt(rotRms / Math.max(rn, 1)) * 180 / Math.PI;
      rotPeak = rotPeak * 180 / Math.PI;

      /* World-space per-frame travel, normalised by the frame's own dt. A
         car moving smoothly covers dt·v every frame whatever dt is; a car on
         a quantised clock covers n·SUBSTEP·v. This separates the two. */
      let travelErrMax = 0, travelErrSum = 0, tn = 0;
      for (let k = 1; k < rows.length; k++) {
        const a = rows[k - 1].ws, b = rows[k].ws;
        const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        const want = rows[k].dt * rows[k].v;
        if (want > 0.05) {
          const e = Math.abs(d - want);
          travelErrMax = Math.max(travelErrMax, e);
          travelErrSum += e; tn++;
        }
      }

      const counts = {};
      for (const r of rows) counts[r.n] = (counts[r.n] || 0) + 1;

      results.push({
        name, frames: rows.length,
        fps: +(rows.length / (rows[rows.length - 1].t - rows[0].t)).toFixed(1),
        meanV: +(rows.reduce((a, r) => a + r.v, 0) / rows.length).toFixed(1),
        subCounts: counts,
        player: stat('cam'), rival: stat('riv'),
        rotRms: +rotRms.toFixed(4), rotPeak: +rotPeak.toFixed(4),
        lagMean: +lagMean.toFixed(5), lagPeak: +lagPeak.toFixed(5),
        travelErrMax: +travelErrMax.toFixed(4),
        travelErrMean: +(travelErrSum / Math.max(tn, 1)).toFixed(4),
        rows: rowsWanted ? rows.slice(60, 60 + rowsWanted) : undefined,
      });

      g.autopilot(false);
    }

    Car.prototype.step = rawStep;
    Car.prototype.applyTo = rawApply;
    return results;
  }, [SECS, CASES.map(([n, f]) => [n, f.toString()]), ROWS, raw]);

  for (const r of res) out[r.name] = r;

  console.log('\n  Second difference of the car\'s ON-SCREEN (camera-space) depth.');
  console.log('  Smooth motion => ~0. Alternating step size => large, sign-flipping.\n');
  const head = '  case                              fps  km/h  substeps/frame      '
    + 'shimmer RMS   /dt² m/s²  flip Hz  flip%   DRAWN-vs-TRUE  peak';
  console.log(head);
  console.log('  ' + '─'.repeat(head.length - 2));
  for (const r of res) {
    const sc = Object.entries(r.subCounts).map(([k, v]) =>
      `${k}x${(v / r.frames * 100).toFixed(0)}%`).join(' ');
    console.log(
      '  ' + r.name.padEnd(32)
      + String(r.fps).padStart(5)
      + String((r.meanV * 3.6).toFixed(0)).padStart(6)
      + '  ' + sc.padEnd(18)
      + (r.player.rms * 1000).toFixed(2).padStart(9) + ' mm'
      + r.player.accel.toFixed(0).padStart(8)
      + r.player.flipHz.toFixed(1).padStart(9)
      + (r.player.flipFrac * 100).toFixed(0).padStart(6) + '%'
      + (r.lagMean * 1000).toFixed(0).padStart(9) + ' mm'
      + (r.lagPeak * 1000).toFixed(0).padStart(7) + ' mm');
  }

  console.log('\n  and the nearest rival, on the same frames:\n');
  for (const r of res) {
    if (!r.rival) continue;
    console.log('  ' + r.name.padEnd(32)
      + (r.rival.rms * 1000).toFixed(2).padStart(9) + ' mm'
      + r.rival.accel.toFixed(0).padStart(8)
      + r.rival.flipHz.toFixed(1).padStart(9) + ' Hz'
      + (r.rival.flipFrac * 100).toFixed(0).padStart(6) + '%');
  }
});

fs.mkdirSync(path.join(ROOT, 'shots'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'shots', 'shimmy.json'), JSON.stringify(out, null, 1));
console.log('\n  → shots/shimmy.json');
finish(process.exitCode || 0);
