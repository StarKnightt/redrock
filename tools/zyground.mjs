/* What, exactly, is holding the run-off up.
 *
 * `tools/zyrunoff.mjs` measures the run-off standing 18–37 m above the first
 * solid surface below it on all fourteen seeds, where the 34 m of course ahead
 * of it measures ±1 m. This tool localises that to a mesh and a station, which
 * the A/B tool deliberately does not try to do: it reports, at every rung past
 * the flag, where the corridor ribbon's own road-edge vertex is relative to the
 * road, and which named mesh a downward ray actually hits.
 *
 * The distinction matters because SolidWorld — what the ray and the camera and
 * an off-road car all consult — does NOT include the road mesh. Ground under
 * the ROAD is therefore supposed to be missing; ground under the road's EDGES
 * is not, and that is what the corridor's station 0 is for.
 *
 *   node tools/zyground.mjs [--seeds 22,16]
 */
import { run } from './harness.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,16,1').split(',').map(Number);

const PROBE = () => {
  const g = window.__game;
  g.setPaused(true);
  const t = g.track;
  const field = g.field ?? g.stage?.userData?.field ?? null;

  const V = t.frames[0].pos.constructor;   // no global THREE in the page
  const rows = [];
  for (let i = 0; i < (field ? field.count : 0); i++) {
    const s = field.ss[i];
    if (s < t.finishS - 1) continue;
    const f = t.frameAt(Math.min(s, t.roadEnd));
    const row = {
      s: +s.toFixed(0), past: +(s - t.finishS).toFixed(0),
      w: +f.width.toFixed(1),
    };
    const p = field.profile(s, 1);
    row.wallDist = +p.wallDist.toFixed(1);
    row.shoreRoom = +p.shoreRoom.toFixed(1);

    /* Where the corridor's own apron says the ground is, analytically, just
       outboard of the kerb — and where SolidWorld says it actually is at the
       same place. The two together separate "the generator put nothing there"
       from "the generator put something there and it was not built".
       Sampled 2 m OUTSIDE the road edge rather than on it: the ribbon's rung 0
       lands exactly on the edge, and a downward ray aimed at the seam between
       the road deck and the apron is a knife-edge that can legitimately miss
       both. Two metres out is also the question that matters — a car leaving
       the road wants ground there. */
    const e = new V();
    for (const [key, side] of [['L', -1], ['R', 1]]) {
      const u = 2 / Math.max(1, p.wallDist);      // 2 m out, as a corridor fraction
      field.point(s, side, u, e);
      row['want' + key] = +(e.y - f.pos.y).toFixed(2);
      const d = g.solid.raycast(e.x, f.pos.y + 60, e.z, 0, -1, 0, 300, 1.2);
      row['got' + key] = Number.isFinite(d) ? +(d - 60).toFixed(2) : null;
    }
    rows.push(row);
  }
  return { length: +t.length.toFixed(0), finishS: +t.finishS.toFixed(0), rows };
};

for (const seed of SEEDS) {
  await run({
    width: 320, height: 200,
    hash: `manual&tier=high&seed=${seed}&cap=0&hud=0`,
  }, async ({ page }) => {
    const r = await page.evaluate(PROBE);
    console.log(`\n════ seed ${seed}   flag at ${r.finishS} m, race ends ${r.length} m ════`);
    console.log('  Sampled 2 m outboard of each kerb. "want" is where the corridor apron');
    console.log('  says the ground is, relative to the road; "got" is what SolidWorld has.\n');
    console.log('   past   road   profile        left shoulder        right shoulder');
    console.log('  flag   width  wallD shoreR    want     got        want     got');
    for (const w of r.rows) {
      const mark = w.past > (r.length - r.finishS) ? '|' : ' ';
      const bad = (want, got) => got === null || Math.abs(got - want) > 3 ? ' ✗' : '  ';
      console.log(`  ${String(w.past).padStart(4)} ${mark}${String(w.w).padStart(6)}`
        + `${String(w.wallDist).padStart(7)}${String(w.shoreRoom).padStart(7)}`
        + `${String(w.wantL).padStart(8)}${String(w.gotL ?? 'none').padStart(8)}${bad(w.wantL, w.gotL)}`
        + `${String(w.wantR).padStart(8)}${String(w.gotR ?? 'none').padStart(8)}${bad(w.wantR, w.gotR)}`);
    }
    console.log('  ("|" marks rungs past the end of the race, i.e. the appended road)');
  });
}
