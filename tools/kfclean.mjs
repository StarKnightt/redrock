/* R2 / D1 — which of the pooled run-ins was actually a clean drive.
 *
 * The autopilot leaves the road on some of these approaches, and a frame taken
 * from a car grinding along the verge is a frame about the driver. Scores each
 * run over the last 250 m: marks spent off-road, worst lateral offset, and the
 * slowest mark.
 *
 *   node tools/kfclean.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const RUNS = flag('runs', 'kfsweep,kfsweep-pre60,kfsweep-pre90,kfsweep-pre120').split(',');
const dir = path.join(ROOT, '.meas', 'r2');
const lines = [];
const say = s => { console.log(s); lines.push(s); };

const data = RUNS.map(r => ({ name: r, d: JSON.parse(fs.readFileSync(path.join(dir, r + '.json'), 'utf8')) }));
const seeds = [...new Set(data.flatMap(x => x.d.map(s => s.seed)))];

for (const seed of seeds) {
  say(`\n── seed ${seed}`);
  for (const { name, d } of data) {
    const s = d.find(x => x.seed === seed);
    if (!s) continue;
    const off = s.rows.filter(r => r.offRoad > 0.5);
    const slow = s.rows.reduce((a, b) => a.kmh < b.kmh ? a : b);
    const lat = s.rows.reduce((a, b) => Math.abs(a.lat) > Math.abs(b.lat) ? a : b);
    const stalled = s.rows.filter(r => !r.reached);
    say(`   ${name.padEnd(18)} off-road at ${String(off.length).padStart(2)} of ${s.rows.length} marks`
      + `${off.length ? ` (${off[0].back}→${off[off.length - 1].back} m)` : ''}`
      + `   worst lat ${lat.lat} m at ${lat.back} m`
      + `   slowest ${slow.kmh} km/h at ${slow.back} m`
      + `   marks not reached: ${stalled.length}`);
  }
}
fs.writeFileSync(path.join(dir, 'kfclean.txt'), lines.join('\n') + '\n');
