/* Where the chase lens actually is, in the road's own coordinates.
 *
 * `crowdSeen` in src/world/environment.js marches its sightline from an eye at
 * (s - 15, offset 0, EDGE_DROP + 2.55). Two of those three numbers are
 * assumptions about a rig that has a boom which lengthens with speed, lifts on
 * air and dodges terrain, and the third — the station — ignores the boom
 * entirely: when the PLAYER is fifteen metres short of a group, the LENS is a
 * boom length further back than that, and a sightline that starts further back
 * runs flatter and is eclipsed by more of the berm.
 *
 * This measures the real thing: for a spread of stations on each seed, drive
 * the car in on autopilot and express g.camera.position in (station, metres
 * from the road edge on each side, metres above the road edge). No pixels
 * here, no judgement — just the three numbers crowdSeen guesses at.
 *
 *   node tools/zqlens.mjs [--seeds 22,1,40]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');

const all = [];

for (const SEED of SEEDS) {
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    const out = await page.evaluate(() => {
      const g = window.__game;
      const t = g.track;
      const EDGE_DROP = g.EDGE_DROP ?? null;
      g.setPaused(true);
      g.autopilot(true, 0.85);
      const rows = [];
      const fracs = [0.04, 0.14, 0.24, 0.36, 0.48, 0.6, 0.72, 0.84, 0.93, 0.985];
      for (const fr of fracs) {
        const target = fr * t.length;
        g.goTo(Math.max(0, target - 200) / t.length);
        g.warp(0.75);
        for (let k = 0; k < 400 && g.player.s < target; k++) g.step(1 / 60);
        const cam = g.camera.position.clone();
        /* Station of the lens: the centreline point nearest it. Searched over
           a window around the player rather than the whole loop, because the
           stage folds back on itself and a global search on a switchback
           returns the road one tier up. */
        let bs = g.player.s, bd = Infinity;
        for (let s = g.player.s - 60; s <= g.player.s + 10; s += 0.25) {
          if (s < 0 || s > t.length) continue;
          const f = t.frameAt(s);
          const d = Math.hypot(cam.x - f.pos.x, cam.z - f.pos.z);
          if (d < bd) { bd = d; bs = s; }
        }
        const f = t.frameAt(bs);
        // Signed lateral offset, in the frame's own right vector.
        const rx = cam.x - f.pos.x, rz = cam.z - f.pos.z;
        const lat = rx * f.right.x + rz * f.right.z;
        rows.push({
          playerS: +g.player.s.toFixed(1),
          kmh: +g.player.kmh.toFixed(0),
          lensS: +bs.toFixed(1),
          behind: +(g.player.s - bs).toFixed(1),
          lat: +lat.toFixed(2),
          aboveCentre: +(cam.y - f.pos.y).toFixed(2),
          width: +f.width.toFixed(1),
        });
      }
      g.autopilot(false);
      return { rows, EDGE_DROP };
    });

    console.log(`\n══ seed ${SEED}`);
    console.log('   player s    km/h   lens s   behind    lateral   above centreline');
    for (const r of out.rows) {
      console.log(`   ${String(r.playerS).padStart(8)}  ${String(r.kmh).padStart(5)}`
        + `  ${String(r.lensS).padStart(7)}  ${String(r.behind).padStart(6)} m`
        + `  ${String(r.lat).padStart(8)} m  ${String(r.aboveCentre).padStart(8)} m`);
      all.push(r);
    }
  });
}

const nums = k => all.map(r => r[k]).sort((a, b) => a - b);
const stat = k => {
  const a = nums(k);
  return `${a[0].toFixed(2)} … ${a[a.length - 1].toFixed(2)}  (median ${a[a.length >> 1].toFixed(2)})`;
};
console.log(`\n  ACROSS ALL SEEDS AND STATIONS`);
console.log(`    boom, metres of station behind the player:  ${stat('behind')}`);
console.log(`    lateral offset from the centreline:         ${stat('lat')}`);
console.log(`    height above the centreline:                ${stat('aboveCentre')}`);
console.log(`\n  crowdSeen assumes: behind 0 m, lateral 0 m, EDGE_DROP + 2.55 above the centreline\n`);
finish(process.exitCode || 0);
