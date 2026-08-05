/**
 * Cel shading: quantised lighting bands with a painted warm/cool shift.
 *
 * Three's toon material already quantises, but it reads the gradient map's red
 * channel only, so every band is a neutral grey multiplier and the result is
 * flat posterisation — the thing that makes cheap toon shading look cheap. A
 * painter does the opposite: light is warm, shadow swings cool and loses
 * saturation, and the step between them carries a hint of a third hue. So the
 * ramp here is full colour and a one-line patch makes the shader read it.
 */
import * as THREE from 'three';

/**
 * A stepped colour ramp indexed by N·L, remapped from -1..1 into 0..1.
 *
 * Nothing is interpolated: the texture is sampled with a nearest filter so the
 * bands stay hard however close the camera gets. Bands are unevenly spaced on
 * purpose — an even split puts the terminator at exactly 90 degrees on every
 * surface in the scene and the whole frame gains a horizon line.
 */
export function toonRamp(bands = [
  // [upper edge of band in N·L space, tint]
  /* Edge placement is tuned to the sun, not to taste. The sun sits at
     elevation ~29°, so every horizontal surface — the road, the canyon floor
     — lands at N·L ≈ 0.49, remapped 0.74. With a top edge below that, the
     entire ground plane sat inside the key band and never banded at all; the
     whole stage read as one smooth wash. The key edge at 0.72 puts flat
     ground just inside the key light, so a few degrees of pitch or banking
     away from the sun drops a surface into the midtone and the road picks up
     crisp painted breaks where it dips and banks. */
  /* Shadow hue is pushed hard to violet-blue rather than merely desaturated.
     Every albedo in this stage sits between 10° and 45°, so a neutral shadow
     multiplies back to a darker version of the same orange and the frame has
     no hue contrast anywhere. A shadow that is genuinely a different hue from
     the light is the cheapest contrast available, and it costs nothing here. */
  /* Key-to-fill ratio matters more than it used to. A quantised frame turns
     the gap between the lit and shadowed sides into a count of rungs, and at
     a 10:1 ratio everything out of the sun fell three rungs to the bottom of
     the ladder — the cast shadow under the car stopped being a shape and
     became a hole with the shadow map's texel grid showing along its edge.
     Around 3:1 the shadow side lands two rungs down, which still reads as a
     decisive flat black-violet mass but keeps its own internal steps. */
  /* The blue lift is measured, and it was too much. Isolating hue from depth,
     this band used to raise blue 1.77x relative to its own luminance; the
     reference lifts 1.19x. The grade's shadowHue is already close to the
     reference, so the ramp was the culprit — and the visible failure was
     specific: a road with no chroma of its own arrived in shade as saturated
     blue paint, a 6x saturation increase across a shadow edge on a neutral
     grey surface.
     Stopping at about 1.4 rather than going to the reference's warm mauve.
     The violet shade is a considered choice and it is the Ghibli half of the
     brief; only its depth and its blue tilt were wrong, not its hue. */
  [0.34, 0x8085a1],   // core shadow, cool violet
  [0.58, 0xa189a6],   // reflected light, still cool
  [0.72, 0xc08a6d],   // mid, the hue turns warm here
  [1.00, 0xfff0cf],   // key light
], width = 64) {
  const data = new Uint8Array(width * 4);
  for (let i = 0; i < width; i++) {
    const t = (i + 0.5) / width;
    const band = bands.find(b => t <= b[0]) || bands[bands.length - 1];
    /* Raw hex bytes, deliberately NOT via THREE.Color: with colour management
       on, Color.set(hex) converts to linear working space, and this texture
       is tagged sRGB — so the GPU decoded the ramp a second time. Every band
       arrived roughly squared: the key light survived, the cool shadow tint
       crushed to near-black, and the whole palette read muddy and warm no
       matter what was painted here. */
    const h = band[1];
    data[i * 4] = (h >> 16) & 255; data[i * 4 + 1] = (h >> 8) & 255;
    data[i * 4 + 2] = h & 255; data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

let _shared = null;
/** One ramp for the whole scene, so every surface bands at the same angles. */
export function sharedRamp() {
  if (!_shared) _shared = toonRamp();
  return _shared;
}

/**
 * The value ladder every lit surface lands on.
 *
 * The gradient ramp alone only quantises the *direct* diffuse term. Four other
 * things reach the frame smoothly and between them they carry most of the
 * ground: the hemisphere fill (a continuous function of the normal), the
 * interpolated vertex colour across triangles tens of metres wide, the shadow
 * map's filtered edge, and fog. On the mesas none of that shows, because a
 * flat-shaded facet a hundred metres away is a handful of pixels wide and all
 * four terms are near-constant across it. On the road and the canyon floor —
 * half the frame, running from four metres to the horizon — every one of them
 * turns into a smooth airbrushed ramp, which is exactly the "quantiser is not
 * applied to the ground" reading.
 *
 * So the ladder is applied once at the very end of the fragment, after fog,
 * to the composed pixel. Anything smooth that reached the frame by any route
 * gets stepped, including the low-frequency light-streak detail painted into
 * the terrain's vertex colours.
 *
 * Only the luminance is quantised and the chroma is carried through unchanged,
 * so two surfaces that land on the same step keep their own hue instead of
 * collapsing into one flat colour the way per-channel posterisation does.
 *
 * Seven rungs, spaced by cube root of luminance.
 *
 * Fewer rungs looks like the right answer for a comic and is not: an even
 * ladder has to cover the whole scale, and at five or six the gap between the
 * two lowest lands squarely on the midtone brown most of this stage is
 * painted in, so every shadowed slope drops a whole step and the frame goes
 * plum.
 *
 * Cube root rather than square root because of where the rungs are needed.
 * The sun is low and the canyon is deep, so large parts of this stage are lit
 * by the sky fill alone and live in the bottom tenth of the scale; a sqrt
 * ladder puts two rungs down there and a whole cliff face — road included —
 * merges into one silhouette you cannot drive on. Cube root spends four rungs
 * below mid grey and coarsens the top, which is also the right trade for the
 * subject: the lit sand wants big flat areas and the shadow side wants to
 * stay readable.
 */
const LADDER_STEPS = 7;
// GLSL literals: interpolating the number 3.0 yields "3", which is an int.
const LADDER_GAMMA = '3.0';

/* One shared uniform across every cel material, so the ladder can be taken out
   at runtime the way the ink and the grade already can. It is the only way to
   tell an artefact the ladder created from one it merely stopped hiding. */
const _posterizeUniform = { value: 1 };
export function setPosterize(on) { _posterizeUniform.value = on ? 1 : 0; }

/* floor(v*N + 0.5)/N, not (floor(v*N)+0.5)/N: the rounded form includes 0 and
   1 as reachable steps, so deep shadow can go to a real black and a lit
   highlight can hold paper white. The bin-centre form clamps both ends off and
   is most of why a posterised frame reads as mid-heavy grey mush. */
const POSTERIZE = /* glsl */`
{
  vec3 celC = gl_FragColor.rgb;
  float celY = dot(celC, vec3(0.2126, 0.7152, 0.0722));
  if (celY > 1e-5 && uCelPosterize > 0.5) {
    /* Stepped in a value space, not in linear light. Even steps in linear
       light put almost every rung inside the top stop and crush the entire
       shadow side onto one, which is the classic way a posterised frame ends
       up as a silhouette. */
    float celV = pow(celY, 1.0 / ${LADDER_GAMMA});
    float celQ = floor(celV * ${LADDER_STEPS}.0 + 0.5) / ${LADDER_STEPS}.0;
    float celS = pow(celQ, ${LADDER_GAMMA}) / celY;
    /* Landing on the rung is a luminance target, and luminance weights blue at
       0.07. A saturated blue therefore has to be scaled a long way up to reach
       the rung its brightness belongs to, and the scale takes the channel that
       is already near full straight past it — where the encode clips it, which
       costs the colour its hue rather than its exposure. Nothing in a
       single-hue desert ever hit this. An ocean does, constantly, and so do
       the flowers.
       So the rung is a target, not a promise: a colour is allowed to stop
       short of it rather than leave the gamut to reach it. Capping the scale
       is also what lets a bright warm surface hold its own colour at the top
       of the ladder instead of being forced to neutral paper white. */
    float celM = max(celC.r, max(celC.g, celC.b));
    gl_FragColor.rgb = celC * min(celS, 1.0 / max(celM, 1e-4));
  }
}`;

/**
 * Collapse three's soft shadow coverage into an inked edge.
 *
 * PCFShadowMap filters with a seventeen-tap box, so what comes back is not a
 * shadow but a coverage fraction on an eighteen-level scale, ramped over about
 * two shadow-map texels. That is a gradient, and this look has nowhere to put
 * a gradient: a shadow-map texel is several screen pixels across at the
 * distances a car is actually looked at, so the ramp arrives as a run of flat
 * plateaux, and the ladder downstream then lands neighbouring plateaux on
 * different rungs. A soft edge and a stepped edge are the same picture here —
 * the terrace was always in the coverage, the ladder only stopped hiding it.
 *
 * So the coverage is remapped through a window narrow enough that the ladder
 * has nothing left to split. Not step(): a true binary edge is a hard alias
 * against the texel grid, and the one thing the 4x MSAA on the beauty target
 * cannot fix is aliasing inside a triangle. Sixteen points of coverage is
 * about a third of a texel — a line, with just enough ramp left on it to
 * resolve.
 *
 * The reference's contact shadows transition over about 0.45% of frame height
 * and ours over a single pixel, and this window is not what stands in the way.
 * Measured: widening it to 0.05-0.95 changes the frame by nothing at all, and
 * neither does spreading the seventeen PCF taps over twenty texels instead of
 * one — at twenty the edge finally moves, and what appears is the tap pattern
 * as dither rather than a ramp. The coverage this stage produces at close
 * range is genuinely binary inside one pixel, because the shadow map is high
 * resolution relative to the frame. There is no gradient here to soften, and
 * making one means a wider filter or a screen-space blur of the shadow term,
 * neither of which lives in this file. The comment above about texels being
 * several pixels across no longer holds at the map size this stage now uses.
 */
const SHADOW_WINDOW = [0.42, 0.58];

/**
 * How much key light survives inside a cast shadow.
 *
 * Measured against the reference, our cast shadows are twice as deep as
 * theirs: their rider's shadow sits at a luma ratio of 0.727 against the lit
 * ground beside it, ours at 0.515. A shadow that dark stops being a shape
 * lying on a surface and becomes a hole cut in it.
 *
 * Flooring the shadow-map attenuation rather than lifting the ramp, because
 * the reference makes exactly this distinction and the ramp cannot: its cast
 * shadows sit at 0.73 while its genuinely turned-away cliff faces sit near
 * 0.48. This only touches occlusion. A surface facing away from the sun still
 * walks the ramp all the way down to the core shadow band.
 *
 * It does not reach 0.727, and it cannot. Swept on the car's own cast shadow
 * over lit asphalt, the response is not a staircase but a cliff: every floor
 * up to 0.11 leaves the shadow at 0.52 of the lit road, 0.15 and above erases
 * it entirely at 0.99, and 0.12 to 0.14 is the shadow tearing in half, some
 * pixels on each rung. There is no setting in between because there is no
 * rung in between. Lit asphalt sits on rung 3 of 7 and the shadow on rung 2,
 * and two rungs that far down the ladder's value curve are a fixed 0.53 apart
 * — the target needs a rung at 2.4. Nothing reachable from this file moves
 * it; the depth of a cast shadow here is a property of LADDER_STEPS. Worth
 * knowing that a brighter surface would land the ratio for free: rung 4 under
 * rung 5 is 0.733, which is the reference's number almost exactly, and their
 * ground is that much brighter than our asphalt.
 *
 * What the floor does buy at this value is hue. The key light is warm and the
 * ambient it is being mixed back into is sky, so letting a tenth of the sun
 * through warms the shadow without moving it off its rung: the blue-over-red
 * tilt goes from 1.83x the lit surface to 1.69x, against a target of 1.35 to
 * 1.45. The rest of that gap is the ambient's own colour, which is set in
 * environment.js and is not this file's to move. 0.11 is the last value that
 * holds together; the tearing starts immediately above it.
 */
const SHADOW_FLOOR = 0.10;

/* Shared, like the posterize switch above and for the same reason: the ladder
   quantises the shadow's depth, so the useful values sit close together and
   the only way to find one is to sweep it against a measured luma ratio on a
   live frame. It also means this can be taken back out at runtime. */
const _shadowFloorUniform = { value: SHADOW_FLOOR };
export function setShadowFloor(v) { _shadowFloorUniform.value = v; }

/**
 * A toon material that respects the full colour of the ramp.
 * @param {THREE.MeshToonMaterialParameters & {posterize?:boolean}} params
 */
export function celMaterial(params = {}) {
  const { posterize = true, ...rest } = params;
  const mat = new THREE.MeshToonMaterial({ gradientMap: sharedRamp(), ...rest });
  mat.onBeforeCompile = shader => {
    /* Stock three throws away the ramp's green and blue. Keeping them is the
       entire difference between "posterised" and "painted". */
    shader.fragmentShader = shader.fragmentShader.replace(
      'return vec3( texture2D( gradientMap, coord ).r );',
      'return texture2D( gradientMap, coord ).rgb;',
    );
    /* Inlined, not patched in place: onBeforeCompile runs before three expands
       its includes, so the only thing in the shader at this point is the
       directive. Taking the chunk from ShaderChunk rather than pasting a copy
       of it keeps this honest across a three upgrade — the replace either
       lands or it visibly stops working, instead of silently pinning an old
       version of the filter. Only the first match is touched, which is the
       directional getShadow; the point-light one below it is not in this
       scene. */
    shader.uniforms.uCelShadowFloor = _shadowFloorUniform;
    shader.fragmentShader = 'uniform float uCelShadowFloor;\n' + shader.fragmentShader.replace(
      '#include <shadowmap_pars_fragment>',
      THREE.ShaderChunk.shadowmap_pars_fragment.replace(
        'return mix( 1.0, shadow, shadowIntensity );',
        `return mix( 1.0, max( smoothstep( ${SHADOW_WINDOW[0].toFixed(2)}, `
        + `${SHADOW_WINDOW[1].toFixed(2)}, shadow ), uCelShadowFloor ), `
        + `shadowIntensity );`,
      ),
    );
    if (posterize) {
      shader.uniforms.uCelPosterize = _posterizeUniform;
      shader.fragmentShader = 'uniform float uCelPosterize;\n' + shader.fragmentShader.replace(
        '#include <fog_fragment>',
        '#include <fog_fragment>\n' + POSTERIZE,
      );
    }
  };
  // Two materials that compile to different programs must not share a cache
  // key, or three hands the second one the first one's compiled shader.
  mat.customProgramCacheKey = () => (posterize ? 'cel-tinted-ramp-q' : 'cel-tinted-ramp');
  return mat;
}

/**
 * The same material with the lighting term dropped, so vertex colour reaches
 * the frame untouched.
 *
 * For anything that is hand-banded in its own colours — the sky, the sun disc,
 * the clouds, the chequer on the underside of the finish gate — a light can
 * only fight the banding that is already drawn. The gate soffit is the clearest
 * case: it faces away from every light in the scene, so a lit chequer resolves
 * to two shades of the same near-black and the pattern vanishes exactly where
 * it has to read.
 */
export function unlitCelMaterial(params = {}) {
  const clean = { ...params, posterize: false };
  const flatShading = clean.flatShading;
  delete clean.flatShading;
  const mat = celMaterial(clean);
  if (flatShading !== undefined) mat.flatShading = flatShading;
  const compileCel = mat.onBeforeCompile;
  mat.onBeforeCompile = shader => {
    compileCel(shader);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      'outgoingLight = diffuseColor.rgb;\n#include <opaque_fragment>',
    );
  };
  mat.customProgramCacheKey = () => 'cel-tinted-ramp-unlit';
  return mat;
}
