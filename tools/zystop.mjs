/* How the car stops now that there is road to stop on.
 *
 * WHY THIS EXISTS AND finstop.mjs DOES NOT ANSWER IT. That tool has three
 * defects, all of which change its numbers rather than merely its presentation:
 *
 *   1. It calls `goTo` without `restart()`, so it inherits however far the
 *      page's own loop carried the car before the harness took the wheel. That
 *      is the suite-wide measurement leak `tools/zjdet.mjs` exists to detect.
 *   2. Its stop test is `p.vx < 0.5`. `vx` is the BODY-FRAME forward component,
 *      which a car sliding sideways under a locked wheel crosses while still
 *      travelling at speed, and which reverse takes negative. It is the reason
 *      that tool once certified braking alone as sufficient when the car was
 *      leaving the world at 40 km/h.
 *   3. It hard-codes the finish at `L - 34` and the gate at `L - 12`, which is
 *      the convention this pass removed.
 *
 * So: stop on `Math.hypot(vx, vy)`, which cannot be crossed early and cannot go
 * negative, and require it held for a tenth of a second so a momentary zero at
 * the top of a bounce is not a stop. Always `restart()`. Read the stations off
 * the Track.
 *
 * Three configurations per seed, because the question "can the brakes do this
 * on their own" and the question "does shipping stop the car on the road" are
 * different questions:
 *
 *   shipping   the ending drives, servo and all. Reports where the car parks,
 *              how much of the retardation was scripted, and the slip angle,
 *              which is what a saturated pedal destroys.
 *   pedal      no ending; the ending's own pedal cap held down, nothing else.
 *              This is the honest "on its own brakes" stopping distance at the
 *              authority the ending is allowed to use.
 *   full       no ending; the pedal buried. The shortest stop the car has.
 *
 *   node tools/zystop.mjs [--seeds ...] [--pedal 0.3] [--trace]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '1,7,12,14,16,20,22,23,26,27,28,34,36,40')
  .split(',').map(Number);
const PEDAL = Number(flag('pedal', '0.3'));
/* The autopilot skill the arrival is taken at. 0.85 is what the rest of the
   suite uses and what the ending's own numbers were taken at, so it is the
   default and the comparable figure; higher arrives faster and is worth asking
   for, because the run-off has to be long enough for the fastest arrival the
   game can produce and not the average one. */
const SKILL = Number(flag('skill', '0.85'));
const TRACE = args.includes('--trace');

