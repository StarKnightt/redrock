/* Is anything standing in the road?
 *
 * A boulder half in the driving lane is not a look, it is a collision the
 * player did not agree to, and it is invisible to every check we have: the
 * geometry is valid, the frame renders, and it only shows up when a capture
 * happens to be taken from the one angle that reveals it. Placement rules put
 * objects at a fraction of the corridor width without knowing how wide the
 * object is, so the failure is systematic rather than occasional.
 *
 * This walks every placed instance in the environment, projects it onto the
 * nearest centreline frame, and reports anything whose own extent reaches
 * across the road edge at a height the car could hit.
 *
 * EVERY SHIPPED SEED, not just the default one.
 *
 * This ran bare on seed 22 for its whole life, which meant thirteen of the
 * fourteen stages a player can actually load had never been checked — and that is
 * the structural reason a tree stood on the tarmac of seed 1 for as long as it
 * did. The audit was real, it was simply pointed at one stage out of fourteen. A
 * placement rule is a function of the noise field, so a rule that holds on one
 * seed says very little about the others: of the fourteen, seed 22 was one of only
 * six that were clean.
 *
 * The sweep costs 8.9 s for all fourteen — 0.64 s a seed, building a whole world
 * each time and rendering nothing — so there is no case for a reduced default. One
 * process doing fourteen seeds is also most of three times faster than fourteen
 * processes doing one each, which is what the old shell loop cost. `--seed` still
 * takes a single one for a quick look.
 *
 *   node tools/verge.mjs [--seeds 22,1,...] [--seed 22] [--list 20]
 */
import * as THREE from 'three';
import { Track } from '../src/world/track.js';
import { buildEnvironment } from '../src/world/environment.js';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
/* The shipped set, matching tools/boot.mjs. Kept in step by hand; a mismatch
   would mean a stage the player can load that this never looks at, which is the
   exact hole this sweep exists to close. */
const BOOT_SEEDS = '22,1,7,12,14,16,20,23,26,27,28,34,36,40';
const SEEDS = String(flag('seeds', flag('seed', BOOT_SEEDS)))
  .split(',').map(s => +s.trim()).filter(s => Number.isFinite(s));
const LIST = +flag('list', 12);

/* A gate with nothing to check has not passed — the same rule boot.mjs applies. */
if (!SEEDS.length) {
  console.log('  ✗ no seeds to check');
  process.exit(1);
}

/* How far past the road edge an object has to keep its own outline. The berm is
   scenery the car is expected to clip, so a pebble only owes the driving
   surface; anything with enough mass to stop a car owes the berm as well. */
const MARGIN_SMALL = 0.35;
const MARGIN_LARGE = 2.6;
const LARGE = 1.2;
/* Vertical window either side of the road surface. A canopy eight metres up is
   not in the way and a rock forty metres below the cliff edge is not either. */
const BELOW = 2.5, ABOVE = 3.5;

/* Not everything in the world is scenery that owes the road a berm's width.
 *
 * The default model above is a boulder's: a solid disc of the object's swept
 * radius, which must stay clear of the driving surface plus a courtesy margin. It
 * is the right model for rock, trunks and shrubs and the wrong one for two
 * categories that were both reporting offences that are not defects.
 *
 * SEETHROUGH — vegetation that is knee-high, transparent, and MOVED BY THE VERTEX
 * SHADER after this tool has read its geometry. `swaying-roadside-grass` is drawn
 * through movingCelMaterial's 'grass-wind' snippet
 * (src/world/environment.js:9397-9408), which displaces every vertex by
 * `sin(...) * 0.045 * bladeHeight` in x and `cos(...) * 0.024 * bladeHeight` in z.
 * The static position this tool can see is therefore a position the tuft is never
 * actually drawn at, which is the same blind spot camwatch has with the crowd. But
 * the sway is only ~5% of the tuft's height, about 7 cm, and the offences being
 * reported are 2 to 31 cm — so modelling the sway alone would not settle them, and
 * pretending it would would be arithmetic dressed up as a reason.
 *
 * The model is wrong in kind, and that is the real answer. A grass tuft is four
 * crossed blades 26 cm wide at the base; its circumscribed disc is half a metre.
 * Judging it as a solid half-metre cylinder flags a tuft whose CENTRE is already
 * 20 to 60 cm outside the margin, purely because the outermost blade tip leans
 * back over it. Nothing about that is in the driver's way — it is grass at the
 * road edge, drawn see-through, which is what roadside grass is for. So these are
 * judged at the point they are PLANTED, widened by the sway the shader can add,
 * rather than by the circle they sweep. A tuft planted on the tarmac is still
 * caught; a tuft leaning over the kerb is not.
 *
 * FURNITURE — barriers, markers, signs and rails, which are AT the road edge on
 * purpose. `corner-tyre-barriers` is placed at `clearOfRoad(profile, 0.5)`
 * (src/world/environment.js:5823-5840), which is deliberately the closest the
 * clearance rule permits, on the outside of a corner, because that is where a tyre
 * barrier belongs. Charging it the 0.35 m courtesy margin that exists to keep
 * scenery off the berm asks it not to do its job. These still owe the driving
 * surface itself — furniture standing on the tarmac is a defect and stays one —
 * but they are allowed inside the margin.
 *
 * Both narrow what is measured, so both are break-tested against a genuine
 * intrusion of their own kind further down; neither is a skip. */
