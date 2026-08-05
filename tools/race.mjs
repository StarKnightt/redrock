/* Does the race actually race?
 *
 * Runs the full four-car field down the stage in accelerated time, several
 * seeds at a time, and reports the things that decide whether the racing is
 * any good: finishing order and times, the spread of the field, how often the
 * lead changed, what fraction of the run the player had someone within two
 * seconds, contact count, recoveries, and what Race.step costs per frame.
 *
 * Two extra scenarios drive the player deliberately slowly and deliberately
 * fast, to confirm the rubber band pulls in both directions instead of just
 * flattering one kind of driver.
 *
 * Then TWO pass/fail gates, and they are two rather than one on purpose. The
 * band a rival gets is the sum of a player-fairness term and a field-cohesion
 * term, the two are independent by construction, and this tool used to read the
 * SUM and call it the rubber band. It therefore went red when a rival dropped
 * off the back of the field — a cohesion event the player neither caused nor
 * could see — and, before the Track.project freeze fix, it went GREEN because
 * one rival was 173 m off the back for a reason that was a bug. See
 * .fix/FINDINGS-band.md for the measurements and .fix/FINDINGS-pin.md §7 for
 * how it was found. So: `player band` reads the player half under the player's
 * name, `pack cohesion` reads the other half under its own, per car and signed,
 * and neither can ever be paid for by the other.
 *
 *   node tools/race.mjs [tag] [--seeds 1,2,3] [--skill 0.85] [--secs 420]
 *                       [--shots 0]
 *
 * --break catch|drop|pack|rubber|detach
 *   Damage the band on purpose and watch the gates go red. This is how a
 *   redefined gate is shown to have teeth; see TEETH below for what each one
 *   is supposed to break and which gate is supposed to notice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = (args[0] && !args[0].startsWith('--')) ? args[0] : 'race';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '1,2,3').split(',').map(Number);
const SKILL = +flag('skill', 0.85);
const SECS = +flag('secs', 420);
const SHOTS = flag('shots', '1') !== '0';
const NO_MECH = args.includes('--nomech');
const NO_LAUNCH = args.includes('--nolaunch');
const NO_PADS = args.includes('--nopads');
const BREAK = flag('break', '');

/* The bars, in one place because the whole point of this round is that a bar
 * has to be sized against the ceiling the shape actually has.
 *
 * BAND.catch is 0.05, so +0.03 is 60% of everything the player term can ever be
 * worth: a build whose catch has regressed by 40% fails here. BAND.drop plus
 * BAND.dropFar is 0.22, so −0.07 is a third of it — looser, and that asymmetry
 * is inherited from the constants rather than chosen. Both numbers are the ones
 * this tool has always used; what changed is that they are now applied to the
 * player half alone instead of to the player half plus whatever the field
 * happened to be doing.
 *
 * PACK.catch is 0.13 and PACK.hold is 0.34, and the cohesion probe saturates
 * both, so its bars sit at 77% and 74% of the respective ceilings.
 */
const CLEAR_AHEAD_MIN = 1.03;   // rivals behind the player must be lifted
const DROPPED_MAX = 0.93;       // rivals ahead of it must be trimmed
/* Inside BAND.dead the player term is specified to be exactly nothing. This is
   the anchor that stops the gate being one nobody can fail: the two readings
   above sit hard against the shape's rails, so a probe stuck at a rail would
   pass them both, and only a zero here can tell a curve from a constant. */
const LEVEL_EPS = 0.002;
/* How near parity the dead-zone read has to get for the zero above to mean
 * anything. Derived from the shape rather than picked: `BAND.dead` is 0.6 s, and
 * at 1.0 s the declared player term is 0.05·ss(0.6, 8, 1.0) = 0.0004 on the
 * catch side and 0.10·ss(0.6, 7, 1.0) = 0.0011 on the drop side — both under
 * LEVEL_EPS. So anything inside a second of parity is a place where a correct
 * band reads 1.000 to this tolerance and a band stuck at either rail reads 1.05
 * or 0.78. Not BAND.dead itself, because the probe sits 6 m behind the car it is
 * reading — it may not sit on top of it, the contact envelope is 3.9 m long —
 * and 6 m is 0.6 s for a rival doing 36 km/h through a slow corner. */
const LEVEL_MAX_GAPT = 1.0;
const PACK_BACK_MIN = 0.10;     // a rival off the BACK must be lifted
const PACK_FRONT_MAX = -0.25;   // one off the FRONT must be held
/* `band` is specified to BE `1 + bandPlayer + bandPack`. Checked rather than
   trusted, because everything below reads the halves. */
const HALVES_RESID_MAX = 1e-9;

const outDir = path.join(ROOT, 'shots', tag);
if (SHOTS) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
}

/* One full race, simulated the way the game loop runs it: g.step() advances
   the player at 120 Hz substeps and — once main.js has the wiring — the
   field too. Returns everything the verdict needs; printing is node-side. */
