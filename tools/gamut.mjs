/* Diagnostic: what the ladder and the grade do to saturated colour.
 *
 * The value ladder quantises luminance and carries chroma through by scaling
 * all three channels to hit the chosen rung. That is well behaved on a stage
 * painted in one hue, and it is not obviously well behaved on a palette built
 * out of ocean blue, cliff green and flower magenta: luminance weights blue at
 * 0.07 and green at 0.72, so the same nominal brightness of blue and green are
 * nowhere near each other on the ladder, and the rescale that lands a colour
 * on its rung can push a channel that is already near full straight out of
 * gamut. Both effects show up as flattening — an ocean that loses its
 * modelling, a green that goes fluorescent — and neither is visible until
 * there is saturated colour in the frame to see it on.
 *
 * So this puts a chart of known colours through the real shaders rather than
 * through a reimplementation of them: swatches are drawn with the actual cel
 * material and composited by the actual pipeline, so the ladder, the grade and
 * the single sRGB encode are all the ones the game ships.
 *
 *   node tools/gamut.mjs [tag]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { run, serve } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ *
 * Frame statistics: node tools/gamut.mjs --frames shots/run/*.png
 *
 * The chart above says what the pipeline does to a colour presented to it.
 * This says what the frame is actually made of, which is a different question
 * and the one the critic was answering by eye: is the histogram mid-heavy, are
 * there genuine blacks and held highlights, and how many hues are in play.
 * ------------------------------------------------------------------ */

/* Chromium writes 8-bit non-interlaced RGBA, so only that path is handled —
   anything else throws rather than silently mis-reading. */
function readPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let p = 8, w = 0, h = 0, bitDepth = 0, colour = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4);
      bitDepth = body[8]; colour = body[9];
      if (body[12]) throw new Error('interlaced png unsupported');
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bitDepth !== 8 || (colour !== 6 && colour !== 2)) {
    throw new Error(`unsupported png: depth ${bitDepth} colour ${colour}`);
  }
  const bpp = colour === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * bpp);
  const stride = w * bpp;
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = src[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

function frameStats(file) {
  const { w, h, bpp, data } = readPng(fs.readFileSync(file));
  const deciles = new Array(10).fill(0);
  const hues = new Array(12).fill(0);
  let n = 0, chromaSum = 0, chromatic = 0;
  for (let i = 0; i < w * h; i++) {
    const r = data[i * bpp], g = data[i * bpp + 1], b = data[i * bpp + 2];
    /* Value in sRGB rather than linear light: the question is how the frame
       is distributed to the eye, and the eye reads the encoded signal. */
    const v = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    deciles[Math.min(9, Math.floor(v * 10))]++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    const chroma = mx ? d / mx : 0;
    chromaSum += chroma;
    /* Hue counted only where there is enough colour for it to mean anything,
       so a frame of grey does not report twelve hues' worth of noise. */
    if (chroma > 0.18 && mx > 30) {
      let hh;
      if (mx === r) hh = ((g - b) / d + 6) % 6;
      else if (mx === g) hh = (b - r) / d + 2;
      else hh = (r - g) / d + 4;
      hues[Math.floor(hh * 2) % 12]++;
      chromatic++;
    }
    n++;
  }
  const pct = deciles.map(c => (c / n) * 100);
  return {
    file: path.relative(ROOT, file),
    darks: +pct[0].toFixed(1),
    highs: +pct[9].toFixed(1),
    mids: +(pct[3] + pct[4] + pct[5] + pct[6]).toFixed(1),
    meanChroma: +(chromaSum / n).toFixed(3),
    /* How many twelfths of the hue circle hold at least two percent of the
       coloured pixels. This is the number the "hue monotony" complaint was
       about, and a desert frame scored two. */
    hueBins: hues.filter(c => chromatic && c / chromatic > 0.02).length,
    deciles: pct.map(v => +v.toFixed(1)),
  };
}

/* A horizontal cut across the road, run-length encoded by rung.
   "It looks like a lane marking" is not something a world author can act on.
   The width of the pale run, its value separation from the surface either side
   of it and how straight it stays from one cut to the next are. */
if (process.argv.includes('--scan')) {
  const args = process.argv.slice(process.argv.indexOf('--scan') + 1);
  const file = path.resolve(ROOT, args[0]);
  const { w, h, bpp, data } = readPng(fs.readFileSync(file));
  for (const yf of (args[1] ? [Number(args[1])] : [0.78, 0.86, 0.94])) {
    const y = Math.round(h * yf);
    const runs = [];
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * bpp;
      const v = Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
      const last = runs[runs.length - 1];
      // Tolerance of two: MSAA leaves a pixel of blend at every band edge.
      if (last && Math.abs(last.v - v) <= 2) { last.n++; last.v = v; }
      else runs.push({ v, n: 1 });
    }
    const big = runs.filter(r => r.n >= 8);
    console.log(`  y=${(yf * 100).toFixed(0)}%  ${big.length} runs >=8px:  ` +
      big.map(r => `${r.v}x${r.n}`).join('  '));
  }
  finish(process.exitCode || 0);
}

