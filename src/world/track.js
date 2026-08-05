/* The mountain.
 *
 * A downhill rally stage is not a circuit: it never repeats, it only falls.
 *
 * The first version of this integrated a smoothed random walk down the hill.
 * It produced a road, and the road was forgettable — every corner the same
 * medium radius, no straight long enough to matter, and near the summit it
 * folded back through its own footprint four times inside two hundred metres.
 * A random walk has no memory, and stage design is entirely memory: a corner
 * is only fast because of the one before it.
 *
 * So the centreline is now driven by an explicit schedule of elements —
 * straights, sweepers, corners, hairpins, tightening corners — laid out in
 * four phases that give the descent a shape you can describe out loud: an open
 * ridge you take flat, a technical face of switchbacks, a mixed shelf, and a
 * fast run out along the coastal shelf. Curvature inside an element is
 * constant, so corners are corners and straights are genuinely straight; a
 * low-pass on the way in gives each one a realistic entry rather than a kink.
 *
 * Which way a corner turns is not free: whenever the road drifts outside the
 * basin the schedule's preferred hand is overridden by whichever way heads
 * back in. That coils the stage without ever bending a straight.
 *
 * Everything downstream — physics, AI, the elevation minimap, where boulders
 * may sit — reads this one structure through frameAt(s).
 */
import * as THREE from 'three';
import { rng, rand, noise1, noise2 } from '../core/rng.js';
import { clamp, lerp, smoothstep } from '../core/util.js';
import { celMaterial, unlitCelMaterial } from '../render/cel.js';

export const STEP = 3;              // metres between centreline samples

/**
 * Box-blur a per-frame scalar over a window measured in metres.
 *
 * The three-tap filters this replaces ran over frames, not distance: at a 3 m
 * sample spacing a few passes of [1,2,1] smooth over about five metres, which
 * let the banking swing seventeen degrees inside twenty-five metres. The road
 * corkscrewed, and the car was thrown off it every time. Prefix sums keep the
 * cost independent of how wide the window is.
 */
function smoothField(frames, key, metres, passes = 2) {
  const n = frames.length;
  const half = Math.max(1, Math.round(metres / (2 * STEP)));
  const pre = new Float64Array(n + 1);
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + frames[i][key];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - half), b = Math.min(n - 1, i + half);
      frames[i][key] = (pre[b + 1] - pre[a]) / (b - a + 1);
    }
  }
}

/** Cap how fast a per-frame scalar may change, in units per metre. */
function rateLimit(frames, key, perMetre) {
  const n = frames.length, step = perMetre * STEP;
  for (let i = 1; i < n; i++) {
    frames[i][key] = clamp(frames[i][key], frames[i - 1][key] - step, frames[i - 1][key] + step);
  }
  for (let i = n - 2; i >= 0; i--) {
    frames[i][key] = clamp(frames[i][key], frames[i + 1][key] - step, frames[i + 1][key] + step);
  }
}

const _v = new THREE.Vector3();
const _t = new THREE.Vector3();
/* Scratch for Track._stationAt, which runs a few hundred times a second. */
const _o1 = new THREE.Vector3();
const _o2 = new THREE.Vector3();
const _ab = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/* How far the crowned road surface has dropped by the time it reaches its own
   edge. The berm has to start exactly here: an earlier version began the berm
   at the frame's centre height, which left a half-metre vertical step running
   the whole length of the stage. Lit only by the sky term it showed up as a
   thin teal line along both shoulders — a seam that looks like a material bug
   and is actually a geometry one. */
export const EDGE_DROP = -0.5;

/* The stone-and-grass berm cross-section, as [lateral offset from the road edge, height].
   Shared, because the guard rail has to stand on top of it — a rail authored
   against its own idea of where the berm is ends up with buried posts on one
   side of the road and floating ones on the other. */
const BERM = [[0.0, EDGE_DROP], [1.5, 0.95], [2.6, 1.35], [3.9, 0.4], [5.0, -0.75]];
const BERM_CREST = 2.6;

/** Berm height at a lateral offset for a sample of the given height scale.
    Interpolating from EDGE_DROP rather than from zero means a scale of 0
    leaves a flat apron continuous with the road, so a berm can die out
    completely on a straight instead of shrinking into a speed bump. */
export function bermHeight(off, scale) {
  const h = (hh) => EDGE_DROP + (hh - EDGE_DROP) * scale;
  for (let k = 0; k < BERM.length - 1; k++) {
    const [o0, h0] = BERM[k], [o1, h1] = BERM[k + 1];
    if (off >= o0 && off <= o1) return h(lerp(h0, h1, (off - o0) / (o1 - o0)));
  }
  return h(off < 0 ? BERM[0][1] : BERM[BERM.length - 1][1]);
}

/* ------------------------------------------------------------------ */
/*  Ramps                                                              */
/* ------------------------------------------------------------------ */

/**
 * The ramp cross-section along the road, as heights at the road mesh's own
 * 3 m sample grid.
 *
 * Grid-aligned, and that is the load-bearing part. `buildRoad` emits one row
 * per STEP, so a ramp defined as an analytic curve and then sampled at 3 m
 * disagrees with its own mesh by centimetres at the crest — which is the BERM
 * duplication bug arrived at from the other side, and that one put the car
 * 1.25 m above the rock it was drawn grinding along. Piecewise-linear between
 * STEP-aligned control points makes physics and mesh agree exactly by
 * construction, costs nothing, and still shades as a curve because the road
 * material runs flatShading:false with computeVertexNormals.
 *
 * Up-face: 18 m of h·u³ with h = 1.42, so the segment slopes rise from 0.002
 * at the foot to 0.199 at the lip. A kicker, not a hump — the maximum slope
 * is exactly where the car leaves. A flat crest would be worse than useless,
 * because the car would arrive at the lip with nothing.
 *
 * The exit slope is the whole size of the jump and it used to be 0.092, which
 * bought 4.4-4.9 m/s and a 0.73-1.32 m apex. Measured over a full race, the
 * stage's own incidental terrain was throwing the car 4.85 m and 3.27 s
 * without being asked, so the engineered, sited, boost-fed ramp was the
 * fourth-biggest jump in its own game and read as a bump in the road. At
 * 0.199 the same lip speeds give 9.5-11 m/s, which clears the accident.
 *
 * Cubic rather than quadratic, and taller rather than shorter, because both
 * halves of the defect are paid for by the same change. A quadratic reaching
 * 0.199 at the lip would have to stand 1.96 m tall; a cubic gets there at
 * 1.42, which is still three times the old relief and finally breaks the
 * road's outline on approach, but leaves a face a car can drive up rather
 * than a wall it hits. The cost is a gentler first half: the up-face is
 * essentially flat for its first nine metres, which is why the site also
 * carries signage now rather than paint alone.
 *
 * Back face: 6 m, linear to zero. The car flies over it; it exists so the
 * bump reads as a bump from the road behind.
 */
const RAMP_PROFILE = [0, 0.007, 0.053, 0.178, 0.421, 0.822, 1.420, 0.710, 0];
/** Index of the lip within RAMP_PROFILE — the end of the up-face. */
const RAMP_LIP_I = 6;
export const RAMP_LEN = (RAMP_PROFILE.length - 1) * STEP;      // 24 m
export const RAMP_UP_LEN = RAMP_LIP_I * STEP;                  // 18 m
/** Slope of the last up-face segment. What the launch impulse is scaled by. */
export const RAMP_LIP_SLOPE =
  (RAMP_PROFILE[RAMP_LIP_I] - RAMP_PROFILE[RAMP_LIP_I - 1]) / STEP;

/* Laterally: full height across the road AND across the first 1.5 m of berm,
   which is the climbable face, then linear to zero at the berm's outer toe.
   Holding it full across the climbable face keeps the taper in the part of the
   profile a car essentially never occupies, and taking it to zero at the toe
   means Field.point and the whole corridor apron need no change at all.
   Full width across the road is not a style choice either: Car._climb compares
   surfaceAt(s, lat) against surfaceAt(s, this.lat) at the SAME s, so a height
   that depends only on s cancels exactly out of the lift budget. A ramp
   narrower than the road would charge MAX_LIFT and feel like an invisible
   kerb. */
const RAMP_FULL_OFF = 1.5;
const RAMP_TOE_OFF = 5.0;

/* The boost pad, as metres before the ramp foot. Six metres of strip cannot
   accelerate anything — see Car.step, where crossing it arms a timer rather
   than adding speed — so its length is chosen to be legible at 170 km/h and
   nothing else. */
export const PAD_BEFORE = 34;
export const PAD_LEN = 6;

/* ------------------------------------------------------------------ */
/*  The finish assembly, and the road that runs on past it             */
/* ------------------------------------------------------------------ */

/**
 * THE STATION CONVENTION, because it changed and the old one was a trap.
 *
 * `Track.length` is the length of the RACE. It is what every siting scan in
 * this project measures fractions and margins against — where boulders may
 * sit, where the tunnel bores, where the crowd stands, which chapter of the
 * palette a station is in — and it is the datum the finish assembly hangs
 * off. It does NOT change when run-off is appended, and that is the whole
 * point: it is the one number a hundred-odd generators read, and moving it
 * re-seeds the entire world.
 *
 * `Track.roadEnd` is the last station with authored road under it. It is
 * `length + RUNOFF_M`, and it is what a car's projection, a surface query and
 * the road/berm meshes are bounded by.
 *
 * The flag and the arch are then ABSOLUTE stations, published once as
 * `Track.finishS` and `Track.gateS`, and every consumer reads those fields
 * rather than re-deriving them. Before this pass they were spelled
 * `track.length - 34` and `track.length - 12` at eleven call sites, which is
 * how a road that grew at the end silently took the whole finish assembly
 * with it and left exactly as little run-off as before.
 */
export const FINISH_BACK_M = 34;
export const GATE_BACK_M = 12;

/**
 * How much road is authored PAST the end of the race, in metres.
 *
 * This is a braking distance and it is derived rather than chosen. A car
 * arriving at the flag at the fastest measured speed — 45.6 m/s, 164 km/h, on
 * the seeds whose last kilometre is a straight — needs v²/2a to stop, and the
 * brakes are worth 12200 N against 1180 kg, so `a` is 10.3 m/s² before
 * anything else helps:
 *
 *     45.6² / (2 × 10.3) = 101 m
 *
 * plus the drag, rolling resistance and engine braking the ending's observer
 * measures at 2–3 m/s², which brings it to about 81 m at full pedal. Full
 * pedal is not available: see BRAKE_PEDAL_MAX in race/ending.js, where a
 * saturated tyre is measured taking the car from 11° of slip to 158°. At the
 * 0.55 pedal that leaves four fifths of the lateral authority, the tyres do
 * 5.7 m/s² and the total is about 8.2, which asks for 127 m.
 *
 * There were 34, which is why the ending had to bolt on 3.8 g of scripted
 * retardation to stop the car at all. 34 + 120 = 154 m past the flag: enough
 * to stop the fastest arrival at a pedal that keeps the car pointing down the
 * road, and with a stopping mark that still leaves road under the car.
 *
 * The number in the brief this pass was written against — "164 km/h needs
 * 58.6 m" — is wrong, and it is wrong by a factor of nearly two. 58.6 m is
 * the stopping distance from 33.9 m/s (122 km/h), which is what the ending's
 * own comment says it is; it was then re-attributed to the 164 km/h arrival.
 * Sizing the run-off to 58.6 m would have left the four fast seeds still
 * needing a servo.
 */
export const RUNOFF_M = 120;

/* What the run-off is, as a shape.
 *
 * A real hillclimb does not stop at the flag: the road runs on, gently, and
 * you use it. So this is authored as road and not as an apron — it curves,
 * it has a shoulder, it falls away — but every number here is chosen so that
 * nothing in it needs skill, because the driver's whole attention past the
 * flag is on the brake pedal.
 *
 * `RUNOFF_CURV` is a peak curvature of 1/2200, which at the 45 m/s the fast
 * seeds arrive at is 0.9 m/s² of lateral demand — a twentieth of the grip
 * budget — and bends the centreline about 2.7 m over the whole run-off,
 * comfortably inside a half-width. It exists so the run-off is not a runway.
 *
 * `RUNOFF_GRADE` is where the slope settles. It is nearly level and slightly
 * falling, and the easing to it is the load-bearing part rather than the
 * value: the course's own runout leaves the road CLIMBING at up to +14% over
 * its last three metres (see _build, where the levelling lerps toward a fixed
 * height and comes out convex), so the join has a slope step of that size to
 * absorb. Vertical curvature costs the car grip at v²·dslope/ds, so the
 * easing is deliberately back-loaded — `RUNOFF_EASE0` holds the joining slope
 * for the first stretch and does the work later, where the car has already
 * lost most of its speed and v² is a third of what it was.
 */
const RUNOFF_CURV = 1 / 2200;
const RUNOFF_GRADE = -0.012;
const RUNOFF_EASE0 = 0.18;
/* What the road holds at, and what the berm slumps to. Free — the road mesh
   emits the same eleven columns whatever the width — so the only question is
   what it should be, and that is a measured one.
   
   It was 14.5 first, chosen to sit under the finish apron's 19–22 m because a
   wider one "would read as an airstrip". tools/zystop.mjs then measured what a
   car actually uses out here, and 14.5 was taking road away from it: a 190 km/h
   arrival on seed 16 brakes down to a lateral of 8.3 m, needing ±8.3 of road,
   while the apron it inherits gives ±11.5 and this narrowed it to ±7.25 —
   underneath the car, mid-stop. It ended up leaning on the berm on five of eight
   seeds, and on four of them it did so merely being DRIVEN down the run-off with
   no braking at all, which is the road failing and not the ending.
   
   19 is the apron's own lower bound, so the run-off no longer narrows under
   anybody; it holds the width the finish already had. A car that uses 8.3 m of it
   has 1.2 m in hand. The airstrip worry was about a width that does not exist
   here anyway — this is 19 m of road with a berm and a falling shoulder on both
   sides, not an apron. */
const RUNOFF_WIDTH = 19;
const RUNOFF_BERM = 0.35;

/* Markings, in triangles. What stays on the road mesh is five ramp-face
   chevrons and a lip stripe, at two triangles an arm and twelve strips for
   the stripe: twenty-two quads a site.
   The pad ground and its four chevrons have moved out to their own mesh —
   see buildRampPaint — because the brief asks for a pad that glows and a lit
   surface sharing the road's material cannot. */
const CHEVRON_W = 0.85;
const GROUND_H = 0.018;      // the painted rectangle
const MARK_H = 0.032;        // and the paint on top of it
/* How finely the paint is cut, across the road and along it. A marking is a
   flat quad on a surface that is not flat, so every quad chords under whatever
   it spans; the cut sizes are chosen against the two curvatures that do the
   burying. Across: the crown's third power means the outermost strip sags most,
   and 0.15 of half-width — about 0.8 m — keeps that at 8 mm. Along: the road's
   rows are 3 m apart and the surface kinks at every one of them, so 1.5 m
   guarantees no quad spans more than one kink. */
const PAINT_LAT = 0.12;
const PAINT_LONG = STEP;
const ROAD_COLUMNS = 11;     // must match buildRoad's default; see roadPoint

