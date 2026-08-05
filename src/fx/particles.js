import * as THREE from 'three';
import { lerp, smoothstep } from '../core/util.js';
import { rng, rand } from '../core/rng.js';
import { skipOverridePass } from './pass.js';
import {
  registerPrepassMesh, unregisterPrepassMesh, INK_ID_SCALE, INK_VOLUME_CLASS,
  INK_BURST_CLASS,
} from '../render/outline.js';

/* ── The five invariants ───────────────────────────────────────────────────
 *
 * Five rounds of this project fixed particle effects one scenario at a time,
 * and every round the same defect came back somewhere else: particles reading
 * as solid objects. Boulders, then cream lumps on grass, then polystyrene
 * chips, then a berm at the landing. The fix for that is not another scenario
 * tuned by hand; it is a small set of properties enforced in the one place
 * every class already passes through, so a class written next year inherits
 * them without its author knowing they exist. They are, in the order they are
 * stated in this file:
 *
 *   1  no instance may fill the lens               (near clamps, SCREEN_CAP)
 *   2  the pool may not paint more of the frame
 *      than its budget                             (_measureCoverage, admit)
 *   3  value is a bounded lift on the ground
 *      the particle came off                       (_matter)
 *   4  the silhouette the ink pass sees is the
 *      silhouette that is drawn                    (SHAPE_FNS)
 *   5  a particle is lit by the light in the
 *      scene, and disturbs nothing else's          (_updateLighting)
 *
 * 1 and 3 bound a single instance, 2 bounds the aggregate, 4 and 5 keep it
 * inside the cel pipeline the rest of the game is drawn with. Each has its
 * own block below, next to the code that enforces it, and a tool that fails
 * if it stops being true. Adding an effect means finding the emitter that is
 * closest to it and copying how that one behaves; it does not mean adding a
 * sixth colour source or a rate that skips admit(). */

/* One surface-keyed ramp keeps every event in the same material family. */
const TARMAC = [
  new THREE.Color(0x6f6961),
  new THREE.Color(0x887f72),
  new THREE.Color(0xa0937f),
  new THREE.Color(0xb9a485),
];
const VERGE = [
  new THREE.Color(0x58603c),
  new THREE.Color(0x707044),
  new THREE.Color(0x8b7848),
  new THREE.Color(0xaa8958),
];

/* ── Invariant 3: a particle's value is a bounded lift on the ground it came
 *    off, and nothing in the system may name a colour of its own ───────────
 *
 * Seven rounds of this project have been told that particles read as solid
 * objects, and every round fixed the class that had been reported. That kept
 * failing because the defect is not in any class, it is in the fact that each
 * class carried its own authored colour. An authored colour is a constant, and
 * a constant cannot be right: the same swatch is dust over a sunlit verge and
 * a chip of polystyrene over grass in shade, because what makes a shape read
 * as matter suspended in air rather than matter lying on the ground is not the
 * value it has, it is the value it has *relative to what it covers*.
 *
 * So there are no dust colours below. There is one ground ramp, one lift per
 * class expressed as a multiple of that ramp's own radiance, and one ceiling
 * over the lot. A class added next month picks a number from LIFT and cannot
 * express anything outside the band, because there is nothing else to type.
 *
 * The measured failures this replaces, all as a ratio to the surface each was
 * seen against: off-road dust 7.6x, braking at a low camera 8.4x, drift 6.5x,
 * the plume in the tunnel bore 5x. The tarmac veil, at 1.5x, was singled out
 * as the one part of the system that was right, so it sets the scale here. */
const GROUND_TARMAC = TARMAC[1];
const GROUND_VERGE = VERGE[1];

/* Multiples of the ground's own radiance. Above roughly 2 an opaque shape
   stops being read as air with dirt in it: the eye has no model for a gas
   that is twice as bright as everything around it, so it reaches for one of
   the few materials that is — snow, foam, stone in sun — and every one of
   those is a solid. That threshold is what the seven reports were reporting. */
const LIFT_CEIL = 2.05;
const LIFT = {
  /* The one the critic passed. Everything else is placed against it. */
  veil: 1.42,
  /* Airborne and seen against sky as often as against ground, so it is
     allowed the most — but the plume is what whited out the hairpin and what
     put snow on the tunnel floor, so "the most" is not much. */
  plume: 1.86,
  drift: 1.74,
  /* Seen flat against tarmac from four metres, where the plume's value is a
     bank of snow. The curtain carries the read; the sheet is nearly ground. */
  burstWall: 1.55,
  burstSheet: 1.22,
  /* Torn air rather than lifted dirt: barely off the road at all. */
  wake: 1.08,
  /* Thrown grit is solid, and solid belongs on the ground's own rungs. */
  debris: 0.94,
};

/* Twelve, and measured rather than assumed.
 *
 * Twenty-four was tried, on the theory that the tall thin fins standing at the
 * ends of the visible arc were foreshortened chords — a two-metre chord under
 * a four-metre wall becomes two metres of *depth* when it turns edgewise, and
 * a quad whose near end is closer than its far end projects as a wedge. It is
 * a good theory and it is not what was happening. Rendering the ring with each
 * segment painted a different colour, and then each segment on its own, showed
 * the fins were ordinary broadside quads with a spike in the middle of them,
 * and halving the chord made the fins narrower rather than fewer. The cause
 * was in the crown, not in the ring: see the tearing wavelength below.
 *
 * Twenty-four also cost real coverage — the pool's own estimate at peak went
 * from 0.61 to 1.09 against a 1.40 soft knee, because rotating twice as many
 * near-flank quads to face the lens overlaps twice as much — so it bought a
 * governor problem in exchange for nothing. Left at twelve. */
const WALL_SEGMENTS = 12;
/* Half the tangential reach of a curtain segment, as a multiple of the ring
   radius, and also the constant the fragment shader needs to turn a position
   along a segment back into a world angle.
 *
 * tan(pi/N) rather than anything larger, so the twelve chords form a
 * circumscribed polygon whose corners meet exactly: neighbours share their end
 * vertices and never cover the same ground twice. Overlapping them was worse
 * than it sounds — two opaque quads over the same pixels are resolved by
 * depth, the winner changes along the overlap, and the swap leaves a hard
 * crease. A ring of creases is a ring of facets, which is the one thing this
 * effect cannot afford to look like.
 */
const ARC_HALF = Math.tan(Math.PI / WALL_SEGMENTS);
/* Where a chord stops being a chord.
 *
 * A ring of twelve tangential quads is a good ring for ten of them and a bad
 * one for two: at the points where the tangent runs down the eye ray, the
 * quad is a wall standing edgewise to the camera. Its two metres of length
 * are then two metres of *depth*, so it projects as a narrow wedge whose near
 * end is closer — and therefore taller — than its far end. That wedge is the
 * "tan needle": not debris, not a shard, just the one segment per flank that
 * the approximation cannot draw. Widening it on screen, which is what this
 * used to do, made the needle thicker without making it stop being a wedge,
 * because the depth extent it comes from was never touched.
 *
 * So the two that cannot be chords stop being chords. As a segment turns
 * end-on its run direction rotates off the ring's tangent and onto the
 * horizontal that faces the camera, which is the same slab of dust seen
 * square instead of edgewise — the cross-section the old floor was standing
 * in for, drawn rather than faked. The blend is over facing, so it is
 * identically zero for every segment that is broadside enough to draw
 * honestly: ten of the twelve keep the exact tangential placement that makes
 * neighbours meet to the pixel, and only the degenerate pair moves.
 *
 * This is the answer to "a ring built out of camera-facing quads is a ring
 * from exactly one camera", which is why the whole curtain is not built that
 * way: it is true, and it is only true of the quads that have a choice. */
const WALL_BROADSIDE = 0.95;
const WALL_END_ON = 0.20;
/* The ground sheet's annulus sits at 0.74 of its quad, so the quad has to be
   this much wider than the ring it carries. */
const SHEET_QUAD = 2.0 / 0.74;
/* What a round puff's quad is enlarged by so that a shape normalised to fit
   inside it draws at the size it drew when it was overhanging and clipped.
   Measured against the mean fit factor plumeSdf now applies. */
const PLUME_QUAD = 1.34;

/* The landing plume's puffs: a kind above the ring's two, so the vertex shader
   places them as billboards and the fragment shader counts them as dust, while
   the prepass still hands them to the stage's pen. */
const BURST_PUFF_KIND = 5;
/* Billows around the contact, and puffs stacked in each. Seven by three is
   twenty-one instances against the twelve chords it replaces, and about a third
   less estimated coverage, because the governor measures a square of the
   instance's larger extent and a chord's larger extent was its full height. */
/* How the landing plume's puffs give their lift back as invariant 1's clamps
   take their size, stated as the share of its asked-for size an instance has
   already lost. Nothing is given up while the clamps are only trimming; by the
   time they have taken three fifths the lift is gone and what is left is at
   the road's own value. See the term at the end of the burst's painting. */
const BURST_CLAMP_HOLD = 0.10;
const BURST_CLAMP_GONE = 0.60;
const BURST_CLAMP_KEEP = 0.0;
const BURST_CLUMPS = 3;
const BURST_ROWS = 2;
const BURST_COLS = 2;

/* ── Invariant 1: no instance may fill the lens ────────────────────────────
 *
 * Two clamps that every particle class passes through before its quad is
 * built, stated in screen terms rather than world ones so they hold for any
 * camera at any field of view, and applied in the one place every class goes
 * through rather than per effect.
 *
 * A puff is opaque by design, and an opaque billboard that reaches the near
 * plane is an opaque frame. Emission volume has been tuned down twice to try
 * to stop that and has come back twice, because volume is not the cause: one
 * puff three metres wide two metres from the lens does it on its own, and no
 * rate low enough to prevent that leaves anything to look at.
 *
 * NEAR_* collapses whatever gets inside touching distance. SCREEN_CAP limits
 * what remains to a share of the screen height. The burst gets a tighter near
 * window than the billboards because it is a ring lying on the road whose
 * segments must stay adjacent, and the window is where they stop agreeing. */
const NEAR_GONE = 1.10;
const NEAR_FULL = 3.20;
/* The burst's window is a multiple of the instance's own vertical extent
   rather than a distance in metres, and that is a repair rather than a
   refinement. As two fixed metres it was written against the only burst that
   existed — a 1.16 m berm curtain, for which 0.45 and 1.30 m are the numbers
   below multiplied out almost exactly — and it silently stopped meaning
   anything when `scale` arrived and let a ramp landing stand a curtain four
   times as tall. A four-metre wall that is only collapsed inside 1.3 m
   reaches the lens at full size: measured frame by frame through the real
   chase camera, the near arc of a full ramp ring arrived two metres from the
   lens with four metres of curtain still standing and filled the bottom third
   of the frame with an opaque pale mass. That is invariant 1's own failure
   case — "one puff three metres wide two metres from the lens does it on its
   own" — reappearing through a route the constant could not see.
   Scaled, a berm curtain keeps the window it was tuned with and a ramp
   curtain begins giving way five metres out, which is about where the eye
   would expect to be able to see into a cloud it is entering. */
const BURST_NEAR_GONE = 0.38;
const BURST_NEAR_FULL = 1.12;
/* The quad's full extent, in half-screens: 1.0 lets one instance span half
   the screen's height and no more. This is a backstop for the pathological
   single puff, not the volume control — the aggregate is the governor's job
   below, and a cap tight enough to do both on its own would leave nothing to
   look at on an ordinary corner. */
const SCREEN_CAP = 1.00;
/* Sum of projected instance areas, as a share of the frame, above which the
   pool starts refusing new work. Each instance is counted at the size it is
   actually drawn — after invariant 1's clamps and clipped to the frame — but
   overlap is counted every time, on purpose: overlap is exactly the overdraw
   that took the hairpin to 40.9 fps, and a measure that forgave it would let
   the same frame through. So a value above 1 is reachable and means the pool
   is painting the same pixels repeatedly, which is the thing being bought. */
/* Placed against measurement rather than taste, because a governor that acts
   during ordinary driving is a governor that quietly deletes the effect it is
   supervising.

   Over two-minute AI runs of the stage at skill 0.9, watched through the real
   chase camera, coverage sits at 0.04–0.05 for half the frames, reaches
   1.48–1.58 at the 99th percentile, and peaks just under 3.0. So the soft
   knee sits at the top of that distribution and the hard limit at its very
   end: the multiplier is touched at all on 1.3% of frames, is below a half on
   0.3% of them, and shuts once or twice in a whole stage. Latent almost
   everywhere, awake only in the handful of frames per run that look like the
   one this invariant exists to prevent. tools/tgovern.mjs re-measures all of
   that and fails if ordinary driving starts being governed. */
const COVER_SOFT = 1.40;
const COVER_HARD = 3.00;
/* A quad is a torn shape inside its own bounds, not a filled rectangle. */
const COVER_FILL = 0.60;
/* What a one-off event keeps when the governor is fully closed. Continuous
   emission may be shut off outright — a veil that thins for a third of a
   second is a veil that thinned — but a landing that produces nothing is a
   landing that did not happen, and a missing event is a worse artefact than a
   crowded frame. So events are shrunk rather than refused. */
const EVENT_FLOOR = 0.34;

