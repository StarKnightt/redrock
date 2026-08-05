/* Compare two 32-seed race sweeps.
 *
 * `race.mjs` prints a per-seed block and then two unlabelled summary blocks
 * of the same shape, so a naive grep double-counts. Anchor on the "seed N"
 * header and read the summary lines under it.
 *
 * How far under is not fixed: the header is followed by one line per car, and
 * that is a DNF line or a finish line depending on how the race went. Reading
 * at a fixed offset silently produced a table of NaN for every column, which
 * is worse than failing, because it looks like a sweep that ran. Scan to the
 * next block instead.
 *
 * Usage: node tools/sweepdiff.mjs before.txt after.txt [more.txt ...]
 */
import { readFileSync } from 'node:fs';

function parse(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const out = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*seed (\d+)\s/.exec(lines[i]);
    if (!m) continue;
    let a = '', b = '';
    for (let j = i + 1; j < lines.length && !/^\s*seed \d+\s/.test(lines[j]); j++) {
      if (/all finished:/.test(lines[j])) a = lines[j];
      if (/lead changes/.test(lines[j])) { b = lines[j]; break; }
    }
    const fin = /all finished: (\w+)/.exec(a);
    const lc = /lead changes (\d+)/.exec(b);
    const co = /collisions (\d+)/.exec(b);
    const rec = /recoveries (\d+)/.exec(b);
    const spread = /1st→last ([\d.]+)s/.exec(a);
    const near = /within 2s of player (\d+)%/.exec(b);
    out.set(+m[1], {
      fin: fin?.[1] === 'yes',
      lead: +(lc?.[1] ?? NaN),
      coll: +(co?.[1] ?? NaN),
      rec: +(rec?.[1] ?? NaN),
      spread: +(spread?.[1] ?? NaN),
      near: +(near?.[1] ?? NaN),
    });
  }
  return out;
}

const runs = process.argv.slice(2).map((p) => ({ p, d: parse(p) }));
const seeds = [...runs[0].d.keys()].sort((a, b) => a - b);

const sum = (d, k) => seeds.reduce((t, s) => t + (d.get(s)?.[k] ?? 0), 0);

console.log(`\n  seeds ${seeds.length}\n`);
console.log('  run'.padEnd(26), 'finished  collisions  lead-chg  recoveries  spread  within 2s');
for (const { p, d } of runs) {
  const fin = seeds.filter((s) => d.get(s)?.fin).length;
  console.log(
    `  ${p.split(/[\\/]/).pop()}`.padEnd(26),
    String(`${fin}/${seeds.length}`).padStart(8),
    String(sum(d, 'coll')).padStart(12),
    String(sum(d, 'lead')).padStart(9),
    String(sum(d, 'rec')).padStart(11),
    (sum(d, 'spread') / seeds.length).toFixed(1).padStart(7) + 's',
    (sum(d, 'near') / seeds.length).toFixed(0).padStart(9) + '%',
  );
}

if (runs.length >= 2) {
  const a = runs[0].d, b = runs[runs.length - 1].d;
  console.log('\n  per-seed, first vs last (collisions / lead changes):');
  let worst = [];
  for (const s of seeds) {
    const x = a.get(s), y = b.get(s);
    if (!x || !y) continue;
    worst.push({ s, dc: y.coll - x.coll, dl: y.lead - x.lead, x, y });
  }
  worst.sort((u, v) => Math.abs(v.dc) - Math.abs(u.dc));
  for (const w of worst.slice(0, 8)) {
    console.log(`   seed ${String(w.s).padStart(2)}  coll ${String(w.x.coll).padStart(3)} → ${String(w.y.coll).padStart(3)} (${w.dc >= 0 ? '+' : ''}${w.dc})   lead ${String(w.x.lead).padStart(2)} → ${String(w.y.lead).padStart(2)} (${w.dl >= 0 ? '+' : ''}${w.dl})`);
  }
  const dnf = seeds.filter((s) => !b.get(s)?.fin);
  console.log(`\n  DNF seeds after: ${dnf.length ? dnf.join(', ') : 'none'}`);
}
console.log('');
