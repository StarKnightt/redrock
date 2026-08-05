/* Exercise and photograph the effects system without wiring it into main.js.
 *
 * Each state is deterministic and deliberately holds the relevant telemetry
 * at its limit, so a weak effect cannot hide behind a run where the physics
 * happened not to produce enough slip or impact energy.
 *
 *   node tools/fx.mjs [tag] [--w 1600] [--h 900] [--cpu]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = (args[0] && !args[0].startsWith('--')) ? args[0] : 'fx';
const flag = (key, fallback) => {
  const i = args.indexOf('--' + key);
  return i < 0 ? fallback : args[i + 1];
};
const W = +flag('w', 1600);
const H = +flag('h', 900);
const diagnose = args.includes('--diagnose');
const ink = args.includes('--no-ink') ? 0 : 1;
const direct = args.includes('--direct');
const outDir = path.join(ROOT, 'shots', tag);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const hash = `manual&tier=${flag('tier', 'high')}&seed=${flag('seed', 22)}&cap=60&hud=0&ink=${ink}`;

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
      CAR,
      frame: g.track.frameAt(0),
      frame2: g.track.frameAt(0),
      metricFrame: g.track.frameAt(0),
      surface: new THREE.Vector3(),
      delta: new THREE.Vector3(),
      centre: new THREE.Vector3(),
      sunOffset: g.sun.position.clone().sub(g.sun.target.position),
    };

    h.pose = (s, lat, slip, vx, state = {}) => {
      const p = g.player;
      const f = g.track.frameAt(s, h.frame);
      p.surfaceAt(s, lat, h.surface);
      p.pos.copy(h.surface).addScaledVector(f.up, CAR.rideHeight + (state.height || 0));
      p.s = s;
      p.lat = lat;
      p.up.copy(f.up);

      const c = Math.cos(slip), sn = Math.sin(slip);
      p.forward.copy(f.tan).multiplyScalar(c).addScaledVector(f.right, -sn).normalize();
      p.right.copy(f.tan).multiplyScalar(sn).addScaledVector(f.right, c).normalize();
      p.yaw = Math.atan2(p.forward.z, p.forward.x);
      p.vx = vx;
      p.vy = Math.tan(slip) * Math.abs(vx);
      p.r = 0;
      p.airborne = !!state.airborne;
      p.height = state.height || 0;
      p.vertVel = state.vertVel || 0;
      p.offRoad = state.offRoad || 0;
      p.throttle = state.throttle || 0;
      p.brake = state.brake || 0;
      p.handbrake = state.handbrake || 0;
      p.lastImpact = state.impact || 0;
      p.roll = state.roll ?? (-slip * 0.12);
      p.pitch = state.pitch || 0;
      p.bodyLift = 0;
      p.susp.fill(0);
      p.suspVel.fill(0);
      const ws = state.wheelSlip || [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) p.wheelSlip[i] = ws[i];
      return f;
    };

    h.apply = () => {
      const p = g.player;
      p.applyTo(g.playerView);
      g.sun.target.position.copy(p.pos);
      g.sun.position.copy(p.pos).add(h.sunOffset);
      g.sun.target.updateMatrixWorld();
    };

    h.aim = (az = 145, el = 11, dist = 12, trail = 0) => {
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

    h.surfaceError = () => {
      const skids = g.fx.skids;
      const positions = skids.positions;
      let max = 0, sum = 0, count = 0;
      let hint = Math.max(0, g.player.s - 80);
      for (let i = 0; i < skids.max; i++) {
        if (g.fx.time - skids.births[i * 4] >= skids.lifetime) continue;
        const p = i * 12;
        h.centre.set(
          (positions[p] + positions[p + 3] + positions[p + 6] + positions[p + 9]) * 0.25,
          (positions[p + 1] + positions[p + 4] + positions[p + 7] + positions[p + 10]) * 0.25,
          (positions[p + 2] + positions[p + 5] + positions[p + 8] + positions[p + 11]) * 0.25,
        );
        const proj = g.track.project(h.centre, hint);
        hint = proj.s;
        const f = g.track.frameAt(proj.s, h.metricFrame);
        h.delta.subVectors(h.centre, f.pos);
        const lat = h.delta.dot(f.right);
        const height = h.delta.dot(f.up);
        const u = Math.min(1, Math.abs(lat) / (f.width * 0.5));
        const expected = -0.5 * u * u * u + 0.065;
        const error = Math.abs(height - expected);
        max = Math.max(max, error);
        sum += error;
        count++;
      }
      return { maxCm: +(max * 100).toFixed(2), meanCm: +((sum / Math.max(1, count)) * 100).toFixed(2) };
    };

    h.finishState = (camera, surfaceCheck = false) => {
      h.apply();
      h.aim(camera.az, camera.el, camera.dist, camera.trail || 0);
      g.pipeline.render();
      const info = g.info();
      const fx = g.fx.stats;
      return {
        kmh: +g.player.kmh.toFixed(0),
        slipDeg: +(g.player.slipAngle * 180 / Math.PI).toFixed(1),
        liveParticles: fx.liveParticles,
        liveClouds: fx.liveClouds,
        liveBursts: fx.liveBursts,
        liveGroundSlaps: fx.liveGroundSlaps,
        skidSegments: fx.skidSegments,
        speedLines: fx.speedLines,
        fxDrawCalls: fx.drawCalls,
        fxTriangles: fx.triangles,
        driftStrength: +fx.driftStrength.toFixed(3),
        brakeStrength: +fx.brakeStrength.toFixed(3),
        dustRate: +fx.dustRate.toFixed(1),
        calls: info.calls,
        triangles: info.triangles,
        surface: surfaceCheck ? h.surfaceError() : null,
      };
    };

    h.run = name => {
      const p = g.player;
      const fx = g.fx;
      const dt = 1 / 60;
      fx.reset();
      p.placeAt(3360, 0);

      if (name === 'burnout') {
        for (let i = 0; i < 132; i++) {
          h.pose(3360, 0, 0, 0.6, {
            throttle: 1, handbrake: 1, wheelSlip: [0.12, 0.12, 1, 1],
          });
          fx.update(dt, p, g.camera);
        }
        return h.finishState({ az: 142, el: 9, dist: 11, trail: -1.1 });
      }

      if (name === 'drift') {
        let s = 3280;
        /* Match the reported failure: a large body slip with deceptively low
           rear-wheel telemetry must still emit from both contact patches. */
        const slip = -0.735;
        const vx = 21.4;
        const speed = vx / Math.cos(slip);
        for (let i = 0; i < 110; i++) {
          h.pose(s, 0.25, slip, vx, {
            throttle: 0.5, handbrake: 1,
            wheelSlip: [0.12, 0.12, 0.16, 0.18],
          });
          fx.update(dt, p, g.camera);
          s += speed * dt;
        }
        return h.finishState({ az: 137, el: 11, dist: 13.5, trail: -3.2 }, true);
      }

      if (name === 'braking') {
        let s = 3360;
        for (let i = 0; i < 48; i++) {
          const vx = 40 - i / 47 * 7;
          h.pose(s, 0, 0, vx, {
            brake: 1, wheelSlip: [0.10, 0.10, 0.08, 0.08],
            pitch: -0.07,
          });
          fx.update(dt, p, g.camera);
          s += vx * dt;
        }
        return h.finishState({ az: 150, el: 9, dist: 11.5, trail: -1.2 }, true);
      }

      if (name === 'speed') {
        let s = 3280;
        for (let i = 0; i < 90; i++) {
          h.pose(s, 0, 0, 52, {
            throttle: 1, wheelSlip: [0.04, 0.04, 0.05, 0.05],
          });
          fx.update(dt, p, g.camera);
          s += 52 * dt;
        }
        return h.finishState({ az: 177, el: 8, dist: 10.5, trail: 4.5 });
      }

      if (name === 'offroad') {
        let s = 3300;
        for (let i = 0; i < 108; i++) {
          const f = g.track.frameAt(s, h.frame2);
          const lat = f.width * 0.5 + 3.0;
          h.pose(s, lat, 0.08, 24, {
            offRoad: 1, throttle: 0.72,
            wheelSlip: [0.38, 0.38, 0.55, 0.55],
          });
          fx.update(dt, p, g.camera);
          s += (24 / Math.cos(0.08)) * dt;
        }
        return h.finishState({ az: 147, el: 10, dist: 12.5, trail: -2.2 });
      }

      if (name === 'landing') {
        const s0 = 3330;
        for (let i = 0; i < 36; i++) {
          const height = 1.55 * (1 - i / 36) + 0.08;
          h.pose(s0 + i * 0.22, 0, 0, 16, {
            height, airborne: true, vertVel: -4.8,
          });
          fx.update(dt, p, g.camera);
        }
        let s = s0 + 36 * 0.22;
        h.pose(s, 0, 0, 16, { impact: 0.82 });
        fx.update(dt, p, g.camera);
        for (let i = 0; i < 4; i++) {
          s += 16 * dt;
          h.pose(s, 0, 0, 16, {});
          fx.update(dt, p, g.camera);
        }
        return h.finishState({ az: 120, el: 18, dist: 12, trail: -0.5 });
      }

      if (name === 'collision') {
        let s = 3360;
        let f = g.track.frameAt(s, h.frame2);
        let lat = f.width * 0.5 - 0.42;
        h.pose(s, lat, 0.04, 20, {
          throttle: 0.4, impact: 0.96, wheelSlip: [0.25, 0.25, 0.42, 0.42],
        });
        fx.update(dt, p, g.camera);
        for (let i = 0; i < 6; i++) {
          s += 12 * dt;
          f = g.track.frameAt(s, h.frame2);
          lat = f.width * 0.5 - 0.42;
          h.pose(s, lat, 0.04, 12, {
            throttle: 0.2, wheelSlip: [0.18, 0.18, 0.3, 0.3],
          });
          fx.update(dt, p, g.camera);
        }
        return h.finishState({ az: 35, el: 14, dist: 9.5, trail: 0.5 });
      }

      throw new Error('unknown fx state: ' + name);
    };

    g.fxHarness = h;
  });

  const idle = await page.evaluate(() => {
    const g = window.__game, h = g.fxHarness, p = g.player;
    g.fx.reset();
    p.placeAt(300, 0);
    for (let i = 0; i < 240; i++) {
      h.pose(300, 0, 0, 0, {});
      g.fx.update(1 / 60, p, g.camera);
    }
    return { ...g.fx.stats };
  });
  const idleClean = idle.liveParticles === 0 && idle.skidSegments === 0 && idle.speedLines === 0;
  console.log(`  idle       ${idleClean ? 'clean' : 'FAILED'}  particles=${idle.liveParticles} skids=${idle.skidSegments}`);
  if (!idleClean) process.exitCode = 1;

  const scenarios = ['burnout', 'drift', 'braking', 'speed', 'offroad', 'landing', 'collision'];
  const results = {};
  for (const name of scenarios) {
    const state = await page.evaluate(key => window.__game.fxHarness.run(key), name);
    if (direct) {
      await page.evaluate(() => {
        const g = window.__game;
        g.renderer.setRenderTarget(null);
        g.renderer.render(g.scene, g.camera);
      });
    }
    const file = path.join(outDir, `${name}.png`);
    await capture(page, file);
    state.file = path.relative(ROOT, file).replaceAll('\\', '/');
    results[name] = state;
    console.log(
      `  ${name.padEnd(9)} particles=${String(state.liveParticles).padStart(3)}`
      + `  skids=${String(state.skidSegments).padStart(3)}`
      + `  lines=${String(state.speedLines).padStart(2)}`
      + `  calls=${state.calls}  tris=${(state.triangles / 1000).toFixed(0)}k`,
    );

    if (name === 'drift') {
      if (diagnose) {
        await page.evaluate(() => {
          const g = window.__game;
          g.fx.skids.mesh.visible = false;
          g.pipeline.render();
        });
        await capture(page, path.join(outDir, 'drift-no-skids.png'));
        await page.evaluate(() => {
          const g = window.__game;
          g.fx.skids.mesh.visible = true;
          g.fx.particles.mesh.visible = false;
          g.pipeline.render();
        });
        await capture(page, path.join(outDir, 'drift-skids-only.png'));
        await page.evaluate(() => {
          const g = window.__game;
          g.fx.particles.mesh.visible = true;
          g.pipeline.render();
        });
      }
      await page.evaluate(() => window.__game.fxHarness.aim(150, 38, 22, -4));
      if (direct) {
        await page.evaluate(() => {
          const g = window.__game;
          g.renderer.setRenderTarget(null);
          g.renderer.render(g.scene, g.camera);
        });
      }
      const highFile = path.join(outDir, 'drift-high.png');
      await capture(page, highFile);
      results['drift-high'] = {
        ...state,
        file: path.relative(ROOT, highFile).replaceAll('\\', '/'),
      };
    }
  }

  const perf = await page.evaluate(async () => {
    const g = window.__game, h = g.fxHarness, p = g.player;
    const fx = g.fx, dt = 1 / 60, frames = 180;
    const samples = [];
    fx.reset();
    let s = 2600;
    const slip = 0.36, vx = 50, speed = vx / Math.cos(slip);
    const start = performance.now();
    for (let i = 0; i < frames; i++) {
      h.pose(s, 0.2, slip, vx, {
        throttle: 0.9, handbrake: 0.72,
        wheelSlip: [0.62, 0.62, 1, 1],
      });
      const u0 = performance.now();
      fx.update(dt, p, g.camera);
      samples.push(performance.now() - u0);
      h.apply();
      h.aim(152, 10, 12.5, -2.5);
      g.pipeline.render();
      s += speed * dt;
      await new Promise(requestAnimationFrame);
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
      updateMaxMs: +samples[samples.length - 1].toFixed(3),
      calls: info.calls,
      triangles: info.triangles,
      geometries: info.geometries,
      textures: info.textures,
      programs: info.programs,
      fx: { ...fx.stats },
      overridePassSkips: skips,
    };
  });

  console.log(
    `\n  full blast  ${perf.fps} fps  ${perf.frameMs} ms/frame`
    + `  fx.update ${perf.updateAvgMs} ms avg / ${perf.updateP95Ms} ms p95`,
  );
  console.log(
    `  renderer    ${perf.calls} calls  ${(perf.triangles / 1000).toFixed(0)}k triangles`
    + `  ${perf.geometries} geometries  ${perf.textures} textures`,
  );
  console.log(
    `  fx live     ${perf.fx.liveParticles} particles  ${perf.fx.skidSegments} skids`
    + `  ${perf.fx.speedLines} lines  override skips=${perf.overridePassSkips}`,
  );

  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
    tag,
    viewport: [W, H],
    gl,
    idle,
    results,
    perf,
    errors: errs,
  }, null, 2));
  console.log(`  → shots/${tag}`);
});

finish(process.exitCode || 0);
