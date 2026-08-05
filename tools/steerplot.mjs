/* Draw the before/after steering traces steerprobe.mjs recorded.
 *
 * A column of numbers says the curve got smoother; a picture of it says which
 * part of the curve was rough and what it looks like now. Rendered through the
 * same headless Chromium as everything else rather than through a plotting
 * dependency — tools/steerplot.html is a canvas and nothing else.
 *
 *   node tools/steerprobe.mjs steer     (first — this reads its CSVs)
 *   node tools/steerplot.mjs [tag]
 */
import { chromium } from 'playwright';
import './tame.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './harness.mjs';
import { finish, guard } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = (args[0] && !args[0].startsWith('--')) ? args[0] : 'steer';
const outDir = path.join(ROOT, 'shots', tag);

for (const n of ['before', 'after']) {
  const f = path.join(outDir, `step60-${n}.csv`);
  if (!fs.existsSync(f)) {
    console.error(`✗ ${path.relative(ROOT, f)} is missing — run tools/steerprobe.mjs ${tag} first`);
    finish(1);
  }
}

const srv = serve();
await new Promise(r => srv.listen(0, r));
const url = `http://localhost:${srv.address().port}/tools/steerplot.html?tag=${tag}`;

const browser = guard(await chromium.launch({ headless: true }));
guard(srv);

const page = await browser.newPage({ viewport: { width: 1500, height: 1180 } });
const errs = [];
page.on('pageerror', e => errs.push('[pageerror] ' + (e.stack || e.message || e)));
page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });

console.log(`→ ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__plotReady, null, { timeout: 20_000 });

const file = path.join(outDir, 'trace.png');
await page.screenshot({ path: file });
console.log(`  → ${path.relative(ROOT, file)}`);

if (errs.length) {
  console.log('\n─── page errors ───');
  [...new Set(errs)].slice(0, 10).forEach(e => console.log(' ', e));
  process.exitCode = 1;
}

finish(process.exitCode || 0);
