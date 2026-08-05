/* AUDIT PROBE (round 2) — one site, everything that could explain a model
 * that says "visible" where the frame says "nothing".
 *
 * Pointed by default at seed 40's ramp landing near s=4150, which the crowd
 * implementer flags as scoring 4 of 5 on `crowdSightScore` and never reaching
 * twelve pixels in tools/zzcadence.mjs.
 *
 * Reported, in this order, because each answer rules out a different cause:
 *
 *   1. Does the site exist. `crowdProbe.plan()` says whether the scheduler
 *      PLACED it; `g.crowd.sites` says whether it survived the build, which
 *      drops any site whose groups total fewer than two.
 *   2. Where its people are. Standing distance in metres off the road edge,
 *      the rise, and the ramp's own lip / foot / land stations, so "the group
 *      is behind the ramp" is a number and not a guess.
 *   3. The model's eye against the real one. `crowdSightScore` puts the lens
 *      CROWD_BOOM = 11 m of station behind the car and CROWD_EYE = 2.55 m
 *      above the road edge at each of CROWD_BACKS = [50,38,28,20,14]. The car
 *      is driven to each of those stations by autopilot and the real
 *      g.camera.position printed beside the modelled one, with the height
 *      above the road edge computed the model's own way.
 *   4. The frame. At each station, per figure: the ablation bounding box, the
 *      projection of the figure's centre through the REAL camera in NDC, the
 *      range, and the pixel height it would subtend unobstructed. A figure
 *      with |ndc| <= 1 and a subtended height over a pixel and no ablation
 *      pixels is occluded; one with |ndc| > 1 is out of frame and which way;
 *      one subtending under a pixel is simply too far.
 *   5. What is in the way, by raycast from the real camera to the chest, with
 *      the name of the mesh it hits — the whole point being that `crowdSeen`
 *      marches a sightline in road coordinates and knows nothing about rocks,
 *      trees, rail posts or the ramp structure.
 *
 * Discipline: performance.now() pinned across every render in a station, frame
 * 0 after each drive-in discarded, 1600x900 through g.pipeline.render(), car
 * driven in by g.autopilot(true, 0.85) and its arrival station verified and
 * printed.
 *
 *   node tools/kc4150.mjs [--seed 40] [--s 4150] [--out shots/r2c-40]
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
const OUT = path.resolve(ROOT, flag('out', `shots/r2c-${SEED}`));
const TAG = flag('tag', `site${WANT_S}`);
const BACKS = flag('backs', '120,90,60,40,20,0').split(',').map(Number);
/* Anchor the run-in on the site's own station rather than on closest approach.
   Through a hairpin the two are hundreds of metres apart — seed 1's s=2143 has
   its closest approach at s=1893 on the other leg — and it is the site's own
   station that `crowdSightScore` scores back from. */
const ANCHOR = flag('anchor', 'closest');
const JSONP = flag('json', '');

fs.mkdirSync(OUT, { recursive: true });

