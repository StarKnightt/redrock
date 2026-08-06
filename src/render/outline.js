/**
 * Ink outlines by screen-space edge detection.
 *
 * The cheap way to outline a low-poly car is an inverted hull — scale the mesh
 * up, flip it, paint it black. It costs one extra draw and it looks fine on the
 * car. It does nothing at all for the road, the berms or the canyon, because
 * those have no silhouette to expand: the edges that matter there are creases
 * between two faces of the same mesh, and a hull pass cannot see them.
 *
 * So: a prepass writes view-space normals and depth, and a full-screen pass
 * inks wherever either one breaks. Depth catches silhouettes and the horizon,
 * normals catch creases inside a silhouette. Two scene passes over 80k
 * triangles is nothing on any GPU that can run this at all.
 */
import * as THREE from 'three';

/* The grade is intentionally an analytic colour transform rather than a LUT.
   A LUT needs trilinear interpolation and can smear close cel values toward
   one another; these point operations map every flat band to another flat
   band. Values are linear-light numbers because the beauty target is linear. */
/* Numbers here were a few percent of everything and a designed look of
   nothing: grade-on and grade-off frames differed by a marginal warm push on
   the sky and were otherwise the same picture. A comic page is printed, and
   printing does two things this stage was not doing — it holds a real black
   and a real paper white at the ends of the scale, and it separates light from
   shadow by hue and not only by value. Both are worth much more here than any
   amount of channel-mixer nudging, because the whole palette sits inside a
   35° hue window and value contrast alone has nowhere left to go. */
const DESERT_GRADE = Object.freeze({
  lift: [0.0, 0.0, 0.0],
  gamma: [1.01, 1.00, 0.98],
  /* Barely above unity. At 1.04 the red channel pinned three of the six cells
     of the golden-sky ramp at full, and a sky whose top three steps are all
     255 in red has no gradation left in the part of it the eye goes to. */
  gain: [1.02, 1.01, 1.00],
  contrast: 1.14,
  /* Down from 1.16, because saturateSafe now delivers the boost where there is
     room for it rather than spending it on colours that were already at the
     edge of the gamut. Less nominal saturation, more of it surviving. */
  saturation: 1.10,
  /* Shadows are cooled toward violet-blue, and the cooling is now mostly
     subtractive rather than a boost on the blue channel.
     A multiply of 1.42 on blue is a gentle cool cast over terracotta, which
     has plenty of blue underneath it to scale. Over a palette that also
     contains greens and yellows it is not a cast at all — it multiplies a
     channel that is nearly zero, so it dominates the ratio between channels
     and rotates the hue instead of cooling it. Measured on the chart, dark
     grass came back as teal and dark yellow as mauve, an 84 degree swing.
     Pulling the warm channels down instead moves every hue by roughly the
     same small amount whatever its blue content, and the sky fill below does
     the visible cooling — additively, which is both what skylight physically
     does in a shadow and the one form that cannot rotate a hue, because it
     adds the same absolute amount to everything it touches. */
  shadowHue: [0.88, 0.95, 1.18],
  shadowHueMix: 0.60,
  /* Golden-hour shade is coloured, not grey — this is the Ghibli half of the
     brief, and 0.92 was quietly washing it out. */
  shadowSaturation: 0.96,
  highlightHue: [1.035, 1.005, 0.95],
  highlightHueMix: 0.42,
  /* The sky fill. Bounded by the headroom left in each channel, so it can
     neither clip a highlight nor cut into a colour's body — but it is an
     absolute quantity, and linear light is unforgiving at the bottom: at
     0.038 it landed the blue channel of every dark cell in the chart on the
     same value regardless of hue, so grass, cliff, yellow and orange all went
     to one violet-grey in shade. That is the hue monotony the whole change is
     meant to escape, arrived at from the other end. Small enough to read as
     sky on a dark surface without becoming the surface. */
  shadowTint: [0.000, 0.005, 0.016],
  highlightTint: [0.032, 0.022, 0.004],
  /* Near identity. The mixer was a warm push for a stage that was already one
     hue, and on saturated primaries an off-diagonal term is a hue rotation
     applied to exactly the colours with the least room to absorb it. */
  mixerR: [1.012, -0.008, -0.004],
  mixerG: [0.004, 1.008, -0.002],
  mixerB: [-0.004, 0.004, 1.012],
  /* A printed toe and shoulder. The toe is what lets the tyres, the deep
     canyon shadow and the ink itself reach an actual black instead of the
     mid-grey everything sat at; the shoulder keeps the clouds and the key
     side of the sand at paper white without clipping them into a flat patch.
     These are linear-light numbers, and linear light is very unforgiving
     here: a toe of 0.05 sounds like a nudge and is in fact the bottom quarter
     of the sRGB scale, which flattens every shadow in the stage to solid
     black. Genuine blacks come from the bottom rung of the value ladder; the
     toe only needs to make sure that rung actually lands on zero. */
  /* Below the ladder's lowest non-zero rung, so that rung survives as a very
     dark tone and only the ladder's true zero prints as black. Set above it —
     as 0.006 was — and the bottom rung is unreachable, which puts a cliff
     between "deep shadow" and "nothing" and loses every shape inside it. */
  toe: 0.0012,
  /* Down from 0.96, which never engaged. The ladder's top rung is a luminance
     of 1.0 and nothing in a golden-hour stage is a neutral that bright, so the
     brightest thing in the frame — cloud tops, the sunlit side of a cliff —
     was landing on rung six at a linear 0.63 and stopping there. Measured
     across the run, the top decile held under half a percent of every frame:
     plenty of bright material, no held highlight anywhere in it.
     Bringing the shoulder down to where rung six actually sits gives the top
     of the range somewhere to go. It lifts the whole curve with it, which on a
     stage this dark is wanted, and because it is a global monotone remap
     applied after the ladder it moves every pixel on a rung together — the
     bands stay flat and nothing re-banded. */
  shoulder: 0.82,
  /* Cool corners against a warm centre. The desert version tinted the corners
     warm, which on a stage that was already warm everywhere just darkened
     them; against a golden key the complementary direction is what makes the
     middle of the frame read as sunlit rather than as merely brighter. */
  vignetteTint: [0.66, 0.64, 0.76],
  vignetteStrength: 0.15,
  speedSaturation: 0.055,
  speedVignette: 0.035,
});

/* The prepass writes a view-space geometric normal and a linear view distance
   into one buffer.
   Geometric, from screen-space derivatives, rather than the interpolated vertex
   normal: an override material loses the original material's flat shading, so
   on any mesh with shared vertices the creases the ink is supposed to find have
   been smoothed away before the edge detector ever sees them. The cross product
   of the view-position derivatives is the true face normal regardless.
   Linear distance rather than the hardware depth buffer: with a 0.4 m near
   plane and a 4 km far plane, the second derivative of nonlinear depth is pure
   noise past a couple of hundred metres, and it inks the middle distance with
   scribble. */
