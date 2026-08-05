/* Where the AI actually loses the stage, in metres rather than in ratios.
 *
 * Three things this measures that no existing tool on this project does:
 *
 *   TRUE lateral offset. `p.offRoad` is (|lat| - hw·0.86)/(hw·0.2) clamped to
 *   1, so it saturates 0.3 m past the edge of a 10 m road while the physics
 *   containment wall sits at hw + 1.05. Everything from "a wheel on the berm"
 *   to "pinned against the wall at 100 km/h" reads 1.00. Every metric here is
 *   in metres past the true edge, and the wall proximity is reported
 *   separately so a grind is distinguishable from a wander.
 *
 *   Excursions as events, not as a percentage. A 21% off-road figure spread
 *   evenly over a stage is a driver riding the kerbs; the same 21% in three
 *   lumps is three corners the planner got wrong. Contiguous runs past the
 *   edge are reported with their arc length, duration, speed and how much of
 *   them was spent against the wall.
 *
 *   Corner arrival against the corner's own limit. For each corner the stage
 *   generator made, the speed the car turned up at versus the speed the radius
 *   will hold, and the room it then used. This is the pacing question stated
 *   in the only terms that can answer it.
 *
 * restart() first, always — without it the run inherits however far the page's
 * own rAF loop carried the car before this script got the wheel, which is a
 * function of browser start time and made one earlier census disagree with
 * itself by 10x.
 *
 *   node tools/rlline.mjs [--seeds 22,1,40] [--skill 0.85] [--tag NAME]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',').map(Number);
const SKILL = +flag('skill', 0.85);
const TAG = flag('tag', 'run');
const SECS = +flag('secs', 400);

const PROBE = ([skill, secs]) => {
  const g = window.__game;
  const p = g.player;
  const t = g.track;
  const H = 1 / 120;

  g.restart();
  g.autopilot(true, skill);
  g.botInput = null;
  p.placeAt(34, 0);
  p.vx = 0; p.vy = 0; p.r = 0;
  p.raceTime = 0; p.finished = false;

  const rec = [];
  let impacts = 0, recoveries = 0;
  for (let i = 0; i < secs * 120 && !p.finished; i++) {
    p.lastImpact = 0;
    g.step(H);
    if (p.strandedFor > 2.5) { p.recover(); recoveries++; }
    if (p.lastImpact > 0.06) impacts++;
    const f = t.frameAt(p.s);
    const hw = f.width * 0.5;
    const d = g.bot._dbg || {};
    rec.push({
      s: p.s,
      over: Math.abs(p.lat) - hw,        // metres past the TRUE road edge
      wallGap: (hw + 1.05) - Math.abs(p.lat),
      kmh: p.speed * 3.6,
      slip: Math.abs(p.slipAngle),
      air: p.airborne ? 1 : 0,
      hb: p.handbrake > 0.5 ? 1 : 0,
      curv: f.curv,
      hw,
      t: p.raceTime,
      lat: p.lat,
      /* Is the wheel on its stop, and which term put it there? A correction
         term whose clamp exceeds the lock available at that speed is not a
         correction, it is a switch. */
      sat: Math.abs(d.steer ?? 0) > 0.99 ? 1 : 0,
      dampOver: Math.abs(d.dampTerm ?? 0) > (d.lock ?? 1) ? 1 : 0,
      contOver: Math.abs(d.contTerm ?? 0) > (d.lock ?? 1) ? 1 : 0,
      lock: d.lock ?? 0,
    });
  }

  /* ---- excursions: contiguous runs past the true edge ------------------ */
  const exc = [];
  let cur = null;
  for (let i = 0; i < rec.length; i++) {
    const r = rec[i];
    if (r.over > 0) {
      if (!cur) cur = { i0: i, s0: r.s, overs: [], wall: 0, n: 0, kmh: 0, t0: r.t };
      cur.overs.push(r.over);
      if (r.wallGap < 0.05) cur.wall++;
      cur.kmh += r.kmh;
      cur.n++;
      cur.s1 = r.s; cur.t1 = r.t;
    } else if (cur) {
      /* Allow a few frames back inside before calling it over — a car
         bouncing along the edge is one excursion, not forty. */
      let gapEnd = i;
      while (gapEnd < rec.length && gapEnd - i < 60 && rec[gapEnd].over <= 0) gapEnd++;
      if (gapEnd < rec.length && gapEnd - i < 60) { continue; }
      exc.push(cur); cur = null;
    }
  }
  if (cur) exc.push(cur);

  const med = a => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
  const excOut = exc.map(e => ({
    s0: +e.s0.toFixed(0), s1: +e.s1.toFixed(0),
    metres: +(e.s1 - e.s0).toFixed(0),
    secs: +(e.t1 - e.t0).toFixed(1),
    medOver: +med(e.overs).toFixed(2),
    maxOver: +Math.max(...e.overs).toFixed(2),
    wallPct: +((e.wall / e.n) * 100).toFixed(0),
    kmh: +(e.kmh / e.n).toFixed(0),
  })).filter(e => e.metres >= 5).sort((a, b) => b.metres - a.metres);

  /* ---- true off-road distance ------------------------------------------ */
  let offM = 0, wallM = 0, total = 0;
  for (let i = 1; i < rec.length; i++) {
    const ds = Math.max(0, rec[i].s - rec[i - 1].s);
    total += ds;
    if (rec[i].over > 0) offM += ds;
    if (rec[i].wallGap < 0.05) wallM += ds;
  }

  /* ---- speed distribution ---------------------------------------------- */
  const bins = [0, 0, 0, 0];
  for (const r of rec) {
    if (r.kmh < 60) bins[0]++;
    else if (r.kmh < 100) bins[1]++;
    else if (r.kmh < 140) bins[2]++;
    else bins[3]++;
  }
  const n = rec.length || 1;

  /* ---- weave ------------------------------------------------------------
     Tacking from one side of the road to the other is not a racing line. A
     "tack" is a reversal of the direction the car is crossing the road that
     covers more than 3 m of road before the next reversal — big enough that
     no wobble term or apex could account for it. Counted only on road that is
     nearly straight, where there is no reason to be crossing at all. */
  let tacks = 0, tackM = 0, sweptSum = 0, sweptN = 0;
  let dir = 0, anchor = rec.length ? rec[0].lat : 0, anchorS = 0;
  for (let i = 1; i < rec.length; i++) {
    if (Math.abs(rec[i].curv) > 0.004 || rec[i].air) { dir = 0; anchor = rec[i].lat; anchorS = rec[i].s; continue; }
    const d = rec[i].lat - anchor;
    if (dir === 0) { if (Math.abs(d) > 0.4) dir = Math.sign(d); continue; }
    if (Math.sign(d) === dir) { anchor = rec[i].lat; anchorS = rec[i].s; continue; }
    if (Math.abs(d) > 3) {
      tacks++; sweptSum += Math.abs(d); sweptN++;
      tackM += rec[i].s - anchorS;
      dir = -dir; anchor = rec[i].lat; anchorS = rec[i].s;
    }
  }

  /* ---- corner audit ----------------------------------------------------- */
  /* Corners the way the stage generator made them: local curvature maxima,
     merged so one long bend is one corner. */
  const corners = [];
  for (const f of t.frames) {
    if (Math.abs(f.curv) < 0.006) continue;
    const R = 1 / Math.abs(f.curv);
    const last = corners[corners.length - 1];
    if (last && f.s - last.s < 150) { if (R < last.R) { last.s = f.s; last.R = R; } }
    else corners.push({ s: f.s, R, w: f.width });
  }
  const at = (sWant) => {
    let best = null, bd = 1e9;
    for (const r of rec) { const d = Math.abs(r.s - sWant); if (d < bd) { bd = d; best = r; } }
    return best;
  };
  const cornerOut = corners.map(c => {
    const arrive = at(c.s - 25);
    const apex = at(c.s);
    if (!arrive || !apex) return null;
    const hold = Math.sqrt(1.08 * 9.81 * Math.min(c.R, 900)) * 3.6;
    // Room used: peak |lat| through the corner as a fraction of the half width.
    let peak = 0;
    for (const r of rec) {
      if (r.s > c.s - 60 && r.s < c.s + 90) peak = Math.max(peak, r.over + r.hw);
    }
    return {
      s: +c.s.toFixed(0), R: +c.R.toFixed(0),
      holdKmh: +hold.toFixed(0), arriveKmh: +arrive.kmh.toFixed(0),
      overPct: +((arrive.kmh / hold) * 100).toFixed(0),
      roomPct: +((peak / (c.w * 0.5)) * 100).toFixed(0),
    };
  }).filter(Boolean);

  return {
    finished: p.finished,
    time: +p.raceTime.toFixed(1),
    reached: +((p.s / t.length) * 100).toFixed(0),
    impacts, recoveries,
    trackLen: +t.length.toFixed(0),
    offM: +offM.toFixed(0), wallM: +wallM.toFixed(0), totalM: +total.toFixed(0),
    offPct: +((offM / total) * 100).toFixed(1),
    speedPct: bins.map(b => +((b / n) * 100).toFixed(1)),
    airPct: +((rec.filter(r => r.air).length / n) * 100).toFixed(1),
    satPct: +((rec.filter(r => r.sat).length / n) * 100).toFixed(1),
    dampOverPct: +((rec.filter(r => r.dampOver).length / n) * 100).toFixed(1),
    contOverPct: +((rec.filter(r => r.contOver).length / n) * 100).toFixed(1),
    tacks, tackSwept: +(sweptN ? sweptSum / sweptN : 0).toFixed(1),
    excAirPct: +((rec.filter(r => r.over > 0 && r.air).length
      / Math.max(1, rec.filter(r => r.over > 0).length)) * 100).toFixed(0),
    exc: excOut,
    corners: cornerOut,
  };
};