const SEETHROUGH = /^(swaying-roadside-grass)$/;
const FURNITURE = new RegExp('^(?:corner-tyre-barriers|corner-hay-bales'
  + '|verge-markers|ramp-signs|hairpin-chevron-signs|cliff-edge-lookout-rails'
  + '|crowd-barriers|gate-(?:start|finish|bunting|chequer))$');
/* Worst-case horizontal displacement the wind snippet can add, as a fraction of
   the tuft's drawn height: hypot(0.045, 0.024) = 0.051 at the blade tip. */
const SWAY_FRAC = 0.051;

const matrix = new THREE.Matrix4();
const position = new THREE.Vector3();
const scale = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const box = new THREE.Box3();

/** One stage, judged. Returns the offences and how much was looked at. */
function checkSeed(SEED) {
const track = new Track(SEED);
const env = buildEnvironment(track, { seed: SEED });

/** Nearest centreline frame to a world point, by brute force over all samples. */
function nearest(point) {
  let best = null, bestD2 = Infinity;
  for (const f of track.frames) {
    const dx = f.pos.x - point.x, dz = f.pos.z - point.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = f; }
  }
  return best;
}

const offences = [];
/* How much was actually judged, so that "nothing intrudes" can be distinguished
   from "nothing was looked at" — see the guard above the clean exit. */
let walked = 0, considered = 0;

function consider(name, point, radius, height, kind = 'scenery') {
  considered++;
  /* Each category is charged for what it actually is — see SEETHROUGH and
     FURNITURE above. Only the footprint and the margin change; the vertical
     window and everything below it are common to all three. */
  if (kind === 'seethrough') radius = SWAY_FRAC * height;
  const f = nearest(point);
  const dx = point.x - f.pos.x, dz = point.z - f.pos.z;
  const lateral = Math.abs(dx * f.flatRight.x + dz * f.flatRight.z);
  const margin = kind === 'furniture' ? 0
    : radius > LARGE ? MARGIN_LARGE : MARGIN_SMALL;
  const edge = f.width * 0.5 + margin;
  if (lateral - radius >= edge) return;
  /* An object whose base is well above or below the roadbed is a cliff or a
     canopy, not an obstruction. Height is measured from the object's foot. */
  const dy = point.y - f.pos.y;
  if (dy > ABOVE) return;
  if (dy + height < -BELOW) return;
  offences.push({
    name,
    s: Math.round(f.s),
    p: +(f.s / track.length).toFixed(3),
    lateral: +lateral.toFixed(2),
    radius: +radius.toFixed(2),
    intrusion: +(edge - (lateral - radius)).toFixed(2),
    dy: +dy.toFixed(1),
    kind,
  });
}

/* The world's own shells and backdrop, which this tool is not about.
 *
 * What it IS about is PLACED objects: things dropped into the world at a chosen
 * position, which the placement rules can therefore put somewhere wrong —
 * boulders, trees, shrubs, hay bales, tyre barriers, signs, markers. Those can
 * be moved out of the road. The surfaces the road is cut into and the horizon it
 * is drawn against cannot, and reporting them says nothing a person can act on.
 *
 * Checked against the real name set rather than written from memory, because the
 * old pattern was matching a naming convention instead of a category and two of
 * its alternatives were wrong about the names actually in the tree:
 *
 *   `foam` never fired. The mesh is `shore-foam`, and `^foam` requires the name
 *   to BEGIN with foam, so a dead alternative sat in the list looking like
 *   coverage. Same disease as a branch outside its input's range.
 *
 *   the headland rings were not in the list at all, and they are the reason this
 *   gate was permanently red. `headland-depth-{0,1,2}` are the three depth rings
 *   of the distant-headland group — src/world/environment.js:5156-5171, whose
 *   group still carries the historical name `distant-mesas`. Ring 1 is "the
 *   actual horizon of this stage — a kilometre and a half out", and ring 0
 *   "stands in open water off the seaward shoulder" (ibid. 5516), which is what
 *   the lighthouses are put on. src/ already classifies them as backdrop:
 *   CROWD_SEETHROUGH lists `headland-depth-\d+` beside `sky-dome`, `ocean-bands`
 *   and `shore-foam` for exactly this reason.
 *
 * Widening this list is how a gate gets quietly silenced, so what it newly
 * admits was enumerated instead of assumed. Over the 42 meshes this tool walks
 * on seed 22, the change skips exactly four more: `shore-foam` and the three
 * headland rings. Nothing that is placed, and nothing that was reporting an
 * offence other than the headland. The enumeration is reproducible with
 * .fix/verge-names.mjs. */
