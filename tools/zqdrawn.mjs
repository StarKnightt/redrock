/* Is `drawnGroundY` actually the ground that is drawn?
 *
 * The crowd's footing gates used to read `field.point` — an analytic corridor
 * surface that nothing renders. tools/wfeet.mjs showed where that leads: 31 of
 * 173 placed figures standing up to 8.05 m above the nearest mesh, because the
 * landform is the flat-triangle interpolation of `landformPoint` on a ladder
 * 9 m apart along the stage and at apron rungs u = 0, 0.1, 0.25, 0.45, 0.7, 1
 * across it, and a chord under a convex curve sags.
 *
 * `drawnGroundY` claims to reproduce that interpolation. This checks the claim
 * the only way it can be checked — against a ray dropped on the meshes — at
 * the lateral distance the crowd actually stands at, over the whole stage. A
 * model test validated this way is worth keeping; one that is not, is not.
 *
 * Three columns per sample: the model's height, `drawnGroundY`'s, and the ray's.
 * The two error distributions are what matters.
 *
 *   node tools/zqdrawn.mjs [--seeds 22,1,40] [--step 10] [--out 7.4]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');
const STEP = Number(flag('step', '10'));
const OUT = Number(flag('out', '7.4'));

const pct = (rows, key, q) => {
  const v = rows.map(r => Math.abs(r[key])).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : 0;
};

for (const SEED of SEEDS) {
  await run({
    width: 640, height: 360,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    page.setDefaultTimeout(600_000);
    const res = await page.evaluate(([step, outM]) => {
      const g = window.__game;
      const THREE = g.THREE;
      const t = g.track;
      const env = g.scene.getObjectByName('environment') || g.stage.getObjectByName('environment');
      const probe = env?.userData?.crowdProbe;
      if (!probe || !probe.drawnY) return { none: true };

      /* Only the landform ribbons. The road, its supports, the walls and the
         props are all real mesh a ray would happily stop on, and none of them
         is the surface `drawnGroundY` is modelling — including them would let
         a wrong answer be scored against the wrong surface and pass. */
      const targets = [];
      g.stage.updateMatrixWorld(true);
      g.stage.traverse(o => {
        if (!o.isMesh) return;
        let nm = o.name;
        for (let q = o.parent; !nm && q; q = q.parent) nm = q.name;
        if (!/^landform/.test(nm || '')) return;
        targets.push(o);
      });
      const ray = new THREE.Raycaster();
      const down = new THREE.Vector3(0, -1, 0);

      const rows = [];
      let missed = 0;
      for (let s = 40; s < t.length - 20; s += step) {
        for (const side of [-1, 1]) {
          const wall = Math.max(1, probe.wallDist(s, side));
          const u = Math.min(outM / wall, 1);
          const p = probe.point(s, side, u);
          const drawn = probe.drawnY(s, side, u);
          /* From well above, so a surface that sits ABOVE the model point is
             found rather than missed — the error goes both ways and a probe
             that can only see one of them would flatter the answer. */
          ray.far = 900;
          ray.set(new THREE.Vector3(p.x, p.y + 260, p.z), down);
          const hits = ray.intersectObjects(targets, false);
          if (!hits.length) { missed++; continue; }
          /* Starting 260 m up means the first thing hit is often the wall rung
             overhanging the apron, tens or hundreds of metres above the
             shoulder — a probe artefact, and one that showed as a 253 m "error"
             in BOTH columns at the same station, which is how it was spotted.
             The surface in question is the one a spectator would stand on: the
             highest hit that is not above the model point by more than a body's
             clearance, and failing that the lowest hit of all. Both columns are
             scored against the same choice. */
          const hit = hits.find(h => h.point.y <= p.y + 2.5) ?? hits[hits.length - 1];
          rows.push({
            s, side,
            model: +(p.y - hit.point.y).toFixed(2),
            drawn: +(drawn - hit.point.y).toFixed(2),
          });
        }
      }
      return { rows, missed, L: +t.length.toFixed(0) };
    }, [STEP, OUT]);

    if (res.none) { console.log(`  seed ${SEED}: no crowdProbe.drawnY`); return; }
    const r = res.rows;
    const worst = k => r.reduce((a, x) => Math.abs(x[k]) > Math.abs(a[k]) ? x : a, r[0]);
    console.log(`\n══ seed ${SEED}  ${res.L} m — error against a ray on the drawn landform,`
      + ` ${OUT} m off the kerb, every ${STEP} m   (${r.length} samples, ${res.missed} no hit)`);
    for (const k of ['model', 'drawn']) {
      const w = worst(k);
      console.log(`   ${k === 'model' ? 'field.point   ' : 'drawnGroundY  '}`
        + ` median |err| ${pct(r, k, 0.5).toFixed(2)} m`
        + `   p90 ${pct(r, k, 0.9).toFixed(2)} m`
        + `   p99 ${pct(r, k, 0.99).toFixed(2)} m`
        + `   worst ${Math.abs(w[k]).toFixed(2)} m at s=${w.s} side ${w.side}`);
    }
    const over = (k, m) => r.filter(x => x[k] > m).length;
    console.log(`   samples more than 0.6 m ABOVE the drawn ground:`
      + ` field.point ${over('model', 0.6)}`
      + ` (${(100 * over('model', 0.6) / r.length).toFixed(1)}%),`
      + ` drawnGroundY ${over('drawn', 0.6)}`
      + ` (${(100 * over('drawn', 0.6) / r.length).toFixed(1)}%)`);
    console.log();
  });
}
finish(process.exitCode || 0);
