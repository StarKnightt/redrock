/* Where does the car stop making progress, and what is holding it there?
 *
 * Runs the AI down the stage and records every window where arc-length
 * progress falls below a walking pace for longer than a second, capturing the
 * full car state at the worst moment of each. The point is to tell two classes
 * of bug apart: if the events cluster at a handful of arc lengths it is the
 * layout, and if they are scattered it is the physics.
 *
 * Recovery is off by default — the AI's automatic recover() is exactly what
 * the player does not have, so leaving it on hides the thing we are looking
 * for.
 *
 *   node tools/stuck.mjs [--seeds 22,7,31] [--skill 0.85] [--recover]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22').split(',').map(Number);
const SKILL = +flag('skill', 0.85);
const RECOVER = args.includes('--recover');
const SECS = +flag('secs', 320);

/* Runs inside the page. Kept as a string so the same body can be evaluated
   once per seed without reloading the module. */
const SWEEP = (opts) => {
  const { skill, recover, secs } = opts;
  const g = window.__game;
  const p = g.player;
  const H = 1 / 120;
  g.botInput = null;
  g.autopilot(true, skill);
  g.race.reset(34);
  g.effects.reset();
  p.placeAt(34, 0); p.raceTime = 0; p.finished = false;

  const V = g.THREE.Vector3;
  const _s = new V();
  /* Ground height under a point, in the local up axis — the same quantity the
     car resolves itself against, so a difference here is a difference the car
     actually feels. */
  const groundAt = (s, lat, f) => p.surfaceAt(s, lat, _s).dot(f.up);

  const vert = (f) => {
    const CARW = 1.5, CARL = 2.4;   // half-track and half-wheelbase, near enough
    const base = groundAt(p.s, p.lat, f);
    const wheels = [];
    for (let i = 0; i < 4; i++) {
      const front = i < 2, left = i % 2 === 0;
      wheels.push(+(groundAt(p.s + (front ? -1 : 1) * CARL, p.lat + (left ? -1 : 1) * CARW, f) - base).toFixed(2));
    }
    return {
      height: +p.height.toFixed(2),        // metres of air under the wheels
      vertVel: +p.vertVel.toFixed(2),
      airborne: p.airborne,
      groundY: +base.toFixed(2),
      wheelGround: wheels,                 // per-corner surface, relative to the car's
      rollDeg: +(p.roll * 180 / Math.PI).toFixed(1),
      pitchDeg: +(p.pitch * 180 / Math.PI).toFixed(1),
      bankDeg: +(f.bank * 180 / Math.PI).toFixed(1),
      susp: p.susp.map(v => +v.toFixed(3)),
      worldY: +p.pos.y.toFixed(2),
    };
  };

  const snap = (t) => {
    const f = g.track.frameAt(p.s);
    const hw = f.width * 0.5;
    return {
      t: +t.toFixed(2),
      s: +p.s.toFixed(1),
      lat: +p.lat.toFixed(2),
      hw: +hw.toFixed(2),
      overWall: +(Math.abs(p.lat) - (hw + 1.05)).toFixed(2),
      kmh: +p.kmh.toFixed(1),
      vx: +p.vx.toFixed(2),
      vy: +p.vy.toFixed(2),
      yawRate: +p.r.toFixed(2),
      slipDeg: +(p.slipAngle * 180 / Math.PI).toFixed(0),
      /* Heading against the road, in degrees. This is the number that says
         whether the car is driving into the wall or merely leaning on it. */
      headingDeg: +(Math.acos(Math.max(-1, Math.min(1, p.forward.dot(f.tan)))) * 180 / Math.PI).toFixed(0),
      contact: !!p._contact,
      airborne: p.airborne,
      height: +p.height.toFixed(2),
      offRoad: +p.offRoad.toFixed(2),
      grade: +f.grade.toFixed(3),
      curv: +f.curv.toFixed(4),
      throttle: +p.throttle.toFixed(2),
      brake: +p.brake.toFixed(2),
      handbrake: +p.handbrake.toFixed(2),
      steerDeg: +(p.steer * 180 / Math.PI).toFixed(0),
      strandedFor: +p.strandedFor.toFixed(2),
      wheelSlip: p.wheelSlip.map(v => +v.toFixed(2)),
      ...vert(f),
    };
  };

  const events = [];
  let open = null, prevS = p.s, t = 0, recoveries = 0;
  let frames = 0, stalledFrames = 0;
  const prevPos = p.pos.clone();
  /* Arc progress over a second, not over a frame. Through a switchback the
     projection is genuinely noisy frame to frame, and a per-frame threshold
     turns ordinary hairpin driving into a hundred fake stalls. */
  const HIST = 120;
  const sRing = new Float64Array(HIST).fill(p.s);
  let ring = 0;
  const trace = [];

  /* Vertical events.
   *
   * Nothing in this model can push the car upward: vertVel starts at zero,
   * only ever has gravity subtracted from it, and is reset to zero on contact.
   * So the car cannot jump — every metre of air it ever gets is the ground
   * moving out from under it, and every metre it rises is the ground rising
   * into it. That makes both directions cheap to detect exactly.
   *
   *   pop   — the surface under the car rose faster than the car could have
   *           driven up any plausible ramp.
   *   dropout — airborne set while the car was still falling slowly or not at
   *           all, i.e. it did not launch off a crest, the floor vanished. */
  const pops = [], dropouts = [];
  let prevHeight = p.height, prevGround = 0, prevAir = p.airborne;

  for (let i = 0; i < secs * 120 && !p.finished; i++) {
    p.lastImpact = 0;
    g.step(H);
    t += H; frames++;
    if (recover && p.strandedFor > 2.5) { p.recover(); recoveries++; }

    {
      /* World Y, not anything resolved against the road frame: the frame's up
         axis rotates with the bank, so a dot product against it moves by
         metres while the car is perfectly level, and reads as a pop that is
         not there. Absolute height cannot lie. */
      const climb = (p.pos.y - prevGround) / H;
      /* The stage only ever descends, so any sustained climb at all is the
         surface lifting the car rather than the car driving up a hill. Two
         metres a second is a 12% climb at 60 km/h — comfortably impossible
         here. */
      if (i > 2 && climb > 2) {
        pops.push({ t: +t.toFixed(2), climb: +climb.toFixed(1), ...snap(t) });
      }
      if (!prevAir && p.airborne && p.vertVel > -0.5 && p.height > 0.25) {
        dropouts.push({ t: +t.toFixed(2), ...snap(t) });
      }
      prevGround = p.pos.y; prevAir = p.airborne; prevHeight = p.height;
    }

    const sAgo = sRing[ring];
    sRing[ring] = p.s; ring = (ring + 1) % HIST;
    const sRate = i < HIST ? 99 : p.s - sAgo;         // metres gained per second
    const worldRate = p.pos.distanceTo(prevPos) / H;  // metres per second moved
    prevPos.copy(p.pos);
    prevS = p.s;

    if (sRate < 2.0) {
      stalledFrames++;
      if (!open) open = { start: t, worst: sRate, dur: 0, at: snap(t), sStart: p.s, minWorld: worldRate, maxWorld: worldRate };
      open.dur = t - open.start;
      open.minWorld = Math.min(open.minWorld, worldRate);
      open.maxWorld = Math.max(open.maxWorld, worldRate);
      if (sRate < open.worst) { open.worst = sRate; open.at = snap(t); open.at.worldRate = +worldRate.toFixed(2); }
      if (trace.length < 4000 && open.dur > 1.0) {
        if (Math.round(t * 4) !== Math.round((t - H) * 4)) {
          const q = snap(t); q.worldRate = +worldRate.toFixed(2); q.sRate = +sRate.toFixed(2);
          trace.push(q);
        }
      }
    } else if (open) {
      if (open.dur > 1.0) { open.sEnd = +p.s.toFixed(1); events.push(open); }
      open = null;
    }
  }
  if (open && open.dur > 1.0) { open.sEnd = +p.s.toFixed(1); events.push(open); }

  return {
    seed: g.seed,
    length: +g.track.length.toFixed(0),
    finished: p.finished,
    time: +p.raceTime.toFixed(1),
    reached: +((p.s / g.track.length) * 100).toFixed(0),
    recoveries,
    stalledPct: +((stalledFrames / frames) * 100).toFixed(1),
    events: events.map(e => ({
      dur: +e.dur.toFixed(2), sStart: +e.sStart.toFixed(1), sEnd: e.sEnd, at: e.at,
      minWorld: +e.minWorld.toFixed(2), maxWorld: +e.maxWorld.toFixed(2),
    })),
    trace,
    pops, dropouts,
  };
};