const VERT = /* glsl */`
attribute vec3 aCenter;
attribute vec3 aAxis;
attribute vec2 aScale;
attribute float aRotation;
attribute float aAge;
attribute float aShape;
attribute float aKind;
attribute vec3 aColor;

varying vec2 vUv;
varying float vAge;
varying float vShape;
varying float vKind;
varying float vViewDepth;
varying float vSpread;
/* How much of its asked-for size invariant 1's two clamps have left this
   instance: 1.0 untouched, 0.0 collapsed. The fragment shader needs it because
   a clamp is a shrink about the instance's own centre, and a shrink is the one
   thing a mass of overlapping puffs cannot survive as one mass — see the fade
   keyed to it in the burst's painting. */
varying float vShrink;
/* Burst only: the angle this segment sits at around the ring, the ring's
   present radius, and how squarely the camera is looking at the quad. The
   radius is what lets the fragment shader measure itself in metres of arc
   rather than in radians — detail sized in radians is fine across a whole
   ring and far too coarse when the camera is close enough to see one segment
   of it, which is exactly the shot a low chase camera takes. */
varying vec3 vSeg;
varying vec3 vFace;
varying vec3 vAlong;
varying vec3 vColor;

void main() {
  vec4 mv;
  vAlong = vec3(1.0, 0.0, 0.0);

  /* Lens guard. Every class is sized through aScale from here down; nothing
     below reads the attribute directly, so a class added later inherits both
     clamps without knowing they exist. projectionMatrix[1][1] is
     1.0 / tan(fovY * 0.5), which turns a world half-extent over a depth into
     a share of the screen's half-height and makes the cap independent of the
     field of view the camera happens to be running. */
  float lensDepth = -(viewMatrix * vec4(aCenter, 1.0)).z;
  /* The two world-placed ring primitives, and only those. The landing plume's
     puffs are kind 5 and are billboards like every other puff, so they take
     the billboard near window and the screen cap rather than the ring's
     looser, height-scaled one — see BURST_PUFF_KIND. */
  float isBurst = step(2.5, aKind) * (1.0 - step(4.5, aKind));
  float burstReach = max(aScale.y, 0.35);
  float near = mix(
    smoothstep(${NEAR_GONE.toFixed(2)}, ${NEAR_FULL.toFixed(2)}, lensDepth),
    smoothstep(burstReach * ${BURST_NEAR_GONE.toFixed(2)},
               burstReach * ${BURST_NEAR_FULL.toFixed(2)}, lensDepth),
    isBurst);
  float halfScreens = max(aScale.x, aScale.y) / max(lensDepth, 0.01)
    * projectionMatrix[1][1];
  float fit = min(1.0, ${SCREEN_CAP.toFixed(2)} / max(halfScreens, 0.0001));
  float shrink = near * mix(fit, 1.0, isBurst);
  vShrink = shrink;
  vec2 scale = aScale * shrink;

  vSeg = vec3(aRotation, scale.x * ${(0.5 / ARC_HALF).toFixed(5)}, 1.0);
  /* Where this puff sits in the plume it belongs to, and how much of the plume's
     height it spans — both as fractions of the whole mass, so the fragment
     shader can paint every puff of a landing off one tonal solution instead of
     shading each as a ball of its own. The two are packed into the one spare
     float the burst path has, the same way the carry vector borrows the spin,
     drag and buoyancy slots: the integer part carries the centre in
     five-hundredths, the fraction carries the half-extent. */
  if (aKind > 4.5) {
    vSeg = vec3(floor(aRotation) / 512.0, scale.x * ${(0.5 / ARC_HALF).toFixed(5)},
      fract(aRotation));
  }
  /* Everything else here is a billboard, because everything else here is a
     puff of gas with no orientation of its own. The landing burst has one: it
     is a ring lying on the road, and a ring built out of camera-facing quads
     is a ring from exactly one camera. These two kinds are placed in the
     world and left there. */
  if (aKind > 3.5 && aKind < 4.5) {
    /* Curtain segment: a wall standing on the road, running along the ring
       tangent that aAxis carries, facing out of the ring. It is raised in the
       view plane rather than in the world so that its width can be given a
       floor — the projected tangent supplies the foreshortening a real wall
       would have, and the floor keeps the two end-on segments from collapsing
       into hairlines. Its height is world up, projected, so the curtain still
       shortens correctly as the camera climbs. */
    vec3 tangent = normalize(aAxis);
    vec3 tangentView = (viewMatrix * vec4(tangent, 0.0)).xyz;
    vec3 riseView = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
    mv = viewMatrix * vec4(aCenter, 1.0);
    /* Placed exactly where the world quad is, so that the twelve chords, which
       share their corner vertices, meet to the pixel; flattening each quad to
       its own centre's depth, as this did at first, moved that shared corner
       by however much the two depths differed and left a vertical step down
       the join.
     *
     * Except at the flanks, where there is no placement that works and the
     * segment is turned to face the lens instead. The direction it turns onto
     * is horizontal in the world and square to the eye ray, so the slab stays
     * a wall standing on the road — it is rotated about its own vertical, not
     * tipped toward the camera. Its sign is taken from the tangent it is
     * leaving so the turn is the shorter way round; the two agree to within a
     * hair by the time the blend has any weight, and where they do not the
     * quad is symmetric in position.x and a flip only mirrors a noise field. */
    float facing = length(tangentView.xy);
    vec3 sideView = normalize(cross(riseView, normalize(mv.xyz)) + vec3(0.00001, 0.0, 0.0));
    sideView *= dot(sideView, tangentView) < 0.0 ? -1.0 : 1.0;
    float endOn = smoothstep(${WALL_BROADSIDE.toFixed(2)}, ${WALL_END_ON.toFixed(2)}, facing);
    vec3 runView = normalize(mix(tangentView, sideView, endOn));
    mv.xyz += runView * (position.x * scale.x) + riseView * (position.y * scale.y);
    vFace = normalize((viewMatrix * vec4(cross(vec3(0.0, 1.0, 0.0), tangent), 0.0)).xyz);
    vAlong = runView;
    /* The wall's height in metres. Every proportion of the crown contour is a
       fraction of it, so the contour has to know how large a fraction is. */
    vSeg.z = scale.y;
  } else if (aKind > 2.5 && aKind < 3.5) {
    /* Ground sheet: flat in the road plane whose normal aAxis carries. */
    vec3 axis = normalize(aAxis);
    vec3 ref = abs(axis.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 ux = normalize(cross(ref, axis));
    vec3 uy = cross(axis, ux);
    vec3 world = aCenter + ux * (position.x * scale.x) + uy * (position.y * scale.y);
    mv = viewMatrix * vec4(world, 1.0);
    /* The sheet is flat, so its own normal says nothing about which part of it
       faces the sun. Its two in-plane axes do, and the fragment knows where in
       them it sits. */
    vFace = normalize((viewMatrix * vec4(ux, 0.0)).xyz);
    vAlong = normalize((viewMatrix * vec4(uy, 0.0)).xyz);
    /* How square the camera is to the road here. A flat ring lying on the
       tarmac is the right primitive from above and a disaster from a low
       chase camera: seen along the surface it stops being a ring and becomes
       a pale swathe dragged halfway across the frame. It has to give way to
       the curtain as the eye comes down to road level. */
    vSeg.z = abs(dot(normalize((viewMatrix * vec4(axis, 0.0)).xyz), normalize(mv.xyz)));
  } else {
    /* An elongated billboard whose long axis is a world direction has to lose
       that length as the direction turns toward the lens, and this did not.
       normalize() threw the foreshortening away: the projected axis was scaled
       back to unit length however little of it was across the screen, so a puff
       half a metre long and fifteen centimetres tall kept its full half metre
       of screen length while pointing straight at the camera — and the
       direction that length was spent in was whatever residue survived the
       projection, which from directly behind the car is very nearly straight
       up. A wide flat smear on the road came out as a narrow vertical stroke
       standing on it.
     *
     * That is the "tan needles" of the last two reviews. They were attributed
     * to the landing burst, then to the burst's ground sheet, and they are
     * neither: rendering the 0.02–0.10 kind band alone reproduces every one of
     * them and nothing else, which makes them the tarmac veil, the class
     * emitted beside the wheels along car.forward. Behind the car, forward *is*
     * the eye ray, so this was the worst case on every frame of ordinary
     * driving, and the chase boom coming down from five metres to one and a
     * half made it worse by putting the lens nearer that axis than ever.
     *
     * It is also the same bug as the crown's wavelength and the near-fade
     * window: one quantity scaling while its partner stayed pinned. Here the
     * axis' *direction* was allowed to rotate with the camera while its
     * *length* was pinned at unit, so the two stopped describing the same
     * vector. Keeping the projected length is what fixes it — and a long puff
     * seen end-on should not vanish, it should read round, because that is what
     * it is: its long axis is pointing at you and what you see is its section.
     * So the along-extent runs down to the across-extent rather than to zero.
     * The unstable direction stops mattering at the same time, because by then
     * the quad is square and its orientation is not observable. */
    vec3 axisView = (viewMatrix * vec4(aAxis, 0.0)).xyz;
    float lie = length(axisView.xy);
    vec2 worldAxis = axisView.xy / max(lie, 0.00001);
    vec2 screenAxis = normalize(aAxis.xy + vec2(0.00001, 0.0));
    float onScreen = step(1.5, aKind);
    vec2 axis = mix(worldAxis, screenAxis, onScreen);
    /* The wake is authored in screen space on purpose — it is a mark on the
       image, not an object in the world — so it keeps its full length. */
    float foreshorten = mix(smoothstep(0.10, 0.52, lie), 1.0, onScreen);
    /* End-on, an elongated puff shows its cross-section, so the long extent
       runs to the short one rather than to zero — a puff pointing at the lens
       is round, not absent. */
    vec2 extent = vec2(mix(scale.y, scale.x, foreshorten), scale.y);
    vec2 across = vec2(-axis.y, axis.x);
    float c = cos(aRotation);
    float s = sin(aRotation);
    vec2 along = axis * c + across * s;
    vec2 side = vec2(-along.y, along.x);
    vec2 local = along * position.x * extent.x + side * position.y * extent.y;
    mv = viewMatrix * vec4(aCenter, 1.0);
    mv.xy += local;
    vFace = vec3(0.0, 0.0, 1.0);
    scale = extent;
  }
  gl_Position = projectionMatrix * mv;
  vUv = uv;
  vAge = aAge;
  vShape = aShape;
  vKind = aKind;
  vViewDepth = -mv.z;
  vSpread = max(scale.x, scale.y) / max(-mv.z, 0.001);
  vColor = aColor;
}`;

const VARYINGS = /* glsl */`
varying vec2 vUv;
varying float vAge;
varying float vShape;
varying float vKind;
varying float vViewDepth;
varying float vSpread;
varying float vShrink;
varying vec3 vSeg;
varying vec3 vFace;
varying vec3 vAlong;
varying vec3 vColor;`;

/* ── Invariant 4: the silhouette the ink pass sees is the silhouette that is
 *    drawn ───────────────────────────────────────────────────────────────────
 *
 * Shape is shared verbatim between the beauty pass and the ink prepass, as one
 * string neither pass may fork. The two have to agree to the pixel: a prepass
 * footprint even slightly wider or narrower than the drawn one leaves the ink
 * pass finding edges just inside or just outside the dust and drawing them,
 * and a hard black line traced a pixel off a soft edge is the strongest
 * "solid object" cue the style has — it was how the plume acquired a painted
 * outline nobody had asked for.
 *
 * Sharing the source is the mechanism; the guarantee is that the mechanism
 * costs nothing when there is no dust on screen, and that is a claim about the
 * whole composite rather than about this file. tools/inkparity.mjs is the
 * gate: it renders a frame with the pool stubbed out, then recompiles the
 * composite with the volumetric gate textually deleted, and requires the two
 * framebuffers to be identical byte for byte — 1,440,000 pixels, not a
 * tolerance. */