if (process.argv.includes('--frames')) {
  const files = process.argv.slice(process.argv.indexOf('--frames') + 1)
    .filter(a => !a.startsWith('--'));
  console.log('  frame                        darks%  mids%  highs%  chroma  hues/12');
  for (const f of files) {
    const s = frameStats(path.resolve(ROOT, f));
    console.log(`  ${s.file.padEnd(26)} ${String(s.darks).padStart(6)}` +
                ` ${String(s.mids).padStart(6)} ${String(s.highs).padStart(7)}` +
                ` ${String(s.meanChroma).padStart(7)} ${String(s.hueBins).padStart(8)}`);
    console.log(`    deciles ${s.deciles.join(' ')}`);
  }
  finish(process.exitCode || 0);
}
const tag = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'gamut';
const outDir = path.join(ROOT, 'shots', tag);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

/* Rows are families, columns are a value ramp within the family. The ramps
   matter more than the individual colours: what is being measured is how many
   distinct steps a family still has after the ladder, and a family that
   collapses to one step has lost its modelling whatever its hue does. */
const CHART = [
  ['ocean', [0x06263f, 0x0b3f66, 0x11608f, 0x1a86bd, 0x37b0dd, 0x74d4ee]],
  ['teal', [0x05302f, 0x0a4f4a, 0x0f7268, 0x179a88, 0x2ec2a8, 0x6fe0c8]],
  ['cliff', [0x11290f, 0x1d461a, 0x2d6b25, 0x419433, 0x5cbd47, 0x8fdd6f]],
  ['grass', [0x2a3a10, 0x46601a, 0x658a25, 0x88b533, 0xafd94b, 0xd3f07c]],
  ['flower-magenta', [0x3a0a2a, 0x631244, 0x8f1a63, 0xbf2585, 0xe248a8, 0xf484c9]],
  ['flower-yellow', [0x453309, 0x715610, 0xa27d19, 0xd0a524, 0xefc846, 0xfbe38c]],
  ['flower-orange', [0x431c07, 0x70300c, 0xa14712, 0xd0631d, 0xef8636, 0xfbb072]],
  ['golden-sky', [0x5a2a20, 0x8c4530, 0xbd6640, 0xdd8d59, 0xf0b183, 0xfad6b6]],
  ['road-grey', [0x1d1e20, 0x343639, 0x4e5155, 0x6c7075, 0x8d9298, 0xb3b8be]],
  ['neutral', [0x101010, 0x2c2c2c, 0x545454, 0x808080, 0xb0b0b0, 0xe4e4e4]],
];

const W = 1200, H = 760;

const srv = serve();
await new Promise(r => srv.listen(0, r));
const url = `http://localhost:${srv.address().port}/tools/gamut.html`;

