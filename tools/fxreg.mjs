/* Does the effects system still emit exactly what it emitted before?
 *
 * The FX captures cannot answer that. Two runs of tools/fx.mjs never agree to
 * the byte — the stage's foliage and water animate off the wall clock, so the
 * pixels move under a frame that is otherwise frozen — and an eyeball
 * comparison of dust cannot see a one-particle difference at all.
 *
 * So this photographs the state instead of the frame. Each scenario is the
 * same deterministic pose loop tools/fx.mjs drives, and what comes out is a
 * hash of every buffer the pool and the skid ring hand to the GPU: positions,
 * scales, colours, kinds, ages, plus the live counts. A single changed random
 * draw anywhere upstream moves the digest. Nothing here renders, so the digest
 * is a pure function of the emission code and the seed.
 *
 * It is a comparison against a recorded baseline, not a fixed expectation:
 *
 *   node tools/fxreg.mjs --save      write shots/fxreg/baseline.json
 *   node tools/fxreg.mjs             compare against it, non-zero on drift
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const save = args.includes('--save');
const outDir = path.join(ROOT, 'shots', 'fxreg');
const baselineFile = path.join(outDir, 'baseline.json');

await run({ width: 1600, height: 900, hash: 'manual&tier=high&seed=22&cap=60&hud=0&ink=1' },
  async ({ page, errs }) => {
    const digests = await page.evaluate(async () => {
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
      const frame2 = g.track.frameAt(0);
      const surface = new THREE.Vector3();

      /* Byte-for-byte identical to the pose helper in tools/fx.mjs. The two
         have to stay in step: a digest taken from a different pose is a
         different scenario, and would report drift that is not there. */
      const pose = (s, lat, slip, vx, state = {}) => {
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
        p.roll = state.roll ?? (-slip * 0.12);
        p.pitch = state.pitch || 0;
        p.bodyLift = 0;
        p.susp.fill(0);
        p.suspVel.fill(0);
        const ws = state.wheelSlip || [0, 0, 0, 0];
        for (let i = 0; i < 4; i++) p.wheelSlip[i] = ws[i];
        return f;
      };

      /* FNV-1a over the raw bytes. Quantised to a millimetre first: the digest
         has to survive a compiler reordering a multiply, and must still catch
         a particle that moved. */
      const hash = (view) => {
        let h = 0x811c9dc5 >>> 0;
        for (let i = 0; i < view.length; i++) {
          let v = view[i];
          if (!Number.isFinite(v)) v = 0;
          let q = Math.round(v * 1000) | 0;
          for (let b = 0; b < 4; b++) {
            h = (h ^ (q & 0xff)) >>> 0;
            h = Math.imul(h, 0x01000193) >>> 0;
            q >>= 8;
          }
        }
        return h;
      };
      const digest = () => {
        const pool = g.fx.particles, skids = g.fx.skids;
        return {
          centers: hash(pool.centers),
          axes: hash(pool.axes),
          scales: hash(pool.scales),
          rotations: hash(pool.rotations),
          ages: hash(pool.ages),
          shapes: hash(pool.shapes),
          kinds: hash(pool.kind),
          colors: hash(pool.colors),
          skidPos: hash(skids.positions),
          skidBirth: hash(skids.births),
          skidStrength: hash(skids.strengths),
          live: pool.live,
          liveChunks: pool.liveChunks,
          liveGroundSlaps: pool.liveGroundSlaps,
          liveSpeed: pool.liveSpeed,
          skids: skids.live,
          /* Read but never compared. Coverage is what the governor sees, not
             what it did, and it is nonzero in scenarios where the baseline
             recorded zero simply because nothing was measuring before. The
             distinction is the whole point of this run: the measurement is
             allowed to move, the emission is not. A drifting `probe` beside
             eleven identical hashes says the governor is watching and not
             touching, which is what it should do at ordinary load. */
          probe: { coverage: +pool.coverage.toFixed(4), gate: +pool.gate.toFixed(4) },
        };
      };

      const scenarios = {
        burnout() {
          for (let i = 0; i < 132; i++) {
            pose(3360, 0, 0, 0.6, { throttle: 1, handbrake: 1, wheelSlip: [0.12, 0.12, 1, 1] });
            g.fx.update(1 / 60, g.player, g.camera);
          }
        },
        drift() {
          let s = 3280;
          const slip = -0.735, vx = 21.4;
          const speed = vx / Math.cos(slip);
          for (let i = 0; i < 110; i++) {
            pose(s, 0.25, slip, vx, {
              throttle: 0.5, handbrake: 1, wheelSlip: [0.12, 0.12, 0.16, 0.18],
            });
            g.fx.update(1 / 60, g.player, g.camera);
            s += speed / 60;
          }
        },
        braking() {
          let s = 3360;
          for (let i = 0; i < 48; i++) {
            const vx = 40 - i / 47 * 7;
            pose(s, 0, 0, vx, { brake: 1, wheelSlip: [0.10, 0.10, 0.08, 0.08], pitch: -0.07 });
            g.fx.update(1 / 60, g.player, g.camera);
            s += vx / 60;
          }
        },
        speed() {
          let s = 3280;
          for (let i = 0; i < 90; i++) {
            pose(s, 0, 0, 52, { throttle: 1, wheelSlip: [0.04, 0.04, 0.05, 0.05] });
            g.fx.update(1 / 60, g.player, g.camera);
            s += 52 / 60;
          }
        },
        offroad() {
          let s = 3300;
          for (let i = 0; i < 108; i++) {
            const f = g.track.frameAt(s, frame2);
            pose(s, f.width * 0.5 + 3.0, 0.08, 24, {
              offRoad: 1, throttle: 0.72, wheelSlip: [0.38, 0.38, 0.55, 0.55],
            });
            g.fx.update(1 / 60, g.player, g.camera);
            s += (24 / Math.cos(0.08)) / 60;
          }
        },
        landing() {
          const s0 = 3330;
          for (let i = 0; i < 36; i++) {
            pose(s0 + i * 0.22, 0, 0, 16, {
              height: 1.55 * (1 - i / 36) + 0.08, airborne: true, vertVel: -4.8,
            });
            g.fx.update(1 / 60, g.player, g.camera);
          }
          let s = s0 + 36 * 0.22;
          pose(s, 0, 0, 16, { impact: 0.82 });
          g.fx.update(1 / 60, g.player, g.camera);
          for (let i = 0; i < 4; i++) {
            s += 16 / 60;
            pose(s, 0, 0, 16, {});
            g.fx.update(1 / 60, g.player, g.camera);
          }
        },
        collision() {
          let s = 3360;
          let f = g.track.frameAt(s, frame2);
          pose(s, f.width * 0.5 - 0.42, 0.04, 20, {
            throttle: 0.4, impact: 0.96, wheelSlip: [0.25, 0.25, 0.42, 0.42],
          });
          g.fx.update(1 / 60, g.player, g.camera);
          for (let i = 0; i < 6; i++) {
            s += 12 / 60;
            f = g.track.frameAt(s, frame2);
            pose(s, f.width * 0.5 - 0.42, 0.04, 12, {
              throttle: 0.2, wheelSlip: [0.18, 0.18, 0.3, 0.3],
            });
            g.fx.update(1 / 60, g.player, g.camera);
          }
        },
        /* The full-blast pose tools/fx.mjs times its frame rate on, which is
           the densest emission the system is ever asked for. */
        blast() {
          let s = 2600;
          const slip = 0.36, vx = 50, speed = vx / Math.cos(slip);
          for (let i = 0; i < 180; i++) {
            pose(s, 0.2, slip, vx, {
              throttle: 0.9, handbrake: 0.72, wheelSlip: [0.62, 0.62, 1, 1],
            });
            g.fx.update(1 / 60, g.player, g.camera);
            s += speed / 60;
          }
        },
      };

      const out = {};
      for (const [name, drive] of Object.entries(scenarios)) {
        g.fx.reset();
        g.player.placeAt(3360, 0);
        drive();
        out[name] = digest();
      }
      return out;
    });

    fs.mkdirSync(outDir, { recursive: true });
    const names = Object.keys(digests);
    if (save) {
      fs.writeFileSync(baselineFile, JSON.stringify(digests, null, 2));
      for (const n of names) {
        console.log(`  ${n.padEnd(10)} live=${String(digests[n].live).padStart(3)}`
          + `  cover=${digests[n].probe.coverage}  gate=${digests[n].probe.gate}`
          + `  centers=${digests[n].centers}`);
      }
      console.log(`  saved baseline → shots/fxreg/baseline.json`);
      return;
    }

    if (!fs.existsSync(baselineFile)) {
      console.log('  no baseline — run with --save first');
      process.exitCode = 1;
      return;
    }
    const base = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    let bad = 0;
    for (const n of names) {
      const a = base[n], b = digests[n];
      const diff = a
        ? Object.keys(b).filter(k => k !== 'probe' && a[k] !== b[k])
        : ['(missing)'];
      if (diff.length) bad++;
      const was = a?.probe ?? a ?? {};
      const moved = was.coverage !== b.probe.coverage ? ` (was ${was.coverage})` : '';
      console.log(`  ${n.padEnd(10)} ${diff.length ? 'DRIFT  ' + diff.join(',') : 'identical'}`
        + `   live=${b.live} cover=${b.probe.coverage}${moved} gate=${b.probe.gate}`);
      for (const k of diff) if (a) console.log(`      ${k}: ${a[k]} → ${b[k]}`);
    }
    console.log(bad
      ? `  FAIL  ${bad} of ${names.length} scenarios drifted`
      : `  PASS  ${names.length} scenarios identical to baseline`);
    if (bad) process.exitCode = 1;
    fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(digests, null, 2));
    if (errs.length) console.log(`  (${errs.length} page messages)`);
  });

finish(process.exitCode || 0);
