import * as THREE from 'three';
import { rng, rand, noise1, fbm1, fbm2 } from '../core/rng.js';
import { clamp, lerp, smoothstep } from '../core/util.js';
import { celMaterial, unlitCelMaterial } from '../render/cel.js';
/* Not a change to the ink pipeline — this is the opt-in it publishes for
   exactly this case. See the crowd section at the foot of this file. */
import { registerPrepassMesh, unregisterPrepassMesh } from '../render/outline.js';
import { skipOverridePass } from '../fx/pass.js';
import {
  EDGE_DROP, STEP, bermHeight, mergeGeometries,
  RAMP_UP_LEN, RAMP_LIP_SLOPE, PAD_BEFORE, PAD_LEN,
} from './track.js';
/* The finish line is `track.finishS` now — an absolute station on the track
   rather than an offset from the end of the road — so this file reads it off the
   track it is handed and there is nothing left to import for it. Where a car
   comes to rest is no longer one number either; see END_RESTS and the note above
   it in the crowd section at the foot of the file. Nothing in `car/` or `race/`
   is written to. */

const TERRAIN_STEP = 9;
const LANDFORM_STATIONS = 16;
/* Rise over run for the outer flank of the landform ribbon — the face between
   the back country and the basin it stands on. Forty-four degrees; steeper
   than scree and shallower than rock, which is what a stylised mountainside
   wants to read as. */
const FLANK_GRADIENT = Math.tan((44 * Math.PI) / 180);
/* How far out a lower stretch of road counts as "the valley below". Beyond
   this the hillside is free to be as tall as its own chapter wants. */
const VALLEY_RANGE = 620;
/* First rung of the ladder the valley cone applies to. It used to be 10 — the
   crest and outward — on the reasoning that everything below the crest is the
   road's own cutting. But the cone falls with distance, so capping the top two
   rungs and nothing else builds a ladder that runs backwards: measured, station
   9 of the +1 ribbon at s≈1188 stood eighteen metres above station 8 with
   stations 10 upward shaved off behind it, and station 8 of the massif at
   s≈2400 stood ninety-four metres above its own station 11. A rung above the
   top of its own ladder is a needle seen end-on and a flat-topped slab seen
   broadside, which is the review's "150 m spire" and a good deal of its
   "enormous flat vertical planes". Applying the cone to the whole wall band
   makes the ladder monotone again. */
const VALLEY_FIRST_STATION = 6;
/* And how steeply the hillside above it is allowed to climb away from it, near
   the valley floor. Shallower than the flank's own gradient on purpose: this is
   the number that decides how much sky the road at the bottom of the valley
   gets. */
const VALLEY_GRADIENT = 0.62;
/* A straight gradient is the wrong shape for it. Held straight, the cone has to
   be shallow enough for the far case, and a slope that keeps a mountainside a
   quarter of a kilometre away out of the top of the frame also shaves the near
   bank the road is cut into, which is where the world's structure is. Rolled
   off, the cone starts at the gradient above and eases away with distance, so
   it is a hillside close in and a long fall out — this is what a valley
   actually looks like, and it is the shape that opens the finish basin, where
   the massif at s≈2400 stood a hundred and six metres up two hundred and fifty
   metres out, twenty-three degrees above the lens with the sky behind it.
   Tuned so the cap is unchanged at a hundred metres, up slightly inside that,
   and progressively lower beyond. */
const VALLEY_FALLOFF = 340;
/* Furthest a shoulder is ever tested for water. Past this the ribbon has
   other limits on it and the sea is not the binding one. */
const SHORE_REACH = 430;
const SEA_DIRECTION = new THREE.Vector3(-0.18, 0, -0.984).normalize();

const CHAPTERS = [
  {
    ground: [0x4b8749, 0x78a957, 0x315f47, 0xa6b961],
    wall: [0x536b67, 0x718078, 0x8d927c, 0x3d5359],
    rock: [0x485d61, 0x697774, 0x33474f],
  },
  /* The gorge. It was authored a full rung below every other chapter — ground
     0x286447 against 0x3c7846 next door, wall 0x4d6665 against 0x62726c — on
     the reasonable theory that a deep forest cut should feel darker than the
     open coast. But this is also the chapter with the tallest cut walls in the
     stage, so most of its surfaces are in shadow most of the time, and a dark
     albedo under a shadow floor is where the ladder runs out: the 35% and 52%
     frames fell far enough that the black outlines stopped separating from the
     terrain and the cel read collapsed. It keeps the coolest, most saturated
     hue of the four, which is what actually made it feel like a gorge; the
     value now sits inside the readable band with the rest. */
  {
    ground: [0x35744a, 0x578e4a, 0x265743, 0x84a453],
    wall: [0x435c65, 0x5c7273, 0x76867c, 0x36505c],
    rock: [0x3e5860, 0x627375, 0x334955],
  },
  {
    ground: [0x3c7846, 0x65934f, 0x285a43, 0x91ac59],
    wall: [0x455d62, 0x62726c, 0x7e8573, 0x334b55],
    rock: [0x3a5057, 0x5e6e6d, 0x2c424c],
  },
  {
    ground: [0x568744, 0x82a751, 0x376943, 0xafb960],
    wall: [0x596d68, 0x758078, 0x94937c, 0x42565d],
    rock: [0x4c6062, 0x6b7772, 0x374b52],
  },
];

const GROUND_COLORS = CHAPTERS[3].ground;
const BRUSH_COLORS = [0x2f7e42, 0x499b45, 0x68b34d, 0x276b48];
/* Wildflowers, and the one rule they answer to that is not about wildflowers.
 *
 * The particle system names no colours: a particle's value is a bounded lift on
 * the ground it came off, capped at a little over twice it (see the invariant
 * in src/fx/particles.js). The heaviest class, the landing plume, lifts 1.86x,
 * and the two grounds it is thrown off sit at 0.50 and 0.43 luminance — so
 * every dust curtain in the stage lands between about 0.79 and 0.93, and it is
 * warm and close to neutral, because tarmac and dry verge are.
 *
 * The pale bloom was 0xfff4df. That is 0.96 and neutral: brighter than any dust
 * the system can make, in the same hue, in patches the same size, scattered
 * along exactly the verges the car lands on. System 2's ramps now throw four
 * metre curtains that have to read against that ground, and a stationary
 * object at the same value and hue as the moving one is the whole of the
 * problem. So the pale flower is pulled a rung and a half below the dust band
 * and given real chroma to sit on the cool side of it, and the yellow — which
 * was inside the band too, at 0.82 — comes down with it. They are still the two
 * bright accents on a green verge; they are no longer competing with the FX.
 * Measured: 0.65 and 0.71 against the plume's 0.79–0.93. */
const FLOWER_COLORS = [0xe846a8, 0xe8b22e, 0x8fa8d8, 0xff793d];
/* Four value bands per depth layer, and the layers step in hue as well as in
   value. Three bands separated by two or three per cent of luminance is one
   band as far as a quantised ladder is concerned, which is why every far
   headland was reading as a single flat pale cut-out laid over the horizon —
   the geometry had always been banded, the paint had not. The near ring keeps
   a wooded green, the middle goes slate, the far one goes to the cool blue-
   grey the atmosphere would actually leave, and each ring's own spread is wide
   enough that a shoulder and a summit land on different rungs. */
const HEADLAND_COLORS = [
  [0x1d3f3c, 0x2d5a4c, 0x437260, 0x5d8a69],
  [0x33505c, 0x466570, 0x5c7c81, 0x76959a],
  [0x5d7280, 0x738794, 0x8a9da8, 0xa3b3bc],
];

const _color = new THREE.Color();
const _point = new THREE.Vector3();
const _point2 = new THREE.Vector3();
const _landA = new THREE.Vector3();
const _landB = new THREE.Vector3();
const _coastBase = new THREE.Vector3();

function chapterAt(p) {
  return p < 0.18 ? 0 : p < 0.43 ? 1 : p < 0.7 ? 2 : 3;
}

/* The bounding box of the RACE, and the run-off is deliberately left out of it.
   Its centre seeds the coastline, the basin floor, the sky and the headlands —
   so a hundred and twenty metres of appended road nudging `cx` by a few metres
   would move the shoreline under the whole stage and repaint every terrain
   vertex on it. The run-off is built into the world the race made; it does not
   get a vote on where that world is. */
function trackBounds(track) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const n = track.courseCount ?? track.frames.length;
  for (let i = 0; i < n; i++) {
    const f = track.frames[i];
    x0 = Math.min(x0, f.pos.x); x1 = Math.max(x1, f.pos.x);
    z0 = Math.min(z0, f.pos.z); z1 = Math.max(z1, f.pos.z);
  }
  return {
    x0, x1, z0, z1,
    cx: (x0 + x1) * 0.5,
    cz: (z0 + z1) * 0.5,
  };
}

/**
 * The landmass is a narrow, irregular peninsula grown around the road.
 *
 * "Seaward" is the side of a road frame facing away from the stage's centre.
 * That makes a hairpin turn away from the water and back toward it while the
 * sea continues to wrap the same outside of the headland. The land field is a
 * union of asymmetric road corridors: a short grass lip on the exposed side
 * and a much broader rising shoulder inland. Nearby switchbacks automatically
 * join into one landmass instead of putting water through another road deck.
 */
/* How much dry ground a run-off frame claims either side of its centreline, on
   top of its half-width. The shore ladder starts marching at `width/2 + 10`, so
   anything below about 10 m would leave the ladder unable to find a dry rung at
   all; 16 gives the 14.5 m road a shoulder of five to nine metres a side and
   stops there. See Coastline.shoreMargin for why it is not the course's 78. */
const ROADSIDE_LIP = 16;

class Coastline {
  constructor(track, seed, bounds) {
    this.track = track;
    this.seed = seed;
    this.sea = SEA_DIRECTION.clone();
    this.noise = noise1(seed * 181 + 73);
    this.seaLevel = track.endY - 28;
    this.centre = new THREE.Vector3(bounds.cx, 0, bounds.cz);
    this.bounds = bounds;
    /* Every frame, run-off included, and that inclusion is load-bearing rather
       than incidental. This function is what says where the land stops, and the
       run-off is a hundred and twenty metres of road built past the point the
       old landmass ended — excluded from the union it would have been road over
       open water on the seaward-finishing seeds. Including it grows the
       peninsula around the appended road and nothing else: the union is a `min`
       over per-frame margins with a radial early-out, so a frame can only ever
       add land within about 120 m of itself in plan. Measured on all fourteen
       seeds (tools/zyrunoff.mjs), the shoreline moves nowhere upstream of the
       finish basin. */
    const nc = track.courseCount ?? track.frames.length;
    /* Two lists, and the course one exists so that a question about the RACE can
     * be asked without the appended road in the answer — see `shoreRoom` in
     * CoastField, which is read by every siting rule near the finish.
     *
     * The `!==` push at the end of each is not decoration. Striding by four from
     * zero and then pushing the final frame is how this list was always built,
     * and appending run-off silently changed what "the final frame" meant: the
     * course's last frame stopped being sampled at all unless its index happened
     * to be a multiple of four. Dropping a sample REMOVES land, and on seed 22
     * that showed up as a shoreline sample 4.5 km back from the flag turning from
     * land into sea — the opposite sign to everything else this pass does, which
     * is what made it findable. */
    this.courseSamples = [];
    for (let i = 0; i < nc; i += 4) this.courseSamples.push(track.frames[i]);
    if (this.courseSamples[this.courseSamples.length - 1] !== track.frames[nc - 1]) {
      this.courseSamples.push(track.frames[nc - 1]);
    }
    this.samples = this.courseSamples.slice();
    for (let i = nc; i < track.frames.length; i += 4) this.samples.push(track.frames[i]);
    if (this.samples[this.samples.length - 1] !== track.frames[track.frames.length - 1]) {
      this.samples.push(track.frames[track.frames.length - 1]);
    }
  }

  outward(frame, out = new THREE.Vector3()) {
    out.set(frame.pos.x - this.centre.x, 0, frame.pos.z - this.centre.z);
    /* Near the middle of the knot the radial direction is under-defined.
       A small global bias keeps the coast hand stable through that crossing. */
    out.addScaledVector(this.sea, 115);
    if (out.lengthSq() < 1) out.copy(this.sea);
    return out.normalize();
  }

  seaAlignment(frame, side) {
    const outward = this.outward(frame, _point2);
    return side * (frame.flatRight.x * outward.x + frame.flatRight.z * outward.z);
  }

  shoreMargin(frame, side) {
    /* The run-off asks for a lip and nothing more, and that is the whole reason
     * this function is allowed to see run-off frames at all.
     *
     * This is a PLAN function — it takes x and z and no y — so it cannot tell
     * that the run-off on seed 7 passes 1.3 m from the road at s=117 while
     * lying 478 m below it, or that seed 22's passes 1.0 m from s=1074 and 354 m
     * under it. The stage descends most of half a kilometre and knots back over
     * itself, so "near in plan" routinely means "a long way down". Given the
     * course frames' 78 m inland shoulder, a run-off frame in one of those
     * crossings grew land 97 m out from a driven corner three hundred metres
     * above it — measured on seed 22, at s=1120, which is 4.5 km back from the
     * flag and nothing to do with run-off.
     *
     * A lip of ROADSIDE_LIP claims ground about 23 m from the centreline: enough
     * that a 14.5 m road and its berm are on land, not enough to reach past its
     * own shoulder and repaint a coastline the race is driven along. Where the
     * run-off really does need more land than that, it is because it is beside
     * the course, and the course's own margin is already supplying it — this
     * function is a `min` over frames, so the generous number still wins wherever
     * a generous frame is genuinely nearby. */
    if (frame.s > this.track.length) return ROADSIDE_LIP;
    const coastness = smoothstep(-0.18, 0.72, this.seaAlignment(frame, side));
    const p = frame.s / this.track.length;
    const exposed = 20 + this.noise(frame.s / 155 + side * 47) * 7;
    const inland = 78 + this.noise(frame.s / 260 + side * 91) * 18;
    const endCap = smoothstep(0.94, 1, p) * 22 + (1 - smoothstep(0, 0.045, p)) * 24;
    return lerp(inland, exposed, coastness) + endCap;
  }

  /**
   * How far this point is outside the landmass; negative is dry.
   *
   * `samples` defaults to every frame, run-off included. Pass `courseSamples` to
   * ask the question the RACE would have answered — which is what the shore
   * ladder does for its course rungs, so that `shoreRoom`, and therefore every
   * siting rule that reads it, is unaffected by road appended past the flag.
   */
  signedDistanceXZ(x, z, samples = this.samples) {
    let distance = Infinity;
    for (const frame of samples) {
      const dx = x - frame.pos.x, dz = z - frame.pos.z;
      const radial = Math.hypot(dx, dz);
      if (radial - 120 > distance) continue;
      const lateral = dx * frame.flatRight.x + dz * frame.flatRight.z;
      const side = lateral >= 0 ? 1 : -1;
      const margin = frame.width * 0.5 + this.shoreMargin(frame, side);
      distance = Math.min(distance, radial - margin);
    }
    return distance;
  }

  shorePoint(s, depth = 0, out = new THREE.Vector3()) {
    const frame = this.track.frameAt(s);
    const side = this.seaSideAt(s);
    let offset = frame.width * 0.5 + this.shoreMargin(frame, side) + depth;
    for (let i = 0; i < 5; i++) {
      out.copy(frame.pos).addScaledVector(frame.flatRight, side * offset);
      const correction = depth - this.signedDistanceXZ(out.x, out.z);
      if (correction <= 0.5) break;
      offset += correction;
    }
    out.y = this.seaLevel;
    return out;
  }

  seaSideAt(s) {
    const frame = this.track.frameAt(s);
    return this.seaAlignment(frame, 1) >= 0 ? 1 : -1;
  }

  shoreDistanceAt(s) {
    const frame = this.track.frameAt(s);
    return this.shoreMargin(frame, this.seaSideAt(s));
  }

  waterDistanceAt(s) {
    const frame = this.track.frameAt(s);
    return Math.hypot(this.shoreDistanceAt(s), Math.max(0, frame.pos.y - this.seaLevel));
  }
}

function setColor(array, offset, hex, light = 1) {
  _color.setHex(hex).multiplyScalar(light);
  array[offset] = _color.r;
  array[offset + 1] = _color.g;
  array[offset + 2] = _color.b;
}

function finishGeometry(geometry) {
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function environmentCelMaterial(params) {
  const clean = { ...params };
  const flatShading = clean.flatShading;
  delete clean.flatShading;
  const material = celMaterial(clean);
  if (flatShading !== undefined) material.flatShading = flatShading;
  return material;
}


/**
 * The road cannot be carved into one x/z heightfield: adjacent switchbacks
 * occupy the same plan footprint at different elevations. This field follows
 * arc length instead, then limits each side against nearby, non-adjacent road
 * sections so a coastal bluff cannot grow through another deck.
 */
class CoastField {
  constructor(track, coast, seed) {
    this.track = track;
    this.coast = coast;
    this.seed = seed;
    this.shapeNoise = fbm1(seed * 19 + 41, 4);
    this.sideNoise = noise1(seed * 31 + 7);
    this.groundNoise = noise1(seed * 43 + 17);
    this.wallNoise = noise1(seed * 59 + 23);
    /* `roadEnd`, so the corridor, the apron and the retaining bank all run on
       under the run-off. Bounded at `length` the appended road would have a
       hundred and twenty metres of it standing on nothing, with the terrain
       ribbon's last row stretched across the gap. */
    this.count = Math.ceil(track.roadEnd / TERRAIN_STEP) + 1;
    /* Where the race's rungs stop and the run-off's begin.
     *
     * Every smoothing pass in this constructor runs in BOTH directions, and the
     * backward ones are why this index has to exist. `valleyY` propagates a
     * lower neighbour back up the ladder at 3 m per 9 m rung with no distance
     * limit, so a run-off rung sitting over the finish basin pulled the valley
     * floor down through hundreds of metres of course behind it — measured on
     * seed 16 as a crowd group moving from s=3902 to s=3926, which is 673 m
     * upstream of the flag and a place this pass has no business touching. The
     * course's rungs are therefore smoothed among themselves exactly as they
     * were before the run-off existed, and the tail is then filled in one
     * forward pass that can be influenced by the course but cannot influence
     * it. */
    this.courseCount = Math.ceil(track.length / TERRAIN_STEP) + 1;
    this.ss = new Float32Array(this.count);
    this.clearL = new Float32Array(this.count);
    this.clearR = new Float32Array(this.count);
    this.nearDyL = new Float32Array(this.count);
    this.nearDyR = new Float32Array(this.count);
    this.clearL.fill(220); this.clearR.fill(220);
    /* The valley below.
     *
     * `clear` above deliberately ignores any road more than 150 m away in
     * height, because it is answering "how much room does this shoulder have
     * before it hits the next deck", and a deck that far above or below is not
     * in the way of a shoulder. But this stage descends four hundred and
     * seventy metres, so for most of its length the road that is nearest in
     * plan is *also* far below — and the terrain builder could not see it. It
     * therefore raised full-height back country directly over the finish
     * basin, and the last seventeen seconds of the race were run at the foot
     * of a mountain with no sky in the frame at all.
     *
     * These two arrays are the other half of that question: where is the
     * lowest thing near me, and how far away in plan. Everything the ribbon
     * builds outboard of the crest is then held under a slope rising from it,
     * so a hillside above a valley falls away toward the valley instead of
     * standing over it. */
    this.valleyY = new Float32Array(this.count);
    this.valleyD = new Float32Array(this.count);
    this.valleyD.fill(VALLEY_RANGE);
    /* How far each shoulder may run before it is standing in the sea.
     *
     * Nothing enforced this. The coastal ladder was written to reach the
     * waterline and stop, but the inland ladder is not — it reaches whatever
     * its chapter and its clearances allow — and `landformPoint` blends the
     * two, so anywhere the sea alignment is partial the ribbon walked out over
     * open water and built a hillside on it. On the coastal run to the finish
     * three quarters of the mass filling the frame was past the shoreline: not
     * a corridor at all, a headland manufactured on top of the view the
     * corridor was supposed to open onto. */
    this.shoreL = new Float32Array(this.count);
    this.shoreR = new Float32Array(this.count);

    for (let i = 0; i < this.count; i++) {
      /* The race's own rungs are clamped to `length` as they always were —
         including the last one, which lands short and which `_sample` reads as
         though it were evenly spaced. That is a pre-existing quirk and copying
         it is the point: the alternative is a ladder whose final course rung
         moves up to 9 m, which repaints the finish apron's terrain for no
         reason connected to run-off. */
      const s = Math.min(i < this.courseCount ? track.length : track.roadEnd,
        i * TERRAIN_STEP);
      const f = track.frameAt(s);
      this.ss[i] = s;
      this.valleyY[i] = f.pos.y;
      /* Neighbours are course frames only. A run-off frame is never what a
         shoulder has to make room for or fall away toward — it is 120 m of road
         with nothing sited along it — and letting it into this scan let it
         rewrite the clearances of course stations near the finish. */
      for (let j = 0; j < track.courseCount; j += 4) {
        const g = track.frames[j];
        if (Math.abs(g.s - s) < 150) continue;
        const dx = g.pos.x - f.pos.x, dz = g.pos.z - f.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < 1) continue;
        const dy = g.pos.y - f.pos.y;
        if (d2 < VALLEY_RANGE * VALLEY_RANGE && dy < -30) {
          /* Deepest wins, and among equals the nearest — the cap has to clear
             the lowest road in the neighbourhood or it would bury it. */
          if (g.pos.y < this.valleyY[i] - 0.01
            || (g.pos.y < this.valleyY[i] + 0.01 && Math.sqrt(d2) < this.valleyD[i])) {
            this.valleyY[i] = g.pos.y;
            this.valleyD[i] = Math.sqrt(d2) - g.width * 0.5 - 12;
          }
        }
        if (Math.abs(dy) > 150 || d2 > 220 * 220) continue;
        const lateral = dx * f.flatRight.x + dz * f.flatRight.z;
        const gap = Math.max(9, (Math.sqrt(d2) - f.width * 0.5 - g.width * 0.5) * 0.5 - 2);
        if (lateral < 0 && gap < this.clearL[i]) {
          this.clearL[i] = gap;
          this.nearDyL[i] = dy;
        } else if (lateral >= 0 && gap < this.clearR[i]) {
          this.clearR[i] = gap;
          this.nearDyR[i] = dy;
        }
      }
    }

    /* A nearest road section can change abruptly at a switchback apex. Only
       propagating smaller clearances keeps the safe side of the result while
       turning those one-sample notches into deliberate bluff pinches. */
    const nc = this.courseCount;
    for (const clear of [this.clearL, this.clearR]) {
      for (let i = 1; i < nc; i++) clear[i] = Math.min(clear[i], clear[i - 1] + 4);
      for (let i = nc - 2; i >= 0; i--) clear[i] = Math.min(clear[i], clear[i + 1] + 4);
      // The tail, forward only. See courseCount.
      for (let i = nc; i < this.count; i++) clear[i] = Math.min(clear[i], clear[i - 1] + 4);
    }
    /* March each shoulder outward until the coast function says it is wet.
       Coarse, then bisected once — the shoreline is smooth at this scale and
       a metre or two either way is inside the noise on the cliff edge. */
    const probe = new THREE.Vector3();
    for (let i = 0; i < this.count; i++) {
      const f = track.frameAt(this.ss[i]);
      /* A course rung marches against the course's own landmass, so the number
         it arrives at is the number it arrived at before any of this. A run-off
         rung marches against everything, because the land it is standing on is
         partly its own. Without the split, a course station near the finish
         found dry ground further out than it used to — the run-off's lip being
         within reach of its probe — and `shoreRoom` moved, which moved the
         crowd barriers on seeds 26, 34 and 36 without moving a single crowd
         site: the same group of people, standing a few centimetres off. */
      const set = this.ss[i] > track.length ? coast.samples : coast.courseSamples;
      for (const side of [-1, 1]) {
        const floor = f.width * 0.5 + 10;
        let wet = SHORE_REACH;
        for (let d = floor; d <= SHORE_REACH; d += 14) {
          probe.copy(f.pos).addScaledVector(f.flatRight, side * d);
          if (coast.signedDistanceXZ(probe.x, probe.z, set) > 0) { wet = d; break; }
        }
        let dry = Math.max(floor, wet - 14);
        for (let k = 0; k < 3 && wet - dry > 1; k++) {
          const mid = (wet + dry) * 0.5;
          probe.copy(f.pos).addScaledVector(f.flatRight, side * mid);
          if (coast.signedDistanceXZ(probe.x, probe.z, set) > 0) wet = mid; else dry = mid;
        }
        (side < 0 ? this.shoreL : this.shoreR)[i] = dry;
      }
    }

    /* Same treatment for the valley floor, so the cap slides along the stage
       rather than switching on at one station and off at the next. */
    for (let i = 1; i < nc; i++) {
      this.valleyY[i] = Math.min(this.valleyY[i], this.valleyY[i - 1] + 3);
    }
    for (let i = nc - 2; i >= 0; i--) {
      this.valleyY[i] = Math.min(this.valleyY[i], this.valleyY[i + 1] + 3);
    }
    // The tail, forward only. See courseCount.
    for (let i = nc; i < this.count; i++) {
      this.valleyY[i] = Math.min(this.valleyY[i], this.valleyY[i - 1] + 3);
    }
  }

  _sample(array, s) {
    const t = clamp(s / TERRAIN_STEP, 0, this.count - 1);
    const i = Math.floor(t), k = t - i;
    return lerp(array[i], array[Math.min(this.count - 1, i + 1)], k);
  }

  /**
   * How near this station is to a saddle in its shoulder, 0 summit to 1 col.
   *
   * A crest does not have to be tall to wall a frame in. From a chase lens two
   * metres off the deck, an unbroken ten-metre bank forty metres out still
   * fills the top of the picture, and the sky audit found sixteen stations in
   * sixty holding five per cent sky or less behind exactly that: not one wall
   * in particular, just the same modest bank running for a kilometre without a
   * single break in it. Adding vegetation to those frames cannot help, because
   * there is nothing behind the vegetation to see.
   *
   * Hill country is not a ruled bank. It is summits with saddles between them,
   * and the saddle is where you see out. One slow phase walks the length of
   * the stage and the two shoulders read it half a cycle apart, so where the
   * left bank is at its summit the right one is at its col and two hundred and
   * sixty metres later they have swapped. That is about six seconds at racing
   * speed — a rhythm rather than a flicker — and it means the frame keeps one
   * high side to be dense against while the other one opens onto the sky.
   * The phase is wobbled by the broad shape noise so the alternation is not
   * metronomic, and it is a multiplier on height alone: nothing moves in plan,
   * no vertex is added, and the corridor keeps its silhouette.
   */
  col(s, side) {
    /* Never through the bore. A tunnel needs a hundred and fifty metres of
       unbroken rock over the road at its *weakest* section, and a saddle every
       two hundred and sixty metres guarantees there is a thin spot somewhere
       in every candidate run — three of the fourteen boot seeds lost their
       tunnel site outright to this before the exemption went in. The site scan
       reads `wallHeightBare`, which is this shoulder before the col, and the
       col then stands aside wherever the scan actually put the bore. */
    const phase = s / 265 + this.shapeNoise(s / 430) * 1.1 + (side > 0 ? 0.5 : 0);
    let col = smoothstep(0.04, 0.74, Math.sin(phase * Math.PI * 2) * 0.5 + 0.5);
    /* Eased in over sixty metres at each mouth so the saddle either side of
       the mountain still runs down to the portal rather than stopping at it.
       Both bores: the early tunnel needs its rock kept whole for exactly the
       same reason the late one does. */
    for (const span of [this.tunnel, this.tunnel2]) {
      if (!span) continue;
      col *= 1 - boreDepth(s, { s0: span.s0 - 70, s1: span.s1 + 70 }, 60);
    }
    return col;
  }

  profile(s, side) {
    const f = this.track.frameAt(s);
    const p = s / this.track.length;
    const chapter = chapterAt(p);
    const ridge = 1 - smoothstep(0.14, 0.22, p);
    const switchbacks = smoothstep(0.13, 0.21, p) * (1 - smoothstep(0.42, 0.5, p));
    const shelf = smoothstep(0.4, 0.49, p) * (1 - smoothstep(0.68, 0.76, p));
    const wash = smoothstep(0.68, 0.78, p);
    const broadNoise = this.shapeNoise(s / 560);
    const tight = clamp(
      ridge * 0.16 + switchbacks * 0.9 + shelf * 0.42 + wash * 0.58 + broadNoise * 0.13,
      0.1, 1,
    );
    const bend = clamp(f.curv * 125, -1, 1);
    const cut = clamp(bend * 0.38 + this.sideNoise(s / 470) * 0.32, -1, 1);
    const seaFacing = this.coast.seaAlignment(f, side);
    const coastness = smoothstep(0.02, 0.72, seaFacing);
    const inlandness = smoothstep(0.02, 0.72, -seaFacing);
    /* Geographic slope wins over corner hand. Near a coast-facing heading the
       alignment passes smoothly through zero, so the bluff relaxes before it
       reappears on the opposite local shoulder instead of popping at an apex. */
    const cutness = clamp(0.18 + inlandness * 0.82 + tight * 0.12 + side * cut * 0.08, 0.08, 1);
    let dropness = clamp(
      coastness * 0.94 + (1 - tight) * 0.08 + Math.max(0, -side * cut) * 0.08,
      0, 1,
    );

    const chapterDistance = [72, 34, side * cut > -0.05 ? 46 : 78, 82][chapter];
    const inlandDistance = chapterDistance
      + this.sideNoise(s / 210 + side * 80) * (chapter === 1 ? 6 : 10)
      - inlandness * 4;
    /* The exposed shoulder is now a real cliff edge, not a distant horizon:
       only a short grass apron separates the barrier from the drop. */
    const coastDistance = 18 + this.sideNoise(s / 125 + side * 37) * 5;
    /* And the col steps the wall back as well as down. Height alone is not
       what shuts a frame: the chase lens sits four metres off the deck and
       looks slightly down, so the top of the picture is only about fourteen
       degrees above the horizon, and a ten-metre bank twenty-five metres out
       is already at twenty-one. Lowering that bank without also moving it
       away leaves it exactly where it was in frame. */
    const col = this.col(s, side);
    const desired = clamp(
      lerp(inlandDistance, coastDistance, coastness) * (1 + col * 1.35),
      13, 165,
    );
    const clear = this._sample(side < 0 ? this.clearL : this.clearR, s);
    const nearDy = this._sample(side < 0 ? this.nearDyL : this.nearDyR, s);
    let insideCurv = 0;
    for (let d = -36; d <= 36; d += 9) {
      const g = this.track.frameIndex((s + d) / STEP);
      if (side * g.curv > 0.001) insideCurv = Math.max(insideCurv, Math.abs(g.curv));
    }
    const insideLimit = insideCurv
      ? Math.max(7, 1 / insideCurv - f.width * 0.5 - 3)
      : 240;
    const wallDist = clamp(Math.min(desired, clear, insideLimit), 7, 165);
    const chapterHeight = [34, 68, side * cut > -0.05 ? 76 : 34, 42][chapter];
    const erosion = Math.pow(
      clamp(this.wallNoise(s / 73 + side * 41) * 0.72 + 0.36, 0, 1),
      2.2,
    );
    const fracture = this.wallNoise(Math.floor((s + (side > 0 ? 37 : 0)) / 108) * 7.31 + side * 83);
    let wallHeight = chapterHeight + cutness * (chapter === 1 ? 27 : 16)
      + this.wallNoise(s / 190 + side * 50) * 8 - erosion * (chapter === 1 ? 38 : 24);
    wallHeight *= 0.42 + inlandness * 0.72 + (1 - coastness) * 0.12;
    const wallHeightBare = wallHeight;
    wallHeight *= 1 - col * 0.88;

    if (clear < desired - 1) {
      if (nearDy > 8) wallHeight = Math.min(wallHeight, Math.max(11, nearDy - 5));
      if (nearDy < -8) {
        wallHeight = Math.min(wallHeight, 18);
        dropness = Math.max(dropness, 0.82);
      }
      wallHeight = Math.min(wallHeight, 48);
    }
    if (chapter === 3) wallHeight = lerp(wallHeight, 11, smoothstep(0.88, 0.97, p));

    const cliffDrop = clamp(
      22 + coastness * (42 + (f.pos.y - this.coast.seaLevel) * 0.11)
        + this.wallNoise(s / 155 + side * 27) * 8,
      16,
      104,
    );

    return {
      f, p, chapter, ridge, switchbacks, shelf, wash, tight, cutness, dropness,
      seaFacing, coastness, inlandness, cliffDrop,
      clear, nearDy, insideLimit, constrained: clear < desired - 1, fracture, erosion,
      wallDist, wallHeight: clamp(wallHeight, 8, 108), col,
      /* Before the saddle was cut, for the tunnel scan — see `col`. */
      wallHeightBare: clamp(wallHeightBare, 8, 108),
      valleyY: this._sample(this.valleyY, s),
      valleyD: this._sample(this.valleyD, s),
      shoreRoom: this._sample(side < 0 ? this.shoreL : this.shoreR, s),
    };
  }

  /**
   * The highest a point this far out on this shoulder may stand.
   *
   * A slope rising from the lowest nearby roadbed, so the mass a driver down
   * there looks up at is a hillside rather than a wall, and so the hillside
   * gets lower the closer it comes to them. Where there is nothing below, the
   * cap is out of reach and nothing changes.
   */
  valleyCeiling(profile, lateral) {
    const gap = Math.max(0, profile.valleyD - lateral);
    return profile.valleyY + 26 + (gap * VALLEY_GRADIENT) / (1 + gap / VALLEY_FALLOFF);
  }

  groundDelta(s, side, u, profile = this.profile(s, side)) {
    const rise = (2 + profile.wallHeight * (0.07 + profile.cutness * 0.075))
      * Math.pow(u, 1.45) * (0.28 + profile.inlandness * 0.9);
    /* Where the cliff edge is, as a fraction of the corridor.
       This used to start falling at 0.16 and be over the side by 0.48, which
       on an eighteen-metre coastal corridor left about three and a half metres
       of standable ground between the kerb and a forty-five metre drop. Every
       placement rule in the file keeps props at least PROP_CLEAR — 5.6 m —
       off the road, so on the seaward shoulder those two numbers between them
       made it arithmetically impossible to stand anything on the verge: the
       clearance rule pushed each plant past the lip and the lip dropped it
       twelve metres down the face, out of sight below the berm. That is the
       whole of the review's "the seaward half is a flat green verge and then
       water, with ZERO objects".

       So the lip is now six to eight metres of shoulder, and its width varies
       along the coast so the edge is not a ruled offset from the road. The
       cliff below it is unchanged — this moves where the fall begins, not how
       far it goes. */
    const lip = 0.33 + this.shapeNoise(s / 96 + side * 13) * 0.11;
    const drop = profile.dropness * (9 + profile.cliffDrop * 0.38)
      * smoothstep(lip, lip + 0.29, u);
    const ripple = (
      this.groundNoise(s / 37 + side * 90 + u * 4.3) * 1.2
      + this.groundNoise(s / 11 + side * 170 + u * 9.1) * 0.45
    ) * u;
    return -0.65 + rise - drop + ripple;
  }

  point(s, side, u, out = new THREE.Vector3()) {
    const profile = this.profile(s, side);
    const f = profile.f;
    const off = profile.wallDist * u;
    const lat = side * (f.width * 0.5 + off);

    out.copy(f.pos).addScaledVector(f.right, lat)
      .addScaledVector(f.up, lerp(EDGE_DROP - 0.08, EDGE_DROP - 0.52, smoothstep(0, 0.24, u)));
    if (u > 0) {
      _point2.copy(f.pos).addScaledVector(f.flatRight, lat);
      _point2.y += this.groundDelta(s, side, u, profile);
      out.lerp(_point2, smoothstep(0.08, 0.34, u));
    }
    return out;
  }
}

/**
 * The wall a switchback leaves between two decks of the same road.
 *
 * Where a neighbouring section of road runs close by, the shoulder has no room
 * to become a landform: everything from the top of the corridor outward has to
 * climb (or fall) to meet the other deck inside a few metres. Eleven stations
 * used to share a straight line 0.7 m wide in plan, which is a curtain — one
 * unbroken quad from the road to the skyline, a top edge ruled with a
 * straightedge, and, where two of those stations nearly coincided, a facet
 * whose normal came out of the noise and caught the light like a mis-modelled
 * wedge. Half the 92% frame was this surface and it had no shape at all.
 *
 * There is more plan room here than 0.7 m: `clear` is already half the gap to
 * the other deck less two metres, so a couple of metres beyond it still lands
 * well short of the far roadbed, and the two walls meeting inside the hill is
 * rock against rock. Spending it on a stepped, noisy profile is what turns the
 * curtain into a face — and the steps have to be in plan as well as in height,
 * because with per-face normals a step is the only thing that makes a crease.
 */
function mergeRampPoint(field, s, side, station, profile, out) {
  const f = profile.f;
  field.point(s, side, 1, out);
  const t = (station - 5) / (LANDFORM_STATIONS - 6);
  const mergeY = f.pos.y + profile.nearDy * 0.5 - 1;
  const base = out.y;
  const rise = mergeY - base;

  /* Room is whatever is left before the other deck's own shoulder, and it
     shrinks to nothing at the ends of the ramp so the apron below and the
     merge above both still join cleanly.
     It used to be capped at three and a half metres. `clear` is already half
     the gap to the other deck less two, so on a switchback with a deck a
     hundred and thirty metres overhead the ramp was climbing sixty-five
     metres inside four metres of plan — an eighty-degree curtain, and the
     ladder's benching had nowhere to land on it. Better than half the
     available gap is still short of the other roadbed, and it buys the face a
     gradient rather than a rule. */
  const room = clamp(profile.clear * 0.55, 0.9, 14);
  const bench = field.wallNoise(s / 31 + side * 57);
  out.addScaledVector(
    f.flatRight,
    side * (t * 0.7 + room * t * (0.35 + bench * 0.65)),
  );

  /* Benched rather than ruled. The ledge term steps the profile at the same
     stations the setback does, so a horizontal crease runs along the face; the
     fracture term is piecewise constant over ~100 m of road, which is what
     gives neighbouring stretches of the same wall visibly different geometry
     instead of one extruded section. */
  const shape = t * t * (3 - 2 * t);
  const relief = Math.min(6.5, Math.abs(rise) * 0.11 + 1.4);
  out.y = lerp(base, mergeY, lerp(t, shape, 0.55))
    + field.wallNoise(s / 23 + side * 37) * relief * t
    + profile.fracture * relief * 0.5 * t * (1 - t) * 4;
  return out;
}

function inlandLandformPoint(field, s, side, station, out) {
  const profile = field.profile(s, side);
  const f = profile.f;
  if (profile.constrained && station >= 5) {
    return mergeRampPoint(field, s, side, station, profile, out);
  }

  const apron = [0, 0.1, 0.25, 0.45, 0.7, 1];
  if (station < apron.length) {
    field.point(s, side, apron[station], out);
    if (station >= 3) out.addScaledVector(f.flatRight, side * profile.erosion * (5 - station) * 1.8);
    return out;
  }

  field.point(s, side, 1, out);
  const wallFracs = [0.14, 0.31, 0.5, 0.68, 0.85, 1];
  /* The ladder's shape, as fractions of however far back the wall is allowed
     to lean. It used to be six absolute distances per chapter, and the two
     chapters that carry the tall cut walls had been given the two shortest
     ladders: chapter 1 stepped back eight metres over a wall that rises to
     ninety-five, and chapter 2 eleven over seventy-six. That is an eighty-five
     degree face by construction, and a mass of them seen end-on from a later
     part of the course is the row of tall thin fins standing through the
     finish-straight frames. Chapters 0 and 3 were already at roughly two
     thirds of their height and are the ones that read as hillsides.

     The span is derived from the wall's own height for that reason, so a wall
     that grows taller also grows a base to stand on. This costs nothing: the
     station count is fixed, only the positions move. */
  const ladder = [
    [0.055, 0.159, 0.295, 0.477, 0.705, 1],
    [0.063, 0.188, 0.350, 0.525, 0.725, 1],
    [0.073, 0.200, 0.327, 0.473, 0.673, 1],
    [0.141, 0.310, 0.500, 0.679, 0.852, 1],
  ][profile.chapter];
  /* Bounded by the room there actually is. `clear` is already half the gap to
     any neighbouring deck, so leaning into it is leaning into hillside, but a
     wall on a switchback still has to stop short of the deck above. */
  const leanRoom = Math.max(
    14,
    Math.min(profile.clear, profile.insideLimit) - profile.wallDist,
  );
  const span = Math.min(profile.wallHeight * 0.62, leanRoom * 0.9);
  const wallSetbacks = ladder.map(k => k * span);

  if (station <= 11) {
    const level = station - 6;
    const frac = wallFracs[level];
    /* Every chapter fractures. The last one used to be excluded — fracture 0
       and facet noise scaled to 0.12 — on the theory that the finish basin
       wants a calm apron, and on a wide-open shoulder it does. But chapter 3
       also contains the tall cut walls of the last kilometre, and with no
       fracture and no facet noise those are a single ruled ramp from the road
       to the skyline: one flat quad tens of metres across, a perfectly
       straight top edge, and a couple of stray facets that catch the light
       differently enough to read as modelling errors rather than as rock.
       The setback ladder here is wide, so the fracture term is kept below
       chapter 1's — enough to break the plane, not enough to turn the run-in
       to the finish into a gorge. */
    const fracture = profile.fracture * frac * [4, 7, 4, 5][profile.chapter];
    const ledgeScale = clamp(profile.wallDist / (wallSetbacks[5] + 8), 0.28, 1);
    /* The budget for a ledge used to be `min(clear, insideLimit) - wallDist`,
       and wallDist is itself the minimum of those two — so on precisely the
       walls that need shape most, a tall cut on the inside of a tight corner
       or one squeezed between two decks of a switchback, the budget came out
       at zero and the clamp below collapsed all six setbacks onto its 0.25 m
       floor. The result is a plane: seventy metres of slab with a ruled top
       edge, no crease anywhere on it, and nothing but the height noise to
       distinguish one facet from the next — which is how a couple of those
       facets came to catch the light hard enough to read as modelling errors.
       Both of those limits are about where the wall meets the road. A ledge
       steps away from the road and upward into the hillside, so partway up
       neither one is binding any more; a floor that opens with the station
       keeps the ladder intact without ever moving the wall's base. */
    /* Small. The setback ladder and the fracture term were both written
       against a budget that was usually zero, so their amplitudes are sized
       for a clamp that was doing most of the work; open the budget wide and
       chapter 1's fracture of seven metres steps whole grid cells at once and
       tiles the wall with rectangles. Two or three metres is enough to put a
       crease between levels, which is all that was missing. */
    const ledgeRoom = Math.max(
      0.8 + frac * 2.8,
      Math.min(profile.clear - profile.wallDist, profile.insideLimit - profile.wallDist),
    );
    /* One noise phase for the whole column, not one per level. Decorrelating
       the levels gives every cell of the grid its own offset, and with a
       budget wide enough for those offsets to actually land, the wall tiles
       into rectangles — a grid of flat panels at random depths, which is a
       worse read than the plane it replaced. Sharing the phase turns the same
       noise into a fault that runs the full height of the wall, which is both
       what rock does and what the flat-shaded facets need in order to catch
       the light as one plane rather than as confetti. */
    const ledge = clamp(
      (wallSetbacks[level] + fracture) * ledgeScale
        + field.wallNoise(s / 29 + side * 57) * (0.5 + frac * 1.4),
      0.12,
      ledgeRoom,
    );
    out.addScaledVector(f.flatRight, side * ledge);
    out.y += profile.wallHeight * frac
      + fracture * 0.58
      + field.wallNoise(s / 21 + side * 13) * frac * 1.4;
    return out;
  }

  const top = inlandLandformPoint(field, s, side, 11, _point2);
  const openSpread = [125, 58, profile.dropness > 0.52 ? 150 : 92, 175][profile.chapter];
  const available = Math.max(
    0.85,
    Math.min(profile.clear - profile.wallDist, profile.insideLimit - profile.wallDist),
  );
  const topBack = Math.min(10 + profile.wallHeight * 0.13, available * 0.28);
  const safeSpread = Math.max(0.5, Math.min(openSpread, available - topBack));
  if (station === 12) {
    out.copy(top).addScaledVector(f.flatRight, side * topBack);
    out.y -= 2 + profile.erosion * 5;
    return out;
  }

  if (station === 13) {
    out.copy(top).addScaledVector(f.flatRight, side * (topBack + safeSpread * 0.42));
    out.y -= [13, 8, 14, 24][profile.chapter] + profile.erosion * 8;
    return out;
  }

  const base = field.point(s, side, 1, out);
  const openHeight = [
    3,
    profile.wallHeight * 0.38,
    profile.dropness > 0.52 ? -42 : profile.wallHeight * 0.28,
    -7,
  ][profile.chapter];
  const outerY = profile.constrained
    ? f.pos.y + profile.nearDy * 0.5 - 1
    : base.y + openHeight - profile.dropness * 12
      + field.groundNoise(s / 63 + side * 211) * 4;
  out.copy(base).addScaledVector(f.flatRight, side * (topBack + safeSpread));
  out.y = outerY;
  if (station === 15) {
    /* The skirt. Station 15 used to step six metres out and five metres down,
       which left the landform ribbon ending in a vertical face as tall as
       whatever the outer slope had reached — twenty to sixty metres of rock
       hanging in the air with the basin visible underneath it. Looking along
       the stage that face is edge-on, and a tall narrow slab standing floor to
       ceiling is exactly the "rock fin occluding the road" at the 96% stop:
       there are half a dozen of them there because the finish looks back
       across four earlier sections of the course.

       So the last station runs a long way out and settles towards the basin
       instead. The ribbon now feathers into the terrain it sits on and there
         is no terminating edge to see. Same vertex, same triangle count.

       Forty-two metres was the wrong constant for the second half of that,
       though, and badly so. The reach was fixed while the fall is whatever
       height the road happens to be at, and this road starts four hundred and
       seventy metres above the waterline: at the top of the stage the last
       quad of the ribbon came out as a single unbroken face dropping 469 m
       over 42 m of ground. That is an eighty-five degree plane the height of a
       mountain, running the whole length of the course, and it is both the
       "enormous flat vertical planes" of the review and — seen from the finish
       basin, which sits at the foot of it — most of the missing sky.

       The reach follows the fall now, so the flank lies back at a gradient a
       hillside could hold, and it is bounded by the same clearance every other
       outward step answers to so a flank cannot run under a neighbouring deck.
       Still one vertex and still the same triangle. */
    if (profile.constrained) {
      out.addScaledVector(f.flatRight, side * 0.25);
      out.y -= 1.5;
    } else {
      const basinY = field.coast.seaLevel + 22
        + field.groundNoise(s / 88 + side * 133) * 9;
      const top = out.y - 5;
      const fall = Math.max(0, top - basinY);
      /* Only a deck *below* limits how far the flank may run: it descends, so
         passing outside a neighbour that is above it goes under that
         neighbour's own hillside, while running out over one that is below
         would roof a road in. */
      const lateral = Math.abs((out.x - f.pos.x) * f.flatRight.x
        + (out.z - f.pos.z) * f.flatRight.z);
      const roomOut = Math.min(
        profile.nearDy < -8 ? Math.max(42, profile.clear * 1.7) : 420,
        /* And never out over the valley floor itself. Laying the flank back
           is only an improvement while it stays on its own side of the
           hill — run it past the road below and it becomes a roof, which is
           worse than the wall it replaced. */
        Math.max(12, profile.valleyD - lateral),
      );
      const reach = clamp(fall / FLANK_GRADIENT, 42, roomOut);
      out.addScaledVector(f.flatRight, side * reach);
      /* Where the room ran out the flank stops at the height the gradient got
         it to rather than plunging the rest of the way. The only places the
         room runs out are the ones with a roadbed below, and that deck's own
         ribbon is directly underneath to carry the ground on down. */
      out.y = Math.max(basinY, top - reach * FLANK_GRADIENT);
    }
  }
  return out;
}

/**
 * The plan and fall of a coastal bluff, level by level.
 *
 * These used to describe a smooth concave curve — every segment from the crest
 * down fell at about three to one, flattening only near the water. Under a sun
 * the bluff can hide that, because a facet's azimuth still changes its value.
 * In a cliff's own shadow it cannot: the only light left is the sky fill, the
 * sky fill is a function of the surface normal's vertical component alone, and
 * a face at three to one has the same vertical component as the one above it
 * whichever way it turns. So the whole bluff — fifty per cent of the frame at
 * the 92% stop — came back as one value with no modelling anywhere on it, and
 * no amount of noise fixed it, because noise in plan does not change n.y.
 *
 * Benched instead. Near-vertical faces alternate with near-level shelves, so
 * consecutive levels differ in the one quantity the fill actually responds to
 * and a shaded bluff reads as a stack of lit ledges and dark faces. It is also
 * simply what a sea cliff looks like. The total reach and the fall to the
 * waterline are unchanged, so the coastline itself does not move.
 */
const COAST_OFFSETS = [2.5, 4.2, 9, 11.5, 19, 24.5, 37, 46, 64, 82];
const COAST_DROPS = [0.05, 0.21, 0.27, 0.47, 0.54, 0.73, 0.80, 0.93, 0.98, 1];
/* The shelves that carry grass rather than bare rock: one in the wall band and
   one in the outer band, so a tall face never gets more than two. */
const COAST_GRASS_LEVELS = [3, 7];

/**
 * How much of a grass terrace a coastal level carries at this station.
 *
 * Three levels used to be lifted a metre and a half to seven and painted
 * grass-green unconditionally, wherever they landed. On a low headland that is
 * the intended run of shelves and it reads well. On a tall bluff the same lift
 * put a green table halfway up a rock face falling away at better than one to
 * one, and from the road that is a pale trapezoid with no landform under it —
 * a modelling error rather than a shelf.
 *
 * So the lift and the paint now share one gate: a terrace exists only where
 * the face below it is actually laid back, and a slow noise along the shore
 * breaks the run into separate shelves instead of one continuous stripe.
 */
function coastShelfAmount(field, s, side, level, profile) {
  if (!COAST_GRASS_LEVELS.includes(level)) return 0;
  const span = Math.max(6, profile.f.pos.y - field.coast.seaLevel);
  const rise = (COAST_DROPS[level + 1] - COAST_DROPS[level]) * span;
  const run = COAST_OFFSETS[level + 1] - COAST_OFFSETS[level];
  const laid = 1 - smoothstep(0.55, 1.5, rise / run);
  const along = smoothstep(-0.4, 0.25, field.wallNoise(s / 64 + level * 17 + side * 39));
  return laid * along;
}

/** Both edges of a grassed bench, for the paint. */
function grassShelf(field, s, side, level, profile) {
  return coastShelfAmount(field, s, side, level, profile) > 0.4
    || coastShelfAmount(field, s, side, level - 1, profile) > 0.4;
}

function coastalLandformPoint(field, s, side, station, out) {
  const profile = field.profile(s, side);
  const f = profile.f;
  if (profile.constrained && station >= 5) {
    return mergeRampPoint(field, s, side, station, profile, out);
  }
  const apron = [0, 0.12, 0.28, 0.5, 0.76, 1];
  if (station < apron.length) {
    field.point(s, side, apron[station], out);
    return out;
  }

  field.point(s, side, 1, _coastBase);
  const level = station - 6;
  const span = Math.max(6, _coastBase.y - field.coast.seaLevel);
  const wobble = field.wallNoise(s / 47 + level * 19 + side * 61) * (0.8 + level * 0.2);
  /* Two scales of plan noise on top of `wobble`, which on its own has a 47 m
     wavelength — five rows of the terrain grid — and so only bends the face
     rather than breaking it. The 33 m term lands a facet every three or four
     rows, which is about the size a facet wants to be at the distance this
     wall is seen from. The blocky one is piecewise constant over ninety metres
     of road and supplies the occasional vertical fault that stops one stretch
     of bluff from being an extrusion of the next; it is kept small, because at
     any real amplitude a step that is constant in s and varies by level is a
     rectangle, and a wall of rectangles is a worse read than a slab. */
  const facet = field.wallNoise(s / 33 + side * 23);
  const block = field.wallNoise(Math.floor((s + side * 43) / 91) * 6.13);
  /* A small per-level term on top of the two column-wide ones. Kept small on
     purpose: at any real amplitude a noise that decorrelates the levels gives
     every cell of the grid its own depth and the face tiles into rectangles,
     but with the column terms carrying the shape this is just enough to stop
     the bluff reading as one extruded section. */
  const jitter = field.wallNoise(s / 45 + level * 11 + side * 3);
  out.copy(_coastBase).addScaledVector(
    f.flatRight,
    side * Math.max(
      1,
      COAST_OFFSETS[level] * (1 + facet * 0.17 + block * 0.08 + jitter * 0.09) + wobble,
    ),
  );
  const shoreY = field.coast.seaLevel - (level === COAST_OFFSETS.length - 1 ? 5 : 0.4);
  /* Facet noise on the descent as well as in plan, weighted to the top of the
     face: the crest is where the bluff meets the sky and a ruled line there
     is the most visible thing a landform can get wrong. */
  const pitch = field.wallNoise(s / 22 + side * 7);
  const crest = 1 - smoothstep(0, 3.2, level);
  out.y = lerp(
    _coastBase.y, shoreY,
    clamp(COAST_DROPS[level] + pitch * 0.055 * (1 - COAST_DROPS[level]), 0, 1),
  ) + crest * field.wallNoise(s / 17 + level * 53 + side * 31) * 1.9;
  /* A soft lip on the grassed shelves. Small now that the bench is in the
     table itself; this only rounds its inner edge. */
  out.y += coastShelfAmount(field, s, side, level, profile)
    * Math.min(3.5, Math.max(1, span * 0.014));
  return out;
}

function landformPoint(field, s, side, station, out) {
  const profile = field.profile(s, side);
  inlandLandformPoint(field, s, side, station, _landA);
  coastalLandformPoint(field, s, side, station, _landB);
  out.lerpVectors(_landA, _landB, smoothstep(0.12, 0.72, profile.coastness));
  /* Held under the valley slope across the wall band and the back country: this
     is the mass a driver somewhere below is looking up at, and it is the mass
     that has been closing the sky. The floor keeps the cap clear of this road
     whatever it does to the skyline above it. */
  const f = profile.f;
  const lateral = Math.abs((out.x - f.pos.x) * f.flatRight.x
    + (out.z - f.pos.z) * f.flatRight.z);
  /* How far down the ladder the cone reaches.
   *
   * It used to start at station 10 everywhere, and that is not where a hillside
   * stops being a hillside. The cap falls with distance, so clipping the top
   * two rungs and leaving the rest alone builds a ladder that runs backwards:
   * from the finish basin, stations 8, 9, 10 and 11 of the massif at s≈2400 sit
   * 106, 78, 44 and 12 metres above the lens, and at s≈1188 station 9 stands 18
   * metres above station 8 with stations 10 upward shaved off behind it.
   *
   * That last one is the review's "roughly 150 m spire in the driver's forward
   * view", and it is why there is no `spire` identifier to find: nothing builds
   * a spire. Station 9 of the +1 ribbon runs for about forty-five metres of arc
   * length with its own back country cut away, and seen end-on down the stage
   * from s=966 — two hundred and five metres out, dead centre — a rung of wall
   * with nothing behind it is a needle. Broadside, the same defect is a
   * flat-topped slab, which is the other half of the "enormous flat vertical
   * planes" finding.
   *
   * It cannot simply start at 6. Beside a switchback the nearest deck below is
   * thirty metres down and eighty out, the cone is savage that close, and
   * running it down the ladder there erases the gorge's cut walls — which are
   * the road's own cutting and the whole reason that chapter reads as a gorge.
   * The two cases are told apart by how far the valley floor is: near, and this
   * is one road stacked over another, so only the back country answers for it;
   * far, and it is a hillside above a valley, which should be falling toward
   * the valley along its whole height.
   *
   * It costs the massif at s≈1200 most of its height, and that is the cone
   * doing what it is for rather than a side effect: that mass was standing out
   * past the deck below it, which is the one thing the cone exists to stop. */
  if (station >= VALLEY_FIRST_STATION) {
    /* The cone rising out of the valley, floored so it can never cut into the
       shoulder of the road that is building it. Tapering that floor away with
       distance was tried and is worse: it lets the cone bite into the near
       flank of a deck that is only thirty metres above another, and what that
       buys in sky at one station it loses at three by hollowing out the
       middle distance the frame was reading depth from. */
    const ceiling = Math.max(f.pos.y + 8, field.valleyCeiling(profile, lateral));
    if (out.y > ceiling) out.y = ceiling;
  }
  /* Measured but deliberately not enforced: `profile.shoreRoom` is how far
     this shoulder can run before it is standing in the sea, and on the run to
     the finish about three quarters of the mass filling the frame is past that
     line — the inland ladder does not know about the water and this function
     blends it with the coastal one, so wherever the sea alignment is partial
     the ribbon builds a hillside on open water.
     Three ways of cutting it back were tried — pulling the surplus stations
     onto the shoreline, sinking them under it, and a seventy-metre taper down
     to it — and all three measured *worse* at the finish than leaving them
     alone, by two stations. Whatever is behind that land is closing the frame
     harder than the land is. It is left in the profile because the next person
     to work on the finish will want the number, and taking the land away is
     not the move until that is understood. */
  return out;
}

const _slopeA = new THREE.Vector3();
const _slopeB = new THREE.Vector3();

/**
 * Whether a plant put here would be standing on ground or stuck to a wall.
 *
 * The station ladder is a shape description, not a terrain classifier: station
 * 9 is a ledge on a cut wall, a bench on a coastal bluff and a point halfway up
 * a switchback curtain, and the ranks that plant by station were putting trees
 * on all three. On the third the result is a tree growing horizontally out of
 * a vertical rock face — the "detached foliage quads" and the trees pinned to
 * the cliff in the review — because the anchor point is on the mesh but the
 * surface it is on is not ground.
 *
 * Sampling the neighbouring station gives the local gradient. Anything past
 * about fifty degrees is a face rather than a slope and carries nothing.
 */
function standable(field, s, side, station, limit = 1.25) {
  landformPoint(field, s, side, station, _slopeA);
  landformPoint(field, s, side, station + (station > 0 ? -1 : 1), _slopeB);
  const run = Math.hypot(_slopeA.x - _slopeB.x, _slopeA.z - _slopeB.z);
  return Math.abs(_slopeA.y - _slopeB.y) <= limit * Math.max(run, 0.35);
}

/**
 * The highest point of the wall, wherever the profile happens to put it.
 *
 * Station 11 is the top of a cut wall but only the middle of a switchback
 * merge ramp, so a tree line planted at a fixed station runs up the face of
 * one and along the skyline of the other. Taking the highest of the three
 * candidate stations puts it on the crest either way.
 */
function crestPoint(field, s, side, out) {
  let best = -Infinity;
  for (const station of [11, 12, 13]) {
    landformPoint(field, s, side, station, _point2);
    if (_point2.y > best) { best = _point2.y; out.copy(_point2); }
  }
  return out;
}

/**
 * Which of the four wall tones a rock facet is painted.
 *
 * A hemisphere light is a function of `normal.y` alone, so on a cut wall —
 * where every facet is steep and they differ mainly in which way round the
 * compass they face — it gives all of them the same value. That is fine while
 * the sun is on the wall and hopeless once it is not: the 52% frame had a
 * thirty-metre rock face filling half of shot as one unbroken navy plane, with
 * the outline pass drawing nothing because there was nothing to draw. An
 * azimuthal fill fixes the walls it happens to face and leaves the rest.
 *
 * So the variation goes into the paint, where the light cannot flatten it.
 * Patches a few facets across, and biased upward: the darkest of the four
 * tones is the rarest, because these faces are already sitting near the bottom
 * of the ladder and the point of the exercise is to spread them across rungs,
 * not to add another one below.
 *
 * The thresholds are the whole function and they have been wrong twice, in
 * opposite directions, for the same reason: `fbm2` sums `noise2`, `noise2` is
 * built from `rng()`, and `rng()` returns [0, 1). Three octaves therefore land
 * in [0, 0.875] with a mean near 0.44 — not in [-1, 1] around zero. Cutting at
 * 0.72/0.36 put nine facets in ten on the middle tone; correcting that to
 * 0.3/-0.02 put ninety-seven per cent on the palest one, which is the pale
 * sage mass filling two thirds of the 76% frame. These are the measured
 * quantiles of this exact expression (see tools/noisedist.mjs), so the four
 * tones come out at roughly 20/30/30/20.
 */
function wallPatch(paint, palette, s, side, station) {
  const n = paint(s / 62 + side * 31, station * 0.85 + 13)
    + paint(s / 26 + side * 7, station * 1.9 + 41) * 0.4;
  return palette.wall[n > 0.741 ? 2 : n > 0.622 ? 1 : n > 0.501 ? 0 : 3];
}

/**
 * The back country: stations 12 to 14, behind every wall and every crest.
 *
 * This was a single call to `palette.rock[0]`, which is most of the land area
 * in the stage painted one flat grey. Looking down on the map that is the
 * "large empty yellow-green plateaus and bare grey slabs filling most of the
 * landmass" in the review; from the road it is worse, because at the 92% stop
 * the whole right half of the frame is the reverse side of a hill fifty metres
 * away and all of it is one value, so the cel ladder has nothing to quantise
 * and the outlines have nothing to sit against.
 *
 * Real back country from a road is grass with the rock coming through where
 * the slope steepens, in patches at a scale of tens of metres. Two octaves of
 * the same noise the apron uses gives that, and it costs nothing: it is a
 * different index into a palette that already exists.
 */
function backSlope(paint, palette, s, side, station) {
  const n = paint(s / 96 + side * 23, station * 0.5 + 61)
    + paint(s / 31 + side * 41, station * 1.3 + 7) * 0.45;
  if (n > 0.80) return palette.rock[0];
  if (n > 0.72) return palette.rock[1];
  if (n > 0.646) return palette.ground[2];
  return n > 0.555 ? palette.ground[0] : palette.ground[1];
}

/* How far into the tunnel a station is, eased at both mouths. Shared by every
   surface that has to stop looking like open hillside once it is under the
   mountain. */
function boreDepth(s, span, fade = 16) {
  if (!span) return 0;
  const a = smoothstep(span.s0 - fade, span.s0 + fade * 0.35, s);
  const b = 1 - smoothstep(span.s1 - fade * 0.35, span.s1 + fade, s);
  return Math.max(0, Math.min(a, b));
}

/* Where the inland ribbon stops and the basin floor takes over as the ground
   on that side. Named and shared rather than written twice, because the two
   places that need it are four thousand lines apart: the loop below, which
   declines to build quads past it, and the crowd's footing gate, which has to
   know that `field.point` past it is not a surface. Written as two uses of one
   constant on purpose — a builder that stops at one station and a placement
   rule that trusts the ground to another is this project's pinned-partner bug
   with a five-kilometre lever arm. */
const BASIN_SHARE_FROM = 0.9;

function buildLandform(field, side) {
  const rows = field.count, cols = LANDFORM_STATIONS;
  const positions = new Float32Array(rows * cols * 3);
  const colors = new Float32Array(rows * cols * 3);
  const indices = new Uint32Array((rows - 1) * (cols - 1) * 6);
  const paintNoise = noise1(field.seed * 71 + (side < 0 ? 11 : 29));
  const groundPaint = fbm2(field.seed * 73 + (side < 0 ? 17 : 37), 3);
  /* The corridor apron does not stop at the tunnel mouth — it runs on under the
     mountain, and the half metre of it left showing between the tarmac and the
     foot of the tunnel ledge is grass-green. At the grazing angle a chase
     camera looks down a bore, that half metre is a bright green line the full
     length of both walls, and it was the single most conspicuous thing wrong
     with the interior. Roofing it over needs geometry that meets the road,
     which the verge audit rightly refuses; making it stone does not. */
  const _bore = new THREE.Color();
  const boreStone = new THREE.Color(0x39424a);
  let pi = 0, ci = 0, ii = 0;

  for (let i = 0; i < rows; i++) {
    const s = field.ss[i];
    const profile = field.profile(s, side);
    const palette = CHAPTERS[profile.chapter];
    const underRock = Math.max(
      boreDepth(s, field.tunnel), boreDepth(s, field.tunnel2)) * 0.95;
    for (let c = 0; c < cols; c++) {
      landformPoint(field, s, side, c, _point);
      positions[pi++] = _point.x;
      positions[pi++] = _point.y;
      positions[pi++] = _point.z;

      let hex;
      if (c < 5) {
        /* Two-dimensional, short-scale paint makes interlocking terrain
           patches. The old floor(s / 117) domains made 450 px rectangles. */
        const patch = groundPaint(s / 38 + side * 19, c * 0.61 + side * 7);
        if (c > 1 && patch > 0.79) {
          hex = patch > 0.87 ? palette.rock[1] : 0x73715a;
        } else {
          /* Keep the broad apron one family; species, grass and small rocks
             supply the close-scale variation without full-rung quilt blocks. */
          hex = palette.ground[0];
        }
      }
      else if (c <= 11) {
        /* Green only where the geometry actually built a shelf, and across
           both of that shelf's edges so the grass covers the bench rather
           than drawing a line along the back of it. Painting fixed levels
           green regardless is what put a grass-coloured facet on the vertical
           part of a rock face. */
        hex = profile.coastness > 0.34 && grassShelf(field, s, side, c - 6, profile)
          ? palette.ground[0]
          : wallPatch(groundPaint, palette, s, side, c);
      } else if (c < 15) {
        hex = profile.coastness > 0.34 && grassShelf(field, s, side, c - 6, profile)
          ? palette.ground[0]
          : backSlope(groundPaint, palette, s, side, c);
      }
      else hex = wallPatch(groundPaint, palette, s, side, c);
      /* Modelling used to be `0.9 + (c % 3) * 0.045` above the apron, which is
         three fixed values keyed on the station index — so every back slope in
         the stage carried the same three horizontal stripes in the same order,
         and at the scale these masses occupy in frame that reads as one flat
         value with a couple of ruled lines in it rather than as terrain. */
      const modelling = c >= 5
        ? 0.9 + (c % 3) * 0.03 + paintNoise(s / 44 + c * 29) * 0.075
        : 0.91 + paintNoise(s / 23 + c * 17) * 0.1;
      if (underRock > 0) hex = _bore.setHex(hex).lerp(boreStone, underRock).getHex();
      setColor(colors, ci, hex, modelling);
      ci += 3;
    }
  }

  const pushTriangle = (a, b, c) => {
    const ai = a * 3, bi = b * 3, ci = c * 3;
    const abx = positions[bi] - positions[ai], abz = positions[bi + 2] - positions[ai + 2];
    const acx = positions[ci] - positions[ai], acz = positions[ci + 2] - positions[ai + 2];
    const normalY = abz * acx - abx * acz;
    indices[ii++] = a;
    if (normalY < -1e-5) {
      indices[ii++] = c; indices[ii++] = b;
    } else {
      indices[ii++] = b; indices[ii++] = c;
    }
  };

  for (let i = 0; i < rows - 1; i++) {
    /* The finish road runs beside the basin floor. A second corridor surface
       here used to overlap the basin and the approaching section, producing
       the stack of fins in the 92% chase view. The rock support still closes
       the roadbed; the shared basin is the terrain on this side. */
    if (side > 0 && field.ss[i] >= field.track.length * BASIN_SHARE_FROM) continue;
    for (let c = 0; c < cols - 1; c++) {
      const a = i * cols + c, b = a + cols, d = a + 1, e = b + 1;
      if (side > 0) {
        pushTriangle(a, d, b);
        pushTriangle(d, e, b);
      } else {
        pushTriangle(a, b, d);
        pushTriangle(d, b, e);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices.slice(0, ii), 1));
  const split = geometry.toNonIndexed();
  geometry.dispose();
  const splitColors = split.attributes.color;
  for (let i = 0; i < splitColors.count; i += 6) {
    let rr = 0, gg = 0, bb = 0;
    const end = Math.min(i + 6, splitColors.count);
    for (let j = i; j < end; j++) {
      rr += splitColors.getX(j);
      gg += splitColors.getY(j);
      bb += splitColors.getZ(j);
    }
    const n = end - i;
    for (let j = i; j < end; j++) splitColors.setXYZ(j, rr / n, gg / n, bb / n);
  }
  return finishGeometry(split);
}

/* Lateral offset of the support's outer edge from the road centreline, and how
   far under the terrain its foot is buried. */
const SUPPORT_OFFSET = 7.48;
const SUPPORT_BURY = 2.5;

/**
 * The retaining bank under the road shoulder.
 *
 * This used to hang a fixed distance below the roadbed — a metre, plus
 * twenty-two on a coastal drop, plus up to forty-four more wherever a
 * switchback put another deck below. Nothing referred that depth to the ground
 * it was supposed to be retaining, and the landform ribbon runs continuously
 * from the road edge outward and downward at every station, so on the open
 * switchbacks the strip was not retaining anything: it was a two-triangle
 * curtain up to sixty-seven metres deep hanging in clear air below the deck,
 * with the sunset visible underneath it.
 *
 * That single surface is three of the review's findings at once. It is the
 * "enormous flat vertical plane" — one quad per nine metres of road, one flat
 * colour, and a top edge ruled with a straightedge. It is the "rectangular slab
 * floating in front of the cliff face", because that is literally what it is.
 * And measured, it is the sky: hiding it takes t=0.375 from no sky at all to
 * seven and a half per cent and t=0.408 from seven to twenty-one, which is more
 * than every terrain change in this pass put together.
 *
 * So the foot now follows the landform apron at the support's own offset and
 * buries itself a couple of metres under it, and a segment whose head is
 * already below ground is not emitted at all. The strip still closes the seam
 * between the roadbed and the terrain, which is the job it was added for; it no
 * longer stands in for a hillside that is already there.
 */
function buildRoadSupport(field, side) {
  const positions = [], colors = [];
  const paintNoise = noise1(field.seed * 89 + (side < 0 ? 13 : 31));
  const _ground = new THREE.Vector3();
  /* Where the landform ribbon's own surface is at the foot's offset. The apron
     stations are exactly `field.point` at fixed u, so this is the mesh the
     support has to meet rather than a second guess at it. */
  const groundAt = (profile, s) => {
    const u = clamp(SUPPORT_OFFSET / Math.max(1, profile.wallDist), 0, 1);
    return field.point(s, side, u, _ground).y;
  };
  const point = (s, bottom, out) => {
    const profile = field.profile(s, side);
    const f = profile.f;
    const bermScale = side < 0 ? f.bermL : f.bermR;
    const off = f.width * 0.5 + 4.08 + (bottom ? 3.4 : 0);
    out.copy(f.pos).addScaledVector(f.right, side * off)
      .addScaledVector(f.up, EDGE_DROP - bermScale * 0.25 - 0.06);
    if (bottom) {
      const lowerDeck = profile.constrained && profile.nearDy < -6
        ? Math.min(44, -profile.nearDy * 0.82)
        : 0;
      const reach = out.y - 1.1 - profile.dropness * 22 - lowerDeck;
      /* Never deeper than the ground needs, and never so shallow that the
         head is left standing above its own foot. */
      out.y = clamp(groundAt(profile, s) - SUPPORT_BURY, reach, out.y - 0.6);
    }
    return out;
  };

  for (let i = 0; i < field.count - 1; i++) {
    const s0 = field.ss[i], s1 = field.ss[i + 1];
    const a = point(s0, false, new THREE.Vector3());
    const b = point(s1, false, new THREE.Vector3());
    const c = point(s0, true, new THREE.Vector3());
    const d = point(s1, true, new THREE.Vector3());
    const profile = field.profile((s0 + s1) * 0.5, side);
    /* Wholly buried: the terrain already covers the head of the strip at both
       ends, so these two triangles can only ever be drawn from inside a hill. */
    if (groundAt(field.profile(s0, side), s0) > a.y + SUPPORT_BURY
      && groundAt(field.profile(s1, side), s1) > b.y + SUPPORT_BURY) continue;
    const palette = CHAPTERS[profile.chapter];
    const hex = palette.wall[profile.coastness > 0.34 ? 0 : 1];
    const light = 0.94 + paintNoise(s0 / 41) * 0.05;
    const verts = side > 0 ? [a, c, b, c, d, b] : [a, b, c, c, b, d];
    for (const p of verts) {
      positions.push(p.x, p.y, p.z);
      _color.setHex(hex).multiplyScalar(light);
      colors.push(_color.r, _color.g, _color.b);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return finishGeometry(geometry);
}

/**
 * Height and paint of the open country outside the road corridor.
 *
 * Lifted out of `buildBasin` because the wind turbines need to stand on the
 * hilltops it makes. Sampling the same function is the only way a turbine base
 * is guaranteed to be on the ground rather than a few metres above or below it.
 */
function basinSampler(seed, coast) {
  const heightNoise = fbm2(seed * 101 + 3, 4);
  const patchNoise = fbm2(seed * 107 + 19, 3);
  const paintNoise = noise1(seed * 103 + 11);
  const baseY = coast.seaLevel + 12;
  const radius = 1850;

  return (x, z, rr) => {
    const rim = smoothstep(720, radius, rr);
    const terrainAmp = lerp(3.5, 17, smoothstep(520, 1280, rr));
    const inlandY = baseY + (heightNoise(x / 180, z / 180) - 0.48) * terrainAmp
      + rim * (34 + heightNoise(x / 370 + 30, z / 370 - 20) * 42);
    const coastDistance = coast.signedDistanceXZ(x, z);
    const seaFloor = coast.seaLevel - 7 - Math.min(12, Math.max(0, coastDistance) * 0.01);
    const y = lerp(inlandY, seaFloor, smoothstep(-22, 7, coastDistance));

    let hex;
    if (coastDistance > 0) {
      hex = 0x173f6f;
    } else if (coastDistance > -8) {
      const shore = [0x68736c, 0xa99d76, 0x52665f, 0xd8c994];
      hex = shore[Math.abs(Math.floor((coastDistance + paintNoise(x / 53 + z / 71) * 5) / 4)) % shore.length];
    } else {
      const patch = patchNoise(x / 125 + 17, z / 125 - 31);
      const fold = heightNoise(x / 240 - 43, z / 240 + 12);
      if (patch > 0.68) {
        hex = patch > 0.82 ? 0x56645d : 0x77735a;
      } else {
        /* The dry-grass palette was a full rung brighter than the other two
           and it is the one that covers the open interior, so wherever it
           landed the map went pale. Pulled back towards the others: it should
           read as sun-bleached pasture next to woodland, not as a different
           material. */
        const palette = fold < 0.34
          ? [0x274f42, 0x356a47, 0x426f43, 0x315a46]
          : fold > 0.67
            ? [0x7c9a52, 0x8ba257, 0x688a4b, 0x9aab5f]
            : GROUND_COLORS;
        /* `0.5 + n` assumed the noise was signed. It is not: three octaves of
           `fbm2` sit in [0.09, 0.82] around a mean of 0.44, so that expression
           scaled to 2.0–5.5 and clamped almost everything onto the last entry
           of the palette. The brightest tone of the dry-grass set covering the
           whole interior is the "large empty yellow-green plateau". Remapping
           the noise's real range spreads the four tones evenly. */
        const t = clamp((patchNoise(x / 48 + 80, z / 48) - 0.26) / 0.36, 0, 0.999);
        hex = palette[Math.floor(t * palette.length)];
      }
    }
    return { y, hex, light: 0.88 + paintNoise(x / 67 + z / 89) * 0.11 };
  };
}

function buildBasin(track, seed, bounds, coast) {
  /* Was 20 x 56 over an 1850 m radius, which is a cell ninety metres across
     near the middle and two hundred at the rim. The colour is per-vertex, so
     at that resolution one palette entry covers an area the size of a village
     and the interior of the map reads as a handful of flat plateaus — the
     "large empty yellow-green plateaus" in the review are literally single
     triangles. Doubling the ring and sector counts costs about two thousand
     triangles across the whole basin and halves the patch size. */
  const rings = 28, sectors = 80, radius = 1850;
  const positions = [], colors = [], indices = [];
  const sampleTerrain = basinSampler(seed, coast);

  const centre = sampleTerrain(bounds.cx, bounds.cz, 0);
  positions.push(bounds.cx, centre.y, bounds.cz);
  setColor(colors, 0, centre.hex, centre.light);

  for (let r = 1; r <= rings; r++) {
    const rr = (r / rings) * radius;
    for (let s = 0; s < sectors; s++) {
      const a = (s / sectors) * Math.PI * 2;
      const x = bounds.cx + Math.cos(a) * rr;
      const z = bounds.cz + Math.sin(a) * rr;
      const sample = sampleTerrain(x, z, rr);
      positions.push(x, sample.y, z);
      const offset = colors.length;
      colors.length += 3;
      setColor(colors, offset, sample.hex, sample.light);
    }
  }

  for (let s = 0; s < sectors; s++) {
    indices.push(0, 1 + (s + 1) % sectors, 1 + s);
  }
  for (let r = 1; r < rings; r++) {
    const inner = 1 + (r - 1) * sectors;
    const outer = inner + sectors;
    for (let s = 0; s < sectors; s++) {
      const sn = (s + 1) % sectors;
      const a = inner + s, b = outer + s, c = inner + sn, d = outer + sn;
      indices.push(a, c, b, c, d, b);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  return finishGeometry(geometry);
}

function movingBasicMaterial(params, key, motion, fragmentMotion = '') {
  const material = new THREE.MeshBasicMaterial(params);
  material.onBeforeCompile = shader => {
    shader.uniforms.uTime = { value: 0 };
    material.userData.shader = shader;
    const varying = fragmentMotion ? 'varying vec3 vMotionWorld;\n' : '';
    shader.vertexShader = `uniform float uTime;\n${varying}` + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\n${motion}${fragmentMotion
        ? '\nvMotionWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;'
        : ''}`,
    );
    if (fragmentMotion) {
      shader.fragmentShader = `uniform float uTime;\n${varying}` + shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `${fragmentMotion}\n#include <opaque_fragment>`,
      );
    }
  };
  material.customProgramCacheKey = () => key;
  return material;
}

function animateMaterialOnRender(mesh, material) {
  mesh.onBeforeRender = () => {
    if (material.userData.shader) {
      material.userData.shader.uniforms.uTime.value = performance.now() * 0.001;
    }
  };
  return mesh;
}

function movingCelMaterial(params, key, motion, unlit = false) {
  const material = unlit ? unlitCelMaterial(params) : environmentCelMaterial(params);
  const compileCel = material.onBeforeCompile;
  material.onBeforeCompile = shader => {
    compileCel(shader);
    shader.uniforms.uTime = { value: 0 };
    material.userData.shader = shader;
    shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\n${motion}`,
    );
  };
  material.customProgramCacheKey = () => `coastal-motion-${key}`;
  return material;
}

/**
 * The sea is one inexpensive faceted sheet: colour is authored per cell, not
 * derived from a reflection or a photographic normal map. Long depth bands
 * remain legible at 100 km/h while small along-shore breaks stop them looking
 * like perfect stripes. A sub-metre vertex motion is enough to keep the broad
 * shape alive without turning it into a water-shader demonstration.
 */
function buildOcean(coast, seed) {
  const pad = 2400;
  const x0 = coast.bounds.x0 - pad, x1 = coast.bounds.x1 + pad;
  const z0 = coast.bounds.z0 - pad, z1 = coast.bounds.z1 + pad;
  const cells = 8;
  const positions = [];
  const colors = [];
  const paint = noise1(seed * 191 + 29);

  const push = (point, hex, light) => {
    positions.push(point.x, point.y, point.z);
    _color.setHex(hex).multiplyScalar(light);
    colors.push(_color.r, _color.g, _color.b);
  };
  const nearColor = new THREE.Color(0x1158a6);
  const pushNear = point => {
    positions.push(point.x, point.y, point.z);
    /* The grid is geometry, not a paint map: per-cell or per-vertex depth
       colours quantised into giant rectangular overlays from high cameras.
       Continuous shader swells and the separate foam ribbons carry the bands. */
    colors.push(nearColor.r, nearColor.g, nearColor.b);
  };

  for (let iz = 0; iz < cells; iz++) {
    const za = lerp(z0, z1, iz / cells);
    const zb = lerp(z0, z1, (iz + 1) / cells);
    for (let ix = 0; ix < cells; ix++) {
      const xa = lerp(x0, x1, ix / cells);
      const xb = lerp(x0, x1, (ix + 1) / cells);
      const mx = (xa + xb) * 0.5, mz = (za + zb) * 0.5;
      const hex = 0x1158a6;
      const light = 1;
      const a = new THREE.Vector3(xa, coast.seaLevel, za);
      const b = new THREE.Vector3(xb, coast.seaLevel, za);
      const c = new THREE.Vector3(xa, coast.seaLevel, zb);
      const e = new THREE.Vector3(xb, coast.seaLevel, zb);
      for (const p of [a, b, c, b, e, c]) push(p, hex, light);
    }
  }

  /* A denser grid is limited to the playable headland. Quantised distance
     colours produce clean shallow-to-deep steps without the radial spikes
     that independent offset ribbons create around overlapping switchbacks. */
  const nearPad = 380;
  const nx0 = coast.bounds.x0 - nearPad, nx1 = coast.bounds.x1 + nearPad;
  const nz0 = coast.bounds.z0 - nearPad, nz1 = coast.bounds.z1 + nearPad;
  const nearCells = 32;
  for (let iz = 0; iz < nearCells; iz++) {
    const za = lerp(nz0, nz1, iz / nearCells);
    const zb = lerp(nz0, nz1, (iz + 1) / nearCells);
    for (let ix = 0; ix < nearCells; ix++) {
      const xa = lerp(nx0, nx1, ix / nearCells);
      const xb = lerp(nx0, nx1, (ix + 1) / nearCells);
      const y = coast.seaLevel + 0.08;
      const a = new THREE.Vector3(xa, y, za);
      const b = new THREE.Vector3(xb, y, za);
      const c = new THREE.Vector3(xa, y, zb);
      const e = new THREE.Vector3(xb, y, zb);
      for (const p of [a, b, c, b, e, c]) pushNear(p);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  finishGeometry(geometry);
  const material = movingBasicMaterial(
    { vertexColors: true, side: THREE.DoubleSide, fog: false },
    'coastal-ocean-bands',
    `transformed.y += sin(position.x * 0.014 + position.z * 0.011 + uTime * 0.42) * 0.22;
     transformed.y += sin(position.x * 0.031 - position.z * 0.019 - uTime * 0.27) * 0.11;`,
    `float phase = vMotionWorld.x * 0.018 + vMotionWorld.z * 0.011 + uTime * 0.14
       + sin(vMotionWorld.x * 0.004 - vMotionWorld.z * 0.006 - uTime * 0.04) * 0.9;
     float swell = sin(phase);
     float broken = step(-0.28, sin(vMotionWorld.x * 0.005 - vMotionWorld.z * 0.007
       + sin(vMotionWorld.z * 0.003) * 0.7));
     float crest = step(0.82, swell) * broken;
     float trough = step(swell, -0.92) * 0.45;
     outgoingLight *= 0.96 + crest * 0.13 - trough * 0.045;`,
  );
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'ocean-bands';
  mesh.receiveShadow = false;
  return animateMaterialOnRender(mesh, material);
}

/** Three broken cream-white ribbons make the shore readable from the racing
    line. Their phase drifts slowly in and out but the coastline itself stays
    fixed, so motion never looks like the whole ocean sliding. */
function buildFoam(coast, seed) {
  const positions = [];
  const colors = [];
  const r = rand(rng(seed * 193 + 47));
  const breakNoise = noise1(seed * 197 + 13);
  const bands = [
    { depth: 4.5, width: 4.2, color: 0xfff3d3, keep: -0.55 },
    { depth: 16, width: 2.8, color: 0xdff4e9, keep: -0.2 },
    { depth: 34, width: 1.7, color: 0xb9e8e5, keep: 0.12 },
  ];
  const segments = Math.ceil(coast.track.length / 24);

  const push = (point, hex, light) => {
    positions.push(point.x, point.y + 0.34, point.z);
    _color.setHex(hex).multiplyScalar(light);
    colors.push(_color.r, _color.g, _color.b);
  };

  for (let band = 0; band < bands.length; band++) {
    const spec = bands[band];
    for (let i = 0; i < segments; i++) {
      const sa = lerp(0, coast.track.length, i / segments);
      const sb = lerp(0, coast.track.length, (i + 1) / segments);
      if (breakNoise((sa + sb) / 85 + band * 91) < spec.keep) continue;
      const wobble = breakNoise((sa + sb) / 46 + band * 137) * (1.2 + band * 0.55);
      const d0 = spec.depth + wobble - spec.width * 0.5;
      const d1 = spec.depth + wobble + spec.width * 0.5;
      const a = coast.shorePoint(sa, d0, new THREE.Vector3());
      const b = coast.shorePoint(sb, d0, new THREE.Vector3());
      const c = coast.shorePoint(sa, d1, new THREE.Vector3());
      const e = coast.shorePoint(sb, d1, new THREE.Vector3());
      /* A radial sea-side change at a tight hairpin deliberately leaves a
         break instead of drawing a ribbon straight across the road. */
      if (a.distanceTo(b) > 72 || c.distanceTo(e) > 72) continue;
      const light = r.f(0.92, 1.04);
      for (const p of [a, b, c, b, e, c]) push(p, spec.color, light);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  finishGeometry(geometry);
  const sx = coast.sea.x.toFixed(5), sz = coast.sea.z.toFixed(5);
  const material = movingBasicMaterial(
    { vertexColors: true, side: THREE.DoubleSide, fog: false },
    'coastal-foam-motion',
    `float foamDrift = sin(position.x * 0.025 + position.z * 0.018 + uTime * 0.55) * 1.15;
     transformed.x += ${sx} * foamDrift;
     transformed.z += ${sz} * foamDrift;
     transformed.y += sin(position.x * 0.041 - position.z * 0.027 + uTime * 0.71) * 0.10;`,
  );
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'shore-foam';
  return animateMaterialOnRender(mesh, material);
}

function grounded(geometry) {
  geometry.computeBoundingBox();
  geometry.translate(0, -geometry.boundingBox.min.y, 0);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * The volume the tunnel occupies, as a list of road-centre samples.
 *
 * Held at module scope and consulted by `makeInstances` rather than threaded
 * through every scatter builder. There are twenty instanced sets in this file
 * — trees, shrubs, boulders, gravel, grass, flowers, marker posts, tyre
 * stacks, hay bales — and the rule they all have to obey is the same one:
 * nothing grows inside a mountain. One gate that every one of them passes
 * through is both cheaper to write and impossible to forget to apply.
 */
let TUNNEL_KEEPOUT = null;

function setTunnelKeepout(field, spans) {
  TUNNEL_KEEPOUT = null;
  const samples = [];
  for (const span of spans) {
    if (!span) continue;
    for (let s = span.s0 - 14; s <= span.s1 + 14; s += 5) {
      const f = field.track.frameAt(clamp(s, 0, field.track.length));
      const { half, crown } = boreSection(f.width);
      samples.push({
        x: f.pos.x, y: f.pos.y, z: f.pos.z,
        /* Wide enough to cover the outer rock on the seaward nose, which is the
           side a shrub would otherwise be found hovering off. */
        radius: half + 19, top: crown * 2.4, bottom: 26,
      });
    }
  }
  TUNNEL_KEEPOUT = samples.length ? samples : null;
}

function insideTunnelRock(position) {
  if (!TUNNEL_KEEPOUT) return false;
  for (const k of TUNNEL_KEEPOUT) {
    const dx = position.x - k.x, dz = position.z - k.z;
    if (dx * dx + dz * dz > k.radius * k.radius) continue;
    const dy = position.y - k.y;
    if (dy < k.top && dy > -k.bottom) return true;
  }
  return false;
}

function makeInstances(geometry, material, items, name, shadows = true) {
  if (TUNNEL_KEEPOUT) items = items.filter(i => !insideTunnelRock(i.position));
  const mesh = new THREE.InstancedMesh(geometry, material, items.length);
  mesh.name = name;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    dummy.position.copy(item.position);
    dummy.rotation.set(item.rotation.x, item.rotation.y, item.rotation.z);
    dummy.scale.copy(item.scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    if (item.color !== undefined) mesh.setColorAt(i, _color.setHex(item.color));
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  mesh.computeBoundingBox();
  mesh.computeBoundingSphere();
  return mesh;
}

/**
 * Where a bore can go.
 *
 * Three things have to be true at once and none of them is negotiable. There
 * must be rock above the road for the whole run, which on a shelf road means a
 * tall inland wall at the *weakest* cross-section, not on average — one thin
 * spot and the tunnel is a hole in the sky. The run must be near enough to
 * straight that the exit is visible from the entrance, because the light at
 * the end is the entire effect and a bend hides it. And it wants to be
 * somewhere the road is already dropping, so the aperture rises into frame as
 * you come down to it.
 *
 * Scouted first at s≈5300 — a section that probes as enclosed on every side —
 * and it does not work: the enclosure there comes from landforms forty to
 * ninety metres off, with only twelve metres of wall at the kerb. There is no
 * rock at the road to bore through. This scan finds the sites that do have it.
 */
const _probe = new THREE.Vector3();

function pickTunnel(field, track, coast, seed, opts = {}) {
  /* The default call is the shipped late tunnel, byte-for-byte: every default
     below restates the constant that used to be written inline. The options
     exist for the EARLY bore (see the second call in buildEnvironment), which
     wants the same scan over a different window with a shorter length —
     one copy of the scoring, two sites. `rails` skips candidates a guardrail
     crosses (nothing else keeps a rail out of a bore; the late tunnel has
     been relying on siting luck), and `avoid` keeps the two bores apart. */
  const {
    sFrom = 450, sTo = track.length - 220,
    length = clamp(track.length * 0.024, 105, 150),
    salt = 13, rails = null, avoid = null,
  } = opts;
  const avoids = (Array.isArray(avoid) ? avoid : [avoid]).filter(Boolean);
  const r = rand(rng(seed * 787 + salt));
  const shortlist = [];
  /* Not in the opening seconds. Weighting the approach sightline pulled two
     seeds to a bore starting a little over two hundred metres in, which is
     four seconds after the lights: the player is put in a hole before they
     have seen the stage they are driving through, and the light at the end
     lands on someone who has not yet been in the light. */
  for (let s = sFrom; s < Math.min(sTo, track.length - 220) - length; s += 8) {
    /* A span may carry its own clearance. The default 140 is bore-to-bore
       spacing; the early ramp band passes 0 because its span already encodes
       the ramp veto's exact margins, and a portal opening a hundred metres
       past a lip — jump, then tunnel — is exactly the composition wanted. */
    if (avoids.some(a => s + length > a.s0 - (a.margin ?? 140)
      && s < a.s1 + (a.margin ?? 140))) continue;
    if (rails) {
      let railed = false;
      for (let x = s - 30; x <= s + length + 30 && !railed; x += STEP) {
        if (rails[clamp(Math.round(x / STEP), 0, track.count - 1)]) railed = true;
      }
      if (railed) continue;
    }
    let wall = Infinity;
    for (let k = 0; k <= 8; k++) {
      const t = s + (length * k) / 8;
      wall = Math.min(wall, field.profile(t, -coast.seaSideAt(t)).wallHeightBare);
    }
    if (wall < 34) continue;
    const a = track.frameAt(s), b = track.frameAt(s + length);
    /* Largest departure from the chord, not the departure at the midpoint. A
       midpoint sample scores an S-bend as dead straight, which is how a bore
       whose approach measured half a metre of curvature came to have its mouth
       hidden behind a hillside until twelve metres out. */
    const swing = (p, q) => {
      const cx = q.pos.x - p.pos.x, cz = q.pos.z - p.pos.z;
      const chord = Math.hypot(cx, cz) || 1;
      let worst = 0;
      for (let n = 1; n < 8; n++) {
        const t = track.frameAt(p.s + ((q.s - p.s) * n) / 8);
        worst = Math.max(worst,
          Math.abs((t.pos.x - p.pos.x) * cz - (t.pos.z - p.pos.z) * cx) / chord);
      }
      return worst;
    };
    const bend = swing(a, b);
    if (bend > 11) continue;
    /* And the run *up* to it has to be straight, which the first version of
       this scan did not ask for. It put the best-scoring bore just around a
       headland: the mouth came into view forty-five metres out, which at a
       hundred and thirty is a second and a bit, so the tunnel did not read as
       something you were driving towards, it read as something that happened.
       Measured the same way as the bore's own bend, over the hundred and forty
       metres before the portal, and weighted harder — a bend inside the bore
       costs you the exit, a bend before it costs you the whole approach. */
    const approach = Math.max(0, s - 170);
    const pa = track.frameAt(approach);
    const sight = swing(pa, a);
    /* And straight is not enough on its own, because a road can be dead
       straight and still hide its own tunnel over a brow. Measured against the
       chase lens rather than the road: the eye is about four metres up and the
       crown of the bore about seven, so a crest has to lift a couple of metres
       above the line from the viewpoint to the portal before it starts eating
       the opening — and once it does, it eats all of it. Three seeds showed
       the mouth only from twelve, fifty-two and sixty-eight metres with a
       perfectly straight approach, and this is what they had in common. */
    let crest = 0;
    for (let n = 1; n < 8; n++) {
      const u = n / 8;
      const t = track.frameAt(approach + (s - approach) * u);
      crest = Math.max(crest, t.pos.y - (pa.pos.y + (a.pos.y - pa.pos.y) * u));
    }
    const brow = Math.max(0, crest - 1.6);
    /* And then the test the proxies were standing in for: walk the line from
       the chase lens to the middle of the portal and ask the terrain whether
       it is in the way. Straightness and brow between them still left three
       seeds whose mouth appeared twelve, sixty-eight and seventy-six metres
       out, every one of them behind a shoulder of corridor hillside that no
       measure of the road's own shape can see. This one costs eight terrain
       samples per candidate and settles it. */
    const score = Math.min(wall, 70) - bend * 2.2 - sight * 3.4 - brow * 4.5
      + (a.pos.y - b.pos.y) * 0.35;
    shortlist.push({ s0: s, s1: s + length, wall, bend, sight, crest, score, approach });
  }
  if (!shortlist.length) return null;

  /* Then the test the proxies were standing in for, on the dozen best only
     because it is the expensive one: walk the line from the chase lens to the
     middle of the portal and ask the terrain, anywhere on the map, whether it
     is in the way.
     *
     * Straightness and brow between them still left three seeds whose mouth
     * appeared twelve, sixty-eight and seventy-six metres out. The shape of
     * the road could not have predicted any of them, because the hillside
     * doing the hiding does not belong to the approach — this stage doubles
     * back on itself, so the mass between the lens and the portal can be the
     * corridor wall of a section a kilometre away in road distance. Hence
     * nearest-station rather than approach-station: whatever piece of terrain
     * is actually there is the piece that gets asked.
     */
  const hiddenCount = (cand) => {
    const a = track.frameAt(cand.s0);
    const pa = track.frameAt(cand.approach);
    const ex = pa.pos.x - pa.tan.x * 9, ez = pa.pos.z - pa.tan.z * 9;
    const eyeY = a.pos.y + 4.2;
    let hidden = 0;
    for (let n = 1; n < 10; n++) {
      const u = n / 10;
      const rx = ex + (a.pos.x - ex) * u, rz = ez + (a.pos.z - ez) * u;
      const ry = eyeY + (a.pos.y + 4.0 - eyeY) * u;
      let f = null, bd = Infinity;
      for (const q of track.frames) {
        const e = (q.pos.x - rx) ** 2 + (q.pos.z - rz) ** 2;
        if (e < bd) { bd = e; f = q; }
      }
      const lat = (rx - f.pos.x) * f.flatRight.x + (rz - f.pos.z) * f.flatRight.z;
      const off = Math.abs(lat) - f.width * 0.5;
      if (off <= 0) continue;
      const dir = lat >= 0 ? 1 : -1;
      /* Against the landform ribbon the mesh is actually built from, not
         against the corridor sampler. The corridor stops at the top of the cut
         wall, so asking it about a point beyond that returns the wall top and
         reports clear — while the thing standing in the way is the back slope
         behind it, which is where all three of the stubborn seeds were hiding
         their portal. */
      let above = -1e9;
      for (let c = 0; c < LANDFORM_STATIONS; c++) {
        landformPoint(field, f.s, dir, c, _probe);
        const cLat = Math.abs((_probe.x - f.pos.x) * f.flatRight.x
          + (_probe.z - f.pos.z) * f.flatRight.z);
        if (cLat > Math.abs(lat) + 6) break;
        if (cLat >= Math.abs(lat) - 6) above = Math.max(above, _probe.y);
      }
      if (above > ry) hidden++;
    }
    return hidden;
  };
  shortlist.sort((p, q) => q.score - p.score);
  let best = null;
  for (const cand of shortlist.slice(0, 14)) {
    cand.hidden = hiddenCount(cand);
    cand.score -= cand.hidden * 11;
    if (!best || cand.score > best.score) best = cand;
  }
  if (!best) return null;
  best.s0 += r.f(-6, 6);
  best.s1 += r.f(-6, 6);
  return best;
}

/* Where buildGuardRail will decide it wants a rail, per frame — a mirror of
 * track.js railWants, which is deliberately not exported and cannot be edited
 * this round. THE TWO MUST AGREE: same noise stream (noise1(77) from
 * core/rng.js, shared by both files), same thresholds, same four smoothing
 * passes. This file has been bitten by two copies of one rule drifting apart
 * (the BERM cross-section put a car 1.25 m above its own rock), so if
 * track.js railWants ever changes, change this with it. Used by the early
 * bore scan and the early ramp scan, both of which need to stay off rails —
 * a rail through a ramp buries its posts, a rail through a bore threads the
 * kerb ledge. */
function railWantsMirror(track) {
  const cliffNoise = noise1(77);
  const wants = new Int8Array(track.count);
  for (let i = 0; i < track.count; i++) {
    const f = track.frames[i];
    if (f.s < 30 || f.s > track.length - 50) continue;
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
 * Extra ramps for the OPENING of the stage, appended to what pickRamps chose.
 *
 * Why this exists rather than a bigger `want` on pickRamps: the user asked
 * for jumps at the START, and on the default seed the first third has no
 * positive-scoring station at all — measured, its only rail-free unvetoed
 * band (lip 1044–1056 on seed 22) is killed purely by the runout preference
 * (−500), with a dead-straight, full-width, lit, boom-clear landing.
 * pickRamps' own doc says a short runout is a preference, not a veto, and
 * "a workmanlike ramp is better than the missing half of the mechanic".
 *
 * So this scan restates pickRamps' terms over the first third only, with
 * exactly one relaxation: the runout penalty is waived IF the landing
 * compensates — straight (landCurv ≤ 0.0025), uncompressed (sag ≥ −0.6) and
 * wide (landW ≥ 9.2) — so the car is braking on a clean straight rather
 * than jumping into a corner. EVERYTHING ELSE IS pickRamps' OWN RULE, same
 * constants imported from track.js: the air veto (1.20–2.40 s) is untouched,
 * approach/landing curvature and swing vetoes are untouched, and a rail
 * crossing is HARDER here (a skip, not −600) because burying rail posts in
 * an up-face is a mesh defect, not a preference. Sun exposure and the camera
 * boom are real rays against the same SolidWorld pickRamps used.
 */
/* The geometric half of the early-ramp scan — everything that needs no
   raycast — shared by appendEarlyRamps and by buildEnvironment, which runs it
   BEFORE siting the early bore so the tunnel yields to the stage's best
   early jump band. On the default seed they otherwise fight over the same
   hundred metres: the only viable ramp band in the first third is lip
   1044–1056 and the early bore's best site was 1023–1122, and a tunnel that
   eats the only early jump answers the wrong half of the request. */
function earlyRampRows(track, field, bores) {
  const N = track.courseCount, L = track.length, F = track.frames;
  const G = 9.81;
  const GRIP = 0.86;             // what the AI plans for — driver.js
  const PAD_GAIN = 4.5;          // m/s the pad is worth by the lip

  /* The speed profile the field would actually drive — pickRamps' own, same
     constants, same three passes. See track.js:1288 for why a bare
     sqrt(GRIP·g·R) is not it. */
  const v = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let peak = 0;
    for (let d = 0; d < 46; d += 6) {
      const f = track.frameAt(Math.min(F[i].s + d, L));
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

  const rails = railWantsMirror(track);
  const at = (s) => track.frameAt(clamp(s, 0, L - 1));
  const yAt = (s) => at(s).pos.y;

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
  for (let i = Math.ceil(420 / STEP); i * STEP < L * 0.34; i += 2) {
    const lip = i * STEP;
    const foot = lip - RAMP_UP_LEN;
    const pad0 = foot - PAD_BEFORE, pad1 = pad0 + PAD_LEN;
    if (pad0 < 140) continue;

    /* Lip speed, made ballistically honest. vAt's backward braking pass runs
       straight through the ballistic span, so at a lip whose landing faces a
       corner it reports a speed that assumes braking IN THE AIR — on the
       shipped seed-22 site it said 41.5 m/s and cars measurably crossed at
       34–38, touching down 12–25 m short of the record's `land`. That error
       is not cosmetic: `track.boostWindow` runs to `land + 20`, and driver.js
       lifts its plan by PAD_PLAN inside the window, so an overlong `land`
       holds every bot (and the autopilot) +6 m/s over the corner plan
       through the first half of its real braking zone. Measured on the
       default seed: 14 near-stops at the s≈1160 corner entry across an
       11-race skill sweep, up to 7.4 s each.
       So cap the lip speed at what FULL braking (8.6 m/s², the car's actual
       straight-line limit — not the planner's 5.8 margin) can recover after
       touchdown against the field's own speed plan, and iterate because the
       touchdown point moves with the speed. Sites with a real runout are
       untouched — there the bound sits above the pad-boosted speed — and the
       air veto below still reads the honest number, so a landing so
       corner-choked that honest air falls under 1.20 s is refused outright
       rather than shipped with a flattering record. */
    const speed0 = Math.min(vAt(foot) + PAD_GAIN, 56);
    let speed = speed0;
    let land = lip + 2 * speed * RAMP_LIP_SLOPE / G * speed;
    /* Half-step damping: the raw map oscillates (a long landing caps the
       speed hard, the capped speed shortens the landing, which uncaps it),
       and an undamped loop can stop mid-swing with the air time parked on
       the 1.20 s veto floor. Damped, it settles in a few steps. */
    for (let it = 0; it < 8; it++) {
      let allow = 99;
      for (let d = 3; d <= 250; d += 3) {
        const v = vAt(land + d);
        const bound = Math.sqrt(v * v + 2 * 8.6 * d);
        if (bound < allow) allow = bound;
      }
      const next = Math.min(speed0, (speed + Math.min(speed0, allow)) * 0.5);
      land = lip + 2 * next * RAMP_LIP_SLOPE / G * next;
      if (Math.abs(next - speed) < 0.2) { speed = next; break; }
      speed = next;
    }
    const air = 2 * speed * RAMP_LIP_SLOPE / G;
    const dist = air * speed;
    if (land > L - 160) continue;

    /* Off both bores, with pickRamps' own margins. */
    let inBore = false;
    for (const bore of bores) {
      if (!bore) continue;
      const fade = bore.fade ?? 16;
      if (lip > bore.s0 - 90 - fade && foot < bore.s1 + 40 + fade) inBore = true;
    }
    if (inBore) continue;

    /* Rails are a skip here, not a −600. */
    let rail = 0;
    for (let x = pad0; x <= land + 25; x += STEP) {
      if (rails[clamp(Math.round(x / STEP), 0, N - 1)]) rail = 1;
    }
    if (rail) continue;

    const appCurv = maxCurv(pad0 - 40, foot);
    const appSwing = swing(pad0 - 40, foot);
    const landCurv = maxCurv(lip, land + 25);
    if (appCurv > 0.0060 || landCurv > 0.0075 || appSwing > 6
      || air < 1.20 || air > 2.40) continue;

    let runout = 0;
    for (let d = 0; d < 300; d += 3) {
      if (vAt(land + d) < speed * 0.80) break;
      runout = d;
    }
    let w = 99, landW = 99;
    for (let x = foot - 6; x <= lip + 6; x += 3) w = Math.min(w, at(x).width);
    for (let x = land - 15; x <= land + 15; x += 3) landW = Math.min(landW, at(x).width);
    const sag60 = yAt(lip) + at(lip).grade * 60 - yAt(lip + 60);
    let brow = 0;
    {
      const a = Math.max(0, lip - 110);
      for (let n = 1; n < 12; n++) {
        const u = n / 12;
        brow = Math.max(brow, yAt(a + (lip - a) * u) - (yAt(a) + (yAt(lip) - yAt(a)) * u));
      }
    }
    let gap = 99;
    if (field) {
      for (const x of [foot, lip, land]) {
        for (const side of [-1, 1]) gap = Math.min(gap, field.profile(x, side).wallDist);
      }
    }

    /* pickRamps' scoring, with the one documented relaxation. */
    const cleanLanding = landCurv <= 0.0025 && sag60 >= -0.6 && landW >= 9.2;
    let score = 0;
    if (brow > 1.4) score -= 400;
    if (runout < 80 && !cleanLanding) score -= 500;
    if (w < 9.2) score -= 300;
    if (landW < 9.2) score -= 300;
    if (sag60 < -0.6) score -= 250;
    score += air * 60 + Math.min(runout, 200) * 0.5 + Math.min(gap, 20) * 4
      - appCurv * 12000 - landCurv * 14000 - brow * 40 - appSwing * 6;
    if (score <= 0) continue;

    rows.push({
      lip, foot, pad0, pad1, land: +land.toFixed(1),
      speed: +speed.toFixed(1), air: +air.toFixed(2), dist: +dist.toFixed(1),
      appCurv, appSwing, landCurv, runout, rail: 0, w, landW,
      sag60: +sag60.toFixed(2), brow: +brow.toFixed(2), gap: +gap.toFixed(1),
      grade: +at(lip).grade.toFixed(3), inBore: 0, veto: false,
      score: +score.toFixed(0), lit: 0, boom: 99,
    });
  }
  rows.sort((a, b) => b.score - a.score || a.lip - b.lip);
  return rows;
}

export function appendEarlyRamps(track, field, coast, seed, opts = {}) {
  const {
    bores = [], sunDirection = null, solid = null, want = 2, existing = [],
  } = opts;
  const L = track.length;
  const at = (s) => track.frameAt(clamp(s, 0, L - 1));
  const rows = earlyRampRows(track, field, bores);

  let sunElev = 0, sunX = 0, sunZ = 0;
  if (sunDirection) {
    const h = Math.hypot(sunDirection.x, sunDirection.z) || 1;
    sunX = sunDirection.x / h; sunZ = sunDirection.z / h;
    sunElev = Math.atan2(sunDirection.y, h);
  }

  /* The two expensive criteria, exactly as pickRamps fires them, on a
     shortlist only. Boom clearance is a hard requirement; the lit bonus is
     pickRamps' own +120. */
  const BOOM_BACK = 9.9, BOOM_UP = 3.1 - 1.2, BOOM_SKIN = 0.55;
  const _o = new THREE.Vector3(), _dir = new THREE.Vector3();
  const rays = (r) => {
    if (!solid) { r.lit = 1; r.boom = 99; return r; }
    let sunFree = 400;
    for (const x of [r.lip, r.lip + r.dist * 0.5]) {
      const f = at(x);
      _o.copy(f.pos).addScaledVector(f.up, 3.0);
      sunFree = Math.min(sunFree, sunDirection
        ? solid.raycast(_o.x, _o.y, _o.z, sunX * Math.cos(sunElev), Math.sin(sunElev),
          sunZ * Math.cos(sunElev), 400, 0.8)
        : 400);
    }
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

  const picked = [];
  const clearOf = (r) => ![...existing, ...picked].some(p =>
    Math.abs(p.lip - r.lip) < 260 || Math.abs(p.land - r.lip) < 200
      || Math.abs(r.land - p.lip) < 200);
  let tested = 0;
  for (const r of rows) {
    if (picked.length >= want || tested >= 24) break;
    if (!clearOf(r)) continue;
    rays(r); tested++;
    if (r.boom < 0) continue;
    picked.push(r);
  }
  picked.sort((a, b) => a.lip - b.lip);
  return picked;
}

/* How far into a bore a station is — track.js boreFloorFactor, restated
   because it is not exported. Same fade, same eased mouths. */
function boreFloorFactor2(s, span) {
  if (!span) return 0;
  const { s0, s1, fade = 16 } = span;
  if (s < s0 - fade || s > s1 + fade) return 0;
  const inAt = smoothstep(s0 - fade, s0 + fade * 0.35, s);
  const outAt = 1 - smoothstep(s1 - fade * 0.35, s1 + fade, s);
  return Math.min(inAt, outAt);
}

/**
 * The second bore's floor treatment, applied to geometry track.js already
 * built for the FIRST bore.
 *
 * buildRoad and buildBerms take one `bore` and their treatment is colour
 * only — no vertex moves — so the early tunnel gets the same treatment as a
 * post-pass rather than an edit to a fenced file. Road: the base grid is one
 * row of `columns` per frame in station order, blended toward the same
 * 0x363d44 by factor·0.82; the appended detail/patch vertices are found by
 * projection and blended the same way (this loses the ±2.5% speckle on the
 * blend target — under an 82% blend to a flat tone and a quantising ladder,
 * that is below a rung everywhere). Berms: rows of P per frame; the
 * per-vertex value modulation v is reconstructed exactly from the known base
 * colour of each ring index, so lerp(base,stone,u)·v is reproduced to the
 * float, not approximated.
 */
export function paintSecondBore(track, roadGeometry, bermGeometries, span) {
  if (!span) return;
  const N = track.count;

  /* ---- road ------------------------------------------------------------ */
  {
    const colors = roadGeometry.attributes.color;
    const positions = roadGeometry.attributes.position;
    const columns = 11;                       // buildRoad's default, unchanged
    const boreFloor = new THREE.Color(0x363d44);
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const u = boreFloorFactor2(track.frames[i].s, span) * 0.82;
      if (u <= 0) continue;
      for (let k = 0; k < columns; k++) {
        const vi = i * columns + k;
        c.fromBufferAttribute(colors, vi).lerp(boreFloor, u);
        colors.setXYZ(vi, c.r, c.g, c.b);
      }
    }
    /* The appended details, patches and paint past the base grid. Bounding
       test first: the span is ~100 m of a 5 km stage and projection is the
       expensive part. */
    const mid = track.frameAt((span.s0 + span.s1) / 2).pos.clone();
    const reach = (span.s1 - span.s0) / 2 + 60;
    const p = new THREE.Vector3();
    for (let vi = N * columns; vi < positions.count; vi++) {
      p.fromBufferAttribute(positions, vi);
      if (p.distanceToSquared(mid) > reach * reach) continue;
      const hit = track.project(p);
      const u = boreFloorFactor2(hit.s, span) * 0.82;
      if (u <= 0) continue;
      c.fromBufferAttribute(colors, vi).lerp(boreFloor, u);
      colors.setXYZ(vi, c.r, c.g, c.b);
    }
    colors.needsUpdate = true;
  }

  /* ---- berms ------------------------------------------------------------ */
  const boreStone = new THREE.Color(0x3a4249);
  /* buildBerms' ring colours, restated for the v reconstruction: k<=1 stone,
     k==2 grass, else dark stone. If track.js changes them, change these. */
  const bermBase = [0x526866, 0x526866, 0x729451, 0x354b52];
  for (const geo of bermGeometries) {
    const colors = geo.attributes.color;
    const P = colors.count / N;
    const base = new THREE.Color();
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const u = boreFloorFactor2(track.frames[i].s, span) * 0.92;
      if (u <= 0) continue;
      for (let k = 0; k < P; k++) {
        const vi = i * P + k;
        base.setHex(bermBase[Math.min(k, 3)]);
        c.fromBufferAttribute(colors, vi);
        const v = base.r > 0 ? c.r / base.r : 1;
        /* lerp(base, stone, u) * v, with c already equal to base * v. */
        c.multiplyScalar(1 - u);
        c.r += boreStone.r * u * v;
        c.g += boreStone.g * u * v;
        c.b += boreStone.b * u * v;
        colors.setXYZ(vi, c.r, c.g, c.b);
      }
    }
    colors.needsUpdate = true;
  }
}

/* Half the bore, and the clear height under the crown.
 *
 * Sized off the road, and deliberately tight: every metre of shoulder inside
 * the bore is a metre of grass-topped berm and corridor terrain that has to be
 * covered by something, and the first version — with nearly three metres of it
 * — spent its triangles hiding scenery instead of building a tunnel. A metre
 * and a half was too tight in the other direction: telemetry through the bore
 * put a car running wide on a seed-12 corner half a metre past the wall plane.
 *
 * The number that settles it is the physics containment wall at
 * `width * 0.5 + 1.05`, which no car can pass, so a body half-width beyond
 * that is the furthest anything can ever reach. Sitting the rock at 2.35
 * leaves about forty centimetres of daylight at the worst moment of the worst
 * seed, and nothing more, which is what a bore through rock would have. */
function boreSection(width) {
  const half = width * 0.5 + 2.35;
  return { half, spring: 3.2, crown: 6.6 };
}

/* The cross-section, left kerb up over the crown and down to the right, as
   fractions of the bore. Nine points: enough for the arch to read as an arch
   under a flat-shaded cel material, few enough that a hundred and thirty
   metres of it costs a few hundred triangles. */
const BORE_RING = [
  [-1.00, 0.00], [-1.05, 0.30], [-1.00, 0.62], [-0.74, 0.90],
  [0.00, 1.00],
  [0.74, 0.90], [1.00, 0.62], [1.05, 0.30], [1.00, 0.00],
];

/* Outer face of the rock the bore runs through: down the seaward nose, over
   the top, and buried well into the hillside on the inland flank so the mass
   reads as part of the cliff rather than a lid dropped onto the road. */
const SHELL_RING = [
  [-2.30, -3.60], [-2.50, 0.60], [-2.15, 1.55], [-1.20, 1.95],
  [0.00, 2.05],
  [1.20, 1.95], [2.15, 1.55], [2.50, 0.60], [2.30, -3.60],
];

/**
 * A bore through the spur, plus the rock it is bored through.
 *
 * Two shells sharing a station list. The inner one is what the driver sees and
 * is deliberately unlit: inside an enclosed space the only fill the cel
 * pipeline has is a hemisphere term that depends on `normal.y` alone, which is
 * how this project previously ended up with 81.6% of a frame in one bucket of
 * the value ladder. Baking the interior values means the ladder inside the
 * tunnel is chosen rather than inherited — crown darkest, springline lighter,
 * a kerb band lighter still, and every value lifted towards the portals so
 * daylight spill does the work of selling the aperture before you can see
 * through it.
 *
 * The outer shell is ordinary lit rock so it matches the cliff it belongs to,
 * and it is what casts the road inside into shadow.
 */
function buildTunnel(field, span, seed, mats) {
  const { track } = field;
  const r = rand(rng(seed * 911 + 71));
  const paint = fbm2(seed * 313 + 5, 2);
  const noise = (x, y) => paint(x, y) - 0.5;
  const { s0, s1 } = span;
  const length = s1 - s0;
  const steps = Math.max(14, Math.round(length / 7));

  const inner = [], outer = [], ledges = [];
  const _f = new THREE.Vector3();
  const _g = new THREE.Vector3();
  /* Horizontal lateral, world-vertical rise.
   *
   * Not the road's banked frame, which is what this was built in first and
   * which fails two ways at once. A kerb square to a banked road leans its top
   * out over the tarmac — the verge audit measures lateral offsets against the
   * horizontal, and caught the ledge half a metre over the driving surface two
   * metres up, which is car-roof height. And a bore that rolls with the
   * camber is wrong anyway: rock does not bank. */
  const place = (f, lat, up, out) => out.set(
    f.pos.x + f.flatRight.x * lat,
    f.pos.y + up,
    f.pos.z + f.flatRight.z * lat,
  );
  // Vertical offset of a road edge from the centreline, from camber alone.
  const edgeRise = (f, dir) => f.right.y * dir * f.width * 0.5;

  /* Top of the kerb ledge on one side of one station.
   *
   * Has to clear two different things: the stone-and-grass berm, whose height
   * depends on a per-station wear scale and can be most of two metres, and the
   * corridor terrain behind it. Leaving either of them poking up put grass
   * inside the mountain, and hugging the berm profile instead of clearing it
   * put two surfaces within a few centimetres of each other, which the ink
   * pass — which draws depth discontinuities — rendered as a scatter of black
   * polygons along the shoulder. Clearing both outright is the only version of
   * this that has no failure mode. */
  const ledgeTop = (f, s, dir, reach) => {
    const profile = field.profile(s, dir);
    const base = f.pos.y + edgeRise(f, dir);
    let top = 0.44;
    for (let n = 0; n <= 3; n++) {
      const off = (reach * n) / 3;
      top = Math.max(top, bermHeight(off, dir > 0 ? f.bermR : f.bermL) + 0.2);
      field.point(s, dir, off / Math.max(profile.wallDist, 1), _g);
      top = Math.max(top, _g.y - base + 0.22);
    }
    return top;
  };

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const s = s0 + length * t;
    const f = track.frameAt(s);
    const sea = field.coast.seaSideAt(s);
    const { half, crown } = boreSection(f.width);
    const reach = half - f.width * 0.5;
    /* Held as a rise from the centreline rather than from the road edge, so
       everything downstream can place against a single vertical datum. */
    const ledge = {
      '-1': edgeRise(f, -1) + ledgeTop(f, s, -1, reach),
      1: edgeRise(f, 1) + ledgeTop(f, s, 1, reach),
    };
    ledges.push(ledge);
    /* Daylight reaches a little way in from each mouth. Not a light — a bake,
       so it costs nothing and cannot be defeated by the shadow map. The short
       `halo` term is what makes the exit read as light rather than as a hole:
       the last few metres of wall around the aperture go to the top of the
       ladder, so the opening arrives already ringed in brightness. */
    const nearest = Math.min(t, 1 - t) * length;
    const mouth = Math.max(0, 1 - nearest / 30);
    const halo = Math.max(0, 1 - nearest / 12);
    const ringIn = [], ringOut = [];
    for (let k = 0; k < BORE_RING.length; k++) {
      const [bl, bu] = BORE_RING[k];
      /* Rock, not tube. The wobble is sampled on station and ring position so
         it runs along the bore as ribs and pockets rather than as noise on
         every vertex independently. */
      const w = noise(s * 0.07, k * 1.7) * 0.55 + noise(s * 0.021, k * 0.6 + 9) * 0.85;
      const lat = bl * (half + w * 0.5);
      /* The wall starts on the ledge, not on the road plane, so there is no
         band of hillside left showing between the two. */
      const floor = bl === 0 ? 0 : ledge[Math.sign(bl)];
      const up = bu === 0 ? floor
        : Math.max(bu * crown + (bu < 0.99 ? w * 0.45 : 0), floor + 0.4);
      place(f, lat, up, _f);
      ringIn.push({ x: _f.x, y: _f.y, z: _f.z, k, t, mouth, halo, w });

      const [sl, su] = SHELL_RING[k];
      const inlandward = Math.sign(sl) !== sea && sl !== 0;
      /* Its own noise, an order of magnitude coarser than the bore's. A shell
         extruded at a constant radius reads as a smooth ramp of rock laid over
         the road; the cliff it is supposed to be part of is broken, and the
         silhouette against the sky is the only part of this mass most players
         will ever look at. */
      const lump = noise(s * 0.115 + k * 4.1, k * 1.9) * 8.5
        + noise(s * 0.042, k * 0.7 + 31) * 6.5;
      const olat = sl * half * (inlandward ? 2.05 : 1)
        + (inlandward ? 0 : Math.sign(sl) * (w + lump * 0.42));
      const oup = su * crown + (su > 0 ? lump : (inlandward ? -14 : -4));
      place(f, olat, oup, _f);
      ringOut.push({ x: _f.x, y: _f.y, z: _f.z, k });
    }
    inner.push(ringIn);
    outer.push(ringOut);
  }

  /* The interior ladder, dark to light.
   *
   * Discrete, and applied per facet rather than per vertex, which is the whole
   * of why this reads. Smoothly interpolated vertex colours on an unlit
   * material gave a soft charcoal dome with no facets, no bands and nothing
   * for the ink pass to find — the exact "one bucket of the ladder" collapse
   * this section was warned about, arrived at from the opposite direction.
   * Nothing here is below 0.10 luma, because the ink is near-black and a
   * surface darker than that swallows its own outline.
   *
   * Spaced by measured screen luma rather than by eye. The first version of
   * this palette looked like nine even steps and was not: three of its nine
   * landed inside a single bucket of the posterise ladder, so two thirds of
   * the walls came out the same value as each other and as the road, and the
   * interior measured 69% in one bucket however the bands were assigned. These
   * are placed at 0.10, 0.17, 0.23, 0.30, 0.35, 0.43, 0.55, 0.66 and 0.80, so
   * adjacent steps are genuinely adjacent rungs and the eight rungs the
   * renderer quantises to are all reachable from in here.
   */
  const STEPS = [
    0x141b21, 0x232d35, 0x303c45, 0x404e59, 0x4d5c68,
    0x5f7180, 0x7b8f9d, 0x97acb8, 0xbcd0d9,
  ];
  const bandOf = k => (k === 4 ? 0 : k === 3 || k === 5 ? 1 : k === 2 || k === 6 ? 2 : k === 1 || k === 7 ? 3 : 4);

  const positions = [], colors = [];
  const _c = new THREE.Color();
  const tri = (a, b, c, hex) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    _c.setHex(hex);
    for (let n = 0; n < 3; n++) colors.push(_c.r, _c.g, _c.b);
  };
  const quad = (a, b, c, d, hex) => { tri(a, b, c, hex); tri(a, c, d, hex); };
  const stepAt = i => STEPS[clamp(Math.round(i), 0, STEPS.length - 1)];

  /* Lamps go on the inland wall, and the pool each one throws is baked into
     the wall facets around it. Two purposes: it is the cheapest possible
     interior lighting, and it is what keeps the value histogram from
     collapsing — without it the whole bore lives in two rungs of the ladder
     and reads as one flat dark shape however carefully it is banded. */
  const lampSide = -field.coast.seaSideAt((s0 + s1) / 2);
  const lampsAt = [];
  for (let d = 11; d < length - 7; d += 12.5) lampsAt.push(d);
  const lampGlow = (along, k) => {
    if (k === 4 || Math.sign(BORE_RING[k][0]) !== lampSide) return 0;
    let best = Infinity;
    for (const d of lampsAt) best = Math.min(best, Math.abs(along - d));
    return Math.max(0, 1 - best / 6.5);
  };

  /* Bore surface, wound so the inward face is the back face. */
  for (let i = 0; i < steps; i++) {
    for (let k = 0; k < BORE_RING.length - 1; k++) {
      const a = inner[i][k], b = inner[i][k + 1];
      const c = inner[i + 1][k + 1], d = inner[i + 1][k];
      const mouth = (a.mouth + c.mouth) * 0.5;
      const halo = (a.halo + c.halo) * 0.5;
      const along = ((i + 0.5) / steps) * length;
      const lamp = Math.max(lampGlow(along, k), lampGlow(along, k + 1)) * 2.1;
      /* Ribs every eleven metres. A step on the ladder, not a texture: at
         speed the bands passing overhead are what says you are moving. */
      const rib = Math.abs((along % 11.5) - 5.75) < 2.2 ? 1.25 : 0;
      /* Wider over the crown than over the walls. The roof is the single
         biggest surface in an interior frame and it has the least reason to
         vary, so left on the same grain as everything else it sits as one
         quiet mass in whichever rung its band lands on — which is most of what
         a modal-bucket figure is measuring. */
      const roof = k >= 3 && k <= 5 ? 1.55 : 1;
      const grain = (noise(along * 0.24, k * 3.3) * 2.1
        + noise(along * 0.9, k * 1.1) * 0.9) * roof;
      /* Deliberately compressed away from the top of the ladder in the middle
         of the run. The bore is only bright near the mouths; if the walls
         halfway along can reach the same steps the exit does, the aperture
         stops being an aperture and becomes another patch of wall. */
      /* The ceiling for everything that is not a lamp, a rib or daylight.
         Left uncapped, a wall facet that happened to catch a bright grain
         sample under a lamp reached the same rung as the aperture, and a
         tunnel with wall panels as bright as its exit has no exit. */
      quad(a, b, c, d, stepAt(Math.min(
        0.15 + bandOf(k) * 1.18 + rib + grain + lamp, 6.4,
      ) + mouth * mouth * 0.8 + halo * halo * 0.5));
    }

    /* A painted service line the length of both walls. Real tunnels have one,
       it costs two triangles a segment, and it is the only thing in here that
       holds the top of the ladder continuously — which is what stops a dark
       interior from reading as a single silhouette. */
    for (const k of [1, 7]) {
      const f = track.frameAt(s0 + (length * (i + 0.5)) / steps);
      const nudge = -Math.sign(BORE_RING[k][0]) * 0.07;
      const band = (v0, v1, q) => ({
        x: lerp(v0.x, v1.x, q) + f.right.x * nudge,
        y: lerp(v0.y, v1.y, q) + f.right.y * nudge,
        z: lerp(v0.z, v1.z, q) + f.right.z * nudge,
      });
      const lo0 = band(inner[i][k], inner[i][k + 1], 0.30);
      const hi0 = band(inner[i][k], inner[i][k + 1], 0.38);
      const lo1 = band(inner[i + 1][k], inner[i + 1][k + 1], 0.30);
      const hi1 = band(inner[i + 1][k], inner[i + 1][k + 1], 0.38);
      quad(lo0, hi0, hi1, lo1, 0x9fb2bb);
    }
  }

  /* The shoulder between the tarmac and the wall foot.
   *
   * Outside it is a grass-topped berm; inside a mountain it cannot be, and a
   * flat strip laid over it does not work either — the berm crests at up to
   * two and a half metres depending on the wear scale at that station, so a
   * strip at kerb height is simply buried and the grass shows through the
   * floor of the tunnel. This walks the same cross-section the berm is built
   * from and lays rock a few centimetres proud of it, which covers the grass
   * at every scale without inventing a step for the car to hit.
   *
   * It also carries the road edge, which is the line the driver steers by once
   * everything else is dark, so the lip at the kerb gets its own step rather
   * than relying on whatever contrast the shadow leaves at the tarmac.
   */
  for (const side of [0, BORE_RING.length - 1]) {
    /* Outward from the road edge, on the wall's own side. Getting this sign
       wrong builds a seventeen-metre sheet lying across both lanes instead of
       a strip of kerb, which renders as a pale floor over the tarmac and looks
       for all the world like a lighting fault. */
    const dir = Math.sign(BORE_RING[side][0]);
    for (let i = 0; i < steps; i++) {
      const f0 = track.frameAt(s0 + (length * i) / steps);
      const f1 = track.frameAt(s0 + (length * (i + 1)) / steps);
      const glow = (inner[i][side].mouth + inner[i + 1][side].mouth) * 0.5;
      const along = ((i + 0.5) / steps) * length;
      const t0 = ledges[i][dir], t1 = ledges[i + 1][dir];
      const at = (f, off, up) => {
        place(f, dir * (f.width * 0.5 + off), up, _f);
        return { x: _f.x, y: _f.y, z: _f.z };
      };
      /* Clear of the verge audit's margin for small objects, measured the way
         the audit measures it: horizontally, from the centreline. */
      const KERB = 0.42;
      const reach0 = boreSection(f0.width).half - f0.width * 0.5;
      const reach1 = boreSection(f1.width).half - f1.width * 0.5;
      /* Face onto the road, and the edge line the driver steers by in the
         dark. Started below the tarmac rather than level with it: the road
         edge drops half a metre into a gutter before the berm begins, and a
         face that starts at road height leaves that gutter — corridor
         hillside, grass and all — showing along both sides of the tunnel. */
      const b0 = edgeRise(f0, dir) - 1.3, b1 = edgeRise(f1, dir) - 1.3;
      /* Split into a face and a lip rather than painted as one panel. The
         ledge has to clear the berm, so on a worn station its face is over two
         metres tall, and at the top of the ladder that is not a kerb — it is a
         pale wall running the length of the bore, brighter than everything but
         the exit and pulling the eye straight down out of the frame. The lip
         keeps the bright step, because that line at the road edge is what the
         driver steers by once the interior is dark; the face behind it drops
         back to the middle of the ladder where it belongs. */
      const lip0 = t0 - 0.34, lip1 = t1 - 0.34;
      quad(at(f0, KERB, b0), at(f0, KERB, lip0), at(f1, KERB, lip1), at(f1, KERB, b1),
        stepAt(3.5 + noise(along * 0.42, side + 5) * 0.8 + glow * 1.2));
      quad(at(f0, KERB, lip0), at(f0, KERB, t0), at(f1, KERB, t1), at(f1, KERB, lip1),
        stepAt(6.2 + glow * 1.2));
      // Walkway, out to the wall foot so no gap opens against the rock.
      quad(at(f0, KERB, t0), at(f0, reach0, t0), at(f1, reach1, t1), at(f1, KERB, t1),
        stepAt(3.3 + noise(along * 0.3, side) * 1.1 + glow * glow * 2.2));
    }
  }

  /* Lamps. Instancing them would be cheaper in triangles and dearer in draw
     calls; folded into this mesh they cost neither. */
  for (let d = 11; d < length - 7; d += 12.5) {
    const f = track.frameAt(s0 + d);
    const { half, spring } = boreSection(f.width);
    const dir = -field.coast.seaSideAt(s0 + d);
    const pts = [
      [dir * (half - 0.15), spring + 0.62], [dir * (half - 0.15), spring + 0.10],
      [dir * (half - 1.05), spring - 0.04], [dir * (half - 1.05), spring + 0.78],
    ].map(([l, u]) => { place(f, l, u, _f); return { x: _f.x, y: _f.y, z: _f.z }; });
    quad(pts[0], pts[1], pts[2], pts[3], 0xffeec0);
    quad(pts[3], pts[2], pts[1], pts[0], 0xffeec0);
  }

  const bore = new THREE.BufferGeometry();
  bore.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  bore.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const boreMesh = new THREE.Mesh(finishGeometry(bore), mats.bore);
  boreMesh.name = 'tunnel-bore';

  /* Outer rock: lit, shadow-casting, painted off the cliff palette, and flat
     per facet for the same reason the bore is. Interpolated across an indexed
     shell it came out as one smooth slab hanging over the road; the cliff it
     is supposed to belong to is faceted, and it has to match. */
  const op = [], oc = [];
  /* Off the chapter the tunnel is actually in, not off a palette of its own.
     Hand-picked greys put a pale concrete tube on a blue-grey cliff: from the
     approach it read as something laid on the hillside rather than bored
     through it, which is the one thing this feature cannot afford to look
     like. Taking the same three rock tones the corridor wall behind it is
     painted with, plus the two wall tones either side of them, makes the mass
     a part of the cliff before a single triangle of it moves. */
  const chapter = CHAPTERS[field.profile((s0 + s1) / 2, -field.coast.seaSideAt((s0 + s1) / 2)).chapter];
  const rock = [
    chapter.rock[0], chapter.rock[1], chapter.rock[2],
    chapter.wall[0], chapter.wall[3],
  ];
  const triO = (a, b, c, hex) => {
    op.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
    _c.setHex(hex);
    for (let n = 0; n < 3; n++) oc.push(_c.r, _c.g, _c.b);
  };
  const quadO = (a, b, c, d, hex) => { triO(a, b, c, hex); triO(a, c, d, hex); };
  for (let i = 0; i < steps; i++) {
    for (let k = 0; k < SHELL_RING.length - 1; k++) {
      const shade = Math.round(Math.abs(noise(i * 3.1 + k * 7.7, k * 2.3)) * 9.9);
      quadO(outer[i][k], outer[i][k + 1], outer[i + 1][k + 1], outer[i + 1][k],
        rock[shade % rock.length]);
    }
  }
  /* Portal faces: the annulus between mouth and outer rock at each end. This
     is the ring of stone you drive through, and the thing that has to be
     legible as an opening from two hundred metres back — so it is the one part
     of the mass allowed to be lighter than the cliff, because that legibility
     is worth more than the restraint.
     *
     * Lighter, though, not pale. At the value it was first given it filled the
     * frame at the moment of entry and lifted the mean luma by 0.13 over three
     * metres, which is a flash, not a transition — and the brief's one hard
     * rule about entering and leaving is that neither may pop. What actually
     * makes the mouth read from distance is the dark hole inside the ring, and
     * that survives the ring being three rungs down. */
  for (const [i, sign] of [[0, 1], [steps, -1]]) {
    for (let k = 0; k < BORE_RING.length - 1; k++) {
      const hex = k === 4 ? 0x5e6b66 : k === 3 || k === 5 ? 0x53615c : 0x4a5854;
      if (sign > 0) quadO(inner[i][k], inner[i][k + 1], outer[i][k + 1], outer[i][k], hex);
      else quadO(outer[i][k], outer[i][k + 1], inner[i][k + 1], inner[i][k], hex);
    }
  }
  const shell = new THREE.BufferGeometry();
  shell.setAttribute('position', new THREE.Float32BufferAttribute(op, 3));
  shell.setAttribute('color', new THREE.Float32BufferAttribute(oc, 3));
  const shellMesh = new THREE.Mesh(finishGeometry(shell), mats.rock);
  shellMesh.name = 'tunnel-rock';
  shellMesh.castShadow = true;
  shellMesh.receiveShadow = true;

  const group = new THREE.Group();
  group.name = 'tunnel';
  group.add(shellMesh);
  group.add(boreMesh);
  group.userData.span = { s0, s1 };
  return group;
}

/* Metres beyond the road edge that a placed object owes the road.
   The berm profile runs out to five metres, so anything with real mass has to
   start beyond it; loose shoulder gravel is supposed to sit on the berm and
   only has to stay off the driving surface itself. */
const PROP_CLEAR = 5.6;
const GRAVEL_CLEAR = 1.15;

/**
 * The corridor fraction at which an object of this size first clears the road.
 *
 * `field.point` places by fraction of `wallDist`, which says nothing about how
 * wide the thing being placed is. A six-metre boulder centred at the first
 * legal fraction still has three metres of itself lying in the driving lane,
 * and on a tight corner — where `wallDist` collapses to single figures — that
 * was a boulder field crossing the racing line with a wheel buried in it.
 * Returns null when the shoulder is too narrow for this size at all, so the
 * caller can shrink it or drop it rather than jam it against the kerb.
 */
function clearOfRoad(profile, halfWidth) {
  const need = (halfWidth > 1.2 ? PROP_CLEAR : GRAVEL_CLEAR) + halfWidth;
  const u = need / profile.wallDist;
  return u > 0.97 ? null : u;
}

/**
 * A station fraction that respects the clearance floor.
 *
 * `clamp(want, minU, cap)` reads like it does this and does not: where the
 * clearance floor comes out above the rank's own ceiling — a wide crown on a
 * shoulder with the wall close in — clamp returns the ceiling, which is below
 * the floor, and the plant is placed inside the clearance it just tested for.
 * That is two trees leaning over the driving surface in the verge audit, and
 * it only shows up once something moves the wall in, which is exactly what
 * opening the corridors does. A rank would rather lose a plant than put one on
 * the road, so an impossible slot returns null and the caller skips it.
 */
function slotOutside(minU, want, cap) {
  const u = Math.max(minU, Math.min(want, cap));
  return u > 0.97 ? null : u;
}

/**
 * A twelve-triangle boulder: two pyramids joined at an irregular hexagon.
 *
 * Three.js has nothing this cheap with an angular silhouette — the platonic
 * solids start at twenty and the dodecahedron is thirty-six. The ring radii
 * are deliberately uneven so the outline is not a regular polygon from any
 * angle, which is the only thing that gives away a low vertex count.
 */
function bipyramid(sides) {
  const pos = [];
  const ring = [];
  const radii = [1, 0.78, 0.92, 0.7, 1.05, 0.83];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const rad = radii[i % radii.length];
    ring.push([Math.cos(a) * rad, (i % 2 ? 0.12 : -0.1), Math.sin(a) * rad]);
  }
  const top = [0.09, 1, -0.06];
  const bottom = [-0.05, -0.86, 0.08];
  for (let i = 0; i < sides; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % sides];
    pos.push(...top, ...a, ...b);
    pos.push(...bottom, ...b, ...a);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function buildRocks(field, seed, material) {
  const r = rand(rng(seed * 109 + 17));
  /* A ladder of silhouettes by cost, spent according to how much of the frame
     the rock is going to occupy. A six-metre hero boulder beside the road gets
     twenty triangles; the half-metre chips in the gutter get four. Choosing
     the variant at random — which is what this did — meant paying icosahedron
     and dodecahedron prices for gravel, and the dodecahedron in particular is
     thirty-six triangles for a shape that reads as a lump either way. */
  const geometries = [
    grounded(new THREE.IcosahedronGeometry(1, 0)),
    grounded(bipyramid(6)),
    grounded(new THREE.OctahedronGeometry(1, 0)),
    grounded(new THREE.TetrahedronGeometry(1, 0)),
  ];
  const GRAVEL = 3;
  const items = geometries.map(() => []);
  /* Hero rocks earn the round silhouette, everything else takes the cheap one.
     The break points are in metres of radius. */
  const grade = size => (size > 2.6 ? 0 : size > 1.5 ? 1 : size > 0.95 ? 2 : GRAVEL);

  const chapterClusters = [4, 10, 6, 10];
  const ranges = [[0.02, 0.17], [0.19, 0.42], [0.45, 0.68], [0.72, 0.98]];
  for (let chapter = 0; chapter < chapterClusters.length; chapter++) {
    for (let c = 0; c < chapterClusters[chapter]; c++) {
      const centre = r.f(ranges[chapter][0], ranges[chapter][1]) * field.track.length;
      const side = r.sign();
      const count = r.i(chapter === 1 ? 13 : 9, chapter === 3 ? 24 : 19);
      const spread = chapter === 3 ? 36 : 25;
      for (let i = 0; i < count; i++) {
        const s = clamp(centre + r.f(-spread, spread) + r.f(-spread, spread), 20, field.track.length - 20);
        const profile = field.profile(s, side);
        let size = r.bell(0.65, chapter === 3 ? 2.9 : 2.4);
        if (i === 0 || (i < 4 && r.chance(0.32))) size = r.f(3.4, chapter === 1 ? 6.2 : 8.5);
        /* 1.5 is the widest the random scale below can make this rock; the
           unit geometries all have a radius of one. */
        const minU = clearOfRoad(profile, size * 1.5);
        if (minU === null) continue;
        const u = clamp((chapter === 3 ? 0.58 : 0.78) + r.f(-0.13, 0.18), minU, 0.97);
        field.point(s, side, u, _point);
        const variant = grade(size);
        items[variant].push({
          position: _point.clone().addScaledVector(profile.f.up, -size * 0.14),
          rotation: new THREE.Euler(r.f(-0.15, 0.15), r.f(0, Math.PI * 2), r.f(-0.15, 0.15)),
          scale: new THREE.Vector3(size * r.f(0.72, 1.48), size * r.f(0.58, 1.28), size * r.f(0.72, 1.5)),
          color: r.pick(CHAPTERS[chapter].rock),
        });
      }
    }
  }

  const anchors = [[0.275, -1], [0.445, 1], [0.605, 1], [0.91, -1]];
  for (const [p, side] of anchors) {
    const centre = p * field.track.length;
    const chapter = chapterAt(p);
    for (let i = 0; i < 22; i++) {
      const s = clamp(centre + r.f(-34, 34), 20, field.track.length - 20);
      const profile = field.profile(s, side);
      const size = i < 3 ? r.f(3.2, 6.8) : r.f(0.55, 2.25);
      const minU = clearOfRoad(profile, size * 1.45);
      if (minU === null) continue;
      const u = clamp(
        p > 0.55 && p < 0.66 ? r.f(0.55, 0.79) : r.f(0.7, 0.97),
        minU, 0.97,
      );
      field.point(s, side, u, _point);
      const variant = grade(size);
      items[variant].push({
        position: _point.clone().addScaledVector(profile.f.up, -size * 0.15),
        rotation: new THREE.Euler(r.f(-0.16, 0.16), r.f(0, Math.PI * 2), r.f(-0.16, 0.16)),
        scale: new THREE.Vector3(size * r.f(0.78, 1.45), size * r.f(0.55, 1.22), size * r.f(0.74, 1.42)),
        color: r.pick(CHAPTERS[chapter].rock),
      });
    }
  }

  /* Shoulder gravel, in seams rather than a sprinkle.
     Eight clusters over five and a half kilometres was one every seven hundred
     metres, which is nowhere in a frame that is forty per cent road. This runs
     the length of the stage and is still grouped: material washes off the cut
     above and collects in drifts, so a seam and then thirty metres of clean
     kerb is the correct rhythm — it just has to be a rhythm rather than four
     appearances in the whole stage. */
  for (let cluster = 0; cluster < 155; cluster++) {
    const centre = r.f(0.02, 0.98) * field.track.length;
    const side = r.sign();
    const count = r.i(3, 6);
    for (let i = 0; i < count; i++) {
      const s = clamp(centre + r.f(-6, 6) + r.f(-3, 3), 20, field.track.length - 20);
      const profile = field.profile(s, side);
      const size = r.f(0.26, 0.8);
      const minU = clearOfRoad(profile, size * 1.4);
      if (minU === null) continue;
      const u = slotOutside(minU, r.f(0.05, 0.15), 0.3);
      if (u === null) continue;
      field.point(s, side, u, _point);
      const variant = grade(size);
      items[variant].push({
        position: _point.clone().addScaledVector(profile.f.up, -size * 0.16),
        rotation: new THREE.Euler(r.f(-0.13, 0.13), r.f(0, Math.PI * 2), r.f(-0.13, 0.13)),
        scale: new THREE.Vector3(size * r.f(0.75, 1.4), size * r.f(0.45, 0.85), size * r.f(0.72, 1.35)),
        color: r.pick(CHAPTERS[chapterAt(s / field.track.length)].rock),
      });
    }
  }

  /* Outcrops breaking the seaward drop. The cliff between the lip and the
     water was one clean swept surface, so the eye had nothing to read depth
     against on the whole open side of the stage. These sit below the lip where
     they cannot be an obstruction, in the wall palette rather than the ground
     one so they read as the same rock the cliff is made of. */
  for (let base = 30; base < field.track.length - 30; base += 34) {
    const centre = clamp(base + r.f(-10, 10), 25, field.track.length - 25);
    const side = field.coast.seaSideAt(centre);
    if (field.profile(centre, side).coastness < 0.22) continue;
    const count = r.i(2, 5);
    for (let i = 0; i < count; i++) {
      const s = clamp(centre + r.f(-16, 16), 20, field.track.length - 20);
      const profile = field.profile(s, side);
      const size = r.f(0.8, 3.6) * (r.chance(0.4) ? 1.5 : 1);
      const minU = clearOfRoad(profile, size * 1.5);
      if (minU === null) continue;
      const u = clamp(r.f(0.4, 0.95), minU, 0.95);
      field.point(s, side, u, _point);
      const variant = grade(size);
      items[variant].push({
        position: _point.clone().addScaledVector(profile.f.up, -size * 0.34),
        rotation: new THREE.Euler(r.f(-0.3, 0.3), r.f(0, Math.PI * 2), r.f(-0.3, 0.3)),
        scale: new THREE.Vector3(size * r.f(0.7, 1.5), size * r.f(0.5, 1.1), size * r.f(0.7, 1.5)),
        color: r.pick(CHAPTERS[chapterAt(s / field.track.length)].rock),
      });
    }
  }

  const group = new THREE.Group();
  group.name = 'boulders';
  for (let i = 0; i < geometries.length; i++) {
    group.add(makeInstances(geometries[i], material, items[i], `boulders-${i}`));
  }
  return group;
}

function branchGeometry(length, bottom, top, yaw, lean, y = 0, sides = 5) {
  const geometry = new THREE.CylinderGeometry(top, bottom, length, sides, 1, false);
  geometry.translate(0, length * 0.5, 0);
  geometry.rotateZ(lean);
  geometry.rotateY(yaw);
  geometry.translate(0, y, 0);
  return geometry;
}

function paintGeometry(geometry, hex) {
  const color = new THREE.Color(hex);
  const colors = new Float32Array(geometry.attributes.position.count * 3);
  for (let i = 0; i < geometry.attributes.position.count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function buildShrubGeometry(variant = 0) {
  const parts = [];
  const specs = variant === 0
    ? [
      [-0.55, 0.55, 0.1, 0.9, 0.75, 0.8],
      [0.42, 0.72, -0.05, 0.8, 1.0, 0.75],
      [0.0, 1.02, 0.35, 0.72, 0.82, 0.68],
    ]
    : [
      [-0.78, 0.42, 0.12, 1.12, 0.58, 0.78],
      [0.2, 0.78, -0.12, 0.68, 1.18, 0.62],
      [0.96, 0.48, 0.24, 0.92, 0.67, 0.84],
      [-0.05, 1.18, 0.3, 0.55, 0.82, 0.52],
    ];
  for (const [x, y, z, sx, sy, sz] of specs) {
    /* At road speed the shrub reads as a three-lobed silhouette; the 108
       triangles of three dodecahedra were invisible detail repeated 231 times.
       Octahedral lobes preserve the faceted cel read at one fifth the cost. */
    const part = variant === 0
      ? new THREE.OctahedronGeometry(1, 0)
      : new THREE.TetrahedronGeometry(1, 0);
    part.scale(sx, sy, sz);
    part.translate(x, y, z);
    parts.push(part);
  }
  const merged = mergeGeometries(parts);
  parts.forEach(g => g.dispose());
  return grounded(merged);
}

function buildTreeGeometry(variant) {
  const parts = [];
  /* Four sides on the trunk and five on the cones. These are six-metre trees
     that are almost never nearer than twenty metres, and at that range the
     extra segments were half the cost of the whole tree for a rounding of the
     outline that the outline pass flattens anyway. */
  const trunk = paintGeometry(
    branchGeometry(6.1, 0.34, 0.16, variant ? -0.18 : 0.08, variant ? 0.14 : -0.05, 0, 4),
    0x68583d,
  );
  parts.push(trunk);

  if (variant === 0) {
    const lower = new THREE.ConeGeometry(2.05, 5.4, 5, 1, false);
    lower.translate(0.45, 4.1, 0);
    const crown = new THREE.ConeGeometry(1.48, 4.8, 5, 1, false);
    crown.translate(0.25, 6.9, 0.05);
    parts.push(paintGeometry(lower, 0x246a43), paintGeometry(crown, 0x398247));
  } else if (variant === 1) {
    const clumps = [
      [-0.2, 4.0, 0, 2.7, 1.45, 1.8, 0x2e7545],
      [1.5, 5.15, 0.15, 2.35, 1.25, 1.55, 0x3d8947],
      [2.7, 6.1, 0.25, 1.7, 1.05, 1.25, 0x286b45],
    ];
    for (const [x, y, z, sx, sy, sz, color] of clumps) {
      const crown = new THREE.OctahedronGeometry(1, 0);
      crown.scale(sx, sy, sz);
      crown.rotateZ(-0.12);
      crown.translate(x, y, z);
      parts.push(paintGeometry(crown, color));
    }
  } else {
    const clumps = [
      [-1.15, 4.35, 0.15, 2.15, 1.75, 1.75, 0x397f47],
      [0.75, 4.75, -0.3, 2.55, 2.05, 2.1, 0x4a9149],
      [0.1, 6.35, 0.2, 1.95, 1.7, 1.65, 0x2d7044],
    ];
    for (const [x, y, z, sx, sy, sz, color] of clumps) {
      const crown = new THREE.OctahedronGeometry(1, 0);
      crown.scale(sx, sy, sz);
      crown.rotateZ(0.05);
      crown.translate(x, y, z);
      parts.push(paintGeometry(crown, color));
    }
  }

  const merged = mergeGeometries(parts);
  parts.forEach(g => g.dispose());
  return grounded(merged);
}

function buildRidgeTreeGeometry(variant) {
  const positions = [], colors = [];
  const push = (points, hex) => {
    _color.setHex(hex);
    for (const point of points) {
      positions.push(...point);
      colors.push(_color.r, _color.g, _color.b);
    }
  };
  for (let plane = 0; plane < 2; plane++) {
    const p = (x, y) => plane === 0 ? [x, y, 0] : [0, y, x];
    push([
      p(-0.24, 0), p(0.24, 0), p(-0.18, 4.1),
      p(0.24, 0), p(0.18, 4.1), p(-0.18, 4.1),
    ], 0x5e513b);
    if (variant === 0) {
      push([p(-2.15, 3.3), p(2.05, 3.3), p(0, 10.2)], 0x286b43);
    } else {
      /* Three broad overlapping lobes, not three splinters. The first version
         of this crown was a set of long thin triangles chosen to suggest a
         ragged leafy outline, and on a crossed billboard that is exactly the
         "degenerate spike tree" in the review: turn until one plane goes
         edge-on and all that is left of the other is three near-zero-width
         slivers standing on a trunk. A lobe has to be about as wide as it is
         tall to survive being seen flat. */
      push([
        p(-2.7, 3.3), p(2.1, 3.1), p(-0.6, 7.9),
        p(-1.9, 5.4), p(2.5, 5.2), p(0.1, 9.6),
      ], 0x3d7c47);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return finishGeometry(geometry);
}

/* Nominal height of the crossed-triangle silhouette in its own units. */
const RIDGE_HEIGHT = 10.2;

/**
 * Place one silhouette proxy, sized for the range it will be seen at.
 *
 * These are two crossed triangles. They read as a tree from fifty metres and
 * as a flat dark slab from five, so their size is not a free parameter the way
 * a modelled tree's is: it is bounded by how much of the frame the proxy is
 * allowed to own. Nearly every object defect in the last review was one of
 * these. The "giant malformed tree" was a twenty-metre proxy eleven metres
 * from the camera; the "bare trunks with no canopy" were the same thing with
 * the canopy triangle above the top of frame, leaving only the trunk quad in
 * shot; the "degenerate spikes" were an x-to-y scale ratio wide enough to
 * collapse the canopy into a sliver, which a modelled tree's volume would have
 * hidden and a flat billboard cannot.
 *
 * So the size comes from the range and the plan stays near square. Callers ask
 * for a height in metres and get whatever the viewing distance allows.
 */
function pushRidge(items, variant, point, profile, r, height, colors, lean) {
  const f = profile.f;
  const range = point.distanceTo(f.pos);
  let h = Math.min(height, 2 + range * 0.45);
  /* And by the room it has beside the road. Every rank has its own placement
     rule and several of them can put a plant a metre off the kerb, so the
     clearance is enforced here rather than in nine separate clamps. The
     crossed silhouette's radius runs about a third of its height, small plants
     are allowed to stand on the berm, and anything with enough mass to stop a
     car is not. Shrinking rather than skipping: a verge wants scrub on it, and
     scrub is what fits. */
  const room = Math.abs(
    (point.x - f.pos.x) * f.flatRight.x + (point.z - f.pos.z) * f.flatRight.z,
  ) - f.width * 0.5;
  const small = (room - 0.4) / 0.34;
  h = Math.min(h, small > 3.6 ? Math.max(3.6, (room - 2.7) / 0.34) : small);
  if (h < 0.85) return;
  const scale = h / RIDGE_HEIGHT;
  items[variant].push({
    position: point.clone().addScaledVector(profile.f.up, -0.02 - h * 0.013),
    rotation: new THREE.Euler(
      0,
      r.f(0, Math.PI * 2),
      lean ? r.f(lean[0], lean[1]) : r.f(-0.1, 0.08),
    ),
    scale: new THREE.Vector3(
      scale * r.f(0.87, 1.13),
      scale * r.f(0.93, 1.09),
      scale * r.f(0.87, 1.13),
    ),
    color: r.pick(colors),
  });
}

/**
 * Bunched, mixed, and full of holes — the way the good clusters already look.
 *
 * A loop that steps a fixed distance and plants one thing per step draws a
 * picket fence, and more than half the frames in the review were picket
 * fences. Real spacing is not jittered-even, it is clumped: a knot of three or
 * four, then twenty metres of nothing. This returns the arc-length offsets for
 * one such knot, so a rank can keep its own placement rule and still bunch.
 */
function clump(r, span, count) {
  const offsets = [];
  const width = span * r.f(0.14, 0.4);
  for (let i = 0; i < count; i++) {
    offsets.push((r.f(-1, 1) + r.f(-1, 1)) * 0.5 * width);
  }
  return offsets.sort((a, b) => a - b);
}

function buildVegetation(field, seed, brushMaterial, treeMaterial, ridgeMaterial) {
  const r = rand(rng(seed * 127 + 31));
  const brushItems = [[], []], treeItems = [[], [], []], ridgeItems = [[], []];
  const brushRanges = [
    [0.025, 0.2, 7], [0.22, 0.48, 8], [0.5, 0.73, 7], [0.74, 0.985, 9],
  ];

  for (const [a, b, clusters] of brushRanges) {
    for (let c = 0; c < clusters; c++) {
      const centre = r.f(a, b) * field.track.length;
      const seaSide = field.coast.seaSideAt(centre);
      const side = r.chance(0.82) ? -seaSide : seaSide;
      const count = r.i(5, 9);
      for (let i = 0; i < count; i++) {
        const s = clamp(centre + r.f(-22, 22) + r.f(-9, 9), 35, field.track.length - 35);
        const profile = field.profile(s, side);
        const upper = profile.coastness > 0.34 ? 0.42 : 0.76;
        const clearance = profile.coastness > 0.34 ? 14 : 16;
        if (profile.wallDist * upper < clearance) continue;
        const lower = Math.max(profile.coastness > 0.34 ? 0.34 : 0.5, clearance / profile.wallDist);
        const u = r.f(lower, upper);
        if (profile.coastness > 0.6 && u > 0.36) continue;
        field.point(s, side, u, _point);
        const scale = r.f(0.35, 0.72);
        brushItems[r.i(0, 1)].push({
          position: _point.clone().addScaledVector(profile.f.up, -0.08),
          rotation: new THREE.Euler(0, r.f(0, Math.PI * 2), r.f(-0.1, 0.1)),
          scale: new THREE.Vector3(scale * r.f(0.8, 1.22), scale, scale * r.f(0.82, 1.18)),
          color: r.pick(BRUSH_COLORS),
        });
      }
    }
  }

  /* Trees grow as layered groves: tall cores in sheltered inland folds,
     mixed leafy edges, then low bushes feathering each cluster into terrain. */
  const groveRanges = [
    [0.03, 0.2, 3], [0.22, 0.46, 5], [0.49, 0.71, 4], [0.74, 0.97, 5],
  ];
  for (const [a, b, clusters] of groveRanges) {
    for (let c = 0; c < clusters; c++) {
      const centre = r.f(a, b) * field.track.length;
      const side = -field.coast.seaSideAt(centre);
      const centreProfile = field.profile(centre, side);
      if (centreProfile.wallDist < 17) continue;
      const exposed = centreProfile.coastness > 0.5;
      const count = r.i(exposed ? 4 : 5, exposed ? 6 : 9);
      for (let i = 0; i < count; i++) {
        const s = clamp(centre + r.f(-28, 28) + r.f(-12, 12), 35, field.track.length - 35);
        const profile = field.profile(s, side);
        if (profile.wallDist < 15) continue;
        const layer = i % 3;
        const u = clamp(
          0.27 + layer * 0.13 + r.f(-0.07, 0.08),
          Math.min(0.68, 13 / profile.wallDist),
          exposed ? 0.53 : 0.72,
        );
        field.point(s, side, u, _point);
        const core = i < Math.max(2, count * 0.3);
        const scale = (core ? r.f(1.08, 1.58) : r.f(0.68, 1.18))
          * (exposed ? r.f(0.72, 0.92) : 1);
        const variant = exposed
          ? (r.chance(0.62) ? 1 : 0)
          : r.pick([0, 0, 1, 2, 2]);
        treeItems[variant].push({
          position: _point.clone().addScaledVector(profile.f.up, -0.12),
          rotation: new THREE.Euler(0, r.f(0, Math.PI * 2), exposed ? r.f(-0.13, 0.02) : r.f(-0.06, 0.06)),
          scale: new THREE.Vector3(
            scale * r.f(0.82, 1.16),
            scale * (variant === 0 ? r.f(1.05, 1.35) : r.f(0.9, 1.12)),
            scale * r.f(0.84, 1.12),
          ),
          color: r.pick([0xffffff, 0xe7f3e2, 0xf1efd9, 0xdcece5]),
        });
        if (i % 2 === 0) {
          const fringeMax = exposed ? 0.5 : 0.76;
          if (profile.wallDist * fringeMax < 15) continue;
          const fringeU = clamp(
            u + r.f(-0.04, 0.12),
            Math.max(exposed ? 0.38 : 0.45, 15 / profile.wallDist),
            fringeMax,
          );
          field.point(s + r.f(-7, 7), side, fringeU, _point2);
          const shrubScale = r.f(0.38, 0.75);
          brushItems[r.i(0, 1)].push({
            position: _point2.clone().addScaledVector(profile.f.up, -0.06),
            rotation: new THREE.Euler(0, r.f(0, Math.PI * 2), r.f(-0.08, 0.08)),
            scale: new THREE.Vector3(shrubScale * r.f(0.8, 1.2), shrubScale, shrubScale * r.f(0.82, 1.18)),
            color: r.pick(BRUSH_COLORS),
          });
        }
      }
    }
  }

  /* Continuous placement rules, not hero-shot anchors. Every rising inland
     shoulder receives a near bush bank, a mid tree rank and two cheap ridge
     ranks, so the 5.6 km ribbon keeps layered silhouettes between captures. */
  let routeIndex = 0;
  for (let base = 24; base < field.track.length - 24; base += 40, routeIndex++) {
    const centre = clamp(base + r.f(-8, 8), 30, field.track.length - 30);
    const side = -field.coast.seaSideAt(centre);
    const profile = field.profile(centre, side);
    const count = profile.wallDist < 12 ? 1 : routeIndex % 3 === 0 ? 3 : 2;
    for (let i = 0; i < count; i++) {
      const s = clamp(centre + (i - (count - 1) * 0.5) * r.f(7, 13), 25, field.track.length - 25);
      const local = field.profile(s, side);
      const layer = i % 3;
      const variant = r.pick([0, 0, 1, 2]);
      const scale = r.f(0.72, 1.34) * (layer === 2 ? 1.08 : 1);
      /* The clearance floor was a flat fourteen metres regardless of how big
         the tree turned out to be, and where the wall stands seven metres off
         the kerb this rank plants at 0.88 of the corridor — five and a half
         metres out, with a crown six across. Sized off the instance instead,
         and a slot that cannot hold the tree loses it rather than leaning it
         over the tarmac. */
      const minU = clearOfRoad(local, 4.6 * scale * 1.18);
      if (minU === null) continue;
      const u = slotOutside(
        minU,
        (local.wallDist < 12 ? 0.88 : 0.34 + layer * 0.19) + r.f(-0.045, 0.055),
        0.92,
      );
      if (u === null) continue;
      field.point(s, side, u, _point);
      treeItems[variant].push({
        position: _point.clone().addScaledVector(local.f.up, -0.1),
        rotation: new THREE.Euler(0, r.f(0, Math.PI * 2), r.f(-0.08, 0.06)),
        scale: new THREE.Vector3(
          scale * r.f(0.78, 1.18),
          scale * (variant === 0 ? r.f(1.02, 1.34) : r.f(0.9, 1.14)),
          scale * r.f(0.8, 1.16),
        ),
        color: r.pick([0xffffff, 0xe2f1df, 0xf0ecd3, 0xd8e9e1]),
      });
    }
  }

  routeIndex = 0;
  for (let base = 24; base < field.track.length - 24; base += 38, routeIndex++) {
    const centre = clamp(base + r.f(-6, 6), 24, field.track.length - 24);
    const side = -field.coast.seaSideAt(centre);
    const profile = field.profile(centre, side);
    if (profile.wallDist < 17) continue;
    const count = routeIndex % 4 === 0 ? 3 : 2;
    for (let i = 0; i < count; i++) {
      const s = clamp(centre + (i - (count - 1) * 0.5) * r.f(4, 8), 20, field.track.length - 20);
      const local = field.profile(s, side);
      if (local.wallDist < 16) continue;
      const u = clamp(
        10 / local.wallDist + i * 0.1 + r.f(-0.035, 0.04),
        0.22,
        0.58,
      );
      field.point(s, side, u, _point);
      const scale = r.f(0.38, 0.88);
      brushItems[(routeIndex + i) % 2].push({
        position: _point.clone().addScaledVector(local.f.up, -0.06),
        rotation: new THREE.Euler(0, r.f(0, Math.PI * 2), r.f(-0.08, 0.08)),
        scale: new THREE.Vector3(
          scale * r.f(0.7, 1.35),
          scale * r.f(0.72, 1.28),
          scale * r.f(0.72, 1.32),
        ),
        color: r.pick([0x286f42, 0x3b8745, 0x579548, 0x326f50, 0x6a9748]),
      });
    }
  }

  /* The hillside wood, planted in knots rather than in a queue.
     Three ranks up the slope — the crest, the shoulder behind it and a bench
     halfway down — but all three drawn from one clump of arc-length offsets,
     so a stand occupies twenty metres of hillside at three depths and the
     forty metres either side of it are empty. A knot that mixes both proxy
     variants and three heights is the read the good frames already have; an
     evenly spaced rank of one variant at one height is the picket fence. */
  routeIndex = 0;
  for (let base = 18; base < field.track.length - 26; base += 31, routeIndex++) {
    const centre = clamp(base + r.f(-6, 6), 18, field.track.length - 18);
    const side = -field.coast.seaSideAt(centre);
    if (field.profile(centre, side).wallHeight < 7) continue;
    if (r.chance(0.24)) continue;
    const stand = r.chance(0.34) ? r.i(5, 8) : r.i(2, 4);
    const offsets = clump(r, 46, stand);
    for (let i = 0; i < stand; i++) {
      const s = clamp(centre + offsets[i], 18, field.track.length - 18);
      const local = field.profile(s, side);
      if (local.wallHeight < 7) continue;
      /* Which rank up the slope this one belongs to. Cycling rather than
         random keeps every knot layered instead of leaving some of them flat
         against the crest. */
      const rank = i % 3;
      const station = [11, 12, 8][rank];
      if (local.constrained) field.point(s, side, [0.97, 0.9, 0.86][rank], _point);
      else if (standable(field, s, side, station, 1.5)) landformPoint(field, s, side, station, _point);
      else continue;
      pushRidge(
        ridgeItems,
        r.chance(0.3) ? 1 : 0,
        _point,
        local,
        r,
        [r.f(11, 19), r.f(9, 15), r.f(7, 12)][rank],
        [0x315f43, 0x3d7547, 0x4a8249, 0x2b6048, 0x537d55, 0x456b50],
        [-0.11, 0.08],
      );
    }
  }

  /* A crest line on *both* shoulders, not only the inland one.
     Every rank above works from `-seaSideAt`, which is correct for a grove —
     trees grow in the sheltered fold — but it leaves the far side of every
     cut wall with a bare skyline, and a tall wall's top edge against the sky
     is the one silhouette in the frame with nothing to break it.

     In stands, not at a spacing. The first version of this walked the crest
     every thirteen metres and planted one tree at each step with a one-in-four
     skip, which is a picket fence with a few teeth missing — and a skyline is
     the worst possible place for one, because it is the rank the eye reads as
     an outline. The step is now long enough to leave real gaps and each stop
     plants a bunch, so the crest is a wood that thins and thickens along the
     ridge. */
  routeIndex = 0;
  for (let base = 20; base < field.track.length - 20; base += 27, routeIndex++) {
    for (const side of [-1, 1]) {
      if (r.chance(0.22)) continue;
      const stand = r.chance(0.22) ? r.i(4, 6) : r.i(1, 3);
      const spread = clump(r, 34, stand);
      for (let k = 0; k < stand; k++) {
        const s = clamp(base + spread[k] + r.f(-1.5, 1.5), 20, field.track.length - 20);
        const local = field.profile(s, side);
        /* Either kind of skyline: the top of a cut wall, or the lip of a bluff
           where the land simply stops. The second is the one the 92% frame was
           missing — a coastal shoulder has no wall height at all, so every
           rank keyed on wallHeight skipped it and left the longest straight
           edge in the stage with nothing on it. */
        const seaward = local.coastness > 0.4
          && local.f.pos.y - field.coast.seaLevel > 24;
        if (local.wallHeight < 10 && !seaward) continue;
        /* On the seaward side the skyline is the lip, not the face — sampled
           just inside where `groundDelta` starts to fall, so these stand on
           the shoulder and silhouette against the sky rather than hanging on
           the drop with water behind them. */
        if (seaward) field.point(s, side, r.f(0.16, 0.34), _point);
        else crestPoint(field, s, side, _point);
        /* Back from the lip along the crest, by a varying amount: a rank of
           trunks all planted exactly on the edge is its own straight line.
           Seaward the jitter is already in the sampled offset, and pushing
           further out would plant them over the drop. */
        if (!seaward) _point.addScaledVector(local.f.flatRight, side * r.f(0.4, 4.2));
        pushRidge(
          ridgeItems,
          (routeIndex + k + (side > 0 ? 1 : 0)) % 3 === 0 ? 1 : 0,
          _point,
          local,
          r,
          /* Heights vary within a stand, not only between them: an even
             skyline of one height is the same fence read horizontally. */
          (seaward ? r.f(5, 9.5) : r.f(8, 16)) * (k === 0 ? 1.15 : r.f(0.68, 1.05)),
          [0x2c5c42, 0x376c46, 0x43794a, 0x2a6349, 0x35714a, 0x24543f],
          seaward ? [-0.2, -0.04] : [-0.12, 0.1],
        );
      }
    }
  }

  /* A cheap continuous middle rank on both shoulders closes the long gaps
     that random groves left between camera samples. Crossed 6–8 triangle
     silhouettes carry density without spending detailed-tree geometry. */
  routeIndex = 0;
  for (let base = 18; base < field.track.length - 18; base += 26, routeIndex++) {
    const centre = clamp(base + r.f(-4, 4), 20, field.track.length - 20);
    const seaSide = field.coast.seaSideAt(centre);
    for (const side of [-1, 1]) {
      const profile = field.profile(centre, side);
      const inland = side !== seaSide;
      const count = Math.abs(profile.f.curv) > 0.003 ? 4 : 2;
      for (let i = 0; i < count; i++) {
        const s = clamp(
          centre + (i - (count - 1) * 0.5) * r.f(7, 12),
          20,
          field.track.length - 20,
        );
        const local = field.profile(s, side);
        const distance = 8 + (i % 2) * (inland ? 11 : 8) + r.f(-1.2, 1.8);
        /* Seaward this rank stays inside the lip. `groundDelta` starts the
           drop at u = 0.16 and finishes it by 0.48, so the old fraction-of-
           corridor rule put half of this rank out over the cliff, where it
           either hung in the air or silhouetted against the water. */
        const u = local.constrained
          ? 0.68 + (i % 3) * 0.1
          : clamp(distance / local.wallDist, 0.12, inland ? 0.9 : 0.26);
        field.point(s, side, u, _point);
        pushRidge(
          ridgeItems,
          (routeIndex + i + (side > 0 ? 1 : 0)) % 5 === 0 ? 1 : 0,
          _point,
          local,
          r,
          inland ? r.f(10, 16) : r.f(4.5, 8.5),
          inland
            ? [0x2e6542, 0x397648, 0x49844c, 0x356d50]
            : [0x5f7b4e, 0x6d8a52, 0x4e6f4c, 0x7d9455],
          inland ? [-0.09, 0.08] : [-0.22, -0.05],
        );
      }
      if (routeIndex % 2 === 0 && profile.wallHeight > 11) {
        if (profile.coastness > 0.55 || profile.constrained) {
          field.point(centre, side, 0.96, _point);
        } else {
          landformPoint(field, centre, side, 8, _point);
        }
        pushRidge(
          ridgeItems, 0, _point, profile, r, r.f(6, 11),
          [0x315f45, 0x3d7149, 0x487b4c],
        );
      }
    }
  }

  /* Close cuttings need vegetation inside the camera's vertical field, not
     only on a ridge that may be above frame. A regular low ledge rank keeps
     enclosed sections alive and breaks the broad wall faces at road height. */
  routeIndex = 0;
  for (let base = 16; base < field.track.length - 16; base += 23, routeIndex++) {
    const s = clamp(base + r.f(-3, 3), 16, field.track.length - 16);
    const seaSide = field.coast.seaSideAt(s);
    for (const side of [-1, 1]) {
      const profile = field.profile(s, side);
      /* A coastal bluff has no wall height to speak of and was skipped by
         this rank, which is exactly why the big seaward masses read as one
         unbroken plane with nothing standing on them. Its benches are already
         painted as grass by `grassShelf`, so they will carry scrub. */
      const bluff = profile.coastness > 0.34;
      if (profile.wallHeight < 12 && !bluff) continue;
      const station = bluff
        ? 7 + ((routeIndex * 2 + (side > 0 ? 1 : 0)) % 4)
        : (routeIndex % 3 === 0 ? 7 : 6);
      if (!standable(field, s, side, station, 1.6)) continue;
      landformPoint(field, s, side, station, _point);
      _point.addScaledVector(profile.f.flatRight, -side * 1.25);
      pushRidge(
        ridgeItems,
        (routeIndex + (side > 0 ? 2 : 0)) % 6 === 0 ? 1 : 0,
        _point, profile, r,
        bluff ? r.f(3.5, 7) : r.f(7, 12),
        bluff
          ? [0x5f7b4e, 0x6d8a52, 0x4e6f4c, 0x7d9455]
          : [0x3a7548, 0x47844c, 0x548e50, 0x326c48],
        bluff ? [-0.24, -0.04] : [-0.06, 0.06],
      );
    }
  }

  /* Corridor floor: the one rank with no clearance gate on it.
     Every other rule above skips a station when `wallDist` or `wallHeight`
     falls below some threshold, which is correct for a grove or a ridge line
     and leaves exactly the tight, enclosed, cliff-shadowed sections — the ones
     where the frame is nothing but road, verge and wall — with no planting at
     all. These sit on the verge and at the foot of the wall, where they break
     the long straight join between the two and give the near field something
     to move past. Ridge silhouettes rather than detailed shrubs: six to ten
     triangles each, and at this range the silhouette is all that survives. */
  routeIndex = 0;
  for (let base = 22; base < field.track.length - 22; base += 21, routeIndex++) {
    for (const side of [-1, 1]) {
      const s = clamp(base + r.f(-5, 5), 20, field.track.length - 20);
      const local = field.profile(s, side);
      if (r.chance(0.22)) continue;
      const count = routeIndex % 3 === 0 ? 2 : 1;
      for (let i = 0; i < count; i++) {
        /* Held close to the apron's own stations. The corridor is sampled
           continuously here but the mesh only has vertices at 0, 0.12, 0.28,
           0.5, 0.76 and 1, and on a steeply falling coastal shoulder a plant
           placed between two of them stands off the triangle that is actually
           drawn. */
        const u = clamp(
          (i === 0 ? 0.28 : 0.5) + r.f(-0.03, 0.03),
          Math.min(0.62, (PROP_CLEAR + 1.1) / local.wallDist),
          0.66,
        );
        field.point(s + r.f(-4, 4), side, u, _point);
        // Verge scrub, not trees: a metre and a half to four.
        pushRidge(
          ridgeItems,
          (routeIndex + i + (side > 0 ? 1 : 0)) % 5 === 0 ? 1 : 0,
          _point, local, r,
          r.f(1.6, 3.7) * (i === 0 ? 0.85 : 1.2),
          [0x33714a, 0x40804c, 0x4e8d51, 0x2b664a, 0x5b9550],
          [-0.13, 0.11],
        );
      }
    }
  }

  /* Slope cover: the face between the verge and the crest.
     Every rank above is anchored to something — the kerb, a ledge, the top of
     the wall — and the result is two or three horizontal bands of planting
     with a bare green face between them, which is what the review is looking
     at when it says the ridge is a picket fence. On a real hillside the trees
     are on the slope and the crest line is just where they run out.

     One side per knot rather than both, a third of the knots dropped, and the
     survivors placed in a tight bunch: that produces stands with gaps between
     them along the road instead of a continuous fringe. Levels 0 and 1 are
     corridor fractions and 2 and 3 are mesh stations, so between them the
     whole face from the shoulder to the shoulder behind the crest is covered
     and nothing is interpolated into thin air. */
  routeIndex = 0;
  /* Thinned from an 11 m stride when the landmarks landed — this and the two
     ranks below it are the generic hillside cover the brief says to trade for
     things that are worth looking at. The stands are what read at speed and
     the noise still decides where they are; what has gone is the fill between
     them, which the eye was averaging into a texture anyway. */
  for (let base = 26; base < field.track.length - 26; base += 15, routeIndex++) {
    const side = routeIndex % 2 === 0 ? -field.coast.seaSideAt(base) : r.sign();
    if (r.chance(0.36)) continue;
    const here = field.profile(base, side);
    if (here.wallDist < 11) continue;
    /* An exposed seaward shoulder has its own windswept rank and should not
       grow a hillside forest, and a bare rock wall carries nothing. */
    if (side === field.coast.seaSideAt(base) && here.coastness > 0.45) continue;
    const count = r.i(2, 4) + (r.chance(0.13) ? 2 : 0);
    const offsets = clump(r, 26, count);
    for (let i = 0; i < count; i++) {
      const s = clamp(base + offsets[i], 25, field.track.length - 25);
      const local = field.profile(s, side);
      const level = (routeIndex + i) % 4;
      if (level < 2) {
        const u = clamp(
          (level === 0 ? 0.62 : 0.85) + r.f(-0.07, 0.09),
          Math.min(0.7, (PROP_CLEAR + 2.2) / local.wallDist),
          0.97,
        );
        field.point(s, side, u, _point);
      } else {
        const station = level === 2 ? 7 : 9;
        if (local.constrained || !standable(field, s, side, station)) continue;
        landformPoint(field, s, side, station, _point);
      }
      /* Taller up the slope, and a mixed habit throughout — the one cluster
         the review liked was dark pines with lighter leafy crowns and a bush
         in it, so the variant and the colour both move within a stand. */
      pushRidge(
        ridgeItems,
        (routeIndex + i * 2) % 3 === 0 ? 1 : 0,
        _point, local, r,
        [r.f(3.4, 6.2), r.f(4.6, 8.4), r.f(6, 11), r.f(5, 9.5)][level],
        [0x2c6a46, 0x35754a, 0x40824c, 0x4d8f50, 0x275e45, 0x599553],
        [-0.08, 0.08],
      );
    }
  }

  /* The hinterland: everything the road is not standing next to.
     Seen from above, all of the planting above is a speckled ribbon perhaps
     forty metres wide hugging the corridor, with the whole interior of the
     basin and the whole back of every landform bare. That is why the stage
     reads as a road with scenery attached rather than as a landscape with a
     road through it, and it is also why there is no middle distance in any
     frame: the eye goes from the verge straight to the flat headlands on the
     horizon with nothing in between to measure against.

     Stations 12 to 15 are the back slope behind each wall — real mesh points,
     so nothing floats — and they run the full length of the stage on both
     sides. Woods rather than a wash: a long run of noise decides where the
     forest is at all, so it climbs some slopes and leaves others bare. */
  const woodNoise = noise1(seed * 311 + 53);
  routeIndex = 0;
  /* Thinned from 15 m and four per knot when the landmarks landed. This is the
     largest single rank in the stage — a third of all the ridge-tree instances
     — and the brief is explicit that generic vegetation gives way to things
     that are worth looking at. The wood still reads: the noise decides where
     the stands are, and it is the stands rather than their density that make
     the hillsides wooded. */
  for (let base = 30; base < field.track.length - 30; base += 19, routeIndex++) {
    for (const side of [-1, 1]) {
      const s = clamp(base + r.f(-5, 5), 25, field.track.length - 25);
      const local = field.profile(s, side);
      /* An open seaward shoulder belongs to the windswept rank below, but a
         seaward shoulder that is also pinched between two decks of the same
         road is not open at all — it is a wall, in frame, and it needs the
         same treatment as any other wall. */
      if (local.coastness > 0.5 && !local.constrained) continue;
      /* Where the wood is. Two scales, so a slope is either wooded or it is
         not, and the edges of the stands are ragged rather than dithered. */
      const density = woodNoise(s / 210 + side * 61) * 0.7
        + woodNoise(s / 74 + side * 23) * 0.45
        + local.inlandness * 0.35 - 0.18
        + (local.constrained ? 0.5 : 0);
      if (density < 0) continue;
      const count = Math.min(3, 1 + Math.floor(density * 4));
      for (let i = 0; i < count; i++) {
        /* A switchback wall has no back slope to scatter over — stations 12
           and up are the merge ramp climbing to the deck above, all of it in
           frame and all of it one curtain. It gets planted up its face
           instead, which is the only thing that breaks a surface the light
           cannot: two albedos a rung apart at the bottom of the ladder round
           to the same rung, a tree silhouette does not. */
        const station = local.constrained
          ? 8 + ((routeIndex + i * 2) % 6)
          : 12 + ((routeIndex + i) % 4);
        /* Looser than the corridor ranks: this is the rank whose whole job is
           back slopes, and trees do grow on a one-in-two hillside. What it has
           to refuse is the near-vertical rock of a cut face. */
        if (!standable(field, s, side, station, 2.1)) continue;
        landformPoint(field, s + r.f(-5, 5), side, station, _point);
        if (!local.constrained) {
          /* Nudged along the slope so a rank does not line up with the mesh
             row it was sampled from. */
          _point.addScaledVector(local.f.flatRight, side * r.f(-6, 9));
        }
        _point.addScaledVector(local.f.tan, r.f(-5, 5));
        pushRidge(
          ridgeItems, r.chance(0.22) ? 1 : 0, _point, local, r,
          (local.constrained ? r.f(4, 9) : r.f(8, 17)) * (station > 13 ? 0.85 : 1),
          [0x2a5940, 0x336545, 0x3d7247, 0x28624a, 0x477c4a],
          [-0.08, 0.07],
        );
      }
    }
  }

  /* The seaward verge, which until now had nothing on it at all.
     Every rank above works from `-seaSideAt`, and the handful that walk both
     shoulders place by fraction of `wallDist` — which on the sea side is a
     rule that throws the plant off the cliff. `groundDelta` starts dropping at
     u = 0.16 and has fallen the full cliff by 0.48, so a coastal corridor of
     eighteen metres has about four metres of standable lip and fourteen metres
     of air. Anything planted past the lip either hung over the water or
     silhouetted against it, which is why the outer third of the frame has been
     empty water in every seaward capture.

     So this rank works in metres from the kerb, inside the lip, and it is not
     a mirror of the inland wood: salt kills anything tall and the wind lays
     the rest over. Low, olive rather than emerald, leaning away from the water,
     bunched into thickets with bare ground between them. */
  const SEA_SCRUB = [0x6b8a4f, 0x7a9455, 0x5b7a4c, 0x87975a, 0x647f52, 0x8fa063];
  routeIndex = 0;
  for (let base = 20; base < field.track.length - 20; base += 10, routeIndex++) {
    const centre = clamp(base + r.f(-3, 3), 20, field.track.length - 20);
    const side = field.coast.seaSideAt(centre);
    const profile = field.profile(centre, side);
    if (profile.coastness < 0.06) continue;
    /* Density follows exposure: a shoulder that is barely seaward keeps some
       of the inland habit, an open clifftop is almost bare between thickets. */
    const thicket = r.chance(0.62 - profile.coastness * 0.18);
    const count = thicket ? r.i(3, 6) : r.i(1, 2);
    const offsets = clump(r, 26, count);
    for (let i = 0; i < count; i++) {
      const s = clamp(centre + offsets[i], 20, field.track.length - 20);
      const local = field.profile(s, side);
      /* Metres from the kerb, not a fraction of a corridor that is mostly
         cliff. The far edge is held inside the lip so nothing stands on the
         drop, and `field.point` is sampled at the apron's own u = 0.12 and
         0.28 stations wherever it can be so the plant sits on the triangle
         that is actually drawn. */
      /* Half of it goes over the lip and down the face.
         Keeping everything on the flat strip between the kerb and the drop put
         the whole rank inside four metres of verge, where from the driver's
         seat it is a thin line of specks along the guardrail and the outer
         third of the frame is still open water. The slope below the road is
         the part of the seaward side that actually has area in frame, and
         scrub growing on it silhouettes against the sea, which is the read
         this side of the road has been missing. `field.point` follows
         `groundDelta` down the face, and 0.5 and 0.76 are apron stations, so
         these sit on drawn triangles rather than on the interpolated line
         between two of them. */
      /* A quarter of it goes over the lip and a little way down the face, for
         the silhouette against the water; the rest stands on the shoulder.
         Soft planting behind a guardrail does not need the full boulder
         clearance — nothing here is a hazard — so it uses the gravel figure
         and can therefore actually reach the part of the shoulder that is in
         frame. */
      const face = r.chance(0.26);
      const u = face
        ? 0.42 + r.f(-0.05, 0.12)
        : Math.min((GRAVEL_CLEAR + 1.2 + r.f(0, 1) * r.f(0, 1) * 5) / local.wallDist, 0.33);
      field.point(s, side, u, _point);
      /* Tall enough to clear the rail.
         Where this side of the road is a berm with a guardrail on it, a plant
         under about two metres is simply behind the rail from the driver's
         seat: the rank was being drawn and none of it was being seen. The
         habit is still low and wind-laid relative to the inland wood — these
         are three to six metres against twelve to seventeen on the hillside —
         but the lead plant of a thicket has to break the rail line or the
         outer third of the frame stays empty. */
      pushRidge(
        ridgeItems, r.chance(0.55) ? 1 : 0, _point, local, r,
        r.f(2.2, 4.4) * (i === 0 && thicket ? 1.65 : 1) * (face ? 1.5 : 1),
        SEA_SCRUB,
        // Laid over, always away from the water.
        [-0.34, -0.08],
      );
    }
    /* A wind-shaped tree every so often, for a silhouette with some height in
       it. One at a time and never in the thicket: an exposed headland grows
       lone trees, not stands. */
    if (routeIndex % 3 === 1 && profile.coastness > 0.14) {
      const local = field.profile(centre, side);
      const scale = r.f(0.62, 1.05);
      /* Unlike the scrub above, this is a modelled tree with a four-metre
         crown on it, so it takes the full prop clearance measured against that
         crown rather than against its trunk. */
      /* Measured against the crown the instance actually gets, not against
         the nominal one: the x scale runs up to 1.3, and testing the trunk's
         clearance against a crown thirty per cent narrower than the one that
         is drawn is how a six-metre tree came to overhang the tarmac. */
      const minU = clearOfRoad(local, 4.6 * scale * 1.3);
      if (minU === null) continue;
      const u = slotOutside(
        minU, (GRAVEL_CLEAR + 2.4 + r.f(0, 3.5)) / local.wallDist, 0.42,
      );
      if (u === null) continue;
      field.point(centre, side, u, _point);
      treeItems[1].push({
        position: _point.clone().addScaledVector(local.f.up, -0.12),
        rotation: new THREE.Euler(0, r.f(0, Math.PI * 2), r.f(-0.3, -0.14)),
        scale: new THREE.Vector3(scale * r.f(0.95, 1.3), scale * r.f(0.66, 0.86), scale),
        color: r.pick([0xd8e0c4, 0xcfdcbe, 0xe2e6cd]),
      });
    }
  }

  /* The final camera still needs forward scenery after the procedural loops
     reach their end condition. This is an arc-length end cap, not a shot
     anchor: it closes both shoulder ranks over the last 30 metres. */
  for (const remaining of [28, 20, 12, 5]) {
    const s = field.track.length - remaining;
    const seaSide = field.coast.seaSideAt(s);
    for (const side of [-1, 1]) {
      const profile = field.profile(s, side);
      for (let rank = 0; rank < 2; rank++) {
        const u = side === seaSide ? 0.14 + rank * 0.08 : 0.55 + rank * 0.2;
        field.point(s, side, u, _point);
        pushRidge(
          ridgeItems,
          (remaining + rank + (side > 0 ? 1 : 0)) % 5 === 0 ? 1 : 0,
          _point, profile, r, r.f(5.5, 9),
          [0x356b47, 0x427b4b, 0x4f8950, 0x2f6448],
          side === seaSide ? [-0.15, -0.02] : [-0.06, 0.06],
        );
      }
    }
  }

  const group = new THREE.Group();
  group.name = 'coastal-plants';
  for (let i = 0; i < 2; i++) {
    group.add(makeInstances(buildShrubGeometry(i), brushMaterial, brushItems[i], `leafy-shrubs-${i}`, false));
  }
  for (let i = 0; i < 3; i++) {
    group.add(makeInstances(buildTreeGeometry(i), treeMaterial, treeItems[i], `coastal-trees-${i}`, true));
  }
  for (let i = 0; i < 2; i++) {
    group.add(makeInstances(
      buildRidgeTreeGeometry(i), ridgeMaterial, ridgeItems[i], `ridge-trees-${i}`, false,
    ));
  }
  return group;
}

/**
 * A leaning verge marker: a squared timber post with a painted head.
 *
 * The seaward shoulder needs something man-made on it. Vegetation alone reads
 * as wilderness, and this is a road — the reference frames all keep a rhythm
 * of small vertical markers running along the drop side, which also gives the
 * eye something to measure speed against where the outer third of the frame is
 * otherwise open water. Ten triangles: a tapered post, and a cap band bright
 * enough to survive against the sea.
 */
function buildMarkerPostGeometry() {
  /* Two crossed quads, four triangles. A marker post is a hundred and fifty
     millimetres wide and one and a half metres tall, which at the distance it
     is read from — a hundred metres down a straight — is between one and two
     pixels across. There is nothing for a section to do at that size, and a
     crossed billboard has the same silhouette from every heading while costing
     less than half of the three-sided cylinder it replaces. The head is a
     separate pair of quads because the white band is the part that carries. */
  const positions = [], colors = [];
  const band = (y0, y1, halfWidth, hex) => {
    _color.setHex(hex);
    for (let plane = 0; plane < 2; plane++) {
      const p = (x, y) => (plane === 0 ? [x, y, 0] : [0, y, x]);
      const w0 = halfWidth * 1.15, w1 = halfWidth;
      for (const point of [
        p(-w0, y0), p(w0, y0), p(-w1, y1),
        p(w0, y0), p(w1, y1), p(-w1, y1),
      ]) {
        positions.push(...point);
        colors.push(_color.r, _color.g, _color.b);
      }
    }
  };
  band(0, 1.24, 0.075, 0x6d6553);
  band(1.24, 1.52, 0.08, 0xe8e2d2);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return finishGeometry(geometry);
}

function buildVergeMarkers(field, seed, material) {
  const r = rand(rng(seed * 331 + 19));
  const items = [];
  /* Continuous, not in strings.
     The first version posted a run of three to seven every forty-six metres
     and dropped a third of those, which is one short group every seventy
     metres of coast — from the driver's seat, looking a hundred metres down a
     straight, that is a single post somewhere in the outer third of the frame
     and then nothing. A marker line's whole job is rhythm: it has to be there
     continuously for the eye to read speed off it. Spacing still varies, and
     it still thins out where the shoulder stops being a drop, but it no longer
     stops. */
  for (let base = 40; base < field.track.length - 40; base += 21) {
    const centre = clamp(base + r.f(-3, 3), 30, field.track.length - 30);
    const side = field.coast.seaSideAt(centre);
    const exposure = field.profile(centre, side).coastness;
    if (exposure < 0.07) continue;
    if (r.chance(0.3 - exposure * 0.24)) continue;
    const run = exposure > 0.4 ? r.i(2, 3) : 1;
    for (let i = 0; i < run; i++) {
      const s = clamp(centre + i * r.f(5.5, 7.5), 30, field.track.length - 30);
      const profile = field.profile(s, side);
      const u = Math.min((GRAVEL_CLEAR + 1.4 + r.f(-0.3, 0.6)) / profile.wallDist, 0.3);
      field.point(s, side, u, _point);
      const scale = r.f(0.9, 1.2);
      items.push({
        position: _point.clone().addScaledVector(profile.f.up, -0.06),
        rotation: new THREE.Euler(r.f(-0.05, 0.05), r.f(0, Math.PI * 2), r.f(-0.13, 0.06)),
        scale: new THREE.Vector3(scale, scale * r.f(0.88, 1.14), scale),
      });
    }
  }
  return makeInstances(buildMarkerPostGeometry(), material, items, 'verge-markers', false);
}

function buildGrassTuftGeometry() {
  const parts = [];
  const specs = [
    [-0.28, 0, 1.25, -0.16, -0.45],
    [0.18, 0.04, 1.55, 0.2, 0.35],
    [-0.02, -0.18, 1.0, 0.1, 1.35],
    [0.32, 0.16, 0.82, -0.12, 2.25],
  ];
  for (const [x, z, height, lean, yaw] of specs) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.13, 0, 0,
      0.13, 0, 0,
      lean, height, 0,
    ], 3));
    geometry.rotateY(yaw);
    geometry.translate(x, 0, z);
    parts.push(geometry);
  }
  const merged = mergeGeometries(parts);
  parts.forEach(geometry => geometry.dispose());
  return grounded(merged);
}

function buildGrassPatches(field, seed, material) {
  const r = rand(rng(seed * 211 + 67));
  const items = [];
  for (let cluster = 0; cluster < 34; cluster++) {
    const centre = r.f(0.025, 0.98) * field.track.length;
    const seaSide = field.coast.seaSideAt(centre);
    const side = r.chance(0.65) ? -seaSide : seaSide;
    const count = r.i(6, 11);
    for (let i = 0; i < count; i++) {
      const s = clamp(centre + r.f(-16, 16) + r.f(-6, 6), 20, field.track.length - 20);
      const profile = field.profile(s, side);
      const upper = side === field.coast.seaSideAt(s) ? 0.16 : 0.23;
      const u = clamp(r.f(0.045, upper), Math.min(upper, 1.1 / profile.wallDist), upper);
      field.point(s, side, u, _point);
      const scale = r.f(0.55, 1.35);
      items.push({
        position: _point.clone().addScaledVector(profile.f.up, -0.025),
        rotation: new THREE.Euler(0, r.f(0, Math.PI * 2), r.f(-0.08, 0.08)),
        scale: new THREE.Vector3(scale * r.f(0.78, 1.25), scale, scale * r.f(0.82, 1.18)),
        color: r.pick([0x3f8443, 0x579a49, 0x74a84e, 0x86aa54]),
      });
    }
  }
  /* Tussock along the whole seaward lip, continuous rather than clustered.
     Grass is the one thing that does grow everywhere on an exposed clifftop,
     and it is the cheapest way to stop the outer third of the frame being a
     flat green band with a hard edge against the water. Straw and grey-green
     rather than the meadow palette: this is the salt-burnt side. */
  for (let base = 16; base < field.track.length - 16; base += 9) {
    const s = clamp(base + r.f(-2.5, 2.5), 16, field.track.length - 16);
    const side = field.coast.seaSideAt(s);
    const profile = field.profile(s, side);
    if (profile.coastness < 0.1 || r.chance(0.3)) continue;
    for (let i = 0; i < (r.chance(0.4) ? 2 : 1); i++) {
      const u = Math.min((3.2 + r.f(0, 1) * r.f(0, 1) * 9) / profile.wallDist, 0.29);
      field.point(s + r.f(-3, 3), side, u, _point);
      const scale = r.f(0.7, 1.6);
      items.push({
        position: _point.clone().addScaledVector(profile.f.up, -0.03),
        rotation: new THREE.Euler(0, r.f(0, Math.PI * 2), r.f(-0.2, -0.02)),
        scale: new THREE.Vector3(scale * r.f(0.8, 1.3), scale * r.f(0.62, 0.95), scale * r.f(0.82, 1.2)),
        color: r.pick([0x8a9553, 0x9aa25c, 0x74874e, 0xa5a866, 0x6d8352]),
      });
    }
  }

  const mesh = makeInstances(buildGrassTuftGeometry(), material, items, 'swaying-roadside-grass', false);
  return animateMaterialOnRender(mesh, material);
}

/**
 * A bird is two strokes and a body, not a delta.
 *
 * The previous version was one triangle per wing running from the nose out to
 * the tip, which fills the whole quarter-plane between them — a solid arrowhead
 * whatever it is doing, and enlarging it only made it a bigger arrowhead. What
 * reads as a bird at any distance is the aspect ratio of the wing: a stroke
 * four or five times longer than it is wide, swept back, with the two of them
 * meeting at a body narrow enough to disappear.
 *
 * That much survives. What did not is that the stroke was FLAT. Every y in the
 * wing was 0 except 0.02 at the leading root, so over a half-span of 1.19 the
 * plane sat 0.96 degrees off horizontal: a sheet of paper 2.52 m wide and 3 cm
 * deep. Both wings therefore shared one normal, and no lit ramp can put two
 * different tones on one normal — which was academic anyway, because the
 * material was the UNLIT one and no tonal difference between the wings was
 * reachable at all. A bird with one tone on both wings is a paper dart.
 *
 * So the wing is now arched, in two segments with a bend at the elbow — 24
 * degrees on the inner panel, 17 on the outer — which is a gull's own section
 * and, more to the point, gives the two wings normals that diverge by about
 * fifty degrees. Under the stage's low side sun that is one wing lit and one
 * wing in shade, which is the whole read. The chords are cambered so the
 * trailing edge sits below the leading edge, which makes each panel a
 * non-planar quad whose two triangles carry different normals — the wing has a
 * value gradient along it instead of one flat fill.
 *
 * Ten triangles, up from six, on about seventy instances in the whole stage.
 *
 * Authored at UNIT SPAN — the geometry is exactly 1.0 wide tip to tip — so the
 * per-instance span attribute is the bird's wingspan in metres and nothing has
 * to be back-computed through a scale factor to know how big a bird is.
 */
const BIRD_ELBOW = 0.22;             // along the half-span, so 44% out
const BIRD_INNER_DEG = 24;
const BIRD_OUTER_DEG = 17;

function buildBirdGeometry() {
  const pos = [];
  const tri = (a, b, c) => pos.push(...a, ...b, ...c);
  const inner = Math.tan((BIRD_INNER_DEG * Math.PI) / 180);
  const outer = Math.tan((BIRD_OUTER_DEG * Math.PI) / 180);
  const yRoot = 0.01;
  const yElbow = yRoot + BIRD_ELBOW * inner;
  const yTip = yElbow + (0.5 - BIRD_ELBOW) * outer;
  for (const sgn of [-1, 1]) {
    const rootLead = [sgn * 0.028, yRoot, -0.072];
    const rootTrail = [sgn * 0.028, yRoot, 0.086];
    const elbowLead = [sgn * BIRD_ELBOW, yElbow, -0.098];
    /* The camber. Without these two drops each panel is planar, its two
       triangles share a normal, and half the shading the arch buys is lost. */
    const elbowTrail = [sgn * BIRD_ELBOW, yElbow - 0.016, 0.074];
    const tipLead = [sgn * 0.5, yTip, 0.052];
    const tipTrail = [sgn * 0.44, yTip - 0.026, 0.138];
    /* Wound so both wings face the same way; the material is double-sided
       anyway, but with flat shading taking its normals from the derivative of
       the view position, a disagreeing winding is two wings lit from opposite
       sides — which is exactly the thing this geometry exists to control. */
    if (sgn < 0) {
      tri(rootLead, elbowLead, elbowTrail); tri(rootLead, elbowTrail, rootTrail);
      tri(elbowLead, tipLead, tipTrail); tri(elbowLead, tipTrail, elbowTrail);
    } else {
      tri(rootLead, elbowTrail, elbowLead); tri(rootLead, rootTrail, elbowTrail);
      tri(elbowLead, tipTrail, tipLead); tri(elbowLead, elbowTrail, tipTrail);
    }
  }
  /* The body, with a shallow keel so its two triangles are not coplanar
     either. Proportioned off the span the same way the wings are. */
  tri([0, 0.016, -0.1825], [-0.032, -0.004, 0.016], [0.032, -0.004, 0.016]);
  tri([-0.032, -0.004, 0.016], [0, 0.006, 0.2222], [0.032, -0.004, 0.016]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return finishGeometry(geometry);
}

/**
 * ── The birds are flocks now, and they carry ink ─────────────────────────────
 *
 * TWO defects and one consequence, all in this block.
 *
 * NOT FLOCKS. The old placement loop read like it made flocks — `flock < 9`,
 * `count = r.i(3,5)` — and made nothing of the sort, because every property
 * that would have bound a group together was drawn INSIDE the per-bird loop:
 * the distance offshore (105–240 m, so up to 135 m of lateral scatter within
 * one "flock"), the altitude (72–155 m, up to 83 m of vertical scatter) and the
 * scale, so they were not even the same species. And the drift that made the
 * looping path took its phase from `instanceMatrix[3]`, each bird's own
 * position, so no two members of a group were ever at the same point in the
 * loop. Cohesion was not tuned badly; it was unreachable by construction.
 *
 * The fix is to move the loop from the instance to the FLOCK. One centre, one
 * radius, one phase, one rate, held per member in instance attributes that are
 * identical across the group, so the group moves as one body by construction
 * and not by coincidence. A member carries only its formation offset, in the
 * flock's own frame, and that offset is rigid — which is what makes the spread
 * of a flock a fixed number of metres instead of an emergent one.
 *
 * The bank falls out of the circle rather than being dialled in: a body turning
 * at speed v on radius R banks atan(v^2/gR), so the flock's own geometry says
 * how far over the birds lean and a tighter turn leans further without anyone
 * choosing that. Speeds are gull cruising speeds and the radii are sized so the
 * resulting angles land between about six and twenty-two degrees.
 *
 * WINGSPAN. 2.52 m of geometry times a 1.5–2.8 instance scale was 3.8–7.1 m
 * for the flocks and 2.8–4.5 m for the near passes. A herring gull is 1.4 m and
 * the largest bird alive is 3.5 m, so the stage was flying pterosaurs. Spans
 * are now 1.30–1.62 m, with the near passes on the small end — the previous
 * round established that the arrow read was the silhouette and not the size, so
 * shrinking these does not reopen it.
 *
 * INK, which is the consequence. The ink pass renders the scene through
 * `scene.overrideMaterial`, whose vertex shader is `modelViewMatrix *
 * vec4(position,1.0)` — it never touches `instanceMatrix` and it never runs the
 * motion above. An `InstancedMesh` full of birds is therefore ONE un-expanded
 * copy at the model origin in the normals buffer, so the ink pass has no idea
 * there is a bird anywhere and draws the contour of whatever is behind it
 * across its front. outline.js publishes the opt-in for exactly this case and
 * the crowd at the foot of this file already uses it; the birds now take the
 * same shape. An `InstancedBufferGeometry` drawn by a plain `Mesh`, kept out of
 * the override pass, with a prepass material that shares the beauty material's
 * vertex body verbatim and the same uniform OBJECTS — not the same values, the
 * same objects, because the prepass runs first inside one `pipeline.render()`
 * and a clock read twice would put the outline a frame away from the bird.
 */
const BIRD_SETS = {
  far: {
    name: 'distant-bird-flocks', key: 'coastal-bird-flock',
    color: 0x33566a, beat: 11.5, amp: 0.62, bob: 1.6,
  },
  near: {
    name: 'near-road-bird-passes', key: 'coastal-bird-near',
    color: 0x2b4a5c, beat: 9.4, amp: 0.72, bob: 0.7,
  },
};
const BIRD_SPAN_FAR = [1.36, 1.62];
const BIRD_SPAN_NEAR = [1.3, 1.44];

const BIRD_ATTRS = /* glsl */`
attribute vec4 aFlock;   // xyz centre of the loop, w its radius
attribute vec4 aLoop;    // phase, rate (signed rad/s), span in metres, wingbeat phase
attribute vec4 aForm;    // formation offset right/up/back in the flock frame, w beat depth
uniform float uTime;
`;

/**
 * The flight, as one GLSL string shared verbatim by the beauty material and the
 * ink prepass material. Everything a bird does happens in here: there is no
 * per-frame CPU work behind any of them.
 *
 * The wingbeat first, in the bird's own frame. Two things make it read as a
 * beat rather than a wobble. The waveform dwells at its extremes instead of
 * sweeping evenly through them, so the eye gets the up pose and the down pose
 * with a fast transit between — the two frames of animation that were asked
 * for, without the popping of an actual two-frame cycle. And the span shortens
 * as the wings leave the horizontal, because a wing rotating about the body
 * foreshortens; without that the silhouette bends and stays the same width,
 * which is what a sheet of paper does.
 */
function birdVertBody(beat, amplitude, bob) {
  return /* glsl */`
  float wave = sin(uTime * ${beat.toFixed(2)} + aLoop.w);
  float flap = sign(wave) * pow(abs(wave), 0.35);
  vec3 local = position;
  local.y += abs(local.x) * flap * ${amplitude.toFixed(2)} * aForm.w;
  local.x *= 1.0 - abs(flap) * 0.26;
  local *= aLoop.z;

  /* Where the FLOCK is on its loop. One angle for every member, because these
     four numbers are the same on every instance of a group. */
  float ang = uTime * aLoop.y + aLoop.x;
  vec3 radial = vec3(sin(ang), 0.0, cos(ang));
  vec3 tangent = vec3(cos(ang), 0.0, -sin(ang));
  vec3 hub = aFlock.xyz + radial * aFlock.w;
  hub.y += sin(ang * 0.5) * ${bob.toFixed(2)};

  /* The bird's frame, banked into its own turn. v^2/gR, so the lean is the
     circle's and not a taste. */
  vec3 fwd = tangent * (aLoop.y < 0.0 ? -1.0 : 1.0);
  float v = aFlock.w * abs(aLoop.y);
  float bank = atan((v * v) / (9.81 * max(aFlock.w, 0.001)));
  vec3 up = normalize(vec3(0.0, cos(bank), 0.0) - radial * sin(bank));
  vec3 sideAxis = cross(up, -fwd);

  /* Formation offset in that frame, then the bird itself. Head is -z. */
  vec3 birdWorld = hub
    + sideAxis * aForm.x + up * aForm.y - fwd * aForm.z
    + sideAxis * local.x + up * local.y - fwd * local.z;
`;
}

/**
 * The JS side of the same flight path.
 *
 * A mirror of the GLSL above, and mirrors rot. This one is held honest from
 * outside: tools/birds.mjs parks a bird through the probe below, is told by
 * THIS function where the bird should now be, projects that through the camera
 * and measures where the silhouette actually landed in the picture. A mirror
 * that has drifted from the shader fails that check with a number attached.
 */
const _birdRadial = new THREE.Vector3();
const _birdFwd = new THREE.Vector3();
const _birdUp = new THREE.Vector3();
const _birdSide = new THREE.Vector3();

function birdPathPoint(item, t, out = new THREE.Vector3()) {
  const ang = t * item.rate + item.phase;
  _birdRadial.set(Math.sin(ang), 0, Math.cos(ang));
  _birdFwd.set(Math.cos(ang), 0, -Math.sin(ang)).multiplyScalar(item.rate < 0 ? -1 : 1);
  const speed = item.radius * Math.abs(item.rate);
  const bank = Math.atan((speed * speed) / (9.81 * Math.max(item.radius, 0.001)));
  _birdUp.set(0, Math.cos(bank), 0).addScaledVector(_birdRadial, -Math.sin(bank)).normalize();
  _birdSide.crossVectors(_birdUp, _birdFwd).multiplyScalar(-1);
  out.copy(item.centre).addScaledVector(_birdRadial, item.radius);
  out.y += Math.sin(ang * 0.5) * item.bob;
  return out
    .addScaledVector(_birdSide, item.form[0])
    .addScaledVector(_birdUp, item.form[1])
    .addScaledVector(_birdFwd, -item.form[2]);
}

/**
 * The beauty material and the ink-prepass material, sharing one uniform block.
 *
 * Lit, unlike the material this replaces. `movingCelMaterial` cannot be used
 * for either half: it mints its own uniforms inside `onBeforeCompile`, so the
 * two passes would not share the clock, and its motion string is injected
 * inside `main()` where an `attribute` declaration is not legal.
 */
function birdMaterials(uniforms, spec, body) {
  const beauty = environmentCelMaterial({
    color: spec.color, flatShading: true, side: THREE.DoubleSide, fog: true,
  });
  const compileCel = beauty.onBeforeCompile;
  beauty.onBeforeCompile = shader => {
    compileCel(shader);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = BIRD_ATTRS + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\n${body}\n  transformed = birdWorld;`,
    );
  };
  beauty.customProgramCacheKey = () => spec.key;

  /* The same expansion, writing what render/outline.js's own prepass writes: a
     geometric view normal from the derivatives of the view position, and the
     linear view distance in alpha. */
  const prepass = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.DoubleSide,
    vertexShader: `${BIRD_ATTRS}
varying vec3 vBirdView;
void main() {
${body}
  vec4 mv = modelViewMatrix * vec4(birdWorld, 1.0);
  vBirdView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: `precision highp float;
varying vec3 vBirdView;
void main() {
  vec3 n = normalize(cross(dFdx(vBirdView), dFdy(vBirdView)));
  gl_FragColor = vec4(n * 0.5 + 0.5, -vBirdView.z);
}`,
  });
  return { beauty, prepass };
}

function buildBirds(spec, items) {
  const source = buildBirdGeometry();
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', source.getAttribute('position'));
  geometry.setAttribute('normal', source.getAttribute('normal'));
  geometry.boundingBox = source.boundingBox;
  geometry.boundingSphere = source.boundingSphere;

  const n = items.length;
  const flock = new Float32Array(n * 4);
  const loop = new Float32Array(n * 4);
  const form = new Float32Array(n * 4);
  const write = i => {
    const it = items[i];
    flock[i * 4] = it.centre.x; flock[i * 4 + 1] = it.centre.y;
    flock[i * 4 + 2] = it.centre.z; flock[i * 4 + 3] = it.radius;
    loop[i * 4] = it.phase; loop[i * 4 + 1] = it.rate;
    loop[i * 4 + 2] = it.span; loop[i * 4 + 3] = it.beatPhase;
    form[i * 4] = it.form[0]; form[i * 4 + 1] = it.form[1];
    form[i * 4 + 2] = it.form[2]; form[i * 4 + 3] = it.amp;
  };
  for (let i = 0; i < n; i++) write(i);
  const attr = (array, size) => new THREE.InstancedBufferAttribute(array, size);
  const aFlock = attr(flock, 4), aLoop = attr(loop, 4), aForm = attr(form, 4);
  geometry.setAttribute('aFlock', aFlock);
  geometry.setAttribute('aLoop', aLoop);
  geometry.setAttribute('aForm', aForm);
  geometry.instanceCount = n;

  const uniforms = { uTime: { value: 0 } };
  const { beauty, prepass } = birdMaterials(
    uniforms, spec, birdVertBody(spec.beat, spec.amp, spec.bob));

  const mesh = new THREE.Mesh(geometry, beauty);
  /* The names are unchanged, deliberately. They are matched by name in exactly
     one place — the see-through list a sightline is allowed to ignore — and
     birds belong on it. Nothing here adds them to any other name filter. */
  mesh.name = spec.name;
  /* One draw of a few hundred triangles whose positions live in an instance
     attribute, so three's bounds are a metre wide and in the wrong place and
     there is nothing worth culling anyway. */
  mesh.frustumCulled = false;
  /* Both off for the same reason as the override pass: three's depth material
     does not run the vertex shader above, so a casting bird would cast its
     shadow from the model origin. */
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  /* The expansion is in world coordinates, so the mesh stays at the identity. */
  mesh.matrixAutoUpdate = false;
  skipOverridePass(mesh);
  registerPrepassMesh(mesh, prepass);

  /* ── The clock ──────────────────────────────────────────────────────────
   *
   * Advanced once per animation frame from a rAF of its own, and this is the
   * one place the birds depart from both of the precedents in this file.
   *
   * The grass and the turbines read `performance.now()` inside
   * `onBeforeRender`, which is fine for them because they are not in the ink
   * prepass. The birds now are, the prepass runs BEFORE the beauty pass inside
   * one `pipeline.render()`, and a clock latched by the beauty draw would hand
   * the prepass the previous frame's value — a near bird covers about ten
   * centimetres in that time, which at seven metres from the lens is tens of
   * pixels of outline sitting beside the bird instead of on it. The crowd
   * solves the same problem by being ticked from `Game.step`; nothing calls a
   * bird update, and `Game` is not this file's to change. A single tick per
   * frame, outside the render, gives every draw within one frame one value,
   * which is the property that actually matters.
   *
   * `hold` is for probes: pinned, two renders of a static scene are the same
   * picture, which tools/birds.mjs depends on and should not have to know this
   * file exists to get. The `onBeforeRender` path is a fallback for a page
   * whose rAF never runs, and trades outline coherence for the birds not
   * standing still.
   *
   * ── And it only advances while the world is being DRAWN ──────────────────
   *
   * A rAF fires whether or not anything was rendered, and the pause menu
   * freezes the picture by NOT RENDERING — that is the whole mechanism, see
   * the long note at src/main.js:1611. So a clock on a bare rAF kept climbing
   * behind the menu and the first frame drawn after the resume showed the
   * birds two seconds further round their loop: 2.09 s of uTime, 15.9 m of
   * bird, and a near-set silhouette that jumped 69 px across the frame
   * (.fix/FINDINGS-birdclock.md). Nothing was left inconsistent by it — a pop,
   * not a correctness break — but it is a pop on a menu whose entire job is to
   * hold the picture still.
   *
   * The gate is a SKIPPED total subtracted from the wall clock rather than a
   * tick moved into `Game.step`, and the difference matters three ways. It
   * leaves the write exactly where it is — once per rAF, outside
   * `pipeline.render()` — so the coherence argument above is untouched instead
   * of needing to be re-established. It costs nothing when nothing is skipped:
   * `skipped` is zero on a build that is never paused, so the uniform takes the
   * values it always took. And it answers the general question rather than the
   * pause: `Game.step` is not called at all while a tool holds the wheel
   * (`Game.paused`, src/main.js:1610), and those tools render by hand and would
   * have been left with frozen birds and with the fallback below — the one path
   * that really does hand the prepass a stale clock — as their live path.
   *
   * The cost is that a missing draw can only be noticed on the NEXT callback,
   * so a pause still costs what the frame it began on had already earned. That
   * is 0.4 ms of clock and 3 mm of bird, measured, against a resume that is
   * otherwise indistinguishable from an ordinary frame. */
  const clock = {
    held: false, ticks: 0, stopped: false, seen: false,
    /* Was the mesh submitted since the last callback, when that callback ran,
       and how much wall clock has been withheld from uTime so far. */
    drawn: false, at: -1, skipped: 0,
  };
  const advance = (now = performance.now()) => {
    if (!clock.held) uniforms.uTime.value = (now - clock.skipped) * 0.001;
  };
  if (typeof requestAnimationFrame === 'function') {
    const tick = () => {
      if (clock.stopped) return;
      /* Stops itself once the stage it belongs to has been torn down, so
         rebuilding on a new seed does not leave a loop per stage running. */
      if (mesh.parent) clock.seen = true;
      else if (clock.seen) { clock.stopped = true; return; }
      clock.ticks++;
      const now = performance.now();
      /* A callback that follows a frame in which nothing asked for this mesh
         withholds that interval instead of advancing over it. */
      if (!clock.drawn && clock.at >= 0) clock.skipped += now - clock.at;
      clock.drawn = false;
      clock.at = now;
      advance(now);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  const skipBefore = mesh.onBeforeRender;
  mesh.onBeforeRender = (renderer, scene, camera, geo, mat, group) => {
    /* Any submission, including the scene-wide normals override that
       fx/pass.js collapses to nothing: both halves happen inside one
       `pipeline.render()`, and what is being asked here is whether the world
       was drawn at all. */
    clock.drawn = true;
    if (clock.ticks === 0) advance();
    if (skipBefore) skipBefore(renderer, scene, camera, geo, mat, group);
  };

  /* What the build knows about its own birds, for the offline probes in tools/.
     Exposed rather than reimplemented for the reason crowdProbe is: a tool that
     re-derived the flight path would be grading its own copy of it. */
  mesh.userData.birdProbe = {
    lit: true,
    bank: items.map(it => (Math.atan((it.radius * it.rate) ** 2
      / (9.81 * Math.max(it.radius, 0.001))) * 180) / Math.PI),
    instances: () => items.map(it => ({
      flock: it.flock,
      span: it.span,
      /* The loop itself, so a probe can sample a whole revolution rather than a
         fixed thirty seconds and hope. Without the rate it cannot know how long
         one is, and a bird whose worst point falls outside the window it happened
         to walk is a bird the probe was structurally unable to see. */
      radius: it.radius,
      rate: it.rate,
      /* And the station this flock was authored from.
         A probe that recovers it with `track.project` instead gets it wrong
         where two decks of the same road run close: the global sweep takes the
         nearest frame in space, which beside a switchback is the OTHER deck, and
         the shoulder fraction then comes out of a frame the bird is nowhere
         near. Measured, seed 3 at half distance: a point parked at u = 0.95 came
         back as u = 0.099 and its ground 30 m out. Handing over the authored
         station lets a probe hint the search and stay on the right deck. */
      s: it.s,
      side: it.side,
      at: birdPathPoint(it, uniforms.uTime.value).toArray(),
    })),
    isolate(k) { geometry.instanceCount = Math.max(0, Math.min(k, n)); },
    restore() { geometry.instanceCount = n; },
    pin(t) { clock.held = true; uniforms.uTime.value = t; },
    release() { clock.held = false; },
    /* Park one bird exactly where it is asked for, and say where that was.
       Radius and rate zero, so the loop is frozen and the bank with it, and no
       formation offset: what is left is the flock centre, which IS the bird. */
    park(i, x, y, z, yaw) {
      const it = items[i];
      it.centre.set(x, y, z);
      it.radius = 0;
      it.rate = 0;
      it.phase = yaw;
      it.form[0] = it.form[1] = it.form[2] = 0;
      write(i);
      aFlock.needsUpdate = aLoop.needsUpdate = aForm.needsUpdate = true;
      return birdPathPoint(it, uniforms.uTime.value).toArray();
    },
    dispose() {
      clock.stopped = true;
      unregisterPrepassMesh(mesh);
    },
  };
  return mesh;
}

function buildBirdFlocks(field, seed) {
  const r = rand(rng(seed * 223 + 79));
  const items = [];
  for (let flock = 0; flock < 9; flock++) {
    const at = r.f(0.04, 0.96) * field.track.length;
    const f = field.track.frameAt(at);
    const side = r.chance(0.72) ? field.coast.seaSideAt(at) : -field.coast.seaSideAt(at);
    /* Everything from here to the member loop is drawn ONCE. That is the whole
       difference between this and what it replaces. */
    const radius = r.f(38, 74);
    const centre = f.pos.clone()
      .addScaledVector(f.flatRight, side * r.f(105, 240))
      .addScaledVector(f.tan, r.f(-40, 40))
      .add(new THREE.Vector3(0, r.f(72, 155), 0));
    const speed = r.f(8.5, 12);
    const rate = (speed / radius) * (r.chance(0.5) ? 1 : -1);
    const phase = r.f(0, Math.PI * 2);
    /* A flock is one species. The variation is between individuals, not
       between a bird and the bird beside it. */
    const span = r.f(BIRD_SPAN_FAR[0], BIRD_SPAN_FAR[1]);
    const gap = span * r.f(1.8, 2.6);
    const beat = r.f(0, Math.PI * 2);
    const count = r.i(3, 5);
    for (let i = 0; i < count; i++) {
      const rank = i - (count - 1) * 0.5;
      items.push({
        flock,
        s: at,
        side,
        centre: centre.clone(),
        radius,
        rate,
        phase,
        bob: BIRD_SETS.far.bob,
        span: span * (1 + r.f(-0.03, 0.03)),
        form: [
          rank * gap,
          rank * span * 0.35 + r.f(-0.25, 0.25),
          Math.abs(rank) * gap * 0.75 + r.f(-0.3, 0.3),
        ],
        /* Close but not locked: a flock's wingbeats are neighbours, not a
           chorus line. */
        beatPhase: beat + r.f(-0.5, 0.5),
        amp: r.f(0.92, 1.08),
      });
    }
  }
  return buildBirds(BIRD_SETS.far, items);
}

/* How wide a berth a near loop gives the road, and how big it may be.
 *
 * The centre sits `NEAR_STANDOFF` past the road edge PLUS its own radius, so the
 * inner side of the loop passes at the standoff and the outer side reaches
 * `2 * radius + standoff` out. That second number is the one the corridor has to
 * be able to hold, and it is the number the shipped formula was written for and
 * the clamp floor then discarded. */
const NEAR_STANDOFF = [4.5, 9];
const NEAR_LOOP_MAX = 26;
/* The smallest loop that still reads as flight. Not a taste: see
   .fix/FINDINGS-birdroom.md §4, where it is measured against both the fixed
   point this replaced and the bank envelope that is pixel-verified. */
const NEAR_LOOP_MIN = 7;
/* The bank the circle is flown at, in degrees. Inside 13.8°–32.3°, which is the
   range `birdPathPoint` has been pixel-verified across in the banked pose
   (tools/birds.mjs, .fix/birdroom.mjs) — so the speed is derived from the radius
   and the bank rather than drawn independently of them. Drawing speed on its own,
   which is what shipped, makes bank a consequence of whatever radius survived
   the clamp: at the floor of 10 m and the top of the old speed range it came out
   at 39°, outside the verified band, and a floor any lower would be steeper
   still. That is the real reason a radius cannot simply be shrunk. */
const NEAR_BANK = [15, 29];
/* Metres of air under the LOWEST point of the whole loop, over the shoulder the
   frame actually draws. A bird flies this far above the ground it passes over
   rather than this far above the road, which is the difference between the two
   halves of the defect: the road is level and the shoulder it flies along is
   not. */
const NEAR_RIDE = [7, 12];
const _birdRoomA = new THREE.Vector3();

/**
 * The largest circle this shoulder can hold at this station, or null.
 *
 * `clamp((wallDist - 9) * 0.5, 10, 26)` is the shape of this calculation with a
 * floor bolted to the bottom of it, and the floor is the defect: where the
 * corridor is tight the floor wins, `wallDist` is consulted and then thrown
 * away, and the bird circles on a radius the shoulder cannot contain. Measured
 * before this went in, 228 of 493 near birds across the fourteen boot seeds left
 * the corridor, by up to 21.4 m.
 *
 * So this returns null instead, exactly as `clearOfRoad` above does and for the
 * same reason: a floor jams the object against the kerb, whereas null lets the
 * caller shrink it, move it or drop it. The caller here moves it — see
 * `buildNearBirdPasses` — because dropping a third of the near set is a
 * different defect from the one being fixed.
 *
 * Two things the shipped line did not do, both of which matter:
 *
 * It reads the corridor along the whole SWEEP and not just at the centre. The
 * loop is in the world XZ plane (`birdVertBody`: `radial = vec3(sin, 0, cos)`),
 * so it travels as far along the road as it does across it, and `wallDist`
 * twenty-six metres away is a different number — this is a hill road, and half
 * the tight stations in the stage are tight because of a corner the loop reaches
 * into.
 *
 * And it uses the standoff it will actually be given rather than assuming the
 * worst one. The shipped code drew `radius` before the standoff and so had to
 * hard-code 9, the top of the range; drawing the standoff first costs nothing
 * and buys up to 2.25 m of radius.
 *
 * The bound is applied at the widest sweep first and then relaxed once, which is
 * sound in that order: shrinking the loop can only widen the narrowest corridor
 * it reaches, so the relaxed radius is re-verified before it is accepted and the
 * conservative one is kept if it fails.
 */
function birdLoopFit(field, s, side, standoff, radius) {
  let wall = Infinity;
  const step = Math.max(2.5, radius / 8);
  for (let d = -radius; d <= radius + 1e-6; d += step) {
    const at = clamp(s + d, 0, field.track.length);
    wall = Math.min(wall, field.profile(at, side).wallDist);
  }
  return (wall - standoff) * 0.5;
}

function birdLoopRadius(field, s, side, standoff) {
  let radius = Math.min(NEAR_LOOP_MAX, birdLoopFit(field, s, side, standoff, NEAR_LOOP_MAX));
  if (radius >= NEAR_LOOP_MIN) {
    const grown = Math.min(NEAR_LOOP_MAX, birdLoopFit(field, s, side, standoff, radius));
    if (grown > radius && birdLoopFit(field, s, side, standoff, grown) >= grown) radius = grown;
  }
  return radius >= NEAR_LOOP_MIN ? radius : null;
}

/**
 * Where the ground is under a point on a bird's path, in the corridor's terms.
 *
 * `wallDist` bounds the sweep LATERALLY and says nothing at all about how high
 * the ground under it is, and on a shoulder rising at up to nine per cent that
 * is the other half of why birds ended up inside slopes: the apron at u = 1 can
 * stand twenty metres above the road the centre was placed off, while the bird
 * was placed 7–12 m above that road. A loop that is perfectly contained
 * laterally still flies into the hill.
 *
 * `drawnGroundY` and not `field.point` deliberately — see its own comment. It is
 * what `buildLandform` actually triangulates, and the shoulder a bird has to
 * clear is the one the frame draws rather than an analytic surface nothing
 * renders. It is also exactly the signal .fix/birdroom.mjs scores this against,
 * so the build and the instrument are answering the same question.
 *
 * Which station a point belongs to is asked in PLAN, and searched rather than
 * projected. Projecting onto the placing tangent — which is what the first cut of
 * this did — is first order in lateral offset times curvature, and those are
 * exactly the two quantities a bird loop is large in: on the switchbacks R is
 * near 30 m and the sweep reaches 30 m out over 26 m of road, so the station came
 * back up to twenty metres wrong and `u` with it. Measured, that was the entire
 * remaining disagreement between this fit and the plan-space search
 * .fix/birdroom.mjs scores with, and it left six birds of 489 a few metres past
 * the line. Searching costs about fifty frame lookups a sample, which is nothing
 * at build time and buys agreement with the instrument.
 *
 * Bounded to ±70 m of the placing station, as the instrument is: unbounded, a
 * bird beside a hairpin gets assigned to the other leg of it, and it is the leg
 * it was placed off whose corridor it has to stay inside.
 *
 * In PLAN and not in three dimensions, which is `track.project`'s error and has
 * had to be beaten out of the instrument three times: `project` minimises the y
 * term too, so lifting a bird moves the station it resolves to.
 */
let _birdRoomF = null;
function birdGroundUnder(field, f, s, side, x, z) {
  /* One scratch frame for the whole build — `frameAt` fills a target if handed
     one and allocates if not, and this runs ten thousand times per flock. */
  if (!_birdRoomF) _birdRoomF = field.track.frameAt(0);
  const end = field.track.length;
  const lo = Math.max(0, s - 70), hi = Math.min(end, s + 70);
  let at = s, best = Infinity;
  const sweep = (from, to, step) => {
    for (let q = from; q <= to + 1e-6; q += step) {
      const g = field.track.frameAt(q, _birdRoomF);
      const d = (g.pos.x - x) ** 2 + (g.pos.z - z) ** 2;
      if (d < best) { best = d; at = q; }
    }
  };
  sweep(lo, hi, 6);
  sweep(Math.max(lo, at - 6), Math.min(hi, at + 6), 0.5);
  const profile = field.profile(at, side);
  const g = profile.f;
  const lat = Math.abs((x - g.pos.x) * g.flatRight.x + (z - g.pos.z) * g.flatRight.z);
  const u = (lat - g.width * 0.5) / Math.max(1e-3, profile.wallDist);
  return { y: drawnGroundY(field, at, side, clamp(u, 0, 1)), u };
}

/**
 * Walk a candidate flock right round its loop and report what it needs.
 *
 * Three numbers, from one walk, because they all want the same 64 path points:
 *
 *   dip     how far the lowest point of the loop falls below `centre.y`. Taken
 *           from `birdPathPoint` rather than added up from `bob` and `form`,
 *           because the parts do not sum the obvious way: the formation's
 *           sideways offset is applied along a BANKED axis, so at 29° of bank a
 *           bird three metres to the side of its flock is also a metre and a half
 *           below it, and that term appears in no sum of the components.
 *   ground  the highest drawn shoulder any member passes over.
 *   reach   the furthest out, as a fraction of the corridor, the loop actually
 *           gets. This is the check rather than the arithmetic: `(wallDist -
 *           standoff) / 2` is exact in the placing frame and first-order once the
 *           road curves under the sweep, and measured, that left two birds of
 *           sixty-three a metre past the line. Walking it costs nothing extra
 *           here and is the same quantity .fix/birdroom.mjs scores.
 */
function birdLoopWalk(field, f, s, side, members, rate) {
  let dip = Infinity, ground = -Infinity, reach = 0;
  const turn = (Math.PI * 2) / Math.abs(rate);
  for (let k = 0; k < 64; k++) {
    const t = (k / 64) * turn;
    for (const it of members) {
      birdPathPoint(it, t, _birdRoomA);
      dip = Math.min(dip, _birdRoomA.y);
      const at = birdGroundUnder(field, f, s, side, _birdRoomA.x, _birdRoomA.z);
      ground = Math.max(ground, at.y);
      reach = Math.max(reach, at.u);
    }
  }
  return { dip, ground, reach };
}

function buildNearBirdPasses(field, seed) {
  const r = rand(rng(seed * 229 + 97));
  const items = [];
  let rejected = 0, offered = 0, widened = 0, shrunk = 0, lifted = 0, dropped = 0;
  for (let pass = 0; pass < 14; pass++) {
    /* The pass still owns its own stretch of the stage — the fourteen are spread
       so a driver meets one every few seconds, and that is worth keeping. What
       changes is that within its stretch it now LOOKS for a shoulder that can
       hold a loop instead of taking the first station offered and jamming a
       10 m circle into it. Dropping the ones that do not fit would cost about a
       third of the near set, and thinning the set is the defect the previous
       round was fixing rather than a repair. */
    const wanted = r.sign();
    const phase = r.f(0, Math.PI * 2);
    const span = r.f(BIRD_SPAN_NEAR[0], BIRD_SPAN_NEAR[1]);
    const gap = span * r.f(1.7, 2.3);
    const beat = r.f(0, Math.PI * 2);
    const count = r.i(2, 3);
    const bankWant = r.f(NEAR_BANK[0], NEAR_BANK[1]) * (Math.PI / 180);
    const turnSign = r.chance(0.5) ? 1 : -1;
    const ride = r.f(NEAR_RIDE[0], NEAR_RIDE[1]);
    const jitter = [];
    for (let i = 0; i < count; i++) {
      jitter.push([r.f(-0.03, 0.03), r.f(-0.2, 0.2), r.f(-0.25, 0.25),
        r.f(-0.5, 0.5), r.f(0.92, 1.08)]);
    }
    /* Build the flock at a site, walk it, and shrink it if the walk says the
       sweep gets past the corridor after all. Every draw the members need is
       already made above, so a retry re-shapes the SAME flock at a new size or a
       new station rather than becoming a different one — and the number of random
       draws per pass does not depend on how many retries it takes, which is what
       keeps a seed's stage the same stage. */
    const shape = (site, radius) => {
      /* Speed from the radius and the bank rather than on its own, so a tight
         loop is a slower, tighter circle instead of a knife-edge one.
         v^2/(gR) = tan bank, the same relation the shader banks by. */
      const rate = (Math.sqrt(9.81 * radius * Math.tan(bankWant)) / radius) * turnSign;
      const centre = site.f.pos.clone().addScaledVector(
        site.f.flatRight, site.side * (site.f.width * 0.5 + radius + site.standoff));
      centre.y = 0;
      const members = jitter.map(([dSpan, dUp, dBack, dBeat, amp], i) => {
        const rank = i - (count - 1) * 0.5;
        return {
          flock: pass, s: site.s, side: site.side, radius, rate, phase,
          centre: centre.clone(),
          bob: BIRD_SETS.near.bob,
          span: span * (1 + dSpan),
          form: [rank * gap, rank * span * 0.3 + dUp, Math.abs(rank) * gap * 0.7 + dBack],
          beatPhase: beat + dBeat,
          amp,
        };
      });
      return {
        members, rate, radius,
        ...birdLoopWalk(field, site.f, site.s, site.side, members, rate),
      };
    };

    /* 0.96 and not 1: the last four per cent of the corridor is where the apron
       meets the foot of the wall, and a bird whose wingtip is in the last few
       inches of it is not a bird with room. */
    const FITS = 0.96;
    /* Sample a window of the stage for shoulders that can hold a loop, roomiest
       first, then try to seat the flock on them in that order. Two stages of
       filter: `birdLoopRadius` is the cheap analytic one over the sweep's own
       stretch of road, the walk is the exact one. */
    const seat = (from, to) => {
      const found = [];
      for (let k = 0; k < 11; k++) {
        const s = clamp(lerp(from, to, (k + r.f(0.1, 0.9)) / 11), 25, field.track.length - 25);
        for (const side of [wanted, -wanted]) {
          const standoff = r.f(NEAR_STANDOFF[0], NEAR_STANDOFF[1]);
          const radius = birdLoopRadius(field, s, side, standoff);
          offered++;
          if (radius !== null) found.push({ s, side, standoff, radius });
          else rejected++;
        }
      }
      /* The roomiest shoulder in the window first, and the side it originally
         asked for where that costs nothing, so the two shoulders still
         alternate along the stage. */
      found.sort((a, b) => (b.radius - a.radius)
        || ((a.side === wanted ? 0 : 1) - (b.side === wanted ? 0 : 1)));
      for (const cand of found.slice(0, 10)) {
        cand.f = field.track.frameAt(cand.s);
        let attempt = shape(cand, cand.radius);
        for (let k = 0; k < 5 && attempt.reach > FITS; k++) {
          const smaller = attempt.radius * 0.86;
          if (smaller < NEAR_LOOP_MIN) break;
          attempt = shape(cand, smaller);
        }
        if (attempt.reach <= FITS) return { built: attempt, site: cand };
      }
      return null;
    };
    /* A stage where a whole fourteenth of the road is too tight anywhere on
       either shoulder is not hypothetical — the switchback chapter holds
       `wallDist` in single figures for a long way — so a pass that cannot seat
       its flock in its own stretch looks half a window either side, and then at
       three windows, before it gives up. Spreading the fourteen evenly along the
       stage is worth something, but it is not worth a third of the set: thinning
       the near birds is the defect the previous round was repairing, so the
       neighbouring stretch is the lesser cost. */
    const L = field.track.length;
    let got = seat(((pass + 0.12) / 14) * L, ((pass + 0.94) / 14) * L);
    for (const wide of [1.5, 3.5]) {
      if (got) break;
      widened++;
      got = seat(((pass + 0.53 - wide * 0.5) / 14) * L, ((pass + 0.53 + wide * 0.5) / 14) * L);
    }
    if (!got) { dropped++; continue; }
    const { built, site } = got;
    if (built.radius < NEAR_LOOP_MAX) shrunk++;
    /* And lift the flock until the LOWEST point of the whole loop rides clear of
       the highest ground any member passes over. `centre.y` is zero in the walk
       and `birdPathPoint` is linear in it, so the one walk gives both. */
    const y = built.ground + ride - built.dip;
    if (y > site.f.pos.y + NEAR_RIDE[1]) lifted++;
    for (const it of built.members) it.centre.y = y;
    items.push(...built.members);
  }
  field.nearBirdPlacement = {
    offered, rejected, widened, shrunk, lifted, dropped, flocks: 14,
    placed: new Set(items.map(it => it.flock)).size,
  };
  return buildBirds(BIRD_SETS.near, items);
}

function flowerStarGeometry(radius = 0.32) {
  const shape = new THREE.Shape();
  const points = 10;
  for (let i = 0; i < points; i++) {
    const angle = Math.PI * 0.5 + (i / points) * Math.PI * 2;
    const rr = i % 2 ? radius * 0.43 : radius;
    const x = Math.cos(angle) * rr, y = Math.sin(angle) * rr;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

function buildFlowerHeadGeometry() {
  const parts = [];
  const heads = [
    [-0.42, 1.04, 0.03, -0.42],
    [0.3, 1.3, 0.02, 0.86],
  ];
  for (const [x, y, z, yaw] of heads) {
    const star = flowerStarGeometry(0.34);
    star.rotateY(yaw);
    star.rotateZ((x + z) * 0.18);
    star.translate(x, y, z);
    parts.push(star);
  }
  const merged = mergeGeometries(parts);
  parts.forEach(g => g.dispose());
  return grounded(merged);
}

function buildFlowerStemGeometry() {
  const parts = [];
  const stems = [
    [-0.42, 1.04, 0.03, -0.08, -0.42],
    [0.3, 1.3, 0.02, 0.035, 0.86],
  ];
  for (const [x, height, z, lean, yaw] of stems) {
    const stem = new THREE.PlaneGeometry(0.07, height);
    stem.translate(0, height * 0.5, 0);
    stem.rotateZ(lean);
    stem.rotateY(yaw);
    stem.translate(x, 0, z);
    parts.push(stem);
  }
  const merged = mergeGeometries(parts);
  parts.forEach(g => g.dispose());
  return grounded(merged);
}

function buildWildflowers(field, seed, flowerMaterial, stemMaterial) {
  const r = rand(rng(seed * 139 + 43));
  const heads = [], stems = [];
  /* Halved when the scheduled flower blazes landed. These are the thin
     background scatter; the blazes are the ones that are meant to be looked
     at, and running both at full density made a five-hundred-instance flower
     bill for a stage with a tight triangle ceiling. */
  const macroClusters = 14;
  for (let c = 0; c < macroClusters; c++) {
    const centre = r.f(0.018, 0.982) * field.track.length;
    const seaSide = field.coast.seaSideAt(centre);
    const side = r.chance(0.68) ? -seaSide : seaSide;
    /* One hue per patch, with only an occasional neighbour from the next
       family. This reads as magenta/yellow/white/orange brushstrokes at racing
       speed instead of confetti spread evenly along the whole road. */
    const family = c % FLOWER_COLORS.length;
    const count = r.i(6, 12);
    for (let i = 0; i < count; i++) {
      const s = clamp(
        centre + r.f(-12, 12) + r.f(-8, 8),
        20,
        field.track.length - 20,
      );
      const profile = field.profile(s, side);
      const upper = profile.coastness > 0.34 ? 0.34 : 0.54;
      const u = clamp(r.f(0.13, upper), Math.min(0.42, 4.8 / profile.wallDist), upper);
      if (profile.coastness > 0.62 && u > 0.3) continue;
      field.point(s, side, u, _point);
      const scale = r.f(0.85, 1.42);
      const transform = {
        position: _point.clone().addScaledVector(profile.f.up, -0.03),
        rotation: new THREE.Euler(r.f(-0.03, 0.03), r.f(0, Math.PI * 2), r.f(-0.1, 0.1)),
        scale: new THREE.Vector3(scale * r.f(0.82, 1.18), scale, scale * r.f(0.84, 1.16)),
      };
      heads.push({
        ...transform,
        color: FLOWER_COLORS[(family + (r.chance(0.12) ? 1 : 0)) % FLOWER_COLORS.length],
      });
      stems.push(transform);
    }
  }

  const group = new THREE.Group();
  group.name = 'roadside-wildflowers';
  group.add(makeInstances(buildFlowerStemGeometry(), stemMaterial, stems, 'flower-stems', false));
  group.add(makeInstances(buildFlowerHeadGeometry(), flowerMaterial, heads, 'flower-heads', false));
  return group;
}

function headlandGeometry(palette, phase) {
  /* Enough facets that an oblique face reads as a rounded graphic headland,
     not one large translucent-looking polygon laid over the horizon. */
  const segments = 16;
  const rings = [
    [0, 1],
    [0.34, 0.94],
    [0.7, 0.62],
    [1, 0.18],
  ];
  const positions = [];
  const indices = [];
  for (let r = 0; r < rings.length; r++) {
    const [y, radius] = rings[r];
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const ringY = clamp(
        y + (r > 0 && r < rings.length - 1
          ? Math.sin(i * 1.73 + phase + r * 2.1) * 0.035
          : 0),
        0,
        1,
      );
      const irregular = 1
        + Math.sin(i * 2.17 + phase) * 0.11
        + Math.sin(i * 4.73 - phase * 0.6) * 0.055;
      const lean = ringY * (0.13 + Math.sin(phase) * 0.04);
      positions.push(
        Math.cos(angle) * radius * irregular + lean,
        ringY,
        Math.sin(angle) * radius * (1 + Math.cos(i * 2.71 + phase) * 0.08),
      );
    }
  }
  const topCenter = positions.length / 3;
  positions.push(0.13 + Math.sin(phase) * 0.04, 1, 0);
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < segments; i++) {
      const n = (i + 1) % segments;
      const a = r * segments + i, b = r * segments + n;
      const c = (r + 1) * segments + i, d = (r + 1) * segments + n;
      indices.push(a, b, c, b, d, c);
    }
  }
  const topRing = (rings.length - 1) * segments;
  for (let i = 0; i < segments; i++) {
    indices.push(topRing + i, topCenter, topRing + (i + 1) % segments);
  }

  const base = new THREE.BufferGeometry();
  base.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  base.setIndex(indices);
  const geometry = base.toNonIndexed();
  base.dispose();
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 3) {
    const y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const x = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const z = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    /* Wobbled by where the facet sits around the mass, so the band edges are
       ragged rather than three contour lines drawn round a cone. */
    const level = y + Math.sin(Math.atan2(z, x) * 3.1 + phase) * 0.07;
    const hex = palette[level > 0.7 ? 3 : level > 0.44 ? 2 : level > 0.19 ? 1 : 0];
    _color.setHex(hex);
    for (let j = 0; j < 3; j++) {
      colors[(i + j) * 3] = _color.r;
      colors[(i + j) * 3 + 1] = _color.g;
      colors[(i + j) * 3 + 2] = _color.b;
    }
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return finishGeometry(geometry);
}

function buildHeadlands(track, seed, bounds, coast, materials) {
  const r = rand(rng(seed * 149 + 47));
  const groups = [[], [], []];
  const summits = [];
  const far = [];

  const rings = [
    { count: 6, distance: [190, 430], radius: [80, 150], height: [70, 145] },
    { count: 7, distance: [1350, 1750], radius: [150, 250], height: [170, 320] },
    { count: 8, distance: [2200, 2850], radius: [220, 350], height: [260, 460] },
  ];
  for (let ring = 0; ring < rings.length; ring++) {
    const spec = rings[ring];
    for (let i = 0; i < spec.count; i++) {
      let x, z;
      if (ring === 0) {
        const s = ((i + 0.35 + r.f(-0.16, 0.16)) / spec.count) * track.length;
        const frame = track.frameAt(clamp(s, 0, track.length));
        const side = coast.seaSideAt(frame.s);
        const distance = frame.width * 0.5 + coast.shoreMargin(frame, side) + r.f(...spec.distance);
        x = frame.pos.x + frame.flatRight.x * side * distance;
        z = frame.pos.z + frame.flatRight.z * side * distance;
        if (coast.signedDistanceXZ(x, z) < 45) continue;
      } else {
        const angle = (i / spec.count) * Math.PI * 2 + r.f(-0.16, 0.16);
        const distance = r.f(...spec.distance);
        x = bounds.cx + Math.cos(angle) * distance;
        z = bounds.cz + Math.sin(angle) * distance;
      }
      const radius = r.f(...spec.radius);
      const aspect = r.f(0.7, 1.12);
      let height = r.f(...spec.height);
      const baseY = (ring === 0 ? coast.seaLevel - 12 : track.endY - 30) + r.f(-7, 7);
      /* The near ring stands in water at the foot of a cliff the road runs
         along the top of, so a stack sized off the sea reads as a pebble from
         up there — or vanishes behind the verge entirely, which is what a
         lighthouse on one did. Sized to breach the driver's own eyeline
         instead, which is also what makes a sea stack look like one. */
      if (ring === 0) {
        const roadY = track.frameAt(clamp(
          ((i + 0.35) / spec.count) * track.length, 0, track.length)).pos.y;
        height = Math.max(height, roadY - baseY + r.f(60, 120));
      }
      const yaw = r.f(0, Math.PI * 2);
      groups[ring].push({
        position: new THREE.Vector3(x, baseY, z),
        rotation: new THREE.Euler(0, yaw, 0),
        scale: new THREE.Vector3(radius, height, radius * aspect),
      });
      /* The near ring is the only geometry in the stage that is both distant
         and reliably unoccluded — it stands in open water off the seaward
         shoulder. That makes its summits the one place a landmark can go and
         be certain of being seen, which is what the lighthouses use. */
      if (ring === 0) {
        summits.push({
          x, z, y: baseY + height * 0.86, radius,
          s: track.frameAt(clamp(
            ((i + 0.35) / spec.count) * track.length, 0, track.length)).s,
        });
      }
      /* The middle ring is the actual horizon of this stage — a kilometre and
         a half out, above everything between. Turbines want that and nothing
         nearer: the crest of the inland wall looks like a distant hilltop for
         fifteen seconds and then the road arrives at its foot. */
      if (ring === 1) far.push({ x, z, y: baseY + height * 0.9, radius });
    }
  }

  const group = new THREE.Group();
  /* Kept for main.js overview compatibility: that harness hides this group by
     its historical name before checking the road/coast relationship. */
  group.name = 'distant-mesas';
  for (let ring = 0; ring < 3; ring++) {
    group.add(makeInstances(
      headlandGeometry(HEADLAND_COLORS[ring], seed * 0.17 + ring * 1.9),
      materials[ring],
      groups[ring],
      `headland-depth-${ring}`,
      false,
    ));
  }
  group.userData.nearSummits = summits;
  group.userData.farSummits = far;
  return group;
}

function buildLandmarks(field) {
  const group = new THREE.Group();
  group.name = 'coastal-landmarks';
  const geometries = [];

  const place = (s, side, u, parts) => {
    const profile = field.profile(s, side);
    field.point(s, side, u, _point);
    const yaw = Math.atan2(profile.f.tan.x, profile.f.tan.z);
    for (const { geometry, color } of parts) {
      paintGeometry(geometry, color);
      geometry.rotateY(yaw);
      geometry.translate(_point.x, _point.y, _point.z);
      geometries.push(geometry);
    }
  };

  {
    const s = field.track.length * 0.105;
    const side = -field.coast.seaSideAt(s);
    const base = new THREE.DodecahedronGeometry(1, 0);
    base.scale(12, 7.5, 16);
    base.translate(0, 6.2, 0);
    const cap = new THREE.CylinderGeometry(7.2, 9.4, 2.3, 9, 1, false);
    cap.scale(1.28, 1, 1);
    cap.translate(-0.8, 12.1, 0.4);
    const shoulder = new THREE.DodecahedronGeometry(1, 0);
    shoulder.scale(7.5, 4.3, 8.2);
    shoulder.translate(12, 3.5, 4);
    place(s, side, 0.78, [
      { geometry: base, color: 0x4a6062 },
      { geometry: shoulder, color: 0x60726c },
      { geometry: cap, color: 0x5aa34c },
    ]);
  }

  {
    const s = field.track.length * 0.305;
    const side = field.coast.seaSideAt(s);
    const parts = [];
    for (const sign of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const segment = new THREE.CylinderGeometry(
          2.5 - i * 0.14, 3.5 - i * 0.1, 4.7, 7, 1, false,
        );
        segment.translate(sign * (8.2 - i * 0.38), 2.35 + i * 4.35, (i % 2) * 0.55);
        segment.rotateZ(sign * (0.03 + i * 0.018));
        parts.push({ geometry: segment, color: i === 3 ? 0x56735e : 0x50666a });
      }
    }
    const lintel = new THREE.BoxGeometry(19.5, 4.5, 7.2);
    lintel.translate(0, 18.4, 0);
    lintel.rotateZ(-0.035);
    const moss = new THREE.BoxGeometry(16.5, 1.1, 6.3);
    moss.translate(0.7, 21.0, -0.15);
    parts.push(
      { geometry: lintel, color: 0x435a61 },
      { geometry: moss, color: 0x47944a },
    );
    place(s, side, 0.67, parts);
  }

  {
    const s = field.track.length * 0.81;
    const side = -field.coast.seaSideAt(s);
    const parts = [];
    const shelf = new THREE.DodecahedronGeometry(1, 0);
    shelf.scale(11, 4.2, 8.5);
    shelf.translate(0, 3.4, 0);
    parts.push({ geometry: shelf, color: 0x566b68 });
    for (let i = 0; i < 5; i++) {
      const tree = new THREE.ConeGeometry(1.5 + (i % 2) * 0.35, 7.5 + (i % 3) * 1.2, 7);
      tree.translate(-7 + i * 3.6, 7.2 + (i % 3) * 0.55, (i % 2 ? 1 : -1) * 1.7);
      tree.rotateZ(-0.08 + i * 0.025);
      parts.push({ geometry: tree, color: i % 2 ? 0x367b45 : 0x276a43 });
    }
    place(s, side, 0.7, parts);
  }

  const merged = mergeGeometries(geometries);
  geometries.forEach(geometry => geometry.dispose());
  const mesh = new THREE.Mesh(
    finishGeometry(merged),
    environmentCelMaterial({ vertexColors: true, flatShading: true }),
  );
  mesh.name = 'landmarks';
  mesh.castShadow = mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}

/* ─── Roadside landmarks ──────────────────────────────────────────────────
 *
 * The brief for this section is a sentence: "every 5 seconds of driving has
 * something new to look at. not cluttered, just alive." Two things follow from
 * it that are easy to get wrong.
 *
 * The first is that the unit is seconds, not metres. Landmarks spread evenly
 * along the arc length arrive in a clump through the switchbacks, where the car
 * is doing 20 m/s, and then not at all down the fast coastal straight where it
 * is doing 55 — the two halves of the stage would need a factor of three
 * between their spacings to feel the same from the seat. So placement is driven
 * off a speed profile and a clock.
 *
 * The second is that "not cluttered" is a real constraint and it means the
 * things already in the world count. A gate, a headland, the existing coastal
 * landmarks and the finish are all events; dropping a hay bale two seconds
 * after one of them buys nothing and costs the composition. The scheduler
 * therefore starts from what is already there and only fills the gaps.
 */

/* A plain point-mass model of how the car gets round: as fast as the lateral
   grip allows in a corner, and limited between corners by how hard it can
   accelerate and brake. Checked against a real lap in tools/pace.mjs — this
   only has to be right enough to spread landmarks by feel, but if it were
   badly wrong the whole placement rule would be too. */
/* Calibration, not physics. These started as plausible numbers for a car and
   gave a 130 s lap against the 256 s a skill-0.85 bot actually drives — the
   shape was right to within seven per cent but the clock ran at double speed,
   so a "five second" spacing was really ten. Scaled to the measured lap; the
   ratios between them are what shape the profile and they are unchanged.
   tools/pace.mjs re-checks both the total and the shape. */
const PACE = { grip: 3.5, accel: 1.7, brake: 3.1, top: 31, floor: 4.5 };

function routeTiming(track) {
  const step = 8;
  const n = Math.ceil(track.length / step) + 1;
  const ss = new Float32Array(n), vv = new Float32Array(n), tt = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    ss[i] = Math.min(track.length, i * step);
    const curv = Math.abs(track.frameAt(ss[i]).curv);
    vv[i] = curv > 1e-5 ? Math.min(PACE.top, Math.sqrt(PACE.grip / curv)) : PACE.top;
  }
  vv[0] = 0;                                            // standing start
  for (let i = 1; i < n; i++) {
    vv[i] = Math.min(vv[i], Math.sqrt(vv[i - 1] ** 2 + 2 * PACE.accel * step));
  }
  for (let i = n - 2; i >= 0; i--) {
    vv[i] = Math.min(vv[i], Math.sqrt(vv[i + 1] ** 2 + 2 * PACE.brake * step));
  }
  for (let i = 1; i < n; i++) {
    tt[i] = tt[i - 1] + step / Math.max(PACE.floor, (vv[i] + vv[i - 1]) * 0.5);
  }
  const total = tt[n - 1];
  return {
    total,
    speedAt(s) { return vv[clamp(Math.round(s / step), 0, n - 1)]; },
    timeOf(s) {
      const k = clamp(s / step, 0, n - 1);
      const i = Math.floor(k);
      return lerp(tt[i], tt[Math.min(n - 1, i + 1)], k - i);
    },
    sAt(time) {
      let lo = 0, hi = n - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (tt[mid] < time) lo = mid + 1; else hi = mid; }
      if (lo === 0) return 0;
      const span = tt[lo] - tt[lo - 1] || 1;
      return lerp(ss[lo - 1], ss[lo], clamp((time - tt[lo - 1]) / span, 0, 1));
    },
  };
}

/** A cylinder with no caps — half the triangles, and the caps are inside the
    stack on everything this is used for. */
function tube(rTop, rBottom, height, sides) {
  return new THREE.CylinderGeometry(rTop, rBottom, height, sides, 1, true);
}

function lighthouseParts() {
  const parts = [];
  const at = (geometry, color, y) => { geometry.translate(0, y, 0); parts.push({ geometry, color }); };
  const cream = 0xf4e8d0, red = 0xd8503f, slate = 0x3d525c;
  at(new THREE.CylinderGeometry(4.3, 5.5, 2.4, 9), 0x5d6b6a, 1.2);
  at(tube(3.62, 4.15, 5.2, 9), cream, 5.0);
  at(tube(3.06, 3.62, 5.2, 9), red, 10.2);
  at(tube(2.5, 3.06, 5.2, 9), cream, 15.4);
  at(new THREE.CylinderGeometry(3.9, 3.9, 0.5, 10), slate, 18.25);
  at(tube(3.7, 3.7, 1.0, 10), slate, 19.0);
  at(new THREE.CylinderGeometry(2.05, 2.25, 3.1, 8), 0x2b7890, 20.0);
  at(new THREE.ConeGeometry(2.8, 2.5, 8), red, 22.8);
  /* A keeper's cottage, because a tower on its own reads as a chess piece.
     Offset to one side so the silhouette is asymmetric from the road. */
  const hut = new THREE.BoxGeometry(6.2, 3.1, 4.4);
  hut.translate(8.4, 1.55, 2.2);
  parts.push({ geometry: hut, color: 0xe4dccb });
  const roof = new THREE.BoxGeometry(6.8, 0.9, 5.0);
  roof.translate(8.4, 3.5, 2.2);
  roof.rotateZ(0.03);
  parts.push({ geometry: roof, color: 0x4a5f66 });
  return parts;
}

/** The lamp itself: an open cone laid along +X with its apex at the lantern,
    flattened so it sweeps as a fan rather than a searchlight. */
function lightBeamGeometry() {
  /* Short and flat. The first version was an eighty-six metre cone at a third
     opacity, which from anywhere near the tower is a hard bright bar ruled
     across the sky — it read as a rendering fault, not as a light. This is a
     shallow fan that fades out well before the far scenery. */
  const g = new THREE.ConeGeometry(3.4, 54, 6, 1, true);
  g.translate(0, -27, 0);
  g.rotateZ(-Math.PI / 2);
  g.scale(1, 0.2, 1);
  return g;
}

function turbineTowerParts() {
  const parts = [];
  const tower = tube(0.9, 1.9, 44, 6);
  tower.translate(0, 22, 0);
  parts.push({ geometry: tower, color: 0xe8ecec });
  const nacelle = new THREE.BoxGeometry(2.3, 2.1, 4.0);
  nacelle.translate(0, 44.6, -0.6);
  parts.push({ geometry: nacelle, color: 0xdfe5e5 });
  return parts;
}

function turbineRotorGeometry() {
  const pos = [];
  const hub = new THREE.ConeGeometry(1.15, 1.9, 6);
  hub.rotateX(Math.PI / 2);
  for (let b = 0; b < 3; b++) {
    const a = (b / 3) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const rot = (x, y) => [x * ca - y * sa, x * sa + y * ca];
    const quad = [[-0.62, 1.4], [0.62, 1.4], [0.24, 20.5], [-0.24, 20.5]];
    const [p0, p1, p2, p3] = quad.map(([x, y]) => rot(x, y));
    pos.push(p0[0], p0[1], 0, p1[0], p1[1], 0, p2[0], p2[1], 0);
    pos.push(p0[0], p0[1], 0, p2[0], p2[1], 0, p3[0], p3[1], 0);
  }
  const blades = new THREE.BufferGeometry();
  blades.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const merged = mergeGeometries([paintGeometry(finishGeometry(blades), 0xf1f4f4),
    paintGeometry(hub, 0xcfd6d6)]);
  return finishGeometry(merged);
}

/** Deck, stringers, four posts and two rails, in the road's own frame so the
    span crosses the stream rather than running along it. */
function footbridgeParts() {
  const parts = [];
  const timber = 0x7a5b3a, dark = 0x4f3b26;
  const deck = new THREE.BoxGeometry(4.9, 0.22, 2.0);
  deck.translate(0, 0.42, 0);
  parts.push({ geometry: deck, color: timber });
  for (const z of [-0.82, 0.82]) {
    const stringer = new THREE.BoxGeometry(5.2, 0.3, 0.22);
    stringer.translate(0, 0.2, z);
    parts.push({ geometry: stringer, color: dark });
    const rail = new THREE.BoxGeometry(4.7, 0.14, 0.14);
    rail.translate(0, 1.32, z);
    parts.push({ geometry: rail, color: timber });
    for (const x of [-2.05, 2.05]) {
      const post = new THREE.BoxGeometry(0.17, 1.1, 0.17);
      post.translate(x, 0.95, z);
      parts.push({ geometry: post, color: dark });
    }
  }
  return parts;
}

function tyreStackGeometry() {
  const parts = [];
  for (let k = 0; k < 3; k++) {
    const t = tube(0.46, 0.46, 0.34, 7);
    t.translate(0, 0.19 + k * 0.35, 0);
    parts.push(paintGeometry(finishGeometry(t), k === 1 ? 0x2b2f33 : 0x1f2226));
  }
  const cap = new THREE.CircleGeometry(0.46, 7);
  cap.rotateX(-Math.PI / 2);
  cap.translate(0, 1.06, 0);
  parts.push(paintGeometry(finishGeometry(cap), 0x33383d));
  const merged = mergeGeometries(parts);
  parts.forEach(p => p.dispose());
  return finishGeometry(merged);
}

function hayBaleGeometry() {
  const g = new THREE.CylinderGeometry(0.86, 0.86, 1.55, 7);
  g.rotateZ(Math.PI / 2);
  g.translate(0, 0.86, 0);
  return finishGeometry(paintGeometry(g, 0xffffff));
}

/**
 * Everything that exists to be looked at, scheduled against the clock.
 *
 * Returns the group and, on `userData.schedule`, the list of what was placed
 * and when it is reached — the acceptance criterion is a claim about timings
 * and tools/pace.mjs checks it against this rather than against an eyeball.
 */
function buildRouteLandmarks(field, seed, coast, rings, mats, existing) {
  const summits = rings.nearSummits, far = rings.farSummits;
  const corridor = rings.corridor;
  const sight = new THREE.Raycaster();
  const _dir = new THREE.Vector3();
  const track = field.track;
  const r = rand(rng(seed * 331 + 29));
  const timing = routeTiming(track);
  const group = new THREE.Group();
  group.name = 'route-landmarks';

  const solid = [];
  const tyres = [], bales = [], rotors = [], beams = [], water = [], blooms = [], stalks = [];
  const schedule = existing.map(e => ({ ...e, t: timing.timeOf(e.s) }));
  const quota = { lighthouse: 2, turbine: 7, bridge: 5, tyres: 15, hay: 18 };
  const lastOf = {};

  const yawAt = s => {
    const f = track.frameAt(s);
    return Math.atan2(f.tan.x, f.tan.z);
  };
  /* Where the last builder actually put something, recorded onto the schedule
     so the capture tool can point a lens at the object rather than at the slot
     that requested it. Half of this pass was spent photographing empty verge
     because those two stations can be four hundred metres apart. */
  let spot = null;
  const drop = (parts, position, yaw) => {
    spot = position.clone();
    for (const { geometry, color } of parts) {
      paintGeometry(geometry, color);
      geometry.rotateY(yaw);
      geometry.translate(position.x, position.y, position.z);
      solid.push(geometry);
    }
  };

  /* Each builder returns true if it found somewhere to stand. A refusal is
     normal — a lighthouse needs a sea cliff and there is not one at every
     four-and-a-half-second mark — and the caller falls through to the next
     candidate rather than forcing it. */
  const builders = {
    /* On a rock out at sea, not on the verge.
     *
     * Two earlier placements both failed, in opposite directions and for the
     * same underlying reason: this road is a shelf cut into a mountainside, so
     * there is almost nowhere between the kerb and the horizon that is both
     * far enough away to be scenery and not hidden behind something. A third
     * of the way across the corridor put a twenty-three-metre tower six metres
     * from the kerb, apparently growing out of the grass; down on the seaward
     * bluff put it below the lip and out of shot from anywhere on the road.
     *
     * The near headland ring is the exception. It stands in open water off the
     * seaward shoulder with nothing between it and the driver, and a lighthouse
     * on a sea rock is the composition this was always reaching for. Scaled up,
     * because at three hundred metres a real one is a matchstick.
     */
    lighthouse(s) {
      /* Ahead, not merely nearby. These rocks sit off the shoulder at their own
         station, so one four hundred metres behind the slot is over the
         driver's shoulder and might as well not exist. */
      const summit = summits.find(k => !k.taken && k.s > s + 40 && k.s < s + 470);
      if (!summit) return false;
      if (lastOf.lighthouse !== undefined && Math.abs(s - lastOf.lighthouse) < 1200) return false;
      summit.taken = true;
      const at = new THREE.Vector3(summit.x, summit.y, summit.z);
      const yaw = yawAt(s) + r.f(-0.4, 0.4);
      const scale = 2.4;
      const parts = lighthouseParts();
      for (const part of parts) part.geometry.scale(scale, scale, scale);
      drop(parts, at, yaw);
      /* The lamp sits at the lantern and turns; nothing else about it moves.
         One instance, one rotation in the vertex shader. */
      beams.push({
        position: at.clone().add(new THREE.Vector3(0, 20.4 * scale, 0)),
        rotation: new THREE.Euler(0, r.f(0, Math.PI * 2), 0),
        scale: new THREE.Vector3(scale, scale, scale),
      });
      return true;
    },

    /* On the skyline the road is about to climb towards.
     *
     * "Distant hilltops" out in the basin do not work here: the basin floor is
     * two hundred metres below the road and the inland wall stands between the
     * two, so a turbine placed there is behind a cliff from every seat on the
     * route. The crest of that wall, several hundred metres further along the
     * road, is the thing that is actually distant and actually on the horizon —
     * it is the silhouette the driver is looking at for the next fifteen
     * seconds. Placed ahead of the slot rather than beside it, which is why
     * `s` here is the viewing station and `sT` is where the turbine stands. */
    turbine(s) {
      if (lastOf.turbine !== undefined && Math.abs(s - lastOf.turbine) < 430) return false;
      const f = track.frameAt(s);
      /* Ahead and on the far ring, within about thirty degrees of the road's
         own direction so it is in the windscreen rather than out of the side
         window. Scaled by range: at a kilometre and a half a real turbine is
         two pixels, and this is a poster, not a survey. */
      let best = null;
      for (const hill of far) {
        if (hill.turbines >= 3) continue;
        const dx = hill.x - f.pos.x, dz = hill.z - f.pos.z;
        const away = Math.hypot(dx, dz);
        if (away < 700 || away > 2600) continue;
        const ang = Math.abs(Math.atan2(
          f.tan.x * dz - f.tan.z * dx, f.tan.x * dx + f.tan.z * dz));
        if (ang > 0.52) continue;
        /* Over the water. Inland the sightline crosses the wall the road is cut
           into and the hilltop is behind a cliff however tall it is; seaward
           there is nothing in the way by construction. Measured: the inland
           picks projected below the horizon line every time. */
        const sea = coast.seaSideAt(f.s);
        if ((f.flatRight.x * dx + f.flatRight.z * dz) * sea / away < 0.12) continue;
        /* And the seaward side has to actually be open. Two stretches of this
           road are cuttings with a wall on both shoulders — probed one at
           s=5329 and every pixel of the frame was inland wall at fifty metres,
           with a turbine scheduled a kilometre and a third beyond it. */
        if (field.profile(f.s, sea).coastness < 0.45) continue;
        /* And not behind a near stack. The middle ring is a kilometre past the
           near one, so a sea rock two hundred metres off the shoulder hides a
           great deal of it — this rejects any candidate whose hub sits lower in
           the frame than a nearer summit standing on the same sightline. */
        const hubRise = hill.y + 40.6 * clamp(away / 430, 2.2, 5.4) - f.pos.y;
        if (hubRise / away < 0.05) continue;
        /* Ray the real terrain rather than a model of it. Cross-sections are
           no use: at s=5329 both shoulders measure twelve metres of wall and
           open coast, and the frame is still solid hillside at fifty metres,
           because the road is curving into a spur the local profile knows
           nothing about. The corridor meshes exist by the time this runs, so
           ask them. A handful of rays at build time costs nothing. */
        _point2.set(f.pos.x, f.pos.y + 3, f.pos.z);
        _dir.set(dx, hubRise - 3, dz).normalize();
        sight.set(_point2, _dir);
        sight.far = away;
        if (sight.intersectObjects(corridor, false).length) continue;
        let blocked = false;
        for (const near of summits) {
          const nx = near.x - f.pos.x, nz = near.z - f.pos.z;
          const along = (nx * dx + nz * dz) / away;
          if (along < 40 || along > away - 200) continue;
          if (Math.abs(nx * dz - nz * dx) / away > near.radius * 0.75) continue;
          if ((near.y - f.pos.y) / along > hubRise / away) { blocked = true; break; }
        }
        if (blocked) continue;
        const score = -ang * 3 - Math.abs(away - 1500) / 1200;
        if (!best || score > best.score) best = { hill, score, away, ang };
      }
      if (!best) return false;
      const hill = best.hill;
      hill.turbines = (hill.turbines || 0) + 1;
      /* Two or three to a hilltop, spread across its cap, because one turbine
         on a hill is a mast and a group of them is a wind farm. */
      const spread = hill.radius * 0.34;
      const scale = clamp(best.away / 430, 2.2, 5.4);
      const count = r.i(2, 3);
      for (let k = 0; k < count; k++) {
        const off = (k - (count - 1) / 2) * spread + r.f(-6, 6);
        const across = new THREE.Vector3(-(hill.z - f.pos.z), 0, hill.x - f.pos.x).normalize();
        const at = new THREE.Vector3(
          hill.x + across.x * off, hill.y - 4 * scale, hill.z + across.z * off);
        const yaw = Math.atan2(f.pos.x - hill.x, f.pos.z - hill.z) + r.f(-0.5, 0.5);
        const parts = turbineTowerParts();
        for (const part of parts) part.geometry.scale(scale, scale, scale);
        drop(parts, at, yaw);
        rotors.push({
          position: at.clone().add(new THREE.Vector3(
            Math.sin(yaw) * -2.4 * scale, 44.6 * scale, Math.cos(yaw) * -2.4 * scale)),
          rotation: new THREE.Euler(0, yaw, 0),
          scale: new THREE.Vector3(scale, scale, scale),
        });
      }
      return true;
    },

    bridge(s) {
      const side = -coast.seaSideAt(s);
      const profile = field.profile(s, side);
      if (profile.coastness > 0.4 || profile.wallDist < 22) return false;
      if (!standable(field, s, side, 13, 2.4)) return false;
      /* A stream running down the slope towards the road, and a plank bridge
         across it on the line a walker would take. The ribbon is sampled off
         the same terrain function as everything else, so it lies in the
         hillside instead of hovering over it. */
      const positions = [], colors = [];
      const steps = 9;
      const wobble = r.f(-6, 6);
      for (let k = 0; k <= steps; k++) {
        const u = lerp(0.22, 0.96, k / steps);
        const ds = wobble * Math.sin(k / steps * 2.1) + r.f(-1.2, 1.2);
        field.point(s + ds, side, u, _point);
        field.point(s + ds, side, u, _point2);
        const f = track.frameAt(s + ds);
        const half = lerp(0.7, 1.5, k / steps);
        for (const sgn of [-1, 1]) {
          positions.push(
            _point.x + f.tan.x * sgn * half,
            _point.y + 0.10,
            _point.z + f.tan.z * sgn * half);
          colors.push(0, 0, 0);
        }
      }
      const indices = [];
      for (let k = 0; k < steps; k++) {
        const a = k * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const ribbon = new THREE.BufferGeometry();
      ribbon.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      ribbon.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      ribbon.setIndex(indices);
      water.push(paintGeometry(finishGeometry(ribbon), 0x2f7fa0));

      const u = 0.52;
      field.point(s + wobble * Math.sin(0.62), side, u, _point);
      drop(footbridgeParts(), _point, yawAt(s));
      for (let k = 0; k < 4; k++) {
        field.point(s + r.f(-7, 7), side, clamp(u + r.f(-0.18, 0.24), 0.24, 0.94), _point2);
        const size = r.f(0.5, 1.1);
        const stone = bipyramid(6);
        stone.scale(size, size * 0.6, size * r.f(0.8, 1.2));
        stone.rotateY(r.f(0, Math.PI));
        stone.translate(_point2.x, _point2.y + size * 0.2, _point2.z);
        solid.push(paintGeometry(stone, r.pick([0x6c7472, 0x59635f, 0x7d827a])));
      }
      return true;
    },

    tyres(s) {
      const f = track.frameAt(s);
      if (Math.abs(f.curv) < 0.009) return false;
      const side = f.curv > 0 ? -1 : 1;               // outside of the corner
      const profile = field.profile(s, side);
      const u = clearOfRoad(profile, 0.5);
      if (u === null || u > 0.55) return false;
      const count = r.i(5, 8);
      for (let k = 0; k < count; k++) {
        const ds = (k - (count - 1) * 0.5) * 1.05;
        field.point(s + ds, side, u + r.f(-0.008, 0.008), _point);
        tyres.push({
          position: _point.clone(),
          rotation: new THREE.Euler(0, r.f(0, 1.1), 0),
          scale: new THREE.Vector3(1, r.f(0.92, 1.08), 1),
        });
      }
      return true;
    },

    /* Not gated on curvature, unlike the tyres. Bales stand in fields, and the
       long open run through the last chapter has almost no corners in it — the
       version that required one left twelve consecutive flower patches there
       and nothing else. */
    hay(s) {
      const f = track.frameAt(s);
      const side = f.curv > 0 ? -1 : 1;
      const profile = field.profile(s, side);
      if (profile.coastness > 0.62) return false;
      const u = clearOfRoad(profile, 1.3);
      if (u === null || u > 0.72) return false;
      const count = r.i(2, 4);
      for (let k = 0; k < count; k++) {
        const ds = (k - (count - 1) * 0.5) * 2.0 + r.f(-0.4, 0.4);
        field.point(s + ds, side, clamp(u + r.f(0, 0.1), 0, 0.9), _point);
        bales.push({
          position: _point.clone(),
          rotation: new THREE.Euler(0, yawAt(s) + r.f(-0.35, 0.35), r.f(-0.04, 0.04)),
          scale: new THREE.Vector3(1, 1, 1),
          color: r.pick([0xd8bb69, 0xc9a95c, 0xe3ca7c, 0xf0dc9a]),
        });
      }
      return true;
    },

    /* The one that never refuses. Wildflowers need nothing but grass, so this
       is what closes the gaps the terrain-specific landmarks leave — and a
       blaze of magenta or yellow at speed is a genuine event, not filler. The
       scattered flowers elsewhere in the stage are deliberately thin; these
       are dense enough to read as a single patch of colour. */
    flowers(s) {
      const side = r.chance(0.5) ? 1 : -1;
      for (const trySide of [side, -side]) {
        const profile = field.profile(s, trySide);
        /* Never refuses. A flower is thirty centimetres across, so the only
           thing it needs is that the ground is not the road, and where the
           corridor is too tight to give a band it gets a single line just past
           the berm. An earlier version returned false on coastal hairpins,
           which is exactly where the holes in the schedule were. */
        /* Seaward the band stops short of the lip, because past it is a drop.
           Inland there is no lip, so the cap is only about not walking the
           patch up the hillside out of frame. */
        const upper = profile.coastness > 0.5 ? 0.34 : 0.62;
        /* Five metres off the kerb, not two-point-eight. A bloom carries a
           1.2 m bounding radius, and at the old inner edge the audit found
           heads hanging over the road line — below it, on the drop side, but
           over it. Where the clearance and the lip leave no band at all the
           side is skipped, which is what the second attempt is for. */
        const lower = 5.2 / profile.wallDist;
        if (lower > upper - 0.05) continue;
        const family = r.i(0, FLOWER_COLORS.length - 1);
        const count = r.i(11, 18);
        for (let k = 0; k < count; k++) {
          const ds = r.f(-9, 9) + r.f(-5, 5);
          /* Per bloom, not per patch. The scatter is fourteen metres and the
             corridor narrows inside that, so a fraction measured at the patch
             centre put the far end of the spread back over the kerb. */
          const at = clamp(s + ds, 24, track.length - 24);
          const here = field.profile(at, trySide);
          const near = 5.2 / here.wallDist;
          if (near > upper - 0.02) continue;
          field.point(at, trySide, r.f(Math.max(lower, near), upper), _point);
          const scale = r.f(0.9, 1.6);
          const transform = {
            position: _point.clone().addScaledVector(track.frameAt(s).up, -0.03),
            rotation: new THREE.Euler(r.f(-0.05, 0.05), r.f(0, Math.PI * 2), r.f(-0.12, 0.12)),
            scale: new THREE.Vector3(scale * r.f(0.85, 1.15), scale, scale * r.f(0.85, 1.15)),
          };
          blooms.push({
            ...transform,
            color: FLOWER_COLORS[(family + (r.chance(0.14) ? 1 : 0)) % FLOWER_COLORS.length],
          });
          stalks.push(transform);
        }
        return true;
      }
      /* Both shoulders were too tight for a band that clears the road. Last
         resort is the inland slope with the framing cap lifted — it is a rising
         hillside, so further out is only further up, never over a drop. */
      const inland = -coast.seaSideAt(s);
      const wide = field.profile(s, inland);
      const near = 5.2 / wide.wallDist;
      if (near > 0.9) return false;
      const family = r.i(0, FLOWER_COLORS.length - 1);
      for (let k = 0; k < 12; k++) {
        const at = clamp(s + r.f(-9, 9) + r.f(-5, 5), 24, track.length - 24);
        field.point(at, inland, r.f(near, Math.min(0.95, near + 0.22)), _point);
        const scale = r.f(0.9, 1.6);
        const transform = {
          position: _point.clone().addScaledVector(track.frameAt(s).up, -0.03),
          rotation: new THREE.Euler(r.f(-0.05, 0.05), r.f(0, Math.PI * 2), r.f(-0.12, 0.12)),
          scale: new THREE.Vector3(scale * r.f(0.85, 1.15), scale, scale * r.f(0.85, 1.15)),
        };
        blooms.push({
          ...transform,
          color: FLOWER_COLORS[(family + (r.chance(0.14) ? 1 : 0)) % FLOWER_COLORS.length],
        });
        stalks.push(transform);
      }
      return true;
    },
  };

  /* Order of preference at each slot. Terrain decides which of these actually
     takes — the list only says what to try first. */
  const order = ['lighthouse', 'bridge', 'turbine', 'tyres', 'hay', 'flowers'];
  const SPACING = 4.6;
  /* Turbines do not hold a slot. Measured on seed 22, six of the seven stood
     between 950 m and 1.2 km from the nearest point the road ever reaches, by
     design — the builder puts them on the far skyline because the basin floor
     is behind a cliff from every seat on the route. That makes them backdrop,
     not something the driver passes, and a backdrop that eats a slot in a
     cadence measured in seconds of gameplay leaves a real hole: the largest
     gap between things the driver actually goes past was 267 m. They are still
     recorded on the schedule, so the capture tools can find them; they just no
     longer block the slot they were placed from. */
  const tooClose = t => schedule.some(e =>
    e.kind !== 'turbine' && Math.abs(e.t - t) < SPACING * 0.55);
  let lastKind = null;
  let time = 4.0;
  while (time < timing.total - 4) {
    if (tooClose(time)) {
      time = Math.max(...schedule.filter(e => Math.abs(e.t - time) < SPACING * 0.55).map(e => e.t))
        + SPACING * r.f(0.85, 1.1);
      continue;
    }
    const base = timing.sAt(time);
    let placed = null;
    /* Whatever went in last slot goes to the back of the queue. Without this
       the open final chapter, where the corner-specific landmarks all refuse,
       came out as twelve consecutive flower patches. */
    const tries = order.filter(k => k !== lastKind).concat(lastKind ? [lastKind] : []);
    outer:
    for (const kind of tries) {
      if (quota[kind] !== undefined && quota[kind] <= 0) continue;
      for (const nudge of [0, 24, -24, 52, -52, 88, -88]) {
        const s = clamp(base + nudge, 40, track.length - 60);
        spot = null;
        /* The nudge is what lets a builder find standable ground, and it is
           also what opened the biggest holes in the schedule: a bridge that
           walked eighty-eight metres down a fast section spent eight seconds
           of the lap doing it, and the slots it skipped past were never
           refilled. Bounded in time, which is the unit that matters here, so
           the same walk is generous through a hairpin and short on a straight.
           The second clash test is because a slot being clear says nothing
           about where the builder ends up standing — that is how two landmarks
           ended up a tenth of a second apart. */
        if (Math.abs(timing.timeOf(s) - time) > SPACING * 0.8) continue;
        if (tooClose(timing.timeOf(s))) continue;
        if (builders[kind](s)) {
          if (quota[kind] !== undefined) quota[kind]--;
          lastOf[kind] = s;
          const entry = { kind, s, t: timing.timeOf(s) };
          if (spot) entry.at = [spot.x, spot.y, spot.z];
          if (kind === 'turbine') { schedule.push(entry); continue outer; }
          lastKind = kind;
          placed = entry;
          break outer;
        }
      }
    }
    /* Advance from where the landmark actually landed, not from the slot that
       asked for it. A builder is allowed to walk up to ninety metres to find
       standable ground, which at speed is three seconds — carrying on from the
       slot time meant the next slot collided with the thing just placed, got
       skipped, and left a ten-second hole. */
    if (placed) { schedule.push(placed); time = Math.max(time, placed.t); }
    time += SPACING * r.f(0.88, 1.12);
  }

  /* Sweep for holes and fill them. The main loop walks forward and can only
     see what it has already placed, so a slot that lands just inside the
     exclusion zone of the *next* thing it goes on to place leaves a gap
     nothing comes back for — which is how a nine-second stretch of nothing
     survived a scheduler whose whole job is that it should not. */
  schedule.sort((a, b) => a.t - b.t);
  /* Over the things the driver goes past, not over everything on the schedule.
     A turbine a kilometre out on the skyline does not close a hole in the
     cadence, and counting it as though it did is what left the holes. */
  const events = schedule.filter(e => e.kind !== 'turbine');
  for (let i = 1; i < events.length; i++) {
    const gap = events[i].t - events[i - 1].t;
    /* 1.6 slots, not 1.25. Once turbines stopped holding slots the main loop
       filled more of them itself, and a filler that also chased every 1.25-slot
       gap put the flower count back up to 28 of 59 — closing a gap the driver
       would not have felt at the price of the one object they see most. At 1.6
       the worst real gap is unchanged at 206 m and flower patches and tyre
       stacks are 66% of events rather than 69%. */
    if (gap < SPACING * 1.6) continue;
    const t = (events[i].t + events[i - 1].t) / 2;
    const s = clamp(timing.sAt(t), 40, track.length - 60);
    /* This used to call `builders.flowers` and nothing else, on the reasoning
       that a hole-filler only has to fill the hole. But the holes are not rare
       — measured, a fifth of the schedule comes through here — and a filler
       with one item in it is a filler that guarantees the thing it plants is
       the most common object on the route. Same preference list as the main
       loop, with the two things either side of the hole tried last, so what
       lands in the gap is whatever the terrain there will take rather than
       always the one kind that will stand anywhere. Flowers are last in the
       order, so they remain the fallback; they just stop being the default. */
    const beside = [events[i - 1].kind, events[i].kind, 'turbine'];
    const tries = order.filter(k => !beside.includes(k))
      .concat(order.filter(k => k !== 'turbine' && beside.includes(k)));
    let filled = null;
    for (const kind of tries) {
      if (quota[kind] !== undefined && quota[kind] <= 0) continue;
      spot = null;
      if (!builders[kind](s)) continue;
      if (quota[kind] !== undefined) quota[kind]--;
      lastOf[kind] = s;
      filled = kind;
      break;
    }
    if (!filled) continue;
    const entry = { kind: filled, s, t: timing.timeOf(s) };
    if (spot) entry.at = [spot.x, spot.y, spot.z];
    events.splice(i, 0, entry);
    schedule.push(entry);
    i++;
  }

  const merged = mergeGeometries(solid);
  solid.forEach(g => g.dispose());
  const mesh = new THREE.Mesh(finishGeometry(merged), mats.solid);
  mesh.name = 'landmark-solids';
  mesh.castShadow = mesh.receiveShadow = true;
  group.add(mesh);

  if (water.length) {
    const streams = new THREE.Mesh(finishGeometry(mergeGeometries(water)), mats.water);
    water.forEach(g => g.dispose());
    streams.name = 'landmark-streams';
    streams.receiveShadow = true;
    group.add(streams);
  }
  if (blooms.length) {
    group.add(makeInstances(buildFlowerStemGeometry(), mats.stem, stalks, 'blaze-stems', false));
    group.add(makeInstances(buildFlowerHeadGeometry(), mats.flower, blooms, 'blaze-heads', false));
  }
  if (tyres.length) group.add(makeInstances(tyreStackGeometry(), mats.tyre, tyres, 'corner-tyre-barriers'));
  if (bales.length) group.add(makeInstances(hayBaleGeometry(), mats.hay, bales, 'corner-hay-bales'));
  if (rotors.length) {
    group.add(animateMaterialOnRender(
      makeInstances(turbineRotorGeometry(), mats.rotor, rotors, 'turbine-rotors', false),
      mats.rotor));
  }
  if (beams.length) {
    group.add(animateMaterialOnRender(
      makeInstances(lightBeamGeometry(), mats.beam, beams, 'lighthouse-beams', false),
      mats.beam));
  }

  schedule.sort((a, b) => a.t - b.t);
  group.userData.schedule = schedule;
  group.userData.lapTime = timing.total;
  /* The model's own time-versus-distance curve, so a driven lap can be checked
     against the thing that actually decided the placements. */
  group.userData.paceCurve = Array.from({ length: 41 }, (_, i) => {
    const s = (i / 40) * track.length;
    return [s, timing.timeOf(s)];
  });
  return group;
}

function buildChevronSignGeometry() {
  const parts = [];
  const post = new THREE.BoxGeometry(0.18, 2.75, 0.18);
  post.translate(0, 1.375, 0);
  parts.push(paintGeometry(post, 0x39464b));
  const board = new THREE.BoxGeometry(1.55, 0.92, 0.12);
  board.translate(0, 2.35, 0);
  parts.push(paintGeometry(board, 0xf2c94c));
  const arrowShape = new THREE.Shape();
  arrowShape.moveTo(-0.44, 0.32);
  arrowShape.lineTo(0.12, 0);
  arrowShape.lineTo(-0.44, -0.32);
  arrowShape.lineTo(-0.23, -0.43);
  arrowShape.lineTo(0.5, 0);
  arrowShape.lineTo(-0.23, 0.43);
  arrowShape.closePath();
  const arrow = new THREE.ShapeGeometry(arrowShape);
  arrow.translate(0, 2.35, 0.066);
  parts.push(paintGeometry(arrow, 0x26363b));
  const merged = mergeGeometries(parts);
  parts.forEach(geometry => geometry.dispose());
  return grounded(merged);
}

function buildRoadsideSigns(field, seed, material) {
  const r = rand(rng(seed * 227 + 83));
  const candidates = [];
  for (let s = 150; s < field.track.length - 150; s += 30) {
    const a = field.track.frameAt(s - 28);
    const b = field.track.frameAt(s + 28);
    const cross = a.tan.x * b.tan.z - a.tan.z * b.tan.x;
    const dot = clamp(a.tan.x * b.tan.x + a.tan.z * b.tan.z, -1, 1);
    const angle = Math.atan2(cross, dot);
    if (Math.abs(angle) > 0.22) candidates.push({ s, angle, strength: Math.abs(angle) });
  }
  candidates.sort((a, b) => b.strength - a.strength);
  const selected = [];
  for (const candidate of candidates) {
    if (selected.every(other => Math.abs(other.s - candidate.s) > 180)) selected.push(candidate);
    if (selected.length >= 10) break;
  }
  const items = [];
  for (const turn of selected) {
    const side = turn.angle >= 0 ? 1 : -1;
    for (const offset of [-10, 0, 10]) {
      const s = turn.s + offset;
      const profile = field.profile(s, side);
      /* Just clear of the berm. A chevron is the one roadside object a driver
         is meant to aim at, so it wants to be as close as it can legally be —
         but its board is a metre and a half wide and at 1.2 m off the edge
         half of that was hanging over the racing line. */
      const u = clamp(
        0.075 + r.f(-0.012, 0.018),
        Math.min(0.34, (PROP_CLEAR - 1.4) / profile.wallDist),
        0.36,
      );
      field.point(s, side, u, _point);
      const yaw = Math.atan2(profile.f.tan.x, profile.f.tan.z) + Math.PI + r.f(-0.08, 0.08);
      items.push({
        position: _point.clone().addScaledVector(profile.f.up, -0.04),
        rotation: new THREE.Euler(0, yaw, side < 0 ? 0.035 : -0.035),
        scale: new THREE.Vector3(1, 1, 1),
      });
    }
  }
  return makeInstances(buildChevronSignGeometry(), material, items, 'hairpin-chevron-signs', false);
}

function addCylinderBetween(parts, a, b, radius, color, sides = 5) {
  const delta = new THREE.Vector3().subVectors(b, a);
  const geometry = new THREE.CylinderGeometry(radius, radius, delta.length(), sides, 1, false);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    delta.normalize(),
  ));
  geometry.translate((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
  parts.push(paintGeometry(geometry, color));
}

function buildCliffEdgeRails(field, material) {
  const parts = [];
  const sections = [0.08, 0.3, 0.61, 0.84];
  for (const p of sections) {
    const centre = p * field.track.length;
    const side = field.coast.seaSideAt(centre);
    const points = [];
    for (let i = -2; i <= 2; i++) {
      const s = clamp(centre + i * 11, 20, field.track.length - 20);
      const profile = field.profile(s, side);
      if (profile.coastness < 0.38 || profile.wallDist < 18) continue;
      field.point(s, side, 0.62, _point);
      points.push(_point.clone());
    }
    for (const point of points) {
      addCylinderBetween(
        parts,
        point,
        point.clone().add(new THREE.Vector3(0, 2.75, 0)),
        0.11,
        0x394c50,
      );
    }
    for (let i = 0; i < points.length - 1; i++) {
      for (const height of [1.25, 2.55]) {
        addCylinderBetween(
          parts,
          points[i].clone().add(new THREE.Vector3(0, height, 0)),
          points[i + 1].clone().add(new THREE.Vector3(0, height, 0)),
          0.1,
          height > 2 ? 0x60716b : 0x455b59,
        );
      }
    }
  }
  const geometry = mergeGeometries(parts);
  parts.forEach(part => part.dispose());
  const mesh = new THREE.Mesh(finishGeometry(geometry), material);
  mesh.name = 'cliff-edge-lookout-rails';
  mesh.castShadow = mesh.receiveShadow = false;
  return mesh;
}

function buildSky(track, seed, bounds, sunDirection) {
  const group = new THREE.Group();
  group.name = 'painted-sky';
  const centre = new THREE.Vector3(bounds.cx, (track.startY + track.endY) * 0.5, bounds.cz);
  const radius = 3150;
  const geometry = new THREE.SphereGeometry(radius, 48, 18);
  const positions = geometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  const low = new THREE.Color(0xee8068);
  const horizon = new THREE.Color(0xffc986);
  const middle = new THREE.Color(0x9fd0ed);
  const high = new THREE.Color(0x5f8fd8);
  const skyColor = new THREE.Color();
  for (let i = 0; i < positions.count; i++) {
    const y = positions.getY(i) / radius;
    const h = clamp((y + 0.12) / 1.02, 0, 1);
    if (h < 0.25) skyColor.copy(low).lerp(horizon, smoothstep(0, 0.25, h));
    else if (h < 0.56) skyColor.copy(horizon).lerp(middle, smoothstep(0.25, 0.56, h));
    else skyColor.copy(middle).lerp(high, smoothstep(0.56, 1, h));
    const band = 0.975 + Math.floor(h * 9) % 2 * 0.03;
    colors[i * 3] = skyColor.r * band;
    colors[i * 3 + 1] = skyColor.g * band;
    colors[i * 3 + 2] = skyColor.b * band;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = unlitCelMaterial({
    color: 0xffffff,
    vertexColors: true,
    flatShading: false,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(geometry, material);
  sky.position.copy(centre);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  sky.name = 'sky-dome';
  group.add(sky);

  const sunMat = unlitCelMaterial({
    color: 0xffefad,
    flatShading: true,
    fog: false,
    depthWrite: false,
  });
  const sun = new THREE.Mesh(new THREE.SphereGeometry(96, 24, 12), sunMat);
  const visualSun = sunDirection.clone();
  visualSun.y *= 0.45;
  sun.position.copy(centre).addScaledVector(visualSun.normalize(), radius * 0.83);
  sun.name = 'sun-disc';
  sun.renderOrder = -5;
  group.add(sun);

  const r = rand(rng(seed * 163 + 59));
  const cloudItems = [];
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2 + r.f(-0.08, 0.08);
    const distance = r.f(2140, 2480);
    const y = centre.y + r.f(390, 790);
    const cx = centre.x + Math.cos(angle) * distance;
    const cz = centre.z + Math.sin(angle) * distance;
    const tx = -Math.sin(angle), tz = Math.cos(angle);
    for (let k = 0; k < 10; k++) {
      const across = (k - 4.5) * r.f(48, 66);
      const crown = 1 - Math.abs(k - 4.5) / 5;
      const major = k === 3 || k === 6;
      const small = k === 0 || k === 2 || k === 9;
      const scale = major
        ? new THREE.Vector3(r.f(220, 310), r.f(58, 92), r.f(105, 155))
        : small
          ? new THREE.Vector3(r.f(48, 86), r.f(18, 34), r.f(30, 58))
          : new THREE.Vector3(r.f(105, 178), r.f(30, 58), r.f(58, 105));
      cloudItems.push({
        position: new THREE.Vector3(
          cx + tx * across + Math.cos(angle) * r.f(-28, 28),
          y + crown * r.f(18, 54) + r.f(-10, 10),
          cz + tz * across + Math.sin(angle) * r.f(-28, 28),
        ),
        rotation: new THREE.Euler(r.f(-0.04, 0.04), angle + r.f(-0.12, 0.12), r.f(-0.03, 0.03)),
        scale,
        color: k % 4 === 0 ? 0xcaa5bc : r.pick([0xfff3d5, 0xf8dfc5, 0xe8c8d5]),
      });
    }
  }
  const cloudMat = unlitCelMaterial({ color: 0xffffff, flatShading: true, fog: false });
  const clouds = makeInstances(
    new THREE.IcosahedronGeometry(1, 0), cloudMat, cloudItems, 'block-clouds', false,
  );
  clouds.renderOrder = -4;
  group.add(clouds);
  return group;
}

/* ─── Trackside crowd ──────────────────────────────────────────────────────
 *
 * "Add spectators and cheerleaders at key points only. Not everywhere — that
 * looks fake." Everything below follows from taking the second sentence as
 * seriously as the first. Eight groups on five and a half kilometres is one
 * every seven hundred metres, which at racing speed is one every fourteen
 * seconds: the driver passes a crowd four or five times in a lap and each one
 * is an event. A continuous line of people would be cheaper to write, more
 * even, and wrong.
 *
 * Three things about this section are worth reading before changing it.
 *
 * **They are billboards, and the billboard lives in the vertex shader.** A
 * spectator is nine flat quads in a plane, and the plane is turned to face the
 * camera about the world's vertical axis every frame. Y-locked rather than
 * fully camera-aligned on purpose: a fully aligned sprite tips as the chase
 * camera pitches over a crest, and a crowd that leans back in unison when the
 * road drops is the most distracting thing a billboard can do. Locked to the
 * vertical it only ever spins about its own feet, and the spin rate is the
 * rate the bearing to the camera changes, which for a figure six metres off
 * the kerb is slow until the moment it is abreast and then irrelevant.
 *
 * **The ink pass has to be told.** `render/outline.js` draws its normals-and-
 * distance prepass with one override material for the whole scene, and that
 * material knows nothing about the expansion above — it would submit the
 * unrotated source quad, so the buffer the outlines are found in would
 * disagree with the drawn frame. Anywhere the camera looked along the source
 * plane's own axis the figure would have a full-width body in colour and a
 * hairline in depth: no silhouette line of its own, and the hillside's line
 * composited straight over the top of it. So the crowd opts out of the
 * override pass and registers its own prepass material, which shares the
 * vertex shader verbatim. The two strings must not fork.
 *
 * **Unlit, and it does not cast.** Unlit because a billboard's normal is a
 * fiction — it turns with the camera, so a lit one changes value as you drive
 * past it, which reads as flickering rather than as shading; and because flat
 * blocks of poster colour are what the brief asked for. No shadow because the
 * shadow map is rendered with three's own depth material, which again does not
 * run this vertex shader: the whole crowd would cast from wherever the source
 * quad happens to lie. `castShadow` is off and stays off.
 */

/* Figure units. y runs 0 at the feet to 1 at the crown and x is in the same
   unit, so one number scales a spectator and everything about it: the arm
   length, the hop height, the pom-poms, and the gap to the neighbour standing
   next to them. This project has lost five rounds to a size expressed in one
   unit and its partner expressed in another; here there is only one unit. */
const FIG_ARM = 0.34;          // shoulder to hand
const FIG_SHOULDER = 0.135;    // half the shoulder span
const FIG_SHOULDER_Y = 0.755;
const FIG_HIP_Y = 0.44;
/* Gap between neighbours in a group, in figure units — a shade over twice the
   shoulder span, so a group reads as people standing together rather than as
   a queue or a pile, at any figure size. */
const FIG_GAP = 0.58;

const SLOT_SKIN = 0, SLOT_SHIRT = 1, SLOT_LEGS = 2, SLOT_ITEM = 3, SLOT_HAIR = 4;
const ROT_NONE = 0, ROT_ARM_L = 1, ROT_ARM_R = 2, ROT_LEG = 3;

const POSE_CHEER = 0, POSE_FLAG = 1, POSE_SIT = 2, POSE_POM = 3;

/* Clothes. Saturated but not fluorescent, and deliberately across the wheel
   from the stage's own greens and ochres so a group reads as a cluster of
   colour against the verge from a hundred metres. */
const CROWD_SHIRTS = [
  0xd8452f, 0x2f6fd8, 0xe8a020, 0x3f9e55, 0xd83f8e,
  0xf2ecdc, 0x6a4fc0, 0x1fa5a0, 0xe86a28, 0x4a6ea8,
];
const CROWD_LEGS = [0x2b3a4a, 0x4a3a2b, 0x384a38, 0x585460, 0x23303a, 0x7a6a58];
const CROWD_SKIN = [0xf2c69f, 0xdaa476, 0xba7f52, 0x8d5c36, 0xf7d8ba];
const CROWD_HAIR = [0x2a1f18, 0x4a3020, 0x7a5a34, 0x1c1a1c, 0xa8895c, 0xb03a2e];
const CROWD_FLAGS = [0xffd23f, 0xff4d3d, 0x3fb8ff, 0xf6f2e6, 0xff6bd6, 0x54d97a];

/* A cheer squad wears one kit, and each squad gets its own, because two squads
   in the same colours read as the same squad seen twice rather than as two.
 *
 * FOUR of them, and the count is not decoration. Every stage builds four
 * squads — the start line, the finish, the longest ramp landing and the first
 * hairpin — and the kit index is `kit++ % CHEER_KITS.length`, so with three
 * kits the fourth squad wears the first squad's. Measured on all three seeds:
 * the start-line squad and the hairpin squad came out byte-identical in shirt,
 * legs, poms and hair. This is the pinned-partner defect again — a list whose
 * length has to match a count computed four thousand lines away — so the
 * fourth entry is deliberately the most distant hue left, and if a fifth squad
 * is ever built this comment is the warning that a fifth kit goes with it. */
const CHEER_KITS = [
  { shirt: 0xff3f8e, legs: 0xf6f2e6, item: 0xffe14d, hair: 0x2a1f18 },
  { shirt: 0x21c7d6, legs: 0xf6f2e6, item: 0xff5a3c, hair: 0x4a3020 },
  { shirt: 0xffe14d, legs: 0x3a3f6e, item: 0xff3f8e, hair: 0x1c1a1c },
  { shirt: 0x7a3fd6, legs: 0xffe14d, item: 0x21c7d6, hair: 0xa8895c },
];

/**
 * One spectator: nine quads, eighteen triangles, all of them in z = 0.
 *
 * Non-indexed, because every quad needs its own pivot, colour slot and
 * rotation group and there is nothing to share between them. Fifty-four
 * vertices is not worth an index buffer.
 */
function crowdFigureGeometry() {
  const position = [], color = [], tag = [], pivot = [];
  const quad = (pts, o) => {
    const [a, b, c, d] = pts;
    for (const v of [a, b, c, a, c, d]) {
      position.push(v[0], v[1], 0);
      color.push(1, 1, 1);
      tag.push(o.slot, o.rot ?? ROT_NONE, o.side ?? 1, o.hand ?? 0);
      pivot.push(o.pivot ? o.pivot[0] : 0, o.pivot ? o.pivot[1] : 0);
    }
  };

  /* Legs, as two quads with a real gap between them. One quad with a notch
     painted in would cost the same and lose the gap, and the gap is most of
     what says "person" at twenty pixels tall. Both swing the same way, so a
     sitting figure's legs go out together rather than doing the splits. */
  for (const s of [-1, 1]) {
    quad([
      [s * 0.125, 0], [s * 0.028, 0], [s * 0.022, 0.46], [s * 0.118, 0.46],
    ], { slot: SLOT_LEGS, rot: ROT_LEG, pivot: [s * 0.07, FIG_HIP_Y], side: 1 });
  }
  // Torso, tapered from shoulders to hips: a rectangle reads as a fridge.
  quad([[-0.115, 0.42], [0.115, 0.42], [0.145, 0.79], [-0.145, 0.79]], { slot: SLOT_SHIRT });
  quad([[-0.105, 0.80], [0.105, 0.80], [0.105, 1.00], [-0.105, 1.00]], { slot: SLOT_SKIN });
  /* Hair, over the crown and a little wider than the head. Two triangles that
     do nothing but break the top of the silhouette, which is the part of a
     figure a viewer reads first and the part a bare rectangle ruins. */
  quad([[-0.12, 0.945], [0.12, 0.945], [0.125, 1.035], [-0.125, 1.035]], { slot: SLOT_HAIR });

  for (const s of [-1, 1]) {
    const px = s * FIG_SHOULDER, py = FIG_SHOULDER_Y;
    const group = s < 0 ? ROT_ARM_L : ROT_ARM_R;
    quad([
      [px - 0.048, py - FIG_ARM], [px + 0.048, py - FIG_ARM],
      [px + 0.048, py + 0.035], [px - 0.048, py + 0.035],
    ], { slot: SLOT_SKIN, rot: group, pivot: [px, py], side: s });
    /* Whatever is in the hand — a pom-pom, a flag, or nothing. Authored at
       the hand and rotated about the shoulder with the arm, so it stays in
       the hand however far the arm goes up. Scaled to zero on a spectator
       holding nothing, which costs two degenerate triangles and no pixels. */
    const hy = py - FIG_ARM;
    quad([
      [px - 0.105, hy - 0.16], [px + 0.105, hy - 0.16],
      [px + 0.105, hy + 0.02], [px - 0.105, hy + 0.02],
    ], { slot: SLOT_ITEM, rot: group, pivot: [px, py], side: s, hand: 1 });
  }

  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  /* White, and overwritten in the vertex shader. three only declares vColor
     when vertexColors is on and vertexColors only turns on when the attribute
     exists, so this is the price of reaching the varying at all. */
  g.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  /* Colour slot, rotation group, which side of the body, and whether this
     vertex is held in the hand — four one-byte facts in one attribute.
     Packed because WebGL guarantees sixteen vertex attributes and the honest
     layout wanted eighteen; the first build of this failed to link with
     "Too many attributes (aHair)". */
  g.setAttribute('aTag', new THREE.Float32BufferAttribute(tag, 4));
  g.setAttribute('aPivot', new THREE.Float32BufferAttribute(pivot, 2));
  return g;
}

/* The whole of the crowd's motion, shared verbatim between the beauty pass
   and the ink prepass. Forking these two strings is the one change that
   cannot be caught by looking at a frame — the picture stays right and the
   outlines quietly stop belonging to it. */
const CROWD_VERT_BODY = /* glsl */`
  float aRot = aTag.y;
  float aSideSign = aTag.z;
  float aHand = aTag.w;
  vec3  aOrigin = aPlace.xyz;
  vec2  aSize = vec2(aBody.x, aPlace.w);
  float aPhase = aBody.z;
  float aRate = aBody.w;

  /* Which of the four rotation groups this vertex belongs to, one-hot. */
  vec4 rsel = vec4(
    step(aRot, 0.5),
    step(0.5, aRot) * step(aRot, 1.5),
    step(1.5, aRot) * step(aRot, 2.5),
    step(2.5, aRot));
  /* And which of the four poses this figure is in. */
  float poseId = aBody.y;
  vec4 psel = vec4(
    step(poseId, 0.5),
    step(0.5, poseId) * step(poseId, 1.5),
    step(1.5, poseId) * step(poseId, 2.5),
    step(2.5, poseId));

  /* How worked up this spectator is, from how close the car has come. The
     stagger is a distance, added to a distance, so a group lights up as a
     ripple down the line rather than as one body — at racing speed the span
     of uStagger metres is about a fifth of a second between the first of them
     and the last. */
  float carDist = distance(aOrigin, uCar) + aPhase * uStagger;
  /* Two ways in, and they are the same way in: how excited this spectator is.
     Proximity is the first, and the second is uHype, which the start
     countdown drives — the car is stationary on the grid, so the distance
     term alone would have the squad at the far end of the grid holding one
     pose for three seconds and then holding it through the release.
     Gated by the same distance the reaction is quoted at, so it means "the
     crowd where the car is, on top of what the car is already doing to them"
     rather than every spectator on five and a half kilometres. */
  float ex = max(smoothstep(uReactFar, uReactNear, carDist),
                 uHype * smoothstep(uReactFar * 2.5, uReactFar, carDist));

  /* Four frames, held. Drawn animation steps and this is drawn animation; a
     smoothly interpolated crowd reads as rubber. The rate is fixed per figure
     and never a function of excitement, because fract(t * rate(t)) with a
     large t jitters violently for any rate that moves — what excitement
     changes is the size of the gesture, not its tempo. */
  float loop = fract(uTime * aRate + aPhase);
  float fr = floor(loop * 4.0);
  vec4 fsel = vec4(
    step(fr, 0.5),
    step(0.5, fr) * step(fr, 1.5),
    step(1.5, fr) * step(fr, 2.5),
    step(2.5, fr));
  float bounce = dot(fsel, uBounce);
  float sway = bounce * 2.0 - 1.0;

  /* Arms, as an outward raise from hanging. Mirrored by the side the limb is
     on, so one number means "up and out" for both of them. */
  float swing = dot(psel, uArmSwing);
  float armL = mix(dot(psel, uArmRestL), uArmUp, ex) + swing * sway * uSwingSpan;
  float armR = mix(dot(psel, uArmRestR), uArmUp, ex) - swing * sway * uSwingSpan;
  float legAng = psel.z * uSitAngle;

  float mag = dot(rsel, vec4(0.0, armL, armR, legAng));
  float ang = aSideSign * mag;
  float armLen = dot(rsel, vec4(1.0, aLimb.z, aLimb.w, 1.0));
  float itemScale = dot(rsel, vec4(1.0, aLimb.x, aLimb.y, 1.0));

  vec2 fromPivot = position.xy - aPivot;
  vec2 handRest = vec2(0.0, -${FIG_ARM.toFixed(3)});
  /* An arm vertex stretches along the arm; a hand-held vertex rides out to
     the end of the arm and keeps its own size. */
  vec2 rel = mix(
    fromPivot * vec2(1.0, armLen),
    handRest * armLen + (fromPivot - handRest) * itemScale,
    aHand);
  float ca = cos(ang), sa = sin(ang);
  vec2 fig = aPivot + vec2(rel.x * ca - rel.y * sa, rel.x * sa + rel.y * ca);

  /* The hop, in figure heights, so a tall spectator jumps proportionally
     higher and the two never come apart. */
  fig.y += ex * uHop * bounce;

  vec3 local = vec3(fig.x * aSize.x, fig.y * aSize.y, 0.0);

  /* Turn the plane to face the camera about the vertical, and only about the
     vertical. Degenerate only when the camera is directly overhead, which is
     the overview shot and has no crowd worth reading in it. */
  vec2 look = cameraPosition.xz - aOrigin.xz;
  float lookLen = length(look);
  vec2 fwd = lookLen > 1e-4 ? look / lookLen : vec2(0.0, 1.0);
  vec3 rgt = vec3(fwd.y, 0.0, -fwd.x);
  vec3 crowdWorld = aOrigin + rgt * local.x + vec3(0.0, local.y, 0.0);
`;

/* Colour is chosen per vertex from five per-figure slots. Doing it here rather
   than baking it into the vertex colours is what lets one geometry serve every
   spectator on the stage. */
const CROWD_COLOR_BODY = /* glsl */`
  float slot = aTag.x;
  float packed = dot(vec4(
    step(slot, 0.5),
    step(0.5, slot) * step(slot, 1.5),
    step(1.5, slot) * step(slot, 2.5),
    step(2.5, slot) * step(slot, 3.5)), aTone) + step(3.5, slot) * aHairTone;
  vec3 crowdCol = crowdUnpack(packed);
`;

/* Five clothing colours per figure, one packed float each — the authored hex
   verbatim, since 0xRRGGBB *is* r*65536 + g*256 + b and every value up to
   2^24 is exact in a float32. Unpacked and converted here rather than stored
   as linear triples because five vec3 attributes is five attributes, and the
   budget is sixteen for the whole shader. */
const CROWD_ATTRS = /* glsl */`
attribute vec4  aTag;
attribute vec2  aPivot;
attribute vec4  aPlace;
attribute vec4  aBody;
attribute vec4  aLimb;
attribute vec4  aTone;
attribute float aHairTone;
uniform float uTime;
uniform vec3  uCar;
uniform float uReactFar;
uniform float uReactNear;
uniform float uStagger;
uniform float uHype;
uniform vec4  uBounce;
uniform vec4  uArmRestL;
uniform vec4  uArmRestR;
uniform vec4  uArmSwing;
uniform float uArmUp;
uniform float uSwingSpan;
uniform float uSitAngle;
uniform float uHop;

vec3 crowdUnpack(float v) {
  float r = floor(v / 65536.0);
  float g = floor((v - r * 65536.0) / 256.0);
  float b = v - r * 65536.0 - g * 256.0;
  vec3 c = vec3(r, g, b) / 255.0;
  // sRGB to the linear working space, the same transfer a hex gets in JS.
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
`;

/**
 * The beauty material and the ink-prepass material, sharing one uniform block.
 *
 * They have to share the *objects*, not the values: the prepass runs first and
 * the beauty pass second inside a single `pipeline.render()`, and any route
 * that set them separately — a clock read twice, two copies of the car
 * position — would put the outlines a frame or a metre away from the figures
 * they belong to. `movingCelMaterial` cannot do this because it mints its own
 * uniforms inside `onBeforeCompile`, so this is its shape with the block
 * passed in.
 */
function crowdMaterials(uniforms) {
  const beauty = unlitCelMaterial({
    color: 0xffffff, vertexColors: true, flatShading: true,
    side: THREE.DoubleSide, fog: true,
  });
  const compileCel = beauty.onBeforeCompile;
  beauty.onBeforeCompile = shader => {
    compileCel(shader);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = CROWD_ATTRS + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\n${CROWD_VERT_BODY}\n${CROWD_COLOR_BODY}
       vColor = crowdCol;
       transformed = crowdWorld;`,
    );
  };
  beauty.customProgramCacheKey = () => 'crowd-billboard';

  /* The same expansion, writing what render/outline.js's own prepass writes:
     a geometric view normal from the derivatives of the view position, the
     linear view distance in alpha, and class 0 in the red channel's offset —
     the class every unnamed prop on this stage carries. */
  const prepass = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.DoubleSide,
    vertexShader: `${CROWD_ATTRS}
varying vec3 vCrowdView;
void main() {
${CROWD_VERT_BODY}
  vec4 mv = modelViewMatrix * vec4(crowdWorld, 1.0);
  vCrowdView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: `precision highp float;
varying vec3 vCrowdView;
void main() {
  vec3 n = normalize(cross(dFdx(vCrowdView), dFdy(vCrowdView)));
  gl_FragColor = vec4(n * 0.5 + 0.5, -vCrowdView.z);
}`,
  });
  return { beauty, prepass };
}

/* How much warning the crowd gives, as a lead time and the speed it is a lead
   time at, rather than as a bare radius. At 47 m/s — 169 km/h, which is where
   this car spends the fast third of the stage — a spectator that only reacted
   inside thirty metres would have finished reacting before the driver could
   see them do it. */
const CROWD_LEAD = 1.55;             // seconds of warning
const CROWD_LEAD_SPEED = 47;         // m/s the lead time is quoted at
const CROWD_REACT_FAR = CROWD_LEAD * CROWD_LEAD_SPEED;
const CROWD_REACT_NEAR = 24;         // fully up by here
const CROWD_STAGGER = 11;            // metres of ripple across a group

/* Height range, feet to crown. Slightly over life size: measured against the
   chase lens at 1600x900 a 1.75 m figure is 19 px tall at seventy metres,
   which is where the reaction has to start reading, and the extra tenth buys
   a pixel there for nothing anywhere else. */
const CROWD_HEIGHT = [1.66, 1.98];
/* Metres of shoulder a spectator owes the road, and the same number every
   other object with mass on this stage owes it. */
const CROWD_CLEAR = PROP_CLEAR;
/* And how far back they actually stand, in metres from the road edge.
 *
 * A distance and not a corridor fraction, and the difference is the whole of
 * this project's recurring defect. `field.point` places by fraction of
 * `wallDist`, and `wallDist` on this stage runs from nine metres through the
 * switchbacks to seventy on the coastal shelf. The first version of this
 * asked for u = 0.62 everywhere: measured, that put a group 6.7 m off the
 * kerb at one site and 42.8 m off it at another — a 1.82 m spectator is 68 px
 * tall at the first and 15 px at the second, so half the crowd was placed
 * somewhere the driver could not see it was a crowd. One number in metres,
 * clamped between the clearance floor and the cliff lip, gives every group the
 * same read.
 */
const CROWD_STAND = 7.4;
/* Where the start-line squad stands.
 *
 * A module constant rather than a local because the site scheduler has to
 * count it: it is a group the player really sees, so it bounds the first
 * stretch of the pacing rule even though it is built outside the ordinary run
 * of sites.
 *
 * Forty-six and not fifty-six, and not the forty the countdown work
 * suggested. Measured by ablation with the car parked on the grid and the
 * countdown running (tools/zqgrid.mjs), over three seeds and nine stations:
 * at 56 the squad is 3.1–3.8 k pixels and 58–75 px tall; at 46 it is 6.1–9.3 k
 * and 95–124 px, two to two and a half times the footprint. The recommended
 * 40 is worse than 46 on every seed, and it is close to a cliff — at 36 and
 * at 30 the squad is off the side of the frame entirely, nothing, on all
 * three seeds. Forty-six is the last station before the group starts leaving
 * the picture and it keeps six metres of margin from the edge.
 */
const CROWD_START_S = 46;
const CROWD_RAIL_H = 0.74;           // metres, the top of a sitting rail
/* The footing gate: how far back towards the road the ground is sampled, and
   how far it may fall over that distance before the feet are on a lip rather
   than on a bank. Both in metres over the same run, so the pair cannot drift
   apart the way a fraction and a distance would — 0.8 m over 2 m is 22°, and
   the slope gate a few lines further down is 44° over its own run.

   RISE_MAX is the companion, and it is the same unit again: how far above the
   road edge the boots may be. The scoring in crowdStand rewards rise, because
   a group on a bank reads better than a group on the flat, and left uncapped
   that reward will happily climb a wooded slope until the group is standing
   in the tops of the firs with a hundred and sixty metres of hillside behind
   its ankles. Seed 22 at s 5050 did exactly that. */
const LIP_PROBE = 2.0;
const LIP_DROP = 0.8;
/* Forty-four degrees, as a rise over a run. What separates ground a person
   stands on from a face they do not, and named once because two gates below
   ask the question — one about the metre the boots are on, one about the
   drop two metres behind them. */
const STAND_SLOPE = 0.97;
/* What standing a pace short of a drop costs a candidate offset. Larger than
   the whole of the rest of the score's range — the rise term pays at most
   CROWD_RISE_PAID * 2 and the standoff term is bounded by the reach — so an
   offset with ground behind it beats one without, always, and the only time
   an edge is chosen is when the station offers nothing else. */
const CROWD_EDGE_COST = 100;
/* How much a metre of rise is worth to the scoring below, and how far out a
   spectator may look for footing on a shoulder the terrain generator has
   flagged as falling away. One constant and its partner, in the same unit,
   derived from each other rather than both guessed — which is the rule this
   whole rework exists to enforce.
   
   The score is `min(rise, RISE_PAID) * 2 - |out - CROWD_STAND|`, so the most
   a spot can ever earn by being on higher ground is RISE_PAID * 2, and any
   spot further from the road than that many metres past CROWD_STAND cannot
   win however good it is. Capping the search there is therefore free: it
   removes only candidates the scorer was already going to refuse. Pick the
   cap independently and the two drift — at ten metres it cut two metres off
   the reach the scorer still had a use for, and seed 22 lost its finish
   crowd entirely, which is the defect at the top of this list. */
const CROWD_RISE_PAID = 2.2;
const CROWD_LIP_REACH = CROWD_STAND + CROWD_RISE_PAID * 2;
/* One probe, at two metres, and it was worth checking whether that is enough:
   tools/zzfoot.mjs still reads figures whose ground drops out a row or two
   below the boots, which looks like a ledge the single probe lands on top of.
   Walking the apron at 1.0 / 2.0 / 3.5 m against the same slope was measured
   and made it worse — 50 of 156 figures with no visible ground at the feet
   against 43 of 157 for the single probe, cliff-edge cases 17 → 18. The extra
   probes do reject the ledges, but the runner-up candidate they promote is
   further from the road and reads worse, and the score has no term for that.
   So the prescription's single probe stands, on its own measurement. */
const RISE_MAX = 4.5;

const _crowdA = new THREE.Vector3();
const _crowdB = new THREE.Vector3();
const _crowdC = new THREE.Vector3();
/* How far out the berm profile in track.js has knots: its BERM table ends at
   5.0 m. Quoted here rather than imported because that table is private to a
   file this work does not own — so it is checked against `bermHeight` by the
   only means available, which is that the function returns a constant for every
   offset past it. A quoted constant that stops matching its source is the
   pinned-partner trap again, so it is named once and used once. */
const BERM_REACH = 5.0;
const _drawnA = new THREE.Vector3();
const _drawnB = new THREE.Vector3();

/* How high the ground the frame ACTUALLY HAS is, under a point on the corridor.
 *
 * `field.point` is an analytic surface, and nothing draws it. What draws the
 * shoulder is `buildLandform`, which samples `landformPoint` on a ladder —
 * TERRAIN_STEP = 9 m apart along the stage, and laterally at the apron rungs
 * u = 0, 0.1, 0.25, 0.45, 0.7, 1 of `wallDist` — and fills the quads between
 * those samples with flat triangles. Where the analytic surface is convex
 * between two rungs, the chord the mesh draws sags underneath it, and the gap
 * is not small: the crowd stands near u ≈ 0.25, right at the widest rung
 * spacing, where on a thirty-metre corridor one quad spans six metres of
 * ground.
 *
 * Measured, this being the whole point: 31 of 173 placed figures stood more
 * than 0.6 m above the nearest drawn mesh, worst 8.05 m (tools/wfeet.mjs),
 * including two at seed 22's finish — which is D2, the defect this all began
 * with. Every gate below was comparing the model against itself and reporting
 * success, which is this project's most dangerous failure and the reason the
 * audit that caught it went looking.
 *
 * So: interpolate `landformPoint` the way the mesh triangulates it, at the
 * mesh's own rows and rungs, and the answer is the drawn ground rather than a
 * surface nobody renders. Validated against a ray dropped on the meshes at
 * every placed figure (tools/zqdrawn.mjs) — that is what makes this faithful
 * rather than merely different.
 */
/* Eight rungs, which reaches past the widest apron this road has. The apron
   proper is the first six; the two after it are the foot of the wall, and
   including them means a query just outside the apron interpolates onto the
   slope that is drawn there instead of flat-lining off the last rung. */
const DRAWN_RUNGS = 8;

/* One ladder per mesh row per side, built on first use and kept for the life of
   the field.
 *
 * The rows are 9 m apart, so there are only about six hundred of them, and the
 * whole table costs about twenty thousand `landformPoint` calls once — against
 * the tens of millions that asking per query would cost, because `crowdSeen`
 * marches up to forty-eight samples per sightline, five sightlines per
 * candidate offset, nineteen offsets per station, for a few thousand stations.
 * The difference between a table and a cache is the difference between reading
 * the drawn ground everywhere and only being able to afford it under the boots. */
function drawnRow(field, side, i) {
  let store = field.__ladders;
  if (!store) store = field.__ladders = new Map();
  let t = store.get(side);
  if (!t) {
    t = {
      lat: new Float64Array(field.count * DRAWN_RUNGS),
      y: new Float64Array(field.count * DRAWN_RUNGS),
      /* Each row's own frame, because a row's rungs are laid out along ITS
         normal and not the query station's. Through a hairpin those fan apart
         by tens of degrees over the nine metres between rows, and measuring
         both rows at one lateral then reads a point the quad between them does
         not contain: seed 1 s=1478 put a figure 8 m off the kerb where the
         ribbon's own parameterisation had no ground at all, and a ray dropped
         there fell a hundred and fourteen metres to the far side's ribbon. */
      fx: new Float64Array(field.count),
      fz: new Float64Array(field.count),
      rx: new Float64Array(field.count),
      rz: new Float64Array(field.count),
      done: new Uint8Array(field.count),
    };
    store.set(side, t);
  }
  if (!t.done[i]) {
    const at = field.ss[i];
    const f = field.profile(at, side).f;
    t.fx[i] = f.pos.x;
    t.fz[i] = f.pos.z;
    t.rx[i] = f.flatRight.x;
    t.rz[i] = f.flatRight.z;
    for (let c = 0; c < DRAWN_RUNGS; c++) {
      landformPoint(field, at, side, c, _drawnB);
      t.lat[i * DRAWN_RUNGS + c] = Math.abs(
        (_drawnB.x - f.pos.x) * f.flatRight.x + (_drawnB.z - f.pos.z) * f.flatRight.z);
      t.y[i * DRAWN_RUNGS + c] = _drawnB.y;
    }
    t.done[i] = 1;
  }
  return t;
}

function drawnRowY(t, i, latWanted) {
  const base = i * DRAWN_RUNGS;
  let prevLat = t.lat[base], prevY = t.y[base];
  for (let c = 1; c < DRAWN_RUNGS; c++) {
    const lat = t.lat[base + c], y = t.y[base + c];
    if (lat >= latWanted) {
      /* Clamped, so a query inside the first rung reads that rung's height
         rather than extrapolating backwards down its slope — off a face that
         drops forty metres a rung, a fraction of a metre the wrong side of the
         road edge would otherwise answer with tens of metres of fiction. */
      const w = lat > prevLat
        ? clamp((latWanted - prevLat) / (lat - prevLat), 0, 1)
        : 0;
      return prevY + (y - prevY) * w;
    }
    prevLat = lat;
    prevY = y;
  }
  return prevY;
}

function drawnGroundY(field, s, side, u) {
  field.point(s, side, u, _drawnA);
  const i = Math.min(field.count - 2,
    Math.max(0, Math.floor(s / TERRAIN_STEP)));
  const s0 = field.ss[i], s1 = field.ss[i + 1];
  const w = s1 > s0 ? clamp((s - s0) / (s1 - s0), 0, 1) : 0;
  const t = drawnRow(field, side, i);
  drawnRow(field, side, i + 1);
  /* One lateral, taken in the query station's own frame, for both rows.
     Measuring each row in ITS frame instead was tried — it is arguably closer to
     how the quads are actually laid out through a turn — and it was worse on
     both instruments: the sweep's p90 error rose from 0.60/0.26/0.25 m to
     0.76/0.33/0.33 m across the three seeds, and tools/wfeet.mjs went from one
     figure standing on air to two. So the simpler parameterisation stays, on the
     measurement rather than on the argument. */
  const lat = Math.abs((_drawnA.x - t.fx[i]) * t.rx[i]
    + (_drawnA.z - t.fz[i]) * t.rz[i]);
  return drawnRowY(t, i, lat) * (1 - w) + drawnRowY(t, i + 1, lat) * w;
}

/**
 * Where a group can stand on this shoulder, as a corridor fraction.
 *
 * `standable()` above answers the same question about the landform ladder,
 * which is the wall and the back country — a different parameterisation from
 * the corridor `field.point` places in, and the corridor is where a spectator
 * stands. Same test, same limit in spirit, measured in the right space.
 */
/**
 * Can a driver coming up the road see a spectator's chest?
 *
 * Not a lateral question, which is the mistake the first two versions of this
 * made. A driver approaches nearly along the road, so the sightline to a
 * group on the shoulder runs *down* the shoulder at a shallow angle and skims
 * everything on it for thirty or forty metres. What it skims is almost always
 * the berm: a raised stone lip the road mesh adds at the kerb, up to 1.85 m
 * above the road edge at 2.6 m out, which is over the head of anybody
 * standing in the apron behind it. A lateral test at the group's own station
 * sees none of that and passes the group anyway — measured against Three's
 * raycaster from the real chase lens, it passed two groups that were 0 of 5
 * and 0 of 8 visible over their whole approach.
 *
 * Worked in the road's own (station, offset, height) coordinates rather than
 * by tracing world space, so it costs a few dozen field lookups instead of a
 * raycast against the stage, and heights are compared as absolute y so the
 * 470 m the road descends cannot leak into the answer.
 *
 * Chest and not crown: a group whose heads clear the bank and whose bodies do
 * not is the same failure one metre up.
 *
 * @param {number} out    metres from the road edge
 * @param {number} chestY absolute height of the chest
 * @param {number} eye    metres the lens rides above the road edge
 * @param {number[]} backs metres the CAR is short of the group, per station
 *
 * The eye is put a boom length behind the car, which the first version of this
 * did not do and which is not a detail. Measured on seeds 22, 1 and 40 at ten
 * stations each (tools/zqlens.mjs), the chase lens sits 6.3–12.3 m of station
 * behind the player, median 10.8, and 3.44 m above the centreline rather than
 * the 2.05 this assumed. Both errors are real and they pull opposite ways —
 * further back flattens the sightline, higher up lifts it — so neither may be
 * dropped for the other. Taking the pessimistic end of each is what makes the
 * test conservative: the longest boom with the lowest eye.
 */
const CROWD_BOOM = 11;       // metres of station the lens trails the car by
const CROWD_EYE = 2.55;      // metres the lens rides above the road edge
/* The guard rail as buildGuardRail actually builds it: BERM_CREST laterally,
   a beam whose underside is RAIL_TOP above the berm crest and which is as
   deep as its own section. Kept here rather than imported because track.js
   exports none of the three, and wrong-by-a-little here is a group placed
   where the beam crosses its chest, not a crash. */
const CROWD_RAIL_LAT = 2.6;    // BERM_CREST
const CROWD_RAIL_UNDER = 1.15; // RAIL_TOP — clear air between crest and beam
const CROWD_RAIL_DEEP = 0.40;  // the beam's own section

function crowdSeen(field, s, side, out, chestY, eye, backs = [15], note = null) {
  /* Fifteen metres out, measured to the CAR. At 40 m/s that is 0.4 s before
     the car is abeam, which is the frame the whole reaction has been building
     towards. The lens itself is CROWD_BOOM further back than that. */
  for (const back of backs) {
    const s0 = s - back - CROWD_BOOM;
    if (s0 < 4) continue;
    const eyeY = field.track.frameAt(s0).pos.y + EDGE_DROP + eye;
    let clear = true;
    /* About a metre of station per sample. Fixed at nine when the span was
       always fifteen metres; the span is now the boom plus whatever standoff
       is being judged, so the count has to follow it or a long sightline is
       sampled coarsely enough to step straight over a rail. */
    const steps = clamp(Math.round(s - s0), 9, 48);
    for (let k = 1; k < steps && clear; k++) {
      const t = k / steps;
      const st = s0 + (s - s0) * t;
      const d = out * t;
      const fr = field.track.frameAt(st);
      const bs = side > 0 ? fr.bermR : fr.bermL;
      const bt = fr.pos.y + EDGE_DROP;
      /* The berm, which is solid ground and blocks everything below its
         crest, plus a third of a metre for the rubble the berm mesh scatters
         over its own mean profile.

         And then the guard rail, which is NOT solid and which this used to
         treat as if it were: a wall from the crest up to 1.15 m over it. That
         is precisely the open part. buildGuardRail stands a beam 0.40 m deep
         with its underside 1.15 m above the crest, on posts 0.26 m wide every
         5.4 m — so the metre of air under the beam is a window, not masonry,
         and only about a twentieth of it has a post in it. Modelling it the
         old way turned every sightline that ducked under a rail into a
         rejection. Held against pixels (tools/zqoracle.mjs) that cost the
         start-line squad and seed 22's hairpin, both of which the frame shows
         plainly at 47–90 px, so it is a false negative and not caution.

         Modelled wherever the berm is substantial rather than by asking where
         the rail runs, because `railWants` is private to track.js and a group
         that clears a rail which turns out not to be there has lost nothing. */
      /* Only as far out as the berm profile actually has knots. Past its last
         one at 5 m `bermHeight` does not stop describing a berm — it
         extrapolates a constant, and every gate that reads it out there is
         asserting solid ground at road level across a shoulder where the berm
         mesh ends and the apron takes over.
     
         Measured, on the site this cost: seed 22's finish. Every one of the
         five approach stations was refused with "the berm crest 12 m out", a
         berm profile evaluated seven metres past its own edge, standing about
         half a metre above the ground that is actually drawn there — and the
         margin the ray lost by was ten centimetres. So the seed had no finish
         crowd at all, which is D1, and the cause was the sightline gate
         defending a ridge nothing renders. */
      const crest = d <= BERM_REACH
        ? bt + bermHeight(d, bs) - EDGE_DROP + 0.34
        : -Infinity;
      const ray = eyeY + (chestY - eyeY) * t;
      const railed = bs > 0.35 && Math.abs(d - CROWD_RAIL_LAT) < 0.5;
      const beam = bt + bermHeight(CROWD_RAIL_LAT, bs) - EDGE_DROP + CROWD_RAIL_UNDER;
      const inBeam = railed && ray > beam - 0.05 && ray < beam + CROWD_RAIL_DEEP + 0.05;
      /* And the shoulder itself off the drawn surface rather than the analytic
         one, for the reason set out at `drawnGroundY`: a sightline that stops on
         a model ridge which the frame does not have is a group refused for
         nothing, and that is the same error as D2 with its sign reversed. */
      const groundY = drawnGroundY(field, st, side,
        d / Math.max(field.profile(st, side).wallDist, 1));
      const solid = Math.max(crest, groundY);
      if (solid > ray + 0.05 || inBeam) {
        clear = false;
        if (note) {
          note.what = inBeam ? 'the guard rail beam'
            : groundY > crest ? 'the shoulder itself' : 'the berm crest';
          const blockY = inBeam ? beam : solid;
          note.text = `${note.what} ${d.toFixed(1)} m out at s=${st.toFixed(0)}`
            + ` (blocker y ${blockY.toFixed(1)}, ray y ${ray.toFixed(1)},`
            + ` eye y ${eyeY.toFixed(1)} at s=${s0.toFixed(0)}, chest y ${chestY.toFixed(1)})`;
        }
      }
    }
    if (clear) return true;
  }
  return false;
}

/**
 * @param {string[]} [trace] if given, one line per candidate offset saying
 *   which gate turned it down. Every gate here is a judgement about what the
 *   player can see, and when one of them empties a whole station the only
 *   useful question is which — so the function says so rather than leaving a
 *   probe to re-derive it and grade its own copy. Read by tools/zqwhy.mjs.
 */
function crowdStand(field, s, side, metres = CROWD_STAND, trace = null) {
  /* First: is there a surface here at all?
   *
   * Every other gate in this function reasons about `field.point`, which is an
   * analytic corridor and not a mesh. For the last tenth of the stage on the
   * inland side there is no mesh under it — buildLandform declines to build
   * its quads past BASIN_SHARE_FROM, deliberately, because the finish road
   * runs beside the basin floor and a second corridor surface stacked fins
   * into the frame. The corridor keeps being computed there all the same, and
   * a placement rule that trusts it puts people in mid-air.
   *
   * Measured with tools/wground.mjs on seed 22: from s=5050 to s=5570 on side
   * +1, at the crowd's own standing distance, the model surface has up to
   * 17.5 m of nothing under it before the basin floor. That is 530 m of
   * run-in, and it is where the old build put both the last ramp landing and
   * the finish crowd itself — the two sites tools/zzfoot.mjs reports with no
   * ground at their feet, at 6.4x to 14.6x the figure's own range.
   *
   * This is the part of D2 the prescribed lip test cannot reach: that test
   * compares `field.point` two metres apart, and both samples are equally
   * fictional. The lip test stays — it is right about real lips — but it
   * cannot be asked to notice that the ground it is measuring is not there. */
  if (side > 0 && s >= field.track.length * BASIN_SHARE_FROM) {
    trace?.push('no inland ribbon past the basin share — the corridor surface'
      + ' here is not a mesh, the basin floor is metres below it');
    return null;
  }
  const profile = field.profile(s, side);
  /* The clearance every other object with mass owes the road, and a metre on
     top of it. Dropping the extra metre was tried and measured: it lets a
     group stand at 5.6 m, the score sometimes prefers that, and the offset
     the score prefers is the one place() then judges the run-in from — so
     seed 40 lost two sites to spots that were closer to the road and hidden
     behind its berm, and its worst hole went from 27.9 s to 40.8. The margin
     stays until the scoring and the sightline are decided together rather
     than one after the other. */
  const uMin = (CROWD_CLEAR + 1.1) / profile.wallDist;
  /* Past the lip on a shoulder that falls away is a forty-metre drop, not a
     viewing spot — the same trap the wildflower band documents above. How far
     out the lip is, though, is a distance, and this used to cap it with the
     FRACTION 0.30. Its partner two lines up is metres. `wallDist` runs from
     nine metres through the switchbacks to seventy on the coastal shelf, so
     the pair agreed at whatever width the 0.30 was tuned on and diverged
     everywhere else: on a nine-metre corridor the cap sat at 2.7 m, inside
     the berm, while the floor sat at 6.7 m and nobody could stand anywhere.
     That is this project's pinned-partner defect again, and it is the same
     one D3 exists to fix — a fraction standing in for a distance.

     Measured on seed 22 through the switchback third (tools/zqshelf.mjs),
     which is where the pacing pass reported "0 stations anybody could stand
     on" across 590 m and 45 s: the road there is a shelf, and most of it
     really is a cliff at four metres out — but not all of it. At s=1560,
     1680 and 1920 the inland shoulder is flat to eight metres, ±0.5 m, on
     corridors 18–25 m wide. Every one of those was refused, and refused by
     the arithmetic rather than by the ground: uMin 0.26–0.36 against a cap
     of 0.30.

     So both bounds are metres from the road edge now, and the cliff itself
     is left to the three gates below that actually measure it — the 44°
     slope test, the lip test, and the sightline. Those look at the ground;
     `dropness` is a category flag the terrain generator sets, and a flag
     cannot tell a shelf from a face. */
  const uMax = Math.min(0.86, (profile.dropness > 0.45 ? CROWD_LIP_REACH : 1e4)
    / profile.wallDist);
  /* A metre of window, not a twentieth of a corridor — for the same reason. */
  if (uMin > uMax - 1 / profile.wallDist) {
    trace?.push(`no corridor: uMin ${uMin.toFixed(2)} > uMax ${uMax.toFixed(2)}`
      + `  (${(uMin * profile.wallDist).toFixed(1)}–${(uMax * profile.wallDist).toFixed(1)} m out,`
      + ` wallDist ${profile.wallDist.toFixed(1)} m, dropness ${profile.dropness.toFixed(2)})`);
    return null;
  }
  const want = clamp(metres / profile.wallDist, uMin, uMax);

  /* What the group has to stand above to be a group at all.
   *
   * Every other prop on this stage is scenery wherever it lands: a tree half
   * behind a bank still reads as a tree, and the rocks are *supposed* to read
   * as landform. A person hidden to the chest reads as nothing. And this
   * shoulder hides them — the berm is a raised lip at the kerb, up to a metre
   * of it, and beyond the lip the apron very often falls away. The first
   * build of this placed by distance alone and put five of the seven groups
   * below the lip; measured from the chase lens, seed 22 s 2631 was 0/5
   * visible over the whole approach and the frame at fifteen metres shows one
   * corner of one flag above the grass and nothing else.
   *
   * So: the ground they stand on has to clear the berm crest beside them,
   * with a little over for the rubble the berm mesh scatters on its own mean
   * profile. Both sides of that comparison are heights above the road edge in
   * metres, which is the unit this project keeps getting wrong. */
  const f = field.track.frameAt(s);
  const base = f.pos.y + EDGE_DROP;
  const scale = side > 0 ? f.bermR : f.bermL;
  /* Everything below is a height above the *road edge*, in metres, including
     the berm's — `bermHeight` returns heights above the centreline and the
     edge is EDGE_DROP under that, so the subtraction is the unit conversion
     and leaving it out is this project's five-times-repeated defect. */
  const bermRise = d => bermHeight(d, scale) - EDGE_DROP;
  /* The chase lens, near enough: about two and a half metres over the kerb it
     is passing. Conservative on purpose — the real boom lifts on air and
     lengthens with speed, both of which only ever help. */
  const EYE = 2.55;

  const step = 1 / profile.wallDist;
  let best = null, bestScore = -Infinity;
  for (let k = -4; k <= 14; k++) {
    const u = want + k * step;
    if (u < uMin || u > uMax) continue;
    field.point(s, side, u, _crowdA);
    /* Every height below is read off the DRAWN shoulder, not off `field.point`.
     *
     * `field.point` is an analytic surface and nothing renders it; the shoulder
     * in the frame is the flat-triangle interpolation of `landformPoint` that
     * `drawnGroundY` reproduces. The two are not close enough to substitute:
     * across the three seeds, at this standing distance, 14–24% of the stage
     * has the model surface more than 0.6 m above the drawn ground and the
     * worst honest cases run to several metres (tools/zqdrawn.mjs, which scores
     * both against a ray dropped on the meshes — model median error 0.11–0.29 m
     * and p90 2.2–6.5 m, `drawnGroundY` 0.01–0.02 m and p90 0.25–0.60 m).
     *
     * That is why every gate here used to pass a site that D2 then failed: the
     * lip test compared the model against itself, so it could not see that the
     * whole surface it was reasoning about was in the air. Measured on the build
     * this replaces, 31 of 173 figures stood more than 0.6 m above the nearest
     * mesh, worst 8.05 m, two of them at seed 22's finish (tools/wfeet.mjs) —
     * which is D2's headline site.
     *
     * The lateral geometry stays with the model: `out` and `run` are horizontal
     * distances across a corridor whose shape the model does describe, and the
     * ribbon is a graph over it. It is only the HEIGHTS that were fiction. */
    const groundY = drawnGroundY(field, s, side, u);
    const rise = groundY - base;
    const out = Math.max(u * profile.wallDist, 0.5);
    const say = why => trace?.push(`  ${out.toFixed(1)} m out, rise ${rise.toFixed(2)} m — ${why}`);
    if (insideTunnelRock(_crowdA)) { say('inside the tunnel rock'); continue; }
    // Forty-four degrees. Past that it is a face and nobody is standing on it.
    field.point(s, side, Math.max(0, u - 0.09), _crowdC);
    const run = Math.hypot(_crowdA.x - _crowdC.x, _crowdA.z - _crowdC.z);
    const backY = drawnGroundY(field, s, side, Math.max(0, u - 0.09));
    if (Math.abs(groundY - backY) > STAND_SLOPE * Math.max(run, 0.4)) {
      say(`too steep to stand on (${(groundY - backY).toFixed(2)} m over ${run.toFixed(2)} m)`);
      continue;
    }

    const note = trace ? {} : null;
    if (!crowdSeen(field, s, side, out, groundY + 0.95, EYE, undefined, note)) {
      say('no sightline — blocked by ' + (note?.text ?? '?'));
      continue;
    }

    /* And is there any ground under them that the player can SEE?
     *
     * A billboard casts no contact shadow — the shadow map cannot run the
     * crowd's vertex shader — and the build compensates by burying the feet
     * six centimetres. That only works while the apron in front of the feet
     * is itself in frame, and on a lip it is not: the lens rides barely two
     * metres over the road edge, so a figure standing on a step is looked at
     * almost along its own ground plane, the strip in front of the feet
     * foreshortens to nothing, and the pixel below the boots belongs to
     * whatever lies two hundred metres beyond. Measured on the build this
     * replaces (tools/zzfoot.mjs), every one of seed 22's eight finish
     * figures read that way, with single-row depth jumps of 400–1150%.
     *
     * The test is the step itself: the ground two metres back towards the
     * road, against the feet. A bank rises to the figure and keeps its apron
     * in view; a lip drops away behind them and does not. Both sides are
     * absolute y on the same surface, so there is no unit to get wrong.
     *
     * One-sided on purpose. Ground ABOVE the feet on the road side is a bank
     * the group is standing at the foot of, which hides nothing under them —
     * it is a sightline problem, and crowdSeen above has already had its say
     * about that.
     *
     * The step test is local, and locality is its limit: the apron can be
     * flat for four metres and still never reach the screen, if the group has
     * climbed far enough up the slope that everything under it is hillside
     * seen past a ridge. So cap the climb as well. */
    const nearY = drawnGroundY(field, s, side,
      Math.max(0, u - LIP_PROBE / profile.wallDist));
    if (groundY - nearY > LIP_DROP) {
      say(`on a lip — the ground ${LIP_PROBE} m towards the road is`
        + ` ${(groundY - nearY).toFixed(2)} m below the feet`);
      continue;
    }
    /* And the same question asked outwards, which the road-side probe cannot
     * answer and which is not the symmetric case.
     *
     * Standing a pace short of an edge passes everything above: the apron
     * towards the road is flat, so the step test is happy, and the slope test
     * samples towards the road too. But the lens is barely two metres over the
     * kerb and it looks at the shoulder almost along its own plane, so the
     * flat strip in FRONT of the boots foreshortens to a pixel or two, and the
     * rows below the feet on screen are filled by whatever is past the edge
     * BEHIND them — the valley, or the sea. That is D2's actual look, and it
     * is why this is not covered by "ground above the feet on the road side is
     * a bank": a bank is behind and above, an edge is behind and below.
     *
     * Measured: this gate exists because loosening the cliff cap above opened
     * seed 22 s=1928 and seed 1 s=2364, and tools/zqboots.mjs — which asks
     * whether the pixels under the boots are ocean or sky rather than asking
     * about depth ratios — found three figures across the three seeds standing
     * on sky, all of them at those two sites, all of them a pace short of a
     * four-metre drop.
     *
     * The fall it takes to matter is NOT the road-side figure. That one is
     * 0.8 m over 2 m, which is 22 degrees, and outwards 22 degrees is most of
     * the shoulders on this mountain. What is being looked for out here is a
     * FACE, and this file already has a definition of one — the slope gate a
     * few lines up, 44 degrees, past which nobody is standing. So the same
     * limit over the same run, and no new number to tune: 1.94 m over 2 m.
     *
     * A PREFERENCE and not a veto, which is the opposite of the road-side
     * test and was decided on the frame rather than by symmetry. Refusing an
     * edge outright was measured against keeping it, everything else held
     * (tools/zzcadence.mjs, one lap per seed, both configurations): with the
     * veto the legible fraction is 26.5 / 24.8 / 27.0 per cent on seeds 22, 1
     * and 40 and the worst hole is 19.0 / 33.5 / 26.8 s; without it, 32.3 /
     * 25.6 / 29.1 and 21.3 / 21.0 / 23.8. Better on the legible fraction on
     * all three and on the worst hole on two of three — because the stations
     * it refuses are, on this mountain, disproportionately the ones in the
     * stretches that have nothing else. What it was bought for is small by
     * comparison: three figures of 163 with sky under their boots.
     *
     * So it steers instead. Where a station offers a spot off the edge the
     * penalty is far larger than any rise can repay and that spot wins; where
     * the edge is all there is, the group still stands and the stretch still
     * has somebody in it. */
    const farY = drawnGroundY(field, s, side,
      Math.min(1, u + LIP_PROBE / profile.wallDist));
    const edge = groundY - farY > STAND_SLOPE * LIP_PROBE;
    if (rise > RISE_MAX) {
      say(`${rise.toFixed(1)} m above the road edge`
        + ` — up the slope, not on the shoulder`);
      continue;
    }

    /* Among the spots they can be seen from, the one that looks chosen: high
       ground is worth about two metres of standing further back, which puts a
       group on the bank at the outside of a turn rather than in the ditch at
       the foot of it, and is the nearest thing a continuous descent has to
       the hilltop the brief asks for. Capped — four metres up is a group
       looking at the roof of the car. */
    const score = Math.min(Math.max(rise, 0), CROWD_RISE_PAID) * 2 - Math.abs(out - metres)
      - (edge ? CROWD_EDGE_COST : 0);
    say(`OK, score ${score.toFixed(2)}${edge ? ' (on an edge)' : ''}`);
    if (score > bestScore) { bestScore = score; best = u; }
  }
  return best;
}

/* How long the car takes to get from one place on the stage to another.
 *
 * The crowd's spacing rule is a statement about pacing — "not wall to wall,
 * but never nothing for a minute either" — and pacing is a time. The rule it
 * replaces was written as four hundred metres and justified as "eight to
 * twenty seconds", which is a distance standing in for a time: true at the
 * tuning point and wrong everywhere else. Measured, the same four hundred
 * metres is 8 s down the coastal run and 19 s through the switchbacks, and it
 * was the switchback end that produced seventy-two seconds of empty road.
 *
 * The model is the cornering ceiling the landmark scheduler uses, with a
 * longitudinal limit on top of it, because a car cannot be at the hairpin
 * speed one metre before the hairpin and the approach is where the time
 * actually goes. Measured against the autopilot on seeds 22, 1 and 40
 * (tools/zqclock.mjs): the bare ceiling runs the lap 43–56% quick, the
 * longitudinal limit takes that to 30%, and re-fitting the grip takes it to
 * 14–22%. Past that the residual is not curvature — this driver also lifts
 * for crests and for the ramps — and chasing it would be fitting noise.
 *
 * So the last 23% is one named constant rather than a shrug, and it is
 * applied HERE, once, so that every threshold downstream is in real seconds
 * and can be compared directly with what tools/zzcadence.mjs measures off the
 * frame. A threshold in one unit and a clock in another is the bug this whole
 * rework exists to remove; it would be absurd to reintroduce it in the fix.
 */
const CROWD_GRIP = 0.62;             // g, lateral, fitted not assumed
const CROWD_VMAX = 47;               // m/s, the speed this car actually tops out at
const CROWD_DRIVE = 3;               // m/s² out of a corner
const CROWD_BRAKE = 6;               // m/s² into one
const CROWD_CLOCK_CAL = 1.23;        // real seconds per modelled second

function crowdClock(track) {
  const DS = 5;
  const L = track.length;
  const n = Math.ceil(L / DS) + 1;
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = Math.min(i * DS, L);
    let peak = 0;
    for (let d = -20; d <= 40; d += 5) {
      const c = track.frameAt(clamp(s + d, 0, L)).curv;
      if (Math.abs(c) > Math.abs(peak)) peak = c;
    }
    const radius = 1 / Math.max(Math.abs(peak), 1e-4);
    v[i] = Math.min(Math.sqrt(CROWD_GRIP * 9.81 * Math.min(radius, 900)), CROWD_VMAX);
  }
  for (let i = n - 2; i >= 0; i--) {
    v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * CROWD_BRAKE * DS));
  }
  for (let i = 1; i < n; i++) {
    v[i] = Math.min(v[i], Math.sqrt(v[i - 1] * v[i - 1] + 2 * CROWD_DRIVE * DS));
  }
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + (CROWD_CLOCK_CAL * DS) / (0.5 * (v[i - 1] + v[i]));
  }
  /** Seconds from the start line to station `s`. */
  const at = (s) => {
    const x = clamp(s, 0, L) / DS;
    const i = Math.min(n - 2, Math.floor(x));
    return lerp(cum[i], cum[i + 1], x - i);
  };
  at.lap = cum[n - 1];
  return at;
}

/** Runs of same-signed curvature, tightest first — the corners of the stage. */
function trackCorners(track) {
  const runs = [];
  let open = null;
  for (let s = 0; s <= track.length; s += 3) {
    const c = track.frameAt(s).curv;
    const sign = Math.abs(c) > 0.006 ? Math.sign(c) : 0;
    if (sign && open && open.sign === sign) {
      open.s1 = s;
      if (Math.abs(c) > Math.abs(open.peak)) { open.peak = c; open.apex = s; }
    } else if (sign) {
      if (open) runs.push(open);
      open = { sign, s0: s, s1: s, peak: c, apex: s };
    } else if (open && s - open.s1 > 18) {
      runs.push(open); open = null;
    }
  }
  if (open) runs.push(open);
  return runs
    .filter(c => c.s1 - c.s0 > 24)
    .map(c => ({
      apex: c.apex, exit: c.s1, sign: c.sign,
      radius: 1 / Math.abs(c.peak),
      turn: Math.abs(c.peak) * (c.s1 - c.s0),
    }))
    .sort((a, b) => a.radius - b.radius);
}

/**
 * The eight places on the stage that get a crowd.
 *
 * The brief names four kinds of spot: after sharp turns, at the top of hills,
 * near ramp landings, and at the finish. Three of them exist here. The fourth
 * does not, and it is worth saying why rather than approximating it: this
 * stage is a four hundred and seventy metre descent and it has **no local
 * maxima in its elevation profile at all** — measured on seeds 22, 1 and 40,
 * zero, at a prominence threshold of fifteen centimetres. The nearest thing
 * to a hilltop is a convexity, and the largest of those lifts the road 2.2 m
 * above the chord between the points seventy metres either side, which
 * `pickRamps` has already measured as too gentle to hide anything from the
 * driver. A group placed on one would be standing on a road that looks flat.
 *
 * What the brief actually wants from a hilltop is a group that chose a
 * vantage — above the road, looking down at cars coming through. That does
 * exist here, on the inland shoulder, where the apron climbs away from the
 * kerb: the rise each group ends up standing on is recorded on the site and
 * reported by tools/crowdaudit.mjs.
 */
/* Where on the run-in the finish crowd goes.
 *
 * It used to be `L - 38`, a hard-coded station with no test behind it, and on
 * all three seeds it landed somewhere the driver never sees the crowd and the
 * finish gate together. Seed 22 read zero of eight figures in pixels from 110
 * m out all the way in to 35 m and only came good at 15 m — nine tenths of a
 * second at racing speed. Seeds 1 and 40 failed it the other way round, on
 * the approach and then gone from 24 m and 35 m out respectively, so the
 * crowd was behind you by the time you crossed the line.
 *
 * A single station cannot be chosen well by one visibility test, because the
 * thing being asked for is not "visible" but "visible for the whole run-in".
 * So: search the window, and score by how many of the approach stations can
 * actually see the spot, with the tie broken towards the line. The gate is at
 * L - 12; the closer the group sits to it the more certainly the two are in
 * one frame, which is the half of the defect that is about staging rather
 * than about occlusion.
 *
 * The window stops at L - 26 because the site's own crowd group stands seven
 * metres further on and everything has to be inside the road.
 */
/* The stations the approach is judged over, as metres the CAR is short of the
   group. Fifty is where a 1.8 m figure first clears twenty pixels; fourteen is
   the last frame before the driver's eyes go to the next corner. */
const CROWD_BACKS = [50, 38, 28, 20, 14];

/* What a metre of run-in given up is worth, as a fraction of one station of
   the approach being in view. Eighty metres to the station: the search window
   is eighty metres wide, so at this rate the whole of it is worth exactly one
   station, and a spot that sees more of its own approach always wins while
   the distance to the line separates spots that see the same amount. Quoted
   once and converted at each use, because pickFinish scores a station at 4
   points and place scores it at 1. */
const CROWD_GATE_RATE = 1 / 80;

/**
 * How much of the run-in can see this spot — 0 to CROWD_BACKS.length.
 *
 * @param {number|null} gateS if given, the station of a gate that has to be in
 *   the SAME frame as the group. See below; this is the whole of D1.
 * @param {{both:number}|null} tally filled in with how many stations have both
 *   the group and the gate properly in frame, which is a different question
 *   from the score and the one `pickFinish` has to be able to refuse on.
 * @param {THREE.Object3D[]|null} blockers the drawn meshes, for the gate's own
 *   occlusion. Without them the gate term is a bearing only, which on one of
 *   the three seeds is not the binding constraint — see gateInShot.
 * @param {Map|null} gateCache shared across one search, keyed on lens station.
 */
function crowdSightScore(field, s, side, u, gateS = null, tally = null,
                         blockers = null, gateCache = null) {
  const profile = field.profile(s, side);
  field.point(s, side, u, _crowdA);
  const out = u * profile.wallDist;
  const cache = gateCache || new Map();
  /* Two questions, scored apart. A station where the group is both unblocked
     and inside the frame is worth a whole point; unblocked but off towards the
     edge is worth a quarter of one, because the lens does move and the road
     does straighten, and a spot that is merely marginal at one station should
     not lose to a spot that is hopeless at all of them. Hard-ANDing the two
     cost seed 22 the station the ablation liked best. */
  let seen = 0, both = 0;
  for (const back of CROWD_BACKS) {
    if (!crowdSeen(field, s, side, out, _crowdA.y + 0.95, CROWD_EYE, [back])) continue;
    let station = crowdInFrame(field, s, back, _crowdA) ? 1 : 0.25;
    /* And the gate, from the SAME lens station, scored as the minimum of the
       two.
     *
     * This term is D1. The requirement was never "the finish crowd is visible"
     * — it is "the crowd and the finish are in one frame" — and this function
     * asked only the first half, so a station that framed the group beautifully
     * on an approach where the gate was off the edge of the screen scored a
     * full point. Measured on seed 40's shipped site: at 110 m before the line
     * the crowd was the SUBJECT of the frame, seven figures at 109 px, and the
     * gate registered zero pixels; at 60 m the gate filled the right third at
     * 54,683 px and the crowd was zero. The only overlap over four run-ins was
     * 240–120 m out with the gate a 16–75 px speck at the frame edge.
     *
     * Scored as a minimum rather than as a veto for the reason the quarter-point
     * exists above — a station that half-frames both should still beat one that
     * frames neither. What refuses a site outright is `tally.both`, which counts
     * only the stations where both are properly in shot. */
    if (gateS !== null) {
      const gateIn = gateInShot(field, blockers, gateS,
        s - back - CROWD_BOOM, cache) ? 1 : 0.25;
      station = Math.min(station, gateIn);
      if (station >= 1) both++;
    }
    seen += station;
  }
  if (tally) tally.both = both;
  return seen;
}

/* Is the group in the picture, as opposed to merely unobstructed?
 *
 * These are two different questions and the whole finish defect turns on the
 * difference. crowdSeen marches a sightline and reports what is in the way;
 * it has nothing to say about where the lens is pointing. Measured on the
 * build this replaces (tools/zzseen.mjs, ablation), seed 40's finish group
 * read ray 8/8 and pixels 0/8 at twenty-four metres, with zero drift between
 * the two instruments' eye points — not occluded, not there. The road had
 * turned and taken the camera with it while the group stayed on the shoulder
 * it was placed on, and every sightline to it was perfectly clear off the
 * left edge of the frame.
 *
 * The chase camera looks along the road, so the road's own tangent is the
 * bearing to beat. Half of the horizontal field is about 44 degrees at 16:9;
 * this wants a good margin inside that, because a group hard against the
 * frame edge is a group leaving it. */
const CROWD_BEARING = Math.cos(44 * Math.PI / 180);

function crowdInFrame(field, s, back, at) {
  const s0 = s - back - CROWD_BOOM;
  if (s0 < 0) return true;
  const lens = field.track.frameAt(s0).pos;
  const car = field.track.frameAt(s - back).pos;
  /* Where the lens looks is where the car is, not where the road points. On a
     switchback the two are tens of degrees apart, and using the tangent at the
     lens station threw away seed 22's best finish spot — one the ablation had
     already shown at 6 of 6 across the whole approach. */
  const fx = car.x - lens.x, fz = car.z - lens.z;
  const flen = Math.hypot(fx, fz);
  const dx = at.x - lens.x, dz = at.z - lens.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-3 || flen < 1e-3) return true;
  return (dx * fx + dz * fz) / (len * flen) > CROWD_BEARING;
}

/* How high up the arch a driver reads it, in metres above the centreline. The
   gate is 7.6 m to the top of its beam; five is the middle of the opening,
   which is a fair thing to ask a sightline about — the very top of it is the
   most generous point on the whole structure and the road surface the least. */
const GATE_READ_M = 5;

const _gateAt = new THREE.Vector3();
const _gateFrom = new THREE.Vector3();

/**
 * Is the finish arch itself in shot from a lens at station `s0`?
 *
 * A function of the LENS station alone: the car is one boom ahead of it and the
 * aim follows the car. So it is memoised on that, which turns the five stations
 * of every candidate in the search window into about a hundred and sixty rays
 * for the whole search rather than one per candidate per station.
 *
 * A RAY and not only a bearing, and that is the second half of D1. On seed 40
 * the bearing is not the binding constraint — measured at native resolution
 * (tools/zwseat.mjs) the arch reads 0 px at 60 m before the line and 166 px at
 * 20 m, and a bearing test passes it at both, because what is wrong at 60 m is
 * that the mountain is in the way. A gate term without occlusion scores the
 * shipped seed 40 site 4 of 5 "with the gate in the same frame" while the frame
 * it is scoring contains no gate at all; that is measured, not hypothetical,
 * because the first cut of this fix did exactly that.
 */
function gateInShot(field, blockers, gateS, s0, cache) {
  const key = Math.round(s0);
  const had = cache.get(key);
  if (had !== undefined) return had;
  const track = field.track;
  const fg = track.frameAt(gateS);
  _gateAt.copy(fg.pos).addScaledVector(fg.up, GATE_READ_M);
  const lens = track.frameAt(s0).pos;
  const car = track.frameAt(s0 + CROWD_BOOM).pos;
  const fx = car.x - lens.x, fz = car.z - lens.z;
  const dx = _gateAt.x - lens.x, dz = _gateAt.z - lens.z;
  const flen = Math.hypot(fx, fz), len = Math.hypot(dx, dz);
  let ok = len < 1e-3 || flen < 1e-3
    || (dx * fx + dz * fz) / (len * flen) > CROWD_BEARING;
  if (ok && blockers && blockers.length) {
    _gateFrom.set(lens.x, lens.y + EDGE_DROP + CROWD_LENS_HIGH, lens.z);
    ok = rayClear(blockers, _gateFrom, _gateAt);
  }
  cache.set(key, ok);
  return ok;
}

/* ------------------------------------------------------------------ */
/*  One real ray, against the meshes the frame actually draws          */
/* ------------------------------------------------------------------ */

/**
 * Why this exists at all, when there is already a sightline test.
 *
 * `crowdSeen` marches the terrain as a HEIGHT FIELD — one y per (station,
 * offset) — and that is not what the drawn world is. Where the road doubles
 * back on itself, or a landform sheet folds over the shoulder it also forms,
 * a vertical line crosses the same mesh twice and a height field can only
 * report one of them. `drawnGroundY` faithfully reports the LOWER crossing,
 * because that is the ground a spectator stands on; the sightline is stopped
 * by the UPPER one, and there is no rung on any ladder in this file that can
 * see it.
 *
 * Measured, two sites, both of which the model liked and the frame did not:
 *
 *   seed 40 s=4150  model 4 of 5, and 0 px at all 19 stations from 150 m out
 *                   to closest approach. A landform--1 sheet crosses the
 *                   vertical twice at every station from 4100 to 4150 and the
 *                   upper crossing stands 4.9 m over the road edge at the
 *                   kerb, against a lens at 3.9. Nothing standing anywhere on
 *                   that shoulder can be seen from the road.
 *   seed 1  s=2143  model 5 of 5, 0 px, with the hairpin's other road deck
 *                   eleven metres overhead.
 *
 * Six figures of a hundred and seventy-five placed where the player never
 * sees them, and on both seeds the invisible site was the sole occupant of
 * that seed's worst pacing hole — so the pacing measurement believed two
 * holes were closed that were not.
 *
 * No refinement of the field fixes this, because the defect is the
 * dimensionality of the field and not its accuracy. So: ask the meshes.
 * Fourteen to sixteen sites at up to five stations each is under eighty rays
 * per stage, against the tens of thousands of field lookups the scheduler
 * already spends — and it is the only test in this file that could have
 * caught either site.
 */

/* How high the lens really rides above the road edge, in metres.
 *
 * NOT `CROWD_EYE`, and the difference is the point. CROWD_EYE is 2.55 and
 * deliberately pessimistic, which is right for a gate that has to be sure a
 * group CAN be seen. This gate does the opposite job — it REFUSES a site — so
 * it has to be sure the group cannot be seen from anywhere the lens might
 * actually be, and a pessimistic eye here would throw away shoulders the real
 * camera looks straight over.
 *
 * Measured on a continuous autopilot run-in on all three seeds
 * (tools/zwlens.mjs, tools/zwseat.mjs): 3.87–3.93 m over the road edge through
 * the finish run-in, median 3.7 m over a whole lap. 3.9 is the generous end,
 * on purpose. Note that this being 1.3 m ABOVE the modelled eye is also why
 * "the eye is too low" was not the cause of either site above — correcting it
 * makes the model more optimistic, not less.
 */
const CROWD_LENS_HIGH = 3.9;

/**
 * What a sightline is allowed to pass through, by name.
 *
 * DEFAULT-BLOCK: anything drawn in the stage that is not matched here stops
 * the ray, and that direction is chosen rather than assumed. A mesh wrongly on
 * this list leaves an invisible site standing, which is the defect above and
 * is silent; a mesh wrongly left off it refuses a good site, which costs a
 * group and is written to the scheduler's own log. The failure that can be
 * seen is the better one to risk.
 *
 * Matching prunes the whole subtree, which is how the gates come off: their
 * pylons and beam are unnamed children of `gate-finish`.
 *
 *   sky, sea, backdrop      drawn behind everything and the longest ray here
 *                           is sixty metres
 *   birds, beams, rotors     animated, and two of them are not solid
 *   landmark-streams         falling water, drawn transparent
 *   grass, flowers, blazes   knee-high, see-through, and swayed in the vertex
 *                            shader — so their raycast geometry is not even
 *                            where they are drawn
 *   the crowd's own dressing `crowd-figures` is one un-expanded figure at the
 *                            model origin as far as Three's raycaster is
 *                            concerned (see that mesh's comment), so it can
 *                            only report nonsense; the barrier is built FOR
 *                            the group and the group stands behind it
 *   posts, signs, gates      all narrower than a person. One ray through a
 *                            1.2 m board is a coin toss and the thing being
 *                            judged is five people over fifteen metres of
 *                            shoulder, so a hit is not evidence the group is
 *                            hidden. The finish arch especially: it is wanted
 *                            in that frame, not treated as a wall.
 *
 * The cars are not on the list because they are not in scope — they are added
 * to the scene beside the stage, and this walks the stage.
 */
const CROWD_SEETHROUGH = new RegExp('^(?:'
  + 'sky-dome|painted-sky|sun-disc|block-clouds|ocean-bands|shore-foam'
  + '|headland-depth-\\d+|distant-mesas'
  + '|distant-bird-flocks|near-road-bird-passes|lighthouse-beams|turbine-rotors'
  + '|landmark-streams'
  + '|swaying-roadside-grass|flower-(?:heads|stems)|blaze-(?:heads|stems)'
  + '|roadside-wildflowers'
  + '|crowd-figures|crowd-barriers|trackside-crowd'
  + '|verge-markers|ramp-signs|hairpin-chevron-signs|cliff-edge-lookout-rails'
  + '|gate-(?:start|finish|bunting|chequer)'
  + '|fx-.*'
  + ')$');

/**
 * Every mesh in the stage that a sightline has to get past.
 *
 * Collected once per stage. Walked by hand rather than with `traverse` so a
 * matched name prunes its children too — see CROWD_SEETHROUGH.
 */
function crowdBlockers(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const o = stack.pop();
    if (o.name && CROWD_SEETHROUGH.test(o.name)) continue;
    if (o.isMesh) {
      const m = o.material;
      /* Glass, water and anything else drawn with blending is something you
         can see a spectator through. */
      if (!(m && !Array.isArray(m) && m.transparent)) out.push(o);
    }
    for (const c of o.children) stack.push(c);
  }
  return out;
}

const _rayCast = new THREE.Raycaster();
const _rayFrom = new THREE.Vector3();
const _rayTo = new THREE.Vector3();
const _rayDir = new THREE.Vector3();

/** Is there nothing drawn between these two points? */
function rayClear(blockers, from, to, note = null, what = '') {
  _rayDir.copy(to).sub(from);
  const dist = _rayDir.length();
  /* Too close to have anything between them, and a normalise away from a
     divide by zero. */
  if (dist < 1.5) return true;
  _rayCast.set(from, _rayDir.divideScalar(dist));
  _rayCast.near = 0.4;
  /* Stopped short of the target, so the ground the group is standing on
     cannot be counted as the thing hiding it. */
  _rayCast.far = dist - 0.5;
  const hit = _rayCast.intersectObjects(blockers, false);
  if (!hit.length) return true;
  if (note && !note.text) {
    note.text = `${hit[0].object.name || '(unnamed)'} ${hit[0].distance.toFixed(0)} m`
      + ` into a ${dist.toFixed(0)} m line${what ? ' ' + what : ''}`;
  }
  return false;
}

/**
 * Can the real lens, from anywhere on the approach, actually reach the chest?
 *
 * Cast at every station in `CROWD_BACKS` and clear if ANY of them gets
 * through, which is deliberately the same "clear at one station is enough"
 * rule `crowdSeen` uses — so this can only ever refuse a site the model
 * accepted, never accept one it refused. That one-directional property is what
 * makes it safe to add at the end of a search that has already been tuned
 * against the frame.
 *
 * Aimed at the chest of a figure standing on `drawnGroundY`, which is where
 * `addFigure` actually puts one, and not at the analytic corridor the station
 * came from. Testing a chest the build does not draw is the whole class of bug
 * this function exists to close.
 *
 * @param {THREE.Object3D[]} blockers from crowdBlockers
 * @param {{text?:string}} [note] filled in with the first thing in the way
 */
function crowdRaySees(field, blockers, s, side, u, note = null) {
  /* No meshes is not "blocked". `crowdProbe.plan()` re-runs the scheduler for
     the tools and buildEnvironment runs before there is a road to look over;
     both have to get the model's answer rather than a refusal of everything. */
  if (!blockers || !blockers.length) return true;
  field.point(s, side, u, _crowdA);
  _rayTo.set(_crowdA.x, drawnGroundY(field, s, side, u) + 0.95, _crowdA.z);
  for (const back of CROWD_BACKS) {
    const s0 = s - back - CROWD_BOOM;
    if (s0 < 4) continue;
    const fr = field.track.frameAt(s0);
    _rayFrom.set(fr.pos.x, fr.pos.y + EDGE_DROP + CROWD_LENS_HIGH, fr.pos.z);
    if (rayClear(blockers, _rayFrom, _rayTo, note, `from ${back} m back`)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  The held finish shot                                               */
/* ------------------------------------------------------------------ */

/**
 * The composition the finish crowd is actually judged in.
 *
 * The driving approach is not the only frame the finish group appears in and
 * it is no longer the important one. `src/race/ending.js` brings the car to
 * rest past the line and `Game.holdCamera` settles into a composed still of
 * the parked car under the arch, which is then held for several seconds while
 * the results card comes up — against roughly four tenths of a second per
 * approach station. A held shot pointed at the gate makes an empty verge
 * behind the line MORE exposed, not less.
 *
 * Measured, and this is the finding that moved the site rather than the model
 * (tools/zwseat.mjs, tools/zwhold.mjs, native resolution, real camera, real
 * meshes): on seeds 22 and 1 the standing places the held shot can see are
 * 16–28 m PAST the line, and on seed 22 that same band is also the best of the
 * whole approach — 42–47 samples legible with the gate in shot at 39–48 px,
 * against 12–16 for anything at or before the line. Not one candidate before
 * the line survives into the held frame on any seed.
 *
 * The old window could not reach any of it. `FINISH_TO` stopped the search 8 m
 * past the line and `LAST_S` capped every site 14 m past it, so the entire
 * band that both frames agree on was outside the search. That, and not the
 * scoring, is why no seed had a crowd in shot at the line.
 *
 * The pose, as `holdCamera` builds it. These five numbers are private to
 * main.js and are therefore copied, which is a risk taken with its eyes open:
 * `tools/zwhold.mjs` reads the real camera back off the settled frame and
 * prints station, height and lens beside the model, so a drift is one command
 * away from being seen rather than one capture away from being missed.
 */
const END_CAM_BEHIND = 26;      // metres of station the lens holds behind the car
/* ...clamped between these, and the SECOND one is against the end of the road
 * and not against the line.
 *
 * This is where the replica went stale. It used to read `[-10, +6]` metres
 * about the line, which was right when there were only 34 m of road past the
 * flag: a lens 26 m behind a car that could not get more than 34 m out never
 * needed to travel past the line, so pinning it there was faithful. The road
 * now runs 154 m past the flag and `holdCamera` clamps to `roadEnd - 8`, so
 * the lens follows the car the whole way down the run-off.
 *
 * Left as it was, the replica answered the two long rest marks with a camera
 * standing beside the finish line. Measured (.fix/kheld-BEFORE.txt), the lens
 * was 42 m out of position at the 74 m mark and 102 m out at the 134 m mark, on
 * all three seeds — so six of the twelve poses in the ensemble were scored
 * against a viewpoint that cannot occur, and scored as easy passes for a group
 * by the line that the real lens has long since driven past. */
const END_CAM_MIN_PAST_LINE = -10;
const END_CAM_ROAD_TAIL = 8;
const END_CAM_LAT = 3.0;        // metres right of the centreline
const END_CAM_HIGH = 5.5;       // metres above it, along the road's up
const END_AIM_HIGH = 7.6;       // metres above the car, which is what it looks at
/* Vertical field of the held lens, in degrees, and the aspect it is composed
   at. The ending closes the lens from the chase camera's 79 to 62 and then
   pushes to 58 over five seconds, so 62 is the widest the held shot ever is
   and using it is the conservative choice for a test that asks whether
   something is inside the frame. */
const END_FOV_V = 62;
const END_ASPECT = 16 / 9;
/* How far inside the frame edge counts as "in shot", as a fraction of it.
 *
 * Set by the push-in rather than by taste. The ending closes the lens from 62
 * degrees to 58 over five seconds, and tan(29°)/tan(31°) is 0.922 — so a chest
 * that projects 0.92 of the way to the frame edge when the shot lands is
 * exactly on the edge when the push finishes, and anything beyond that is a
 * spectator who slides out of the picture while the player watches. 0.88 is
 * that bound with a little to spare.
 *
 * A tighter margin was tried first, on the chase camera's argument that a group
 * against the frame edge is a group leaving it. It is the wrong argument here:
 * a held shot does not move, so the edge is a place a group can sit. Measured
 * on seed 22, 0.78 threw away the whole of the band the real held frame reads
 * at 39–48 px, because the group is 24–32 m past the line and the lens is
 * beside the line looking down the road — of course it is off to one side. */
const END_MARGIN = 0.88;
const END_TAN_V = Math.tan(END_FOV_V * Math.PI / 360) * END_MARGIN;
const END_TAN_H = END_TAN_V * END_ASPECT;

/* How far from the held lens a spectator can be and still be a spectator, in
 * metres.
 *
 * The cone test above asks only about direction, and that was safe while the
 * lens was pinned beside the line: everything it could see was within thirty
 * metres. Once the lens follows the car down 124 m of run-off the cone stretches
 * the length of the road and the test starts passing groups that are in shot the
 * way a hedge is in shot. Measured on seed 22 (.fix/kspan-px.txt), a station 138
 * m past the line scores a perfect 12 of 12 while the chest it is scoring stands
 * NINE pixels tall at the 10 m rest mark and ten at the 26 m mark:
 *
 *   d past line   in-cone/12    chest px at rest 10 / 26 / 74 / 134
 *          +22       4          34   42   45   16
 *          +66       8          18   20   49   29
 *         +138      12           9   10   15   37
 *
 * So the number was rising as the group got less visible, which is worse than
 * no number. 45 m is 30 px of chest at this lens (1.8 m figure, 62 deg vertical,
 * 900 px); it keeps the whole of the 34–51 px band the shipped sites read at
 * and the 39–48 px band tools/zwseat.mjs validated, and refuses everything
 * under thirty. Deliberately a plain distance and not a projected height,
 * because the ending pushes the lens in and a height would have to be quoted
 * against one moment of the push. */
const END_HELD_REACH = 45;

/* Where the car actually stops — and it is TWO numbers, not one.
 *
 * `STOP_METRES_PAST_LINE` is where the ending AIMS, and ending.js is explicit
 * that it misses: the car comes to rest well short or well long depending on
 * arrival speed against 34 m of road. `holdCamera` hangs the lens station off
 * the car's station, so that much was already scored over a range here.
 *
 * What was missing is the other axis, and it is the bigger one. `holdCamera`
 * aims at `fa.pos + fa.flatRight * p.lat + fa.up * 7.6` — the car's LATERAL is
 * in the aim. The lens sits about fifteen metres from what it looks at, so a
 * metre of lateral swings the axis of the shot by nearly four degrees against a
 * half-width of forty-five. Modelling the aim as if the car stopped on the
 * centreline is therefore not a small simplification; it is most of the error.
 *
 * Measured over ten seeds at two autopilot skills (tools/_rest.mjs, since
 * folded into tools/zwens.mjs): rest 0.9–34.0 m past the line, lateral
 * −6.1 to +5.8 m, held fov 58.0–61.9. So the pose is a two-parameter family
 * about 22 degrees wide, and a group composed against one member of it is
 * composed against nothing. Seed 1 is the demonstration: its finish group
 * scored 3 of 3 against the old centreline-only model and rendered 5,393 px in
 * a held frame that happened to stop at 8.7 m / low lateral, then 0 px in the
 * next run's held frame at 4.8 m / +5.5 m lateral. Same site, same code, one
 * number of car lateral between a finish moment and an empty verge.
 *
 * Four rest marks by three laterals. A 6x5 grid was swept first
 * (tools/zwens.mjs) and this subset ranks the window identically on all three
 * seeds while costing 12 rays per candidate instead of 30. The laterals are the
 * measured extremes and the middle, because the extremes are what a group has
 * to survive and the middle is what it will usually get. */
/* ---- and the range these four cover moved, because the road did -------------
 *
 * They were [2, 12, 22, 34]: the whole of the 34 m that used to exist past the
 * line, which is where a car could come to rest when that was all there was.
 * There are now 154 m and the ending derives its station from the arrival speed
 * instead of aiming at a constant, so the distribution is both wider and
 * bimodal. Measured with tools/zystop.mjs, fourteen seeds, where the car
 * actually came to rest past the line:
 *
 *   7, 7, 12, 13, 18, 27          the slow arrivals, 90–98 km/h
 *   70, 75, 78                    the middle, 118–140
 *   132, 133, 134, 134, 134       the fast ones, 161–190, clamped by the road
 *
 * Four marks over that, one to a cluster and the last on the clamp. Leaving the
 * old four would have scored every candidate station against poses no car can
 * reach any more — the held lens hangs off the car, so a crowd composed for a
 * car at 2–34 m is a crowd behind the camera on the seeds that stop at 134. */
const END_RESTS = [10, 26, 74, 134];
const END_LATS = [-6, 0, 6];
const END_POSES = END_RESTS.length * END_LATS.length;
/* How much of the ensemble a station has to hold to count as a composed finish
 * rather than a lucky one.
 *
 * It was two thirds, on the argument that the grid's corners are the tails of
 * the stop distribution and a group should survive most of it. That argument
 * held when the stop distribution was 34 m wide. It does not survive the road
 * growing to 154 m, and the reason is not a matter of degree.
 *
 * The held lens hangs 26 m behind the car, so it TRAVELS with the stop mark.
 * Sweeping every standable station on all three seeds against the real lens
 * (.fix/kspan-reach.txt) the run-off comes apart into three disjoint bands, and
 * the bands do not overlap anywhere:
 *
 *   station d past the line     serves            best score
 *      +12 .. +36               rest 10 and 26      4-5 of 12
 *      +42 .. +54               nothing             0 of 12
 *      +60 .. +84               rest 74             1-3 of 12
 *      +90 .. +114              nothing             0 of 12
 *     +120 .. +144              rest 134            1-3 of 12
 *
 * The dead bands are the geometry, not a gap in the sampling: at +48 the group
 * is 25 m short of legible for the near marks and six metres BEHIND the lens
 * for the 74 m mark. So the reachable maximum for any one group is five of
 * twelve, and a bar of two thirds could not be met by any station on any seed.
 * It was not being met either — it was being cleared by poses the old far clamp
 * placed beside the line, which is how seeds 22 and 1 both reported exactly
 * 8 of 12 while the real lens was 102 m away.
 *
 * A third — four of twelve — is "holds two thirds of one arrival cluster",
 * which is the most that exists to hold. Reachable on seeds 22 and 1 near the
 * gate, and correctly NOT reachable on seed 40, which has no standable shoulder
 * within 80 m of its line in either direction. */
const END_HOLD_SHARE = 1 / 3;

const _heldPos = new THREE.Vector3();
const _heldFwd = new THREE.Vector3();
const _heldRight = new THREE.Vector3();
const _heldUp = new THREE.Vector3();
const _heldTo = new THREE.Vector3();
const _heldY = new THREE.Vector3(0, 1, 0);

/**
 * The held lens and what it is aimed at, for a car resting `restPast` metres
 * past the line with lateral `carLat`.
 *
 * Checked against the camera main.js actually builds rather than trusted:
 * `tools/zwens.mjs` rebuilds this from the same five constants, drives a real
 * lap to a real stop and reports the position and axis error against the live
 * camera before it uses the replica for anything. Currently 0 m and 0°.
 */
function heldPose(track, line, restPast, carLat = 0) {
  /* Both stations bounded by `roadEnd` and not by `track.length`, because the
     course ends at the flag and the car keeps rolling: `track.length` is 34 m
     past the line and the rest marks reach 134. Clamping the CAR to the course
     put the aim 42 m and 102 m short at the two long marks — the same error as
     the lens clamp above and in the same direction, so the two hid each other
     by keeping the whole shot self-consistently in the wrong place. */
  const carS = clamp(line + restPast, 4, track.roadEnd - 2);
  const camS = clamp(line + restPast - END_CAM_BEHIND,
    line + END_CAM_MIN_PAST_LINE, track.roadEnd - END_CAM_ROAD_TAIL);
  const fc = track.frameAt(camS);
  const pos = fc.pos.clone()
    .addScaledVector(fc.flatRight, END_CAM_LAT)
    .addScaledVector(fc.up, END_CAM_HIGH);
  const fa = track.frameAt(carS);
  const aim = fa.pos.clone()
    .addScaledVector(fa.flatRight, carLat)
    .addScaledVector(fa.up, END_AIM_HIGH);
  return { pos, aim };
}

/**
 * Is a point inside the held frame?
 *
 * The camera's own basis rather than a bearing against the road tangent, which
 * is what `crowdInFrame` can afford: the held lens is aimed nearly eight
 * metres above a car twenty-six metres away, so its axis is several degrees
 * off horizontal and the vertical extent of the frame is a real constraint —
 * the bottom of it meets the ground about eleven metres in front of the lens.
 */
function inHeldFrame(pose, at) {
  _heldFwd.copy(pose.aim).sub(pose.pos);
  const d = _heldFwd.length();
  if (d < 1e-3) return false;
  _heldFwd.divideScalar(d);
  _heldRight.crossVectors(_heldFwd, _heldY);
  if (_heldRight.lengthSq() < 1e-6) return false;
  _heldRight.normalize();
  _heldUp.crossVectors(_heldRight, _heldFwd).normalize();
  _heldTo.copy(at).sub(pose.pos);
  const z = _heldTo.dot(_heldFwd);
  /* Behind the lens, or close enough to it to be the lens. */
  if (z < 3) return false;
  /* ...and near enough to read as a person rather than as texture.
     See END_HELD_REACH — a cone test alone counts a nine-pixel smudge. */
  if (_heldTo.lengthSq() > END_HELD_REACH * END_HELD_REACH) return false;
  return Math.abs(_heldTo.dot(_heldRight)) <= END_TAN_H * z
    && Math.abs(_heldTo.dot(_heldUp)) <= END_TAN_V * z;
}

/**
 * How many of the plausible held poses have this group in shot and unhidden.
 *
 * 0 to END_POSES. Uses the real meshes for the occlusion half when they exist,
 * for the same reason `crowdRaySees` does: the held lens is five and a half
 * metres up and looking along the road, which is exactly the geometry a
 * single-valued height field gets wrong.
 */
function crowdHeldScore(field, blockers, s, side, u, line, hits = null) {
  const track = field.track;
  field.point(s, side, u, _crowdA);
  _heldPos.set(_crowdA.x, drawnGroundY(field, s, side, u) + 0.95, _crowdA.z);
  let n = 0;
  for (const rest of END_RESTS) {
    for (const lat of END_LATS) {
      const pose = heldPose(track, line, rest, lat);
      if (!inHeldFrame(pose, _heldPos)) { hits?.push({ rest, lat, ok: 0, why: 'frame' }); continue; }
      if (blockers && blockers.length
        && !rayClear(blockers, pose.pos, _heldPos)) {
        hits?.push({ rest, lat, ok: 0, why: 'blocked' });
        continue;
      }
      hits?.push({ rest, lat, ok: 1, why: '' });
      n++;
    }
  }
  return n;
}
/** ...and whether that is enough of them to call the shot composed. */
function heldEnough(n) { return n >= END_POSES * END_HOLD_SHARE; }

/* Where the finish gate stands is `track.gateS`, published by the Track.
 *
 * It is 22 m PAST the line, not 12 m short of it, and the difference has cost
 * this file two rounds. `FINISH_FROM`/`FINISH_TO` below were documented as
 * metres before the line and applied to `L`, so a window written as "the
 * brief's L−90 … L−20" actually ran from 56 m before the line to 8 m past it —
 * and every conclusion drawn about "the run-in" was drawn about a different
 * stretch of road from the one intended. Both bounds are now measured from the
 * line, which is the thing the player crosses, and the gate has a name.
 *
 * The offset itself no longer lives here, and that is the round-4 change: it
 * was `L - 12` against the end of the road, and the road now runs 120 m past
 * the flag. See the station convention in world/track.js. */

/* The window `pickFinish` searches, as metres either side of the LINE.
 *
 * The head of it is where it was — 56 m before the line is the old L−90. The
 * tail is the change, and it is the whole of D1.
 *
 * It used to stop 8 m past the line, and every site was additionally capped 14
 * m past it by `LAST_S`. Measured with the real camera and the real meshes on
 * all three seeds (tools/zwseat.mjs, tools/zwhold.mjs), the standing places
 * that can actually see the finish AND be seen at it are 16–28 m past the
 * line: on seed 22 that band reads 42–47 legible samples with the gate in shot
 * at 39–48 px and is in the held ending frame, against 12–16 samples and no
 * held frame for anything at or before the line, and on seed 1 nothing before
 * the line survives into the held frame at all. The old window could not offer
 * a single metre of it. That is why no seed crossed the line with a crowd in
 * shot — not the scoring, which was also wrong, but the search bound.
 *
 * `place` then slides up to 24 m either way from the station picked here and is
 * deliberately NOT held to this window, which was checked rather than assumed.
 * Holding it was tried, on the grounds that one limit honoured by two searches
 * is this project's own rule; measured on seed 40 (tools/zqfinframe.mjs), it
 * moved the group from s=5008 to s=5032 and cost most of the crowd: the
 * footprint over the seven approach stations fell from 974–12995 px to 146–538,
 * and the tallest figure from 35–156 px to 25–45 — under the 80–125 px the
 * readability critic passed. The window's edge is a search bound, not a fact
 * about the mountain. What the slide IS held to is `FINISH_LAST_BACK`, which is
 * a fact about the mountain. */
const FINISH_BEFORE = 56;
const FINISH_AFTER = 26;

/* The last station the finish group may stand on, as metres short of the end of
 * the road — and it is the finish's alone.
 *
 * Every other site stops at `LAST_S` = L − 20, and that bound is about a group
 * of six spread over fifteen metres having road left to stand beside. The
 * finish is the one site where the last twenty metres are the point: the arch
 * is at L − 12 and the held camera is aimed over it. Eight metres is what is
 * left after the group's forward member, which stands about 11 m past the site
 * station, and every figure is still gated individually by `crowdStand`, so a
 * shoulder that runs out simply builds fewer people rather than building them
 * on air. */
const FINISH_LAST_BACK = 8;

/* What a fully composed held shot is worth against the driving approach,
 * measured in approach stations — so five is parity with a perfect 5/5 run-in.
 *
 * The approach stations are about four tenths of a second each at racing speed.
 * The held shot is a single composed frame that stands for several seconds
 * while the results card comes up, and it is the last thing anybody sees. If
 * anything this under-prices it; pricing it at parity means a site cannot be
 * chosen for the held shot alone unless the approach has nothing better to
 * offer, which is the conservative direction for a change this size.
 *
 * Scored as a SHARE of the pose ensemble and not as a count, so the number of
 * poses sampled can change without silently re-weighting the finish against
 * every other site. That coupling is exactly what broke when the ensemble grew
 * from three to twelve. */
const HELD_WORTH = 5;
const heldWorth = (held) => (held / END_POSES) * HELD_WORTH;

function pickFinish(field, track, coast, L, blockers = null, log = null,
                    gateCache = new Map()) {
  const gate = track.gateS;
  const line = track.finishS;
  /* Still measured back from `L` — the end of the RACE — and not from the end
     of the pavement, which is now a hundred and twenty metres further on. The
     bound is about a group of six having the arch beside it, so it belongs to
     the finish assembly's datum; run-off is not somewhere a crowd stands.
     It lands on exactly `line + FINISH_AFTER`, as it did before this pass, so
     the search window is unchanged to the metre. */
  const lastS = L - FINISH_LAST_BACK;
  /* `best` only ever holds a spot that delivers the actual requirement — the
     crowd and the gate in ONE frame somewhere, or the crowd in the held shot.
     `any` holds the best spot that merely stands up and can be seen, and it
     exists so that a stage whose run-in cannot do it still gets a finish crowd
     and a line in the log saying so, rather than a silent slide to a spot that
     satisfies neither. That silent slide is what shipped last round. */
  let full = null, best = null, any = null;
  for (let s = line - FINISH_BEFORE; s <= Math.min(line + FINISH_AFTER, lastS); s += 2) {
    const sea = coast.seaSideAt(s);
    /* Inland first, as every other site on this stage does it: the seaward
       shoulder is a cliff lip for most of the descent. */
    for (const side of [...new Set([-sea, sea].filter(Boolean))]) {
      const u = crowdStand(field, s, side);
      if (u === null) continue;
      const tally = { both: 0 };
      const seen = crowdSightScore(field, s, side, u, gate, tally,
        blockers, gateCache);
      const held = crowdHeldScore(field, blockers, s, side, u, line);
      if (!seen && !held) continue;
      /* Four points a station, four points a held pose, against a twentieth of
         a point per metre away from the gate. So one more station or one more
         pose in view is always worth more than the whole eighty metres of
         window, and the distance to the gate only ever separates spots that
         are framed equally well.
       
         ABS, and the sign is not a detail: the window now reaches past the
         gate, and `gate - s` unsigned turned every metre beyond it into a
         BONUS. A group forty metres down the road from the arch would have
         out-scored one standing under it. */
      const score = (seen + heldWorth(held)) * 4
        - Math.abs(gate - s) * CROWD_GATE_RATE * 4;
      const cand = { s, side, u, seen, both: tally.both, held, score };
      if (!any || score > any.score) any = cand;
      /* Two thirds of the ensemble and not one pose of it. One pose was the
         first cut and it is the same mistake as scoring the group without the
         gate, one level down: seed 1's site cleared a single modelled pose,
         rendered 5,393 px in the held frame of a run that stopped where that
         pose said, and 0 px in the next run. A finish that depends on where the
         car happens to halt is not a composed finish. */
      if (tally.both >= 1 || heldEnough(held)) {
        if (!best || score > best.score) best = cand;
      }
      /* And a tier above that, for a station that satisfies BOTH frames rather
         than trading one off against the other. Scored candidates alone put
         seed 1 at 18 m past the line with 3.5/5 of the approach and 7 of 12 held
         poses, beating a station 8 m further on with 8 of 12 — a station that
         cleared the composition bar losing to one that did not, by four tenths
         of a point of run-in. A bar that the ranking is allowed to trade away is
         not a bar. */
      if (tally.both >= 1 && heldEnough(held)) {
        if (!full || score > full.score) full = cand;
      }
    }
  }
  if (log) {
    const p = full || best || any;
    if (!p) {
      log.push('finish: no station in the window has standable, visible shoulder'
        + ' on either side — the stage ships without a finish crowd');
    } else if (!best) {
      log.push('finish: NOTHING in the window puts the crowd and the gate in one'
        + ` frame or in the held shot. Best available is s=${p.s.toFixed(0)}`
        + ` side ${p.side}, ${p.seen}/5 of the approach, 0 with the gate,`
        + ' 0 held poses — reported rather than presented as a finish');
    } else {
      log.push(`finish: s=${p.s.toFixed(0)} side ${p.side} — ${p.seen}/5 of the`
        + ` approach, ${p.both}/5 with the gate in the same frame,`
        + ` ${p.held}/${END_POSES} held poses,`
        /* Signed, because the window now reaches past the line and "-22 m
           short of the line" is a sentence nobody can read at a glance. */
        + ` ${Math.abs(line - p.s).toFixed(0)} m`
        + ` ${p.s > line ? 'past' : 'short of'} the line`);
      /* And every way the winner falls short, named. "The best station in the
         window" and "a finish moment" are not the same claim, and the difference
         is invisible in a line that only reports the winner — which is how a
         group 98 m from the line shipped as a finish. Each shortfall says which
         of the two frames it is about, because they have different causes and
         only one of them is fixable from this file. */
      const short = [];
      if (line - p.s > 40) {
        short.push(`the group is ${(line - p.s).toFixed(0)} m short of the line`
          + ' — no shoulder nearer to it can be both stood on and seen, and'
          + ' nothing in this file can move it closer');
      }
      if (p.both < 2) {
        short.push(`the crowd and the arch share only ${p.both} of 5 approach`
          + ' frames, so the run-in shows one or the other');
      }
      if (!heldEnough(p.held)) {
        short.push(`the held ending shot keeps the group in ${p.held} of`
          + ` ${END_POSES} poses, under the ${(END_HOLD_SHARE * 100).toFixed(0)}%`
          + ' the composition needs, so whether it is in that frame depends on'
          + ' where the car happens to stop');
      }
      for (const why of short) log.push('finish: FALLS SHORT — ' + why);
    }
  }
  return full || best || any;
}

function crowdSites(track, field, coast, r, log = null,
                    blockers = field.crowdBlockers || null) {
  const L = track.length;
  const line = track.finishS;
  const want = [];
  /* One cache for the whole stage: whether the arch is in shot from a given lens
     station is a fact about the road, so `pickFinish` and every slide `place`
     tries are asking the same question and there is no reason to pay twice. */
  const gateCache = new Map();

  /* The finish, first and unconditionally: it is the one spot in the brief
     that cannot move, and it is the last thing anybody sees. */
  const fin = pickFinish(field, track, coast, L, blockers, log, gateCache);
  want.push({
    kind: 'finish', rank: 0, cheer: true, size: 6,
    s: fin ? fin.s : L - 38,
    outside: fin ? fin.side : -coast.seaSideAt(L - 38),
    /* The two things that make this site the FINISH and not just a site, both
       carried on the candidate because `place` re-opens the search and has to
       score it the same way `pickFinish` did. `line` is what the held ending
       camera hangs off; `lastS` is how much closer to the end of the road this
       one site is allowed to stand. */
    line,
    lastS: L - FINISH_LAST_BACK,
    /* And how far down the road a MEMBER of the group may stand, which is the
       bound the figure loop clamps to. */
    standS: L - 2,
    /* The finish carries its gate with it, because the station `pickFinish`
       chose is not the last word on where the group ends up: `place` re-opens
       the search over ±24 m to find footing a group fits on, and it scores
       that search on sightline alone. So the one preference that makes this
       site the FINISH crowd rather than a crowd — that it be near the line —
       was weighed carefully and then discarded a few lines later. Measured on
       seed 40: pickFinish chose s=5036 and place sledged it to 5012, 94 m
       short of a line at 5106, for a fractional gain in run-in.

       Both halves now price a metre against the same thing — a station of
       run-in per eighty metres — and that phrasing is deliberate, because the
       two functions do NOT score in the same units. pickFinish pays 4 points
       a station, place pays 1. Copying pickFinish's 0.05 per metre straight
       across made the pull five times too strong and was caught on the frame
       before it got any further: seed 40's group moved to s=5032 and went
       from 196 px tall at ten metres to 44, a spot the model rated 4 of 5 and
       the ablation rated a twentieth of the footprint. One rate, converted at
       each end, so the pair cannot drift. */
    gateS: track.gateS,
    /* And the third thing, for the same reason as the other two: whether the
       station `pickFinish` settled on was one that holds the group in the held
       ending shot across the stop range, so that the slide cannot quietly trade
       that away either.
     *
       Measured on seed 1 with the ensemble model in and this floor out:
       pickFinish chose s=5590, 8 of 12 poses, and `place` slid to 5582 with 7 of
       12 — under the bar — for four tenths of a station of run-in. Exactly the
       shape of the gate-distance bug above, in a different currency, which is
       why the fix is the same shape: carry the requirement onto the candidate. */
    heldFloor: fin && heldEnough(fin.held) ? fin.held : 0,
  });

  /* Ramp landings, longest flight first — the biggest jump gets the cheer
     squad, which is the brief's "after big jumps". Placed eight metres past
     the touchdown so the group is what the car comes down towards rather than
     something it has already overflown. */
  const ramps = (track.ramps || []).slice().sort((a, b) => b.dist - a.dist);
  ramps.forEach((ramp, k) => want.push({
    kind: 'ramp landing', s: ramp.land + 8, rank: 1 + k * 0.01,
    cheer: k === 0, size: k === 0 ? 3 : 4 + (k % 2),
    outside: 0,
  }));

  /* Corners, tightest first, on the outside — where a spectator can see the
     whole corner and a car can not arrive in their lap. Eighteen metres past
     the exit, which is where the driver's eyes already are on the way out. */
  const corners = trackCorners(track);
  corners.forEach((c, k) => want.push({
    kind: c.radius < 42 ? 'hairpin exit' : 'turn exit',
    s: c.exit + 18, rank: 2 + k * 0.01,
    /* Not `radius < 42 && k === 0`, which spent the cheerleaders on the
       tightest corner FOUND rather than the tightest corner PLACED — and on
       seed 22 the tightest corner does not place, so the hairpin exit the
       brief names by name got an ordinary crowd and the squad was never
       built at all. Decided below, once it is known who is standing where. */
    cheer: false,
    size: 3 + (k % 4),
    outside: -c.sign,
    radius: c.radius,
  }));

  const clock = crowdClock(track);
  /* Eighteen, and the number is a budget rather than a target: the pacing pass
     spends it worst-hole-first and stops when no hole is over the limit, so on
     a stage with even terrain it is never reached. The prescription said eight,
     which is one more than the stage this replaces had, and eight is not enough
     to close a seventy-second hole on a lap with six of them — seed 40 ran out
     of budget at fourteen with a standable, visible shoulder still unused below
     the hairpin. The ceiling that matters is triangles, and it is not close:
     eighteen sites is about 75 figures, 1600 of the 4,850 spare. */
  const MAX_SITES = 18;
  /* Ten seconds apart at the least, and never more than twenty-eight with
     nobody. Both in seconds and both against the same clock, which is the
     whole point: the rule these replace was four hundred METRES with a
     justification written in seconds, and through the switchback third —
     where the road is slowest and 400 m is nineteen seconds, not eight — it
     left 1332 m between the hairpin and the next turn exit and seventy-two
     seconds of empty road with it.

     Twenty-eight and not the thirty-five the target is written in, because
     these seconds are measured between site STATIONS and the target is about
     the SCREEN. A group is legible for three to five seconds as it comes up,
     and it stops being legible before the car is abeam of it — so the hole a
     player sees runs from the end of one group's window to the start of the
     next, and it is longer than the station-to-station figure by about six
     seconds. Measured on seed 22 against tools/zzcadence.mjs: the schedule's
     45.3 s between s=1532 and s=2121 read 51.75 s on the frame, and its 39.6
     s between s=2647 and s=3555 read 32 s. So the threshold is set below the
     target by the size of that offset rather than at it. This is the same
     mistake D3 exists to fix, one level up: a bound in one unit and the
     thing it is bounding measured in another. */
  const APART_S = 10;
  /* The same floor for the pacing pass, and lower, because the two passes are
     answering different questions and ten seconds is only the right answer to
     one of them.
   *
     The ranking's job is to spread a surplus of good corners over a lap, so its
     spacing is a preference and ten seconds of it costs nothing — there is
     always another corner. The pacing pass runs when there is no surplus: it is
     looking at a stretch of road with nobody on it and asking whether anybody
     can stand anywhere inside it at all. Refusing the only ground in a hole
     because it sits close to the group at the hole's mouth does not buy spacing,
     it buys emptiness.

     Seed 40 is the case, measured at 2 m over both shoulders (tools/zwhole.mjs):
     between s=1000 and s=1480 there are 83 stations that anybody can stand on
     and that both the analytic sightline and a real ray reach — and every one of
     them lies between 1000 and 1152, which is t=33.3–42.6 s, all of it inside
     ten seconds of the site already standing at s=990 (t=32.8 s). From 1152 to
     1480 nothing stands on either side at any stride. So the choice on that seed
     is a group about six seconds after its neighbour or 45.5 s of empty road,
     and there is no third option anywhere in 480 m.

     Six seconds and not five: it is the number the pass's own edge rule has
     always used to decide a hole is two moments rather than one (`edge` below is
     APART_S * 0.5), so a fill at six is consistent with what this pass already
     believed about its own output rather than a new licence. Measured either way
     over the three audited seeds, worst hole and the share of the lap with a
     legible group on it (tools/zzcadence.mjs, 12 px bar):

       ten seconds everywhere    24.25 / 28.5  / 45.5 s   26.9 / 24.1 / 19.3 %
       six in the pacing pass    22.75 / 29.25 / 36.5 s   30.1 / 25.9 / 25.1 %

     Six is better on five of the six numbers and the one it loses, seed 1's
     worst hole, loses 0.75 s. The pacing pass is the only caller; the ranking
     still spreads on ten. */
  const APART_FILL_S = 6;
  const GAP_S = 28;

  const sites = [];
  const tried = new Set();
  /* Every station the model liked and the meshes did not, kept so that a
     refusal is a measurement rather than a silence. Two of these were shipped
     last round as filled pacing holes. */
  const refused = new Map();
  /* A candidate is a corner exit or a ramp landing, which is a statement
     about where the DRIVER will be looking and not a claim that the shoulder
     is any good at that exact metre. So each one is allowed to slide a little
     to find footing, and among everything that stands up the spot that most
     of the run-in can see wins.
     
     Both halves matter. Taking the first side that passed put seed 40's turn
     exit at 4503 on the inside of the corner, where a berm three metres over
     the group's heads hid four of the five; scoring the sides moves it back
     out. And the slide is what gets seed 22 a hairpin at all — the exit
     station itself has a 0.95 dropness on one side and no sightline on the
     other, and there is good ground sixteen metres up the road. */
  const SLIDE = [0, 8, -8, 16, -16, 24, -24];
  /* The last station a group may stand on, once for both tests below.
   *
   * They were written separately as L-25 in the option search and L-20 in the
   * firmness test, which is this project's pinned-partner defect in its purest
   * form: two expressions of one limit, guessed five metres apart. The five
   * metres were not free. Seed 22's finish shoulder holds nobody until s=5572
   * and then holds a group from 5572 to 5588 — so the only station whose whole
   * squeezed stance fits on real ground is 5576, the option search capped at
   * 5573 could not offer it, and the seed lost its finish crowd. That crowd is
   * the one placement the brief says cannot move. */
  const LAST_S = L - 20;
  const place = (c) => {
    const sea = coast.seaSideAt(c.s);
    /* The outside of the corner if there is one, then the inland shoulder,
       then whatever is left. Inland before seaward because the seaward
       shoulder is a cliff lip for most of this stage and a crowd standing
       past it is a crowd standing in the air. */
    const order = [...new Set([c.outside, -sea, sea].filter(Boolean))];
    /* The finish reaches closer to the end of the road than anything else, for
       the reason set out at FINISH_LAST_BACK. Two bounds and not one: `lastS`
       is how far down the road the SITE may sit, `standLast` is how far a member
       of its group may. They were the same number for every other site and
       collapsing them cost the finish its best station on two seeds — the
       firmness test below samples the stance up to 10 m past the centre, so a
       site standing at the site cap could never be firm at all and the search
       fell back eight metres and two thirds of its held-shot score. */
    const lastS = c.lastS ?? LAST_S;
    const standLast = c.standS ?? LAST_S;
    const options = [];
    for (const ds of SLIDE) {
      const s = c.s + ds;
      if (s < 90 || s > lastS) continue;
      for (const side of order) {
        const u = crowdStand(field, s, side);
        if (u === null) continue;
        const tally = { both: 0 };
        const seen = crowdSightScore(field, s, side, u, c.gateS ?? null, tally,
          blockers, gateCache);
        /* And, for the finish, the held ending pose — scored here and not only
           in `pickFinish`, because this search is allowed to move the group
           twenty-four metres and would otherwise undo the only reason the
           station was chosen. The file already learned this once about the
           distance to the gate; the held shot is the same lesson with a
           different frame. */
        const held = c.line === undefined ? 0
          : crowdHeldScore(field, blockers, s, side, u, c.line);
        /* One clear station out of the five is the bar, and raising it to two
           was tried and measured: identical cadence on all three seeds, to the
           quarter-second, because every spot that gets placed already scores
           two or better. A tighter gate that changes nothing it can be shown
           on is a tighter gate that will surprise somebody on the seed nobody
           measured, so the bar stays where the evidence puts it. */
        if (!seen && !held) continue;
        /* Half a station's worth of preference for the outside of the corner
           and for not having moved, so those only ever break ties between
           spots the driver can see equally well. */
        const score = seen
          + heldWorth(held)
          + (side === c.outside ? 0.5 : 0)
          - Math.abs(ds) * 0.02
          - (c.gateS ? Math.abs(c.gateS - s) * CROWD_GATE_RATE : 0);
        options.push({
          s, side, u, seen, both: tally.both, held, score,
          keeps: c.heldFloor ? (held >= c.heldFloor ? 1 : 0) : 1,
        });
      }
    }
    /* Options that keep the held composition first, and only then by score.
       A tier and not a bonus, because a bonus is a number somebody will later
       find is too small on a seed nobody measured. */
    options.sort((a, b) => b.keeps - a.keeps || b.score - a.score);
    /* And then the part a single station cannot tell you: whether a GROUP
       fits. A site is validated at its centre but built as five or six people
       spread over fifteen metres of road, each of whom is placed by the same
       gates at their own station — so a spot whose window is one metre wide
       passes here and then builds nobody. Three of seed 40's eight sites
       vanished exactly that way, between the scheduler counting them and the
       figure loop dropping them, which is how that seed ended up with one
       hundred and fifty-nine seconds of empty road.
    
       Sampled over the span the two groups at a site actually occupy: the
       squad six metres back of centre, the crowd seven forward. */
    const STANCE = [-8, -4, 4, 10];
    /* Both arrangements, because the builder has both. When the wide spread
       will not fit, buildCrowd falls back to a squeezed one at 0.34 of the
       spacing and stands the group close — so a shoulder that holds four
       people over five metres IS a site, and testing only the wide spread
       refuses it on behalf of a builder that would have coped.

       This mattered as soon as the cliff cap above stopped refusing shelves:
       seed 22's switchback third turns out to have three of them, at s=1560,
       1668 and 1928, each about a chain long between a berm and a four-metre
       drop. Every one stands up at its own station and fails at ±8 m, so the
       wide test alone threw all three away and with them the 45.3 s hole they
       had just closed. The scheduler counting a different arrangement from
       the one the lap builds is the same disagreement this block was written
       to fix, pointing the other way. */
    const SQUEEZE = 0.34;
    let best = null;
    for (const o of options) {
      /* The schedule's minimum spacing, enforced HERE, on the station that is
         actually going to be used.
       *
         It was only ever consulted in `byRank`, against the station a
         candidate WANTED — and `place` then slides up to twenty-four metres
         from that, and the gap-filling pass calls `place` directly and never
         consulted it at all. Both routes shipped sites inside the limit:
         measured spacings of 6.88 s, 6.03 s and 5.49 s against a stated
         minimum of ten. The comment in the gap-filling pass asserting that
         "`place` enforces it a few lines down" was describing code that did
         not exist, which is worse than no comment, because two later decisions
         were taken on the strength of it. */
      if (!clearOf(o.s, c.apart ?? APART_S)) continue;
      let fits = false;
      for (const scale of [1, SQUEEZE]) {
        let firm = 1;
        for (const dz of STANCE) {
          const s = o.s + dz * scale;
          if (s > 40 && s < standLast && crowdStand(field, s, o.side) !== null) firm++;
        }
        if (firm >= 4) { fits = true; break; }
      }
      if (!fits) continue;
      /* And last, because it is the only test here that costs a raycast: does
         the lens REALLY reach them? Everything above is a model of the terrain
         and two of the sites it passed last round were invisible in every frame
         of the game. See crowdRaySees. Last in the order so it is asked once
         per site rather than once per candidate offset — fourteen to sixteen
         rays a stage instead of a hundred. */
      const note = {};
      if (!crowdRaySees(field, blockers, o.s, o.side, o.u, note)) {
        /* Keyed, because the gap-filling pass re-walks the same hole up to
           three times and would otherwise report one bad shoulder four times
           over — which reads as four separate problems. */
        refused.set(`${o.s.toFixed(0)}/${o.side}`,
          `${c.kind} at s=${o.s.toFixed(0)} side ${o.side}:`
          + ` model says ${o.seen}/5, the meshes say nothing — ${note.text}`);
        continue;
      }
      best = o;
      break;
    }
    if (!best) return null;
    field.point(best.s, best.side, best.u, _crowdA);
    const f = track.frameAt(best.s);
    return {
      ...c, s: best.s, side: best.side, u: best.u, seen: best.seen,
      both: best.both, held: best.held,
      /* Against the road edge, which is what a spectator is looking over,
         not against the crowned centreline half a metre above it. */
      rise: _crowdA.y - (f.pos.y + EDGE_DROP),
      at: _crowdA.clone(),
    };
  };
  const clearOf = (s, apart = APART_S) =>
    sites.every(p => Math.abs(clock(p.s) - clock(s)) >= apart);

  want.sort((a, b) => a.rank - b.rank);
  const say = (c, verdict) => log?.push(
    `${c.kind.padEnd(14)} wants s=${c.s.toFixed(0)} (t=${clock(c.s).toFixed(1)} s) — ${verdict}`);
  const byRank = (budget) => {
    for (const c of want) {
      if (tried.has(c)) continue;
      if (sites.length >= budget) { say(c, 'no budget left'); continue; }
      if (!clearOf(c.s)) { say(c, 'too close in time to a site already taken'); continue; }
      tried.add(c);
      const site = place(c);
      if (site) {
        sites.push(site);
        say(c, `PLACED at s=${site.s.toFixed(0)} side ${site.side}, ${site.seen}/5`
          + ` of the run-in${site.held ? `, ${site.held}/${END_POSES} held poses` : ''}`);
      } else say(c, 'nowhere along it that anybody can both stand and be seen');
    }
  };
  /* Two of the eight held back from the ranking. Rank says which corners are
     worth watching from and nothing at all about where they are, and on this
     stage the good ones cluster: left to itself the ranking spent all eight
     on seed 22 before reaching the turn exits at s=807 and s=966, which are
     the only things standing in the first sixty-eight seconds of the race.
     The reserve is what the pacing pass gets to spend. */
  byRank(MAX_SITES - 2);

  /* Second pass: the holes the first one leaves.
   *
   * Ranking by how interesting a corner is says nothing about where the
   * corners are, and on a stage whose tight third is all in one place the
   * top-ranked seven can sit in two clusters with a minute of nothing
   * between them. So having taken the best spots, go back and fill: find the
   * longest stretch with nobody, and put the best unused candidate that
   * falls inside it there. Repeat until nothing is over the limit or the
   * budget is gone.
   *
   * The start-line squad is a real group the player really sees, so it bounds
   * the first stretch even though it is built separately; and the end of the
   * lap bounds the last one, because a gap you are still in when you cross
   * the line is a gap. */
  for (let guard = 0; guard < 3 * MAX_SITES && sites.length < MAX_SITES; guard++) {
    sites.sort((a, b) => a.s - b.s);
    const marks = [clock(CROWD_START_S), ...sites.map(p => clock(p.s)), clock.lap];
    const gaps = [];
    for (let i = 1; i < marks.length; i++) {
      if (marks[i] - marks[i - 1] > GAP_S) {
        gaps.push({ lo: marks[i - 1], hi: marks[i], dt: marks[i] - marks[i - 1] });
      }
    }
    /* Every gap over the limit, worst first, and not just the worst one. The
       first cut of this stopped at the first hole it could not fill, which on
       seed 22 was the opening stretch — so the two forty-odd second holes
       further down the mountain were never even looked at. */
    gaps.sort((a, b) => b.dt - a.dt);
    let filled = null;
    for (const gp of gaps) {
      /* Room to breathe at each end, but not the full spacing: the whole
         reason this pass exists is that the alternative is a minute of empty
         road, and a group six seconds after another one is still two
         separate moments. Half, and never more than a third of the hole. */
      const edge = Math.min(APART_S * 0.5, gp.dt / 3);
      for (const c of want) {
        if (tried.has(c)) continue;
        const tc = clock(c.s);
        if (tc < gp.lo + edge || tc > gp.hi - edge) continue;
        /* Before spending the candidate, not only inside `place`: `tried` is
           permanent, so a corner offered to a hole it is too close to a
           neighbour for would be marked used and never looked at again. */
        if (!clearOf(c.s, APART_FILL_S)) continue;
        tried.add(c);
        filled = place({ ...c, apart: APART_FILL_S });
        if (filled) break;
      }
      /* And when the ranking has nothing left inside the hole, stop asking the
         ranking. A corner exit is where the driver is already looking, which
         is why they are ranked first and why they are tried first — but the
         list of them is finite and it is not distributed. On seed 22 the
         opening fifty-six seconds contained exactly two ranked candidates and
         neither of them could be stood on, so the hole was reported and left,
         three times over, while the schedule still had budget in hand.
         Nothing about the brief says a group may only stand at a corner. So
         walk the hole and look for ground.

           Coarser than the ranked pass on purpose: twenty metres between probes
           and only the two shoulders, because `place` will slide the winner up
         to twenty-four metres anyway and this is a search for a stretch of
         standable, visible shoulder rather than for a metre of it. The middle
         of the hole is worth about a station of sightline, so a mediocre spot
         in the centre beats a good one against the edge — the point of the
         pass is the pacing, not the spot. */
      if (!filled) {
        const mid = (gp.lo + gp.hi) * 0.5;
        const found = [];
        /* A narrower keep-out than the ranked pass uses. Both margins exist to
           stop a filler landing on the shoulder of the group that bounds the
           hole, where it buys a second of pacing and reads as one long site —
           but the ranked pass is choosing between corners it likes and can
           afford to be fussy, and this one is running because there were no
           corners at all. On seed 40 the only standable, visible station in
           the forty-second hole below the hairpin was s=2180, six seconds from
           the far end of it, and the ranked pass's twelve-second margin threw
           it away and left the whole hole. The floor is still the schedule's
           own minimum spacing, which `place` enforces a few lines down and
           which is the rule that actually means "not on top of each other";
           this is only about not wasting the pass's one shot on an edge when a
           middle exists, and the score below already prefers the middle. */
        const walkEdge = Math.min(APART_S * 0.6, gp.dt * 0.15);
        /* Eight metres between probes and not twenty.
        
           Twenty was chosen on the reasoning quoted above — that `place` will
           slide the winner up to twenty-four metres anyway, so the walk only
           has to find the neighbourhood. That holds while standable shoulder
           comes in stretches longer than the stride, and on the parts of this
           mountain that have a shoulder at all it does. It fails exactly where
           this pass is needed: through seed 22's switchback third the only
           ground there is comes in shelves about a chain long between a berm
           and a four-metre drop, at s=1560, 1668 and 1928, and a twenty-metre
           stride walks over all three — 1660 and 1680 are both refused, 1668
           stands. The slide cannot rescue what the walk never sampled, because
           the slide starts from a station the walk accepted and there were
           none. Measured, the stride alone is worth 24 s of the 46 s hole. */
        for (let s = 120; s < L - 25; s += 8) {
          const tc = clock(s);
          if (tc < gp.lo + walkEdge || tc > gp.hi - walkEdge) continue;
          const sea = coast.seaSideAt(s);
          for (const side of [...new Set([-sea, sea].filter(Boolean))]) {
            if (!clearOf(s, APART_FILL_S)) continue;
            const u = crowdStand(field, s, side);
            if (u === null) continue;
            const seen = crowdSightScore(field, s, side, u);
            if (seen < 2) continue;
            found.push({ s, side, score: seen - Math.abs(tc - mid) / Math.max(gp.dt, 1) });
          }
        }
        /* Down the list and not just the head of it. `place` asks a question
           this scan does not — whether five or six people fit along the
           shoulder, not whether one does — and on seed 22 the best-scoring
           station in the opening hole was a one-metre window that answered
           yes to the first question and no to the second. Six tries is about
           two hundred metres of shoulder either side of the best spot. */
        found.sort((a, b) => b.score - a.score);
        for (const pick of found.slice(0, 6)) {
          filled = place({
            kind: 'roadside', s: pick.s, rank: 9, cheer: false,
            size: 3 + (sites.length % 3), outside: pick.side,
            apart: APART_FILL_S,
          });
          if (filled) {
            log?.push(`gap fill: ${gp.dt.toFixed(0)} s hole at t=${gp.lo.toFixed(0)}`
              + `–${gp.hi.toFixed(0)} s — no corner left inside it, walked the hole`
              + ` and stood a group on the shoulder at s=${filled.s.toFixed(0)}`);
            break;
          }
        }
        if (!filled) {
          log?.push(`gap fill: walked t=${gp.lo.toFixed(0)}–${gp.hi.toFixed(0)} s,`
            + ` ${found.length} station(s) anybody could stand on and be seen from,`
            + ' none with room for a group');
        }
      }
      if (filled) {
        if (filled.kind !== 'roadside') {
          log?.push(`gap fill: ${gp.dt.toFixed(0)} s hole at t=${gp.lo.toFixed(0)}`
            + `–${gp.hi.toFixed(0)} s takes ${filled.kind} at s=${filled.s.toFixed(0)}`);
        }
        break;
      }
      log?.push(`gap fill: ${gp.dt.toFixed(0)} s hole at t=${gp.lo.toFixed(0)}`
        + `–${gp.hi.toFixed(0)} s — nothing stands up inside it, corner or shoulder`);
    }
    if (!filled) break;
    sites.push(filled);
  }

  /* Anything the pacing pass did not need goes back to the ranking. */
  byRank(MAX_SITES);

  sites.sort((a, b) => a.s - b.s);
  /* The cheer squad at the hairpin, decided now that the placements are
     known. First hairpin down the road rather than the tightest one, so the
     squad is met early and the finish is not the only one. */
  const hairpin = sites.find(p => p.kind === 'hairpin exit');
  if (hairpin) hairpin.cheer = true;
  if (log && refused.size) {
    log.push(`refused by the real ray (${refused.size} distinct stations):`);
    for (const why of refused.values()) log.push('  ' + why);
  }
  return sites;
}

/**
 * Everything the crowd is, as one instanced draw and a handful of rails.
 *
 * Built after `pickRamps` rather than inside `buildEnvironment`, because two
 * of the four kinds of spot the brief names are facts about the ramps and the
 * ramps are chosen from the finished terrain. See buildStage in main.js.
 *
 * @param {Track} track   with `ramps` already chosen
 * @param {THREE.Object3D} env  the built environment, for its CoastField
 */
export function buildCrowd(track, env, { seed = track.seed } = {}) {
  const field = env.userData?.field;
  if (!field) return null;
  const coast = field.coast;
  const r = rand(rng(seed * 613 + 71));
  const group = new THREE.Group();
  group.name = 'trackside-crowd';

  const uniforms = {
    uTime: { value: 0 },
    uCar: { value: new THREE.Vector3(0, -1e4, 0) },
    uReactFar: { value: CROWD_REACT_FAR },
    uReactNear: { value: CROWD_REACT_NEAR },
    uStagger: { value: CROWD_STAGGER },
    /* The countdown's one hook into the crowd, and deliberately one: it is in
       the shared uniform block, so the beauty pass and the ink prepass read
       the same value on the same frame and the outlines belong to the arms
       they are drawn around. Zero unless a countdown is running, which is the
       state every capture and every tool sees. */
    uHype: { value: 0 },
    /* One loop, four frames: down, up, coming down, settling. The hop and the
       arm sway both read off this, so the arms are highest on the frame the
       feet leave the ground. */
    uBounce: { value: new THREE.Vector4(0.0, 1.0, 0.42, 0.12) },
    /* Rest angles per pose, as an outward raise from hanging.
       cheer / flag / sit / pom. */
    uArmRestL: { value: new THREE.Vector4(2.15, 2.50, 0.55, 2.00) },
    uArmRestR: { value: new THREE.Vector4(2.15, 0.35, 1.35, 2.00) },
    uArmSwing: { value: new THREE.Vector4(0.25, 0.35, 0.15, 0.75) },
    uArmUp: { value: 2.55 },
    uSwingSpan: { value: 0.32 },
    uSitAngle: { value: 1.32 },
    uHop: { value: 0.17 },
  };
  const { beauty, prepass } = crowdMaterials(uniforms);

  const figures = [];
  const rails = [];
  /* The meshes the frame draws, collected before the scheduler runs because the
     scheduler is what asks about them.
   *
     Rooted at `env.parent` — the stage group main.js builds — and not at `env`:
     the road, both berms, the guard rail and both gates are SIBLINGS of the
     environment, added to the stage before this function is called, and a
     sightline down a shoulder meets more of them than it meets terrain. Rooting
     at `env` would have tested against the landform alone. Falls back to `env`
     so a caller that builds the crowd on a bare environment still gets the
     model's answer rather than a refusal of everything.
   *
     Left on the field so `crowdProbe.plan()` re-runs the scheduler against
     exactly the same list, rather than against a second copy of the rule that
     could disagree with this one. */
  field.crowdBlockers = crowdBlockers(env.parent ?? env);
  const sites = crowdSites(track, field, coast, r);
  let kit = 0;

  const addFigure = (s, side, back, pose, look, height) => {
    /* The jittered standing distance first, and the site's own if that finds
       nothing. The jitter is there to stop a group reading as bollards, which
       is worth a metre and a half of stagger and is not worth losing a person
       over — and losing people is not free, because a site that ends up with
       one is dropped whole. */
    const uHere = crowdStand(field, s, side, back) ?? crowdStand(field, s, side);
    if (uHere === null) return false;
    field.point(s, side, uHere, _crowdA);
    if (insideTunnelRock(_crowdA)) return false;
    figures.push({
      /* Sunk a few centimetres. There is no contact shadow under a billboard
         — the shadow map cannot run this vertex shader — so the one thing
         that has to be right is that the feet are not hovering, and on
         uneven ground the cheapest way to guarantee that is to bury them.

         Which requires knowing where the ground IS. The height comes off
         `drawnGroundY` — the shoulder the frame draws — and not off the
         analytic `field.point` that x and z come from, because the two differ
         by more than a body height on a fifth of this stage and burying six
         centimetres into a surface nobody renders is what D2 looked like. */
      origin: new THREE.Vector3(_crowdA.x,
        drawnGroundY(field, s, side, uHere) - 0.06, _crowdA.z),
      height,
      girth: r.f(0.90, 1.10),
      pose,
      phase: r.f(0, 1),
      rate: pose === POSE_POM ? r.f(1.55, 1.85) : r.f(0.95, 1.30),
      ...look,
    });
    return true;
  };

  for (const site of sites) {
    const squad = site.cheer;
    const size = clamp(squad ? r.i(2, 3) : r.i(3, 6), 2, 6);
    site.groups = [];
    const built = [];

    /* A squad on its own everywhere except the finish, which is the one place
       on the stage that should look busy: a cheer squad on the line and a
       crowd standing behind it. Everywhere else a squad and a crowd at the
       same spot is two groups' worth of people for one group's worth of
       moment, and the brief's whole point is that there should be few of
       them. */
    const plans = squad
      ? (site.kind === 'finish'
        ? [{ cheer: true, n: size }, { cheer: false, n: r.i(3, 5) }]
        : [{ cheer: true, n: size }])
      : [{ cheer: false, n: size }];

    for (const plan of plans) {
      const kitIx = plan.cheer ? kit++ % CHEER_KITS.length : -1;
      const kitCol = plan.cheer ? CHEER_KITS[kitIx] : null;
      const sitters = !plan.cheer && r.chance(0.45);
      const half = (plan.n - 1) * 0.5;
      let n = 0, railA = null, railB = null;
      /* Two goes at the group, and the second one closes it up.
       *
       * A site is chosen at a station and built as five or six people spread
       * over fifteen metres of it, so a spot whose good ground is narrow gets
       * scheduled and then builds nobody — and a site that builds fewer than
       * two is thrown away entirely a few lines further down. Silently: the
       * scheduler counts eight, the lap ships six, and the pacing pass that
       * placed two of them for the express purpose of closing a seventy
       * second hole never learns that both were discarded. Measured on seed
       * 22 that was exactly what happened.
       *
       * So when the wide arrangement fails, put the group back on the one
       * station that was actually validated and stand them close. A tighter
       * group is a small cost; no group is the defect. */
      const mark = figures.length;
      for (let attempt = 0; attempt < 2 && n < 2; attempt++) {
        if (attempt) { figures.length = mark; n = 0; railA = railB = null; }
        const squeeze = attempt ? 0.34 : 1;
        let lastPose = -1, runLen = 0;
        /* And a ceiling on how many of the group may share a pose at all.
           The run rule below forbids a third in a row and cannot see totals,
           so it passes "cheer flag cheer cheer flag cheer" — four of six
           waving the same arm, alternated. Half the group, rounded up: two of
           three, three of six. Sitters are exempt because sitting is chosen
           by position along the rail rather than by the coin, and the squad
           is uniform by design. */
        const used = [0, 0, 0, 0];
        const poseCap = Math.ceil(plan.n / 2);
        /* Two groups at one site stand apart, not interleaved: the squad on
           the near side of the spot and the crowd behind it. */
        const centre = site.s + (plan.cheer ? -6 : 7) * squeeze;
        for (let k = 0; k < plan.n; k++) {
          const height = r.f(CROWD_HEIGHT[0], CROWD_HEIGHT[1]);
          const width = height * r.f(0.90, 1.10);
          /* Spacing in the figure's own unit, so a group of tall spectators
             spreads exactly as far as a group of short ones relative to
             themselves and neither ever grows into the other. */
          const gap = width * FIG_GAP;
          const ds = ((k - half) * gap * 1.9 + r.f(-0.3, 0.3) * gap) * squeeze;
          /* Depth jitter in metres, like the standing distance it perturbs. A
             group standing on a ruled line reads as bollards; a metre and a
             half of stagger reads as people. */
          const back = CROWD_STAND + r.f(-1.1, 1.6);
          /* The finish reaches further down the road than any other site, so
             the clamp has to as well or the group is folded back on itself:
             every figure past the bound lands on the SAME station and a spread
             of six becomes a stack of three. See FINISH_LAST_BACK. */
          const s = clamp(centre + ds, 40, site.standS ?? track.length - 20);
          /* Pose, with a rule against a third in a row.
           *
           * An independent coin per person is the right model for a crowd and
           * the wrong one for a group of four, which is what these are: at
           * p = 0.42 a run of four identical poses turns up about once every
           * six groups, and the shipped stage had two sites that were
           * four-of-a-kind out of seven. A crowd of four people all waving
           * the same arm reads as one asset repeated, which is exactly what
           * it is. Two the same is a coincidence and stays allowed; the third
           * is forced the other way. */
          let pose = plan.cheer
            ? POSE_POM
            : sitters && k % 2 === 0 ? POSE_SIT
              : r.chance(0.42) ? POSE_FLAG : POSE_CHEER;
          if (!plan.cheer && pose !== POSE_SIT && pose === lastPose && runLen >= 2) {
            pose = pose === POSE_FLAG ? POSE_CHEER : POSE_FLAG;
          }
          if (!plan.cheer && pose !== POSE_SIT && used[pose] >= poseCap) {
            pose = pose === POSE_FLAG ? POSE_CHEER : POSE_FLAG;
          }
          used[pose]++;
          runLen = pose === lastPose ? runLen + 1 : 1;
          lastPose = pose;
          const look = plan.cheer
            ? {
              skin: r.pick(CROWD_SKIN), shirt: kitCol.shirt,
              legs: kitCol.legs, item: kitCol.item, hair: kitCol.hair,
              itemL: 0.95, itemR: 0.95, armL: 1, armR: 1,
            }
            : pose === POSE_FLAG
              ? {
                skin: r.pick(CROWD_SKIN), shirt: r.pick(CROWD_SHIRTS),
                legs: r.pick(CROWD_LEGS), item: r.pick(CROWD_FLAGS), hair: r.pick(CROWD_HAIR),
                /* One long arm and a big cloth on it: the arm is the pole. A
                   separate pole quad would cost two more triangles and read as
                   a stick at every distance this is actually seen from. */
                itemL: 2.3, itemR: 0, armL: 1.45, armR: 1,
              }
              : {
                skin: r.pick(CROWD_SKIN), shirt: r.pick(CROWD_SHIRTS),
                legs: r.pick(CROWD_LEGS), item: 0xffffff, hair: r.pick(CROWD_HAIR),
                itemL: 0, itemR: 0, armL: 1, armR: 1,
              };
          if (pose === POSE_SIT) {
            const uHere = crowdStand(field, s, site.side, back)
              ?? crowdStand(field, s, site.side);
            if (uHere === null) continue;
            field.point(s, site.side, uHere, _crowdA);
            const seat = _crowdA.clone();
            // The drawn shoulder, as everywhere else — see addFigure.
            seat.y = drawnGroundY(field, s, site.side, uHere)
              + CROWD_RAIL_H - FIG_HIP_Y * height;
            figures.push({
              origin: seat, height, girth: width / height, pose,
              phase: r.f(0, 1), rate: r.f(0.85, 1.15), ...look,
            });
            /* The rail they are sitting on, as two points to run it between.
               Built from where the sitters actually ended up, so it cannot end
               up beside them. */
            field.point(s, site.side, uHere, _crowdA);
            _crowdA.y = drawnGroundY(field, s, site.side, uHere);
            if (!railA) railA = _crowdA.clone();
            railB = _crowdA.clone();
            n++;
            continue;
          }
          if (addFigure(s, site.side, back, pose, look,
            plan.cheer ? height * 0.98 : height)) n++;
        }
        if (n >= 2 || attempt) {
          if (railA && railB && railA.distanceTo(railB) > 1.2) rails.push([railA, railB]);
          if (n) built.push({ cheer: plan.cheer, n, s: centre });
        }
      }
    }
    site.groups = built;
  }
  /* A site whose ground turned out not to hold anybody is not a site, and a
     site holding one person is not a group. Both drop off the list so the
     count that gets reported is the count that is standing there. */
  for (let i = sites.length - 1; i >= 0; i--) {
    if (sites[i].groups.reduce((a, b) => a + b.n, 0) < 2) sites.splice(i, 1);
  }

  /* The start line. The player is set down at s = 34 with the chase lens
     about ten metres behind that, so the start gate at s = 10 is behind the
     camera and anything placed at it is placed out of shot. The squad goes
     down the road instead, at the far end of the grid, where it is in the
     frame the driver is looking at while the lights are on them. */
  const startS = CROWD_START_S;
  {
    const sea = coast.seaSideAt(startS);
    let side = -sea, u = crowdStand(field, startS, side);
    if (u === null) { side = sea; u = crowdStand(field, startS, side); }
    if (u !== null) {
      const kitCol = CHEER_KITS[kit++ % CHEER_KITS.length];
      let n = 0;
      /* Offset half a slot — about 1.2 m — down the road from centred.

         The row runs along the road, so its near end subtends the widest angle
         from the grid lens and is the figure nearest the right frame edge.
         Centred on 46 that figure stood at 43.5 and on seed 1 the group's box
         ran to x=1599 of 1599: one of three cheerleaders cut in half in the
         shot the player looks at longest in the game. Measured at 1600x900 over
         the three seeds, right box edge and group footprint:

           centred      1572 / 1599(cut) / 1585 px      6952 / 9352 / 8085 px
           +half slot   1520 /      1557 / 1535         6203 / 8200 / 7048
           +full slot   1475 /      1512 / 1494         5483 / 7232 / 6412

         Half a slot is the cheapest offset that leaves all three whole on all
         three seeds — 42 px of margin at worst — and it costs 11–13% of the
         footprint where a full slot costs 21–23%. The station stays inside the
         band the ablation behind CROWD_START_S measured, so the squad is not
         being moved far, only off the edge. */
      for (let k = 0; k < 3; k++) {
        const height = r.f(CROWD_HEIGHT[0], CROWD_HEIGHT[1]) * 0.98;
        const gap = height * FIG_GAP;
        if (addFigure(startS + (k - 0.5) * gap * 2.1, side, CROWD_STAND + r.f(-0.8, 1.2),
          POSE_POM, {
            skin: r.pick(CROWD_SKIN), shirt: kitCol.shirt, legs: kitCol.legs,
            item: kitCol.item, hair: kitCol.hair,
            itemL: 0.95, itemR: 0.95, armL: 1, armR: 1,
          }, height)) n++;
      }
      if (n) {
        sites.unshift({
          kind: 'start line', s: startS, side, u, cheer: true,
          rise: 0, at: figures[figures.length - 1].origin.clone(),
          groups: [{ cheer: true, n, s: startS }],
        });
      }
    }
  }

  if (!figures.length) return null;

  const geometry = crowdFigureGeometry();
  const n = figures.length;
  const place = new Float32Array(n * 4), body = new Float32Array(n * 4);
  const limb = new Float32Array(n * 4), tone = new Float32Array(n * 4);
  const hairTone = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const f = figures[i];
    place[i * 4] = f.origin.x; place[i * 4 + 1] = f.origin.y;
    place[i * 4 + 2] = f.origin.z; place[i * 4 + 3] = f.height;
    body[i * 4] = f.height * f.girth; body[i * 4 + 1] = f.pose;
    body[i * 4 + 2] = f.phase; body[i * 4 + 3] = f.rate;
    limb[i * 4] = f.itemL; limb[i * 4 + 1] = f.itemR;
    limb[i * 4 + 2] = f.armL; limb[i * 4 + 3] = f.armR;
    tone[i * 4] = f.skin; tone[i * 4 + 1] = f.shirt;
    tone[i * 4 + 2] = f.legs; tone[i * 4 + 3] = f.item;
    hairTone[i] = f.hair;
  }
  const attr = (array, n2) => new THREE.InstancedBufferAttribute(array, n2);
  geometry.setAttribute('aPlace', attr(place, 4));
  geometry.setAttribute('aBody', attr(body, 4));
  geometry.setAttribute('aLimb', attr(limb, 4));
  geometry.setAttribute('aTone', attr(tone, 4));
  geometry.setAttribute('aHairTone', attr(hairTone, 1));
  geometry.instanceCount = n;

  const mesh = new THREE.Mesh(geometry, beauty);
  mesh.name = 'crowd-figures';
  /* The geometry is one figure at the origin and the positions live in an
     instance attribute, so three's own bounds are a metre wide and in the
     wrong place. There is nothing to cull here anyway: one draw of a
     thousand triangles. */
  mesh.frustumCulled = false;
  /* Both off, and both for the same reason as the override pass: three's
     depth material does not run the vertex shader above, so a casting crowd
     would cast from wherever the source quad happens to lie. */
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  /* The expansion is in world coordinates, so the mesh must stay at the
     identity. Anything that reparents this under a transformed node has to
     put the transform into aOrigin instead. */
  mesh.matrixAutoUpdate = false;
  skipOverridePass(mesh);
  registerPrepassMesh(mesh, prepass);
  group.add(mesh);

  if (rails.length) {
    const parts = [];
    for (const [a, b] of rails) {
      const lift = new THREE.Vector3(0, CROWD_RAIL_H, 0);
      addCylinderBetween(parts, a.clone().add(lift), b.clone().add(lift), 0.075, 0x6f5a3e, 4);
      for (const p of [a, b]) {
        addCylinderBetween(parts, p, p.clone().add(lift), 0.085, 0x4a3b28, 4);
      }
    }
    const railMesh = new THREE.Mesh(
      finishGeometry(mergeGeometries(parts)),
      environmentCelMaterial({ color: 0xffffff, vertexColors: true, flatShading: true }),
    );
    parts.forEach(p => p.dispose());
    railMesh.name = 'crowd-barriers';
    railMesh.castShadow = railMesh.receiveShadow = true;
    group.add(railMesh);
  }

  /* Triangles, and the rails are counted off their INDEX and not their
     positions. `mergeGeometries` returns indexed geometry for the cylinders,
     where a shared vertex is drawn by several triangles — so position.count/3
     is not the triangle count, it is the vertex count divided by three, and it
     under-reported the rails by 60–120 triangles on every seed. The figures
     are the other case and stay as they are: crowdFigureGeometry is
     deliberately non-indexed (see its comment) so for them the two agree. */
  const railGeo = group.getObjectByName('crowd-barriers')?.geometry;
  const tris = (geometry.attributes.position.count / 3) * n
    + (railGeo
      ? (railGeo.index ? railGeo.index.count : railGeo.attributes.position.count) / 3
      : 0);

  group.userData.crowd = {
    /* Called once per simulation frame from Game.step, before the render, so
       both passes see one value. Not read off `performance.now()` inside
       onBeforeRender the way the grass and the turbines are: two renders of a
       static scene have to be the same image, and a probe that pins the clock
       should not have to know this file exists. */
    update(carPos, dt = 0) {
      uniforms.uTime.value += dt;
      if (carPos) uniforms.uCar.value.copy(carPos);
    },
    /* Excitement the car has not earned: the start countdown, 0..1. Same
       clock discipline as update — set from Game.step, never from a render
       callback. */
    setHype(v) { uniforms.uHype.value = clamp(v, 0, 1); },
    uniforms,
    sites,
    figures: n,
    triangles: tris,
    dispose() { unregisterPrepassMesh(mesh); },
  };
  return group;
}

export function buildEnvironment(track, { seed = track.seed, sunDirection = new THREE.Vector3(-1, 1, 0.6) } = {}) {
  const root = new THREE.Group();
  root.name = 'environment';
  const bounds = trackBounds(track);
  const coast = new Coastline(track, seed, bounds);
  const field = new CoastField(track, coast, seed);
  /* Chosen before anything is planted, because the one rule the tunnel imposes
     on the rest of the stage is that nothing may be planted inside the
     mountain. Every scatter builder answers to this through `makeInstances`. */
  const tunnel = pickTunnel(field, track, coast, seed);
  field.tunnel = tunnel;
  /* The EARLY bore — the user-facing complaint this round answers is that the
     opening of the stage is under-served, and on the default seed the first
     event of any kind was at 65% of the track. Same scan, different window:
     the first ~30% of the stage, a shorter bore (the opening should read as
     an appetiser, and every metre is ~7.3 triangles against a ceiling the
     worst seed sits 1,839 under), rails excluded (nothing else keeps a
     guardrail out of a bore), and clear of the main tunnel. Where the
     opening has no 34 m of unbroken rock this returns null and the seed
     ships with the one tunnel it always had. */
  /* The bore yields to the stage's best early jump band. The ramps are the
     primary ask and are sited later (they need this environment for sun and
     boom rays), so the geometric half of their scan runs here first and the
     tunnel keeps off the winner — on the default seed the two best sites in
     the opening are the same hundred metres of road. */
  /* The span is the early-ramp veto's own exclusion, inverted: a bore ending
     56 m before the foot or starting 106 m past the lip leaves the band
     sitable (see the inBore margins in earlyRampRows), plus 2 m so the two
     strict inequalities cannot land on the same station. */
  const earlyBands = earlyRampRows(track, field, [tunnel]);
  const rampBand = earlyBands.length
    ? { s0: earlyBands[0].foot - 58, s1: earlyBands[0].lip + 108, margin: 0 }
    : null;
  const tunnel2 = pickTunnel(field, track, coast, seed, {
    sFrom: 480,
    sTo: track.length * 0.30,
    length: clamp(track.length * 0.017, 84, 110),
    salt: 29,
    rails: railWantsMirror(track),
    avoid: [tunnel, rampBand],
  });
  field.tunnel2 = tunnel2;
  setTunnelKeepout(field, [tunnel, tunnel2]);
  /* The generator's own view of the terrain, for the offline audits in tools/.
     Nothing at run time reads it, and a placement bug is otherwise only
     visible as a pixel in a capture. */
  root.userData.field = field;
  root.userData.tunnel = tunnel;
  root.userData.tunnel2 = tunnel2;
  /* The station ladder itself, so an audit can ask how high the skyline is
     without re-deriving it from a scrambled non-indexed vertex buffer. */
  root.userData.landformPoint = (s, side, station, out = new THREE.Vector3()) =>
    landformPoint(field, s, side, station, out);
  root.userData.crestPoint = (s, side, out = new THREE.Vector3()) =>
    crestPoint(field, s, side, out);
  /* The crowd's own placement predicates, for the offline audits in tools/.
     Exposed rather than reimplemented because a probe that re-derives them is
     grading its own copy: the point of tools/zqoracle.mjs is to hold THIS
     model against pixels, and it cannot do that from the outside. */
  root.userData.crowdProbe = {
    stand: (s, side, metres) => crowdStand(field, s, side, metres),
    why: (s, side, metres) => {
      const trace = [];
      const u = crowdStand(field, s, side, metres, trace);
      const seen = u === null ? null : CROWD_BACKS.map(back => {
        const profile = field.profile(s, side);
        field.point(s, side, u, _crowdA);
        const note = {};
        const ok = crowdSeen(field, s, side, u * profile.wallDist,
          _crowdA.y + 0.95, CROWD_EYE, [back], note);
        return `${back}m:${ok ? 'clear' : 'blocked by ' + note.text}`;
      });
      return { u, trace, seen };
    },
    seen: (s, side, out, chestY, eye = CROWD_EYE, backs) =>
      crowdSeen(field, s, side, out, chestY, eye, backs),
    /* Whether the lens is POINTING at a place, as distinct from having an
       unobstructed line to it — the two questions crowdInFrame exists to keep
       apart. Exposed for both the group and the finish gate, because D1 is
       whether the two are in ONE frame and a probe that re-derived the bearing
       test would be grading its own copy of it. */
    inFrame: (s, back, x, y, z) => crowdInFrame(field, s, back, { x, y, z }),
    backs: CROWD_BACKS.slice(),
    boom: CROWD_BOOM,
    eye: CROWD_EYE,
    point: (s, side, u) => field.point(s, side, u, new THREE.Vector3()),
    clock: crowdClock(track),
    startS: CROWD_START_S,
    plan: () => {
      const log = [];
      crowdSites(track, field, coast, null, log);
      return log;
    },
    wallDist: (s, side) => field.profile(s, side).wallDist,
    stand_m: CROWD_STAND,
    drawnY: (s, side, u) => drawnGroundY(field, s, side, u),
    /* The three halves of the round-3 placement rule, exposed so a probe can
       certify the rule the build actually runs instead of re-deriving it and
       then grading its own copy — which is how two unsound instruments got as
       far as a verdict last round.

       `blockers` in particular is the list itself, not a description of it: a
       tool that filtered the scene by its own regex would certify a different
       set of meshes from the one `place` consults, and the disagreement would
       be invisible. */
    blockers: () => field.crowdBlockers || [],
    sight: (s, side, u) => crowdSightScore(field, s, side, u),
    raySees: (s, side, u) => {
      const note = {};
      const ok = crowdRaySees(field, field.crowdBlockers, s, side, u, note);
      return { ok, why: note.text || null };
    },
    held: (s, side, u) => crowdHeldScore(field, field.crowdBlockers, s, side, u,
      track.finishS),
    /* ...and WHICH of the poses, because "8 of 12" hides the only thing that
       matters about the ensemble now that it spans 124 m of run-off: whether a
       station serves the slow arrivals, the fast ones, or a bit of both. */
    heldWhich: (s, side, u) => {
      const hits = [];
      crowdHeldScore(field, field.crowdBlockers, s, side, u, track.finishS, hits);
      return hits;
    },
    heldPose: (rest, lat = 0) => {
      const p = heldPose(track, track.finishS, rest, lat);
      return { pos: p.pos.toArray(), aim: p.aim.toArray() };
    },
    heldRests: END_RESTS.slice(),
    heldLats: END_LATS.slice(),
    heldPoses: END_POSES,
    heldShare: END_HOLD_SHARE,
    lensHigh: CROWD_LENS_HIGH,
    line: track.finishS,
    gate: track.gateS,
  };
  root.userData.coast = {
    type: 'road-following-peninsula',
    seaDirection: [coast.sea.x, coast.sea.z],
    seaLevel: coast.seaLevel,
    seaSideAt: s => coast.seaSideAt(s),
    shoreDistanceAt: s => coast.shoreDistanceAt(s),
    waterDistanceAt: s => coast.waterDistanceAt(s),
    signedDistanceXZ: (x, z) => coast.signedDistanceXZ(x, z),
  };

  const terrainMat = environmentCelMaterial({
    vertexColors: true,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  const landformMat = environmentCelMaterial({
    vertexColors: true,
    flatShading: false,
    side: THREE.DoubleSide,
  });
  const basinMat = environmentCelMaterial({ vertexColors: true, flatShading: true });
  const rockMat = environmentCelMaterial({ color: 0xffffff, flatShading: true });
  const tunnelRockMat = environmentCelMaterial({
    color: 0xffffff, vertexColors: true, flatShading: true,
  });
  /* Unlit, because lighting it would hand the interior's whole value structure
     to a hemisphere term that has no idea it is indoors — which is precisely
     how an enclosed section of this stage previously collapsed into one bucket
     of the ladder. Double-sided rather than back-faced: the bore is a mix of
     tube walls, a flat shoulder and a kerb lip, their windings do not agree,
     and single-siding it culled the shoulder and left grass showing through
     the floor of a mountain. */
  const tunnelBoreMat = unlitCelMaterial({
    color: 0xffffff, vertexColors: true, flatShading: true,
    fog: false, side: THREE.DoubleSide,
  });
  const brushMat = unlitCelMaterial({ color: 0xffffff, flatShading: true, fog: true });
  const treeMat = unlitCelMaterial({
    color: 0xffffff, vertexColors: true, flatShading: true, fog: true,
  });
  /* Double-sided, and this is the whole of the "degenerate spike tree" defect.
     A ridge tree is two triangles crossed at a right angle, which works
     because whatever angle you view it from, one of the two is close to
     face-on. Drawn single-sided that guarantee is gone: half the yaws cull the
     plane that was doing the work and leave the other one edge-on, so the tree
     collapses to a near-zero-width sliver on a trunk. It looked like a scale
     bug — the review reasonably read it as one and asked for the low end of
     the width distribution to be clamped — but no scale clamp can fix it,
     because the geometry was never thin. Two thousand of these are drawn and
     turning off back-face culling costs nothing: the same triangles are
     rasterised either way. */
  const ridgeTreeMat = unlitCelMaterial({
    color: 0xffffff, vertexColors: true, flatShading: true, fog: true,
    side: THREE.DoubleSide,
  });
  const flowerMat = environmentCelMaterial({
    color: 0xffffff, flatShading: true, side: THREE.DoubleSide,
  });
  const stemMat = environmentCelMaterial({
    color: 0x398147, flatShading: true, side: THREE.DoubleSide,
  });
  const grassMat = movingCelMaterial(
    { color: 0xffffff, flatShading: true, side: THREE.DoubleSide },
    'grass-wind',
    `#ifdef USE_INSTANCING
       float phase = instanceMatrix[3].x * 0.021 + instanceMatrix[3].z * 0.017;
     #else
       float phase = 0.0;
     #endif
     float bladeHeight = max(position.y, 0.0);
     transformed.x += sin(uTime * 1.15 + phase) * 0.045 * bladeHeight;
     transformed.z += cos(uTime * 0.82 + phase * 1.3) * 0.024 * bladeHeight;`,
  );
  /* The birds build their own pair of materials — a lit beauty material and an
     ink-prepass material sharing one uniform block — because the two halves
     have to share the clock OBJECT and `movingCelMaterial` mints its own. See
     birdMaterials above. */
  /* Signs and marker posts are flat panels and crossed billboards, so the same
     culling problem applies to them as to the ridge trees above. */
  const signMat = environmentCelMaterial({
    color: 0xffffff, vertexColors: true, flatShading: true, side: THREE.DoubleSide,
  });
  const railMat = environmentCelMaterial({ color: 0xffffff, vertexColors: true, flatShading: true });
  const landmarkMat = environmentCelMaterial({ vertexColors: true, flatShading: true });
  const tyreMat = environmentCelMaterial({ color: 0xffffff, vertexColors: true, flatShading: true });
  const hayMat = environmentCelMaterial({ color: 0xffffff, flatShading: true });
  const streamMat = movingCelMaterial(
    { color: 0xffffff, vertexColors: true, flatShading: true },
    'stream-flow',
    `transformed.y += sin(position.x * 0.9 + position.z * 0.7 + uTime * 2.1) * 0.045;`,
  );
  /* Blades and beam both turn about their own instance origin in the vertex
     shader off the shared clock. Five turbines and two lamps, and not one of
     them costs anything per frame on the CPU. Flat shading takes its normals
     from the derivative of the view position, so the rotated geometry lights
     correctly without the normals being rotated too. */
  const rotorMat = movingCelMaterial(
    { color: 0xffffff, vertexColors: true, flatShading: true, side: THREE.DoubleSide },
    'turbine-spin',
    `float spin = uTime * 0.62
       #ifdef USE_INSTANCING
         + instanceMatrix[3].x * 0.31 + instanceMatrix[3].z * 0.27
       #endif
       ;
     float cs = cos(spin), sn = sin(spin);
     transformed.xy = mat2(cs, sn, -sn, cs) * transformed.xy;`,
  );
  const beamMat = movingCelMaterial(
    {
      color: 0xffeec2, transparent: true, opacity: 0.15, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    },
    'lighthouse-sweep',
    `float sweep = uTime * 0.55
       #ifdef USE_INSTANCING
         + instanceMatrix[3].x * 0.05
       #endif
       ;
     float cs = cos(sweep), sn = sin(sweep);
     transformed.xz = mat2(cs, sn, -sn, cs) * transformed.xz;`,
    true,
  );
  const headlandMats = [
    unlitCelMaterial({ color: 0xffffff, vertexColors: true, flatShading: true, fog: false }),
    unlitCelMaterial({ color: 0xffffff, vertexColors: true, flatShading: true, fog: false }),
    unlitCelMaterial({ color: 0xffffff, vertexColors: true, flatShading: true, fog: false }),
  ];

  root.add(buildSky(track, seed, bounds, sunDirection));

  const basin = new THREE.Mesh(buildBasin(track, seed, bounds, coast), basinMat);
  basin.name = 'basin-floor';
  basin.receiveShadow = true;
  root.add(basin);
  root.add(buildOcean(coast, seed));
  root.add(buildFoam(coast, seed));

  const corridor = [];
  for (const side of [-1, 1]) {
    const terrain = new THREE.Mesh(buildLandform(field, side), landformMat);
    terrain.name = `landform-${side}`;
    terrain.receiveShadow = true;
    terrain.castShadow = true;
    root.add(terrain);
    corridor.push(terrain);
  }

  if (tunnel) {
    root.add(buildTunnel(field, tunnel, seed, {
      bore: tunnelBoreMat, rock: tunnelRockMat,
    }));
  }
  /* Same builder, same materials, same mesh names — which is load-bearing:
     camcollide.js includes tunnel rock by name regex, and the outline pass
     classes are keyed the same way. A different seed salt would buy nothing;
     the noise is sampled by station, and the stations differ. */
  if (tunnel2) {
    root.add(buildTunnel(field, tunnel2, seed, {
      bore: tunnelBoreMat, rock: tunnelRockMat,
    }));
  }

  const supportParts = [-1, 1].map(side => buildRoadSupport(field, side));
  const support = new THREE.Mesh(mergeGeometries(supportParts), terrainMat);
  supportParts.forEach(geometry => geometry.dispose());
  support.name = 'road-supports';
  support.castShadow = support.receiveShadow = true;
  root.add(support);

  root.add(buildRocks(field, seed, rockMat));
  root.add(buildVegetation(field, seed, brushMat, treeMat, ridgeTreeMat));
  root.add(buildGrassPatches(field, seed, grassMat));
  root.add(buildWildflowers(field, seed, flowerMat, stemMat));
  root.add(buildRoadsideSigns(field, seed, signMat));
  root.add(buildVergeMarkers(field, seed, signMat));
  root.add(buildCliffEdgeRails(field, railMat));
  root.add(buildLandmarks(field));
  const headlands = buildHeadlands(track, seed, bounds, coast, headlandMats);
  root.add(headlands);
  /* The gates and the four coastal landmarks are already events on the route;
     the scheduler fills between them rather than on top of them. */
  headlands.userData.corridor = corridor;
  const landmarks = buildRouteLandmarks(field, seed, coast, headlands.userData, {
    solid: landmarkMat,
    water: streamMat,
    tyre: tyreMat,
    hay: hayMat,
    rotor: rotorMat,
    beam: beamMat,
    flower: flowerMat,
    stem: stemMat,
  }, [
    { kind: 'start gate', s: 10 },
    { kind: 'headland shelf', s: track.length * 0.105 },
    { kind: 'sea arch', s: track.length * 0.305 },
    { kind: 'wooded stack', s: track.length * 0.81 },
    { kind: 'finish gate', s: track.gateS },
  ]);
  root.add(landmarks);
  root.userData.schedule = landmarks.userData.schedule;
  root.userData.lapTime = landmarks.userData.lapTime;
  root.add(buildBirdFlocks(field, seed));
  root.add(buildNearBirdPasses(field, seed));
  return root;
}