const PRE_VERT = /* glsl */`
varying vec3 vViewPos;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

/* Distance and an object class share the alpha channel.
   The single most important line in a racing game is where the road stops and
   the desert starts, and neither of the two detectors can see it: the surfaces
   are adjacent, near enough coplanar, and belong to the same continuous
   silhouette, so there is no depth step and no crease. It is a boundary
   between two *things*, which is a fact about the scene graph rather than
   about the geometry, and the only way for a screen-space pass to know it is
   to be told.
   Packed into the normal's red channel rather than into the distance channel
   or a second target. Distance is the one number in this buffer that has to
   stay exact — the edge measure is a second difference of its reciprocal, so
   it amplifies whatever noise is in it — and biasing a 4 km range by a class
   offset costs enough of the float's mantissa to put a floor under the near
   field. Red is a 0..1 encoded normal component: offsetting it by four per
   class leaves the recovered direction accurate to a millionth. */
// A GLSL literal: template interpolation of the number 4.0 yields "4", which
// is an int in GLSL ES and will not divide a float.
const ID_SCALE = '4.0';

/* One class is reserved for volumetric surfaces — presently the car's dust.
   They occupy the prepass so that they occlude other objects' edges, and the
   composite then declines to draw any edge of their own. See the gate in the
   composite and registerPrepassMesh below. */
const VOLUME_ID = '6.0';
/* One class is reserved for the landing burst — a volumetric surface that does
   want a contour. It takes the same pen as any unclassified prop (see the
   class-weight mix at the end of the composite, which leaves it on uWOther)
   and differs from one in exactly one respect: a depth step between two of its
   own fragments raises no line. See the gate beside the volumetric one. */
const BURST_ID = '7.0';
export const INK_ID_SCALE = 4;
export const INK_VOLUME_CLASS = 6;
export const INK_BURST_CLASS = 7;

const PRE_FRAG = /* glsl */`
precision highp float;
varying vec3 vViewPos;
uniform float uInkId;
void main() {
  vec3 n = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
  gl_FragColor = vec4(n * 0.5 + 0.5 + vec3(uInkId * ${ID_SCALE}, 0.0, 0.0), -vViewPos.z);
}`;

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;

uniform sampler2D tColor;
uniform sampler2D tNormal;
uniform vec2  uTexel;
uniform float uFar;
uniform float uThickness;
uniform float uWeightScale;
uniform float uDepthEdge;
uniform float uNormalEdge;
uniform float uIdEdge;
uniform vec3  uInk;
uniform float uInkFloor;
uniform float uInkFloorHero;
uniform float uCreaseInk;
uniform float uFadeStart;
uniform float uFadeEnd;
uniform float uInkEnabled;

/* Per-class pen weights. See the note above the mix at the end of main(). */
uniform float uWRoad;
uniform float uWBerm;
uniform float uWLandNear;
uniform float uWLandFar;
uniform float uWShell;
uniform float uWRail;
uniform float uWOther;
uniform float uCliffCrease;

uniform float uMottleAmp;
uniform float uWRoadMottle;
uniform vec2  uMottleFreq;
uniform mat4  uCamWorld;
uniform vec2  uTanHalf;

uniform float uGradeAmount;
uniform vec3  uLift;
uniform vec3  uGamma;
uniform vec3  uGain;
uniform float uContrast;
uniform float uSaturation;
uniform float uShadowSaturation;
uniform vec3  uShadowHue;
uniform float uShadowHueMix;
uniform vec3  uHighlightHue;
uniform float uHighlightHueMix;
uniform vec3  uShadowTint;
uniform vec3  uHighlightTint;
uniform float uToe;
uniform float uShoulder;
uniform vec3  uMixerR;
uniform vec3  uMixerG;
uniform vec3  uMixerB;

uniform float uVignetteAmount;
uniform vec3  uVignetteTint;
uniform float uVignetteStrength;
uniform float uSpeedSaturation;
uniform float uSpeedVignette;
uniform float uSpeed;

uniform float uImpact;
uniform vec2  uImpactAxis;

/* Background pixels were never written by the prepass, so their distance
   reads as zero. Pushed out to the far plane instead, they give the horizon
   the large discontinuity that inks every silhouette against the sky. */
/* One fetch per tap, decoded three ways.
   Distance, surface class and normal all live in the same texel, so reading
   the texture once per tap and unpacking is the difference between eight
   samples per pixel and fifteen. */
vec4 probe(vec2 uv) { return texture2D(tNormal, uv); }

float dist(vec4 t) {
  return t.a <= 0.0 ? uFar : t.a;
}

/* Background pixels carry class 0, and so does anything unclassified, so an
   unclassified object against the sky raises no ID edge — the depth step
   already draws that one. */
float inkId(vec4 t) {
  return floor(t.r / ${ID_SCALE});
}

vec3 viewNormal(vec4 t) {
  vec3 raw = t.xyz;
  raw.r -= floor(raw.r / ${ID_SCALE}) * ${ID_SCALE};
  return normalize(raw * 2.0 - 1.0);
}

/* Saturation that cannot cut a channel off.
   mix(grey, c, s) with s above one extrapolates away from grey, and for any
   colour whose darkest channel is already near its luminance that line crosses
   zero before it gets there. After the clamp the channel is simply gone: the
   colour has no body left, it reads as ink rather than as paint, and every
   later operation in the grade moves its hue instead of its saturation.
   On a stage painted in one hue this never showed, because a terracotta has
   plenty of blue underneath it. Measured on the coastal chart
   (tools/gamut.mjs) it was happening to ocean, teal, grass, magenta, yellow
   and orange alike — every saturated family came back with a dead channel and
   a hue shift to go with it, the largest of them 78 degrees.
   Capping the amount per pixel at the point where the darkest channel would
   reach zero puts the boost where there is actually room for it, which is the
   desaturated middle of the frame, and leaves colours that are already at the
   edge of the gamut alone. That is also the right artistic answer: a poster
   palette wants its greys pushed and its primaries left where the artist put
   them. */
vec3 saturateSafe(vec3 c, float s) {
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float room = y - min(c.r, min(c.g, c.b));
  float sMax = room > 1e-4 ? y / room : 1e4;
  /* Only a third of the way to the boundary, not nine tenths. The cap only
     ever binds on colours that are already saturated, so how close it is
     allowed to get is precisely how much body those colours keep: at 0.9 a
     lit green went from a blue channel of 77 to one of 8 and came back
     fluorescent, which is the failure this function exists to prevent. */
  return mix(vec3(y), c, min(s, 1.0 + (sMax - 1.0) * 0.35));
}

float classIs(float id, float want) { return 1.0 - step(0.5, abs(id - want)); }

/* Value noise in world space, for the band mottling.
   World space and not screen space: at 2-6 m a screen-space blob is the same
   size as a world one at a single distance only, and it slides across the
   terrain as the camera moves, which reads as a dirty lens rather than as
   paint. Reconstructed from the prepass distance, so it costs no extra
   geometry — see the ray build in main(). */
float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i + vec3(0.0, 0.0, 0.0)), hash31(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash31(i + vec3(0.0, 1.0, 0.0)), hash31(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hash31(i + vec3(0.0, 0.0, 1.0)), hash31(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash31(i + vec3(0.0, 1.0, 1.0)), hash31(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}

vec3 desertGrade(vec3 source) {
  vec3 c = source + uLift * (1.0 - min(source, vec3(1.0)));
  c = pow(max(c, vec3(0.0)), 1.0 / uGamma) * uGain;
  /* Contrast as a power about mid grey, not as a slope through it.
     A slope of s about 0.18 sends everything below 0.18 * (1 - 1/s) negative,
     and the clamp that follows turns it into solid black — at s = 1.12 that
     is every linear channel under 0.019, which is the bottom fifteen percent
     of the sRGB scale. In a stage where whole cliff faces and long stretches
     of road are lit by sky fill alone, that quietly deleted them: the shadow
     side of frame 044 had no road surface in it at all. The power form has
     the same effect on the midtones, is monotonic everywhere, and cannot
     reach zero from a non-zero input.
     Applied to luminance and scaled back onto the colour, rather than to each
     channel separately. A power curve run per channel does not just add
     contrast, it widens the ratios between the channels — which is a
     saturation boost, applied hardest to the colours that have the least room
     for one, and it is half of why the lit greens and yellows were coming
     back with their blue channel gone. Contrast is a value operation and
     saturation is a chroma operation; keeping them apart is what lets the
     value structure be pushed hard without the palette going fluorescent. */
  float cy = dot(c, vec3(0.2126, 0.7152, 0.0722));
  if (cy > 1e-5) c *= (pow(cy / 0.18, uContrast) * 0.18) / cy;

  c = saturateSafe(c, uSaturation + uSpeed * uSpeedSaturation);
  c = max(vec3(dot(c, uMixerR), dot(c, uMixerG), dot(c, uMixerB)), vec3(0.0));

  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float shadow = 1.0 - smoothstep(0.05, 0.34, y);
  float highlight = smoothstep(0.34, 0.88, y);
  c = mix(vec3(y), c, mix(1.0, uShadowSaturation, shadow));
  /* Multiplicative, so the rotation is a change of hue at the same value
     rather than a wash laid over the top. An additive tint at this strength
     turns the shadows into flat blue paint and loses the albedo underneath. */
  c *= mix(vec3(1.0), uShadowHue, shadow * uShadowHueMix);
  c *= mix(vec3(1.0), uHighlightHue, highlight * uHighlightHueMix);
  c += uShadowTint * shadow * (1.0 - min(c, vec3(1.0)));
  c += uHighlightTint * highlight * (1.0 - min(c, vec3(1.0)));

  /* Toe and shoulder, applied on value so the hue survives both ends.
     Everything below the toe prints as black and everything above the
     shoulder prints as paper; without them the frame has no true black
     outside the tyres and no true white outside the clouds. */
  y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  if (y > 1e-5) {
    float py = clamp((y - uToe) / max(uShoulder - uToe, 1e-3), 0.0, 1.0);
    c *= py / y;
  }
  /* Bring an out-of-gamut colour home along its own hue rather than clipping
     it. The toe and shoulder are luminance operations, so a saturated colour
     can still leave one channel above full after them, and a hard clamp then
     removes only that channel — which is a hue rotation, not an exposure
     change. A vivid orange turns yellow exactly where it is brightest, and
     that is the most visible pixel in the flower. */
  float mx = max(c.r, max(c.g, c.b));
  return max(c, vec3(0.0)) / max(mx, 1.0);
}

void main() {
  vec3 col = texture2D(tColor, vUv).rgb;

  /* A heavy hit gets one short, directional registration error, like the
     colour plates of a screen print jumping out of alignment. The branch is
     coherent across the frame and skips both extra taps for normal driving. */
  if (uImpact > 0.001) {
    vec2 split = uImpactAxis * uTexel * (4.0 * uImpact * uImpact);
    col.r = mix(col.r, texture2D(tColor, clamp(vUv + split, 0.0, 1.0)).r, uImpact);
    col.b = mix(col.b, texture2D(tColor, clamp(vUv - split, 0.0, 1.0)).b, uImpact);
    float y = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col += (1.0 - min(y, 1.0)) * uImpact * uImpact * vec3(0.018, 0.009, 0.004);
  }

  col = mix(col, desertGrade(col), uGradeAmount);

  vec4 tc = probe(vUv);
  float d  = dist(tc);
  float id = inkId(tc);

  /* Band mottling.
   *
   * A flat cel band in this stage is a byte-identical fill; the reference it
   * is measured against carries a luma sd of 11/255 inside a single band,
   * and — this is the part that decides the implementation — its energy is
   * still climbing at a 128 px sample offset. That rules out grain. It is
   * large soft blobs a couple of metres across, drifting across facet
   * boundaries as if the paint were laid on by hand.
   *
   * Here rather than in the ladder itself, for two reasons. It has to land
   * after the quantiser or it only dithers pixels across a rung boundary and
   * the band edges come back speckled; and the surface class the prepass
   * already writes is the only gate available that separates landform and
   * road from the car without every material in the stage having to opt in.
   * The car stays a flat cel object, which is the brief.
   *
   * Amplitude is in display levels, not as a fraction of the surface. A
   * multiply of a fixed percentage is a much larger visible step on a lit
   * road than in a shadow, because sRGB spends most of its codes down there;
   * dividing by the encoded value spends the same number of levels
   * everywhere, which is what "sd 11 out of 255" actually asks for. */
  float mottleGate = max(max(classIs(id, 1.0) * uWRoadMottle,
                             classIs(id, 2.0) * uWRoadMottle),
                         classIs(id, 3.0));
  if (uMottleAmp > 0.0001 && mottleGate > 0.0) {
    vec2 ndc = vUv * 2.0 - 1.0;
    vec3 world = (uCamWorld * vec4(vec3(ndc * uTanHalf, -1.0) * d, 1.0)).xyz;
    float m = (vnoise(world * uMottleFreq.x) - 0.5)
            + (vnoise(world * uMottleFreq.y) - 0.5) * 0.5;
    m *= 1.333;
    /* Falls off with distance, as the reference's does — sd 11 in the near
       band against 3.5 on the far dunes. A far hillside is already a small
       number of pixels per blob, and mottling it is indistinguishable from
       noise. */
    float mFade = mix(1.0, 0.28, smoothstep(70.0, 420.0, d));
    float mY = max(dot(col, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
    float mS = pow(mY, 1.0 / 2.2);
    col *= 1.0 + clamp(2.2 * uMottleAmp * m * mottleGate * mFade / max(mS, 0.14),
                       -0.45, 0.45);
  }

  /* A superellipse follows the shape of the frame better than a circular
     vignette. Its long shoulder keeps the centre untouched and its shallow
     warm tint avoids the black-ring look. The HUD is a later 2D canvas layer,
     so none of its edge furniture is multiplied here. */
  vec2 frame = abs(vUv * 2.0 - 1.0);
  float frameEdge = pow(pow(frame.x, 3.2) + pow(frame.y * 0.96, 3.2), 1.0 / 3.2);
  float vignette = smoothstep(0.60, 1.22, frameEdge);
  float vignetteStrength = uVignetteStrength + uSpeed * uSpeedVignette + uImpact * 0.018;
  col *= mix(vec3(1.0), uVignetteTint, vignette * vignetteStrength * uVignetteAmount);

  /* Everything about the ink relaxes with distance, on one shared curve.
     A pen that draws every crease at 300 m turns a switchback stack into a
     black knot: geometry that is metres apart lands on adjacent pixels, and
     each edge still gets its full line. Far ink should be one silhouette
     stroke, thinner, and nothing else. */
  float far01 = smoothstep(60.0, 420.0, d);

  /* Two radii, not one, and this is the line hierarchy.
     A pen has one weight for the contour of a shape and a lighter one for the
     detail inside it, and a single-radius detector cannot express that: every
     stroke in the frame came out the same ~1 px hairline, which reads as
     anti-aliasing rather than as ink, and which is why the car looked
     un-outlined at close range while the same weight of line looked like a
     confident contour on a mesa two hundred metres away — out there a hairline
     is a large fraction of the shape it is drawing.
     Silhouettes get the wide radius and interior creases the narrow one. The
     stroke a Roberts cross leaves is about as wide as its tap offset, so this
     is the whole of the weight variation and it costs no extra taps. */
  vec2 base = uTexel * (uThickness * uWeightScale);
  vec2 o  = base * mix(1.6, 0.5, far01);   // silhouette
  vec2 oc = base * mix(0.7, 0.4, far01);   // interior detail

  // Roberts cross rather than a full Sobel: half the taps, and on hard-edged
  // low-poly geometry the extra angular accuracy of a Sobel is invisible.
  vec2 uv0 = vUv + vec2(-o.x, -o.y);
  vec2 uv1 = vUv + vec2( o.x,  o.y);
  vec2 uv2 = vUv + vec2(-o.x,  o.y);
  vec2 uv3 = vUv + vec2( o.x, -o.y);

  vec4 t0 = probe(uv0), t1 = probe(uv1), t2 = probe(uv2), t3 = probe(uv3);
  float d0 = dist(t0), d1 = dist(t1);
  float d2 = dist(t2), d3 = dist(t3);

  /* Curvature of INVERSE distance, and the inverse matters.
     A first difference inks the whole ground, because a road at a grazing
     angle changes distance enormously from pixel to pixel. The obvious repair
     is a second difference, on the grounds that a flat plane has no curvature
     — but that is only true of a linear parametrisation, and distance across a
     receding plane goes as 1/x in screen space, so its second derivative still
     explodes as the surface turns edge-on. That is what drew the long streaks
     radiating from the vanishing point down the road.
     Perspective interpolation is linear in 1/w, so inverse distance is exactly
     linear across any flat surface at any angle, and its curvature is exactly
     zero. Multiplying back by distance makes the measure scale-free, so a line
     weighs the same on the bonnet as on the horizon. */
  float i  = 1.0 / d;
  float i0 = 1.0 / d0, i1 = 1.0 / d1, i2 = 1.0 / d2, i3 = 1.0 / d3;
  float dd = (abs(i0 + i1 - 2.0 * i) + abs(i2 + i3 - 2.0 * i)) * d;

  /* The curvature measure fires symmetrically — the pixels on both sides of a
     step see the same |second difference| — so every silhouette used to come
     out as two parallel strokes, and at distance those pairs merged into
     scribble. A flat plane is exactly linear in inverse distance, so the
     centre tap sits exactly on the neighbour mean and any pixel strictly above
     it is on the near side of a step. Keeping only those halves every line
     and pins it to the occluding surface. */
  float nearSide = step((i0 + i1 + i2 + i3) * 0.25, i);

  /* Thresholds scale up with distance. dd is scale-free by construction, so
     without this a 10 cm ledge at 400 m inks exactly as insistently as it
     does at 4 m — which is how the far guard rail grew stipple and duplicate
     strands from geometry thinner than a pixel. */
  float depthTh = uDepthEdge * mix(1.0, 6.0, far01);

  /* Two-tier weight is the line hierarchy. A small relative step — a lamp rim
     a few centimetres proud of the body — takes light ink; only a genuine
     silhouette-scale step earns full black. Without the split, every panel
     gap on the nose weighs the same as the outline and the front of the car
     reads as one clump. */
  float depthEdge = smoothstep(depthTh, depthTh * 2.5, dd) * nearSide
                  * (0.72 + 0.28 * smoothstep(depthTh * 3.0, depthTh * 8.0, dd));

  vec2 uc0 = vUv + vec2(-oc.x, -oc.y);
  vec2 uc1 = vUv + vec2( oc.x,  oc.y);
  vec2 uc2 = vUv + vec2(-oc.x,  oc.y);
  vec2 uc3 = vUv + vec2( oc.x, -oc.y);

  vec3 n  = viewNormal(tc);
  vec3 n0 = viewNormal(probe(uc0)), n1 = viewNormal(probe(uc1));
  vec3 n2 = viewNormal(probe(uc2)), n3 = viewNormal(probe(uc3));
  float nd = length(n0 - n1) + length(n2 - n3);
  /* Creases are gated by depth continuity. Without this the silhouette gets
     inked twice — once by depth and once by the garbage normal difference
     across it — and every outline grows a soft halo on its outer side. */
  float coplanar = 1.0 - smoothstep(depthTh, depthTh * 3.0, dd);
  /* A geometric normal recovered from screen-space derivatives gets noisy as
     a face goes edge-on, so the noise floor rises with the grazing angle. The
     previous guard multiplied the whole crease term by that facing ratio,
     which does suppress the noise — and also every real crease on any surface
     receding from the camera. That is the entire near field: the ground under
     the car, the road surface, the near berm. It is why one continuous berm
     inks in the middle distance and vanishes in the bottom corner of the same
     frame, and it was not a threshold-versus-depth problem at all.
     Raising the bar instead of muting the surface keeps the noise out and
     lets a genuine fold through, because a fold's normal difference is an
     order of magnitude above the noise however edge-on it is seen. */
  float graze = clamp(abs(n.z), 0.06, 1.0);
  /* The grazing-angle guard is relaxed on near landform, and this is the one
     place in the pass where the two measurements of "our terrain" disagree.
     The far hills measure four times the ink of the car, and the near cliff
     faces measure almost none — 0.5% against the car's 6% in the same frame.
     They are not the same surface. The far hills are ridge silhouettes seen
     against the sky, which the depth term draws and which the fade below now
     removes; a cliff wall filling the left half of the frame is a smooth
     ribbon seen almost edge-on, so the guard above raises its crease bar by
     2.6x and its facet folds — which are real, and are the only structure
     the rock has — never reach it. The biggest object in the frame was the
     one thing in the stage carrying no line at all.
     Near only. The guard exists because a geometric normal recovered from
     derivatives goes to noise at a grazing angle, and out in the middle
     distance that noise is exactly what turns a hillside into stipple. */
  float landCrease = classIs(id, 3.0) * (1.0 - smoothstep(110.0, 260.0, d));
  float grazePenalty = mix(mix(2.6, 1.0, graze), uCliffCrease, landCrease);
  /* Creases stiffen with distance and die entirely by ~350 m: they are
     interior detail, and interior detail past that range is what tangled the
     far switchbacks. The silhouette carries the drawing out there. */
  float creaseTh = uNormalEdge * mix(1.0, 3.0, far01) * grazePenalty;
  float creaseFade = 1.0 - smoothstep(110.0, 350.0, d);
  float normalEdge = smoothstep(creaseTh, creaseTh * 2.0, nd)
                   * coplanar * creaseFade;

  /* The boundary between two classes of surface, on the wide radius and at
     contour weight. Where the road stops is the first line a comic artist
     would put on a racing page and it deserves the same pen as a silhouette,
     not a panel-gap hairline.
     The depth gate is much looser than the crease gate: a road edge usually
     does have some fold across it where the shoulder lifts, and gating this
     as tightly as a crease deletes the line on exactly the banked outside
     edges where it matters most. It only needs to be loose enough not to
     double-print a silhouette the depth term has already drawn. */
  float idDiff = step(0.5, abs(inkId(t0) - id)) + step(0.5, abs(inkId(t1) - id))
               + step(0.5, abs(inkId(t2) - id)) + step(0.5, abs(inkId(t3) - id));
  float idEdge = min(idDiff, 1.0) * uIdEdge
               * (1.0 - smoothstep(depthTh * 4.0, depthTh * 12.0, dd))
               * (1.0 - smoothstep(180.0, 460.0, d));

  /* A volumetric surface occupies the buffer so that it hides the edges of
     what is behind it, and raises none of its own. Both halves are needed:
     without the first, ink from geometry the dust covers composites straight
     over the dust, because this pass has no depth relationship with the
     colour buffer it paints onto; without the second, every puff and every
     puff-on-puff overlap is a depth step and the plume inks itself into a
     pile of boulders.
     Depth and crease strokes are already pinned to the near side of a step by
     nearSide, so testing the centre tap alone erases the plume's own contour
     while leaving the car's contour against it intact — those pixels carry
     the car's class, not the dust's. An ID boundary inks from both sides, so
     that one has to test the neighbours as well.
     Every factor below is exactly 1.0 in a frame that contains no volumetric
     surface, which is what keeps this pass unchanged for everything else. */
  float volume = 1.0 - step(0.5, abs(id - ${VOLUME_ID}));
  float volumeNear = max(
    max(1.0 - step(0.5, abs(inkId(t0) - ${VOLUME_ID})),
        1.0 - step(0.5, abs(inkId(t1) - ${VOLUME_ID}))),
    max(1.0 - step(0.5, abs(inkId(t2) - ${VOLUME_ID})),
        1.0 - step(0.5, abs(inkId(t3) - ${VOLUME_ID}))));
  float solid = 1.0 - volume;
  depthEdge *= solid;
  normalEdge *= solid;
  idEdge *= solid * (1.0 - volumeNear);

  /* A mass of dust has one outline and no lines inside it, and the depth term
     cannot tell the two apart. The burst is a dozen overlapping billboards, so
     every overlap between two of them is a step in this buffer, and the pen
     ruled a contour along every one: measured, 38.5% of the plume's pixels
     carried ink against 3.5% for the near-wheel veil and 3.7% for the world in
     the same frame, and what came back was eight to twelve separately outlined
     lumps rather than one cloud.
     Suppressed only where the centre tap and all four neighbours are the same
     class, which is the interior of the mass and nothing else. The union's own
     silhouette is untouched: there the neighbours carry road, berm or sky, so
     this factor is 1.0 and the depth term draws it exactly as before — and the
     ID term draws it too, which is the boundary a class was added for.
     Every factor below is exactly 1.0 in a frame with no burst in it. */
  float burstAll = (1.0 - step(0.5, abs(id - ${BURST_ID})))
    * (1.0 - step(0.5, abs(inkId(t0) - ${BURST_ID})))
    * (1.0 - step(0.5, abs(inkId(t1) - ${BURST_ID})))
    * (1.0 - step(0.5, abs(inkId(t2) - ${BURST_ID})))
    * (1.0 - step(0.5, abs(inkId(t3) - ${BURST_ID})));
  depthEdge *= 1.0 - burstAll;

  /* Ink thins out with distance instead of stopping dead. Fully inking the
     far hillsides turns them into a wireframe, and cutting outlines off at a
     hard range makes a visible ring travel across the world as you drive. */
  float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, d);

  /* Weight, not just coverage. Contours print at full density; interior
     detail and shape lines print lighter, so the eye reads the silhouette
     first. Mixed as two separate strokes rather than one max() so a light
     line crossing a heavy one cannot lighten it. */
  float heavy = clamp(max(depthEdge, idEdge), 0.0, 1.0) * fade * uInkEnabled;
  float light = clamp(normalEdge, 0.0, 1.0) * fade * uInkEnabled * uCreaseInk;
  float ink = heavy + light * (1.0 - heavy);

  /* How much of the pen's budget each class of surface is worth.
   *
   * Measured against the reference, this is the largest single difference in
   * the frame and it is not the colour or the weight of the line — it is
   * where the line goes. The reference spends sixteen times more ink on its
   * hero vehicle than on distant landform. We spent more on the hills behind
   * the car than on the car, which is most of what makes ours read as vector
   * art and theirs as paint.
   *
   * Not sixteen to one, though. Their landform carries no edge the rider
   * needs; ours carries the road edge, which is the line the player steers
   * by, and deleting it to win a ratio would be trading a game for a
   * picture. Four to one is the defensible version: the hills recede, the
   * kerb stops printing heavier than the car, and every line the driver uses
   * is still on the page — thinner. */
  float classW = uWOther;
  classW = mix(classW, uWRoad,  classIs(id, 1.0));
  classW = mix(classW, uWBerm,  classIs(id, 2.0));
  classW = mix(classW, mix(uWLandNear, uWLandFar, smoothstep(80.0, 300.0, d)),
               classIs(id, 3.0));
  classW = mix(classW, uWShell, classIs(id, 4.0));
  classW = mix(classW, uWRail,  classIs(id, 5.0));
  ink *= classW;

  /* Ink as a darkening of what it borders, rather than one colour.
   *
   * Ours was a single constant, and measurably so: the darkest pixel of
   * every stroke in the frame came back #160c12 whether it lay against navy
   * bodywork, grey road or lit orange. The reference's does not — binned by
   * the luma of the surface it borders, its strokes hold a near-constant
   * ratio to that surface, from about 0.30 over darks up to 0.58 over
   * midtones, at 1.4-1.8x the local saturation and rotated a little toward
   * violet. It is a saturated coloured dark, not a black, and it is why
   * their line sits inside the painting instead of on top of it.
   *
   * The ratio is a display-space one — their measurement is in sRGB bytes —
   * so the curve is evaluated on the encoded value and raised back into
   * linear before it multiplies. Done directly in linear, a ratio of 0.30 is
   * a stroke that barely darkens anything. */
  float inkY = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float inkS = pow(max(inkY, 0.0), 1.0 / 2.2);
  float inkK = mix(0.30, 0.55, smoothstep(0.15, 0.60, inkS));
  vec3 inkCol = col * pow(inkK, 2.2);
  float inkColY = dot(inkCol, vec3(0.2126, 0.7152, 0.0722));
  inkCol = max(mix(vec3(inkColY), inkCol, 1.5), vec3(0.0));
  /* uInk stays, as a floor. A stroke against a bright sky would otherwise be
     a pale tint of that sky and carry no weight at all.
     The floor is higher on the car, and that is the whole asymmetry restated
     in colour rather than in width: a proportional ink over the shell's dark
     navy is a dark navy, which is no line at all, and the hero is the one
     thing in the frame whose silhouette has to hold. Landform gets the full
     proportional treatment and recedes; the car keeps a drawn edge. */
  inkCol = mix(inkCol, uInk, mix(uInkFloor, uInkFloorHero, classIs(id, 4.0)));

  vec3 outc = mix(col, inkCol, ink);

  // The single linear -> sRGB conversion for the whole pipeline.
  outc = mix(outc * 12.92,
             1.055 * pow(max(outc, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
             step(vec3(0.0031308), outc));

  gl_FragColor = vec4(outc, 1.0);
}`;

