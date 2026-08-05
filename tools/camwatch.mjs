/* Dense ground-truth audit of the chase camera against the whole stage.
 *
 * tools/camprobe.mjs measures the camera against SolidWorld, the same proxy the
 * fix consults. That makes it blind in precisely the way that matters: any mesh
 * the proxy does not include is invisible both to the protection and to the
 * measurement, so a camera buried in excluded geometry reports a clean lap and
 * renders a navy void. A critic sampling the actual frames found one; this
 * exists so the gate finds the next one first.
 *
 * Everything here is raycast against the real scene graph with Three's own
 * Raycaster — slow, but answerable only by the truth. Two questions per
 * station:
 *
 *   boom      is there anything between the driver's head and the lens, and
 *             how far past it did the lens end up. Directly comparable to
 *             camprobe's numbers, but without the proxy in the loop.
 *   frame     what does the middle of the picture actually land on, and at what
 *             range. Under a metre or so means the near plane is inside a
 *             surface and the shot is unjudgeable — the critic's test.
 *
 * Reports the worst stations individually rather than one lap aggregate,
 * because an aggregate is what let a localised intrusion hide between two
 * clean neighbours.
 *
 * Two sampling modes, because they do not agree and the disagreement is the
 * bug. `lap` drives one continuous lap and samples it, which is what a player
 * experiences. `drive` uses the same `driveTo` per station that shoot.mjs and
 * skyprobe use — a placed start 180 m back, then an AI run-in — so the car
 * arrives on a different line, at a different speed, with a different attitude.
 * A localised intrusion can exist in one and not the other, and the capture
 * gate only ever sees the second.
 *
 *   node tools/camwatch.mjs [--n 400] [--worst 12] [--mode lap|drive]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const N = +flag('n', 400);
const WORST = +flag('worst', 12);
const FROM = +flag('from', 0);
const TO = +flag('to', 1);
const TAG = flag('tag', 'camwatch');
const MODE = flag('mode', 'lap');
if (MODE !== 'lap' && MODE !== 'drive') { console.error('  --mode must be lap or drive'); process.exit(2); }

await run({ width: 960, height: 540, hash: 'manual&tier=high&seed=22&cap=0&hud=0' }, async ({ page }) => {
  const out = await page.evaluate(([n, from, to, mode]) => {
    const g = window.__game;
    const THREE = g.THREE;
    const p = g.player;
    const L = g.track.length;

    g.setPaused(true);
    const sample = () => ({
      s: p.s, t: p.s / L, kmh: p.kmh,
      head: p.pos.clone().addScaledVector(p.up, 1.2),
      cam: g.camera.position.clone(),
      dir: g.camera.getWorldDirection(new THREE.Vector3()).clone(),
      occl: g.chase.occl, lift: g.chase.lift, slide: g.chase.slide.length(),
    });

    /* Where the lens went, either along one continuous lap or arriving at each
       station the way the capture tools arrive. */
    const tape = [];
    if (mode === 'lap') {
      g.autopilot(true, 0.85);
      g.goTo(0.002);
      let guard = 0;
      while (p.s < L - 45 && guard++ < 60 * 60 * 6) { g.step(1 / 60); tape.push(sample()); }
      g.autopilot(false);
    } else {
      for (let k = 0; k < n; k++) {
        g.driveTo(from + (to - from) * k / (n - 1));
        tape.push(sample());
      }
    }

    /* Everything solid enough to hide a camera in. Sprites, the sky dome, the
       sun and the ocean band are excluded because a lens "inside" them is not
       what the bug looks like; everything else in the stage is fair game, which
       is the point of a ground-truth pass. */
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
    ray.far = 400;
    const hitName = h => {
      let o = h.object, nm = o.userData.__probeName;
      return nm + (h.object.isInstancedMesh ? `#${h.instanceId}` : '');
    };

    const stations = [];
    const lo = Math.floor(from * (tape.length - 1)), hi = Math.floor(to * (tape.length - 1));
    const count = mode === 'lap' ? n : tape.length;
    for (let k = 0; k < count; k++) {
      const idx = mode === 'lap' ? lo + Math.round(k * (hi - lo) / (n - 1)) : k;
      const f = tape[idx];

      /* Boom, head to lens. Anything hit is between the driver and the camera,
         so the camera is behind it. */
      const boom = f.cam.clone().sub(f.head);
      const len = boom.length();
      boom.normalize();
      ray.set(f.head, boom);
      ray.far = len + 0.001;
      const bh = ray.intersectObjects(targets, false);
      const first = bh.length ? bh[0] : null;

      /* Frame centre, the critic's test. */
      ray.set(f.cam, f.dir);
      ray.far = 400;
      const fh = ray.intersectObjects(targets, false);

      stations.push({
        i: idx,
        t: +f.t.toFixed(4), s: +f.s.toFixed(1), kmh: Math.round(f.kmh),
        boomLen: +len.toFixed(2),
        occl: +f.occl.toFixed(3), lift: +f.lift.toFixed(2), slide: +f.slide.toFixed(2),
        // How far past the obstruction the lens sits. Positive is inside.
        pen: first ? +(len - first.distance).toFixed(2) : 0,
        blocker: first ? hitName(first) : null,
        centre: fh.length ? { d: +fh[0].distance.toFixed(1), name: hitName(fh[0]) } : null,
        // What the frame centre would have shown with nothing in the way.
        behind: fh.length > 1 ? { d: +fh[1].distance.toFixed(1), name: hitName(fh[1]) } : null,
      });
    }
    return { tape: tape.length, stations, targets: targets.length, mode };
  }, [N, FROM, TO, MODE]);

  const st = out.stations;
  console.log(`  mode=${out.mode}, ${st.length} stations`
    + ` (one every ${(5570 * (TO - FROM) / st.length).toFixed(0)} m or so),`
    + ` ${out.targets} meshes as ray targets\n`);

  const buried = st.filter(s => s.pen > 0);
  const voids = st.filter(s => s.centre && s.centre.d < 1.2);
  console.log(`  stations with the lens behind scenery      ${buried.length} of ${st.length}`);
  console.log(`  stations whose frame centre is under 1.2 m ${voids.length} of ${st.length}`
    + `   — this is what an unjudgeable frame looks like`);

  const show = (label, rows, key) => {
    console.log(`\n  ${label}`);
    if (!rows.length) { console.log('    none'); return; }
    console.log(`       t       s     km/h   boom  occl    ${key === 'pen' ? 'past surface' : 'centre range'}  what`);
    for (const s of rows) {
      const v = key === 'pen' ? `${s.pen.toFixed(2)} m` : `${s.centre ? s.centre.d.toFixed(1) + ' m' : '  -'}`;
      const who = key === 'pen' ? s.blocker : (s.centre ? s.centre.name : '-');
      console.log(`    ${s.t.toFixed(4)} ${String(s.s).padStart(7)} ${String(s.kmh).padStart(5)}`
        + ` ${s.boomLen.toFixed(1).padStart(6)} ${(s.occl * 100).toFixed(0).padStart(4)}%`
        + ` ${v.padStart(14)}  ${who}`);
    }
  };

  show(`worst ${WORST} stations by how far the lens is past a surface:`,
    st.slice().sort((a, b) => b.pen - a.pen).slice(0, WORST).filter(s => s.pen > 0), 'pen');
  show(`worst ${WORST} stations by how close the frame centre is:`,
    st.slice().sort((a, b) => (a.centre ? a.centre.d : 1e9) - (b.centre ? b.centre.d : 1e9)).slice(0, WORST), 'centre');

  /* The other half of the brief: terrain standing between the lens and the
     road. Not a camera intrusion — the shot is fine, the road is hidden. */
  const hidesRoad = st.filter(s => s.centre && s.behind
    && /landform|berm|basin/i.test(s.centre.name) && /road|gate|guardrail/i.test(s.behind.name));
  console.log(`\n  stations where terrain stands between the lens and the road: ${hidesRoad.length}`);
  if (hidesRoad.length) {
    console.log('       t       s     centre hit              road behind it   gap');
    for (const s of hidesRoad.slice(0, 20)) {
      console.log(`    ${s.t.toFixed(4)} ${String(s.s).padStart(7)}   ${s.centre.name.padEnd(18)} ${s.centre.d.toFixed(1).padStart(6)} m`
        + `   ${s.behind.name.padEnd(10)} ${s.behind.d.toFixed(1).padStart(6)} m   ${(s.behind.d - s.centre.d).toFixed(1)} m`);
    }
  }

  fs.mkdirSync(path.join(ROOT, 'shots', TAG), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'shots', TAG, 'stations.json'), JSON.stringify(out, null, 1));
  console.log(`\n  → shots/${TAG}/stations.json`);
});

finish(process.exitCode || 0);