await run({ width: W, height: H, url, ready: '__gamut', begin: false }, async ({ page, errs }) => {
  await page.evaluate(([chart, w, h]) => window.__gamut.build(chart, w, h), [CHART, W, H]);

  const shoot = () => page.evaluate(() => window.__gamut.shoot());
  /* Chroma as max-min over max is crude next to a proper appearance model and
     is the right crudeness here: it answers "did this come back as saturated
     as it went in", which is the question. */
  const sample = () => page.evaluate(() => window.__gamut.sample());

  const hueOf = ([r, g, b]) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (!d) return -1;
    let hh;
    if (mx === r) hh = ((g - b) / d + 6) % 6;
    else if (mx === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    return Math.round(hh * 60);
  };
  const chromaOf = ([r, g, b]) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mx ? +((mx - mn) / mx).toFixed(3) : 0;
  };
  const hueGap = (a, b) => {
    if (a < 0 || b < 0) return 0;
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  };

  /* Three passes, because "the palette came out wrong" has to be attributable
     to a stage. Ladder-only isolates the quantiser; graded adds the composite.
     A colour that is already broken in the ladder pass is a cel.js problem and
     a colour that only breaks in the graded pass is an outline.js one. */
  const setStage = (ladder, grade) =>
    page.evaluate(s => window.__gamut.stage(s[0], s[1]), [ladder, grade]);

  const report = {};
  const passes = {};
  for (const [pass, ladder, grade] of [
    ['raw', false, false],
    ['ladder', true, false],
    ['graded', true, true],
  ]) {
    await setStage(ladder, grade);
    const png = await shoot();
    fs.writeFileSync(path.join(outDir, `chart-${pass}.png`),
      Buffer.from(png.split(',')[1], 'base64'));
    passes[pass] = await sample();
  }

  for (let r = 0; r < CHART.length; r++) {
    const [name, hexes] = CHART[r];
    const src = hexes.map(h => [(h >> 16) & 255, (h >> 8) & 255, h & 255]);
    const row = {};
    for (const pass of ['raw', 'ladder', 'graded']) {
      const dst = passes[pass][r];
      row[pass] = {
        /* Steps surviving: how many of the six input values still resolve to
           different output colours. One is a family that has been flattened. */
        stepsOf6: new Set(dst.map(p => p.join(','))).size,
        clipped: dst.filter(p => Math.max(...p) >= 254).length,
        /* Cells whose darkest channel has been driven to zero. This is the one
           that matters most for a saturated palette: a colour with a zero
           channel has no body left, and every further operation on it moves
           its hue instead of its saturation. */
        crushed: dst.filter(p => Math.min(...p) <= 1).length,
        /* Hue is meaningless on a near-black cell and noisy on a near-grey
           one, so those are excluded rather than allowed to dominate the max
           and hide a real rotation elsewhere in the ramp. */
        ...(() => {
          let worst = 0, at = -1;
          src.forEach((s, i) => {
            if (Math.max(...dst[i]) < 32 || chromaOf(dst[i]) < 0.12) return;
            const g = hueGap(hueOf(s), hueOf(dst[i]));
            if (g > worst) { worst = g; at = i; }
          });
          return { maxHueShift: worst, worstCell: at };
        })(),
        chroma: dst.map(chromaOf),
        out: dst.map(p => '#' + p.map(v => v.toString(16).padStart(2, '0')).join('')),
      };
    }
    row.chromaIn = src.map(chromaOf);
    report[name] = row;
  }

  fs.writeFileSync(path.join(outDir, 'gamut.json'), JSON.stringify(report, null, 1));
  const line = (label, get) => {
    console.log(`\n  ${label}`);
    console.log('  family             steps/6  clipped  crushed  maxHue  chroma mid');
    for (const [name, v] of Object.entries(report)) {
      const p = get(v);
      console.log(`  ${name.padEnd(18)} ${String(p.stepsOf6).padStart(4)}` +
                  `  ${String(p.clipped).padStart(7)}  ${String(p.crushed).padStart(7)}` +
                  `  ${String(p.maxHueShift).padStart(5)}°` +
                  `  ${v.chromaIn[3].toFixed(2)} -> ${p.chroma[3].toFixed(2)}`);
    }
  };
  line('ladder only', v => v.ladder);
  line('ladder + grade (shipped)', v => v.graded);

  console.log(`\n  errors: ${errs.length}`);
});

srv.close();
finish(process.exitCode || 0);
