/* Do the birds read as birds — and can this tool see one at all?
 *
 * A bird in this stage is an instance whose position is a looping path in the
 * vertex shader, so it is never where its instance data says it is and pointing
 * a camera at one by hand does not work. This parks a single bird at a chosen
 * distance in front of the lens, isolates it (every other instance is switched
 * off), pins the shader clock, and captures the flap cycle at six phases so the
 * silhouette can be judged in the up pose, the down pose and the transit rather
 * than at whatever phase a shoot lands on.
 *
 * ── Why the control frame exists ──────────────────────────────────────────────
 *
 * The previous version of this file wrote twelve frames that contained no bird
 * at all, and reported numbers about them anyway. Three probes have been thrown
 * away on this project this week for confident zeros produced by blind
 * instruments, and a bird probe is especially easy to blind: the subject is one
 * dark shape a few dozen pixels across, and every failure mode — the boot veil
 * still up, the bird solved to a point behind the lens, the mesh frustum-culled,
 * the clock not pinned so it has moved on by the time the shutter opens —
 * produces a frame of empty sky that looks exactly like a frame of empty sky.
 *
 * So no number here is reported until the instrument has proved, per frame,
 * that it is looking at the bird:
 *
 *   1  the null frame. Two captures with nothing changed between them must be
 *      the same picture. This is not a formality — see the clock note below.
 *   2  every frame is shot twice, once with the mesh hidden and once with it
 *      shown, and the silhouette is the DIFFERENCE of the two. A mask is not
 *      inferred from a colour key or a bounding box; it is the set of pixels
 *      the bird is responsible for, by construction.
 *   3  a frame whose mask is smaller than SEEN_MIN is not measured. It is
 *      reported as blind and the run fails.
 *   4  the mask's centroid is held against where the build says it parked the
 *      bird, projected through the same camera. This is the check that catches
 *      the interesting failure — a mask that is real but is some other object
 *      flickering, or a JS-side mirror of the flight path that has drifted from
 *      the GLSL one. The tolerance is a fraction of the bird's own size on
 *      screen, because a fixed pixel count is a different demand at nine metres
 *      than at forty.
 *
 * (4) only has teeth against a build that will say where it put the bird. The
 * pre-round birds could not, so against those this degrades to (1)-(3) and
 * says so in the output.
 *
 * Check (1) earned its place on the first run of this file. The ocean, the
 * grass, the turbines and the birds themselves all take their uTime from
 * `performance.now()` inside `onBeforeRender` — tools/shfreeze.mjs documents
 * the same property from the other side — so two renders of a *paused* scene
 * are two different pictures, and the hidden/shown difference came back as
 * 423,193 px of "bird" in a 518,400 px frame. That is the whole world moving,
 * with the bird lost somewhere inside it, and every number computed from it was
 * meaningless. The wall clock is pinned below before any shutter opens.
 *
 * ── What it measures ──────────────────────────────────────────────────────────
 *
 *   hairline    the wing's rise across its half-span, in degrees, and how many
 *               distinct normals the wing triangles carry — a wing whose
 *               triangles share one normal cannot be separated by any lit ramp.
 *               Then the pixel half of the same question: the difference in
 *               mean value between the two halves of the silhouette, which is
 *               zero for a flat wing and zero for an unlit material.
 *   flock       nearest-neighbour distance over every bird on the stage. Label
 *               free on purpose, so it reads the same way on a build with no
 *               flock structure to declare and on one that has it.
 *   span        tip to tip, in metres.
 *   ink         how many pixels the ink pass changes on the bird. Shot twice,
 *               ink on and ink off, and differenced inside the mask plus a
 *               three-pixel halo. A bird the prepass draws at the model origin
 *               scores zero here however heavily the rest of the frame is inked.
 *
 *   node tools/birds.mjs [--seed 22]
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run, capture, settleBoot } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');

const W = 960, H = 540;
const PHASES = 6;
/* Where each set is parked, in metres in front of the lens. Both sets live much
   further out on the stage — 105–240 m for the flocks — but a silhouette cannot
   be judged at thirty pixels of sky, and judging the silhouette is what this
   shoot is for. The scale being looked at is still each set's own.

   The lens itself is left alone. An earlier version of this file narrowed it to
   26 deg for the shoot, and the camera rig put it back somewhere between the
   two captures of a pair, so the control differenced a wide frame against a
   zoomed one and called the whole picture "bird" — six of twelve frames, and
   they looked exactly like the honest ones in the log. Nothing here touches the
   camera now; the pair is shot through whatever lens the game is using, which
   is the only way the two frames are guaranteed to agree about everything
   except the bird. */
