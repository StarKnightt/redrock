/* Are the scheduled landmarks events, and are they varied?
 *
 * The schedule is a list of things placed and the arc length they are reached
 * at, and boot.mjs reports its length and its largest gap. Neither answers the
 * question the route actually poses, which is whether a driver sees an event.
 * Two ways the schedule can lie about that:
 *
 *   reach   an offshore turbine or a lighthouse on a sea stack is scheduled at
 *           the station it is nearest to, and can still be four hundred metres
 *           out to sea for its whole approach. At that range, behind haze and
 *           two degrees wide, it is scenery. Anything that never comes inside
 *           a couple of hundred metres of the road is not an event and should
 *           not be counted as one.
 *   variety a route made of forty flower patches at even spacing has a perfect
 *           gap histogram and nothing to look at.
 *
 * So this reports, per kind, how close it ever gets and how much of the
 * schedule it is — and then the same numbers again over only those entries a
 * driver actually passes.
 *
 *   node tools/cadence.mjs [--seed 22] [--near 220]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const NEAR = Number(flag('near', '220'));

await run({
  width: 320, height: 200,
  hash: `manual&tier=high&seed=${SEED}&cap=60&hud=0`,
}, async ({ page }) => {
  const out = await page.evaluate(near => {
    const g = window.__game;
    let schedule = null;
    g.scene.traverse(o => { if (o.userData && o.userData.schedule) schedule = o.userData.schedule; });
    const rows = [];
    for (const e of schedule || []) {
      let closest = Infinity, atS = e.s;
      if (e.at) {
        for (let s = 0; s <= g.track.length; s += 8) {
          const f = g.track.frameAt(s);
          const d = Math.hypot(e.at[0] - f.pos.x, e.at[2] - f.pos.z);
          if (d < closest) { closest = d; atS = s; }
        }
      } else {
        /* No position recorded: it is placed on the verge at its own station,
           so the driver passes through it. */
        closest = 0;
      }
      rows.push({ kind: e.kind, s: e.s, t: e.t, closest, atS });
    }
    return { rows, length: g.track.length, lap: g.scene.getObjectByName('environment').userData.lapTime };
  }, NEAR);

  const byKind = {};
  for (const r of out.rows) {
    const k = byKind[r.kind] || (byKind[r.kind] = { n: 0, near: 0, min: Infinity });
    k.n++;
    k.min = Math.min(k.min, r.closest);
    if (r.closest <= NEAR) k.near++;
  }
  const total = out.rows.length;
  const passed = out.rows.filter(r => r.closest <= NEAR);

  console.log(`\n  ${total} scheduled entries, seed ${SEED}, lap ${out.lap ? out.lap.toFixed(0) + 's' : '?'}`);
  console.log(`  within ${NEAR} m of the road at some point: ${passed.length}`
    + `   never that close: ${total - passed.length}\n`);
  console.log('  kind             n   passed   closest approach   share of real events');
  const rank = Object.entries(byKind).sort((a, b) => b[1].near - a[1].near);
  for (const [kind, k] of rank) {
    console.log(`    ${kind.padEnd(16)} ${String(k.n).padStart(2)}`
      + `  ${String(k.near).padStart(6)}`
      + `   ${(k.min === Infinity ? '-' : k.min.toFixed(0) + ' m').padStart(14)}`
      + `   ${passed.length ? ((100 * k.near) / passed.length).toFixed(0).padStart(3) : '  -'}%`);
  }

  /* The variety number the review actually quoted: how much of the route is
     the two cheapest kinds to place. */
  const filler = passed.filter(r => /flower|tyre/.test(r.kind)).length;
  console.log(`\n  flower patches + tyre stacks: ${filler}/${passed.length}`
    + ` = ${passed.length ? ((100 * filler) / passed.length).toFixed(0) : 0}% of real events`);

  /* Gaps measured over real events only, in seconds of racing. */
  const seq = passed.slice().sort((a, b) => a.s - b.s);
  let worst = 0, worstAt = 0;
  for (let i = 1; i < seq.length; i++) {
    const gap = seq[i].s - seq[i - 1].s;
    if (gap > worst) { worst = gap; worstAt = seq[i - 1].s; }
  }
  console.log(`  largest gap between real events: ${worst.toFixed(0)} m after s=${worstAt.toFixed(0)}`);
  const never = out.rows.filter(r => r.closest > NEAR);
  if (never.length) {
    console.log('\n  scheduled but never within reach:');
    for (const r of never) {
      console.log(`    ${r.kind.padEnd(16)} slot s=${r.s.toFixed(0)}`
        + `  closest ${r.closest.toFixed(0)} m at s=${r.atS.toFixed(0)}`);
    }
  }
  console.log();
});
finish(process.exitCode || 0);
