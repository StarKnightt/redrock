/* The ground under the car, marked.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 *
 * A car four metres up behind a chase camera that climbed with it is drawn in
 * the same part of the frame a car on the road is drawn in. There is a real
 * screen-space signal — the point on the road directly beneath the car runs
 * 100 to 190 px further down the frame between the road and the apex, measured
 * at every ramp on both seeds — and it reads as nothing at all, because there
 * is nothing at that point. Daylight under a car is only daylight if something
 * is holding the bottom of it.
 *
 * The car's own cast shadow cannot be that something, and this is worth stating
 * because it is the obvious candidate and it fails for a structural reason
 * rather than a tuning one. The sun sits at 29° of elevation, so a shadow is
 * thrown 1/tan(29°) — 1.78 m — sideways per metre of height, along a *world*
 * azimuth. At apex that is 6.2 to 9.6 m from the point beneath the car, and
 * which way it goes depends on the compass heading of the ramp and nothing
 * else. Measured across the six launches, the shadow's centroid sits between
 * 472 px left of the car and 245 px right of it, and at every one of them the
 * count of shadow pixels inside the car's own screen column is exactly zero.
 * One site throws a shadow four times *larger* at the apex than on the road and
 * still contributes nothing, because it is 449 px off to the left. A cue has to
 * mean the same thing twice; this one does not mean anything once.
 *
 * ── What this is ──────────────────────────────────────────────────────────────
 *
 * A plumb shadow: the car's footprint dropped straight down onto whatever is
 * underneath it, faded in over the first three quarters of a metre of height. It
 * is placed on the four wheel contact patches the effects module already
 * computes, which means it lands where the wheels would land — on the road's
 * camber, down in the dip past a lip, out on the verge if that is where the car
 * is going.
 *
 * It is a function of the car's height and of nothing else — not of ramps, not
 * of armLanding, not of proximity to a lip. That is a deliberate choice and it
 * has a measured consequence: over a full descent the mark is drawn on 8% of
 * frames, and five to six points of that is away from the three lips, on air the
 * incidental terrain gives — reaching 7.1 m on seed 40 around s = 500-750, which
 * is higher than any ramp on the stage. Anything that suppressed it there would
 * be a frame saying the car is on the ground while the simulation has it six
 * metres up, and it would pop on and off as the car neared a lip. The terrain
 * out-jumping the ramps is a known and closed finding about the stage; this
 * makes it visible rather than causing it.
 *
 * ── Why it does not read as an object ─────────────────────────────────────────
 *
 * The recurring failure on this project is effects reading as solids: boulders,
 * popcorn, polystyrene chips. The particle system answers that with an
 * invariant — a particle's value is a bounded multiple of the ground it came
 * off, and no class may name a colour. The same idea, in the strictest form
 * available, is what this is:
 *
 *   it has no colour. It is a multiply against the pixel already in the frame,
 *   so its hue is the ground's hue and its value is a fixed fraction of the
 *   ground's value, whatever the ground happens to be. It cannot be brighter
 *   than what it covers, so the "brighter than everything around it, therefore
 *   snow or foam or stone" failure is not reachable from here. And the fraction
 *   is not a taste: it is set to the ratio the sun's own cast shadows have to
 *   the surfaces they fall on, measured in the same frame by tools/zjshade.mjs.
 *   At that value the mark is not *like* a shadow, it has a shadow's exact
 *   relationship to its ground, and nothing else in this world has that.
 *
 * Two flats, not a gradient: a core and one penumbra band, with a hard edge
 * between them and a hard outer edge, both anti-aliased about a pixel. That is
 * what a hand-painted cel shadow is, and it is the difference between a shadow
 * and a hole — a hole is one flat black, and this is never black and never one
 * flat. It takes no ink: it is kept out of the normals prepass, like the skid
 * marks it is otherwise built exactly like, because an outline is what this
 * pipeline puts around things that have volume.
 *
 * The band widens and lightens with height and the core does neither, which is
 * the second read — how far up, not just that it is up — kept off the part of
 * the mark that is doing the anchoring. The convention of shrinking a drop
 * shadow away to nothing comes from cameras that cannot show the gap; here the
 * gap is the primary cue, so taking the anchor with it would remove the thing
 * the gap is measured against exactly when the gap is largest.
 *
 * ── What it is measured by ────────────────────────────────────────────────────
 *
 *   tools/zjread.mjs    the read itself, per site, against the sun's shadow as
 *                       the control candidate and the matched road frame as the
 *                       control moment
 *   tools/zjshade.mjs   the value: this mark's ratio to the ground it covers
 *                       against the sun's own, in the same frame
 *   tools/zjlift.mjs    airlift's camera sweep re-scored on the read
 *   tools/zjcost.mjs    that it moves no ink, what it costs to draw, and where
 *                       ordinary driving produces one
 *   tools/zjrival.mjs   what a followed car's mark comes to at race distances,
 *                       and a census of how often one is on screen at all
 *   tools/zjstart.mjs   that the grid, the launch and the overview produce
 *                       nothing, and that the read numbers repeat exactly
 */
