/* R2 / D1 (A) — the facts of the finish placement.
 *
 * Read-only: no drive, no render. Reports for each seed the track length, the
 * finish site's station/side/standing distance/rise, how many figures in how
 * many groups, the distance to the gate (L-12) and to the line (L), and the
 * scheduler's own log for the finish — which is where `pickFinish`'s choice is
 * visible before `place` slid it.
 *
 *   node tools/kfplace.mjs [--seeds 22,1,40]
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

const outDir = path.join(ROOT, '.meas', 'r2');
fs.mkdirSync(outDir, { recursive: true });
const all = [];
const lines = [];
const say = s => { console.log(s); lines.push(s); };

for (const SEED of SEEDS) {
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    const res = await page.evaluate(() => {
      const g = window.__game, t = g.track;
      const env = g.scene.getObjectByName('environment');
      const probe = env?.userData?.crowdProbe;
      const crowd = g.crowd;
      if (!crowd) return { none: true };
      const site = crowd.sites.find(s => s.kind === 'finish');
      const mesh = g.scene.getObjectByName('crowd-figures');
      const place = mesh.geometry.getAttribute('aPlace');

      /* Which instances belong to the finish site, by the same 26 m radius
         tools/zzseen.mjs uses, plus each one's own station so the group's
         extent along the road is visible. */
      const mine = [];
      if (site) {
        for (let i = 0; i < place.count; i++) {
          const x = place.getX(i), y = place.getY(i), z = place.getZ(i);
          if (Math.hypot(x - site.at.x, z - site.at.z) > 26) continue;
          const v = new g.THREE.Vector3(x, y, z);
          let st = null;
          try { st = t.project(v); } catch (e) { st = null; }
          mine.push({
            i, x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2),
            h: +place.getW(i).toFixed(2),
            s: st && st.s !== undefined ? +st.s.toFixed(1) : (typeof st === 'number' ? +st.toFixed(1) : null),
          });
        }
      }

      /* Every named object in the stage that could be the finish structure,
         so (B)'s gate ablation is pointed at something that exists. */
      const named = [];
      g.stage.traverse(o => {
        if (/finish|gate|banner|line/i.test(o.name || '')) {
          named.push({ name: o.name, type: o.type, children: o.children.length });
        }
      });
      const gate = g.stage.getObjectByName('gate-finish');
      let gateS = null, gatePos = null;
      if (gate) {
        g.stage.updateMatrixWorld(true);
        const p = new g.THREE.Vector3();
        gate.getWorldPosition(p);
        gatePos = [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)];
        const pr = t.project(p);
        gateS = pr && pr.s !== undefined ? +pr.s.toFixed(1) : (typeof pr === 'number' ? +pr.toFixed(1) : null);
      }

      const wallDist = site && probe ? probe.wallDist(site.s, site.side) : null;

      return {
        seed: t.seed, L: t.length,
        siteCount: crowd.sites.length,
        figures: crowd.figures, triangles: crowd.triangles,
        site: site ? {
          s: site.s, side: site.side, u: site.u, seen: site.seen,
          rise: site.rise, at: [site.at.x, site.at.y, site.at.z],
          groups: site.groups.map(gr => ({ cheer: gr.cheer, n: gr.n, s: gr.s })),
        } : null,
        wallDist,
        mine,
        named, gateS, gatePos,
        plan: probe ? probe.plan() : [],
        sites: crowd.sites.map(s => ({ kind: s.kind, s: +s.s.toFixed(0), n: s.groups.reduce((a, b) => a + b.n, 0) })),
      };
    });

    if (res.none) { say(`  seed ${SEED}: no crowd`); return; }
    all.push(res);
    const s = res.site;
    say(`\n══ seed ${res.seed} ══════════════════════════════════════════`);
    say(`  track.length            ${res.L.toFixed(2)} m`);
    say(`  gate 'gate-finish' at   s=${res.gateS}  (L-12 = ${(res.L - 12).toFixed(2)})  pos ${JSON.stringify(res.gatePos)}`);
    say(`  named finish-ish nodes  ${res.named.map(n => n.name).join(', ') || '(none)'}`);
    if (!s) { say('  NO FINISH SITE'); return; }
    const out = res.wallDist === null ? null : s.u * res.wallDist;
    say(`  finish site  s          ${s.s.toFixed(2)}`);
    say(`               side       ${s.side} (${s.side > 0 ? 'right' : 'left'} of travel)`);
    say(`               u          ${s.u.toFixed(4)}   wallDist ${res.wallDist === null ? '?' : res.wallDist.toFixed(2)} m`);
    say(`               out        ${out === null ? '?' : out.toFixed(2)} m from the road edge`);
    say(`               rise       ${s.rise.toFixed(2)} m above the road edge`);
    say(`               seen       ${s.seen}/5 of pickFinish's approach stations`);
    say(`               groups     ${s.groups.length}  ${JSON.stringify(s.groups)}`);
    say(`               figures    ${s.groups.reduce((a, b) => a + b.n, 0)} by the group count,`
      + ` ${res.mine.length} instances within 26 m of the site centre`);
    say(`               inst s     ${res.mine.map(m => m.s).join(', ')}`);
    say(`               inst h(m)  ${res.mine.map(m => m.h).join(', ')}`);
    say(`  distance to gate (L-12) ${(res.L - 12 - s.s).toFixed(2)} m`);
    say(`  distance to line (L)    ${(res.L - s.s).toFixed(2)} m`);
    say(`  nearest instance to line ${Math.min(...res.mine.map(m => res.L - m.s)).toFixed(1)} m`
      + `   furthest ${Math.max(...res.mine.map(m => res.L - m.s)).toFixed(1)} m`);
    say(`  all sites: ${res.sites.map(x => `${x.kind}@${x.s}(${x.n})`).join('  ')}`);
    say('  scheduler log lines mentioning the finish:');
    for (const l of res.plan) if (/finish/i.test(l)) say(`    ${l}`);
    say('  full scheduler log:');
    for (const l of res.plan) say(`      ${l}`);
  });
}

fs.writeFileSync(path.join(outDir, 'kfplace.json'), JSON.stringify(all, null, 2));
fs.writeFileSync(path.join(outDir, 'kfplace.txt'), lines.join('\n') + '\n');
console.log(`\n  → ${path.join(outDir, 'kfplace.txt')}`);
finish(process.exitCode || 0);
