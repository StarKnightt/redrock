/* The grid frame, both formations, with a number on it.
 *
 * "The grid shot contains one car" is the half of the grid reversal that is not
 * a statistical claim, and it should not be settled by looking at a picture
 * either. So: the same build, the same seed, the same lens, the field placed
 * once behind the player and once ahead of it, and each rival's contribution to
 * the frame measured by ablation — render, drop that car five kilometres down,
 * render again, diff. That counts only pixels the car owns, through the ink and
 * behind every occluder, which is the same method tools/kqgrid.mjs uses for the
 * cheer squad.
 *
 * The formation is overridden through `e.grid`, which is where Race's
 * constructor copies GRID and where reset() reads it back from, so both frames
 * come off the module's own placement path.
 *
 * Clock pinned and frame 0 discarded: environment.js drives a shader uniform
 * from performance.now(), so two renders of the same state are not the same
 * image unless it is held still.
 *
 * Frames are the GL buffer with the HUD composited over it, which is the only
 * way the countdown numerals and the position badge appear in a capture at all.
 *
 *   node tools/kwshot.mjs [--seeds 22,1,40] [--grids pole,reversed]
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
const GRIDS = {
  pole: [[-7, 2.3], [-13.5, -2.3], [-20, 2.3]],
  reversed: [[20, 2.3], [13.5, -2.3], [7, 2.3]],
  roomy: [[27, 2.3], [20.5, -2.3], [14, 2.3]],
  mid: [[23, 2.3], [16.5, -2.3], [10, 2.3]],
};
const WANT = flag('grids', 'pole,reversed').split(',');
/* Which frame of the countdown to judge. 15 is a quarter of a second into the
   "3", the frame the player first sees; 195 is a quarter second after GO, by
   which time the numeral has left and nothing is in front of the field but
   road. Both are worth looking at and they answer different questions. */
const FRAME = +flag('frame', 15);
const outDir = path.join(ROOT, 'shots', 'kwshot');
fs.mkdirSync(outDir, { recursive: true });

const rows = [];