const all = {};
for (const seed of SEEDS) {
  await run({ width: 480, height: 270, hash: `manual&tier=low&seed=${seed}&cap=0&hud=0` },
    async ({ page }) => {
      const r = await page.evaluate(PROBE, [SKILL, SECS]);
      all[seed] = r;
      console.log(`\n═══ seed ${seed} [${TAG}] skill ${SKILL} ═══`);
      console.log(`  ${r.finished ? 'FINISHED' : 'DNF at ' + r.reached + '%'} in ${r.time}s`
        + `   ${r.impacts} impacts   ${r.recoveries} recoveries`);
      console.log(`  true off-road ${r.offM} m of ${r.totalM} m (${r.offPct}%)`
        + `   against the wall ${r.wallM} m`);
      console.log(`  speed  <60 ${r.speedPct[0]}%   60-100 ${r.speedPct[1]}%`
        + `   100-140 ${r.speedPct[2]}%   >140 ${r.speedPct[3]}%`);
      console.log(`  wheel on the stop ${r.satPct}% of the lap`
        + `   (damping term alone exceeds available lock ${r.dampOverPct}%,`
        + ` containment ${r.contOverPct}%)`);
      console.log(`  ${r.tacks} tacks across the road on straight sections,`
        + ` mean sweep ${r.tackSwept} m   airborne ${r.airPct}% of the lap`
        + `   ${r.excAirPct}% of off-road frames are AIRBORNE`);

      console.log(`\n  ─── excursions past the true edge (>=5 m) ───`);
      if (!r.exc.length) console.log('    none');
      for (const e of r.exc.slice(0, 12)) {
        console.log(`    s=${String(e.s0).padStart(5)}→${String(e.s1).padStart(5)}`
          + `  ${String(e.metres).padStart(4)} m  ${String(e.secs).padStart(5)} s`
          + `  med ${e.medOver.toFixed(2)} max ${e.maxOver.toFixed(2)} m past edge`
          + `  wall ${String(e.wallPct).padStart(3)}%  ${String(e.kmh).padStart(3)} km/h`);
      }
      const big = r.exc.filter(e => e.metres >= 100);
      console.log(`    ${r.exc.length} excursions, ${big.length} over 100 m,`
        + ` longest ${r.exc.length ? r.exc[0].metres : 0} m`);

      console.log(`\n  ─── corner arrivals (over 100% = arrived above the radius limit) ───`);
      const bad = r.corners.filter(c => c.overPct > 100 || c.roomPct > 100);
      for (const c of r.corners) {
        const mark = c.overPct > 100 ? ' ←OVER' : '';
        const mark2 = c.roomPct > 100 ? ' ←OFF' : '';
        console.log(`    s=${String(c.s).padStart(5)}  R ${String(c.R).padStart(4)} m`
          + `  hold ${String(c.holdKmh).padStart(3)}  arrived ${String(c.arriveKmh).padStart(3)}`
          + `  = ${String(c.overPct).padStart(3)}%   room ${String(c.roomPct).padStart(4)}%${mark}${mark2}`);
      }
      console.log(`    ${bad.length} of ${r.corners.length} corners over the limit or off the road`);
    });
}