const RACE_SIM = async ([seed, skill, secs, playerBoost, raceOpts]) => {
  const { Race } = await import('/src/race/index.js');
  const g = window.__game;
  const p = g.player;

  if (g.race) g.race.dispose();
  const race = new Race(g.track, g.scene, { seed, ...(raceOpts || {}) });
  g.race = race;

  /* Cost is measured with a wrapper rather than around a call site, because
     the call site may be inside main.js: once the game wires g.race into its
     own step(), this tool must NOT step the race as well. Every opponent
     would live at double time relative to the player — permanently "ahead",
     throttled to the band's floor, and finishing on a clock the standings
     cannot compare. Detect the wiring by watching the race clock across one
     game step, then undo the probe step with a full reset. */
  let stepMs = 0, stepMsMax = 0;
  const rawStep = race.step.bind(race);
  race.step = (d, pl) => {
    const t0 = performance.now();
    rawStep(d, pl);
    const ms = performance.now() - t0;
    stepMs += ms; if (ms > stepMsMax) stepMsMax = ms;
  };
  g.botInput = { steer: 0, throttle: 0, brake: 1, handbrake: 0 };
  g.step(1 / 60);
  const wired = race._clock > 0;
  window.__game.__raceDriven = wired;
  race.reset();
  stepMs = 0; stepMsMax = 0;

  g.botInput = null;
  g.autopilot(true, skill);
  g.bot.wobble = 5;              // Driver seeds this from Math.random; pin it
  g.bot.boost = playerBoost || 1;
  p.placeAt(34, 0); p.vx = 0; p.vy = 0; p.r = 0;
  p.raceTime = 0; p.finished = false;
  p.rpm = 1050; p.gear = 0;
  /* The game's own clock, not the car's. Slow motion can leave part of a
     substep unspent, and starting the next race on a different phase of the
     accumulator is enough to make the same seed produce a different race. */
  g.resetSimClock();

  const DT = 1 / 60;
  let frames = 0;
  let leadChanges = 0, lastLeader = null;
  let closeFrames = 0, raceFrames = 0, playerRecoveries = 0;
  let bandMin = 9, bandMax = 0;
  /* Band averages conditioned on which side of the player a car is, which is
     what "responds in both directions" actually means — and taken over the
     PLAYER HALF of the band rather than over the whole of it. The whole of it
     also carries the pack term, which is a fact about the field's own shape and
     is not conditioned on the player at all, so averaging it either side of the
     player mixes a signal with something that has no opinion. */
  let behindSum = 0, behindN = 0, aheadSum = 0, aheadN = 0;

  for (let i = 0; i < secs * 60; i++) {
    g.step(DT);
    if (p.strandedFor > 2.5) { p.recover(); playerRecoveries++; }
    if (!wired) race.step(DT, p);
    frames++;

    const st = race.standings();
    if (lastLeader && st[0].car !== lastLeader) leadChanges++;
    lastLeader = st[0].car;

    if (!p.finished) {
      raceFrames++;
      const d = race.deltaFor(p);
      if (d !== null && Math.abs(d) < 2) closeFrames++;
      for (const e of race.entries) {
        if (e.finished) continue;
        bandMin = Math.min(bandMin, e.band);
        bandMax = Math.max(bandMax, e.band);
        const gapT = (p.s - e.car.s) / Math.max(p.speed, e.car.speed, 10);
        if (gapT > 1) { behindSum += 1 + e.bandPlayer; behindN++; }
        else if (gapT < -1) { aheadSum += 1 + e.bandPlayer; aheadN++; }
      }
    }
    if (st.every(x => x.finished)) break;
  }

  return {
    seed, skill, playerBoost: playerBoost || 1, wired,
    stepAvgMs: +(stepMs / frames).toFixed(4),
    stepMaxMs: +stepMsMax.toFixed(2),
    leadChanges,
    closePct: +((closeFrames / Math.max(raceFrames, 1)) * 100).toFixed(0),
    collisions: race.collisions,
    playerRecoveries,
    band: {
      min: +bandMin.toFixed(3), max: +bandMax.toFixed(3),
      behind: behindN ? +(behindSum / behindN).toFixed(3) : null,
      ahead: aheadN ? +(aheadSum / aheadN).toFixed(3) : null,
    },
    standings: race.standings().map(x => ({
      name: x.name, isPlayer: x.isPlayer, finished: x.finished,
      time: +x.time.toFixed(2), s: +x.s.toFixed(0), recoveries: x.recoveries,
    })),
  };
};

