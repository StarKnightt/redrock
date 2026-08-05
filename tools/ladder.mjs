/* Which rung of the landform ladder is standing in the frame.
 *
 * tools/sky.mjs --who answers "how much sky, and what is in the way", by mesh
 * name. That is enough to tell a corridor wall from a road support, and not
 * enough to fix either: `landform--1` is sixteen stations deep, and the change
 * that lowers a cut wall is not the change that lays back a flank skirt.
 *
 * This walks the generator's own station ladder — the same
 * `landformPoint(s, side, station)` the mesh was built from, exposed on the
 * environment for exactly this — into a flat point cloud, then names, for every
 * above-lens ray that lands on a landform, the station index and the arc length
 * that built it. What comes back is a histogram over the sixteen rungs, which
 * is the level of detail a fix is actually authored at.
 *
 *   node tools/ladder.mjs [--seed 22] [--at 0.775,0.992] [--stops 60]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const STOPS = Number(flag('stops', '60'));
const AT = (flag('at', '') || '').split(',').filter(Boolean).map(Number);
/* "--near 150,260" also lists the highest ladder points in that range of plan
   distance from the lens, whether or not a ray happened to find them. */
const NEAR = (flag('near', '') || '').split(',').filter(Boolean).map(Number);

await run({
  width: 960, height: 540,
  hash: `manual&tier=high&seed=${SEED}&cap=60&hud=0&ink=1`,
}, async ({ page }) => {
  const out = await page.evaluate(async ({ stops, at, near }) => {
    const g = window.__game, THREE = g.THREE;
    const env = g.scene.getObjectByName('environment');
    const { field, landformPoint } = env.userData;
    const STATIONS = 16;

    /* The ladder as a point cloud, in the same order the mesh was built. One
       pass over ~20k stations; every one of them costs a `profile()`, so this
       is seconds, not milliseconds, and it is done once for the whole sweep. */
    const rows = field.count;
    const cloud = [];
    const p = new THREE.Vector3();
    for (const side of [-1, 1]) {
      for (let i = 0; i < rows; i++) {
        const s = field.ss[i];
        for (let c = 0; c < STATIONS; c++) {
          landformPoint(s, side, c, p);
          cloud.push({ x: p.x, y: p.y, z: p.z, s, side, c });
        }
      }
    }
    /* A plan-space hash so a hit is matched against a few dozen candidates
       rather than twenty thousand. The ladder is dense in s and sparse across
       stations, so cell size is set by the row spacing. */
    const CELL = 24;
    const bins = new Map();
    const key = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    for (const q of cloud) {
      const k = key(q.x, q.z);
      let b = bins.get(k);
      if (!b) bins.set(k, b = []);
      b.push(q);
    }
    const nearest = (x, y, z) => {
      let best = null, bd = Infinity;
      const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          const list = bins.get(`${cx + a},${cz + b}`);
          if (!list) continue;
          for (const q of list) {
            const d = (q.x - x) ** 2 + (q.y - y) ** 2 + (q.z - z) ** 2;
            if (d < bd) { bd = d; best = q; }
          }
        }
      }
      return best && bd < 60 * 60 ? best : null;
    };

    const ray = new THREE.Raycaster();
    ray.far = 4000;
    const OPEN = /^(sky|block-clouds|sun-|ocean|foam)/;
    const ndc = new THREE.Vector2();
    const list = at.length ? at : Array.from({ length: stops }, (_, i) => (i + 0.5) / stops);
    const rowsOut = [];
    for (const t of list) {
      g.driveTo(t);
      g.setPaused(true);
      g.renderOnce();
      const w = 960, h = 540;
      let above = 0, open = 0, total = 0;
      const rung = {};
      for (let y = 0; y < h; y += Math.floor(h / 21)) {
        for (let x = 0; x < w; x += Math.floor(w / 30)) {
          ndc.set((x / w) * 2 - 1, -((y / h) * 2 - 1));
          total++;
          ray.setFromCamera(ndc, g.camera);
          const hit = ray.intersectObjects(g.scene.children, true)
            .find(q => q.object.visible && !OPEN.test(q.object.name || ''));
          if (!hit) { open++; continue; }
          if (ndc.y < 0) continue;
          above++;
          const name = hit.object.name || '';
          let label = name;
          if (/^landform-/.test(name)) {
            const q = nearest(hit.point.x, hit.point.y, hit.point.z);
            label = q ? `landform s${q.side > 0 ? '+' : '-'} st${String(q.c).padStart(2)}` : 'landform ?';
            const rec = rung[label] || (rung[label] = { n: 0, d: 0, rise: 0, srcS: 0, dy: 0 });
            rec.n++;
            rec.d += hit.distance;
            rec.srcS += q ? q.s : 0;
            rec.dy += hit.point.y - g.camera.position.y;
            rec.rise += (Math.atan2(hit.point.y - g.camera.position.y,
              Math.hypot(hit.point.x - g.camera.position.x,
                hit.point.z - g.camera.position.z)) * 180) / Math.PI;
            continue;
          }
          const rec = rung[label] || (rung[label] = { n: 0, d: 0, rise: 0, srcS: 0, dy: 0 });
          rec.n++;
          rec.d += hit.distance;
          rec.dy += hit.point.y - g.camera.position.y;
          rec.rise += (Math.atan2(hit.point.y - g.camera.position.y,
            Math.hypot(hit.point.x - g.camera.position.x,
              hit.point.z - g.camera.position.z)) * 180) / Math.PI;
        }
      }
      /* What stands highest near the lens, straight off the ladder rather than
         off a ray. A needle a couple of metres wide falls between the rays of
         any sampling grid coarse enough to run sixty times, so the thing most
         worth naming is the thing this sweep is least likely to hit. */
      let tall = null;
      if (near) {
        const cam = g.camera.position;
        tall = cloud
          .map(q => ({ q, d: Math.hypot(q.x - cam.x, q.z - cam.z), up: q.y - cam.y }))
          .filter(e => e.d > near[0] && e.d < near[1])
          .sort((a, b) => b.up - a.up)
          .slice(0, 10)
          .map(e => ({ s: e.q.s, side: e.q.side, c: e.q.c, d: e.d, up: e.up }));
      }
      rowsOut.push({ t: +t.toFixed(3), s: g.player.s, sky: open / total, above, rung, tall });
    }
    return rowsOut;
  }, { stops: STOPS, at: AT, near: NEAR });

  for (const r of out) {
    console.log(`\n  t=${r.t.toFixed(3)} s=${Math.round(r.s)}  sky ${(100 * r.sky).toFixed(1)}%`
      + `  ${r.above} rays above the lens`);
    const rank = Object.entries(r.rung).sort((a, b) => b[1].n - a[1].n);
    for (const [k, v] of rank.slice(0, 8)) {
      console.log(`    ${k.padEnd(22)} ${((100 * v.n) / (r.above || 1)).toFixed(0).padStart(3)}%`
        + `  ${(v.d / v.n).toFixed(0).padStart(4)} m out`
        + `  ${(v.rise / v.n).toFixed(1).padStart(5)}°`
        + `  ${(v.dy / v.n).toFixed(0).padStart(4)} m up`
        + (v.srcS ? `  built at s=${Math.round(v.srcS / v.n)}` : ''));
    }
    if (r.tall) {
      console.log(`    ── highest ladder points ${NEAR[0]}–${NEAR[1]} m out ──`);
      for (const e of r.tall) {
        console.log(`    side ${e.side > 0 ? '+' : '-'} station ${String(e.c).padStart(2)}`
          + `  s=${e.s.toFixed(0).padStart(5)}`
          + `  ${e.d.toFixed(0).padStart(4)} m out`
          + `  ${e.up.toFixed(1).padStart(6)} m above the lens`);
      }
    }
  }
  console.log();
});
finish(process.exitCode || 0);
