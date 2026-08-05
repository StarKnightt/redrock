/* Is the road hidden because of where the camera is, or because of what is
 * standing in front of it?
 *
 * A critic reported that on the finish approach the seaward landform occludes
 * the road surface. Terrain in front of the road is not automatically a defect
 * — a chase camera sits nine metres behind and three above the car, so on the
 * exit of a left-hander it is looking across the inside of the corner and a
 * bank there is simply the shape of the hill. The question is whether the
 * obstruction is an artefact of the lens being where it is, or a lump of ground
 * that is in the way of anybody on that road.
 *
 * So each station gets asked twice along one ray direction: once from the lens,
 * and once from the driver's own eyeline. If the driver can see the road and
 * the camera cannot, it is the camera's problem and mine to fix. If the driver
 * cannot see it either, the ground is in the way and it is the environment's.
 *
 * Where it is the environment's, the last section measures the offending body
 * directly — how far out from the road centre it reaches and how far above the
 * road surface it stands — so the report is actionable without me touching
 * files another agent owns.
 *
 *   node tools/camsight.mjs [--from 0.925] [--to 0.965] [--n 60]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const FROM = +flag('from', 0.925), TO = +flag('to', 0.965), N = +flag('n', 60);

await run({ width: 960, height: 540, hash: 'manual&tier=high&seed=22&cap=0&hud=0' }, async ({ page }) => {
  const out = await page.evaluate(([from, to, n]) => {
    const g = window.__game;
    const THREE = g.THREE;
    const p = g.player;
    const L = g.track.length;
    g.setPaused(true);

    const pick = /landform|berm|basin/i, wanted = /^road/i;
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
    const terrainOnly = targets.filter(o => pick.test(o.userData.__probeName));

    const ray = new THREE.Raycaster();
    const rows = [];
    for (let k = 0; k < n; k++) {
      g.driveTo(from + (to - from) * k / (n - 1));
      const dir = g.camera.getWorldDirection(new THREE.Vector3());
      const eye = p.pos.clone().addScaledVector(p.up, 1.15);

      const shoot = origin => {
        ray.set(origin, dir); ray.far = 400;
        const h = ray.intersectObjects(targets, false);
        const terrain = h.find(x => pick.test(x.object.userData.__probeName));
        const road = h.find(x => wanted.test(x.object.userData.__probeName));
        return {
          first: h.length ? { d: +h[0].distance.toFixed(1), name: h[0].object.userData.__probeName } : null,
          terrain: terrain ? { d: +terrain.distance.toFixed(1), name: terrain.object.userData.__probeName } : null,
          road: road ? +road.distance.toFixed(1) : null,
        };
      };

      const lens = shoot(g.camera.position);
      const driver = shoot(eye);

      /* The question the centre ray cannot answer. A single ray down the middle
         of the frame hits the bank on the inside of every corner ever built,
         which says nothing about whether the driver can see where they are
         going. So walk the road ahead and count how much of it the lens has a
         clear line to, then ask the same of the driver's eyeline. If the two
         agree, the centre ray was measuring the shape of the hill. */
      const seen = origin => {
        let vis = 0, total = 0, firstLost = null;
        for (let d = 10; d <= 130; d += 2) {
          const pt = g.track.pointAt(p.s + d, 0, new THREE.Vector3());
          pt.y += 0.35;
          const to = pt.clone().sub(origin);
          const dist = to.length();
          ray.set(origin, to.multiplyScalar(1 / dist));
          ray.far = dist - 0.6;
          const h = ray.intersectObjects(terrainOnly, false);
          total++;
          if (!h.length) vis++;
          else if (firstLost === null) firstLost = d;
        }
        return { frac: vis / total, firstLost };
      };
      const lensRoad = seen(g.camera.position);
      const driverRoad = seen(eye);
      rows.push({
        t: +(p.s / L).toFixed(4), s: +p.s.toFixed(1), kmh: Math.round(p.kmh),
        occl: +g.chase.occl.toFixed(2), boom: +g.camera.position.distanceTo(eye).toFixed(1),
        lens, driver, lensRoad, driverRoad,
        // Terrain in front of the road, from this viewpoint.
        lensBlocked: !!(lens.terrain && lens.road && lens.terrain.d < lens.road),
        driverBlocked: !!(driver.terrain && driver.road && driver.terrain.d < driver.road),
      });
    }

    /* How big is the lump. Walk the road centreline and, on the seaward side,
       find the highest terrain surface at each lateral offset by dropping a ray
       from well above. Anything standing above the road deck is what is in the
       way. */
    const prof = [];
    const down = new THREE.Vector3(0, -1, 0);
    const at = new THREE.Vector3();
    for (let s = 5150; s <= 5450; s += 2) {
      const road = g.track.pointAt(s, 0, new THREE.Vector3());
      let peak = -1e9, peakLat = 0, peakName = null;
      for (let lat = 4; lat <= 46; lat += 1) {
        // Seaward is whichever side runs downhill into the basin; probe both and
        // keep the side that actually carries a raised body.
        for (const sign of [-1, 1]) {
          g.track.pointAt(s, sign * lat, at);
          ray.set(at.clone().setY(road.y + 120), down);
          ray.far = 400;
          const h = ray.intersectObjects(terrainOnly, false);
          if (!h.length) continue;
          const y = road.y + 120 - h[0].distance;
          if (y > peak) { peak = y; peakLat = sign * lat; peakName = h[0].object.userData.__probeName; }
        }
      }
      prof.push({
        s, roadY: +road.y.toFixed(2),
        peak: +peak.toFixed(2), above: +(peak - road.y).toFixed(2),
        lat: peakLat, body: peakName,
      });
    }
    return { rows, prof, targets: targets.length };
  }, [FROM, TO, N]);

  const r = out.rows;
  const lensBad = r.filter(x => x.lensBlocked);
  const bothBad = r.filter(x => x.lensBlocked && x.driverBlocked);
  const lensOnly = r.filter(x => x.lensBlocked && !x.driverBlocked);

  console.log(`  ${r.length} stations from t=${FROM} to t=${TO}, ${out.targets} meshes as ray targets\n`);
  console.log(`  terrain in front of the road from the lens      ${lensBad.length} of ${r.length}`);
  console.log(`  ...and from the driver's eyeline as well        ${bothBad.length}`
    + `   — ground genuinely in the way`);
  console.log(`  ...but clear from the driver's eyeline          ${lensOnly.length}`
    + `   — an artefact of where the lens is\n`);

  if (lensBad.length) {
    console.log('       t       s     km/h  boom   terrain ahead            road behind   driver sees');
    for (const x of lensBad) {
      console.log(`    ${x.t.toFixed(4)} ${String(x.s).padStart(7)} ${String(x.kmh).padStart(5)}`
        + ` ${x.boom.toFixed(1).padStart(5)}   ${x.lens.terrain.name.padEnd(12)} ${x.lens.terrain.d.toFixed(1).padStart(6)} m`
        + `   ${String(x.lens.road).padStart(6)} m`
        + `   ${x.driverBlocked ? 'blocked too at ' + x.driver.terrain.d.toFixed(1) + ' m' : 'road clear'}`);
    }
  }

  /* The legibility question, which is the one that actually matters. */
  const pc = v => (v * 100).toFixed(0) + '%';
  const mean = xs => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  console.log(`\n  how much of the road 10–130 m ahead has a clear line to it:`);
  console.log(`    from the lens             ${pc(mean(r.map(x => x.lensRoad.frac)))} on average,`
    + ` worst station ${pc(Math.min(...r.map(x => x.lensRoad.frac)))}`);
  console.log(`    from the driver's eyeline ${pc(mean(r.map(x => x.driverRoad.frac)))} on average,`
    + ` worst station ${pc(Math.min(...r.map(x => x.driverRoad.frac)))}`);
  const costly = r.filter(x => x.driverRoad.frac - x.lensRoad.frac > 0.1)
    .sort((a, b) => (b.driverRoad.frac - b.lensRoad.frac) - (a.driverRoad.frac - a.lensRoad.frac));
  console.log(`\n  stations where the lens loses road the driver can see, by more than 10 points:`
    + ` ${costly.length} of ${r.length}`);
  if (costly.length) {
    console.log('       t       s     lens sees   driver sees   difference   lens loses it from');
    for (const x of costly.slice(0, 12)) {
      console.log(`    ${x.t.toFixed(4)} ${String(x.s).padStart(7)} ${pc(x.lensRoad.frac).padStart(11)}`
        + ` ${pc(x.driverRoad.frac).padStart(13)} ${(pc(x.driverRoad.frac - x.lensRoad.frac)).padStart(12)}`
        + `   ${x.lensRoad.firstLost === null ? '-' : x.lensRoad.firstLost + ' m'}`);
    }
  }

  const raised = out.prof.filter(x => x.above > 0.6);
  console.log(`\n  terrain standing above the road deck, s=5150–5450, either side of centre:`);
  if (!raised.length) console.log('    nothing above 0.6 m');
  else {
    console.log('       s    road y   highest terrain   above deck   at lateral   body');
    for (const x of raised) {
      console.log(`    ${String(x.s).padStart(5)} ${x.roadY.toFixed(2).padStart(8)}`
        + ` ${x.peak.toFixed(2).padStart(15)} ${(x.above.toFixed(2) + ' m').padStart(12)}`
        + ` ${(x.lat + ' m').padStart(12)}   ${x.body}`);
    }
  }

  fs.mkdirSync(path.join(ROOT, 'shots', 'camsight'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'shots', 'camsight', 'sight.json'), JSON.stringify(out, null, 1));
  console.log('\n  → shots/camsight/sight.json');
});

finish(process.exitCode || 0);