/* The paint's shape, named because the road buffer has to be sized for exactly
   the number of quads the emission below produces, and a subdivided marking is
   no longer countable by eye. */
const RAMP_CHEVRONS = 5;
const CHEV_REACH = 0.86;     // how far out an arm starts, in half-widths
const CHEV_ARM = 1.2;        // and how far down-road it runs to the crown
const LIP_HALF = 0.94;
const LIP_LONG = 0.6;
const PAD_HALF = 0.92;
/* An upper bound, not a count: the cuts along the road are snapped to the mesh's
   rows, so how many a band needs depends on where the band happens to sit. One
   spare piece per strip covers the worst phase. */
const paintQuads = (dLat, back) =>
  Math.max(1, Math.ceil(Math.abs(dLat) / PAINT_LAT))
  * (Math.max(1, Math.ceil(back / PAINT_LONG)) + 1);
const DECOR_QUADS = RAMP_CHEVRONS * 2 * paintQuads(CHEV_REACH, CHEVRON_W)
  + paintQuads(2 * LIP_HALF, LIP_LONG);

/* The paint, as colours.
 *
 * The brief asks for yellow and red stripes and for a glowing pad, and the
 * first pass shipped cream (0xe6dcc4), sand (0xd8ccae) and teal (0x3f93ad).
 * Probed through the finished frame those came back neutral at every range:
 * off-white road paint on grey road, separated by value alone, and value is
 * the one axis the cel ladder spends on lighting.
 *
 * Two of these are ordinary road paint and go on the road's own lit material.
 * The two PAD_ colours are self-lit — see buildRampPaint — so they are
 * authored as the value they will actually draw at rather than as an albedo
 * the sun still has to reach. */
const RAMP_MARK_A = 0xf2b431;    // hazard yellow, the odd chevrons
const RAMP_MARK_B = 0xc0341f;    // hazard red, the even ones
const LIP_MARK = 0xd2401f;       // and the lip itself, in the same red

/* The pad, and it is deliberately not in the family above.
 *
 * Measured from 43 m the first self-lit pad scored 0.079 of luma contrast
 * against the tarmac while the *lit* hazard chevrons on the ramp face scored
 * 0.35 from twice that distance — an unlit surface authored at 0xffc233 draws
 * darker through this pipeline than a lit surface authored at 0xf2b431, because
 * the lit one is albedo times a sun the cel ladder puts on its top rung and the
 * unlit one is the albedo and nothing else. So the authored colour has to be
 * where the *output* should be, which for something meant to read as a light is
 * near the top of the range.
 *
 * It also has to stop speaking the hazard boards' language. There are now four
 * yellow-and-red striped boards at every site doing the warning job properly,
 * in the vocabulary warnings use, so the pad is free to be the other thing —
 * hot, bright, and about going faster rather than about being careful. Amber
 * through white at the centre, with the arrows dark enough to read as shape
 * against it. */
const PAD_GLOW = 0xc4441a;       // the bed, self-lit, ember rather than hazard
const PAD_CORE = 0xffcf76;       // hotter down the centreline, where the wheels go
const PAD_CORE_HALF = 0.30;      // how much of the half-width the core takes
const PAD_GLOW_MARK = 0xfff0b4;  // and the arrows themselves, white hot

/**
 * The road surface's own relief, above the centreline frame: the crown, the
 * ripple and the worn troughs. One function, read by the mesh that draws the
 * road and by every marking laid on it.
 *
 * This is the third time this project has been bitten by two copies of a
 * surface disagreeing, and it is the reason the boost pad was still 9.6% buried
 * after the crown was accounted for. The paint modelled the crown and nothing
 * else, while the road it sits on also carries a ripple of ±65 mm and troughs
 * up to 70 mm deep. Against relief four times the 18 mm the paint is lifted by,
 * no lift was ever going to be enough — the pad was not sitting slightly low,
 * it was sitting on a different surface.
 *
 * The ripple also had to change to be shareable at all, and that is worth
 * stating plainly because it is a change to the road rather than to the paint.
 * It was `grain(s / 3.7 + c * 3.1)`, indexed by *column number*: adjacent
 * columns are a metre apart and 3.1 units apart in the field, which is fully
 * decorrelated, so the road carried ±65 mm of vertical noise at a spatial
 * frequency its own 11 columns and 3 m rows cannot represent. That is aliasing
 * rather than relief — the mesh renders it as a sawtooth whose shading is
 * arbitrary, and nothing else can follow it, because between two samples there
 * is no fact of the matter about where the surface is. At 9 m along and about a
 * road-width across, the same amplitude is carried by three rows and five
 * columns, which the mesh can draw and the paint can sit on.
 */
const roadRelief = (() => {
  const grain = noise1(991);
  const rutN = noise1(1201);       // how worn the wheel track is, along the stage
  const wanderN = noise1(1307);    // where it sits, across the road
  return (s, lat) => {
    const k = lat >= 0 ? 1 : 0;    // the two wheel tracks wear independently
    const amp = clamp(0.08 + rutN(s / 15 + k * 311) * 0.88 + rutN(s / 5.2 + k * 127) * 0.58,
      0, 0.94);
    const ctr = clamp(0.34 + wanderN(s / 13 + k * 211) * 0.2 + wanderN(s / 4.7 + k * 83) * 0.07,
      0.15, 0.59);
    const crown = -Math.pow(Math.abs(lat), 3.0) * 0.5;
    const trough = Math.exp(-Math.pow((Math.abs(lat) - ctr) * 9.0, 2)) * 0.075 * amp;
    const ripple = grain(s / 9 + lat) * 0.065;
    return crown + ripple - trough;
  };
})();

/**
 * A point `lift` above the road mesh, at an arbitrary station and lateral.
 *
 * Sampling the relief function directly would still not put a marking on the
 * road, because the mesh is not the relief function — it is eleven columns of
 * it, sampled every three metres and joined with flat quads. Between samples
 * the mesh is a chord, and a chord under a curve is exactly the failure this
 * whole family of defects is made of. So this reproduces what the mesh does:
 * the four surrounding mesh vertices, built the way buildRoad builds them, and
 * a bilinear blend between them. The paint then sits `lift` above the surface
 * the renderer actually rasterises, not above an idea of it.
 *
 * What is left is the twist inside one cell — a bilinear patch against the two
 * triangles it is drawn as — and that is now a millimetre or two, because the
 * relief no longer varies faster than the lattice can carry.
 */
const _rp = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _rup = new THREE.Vector3();
const _re0 = new THREE.Vector3(), _re1 = new THREE.Vector3();
const _rout = new THREE.Vector3();
function roadPoint(track, s, lat, lift) {
  const t = clamp(s, 4, track.length - 4) / STEP;
  const i0 = clamp(Math.floor(t), 0, track.count - 2);
  const wS = clamp(t - i0, 0, 1);
  const c = (clamp(lat, -1, 1) + 1) * 0.5 * (ROAD_COLUMNS - 1);
  const c0 = clamp(Math.floor(c), 0, ROAD_COLUMNS - 2);
  const wL = clamp(c - c0, 0, 1);
  const latOf = k => (k / (ROAD_COLUMNS - 1) - 0.5) * 2;

  _rup.set(0, 0, 0);
  for (let a = 0; a < 2; a++) {
    for (let b = 0; b < 2; b++) {
      const f = track.frames[i0 + a];
      const cl = latOf(c0 + b);
      const h = roadRelief(f.s, cl) + track.rampHeight(f.s, 0);
      _rp[a * 2 + b].copy(f.pos)
        .addScaledVector(f.right, cl * f.width * 0.5)
        .addScaledVector(f.up, h);
      _rup.addScaledVector(f.up, 0.25);
    }
  }
  /* On the correct triangle, not on a bilinear patch through the four corners.
     buildRoad emits (a,b,d) and (b,e,d) — a diagonal from the near-outer corner
     to the far-inner one — so the two halves of a cell are the wL + wS <= 1 side
     and the other, and a bilinear blend is neither of them. The difference is
     the cell's twist, and with ±65 mm of ripple in play it was tens of
     millimetres: the whole clearance budget, spent on a curve the road does not
     actually have.

     Then out along the averaged normal — averaged because the two rows can be
     banked differently and a marking straddling them belongs to neither. */
  const near = wL + wS <= 1;
  const origin = near ? _rp[0] : _rp[3];
  const e0 = _re0.subVectors(near ? _rp[1] : _rp[2], origin);
  const e1 = _re1.subVectors(near ? _rp[2] : _rp[1], origin);
  return _rout.copy(origin)
    .addScaledVector(e0, near ? wL : 1 - wL)
    .addScaledVector(e1, near ? wS : 1 - wS)
    .addScaledVector(_rup.normalize(), lift);
}

/* Exported for tools/latticecheck.mjs, which is the gate on paint-versus-road
   parity. Nothing in src/ calls it. */
export const roadPointForProbe = roadPoint;

/* One marking quad, in the road's own (station, lateral) space: a band whose
 * two ends can sit at different stations, which is all a chevron arm is.
 * Lateral runs low to high so the winding matches the surface quads and the
 * markings are not backfacing on one side of the road.
 *
 * The lift clears the flecks at 0.008 and the patches at 0.012, and the paint
 * clears its own ground — two coplanar quads is a z-fight, and it showed up
 * as the pad flickering out from under its own chevrons.
 *
 * Shared between the road mesh and the pad's own mesh so that moving the pad
 * onto a self-lit material could not quietly move the pad.
 */
function markCorners(track, sA, latA, sB, latB, back, lift) {
  const out = [];
  for (const [cs, cl] of [[sA - back, latA], [sA, latA], [sB, latB], [sB - back, latB]]) {
    out.push(roadPoint(track, cs, cl, lift).clone());
  }
  return out;
}

/**
 * A marking cut into quads small enough to follow the surface under it, and
 * emitted through whichever `band` is in scope — so the road mesh and the pad's
 * own mesh get an identical cut and cannot drift apart.
 *
 * Two axes. Across, because the crown and the ripple curve that way; along,
 * because the mesh kinks at every 3 m row. A chevron arm needs the first and a
 * six-metre pad ground needs both.
 */
function paintBand(band, sA, latA, sB, latB, back, lift, color) {
  const nLat = Math.max(1, Math.ceil(Math.abs(latB - latA) / PAINT_LAT));
  for (let i = 0; i < nLat; i++) {
    const t0 = i / nLat, t1 = (i + 1) / nLat;
    const s0 = sA + (sB - sA) * t0, l0 = latA + (latB - latA) * t0;
    const s1 = sA + (sB - sA) * t1, l1 = latA + (latB - latA) * t1;
    for (const [off, len] of longCuts(sA, back)) {
      band(s0 - off, l0, s1 - off, l1, len, lift, color);
    }
  }
}

/**
 * Where to cut a band along the road, as [offset back from the near edge,
 * length] pairs, snapped to the mesh's rows.
 *
 * Snapped rather than evenly spaced because the mesh is exactly linear between
 * two rows and kinks at every one of them: a cut that lands on a row has no
 * error at all, and an evenly spaced cut that straddles one carries the kink.
 * It is also cheaper — a six-metre pad bed needs two or three pieces this way
 * instead of four, and paint is the only thing on this stage that has grown
 * since the triangle ceiling was set.
 */
function longCuts(sA, back) {
  if (back <= PAINT_LONG && Math.floor(sA / STEP) === Math.floor((sA - back) / STEP)) {
    return [[0, back]];
  }
  const out = [];
  let off = 0;
  while (off < back - 1e-6) {
    const s = sA - off;
    const prevRow = Math.ceil(s / STEP - 1e-6) * STEP - STEP;   // the row behind s
    const len = Math.min(back - off, Math.max(0.05, s - prevRow), PAINT_LONG);
    out.push([off, len]);
    off += len;
  }
  return out;
}

/** A band spanning the road, kerb to kerb, through paintBand. */
function crossBand(band, s, lat, back, lift, color) {
  paintBand(band, s, -lat, s, lat, back, lift, color);
}

/**
 * Where the pad's chevrons sit, as [station, reach, arm].
 *
 * Three deep ones rather than four shallow ones. At 0.9 m of arm across 3.8 m
 * of road the V was 13 degrees off square, and from the chase camera's angle
 * that does not read as an arrow at all — the pad came out as a striped mat,
 * which is the one thing it must not be, because stripes are what the hazard
 * boards either side of it are saying. At 1.7 m the arrow points.
 */
function padChevrons(r) {
  const out = [];
  for (let k = 0; k < 3; k++) out.push([r.pad0 + 0.5 + k * 1.75, 0.72, 1.7]);
  return out;
}

/** One sample of the stage: everything a car, a camera or a rock needs. */
export class Frame {
  constructor() {
    this.pos = new THREE.Vector3();
    this.tan = new THREE.Vector3();
    this.right = new THREE.Vector3();   // banked
    this.up = new THREE.Vector3();      // banked
    this.flatRight = new THREE.Vector3();
    this.s = 0; this.curv = 0; this.bank = 0; this.width = 0; this.grade = 0;
    this.bermL = 1; this.bermR = 1;     // berm height scale, per side
  }
}

export class Track {
  /**
   * @param {number} seed
   * @param {{runoff?:number}} opts `runoff` overrides RUNOFF_M, in metres.
   *
   * The override exists as an INSTRUMENT and not as a tuning knob. This project
   * has no version control, so the only way to demonstrate that appending 120 m
   * of road past the flag left the race itself untouched is to build the same
   * seed both ways in one process and diff the geometry — which is what
   * `tools/zyrunoff.mjs --control` does. Zero is the control: `_appendRunoff`
   * returns before it pushes a frame, `roadEnd` collapses onto `length`, and
   * every derived station is what it was before this pass.
   */
  constructor(seed = 7, { runoff = RUNOFF_M } = {}) {
    this.seed = seed;
    this.runoff = Math.max(0, runoff);
    /* Filled in by pickRamps once the environment exists — the siting scan
       needs the terrain to know where the sun reaches the road. Empty is a
       valid stage: every consumer of rampHeight early-outs on it, so a Track
       built bare by a tool behaves exactly as it did before ramps existed. */
    this.ramps = [];
    this._build(seed);
  }

  /**
   * Height the ramp adds to the surface at (s, off), where `off` is metres
   * past the road edge — zero anywhere on the road itself.
   *
   * The one copy. Four consumers read it: buildRoad's `h` term, buildBerms'
   * `up` term, buildGuardRail's seat(), and Car.surfaceAt. This project has
   * already been bitten once by two copies of a cross-section drifting apart,
   * and tools/turns.mjs --pass 1 is the gate that catches it happening again.
   */
  rampHeight(s, off = 0) {
    const ramps = this.ramps;
    for (let k = 0; k < ramps.length; k++) {
      const u = s - ramps[k].foot;
      if (u <= 0 || u >= RAMP_LEN) continue;
      const t = u / STEP;
      const i = Math.floor(t);
      const h = lerp(RAMP_PROFILE[i], RAMP_PROFILE[i + 1], t - i);
      if (h <= 0) return 0;
      if (off <= RAMP_FULL_OFF) return h;
      if (off >= RAMP_TOE_OFF) return 0;
      return h * (RAMP_TOE_OFF - off) / (RAMP_TOE_OFF - RAMP_FULL_OFF);
    }
    return 0;
  }

