/* Why does the car "struggle in turns"?
 *
 * Two rounds of turn fixes have each found a real bug, each measured better
 * afterwards, and the player has complained again both times. Everything in
 * tools/ that judges handling judges it through the AI driver, which steers
 * analogue, brakes analogue, and never asks the car for more than it has. The
 * player is on a keyboard. So this asks three questions nothing else asks.
 *
 *   A. STEERING AUTHORITY, on a real skidpad. steerprobe.mjs says a skidpad
 *      is impossible here because any held lock puts the car in the berm
 *      inside two seconds, and that is true only while the car is allowed to
 *      travel. Pin position and attitude every substep and the car is on a
 *      treadmill: vx, vy, r, steer, the springs and the load transfer all
 *      evolve exactly as they do on the road, and the surface, the walls and
 *      the berm are held constant underneath. That is a steady-state
 *      cornering measurement of the real code. What comes out is how much
 *      cornering each steering command actually buys — and whether more
 *      command buys more corner.
 *
 *   B. THE BRAKE. A keyboard brake is 0 or 1, and the friction-circle split
 *      changes shape at brake > 0.05, so a player entering a corner steps
 *      across that discontinuity every single time. This sweeps the pedal
 *      against held lock and reports what the axles have left.
 *
 *   C. A KEYBOARD LAP. The same driver intent, actuated the way a keyboard
 *      actuates it: steer is -1, 0 or +1, throttle and brake are on or off.
 *      Run against the analogue lap on the same seed, same line, same
 *      everything else. If the keyboard lap is the one that cannot turn, the
 *      complaint is reproduced and localised.
 *
 *   node tools/zxturn.mjs [--seeds 22] [--pass A,B,C]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22').split(',').map(Number);
const PASSES = flag('pass', 'A,B,C').split(',');

const PROBE = ([passes]) => {
  const g = window.__game;
  const p = g.player;
  const DEG = 180 / Math.PI;
  const H = 1 / 120;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  g.freeCam = true;
  g.setPaused(true);

  /* The flattest, straightest 300 m on the stage. A skidpad wants the road
     to contribute nothing, and curvature under the car would show up in the
     answer as cornering the driver did not ask for. */
  const t = g.track;
  let bestS = 200, bestC = 1e9;
  for (let s = 140; s < t.length - 400; s += 20) {
    let c = 0;
    for (let d = 0; d < 300; d += 15) {
      const f = t.frameAt(s + d);
      /* Bank counts as much as curvature. A banked straight puts a constant
         lateral component of gravity into the pad, which biases every run on
         it the same way — and the pad's whole job is to have nothing in it
         but the car. */
      c += Math.abs(f.curv) + Math.abs(f.bank) * 0.02 + Math.abs(f.grade) * 0.004;
    }
    if (c < bestC) { bestC = c; bestS = s; }
  }
  const padGrade = +(t.frameAt(bestS).grade * 100).toFixed(1);
  const padBank = +(t.frameAt(bestS).bank * DEG).toFixed(2);

  /**
   * One skidpad run.
   *
   * Position, station and attitude are restored after every substep. Nothing
   * in the car's own frame is touched — vx, vy, r, steer, steerVel, the
   * springs, the load transfer and the tyre state all carry forward — so the
   * lateral balance that settles out is the real one. Yaw is pinned along
   * with position, and that is deliberate rather than convenient: the only
   * thing in the model that reads absolute heading is the in-plane component
   * of gravity, and letting the car rotate through a radian and a half on a
   * 9% grade swings that by a metre a second squared, which lands straight in
   * the friction circle and confounds the thing being measured. Pinned, the
   * grade is a constant tilt, which is what a skidpad is.
   */
  /* Where the car's path is going, not where its nose is pointing.
   *
   * Yaw rate over speed is the curvature of the BODY's rotation, and it is
   * the wrong number the moment the car has any slide in it: the direction
   * the car is travelling is its heading plus its body slip angle, so the
   * path turns at (r + dβ/dt) and not at r. A car that corners by sliding
   * outward while barely rotating reads as a huge radius on r/v and is in
   * fact holding a tight one — and a car doing the reverse reads as tight
   * while it runs wide. Both cases are exactly what is being looked for here,
   * so both numbers are kept and reported side by side. The gap between them
   * IS the disconnect between where the car points and where it goes. */
  const PATH_SAMPLES = [0.15, 0.3, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.5, 6.0];

  const skid = (speed, steer, brake, throttle, secs) => {
    p.placeAt(bestS, 0);
    p.vx = speed; p.vy = 0; p.r = 0;
    const pos = p.pos.clone(), up = p.up.clone();
    const s0 = p.s, lat0 = p.lat, yaw0 = p.yaw;
    const input = { steer, throttle, brake, handbrake: 0 };
    const n = Math.round(secs * 120);
    const tail = [];
    const marks = [];
    let peakSlip = 0, peakR = 0, contact = 0, peakPath = 0, peakPathAt = 0;
    let prevBeta = 0;
    for (let i = 0; i < n; i++) {
      p.step(H, input);
      const beta = Math.atan2(p.vy, Math.abs(p.vx) + 0.5);
      const pathRate = p.r + (beta - prevBeta) / H;
      prevBeta = beta;
      const pathG = Math.abs(p.speed * pathRate) / 9.81;
      peakSlip = Math.max(peakSlip, Math.abs(p.slipAngle));
      peakR = Math.max(peakR, Math.abs(p.r));
      if (pathG > peakPath) { peakPath = pathG; peakPathAt = (i + 1) * H; }
      if (p.offRoad > 0.01 || p._contact) contact++;
      // Back on the treadmill.
      p.pos.copy(pos); p.up.copy(up);
      p.s = s0; p.lat = lat0; p.yaw = yaw0; p._lastS = s0;
      p.height = 0; p.vertVel = 0; p.airborne = false;
      p.offRoad = 0;
      /* And the belt runs at a constant speed. Without this the pad is an
         18.6% descent and the car simply runs away down it: a run labelled
         43 km/h finished at 72 and one labelled 173 finished at 200, so every
         row was measured somewhere other than where it said. vy and r are
         untouched — only the belt is held. */
      p.vx = speed;
      const tNow = (i + 1) * H;
      for (const m of PATH_SAMPLES) {
        if (Math.abs(tNow - m) < H * 0.5 && m <= secs) {
          marks.push([m, +pathG.toFixed(3), +(Math.abs(p.speed * p.r) / 9.81).toFixed(3),
            +(beta * DEG).toFixed(1)]);
        }
      }
      if (i >= n - 36) {
        tail.push({
          r: p.r, vx: p.vx, vy: p.vy, speed: p.speed, pathRate,
          steer: p.steer, slipF: p._slipF, slipR: p._slipR,
          cF: p._circleF, cR: p._circleR, slip: p.slipAngle,
          loadF: p.loadF, loadR: p.loadR,
          fyf: p._fyf, fyr: p._fyr, fyg: p._fyg, scrub: p._scrub,
        });
      }
    }
    const mean = k => tail.reduce((a, x) => a + x[k], 0) / tail.length;
    const v = mean('speed');
    const r = mean('r');
    const pr = mean('pathRate');
    return {
      cmd: steer, brake, throttleCmd: throttle,
      speedKmh: +(v * 3.6).toFixed(1),
      yawRate: +r.toFixed(4),
      pathRate: +pr.toFixed(4),
      radiusM: Math.abs(r) > 1e-4 ? +(v / Math.abs(r)).toFixed(1) : null,
      pathRadiusM: Math.abs(pr) > 1e-4 ? +(v / Math.abs(pr)).toFixed(1) : null,
      latG: +(Math.abs(v * r) / 9.81).toFixed(3),
      pathG: +(Math.abs(v * pr) / 9.81).toFixed(3),
      peakPathG: +peakPath.toFixed(3), peakPathAtSec: +peakPathAt.toFixed(2),
      roadWheelDeg: +(mean('steer') * DEG).toFixed(2),
      slipFDeg: +(mean('slipF') * DEG).toFixed(2),
      slipRDeg: +(mean('slipR') * DEG).toFixed(2),
      circleF: +mean('cF').toFixed(3),
      circleR: +mean('cR').toFixed(3),
      loadFN: Math.round(mean('loadF') * 2),
      loadRN: Math.round(mean('loadR') * 2),
      bodySlipDeg: +(mean('slip') * DEG).toFixed(2),
      peakSlipDeg: +(peakSlip * DEG).toFixed(1),
      peakYaw: +peakR.toFixed(3),
      vyMean: +mean('vy').toFixed(2),
      FyfN: Math.round(mean('fyf')), FyrN: Math.round(mean('fyr')),
      FygN: Math.round(mean('fyg')), scrubN: Math.round(mean('scrub')),
      dirtyFrames: contact,
      marks,
    };
  };

  /**
   * The same run both ways round, averaged.
   *
   * A skidpad is always driven in both directions and the reason is exactly
   * the reason it matters here: any constant side force on the pad — bank,
   * the fall line of the hillside the road is cut into, a sign error — adds
   * to one hand and subtracts from the other. Averaging the magnitudes
   * cancels it and the difference between the hands is the bias, reported so
   * it cannot hide.
   */
  const pad = (speed, steer, brake, throttle, secs) => {
    const a = skid(speed, steer, brake, throttle, secs);
    const b = skid(speed, -steer, brake, throttle, secs);
    const mid = (x, y) => (Math.abs(x) + Math.abs(y)) * 0.5;
    return {
      ...a,
      yawRate: +mid(a.yawRate, b.yawRate).toFixed(4),
      radiusM: +((mid(a.speedKmh, b.speedKmh) / 3.6)
        / Math.max(1e-4, mid(a.yawRate, b.yawRate))).toFixed(1),
      pathRadiusM: +((mid(a.speedKmh, b.speedKmh) / 3.6)
        / Math.max(1e-4, mid(a.pathRate, b.pathRate))).toFixed(1),
      latG: +mid(a.latG, b.latG).toFixed(3),
      pathG: +mid(a.pathG, b.pathG).toFixed(3),
      peakPathG: +mid(a.peakPathG, b.peakPathG).toFixed(3),
      peakYaw: +mid(a.peakYaw, b.peakYaw).toFixed(3),
      peakSlipDeg: +mid(a.peakSlipDeg, b.peakSlipDeg).toFixed(1),
      slipFDeg: +mid(a.slipFDeg, b.slipFDeg).toFixed(2),
      slipRDeg: +mid(a.slipRDeg, b.slipRDeg).toFixed(2),
      /* Nonzero means the pad is not neutral: one hand corners harder than
         the other, and the gap is twice whatever constant side force is
         sitting under both. */
      handSplit: +(Math.abs(a.yawRate) - Math.abs(b.yawRate)).toFixed(4),
    };
  };

  const res = { seed: t.seed, padS: +bestS.toFixed(0), padGrade, padBank };

  /* ---- A: how much corner does a steering command buy? ----------------- */
  if (passes.includes('A')) {
    const speeds = [12, 18, 25, 32, 40, 48];
    const cmds = [0.1, 0.2, 0.3, 0.45, 0.6, 0.75, 0.9, 1.0];
    /* Straight ahead, so any cornering the pad supplies on its own is on the
       record before anything is attributed to the car. */
    res.padBias = speeds.map(v => skid(v, 0, 0, 0, 1.6));
    res.authority = speeds.map(v => ({
      speedTarget: v,
      lockDeg: +((0.62 + (0.16 - 0.62)
        * (x => x * x * (3 - 2 * x))(clamp((v - 4) / 42, 0, 1))) * DEG).toFixed(1),
      rows: cmds.map(c => pad(v, c, 0, 0, 6.0)),
    }));
    /* How long the car takes to get to whatever it is going to do, at the one
       command a keyboard can actually send. */
    res.settle = speeds.map(v => skid(v, 1.0, 0, 0, 6.0));
  }

  /* ---- B: the brake pedal against held lock ---------------------------- */
  if (passes.includes('B')) {
    const brakes = [0, 0.04, 0.06, 0.15, 0.3, 0.5, 0.75, 1.0];
    res.brakeSweep = [18, 25, 32, 42].map(v => ({
      speedTarget: v,
      rows: brakes.map(b => pad(v, 1.0, b, 0, 3.0)),
    }));
    /* And the same thing at the lock a driver would actually be holding
       mid-corner, so the answer is not an artefact of asking the front for
       more than it has. */
    res.brakeSweepHalf = [25, 42].map(v => ({
      speedTarget: v,
      rows: brakes.map(b => pad(v, 0.45, b, 0, 3.0)),
    }));
  }

  /* ---- C: an analogue lap and a keyboard lap -------------------------- */
  if (passes.includes('C')) {
    /**
     * The same driver, actuated four ways.
     *
     * Every handling instrument in tools/ drives through the AI, and the AI
     * has an analogue wheel and an analogue brake pedal it never saturates.
     * A player has neither. Rather than swap the whole controller at once —
     * which conflates the car with the controller, and a bang-bang steering
     * loop is unstable for reasons that have nothing to do with tyres — each
     * axis is quantised on its own against the same line, the same speeds and
     * the same seed. Whichever axis breaks the car is the answer.
     *
     * The steering quantiser has hysteresis and a minimum hold, because a
     * human does. Without them the command chatters at 120 Hz across the
     * threshold, which no keyboard can do and which wrecks the car on its own.
     */
    const lap = (mode) => {
      g.restart();
      g.autopilot(true, 0.85);
      g.countdown.skip();
      g.ending.skip();
      const bot = g.bot;
      const realDrive = bot.drive.bind(bot);
      let keyHeld = 0, keyFor = 0;
      const keySteer = (want, dt) => {
        keyFor += dt;
        const on = keyHeld !== 0;
        // Schmitt trigger: press at a third of lock, release at a tenth.
        const wantKey = Math.abs(want) > (on ? 0.10 : 0.33) ? Math.sign(want) : 0;
        if (wantKey !== keyHeld && (keyFor > 0.1 || wantKey === 0 || keyHeld === 0)) {
          if (wantKey !== keyHeld) { keyHeld = wantKey; keyFor = 0; }
        }
        return keyHeld;
      };
      if (mode !== 'analogue') {
        bot.drive = (car, dt) => {
          const a = realDrive(car, dt);
          const binSteer = mode === 'steer' || mode === 'keyboard';
          const binPedal = mode === 'brake' || mode === 'keyboard';
          return {
            steer: binSteer ? keySteer(a.steer, dt) : a.steer,
            throttle: binPedal ? (a.throttle > 0.35 ? 1 : 0) : a.throttle,
            brake: binPedal ? (a.brake > 0.12 ? 1 : 0) : a.brake,
            handbrake: a.handbrake,
          };
        };
      }
      let frames = 0, impacts = 0, offRoad = 0, sideways = 0, spun = 0;
      let recoveries = 0, brakeFrames = 0, brakeAndTurn = 0;
      let cRsum = 0, cRn = 0, worstCR = 1;
      let missSum = 0, missN = 0, worstMiss = 0;
      let lockSum = 0, lockN = 0;
      let vMin = 999, vMax = 0;
      const corner = [];
      for (let i = 0; i < 300 * 120 && !p.finished; i++) {
        p.lastImpact = 0;
        g.step(H);
        frames++;
        if (p.strandedFor > 2.5) { p.recover(); recoveries++; }
        if (p.lastImpact > 0.06) impacts++;
        if (p.offRoad > 0.5) offRoad++;
        const slip = Math.abs(p.slipAngle);
        if (slip > 0.16) sideways++;
        if (slip > 0.7) spun++;
        const kmh = p.kmh;
        if (kmh < vMin) vMin = kmh;
        if (kmh > vMax) vMax = kmh;
        if (p.brake > 0.05) {
          brakeFrames++;
          if (Math.abs(p.steer) > 0.05) brakeAndTurn++;
          cRsum += p._circleR; cRn++;
          worstCR = Math.min(worstCR, p._circleR);
        }
        /* The whole question, as one number. The road under the car has a
           curvature; the car's path has a curvature of r/v. How far short the
           car falls of the road it is standing on is understeer the player has
           to correct with something — width, lift, or a second bite. Only
           counted where the road is actually turning and the car is actually
           moving, and expressed as a fraction so a hairpin and a sweeper are
           comparable. */
        const f = g.track.frameAt(p.s);
        const need = Math.abs(f.curv);
        if (need > 0.006 && p.speed > 8 && !p.airborne) {
          const got = Math.abs(p.r) / p.speed;
          const miss = clamp(1 - got / need, -1, 1);
          missSum += miss; missN++;
          if (miss > worstMiss) worstMiss = miss;
          lockSum += Math.abs(p.steer) / Math.max(1e-4, 0.62); lockN++;
          if (missN % 60 === 0) {
            corner.push([+p.s.toFixed(0), +(1 / need).toFixed(0), +kmh.toFixed(0),
              +miss.toFixed(3), +p.lat.toFixed(2), +(p.steer * DEG).toFixed(1),
              +p._circleR.toFixed(2)]);
          }
        }
      }
      bot.drive = realDrive;
      g.autopilot(false);
      return {
        mode,
        finished: p.finished,
        time: +p.raceTime.toFixed(1),
        reachedPct: +((p.s / g.track.length) * 100).toFixed(1),
        vMin: +vMin.toFixed(0), vMax: +vMax.toFixed(0),
        impacts,
        offRoadPct: +((offRoad / frames) * 100).toFixed(1),
        sidewaysPct: +((sideways / frames) * 100).toFixed(1),
        spunPct: +((spun / frames) * 100).toFixed(2),
        recoveries,
        brakePct: +((brakeFrames / frames) * 100).toFixed(1),
        brakeAndTurnPct: +((brakeAndTurn / frames) * 100).toFixed(1),
        meanCircleRUnderBrake: cRn ? +(cRsum / cRn).toFixed(3) : null,
        worstCircleR: +worstCR.toFixed(3),
        meanMiss: missN ? +(missSum / missN).toFixed(3) : null,
        worstMiss: +worstMiss.toFixed(3),
        meanLockUsed: lockN ? +(lockSum / lockN).toFixed(3) : null,
        corner,
      };
    };
    res.laps = ['analogue', 'brake', 'steer', 'keyboard'].map(lap);
  }

  g.setPaused(false);
  return res;
};

