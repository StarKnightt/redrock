/* What does the steering input actually do, and how much does the body lean?
 *
 * The player's steering path is Input.update -> driverInput() -> Car.step, and
 * none of it can be judged from a screenshot. This drives synthetic key
 * presses through the real chain and traces the road-wheel angle out the far
 * end: a square key input at three frame rates, the same input sampled at the
 * physics substep so a staircase in the command has somewhere to show up, a
 * scripted hairpin, the resting pose, and body roll against cornering load
 * over a whole AI lap.
 *
 * Both the current build and the one it replaced are measured in the same
 * page, by swapping the two old functions back in for the second pass. There
 * is no repository here to check an old build out of, and running two builds
 * in two browsers would put the track, the seed and the adapter between the
 * numbers.
 *
 *   node tools/steerprobe.mjs [tag]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = (args[0] && !args[0].startsWith('--')) ? args[0] : 'steer';
const outDir = path.join(ROOT, 'shots', tag);
fs.mkdirSync(outDir, { recursive: true });

const PROBE = ([legacy, lapOnly]) => {
  const g = window.__game;
  const p = g.player;
  const DEG = 180 / Math.PI;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /* Nothing here needs a camera, and the chase camera is the one part of the
     game this probe must not depend on — it is telemetry, so it should still
     produce numbers while somebody is halfway through rewriting the view. */
  g.freeCam = true;

  /* ---- the build under test -------------------------------------------
     'legacy' puts back what this work replaced: the linear, asymmetric rate
     limit that used to live in Input.update, the first-order exponential the
     car used to chase the wanted angle with, and the old body roll. Roll is
     a display quantity — nothing in the simulation reads it — so recomputing
     it after the real suspension pass reproduces the old value exactly. */
  const restore = [];
  if (legacy) {
    const inp = g.input;
    const realUpdate = inp.update.bind(inp);
    inp.update = function (dt) {
      realUpdate(dt);
      const want = this.steer;                     // now the raw axis
      const toward = Math.sign(want - this._legacy);
      const returning = want === 0 || Math.sign(want) !== Math.sign(this._legacy || want);
      const rate = returning ? 6.5 : 3.4;
      this._legacy = Math.abs(want - this._legacy) < rate * dt
        ? want : this._legacy + toward * rate * dt;
      this.steer = this._legacy;
    };
    inp._legacy = 0;
    restore.push(() => { inp.update = realUpdate; });

    const proto = Object.getPrototypeOf(p);
    const realSteer = proto._steerToward;
    proto._steerToward = function (target, _w, dt) {
      const rate = Math.abs(target) > Math.abs(this.steer) ? 7.0 : 11.0;
      this.steer += (target - this.steer) * (1 - Math.exp(-rate * dt));
      this.steerVel = 0;
    };
    restore.push(() => { proto._steerToward = realSteer; });

    const realSusp = proto._suspension;
    proto._suspension = function (...a) {
      realSusp.apply(this, a);
      const lean = clamp((Math.abs(this.slipAngle) - 0.21) * 0.42, 0, 0.055)
        * -Math.sign(this.slipAngle);
      this.roll = ((this.susp[0] + this.susp[2])
        - (this.susp[1] + this.susp[3])) * 0.315 + lean;
    };
    restore.push(() => { proto._suspension = realSusp; });
  }

  g.botInput = null;
  g.autopilot(false);
  const keys = g.input.down;

  /* A straight to test on. Curvature makes the trace unreadable — the car
     turns whether or not the key is down — so find the flattest 300 m. */
  const t = g.track;
  let bestS = 200, bestC = 1e9;
  for (let s = 120; s < t.length - 400; s += 20) {
    let c = 0;
    for (let d = 0; d < 300; d += 15) c += Math.abs(t.frameAt(s + d).curv);
    if (c < bestC) { bestC = c; bestS = s; }
  }

  /* The tightest corner, for the hairpin run. */
  let hairS = 400, hairC = 0;
  for (let s = 260; s < t.length - 200; s += 5) {
    const c = Math.abs(t.frameAt(s).curv);
    if (c > hairC) { hairC = c; hairS = s; }
  }

  const settle = () => {
    keys.clear();
    g.input.steer = 0;
    if (legacy) g.input._legacy = 0;
    for (let i = 0; i < 90; i++) g.step(1 / 60);
  };

  /* `lapOnly` is for the extra stage seeds, where the only question is
     whether the AI still gets down the hill and how long it takes. */
  let rest = null, step = null, frames60 = null, sub60 = null, hairpin = null;
  if (!lapOnly) {

  /* ---- resting pose ---------------------------------------------------- */
  p.placeAt(bestS, 0);
  settle();
  for (let i = 0; i < 150; i++) g.step(1 / 60);
  rest = {
    rollDeg: +(p.roll * DEG).toFixed(3),
    pitchDeg: +(p.pitch * DEG).toFixed(3),
    kmh: +p.kmh.toFixed(2),
    gradePct: +(t.frameAt(p.s).grade * 100).toFixed(1),
    susp: p.susp.map(v => +v.toFixed(4)),
  };

  /* ---- square-wave step response --------------------------------------
     0.35 s of nothing, 0.9 s of right lock, 0.9 s of release, 0.9 s of left
     lock, 0.9 s of release, with the throttle held so the car is at a
     realistic speed rather than crawling.

     `sub` optionally samples the road-wheel angle at every physics substep
     instead of every frame. That is the resolution the jerk lives at: the
     input layer runs once per rendered frame and the car runs at 120 Hz, so
     a command that changes by a step every frame reaches the car as a
     staircase, and a staircase is invisible if you only look at it once per
     stair. */
  const square = (dt, entrySpeed = 25, sub = false) => {
    p.placeAt(bestS, 0);
    p.vx = entrySpeed;
    settle();
    p.placeAt(bestS, 0);
    p.vx = entrySpeed;

    const rows = [];
    let time = 0;
    let unwrap = null;
    let frameNo = 0;
    if (sub) {
      const real = p.step.bind(p);
      let subT = 0;
      p.step = (h, input) => {
        real(h, input);
        subT += h;
        rows.push([+subT.toFixed(5), +(p.steer * DEG).toFixed(5), frameNo]);
      };
      unwrap = () => { delete p.step; };
    }

    const frames = [];
    while (time < 3.95) {
      frameNo++;
      let key = null;
      if (time >= 0.35 && time < 1.25) key = 'KeyD';
      else if (time >= 2.15 && time < 3.05) key = 'KeyA';
      keys.clear();
      if (key) keys.add(key);
      keys.add('KeyW');
      g.step(dt);
      time += dt;
      frames.push([
        +time.toFixed(4),
        key === 'KeyD' ? 1 : key === 'KeyA' ? -1 : 0,
        +g.input.steer.toFixed(5),
        +(p.steer * DEG).toFixed(4),
        +(p.r * DEG).toFixed(3),
        +p.kmh.toFixed(2),
        +(p.roll * DEG).toFixed(3),
        +(p.pitch * DEG).toFixed(3),
      ]);
    }
    if (unwrap) unwrap();
    return sub ? { frames, sub: rows } : { frames };
  };

  /* Time to cover 90% of the eventual travel after the key goes down, time to
     come back within 10% of centre after release, and the peak rate. */
  const analyse = ({ frames }, dt) => {
    const steer = frames.map(r => r[3]);
    const t0 = frames.findIndex(r => r[1] === 1);
    const tRel = frames.findIndex((r, i) => i > t0 && r[1] === 0);
    const peak = Math.max(...steer.slice(t0, tRel));
    let rise = null, fall = null;
    for (let i = t0; i < tRel; i++) if (steer[i] >= peak * 0.9) { rise = (i - t0) * dt; break; }
    for (let i = tRel; i < steer.length; i++) if (steer[i] <= peak * 0.1) { fall = (i - tRel) * dt; break; }
    let rate = 0;
    for (let i = 1; i < steer.length; i++) rate = Math.max(rate, Math.abs(steer[i] - steer[i - 1]) / dt);
    return {
      peakSteerDeg: +peak.toFixed(2),
      riseTo90Sec: rise === null ? null : +rise.toFixed(3),
      returnTo10Sec: fall === null ? null : +fall.toFixed(3),
      peakRateDegSec: +rate.toFixed(0),
    };
  };

  /**
   * Is the steering angle a curve or a staircase?
   *
   * The input layer runs once per rendered frame and the car runs at 120 Hz,
   * so at 60 fps every frame is two physics substeps fed one command. If that
   * command arrives as a series of equal steps — which is what a per-frame
   * rate limit produces — the car's steering velocity is flat inside a frame
   * and jumps at every frame boundary. That is the staircase, and it is
   * exactly the thing a player feels as a buzz through a turn-in.
   *
   * Comparing the size of the velocity change at frame boundaries against the
   * change between the two substeps inside a frame separates that from mere
   * speed: a smooth curve is equally curved wherever you sample it and scores
   * about 1, and a staircase scores as many times more as its stairs are
   * taller than its slope. Sampled where the wheel is actually moving, since
   * a stationary wheel has nothing to say either way.
   */
  const staircase = (sub) => {
    const v = [], fr = [];
    for (let i = 1; i < sub.length; i++) {
      v.push((sub[i][1] - sub[i - 1][1]) / (sub[i][0] - sub[i - 1][0]));
      fr.push(sub[i][2]);
    }
    const peakRate = Math.max(...v.map(Math.abs));
    let edgeSum = 0, edgeN = 0, insideSum = 0, insideN = 0;
    for (let i = 1; i < v.length; i++) {
      // Only where something is happening; the flats at either end are silent.
      if (Math.abs(v[i]) < peakRate * 0.05 && Math.abs(v[i - 1]) < peakRate * 0.05) continue;
      const d = Math.abs(v[i] - v[i - 1]);
      if (fr[i] !== fr[i - 1]) { edgeSum += d; edgeN++; } else { insideSum += d; insideN++; }
    }
    const edge = edgeN ? edgeSum / edgeN : 0;
    const inside = insideN ? insideSum / insideN : 0;
    return {
      peakRateDegSec: +peakRate.toFixed(0),
      atFrameEdgeDegSec: +edge.toFixed(1),
      insideFrameDegSec: +inside.toFixed(1),
      ratio: inside > 1e-6 ? +(edge / inside).toFixed(2) : null,
    };
  };

  const at60 = square(1 / 60, 25, true);
  const at30 = square(1 / 30);
  const at144 = square(1 / 144);
  frames60 = at60.frames;
  sub60 = at60.sub;
  step = {
    at30: analyse(at30, 1 / 30),
    at60: analyse(at60, 1 / 60),
    at144: analyse(at144, 1 / 144),
    substep: staircase(at60.sub),
  };

  /* ---- scripted hairpin ------------------------------------------------ */
  g.autopilot(true, 0.85);
  g.bot.wobble = 5;
  p.placeAt(Math.max(6, hairS - 170), 0);
  p.vx = 0; p.vy = 0; p.r = 0;
  for (let i = 0; i < 40 * 60 && p.s < hairS - 45; i++) g.step(1 / 60);
  g.autopilot(false);
  const entry = { kmh: +p.kmh.toFixed(1), s: +p.s.toFixed(0) };
  const curv = g.track.frameAt(hairS).curv;
  const key = curv > 0 ? 'KeyD' : 'KeyA';
  const hairRows = [];
  {
    let time = 0;
    g.input.steer = 0;
    if (legacy) g.input._legacy = 0;
    for (let i = 0; i < 5.0 * 60; i++) {
      keys.clear();
      if (time > 0.30 && time < 2.30) keys.add(key);
      if (time > 0.9) keys.add('KeyW');
      g.step(1 / 60);
      time += 1 / 60;
      hairRows.push([
        +time.toFixed(4),
        keys.has(key) ? (key === 'KeyD' ? 1 : -1) : 0,
        +g.input.steer.toFixed(5),
        +(p.steer * DEG).toFixed(4),
        +(p.r * DEG).toFixed(3),
        +p.kmh.toFixed(2),
        +(p.roll * DEG).toFixed(3),
        +(p.pitch * DEG).toFixed(3),
        +(p.slipAngle * DEG).toFixed(2),
        +p.lat.toFixed(2),
      ]);
    }
  }
  let bi = 0;
  hairRows.forEach((r, i) => { if (Math.abs(r[4]) > Math.abs(hairRows[bi][4])) bi = i; });
  hairpin = {
    entry, hairS: +hairS.toFixed(0), radius: +(1 / hairC).toFixed(0),
    dir: curv > 0 ? 'right' : 'left',
    peakRollDeg: +Math.max(...hairRows.map(r => Math.abs(r[6]))).toFixed(2),
    atPeakYaw: { yawRate: hairRows[bi][4], rollDeg: hairRows[bi][6], kmh: hairRows[bi][5], slipDeg: hairRows[bi][8] },
    maxLat: +Math.max(...hairRows.map(r => Math.abs(r[9]))).toFixed(2),
    rows: hairRows,
  };
  settle();

  }   // !lapOnly

  /* ---- roll across a whole AI lap --------------------------------------
     A skidpad would be the textbook measurement and there is nowhere to put
     one: the stage is a 5.6 km descent between two berms, and any held lock
     large enough to load the car has it off the road inside two seconds, so
     the number that comes back describes the berm. A full lap gives the
     honest thing instead — how much the body leans at each cornering load,
     and how often it leans the right way — over the road the player drives. */
  g.autopilot(true, 0.85);
  g.bot.wobble = 5;
  p.placeAt(34, 0); p.vx = 0; p.vy = 0; p.r = 0;
  p.raceTime = 0; p.finished = false; p.rpm = 1050; p.gear = 0;
  /* The field is stepped by the game loop and it can hit the player. Left
     wherever the previous section abandoned it, it makes a stage time that
     depends on what was measured before it — which is how the same build gave
     246, 250 and 235 seconds on three passes. */
  if (g.race) g.race.reset();
  const bins = [[0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.0], [1.0, 9]].map(b => ({
    lo: b[0], hi: b[1], sum: 0, signed: 0, n: 0, agree: 0,
  }));
  let maxRoll = 0, maxPitch = 0, rollFrames = 0, lapFrames = 0, recoveries = 0;
  /* Stage time on this stage is chaotic — one berm brushed differently early
     on is ten seconds by the finish — so it is a weak signal on its own.
     These are the aggregates, and they say whether the car is being driven
     accurately or wrestled. */
  let impacts = 0, offRoadFrames = 0, sideways = 0;
  let prevS = p.s, noProgress = 0, worstStall = 0;
  for (let i = 0; i < 300 * 120 && !p.finished; i++) {
    g.step(1 / 120);
    if (p.strandedFor > 2.5) { p.recover(); recoveries++; }
    lapFrames++;
    if (p.lastImpact > 0.06) impacts++;
    if (p.offRoad > 0.5) offRoadFrames++;
    if (Math.abs(p.slipAngle) > 0.16) sideways++;
    if (p.s - prevS < 0.005) { noProgress++; worstStall = Math.max(worstStall, noProgress); }
    else noProgress = 0;
    prevS = p.s;
    const ayG = Math.abs(p.speed * p.r) / 9.81;
    maxRoll = Math.max(maxRoll, Math.abs(p.roll));
    maxPitch = Math.max(maxPitch, Math.abs(p.pitch));
    if (Math.abs(p.roll) * DEG > 8) rollFrames++;
    for (const b of bins) {
      if (ayG >= b.lo && ayG < b.hi) {
        b.sum += Math.abs(p.roll); b.n++;
        /* Outside lean means roll shares the sign of the yaw rate. Signed, as
           well as counted: |roll| flatters a body that leans hard in both
           directions, and leaning hard the wrong way is worse than not
           leaning at all. */
        b.signed += p.roll * Math.sign(p.r);
        if (Math.sign(p.roll) === Math.sign(p.r)) b.agree++;
      }
    }
  }
  const lap = {
    finished: p.finished, time: +p.raceTime.toFixed(1), recoveries,
    impacts,
    offRoadPct: +((offRoadFrames / lapFrames) * 100).toFixed(1),
    sidewaysPct: +((sideways / lapFrames) * 100).toFixed(1),
    longestStallSec: +(worstStall / 120).toFixed(1),
    maxRollDeg: +(maxRoll * DEG).toFixed(2),
    maxPitchDeg: +(maxPitch * DEG).toFixed(2),
    over8Pct: +((rollFrames / Math.max(lapFrames, 1)) * 100).toFixed(1),
    bins: bins.map(b => ({
      band: `${b.lo}-${b.hi === 9 ? '+' : b.hi} g`,
      pctOfLap: +((b.n / Math.max(lapFrames, 1)) * 100).toFixed(1),
      rollDeg: b.n ? +((b.sum / b.n) * DEG).toFixed(2) : null,
      outwardDeg: b.n ? +((b.signed / b.n) * DEG).toFixed(2) : null,
      outsidePct: b.n ? +((b.agree / b.n) * 100).toFixed(0) : null,
    })),
  };
  g.autopilot(false);
  keys.clear();
  for (const undo of restore) undo();

  return { legacy, straightS: +bestS.toFixed(0), rest, step, frames60, sub60, hairpin, lap };
};