function report(r, label) {
  const st = r.standings;
  const times = st.filter(x => x.finished).map(x => x.time);
  const margin = times.length >= 2 ? times[times.length - 1] - times[0] : null;
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;

  console.log(`\n  ${label}`);
  for (const x of st) {
    const who = (x.isPlayer ? 'PLAYER' : x.name).padEnd(7);
    const state = x.finished ? `${x.time.toFixed(2)}s` : `DNF at ${x.s} m (t=${x.time.toFixed(0)}s)`;
    console.log(`    P${st.indexOf(x) + 1}  ${who} ${state}` +
      (x.recoveries ? `  (${x.recoveries} recoveries)` : ''));
  }
  console.log(`    all finished: ${st.every(x => x.finished) ? 'yes' : 'NO'}` +
    `   1st→last ${margin === null ? '—' : margin.toFixed(1) + 's'}` +
    `   avg adjacent gap ${avgGap === null ? '—' : avgGap.toFixed(1) + 's'}`);
  console.log(`    lead changes ${r.leadChanges}   within 2s of player ${r.closePct}% of race` +
    `   collisions ${r.collisions}   player recoveries ${r.playerRecoveries}`);
  console.log(`    boost ${r.band.min}–${r.band.max}` +
    ` (player half avg ${r.band.behind ?? '—'} for a rival behind,` +
    ` ${r.band.ahead ?? '—'} for one ahead)` +
    `   Race.step avg ${r.stepAvgMs} ms, worst ${r.stepMaxMs} ms`);
  return { margin, avgGap };
}

/* ---- the band stand ------------------------------------------------------
 *
 * A stand and not a scenario, and that distinction is the repair.
 *
 * The old probe raced for 45 s, teleported the player 260 m, stepped 8 s and
 * read the mean of `e.band`. Every one of those four decisions was wrong in a
 * way that showed up as a number nobody could account for:
 *
 *  - it never put the game back to a known state, so it inherited the
 *    sim-clock phase and the slow-motion latch of whatever ran before it;
 *  - it assumed `__raceDriven` rather than measuring it, which is only true
 *    because five race scenarios happen to run first — the same assumption run
 *    standalone steps the field twice and moves every rival at double time;
 *  - 260 METRES is a gap on a curve whose every constant is in SECONDS, so
 *    where it lands is decided by how fast the field happens to be going;
 *  - 8 s is 97% of a 0.45/s first-order lag, sampled after a step from the
 *    opposite rail, compared against a steady-state bar;
 *  - and `e.band` is the sum of two independent terms, only one of which the
 *    gate is named after.
 *
 * So: known state, detected wiring, gaps commanded in seconds, held until the
 * lag has converged, and the two halves read separately. Everything the stand
 * asserts is a property `src/race/index.js` states about itself in prose —
 * a dead zone, a ceiling, a sign — rather than a number this file has tuned.
 */
