/* Where, along a stretch, can a group stand at all?
 *
 * zqwhy answers "which gate refused this station" one station at a time and is
 * far too verbose to answer "is there anywhere in this eighty metres". The
 * finish search needs the second question: the brief's window is L-90 … L-20
 * and on seed 22, once the footing gates read the drawn shoulder rather than
 * the analytic model, that window contains nothing at all. How far back the
 * nearest real viewing spot lies decides whether that is a bug or a landform.
 *
 *   node tools/zqreach.mjs --seed 22 --from 5300 --to 5590 --step 4
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const STEP = Number(flag('step', '4'));

await run({
  width: 640, height: 360,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(600_000);
  const res = await page.evaluate(([from, to, step]) => {
    const g = window.__game;
    const env = g.scene.getObjectByName('environment') || g.stage.getObjectByName('environment');
    const probe = env?.userData?.crowdProbe;
    if (!probe) return { none: true };
    const L = g.track.length;
    const a = from === null ? L - 300 : from;
    const b = to === null ? L - 10 : to;
    const rows = [];
    for (let s = a; s <= b; s += step) {
      for (const side of [-1, 1]) {
        const u = probe.stand(s, side);
        if (u === null) continue;
        const wall = probe.wallDist(s, side);
        const p = probe.point(s, side, u);
        rows.push({
          s: +s.toFixed(0), side,
          out: +(u * wall).toFixed(1),
          y: +(probe.drawnY ? probe.drawnY(s, side, u) : p.y).toFixed(2),
        });
      }
    }
    return { rows, L: +L.toFixed(0), a, b };
  }, [Number(flag('from', 'null')) || null, Number(flag('to', 'null')) || null, STEP]);

  if (res.none) { console.log('  no crowdProbe'); return; }
  console.log(`\n══ seed ${SEED}  ${res.L} m — stations that can stand,`
    + ` s ${res.a.toFixed(0)}–${res.b.toFixed(0)} every ${STEP} m`);
  if (!res.rows.length) { console.log('   NOTHING, either side, anywhere in that stretch'); }
  for (const side of [-1, 1]) {
    const mine = res.rows.filter(r => r.side === side);
    console.log(`   side ${String(side).padStart(2)}: ${mine.length} stations`
      + (mine.length ? `, nearest the far end s=${mine[mine.length - 1].s}`
        + ` (${(res.L - mine[mine.length - 1].s).toFixed(0)} m short of the line),`
        + ` ${mine[mine.length - 1].out} m out` : ''));
  }
  const runs = [];
  for (const side of [-1, 1]) {
    let cur = null;
    for (const r of res.rows.filter(x => x.side === side)) {
      if (cur && r.s - cur.s1 <= STEP) { cur.s1 = r.s; cur.n++; }
      else { cur = { side, s0: r.s, s1: r.s, n: 1 }; runs.push(cur); }
    }
  }
  runs.sort((a, b) => b.s1 - a.s1);
  console.log('   contiguous stretches, nearest the line first:');
  for (const r of runs.slice(0, 10)) {
    console.log(`      side ${String(r.side).padStart(2)}  s ${r.s0}–${r.s1}`
      + `  (${r.s1 - r.s0 + STEP} m)`);
  }
  console.log();
});
finish(process.exitCode || 0);