/* Extra stage seeds. The AI shares the steering path with the player, so a
   change that helps a keyboard can just as easily put a bot in the scenery,
   and one stage is not enough to know which. */
const SEEDS = (args.indexOf('--seeds') < 0 ? '22,1,7'
  : args[args.indexOf('--seeds') + 1]).split(',').map(Number);

let old0 = null, now0 = null;

await run({ width: 480, height: 270, hash: `manual&seed=${SEEDS[0]}` }, async ({ page }) => {
  const now = await page.evaluate(PROBE, [false, false]);
  const old = await page.evaluate(PROBE, [true, false]);
  old0 = old.lap; now0 = now.lap;

  const pair = (label, a, b, unit = '') =>
    `    ${label.padEnd(34)} ${String(a).padStart(9)}${unit}   ->${String(b).padStart(9)}${unit}`;

  console.log(`\n  before -> after   (straight at s=${now.straightS}, ` +
    `grade ${now.rest.gradePct}%)`);

  console.log('\n  resting pose, no input');
  console.log(pair('roll', old.rest.rollDeg, now.rest.rollDeg, '°'));
  console.log(pair('pitch', old.rest.pitchDeg, now.rest.pitchDeg, '°'));

  console.log('\n  square key press -> road-wheel angle');
  for (const [k, hz] of [['at30', 30], ['at60', 60], ['at144', 144]]) {
    console.log(pair(`rise to 90% of lock @ ${hz} fps`,
      old.step[k].riseTo90Sec, now.step[k].riseTo90Sec, ' s'));
  }
  for (const [k, hz] of [['at30', 30], ['at60', 60], ['at144', 144]]) {
    console.log(pair(`return to 10% @ ${hz} fps`,
      old.step[k].returnTo10Sec, now.step[k].returnTo10Sec, ' s'));
  }
  console.log(pair('lock reached', old.step.at60.peakSteerDeg, now.step.at60.peakSteerDeg, '°'));

  console.log('\n  curve or staircase, sampled at the 120 Hz physics substep');
  console.log(pair('peak steering rate',
    old.step.substep.peakRateDegSec, now.step.substep.peakRateDegSec, ' °/s'));
  console.log(pair('mean rate change at a frame edge',
    old.step.substep.atFrameEdgeDegSec, now.step.substep.atFrameEdgeDegSec, ' °/s'));
  console.log(pair('mean rate change inside a frame',
    old.step.substep.insideFrameDegSec, now.step.substep.insideFrameDegSec, ' °/s'));
  console.log(pair('staircase ratio (1.0 = a smooth curve)',
    old.step.substep.ratio, now.step.substep.ratio));

  console.log(`\n  hairpin  s=${now.hairpin.hairS}  R=${now.hairpin.radius} m  ` +
    `turns ${now.hairpin.dir}  entry ~${now.hairpin.entry.kmh} km/h`);
  console.log(pair('peak roll', old.hairpin.peakRollDeg, now.hairpin.peakRollDeg, '°'));
  console.log(pair('roll at peak yaw rate',
    old.hairpin.atPeakYaw.rollDeg, now.hairpin.atPeakYaw.rollDeg, '°'));
  console.log(pair('yaw rate there',
    old.hairpin.atPeakYaw.yawRate, now.hairpin.atPeakYaw.yawRate, ' °/s'));
  console.log(pair('widest line', old.hairpin.maxLat, now.hairpin.maxLat, ' m'));

  console.log(`\n  AI lap, stage seed ${SEEDS[0]}, skill 0.85`);
  console.log(pair('stage time', old.lap.finished ? old.lap.time : 'DNF',
    now.lap.finished ? now.lap.time : 'DNF', ' s'));
  console.log(pair('recoveries', old.lap.recoveries, now.lap.recoveries));
  console.log(pair('max roll', old.lap.maxRollDeg, now.lap.maxRollDeg, '°'));
  console.log(pair('max pitch', old.lap.maxPitchDeg, now.lap.maxPitchDeg, '°'));
  console.log(pair('frames past 8° of roll', old.lap.over8Pct, now.lap.over8Pct, ' %'));
  console.log('\n    body roll by cornering load. "net outward" is the lean signed against');
  console.log('    the turn, so leaning the wrong way counts against it.');
  for (let i = 0; i < now.lap.bins.length; i++) {
    const o = old.lap.bins[i], n = now.lap.bins[i];
    console.log(`      ${n.band.padEnd(7)} ${String(n.pctOfLap).padStart(5)}% of lap   ` +
      `net outward ${String(o.outwardDeg).padStart(5)}° -> ${String(n.outwardDeg).padStart(5)}°   ` +
      `outward ${String(o.outsidePct).padStart(3)}% -> ${String(n.outsidePct).padStart(3)}% of frames`);
  }

  fs.writeFileSync(path.join(outDir, 'steer.json'), JSON.stringify({ old, now }, null, 1));
  const head = 't,key,command,roadWheelDeg,yawRateDeg,kmh,rollDeg,pitchDeg';
  for (const [name, r] of [['before', old], ['after', now]]) {
    fs.writeFileSync(path.join(outDir, `step60-${name}.csv`),
      head + '\n' + r.frames60.map(x => x.join(',')).join('\n'));
    fs.writeFileSync(path.join(outDir, `hairpin-${name}.csv`),
      head + ',slipDeg,lat\n' + r.hairpin.rows.map(x => x.join(',')).join('\n'));
    /* The 120 Hz view of the same press. Everything interesting about
       smoothness happens between two rendered frames. */
    fs.writeFileSync(path.join(outDir, `substep-${name}.csv`),
      't,roadWheelDeg,frame\n' + r.sub60.map(x => x.join(',')).join('\n'));
  }
  console.log(`\n  → shots/${tag}/steer.json + step60-*.csv + substep-*.csv + hairpin-*.csv`);
});