const DIST = { far: 7, near: 4.5 };
/* A 1.4 m bird at 14 m is around a hundred pixels across and, being mostly
   wing, a few hundred pixels of area. Forty is comfortably below anything real
   and comfortably above compression noise on a flat sky. */
const SEEN_MIN = 40;
/* Where the build says the bird is has to land ON the bird. Not on its
   centroid: a silhouette's centroid is not its origin — the wings sit above the
   body, the tail is longer than the head, and when the wings are fully up the
   centroid climbs with them, which failed an honest frame by five pixels on the
   first run. The test is containment in the pixels the bird actually changed,
   with a few pixels of margin for the thin end of a wing. That is the strong
   form anyway: a bird drawn at the model origin five kilometres away does not
   land inside its own silhouette by accident. */
const SEEN_PAD = 5;
/* And what the null frame is allowed to be. Not zero: the capture path is PNG
   over a compositor and a handful of pixels can flicker on a gradient. */
const NULL_MAX = 12;

const OUT = path.join(ROOT, 'shots', 'birds');
const dirs = {
  ink: OUT,
  inkHidden: path.join(OUT, 'control'),
  noink: path.join(OUT, 'noink'),
  noinkHidden: path.join(OUT, 'noink', 'control'),
  crop: path.join(OUT, 'crop'),
};
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

/* ── page side ─────────────────────────────────────────────────────────────── */

