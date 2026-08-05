/* Does the body actually lean, and does it sit level when it should?
 *
 * Two things a number cannot settle. Roll has a sign, and the sign has been
 * wrong here before, so the corner shot is taken from behind with the camera's
 * up axis locked to the road frame: the road reads level in the frame and any
 * tilt on the car is the car. The rest shot is the control — same car, same
 * lens, no input, nothing to lean it.
 *
 * Both are shot before and after, from the same moment of the same scripted
 * corner, by putting the old roll back for the second pass.
 *
 * Framed with a free camera set from the track frame rather than through the
 * chase camera, which is being rewritten elsewhere and is not this tool's
 * business.
 *
 *   node tools/leanshot.mjs [tag]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = (args[0] && !args[0].startsWith('--')) ? args[0] : 'lean';
const outDir = path.join(ROOT, 'shots', tag);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

/* Put the old body roll back. Roll is a display quantity — nothing in the
   simulation reads it — so recomputing it after the real suspension pass
   reproduces the old value exactly, and the two shots differ in nothing else. */
const LEGACY_ROLL = () => {
  const proto = Object.getPrototypeOf(window.__game.player);
  if (proto.__realSusp) return;
  proto.__realSusp = proto._suspension;
  proto._suspension = function (...a) {
    proto.__realSusp.apply(this, a);
    const s = Math.abs(this.slipAngle);
    const lean = Math.min(Math.max((s - 0.21) * 0.42, 0), 0.055) * -Math.sign(this.slipAngle);
    this.roll = ((this.susp[0] + this.susp[2]) - (this.susp[1] + this.susp[3])) * 0.315 + lean;
  };
};
const CURRENT_ROLL = () => {
  const proto = Object.getPrototypeOf(window.__game.player);
  if (proto.__realSusp) { proto._suspension = proto.__realSusp; delete proto.__realSusp; }
};

/* Run the scripted corner and stop `stopAt` frames in. With stopAt < 0 it runs
   the whole thing and reports which frame leaned hardest, so the second pass
   can stop exactly there. */
const CORNER = (stopAt) => {
  const g = window.__game;
  const p = g.player;
  const DEG = 180 / Math.PI;
  g.freeCam = true;
  g.botInput = null;

  /* The tightest corner on the stage is under a cliff, and a cel-shaded car
     photographed in shadow has one flat value across the whole body — the
     silhouette is there but nothing inside it reads, which is no way to judge
     a lean. Take the tightest corner the sun can actually see instead, by
     asking the stage geometry whether anything is standing between it and the
     light. */
  const t = g.track;
  const THREE = g.THREE;
  const ray = new THREE.Raycaster();
  const sun = new THREE.Vector3(-150, 125, 165).normalize();
  const from = new THREE.Vector3();
  const candidates = [];
  for (let s = 260; s < t.length - 200; s += 5) {
    candidates.push({ s, c: Math.abs(t.frameAt(s).curv) });
  }
  candidates.sort((a, b) => b.c - a.c);
  let hairS = candidates[0].s, hairC = candidates[0].c;
  for (const cand of candidates.slice(0, 60)) {
    const f = t.frameAt(cand.s);
    from.copy(f.pos).addScaledVector(f.up, 1.4);
    ray.set(from, sun);
    ray.far = 600;
    if (ray.intersectObject(g.stage, true).length === 0) {
      hairS = cand.s; hairC = cand.c;
      break;
    }
  }

  // Arrive under AI power, so the entry speed is one the stage actually gives.
  g.autopilot(true, 0.85);
  g.bot.wobble = 5;
  p.placeAt(Math.max(6, hairS - 170), 0);
  p.vx = 0; p.vy = 0; p.r = 0;
  for (let i = 0; i < 40 * 60 && p.s < hairS - 45; i++) g.step(1 / 60);
  g.autopilot(false);

  const key = t.frameAt(hairS).curv > 0 ? 'KeyD' : 'KeyA';
  const keys = g.input.down;
  g.input.steer = 0;
  const trace = [];
  const limit = stopAt < 0 ? 2.6 * 60 : stopAt;
  for (let i = 0; i <= limit; i++) {
    keys.clear();
    const time = i / 60;
    if (time > 0.30 && time < 2.30) keys.add(key);
    if (time > 0.9) keys.add('KeyW');
    g.step(1 / 60);
    trace.push({
      i, roll: p.roll, yaw: p.r,
      rollDeg: +(p.roll * DEG).toFixed(2),
      yawDeg: +(p.r * DEG).toFixed(1),
      kmh: +p.kmh.toFixed(0),
      slipDeg: +(p.slipAngle * DEG).toFixed(1),
      ayG: +((p.speed * p.r) / 9.81).toFixed(2),
    });
  }
  keys.clear();

  if (stopAt < 0) {
    /* The frame to shoot: hardest lean while the car is genuinely loaded up
       and still on the road, not the frame it clipped a berm on. */
    let best = trace[0];
    for (const r of trace) {
      if (Math.abs(r.ayG) < 0.6) continue;
      if (Math.abs(r.roll) > Math.abs(best.roll)) best = r;
    }
    return { pick: best.i, at: best, turns: key === 'KeyD' ? 'right' : 'left' };
  }

  /* Frame it. Behind and a little to the inside, low, with the camera's up
     axis taken from the road so the horizon in the shot is the road's and the
     only thing tilted is the car. */
  g.setPaused(true);
  const cam = g.camera;
  cam.up.copy(p.up);
  cam.position.copy(p.pos)
    .addScaledVector(p.forward, -6.1)
    .addScaledVector(p.right, Math.sign(p.r || 1) * 1.5)
    .addScaledVector(p.up, 1.35);
  cam.lookAt(p.pos.x, p.pos.y + 0.6, p.pos.z);
  g.sun.position.copy(p.pos).add(new g.THREE.Vector3(-150, 125, 165));
  g.sun.target.position.copy(p.pos);
  g.sun.target.updateMatrixWorld();
  return { shot: trace[trace.length - 1] };
};

