/* Which axis can a rival marker actually be drawn on?
 *
 * tools/zrspread.mjs establishes the problem: on the elevation card's own
 * whole-track axis a rival marker sits inside the player's marker 82% of the
 * time and all three do 65% of the time, at every supported size, because both
 * the card and the marker scale off the same `u` — so the ratio is a constant
 * and no amount of resolution fixes it. 5598 m across 298 CSS px is 18.8 m a
 * pixel against a median player-to-rival gap of 94 m.
 *
 * So the axis has to be relative to the player, and this scores the candidates
 * against the recorded races rather than against anybody's taste. Each axis is
 * a function from signed arc-length offset to signed pixel offset from a centre
 * datum, over a half-width taken from the card's own drawable ridge width.
 *
 * What is scored:
 *
 *   separable      the marker is far enough from the player's centre datum to
 *                  be a mark of its own rather than a bulge on it
 *   all separable  all three are, simultaneously — the reading the feature is
 *                  for, and the one the whole-track axis gets 35% of
 *   pinned         the marker is against the rim, so its distance is no longer
 *                  being reported. Information the axis has thrown away.
 *   px/s           how fast the marker moves when there is something to watch
 *                  (a rival inside 100 m). The complaint a whole-track axis
 *                  earns is markers that never move perceptibly; 0.47 px/s is
 *                  what it delivers, which is one pixel every two seconds.
 *
 * Reads the census, so it is instant and can be re-run against a different
 * marker size without touching a browser.
 *
 *   node tools/zraxis.mjs [--json .meas/zrspread16.json] [--sep 14,18,22]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SRC = flag('json', path.join(ROOT, '.meas', 'zrspread16.json'));
/* Marker separations to score, in GRID UNITS of u — the HUD's own scale
   factor, min(w,h)/720 — because every mark in the HUD is authored in them and
   a separation in device pixels would only be true at one size. */
const SEPS = flag('sep', '14,18,22').split(',').map(Number);

const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const L = data.races[0].length;

/* The card's drawable width, in units of u: map.w is min(330u, w*0.30) and the
   ridge is inset 16u each side, so on every 16:9 or taller panel it is 298u.
   The ultrawide case clips map.w at w*0.30 — at 2560x1080, 0.30*2560 = 768
   against 330u = 495, so 330u still wins and the width is the same 298u.
   Verified against tools/zrspread.mjs's table, where ridge px / u is 298 for
   every entry. */
const IW_U = 298;
const H_U = IW_U / 2;

const AXES = {
  /* The baseline: the elevation card's own axis, which is what "put them on
     the map" means before it is measured. */
  'whole-track': d => d * IW_U / L,
  'linear ±150 m': d => Math.max(-1, Math.min(1, d / 150)) * H_U,
  'linear ±300 m': d => Math.max(-1, Math.min(1, d / 300)) * H_U,
  'linear ±600 m': d => Math.max(-1, Math.min(1, d / 600)) * H_U,
  /* Rational compression. Never reaches the rim, so nothing is ever off scale
     and no rival is ever dropped: the near field gets most of the pixels and
     the far field asymptotes. K is the gap that lands halfway out. */
  'hyperbolic K=60': d => H_U * d / (Math.abs(d) + 60),
  'hyperbolic K=90': d => H_U * d / (Math.abs(d) + 90),
  'hyperbolic K=150': d => H_U * d / (Math.abs(d) + 150),
  'hyperbolic K=220': d => H_U * d / (Math.abs(d) + 220),
  /* Square root over a finite window: gentler near zero than linear, still
     hits the rim. */
  'sqrt ±400 m': d => Math.sign(d) * H_U * Math.sqrt(Math.min(Math.abs(d), 400) / 400),
  /* asinh — linear through the datum, logarithmic in the far field, and scaled
     so the worst gap ever measured lands just inside the rim. Linear at the
     datum is the property sqrt does not have: sqrt's slope there is infinite,
     so two cars trading paint at half a metre would send their marker skating
     several units on gap noise alone. */
  'asinh K=25': d => H_U * Math.asinh(d / 25) / Math.asinh(1200 / 25),
  'asinh K=40': d => H_U * Math.asinh(d / 40) / Math.asinh(1200 / 40),
  'asinh K=60': d => H_U * Math.asinh(d / 60) / Math.asinh(1200 / 60),
  'asinh K=90': d => H_U * Math.asinh(d / 90) / Math.asinh(1200 / 90),
  'tanh K=120': d => H_U * Math.tanh(d / 120),
  'tanh K=200': d => H_U * Math.tanh(d / 200),
};

