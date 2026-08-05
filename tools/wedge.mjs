/* Deterministic reproductions of "the car is stuck".
 *
 * The stage sweep in tools/stuck.mjs finds where it happens; this puts the car
 * into each candidate state by hand and drives it with a fixed input, so the
 * result is a number that does not move between runs. No AI, no Math.random.
 *
 *   node tools/wedge.mjs
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const CASES = (opts) => {
  const g = window.__game;
  const p = g.player;
  const H = 1 / 120;
  const T = g.track;

  const hold = (input, secs) => {
    g.botInput = input;
    for (let i = 0; i < secs * 120; i++) g.step(H);
  };
  const nul = { steer: 0, throttle: 0, brake: 0, handbrake: 0 };

  /* Put the car at `s`, then rotate it to `deg` away from the road tangent.
     placeAt always faces down the road, so the heading is applied after. */
  const face = (s, lat, deg) => {
    p.placeAt(s, lat);
    p.yaw += deg * Math.PI / 180;
    p.forward.set(Math.cos(p.yaw), 0, Math.sin(p.yaw));
    p.forward.addScaledVector(p.up, -p.forward.dot(p.up)).normalize();
    p.right.crossVectors(p.forward, p.up).normalize();
  };
  const state = () => {
    const f = T.frameAt(p.s);
    return {
      s: +p.s.toFixed(1), lat: +p.lat.toFixed(2), kmh: +p.kmh.toFixed(1),
      vx: +p.vx.toFixed(2), vy: +p.vy.toFixed(2),
      head: +(Math.acos(Math.max(-1, Math.min(1, p.forward.dot(f.tan)))) * 180 / Math.PI).toFixed(0),
      contact: !!p._contact, strand: +p.strandedFor.toFixed(1),
    };
  };
  const travel = (fn) => {
    const a = p.pos.clone(); const s0 = p.s;
    fn();
    return { moved: +p.pos.distanceTo(a).toFixed(1), gained: +(p.s - s0).toFixed(1) };
  };

  /* A steep part of the stage, so gravity is doing its worst. */
  let steep = 40, worst = 0;
  for (let s = 60; s < T.length - 80; s += 10) {
    const gr = T.frameAt(s).grade;
    if (gr < worst) { worst = gr; steep = s; }
  }

  const out = { steepAt: +steep.toFixed(0), steepGrade: +worst.toFixed(3), cases: [] };
  const add = (name, note, r) => out.cases.push({ name, note, ...r });

  /* A — spun to a stop facing back up the hill, and the player does the
       instinctive thing: stands on the brake. */
  face(steep, 0, 180);
  add('A spun, brake held', 'wants: stays put',
    { ...travel(() => hold({ steer: 0, throttle: 0, brake: 1, handbrake: 0 }, 6)), end: state() });

  /* B — same, but coasting. The honest baseline for how far gravity alone
       rolls the car back in six seconds. */
  face(steep, 0, 180);
  add('B spun, no input', 'wants: rolls back slowly',
    { ...travel(() => hold(nul, 6)), end: state() });

  /* C — same, and the player tries to drive out of it. */
  face(steep, 0, 180);
  add('C spun, throttle held', 'wants: drives off up the road',
    { ...travel(() => hold({ steer: 1, throttle: 1, brake: 0, handbrake: 0 }, 6)), end: state() });

  /* D — already rolling backwards at speed, brake applied. This is the state
       the AI reaches after a spin on a descent. */
  face(steep, 0, 180);
  p.vx = -8;
  add('D rolling back 8 m/s, brake', 'wants: stops',
    { ...travel(() => hold({ steer: 0, throttle: 0, brake: 1, handbrake: 0 }, 6)), end: state() });

  /* Nose into the barrier. Which way round that is depends on the sign
     conventions of the frame, so it is measured rather than assumed: park the
     car against the right-hand wall at each diagonal and keep whichever one
     ends up pointing at it. Nothing in the wall code reads the car's forward
     velocity, only its lateral one, so this is the case that would wedge. */
  const f = T.frameAt(steep);
  const wallLat = f.width * 0.5 + 0.9;
  const intoWall = (deg) => { face(steep, wallLat, deg); return p.forward.dot(T.frameAt(p.s).right); };
  const diag = intoWall(45) > 0 ? 45 : -45;
  const square = intoWall(90) > 0 ? 90 : -90;

  face(steep, wallLat, diag);
  add('E nose in wall 45°, full throttle', 'wants: escapes',
    { ...travel(() => hold({ steer: 0, throttle: 1, brake: 0, handbrake: 0 }, 6)), end: state() });

  face(steep, wallLat, square);
  add('F nose in wall 90°, full throttle', 'wants: escapes, or at least is not held at full noise',
    { ...travel(() => hold({ steer: 0, throttle: 1, brake: 0, handbrake: 0 }, 6)), end: state() });

  /* F2 — square into the barrier and the driver steers hard, which is what
       anyone actually does. Full lock plus full throttle. */
  face(steep, wallLat, square);
  add('F2 nose in wall 90°, throttle + full lock', 'wants: escapes',
    { ...travel(() => hold({ steer: -1, throttle: 1, brake: 0, handbrake: 0 }, 6)), end: state() });

  /* G — stopped square in the road, standing start. The control: if this ever
       fails the problem is torque, not geometry. */
  face(steep, 0, 0);
  add('G standing start on road', 'wants: pulls away',
    { ...travel(() => hold({ steer: 0, throttle: 1, brake: 0, handbrake: 0 }, 6)), end: state() });

  /* H — reverse out of the barrier from rest, which is what the brake-as-
       reverse branch exists for and must keep doing. */
  face(steep, wallLat, diag);
  p.vx = 0; p.vy = 0;
  add('H reverse out of wall from rest', 'wants: backs away',
    { ...travel(() => hold({ steer: 0, throttle: 0, brake: 1, handbrake: 0 }, 4)), end: state() });

  /* The state every long stall in the stage sweep actually ends in: spun
     round, up on the berm, pointing back up the road. If the player cannot
     drive out of this then the R key is not a convenience, it is mandatory. */
  const perch = (deg) => {
    face(steep, wallLat, deg);
    p.vx = 0; p.vy = 0;
    // Let it settle onto the berm rather than testing the placement pose.
    hold(nul, 0.4);
  };

  perch(180);
  add('K perched on berm, throttle + lock', 'wants: drives off it',
    { ...travel(() => hold({ steer: 1, throttle: 1, brake: 0, handbrake: 0 }, 6)), end: state() });

  perch(180);
  add('L perched on berm, no input', 'wants: does not run away on its own',
    { ...travel(() => hold(nul, 6)), end: state() });

  perch(180);
  add('M perched on berm, brake (reverse)', 'wants: backs off it',
    { ...travel(() => hold({ steer: 0, throttle: 0, brake: 1, handbrake: 0 }, 6)), end: state() });

  /* I — how long the built-in safety net takes to notice, and whether one
       application of it is enough. */
  face(steep, 0, 180);
  p.vx = 0;
  hold(nul, 3);
  const beforeRecover = state();
  p.recover();
  hold(nul, 0.5);
  add('I recover() from a spin', 'wants: pointing down the road, clear of the trap',
    { moved: null, gained: null, before: beforeRecover, end: state() });

  /* J — respawn(), the player-facing R key, from the same state. */
  face(steep, 0, 180);
  p.vx = 0;
  hold(nul, 3);
  g.respawn();
  hold(nul, 0.5);
  add('J respawn() from a spin', 'wants: same', { moved: null, gained: null, end: state() });

  g.botInput = null;
  return out;
};

await run({ width: 480, height: 270, hash: 'manual' }, async ({ page }) => {
  const r = await page.evaluate(CASES, {});
  console.log(`\n  steepest point s=${r.steepAt} m, grade ${(r.steepGrade * 100).toFixed(1)}%\n`);
  for (const c of r.cases) {
    const head = `  ${c.name}`.padEnd(40);
    const m = c.moved === null ? '' : `moved ${String(c.moved).padStart(6)} m, s ${c.gained > 0 ? '+' : ''}${c.gained} m  `;
    console.log(`${head}${m}→ ${JSON.stringify(c.end)}`);
    if (c.before) console.log(`${''.padEnd(40)}  before: ${JSON.stringify(c.before)}`);
    console.log(`${''.padEnd(40)}  ${c.note}`);
  }
});

finish(process.exitCode || 0);
