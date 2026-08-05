/* Does the plumb mark have a shadow's value, or a hole's?
 *
 * src/fx/airmark.js claims the mark cannot read as a hole or as paint because
 * it has no colour of its own: it is a multiply against the frame, so its hue
 * is the ground's hue and its value is a fixed fraction of the ground's value.
 * The fraction is meant to be the one the sun's own cast shadows already have.
 * This measures both, in the composed frame the player sees, and puts them next
 * to each other.
 *
 * Method. Two ablations per moment, each a pair of renders that differ in one
 * thing, so the pixels a layer owns are exactly the pixels the pair disagrees
 * about — and for those pixels both the covered value and the covering value
 * are in hand, so the ratio is per-pixel rather than per-region.
 *
 *   sun shadow   the car casting against the car not casting, on the road,
 *                where its shadow is under the car and unambiguous.
 *   plumb mark   the mark drawn against the mark hidden, at the apex.
 *
 * Reported as percentiles of the per-pixel ratio rather than a mean: the mark
 * has two bands by design and a mean would land between them and describe
 * neither. And in absolute displayed luminance as well as ratio, because "not a
 * hole" is a claim about the absolute value — a hole is darker than any shadow
 * in the frame, and the ink is darker still.
 *
 * The composite is not a linear function of the beauty target, so a multiply of
 * 0.30 in linear light does not arrive as 0.30 on the screen. That is exactly
 * why the sun's shadow is measured the same way in the same frame instead of
 * the algebra being trusted.
 *
 * performance.now pinned; frame 0 after any state change discarded.
 *
 *   node tools/zjshade.mjs [--seeds 22,40]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,40').split(',').map(Number);
const W = 1600, H = 900;

const PROBE = () => {
  const g = window.__game;
  g.setPaused(true);
  const cv = g.renderer.domElement, w = cv.width, h = cv.height;
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const tc = tmp.getContext('2d', { willReadFrequently: true });
  const grab = () => {
    g.renderOnce(); tc.drawImage(cv, 0, 0);
    return tc.getImageData(0, 0, w, h).data;
  };
  const realNow = performance.now.bind(performance);
  const tPin = realNow(); performance.now = () => tPin;

  const casters = [];
  g.playerView.root.traverse(o => { if (o.isMesh && o.castShadow) casters.push(o); });
  const mark = g.effects?.airMark?.mesh || null;

  /* Both layers off, so each is measured against the same bare frame and the
     two ratios are not contaminated by each other. */
  const markWas = mark ? mark.visible : false;
  if (mark) mark.visible = false;
  for (const o of casters) o.castShadow = false;
  grab();
  const bare = grab();

  for (const o of casters) o.castShadow = true;
  grab();
  const withSun = grab();
  for (const o of casters) o.castShadow = false;

  let withMark = null;
  if (mark) {
    mark.visible = markWas;
    grab();
    withMark = grab();
  }
  for (const o of casters) o.castShadow = true;
  if (mark) mark.visible = markWas;

  performance.now = realNow;

  const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  const measure = (over) => {
    if (!over) return null;
    const ratios = [], covered = [], covering = [];
    for (let i = 0; i < bare.length; i += 4) {
      const d = Math.abs(over[i] - bare[i]) + Math.abs(over[i + 1] - bare[i + 1])
        + Math.abs(over[i + 2] - bare[i + 2]);
      if (d <= 12) continue;
      const a = lum(bare, i), b = lum(over, i);
      if (a < 4) continue;         // nothing to be a fraction of
      ratios.push(b / a); covered.push(a); covering.push(b);
    }
    if (!ratios.length) return { n: 0 };
    ratios.sort((x, y) => x - y);
    covering.sort((x, y) => x - y);
    const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
    return {
      n: ratios.length,
      r10: +q(ratios, 0.10).toFixed(3),
      r50: +q(ratios, 0.50).toFixed(3),
      r90: +q(ratios, 0.90).toFixed(3),
      /* Absolute displayed luminance of the darkest of it, 0-255. The "hole"
         question is whether this goes below what a shadow in this frame does. */
      dark: +q(covering, 0.02).toFixed(1),
      mid: +q(covering, 0.50).toFixed(1),
    };
  };

  /* And the floor of the frame: the darkest non-ink value anywhere in it, so
     "darker than any shadow" has something to be compared against. */
  const all = [];
  for (let i = 0; i < bare.length; i += 4) all.push(lum(bare, i));
  all.sort((a, b) => a - b);

  return {
    h: +g.player.height.toFixed(2),
    sun: measure(withSun),
    mark: measure(withMark),
    frameFloor: +all[Math.floor(all.length * 0.005)].toFixed(1),
    frameP5: +all[Math.floor(all.length * 0.05)].toFixed(1),
  };
};

for (const SEED of SEEDS) {
  await run({ width: W, height: H, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0` },
    async ({ page }) => {
      const ramps = await page.evaluate(() => {
        window.__game.setPaused(true);
        return (window.__game.track.ramps || []).map(r => ({ pad0: r.pad0 }));
      });
      const STEP = (until, arg = 0) => page.evaluate(([until, arg]) => {
        const g = window.__game, p = g.player;
        const test = until === 'pad' ? () => p.s >= arg : () => p.airborne && p.vertVel <= 0;
        let n = 0;
        while (n++ < 900) { g.step(1 / 60); if (test()) break; }
        return n < 900;
      }, [until, arg]);

      console.log(`\n─── seed ${SEED} ───`);
      console.log('  site  moment    h     layer        px      ratio 10/50/90'
        + '        darkest   median   frame floor');
      for (let i = 0; i < ramps.length; i++) {
        await page.evaluate(s => {
          const g = window.__game;
          g.autopilot(true, 0.85);
          g.driveTo(s / g.track.length, { runUp: 320, maxSec: 45 });
        }, ramps[i].pad0 - 60);
        await STEP('pad', ramps[i].pad0 - 40);
        const road = await PROBE_ON(page);
        await STEP('apex');
        const apex = await PROBE_ON(page);
        await page.evaluate(() => window.__game.autopilot(false));

        for (const [name, m] of [['road', road], ['APEX', apex]]) {
          for (const [layer, s] of [['sun shadow', m.sun], ['plumb mark', m.mark]]) {
            if (!s || !s.n) {
              console.log(`  r${i}    ${name.padEnd(6)} ${String(m.h).padStart(5)}`
                + `  ${layer.padEnd(11)} ${'—'.padStart(7)}   (not in frame)`);
              continue;
            }
            console.log(`  r${i}    ${name.padEnd(6)} ${String(m.h).padStart(5)}`
              + `  ${layer.padEnd(11)} ${String(s.n).padStart(7)}`
              + `   ${s.r10.toFixed(3)} / ${s.r50.toFixed(3)} / ${s.r90.toFixed(3)}`
              + `      ${String(s.dark).padStart(6)}   ${String(s.mid).padStart(6)}`
              + `   ${String(m.frameFloor).padStart(6)}`);
          }
        }
      }
    });
}

async function PROBE_ON(page) { return page.evaluate(PROBE); }

finish(process.exitCode || 0);
