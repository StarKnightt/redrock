/* The run-off past the finish line, and what appending it cost.
 *
 * Three questions, and the first one is the only one that can fail silently:
 *
 *   1. IS THE RACE STILL THE SAME RACE?  `track.length` is read by something
 *      like a hundred and twenty siting expressions, so the whole design of
 *      this change is that `length` does NOT move and a separate `roadEnd`
 *      does. That is a claim about a hundred and twenty call sites, and the
 *      only honest way to check it is to build the same seed twice in one
 *      process — once with the run-off and once with `?runoff=0`, which is the
 *      control the Track constructor exists to provide — and diff the vertex
 *      buffers. Scenery must be byte-identical. The road, the berms, the
 *      corridor and the retaining bank must be byte-identical over the course
 *      rows and longer after them, because their rows are emitted in station
 *      order and the appended ones come last.
 *
 *   2. WHAT DID IT COST?  The same scene walk `tools/budget.mjs` does,
 *      instances included, taken both ways in the same browser on the same
 *      adapter so the delta is a delta and not two numbers from two runs.
 *
 *   3. IS THE RUN-OFF ROAD?  Terrain under all of it, none of it in the sea,
 *      and the vertical curvature at the join — which is the one number the
 *      run-off could plausibly get wrong, because the stage's own runout leaves
 *      the road climbing at up to +14% and unloading a braking car costs grip.
 *
 * Nothing here steps the car. See tools/zystop.mjs for the stop.
 *
 *   node tools/zyrunoff.mjs [--seeds 22,1,7] [--verbose]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '1,7,12,14,16,20,22,23,26,27,28,34,36,40')
  .split(',').map(Number);
const VERBOSE = args.includes('--verbose');

/* Runs INSIDE the page, once per build. Everything it returns is either a
   number or a hash, because a probe that ships vertex buffers back over CDP for
   fourteen seeds is a probe nobody runs twice. */
