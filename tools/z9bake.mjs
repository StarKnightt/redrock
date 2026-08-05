/* Sweep candidate end-of-life terms for the landing burst by rewriting the
 * shader source, one build per variant, and read each with tools/z9tail.mjs.
 *
 * Same contract as tools/b6bake.mjs: the file is written, the real instrument
 * runs against the real build, and the file is restored in a finally. There is
 * no runtime hook for a GLSL constant, so this is the only honest way to ask
 * what a term is worth.
 *
 *   node tools/z9bake.mjs --seeds 22 --pick base,flat0.8
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,40');
const FROM = flag('from', '14');

const SRC = 'src/fx/particles.js';
const original = readFileSync(SRC, 'utf8');

const INSET = 'distanceToShape += smoothstep(0.46, 0.98, vAge) * 1.25 * isBurstPuff;';
const TEAR = 'float tearAmount = mix(1.0, 0.30, isBurstPuff);';
const PEN = '  float isBurstWall = step(3.5, vKind);';
if (!original.includes(INSET) || !original.includes(TEAR) || !original.includes(PEN)
  || !original.includes('life * q.f(0.44, 0.58), packed, speed, decel,')) {
  console.error('anchors not found — refusing to write'); process.exit(1);
}

/* An anisotropic inset: the amount is scaled by how vertical the boundary
   normal is at this fragment, so the puff loses height faster than width. The
   mass is a row of side-by-side billows, so its overlaps are lateral; a
   uniform inset spends them and the union comes apart into one object per
   puff, which is the reported defect. */
const flat = (k, amp = 1.25, s0 = 0.46, s1 = 0.98) =>
  [INSET, `float vertBias = abs(normalize(p + vec2(0.0, 0.0001)).y);
  distanceToShape += smoothstep(${s0}, ${s1}, vAge) * ${amp.toFixed(3)}
    * mix(${(1 - k).toFixed(3)}, ${(1 + k).toFixed(3)}, vertBias) * isBurstPuff;`];

/* The last of the dissolution handed to the noise instead of to the boundary:
   the puff thins by holes rather than by drawing in. Lace is what an opaque
   pipeline has instead of alpha. */
const lace = (t, s = 0.55) =>
  [TEAR, `float tearAmount = mix(1.0, mix(0.30, ${t.toFixed(2)},
    smoothstep(${s.toFixed(2)}, 1.0, vAge)), isBurstPuff);`];

/* The pen lets go of a burst puff once it has stopped being part of one mass.
   A closed contour around each surviving lobe is the strongest solid-object
   cue the style has, and it is the half of the report that says "hard
   contours". A step and not a ramp: the class is an id, and a fractional id
   lands between two classes in the composite's comparison. */
const pen = (at) =>
  [PEN, `  float isBurstWall = step(3.5, vKind)
    * (1.0 - step(${at.toFixed(2)}, vAge) * isBurstPuff);`];

const LIFE = 'life * q.f(0.44, 0.58), packed, speed, decel,';

/* One clock for the whole mass.
 *
 * Every puff's dissolution is cut on its own normalised age, and the puffs are
 * given lives spread over 0.44..0.58 of the event — a 1.3:1 range. So at any
 * frame of the tail the twelve are at twelve different points of the same
 * curve, the oldest are already erased and the youngest still carry most of
 * their body, and the mass comes apart by losing members rather than by
 * thinning. Narrowing the spread puts them back on one clock. The random is
 * still drawn so the rest of the stream is untouched. */
const clock = (k) =>
  [LIFE, `life * (0.51 + (q.f(0.44, 0.58) - 0.51) * ${k.toFixed(2)}), packed, speed, decel,`];

const HALO = 'float halo = smoothstep(-0.17, -0.015, distanceToShape) * isDust * bulk;';
const DIM = 'body = mix(body, body * 0.86, smoothstep(0.44, 1.0, vAge));';

/* The rim highlight is a band 0.17 wide measured in from the boundary, and it
   exists to dissolve the edge optically. On a puff the end-of-life inset has
   eaten down to a lobe narrower than that band, the whole fragment is inside
   it, so the last thing left of the burst is painted entirely in its brightest
   rung. Retired on the same curve that is doing the eating. */
const nohalo = (s0 = 0.46, s1 = 0.98) =>
  [HALO, `float halo = smoothstep(-0.17, -0.015, distanceToShape) * isDust * bulk
    * (1.0 - smoothstep(${s0.toFixed(2)}, ${s1.toFixed(2)}, vAge) * isBurstPuff);`];

const dim = (f) => [DIM, `body = mix(body, body * ${f.toFixed(2)}, smoothstep(0.44, 1.0, vAge));`];

/* Dissolve on the way to the lens, ahead of the scale clamp that is waiting
   there. vSpread is the instance's angular size, so this is stated in screen
   terms exactly as invariant 1's two clamps are, and it acts only while a puff
   is arriving at the camera. */
