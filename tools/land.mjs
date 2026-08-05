/* The landing burst, photographed properly.
 *
 * tools/fx.mjs takes one frame of a landing, five frames after contact, from
 * one angle. That is not enough to judge an effect whose whole argument is
 * that it expands: a single early frame of anything looks like a shape sitting
 * on the road. This drives the same event at three impact strengths and
 * photographs it at five points across its life, from the chase angle a player
 * actually gets and from a low one, and reports how much of the frame the
 * burst covers at each step so the expansion can be checked as a number rather
 * than by eye.
 *
 *   node tools/land.mjs [tag] [--w 1600] [--h 900]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = (args[0] && !args[0].startsWith('--')) ? args[0] : 'land';
const flag = (key, fallback) => {
  const i = args.indexOf('--' + key);
  return i < 0 ? fallback : args[i + 1];
};
const W = +flag('w', 1600);
const H = +flag('h', 900);
const outDir = path.join(ROOT, 'shots', tag);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const hash = `manual&tier=${flag('tier', 'high')}&seed=${flag('seed', 22)}&cap=60&hud=0&ink=1`;

/* Frames after contact. The burst lives between 25 and 35 frames depending on
   strength, so this walks it from the punch to the last of it. */
const STEPS = [1, 3, 6, 11, 18, 26];
const IMPACTS = [
  { name: 'soft', impact: 0.32, kmh: 45 },
  { name: 'mid', impact: 0.66, kmh: 95 },
  { name: 'hard', impact: 1.0, kmh: 150 },
];
const VIEWS = [
  { name: 'chase', az: 178, el: 9, dist: 11.5, trail: 1.0 },
  { name: 'low', az: 168, el: 3.2, dist: 10.0, trail: 0.6 },
  { name: 'quarter', az: 128, el: 15, dist: 12.0, trail: -0.5 },
];

