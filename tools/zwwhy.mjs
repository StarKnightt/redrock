/* Why a station is refused, and what a REAL ray says about it.
 *
 * Two questions in one pass, because they are the two halves of R3:
 *
 *   1. crowdProbe.why() — the file's own trace for every candidate offset at a
 *      station, so "nothing stands here" can be read as a reason rather than
 *      guessed at. Used on seed 40's line..gate stretch, where the finish
 *      window runs out of ground 38 m before the line.
 *
 *   2. A Three raycast from the modelled lens to the chest, against the built
 *      meshes, at both the model eye (2.55 m over the road edge) and the
 *      measured one (3.94 m) — the D5 test, plus its cost in milliseconds.
 *
 *   node tools/zwwhy.mjs --seed 40 --from 5030 --to 5092
 *   node tools/zwwhy.mjs --seed 40 --at 4150 --side -1
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
const AT = flag('at', null);
const FROM = +flag('from', 5030);
const TO = +flag('to', 5092);
const STEP = +flag('step', 2);
const SIDES = flag('side', '-1,1').split(',').map(Number);
const OUTM = +flag('out', 7.4);
const OUT = flag('out', `zwwhy-${SEED}`);

const lines = [];
const say = s => { console.log(s); lines.push(s); };

await run({
  width: 320, height: 200,
  hash: `manual&tier=high&seed=${SEED}&cap=60&hud=0`,
}, async ({ page }) => {
  const r = await page.evaluate(({ AT, FROM, TO, STEP, SIDES, OUTM }) => {
    window.__OUT = OUTM;
    const THREE = window.__game.THREE;
    const g = window.__game, t = g.track;
    const env = g.scene.getObjectByName('environment');
    const P = env.userData.crowdProbe;

    /* The meshes the frame actually draws, minus the four things a sightline
       must not be stopped by: the sky dome (drawn, and behind everything), the
       ocean and its foam (below every shoulder, and a hit on them means the ray
       already left the land), the birds, and the crowd itself. Grass and
       wildflowers are excluded too — they are knee-high scatter that the
       figures stand among rather than behind. */
    const SKIP = /^(sky-dome|painted-sky|sun-disc|block-clouds|ocean-bands|shore-foam|crowd-figures|trackside-crowd|.*bird.*|.*grass.*|.*wildflower.*|.*flower.*)$/i;
    const blockers = [];
    g.scene.traverse(o => {
      if (!o.isMesh) return;
      if (SKIP.test(o.name)) return;
      if (o.material && o.material.transparent) return;
      blockers.push(o);
    });

    const ray = new THREE.Raycaster();
    ray.firstHitOnly = true;
    const cast = (s, side, u, back, eye) => {
      const at = P.point(s, side, u);
      const chest = new THREE.Vector3(at.x, P.drawnY(s, side, u) + 0.95, at.z);
      const s0 = s - back - P.boom;
      if (s0 < 4) return null;
      const f = t.frameAt(s0);
      const lens = new THREE.Vector3(f.pos.x, f.pos.y - 0.5 + eye, f.pos.z);
      const dir = chest.clone().sub(lens);
      const dist = dir.length();
      ray.set(lens, dir.normalize());
      ray.near = 0.1;
      ray.far = dist - 0.25;
      const hits = ray.intersectObjects(blockers, false);
      return {
        dist: +dist.toFixed(1),
        hit: hits.length ? hits[0].object.name : null,
        at: hits.length ? +hits[0].distance.toFixed(1) : null,
        hitY: hits.length ? +hits[0].point.y.toFixed(2) : null,
        chestY: +chest.y.toFixed(2), lensY: +lens.y.toFixed(2),
      };
    };

    const rows = [];
    const stations = AT !== null ? [+AT]
      : (() => { const o = []; for (let s = FROM; s <= TO; s += STEP) o.push(s); return o; })();
    for (const s of stations) {
      for (const side of SIDES) {
        const w = P.why(s, side);
        const row = { s, side, u: w.u, trace: w.trace, seen: w.seen, rays: null };
        /* Cast even where the model refused the station, which is the whole
           point: a refusal is only sound if the drawn world agrees with it. */
        const u = w.u !== null ? w.u : window.__OUT / P.wallDist(s, side);
        row.castU = +u.toFixed(3);
        row.rays = P.backs.map(back => ({
          back,
          model: cast(s, side, u, back, 2.55),
          real: cast(s, side, u, back, 3.94),
        }));
        rows.push(row);
      }
    }

    // Cost: one ray per site per station, timed.
    const t0 = performance.now();
    let n = 0;
    for (const site of (g.crowd?.sites || [])) {
      if (site.u == null) continue;
      for (const back of P.backs) { cast(site.s, site.side, site.u, back, 3.94); n++; }
    }
    const ms = performance.now() - t0;

    return {
      L: +t.length.toFixed(0), blockers: blockers.map(b => b.name),
      rows, cost: { n, ms: +ms.toFixed(1), per: +(ms / Math.max(n, 1)).toFixed(2) },
    };
  }, { AT, FROM, TO, STEP, SIDES, OUTM });

  say(`seed ${SEED}  L=${r.L}  line=${r.L - 34}  gate=${r.L - 12}`);
  say(`  ${r.blockers.length} blocker meshes; ${r.cost.n} rays in ${r.cost.ms} ms`
    + ` (${r.cost.per} ms each)`);
  for (const row of r.rows) {
    say(`\n  s=${row.s} side ${row.side}  u=${row.u === null ? 'NONE' : row.u.toFixed(3)}`);
    for (const l of row.trace) say('      ' + l);
    if (row.seen) say('      sightline: ' + row.seen.join('  |  '));
    if (row.rays) {
      for (const q of row.rays) {
        const f = (x) => x === null ? 'n/a'
          : x.hit ? `BLOCKED by ${x.hit} at ${x.at}/${x.dist} m, y ${x.hitY}` : `clear (${x.dist} m)`;
        say(`      ray back ${String(q.back).padStart(2)} m:  eye2.55 ${f(q.model)}`);
        say(`                       eye3.94 ${f(q.real)}`
          + (q.real ? `   chest y ${q.real.chestY}, lens y ${q.real.lensY}` : ''));
      }
    }
  }

  const dir = path.join(ROOT, '.meas', 'r3');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${OUT}.txt`), lines.join('\n') + '\n');
  console.log(`\n  → ${path.join(dir, OUT + '.txt')}`);
});
finish(process.exitCode || 0);
