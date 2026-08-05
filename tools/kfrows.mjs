/* R2 / D1 — print the raw per-mark rows of one seed across all pooled runs.
 *
 *   node tools/kfrows.mjs --seed 1 [--lo 40] [--hi 130]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = Number(flag('seed', '1'));
const LO = Number(flag('lo', '0')), HI = Number(flag('hi', '250'));
const RUNS = flag('runs', 'kfsweep,kfsweep-pre60,kfsweep-pre90,kfsweep-pre120').split(',');
const dir = path.join(ROOT, '.meas', 'r2');

for (const r of RUNS) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, r + '.json'), 'utf8'));
  const s = data.find(x => x.seed === SEED);
  if (!s) continue;
  console.log(`\n── ${r} — seed ${SEED}, site s=${s.siteS}, L=${s.L}`);
  for (const row of s.rows) {
    if (row.back < LO || row.back > HI) continue;
    const cb = row.crowdBox, gb = row.gateBox;
    console.log(`  ${String(row.back).padStart(4)} m  s=${String(row.s).padStart(7)}`
      + ` ${String(row.kmh).padStart(6)} km/h lat ${String(row.lat).padStart(6)}`
      + ` off ${String(row.offRoad).padStart(4)}`
      + `  crowd ${String(row.crowd).padStart(6)} tall ${String(row.tallest).padStart(3)}`
      + `  cbox ${cb ? `x[${cb[0]}..${cb[2]}] y[${cb[1]}..${cb[3]}]` : '—'}`
      + `  gate ${String(row.gate).padStart(6)}`
      + `  gbox ${gb ? `x[${gb[0]}..${gb[2]}] y[${gb[1]}..${gb[3]}]` : '—'}`);
  }
}
