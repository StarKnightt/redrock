/* Does invariant 2 actually govern?
 *
 * The coverage measurement has been running every frame for some time and has
 * never once produced a multiplier below 1.0, because ordinary play paints
 * 1–5% of the frame against a 55% soft threshold. An invariant that has never
 * been observed to act is an invariant on paper, and the frame that started
 * the whole rebuild — shots/crit-motion/028.png, a white-out at a normal stop
 * entering a hairpin, 40.9 fps against 56–60 — is exactly the event it exists
 * to prevent. So this forces the condition and checks the response.
 *
 * Three parts, in increasing strength:
 *
 *   sweep   coverageBias walked across the soft-to-hard window with the
 *           emission otherwise unchanged. The multiplier must fall to zero and
 *           the spawn count must fall with it.
 *   close   a real overload: the densest pose the system has, with the camera
 *           parked a metre and a half off the rear wheel so the puffs really
 *           do fill the lens. Run twice, with the governor on and off, from
 *           the same seed.
 *   events  a landing burst under the same load, which must still happen —
 *           events are shrunk, never refused.
 *
 *   node tools/tgovern.mjs [tag]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = (args[0] && !args[0].startsWith('--')) ? args[0] : 'tgovern';
const outDir = path.join(ROOT, 'shots', tag);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await run({ width: 1600, height: 900, hash: 'manual&tier=high&seed=22&cap=60&hud=0&ink=1' },
  async ({ page, errs, gl }) => {
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
      const frame = g.track.frameAt(0);
      const surface = new THREE.Vector3();
      const centre = new THREE.Vector3();
      const sunOffset = g.sun.position.clone().sub(g.sun.target.position);

      const h = {};
      h.pose = (s, lat, slip, vx, state = {}) => {
        const p = g.player;
        const f = g.track.frameAt(s, frame);
        p.surfaceAt(s, lat, surface);
        p.pos.copy(surface).addScaledVector(f.up, CAR.rideHeight + (state.height || 0));
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
        p.roll = -slip * 0.12;
        p.pitch = 0;
        p.bodyLift = 0;
        p.susp.fill(0);
        p.suspVel.fill(0);
        const ws = state.wheelSlip || [0, 0, 0, 0];
        for (let i = 0; i < 4; i++) p.wheelSlip[i] = ws[i];
      };

      /* The camera the crit-motion frame was taken from: low, close and
         pointed into the plume rather than at the car. */
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
        centre.copy(p.pos).addScaledVector(p.forward, trail).addScaledVector(p.up, 0.45);
        cam.lookAt(centre);
        p.applyTo(g.playerView);
        g.sun.target.position.copy(p.pos);
        g.sun.position.copy(p.pos).add(sunOffset);
        g.sun.target.updateMatrixWorld();
      };

      /* Count what the pool is actually asked to make, which is the quantity
         the governor is supposed to move. Live count alone cannot show it —
         a pool at its ceiling reports the ceiling either way. */
      h.counted = (fn) => {
        const pool = g.fx.particles;
        const s0 = pool._spawn.bind(pool), s1 = pool._spawnBurst.bind(pool);
        let spawns = 0, bursts = 0;
        pool._spawn = (...a) => { spawns++; return s0(...a); };
        pool._spawnBurst = (...a) => { bursts++; return s1(...a); };
        const extra = fn();
        pool._spawn = s0;
        pool._spawnBurst = s1;
        return { spawns, bursts, ...extra };
      };

      /* A pool with the emission multipliers wound up. This is the honest
         overload: real particles at real sizes in real numbers, rather than a
         number typed into the measurement, and it is the shape of the fault
         the governor exists for — a corner where the emitters are all asking
         at once and the camera is close enough for it to matter. */
      h.flood = (dustScale, driftScale) => {
        g.fx.dispose();
        g.fx = new Effects(g.scene, g.track, { seed: 2205, dustScale, driftScale });
      };

      /* The full-blast pose tools/fx.mjs measures its frame rate on, held for
         `frames` at whatever camera distance is asked for. */
      h.blast = (frames, cam, opts = {}) => {
        const p = g.player, fx = g.fx, dt = 1 / 60;
        fx.reset();
        fx.particles.governor = opts.governor !== false;
        fx.particles.coverageBias = opts.bias || 0;
        let s = 2600;
        const slip = 0.36, vx = 50, speed = vx / Math.cos(slip);
        let peakCover = 0, peakGate = 1, minGate = 1, sumCover = 0;
        let land = null;
        const out = h.counted(() => {
          for (let i = 0; i < frames; i++) {
            const jump = opts.landAt && i >= opts.landAt && i < opts.landAt + 6;
            h.pose(s, 0.2, slip, vx, {
              throttle: 0.9, handbrake: 0.72, wheelSlip: [0.62, 0.62, 1, 1],
              airborne: jump && i < opts.landAt + 5,
              height: jump && i < opts.landAt + 5 ? 0.6 : 0,
              impact: opts.landAt && i === opts.landAt + 5 ? 1 : 0,
            });
            h.aim(cam.az, cam.el, cam.dist, cam.trail);
            fx.update(dt, p, g.camera);
            if (opts.landAt && i === opts.landAt + 5) {
              const pool = fx.particles;
              let segments = 0, height = 0;
              for (let k = 0; k < pool.max; k++) {
                if (!pool.active[k] || pool.kind[k] < 3.5) continue;
                segments++;
                height = Math.max(height, pool.scales[k * 2 + 1]);
              }
              land = { segments, height: +height.toFixed(2) };
            }
            const c = fx.particles.coverage + fx.particles.coverageBias;
            peakCover = Math.max(peakCover, c);
            sumCover += c;
            minGate = Math.min(minGate, fx.particles.gate);
            peakGate = Math.max(peakGate, fx.particles.gate);
            s += speed * dt;
          }
          return {};
        });
        fx.particles.governor = true;
        fx.particles.coverageBias = 0;
        return {
          ...out,
          frames,
          peakCover: +peakCover.toFixed(3),
          meanCover: +(sumCover / frames).toFixed(3),
          minGate: +minGate.toFixed(3),
          peakGate: +peakGate.toFixed(3),
          live: fx.particles.live,
          land,
        };
      };

      h.shoot = () => {
        g.pipeline.render();
        const info = g.info();
        return { calls: info.calls, triangles: info.triangles };
      };

      /* Share of the frame the dust is painting, straight off the canvas.
         The measured estimate is a sum of quad areas and counts overlap twice
         by design; this is the honest denominator to sanity-check it against. */
      h.pale = () => {
        const c = g.renderer.domElement;
        const off = document.createElement('canvas');
        off.width = c.width; off.height = c.height;
        const ctx = off.getContext('2d');
        ctx.drawImage(c, 0, 0);
        const d = ctx.getImageData(0, 0, off.width, off.height).data;
        let dust = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], gg = d[i + 1], b = d[i + 2];
          const v = (r + gg + b) / 3;
          const warm = r - b;
          if (v > 118 && v < 235 && warm > 8 && warm < 46 && Math.abs(r - gg) < 24) dust++;
        }
        return +(dust / (off.width * off.height) * 100).toFixed(2);
      };

      g.govHarness = h;
    });

    /* The framing shots/crit-motion/028.png was taken from: low, close behind,
       looking through the plume at the road rather than at the car. */
    const CLOSE = { az: 168, el: 5.5, dist: 7.5, trail: -3.2 };
    const FAR = { az: 152, el: 10, dist: 12.5, trail: -2.5 };
    const report = { sweep: [], close: {}, events: {} };

    console.log('\n  sweep — coverage forced, everything else unchanged');
    console.log('    bias   coverage    gate   spawns  bursts   live');
    for (const bias of [0, 0.8, 1.4, 2.0, 2.6, 3.0, 3.6]) {
      const r = await page.evaluate(([cam, b]) =>
        window.__game.govHarness.blast(90, cam, { bias: b }), [FAR, bias]);
      report.sweep.push({ bias, ...r });
      console.log(`    ${String(bias).padEnd(5)}  ${String(r.peakCover).padStart(7)}`
        + `  ${String(r.minGate).padStart(6)}  ${String(r.spawns).padStart(6)}`
        + `  ${String(r.bursts).padStart(6)}  ${String(r.live).padStart(5)}`);
    }

    const FLOOD = 20;
    console.log(`\n  flood — emission wound up ${FLOOD}x, governor off and on`);
    for (const [name, on] of [['off', false], ['on', true]]) {
      const r = await page.evaluate(([cam, governor, scale]) => {
        const h = window.__game.govHarness;
        h.flood(scale, scale);
        const out = h.blast(150, cam, { governor });
        return { ...out, ...h.shoot(), dustPct: h.pale() };
      }, [CLOSE, on, FLOOD]);
      await capture(page, path.join(outDir, `flood-governor-${name}.png`));
      report.close[name] = r;
      console.log(`    governor ${name.padEnd(3)}  peak coverage ${String(r.peakCover).padStart(6)}`
        + `  mean ${String(r.meanCover).padStart(6)}`
        + `  min gate ${String(r.minGate).padStart(5)}  spawns ${String(r.spawns).padStart(5)}`
        + `  live ${String(r.live).padStart(3)}  pale pixels ${r.dustPct}%`);
    }
    await page.evaluate(() => window.__game.govHarness.flood(1, 1));

    console.log('\n  events — a landing under the same forced load');
    for (const bias of [0, 2.2, 3.6]) {
      const r = await page.evaluate(([cam, b]) =>
        window.__game.govHarness.blast(90, cam, { bias: b, landAt: 60 }), [FAR, bias]);
      report.events[bias] = r;
      console.log(`    bias ${String(bias).padEnd(4)} gate ${String(r.minGate).padStart(5)}`
        + `   landing burst ${r.land ? r.land.segments : 0} segments`
        + `  ${r.land ? r.land.height : 0} m tall`);
    }

    /* The other half of the claim, and the one that is easy to lose: the
       governor must be all but invisible in ordinary play. A multiplier that
       acts on a tenth of the frames of a normal stage is not a safety limit,
       it is a quiet deletion of the effect it supervises — and the captures
       cannot see it, because they hold a camera that is nowhere near the car
       while the dust is being made. This drives the real game. */
    console.log('\n  stage — a real run, where the governor should barely exist');
    report.stage = {};
    for (const seed of [22, 7]) {
      const r = await page.evaluate(async (s) => {
        const g = window.__game;
        const p = g.player;
        if (g.fx !== g.effects) { g.fx.dispose(); g.fx = g.effects; }
        /* The harness above froze the world and took the camera off the car.
           A stage run needs both back: a governor judged from a camera that
           is not looking at the dust is not judged at all. */
        g.freeCam = false;
        g.setPaused(false);
        g.botInput = null;
        g.autopilot(true, 0.9);
        p.placeAt(34, 0); p.raceTime = 0; p.finished = false;
        p.vx = 0; p.vy = 0; p.r = 0;
        const cover = [], gates = [];
        for (let i = 0; i < 120 * 120 && !p.finished; i++) {
          g.step(1 / 120);
          if (i & 1) continue;
          cover.push(g.effects.particles.coverage);
          gates.push(g.effects.particles.gate);
        }
        cover.sort((a, b) => a - b);
        const q = t => +cover[Math.floor(cover.length * t)].toFixed(3);
        return {
          seed: s, frames: cover.length,
          p50: q(0.5), p99: q(0.99), max: +cover[cover.length - 1].toFixed(3),
          touched: +(gates.filter(v => v < 0.999).length / gates.length * 100).toFixed(2),
          halved: +(gates.filter(v => v < 0.5).length / gates.length * 100).toFixed(2),
          worstGate: +Math.min(...gates).toFixed(3),
        };
      }, seed);
      report.stage[seed] = r;
      console.log(`    seed ${String(seed).padEnd(3)} coverage p50 ${r.p50}  p99 ${r.p99}`
        + `  max ${r.max}   gate touched on ${r.touched}% of frames,`
        + ` halved on ${r.halved}%, worst ${r.worstGate}`);
    }

    const closed = report.sweep[report.sweep.length - 1];
    const open = report.sweep[0];
    const ok = {
      'gate closes when coverage is forced past hard': closed.minGate === 0,
      'gate is untouched at ordinary coverage': open.minGate === 1,
      'continuous emission stops with the gate': closed.spawns < open.spawns * 0.05,
      /* A feedback governor settles at its knee rather than at zero, so what
         is checked is that the equilibrium moved, not that emission stopped. */
      'a real overload is clamped': report.close.on.meanCover < report.close.off.meanCover * 0.9,
      'a real overload emits less': report.close.on.spawns < report.close.off.spawns * 0.9,
      /* dustPct is reported but not asserted on. The pale-pixel window is not
         monotone under extreme overlap — piled-up dust leaves the window at
         the bright end — so it tells you the two frames differ and not which
         way round. Coverage and the spawn count are the measures that mean
         what they say here. */
      'events survive a closed gate': (report.events[3.6].land?.segments || 0) === 12,
      'ordinary driving is barely governed':
        Object.values(report.stage).every(r => r.touched < 4),
      'ordinary driving is never halved for long':
        Object.values(report.stage).every(r => r.halved < 0.5),
      'events are made smaller by a closed gate':
        report.events[3.6].land.height < report.events[0].land.height * 0.8,
    };
    console.log('');
    let bad = 0;
    for (const [what, pass] of Object.entries(ok)) {
      if (!pass) bad++;
      console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${what}`);
    }
    if (bad) process.exitCode = 1;

    fs.writeFileSync(path.join(outDir, 'report.json'),
      JSON.stringify({ tag, gl, report, checks: ok, errors: errs }, null, 2));
    console.log(`  → shots/${tag}`);
  });

finish(process.exitCode || 0);
