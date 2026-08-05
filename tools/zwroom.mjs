/* How much room the finish run-in really has, to half a metre.
 *
 * zwfin.mjs showed that seed 40's line..gate stretch has drawn ground and a
 * clear sightline at 5 m off the road edge and neither at 7.4 m, which is where
 * `crowdStand`'s clearance floor puts the innermost candidate. This resolves
 * that boundary: for every station and side it sweeps the standoff, and for each
 * cell reports whether a mesh is under the boots, WHICH mesh, and whether a real
 * ray from the pessimistic modelled lens reaches the chest at each approach
 * station.
 *
 *   node tools/zwroom.mjs [--seeds 40] [--lo -30] [--hi 32]
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
const LO = +flag('lo', -30);
const HI = +flag('hi', 32);
const OUTS = flag('outs', '4.5,5,5.6,6.2,6.8,7.4,8.5,10,12').split(',').map(Number);

const lines = [];
const say = s => { console.log(s); lines.push(s); };
const all = [];

for (const SEED of SEEDS) {
  await run({
    width: 320, height: 200,
    hash: `manual&tier=high&seed=${SEED}&cap=60&hud=0`,
  }, async ({ page }) => {
    const r = await page.evaluate(({ LO, HI, OUTS }) => {
      const THREE = window.__game.THREE;
      const g = window.__game, t = g.track;
      const env = g.scene.getObjectByName('environment');
      const P = env.userData.crowdProbe;
      const L = t.length, LINE = t.finishS, GATE = t.gateS;

      const SKIP = /^(sky-dome|painted-sky|sun-disc|block-clouds|ocean-bands|shore-foam|crowd-figures|trackside-crowd|.*bird.*|.*grass.*|.*wildflower.*|.*flower.*)$/i;
      const blockers = [];
      g.scene.traverse(o => {
        if (!o.isMesh || SKIP.test(o.name)) return;
        if (o.material && o.material.transparent) return;
        blockers.push(o);
      });

      const ray = new THREE.Raycaster();
      const DOWN = new THREE.Vector3(0, -1, 0);
      const rows = [];
      for (let s = LINE + LO; s <= LINE + HI; s += 2) {
        for (const side of [-1, 1]) {
          const wall = P.wallDist(s, side);
          const cells = [];
          for (const outM of OUTS) {
            const u = outM / wall;
            const at = P.point(s, side, u);
            const dy = P.drawnY(s, side, u);
            ray.set(new THREE.Vector3(at.x, at.y + 60, at.z), DOWN);
            ray.near = 0; ray.far = 400;
            const gh = ray.intersectObjects(blockers, false);
            const ground = gh.length ? gh[0] : null;
            const chest = new THREE.Vector3(at.x, dy + 0.95, at.z);
            let clear = 0;
            const blocks = [];
            for (const back of P.backs) {
              const s0 = s - back - P.boom;
              if (s0 < 4) continue;
              const f = t.frameAt(s0);
              const lens = new THREE.Vector3(f.pos.x, f.pos.y - 0.5 + 2.55, f.pos.z);
              const d = chest.clone().sub(lens);
              const dist = d.length();
              ray.set(lens, d.normalize());
              ray.near = 0.1; ray.far = dist - 0.25;
              const h = ray.intersectObjects(blockers, false);
              if (!h.length) clear++; else blocks.push(h[0].object.name);
            }
            cells.push({
              outM, drawnY: +dy.toFixed(2),
              gy: ground ? +ground.point.y.toFixed(2) : null,
              what: ground ? ground.object.name : null,
              err: ground ? +(dy - ground.point.y).toFixed(2) : null,
              clear, block: blocks[0] || null,
            });
          }
          rows.push({
            s, side, wall: +wall.toFixed(1), standM: P.stand(s, side) === null ? null
              : +(P.stand(s, side) * wall).toFixed(1),
            cells,
          });
        }
      }
      return { L: +L.toFixed(0), LINE, GATE, rows };
    }, { LO, HI, OUTS });

    say(`\n══ seed ${SEED} ══  L=${r.L}  line=${r.LINE}  gate=${r.GATE}`);
    say('  digit = how many of the 5 approach stations a REAL ray reaches the chest from'
      + ' (pessimistic 2.55 m eye);  ^ = no drawn ground under the boots');
    say('      s   rel  side  wall  stand   ' + OUTS.map(o => `${o}`.padStart(6)).join('')
      + '    ground mesh at innermost grounded cell');
    for (const row of r.rows) {
      const cols = row.cells.map(c => {
        if (c.gy === null || Math.abs(c.err) > 1.5) return '     ^';
        return `     ${c.clear}`;
      }).join('');
      const first = row.cells.find(c => c.gy !== null && Math.abs(c.err) <= 1.5);
      say(`  ${String(row.s).padStart(5)} ${String(row.s - r.LINE).padStart(5)}`
        + `  ${String(row.side).padStart(3)} ${String(row.wall).padStart(5)}`
        + `  ${String(row.standM ?? '—').padStart(5)}   ${cols}`
        + `    ${first ? `${first.outM} m: ${first.what} (err ${first.err})` : '—'}`);
    }
    all.push({ seed: +SEED, ...r });
  });
}

const dir = path.join(ROOT, '.meas', 'r3');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'zwroom.json'), JSON.stringify(all, null, 2));
fs.writeFileSync(path.join(dir, 'zwroom.txt'), lines.join('\n') + '\n');
console.log(`\n  → ${path.join(dir, 'zwroom.txt')}`);
finish(process.exitCode || 0);
