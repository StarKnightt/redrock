/* Numeric interrogation of the live scene. Screenshots say something looks
   wrong; this says what the numbers actually are.
     node tools/probe.mjs "return {x: g.camera.position.x}"
     node tools/probe.mjs some/script.js                                    */
import fs from 'node:fs';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
/* A path rather than a snippet, because anything long enough to be interesting
   is also long enough that shell quoting mangles it — a division ends up read
   as a regex and the failure looks like a bug in the probe. */
const body = args.length === 1 && args[0].endsWith('.js') && fs.existsSync(args[0])
  ? fs.readFileSync(args[0], 'utf8')
  : args.join(' ');

await run({ width: 640, height: 360, hash: 'manual' }, async ({ page }) => {
  const out = await page.evaluate(src => {
    const g = window.__game;
    const THREE = g.THREE;
    return JSON.parse(JSON.stringify(new Function('g', 'THREE', src)(g, THREE)));
  }, body);
  console.log(JSON.stringify(out, null, 2));
});

finish(process.exitCode || 0);
