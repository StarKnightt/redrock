/* Pose histogram, and the longest run of one pose inside a single group.
 *
 * The critic's D4 note is two claims: the overall mix is lopsided (cheer 13 /
 * pom 8 / flag 5 / sit 2 of 28) and two sites were four-of-a-kind. The second
 * is the one that shows — four people waving the same arm reads as one asset
 * repeated — so it is counted per group here, not per stage.
 *
 *   node tools/wpose.mjs [--seeds 22,1,40]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');
const NAME = ['cheer', 'flag', 'sit', 'pom'];

for (const SEED of SEEDS) {
  await run({
    width: 640, height: 360,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    page.setDefaultTimeout(600_000);
    const out = await page.evaluate(() => {
      const g = window.__game;
      if (!g.crowd) return null;
      const mesh = g.scene.getObjectByName('crowd-figures');
      const place = mesh.geometry.getAttribute('aPlace');
      const body = mesh.geometry.getAttribute('aBody');
      const tally = [0, 0, 0, 0];
      const groups = [];
      for (const site of g.crowd.sites) {
        const near = [];
        for (let i = 0; i < place.count; i++) {
          const x = place.getX(i), z = place.getZ(i);
          if (Math.hypot(x - site.at.x, z - site.at.z) > 26) continue;
          near.push({ x, z, pose: Math.round(body.getY(i)) });
        }
        near.sort((a, b) => (a.x - b.x) || (a.z - b.z));
        let best = 0, runLen = 0, last = -1;
        for (const f of near) {
          tally[f.pose] = (tally[f.pose] || 0) + 1;
          runLen = f.pose === last ? runLen + 1 : 1;
          last = f.pose;
          if (runLen > best) best = runLen;
        }
        groups.push({ kind: site.kind, n: near.length, run: best });
      }
      return { tally, groups };
    });
    if (!out) { console.log(`  seed ${SEED}: no crowd`); return; }
    const total = out.tally.reduce((a, b) => a + b, 0);
    console.log(`\n══ seed ${SEED} — ${total} figures`);
    console.log('   ' + out.tally.map((n, i) => `${NAME[i]} ${n}`).join('  '));
    const four = out.groups.filter(gp => gp.run >= 4);
    console.log(`   groups of 4+ identical in a row: ${four.length}`
      + (four.length ? '  — ' + four.map(gp => `${gp.kind} (${gp.run}/${gp.n})`).join(', ') : ''));
  });
}
finish(process.exitCode || 0);
