/* The three frames the finish crowd is actually judged on, at native size.
 *
 * One continuous autopilot run per seed, with the ending armed, and three
 * captures out of it:
 *
 *   approach   the best frame of the run-in, chosen by measurement rather than
 *              by a hand-picked station: every 2 m from 120 m out to the line
 *              is scored for crowd footprint with the gate also in shot, and
 *              the largest is kept
 *   line       the crossing frame itself
 *   held       the settled ending pose, after the blend has finished and the
 *              car has stopped
 *   grid       the start, from a separate restart, which is the most-looked-at
 *              frame in the game
 *
 * Each one reports the crowd's footprint by render-differencing — the figures
 * and their ink against the same frame with the mesh hidden — plus the tallest
 * figure, the horizontal extent of the crowd's pixels (which is how the grid
 * squad's clipping is measured), and the finish gate's own pixels.
 *
 * performance.now() is pinned across every pair and frame 0 of each pair is
 * discarded, so the grass and the turbines cannot contribute a difference; the
 * printed drift column is that guarantee checked rather than assumed.
 *
 *   node tools/zwshot.mjs [--seeds 22,1,40]
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
const TAG = flag('tag', 'zwshot');
const dir = path.join(ROOT, '.meas', 'r3', TAG);
fs.mkdirSync(dir, { recursive: true });

const lines = [];
const say = s => { console.log(s); lines.push(s); };
const all = [];

/* Wrapped in a call rather than passed as a body: Playwright evaluates a plain
   string as an EXPRESSION, so a `return` in it is a syntax error. */
const SHARED = `(() => {
const g = window.__game;
const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
const gl = g.renderer.getContext();
const mesh = g.scene.getObjectByName('crowd-figures');
const rails = g.scene.getObjectByName('crowd-barriers');
const grab = () => {
  const px = new Uint8Array(W * H * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
};
const foot = (a, b) => {
  let n = 0, x0 = W, x1 = -1, y0 = H, y1 = -1;
  const colTop = new Int32Array(W).fill(-1), colBot = new Int32Array(W).fill(-1);
  for (let i = 0, p = 0; i < a.length; i += 4, p++) {
    if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i+1] - b[i+1]) > 6
      || Math.abs(a[i+2] - b[i+2]) > 6) {
      n++;
      const x = p % W, y = H - 1 - ((p / W) | 0);
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (colTop[x] < 0 || y < colTop[x]) colTop[x] = y;
      if (y > colBot[x]) colBot[x] = y;
    }
  }
  let tall = 0;
  for (let x = 0; x < W; x++) if (colTop[x] >= 0) tall = Math.max(tall, colBot[x] - colTop[x] + 1);
  return { n, tall, x0: x1 < 0 ? null : x0, x1: x1 < 0 ? null : x1, y0: y1 < 0 ? null : y0, y1: y1 < 0 ? null : y1 };
};
/* One measurement = five renders. Frame 0 is discarded; the second and third
   are differenced against each other to prove the clock is pinned; the fourth
   is the crowd hidden. */
const measure = () => {
  const real = performance.now.bind(performance);
  const pinned = real();
  performance.now = () => pinned;
  mesh.visible = true; if (rails) rails.visible = true;
  g.renderOnce();
  g.renderOnce();
  const withC = grab();
  g.renderOnce();
  const drift = foot(withC, grab()).n;
  mesh.visible = false; if (rails) rails.visible = false;
  g.renderOnce();
  const without = grab();
  mesh.visible = true; if (rails) rails.visible = true;
  g.renderOnce();
  performance.now = real;
  return { ...foot(withC, without), drift, W, H };
};
`;

