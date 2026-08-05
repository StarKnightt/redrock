/* Why did the crowd not stand there?
 *
 * `crowdStand` walks nineteen offsets across the shoulder and turns each one
 * down for one of five reasons. When a station places nobody the interesting
 * question is which gate emptied it, and guessing from the outside is how you
 * end up loosening the wrong one.
 *
 *   node tools/zqwhy.mjs --seed 22 --at 56,1299,1330
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const AT = flag('at', '56').split(',').map(Number);

await run({
  width: 640, height: 360,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  const out = await page.evaluate(([at]) => {
    const g = window.__game;
    const env = g.scene.getObjectByName('environment') || g.stage.getObjectByName('environment');
    const probe = env?.userData?.crowdProbe;
    if (!probe) return { none: true };
    const rows = [];
    for (const s of at) {
      for (const side of [1, -1]) {
        rows.push({ s, side, ...probe.why(s, side) });
      }
    }
    return { rows, L: +g.track.length.toFixed(0) };
  }, [AT]);

  if (out.none) { console.log('  no crowdProbe'); return; }
  console.log(`\n  seed ${SEED}, track ${out.L} m\n`);
  for (const r of out.rows) {
    console.log(`  s=${r.s}  side ${r.side}  →  ${r.u === null ? 'NOTHING STANDS HERE' : 'u=' + r.u.toFixed(3)}`);
    for (const line of r.trace) console.log('    ' + line);
    if (r.seen) {
      console.log('    approach, at the chosen offset:');
      for (const line of r.seen) console.log('      ' + line);
    }
    console.log();
  }
});
finish(process.exitCode || 0);
