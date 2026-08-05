/* Review probe (read-only): the approach, as the driver gets it.
 *
 * The question the brief asks is "so the player sees them coming", and the
 * only honest test of that is a frame taken from a car at racing speed at a
 * stated distance from the thing. This drives in with the AI, stops at a
 * ladder of distances short of the pad, and takes a full frame plus a
 * magnified crop centred on the pad at each rung — through g.pipeline.render(),
 * no teleports.
 *
 * Alongside each frame it reports what the pad and the lip stripe are worth in
 * pixels, measured the only way that cannot be argued with: render the frame,
 * render it again with the marking meshes hidden, and count the pixels that
 * changed. That is an exact area for the marking as drawn, including whatever
 * the road is doing to it.
 *
 * Nothing under src/ is touched.
 *
 *   node tools/c2approach.mjs [--seed 22] [--ramp 1] [--zoom 4]
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
const RAMP = +flag('ramp', 1);
const ZOOM = +flag('zoom', 4);
const RUNGS = (flag('at', '150,120,90,60,35') || '').split(',').map(Number);
const TAG = flag('tag', `c2approach${SEED}`);

await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
  async ({ page }) => {
    const n = await page.evaluate(() => {
      window.__game.setPaused(true);
      return window.__game.track.ramps.length;
    });
    const idx = Math.min(RAMP, n - 1);

    const out = await page.evaluate(([i, rungs, zoom]) => {
      const g = window.__game, p = g.player, r = g.track.ramps[i];
      const cv = g.renderer.domElement, w = cv.width, h = cv.height;
      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      const tc = tmp.getContext('2d');
      const grab = () => { g.renderOnce(); tc.drawImage(cv, 0, 0); return tc.getImageData(0, 0, w, h).data; };
      const realNow = performance.now.bind(performance);

      /* Every mesh whose name suggests it carries a ramp marking, so the
         difference render isolates paint from road. Collected by name rather
         than assumed, and listed in the output so the attribution is checkable. */
      const marks = [];
      g.scene.traverse(o => {
        const nm = (o.name || '').toLowerCase();
        if (o.isMesh && /^ramp-/.test(nm)) marks.push(o);
      });

      g.setPaused(true);
      if (g.race?.entries) g.race.entries.length = 0;
      g.autopilot(true, 0.9);

      const rows = [], pngs = [];
      for (const d of rungs) {
        const s = r.pad0 - d;
        g.driveTo(s / g.track.length, { runUp: 340, maxSec: 45 });
        g.setPaused(true);
        /* Pinned across the pair, and the drive-in's first grab discarded.
           This isolates the ramp markings by hiding them and differencing, so
           anything that moves between the two renders is scored as paint —
           and src/world/environment.js animates a shader uniform off
           performance.now() inside onBeforeRender, so the grass moves. */
        const tPin = realNow(); performance.now = () => tPin;
        grab();

        const shown = grab();
        const was = marks.map(o => o.visible);
        marks.forEach(o => { o.visible = false; });
        const bare = grab();
        marks.forEach((o, k) => { o.visible = was[k]; });
        performance.now = realNow;

        let px = 0, sumR = 0, sumG = 0, sumB = 0;
        let mnX = w, mxX = -1, mnY = h, mxY = -1;
        for (let q = 0; q < shown.length; q += 4) {
          const dr = Math.abs(shown[q] - bare[q]) + Math.abs(shown[q + 1] - bare[q + 1])
            + Math.abs(shown[q + 2] - bare[q + 2]);
          if (dr <= 12) continue;
          px++;
          sumR += shown[q]; sumG += shown[q + 1]; sumB += shown[q + 2];
          const id = q >> 2, x = id % w, y = (id / w) | 0;
          if (x < mnX) mnX = x; if (x > mxX) mxX = x;
          if (y < mnY) mnY = y; if (y > mxY) mxY = y;
        }
        const hex = px ? '#' + [sumR, sumG, sumB].map(v =>
          Math.round(v / px).toString(16).padStart(2, '0')).join('') : '-';

        /* Where the pad centre lands on screen, so the crop is on the marking
           and not on the car. */
        const f = g.track.frameAt((r.pad0 + r.pad1) * 0.5);
        const q = f.pos.clone().addScaledVector(f.up, 0.2).project(g.camera);
        const cx = (q.x * 0.5 + 0.5) * w, cy = (-q.y * 0.5 + 0.5) * h;

        rows.push({
          d, s: Math.round(p.s), toLip: Math.round(r.lip - p.s),
          kmh: Math.round(p.speed * 3.6), px, hex,
          box: px ? `${mxX - mnX + 1}x${mxY - mnY + 1}` : '-',
        });

        g.renderOnce();
        const c = document.createElement('canvas');
        const bw = 900, bh = 500, sw = bw / zoom, sh = bh / zoom;
        c.width = bw; c.height = bh;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(cv, Math.max(0, Math.min(w - sw, cx - sw / 2)),
          Math.max(0, Math.min(h - sh, cy - sh * 0.55)), sw, sh, 0, 0, bw, bh);
        pngs.push({ d, full: cv.toDataURL('image/png'), crop: c.toDataURL('image/png') });
      }
      g.autopilot(false);
      return { rows, pngs, marks: marks.map(o => o.name).slice(0, 12), nMarks: marks.length };
    }, [idx, RUNGS, ZOOM]);

    const dir = path.join(ROOT, 'shots', TAG);
    fs.mkdirSync(dir, { recursive: true });
    for (const s of out.pngs) {
      fs.writeFileSync(path.join(dir, `d${s.d}.png`), Buffer.from(s.full.split(',')[1], 'base64'));
      fs.writeFileSync(path.join(dir, `d${s.d}-crop.png`), Buffer.from(s.crop.split(',')[1], 'base64'));
    }
    console.log(`\n  seed ${SEED} ramp ${idx} → shots/${TAG}`);
    console.log(`  marking meshes hidden for the difference (${out.nMarks}): ${out.marks.join(', ')}`);
    console.log('\n   m short of pad    s   to lip   km/h   marking px²      box   mean colour');
    for (const r of out.rows) {
      console.log(`  ${String(r.d).padStart(15)} ${String(r.s).padStart(5)}`
        + ` ${String(r.toLip).padStart(8)} ${String(r.kmh).padStart(6)}`
        + ` ${String(r.px).padStart(13)} ${r.box.padStart(9)}   ${r.hex}`);
    }
  });

finish(process.exitCode || 0);