const SHAPE_FNS = /* glsl */`
float hash1(float n) {
  return fract(sin(n * 127.1) * 43758.5453123);
}

float hash2(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float valueNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash2(cell);
  float b = hash2(cell + vec2(1.0, 0.0));
  float c = hash2(cell + vec2(0.0, 1.0));
  float d = hash2(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/* A soft lopsided puff rather than a union of circles. The old cloud was seven
   overlapping discs, which is the canonical way to draw a boulder: every
   contour convex, every lobe the same sign of curvature.

   Every term here is drawn per instance — harmonic count, amplitude, base
   radius, squash, lean and centre offset. Randomising only the phases, as the
   first pass did, left every puff the same three-lobed floret at the same
   radius, and a trail of those reads as beads on a string no matter how the
   phases are shuffled. The wobble is renormalised against the base radius so
   a high-amplitude draw scallops deeply without throwing out petals. */
float plumeSdf(vec2 p, float seed) {
  float h0 = hash1(seed + 1.0);
  float h1 = hash1(seed + 2.0);
  float h2 = hash1(seed + 3.0);
  float h3 = hash1(seed + 4.0);
  float h4 = hash1(seed + 5.0);
  float h5 = hash1(seed + 6.0);
  float h6 = hash1(seed + 7.0);
  float h7 = hash1(seed + 8.0);

  vec2 offset = vec2(h4 - 0.5, h5 - 0.5) * 0.30;
  vec2 squash = vec2(1.0 + (h6 - 0.5) * 0.72, 1.0 + (h7 - 0.5) * 0.72);
  float shear = (h3 - 0.5) * 0.66;
  p -= offset;
  p *= squash;
  p.x += p.y * shear;

  /* Only the two- and three-fold term is allowed to be deep: that reads as a
     lopsided or kidney-shaped puff. Letting the mid and high harmonics run as
     wide turned every instance into a maple leaf, because deep notches at four
     or more folds are petals, not billows. */
  float base = 0.46 + h4 * 0.26;
  float w0 = 0.05 + h5 * 0.21;
  float w1 = 0.02 + h6 * 0.070;
  float w2 = 0.008 + h7 * 0.032;
  float norm = min(base * 0.42 / (w0 + w1 + w2), 1.0);

  float a = atan(p.y, p.x);
  float radius = base
    + w0 * norm * sin(a * (2.0 + floor(h0 * 2.0)) + h0 * 6.2832)
    + w1 * norm * sin(a * (4.0 + floor(h1 * 3.0)) + h1 * 6.2832)
    + w2 * norm * sin(a * (7.0 + floor(h2 * 5.0)) + h2 * 6.2832);
  /* And made to fit the quad that carries it, which it did not.
   *
   * This is the third instance in this file of one quantity scaling while its
   * companion stays pinned, and the first two were found the same way: a shape
   * whose drawn extent is a function of its own random draw, inside a primitive
   * whose extent is fixed at plus or minus one. The squash above contracts p by
   * as little as 0.64, so a puff that draws a base radius of 0.72 and a deep
   * two-fold wobble reaches 1.6 in the quad's own units — and everything past
   * 1.0 is not drawn. What is left is a rounded shape with two of its sides
   * sliced off flat and a sharp corner where the cuts meet, which is what the
   * near-wheel veil was measured and captured doing: four to eight flat tan
   * chips per frame with straight edges, lying on the tarmac. Nothing about it
   * was a dust problem. It was a puff bigger than the card it was printed on.
   *
   * So the worst case is solved for and the radius scaled to fit inside it. A
   * puff that already fits is untouched, which is most of them; one that would
   * have been clipped is drawn whole and slightly smaller instead. 0.86 rather
   * than 1.0 leaves room for the erosion below, which moves the boundary
   * outward as well as inward. */
  float reach = (base + (w0 + w1 + w2) * norm) * (1.0 + abs(shear))
    / min(squash.x, squash.y) + max(abs(offset.x), abs(offset.y));
  return length(p) - radius * min(1.0, 0.86 / reach);
}

float chunkSdf(vec2 p, float seed) {
  p.x += p.y * (hash1(seed + 21.0) - 0.5) * 0.45;
  float diamond = abs(p.x) * (0.82 + hash1(seed + 22.0) * 0.24)
                + abs(p.y) * (1.02 + hash1(seed + 23.0) * 0.32) - 0.72;
  float cut = p.x * (hash1(seed + 24.0) - 0.5) + p.y - 0.58;
  return max(diamond, cut);
}

/* The speed wake: air torn past the car, not a thing thrown by it.
 *
 * This was a capsule tapering from a round cap at one end to a narrower round
 * cap at the other, which is the shape of a splinter, and it was drawn opaque
 * and pale with a full black contour round it. Magnified at ground level behind
 * the wheels, several of those at once are the "thin shards lying on the road"
 * the last two reviews named — and they were attributed to the landing burst,
 * which does not emit anything of the kind.
 *
 * A spindle instead: no cap at either end, the width going to nothing at both,
 * so the silhouette has no blunt termination anywhere for the eye to read as a
 * broken-off end. The power on the sine keeps it from being a symmetric lens by
 * holding it wide through the middle and letting it run out to a long thin tail,
 * which is what a smear of moving air looks like when it is drawn flat. */
float streakSdf(vec2 p, float seed) {
  p.y += sin(p.x * 3.2 + seed) * 0.035;
  float along = clamp((p.x + 0.78) / 1.56, 0.0, 1.0);
  float taper = pow(sin(along * 3.14159), 0.62);
  return abs(p.y) - 0.30 * taper * mix(1.0, 0.72, along);
}

/* The landing burst.
 *
 * Every earlier attempt at this drew N separate puffs around the wheels and
 * then tried to stop each one looking like a rock. That is the wrong problem.
 * A handful of bright convex silhouettes on grey tarmac at four metres is a
 * handful of objects whatever their outline, because the eye counts them
 * before it reads any of them. So the burst is not a set of objects at all: it
 * is two shapes, and the shape is what expands.
 *
 * The ground sheet is one annulus in the road plane, drawn inside a single
 * quad. It cannot be a scatter because it is one primitive, and it cannot be
 * a solid because it lies in the surface it would have to sit on.
 *
 * The curtain is a closed ring wall, cut into twelve overlapping segments only
 * because a quad cannot bend. Its top contour is a function of world angle
 * alone, so neighbouring segments agree along their shared arc and the union
 * is one continuous crown all the way round rather than twelve humps.
 */
float burstWallAngle(vec2 p, vec3 seg) {
  return seg.x + atan(p.x * ${ARC_HALF.toFixed(4)});
}

/* The curtain's top edge. Kept in its own function because the beauty pass
   needs it twice — once for the silhouette and once to know how far up the
   curtain a fragment is — and the ink pass needs it to agree to the pixel.
   seg carries the world angle of the segment, the ring's radius and the
   wall's height in metres, all three of which the contour is a function of. */
float burstWallTop(float ang, vec3 seg, float age, float seed) {
  float radius = seg.y;
  /* How much of the wall has to be missing.
   *
   * Everything below is a fraction of the wall's own height, so a wall three
   * times taller is the identical silhouette three times larger — and a
   * silhouette that reads as a puff of dust at a metre reads as a bank of
   * earth at four, because the eye sizes the tearing against the world and
   * not against the shape. A ramp landing drawn this way was a closed opaque
   * rampart with the car hidden behind it. So the one thing that does not
   * scale with the height is how solid it is: the taller the curtain, the
   * more of it is holes and the deeper the notches between its billows run.
   * Tuned against the two ends that exist — a 1.16 m berm landing, which is
   * where all the proportions came from and must not move, and the 3.9 m of
   * a full ramp. */
  float tall = smoothstep(1.35, 3.60, seg.z);
  /* The crown has to swing nearly its own depth. A contour that varies by a
     tenth is a parapet with a bit of wear on it — which is exactly what the
     first version of this looked like — and a parapet is masonry. Tall billows
     separated by saddles that come most of the way back to the road are what
     makes the same closed ring read as gas instead. */
  /* Weighted down the spectrum rather than concentrated at the bottom of it.
     With two thirds of the swing in the second and third harmonics, the half
     of the ring the camera can see is one and a half slow waves — two smooth
     dunes with a saddle between them, which is a landform. The same total
     swing spread across five harmonics and two noise octaves is a bank of
     billows with smaller billows on their shoulders, and that is a cloud.
     Same amplitude, same reach against the world; only the spectrum moved. */
  float crown = 0.54
    + 0.140 * sin(ang * 2.0 + seed * 6.2832)
    + 0.150 * sin(ang * 3.0 - seed * 4.1)
    + 0.150 * sin(ang * 5.0 + seed * 2.9)
    + 0.095 * sin(ang * 8.0 - seed * 9.7);
  crown += (valueNoise(vec2(ang * 2.6, 0.7) + seed * 5.0) - 0.5) * 0.22;
  crown += (valueNoise(vec2(ang * 6.0, age * 0.8) + seed * 11.0) - 0.5) * 0.24;
  /* And one term whose scale is set in metres of arc rather than in radians, so
     the crown still has structure in it when the camera is close enough that
     only a couple of metres of the ring are on screen.
   *
   * Metres of arc *of a berm landing*. This is the whole of the fin defect and
   * it took three wrong answers to find. Every amplitude in this function is a
   * fraction of the wall's height, on the sound argument that a wall three
   * times taller should be the same silhouette three times larger. This term's
   * wavelength was not: it was pinned at about half a metre of arc whatever the
   * wall did. So on a berm it is the texture of a billow, and on a four-metre
   * ramp landing it is a third of four metres swinging up and down every half
   * metre — features eight times taller than they are wide, which is not a
   * billow and not even a picket fence, it is a comb. Standing where two of
   * them happened to peak together, that is a fin, and it is what the last two
   * critics called tan needles.
   *
   * Capping the amplitude in metres was the previous attempt and it is the
   * wrong half of the ratio to hold: it keeps the aspect honest by making a
   * four-metre curtain's edge as smooth as glass, which is how the same
   * curtain came back as a snowdrift. Stretching the wavelength with the
   * height instead keeps the aspect *and* the detail: a big mass tears in big
   * pieces, which is both what dust does and what the eye uses to judge how
   * large the mass is. The berm end, where every proportion here was tuned,
   * divides by one and does not move. */
  /* Not the full ratio, though. Stretched one-for-one with the height the crown
     is exactly the berm's silhouette scaled up, which is correct and reads as
     four smooth swoops, because only two or three of its features fit in the
     arc the camera can see — the same glassy rim the amplitude cap produced,
     arrived at from the other side. The root of the ratio is the compromise
     that survives both captures: features about twice the berm's aspect on a
     four-metre wall, which is still a torn mass and not a comb, with two or
     three tears across every billow instead of a billow every three tears. */
  float grow = pow(max(max(seg.z, 0.8) / 1.16, 1.0), 0.55);
  crown += (valueNoise(vec2(ang * max(radius, 0.5) * 2.2 / grow, age * 0.6) + seed * 17.0)
    - 0.5) * 0.34;
  /* Squashed toward a floor and a ceiling rather than clipped at them. Left
     to run, the harmonics occasionally line up into a narrow peak twice the
     height of the curtain either side of it, and a row of narrow peaks over
     deep notches is torn card, not dust. But a hard clamp is worse than the
     peak it removes: wherever the sum overshoots, the crown comes out at
     exactly the limit across the whole overshoot and the curtain grows a
     perfectly level plateau, which is the most man-made shape there is. */
  /* A tall wall is also allowed to come all the way back to the road between
     its billows, which a short one is not. The floor exists because a berm
     landing wants a continuous skirt of dust at the tyre line; four metres of
     continuous anything is a parapet, and what a big impact actually throws
     is two or three masses with the road showing between them. */
  float swing = (crown - 0.54) / 0.42;
  crown = mix(0.54, 0.48, tall)
    + mix(0.42, 0.47, tall) * swing * inversesqrt(1.0 + swing * swing);
  /* Punches up, holds, then thins. A shape that visibly grows and then thins
     is read as gas; one that holds its size while it slides outward is read
     as a thing being pushed.
   *
   * The hold in the middle is new and it is the whole of the duration fix.
   * The crown used to start falling at a twentieth of the burst's life and be
   * nine tenths gone by the end of it, which sounds gradual and is not: over
   * the same stretch the ring is also widening and the camera is closing, so
   * the three curves multiply and the mass measured 3.2% of the frame at
   * frame 3 and 0.245% at frame 6 — a four-frame flash, which is under a
   * tenth of a second and is not long enough for the eye to read anything as
   * anything. Dust thrown by four tonnes at fifty metres a second does not
   * arrive and leave inside a tenth of a second; it goes up, stands there,
   * and comes apart. So: up over the first eighth of the life, standing
   * through the middle third, and only then thinning. */
  float rise = mix(0.30, 1.0, smoothstep(0.0, 0.13, age));
  float fall = 1.0 - smoothstep(0.34, 0.94, age) * 0.86;
  crown *= rise * fall * (1.0 - smoothstep(0.90, 1.0, age));

  /* Torn from the first frame, and torn on a scale set in metres of arc
     rather than in radians. A curtain that is solid for a tenth of a second
     and then starts to open has already been read as a sheet by then; and
     tearing measured in radians is invisible from close in, where one segment
     fills the frame and its whole angular span is a few degrees — which is
     the shot a low chase camera takes on every landing.

     Bitten down from the crown rather than punched through the body. Noise
     added to the field opens rounded holes in the middle of the curtain,
     which look like perforations in a sheet: the eye reads the sheet, then
     the holes in it. Taken off the top instead, the same noise deepens the
     saddles between billows into notches that run most of the way to the
     road, which is how a torn dust edge is actually drawn. Two octaves of
     value noise sum to something clustered hard around a half, so the field
     is pulled back out to its full swing first. */
  float arc = ang * max(radius, 0.5);
  /* On the same stretched clock as the crown's fine term, and for the same
     reason: a bite is as deep as a fraction of the wall, so its width has to
     grow with the wall too or the notches sharpen into slots as the curtain
     gets taller. Two octaves, the finer one for the ragged edge of each tear. */
  float grain = valueNoise(vec2(arc * 3.4 / grow, age * 0.9) + seed * 7.0) * 0.62
    + valueNoise(vec2(arc * 7.6 / grow, age * 1.6) + seed * 3.0) * 0.38;
  /* Barely torn at the instant of contact and increasingly ragged after it.
     The punch has to arrive as mass — a burst that is already lacy on the
     frame it appears reads as a wisp rather than as something the car did to
     the ground — and then come apart, which is the half the eye reads as gas. */
  /* Deeper bites than the curtain used when it stood half as tall again. All
     of this shaping is a fraction of the quad's height, so dropping the
     curtain below a metre shortened every notch in it by the same third and
     the silhouette flattened into a dune from a low camera — where the near
     arc is seen almost edge on and is the only part of the ring doing any
     work. The proportions have to grow when the height shrinks to keep the
     tearing the same size in metres. */
  /* The tearing runs on the same stretched clock the crown does. Reaching
     nine tenths bitten away by six tenths of the life left the last two
     thirds of the burst as a scatter of slivers with road between them —
     "tan needles and shards lying on the road", which is a set of objects and
     the exact failure this file exists to prevent. A mass that is coming
     apart still has to be a mass while it does it.
   *
   * No cap on the depth of a bite. There were two here in turn, at a metre and
   * a half and then at four, and both were standing in for the wavelength fix
   * above: with the pitch of a tear now growing with the wall, a deep bite is a
   * wide tear rather than a slot, and depth is free to be a fraction of the
   * height like everything else. */
  float bite = mix(mix(0.16, 0.34, tall), mix(0.74, 0.80, tall),
    smoothstep(0.05, 0.82, age));
  return crown * (1.0 - smoothstep(mix(0.28, 0.19, tall), mix(0.70, 0.63, tall), grain) * bite);
}

float burstSdf(vec2 p, float age, float seed, float kind, vec3 seg) {
  if (kind > 3.5) {
    /* Position along the segment turns into a world angle; the crown is
       sampled there, so the seam between two segments is not a seam. */
    float ang = burstWallAngle(p, seg);
    float height = (p.y + 1.0) * 0.5;
    float top = burstWallTop(ang, seg, age, seed);
    float d = height - top;
    /* A sparse few real openings on top of the torn edge, in the thin upper
       body only, so there is somewhere the road shows through the mass and
       not only around it. On a tall wall they are neither sparse nor confined
       to the top: four metres of unbroken anything is a structure.
     *
     * Sparser than they were, and this is a consequence of the burst joining
     * the ink pass. An opening punched through the middle of the curtain is a
     * closed silhouette of its own, and the pen now draws it: what was a soft
     * gap in an untraced mass becomes a ring of contour with dust inside and
     * dust outside, which is the drawn definition of a hole in a sheet. The
     * comment above the tearing says the same thing about the field version
     * of this — "the eye reads the sheet, then the holes in it" — and ink
     * makes it twice as true. Held to a couple of openings per segment and
     * confined to the thin top, with the tearing at the crown left to do the
     * work of showing road through the mass. Measured: this and the crown cap
     * together took the pen's coverage of the plume from a scribble to
     * something on the order of what the pen spends on the car. */
    float tall = smoothstep(1.35, 3.60, seg.z);
    float lift = height / max(top, 0.02);
    /* Openings on the same stretched pitch the crown's tearing runs on, so a
       tall curtain is opened by a few large gaps rather than stippled with
       many small ones. Small openings in a big mass are perforations, and the
       pen draws each one as a closed contour with dust on both sides of it. */
    float grow = pow(max(max(seg.z, 0.8) / 1.16, 1.0), 0.55);
    float holes = valueNoise(
      vec2(ang * max(seg.y, 0.5) * 2.2 / grow, height * 3.0 - age * 1.1) + seed * 19.0);
    d += smoothstep(mix(0.66, 0.58, tall), mix(0.84, 0.80, tall), holes)
      * mix(0.26, 0.34, tall)
      * smoothstep(mix(0.42, 0.34, tall), 0.98, lift);
    /* And a torn foot, on the same pitch as the torn crown.
     *
     * The ring lifts off the road as it rises, which is deliberate — ground
     * visible underneath is what says a mass is airborne rather than stained
     * onto the surface — but it means the bottom of every quad is a boundary of
     * the drawn shape rather than a join with the tarmac, and the quad's bottom
     * is dead straight. Before the burst took the pen that was a soft edge
     * nobody read; with a contour on it, magnified, it is a ruled horizontal
     * line under a cloud, and a cloud with a ruled line under it is a piece of
     * card standing on its end. Bitten up from below by a fraction of what the
     * crown is bitten down by, so the foot is ragged without the curtain ever
     * losing contact along its whole length. */
    float base = (valueNoise(vec2(ang * max(seg.y, 0.5) * 1.9 / grow, age * 0.45)
      + seed * 23.0) - 0.30) * mix(0.05, 0.13, tall);
    d = max(d, base - height);
    return d;
  }

  /* Deliberately off-round. A ring of even width at an even radius painted on
     tarmac is a road marking, and it stays one however briefly it is there. */
  float a = atan(p.y, p.x);
  float lobe = sin(a * 2.0 + seed * 1.3) * 0.115
             + sin(a * 3.0 + seed) * 0.082
             + sin(a * 5.0 - seed * 1.6) * 0.050;
  float r = length(p);
  /* How much sheet there is to draw, as one number: nothing when the lens has
     dropped to the road's own level and the annulus has no width on screen,
     nothing once the burst is over. Both of those used to be separate
     multipliers on the width, which is where the last defect came from. */
  float thin = smoothstep(0.10, 0.34, seg.z) * (1.0 - smoothstep(0.58, 0.98, age));
  float halfWidth = mix(0.130, 0.048, smoothstep(0.0, 0.9, age)) * thin;
  float d = abs(r - (0.74 + lobe)) - halfWidth;
  /* Filled only for the first few frames of contact, and never far out. A
     ground sheet that keeps its middle is a pale mat lying on the road, and a
     mat is as solid a read as a rock — it just lies down. */
  d = min(d, r - (0.62 + lobe) * (1.0 - smoothstep(0.0, 0.16, age)) * thin);
  /* Scalloped, not severed.
   *
   * This used to cut right through in two or three places, and the argument for
   * it was explicitly about ink: an unbroken ring on tarmac reads as a curve
   * someone drew there, whereas "severed into arcs, the same ink reads as the
   * edges of torn sheets". The first half of that is true. The second turned
   * out to be exactly backwards, and the capture that settled it is the sheet
   * rendered on its own — the arcs do not read as torn sheet, they read as
   * eight pale plates lying on the road, one contour each, which is the
   * defect this whole file exists to prevent.
   *
   * The premise it rested on is gone in any case: the sheet no longer takes
   * the pen at all, so there is no ink here for a severed edge to be the edge
   * of. What is left is deep scalloping, which varies the ring's width without
   * ever cutting it in two, so at a grazing angle it is one soft band of dust
   * at the foot of the curtain instead of a scatter of countable objects. The
   * off-round lobes above are what keeps it from being a road marking.
   *
   * Scalloped as a fraction of the band's own width, which is the whole point
   * and was the bug. "Not severed" was a hand-picked 0.115 against a width of
   * 0.048 to 0.130, so it held at full width and nowhere else — and the band
   * spends most of its life away from full width, because both the grazing-angle
   * fade and the end-of-life fade worked by narrowing it. Narrow the band under
   * a fixed scallop depth and it is severed after all, into tapered radial
   * slivers; and a flat radial sliver seen from a lens down at road level does
   * not project as a sliver lying down, it projects as a stroke standing up.
   * That is the "tan needles" of the last two reviews, and the fade meant to
   * remove the sheet at exactly this camera height was manufacturing them. The
   * chase boom has since been cut from five metres to one and a half, so this
   * fade is now doing its work on every landing rather than occasionally.
   *
   * Below one, the scallop cannot cut through at any width, which makes the
   * claim in the name of this paragraph true by construction instead of by
   * arithmetic that happened to work at one size. */
  float tear = valueNoise(vec2(a * 5.3, 1.7) + seed * 3.0) * 0.66
             + valueNoise(vec2(a * 11.0, 4.1) - seed * 2.2) * 0.34;
  d += smoothstep(0.38, 0.82, tear) * halfWidth * 0.88
    * smoothstep(0.0, 0.30, age);
  return d;
}`;

const SHAPE_BODY = /* glsl */`
  vec2 p = (vUv - 0.5) * 2.0;
  float seed = vShape * 97.0 + 11.0;
  float rounded = plumeSdf(p, seed);
  float angular = chunkSdf(p, seed);
  float streak = streakSdf(p, seed);
  float isChunk = step(0.5, vKind) * (1.0 - step(1.5, vKind));
  float isStreak = step(1.5, vKind) * (1.0 - step(2.5, vKind));
  /* The ring: the ground sheet and the curtain chords, the two primitives with
     a shape function of their own. The landing plume's puffs are kind 5 and are
     dust by every test in this file — same silhouette, same erosion, same
     painting — so they are counted as dust below and not as burst. */
  float isBurst = step(2.5, vKind) * (1.0 - step(4.5, vKind));
  float isBurstPuff = step(4.5, vKind);
  float isDust = (1.0 - step(0.5, vKind)) + isBurstPuff;
  float isDriftFiller = step(0.10, vKind) * (1.0 - step(0.35, vKind));
  /* The landing burst, which is dust that must not be torn. Erosion is what
     turns the plume's overlapping puffs into a wispy mass, but a landing puff
     is on its own with clear tarmac around it, and a single torn silhouette
     at that size is not a wisp — it is a shard. A ring of them read as
     broken eggshell scattered around the wheels. */
  float isSoftDust = step(0.35, vKind) * (1.0 - step(0.5, vKind));
  /* The tarmac veil. Dust in every other respect, but it is the only dust
     class that is never seen against the sky, and two of the rules that make
     airborne dust read as airborne are anchored to the sky's own value. On a
     shape lying on the road they do not lighten it, they bleach it. */
  float isVeil = step(0.02, vKind) * (1.0 - step(0.10, vKind));
  float distanceToShape = mix(mix(rounded, angular, isChunk), streak, isStreak);

  /* Dust expands by thinning, not by growing into a bigger solid. Noise added
     to the field tears the boundary and then eats through the body as the puff
     ages, so the same instance that starts as a compact kick ends as lace you
     can see the road through. It also breaks the ink, which now traces a
     ragged interrupted contour instead of one closed loop around a lump. */
  float wisp = smoothstep(0.32, 1.0, vAge);
  /* Anisotropic sampling smears the tears along the puff's long axis, so the
     boundary breaks up into trailing wisps instead of the even crinkle that
     makes a light blob read as weathered stone. Scale and stretch vary per
     instance as well, so one puff comes out coarsely torn and its neighbour
     finely shredded. */
  float grainScale = 0.78 + hash1(seed + 11.0) * 0.70;
  vec2 g = p * vec2(1.00 + hash1(seed + 12.0) * 0.90,
                    0.56 + hash1(seed + 13.0) * 0.44) * grainScale;
  /* Weighted to the fine octaves. With the energy low down, the rim erosion
     cut a handful of deep notches straight toward the centre and every puff
     came out a maple leaf; up here it frays the edge instead of lobing it. */
  /* Band-limited to the pixels actually available, and this is the third
     instance in this file of one quantity scaling while its partner stayed
     pinned. The three octaves are fixed in quad space, which is the right
     choice — a tear should be a fraction of the puff, so the fray keeps its
     aspect whatever size the puff is. But how many *pixels* one cycle of the
     top octave covers is not fixed: it is the puff's screen size divided by
     twenty-three. On a puff filling a third of the frame that is six or seven
     pixels, and six-pixel noise through a hard discard is not a frayed edge,
     it is a scatter of loose squares — which is exactly what a magnified
     capture of the spray behind the wheels showed, a pale mass fringed with
     detached blocks. bulk was already fading the whole treatment out at the
     small end for the same reason, so only half the problem was covered.
     Each octave now fades as its own wavelength approaches pixel scale, and
     the sum is renormalised so dropping one does not shift the field's mean
     and silently move every threshold measured against it. */
  float pxPerUnit = 1.0 / max(max(fwidth(p.x), fwidth(p.y)), 0.00001);
  float w0 = 0.42 * smoothstep(1.7, 4.2, pxPerUnit / 5.4);
  float w1 = 0.34 * smoothstep(1.7, 4.2, pxPerUnit / 11.5);
  float w2 = 0.24 * smoothstep(1.7, 4.2, pxPerUnit / 23.0);
  float grain = (valueNoise(g * 5.4 + vec2(seed, seed * 1.7)) * w0
              + valueNoise(g * 11.5 + vec2(seed * 3.1, seed * 0.4)) * w1
              + valueNoise(g * 23.0 + vec2(seed * 0.7, seed * 2.3)) * w2)
              / max(w0 + w1 + w2, 0.04);
  float shred = 0.72 + hash1(seed + 14.0) * 0.50;
  /* Weight the erosion toward the rim. Applied evenly it chopped each puff
     into separate islands of similar size, which is a recipe for gravel; kept
     radial, the core stays one connected mass and only its edge frays. */
  float rimBias = mix(0.26, 1.0, smoothstep(-0.62, 0.02, rounded));
  /* Erosion is in quad space, so a puff that covers few pixels gets its fray
     carved at pixel scale and comes out a hard-edged chip. Fade the whole
     treatment out as the instance shrinks on screen and small puffs stay the
     soft blobs they should be. */
  float bulk = smoothstep(0.045, 0.20, vSpread) * (1.0 - isSoftDust);
  /* The landing plume tears less than the wheel spray does, and the reason is
     the pen rather than the dust. Ink is measured as a share of the plume's own
     pixels, so it is set by the length of the silhouette against the area inside
     it — and a boundary eroded to lace at this size has ten times the perimeter
     of the mass it encloses, which is how the curtain came to carry ten times
     the ink of world geometry when four was asked for. Held to about half the
     erosion, the boundary keeps its big lobes and loses the lace: at four metres
     across, lobes are what a cumulus edge is made of anyway, and lace at that
     scale is not a torn edge, it is a fringe. */
  float tearAmount = mix(1.0, 0.30, isBurstPuff);
  distanceToShape += (grain - 0.40) * mix(0.22, 0.62, wisp) * rimBias * bulk
    * shred * isDust * tearAmount;
  /* And at the end it goes away, by drawing in rather than by coming apart.
   *
   * This used to add noise at an amplitude of 1.14 to a field whose whole
   * radius is about 0.6, which does not thin a puff, it detonates it: wherever
   * the noise ran high the shape was erased, and what survived was a handful of
   * separate slivers with road between them. Each of those then took its own
   * contour, and a set of pale slivers with contours on tarmac is a set of
   * objects. Counted, the spray behind the wheels was breaking into a dozen and
   * more islands, several of them two or three times taller than they were
   * wide, which is the shape both reviews called a needle.
   *
   * The rule the curtain already works to applies here word for word: a mass
   * that is coming apart still has to be a mass while it does it. So the term
   * is mostly a uniform inset — the boundary retreats, evenly, until there is
   * nothing left — with only enough noise on it to keep that retreat ragged.
   * The puff still ends up showing road through where it overlapped its
   * neighbours; it just stops being the last three survivors of an explosion.
   *
   * It also starts later than the shredding did, and this is the half that
   * counts. What makes a train of puffs read as one moving film rather than as
   * a row of dots is that neighbours overlap, and an inset that begins at
   * four tenths of the life takes the overlap away from the whole tail of the
   * train: measured, that raised the island count from six to eight, because
   * every puff that stopped touching its neighbour became a thing of its own.
   * Holding full size through six tenths and then going in the remaining four
   * keeps the film together and still gets the puff off the screen. */
  float dying = smoothstep(0.50, 1.0, vAge);
  distanceToShape += (grain - 0.50) * 0.72 * dying * bulk * isDust * tearAmount;
  /* The landing plume is an event, so it ends, and it ends on its own clock
     rather than on the slow dissolve every other dust class gets. An inset that
     runs the boundary in until there is nothing left of it: the billow draws
     down and goes, which is what a thrown mass does once the energy that threw
     it has gone, and it leaves nothing lying on the road behind it. */
  distanceToShape += smoothstep(0.46, 0.98, vAge) * 1.25 * isBurstPuff;
  distanceToShape = mix(
    distanceToShape, burstSdf(p, vAge, seed, vKind, vSeg), isBurst);

  if (distanceToShape > 0.0) discard;`;

