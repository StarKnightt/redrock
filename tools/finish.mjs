/* The ending, measured and shot.
 *
 * Drives the real race in at racing speed — never a parked car, never a
 * bypassed pipeline — lets the flag fall, and reports the four things the
 * sequence can get wrong:
 *
 *   where the car actually stops, against the road it has to stop on
 *   whether the held lens is standing inside anything
 *   what the rivals do once they are past the line
 *   how big the classification card is, in device pixels
 *
 * Captures at native 1600x900 through g.pipeline.render(), composited with
 * the HUD overlay, at the crossing, the hold and the card.
 *
 *   node tools/finish.mjs [--seeds 22,1,7] [--shots 0]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,7').split(',').map(Number);
const SHOTS = flag('shots', '1') !== '0';
const outDir = path.join(ROOT, 'shots', 'finish');

/* Everything the page has to do, in one function so the drawing buffer is
   still alive when a frame is read back. */
const PROBE = async ([wantShots]) => {
  const g = window.__game;
  const p = g.player;
  /* Three stations where there were two, and the third is the one that moved.
     `length` is still the COURSE, so `length - 34` still lands on the line and
     that value was never wrong here. What was wrong is `L` standing in for the
     end of the road as well: the road now runs to `roadEnd`, 120 m further on,
     so `roadLeft` below was measuring to the end of the course and reporting a
     car with 135 m under it as having 15. Named stations for all three. */
  const L = g.track.length;
  const LINE = g.track.finishS;
  const END = g.track.roadEnd;

  const shot = () => {
    g.pipeline.render();
    if (g.hudOn) g.hud.draw();
    const src = g.renderer.domElement;
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const x = c.getContext('2d');
    x.drawImage(src, 0, 0);
    x.drawImage(g.hud.canvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  };

  /* How much clear air the lens has, as the shortest of six axis casts. The
     chase camera's own occlusion test lives in a file this pass may not
     touch, so the held pose has to be able to prove itself. */
  const clearance = () => {
    const c = g.camera.position;
    let worst = Infinity, dir = null;
    for (const [dx, dy, dz, name] of [
      [1, 0, 0, '+x'], [-1, 0, 0, '-x'], [0, 1, 0, 'up'],
      [0, -1, 0, 'down'], [0, 0, 1, '+z'], [0, 0, -1, '-z'],
    ]) {
      const d = g.solid.raycast(c.x, c.y, c.z, dx, dy, dz, 30, 1.0);
      if (d < worst) { worst = d; dir = name; }
    }
    return { m: +worst.toFixed(2), dir };
  };

  /* The `/3` bug, asserted before anything in this file steps the game — which
     is the whole point of it. Race.fieldSize is _order.length, the player was
     only added by _ensurePlayer, _ensurePlayer was only reached from
     Race.step, and main.js gates Race.step on a stepped frame. Nothing steps
     during the countdown hold, so for the three seconds a player spends
     staring at the HUD the field was three cars. Read here at zero steps: if
     it says 4, the constructor put the player in. */
  const fieldAtBoot = g.race.fieldSize;

  g.setPaused(true);
  g.hudOn = true;
  g.setView('chase');
  g.ending.enabled = true;

  /* Does "race again" give the same race?
   *
   * Asked first, before anything else touches this page, because it is the
   * one claim about the restart that matters and it is not observable from a
   * screenshot. Twenty seconds of autopilot from a cold boot, then the same
   * twenty seconds again with nothing between them but g.restart(), sampled
   * every second and differenced. A restart that leaves so much as a steering
   * angle or an unspent substep behind shows up here as a divergence that
   * grows, which is exactly how every other determinism gate in tools/ is
   * built. */
  const lap = () => {
    const out = [];
    g.autopilot(true, 0.9);
    for (let i = 0; i < 20 * 60; i++) {
      g.step(1 / 60);
      if (i % 60 === 59) out.push(+p.s.toFixed(3));
    }
    return out;
  };
  const fresh = lap();

  // In at racing speed from 220 m back, the way a race arrives.
  g.autopilot(true, 0.9);
  g.goTo((LINE - 220) / L);
  p.finished = false; p.raceTime = 0;
  g.race.reset(p.s);
  g.race.join(p);
  /* goTo skipped the ending on the way past — that is the whole point of it.
     Re-arm now that the car is where a tool wants it. */
  g.ending.arm();

  /* The approach, kept in a ring so the crossing can be read against the
     three seconds of ordinary racing in front of it. Without that baseline a
     yaw rate at the line is just a number. */
  const approach = [];
  for (let i = 0; i < 40 * 60 && !p.finished; i++) {
    g.step(1 / 60);
    approach.push({ past: +(p.s - LINE).toFixed(1), kmh: +p.kmh.toFixed(0),
      r: +(p.r * 180 / Math.PI).toFixed(0),
      slip: +(Math.atan2(p.vy, p.vx) * 180 / Math.PI).toFixed(0) });
    if (approach.length > 180) approach.shift();
  }
  const before = approach.filter((_, i) => i % 15 === 0).slice(-8);
  const crossKmh = +p.kmh.toFixed(0);
  const crossS = +p.s.toFixed(1);
  const shots = {};
  if (wantShots) shots.cross = shot();

  /* Now watch the stop. Sampled every frame, because the numbers that matter
     — the deepest the car gets and the hardest the pedal goes — are single
     frames somewhere in the middle. */
  let maxBrake = 0, maxHand = 0, deepest = p.s, stoppedAt = -1;
  let maxSlip = 0, nearestEdge = Infinity;
  let t = 0;
  const trace = [];
  /* World-space travel between samples, to be read against `past`. The two
     disagreeing is the whole reason this column exists: `s` is a projection
     onto the centreline and a car can move a long way without changing it. */
  let markPos = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
  for (let i = 0; i < 10 * 60; i++) {
    g.step(1 / 60);
    t += 1 / 60;
    maxBrake = Math.max(maxBrake, p.brake);
    maxHand = Math.max(maxHand, p.handbrake);
    deepest = Math.max(deepest, p.s);
    /* Only while there is enough velocity for a direction to mean anything.
       atan2 of two numbers either side of zero is noise, and below walking
       pace that is all it is — an earlier run of this tool reported 101° of
       slip on a car that had been stationary for half a second. */
    if (p.kmh > 5) {
      maxSlip = Math.max(maxSlip, Math.abs(Math.atan2(p.vy, p.vx) * 180 / Math.PI));
      const hw = g.track.frameAt(p.s).width * 0.5;
      nearestEdge = Math.min(nearestEdge, hw - Math.abs(p.lat));
    }
    if (stoppedAt < 0 && p.speed < 0.5) stoppedAt = t;
    if (i % 15 === 14 && trace.length < 12) {
      /* lat and slip are here because the first working stop was measured
         with neither, and the trace showed a car whose `s` had stopped
         advancing while it still read 24 km/h — which is unreadable without
         knowing which way it was pointing. */
      trace.push({ t: +t.toFixed(2), past: +(p.s - LINE).toFixed(1),
        kmh: +p.kmh.toFixed(0), brake: +p.brake.toFixed(2), hb: +p.handbrake.toFixed(2),
        lat: +p.lat.toFixed(1),
        edge: +(g.track.frameAt(p.s).width * 0.5).toFixed(1),
        slip: +(Math.atan2(p.vy, p.vx) * 180 / Math.PI).toFixed(0),
        steer: +(p.steer * 180 / Math.PI).toFixed(0),
        r: +(p.r * 180 / Math.PI).toFixed(0),
        moved: +Math.hypot(p.pos.x - markPos.x, p.pos.y - markPos.y,
          p.pos.z - markPos.z).toFixed(1),
        bias: +g.ending.servo.bias.toFixed(1),
        cam: +g.ending.camera.toFixed(2) });
      markPos = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
    }
    if (wantShots && !shots.hold && t >= 1.2) shots.hold = shot();
  }
  const held = clearance();
  const heldCam = { ...g.camera.position };
  if (wantShots) shots.card = shot();

  /* The card, in device pixels. Screen-space size is the thing this project
     keeps getting wrong.
     Differenced against the same frame with the card's own alpha held at
     zero, and NOT against a frame with no ending at all. The ending dims the
     rest of the HUD, so the naive difference is every lit pixel on screen —
     which is exactly what the first version of this measured, and it duly
     reported the results card as 88.5% of the frame. Holding the dim on both
     sides leaves the card and its prompt as the only things that moved. */
  const hud = g.hud;
  const end = hud.state.ending;
  const keep = { alpha: end.alpha, prompt: end.prompt };
  const gx = hud.canvas.getContext('2d');
  const W = hud.canvas.width, H = hud.canvas.height;
  end.alpha = 0; end.prompt = 0;
  hud.draw();
  const plain = gx.getImageData(0, 0, W, H).data;
  Object.assign(end, keep);
  hud.draw();
  const withIt = gx.getImageData(0, 0, W, H).data;
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, px = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let d = 0;
      for (let k = 0; k < 4; k++) d += Math.abs(plain[i + k] - withIt[i + k]);
      if (d < 8) continue;
      px++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }

  // And let the rest of the field come home, so the parking can be checked.
  for (let i = 0; i < 90 * 60; i++) {
    g.step(1 / 60);
    if (g.race.standings().every(x => x.finished)) break;
  }
  if (wantShots) shots.field = shot();
  const parked = g.race.standings().map(x => ({
    name: x.isPlayer ? 'PLAYER' : x.name,
    pos: x.position, finished: x.finished,
    time: +x.time.toFixed(2),
    past: +(x.car.s - LINE).toFixed(1),
    lat: +x.car.lat.toFixed(1),
    kmh: +x.car.kmh.toFixed(1),
    rec: x.recoveries,
  }));

  /* Where the car actually finished up, read BEFORE the restart below puts it
     back on the grid — which the first version of this did not, and duly
     reported the stop as 4863 m short of the line. */
  const rest = { past: +(p.s - LINE).toFixed(1), lat: +p.lat.toFixed(1) };

  /* And now the restart, from exactly where a player would press it: the
     results card, with the whole field parked, the servo's observer wound up,
     the camera held and the car sitting on a steering angle it stopped on.
     Compared against the twenty seconds recorded off a cold boot at the top
     of this probe. */
  g.restart();
  const again = lap();
  /* And a second restart, because "restart matches cold boot" and "restart
     matches restart" are different claims and only one of them turned out to
     be true. Cheap to ask and it is the difference between blaming this
     file and blaming the boot. */
  g.restart();
  const third = lap();
  const worst = (a, b) => +Math.max(...a.map((s, i) => Math.abs(s - b[i]))).toFixed(3);
  const restart = {
    worst: worst(fresh, again),
    stable: worst(again, third),
    n: fresh.length,
    endFresh: fresh[fresh.length - 1],
    endAgain: again[again.length - 1],
    endThird: third[third.length - 1],
  };

  return {
    seed: g.seed, L: +L.toFixed(0), LINE: +LINE.toFixed(0), END: +END.toFixed(0),
    crossKmh, crossS, before, restart, fieldAtBoot,
    maxSlip: +maxSlip.toFixed(0),
    nearestEdge: +nearestEdge.toFixed(1),
    restLat: rest.lat,
    stopPast: rest.past,
    deepestPast: +(deepest - LINE).toFixed(1),
    roadLeft: +(END - deepest).toFixed(1),
    stoppedAt: +stoppedAt.toFixed(2),
    maxBrake: +maxBrake.toFixed(2), maxHand: +maxHand.toFixed(2),
    trace, held, heldCam,
    card: { W, H, px, box: px ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null },
    parked, shots,
  };
};

