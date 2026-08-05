/* Choose shot windows offline, from the scout telemetry and the world profile.
 *
 * No browser. This is deliberate: picking a window is a search over tens of
 * thousands of candidates and running one headless Chromium per candidate is
 * exactly the machine-hammering the brief forbids. The scout drove the lap
 * once under the same restart + autopilot + fixed 1/60 sequence the capture
 * pass uses, so a frame index chosen here is the same frame there.
 *
 *   node tools/reelplan.mjs [--seeds 22,1,40,...] [--top 6]
 *
 * Columns in scout rows:
 *   0 s   1 kmh   2 offRoad   3 height   4 slipDeg   5 lat
 *   6 airborne   7 gapAhead   8 gapBehind   9 strandedFor  10 rivalAir  11 wheelSlip
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40,7,29,34,15').split(',').map(Number);
const TOP = +flag('top', 4);
const DIR = path.join(ROOT, 'out', 'reel', 'scout');

const S = 0, KMH = 1, OFF = 2, AIR_H = 3, SLIP = 4, LAT = 5, AIRB = 6,
  AHEAD = 7, BEHIND = 8, STUCK = 9, RAIR = 10;

/* How far from the end of the stage a shot has to stay. The finish gate is at
   length-12 and stands 11.4 m tall, so it is a visible object well before the
   car reaches it; the ending is also being rewritten by another agent and must
   not appear. 520 m is about twenty seconds of road at racing pace and puts
   the gate under half a degree of arc even on a straight. */
const END_KEEPOUT = 520;
/* And off the grid, so the body of the reel does not re-shoot the start. */
const START_KEEPOUT = 120;

function load(seed) {
  const t = JSON.parse(fs.readFileSync(path.join(DIR, `seed-${seed}.json`), 'utf8'));
  const w = JSON.parse(fs.readFileSync(path.join(DIR, `world-${seed}.json`), 'utf8'));
  const shoreAt = s => {
    const i = Math.max(0, Math.min(w.rows.length - 1, Math.round(s / w.step)));
    return w.rows[i][5];
  };
  const curvAt = s => {
    const i = Math.max(0, Math.min(w.rows.length - 1, Math.round(s / w.step)));
    return Math.abs(w.rows[i][2]);
  };
  return { t, w, shoreAt, curvAt };
}

/** Every frame in [i0,i1) satisfies `ok`, and the window is inside the fences. */
function clean(rows, i0, i1, len, ok) {
  for (let i = i0; i < i1; i++) {
    const r = rows[i];
    if (r[S] < START_KEEPOUT || r[S] > len - END_KEEPOUT) return false;
    if (r[STUCK] > 0.05) return false;
    if (Math.abs(r[SLIP]) > 55) return false;      // spinning
    if (!ok(r, i)) return false;
  }
  return true;
}

const mean = (rows, i0, i1, k) => {
  let a = 0;
  for (let i = i0; i < i1; i++) a += rows[i][k];
  return a / (i1 - i0);
};
const minOf = (rows, i0, i1, k) => {
  let a = Infinity;
  for (let i = i0; i < i1; i++) a = Math.min(a, rows[i][k]);
  return a;
};
const maxOf = (rows, i0, i1, k) => {
  let a = -Infinity;
  for (let i = i0; i < i1; i++) a = Math.max(a, rows[i][k]);
  return a;
};

/* ── the shot kinds ──────────────────────────────────────────────────── */

function coastShots(d, seed) {
  const { t, shoreAt, curvAt } = d;
  const rows = t.rows, N = 150;                     // 2.5 s
  const out = [];
  for (let i = 0; i + N < rows.length; i += 6) {
    if (!clean(rows, i, i + N, t.length,
      r => r[OFF] < 0.10 && r[KMH] > 82 && !r[AIRB] && Math.abs(r[SLIP]) < 14)) continue;
    const s0 = rows[i][S];
    const shore = shoreAt(s0);
    /* Ocean close on one side and the road turning gently: a straight at
       130 km/h with the sea 200 m away is a road, not a coast road. */
    const score = mean(rows, i, i + N, KMH) * 0.6
      + Math.max(0, 90 - shore) * 1.2
      + Math.min(curvAt(s0), 8) * 3
      - mean(rows, i, i + N, OFF) * 200;
    out.push({ kind: 'coast', seed, i, n: N, s0, s1: rows[i + N - 1][S], shore, score });
  }
  return out;
}

