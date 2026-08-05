/* Does the field drive the tunnel, or survive it?
 *
 * A whole-stage race report says nobody got stuck somewhere, which is not the
 * same as saying nobody got stuck here. This runs the field and records every
 * car's line and speed while it is between the portals, plus any contact or
 * recovery that happens inside them, so "the AI drives it correctly" has a
 * lateral offset and a speed behind it.
 *
 *   node tools/tunneldrive.mjs [--seeds 22,1,12] [--secs 300]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,12').split(',');
const SECS = Number(flag('secs', '300'));

for (const seed of SEEDS) {
  await run({
    width: 320, height: 200,
    hash: `manual&tier=high&seed=${seed}&cap=60&hud=0`,
  }, async ({ page }) => {
    const out = await page.evaluate(async secs => {
      const g = window.__game;
      const span = g.field.tunnel;
      const race = g.race;
      /* Wake the race the way tools/race.mjs does: one braked step to find out
         whether the main loop already drives it, then autopilot the player and
         put everyone back on the grid. */
      g.botInput = { steer: 0, throttle: 0, brake: 1, handbrake: 0 };
      g.step(1 / 60);
      const wired = race._clock > 0;
      race.reset();
      g.botInput = null;
      g.autopilot(true, 0.85);
      g.bot.wobble = 5;
      const p0 = g.player;
      p0.placeAt(34, 0); p0.vx = 0; p0.vy = 0; p0.r = 0;
      p0.raceTime = 0; p0.finished = false;
      const cars = [g.player, ...race.entries.map(e => e.car)]
        .filter((c, i, a) => c && a.indexOf(c) === i);
      const log = new Map();
      let collisions0 = race ? race.collisions : 0;
      let insideCollisions = 0, insideRecoveries = 0;
      /* A control window of the same length on open road, immediately after
         the bore. Contacts inside a tunnel only mean something against a
         baseline: the car is held by a containment wall at half a road width
         plus 1.05 m that exists at every station on the stage, and the bore
         wall sits 1.30 m outside that, so a rub in here should happen at the
         same rate as a rub anywhere. This is the number that says whether it
         does. */
      const ctrl0 = span.s1 + 30, ctrl1 = ctrl0 + (span.s1 - span.s0);
      let ctrlCollisions = 0, ctrlRecoveries = 0;
      const dt = 1 / 60;
      for (let n = 0; n < secs * 60; n++) {
        g.step(dt);
        if (!wired) race.step(dt, g.player);
        for (const p of cars) {
          if (p.strandedFor > 2.5) {
            if (p.s > span.s0 - 10 && p.s < span.s1 + 10) insideRecoveries++;
            if (p.s > ctrl0 && p.s < ctrl1) ctrlRecoveries++;
            p.recover();
          }
          if (p.s < span.s0 || p.s > span.s1) continue;
          const f = g.track.frameAt(p.s);
          const dx = p.pos.x - f.pos.x, dz = p.pos.z - f.pos.z;
          const lat = dx * f.flatRight.x + dz * f.flatRight.z;
          const name = p === g.player ? 'PLAYER' : (p.name || p.livery || 'RIVAL');
          const rec = log.get(name)
            || { n: 0, lat: 0, absMax: 0, vmin: 1e9, vmax: 0, edge: 0, halfMin: 99 };
          rec.n++;
          rec.lat += lat;
          rec.absMax = Math.max(rec.absMax, Math.abs(lat));
          const v = p.speed !== undefined ? p.speed : p.vel.length();
          rec.vmin = Math.min(rec.vmin, v);
          rec.vmax = Math.max(rec.vmax, v);
          // How close the widest wheel line came to the bore wall.
          const clear = (f.width * 0.5 + 2.35) - Math.abs(lat) - 1.0;
          rec.halfMin = Math.min(rec.halfMin, clear);
          if (Math.abs(lat) > f.width * 0.5) rec.edge++;
          log.set(name, rec);
        }
        if (race && race.collisions > collisions0) {
          const d = race.collisions - collisions0;
          if (cars.some(p => p.s > span.s0 - 10 && p.s < span.s1 + 10)) insideCollisions += d;
          if (cars.some(p => p.s > ctrl0 && p.s < ctrl1)) ctrlCollisions += d;
          collisions0 = race.collisions;
        }
        if (cars.every(p => p.s > ctrl1 + 60)) break;
      }
      return {
        span: [Math.round(span.s0), Math.round(span.s1)],
        insideCollisions, insideRecoveries,
        ctrlCollisions, ctrlRecoveries,
        ctrl: [Math.round(ctrl0), Math.round(ctrl1)],
        rows: [...log].map(([k, v]) => `${k.padEnd(8)}`
          + ` samples ${String(v.n).padStart(4)}`
          + `  mean lat ${(v.lat / v.n).toFixed(2)} m`
          + `  worst |lat| ${v.absMax.toFixed(2)} m`
          + `  wall clearance ${v.halfMin.toFixed(2)} m`
          + `  speed ${(v.vmin * 3.6).toFixed(0)}-${(v.vmax * 3.6).toFixed(0)} km/h`
          + `  off-tarmac frames ${v.edge}`),
      };
    }, SECS);
    console.log(`\n  seed ${seed}  bore ${out.span[0]}-${out.span[1]} m`);
    out.rows.forEach(r => console.log('    ' + r));
    console.log(`    inside the bore: ${out.insideCollisions} contact(s),`
      + ` ${out.insideRecoveries} recovery(ies)`);
    console.log(`    open road ${out.ctrl[0]}-${out.ctrl[1]} m for comparison:`
      + ` ${out.ctrlCollisions} contact(s), ${out.ctrlRecoveries} recovery(ies)`);
  });
}
finish(process.exitCode || 0);
