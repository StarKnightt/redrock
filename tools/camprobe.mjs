/* Chase camera against solid terrain, over a whole AI lap.
 *
 * The comparison has to be exact, and two AI laps are not: the effects system
 * draws from a shared random stream that the camera position feeds into, so
 * the same build driven twice takes two slightly different lines and the
 * before/after numbers stop being about the camera. So the lap is driven once
 * and the car's motion recorded, then the recording is replayed through two
 * cameras — one with the occlusion test, one without. Same road, same line,
 * same frames; the only difference is the thing under test.
 *
 * Per frame, measured independently of what the camera itself believes:
 *
 *   occluded  — the segment from the driver's head to the lens crosses solid
 *               geometry, i.e. the lens is behind a wall. This is the bug.
 *   penetr.   — how far past that surface the lens sits, in metres.
 *   clearance — shortest distance from the lens to any solid surface, over 26
 *               directions.
 *
 *   node tools/camprobe.mjs [--tag name] [--skill 0.85]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const tag = flag('tag', 'camprobe');
const skill = +flag('skill', 0.85);
const STATIONS = +flag('stations', 600);
const WORST = +flag('worst', 10);
const SEED = +flag('seed', 22);

await run({ width: 960, height: 540, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0` }, async ({ page }) => {
  const proxy = await page.evaluate(() => {
    const w = window.__game.solid;
    return { tris: w.count, entries: w.entries, grid: [w.nx, w.nz] };
  });
  console.log(`  proxy: ${proxy.tris.toLocaleString()} triangles, ${proxy.entries.toLocaleString()} grid entries, ${proxy.grid.join('x')} cells\n`);

  const out = await page.evaluate(([skill, stations]) => {
    const g = window.__game;
    const THREE = g.THREE;
    const w = g.solid;
    const V = v => [v.x, v.y, v.z];

    /* ---- 1. one lap, recorded --------------------------------------- */
    g.setPaused(true);
    g.autopilot(true, skill);
    g.goTo(0.002);
    const tape = [];
    const len = g.track.length;
    let guard = 0;
    while (g.player.s < len - 45 && guard++ < 60 * 60 * 6) {
      g.step(1 / 60);
      const p = g.player;
      tape.push({
        pos: V(p.pos), up: V(p.up), forward: V(p.forward), right: V(p.right),
        vx: p.vx, vy: p.vy, speed: p.speed, r: p.r, roll: p.roll,
        throttle: p.throttle, s: p.s, kmh: p.kmh,
        airborne: p.airborne, airTime: p.airTime, height: p.height,
      });
    }
    g.autopilot(false);

    /* ---- 2. replay it through two cameras --------------------------- */
    const ChaseCamera = Object.getPrototypeOf(g.chase).constructor;
    const stub = () => ({
      pos: new THREE.Vector3(), up: new THREE.Vector3(), forward: new THREE.Vector3(),
      right: new THREE.Vector3(), vx: 0, vy: 0, speed: 0, r: 0, roll: 0, throttle: 0,
      airborne: false, airTime: 0,
    });

    const DIRS = [];
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      if (!x && !y && !z) continue;
      const l = Math.hypot(x, y, z);
      DIRS.push([x / l, y / l, z / l]);
    }

    const replay = (on, lag = true) => {
      const cam = new ChaseCamera(new THREE.PerspectiveCamera(62, 16 / 9, 0.4, 4000));
      cam.world = w;
      cam.collideEnabled = on;
      cam.yawLagEnabled = lag;
      cam.shakeEnabled = false;   // shake is noise here, and it is unchanged
      const car = stub();
      const rows = [];
      for (const f of tape) {
        car.pos.fromArray(f.pos); car.up.fromArray(f.up);
        car.forward.fromArray(f.forward); car.right.fromArray(f.right);
        car.vx = f.vx; car.vy = f.vy; car.speed = f.speed;
        car.r = f.r; car.roll = f.roll; car.throttle = f.throttle;
        car.airborne = f.airborne; car.airTime = f.airTime;
        cam.update(car, 1 / 60, {});

        const c = cam.camera.position;
        const hx = car.pos.x + car.up.x * 1.2;
        const hy = car.pos.y + car.up.y * 1.2;
        const hz = car.pos.z + car.up.z * 1.2;
        let bx = c.x - hx, by = c.y - hy, bz = c.z - hz;
        const boom = Math.hypot(bx, by, bz) || 1e-6;
        bx /= boom; by /= boom; bz /= boom;
        const hit = w.raycast(hx, hy, hz, bx, by, bz, boom, 0.8);
        let clear = 40;
        for (const d of DIRS) {
          const q = w.raycast(c.x, c.y, c.z, d[0], d[1], d[2], clear, 0.6);
          if (q < clear) clear = q;
        }
        /* The same measurement taken at the driver's head. When this is near
           zero the car itself is in the scenery and no camera placement can
           be clear — the boom has nowhere free to reach from. */
        let headClear = 40;
        for (const d of DIRS) {
          const q = w.raycast(hx, hy, hz, d[0], d[1], d[2], headClear, 0.6);
          if (q < headClear) headClear = q;
        }
        rows.push({
          headClear: +headClear.toFixed(2),
          s: +f.s.toFixed(1), t: +(f.s / len).toFixed(4), kmh: +f.kmh.toFixed(0),
          boom: +boom.toFixed(2),
          occluded: hit < boom,
          penetration: hit < boom ? +(boom - hit).toFixed(2) : 0,
          clearance: +clear.toFixed(2),
          air: +cam.air.toFixed(2), height: +f.height.toFixed(2),
          occl: +cam.occl.toFixed(3), lift: +cam.lift.toFixed(2),
          slide: +cam.slide.length().toFixed(2),
          cam: [c.x, c.y, c.z], head: [hx, hy, hz],
        });
      }
      return rows;
    };

    const before = replay(false);
    const after = replay(true);
    /* The interesting cross-term: rotating and pulling in at the same time. */
    const noLag = replay(true, false);
    const noLagNoCollide = replay(false, false);

    /* ---- 2b. the same question asked of the real scene ---------------
       Everything above consults SolidWorld, which is also what the fix
       consults, so the two agree by construction and neither can see a mesh the
       proxy leaves out. That blind spot is not hypothetical: a critic found the
       lens buried in terrain at a station this gate had called clean. So a
       second pass re-asks the boom question of the actual scene graph with
       Three's own Raycaster. Slow, hence stations rather than every frame, but
       it is the only measurement here that can fail. */
    const skip = /sky-dome|sun-disc|ocean-bands|shore-foam|block-clouds|bird|beam|foam/i;
    const targets = [];
    g.stage.updateMatrixWorld(true);
    g.stage.traverse(o => {
      if (!o.isMesh) return;
      let nm = o.name;
      for (let q = o.parent; !nm && q; q = q.parent) nm = q.name;
      if (skip.test(nm || '')) return;
      o.userData.__probeName = nm || '(unnamed)';
      targets.push(o);
    });
    const ray = new THREE.Raycaster();
    const O = new THREE.Vector3(), D = new THREE.Vector3();
    const truth = rows => {
      const outs = [];
      for (let k = 0; k < stations; k++) {
        const r = rows[Math.round(k * (rows.length - 1) / (stations - 1))];
        O.fromArray(r.head);
        D.fromArray(r.cam).sub(O);
        const L = D.length();
        D.multiplyScalar(1 / L);
        ray.set(O, D);
        ray.far = L + 1e-3;
        const h = ray.intersectObjects(targets, false);
        outs.push({
          t: r.t, s: r.s, kmh: r.kmh, boom: r.boom, occl: r.occl, slide: r.slide,
          pen: h.length ? +(L - h[0].distance).toFixed(2) : 0,
          blocker: h.length ? h[0].object.userData.__probeName : null,
        });
      }
      return outs;
    };
    const truthBefore = truth(before), truthAfter = truth(after);

    /* ---- 3. what the test costs ------------------------------------- */
    const cam = new ChaseCamera(new THREE.PerspectiveCamera(62, 16 / 9, 0.4, 4000));
    cam.world = w; cam.collideEnabled = true; cam.shakeEnabled = false;
    const car = stub();
    const N = 20000;
    const step = Math.max(1, Math.floor(tape.length / N));
    const warm = [];
    for (let i = 0; i < tape.length; i += step) warm.push(tape[i]);
    const timeIt = on => {
      cam.collideEnabled = on; cam.started = false;
      for (let pass = 0; pass < 2; pass++) {
        const t0 = performance.now();
        for (const f of warm) {
          car.pos.fromArray(f.pos); car.up.fromArray(f.up);
          car.forward.fromArray(f.forward); car.right.fromArray(f.right);
          car.vx = f.vx; car.vy = f.vy; car.speed = f.speed;
          car.r = f.r; car.roll = f.roll; car.throttle = f.throttle;
          cam.update(car, 1 / 60, {});
        }
        if (pass) return (performance.now() - t0) / warm.length;
      }
    };
    const costOff = timeIt(false);
    const costOn = timeIt(true);

    return { tape: tape.length, before, after, noLag, noLagNoCollide, costOff, costOn, warm: warm.length, truthBefore, truthAfter, targets: targets.length };
  }, [skill, STATIONS]);

  const stats = rows => {
    const occ = rows.filter(r => r.occluded);
    const clears = rows.map(r => r.clearance);
    let worst = Infinity, at = null;
    for (const r of rows) if (r.clearance < worst) { worst = r.clearance; at = r; }
    /* Restricted to the frames where the car itself has room. Anywhere the
       car is buried the camera cannot be rescued, and averaging those in
       hides whether the boom is doing its job everywhere else. */
    const onRoad = rows.filter(r => r.headClear > 1.5);
    let worstFree = Infinity, atFree = null;
    for (const r of onRoad) if (r.clearance < worstFree) { worstFree = r.clearance; atFree = r; }
    return {
      worstFree, atFree, buried: rows.length - onRoad.length,
      frames: rows.length,
      occluded: occ.length,
      deepest: occ.length ? Math.max(...occ.map(r => r.penetration)) : 0,
      worst, at,
      pulled: rows.filter(r => r.occl < 0.995).length,
      tightest: Math.min(1, ...rows.map(r => r.occl)),
      median: clears.slice().sort((a, b) => a - b)[clears.length >> 1],
    };
  };
  const b = stats(out.before), a = stats(out.after);

  const line = (label, x, y, unit = '') =>
    console.log(`  ${label.padEnd(30)} ${String(x).padStart(10)}   ${String(y).padStart(10)} ${unit}`);
  console.log(`  one recorded lap, ${out.tape} frames, replayed through both cameras\n`);
  console.log(`  ${''.padEnd(30)} ${'BEFORE'.padStart(10)}   ${'AFTER'.padStart(10)}`);
  line('frames with lens behind rock', b.occluded, a.occluded, `of ${b.frames}`);
  line('  as a share of the lap', (b.occluded / b.frames * 100).toFixed(2) + '%', (a.occluded / a.frames * 100).toFixed(2) + '%');
  line('deepest penetration', b.deepest.toFixed(2), a.deepest.toFixed(2), 'm');
  /* Signed, because plain distance-to-nearest-surface flatters the broken
     case: a lens eleven metres inside a hillside is a long way from the
     surface of it. Negative is how far inside. */
  const signed = rows => {
    let w = Infinity, at = null;
    for (const r of rows) {
      const v = r.occluded ? -r.penetration : r.clearance;
      if (v < w) { w = v; at = r; }
    }
    return { w, at };
  };
  const sb = signed(out.before), sa = signed(out.after);
  line('worst signed clearance', sb.w.toFixed(2), sa.w.toFixed(2), 'm  (negative = inside)');
  line('  at', `t=${sb.at.t}`, `t=${sa.at.t}`);
  line('  car\'s own clearance there', sb.at.headClear.toFixed(2), sa.at.headClear.toFixed(2), 'm');
  line('worst where the car is clear', b.worstFree.toFixed(2), a.worstFree.toFixed(2), 'm');
  line('  at', `t=${b.atFree.t}`, `t=${a.atFree.t}`);
  line('frames with the car in scenery', b.buried, a.buried);

  /* The regression question, asked directly: is there anywhere the fix leaves
     the lens closer to rock than leaving it alone would have? */
  let loss = 0, lossAt = null;
  for (let i = 0; i < out.before.length; i++) {
    const d = out.before[i].clearance - out.after[i].clearance;
    if (d > loss) { loss = d; lossAt = out.before[i]; }
  }
  const worse = out.before.filter((r, i) => out.after[i].clearance < r.clearance - 0.05).length;
  console.log(`\n  frames the fix leaves closer to rock  ${worse} of ${out.before.length} (${(worse / out.before.length * 100).toFixed(2)}%)`);
  console.log(`  largest clearance lost                ${loss.toFixed(2)} m` + (lossAt ? `  at t=${lossAt.t}, where the car itself had ${lossAt.headClear} m` : ''));
  line('median clearance', b.median.toFixed(1), a.median.toFixed(1), 'm');

  /* Ground truth, and per station rather than aggregated. An aggregate is what
     hid the last intrusion: one bad station among fifteen thousand frames
     rounds to nothing in every summary statistic, and a critic looking at
     sixty pictures saw it immediately. */
  const tb = out.truthBefore, ta = out.truthAfter;
  const bad = rs => rs.filter(r => r.pen > 0);
  console.log(`\n  ---- against the real scene graph, not the proxy ----`);
  console.log(`  ${out.targets} meshes as ray targets, ${ta.length} stations`
    + ` (one every ${(5598 / ta.length).toFixed(1)} m)\n`);
  line('stations with lens inside scenery', bad(tb).length, bad(ta).length, `of ${ta.length}`);
  line('deepest, ground truth',
    (bad(tb).length ? Math.max(...bad(tb).map(r => r.pen)) : 0).toFixed(2),
    (bad(ta).length ? Math.max(...bad(ta).map(r => r.pen)) : 0).toFixed(2), 'm');

  const worstList = (label, rs) => {
    const top = rs.slice().sort((x, y) => y.pen - x.pen).slice(0, WORST).filter(r => r.pen > 0);
    console.log(`\n  worst ${WORST} stations, ${label}:`);
    if (!top.length) { console.log('    none — no station has the lens inside anything'); return; }
    console.log('       t       s     km/h   boom   occl  slide    inside  what');
    for (const r of top) {
      console.log(`    ${r.t.toFixed(4)} ${String(r.s).padStart(7)} ${String(r.kmh).padStart(5)}`
        + ` ${r.boom.toFixed(1).padStart(6)} ${(r.occl * 100).toFixed(0).padStart(5)}%`
        + ` ${r.slide.toFixed(2).padStart(6)} ${(r.pen.toFixed(2) + ' m').padStart(9)}  ${r.blocker}`);
    }
  };
  worstList('with the fix off', tb);
  worstList('as shipped', ta);

  line('frames with boom pulled in', b.pulled, a.pulled, `(${(a.pulled / a.frames * 100).toFixed(2)}% of the lap)`);
  line('shortest boom', (b.tightest * 100).toFixed(0) + '%', (a.tightest * 100).toFixed(0) + '%', 'of nominal');
  console.log(`\n  chase camera update cost      ${(out.costOff * 1000).toFixed(1)} us   ${(out.costOn * 1000).toFixed(1)} us  (${out.warm} samples)`);
  console.log(`  occlusion test alone          ${''.padStart(10)}   ${((out.costOn - out.costOff) * 1000).toFixed(1)} us  of a 16.7 ms frame`);

  const runsOf = rows => {
    const runs = [];
    for (const r of rows) {
      const last = runs[runs.length - 1];
      if (r.occluded || r.occl < 0.98) {
        if (last && !last.closed) { last.s1 = r.s; last.t1 = r.t; last.n++; last.deep = Math.max(last.deep, r.penetration); last.occl = Math.min(last.occl, r.occl); last.occN += r.occluded ? 1 : 0; }
        else runs.push({ s0: r.s, s1: r.s, t0: r.t, t1: r.t, n: 1, deep: r.penetration, occl: r.occl, occN: r.occluded ? 1 : 0, closed: false });
      } else if (last) last.closed = true;
    }
    return runs.filter(r => r.n >= 2);
  };
  for (const [label, rows] of [['BEFORE', out.before], ['AFTER', out.after]]) {
    console.log(`\n  ${label} — stretches where the boom met terrain:`);
    const runs = runsOf(rows);
    if (!runs.length) console.log('    none');
    for (const r of runs) {
      console.log(`    t ${(r.t0 * 100).toFixed(1)}%–${(r.t1 * 100).toFixed(1)}%  s ${r.s0.toFixed(0)}–${r.s1.toFixed(0)} m  ${(r.n / 60).toFixed(2)} s`
        + `  behind rock for ${(r.occN / 60).toFixed(2)} s  deepest ${r.deep.toFixed(2)} m  boom to ${(r.occl * 100).toFixed(0)}%`);
    }
  }

  /* The pullback, which is the new question. Airborne the boom goes from 8.4 m
     to 13.4 m and 2.4 m higher, and a longer boom is a boom with more chance
     of finding a hillside — at the one moment in the run when the camera has
     to be clear, because there is nothing to look at but the car. Ramp siting
     already rejects a station whose extended boom is blocked; this checks the
     whole flight rather than the two stations the siting scan raycast. */
  {
    const air = out.after.filter(r => r.air > 0.01);
    const flights = [];
    for (const r of air) {
      const last = flights[flights.length - 1];
      if (last && r.s - last.s1 < 6) {
        last.s1 = r.s; last.n++;
        last.boom = Math.max(last.boom, r.boom);
        last.occl = Math.min(last.occl, r.occl);
        last.occN += r.occluded ? 1 : 0;
        last.deep = Math.max(last.deep, r.penetration);
        last.clear = Math.min(last.clear, r.clearance);
        last.height = Math.max(last.height, r.height);
      } else {
        flights.push({ s0: r.s, s1: r.s, n: 1, boom: r.boom, occl: r.occl,
          occN: r.occluded ? 1 : 0, deep: r.penetration, clear: r.clearance, height: r.height });
      }
    }
    console.log(`\n  ---- the airborne pullback ----`);
    console.log(`  ${air.length} frames with the boom extended, in ${flights.length} flight(s)\n`);
    if (!flights.length) console.log('    none — the car never left the ground on this lap');
    else console.log('       s0      s1   frames   apex   longest boom   shortest   behind rock   nearest surface');
    for (const f of flights) {
      console.log(`    ${f.s0.toFixed(0).padStart(5)} ${f.s1.toFixed(0).padStart(7)} ${String(f.n).padStart(8)}`
        + ` ${f.height.toFixed(2).padStart(6)} ${f.boom.toFixed(1).padStart(14)} m`
        + ` ${(f.occl * 100).toFixed(0).padStart(9)}% ${(f.occN / 60).toFixed(2).padStart(13)}s`
        + ` ${f.clear.toFixed(2).padStart(17)} m`);
    }
    const bad = flights.filter(f => f.occN > 0);
    if (bad.length) {
      console.log(`\n  ${bad.length} flight(s) had the lens behind terrain — the pullback is not clear`);
      process.exitCode = 1;
    } else if (flights.length) {
      console.log('\n  no flight put the lens behind terrain');
    }
  }

  /* Does the rotational lag make the occlusion harder? A boom that is swinging
     as well as shortening points somewhere the un-lagged one never did, so the
     pull-in is being asked a different question at every one of these
     stations, and the answer has to be no worse. */
  console.log('\n  rotational lag against the occlusion fix, same lap, four combinations:');
  console.log(`    ${''.padEnd(22)} ${'frames behind rock'.padStart(19)} ${'deepest'.padStart(9)} ${'shortest boom'.padStart(14)}`);
  const combo = (label, rows) => {
    const s = stats(rows);
    const shortest = Math.min(...rows.map(r => r.occl));
    console.log(`    ${label.padEnd(22)} ${String(s.occluded).padStart(19)} ${s.deepest.toFixed(2).padStart(9)} m`
      + ` ${(shortest * 100).toFixed(0).padStart(13)}%`);
  };
  combo('no lag, no collide', out.noLagNoCollide);
  combo('lag, no collide', out.before);
  combo('no lag, collide', out.noLag);
  combo('lag + collide (shipped)', out.after);

  const outDir = path.join(ROOT, 'shots', tag);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'lap.json'), JSON.stringify({ proxy, before: b, after: a, cost: { off: out.costOff, on: out.costOn }, rows: { before: out.before, after: out.after } }, null, 1));
  console.log(`\n  → shots/${tag}/lap.json`);
});

finish(process.exitCode || 0);
