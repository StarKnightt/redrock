/* How long does a rival take to turn around after a spin, and what is it doing
 * while it takes that long?
 *
 * The backlog entry says 5-20 seconds and reads as broken AI. That is a claim
 * about a distribution, so this measures one: every episode in which a rival's
 * nose leaves the road direction, across as many seeds as asked for, with
 * enough state captured during each to say WHY it took what it took rather
 * than only that it did.
 *
 * An episode opens when the car's heading falls past `ON` of the road tangent
 * and closes when it is back inside `OFF` and driving forward again. The two
 * thresholds are deliberately far apart: a single threshold reopens an episode
 * every time a sliding car's nose crosses it, and one manoeuvre reads as nine.
 *
 * Episodes are classified by how far round the car actually got, because a
 * 70-degree slide and a full spin are different events and averaging them
 * hides both.
 *
 *   node tools/spin.mjs [--seeds 1..32] [--secs 420] [--skill 0.85]
 *                       [--json out.json] [--worst 6]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

/* "1..32" as well as "1,2,3", because the 32-seed sweep is the common case. */
const parseSeeds = (spec) => {
  const m = /^(\d+)\.\.(\d+)$/.exec(spec);
  if (!m) return spec.split(',').map(Number);
  const out = [];
  for (let i = +m[1]; i <= +m[2]; i++) out.push(i);
  return out;
};
const SEEDS = parseSeeds(flag('seeds', '1..12'));
const SECS = +flag('secs', 420);
const SKILL = +flag('skill', 0.85);
const WORST = +flag('worst', 6);
const JSON_OUT = flag('json', null);
/* The race teleports a stranded car back onto the road after 2.5 s. That is
   the thing that ends nearly every spin, so with it on this tool measures the
   rescue timer and not the driver. Off, it measures what the driver can
   actually do — which is the behaviour the player is watching. */
const NORESCUE = args.includes('--norescue');
/* "Recovered" defaults to the nose being round and the car moving forward at
   a walking pace or better, which is what the episode boundary needs to be
   for the count of episodes to mean anything. It is not what a player would
   call recovered: a car crawling along a berm at 22 km/h pointing the right
   way is still in trouble. --strict additionally requires the car to be back
   between the kerbs with a margin and up to a fraction of the pace its own
   driver would have chosen for that piece of road, which is the definition
   worth quoting. It is off by default so the episode counts stay comparable
   with every earlier run of this tool. */
const STRICT = args.includes('--strict');

