/* What ground the last 140 m of the stage actually offers a finish crowd.
 *
 * D1 is a staging question — crowd and gate in one frame, and somebody in shot
 * as the line goes under the car — and the honest first question is what the
 * mountain has. So this scans the run-in station by station, side by side, at
 * several standing distances, and answers three things per cell from the DRAWN
 * world rather than from the model:
 *
 *   ground   a ray dropped from 60 m up: is there a mesh under the boots, and
 *            how far is it from where drawnGroundY says it is
 *   see      a ray from the modelled lens to the chest, at the pessimistic eye
 *            (2.55 m over the road edge) and the measured median (3.6 m)
 *   stand    what crowdStand/crowdSeen think, for comparison
 *
 * Plus, for the record, whether the gate's own station is inside the bearing
 * cone from the same lens.
 *
 *   node tools/zwfin.mjs [--seeds 22,1,40] [--back 20]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');
const SPAN = +flag('span', 150);
const OUTS = flag('outs', '5,7.4,10,14,20').split(',').map(Number);

const lines = [];
const say = s => { console.log(s); lines.push(s); };
const all = [];

for (const SEED of SEEDS) {
  await run({
    width: 320, height: 200,
    hash: `manual&tier=high&seed=${SEED}&cap=60&hud=0`,
  }, async ({ page }) => {
    const r = await page.evaluate(({ SPAN, OUTS }) => {
      const THREE = window.__game.THREE;
      const g = window.__game, t = g.track;
      const env = g.scene.getObjectByName('environment');
      const P = env.userData.crowdProbe;
      const L = t.length, LINE = t.finishS, GATE = t.gateS;

      const SKIP = /^(sky-dome|painted-sky|sun-disc|block-clouds|ocean-bands|shore-foam|crowd-figures|trackside-crowd|.*bird.*|.*grass.*|.*wildflower.*|.*flower.*)$/i;
      const blockers = [];
      g.scene.traverse(o => {
        if (!o.isMesh) return;
        if (SKIP.test(o.name)) return;
        if (o.material && o.material.transparent) return;
        blockers.push(o);
      });

      const ray = new THREE.Raycaster();
      const down = new THREE.Vector3(0, -1, 0);
      const groundAt = (p) => {
        ray.set(new THREE.Vector3(p.x, p.y + 60, p.z), down);
        ray.near = 0; ray.far = 400;
        const h = ray.intersectObjects(blockers, false);
        return h.length ? { y: h[0].point.y, what: h[0].object.name } : null;
      };
      const sightTo = (chest, s, back, eye) => {
        const s0 = s - back - P.boom;
        if (s0 < 4) return { skip: true };
        const f = t.frameAt(s0);
        const lens = new THREE.Vector3(f.pos.x, f.pos.y - 0.5 + eye, f.pos.z);
        const d = chest.clone().sub(lens);
        const dist = d.length();
        ray.set(lens, d.normalize());
        ray.near = 0.1; ray.far = dist - 0.25;
        const h = ray.intersectObjects(blockers, false);
        return { clear: !h.length, what: h.length ? h[0].object.name : null, dist };
      };

      const gatePos = t.frameAt(GATE).pos;
      const rows = [];
      for (let s = L - SPAN; s <= L - 2; s += 2) {
        for (const side of [-1, 1]) {
          const wall = P.wallDist(s, side);
          const standU = P.stand(s, side);
          const cells = OUTS.map(outM => {
            const u = outM / wall;
            if (u > 1) return null;
            const at = P.point(s, side, u);
            const dy = P.drawnY(s, side, u);
            const gr = groundAt(at);
            const chest = new THREE.Vector3(at.x, dy + 0.95, at.z);
            const lo = sightTo(chest, s, 20, 2.55);
            const hi = sightTo(chest, s, 20, 3.6);
            const near = sightTo(chest, s, 14, 3.6);
            const far = sightTo(chest, s, 50, 3.6);
            return {
              outM, drawnY: +dy.toFixed(2),
              groundY: gr ? +gr.y.toFixed(2) : null, groundWhat: gr ? gr.what : null,
              err: gr ? +(dy - gr.y).toFixed(2) : null,
              lo: !!lo.clear, hi: !!hi.clear, near: !!near.clear, far: !!far.clear,
              blockLo: lo.what, blockHi: hi.what,
              model: P.seen(s, side, outM, dy + 0.95, undefined, [20]),
            };
          });
          rows.push({
            s, side, wall: +wall.toFixed(1),
            edgeY: +(t.frameAt(s).pos.y - 0.5).toFixed(2),
            standU: standU === null ? null : +standU.toFixed(3),
            standM: standU === null ? null : +(standU * wall).toFixed(1),
            gateIn: P.inFrame(s, 20, gatePos.x, gatePos.y, gatePos.z),
            cells,
          });
        }
      }
      return { L: +L.toFixed(0), LINE, GATE, rows, blockers: blockers.length };
    }, { SPAN, OUTS });

    say(`\n══ seed ${SEED} ══  L=${r.L}  line=${r.LINE}  gate=${r.GATE}`
      + `   ${r.blockers} blocker meshes`);
    say('  per cell: G=ground under boots & sightline clear from BOTH eyes,'
      + ' g=clear only from 3.6 m eye, o=ground but blocked, ^=no ground under boots');
    say('       s  rel   side  wall  edgeY  stand  gateIn   '
      + OUTS.map(o => `${o}m`.padStart(6)).join(''));
    for (const row of r.rows) {
      const cols = row.cells.map(c => {
        if (!c) return '     -';
        if (c.groundY === null || Math.abs(c.err) > 1.5) return '     ^';
        return (c.lo && c.hi ? '     G' : c.hi ? '     g' : '     o');
      }).join('');
      say(`   ${String(row.s).padStart(5)} ${String(row.s - r.LINE).padStart(5)}`
        + `   ${String(row.side).padStart(3)}  ${String(row.wall).padStart(5)}`
        + ` ${String(row.edgeY).padStart(6)}  ${String(row.standM ?? '—').padStart(5)}`
        + `  ${row.gateIn ? 'yes' : ' no'}    ${cols}`);
    }
    all.push({ seed: +SEED, ...r });
  });
}

const dir = path.join(ROOT, '.meas', 'r3');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'zwfin.json'), JSON.stringify(all, null, 2));
fs.writeFileSync(path.join(dir, 'zwfin.txt'), lines.join('\n') + '\n');
console.log(`\n  → ${path.join(dir, 'zwfin.txt')}`);
finish(process.exitCode || 0);
