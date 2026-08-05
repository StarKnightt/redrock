/* Is a race deterministic, and is the player's flight deterministic inside it?
 *
 * tools/zjrival.mjs's census disagreed with itself across two invocations on one
 * seed — 222 in-frame airborne rival frames one time and 2108 the next — and a
 * number that moves like that cannot be reported without knowing which part of
 * the simulation is moving. The player-side probes are bit-identical across
 * launches (tools/zjstart.mjs), so this asks the narrower question: does the
 * field arrive at the same place twice.
 *
 * Two runs per seed in the same process, each a fresh page, each stepped
 * identically from the grid under autopilot. Compared on the player's own
 * trajectory and on the rivals' — and the player is checked first, because if
 * the player diverges then nothing downstream of it means anything, whereas if
 * only the rivals diverge then the census is a sample rather than a constant.
 *
 *   node tools/zjdet.mjs [--seeds 22,40] [--sec 60]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,40').split(',').map(Number);
const SEC = +flag('sec', 60);

const TRACE = ([sec]) => {
  const g = window.__game, p = g.player;
  g.setPaused(true);
  /* Back to the grid, and this is the whole point of the tool. The page has been
     running its own loop since it booted, and how far the car got before the
     harness took the wheel is a function of how long the browser took to start.
     Anything that steps from here without resetting is measuring a different
     race every time — which is what this file was written to chase down. */
  g.restart();
  g.autopilot(true, 0.9);
  g.countdown.skip();
  const cars = (g.race?.entries || []).map(e => e.car).filter(c => c && c !== g.player);
  const player = [];
  const rivals = cars.map(() => []);
  for (let n = 0; n < 60 * sec; n++) {
    g.step(1 / 60);
    if (n % 60 !== 0) continue;
    player.push(`${p.s.toFixed(4)}/${p.lat.toFixed(4)}/${p.height.toFixed(4)}`);
    for (let i = 0; i < cars.length; i++) {
      rivals[i].push(`${cars[i].s.toFixed(4)}/${(cars[i].lat ?? 0).toFixed(4)}`);
    }
  }
  g.autopilot(false);
  return { player, rivals, n: cars.length };
};

let fails = 0;

for (const SEED of SEEDS) {
  const takes = [];
  for (let take = 0; take < 2; take++) {
    await run({ width: 640, height: 360, hash: `manual&tier=low&seed=${SEED}&cap=0&hud=0` },
      async ({ page }) => { takes.push(await page.evaluate(TRACE, [SEC])); });
  }
  const [a, b] = takes;
  const firstDiff = (x, y) => {
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return i;
    return x.length === y.length ? -1 : Math.min(x.length, y.length);
  };
  const pd = firstDiff(a.player, b.player);
  const rd = a.rivals.map((r, i) => firstDiff(r, b.rivals[i]));
  const playerOk = pd < 0;
  const rivalsOk = rd.every(d => d < 0);
  if (!playerOk) fails++;
  console.log(`\n  seed ${SEED} — ${SEC} s from the grid, twice, sampled once a second`);
  console.log(`    player   ${playerOk ? 'identical' : `diverges at second ${pd}`}`);
  for (let i = 0; i < rd.length; i++) {
    console.log(`    rival ${i}  ${rd[i] < 0 ? 'identical' : `diverges at second ${rd[i]}`}`
      + (rd[i] >= 0 ? `   ${a.rivals[i][rd[i]]}  vs  ${b.rivals[i][rd[i]]}` : ''));
  }
  if (playerOk && !rivalsOk) {
    console.log('    → the player is reproducible and the field is not, so any'
      + ' number that depends on where a rival is is a sample, not a constant');
  }
}

console.log(fails
  ? `\n  FAIL — the player's own trajectory is not reproducible`
  : `\n  PASS — the player's trajectory is reproducible across launches`);
if (fails) process.exitCode = 1;
finish(process.exitCode || 0);
