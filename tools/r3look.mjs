/* Round-3 review instrument (read-only): frames of the approach, plus a luma
 * and saturation profile taken across the road at the pad and at the ramp face.
 *
 * The face chevrons are painted into the road mesh's own vertex colours, so
 * they cannot be isolated by hiding a mesh. What can be done honestly is to
 * walk a line across the road in the finished frame and print what the pixels
 * do: paint that announces itself puts a step in that profile, paint that does
 * not is a wobble in the road's own mottle.
 *
 *   node tools/r3look.mjs [--seed 22] [--ramp 1] [--at 120,90,60,40,25,14]
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
const RUNGS = (flag('at', '120,90,60,40,25,14') || '').split(',').map(Number);
const TAG = flag('tag', `r3look${SEED}`);

await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
  async ({ page }) => {
    const out = await page.evaluate(([idx, rungs]) => {
      const g = window.__game, p = g.player, track = g.track;
      const cv = g.renderer.domElement, w = cv.width, h = cv.height;
      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      const tc = tmp.getContext('2d');
      const grab = () => { g.renderOnce(); tc.drawImage(cv, 0, 0); return tc.getImageData(0, 0, w, h).data; };
      g.setPaused(true);
      if (g.race?.entries) g.race.entries.length = 0;
      const r = track.ramps[Math.min(idx, track.ramps.length - 1)];
      g.autopilot(true, 0.85);

      const rows = [], pngs = [], profiles = [];
      for (const d of rungs) {
        g.driveTo((r.pad0 - d) / track.length, { runUp: 340, maxSec: 45 });
        g.setPaused(true);
        const px = grab();

        const at = (s, lat) => {
          const f = track.frameAt(s);
          const v = f.pos.clone().addScaledVector(f.right, lat * f.width * 0.5)
            .addScaledVector(f.up, 0.036 + track.rampHeight(s, 0));
          const q = v.clone().project(g.camera);
          return { x: Math.round((q.x * 0.5 + 0.5) * w), y: Math.round((-q.y * 0.5 + 0.5) * h) };
        };
        const sample = (s, lat) => {
          const c = at(s, lat);
          if (c.x < 0 || c.y < 0 || c.x >= w || c.y >= h) return null;
          const i = (c.y * w + c.x) * 4;
          const R = px[i], G = px[i + 1], B = px[i + 2];
          const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
          return { L: (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255, S: (mx - mn) / (mx || 1) };
        };
        /* Across the road at a station, 41 samples kerb to kerb. */
        const line = (s) => {
          const L = [], S = [];
          for (let k = 0; k <= 40; k++) {
            const c = sample(s, -1 + k / 20);
            L.push(c ? +c.L.toFixed(3) : null); S.push(c ? +c.S.toFixed(2) : null);
          }
          const ok = L.filter(v => v !== null);
          return { L, S, span: ok.length ? +(Math.max(...ok) - Math.min(...ok)).toFixed(3) : 0 };
        };
        profiles.push({
          d,
          padCore: line((r.pad0 + r.pad1) / 2),
          face: line(r.foot + 2.5 + 1.6),
          plain: line(r.pad0 - 18),
        });

        /* Crop centred on the pad. */
        const c0 = at((r.pad0 + r.pad1) / 2, 0);
        const zoom = d > 70 ? 6 : (d > 30 ? 4 : 2.5);
        const c = document.createElement('canvas');
        const bw = 1000, bh = 560, sw = Math.round(bw / zoom), sh = Math.round(bh / zoom);
        c.width = bw; c.height = bh;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(cv, Math.max(0, Math.min(w - sw, c0.x - sw / 2)),
          Math.max(0, Math.min(h - sh, c0.y - sh * 0.6)), sw, sh, 0, 0, bw, bh);
        pngs.push({ d, full: cv.toDataURL('image/png'), crop: c.toDataURL('image/png'), zoom });
        rows.push({ d, s: Math.round(p.s), kmh: Math.round(p.speed * 3.6), zoom });
      }
      g.autopilot(false);
      return { rows, pngs, profiles, lip: r.lip, seed: track.seed };
    }, [RAMP, RUNGS]);

    const dir = path.join(ROOT, 'shots', TAG);
    fs.mkdirSync(dir, { recursive: true });
    for (const s of out.pngs) {
      fs.writeFileSync(path.join(dir, `d${s.d}.png`), Buffer.from(s.full.split(',')[1], 'base64'));
      fs.writeFileSync(path.join(dir, `d${s.d}-crop.png`), Buffer.from(s.crop.split(',')[1], 'base64'));
    }
    console.log(`\n  seed ${out.seed}, lip ${out.lip} → shots/${TAG}`);
    for (const r of out.rows) console.log(`   d${r.d}: s ${r.s}, ${r.kmh} km/h, crop zoom x${r.zoom}`);
    const bar = v => v === null ? ' ' : ' .:-=+*#%@'[Math.min(9, Math.max(0, Math.round(v * 12)))];
    console.log('\n  luma across the road, kerb to kerb (41 samples). ' +
      'scale " .:-=+*#%@" is luma 0 to 0.75');
    for (const pr of out.profiles) {
      console.log(`\n   d${pr.d}  pad     |${pr.padCore.L.map(bar).join('')}|  span ${pr.padCore.span}`);
      console.log(`        face    |${pr.face.L.map(bar).join('')}|  span ${pr.face.span}`);
      console.log(`        plain   |${pr.plain.L.map(bar).join('')}|  span ${pr.plain.span}`);
      console.log(`        sat pad |${pr.padCore.S.map(v => v === null ? ' ' : ' .:-=+*#%@'[Math.min(9, Math.round(v * 10))]).join('')}|`);
      console.log(`        sat face|${pr.face.S.map(v => v === null ? ' ' : ' .:-=+*#%@'[Math.min(9, Math.round(v * 10))]).join('')}|`);
      console.log(`        sat plan|${pr.plain.S.map(v => v === null ? ' ' : ' .:-=+*#%@'[Math.min(9, Math.round(v * 10))]).join('')}|`);
    }
  });

finish(process.exitCode || 0);