import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../core/util.js';
import { skipOverridePass } from './pass.js';

/* Ring subdivisions around the outline and radially. Twenty-eight is smooth at
   the size this occupies — 115 px across and 12,000 px of frame at the apex —
   and the whole mesh is 113 vertices against one draw call and 196 triangles,
   so there is nothing to save by being clever. */
const SEGMENTS = 28;
const RINGS = 4;

/* The footprint, in metres: the car's own plan half-extents, 4.1 by 2.02.
 *
 * And a superellipse rather than an ellipse, which is the difference between
 * this reading as the car's shadow and reading as a puddle. The camera looks
 * down on the mark at about forty degrees, so the axis running away from the
 * lens is foreshortened to two thirds — and a true ellipse at the car's own
 * proportions therefore arrives on screen very close to a circle. Measured on
 * the first build: a round dark patch on the road, which is a manhole. Pushing
 * the corners out squares the silhouette off without making it longer than the
 * car is, so what survives the foreshortening is a shape with a front and a
 * back. */
const HALF_LEN = 2.05;
const HALF_WID = 1.02;
/* Superellipse exponent. 2 is an ellipse and infinity is the rectangle; 2.5 is
   a rounded rectangle with no corner sharp enough for the outer edge's
   anti-aliasing to fail on. */
const SQUARENESS = 2.5;

/* How far out the penumbra band reaches, as a multiple of the core, at no
   height and at full height. Both modest. The band is the height read and the
   core is the anchor, so the band is allowed to move and the core is not. */
const OUTER_LOW = 1.30;
const OUTER_HIGH = 1.62;
/* And the core's own scale over the same range. Nearly still, deliberately —
   see the note above about not taking the anchor away at the apex. */
const CORE_SCALE_LOW = 1.0;
const CORE_SCALE_HIGH = 0.90;

/* The height at which the mark is at its widest and faintest. Above the apex
   the lip produces (5.4 m), so no jump on the stage saturates it and the cue
   keeps a gradient all the way up. */
const HEIGHT_REF = 6.0;

/* Multiplies against the ground, in the beauty target's linear light.
 *
 * Both are rungs of the value ladder. A rung's luminance is (n/7)^3, so taking
 * lit asphalt from rung 3 down to rung 2 — where cel.js puts the sun's own
 * shadow on it — is a factor of (2/3)^3 = 0.296, and half a rung is
 * (2.5/3)^3 = 0.579. So the core is one rung down and the band is half of one,
 * which is two even steps in the space the ladder's own steps are even in.
 *
 * The algebra is not what these are set from. tools/zjshade.mjs measures the
 * per-pixel ratio the sun's cast shadow has to the surface it falls on, in the
 * composed frame, and at the launch sites it comes out at 0.50 of the covered
 * value at the tenth percentile — which is 0.303 back through the composite's
 * curve. The algebra and the measurement agree to within a per cent, which is
 * the only reason the algebra gets to be quoted at all.
 *
 * That the value is set as a *ratio* and applied as a multiply is what bounds
 * the failure this project keeps having. A multiply holds the contrast between
 * the mark and its surroundings constant wherever the mark lands: one rung, on
 * lit asphalt and in a cliff's shadow alike. Reading as a hole is a contrast
 * phenomenon — a hole is much darker than what is around it — so a layer that
 * cannot exceed one rung of local contrast cannot get there, and it does not
 * need an absolute floor to stop it. The absolute value it produces on dark
 * ground is dark, and so is everything next to it. */
const CORE_MUL = 0.296;
const BAND_MUL = 0.579;