const STAND = async ([seed, brk]) => {
  const { Race, BAND, PACK } = await import('/src/race/index.js');
  const g = window.__game;
  const p = g.player;

  /* TEETH. A build that deserves to fail, on request, so a gate that has been
     redefined can be shown to still bite. Never reached without --break, and
     these write to the objects the game itself reads — this is a different
     build, not a probe setting.
       catch   BAND.catch 0.05 → 0.02, a 60% regression in the half the player
               can see. `player band` must go red in the catch direction only.
       drop    the same to the other direction.
       pack    PACK zeroed. `pack cohesion` must go red and `player band` must
               NOT — that pair is the whole separation, demonstrated.
       rubber  the band switched off entirely. Both gates red.
       detach  the band untouched, one rival held 600 m off the back of the
               field. This is the shape of the regression that made this tool
               red an hour ago. `player band` must stay GREEN, `pack cohesion`
               must report the detachment, and the legacy avgBand this tool
               used to gate on is printed alongside so it can be seen going red
               on a build whose player fairness is perfect. */
  if (brk === 'catch') BAND.catch = 0.02;
  if (brk === 'drop') { BAND.drop = 0.02; BAND.dropFar = 0.02; }
  if (brk === 'pack') { PACK.catch = 0; PACK.hold = 0; }

  if (g.race) g.race.dispose();
  const race = new Race(g.track, g.scene, { seed, rubber: brk !== 'rubber' });
  g.race = race;
  /* THE CALL THE OLD PROBE DID NOT MAKE. It is the only thing that puts the
     sim-clock phase, the slow-motion latch, the ending, the countdown and the
     effects back to the top; `placeAt` and `autopilot` between them cover most
     of it by accident, which is why the omission was survivable and not why it
     was correct. Measured on seed 1: adding it changes the reading by nothing.
     It is here so that stays true of the next thing that runs before it. */
  g.restart();
  g.autopilot(true, 0.85);
  g.bot.wobble = 5;              // Driver seeds this from Math.random; pin it
  g.bot.boost = 1;

  const grid = () => {
    race.reset();
    p.placeAt(34, 0);
    p.raceTime = 0; p.finished = false; p.rpm = 1050; p.gear = 0;
    g.resetSimClock();
  };

  /* Detected, never assumed. main.js steps `this.race` itself, so a tool that
     also steps it runs every opponent at double time — which is exactly what
     defeated tools/rlband.mjs, by a clean factor of two in ground covered.
     Watch the race clock across one game step, then undo the probe step. */
  g.botInput = { steer: 0, throttle: 0, brake: 1, handbrake: 0 };
  grid();
  g.step(1 / 60);
  const wired = race._clock > 0;
  g.__raceDriven = wired;
  g.botInput = null;
  grid();

  const step1 = () => {
    g.step(1 / 60);
    if (p.strandedFor > 2.5) p.recover();
    if (!wired) race.step(1 / 60, p);
  };
  /* Never past the flag. A finished car is outside the band by design
     (`_rubber` returns 1), so a stand that parks the player over the line
     measures nothing and reads 1.000 while doing it. */
  const roomy = s => Math.min(g.track.finishS - 250, Math.max(6, s));

  /* 30 s of real racing before anything is commanded, so the speeds, gears and
     lines the band is read against are a race's and not a stand's. 20 s to
     converge: at BAND.rate 0.45/s that is 1 − e^−9, which is four decimal
     places of a steady state, against the 8 s the old probe allowed.
     600 m of displacement because the pack term is referenced to the field
     MEAN: one car D metres clear of the other two sits 2D/3 from that mean, so
     saturating a 320 m PACK.full takes 480 and 600 leaves margin. */
  const SETTLE = 30, CONVERGE = 20, DETACH = 600;

  /* --break detach: one rival held off the back for the whole of the band
     measurement, which is the shape of the cohesion event that used to read as
     player unfairness. A no-op otherwise. */
  const detachHold = brk === 'detach' ? race.entries[0] : null;
  const pin = () => {
    if (!detachHold) return;
    const others = race.entries.filter(e => e !== detachHold).map(e => e.car);
    const om = others.reduce((a, c) => a + c.s, 0) / others.length;
    detachHold.car.placeAt(roomy(om - DETACH), 0);
  };

  /**
   * @param label
   * @param subject the one car this read is ABOUT, when it is about one car.
   *   Both the dead-zone check and both cohesion checks are per-car and signed
   *   on purpose: the mean over the field is exactly the quantity that let a
   *   detached rival read as player unfairness, so nothing here may be decided
   *   by one. The mean is still computed, and only so that it can be seen not
   *   being the thing that decides.
   */
  const read = (label, subject = null) => {
    const n = race.entries.length;
    const rows = race.entries.map(e => ({
      name: e.name,
      s: +e.car.s.toFixed(0),
      kmh: +(e.car.speed * 3.6).toFixed(0),
      gapT: +((p.s - e.car.s) / Math.max(p.speed, e.car.speed, 10)).toFixed(2),
      /* The player half of the multiplier, as a multiplier: this is what the
         gate above used to think it was reading out of `e.band`. */
      player: +(1 + e.bandPlayer).toFixed(4),
      pack: +e.bandPack.toFixed(4),
      band: +e.band.toFixed(4),
      boost: +e.driver.boost.toFixed(3),
      resid: Math.abs(e.band - (1 + e.bandPlayer + e.bandPack)),
    }));
    const mean = k => rows.reduce((a, r) => a + r[k], 0) / n;
    const sub = subject ? rows[race.entries.indexOf(subject)] : null;
    return {
      label, rows,
      subject: sub ? sub.name : null,
      subjectPlayer: sub ? sub.player : null,
      subjectPack: sub ? sub.pack : null,
      subjectGapT: sub ? sub.gapT : null,
      othersPack: sub
        ? +(rows.filter(r => r !== sub).reduce((a, r) => a + r.pack, 0)
          / (n - 1)).toFixed(4)
        : null,
      spread: +(Math.max(...rows.map(r => r.s)) - Math.min(...rows.map(r => r.s))).toFixed(0),
      playerS: +p.s.toFixed(0),
      player: +mean('player').toFixed(4),
      pack: +mean('pack').toFixed(4),
      boost: +mean('boost').toFixed(3),
      /* What this tool gated on until now, kept as a REPORTED number so the
         redefinition can be audited instead of asserted. Never a pass/fail. */
      legacyAvgBand: +mean('band').toFixed(3),
      resid: Math.max(...rows.map(r => r.resid)),
    };
  };

  /* Hold the player at a commanded gap and let the lag converge.
   *
   * @param gapT seconds. POSITIVE puts the player ahead of the field, which is
   *   the sign `_rubber` treats as "this rival is behind" and lifts — the catch
   *   direction. Negative is the drop one. In seconds because BAND is: dead
   *   0.6, catchAt 8, dropAt 7, dropFarAt 22.
   * @param onCar sit 6 m behind ONE named rival instead, for the dead-zone
   *   read. A gap from the field's mean cannot deliver one: by the time the
   *   field has strung out, "level with the mean" is several seconds away from
   *   every car in it. One named car and not "whichever is in the middle now",
   *   so the car being read has been inside the dead zone for the whole
   *   convergence window rather than having wandered in. 6 m and not 0 because
   *   the contact envelope is 3.9 m long and a probe may not punt the car it is
   *   measuring.
   *
   * Re-placed every frame rather than teleported once, because a parked player
   * does not hold a gap — the old probe's "260 m behind" grew to 600 m over its
   * own 8 s window, and on the brake the car drove backwards while it did it.
   * The player is a fixture here, not a driver; what is under test is the
   * band's response to a gap, and the gap is the input.
   */
  /* The station at which EVERY rival is at least `gapT` away, in the band's own
   * units. Referenced to the extreme rival and to that rival's own speed, not
   * to the field's mean of either, and that is what makes the reading a
   * guarantee instead of an average: the bars below are applied to the mean
   * player half, so a stand that leaves one rival short of the knee is a stand
   * whose mean is part ramp. `gapT_i = (p.s − s_i) / max(p.speed, v_i, 10)` and
   * the player is a parked fixture here, so `max(v_i, 10)` is the whole
   * denominator and the inequality inverts exactly.
   *
   * It also means a strung-out field can still be measured. A stand referenced
   * to the mean cannot do that — with one rival 600 m off the back, "18 s ahead
   * of the mean" is 1 s ahead of one car and 58 ahead of another — and a
   * player-fairness gate that stops working precisely when the field detaches
   * is the gate this round exists to replace. */
  const station = gapT => {
    const vals = race.entries.map(e => e.car.s + gapT * Math.max(e.car.speed, 10));
    return gapT > 0 ? Math.max(...vals) : Math.min(...vals);
  };

  const hold = (secs, { gapT = 0, onCar = null } = {}) => {
    g.botInput = { steer: 0, throttle: 0, brake: 0, handbrake: 1 };
    let clipped = false;
    for (let i = 0; i < secs * 60; i++) {
      pin();
      const want = onCar ? onCar.car.s - 6 : station(gapT);
      const at = roomy(want);
      if (Math.abs(at - want) > 1) clipped = true;
      p.placeAt(at, 0);
      step1();
    }
    return clipped;
  };

  const runRace = secs => { for (let i = 0; i < secs * 60; i++) { pin(); step1(); } };

  g.botInput = null;
  runRace(SETTLE);
  const settled = read('30 s of racing, nothing commanded');
  /* Beyond BAND.catchAt (8 s) and BAND.dropFarAt (22 s) with a few seconds of
     margin, because the bars are steady-state values at the shape's rails and a
     reading taken on the ramp is a reading of wherever the probe happened to
     land — which is what 260 metres was.

     Catch first and drop second, because the drop needs road BEHIND the field
     and 30 s of settling has only put it 900 m down the stage: the catch hold
     carries the field another 700 m before the drop is asked for. The dead zone
     is LAST either way — the zero there has to be arrived at from a saturated
     rail rather than never having left it, because a probe that reads zero
     because it never moved is the shape of gate this project has nearly shipped
     twice. */
  const clipB = hold(CONVERGE, { gapT: +14 });
  const clearAhead = read('player clear ahead, rivals behind');
  const clipA = hold(CONVERGE, { gapT: -28 });
  const dropped = read('player dropped, rivals ahead');
  /* Whoever is in the middle of the field right now, and then that same car for
     the whole window — see `hold`'s onCar. */
  const midCar = [...race.entries].sort((a, b) => a.car.s - b.car.s)[
    (race.entries.length - 1) >> 1];
  hold(CONVERGE, { onCar: midCar });
  const level = read('player level with one rival', midCar);

  /* ---- cohesion, measured on its own terms -------------------------------
     Back to the grid and a fresh 30 s, because the holds above have left the
     field wherever they left it. Then ONE rival is held 600 m off the back and
     later 600 m off the front, and the number that matters is THAT CAR'S pack
     term — per car and signed. The mean is computed too, and only so that the
     thing that must never be a gate can be seen not being one. */
  g.botInput = null;
  grid();
  runRace(SETTLE);
  const subject = race.entries[0];
  const displace = (dir, label) => {
    g.botInput = { steer: 0, throttle: 0, brake: 0, handbrake: 1 };
    for (let i = 0; i < CONVERGE * 60; i++) {
      const others = race.entries.filter(e => e !== subject).map(e => e.car);
      const om = others.reduce((a, c) => a + c.s, 0) / others.length;
      subject.car.placeAt(roomy(om + dir * DETACH), 0);
      /* The player parked well clear: it has no vote on the pack term — that
         term is referenced to the rival field's own mean and the player is not
         in it — and this keeps it out of contact and out of the lane bias. */
      p.placeAt(roomy(om - 400), 0);
      step1();
    }
    return read(label, subject);
  };
  const offBack = displace(-1, 'one rival 600 m off the BACK');
  const offFront = displace(+1, 'one rival 600 m off the FRONT');

  return {
    seed, wired, brk,
    ceilings: {
      catch: BAND.catch, drop: BAND.drop + BAND.dropFar, dead: BAND.dead,
      catchAt: BAND.catchAt, dropFarAt: BAND.dropFarAt,
      packCatch: PACK.catch, packHold: PACK.hold,
    },
    clipped: clipA || clipB,
    band: { settled, dropped, clearAhead, level },
    cohesion: { offBack, offFront },
  };
};

