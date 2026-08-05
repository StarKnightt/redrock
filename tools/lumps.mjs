/* Is it one shape or a pile of objects, and how far above the road does it sit.
 *
 * Both failures this project keeps hitting with particles are measurable, and
 * arguing about them from screenshots has not worked twice now. So measure.
 *
 * Each scenario is rendered twice, once with the particle pool visible and
 * once with it hidden, and the difference is an exact mask of what the pool
 * put on screen — no colour keying, no guessing which pale pixel was dust.
 * From that mask:
 *
 *   lumps    connected components above a floor area. This is the number the
 *            eye counts. A trailing plume is allowed to be several; anything
 *            at close range on tarmac that resolves into six separate blobs
 *            is six objects lying in the road, whatever each one looks like.
 *   biggest  share of the mask held by its largest component. Near 1.0 means
 *            one connected shape; 0.2 means confetti.
 *   lift     mean luminance of the mask minus the mean luminance of exactly
 *            the pixels it covered. This is the contrast against the road,
 *            which is the whole of the "bright shapes on grey tarmac" read.
 *
 *   node tools/lumps.mjs [tag]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = (args[0] && !args[0].startsWith('--')) ? args[0] : 'lumps';
const outDir = path.join(ROOT, 'shots', tag);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const VIEWS = {
  low: { az: 168, el: 3.2, dist: 10.0, trail: 0.6 },
  chase: { az: 178, el: 9, dist: 11.5, trail: 1.0 },
};

/* Cruise cases hold a steady speed on clean tarmac long enough for the veil to
   reach its running density; landing cases are read at frame 3, which is what
   a player actually sees of a burst rather than the frame that flatters it. */