const PROBE = async ([pedal, skill, trace]) => {
  const g = window.__game;
  const p = g.player;
  const t = g.track;
  const DT = 1 / 60;
  const BRAKE_G = 12200 / 1180;

  /* Arrive the way a race arrives. `restart()` first, every time — see the
     header. Then autopilot from 320 m back, which is far enough that the car is
     at whatever speed the stage's last corner actually allows rather than at
     whatever speed it was teleported in with. */
  const arrive = () => {
    g.restart();
    g.autopilot(true, skill);
    /* A fraction of `length`, because that is what `goTo` multiplies by — not
       of `roadEnd`. It also clamps its destination to `roadEnd - 40`, which is
       the one place in the code that had to learn about run-off just so a tool
       could be parked in it. */
    g.goTo((t.finishS - 320) / t.length);
    /* AFTER goTo, which skips the ending on the way through — deliberately, so
       that a teleporting tool cannot be ambushed by it — and `enabled` too,
       because `manual` in the hash turns the ending off. A tool measuring the
       ending has to ask for the ending. */
    g.ending.enabled = true;
    g.ending.arm();
    p.finished = false;
    for (let i = 0; i < 60 * 60 && !p.finished; i++) g.step(DT);
    return { s: p.s, speed: p.speed, kmh: p.speed * 3.6 };
  };

  /* The state the car is IN at the line, which is the thing that decides whether
     an excursion during the stop is the ending's fault. A car that crosses at 30°
     of slip with a wheel on the verge and 40°/s of yaw is not a car the stop put
     there — it is an arrival, and the ending inherits it. */
  const atLine = () => {
    const { lat, half } = lateralOf();
    return {
      slip: +(Math.abs(p.slipAngle) * 180 / Math.PI).toFixed(0),
      lat: +lat.toFixed(1),
      off: +(Math.abs(lat) - half).toFixed(1),
      yaw: +(Math.abs(p.r) * 180 / Math.PI).toFixed(0),
    };
  };

  const lateralOf = () => {
    const f = t.frameAt(Math.min(Math.max(p.s, 0), t.roadEnd));
    const d = p.pos.clone().sub(f.pos);
    return {
      lat: d.x * f.flatRight.x + d.z * f.flatRight.z,
      half: f.width * 0.5,
    };
  };

  const settle = (label, opts) => {
    const a = arrive();
    const line = atLine();
    if (opts.pedal !== undefined) {
      g.autopilot(false);
      g.ending.skip();
      g.botInput = { steer: 0, throttle: 0, brake: opts.pedal, handbrake: 0 };
    }
    if (opts.coast) {
      /* Autopilot left ON from arrive(), so the run-off is driven by the same
         Driver the rest of the suite uses, at racing speed, with nothing else
         changed. It never stops, so it is run to the end of the road and only
         its off-road figure is read. */
      g.ending.skip();
      g.botInput = null;
    }
    const p0 = p.pos.clone();
    const s0 = p.s;
    let secs = 0, still = 0, stopped = -1;
    let peakSlip = 0, peakScrub = 0, peakDemand = 0, worstOff = 0, path = 0;
    let sPinned = 0, lastS = p.s;
    const rows = [];
    const prev = p.pos.clone();
    for (let i = 0; i < 20 * 60; i++) {
      g.step(DT);
      secs += DT;
      path += p.pos.distanceTo(prev);
      prev.copy(p.pos);
      peakSlip = Math.max(peakSlip, Math.abs(p.slipAngle) * 180 / Math.PI);
      /* The scripted part, read off the servo rather than inferred: `_demand`
         is the total retardation asked for and `p.brake` is what of it went to
         the tyres, so the difference is the scrub. Both are the values the car
         was actually stepped with. */
      const demand = g.ending?.servo?._demand ?? 0;
      peakDemand = Math.max(peakDemand, demand);
      peakScrub = Math.max(peakScrub, Math.max(0, demand - p.brake * BRAKE_G));
      const { lat, half } = lateralOf();
      worstOff = Math.max(worstOff, Math.abs(lat) - half);
      if (Math.abs(p.s - lastS) < 1e-4) sPinned += DT; else sPinned = 0;
      lastS = p.s;
      /* The stop test. Speed as a magnitude, held for a tenth of a second so a
         momentary zero at the top of a bounce is not a stop.
         And the hand-over to the handbrake, which is not presentation: the brake
         pedal doubles as reverse, so a car held on the pedal at a standstill
         drives back up the road — the ending's own CREEP_MS comment records this
         as a stop that measured −6 m. Without the hand-over the car never rests
         for a tenth of a second at all and this test reports NEVER, which is
         what it did on the first run of this tool. */
      const v = Math.hypot(p.vx, p.vy);
      /* The driven row has no stop to wait for, so it ends where the road does —
         short of the last frames, past which `s` pins and `lateralOf` is reading
         a projection onto a centreline the car has run off the end of. */
      if (opts.coast && p.s >= t.roadEnd - 10) { stopped = secs; break; }
      if (opts.pedal !== undefined && v < 1) {
        g.botInput = { steer: 0, throttle: 0, brake: 0, handbrake: 1 };
      }
      if (v < 0.35) { still += DT; if (still >= 0.1) { stopped = secs; break; } }
      else still = 0;
      if (trace && i % 15 === 14) {
        rows.push({
          t: +secs.toFixed(2), past: +(p.s - t.finishS).toFixed(1),
          kmh: +(p.speed * 3.6).toFixed(0), slip: +(Math.abs(p.slipAngle) * 180 / Math.PI).toFixed(0),
          scrub: +Math.max(0, demand - p.brake * BRAKE_G).toFixed(1),
          pedal: +p.brake.toFixed(2), off: +(Math.abs(lat) - half).toFixed(1),
          /* The two halves of that subtraction, because they have different
             owners: `lat` is where the car put itself and `half` is how much
             road the track author left it. An excursion is a rising `lat` or a
             falling `half`, and the fix is different for each. */
          lat: +lat.toFixed(1), half: +half.toFixed(1),
        });
      }
    }
    g.botInput = null;
    g.autopilot(false);
    return {
      label,
      line,
      fromKmh: +a.kmh.toFixed(0),
      /* Two distances, because they answer different things. `alongRoad` is
         how far down the course the car got, which is what the run-off has to
         be long enough for. `path` is how far the car actually travelled,
         which is larger by whatever it did sideways. */
      alongRoad: +(p.s - a.s).toFixed(1),
      path: +path.toFixed(1),
      straight: +p.pos.distanceTo(p0).toFixed(1),
      secs: stopped < 0 ? null : +stopped.toFixed(2),
      pastLine: +(p.s - t.finishS).toFixed(1),
      roadLeft: +(t.roadEnd - p.s).toFixed(1),
      peakSlip: +peakSlip.toFixed(0),
      peakScrub: +peakScrub.toFixed(1),
      peakDemand: +peakDemand.toFixed(1),
      offRoad: +worstOff.toFixed(1),
      pinnedS: +sPinned.toFixed(2),
      meanG: stopped > 0 ? +(a.speed / stopped / 9.81).toFixed(2) : null,
      rows,
    };
  };

  const out = [];
  out.push(settle('shipping', {}));
  /* Steered, and not braked at all. The control for every excursion the other
     rows show: if a car that is merely COASTING down the run-off under the same
     driver leaves the road, then the road is what left it, and no amount of
     re-deriving the retardation will fix that. It does not stop, so its distance
     columns are meaningless and only its off-road figure is read. */
  out.push(settle('driven, no ending', { coast: true }));
  out.push(settle('pedal ' + pedal, { pedal }));
  out.push(settle('full pedal', { pedal: 1 }));

  return {
    seed: g.seed,
    length: +t.length.toFixed(0), roadEnd: +t.roadEnd.toFixed(0),
    finishS: +t.finishS.toFixed(0), gateS: +t.gateS.toFixed(0),
    runoffPastLine: +(t.roadEnd - t.finishS).toFixed(0),
    out,
  };
};