const arrive = (s0, s1, k) =>
  [INSET, INSET + `\n  distanceToShape += smoothstep(${s0.toFixed(3)}, ${s1.toFixed(3)}, vSpread)
    * ${k.toFixed(2)} * isBurstPuff;`];

const VARIANTS = {
  base: [],
  'arr.60-1.00': [arrive(0.60, 1.00, 1.25)],
  'arr.65-1.05': [arrive(0.65, 1.05, 1.25)],
  'arr.70-1.10': [arrive(0.70, 1.10, 1.25)],
  'arr.75-1.25': [arrive(0.75, 1.25, 1.25)],
  'arr.70-1.10k2': [arrive(0.70, 1.10, 2.00)],
  'arr.65-0.95k2': [arrive(0.65, 0.95, 2.00)],
  'arr.28-.50': [arrive(0.28, 0.50, 1.25)],
  'arr.30-.60': [arrive(0.30, 0.60, 1.25)],
  'arr.24-.46': [arrive(0.24, 0.46, 1.25)],
  'arr.20-.42': [arrive(0.20, 0.42, 1.25)],
  'arr.24-.46k2': [arrive(0.24, 0.46, 2.00)],
  'arr.20-.36k2': [arrive(0.20, 0.36, 2.00)],
  halo: [nohalo()],
  'halo+pen': [nohalo(), pen(0.58)],
  'halo0.40': [nohalo(0.40, 0.90)],
  'dim0.62': [dim(0.62)],
  'halo+dim': [nohalo(), dim(0.62)],
  'halo+dim+pen': [nohalo(), dim(0.62), pen(0.58)],
  clock0: [clock(0)],
  'clock0.25': [clock(0.25)],
  'clock0.5': [clock(0.5)],
  'clock0+flat0.6': [clock(0), flat(0.6)],
  'clock0.25+flat0.6': [clock(0.25), flat(0.6)],
  'clock0+lace': [clock(0), lace(1.0)],
  /* One clock costs peak area, because the short-lived puffs were being
     insetting away before the peak. The inset is re-tuned to give it back. */
  'clock0+a1.45': [clock(0), [INSET, INSET.replace('1.25', '1.45')]],
  'clock0+a1.65': [clock(0), [INSET, INSET.replace('1.25', '1.65')]],
  'clock0+a1.85': [clock(0), [INSET, INSET.replace('1.25', '1.85')]],
  'clock0+s0.38': [clock(0), [INSET, INSET.replace('0.46', '0.38')]],
  'clock0+s0.38a1.45': [clock(0),
    [INSET, INSET.replace('0.46', '0.38').replace('1.25', '1.45')]],
  'clock0+s0.32a1.45': [clock(0),
    [INSET, INSET.replace('0.46', '0.32').replace('1.25', '1.45')]],
  'flat0.3': [flat(0.3)],
  'flat0.45': [flat(0.45)],
  'flat0.55': [flat(0.55)],
  'flat0.6': [flat(0.6)],
  'flat0.65': [flat(0.65)],
  'flat0.75': [flat(0.75)],
  'flat0.9': [flat(0.9)],
  'flat0.9x1.5': [flat(0.9, 1.55)],
  'flat0.6+lace': [flat(0.6), lace(1.0)],
  'flat0.6+pen': [flat(0.6), pen(0.58)],
  'lace1.0': [lace(1.0)],
  'lace1.0+pen': [lace(1.0), pen(0.58)],
  'flat0.9+lace': [flat(0.9), lace(1.0)],
  'flat0.9+lace+pen': [flat(0.9), lace(1.0), pen(0.58)],
  'pen': [pen(0.58)],
};

const PICK = flag('pick', Object.keys(VARIANTS).join(',')).split(',');

try {
  for (const name of PICK) {
    const edits = VARIANTS[name];
    if (!edits) { console.error(`unknown variant ${name}`); continue; }
    let patched = original;
    for (const [from, to] of edits) patched = patched.replace(from, to);
    writeFileSync(SRC, patched);
    const out = execFileSync('node',
      ['tools/z9tail.mjs', '--seeds', SEEDS, '--tag', name, '--from', FROM,
        '--shots', args.includes('--shots') ? '1' : '0'],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    console.log(`\n═══ ${name} ═══`);
    if (args.includes('--full')) { console.log(out); continue; }
    let seed = '';
    for (const line of out.split('\n')) {
      const m = line.match(/^\s+seed (\d+)\s+\[/);
      if (m) { seed = m[1]; continue; }
      if (/peak \d+ px|over the tail|last frame drawn/.test(line)) {
        console.log(`   s${seed} ${line.trim()}`);
      }
    }
  }
} finally {
  writeFileSync(SRC, original);
  console.log('\n  source restored');
}
