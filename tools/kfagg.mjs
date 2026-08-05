/* R2 / D1 — pool the four run-in sweeps.
 *
 * The autopilot is not a repeatable instrument on these last four hundred
 * metres: it takes a different line and a different speed depending on where
 * the drive-in began, and on all three seeds it loses the car at least once on
 * the final corner. One sweep therefore reports one drive, not the run-in. So
 * four sweeps are run with the drive-in ending at four different points, and
 * this pools them: per station, the median and the range of the crowd
 * footprint, the tallest figure and the gate footprint, and how many of the
 * four runs had both crowd and gate on screen at once.
 *
 *   node tools/kfagg.mjs [--runs kfsweep,kfsweep-pre60,kfsweep-pre90,kfsweep-pre120]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const RUNS = flag('runs', 'kfsweep,kfsweep-pre60,kfsweep-pre90,kfsweep-pre120').split(',');
const STATIONS = flag('stations', '110,90,80,70,60,50,40,30,20,12,6,0').split(',').map(Number);
const dir = path.join(ROOT, '.meas', 'r2');

const med = a => {
  const b = [...a].sort((x, y) => x - y);
  return b.length % 2 ? b[(b.length - 1) / 2] : Math.round((b[b.length / 2 - 1] + b[b.length / 2]) / 2);
};

const runs = RUNS.map(r => JSON.parse(fs.readFileSync(path.join(dir, r + '.json'), 'utf8')));
const seeds = [...new Set(runs.flatMap(r => r.map(s => s.seed)))];
const lines = [];
const say = s => { console.log(s); lines.push(s); };

const out = [];
for (const seed of seeds) {
  const per = runs.map(r => r.find(s => s.seed === seed)).filter(Boolean);
  const head = per[0];
  say(`\n══ seed ${seed} ══  L=${head.L}  site s=${head.siteS}`
    + ` (${(head.L - head.siteS).toFixed(0)} m before the line)  ${head.n} figures`
    + `   ${per.length} independent run-ins pooled`);
  say('    m before   crowd px  (min–max)        tallest px (min–max)   gate px  (min–max)'
    + '        both on screen   crowd in frame');
  const table = [];
  for (const st of STATIONS) {
    const rs = per.map(p => p.rows.find(r => r.back === st)).filter(Boolean);
    if (!rs.length) continue;
    const c = rs.map(r => r.crowd), t = rs.map(r => r.tallest), gt = rs.map(r => r.gate);
    const both = rs.filter(r => r.crowd > 0 && r.gate > 0).length;
    const inF = rs.filter(r => r.crowd > 0).length;
    say(`    ${String(st).padStart(6)} m  ${String(med(c)).padStart(8)}`
      + `  (${Math.min(...c)}–${Math.max(...c)})`.padEnd(18)
      + `  ${String(med(t)).padStart(7)}   (${Math.min(...t)}–${Math.max(...t)})`.padEnd(24)
      + `  ${String(med(gt)).padStart(7)}  (${Math.min(...gt)}–${Math.max(...gt)})`.padEnd(22)
      + `   ${both}/${rs.length}`.padEnd(10)
      + `      ${inF}/${rs.length}`);
    table.push({
      back: st, n: rs.length,
      crowd: { med: med(c), min: Math.min(...c), max: Math.max(...c), all: c },
      tallest: { med: med(t), min: Math.min(...t), max: Math.max(...t), all: t },
      gate: { med: med(gt), min: Math.min(...gt), max: Math.max(...gt), all: gt },
      both, inFrame: inF,
    });
  }
  const s20 = per.map(p => p.s20), s40 = per.map(p => p.s40);
  say(`    screen time > 20 px: measured ${s20.map(x => x.sec).join(' / ')} s`
    + `   speed-normalised ${s20.map(x => x.secClean).join(' / ')} s`
    + `   span ${s20.map(x => `${x.from}→${x.to}m`).join(' / ')}`);
  say(`    screen time > 40 px: measured ${s40.map(x => x.sec).join(' / ')} s`
    + `   speed-normalised ${s40.map(x => x.secClean).join(' / ')} s`
    + `   span ${s40.map(x => `${x.from}→${x.to}m`).join(' / ')}`);

  // Where the crowd last registers a pixel, per run.
  const last = per.map(p => {
    const v = p.rows.filter(r => r.crowd > 0);
    return v.length ? v[v.length - 1].back : null;
  });
  const first = per.map(p => {
    const v = p.rows.filter(r => r.crowd > 0);
    return v.length ? v[0].back : null;
  });
  say(`    first pixel at ${first.join(' / ')} m before the line;`
    + ` last pixel at ${last.join(' / ')} m before the line`);
  out.push({ seed, L: head.L, siteS: head.siteS, n: head.n, table, s20, s40, first, last });
}

fs.writeFileSync(path.join(dir, 'kfagg.json'), JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(dir, 'kfagg.txt'), lines.join('\n') + '\n');
console.log(`\n  → ${path.join(dir, 'kfagg.txt')}`);
