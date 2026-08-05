/* The jump interface, photographed and measured.
 *
 * System 2 puts ramps and boost pads on the stage. This drives the FX side of
 * one from the outside — the way the ramps module will — and answers the five
 * questions that were asked of it:
 *
 *   scale     does a landing get visibly bigger on an axis that is not
 *             strength, which saturates?
 *   height    does a full ramp landing put up a curtain around four metres?
 *   carry     at the 17-19 m/s a real landing arrives at, does the burst sweep
 *             out behind the car or close around it?
 *   take-off  is there anything at all at the lip?
 *   rivals    does a car that is not the player disturb the ground?
 *
 * Heights, radii and the car's position relative to the ring are read out of
 * the pool in metres rather than judged from the pictures, because "about four
 * metres" is checkable and "looks big enough" is not.
 *
 *   node tools/tramp.mjs [tag] [--w 1600] [--h 900]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = (args[0] && !args[0].startsWith('--')) ? args[0] : 'tramp';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const W = +flag('w', 1600);
const H = +flag('h', 900);
const outDir = path.join(ROOT, 'shots', tag);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const hash = `manual&tier=${flag('tier', 'high')}&seed=${flag('seed', 22)}&cap=60&hud=0&ink=1`;

/* The speed a ramp landing actually arrives at, and the speed the old carry
   fraction was set against. Both are driven so the difference is on record. */