const PROBE = () => {
  const g = window.__game;
  g.setPaused(true);
  const t = g.track;

  /* FNV-1a over the raw float bytes. Not a checksum of rounded values: the
     question is whether the buffer is the same buffer, and rounding first would
     hide exactly the sub-millimetre drift a smoothing pass reaching one frame
     further would produce. */
  const hash = (attr, floats = Infinity) => {
    if (!attr) return null;
    const a = attr.array;
    const n = Math.min(a.length, floats);
    const bytes = new Uint8Array(
      new Float32Array(a.buffer ? a.subarray(0, n) : a.slice(0, n)).buffer);
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = (h * 0x01000193) >>> 0;
    }
    return { h: h.toString(16).padStart(8, '0'), n };
  };

  /* The scene walk, on tools/budget.mjs's own rules — drawRange, instance
     counts, and the InstancedBufferGeometry clamp the renderer itself applies.
     Copied deliberately rather than imported: budget.mjs runs its walk in a
     different page and this one has to be the same arithmetic or the delta
     means nothing. */
  const meshes = [];
  let tris = 0;
  g.scene.traverse((o) => {
    const geo = o.geometry;
    if (!geo || !geo.attributes || !geo.attributes.position) return;
    if (!o.isMesh) return;
    const full = geo.index ? geo.index.count : geo.attributes.position.count;
    const range = geo.drawRange && Number.isFinite(geo.drawRange.count)
      ? Math.min(geo.drawRange.count, full - geo.drawRange.start) : full;
    let n = 1;
    if (o.isInstancedMesh) n = o.count;
    else if (geo.isInstancedBufferGeometry) {
      const cap = geo._maxInstanceCount;
      n = Math.min(geo.instanceCount, Number.isFinite(cap) ? cap : 1);
      if (!Number.isFinite(n)) n = 1;
    }
    tris += (range / 3) * n;
    meshes.push({
      name: o.name || o.type,
      tris: (range / 3) * n,
      floats: geo.attributes.position.array.length,
      attr: geo.attributes.position,
    });
  });

  /* Three classes of mesh, and the classification is the test.
     GROWS  — emits one row per road frame, so it gets longer and its COURSE
              PREFIX must be byte-identical.
     COAST  — derived from the shoreline, which legitimately moves because the
              landmass now has to reach under the appended road. Allowed to
              change, but only near the finish: proved separately by sampling
              signedDistanceXZ along the whole stage.
     everything else — sited scenery. Must be byte-identical, full stop. */
  const GROWS = /^(road|berm-?1|landform-?-?1|road-supports)$/;
  const COAST = /^(basin-floor|shore-foam|ocean-bands)$/;

  const rows = {};
  const attrs = {};
  for (const m of meshes) {
    /* One entry per name; the four rival shells share a name and the same
       geometry, so summing them would make the hash depend on car count. */
    if (rows[m.name]) { rows[m.name].tris += m.tris; continue; }
    attrs[m.name] = m.attr;
    rows[m.name] = {
      tris: m.tris,
      floats: m.floats,
      cls: GROWS.test(m.name) ? 'grows' : COAST.test(m.name) ? 'coast' : 'sited',
      full: hash(m.attr),
    };
  }
  /* Left on the window so the caller can come back for a prefix once it knows
     how long the control's buffer was. Closes over `attrs`, which is not
     serialised — the geometry never leaves the page. */
  window.__zyPrefix = (name, floats) => hash(attrs[name], floats);
  /* And so it can come back for WHERE a mismatching mesh mismatches. A hash tells
     you a buffer moved; the station it moved at is what tells you which generator
     read the wrong length. Returns a few vertices around the first disagreement,
     which the caller pairs up between builds. */
  window.__zyHead = (name, n = 12) => {
    const a = attrs[name];
    if (!a) return null;
    return Array.from(a.array.slice(0, n * 3)).map(v => +v.toFixed(3));
  };
  /* Unrounded, deliberately. Rounding to millimetres here once hid the whole
     answer: the crowd rails' disagreement is float noise several orders below a
     millimetre, and a rounded dump reported them as identical while the byte
     hash went on reporting them as different. */
  window.__zyVerts = (name) => {
    const a = attrs[name];
    return a ? Array.from(a.array) : null;
  };

  /* Where the shoreline is, at a fixed ladder of stations spanning the whole
     stage. Sampled on the road frame so the two builds ask about the same
     places, and reported as the signed distance itself rather than as a
     shorePoint, because shorePoint iterates and would blur a small change. */
  const shore = [];
  for (let i = 0; i <= 200; i++) {
    const s = (i / 200) * t.length;
    const f = t.frameAt(s);
    for (const lat of [-90, -40, 40, 90]) {
      const p = f.pos.clone().addScaledVector(f.flatRight, lat);
      shore.push({
        s: +s.toFixed(1), x: +p.x.toFixed(2), z: +p.z.toFixed(2),
        roadY: +f.pos.y.toFixed(2),
        d: +g.coast.signedDistanceXZ(p.x, p.z).toFixed(4),
      });
    }
  }
  /* The run-off centreline in plan, so the caller can ask the one question that
     settles a shoreline disagreement: is the ground that appeared inside the
     appended road's own footprint, or somewhere else entirely? */
  const runPts = [];
  for (let i = t.courseCount; i < t.count; i++) {
    const f = t.frames[i];
    runPts.push([+f.pos.x.toFixed(2), +f.pos.z.toFixed(2), +f.pos.y.toFixed(2)]);
  }

  /* The siting answers, which are the thing the hashes are a proxy for. If any
     of these move, something read `length` where it meant `roadEnd`. */
  const ramps = (t.ramps || []).map(r => +r.lip.toFixed(1));
  const crowd = (g.crowd && g.crowd.sites ? g.crowd.sites : []).map(
    s => `${s.kind}@${(s.s ?? 0).toFixed(0)}/${s.side ?? s.outside ?? 0}`);
  const schedule = (g.stage?.userData?.schedule || []).map(
    e => `${e.kind}@${(e.s ?? 0).toFixed(0)}`);
  const bounds = g.coast && g.coast.bounds ? {
    cx: +g.coast.bounds.cx.toFixed(4), cz: +g.coast.bounds.cz.toFixed(4),
  } : null;

  /* ---- is the run-off road? ---------------------------------------------
   * Sampled every 6 m from the flag to the last frame, on both SHOULDERS.
   *
   * Not on the centreline, and not on the kerb line either, and getting that
   * wrong is what this comment is for. `SolidWorld` — which is what
   * `solid.raycast` consults, and what the chase camera and an off-road car
   * consult — deliberately excludes the road mesh: its include list is
   * landform, basin-floor, road-supports, berm and tunnel rock. So there is
   * nothing under any road deck anywhere in this game, and a probe dropped down
   * the centreline reports the drop to whatever is beside it. Aimed exactly at
   * the kerb it is worse than useless: that is the seam between the road deck
   * and the corridor apron, and a vertical ray there can miss both.
   *
   * An earlier version of this tool did exactly that and reported the run-off
   * standing 18–37 m above the ground on all fourteen seeds, with the course's
   * own last 34 m reading ±1 m — which looked like a damning asymmetry and was
   * an artifact of which of three knife-edge samples happened to catch a berm.
   * `tools/zyground.mjs` localised it: two metres outboard of the kerb the
   * corridor apron wants to be 0.59 m below the road and SolidWorld has it
   * within 0.4 m, every rung, both shoulders.
   *
   * Two metres out is also the question worth asking. A car braking from
   * 164 km/h that puts a wheel off wants ground there. */
  const shape = [];
  const step = 6;
  for (let s = t.finishS; s <= t.roadEnd + 1e-6; s += step) {
    const f = t.frameAt(Math.min(s, t.roadEnd));
    const row = { s: +s.toFixed(0), y: +f.pos.y.toFixed(2), w: +f.width.toFixed(1) };
    let worstGround = -Infinity, wet = 0, missing = 0;
    for (const side of [-1, 1]) {
      for (const out of [2, 6]) {
        const p = f.pos.clone()
          .addScaledVector(f.flatRight, side * (f.width * 0.5 + out));
        /* From 60 m up, because the appended road climbs on some seeds and a
           probe launched from the road's own height starts inside the hill. */
        const d = g.solid.raycast(p.x, f.pos.y + 60, p.z, 0, -1, 0, 300, 1.2);
        /* How far BELOW the road the shoulder is. Negative means the ground
           stands above the road, which beside a cut is normal. The WORST of the
           four is reported, because one good shoulder does not make a road. */
        if (!Number.isFinite(d)) missing++;
        else worstGround = Math.max(worstGround, d - 60);
        if (g.coast && g.coast.signedDistanceXZ(p.x, p.z) > 0) wet++;
      }
    }
    row.ground = missing ? null : +worstGround.toFixed(2);
    row.missing = missing;
    row.wet = wet;
    shape.push(row);
  }

  /* What the road past the flag asks of a braking car, as fractions of g.
   *
   * Reported over TWO spans, because they have different authors and only one
   * of them is this pass's: `course` is the 34 m between the flag and the end
   * of the race, which is exactly the road that was there before and is not
   * touched; `runoff` is the appended 120 m. A single worst-case over both
   * would let the pre-existing road's numbers be read as the run-off's.
   *
   * The speed model is the fastest arrival braking at the authority the
   * run-off was sized for, so v² falls linearly with distance past the flag —
   * which matters, because a crest 80 m out is met at two thirds of the speed
   * a crest at the flag would be. */
  const slopeAt = (s) => {
    const a = t.frameAt(Math.max(0, s - 4.5)).pos;
    const b = t.frameAt(Math.min(t.roadEnd, s + 4.5)).pos;
    return (b.y - a.y) / Math.max(1e-6, Math.hypot(b.x - a.x, b.z - a.z));
  };
  const V0 = 45.6, A = 8.2;          // see RUNOFF_M in world/track.js
  const span = (from, to) => {
    const o = { unloadG: 0, atM: 0, atKmh: 0, latG: 0, latAtM: 0, devM: 0, slope0: 0, slope1: 0 };
    if (to - from < 3) return o;
    o.slope0 = +slopeAt(from).toFixed(4);
    o.slope1 = +slopeAt(to).toFixed(4);
    /* How far the road wanders off the straight line it is travelling on AS IT
       ENTERS THIS SPAN, which is the datum that answers "does this stretch
       bend". Measured from the flag instead — which is what it was, and is what
       made the run-off look like it wandered 33 m on seed 22 — the run-off
       inherits the whole of the course's own final bend and then reports it as
       its own, because a road continuing dead straight from a heading 8° off
       the flag's still walks 17 m sideways over 120 m. */
    const p0 = t.frameAt(from).pos.clone();
    const tan0 = t.frameAt(from).tan.clone();
    for (let s = from; s <= to; s += 3) {
      const past = s - t.finishS;
      const v2 = Math.max(0, V0 * V0 - 2 * A * past);
      /* Negative vertical curvature is a crest, which unloads the car. Positive
         is a compression, which loads it and cannot cost it grip. */
      const kv = (slopeAt(Math.min(s + 6, t.roadEnd)) - slopeAt(Math.max(s - 6, 0))) / 12;
      const unload = -kv * v2 / 9.81;
      if (unload > o.unloadG) {
        o.unloadG = unload; o.atM = past; o.atKmh = Math.sqrt(v2) * 3.6;
      }
      const lat = Math.abs(t.frameAt(s).curv) * v2 / 9.81;
      if (lat > o.latG) { o.latG = lat; o.latAtM = past; }
      const d = t.frameAt(s).pos.clone().sub(p0);
      o.devM = Math.max(o.devM, Math.abs(d.x * tan0.z - d.z * tan0.x));
    }
    for (const k of ['unloadG', 'latG']) o[k] = +o[k].toFixed(3);
    for (const k of ['atM', 'latAtM', 'atKmh', 'devM']) o[k] = +o[k].toFixed(1);
    return o;
  };
  /* The join frame at exactly `t.length` is the COURSE's last frame — its
     curvature and its grade are the stage's, authored before this pass. Starting
     the appended span one sample later keeps the two spans' authorship clean;
     including it credited the run-off with up to 0.55 g of lateral demand that
     is the finish corner's, on the seven seeds that finish in a bend. */
  const courseSpan = span(t.finishS, t.length);
  const runoffSpan = span(t.length + 3, t.roadEnd - 6);

  g.setPaused(false);
  return {
    seed: g.seed,
    runoff: +t.runoff.toFixed(0),
    length: +t.length.toFixed(1),
    roadEnd: +t.roadEnd.toFixed(1),
    finishS: +t.finishS.toFixed(1),
    gateS: +t.gateS.toFixed(1),
    courseCount: t.courseCount,
    count: t.count,
    tris,
    rows,
    ramps, crowd, schedule, bounds, shore, runPts,
    stats: g.stageStats(),
    shape,
    courseSpan, runoffSpan,
  };
};

