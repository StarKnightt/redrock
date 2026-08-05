/* A stopwatch on the turn-around, with the race taken out of it.
 *
 * tools/spin.mjs is the honest measure — it watches real rivals in real races
 * — and that is exactly what makes it a poor thing to iterate against: an
 * episode's duration depends on where the car happened to spin, how fast it
 * happened to be going, whether a rival hit it afterwards and whether the
 * race teleported it, so two builds differ by a second for reasons that have
 * nothing to do with the controller. A 32-seed sweep also costs 76 s.
 *
 * This puts one car, alone, into a known spun state at a known place, and
 * times how long the driver takes to get it back. Same physics, same driver,
 * same substep rate the race uses. Nothing else on the road.
 *
 * RECOVERED means what the brief says it means, not "the nose came round":
 *
 *   - pointing down the road, inside RECOVER_HEAD of the tangent,
 *   - back between the kerbs with a margin, not scraping along a berm,
 *   - and at a racing pace, defined as a fraction of the speed this driver
 *     would have chosen for this piece of road if nothing had happened.
 *
 * All three, held for HOLD seconds so a car that flicks through the window
 * on its way to the scenery does not score.
 *
 * The states are a grid rather than a sample: every combination of station,
 * heading error and entry speed, so a change that helps one corner and hurts
 * another cannot hide inside an average.
 *
 *   node tools/recbench.mjs [--skill 0.8] [--json out.json] [--worst 10]
 *                           [--stations 12] [--secs 30]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SKILL = +flag('skill', 0.8);
const STATIONS = +flag('stations', 12);
const SECS = +flag('secs', 30);
const WORST = +flag('worst', 10);
const JSON_OUT = flag('json', null);

const SIM = async ([skill, nStations, secs]) => {
  const { Car } = await import('/src/car/physics.js');
  const { Driver } = await import('/src/car/driver.js');
  const g = window.__game;
  const track = g.track;

  const DT = 1 / 60;
  const RECOVER_HEAD = Math.cos(20 * Math.PI / 180);   // nose within 20 deg
  const PACE_FRAC = 0.70;      // of the speed the driver would have chosen
  const EDGE_MARGIN = 1.5;     // metres inside the kerb it has to be
  const HOLD = 0.30;

  /* Spread the stations over the middle of the stage. The first 200 m is the
     grid and the last 200 m the run to the line; a turn-around in either is a
     different situation and not the one the backlog is about. */
  const stations = [];
  for (let i = 0; i < nStations; i++) {
    stations.push(300 + (track.length - 700) * (i / Math.max(1, nStations - 1)));
  }
  const HEADS = [70, 100, 130, 160, 180];    // degrees of heading error
  const SPEEDS = [8, 16, 24];                // m/s the car is carrying
  const LATS = [-0.6, 0.6];                  // fraction of half-width, each side

  const results = [];
  for (const s of stations) {
    for (const headDeg of HEADS) {
      for (const V of SPEEDS) {
        for (const latF of LATS) {
          const f = track.frameAt(s);
          const hw = f.width * 0.5;
          const car = new Car(track, { palette: 1, ai: true });
          /* The wobble is seeded from the driver seed, and the seed is part
             of the state under test: a bench that used a fresh random phase
             would give a different answer every run, which is the one thing
             a regression gate may not do. */
          const driver = new Driver(track, { skill, lane: 0, seed: 7 });
          driver.boost = 1;

          car.placeAt(s, latF * hw);
          /* Rotate the nose off the road, then rebuild the basis from it, so
             forward and right are consistent with the yaw the way an ordinary
             step would leave them. */
          car.yaw += headDeg * Math.PI / 180;
          car._orient(track.frameAt(car.s));
          /* Velocity still pointing down the road: that is what a spin is.
             A car rotated on the spot with its velocity rotated to match is
             not spun, it is parked facing the wrong way, and it recovers in
             a quarter of the time. Resolved into the car's own axes, which
             is where vx and vy live. */
          const vWorld = f.tan.clone().multiplyScalar(V);
          car.vx = vWorld.dot(car.forward);
          car.vy = vWorld.dot(car.right);
          /* A spin has yaw rate in it too, in the direction that put the car
             where it is. Sign from the heading offset, magnitude modest so
             the state is a car that HAS spun rather than one mid-spin. */
          car.r = 0.6;

          let t = 0, held = 0, dur = null, teleports = 0;
          let firstFace = null, sumOff = 0, sumAir = 0, n = 0, minS = car.s;
          let recFrames = 0;
          for (let i = 0; i < secs * 60; i++) {
            const input = driver.drive(car, DT);
            for (let k = 0; k < 2; k++) car.step(DT / 2, input);
            t += DT; n++;

            const fr = track.frameAt(car.s);
            const facing = car.forward.dot(fr.tan);
            const half = fr.width * 0.5;
            if (Math.abs(car.lat) > half) sumOff++;
            if (car.airborne) sumAir++;
            if (driver.rec) recFrames++;
            /* The race would have taken it away at this point. Counted, not
               acted on: the question here is what the driver can do, and a
               teleport answers a different one. */
            if (car.strandedFor > (driver.recovering ? 8 : 2.5)) {
              teleports++; car.strandedFor = 0;
            }
            const pace = driver.targetSpeed(car.s) * PACE_FRAC;
            const ok = facing > RECOVER_HEAD
              && Math.abs(car.lat) < half - EDGE_MARGIN
              && car.vx > pace;
            if (firstFace === null && facing > RECOVER_HEAD) firstFace = +t.toFixed(2);
            if (ok) {
              held += DT;
              if (held >= HOLD) { dur = +(t - HOLD).toFixed(2); break; }
            } else held = 0;
          }
          results.push({
            s: +s.toFixed(0), headDeg, V, latF,
            dur, timeout: dur === null,
            faceAt: firstFace,
            teleports,
            offPct: +(sumOff / n * 100).toFixed(0),
            airPct: +(sumAir / n * 100).toFixed(0),
            recPct: +(recFrames / n * 100).toFixed(0),
            grade: +f.grade.toFixed(3),
            curv: +f.curv.toFixed(4),
            hw: +hw.toFixed(2),
          });
          car.dispose?.();
        }
      }
    }
  }
  return results;
};

