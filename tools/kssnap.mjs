/* A frozen copy of src/ to measure against.
 *
 * src/main.js and src/race/ending.js were being edited while this audit was
 * running — main.js changed by two hundred lines between two greps a minute
 * apart. A lap sweep takes minutes per seed and there are three seeds, so
 * serving the live tree would have produced numbers from three different
 * builds and no way to tell which. This copies src/ and index.html once, and
 * every probe in this audit serves that copy; /node_modules/ still comes from
 * the real root, since nothing writes there.
 *
 *   node tools/kssnap.mjs [--refresh]     take (or retake) the snapshot
 *
 * Import `freeze()` to get a server over it.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SNAP = path.join(ROOT, '.work', 'ks-snap');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png',
};

/** Copy src/ and index.html into .work/ks-snap. Returns the manifest. */
export function take() {
  fs.rmSync(SNAP, { recursive: true, force: true });
  fs.mkdirSync(SNAP, { recursive: true });
  fs.cpSync(path.join(ROOT, 'src'), path.join(SNAP, 'src'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(SNAP, 'index.html'));
  const files = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else files.push({
        file: path.relative(SNAP, f).replace(/\\/g, '/'),
        bytes: fs.statSync(f).size,
        mtime: fs.statSync(f).mtime.toISOString(),
      });
    }
  };
  walk(SNAP);
  const manifest = { takenAt: new Date().toISOString(), files };
  fs.writeFileSync(path.join(SNAP, 'MANIFEST.json'), JSON.stringify(manifest, null, 1));
  return manifest;
}

/** Serve the snapshot; /node_modules/ falls through to the real root. */
export async function freeze() {
  if (!fs.existsSync(path.join(SNAP, 'index.html'))) take();
  const srv = http.createServer((rq, rs) => {
    const rel = decodeURI(rq.url.split('?')[0].split('#')[0]);
    const base = rel.startsWith('/node_modules/') ? ROOT : SNAP;
    const f = path.join(base, rel === '/' ? 'index.html' : rel);
    if (!f.startsWith(base)) { rs.writeHead(403); return rs.end(); }
    fs.readFile(f, (e, d) => {
      if (e) { rs.writeHead(404); return rs.end('not found'); }
      rs.writeHead(200, {
        'content-type': TYPES[path.extname(f)] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      rs.end(d);
    });
  });
  await new Promise(r => srv.listen(0, r));
  const base = `http://localhost:${srv.address().port}`;
  const stamp = JSON.parse(fs.readFileSync(path.join(SNAP, 'MANIFEST.json'), 'utf8')).takenAt;
  return { base, stamp, close: () => srv.close() };
}

if (process.argv[1] && process.argv[1].endsWith('kssnap.mjs')) {
  const m = take();
  console.log(`snapshot ${SNAP}`);
  console.log(`  ${m.files.length} files, taken ${m.takenAt}`);
  for (const f of m.files.filter(x => /main\.js|environment\.js/.test(x.file))) {
    console.log(`  ${f.file.padEnd(28)} ${String(f.bytes).padStart(8)} bytes  ${f.mtime}`);
  }
}
