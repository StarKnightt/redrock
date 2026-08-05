/* Where the tunnel and the ramps actually are, with the run-off as a control.
 *
 * The claim under test is that appending 120 m of road past the flag left the
 * race's siting untouched. `Track` publishes a `?runoff=0` control for exactly
 * this, so the honest comparison is the same seed booted both ways and the
 * chosen stations read out of the built world — not out of a re-implementation
 * of the scan, which would only prove that two copies of the same arithmetic
 * agree.
 *
 *   node tools/qtsite.mjs [--seeds 22,1,40]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',').map(Number);

const PROBE = () => {
  const g = window.__game;
  g.setPaused(true);
  const t = g.track;
  const env = g.scene.getObjectByName('environment');
  const tun = env?.userData?.tunnel ?? null;
  return {
    seed: t.seed,
    length: +t.length.toFixed(1),
    roadEnd: +t.roadEnd.toFixed(1),
    runoff: +t.runoff.toFixed(0),
    finishS: +t.finishS.toFixed(1),
    gateS: +t.gateS.toFixed(1),
    courseCount: t.courseCount,
    count: t.count,
    tunnel: tun ? {
      s0: +tun.s0.toFixed(1), s1: +tun.s1.toFixed(1),
      len: +(tun.s1 - tun.s0).toFixed(1),
      wall: +tun.wall.toFixed(1), bend: +tun.bend.toFixed(2),
      sight: +tun.sight.toFixed(2), crest: +tun.crest.toFixed(2),
      hidden: tun.hidden ?? null, score: +tun.score.toFixed(2),
    } : null,
    ramps: (t.ramps || []).map(r => ({
      lip: +r.lip.toFixed(1), foot: +r.foot.toFixed(1), land: +r.land.toFixed(1),
      speed: r.speed, airPred: r.air, score: r.score,
      runout: r.runout, w: +r.w.toFixed(1), landW: +r.landW.toFixed(1),
      appCurv: +r.appCurv.toFixed(5), appSwing: +r.appSwing.toFixed(2),
    })),
  };
};

const rows = [];
for (const seed of SEEDS) {
  for (const runoff of [null, 0]) {
    const hash = `manual&tier=high&seed=${seed}&cap=0&hud=0`
      + (runoff === null ? '' : `&runoff=${runoff}`);
    await run({ width: 320, height: 200, hash }, async ({ page }) => {
      rows.push({ tag: runoff === null ? 'ship' : 'ctrl', ...await page.evaluate(PROBE) });
    });
  }
}

console.log('\n  seed  build   length  roadEnd  finishS   tunnel s0..s1   len   ramps');
for (const r of rows) {
  const t = r.tunnel;
  console.log(`  ${String(r.seed).padStart(4)}  ${r.tag.padEnd(5)}`
    + ` ${String(r.length).padStart(8)} ${String(r.roadEnd).padStart(8)}`
    + ` ${String(r.finishS).padStart(8)}`
    + `   ${t ? String(t.s0).padStart(6) + '..' + String(t.s1).padEnd(6) : '   none      '}`
    + ` ${t ? String(t.len).padStart(5) : '     '}`
    + `   ${r.ramps.map(x => x.lip).join(' / ')}`);
}
console.log('\n  tunnel scan terms (ship vs control)');
for (const r of rows) {
  const t = r.tunnel;
  if (!t) continue;
  console.log(`  seed ${String(r.seed).padStart(3)} ${r.tag.padEnd(5)}`
    + ` wall ${String(t.wall).padStart(5)} bend ${String(t.bend).padStart(5)}`
    + ` sight ${String(t.sight).padStart(5)} crest ${String(t.crest).padStart(5)}`
    + ` hidden ${String(t.hidden).padStart(2)} score ${String(t.score).padStart(7)}`);
}
console.log('\n' + JSON.stringify(rows));

finish(process.exitCode || 0);
