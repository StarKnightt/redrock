/* Round-3 review instrument (read-only): the launch, frame by frame.
 *
 * The question is not how long the slow motion lasts — slowclock.mjs answers
 * that — but what the player is looking at while it does. So this walks the
 * launch on a fixed 60 Hz wall clock and, for every frame, records the time
 * scale in force, the car's height, how far the camera is from it, how many
 * pixels of the frame the car covers and where the horizon sits. Frames named
 * on --shots are written out at native resolution.
 *
 * Wall time, not simulation time: Game.step(dt) takes dt as wall clock and
 * spends dt * timeScale() on the physics, so N steps of 1/60 are N/60 seconds
 * of the player's life whatever the scale is doing.
 *
 *   node tools/r3launch.mjs [--seed 22] [--ramp 1] [--shots 0,8,20,34,48,70]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', 22);
const RAMP = +flag('ramp', 1);
const SHOTS = (flag('shots', '0,6,14,30,48,66,84') || '').split(',').filter(Boolean).map(Number);
const TAG = flag('tag', `r3launch${SEED}`);

await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
  async ({ page }) => {
    const out = await page.evaluate(([idx, shots]) => {
      const g = window.__game, p = g.player;
      const cv = g.renderer.domElement, w = cv.width, h = cv.height;
      g.setPaused(true);
      if (g.race?.entries) g.race.entries.length = 0;
      const r = g.track.ramps[Math.min(idx, g.track.ramps.length - 1)];
      g.autopilot(true, 0.85);
      g.driveTo((r.pad0 - 40) / g.track.length, { runUp: 340, maxSec: 45 });

      const carPx = () => {
        const a = p.pos.clone().addScaledVector(p.forward, 2.05).project(g.camera);
        const b = p.pos.clone().addScaledVector(p.forward, -2.05).project(g.camera);
        return Math.hypot((a.x - b.x) * 0.5 * w, (a.y - b.y) * 0.5 * h);
      };
      /* Pixels per metre of altitude, read off the live camera: project the car
         and a point one metre below it and take the screen gap. This is the
         number that decides whether the flight looks high. */
      const pxPerM = () => {
        const f = g.track.frameAt(p.s);
        const a = p.pos.clone().project(g.camera);
        const b = p.pos.clone().addScaledVector(f.up, -1).project(g.camera);
        return Math.abs((a.y - b.y) * 0.5 * h);
      };

      const rows = [], pngs = [];
      let f = 0, wasAir = false, done = 0;
      /* Start a little before the pad so the run-in is on the trace. */
      while (f < 200) {
        const scale = g.timeScale();
        const camD = g.camera.position.distanceTo(p.pos);
        rows.push({
          f, wall: +(f / 60).toFixed(3), scale: +scale.toFixed(3),
          air: p.airborne ? 1 : 0, hgt: +p.height.toFixed(2),
          camD: +camD.toFixed(2), carPx: +carPx().toFixed(1),
          pxm: +pxPerM().toFixed(1), kmh: Math.round(p.speed * 3.6),
        });
        if (shots.includes(f)) {
          g.renderOnce();
          pngs.push({ f, png: cv.toDataURL('image/png') });
        }
        g.step(1 / 60);
        if (p.airborne) wasAir = true;
        if (wasAir && !p.airborne) { if (++done > 24) break; }
        f++;
      }
      g.autopilot(false);
      return { rows, pngs, lip: r.lip, seed: g.track.seed };
    }, [RAMP, SHOTS]);

    const dir = path.join(ROOT, 'shots', TAG);
    fs.mkdirSync(dir, { recursive: true });
    for (const s of out.pngs) {
      fs.writeFileSync(path.join(dir, `f${String(s.f).padStart(3, '0')}.png`),
        Buffer.from(s.png.split(',')[1], 'base64'));
    }
    console.log(`\n  seed ${out.seed}, lip ${out.lip} → shots/${TAG}`);
    console.log('   f   wall s  scale  air  height m   cam m   car px   px per m of altitude   km/h');
    for (const r of out.rows) {
      console.log(`  ${String(r.f).padStart(3)} ${r.wall.toFixed(3).padStart(8)}`
        + ` ${r.scale.toFixed(2).padStart(6)} ${String(r.air).padStart(4)}`
        + ` ${r.hgt.toFixed(2).padStart(9)} ${r.camD.toFixed(2).padStart(7)}`
        + ` ${r.carPx.toFixed(1).padStart(8)} ${r.pxm.toFixed(1).padStart(22)}`
        + ` ${String(r.kmh).padStart(6)}`);
    }
    const air = out.rows.filter(r => r.air);
    const ground = out.rows.filter(r => !r.air && r.f < (air[0]?.f ?? 0));
    if (air.length && ground.length) {
      const g0 = ground[ground.length - 1];
      const camMax = Math.max(...air.map(r => r.camD));
      console.log(`\n  camera ${g0.camD.toFixed(2)} m at the lip → ${camMax.toFixed(2)} m at its furthest`
        + `  (+${(camMax - g0.camD).toFixed(2)} m, ${((camMax / g0.camD - 1) * 100).toFixed(0)}%)`);
      console.log(`  car ${g0.carPx.toFixed(0)} px long at the lip → `
        + `${Math.min(...air.map(r => r.carPx)).toFixed(0)} px at its smallest`);
      console.log(`  flight ${(air.length / 60).toFixed(2)} s of wall clock, apex `
        + `${Math.max(...air.map(r => r.hgt)).toFixed(2)} m`);
      const dip = out.rows.filter(r => r.scale < 0.99);
      console.log(`  slow motion ${(dip.length / 60).toFixed(2)} s of wall clock,`
        + ` deepest x${Math.min(...out.rows.map(r => r.scale)).toFixed(2)},`
        + ` ends at height ${dip.length ? dip[dip.length - 1].hgt.toFixed(2) : '-'} m`
        + ` of a ${Math.max(...air.map(r => r.hgt)).toFixed(2)} m apex`);
    }
  });

finish(process.exitCode || 0);
