/* Why an off-axis rival is not coming back, resolved by heading error.
 *
 * tools/spin.mjs measures episodes — how long each one took and how it ended.
 * That is the right shape for a verdict and the wrong shape for a diagnosis,
 * because an episode is slow for whatever its worst second was and the mean
 * hides which second that is. This walks the same races but bins every frame
 * by how far off the road the nose is, and reports, per bin, whether the
 * heading error is closing or opening and what the driver is actually
 * delivering to the wheels while it does.
 *
 * The two readings that matter:
 *
 *   d(head)/dt   negative means the car is coming back. The angle at which
 *                this changes sign is the angle past which the ordinary
 *                racing controller has lost the car, and therefore the angle
 *                at which the turn-around controller ought to be taking it.
 *
 *   wheel vs cmd the road-wheel angle actually reached against the command
 *                the driver asked for. A large gap means something between
 *                the two is eating the input — the air cut, the speed-
 *                dependent lock, or the steering rate limit.
 *
 * Airborne is split by how long the car has been off the ground, because the
 * driver's air cut does not distinguish a second of ramp flight from a wheel
 * skipping over a stone, and those want opposite treatment.
 *
 *   node tools/recdiag.mjs [--seeds 1..8] [--secs 420] [--skill 0.85]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const parseSeeds = (spec) => {
  const m = /^(\d+)\.\.(\d+)$/.exec(spec);
  if (!m) return spec.split(',').map(Number);
  const out = [];
  for (let i = +m[1]; i <= +m[2]; i++) out.push(i);
  return out;
};
const SEEDS = parseSeeds(flag('seeds', '1..8'));
const SECS = +flag('secs', 420);
const SKILL = +flag('skill', 0.85);

const SIM = async ([seed, skill, secs]) => {
  const { Race } = await import('/src/race/index.js');
  const { steerLockAt } = await import('/src/car/physics.js');
  const g = window.__game;
  const p = g.player;

  // Same setup as tools/spin.mjs and tools/race.mjs, so this is the same run.
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

  const DT = 1 / 60;
  /* Five-degree bins to 100, then one bin for everything beyond: past 100 the
     car is simply backwards and the distinctions stop meaning anything. */
  const NB = 21;
  const bin = (deg) => Math.min(NB - 1, Math.floor(deg / 5));
  const mk = () => ({
    n: 0, dhead: 0, absd: 0, slip: 0, air: 0, off: 0, rec: 0,
    cmd: 0, wheel: 0, lock: 0, kmh: 0, flick: 0, flight: 0, brk: 0, thr: 0,
    /* Signed along-car velocity and across-car velocity, kept apart because
       `speed` is their hypotenuse and a car doing 90 km/h of which 75 is
       sideways is a completely different problem from one doing 90 forwards.
       `rev` is the reverse leg of the three-point turn, `stale` the seconds
       the controller has admitted to getting nowhere. */
    vx: 0, avy: 0, rev: 0, stale: 0, ground: 0, gbrk: 0, gthr: 0,
  });
  const on = Array.from({ length: NB }, mk);    // turn-around controller running
  const off = Array.from({ length: NB }, mk);   // and not

  /* The forward leg's speed law is `throttle = clamp((REC_SPEED - vx)*0.5, 0,
     0.85)` with the brake left alone, so for any vx above REC_SPEED it asks
     for nothing at all and the car simply coasts. On a descent that is not a
     neutral choice. Count how much of the manoeuvre is spent there, and how
     fast the car is while it is. */
  const REC_SPEED = 7.0;
  const dead = { n: 0, kmh: 0, vx: 0, avy: 0, head: 0 };
  const leg = { fwd: 0, rev: 0, fwdCoast: 0 };

  /* "Flicker" is airborne for less than the time it takes the springs to
     notice — the same 0.2 s the physics uses to decide a kerb hop should not
     pitch the car. Anything longer is flight the driver should respect. */
  const FLICK = 0.20;

  const prev = new Map();
  for (let i = 0; i < secs * 60; i++) {
    g.step(DT);
    if (p.strandedFor > 2.5) p.recover();
    if (!wired) race.step(DT, p);

    for (const e of race.entries) {
      const car = e.car;
      if (car.finished) { prev.delete(car); continue; }
      const f = g.track.frameAt(car.s);
      const facing = Math.max(-1, Math.min(1, car.forward.dot(f.tan)));
      const deg = Math.acos(facing) * 180 / Math.PI;
      const was = prev.get(car);
      prev.set(car, deg);
      if (was === undefined) continue;

      const b = bin(deg);
      const A = (e.driver.rec ? on : off)[b];
      A.n++;
      const d = (deg - was) / DT;
      A.dhead += d;
      A.absd += Math.abs(d);
      A.slip += Math.abs(car.slipAngle) * 180 / Math.PI;
      if (car.airborne) {
        A.air++;
        if (car.airTime < FLICK) A.flick++; else A.flight++;
      }
      if (Math.abs(car.lat) > f.width * 0.5) A.off++;
      A.cmd += Math.abs(e.driver.steerSmooth);
      A.wheel += Math.abs(car.steer) * 180 / Math.PI;
      A.lock += steerLockAt(car.speed) * 180 / Math.PI;
      A.kmh += car.kmh;
      A.brk += car.brake; A.thr += car.throttle;
      A.vx += car.vx; A.avy += Math.abs(car.vy);
      if (e.driver.rec) {
        if (e.driver.rec.gear < 0) A.rev++; else leg.fwd++;
        if (e.driver.rec.gear < 0) leg.rev++;
        A.stale += e.driver.rec.stale;
        if (e.driver.rec.gear > 0 && car.vx > REC_SPEED) {
          leg.fwdCoast++;
          dead.n++; dead.kmh += car.kmh; dead.vx += car.vx;
          dead.avy += Math.abs(car.vy); dead.head += deg;
        }
      }
      /* Pedals only count for something on a frame the tyres are down: the
         whole drivetrain sits inside `grounded`, so brake asked for in the
         air is brake that never happened. */
      if (!car.airborne) { A.ground++; A.gbrk += car.brake; A.gthr += car.throttle; }
    }
    if (race.standings().every(x => x.finished)) break;
  }
  return { seed, on, off, dead, leg };
};