/* Node-side verdict. Every check names the property it is testing, because a
   red line that does not say what broke is a red line somebody re-baselines. */
function judge(stands) {
  const fails = [];
  for (const st of stands) {
    const tag = `seed ${st.seed}`;
    const b = st.band, c = st.cohesion;
    const chk = (ok, what) => { if (!ok) fails.push(`${tag}: ${what}`); };

    chk(Math.max(b.settled.resid, b.dropped.resid, b.clearAhead.resid,
      b.level.resid, c.offBack.resid, c.offFront.resid) < HALVES_RESID_MAX,
      'band is not the sum of the two halves it reports');
    /* The bars are steady-state numbers at the shape's rails, so the check
       that the reading is AT a rail is part of the gate and not a formality.
       Asserted on the gap each rival actually had at the read instant, per car:
       the commanded gap is only a request, and early in a hold the stage can be
       too short to grant it. (`clipped` reports that it happened; it does not
       fail anything, because what the reading needs is the gap it had when it
       was read, and 20 s of convergence has long forgotten the first second.) */
    chk(b.clearAhead.rows.every(r => r.gapT >= st.ceilings.catchAt),
      `player band, rivals behind: not every rival was past BAND.catchAt`
      + ` ${st.ceilings.catchAt} s — gaps ${b.clearAhead.rows.map(r => r.gapT).join(', ')}`);
    chk(b.dropped.rows.every(r => r.gapT <= -st.ceilings.dropFarAt),
      `player band, rivals ahead: not every rival was past BAND.dropFarAt`
      + ` ${st.ceilings.dropFarAt} s — gaps ${b.dropped.rows.map(r => r.gapT).join(', ')}`);

    // player band
    chk(b.clearAhead.player > CLEAR_AHEAD_MIN,
      `player band, rivals behind: ${b.clearAhead.player} not > ${CLEAR_AHEAD_MIN}`);
    chk(b.dropped.player < DROPPED_MAX,
      `player band, rivals ahead: ${b.dropped.player} not < ${DROPPED_MAX}`);
    chk(Math.abs(b.level.subjectGapT) <= LEVEL_MAX_GAPT,
      `dead-zone check not exercised: ${b.level.subject} sat at gapT`
      + ` ${b.level.subjectGapT}, further than ${LEVEL_MAX_GAPT} s from parity`);
    chk(Math.abs(b.level.subjectPlayer - 1) < LEVEL_EPS,
      `player band inside the dead zone: ${b.level.subject} reads`
      + ` ${b.level.subjectPlayer}, not 1 to ${LEVEL_EPS}`);
    chk(b.dropped.player < b.level.subjectPlayer
      && b.level.subjectPlayer < b.clearAhead.player,
      'player band is not monotone across ahead / level / behind');

    // pack cohesion
    chk(c.offBack.subjectPack > PACK_BACK_MIN,
      `cohesion, rival off the back: ${c.offBack.subjectPack} not > ${PACK_BACK_MIN}`);
    chk(c.offFront.subjectPack < PACK_FRONT_MAX,
      `cohesion, rival off the front: ${c.offFront.subjectPack} not < ${PACK_FRONT_MAX}`);
  }
  return fails;
}