/* How much of the band's darkening survives at full height, as the penumbra
   widens. This is the second read — how far up, rather than merely up — and it
   is carried entirely by the band. The core does not fade at all: it is one rung
   at every height, so it stays a shadow's exact value instead of drifting off
   the ladder as the car climbs, and it is still the full anchor at the apex
   where the gap it anchors is largest. */
const BAND_SOFT = 0.52;

/* Where the mark starts appearing and where it is fully in. Below the first
   figure the car is inside its own suspension travel and the mark is under its
   bodywork with nothing to show; by the second the wheels are clear of the road
   and there is a gap to hold. The band is short on purpose — the mark wants to
   be established while the car is still close to the ground, because that is the
   only moment the two are unambiguously the same object, and the gap can then
   open between things the eye has already connected. */
const RISE_LOW = 0.18;
const RISE_HIGH = 0.75;

/* Off the surface, matching the skid marks' own lift. Polygon offset does the
   rest of the work; this is for the case where the surface the patches were
   sampled on and the surface the terrain actually drew disagree by a
   centimetre across a crowned road. */
const LIFT = 0.05;

const VERT = /* glsl */`
attribute vec2 aUnit;
attribute float aFrac;

uniform vec3 uCentre;
uniform vec3 uAxisA;
uniform vec3 uAxisB;
uniform float uOuter;

varying float vR;

void main() {
  /* The ellipse is laid out in its own space and placed here rather than on the
     CPU, so a frame costs three uniforms instead of a hundred and thirteen
     vertex writes and a buffer upload. vR is the elliptical radius in units of
     the core radius, which is what both edges below are expressed in. */
  float r = aFrac * uOuter;
  vR = r;
  vec3 world = uCentre + uAxisA * (aUnit.y * r) + uAxisB * (aUnit.x * r);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
}`;

const FRAG = /* glsl */`
precision highp float;

uniform float uCore;
uniform float uBand;
uniform float uOuter;

varying float vR;

void main() {
  /* One pixel of ramp on each edge and no more. A true step() aliases against
     the ellipse's own tessellation, and anything wider is the gradient this
     look has nowhere to put. */
  float aa = max(fwidth(vR) * 1.1, 0.004);
  float inside = 1.0 - smoothstep(uOuter - aa, uOuter + aa, vR);
  if (inside <= 0.002) discard;
  float core = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, vR);
  float k = mix(uBand, uCore, core);
  /* Multiply blending: 1.0 leaves the frame alone, so the outer ramp fades to
     no darkening rather than to a colour. Nothing in this shader can produce a
     value above 1, which is the whole guarantee. */
  gl_FragColor = vec4(vec3(mix(1.0, k, inside)), 1.0);
}`;

const _fwd = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3();
const _centre = new THREE.Vector3();

export class AirMark {
  constructor(parent) {
    const verts = 1 + SEGMENTS * RINGS;
    const unit = new Float32Array(verts * 2);
    const frac = new Float32Array(verts);
    const position = new Float32Array(verts * 3);   // unused, kept for three
    const index = [];

    /* Centre, then RINGS rings of SEGMENTS. The core boundary is at radius 1
       in `vR`, and the rings are fractions of the *outer* radius, so with the
       outer between 1.30 and 1.62 the boundary always falls inside a band
       rather than on a ring edge — which is what lets fwidth anti-alias it. */
    unit[0] = 0; unit[1] = 0; frac[0] = 0;
    for (let ring = 0; ring < RINGS; ring++) {
      const f = (ring + 1) / RINGS;
      for (let s = 0; s < SEGMENTS; s++) {
        const a = (s / SEGMENTS) * Math.PI * 2;
        const v = 1 + ring * SEGMENTS + s;
        /* The superellipse in its standard parameterisation. Unit radius in
           every direction, so `vR` downstream is still a plain radius and both
           edges in the fragment shader are still circles in this space —
           the shape lives entirely in these two numbers. */
        const cs = Math.sin(a), sn = Math.cos(a);
        const k = Math.pow(
          Math.pow(Math.abs(cs), SQUARENESS) + Math.pow(Math.abs(sn), SQUARENESS),
          -1 / SQUARENESS,
        );
        unit[v * 2] = cs * k;
        unit[v * 2 + 1] = sn * k;
        frac[v] = f;
      }
    }
    for (let s = 0; s < SEGMENTS; s++) {
      const n = (s + 1) % SEGMENTS;
      index.push(0, 1 + s, 1 + n);
      for (let ring = 0; ring < RINGS - 1; ring++) {
        const a = 1 + ring * SEGMENTS + s, b = 1 + ring * SEGMENTS + n;
        const c = 1 + (ring + 1) * SEGMENTS + s, d = 1 + (ring + 1) * SEGMENTS + n;
        index.push(a, c, b, b, c, d);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('aUnit', new THREE.BufferAttribute(unit, 2));
    geometry.setAttribute('aFrac', new THREE.BufferAttribute(frac, 1));
    geometry.setIndex(index);

    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uCentre: { value: new THREE.Vector3() },
        uAxisA: { value: new THREE.Vector3(HALF_LEN, 0, 0) },
        uAxisB: { value: new THREE.Vector3(0, 0, HALF_WID) },
        uOuter: { value: OUTER_LOW },
        uCore: { value: 1 },
        uBand: { value: 1 },
      },
      transparent: true,
      blending: THREE.MultiplyBlending,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
      toneMapped: false,
      extensions: { derivatives: true },
    });
    material.forceSinglePass = true;

