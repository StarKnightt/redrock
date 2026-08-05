/* The wheel spray, close up, at racing speed — and how many things it is.
 *
 * Every tool in this project measures the dust by area: what fraction of the
 * frame it covers, how many tones it holds, how much ink is on it. None of them
 * measures the thing the dust keeps being failed for. "Tan needles and shards
 * lying on the road" is not a statement about area or about value, it is a
 * statement about *count*: the eye finds several separate bright convex shapes
 * on grey tarmac and counts them before it reads any of them, and a countable
 * set of shapes is a set of objects however well each one is drawn.
 *
 * So this counts them. The plume mask is taken the way dustjudge takes it, by
 * rendering with and without the pool from one frozen frame, and then split
 * into four-connected components. An island's area and aspect say whether it is
 * a puff, a sliver or a needle; the number of islands says whether the spray is
 * one mass coming off the tyres or a scatter of chips. A soft continuous plume
 * is a handful of large islands. Polystyrene is thirty small ones.
 *
 * It also isolates the pool by kind, because the classes fail differently and
 * in a finished frame they are the same colour on top of each other: the round
 * dust puffs, the angular chunks, the tapered streaks. The last critic's
 * "needles and shards" was attributed to the landing burst, and it was not the
 * landing burst — it was these, which is only visible when they are drawn on
 * their own.
 *
 * Read-only. Nothing under src/ is touched.
 *
 *   node tools/wheelnear.mjs [--seed 22] [--n 6] [--only dust|streak|chunk]
 *                            [--zoom 5] [--bykind] [--tag name]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', 22);
const N = +flag('n', 6);
const ONLY = flag('only', 'all');
const ZOOM = +flag('zoom', 5);
const BYKIND = args.includes('--bykind');
/* Where on the stage to sit. A straight at full speed is the shot the critic
   judged: the spray is at its densest, it is closest to the lens, and there is
   no corner geometry in front of it to hide behind. */
const AT = +flag('at', 0.42);
const TAG = flag('tag', `wheelnear${SEED}`);

/* Islands below this many pixels are ignored. A dozen stray pixels at the edge
   of a soft plume are not a thing the eye counts; a hundred contiguous pixels
   of cream on tarmac at this magnification is. */
const MIN_ISLAND = 90;