/* Find the birds and describe the geometry. Runs once per browser. */
const survey = ({ page }) => page.evaluate(() => {
  const g = window.__game;
  g.driveTo(0.3);
  g.setPaused(true);
  const found = [];
  g.scene.traverse(o => { if (o.isMesh && /bird/.test(o.name || '')) found.push(o); });
  window.__birds = found;

  return found.map(mesh => {
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const probe = mesh.userData.birdProbe || null;

    /* Geometry, in its rest pose. Non-indexed on both the old build and the
       new one, so a triangle is three consecutive vertices. */
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      minX = Math.min(minX, pos.getX(i));
      maxX = Math.max(maxX, pos.getX(i));
    }
    const halfSpan = Math.max(Math.abs(minX), Math.abs(maxX));
    const normals = [];
    let wingTris = 0, wingLo = Infinity, wingHi = -Infinity;
    for (let t = 0; t < pos.count; t += 3) {
      const p = [0, 1, 2].map(k => [pos.getX(t + k), pos.getY(t + k), pos.getZ(t + k)]);
      const reach = Math.max(...p.map(v => Math.abs(v[0])));
      /* A wing triangle is one that gets out past a third of the half-span.
         The body diamond and its keel sit inside that on both builds. */
      if (reach < halfSpan * 0.34) continue;
      wingTris++;
      for (const v of p) { wingLo = Math.min(wingLo, v[1]); wingHi = Math.max(wingHi, v[1]); }
      const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
      const w = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const len = Math.hypot(...n) || 1;
      normals.push(n.map(v => v / len));
    }
    /* Distinct to a hundredth. Two triangles that agree to that are one
       shading surface as far as any ramp in this renderer is concerned. */
    const key = n => n.map(v => v.toFixed(2)).join(',');
    const distinct = new Set(normals.map(key)).size;
    let maxAngle = 0;
    for (let i = 0; i < normals.length; i++) {
      for (let j = i + 1; j < normals.length; j++) {
        const d = Math.min(1, Math.max(-1,
          normals[i][0] * normals[j][0] + normals[i][1] * normals[j][1]
          + normals[i][2] * normals[j][2]));
        maxAngle = Math.max(maxAngle, Math.acos(d) * 180 / Math.PI);
      }
    }

    /* Placement. The new build hands over what it authored; the old one has
       nothing but the instance matrices, which is all this needs. */
    let spans = [], points = [], flocks = null, lit = null;
    if (probe) {
      const inst = probe.instances();
      spans = inst.map(i => i.span);
      points = inst.map(i => i.at);
      flocks = inst.map(i => i.flock);
      lit = probe.lit;
    } else {
      const width = maxX - minX;
      const m = mesh.instanceMatrix;
      for (let i = 0; i < mesh.count; i++) {
        const o = i * 16;
        const a = m.array;
        /* Column 0's length is the x scale, and these are uniform scales. */
        spans.push(Math.hypot(a[o], a[o + 1], a[o + 2]) * width);
        points.push([a[o + 12], a[o + 13], a[o + 14]]);
      }
      lit = !!(mesh.material && mesh.material.isMeshLambertMaterial === true
        || (mesh.material && mesh.material.lights === true));
    }

    /* Nearest neighbour, over every bird of this set. O(n^2) on seventy
       instances. Distance to the closest other bird is what "is this a flock"
       comes down to and it needs no labels to ask. */
    const nn = [];
    for (let i = 0; i < points.length; i++) {
      let best = Infinity;
      for (let j = 0; j < points.length; j++) {
        if (i === j) continue;
        const d = Math.hypot(points[i][0] - points[j][0],
          points[i][1] - points[j][1], points[i][2] - points[j][2]);
        best = Math.min(best, d);
      }
      if (Number.isFinite(best)) nn.push(best);
    }
    nn.sort((a, b) => a - b);
    const q = f => (nn.length ? nn[Math.min(nn.length - 1, Math.floor(f * nn.length))] : NaN);

    /* And the exact intra-flock spread when the build knows its own flocks. */
    let flockSpread = null;
    if (flocks) {
      const byFlock = new Map();
      flocks.forEach((f, i) => {
        if (!byFlock.has(f)) byFlock.set(f, []);
        byFlock.get(f).push(points[i]);
      });
      const widths = [];
      for (const members of byFlock.values()) {
        let wmax = 0;
        for (let i = 0; i < members.length; i++) {
          for (let j = i + 1; j < members.length; j++) {
            wmax = Math.max(wmax, Math.hypot(
              members[i][0] - members[j][0],
              members[i][1] - members[j][1],
              members[i][2] - members[j][2]));
          }
        }
        widths.push(wmax);
      }
      widths.sort((a, b) => a - b);
      flockSpread = {
        flocks: widths.length,
        median: widths[Math.floor(widths.length / 2)],
        max: widths[widths.length - 1],
      };
    }

    return {
      name: mesh.name,
      probe: !!probe,
      lit,
      instances: points.length,
      trisEach: pos.count / 3,
      geomWidth: maxX - minX,
      wingTris,
      wingRise: Math.atan2(wingHi - wingLo, halfSpan) * 180 / Math.PI,
      wingNormals: distinct,
      wingNormalSpread: maxAngle,
      spanMin: Math.min(...spans),
      spanMax: Math.max(...spans),
      nnMedian: q(0.5),
      nnP90: q(0.9),
      flockSpread,
    };
  });
});

/* Park bird 0 of set `idx` in front of the lens at flap phase `t`, hide every
   other instance, and return where the build says it put it. */
