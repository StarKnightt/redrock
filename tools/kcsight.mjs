/* AUDIT PROBE (round 2) — the model's sightline against the real one, step for
 * step.
 *
 * `crowdSeen` does not trace a line through the world. It marches a parameter t
 * from the eye station to the group station and, at each step, asserts that the
 * sightline is at lateral offset `out * t` — a straight line in (station,
 * lateral) coordinates. It then compares the ray's height against the drawn
 * ground AT THAT (station, lateral).
 *
 * A straight line in road coordinates is not a straight line in the world
 * wherever the road bends. This prints both, side by side, for one site:
 *
 *   model    the (station, lateral) the march assumes at each t, and the drawn
 *            ground height it reads there;
 *   truth    the same fraction along the actual world-space segment from the
 *            eye point to the group's chest, projected back onto the ribbon to
 *            recover the (station, lateral) it really passes over, with the
 *            drawn ground height there AND a ray dropped on the meshes for the
 *            height nothing can argue with.
 *
 * The eye is the model's own — `track.frameAt(s - back - 11).pos` lifted to
 * EDGE_DROP + 2.55 — so that the comparison is the march against the geometry
 * and not the march against a different camera. The real chase lens is
 * measured against the same march separately, driven in by autopilot.
 *
 *   node tools/kcsight.mjs [--seed 40] [--s 4150] [--steps 40]
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
const STEPS = Number(flag('steps', '40'));

await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(600_000);
  const res = await page.evaluate(([wantS, steps]) => {
    const g = window.__game;
    const THREE = g.THREE;
    const t = g.track;
    const env = g.scene.getObjectByName('environment');
    const probe = env.userData.crowdProbe;
    const CROWD_BOOM = 11, CROWD_EYE = 2.55;
    const CROWD_BACKS = [50, 38, 28, 20, 14];

    let EDGE_DROP = null;
    for (const p of g.crowd.sites) {
      if (p.rise == null || !p.at || p.kind === 'start line') continue;
      EDGE_DROP = p.at.y - p.rise - t.frameAt(p.s).pos.y;
      break;
    }

    let site = null, bd = Infinity;
    for (const p of g.crowd.sites) {
      const d = Math.abs(p.s - wantS);
      if (d < bd) { bd = d; site = p; }
    }
    if (!site || bd > 40) return { none: true, bd };
    const side = site.side;
    const wallAt = s => probe.wallDist(s, side);
    const out = site.u * wallAt(site.s);
    const chestY = probe.drawnY(site.s, side, site.u) + 0.95;

    // ground truth, by ray, on the drawn meshes
    const skip = /sky-dome|sun-disc|ocean-bands|shore-foam|block-clouds|bird|beam|foam|crowd/i;
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
    const dropOn = (x, z) => {
      ray.far = 900;
      ray.set(new THREE.Vector3(x, 400, z), new THREE.Vector3(0, -1, 0));
      const hits = ray.intersectObjects(targets, false);
      return hits.length
        ? { y: +hits[0].point.y.toFixed(2), what: hits[0].object.userData.__probeName }
        : null;
    };

    const marches = [];
    for (const back of CROWD_BACKS) {
      const s0 = site.s - back - CROWD_BOOM;
      const eyeY = t.frameAt(s0).pos.y + EDGE_DROP + CROWD_EYE;
      const eyeP = t.frameAt(s0).pos.clone(); eyeP.y = eyeY;
      const chestP = new THREE.Vector3(site.at.x, chestY, site.at.z);
      const rows = [];
      let hint = s0;
      for (let k = 1; k <= steps; k++) {
        const tt = k / steps;
        // ── the model's own march ────────────────────────────────────────
        const st = s0 + (site.s - s0) * tt;
        const d = out * tt;
        const rayY = eyeY + (chestY - eyeY) * tt;
        const mGround = probe.drawnY(st, side, d / Math.max(wallAt(st), 1));
        // ── the same fraction along the real segment ────────────────────
        const w = eyeP.clone().lerp(chestP, tt);
        const pr = t.project(w, hint);
        hint = pr.s;
        const tLat = Math.abs(pr.lat);
        const tGround = probe.drawnY(pr.s, side, tLat / Math.max(wallAt(pr.s), 1));
        const dropped = dropOn(w.x, w.z);
        rows.push({
          t: +tt.toFixed(3),
          mS: +st.toFixed(1), mOut: +d.toFixed(2), mGround: +mGround.toFixed(2),
          tS: +pr.s.toFixed(1), tOut: +tLat.toFixed(2),
          tSideSign: Math.sign(pr.lat) === Math.sign(side) ? 'same' : 'OPP',
          tGround: +tGround.toFixed(2),
          dropY: dropped ? dropped.y : null, dropWhat: dropped ? dropped.what : null,
          rayY: +rayY.toFixed(2),
          mBlock: mGround > rayY + 0.05,
          tBlock: dropped ? dropped.y > rayY + 0.05 : false,
        });
      }
      marches.push({
        back, s0: +s0.toFixed(1), eyeY: +eyeY.toFixed(2),
        modelVerdict: probe.seen(site.s, side, out, chestY, CROWD_EYE, [back]),
        maxLatGap: +Math.max(...rows.map(r => r.tOut - r.mOut)).toFixed(2),
        firstTrue: rows.find(r => r.tBlock) || null,
        firstModel: rows.find(r => r.mBlock) || null,
        rows,
      });
    }

    /* And the same thing from the real chase lens, so nobody can say the
       divergence is an artefact of the modelled eye point. */
    const real = [];
    for (const back of CROWD_BACKS) {
      const carS = site.s - back;
      g.setPaused(true);
      g.goTo(Math.max(2, carS - 130) / t.length);
      g.autopilot(true, 0.85);
      for (let k = 0; k < 60 * 30 && g.player.s < carS; k++) g.step(1 / 60);
      g.renderOnce();
      const cam = g.camera; cam.updateMatrixWorld(true);
      const eyeP = cam.position.clone();
      const chestP = new THREE.Vector3(site.at.x, chestY, site.at.z);
      let first = null, maxGap = -Infinity;
      let hint = carS - 20;
      for (let k = 1; k <= steps; k++) {
        const tt = k / steps;
        const w = eyeP.clone().lerp(chestP, tt);
        const pr = t.project(w, hint); hint = pr.s;
        const mOut = out * tt;
        maxGap = Math.max(maxGap, Math.abs(pr.lat) - mOut);
        const dropped = dropOn(w.x, w.z);
        if (!first && dropped && dropped.y > w.y + 0.05) {
          first = {
            t: +tt.toFixed(3), tS: +pr.s.toFixed(1), tOut: +Math.abs(pr.lat).toFixed(2),
            mOut: +mOut.toFixed(2), rayY: +w.y.toFixed(2),
            dropY: dropped.y, dropWhat: dropped.what,
            alongM: +eyeP.distanceTo(w).toFixed(1),
          };
        }
      }
      real.push({
        back, arrived: +g.player.s.toFixed(1),
        eye: [+eyeP.x.toFixed(2), +eyeP.y.toFixed(2), +eyeP.z.toFixed(2)],
        maxLatGap: +maxGap.toFixed(2), first,
      });
      g.autopilot(false);
    }

    return {
      site: {
        kind: site.kind, s: +site.s.toFixed(1), side, u: +site.u.toFixed(4),
        out: +out.toFixed(2), wallDist: +wallAt(site.s).toFixed(1),
        chestY: +chestY.toFixed(2), seen: site.seen,
        at: [+site.at.x.toFixed(2), +site.at.y.toFixed(2), +site.at.z.toFixed(2)],
      },
      curv: CROWD_BACKS.map(b => ({
        back: b,
        curvAtEye: +t.frameAt(site.s - b - CROWD_BOOM).curv.toFixed(5),
        curvAtSite: +t.frameAt(site.s).curv.toFixed(5),
        radiusAtEye: +(1 / Math.max(Math.abs(t.frameAt(site.s - b - CROWD_BOOM).curv), 1e-6)).toFixed(0),
      })),
      EDGE_DROP, marches, real,
    };
  }, [WANT_S, STEPS]);

  if (res.none) { console.log(`  no site within 40 m of s=${WANT_S} (nearest ${res.bd} m)`); return; }
  const s = res.site;
  console.log(`\n  seed ${SEED} — ${s.kind} s=${s.s} side ${s.side}, model ${s.seen}/5,`
    + ` standing ${s.out} m out of a ${s.wallDist} m corridor, chest y ${s.chestY}`);
  console.log(`  road curvature at the site: ${res.curv[0].curvAtSite}`
    + ` (radius ${(1 / Math.abs(res.curv[0].curvAtSite)).toFixed(0)} m);`
    + ` at the eye stations: ${res.curv.map(c => `${c.back}m→r=${c.radiusAtEye}`).join('  ')}`);

  for (const m of res.marches) {
    console.log(`\n  ── ${m.back} m back: eye at s=${m.s0}, y ${m.eyeY};`
      + ` crowdSeen says ${m.modelVerdict ? 'CLEAR' : 'blocked'}`);
    console.log(`     the march's lateral offset understates the real line by up to`
      + ` ${m.maxLatGap} m`);
    console.log('      t     model s   model out  model gnd |   true s   true out  side'
      + '  drawn gnd   ray-dropped gnd (mesh)      ray y   model?  truth?');
    for (const r of m.rows) {
      console.log(`   ${String(r.t).padStart(5)} ${String(r.mS).padStart(9)}`
        + ` ${String(r.mOut).padStart(11)} ${String(r.mGround).padStart(10)} |`
        + ` ${String(r.tS).padStart(8)} ${String(r.tOut).padStart(10)} ${r.tSideSign.padStart(5)}`
        + ` ${String(r.tGround).padStart(10)}`
        + ` ${String(r.dropY).padStart(9)} ${String(r.dropWhat || '').padEnd(18)}`
        + ` ${String(r.rayY).padStart(8)}`
        + `  ${r.mBlock ? 'BLOCK' : '  ok '}  ${r.tBlock ? 'BLOCK' : '  ok '}`);
    }
    console.log(`     first step the MODEL calls blocked: `
      + (m.firstModel ? `t=${m.firstModel.t} at s=${m.firstModel.mS}, ${m.firstModel.mOut} m out` : 'none'));
    console.log(`     first step the MESH actually blocks: `
      + (m.firstTrue ? `t=${m.firstTrue.t} — true (s=${m.firstTrue.tS}, ${m.firstTrue.tOut} m out),`
        + ` mesh ${m.firstTrue.dropWhat} at y ${m.firstTrue.dropY} against a ray at y ${m.firstTrue.rayY};`
        + ` the march was looking at (s=${m.firstTrue.mS}, ${m.firstTrue.mOut} m out) where the ground is ${m.firstTrue.mGround}`
        : 'none'));
  }

  console.log('\n  THE SAME LINE FROM THE REAL CHASE LENS (autopilot driven in):');
  for (const r of res.real) {
    console.log(`    ${String(r.back).padStart(3)} m back (arrived s=${r.arrived}) eye ${JSON.stringify(r.eye)}`
      + `  march understates lateral by up to ${r.maxLatGap} m`);
    console.log('        ' + (r.first
      ? `first obstruction ${r.first.alongM} m along the line: ${r.first.dropWhat} at y ${r.first.dropY}`
      + ` vs ray y ${r.first.rayY}; there the line is ${r.first.tOut} m off the edge at s=${r.first.tS}`
      + ` while the march assumed ${r.first.mOut} m`
      : 'nothing in the way'));
  }
  const jf = path.join(ROOT, '.meas', 'r2', `kcsight-${SEED}-${WANT_S}.json`);
  fs.mkdirSync(path.dirname(jf), { recursive: true });
  fs.writeFileSync(jf, JSON.stringify(res, null, 1));
  console.log('\n  json → ' + jf + '\n');
});
finish(process.exitCode || 0);