function rampShots(d, seed) {
  const { t } = d;
  const rows = t.rows;
  const out = [];
  const lips = (t.ramps || []).map(r => r.lip ?? r.foot).filter(Number.isFinite);
  for (const lip of lips) {
    /* The frame the car crosses the lip. */
    let hit = -1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i - 1][S] < lip && rows[i][S] >= lip) { hit = i; break; }
    }
    if (hit < 0) continue;
    /* Run on until it is back on the ground and settled. */
    let land = hit;
    for (let i = hit + 6; i < Math.min(rows.length, hit + 60 * 8); i++) {
      if (!rows[i][AIRB] && rows[i][AIR_H] < 0.12) { land = i; break; }
    }
    const i0 = Math.max(0, hit - 54);            // 0.9 s of approach
    const i1 = Math.min(rows.length, land + 66); // 1.1 s of landing and dust
    if (i1 - i0 < 60) continue;
    const ok = clean(rows, i0, i1, t.length, r => r[OFF] < 0.34 && r[KMH] > 45);
    out.push({
      kind: 'ramp', seed, i: i0, n: i1 - i0, s0: rows[i0][S], s1: rows[i1 - 1][S],
      lip, apex: maxOf(rows, hit, land, AIR_H), airSec: +((land - hit) / 60).toFixed(2),
      rivalAir: maxOf(rows, i0, i1, RAIR) > 0,
      clean: ok,
      score: (ok ? 60 : 0) + maxOf(rows, hit, land, AIR_H) * 12 + (land - hit) / 4
        + (maxOf(rows, i0, i1, RAIR) > 0 ? 18 : 0)
        - mean(rows, i0, i1, OFF) * 90,
    });
  }
  return out;
}

function tunnelShots(d, seed) {
  const { t } = d;
  const rows = t.rows;
  const bore = t.tunnel;
  if (!bore) return [];
  const out = [];
  let enter = -1, exit = -1;
  for (let i = 1; i < rows.length; i++) {
    if (enter < 0 && rows[i][S] >= bore.s0) enter = i;
    if (exit < 0 && rows[i][S] >= bore.s1) { exit = i; break; }
  }
  if (enter < 0 || exit < 0) return [];
  /* The approach and the mouth: the palette drop is the shot. */
  const i0 = Math.max(0, enter - 96);           // 1.6 s of approach
  const i1 = Math.min(rows.length, enter + 90); // 1.5 s inside
  if (i1 - i0 > 60) {
    out.push({
      kind: 'tunnel-in', seed, i: i0, n: i1 - i0, s0: rows[i0][S], s1: rows[i1 - 1][S],
      clean: clean(rows, i0, i1, t.length, r => r[OFF] < 0.22 && r[KMH] > 55),
      score: mean(rows, i0, i1, KMH) * 0.5 + (bore.score || 0)
        - mean(rows, i0, i1, OFF) * 120,
    });
  }
  const j0 = Math.max(0, exit - 84), j1 = Math.min(rows.length, exit + 54);
  if (j1 - j0 > 60) {
    out.push({
      kind: 'tunnel-out', seed, i: j0, n: j1 - j0, s0: rows[j0][S], s1: rows[j1 - 1][S],
      clean: clean(rows, j0, j1, t.length, r => r[OFF] < 0.22 && r[KMH] > 55),
      score: mean(rows, j0, j1, KMH) * 0.5 + (bore.score || 0)
        - mean(rows, j0, j1, OFF) * 120,
    });
  }
  return out;
}