const FRAG = /* glsl */`
precision highp float;

uniform vec3 uInk;
uniform vec3 uSunView;
${VARYINGS}
${SHAPE_FNS}
void main() {
${SHAPE_BODY}

  /* Derivatives hold ink near the car's screen-space weight, then reduce it
     with depth so distant dust reads as atmosphere rather than a sticker. */
  float inkPixels = mix(3.35, 1.05, smoothstep(10.0, 75.0, vViewDepth));
  inkPixels *= mix(1.0, 0.22, isDriftFiller);
  inkPixels *= mix(1.0, mix(0.30, 0.10, wisp) * mix(0.45, 1.0, bulk), isDust);
  /* Measure the line against the smooth base outline. Taking fwidth of the
     eroded field reads the noise gradient instead of the silhouette, pins the
     width to its clamp and wraps every puff in a heavy contour — which is what
     made isolated dust look like chipped stone. */
  float edgeGradient = mix(fwidth(distanceToShape), max(fwidth(rounded), 0.004), isDust);
  float rimWidth = clamp(edgeGradient * inkPixels, 0.006, mix(0.052, 0.017, isDust));
  float rim = step(-rimWidth, distanceToShape);

  /* The SDF gradient is a procedural lobe normal. Quantizing its sun response
     gives painted crown/mid/underside planes without planar ribbon geometry.
     Dust shades off a plain dome rather than off its own outline. The eroded
     field scatters the rungs into mottled facets, and the harmonic outline is
     barely better: a radial gradient over a lobed contour quantises into
     angular wedges that converge on the centre and read as leaf veins. A
     circle gives clean concentric bands under a torn silhouette, which is how
     a cel cloud is actually painted. */
  float lobeField = mix(distanceToShape, length(p) - 0.62, isDust);
  vec2 gradient = vec2(dFdx(lobeField), dFdy(lobeField));
  gradient = normalize(gradient + vec2(0.00001));
  float dome = 0.72 + clamp(-lobeField * 1.8, 0.0, 0.55);
  vec3 lobeNormal = normalize(vec3(gradient, dome));
  float light = dot(lobeNormal, normalize(uSunView)) * 0.5 + 0.5;
  float shadowStep = 0.39;
  float lightStep = 0.64;

  /* Airborne dust is lit through, so its shade side stays bright. Driving the
     shadow rung down to 0.58 like a solid gave the plume a rock's tonal range. */
  vec3 shadowColor = vColor * mix(vec3(0.58, 0.64, 0.75), vec3(0.68, 0.72, 0.86), isDust);
  vec3 midColor = vColor;
  vec3 lightColor = min(
    vColor * mix(vec3(1.16, 1.06, 0.88), vec3(1.15, 1.12, 1.04), isDust)
      + vec3(0.028, 0.012, 0.0), vec3(1.0));
  vec3 body = mix(shadowColor, midColor, step(shadowStep, light));
  body = mix(body, lightColor, step(lightStep, light));
  body = mix(body, vColor * 0.82, isStreak);
  /* Old dust has thinned enough to take the sky's colour, which finishes the
     separation from anything sitting on the ground. Withheld from the veil:
     this is a mix toward an absolute white rather than a scaling of the
     instance's own colour, so on a base as dark as the veil's it does not
     tint the dust, it overwhelms it — measured, it was raising the veil to
     more than twice the value it was given and was the real reason darkening
     the palette barely moved the frame. The veil is also the one dust that
     never thins against sky, so it has nothing to take the colour of. */
  body = mix(body, mix(body, vec3(0.99, 0.96, 0.91), 0.24 * wisp * (1.0 - isVeil)), isDust);
  /* The outer band of a dust puff is the brightest part of it, because you are
     looking through less of it. Terminating the silhouette in the light rung
     instead of in shadow is what stops a pale lump reading as stone — the edge
     dissolves optically even though the pixels stay opaque. */
  float halo = smoothstep(-0.17, -0.015, distanceToShape) * isDust * bulk;
  body = mix(body, lightColor, halo * 0.70 * mix(1.0, 0.40, isVeil));
  /* A puff too small to fray is also too thin to be bright. Holding back the
     highlight keeps stray single puffs close to the road's own value instead
     of stamping a hard pale shape onto it. On its own curve rather than on
     bulk: the tarmac veil is small enough that it wants a good deal more of
     this than the eroded sizes do, and reusing bulk dulled the drift plume. */
  body = mix(body, body * mix(0.62, 1.0, smoothstep(0.02, 0.15, vSpread)), isDust);

  float transitionDistance = min(abs(light - shadowStep), abs(light - lightStep));
  float transitionWidth = max(fwidth(light) * 1.15, 0.006);
  float transitionInk = 1.0 - step(transitionWidth, transitionDistance);
  transitionInk *= (1.0 - isChunk) * (1.0 - isStreak) * (1.0 - rim);
  transitionInk *= mix(1.0, 0.25, isDriftFiller);
  /* Interior tone breaks are facet lines, and facets are what stone has.
     The landing burst gives them up altogether: its puffs are small, isolated
     and close to the camera, and at that size one tone break across a puff is
     not a fold in a cloud, it is the edge of a chip of rock. */
  transitionInk *= mix(1.0, 0.30 * (1.0 - wisp), isDust) * (1.0 - isSoftDust);
  /* Dust keeps a line, but a soft one in its own hue. Full black contour on a
     rounded shape is the strongest "solid object" cue the style has.
   *
   * The speed wake was taking the full black one, because it is not dust by
   * this test — isDust is only the round puff class — and nothing else here
   * distinguished it from thrown grit. Grit should have that line: it is a
   * solid, it is on the ground's own value rungs, and a hard contour is the
   * truth about it. The wake is the opposite thing, torn air, and it was being
   * given the strongest solid cue in the style and then set pale so it could
   * not be missed. It gets no line at all now — air has no edge — and the
   * spindle silhouette above is what carries it instead. */
  float airborneLine = max(isDust, isStreak);
  vec3 lineColor = mix(uInk, mix(uInk, vColor * 0.54, 0.76), airborneLine);
  body = mix(body, lineColor, transitionInk * 0.86);
  /* And the landing plume's puffs draw none either, for the reason spelled out
     under INK_BURST_CLASS: they write an inked class into the prepass, so the
     stage's own pen finds their torn edges, and a second contour drawn here
     would double-print every stroke. */
  body = mix(body, lineColor, rim * (1.0 - isStreak) * (1.0 - isBurstPuff));

  /* The burst is painted on its own terms rather than shaded off an SDF
     gradient. A dome normal is the right model for a puff and the wrong one
     for a curtain: it puts a bright centre and a dark edge on every segment,
     which is precisely the per-segment reading the ring exists to avoid.
     These two are painted the way a background artist would paint them —
     the curtain from its foot up, the sheet from its centre out — so the
     tone follows the whole ring and never an individual quad. */
  /* ── The landing plume is painted as one mass, not as twenty-seven balls ───
   *
   * The dust path shades off the SDF gradient, which is the right model for a
   * puff on its own: a dome normal gives a bright crown and a dark underside and
   * a single puff of dust looks like that. Twenty-seven overlapping puffs shaded
   * that way look like twenty-seven balls, and captured they do — a heap of
   * cauliflower with a dark crescent under every lobe, each one separately
   * readable, which is the countable-objects failure arriving through the
   * shading rather than through the placement.
   *
   * This is the same lesson the curtain already carried and the note is worth
   * keeping: "a dome normal is the right model for a puff and the wrong one for
   * a curtain — it puts a bright centre and a dark edge on every segment, which
   * is precisely the per-segment reading the ring exists to avoid". A plume is a
   * curtain in this respect. So it is painted from its foot up, off its height
   * within the whole mass, and every puff in a landing lands on the same rungs
   * at the same heights. Nothing in the tone marks where one puff ends and the
   * next begins, which is the property the twelve chords were built for and the
   * only one of theirs worth keeping. */
  if (isBurstPuff > 0.5) {
    float fraction = clamp(vSeg.x + p.y * vSeg.z, 0.0, 1.3);
    float band = max(fwidth(fraction) * 0.9, 0.006);
    /* Dust at the road is looked at through the whole depth of the plume and is
       in the car's own shade; the head of it is a single thickness with the sky
       behind. Getting that order right is most of what stops a pale mass reading
       as something lying on the ground. */
    /* Six rungs up the mass rather than three. The count is not decoration: a
       flat interior is the other half of what made the old curtain read as cut
       card, and measured at the peak frame the plume was carrying six tones where
       it used to carry ten to thirteen. Six rungs and a warm drift up them puts
       that back without a single interior contour, because they are rungs of one
       gradient over the whole mass and not facets of any puff in it. */
    vec3 foot = vColor * 0.54;
    vec3 shin = vColor * 0.67;
    vec3 waist = vColor * 0.81;
    vec3 chest = vColor * 0.93;
    vec3 shoulder = min(vColor * 1.08 + vec3(0.012, 0.006, 0.0), vec3(1.0));
    vec3 head = min(vColor * 1.24 + vec3(0.028, 0.016, 0.004), vec3(1.0));
    body = mix(foot, shin, smoothstep(0.13 - band, 0.13 + band, fraction));
    body = mix(body, waist, smoothstep(0.28 - band, 0.28 + band, fraction));
    body = mix(body, chest, smoothstep(0.43 - band, 0.43 + band, fraction));
    body = mix(body, shoulder, smoothstep(0.58 - band, 0.58 + band, fraction));
    body = mix(body, head, smoothstep(0.74 - band, 0.74 + band, fraction));
    /* And the last of it lighter again, so the top edge dissolves optically
       while every pixel of it stays opaque. */
    body = mix(body, min(head * 1.09, vec3(1.0)),
      smoothstep(0.93 - band, 0.93 + band, fraction));
    /* Thinning toward the road's own value as it goes, so the plume leaves
       rather than switches off, and pulled back when it is too small on screen
       to show any interior — a piece too small to read is also too thin to be
       bright. */
    body = mix(body, body * 0.86, smoothstep(0.44, 1.0, vAge));
    body = mix(mix(body, vColor * 0.90, 0.52), body, smoothstep(0.03, 0.16, vSpread));
    /* And it gives its lift back as invariant 1's clamps take its size.
     *
     * The tail is where this plume still reads as a handful of objects. On the
     * last frames of a landing the mass has arrived at the lens, the screen cap
     * and the near window are scaling instances down about their own centres,
     * and a union of a dozen overlapping puffs comes apart into the separate
     * puffs it was made of: on seed 22's last drawn frame the burst's own
     * pixels sit in four unconnected pale lobes, and on seed 40's in three.
     * Neither age nor angular size explains it — both terms above are still
     * mild there — and no shape function can see it, because a clamp shrinks
     * the quad and leaves the silhouette drawn on it untouched.
     *
     * The prescription this came in under was to fade the puffs out ahead of
     * their scale, and the reading behind it is right: a shrinking opaque puff
     * is a small hard object and a fading one is air. There is no alpha to
     * fade, though — the pool is opaque by invariant 4 and every fragment it
     * draws is written — so what fades is the value, which is what alpha would
     * have bought anyway. vColor is the road under the puff times the lift it
     * was spawned with, so dividing that lift back out lands exactly on the
     * colour of the road the fragment covers, and dust at the road's own value
     * is dust that has settled.
     *
     * Worth being plain about the size of it, because the clamps only bite
     * hard on the very last frame: this takes 18% of the pale pixels off that
     * frame on seed 22 and 34% on seed 40, and does not touch any earlier one.
     * It is the whole of what can be had from here without shortening the
     * event — eroding the silhouette instead buys much more and costs the
     * duration floor, which the tail already sits on. Nothing here touches the
     * silhouette, so the pen sees the shape it saw before and the ink is
     * where it was. */
    float spent = smoothstep(${BURST_CLAMP_HOLD.toFixed(2)},
      ${BURST_CLAMP_GONE.toFixed(2)}, 1.0 - vShrink);
    vec3 road = vColor * ${(1 / LIFT.burstWall).toFixed(4)};
    body = mix(body, mix(road, body, ${BURST_CLAMP_KEEP.toFixed(2)}), spent);
  }

  vec3 burstBody = body;
  {
    /* Two rungs, not three. Half a second is not long enough to read a third,
       and an extra interior break at this scale is a facet, and facets are
       what stone has. */
    /* The lit side of the ring, resolved per fragment from where that fragment
       actually sits on the circle rather than from the flat quad carrying it.
       Taken off the quad's own normal, the terminator lands on a facet edge
       and the ring gets a twelve-sided kink in it. */
    float turn = burstWallAngle(p, vSeg) - vSeg.x;
    vec3 outward = vKind > 3.5
      ? normalize(vFace * cos(turn) + vAlong * sin(turn))
      : normalize(vFace * p.x + vAlong * p.y + vec3(0.0, 0.0, 0.0001));
    float sunSide = step(0.52, dot(outward, normalize(uSunView)) * 0.5 + 0.5);
    if (vKind > 3.5) {
      float height = (p.y + 1.0) * 0.5;
      float top = burstWallTop(burstWallAngle(p, vSeg), vSeg, vAge, seed);
      float fraction = clamp(height / max(top, 0.0015), 0.0, 1.0);
      float band = max(fwidth(fraction) * 0.9, 0.004);
      /* Painted from the foot up. The dust at the road is looked at through
         the whole depth of the ring and is in the car's own shade; the crown
         is a single thickness with the sun behind it. Getting that order
         right is most of what stops a pale mass reading as a kerb, which is
         lit the other way round. */
      vec3 foot = vColor * 0.52;
      vec3 midway = vColor * mix(0.84, 0.95, sunSide);
      vec3 crown = min(vColor * mix(1.30, 1.44, sunSide) + vec3(0.04, 0.03, 0.01), vec3(1.0));
      burstBody = mix(foot, midway, smoothstep(0.26 - band, 0.26 + band, fraction));
      burstBody = mix(burstBody, crown, smoothstep(0.64 - band, 0.64 + band, fraction));
      /* And the last of it lighter again. Ending the silhouette on the
         brightest rung the curtain has is what dissolves the top edge
         optically while every pixel of it stays opaque — the same trick the
         plume uses at its rim, and the difference between a mass that stops
         and a mass that thins out. */
      burstBody = mix(burstBody, min(crown * 1.10, vec3(1.0)),
        smoothstep(0.88 - band, 0.88 + band, fraction));
    } else {
      float radius = length(p);
      float band = max(fwidth(radius) * 0.9, 0.004);
      /* The leading edge of a ground sheet is the part still moving, so it
         is the part that catches the light. */
      vec3 trailing = vColor * 0.88;
      vec3 leading = min(vColor * mix(1.16, 1.30, sunSide), vec3(1.0));
      burstBody = mix(vColor * 0.78, trailing,
        smoothstep(0.40 - band, 0.40 + band, radius));
      burstBody = mix(burstBody, leading,
        smoothstep(0.72 - band, 0.72 + band, radius));
    }
    /* Both thin toward the road's own value as they go, so the burst leaves
       rather than switches off. */
    burstBody = mix(burstBody, burstBody * 0.84, smoothstep(0.40, 1.0, vAge));
    /* And the same rule the plume gets from bulk, which the burst never had:
       a piece too small on screen to show any interior is also too thin to be
       bright. At full contrast a distant or early burst is a handful of pale
       wedges — the tonal range survives when the shape does not, and what is
       left of a torn curtain three pixels tall is a chip of something. Pulled
       back toward the ground's own value instead, small pieces stay
       disturbance. */
    float burstBulk = smoothstep(0.03, 0.16, vSpread);
    burstBody = mix(mix(burstBody, vColor * 0.88, 0.55), burstBody, burstBulk);
    /* No rim drawn here, and this is the other half of invariant 4: one
       silhouette gets one line, from the pass whose job lines are. The burst
       writes an inked class into the prepass now (see INK_BURST_CLASS), so
       the composite finds this shape's torn edges itself, with the stage's
       own pen — the same weight, the same proportional darkening against
       whatever it borders, the same distance fade. Painting a second contour
       here would double-print every stroke, and a doubled line half a pixel
       off its twin is the heaviest "solid object" cue the style has.
       It is also why the rim that used to be here never showed up in a
       measurement: a line drawn in the beauty pass is in the frame whether
       the ink pass is on or off, so tools/dustjudge.mjs — which measures ink
       by rendering the same frozen frame both ways — correctly reported the
       plume as carrying none. */
  }
  gl_FragColor = vec4(mix(body, burstBody, isBurst), 1.0);
}`;

