/* The scheduler's own running commentary, verbatim.
 *
 * crowdSites() takes an optional log and narrates every decision into it:
 * which candidate was tried, which gate turned it down, which hole the pacing
 * pass went after and what it found there. tools/zqsched.mjs prints the
 * outcome; this prints the reasoning, which is what you want when the outcome
 * is "there is still a forty-five second hole" and the question is whether
 * anything could have gone in it.
 *
 *   node tools/zqplan.mjs [--seeds 22,1,40]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');

for (const SEED of SEEDS) {
  await run({
    width: 320, height: 200,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    const out = await page.evaluate(() => {
      const g = window.__game;
      const env = g.scene.getObjectByName('environment') || g.stage.getObjectByName('environment');
      const probe = env?.userData?.crowdProbe;
      if (!probe) return { none: true };
      return { L: g.track.length, seed: g.track.seed, plan: probe.plan() };
    });
    if (out.none) { console.log('  no crowd probe'); return; }
    console.log(`\n══ seed ${out.seed} — ${out.L.toFixed(0)} m`);
    for (const line of out.plan) console.log('   ' + line);
  });
}

finish();