const BACKDROP =
  /^(sky|sun-|ocean|shore-foam|basin|landform|headland-depth-\d+|road-supports|block-clouds)/;

env.traverse((object) => {
  if (!object.isMesh || !object.geometry) return;
  if (BACKDROP.test(object.name)) return;
  walked++;
  const kind = SEETHROUGH.test(object.name) ? 'seethrough'
    : FURNITURE.test(object.name) ? 'furniture' : 'scenery';
  const geometry = object.geometry;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const local = geometry.boundingBox;

  if (object.isInstancedMesh) {
    for (let i = 0; i < object.count; i++) {
      object.getMatrixAt(i, matrix);
      matrix.decompose(position, quaternion, scale);
      /* Yaw is free, so the footprint that matters is the circle the object
         sweeps, not its axis-aligned box. */
      const radius = Math.max(
        Math.abs(local.max.x), Math.abs(local.min.x),
        Math.abs(local.max.z), Math.abs(local.min.z),
      ) * Math.max(Math.abs(scale.x), Math.abs(scale.z));
      consider(`${object.name}[${i}]`, position, radius, local.max.y * scale.y, kind);
    }
    return;
  }

  /* Static merged meshes have no instances to walk, so sample their vertices
     and treat each one as a point with no radius of its own. */
  const pos = geometry.attributes.position;
  const stride = Math.max(1, Math.floor(pos.count / 4000));
  box.setFromBufferAttribute(pos);
  for (let i = 0; i < pos.count; i += stride) {
    position.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(object.matrixWorld);
    consider(`${object.name}#${i}`, position, 0, 0, kind);
  }
});

const groups = new Map();
for (const o of offences) {
  const key = o.name.replace(/[[#]\d+\]?$/, '');
  const g = groups.get(key) || { n: 0, worst: o };
  g.n++;
  if (o.intrusion > g.worst.intrusion) g.worst = o;
  groups.set(key, g);
}

/* "No offences" is only good news if something was examined.
 *
 * This gate's clean path is now the live one — it used to be red on every run, and
 * a red gate at least announces itself. A green one does not, so an empty
 * `offences` list has to be able to fail. It would otherwise read as a clear road
 * whether the road was clear or the world simply never built: a stage that threw
 * during construction, a traverse that matched nothing, or a BACKDROP pattern
 * widened until it swallowed everything all arrive here with zero offences and an
 * unqualified tick. That last one matters most, because widening that pattern is
 * exactly the edit this file invites.
 *
 * The floors are far below the observed readings rather than fitted to them, so
 * they catch a collapse without tripping when placement counts drift. Measured on
 * seeds 22, 1, 40, 7 and 99: 30 meshes judged on every one, and 17141 to 18917
 * placements considered. The floors sit about 4x and 34x under that. */
const MIN_WALKED = 8, MIN_CONSIDERED = 500;
if (walked < MIN_WALKED || considered < MIN_CONSIDERED) {
  console.log(`  seed ${SEED}: ✗ nothing was judged — ${walked} mesh(es) walked and`
    + ` ${considered} placement(s) considered, under the floor of ${MIN_WALKED} and`
    + ` ${MIN_CONSIDERED}. An empty offence list here is an empty measurement,`
    + ' not a clear road.');
  return { ok: false, empty: true };
}

if (!groups.size) {
  console.log(`  seed ${String(SEED).padStart(2)}: ✓ nothing intrudes`
    + ` (${walked} meshes, ${considered} placements)`);
  return { ok: true };
}

console.log(`  seed ${String(SEED).padStart(2)}: ✗ ${offences.length} intrusion(s) across`
  + ` ${groups.size} object set(s) (${walked} meshes, ${considered} placements)`);
for (const [key, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) {
  const w = g.worst;
  console.log(
    `      ${key.padEnd(26)} ${String(g.n).padStart(4)}  worst at p=${w.p} ` +
    `(${w.intrusion} m over the edge, radius ${w.radius} m, ${w.dy} m above the road,`
    + ` as ${w.kind})`,
  );
}
for (const o of offences.sort((a, b) => b.intrusion - a.intrusion).slice(0, LIST)) {
  console.log(`        ${o.name.padEnd(26)} p=${o.p} s=${o.s}`
    + `  lateral ${o.lateral} m  radius ${o.radius} m`);
}
return { ok: false, n: offences.length };
}

console.log(`\n  ${SEEDS.length} seed(s): ${SEEDS.join(', ')}\n`);
const bad = [];
for (const seed of SEEDS) {
  if (!checkSeed(seed).ok) bad.push(seed);
}
if (bad.length) {
  console.log(`\n  ✗ ${bad.length} of ${SEEDS.length} seed(s) have something in the road:`
    + ` ${bad.join(', ')}`);
  process.exit(1);
}
console.log(`\n  ✓ all ${SEEDS.length} seed(s) clean`);
process.exit(0);
