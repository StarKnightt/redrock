/* What the stage looks like as a function of arc length, so shot windows can
 * be scored against the world and not only against the car's telemetry.
 *
 * CAPTURE-ONLY. Nothing here steps the simulation or writes to the world; it
 * builds one page per seed, samples the track and coast helpers the world
 * already exposes, and exits. No lap is driven, so this costs a second a seed.
 *
 *   node tools/reelworld.mjs [--seeds 22,1,40]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',').map(Number);
const STEP = +flag('step', 6);
const OUT = path.join(ROOT, 'out', 'reel', 'scout');

fs.mkdirSync(OUT, { recursive: true });

const PROFILE = ([step]) => {
  const g = window.__game;
  const t = g.track;
  const coast = g.coast;
  const rows = [];
  for (let s = 0; s <= t.length; s += step) {
    const f = t.frameAt(s);
    const shore = coast ? coast.shoreDistanceAt(s) : NaN;
    const water = coast ? coast.waterDistanceAt(s) : NaN;
    rows.push([
      s,
      +f.pos.y.toFixed(1),
      +(f.curv * 1000).toFixed(2),        // 1/km, signed
      +f.width.toFixed(1),
      +((f.bank * 180) / Math.PI).toFixed(1),
      Number.isFinite(shore) ? +shore.toFixed(0) : -1,
      Number.isFinite(water) ? +water.toFixed(0) : -1,
      coast ? coast.seaSideAt(s) : 0,
    ]);
  }
  /* Every named thing standing beside the road, projected back onto the
     centreline, so "is there a lighthouse in this shot" is answerable. The
     stage is a flat list of groups with names set by environment.js. */
  const marks = [];
  const V = new g.THREE.Vector3();
  const seen = new Map();
  g.stage.traverse(o => {
    if (!o.name || o.isMesh === false) { /* keep walking */ }
    if (!o.name) return;
    if (!/light|bridge|turbine|wind|tower|beacon|pier|jetty|arch|mast/i.test(o.name)) return;
    o.getWorldPosition(V);
    const n = (seen.get(o.name) || 0) + 1;
    seen.set(o.name, n);
    if (n > 40) return;
    marks.push({ name: o.name, x: +V.x.toFixed(0), y: +V.y.toFixed(0), z: +V.z.toFixed(0) });
  });
  return { length: +t.length.toFixed(1), step, rows, marks, names: [...seen.keys()] };
};

for (const SEED of SEEDS) {
  await run({
    width: 640, height: 360, begin: false,
    hash: `manual&tier=low&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    const d = await page.evaluate(PROFILE, [STEP]);
    fs.writeFileSync(path.join(OUT, `world-${SEED}.json`), JSON.stringify(d));
    const coastal = d.rows.filter(r => r[5] >= 0 && r[5] < 140).length / d.rows.length;
    console.log(`  seed ${SEED}  ${d.length} m   coastal(<140 m to shore) ${(coastal * 100).toFixed(0)}%`
      + `   landmark meshes: ${d.names.join(', ') || 'none matched'}`);
  });
}

finish(process.exitCode || 0);