function showStand(st) {
  const line = (d, note = '') => {
    console.log(`    ${d.label.padEnd(36)} player ${d.player.toFixed(4)}`
      + `   pack ${d.pack.toFixed(4)}   boost ${d.boost.toFixed(3)}`
      + `   spread ${String(d.spread).padStart(4)} m`
      + `   [legacy avgBand ${d.legacyAvgBand}]${note}`);
    for (const r of d.rows) {
      console.log(`      ${(r.name || '?').padEnd(6)} s ${String(r.s).padStart(4)}`
        + ` ${String(r.kmh).padStart(4)} km/h   gapT ${String(r.gapT).padStart(7)}`
        + `   player ${r.player.toFixed(4)}   pack ${String(r.pack).padStart(7)}`
        + `   band ${r.band.toFixed(4)}   boost ${r.boost.toFixed(3)}`);
    }
  };
  console.log(`\n  seed ${st.seed}   field driven by`
    + ` ${st.wired ? 'main.js game loop' : 'this tool'}`
    + `   ceilings: player ±${st.ceilings.catch}/−${st.ceilings.drop.toFixed(2)},`
    + ` pack +${st.ceilings.packCatch}/−${st.ceilings.packHold}`
    + `   halves residual ≤ ${st.band.clearAhead.resid.toExponential(1)}`
    + (st.clipped ? '   (a commanded gap was clipped by the stage early in a'
      + ' hold; see the per-car gapT for what was actually read)' : ''));
  line(st.band.settled);
  line(st.band.dropped, `  bar < ${DROPPED_MAX}`);
  line(st.band.clearAhead, `  bar > ${CLEAR_AHEAD_MIN}`);
  line(st.band.level, `  ${st.band.level.subject} at gapT`
    + ` ${st.band.level.subjectGapT} reads ${st.band.level.subjectPlayer},`
    + ` bar 1±${LEVEL_EPS}`);
  for (const d of [st.cohesion.offBack, st.cohesion.offFront]) {
    line(d, `  subject ${d.subject} pack ${d.subjectPack}, others ${d.othersPack}`);
  }
}

