/* AUDIT PROBE (round 2) — is it drawnGroundY that is wrong, or landformPoint?
 *
 * tools/kcblock.mjs puts the geometry that hides seed 40's s=4150 site at
 * 0.7–7 m off the road edge and 2.3–3.3 m above it, on an up-facing 44° face,
 * across sixty metres of the approach — and `drawnGroundY` reads the same
 * (station, offset) as flat, within a quarter of a metre of road level. One of
 * three things is true and this separates them:
 *
 *   a) `landformPoint` — the ladder both `drawnGroundY` and `buildLandform`
 *      are supposed to be built from — has the bank, and `drawnGroundY`'s row
 *      indexing or lateral interpolation loses it;
 *   b) `landformPoint` does not have the bank either, and `buildLandform`
 *      draws something the ladder does not describe;
 *   c) the drawn mesh folds over itself, so there are two surfaces at the same
 *      (x, z) and `drawnGroundY` faithfully reports the lower one.
 *
 * So: the ladder rung by rung at the blocking stations, `drawnGroundY` at the
 * same offsets, and every `landform--1` intersection of a vertical line through
 * the same points. Also printed: `field.ss` against the uniform TERRAIN_STEP
 * ladder that `drawnGroundY` indexes by, since that index is computed as
 * floor(s / TERRAIN_STEP) and trusts the array to match.
 *
 *   node tools/kcladder.mjs [--seed 40] [--from 4090] [--to 4160] [--step 4]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '40');
const FROM = Number(flag('from', '4090'));
const TO = Number(flag('to', '4160'));
const STEP = Number(flag('step', '4'));
const SIDE = Number(flag('side', '-1'));

await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  const res = await page.evaluate(([from, to, step, side]) => {
    const g = window.__game;
    const THREE = g.THREE;
    const t = g.track;
    const env = g.scene.getObjectByName('environment');
    const probe = env.userData.crowdProbe;
    const lp = env.userData.landformPoint;
    const field = env.userData.field;

    const skip = /sky-dome|sun-disc|ocean-bands|shore-foam|block-clouds|bird|crowd/i;
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
    const stack = (x, z) => {
      ray.far = 1400;
      ray.set(new THREE.Vector3(x, 600, z), new THREE.Vector3(0, -1, 0));
      return ray.intersectObjects(targets, false).map(h => ({
        y: +h.point.y.toFixed(2), what: h.object.userData.__probeName,
        up: h.face ? h.face.normal.clone().applyMatrix3(
          new THREE.Matrix3().getNormalMatrix(h.object.matrixWorld)).normalize().y > 0 : null,
      }));
    };

    /* field.ss against the ladder drawnGroundY indexes by. */
    const ss = [];
    for (let i = 0; i < Math.min(field.count, 6); i++) ss.push(+field.ss[i].toFixed(2));
    const stepGuess = field.count > 1 ? field.ss[1] - field.ss[0] : null;
    const iAt = Math.floor((from + to) * 0.5 / stepGuess);
    const ssCheck = {
      count: field.count, first: ss, stepGuess: +stepGuess.toFixed(3),
      uniform: (() => {
        let worst = 0;
        for (let i = 0; i < field.count; i++) {
          worst = Math.max(worst, Math.abs(field.ss[i] - i * stepGuess));
        }
        return +worst.toFixed(4);
      })(),
      probeIndex: iAt, ssAtIndex: +field.ss[iAt].toFixed(2),
    };

    const rows = [];
    for (let s = from; s <= to; s += step) {
      const f = t.frameAt(s);
      const edgeY = f.pos.y - 0.5;                 // EDGE_DROP = -0.5
      const wall = probe.wallDist(s, side);
      const rungs = [];
      for (let c = 0; c < 6; c++) {
        const p = lp(s, side, c);
        const lat = Math.abs((p.x - f.pos.x) * f.flatRight.x + (p.z - f.pos.z) * f.flatRight.z);
        rungs.push({
          c, out: +(lat - f.width / 2).toFixed(2), y: +p.y.toFixed(2),
          above: +(p.y - edgeY).toFixed(2),
        });
      }
      const cols = [];
      for (const m of [0, 1, 2, 4, 6, 8, 12, 16, 20]) {
        const u = m / wall;
        const p = probe.point(s, side, u);
        const st = stack(p.x, p.z).filter(h => /landform/.test(h.what));
        cols.push({
          m, drawnAbove: +(probe.drawnY(s, side, u) - edgeY).toFixed(2),
          modelAbove: +(p.y - edgeY).toFixed(2),
          hits: st.map(h => ({ above: +(h.y - edgeY).toFixed(2), up: h.up })),
        });
      }
      rows.push({ s: +s.toFixed(1), edgeY: +edgeY.toFixed(2), wall: +wall.toFixed(1), rungs, cols });
    }
    return { ssCheck, rows, side };
  }, [FROM, TO, STEP, SIDE]);

  console.log(`\n  seed ${SEED}, side ${res.side} — heights are metres ABOVE THE ROAD EDGE.`);
  const c = res.ssCheck;
  console.log(`\n  field.ss: ${c.count} rows, first ${JSON.stringify(c.first)},`
    + ` spacing ${c.stepGuess} m, worst departure from a uniform ladder ${c.uniform} m`
    + `  (drawnGroundY indexes with floor(s / TERRAIN_STEP), so this must be 0)`);

  for (const r of res.rows) {
    console.log(`\n  s=${r.s}  road edge y ${r.edgeY}, corridor ${r.wall} m`);
    console.log(`    landformPoint ladder: `
      + r.rungs.map(g2 => `c${g2.c}@${g2.out}m=${g2.above}`).join('  '));
    console.log('     m out   drawnGroundY   field.point   every landform surface a vertical line crosses');
    for (const col of r.cols) {
      console.log(`    ${String(col.m).padStart(6)}  ${String(col.drawnAbove).padStart(12)}`
        + `  ${String(col.modelAbove).padStart(12)}   `
        + col.hits.map(h => `${h.above}${h.up ? '^' : 'v'}`).join('  '));
    }
  }
  const jf = path.join(ROOT, '.meas', 'r2', `kcladder-${SEED}.json`);
  fs.mkdirSync(path.dirname(jf), { recursive: true });
  fs.writeFileSync(jf, JSON.stringify(res, null, 1));
  console.log('\n  ^ = up-facing surface, v = an underside.  json → ' + jf + '\n');
});
finish(process.exitCode || 0);