/* Every rival sample, and the frames they came in, so pairwise separation can
   be scored on the same frame rather than across the pile. */
const frames = [];
for (const o of data.races) for (const s of o.samples) frames.push(s.slice(1));
const flat = frames.flat();
console.log(`  ${data.races.length} fields, ${frames.length} frames,`
  + ` ${flat.length} rival samples, stage ${L.toFixed(0)} m`);
console.log(`  card ridge ${IW_U}u wide, so the datum has ±${H_U}u either side\n`);

/* Motion is only interesting where there is something to watch. A rival 600 m
   away moving at half a pixel a second is fine; one at 30 m has to move. */
const nearRates = (fn, lo, hi) => {
  const out = [];
  for (const o of data.races) {
    for (let i = 1; i < o.samples.length; i++) {
      const a = o.samples[i - 1], b = o.samples[i];
      for (let k = 1; k < a.length; k++) {
        const m = Math.abs(b[k]);
        if (m < lo || m > hi) continue;
        out.push(Math.abs(fn(b[k]) - fn(a[k])) * o.hz);
      }
    }
  }
  return out.sort((x, y) => x - y);
};
const q = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];

/* Separability is scored per gap band, because "separable" means different
   things at different gaps and one blended percentage hides all of it.
     touching  under 10 m — a car length. These SHOULD overlap the datum; a
               marker standing clear of it there would be claiming daylight
               that does not exist.
     racing    10 to 150 m. The band the feature is for, and the band the
               whole-track axis cannot draw: 90% of nearest-rival samples are
               inside 165 m.
     distant   over 150 m. Only ahead-or-behind and roughly-how-far matter. */
const BANDS = [['touching', 0, 10], ['racing', 10, 150], ['distant', 150, 1e9]];
for (const SEP of SEPS) {
  console.log(`── marker separation ${SEP}u ` + '─'.repeat(56));
  console.log('   axis                 separable from the datum        all 3'
    + '   pinned   chatter   racing px/s');
  console.log('                        touching   racing   distant     clear'
    + '   at rim   under15m   (med, p90)');
  for (const [name, fn] of Object.entries(AXES)) {
    const inBand = BANDS.map(() => 0), sepBand = BANDS.map(() => 0);
    let allSep = 0, pinned = 0;
    for (const f of frames) {
      const xs = f.map(fn);
      for (let k = 0; k < f.length; k++) {
        const a = Math.abs(f[k]);
        const b = BANDS.findIndex(([, lo, hi]) => a >= lo && a < hi);
        inBand[b]++;
        if (Math.abs(xs[k]) >= SEP) sepBand[b]++;
        if (Math.abs(xs[k]) >= H_U - 1) pinned++;
      }
      /* All three separable from the datum AND from each other — the state in
         which the strip is showing three cars rather than a smear. */
      let mutual = xs.every(x => Math.abs(x) >= SEP);
      for (let i = 0; i < xs.length && mutual; i++) {
        for (let j = i + 1; j < xs.length; j++) {
          if (Math.abs(xs[i] - xs[j]) < SEP) { mutual = false; break; }
        }
      }
      if (mutual) allSep++;
    }
    const r = nearRates(fn, 10, 150), c = nearRates(fn, 0, 15);
    const p = (i) => (sepBand[i] / Math.max(1, inBand[i]) * 100).toFixed(0) + '%';
    console.log(`   ${name.padEnd(20)} ${p(0).padStart(8)} ${p(1).padStart(8)}`
      + ` ${p(2).padStart(9)} ${(allSep / frames.length * 100).toFixed(0).padStart(8)}%`
      + ` ${(pinned / flat.length * 100).toFixed(0).padStart(8)}%`
      + ` ${q(c, 0.5).toFixed(1).padStart(10)}`
      + `   ${q(r, 0.5).toFixed(2).padStart(5)} ${q(r, 0.9).toFixed(2).padStart(6)}`);
  }
  console.log('');
}

/* How many markers land on top of each other, for the axis actually chosen.
   Vertical position on a relative strip carries no meaning, so overlap can be
   resolved by stacking rather than by displacing x — but only if the stack is
   shallow enough to be worth building. This counts how deep it would get. */
