/* What is actually at the end of the road, and how much of it is left.
 *
 * Everything the ending has to be designed against is a distance, and every
 * one of them was assumed before this tool existed:
 *
 *   the LINE      where Car.step latches `finished`, at track.finishS
 *   the GATE      the finish arch, at track.gateS
 *   the EDGE      track.roadEnd, past which frameAt clamps and the car is
 *                 sliding across raw terrain with its `s` pinned
 *
 * All three used to be read off track.length — the line at length - 34, the
 * gate at length - 12, the edge AT length — and there were 34 m between the
 * line and the edge, which is why this tool was written: any ending that wants
 * the car stopped on the authored world had to do it inside that.
 *
 * `length` is still the course, so the first two arithmetic still landed where
 * they should. The third stopped being true: the road runs to `roadEnd` now,
 * 154 m past the line, and every `L` below that meant "the edge" was measuring
 * to the end of the COURSE — which is 120 m of road this tool could not see, on
 * a tool whose entire subject is how much road is left.
 *
 * This measures how far a car arriving at racing speed travels with the brakes
 * buried, which is the number that decides whether braking alone can be the
 * mechanism at all. It now can be — but do not read it here.
 *
 * DO NOT TRUST THE DISTANCES IN THIS FILE. The stations above are correct and
 * the ground survey at the gate is correct. The braking rows are not, and they
 * disagree with themselves: seed 1 reports travelling 3.9 m while also reporting
 * 2.57 s at a mean of 1.15 g, which is 37 m. The stop test is `p.vx < 0.5`, and
 * `vx` is crossed by a car that is still sliding, so the row is timing something
 * that is not a stop and measuring a straight line to a point the car had not
 * finished leaving. tools/zystop.mjs replaces it: speed as a magnitude, held for
 * a tenth of a second, path length integrated per step, and the handbrake taken
 * over at walking pace so the brake pedal cannot select reverse. Left here
 * because the survey is still worth running and deleting it would lose that.
 *
 * Also reports the ground around the gate, because a held camera has to stand
 * somewhere and the alternative to measuring that is discovering it inside a
 * hillside in a capture.
 *
 *   node tools/finstop.mjs [--seeds 22,1,7]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,7,26,40').split(',').map(Number);

const PROBE = async ([]) => {
  const g = window.__game;
  const p = g.player;
  const L = g.track.length;
  const LINE = g.track.finishS;
  const GATE = g.track.gateS;
  /* The edge is `roadEnd` and no longer `length`. Every `L` below that meant
     "where the road stops" is now END; the ones that remain are the course
     length, which is all `goTo` knows how to take a fraction of. */
  const END = g.track.roadEnd;

  /* Arrive the way a race arrives: autopilot from well back, at speed, and
     stop the run the frame `finished` latches. Never a parked car. */
  const arrive = () => {
    /* `restart()` first, or the run inherits however far the page's own loop
       carried the car before the harness took the wheel — see tools/zjdet.mjs.
       This tool predates that finding and did not have it. */
    g.restart();
    g.autopilot(true, 0.85);
    g.goTo((LINE - 260) / L);
    p.finished = false; p.raceTime = 0;
    for (let i = 0; i < 30 * 60 && !p.finished; i++) g.step(1 / 60);
    return { s: p.s, speed: p.speed };
  };

  const at = arrive();

  /* Free-roll: what shipping does today. Autopilot is left on the wheel, so
     this is the game's own behaviour past the line and not a straw man. */
  const roll = [];
  for (let i = 0; i < 4 * 60; i++) {
    g.step(1 / 60);
    if (i % 30 === 29) roll.push({ t: +((i + 1) / 60).toFixed(1), s: +p.s.toFixed(1), kmh: +p.kmh.toFixed(0),
      offEnd: +(p.pos.distanceTo(g.track.frameAt(END).pos)).toFixed(1) });
  }

  /* Brakes buried from the same arrival, with no steering input at all —
     the pessimistic case, since a locked wheel is not the shortest stop.
     `vx` and not `speed`: `speed` is a hypot and cannot go negative, and the
     car selects reverse the moment it runs out of forward speed with the
     pedal still down, so a test on `speed` watches it drive back up the road
     and calls the whole excursion the stop. */
  const braked = [];
  for (const [label, input] of [
    ['brake', { steer: 0, throttle: 0, brake: 1, handbrake: 0 }],
    ['coast', { steer: 0, throttle: 0, brake: 0, handbrake: 0 }],
  ]) {
    const a = arrive();
    g.autopilot(false);
    g.botInput = input;
    /* Where the car really is, not `s`: past the last frame `s` is pinned at
       track.roadEnd and stops reporting travel, which is the exact failure
       this tool is about. Ground distance from the crossing point is honest
       on both sides of the edge. */
    const p0 = p.pos.clone();
    let t = 0, stopped = -1, atEdge = null, travelled = 0;
    for (let i = 0; i < 15 * 60; i++) {
      const wasBefore = p.s < END - 0.05;
      g.step(1 / 60);
      t += 1 / 60;
      travelled = p.pos.distanceTo(p0);
      if (wasBefore && p.s >= END - 0.05) atEdge = +(p.speed * 3.6).toFixed(0);
      if (p.vx < 0.5) { stopped = t; break; }
    }
    braked.push({
      label, fromKmh: +(a.speed * 3.6).toFixed(0),
      dist: +travelled.toFixed(1), secs: +stopped.toFixed(2),
      atEdgeKmh: atEdge, pinned: p.s >= END - 0.05,
      overEdge: +(travelled - (END - a.s)).toFixed(1),
      meanG: stopped > 0 ? +(a.speed / stopped / 9.81).toFixed(2) : null,
    });
    g.botInput = null;
  }

  /* The ground around the gate, for a camera that has to stand still and
     look at it. Sampled on the road frame at the gate: lateral offsets each
     side, and how far above the road surface the terrain is there. */
  const f = g.track.frameAt(GATE);
  const solid = g.solid;
  const ground = [];
  for (const lat of [-26, -20, -14, -10, 10, 14, 20, 26]) {
    const o = f.pos.clone().addScaledVector(f.flatRight, lat);
    /* Straight down from well above: distance to the first surface is the
       terrain height under that station, referenced to the road. */
    const d = solid.raycast(o.x, o.y + 40, o.z, 0, -1, 0, 120, 1.2);
    ground.push({ lat, rise: Number.isFinite(d) ? +(40 - d).toFixed(1) : null });
  }

  return {
    seed: g.seed, length: +L.toFixed(1),
    line: +LINE.toFixed(1), gate: +GATE.toFixed(1), edge: +END.toFixed(1),
    lineToGate: +(GATE - LINE).toFixed(1),
    lineToEdge: +(END - LINE).toFixed(1),
    gateToEdge: +(END - GATE).toFixed(1),
    arriveS: +at.s.toFixed(1), arriveKmh: +(at.speed * 3.6).toFixed(0),
    roll, braked, ground,
  };
};

