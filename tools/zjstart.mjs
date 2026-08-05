/* Three things about the plumb ground mark that are not about the apex.
 *
 * One — the start. The mark is a function of ride height and of nothing else,
 * and on the grid the car is sitting on its springs with the countdown holding
 * the field. Ride height there is not zero: it is whatever the suspension
 * settles to, and the fade-in floor is only 0.18 m. If that floor were mis-set
 * the very first frame of every race would have a shadow under a stationary
 * car. Every frame of the hold is checked, and the hold is a real one — no bot
 * on the wheel, because a bot skips the countdown.
 *
 * Two — the overview. `overview()` puts the camera kilometres up to frame the
 * whole basin, and tools use it. It also sets `paused`. The question is not
 * whether the mark is visible from up there (at that range it is sub-pixel) but
 * whether taking the shot disturbs the mark's state, since the effects module
 * caches wheel patches frame to frame.
 *
 * Three — determinism. The read numbers are the report, so the probe behind
 * them has to give the same answer twice. Two independent launches per seed,
 * driven to the same apex, compared on the mark's own geometry and pixel count.
 *
 *   node tools/zjstart.mjs [--seeds 22,40]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';
import { READ_PROBE, STEP_TO } from './zjprobe.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,40').split(',').map(Number);
/* zjread's floor, so this measures the same quantity the report does. */
const COL_FLOOR = 150;

let fails = 0;

/* The grid. `countdown=1` arms it; no autopilot, because main.js releases the
   hold the moment it sees a bot. Wall-clock dt is what the countdown counts, so
   the hold is stepped at 1/60 until it lifts, and then a second of real driving
   is stepped too — the launch off the line is a load transient and the rear can
   unweight. */
const GRID = () => {
  const g = window.__game, p = g.player;
  g.setPaused(true);
  let held = 0, heldDrawn = 0, hMax = -1e9, hMin = 1e9;
  for (let n = 0; n < 60 * 5 && g.countdown.holding; n++) {
    g.step(1 / 60);
    held++;
    hMax = Math.max(hMax, p.height); hMin = Math.min(hMin, p.height);
    if (g.effects.airMark.mesh.visible) heldDrawn++;
  }
  /* Off the line under full throttle, which is the transient. */
  g.autopilot(true, 1.0);
  let launch = 0, launchDrawn = 0, launchMax = -1e9;
  for (let n = 0; n < 60 * 4; n++) {
    g.step(1 / 60);
    launch++;
    launchMax = Math.max(launchMax, p.height);
    if (g.effects.airMark.mesh.visible) launchDrawn++;
  }
  g.autopilot(false);
  return {
    held, heldDrawn, launch, launchDrawn,
    holdH: [+hMin.toFixed(3), +hMax.toFixed(3)],
    launchH: +launchMax.toFixed(3),
    stillHolding: g.countdown.holding,
  };
};

/* The overview, taken at an apex so the mark is live and there is something to
   disturb. The mark's world transform is read before and after. */
const OVERVIEW = () => {
  const g = window.__game;
  const mesh = g.effects.airMark.mesh;
  const snap = () => {
    mesh.updateMatrixWorld(true);
    return [...mesh.matrixWorld.elements].map(v => +v.toFixed(6)).join(',')
      + '|' + mesh.visible;
  };
  const before = snap();
  g.overview();
  g.renderOnce();
  const during = snap();
  g.setView('chase');
  g.renderOnce();
  const after = snap();
  return { moved: during !== before, restored: after === before };
};

for (const SEED of SEEDS) {
  await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&countdown=1` },
    async ({ page }) => {
      const g0 = await page.evaluate(GRID);
      const ok = g0.heldDrawn === 0 && g0.launchDrawn === 0;
      if (!ok) fails++;
      console.log(`\n  seed ${SEED} — the grid`);
      console.log(`    ${g0.held} frames of countdown hold, ride height`
        + ` ${g0.holdH[0]} .. ${g0.holdH[1]} m, mark drawn on ${g0.heldDrawn}`);
      console.log(`    ${g0.launch} frames off the line at full throttle, peak`
        + ` ${g0.launchH} m, mark drawn on ${g0.launchDrawn}`);
      console.log(`    ${ok ? 'PASS' : 'FAIL'} — nothing under a car that is on the road`);
    });
}

for (const SEED of SEEDS) {
  await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0` },
    async ({ page }) => {
      const pad = await page.evaluate(() => {
        window.__game.setPaused(true);
        return window.__game.track.ramps[1].pad0;
      });
      await page.evaluate(s => {
        const g = window.__game;
        g.autopilot(true, 0.85);
        g.driveTo(s / g.track.length, { runUp: 320, maxSec: 45 });
      }, pad - 60);
      await page.evaluate(STEP_TO, ['apex', 0, 900]);
      const o = await page.evaluate(OVERVIEW);
      if (!o.restored) fails++;
      console.log(`\n  seed ${SEED} — an overview taken at the apex`);
      console.log(`    the mark's world transform ${o.moved ? 'moved' : 'held'} during the shot,`
        + ` and is ${o.restored ? 'identical' : 'DIFFERENT'} after it`);
      console.log(`    ${o.restored ? 'PASS' : 'FAIL'} — the shot leaves the mark where it was`);
    });
}

/* Determinism: the same apex, two launches, same answer. */
for (const SEED of SEEDS) {
  const takes = [];
  for (let take = 0; take < 2; take++) {
    await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
      async ({ page }) => {
        const pad = await page.evaluate(() => {
          window.__game.setPaused(true);
          return window.__game.track.ramps[1].pad0;
        });
        await page.evaluate(s => {
          const g = window.__game;
          g.autopilot(true, 0.85);
          g.driveTo(s / g.track.length, { runUp: 320, maxSec: 45 });
        }, pad - 60);
        await page.evaluate(STEP_TO, ['apex', 0, 900]);
        takes.push(await page.evaluate(READ_PROBE, [COL_FLOOR, true]));
      });
  }
  const [a, b] = takes;
  const row = m => `h ${m.h} m   car ${m.car.px} px   mark ${m.mark.px} px`
    + `   core ${m.core ? m.core.px : '—'} px   read ${m.mark.readPx} px`
    + `   dx ${m.mark.dx} px`;
  const key = m => `${m.h}|${m.car.px}|${m.car.bottom}|${m.mark.px}|${m.mark.colPx}`
    + `|${m.mark.sep}|${m.mark.readPx}|${m.mark.dx}|${m.core ? m.core.px : ''}`
    + `|${m.core ? m.core.readPx : ''}`;
  const same = key(a) === key(b);
  if (!same) fails++;
  console.log(`\n  seed ${SEED} — the same apex twice, two launches`);
  console.log(`    take 1  ${row(a)}`);
  console.log(`    take 2  ${row(b)}`);
  console.log(`    ${same ? 'PASS' : 'FAIL'} — identical`);
}

console.log(fails ? `\n  ${fails} FAILED` : `\n  all clear`);
if (fails) process.exitCode = 1;
finish(process.exitCode || 0);