const SIM = async ([seed, skill, secs, norescue, strict]) => {
  const { Race } = await import('/src/race/index.js');
  const g = window.__game;
  const p = g.player;

  /* Set up exactly as tools/race.mjs and tools/stall.mjs do, so the run being
     measured is the run those tools report on. */
  if (g.race) g.race.dispose();
  const race = new Race(g.track, g.scene, { seed });
  g.race = race;
  g.botInput = { steer: 0, throttle: 0, brake: 1, handbrake: 0 };
  g.step(1 / 60);
  const wired = race._clock > 0;
  race.reset();
  g.botInput = null;
  g.autopilot(true, skill);
  g.bot.wobble = 5;
  g.bot.boost = 1;
  p.placeAt(34, 0); p.vx = 0; p.vy = 0; p.r = 0;
  p.raceTime = 0; p.finished = false;
  p.rpm = 1050; p.gear = 0;

  /* Watch the teleport rescue without changing it. A rescue inside an episode
     means the AI did not recover — the race did it for it — and an episode
     that ends that way must not be counted as a fast turn-around. */
  const rescued = new Map();
  /* recover() teleports the car and re-points it down the road, so anything
     read afterwards describes the rescue rather than what provoked it. */
  const preRescue = new Map();

  const ON = 0.50;        // heading falls past 60 deg of the road: episode opens
  const OFF = 0.85;       // back inside 32 deg and driving: episode closes
  const HOLD = 0.25;      // seconds it must stay that way, so a flick is not a fix
  const DT = 1 / 60;

  const watched = race.entries.map(e => ({
    name: e.name, car: e.car, driver: e.driver, ep: null, prevSteer: e.car.steer,
  }));

  const byCar = new Map(watched.map(w => [w.car, w]));
  for (const e of race.entries) {
    const car = e.car;
    const raw = car.recover.bind(car);
    car.recover = () => {
      rescued.set(car, (rescued.get(car) || 0) + 1);
      preRescue.set(car, snap(byCar.get(car)));
      if (norescue) { car.strandedFor = 0; return; }
      raw();
    };
  }

  const episodes = [];
  let t = 0;

  const snap = (w) => {
    const car = w.car;
    const f = g.track.frameAt(car.s);
    const hw = f.width * 0.5;
    return {
      t: +t.toFixed(2),
      s: +car.s.toFixed(1),
      facing: +car.forward.dot(f.tan).toFixed(3),
      headDeg: +(Math.acos(Math.max(-1, Math.min(1, car.forward.dot(f.tan)))) * 180 / Math.PI).toFixed(0),
      kmh: +car.kmh.toFixed(1),
      vx: +car.vx.toFixed(2),
      vy: +car.vy.toFixed(2),
      yawRate: +car.r.toFixed(2),
      slipDeg: +(car.slipAngle * 180 / Math.PI).toFixed(0),
      lat: +car.lat.toFixed(2),
      hw: +hw.toFixed(2),
      room: +(hw + 1.05 - Math.abs(car.lat)).toFixed(2),   // metres to the wall
      grade: +f.grade.toFixed(3),
      curv: +f.curv.toFixed(4),
      thr: +car.throttle.toFixed(2),
      brk: +car.brake.toFixed(2),
      hb: +car.handbrake.toFixed(2),
      steerDeg: +(car.steer * 180 / Math.PI).toFixed(1),
      cmd: +w.driver.steerSmooth.toFixed(3),
      /* The sign the turn-around branch steers on. If this is stable while
         the command is not, something other than the branch is moving the
         command. */
      cross: +car.right.dot(f.tan).toFixed(3),
      wall: !!car._contact,
      air: car.airborne,
      boost: +w.driver.boost.toFixed(3),
      stranded: +car.strandedFor.toFixed(2),
      /* Why the race did or did not grant the turn-around more time. */
      rec: w.driver.rec ? {
        t: +w.driver.rec.t.toFixed(2), stale: +w.driver.rec.stale.toFixed(2),
        air: +w.driver.rec.air.toFixed(2), gear: w.driver.rec.gear,
        dir: w.driver.rec.dir, best: +w.driver.rec.best.toFixed(2),
        ok: w.driver.recovering,
      } : null,
    };
  };

  for (let i = 0; i < secs * 60; i++) {
    g.step(DT);
    if (p.strandedFor > 2.5) p.recover();
    if (!wired) race.step(DT, p);
    t += DT;

    for (const w of watched) {
      const car = w.car;
      if (car.finished) { w.ep = null; continue; }
      const f = g.track.frameAt(car.s);
      const facing = car.forward.dot(f.tan);
      const hw = f.width * 0.5;
      const steerRate = Math.abs(car.steer - w.prevSteer) / DT;
      w.prevSteer = car.steer;
      const cross = car.right.dot(f.tan);
      const flipped = w.prevCross !== undefined && Math.sign(cross) !== Math.sign(w.prevCross);
      w.prevCross = cross;

      if (!w.ep) {
        if (facing < ON) {
          w.ep = {
            name: w.name, seed, t0: +t.toFixed(2), start: snap(w),
            minFacing: facing, n: 0, held: 0, dur: null,
            frames: { wrongWay: 0, reverse: 0, wall: 0, sat: 0, air: 0, offRoad: 0, crossFlip: 0 },
            sum: { speed: 0, thr: 0, brk: 0, absSteer: 0, room: 0, absYaw: 0 },
            minRoom: 99, rates: [], rescues: rescued.get(car) || 0,
            trace: [], sMin: car.s, sMax: car.s,
          };
        }
      }
      const ep = w.ep;
      if (!ep) continue;

      ep.n++;
      ep.minFacing = Math.min(ep.minFacing, facing);
      if (facing < 0.25) ep.frames.wrongWay++;
      if (car.vx < -0.5) ep.frames.reverse++;
      if (car._contact) ep.frames.wall++;
      if (Math.abs(w.driver.steerSmooth) > 0.97) ep.frames.sat++;
      if (car.airborne) ep.frames.air++;
      if (Math.abs(car.lat) > hw) ep.frames.offRoad++;
      if (flipped) ep.frames.crossFlip++;
      ep.sum.speed += car.speed;
      ep.sum.thr += car.throttle;
      ep.sum.brk += car.brake;
      ep.sum.absSteer += Math.abs(car.steer);
      ep.sum.absYaw += Math.abs(car.r);
      ep.sum.room += hw + 1.05 - Math.abs(car.lat);
      ep.minRoom = Math.min(ep.minRoom, hw + 1.05 - Math.abs(car.lat));
      ep.rates.push(steerRate);
      ep.sMin = Math.min(ep.sMin, car.s); ep.sMax = Math.max(ep.sMax, car.s);
      if (ep.n % 6 === 1 && ep.trace.length < 400) ep.trace.push(snap(w));

      const now = rescued.get(car) || 0;
      if (now > ep.rescues && !norescue) {
        ep.outcome = 'teleport';
        ep.dur = +(t - ep.t0).toFixed(2);
        ep.end = preRescue.get(car) || snap(w);
        episodes.push(ep); w.ep = null; continue;
      }
      const backOnIt = strict
        ? (facing > OFF && Math.abs(car.lat) < hw - 1.5
          && car.vx > w.driver.targetSpeed(car.s) * 0.70)
        : (facing > OFF && car.vx > 6);
      if (backOnIt) {
        ep.held += DT;
        if (ep.held >= HOLD) {
          ep.outcome = 'recovered';
          ep.dur = +(t - ep.t0 - HOLD).toFixed(2);
          ep.end = snap(w);
          episodes.push(ep); w.ep = null; continue;
        }
      } else ep.held = 0;
      if (t - ep.t0 > 90) {
        ep.outcome = 'timeout';
        ep.dur = +(t - ep.t0).toFixed(2);
        ep.end = snap(w);
        episodes.push(ep); w.ep = null;
      }
    }
    if (race.standings().every(x => x.finished)) break;
  }

  // Finish the per-episode aggregates node-side wants, and drop the raw arrays.
  for (const ep of episodes) {
    const n = Math.max(ep.n, 1);
    ep.pct = {
      wrongWay: +(ep.frames.wrongWay / n * 100).toFixed(0),
      reverse: +(ep.frames.reverse / n * 100).toFixed(0),
      wall: +(ep.frames.wall / n * 100).toFixed(0),
      sat: +(ep.frames.sat / n * 100).toFixed(0),
      air: +(ep.frames.air / n * 100).toFixed(0),
      offRoad: +(ep.frames.offRoad / n * 100).toFixed(0),
    };
    ep.crossFlipsPerSec = +(ep.frames.crossFlip / Math.max(ep.dur, 0.1)).toFixed(2);
    ep.avg = {
      kmh: +(ep.sum.speed / n * 3.6).toFixed(1),
      thr: +(ep.sum.thr / n).toFixed(2),
      brk: +(ep.sum.brk / n).toFixed(2),
      steerDeg: +(ep.sum.absSteer / n * 180 / Math.PI).toFixed(1),
      yawRate: +(ep.sum.absYaw / n).toFixed(2),
      room: +(ep.sum.room / n).toFixed(2),
    };
    const r = ep.rates.slice().sort((a, b) => a - b);
    const q = f => +(r.length ? r[Math.min(r.length - 1, Math.floor(f * r.length))] * 180 / Math.PI : 0).toFixed(0);
    ep.steerRate = { p50: q(0.5), p90: q(0.9), p99: q(0.99) };
    ep.minRoom = +ep.minRoom.toFixed(2);
    ep.minFacing = +ep.minFacing.toFixed(3);
    ep.sGain = +(ep.sMax - ep.sMin).toFixed(0);
    delete ep.rates; delete ep.sum; delete ep.frames; delete ep.sMin; delete ep.sMax;
  }

  return {
    seed,
    finished: race.standings().filter(x => x.finished).length,
    rescues: race.entries.map(e => ({ name: e.name, n: e.recoveries })),
    episodes,
  };
};