for (const SEED of SEEDS) {
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ending=1`,
  }, async ({ page }) => {
    page.setDefaultTimeout(600_000);

    /* The grid first, off its own restart, so the run-in below is not measured
       from a car that has already been driven somewhere. */
    const grid = await page.evaluate(SHARED + `
      g.setPaused(true);
      g.restart();
      /* Two steps, because restart() places the car and the chase camera is
         written by step(): rendering straight off a restart photographs the
         lens wherever the previous frame left it, which is how the first run of
         this reported an empty grid. Two frames is 1.2 m of creep at idle. */
      g.step(1/60); g.step(1/60);
      return measure();
    })()`);
    await page.screenshot({ path: path.join(dir, `${SEED}-grid.png`) });

    const shots = await page.evaluate(SHARED + `
      const t = g.track, LINE = t.finishS, GATE = t.gateS;
      const THREE = g.THREE;
      const gateTop = t.frameAt(GATE).pos.clone(); gateTop.y += 5;
      /* The gate's own pixels, by projection and a ray rather than by hiding it
         — the arch is not one mesh and half of it is the road's. */
      const gatePx = () => {
        const cam = g.camera;
        cam.updateMatrixWorld(); cam.updateProjectionMatrix();
        const ndc = gateTop.clone().project(cam);
        if (ndc.z > 1 || Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) return 0;
        const d = cam.position.distanceTo(gateTop);
        return Math.round((7.6 / d) / (2 * Math.tan(cam.fov * Math.PI / 360)) * H);
      };

      g.setPaused(true);
      g.restart();
      g.autopilot(true, 0.85);
      for (let i = 0; i < 60 * 400 && g.player.s < LINE - 130; i++) g.step(1/60);
      g.ending.enabled = true;
      g.ending.arm();

      const run = [];
      let best = null, atLine = null, held = null;
      let lastS = -1e9;
      for (let i = 0; i < 60 * 60; i++) {
        g.step(1/60);
        const rel = g.player.s - LINE;
        const blend = g.ending.camera;
        if (blend < 0.02 && rel - lastS < 4) continue;
        if (blend >= 0.02 && !(blend > 0.999 && g.player.speed < 0.3)) continue;
        lastS = rel;
        const m = measure();
        const gp = gatePx();
        const row = { rel: +rel.toFixed(1), blend: +blend.toFixed(2), gate: gp, ...m };
        run.push(row);
        if (rel < 2 && gp > 0 && (!best || m.n * (gp > 8 ? 1 : 0.01) > best.n * (best.gate > 8 ? 1 : 0.01))) best = row;
        if (Math.abs(rel) < 4 && !atLine) atLine = row;
        if (blend > 0.999 && g.player.speed < 0.3) { held = row; break; }
      }
      return { LINE, GATE, rest: +(g.player.s - LINE).toFixed(1), run, best, atLine, held };
    })()`);
    await page.screenshot({ path: path.join(dir, `${SEED}-held.png`) });

    say(`\n══ seed ${SEED} ══  line=${shots.LINE} gate=${shots.GATE}`
      + `  car rest ${shots.rest} m past the line`);
    const show = (name, row) => {
      if (!row) { say(`  ${name.padEnd(9)} — not reached`); return; }
      say(`  ${name.padEnd(9)} rel ${String(row.rel).padStart(6)} m  crowd`
        + ` ${String(row.n).padStart(6)} px, tallest ${String(row.tall).padStart(4)} px,`
        + ` box x ${row.x0}–${row.x1} y ${row.y0}–${row.y1}`
        + `   gate ${String(row.gate).padStart(4)} px   drift ${row.drift}`);
    };
    show('grid', { rel: 0, gate: 0, ...grid });
    show('approach', shots.best);
    show('at line', shots.atLine);
    show('held', shots.held);
    const gridClip = grid.x1 !== null && grid.x1 >= grid.W - 1;
    say(`  grid squad right edge x=${grid.x1} of ${grid.W - 1}`
      + `  ${gridClip ? '◀── CLIPPED' : '(clear of the frame edge)'}`);
    all.push({ seed: +SEED, grid, ...shots });
  });
}

fs.writeFileSync(path.join(dir, '..', `${TAG}.json`), JSON.stringify(all, null, 2));
fs.writeFileSync(path.join(dir, '..', `${TAG}.txt`), lines.join('\n') + '\n');
console.log(`\n  → ${path.join(dir, '..', TAG + '.txt')}  (frames in ${dir})`);
finish(process.exitCode || 0);