const parkBird = ({ page }, idx, kind, t) => page.evaluate(([idx, kind, t, dist]) => {
  const g = window.__game;
  const THREE = g.THREE;
  const mesh = window.__birds[idx];

  // Aim a little above the horizon so the subject is against sky.
  const fwd = new THREE.Vector3();
  g.camera.getWorldDirection(fwd);
  fwd.y += 0.16; fwd.normalize();
  const want = g.camera.position.clone().addScaledVector(fwd, dist);
  const yaw = Math.PI * 0.62;

  const probe = mesh.userData.birdProbe;
  let placed = null;
  if (probe) {
    probe.pin(t);
    probe.isolate(1);
    /* The build parks it and the build reports where — this tool does not get
       to hold its own opinion about where the bird is and then grade the
       picture against that. */
    placed = probe.park(0, want.x, want.y, want.z, yaw);
  } else {
    /* The pre-round birds. Position is the instance translation plus a drift
       whose phase is a function of that same translation, so there is nothing
       to invert; this converges on it instead. Kept so the before/after
       numbers in .fix/birds-progress.md can be reproduced. */
    const near = /near/.test(mesh.name);
    const drift = p => (near
      ? new THREE.Vector3(
        Math.sin(t * 0.34 + p.x * 0.017 + p.z * 0.023) * 4.8,
        (0.5 + 0.5 * Math.sin(t * 0.46 + p.x * 0.017 + p.z * 0.023)) * 3.2,
        Math.cos(t * 0.27 + (p.x * 0.017 + p.z * 0.023) * 0.8) * 6.4)
      : new THREE.Vector3(
        Math.sin(t * 0.31 + p.x * 0.013 + p.z * 0.019) * 1.3, 0,
        Math.cos(t * 0.24 + (p.x * 0.013 + p.z * 0.019) * 0.7) * 1.8));
    /* Damped, because the undamped form oscillates for the near set — its
       drift is up to 6.4 m and the bare iteration walks between two points
       either side of the answer instead of settling on it. */
    let q = want.clone();
    for (let i = 0; i < 60; i++) {
      q = q.clone().multiplyScalar(0.5).addScaledVector(want.clone().sub(drift(q)), 0.5);
    }
    const scale = near ? 1.5 : 2.4;
    mesh.setMatrixAt(0, new THREE.Matrix4().compose(
      q,
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)),
      new THREE.Vector3(scale, scale, scale)));
    mesh.instanceMatrix.needsUpdate = true;
    if (window.__count === undefined) window.__count = {};
    if (window.__count[idx] === undefined) window.__count[idx] = mesh.count;
    mesh.count = 1;
    mesh.onBeforeRender = () => {
      const sh = mesh.material.userData.shader;
      if (sh) sh.uniforms.uTime.value = t;
    };
    /* No claim about where it ended up: the drift solve is this tool's own
       copy of the shader and grading a picture with it would be grading the
       copy. The mask still has to exist and still has to be bird-sized. */
    placed = null;
  }

  g.renderOnce();

  const ndc = placed
    ? new THREE.Vector3(placed[0], placed[1], placed[2]).project(g.camera)
    : null;
  return { ndc: ndc ? [ndc.x, ndc.y] : null };
}, [idx, kind, t, DIST[kind]]);

const setVisible = ({ page }, idx, on) => page.evaluate(([idx, on]) => {
  const g = window.__game;
  window.__birds[idx].visible = on;
  g.renderOnce();
}, [idx, on]);

/* Pin the wall clock. Every moving material on this stage reads
   `performance.now()` inside its own `onBeforeRender`, so without this two
   renders of a paused scene differ everywhere and the control frame measures
   the sea rather than the bird. Freezing it is what makes a paused render
   reproducible, and reproducibility is the whole basis of a difference. */
const freezeWallClock = ({ page }) => page.evaluate(() => {
  if (window.__birdFrozen) return;
  const at = performance.now.call(performance);
  performance.now = () => at;
  window.__birdFrozen = true;
});

const rerender = ({ page }) => page.evaluate(() => window.__game.renderOnce());

/* ── analysis, also page side: a browser is the PNG decoder that is already
      running, the same way tools/imgstat.mjs uses one ──────────────────────── */