  /** The ramp whose lip a step from `s0` to `s1` crossed, or null. */
  rampCrossed(s0, s1) {
    for (let k = 0; k < this.ramps.length; k++) {
      const lip = this.ramps[k].lip;
      if (s0 < lip && s1 >= lip) return this.ramps[k];
    }
    return null;
  }

  /** The boost pad a step from `s0` to `s1` entered, or null. */
  padCrossed(s0, s1) {
    for (let k = 0; k < this.ramps.length; k++) {
      const p0 = this.ramps[k].pad0;
      if (s0 < p0 && s1 >= p0) return this.ramps[k];
    }
    return null;
  }

  /**
   * True from the pad to a little past the landing.
   *
   * What this is for is the AI, and it is not cosmetic. A driver plans a
   * speed and then throttles or brakes toward it, so a bot that gets boosted
   * immediately finds itself over its own plan and brakes against the pad —
   * every rival loses time at every ramp while the player gains, and the pads
   * become a silent handicap dressed up as a feature. Lifting the plan across
   * the window keeps the error positive and the throttle open. The window is
   * straight by construction: `pickRamps` will not site a ramp without a near
   * -straight approach and a runout.
   */
  boostWindow(s) {
    for (let k = 0; k < this.ramps.length; k++) {
      const r = this.ramps[k];
      if (s >= r.pad0 && s <= r.land + 20) return true;
    }
    return false;
  }

  /* ---- the schedule -------------------------------------------------
     Four phases with distinct character, so the stage has somewhere to go.
     Lengths are approximate: generation stops on the first element boundary
     past the target, which is also why the last phase is the forgiving one. */
  _plan(r, targetLen) {
    const plan = [];
    let len = 0;
    const add = e => { plan.push(e); len += e.len; };

    const straight = (a, b) => add({ kind: 'straight', len: r.f(a, b), r0: Infinity, r1: Infinity });
    const turn = (kind, rMin, rMax, arcMin, arcMax, tighten = 0) => {
      const r0 = r.f(rMin, rMax);
      const r1 = tighten ? r0 * r.f(0.42, 0.6) : r0;
      const arc = r.f(arcMin, arcMax) * Math.PI / 180;
      // Arc length of a corner whose radius changes is close enough to the
      // mean radius for layout purposes.
      add({ kind, len: arc * ((r0 + r1) / 2), r0, r1, arc });
    };

    /* Phase 1 — the ridge. Open, fast, mostly committed. Teaches the car. */
    straight(150, 240);
    turn('sweeper', 170, 290, 45, 85);
    straight(110, 190);
    turn('sweeper', 130, 220, 55, 100);
    turn('corner', 70, 110, 60, 95);
    straight(150, 260);

    /* Phase 2 — the face. Switchbacks down the steep flank. This is where the
       stage is won and lost, so the corners here are the memorable ones. */
    turn('hairpin', 24, 34, 155, 195);
    straight(55, 95);
    turn('corner', 50, 80, 75, 115);
    turn('sweeper', 110, 165, 40, 70);
    straight(60, 110);
    turn('hairpin', 26, 36, 150, 185);
    straight(45, 80);
    turn('corner', 55, 90, 80, 120, 1);        // tightens: punishes early throttle
    straight(70, 130);
    turn('hairpin', 23, 32, 160, 200);
    straight(50, 90);

    /* Phase 3 — the shelf. Flowing, linked, rhythmic. Esses, then room. */
    turn('sweeper', 95, 150, 50, 80);
    turn('sweeper', 90, 140, 50, 80, 0);       // hand is flipped below
    plan[plan.length - 1].flip = true;
    straight(80, 140);
    turn('corner', 60, 95, 70, 105);
    turn('sweeper', 120, 190, 35, 60);
    plan[plan.length - 1].flip = true;
    straight(120, 200);
    turn('corner', 65, 100, 85, 125, 1);
    /* One deliberately off-camber corner. Everything else is surveyed for
       grip; this one takes it away, and it is the corner people remember. */
    turn('sweeper', 100, 150, 55, 85);
    plan[plan.length - 1].offCamber = true;

    /* Phase 4 — the coastal shelf. Long, fast, one last big stop. */
    while (len < targetLen - 700) {
      straight(200, 380);
      turn('sweeper', 180, 320, 30, 60);
      if (r.chance(0.4)) { turn('corner', 70, 120, 60, 100); straight(90, 160); }
    }
    turn('hairpin', 30, 42, 140, 175);
    straight(260, 400);
    return plan;
  }

  _build(seed) {
    const r = rand(rng(seed));
    const gradeNoise = noise1(seed * 7 + 29);
    const widthNoise = noise1(seed * 13 + 5);
    const bermNoise = noise1(seed * 17 + 3);

    const TARGET_LEN = 5600;
    const START_Y = 500;
    const R_MIN = 260, R_MAX = 540;
    /* The basin centre migrates as the stage descends. Holding it fixed keeps
       the road inside one ring, which is tidy and reads from above as a spiral
       drawn on top of itself — you cannot trace start to finish. Letting the
       centre travel turns the same schedule into a descending traverse: the
       switchback cluster and the fast sections end up in different parts of
       the map, and the silhouette has a direction. */
    const TRAVEL = 1150;
    const centre = (prog) => ({ x: TRAVEL * prog, z: TRAVEL * 0.28 * prog });

    const plan = this._plan(r, TARGET_LEN);
    this.plan = plan;

    const pts = [];
    let pos = new THREE.Vector3(0, START_Y, -520);
    let heading = 0;                  // radians; x += cos(h), z += sin(h)
    let curv = 0;                     // rad per metre, low-passed
    let grade = -0.05;
    let s = 0;

    let ei = 0, eStart = 0, hand = 1;
    let curEl = null;

    const chooseHand = (el) => {
      /* Prefer alternating hands — a stage that turns the same way twice in a
         row reads as a spiral — but the basin wins the argument. */
      let want = -hand;
      if (el.flip) want = -want;
      const c = centre(clamp(s / TARGET_LEN, 0, 1));
      const dx = pos.x - c.x, dz = pos.z - c.z;
      const rad = Math.hypot(dx, dz);
      if (rad > R_MAX || rad < R_MIN) {
        // Which way turns toward the centre: sign of heading × (centre − pos).
        const hx = Math.cos(heading), hz = Math.sin(heading);
        const inward = Math.sign(hx * (-dz / (rad || 1)) - hz * (-dx / (rad || 1))) || 1;
        want = rad > R_MAX ? inward : -inward;
      }
      return want;
    };

    while (s < TARGET_LEN && ei < plan.length) {
      if (!curEl || s - eStart >= curEl.len) {
        if (curEl) { eStart += curEl.len; }
        curEl = plan[ei++];
        if (!curEl) break;
        curEl.s0 = eStart;
        if (curEl.kind !== 'straight') { hand = chooseHand(curEl); curEl.hand = hand; }
      }

      const local = curEl.len > 0 ? (s - eStart) / curEl.len : 1;
      let target = 0;
      if (curEl.kind !== 'straight') {
        const rad = lerp(curEl.r0, curEl.r1, smoothstep(0.1, 0.85, local));
        target = curEl.hand / rad;
      }

      /* Transition. A hairpin has to arrive quickly or it eats the straight
         before it; a sweeper wants a long, soft entry. */
      const tRate = curEl.kind === 'hairpin' ? 0.13 : curEl.kind === 'corner' ? 0.09 : 0.055;
      curv += (target - curv) * tRate;
      heading += curv * STEP;

      /* Grade. Steepest on the open phases, eased through the switchbacks so
         they stay drivable, and never positive — this road only falls. */
      const steep = curEl.kind === 'hairpin' ? 0.42 : curEl.kind === 'corner' ? 0.72 : 1;
      /* Two scales of vertical shape. The long one decides whether a section
         is a plunge or a shelf; the short one puts crests and compressions
         inside it, which is what makes a descent feel like one from the
         driver's seat — a constant 9% grade reads as flat once the horizon is
         the only reference. */
      const gWant = clamp(-0.105 + gradeNoise(s / 300) * 0.07
                          + gradeNoise(s / 62 + 500) * 0.055, -0.20, -0.010) * steep;
      grade += (gWant - grade) * 0.06;

      const dy = grade * STEP;
      const horiz = Math.sqrt(Math.max(0, STEP * STEP - dy * dy));
      pos = pos.clone();
      pos.x += Math.cos(heading) * horiz;
      pos.z += Math.sin(heading) * horiz;
      pos.y += dy;

      pts.push({ p: pos, s, curv, grade, el: curEl });
      s += STEP;
      if (pos.y < 6) break;
    }

    /* Level the last 90 m so the finish gate sits square and a car crossing at
       160 km/h has somewhere to stop. */
    const runout = Math.min(30, pts.length - 2);
    for (let i = pts.length - runout; i < pts.length; i++) {
      const k = (i - (pts.length - runout)) / runout;
      pts[i].p.y = lerp(pts[i].p.y, pts[pts.length - runout].p.y - 1.2, k);
      pts[i].curv *= 1 - k * 0.9;
    }

    this.length = (pts.length - 1) * STEP;
    this.startY = START_Y;
    this.endY = pts[pts.length - 1].p.y;

    /* ---- frames -------------------------------------------------------
       Frenet frames twist violently where curvature crosses zero, which on a
       road means the banking flips over between corners. World-up frames are
       stable everywhere the road is not vertical, and the bank is then an
       explicit rotation about the tangent — which is also the only way to
       control how much bank there is. */
    const N = pts.length;
    const frames = new Array(N);
    for (let i = 0; i < N; i++) {
      const f = new Frame();
      const a = pts[Math.max(0, i - 1)].p, b = pts[Math.min(N - 1, i + 1)].p;
      f.pos.copy(pts[i].p);
      f.tan.subVectors(b, a).normalize();
      f.s = pts[i].s;
      f.curv = pts[i].curv;
      f.grade = pts[i].grade;
      f.el = pts[i].el;
      /* tan × up. Face +X with +Y up and this gives +Z, which is genuinely the
         driver's right — Three.js objects have forward −Z, up +Y, right +X,
         and forward × up = (−Z) × Y = +X. The other order gives left, and a
         basis built from it has determinant −1: the car mesh renders mirrored
         and every steering and drift sign downstream is inverted. */
      f.flatRight.crossVectors(f.tan, UP).normalize();
      frames[i] = f;
    }

    /* Width. Nominal rally road, pinched where the cliff closes in, opened at
       hairpins so there is room to throw the car sideways, and one deliberate
       pinch point per stage so not every metre is equally safe. */
    for (let i = 0; i < N; i++) {
      const f = frames[i];
      let w = 12.6 + widthNoise(f.s / 240) * 3.0;
      if (f.el?.kind === 'hairpin') {
        const local = (f.s - f.el.s0) / f.el.len;
        w = lerp(w, 20.5, Math.sin(clamp(local, 0, 1) * Math.PI) * 0.9);
      }
      if (widthNoise(f.s / 190 + 60) < -0.55) w = lerp(w, 8.8, 0.8);   // pinch
      if (f.s < 70) w = lerp(21, w, f.s / 70);                          // start apron
      if (f.s > this.length - 100) w = lerp(w, 23, (f.s - (this.length - 100)) / 100);
      f.width = clamp(w, 8.4, 24);
    }
    smoothField(frames, 'width', 60);
    rateLimit(frames, 'width', 0.075);   // no more than 7.5 m of flare per 100 m

    /* Bank. atan rather than a hard clamp on curvature × v²/g: a clamp makes
       every corner past a threshold bank identically, so a 300 m sweeper and a
       24 m hairpin looked the same. This keeps them a factor of three apart. */
    /* The gain used to be 0.58, which saturated the clamp for anything tighter
       than a 100 m radius — so every real corner on the stage banked at exactly
       the same 17°, and the factor-of-three spread this formula exists to
       produce did not survive. 0.26 puts a 33 m hairpin on the clamp and leaves
       a 150 m sweeper around 7°. */
    const VREF = 27;
    for (const f of frames) {
      const raw = Math.atan(f.curv * VREF * VREF / 9.81) * 0.26;
      f.bank = clamp(raw, -0.30, 0.30) * (f.el?.offCamber ? -0.45 : 1);
    }
    /* Flatten the aprons before smoothing rather than after. Forcing the end
       frames to zero once the rate limit has run puts the one discontinuity
       the limit exists to prevent right back into the road. */
    for (let i = 0; i < N; i++) {
      const fromEnd = Math.min(frames[i].s, this.length - frames[i].s);
      frames[i].bank *= smoothstep(0, 40, fromEnd);
    }
    smoothField(frames, 'bank', 70);
    // A real road takes 50 m to roll into 17° of bank. 0.006 rad/m is that.
    rateLimit(frames, 'bank', 0.006);

    for (const f of frames) {
      /* Positive curvature is a right turn — heading integrates x by cos and z
         by sin, so rising heading swings +X toward +Z — and banking lifts the
         outside, which is the left. Rotating +right about the tangent by a
         positive angle drops it, which raises the left exactly as wanted. */
      f.right.copy(f.flatRight).applyAxisAngle(f.tan, f.bank);
      f.up.crossVectors(f.right, f.tan).normalize();
      if (f.up.y < 0) f.up.negate();
    }

    /* Berm height, per side. Piled high on the outside of a fast corner where
       cars actually arrive, slumped to nothing on the inside so there is a cut
       to take, and broken up along its length so it is not an extrusion. */
    /* Berm height, per side. Piled high on the outside of a corner where cars
       actually arrive, gone on the inside so there is a cut to take, and low
       on straights — the base used to be high enough that a berm ran the whole
       stage at roughly constant height, which is what made it read as an
       extrusion no matter how much the profile was jittered. */
    for (const f of frames) {
      // Positive curvature turns right, so the outside is right when it is negative.
      const outsideR = clamp(-f.curv * 170, -1, 1);
      const wearR = bermNoise(f.s / 34) * 0.55;
      const wearL = bermNoise(f.s / 34 + 500) * 0.55;
      f.bermR = clamp(0.30 + wearR + outsideR * 0.85, 0.0, 1.75);
      f.bermL = clamp(0.30 + wearL - outsideR * 0.85, 0.0, 1.75);
    }
    // Narrower than the road fields: a berm is allowed to be lumpy along its run.
    smoothField(frames, 'bermL', 22);
    smoothField(frames, 'bermR', 22);

    /* ---- run-off ------------------------------------------------------
       Appended AFTER every field pass above has run, and that ordering is
       the whole reason the race is bit-identical to what it was before this
       existed. `smoothField(frames, 'width', 60)` averages over ±30 m and
       clamps its window at the end of the array, so a tail present while it
       runs would have changed the width of the last thirty metres of the
       course — and `rateLimit` would have carried some of that further back
       still. Run the passes on the race, then extend. */
    this._appendRunoff(frames, seed, centre(1));

    this.frames = frames;
    this.count = frames.length;
    /* How many of those frames are the race. For the scans that have to be
       bounded by the course and not by the pavement — see `pickRamps`, whose
       speed profile propagates backwards from its last entry, and
       `trackBounds`, whose bounding box seeds the coastline. */
    this.courseCount = N;
    /* The last station with road under it, as against `length`, which is the
       last station of the RACE. See the station convention at FINISH_BACK_M. */
    this.roadEnd = (frames.length - 1) * STEP;
    this.finishS = this.length - FINISH_BACK_M;
    this.gateS = this.length - GATE_BACK_M;
    this.sectors = [this.length / 3, (this.length * 2) / 3, this.length];

    /* The elevation card's ridge, and it spans the ROAD rather than the race.
       The card carries a marker for where the player is, and a marker that
       stops reporting a car which is still visibly moving is the defect the
       HUD's own strip comment argues against at length. So the run-off is on
       the card, the chequered bar stands over `finishS` instead of over the
       right-hand end of the ridge, and the dot keeps travelling past it while
       the car rolls to a halt. */
    this.profile = [];
    for (let i = 0; i < 160; i++) {
      const f = this.frameIndex((i / 159) * (this.count - 1));
      this.profile.push({ s: f.s, y: f.pos.y });
    }

    this.crossings = this._findCrossings();
  }