    this.geometry = geometry;
    this.material = material;
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'fx-air-mark';
    /* The vertices live in the ellipse's own space and are placed by the vertex
       shader, so the geometry's bounds say nothing about where it is drawn. */
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    skipOverridePass(this.mesh);
    parent.add(this.mesh);

    /* Amplitude, 0..1, so a jump measured by tools can be turned off from one
       build. The strength is otherwise a pure function of the car's height, and
       deliberately: this has no state of its own and cannot drift out of step
       with the flight. */
    this.strength = 1;
    /* What the last update produced, for tools/zjread.mjs and friends. */
    this.height = 0;
    this.outer = OUTER_LOW;
  }

  /**
   * Place the mark for this frame.
   *
   * @param car      the car, for its height and its heading
   * @param patches  the four wheel contact points, in the order the effects
   *                 module keeps them: front-left, front-right, rear-left,
   *                 rear-right. Already projected onto the surface.
   * @param up       the surface up at the car's station
   */
  update(car, patches, up) {
    const height = Math.max(0, car.height || 0);
    this.height = height;
    const rise = smoothstep(RISE_LOW, RISE_HIGH, height) * clamp(this.strength, 0, 1);
    if (rise <= 0.004) {
      this.mesh.visible = false;
      return;
    }

    const t = clamp(height / HEIGHT_REF, 0, 1);
    const outer = lerp(OUTER_LOW, OUTER_HIGH, t);
    const coreScale = lerp(CORE_SCALE_LOW, CORE_SCALE_HIGH, t);

    _up.copy(up);
    if (_up.lengthSq() < 1e-6) _up.set(0, 1, 0); else _up.normalize();

    _centre.copy(patches[0]).add(patches[1]).add(patches[2]).add(patches[3])
      .multiplyScalar(0.25).addScaledVector(_up, LIFT);

    /* Heading flattened into the surface, so the ellipse lies on the road
       rather than leaning with a pitched-up car. Falls back to the axis between
       the front and rear patches, which is the same thing measured on the
       ground, for the degenerate case of a car pointing straight up. */
    _fwd.copy(car.forward).addScaledVector(_up, -car.forward.dot(_up));
    if (_fwd.lengthSq() < 1e-4) {
      _fwd.copy(patches[0]).add(patches[1]).sub(patches[2]).sub(patches[3]);
      _fwd.addScaledVector(_up, -_fwd.dot(_up));
    }
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    _fwd.normalize();
    _side.crossVectors(_up, _fwd).normalize();

    const u = this.material.uniforms;
    u.uCentre.value.copy(_centre);
    u.uAxisA.value.copy(_fwd).multiplyScalar(HALF_LEN * coreScale);
    u.uAxisB.value.copy(_side).multiplyScalar(HALF_WID * coreScale);
    u.uOuter.value = outer;
    u.uCore.value = lerp(1, CORE_MUL, rise);
    u.uBand.value = lerp(1, BAND_MUL, rise * lerp(1, BAND_SOFT, t));
    this.outer = outer;
    this.mesh.visible = true;
  }

  hide() {
    this.mesh.visible = false;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