/* ── Invariant 4, second half: the burst is drawn, so the pen draws it ──────
 *
 * Everything in this pool used to write the volumetric class, which tells the
 * composite to occupy the buffer and raise no line. That is right for the
 * airborne puffs and wrong for the landing burst, and the difference is not a
 * matter of taste — it is measurable. tools/dustjudge.mjs renders the burst
 * with the ink pass on and off from the same frozen frame: at peak the pass
 * darkened 0.55% of the plume's pixels against 4.11% of the world's in the
 * same frame, a 7.5:1 deficit, and the critic's reading of that frame was
 * "a hard-edged cream sawtooth crown with a single flat value across it and
 * no contour anywhere". A stage drawn in ink whose dust carries none is a
 * sticker on a drawing, and every one of the seven "reads as a solid" reports
 * this file records is a report of a shape the pen never touched.
 *
 * The two halves want opposite things and always did:
 *
 *   the puffs      overlap each other constantly, and every overlap is a
 *                  depth step. Inked, a trail of them is a pile of boulders
 *                  with a line round each — the failure the volumetric class
 *                  was added to fix. They keep it.
 *   the burst      is two shapes, not a scatter: one annulus lying in the road
 *                  and one closed ring wall, both torn through by design. The
 *                  pen finds their torn edges and the holes bitten out of
 *                  them, which is an interrupted contour around a mass with
 *                  road showing through it — the drawn version of exactly the
 *                  reading the shape functions were written to produce. The
 *                  comment on the sheet's tear term has been asking for this
 *                  since it was written: "severed into arcs, the same ink
 *                  reads as the edges of torn sheets, which is what it is
 *                  meant to be."
 *
 * So the class is chosen per fragment off the same vKind the silhouette is,
 * and the burst rejoins the pen. It still occupies the prepass, so it still
 * hides the guardrail's outline behind it; the only thing that changes is
 * that the composite is now allowed to find its edges.
 *
 * Class 0 was tried first, on the argument that it is the stage's unclassified
 * default — the trees, the posts, every prop nobody named — and so gives the
 * burst the pen a thing in the world gets without editing the composite. It
 * was the wrong class for one measurable reason, and it is not about the pen's
 * weight. Class 0 is also what the background carries, because the prepass
 * never writes the sky; so "these two samples are both burst" and "these two
 * samples are both sky" are the same test, and there is no way to tell the
 * composite to stop drawing lines inside the plume that does not also stop it
 * drawing every unclassified prop against the sky.
 *
 * So the burst has a class of its own now. It is deliberately given the same
 * pen weight class 0 had — the composite's weight mix leaves it on uWOther,
 * which is exactly what an unclassified prop gets — so nothing about how hard
 * the burst is drawn has changed. The only thing the class buys is the one
 * thing it was needed for: the composite can suppress a depth step between two
 * burst fragments, which is a fold inside one mass of dust, while still
 * drawing the step between a burst fragment and the road, which is its
 * silhouette. See the gate in the composite. */

/* The plume's contribution to the ink pass's normals-and-distance buffer.
   Same vertex shader and same silhouette as the beauty pass, so the buffer
   agrees with the drawn frame exactly; the ink pass then knows the dust is
   there and stops compositing the guardrail's outline over the front of it.
   A view-aligned billboard is a plane of constant view depth, so its
   geometric normal is exactly the view axis — writing that as a constant is
   both correct and free, and a constant normal raises no crease anywhere
   inside the plume. The red channel carries the class offset: volumetric for
   the puffs, and the stage's own default for the burst. */
const PREPASS_FRAG = /* glsl */`
precision highp float;
${VARYINGS}
${SHAPE_FNS}
void main() {
${SHAPE_BODY}
  /* The curtain takes the pen and the ground sheet does not.
   *
   * When the burst joined the ink pass it joined as one thing, and the sheet
   * should never have come with it. A silhouette is worth drawing when it is
   * the boundary of a mass standing in the air; the sheet is a flat mat lying
   * in the road plane, and from the camera this game actually uses — two and a
   * half metres up, nine back — it is seen at about seventy-five degrees off
   * its own normal, where a torn annulus does not project as a ring at all. It
   * projects as eight or nine separate lozenges scattered on the tarmac, and
   * once each of those is given a closed contour they stop being a smear of
   * dust and become objects: measured on its own, the sheet carried 67% ink
   * coverage, the highest of anything in the frame, because it is all
   * perimeter and no area. That is the polystyrene chip, drawn in pen.
   *
   * So it goes back through the volumetric class it was written for, where it
   * still occupies the prepass and still hides what is behind it, and draws no
   * line of its own. Which is also the honest reading of what it is: the sheet
   * is the dust that has not left the ground yet. */
  float isBurstWall = step(3.5, vKind);
  float inkClass = mix(${INK_VOLUME_CLASS.toFixed(1)}, ${INK_BURST_CLASS.toFixed(1)}, isBurstWall);
  gl_FragColor = vec4(0.5 + inkClass * ${INK_ID_SCALE.toFixed(1)}, 0.5, 1.0, vViewDepth);
}`;

function quadGeometry(max) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0, 1, 0, 1, 1, 0, 1,
  ], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.instanceCount = max;
  geometry.setDrawRange(0, 6);
  return geometry;
}