await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
  async ({ page }) => {
  const out = await page.evaluate(([frames, only, byKind, at, minIsland, zoom]) => {
    const g = window.__game;
    const p = g.player;
    const pool = g.effects.particles;
    g.setPaused(true);
    g.autopilot(true, 1.0);
    g.driveTo(at, { runUp: 420, maxSec: 60 });
    /* A few more seconds of driving after arrival so the spray is in its steady
       state rather than however it looked on the frame the drive stopped. */
    for (let k = 0; k < 90; k++) g.step(1 / 60);

    const cv = g.renderer.domElement, w = cv.width, h = cv.height;
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tc = tmp.getContext('2d');
    const grab = () => { g.renderOnce(); tc.drawImage(cv, 0, 0); return tc.getImageData(0, 0, w, h).data; };
    const realNow = performance.now.bind(performance);

    const band = (kd) => (kd < 0.5 ? 0 : kd < 1.5 ? 1 : kd < 2.5 ? 2 : 3);
    const wanted = only === 'dust' ? 0 : only === 'chunk' ? 1 : only === 'streak' ? 2 : -1;
    const hide = () => {
      if (wanted < 0) return;
      for (let j = 0; j < pool.max; j++) {
        if (!pool.active[j] || band(pool.kind[j]) === wanted) continue;
        pool.scales[j * 2] = 0; pool.scales[j * 2 + 1] = 0;
      }
      pool.scaleAttr.needsUpdate = true;
    };

    const rows = [];
    const pngs = [];
    for (let f = 0; f < frames; f++) {
      g.setPaused(true);
      hide();
      if (byKind) {
        const wheel = [[1, 0.15, 0.15], [0.15, 1, 0.15], [0.2, 0.4, 1], [1, 0.9, 0.1]];
        for (let j = 0; j < pool.max; j++) {
          if (!pool.active[j]) continue;
          const rgb = wheel[band(pool.kind[j])];
          pool.colors[j * 3] = rgb[0] * 0.62;
          pool.colors[j * 3 + 1] = rgb[1] * 0.62;
          pool.colors[j * 3 + 2] = rgb[2] * 0.62;
        }
        pool.colorAttr.needsUpdate = true;
      }
      /* One clock across the three renders of this frame. The plume mask is
         the difference between "shown" and "bare" and the ink mask the
         difference between "shown" and "noink", so anything that moves
         between renders is scored as dust or as ink — and
         src/world/environment.js sets a shader uniform from
         performance.now() inside onBeforeRender, which sways every blade of
         grass in the frame. */
      const tPin = realNow(); performance.now = () => tPin;
      const shown = grab();
      pool.mesh.visible = false;
      const bare = grab();
      pool.mesh.visible = true;
      g.pipeline.inkEnabled = false;
      const noink = grab();
      g.pipeline.inkEnabled = true;
      performance.now = realNow;

      const mask = new Uint8Array(w * h);
      let plume = 0, inked = 0, world = 0, inkWorld = 0;
      for (let q = 0; q < shown.length; q += 4) {
        const dr = Math.abs(shown[q] - bare[q]) + Math.abs(shown[q + 1] - bare[q + 1])
          + Math.abs(shown[q + 2] - bare[q + 2]);
        const drop = (0.2126 * (noink[q] - shown[q]) + 0.7152 * (noink[q + 1] - shown[q + 1])
          + 0.0722 * (noink[q + 2] - shown[q + 2])) / 255;
        if (dr > 12) {
          mask[q >> 2] = 1; plume++;
          if (drop > 0.02) inked++;
        } else {
          world++;
          if (drop > 0.02) inkWorld++;
        }
      }

      /* Four-connected components, iterative so a plume the width of the road
         cannot blow the stack. */
      const seen = new Uint8Array(w * h);
      const stack = new Int32Array(w * h);
      const islands = [];
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i] || seen[i]) continue;
        let sp = 0, area = 0, x0 = w, x1 = -1, y0 = h, y1 = -1;
        stack[sp++] = i; seen[i] = 1;
        while (sp) {
          const c = stack[--sp];
          const x = c % w, y = (c / w) | 0;
          area++;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
          if (x > 0 && mask[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack[sp++] = c - 1; }
          if (x < w - 1 && mask[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack[sp++] = c + 1; }
          if (y > 0 && mask[c - w] && !seen[c - w]) { seen[c - w] = 1; stack[sp++] = c - w; }
          if (y < h - 1 && mask[c + w] && !seen[c + w]) { seen[c + w] = 1; stack[sp++] = c + w; }
        }
        if (area >= minIsland) {
          islands.push({ area, w: x1 - x0 + 1, h: y1 - y0 + 1 });
        }
      }
      islands.sort((a, b) => b.area - a.area);
      /* A needle is a small island that is much taller than it is wide, which is
         the shape the critic named twice. Counted separately from the total so
         that "one mass plus three needles" and "four puffs" do not read the
         same. */
      const needles = islands.filter(s => s.area < 4000
        && Math.max(s.h / s.w, s.w / s.h) > 2.2).length;
      const biggest = islands.length ? islands[0].area / Math.max(plume, 1) : 0;

      rows.push({
        f,
        plume: +(plume / (w * h) * 100).toFixed(3),
        ink: +(plume ? inked / plume * 100 : 0).toFixed(2),
        world: +(inkWorld / world * 100).toFixed(2),
        islands: islands.length,
        needles,
        biggest: +(biggest * 100).toFixed(1),
        median: islands.length ? islands[(islands.length / 2) | 0].area : 0,
        speed: +(p.speed || 0).toFixed(1),
        live: pool.live ?? 0,
      });

      if (f === frames - 1) {
        g.renderOnce();
        /* Magnified on the car, because that is the only scale at which this
           defect exists. Every wide capture of the spray reads as a pale smear;
           the needles are a few dozen pixels each and the critic found them at
           three and a half times. */
        const c = document.createElement('canvas');
        const bw = 1000, bh = 560, sw = bw / zoom, sh = bh / zoom;
        const q = p.pos.clone().project(g.camera);
        c.width = bw; c.height = bh;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(cv, Math.max(0, Math.min(w - sw, (q.x * 0.5 + 0.5) * w - sw / 2)),
          Math.max(0, Math.min(h - sh, (-q.y * 0.5 + 0.5) * h - sh * 0.35)), sw, sh, 0, 0, bw, bh);
        pngs.push({ f, full: cv.toDataURL('image/png'), crop: c.toDataURL('image/png') });
      }

      g.setPaused(false);
      g.step(1 / 60);
    }
    return { rows, pngs, w, h };
  }, [N, ONLY, BYKIND, AT, MIN_ISLAND, ZOOM]);

  const dir = path.join(ROOT, 'shots', TAG);
  fs.mkdirSync(dir, { recursive: true });
  for (const s of out.pngs) {
    const nn = String(s.f).padStart(2, '0');
    fs.writeFileSync(path.join(dir, `f${nn}.png`), Buffer.from(s.full.split(',')[1], 'base64'));
    if (s.crop) fs.writeFileSync(path.join(dir, `f${nn}-crop.png`),
      Buffer.from(s.crop.split(',')[1], 'base64'));
  }
  console.log(`  → shots/${TAG}   only=${ONLY}${BYKIND ? ' bykind' : ''}`);
  console.log('\n  frame  plume%   ink%  world%  islands  needles  biggest%  median  km/h  live');
  for (const r of out.rows) {
    console.log(`  ${String(r.f).padStart(5)}${r.f === 0 ? '*' : ' '}${r.plume.toFixed(3).padStart(7)}`
      + ` ${r.ink.toFixed(2).padStart(6)} ${r.world.toFixed(2).padStart(7)}`
      + ` ${String(r.islands).padStart(8)} ${String(r.needles).padStart(8)}`
      + ` ${r.biggest.toFixed(1).padStart(9)} ${String(r.median).padStart(7)}`
      + ` ${(r.speed * 3.6).toFixed(0).padStart(5)} ${String(r.live).padStart(5)}`);
  }
  /* Frame 0 is the drive-in artifact and is not averaged. The first render
     after a long driveTo carries edge pixels that land in both masks, and ink
     *is* edge pixels: on seed 22 frame 0 reads 36% ink and 45 islands where
     the settled frames read 7% and 8. Averaging it in is how this tool once
     reported 26.7% ink for a stage that holds 3.5%. */
  const live = out.rows.filter(r => r.f > 0);
  const n = live.length || 1;
  const mean = (k) => live.reduce((a, b) => a + b[k], 0) / n;
  console.log(`\n  mean ${mean('islands').toFixed(1)} islands, ${mean('needles').toFixed(1)}`
    + ` needle-shaped, largest holds ${mean('biggest').toFixed(1)}% of the plume`
    + `, ${mean('ink').toFixed(1)}% ink`);
  if (out.rows.some(r => r.f === 0)) {
    console.log('  * frame 0 is the driveTo artifact and is excluded from the mean.');
  }
});

finish(process.exitCode || 0);
