/* Where along the stage is the crowd's ground plane a fiction?
 *
 * Every gate in the crowd build stands on `field.point(s, side, u)`, an
 * analytic corridor surface. It is not a mesh. Beside the finish on seed 22
 * the drawn stage under that surface is the basin floor fifteen metres below
 * it and the road is on supports, so a group placed by the model is placed in
 * the air — which is D2, and which the lip test cannot catch because that
 * test compares the model against itself.
 *
 * This walks the whole stage at the crowd's own standing distance, drops a
 * ray from just above the model surface, and reports the drop to the first
 * real mesh. Positive `drop` is how far a spectator placed there would be
 * standing above anything that is drawn.
 *
 *   node tools/wground.mjs [--seed 22] [--step 10] [--out 7.4]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22').split(',');
const STEP = Number(flag('step', '10'));
const OUT = Number(flag('out', '7.4'));

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
      if (!probe) return { none: true };

      const skip = /sky-dome|sun-disc|ocean-bands|shore-foam|block-clouds|bird|beam|foam|crowd/i;
      const targets = [];
      g.stage.updateMatrixWorld(true);
      g.stage.traverse(o => {
        if (!o.isMesh) return;
        let nm = o.name;
        for (let q = o.parent; !nm && q; q = q.parent) nm = q.name;
        if (skip.test(nm || '')) return;
        o.userData.__probeName = nm || '(unnamed)';
        targets.push(o);
      });
      const ray = new THREE.Raycaster();
      const down = new THREE.Vector3(0, -1, 0);

      const rows = [];
      for (let s = 40; s < t.length - 20; s += step) {
        for (const side of [-1, 1]) {
          const wall = Math.max(1, probe.wallDist(s, side));
          const p = probe.point(s, side, Math.min(outM / wall, 1));
          ray.far = 400;
          ray.set(new THREE.Vector3(p.x, p.y + 1.5, p.z), down);
          const hit = ray.intersectObjects(targets, false)[0];
          rows.push({
            s, side,
            drop: hit ? +(p.y - hit.point.y).toFixed(2) : 999,
            what: hit ? hit.object.userData.__probeName : 'nothing at all',
          });
        }
      }
      return { rows, L: +t.length.toFixed(0) };
    }, [STEP, OUT]);

    if (res.none) { console.log('  no crowdProbe'); return; }
    const bad = res.rows.filter(r => r.drop > 1.0);
    console.log(`\n══ seed ${SEED}  ${res.L} m — the model's ground vs the drawn stage,`
      + ` ${OUT} m off the kerb, every ${STEP} m`);
    console.log(`   stations sampled: ${res.rows.length}`);
    console.log(`   more than 1 m of air under the model surface: ${bad.length}`
      + `  (${(100 * bad.length / res.rows.length).toFixed(1)}%)`);
    const byWhat = {};
    for (const r of res.rows) byWhat[r.what] = (byWhat[r.what] || 0) + 1;
    console.log('   what the model surface is actually sitting on:');
    for (const [k, v] of Object.entries(byWhat).sort((a, b) => b[1] - a[1])) {
      console.log(`      ${String(v).padStart(5)}  ${k}`);
    }
    // Contiguous runs of air, per side.
    for (const side of [-1, 1]) {
      const mine = res.rows.filter(r => r.side === side);
      const runs = [];
      let cur = null;
      for (const r of mine) {
        if (r.drop > 1.0) {
          if (!cur) cur = { s0: r.s, worst: 0, what: r.what };
          cur.s1 = r.s;
          if (r.drop > cur.worst) { cur.worst = r.drop; cur.what = r.what; }
        } else if (cur) { runs.push(cur); cur = null; }
      }
      if (cur) runs.push(cur);
      runs.sort((a, b) => (b.s1 - b.s0) - (a.s1 - a.s0));
      console.log(`   side ${side}: ${runs.length} stretches with air under the model surface,`
        + ` longest first`);
      for (const r of runs.slice(0, 8)) {
        console.log(`      s ${String(r.s0).padStart(5)}–${String(r.s1).padStart(5)}`
          + ` (${String(r.s1 - r.s0 + STEP).padStart(4)} m)   worst drop ${r.worst} m   onto ${r.what}`);
      }
    }
    console.log();
  });
}
finish(process.exitCode || 0);