const laps = [];
if (old0 && now0) laps.push({ seed: SEEDS[0], old: old0, now: now0 });
for (const seed of SEEDS.slice(1)) {
  await run({ width: 320, height: 180, hash: `manual&seed=${seed}` }, async ({ page }) => {
    const now = await page.evaluate(PROBE, [false, true]);
    const old = await page.evaluate(PROBE, [true, true]);
    laps.push({ seed, old: old.lap, now: now.lap });
  });
}

/* A parse error in somebody else's module stops the harness before a browser
   is launched, and there is nothing to report. Say so rather than dying in
   the summary with a null. */
if (!laps.length) {
  console.error('\n  no runs completed — see the errors above');
  process.exitCode = 1;
  finish(1);
}

console.log('\n  AI down the stage, every seed, before -> after');
const tot = { old: {}, now: {} };
for (const l of laps) {
  const f = x => (x.finished ? x.time.toFixed(1) + ' s' : 'DID NOT FINISH');
  console.log(`    seed ${String(l.seed).padStart(3)}   ` +
    `${String(f(l.old)).padStart(14)} -> ${String(f(l.now)).padStart(14)}`);
  console.log(`               impacts ${String(l.old.impacts).padStart(3)} -> ${String(l.now.impacts).padStart(3)}` +
    `   off road ${String(l.old.offRoadPct).padStart(4)}% -> ${String(l.now.offRoadPct).padStart(4)}%` +
    `   sideways ${String(l.old.sidewaysPct).padStart(4)}% -> ${String(l.now.sidewaysPct).padStart(4)}%` +
    `   recoveries ${l.old.recoveries} -> ${l.now.recoveries}` +
    `   longest stall ${l.old.longestStallSec}s -> ${l.now.longestStallSec}s`);
  for (const side of ['old', 'now']) {
    for (const k of ['time', 'impacts', 'offRoadPct', 'sidewaysPct', 'recoveries']) {
      tot[side][k] = (tot[side][k] || 0) + l[side][k];
    }
  }
}
const n = laps.length;
console.log(`\n    mean of ${n}   ` +
  `time ${(tot.old.time / n).toFixed(1)} -> ${(tot.now.time / n).toFixed(1)} s   ` +
  `impacts ${(tot.old.impacts / n).toFixed(1)} -> ${(tot.now.impacts / n).toFixed(1)}   ` +
  `off road ${(tot.old.offRoadPct / n).toFixed(1)}% -> ${(tot.now.offRoadPct / n).toFixed(1)}%   ` +
  `sideways ${(tot.old.sidewaysPct / n).toFixed(1)}% -> ${(tot.now.sidewaysPct / n).toFixed(1)}%   ` +
  `recoveries ${(tot.old.recoveries / n).toFixed(1)} -> ${(tot.now.recoveries / n).toFixed(1)}`);
const allHome = laps.every(l => l.now.finished);
console.log(`\n  every seed still finishes: ${allHome ? 'yes' : 'NO'}`);
if (!allHome) process.exitCode = 1;
fs.writeFileSync(path.join(outDir, 'laps.json'), JSON.stringify(laps, null, 1));

finish(process.exitCode || 0);