const analyse = ({ page }, shown, hidden, plain, ndc) => page.evaluate(
  async ([shownB64, hiddenB64, plainB64, ndc, TOL]) => {
    const decode = async b64 => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height);
    };
    const A = await decode(shownB64);
    const B = await decode(hiddenB64);
    const C = plainB64 ? await decode(plainB64) : null;
    const w = A.width, h = A.height, a = A.data, b = B.data;

    const mask = new Uint8Array(w * h);
    let area = 0, sx = 0, sy = 0;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0, p = 0; p < w * h; p++, i += 4) {
      const d = Math.max(
        Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      if (d <= TOL) continue;
      mask[p] = 1;
      area++;
      const x = p % w, y = (p / w) | 0;
      sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!area) return { area: 0 };

    const lum = i => 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2];
    /* The two halves of the silhouette, split at its own centre. On a flat
       wing under an unlit material these are the same number to the bit. */
    const mid = (x0 + x1) * 0.5;
    let lSum = 0, lN = 0, rSum = 0, rN = 0;
    const buckets = new Map();
    for (let p = 0; p < w * h; p++) {
      if (!mask[p]) continue;
      const i = p * 4, x = p % w, v = lum(i);
      if (x < mid) { lSum += v; lN++; } else { rSum += v; rN++; }
      const k = Math.round(v / 8);
      buckets.set(k, (buckets.get(k) || 0) + 1);
    }
    /* Value steps holding at least 4% of the bird. A cel ramp separating two
       wings shows up here as two, and as one when it cannot. */
    const steps = [...buckets.values()].filter(n => n >= area * 0.04).length;

    /* ── Ink ──────────────────────────────────────────────────────────────
     *
     * The first version of this measured how much the ink pass changed inside
     * the mask plus a three-pixel halo, and it reported 9–18% for birds that
     * carry no ink at all. The halo is the reason: it is mostly background, the
     * background is heavily inked, and the number came back describing the
     * ridge line behind the bird. Inside the mask is not much better on its
     * own — a bird that is missing from the normals buffer has the contours of
     * whatever is BEHIND it composited over its front, which changes the same
     * pixels that a contour of its own would.
     *
     * What separates the two cases is where the dark pixels sit. A contour that
     * belongs to the bird hugs the bird's own boundary; background ink bleeding
     * through lands wherever the background's edges happen to fall. So the
     * measure is the boundary band against the interior, in the inked frame,
     * and it needs no second render to mean something:
     *
     *   edge     mean value of the one-pixel band inside the silhouette edge
     *   core     mean value of everything further in
     *   contour  core - edge, i.e. how much darker the rim is than the body.
     *
     * Near zero for an un-inked bird, strongly positive for an inked one, and
     * it cannot be faked by a dark bird because it is a difference between two
     * parts of the same bird. The ink-on/ink-off count is kept as a secondary
     * reading, now confined to the mask. */
    const RIM = 2;
    const rim = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) {
      if (!mask[p]) continue;
      const x = p % w, y = (p / w) | 0;
      let edge = false;
      for (let dy = -RIM; dy <= RIM && !edge; dy++) {
        for (let dx = -RIM; dx <= RIM; dx++) {
          const qx = x + dx, qy = y + dy;
          if (qx < 0 || qy < 0 || qx >= w || qy >= h || !mask[qy * w + qx]) { edge = true; break; }
        }
      }
      if (edge) rim[p] = 1;
    }
    let rimN = 0, rimHit = 0, rimDark = 0;
    let coreN = 0, coreHit = 0, coreDark = 0, inkPx = 0;
    const c = C ? C.data : null;
    for (let p = 0; p < w * h; p++) {
      if (!mask[p]) continue;
      const i = p * 4;
      if (!c) { if (rim[p]) rimN++; else coreN++; continue; }
      const hit = Math.max(Math.abs(a[i] - c[i]),
        Math.abs(a[i + 1] - c[i + 1]), Math.abs(a[i + 2] - c[i + 2])) > TOL;
      /* Positive means the ink pass made this pixel darker than it is with the
         pass switched off, which is what an outline does. */
      const dark = (0.2126 * c[i] + 0.7152 * c[i + 1] + 0.0722 * c[i + 2]) - lum(i);
      if (hit) inkPx++;
      if (rim[p]) { rimN++; if (hit) rimHit++; rimDark += dark; }
      else { coreN++; if (hit) coreHit++; coreDark += dark; }
    }

    const out = {
      area, w, h,
      bbox: [x0, y0, x1 - x0 + 1, y1 - y0 + 1],
      centroid: [sx / area, sy / area],
      halfDelta: Math.abs((lN ? lSum / lN : 0) - (rN ? rSum / rN : 0)),
      steps,
      rimN, coreN,
      rimHit: rimN ? rimHit / rimN : 0,
      coreHit: coreN ? coreHit / coreN : 0,
      rimDark: rimN ? rimDark / rimN : 0,
      coreDark: coreN ? coreDark / coreN : 0,
      inkPx,
    };
    if (ndc) {
      const px = (ndc[0] * 0.5 + 0.5) * w, py = (-ndc[1] * 0.5 + 0.5) * h;
      out.predicted = [px, py];
      out.miss = Math.hypot(px - out.centroid[0], py - out.centroid[1]);
      /* Distance from the predicted point to the nearest pixel the bird is
         responsible for. Zero when the build's answer lands on the bird. */
      let best = Infinity;
      for (let p = 0; p < w * h; p++) {
        if (!mask[p]) continue;
        const d = Math.hypot((p % w) - px, ((p / w) | 0) - py);
        if (d < best) best = d;
      }
      out.reach = best;
    }

    /* A magnified crop of the subject, so the twelve frames can be judged as
       silhouettes rather than as numbers. Nearest neighbour: this is evidence,
       not a picture, and a smoothed one would invent edges that the ink pass
       did not draw. */
    {
      const pad = 14, z = 5;
      const cx0 = Math.max(0, x0 - pad), cy0 = Math.max(0, y0 - pad);
      const cx1 = Math.min(w - 1, x1 + pad), cy1 = Math.min(h - 1, y1 + pad);
      const cw = cx1 - cx0 + 1, ch = cy1 - cy0 + 1;
      const src = document.createElement('canvas');
      src.width = w; src.height = h;
      src.getContext('2d').putImageData(A, 0, 0);
      const dst = document.createElement('canvas');
      dst.width = cw * z; dst.height = ch * z;
      const dc = dst.getContext('2d');
      dc.imageSmoothingEnabled = false;
      dc.drawImage(src, cx0, cy0, cw, ch, 0, 0, cw * z, ch * z);
      out.crop = dst.toDataURL('image/png').split(',')[1];
    }
    return out;
  },
  [shown, hidden, plain, ndc, 10]);

