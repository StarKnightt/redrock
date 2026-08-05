/* A cheap solid-world proxy for the chase camera.
 *
 * The camera needs one question answered every frame — "is there rock between
 * the driver's head and where I want to put the lens" — and it needs the
 * answer for well under a tenth of a millisecond. Three's Raycaster cannot do
 * that: it walks every triangle of every mesh handed to it, and the terrain
 * here is seventy thousand of them.
 *
 * So the solid meshes are flattened once, at build time, into world-space
 * triangles bucketed by an x/z grid. The boom is nine metres long and the
 * cells are ten, so a query touches two or three buckets and a hundred-odd
 * triangles. Bucketing in plan rather than in three dimensions is deliberate:
 * the stage stacks switchbacks over each other, so an x/z bucket does return
 * triangles from a deck fifty metres below — but it is only a prefilter, and
 * the Möller–Trumbore test behind it is exact in 3D, so nothing is mis-hit.
 *
 * Instanced meshes (boulders, plants, signs) are skipped. They are small,
 * expanding their transforms would multiply the triangle count, and a camera
 * grazing a shrub is not the failure this exists to prevent.
 *
 * What else is left out, and why, since selecting by name is a standing hazard
 * in a world other people are reshaping — run tools/camproxy.mjs to check these
 * against what is actually in the stage:
 *
 *   road          the deck itself, and by far the largest body on the stage at
 *                 41k triangles, which would grow this by well over half. Six
 *                 hundred stations of ground-truth raycasting against the full
 *                 scene never once found the deck between the driver and the
 *                 lens, so the cost buys nothing.
 *   guardrail     runs the length of the road a metre from where the camera
 *                 flies. Including it would collapse the boom on every corner
 *                 of the stage, and a rail across the frame is not the failure
 *                 this prevents — you can see straight past it.
 *   gates         start, finish, chequer and bunting. The car drives under
 *                 them; the camera cannot avoid what it must pass through, and
 *                 snatching the lens onto the bumper as you cross the line
 *                 would be a worse artefact than one frame of gate soffit.
 *   landmarks     lighthouse, turbines, streams and the rest. Nothing in the
 *                 set comes within fourteen metres of the road.
 */

const CELL = 10;

export class SolidWorld {
  /**
   * @param {THREE.Object3D} root  scene subtree to flatten
   * @param {RegExp} include       matched against the mesh's own name, or the
   *                               nearest named ancestor if it has none
   */
  constructor(root, include = /landform|basin-floor|road-supports|berm|tunnel-rock|tunnel-bore/i) {
    root.updateMatrixWorld(true);
    /* Kept on the instance so tools/camproxy.mjs can audit the real pattern
       rather than a copy of it. A second copy of this list is precisely how a
       proxy silently stops covering geometry that has been renamed or added. */
    this.include = include;

    const meshes = [];
    root.traverse(o => {
      if (!o.isMesh || o.isInstancedMesh) return;
      let name = o.name;
      for (let p = o.parent; !name && p; p = p.parent) name = p.name;
      if (include.test(name || '')) meshes.push(o);
    });

    let count = 0;
    for (const m of meshes) {
      const g = m.geometry;
      count += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
    this.count = count;
    this.tris = new Float32Array(count * 9);
    this.names = meshes.map(m => m.name);

    const e = m => m.elements;
    let w = 0;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const mesh of meshes) {
      const g = mesh.geometry;
      const pos = g.attributes.position;
      const idx = g.index;
      const n = idx ? idx.count : pos.count;
      const M = e(mesh.matrixWorld);
      for (let i = 0; i < n; i++) {
        const v = idx ? idx.getX(i) : i;
        const px = pos.getX(v), py = pos.getY(v), pz = pos.getZ(v);
        const x = M[0] * px + M[4] * py + M[8] * pz + M[12];
        const y = M[1] * px + M[5] * py + M[9] * pz + M[13];
        const z = M[2] * px + M[6] * py + M[10] * pz + M[14];
        this.tris[w++] = x; this.tris[w++] = y; this.tris[w++] = z;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
    }

    this.minX = minX; this.minZ = minZ;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / CELL) + 1);
    this.nz = Math.max(1, Math.ceil((maxZ - minZ) / CELL) + 1);

