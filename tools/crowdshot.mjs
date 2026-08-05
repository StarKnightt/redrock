/* What the crowd looks like from the seat.
 *
 * Three frames per site, taken on the approach at fixed distances rather than
 * at fixed times: the proximity reaction is a function of how far the car is,
 * so a frame at eighty metres, one at forty and one at fifteen is the reaction
 * itself, and if the crowd looks the same in all three it is not working.
 *
 * The car is driven in by the AI. A parked car has no chase camera worth the
 * name and no reaction to trigger.
 *
 *   node tools/crowdshot.mjs [--seed 22] [--tag crowd]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const TAG = flag('tag', 'crowd');
/* Zero means "as close as this site ever gets", found by walking until the
   distance turns. Asking for a fixed fifteen metres is asking for a number
   the road does not offer at every site: the groups that sit on a bank stand
   twenty metres off it, and the drive-in then ran on for half a kilometre
   looking for a distance that never came. */
const DISTS = (flag('at', '80,40,0')).split(',').map(Number);

let failed = 0;
const outDir = path.join(ROOT, 'shots', TAG);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  const sites = await page.evaluate(() => {
    const g = window.__game, t = g.track;
    g.setPaused(true);
    return (g.crowd?.sites || []).map(s => {
      /* The station of CLOSEST APPROACH, not the station the group was placed
         from. Those differ by a hundred metres at a hairpin, and driving to
         the placement station is how a "closest" frame ends up being taken
         from across the valley. Walked along the centreline against the
         group's fixed position, over the same +/-250 m window crowdaudit,
         zzseen and wdiag all use, so this tool now agrees with them about
         where a site is nearest. */
      let closest = Infinity, atS = s.s;
      for (let u = Math.max(0, s.s - 250); u <= Math.min(t.length, s.s + 250); u += 2) {
        const f = t.frameAt(u);
        const d = Math.hypot(s.at.x - f.pos.x, s.at.z - f.pos.z);
        if (d < closest) { closest = d; atS = u; }
      }
      return {
        kind: s.kind, s: s.s, atS, closest: +closest.toFixed(1),
        at: [s.at.x, s.at.y, s.at.z],
      };
    });
  });
  console.log(`\n  seed ${SEED} — ${sites.length} sites`);

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    /* The start line is the one shot that must not be driven into: the whole
       point of it is the frame the driver is looking at from a standstill on
       the grid. */
    const isStart = site.kind === 'start line';
    if (isStart) {
      await page.evaluate(() => {
        const g = window.__game;
        g.goTo(34 / g.track.length);
        g.warp(0.5);
        g.crowd.update(g.player.pos, 0.4);
      });
      await capture(page, path.join(outDir, `s${SEED}-0-start-grid.png`));
      console.log(`    ${site.kind.padEnd(14)} grid frame from s=34`);
      continue;
    }

    await page.evaluate(s => {
      const g = window.__game;
      g.autopilot(true, 0.85);
      g.driveTo(Math.max(0.002, (s - 150) / g.track.length), { runUp: 300, maxSec: 45 });
    }, site.atS);

    for (const want of DISTS) {
      const at = await page.evaluate(([target, targetS, want]) => {
        const g = window.__game, p = g.player;
        /* Along the ROAD, not across the map.
         *
         * The old walk drove until the straight-line distance to the group
         * stopped falling. Through a hairpin that is the wrong question: the
         * road turns back on itself, so for most of the approach the car is
         * getting further away in a straight line while getting closer along
         * the tarmac, and the walk stopped at the first hesitation. Every
         * hairpin frame in the original evidence is a long shot for this
         * reason — seed 22's "closest" was taken at 87.2 m.
         *
         * Station gap is monotonic on the way in by construction, so it can
         * be walked without a receding test at all. The Euclidean distance is
         * still what gets reported, because that is what the lens sees; it is
         * just no longer what steers the walk. */
        const d = () => Math.hypot(target[0] - p.pos.x, target[2] - p.pos.z);
        const gap = () => targetS - p.s;
        const wanted = want > 0 ? want : 2;
        /* The stall test used to be "p.s did not increase this frame", and it
           fired constantly on a car driving perfectly well.
           track.project() finds the station by a coarse scan anchored to the
           PREVIOUS station and then a symmetric +/-step descent from the best
           coarse node, so while the car creeps forward the scan keeps landing
           on the same node and p.s does not move — measured on seed 22 at the
           first hairpin, p.s sat at 1203.03 for thirty consecutive frames at a
           steady 55 km/h and then jumped 5.75 m. p.s is a staircase, not a
           ramp, and any single-frame monotonicity test on it is a coin toss.
           That is what stopped this walk at the hairpins: three "80 / 40 /
           closest" rows all reported the same frame at 140 m.
           Stall is now a real stall — no progress at all over seven seconds
           of simulation. Long enough to clear the longest tread of the
           staircase by an order of magnitude, and, more to the point, longer
           than the game's own recovery: main.js unsticks a stranded car after
           four seconds, so a window shorter than that abandons a car the game
           was about to rescue. At a second and a half this abandoned two
           stations on seed 22 that it then reached on the very next call. */
        const STALL = 420;
        let n = 0, sinceGain = 0, best = p.s;
        while (n++ < 3600 && gap() > wanted) {
          g.step(1 / 60);
          if (p.s > best + 1e-4) { best = p.s; sinceGain = 0; } else sinceGain++;
          if (sinceGain >= STALL) break;
        }
        return {
          d: +d().toFixed(1), gap: +gap().toFixed(1),
          s: +p.s.toFixed(0), kmh: +p.kmh.toFixed(0),
          /* Whether the frame about to be captured is the frame that was
             asked for. A capture taken from wherever the walk gave up is not
             evidence about anything and must not be filed as though it were. */
          reached: gap() <= wanted + 3,
          stalled: sinceGain >= STALL,
          steps: n,
        };
      }, [site.at, site.atS, want]);

      if (!at.reached) {
        console.log(`    ${site.kind.padEnd(14)} ${String(want || 'closest').padStart(7)}`
          + `  ✗ NOT REACHED — walk gave up ${at.gap} m short after ${at.steps} frames`
          + `${at.stalled ? ' (car stalled)' : ' (step limit)'}; no frame filed`);
        failed++;
        continue;
      }

      /* Discard the first grab after a long drive-in: the first read-back
         carries an artefact that has invented a whole critic round before.
         The clock is pinned from here to the end of the site's captures, so
         the reaction-on and reaction-at-rest frames below differ in the
         reaction and in nothing else. src/world/environment.js drives a
         shader uniform off performance.now() inside onBeforeRender, so
         without this the grass and the dust move between the pair and the
         difference between the two pictures is partly weather. */
      await page.evaluate(() => {
        const t = performance.now();
        window.__realNow = performance.now.bind(performance);
        performance.now = () => t;
        window.__game.renderOnce();
      });
      await capture(page,
        path.join(outDir,
          `s${SEED}-${i}-${site.kind.replace(/ /g, '-')}-${want || 'closest'}${want ? 'm' : ''}.png`));
      /* The same frame with the reaction switched off, by telling the crowd
         the car is half a kilometre away. Same camera, same clock, same
         everything else — so the pair is the reaction and nothing but, which
         is not true of a frame at eighty metres against a frame at fifteen. */
      if (!want) {
        await page.evaluate(() => {
          const g = window.__game;
          /* Paused, or the loop advances the car between the two grabs and
             the pair stops being a controlled comparison — which it did:
             the first version of this moved the dust and the camera as well
             as the arms. */
          g.setPaused(true);
          const car = g.crowd.uniforms.uCar.value.clone();
          g.crowd.uniforms.uCar.value.set(car.x + 900, car.y, car.z);
          g.renderOnce();
          window.__restore = () => g.crowd.uniforms.uCar.value.copy(car);
        });
        await capture(page,
          path.join(outDir, `s${SEED}-${i}-${site.kind.replace(/ /g, '-')}-closest-at-rest.png`));
        await page.evaluate(() => {
          window.__restore();
          window.__game.renderOnce();
        });
      }
      await page.evaluate(() => {
        performance.now = window.__realNow;
        window.__game.setPaused(false);
      });
      console.log(`    ${site.kind.padEnd(14)} ${(want || 'closest') + ''.padStart(0)} m target`
        + `  ${String(at.gap).padStart(5)} m of road left,`
        + ` ${String(at.d).padStart(5)} m by eye  s ${String(at.s).padStart(5)}`
        + `  ${String(at.kmh).padStart(3)} km/h`
        + `  (site is ${site.closest} m off the road at its nearest)`);
    }
    await page.evaluate(() => window.__game.autopilot(false));
  }
});

console.log(`\n  → shots/${TAG}`);
if (failed) {
  console.log(`  ✗ ${failed} station(s) not reached — those frames were NOT filed.`);
  process.exitCode = 1;
}
finish(process.exitCode || 0);
