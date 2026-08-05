/* Perceived airborne read — the thing zzflight's separation is a proxy for.
 *
 * zzflight measured two quantities and reported them side by side: the car's own
 * cast shadow in pixels, and the screen-space gap from the car down to the
 * ground point beneath it. The gap is large. Measured here, the point on the
 * road directly under the car runs 100 to 192 px further down the frame between
 * the matched road frame and the apex, at every launch on both seeds, and it is
 * in frame at every one of them with 143 to 203 px to spare below it. The frame
 * still reads flat. So separation is not the read, and the round that maximised
 * it was optimising a necessary condition and not a sufficient one.
 *
 * What this measures instead. A player reads "off the ground" from a mark that
 *
 *   i.   is on the ground,
 *   ii.  is unambiguously this car's mark — it sits under the car in the frame,
 *        so it can be taken for where the car would touch down, and
 *   iii. is separated from the car's silhouette by daylight.
 *
 * All three, or none of it counts. A mark four hundred pixels off to one side is
 * a shadow of something else. Daylight under a car with nothing at the bottom of
 * it is a car photographed against a road.
 *
 * So, by ablation (see tools/zjprobe.mjs for the mechanics):
 *
 *   colPx    the candidate's pixels inside the car's own screen column. Clause
 *            ii as a number.
 *   sep      inside that column, from the car's lowest pixel down to the top of
 *            the candidate. The daylight, measured where the eye crosses it.
 *   readPx   sep, but only if colPx clears a floor. Otherwise zero — there is no
 *            mark for the gap to be read against.
 *
 * `dx` is the candidate's centroid offset from the car's, and it is here for one
 * argument: whether a candidate is a *cue* at all. A cue has to mean the same
 * thing twice. If the offset's sign and size swing with the compass heading of
 * the ramp then the same height puts the mark far left at one site and far right
 * at the next, and there is nothing to learn.
 *
 * The control is the matched road frame at the same site with the same camera.
 * On the road readPx must be zero: the wheels are on the mark.
 *
 *   node tools/zjread.mjs [--seeds 22,40] [--tag read] [--flight]
 *
 * --flight samples the rest of the airborne window as well as the apex, and
 * reports how much of it is anchored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';
import { READ_PROBE, STEP_TO } from './zjprobe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const has = k => args.includes('--' + k);
const SEEDS = flag('seeds', flag('seed', '22,40')).split(',').map(Number);
const TAG = flag('tag', 'read');
const FLIGHT = has('flight');
/* The before. Not a different build and not an older checkout — the same run with
   the mark suppressed, which is pixel-for-pixel the frame this work started
   from, since the mark is the only thing that was added and it takes no ink. */
const NOMARK = has('nomark');
const W = 1600, H = 900;

/* Pixels of a candidate that have to fall inside the car's own column before
   the daylight above it is called a read. 150 px at this resolution is a mark
   about twelve pixels on a side; under that it is a scatter of stray texels and
   the eye has nothing to fix on. Everything is reported raw as well as gated so
   this can be argued with, and nothing below is close to it in either
   direction: the failures are at zero and the passes are in five figures. */
const COL_FLOOR = 150;

const outDir = path.join(ROOT, 'shots', TAG);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const rows = [];

