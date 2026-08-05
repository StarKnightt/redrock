/* MEASUREMENT PROBE (round-2 audit) — the crowd inventory, off the built stage.
 *
 * No rendering: this is the model's own view of itself. Sites, stations, the
 * scheduler's log, and every instance attribute on the crowd mesh, with each
 * figure attributed to a site by projecting its world position back onto the
 * track and taking the nearest station.
 *
 *   node tools/ksinv.mjs [--seed 22]
 *
 * Writes .meas/r2/ksinv-<seed>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');

const OUT = path.resolve('.meas/r2');
fs.mkdirSync(OUT, { recursive: true });

await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(600_000);
  const out = await page.evaluate(() => {
    const g = window.__game;
    if (!g.crowd) return { none: true };
    const env = g.scene.getObjectByName('environment');
    const probe = env.userData.crowdProbe;
    const clock = probe.clock;
    const mesh = g.scene.getObjectByName('crowd-figures');
    const A = mesh.geometry.attributes;
    const n = A.aPlace.count;
    const hex = v => '#' + Math.round(v).toString(16).padStart(6, '0');

    const sites = g.crowd.sites.map((p, i) => ({
      i, kind: p.kind, s: +p.s.toFixed(1), side: p.side,
      u: p.u === undefined ? null : +p.u.toFixed(3),
      seen: p.seen ?? null,
      rise: p.rise === undefined ? null : +p.rise.toFixed(2),
      cheer: !!p.cheer,
      t: +clock(p.s).toFixed(2),
      nGroups: p.groups ? p.groups.length : 0,
      groups: (p.groups || []).map(gr => ({ cheer: gr.cheer, n: gr.n, s: +gr.s.toFixed(1) })),
      declared: (p.groups || []).reduce((a, b) => a + b.n, 0),
    }));

    /* Which site built which instance.
     *
     * By build order, not by geometry. buildCrowd walks `sites` in ascending
     * station and pushes each site's figures in turn, then appends the start
     * line squad last; so the instance buffer is the sites' declared counts
     * laid end to end. Projecting a figure's world position back onto the road
     * and taking the nearest station LOOKS more robust and is not: through the
     * switchbacks the shoulder at a hairpin exit is physically nearer the road
     * on the far side of the hairpin, and on seed 1 that moved all four
     * figures off site 7 (s=2143) onto site 6 (s=1929), which then reported
     * nine of a declared five. Order is exact when the counts add up, which is
     * checked rather than assumed. */
    const ordered = sites.filter(p => p.kind !== 'start line');
    const startSite = sites.find(p => p.kind === 'start line');
    const declSum = ordered.reduce((a, p) => a + p.declared, 0)
      + (startSite ? startSite.declared : 0);
    const owner = new Int32Array(n).fill(-1);
    if (declSum === n) {
      let at = 0;
      for (const p of ordered) { for (let k = 0; k < p.declared; k++) owner[at++] = p.i; }
      if (startSite) for (let k = 0; k < startSite.declared; k++) owner[at++] = startSite.i;
    }

    const figs = [];
    const V = new g.THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const x = A.aPlace.array[i * 4], y = A.aPlace.array[i * 4 + 1];
      const z = A.aPlace.array[i * 4 + 2], h = A.aPlace.array[i * 4 + 3];
      V.set(x, y, z);
      const site = sites.find(p => p.i === owner[i]);
      const pr = g.track.project(V, site ? site.s : -1);
      figs.push({
        i, x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2),
        height: +h.toFixed(3),
        girth: +(A.aBody.array[i * 4] / h).toFixed(3),
        pose: Math.round(A.aBody.array[i * 4 + 1]),
        phase: +A.aBody.array[i * 4 + 2].toFixed(3),
        rate: +A.aBody.array[i * 4 + 3].toFixed(3),
        itemL: +A.aLimb.array[i * 4].toFixed(2),
        itemR: +A.aLimb.array[i * 4 + 1].toFixed(2),
        armL: +A.aLimb.array[i * 4 + 2].toFixed(2),
        armR: +A.aLimb.array[i * 4 + 3].toFixed(2),
        skin: hex(A.aTone.array[i * 4]),
        shirt: hex(A.aTone.array[i * 4 + 1]),
        legs: hex(A.aTone.array[i * 4 + 2]),
        item: hex(A.aTone.array[i * 4 + 3]),
        hair: hex(A.aHairTone.array[i]),
        s: +pr.s.toFixed(1), lat: +pr.lat.toFixed(2), roadDist: +pr.dist.toFixed(2),
      });
    }
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const f = figs[i];
      f.site = owner[i];
      const site = sites.find(p => p.i === owner[i]);
      f.dS = site ? +Math.abs(f.s - site.s).toFixed(1) : null;
      if (f.dS !== null && f.dS > worst) worst = f.dS;
    }

    return {
      assignOK: declSum === n, declSum,
      seed: g.seed ?? null,
      length: +g.track.length.toFixed(1),
      lapClock: +clock.lap.toFixed(2),
      startS: probe.startS,
      figures: g.crowd.figures, triangles: g.crowd.triangles,
      instances: n,
      sites, figs, worstAssign: +worst.toFixed(1),
      plan: probe.plan(),
      startClock: +clock(probe.startS).toFixed(2),
    };
  });

  if (out.none) { console.log('  no crowd'); return; }
  fs.writeFileSync(path.join(OUT, `ksinv-${SEED}.json`), JSON.stringify(out, null, 1));

  const P = ['cheer', 'flag', 'sit', 'pom'];
  console.log(`\n=== SEED ${SEED} — inventory ===`);
  console.log(`  track ${out.length} m,  lap clock ${out.lapClock} s,`
    + `  ${out.sites.length} sites,  ${out.figures} figures,  ${out.triangles} triangles`);
  console.log(`  build-order attribution ${out.assignOK ? 'exact' : 'FAILED'}`
    + ` (declared ${out.declSum} vs ${out.instances} instances);`
    + `  worst |figure s - site s| = ${out.worstAssign} m`);

  const per = out.sites.map(p => out.figs.filter(f => f.site === p.i));
  console.log('\n   #  kind            s       t(s)  side  seen rise   grps  decl  built  poses(c/f/s/p)');
  out.sites.forEach((p, k) => {
    const fs2 = per[k];
    const h = [0, 0, 0, 0];
    fs2.forEach(f => h[f.pose]++);
    console.log(`  ${String(p.i).padStart(2)}  ${p.kind.padEnd(14)}`
      + `${String(p.s).padStart(6)} ${String(p.t).padStart(8)}`
      + `  ${String(p.side).padStart(4)}  ${String(p.seen).padStart(4)}`
      + ` ${String(p.rise).padStart(5)}  ${String(p.nGroups).padStart(4)}`
      + `  ${String(p.declared).padStart(4)}  ${String(fs2.length).padStart(5)}`
      + `   ${h.join('/')}`);
  });

  console.log('\n  SPACING between consecutive sites:');
  console.log('     from -> to        dm (m)   dt (s)');
  for (let i = 1; i < out.sites.length; i++) {
    const a = out.sites[i - 1], b = out.sites[i];
    console.log(`    ${String(a.s).padStart(6)} -> ${String(b.s).padStart(6)}`
      + `  ${(b.s - a.s).toFixed(1).padStart(8)} ${(b.t - a.t).toFixed(2).padStart(8)}`);
  }
  const lastT = out.sites[out.sites.length - 1].t;
  console.log(`    tail: last site t=${lastT} s to lap end ${out.lapClock} s`
    + ` = ${(out.lapClock - lastT).toFixed(2)} s`);

  const pose = [0, 0, 0, 0];
  out.figs.forEach(f => pose[f.pose]++);
  const tot = out.figs.length;
  console.log('\n  STAGE POSE MIX: ' + pose.map((v, i) =>
    `${P[i]} ${v} (${(100 * v / tot).toFixed(1)}%)`).join('   '));

  console.log('\n  SCHEDULER LOG (crowdProbe.plan()):');
  out.plan.forEach((l, i) => console.log(`   ${String(i + 1).padStart(3)}  ${l}`));
  const placed = out.plan.filter(l => / PLACED /.test(l)).length;
  const gapLines = out.plan.filter(l => /^gap fill/.test(l));
  const gapTook = gapLines.filter(l => / takes /.test(l)).length;
  const gapWalk = gapLines.filter(l => /walked the hole/.test(l)).length;
  console.log(`\n  ranked-pass PLACED lines: ${placed}`);
  console.log(`  "gap fill" lines total: ${gapLines.length}`);
  console.log(`    of which took a ranked candidate ("takes"): ${gapTook}`);
  console.log(`    of which "walked the hole" roadside fallback: ${gapWalk}`);
  console.log(`    of which found nothing: ${gapLines.length - gapTook - gapWalk}`);
  console.log(`  sites by kind in the built stage: ` + JSON.stringify(
    out.sites.reduce((a, p) => (a[p.kind] = (a[p.kind] || 0) + 1, a), {})));
  console.log();
});
finish(process.exitCode || 0);