  /**
   * Authored road past the end of the race, so a car that crosses the flag at
   * 164 km/h can be stopped by its own brakes.
   *
   * WHY THIS IS NOT A LONGER STAGE, which is the one-line version of the same
   * idea and does not work. `length` is read by something like a hundred and
   * twenty siting expressions across this file and `world/environment.js` —
   * `field.track.length * 0.305` for the sea arch, `clamp(centre, 20,
   * field.track.length - 20)` for every boulder, `chapterAt(s / length)` for
   * every palette lookup. Growing it moves all of them, so the stage that
   * came back would be a different stage with the same seed, and the finish
   * assembly would have slid down with the road to leave exactly as little
   * run-off as before. So the race keeps its length and the pavement gets
   * longer than the race.
   *
   * What is appended is road, not an apron: the same eleven-column mesh, the
   * same berm profile, the same surface. It is allowed to bend and to fall,
   * and it is held to numbers that mean neither costs the driver anything —
   * see RUNOFF_CURV and RUNOFF_GRADE. Nothing here is scored, sited or
   * scanned; it is the one stretch of this stage that is simply drawn.
   */
  _appendRunoff(frames, seed, centreEnd) {
    const n = Math.round(this.runoff / STEP);
    if (n < 1) return;
    const join = frames[frames.length - 1];

    let heading = Math.atan2(join.tan.z, join.tan.x);
    const joinSlope = join.tan.y / (Math.hypot(join.tan.x, join.tan.z) || 1);

    /* Which way the bend goes: toward the basin centre, on exactly the test
       `chooseHand` uses. Not a style choice — the stage finishes on a coastal
       shelf and roughly half the seeds finish pointing along it, so a run-off
       free to pick its own hand can walk a hundred and twenty metres of road
       out over open water. Bending inland cannot do that. */
    const dx = join.pos.x - centreEnd.x, dz = join.pos.z - centreEnd.z;
    const rad = Math.hypot(dx, dz) || 1;
    const hx = Math.cos(heading), hz = Math.sin(heading);
    const inward = Math.sign(hx * (-dz / rad) - hz * (-dx / rad)) || 1;
    /* Its own stream, seeded off the stage's own seed. Drawing from `_build`'s
       `r` would work today and would silently re-roll the whole schedule the
       first time anything is added to `_plan` after it. */
    const bend = inward * RUNOFF_CURV * rand(rng(seed * 811 + 37)).f(0.5, 1);

    const pos = join.pos.clone();
    const first = frames.length;
    for (let k = 1; k <= n; k++) {
      const u = k / n;
      /* In over the first third, out over the last quarter, so the run-off
         arrives straight — there is nothing past the last frame to hold a
         curve against, and a road that ends mid-bend reads as broken. */
      const curv = bend * smoothstep(0, 0.34, u) * (1 - smoothstep(0.76, 1, u));
      /* Back-loaded, for the reason RUNOFF_GRADE sets out: the vertical
         curvature this easing implies costs the car v²·dslope/ds of load, and
         v² by the far end is a third of what it is at the join. */
      const slope = lerp(joinSlope, RUNOFF_GRADE, smoothstep(RUNOFF_EASE0, 1, u));

      heading += curv * STEP;
      const dy = slope * STEP;
      const horiz = Math.sqrt(Math.max(0, STEP * STEP - dy * dy));
      pos.x += Math.cos(heading) * horiz;
      pos.z += Math.sin(heading) * horiz;
      pos.y += dy;

      const f = new Frame();
      f.pos.copy(pos);
      f.s = this.length + k * STEP;
      f.curv = curv;
      f.grade = slope;
      f.el = null;
      f.bank = 0;
      f.width = lerp(join.width, RUNOFF_WIDTH, smoothstep(0, 0.55, u));
      f.bermL = lerp(join.bermL, RUNOFF_BERM, smoothstep(0, 0.5, u));
      f.bermR = lerp(join.bermR, RUNOFF_BERM, smoothstep(0, 0.5, u));
      frames.push(f);
    }

    /* Tangents last, by the same central difference the race uses, and it has
       to include the joining frame: its own tangent was the one-sided
       difference of the final segment, because there was nothing past it.
       Leaving that alone would put a normal discontinuity in the road exactly
       where the road now continues. It is thirty metres past the flag and the
       row it moves is a row of run-off, so what changes is one mesh row's
       shading rather than anything a car is driven through. `bank` at that
       station is already zero — the aprons are flattened before smoothing —
       so `right` is `flatRight` and the pose cannot rotate under the car. */
    for (let i = first - 1; i < frames.length; i++) {
      const f = frames[i];
      const a = frames[Math.max(0, i - 1)].pos;
      const b = frames[Math.min(frames.length - 1, i + 1)].pos;
      f.tan.subVectors(b, a).normalize();
      f.flatRight.crossVectors(f.tan, UP).normalize();
      f.right.copy(f.flatRight).applyAxisAngle(f.tan, f.bank);
      f.up.crossVectors(f.right, f.tan).normalize();
      if (f.up.y < 0) f.up.negate();
    }
  }

  /**
   * Where the stage passes over itself without enough air between the decks.
   *
   * A mountain road crossing its own footprint once, with a hundred metres of
   * drop between, is a landmark. Doing it four times with twenty metres of
   * separation is a knot — unreadable from the cockpit and worse from above.
   * This is the metric that made that difference measurable instead of a
   * matter of opinion, so the layout could be tuned against a number.
   */
  _findCrossings(minClear = 26) {
    const out = [];
    const N = this.count;
    const seg = (i) => [this.frames[i].pos, this.frames[i + 1].pos];
    for (let i = 0; i < N - 1; i += 2) {
      const [a1, a2] = seg(i);
      for (let j = i + 40; j < N - 1; j += 2) {
        const [b1, b2] = seg(j);
        // Cheap reject before the segment-intersection test.
        if (Math.abs(a1.x - b1.x) > 40 || Math.abs(a1.z - b1.z) > 40) continue;
        const d1x = a2.x - a1.x, d1z = a2.z - a1.z;
        const d2x = b2.x - b1.x, d2z = b2.z - b1.z;
        const den = d1x * d2z - d1z * d2x;
        if (Math.abs(den) < 1e-9) continue;
        const ex = b1.x - a1.x, ez = b1.z - a1.z;
        const t = (ex * d2z - ez * d2x) / den;
        const u = (ex * d1z - ez * d1x) / den;
        if (t < 0 || t > 1 || u < 0 || u > 1) continue;
        const dy = Math.abs(lerp(a1.y, a2.y, t) - lerp(b1.y, b2.y, u));
        if (dy < minClear) {
          out.push({ s1: +(i * STEP).toFixed(0), s2: +(j * STEP).toFixed(0), dy: +dy.toFixed(1) });
        }
      }
    }
    return out;
  }

  frameIndex(i) { return this.frames[clamp(Math.round(i), 0, this.count - 1)]; }

  /** Interpolated frame at arc length `s`. Hot path. */
  frameAt(s, out = null) {
    const t = clamp(s / STEP, 0, this.count - 1.0001);
    const i = Math.floor(t), k = t - i;
    const a = this.frames[i], b = this.frames[i + 1] || a;
    const f = out || new Frame();
    f.pos.copy(a.pos).lerp(b.pos, k);
    f.tan.copy(a.tan).lerp(b.tan, k).normalize();
    f.right.copy(a.right).lerp(b.right, k).normalize();
    f.up.copy(a.up).lerp(b.up, k).normalize();
    f.flatRight.copy(a.flatRight).lerp(b.flatRight, k).normalize();
    f.s = s;
    f.curv = lerp(a.curv, b.curv, k);
    f.bank = lerp(a.bank, b.bank, k);
    f.width = lerp(a.width, b.width, k);
    f.grade = lerp(a.grade, b.grade, k);
    f.bermL = lerp(a.bermL, b.bermL, k);
    f.bermR = lerp(a.bermR, b.bermR, k);
    return f;
  }

  pointAt(s, lat = 0, out = new THREE.Vector3()) {
    const f = this.frameAt(s, _scratch);
    return out.copy(f.pos).addScaledVector(f.right, lat);
  }

  /**
   * Exact station of the offset curve `lat` metres out, nearest `near`.
   *
   * `frameAt` lerps `frames[i].pos`, so the road this is inverting is a
   * polyline, and the nearest point on a segment is a dot product — there is
   * nothing here worth bisecting toward.
   */
  _stationAt(p, near, lat, span) {
    const last = this.count - 2;
    const i0 = clamp(Math.floor((near - span) / STEP), 0, last);
    const i1 = clamp(Math.ceil((near + span) / STEP), 0, last);
    let bestS = near, bestD = Infinity;
    for (let i = i0; i <= i1; i++) {
      const fa = this.frames[i], fb = this.frames[i + 1];
      _o1.copy(fa.pos).addScaledVector(fa.right, lat);
      _ab.copy(fb.pos).addScaledVector(fb.right, lat).sub(_o1);
      const len2 = _ab.lengthSq();
      const t = len2 > 1e-12
        ? clamp(_o2.subVectors(p, _o1).dot(_ab) / len2, 0, 1) : 0;
      const d = _o1.addScaledVector(_ab, t).distanceToSquared(p);
      if (d < bestD) { bestD = d; bestS = (i + t) * STEP; }
    }
    return bestS;
  }

  /**
   * Where on the road `p` is, as (s, lat).
   *
   * This is the inverse of the map `Car.step` rebuilds the car's position
   * through — `pointAt(s, lat)`, i.e. the offset curve `lat` metres out — and
   * it has to be the inverse of exactly that map and not of something nearby.
   *
   * It used to return the nearest point on the CENTRELINE, which is a
   * different curve as soon as `lat` is not zero, and the difference is not
   * academic. The centreline is a polyline with a kink at every sample, and
   * outside a convex kink every point in the vertex's normal wedge has the
   * vertex as its nearest point — a wedge |lat|·θ wide, which on a 39 m-radius
   * corner at 6 m off centre measures 0.44 m of road (.fix/pinwedge.mjs). The
   * rebuild then places the car back on the vertex's normal line, so the wedge
   * is not a speed bump the car drives over, it is an attractor with a fixed
   * point sitting in it: the same 0.13 m of travel is deleted 120 times a
   * second, forever, and the car is frozen in the world with the speedometer
   * reading 55. That is the "sometimes car stucks" report, and it is also why
   * `Car.s` was known to pin off-road and be untrustworthy as a distance.
   * Projecting onto the curve the car is actually on removes it: a point on a
   * polyline has a zero-width wedge, so the station tracks travel 1:1.
   *
   * A global sweep every frame for every car is wasted work: a car moves a few
   * metres between frames, so a coarse pass around the last known position
   * finds the neighbourhood. `hint` of −1 forces the global sweep, which
   * respawns and first-frame placement need.
   */
  project(p, hint = -1) {
    /* `roadEnd` and not `length`: this is asking where on the PAVEMENT a point
       is, and past the flag there are another hundred and twenty metres of it.
       Bounding the sweep at `length` was what pinned `s` for a car still
       travelling, which the ending's servo then read as a distance that had
       stopped closing. */
    const end = this.roadEnd;
    let lo = 0, hi = end;
    if (hint >= 0) { lo = hint - 90; hi = hint + 90; }
    let best = hint >= 0 ? clamp(hint, 0, end) : 0, bestD = Infinity;
    const coarse = hint >= 0 ? 4 : 12;
    for (let s = Math.max(0, lo); s <= Math.min(end, hi); s += coarse) {
      const d = this.frameAt(s, _scratch).pos.distanceToSquared(p);
      if (d < bestD) { bestD = d; best = s; }
    }
    /* The coarse pass only has to name the neighbourhood; the offset curve it
       should have been searching is not known until there is a `lat` to read,
       and a `lat` needs a station. Two passes settle it — the car is already
       sitting on the curve being solved for, so the first correction is the
       whole of it and the second only confirms. */
    let f = this.frameAt(best, _scratch);
    let lat = _v.subVectors(p, f.pos).dot(f.right);
    let s = best;
    for (let pass = 0; pass < 2; pass++) {
      s = clamp(this._stationAt(p, s, lat, coarse), 0, end);
      f = this.frameAt(s, _scratch);
      lat = _v.subVectors(p, f.pos).dot(f.right);
    }
    return {
      s, lat, height: _v.dot(f.up),
      width: f.width, dist: p.distanceTo(f.pos),
    };
  }
}

const _scratch = new Frame();

/**
 * Where buildGuardRail will decide it wants a rail, per frame.
 *
 * Factored out because the ramp scan has to know, and a scan that
 * approximated the rule would be scoring a station as rail-free on hope. A
 * rail crossing a ramp gets buried posts on the up-face and floating ones
 * past the lip; rampHeight is added to seat() as well, but the cheapest fix
 * is still to put the ramp somewhere there is no rail.
 */
function railWants(track) {
  const cliffNoise = noise1(77);
  const wants = new Int8Array(track.count);
  for (let i = 0; i < track.count; i++) {
    const f = track.frames[i];
    /* Still `length` and not `roadEnd`, so the run-off ships without a rail.
       Deliberate and measured: the rail is 11,196 triangles on seed 22 at
       roughly 2.4 a metre, the run-off's own terrain does not fall away past
       the flag on any of the fourteen seeds (tools/zyrunoff.mjs), and the one
       car that is ever out here is under a servo bringing it to a halt. */
    if (f.s < 30 || f.s > track.length - 50) continue;
    // Outside of the corner: a right turn (positive curvature) exposes the left.
    let side = 0;
    if (f.curv > 0.004) side = -1;
    else if (f.curv < -0.004) side = 1;
    else if (cliffNoise(f.s / 170) > 0.28) side = 1;
    if (side && (side > 0 ? f.bermR : f.bermL) > 0.55) wants[i] = side;
  }
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < track.count - 1; i++) {
      if (!wants[i] && wants[i - 1] && wants[i - 1] === wants[i + 1]) wants[i] = wants[i - 1];
    }
  }
  return wants;
}

