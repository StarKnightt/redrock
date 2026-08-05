/* Roll the three seeds' JSON up into one table, so the report quotes one
 * source. Reads .meas/r2/ksinv-*.json, kslap-*.json, kspose-*.json.
 *
 *   node tools/ksroll.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('.meas/r2');
const SEEDS = ['22', '1', '40'];
const rd = (p) => JSON.parse(fs.readFileSync(path.join(OUT, p), 'utf8'));
const P = ['cheer', 'flag', 'sit', 'pom'];

const all = {};
for (const s of SEEDS) {
  all[s] = { inv: rd(`ksinv-${s}.json`), lap: rd(`kslap-${s}.json`), pose: rd(`kspose-${s}.json`) };
}

console.log('== A. INVENTORY ==');
console.log('seed  track_m  lap_s   sites  figures  fig_tris  total_tris  ranked  gapfill_ranked  gapfill_walked  gapfill_failed');
for (const s of SEEDS) {
  const i = all[s].inv;
  const gl = i.plan.filter(l => /^gap fill/.test(l));
  const took = gl.filter(l => / takes /.test(l)).length;
  const walk = gl.filter(l => /walked the hole/.test(l)).length;
  console.log(`${s.padStart(4)}  ${String(i.length).padStart(7)}  ${String(i.lapClock).padStart(6)}`
    + `  ${String(i.sites.length).padStart(5)}  ${String(i.figures).padStart(7)}`
    + `  ${String(i.figures * 18).padStart(8)}  ${String(i.triangles).padStart(10)}`
    + `  ${String(i.plan.filter(l => / PLACED /.test(l)).length).padStart(6)}`
    + `  ${String(took).padStart(14)}  ${String(walk).padStart(14)}`
    + `  ${String(gl.length - took - walk).padStart(14)}`);
}

for (const s of SEEDS) {
  const i = all[s].inv, po = all[s].pose;
  console.log(`\n-- seed ${s}: sites (spacing to the NEXT site) --`);
  console.log('  #  kind          station  t_s     side  figs  groups  next_dm  next_dt   poses c/f/s/p  maxSamePose  maxShirt  maxKit');
  i.sites.forEach((p, k) => {
    const nx = i.sites[k + 1];
    const q = po.sites.find(x => x.i === p.i);
    console.log(`  ${String(p.i).padStart(2)} ${p.kind.padEnd(13)}`
      + `${String(Math.round(p.s)).padStart(7)} ${String(p.t).padStart(7)}`
      + `${String(p.side).padStart(6)} ${String(q.n).padStart(5)}`
      + `${String(p.nGroups).padStart(8)}`
      + `${nx ? (nx.s - p.s).toFixed(0).padStart(9) : '        -'}`
      + `${nx ? (nx.t - p.t).toFixed(2).padStart(9) : '        -'}`
      + `   ${q.hist.join('/').padEnd(12)}${String(q.maxSame).padStart(11)}`
      + `${String(q.maxShirt).padStart(10)}${String(q.maxKit).padStart(8)}`);
  });
  const dt = i.sites.slice(1).map((p, k) => p.t - i.sites[k].t);
  const dm = i.sites.slice(1).map((p, k) => p.s - i.sites[k].s);
  const mn = a => Math.min(...a), mx = a => Math.max(...a);
  const av = a => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`  spacing: ${dm.length} intervals — metres min ${mn(dm).toFixed(0)}`
    + ` median ${dm.slice().sort((a, b) => a - b)[dm.length >> 1].toFixed(0)}`
    + ` max ${mx(dm).toFixed(0)} mean ${av(dm).toFixed(0)};`
    + `  seconds min ${mn(dt).toFixed(2)}`
    + ` median ${dt.slice().sort((a, b) => a - b)[dt.length >> 1].toFixed(2)}`
    + ` max ${mx(dt).toFixed(2)} mean ${av(dt).toFixed(2)}`);
  console.log(`  intervals under 10 s: ${dt.filter(x => x < 10).length}`
    + `;  under 7 s: ${dt.filter(x => x < 7).length}`);
}

console.log('\n== B. IN-FRAME DENSITY ==');
console.log('seed  lap_s  samples  sites_any 0/1/2/3+ %            sites_leg 0/1/2/3+ %          legfigs 0/1-3/4-8/9-15/16+ %');
for (const s of SEEDS) {
  const d = all[s].lap;
  const f = o => Object.values(o).map(v => String(v).padStart(5)).join('/');
  console.log(`${s.padStart(4)}  ${String(d.lap).padStart(6)} ${String(d.nSamples).padStart(7)}`
    + `   ${f(d.dist.sitesAny)}   ${f(d.dist.sitesLeg)}   ${f(d.dist.legFigs)}`);
}
console.log('\nseed  sitesAny p50/p90/p99/max   sitesLeg p50/p90/p99/max   legFigs p50/p90/p99/max   cover p50/p90/p99/MAX %');
for (const s of SEEDS) {
  const d = all[s].lap, t = d.stat;
  const q = o => `${o.p50}/${o.p90}/${o.p99}/${o.max}`;
  console.log(`${s.padStart(4)}  ${q(t.sitesAny).padStart(18)}   ${q(t.sitesLeg).padStart(18)}`
    + `   ${q(t.legFigs).padStart(18)}`
    + `   ${t.coverP50Pct}/${t.coverP90Pct}/${t.coverP99Pct}/${t.coverMaxPct}`);
}
console.log('\nseed  longest >=2 sites any   longest >=2 sites legible   longest >=9 legible figs   time with >=1 legible');
for (const s of SEEDS) {
  const d = all[s].lap, st = d.stretch;
  const top = a => a.length ? `${a[0].dt} s @ t=${a[0].t0}` : 'never';
  console.log(`${s.padStart(4)}  ${top(st.sites2any).padStart(21)}   ${top(st.sites2leg).padStart(25)}`
    + `   ${top(st.leg9).padStart(24)}   ${st.totalLeg1} s`
    + ` (${(100 * st.totalLeg1 / d.lap).toFixed(1)}%)`);
}

console.log('\n== C. ADJACENT PAIRS ==');
for (const s of SEEDS) {
  const d = all[s].lap;
  console.log(`seed ${s}: ${d.pairs.length} of ${d.sites.length - 1} adjacent pairs`
    + ` (${d.pairs.filter(p => p.overlap).length} overlap, `
    + `${d.pairs.filter(p => !p.overlap).length} join inside 3 s)`);
  d.pairs.forEach(p => console.log(`   ${p.a}+${p.b}  ${p.aKind}@${Math.round(p.aS)}`
    + ` -> ${p.bKind}@${Math.round(p.bS)}  ${p.dS} m  `
    + (p.overlap ? `overlap ${p.overlapSec} s (${p.overlapSamples} samples), worst t=${p.at.t} s, ${p.at.nLeg} legible`
      : `gap ${p.minGap} s`)));
}

console.log('\n== D. POSE MIX vs CLAIM (cheer 32 / flag 35 / sit 12 / pom 21) ==');
console.log('seed  n   cheer%   flag%    sit%     pom%');
for (const s of SEEDS) {
  const p = all[s].pose;
  console.log(`${s.padStart(4)} ${String(p.figures).padStart(3)}`
    + p.mixPct.map(v => String(v).padStart(8)).join(''));
}
{
  const tot = [0, 0, 0, 0]; let n = 0;
  for (const s of SEEDS) { all[s].pose.mix.forEach((v, i) => tot[i] += v); n += all[s].pose.figures; }
  console.log(` all ${String(n).padStart(3)}`
    + tot.map(v => String((100 * v / n).toFixed(1)).padStart(8)).join(''));
}

console.log('\n== E. FIGURE PIXEL HEIGHTS (legible samples) ==');
console.log('seed  n_samples  p10  p50  p90  max   <40px%  40-125%  >125%');
for (const s of SEEDS) {
  const h = all[s].lap.hStat;
  console.log(`${s.padStart(4)}  ${String(h.n).padStart(9)}  ${String(h.p10).padStart(3)}`
    + `  ${String(h.p50).padStart(3)}  ${String(h.p90).padStart(3)}  ${String(h.max).padStart(3)}`
    + `   ${String(h.under40).padStart(6)}  ${String(h.band).padStart(7)}  ${String(h.over125).padStart(5)}`);
}

console.log('\n== METHOD CHECKS ==');
for (const s of SEEDS) {
  const d = all[s].lap;
  console.log(`seed ${s}: clock drift ${d.driftMax} px, step() threw ${d.threw},`
    + ` footprint ${d.totalMaskPx} px = ${d.totalUnionPx} figure + ${d.totalRailPx} rail`
    + ` + ${d.unclaimed} unattributed (${(100 * d.unclaimed / d.totalMaskPx).toFixed(1)}%)`);
}