/* Surface classes, by object name.
 *
 * Classified here rather than stamped on at build time so that the ink pass
 * owns its own inputs: nothing outside this file has to remember to tag a new
 * mesh for it to be drawn correctly, and the stage, the car and the AI field
 * are all built by different modules.
 *
 * What matters is the boundaries the split creates. Road against shoulder is
 * the line a comic artist would draw first on a racing page and neither
 * detector can see it; shoulder against desert floor is the berm edge that
 * disappears whenever it comes near the camera.
 */
const INK_CLASS = [
  [/^road$/, 1],
  [/^(berm|road-supports)/, 2],
  [/^(landform|basin)/, 3],
  [/^(shell|wheel\d)/, 4],
  [/^guardrail$/, 5],
  // Volumetric. Occludes other lines, draws none. See VOLUME_ID.
  [/^fx-unified-billows$/, 6],
  /* Deliberately no class for shore-foam, which was tried and reverted. The
     shoreline already inks as ocean against landform; the foam is a thin
     wispy strip lying on top of the water inside that boundary, and giving it
     a class puts a contour down both sides of something only a few pixels
     wide. The two strokes merge and the surf reads as a black gash in the sea
     rather than as foam. It wants to stay a pale shape with no line on it,
     which is how it would be painted. */
];

/* Objects whose geometry only exists once their own vertex shader has run
 * cannot be drawn by the shared override material: that material knows
 * nothing about their attributes and would submit the unexpanded source quad.
 * Skipping them instead — which is what the particle system used to do —
 * leaves a hole in the buffer this pass reads, and edges belonging to
 * geometry they hide then composite over them.
 *
 * Such an object registers a prepass material here and is drawn in a second
 * short pass into the same target, depth-testing against what the first pass
 * left. It is drawn through a private scene of proxies that share the source
 * geometry, so the main scene's traversal is not touched and every object
 * that has not opted in sees exactly the pass it always saw.
 */
