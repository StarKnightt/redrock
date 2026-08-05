/* Whether a capture reads, as numbers.
 *
 * `murk.mjs` needs the sim running and answers "what is under this pixel".
 * This one takes finished PNGs and answers "is the frame still legible",
 * which is the only way to compare a shot against one taken before a change
 * without keeping two builds alive at once. The number that matters is
 * `modal`: the share of the frame sitting in one bucket of the value ladder.
 * Past about seventy per cent the outlines are the only thing separating
 * shapes. `p05` and `p95` are the anchors — a fill that lifts those has
 * flooded the shadows or blown the highlights rather than opened the middle.
 *
 * The top third is skipped: the sky is hand-banded vertex colour that never
 * sees a light, and leaving it in swamps the world it is meant to describe.
 *
 *   node tools/imgstat.mjs shots/before/092.png shots/after/092.png
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');

for (const f of files) {
  const b64 = readFileSync(f).toString('base64');
  const out = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    // Sky is a hand-painted gradient and is not part of the shading ladder;
    // sample only the lower two thirds so the numbers describe the world.
    const y0 = Math.floor(c.height / 3);
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const L = [];
    let sat = 0;
    for (let y = y0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        const r = d[i], gg = d[i + 1], bb = d[i + 2];
        L.push(0.2126 * lin(r) + 0.7152 * lin(gg) + 0.0722 * lin(bb));
        const mx = Math.max(r, gg, bb), mn = Math.min(r, gg, bb);
        sat += mx === 0 ? 0 : (mx - mn) / mx;
      }
    }
    const n = L.length;
    const mean = L.reduce((a, v) => a + v, 0) / n;
    const sd = Math.sqrt(L.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
    const bins = new Array(16).fill(0);
    for (const v of L) bins[Math.min(15, Math.floor(Math.cbrt(v) * 16))]++;
    const modal = Math.max(...bins) / n;
    const s = [...L].sort((a, b) => a - b);
    const p = (q) => s[Math.floor(q * (n - 1))];
    return { mean, sd, modal, p05: p(0.05), p50: p(0.5), p95: p(0.95), sat: sat / n };
  }, b64);
  console.log(
    f.padEnd(46),
    'mean', out.mean.toFixed(3),
    'sd', out.sd.toFixed(4),
    'modal', (out.modal * 100).toFixed(1) + '%',
    'p05', out.p05.toFixed(3),
    'p50', out.p50.toFixed(3),
    'p95', out.p95.toFixed(3),
    'sat', out.sat.toFixed(3),
  );
}
await browser.close();
