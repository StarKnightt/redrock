/* Photograph a turn-around, so the manoeuvre can be judged and not just timed.
 *
 * A duration says a recovery got faster. It does not say whether the car
 * looked like it knew what it was doing, and that is the actual complaint.
 * This replays a race to a known spin — deterministically, set up exactly as
 * tools/spin.mjs sets it up — and shoots the manoeuvre as a strip of frames
 * from an elevated three-quarter, which is the angle a car's heading reads
 * from.
 *
 *   node tools/spinshot.mjs [tag] --seed 3 --at 41.0 --car SAGE
 *                           [--frames 8] [--every 0.8] [--lead 0.6]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = (args[0] && !args[0].startsWith('--')) ? args[0] : 'spinshot';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const SEED = +flag('seed', 1);
const AT = +flag('at', 40);
const CAR = flag('car', null);
const FRAMES = +flag('frames', 8);
const EVERY = +flag('every', 0.8);
const LEAD = +flag('lead', 0.6);
const W = +flag('w', 960), H = +flag('h', 540);

const outDir = path.join(ROOT, 'shots', tag);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const SETUP = async ([seed, until]) => {
  const { Race } = await import('/src/race/index.js');
  const g = window.__game;
  const p = g.player;
  if (g.race) g.race.dispose();
  const race = new Race(g.track, g.scene, { seed });
  g.race = race;
  g.botInput = { steer: 0, throttle: 0, brake: 1, handbrake: 0 };
  g.step(1 / 60);
  const wired = race._clock > 0;
  race.reset();
  g.botInput = null;
  g.autopilot(true, 0.85);
  g.bot.wobble = 5; g.bot.boost = 1;
  p.placeAt(34, 0); p.vx = 0; p.vy = 0; p.r = 0;
  p.raceTime = 0; p.finished = false; p.rpm = 1050; p.gear = 0;
  window.__spin = { wired, t: 0 };
  for (let i = 0; i < until * 60; i++) {
    g.step(1 / 60);
    if (p.strandedFor > 2.5) p.recover();
    if (!wired) race.step(1 / 60, p);
    window.__spin.t += 1 / 60;
  }
  return true;
};

const ADVANCE = ([secs, name]) => {
  const g = window.__game;
  const p = g.player;
  const st = window.__spin;
  for (let i = 0; i < Math.round(secs * 60); i++) {
    g.step(1 / 60);
    if (p.strandedFor > 2.5) p.recover();
    if (!st.wired) g.race.step(1 / 60, p);
    st.t += 1 / 60;
  }
  const e = g.race.entries.find(x => x.name === name) || g.race.entries[0];
  const car = e.car;
  car.applyTo(e.view);
  e.view.root.visible = true;

  /* Elevated three-quarter from the open side of the road, tracking the car.
     A chase camera sits behind the car and shows a turn-around as the world
     rotating, which is exactly the thing that cannot be judged. */
  const f = g.track.frameAt(car.s);
  const side = -Math.sign(car.lat || 1);
  g.freeCam = true;
  const cam = g.camera;
  cam.up.set(0, 1, 0);
  cam.position.copy(car.pos)
    .addScaledVector(f.right, side * 12)
    .addScaledVector(f.tan, -7);
  cam.position.y += 8.5;
  cam.fov = 42; cam.near = 0.1; cam.far = 4000;
  cam.updateProjectionMatrix();
  cam.lookAt(car.pos.x, car.pos.y + 0.4, car.pos.z);
  /* Hold the sim still until the capture. The rAF loop keeps stepping between
     evaluates, and one of the things it steps is the race's own culling — a
     rival more than 450 m from the player is hidden, which for a car that has
     spun and lost half a minute is most of them. Two frames of that between
     framing the shot and taking it is a photograph of an empty road. */
  g.setPaused(true);

  const facing = car.forward.dot(f.tan);
  const rec = e.driver.rec;
  return {
    t: +st.t.toFixed(2),
    name: e.name,
    s: +car.s.toFixed(0),
    head: +(Math.acos(Math.max(-1, Math.min(1, facing))) * 180 / Math.PI).toFixed(0),
    kmh: +car.kmh.toFixed(0),
    vx: +car.vx.toFixed(1),
    lat: +car.lat.toFixed(1),
    hw: +(f.width * 0.5).toFixed(1),
    thr: +car.throttle.toFixed(2),
    brk: +car.brake.toFixed(2),
    steer: +(car.steer * 180 / Math.PI).toFixed(0),
    leg: rec ? (rec.gear > 0 ? 'forward' : 'reverse') : '—',
  };
};

await run({ width: W, height: H, hash: 'manual' }, async ({ page }) => {
  await page.evaluate(SETUP, [SEED, Math.max(0, AT - LEAD)]);
  console.log(`\n  seed ${SEED}, watching ${CAR || 'first rival'} from t=${(AT - LEAD).toFixed(1)}s\n`);
  console.log('   file          t       s   head    km/h     vx   lat/hw   thr   brk  steer   leg');
  const rows = [];
  for (let i = 0; i < FRAMES; i++) {
    const st = await page.evaluate(ADVANCE, [i === 0 ? 0 : EVERY, CAR]);
    const file = `${String(i).padStart(2, '0')}.png`;
    await capture(page, path.join(outDir, file));
    rows.push({ file, ...st });
    console.log(`   ${file}  ${String(st.t).padStart(6)}  ${String(st.s).padStart(6)}  ` +
      `${String(st.head).padStart(4)}°  ${String(st.kmh).padStart(5)}  ${String(st.vx).padStart(6)}  ` +
      `${String(st.lat).padStart(5)}/${String(st.hw).padStart(4)}  ${String(st.thr).padStart(4)}  ` +
      `${String(st.brk).padStart(4)}  ${String(st.steer).padStart(4)}°  ${st.leg}`);
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ seed: SEED, at: AT, car: CAR, rows }, null, 1));
  console.log(`\n  → shots/${tag}`);
});

finish(process.exitCode || 0);