const all = [];
for (const seed of SEEDS) {
  await run({
    width: 320, height: 200, hash: `manual&tier=high&seed=${seed}&cap=0&hud=0`,
  }, async ({ page }) => {
    all.push(await page.evaluate(PROBE, [PEDAL, SKILL, TRACE]));
  });
}

/* The ending's own model, restated here rather than imported, because a tool that
   imports the number it is checking cannot catch that number being wrong. If these
   drift from ending.js the columns below stop agreeing with the measured rest
   station, and that disagreement is the finding. */
/* --cap is what ending.js's BRAKE_PEDAL_MAX is set to for this run. It exists so
   that a sweep of that constant can be scored against the model it implies
   rather than against a stale copy of one value of it. */
const STOP_A = Number(flag('cap', '0.55')) * (12200 / 1180) + 1.7;
const STOP_MIN_M = 26, STOP_TAIL_M = 20;
const station = (v, room) =>
  Math.min(Math.max((v * v) / (2 * STOP_A), STOP_MIN_M),
    Math.max(STOP_MIN_M, room - STOP_TAIL_M));

console.log('\n════ arrival, and the road there is to stop in ════');
console.log('  The ending derives its station from the arrival at ' + STOP_A.toFixed(1)
  + ' m/s² — the pedal');
console.log('  cap plus the world — and clamps it to the road. Where "asks for" is short of');
console.log('  "wants", the clamp bound and the scripted trim pays the difference.\n');
console.log('  seed   arrives at the flag   road past the flag   needs at 1.0 g'
  + '   wants   asks for   clamped');
let worstNeed = 0;
for (const r of all) {
  const v = r.out[0].fromKmh / 3.6;
  const at1g = (v * v) / (2 * 9.81);
  const wants = (v * v) / (2 * STOP_A);
  const asks = station(v, r.runoffPastLine);
  /* What the servo has to make up where the clamp bound: the retardation the
     shortened station demands, less what the car brings to it unaided. */
  const need = Math.max(0, (v * v) / (2 * asks) - STOP_A);
  worstNeed = Math.max(worstNeed, need);
  console.log(`  ${String(r.seed).padStart(4)}   ${(r.out[0].fromKmh + ' km/h').padStart(19)}`
    + `   ${(r.runoffPastLine + ' m').padStart(18)}`
    + `   ${(at1g.toFixed(0) + ' m').padStart(14)}`
    + `   ${(wants.toFixed(0) + ' m').padStart(5)}   ${(asks.toFixed(0) + ' m').padStart(8)}`
    + `   ${need > 0.05 ? 'yes, trim ' + need.toFixed(1) : 'no'}`);
}