/** One instanced pool covers dust, smoke, landings, impacts and speed wakes. */
export class ParticlePool {
  constructor(parent, { max = 384, seed = 1, sun = null } = {}) {
    this.max = Math.max(64, max | 0);
    this.seed = seed | 0;
    this.cursor = 0;
    this.live = 0;
    this.liveSpeed = 0;
    this.liveChunks = 0;
    this.liveGroundSlaps = 0;
    this.sun = sun;
    this._sunWorld = new THREE.Vector3(-0.35, 0.75, 0.55).normalize();
    this._veilScratch = new THREE.Color();
    /* Governor state. coverage is the pool's own estimate of the share of the
       frame it is about to paint, gate is what the emitters are allowed to
       ask for as a result — see admit() and admitEvent() below, which are the
       only two ways it is ever read. */
    this.coverage = 0;
    this.gate = 1;
    /* Off only in tools that need the unclamped run to compare against; see
       tools/tgovern.mjs. There is no way to reach this from the game. */
    this.governor = true;
    /* Test hook, and the only way to exercise the governor deliberately:
       measured coverage is 1–5% of the frame in ordinary play, so the
       multiplier is 1.0 in every capture this project has, and an invariant
       that has never once been observed to act is an invariant on paper.
       Added to the measured sum before the curve, so a bias of 0.6 puts the
       pool over COVER_SOFT with nothing else in the scene changed. */
    this.coverageBias = 0;
    this._camPos = new THREE.Vector3();
    this._camFwd = new THREE.Vector3(0, 0, -1);
    this._camRight = new THREE.Vector3(1, 0, 0);
    this._camUp = new THREE.Vector3(0, 1, 0);
    this._projX = 1;
    this._projY = 1;
    this._hasCamera = false;

    const n = this.max;
    this.active = new Uint8Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.baseSize = new Float32Array(n);
    this.growth = new Float32Array(n);
    this.aspect = new Float32Array(n);
    this.spin = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.accelY = new Float32Array(n);
    this.kind = new Float32Array(n);
    /* Burst-only state. The ring's radius and each quad's width have to stay
       in lockstep to the centimetre — a segment narrower than its share of the
       circumference opens a gap and the wall becomes eight lumps again — so
       the burst kinds are integrated from a closed form rather than through
       the damped velocity the puffs use. */
    this.origins = new Float32Array(n * 3);
    this.baseSizeY = new Float32Array(n);
    this.growthY = new Float32Array(n);
    this.travelV = new Float32Array(n);
    this.travelA = new Float32Array(n);
    this.centers = new Float32Array(n * 3);
    this.axes = new Float32Array(n * 3);
    this.scales = new Float32Array(n * 2);
    this.rotations = new Float32Array(n);
    this.ages = new Float32Array(n);
    this.shapes = new Float32Array(n);
    this.colors = new Float32Array(n * 3);

    const geometry = quadGeometry(n);
    this.centerAttr = new THREE.InstancedBufferAttribute(this.centers, 3);
    this.axisAttr = new THREE.InstancedBufferAttribute(this.axes, 3);
    this.scaleAttr = new THREE.InstancedBufferAttribute(this.scales, 2);
    this.rotationAttr = new THREE.InstancedBufferAttribute(this.rotations, 1);
    this.ageAttr = new THREE.InstancedBufferAttribute(this.ages, 1);
    this.shapeAttr = new THREE.InstancedBufferAttribute(this.shapes, 1);
    this.kindAttr = new THREE.InstancedBufferAttribute(this.kind, 1);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colors, 3);
    geometry.setAttribute('aCenter', this.centerAttr);
    geometry.setAttribute('aAxis', this.axisAttr);
    geometry.setAttribute('aScale', this.scaleAttr);
    geometry.setAttribute('aRotation', this.rotationAttr);
    geometry.setAttribute('aAge', this.ageAttr);
    geometry.setAttribute('aShape', this.shapeAttr);
    geometry.setAttribute('aKind', this.kindAttr);
    geometry.setAttribute('aColor', this.colorAttr);

    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uInk: { value: new THREE.Color(0x160c12) },
        uSunView: { value: new THREE.Vector3(-0.35, 0.75, 0.55).normalize() },
      },
      transparent: false,
      depthTest: true,
      depthWrite: true,
      toneMapped: false,
      extensions: { derivatives: true },
    });

    /* The plume still has to sit out the scene-wide override pass, because
       that pass draws every object with one material that cannot expand these
       quads. It rejoins the prepass on its own terms straight afterwards. */
    const prepassMaterial = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: PREPASS_FRAG,
      uniforms: {},
      transparent: false,
      depthTest: true,
      depthWrite: true,
      toneMapped: false,
    });

    this.geometry = geometry;
    this.material = material;
    this.prepassMaterial = prepassMaterial;
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'fx-unified-billows';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
    skipOverridePass(this.mesh);
    registerPrepassMesh(this.mesh, prepassMaterial);
    const skipBeforeRender = this.mesh.onBeforeRender;
    this.mesh.onBeforeRender = (renderer, scene, camera, drawnGeometry) => {
      this._updateLighting(camera);
      skipBeforeRender(renderer, scene, camera, drawnGeometry);
    };
    parent.add(this.mesh);
    this._resetRandom();
  }

  _resetRandom() {
    this.random = rand(rng(this.seed + 1009));
  }

  /* ── Invariant 5: a particle is lit by the light that is actually in the
   *    scene, and disturbs nothing else's lighting ──────────────────────────
   *
   * The sun direction is read off the scene's own directional light every
   * frame rather than baked in, so the tonal split across a puff turns with
   * the sun as the stage descends and the crown of a curtain is on the side
   * the sun is really on. A constant here is the same mistake as a constant
   * colour in invariant 3: it is right in one place on the mountain and wrong
   * everywhere else, and dust lit from a direction nothing else is lit from
   * reads as a decal rather than as something in the world.
   *
   * The other half is negative and matters more. The pool casts no shadow and
   * samples none: it is one instanced mesh outside the shadow map, and it sits
   * out the scene-wide override pass entirely. So the mountain's own shadowing
   * of the road under it has to be exactly what it is with no dust in frame.
   * tools/tshadow.mjs is the gate on that. It samples the road under the shell
   * and reports how much of it darkens; the count moves as the landform is
   * rebuilt, so read the split rather than the number. The pixels that do not
   * darken are the ones already on the bottom rung, which the posterise step
   * rounds back where they were — at the last run 2,382 of 2,537 darkened and
   * the 155 that did not sat a whole rung below the rest of the band. That is
   * quantisation, not shadow leaking through the FX.
   *
   * The known cost of taking no shadow: a plume standing in the mountain's
   * shade is lit as though it were not. Left as it is deliberately — the value
   * ceiling in invariant 3 is a ratio against the ground the dust came off,
   * and that ground is drawn in shade, so the dust is already the smaller of
   * the two errors. Recorded rather than fixed, because fixing it means the
   * pool joining the shadow pass and that is a cel-pipeline change. */
  _updateLighting(camera) {
    if (this.sun?.position && this.sun?.target?.position) {
      this._sunWorld.copy(this.sun.position).sub(this.sun.target.position).normalize();
    }
    this.material.uniforms.uSunView.value.copy(this._sunWorld)
      .transformDirection(camera.matrixWorldInverse);
    this.observe(camera);
  }

  /** Whatever camera the pool is judged from, taken off the real render. */
  observe(camera) {
    if (!camera?.isCamera) return;
    this._camPos.setFromMatrixPosition(camera.matrixWorld);
    this._camRight.set(1, 0, 0).transformDirection(camera.matrixWorld);
    this._camUp.set(0, 1, 0).transformDirection(camera.matrixWorld);
    this._camFwd.set(0, 0, -1).transformDirection(camera.matrixWorld);
    const e = camera.projectionMatrix.elements;
    this._projX = Math.abs(e[0]) || 1;
    this._projY = Math.abs(e[5]) || 1;
    this._hasCamera = true;
  }

  /* ── Invariant 2: the pool may not paint more of the frame than its budget ─
   *
   * Measured rather than assumed, from the instances actually alive and the
   * camera actually rendering, and fed back to every emitter through a single
   * multiplier. Rate tuning cannot do this job: the same rate is a thin trail
   * on a straight and a white-out in a hairpin, because what fills the screen
   * is the camera closing on the puffs, not the number of them.
   *
   * The measurement is of the frame just finished and the multiplier is spent
   * on the next one. That one frame of lag is the whole design: a governor
   * that tried to predict its own output would have to build every quad twice,
   * and dust that arrives a sixtieth of a second late is dust.
   *
   * Nothing else in the pool reads `gate`. Emitters go through admit() for a
   * rate and admitEvent() for a one-off, so a class added later is governed
   * whether or not its author knew there was a governor. */
  _measureCoverage() {
    if (!this._hasCamera) { this.coverage = 0; this.gate = 1; return; }
    const cx = this._camPos.x, cy = this._camPos.y, cz = this._camPos.z;
    const fx = this._camFwd.x, fy = this._camFwd.y, fz = this._camFwd.z;
    const rx = this._camRight.x, ry = this._camRight.y, rz = this._camRight.z;
    const ux = this._camUp.x, uy = this._camUp.y, uz = this._camUp.z;
    let sum = 0;
    for (let i = 0; i < this.max; i++) {
      if (!this.active[i]) continue;
      const p3 = i * 3;
      const dx = this.centers[p3] - cx;
      const dy = this.centers[p3 + 1] - cy;
      const dz = this.centers[p3 + 2] - cz;
      const depth = dx * fx + dy * fy + dz * fz;
      if (depth < 0.05) continue;
      const p2 = i * 2;
      const sx = this.scales[p2], sy = this.scales[p2 + 1];
      const reach = Math.max(sx, sy);
      if (reach <= 0) continue;
      /* Invariant 1 is applied in the vertex shader, so the measurement has to
         apply it too or it is measuring a quad that is never drawn. This is
         what the first cut of the governor got wrong and why it could not be
         switched on: an instance a metre from the lens is collapsed to nothing
         up there, and counting it at its unclamped size put a single puff at
         43% of the frame and drove the estimate to 11.3 on a stage run whose
         real dust never covered more than a few per cent. */
      const burst = this.kind[i] > 2.5 && this.kind[i] < 4.5;
      /* Same window as the vertex shader, including its scaling by the
         instance's own height — see BURST_NEAR_GONE. Left as a constant here
         while the shader scaled it, the estimate counted a four-metre curtain
         two metres from the lens at its full unclamped size and reported the
         pool painting three frames' worth of dust in a frame that in fact
         held about ten per cent of one. That is the failure the first cut of
         this governor had, in the one class that had since grown large
         enough to reproduce it. */
      const near = burst
        ? smoothstep(Math.max(sy, 0.35) * BURST_NEAR_GONE,
          Math.max(sy, 0.35) * BURST_NEAR_FULL, depth)
        : smoothstep(NEAR_GONE, NEAR_FULL, depth);
      if (near <= 0) continue;
      const shrink = burst
        ? near
        : near * Math.min(1, SCREEN_CAP / Math.max((reach / depth) * this._projY, 1e-4));
      /* Half extents in normalised device coordinates, which span 2 across the
         frame. Billboards spin in the image plane, so the larger extent is
         taken on both axes rather than pretending a rotation cannot happen. */
      /* And what it paints rather than what it is placed on. A round puff's quad
         is enlarged by PLUME_QUAD so that its normalised shape fits inside it,
         which leaves the quad a third larger than the dust drawn on it — and the
         governor is a measure of pixels painted, so counting the card rather
         than the print raised the estimate by nearly a factor of two and started
         halving ordinary corners. The clamps above stay on the quad, because
         that is what the vertex shader clamps. */
      const paint = this.kind[i] < 0.5 ? reach / PLUME_QUAD : reach;
      const hw = (paint * 0.5 * shrink / depth) * this._projX;
      const hh = (paint * 0.5 * shrink / depth) * this._projY;
      /* And clipped to the frame it is a share of. Dust thirty metres off to
         the side is not in the picture, and the pool routinely has half its
         instances behind or beside a camera that has swung through a corner. */
      const ndcX = ((dx * rx + dy * ry + dz * rz) / depth) * this._projX;
      const ndcY = ((dx * ux + dy * uy + dz * uz) / depth) * this._projY;
      const spanX = Math.min(ndcX + hw, 1) - Math.max(ndcX - hw, -1);
      if (spanX <= 0) continue;
      const spanY = Math.min(ndcY + hh, 1) - Math.max(ndcY - hh, -1);
      if (spanY <= 0) continue;
      sum += spanX * 0.5 * spanY * 0.5 * COVER_FILL;
    }
    this.coverage = sum;
    this.gate = 1 - smoothstep(COVER_SOFT, COVER_HARD, sum + this.coverageBias);
  }

  /**
   * Invariant 2 applied to a continuous emission rate. Every rate in the
   * system is passed through here and none of them may be used raw.
   */
  admit(rate) {
    return this.governor ? rate * this.gate : rate;
  }

  /**
   * Invariant 2 applied to a one-off event's amplitude. An event is never
   * refused outright, only made smaller — see EVENT_FLOOR.
   */
  admitEvent(scale = 1) {
    if (!this.governor || this.gate >= 1) return scale;
    return scale * lerp(EVENT_FLOOR, 1, this.gate);
  }

  /**
   * The only place in the system a particle colour is produced.
   *
   * Takes the ground the particle came off and returns that ground's own hue
   * at a bounded multiple of its radiance. THREE.Color is linear here, so the
   * multiply is a multiply of light and the hue survives it — which is the
   * other half of the read: dust is the ground airborne, so it has to be the
   * ground's colour, and the only thing separating it from the ground is how
   * much brighter it is. Nothing else may return a colour, and there is
   * deliberately no argument for one.
   */
  _matter(lift, surface = 0) {
    const s = surface < 0 ? 0 : surface > 1 ? 1 : surface;
    return this._veilScratch.copy(GROUND_TARMAC).lerp(GROUND_VERGE, s)
      .multiplyScalar(Math.min(lift, LIFT_CEIL));
  }

  _spawn(px, py, pz, vx, vy, vz, ax, ay, az, size, growth, aspect, life,
    rotation, spin, drag, accelY, color, shape, kind = 0) {
    const i = this.cursor;
    this.cursor = (i + 1) % this.max;
    if (!this.active[i]) {
      this.active[i] = 1;
      this.live++;
    }
    const p3 = i * 3, p2 = i * 2;
    /* The round puff's shape is now normalised to fit inside the quad carrying
       it — see plumeSdf — and a shape that used to overhang its card by a third
       and be clipped there draws a third smaller once it is made to fit. The
       card is enlarged by the same factor in the one place a size is stored, so
       what changes is the clipping and not the apparent size of any dust in the
       game. Everything downstream reads scales: the near clamp, the screen cap
       and the coverage governor all see the quad it is actually drawn on. */
    if (kind < 0.5) {
      size *= PLUME_QUAD;
      growth *= PLUME_QUAD;
    }
    this.age[i] = 0;
    this.life[i] = life;
    this.centers[p3] = px;
    this.centers[p3 + 1] = py;
    this.centers[p3 + 2] = pz;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.axes[p3] = ax;
    this.axes[p3 + 1] = ay;
    this.axes[p3 + 2] = az;
    this.baseSize[i] = size;
    this.growth[i] = growth;
    this.aspect[i] = aspect;
    this.scales[p2] = size;
    this.scales[p2 + 1] = size * aspect;
    this.rotations[i] = rotation;
    this.spin[i] = spin;
    this.drag[i] = drag;
    this.accelY[i] = accelY;
    this.ages[i] = 0;
    this.shapes[i] = shape;
    this.kind[i] = kind;
    this.colors[p3] = color.r;
    this.colors[p3 + 1] = color.g;
    this.colors[p3 + 2] = color.b;
    this.mesh.visible = true;
  }

  /**
   * Off-road dirt and the on-road veil are one emitter but not one phenomenon,
   * so every property below is written as a tarmac range and a verge range and
   * interpolated by `surface`. One random draw feeds both ends of each pair, so
   * a wheel straddling the verge throws a puff that is genuinely halfway
   * between the two rather than one of each at random.
   *
   * The verge column is the plume that already works and is unchanged. The
   * tarmac column is a different thing entirely: darker, flatter, shorter
   * lived, and carried along with the car instead of dumped behind it.
   */
  emitDust(point, car, side, strength, surface) {
    const q = this.random;
    /* lo/hi on tarmac, then lo/hi on the verge. */
    const span = (loA, hiA, loB, hiB) => {
      const r = q.f();
      return lerp(loA + (hiA - loA) * r, loB + (hiB - loB) * r, surface);
    };
    const lateral = side * q.f(0.35, 1.15) + q.f(-0.55, 0.55);
    const back = q.f(0.2, 1.15);
    /* Off the road the tyre throws dirt upward. On tarmac nothing is thrown —
       a film of grit is dragged along the surface — so the veil stays a scud
       at axle height instead of climbing into a column beside the car. */
    const rise = span(0.10, 0.55, 1.31, 2.94);
    const spread = q.f(-0.34, 0.34) * lerp(1.8, 1.0, surface);
    /* Entrained in the car's wake. A puff with no forward velocity is left
       standing in the road while the car pulls away at fifty metres a second,
       and the veil then reads as litter behind you rather than as air you
       disturbed. Measured at 160 km/h the old carry still shed it eleven
       metres in half a second, which put it clear of the car and alone on the
       tarmac — the two conditions that make anything read as an object. Nearly
       full carry, and a light drag to keep it, holds it under the car for as
       long as it lives. Off the road the dust is thrown by the tyre rather
       than dragged by the body, so it keeps almost none of it. */
    const wake = (car.speed || 0) * lerp(0.94, 0.12, surface) * q.f(0.96, 1.04);
    const px = point.x + car.right.x * spread + car.forward.x * q.f(-0.22, 0.12) + car.up.x * q.f(0.02, 0.24);
    const py = point.y + car.right.y * spread + car.forward.y * q.f(-0.22, 0.12) + car.up.y * q.f(0.02, 0.24);
    const pz = point.z + car.right.z * spread + car.forward.z * q.f(-0.22, 0.12) + car.up.z * q.f(0.02, 0.24);
    this._spawn(
      px, py, pz,
      car.forward.x * (wake - back) + car.right.x * lateral + car.up.x * rise,
      car.forward.y * (wake - back) + car.right.y * lateral + car.up.y * rise,
      car.forward.z * (wake - back) + car.right.z * lateral + car.up.z * rise,
      car.forward.x, car.forward.y, car.forward.z,
      /* Bigger on tarmac than it was, not smaller. Small puffs at this rate
         land as separate dots with road between them, and a row of dots is
         countable; overlapping ones merge into a single moving film, and a
         film is not. The value drop below is what stops the larger shape
         becoming a larger object. */
      span(0.78, 1.42, 0.30, 1.10) * lerp(0.9, 1.2, strength),
      span(1.00, 1.90, 0.84, 1.92),
      /* Emphatically wider than tall. A puff that can be taller than it is
         wide is a lump standing on the road; one that is a third as tall as
         it is wide is a sheet lying along it. */
      span(0.26, 0.44, 0.58, 1.28),
      span(0.26, 0.46, 0.42, 1.04),
      /* Held flat on screen instead of spun freely. These quads are view
         aligned, so a rotation is a rotation in the image, and a shape three
         times wider than it is tall turned through a right angle is not a
         squashed puff any more — it is a column standing on the road. Half of
         them came out that way and read as little geysers beside the wheels.
         The plume's puffs are near enough round that a free spin costs it
         nothing, so it keeps one. */
      span(-0.22, 0.22, -3.14, 3.14), span(-0.20, 0.20, -1.1, 1.1),
      span(0.28, 0.38, 0.75, 1.30),
      span(0.05, 0.35, 0.90, 1.90),
      this._matter(lerp(LIFT.veil, LIFT.plume, surface), surface),
      q.f(), surface > 0.5 ? 0 : 0.05,
    );
  }

  emitDrift(point, car, side, strength, surface) {
    const q = this.random;
    const stationary = 1 - smoothstep(3, 10, car.speed);
    const slipSide = car.slipAngle < 0 ? -1 : 1;
    const movingLateral = slipSide * q.f(0.15, 1.15) + q.f(-1.75, 1.75);
    const burnoutLateral = side * q.f(1.15, 2.15) + q.f(-0.25, 0.25);
    const lateral = lerp(movingLateral, burnoutLateral, stationary);
    const rise = lerp(q.f(1.35, 2.75), q.f(0.45, 1.00), stationary);
    const back = q.f(0.08, 0.65);
    /* Scatter along the car's own axis too. Emitting from a point put every
       puff on one clean arc, and a clean arc of similar blobs is a string of
       beads however varied the blobs themselves are. */
    const along = q.f(-0.55, 0.30);
    const across = q.f(-0.40, 0.40);
    const lift = q.f(0.04, 0.42);
    const px = point.x + car.right.x * across + car.forward.x * along + car.up.x * lift;
    const py = point.y + car.right.y * across + car.forward.y * along + car.up.y * lift;
    const pz = point.z + car.right.z * across + car.forward.z * along + car.up.z * lift;
    const ax = car.forward.x * (1 - stationary) + car.right.x * side * stationary;
    const ay = car.forward.y * (1 - stationary) + car.right.y * side * stationary;
    const az = car.forward.z * (1 - stationary) + car.right.z * side * stationary;
    /* Squared draw: mostly small puffs with the occasional big one, so the
       trail has a size hierarchy instead of one repeated bead. Front-loaded
       into base size rather than growth so consecutive puffs already overlap
       where they are born and merge into a connected mass near the wheel. */
    const roll = q.f();
    this._spawn(
      px, py, pz,
      -car.forward.x * back + car.right.x * lateral + car.up.x * rise,
      -car.forward.y * back + car.right.y * lateral + car.up.y * rise,
      -car.forward.z * back + car.right.z * lateral + car.up.z * rise,
      ax, ay, az,
      lerp(0.46 + roll * roll * 1.30, q.f(0.40, 0.62), stationary) * lerp(0.94, 1.08, strength),
      lerp(q.f(0.50, 1.70), q.f(0.60, 0.92), stationary),
      lerp(q.f(0.52, 1.58), q.f(0.42, 0.68), stationary),
      lerp(q.f(0.85, 2.05), q.f(0.80, 1.10), stationary),
      q.f(-3.14, 3.14), q.f(-0.7, 0.7), q.f(0.45, 0.85),
      q.f(1.10, 2.30), this._matter(LIFT.drift, surface), q.f(),
      stationary > 0.5 ? 0 : 0.25,
    );
  }

  emitHeroDrift(point, car, strength, surface) {
    const q = this.random;
    const slipSide = car.slipAngle < 0 ? -1 : 1;
    const lateral = slipSide * q.f(0.35, 1.35) + q.f(-0.95, 0.95);
    const rise = q.f(1.45, 2.85);
    const back = q.f(0.2, 0.85);
    const behind = q.f(0.12, 0.36);
    this._spawn(
      point.x - car.forward.x * behind + car.up.x * 0.16,
      point.y - car.forward.y * behind + car.up.y * 0.16,
      point.z - car.forward.z * behind + car.up.z * 0.16,
      -car.forward.x * back + car.right.x * lateral + car.up.x * rise,
      -car.forward.y * back + car.right.y * lateral + car.up.y * rise,
      -car.forward.z * back + car.right.z * lateral + car.up.z * rise,
      car.forward.x, car.forward.y, car.forward.z,
      q.f(0.72, 1.55) * lerp(0.92, 1.12, strength),
      q.f(0.90, 2.20), q.f(0.62, 1.42), q.f(1.05, 2.15),
      q.f(-3.14, 3.14), q.f(-0.55, 0.55), q.f(0.42, 0.76),
      q.f(1.00, 2.05), this._matter(LIFT.drift, surface), q.f(), 0,
    );
  }

  /** A world-placed quad on the closed-form burst path. */
  _spawnBurst(px, py, pz, dx, dy, dz, ax, ay, az, cx, cy, cz,
    sizeX, growX, sizeY, growY, life, seg, speed, decel, color, shape, kind) {
    const i = this.cursor;
    this.cursor = (i + 1) % this.max;
    if (!this.active[i]) {
      this.active[i] = 1;
      this.live++;
    }
    const p3 = i * 3, p2 = i * 2;
    this.age[i] = 0;
    this.life[i] = life;
    this.origins[p3] = px;
    this.origins[p3 + 1] = py;
    this.origins[p3 + 2] = pz;
    this.centers[p3] = px;
    this.centers[p3 + 1] = py;
    this.centers[p3 + 2] = pz;
    /* Unit outward direction, not a velocity: the burst path never integrates
       these, it scales them by the travel it has already solved for. */
    this.vx[i] = dx;
    this.vy[i] = dy;
    this.vz[i] = dz;
    this.axes[p3] = ax;
    this.axes[p3 + 1] = ay;
    this.axes[p3 + 2] = az;
    this.travelV[i] = speed;
    this.travelA[i] = decel;
    this.baseSize[i] = sizeX;
    this.growth[i] = growX;
    this.baseSizeY[i] = sizeY;
    this.growthY[i] = growY;
    this.aspect[i] = 1;
    /* Carry velocity, in the three slots the damped path uses for spin, drag
       and buoyancy. The burst never reaches that code — it returns from the
       closed-form branch well before it — so these are free, and three more
       arrays for one vector that only one particle class has would not be. */
    this.spin[i] = cx;
    this.drag[i] = cy;
    this.accelY[i] = cz;
    this.scales[p2] = sizeX;
    this.scales[p2 + 1] = sizeY;
    this.rotations[i] = seg;
    this.ages[i] = 0;
    this.shapes[i] = shape;
    this.kind[i] = kind;
    this.colors[p3] = color.r;
    this.colors[p3 + 1] = color.g;
    this.colors[p3 + 2] = color.b;
    this.mesh.visible = true;
  }

  /**
   * One ground sheet and one closed curtain, both expanding, both gone inside
   * six tenths of a second.
   *
   * Thirteen instances replace the twenty-two discrete puffs this used to
   * throw, and they are thirteen pieces of two shapes rather than thirteen
   * things — the twelve chords share one contour function and one seed, so
   * nothing in the silhouette marks where one ends and the next begins.
   *
   * `strength` and `scale` are two different questions and the effect needs
   * both. Strength is how hard the contact was and it saturates by design at
   * 1, which is right: a landing cannot be more than fully hard. Scale is how
   * big the event is, and a ramp is a bigger event than a berm at the same
   * strength — the car fell four times as far and the ground answers on a
   * different order. With only strength to work with a ramp landing could not
   * be made to read as one, because it was already at the top of the only axis
   * there was.
   *
   * Scale is linear in curtain height, which is the dimension that carries the
   * read, and sublinear in everything else. Radius and duration grow with it
   * so the burst stays a burst rather than a taller version of the same ring,
   * and expansion speed grows a little faster than radius so a big landing
   * also spreads further relative to its own size.
   *
   *   1.0   the kerb hop and the berm drop the stage produces on its own,
   *         which is what every number below was tuned against
   *   3.4   a full-strength ramp landing: a 3.9 m curtain on a 4 m ring
   *   3.6   the ceiling, beyond which the ring is bigger than the road
   */
  emitLandingBurst(point, car, strength, surface = 0, scale = 1) {
    const q = this.random;
    /* One shape seed for the whole curtain. The crown contour is a function
       of world angle, so segments only agree across their shared arc if they
       are asking the same function — a per-segment seed would put a step in
       the silhouette at every join, which is how a wall becomes a row. */
    const shape = q.f();
    const up = car.up;
    const size = scale < 0.35 ? 0.35 : scale > 3.6 ? 3.6 : scale;
    /* Radius barely grows with scale, and that is the whole reason a big
       landing works. The ring is the thing the car has to get out of: grown in
       proportion to the height it stayed around the car for half a second,
       which is the failure the height was cut to avoid in the first place.
       Held near where it was, the car is clear of it inside a fifth of a
       second at landing speeds and what is left is a tall torn column of dust
       behind — which is the shot. */
    const radius = lerp(1.52, 2.02, strength) * Math.pow(size, 0.22);
    /* Sized so a hard landing tops out around three and a half metres. Run
       faster than this, the ring is a broken arc six metres from a car that
       has already driven out of it, and what is left is a few pale shapes
       lying on the road well away from anything — which is the scatter this
       was built to get rid of, arrived at from the other end.
     *
     * Halved, and measured rather than judged. At the old rate a full ramp
     * ring travelled 3.3 m outward, so it went from five metres across to
     * twelve inside its own lifetime — and a chase camera sixteen metres back
     * and looking down does not see a twelve-metre ring as a bigger burst, it
     * sees the near arc sweep past the bottom of the frame and leave. Captured
     * frame by frame that is precisely what happens: the mass fills 3.5% of
     * the frame at frame 3 and 0.23% at frame 6, and the reason is not that
     * the dust died — every instance is still alive and will be for another
     * fifty frames — it is that the dust left the picture. The energy that
     * was going sideways out of the shot now goes up in it, below. */
    const speed = lerp(2.10, 3.20, strength) * q.f(0.94, 1.06) * Math.pow(size, 0.12);
    const life = lerp(0.40, 0.54, strength) * Math.pow(size, 0.45);
    /* Decelerating expansion, brought to rest exactly as the burst dies. A
       ring that coasts out at a constant rate reads as something being blown
       along; one that leaves hard and settles reads as something that hit. */
    const decel = speed / life;
    /* Lower than the car rather than level with it. At 1.58 the curtain stood
       as tall as the body and closed around its lower half, so the car looked
       parked in the dust instead of having thrown it — and a shape that
       encloses the thing that made it stops reading as a consequence of the
       landing and starts reading as scenery. Kept under a metre and pushed
       wider instead: the same mass of dust spread flat leaves the car clear
       and puts the motion outward, which is the direction that says impact.
       A ramp landing overrides that through `scale`, and can afford to: the
       ring is wider in proportion and the car drives out of the front of it
       inside a quarter of a second. */
    const height = lerp(0.66, 1.16, strength) * size;
    /* A share of the car's own velocity, given to the whole burst — but not a
       fixed share, which is what it was.
     *
     * The fixed 0.35 was set against 240 km/h, where a burst pinned to the
     * contact point is eight metres behind the car within a tenth of a second
     * and a chase camera ten metres back drives through the ring and out the
     * far side before the dust has finished growing. That is a real problem
     * and the number solves it — at 66 m/s. Ramp landings do not happen at
     * 66 m/s. They happen at 17 to 19, where the same fraction leaves the ring
     * moving forward at only three metres a second less than the car, so it
     * never gets behind: the curtain grows around the car and stays there for
     * the whole event, which is the one thing the height was cut to avoid.
     *
     * So the share is on a curve instead of a constant, set low where landings
     * actually happen and high where the camera problem actually is. At 18 m/s
     * the car is clear of a full ramp ring in about a quarter of a second and
     * six metres ahead of it by the end.
     *
     * The top of the curve is now 0.74 rather than 0.42, because "landings
     * happen at 17 to 19 m/s" stopped being true this session — the ramps were
     * rebuilt after the stage's own incidental terrain was measured out-
     * jumping all three of them by more than four to one, and the same drive
     * that used to launch at 18 m/s now launches at 52. At 0.42 the ring is
     * left standing while the car leaves at thirty metres a second, and since
     * the chase camera goes with the car it arrives at the dust: measured
     * frame by frame the curtain starts sixteen metres in front of the lens
     * and is behind it inside a third of a second, which puts a hard ceiling
     * on how long the burst can be looked at no matter what its own curves
     * do. Nothing about the shape was ever the limit at these speeds; the
     * geometry was.
     *
     * 0.86 is also the physically honest end of the range rather than the
     * generous one. The veil the critic passed is dragged along at 0.94 of
     * the car's speed on tarmac, on the argument that a film of grit under a
     * body moving at fifty metres a second is entrained rather than left; a
     * four-metre column standing above the road is entrained a little less
     * completely than that film and a great deal more completely than a
     * stone.
     *
     * What the number actually buys is stated in metres: the ring drifts back
     * from the car at seven metres a second instead of thirty, so it sits in
     * the road between the car and the lens for the whole of its life and
     * ends it about nine metres in front of the camera. That is the shot. It
     * also keeps invariant 1 honest without the near clamp having to save it
     * — at 0.42 the ring arrived at the lens with four metres of curtain
     * still standing and filled the bottom third of the frame with an opaque
     * pale wall, and an opaque billboard that reaches the near plane is an
     * opaque frame however well it is drawn. */
    const v = car.speed || 0;
    const carry = v * lerp(0.16, 0.86, smoothstep(14, 55, v));
    const cx = car.forward.x * carry;
    const cy = car.forward.y * carry;
    const cz = car.forward.z * carry;

    /* The sheet outruns the curtain, so its lit rim is always clear of the
       wall rather than buried behind it. */
    /* And the sheet grows less again. It is a flat mat lying on the road, and
       the larger a mat is the more certainly it is a mat — the curtain is
       where a big landing is allowed to be big. */
    /* ── There is no ground sheet any more ──────────────────────────────────
     *
     * It was the burst's other half: one annulus lying in the road plane,
     * chosen because it "cannot be a scatter because it is one primitive, and
     * cannot be a solid because it lies in the surface it would have to sit
     * on". The second half of that was never true. A pale annulus on tarmac is
     * a mat, and the file's own note on it says a mat "is as solid a read as a
     * rock — it just lies down"; it has been caught reading as eight pale
     * plates, then as tan needles when its own fade narrowed it, and in the
     * capture that ended this round it is a smooth flat ring of cream on the
     * road wider than the car is long, which is a spill.
     *
     * Every argument for keeping it was about the curtain: something had to
     * hold the ring's contact with the road, because a wall standing on tarmac
     * with a hard straight foot is a piece of card on its end. The billows have
     * their own feet, so the job is gone. And the fade that was supposed to
     * retire it at road level is camera-dependent, which means it was never
     * absent, only sometimes absent — measured at 0.11 on one ramp and plainly
     * drawing on another. One primitive that is right from every camera beats
     * two where the second is right from some. */

    /* The curtain lifts, and the sheet does not.
     *
     * This is where the expansion speed that came off the ring above has
     * gone. Dust knocked out of a road by a landing does not travel outward
     * along it — the road is in the way — it is forced out, turns, and goes
     * up, and the going up is the whole of what separates a plume from a
     * puddle. Everything this burst had was horizontal, which is why every
     * capture of it is a pale shape lying on the tarmac and why the crown
     * disappears the moment the ring is wide enough for the camera to be
     * looking down into it rather than across it.
     *
     * Two terms, both on the same decelerating curve the carry uses, so the
     * mass rises quickly and then hangs rather than climbing at a constant
     * rate like something launched:
     *
     *   lift     the whole ring leaves the road, so there is air under it and
     *            the road's own value shows through beneath the mass. A
     *            shape with ground visible under it is airborne; one welded
     *            to the surface is a stain on it.
     *   climb    the wall grows taller as it widens, tied to the radial
     *            travel so a segment's height and its width stay on one
     *            solution and a long frame cannot desynchronise them.
     *
     * Sublinear in size, like the radius: a landing four times the scale
     * throws dust about twice as high, and a plume that grows with the full
     * scale would put a ten-metre bank of earth over a mountain road. */
    const travelMax = speed * life * 0.5;
    /* Enough to put air under the mass, not enough to launch it. At
       1.05..1.85 the whole plume rose about 1.6 m over its life, and measured
       against the road it came off, its lowest puff's foot went from 0.6 m
       below the surface at touchdown to a metre above it by the end — a mass
       hanging in the air with no contact and no shadow, which is the one
       reading a landing must not have. Roughly halved, the foot stays within a
       quarter of a metre of the road for the whole event and the plume still
       lifts clear of it. */
    const lift = lerp(0.60, 1.00, strength) * Math.pow(size, 0.42);
    const climb = height * 0.18 / Math.max(travelMax, 0.05);

    /* How high the mass stands, which is not the same question as how big the
     * event is, and separating the two is what stops the burst hiding the car.
     *
     * `height` is the event's size and everything scales off it, including how
     * far apart the billows are stacked. Left at full it built a column: on
     * seed 22 the mass reached 4.9 m over a road, out of twelve puffs each
     * 2.9 m across packed within 0.9 m of the centreline — taller than it was
     * wide, and four times the height of the car that threw it.
     *
     * The reason that hides the hero is geometric and it is worth writing down,
     * because the last three attempts to fix it all pushed on the wrong axis.
     * The chase lens sits about 5 m above the car and 14 m behind it, so the
     * sightline from lens to car falls to the road as it arrives. Measured on
     * seed 22 it passes 3.2 m behind the contact point at roughly 1.2 m above
     * the road, rising to 2.2 m for the car's roof. Anything standing higher
     * than that at that distance is not behind the car at all — it is between
     * the car and the lens. A 4.9 m column clears that sightline by two and a
     * half metres, so it does not partly cover the car, it covers all of it:
     * the car went from 3,419 px to 0 px for three frames.
     *
     * Two fifths, measured. It puts the mass's top at 3.4 m on seed 22 and
     * 3.0 m on seed 40 — still twice the car's height, so it reads as a burst
     * and not as a scuff — and the car never drops below 3,390 px. It is also
     * the direction the reference has always been in: an impact plume is low
     * and wide and behind, and this file has been calling for that in prose
     * while spending its scale on height.
     *
     * It is very nearly free, which is the part the previous round got wrong
     * by concluding "the only lever is the plume's size, and it is a direct
     * exchange against ink". Size is an exchange against ink, because ink on a
     * drawn mask is boundary over area. Height is not: cutting it takes the
     * mass out of the sightline while the union stays one body, and the ink
     * went the right way — 25.8% to 24.1% on seed 22, 12.6% to 11.5% on
     * seed 40. */
    const stand = height * 0.40;

    /* Both terms ride the carry vector, which is the one channel a burst quad
       has that is integrated on the same solved curve as its radius. Travel
       is speed x that curve exactly, so a vertical carry of speed * climb / 2
       is the same motion as "half the height it has grown" — which is what
       keeps a quad that is taller than it was standing on the road rather
       than sunk halfway into it. */
    const wallRise = lift + speed * climb * 0.5;
    const wx = cx + up.x * wallRise;
    const wy = cy + up.y * wallRise;
    const wz = cz + up.z * wallRise;

    /* ── The curtain is billows, not a wall ──────────────────────────────────
     *
     * It was twelve tall chord quads sharing one crown contour that is a
     * function of world angle alone, and that construction was chosen for a
     * good reason: nothing in the silhouette marks where one quad ends and the
     * next begins, so the ring cannot read as twelve objects. It worked. The
     * ring reads as one thing. The trouble is what that one thing is.
     *
     * A single contour over a closed ring is, by construction, one continuous
     * connected ribbon, and a ribbon is what it was measured to be: on seed 22
     * the largest connected component of the plume held 91% of it — 99 to 100%
     * on most frames — while filling only 0.38 of its own bounding box. Those
     * two numbers together have exactly one reading. A cluster of round masses
     * is many mid-sized components each filling about 0.7 of its box; one
     * component at 0.38 fill is one long tortuous sheet. And the two chords per
     * flank that stand nearly edge-on to the lens contribute their length as
     * depth, so they project as tall sharp points on that sheet's upper edge.
     * A smooth continuous band with three triangular points on it is a coronet,
     * and on seed 40's lighting it reads as gilt antlers. No amount of contour
     * tuning fixes that, because the ribbon is the primitive, not the finish.
     *
     * So the curtain becomes what a landing actually throws: a handful of
     * separate billows around the contact, each one a knot of overlapping round
     * puffs, with road visible between them. The earlier objection to puffs
     * still stands and is answered rather than ignored — "a handful of bright
     * convex silhouettes on grey tarmac is a handful of objects, because the eye
     * counts them before it reads any of them". Three things are different now:
     * the puffs are not convex, because the erosion that tears every other dust
     * puff in this file now applies to these; the erosion no longer breaks into
     * chips at close range, because it is band-limited to the pixels available;
     * and they are clustered rather than scattered, so what the eye counts is
     * six or seven billows of a mass, not twenty-four separate lumps.
     *
     * The clumps are stacked upward rather than spread along the arc. That is
     * what buys the height — the top puff of a clump carries the crown — while
     * keeping each clump narrow enough that the arc between clumps stays open.
     */
    /* Across the road behind the wheels, not around them.
     *
     * A ring was the wrong arrangement for two separate reasons and this fixes
     * both with one change. The first is what it draws: a ring at 2.7 m puts
     * two of its billows in front of the car where the body hides them and two
     * more out at the frame edges, so a chase camera gets clear tarmac behind
     * the wheels and dust at the roadside, which is the shot inside out — and a
     * mass that closes around the car "stops reading as a consequence of the
     * landing and starts reading as scenery", which is this file's own note on
     * why the curtain was kept below the car's height.
     *
     * The second is the pen, and it is the reason the ink measured ten to one
     * against world geometry rather than the four to one that was asked for.
     * The composite is a screen-space edge detector: these puffs share one ink
     * class and write one constant normal, so the only thing that can raise a
     * line between two of them is a step in depth. On a ring, neighbouring
     * billows are at genuinely different distances from the lens, so the pen
     * ruled a contour along every seam inside the mass and what came back was a
     * heap of separately outlined lumps — a cut-out with a drawn edge, exactly
     * as described, and no stroke width would have fixed it because the strokes
     * were not on the silhouette.
     *
     * A row across the road has all of its billows at one distance. The pen then
     * finds the union's outline and nothing inside it, which is what a painted
     * cloud has: one line round the mass, none between its lobes. It is also
     * the honest shape — a car landing at fifty metres a second does not leave a
     * symmetric ring of dust, it drags a broad transverse curtain out behind
     * itself — and it has no flanks, so there is nothing left to project as the
     * tall sharp points that made the old silhouette a coronet.
     *
     * Bowed rather than ruled, because a straight row of anything is a fence.
     * The bow is kept to a quarter of the ring radius so the depth spread across
     * it stays under what the pen calls an edge.
     */
    /* Half from the ring and half from the plume's height, and the split is
       load-bearing rather than cosmetic. Off the radius alone the puffs scale as
       size^0.22, so a landing the governor has shrunk to a third of its scale
       still draws puffs four-fifths the size of a full one — measured, an event
       the gate had closed on came back 79% as tall, and "an event is shrunk but
       never refused" stops meaning anything at that ratio. The height is linear
       in the scale, so mixing it in gives the governor something to bite on
       while the radius term keeps a small berm drop's puffs in proportion to the
       small ring they sit on. */
    const puffR = radius * 0.55 + height * 0.34;
    /* Half the curtain's width — and it is measured in puffs, not in ring
       radii, which is the fifth instance of this file's recurring bug.
     *
     * It was radius * 1.40 while the puffs it spaces are puffR, and the two
     * scale in different units: the radius goes as size^0.22 and the puff is
     * half radius and half height, and the height is linear in size. So the
     * gap between two billows grew by 1.33x from a kerb hop to a full ramp
     * landing while the billows themselves grew by 1.93x — measured on the
     * ramp, three clumps 2.5 m apart carrying puffs 2.9 m across, spread over
     * ten metres of road. Two things follow and both are the reported defect:
     * the mass is twice as wide as it should be, and its lobes are just far
     * enough apart not to merge, so the pen finds twelve silhouettes instead
     * of one.
     *
     * Spacing a row of round things is a question about the round things, so
     * it is asked in their units. A third of a puff radius between clump
     * centres is deep overlap by construction at every scale, which is what
     * makes the row one mass rather than a row. */
    const halfWide = puffR * 0.32;
    for (let k = 0; k < BURST_CLUMPS; k++) {
      /* Stratified across the road with jitter: evenly spaced billows are
         machined, and free placement lets two land on top of each other and
         leave a hole. */
      const lat01 = (k + 0.5 + q.f(-0.30, 0.30)) / BURST_CLUMPS * 2 - 1;
      const lateral = lat01 * halfWide;
      /* The bow, plus how far behind the contact this billow sits. Back far
         enough to clear the rear axle — the contact point is the mean of the
         four wheel patches, so it is the middle of the car, and dust that
         reads as thrown by the wheels has to start behind them.
       *
       * A fifth further back than that, and the sign of this term is not what
       * it looks like. Moving the mass back moves it toward the lens, which is
       * why the last round measured it as a straight loss and stopped. But the
       * sightline from lens to car falls as it arrives, so it is also the term
       * that decides how much room there is under that line: at 3.2 m behind
       * the contact the clearance is about 1.2 m, and it grows by roughly a
       * third of a metre for every further metre back. Against a 4.9 m column
       * that is worth nothing, and the measurement was right. Against a mass
       * that now stands to 3.4 m it is the second half of the fix — measured
       * on seed 22, the car's worst frame goes from 2,429 px to 3,390 px, and
       * the ink falls with it because a mass nearer the lens is a larger mask
       * and ink is boundary over area.
       *
       * A fifth and not more only because of what the burst is allowed to be.
       * Past about 1.4x the mass reaches the lens early enough that its peak
       * arrives sooner and larger, and the event measures shorter against its
       * own peak: 19 frames here, 17 at 1.4x, 16 at 1.6x, against a floor of
       * 18. The car keeps improving the whole way — this is the read running
       * out, not the geometry. */
      const back = radius * (1.61 - 0.26 * Math.abs(lat01));
      const tall = q.f(0.68, 1.16) * (1 - 0.30 * Math.abs(lat01));
      for (let n = 0; n < BURST_ROWS * BURST_COLS; n++) {
        const j = (n / BURST_COLS) | 0, i = n % BURST_COLS;
        const up01 = (j + q.f(0.0, 0.55)) / BURST_ROWS;
        /* Symmetric about the clump's own centre. Stratified as
           (i + [0, 0.62]) it was not — the two columns landed on [-0.50,-0.19]
           and [0.00, 0.31], so every clump leaned left by a tenth of its width
           and the whole plume leaned with it. */
        const arc01 = (i + 0.5 + q.f(-0.31, 0.31)) / BURST_COLS - 0.5;
        /* Domed: pinched at the foot, full through the body, drawn in at the
           head, and narrower at the flanks the higher it goes. A block of equal
           puffs is a block. */
        const shrink = (0.60 + 0.52 * Math.sin(Math.PI * Math.pow(up01, 0.72)))
          * (1 - 0.34 * Math.abs(arc01) * 2 * up01);
        /* The two rows have to overlap or the crown is a separate object. At
           0.88 the upper row sat up to 2.6 m above the lower one carrying
           puffs 2.9 m across, so the two only just touched and on a bad draw
           did not; 0.78 closes that to 2.3 m and the column stays connected
           from the road to its head. */
        const rise = stand * tall * (0.16 + up01 * 0.78);
        /* Same unit as the clump spacing above, and for the same reason: the
           column offset inside a clump is a distance between puffs. At
           1.85 * puffR the two columns of a clump were further apart than the
           clumps were, so there were no clumps — just twelve puffs strewn
           across ten metres. */
        const along = lateral + arc01 * 0.40 * puffR;
        /* The plume's own height, as the reference every puff's tone is measured
           against, so the rungs land at the same heights for all of them and the
           mass is painted rather than the puffs. */
        const sizeY = puffR * shrink * q.f(0.80, 1.06);
        /* The rungs the whole mass is painted off, so they have to be measured
           against the height the mass actually stands to and not against the
           event's size — off `height` the mass now occupies the bottom two
           rungs of six and is painted flat. */
        const plumeH = stand * 1.20;
        const packed = Math.floor(Math.min(rise / plumeH, 0.99) * 512)
          + Math.min(Math.max(sizeY / plumeH, 0.01), 0.98);
        /* Outward, for the radial travel: mostly backward, with a little
           sideways for the billows at the ends so the mass swells rather than
           translating rigidly. Mostly backward and not half-and-half, because
           this is the term that carries the plume off the road: at 0.55 the
           end billows spent nearly half of a 1.8 m travel going sideways, and
           a mass placed inside the kerbs at spawn was over them by the middle
           of its life. Behind the car is where it belongs anyway. */
        const ox = car.right.x * lat01 * 0.40 - car.forward.x * 0.95;
        const oy = car.right.y * lat01 * 0.40 - car.forward.y * 0.95;
        const oz = car.right.z * lat01 * 0.40 - car.forward.z * 0.95;
        const on = Math.max(Math.hypot(ox, oy, oz), 1e-4);
        this._spawnBurst(
          point.x + car.right.x * along - car.forward.x * back + up.x * rise,
          point.y + car.right.y * along - car.forward.y * back + up.y * rise,
          point.z + car.right.z * along - car.forward.z * back + up.z * rise,
          ox / on, oy / on, oz / on,
          car.right.x, car.right.y, car.right.z,
          /* The higher puffs of a billow ride more of the lift, so it leans and
             stretches as it rises instead of translating rigidly. */
          cx + up.x * wallRise * lerp(0.72, 1.34, up01),
          cy + up.y * wallRise * lerp(0.72, 1.34, up01),
          cz + up.z * wallRise * lerp(0.72, 1.34, up01),
          puffR * shrink, puffR * 0.18,
          sizeY, puffR * 0.18,
          life * q.f(0.44, 0.58), packed, speed, decel,
          this._matter(LIFT.burstWall, surface), q.f(), BURST_PUFF_KIND,
        );

      }
    }
  }

  /**
   * The lip.
   *
   * There was nothing here at all: the car left the ground in silence, and a
   * ramp whose surface produces no evidence of being driven over is a ramp the
   * car passed through rather than off. It is the cheaper half of the pair —
   * a launch throws far less than a landing, because the tyres are unloading
   * rather than being driven into the ground — but its absence is louder than
   * its size, since it is the frame the player is looking at when they commit.
   *
   * Not a ring. A ring is the signature of something arriving; this is a
   * scuff dragged backwards off the lip and then abandoned, so it carries none
   * of the car's velocity and is left standing where the wheels last were.
   * That is also what sells the launch: the dust stays put and the car does
   * not, which is the only cue in the frame that the two have separated.
   *
   * @param {number} scale the same axis emitLandingBurst takes, so a ramp
   * arms one number and both ends of its jump agree about how big it was.
   */
  emitTakeoff(point, car, strength, surface = 0, scale = 1) {
    const q = this.random;
    const size = scale < 0.35 ? 0.35 : scale > 3.6 ? 3.6 : scale;
    const grit = Math.pow(size, 0.5);
    const puffs = Math.max(2, Math.round(lerp(3, 6, strength) * grit));
    for (let k = 0; k < puffs; k++) {
      const back = q.f(1.4, 4.2) * grit;
      const lateral = q.f(-1.5, 1.5) * grit;
      /* Barely any. Dust thrown up at the lip hangs in front of the camera
         for the whole flight, and the flight is the shot. */
      const rise = q.f(0.15, 0.85);
      const along = q.f(-0.9, 0.25);
      const across = q.f(-0.7, 0.7);
      this._spawn(
        point.x + car.forward.x * along + car.right.x * across + car.up.x * 0.06,
        point.y + car.forward.y * along + car.right.y * across + car.up.y * 0.06,
        point.z + car.forward.z * along + car.right.z * across + car.up.z * 0.06,
        -car.forward.x * back + car.right.x * lateral + car.up.x * rise,
        -car.forward.y * back + car.right.y * lateral + car.up.y * rise,
        -car.forward.z * back + car.right.z * lateral + car.up.z * rise,
        car.forward.x, car.forward.y, car.forward.z,
        q.f(0.52, 0.98) * lerp(0.9, 1.2, strength) * grit,
        q.f(0.55, 1.35), 
        /* Wider than tall, like the veil and for the same reason: this sits on
           the road surface in the middle of the frame and a shape that stands
           up off it is an object standing on the ramp. */
        q.f(0.30, 0.52),
        q.f(0.34, 0.62) * Math.pow(size, 0.3),
        q.f(-0.3, 0.3), q.f(-0.25, 0.25), q.f(0.9, 1.6), q.f(0.10, 0.45),
        this._matter(lerp(LIFT.veil, LIFT.plume, surface), surface),
        q.f(), surface > 0.5 ? 0 : 0.05,
      );
    }
    /* And a little thrown grit, which is the part that says the surface was
       loose. Solid, so it sits on the ground's own rungs and falls. */
    const chunks = Math.max(1, Math.round(lerp(1, 3, strength) * grit));
    for (let k = 0; k < chunks; k++) {
      const back = q.f(2.0, 5.5) * grit;
      const lateral = q.f(-2.2, 2.2);
      const rise = q.f(1.2, 3.4) * grit;
      this._spawn(
        point.x + car.up.x * 0.10, point.y + car.up.y * 0.10, point.z + car.up.z * 0.10,
        -car.forward.x * back + car.right.x * lateral + car.up.x * rise,
        -car.forward.y * back + car.right.y * lateral + car.up.y * rise,
        -car.forward.z * back + car.right.z * lateral + car.up.z * rise,
        car.right.x, car.right.y, car.right.z,
        q.f(0.16, 0.30), q.f(0.30, 0.62), q.f(0.52, 0.80),
        q.f(0.45, 0.80), q.f(-Math.PI, Math.PI), q.f(-2.4, 2.4),
        q.f(1.2, 1.9), q.f(-0.9, -0.35), this._matter(LIFT.debris, surface), q.f(), 1,
      );
    }
  }

  /**
   * @param {number} scale invariant 2's allowance, 0..1. A crowded frame gets
   * fewer pieces of the same scrape rather than a smaller one — thinning a
   * scatter is what a scatter can afford to lose.
   */
  emitImpact(point, car, side, strength, surface = 0, scale = 1) {
    const q = this.random;
    const share = scale < 0 ? 0 : scale > 1 ? 1 : scale;
    const ox = car.up.x * 0.34 + car.right.x * side * 0.24 + car.forward.x * 0.18;
    const oy = car.up.y * 0.34 + car.right.y * side * 0.24 + car.forward.y * 0.18;
    const oz = car.up.z * 0.34 + car.right.z * side * 0.24 + car.forward.z * 0.18;
    const puffs = Math.max(2, Math.round(7 * share));
    for (let k = 0; k < puffs; k++) {
      const inward = side * q.f(1.2, 3.0);
      const fore = q.f(1.0, 3.2);
      const rise = q.f(0.5, 1.7);
      this._spawn(
        point.x + ox, point.y + oy, point.z + oz,
        car.right.x * inward + car.forward.x * fore + car.up.x * rise,
        car.right.y * inward + car.forward.y * fore + car.up.y * rise,
        car.right.z * inward + car.forward.z * fore + car.up.z * rise,
        car.right.x, car.right.y, car.right.z,
        q.f(0.46, 0.76), q.f(0.95, 1.45), q.f(0.62, 0.92),
        q.f(0.78, 1.16), q.f(-1.0, 1.0), q.f(-1.4, 1.4),
        q.f(0.8, 1.2), q.f(0.05, 0.30), this._matter(LIFT.plume, surface), q.f(), 0,
      );
    }
    const chunks = Math.max(1, Math.round(3 * share));
    for (let k = 0; k < chunks; k++) {
      const inward = side * q.f(2.8, 7.0);
      const fore = q.f(1.2, 5.2);
      const rise = q.f(0.4, 3.4);
      const speed = q.f(1.55, 2.15);
      const dx = car.right.x * inward + car.forward.x * fore + car.up.x * rise;
      const dy = car.right.y * inward + car.forward.y * fore + car.up.y * rise;
      const dz = car.right.z * inward + car.forward.z * fore + car.up.z * rise;
      this._spawn(
        point.x + ox, point.y + oy, point.z + oz, dx * speed, dy * speed, dz * speed,
        dx, dy, dz,
        q.f(0.22, 0.38), q.f(0.55, 0.9), q.f(0.48, 0.72),
        q.f(0.58, 0.92), q.f(-Math.PI, Math.PI), q.f(-2.2, 2.2),
        q.f(1.4, 2.1), q.f(-0.8, -0.25), this._matter(LIFT.debris, surface), q.f(), 1,
      );
    }
  }

  emitBraking(point, car, side, strength, surface) {
    const q = this.random;
    const carryF = car.vx * 0.68;
    const carryR = car.vy * 0.68;
    const back = q.f(1.2, 3.1);
    const lateral = side * q.f(0.25, 0.85) + q.f(-0.30, 0.30);
    const rise = q.f(0.70, 1.50);
    const foreJitter = q.f(-0.10, 0.03);
    const sideJitter = q.f(-0.10, 0.10);
    this._spawn(
      point.x + car.forward.x * foreJitter + car.right.x * sideJitter + car.up.x * 0.07,
      point.y + car.forward.y * foreJitter + car.right.y * sideJitter + car.up.y * 0.07,
      point.z + car.forward.z * foreJitter + car.right.z * sideJitter + car.up.z * 0.07,
      car.forward.x * (carryF - back) + car.right.x * (carryR + lateral) + car.up.x * rise,
      car.forward.y * (carryF - back) + car.right.y * (carryR + lateral) + car.up.y * rise,
      car.forward.z * (carryF - back) + car.right.z * (carryR + lateral) + car.up.z * rise,
      car.forward.x, car.forward.y, car.forward.z,
      q.f(0.62, 0.95) * lerp(0.88, 1.16, strength),
      q.f(1.50, 2.20), q.f(0.42, 0.60), q.f(0.40, 0.58),
      q.f(-0.65, 0.65), q.f(-0.8, 0.8), q.f(0.9, 1.5),
      q.f(0.15, 0.45), this._matter(lerp(LIFT.veil, LIFT.drift, surface), surface),
      q.f(), 0,
    );
  }

  emitSpeedWake(point, car, side, strength, surface = 0) {
    const q = this.random;
    const back = q.f(2.2, 4.8);
    const lateral = side * q.f(0.35, 1.2);
    const carryF = car.vx * 0.78;
    const carryR = car.vy * 0.78;
    const lift = q.f(0.10, 0.34);
    const sideOffset = side * q.f(0.85, 1.55);
    this._spawn(
      point.x + car.right.x * sideOffset + car.up.x * 0.90,
      point.y + car.right.y * sideOffset + car.up.y * 0.90,
      point.z + car.right.z * sideOffset + car.up.z * 0.90,
      car.forward.x * (carryF - back) + car.right.x * (carryR + lateral) + car.up.x * lift,
      car.forward.y * (carryF - back) + car.right.y * (carryR + lateral) + car.up.y * lift,
      car.forward.z * (carryF - back) + car.right.z * (carryR + lateral) + car.up.z * lift,
      side, -1.0, 0,
      /* Length on the clock, not in metres.
       *
       * Half a metre of streak was half a metre of streak at forty km/h and at
       * two hundred, and a wake is the one thing in this pool that has no size
       * of its own: it is a length of air that went past, so its length is a
       * speed multiplied by a time. Pinned, it comes out at the speeds that
       * matter as a short fat rod — an object — and only looks like a smear at
       * the speeds where it is barely emitted. On the exposure the rest of the
       * shape already implies, about a tenth of a second, it is a third of a
       * metre at a crawl and better than two metres flat out, which is a smear.
       * Held to the aspect by the same factor, so it lengthens rather than
       * swelling: a rod that grows in both directions is a bigger rod. */
      q.f(0.55, 0.90) * lerp(0.82, 1.08, strength) * lerp(0.62, 2.35,
        smoothstep(8, 62, Math.abs(car.speed || 0))),
      q.f(0.10, 0.22),
      q.f(0.25, 0.34) * lerp(1.0, 0.44, smoothstep(8, 62, Math.abs(car.speed || 0))),
      q.f(0.08, 0.14),
      q.f(-0.08, 0.08), q.f(-0.16, 0.16), q.f(1.5, 2.4),
      q.f(-0.1, 0.05), this._matter(LIFT.wake, surface), q.f(), 2,
    );
  }

  emitSpeedDust(point, car, side, strength, surface = 0) {
    const q = this.random;
    const back = q.f(1.2, 2.8);
    const lateral = side * q.f(0.35, 0.9);
    const carryF = car.vx * 0.78;
    const carryR = car.vy * 0.78;
    const lift = q.f(0.2, 0.55);
    this._spawn(
      point.x + car.up.x * 0.07, point.y + car.up.y * 0.07, point.z + car.up.z * 0.07,
      car.forward.x * (carryF - back) + car.right.x * (carryR + lateral) + car.up.x * lift,
      car.forward.y * (carryF - back) + car.right.y * (carryR + lateral) + car.up.y * lift,
      car.forward.z * (carryF - back) + car.right.z * (carryR + lateral) + car.up.z * lift,
      car.forward.x, car.forward.y, car.forward.z,
      /* Wider, flatter and in the veil's value, for the same reason the veil
         itself is: these sit on the road right beside the wheels, which is the
         least forgiving place in the frame for a pale opaque shape. */
      q.f(0.40, 0.66) * lerp(0.85, 1.08, strength),
      /* Round, near enough. This was a third as tall as it was wide, laid along
         the car's forward axis — and from a chase camera the forward axis is the
         eye ray, so the wide dimension was the one pointing at the lens. With
         the projection honest that leaves a shape a sixth of a metre across:
         the class exists to put a soft patch of dust at the tyre line and it had
         become a dot. Given no long axis worth keeping, it is better off with
         none at all, because an isotropic billboard cannot degenerate at any
         viewing angle, which is one fewer thing that can come back. */
      q.f(0.30, 0.62), q.f(0.95, 1.45), q.f(0.10, 0.22),
      q.f(-0.20, 0.20), q.f(-0.25, 0.25), q.f(1.5, 2.2),
      q.f(0.10, 0.35), this._matter(LIFT.veil, surface), q.f(), 0.05,
    );
  }

  update(dt) {
    let liveSpeed = 0;
    let liveChunks = 0;
    let liveGroundSlaps = 0;
    for (let i = 0; i < this.max; i++) {
      if (!this.active[i]) continue;
      const age = this.age[i] + dt;
      this.age[i] = age;
      if (age >= this.life[i]) {
        this.active[i] = 0;
        this.ages[i] = 1;
        this.scales[i * 2] = this.scales[i * 2 + 1] = 0;
        this.live--;
        continue;
      }
      const kind = this.kind[i];
      if (kind > 2.5) liveGroundSlaps++;
      else if (kind > 1.5) liveSpeed++;
      else if (kind > 0.5) liveChunks++;
      if (kind > 2.5) {
        /* Solved rather than stepped, and the same solution drives both the
           position and the width: the ring reaches a given radius and each
           quad reaches exactly its share of that circumference in the same
           frame, however the frame rate happens to fall. Travel is held at
           the stopping point so a long frame cannot pull the ring back in. */
        const stop = this.travelV[i] / this.travelA[i];
        const t = Math.min(age, stop);
        const travel = this.travelV[i] * t - 0.5 * this.travelA[i] * t * t;
        /* Part of the burst goes with the car. Dust thrown up under a car at
           sixty metres a second does not stand still in the road — it is
           caught in the wake — and at ramp speeds the difference is whether
           the player sees the burst at all: with none of it, the chase camera
           overtakes and passes through the ring inside a sixth of a second.
           Slowed to nothing over the life on the same curve the radius uses. */
        const carry = t - 0.5 * t * t / this.life[i];
        const p3b = i * 3, p2b = i * 2;
        this.centers[p3b] = this.origins[p3b] + this.vx[i] * travel + this.spin[i] * carry;
        this.centers[p3b + 1] = this.origins[p3b + 1] + this.vy[i] * travel + this.drag[i] * carry;
        this.centers[p3b + 2] = this.origins[p3b + 2] + this.vz[i] * travel + this.accelY[i] * carry;
        this.scales[p2b] = this.baseSize[i] + this.growth[i] * travel;
        this.scales[p2b + 1] = this.baseSizeY[i] + this.growthY[i] * travel;
        this.ages[i] = age / this.life[i];
        continue;
      }
      const damping = 1 / (1 + this.drag[i] * dt);
      this.vx[i] *= damping;
      this.vy[i] = this.vy[i] * damping + this.accelY[i] * dt;
      this.vz[i] *= damping;
      const p3 = i * 3, p2 = i * 2;
      this.centers[p3] += this.vx[i] * dt;
      this.centers[p3 + 1] += this.vy[i] * dt;
      this.centers[p3 + 2] += this.vz[i] * dt;
      this.rotations[i] += this.spin[i] * dt;
      const fraction = age / this.life[i];
      const appear = lerp(0.78, 1, smoothstep(0, 0.08, age));
      const vanish = smoothstep(0.84, 1, fraction);
      const size = (this.baseSize[i] + this.growth[i] * age)
        * appear * lerp(1, 0.42, vanish);
      this.scales[p2] = size;
      this.scales[p2 + 1] = size * this.aspect[i];
      this.ages[i] = fraction;
    }
    this.liveSpeed = liveSpeed;
    this.liveChunks = liveChunks;
    this.liveGroundSlaps = liveGroundSlaps;
    this._measureCoverage();
    this.mesh.visible = this.live > 0;
    if (!this.mesh.visible) return;
    this.centerAttr.needsUpdate = true;
    this.axisAttr.needsUpdate = true;
    this.scaleAttr.needsUpdate = true;
    this.rotationAttr.needsUpdate = true;
    this.ageAttr.needsUpdate = true;
    this.shapeAttr.needsUpdate = true;
    this.kindAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
  }

  reset() {
    this.active.fill(0);
    this.ages.fill(1);
    this.scales.fill(0);
    this.cursor = 0;
    this.live = 0;
    this.liveSpeed = 0;
    this.liveChunks = 0;
    this.liveGroundSlaps = 0;
    this.coverage = 0;
    this.gate = 1;
    this.mesh.visible = false;
    this._resetRandom();
    this.ageAttr.needsUpdate = true;
    this.scaleAttr.needsUpdate = true;
  }

  dispose() {
    unregisterPrepassMesh(this.mesh);
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.prepassMaterial.dispose();
  }
}
