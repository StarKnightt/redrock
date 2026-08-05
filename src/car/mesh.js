/* The car.
 *
 * Lofted from cross-sections along its length rather than assembled from
 * boxes. A box car is instantly readable as a box car, and no amount of
 * shading rescues it; lofting costs about the same and gives real shoulders,
 * a tapering nose and a tucked-in sill — the shapes an outline pass has
 * something to draw around.
 *
 * Everything is one geometry with vertex colours, so the whole car is a single
 * draw call under a single cel material. The wheels are separate because they
 * spin, and the body is separate from the chassis root because the suspension
 * leans it.
 *
 * Proportions are deliberately exaggerated: short overhangs, a wide track,
 * wheels a size too big and a cabin pulled back. That is what reads as
 * "rally car" in silhouette at 140 km/h from eight metres behind.
 */
import * as THREE from 'three';
import { mergeGeometries } from '../world/track.js';

/** A chamfered hexagonal section: flat floor, kicked-out shoulders, narrower roof. */
function section(hw, yBot, yTop, shoulder = 0.86, tuck = 0.9, shoulderY = 0.38) {
  const yMid = yBot + (yTop - yBot) * shoulderY;
  return [
    [-hw * tuck, yBot], [hw * tuck, yBot],
    [hw, yMid], [hw * shoulder, yTop],
    [-hw * shoulder, yTop], [-hw, yMid],
  ];
}

/**
 * Loft a closed profile along z.
 * @param {{z:number, pts:number[][], col:THREE.Color}[]} stations
 */