await run({ width: W, height: H, hash }, async ({ page, errs, gl }) => {
  await page.evaluate(async () => {
    const [{ Effects }, { CAR }] = await Promise.all([
      import('/src/fx/index.js'),
      import('/src/car/mesh.js'),
    ]);
    const g = window.__game;
    cancelAnimationFrame(g._raf);
    g.running = false;
    g.setPaused(true);
    g.freeCam = true;
    if (g.fx) g.fx.dispose();
    g.fx = new Effects(g.scene, g.track, { seed: 2205 });

    const THREE = g.THREE;
    const h = {
      frame: g.track.frameAt(0),
      surface: new THREE.Vector3(),
      centre: new THREE.Vector3(),
      sunOffset: g.sun.position.clone().sub(g.sun.target.position),
    };

    h.pose = (s, vx, state = {}) => {
      const p = g.player;
      const f = g.track.frameAt(s, h.frame);
      p.surfaceAt(s, 0, h.surface);
      p.pos.copy(h.surface).addScaledVector(f.up, CAR.rideHeight + (state.height || 0));
      p.s = s;
      p.lat = 0;
      p.up.copy(f.up);
      p.forward.copy(f.tan);
      p.right.copy(f.right);
      p.yaw = Math.atan2(p.forward.z, p.forward.x);
      p.vx = vx;
      p.vy = 0;
      p.r = 0;
      p.airborne = !!state.airborne;
      p.height = state.height || 0;
      p.vertVel = state.vertVel || 0;
      p.offRoad = 0;
      p.throttle = state.throttle || 0;
      p.brake = 0;
      p.handbrake = 0;
      p.lastImpact = state.impact || 0;
      p.roll = 0;
      p.pitch = state.pitch || 0;
      p.bodyLift = 0;
      p.susp.fill(0);
      p.suspVel.fill(0);
      for (let i = 0; i < 4; i++) p.wheelSlip[i] = state.slip || 0;
    };

    h.aim = (az, el, dist, trail) => {
      const p = g.player, cam = g.camera;
      const yaw = Math.atan2(p.forward.z, p.forward.x) + az * Math.PI / 180;
      const elevation = el * Math.PI / 180;
      cam.position.set(
        p.pos.x + Math.cos(yaw) * Math.cos(elevation) * dist,
        p.pos.y + Math.sin(elevation) * dist + 0.45,
        p.pos.z + Math.sin(yaw) * Math.cos(elevation) * dist,
      );
      cam.up.set(0, 1, 0);
      cam.fov = 42;
      cam.near = 0.1;
      cam.far = 4000;
      cam.updateProjectionMatrix();
      h.centre.copy(p.pos).addScaledVector(p.forward, trail).addScaledVector(p.up, 0.45);
      cam.lookAt(h.centre);
    };

    /* Drive the event, then hold it at a chosen number of frames after
       contact. Re-run from scratch each time so every capture of one impact
       strength shows the same burst at a different moment. */
    h.at = (impact, kmh, frames) => {
      const g2 = window.__game;
      const p = g2.player, fx = g2.fx, dt = 1 / 60;
      fx.reset();
      const vx = kmh / 3.6;
      let s = 3320;
      p.placeAt(s, 0);
      for (let i = 0; i < 30; i++) {
        h.pose(s, vx, { height: 1.6 * (1 - i / 30) + 0.09, airborne: true, vertVel: -5.4 });
        fx.update(dt, p, g2.camera);
        s += vx * dt * 0.35;
      }
      h.pose(s, vx, { impact, pitch: -0.05 });
      fx.update(dt, p, g2.camera);
      for (let i = 1; i < frames; i++) {
        s += vx * dt;
        h.pose(s, vx, { throttle: 0.4 });
        fx.update(dt, p, g2.camera);
      }
      return s;
    };

    h.shoot = (view) => {
      const p = g.player;
      p.applyTo(g.playerView);
      g.sun.target.position.copy(p.pos);
      g.sun.position.copy(p.pos).add(h.sunOffset);
      g.sun.target.updateMatrixWorld();
      h.aim(view.az, view.el, view.dist, view.trail);
      g.pipeline.render();
      const info = g.info();
      const fx = g.fx.stats;
      return {
        burstPieces: fx.liveGroundSlaps,
        liveParticles: fx.liveParticles,
        fxDrawCalls: fx.drawCalls,
        fxTriangles: fx.triangles,
        calls: info.calls,
        triangles: info.triangles,
      };
    };

    /* How much of the frame the burst is painting, and how bright it is
       against the road it is painted on. The burst is the only thing in the
       scene whose colour is BURST_WALL or BURST_SHEET, so a value-and-hue
       window picks it out of a static frame well enough to trend. */
    h.coverage = () => {
      const c = g.renderer.domElement;
      const off = document.createElement('canvas');
      off.width = c.width; off.height = c.height;
      const ctx = off.getContext('2d');
      ctx.drawImage(c, 0, 0);
      const d = ctx.getImageData(0, 0, off.width, off.height).data;
      let dust = 0, road = 0, dustSum = 0, roadSum = 0;
      const y0 = Math.floor(off.height * 0.35);
      for (let y = y0; y < off.height; y++) {
        for (let x = 0; x < off.width; x++) {
          const i = (y * off.width + x) * 4;
          const r = d[i], gg = d[i + 1], b = d[i + 2];
          const v = (r + gg + b) / 3;
          const warm = r - b;
          if (v > 118 && v < 215 && warm > 8 && warm < 42 && Math.abs(r - gg) < 22) {
            dust++; dustSum += v;
          } else if (v > 55 && v < 130 && Math.abs(warm) <= 8) {
            road++; roadSum += v;
          }
        }
      }
      const total = (off.height - y0) * off.width;
      return {
        dustPct: +(dust / total * 100).toFixed(2),
        dustValue: dust ? +(dustSum / dust).toFixed(1) : 0,
        roadValue: road ? +(roadSum / road).toFixed(1) : 0,
      };
    };

    g.landHarness = h;
  });

  const results = {};
  for (const shot of IMPACTS) {
    for (const view of VIEWS) {
      /* Only the quarter view walks the whole life; the other two answer the
         "would a player mistake this for an object" question, which is asked
         while the burst is at its largest. */
      const steps = view.name === 'quarter' ? STEPS : [3, 11];
      for (const frames of steps) {
        const state = await page.evaluate(([impact, kmh, f, v]) => {
          const h = window.__game.landHarness;
          h.at(impact, kmh, f);
          const s = h.shoot(v);
          return { ...s, ...h.coverage() };
        }, [shot.impact, shot.kmh, frames, view]);
        const key = `${shot.name}-${view.name}-f${String(frames).padStart(2, '0')}`;
        const file = path.join(outDir, `${key}.png`);
        await capture(page, file);
        state.file = path.relative(ROOT, file).replaceAll('\\', '/');
        results[key] = state;
        console.log(
          `  ${key.padEnd(22)} pieces=${String(state.burstPieces).padStart(2)}`
          + `  cover=${String(state.dustPct).padStart(5)}%`
          + `  dust=${String(state.dustValue).padStart(5)}  road=${String(state.roadValue).padStart(5)}`
          + `  fxCalls=${state.fxDrawCalls} fxTris=${state.fxTriangles}`
          + `  scene=${state.calls}/${(state.triangles / 1000).toFixed(0)}k`,
        );
      }
    }
  }

  const perf = await page.evaluate(async () => {
    const g = window.__game, h = g.landHarness, p = g.player;
    const fx = g.fx, dt = 1 / 60;
    const samples = [];
    /* Land once every twelve frames for three seconds: far more landings than
       a jump course can ever produce, so the burst is always on screen. */
    fx.reset();
    let s = 3200;
    const vx = 40;
    const start = performance.now();
    let frames = 0;
    for (let cycle = 0; cycle < 15; cycle++) {
      for (let i = 0; i < 12; i++) {
        const airborne = i < 3;
        h.pose(s, vx, {
          height: airborne ? 0.5 : 0,
          airborne,
          impact: i === 3 ? 1 : 0,
          throttle: 1,
        });
        const u0 = performance.now();
        fx.update(dt, p, g.camera);
        samples.push(performance.now() - u0);
        p.applyTo(g.playerView);
        h.aim(178, 9, 11.5, 1.0);
        g.pipeline.render();
        s += vx * dt;
        frames++;
        await new Promise(requestAnimationFrame);
      }
    }
    const elapsed = performance.now() - start;
    samples.sort((a, b) => a - b);
    const info = g.info();
    let skips = 0;
    g.fx.root.traverse(o => { skips += o.userData.fxOverrideSkips || 0; });
    return {
      fps: +(frames * 1000 / elapsed).toFixed(1),
      frameMs: +(elapsed / frames).toFixed(2),
      updateAvgMs: +(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(3),
      updateP95Ms: +samples[Math.floor(samples.length * 0.95)].toFixed(3),
      calls: info.calls,
      triangles: info.triangles,
      fx: { ...fx.stats },
      overridePassSkips: skips,
    };
  });

  console.log(
    `\n  repeat landings  ${perf.fps} fps  ${perf.frameMs} ms/frame`
    + `  fx.update ${perf.updateAvgMs} ms avg / ${perf.updateP95Ms} ms p95`,
  );
  console.log(
    `  fx               ${perf.fx.drawCalls} draw calls  ${perf.fx.triangles} triangles`
    + `   scene ${perf.calls} calls / ${(perf.triangles / 1000).toFixed(1)}k triangles`,
  );

  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
    tag, viewport: [W, H], gl, results, perf, errors: errs,
  }, null, 2));
  console.log(`  → shots/${tag}`);
});

finish(process.exitCode || 0);