/* ── driver ────────────────────────────────────────────────────────────────── */

const b64 = f => fs.readFileSync(f).toString('base64');
const shots = [];

for (const ink of [1, 0]) {
  await run({
    width: W, height: H,
    hash: `manual&tier=high&seed=${SEED}&cap=60&hud=0&ink=${ink}`,
  }, async (ctx) => {
    /* Before any shutter opens. Without it the shoot photographs the boot veil
       and every frame is a night scene with nothing in it — one of the ways
       the last version of this file came back with twelve empty pictures. */
    await settleBoot(ctx.page);
    await freezeWallClock(ctx);
    const sets = await survey(ctx);
    if (ink === 1) {
      shots.survey = sets;
      if (!sets.length) throw new Error('no bird mesh in the scene');
      /* The null frame, before anything is touched. */
      await rerender(ctx);
      await capture(ctx.page, path.join(dirs.inkHidden, 'null-a.png'));
      await rerender(ctx);
      await capture(ctx.page, path.join(dirs.inkHidden, 'null-b.png'));
    }
    for (let idx = 0; idx < sets.length; idx++) {
      const kind = /near/.test(sets[idx].name) ? 'near' : 'far';
      for (let k = 0; k < PHASES; k++) {
        const t = k * 0.088;
        const { ndc } = await parkBird(ctx, idx, kind, t);
        const stem = `${kind}-${k}.png`;
        await setVisible(ctx, idx, false);
        await capture(ctx.page, path.join(ink ? dirs.inkHidden : dirs.noinkHidden, stem));
        await setVisible(ctx, idx, true);
        await capture(ctx.page, path.join(ink ? dirs.ink : dirs.noink, stem));
        if (ink === 1) shots.push({ idx, kind, k, stem, ndc, set: sets[idx].name });
      }
    }

    /* The second browser is the one that has both sets of pictures on disk, so
       the measuring is done from inside it. */
    if (ink === 0) {
      shots.nul = await analyse(ctx,
        b64(path.join(dirs.inkHidden, 'null-a.png')),
        b64(path.join(dirs.inkHidden, 'null-b.png')),
        null, null);
      for (const s of shots) {
        s.stats = await analyse(ctx,
          b64(path.join(dirs.ink, s.stem)),
          b64(path.join(dirs.inkHidden, s.stem)),
          b64(path.join(dirs.noink, s.stem)),
          s.ndc);
      }
    }
  });
}

/* ── report, and only now ──────────────────────────────────────────────────── */

let blind = 0, adrift = 0;
const nul = shots.nul || { area: 0 };
console.log('\n  control');
console.log(`\n    null frame — two captures, nothing changed: ${nul.area} px differ`
  + (nul.area <= NULL_MAX ? '   ✓ the scene is reproducible'
    : `   ✗ NOT REPRODUCIBLE (limit ${NULL_MAX})`));
if (nul.area > NULL_MAX) {
  console.log('\n    A difference of two renders cannot isolate the bird when the');
  console.log('    renders do not agree with themselves. Nothing else is reported.');
  process.exitCode = 1;
  finish(process.exitCode);
}

