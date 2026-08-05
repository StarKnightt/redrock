/* Three questions the staged captures cannot answer.
 *
 * 1. In an unmodified race, do the three AI rivals actually cross the pads and
 *    leave the ground? Nothing is placed, nothing is teleported: the race runs
 *    and every car's pad crossings, launches, air time and apex are counted.
 * 2. How much of the landing squash is on screen? The spring is reported in
 *    metres; this also projects the body's own offset to pixels, because a
 *    7 cm compression on a car 45 px long is not a compression anyone sees.
 * 3. What does the flight look like WITHOUT the camera's airborne pullback?
 *    chase.air is pinned to zero from outside the module, so the shipped
 *    separation can be compared with the separation the same jump would have
 *    had on the ordinary boom.
 *
 *   node tools/airaudit.mjs [--seed 22]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', flag('seed', '22')).split(',').map(Number);
const W = 1600, H = 900;

for (const SEED of SEEDS) {
await run({ width: W, height: H, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0` }, async ({ page }) => {

  /* ---- 1. the field, in a real race ------------------------------------ */
  const race = await page.evaluate(() => {
    const g = window.__game;
    g.setPaused(true);
    /* The stage from the grid, driven by the same drivers the game ships:
       the player on autopilot, the field on its own. */
    g.goTo(0.004);
    g.race.reset();
    g.resetSimClock();
    g.autopilot(true, 0.85);
    const cars = [{ name: 'player', car: g.player },
      ...(g.race?.entries ?? []).map((e, i) => ({ name: 'rival ' + (i + 1), car: e.car }))];
    const st = cars.map(c => ({
      name: c.name, pads: 0, launches: 0, air: 0, apex: 0, lastS: c.car.s, wasAir: false,
    }));
    const L = g.track.length;
    /* Long enough to get the whole stage in at the pace the race runs. */
    for (let i = 0; i < 60 * 260; i++) {
      g.step(1 / 60);
      for (let k = 0; k < cars.length; k++) {
        const c = cars[k].car, s = st[k];
        if (c.s > s.lastS && c.s - s.lastS < 30 && g.track.padCrossed(s.lastS, c.s)) s.pads++;
        s.lastS = c.s;
        if (c.airborne && !s.wasAir && c.height >= 0) s.launches++;
        if (c.airborne) { s.air += 1 / 60; s.apex = Math.max(s.apex, c.height); }
        s.wasAir = !!c.airborne;
      }
      if (g.player.s > L - 40) break;
    }
    return {
      ramps: g.track.ramps.length,
      rows: st.map(s => ({ name: s.name, pads: s.pads, launches: s.launches,
        air: +s.air.toFixed(2), apex: +s.apex.toFixed(2) })),
    };
  });
  console.log(`\n  seed ${SEED} — ${race.ramps} ramps, one full race`);
  console.log('    car        pads crossed   times airborne   total air   best apex');
  for (const r of race.rows) {
    console.log(`    ${r.name.padEnd(10)} ${String(r.pads).padStart(12)} ${String(r.launches).padStart(16)}`
      + ` ${(r.air.toFixed(2) + 's').padStart(11)} ${(r.apex.toFixed(2) + ' m').padStart(11)}`);
  }

  /* ---- 2 and 3. the same jump, shipped camera and pinned camera -------- */
  const fly = async (pin) => page.evaluate((pin) => {
    const g = window.__game, p = g.player, track = g.track;
    if (pin) Object.defineProperty(g.chase, 'air',
      { get: () => 0, set: () => {}, configurable: true });
    if (g.race?.entries) g.race.entries.length = 0;
    const r = track.ramps[Math.min(1, track.ramps.length - 1)];
    g.autopilot(true, 0.85);
    g.driveTo((r.pad0 - 60) / track.length, { runUp: 320, maxSec: 45 });
    const px = v => { const q = v.clone().project(g.camera);
      return { x: (q.x * 0.5 + 0.5) * 1600, y: (-q.y * 0.5 + 0.5) * 900 }; };
    let n = 0, wasAir = false, best = null, squash = 0, squashPx = 0, bounces = 0;
    let prev = 0, dir = 0;
    while (n++ < 900) {
      g.step(1 / 60);
      if (p.airborne) wasAir = true;
      if (wasAir) {
        const up = track.frameAt(p.s).up;
        const car = px(p.pos), gnd = px(p.pos.clone().addScaledVector(up, -p.height));
        const nose = px(p.pos.clone().addScaledVector(p.forward, 2.05));
        const tail = px(p.pos.clone().addScaledVector(p.forward, -2.05));
        const len = Math.hypot(nose.x - tail.x, nose.y - tail.y);
        const sep = gnd.y - car.y;
        if (!best || sep > best.sep) {
          best = { sep: +sep.toFixed(1), len: +len.toFixed(1), h: +p.height.toFixed(2),
            boom: +g.camera.position.distanceTo(p.pos).toFixed(1), fov: +g.camera.fov.toFixed(1) };
        }
        /* The squash, in metres and in the pixels it actually moves the body:
           the same 1 m of world scaled by the projection at this distance. */
        if (Math.abs(p.squash) > Math.abs(squash)) {
          squash = p.squash;
          const a = px(p.pos), b = px(p.pos.clone().addScaledVector(up, Math.abs(p.squash)));
          squashPx = Math.abs(b.y - a.y);
        }
        const d = Math.sign(p.squash - prev);
        if (d && dir && d !== dir) bounces++;
        if (d) dir = d;
        prev = p.squash;
      }
      if (wasAir && !p.airborne && n > 400) break;
    }
    g.autopilot(false);
    return { ...best, squash: +squash.toFixed(3), squashPx: +squashPx.toFixed(1), bounces };
  }, pin);

  const shipped = await fly(false);
  console.log(`\n    shipped camera   apex ${shipped.h} m -> ${shipped.sep} px of separation`
    + `   car ${shipped.len} px long   boom ${shipped.boom} m   fov ${shipped.fov}`);
  console.log(`    landing squash ${(shipped.squash * 100).toFixed(1)} cm = ${shipped.squashPx} px of body travel`
    + `   direction changes in the spring: ${shipped.bounces}`);
  const pinned = await fly(true);
  console.log(`    pullback off     apex ${pinned.h} m -> ${pinned.sep} px of separation`
    + `   car ${pinned.len} px long   boom ${pinned.boom} m   fov ${pinned.fov}`);
  console.log(`    => the pullback costs ${(100 * (1 - shipped.sep / pinned.sep)).toFixed(0)}% of the separation`
    + ` and ${(100 * (1 - shipped.len / pinned.len)).toFixed(0)}% of the car`);
});
}
finish(process.exitCode || 0);