/* Both vertical events happen at a road edge or they do not, and that single
   fact decides whether this is a geometry problem or a physics one. */
const summarise = (list, label) => {
  if (!list.length) return console.log(`  ${label}: none`);
  const onBerm = list.filter(e => Math.abs(e.lat) > e.hw).length;
  const worst = list.reduce((m, e) => ((e.climb ?? e.height) > (m.climb ?? m.height) ? e : m));
  console.log(`  ${label}: ${list.length}, ${onBerm} of them past the road edge`);
  console.log(`    worst: ${JSON.stringify(worst)}`);
  const byPlace = new Map();
  for (const e of list) {
    const k = Math.round(e.s / 50) * 50;
    byPlace.set(k, (byPlace.get(k) || 0) + 1);
  }
  const top = [...byPlace].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`    ${byPlace.size} distinct 50 m buckets; busiest ` +
    top.map(([s, n]) => `s${s}×${n}`).join(' '));
};

for (const seed of SEEDS) {
  const shooting = args.includes('--shoot');
  await run({
    width: shooting ? 1280 : 480,
    height: shooting ? 720 : 270,
    hash: `manual&seed=${seed}`,
  }, async ({ page }) => {
    const r = await page.evaluate(SWEEP, { skill: SKILL, recover: RECOVER, secs: SECS });
    console.log(`\n─── seed ${r.seed} — ${r.length} m, ${r.finished ? r.time + 's' : 'DNF at ' + r.reached + '%'}` +
      `, ${r.events.length} stalls, ${r.stalledPct}% of frames stalled` +
      (RECOVER ? `, ${r.recoveries} recoveries` : ''));
    for (const e of r.events) {
      const a = e.at;
      console.log(`  ${String(e.dur.toFixed(1)).padStart(6)}s  s=${String(a.s).padStart(6)}  ` +
        `lat ${String(a.lat).padStart(6)} (hw ${a.hw}, over ${a.overWall})  ` +
        `${String(a.kmh).padStart(5)} km/h  world ${String(e.minWorld).padStart(5)}-${String(e.maxWorld).padStart(6)} m/s  ` +
        `vx ${String(a.vx).padStart(6)}  head ${String(a.headingDeg).padStart(3)}°  ` +
        `${a.contact ? 'WALL' : '    '}${a.airborne ? ' AIR' : '    '}  ` +
        `thr ${a.throttle} brk ${a.brake}  off ${a.offRoad}  strand ${a.strandedFor}s`);
    }
    /* Photograph the worst one. The run is deterministic, so replaying it to
       the same frame lands the car in the same place and the camera sees what
       the telemetry was describing. */
    if (args.includes('--shoot') && r.events.length) {
      const worst = r.events.reduce((m, e) => (e.dur > m.dur ? e : m));
      const dir = path.join(ROOT, 'shots', 'stuck');
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, v] of [['stuck-across', { out: 11, along: 2, up: 1.6 }],
        ['stuck-chase', { out: 3, along: -12, up: 3.2 }]]) {
        const info = await page.evaluate(({ skill, until, view }) => {
          const g = window.__game;
          const p = g.player;
          const H = 1 / 120;
          g.botInput = null;
          g.autopilot(true, skill);
          /* Back to the grid, not to wherever the sweep left them. The player
             shares the road with three opponents and step() advances all of
             them, so a replay that only re-places the player is a different
             race and lands somewhere else entirely. */
          g.race.reset(34);
          g.effects.reset();
          p.placeAt(34, 0); p.raceTime = 0; p.finished = false;
          for (let i = 0; i < until * 120; i++) g.step(H);
          p.applyTo(g.playerView);
          g.freeCam = true; g.setPaused(true);
          const f = g.track.frameAt(p.s);
          const side = -Math.sign(p.lat || 1);
          const cam = g.camera;
          cam.position.copy(p.pos)
            .addScaledVector(f.flatRight ?? f.right, side * view.out)
            .addScaledVector(f.tan, view.along);
          cam.position.y += view.up;
          cam.up.set(0, 1, 0); cam.fov = 40; cam.near = 0.1; cam.far = 4000;
          cam.updateProjectionMatrix();
          cam.lookAt(p.pos.x, p.pos.y + 0.3, p.pos.z);
          g.pipeline.render();
          const hw = f.width * 0.5;
          return {
            s: +p.s.toFixed(0), lat: +p.lat.toFixed(2), hw: +hw.toFixed(2),
            kmh: +p.kmh.toFixed(1), offRoad: +p.offRoad.toFixed(2),
            head: +(Math.acos(Math.max(-1, Math.min(1, p.forward.dot(f.tan)))) * 180 / Math.PI).toFixed(0),
          };
        }, { skill: SKILL, until: worst.at.t, view: v });
        await page.waitForTimeout(100);
        await capture(page, path.join(dir, `${name}.png`));
        console.log(`  shot ${name}  ${JSON.stringify(info)}`);
      }
    }

    summarise(r.pops, 'upward pops (floor rose > 6 m/s)');
    summarise(r.dropouts, 'floor dropouts (airborne, not launched)');
    if (r.trace.length && args.includes('--trace')) {
      console.log('\n  trace (4 Hz, inside stall windows):');
      for (const q of r.trace) console.log('   ', JSON.stringify(q));
    }
  });
}

finish(process.exitCode || 0);
