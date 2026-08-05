/* What a jump actually looks like.
 *
 * Four frames at every ramp on the seed — the approach with the pad in shot,
 * the lip, the apex from the pulled-back boom, and the landing — plus one
 * frame of a rival in the air, which is a different thing to check: the
 * camera is pointed at the player, so a rival's flight has to read from the
 * side and at a distance.
 *
 * The car is driven in by the AI rather than teleported, because a teleported
 * car has no speed, and a ramp with no speed is a bump.
 *
 *   node tools/rampshot.mjs [--seed 22] [--seeds 22,1,7]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', flag('seed', '22')).split(',').map(Number);
const TAG = flag('tag', 'ramps');

const outDir = path.join(ROOT, 'shots', TAG);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

/* Advance to the next moment worth a picture and report where the car is.
   Everything is done a frame at a time from node so the capture can happen
   between two steps rather than after a fixed number of them — the apex is
   four frames wide at 60 Hz and a loop that overshoots it by two lands on a
   car that is already coming down. */
const STEP = async (page, until, arg = 0, limit = 900) => page.evaluate(([until, arg, limit]) => {
  const g = window.__game, p = g.player;
  const test = {
    /* Short of the pad, not on it: on it the pad is under the car and the
       shot is of the road past it. From here the pad, the ramp and the lip
       are all in the same frame, which is what the driver sees. */
    pad: () => p.s >= arg,
    lip: () => p.airborne && p.launched && p.sinceLaunch < 0.2,
    apex: () => p.airborne && p.vertVel <= 0,
    land: () => p.launched && p.sinceLaunch > 0.05 && !p.airborne,
  }[until];
  let n = 0;
  while (n++ < limit) {
    g.step(1 / 60);
    if (test()) break;
  }
  return {
    hit: n < limit, s: +p.s.toFixed(0), kmh: +p.kmh.toFixed(0),
    height: +p.height.toFixed(2), air: +p.airTime.toFixed(2),
    boom: +(g.chase.air ?? 0).toFixed(2),
    pitch: +(p.airPitch * 180 / Math.PI).toFixed(1),
    squash: +p.squash.toFixed(3),
    scale: +g.timeScale().toFixed(2),
  };
}, [until, arg, limit]);

for (const SEED of SEEDS) {
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    const sites = await page.evaluate(() => {
      const g = window.__game;
      g.setPaused(true);
      return g.track.ramps.map(r => ({ lip: r.lip, pad0: r.pad0, land: r.land }));
    });
    console.log(`\n  seed ${SEED} — ${sites.length} ramps`);

    for (let i = 0; i < sites.length; i++) {
      const r = sites[i];
      await page.evaluate((s) => {
        const g = window.__game;
        g.autopilot(true, 0.85);
        g.driveTo(s / g.track.length, { runUp: 320, maxSec: 45 });
      }, r.pad0 - 46);
      const rows = [];
      for (const [moment, file] of [
        ['pad', 'approach'], ['lip', 'lip'], ['apex', 'apex'], ['land', 'landing'],
      ]) {
        const at = await STEP(page, moment, r.pad0 - 26);
        await capture(page, path.join(outDir, `s${SEED}-r${i}-${file}.png`));
        rows.push([file, at]);
      }
      await page.evaluate(() => window.__game.autopilot(false));
      for (const [file, at] of rows) {
        console.log(`    ${file.padEnd(9)} s ${String(at.s).padStart(5)}  ${String(at.kmh).padStart(3)} km/h`
          + `  h ${at.height.toFixed(2).padStart(5)} m  boom ${at.boom.toFixed(2)}`
          + `  nose ${at.pitch.toFixed(1).padStart(6)}°  squash ${at.squash.toFixed(3).padStart(6)}`
          + `  time x${at.scale.toFixed(2)}${at.hit ? '' : '   MISSED'}`);
      }
    }

    /* A rival in the air. The requirement is explicit and it is a different
       shot: the camera is on the player, so this only works if the player is
       close enough behind to have the rival's flight in frame. */
    const rival = await page.evaluate((lip) => {
      const g = window.__game, p = g.player;
      const e = g.race?.entries?.[0];
      if (!e) return null;
      g.autopilot(true, 0.85);
      g.driveTo((lip - 150) / g.track.length, { runUp: 300, maxSec: 45 });
      /* Put the rival on the ramp and the player just behind it, then let
         both run: the field is stepped by the game loop, so the rival takes
         the jump under its own driver. */
      e.car.placeAt(p.s + 24, 2.0);
      e.car.vx = p.speed; e.car.vy = 0;
      let n = 0, best = null;
      while (n++ < 600) {
        g.step(1 / 60);
        if (e.car.airborne && e.car.height > (best?.h ?? 0)) {
          best = { h: e.car.height, s: +e.car.s.toFixed(0), gap: +(e.car.s - p.s).toFixed(0) };
        }
        if (best && !e.car.airborne && e.car.height < 0.02) break;
      }
      return best;
    }, sites[sites.length - 1].lip);
    if (rival) {
      console.log(`    rival airborne — ${rival.h.toFixed(2)} m up at s ${rival.s}, ${rival.gap} m ahead`);
    }

    /* And the frame itself, taken on the way over rather than after: replay
       the same launch and stop at the rival's apex. */
    const shot = await page.evaluate((lip) => {
      const g = window.__game, p = g.player;
      const e = g.race?.entries?.[0];
      if (!e) return null;
      g.driveTo((lip - 150) / g.track.length, { runUp: 300, maxSec: 45 });
      e.car.placeAt(p.s + 24, 2.0);
      e.car.vx = p.speed; e.car.vy = 0;
      let n = 0, wasUp = false;
      while (n++ < 600) {
        g.step(1 / 60);
        if (e.car.airborne) wasUp = true;
        if (wasUp && e.car.vertVel <= 0) break;
      }
      g.autopilot(false);
      return { h: +e.car.height.toFixed(2), s: +e.car.s.toFixed(0) };
    }, sites[sites.length - 1].lip);
    if (shot) await capture(page, path.join(outDir, `s${SEED}-rival-air.png`));
  });
}

console.log(`\n  → shots/${TAG}`);
finish(process.exitCode || 0);