const add = (a, b) => {
  for (let i = 0; i < a.length; i++) {
    for (const k of Object.keys(a[i])) a[i][k] += b[i][k];
  }
};

await run({ width: 480, height: 270, hash: 'manual' }, async ({ page }) => {
  let ON = null, OFF = null;
  const DEAD = { n: 0, kmh: 0, vx: 0, avy: 0, head: 0 };
  const LEG = { fwd: 0, rev: 0, fwdCoast: 0 };
  for (const seed of SEEDS) {
    const r = await page.evaluate(SIM, [seed, SKILL, SECS]);
    if (!ON) { ON = r.on; OFF = r.off; } else { add(ON, r.on); add(OFF, r.off); }
    for (const k of Object.keys(DEAD)) DEAD[k] += r.dead[k];
    for (const k of Object.keys(LEG)) LEG[k] += r.leg[k];
    process.stdout.write(`  seed ${String(seed).padStart(2)} done\n`);
  }

  const table = (label, B) => {
    console.log(`\n─── ${label} ───`);
    console.log('  head err     sec   d(head)/dt  |d/dt|   |slip|   air%  flick%  flight%   off%    cmd  wheel   lock   km/h     vx    |vy|   rev%  stale   thr    brk  gthr  gbrk');
    for (let i = 0; i < B.length; i++) {
      const A = B[i];
      if (A.n < 60) continue;      // under a second across the whole sweep
      const m = k => A[k] / A.n;
      const gm = k => (A.ground ? A[k] / A.ground : NaN);
      console.log(
        `  ${String(i * 5).padStart(3)}-${String(i * 5 + 5).padStart(3)}  ` +
        `${(A.n / 60).toFixed(0).padStart(6)}  ` +
        `${m('dhead').toFixed(1).padStart(11)}  ${m('absd').toFixed(1).padStart(6)}  ` +
        `${m('slip').toFixed(0).padStart(7)}  ` +
        `${(A.air / A.n * 100).toFixed(0).padStart(5)}  ` +
        `${(A.flick / A.n * 100).toFixed(0).padStart(6)}  ` +
        `${(A.flight / A.n * 100).toFixed(0).padStart(7)}  ` +
        `${(A.off / A.n * 100).toFixed(0).padStart(5)}  ` +
        `${m('cmd').toFixed(2).padStart(5)}  ${m('wheel').toFixed(1).padStart(5)}  ` +
        `${m('lock').toFixed(1).padStart(5)}  ${m('kmh').toFixed(0).padStart(5)}  ` +
        `${m('vx').toFixed(1).padStart(6)}  ${m('avy').toFixed(1).padStart(6)}  ` +
        `${(A.rev / A.n * 100).toFixed(0).padStart(5)}  ${m('stale').toFixed(2).padStart(5)}  ` +
        `${m('thr').toFixed(2).padStart(4)}  ${m('brk').toFixed(2).padStart(5)}  ` +
        `${gm('gthr').toFixed(2).padStart(4)}  ${gm('gbrk').toFixed(2).padStart(4)}`);
    }
  };
  table('turn-around controller NOT running', OFF);
  table('turn-around controller running', ON);

  /* The one number the whole diagnosis turns on: where, with nothing trying
     to turn the car around, the heading error stops closing and starts
     opening. Interpolated across the sign change so it does not simply
     report a bin edge. */
  let cross = null;
  for (let i = 1; i < OFF.length; i++) {
    const a = OFF[i - 1], b = OFF[i];
    if (a.n < 60 || b.n < 60) continue;
    const da = a.dhead / a.n, db = b.dhead / b.n;
    if (da < 0 && db > 0) {
      cross = (i - 1) * 5 + 2.5 + 5 * (-da / (db - da));
      break;
    }
  }
  console.log(`\n  heading error stops closing at about ${cross === null ? '—' : cross.toFixed(0) + ' deg'}` +
    `   (REC_ENTER is cos 0.25 = 75.5 deg)`);

  const legTot = LEG.fwd + LEG.rev;
  console.log(`\n─── the manoeuvre's two legs ───`);
  console.log(`  forward leg  ${(LEG.fwd / 60).toFixed(0)}s  (${(LEG.fwd / legTot * 100).toFixed(0)}%)` +
    `      reverse leg  ${(LEG.rev / 60).toFixed(0)}s  (${(LEG.rev / legTot * 100).toFixed(0)}%)`);
  if (DEAD.n) {
    const m = k => DEAD[k] / DEAD.n;
    console.log(`  forward leg above REC_SPEED, so asking for neither throttle nor brake:`);
    console.log(`    ${(DEAD.n / 60).toFixed(0)}s  — ${(DEAD.n / LEG.fwd * 100).toFixed(0)}% of the forward leg,` +
      ` ${(DEAD.n / legTot * 100).toFixed(0)}% of the whole manoeuvre`);
    console.log(`    while there: ${m('kmh').toFixed(0)} km/h   vx ${m('vx').toFixed(1)} m/s` +
      `   |vy| ${m('avy').toFixed(1)} m/s   heading error ${m('head').toFixed(0)} deg`);
  }
});

finish(process.exitCode || 0);