const pct = (a, f) => {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(f * s.length))];
};
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

await run({ width: 480, height: 270, hash: 'manual' }, async ({ page }) => {
  const r = await page.evaluate(SIM, [SKILL, STATIONS, SECS]);

  /* A timeout is not a missing measurement, it is the worst one. Scoring it
     at the cap rather than dropping it is what stops a change that turns ten
     slow recoveries into ten failures from reading as an improvement. */
  const score = e => (e.dur === null ? SECS : e.dur);
  const all = r.map(score);
  const done = r.filter(e => !e.timeout);

  console.log(`\n─── recovery bench: ${r.length} states, ${SECS}s cap ───\n`);
  console.log(`  recovered      ${done.length}/${r.length}  (${(done.length / r.length * 100).toFixed(0)}%)`);
  console.log(`  time to back-on-the-line, timeouts scored at the cap:`);
  console.log(`     median ${pct(all, 0.5).toFixed(2)}s   mean ${mean(all).toFixed(2)}s   ` +
    `p90 ${pct(all, 0.9).toFixed(2)}s   max ${Math.max(...all).toFixed(2)}s`);
  const faces = r.filter(e => e.faceAt !== null).map(e => e.faceAt);
  console.log(`  time merely to FACE the right way: median ${pct(faces, 0.5).toFixed(2)}s ` +
    `(${faces.length}/${r.length} ever did)`);
  console.log(`  would-be teleports ${r.reduce((a, e) => a + e.teleports, 0)}`);

  const by = (key, fmt = String) => {
    const keys = [...new Set(r.map(e => e[key]))].sort((a, b) => a - b);
    console.log(`\n  by ${key}:`);
    for (const k of keys) {
      const g = r.filter(e => e[key] === k);
      const gs = g.map(score);
      console.log(`    ${fmt(k).padStart(7)}  n=${String(g.length).padStart(3)}  ` +
        `median ${pct(gs, 0.5).toFixed(2)}s  mean ${mean(gs).toFixed(2)}s  ` +
        `p90 ${pct(gs, 0.9).toFixed(2)}s  timeouts ${g.filter(e => e.timeout).length}  ` +
        `off-road ${mean(g.map(e => e.offPct)).toFixed(0)}%  air ${mean(g.map(e => e.airPct)).toFixed(0)}%  ` +
        `in controller ${mean(g.map(e => e.recPct)).toFixed(0)}%`);
    }
  };
  by('headDeg', k => k + 'deg');
  by('V', k => k + 'm/s');
  by('latF', k => k.toFixed(1));

  console.log(`\n  worst ${WORST}:`);
  for (const e of r.slice().sort((a, b) => score(b) - score(a)).slice(0, WORST)) {
    console.log(`    s=${String(e.s).padStart(5)} head ${String(e.headDeg).padStart(3)} ` +
      `V ${String(e.V).padStart(2)} lat ${e.latF.toFixed(1).padStart(4)}  ` +
      `${(e.dur === null ? 'TIMEOUT' : e.dur.toFixed(2) + 's').padStart(8)}  ` +
      `faced at ${String(e.faceAt ?? '—').padStart(5)}  off ${String(e.offPct).padStart(3)}%  ` +
      `air ${String(e.airPct).padStart(3)}%  ctrl ${String(e.recPct).padStart(3)}%  ` +
      `grade ${e.grade}  curv ${e.curv}`);
  }

  if (JSON_OUT) {
    const file = path.isAbsolute(JSON_OUT) ? JSON_OUT : path.join(ROOT, JSON_OUT);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ skill: SKILL, secs: SECS, results: r }, null, 1));
    console.log(`\n  → ${file}`);
  }
});

finish(process.exitCode || 0);