/* The warning above is in the source, where nobody quoting a number from a
   captured log ever reads it. Put it in the output too. This changes no
   measurement; the braking rows are exactly as wrong as they were. */
console.log('\n  ⚠ THE BRAKING ROWS BELOW ARE WRONG AND ARE KEPT ONLY FOR THE SURVEY.');
console.log('    The stop test is `p.vx < 0.5`, which a still-sliding car crosses, so'
  + '\n    `dist` and `secs` describe something that is not a stop and disagree with'
  + '\n    their own mean-g column. Use tools/zystop.mjs for stopping distances.'
  + '\n    The stations, and the ground survey at the gate, are correct.\n');

for (const seed of SEEDS) {
  await run({
    width: 320, height: 200, hash: `manual&tier=high&seed=${seed}&cap=60&hud=0`,
  }, async ({ page }) => {
    const r = await page.evaluate(PROBE, []);
    console.log(`\n  seed ${r.seed}   course ${r.length} m`
      + `   line ${r.line}   gate ${r.gate}   edge ${r.edge}`
      + `   (${r.lineToEdge} m of road past the line)`);
    console.log(`    arrives at the line doing ${r.arriveKmh} km/h`);
    for (const b of r.braked) {
      console.log(`    ${b.label.padEnd(6)} from ${String(b.fromKmh).padStart(3)} km/h:`
        + ` travels ${String(b.dist).padStart(6)} m in ${String(b.secs).padStart(5)} s`
        + `  (mean ${b.meanG}g)`
        + `  reaches the edge at ${b.atEdgeKmh === null ? 'n/a' : b.atEdgeKmh + ' km/h'}`
        + `  ${b.overEdge > 0 ? `— ${b.overEdge} m PAST THE EDGE` : `— stops ${-b.overEdge} m short of it`}`);
    }
    console.log(`    shipping, left alone past the line:`);
    for (const x of r.roll) {
      console.log(`      +${x.t}s  s=${x.s}  ${x.kmh} km/h  ${x.offEnd} m from the last road frame`);
    }
    console.log(`    ground beside the gate (m above the road at that station):`);
    console.log('      ' + r.ground.map(x => `${x.lat > 0 ? '+' : ''}${x.lat}m:${x.rise === null ? '—' : x.rise}`).join('  '));
  });
}
finish(process.exitCode || 0);
