/* The pose mix, per site and over the stage.
 *
 * D4's second half: "pose mix is cheer 13 / pom 8 / flag 5 / sit 2 of 28, with
 * two sites four-of-a-kind". Four poses exist and a crowd that is two thirds
 * one of them reads as one asset repeated, which is what it is. The run-length
 * rule in buildCrowd forbids a third identical pose in a row within a group;
 * whether that is enough is a counting question, so count.
 *
 * Read off the instance attributes rather than off the builder, so what is
 * reported is what was uploaded to the GPU.
 *
 *   node tools/zqpose.mjs [--seeds 22,1,40]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');
const NAME = ['cheer', 'flag', 'sit', 'pom'];

for (const SEED of SEEDS) {
  await run({
    width: 320, height: 200,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    const out = await page.evaluate(() => {
      const g = window.__game;
      const mesh = g.scene.getObjectByName('crowd-figures');
      if (!mesh || !g.crowd) return { none: true };
      const place = mesh.geometry.getAttribute('aPlace');
      const bodyA = mesh.geometry.getAttribute('aBody');
      const sites = g.crowd.sites.map(s => ({ kind: s.kind, s: s.s, at: [s.at.x, s.at.z], poses: [] }));
      const all = [];
      for (let i = 0; i < place.count; i++) {
        const p = Math.round(bodyA.getY(i));
        all.push(p);
        let best = null, bd = Infinity;
        for (const site of sites) {
          const d = Math.hypot(place.getX(i) - site.at[0], place.getZ(i) - site.at[1]);
          if (d < bd) { bd = d; best = site; }
        }
        if (best && bd < 40) best.poses.push(p);
      }
      return { seed: g.track.seed, all, sites };
    });
    if (out.none) { console.log('  no crowd'); return; }
    const tally = (list) => {
      const c = [0, 0, 0, 0];
      for (const p of list) c[p]++;
      return c;
    };
    const t = tally(out.all);
    console.log(`\n══ seed ${out.seed} — ${out.all.length} figures`);
    console.log('   overall  ' + NAME.map((n, i) =>
      `${n} ${t[i]} (${(100 * t[i] / out.all.length).toFixed(0)}%)`).join('   '));
    let fourOfAKind = 0;
    for (const site of out.sites) {
      if (!site.poses.length) continue;
      const c = tally(site.poses);
      const top = Math.max(...c);
      /* Four or more of one pose in one site is the shape the brief calls out;
         a squad is uniform by design, so it does not count against this. */
      const uniform = top >= 4 && site.poses.length >= 4 && !(c[3] === site.poses.length);
      if (uniform) fourOfAKind++;
      console.log(`     ${site.kind.padEnd(14)} s=${String(Math.round(site.s)).padStart(4)}`
        + `  ${site.poses.map(p => NAME[p]).join(' ')}${uniform ? '   ◀── four of a kind' : ''}`);
    }
    console.log(`   sites that are four or more of one pose: ${fourOfAKind}`);
  });
}

finish();
