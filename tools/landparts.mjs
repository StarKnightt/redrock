/* Which half of the landing burst is which.
 *
 * The curtain and the ground sheet occupy the same few metres and are close
 * in value on purpose, so a frame that reads badly does not say which of them
 * is at fault. This shoots the same moment three times — both, curtain only,
 * sheet only — by parking the other one's instances at zero scale.
 *
 *   node tools/landparts.mjs [tag] [--frames 11] [--view low]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = (args[0] && !args[0].startsWith('--')) ? args[0] : 'landparts';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const FRAMES = +flag('frames', 11);
const outDir = path.join(ROOT, 'shots', tag);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const VIEWS = {
  low: { az: 168, el: 3.2, dist: 10.0, trail: 0.6 },
  chase: { az: 178, el: 9, dist: 11.5, trail: 1.0 },
  quarter: { az: 128, el: 15, dist: 12.0, trail: -0.5 },
};
const view = VIEWS[flag('view', 'low')];

await run({ width: 1600, height: 900, hash: 'manual&tier=high&seed=22&cap=60&hud=0&ink=1' },
  async ({ page, errs }) => {
    await page.evaluate(async () => {
      const [{ Effects }, { CAR }] = await Promise.all([
        import('/src/fx/index.js'), import('/src/car/mesh.js'),
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
        p.s = s; p.lat = 0;
        p.up.copy(f.up); p.forward.copy(f.tan); p.right.copy(f.right);
        p.yaw = Math.atan2(p.forward.z, p.forward.x);
        p.vx = vx; p.vy = 0; p.r = 0;
        p.airborne = !!state.airborne;
        p.height = state.height || 0;
        p.vertVel = state.vertVel || 0;
        p.offRoad = 0;
        p.throttle = state.throttle || 0;
        p.brake = 0; p.handbrake = 0;
        p.lastImpact = state.impact || 0;
        p.roll = 0; p.pitch = 0; p.bodyLift = 0;
        p.susp.fill(0); p.suspVel.fill(0);
        p.wheelSlip.fill(0);
      };
      h.at = (impact, kmh, frames) => {
        const p = g.player, fx = g.fx, dt = 1 / 60;
        fx.reset();
        const vx = kmh / 3.6;
        let s = 3320;
        p.placeAt(s, 0);
        for (let i = 0; i < 30; i++) {
          h.pose(s, vx, { height: 1.6 * (1 - i / 30) + 0.09, airborne: true, vertVel: -5.4 });
          fx.update(dt, p, g.camera);
          s += vx * dt * 0.35;
        }
        h.pose(s, vx, { impact });
        fx.update(dt, p, g.camera);
        for (let i = 1; i < frames; i++) {
          s += vx * dt;
          h.pose(s, vx, {});
          fx.update(dt, p, g.camera);
        }
      };
      /* Park one class of instance at zero scale without touching the sim, so
         the remaining one is drawn exactly as it would have been. */
      h.isolate = which => {
        const pool = g.fx.particles;
        for (let i = 0; i < pool.max; i++) {
          if (!pool.active[i]) continue;
          const k = pool.kind[i];
          const burst = k > 2.5;
          let drop = false;
          if (which === 'wall') drop = k < 3.5;
          else if (which === 'sheet') drop = k > 3.5 || !burst;
          else if (which === 'burst') drop = !burst;
          else if (which === 'noburst') drop = burst;
          if (drop) pool.scales[i * 2] = pool.scales[i * 2 + 1] = 0;
        }
        pool.scaleAttr.needsUpdate = true;
      };
      h.shoot = v => {
        const p = g.player, cam = g.camera;
        p.applyTo(g.playerView);
        g.sun.target.position.copy(p.pos);
        g.sun.position.copy(p.pos).add(h.sunOffset);
        g.sun.target.updateMatrixWorld();
        const yaw = Math.atan2(p.forward.z, p.forward.x) + v.az * Math.PI / 180;
        const el = v.el * Math.PI / 180;
        cam.position.set(
          p.pos.x + Math.cos(yaw) * Math.cos(el) * v.dist,
          p.pos.y + Math.sin(el) * v.dist + 0.45,
          p.pos.z + Math.sin(yaw) * Math.cos(el) * v.dist,
        );
        cam.up.set(0, 1, 0);
        cam.fov = 42; cam.near = 0.1; cam.far = 4000;
        cam.updateProjectionMatrix();
        h.centre.copy(p.pos).addScaledVector(p.forward, v.trail).addScaledVector(p.up, 0.45);
        cam.lookAt(h.centre);
        g.pipeline.render();
      };
      g.partsHarness = h;
    });

    const IMPACT = +flag('impact', 0.66);
    const KMH = +flag('kmh', 95);
    for (const which of ['both', 'burst', 'noburst', 'wall', 'sheet']) {
      await page.evaluate(([w, f, v, impact, kmh]) => {
        const h = window.__game.partsHarness;
        h.at(impact, kmh, f);
        if (w !== 'both') h.isolate(w);
        h.shoot(v);
      }, [which, FRAMES, view, IMPACT, KMH]);
      const file = path.join(outDir, `${which}.png`);
      await capture(page, file);
      console.log(`  ${which} → ${path.relative(ROOT, file)}`);
    }
    if (errs.length) console.log(errs.slice(0, 5).join('\n'));
  });

finish(process.exitCode || 0);