const sum = Object.entries(all);
if (sum.length > 1) {
  console.log(`\n═══ summary [${TAG}] ═══`);
  let tt = 0, ti = 0, to = 0, tw = 0, tslow = 0, tbig = 0;
  for (const [seed, r] of sum) {
    console.log(`  seed ${String(seed).padStart(3)}  ${String(r.time).padStart(6)}s`
      + `  ${String(r.impacts).padStart(3)} imp  off ${String(r.offM).padStart(4)} m`
      + `  wall ${String(r.wallM).padStart(4)} m  <60 ${r.speedPct[0]}%`
      + `  >100m excursions ${r.exc.filter(e => e.metres >= 100).length}`);
    tt += r.time; ti += r.impacts; to += r.offM; tw += r.wallM;
    tslow += r.speedPct[0]; tbig += r.exc.filter(e => e.metres >= 100).length;
  }
  const k = sum.length;
  console.log(`  MEAN      ${(tt / k).toFixed(1)}s  ${(ti / k).toFixed(0)} imp`
    + `  off ${(to / k).toFixed(0)} m  wall ${(tw / k).toFixed(0)} m`
    + `  <60 ${(tslow / k).toFixed(1)}%  >100m excursions ${(tbig / k).toFixed(1)}`);
}

fs.mkdirSync(path.join(ROOT, '.fix'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.fix', `rlline-${TAG}.json`), JSON.stringify(all, null, 1));

finish(process.exitCode || 0);
