/* Does the car actually work?
 *
 * Runs the AI driver down the whole stage in accelerated time and reports the
 * things you cannot see in a screenshot: stage time, speed range, how much of
 * the run was spent sideways, how often it hit something, whether it ever got
 * stuck. Plus three standalone tests — acceleration, braking, and a handbrake
 * flick — whose numbers can be compared against a real car.
 *
 *   node tools/drive.mjs [--skill 0.85] [--secs 260]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SKILL = +flag('skill', 0.85);
const SECS = +flag('secs', 300);

await run({ width: 480, height: 270, hash: 'manual' }, async ({ page }) => {
  const tests = await page.evaluate(() => {
    const g = window.__game;
    const p = g.player;
    const H = 1 / 120;
    const set = i => { g.botInput = i; };
    const stepFor = (secs, input) => { set(input); for (let i = 0; i < secs * 120; i++) g.step(H); };

    /* Acceleration. Timed on a real part of the stage, so the grade is in it —
       which is the point of a downhill game. */
    p.placeAt(40, 0); p.vx = 0; p.vy = 0; p.r = 0;
    let t100 = null, t160 = null;
    set({ steer: 0, throttle: 1, brake: 0, handbrake: 0 });
    for (let i = 0; i < 20 * 120; i++) {
      g.step(H);
      if (!t100 && p.kmh >= 100) t100 = i * H;
      if (!t160 && p.kmh >= 160) t160 = i * H;
      if (t160) break;
    }
    const vMaxRun = p.kmh;

    /* Braking, 100 km/h to a stop, measured in metres. */
    p.placeAt(40, 0); p.vx = 100 / 3.6; p.vy = 0; p.r = 0;
    const s0 = p.s;
    set({ steer: 0, throttle: 0, brake: 1, handbrake: 0 });
    for (let i = 0; i < 12 * 120 && p.kmh > 3; i++) g.step(H);
    const brakeDist = p.s - s0;

    /* Handbrake flick: can the car be put sideways and then caught? */
    p.placeAt(40, 0); p.vx = 22; p.vy = 0; p.r = 0;
    stepFor(0.9, { steer: 0.75, throttle: 0.3, brake: 0, handbrake: 1 });
    const slipPeak = Math.abs(p.slipAngle) * 180 / Math.PI;
    /* Opposite lock and a partial lift, which is what a driver actually does —
       holding the throttle pinned through the catch sustains the drift on
       purpose and says nothing about whether the car is recoverable. */
    let caught = null, worst = slipPeak;
    set({ steer: -0.55, throttle: 0.3, brake: 0, handbrake: 0 });
    for (let i = 0; i < 5 * 120; i++) {
      g.step(H);
      worst = Math.max(worst, Math.abs(p.slipAngle) * 180 / Math.PI);
      if (Math.abs(p.slipAngle) < 0.09) { caught = i * H; break; }
    }

    return {
      accel: { t100: t100 && +t100.toFixed(2), t160: t160 && +t160.toFixed(2), vMax: +vMaxRun.toFixed(0) },
      brake100to0_m: +brakeDist.toFixed(1),
      drift: {
        peakSlipDeg: +slipPeak.toFixed(1), worstSlipDeg: +worst.toFixed(1),
        caughtAfterSec: caught === null ? null : +caught.toFixed(2),
      },
    };
  });

  console.log('\n  acceleration   0-100 %ss   0-160 %ss   peak %s km/h'
    .replace('%s', tests.accel.t100).replace('%s', tests.accel.t160).replace('%s', tests.accel.vMax));
  console.log(`  braking        100-0 in ${tests.brake100to0_m} m`);
  console.log(`  handbrake      flick to ${tests.drift.peakSlipDeg}°, deepens to ${tests.drift.worstSlipDeg}°, ` +
    (tests.drift.caughtAfterSec === null ? 'NEVER CAUGHT (spun)' : `caught in ${tests.drift.caughtAfterSec}s`));

  const lap = await page.evaluate(async (SECS_SKILL) => {
    const [secs, skill] = SECS_SKILL;
    const g = window.__game;
    const p = g.player;
    g.botInput = null;
    g.autopilot(true, skill);
    p.placeAt(34, 0); p.raceTime = 0; p.finished = false;
    p.vx = 0; p.vy = 0; p.r = 0;

    const H = 1 / 120;
    let impacts = 0, offRoadFrames = 0, sideways = 0, frames = 0;
    let vMin = 999, vMax = 0, stuck = 0, worstStuck = 0, prevS = p.s, noProgress = 0;
    let recoveries = 0;
    const splits = [];
    let nextSplit = 0;

    for (let i = 0; i < secs * 120 && !p.finished; i++) {
      p.lastImpact = 0;
      g.step(H);
      frames++;
      // What the race will do for AI cars, so the measurement matches the game.
      if (p.strandedFor > 2.5) { p.recover(); recoveries++; }
      if (p.lastImpact > 0.06) impacts++;
      if (p.offRoad > 0.5) offRoadFrames++;
      if (Math.abs(p.slipAngle) > 0.16) sideways++;
      const kmh = p.kmh;
      if (kmh < vMin) vMin = kmh;
      if (kmh > vMax) vMax = kmh;
      if (p.s - prevS < 0.005) { noProgress++; worstStuck = Math.max(worstStuck, noProgress); }
      else noProgress = 0;
      prevS = p.s;
      while (nextSplit < 10 && p.s > (g.track.length * (nextSplit + 1)) / 10) {
        splits.push(+p.raceTime.toFixed(1)); nextSplit++;
      }
    }
    stuck = worstStuck / 120;
    return {
      finished: p.finished,
      time: +p.raceTime.toFixed(1),
      reached: +((p.s / g.track.length) * 100).toFixed(0),
      avgKmh: +((p.s / Math.max(p.raceTime, 0.1)) * 3.6).toFixed(0),
      vMin: +vMin.toFixed(0), vMax: +vMax.toFixed(0),
      impacts,
      offRoadPct: +((offRoadFrames / frames) * 100).toFixed(0),
      sidewaysPct: +((sideways / frames) * 100).toFixed(0),
      longestStuckSec: +stuck.toFixed(1),
      recoveries,
      splits,
    };
  }, [SECS, SKILL]);

  console.log(`\n  stage run (skill ${SKILL})`);
  console.log(`    ${lap.finished ? 'FINISHED' : 'DID NOT FINISH — reached ' + lap.reached + '%'} in ${lap.time}s`);
  console.log(`    avg ${lap.avgKmh} km/h, range ${lap.vMin}-${lap.vMax} km/h`);
  console.log(`    ${lap.impacts} impacts, ${lap.offRoadPct}% off road, ${lap.sidewaysPct}% sideways`);
  console.log(`    longest without progress: ${lap.longestStuckSec}s, ${lap.recoveries} recoveries`);
  console.log(`    decile splits: ${lap.splits.join('  ')}`);
});

finish(process.exitCode || 0);