for (const SEED of SEEDS) {
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0`,
  }, async ({ page }) => {
    page.setDefaultTimeout(600_000);

    for (const name of WANT) {
      const out = await page.evaluate(([slots, holdFrames]) => {
        const g = window.__game;
        const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
        const gl = g.renderer.getContext();

        g.setPaused(true);
        /* Formation, then the full reset that places from it. */
        g.race.entries.forEach((e, i) => { e.grid = slots[i]; });
        g.restart();
        g.chase.started = false;
        g.countdown.arm();
        /* Stepped, not warped: warp() skips the countdown, and the whole point
           is the frame the player looks at while it is running. Wall-clock dt,
           which is what the countdown counts. */
        for (let i = 0; i < holdFrames; i++) g.step(1 / 60);

        const real = performance.now.bind(performance);
        const pinned = real();
        performance.now = () => pinned;

        const grab = () => {
          const px = new Uint8Array(W * H * 4);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
          return px;
        };
        const box = (a, b) => {
          let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
          for (let i = 0, p = 0; i < a.length; i += 4, p++) {
            if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i + 1] - b[i + 1]) > 6
              || Math.abs(a[i + 2] - b[i + 2]) > 6) {
              n++;
              const x = p % W, yy = H - 1 - ((p / W) | 0);
              if (x < x0) x0 = x; if (x > x1) x1 = x;
              if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
            }
          }
          return n ? { n, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null;
        };

        g.renderOnce();          // frame 0, discarded
        g.renderOnce();
        const A = grab();

        /* Each rival alone. Moved far below the world rather than made
           invisible, so the ink pass and the shadow map lose it too — a car
           hidden with .visible still owns its shadow, and a shadow is pixels. */
        const each = [];
        for (const e of g.race.entries) {
          const y0 = e.view.root.position.y;
          e.view.root.position.y = y0 - 5000;
          g.renderOnce();
          const B = grab();
          e.view.root.position.y = y0;
          g.renderOnce();
          const bb = box(A, B);
          each.push({
            name: e.name,
            ds: +(e.car.s - g.player.s).toFixed(1),
            lat: +e.car.lat.toFixed(2),
            px: bb ? bb.n : 0,
            h: bb ? bb.h : 0,
            w: bb ? bb.w : 0,
            box: bb ? [bb.x0, bb.y0, bb.x1, bb.y1] : null,
          });
        }

        /* The cheer squad, in the SAME frame, because moving the field up the
           road could put a car in front of it. environment.js stands the squad
           at s=46, which the pole grid left twelve metres clear ahead of the
           whole formation and the reversed grid puts level with the second row.
           Measured the way tools/kqgrid.mjs measures it — by ablating the
           instances — except that here the cars are actually on the grid, which
           is the only state in which the question means anything. */
        let squad = null;
        const site = g.crowd && g.crowd.sites.find(s => s.kind === 'start line');
        const mesh = g.scene.getObjectByName('crowd-figures');
        if (site && mesh) {
          const place = mesh.geometry.getAttribute('aPlace');
          const mine = [];
          for (let i = 0; i < place.count; i++) {
            if (Math.hypot(place.getX(i) - site.at.x, place.getZ(i) - site.at.z) > 26) continue;
            mine.push(i);
          }
          const sy = mine.map(i => place.getY(i));
          mine.forEach((i, k) => place.setY(i, sy[k] - 5000));
          place.needsUpdate = true;
          g.renderOnce();
          const S = grab();
          mine.forEach((i, k) => place.setY(i, sy[k]));
          place.needsUpdate = true;
          g.renderOnce();
          const sb = box(A, S);
          squad = {
            n: mine.length, s: +site.s.toFixed(1),
            px: sb ? sb.n : 0, tallest: sb ? sb.h : 0,
            box: sb ? [sb.x0, sb.y0, sb.x1, sb.y1] : null,
          };
        }

        // And all three at once, for the field's whole footprint.
        const ys = g.race.entries.map(e => e.view.root.position.y);
        g.race.entries.forEach(e => { e.view.root.position.y -= 5000; });
        g.renderOnce();
        const all = grab();
        g.race.entries.forEach((e, k) => { e.view.root.position.y = ys[k]; });
        g.renderOnce();
        const whole = box(A, all);

        performance.now = real;

        // The frame itself, HUD composited.
        g.renderOnce();
        g.hud.draw();
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const cx = canvas.getContext('2d');
        cx.drawImage(g.renderer.domElement, 0, 0);
        cx.drawImage(g.hud.canvas, 0, 0, W, H);

        return {
          each, squad,
          field: whole ? { px: whole.n, box: [whole.x0, whole.y0, whole.x1, whole.y1] } : null,
          playerS: +g.player.s.toFixed(1),
          pos: g.race.positionOf(g.player),
          fieldSize: g.race.fieldSize,
          countdown: g.countdown.display(),
          png: canvas.toDataURL('image/png'),
        };
      }, [GRIDS[name], FRAME]);

      const file = path.join(outDir, `s${SEED}-${name}${FRAME===15?'':'-f'+FRAME}.png`);
      fs.writeFileSync(file, Buffer.from(out.png.split(',')[1], 'base64'));
      const seen = out.each.filter(e => e.px > 0).length;
      rows.push({
        seed: SEED, grid: name, seen, field: out.field?.px ?? 0,
        each: out.each, squad: out.squad,
      });
      console.log(`\n  seed ${SEED}  ${name}`);
      console.log(`    player at s=${out.playerS}, HUD reads P${out.pos}/${out.fieldSize},`
        + ` numeral "${out.countdown ? out.countdown.text : 'none'}"`);
      console.log(`    rivals visible in the frame: ${seen} of ${out.each.length}`
        + `   whole field ${out.field?.px ?? 0} px`
        + `${out.field ? `  in a box ${JSON.stringify(out.field.box)}` : ''}`);
      for (const e of out.each) {
        console.log(`      ${e.name.padEnd(7)} Δs ${String(e.ds).padStart(6)} m`
          + `  lat ${String(e.lat).padStart(5)}`
          + `  ${String(e.px).padStart(6)} px   ${String(e.h).padStart(3)} px tall`
          + `  ${String(e.w).padStart(3)} px wide`
          + (e.px ? '' : '   NOT IN FRAME'));
      }
      if (out.squad) {
        console.log(`    cheer squad at s=${out.squad.s}: ${out.squad.n} figures,`
          + ` ${out.squad.px} px, tallest ${out.squad.tallest} px,`
          + ` box ${JSON.stringify(out.squad.box)}`);
      }
      console.log(`    → shots/kwshot/s${SEED}-${name}${FRAME===15?'':'-f'+FRAME}.png`);
    }
  });
}

console.log('\n  ══ the grid frame, summarised ══');
console.log('  seed  grid        rivals in frame   field footprint (px)');
for (const r of rows) {
  console.log(`  ${String(r.seed).padStart(4)}  ${r.grid.padEnd(10)}`
    + `${String(r.seen + ' of 3').padStart(14)}   ${String(r.field).padStart(10)}`);
}
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(rows, null, 1));
finish(process.exitCode || 0);
