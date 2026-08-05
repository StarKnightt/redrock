/* Exact pixel diff between two sets of composite dumps.
 *
 * A hash answers "identical or not" and nothing else, which is the wrong
 * resolution for a question about a shader edit: recompiling a fragment
 * program with six fewer lines can move a handful of pixels by one code
 * through nothing but instruction scheduling, and a hash cannot tell that
 * apart from a line that moved. This counts the pixels and reports the largest
 * channel difference, so "identical", "three pixels by one level" and "the
 * outline moved" are three different answers.
 *
 * Decodes 8-bit RGBA PNGs directly — no dependency, and the dumps are written
 * by tools/b5hash.mjs --dump, which is the only producer.
 *
 *   node tools/b5hash.mjs --tag before --dump   (with the original file)
 *   node tools/b5hash.mjs --tag after  --dump   (with the edit in place)
 *   node tools/b5pxdiff.mjs before after
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'shots', 'pxid');
const [A, B] = process.argv.slice(2);
if (!A || !B) { console.error('usage: node tools/b5pxdiff.mjs <tagA> <tagB>'); process.exit(2); }

function decode(file) {
  const buf = fs.readFileSync(file);
  let p = 8, w = 0, h = 0, depth = 0, colour = 0, interlace = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; colour = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (colour !== 6 && colour !== 2)) {
    throw new Error(`${path.basename(file)}: unsupported PNG (depth ${depth}, colour ${colour})`);
  }
  const bpp = colour === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let q = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[q++];
    const line = raw.subarray(q, q + stride); q += stride;
    const cur = out.subarray(y * stride, y * stride + stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, bpp, data: out };
}

const files = fs.readdirSync(DIR).filter(f => f.startsWith(A + '-')).sort();
if (!files.length) { console.error(`no dumps tagged "${A}" in shots/pxid`); process.exit(2); }

let worst = 0, anyDiff = 0;
console.log(`\n  exact pixel diff, "${A}" against "${B}"\n`);
console.log('   differing px   of total    max channel Δ   dump');
for (const f of files) {
  const g = f.replace(A + '-', B + '-');
  const pa = path.join(DIR, f), pb = path.join(DIR, g);
  if (!fs.existsSync(pb)) { console.log(`   ${'—'.padStart(12)}   missing counterpart for ${f}`); continue; }
  const a = decode(pa), b = decode(pb);
  if (a.w !== b.w || a.h !== b.h) { console.log(`   size mismatch ${f}`); continue; }
  let n = 0, maxd = 0;
  for (let i = 0; i < a.data.length; i += a.bpp) {
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a.data[i + k] - b.data[i + k]));
    if (d) { n++; if (d > maxd) maxd = d; }
  }
  if (n) { anyDiff++; worst = Math.max(worst, n); }
  console.log(`   ${String(n).padStart(12)}   ${String(a.w * a.h).padStart(8)}`
    + `   ${String(maxd).padStart(13)}   ${f.replace(A + '-', '')}`);
}
console.log(`\n  ${files.length - anyDiff} of ${files.length} dumps are byte-identical;`
  + ` the worst non-identical one differs on ${worst} pixels.`);
