/* Does roadPoint land on the road mesh's own vertices?
 *
 * The paint is built from roadPoint and measured 20 mm under the tarmac, which
 * is only possible if the two disagree. This compares them at the one place
 * they must agree exactly — the lattice points the mesh is made of — with lift
 * zero, so any difference is the construction and not the interpolation.
 *
 *   node tools/latticecheck.mjs [--seed 22]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', 22);

await run({ width: 480, height: 270, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0` },
  async ({ page }) => {
    const out = await page.evaluate(async () => {
      const THREE = await import('three');
      const t = await import('/src/world/track.js');
      const g = window.__game;
      const road = g.scene.getObjectByName('road');
      const pos = road.geometry.getAttribute('position');
      const COLUMNS = 11;
      const v = new THREE.Vector3(), p = new THREE.Vector3();
      const rows = [];
      let worst = 0;
      for (let i = 40; i < g.track.count - 40; i += 37) {
        for (let c = 0; c < COLUMNS; c += 3) {
          v.fromBufferAttribute(pos, i * COLUMNS + c);
          const lat = (c / (COLUMNS - 1) - 0.5) * 2;
          p.copy(t.roadPointForProbe(g.track, g.track.frames[i].s, lat, 0));
          const d = p.distanceTo(v) * 1000;
          if (d > worst) { worst = d; }
          if (rows.length < 12) {
            rows.push({
              i, c, lat: +lat.toFixed(2), mm: +d.toFixed(2),
              dy: +((p.y - v.y) * 1000).toFixed(2),
            });
          }
        }
      }
      return { worst: +worst.toFixed(2), rows };
    });
    console.log('  roadPoint against the road mesh at its own lattice points');
    console.log('      row   col     lat   distance mm   Δy mm');
    for (const r of out.rows) {
      console.log(`  ${String(r.i).padStart(7)} ${String(r.c).padStart(5)}`
        + ` ${r.lat.toFixed(2).padStart(7)} ${r.mm.toFixed(2).padStart(13)}`
        + ` ${r.dy.toFixed(2).padStart(7)}`);
    }
    console.log(`  worst anywhere sampled: ${out.worst} mm`);
  });

finish(process.exitCode || 0);
