/* The perceived-airborne-read measurement, in one place.
 *
 * Two tools need it and it is the whole contribution of both, so it lives here
 * rather than being written twice and drifting: tools/zjread.mjs reports it per
 * site, and tools/zjlift.mjs sweeps the camera against it. The reasoning behind
 * the metric is in zjread.mjs's header.
 *
 * This is page-side code. It is handed to page.evaluate, so it may not close
 * over anything in this module.
 */

/**
 * One probe, at whatever state the page is currently in.
 *
 * Ablations, each a pair of renders differing in exactly one thing, with
 * performance.now pinned across the lot — src/world/environment.js drives a
 * shader uniform from it, so two renders of a still scene otherwise differ —
 * and the frame after every state change discarded.
 *
 *   car      the body's silhouette, with its shadow suppressed in both halves
 *            so the shadow cancels and what is left is the body
 *   shadow   the car casting against the car not casting, which is zzflight's
 *            measurement exactly
 *   mark     the plumb ground mark drawn against hidden
 *   core     the mark with its penumbra band turned off, so the daylight can
 *            also be measured to the shadow proper rather than to the faint
 *            edge of its halo
 *
 * @param {[number, boolean]} args  [colFloor, withSun]
 */
export const READ_PROBE = ([COL_FLOOR, WITH_SUN]) => {
  const g = window.__game;
  const THREE = g.THREE;
  g.setPaused(true);
  const cv = g.renderer.domElement, w = cv.width, h = cv.height;
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const tc = tmp.getContext('2d', { willReadFrequently: true });
  const grab = () => {
    g.renderOnce(); tc.drawImage(cv, 0, 0);
    return tc.getImageData(0, 0, w, h).data;
  };
  const realNow = performance.now.bind(performance);
  const tPin = realNow(); performance.now = () => tPin;

  const casters = [];
  g.playerView.root.traverse(o => { if (o.isMesh && o.castShadow) casters.push(o); });
  const setCast = v => { for (const o of casters) o.castShadow = v; };

  const air = g.effects?.airMark || null;
  const mark = air ? air.mesh : null;

  grab();
  const full = grab();

  /* The core alone: the band's multiply set to 1, which is no darkening at all,
     leaving the mark's shape and value untouched everywhere else. */
  let coreOnly = null;
  if (mark && mark.visible) {
    const band = air.material.uniforms.uBand.value;
    air.material.uniforms.uBand.value = 1;
    grab();
    coreOnly = grab();
    air.material.uniforms.uBand.value = band;
  }

  let noMark = null;
  if (mark) {
    const was = mark.visible;
    mark.visible = false;
    grab();
    noMark = grab();
    mark.visible = was;
  }

  /* Body silhouette. Measured with the mark already off, so the two layers do
     not overlap in the diff. */
  if (mark) mark.visible = false;
  setCast(false);
  grab();
  const noShadow = grab();
  g.playerView.root.visible = false;
  grab();
  const noCar = grab();
  g.playerView.root.visible = true;

  let withShadow = null;
  if (WITH_SUN) {
    setCast(true);
    grab();
    withShadow = grab();
  }
  setCast(true);
  if (mark) mark.visible = air.mesh.visible = true;

  performance.now = realNow;

  /* A layer is the set of pixels two renders disagree about. 12 on the sum of
     the channel differences, which is zzflight's threshold, kept so the shadow
     numbers here and there are the same numbers. */
  const DIFF = 12;
  const layer = (a, b) => {
    let px = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, sx = 0, sy = 0;
    const top = new Int32Array(w).fill(-1);
    const bot = new Int32Array(w).fill(-1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1])
          + Math.abs(a[i + 2] - b[i + 2]);
        if (d <= DIFF) continue;
        px++; sx += x; sy += y;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (top[x] < 0) top[x] = y;
        bot[x] = y;
      }
    }
    return { px, x0, x1, y0, y1, cx: px ? sx / px : 0, cy: px ? sy / px : 0, top, bot };
  };

  const car = layer(noShadow, noCar);
  let carBottom = -1e9;
  for (let x = car.x0; x <= car.x1; x++) if (car.bot[x] > carBottom) carBottom = car.bot[x];

  /* Clauses ii and iii of the metric, together: how much of a layer falls in
     the column under the car, and how far below the car's own lowest pixel the
     top of that part is. A layer outside the column scores nothing however
     large it is, which is the entire difference between this and separation. */
  const score = (a, b) => {
    if (!a || !b || !car.px) return null;
    const m = layer(a, b);
    let colPx = 0, top = 1e9;
    for (let y = 0; y < h; y++) {
      for (let x = car.x0; x <= car.x1; x++) {
        const i = (y * w + x) * 4;
        const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1])
          + Math.abs(a[i + 2] - b[i + 2]);
        if (d <= DIFF) continue;
        colPx++;
        if (y < top) top = y;
      }
    }
    const sep = top < 1e9 ? Math.round(top - carBottom) : null;
    return {
      px: m.px,
      box: m.px ? [m.x0, m.y0, m.x1 - m.x0 + 1, m.y1 - m.y0 + 1] : null,
      dx: m.px ? Math.round(m.cx - car.cx) : null,
      colPx,
      sep,
      readPx: colPx >= COL_FLOOR && sep !== null && sep > 0 ? sep : 0,
    };
  };

  const p = g.player;
  const cam = g.camera;
  const proj = (v) => {
    const q = v.clone().project(cam);
    return {
      x: Math.round((q.x * 0.5 + 0.5) * w), y: Math.round((-q.y * 0.5 + 0.5) * h),
      inFrame: q.x >= -1 && q.x <= 1 && q.y >= -1 && q.y <= 1 && q.z <= 1,
    };
  };
  const ground = new THREE.Vector3();
  p.surfaceAt(p.s, p.lat, ground);
  const sun = g.sun;
  const lightDir = new THREE.Vector3()
    .subVectors(sun.position, sun.target.position).normalize();
  const horiz = Math.hypot(lightDir.x, lightDir.z) / Math.max(lightDir.y, 1e-4);

  return {
    h: +p.height.toFixed(2), kmh: +p.kmh.toFixed(0),
    air: +g.chase.air.toFixed(2),
    boom: +cam.position.distanceTo(p.pos).toFixed(2),
    camY: +(cam.position.y - ground.y).toFixed(2),
    fov: +cam.fov.toFixed(1),
    sunElev: +(Math.asin(Math.max(1e-4, lightDir.y)) * 180 / Math.PI).toFixed(1),
    sunSpread: +(horiz * p.height).toFixed(1),
    gnd: proj(ground),
    cast: proj(ground.clone().addScaledVector(
      new THREE.Vector3(-lightDir.x, 0, -lightDir.z).normalize(),
      horiz * (p.height + 0.6))),
    car: {
      px: car.px, w: car.x1 - car.x0 + 1, h: car.y1 - car.y0 + 1,
      cx: Math.round(car.cx), bottom: Math.round(carBottom),
    },
    shadow: WITH_SUN ? score(withShadow, noShadow) : null,
    mark: score(full, noMark),
    /* Same daylight, measured to the core instead of to the outer edge of the
       penumbra. Both are reported: the outer edge is the conservative number
       and the core is the one the eye is actually crossing to. */
    core: coreOnly ? score(coreOnly, noMark) : null,
  };
};

/** Step the simulation until a condition, in whole 1/60 frames. Page-side. */
export const STEP_TO = ([until, arg, limit]) => {
  const g = window.__game, p = g.player;
  const test = {
    pad: () => p.s >= arg,
    apex: () => p.airborne && p.vertVel <= 0,
    air: () => p.airborne,
  }[until];
  let n = 0;
  while (n++ < limit) { g.step(1 / 60); if (test()) break; }
  return n < limit;
};
