/* AUDIT PROBE (round 2) — how common is the condition that hides seed 40's
 * s=4150 site: a second, higher `landform` surface over the shoulder the crowd
 * model reasons about.
 *
 * tools/kcladder.mjs establishes that at s=4100–4150 on seed 40 a vertical line
 * through the inland shoulder crosses `landform--1` twice, that `drawnGroundY`
 * matches the LOWER surface to within 0.03 m, and that the sightline is stopped
 * by the UPPER one. `crowdSeen` has no term for a second surface, so it reports
 * clear.
 *
 * This asks the stage how often that is true — at every placed figure, and on a
 * sweep of both shoulders — so the finding can be called isolated or a pattern
 * on a count rather than on one site.
 *
 *   node tools/kcfold.mjs [--seed 40] [--step 12]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '40');
const STEP = Number(flag('step', '12'));

await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(900_000);
  const res = await page.evaluate(([step]) => {
    const g = window.__game;
    const THREE = g.THREE;
    const t = g.track;
    const env = g.scene.getObjectByName('environment');
    const probe = env.userData.crowdProbe;
    const L = t.length;

    const skip = /sky-dome|sun-disc|ocean-bands|shore-foam|block-clouds|bird|crowd/i;
    const targets = [];
    g.stage.updateMatrixWorld(true);
    g.stage.traverse(o => {
      if (!o.isMesh) return;
      let nm = o.name;
      for (let q = o.parent; !nm && q; q = q.parent) nm = q.name;
      if (skip.test(nm || '')) return;
      o.userData.__probeName = nm || '(unnamed)';
      targets.push(o);
    });
    const ray = new THREE.Raycaster();
    const landHits = (x, z) => {
      ray.far = 1400;
      ray.set(new THREE.Vector3(x, 600, z), new THREE.Vector3(0, -1, 0));
      /* Everything solid, not just the landform: seed 1's s=2143 group stands
         under the road deck of the hairpin's other leg, and a filter that only
         admitted terrain reported it as unroofed. */
      return ray.intersectObjects(targets, false)
        .map(h => ({ y: h.point.y, what: h.object.userData.__probeName }));
    };

    // ── every placed figure ──────────────────────────────────────────────
    const mesh = g.scene.getObjectByName('crowd-figures');
    const place = mesh.geometry.getAttribute('aPlace');
    const sites = g.crowd.sites;
    const perSite = sites.map(s => ({
      kind: s.kind, s: +s.s.toFixed(0), side: s.side ?? null, seen: s.seen ?? null,
      out: s.u != null && s.side ? +(s.u * probe.wallDist(s.s, s.side)).toFixed(1) : null,
      n: 0, roofed: 0, worstRoof: null,
    }));
    const figs = [];
    for (let i = 0; i < place.count; i++) {
      const x = place.getX(i), y = place.getY(i), z = place.getZ(i);
      const h = place.getW(i);
      let k = -1, bd = Infinity;
      for (let q = 0; q < sites.length; q++) {
        const a = sites[q].at; if (!a) continue;
        const d = Math.hypot(x - a.x, z - a.z);
        if (d < bd) { bd = d; k = q; }
      }
      const hits = landHits(x, z);
      /* A roof over the figure, and near enough to be one. A mountainside three
         hundred metres straight up is not what hides a spectator, and counting
         it makes the tally meaningless — the cap is generous rather than tuned. */
      const above = hits.filter(hh => hh.y > y + h && hh.y < y + 40).sort((a, b) => a.y - b.y);
      perSite[k].n++;
      if (above.length) {
        perSite[k].roofed++;
        const clear = +(above[0].y - y).toFixed(2);
        if (perSite[k].worstRoof === null || clear > perSite[k].worstRoof) perSite[k].worstRoof = clear;
      }
      figs.push({
        i, site: k, feet: +y.toFixed(2), h: +h.toFixed(2),
        nLand: hits.length,
        roofAt: above.length ? +(above[0].y - y).toFixed(2) : null,
        roofWhat: above.length ? above[0].what : null,
      });
    }

    // ── the whole stage, both shoulders, at the crowd's standing distance ─
    const stand = probe.stand_m;
    let n = 0, roofed = 0;
    const spans = [];
    let open = null;
    for (let s = 60; s < L - 25; s += step) {
      for (const side of [-1, 1]) {
        const wall = probe.wallDist(s, side);
        const p = probe.point(s, side, Math.min(0.86, stand / wall));
        const gy = probe.drawnY(s, side, Math.min(0.86, stand / wall));
        const hits = landHits(p.x, p.z);
        const above = hits.filter(hh => hh.y > gy + 2.0 && hh.y < gy + 40).sort((a, b) => a.y - b.y);
        n++;
        if (above.length) {
          roofed++;
          if (side === -1) {
            if (open && s - open.s1 <= step * 1.5) { open.s1 = s; open.max = Math.max(open.max, above[0].y - gy); }
            else { if (open) spans.push(open); open = { s0: s, s1: s, max: above[0].y - gy }; }
          }
        }
      }
    }
    if (open) spans.push(open);
    return {
      length: Math.round(L), stand,
      perSite, figs, sweep: { n, roofed },
      spans: spans.filter(sp => sp.s1 - sp.s0 >= step)
        .map(sp => ({ s0: sp.s0, s1: sp.s1, m: sp.s1 - sp.s0, max: +sp.max.toFixed(1) }))
        .sort((a, b) => b.m - a.m).slice(0, 12),
    };
  }, [STEP]);

  console.log(`\n  seed ${SEED} — a second landform/rock surface over the crowd's shoulder`);
  console.log(`  stage sweep at ${res.stand} m off the road edge, both shoulders:`
    + ` ${res.sweep.roofed} of ${res.sweep.n} stations have solid geometry more than 2 m`
    + ` above the shoulder`
    + `  (${(100 * res.sweep.roofed / res.sweep.n).toFixed(1)}%)`);
  console.log('\n  longest inland runs where that is true:');
  for (const sp of res.spans) {
    console.log(`    s ${String(sp.s0).padStart(5)}–${String(sp.s1).padStart(5)}`
      + `  (${String(sp.m).padStart(4)} m)   upper surface up to ${sp.max} m over the shoulder`);
  }
  console.log('\n  per site — figures with a drawn surface OVER THEIR HEADS:');
  console.log('    site               s  side  model   figs  roofed   lowest roof above the feet');
  for (const p of res.perSite) {
    console.log(`    ${p.kind.padEnd(14)} ${String(p.s).padStart(5)} ${String(p.side).padStart(5)}`
      + `  ${String(p.seen === null ? '—' : p.seen).padStart(5)}`
      + `  ${String(p.n).padStart(5)}  ${String(p.roofed).padStart(6)}`
      + `   ${p.worstRoof === null ? '—' : p.worstRoof + ' m'}`);
  }
  const jf = path.join(ROOT, '.meas', 'r2', `kcfold-${SEED}.json`);
  fs.mkdirSync(path.dirname(jf), { recursive: true });
  fs.writeFileSync(jf, JSON.stringify(res, null, 1));
  console.log('\n  json → ' + jf + '\n');
});
finish(process.exitCode || 0);