await run({ width: 640, height: 360, hash: 'manual' }, async ({ page, errs, gl }) => {
  /* Render-cost baseline with no opponent on screen, from the start line,
     so the with-race numbers a few lines down are an apples-to-apples diff.
     The game builds its own field at boot, so "no opponents" has to be
     arranged by hiding them — disposing g.race would crash the rAF loop,
     which steps it between evaluates. */
  const base = await page.evaluate(() => {
    const g = window.__game;
    g.goTo(0.004);
    const views = g.race ? g.race.entries.map(e => e.view.root) : [];
    for (const v of views) v.visible = false;
    g.renderOnce();
    const info = g.info();
    for (const v of views) v.visible = true;
    return info;
  });

  /* The balance baseline. Ramps and pads are stage geometry — they cannot be
     taken out of a built track — but the three places they reach the
     simulation can be, and taking those out leaves the same stage with the
     mechanic switched off. That is the comparison the ±10% on lead changes
     and the ±1.5 s on spread are against; anything else compares two
     different builds. */
  if (NO_MECH || NO_LAUNCH || NO_PADS) {
    await page.evaluate(([noJump, noPad]) => {
      const t = window.__game.track;
      if (noJump) t.rampCrossed = () => null;
      if (noPad) { t.padCrossed = () => null; t.boostWindow = () => false; }
    }, [NO_MECH || NO_LAUNCH, NO_MECH || NO_PADS]);
    console.log(`  jumps ${NO_MECH || NO_LAUNCH ? 'OFF' : 'on'}, boost pads ${NO_MECH || NO_PADS ? 'OFF' : 'on'}`);
  }

  const all = [];
  for (const seed of SEEDS) {
    const r = await page.evaluate(RACE_SIM, [seed, SKILL, SECS]);
    if (!all.length) {
      console.log(`\n  field driven by: ${r.wired ? 'main.js game loop' : 'this tool'}`);
    }
    report(r, `seed ${seed}  (player skill ${SKILL})`);
    all.push(r);
  }

  /* Same seed twice must give the same race to the centimetre — the module
     is specified deterministic, so any drift here is a bug, not noise. */
  const again = await page.evaluate(RACE_SIM, [SEEDS[0], SKILL, SECS]);
  const same = JSON.stringify(again.standings) === JSON.stringify(all[0].standings);
  console.log(`\n  determinism (seed ${SEEDS[0]} re-run): ${same ? 'identical' : 'DIVERGED'}`);
  if (!same) process.exitCode = 1;

  /* Rubber band, both directions. Skill cannot make the bot meaningfully
     slower or faster (its pace is flat across the stable skill range), so
     the slow scenario cuts the player's own boost and the fast one runs the
     bot at its natural best. Both are reported for feel; the pass/fail is
     the teleport probe below, which puts the player unambiguously far ahead
     and far behind and reads the band's response directly. */
  const slow = await page.evaluate(RACE_SIM, [SEEDS[0], 0.75, SECS + 180, 0.88]);
  report(slow, `slow player  (boost 0.88, seed ${SEEDS[0]})`);
  const fast = await page.evaluate(RACE_SIM, [SEEDS[0], 0.85, SECS, 1.0]);
  report(fast, `fast player  (bot at natural best, seed ${SEEDS[0]})`);

  const stands = [];
  for (const seed of SEEDS) {
    stands.push(await page.evaluate(STAND, [seed, BREAK]));
  }
  console.log('\n  ─── band stand ' + (BREAK ? `[--break ${BREAK}] ` : '')
    + '───────────────────────────────────────');
  for (const st of stands) showStand(st);

  const fails = judge(stands);
  const s0 = stands[0].band;
  console.log(`\n  player band:   rivals behind ${s0.clearAhead.player}`
    + ` (bar > ${CLEAR_AHEAD_MIN}), rivals ahead ${s0.dropped.player}`
    + ` (bar < ${DROPPED_MAX}), level with ${s0.level.subject}`
    + ` ${s0.level.subjectPlayer} (bar 1±${LEVEL_EPS})`);
  console.log(`  pack cohesion: a rival off the back reads`
    + ` ${stands[0].cohesion.offBack.subjectPack}`
    + ` (bar > ${PACK_BACK_MIN}), one off the front`
    + ` ${stands[0].cohesion.offFront.subjectPack} (bar < ${PACK_FRONT_MAX})`);
  if (fails.length) {
    console.log(`\n  BAND GATES RED — ${fails.length} check(s):`);
    for (const f of fails) console.log('    ✗ ' + f);
    process.exitCode = 1;
  } else {
    console.log(`\n  band gates green on ${SEEDS.length} seed(s):`
      + ' player fairness responds in both directions and is nothing at parity;'
      + ' field cohesion pulls both ways under its own name.');
  }

  /* Render cost with the field on screen, same viewpoint as the baseline.
     The grid goes AHEAD of the player: a chase camera looks forward, and a
     field gridded behind it gets frustum-culled into a flattering number. */
  const withRace = await page.evaluate(async () => {
    const { Race } = await import('/src/race/index.js');
    const g = window.__game;
    if (g.race) g.race.dispose();
    g.race = new Race(g.track, g.scene, { seed: 1 });
    g.botInput = { steer: 0, throttle: 0, brake: 1, handbrake: 0 };
    g.goTo(0.004);
    g.race.reset(g.player.s + 32);
    g.race.step(1 / 60, g.player);
    g.renderOnce();
    return g.info();
  });
  console.log(`\n  render   baseline ${base.calls} calls / ${(base.triangles / 1000).toFixed(0)}k tris` +
    `   with field ${withRace.calls} calls / ${(withRace.triangles / 1000).toFixed(0)}k tris` +
    `   (+${withRace.calls - base.calls} calls, +${((withRace.triangles - base.triangles) / 1000).toFixed(0)}k tris)`);

  if (SHOTS) {
    /* Grid: field formed up behind the start, shot front-on from just up the
       road — close enough that palettes and stance are actually judgeable. */
    await page.evaluate(() => {
      const g = window.__game;
      g.botInput = { steer: 0, throttle: 0, brake: 1, handbrake: 0 };
      g.player.placeAt(34, 0);
      for (let i = 0; i < 30; i++) g.step(1 / 120);   // settle springs + shadow frustum
      g.player.applyTo(g.playerView);
      g.race.reset();
      g.freeCam = true;
      const f = g.track.frameAt(52);
      g.camera.up.set(0, 1, 0);
      g.camera.position.copy(f.pos)
        .addScaledVector(f.right, -6).addScaledVector(f.up, 4.5);
      const aim = g.track.frameAt(22).pos;
      g.camera.lookAt(aim.x, aim.y + 0.6, aim.z);
    });
    await page.waitForTimeout(120);
    await capture(page, path.join(outDir, 'grid.png'));
    console.log('\n  shot grid.png');

    /* Mid-race frames: play the actual race and shoot the moments where an
       opponent sits ahead of the chase camera, because a pack behind the
       player is a pack behind the lens. */
    await page.evaluate(() => {
      const g = window.__game;
      g.setView('chase');
      g.botInput = null;
      g.autopilot(true, 0.85);
      g.bot.wobble = 5;
      g.bot.boost = 1;
      const p = g.player;
      p.placeAt(34, 0); p.vx = 0; p.vy = 0; p.r = 0;
      p.raceTime = 0; p.finished = false; p.rpm = 1050; p.gear = 0;
      g.race.reset();
    });
    for (let shot = 1; shot <= 3; shot++) {
      const at = await page.evaluate(([minT, maxT]) => {
        const g = window.__game;
        const p = g.player;
        let t = 0;
        for (let i = 0; i < maxT * 60; i++) {
          g.step(1 / 60);
          if (p.strandedFor > 2.5) p.recover();
          if (!g.__raceDriven) g.race.step(1 / 60, p);
          t += 1 / 60;
          if (t < minT) continue;
          if (g.race.cars.some(c => c.s - p.s > 12 && c.s - p.s < 55)) break;
        }
        return {
          t: +p.raceTime.toFixed(1),
          gaps: g.race.cars.map(c => +(c.s - p.s).toFixed(0)),
          delta: g.race.deltaFor(p) === null ? null : +g.race.deltaFor(p).toFixed(2),
          pos: g.race.positionOf(p),
        };
      }, [shot === 1 ? 6 : 12, 90]);
      await capture(page, path.join(outDir, `chase-${shot}.png`));
      console.log(`  shot chase-${shot}.png   t=${at.t}s  P${at.pos}  Δ${at.delta}s  opponent Δs ${at.gaps.join(', ')} m`);
    }
    /* Side-on framing of the same moment, from the player's own road frame
       rather than the hero preset — the preset stands 26 m off the road,
       which inside a canyon is 26 m inside the wall. */
    await page.evaluate(() => {
      const g = window.__game;
      const p = g.player;
      g.freeCam = true;
      const f = g.track.frameAt(p.s);
      const ahead = g.race.cars
        .filter(c => c.s > p.s)
        .sort((a, b) => a.s - b.s)[0];
      const aim = ahead
        ? p.pos.clone().lerp(ahead.pos, 0.45) : p.pos.clone();
      g.camera.up.set(0, 1, 0);
      g.camera.position.copy(p.pos)
        .addScaledVector(f.right, -9).addScaledVector(f.up, 4)
        .addScaledVector(f.tan, -6);
      g.camera.lookAt(aim.x, aim.y + 0.5, aim.z);
    });
    await page.waitForTimeout(120);
    await capture(page, path.join(outDir, 'side-pack.png'));
    console.log('  shot side-pack.png');
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.json'),
    JSON.stringify({ tag, gl, base, withRace, races: all, slow, fast, errors: errs }, null, 2));
  console.log(`\n  → shots/${tag}`);
});

finish(process.exitCode || 0);
