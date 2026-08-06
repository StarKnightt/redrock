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
 *   node tools/verge.mjs [--seed 22] [--list 20]
 */
import * as THREE from 'three';
import { Track } from '../src/world/track.js';
import { buildEnvironment } from '../src/world/environment.js';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', 22);
const LIST = +flag('list', 12);

/* How far past the road edge an object has to keep its own outline. The berm is
   scenery the car is expected to clip, so a pebble only owes the driving
   surface; anything with enough mass to stop a car owes the berm as well. */
const MARGIN_SMALL = 0.35;
const MARGIN_LARGE = 2.6;
const LARGE = 1.2;
/* Vertical window either side of the road surface. A canopy eight metres up is
   not in the way and a rock forty metres below the cliff edge is not either. */
const BELOW = 2.5, ABOVE = 3.5;

const track = new Track(SEED);
const env = buildEnvironment(track, { seed: SEED });

const matrix = new THREE.Matrix4();
const position = new THREE.Vector3();
const scale = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const box = new THREE.Box3();

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

function consider(name, point, radius, height) {
  const f = nearest(point);
  const dx = point.x - f.pos.x, dz = point.z - f.pos.z;
  const lateral = Math.abs(dx * f.flatRight.x + dz * f.flatRight.z);
  const edge = f.width * 0.5 + (radius > LARGE ? MARGIN_LARGE : MARGIN_SMALL);
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
      consider(`${object.name}[${i}]`, position, radius, local.max.y * scale.y);
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
    consider(`${object.name}#${i}`, position, 0, 0);
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

if (!groups.size) {
  console.log('  ✓ nothing intrudes on the driving surface');
  process.exit(0);
}

console.log(`  ✗ ${offences.length} intrusion(s) across ${groups.size} object set(s)\n`);
for (const [key, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) {
  const w = g.worst;
  console.log(
    `  ${key.padEnd(28)} ${String(g.n).padStart(4)}  worst at p=${w.p} ` +
    `(${w.intrusion} m over the edge, radius ${w.radius} m, ${w.dy} m above the road)`,
  );
}
console.log();
for (const o of offences.sort((a, b) => b.intrusion - a.intrusion).slice(0, LIST)) {
  console.log(`    ${o.name.padEnd(26)} p=${o.p} s=${o.s}  lateral ${o.lateral} m  radius ${o.radius} m`);
}
process.exit(1);