function loft(stations, { capFront = true, capBack = true } = {}) {
  const P = stations[0].pts.length;
  const verts = [], cols = [], idx = [];
  for (const st of stations) {
    for (const [x, y] of st.pts) {
      verts.push(x, y, st.z);
      cols.push(st.col.r, st.col.g, st.col.b);
    }
  }
  for (let i = 0; i < stations.length - 1; i++) {
    for (let e = 0; e < P; e++) {
      const a = i * P + e, b = i * P + ((e + 1) % P);
      const c = a + P, d = b + P;
      idx.push(a, b, c, b, d, c);
    }
  }
  // Fans rather than a triangulation: the sections are convex by construction.
  if (capFront) for (let e = 1; e < P - 1; e++) idx.push(0, e + 1, e);
  if (capBack) {
    const o = (stations.length - 1) * P;
    for (let e = 1; e < P - 1; e++) idx.push(o, o + e, o + e + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Bake a flat colour into every vertex of a geometry. */
function tint(g, col) {
  const c = col.isColor ? col : new THREE.Color(col);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function place(g, x, y, z, rx = 0, ry = 0, rz = 0) {
  g.applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(1, 1, 1)));
  return g;
}

/** A box with a colour baked into its vertices, positioned and rotated. */
function box(w, h, d, col, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  return place(tint(new THREE.BoxGeometry(w, h, d), col), x, y, z, rx, ry, rz);
}

/**
 * A fender: a rectangular cross-section swept along an arc about the x axis,
 * centred on a wheel hub. Built as a real swept surface rather than as a row
 * of rotated boxes — discrete slats leave gaps at the outer radius and their
 * corners catch the light individually, so in profile they read as a row of
 * teeth around the wheel instead of as one curved panel over it.
 * @param {number} xi inner face, signed; @param {number} xo outer face, signed
 */
function fender(xi, xo, hubY, hubZ, r0, r1, span, col, steps = 9) {
  const pos = [], idx = [];
  // Cross-section corners, ordered so that consecutive-section quads wound
  // (a, b, d) / (a, d, c) all face outwards for a sweep of increasing angle.
  const sect = xo > xi
    ? [[xi, r1], [xo, r1], [xo, r0], [xi, r0]]
    : [[xi, r0], [xo, r0], [xo, r1], [xi, r1]];
  for (let i = 0; i < steps; i++) {
    const a = -span / 2 + (i / (steps - 1)) * span;
    const c = Math.cos(a), s = Math.sin(a);
    for (const [x, r] of sect) pos.push(x, hubY + c * r, hubZ + s * r);
  }
  for (let i = 0; i < steps - 1; i++) {
    for (let k = 0; k < 4; k++) {
      const a = i * 4 + k, b = i * 4 + (k + 1) % 4;
      idx.push(a, b, b + 4, a, b + 4, a + 4);
    }
  }
  // Caps, so the ends are closed where the fender meets the bodyside.
  const last = (steps - 1) * 4;
  idx.push(0, 2, 1, 0, 3, 2, last, last + 1, last + 2, last, last + 2, last + 3);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return tint(g, col);
}

/** A short cylinder lying along z — lamps, tubing, hubs. */
function disc(r, depth, col, x, y, z, sides = 10) {
  const g = new THREE.CylinderGeometry(r, r, depth, sides, 1);
  g.rotateX(Math.PI / 2);
  return place(tint(g, col), x, y, z);
}

/* The hero is lifted well clear of the stage.
   At 0xd8462a it sat about fifteen degrees from the canyon's red-brown at
   similar saturation and similar value, so the player's own car was less
   legible in its own frame than the green AI two hundred metres up the road —
   the palette hierarchy was inverted. It is now a higher-key, more saturated
   red-orange whose value is clearly above the slate of the road it is always
   seen against, which is the pairing that has to work in every single frame
   of the game.
   Trim is a cool near-black rather than a warm one, so it belongs to the
   shadow family, and the glass is lifted off the floor of the value ladder —
   at 0x2c4256 the whole cabin quantised straight to solid black and the car
   lost its greenhouse at close range. */
const PALETTES = [
  { body: 0xff5a24, trim: 0x2b2833, accent: 0xffc63d },   // player: rally orange-red
  { body: 0x2f7fbd, trim: 0x22262b, accent: 0xe8e2d4 },
  { body: 0xe0d24a, trim: 0x2b2620, accent: 0x37312c },
  { body: 0x63b562, trim: 0x232a24, accent: 0xf2efe4 },
  { body: 0xb9b4ad, trim: 0x2a2726, accent: 0xcf3f2f },
];

/* Track is deliberately close to the body width and the wheels are large:
   what makes a car read as "rally" at a glance is fat tyres sitting proud of
   flared arches with daylight above them. The first pass had a 1.66 m track
   inside a 2.02 m body, so the wheels were tucked under the shell and the car
   read as a skirted prototype. */
export const CAR = {
  length: 4.1, width: 2.02, wheelBase: 2.62,
    track: 2.00, wheelR: 0.50, wheelW: 0.36,
  rideHeight: 0.30,
};

/**
 * Build one car.
 * @returns {{root:THREE.Group, body:THREE.Group, wheels:THREE.Object3D[], steerWheels:THREE.Object3D[]}}
 */
export function buildCar(paletteIndex = 0) {
  const pal = PALETTES[paletteIndex % PALETTES.length];
  const body = new THREE.Color(pal.body);
  const shade = new THREE.Color(pal.body).multiplyScalar(0.72);
  const trim = new THREE.Color(pal.trim);
  const glass = new THREE.Color(0x41637f);
  const accent = new THREE.Color(pal.accent);

  const parts = [];

  /* ---- main shell -------------------------------------------------- */
  const S = (z, hw, yb, yt, sh, tk, col, shy) =>
    ({ z, pts: section(hw, yb, yt, sh, tk, shy), col: col || body });

  /* Two changes from the first pass, both about silhouette.
     Short overhangs: the nose used to reach z=-2.15 against a front axle at
     -1.31, so a third of the wheelbase hung ahead of the wheel and the car
     read cab-rearward, like a muscle car.
     A narrow body: the shell is now inboard of the tyres rather than as wide
     as them. A closed loft cannot have an arch cut into it, so the only way to
     get daylight around a wheel is to keep the bodyside inside the wheel's
     inner face and bridge back out over the top with a flare. */
  parts.push(loft([
    S(-1.86, 0.50, 0.16, 0.44, 0.80, 0.86, trim),      // nose tip / bumper
    S(-1.72, 0.68, 0.10, 0.56, 0.86, 0.88, trim),
    S(-1.60, 0.74, 0.08, 0.62, 0.88, 0.88),
    S(-1.31, 0.79, 0.06, 0.70, 0.90, 0.86),            // over the front axle
    S(-0.62, 0.80, 0.05, 0.76, 0.92, 0.84),
    S(0.10, 0.80, 0.05, 0.78, 0.92, 0.84),
    S(0.86, 0.80, 0.05, 0.76, 0.92, 0.84),
    S(1.31, 0.79, 0.06, 0.72, 0.90, 0.86),             // over the rear axle
    S(1.72, 0.70, 0.10, 0.64, 0.88, 0.88),
    S(1.94, 0.56, 0.14, 0.54, 0.84, 0.86, trim),       // tail
  ]));

  /* ---- greenhouse ---------------------------------------------------
     A separate loft so the windscreen can rake hard without dragging the
     shoulder line with it. Narrower than the body, which is what gives the
     car its tumblehome and stops it reading as a shoebox. */
  const G = (z, hw, yb, yt, sh, col) => ({ z, pts: section(hw, yb, yt, sh, 0.98, 0.5), col: col || glass });
  /* Pairs of stations share a z where the material changes. The loft
     interpolates colour between neighbours, so without a coincident pair the
     body colour bleeds up through the windscreen as a gradient and the cabin
     reads as glowing rather than glazed. The duplicate quads are zero-area. */
  parts.push(loft([
    G(-0.86, 0.54, 0.76, 0.88, 0.90, shade),           // scuttle
    G(-0.60, 0.64, 0.76, 1.00, 0.88, shade),           // cowl
    G(-0.60, 0.64, 0.76, 1.00, 0.88),                  // hard break into glass
    G(-0.18, 0.70, 0.76, 1.38, 0.86),                  // top of the screen
    G(0.62, 0.70, 0.76, 1.40, 0.86),                   // roof
    G(1.02, 0.66, 0.76, 1.30, 0.88),                   // rear screen
    G(1.02, 0.66, 0.76, 1.30, 0.88, shade),            // hard break out of glass
    G(1.30, 0.58, 0.76, 1.04, 0.90, shade),
  ], { capFront: true, capBack: true }));

  // Roof panel, so the cabin is not glass all the way over.
  parts.push(box(1.18, 0.10, 0.94, body, 0, 1.41, 0.24));
  // Roof scoop, with a mouth facing forward so it reads as an intake.
  parts.push(box(0.40, 0.15, 0.44, shade, 0, 1.51, 0.02));
  parts.push(box(0.30, 0.10, 0.05, 0x14100f, 0, 1.51, -0.21));

  /* Pillars. Without them the greenhouse is one continuous tinted blister,
     which reads as a fighter canopy rather than as a car cabin. */
  for (const sx of [-1, 1]) {
    parts.push(box(0.08, 0.60, 0.10, body, sx * 0.64, 1.17, -0.39, 0.835));  // A
    parts.push(box(0.08, 0.34, 0.10, body, sx * 0.69, 1.16, 0.60));          // B
  }

  /* ---- wheel arches --------------------------------------------------
     Flared boxes rather than tori: at this poly budget a torus reads as a
     smooth donut stuck on the side, where a chunky flare reads as bodywork.
     The flare has to reach past the tyre's outer face (x = 1.18) or the wheel
     looks like it is escaping from under the car. */
  /* Seven slats swept around the tyre's arc rather than a box over the top of
     it. The outline pass traces silhouette, so a cuboid here would be drawn as
     a hard black rectangle and read as a crate bolted to the side of the car;
     following the arc costs the same triangles and reads as bodywork. */
  /* The arc stops short of the hub line. Carried further round it would reach
     past the front and back of the tyre, and a fender that wraps the whole
     wheel reads as a mudguard on a tractor. */
  const HUB = CAR.wheelR - CAR.rideHeight;
  for (const z of [-1.31, 1.31]) {
    for (const sx of [-1, 1]) {
      // Outer face clears the tyre's outer face (track/2 + wheelW/2 = 1.18).
      parts.push(fender(sx * 0.78, sx * 1.23, HUB, z, 0.57, 0.71, 1.94, trim));
      // A shade-coloured lip just under it, to catch a second tone on the curve.
      parts.push(fender(sx * 0.84, sx * 1.19, HUB, z, 0.50, 0.57, 1.72, shade, 7));
    }
  }

  /* ---- bumpers, sills, lights ---------------------------------------- */
  parts.push(box(1.46, 0.26, 0.26, trim, 0, 0.26, -1.84));         // front bumper
  parts.push(box(1.48, 0.24, 0.26, trim, 0, 0.26, 1.92));          // rear bumper
  parts.push(box(1.16, 0.12, 0.30, 0x1a1618, 0, 0.12, 1.88));      // rear diffuser
  for (const sx of [-1, 1]) {
    parts.push(box(0.12, 0.22, 1.50, trim, sx * 0.78, 0.10, 0.08));   // sill
    /* A colour flash along the sill. The bottom of the car was one unbroken
       black band running nose to tail, which at any distance merged with the
       tyres and the ground shadow into a single dark smear. */
    parts.push(box(0.09, 0.09, 1.30, accent, sx * 0.82, 0.20, 0.08));
    parts.push(box(0.30, 0.16, 0.10, accent, sx * 0.48, 0.46, -1.88));  // headlight
    /* Lens on a recessed dark bezel, and proud of the tail. These were small
       and flush, so at any distance they sampled the same as the dark panel
       around them and the back of the car had no colour on it at all. */
    parts.push(box(0.50, 0.34, 0.06, 0x161214, sx * 0.44, 0.56, 1.95));
    parts.push(box(0.44, 0.26, 0.08, 0xf04a2a, sx * 0.44, 0.56, 1.99));
    parts.push(box(0.12, 0.12, 0.18, 0x5a5a5e, sx * 0.42, 0.20, 2.00)); // exhaust
    // Mud flaps behind each wheel: cheap, and unmistakably rally.
    for (const z of [-1.31, 1.31]) {
      parts.push(box(0.34, 0.30, 0.04, 0x1a1618, sx * 0.98, 0.14, z + 0.68));
    }
    // Bull-bar uprights: reads as rally kit and gives the nose a silhouette.
    parts.push(box(0.09, 0.40, 0.09, trim, sx * 0.44, 0.44, -1.96));
  }
  parts.push(box(1.06, 0.11, 0.11, trim, 0, 0.64, -1.96));          // bull bar
  /* Four spot lamps. Cubes read as a crate of butter strapped to the nose; a
     dark bezel with a bright lens inside it reads as a lamp even at eight
     metres, and the round silhouette survives an outline pass. */
  for (const x of [-0.39, -0.13, 0.13, 0.39]) {
    parts.push(disc(0.125, 0.10, trim, x, 0.74, -1.99));
    parts.push(disc(0.093, 0.05, accent, x, 0.74, -2.05));
  }

  /* ---- rear wing ------------------------------------------------------ */
  /* Sized off the rear silhouette, not the side one. The player looks at the
     back of this car for the whole race, and a wing tucked down on the deck
     contributes nothing there however good it looks in a side orbit — it has
     to span the full body and sit clear of the deck to register at all. */
  parts.push(box(1.74, 0.09, 0.40, shade, 0, 1.27, 1.78, -0.15));
  parts.push(box(1.62, 0.05, 0.15, accent, 0, 1.235, 1.62, -0.15));   // gurney lip
  for (const sx of [-1, 1]) {
    parts.push(box(0.07, 0.34, 0.46, trim, sx * 0.86, 1.24, 1.78));   // endplate
    parts.push(box(0.13, 0.40, 0.15, trim, sx * 0.52, 1.05, 1.74));   // stem
  }

  const shell = mergeGeometries(parts);
  parts.forEach(p => p.dispose());
  shell.computeVertexNormals();

  const bodyGroup = new THREE.Group();
  bodyGroup.add(new THREE.Mesh(shell));   // material assigned by the caller
  bodyGroup.children[0].castShadow = true;
  bodyGroup.children[0].name = 'shell';

  /* ---- wheels ---------------------------------------------------------
     Twelve-sided so the facets are visible and the outline has corners to
     catch — a smooth cylinder reads as a black disc under cel shading. */
  const wheels = [], steerWheels = [];
  const R = CAR.wheelR, W = CAR.wheelW;

  /* Sixteen sides, not twelve. At twelve the tyre reads as faceted by accident
     rather than by choice and visibly walks as it spins. */
  const axle = g => { g.rotateZ(Math.PI / 2); return g; };
  const tyreGeo = tint(axle(new THREE.CylinderGeometry(R, R, W, 16, 1)), 0x1d1a1c);
  // Inset rim with a dark gap around it, so the outline pass has an edge here.
  const rimGeo = tint(axle(new THREE.CylinderGeometry(R * 0.64, R * 0.64, W * 1.04, 16, 1)),
    new THREE.Color(pal.accent).multiplyScalar(0.35));
  const faceGeo = tint(axle(new THREE.CylinderGeometry(R * 0.56, R * 0.56, W * 1.08, 16, 1)), pal.accent);
  const hubGeo = tint(axle(new THREE.CylinderGeometry(R * 0.17, R * 0.17, W * 1.16, 8, 1)), 0x201d1e);

  const wheelParts = [tyreGeo, rimGeo, faceGeo, hubGeo];
  // Five chunky spokes: a plain disc reads as a vinyl record and looks static
  // however fast it turns.
  for (let s = 0; s < 5; s++) {
    const a = (s / 5) * Math.PI * 2;
    const spoke = tint(new THREE.BoxGeometry(W * 1.12, R * 0.60, R * 0.17), 0x201d1e);
    spoke.rotateX(a);
    spoke.translate(0, Math.cos(a) * R * 0.30, Math.sin(a) * R * 0.30);
    wheelParts.push(spoke);
  }

  for (let i = 0; i < 4; i++) {
    const front = i < 2, left = i % 2 === 0;
    const wheelGeo = mergeGeometries(wheelParts.map(g => g.clone()));
    wheelGeo.computeVertexNormals();
    const mesh = new THREE.Mesh(wheelGeo);
    mesh.castShadow = true;
    mesh.name = `wheel${i}`;

    /* Steering has to rotate about the hub, and the spin has to be inside
       that — so each wheel is a hub group holding a spin group. */
    const hub = new THREE.Group();
    hub.position.set(
      (left ? -1 : 1) * CAR.track * 0.5,
      CAR.wheelR,
      front ? -CAR.wheelBase * 0.5 : CAR.wheelBase * 0.5);
    const spin = new THREE.Group();
    spin.add(mesh);
    hub.add(spin);
    hub.userData.spin = spin;
    hub.userData.front = front;
    wheels.push(hub);
    if (front) steerWheels.push(hub);
  }
  wheelParts.forEach(g => g.dispose());

  const root = new THREE.Group();
  root.add(bodyGroup);
  for (const w of wheels) root.add(w);

  return { root, body: bodyGroup, wheels, steerWheels, palette: pal };
}