/**
 * Where a ramp can actually go.
 *
 * Fixed stations are impossible on their face — the stages run 4,563 m to
 * 5,598 m — and fixed *fractions* measured just as badly. Scanned across all
 * fourteen canonical seeds, the count with a viable station within 45 m of a
 * given fraction runs 5/14 at 0.10 and then **zero out of fourteen** at 0.25,
 * 0.40 and 0.55. Those zeros are not noise: that band is Phase 2, the
 * switchback face, and a switchback structurally cannot host a ramp — there
 * is no approach straight enough and no landing that is not a corner. Ramps
 * are impossible through the switchbacks and always possible on the coastal
 * shelf, and where exactly on the shelf moves hundreds of metres between
 * seeds. Viability density varies more than five-fold across seeds too. So
 * this is a scan, in the same shortlist/score/veto shape as pickTunnel.
 *
 * It returns three when it can and is allowed to return two. Measured, the
 * last third of the stage has a positive-scoring station on 14/14 seeds, the
 * middle third on 9/14 and the first on 8/14. Two is the guarantee; three is
 * the common case.
 *
 * Sun exposure is a criterion rather than a hope, and that is the one thing
 * the numbers alone got wrong. The second-ranked site on seed 22 by pure
 * geometry — the widest road and the longest runout on the stage — is a
 * shadowed cut with cliff filling both sides of frame, where a car three
 * metres up has nothing to be silhouetted against. Spectacle is worth nothing
 * there. The sun is fixed, so this is one terrain profile query per candidate.
 */
export function pickRamps(track, field, coast, seed, opts = {}) {
  const { bore = null, sunDirection = null, solid = null, want = 3 } = opts;
  /* `courseCount` and not `count`: the speed profile below propagates
     BACKWARDS from its last entry, so run-off frames on the end of the array
     would feed a braking pass that reaches into the race and re-scores every
     candidate. Run-off cannot host a ramp anyway — the scan stops 260 m short
     of `L` — so the honest bound is the race. */
  const N = track.courseCount, L = track.length, F = track.frames;
  const G = 9.81;
  const GRIP = 0.86;             // what the AI plans for — driver.js
  const PAD_GAIN = 4.5;          // m/s the pad is worth by the lip

  /* A speed profile the field would actually drive: a corner limit, a
     backward pass for braking and a forward pass for what the engine and the
     grade can add. A bare sqrt(GRIP·g·R) overstates arrival speed at every
     candidate by about a quarter against a measured drive-in, because it
     never has to have slowed down for anything. */
  const v = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let peak = 0;
    for (let d = 0; d < 46; d += 6) {
      const f = track.frameAt(Math.min(F[i].s + d, L), _scratch);
      if (Math.abs(f.curv) > Math.abs(peak)) peak = f.curv;
    }
    const R = 1 / Math.max(Math.abs(peak), 1e-4);
    v[i] = Math.min(Math.sqrt(GRIP * G * Math.min(R, 900)), 52);
  }
  for (let i = N - 2; i >= 0; i--) {
    v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * 5.8 * STEP));
  }
  v[0] = Math.min(v[0], 8);
  for (let i = 1; i < N; i++) {
    const a = 3.4 - F[i].grade * G;
    v[i] = Math.min(v[i], Math.sqrt(Math.max(0, v[i - 1] * v[i - 1] + 2 * a * STEP)));
  }
  const vAt = (s) => v[clamp(Math.round(s / STEP), 0, N - 1)];

  const rails = railWants(track);
  const at = (s) => track.frameAt(clamp(s, 0, L - 1), _scratch);
  const yAt = (s) => at(s).pos.y;

  /* Sun elevation and azimuth, from the one light the stage is lit by. */
  let sunElev = 0, sunX = 0, sunZ = 0;
  if (sunDirection) {
    const h = Math.hypot(sunDirection.x, sunDirection.z) || 1;
    sunX = sunDirection.x / h; sunZ = sunDirection.z / h;
    sunElev = Math.atan2(sunDirection.y, h);
  }

  const maxCurv = (a, b) => {
    let m = 0;
    for (let s = a; s <= b; s += 3) m = Math.max(m, Math.abs(at(s).curv));
    return m;
  };
  const swing = (a, b) => {
    const p = at(a).pos.clone(), q = at(b).pos.clone();
    const cx = q.x - p.x, cz = q.z - p.z;
    const chord = Math.hypot(cx, cz) || 1;
    let worst = 0;
    for (let n = 1; n < 10; n++) {
      const m = at(a + (b - a) * n / 10).pos;
      worst = Math.max(worst, Math.abs((m.x - p.x) * cz - (m.z - p.z) * cx) / chord);
    }
    return worst;
  };

  const rows = [];
  /* Lip stations land on the mesh grid, so foot, lip and every control point
     of the profile are frame stations and the physics/mesh parity is exact. */
  for (let i = Math.ceil(420 / STEP); i * STEP < L - 260; i += 2) {
    const lip = i * STEP;
    const foot = lip - RAMP_UP_LEN;
    const pad0 = foot - PAD_BEFORE, pad1 = pad0 + PAD_LEN;
    if (pad0 < 140) continue;

    const speed = Math.min(vAt(foot) + PAD_GAIN, 56);
    /* The flight the model will actually produce. Vertical position is
       carried relative to the surface, so a flight is a parabola against the
       road rather than against the world and the air is 2·v₀/g whatever the
       profile downroad does. Measured, the road's own departure from its lip
       tangent over a 60 m flight is at most about 1.2 m either way, against a
       1.2–2.3 m apex — worth knowing, not worth modelling. */
    const air = 2 * speed * RAMP_LIP_SLOPE / G;
    const dist = air * speed;
    const land = lip + dist;
    if (land > L - 160) continue;

    const appCurv = maxCurv(pad0 - 40, foot);
    const appSwing = swing(pad0 - 40, foot);
    const landCurv = maxCurv(lip, land + 25);

    let runout = 0;
    for (let d = 0; d < 300; d += 3) {
      if (vAt(land + d) < speed * 0.80) break;
      runout = d;
    }

    let rail = 0, w = 99, landW = 99;
    for (let x = pad0; x <= land + 25; x += STEP) {
      if (rails[clamp(Math.round(x / STEP), 0, N - 1)]) rail = 1;
    }
    for (let x = foot - 6; x <= lip + 6; x += 3) w = Math.min(w, at(x).width);
    for (let x = land - 15; x <= land + 15; x += 3) landW = Math.min(landW, at(x).width);

    /* Convex is free height and a soft arrival; concave is a compression that
       cuts the jump short and slams the car into rising ground. */
    const sag60 = yAt(lip) + at(lip).grade * 60 - yAt(lip + 60);

    /* Cheap brow guard. Measured over all fourteen seeds the crest amplitude
       over a 110 m approach has a median and a p90 of 0.00 m and a maximum of
       0.53 m — the grade field is far too gentle to put a brow between the
       driver and anything this far away, so visibility here is essentially
       free. Kept as a guard, not as a budget: this is one interpolation per
       sample, not the tunnel's eight terrain queries. */
    let brow = 0;
    {
      const a = Math.max(0, lip - 110);
      for (let n = 1; n < 12; n++) {
        const u = n / 12;
        brow = Math.max(brow, yAt(a + (lip - a) * u) - (yAt(a) + (yAt(lip) - yAt(a)) * u));
      }
    }

    /* How much room the terrain leaves beside the road, as a cheap prefilter
       for the boom test below — the expensive one only runs on a shortlist. */
    let gap = 99;
    if (field) {
      for (const x of [foot, lip, land]) {
        /* wallDist is measured from the road edge, which is where the boom
           has to find room to stand. */
        for (const side of [-1, 1]) gap = Math.min(gap, field.profile(x, side).wallDist);
      }
    }

    const inBore = bore
      && lip > bore.s0 - 90 - (bore.fade ?? 16) && foot < bore.s1 + 40 + (bore.fade ?? 16);

    rows.push({
      lip, foot, pad0, pad1, land: +land.toFixed(1),
      speed: +speed.toFixed(1), air: +air.toFixed(2), dist: +dist.toFixed(1),
      appCurv, appSwing, landCurv, runout, rail, w, landW,
      sag60: +sag60.toFixed(2), brow: +brow.toFixed(2), gap: +gap.toFixed(1),
      grade: +at(lip).grade.toFixed(3), inBore: inBore ? 1 : 0,
    });
  }

  /* Two kinds of rejection, and the difference matters because two ramps is a
     guarantee and three is not.
     A veto is a station where the ramp would be wrong rather than merely
     worse: launching into a corner, launching out of a corner, under the
     mountain, or a flight that is not a jump or cannot be landed. Nothing
     relaxes those. Everything else — a short runout, a narrow landing, a rail
     to climb over, a compression past the lip — is a preference, and on a
     stage that has no clean site anywhere a workmanlike ramp is better than
     the missing half of the mechanic. */
  const scored = rows.map(r => {
    const veto = r.appCurv > 0.0060       // approach must be near-straight
      || r.landCurv > 0.0075              // landing must not be a corner
      || r.appSwing > 6
      || r.inBore
      /* Both bounds moved with the lip. The floor is still "a car that
         dribbled over this is not jumping"; the ceiling is still "this cannot
         be landed", and both are read off the same 2·v₀/g the profile now
         produces, which is a shade over twice what it was. */
      || r.air < 1.20                     // not a jump
      || r.air > 2.40;                    // unlandable
    let score = 0;
    if (r.brow > 1.4) score -= 400;
    if (r.rail) score -= 600;
    if (r.runout < 80) score -= 500;
    /* 9.2 m is the bar, not 10.5. The ramp is full road width so it fits any
       road the car fits on; what width buys is room to correct on landing,
       and the stage's own pinch floor is 8.4 m. */
    if (r.w < 9.2) score -= 300;
    if (r.landW < 9.2) score -= 300;
    if (r.sag60 < -0.6) score -= 250;
    score += r.air * 60 + Math.min(r.runout, 200) * 0.5 + Math.min(r.gap, 20) * 4
      - r.appCurv * 12000 - r.landCurv * 14000 - r.brow * 40 - r.appSwing * 6;
    return { ...r, veto, score: +score.toFixed(0), lit: 0, boom: 99 };
  }).filter(r => !r.veto).sort((a, b) => b.score - a.score || a.lip - b.lip);

  /* ---- the two expensive criteria, on a shortlist only -----------------
     Both are raycasts through the terrain proxy, and both are here rather
     than in the loop above for the same reason pickTunnel keeps hiddenCount
     out of its own: they are the ones that cost real work, and the cheap
     terms have already narrowed the field by two orders of magnitude.

     The boom is the pullback the camera actually asks for while the car is in
     the air — 10.9 m astern, 3.1 m up. Clear on the stage's own seed by a
     metre, which is exactly the kind of thing that is true on one seed and
     false on the next, so it is measured rather than assumed. It used to be
     13.4 m astern and 5.5 m up: both the lift and half the extension were
     measured subtracting from the very separation they existed to show, and
     ChaseCamera has dropped them.

     Sun exposure decides whether the jump is worth looking at. The
     second-best site on seed 22 by every geometric measure is a shadowed cut
     where a car three metres up has nothing behind it; ranking it above an
     equally clean lit station is the mistake this term exists to prevent.
     A hit further than 200 m along the sun ray cannot shade the car — the
     shadow camera's near plane is 40 m from a light 268 m away — so beyond
     that it is a headland, not shade. */
  const BOOM_BACK = 9.9, BOOM_UP = 3.1 - 1.2, BOOM_SKIN = 0.55;
  const _o = new THREE.Vector3(), _dir = new THREE.Vector3();
  const rays = (r) => {
    if (r._rayed) return r;
    r._rayed = true;
    if (!solid) { r.lit = 1; r.boom = 99; return r; }
    /* Sampled at the lip and again half way down the flight, and the darker
       of the two wins. The lip alone was the right test when a flight was
       35 m long and the apex was still more or less over the lip; at 90-120 m
       the car spends its whole airborne second somewhere else entirely, and
       on seed 22 that somewhere was a cutting with cliff filling both sides
       of frame while the lip itself scored fully lit. */
    let sunFree = 400;
    for (const x of [r.lip, r.lip + r.dist * 0.5]) {
      const f = at(x);
      _o.copy(f.pos).addScaledVector(f.up, 3.0);
      sunFree = Math.min(sunFree, sunDirection
        ? solid.raycast(_o.x, _o.y, _o.z, sunX * Math.cos(sunElev), Math.sin(sunElev),
          sunZ * Math.cos(sunElev), 400, 0.8)
        : 400);
    }
    r.sunFree = +Math.min(sunFree, 400).toFixed(0);
    r.lit = sunFree > 200 ? 1 : 0;

    let boom = 99;
    for (const x of [r.lip, r.land]) {
      const g2 = at(x);
      _o.copy(g2.pos).addScaledVector(g2.up, 1.2);
      _dir.copy(g2.tan).negate().multiplyScalar(BOOM_BACK);
      _dir.y += BOOM_UP;
      const len = _dir.length();
      _dir.multiplyScalar(1 / len);
      const d = solid.raycast(_o.x, _o.y, _o.z, _dir.x, _dir.y, _dir.z,
        len + BOOM_SKIN + 1, 0.8);
      boom = Math.min(boom, d - (len + BOOM_SKIN));
    }
    r.boom = +boom.toFixed(2);
    return r;
  };

  /* Best in each third, so the ramps are spread down the descent rather than
     clustered wherever the road happens to be widest, then fill from the
     whole stage if a third had nothing. */
  const picked = [];
  const clearOf = (r) => !picked.some(p =>
    Math.abs(p.lip - r.lip) < 260 || Math.abs(p.land - r.lip) < 200
      || Math.abs(r.land - p.lip) < 200);
  const bestOf = (list) => {
    let best = null, tested = 0;
    for (const r of list) {
      if (tested >= 20) break;
      rays(r); tested++;
      if (r.boom < 0) continue;                 // the pullback would be clipped
      const v = r.score + r.lit * 120;
      if (!best || v > best.score + best.lit * 120) best = r;
    }
    return best;
  };
  const inThird = (r, k) => r.lip >= L * (k / 3) && r.lip < L * ((k + 1) / 3);
  for (let k = 0; k < 3 && picked.length < want; k++) {
    const best = bestOf(scored.filter(r => r.score > 0 && inThird(r, k) && clearOf(r)));
    if (best) picked.push(best);
  }
  while (picked.length < want) {
    const best = bestOf(scored.filter(r => r.score > 0 && clearOf(r)));
    if (!best) break;
    picked.push(best);
  }
  /* Two is the guarantee. Where the whole stage scored negative — a layout
     with no clean site anywhere — take the least bad one rather than ship a
     stage with a single ramp on it. */
  while (picked.length < 2) {
    const best = bestOf(scored.filter(clearOf));
    if (!best) break;
    picked.push(best);
  }
  picked.sort((a, b) => a.lip - b.lip);
  picked.forEach((r, k) => { r.index = k; delete r._rayed; });
  return picked;
}

/* ------------------------------------------------------------------ */
/*  Geometry                                                           */
/* ------------------------------------------------------------------ */

/**
 * The driving surface.
 *
 * Eleven columns across rather than two triangles, because the surface is not
 * flat-coloured: worn tyre lines sit where cars actually drive, the shoulders
 * fade into the grassy verge, and a cel shader has no gradients in which to hide
 * banding — so the colour has to come from geometry it can quantise cleanly.
 */