const out = [];
for (const seed of SEEDS) {
  await run({
    width: 320, height: 200,
    hash: `manual&tier=high&seed=${seed}&cap=0&hud=0`,
  }, async ({ page }) => {
    const after = await page.evaluate(PROBE);
    /* Full vertex dumps for the few meshes worth locating a disagreement in
       rather than merely detecting one. Small enough to ship: the crowd's rails
       are a few hundred vertices. */
    const WATCH = ['crowd-barriers'];
    const afterVerts = await page.evaluate((names) => {
      const o = {};
      for (const n of names) o[n] = window.__zyVerts(n);
      return o;
    }, WATCH);

    /* The control, in the same page. A hash change alone does not reload, so
       the reload is explicit — and `begin()` again afterwards, because the new
       Game is a new object. */
    await page.evaluate((h) => { location.hash = h; location.reload(); },
      `manual&tier=high&seed=${seed}&cap=0&hud=0&runoff=0`);
    await page.waitForFunction(() => !!window.__game, null, { timeout: 90_000 });
    await page.evaluate(() => window.__game.begin());
    const base = await page.evaluate(PROBE);
    const baseVerts = await page.evaluate((names) => {
      const o = {};
      for (const n of names) o[n] = window.__zyVerts(n);
      return o;
    }, WATCH);

    /* Re-hash the meshes that grow, over the control's own float count, so the
       comparison is course-against-course. Done on the control's page and then
       on a rebuild of the run-off page, because __zyPrefix closes over the
       geometry of whichever build is loaded. */
    const basePrefix = await page.evaluate((names) => {
      const o = {};
      for (const n of names) o[n] = window.__zyPrefix(n, Infinity);
      return o;
    }, Object.keys(base.rows).filter(k => base.rows[k].grows));

    await page.evaluate((h) => { location.hash = h; location.reload(); },
      `manual&tier=high&seed=${seed}&cap=0&hud=0`);
    await page.waitForFunction(() => !!window.__game, null, { timeout: 90_000 });
    await page.evaluate(() => window.__game.begin());
    await page.evaluate(PROBE);
    const afterPrefix = await page.evaluate((spec) => {
      const o = {};
      for (const [n, floats] of spec) o[n] = window.__zyPrefix(n, floats);
      return o;
    }, Object.keys(basePrefix).map(n => [n, base.rows[n].floats]));

    out.push({ seed, base, after, basePrefix, afterPrefix, baseVerts, afterVerts });
  });
}