    /* CSR: count per cell, prefix sum, then fill. One Int32Array of triangle
       indices rather than six thousand small arrays — building this the naive
       way cost more than the rest of the stage put together. */
    const cells = this.nx * this.nz;
    const start = new Int32Array(cells + 1);
    const cellRange = (t, fn) => {
      const o = t * 9;
      let x0 = this.tris[o], x1 = x0, z0 = this.tris[o + 2], z1 = z0;
      for (let k = 1; k < 3; k++) {
        const x = this.tris[o + k * 3], z = this.tris[o + k * 3 + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      const i0 = this._ix(x0), i1 = this._ix(x1);
      const j0 = this._iz(z0), j1 = this._iz(z1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * this.nx + i);
    };

    for (let t = 0; t < count; t++) cellRange(t, c => { start[c + 1]++; });
    for (let c = 0; c < cells; c++) start[c + 1] += start[c];
    const items = new Int32Array(start[cells]);
    const cursor = start.slice(0, cells);
    for (let t = 0; t < count; t++) cellRange(t, c => { items[cursor[c]++] = t; });

    this.start = start;
    this.items = items;
    this.stamp = new Int32Array(count);
    this.tick = 0;
    this.entries = items.length;
  }

  _ix(x) { return Math.min(this.nx - 1, Math.max(0, ((x - this.minX) / CELL) | 0)); }
  _iz(z) { return Math.min(this.nz - 1, Math.max(0, ((z - this.minZ) / CELL) | 0)); }

  /**
   * Nearest hit along a ray, or `far` if there is none.
   *
   * `pad` widens the plan-space bucket search, which is how a fat boom is
   * approximated without a real sphere cast: the caller fires a few parallel
   * rays and every one of them sees the same candidate set.
   *
   * The face normal of whatever was hit is left in `hitNx/hitNy/hitNz`, wound
   * to face back along the ray so it always points toward open space. The
   * camera needs it for the case where shortening the boom cannot help: a wall
   * closer to the driver's head than the boom's own minimum length, where the
   * only way out is sideways rather than nearer.
   */
  raycast(ox, oy, oz, dx, dy, dz, far, pad = 0) {
    const ex = ox + dx * far, ey = oy + dy * far, ez = oz + dz * far;
    const i0 = this._ix(Math.min(ox, ex) - pad), i1 = this._ix(Math.max(ox, ex) + pad);
    const j0 = this._iz(Math.min(oz, ez) - pad), j1 = this._iz(Math.max(oz, ez) + pad);
    const T = this.tris, start = this.start, items = this.items, stamp = this.stamp;
    const tick = ++this.tick;
    let best = far;
    let bestTri = -1;

    for (let j = j0; j <= j1; j++) {
      const row = j * this.nx;
      for (let i = i0; i <= i1; i++) {
        const c = row + i;
        for (let k = start[c], end = start[c + 1]; k < end; k++) {
          const t = items[k];
          if (stamp[t] === tick) continue;
          stamp[t] = tick;

          /* Möller–Trumbore, double-sided: the terrain material is DoubleSide
             and a boom that has already ended up inside a wall has to be able
             to see its way back out. */
          const o = t * 9;
          const ax = T[o], ay = T[o + 1], az = T[o + 2];
          const e1x = T[o + 3] - ax, e1y = T[o + 4] - ay, e1z = T[o + 5] - az;
          const e2x = T[o + 6] - ax, e2y = T[o + 7] - ay, e2z = T[o + 8] - az;
          const px = dy * e2z - dz * e2y;
          const py = dz * e2x - dx * e2z;
          const pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (det > -1e-9 && det < 1e-9) continue;
          const inv = 1 / det;
          const tx = ox - ax, ty = oy - ay, tz = oz - az;
          const u = (tx * px + ty * py + tz * pz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = ty * e1z - tz * e1y;
          const qy = tz * e1x - tx * e1z;
          const qz = tx * e1y - ty * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (d > 1e-4 && d < best) { best = d; bestTri = t; }
        }
      }
    }

    if (bestTri < 0) { this.hitNx = 0; this.hitNy = 1; this.hitNz = 0; return best; }
    const o = bestTri * 9;
    const ax = T[o], ay = T[o + 1], az = T[o + 2];
    const ux = T[o + 3] - ax, uy = T[o + 4] - ay, uz = T[o + 5] - az;
    const vx = T[o + 6] - ax, vy = T[o + 7] - ay, vz = T[o + 8] - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
    nx *= inv; ny *= inv; nz *= inv;
    /* Winding is not dependable here — the terrain is DoubleSide and the boom
       can hit a face from either side — so the normal is flipped to oppose the
       ray rather than trusted as authored. */
    if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }
    this.hitNx = nx; this.hitNy = ny; this.hitNz = nz;
    return best;
  }
}
