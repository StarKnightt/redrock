/* kb* probe — crowd bookkeeping, no rendering.
 *
 * Answers the cheap half of the zqboots instrument audit:
 *   - how many figures exist, how many fall inside SOME site's 26 m radius,
 *     how many are orphaned, how many are claimed by two or more sites
 *   - what the finish site is and where it sits relative to the finish gate
 *   - the spread of figure heights and instance-origin distances
 *
 *   node tools/kbsites.mjs [--seeds 22,1,40] [--radius 26]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');
const RADIUS = Number(flag('radius', '26'));

for (const SEED of SEEDS) {
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    page.setDefaultTimeout(600_000);
    const out = await page.evaluate(([radius]) => {
      const g = window.__game;
      const t = g.track;
      if (!g.crowd) return { none: true };
      const mesh = g.scene.getObjectByName('crowd-figures');
      const place = mesh.geometry.getAttribute('aPlace');
      const n = place.count;
      const sites = g.crowd.sites;
      const owners = [];
      for (let i = 0; i < n; i++) owners.push([]);
      const perSite = sites.map((site, si) => {
        const mine = [];
        for (let i = 0; i < n; i++) {
          const d = Math.hypot(place.getX(i) - site.at.x, place.getZ(i) - site.at.z);
          if (d <= radius) { mine.push(i); owners[i].push(si); }
        }
        return {
          si, kind: site.kind, s: +site.s.toFixed(1), side: site.side,
          at: [+site.at.x.toFixed(1), +site.at.y.toFixed(2), +site.at.z.toFixed(1)],
          groups: site.groups ? site.groups.map(gr => ({ cheer: gr.cheer, n: gr.n, s: +gr.s.toFixed(1) })) : null,
          declared: site.groups ? site.groups.reduce((a, b) => a + b.n, 0) : null,
          mine: mine.length,
        };
      });
      const orphans = [];
      let dupes = 0;
      for (let i = 0; i < n; i++) {
        if (owners[i].length === 0) {
          // nearest site, so an orphan can be described rather than just counted
          let best = -1, bd = Infinity;
          for (let si = 0; si < sites.length; si++) {
            const d = Math.hypot(place.getX(i) - sites[si].at.x, place.getZ(i) - sites[si].at.z);
            if (d < bd) { bd = d; best = si; }
          }
          orphans.push({
            i, x: +place.getX(i).toFixed(1), y: +place.getY(i).toFixed(2),
            z: +place.getZ(i).toFixed(1), h: +place.getW(i).toFixed(2),
            nearestSite: best, nearestKind: sites[best]?.kind, nearestS: +(sites[best]?.s ?? 0).toFixed(0),
            dist: +bd.toFixed(1),
          });
        }
        if (owners[i].length > 1) dupes++;
      }
      // union of all claimed
      let claimed = 0;
      for (let i = 0; i < n; i++) if (owners[i].length) claimed++;

      const heights = [];
      for (let i = 0; i < n; i++) heights.push(place.getW(i));
      heights.sort((a, b) => a - b);

      // finish site
      const fin = sites.filter(s2 => s2.kind === 'finish');
      const gate = t.gateS;
      const finishInfo = fin.map(site => {
        const mine = [];
        for (let i = 0; i < n; i++) {
          if (Math.hypot(place.getX(i) - site.at.x, place.getZ(i) - site.at.z) <= radius) mine.push(i);
        }
        return {
          kind: site.kind, s: +site.s.toFixed(1), side: site.side,
          at: [+site.at.x.toFixed(1), +site.at.y.toFixed(2), +site.at.z.toFixed(1)],
          gate: +gate.toFixed(1), fromGate: +(site.s - gate).toFixed(1),
          groups: site.groups.map(gr => ({ cheer: gr.cheer, n: gr.n, s: +gr.s.toFixed(1) })),
          declared: site.groups.reduce((a, b) => a + b.n, 0),
          held: mine.length,
          figures: mine.map(i => ({
            i, x: +place.getX(i).toFixed(2), y: +place.getY(i).toFixed(2),
            z: +place.getZ(i).toFixed(2), h: +place.getW(i).toFixed(2),
            ds: null,
          })),
        };
      });
      return {
        length: +t.length.toFixed(1), figures: n, reported: g.crowd.figures,
        sites: perSite, orphans, dupes, claimed, finishInfo,
        hMin: +heights[0].toFixed(2), hMax: +heights[heights.length - 1].toFixed(2),
        hMed: +heights[heights.length >> 1].toFixed(2),
      };
    }, [RADIUS]);

    if (out.none) { console.log(`seed ${SEED}: no crowd`); return; }
    console.log(`\n══ seed ${SEED}  track ${out.length} m  figures ${out.figures} (crowd.figures=${out.reported})`);
    console.log(`   heights ${out.hMin} / ${out.hMed} / ${out.hMax} m`);
    console.log(`   sites ${out.sites.length}   claimed by >=1 site: ${out.claimed}`
      + `   ORPHANS: ${out.orphans.length}   claimed by >1 site: ${out.dupes}`);
    for (const s of out.sites) {
      console.log(`     [${String(s.si).padStart(2)}] ${String(s.kind).padEnd(14)} s=${String(s.s).padStart(7)} side=${s.side}`
        + `  declared ${s.declared}  within ${RADIUS}m of at: ${s.mine}`
        + (s.declared !== s.mine ? `   ◀── MISMATCH ${s.mine - s.declared}` : ''));
    }
    for (const o of out.orphans) {
      console.log(`     ORPHAN i=${o.i} (${o.x},${o.y},${o.z}) h=${o.h}`
        + `  nearest site [${o.nearestSite}] ${o.nearestKind} s=${o.nearestS} at ${o.dist} m`);
    }
    for (const f of out.finishInfo) {
      console.log(`   FINISH  s=${f.s} side=${f.side} at=[${f.at}]  gate=${f.gate}  s-gate=${f.fromGate} m`
        + `   declared ${f.declared}  held ${f.held}`);
      console.log(`     groups: ${f.groups.map(gr => `${gr.cheer ? 'squad' : 'crowd'} n=${gr.n} s=${gr.s}`).join('  |  ')}`);
      for (const fig of f.figures) {
        console.log(`       i=${String(fig.i).padStart(3)}  (${fig.x}, ${fig.y}, ${fig.z})  h=${fig.h}`);
      }
    }
    console.log('JSON ' + JSON.stringify({ seed: SEED, ...out }));
  });
}
finish(process.exitCode || 0);
