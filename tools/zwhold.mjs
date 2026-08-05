/* The held finish shot, and only that shot.
 *
 * zwseat measures the whole run-in and reports the held frames as one column.
 * This one stops on the settled pose and asks the frame directly: for every
 * candidate standing place around the line, is the chest in the frustum, is
 * anything in the way, and how tall is it in pixels. Separating "not pointed
 * at" from "hidden behind something" is the whole point — they have different
 * fixes and zwseat's single yes/no column cannot tell them apart.
 *
 * Also reports the real held pose, so the model of it in environment.js can be
 * checked against the camera main.js actually builds rather than against the
 * constants it was copied from.
 *
 *   node tools/zwhold.mjs [--seeds 22,1,40] [--outs 6.8,8.5,11] [--lo -40] [--hi 34]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');
const OUTS = flag('outs', '6.8,8.5,11').split(',').map(Number);
const LO = +flag('lo', -40);
const HI = +flag('hi', 34);
const STEP = +flag('step', 4);
const TAG = flag('tag', 'zwhold');

const lines = [];
const say = s => { console.log(s); lines.push(s); };
const all = [];

for (const SEED of SEEDS) {
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ending=1`,
  }, async ({ page }) => {
    const r = await page.evaluate(({ OUTS, LO, HI, STEP }) => {
      const THREE = window.__game.THREE;
      const g = window.__game, t = g.track;
      const env = g.scene.getObjectByName('environment');
      const P = env.userData.crowdProbe;
      const L = t.length, LINE = t.finishS, GATE = t.gateS;
      const H = g.renderer.domElement.height;

      /* The same list environment.js uses, read off the file rather than
         re-declared here, so this cannot certify a different set of meshes
         from the one the placement rule consults. */
      const blockers = P.blockers ? P.blockers() : [];

      g.setPaused(true);
      g.restart();
      g.autopilot(true, 0.85);
      for (let i = 0; i < 60 * 300 && g.player.s < LINE - 120; i++) g.step(1 / 60);
      g.ending.enabled = true;
      g.ending.arm();
      let held = 0;
      for (let i = 0; i < 60 * 40; i++) {
        g.step(1 / 60);
        held = g.ending.camera;
        if (held > 0.999 && g.player.speed < 0.3) break;
      }
      const cam = g.camera;
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();
      const tanHalf = Math.tan(cam.fov * Math.PI / 360);
      const camPr = t.project(cam.position, g.player.s);

      /* And, separately, EVERY drawn mesh — because the question "what is in the
         way" cannot be answered by a list that was written down in advance. The
         held pose is the one shot in the game composed with a structure
         deliberately between the lens and the subject, so a blocker list that
         excludes the arch on the grounds that you can see through it on approach
         is the list most likely to be wrong here. Skip only the crowd itself
         (instanced in the vertex shader, so Three's raycaster tests one
         unexpanded figure at the model origin and its hits are meaningless) and
         the things that are genuinely not surfaces. */
      const SEEN_THROUGH = /^(?:sky-dome|painted-sky|sun-disc|block-clouds|ocean-bands|shore-foam|crowd-figures|crowd-barriers|trackside-crowd|fx-|headland-depth-|distant-|.*-bird-|lighthouse-beams|turbine-rotors|landmark-streams|swaying-|flower-|blaze-|roadside-wildflowers)/;
      const everything = [];
      g.scene.traverse(o => {
        if (o.isMesh && o.visible && !SEEN_THROUGH.test(o.name || '')) everything.push(o);
      });

      const ray = new THREE.Raycaster();
      const ndc = new THREE.Vector3();
      const lookAll = (p) => {
        const d = cam.position.distanceTo(p);
        ray.set(cam.position, p.clone().sub(cam.position).normalize());
        ray.near = 0.3; ray.far = d - 0.4;
        const hit = ray.intersectObjects(everything, false);
        return hit.length ? `${hit[0].object.name || '(unnamed)'}@${hit[0].distance.toFixed(0)}m/${d.toFixed(0)}m` : null;
      };
      const look = (p, height) => {
        ndc.copy(p).project(cam);
        const inFrame = ndc.z <= 1 && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1;
        const d = cam.position.distanceTo(p);
        const dir = p.clone().sub(cam.position).normalize();
        ray.set(cam.position, dir);
        ray.near = 0.3; ray.far = d - 0.4;
        const hit = blockers.length ? ray.intersectObjects(blockers, false) : [];
        return {
          inFrame,
          ndc: [+ndc.x.toFixed(2), +ndc.y.toFixed(2)],
          by: hit.length ? (hit[0].object.name || '(unnamed)') : null,
          allBy: lookAll(p),
          px: +((height / d) / (2 * tanHalf) * H).toFixed(0),
        };
      };

      const gateTop = t.frameAt(GATE).pos.clone();
      gateTop.y += 6;
      const rows = [];
      for (let rel = LO; rel <= HI; rel += STEP) {
        const s = LINE + rel;
        if (s < 40 || s > L - 2) continue;
        for (const side of [-1, 1]) {
          const wall = P.wallDist(s, side);
          for (const outM of OUTS) {
            const u = outM / wall;
            if (u > 0.95) continue;
            const at = P.point(s, side, u);
            const dy = P.drawnY(s, side, u);
            const o = look(new THREE.Vector3(at.x, dy + 0.95, at.z), 1.9);
            rows.push({ rel, side, outM, ...o, stand: P.stand(s, side) !== null });
          }
        }
      }
      return {
        L: +L.toFixed(0), LINE, GATE,
        blockers: blockers.length,
        rest: +(g.player.s - LINE).toFixed(1),
        held: +held.toFixed(3),
        cam: {
          rel: +(camPr.s - LINE).toFixed(1),
          high: +(cam.position.y - (t.frameAt(camPr.s).pos.y - 0.5)).toFixed(2),
          lat: +camPr.lat.toFixed(2),
          fov: +cam.fov.toFixed(1),
        },
        gate: look(gateTop, 11.4),
        rows,
      };
    }, { OUTS, LO, HI, STEP });

    say(`\n══ seed ${SEED} ══  L=${r.L} line=${r.LINE} gate=${r.GATE}`
      + `  car rest ${r.rest} m past  blend ${r.held}  ${r.blockers} blockers`);
    say(`  held lens: ${r.cam.rel} m past line, ${r.cam.high} m over road edge,`
      + ` lat ${r.cam.lat}, fov ${r.cam.fov}`);
    say(`  gate top: ${r.gate.inFrame ? 'in frame' : 'OFF FRAME'} at ndc`
      + ` ${r.gate.ndc.join(',')}, ${r.gate.by ? 'behind ' + r.gate.by : 'clear'},`
      + ` ${r.gate.px} px`);
    const good = r.rows.filter(x => x.inFrame && !x.by && x.px >= 12);
    say(`  ${good.length} of ${r.rows.length} candidate chests are in frame, clear and >=12 px:`);
    say('    rel side  out    px   ndc-x  ndc-y  standable');
    for (const x of good.sort((a, b) => b.px - a.px)) {
      say(`    ${String(x.rel).padStart(3)} ${String(x.side).padStart(4)}`
        + ` ${String(x.outM).padStart(5)} ${String(x.px).padStart(5)}`
        + ` ${String(x.ndc[0]).padStart(7)} ${String(x.ndc[1]).padStart(6)}`
        + `  ${x.stand ? 'yes' : 'no'}`);
    }
    if (!good.length) say('    NONE');
    if (args.includes('--all')) {
      say('  every candidate, in station order:');
      for (const x of r.rows) {
        say(`    rel ${String(x.rel).padStart(3)} side ${String(x.side).padStart(2)}`
          + ` out ${String(x.outM).padStart(4)} ${String(x.px).padStart(4)} px`
          + ` ndc ${String(x.ndc[0]).padStart(6)},${String(x.ndc[1]).padStart(6)}`
          + ` ${x.inFrame ? 'in frame' : 'OFF    '}`
          + ` list:${x.by || 'clear'} all:${x.allBy || 'clear'}`
          + ` ${x.stand ? 'standable' : '-'}`);
      }
    }
    const why = {};
    for (const x of r.rows) {
      const k = !x.inFrame ? 'not pointed at' : x.by ? 'behind ' + x.by
        : x.px < 12 ? 'under 12 px' : 'ok';
      why[k] = (why[k] || 0) + 1;
    }
    say('  why the rest fail: ' + Object.entries(why)
      .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
    /* The disagreement between the two rays, which is the whole reason for the
       second one: a station the placement list calls clear and every drawn mesh
       calls blocked is a hole in the list, not in the terrain. */
    const missed = r.rows.filter(x => x.inFrame && !x.by && x.px >= 12 && x.allBy);
    say(`  clear by the placement list and BLOCKED by some other drawn mesh:`
      + ` ${missed.length} of ${good.length}`);
    for (const x of missed.slice(0, 12)) {
      say(`    rel ${String(x.rel).padStart(3)} side ${x.side} out ${x.outM}`
        + ` ${x.px} px — ${x.allBy}`);
    }
    all.push({ seed: +SEED, ...r });
  });
}

const dir = path.join(ROOT, '.meas', 'r3');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${TAG}.json`), JSON.stringify(all, null, 2));
fs.writeFileSync(path.join(dir, `${TAG}.txt`), lines.join('\n') + '\n');
console.log(`\n  → ${path.join(dir, TAG + '.txt')}`);
finish(process.exitCode || 0);