await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(1_200_000);
  const res = await page.evaluate(([wantS, backs, anchor]) => {
    const g = window.__game;
    const THREE = g.THREE;
    const t = g.track;
    const L = t.length;
    const env = g.scene.getObjectByName('environment');
    const probe = env.userData.crowdProbe;
    const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
    const gl = g.renderer.getContext();
    const mesh = g.scene.getObjectByName('crowd-figures');
    const place = mesh.geometry.getAttribute('aPlace');
    const bodyA = mesh.geometry.getAttribute('aBody');

    /* EDGE_DROP is private to track.js. Recovered from a site the scheduler
       already measured, because `rise` is defined as at.y - (pos.y +
       EDGE_DROP) — so the constant falls straight out rather than being
       quoted here and left to drift. */
    let EDGE_DROP = null;
    for (const p of g.crowd.sites) {
      if (p.rise == null || !p.at || p.kind === 'start line') continue;
      EDGE_DROP = p.at.y - p.rise - t.frameAt(p.s).pos.y;
      break;
    }
    const CROWD_BOOM = 11, CROWD_EYE = 2.55;
    const CROWD_BACKS = [50, 38, 28, 20, 14];
    const CROWD_BEARING = Math.cos(44 * Math.PI / 180);
    /* crowdInFrame, re-derived because it is not exposed. Quoted from
       environment.js as it stands: bearing from the lens station to the group
       against the bearing from the lens station to the CAR station. */
    const inFrame = (s, back, at) => {
      const s0 = s - back - CROWD_BOOM;
      if (s0 < 0) return { ok: true, cos: 1 };
      const lens = t.frameAt(s0).pos, car = t.frameAt(s - back).pos;
      const fx = car.x - lens.x, fz = car.z - lens.z, flen = Math.hypot(fx, fz);
      const dx = at.x - lens.x, dz = at.z - lens.z, len = Math.hypot(dx, dz);
      if (len < 1e-3 || flen < 1e-3) return { ok: true, cos: 1 };
      const c = (dx * fx + dz * fz) / (len * flen);
      return { ok: c > CROWD_BEARING, cos: +c.toFixed(4) };
    };

    const grab = () => {
      const px = new Uint8Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const diff = (a, b) => {
      let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let i = 0, p = 0; i < a.length; i += 4, p++) {
        if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i + 1] - b[i + 1]) > 6
          || Math.abs(a[i + 2] - b[i + 2]) > 6) {
          n++;
          const x = p % W, yy = H - 1 - ((p / W) | 0);
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
        }
      }
      return n ? { n, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { n: 0, w: 0, h: 0 };
    };

    // ── 1. does the site exist ──────────────────────────────────────────
    const plan = probe.plan();
    const sites = g.crowd.sites.map(p => ({
      kind: p.kind, s: +p.s.toFixed(1), side: p.side ?? null,
      u: p.u ?? null, seen: p.seen ?? null,
      rise: p.rise != null ? +p.rise.toFixed(2) : null,
      groups: (p.groups || []).map(q => ({ cheer: q.cheer, n: q.n, s: +q.s.toFixed(1) })),
      at: p.at ? [+p.at.x.toFixed(1), +p.at.y.toFixed(1), +p.at.z.toFixed(1)] : null,
    }));
    let site = null, bestD = Infinity;
    for (const p of g.crowd.sites) {
      const d = Math.abs(p.s - wantS);
      if (d < bestD) { bestD = d; site = p; }
    }
    const near = bestD <= 40 ? site : null;

    const ramps = (t.ramps || []).map(r => ({
      lip: +r.lip.toFixed(1), foot: +r.foot.toFixed(1), land: +r.land.toFixed(1),
      dist: +r.dist.toFixed(1), air: r.air, speed: r.speed,
      wants: +(r.land + 8).toFixed(1),
    }));

    /* The model's own account of the station, whether or not a site is there:
       what crowdStand does with it and which gate refuses each sightline. */
    const modelAt = {};
    for (const side of [-1, 1]) {
      const w = probe.why(wantS, side);
      modelAt[side] = {
        u: w.u, seen: w.seen, trace: w.trace,
        wallDist: +probe.wallDist(wantS, side).toFixed(1),
        out: w.u === null ? null : +(w.u * probe.wallDist(wantS, side)).toFixed(2),
      };
    }

    const out = {
      W, H, fov: g.camera.fov, length: Math.round(L), EDGE_DROP,
      plan, sites, ramps, modelAt,
      wantS, found: near ? {
        kind: near.kind, s: +near.s.toFixed(1), side: near.side, u: near.u,
        seen: near.seen, rise: +near.rise.toFixed(2),
        out: +(near.u * probe.wallDist(near.s, near.side)).toFixed(2),
        wallDist: +probe.wallDist(near.s, near.side).toFixed(1),
        groups: (near.groups || []).map(q => ({ cheer: q.cheer, n: q.n, s: +q.s.toFixed(1) })),
        at: [+near.at.x.toFixed(2), +near.at.y.toFixed(2), +near.at.z.toFixed(2)],
      } : null,
      nearestSiteDist: +bestD.toFixed(1),
      shots: [], stations: [], eyes: [],
    };
    if (!near) return out;

    // which instances are this site's
    const mine = [];
    for (let i = 0; i < place.count; i++) {
      const x = place.getX(i), y = place.getY(i), z = place.getZ(i);
      if (Math.hypot(x - near.at.x, z - near.at.z) > 30) continue;
      mine.push({ i, x, y, z, h: place.getW(i), pose: bodyA.getY(i) });
    }
    out.figures = mine.map(m => ({
      i: m.i, pose: m.pose, h: +m.h.toFixed(2),
      at: [+m.x.toFixed(2), +m.y.toFixed(2), +m.z.toFixed(2)],
    }));

    // closest approach
    let closest = Infinity, atS = near.s;
    for (let s = Math.max(0, near.s - 250); s <= Math.min(L, near.s + 250); s += 1) {
      const f = t.frameAt(s);
      const d = Math.hypot(near.at.x - f.pos.x, near.at.z - f.pos.z);
      if (d < closest) { closest = d; atS = s; }
    }
    out.closeS = Math.round(atS);
    if (anchor === 'site') atS = near.s;
    out.atS = Math.round(atS);
    out.anchor = anchor;
    out.closest = +closest.toFixed(1);

    // ── 3. model eye vs real eye at CROWD_BACKS ────────────────────────
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

    const driveTo = (target) => {
      g.setPaused(true);
      g.goTo(Math.max(2, target - 130) / L);
      g.autopilot(true, 0.85);
      for (let k = 0; k < 60 * 30 && g.player.s < target; k++) g.step(1 / 60);
      return +g.player.s.toFixed(1);
    };

    for (const back of CROWD_BACKS) {
      const carS = near.s - back;
      const arrived = driveTo(carS);
      g.renderOnce();                       // frame 0 after the drive
      const cam = g.camera; cam.updateMatrixWorld(true);
      const modelLensS = near.s - back - CROWD_BOOM;
      const mp = t.frameAt(Math.max(0, modelLensS)).pos;
      const modelEyeY = mp.y + EDGE_DROP + CROWD_EYE;
      /* The real lens height stated the model's way: above the road edge at
         the station the real lens is actually over, found by the nearest point
         on the ribbon rather than by assuming the boom length. */
      let lensS = 0, lensD = Infinity;
      for (let s = Math.max(0, carS - 40); s <= carS + 10; s += 0.5) {
        const f = t.frameAt(s);
        const d = Math.hypot(cam.position.x - f.pos.x, cam.position.z - f.pos.z);
        if (d < lensD) { lensD = d; lensS = s; }
      }
      const realEdgeY = t.frameAt(lensS).pos.y + EDGE_DROP;
      out.eyes.push({
        back, carWanted: +carS.toFixed(1), carArrived: arrived,
        kmh: +g.player.kmh.toFixed(0),
        modelLensS: +modelLensS.toFixed(1),
        modelEye: [+mp.x.toFixed(1), +modelEyeY.toFixed(2), +mp.z.toFixed(1)],
        realCam: [+cam.position.x.toFixed(2), +cam.position.y.toFixed(2), +cam.position.z.toFixed(2)],
        realLensS: +lensS.toFixed(1), realLensLateral: +lensD.toFixed(2),
        realBoom: +(arrived - lensS).toFixed(2),
        realAboveEdge: +(cam.position.y - realEdgeY).toFixed(2),
        modelAboveEdge: CROWD_EYE,
        dEyeY: +(cam.position.y - modelEyeY).toFixed(2),
        pitchDeg: +(Math.asin(-new THREE.Vector3(0, 0, -1)
          .applyQuaternion(cam.quaternion).y) * 180 / Math.PI).toFixed(2),
        inFrameModel: inFrame(near.s, back, near.at),
      });
    }

    // ── 4/5. the frame, station by station ─────────────────────────────
    for (const back of backs) {
      const carS = Math.max(3, atS - back);
      const arrived = driveTo(carS);
      const cam = g.camera; cam.updateMatrixWorld(true);

      const real = performance.now.bind(performance);
      const pinned = real();
      performance.now = () => pinned;
      g.renderOnce();                       // frame 0, discarded
      g.renderOnce();
      const base = grab();
      g.renderOnce();
      const drift = diff(base, grab()).n;
      const png = g.renderer.domElement.toDataURL('image/png');

      const per = [];
      for (const m of mine) {
        const y0 = place.getY(m.i);
        place.setY(m.i, y0 - 5000);
        place.needsUpdate = true;
        g.renderOnce();
        per.push(diff(base, grab()));
        place.setY(m.i, y0);
        place.needsUpdate = true;
      }
      g.renderOnce();
      performance.now = real;

      const rows = mine.map((m, k) => {
        const c = new THREE.Vector3(m.x, m.y + m.h * 0.5, m.z);
        const head = new THREE.Vector3(m.x, m.y + m.h * 0.95, m.z);
        const chest = new THREE.Vector3(m.x, m.y + m.h * 0.55, m.z);
        const range = c.distanceTo(cam.position);
        const nd = c.clone().project(cam);
        const ndH = head.clone().project(cam);
        const subtend = H * m.h / (2 * Math.max(range, 0.01)
          * Math.tan(cam.fov * Math.PI / 360));
        const cast = (p) => {
          const dir = p.clone().sub(cam.position);
          const len = dir.length();
          ray.far = len - 0.35;
          ray.set(cam.position, dir.normalize());
          const hit = ray.intersectObjects(targets, false)[0];
          return hit ? { what: hit.object.userData.__probeName, at: +hit.distance.toFixed(1) } : null;
        };
        const d = per[k];
        let why = 'pixels';
        if (!d.n) {
          if (nd.z > 1 || nd.z < -1) why = 'behind the lens / past the far plane';
          else if (Math.abs(nd.x) > 1) why = nd.x > 0 ? 'off the RIGHT of frame' : 'off the LEFT of frame';
          else if (Math.abs(ndH.y) > 1 && Math.abs(nd.y) > 1) {
            why = nd.y > 0 ? 'off the TOP of frame' : 'off the BOTTOM of frame';
          } else if (subtend < 1) why = 'subpixel';
          else why = 'in frame, no pixels — occluded';
        }
        return {
          i: m.i, pose: m.pose, height: +m.h.toFixed(2),
          px: d.n, box: d.n ? [d.x0, d.y0, d.w, d.h] : [0, 0, 0, 0],
          ndc: [+nd.x.toFixed(3), +nd.y.toFixed(3), +nd.z.toFixed(4)],
          ndcHead: [+ndH.x.toFixed(3), +ndH.y.toFixed(3)],
          screen: [Math.round((nd.x * 0.5 + 0.5) * W), Math.round((0.5 - nd.y * 0.5) * H)],
          range: +range.toFixed(1), subtend: +subtend.toFixed(1),
          why,
          hitChest: cast(chest), hitHead: cast(head),
        };
      });

      out.stations.push({
        back, carWanted: Math.round(carS), carArrived: arrived,
        kmh: +g.player.kmh.toFixed(0), drift,
        cam: [+cam.position.x.toFixed(2), +cam.position.y.toFixed(2), +cam.position.z.toFixed(2)],
        pitchDeg: +(Math.asin(-new THREE.Vector3(0, 0, -1)
          .applyQuaternion(cam.quaternion).y) * 180 / Math.PI).toFixed(2),
        rows,
      });
      out.shots.push({ back, png });
    }
    g.autopilot(false);
    return out;
  }, [WANT_S, BACKS, ANCHOR]);

  const files = [];
  for (const sh of res.shots || []) {
    const f = path.join(OUT, `${TAG}-back${String(sh.back).padStart(3, '0')}.png`);
    fs.writeFileSync(f, Buffer.from(sh.png.split(',')[1], 'base64'));
    files.push(f);
  }
  delete res.shots;
  const jf = JSONP || path.join(ROOT, '.meas', 'r2', `kc4150-${SEED}-${TAG}.json`);
  fs.mkdirSync(path.dirname(jf), { recursive: true });
  fs.writeFileSync(jf, JSON.stringify(res, null, 1));

  console.log(`\n  seed ${SEED} — site wanted at s=${WANT_S}; EDGE_DROP recovered as ${res.EDGE_DROP}`);
  console.log(`\n  RAMPS on this stage (lip / foot / land / flight / land+8 = what the scheduler wants):`);
  for (const r of res.ramps) {
    console.log(`    lip ${String(r.lip).padStart(7)}  foot ${String(r.foot).padStart(7)}`
      + `  land ${String(r.land).padStart(7)}  dist ${String(r.dist).padStart(6)} m`
      + `  → wants s=${r.wants}`);
  }
  console.log(`\n  SCHEDULER LOG (crowdProbe.plan()):`);
  res.plan.forEach(l => console.log('    ' + l));
  console.log(`\n  g.crowd.sites (${res.sites.length}):`);
  for (const s of res.sites) {
    console.log(`    ${s.kind.padEnd(14)} s=${String(s.s).padStart(6)} side ${String(s.side).padStart(2)}`
      + `  seen ${s.seen === null ? '—' : s.seen}/5  rise ${s.rise}`
      + `  groups ${JSON.stringify(s.groups)}`);
  }
  console.log(`\n  nearest site to s=${WANT_S}: ${res.nearestSiteDist} m away`);
  if (!res.found) {
    console.log('  → NO site within 40 m of the wanted station.');
  } else {
    const f = res.found;
    console.log(`  → ${f.kind} at s=${f.s} side ${f.side}, model ${f.seen}/5,`
      + ` standing ${f.out} m off the road edge (u=${f.u.toFixed(3)} of a ${f.wallDist} m corridor),`
      + ` rise ${f.rise} m`);
    console.log(`     groups: ${JSON.stringify(f.groups)}  → ${res.figures.length} instances found`);
    console.log(`     closest approach s=${res.closeS}, ${res.closest} m lateral;`
      + ` run-in anchored on s=${res.atS} (${res.anchor})`);
  }
  for (const side of [-1, 1]) {
    const m = res.modelAt[side];
    console.log(`\n  crowdProbe.why(${WANT_S}, ${side}) — wallDist ${m.wallDist} m,`
      + ` u ${m.u === null ? 'NONE' : m.u.toFixed(3)}${m.out !== null ? ` (${m.out} m out)` : ''}`);
    (m.trace || []).forEach(l => console.log('      ' + l));
    (m.seen || []).forEach(l => console.log('      ' + l));
  }

  if (res.eyes?.length) {
    console.log('\n  MODEL EYE vs REAL LENS at the five approach stations the score uses:');
    console.log('   back  carS(want/got)  model lens s   model eye y   real cam y'
      + '   real boom   real above edge   model above edge   dY    pitch  inFrame(model)');
    for (const e of res.eyes) {
      console.log(`   ${String(e.back).padStart(4)}  ${String(e.carWanted).padStart(6)}/`
        + `${String(e.carArrived).padEnd(7)} ${String(e.modelLensS).padStart(12)}`
        + ` ${String(e.modelEye[1]).padStart(13)} ${String(e.realCam[1]).padStart(12)}`
        + ` ${String(e.realBoom).padStart(11)} ${String(e.realAboveEdge).padStart(17)}`
        + ` ${String(e.modelAboveEdge).padStart(18)} ${String(e.dEyeY).padStart(6)}`
        + ` ${String(e.pitchDeg).padStart(7)}  ${e.inFrameModel.ok ? 'yes' : 'NO '} cos=${e.inFrameModel.cos}`);
    }
  }

  for (const st of res.stations || []) {
    console.log(`\n  ── ${st.back} m back — car wanted s=${st.carWanted}, arrived ${st.carArrived},`
      + ` ${st.kmh} km/h, cam ${JSON.stringify(st.cam)}, pitch ${st.pitchDeg}°, drift ${st.drift} px`);
    console.log('     fig  pose  h(m)   px   box[x,y,w,h]           ndc x,y        screen'
      + '      range  subtend   why / blocker');
    for (const r of st.rows) {
      console.log(`     ${String(r.i).padStart(4)} ${String(r.pose).padStart(5)}`
        + ` ${String(r.height).padStart(5)} ${String(r.px).padStart(5)}`
        + `  ${JSON.stringify(r.box).padEnd(22)}`
        + ` ${String(r.ndc[0]).padStart(7)},${String(r.ndc[1]).padStart(7)}`
        + ` ${String(r.screen[0]).padStart(5)},${String(r.screen[1]).padStart(4)}`
        + ` ${String(r.range).padStart(7)} ${String(r.subtend).padStart(7)} px`
        + `  ${r.why}`
        + `${r.hitChest ? `  [chest ray hits ${r.hitChest.what} at ${r.hitChest.at} m]` : '  [chest ray clear]'}`
        + `${r.hitHead ? `  [head ray hits ${r.hitHead.what} at ${r.hitHead.at} m]` : '  [head ray clear]'}`);
    }
  }
  console.log('\n  captures:');
  files.forEach(f => console.log('    ' + f));
  console.log('  json → ' + jf);
  console.log();
});
finish(process.exitCode || 0);