/* The control: no input, nothing moving, on the flattest piece of road the
   stage has. Anything the car is doing here it is doing for no reason. */
const REST = () => {
  const g = window.__game;
  const p = g.player;
  const DEG = 180 / Math.PI;
  g.freeCam = true;
  g.botInput = { steer: 0, throttle: 0, brake: 0, handbrake: 0 };
  g.autopilot(false);

  const t = g.track;
  let flatS = 100, flatScore = 1e9;
  for (let s = 60; s < t.length - 120; s += 4) {
    const f = t.frameAt(s);
    const score = Math.abs(f.grade) * 40 + Math.abs(f.bank) * 20 + Math.abs(f.curv) * 200;
    if (score < flatScore) { flatScore = score; flatS = s; }
  }
  const f = t.frameAt(flatS);

  p.placeAt(flatS, 0);
  for (let i = 0; i < 4 * 60; i++) g.step(1 / 60);
  g.botInput = null;

  g.setPaused(true);
  const cam = g.camera;
  cam.up.copy(p.up);
  cam.position.copy(p.pos)
    .addScaledVector(p.forward, -6.1)
    .addScaledVector(p.right, 1.5)
    .addScaledVector(p.up, 1.35);
  cam.lookAt(p.pos.x, p.pos.y + 0.6, p.pos.z);
  g.sun.position.copy(p.pos).add(new g.THREE.Vector3(-150, 125, 165));
  g.sun.target.position.copy(p.pos);
  g.sun.target.updateMatrixWorld();

  return {
    s: +flatS.toFixed(0),
    gradePct: +(f.grade * 100).toFixed(2),
    bankDeg: +(f.bank * DEG).toFixed(2),
    rollDeg: +(p.roll * DEG).toFixed(3),
    pitchDeg: +(p.pitch * DEG).toFixed(3),
    kmh: +p.kmh.toFixed(2),
    susp: p.susp.map(v => +v.toFixed(4)),
  };
};

await run({ width: 1600, height: 900, hash: 'manual&seed=22&hud=0&tier=high' },
  async ({ page, errs, gl }) => {
    const report = {};

    // Which frame of the corner to shoot, decided on the current build and
    // then reused for both, so the two shots are the same instant.
    const scout = await page.evaluate(CORNER, -1);
    console.log(`\n  corner turns ${scout.turns}; hardest lean at frame ${scout.pick} ` +
      `— ${scout.at.kmh} km/h, ${scout.at.ayG} g, yaw ${scout.at.yawDeg} °/s`);

    for (const [name, patch] of [['after', CURRENT_ROLL], ['before', LEGACY_ROLL]]) {
      await page.evaluate(patch);
      const r = await page.evaluate(CORNER, scout.pick);
      const file = path.join(outDir, `corner-${name}.png`);
      await capture(page, file);
      report[`corner_${name}`] = r.shot;
      console.log(`  corner-${name}.png   roll ${r.shot.rollDeg}°  ` +
        `yaw ${r.shot.yawDeg} °/s  ${r.shot.kmh} km/h  ${r.shot.ayG} g  slip ${r.shot.slipDeg}°`);
    }

    await page.evaluate(CURRENT_ROLL);
    const rest = await page.evaluate(REST);
    await capture(page, path.join(outDir, 'rest-level.png'));
    report.rest = rest;
    console.log(`\n  rest-level.png   s=${rest.s}, grade ${rest.gradePct}%, bank ${rest.bankDeg}°`);
    console.log(`    roll ${rest.rollDeg}°   pitch ${rest.pitchDeg}°   ${rest.kmh} km/h`);

    /* Frame rate, with the whole stage on screen and the post chain running.
       A handling change should not cost anything here, and saying so is
       cheaper than being asked. */
    const perf = await page.evaluate(async () => {
      const g = window.__game;
      g.freeCam = false;
      g.setPaused(false);
      await new Promise(r => setTimeout(r, 2500));
      return { fps: +g.fps.toFixed(1), cap: g.fpsCap, ...g.info() };
    });
    console.log(`\n  steady ${perf.fps} fps (cap ${perf.cap}), ` +
      `${perf.calls} calls / ${(perf.triangles / 1000).toFixed(0)}k tris   ${gl.renderer}`);
    report.perf = { fps: perf.fps, cap: perf.cap, calls: perf.calls, triangles: perf.triangles };

    fs.writeFileSync(path.join(outDir, 'report.json'),
      JSON.stringify({ tag, gl, scout, ...report, errors: errs }, null, 2));
    console.log(`  → shots/${tag}`);
  });

finish(process.exitCode || 0);