const PREPASS_MESHES = new Map();

export function registerPrepassMesh(mesh, material) {
  PREPASS_MESHES.set(mesh, material);
}

export function unregisterPrepassMesh(mesh) {
  PREPASS_MESHES.delete(mesh);
}

function inkClassOf(object) {
  const cached = object.userData.inkId;
  if (cached !== undefined) return cached;
  let id = 0;
  for (const [pattern, value] of INK_CLASS) {
    if (pattern.test(object.name)) { id = value; break; }
  }
  object.userData.inkId = id;
  return id;
}

export class CelPipeline {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  constructor(renderer, scene, camera, opts = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = opts.enabled ?? true;
    this.inkEnabled = opts.outlines ?? true;
    this.gradeEnabled = opts.grade ?? true;
    this.vignetteEnabled = opts.vignette ?? true;
    this.speedEnabled = opts.speed ?? true;
    this.impactEnabled = opts.impact ?? true;
    this.mottleEnabled = opts.mottleEnabled ?? true;
    this.mottle = opts.mottle ?? 0.045;
    this.speed = 0;
    this.impact = 0;
    this.impactAxis = new THREE.Vector2(0, -1);

    /* Linear, and half-float so that storing linear light in it does not band
       the shadows. Encoding to sRGB on the way into this buffer and letting
       three encode again on the way out of the composite is the classic
       version of this mistake: the whole frame comes out crushed and dark,
       and it looks convincingly like a lighting bug. The composite does the
       one and only conversion, at the end, by hand. */
    /* MSAA on the beauty pass only. `antialias: true` on the renderer covers
       the default framebuffer, which nothing here draws to except the final
       quad — so without samples on this target every geometry edge in the
       composite arrived jagged. The normals target stays single-sampled on
       purpose: averaged normals and averaged distances decode to edges that
       do not exist. */
    this.color = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false,
      samples: 4,
    });

    /* Float, because the alpha channel carries metres rather than a 0..1
       normal. Eight bits of distance over four kilometres would quantise to
       sixteen-metre steps and every surface would be one flat plateau. */
    this.normals = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      type: THREE.FloatType, depthBuffer: true, stencilBuffer: false,
    });

    this.normalMat = new THREE.ShaderMaterial({
      vertexShader: PRE_VERT, fragmentShader: PRE_FRAG, side: THREE.DoubleSide,
      uniforms: { uInkId: { value: 0 } },
    });
    /* The override material is one program shared by every object in the
       prepass, so the class has to be pushed in per draw. three calls this
       with the object it is about to submit, and flagging the material is
       what makes the new value reach the GPU before that draw rather than
       after it. */
    this.normalMat.onBeforeRender = (renderer, scene, camera, geometry, object) => {
      const id = inkClassOf(object);
      if (this.normalMat.uniforms.uInkId.value !== id) {
        this.normalMat.uniforms.uInkId.value = id;
        this.normalMat.uniformsNeedUpdate = true;
      }
    };

    this.quadMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tColor: { value: this.color.texture },
        tNormal: { value: this.normals.texture },
        uTexel: { value: new THREE.Vector2() },
        uFar: { value: 1000 },
        /* Sized against the near-side gate: detection only fires on the
           occluding half of a step, so the visible stroke is roughly the tap
           offset itself. Anything under ~2.5 px reads as a pencil, not ink. */
        uThickness: { value: opts.thickness ?? 3.2 },
        /* Tap offsets are in texels, so a line drawn at a fixed texel width is
           a shrinking fraction of the page as the frame grows: the same build
           that reads as inked at 1024 wide reads as bare at 1400 and worse at
           4K. Scaling by frame height against a 900 px reference makes the
           weight a property of the drawing rather than of the buffer. */
        uWeightScale: { value: 1 },
        uDepthEdge: { value: opts.depthEdge ?? 0.02 },
        uNormalEdge: { value: opts.normalEdge ?? 0.55 },
        uIdEdge: { value: opts.idEdge ?? 1.0 },
        uInk: { value: new THREE.Color(opts.ink ?? 0x160c12) },
        /* How much of the constant ink colour survives the proportional
           darkening. Enough to keep a stroke against the sky from being a
           pale tint of it, not enough to flatten the transfer function back
           into one colour. */
        uInkFloor: { value: opts.inkFloor ?? 0.20 },
        uInkFloorHero: { value: opts.inkFloorHero ?? 0.78 },
        // Interior detail and shape lines, lighter than a contour.
        uCreaseInk: { value: opts.creaseInk ?? 0.62 },
        /* Pulled in hard from 300/950. At the old range every road edge,
           verge and guardrail post ran to the horizon at full weight, and the
           far hills measured more inked pixels than the car did. */
        uFadeStart: { value: opts.fadeStart ?? 120 },
        uFadeEnd: { value: opts.fadeEnd ?? 400 },
        uInkEnabled: { value: 1 },
        uWRoad: { value: opts.wRoad ?? 0.72 },
        uWBerm: { value: opts.wBerm ?? 0.62 },
        /* Near landform keeps most of its pen — a cliff face two car lengths
           away is a foreground object. Far landform is the horizon wireframe
           and gets almost nothing. */
        uWLandNear: { value: opts.wLandNear ?? 0.84 },
        uWLandFar: { value: opts.wLandFar ?? 0.22 },
        uWShell: { value: opts.wShell ?? 1.0 },
        uWRail: { value: opts.wRail ?? 0.55 },
        uWOther: { value: opts.wOther ?? 0.85 },
        uCliffCrease: { value: opts.cliffCrease ?? 0.45 },
        /* Swept against the variation it actually adds, differenced frame
           against frame so the band edges cancel and only the mottle is left:
           0.045 adds 1.5 luma of spread, this adds 3.0, 0.14 adds 4.7 and is
           where the far verge starts to grey out. The reference sits at 11,
           and that is not a number to chase from here — theirs is a painted
           surface, ours is a quantised one with mottle laid over it. */
        uMottleAmp: { value: opts.mottle ?? 0.09 },
        uWRoadMottle: { value: opts.mottleRoad ?? 0.75 },
        /* Two octaves at roughly 6 m and 2.4 m. The reference's blobs run
           2.5-8% of frame width and its energy is still rising at a 128 px
           offset, so nothing here is allowed near the pixel scale. */
        uMottleFreq: { value: new THREE.Vector2(1 / 8.0, 1 / 3.0) },
        uCamWorld: { value: new THREE.Matrix4() },
        uTanHalf: { value: new THREE.Vector2(1, 1) },
        uGradeAmount: { value: 1 },
        uLift: { value: new THREE.Vector3(...DESERT_GRADE.lift) },
        uGamma: { value: new THREE.Vector3(...DESERT_GRADE.gamma) },
        uGain: { value: new THREE.Vector3(...DESERT_GRADE.gain) },
        uContrast: { value: DESERT_GRADE.contrast },
        uSaturation: { value: DESERT_GRADE.saturation },
        uShadowSaturation: { value: DESERT_GRADE.shadowSaturation },
        uShadowHue: { value: new THREE.Vector3(...DESERT_GRADE.shadowHue) },
        uShadowHueMix: { value: DESERT_GRADE.shadowHueMix },
        uHighlightHue: { value: new THREE.Vector3(...DESERT_GRADE.highlightHue) },
        uHighlightHueMix: { value: DESERT_GRADE.highlightHueMix },
        uShadowTint: { value: new THREE.Vector3(...DESERT_GRADE.shadowTint) },
        uHighlightTint: { value: new THREE.Vector3(...DESERT_GRADE.highlightTint) },
        uToe: { value: DESERT_GRADE.toe },
        uShoulder: { value: DESERT_GRADE.shoulder },
        uMixerR: { value: new THREE.Vector3(...DESERT_GRADE.mixerR) },
        uMixerG: { value: new THREE.Vector3(...DESERT_GRADE.mixerG) },
        uMixerB: { value: new THREE.Vector3(...DESERT_GRADE.mixerB) },
        uVignetteAmount: { value: 1 },
        uVignetteTint: { value: new THREE.Vector3(...DESERT_GRADE.vignetteTint) },
        uVignetteStrength: { value: DESERT_GRADE.vignetteStrength },
        uSpeedSaturation: { value: DESERT_GRADE.speedSaturation },
        uSpeedVignette: { value: DESERT_GRADE.speedVignette },
        uSpeed: { value: 0 },
        uImpact: { value: 0 },
        uImpactAxis: { value: this.impactAxis },
      },
    });

    const quad = new THREE.BufferGeometry();
    // A single oversized triangle, not two: no seam down the diagonal and one
    // fewer vertex shader invocation per pixel along it.
    quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    quad.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad = new THREE.Mesh(quad, this.quadMat);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene().add(this.quad);
    this.quadCam = new THREE.Camera();
  }

  setSize(w, h) {
    const dpr = this.renderer.getPixelRatio();
    const pw = Math.max(1, Math.floor(w * dpr)), ph = Math.max(1, Math.floor(h * dpr));
    this.color.setSize(pw, ph);
    this.normals.setSize(pw, ph);
    this.quadMat.uniforms.uTexel.value.set(1 / pw, 1 / ph);
    this.quadMat.uniforms.uWeightScale.value = ph / 900;
  }

  update(dt, { speed = 0 } = {}) {
    const t = Math.max(0, Math.min(1, (speed - 18) / 34));
    const target = this.speedEnabled ? t * t * (3 - 2 * t) : 0;
    const rate = target > this.speed ? 4.8 : 2.4;
    this.speed += (target - this.speed) * (1 - Math.exp(-rate * dt));
    this.impact *= Math.exp(-8.5 * dt);
  }

  addImpact(strength, side = 0) {
    if (!this.impactEnabled) return;
    const kick = Math.max(0, Math.min(1, (strength - 0.12) / 0.88));
    if (kick < 0.04) return;
    this.impact = Math.max(this.impact, kick);
    const lateral = Math.abs(side) > 0.1;
    this.impactAxis.set(lateral ? Math.sign(side) : 0.14, lateral ? 0.12 : -1).normalize();
  }

  /* Second half of the normals prepass, for the opt-ins described above. The
     early return keeps a frame with nothing registered — or nothing visible,
     which is every frame with no dust in it — off this path entirely. */
  _renderPrepassOptIns(r) {
    if (PREPASS_MESHES.size === 0) return;
    if (!this.prepassScene) {
      this.prepassScene = new THREE.Scene();
      this.prepassScene.matrixWorldAutoUpdate = false;
      this.prepassProxies = new Map();
    }
    for (const [mesh, proxy] of this.prepassProxies) {
      if (PREPASS_MESHES.has(mesh)) continue;
      this.prepassScene.remove(proxy);
      this.prepassProxies.delete(mesh);
    }
    let anyVisible = false;
    for (const [mesh, material] of PREPASS_MESHES) {
      let proxy = this.prepassProxies.get(mesh);
      if (!proxy) {
        proxy = new THREE.Mesh(mesh.geometry, material);
        proxy.frustumCulled = false;
        proxy.matrixAutoUpdate = false;
        proxy.matrixWorldAutoUpdate = false;
        this.prepassProxies.set(mesh, proxy);
        this.prepassScene.add(proxy);
      }
      proxy.visible = mesh.visible;
      proxy.matrixWorld.copy(mesh.matrixWorld);
      anyVisible = anyVisible || mesh.visible;
    }
    if (!anyVisible) return;
    /* The target already holds the first pass; three would clear it. */
    const autoClear = r.autoClear;
    r.autoClear = false;
    r.render(this.prepassScene, this.camera);
    r.autoClear = autoClear;
  }

  render() {
    const r = this.renderer;
    if (!this.enabled) {
      r.setRenderTarget(null);
      r.render(this.scene, this.camera);
      this.stats = { calls: r.info.render.calls, triangles: r.info.render.triangles };
      return;
    }

    /* ONE SHADOW MAP PER FRAME, not one per scene pass.
     *
     * three runs its shadow pass at the top of every renderer.render()
     * (three.module.js:30081), and this method makes two of them over a scene
     * that has lights — the normals prepass below and the beauty pass after
     * it. So the single most expensive term in the frame was being paid twice
     * to produce one picture. Measured (tools/shcost.mjs, paired differences
     * against the same frame with the pass held): at the 8192 that shipped for
     * months the two passes together cost 3.35-4.05 ms of a 4.9-6.7 ms frame on
     * a 4060, and at the 4096 that replaced it they cost 0.65-1.00 ms. Halving
     * that is the largest single saving available in the renderer, and it costs
     * the picture nothing.
     *
     * Set immediately before the BEAUTY pass rather than at the top of this
     * method, and that placement is the whole no-op argument. shadow matrices
     * are only recomputed inside the shadow pass (three.module.js:22484), and
     * setupLights reads them straight afterwards, so today the map that
     * actually reaches the frame is the SECOND one, built at exactly this
     * point. Triggering the single pass here reproduces that same map at that
     * same moment. Triggering it before the normals prepass would instead keep
     * the first one — almost certainly identical, but "almost" is not what a
     * pixel-parity claim is allowed to rest on.
     *
     * Saved and restored rather than set once at construction, exactly as
     * autoClear is in _renderPrepassOptIns below. A global autoUpdate = false
     * would also change what tools/fx.mjs and tools/inkprobe.mjs see, since
     * both call renderer.render() directly and would then draw against
     * whatever map this method last left. Confining it to this method makes
     * every renderer.render() outside the pipeline behave exactly as before.
     *
     * The quad pass cannot swallow the flag: three clears needsUpdate at
     * three.module.js:22506, AFTER its `lights.length === 0` early return at
     * 22386, so a lightless scene leaves a pending update pending.
     *
     * Verified a pixel no-op at five stations by tools/shparity.mjs, which
     * also confirms the shadow map's own bytes do not depend on the wall clock
     * — the one route by which the two passes could ever have differed. */
    const shadowAuto = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;

    this.quadMat.uniforms.uFar.value = this.camera.far;
    this.quadMat.uniforms.uInkEnabled.value = this.inkEnabled ? 1 : 0;
    this.quadMat.uniforms.uGradeAmount.value = this.gradeEnabled ? 1 : 0;
    this.quadMat.uniforms.uVignetteAmount.value = this.vignetteEnabled ? 1 : 0;
    this.quadMat.uniforms.uSpeed.value = this.speedEnabled ? this.speed : 0;
    this.quadMat.uniforms.uImpact.value = this.impactEnabled ? this.impact : 0;
    this.quadMat.uniforms.uMottleAmp.value = this.mottleEnabled ? this.mottle : 0;

    /* The mottling needs a world position and the composite only has a
       distance, so the view ray is rebuilt from the projection each frame.
       Taken off the matrix rather than off fov and aspect so an overview shot
       or a changed lens cannot silently put the blobs somewhere else. */
    const pm = this.camera.projectionMatrix.elements;
    this.quadMat.uniforms.uTanHalf.value.set(1 / pm[0], 1 / pm[5]);
    this.camera.updateMatrixWorld();
    this.quadMat.uniforms.uCamWorld.value.copy(this.camera.matrixWorld);

    /* Normals prepass. The background and the fog are suppressed: a fogged
       normal is a blend of a surface and the fog colour, which decodes to a
       direction that belongs to neither, and every distant crease would ink
       according to how foggy it was rather than how sharp it was. */
    if (this.inkEnabled) {
      const bg = this.scene.background, fog = this.scene.fog;
      this.scene.background = null;
      this.scene.fog = null;
      this.scene.overrideMaterial = this.normalMat;
      r.setRenderTarget(this.normals);
      r.clear();
      r.render(this.scene, this.camera);
      this.scene.overrideMaterial = null;
      this._renderPrepassOptIns(r);
      this.scene.background = bg;
      this.scene.fog = fog;
    }

    r.shadowMap.needsUpdate = true;
    r.setRenderTarget(this.color);
    r.clear();
    r.render(this.scene, this.camera);

    /* Snapshot the scene's cost before the composite runs. renderer.info is
       reset per render() call, so anything reading it after the full-screen
       pass sees one draw call and no triangles, and every perf report claims
       the stage is free. */
    this.stats = { calls: r.info.render.calls, triangles: r.info.render.triangles };

    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCam);
    r.shadowMap.autoUpdate = shadowAuto;
  }

  dispose() {
    this.color.dispose();
    this.normals.dispose();
    this.normalMat.dispose();
    this.quadMat.dispose();
    this.quad.geometry.dispose();
  }
}
