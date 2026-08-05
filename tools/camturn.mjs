/* Sequence captures of the chase camera through a corner, lag on and lag off.
 *
 * Driving the same corner twice does not give a fair pair — the rival field
 * re-seeds itself and the AI's line moves — so the car is driven once, its
 * full visual state recorded frame by frame, and that recording played back
 * into the real renderer twice. The car is then pixel-identical between the
 * two strips and the only thing that differs is the camera.
 *
 * `--vary` picks which camera feature is toggled between the two strips:
 * `lag` for the rotational lag, `dutch` for the soft-kneed corner roll,
 * `collide` for keeping the lens out of the scenery.
 *
 *   node tools/camturn.mjs [--s 1985,2030] [--n 6] [--tag camturn] [--vary lag]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const [S0, S1] = flag('s', '1985,2030').split(',').map(Number);
const N = +flag('n', 6);
const tag = flag('tag', 'camturn');
const VARY = flag('vary', 'lag');
const PICK = flag('pick', 'even');
if (!['lag', 'dutch', 'collide'].includes(VARY)) { console.error('  --vary must be lag, dutch or collide'); process.exit(2); }
const NAME = {
  lag: ['lag-on', 'lag-off'],
  dutch: ['soft-dutch', 'clamped-dutch'],
  collide: ['kept-out', 'let-in'],
}[VARY];
const W = +flag('w', 1024), H = +flag('h', 576);

const outDir = path.join(ROOT, 'shots', tag);
fs.rmSync(outDir, { recursive: true, force: true });
for (const d of NAME) fs.mkdirSync(path.join(outDir, d), { recursive: true });

await run({ width: W, height: H, hash: 'manual&tier=high&seed=22&cap=60&ink=1&hud=0' }, async ({ page, errs, gl }) => {
  const info = await page.evaluate(([s0, s1, n, pick]) => {
    const g = window.__game;
    const p = g.player;
    const snap = () => ({
      pos: p.pos.toArray(), up: p.up.toArray(), forward: p.forward.toArray(), right: p.right.toArray(),
      vx: p.vx, vy: p.vy, speed: p.speed, r: p.r, roll: p.roll, pitch: p.pitch, throttle: p.throttle,
      steer: p.steer, bodyLift: p.bodyLift || 0, susp: [...p.susp], wheelSpin: [...p.wheelSpin],
      s: p.s, kmh: p.kmh,
    });

    g.setPaused(true);

    /* Which car build these frames were shot on. Two agents are editing this
       project at once and a stale bundle looks exactly like a null result. */
    g.goTo(0.05);
    g.botInput = { steer: 0, throttle: 0, brake: 0, handbrake: false };
    for (let i = 0; i < 30; i++) g.step(1 / 60);
    g.botInput = { steer: 1, throttle: 0, brake: 0, handbrake: false };
    const trace = [];
    for (let i = 0; i < 120; i++) { g.step(1 / 240); trace.push(p.steer); }
    g.botInput = null;
    const settled = trace[trace.length - 1];
    const riseMs = (trace.findIndex(v => v >= settled * 0.9) + 1) * 1000 / 240;

    g.autopilot(true, 0.85);
    g.goTo(Math.max(6, s0 - 220) / g.track.length);
    const tape = [];
    let guard = 0;
    while (p.s < s1 && guard++ < 60 * 120) { g.step(1 / 60); tape.push(snap()); }
    g.autopilot(false);

    const first = tape.findIndex(f => f.s >= s0);
    let shots = [];
    if (pick === 'dutch') {
      /* Evenly spaced stations keep landing on frames where the old clamp was
         not doing anything, which makes an honest pair look like a null
         result. Choosing by the quantity under test guarantees the strips are
         shot where they actually differ; spacing them apart keeps four shots
         from being four copies of the same instant. */
      const rank = [];
      for (let i = first; i < tape.length; i++) rank.push([i, Math.abs(-tape[i].r * 0.11 - tape[i].roll * 0.35)]);
      rank.sort((a, b) => b[1] - a[1]);
      for (const [i] of rank) {
        if (shots.length >= n) break;
        if (shots.every(j => Math.abs(j - i) > 25)) shots.push(i);
      }
      shots.sort((a, b) => a - b);
    } else {
      for (let k = 0; k < n; k++) shots.push(first + Math.round(k * (tape.length - 1 - first) / (n - 1)));
    }

    g.__tape = tape;
    g.__shots = shots;
    /* capture() pauses, renders and un-pauses; an un-paused frame between
       shots would let the real simulation run on top of the playback. */
    g.__setPaused = g.setPaused;
    g.setPaused = () => {};
    g.paused = true;
    return {
      frames: tape.length, riseMs,
      steerRate: Math.max(...tape.slice(1).map((f, i) => Math.abs(f.steer - tape[i].steer) * 60)) * 180 / Math.PI,
      shots: shots.map(i => ({ i, s: +tape[i].s.toFixed(1), kmh: Math.round(tape[i].kmh) })),
    };
  }, [S0, S1, N, PICK]);

  console.log(`  car build: steering reaches 90% of lock in ${info.riseMs.toFixed(0)} ms`
    + `  (400 ms old filter, 167 ms new)`);
  console.log(`  recorded ${info.frames} frames, shooting at s = ${info.shots.map(x => x.s).join(', ')}\n`);

  for (const on of [true, false]) {
    const dir = on ? NAME[0] : NAME[1];
    await page.evaluate(([on, vary]) => {
      const g = window.__game;
      if (vary === 'lag') g.chase.yawLagEnabled = on;
      else if (vary === 'collide') g.chase.collideEnabled = on;
      else g.chase.softDutchEnabled = on;
      g.chase.started = false;              // reseed, so neither strip inherits the other
      g.__cursor = 0;
    }, [on, VARY]);

    for (let k = 0; k < info.shots.length; k++) {
      const st = await page.evaluate(target => {
        const g = window.__game, p = g.player;
        const V = (v, a) => v.set(a[0], a[1], a[2]);
        for (let i = g.__cursor; i <= target; i++) {
          const f = g.__tape[i];
          V(p.pos, f.pos); V(p.up, f.up); V(p.forward, f.forward); V(p.right, f.right);
          p.vx = f.vx; p.vy = f.vy; p.speed = f.speed; p.r = f.r;
          p.roll = f.roll; p.pitch = f.pitch; p.throttle = f.throttle; p.steer = f.steer;
          p.bodyLift = f.bodyLift; p.s = f.s; p.kmh = f.kmh;
          for (let j = 0; j < 4; j++) { p.susp[j] = f.susp[j]; p.wheelSpin[j] = f.wheelSpin[j]; }
          p.applyTo(g.playerView);
          g.chase.update(p, 1 / 60, {});
          g.sun.position.copy(p.pos).add(new g.THREE.Vector3(-150, 125, 165));
          g.sun.target.position.copy(p.pos);
          g.sun.target.updateMatrixWorld();
        }
        g.__cursor = target + 1;
        const f = g.__tape[target];
        const c = g.camera.position;
        const tx = c.x - p.pos.x, tz = c.z - p.pos.z;
        const wrap = a => { const t = (a + Math.PI) % (Math.PI * 2); return (t < 0 ? t + Math.PI * 2 : t) - Math.PI; };
        const tr = new g.THREE.Vector3().copy(p.forward).multiplyScalar(p.vx).addScaledVector(p.right, p.vy);
        if (tr.lengthSq() < 4) tr.copy(p.forward); else tr.normalize();
        tr.lerp(p.forward, 0.22).normalize();
        const err = wrap(Math.atan2(-tx, -tz) - Math.atan2(tr.x, tr.z)) * 180 / Math.PI;
        const ndc = p.pos.clone().project(g.camera);
        const tilt = new g.THREE.Euler().setFromQuaternion(g.camera.quaternion, 'YXZ').z * 180 / Math.PI;
        return {
          s: +f.s.toFixed(1), kmh: Math.round(f.kmh), err: +err.toFixed(2),
          carX: +ndc.x.toFixed(3), occl: +g.chase.occl.toFixed(2),
          roll: +(p.roll * 180 / Math.PI).toFixed(2), tilt: +tilt.toFixed(2),
          rawDutch: +((-p.r * 0.11 - p.roll * 0.35) * 180 / Math.PI).toFixed(2),
          soft: g.chase.softDutchEnabled,
        };
      }, info.shots[k].i);

      await capture(page, path.join(outDir, dir, `${String(k).padStart(2, '0')}.png`));
      console.log(`  ${dir.padEnd(14)} ${String(k).padStart(2)}  s=${String(st.s).padStart(6)}  ${String(st.kmh).padStart(3)} km/h`
        + `  yaw error ${st.err.toFixed(2).padStart(7)}°   car at x=${st.carX.toFixed(3).padStart(6)}`
        + `  boom ${String((st.occl * 100).toFixed(0)).padStart(3)}%`
        + `  body roll ${st.roll.toFixed(1).padStart(6)}°  dutch asked ${st.rawDutch.toFixed(2).padStart(6)}°`
        + `  horizon ${st.tilt.toFixed(2).padStart(6)}°  soft=${st.soft}`);
    }
    console.log('');
  }

  await page.evaluate(() => {
    const g = window.__game;
    g.setPaused = g.__setPaused;
    g.chase.yawLagEnabled = true;
    g.chase.softDutchEnabled = true;
    g.chase.collideEnabled = true;
  });
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ tag, vary: VARY, gl, info, errors: errs }, null, 2));
  console.log(`  → shots/${tag}/{${NAME.join(',')}}`);
});

finish(process.exitCode || 0);
