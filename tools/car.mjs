/* Photograph the car.
 *
 * The stage shots are framed to judge the road; at chase distance the car is
 * two hundred pixels tall and nothing about its shape, its stance or the way
 * it moves can be read from them. This orbits the mesh at close range and then
 * catches it in the four states that actually reveal the physics: turned in,
 * braking hard, mid-drift, and landing.
 *
 *   node tools/car.mjs [tag] [--w 1400] [--h 900]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = (args[0] && !args[0].startsWith('--')) ? args[0] : 'car';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const W = +flag('w', 1400), H = +flag('h', 900);

const outDir = path.join(ROOT, 'shots', tag);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const HASH = `manual&tier=${flag('tier', 'high')}&seed=${flag('seed', 22)}&cap=${flag('cap', 60)}`;

/* Azimuth is measured from straight ahead of the car, elevation above the
   ground plane, distance in metres. Three-quarter front is the angle a car is
   almost always drawn from, so it leads. */
const ORBITS = [
  ['three-quarter-front', 38, 11, 9.5],
  ['front', 4, 8, 9.0],
  ['side', 90, 7, 10.0],
  ['three-quarter-rear', 143, 12, 9.5],
  ['rear', 178, 9, 9.0],
  ['low-front', 30, 2.5, 7.5],
  ['top-down', 45, 62, 13.0],
];

await run({ width: W, height: H, hash: HASH }, async ({ page, errs, gl }) => {
  await page.evaluate(() => {
    const g = window.__game;
    g.freeCam = true;
    g.setPaused(true);
    /* A sunlit, sea-facing stretch. s=300 was open desert before the coast
       landed and is now a shaded cutting, which put every orbit in silhouette
       and made the car impossible to judge. */
    g.player.placeAt(3360, 0);
    /* Step on the brakes rather than just placing the car. The sun's shadow
       frustum is re-centred on the player inside step(), so a car that is only
       placed sits outside it and casts no shadow at all — which is exactly
       what made it look pasted on top of the road. */
    g.botInput = { steer: 0, throttle: 0, brake: 1, handbrake: 1 };
    for (let i = 0; i < 60; i++) g.step(1 / 120);
    g.player.applyTo(g.playerView);
  });

  const shot = async (name, js, arg) => {
    await page.evaluate(([src, a]) => new Function('g', 'a', src)(window.__game, a), [js, arg]);
    await page.waitForTimeout(120);
    await capture(page, path.join(outDir, `${name}.png`));
    console.log(`  ${name}`);
  };

  const AIM = `
    const p = g.player, cam = g.camera;
    const yaw = p.yaw + a.az * Math.PI / 180;
    const el = a.el * Math.PI / 180;
    const d = a.dist;
    cam.position.set(
      p.pos.x + Math.cos(yaw) * Math.cos(el) * d,
      p.pos.y + Math.sin(el) * d + 0.4,
      p.pos.z + Math.sin(yaw) * Math.cos(el) * d);
    cam.up.set(0, 1, 0);
    cam.fov = 34; cam.near = 0.1; cam.far = 4000;
    cam.updateProjectionMatrix();
    cam.lookAt(p.pos.x, p.pos.y + 0.35, p.pos.z);
    /* Through the pipeline, not the raw renderer. The ink and the grade both
       live in the composite pass, so a direct renderer.render() produces a car
       with no outline and no grade — which a reviewer reasonably reads as the
       cel shading being broken rather than the capture bypassing it. */
    g.pipeline.render();
  `;

  for (const [name, az, el, dist] of ORBITS) {
    await shot(`orbit-${name}`, AIM, { az, el, dist });
  }

  /* Action. Each state is reached by driving the car into it rather than by
     setting the pose directly, so what the camera sees is what the physics
     actually produces. */
  const DRIVE = `
    const p = g.player, H = 1 / 120;
    p.placeAt(a.s, 0); p.vx = a.v;
    g.botInput = a.input;
    for (let i = 0; i < a.secs * 120; i++) g.step(H);
    p.applyTo(g.playerView);
    g.freeCam = true;
    const cam = g.camera;
    const yaw = p.yaw + a.az * Math.PI / 180;
    cam.position.set(
      p.pos.x + Math.cos(yaw) * 8.5, p.pos.y + 3.0, p.pos.z + Math.sin(yaw) * 8.5);
    cam.up.set(0, 1, 0); cam.fov = 40; cam.updateProjectionMatrix();
    cam.lookAt(p.pos.x, p.pos.y + 0.3, p.pos.z);
    g.pipeline.render();
    return { kmh: +p.kmh.toFixed(0), slip: +(p.slipAngle * 57.3).toFixed(1),
             roll: +(p.roll * 57.3).toFixed(1), pitch: +(p.pitch * 57.3).toFixed(1) };
  `;
  const states = [
    ['action-turn-in', { s: 1580, v: 24, secs: 1.6, az: 135,
      input: { steer: 0.8, throttle: 0.5, brake: 0, handbrake: 0 } }],
    ['action-braking', { s: 300, v: 40, secs: 0.7, az: 150,
      input: { steer: 0, throttle: 0, brake: 1, handbrake: 0 } }],
    ['action-drift', { s: 1580, v: 24, secs: 1.1, az: 120,
      input: { steer: 0.75, throttle: 0.5, brake: 0, handbrake: 1 } }],
    ['action-launch', { s: 300, v: 0, secs: 1.2, az: 160,
      input: { steer: 0, throttle: 1, brake: 0, handbrake: 0 } }],
  ];
  const telem = {};
  for (const [name, arg] of states) {
    const t = await page.evaluate(([src, a]) => new Function('g', 'a', src)(window.__game, a),
      [DRIVE, arg]);
    await page.waitForTimeout(100);
    await capture(page, path.join(outDir, `${name}.png`));
    telem[name] = t;
    console.log(`  ${name}  ${t.kmh} km/h  slip ${t.slip}°  roll ${t.roll}°  pitch ${t.pitch}°`);
  }

  fs.writeFileSync(path.join(outDir, 'report.json'),
    JSON.stringify({ tag, gl, telem, errors: errs }, null, 2));
  console.log(`  → shots/${tag}`);
});

finish(process.exitCode || 0);
