/* Where can a tunnel actually go?
 *
 * A bore needs rock above the road, which on a shelf road means a tall inland
 * wall; it needs to be straight enough that the exit is visible from the
 * entrance, or the light-at-the-end payoff never happens; and it wants to sit
 * where the road is already in shadow so the contrast is with something rather
 * than against it. This scores every station on those three and prints the
 * best runs.
 *
 *   node tools/tunnelsite.mjs [--len 130]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const LEN = Number(flag('len', '130'));

await run({ width: 320, height: 200, hash: 'manual&tier=high&seed=22&cap=60&hud=0' }, async ({ page }) => {
  const out = await page.evaluate(len => {
    const g = window.__game, field = g.field, track = g.track, coast = g.coast;
    const rows = [];
    for (let s = 60; s < track.length - 60 - len; s += 10) {
      const inland = -coast.seaSideAt(s);
      let wall = Infinity, width = 0, drop = 0, bend = 0;
      const a = track.frameAt(s), b = track.frameAt(s + len);
      for (let k = 0; k <= 8; k++) {
        const t = s + (len * k) / 8;
        const p = field.profile(t, inland);
        wall = Math.min(wall, p.wallHeight);
        width = Math.max(width, track.frameAt(t).width);
        drop = Math.max(drop, field.profile(t, -inland).cliffDrop);
      }
      // Straightness: how far the midpoint strays from the entry-exit chord.
      const m = track.frameAt(s + len / 2);
      const cx = b.pos.x - a.pos.x, cz = b.pos.z - a.pos.z;
      const chord = Math.hypot(cx, cz) || 1;
      bend = Math.abs((m.pos.x - a.pos.x) * cz - (m.pos.z - a.pos.z) * cx) / chord;
      const grade = (b.pos.y - a.pos.y) / len;
      rows.push({
        s: Math.round(s),
        wall: +wall.toFixed(0),
        width: +width.toFixed(1),
        drop: +drop.toFixed(0),
        bend: +bend.toFixed(1),
        grade: +grade.toFixed(3),
      });
    }
    return rows;
  }, LEN);

  /* A bore needs rock over the whole run, not on average, so the wall figure
     is the weakest cross-section rather than the mean. */
  const scored = out
    .map(r => ({ ...r, score: Math.min(r.wall, 70) - r.bend * 2.2 }))
    .sort((a, b) => b.score - a.score);
  console.log(`\n  best ${LEN} m runs (wall = weakest inland wall over the run,`
    + ' bend = midpoint offset from the entry-exit chord)\n');
  console.log('        s   wall   bend   width   drop   grade   score');
  const picked = [];
  for (const r of scored) {
    if (picked.some(p => Math.abs(p.s - r.s) < LEN)) continue;
    picked.push(r);
    console.log(`   ${String(r.s).padStart(6)} ${String(r.wall).padStart(6)}`
      + ` ${String(r.bend).padStart(6)} ${String(r.width).padStart(7)}`
      + ` ${String(r.drop).padStart(6)} ${String(r.grade).padStart(7)}`
      + ` ${r.score.toFixed(1).padStart(7)}`);
    if (picked.length >= 10) break;
  }
});

finish(process.exitCode || 0);