function driftShots(d, seed) {
  const { t } = d;
  const rows = t.rows, N = 132;                 // 2.2 s
  const out = [];
  for (let i = 0; i + N < rows.length; i += 4) {
    if (!clean(rows, i, i + N, t.length,
      r => r[OFF] < 0.16 && r[KMH] > 62 && !r[AIRB])) continue;
    const peak = Math.max(Math.abs(minOf(rows, i, i + N, SLIP)), maxOf(rows, i, i + N, SLIP));
    if (peak < 9) continue;
    out.push({
      kind: 'drift', seed, i, n: N, s0: rows[i][S], s1: rows[i + N - 1][S], peak,
      score: peak * 3.2 + mean(rows, i, i + N, KMH) * 0.35 - mean(rows, i, i + N, OFF) * 200,
    });
  }
  return out;
}

function racingShots(d, seed) {
  const { t } = d;
  const rows = t.rows, N = 150;                 // 2.5 s
  const out = [];
  for (let i = 0; i + N < rows.length; i += 5) {
    if (!clean(rows, i, i + N, t.length,
      r => r[OFF] < 0.12 && r[KMH] > 72 && r[AHEAD] >= 0 && r[AHEAD] < 46)) continue;
    const g = mean(rows, i, i + N, AHEAD);
    out.push({
      kind: 'racing', seed, i, n: N, s0: rows[i][S], s1: rows[i + N - 1][S], gap: +g.toFixed(1),
      score: Math.max(0, 46 - g) * 2.4 + mean(rows, i, i + N, KMH) * 0.4
        - mean(rows, i, i + N, OFF) * 200,
    });
  }
  return out;
}

/* ── survey ──────────────────────────────────────────────────────────── */

const KINDS = ['coast', 'ramp', 'tunnel-in', 'tunnel-out', 'drift', 'racing'];
const all = [];

for (const seed of SEEDS) {
  let d;
  try { d = load(seed); } catch { console.log(`  seed ${seed}: no scout data`); continue; }
  const shots = [
    ...coastShots(d, seed), ...rampShots(d, seed), ...tunnelShots(d, seed),
    ...driftShots(d, seed), ...racingShots(d, seed),
  ];
  all.push(...shots);
  const by = k => shots.filter(s => s.kind === k);
  console.log(`\n── seed ${seed}  (${d.t.length} m, ${(d.t.frames / 60).toFixed(0)} s lap)`);
  for (const k of KINDS) {
    const list = by(k).sort((a, b) => b.score - a.score);
    if (!list.length) { console.log(`   ${k.padEnd(11)} —`); continue; }
    const best = list.slice(0, TOP).map(x =>
      `s${x.s0 | 0}-${x.s1 | 0}${x.apex !== undefined ? ` apex${x.apex.toFixed(1)}m/${x.airSec}s${x.rivalAir ? '+AI' : ''}${x.clean ? '' : ' DIRTY'}` : ''}`
      + `${x.peak !== undefined ? ` slip${x.peak.toFixed(0)}°` : ''}`
      + `${x.gap !== undefined ? ` gap${x.gap}m` : ''}`
      + `${x.clean === false && x.apex === undefined ? ' DIRTY' : ''}`
      + ` [${x.score.toFixed(0)}]`);
    console.log(`   ${k.padEnd(11)} ${list.length} cand  ${best.join('   ')}`);
  }
}

/* Top few of each (seed, kind), spaced apart. A global top-N is useless here:
   one kind on one seed produces hundreds of overlapping windows a frame apart
   and swamps everything else. */
const keep = [];
for (const seed of SEEDS) {
  for (const k of KINDS) {
    const list = all.filter(x => x.seed === seed && x.kind === k)
      .sort((a, b) => b.score - a.score);
    const chosen = [];
    for (const x of list) {
      if (chosen.some(y => Math.abs(y.i - x.i) < 200)) continue;
      chosen.push(x);
      if (chosen.length >= 5) break;
    }
    keep.push(...chosen);
  }
}
fs.writeFileSync(path.join(DIR, 'candidates.json'), JSON.stringify(keep, null, 1));
console.log(`\n  ${all.length} candidates → ${keep.length} kept`
  + ` → out/reel/scout/candidates.json`);
