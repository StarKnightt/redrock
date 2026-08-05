/* Where the ramps landed, and whether the siting scan's proxies were honest.
 *
 * pickRamps runs at stage-build time, before the road exists, so two of its
 * criteria have to be proxies: standing room for the pulled-back camera boom
 * is asked of the terrain field rather than raycast, and sun exposure is
 * asked of the sun-side wall's elevation rather than traced. This tool boots
 * each seed for real and fires both of those as actual SolidWorld rays, so
 * the proxy can be shown to agree with the thing it stands in for — on every
 * seed, not just the one the stage ships with.
 *
 * It also carries the gate the scan exists to satisfy: at least two viable
 * ramps on every canonical seed.
 *
 *   node tools/rampsite.mjs [--seeds 22,1,...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,7,12,14,16,20,23,26,27,28,34,36,40').split(',').map(Number);

/* What the pullback actually asks for: 9.9 m astern and 3.1 m up, measured
   from the driver's head at 1.2 m. See ChaseCamera's air term — it used to
   ask for 13.4 and 5.5, and the lift and most of the extension were dropped
   because they were measured shrinking the jump they were framing. */
const BOOM_BACK = 9.9, BOOM_UP = 3.1 - 1.2;

const all = {};
let bad = 0;

for (const seed of SEEDS) {
  await run({
    width: 480, height: 270,
    hash: `manual&tier=high&seed=${seed}&cap=0&hud=0`,
  }, async ({ page }) => {
    const out = await page.evaluate(([boomBack, boomUp]) => {
      const g = window.__game;
      const t = g.track;
      const THREE = g.THREE;
      const L = t.length;
      const at = (s) => t.frameAt(Math.max(0, Math.min(L - 1, s)));

      /* The sun as main.js positions it, read off the light rather than
         restated, so this cannot drift from what the frame is lit by. */
      const sun = g.sun.position.clone().sub(g.sun.target.position).normalize();

      /* Nearest guardrail vertex to a corridor, exact — it walks the mesh the
         stage actually built rather than re-deriving the rule. */
      const railNear = (s0, s1) => {
        const rail = g.scene.getObjectByName('guardrail');
        if (!rail) return 999;
        const pos = rail.geometry.attributes.position;
        const v = new THREE.Vector3();
        const pts = [];
        for (let x = s0; x <= s1; x += 6) pts.push(at(x).pos.clone());
        let best = Infinity;
        const step = Math.max(1, Math.floor(pos.count / 6000));
        for (let i = 0; i < pos.count; i += step) {
          v.fromBufferAttribute(pos, i).applyMatrix4(rail.matrixWorld);
          for (const p of pts) best = Math.min(best, v.distanceTo(p));
        }
        return +best.toFixed(1);
      };

      const boom = (s) => {
        const f = at(s);
        const head = f.pos.clone().addScaledVector(f.up, 1.2);
        const dir = f.tan.clone().negate().multiplyScalar(boomBack)
          .addScaledVector(new THREE.Vector3(0, 1, 0), boomUp);
        const len = dir.length();
        dir.normalize();
        const d = g.solid.raycast(head.x, head.y, head.z, dir.x, dir.y, dir.z, len + 2, 0.8);
        return { want: +len.toFixed(1), free: +Math.min(d, len + 2).toFixed(1) };
      };

      /* Is a car three metres over the lip actually in the sun? SolidWorld
         excludes the road, so this only ever reports terrain.
         The threshold is not arbitrary: the shadow camera sits 268 m from the
         car along the sun with a near plane at 40, so nothing further than
         about 228 m toward the sun can put the car in shade whatever it is.
         A hit beyond that is a headland on the horizon — scenery, not shadow. */
      const sunlit = (s) => {
        const f = at(s);
        const p = f.pos.clone().addScaledVector(f.up, 3.0);
        const d = g.solid.raycast(p.x, p.y, p.z, sun.x, sun.y, sun.z, 400, 0.8);
        return { free: +Math.min(d, 400).toFixed(0), lit: d > 200 };
      };

      let bore = null;
      g.scene.traverse(o => { if (o.userData && o.userData.tunnel) bore = o.userData.tunnel; });

      return {
        seed: t.seed, length: +L.toFixed(0),
        bore: bore ? [Math.round(bore.s0), Math.round(bore.s1)] : null,
        ramps: t.ramps.map(r => ({
          ...r,
          frac: +(r.lip / L).toFixed(3),
          kmh: Math.round(r.speed * 3.6),
          bank: +(at(r.lip).bank * 180 / Math.PI).toFixed(1),
          rail: railNear(r.pad0, r.land + 25),
          boomLip: boom(r.lip), boomLand: boom(r.land),
          sunLip: sunlit(r.lip), sunLand: sunlit(r.land),
        })),
      };
    }, [BOOM_BACK, BOOM_UP]);

    all[seed] = out;
    const n = out.ramps.length;
    const fail = [];
    if (n < 2) fail.push(`only ${n} ramp(s)`);
    /* A shadowed ramp is not a failure — the mechanic is the same there and
       the stage wants the rhythm — but a stage where NO ramp is in the sun has
       nothing to be silhouetted against anywhere, and that is a failure. */
    if (n && !out.ramps.some(r => r.sunLip.lit)) fail.push('no ramp in the sun');
    for (const r of out.ramps) {
      if (r.boomLip.free < r.boomLip.want + 0.55) fail.push(`boom clipped at lip ${r.lip}`);
      if (r.boomLand.free < r.boomLand.want + 0.55) fail.push(`boom clipped at landing ${r.lip}`);
      if (out.bore && r.lip > out.bore[0] - 90 && r.foot < out.bore[1] + 56) {
        fail.push(`ramp ${r.lip} inside the bore`);
      }
    }
    if (fail.length) bad++;

    console.log(`\n─── seed ${String(out.seed).padStart(3)}   ${out.length} m   ${n} ramps`
      + `   bore ${out.bore ? out.bore.join('–') : 'none'} ───`);
    console.log('     lip   foot    pad   land   frac   kmh   air   dist  runout'
      + '   w  landW   grade   lit  gap   rail   boomLip   boomLand   sun m  score');
    for (const r of out.ramps) {
      console.log(
        `  ${String(r.lip).padStart(6)} ${String(r.foot).padStart(6)} ${String(r.pad0).padStart(6)}`
        + ` ${String(Math.round(r.land)).padStart(6)} ${r.frac.toFixed(3).padStart(6)}`
        + ` ${String(r.kmh).padStart(5)} ${r.air.toFixed(2).padStart(5)} ${r.dist.toFixed(0).padStart(6)}`
        + ` ${String(r.runout).padStart(7)} ${r.w.toFixed(1).padStart(5)} ${r.landW.toFixed(1).padStart(6)}`
        + ` ${r.grade.toFixed(3).padStart(7)} ${r.lit.toFixed(2).padStart(5)} ${r.gap.toFixed(0).padStart(4)}`
        + ` ${String(r.rail).padStart(6)}`
        + ` ${(r.boomLip.free + '/' + r.boomLip.want).padStart(10)}`
        + ` ${(r.boomLand.free + '/' + r.boomLand.want).padStart(10)}`
        + ` ${String(r.sunLip.free).padStart(6)} ${String(r.score).padStart(6)}`);
    }
    if (fail.length) console.log(`  FAIL  ${fail.join('; ')}`);
  });
}