/* The road inside a tunnel is not the road outside it, and the reason is
 * measurable rather than aesthetic.
 *
 * Open-road albedo here deliberately spans two rungs of the value ladder —
 * that is what stops the surface reading as a dead slab. Under a mountain it
 * backfires. The interior is a single shadowed surface, so the only thing the
 * sun's shadow can do is knock the upper population down onto the lower one:
 * measured at mid-bore, 95% of the pixels the shadow left untouched were
 * already on rung 2 while 66% of the ones it moved started on rung 4. Half the
 * floor changed and half did not, and the result reads as a mountain casting a
 * ragged, holed shadow onto its own tunnel.
 *
 * So the bore gets its own floor: the same geometry, blended most of the way to
 * one flat, dark tone, easing in over the last few metres outside each portal
 * so there is no seam at the mouth. Repair patches go with it, which also
 * settles their other problem — a pale chippings scar is a road feature in
 * daylight and a puddle of snow in a dark tunnel.
 */
function boreFloorFactor(s, bore) {
  if (!bore) return 0;
  const { s0, s1, fade = 16 } = bore;
  if (s < s0 - fade || s > s1 + fade) return 0;
  const inAt = smoothstep(s0 - fade, s0 + fade * 0.35, s);
  const outAt = 1 - smoothstep(s1 - fade * 0.35, s1 + fade, s);
  return Math.min(inAt, outAt);
}

