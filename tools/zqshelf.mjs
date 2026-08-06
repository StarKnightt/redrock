/* What is actually out there on the shoulder, metre by metre?
 *
 * crowdStand refuses a dropping shoulder past u = 0.30 on the grounds that
 * "past the lip on a seaward shoulder is a forty-metre drop". That is a
 * category flag (`profile.dropness`), not a measurement of the ground, and on
 * the seeds where the pacing pass reports "0 stations anybody could stand on"
 * the flag is what emptied the stretch. Before loosening or defending it, look
 * at the ground: walk the corridor out from the kerb and print the height
 * against the road edge, so a bank, a shelf and a cliff can be told apart.
 *
 * Heights are metres above the ROAD EDGE, which is the unit crowdStand works
 * in — not above the crowned centreline, which is EDGE_DROP higher and is the
 * confusion this file's comments call the five-times-repeated defect.
 *
 *   node tools/zqshelf.mjs [--seed 22] [--from 1560] [--to 2100] [--step 60]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const FROM = Number(flag('from', '1560'));
const TO = Number(flag('to', '2100'));
const STEP = Number(flag('step', '60'));

await run({
  width: 320, height: 200,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  const out = await page.evaluate(([from, to, step]) => {
    const g = window.__game;
    const env = g.scene.getObjectByName('environment') || g.stage.getObjectByName('environment');
    const probe = env?.userData?.crowdProbe;
    const field = g.field || env?.userData?.field;
    if (!probe || !field) return { none: true };
    /* The corridor surface is a model, and this file used to report it as
       though it were the ground. That is the failure mode tools/wsurf.mjs and
       tools/wground.mjs exist to catch: crowdStand consults probe.point, so a
       tool that answers "what is out there" with probe.point agrees with
       crowdStand by construction and cannot see a landform ribbon that
       interpenetrates the corridor, or a road on supports over a basin floor
       fifteen metres down. So every model height below is now printed beside
       a ray dropped onto the meshes that are actually drawn. */
    const THREE = g.THREE;
    const skip = /sky-dome|sun-disc|ocean-bands|shore-foam|block-clouds|bird|beam|foam|crowd/i;
    const targets = [];
    g.stage.updateMatrixWorld(true);
    g.stage.traverse(o => {
      if (!o.isMesh) return;
      let nm = o.name;
      for (let q = o.parent; !nm && q; q = q.parent) nm = q.name;
      if (skip.test(nm || '')) return;
      targets.push(o);
    });
    const ray = new THREE.Raycaster();
    ray.far = 4000;
    const down = new THREE.Vector3(0, -1, 0);
    /* Height of the real ground under a model point, or null if the ray finds
       nothing at all — which is itself the answer, and a loud one. */
    const realY = (p) => {
      ray.set(new THREE.Vector3(p.x, p.y + 600, p.z), down);
      const hit = ray.intersectObjects(targets, false)[0];
      return hit ? hit.point.y : null;
    };

    const rows = [];
    for (let s = from; s <= to; s += step) {
      for (const side of [1, -1]) {
        const wall = probe.wallDist(s, side);
        const f = g.track.frameAt(s);
        /* EDGE_DROP is not exported to the page; the corridor at u→0 is the
           road edge itself, so take the height there as the datum and every
           number below is a rise against it by construction. */
        const datum = probe.point(s, side, 0.001).y;
        const cols = [];
        const gaps = [];
        for (const m of [2, 3, 4, 6, 8, 11, 15, 20]) {
          const u = m / wall;
          if (u > 1) { cols.push(null); gaps.push(null); continue; }
          const p = probe.point(s, side, u);
          cols.push(+(p.y - datum).toFixed(2));
          const r = realY(p);
          /* Positive gap: the model surface floats above anything drawn, so a
             spectator placed here stands in the air. Negative: there is mass
             the model does not know about, and the sightline gates are
             reasoning through it. */
          gaps.push(r === null ? NaN : +(p.y - r).toFixed(2));
        }
        rows.push({ s, side, wall: +wall.toFixed(1), y: +f.pos.y.toFixed(1), cols, gaps });
      }
    }
    return { seed: g.track.seed, rows };
  }, [FROM, TO, STEP]);

  if (out.none) { console.log('  no probe'); return; }
  console.log(`\n  seed ${out.seed} — height above the road edge, metres out from it\n`);
  console.log('      s  side   wall      2m     3m     4m     6m     8m    11m    15m    20m');
  let worst = 0, worstAt = null, missing = 0;
  for (const r of out.rows) {
    console.log(`  ${String(r.s).padStart(5)}  ${String(r.side).padStart(4)}`
      + `  ${String(r.wall).padStart(5)}m  `
      + r.cols.map(c => (c === null ? '    —' : c.toFixed(2)).padStart(6)).join(' '));
    console.log(`  ${''.padStart(5)}  ${'real'.padStart(4)}  ${''.padStart(6)}  `
      + r.gaps.map(gp => (gp === null ? '    —'
        : Number.isNaN(gp) ? '   ··' : gp.toFixed(2)).padStart(6)).join(' '));
    for (const gp of r.gaps) {
      if (gp === null) continue;
      if (Number.isNaN(gp)) { missing++; continue; }
      if (Math.abs(gp) > Math.abs(worst)) { worst = gp; worstAt = r; }
    }
  }
  /* The point of the second row. The model line alone is what crowdStand
     already believes; only the gap can disagree with it. */
  console.log('\n  "real" is the model height minus the drawn ground under it.'
    + '  Positive is a spectator standing in the air;\n  negative is mass the'
    + ' corridor model does not know about.  ·· means the ray found nothing at all.');
  if (worstAt) {
    console.log(`  worst disagreement ${worst > 0 ? '+' : ''}${worst.toFixed(2)} m`
      + ` at s=${worstAt.s} side ${worstAt.side}.`);
  }
  if (missing) console.log(`  ${missing} sample${missing === 1 ? '' : 's'} had no ground beneath at all.`);
  if (Math.abs(worst) < 0.5 && !missing) {
    console.log('  the corridor model and the drawn stage agree here.');
  }
});

/* Not `finish()`. `finish` defaults its argument to 0, so a bare call is
   `finish(0)` — the discarded exit code the 67-tool repair removed, in a
   spelling a grep for "finish(0)" cannot match. Measured: with a syntax error in
   src/core/util.js this tool printed "parse errors — not launching a browser",
   cast no rays, and exited 0. */
finish(process.exitCode || 0);