for (const SEED of SEEDS) {
  await run({ width: W, height: H, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0` },
    async ({ page }) => {
      const ramps = await page.evaluate(() => {
        window.__game.setPaused(true);
        return (window.__game.track.ramps || []).map(r => ({ lip: r.lip, pad0: r.pad0 }));
      });

      const probe = () => page.evaluate(READ_PROBE, [COL_FLOOR, true]);
      const step = (until, arg = 0, limit = 900) =>
        page.evaluate(STEP_TO, [until, arg, limit]);

      console.log(`\n─── seed ${SEED} ─── ${ramps.length} ramps`);
      console.log('  site  moment    h    car w/px       sun cast shadow             '
        + '    plumb ground mark');
      console.log('                                  px    dx  colPx   sep  READ    '
        + '   px    dx  colPx   sep  READ   core sep');

      for (let i = 0; i < ramps.length; i++) {
        const r = ramps[i];
        /* From the grid before every site. driveTo resets the player, but not the
           field, and a rival left wherever the page's own loop had carried it
           before the harness took the wheel can be leaned on during the run-up.
           That is worth a few pixels of apex height, which is exactly the size of
           the disagreement this tool showed between two invocations of itself.
           See tools/zjdet.mjs. */
        await page.evaluate(([s, nomark]) => {
          const g = window.__game;
          g.restart();
          g.autopilot(true, 0.85);
          g.driveTo(s / g.track.length, { runUp: 320, maxSec: 45 });
          /* Held off for the whole site, including the captures, by nailing the
             amplitude the mark is otherwise a pure function of height through. */
          if (nomark) g.effects.airMark.strength = 0;
        }, [r.pad0 - 60, NOMARK]);

        await step('pad', r.pad0 - 40);
        const road = await probe();
        await capture(page, path.join(outDir, `s${SEED}-r${i}-road.png`));

        await step('apex');
        const apex = await probe();
        await capture(page, path.join(outDir, `s${SEED}-r${i}-apex.png`));

        let flight = null;
        if (FLIGHT) {
          /* Every third frame of what is left of the flight, so the anchored
             fraction is a fraction of the air rather than of the apex. */
          const samples = [];
          for (let k = 0; k < 24; k++) {
            const still = await page.evaluate(() => {
              const g = window.__game;
              for (let n = 0; n < 3; n++) g.step(1 / 60);
              return g.player.airborne;
            });
            if (!still) break;
            samples.push(await probe());
          }
          flight = {
            n: samples.length,
            anchored: samples.filter(s => (s.mark?.readPx || 0) > 0).length,
            shadowed: samples.filter(s => (s.shadow?.readPx || 0) > 0).length,
            minH: samples.length ? Math.min(...samples.map(s => s.h)) : 0,
          };
        }
        await page.evaluate(() => window.__game.autopilot(false));

        for (const [name, m] of [['road', road], ['APEX', apex]]) {
          const f = v => (v === null || v === undefined ? '—' : String(v));
          const s = m.shadow, a = m.mark;
          rows.push({ seed: SEED, site: i, moment: name, ...m });
          console.log(`  r${i}    ${name.padEnd(6)} ${String(m.h).padStart(4)}`
            + ` ${String(m.car.w).padStart(4)}/${String(m.car.px).padStart(6)}`
            + ` ${f(s?.px).padStart(6)} ${f(s?.dx).padStart(5)} ${f(s?.colPx).padStart(6)}`
            + ` ${f(s?.sep).padStart(5)} ${f(s?.readPx).padStart(5)}   `
            + ` ${f(a?.px).padStart(6)} ${f(a?.dx).padStart(5)} ${f(a?.colPx).padStart(6)}`
            + ` ${f(a?.sep).padStart(5)} ${f(a?.readPx).padStart(5)}`
            + ` ${f(m.core?.sep).padStart(10)}`);
          console.log(`          ground point under car ${m.gnd.x},${m.gnd.y}`
            + ` ${m.gnd.inFrame ? 'IN FRAME' : 'OFF FRAME'}, ${H - m.gnd.y} px of margin below`
            + `  |  sun ${m.sunElev}° throws the shadow ${m.sunSpread} m sideways`
            + ` → ${m.cast.x},${m.cast.y}`);
        }
        if (flight) {
          console.log(`        rest of the flight: ${flight.n} samples down to`
            + ` ${flight.minH.toFixed(2)} m — anchored by the mark on`
            + ` ${flight.anchored}/${flight.n}, by the sun's shadow on`
            + ` ${flight.shadowed}/${flight.n}`);
        }
      }
    });
}

const apexes = rows.filter(r => r.moment === 'APEX');
const roads = rows.filter(r => r.moment === 'road');
console.log('\n  ═══ apex, every site ═══');
console.log('   seed site    h    sun READ   mark READ   core READ    sun dx   mark dx');
for (const r of apexes) {
  console.log(`  ${String(r.seed).padStart(5)} r${r.site}  ${String(r.h).padStart(4)}`
    + ` ${String(r.shadow?.readPx ?? '—').padStart(9)}`
    + ` ${String(r.mark?.readPx ?? '—').padStart(11)}`
    + ` ${String(r.core?.readPx ?? '—').padStart(11)}`
    + ` ${String(r.shadow?.dx ?? '—').padStart(9)}`
    + ` ${String(r.mark?.dx ?? '—').padStart(9)}`);
}
const mean = (a, k) => (a.length ? a.reduce((s, r) => s + k(r), 0) / a.length : 0);
console.log(`\n   mean apex read — sun shadow ${mean(apexes, r => r.shadow?.readPx || 0).toFixed(0)} px`
  + `, plumb mark ${mean(apexes, r => r.mark?.readPx || 0).toFixed(0)} px`
  + ` (to its core, ${mean(apexes, r => r.core?.readPx || 0).toFixed(0)} px)`);
console.log(`   on the road the mark scores`
  + ` ${roads.map(r => r.mark?.readPx ?? 0).join('/')} px — it is under the car`);
const dxs = apexes.map(r => r.shadow?.dx).filter(v => v !== null && v !== undefined);
if (dxs.length) {
  console.log(`   sun shadow dx across sites: ${Math.min(...dxs)} .. ${Math.max(...dxs)} px`
    + ` (spread ${Math.max(...dxs) - Math.min(...dxs)})`);
}
const mdxs = apexes.map(r => r.mark?.dx).filter(v => v !== null && v !== undefined);
if (mdxs.length) {
  console.log(`   plumb mark dx across sites: ${Math.min(...mdxs)} .. ${Math.max(...mdxs)} px`
    + ` (spread ${Math.max(...mdxs) - Math.min(...mdxs)}) — a cue has to mean the`
    + ' same thing twice');
}
console.log(`\n  → shots/${TAG}`);
finish(process.exitCode || 0);
