/* Where a spectator on the finish run-in is actually SEEN from.
 *
 * The ground truth for D1, and it does not use any of the crowd's own model:
 * one continuous autopilot run-in from a real restart, with the ending armed so
 * the held finish shot is the real camera for the last three seconds, and at
 * every sample a grid of candidate standing places is tested against
 *
 *   - the real camera's frustum, from its real projection matrix
 *   - a real ray from the real camera position to the candidate's chest,
 *     against the drawn meshes
 *
 * A candidate scores a sample when it is inside the frustum, unoccluded, and
 * tall enough on screen to read (>= 12 px). The report is then per candidate:
 * how many metres of run-in it is legible over, and whether it is legible on
 * the crossing frame and in the held shot — which is what "the crowd is at the
 * finish" means.
 *
 * The finish gate is scored the same way at every sample, so "crowd and gate in
 * ONE frame" is a conjunction of two measured columns rather than a bearing
 * test.
 *
 *   node tools/zwseat.mjs [--seeds 22,1,40] [--outs 6.8,8.5,11] [--lo -80] [--hi 32]
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
const LO = +flag('lo', -80);
const HI = +flag('hi', 32);
const STEP = +flag('step', 4);
const TAG = flag('tag', 'zwseat');

const lines = [];
const say = s => { console.log(s); lines.push(s); };
const all = [];

for (const SEED of SEEDS) {
  await run({
    width: 1600, height: 900,
    /* ?ending=1 because `manual` disables the ending, and the held finish shot
       is half of what this measures. */
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ending=1`,
  }, async ({ page }) => {
    const r = await page.evaluate(({ OUTS, LO, HI, STEP }) => {
      const THREE = window.__game.THREE;
      const g = window.__game, t = g.track;
      const env = g.scene.getObjectByName('environment');
      const P = env.userData.crowdProbe;
      const L = t.length, LINE = t.finishS, GATE = t.gateS;
      const H = g.renderer.domElement.height;

      const SKIP = /^(sky-dome|painted-sky|sun-disc|block-clouds|ocean-bands|shore-foam|crowd-figures|trackside-crowd|.*bird.*|.*grass.*|.*wildflower.*|.*flower.*)$/i;
      const blockers = [];
      g.scene.traverse(o => {
        if (!o.isMesh || SKIP.test(o.name)) return;
        if (o.material && o.material.transparent) return;
        blockers.push(o);
      });

      /* The candidates: a chest at every station/side/standoff in the window
         that has drawn ground under it. Built once, in world space, so the
         sampling loop below is pure geometry. */
      const cand = [];
      for (let rel = LO; rel <= HI; rel += STEP) {
        const s = LINE + rel;
        if (s < 40 || s > L - 4) continue;
        for (const side of [-1, 1]) {
          const wall = P.wallDist(s, side);
          for (const outM of OUTS) {
            const u = outM / wall;
            if (u > 0.95) continue;
            const at = P.point(s, side, u);
            const dy = P.drawnY(s, side, u);
            cand.push({
              rel, s, side, outM,
              chest: new THREE.Vector3(at.x, dy + 0.95, at.z),
              seen: 0, firstRel: null, lastRel: null,
              atLine: false, atHold: false, best: 0,
            });
          }
        }
      }
      /* And the gate, scored by the same two tests at the same samples. */
      const gateTop = t.frameAt(GATE).pos.clone();
      gateTop.y += 6;

      const ray = new THREE.Raycaster();
      const ndc = new THREE.Vector3();
      const visible = (p, cam, tanHalf, height) => {
        ndc.copy(p).project(cam);
        if (ndc.z > 1 || Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) return 0;
        const d = cam.position.distanceTo(p);
        const dir = p.clone().sub(cam.position);
        ray.set(cam.position, dir.normalize());
        ray.near = 0.2; ray.far = d - 0.3;
        if (ray.intersectObjects(blockers, false).length) return 0;
        return (height / d) / (2 * tanHalf) * H;
      };

      g.setPaused(true);
      g.restart();
      g.autopilot(true, 0.85);
      /* driveTo would teleport; this is a continuous run so that every sample
         has the camera the player would have had at it. */
      for (let i = 0; i < 60 * 300 && g.player.s < LINE - 200; i++) g.step(1 / 60);
      /* Armed AFTER the autopilot, which skips it — the ending is the last
         three seconds of the shot being measured and cannot be left out. */
      g.ending.enabled = true;
      g.ending.arm();

      const samples = [];
      let lastRel = -1e9, lastHeld = -1e9, lastFrame = -1e9;
      for (let i = 0; i < 60 * 60; i++) {
        g.step(1 / 60);
        const rel = g.player.s - LINE;
        const held = g.ending.camera;
        /* Two cadences. On the approach the camera is a function of station, so
           sample by station; once the ending has the lens the car is stopping
           and station is nearly constant, so sample by blend instead. Sampling
           every held frame is 180 of them and 31,000 raycasts, which is where
           the first run of this spent seven minutes a seed. */
        if (held < 0.02) {
          if (rel - lastRel < 2) continue;
          lastRel = rel;
        } else if (held >= 0.995) {
          if (i - lastFrame < 15) continue;
          lastFrame = i;
        } else {
          if (held - lastHeld < 0.05) continue;
          lastHeld = held;
        }
        const cam = g.camera;
        cam.updateMatrixWorld();
        cam.updateProjectionMatrix();
        const tanHalf = Math.tan(cam.fov * Math.PI / 360);
        const camPr = t.project(cam.position, g.player.s);
        const gatePx = visible(gateTop, cam, tanHalf, 11.4);
        for (const c of cand) {
          const px = visible(c.chest, cam, tanHalf, 1.9);
          if (px >= 12) {
            c.seen++;
            if (c.firstRel === null) c.firstRel = +rel.toFixed(1);
            c.lastRel = +rel.toFixed(1);
            c.best = Math.max(c.best, px);
            if (gatePx >= 8) c.both = (c.both || 0) + 1;
            if (Math.abs(rel) < 3) c.atLine = true;
            if (held > 0.9) c.atHold = true;
          }
        }
        samples.push({
          rel: +rel.toFixed(1), kmh: +g.player.kmh.toFixed(1),
          held: +held.toFixed(2), gatePx: +gatePx.toFixed(0),
          camHigh: +(cam.position.y - (t.frameAt(camPr.s).pos.y - 0.5)).toFixed(2),
          boom: +(g.player.s - camPr.s).toFixed(1),
        });
        if (held > 0.995 && g.player.speed < 0.4) break;
      }
      return {
        L: +L.toFixed(0), LINE, GATE, samples,
        cand: cand.map(c => ({
          rel: c.rel, s: c.s, side: c.side, outM: c.outM, seen: c.seen,
          both: c.both || 0, firstRel: c.firstRel, lastRel: c.lastRel,
          atLine: c.atLine, atHold: c.atHold, best: +c.best.toFixed(0),
        })),
      };
    }, { OUTS, LO, HI, STEP });

    say(`\n══ seed ${SEED} ══  L=${r.L}  line=${r.LINE}  gate=${r.GATE}`
      + `  ${r.samples.length} samples`);
    const held = r.samples.filter(s => s.held > 0.9);
    say(`  run-in ${r.samples[0].rel.toFixed(0)} → ${r.samples[r.samples.length - 1].rel.toFixed(0)} m`
      + `  (held frames ${held.length})   gate px at`
      + ` −60/−20/0: ${[-60, -20, 0].map(x => {
        const s = r.samples.reduce((a, b) => Math.abs(b.rel - x) < Math.abs(a.rel - x) ? b : a);
        return s.gatePx;
      }).join('/')}`);
    say(`  real lens over road edge: min ${Math.min(...r.samples.map(s => s.camHigh)).toFixed(2)}`
      + `  med ${r.samples.map(s => s.camHigh).sort((a, b) => a - b)[r.samples.length >> 1].toFixed(2)}`
      + `  max ${Math.max(...r.samples.map(s => s.camHigh)).toFixed(2)}`
      + `   boom min ${Math.min(...r.samples.map(s => s.boom)).toFixed(1)}`
      + ` max ${Math.max(...r.samples.map(s => s.boom)).toFixed(1)}`);
    say('  candidates that are legible anywhere (>=12 px, unoccluded, in frustum):');
    say('    rel-line side  out    samples  with-gate  first→last rel   px  at-line  held');
    const good = r.cand.filter(c => c.seen > 0).sort((a, b) => b.both - a.both || b.seen - a.seen);
    for (const c of good) {
      say(`    ${String(c.rel).padStart(8)} ${String(c.side).padStart(4)}`
        + ` ${String(c.outM).padStart(5)}  ${String(c.seen).padStart(9)}`
        + `  ${String(c.both).padStart(9)}   ${String(c.firstRel).padStart(6)}`
        + `→${String(c.lastRel).padStart(6)}  ${String(c.best).padStart(4)}`
        + `  ${c.atLine ? '  yes  ' : '   no  '}  ${c.atHold ? 'yes' : ' no'}`);
    }
    if (!good.length) say('    NONE');
    all.push({ seed: +SEED, ...r });
  });
}

const dir = path.join(ROOT, '.meas', 'r3');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${TAG}.json`), JSON.stringify(all, null, 2));
fs.writeFileSync(path.join(dir, `${TAG}.txt`), lines.join('\n') + '\n');
console.log(`\n  → ${path.join(dir, TAG + '.txt')}`);
finish(process.exitCode || 0);
