/* R3 reconnaissance — what the crowd scheduler currently has to work with.
 *
 * Reads the file's OWN predicates through env.userData.crowdProbe rather than
 * reimplementing them, for the reason zqoracle documents: a probe that
 * re-derives a placement rule is grading its own copy of it.
 *
 * Reports, per seed:
 *   - the geometry that D1 is actually about: line, gate, end of road
 *   - every shipped site, with the schedule clock and the gap to its neighbour,
 *     so the APART_S claim can be checked against what is standing there
 *   - the finish window, station by station, as three columns: can anybody
 *     stand here, is the GROUP in frame, is the GATE in frame — the last of
 *     which nothing in the build currently asks
 *   - the mesh inventory with triangle counts, for costing the D5 ray
 *
 *   node tools/zwrecon.mjs [--seeds 22,1,40]
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
const OUT = flag('out', 'zwrecon');

const lines = [];
const say = s => { console.log(s); lines.push(s); };
const all = [];

for (const SEED of SEEDS) {
  await run({
    width: 320, height: 200,
    hash: `manual&tier=high&seed=${SEED}&cap=60&hud=0`,
  }, async ({ page }) => {
    const r = await page.evaluate(() => {
      const g = window.__game, t = g.track;
      const env = g.scene.getObjectByName('environment');
      const P = env.userData.crowdProbe;
      const L = t.length, LINE = t.finishS, GATE = t.gateS;
      const gatePos = t.frameAt(GATE).pos;

      const sites = (g.crowd?.sites || []).map(s => ({
        kind: s.kind, s: +s.s.toFixed(0), side: s.side,
        seen: s.seen ?? null,
        n: (s.groups || []).reduce((a, b) => a + b.n, 0),
        t: +P.clock(s.s).toFixed(1),
        rise: s.rise == null ? null : +s.rise.toFixed(2),
      }));

      /* The finish window, wider than the search's own so the stations it
         never considers are visible too. */
      const win = [];
      for (let s = L - 130; s <= L - 16; s += 2) {
        for (const side of [-1, 1]) {
          const u = P.stand(s, side);
          if (u === null) continue;
          const at = P.point(s, side, u);
          const out = u * P.wallDist(s, side);
          const per = P.backs.map(back => {
            const clear = P.seen(s, side, out, at.y + 0.95, undefined, [back]);
            const inG = P.inFrame(s, back, at.x, at.y, at.z);
            const inK = P.inFrame(s, back, gatePos.x, gatePos.y, gatePos.z);
            return (clear ? 1 : 0) | (inG ? 2 : 0) | (inK ? 4 : 0);
          });
          win.push({
            s, side, u: +u.toFixed(3), out: +out.toFixed(1),
            drawnY: +P.drawnY(s, side, u).toFixed(2),
            edgeY: +(t.frameAt(s).pos.y - 0.5).toFixed(2),
            per,
          });
        }
      }

      const meshes = [];
      g.scene.traverse(o => {
        if (!o.isMesh) return;
        const gg = o.geometry;
        const tri = gg.index ? gg.index.count / 3
          : gg.attributes.position ? gg.attributes.position.count / 3 : 0;
        const inst = o.isInstancedMesh ? o.count : (gg.instanceCount || 1);
        meshes.push({
          name: o.name || '(anon)', tri, inst,
          total: tri * (o.isInstancedMesh ? o.count : 1),
          transparent: !!(o.material && o.material.transparent),
        });
      });
      meshes.sort((a, b) => b.total - a.total);

      return {
        L: +L.toFixed(0), LINE: +LINE.toFixed(0), GATE, lap: +P.clock.lap.toFixed(1),
        startS: P.startS, stand: P.stand_m, backs: P.backs, boom: P.boom, eye: P.eye,
        figures: g.crowd?.figures ?? 0, tris: g.crowd?.triangles ?? 0,
        sites, win, meshes,
        plan: P.plan(),
      };
    });

    say(`\n══ seed ${SEED} ══  L=${r.L}  line=${r.LINE}  gate=${r.GATE}`
      + `  lap=${r.lap} s   ${r.sites.length} sites / ${r.figures} figures`
      + `  crowd tris ${r.tris}`);

    say(`  sites (backs ${r.backs.join(',')} m, boom ${r.boom} m, model eye ${r.eye} m):`);
    let prev = null;
    for (const s of r.sites) {
      const gap = prev === null ? null : +(s.t - prev).toFixed(2);
      say(`    ${s.kind.padEnd(14)} s=${String(s.s).padStart(4)} side ${String(s.side).padStart(2)}`
        + `  t=${String(s.t).padStart(6)} s  ${gap === null ? '      ' : String(gap).padStart(6)}`
        + `  n=${s.n}  seen=${s.seen}  rise=${s.rise}`
        + `${gap !== null && gap < 10 ? '   ← under APART_S' : ''}`);
      prev = s.t;
    }

    const fin = r.sites.find(s => s.kind === 'finish');
    say(`  finish site: ${fin ? `s=${fin.s} = line${fin.s - r.LINE >= 0 ? '+' : ''}${fin.s - r.LINE}`
      + `, ${r.GATE - fin.s} m short of the gate` : 'NONE'}`);

    say('  finish window — b=both group and gate in frame, g=group only,'
      + ' k=gate only, .=neither, x=sightline blocked');
    say('        s  rel-line side  out   drawnY  edgeY   ' + r.backs.map(b => `${b}m`.padStart(4)).join(''));
    for (const w of r.win) {
      const cols = w.per.map(m => {
        if (!(m & 1)) return '   x';
        const g2 = !!(m & 2), k = !!(m & 4);
        return (g2 && k ? '   b' : g2 ? '   g' : k ? '   k' : '   .');
      }).join('');
      say(`    ${String(w.s).padStart(5)}  ${String(w.s - r.LINE).padStart(7)}`
        + `  ${String(w.side).padStart(3)}  ${String(w.out).padStart(4)}`
        + `  ${String(w.drawnY).padStart(7)} ${String(w.edgeY).padStart(6)}   ${cols}`);
    }

    say('  meshes over 2000 triangles:');
    for (const m of r.meshes.filter(m => m.total >= 2000)) {
      say(`    ${m.name.padEnd(26)} ${String(m.total).padStart(7)} tri`
        + `  (${m.tri} x ${m.inst})${m.transparent ? '  transparent' : ''}`);
    }
    say(`    total ${r.meshes.reduce((a, b) => a + b.total, 0)} tri over ${r.meshes.length} meshes`);

    say('  scheduler log:');
    for (const l of r.plan) say('    ' + l);

    all.push({ seed: +SEED, ...r });
  });
}

const dir = path.join(ROOT, '.meas', 'r3');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${OUT}.json`), JSON.stringify(all, null, 2));
fs.writeFileSync(path.join(dir, `${OUT}.txt`), lines.join('\n') + '\n');
console.log(`\n  → ${path.join(dir, OUT + '.txt')}`);
finish(process.exitCode || 0);
