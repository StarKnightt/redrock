/* Do the built geometries agree with themselves?
 *
 * Winding and normals are two independent statements about which way a surface
 * faces, written in two different places, and nothing forces them to match. A
 * mismatch does not usually announce itself: the road stayed visible and
 * correctly lit, and the only symptom was that it silently stopped receiving
 * shadows. Back-face outline passes and any cel shader care about winding too,
 * so this is worth a standing check rather than another afternoon of bisecting
 * pixels in a browser.
 *
 * For each geometry: compute the geometric normal of every triangle from its
 * winding and compare it against the stored vertex normals. Reports the share
 * of triangles that disagree.
 *
 *   node tools/geom.mjs
 */
import * as THREE from 'three';
import { Track, buildRoad, buildBerms, buildGuardRail, buildGate } from '../src/world/track.js';
import { buildCar } from '../src/car/mesh.js';

const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
const cb = new THREE.Vector3(), ab = new THREE.Vector3(), n = new THREE.Vector3();
const sn = new THREE.Vector3();

/** Share of triangles whose winding disagrees with their stored normals. */
function audit(geo) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  if (!nrm) return { tris: 0, flipped: 0, note: 'no normal attribute' };
  const index = geo.index;
  const tris = (index ? index.count : pos.count) / 3;
  let flipped = 0, degenerate = 0;
  for (let t = 0; t < tris; t++) {
    const ia = index ? index.getX(t * 3) : t * 3;
    const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    A.fromBufferAttribute(pos, ia); B.fromBufferAttribute(pos, ib); C.fromBufferAttribute(pos, ic);
    // The same expression three.js uses in computeVertexNormals.
    cb.subVectors(C, B); ab.subVectors(A, B); n.crossVectors(cb, ab);
    if (n.lengthSq() < 1e-12) { degenerate++; continue; }
    sn.fromBufferAttribute(nrm, ia).add(sn.clone().fromBufferAttribute(nrm, ib));
    if (sn.lengthSq() < 1e-12) { degenerate++; continue; }
    if (n.dot(sn) < 0) flipped++;
  }
  return { tris, flipped, degenerate };
}

const track = new Track(22);
const cases = [
  ['road', buildRoad(track)],
  ['berm right', buildBerms(track, { side: 1 })],
  ['berm left', buildBerms(track, { side: -1 })],
  ['guard rail', buildGuardRail(track)],
];
// Gate and car are object hierarchies rather than single geometries.
const collect = (obj, prefix) => obj.traverse(o => {
  if (o.isMesh) cases.push([`${prefix}/${o.name || o.geometry.type}`, o.geometry]);
});
collect(buildGate(track, 40, { finish: false }), 'gate');
collect(buildCar(0).root, 'car');

let bad = 0;
for (const [label, geo] of cases) {
  const r = audit(geo);
  /* A set this tool could not audit has not passed it.
   *
   * `pct` used to fall back to 0 when `r.tris` was 0, and 0 is under the 1% bar,
   * so a geometry with no normal attribute at all — `audit`'s own early return,
   * which reports `tris: 0` and the note "no normal attribute" — printed a tick.
   * So did one with no triangles. The winding audit passing on a geometry whose
   * winding it never looked at is the shape this suite has shipped four times;
   * a builder that stopped emitting normals would have been reported as
   * consistent, in green, with the reason printed alongside the tick.
   *
   * Every case here is a real mesh with thousands of triangles today (the
   * smallest is a 12-triangle box), so nothing is being reclassified — the hole
   * was latent. It is closed by making "could not audit" its own failure rather
   * than a zero. */
  const unaudited = !r.tris || !!r.note;
  const pct = r.tris ? (100 * r.flipped / r.tris) : 0;
  const ok = !unaudited && pct < 1;
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(18)} ${String(r.tris).padStart(6)} tris` +
    `  ${pct.toFixed(1)}% wound against their normals` +
    (r.degenerate ? `  (${r.degenerate} degenerate)` : '') +
    (r.note ? `  ${r.note}` : '') +
    (unaudited ? '  ◀── NOT AUDITED, not a pass' : ''));
}
console.log(bad ? `\n  ${bad} geometry set(s) disagree with themselves or could not be audited`
  : '\n  all geometry consistent');
/* A run with no cases in it has not passed either. */
if (!cases.length) {
  console.log('  FAIL no geometry sets were built at all');
  bad++;
}
process.exit(bad ? 1 : 0);
