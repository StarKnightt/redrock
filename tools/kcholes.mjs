/* AUDIT PROBE (round 2) — where the remaining empty road is, and what refuses
 * to fill it.
 *
 * Reads the sample trace tools/kccadence.mjs left in .meas/r2/kccad-<seed>.json
 * — the same lap, the same ablation, no second drive — and turns it into the
 * list of stretches longer than MINGAP seconds with nothing above THRESH pixels.
 * Each end of each hole is attributed to the site that bounds it, taken as the
 * nearest site in `g.crowd.sites` to the station where the last figure left the
 * frame and the station where the next one entered it.
 *
 * Then, for the worst hole on the seed, the scheduler is asked why: STATIONS
 * evenly spaced inside the hole, both shoulders, `crowdProbe.why(s, side)`,
 * which returns the trace of every candidate offset `crowdStand` looked at and
 * the gate that turned each one down — or, when a spot does stand up, which of
 * the five approach sightlines `crowdSeen` refuses. A native 1600x900 frame is
 * saved from the middle of the hole with the car driven in by autopilot.
 *
 *   node tools/kcholes.mjs [--seed 22] [--thresh 20] [--mingap 15] [--n 7]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const THRESH = Number(flag('thresh', '20'));
const MINGAP = Number(flag('mingap', '15'));
const NSTAT = Number(flag('n', '7'));
const SRC = path.resolve(ROOT, flag('src', `.meas/r2/kccad-${SEED}.json`));
const OUT = path.resolve(ROOT, flag('out', `shots/r2c-${SEED}`));

const trace = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const SAMPLE = trace.lap / trace.nSamples;
const sm = trace.samples;
const sites = trace.sites;

/* Holes under the midpoint convention: from the first failing sample to the
   first passing one, which is exactly how zzcadence measures them. Also kept:
   the last passing station before and the first passing station after, which
   is what names the sites at each end. */
const holes = [];
let start = null, lastOn = null;
for (const s of sm) {
  if (s.tall >= THRESH) {
    if (start !== null) {
      holes.push({
        t0: start.t, t1: s.t, dt: +(s.t - start.t).toFixed(2),
        s0: start.s, s1: s.s, beforeS: lastOn ? lastOn.s : null, afterS: s.s,
      });
      start = null;
    }
    lastOn = s;
  } else if (start === null) start = s;
}
if (start !== null) {
  const last = sm[sm.length - 1];
  holes.push({
    t0: start.t, t1: last.t, dt: +(last.t - start.t).toFixed(2),
    s0: start.s, s1: last.s, beforeS: lastOn ? lastOn.s : null, afterS: null,
  });
}
const nearestSite = s => {
  if (s === null) return null;
  let best = null, bd = Infinity;
  for (const p of sites) { const d = Math.abs(p.s - s); if (d < bd) { bd = d; best = p; } }
  return best ? { kind: best.kind, s: best.s, side: best.side, seen: best.seen, n: best.n, d: Math.round(bd) } : null;
};
const big = holes.filter(h => h.dt >= MINGAP).sort((a, b) => b.dt - a.dt);
for (const h of big) { h.opens = nearestSite(h.beforeS); h.closes = nearestSite(h.afterS); }

console.log(`\n  seed ${SEED} — holes over ${MINGAP} s with nothing above ${THRESH} px`
  + ` (lap ${trace.lap} s, ${sm.length} samples every ${SAMPLE.toFixed(2)} s)`);
console.log(`  source: ${SRC}`);
for (const h of big) {
  console.log(`\n    ${h.dt} s   t ${h.t0}–${h.t1} s   s ${h.s0}–${h.s1}`
    + `  (${h.s1 - h.s0} m)`);
  console.log(`      opens after: ${h.opens ? `${h.opens.kind} s=${h.opens.s} side ${h.opens.side}`
    + ` seen ${h.opens.seen}/5, ${h.opens.n} figures (last legible at s=${h.beforeS})` : '(lap start)'}`);
  console.log(`      closes at:   ${h.closes ? `${h.closes.kind} s=${h.closes.s} side ${h.closes.side}`
    + ` seen ${h.closes.seen}/5, ${h.closes.n} figures (first legible at s=${h.afterS})` : '(lap end)'}`);
}
if (!big.length) { console.log('    none'); finish(process.exitCode || 0); }

const worst = big[0];
const probeS = [];
for (let k = 0; k < NSTAT; k++) {
  probeS.push(Math.round(worst.s0 + (worst.s1 - worst.s0) * (k + 0.5) / NSTAT));
}
const midS = Math.round((worst.s0 + worst.s1) * 0.5);
fs.mkdirSync(OUT, { recursive: true });

await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(600_000);
  const res = await page.evaluate(([stations, mid]) => {
    const g = window.__game;
    const env = g.scene.getObjectByName('environment');
    const probe = env.userData.crowdProbe;
    const L = g.track.length;
    const rows = [];
    for (const s of stations) {
      for (const side of [-1, 1]) {
        const w = probe.why(s, side);
        rows.push({
          s, side, u: w.u,
          wallDist: +probe.wallDist(s, side).toFixed(1),
          out: w.u === null ? null : +(w.u * probe.wallDist(s, side)).toFixed(2),
          trace: w.trace, seen: w.seen,
        });
      }
    }
    // the middle of the hole, driven in and captured
    g.setPaused(true);
    g.goTo(Math.max(2, mid - 150) / L);
    g.autopilot(true, 0.85);
    for (let k = 0; k < 60 * 30 && g.player.s < mid; k++) g.step(1 / 60);
    const real = performance.now.bind(performance);
    const pinned = real();
    performance.now = () => pinned;
    g.renderOnce();                    // frame 0, discarded
    g.renderOnce();
    const png = g.renderer.domElement.toDataURL('image/png');
    performance.now = real;
    const arrived = +g.player.s.toFixed(1);
    const kmh = +g.player.kmh.toFixed(0);
    g.autopilot(false);
    return { rows, png, arrived, kmh, startS: probe.startS };
  }, [probeS, midS]);

  const f = path.join(OUT, `hole-${Math.round(worst.t0)}s-mid${midS}.png`);
  fs.writeFileSync(f, Buffer.from(res.png.split(',')[1], 'base64'));

  console.log(`\n  WORST HOLE on seed ${SEED}: ${worst.dt} s, s ${worst.s0}–${worst.s1}.`
    + `  crowdProbe.why() at ${probeS.length} stations inside it:`);
  for (const r of res.rows) {
    console.log(`\n    s=${r.s} side ${r.side}  wallDist ${r.wallDist} m`
      + `  → ${r.u === null ? 'NO STANDABLE SPOT' : `stands at ${r.out} m out (u=${r.u.toFixed(3)})`}`);
    for (const l of r.trace) console.log('        ' + l);
    for (const l of (r.seen || [])) console.log('        sightline ' + l);
  }
  console.log(`\n  capture from the middle of the hole (car arrived s=${res.arrived},`
    + ` ${res.kmh} km/h): ${f}`);
  console.log();
});
finish(process.exitCode || 0);