console.log('\n    hidden/shown — is there a bird in the frame at all?\n');
for (const s of shots) {
  const st = s.stats || { area: 0 };
  const seen = st.area >= SEEN_MIN;
  const off = st.reach !== undefined && st.reach > SEEN_PAD;
  if (!seen) blind++;
  if (seen && off) adrift++;
  if (st.crop) {
    fs.writeFileSync(path.join(dirs.crop, s.stem), Buffer.from(st.crop, 'base64'));
  }
  console.log(
    `    ${s.stem.replace('.png', '').padEnd(8)}`
    + `  mask ${String(st.area).padStart(6)} px`
    + (st.bbox ? `  bbox ${String(st.bbox[2]).padStart(4)}x${String(st.bbox[3]).padStart(3)}` : '')
    + (st.reach === undefined ? '   where: not claimed'
      : `   predicted point is ${st.reach.toFixed(1)} px from the bird`)
    + (seen ? (off ? '   ✗ ADRIFT' : '   ✓') : '   ✗ BLIND'),
  );
}

if (blind) {
  console.log(`\n  ✗ ${blind} of ${shots.length} frames contain no bird.`);
  console.log('    Nothing else is reported: an instrument that cannot see its');
  console.log('    subject has no business producing a number about it.');
  process.exitCode = 1;
  finish(process.exitCode);
} else {
  if (adrift) {
    console.log(`\n  ✗ ${adrift} frame(s) have a mask that is not where the build`
      + ' says the bird is.');
    process.exitCode = 1;
  } else {
    console.log(`\n  ✓ all ${shots.length} frames contain the bird,`
      + (shots[0].stats.miss === undefined
        ? ' position not claimed by the build.'
        : ' where the build says it is.'));
  }

  for (const set of shots.survey) {
    const mine = shots.filter(s => s.set === set.name).map(s => s.stats);
    const avg = f => mine.reduce((a, s) => a + f(s), 0) / mine.length;
    console.log(`\n  ${set.name}   ${set.instances} birds x ${set.trisEach} tris`
      + `   ${set.probe ? 'declares its placement' : 'legacy, no probe'}`
      + `   material ${set.lit ? 'lit' : 'unlit'}`);
    console.log(`    1 hairline   wing rise ${set.wingRise.toFixed(2)} deg over its half-span`
      + `,  ${set.wingTris} wing tris carrying ${set.wingNormals} distinct normal(s)`
      + `,  widest pair ${set.wingNormalSpread.toFixed(1)} deg`);
    console.log(`                 in pixels: value split across the silhouette`
      + ` ${avg(s => s.halfDelta).toFixed(2)}/255`
      + `,  ${(avg(s => s.steps)).toFixed(1)} value steps on the bird`);
    console.log(`    2 flock      nearest other bird: median`
      + ` ${set.nnMedian.toFixed(1)} m, p90 ${set.nnP90.toFixed(1)} m`
      + (set.flockSpread
        ? `   |  ${set.flockSpread.flocks} flocks, widest member spread`
          + ` median ${set.flockSpread.median.toFixed(1)} m,`
          + ` max ${set.flockSpread.max.toFixed(1)} m`
        : '   |  no flock structure declared'));
    console.log(`    3 span       ${set.spanMin.toFixed(2)}–${set.spanMax.toFixed(2)} m tip to tip`
      + `   (geometry ${set.geomWidth.toFixed(3)} wide)`);
    console.log(`    4 ink        rim  ${(avg(s => s.rimHit) * 100).toFixed(0)}% of`
      + ` ${avg(s => s.rimN).toFixed(0)} px touched by the pass,`
      + ` darkened by ${avg(s => s.rimDark).toFixed(1)}/255`);
    console.log(`                 core ${(avg(s => s.coreHit) * 100).toFixed(0)}% of`
      + ` ${avg(s => s.coreN).toFixed(0)} px touched by the pass,`
      + ` darkened by ${avg(s => s.coreDark).toFixed(1)}/255`);
    console.log(`                 ${avg(s => s.inkPx).toFixed(0)} of`
      + ` ${avg(s => s.area).toFixed(0)} px on the bird change when ink is switched on`);
  }
  console.log(`\n  frames: ${path.relative(ROOT, dirs.ink)} (12),`
    + ` magnified crops in ${path.relative(ROOT, dirs.crop)},`
    + ` controls in ${path.relative(ROOT, dirs.inkHidden)}\n`);
  finish(process.exitCode || 0);
}
