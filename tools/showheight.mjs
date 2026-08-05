/* Read-only review probe: is the height actually SHOWN?
 *
 * The physics answer to "how big is the jump" is p.height. The composition
 * answer is different and it is the one the player gets: how far, in pixels,
 * does the car separate from the point of road directly beneath it, and how
 * big is the car while that happens. A camera that climbs and pulls back
 * faster than the car rises can make a real jump read as flat.
 *
 * Per frame through every ramp launch on a seed this projects, through the
 * game's own camera after the game's own camera update:
 *
 *   carPx     screen y of the car's origin
 *   gndPx     screen y of the road point directly under it (pos - up*height)
 *   sepPx     gndPx - carPx, the separation actually drawn
 *   lenPx     the car's own projected length, as the ruler
 *   lifts     sepPx / lenPx, air measured in car lengths on screen
 *   boom      lens-to-car distance, fov, timeScale
 *
 * Nothing is rendered and nothing is written. Read-only.
 *
 *   node tools/showheight.mjs [--seeds 22,1,16,40]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22').split(',').map(Number);
const W = +flag('w', 1600), H = +flag('h', 900);

const all = [];

for (const SEED of SEEDS) {
  await run({
    width: W, height: H,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    const out = await page.evaluate(([W, H]) => {
      const g = window.__game, p = g.player, track = g.track, L = track.length;
      g.setPaused(true);
      if (g.race?.entries) g.race.entries.length = 0;

      const V = window.THREE_V || null;
      const proj = (v) => {
        // Clone-free NDC projection through the live camera.
        const q = v.clone().project(g.camera);
        return { x: (q.x * 0.5 + 0.5) * W, y: (-q.y * 0.5 + 0.5) * H, z: q.z };
      };

      const rows = [];
      g.autopilot(true, 0.85);
      for (const r of track.ramps) {
        g.driveTo((r.pad0 - 60) / L, { runUp: 320, maxSec: 45 });
        const samples = [];
        let wasAir = false, n = 0, done = 0;
        while (n++ < 900) {
          g.step(1 / 60);
          if (p.airborne) wasAir = true;
          if (wasAir) {
            const up = track.frameAt(p.s).up;
            const car = proj(p.pos);
            const gnd = proj(p.pos.clone().addScaledVector(up, -p.height));
            // The car's own length as the on-screen ruler: 4.1 m along travel.
            const nose = proj(p.pos.clone().addScaledVector(p.forward, 2.05));
            const tail = proj(p.pos.clone().addScaledVector(p.forward, -2.05));
            const lenPx = Math.hypot(nose.x - tail.x, nose.y - tail.y);
            samples.push({
              t: +(samples.length / 60).toFixed(3),
              h: +p.height.toFixed(3),
              air: p.airborne ? 1 : 0,
              carY: +car.y.toFixed(1), gndY: +gnd.y.toFixed(1),
              sep: +(gnd.y - car.y).toFixed(1),
              lenPx: +lenPx.toFixed(1),
              boom: +g.camera.position.distanceTo(p.pos).toFixed(2),
              camUp: +(g.camera.position.y - p.pos.y).toFixed(2),
              fov: +g.camera.fov.toFixed(1),
              scale: +g.timeScale().toFixed(2),
              pitch: +(p.airPitch * 180 / Math.PI).toFixed(1),
              squash: +p.squash.toFixed(3),
            });
          }
          if (wasAir && !p.airborne) { if (++done > 40) break; }
        }
        // A grounded reference from just before the pad, same speed regime.
        rows.push({ lip: r.lip, samples });
      }
      g.autopilot(false);
      return { seed: track.seed, rows };
    }, [W, H]);

    for (const r of out.rows) {
      const s = r.samples;
      if (!s.length) { console.log(`  seed ${out.seed} lip ${r.lip} — no air`); continue; }
      const apex = s.reduce((a, b) => (b.h > a.h ? b : a), s[0]);
      const first = s[0];
      const maxSep = s.reduce((a, b) => (b.sep > a.sep ? b : a), s[0]);
      const grounded = s.filter(x => !x.air);
      const g0 = grounded[grounded.length - 1] || s[s.length - 1];
      const rec = {
        seed: out.seed, lip: r.lip,
        apexH: apex.h, apexSep: apex.sep, apexLen: apex.lenPx,
        lifts: +(apex.sep / apex.lenPx).toFixed(3),
        pctH: +(apex.sep / 900 * 100).toFixed(2),
        maxSep: maxSep.sep, maxSepPct: +(maxSep.sep / 900 * 100).toFixed(2),
        lenLip: first.lenPx, lenApex: apex.lenPx,
        shrink: +((1 - apex.lenPx / first.lenPx) * 100).toFixed(1),
        boomLip: first.boom, boomApex: apex.boom,
        camUpLip: first.camUp, camUpApex: apex.camUp,
        fovLip: first.fov, fovApex: apex.fov,
        pitchMax: Math.max(...s.map(x => Math.abs(x.pitch))),
        pitchApex: apex.pitch,
        pitchLandNose: Math.min(...s.map(x => x.pitch)),
        squashMax: Math.max(...s.map(x => Math.abs(x.squash))),
        scaleMin: Math.min(...s.map(x => x.scale)),
      };
      all.push(rec);
      console.log(`  seed ${rec.seed} lip ${String(rec.lip).padStart(5)}`
        + `  apex ${rec.apexH.toFixed(2)} m -> ${rec.apexSep.toFixed(1)} px sep`
        + ` (${rec.pctH.toFixed(2)}% of frame, ${rec.lifts.toFixed(2)} car lengths)`
        + `  car ${rec.lenLip.toFixed(0)}->${rec.lenApex.toFixed(0)} px (${rec.shrink.toFixed(0)}% smaller)`
        + `  boom ${rec.boomLip.toFixed(1)}->${rec.boomApex.toFixed(1)} m`
        + `  camUp ${rec.camUpLip.toFixed(2)}->${rec.camUpApex.toFixed(2)}`
        + `  fov ${rec.fovLip}->${rec.fovApex}`
        + `  nose ${rec.pitchApex.toFixed(1)}/${rec.pitchLandNose.toFixed(1)}deg`
        + `  squash ${rec.squashMax.toFixed(3)}  slowmo x${rec.scaleMin.toFixed(2)}`);
    }
  });
}

if (all.length) {
  const m = k => all.reduce((a, r) => a + r[k], 0) / all.length;
  console.log(`\n  ${all.length} launches`);
  console.log(`  separation at apex: ${Math.min(...all.map(r => r.apexSep)).toFixed(0)}–${Math.max(...all.map(r => r.apexSep)).toFixed(0)} px`
    + ` (mean ${m('apexSep').toFixed(0)} px = ${m('pctH').toFixed(2)}% of a 900 px frame, ${m('lifts').toFixed(2)} car lengths)`);
  console.log(`  car shrinks ${Math.min(...all.map(r => r.shrink)).toFixed(0)}–${Math.max(...all.map(r => r.shrink)).toFixed(0)}% between lip and apex`);
  console.log(`  peak nose-up ${Math.max(...all.map(r => r.pitchMax)).toFixed(1)}deg, most nose-down ${Math.min(...all.map(r => r.pitchLandNose)).toFixed(1)}deg`);
  console.log(`  squash peak ${Math.max(...all.map(r => r.squashMax)).toFixed(3)} m, slowest time scale x${Math.min(...all.map(r => r.scaleMin)).toFixed(2)}`);
}
finish(process.exitCode || 0);
