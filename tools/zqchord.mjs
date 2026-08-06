/* How curled is the approach to a site, and where does the chord go?
 *
 * The chord test in crowdSightScore only runs when the straight line from the
 * lens to the group is appreciably shorter than the road between them. This
 * prints that ratio, and then walks the chord printing how far outside the
 * corridor each sample lands — so "the test never fired" and "the test fired
 * and found nothing" can be told apart.
 *
 *   node tools/zqchord.mjs [--seed 1] [--at 2127] [--backs 50,38,28,20,14]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '1');
const AT = Number(flag('at', '2127'));
const BACKS = flag('backs', '50,38,28,20,14').split(',').map(Number);

await run({
  width: 320, height: 200,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  const out = await page.evaluate(([at, backs]) => {
    const g = window.__game;
    const t = g.track;
    const env = g.scene.getObjectByName('environment') || g.stage.getObjectByName('environment');
    const probe = env?.userData?.crowdProbe;
    const site = (g.crowd?.sites || []).find(s => Math.abs(s.s - at) < 3);
    if (!site || !probe) return { none: true };
    const BOOM = 11;
    const rows = [];
    for (const back of backs) {
      const s0 = site.s - back - BOOM;
      const lens = t.frameAt(s0).pos;
      const arc = site.s - s0;
      const chord = Math.hypot(site.at.x - lens.x, site.at.z - lens.z);
      const samples = [];
      for (let k = 1; k < 12; k++) {
        const tt = k / 12;
        const p = {
          x: lens.x + (site.at.x - lens.x) * tt,
          y: 0,
          z: lens.z + (site.at.z - lens.z) * tt,
        };
        const ry = t.frameAt(s0).pos.y + 2.5;
        const hit = t.project(new g.THREE.Vector3(p.x, ry, p.z), s0 + arc * tt);
        samples.push({
          t: +tt.toFixed(2), s: +hit.s.toFixed(0),
          lat: +(Math.abs(hit.lat) - hit.width * 0.5).toFixed(1),
          wall: +probe.wallDist(hit.s, hit.lat >= 0 ? 1 : -1).toFixed(1),
        });
      }
      rows.push({ back, arc: +arc.toFixed(0), chord: +chord.toFixed(0),
        ratio: +(chord / arc).toFixed(3), samples });
    }
    return { seed: t.seed, s: site.s, kind: site.kind, rows };
  }, [AT, BACKS]);

  if (out.none) { console.log('  no such site'); return; }
  console.log(`\n  seed ${out.seed} — ${out.kind} at s=${out.s.toFixed(0)}`);
  for (const r of out.rows) {
    console.log(`\n    ${r.back} m back: arc ${r.arc} m, chord ${r.chord} m,`
      + ` ratio ${r.ratio}  ${r.ratio < 0.88 ? '← curled, test runs' : '(straight, test skipped)'}`);
    console.log('        ' + r.samples.map(s =>
      `s${s.s}:${s.lat > 0 ? '+' : ''}${s.lat}m/${s.wall}`).join('  '));
  }
});

/* Not `finish()`. `finish` defaults its argument to 0, so a bare call is
   `finish(0)` — the discarded exit code the 67-tool repair removed, in a
   spelling a grep for "finish(0)" cannot match. Measured: with a syntax error in
   src/core/util.js this tool printed "parse errors — not launching a browser",
   sampled no chord, and exited 0. */
finish(process.exitCode || 0);
