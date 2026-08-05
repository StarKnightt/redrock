/* What a lower chase lens costs, priced on the thing a racing camera is for.
 *
 * tools/zjlift.mjs re-scores the camera sweep on the anchored read and finds
 * that dropping the lens gains read pixels: 94 px shipped against 125 at
 * `airLift -1.5` and 132 at `-3.0`. That is a real gain on the new metric and it
 * would be dishonest to leave it out of the report, so it has to be priced
 * rather than waved away — and the price is not the read, it is everything else
 * the lens height is doing.
 *
 * The measurement is road ahead. From the lens, the track's own centreline is
 * walked forward from the car in 5 m steps and each station is asked two
 * questions: does it fall inside the frame, and is there anything between the
 * lens and it. The answer is the distance at which the road first goes missing,
 * which over a crest is a function of how high the lens is sitting. Asked at
 * every launch site on both seeds, at the apex and at the matched road frame,
 * because a camera constant that only pays at the apex still has to be paid for
 * on the other ninety-two per cent of the stage.
 *
 * A note on what is not being claimed. At `airLift -3.0` the lens is still 7.5 m
 * above the road on average, so it does not clip the ground and this does not
 * pretend it does.
 *
 *   node tools/zjsight.mjs [--seeds 22,40] [--reach 400]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';
import { STEP_TO } from './zjprobe.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,40').split(',').map(Number);
const REACH = +flag('reach', 400);

const CONFIGS = [
  { name: 'SHIPPED  lift 0', lift: 0 },
  { name: 'lift-1.5', lift: -1.5 },
  { name: 'lift-3.0', lift: -3.0 },
];

const SIGHT = ([reach]) => {
  const g = window.__game, THREE = g.THREE, p = g.player, t = g.track;
  g.setPaused(true);
  g.renderOnce();

  /* What a ray can be stopped by: the ground and the things standing on it. The
     sky, the sea and the decorative bodies are not obstructions. */
  const skip = /sky-dome|sun-disc|ocean|shore|cloud|bird|beam|foam|fx-|air-mark|skid/i;
  const targets = [];
  g.stage.updateMatrixWorld(true);
  g.stage.traverse(o => {
    if (!o.isMesh || !o.visible) return;
    let nm = o.name;
    for (let q = o.parent; !nm && q; q = q.parent) nm = q.name;
    if (skip.test(nm || '')) return;
    targets.push(o);
  });

  const cam = g.camera;
  cam.updateMatrixWorld(true);
  const lens = cam.position.clone();
  const ray = new THREE.Raycaster();
  ray.far = reach + 60;
  const frame = {};
  const point = new THREE.Vector3();
  const dir = new THREE.Vector3();

  let firstGone = null, seen = 0, inFrameTo = null;
  for (let d = 10; d <= reach; d += 5) {
    const s = p.s + d;
    if (s >= t.length) break;
    p.surfaceAt(s, 0, point);
    /* In frame? Judged on the road surface point itself. */
    const q = point.clone().project(cam);
    const onScreen = q.x >= -1 && q.x <= 1 && q.y >= -1 && q.y <= 1 && q.z <= 1;
    if (onScreen) inFrameTo = d;
    /* Clear line to it? A hit short of the point by more than a metre is
       something standing in the way. */
    dir.subVectors(point, lens);
    const range = dir.length();
    dir.normalize();
    ray.set(lens, dir);
    const hits = ray.intersectObjects(targets, false);
    const blocked = hits.length > 0 && hits[0].distance < range - 1.0;
    if (onScreen && !blocked) { seen = d; continue; }
    if (firstGone === null) firstGone = d;
  }

  const ground = new THREE.Vector3();
  p.surfaceAt(p.s, p.lat, ground);
  return {
    h: +p.height.toFixed(2),
    lensAbove: +(lens.y - ground.y).toFixed(2),
    boom: +lens.distanceTo(p.pos).toFixed(2),
    /* The last station with both an unblocked line and a place in the frame. */
    clearTo: seen,
    /* And where it first fails, which separates "the frame ran out" from
       "the hill got in the way". */
    firstGone: firstGone === null ? reach : firstGone,
    inFrameTo: inFrameTo === null ? 0 : inFrameTo,
  };
};

for (const SEED of SEEDS) {
  await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0` },
    async ({ page }) => {
      const ramps = await page.evaluate(() => {
        window.__game.setPaused(true);
        return (window.__game.track.ramps || []).map(r => r.pad0);
      });
      console.log(`\n─── seed ${SEED} ───`);
      console.log('  site  moment   camera             h    lens above road'
        + '   clear road ahead   in frame to   first gone');
      for (let i = 0; i < ramps.length; i++) {
        for (const moment of ['road', 'APEX']) {
          for (const c of CONFIGS) {
            /* The constant is set before the car is driven, not after it has
               arrived. The boom and the lens height are sprung, so a value
               written two frames before the reading is a value the camera has
               not got to yet — the first version of this tool did that and
               reported a lens that had moved half a metre when the setting is
               worth nearly two. */
            await page.evaluate(([s, lift]) => {
              const g = window.__game;
              g.chase.airLift = lift;
              g.autopilot(true, 0.85);
              g.driveTo(s / g.track.length, { runUp: 320, maxSec: 45 });
            }, [ramps[i] - (moment === 'road' ? 260 : 60), c.lift]);
            if (moment === 'APEX') await page.evaluate(STEP_TO, ['apex', 0, 900]);
            const m = await page.evaluate(SIGHT, [REACH]);
            await page.evaluate(() => {
              window.__game.chase.airLift = 0;
              window.__game.autopilot(false);
            });
            console.log(`  r${i}   ${moment.padEnd(6)}  ${c.name.padEnd(17)}`
              + ` ${String(m.h).padStart(4)}   ${String(m.lensAbove).padStart(14)}`
              + `   ${String(m.clearTo).padStart(15)} m`
              + ` ${String(m.inFrameTo).padStart(12)} m`
              + ` ${String(m.firstGone).padStart(11)} m`);
          }
        }
      }
    });
}

finish(process.exitCode || 0);
