/* Crop and magnify a finished PNG, so a claim about a 20-pixel marking can be
 * looked at instead of argued about. Read-only; writes only what it is told to.
 *
 *   node tools/zoom.mjs in.png out.png x y w h [scale]
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const [inF, outF, x, y, w, h, scale = 4] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('about:blank');
const url = await page.evaluate(async ([b64, x, y, w, h, s]) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = w * s; c.height = h * s;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, x, y, w, h, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}, [readFileSync(inF).toString('base64'), +x, +y, +w, +h, +scale]);
writeFileSync(outF, Buffer.from(url.split(',')[1], 'base64'));
await browser.close();
console.log(`${outF}  ${w}x${h} @${scale}x`);