/* `bad` is only ever incremented inside the run() callback, and run() skips the
   callback entirely when the page throws during boot. A seed that never got as
   far as being surveyed leaves no entry in `all`, and that absence — not the
   tally — is what proves it failed. Without this the summary happily read
   "seeds with at least two ramps: 0/14 ... all seeds pass". */
const unmeasured = SEEDS.filter(s => !all[s]);
const counts = SEEDS.map(s => all[s]?.ramps.length ?? 0);
const two = counts.filter(n => n >= 2).length;
const three = counts.filter(n => n >= 3).length;
console.log(`\n═══ ${SEEDS.length} seeds ═══`);
console.log(`  seeds with at least two ramps: ${two}/${SEEDS.length}`
  + `   with three: ${three}/${SEEDS.length}`);
if (unmeasured.length) {
  console.log(`  ${unmeasured.length} seed(s) were never surveyed at all: ${unmeasured.join(', ')}`);
}
console.log(`  ${bad || unmeasured.length
  ? `${bad + unmeasured.length} seed(s) failed a gate`
  : 'all seeds pass'}`);

fs.mkdirSync(path.join(ROOT, 'shots', 'rampsite'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'shots', 'rampsite', 'sites.json'), JSON.stringify(all, null, 1));
console.log('\n  → shots/rampsite/sites.json');
/* Raise, never lower: a bare 0 here discarded whatever run() had already
   decided about a page that threw. */
finish(bad || unmeasured.length ? 1 : (process.exitCode || 0));