/* ---- report ------------------------------------------------------------- */
let bad = 0;
console.log('\n════ 1. is the race still the same race? ════');
console.log('  Sited scenery hashed whole; road/berm/corridor/bank hashed over their');
console.log('  course rows; shoreline-derived meshes checked for locality instead.\n');
const coastNotes = [];
for (const { seed, base, after, basePrefix, afterPrefix, baseVerts, afterVerts } of out) {
  const names = new Set([...Object.keys(base.rows), ...Object.keys(after.rows)]);
  const moved = [];
  const noise = [];
  for (const n of names) {
    const b = base.rows[n], a = after.rows[n];
    if (!b || !a) { moved.push(`${n}: present in only one build`); continue; }
    if (b.cls !== 'sited') continue;
    /* Where, not just whether — and with a tolerance, because bit-identity is
     * the wrong bar for a float32 buffer.
     *
     * `Coastline.signedDistanceXZ` carries a radial early-out that skips a
     * candidate frame when it cannot beat the running minimum, so which frames
     * are visited depends on the order they are visited in, and appending frames
     * changes that order. Where two paths reach the same answer by different
     * summations, float32 keeps whichever last bit it lands on. At 4–5 km from
     * the origin one ulp of float32 is about 2.4e-4 m, and that is precisely the
     * size of what is left here: 1.3e-4 m on the finish crowd's rails.
     *
     * So the test is "did anything move as much as a millimetre", and a vertex
     * index is resolved to a station so that a real move could not hide behind
     * this allowance. */
    const NOISE_M = 1e-3;
    const bv = baseVerts && baseVerts[n], av = afterVerts && afterVerts[n];
    if (bv && av && bv.length === av.length) {
      let worst = 0, at = 0;
      for (let i = 0; i + 2 < bv.length; i += 3) {
        const d = Math.hypot(av[i] - bv[i], av[i + 1] - bv[i + 1], av[i + 2] - bv[i + 2]);
        if (d > worst) { worst = d; at = i; }
      }
      if (worst > 0) {
        let nearS = 0, nearD = Infinity;
        for (const p of base.shore) {
          const dd = Math.hypot(p.x - bv[at], p.z - bv[at + 2]);
          if (dd < nearD) { nearD = dd; nearS = p.s; }
        }
        const where = `worst vertex moved ${worst.toExponential(2)} m, near s≈`
          + `${Math.round(nearS)} (${Math.round(base.length - nearS)} m back from`
          + ' the flag)';
        if (worst >= NOISE_M) moved.push(`${n}: ${where}`);
        else noise.push(`${n}: ${where} — under a millimetre, float32 noise`);
        continue;
      }
    }
    if (!b.full || !a.full || b.full.h !== a.full.h || b.full.n !== a.full.n) {
      moved.push(`${n}: ${b.full?.h}/${b.full?.n} → ${a.full?.h}/${a.full?.n}`);
    }
  }
  const grew = [];
  for (const n of Object.keys(basePrefix)) {
    const b = basePrefix[n], a = afterPrefix[n];
    if (!b || !a || b.h !== a.h || b.n !== a.n) {
      grew.push(`${n}: course rows differ (${b?.h}/${b?.n} → ${a?.h}/${a?.n})`);
    }
  }

  /* Shoreline locality, and the test is a FOOTPRINT test rather than a station
   * test.
   *
   * The naive version — "the shoreline may only move near the flag" — is wrong
   * on this stage, and wrong in a way that took a while to see. The coast
   * function takes x and z and no y. The stage descends 470 m and folds back
   * across itself, so the appended road passes directly underneath earlier parts
   * of the course: 1.3 m away in plan and 478 m below on seed 7, 1.0 m and 354 m
   * below on seed 22. Land that appears for the run-off there is land that
   * appears, in plan, beside a corner four kilometres earlier in the race.
   *
   * So the question is not where in the RACE the ground appeared, it is whether
   * the ground that appeared is the run-off's own shoulder. Every ladder sample
   * that changed is checked against the appended centreline: inside
   * ROADSIDE_LIP plus a margin for the road's half-width and the ladder's own
   * coarseness, it is the shoulder the run-off is standing on. Outside it,
   * something global moved and that is a real failure. */
  /* And the test is on the SIGN, not on the value.
   *
   * `signedDistanceXZ` is a continuous field, and the union is a `min` over
   * per-frame margins, so an appended frame lowers the field at every point it
   * is the nearest competitor for — which is a large set. Almost all of those
   * changes are invisible: a sample that went from 20.7 m out to sea to 16.8 m
   * out to sea is still out to sea, and nothing in the game reads the value
   * except through a land/sea test or a shoreline march. Flagging value changes
   * reported seeds 36 and 40 as regressions for 2 m and 4 m of nothing. What
   * moves the world is a sample changing side. */
  const LIP_REACH = 34;                   // ROADSIDE_LIP 16 + half-width + slack
  let flipped = 0, worstOutside = 0, outsideAt = null, worstDrop = 0, firstFlipS = null;
  for (let i = 0; i < Math.min(base.shore.length, after.shore.length); i++) {
    const b = base.shore[i], a = after.shore[i];
    if ((b.d > 0) === (a.d > 0)) continue;
    flipped++;
    if (firstFlipS === null) firstFlipS = b.s;
    let near = Infinity, nearY = 0;
    for (const [rx, rz, ry] of after.runPts) {
      const pd = Math.hypot(b.x - rx, b.z - rz);
      if (pd < near) { near = pd; nearY = ry; }
    }
    if (near > LIP_REACH) {
      if (near > worstOutside) {
        worstOutside = near; outsideAt = { s: b.s, near, drop: b.roadY - nearY };
      }
    } else worstDrop = Math.max(worstDrop, b.roadY - nearY);
  }
  coastNotes.push({ seed, flipped, firstFlipS, worstDrop });

  const sited = [];
  if (outsideAt) {
    sited.push(`a shoreline sample at s=${Math.round(outsideAt.s)} changed side, and`
      + ` the nearest run-off is ${outsideAt.near.toFixed(0)} m away in plan —`
      + ' OUTSIDE the appended road\'s own footprint, so something global moved');
  }
  const cmp = (label, x, y) => {
    const sx = JSON.stringify(x), sy = JSON.stringify(y);
    if (sx !== sy) sited.push(`${label} ${sx} → ${sy}`);
  };
  cmp('length', base.length, after.length);
  cmp('finishS', base.finishS, after.finishS);
  cmp('gateS', base.gateS, after.gateS);
  cmp('ramps', base.ramps, after.ramps);
  cmp('crowd', base.crowd, after.crowd);
  cmp('schedule', base.schedule, after.schedule);
  cmp('bounds', base.bounds, after.bounds);
  cmp('stageStats', { ...base.stats, roadEnd: 0, runoff: 0 },
    { ...after.stats, roadEnd: 0, runoff: 0 });

  const ok = !moved.length && !grew.length && !sited.length;
  if (!ok) bad++;
  const cn = coastNotes[coastNotes.length - 1];
  console.log(`  ${String(seed).padStart(4)}   ${ok ? '✓ race identical' : '✗ RACE CHANGED'}`
    + `    land/sea: ${!cn.flipped ? 'not one of '
      + base.shore.length + ' samples changed side'
      : `${cn.flipped} of ${base.shore.length} samples became land, first at s=`
        + `${Math.round(cn.firstFlipS)}, all inside the run-off's own shoulder`
        + ` (which passes up to ${cn.worstDrop.toFixed(0)} m below them)`}`);
  for (const m of [...moved, ...grew, ...sited]) console.log('           ! ' + m);
  for (const m of noise) console.log('           · ' + m);
}

console.log('\n════ 2. what did it cost? ════');
console.log('  seed    control      with run-off     delta   per metre   ceiling 260,000');
let worst = 0, worstSeed = 0;
for (const { seed, base, after } of out) {
  const d = after.tris - base.tris;
  const per = d / Math.max(1, after.runoff);
  if (after.tris > worst) { worst = after.tris; worstSeed = seed; }
  const over = after.tris > 260_000;
  if (over) bad++;
  console.log(`  ${String(seed).padStart(4)}  ${String(Math.round(base.tris)).padStart(9)}`
    + `  ${String(Math.round(after.tris)).padStart(13)}`
    + `  ${(d >= 0 ? '+' : '') + Math.round(d)}`.padStart(9)
    + `  ${per.toFixed(1).padStart(9)}`
    + `   ${over ? '✗ OVER' : 'ok, ' + Math.round(260_000 - after.tris) + ' spare'}`);
}
console.log(`\n  worst seed is ${worstSeed} at ${Math.round(worst)} triangles`
  + `  (${Math.round(260_000 - worst)} under the ceiling)`);

if (VERBOSE) {
  console.log('\n  where the delta went, on the worst seed:');
  const w = out.find(o => o.seed === worstSeed);
  const names = [...new Set([...Object.keys(w.base.rows), ...Object.keys(w.after.rows)])];
  const deltas = names.map(n => ({
    n, d: (w.after.rows[n]?.tris || 0) - (w.base.rows[n]?.tris || 0),
  })).filter(x => Math.abs(x.d) > 0.5).sort((a, b) => b.d - a.d);
  for (const x of deltas) {
    console.log(`    ${x.n.padEnd(20)} ${(x.d >= 0 ? '+' : '') + Math.round(x.d)}`);
  }
}

console.log('\n════ 3. is the run-off road? ════');
console.log('  Ground: how far below the road the shoulder is, 2 m and 6 m outboard of');
console.log('  each kerb, worst of the four. The last 34 m of course is measured in BOTH');
console.log('  builds, so a drop that was always there is not charged to the run-off —');
console.log('  and it is the yardstick for what "normal" is on this stage.\n');
console.log('  seed   past line   shoulder drop: course 34 m    run-off 120 m   in the sea');
for (const { seed, base, after } of out) {
  const seg = (r, from, to) => r.shape.filter(x => x.s >= from - 1e-6 && x.s <= to + 1e-6);
  const worstGap = (rowsIn) => {
    const holes = rowsIn.filter(r => r.ground === null).length;
    const gap = rowsIn.reduce((m, r) => Math.max(m, r.ground ?? -Infinity), -Infinity);
    return { holes, gap };
  };
  const cBase = worstGap(seg(base, base.finishS, base.roadEnd));
  const cAfter = worstGap(seg(after, after.finishS, after.length));
  const rAfter = worstGap(seg(after, after.length, after.roadEnd));
  const wet = seg(after, after.length, after.roadEnd).filter(r => r.wet > 0);

  /* What actually fails: a shoulder with NOTHING under it, or a drop far
     outside the family the course itself sits in. The course's own last 34 m
     measures 1.6 to 9.8 m across the fourteen seeds — that is what a shoulder on
     this stage looks like — so a threshold of "no worse than the course by 2 m"
     was measuring seed-to-seed terrain variety, not a defect. */
  const worse = rAfter.gap - cBase.gap;
  const holeBad = rAfter.holes > 0 || rAfter.gap > 20;
  const wetBad = wet.length > 0;
  if (holeBad || wetBad) bad++;
  console.log(`  ${String(seed).padStart(4)}   ${String(Math.round(after.roadEnd - after.finishS)).padStart(9)}`
    + `   ${('control ' + cBase.gap.toFixed(1) + ' / now ' + cAfter.gap.toFixed(1) + ' m').padStart(24)}`
    + `   ${(rAfter.holes ? rAfter.holes + ' ON AIR'
      : rAfter.gap.toFixed(1) + ' m (' + (worse >= 0 ? '+' : '') + worse.toFixed(1) + ')').padStart(17)}`
    + `   ${(wet.length ? '✗ ' + wet.length + ' samples' : 'none').padStart(11)}`);
}

console.log('\n  What the road past the flag asks of a braking car, split by author.');
console.log('  The 34 m of course is unchanged by this pass and is here as the yardstick.\n');
console.log('  seed         span   slope in → out    worst crest unload      peak lateral    centreline');
for (const { seed, after } of out) {
  for (const [label, sp] of [['course 34 m', after.courseSpan],
    ['run-off 120 m', after.runoffSpan]]) {
    const crestBad = label[0] === 'r' && sp.unloadG > 0.25;
    const latBad = label[0] === 'r' && sp.latG > 0.15;
    if (crestBad || latBad) bad++;
    console.log(`  ${String(seed).padStart(4)}   ${label.padStart(13)}`
      + `   ${(sp.slope0.toFixed(3) + ' → ' + sp.slope1.toFixed(3)).padStart(15)}`
      + `   ${(sp.unloadG.toFixed(2) + ' g @ ' + sp.atM + ' m/' + Math.round(sp.atKmh) + ' km/h').padStart(21)}`
      + `   ${(sp.latG.toFixed(2) + ' g @ ' + sp.latAtM + ' m').padStart(15)}`
      + `   ${(sp.devM.toFixed(1) + ' m').padStart(9)}`
      + (crestBad || latBad ? '  ✗' : ''));
  }
}

console.log(bad ? `\n  ✗ ${bad} findings above` : '\n  ✓ clean');
if (bad) process.exitCode = 1;
finish(process.exitCode || 0);
