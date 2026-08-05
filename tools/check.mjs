/* Parse every source file before launching a browser.
 *
 * A syntax error costs a second here and a two-minute timeout there, because a
 * module that fails to parse never defines window.__game and the harness has
 * nothing to wait for. `node --check` is used rather than a hand-rolled strip
 * of import/export lines: it is the same parser that will actually run the
 * file, so it agrees about module syntax instead of approximating it. */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const checkOne = f => new Promise(res => {
  execFile(process.execPath, ['--check', f], (err, _o, stderr) => {
    if (!err) return res(null);
    // Trim node's banner down to the line that names the problem.
    const line = String(stderr).split('\n').find(l => /Error/.test(l)) || String(stderr).split('\n')[2] || '';
    res(`  ${path.relative(ROOT, f)}: ${line.trim()}`);
  });
});

export async function checkAsync() {
  const files = walk(path.join(ROOT, 'src'));
  const out = await Promise.all(files.map(checkOne));
  return out.filter(Boolean);
}

/** Synchronous shim for callers that cannot await — spawns one child. */
export function check() { return _cached; }
let _cached = [];
export async function prime() { _cached = await checkAsync(); return _cached; }

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const bad = await checkAsync();
  console.log(bad.length ? '✗\n' + bad.join('\n') : '✓ parse clean');
  process.exit(bad.length ? 1 : 0);
}
