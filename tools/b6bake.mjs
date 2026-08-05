/* Sweep the two baked constants by rewriting the source, one build per pair.
 *
 * The runtime hook the shape search used is gone, and the numbers that matter
 * now — the burst's own duration above all — come from b5burst, which reads
 * the file. So this writes the file, runs the gate, restores it, and prints
 * the one-line summary for each pair. Slower than a hook and honest about it:
 * every row is a real build measured by the real instrument.
 *
 *   node tools/b6bake.mjs --pairs '[[0.40,1.20],[0.40,1.00]]' --seeds 22,40
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const PAIRS = JSON.parse(flag('pairs', '[[0.40,1.20]]'));
const SEEDS = flag('seeds', '22,40');

const SRC = 'src/fx/particles.js';
const original = readFileSync(SRC, 'utf8');
const standRe = /const stand = height \* [\d.]+;/;
const backRe = /const back = radius \* \([\d.]+ - [\d.]+ \* Math\.abs\(lat01\)\);/;
const lifeRe = /const life = lerp\([\d.]+, [\d.]+, strength\) \* Math\.pow\(size, 0\.45\);/;
const spdRe = /const speed = lerp\([\d.]+, [\d.]+, strength\) \* q\.f\(0\.94, 1\.06\) \* Math\.pow\(size, 0\.12\);/;
if (!standRe.test(original) || !backRe.test(original) || !lifeRe.test(original)
  || !spdRe.test(original)) {
  console.error('anchors not found — refusing to write'); process.exit(1);
}

try {
  for (const [stand, backMul, lifeMul = 1, spdMul = 1] of PAIRS) {
    const a = (1.34 * backMul).toFixed(3), b = (0.22 * backMul).toFixed(3);
    const l0 = (0.40 * lifeMul).toFixed(3), l1 = (0.54 * lifeMul).toFixed(3);
    const s0 = (2.10 * spdMul).toFixed(3), s1 = (3.20 * spdMul).toFixed(3);
    const patched = original
      .replace(standRe, `const stand = height * ${stand.toFixed(2)};`)
      .replace(backRe, `const back = radius * (${a} - ${b} * Math.abs(lat01));`)
      .replace(lifeRe, `const life = lerp(${l0}, ${l1}, strength) * Math.pow(size, 0.45);`)
      .replace(spdRe, `const speed = lerp(${s0}, ${s1}, strength) * q.f(0.94, 1.06) * Math.pow(size, 0.12);`);
    writeFileSync(SRC, patched);
    const out = execFileSync('node', ['tools/b5burst.mjs', '--seeds', SEEDS],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    console.log(`\n═══ stand ${stand.toFixed(2)}  back ${backMul.toFixed(2)}x (${a} - ${b}|lat|)`
      + `  life ${lifeMul.toFixed(2)}x  speed ${spdMul.toFixed(2)}x (${s0}..${s1}) ═══`);
    let seed = '';
    for (const line of out.split('\n')) {
      const m = line.match(/^\s+seed (\d+),/);
      if (m) { seed = m[1]; continue; }
      if (/ink \d|largest island|box \d|duration|is drawn on|car still visible|worst \|lat\||plume reaches|governor coverage/.test(line)) {
        console.log(`   s${seed} ${line.trim()}`);
      }
    }
  }
} finally {
  writeFileSync(SRC, original);
  console.log('\n  source restored');
}
