/* What is actually under the inland shoulder past the basin share.
 *
 * `crowdStand` refuses side +1 past `BASIN_SHARE_FROM` because the landform
 * ribbon is not built there and the corridor `field.point` it would otherwise
 * trust is fiction. That refusal is right about the corridor; the question this
 * asks is whether there is a DIFFERENT real surface a spectator could stand on
 * instead, and how far below the road it is — because on one seed those are the
 * only metres near the finish line that are not behind a berm.
 *
 * A downward ray per sample, against the drawn meshes, plus the sightline from
 * the modelled lens to a chest standing on whatever it finds.
 *
 *   node tools/zwbasin.mjs [--seeds 40] [--before 40] [--after 30]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '40').split(',');
const OUTS = flag('outs', '6,9,12,16,22').split(',').map(Number);
const BEFORE = +flag('before', 40);
const AFTER = +flag('after', 30);
const TAG = flag('tag', 'zwbasin');

const lines = [];
const say = s => { console.log(s); lines.push(s); };
const all = [];

for (const SEED of SEEDS) {
  await run({
    width: 320, height: 200,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    const r = await page.evaluate(({ OUTS, BEFORE, AFTER }) => {
      const THREE = window.__game.THREE;
      const g = window.__game, t = g.track;
      const P = g.scene.getObjectByName('environment').userData.crowdProbe;
      const L = t.length, LINE = P.line;
      const blockers = P.blockers();
      const ray = new THREE.Raycaster();
      const down = new THREE.Vector3(0, -1, 0);
      const rows = [];
      for (let s = LINE - BEFORE; s <= Math.min(LINE + AFTER, L - 2); s += 4) {
        const f = t.frameAt(s);
        const edge = f.pos.y - 0.5;
        for (const side of [-1, 1]) {
          const wall = P.wallDist(s, side);
          for (const outM of OUTS) {
            const u = outM / wall;
            if (u > 0.98) continue;
            const at = P.point(s, side, u);
            /* Straight down from well above, so the first hit is the top
               surface at these coordinates whatever the corridor thinks. */
            ray.set(new THREE.Vector3(at.x, at.y + 60, at.z), down);
            ray.near = 0; ray.far = 200;
            const hit = ray.intersectObjects(blockers, false);
            if (!hit.length) {
              rows.push({ rel: +(s - LINE).toFixed(0), side, outM, ground: null });
              continue;
            }
            const gy = hit[0].point.y;
            const chest = new THREE.Vector3(at.x, gy + 0.95, at.z);
            /* And can it be seen: the nearest and the farthest approach
               station, from the measured lens height over the road edge. */
            const sight = [50, 14].map(back => {
              const s0 = s - back - 11;
              if (s0 < 4) return 'n/a';
              const lf = t.frameAt(s0);
              const from = new THREE.Vector3(lf.pos.x, lf.pos.y - 0.5 + 3.9, lf.pos.z);
              const dir = chest.clone().sub(from);
              const d = dir.length();
              ray.set(from, dir.normalize());
              ray.near = 0.4; ray.far = d - 0.5;
              const h2 = ray.intersectObjects(blockers, false);
              return h2.length ? (h2[0].object.name || '?') : 'clear';
            });
            rows.push({
              rel: +(s - LINE).toFixed(0), side, outM,
              ground: hit[0].object.name || '(unnamed)',
              gy: +gy.toFixed(2),
              belowEdge: +(edge - gy).toFixed(2),
              model: +(at.y - gy).toFixed(2),
              sight,
            });
          }
        }
      }
      return { L: +L.toFixed(0), LINE, blockers: blockers.length, rows };
    }, { OUTS, BEFORE, AFTER });

    say(`\n══ seed ${SEED} ══  L=${r.L} line=${r.LINE}  ${r.blockers} blockers`);
    say('    rel side  out  ground            below-edge  model-above  sight@50  sight@14');
    for (const x of r.rows) {
      if (!x.ground) {
        say(`    ${String(x.rel).padStart(3)} ${String(x.side).padStart(4)}`
          + ` ${String(x.outM).padStart(4)}  NOTHING UNDER IT`);
        continue;
      }
      say(`    ${String(x.rel).padStart(3)} ${String(x.side).padStart(4)}`
        + ` ${String(x.outM).padStart(4)}  ${x.ground.padEnd(18)}`
        + ` ${String(x.belowEdge).padStart(9)} ${String(x.model).padStart(12)}`
        + `  ${x.sight[0].padStart(8)}  ${x.sight[1].padStart(8)}`);
    }
    all.push({ seed: +SEED, ...r });
  });
}

const dir = path.join(ROOT, '.meas', 'r3');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${TAG}.json`), JSON.stringify(all, null, 2));
fs.writeFileSync(path.join(dir, `${TAG}.txt`), lines.join('\n') + '\n');
console.log(`\n  → ${path.join(dir, TAG + '.txt')}`);
finish(process.exitCode || 0);