const all = {};
for (const seed of SEEDS) {
  await run({ width: 480, height: 270, hash: `manual&tier=low&seed=${seed}&cap=0&hud=0` },
    async ({ page }) => {
      const out = await page.evaluate(PROBE, [PASSES]);
      all[seed] = out;

      console.log(`\n═══ seed ${out.seed} — skidpad at s=${out.padS}, ` +
        `grade ${out.padGrade}%, bank ${out.padBank}° ═══`);

      if (out.authority) {
        console.log('\n  pad neutrality, steer = 0 (any yaw here is the pad, not the car)');
        for (const r of out.padBias) {
          console.log(`    ${String(Math.round(r.speedKmh)).padStart(3)} km/h   ` +
            `yaw ${String(r.yawRate).padStart(8)} rad/s   Fy_g ${String(r.FygN).padStart(6)} N`);
        }
        console.log('\n  PASS A — steady-state cornering per steering command,');
        console.log('  both hands averaged. Lower R and higher lat g is more corner.');
        for (const b of out.authority) {
          console.log(`\n    ${String(Math.round(b.speedTarget * 3.6)).padStart(3)} km/h  ` +
            `full lock ${b.lockDeg}°`);
          console.log('      cmd   wheel   pathR   pathG   yawR   yaw g  bodySlip' +
            '   slipF   slipR  peakPathG @t');
          for (const r of b.rows) {
            console.log(`      ${r.cmd.toFixed(2)}  ${String(r.roadWheelDeg).padStart(6)}°` +
              ` ${String(r.pathRadiusM ?? '-').padStart(6)} m ` +
              `${String(r.pathG).padStart(6)} ${String(r.radiusM).padStart(7)} m` +
              `${String(r.latG).padStart(7)}   ${String(r.bodySlipDeg).padStart(6)}° ` +
              `${String(r.slipFDeg).padStart(6)}° ${String(r.slipRDeg).padStart(6)}°  ` +
              `${String(r.peakPathG).padStart(6)} @${r.peakPathAtSec}s`);
          }
          const best = b.rows.reduce((a, r) => (r.pathG > a.pathG ? r : a), b.rows[0]);
          const atFull = b.rows[b.rows.length - 1];
          const lost = best.pathG > 0 ? (1 - atFull.pathG / best.pathG) * 100 : 0;
          console.log(`      best path at cmd ${best.cmd.toFixed(2)} (${best.pathG} g, ` +
            `R=${best.pathRadiusM} m); full lock ${atFull.pathG} g, R=${atFull.pathRadiusM} m` +
            (lost > 1 ? `  → ${lost.toFixed(0)}% LOST AT FULL LOCK` : ''));
        }
        console.log('\n  how the corner arrives, at full lock (the only command a key sends)');
        console.log('    speed    t=0.15  0.30  0.50  0.75  1.00  1.50  2.00  3.00  4.50  6.00   (path g)');
        for (const r of out.settle) {
          console.log(`    ${String(Math.round(r.speedKmh)).padStart(3)} km/h  ` +
            r.marks.map(m => String(m[1].toFixed(2)).padStart(5)).join(' '));
        }
        console.log('    and the body slip angle it is doing that with, degrees');
        for (const r of out.settle) {
          console.log(`    ${String(Math.round(r.speedKmh)).padStart(3)} km/h  ` +
            r.marks.map(m => String(m[3].toFixed(1)).padStart(5)).join(' '));
        }
      }

      if (out.brakeSweep) {
        for (const [label, set] of [['full lock', out.brakeSweep],
          ['0.45 lock', out.brakeSweepHalf]]) {
          console.log(`\n  PASS B — brake pedal against ${label}`);
          for (const b of set) {
            console.log(`\n    ${Math.round(b.speedTarget * 3.6)} km/h, speed held`);
            console.log('      brake   pathR    pathG   circF  circR   loadF  loadR' +
              '   slipR   bodySlip  peakSlip');
            for (const r of b.rows) {
              console.log(`      ${r.brake.toFixed(2)} ${String(r.pathRadiusM ?? '-').padStart(8)} m ` +
                `${String(r.pathG).padStart(6)}  ${String(r.circleF).padStart(5)}  ` +
                `${String(r.circleR).padStart(5)}  ${String(r.loadFN).padStart(6)} ` +
                `${String(r.loadRN).padStart(6)}  ${String(r.slipRDeg).padStart(7)}°  ` +
                `${String(r.bodySlipDeg).padStart(7)}°  ${String(r.peakSlipDeg).padStart(6)}°`);
            }
            const dry = b.rows[0], wet = b.rows[b.rows.length - 1];
            const lost = dry.pathG > 0 ? (1 - wet.pathG / dry.pathG) * 100 : 0;
            console.log(`      off-pedal ${dry.pathG} g / R=${dry.pathRadiusM} m → ` +
              `on-pedal ${wet.pathG} g / R=${wet.pathRadiusM} m` +
              `   rear grip ${dry.circleR} → ${wet.circleR}` +
              (lost > 3 ? `   → ${lost.toFixed(0)}% OF THE CORNER LOST TO THE PEDAL` : ''));
          }
        }
      }

      if (out.laps) {
        console.log('\n  PASS C — one driver, one line, four ways of actuating it');
        console.log('    "brake" = binary pedal only. "steer" = keyed wheel only.');
        const L = out.laps;
        const row = (label, pick, unit = '') =>
          console.log(`    ${label.padEnd(32)}` +
            L.map(x => String(pick(x)).padStart(11)).join('') + unit);
        console.log(`    ${''.padEnd(32)}` +
          L.map(x => x.mode.padStart(11)).join(''));
        row('finished', x => x.finished);
        row('stage time / reached', x => x.finished ? x.time + 's' : 'DNF ' + x.reachedPct + '%');
        row('impacts', x => x.impacts);
        row('off road %', x => x.offRoadPct);
        row('sideways >9° %', x => x.sidewaysPct);
        row('spun >40° %', x => x.spunPct);
        row('recoveries', x => x.recoveries);
        row('on the brake %', x => x.brakePct);
        row('braking AND steering %', x => x.brakeAndTurnPct);
        row('rear grip while braking', x => x.meanCircleRUnderBrake);
        row('worst rear grip', x => x.worstCircleR);
        row('curvature shortfall, mean', x => x.meanMiss);
        row('lock in use, mean', x => x.meanLockUsed);
      }

      fs.mkdirSync(path.join(ROOT, 'shots', 'zxturn'), { recursive: true });
    });
}
fs.writeFileSync(path.join(ROOT, 'shots', 'zxturn', 'turn.json'), JSON.stringify(all, null, 1));
console.log('\n  → shots/zxturn/turn.json');
finish(process.exitCode || 0);