if (SHOTS) fs.mkdirSync(outDir, { recursive: true });

for (const seed of SEEDS) {
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${seed}&cap=60&ending=1`,
  }, async ({ page }) => {
    const r = await page.evaluate(PROBE, [SHOTS]);
    console.log(`\n  seed ${r.seed}   course ${r.L} m, line at ${r.LINE}`
      + `, road ends at ${r.END} (${r.END - r.LINE} m of run-off)`);
    console.log(`    field size at zero steps: ${r.fieldAtBoot}`
      + `  ${r.fieldAtBoot === 4 ? '✓' : '✗ the /3 bug is back'}`);
    console.log(`    race again: 20 s of autopilot, ${r.restart.n} samples`
      + `   boot ${r.restart.endFresh}  restart ${r.restart.endAgain}`
      + `  restart again ${r.restart.endThird}`);
    console.log(`      vs cold boot ${r.restart.worst} m`
      + `${r.restart.worst === 0 ? ' ✓' : ' ✗'}`
      + `   restart vs restart ${r.restart.stable} m`
      + `${r.restart.stable === 0 ? ' ✓' : ' ✗'}`);
    console.log(`    crosses at ${r.crossKmh} km/h`);
    console.log(`    approach (yaw/s, slip) : `
      + r.before.map(x => `${x.past}m ${x.r}/${x.slip}`).join('  '));
    console.log(`    stops ${r.stopPast} m past the line`
      + ` (deepest ${r.deepestPast}, ${r.roadLeft} m of road still ahead of it)`
      + ` after ${r.stoppedAt} s`);
    console.log(`    pedal peaks: brake ${r.maxBrake}  handbrake ${r.maxHand}`);
    console.log(`    worst slip while moving ${r.maxSlip}°,`
      + ` closest to the verge ${r.nearestEdge} m, rests at lat ${r.restLat}`);
    console.log('      t     past  moved  km/h  brake   hb    lat / edge  steer  yaw/s  slip  bias   cam');
    for (const x of r.trace) {
      console.log(`      ${String(x.t).padStart(5)} ${String(x.past).padStart(6)}`
        + ` ${String(x.moved).padStart(6)}`
        + ` ${String(x.kmh).padStart(5)} ${String(x.brake).padStart(6)}`
        + ` ${String(x.hb).padStart(4)} ${String(x.lat).padStart(6)}`
        + ` ${String(x.edge).padStart(6)}${Math.abs(x.lat) > x.edge ? ' OFF' : '    '}`
        + ` ${String(x.steer).padStart(6)} ${String(x.r).padStart(6)}`
        + ` ${String(x.slip).padStart(5)} ${String(x.bias).padStart(5)}`
        + ` ${String(x.cam).padStart(5)}`);
    }
    console.log(`    held lens: nearest surface ${r.held.m} m (${r.held.dir})`);
    console.log(`    card: ${r.card.px} px changed, box`
      + (r.card.box ? ` x${r.card.box[0]} y${r.card.box[1]}  ${r.card.box[2]} x ${r.card.box[3]} device px`
        + `  = ${((r.card.box[2] * r.card.box[3]) / (r.card.W * r.card.H) * 100).toFixed(1)}% of frame`
        : ' NOTHING DRAWN'));
    console.log('    classification, once everyone is home:');
    for (const x of r.parked) {
      console.log(`      P${x.pos} ${String(x.name).padEnd(7)}`
        + ` ${x.finished ? x.time.toFixed(2) + 's' : 'DNF   '}`
        + `  parked ${String(x.past).padStart(5)} m past the line, lat ${String(x.lat).padStart(5)}`
        + `, ${x.kmh} km/h${x.rec ? `, ${x.rec} recoveries` : ''}`);
    }
    if (SHOTS) {
      for (const [k, data] of Object.entries(r.shots)) {
        fs.writeFileSync(path.join(outDir, `${seed}-${k}.png`),
          Buffer.from(data.split(',')[1], 'base64'));
      }
      console.log(`    → shots/finish/${seed}-*.png`);
    }
  });
}
finish(process.exitCode || 0);
