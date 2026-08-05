/* What does the route offer a crowd?
 *
 * System 3 places spectators at four kinds of place: the exit of a sharp turn,
 * the top of a rise, beside a ramp landing, and the finish. Three of those are
 * facts about the layout and the layout moves hundreds of metres between
 * seeds, so this dumps what is actually there before anything is planted.
 *
 * Reports, per seed: the tightest corners and where their exits are, every
 * local crest in the elevation profile, the ramp landings pickRamps chose, and
 * how much standable shoulder each candidate has on each side.
 *
 *   node tools/crowdscout.mjs [--seeds 22,1,40]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');

for (const seed of SEEDS) {
  await run({
    width: 320, height: 200,
    hash: `manual&tier=high&seed=${seed}&cap=60&hud=0`,
  }, async ({ page }) => {
    const out = await page.evaluate(() => {
      const g = window.__game;
      const t = g.track;
      const field = g.field;
      const L = t.length;

      /* Corners, as runs of same-signed curvature above a threshold. */
      const corners = [];
      let run = null;
      for (let s = 0; s <= L; s += 3) {
        const c = t.frameAt(s).curv;
        const sign = Math.abs(c) > 0.006 ? Math.sign(c) : 0;
        if (sign && run && run.sign === sign) {
          run.s1 = s;
          if (Math.abs(c) > Math.abs(run.peak)) { run.peak = c; run.apex = s; }
        } else if (sign) {
          if (run) corners.push(run);
          run = { sign, s0: s, s1: s, peak: c, apex: s };
        } else if (run && s - run.s1 > 18) {
          corners.push(run); run = null;
        }
      }
      if (run) corners.push(run);
      const named = corners
        .filter(c => c.s1 - c.s0 > 20)
        .map(c => ({
          apex: +c.apex.toFixed(0), exit: +c.s1.toFixed(0),
          arc: +(c.s1 - c.s0).toFixed(0),
          radius: +(1 / Math.abs(c.peak)).toFixed(0),
          sign: c.sign,
          /* Total heading change through the run — a hairpin is defined by how
             far round it goes, not by its tightest instant. */
          turn: +(Math.abs(c.peak) * (c.s1 - c.s0) * 57.3).toFixed(0),
        }))
        .sort((a, b) => a.radius - b.radius);

      /* Crests: local maxima of a smoothed elevation profile. The stage falls
         470 m, so "the top of a hill" here means a place where it briefly
         stops falling, not an absolute summit. */
      const step = 12;
      const n = Math.floor(L / step);
      const y = [];
      for (let i = 0; i <= n; i++) y.push(t.frameAt(i * step).pos.y);
      const sm = y.map((_, i) => {
        let a = 0, k = 0;
        for (let j = Math.max(0, i - 3); j <= Math.min(n, i + 3); j++) { a += y[j]; k++; }
        return a / k;
      });
      const crests = [];
      for (let i = 4; i < n - 4; i++) {
        if (sm[i] < sm[i - 1] || sm[i] < sm[i + 1]) continue;
        /* Prominence, both ways, over 150 m. */
        let dl = 0, dr = 0;
        for (let j = i; j >= Math.max(0, i - 13); j--) dl = Math.max(dl, sm[i] - sm[j]);
        for (let j = i; j <= Math.min(n, i + 13); j++) dr = Math.max(dr, sm[i] - sm[j]);
        const prom = Math.min(dl, dr);
        if (prom < 0.15) continue;
        if (crests.length && i * step - crests[crests.length - 1].s < 160) {
          if (prom > crests[crests.length - 1].prom) crests[crests.length - 1] = { s: i * step, prom: +prom.toFixed(2) };
          continue;
        }
        crests.push({ s: i * step, prom: +prom.toFixed(2) });
      }

      /* Brows: convex points on a road that never actually goes up. The stage
         is a 470 m descent, so an absolute summit is not a thing it has; what
         it has is places where the fall steepens, which from the seat is a
         crest you go light over and cannot see past. Measured as the height of
         the road above the chord between the points 70 m either side. */
      const brows = [];
      for (let s = 120; s < L - 200; s += 6) {
        const a = t.frameAt(s - 70).pos.y, b = t.frameAt(s + 70).pos.y;
        const sag = t.frameAt(s).pos.y - (a + b) * 0.5;
        if (sag < 0.25) continue;
        if (brows.length && s - brows[brows.length - 1].s < 200) {
          if (sag > brows[brows.length - 1].sag) brows[brows.length - 1] = { s, sag: +sag.toFixed(2) };
          continue;
        }
        brows.push({ s, sag: +sag.toFixed(2) });
      }

      const shoulder = s => {
        const r = {};
        for (const side of [-1, 1]) {
          const p = field.profile(s, side);
          r[side < 0 ? 'L' : 'R'] = {
            wall: +p.wallDist.toFixed(1),
            coast: +p.coastness.toFixed(2),
            drop: +p.dropness.toFixed(2),
          };
        }
        return r;
      };

      return {
        length: +L.toFixed(0),
        drop: +(t.startY - t.endY).toFixed(0),
        ramps: (t.ramps || []).map(r => ({
          lip: +r.lip.toFixed(0), land: +r.land.toFixed(0), air: r.air,
          dist: r.dist, speed: r.speed, sh: shoulder(r.land),
        })),
        hairpins: named.slice(0, 6).map(c => ({ ...c, sh: shoulder(c.exit + 25) })),
        crests: crests.sort((a, b) => b.prom - a.prom).slice(0, 4)
          .map(c => ({ ...c, sh: shoulder(c.s) })),
        brows: brows.sort((a, b) => b.sag - a.sag).slice(0, 6)
          .map(c => ({ ...c, sh: shoulder(c.s) })),
        finish: { s: +(L - 12).toFixed(0), sh: shoulder(L - 30) },
        tunnel: g.field.tunnel ? [g.field.tunnel.s0, g.field.tunnel.s1] : null,
      };
    });

    const sh = o => `L${o.L.wall}/c${o.L.coast}/d${o.L.drop}  R${o.R.wall}/c${o.R.coast}/d${o.R.drop}`;
    console.log(`\n══ seed ${seed}   ${out.length} m, ${out.drop} m drop, `
      + `bore ${out.tunnel ? out.tunnel.map(v => v.toFixed(0)).join('-') : 'none'}`);
    console.log('  ramps:');
    for (const r of out.ramps) {
      console.log(`    lip ${String(r.lip).padStart(4)}  land ${String(r.land).padStart(4)}`
        + `  ${r.dist} m of air at ${r.speed} m/s   ${sh(r.sh)}`);
    }
    console.log('  tightest corners (exit + 25 m):');
    for (const c of out.hairpins) {
      console.log(`    apex ${String(c.apex).padStart(4)}  exit ${String(c.exit).padStart(4)}`
        + `  R${String(c.radius).padStart(3)} m  ${String(c.turn).padStart(3)}deg  ${sh(c.sh)}`);
    }
    console.log(`  crests (true local maxima): ${out.crests.length || 'NONE'}`);
    for (const c of out.crests) {
      console.log(`    s ${String(c.s).padStart(4)}  prominence ${String(c.prom).padStart(5)} m   ${sh(c.sh)}`);
    }
    console.log('  brows (convex over a 140 m chord):');
    for (const c of out.brows) {
      console.log(`    s ${String(c.s).padStart(4)}  rise over chord ${String(c.sag).padStart(5)} m   ${sh(c.sh)}`);
    }
    console.log(`  finish s ${out.finish.s}   ${sh(out.finish.sh)}`);
  });
}
console.log();
finish(process.exitCode || 0);