const CASES = [
  { name: 'cruise-120-low', kind: 'cruise', kmh: 120, view: 'low' },
  { name: 'cruise-160-low', kind: 'cruise', kmh: 160, view: 'low' },
  { name: 'cruise-160-chase', kind: 'cruise', kmh: 160, view: 'chase' },
  { name: 'cruise-200-low', kind: 'cruise', kmh: 200, view: 'low' },
  { name: 'land-hard-f03-chase', kind: 'land', kmh: 150, impact: 1, frames: 3, view: 'chase' },
  { name: 'land-hard-f03-low', kind: 'land', kmh: 150, impact: 1, frames: 3, view: 'low' },
  { name: 'land-ramp-f03-chase', kind: 'land', kmh: 210, impact: 1, frames: 3, view: 'chase' },
];

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
        p.throttle = state.throttle === undefined ? 1 : state.throttle;
        p.brake = 0; p.handbrake = 0;
        p.lastImpact = state.impact || 0;
        p.roll = 0; p.pitch = 0; p.bodyLift = 0;
        p.susp.fill(0); p.suspVel.fill(0);
        p.wheelSlip.fill(0);
      };
      h.cruise = (kmh) => {
        const p = g.player, fx = g.fx, dt = 1 / 60;
        fx.reset();
        const vx = kmh / 3.6;
        let s = 3320;
        p.placeAt(s, 0);
        for (let i = 0; i < 110; i++) {
          h.pose(s, vx, {});
          fx.update(dt, p, g.camera);
          s += vx * dt;
        }
      };
      h.land = (impact, kmh, frames) => {
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
      h.shoot = (v, showFx) => {
        const p = g.player, cam = g.camera;
        /* Scales rather than mesh.visible: the pipeline draws the pool through
           a registered prepass as well as the main pass, and clearing the flag
           only takes one of them out. A zero-scale instance is absent from
           both, and the sim is rebuilt before every shot so nothing leaks. */
        if (!showFx) {
          const pool = g.fx.particles;
          for (let i = 0; i < pool.max; i++) pool.scales[i * 2] = pool.scales[i * 2 + 1] = 0;
          pool.scaleAttr.needsUpdate = true;
        }
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
      /* Decoded here rather than in node so the whole run needs one browser. */
      h.measure = async (onB64, offB64) => {
        const load = async (b64) => {
          const img = new Image();
          img.src = 'data:image/png;base64,' + b64;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.width; c.height = img.height;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          return { d: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
        };
        const A = await load(onB64), B = await load(offB64);
        const { w, h: ht } = A;
        const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        const lum = (d, i) => 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
        const mask = new Uint8Array(w * ht);
        let n = 0, sumOn = 0, sumOff = 0;
        for (let p = 0; p < w * ht; p++) {
          const i = p * 4;
          const diff = Math.abs(A.d[i] - B.d[i]) + Math.abs(A.d[i + 1] - B.d[i + 1])
            + Math.abs(A.d[i + 2] - B.d[i + 2]);
          if (diff > 14) {
            mask[p] = 1; n++;
            sumOn += lum(A.d, i);
            sumOff += lum(B.d, i);
          }
        }
        /* Four-connected flood fill. Eight would bridge shapes that merely
           touch at a corner, and a corner touch is not what makes two blobs
           read as one thing. */
        const seen = new Uint8Array(w * ht);
        const areas = [];
        const stack = new Int32Array(w * ht);
        for (let p = 0; p < w * ht; p++) {
          if (!mask[p] || seen[p]) continue;
          let top = 0, area = 0;
          stack[top++] = p; seen[p] = 1;
          while (top > 0) {
            const q = stack[--top];
            area++;
            const x = q % w, y = (q / w) | 0;
            if (x > 0 && mask[q - 1] && !seen[q - 1]) { seen[q - 1] = 1; stack[top++] = q - 1; }
            if (x < w - 1 && mask[q + 1] && !seen[q + 1]) { seen[q + 1] = 1; stack[top++] = q + 1; }
            if (y > 0 && mask[q - w] && !seen[q - w]) { seen[q - w] = 1; stack[top++] = q - w; }
            if (y < ht - 1 && mask[q + w] && !seen[q + w]) { seen[q + w] = 1; stack[top++] = q + w; }
          }
          areas.push(area);
        }
        areas.sort((a, b) => b - a);
        /* Below this a component is a fringe pixel or an ink seam, not a thing
           anyone would point at. Roughly a 12px square in a 1600x900 frame. */
        const solid = areas.filter(a => a >= 150);
        return {
          coverage: n / (w * ht),
          lumps: solid.length,
          biggest: n ? (areas[0] || 0) / n : 0,
          top: solid.slice(0, 6),
          onL: n ? sumOn / n : 0,
          offL: n ? sumOff / n : 0,
        };
      };
      g.lumpHarness = h;
    });

    const rows = [];
    for (const c of CASES) {
      const shots = {};
      for (const showFx of [true, false]) {
        await page.evaluate(([cs, v, show]) => {
          const h = window.__game.lumpHarness;
          if (cs.kind === 'cruise') h.cruise(cs.kmh);
          else h.land(cs.impact, cs.kmh, cs.frames);
          h.shoot(v, show);
        }, [c, VIEWS[c.view], showFx]);
        const file = path.join(outDir, `${c.name}${showFx ? '' : '-off'}.png`);
        await capture(page, file);
        shots[showFx ? 'on' : 'off'] = fs.readFileSync(file).toString('base64');
      }
      const m = await page.evaluate(
        ([on, off]) => window.__game.lumpHarness.measure(on, off), [shots.on, shots.off]);
      rows.push({ name: c.name, ...m });
      console.log(
        '  ' + c.name.padEnd(22),
        'cover ' + (m.coverage * 100).toFixed(2).padStart(5) + '%',
        'lumps ' + String(m.lumps).padStart(3),
        'biggest ' + (m.biggest * 100).toFixed(0).padStart(3) + '%',
        'L ' + m.onL.toFixed(3) + ' over ' + m.offL.toFixed(3),
        'lift ' + (m.onL - m.offL >= 0 ? '+' : '') + (m.onL - m.offL).toFixed(3),
        'top ' + m.top.slice(0, 4).join(','),
      );
    }
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(rows, null, 2));
    if (errs.length) console.log(errs.slice(0, 5).join('\n'));
  });

finish(process.exitCode || 0);