const pct = (arr, f) => {
  if (!arr.length) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(f * s.length))];
};
const mean = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);

await run({ width: 480, height: 270, hash: 'manual' }, async ({ page }) => {
  const all = [];
  for (const seed of SEEDS) {
    const r = await page.evaluate(SIM, [seed, SKILL, SECS, NORESCUE, STRICT]);
    const spins = r.episodes.filter(e => e.minFacing < 0);
    process.stdout.write(`  seed ${String(seed).padStart(2)}  ` +
      `${String(r.episodes.length).padStart(3)} off-axis  ` +
      `${String(spins.length).padStart(3)} past 90°  ` +
      `teleports ${r.rescues.map(x => x.n).join('/')}\n`);
    all.push(r);
  }

  const eps = all.flatMap(r => r.episodes);
  const band = (label, list) => {
    if (!list.length) return console.log(`  ${label.padEnd(22)} none`);
    const d = list.map(e => e.dur);
    const tele = list.filter(e => e.outcome === 'teleport').length;
    console.log(`  ${label.padEnd(22)} n=${String(list.length).padStart(4)}  ` +
      `median ${pct(d, 0.5).toFixed(2)}s  mean ${mean(d).toFixed(2)}s  ` +
      `p90 ${pct(d, 0.9).toFixed(2)}s  p99 ${pct(d, 0.99).toFixed(2)}s  ` +
      `max ${Math.max(...d).toFixed(2)}s   teleported ${tele} (${(tele / list.length * 100).toFixed(0)}%)`);
  };

  console.log(`\n─── recovery duration, ${SEEDS.length} seeds, ${eps.length} episodes ───\n`);
  band('all off-axis', eps);
  band('slide 60-90°', eps.filter(e => e.minFacing >= 0));
  band('spun past 90°', eps.filter(e => e.minFacing < 0));
  band('spun past 135°', eps.filter(e => e.minFacing < -0.707));

  const spins = eps.filter(e => e.minFacing < 0);
  if (spins.length) {
    const f = k => mean(spins.map(e => e.pct[k])).toFixed(0);
    const a = k => mean(spins.map(e => e.avg[k])).toFixed(2);
    console.log(`\n  during a spin episode, averaged over ${spins.length}:`);
    console.log(`    in the driver's turn-around branch  ${f('wrongWay')}% of frames`);
    console.log(`    steering command at full lock       ${f('sat')}%`);
    console.log(`    rolling backwards (vx < -0.5)       ${f('reverse')}%`);
    console.log(`    touching the wall                   ${f('wall')}%`);
    console.log(`    past the road edge                  ${f('offRoad')}%`);
    console.log(`    airborne                            ${f('air')}%`);
    console.log(`    mean speed ${a('kmh')} km/h   mean |steer| ${a('steerDeg')}°  ` +
      `mean |yaw rate| ${a('yawRate')} rad/s   mean room to wall ${a('room')} m`);
    console.log(`    turn-around steer sign flips        ${mean(spins.map(e => e.crossFlipsPerSec)).toFixed(2)} /s`);
    console.log(`    wheel rate during episode: p50 ${mean(spins.map(e => e.steerRate.p50)).toFixed(0)}°/s  ` +
      `p90 ${mean(spins.map(e => e.steerRate.p90)).toFixed(0)}°/s  ` +
      `p99 ${mean(spins.map(e => e.steerRate.p99)).toFixed(0)}°/s`);

    /* Where. If the long ones cluster against a wall or on a climb that is a
       different fix from if they are scattered down the middle of the road. */
    const long = spins.filter(e => e.dur > 5);
    console.log(`\n  ${long.length} of ${spins.length} spins took over 5 s.` +
      (long.length ? `  Of those: ${long.filter(e => e.minRoom < 1.5).length} had under 1.5 m to the wall,` +
        ` ${long.filter(e => e.start.grade > -0.02).length} on flat-or-uphill,` +
        ` ${long.filter(e => e.pct.wall > 20).length} leaning on the wall for 20%+ of it,` +
        ` ${long.filter(e => Math.abs(e.start.curv) > 0.015).length} in a tight corner.` : ''));

    console.log(`\n  worst ${WORST}:`);
    for (const e of spins.sort((x, y) => y.dur - x.dur).slice(0, WORST)) {
      console.log(`   seed ${String(e.seed).padStart(2)} ${e.name.padEnd(7)} t=${String(e.t0).padStart(6)}s ` +
        `${String(e.dur).padStart(6)}s ${e.outcome.padEnd(9)} s=${String(e.start.s).padStart(6)} ` +
        `worst head ${String(Math.round(Math.acos(Math.max(-1, e.minFacing)) * 180 / Math.PI)).padStart(3)}°  ` +
        `arc gained ${String(e.sGain).padStart(4)} m  ` +
        `wrongWay ${String(e.pct.wrongWay).padStart(3)}%  sat ${String(e.pct.sat).padStart(3)}%  ` +
        `rev ${String(e.pct.reverse).padStart(3)}%  wall ${String(e.pct.wall).padStart(3)}%  ` +
        `room ${String(e.minRoom).padStart(5)} m  avg ${String(e.avg.kmh).padStart(5)} km/h  ` +
        `grade ${e.start.grade}`);
    }
  }

  const totalTele = all.reduce((t, r) => t + r.rescues.reduce((a, x) => a + x.n, 0), 0);
  console.log(`\n  teleport rescues across the sweep: ${totalTele} ` +
    `(${(totalTele / SEEDS.length).toFixed(1)} per race, ${(totalTele / SEEDS.length / 3).toFixed(1)} per rival)`);

  if (JSON_OUT) {
    const file = path.isAbsolute(JSON_OUT) ? JSON_OUT : path.join(ROOT, JSON_OUT);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ seeds: SEEDS, secs: SECS, skill: SKILL, runs: all }, null, 1));
    console.log(`  → ${file}`);
  }
});

finish(process.exitCode || 0);