const LANDING_MS = 18;
const FAST_MS = 60;

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

    h.pose = (car, s, vx, state = {}) => {
      const f = g.track.frameAt(s, h.frame);
      car.surfaceAt(s, state.lat || 0, h.surface);
      car.pos.copy(h.surface).addScaledVector(f.up, CAR.rideHeight + (state.height || 0));
      car.s = s;
      car.lat = state.lat || 0;
      car.up.copy(f.up);
      car.forward.copy(f.tan);
      car.right.copy(f.right);
      car.yaw = Math.atan2(car.forward.z, car.forward.x);
      car.vx = vx;
      car.vy = 0;
      car.r = 0;
      car.airborne = !!state.airborne;
      car.height = state.height || 0;
      car.vertVel = state.vertVel || 0;
      car.offRoad = state.offRoad || 0;
      car.throttle = state.throttle || 0;
      car.brake = 0;
      car.handbrake = 0;
      car.lastImpact = state.impact || 0;
      car.roll = 0;
      car.pitch = state.pitch || 0;
      car.bodyLift = 0;
      car.susp.fill(0);
      car.suspVel.fill(0);
      for (let i = 0; i < 4; i++) car.wheelSlip[i] = state.slip || 0;
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
      p.applyTo(g.playerView);
      g.sun.target.position.copy(p.pos);
      g.sun.position.copy(p.pos).add(h.sunOffset);
      g.sun.target.updateMatrixWorld();
    };

    /* What the burst is, in metres, straight off the instance buffers. The
       curtain quads are kind 4 and their y scale is the full height of the
       wall the crown is drawn inside; the crown itself peaks a few per cent
       below the top of the quad. The ring radius is the distance from the
       burst's own centre to a segment. */
    h.burst = (car) => {
      const pool = g.fx.particles;
      let height = 0, radius = 0, segments = 0, sheet = 0;
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < pool.max; i++) {
        if (!pool.active[i] || pool.kind[i] < 3.5) continue;
        segments++;
        height = Math.max(height, pool.scales[i * 2 + 1]);
        cx += pool.centers[i * 3];
        cy += pool.centers[i * 3 + 1];
        cz += pool.centers[i * 3 + 2];
      }
      for (let i = 0; i < pool.max; i++) {
        if (pool.active[i] && pool.kind[i] > 2.5 && pool.kind[i] < 3.5) sheet++;
      }
      if (!segments) return { segments: 0, sheet, height: 0, radius: 0, clear: 0 };
      cx /= segments; cy /= segments; cz /= segments;
      for (let i = 0; i < pool.max; i++) {
        if (!pool.active[i] || pool.kind[i] < 3.5) continue;
        const dx = pool.centers[i * 3] - cx;
        const dz = pool.centers[i * 3 + 2] - cz;
        radius = Math.max(radius, Math.hypot(dx, dz));
      }
      /* Positive when the car is outside the ring, negative when the ring is
         still around it. This is the "does it enclose the car" question as a
         number: it must go positive well inside the burst's life. */
      const carDist = Math.hypot(car.pos.x - cx, car.pos.z - cz);
      return {
        segments, sheet,
        height: +height.toFixed(2),
        radius: +radius.toFixed(2),
        clear: +(carDist - radius).toFixed(2),
      };
    };

    /* Fly and land, with the FX system told how big the jump is exactly the
       way the ramps module will tell it. Returns the burst measured at each
       requested frame after contact. */
    h.jump = (opts) => {
      const { scale = 1, vx = 18, air = 30, impact = 1, hold = 0, watch = [] } = opts;
      const p = g.player, fx = g.fx, dt = 1 / 60;
      fx.reset();
      let s = 3320;
      p.placeAt(s, 0);
      h.pose(p, s, vx, {});
      fx.update(dt, p, g.camera);
      /* The ramp says how big it is on the frame the car meets the lip. */
      if (scale !== 1) fx.armLanding(scale);
      const trace = [];
      let launchParticles = 0;
      for (let i = 0; i < air; i++) {
        h.pose(p, s, vx, {
          height: 1.9 * Math.sin(Math.PI * (i + 1) / (air + 1)) + 0.1,
          airborne: true, vertVel: i < air / 2 ? 6 : -6,
        });
        fx.update(dt, p, g.camera);
        if (i === 1) launchParticles = fx.particles.live;
        s += vx * dt;
      }
      h.pose(p, s, vx, { impact, pitch: -0.05 });
      fx.update(dt, p, g.camera);
      const frames = Math.max(hold, watch.length ? Math.max(...watch) : 0);
      const seen = {};
      if (watch.includes(0)) seen[0] = h.burst(p);
      for (let i = 1; i <= frames; i++) {
        s += vx * dt;
        h.pose(p, s, vx, { throttle: 0.5 });
        fx.update(dt, p, g.camera);
        trace.push(h.burst(p).clear);
        if (watch.includes(i)) seen[i] = h.burst(p);
      }
      return { launchParticles, seen, trace, live: fx.particles.live };
    };

    /* The lip on its own, held so it can be photographed while it is there. */
    h.takeoff = (scale, frames) => {
      const p = g.player, fx = g.fx, dt = 1 / 60;
      fx.reset();
      let s = 3320;
      p.placeAt(s, 0);
      h.pose(p, s, 26, {});
      fx.update(dt, p, g.camera);
      fx.armLanding(scale);
      let born = 0;
      for (let i = 0; i < frames; i++) {
        h.pose(p, s, 26, { height: 0.2 + i * 0.12, airborne: true, vertVel: 7 });
        fx.update(dt, p, g.camera);
        if (i === 0) born = fx.particles.live;
        s += 26 * dt;
      }
      /* How far the car has pulled away from the grit it left. The scuff is
         supposed to stay on the ramp, so this grows at very nearly the car's
         own speed. */
      const pool = fx.particles;
      let n = 0, dsum = 0;
      for (let i = 0; i < pool.max; i++) {
        if (!pool.active[i]) continue;
        n++;
        dsum += Math.hypot(pool.centers[i * 3] - p.pos.x, pool.centers[i * 3 + 2] - p.pos.z);
      }
      return { born, live: n, meanBehind: +(dsum / Math.max(1, n)).toFixed(2) };
    };

    h.shoot = () => {
      g.pipeline.render();
      const info = g.info();
      return { calls: info.calls, triangles: info.triangles, live: g.fx.particles.live };
    };

    /* Invariant 3 as a measurement rather than an assertion: what value the
       burst is actually painting, against the road it is painted on. A taller
       curtain shows far more of its brightest rung than a short one, so the
       ratio has to be watched as scale grows — that is precisely how "bigger"
       turns into "made of a different material". */
    h.values = () => {
      const c = g.renderer.domElement;
      const off = document.createElement('canvas');
      off.width = c.width; off.height = c.height;
      const ctx = off.getContext('2d');
      ctx.drawImage(c, 0, 0);
      const d = ctx.getImageData(0, 0, off.width, off.height).data;
      let dust = 0, road = 0, dustSum = 0, roadSum = 0, peak = 0;
      const y0 = Math.floor(off.height * 0.30);
      for (let y = y0; y < off.height; y++) {
        for (let x = 0; x < off.width; x++) {
          const i = (y * off.width + x) * 4;
          const r = d[i], gg = d[i + 1], b = d[i + 2];
          const v = (r + gg + b) / 3;
          const warm = r - b;
          if (v > 118 && v < 235 && warm > 8 && warm < 46 && Math.abs(r - gg) < 24) {
            dust++; dustSum += v; peak = Math.max(peak, v);
          } else if (v > 55 && v < 130 && Math.abs(warm) <= 8) {
            road++; roadSum += v;
          }
        }
      }
      const dv = dust ? dustSum / dust : 0;
      const rv = road ? roadSum / road : 0;
      return {
        dustPct: +(dust / ((off.height - y0) * off.width) * 100).toFixed(2),
        dustValue: +dv.toFixed(1),
        roadValue: +rv.toFixed(1),
        peakValue: peak,
        ratio: rv ? +(dv / rv).toFixed(2) : 0,
      };
    };

    g.rampHarness = h;
  });

  const report = { landing: {}, takeoff: {}, rival: {} };

  console.log('\n  landing — scale against a fixed strength of 1.0, at 18 m/s');
  console.log('    scale  segs  curtain m  ring m   car clear of ring after');
  for (const scale of [1, 2, 3.4]) {
    const r = await page.evaluate(s =>
      window.__game.rampHarness.jump({ scale: s, vx: 18, watch: [1, 6, 14, 24], hold: 40 }),
    scale);
    const peak = r.seen[1];
    const clearAt = r.trace.findIndex(v => v > 0);
    report.landing[scale] = { ...r, clearFrame: clearAt };
    console.log(`    ${String(scale).padEnd(6)} ${String(peak.segments).padStart(4)}`
      + `  ${String(peak.height).padStart(9)}  ${String(peak.radius).padStart(6)}`
      + `   ${clearAt < 0 ? 'NEVER' : clearAt + ' frames'}`);
    for (const f of [1, 6, 14, 24]) {
      const v = await page.evaluate(([s, frame]) => {
        const h = window.__game.rampHarness;
        h.jump({ scale: s, vx: 18, hold: frame });
        h.aim(168, 8, 13 + s * 2.5, -1.0);
        h.shoot();
        return h.values();
      }, [scale, f]);
      report.landing[scale][`values${f}`] = v;
      if (f === 6) {
        console.log(`           value ${v.dustValue} against road ${v.roadValue}`
          + `  = ${v.ratio}x   peak ${v.peakValue}   ${v.dustPct}% of frame`);
      }
      await capture(page, path.join(outDir, `landing-s${scale}-f${String(f).padStart(2, '0')}.png`));
    }
    await page.evaluate(([s]) => {
      const h = window.__game.rampHarness;
      h.jump({ scale: s, vx: 18, hold: 6 });
      h.aim(150, 2.6, 11 + s * 2.5, -0.6);
    }, [scale]);
    await capture(page, path.join(outDir, `landing-s${scale}-low.png`));
  }

  console.log('\n  carry — the same burst at the speed the old fraction was set for');
  for (const vx of [LANDING_MS, FAST_MS]) {
    const r = await page.evaluate(v =>
      window.__game.rampHarness.jump({ scale: 3.4, vx: v, watch: [1], hold: 40 }), vx);
    const clearAt = r.trace.findIndex(x => x > 0);
    report.landing[`carry${vx}`] = { clearFrame: clearAt, trace: r.trace };
    console.log(`    ${vx} m/s   car clear of the ring after `
      + `${clearAt < 0 ? 'NEVER' : clearAt + ' frames'}`
      + `   separation at the end ${r.trace[r.trace.length - 1]} m`);
  }

  console.log('\n  take-off — the lip');
  for (const scale of [1, 3.4]) {
    const r = await page.evaluate(s => {
      const h = window.__game.rampHarness;
      const out = h.takeoff(s, 6);
      h.aim(158, 7, 12, -2.0);
      return { ...out, ...h.shoot() };
    }, scale);
    await capture(page, path.join(outDir, `takeoff-s${scale}.png`));
    report.takeoff[scale] = r;
    console.log(`    scale ${String(scale).padEnd(4)} ${String(r.born).padStart(3)} pieces at the lip`
      + `   ${r.meanBehind} m behind the car six frames later`);
  }

  console.log('\n  rivals — a car that is not the player');
  const rival = await page.evaluate(async () => {
    const g = window.__game, h = g.rampHarness;
    const fx = g.fx, dt = 1 / 60;
    const car = g.race.entries[0].car;
    fx.reset();
    fx.follow([car]);

    /* Player parked off to one side and the camera on the rival, which is the
       shot the jump section will keep taking. */
    let s = 3320;
    g.player.placeAt(s - 26, 0);
    h.pose(g.player, s - 26, 0, {});
    car.placeAt(s, 0);

    const before = fx.particles.live;
    for (let i = 0; i < 60; i++) {
      h.pose(car, s, 26, { slip: 0.5, offRoad: 0.4, lat: 4.2 });
      fx.update(dt, g.player, g.camera);
      s += 26 * dt;
      car.applyTo(g.race.entries[0].view);
    }
    const drivingDust = fx.particles.live;

    /* And the same car over a jump. */
    for (let i = 0; i < 34; i++) {
      h.pose(car, s, 22, { height: 1.8 * Math.sin(Math.PI * (i + 1) / 35) + 0.1, airborne: true });
      fx.update(dt, g.player, g.camera);
      s += 22 * dt;
    }
    const inFlight = fx.particles.live;
    h.pose(car, s, 22, { impact: 1 });
    fx.update(dt, g.player, g.camera);
    for (let i = 0; i < 5; i++) {
      s += 22 * dt;
      h.pose(car, s, 22, {});
      fx.update(dt, g.player, g.camera);
      car.applyTo(g.race.entries[0].view);
    }
    const landing = h.burst(car);

    /* Camera on the rival rather than on the player. */
    const cam = g.camera;
    cam.position.set(car.pos.x - 9, car.pos.y + 3.2, car.pos.z - 7);
    cam.lookAt(car.pos.x, car.pos.y + 0.6, car.pos.z);
    cam.updateProjectionMatrix();
    g.pipeline.render();
    return { before, drivingDust, inFlight, landing, s };
  });
  await capture(page, path.join(outDir, 'rival-landing.png'));

  /* Only now, with the frame on disk: a followed car far enough away has to
     cost the pool nothing at all. */
  rival.distant = await page.evaluate((s) => {
    const g = window.__game, h = g.rampHarness, fx = g.fx;
    const car = g.race.entries[0].car;
    fx.reset();
    car.placeAt(s + 900, 0);
    for (let i = 0; i < 40; i++) {
      h.pose(car, s + 900, 26, { slip: 0.6, offRoad: 1 });
      fx.update(1 / 60, g.player, g.camera);
    }
    const live = fx.particles.live;

    /* What following costs. Three rivals in frame is the normal case, and the
       answer has to be small enough that nobody has to think about it: a
       rival's dust is only worth having if it is not paid for by the player's
       frame. Timed against the same update doing nothing else. */
    const time = (n) => {
      const cars = g.race.entries.slice(0, n).map(e => e.car);
      for (const c of cars) c.placeAt(g.player.s + 12, 0);
      fx.follow(cars);
      for (let i = 0; i < 30; i++) fx.update(1 / 60, g.player, g.camera);
      const t0 = performance.now();
      for (let i = 0; i < 300; i++) fx.update(1 / 60, g.player, g.camera);
      return +((performance.now() - t0) / 300).toFixed(3);
    };
    const alone = time(0);
    const three = time(3);
    fx.follow([]);
    return { live, alone, three };
  }, rival.s);
  report.rival = rival;
  console.log(`    driving past      ${rival.drivingDust} live particles (from ${rival.before})`);
  console.log(`    landing           ${rival.landing.segments} curtain segments`
    + `  ${rival.landing.height} m tall  ${rival.landing.radius} m ring`);
  console.log(`    900 m away        ${rival.distant.live} live particles`);
  console.log(`    cost of following three rivals   ${rival.distant.alone} ms`
    + ` → ${rival.distant.three} ms per update`);

  const peak = report.landing[3.4].seen[1];
  const ok = {
    'a full ramp landing puts up a curtain near 4 m':
      peak.height > 3.4 && peak.height < 4.6,
    'scale is a real axis, not a saturated one':
      peak.height > report.landing[1].seen[1].height * 2.5,
    'the ring is closed at every scale':
      [1, 2, 3.4].every(s => report.landing[s].seen[1].segments === 12),
    'the car gets out of its own landing at 18 m/s':
      report.landing[3.4].clearFrame > 0 && report.landing[3.4].clearFrame < 30,
    'the burst still keeps up at 60 m/s':
      report.landing.carry60.clearFrame > 0,
    'there is something at the lip': report.takeoff[1].born > 0,
    'the lip scuff is left behind': report.takeoff[3.4].meanBehind > 4,
    'a rival throws dust': rival.drivingDust > 0,
    'a rival landing produces a burst': rival.landing.segments === 12,
    'a distant rival costs nothing': rival.distant.live === 0,
    'following three rivals is not felt': rival.distant.three < 0.35,
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
