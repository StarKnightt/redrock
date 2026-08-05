/* How far above the road is the paint, in millimetres?
 *
 * The pixel test says how much of the pad is lost; it cannot say by how much,
 * and "lost" and "lost by 2 mm" want different fixes. This raycasts the road
 * mesh itself — the real triangles, through Three's own Raycaster — straight
 * down onto it from just above every vertex of the pad mesh and every quad
 * centre, and reports the clearance. Negative is under the tarmac.
 *
 * Vertices and centres both, because a quad whose four corners are all above
 * the surface can still chord under the middle of it, which is the whole family
 * of defects this measures.
 *
 *   node tools/padclear.mjs [--seeds 22,40]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,40').split(',').map(Number);

for (const SEED of SEEDS) {
  await run({ width: 480, height: 270, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0` },
    async ({ page }) => {
      const out = await page.evaluate(async () => {
        const THREE = await import('three');
        const g = window.__game;
        const road = g.scene.getObjectByName('road');
        const targets = ['ramp-pad', 'ramp-signs']
          .map(n => g.scene.getObjectByName(n)).filter(Boolean);
        if (!road || !targets.length) return { err: 'missing road or ramp-pad' };

        const ray = new THREE.Raycaster();
        ray.far = 6;
        const down = new THREE.Vector3(0, -1, 0);
        const from = new THREE.Vector3();
        /* Clearance of one world point: drop a ray from 2 m above it and see
           how far short of it the road is. */
        const clearOf = (p) => {
          from.set(p.x, p.y + 2, p.z);
          ray.set(from, down);
          const hit = ray.intersectObject(road, false)[0];
          /* The ray starts 2 m up, so it travels 2 m plus however far the point
             is above the surface before it arrives. Positive is above. */
          return hit ? (hit.distance - 2) * 1000 : null;
        };

        /* Control: road vertices measured against the road. Anything other than
           zero here is the instrument, not the paint. */
        const rpos = road.geometry.getAttribute('position');
        const cv = new THREE.Vector3();
        const ctl = [];
        for (let i = 0; i < rpos.count; i += Math.max(1, Math.floor(rpos.count / 400))) {
          cv.fromBufferAttribute(rpos, i);
          road.localToWorld(cv);
          const d = clearOf(cv);
          if (d !== null) ctl.push(d);
        }
        ctl.sort((a, b) => a - b);

        const report = {};
        for (const mesh of targets) {
          if (mesh.name !== 'ramp-pad') continue;
          const pos = mesh.geometry.getAttribute('position');
          const c = new THREE.Vector3(), v = new THREE.Vector3();
          const mm = [];
          let worstQuad = null;
          for (let i = 0; i + 3 < pos.count; i += 4) {
            c.set(0, 0, 0);
            for (let k = 0; k < 4; k++) {
              v.fromBufferAttribute(pos, i + k);
              mesh.localToWorld(v);
              c.addScaledVector(v, 0.25);
              const d = clearOf(v);
              if (d !== null) mm.push(d);
            }
            const dc = clearOf(c);
            if (dc !== null) {
              mm.push(dc);
              if (!worstQuad || dc < worstQuad.mm) worstQuad = { mm: +dc.toFixed(1), quad: i / 4 };
            }
          }
          mm.sort((a, b) => a - b);
          const at = q => +mm[Math.floor(q * (mm.length - 1))].toFixed(1);
          report[mesh.name] = {
            samples: mm.length, min: at(0), p01: at(0.01), p10: at(0.1),
            median: at(0.5), max: at(1),
            under: +(mm.filter(x => x < 0).length / mm.length * 100).toFixed(2),
            thin: +(mm.filter(x => x < 5).length / mm.length * 100).toFixed(2),
            worstQuad,
          };
        }
        return {
          seed: g.track.seed, report,
          control: ctl.length ? {
            n: ctl.length, min: +ctl[0].toFixed(1),
            median: +ctl[Math.floor(ctl.length / 2)].toFixed(1),
            max: +ctl[ctl.length - 1].toFixed(1),
          } : null,
        };
      });

      if (out.err) { console.log('  ' + out.err); return; }
      console.log(`\n  seed ${out.seed} — paint clearance above the road, mm`);
      if (out.control) {
        console.log(`  control, road vertices against the road itself:`
          + ` ${out.control.n} samples, min ${out.control.min}`
          + `  median ${out.control.median}  max ${out.control.max}`);
      }
      for (const [name, r] of Object.entries(out.report)) {
        console.log(`  ${name}: ${r.samples} samples`);
        console.log(`     min ${r.min}   1st pct ${r.p01}   10th ${r.p10}`
          + `   median ${r.median}   max ${r.max}`);
        console.log(`     under the tarmac ${r.under}%   under 5 mm of clearance ${r.thin}%`
          + `   worst quad #${r.worstQuad?.quad} at ${r.worstQuad?.mm} mm`);
      }
    });
}

finish(process.exitCode || 0);
