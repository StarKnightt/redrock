/* tools/airlift.mjs, re-scored.
 *
 * airlift established the three airborne camera terms by sweeping them against
 * the on-screen separation between the car and the road point beneath it: every
 * metre of boom costs about 10 px of separation and 6 px of car, and 41.5 px per
 * metre of height is the ceiling with the boom fully off. Two contested calls
 * came out of that sweep — the lift and the FOV widen both to zero, the boom cut
 * to 1.5 m — and a fresh critic re-ran the sweep and upheld both.
 *
 * The review that followed made the sharper point: that sweep optimised pixels
 * of separation between the car and the road, which is the right measurement of
 * the wrong thing, because separation is only perceivable if something anchors
 * where the ground under the car is. So the same sweep is run here against the
 * anchored read instead — separation that a mark under the car is actually
 * holding the bottom of. If the two disagree, the camera constants are up for
 * revision. If they agree, they are settled on both metrics and the earlier
 * rounds' conclusion survives the reframing rather than merely predating it.
 *
 * Two configurations are in the sweep that airlift could not have run. Negative
 * lift is one: the angular separation between a car at height h and the ground
 * under it, from a lens d behind and H above that ground, is
 * atan(H/d) - atan((H-h)/d), which is stationary at H = h/2 and falls away on
 * both sides. The shipped lens sits at h+3 or so, well up the falling side, so
 * the algebra says *lowering* it should buy separation — which is the same
 * finding the earlier round made about raising it, continued through zero. It
 * has a cost that this metric cannot see and the report names.
 *
 *   node tools/zjlift.mjs [--seeds 22,40] [--tag lift]
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
const SEEDS = flag('seeds', '22,40').split(',').map(Number);
const TAG = flag('tag', 'lift');
const COL_FLOOR = 150;
const W = 1600, H = 900;

const CONFIGS = [
  { name: 'SHIPPED  boom+1.5', boom: 1.5, lift: 0, fov: 0, shot: true },
  { name: 'no pullback', boom: 0, lift: 0, fov: 0 },
  { name: 'boom+2.5', boom: 2.5, lift: 0, fov: 0 },
  { name: 'boom+5', boom: 5.0, lift: 0, fov: 0 },
  { name: 'boom+5 lift+2.4 fov+6', boom: 5.0, lift: 2.4, fov: 6 },
  { name: 'lift+2.4', boom: 1.5, lift: 2.4, fov: 0 },
  { name: 'fov+6', boom: 1.5, lift: 0, fov: 6 },
  { name: 'lift-1.5', boom: 1.5, lift: -1.5, fov: 0, shot: true },
  { name: 'lift-3.0', boom: 1.5, lift: -3.0, fov: 0, shot: true },
];

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
      console.log(`\n─── seed ${SEED} ───`);
      console.log('  site  camera                  apex m   READ   core   sep  colPx'
        + '   car px   boom   lens above road   fov   ground pt');

      for (let i = 0; i < ramps.length; i++) {
        for (const c of CONFIGS) {
          await page.evaluate(([s, c]) => {
            const g = window.__game;
            g.chase.airBoom = c.boom; g.chase.airLift = c.lift; g.chase.airFov = c.fov;
            g.autopilot(true, 0.85);
            g.driveTo(s / g.track.length, { runUp: 320, maxSec: 45 });
          }, [ramps[i].pad0 - 60, c]);
          await page.evaluate(STEP_TO, ['apex', 0, 900]);
          const m = await page.evaluate(READ_PROBE, [COL_FLOOR, false]);
          if (c.shot) {
            await capture(page, path.join(outDir,
              `s${SEED}-r${i}-${c.name.split(/\s+/)[0].replace(/[^\w.+-]/g, '')}.png`));
          }
          await page.evaluate(() => window.__game.autopilot(false));

          rows.push({ seed: SEED, site: i, cfg: c.name, ...m });
          console.log(`  r${i}    ${c.name.padEnd(22)} ${String(m.h).padStart(6)}`
            + ` ${String(m.mark?.readPx ?? '—').padStart(6)}`
            + ` ${String(m.core?.readPx ?? '—').padStart(6)}`
            + ` ${String(m.mark?.sep ?? '—').padStart(5)}`
            + ` ${String(m.mark?.colPx ?? '—').padStart(6)}`
            + ` ${String(m.car.px).padStart(8)}`
            + ` ${String(m.boom).padStart(6)}`
            + ` ${String(m.camY).padStart(17)}`
            + ` ${String(m.fov).padStart(5)}`
            + ` ${m.gnd.inFrame ? '  in frame' : '  OFF FRAME'}`);
        }
      }
    });
}

console.log('\n  ═══ per configuration, averaged over every launch ═══');
console.log('   camera                  apex m    READ   core   raw sep   colPx'
  + '    car px   boom   lens above road   ground pt in frame');
for (const c of CONFIGS) {
  const set = rows.filter(r => r.cfg === c.name);
  if (!set.length) continue;
  const m = f => set.reduce((a, r) => a + (f(r) || 0), 0) / set.length;
  const inFrame = set.filter(r => r.gnd.inFrame).length;
  console.log(`  ${c.name.padEnd(22)} ${m(r => r.h).toFixed(2).padStart(6)}`
    + ` ${m(r => r.mark?.readPx).toFixed(0).padStart(7)}`
    + ` ${m(r => r.core?.readPx).toFixed(0).padStart(6)}`
    + ` ${m(r => r.mark?.sep).toFixed(0).padStart(9)}`
    + ` ${m(r => r.mark?.colPx).toFixed(0).padStart(7)}`
    + ` ${m(r => r.car.px).toFixed(0).padStart(9)}`
    + ` ${m(r => r.boom).toFixed(1).padStart(6)}`
    + ` ${m(r => r.camY).toFixed(2).padStart(17)}`
    + ` ${String(inFrame + '/' + set.length).padStart(20)}`);
}
console.log(`\n  → shots/${TAG}`);
finish(process.exitCode || 0);
