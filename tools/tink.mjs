/* Does the ink still read inside the bore?
 *
 * The failure this is watching for has happened on this stage before: in dark
 * terrain the black outlines stopped separating from what they were drawn on,
 * and the cel read collapsed into a silhouette. A tunnel is the darkest place
 * on the stage, so the question needs an answer in pixels — how much of the
 * frame the ink pass actually darkens, and by how much, compared with the same
 * measurement out in daylight.
 *
 *   node tools/tink.mjs [--seed 22]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');

await run({ width: 1024, height: 576, hash: `manual&tier=high&seed=${SEED}&cap=60&ink=1` }, async ({ page }) => {
  const out = await page.evaluate(async () => {
    const g = window.__game;
    const span = g.field.tunnel;
    const L = g.track.length;
    const grab = () => {
      g.renderOnce();
      const cv = g.renderer.domElement, w = cv.width, h = cv.height;
      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      tmp.getContext('2d').drawImage(cv, 0, 0);
      return tmp.getContext('2d').getImageData(0, 0, w, h).data;
    };
    const realNow = performance.now.bind(performance);
    const at = (name, s) => {
      g.driveTo(Math.max(0, Math.min(L - 5, s)) / L);
      g.setPaused(true);
      /* Pinned, and the drive-in's first grab discarded. This differences an
         inked render against an un-inked one, and src/world/environment.js
         drives a shader uniform off performance.now() inside onBeforeRender —
         so unpinned, every blade of grass that moved between the two renders
         was counted as ink coverage on a stage that is largely grass. */
      const tPin = realNow(); performance.now = () => tPin;
      grab();
      g.pipeline.inkEnabled = true;
      const inked = grab();
      g.pipeline.inkEnabled = false;
      const plain = grab();
      g.pipeline.inkEnabled = true;
      performance.now = realNow;
      let n = 0, drawn = 0, depth = 0, faint = 0;
      for (let i = 0; i < inked.length; i += 4) {
        const a = 0.2126 * plain[i] + 0.7152 * plain[i + 1] + 0.0722 * plain[i + 2];
        const b = 0.2126 * inked[i] + 0.7152 * inked[i + 1] + 0.0722 * inked[i + 2];
        n++;
        const d = (a - b) / 255;
        if (d > 0.02) {
          drawn++;
          depth += d;
          /* An outline that only moves the pixel it is drawn on by a few
             percent of full scale is a line you cannot see. */
          if (d < 0.06) faint++;
        }
      }
      return {
        name, s,
        coverage: (100 * drawn) / n,
        depth: drawn ? depth / drawn : 0,
        faint: drawn ? (100 * faint) / drawn : 0,
      };
    };
    const rows = [];
    rows.push(at('open road, before', span.s0 - 220));
    rows.push(at('approach', span.s0 - 60));
    rows.push(at('inside, first third', span.s0 + (span.s1 - span.s0) * 0.33));
    rows.push(at('inside, mid', (span.s0 + span.s1) / 2));
    rows.push(at('inside, last third', span.s0 + (span.s1 - span.s0) * 0.72));
    rows.push(at('open road, after', span.s1 + 90));
    return { rows, s0: span.s0, s1: span.s1 };
  });
  console.log(`\n  bore ${out.s0.toFixed(0)}–${out.s1.toFixed(0)} m\n`);
  console.log('  position                 station   ink coverage   mean darkening   of those, faint');
  for (const r of out.rows) {
    console.log(`  ${r.name.padEnd(22)} ${String(Math.round(r.s)).padStart(7)}`
      + ` ${(r.coverage.toFixed(2) + '%').padStart(14)}`
      + ` ${r.depth.toFixed(3).padStart(16)}`
      + ` ${(r.faint.toFixed(0) + '%').padStart(17)}`);
  }
  console.log();
});
finish(process.exitCode || 0);
