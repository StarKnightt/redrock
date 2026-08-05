/* Where the plume is, relative to the car and relative to the lens.
 *
 * b5burst answers "how much of the car is left" with one number. It does not
 * say which part of the car went, or which puffs took it, and those are the
 * two things a fix has to know. This prints, for each frame of the landing:
 *
 *   - the car's own screen box, measured with the plume hidden as well as the
 *     car, so it is the car's full extent and not what is left of it
 *   - the plume's screen box
 *   - the car's lost pixels split into the part the plume covers from ABOVE
 *     the car's mid-line and the part it covers from BELOW it, which is the
 *     difference between "the mass is too tall" and "the mass is too wide"
 *   - every live burst puff in camera space: how far behind the car it is
 *     along the view axis, how high, and its half-extent — so "is it between
 *     the lens and the car" is answered in metres
 *
 * Same discipline as b5burst: performance.now pinned across each measurement,
 * frame 0 printed but flagged, pool emptied and re-seeded before the run.
 *
 *   node tools/b6where.mjs [--seed 22] [--ramp 1] [--n 20]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', flag('seed', '22')).split(',').map(Number);
const RAMP = +flag('ramp', 1);
const N = +flag('n', 20);

for (const SEED of SEEDS) {
  await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
    async ({ page }) => {
      const out = await page.evaluate(([ramp, frames]) => {
        const g = window.__game, p = g.player;
        const pool = g.effects.particles;
        const cv = g.renderer.domElement, w = cv.width, h = cv.height;
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const tc = tmp.getContext('2d');
        const grab = () => { g.renderOnce(); tc.drawImage(cv, 0, 0); return tc.getImageData(0, 0, w, h).data; };
        const real = performance.now.bind(performance);
        const carParts = [];
        g.scene.traverse(o => { if (/^(shell|wheel\d)/.test(o.name)) carParts.push(o); });

        const frame = () => {
          const t = real(); performance.now = () => t;
          const shown = grab();
          pool.mesh.visible = false;
          const bare = grab();
          const was = carParts.map(o => o.visible);
          carParts.forEach(o => { o.visible = false; });
          const naked = grab();          /* no plume, no car */
          pool.mesh.visible = true;
          const noCar = grab();          /* plume, no car */
          carParts.forEach((o, i) => { o.visible = was[i]; });
          performance.now = real;

          const diff = (a, b, q) => Math.abs(a[q] - b[q]) + Math.abs(a[q + 1] - b[q + 1])
            + Math.abs(a[q + 2] - b[q + 2]);

          /* The car's whole extent: bare (car, no plume) against naked. */
          let cTop = h, cBot = -1, cL = w, cR = -1, carFull = 0;
          /* The plume's extent: shown against bare. */
          let pTop = h, pBot = -1, pL = w, pR = -1, plume = 0;
          const carMask = new Uint8Array(w * h);
          for (let q = 0; q < shown.length; q += 4) {
            const c = q >> 2, x = c % w, y = (c / w) | 0;
            if (diff(bare, naked, q) > 12) {
              carMask[c] = 1; carFull++;
              if (y < cTop) cTop = y; if (y > cBot) cBot = y;
              if (x < cL) cL = x; if (x > cR) cR = x;
            }
            if (diff(shown, bare, q) > 12) {
              plume++;
              if (y < pTop) pTop = y; if (y > pBot) pBot = y;
              if (x < pL) pL = x; if (x > pR) pR = x;
            }
          }
          /* What is left of the car, and where the losses are. */
          let carVis = 0, lostHigh = 0, lostLow = 0, lostLeft = 0, lostRight = 0;
          const mid = (cTop + cBot) * 0.5, xmid = (cL + cR) * 0.5;
          for (let q = 0; q < shown.length; q += 4) {
            const c = q >> 2;
            if (diff(shown, noCar, q) > 12) carVis++;
            if (!carMask[c]) continue;
            if (diff(shown, noCar, q) > 12) continue;   /* still visible */
            const x = c % w, y = (c / w) | 0;
            if (y < mid) lostHigh++; else lostLow++;
            if (x < xmid) lostLeft++; else lostRight++;
          }
          return {
            carFull, carVis, lostHigh, lostLow, lostLeft, lostRight,
            carBox: [cL, cTop, cR - cL + 1, cBot - cTop + 1],
            plumeBox: [pL, pTop, pR - pL + 1, pBot - pTop + 1],
            plume,
          };
        };

        /* Every live burst puff in the camera's own frame. */
        const cam = () => {
          const V = g.THREE.Vector3;
          const cp = g.camera.getWorldPosition(new V());
          const fwd = new V(0, 0, -1).applyQuaternion(g.camera.quaternion).normalize();
          const carP = p.pos.clone();
          const carDepth = carP.clone().sub(cp).dot(fwd);
          const rows = [];
          for (let i = 0; i < pool.max; i++) {
            if (!pool.active[i] || pool.kind[i] < 4.5) continue;
            const c = new V(pool.centers[i * 3], pool.centers[i * 3 + 1], pool.centers[i * 3 + 2]);
            const d = c.clone().sub(cp).dot(fwd);
            rows.push({
              /* negative = nearer the lens than the car is */
              rel: +(d - carDepth).toFixed(2),
              depth: +d.toFixed(2),
              up: +(c.y - carP.y).toFixed(2),
              sy: +pool.scales[i * 2 + 1].toFixed(2),
              sx: +pool.scales[i * 2].toFixed(2),
            });
          }
          rows.sort((a, b) => a.rel - b.rel);
          return {
            carDepth: +carDepth.toFixed(2),
            camUp: +(cp.y - carP.y).toFixed(2),
            speed: +(p.speed || 0).toFixed(1),
            rows,
          };
        };

        g.setPaused(true);
        if (g.race?.entries) g.race.entries.length = 0;
        for (let i = 0; i < pool.max; i++) {
          pool.active[i] = 0; pool.scales[i * 2] = pool.scales[i * 2 + 1] = 0;
        }
        pool.live = 0; pool.cursor = 0; pool._resetRandom();

        const r = g.track.ramps[Math.min(ramp, g.track.ramps.length - 1)];
        g.autopilot(true, 0.85);
        g.driveTo((r.pad0 - 60) / g.track.length, { runUp: 320, maxSec: 45 });
        let k = 0, wasAir = false;
        while (k++ < 900) { g.step(1 / 60); if (p.airborne) wasAir = true; if (wasAir && !p.airborne) break; }
        const land = [], geo = [];
        for (let f = 0; f < frames; f++) {
          g.setPaused(true);
          land.push(frame());
          geo.push(cam());
          g.setPaused(false);
          g.step(1 / 60);
        }
        g.autopilot(false);
        return { seed: g.track.seed, land, geo };
      }, [RAMP, N]);

      console.log(`\n  seed ${out.seed}  —  where the plume is`);
      console.log('   frame  carFull  carVis   lost:high   low   left  right'
        + '     car box x,y,w,h        plume box x,y,w,h    v m/s  camUp');
      out.land.forEach((r, i) => {
        const q = out.geo[i];
        console.log(`   ${String(i).padStart(5)} ${String(r.carFull).padStart(8)}`
          + ` ${String(r.carVis).padStart(7)} ${String(r.lostHigh).padStart(11)}`
          + ` ${String(r.lostLow).padStart(5)} ${String(r.lostLeft).padStart(6)}`
          + ` ${String(r.lostRight).padStart(6)}`
          + `   ${r.carBox.join(',').padStart(18)}   ${r.plumeBox.join(',').padStart(18)}`
          + ` ${q.speed.toFixed(1).padStart(6)} ${q.camUp.toFixed(2).padStart(6)}`);
      });

      console.log('\n  burst puffs in camera space, nearest the lens first');
      console.log('  (rel = metres behind the car along the view axis; negative = between lens and car)');
      [0, 4, 8, 12, 16].filter(f => f < out.geo.length).forEach(f => {
        const q = out.geo[f];
        if (!q.rows.length) return;
        console.log(`   frame ${f}  car at ${q.carDepth} m, lens ${q.camUp} m above the car`);
        console.log('     rel     depth      up      sx      sy');
        q.rows.forEach(r => console.log(`   ${r.rel.toFixed(2).padStart(6)}`
          + ` ${r.depth.toFixed(2).padStart(9)} ${r.up.toFixed(2).padStart(7)}`
          + ` ${r.sx.toFixed(2).padStart(7)} ${r.sy.toFixed(2).padStart(7)}`));
      });
    });
}

finish(process.exitCode || 0);
