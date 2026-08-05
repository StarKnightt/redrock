/* R2 / D1 — the run-in table that goes with the filed captures.
 *
 * One row per station, from the same run the PNG in shots/r2f-<seed>/ was
 * taken on, so the numbers and the pictures are the same frame.
 *
 *   node tools/kftable.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(ROOT, '.meas', 'r2');
const W = 1600;
const STATIONS = [110, 90, 80, 70, 60, 50, 40, 30, 20, 12, 6, 0];

/* seed -> the run whose PNGs were filed, and where they went. */
const FILED = [
  { seed: 22, run: 'kfsweep', pre: 40, shots: 'shots/r2f-22' },
  { seed: 1, run: 'kfshot-1', pre: 120, shots: 'shots/r2f-1' },
  { seed: 40, run: 'kfshot-40', pre: 90, shots: 'shots/r2f-40' },
  { seed: '22 (pre-fix build, C:/Code/redrock-critic)', run: 'kfsweep-pre-fix', pre: 40, shots: 'shots/r2fpre-22' },
];

const lines = [];
const say = s => { console.log(s); lines.push(s); };

for (const f of FILED) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, f.run + '.json'), 'utf8'));
  const s = data[0];
  say(`\n══ seed ${f.seed} ══  L=${s.L}  finish site s=${s.siteS}`
    + ` (${(s.L - s.siteS).toFixed(0)} m before the line, ${(s.L - 12 - s.siteS).toFixed(0)} m before the gate)`
    + `  ${s.n} figures   drive-in pre=${f.pre}   captures in ${f.shots}/`);
  say('    m before line   km/h   crowd px   tallest fig   gate px    crowd in frame'
    + '   crowd box x[..] y[..]   px from L edge / R edge   gate box x[..]');
  for (const st of STATIONS) {
    const r = s.rows.find(x => x.back === st);
    if (!r) continue;
    const cb = r.crowdBox, gb = r.gateBox;
    say(`    ${String(st).padStart(9)} m  ${String(r.kmh).padStart(6)}`
      + `  ${String(r.crowd).padStart(8)}   ${String(r.tallest).padStart(7)} px`
      + `  ${String(r.gate).padStart(8)}          ${r.crowd > 0 ? 'YES' : 'no '}`
      + `        ${cb ? `x[${cb[0]}..${cb[2]}] y[${cb[1]}..${cb[3]}]`.padEnd(24) : '—'.padEnd(24)}`
      + `  ${cb ? `${cb[0]} / ${W - 1 - cb[2]}`.padStart(11) : '   —'.padStart(11)}`
      + `   ${gb ? `x[${gb[0]}..${gb[2]}]` : '—'}`);
  }
  const vis = s.rows.filter(r => r.crowd > 0);
  say(`    crowd registers pixels from ${vis[0].back} m to ${vis[vis.length - 1].back} m before the line`);
  say(`    of the 12 stations, crowd in frame at ${STATIONS.filter(st => (s.rows.find(x => x.back === st) || {}).crowd > 0).length}`
    + `, crowd AND gate both in frame at `
    + `${STATIONS.filter(st => { const r = s.rows.find(x => x.back === st); return r && r.crowd > 0 && r.gate > 0; }).length}`);
  say(`    screen time  > 20 px: ${s.s20.sec} s measured, ${s.s20.secClean} s speed-normalised`
    + `   (${s.s20.from} → ${s.s20.to} m before the line)`);
  say(`    screen time  > 40 px: ${s40str(s)}`);
}

function s40str(s) {
  return `${s.s40.sec} s measured, ${s.s40.secClean} s speed-normalised`
    + `   (${s.s40.from} → ${s.s40.to} m before the line)`;
}

fs.writeFileSync(path.join(dir, 'kftable.txt'), lines.join('\n') + '\n');
console.log(`\n  → ${path.join(dir, 'kftable.txt')}`);