console.log('\n════ the state the car is IN at the line ════');
console.log('  Inherited from the arrival, not caused by the stop — a car that crosses');
console.log('  sideways or with a wheel off cannot be stopped tidily by anything.\n');
console.log('  seed   slip at line   lateral   off road   yaw rate');
for (const r of all) {
  const l = r.out[0].line;
  console.log(`  ${String(r.seed).padStart(4)}   ${(l.slip + '°').padStart(11)}`
    + `   ${(l.lat + ' m').padStart(7)}`
    + `   ${(l.off > 0 ? '+' + l.off.toFixed(1) + ' m' : 'on').padStart(8)}`
    + `   ${(l.yaw + '°/s').padStart(8)}`);
}

console.log('\n════ what actually happens ════');
console.log('  "past line" is where it comes to rest; "road left" is what remains under it.');
console.log('  Scrub is the SCRIPTED retardation, m/s² — the number this pass is here to cut.\n');
console.log('  "travelled" is the car\'s own path length from the flag, which keeps');
console.log('  reporting after `s` pins at the end of the road; "past line" is `s`, and');
console.log('  a pinned one means the car ran out of road.\n');
console.log('  seed   configuration    from    stops in   travelled   past line'
  + '   road left   peak slip   peak scrub   off road');
let bad = 0, inherited = 0;
for (const r of all) {
  for (const o of r.out) {
    const ranOut = o.roadLeft <= 0.05;
    /* Two verdicts, because they belong to different owners. The stop is the
       ending's: did the car come to rest, on the road, without being spun by
       the retardation. The car's ATTITUDE is largely the arrival's — see the
       state-at-the-line table — so a seed that crossed sideways is counted
       separately rather than charged to this file. */
    const stopFail = o.secs === null || ranOut;
    /* Only the shipping row is steered. The pedal rows hold `steer: 0` — they
       are straight-line brake tests, and a straight line leaves a road that
       curves, so their off-road and slip figures say nothing about the ending
       and are not scored. */
    const steered = o.label === 'shipping' || o.label.startsWith('driven');
    const tidy = o.offRoad <= 0.5 && o.peakSlip <= 25;
    const wasTidy = o.line.off <= 0.5 && o.line.slip <= 12;
    const fail = (stopFail && o.label !== 'driven, no ending')
      || (steered && !tidy);
    if (o.label === 'shipping') {
      if (stopFail || (!tidy && wasTidy)) bad++;
      else if (!tidy) inherited++;
    }
    console.log(`  ${String(r.seed).padStart(4)}   ${o.label.padEnd(15)}`
      + `${String(o.fromKmh).padStart(4)}`
      + `   ${(o.secs === null ? 'NEVER' : o.secs + ' s').padStart(8)}`
      + `   ${(o.path + ' m').padStart(9)}`
      + `   ${(o.pastLine + ' m' + (ranOut ? '*' : '')).padStart(10)}`
      + `   ${(ranOut ? 'RAN OUT' : o.roadLeft + ' m').padStart(9)}`
      + `   ${(o.peakSlip + '°').padStart(9)}`
      + `   ${o.peakScrub.toFixed(1).padStart(10)}`
      + `   ${(o.offRoad > 0 ? '+' + o.offRoad + ' m' : 'on').padStart(8)}`
      + (steered ? '' : '   (steer 0)')
      + (fail ? (stopFail || wasTidy ? '  ✗' : '  ~ arrived like that') : ''));
  }
  if (TRACE) {
    for (const o of r.out) {
      if (!o.rows.length) continue;
      console.log(`      ── seed ${r.seed}, ${o.label}`);
      for (const x of o.rows) {
        console.log(`         +${String(x.t).padStart(5)}s  past ${String(x.past).padStart(6)} m`
          + `  ${String(x.kmh).padStart(3)} km/h  slip ${String(x.slip).padStart(3)}°`
          + `  pedal ${x.pedal}  scrub ${String(x.scrub).padStart(5)}`
          + `  lat ${String(x.lat).padStart(5)} of ±${String(x.half).padStart(4)}`
          + `  off ${x.off}`);
      }
    }
  }
}
console.log(`\n  worst seed needs ${worstNeed.toFixed(1)} m/s² of trim on top of the`
  + ` ${STOP_A.toFixed(1)} the car brings itself`);
console.log(bad
  ? `  ✗ ${bad} seeds fail as shipped`
  : '  ✓ every seed stops, on the road, on the brakes'
    + (inherited ? `, and ${inherited} inherit an untidy arrival` : ''));
finish(process.exitCode || 0);
