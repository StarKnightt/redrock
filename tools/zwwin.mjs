/* The finish window, station by station, exactly as the scheduler sees it.
 *
 * `zqplan` reports the decision; this reports the inputs to it. For every
 * station and side in the run-in it asks the same four questions `pickFinish`
 * asks, through the same functions, so a station that is refused says which
 * gate refused it rather than leaving a probe to guess:
 *
 *   stand    can anybody stand here at all, and how far out
 *   seen     how much of the approach can see them, gate term included
 *   gate     how many of those stations have the arch in shot too
 *   held     how many of the plausible held ending poses see them
 *   ray      does one real ray from the real lens reach their chest
 *
 *   node tools/zwwin.mjs [--seeds 22,1,40] [--before 60] [--after 30]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');
const BEFORE = +flag('before', 60);
const AFTER = +flag('after', 30);
const TAG = flag('tag', 'zwwin');

const lines = [];
const say = s => { console.log(s); lines.push(s); };
const all = [];

for (const SEED of SEEDS) {
  await run({
    width: 320, height: 200,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    const r = await page.evaluate(({ BEFORE, AFTER }) => {
      const g = window.__game, t = g.track;
      const P = g.scene.getObjectByName('environment').userData.crowdProbe;
      const L = t.length, LINE = P.line, GATE = P.gate;
      const rows = [];
      for (let s = LINE - BEFORE; s <= Math.min(LINE + AFTER, L - 2); s += 2) {
        for (const side of [-1, 1]) {
          const u = P.stand(s, side);
          if (u === null) { rows.push({ rel: +(s - LINE).toFixed(0), side, u: null }); continue; }
          const wall = P.wallDist(s, side);
          const ray = P.raySees(s, side, u);
          rows.push({
            rel: +(s - LINE).toFixed(0), side,
            u: +u.toFixed(3), out: +(u * wall).toFixed(1),
            held: P.held(s, side, u),
            ray: ray.ok, why: ray.why,
          });
        }
      }
      return {
        L: +L.toFixed(0), LINE, GATE, blockers: P.blockers().length,
        rests: P.heldRests, lens: P.lensHigh, rows,
      };
    }, { BEFORE, AFTER });

    say(`\n══ seed ${SEED} ══  L=${r.L} line=${r.LINE} gate=${r.GATE}`
      + `  ${r.blockers} blockers  held rests ${r.rests.join('/')}  modelled lens ${r.lens} m`);
    say('    rel side   out   held  ray');
    for (const x of r.rows) {
      if (x.u === null) {
        say(`    ${String(x.rel).padStart(3)} ${String(x.side).padStart(4)}`
          + '     —      —    —   nobody can stand here');
        continue;
      }
      say(`    ${String(x.rel).padStart(3)} ${String(x.side).padStart(4)}`
        + ` ${String(x.out).padStart(5)}  ${String(x.held).padStart(4)}`
        + `  ${x.ray ? 'yes' : 'NO '}  ${x.why || ''}`);
    }
    all.push({ seed: +SEED, ...r });
  });
}

const dir = path.join(ROOT, '.meas', 'r3');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${TAG}.json`), JSON.stringify(all, null, 2));
fs.writeFileSync(path.join(dir, `${TAG}.txt`), lines.join('\n') + '\n');
console.log(`\n  → ${path.join(dir, TAG + '.txt')}`);
finish(process.exitCode || 0);