export function buildRoad(track, { columns = 11, bore = null } = {}) {
  const N = track.count;
  const verts = new Float32Array(N * columns * 3);
  const uvs = new Float32Array(N * columns * 2);
  const cols = new Float32Array(N * columns * 3);
  const idx = new Uint32Array((N - 1) * (columns - 1) * 6);

  /* The road starts hue-neutral and slightly warm. Golden-hour shade already
     cools neutral surfaces; pre-cooling the albedo made this largest surface
     land navy and compete with the ocean. */
  /* Three tones for the surface, about a rung of the value ladder either side
     of the road colour, plus the green verge at the shoulder.

     The lane-line reading was never really about contrast — it was about
     contrast that never varied. A quantised surface only shows detail that
     crosses a step, so dropping the rut below a rung does not soften it, it
     deletes it, and the road becomes one dead slab with a car parked on it.
     What has to change is coherence, not amplitude: keep enough separation
     that worn ground and blown dust do cross a step, and drive them from
     fields that vary across the road as well as along it, so what crosses is
     a patch rather than a stripe. */
  const surface = new THREE.Color();
  const base = new THREE.Color(0x55514d);
  const shade = new THREE.Color(0x292a2b);   // compacted aggregate in damp hollows
  /* Salt-worn aggregate and wheel polish, and it used to be 0x5b656f — a pale
     neutral grey a full 2.14x the base's linear luminance.
     Two things were wrong with that and they are the same thing. Measured on
     a finished landing frame, the road's luma ran 0.334 at the median and
     0.520 at the ninetieth percentile at a mean saturation of 0.093: a tenth
     of the road sitting a whole rung above the rest of it with no chroma to
     explain why. A smooth noise field crossing a rung boundary near the middle
     of its range does not read as wear, it reads as something spilled, because
     the boundary turns a gradient into a hard edge in an arbitrary place.
     And it is the worst possible neighbour for the landing dust, which is
     thrown at this surface in far greater quantity now the ramps are real.
     The wildflowers had this exact defect and it was fixed the same way: the
     pale flower sat at 0.96 inside the dust's own 0.79-0.93 band and moved to
     a chromatic lilac-blue at 0.65 — hue instead of value.
     So this is cool where the base is warm, and only 1.52x its linear
     luminance instead of 2.14x. The ladder quantises luminance and carries
     chroma through untouched, which means hue contrast is the one kind of
     detail it cannot delete. The strongest patches still cross to the rung
     above — the road is not meant to be a dead slab and dropping everything
     below a rung is how it becomes one — but they now have to be nearly at
     full strength to do it instead of a little over half, and when they get
     there they are stone-blue rather than a bright neutral blotch. */
  const pale = new THREE.Color(0x5b656f);
  const verge = new THREE.Color(0x78975a);
  /* Cool, so it reads as stone-lined rather than as the same tarmac with the
     lights off, and low enough that a lit sample and a shadowed one both land
     on the bottom two rungs instead of straddling four of them. */
  const boreFloor = new THREE.Color(0x363d44);
  const grain = noise1(991);
  const rutN = noise1(1201);       // how worn the wheel track is, along the stage
  const wanderN = noise1(1307);    // where it sits, across the road
  const driftN = noise1(1409);     // how far the shoulder has crept in
  /* Genuinely two-dimensional, unlike everything else on this surface. A 1D
     field offset by the lateral coordinate is the same field sheared, so its
     features cross the road at a fixed shallow angle and it draws long
     diagonals — the highway problem again with a slight lean on it. */
  const patchN = noise2(1409);     // dust and hardpack, in patches
  const microN = noise2(1703);     // near-field chips at the road mesh's 3 m limit

  let vi = 0, ui = 0, ci = 0, ii = 0;
  for (let i = 0; i < N; i++) {
    const f = track.frames[i];
    const hw = f.width * 0.5;
    /* The ramp is a height term on rows this loop already emits, on the road's
       own 3 m grid. No new rows, no new columns — the ramp bodies are free. */
    const ramp = track.rampHeight(f.s, 0);
    const underRock = boreFloorFactor(f.s, bore) * 0.82;
    /* Per side, on independent phases. A rut held at a fixed offset and a
       fixed strength is an extrusion, and two of them are a carriageway — the
       thing that makes a wheel track read as worn rather than painted is that
       it wanders, fades out where the surface is hard, and never quite agrees
       with the one on the other side. Sampled per frame, so all of it varies
       along the stage at 3 m and none of it costs anything at run time. */
    const wear = [0, 1].map(k => clamp(
      0.08 + rutN(f.s / 15 + k * 311) * 0.88 + rutN(f.s / 5.2 + k * 127) * 0.58,
      0, 0.94,
    ));
    const line = [0, 1].map(k => clamp(
      0.34 + wanderN(f.s / 13 + k * 211) * 0.2
        + wanderN(f.s / 4.7 + k * 83) * 0.07,
      0.15, 0.59,
    ));
    /* How far the loose verge aggregate has crept in, also per side. Held at a
       constant strength it put a pale stripe of constant width down both
       edges — the same defect as the ruts, arrived at from the other side. */
    const shoulder = [0, 1].map(k => clamp(
      0.40 + driftN(f.s / 25 + k * 407) * 0.5, 0.04, 0.82));

    for (let c = 0; c < columns; c++) {
      const u = c / (columns - 1);
      const lat = (u - 0.5) * 2;
      const side = lat >= 0 ? 1 : 0;
      const amp = wear[side], ctr = line[side];
      /* The crown, the ripple and the ruts all come from roadRelief now — the
         ruts are cut into the surface rather than painted on it, and without
         that relief there is no shadow terminator anywhere on the road and the
         colour banding alone reads as a texture smear. It is shared with the
         paint because the paint has to sit on this surface and cannot do that
         from a copy of half of it. The wear and wander fields are still needed
         locally: the colour below is driven by the same numbers as the relief,
         which is what keeps a trough dark where it is deep. */
      const h = roadRelief(f.s, lat) + ramp;
      verts[vi++] = f.pos.x + f.right.x * lat * hw + f.up.x * h;
      verts[vi++] = f.pos.y + f.right.y * lat * hw + f.up.y * h;
      verts[vi++] = f.pos.z + f.right.z * lat * hw + f.up.z * h;
      uvs[ui++] = u * 3.0; uvs[ui++] = f.s / 9.0;

      /* Patchy tone, at two scales, varying across the road as well as along
         it. This is what stops the road being a ribbon: every other source of
         variation here runs parallel to the kerb, and anything that runs
         parallel to the kerb reads as markings. */
      const patch = patchN(f.s / 14, lat * 3.4 + 11) * 0.75
                  + patchN(f.s / 5.2 + 37, lat * 6.5 + 3) * 0.55
                  + microN(f.s / 2.8 + 91, lat * 10.5 + 17) * 0.35 - 0.83;
      surface.copy(base);
      if (patch > 0) surface.lerp(pale, Math.min(patch, 1) * 0.86);
      else surface.lerp(shade, Math.min(-patch, 1) * 0.86);

      /* The long fields describe wear zones; this field is the aggregate the
         orbit camera can actually resolve. Its 2-D cells are only a few metres
         across and have enough authored range to survive road-grey's ladder. */
      const aggregate = microN(f.s / 3.6 + 217, lat * 9.3 + 5) * 2 - 1;
      if (aggregate > 0.16) surface.lerp(pale, (aggregate - 0.16) * 0.68);
      else if (aggregate < -0.16) surface.lerp(shade, (-aggregate - 0.16) * 0.64);

      const rut = Math.exp(-Math.pow((Math.abs(lat) - ctr) * 11.0, 2)) * amp;
      const rutBreak = 0.2 + microN(f.s / 4.2 + side * 53, lat * 8.5 + 29) * 0.8;
      surface.lerp(pale, rut * rutBreak * 0.22);

      /* Held to the last sixth of the half-width. At 0.66 the verge reached a
         third of the way in, so both edges of the road carried a stripe far
         lighter than anything either side of it — it read as a seam between
         two meshes rather than as a shoulder. */
      const edge = smoothstep(0.84, 1.0, Math.abs(lat));
      surface.lerp(verge, edge * shoulder[side]);

      const chip = grain(f.s / 3.2 + c * 19.7);
      if (chip > 0.38) surface.lerp(pale, (chip - 0.38) * 0.32);
      else if (chip < -0.38) surface.lerp(shade, (-chip - 0.38) * 0.28);
      if (underRock > 0) surface.lerp(boreFloor, underRock);
      const speckle = 1 + grain(f.s / 4.6 + c * 7.7) * 0.025;
      cols[ci++] = surface.r * speckle;
      cols[ci++] = surface.g * speckle;
      cols[ci++] = surface.b * speckle;
    }
  }
  for (let i = 0; i < N - 1; i++) {
    for (let c = 0; c < columns - 1; c++) {
      /* Columns run along +right, rows along +tan, and right × tan is +up, so
         (a,b,d) is the order that puts the front face skyward. This was (a,d,b)
         to compensate for a `right` vector that pointed left; with the basis
         corrected that compensation inverted every triangle on the road, which
         showed up not as an invisible road but as a road that quietly stopped
         receiving shadows. */
      const a = i * columns + c, b = a + 1, d = a + columns, e = d + 1;
      idx[ii++] = a; idx[ii++] = b; idx[ii++] = d;
      idx[ii++] = b; idx[ii++] = e; idx[ii++] = d;
    }
  }

  /* Flush aggregate speckle, not debris. Compact silhouettes stay embedded in
     the surface; a minority now cross the road-grey ladder so the near camera
     does not quantise every fleck back into one flat value. */
  const detailSpacing = 3.2;
  const detailCount = Math.floor(track.length / detailSpacing);
  /* Resurfacing. The lower two fifths of nearly every frame is the road and
     nothing else, and the flecks above are all sub-metre — at the scale the
     camera actually sees this surface they average back into the base grey
     before they reach the ladder. A patch is metres across: a strip that was
     dug up and refilled, a skin of newer binder over a crack, a scab of
     chippings. Those are the features on a real hill road that you can see
     from a car, and each one is four triangles. */
  const patchSpacing = 11;
  const patchCount = Math.floor(track.length / patchSpacing);
  /* Paint. A ramp and a boost pad both have to be readable from far enough
     back to do something about them, and neither is legible as a shape: the
     ramp is 0.9 m over 18 m, which is a nothing gradient at the distance you
     need to see it, and the pad is flat by definition. So they are read as
     markings, and the markings are the same four triangles per chevron the
     patches already are. */
  const decorQuads = track.ramps.length * DECOR_QUADS;
  const extra = detailCount * 3 + patchCount * 6 + decorQuads * 4;
  const finalVerts = new Float32Array(verts.length + extra * 3);
  const finalUvs = new Float32Array(uvs.length + extra * 2);
  const finalCols = new Float32Array(cols.length + extra * 3);
  const finalIdx = new Uint32Array(idx.length + detailCount * 3 + patchCount * 12 + decorQuads * 6);
  finalVerts.set(verts); finalUvs.set(uvs); finalCols.set(cols); finalIdx.set(idx);
  const detailR = rand(rng(track.seed * 1709 + 83));
  const detailColor = new THREE.Color();
  const centre = new THREE.Vector3();
  let dv = verts.length, du = uvs.length, dc = cols.length, di = idx.length;
  let vertex = verts.length / 3;
  for (let n = 0; n < detailCount; n++) {
    const s = clamp((n + detailR.f(0.12, 0.88)) * detailSpacing, 8, track.length - 8);
    const f = track.frameAt(s);
    const lat = detailR.f(-0.72, 0.72);
    const size = detailR.f(0.07, 0.2);
    const length = size * detailR.f(0.68, 1.35);
    const width = size * detailR.f(0.68, 1.35);
    const yaw = detailR.f(-Math.PI, Math.PI);
    const along = f.tan.clone().multiplyScalar(Math.cos(yaw))
      .addScaledVector(f.right, Math.sin(yaw)).normalize();
    const across = f.right.clone().multiplyScalar(Math.cos(yaw))
      .addScaledVector(f.tan, -Math.sin(yaw)).normalize();
    centre.copy(f.pos).addScaledVector(f.right, lat * f.width * 0.5)
      .addScaledVector(f.up,
        -Math.pow(Math.abs(lat), 3) * 0.5 + 0.008 + track.rampHeight(s, 0));
    const points = [
      centre.clone().addScaledVector(along, -length * detailR.f(0.35, 0.65))
        .addScaledVector(across, -width * detailR.f(0.28, 0.58)),
      centre.clone().addScaledVector(along, length * detailR.f(0.35, 0.65))
        .addScaledVector(across, -width * detailR.f(0.12, 0.4)),
      centre.clone().addScaledVector(along, -length * detailR.f(-0.18, 0.25))
        .addScaledVector(across, width * detailR.f(0.35, 0.65)),
    ];
    if (detailR.chance(0.32)) {
      if (detailR.chance(0.6)) {
        detailColor.copy(shade).lerp(base, detailR.f(0.16, 0.34));
      } else {
        detailColor.setHex(0x99938a).lerp(base, detailR.f(0.08, 0.24));
      }
    } else {
      const target = detailR.chance(0.58) ? shade : pale;
      detailColor.copy(base).lerp(target, detailR.f(0.05, 0.16));
    }
    detailColor.lerp(boreFloor, boreFloorFactor(s, bore) * 0.82);
    for (const point of points) {
      finalVerts[dv++] = point.x; finalVerts[dv++] = point.y; finalVerts[dv++] = point.z;
      finalUvs[du++] = 0; finalUvs[du++] = 0;
      finalCols[dc++] = detailColor.r; finalCols[dc++] = detailColor.g; finalCols[dc++] = detailColor.b;
    }
    finalIdx[di++] = vertex; finalIdx[di++] = vertex + 2; finalIdx[di++] = vertex + 1;
    vertex += 3;
  }

  const patchColor = new THREE.Color();
  const skin = new THREE.Color(0x3d3c3b);      // fresh binder over a dug-out strip
  /* Kept close to the road's own value on purpose. The posterise ladder is
     unforgiving here: a chippings scar only 0.6 of a stop above the tarmac
     still crossed a rung boundary and came back as a white blotch. */
  /* Loose chippings rolled into the seam. Moved into the same cool family as
     `pale` above, for the same reason and with the same arithmetic: a repair
     scar is the one feature on this road that is cut with a hard edge, so it
     is the one that can least afford to be separated from the tarmac by value
     alone. It is barely brighter than the road now and is told apart from it
     by hue. */
  const chip = new THREE.Color(0x606b76);
  for (let n = 0; n < patchCount; n++) {
    const s = clamp((n + detailR.f(0.1, 0.9)) * patchSpacing, 12, track.length - 12);
    const f = track.frameAt(s);
    const hw = f.width * 0.5;
    /* Rectangular in the road's own frame, because that is how a patch is cut,
       but with each corner pulled independently so no two are the same shape
       and none of them is axis-aligned enough to read as a decal. */
    const lat = detailR.f(-0.82, 0.82);
    /* Sized and valued as repair, not as spillage. At 2–9 m long and up to
       5 m across, with a third of them mixed most of the way to a pale chip
       grey, these read as patches of snow on the tarmac. A real skin patch is
       a metre or two of darker binder; the chippings scar is the exception and
       it is never lighter than the road it sits in by much. */
    const along = detailR.f(0.8, 2.9);
    const across = detailR.f(0.45, 1.5) / hw;
    const skew = detailR.f(-0.35, 0.35);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const first = vertex;
    if (detailR.chance(0.78)) {
      patchColor.copy(skin).lerp(base, detailR.f(0.12, 0.5));
    } else {
      patchColor.copy(chip).lerp(base, detailR.f(0.6, 0.92));
    }
    /* Harder than the surface itself. A patch is only visible because it
       differs from the road, so leaving it at the same blend as the road
       preserves exactly the contrast that made it read as spilled paint under
       the mountain. */
    patchColor.lerp(boreFloor, boreFloorFactor(s, bore) * 0.94);
    for (const [ca, cb] of corners) {
      const dl = clamp(lat + cb * across * detailR.f(0.72, 1.15) + ca * skew * across, -0.97, 0.97);
      const ds = ca * along * detailR.f(0.78, 1.2);
      /* Through roadPoint for the same reason the markings are: a repair patch
         that models the crown and not the ripple is a repair patch with holes
         in it. These are road-coloured, so the burial was invisible rather than
         absent. */
      const p = roadPoint(track, s + ds, dl, 0.012);
      finalVerts[dv++] = p.x; finalVerts[dv++] = p.y; finalVerts[dv++] = p.z;
      finalUvs[du++] = 0; finalUvs[du++] = 0;
      finalCols[dc++] = patchColor.r; finalCols[dc++] = patchColor.g; finalCols[dc++] = patchColor.b;
    }
    finalIdx[di++] = first; finalIdx[di++] = first + 2; finalIdx[di++] = first + 1;
    finalIdx[di++] = first; finalIdx[di++] = first + 3; finalIdx[di++] = first + 2;
    vertex += 4;
  }

  /* Markings. Everything below is a band in the road's own (station, lateral)
     space: a quad whose two ends can sit at different stations, which is all a
     chevron arm is. Lateral runs low to high so the winding matches the
     patches above and the markings are not backfacing on one side of the
     road. */
  const band = (sA, latA, sB, latB, back, lift, color) => {
    const first = vertex;
    for (const p of markCorners(track, sA, latA, sB, latB, back, lift)) {
      finalVerts[dv++] = p.x; finalVerts[dv++] = p.y; finalVerts[dv++] = p.z;
      finalUvs[du++] = 0; finalUvs[du++] = 0;
      finalCols[dc++] = color.r; finalCols[dc++] = color.g; finalCols[dc++] = color.b;
    }
    finalIdx[di++] = first; finalIdx[di++] = first + 2; finalIdx[di++] = first + 1;
    finalIdx[di++] = first; finalIdx[di++] = first + 3; finalIdx[di++] = first + 2;
    vertex += 4;
  };
  /* Two arms, meeting on the crown and pointing the way the car is going.
     Through paintBand, which is what stops an arm breaking into disconnected
     chips at mid range: an arm crosses four of the road's columns, and a single
     quad across four columns dips under two of them. */
  const chevron = (s, reach, arm, color) => {
    paintBand(band, s, -reach, s + arm, 0, CHEVRON_W, MARK_H, color);
    paintBand(band, s + arm, 0, s, reach, CHEVRON_W, MARK_H, color);
  };
  /* Alternating, because a hazard marking is a stripe pattern and one colour
     repeated five times is a row of arrows. */
  const rampMark = [new THREE.Color(RAMP_MARK_A), new THREE.Color(RAMP_MARK_B)];
  const lipMark = new THREE.Color(LIP_MARK);
  for (const r of track.ramps) {
    for (let k = 0; k < RAMP_CHEVRONS; k++) {
      chevron(r.foot + 2.5 + k * 3.2, CHEV_REACH, CHEV_ARM, rampMark[k & 1]);
    }
    /* The lip itself, because the one thing the driver has to judge is where
       the road stops being under the car. */
    crossBand(band, r.lip, LIP_HALF, LIP_LONG, MARK_H, lipMark);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(finalVerts, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(finalUvs, 2));
  g.setAttribute('color', new THREE.BufferAttribute(finalCols, 3));
  /* Trimmed to what was written. The marking allocation is an upper bound —
     see paintQuads — and an index buffer padded with zeroes is a thousand
     degenerate triangles at vertex 0, which draw nothing and count anyway. */
  g.setIndex(new THREE.BufferAttribute(finalIdx.subarray(0, di), 1));
  /* Derived, not the surface up-vector. Hardcoding up was fine when the road
     was a developable ribbon, but it makes the crown and the carved ruts
     invisible to the lighting — the relief is there in the mesh and shades
     exactly as if it were not. */
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/**
 * The boost pad, on its own mesh so that it can be self-lit.
 *
 * "A glowing strip on the road" is the brief, and the first pass answered it
 * with a teal rectangle painted into the road's vertex colours. Measured
 * through the finished frame it sat on the same value family as the tarmac,
 * because that is what a lit surface does: whatever albedo it is given, the
 * sun angle and the seven-rung ladder decide which rung it lands on, and a
 * flat piece of road lands on the road's rung.
 *
 * The cel pipeline has one honest way to say "self-lit" and it is
 * `unlitCelMaterial`: the lighting term is dropped and the ladder with it, so
 * the colour authored here is the colour that reaches the frame, untouched.
 * That is literally a rung of its own — it is off the ladder. Lit asphalt
 * draws around 0.33 of full luma in the finished frame; this draws at 0.77
 * and holds its hue while it does it, which is the difference between paint
 * and a light. Nothing in render/ is touched to get it.
 *
 * Geometry is identical to what buildRoad used to emit for these quads, and
 * comes from the same markCorners, so moving the pad onto another material
 * could not quietly move the pad. Twenty quads a site — twelve of them the
 * strips the ground rectangle is cut into, for the crown.
 */
export function buildRampPaint(track) {
  if (!track.ramps.length) return null;
  const verts = [], cols = [], idx = [];
  const glow = new THREE.Color(PAD_GLOW);
  const glowMark = new THREE.Color(PAD_GLOW_MARK);
  const band = (sA, latA, sB, latB, back, lift, color) => {
    const first = verts.length / 3;
    for (const p of markCorners(track, sA, latA, sB, latB, back, lift)) {
      verts.push(p.x, p.y, p.z);
      cols.push(color.r, color.g, color.b);
    }
    idx.push(first, first + 2, first + 1, first, first + 3, first + 2);
  };
  const core = new THREE.Color(PAD_CORE);
  for (const r of track.ramps) {
    crossBand(band, r.pad1, PAD_HALF, PAD_LEN, GROUND_H, glow);
    /* The core: a second, hotter pass down the middle third, one rung of paint
       higher so it cannot z-fight the strip it sits on. This is the "glowing"
       half of the brief and the strip alone was not carrying it — a single flat
       colour, however bright, reads as paint, because paint is what a single
       flat colour is. A light has a hot centre and a cooler edge, and two unlit
       tones are the cheapest honest way to say so on a pipeline whose lighting
       term is switched off here. */
    paintBand(band, r.pad1, -PAD_CORE_HALF, r.pad1, PAD_CORE_HALF,
      PAD_LEN, GROUND_H + 0.004, core);
    for (const [s, reach, arm] of padChevrons(r)) {
      paintBand(band, s, -reach, s + arm, 0, CHEVRON_W, MARK_H, glowMark);
      paintBand(band, s + arm, 0, s, reach, CHEVRON_W, MARK_H, glowMark);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/**
 * Vertical signage at the pad and at the lip.
 *
 * This is the item the first pass deferred, and deferring it was the single
 * biggest defect in the system. Measured on that build, the pad's projected
 * area on approach ran 2 px² at 130 m, 1 px² at 100 m, 3 px² at 75 m and
 * 21 px² at 50 m; it only became legible inside about 25 m, which is half a
 * second at 176 km/h. Widening the chevrons and raising their contrast had
 * already been tried and could not work, because the problem is not contrast.
 * A flat marking seen at a shallow angle has almost no vertical extent, and
 * nothing painted on the road can subtend more than a few square pixels past
 * 50 m however bright it is. It is a geometry problem, so this is a geometry
 * answer.
 *
 * Two posts a side carrying a striped board, at the pad and again at the lip.
 * Four boards a site, standing on the berm crest — the same seat the guard
 * rail uses, including its ramp-height term, so a board at the lip rides up
 * with the lip instead of being swallowed by it.
 *
 * On the berm crest rather than at the road edge for two reasons. It is where
 * roadside furniture on this stage already stands, so the chase camera has
 * been flying past objects at exactly this offset for the whole project; and
 * it keeps the boards out of the corridor the boom swings through, which is
 * the risk that made this worth deferring in the first place. Measured rather
 * than assumed — tools/camwatch.mjs and tools/camprobe.mjs.
 *
 * Self-lit for the same reason the pad is: a warning board the sun has to
 * reach is a warning board that goes quiet in every cutting on the stage, and
 * the entire point of it is to be seen from 130 m in whatever light.
 *
 * Twenty-six triangles a board — ten a post, six for three stripes — so 312
 * on a three-ramp stage. The material is DoubleSide, which is what lets that
 * be twenty-six rather than fifty-two: the two sides of the road are mirror
 * images of each other, so any winding that faces outward on one faces inward
 * on the other, and the alternative to a two-sided material is emitting every
 * face twice.
 */
export function buildRampSigns(track) {
  if (!track.ramps.length) return null;

  const POST_HALF = 0.09;      // square section, metres
  const POST_OFF = 0.9;        // lateral spacing either side of the crest
  const BOARD_HALF = 1.0;      // half the board's width, laterally
  const BOARD_LOW = 1.4;       // board bottom, above the berm crest
  const BOARD_HIGH = 2.7;      // and its top
  const FOOT = 0.7;            // how far the posts are driven in
  const NOSE = 0.06;           // the face stands proud of the posts
  const STRIPES = [
    new THREE.Color(RAMP_MARK_A), new THREE.Color(RAMP_MARK_B), new THREE.Color(RAMP_MARK_A),
  ];
  const POST_COLOR = new THREE.Color(0x4a4038);

  const verts = [], cols = [], idx = [];
  const _p = new THREE.Vector3();
  /* A point in the sign's own frame: `off` metres past the road edge on this
     side, `up` metres above the berm crest there, `fwd` metres down-road. */
  const pt = (f, side, off, up, base, fwd = 0) => _p.copy(f.pos)
    .addScaledVector(f.right, side * (f.width * 0.5 + off))
    .addScaledVector(f.up, base + up)
    .addScaledVector(f.tan, fwd)
    .clone();
  const quad = (a, b, c, d, color) => {
    const first = verts.length / 3;
    for (const p of [a, b, c, d]) { verts.push(p.x, p.y, p.z); cols.push(color.r, color.g, color.b); }
    idx.push(first, first + 1, first + 2, first, first + 2, first + 3);
  };

  for (const r of track.ramps) {
    /* At the pad and at the lip. The pad board says a boost is coming and the
       lip board says where the road stops being under the car; between them
       they cover the two decisions the driver actually has to make. */
    for (const s of [r.pad0 + PAD_LEN * 0.5, r.lip]) {
      const f = track.frameAt(clamp(s, 4, track.length - 4));
      for (const side of [-1, 1]) {
        const scale = side > 0 ? f.bermR : f.bermL;
        const base = bermHeight(BERM_CREST, scale) + track.rampHeight(f.s, BERM_CREST);
        /* The board faces back down the road, so it is a rectangle in the
           (right, up) plane and an approaching driver sees its full area
           rather than its edge. It is 4 cm thick in reality and 0 cm here,
           which the two-sided material covers: a board that vanished the
           moment you were past it would read as a hole in the scenery from
           the chase camera. */
        const stripeH = (BOARD_HIGH - BOARD_LOW) / STRIPES.length;
        const l0 = BERM_CREST - BOARD_HALF, l1 = BERM_CREST + BOARD_HALF;
        for (let k = 0; k < STRIPES.length; k++) {
          const y0 = BOARD_LOW + k * stripeH, y1 = y0 + stripeH;
          quad(pt(f, side, l0, y0, base, -NOSE), pt(f, side, l1, y0, base, -NOSE),
            pt(f, side, l1, y1, base, -NOSE), pt(f, side, l0, y1, base, -NOSE), STRIPES[k]);
        }
        /* Two legs. Square section, buried below the crest so a post never
           floats clear of the rubble the berm mesh adds on top of its own mean
           profile — the guard rail learned that one the expensive way. */
        for (const lo of [BERM_CREST - POST_OFF, BERM_CREST + POST_OFF]) {
          const corners = [
            [lo - POST_HALF, -POST_HALF], [lo + POST_HALF, -POST_HALF],
            [lo + POST_HALF, POST_HALF], [lo - POST_HALF, POST_HALF],
          ];
          const ring = y => corners.map(([cl, ct]) => pt(f, side, cl, y, base, ct));
          const lower = ring(-FOOT), upper = ring(BOARD_LOW + 0.15);
          for (let k = 0; k < 4; k++) {
            const n = (k + 1) % 4;
            quad(lower[k], lower[n], upper[n], upper[k], POST_COLOR);
          }
          quad(upper[0], upper[1], upper[2], upper[3], POST_COLOR);
        }
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/**
 * The stone-and-grass berm along one edge.
 *
 * This is the thing you actually hit, so it is built from the same width
 * function the physics reads — a visual lip that disagrees with the collision
 * boundary by half a metre is the most infuriating bug a racing game can have.
 * The per-sample height scale computed during stage build does the rest: high
 * on the outside of fast corners, gone on the inside, and never the same for
 * fifty metres running.
 */
export function buildBerms(track, { side = 1, bore = null } = {}) {
  const N = track.count;
  const P = BERM.length;
  const verts = [], cols = [], idx = [];
  const bump = noise1(side > 0 ? 313 : 517);
  const c1 = new THREE.Color(0x526866), c2 = new THREE.Color(0x729451), c3 = new THREE.Color(0x354b52);
  const col = new THREE.Color();
  /* The berm's middle band is grass, and grass does not grow under a mountain.
     The tunnel's own kerb ledge covers most of the shoulder, but the half metre
     of gutter between the tarmac edge and the foot of that ledge is berm, and
     at the grazing angle a chase camera looks down a tunnel it draws a bright
     green line the full length of both walls. Cheaper and more robust than
     trying to roof it over: stop it being green. */
  const boreStone = new THREE.Color(0x3a4249);

  for (let i = 0; i < N; i++) {
    const f = track.frames[i];
    const hw = f.width * 0.5;
    const underRock = boreFloorFactor(f.s, bore) * 0.92;
    const scale = side > 0 ? f.bermR : f.bermL;
    for (let k = 0; k < P; k++) {
      const [o, hh] = BERM[k];
      /* Jitter laterally as well as vertically, and at a wavelength close to
         the 3 m sample spacing. Long-wavelength jitter only makes the tube
         wobble; this is what turns it into rubble, because adjacent rings
         genuinely disagree and flat shading then has facets to find. */
      const jitter = k === 0 ? 0
        : bump(f.s / 4.2 + k * 17) * 0.55 + bump(f.s / 1.7 + k * 53) * 0.25;
      const lat = side * (hw + o + jitter * scale);
      const lump = k === 0 ? 0
        : (bump(f.s / 3.1 + k * 9) * 0.34 + bump(f.s / 1.3 + k * 71) * 0.16) * scale;
      const up = bermHeight(o, scale) + lump + track.rampHeight(f.s, o);
      verts.push(
        f.pos.x + f.right.x * lat + f.up.x * up,
        f.pos.y + f.right.y * lat + f.up.y * up,
        f.pos.z + f.right.z * lat + f.up.z * up,
      );
      col.copy(k <= 1 ? c1 : k === 2 ? c2 : c3);
      if (underRock > 0) col.lerp(boreStone, underRock);
      const v = 1 + bump(f.s / 3.1 + k * 31) * 0.16;
      cols.push(col.r * v, col.g * v, col.b * v);
    }
  }
  for (let i = 0; i < N - 1; i++) {
    for (let k = 0; k < P - 1; k++) {
      /* The profile marches along +right on the right-hand berm and along
         −right on the left, so the sides need opposite winding to both face
         outward. */
      const a = i * P + k, b = a + 1, d = a + P, e = d + 1;
      if (side > 0) idx.push(a, d, b, b, d, e);
      else idx.push(a, b, d, b, e, d);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/**
 * Timber guard rail along exposed outside edges.
 *
 * Swept as one continuous ribbon per run rather than emitted per post: a rail
 * built from a box per segment does not stay joined through a corner, and
 * reads as a row of loose sticks. Runs must be long enough to look deliberate,
 * and both ends get a heavier post so the rail terminates rather than stops.
 */
export function buildGuardRail(track, { postEvery = 5.4, minRun = 48 } = {}) {
  /* A rail is only allowed where there is berm under it to stand on, and
     short holes are closed so a momentary curvature sign flip does not chop
     one continuous rail into three. Both live in railWants, which the ramp
     scan reads as well. */
  const wants = railWants(track);

  const runs = [];
  const minSamples = Math.round(minRun / STEP);
  for (let i = 0; i < track.count; i++) {
    if (!wants[i]) continue;
    let j = i;
    while (j + 1 < track.count && wants[j + 1] === wants[i]) j++;
    if (j - i >= minSamples) runs.push({ i0: i, i1: j, side: wants[i] });
    i = j;
  }

  const RAIL = [[-0.11, 0.0], [0.11, 0.0], [0.11, 0.40], [-0.11, 0.40]];
  const RAIL_TOP = 1.15;              // metres above the berm crest
  const parts = [];
  const post = new THREE.BoxGeometry(0.26, 1.5, 0.26);
  const endPost = new THREE.BoxGeometry(0.4, 1.8, 0.4);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  const _sc = new THREE.Vector3(1, 1, 1);

  /* Stand everything on the berm crest, using the berm's own height function.
     Authoring the rail against a guessed height is how the first version ended
     up with posts half-buried on one side and floating on the other. */
  /* Ramps prefer rail-free sites and the scan scores for it, but a rail that
     does cross one has to climb it rather than have its posts buried on the
     up-face and hanging past the lip. */
  const seat = (f, side) => {
    const scale = side > 0 ? f.bermR : f.bermL;
    return {
      lat: side * (f.width * 0.5 + BERM_CREST),
      base: bermHeight(BERM_CREST, scale) + track.rampHeight(f.s, BERM_CREST),
    };
  };

  for (const run of runs) {
    const n = run.i1 - run.i0 + 1;
    const P = RAIL.length;
    const verts = [], idx = [];
    for (let k = 0; k < n; k++) {
      const f = track.frames[run.i0 + k];
      const { lat: baseLat, base } = seat(f, run.side);
      /* Ramp the last five metres down into the berm at each end. A rail that
         simply stops at full height reads as broken; a real one is anchored. */
      const fade = clamp(Math.min(k, n - 1 - k) / 5, 0, 1);
      const top = lerp(0.25, RAIL_TOP, fade);
      for (const [dl, du] of RAIL) {
        const lat = baseLat + run.side * dl;
        const up = base + top + du;
        verts.push(
          f.pos.x + f.right.x * lat + f.up.x * up,
          f.pos.y + f.right.y * lat + f.up.y * up,
          f.pos.z + f.right.z * lat + f.up.z * up,
        );
      }
    }
    for (let k = 0; k < n - 1; k++) {
      for (let e = 0; e < P; e++) {
        const a = k * P + e, b = k * P + ((e + 1) % P);
        const c = a + P, d = b + P;
        if (run.side > 0) idx.push(a, c, b, b, c, d);
        else idx.push(a, b, c, b, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    parts.push(g);

    const stride = Math.max(1, Math.round(postEvery / STEP));
    for (let k = 0; k < n; k += stride) {
      const isEnd = k === 0 || k + stride >= n;
      const f = track.frames[run.i0 + k];
      const { lat, base } = seat(f, run.side);
      // Third column is −tan: an object's local +Z points backward, so
      // (right, up, +tan) is a mirrored basis and everything built on it is
      // reflected. See buildGate for the same correction.
      q.setFromRotationMatrix(m.makeBasis(f.right, f.up, _t.copy(f.tan).negate()));
      const top = lerp(0.25, RAIL_TOP, clamp(Math.min(k, n - 1 - k) / 5, 0, 1));
      /* Driven into the ground rather than stood on top of it. `bermHeight` is
         the berm's mean profile, but the mesh adds up to half a metre of
         lateral and vertical rubble on top of that, so a post seated on the
         mean floats clear of the surface it is supposed to be planted in
         wherever the rubble happens to dip. Anchoring the foot below the
         profile costs nothing — the buried part is inside an opaque berm — and
         the visible top is unchanged. */
      const footDepth = 0.9;
      const h = top + 0.2 + footDepth;
      _v.copy(f.pos).addScaledVector(f.right, lat)
        .addScaledVector(f.up, base + top + 0.2 - h / 2);
      const nominal = isEnd ? 1.8 : 1.5;
      m.compose(_v, q, _sc.set(1, h / nominal, 1));
      parts.push((isEnd ? endPost : post).clone().applyMatrix4(m));
    }
  }
  post.dispose(); endPost.dispose();
  if (!parts.length) return null;
  const merged = mergeGeometries(parts);
  parts.forEach(p => p.dispose());
  merged.computeVertexNormals();
  return merged;
}

/**
 * Start and finish gates.
 *
 * Built on the track frame so the arch is square to the road and leans with
 * the banking. Mass matters here — the first version was two thin uprights and
 * a flat plank, which reads as a goalpost. These get battered stone pylons
 * with a cap, a beam deep enough to cast a real shadow, diagonal braces and a
 * banner with sag in it.
 */
export function buildGate(track, s, { height = 7.6, finish = false } = {}) {
  const f = track.frameAt(s);
  const hw = f.width * 0.5 + 1.8;
  const group = new THREE.Group();
  group.name = finish ? 'gate-finish' : 'gate-start';
  group.quaternion.setFromRotationMatrix(
    // −tan, not +tan: local +Z is backward, so (right, up, tan) has
    // determinant −1 and mirrors the whole gate.
    new THREE.Matrix4().makeBasis(f.right.clone(), f.up.clone(), f.tan.clone().negate()));
  group.position.copy(f.pos);

  const stone = celMaterial({ color: 0x65736d, flatShading: true });
  const dark = celMaterial({ color: 0x3b5158, flatShading: true });
  const timber = celMaterial({ color: 0x725233, flatShading: true });
  const cloth = celMaterial({
    color: finish ? 0x27648b : 0xee6847, flatShading: true, side: THREE.DoubleSide,
  });

  for (const sgn of [-1, 1]) {
    /* Battered stack: each course narrower and rotated a little, so the pylon
       has a silhouette instead of being a single extruded box. */
    const courses = 6;
    for (let k = 0; k < courses; k++) {
      const w = 2.3 - k * 0.19;
      const slab = new THREE.Mesh(new THREE.BoxGeometry(w, height / courses, w * 0.85), stone);
      slab.position.set(sgn * hw, height / (courses * 2) + (k * height) / courses, 0);
      slab.rotation.y = (k % 2 ? 1 : -1) * 0.06 + sgn * 0.04;
      slab.castShadow = slab.receiveShadow = true;
      group.add(slab);
    }
    const cap = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.45, 2.1), dark);
    cap.position.set(sgn * hw, height + 0.22, 0);
    cap.castShadow = true;
    group.add(cap);

    // Diagonal brace from the pylon shoulder up to the beam.
    const brace = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.34, 0.34), timber);
    brace.position.set(sgn * (hw - 1.2), height + 0.95, 0);
    brace.rotation.z = sgn * 0.62;
    brace.castShadow = true;
    group.add(brace);
  }

  const beam = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 2.6, 0.85, 0.95), timber);
  beam.position.set(0, height + 1.5, 0);
  beam.castShadow = true;
  group.add(beam);
  const beam2 = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 2.2, 0.4, 0.6), dark);
  beam2.position.set(0, height + 0.72, 0);
  beam2.castShadow = true;
  group.add(beam2);

  const banner = new THREE.Mesh(new THREE.PlaneGeometry(hw * 1.9, 2.4, 16, 3), cloth);
  banner.position.set(0, height - 0.15, 0.1);
  {
    /* A flat plane looks printed on. A catenary sag across the span plus a
       ripple along it is the difference between fabric and cardboard. */
    const p = banner.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) / (hw * 0.95), y = p.getY(i);
      p.setY(i, y - (1 - x * x) * 0.42);
      p.setZ(i, Math.sin(x * 3.7) * 0.14 + Math.cos(y * 2.6) * 0.06);
    }
    banner.geometry.computeVertexNormals();
  }
  group.add(banner);

  /* The finish is the one gate that gets driven under, and from underneath a
     beam is a slab. At the last stop the chase lens sits six metres below the
     span and nine metres out, so the climax of the race was a grey ceiling
     filling the top third of the frame with nothing in it that said finish.
     Two additions, both facing down, and neither of them costs more than a
     road fleck: a chequer band across the soffit, which is the one pattern
     that means finish line from any angle, and a run of bunting hanging off
     the beam that the car drives through. */
  if (finish) {
    const span = hw * 2 + 2.2;
    const cells = 16;
    /* Deep enough to be a ceiling rather than a stripe. At the last stop the
       lens looks up at forty degrees and a one-metre band slides out of frame
       before the car is under it; two and a half metres of chequer is still
       overhead at the moment the line is crossed. */
    const soffit = new THREE.PlaneGeometry(span, 2.5, cells, 4).toNonIndexed();
    const col = new Float32Array(soffit.attributes.position.count * 3);
    const light = new THREE.Color(0xd9dde0), dark = new THREE.Color(0x22272b);
    for (let q = 0; q < soffit.attributes.position.count / 6; q++) {
      const cx = q % cells, cy = Math.floor(q / cells) % 2;
      const c = (cx + cy) % 2 ? light : dark;
      for (let v = 0; v < 6; v++) {
        col[(q * 6 + v) * 3] = c.r; col[(q * 6 + v) * 3 + 1] = c.g; col[(q * 6 + v) * 3 + 2] = c.b;
      }
    }
    soffit.setAttribute('color', new THREE.BufferAttribute(col, 3));
    /* Unlit: the underside of a beam faces away from every light in the scene,
       so a lit chequer resolves to two shades of the same near-black and the
       pattern disappears exactly where it is needed. */
    const chequer = new THREE.Mesh(soffit, unlitCelMaterial({
      color: 0xffffff, vertexColors: true, side: THREE.DoubleSide,
    }));
    chequer.rotation.x = -Math.PI / 2;
    chequer.position.set(0, height + 1.06, 0);
    chequer.name = 'gate-chequer';
    group.add(chequer);

    const flagMats = [
      celMaterial({ color: 0xee6847, flatShading: true, side: THREE.DoubleSide }),
      celMaterial({ color: 0xf2c14a, flatShading: true, side: THREE.DoubleSide }),
      celMaterial({ color: 0xd9dde0, flatShading: true, side: THREE.DoubleSide }),
    ];
    const n = 15;
    for (let k = 0; k < n; k++) {
      const u = (k + 0.5) / n - 0.5;
      const g2 = new THREE.BufferGeometry();
      const w = 0.34, drop = 0.62 + Math.abs(u) * 0.1;
      g2.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        -w, 0, 0, w, 0, 0, 0, -drop, 0,
      ]), 3));
      g2.computeVertexNormals();
      const flag = new THREE.Mesh(g2, flagMats[k % 3]);
      /* Hung off a cord with a sag of its own, so the row is a curve rather
         than a ruled line of identical tags. */
      flag.position.set(u * span * 0.94, height + 0.98 - (1 - (u * 2) ** 2) * 0.3, 0.62);
      flag.rotation.z = -u * 0.5;
      flag.name = 'gate-bunting';
      group.add(flag);
    }
  }
  return group;
}

/** Minimal local merge — avoids pulling an addon in for four call sites. */
export function mergeGeometries(list) {
  let total = 0, itotal = 0;
  for (const g of list) {
    total += g.attributes.position.count;
    itotal += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const hasCol = list.every(g => g.attributes.color);
  const col = hasCol ? new Float32Array(total * 3) : null;
  const idx = new Uint32Array(itotal);
  let vo = 0, io = 0;
  for (const g of list) {
    const p = g.attributes.position, n = g.attributes.normal, c = g.attributes.color;
    pos.set(p.array.subarray(0, p.count * 3), vo * 3);
    if (n) nrm.set(n.array.subarray(0, n.count * 3), vo * 3);
    if (col && c) col.set(c.array.subarray(0, c.count * 3), vo * 3);
    if (g.index) { for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.array[i] + vo; }
    else { for (let i = 0; i < p.count; i++) idx[io++] = i + vo; }
    vo += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}