const CHOSEN = flag('axis', 'hyperbolic K=90');
if (AXES[CHOSEN]) {
  console.log(`── overlap depth on "${CHOSEN}" ` + '─'.repeat(45));
  for (const SEP of SEPS) {
    const hist = [0, 0, 0, 0];
    let clashes = 0;
    for (const f of frames) {
      const xs = f.map(AXES[CHOSEN]).sort((a, b) => Math.abs(a) - Math.abs(b));
      const rows = [];
      for (const x of xs) {
        let r = 0;
        while (rows[r] && rows[r].some(v => Math.abs(v - x) < SEP)) r++;
        (rows[r] = rows[r] || []).push(x);
      }
      hist[Math.min(3, rows.length - 1)]++;
      if (rows.length > 1) clashes++;
    }
    const p = i => (hist[i] / frames.length * 100).toFixed(1) + '%';
    console.log(`   ${SEP}u marks:  one row ${p(0)}   two ${p(1)}   three ${p(2)}`
      + `   — any overlap at all on ${(clashes / frames.length * 100).toFixed(0)}% of frames`);
  }
  console.log('');
}

/* Whether the finish marker belongs on a RELATIVE axis at all, and if so from
 * how far out.
 *
 * The strip carries the same chequered bar the elevation card does, at the
 * distance still to run, because "where the line is relative to the cars" is the
 * question the last kilometre is about. But an asymptotic axis sends everything
 * far away to the same place, so for most of a four-minute descent the bar sits
 * on the rim — and so does any rival more than a few hundred metres up the road.
 * tools/zrshot.mjs caught the result: a crop with two rivals 332 and 600 m ahead
 * parked against the bar while the line was 3.6 km away, which reads as a pair
 * of cars about to finish and is false.
 *
 * Two marks closer together than one marker width are not two marks, so: over
 * every recorded frame of every race, how often does the bar land within that of
 * a rival which is NOT actually near the line — against how often it lands there
 * truthfully, which is the case worth drawing. `--sep` sets the width, in u. */
{
  const fn = AXES[CHOSEN] || AXES['hyperbolic K=90'];
  const SEP = SEPS[Math.floor(SEPS.length / 2)];
  console.log(`── the finish bar on "${CHOSEN}", by how far out it is drawn `
    + '─'.repeat(19));
  console.log(`   two marks within ${SEP}u read as one; "far" is a rival more than`
    + ' 150 m from the line');
  console.log('   drawn from   bar on screen   on a far rival   on a near one');
  for (const T of [200, 300, 400, 600, 800, 1200, 1e9]) {
    let up = 0, bad = 0, ok = 0, n = 0;
    for (const o of data.races) {
      for (const s of o.samples) {
        n++;
        const left = o.length - s[0];
        if (left > T) continue;
        up++;
        const xf = fn(left);
        for (let k = 1; k < s.length; k++) {
          if (Math.abs(fn(s[k]) - xf) > SEP) continue;
          if (Math.abs(s[k] - left) > 150) bad++; else ok++;
        }
      }
    }
    const pc = (v) => (100 * v / n).toFixed(1) + '%';
    console.log(`   ${(T > 1e8 ? 'always' : T + ' m out').padEnd(12)}`
      + `${pc(up).padStart(13)}   ${(pc(bad) + ` (${bad})`).padStart(14)}`
      + `   ${(pc(ok) + ` (${ok})`).padStart(13)}`);
  }
  console.log('');
}

/* Where each candidate puts the gaps that matter, so the shape of the axis is
   readable as a table and not only as a score. */
console.log('── where a given gap lands, in u from the datum '
  + '─'.repeat(28));
const MARKS = [0, 8, 15, 30, 60, 94, 150, 227, 400, 700, 1100];
console.log('   axis                ' + MARKS.map(m => String(m).padStart(5)).join(''));
for (const [name, fn] of Object.entries(AXES)) {
  console.log(`   ${name.padEnd(20)}`
    + MARKS.map(m => fn(m).toFixed(0).padStart(5)).join(''));
}
console.log('\n   (8 m is a car length — cars that close are touching. 29 m is the'
  + '\n    median nearest rival, 94 m the median gap to any rival, 227 m the p75,'
  + '\n    417 m the p90, 1111 m the worst seen.)');
