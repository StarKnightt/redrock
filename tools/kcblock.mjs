/* AUDIT PROBE (round 2) — where, exactly, the thing that hides a site is.
 *
 * tools/kcrung.mjs shows a vertical line through this site's figures crossing
 * `landform--1` twice: once at the shoulder the figures stand on and once
 * fifteen metres over their heads. That is the shape of the answer but not the
 * answer, because a vertical ray cannot say whether the upper sheet is in the
 * way of a driver's eye.
 *
 * So: drive in by autopilot, cast from the real camera to each figure's chest,
 * and put the intersection back into road coordinates — station, metres from
 * the road edge, height above the road edge — next to what `drawnGroundY`
 * returns at that same station and offset, which is the number `crowdSeen`
 * marches against. If the ray meets solid geometry metres above the height the
 * model reads at the same place, the model is not looking at the surface that
 * blocks it.
 *
 * The face is characterised too: the triangle normal at the hit, and the row of
 * the ladder the hit belongs to, so "an overhang from this station" and "the
 * wall of a station further up the road" are told apart.
 *
 *   node tools/kcblock.mjs [--seed 40] [--s 4150] [--backs 120,90,60,40,20]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '40');
const WANT_S = Number(flag('s', '4150'));
const BACKS = flag('backs', '120,90,60,40,20').split(',').map(Number);

await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(600_000);
  const res = await page.evaluate(([wantS, backs]) => {
    const g = window.__game;
    const THREE = g.THREE;
    const t = g.track;
    const env = g.scene.getObjectByName('environment');
    const probe = env.userData.crowdProbe;

    let site = null, bd = Infinity;
    for (const p of g.crowd.sites) {
      const d = Math.abs(p.s - wantS);
      if (d < bd) { bd = d; site = p; }
    }
    const side = site.side;
    const f0 = t.frameAt(site.s);
    const EDGE_DROP = site.at.y - site.rise - f0.pos.y;

    const skip = /sky-dome|sun-disc|ocean-bands|shore-foam|block-clouds|bird|crowd/i;
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

    const mesh = g.scene.getObjectByName('crowd-figures');
    const place = mesh.geometry.getAttribute('aPlace');
    const mine = [];
    for (let i = 0; i < place.count; i++) {
      const x = place.getX(i), y = place.getY(i), z = place.getZ(i);
      if (Math.hypot(x - site.at.x, z - site.at.z) > 30) continue;
      mine.push({ i, x, y, z, h: place.getW(i) });
    }

    const road = (p) => {
      const pr = t.project(p, site.s);
      const fr = t.frameAt(pr.s);
      return {
        s: +pr.s.toFixed(1),
        out: +(Math.abs(pr.lat) - fr.width / 2).toFixed(2),
        lat: +pr.lat.toFixed(2),
        aboveEdge: +(p.y - (fr.pos.y + EDGE_DROP)).toFixed(2),
        drawnAtSameSpot: +probe.drawnY(pr.s, side,
          Math.max(0, Math.abs(pr.lat) - fr.width / 2) / probe.wallDist(pr.s, side)).toFixed(2),
        drawnAboveEdge: +(probe.drawnY(pr.s, side,
          Math.max(0, Math.abs(pr.lat) - fr.width / 2) / probe.wallDist(pr.s, side))
          - (fr.pos.y + EDGE_DROP)).toFixed(2),
      };
    };

    const out = { rows: [], site: { s: +site.s.toFixed(1), side, seen: site.seen, out: +(site.u * probe.wallDist(site.s, side)).toFixed(2) }, EDGE_DROP };
    for (const back of backs) {
      const carS = Math.max(3, site.s - back);
      g.setPaused(true);
      g.goTo(Math.max(2, carS - 130) / t.length);
      g.autopilot(true, 0.85);
      for (let k = 0; k < 60 * 30 && g.player.s < carS; k++) g.step(1 / 60);
      g.renderOnce();
      const cam = g.camera; cam.updateMatrixWorld(true);
      const eye = cam.position.clone();
      const eyeRoad = road(eye);
      const hits = [];
      for (const m of mine) {
        const chest = new THREE.Vector3(m.x, m.y + m.h * 0.55, m.z);
        const dir = chest.clone().sub(eye);
        const len = dir.length();
        ray.far = len - 0.3;
        ray.set(eye, dir.clone().normalize());
        const h = ray.intersectObjects(targets, false)[0];
        if (!h) { hits.push({ i: m.i, clear: true, range: +len.toFixed(1) }); continue; }
        const n = h.face
          ? h.face.normal.clone().applyMatrix3(
            new THREE.Matrix3().getNormalMatrix(h.object.matrixWorld)).normalize()
          : null;
        hits.push({
          i: m.i, clear: false, range: +len.toFixed(1),
          what: h.object.userData.__probeName,
          along: +h.distance.toFixed(1),
          frac: +(h.distance / len).toFixed(3),
          at: [+h.point.x.toFixed(2), +h.point.y.toFixed(2), +h.point.z.toFixed(2)],
          road: road(h.point),
          normal: n ? [+n.x.toFixed(2), +n.y.toFixed(2), +n.z.toFixed(2)] : null,
          faceTiltDeg: n ? +(Math.acos(Math.min(1, Math.abs(n.y))) * 180 / Math.PI).toFixed(1) : null,
          facingUp: n ? n.y > 0 : null,
        });
      }
      out.rows.push({
        back, arrived: +g.player.s.toFixed(1),
        eye: [+eye.x.toFixed(2), +eye.y.toFixed(2), +eye.z.toFixed(2)],
        eyeRoad, hits,
      });
      g.autopilot(false);
    }
    return out;
  }, [WANT_S, BACKS]);

  console.log(`\n  seed ${SEED} — site s=${res.site.s} side ${res.site.side},`
    + ` model ${res.site.seen}/5, standing ${res.site.out} m off the road edge.`
    + `  EDGE_DROP ${res.EDGE_DROP.toFixed(2)}`);
  for (const r of res.rows) {
    console.log(`\n  ── ${r.back} m back (car s=${r.arrived}); real lens at`
      + ` s=${r.eyeRoad.s}, ${r.eyeRoad.lat} m lateral, ${r.eyeRoad.aboveEdge} m above the road edge`);
    for (const h of r.hits) {
      if (h.clear) { console.log(`     figure ${h.i}: sightline CLEAR over ${h.range} m`); continue; }
      console.log(`     figure ${h.i}: range ${h.range} m — blocked by ${h.what}`
        + ` at ${h.along} m (${(h.frac * 100).toFixed(0)}% of the way)`);
      console.log(`        the blocker in road coordinates: s=${h.road.s},`
        + ` ${h.road.out} m off the road edge, ${h.road.aboveEdge} m ABOVE the road edge`);
      console.log(`        drawnGroundY at that same station and offset:`
        + ` ${h.road.drawnAtSameSpot}  (= ${h.road.drawnAboveEdge} m above the road edge)`);
      console.log(`        → the surface the model reads there sits`
        + ` ${(h.road.aboveEdge - h.road.drawnAboveEdge).toFixed(2)} m BELOW the geometry that`
        + ` actually stops the ray`);
      console.log(`        face normal ${JSON.stringify(h.normal)}, tilt from horizontal`
        + ` ${h.faceTiltDeg}°, ${h.facingUp ? 'up-facing' : 'DOWN-FACING (an underside)'}`);
    }
  }
  const jf = path.join(ROOT, '.meas', 'r2', `kcblock-${SEED}-${WANT_S}.json`);
  fs.mkdirSync(path.dirname(jf), { recursive: true });
  fs.writeFileSync(jf, JSON.stringify(res, null, 1));
  console.log('\n  json → ' + jf + '\n');
});
finish(process.exitCode || 0);
