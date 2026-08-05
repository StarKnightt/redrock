/* Does the bore land on a terrain change, or on nothing in particular?
 *
 * The claim that justified the site was that the tunnel is cut where the stage
 * changes — a tall inland wall arriving over the road — rather than at an
 * arbitrary station. That is a statement about `wallHeightBare` along the lap,
 * so this prints it along the lap and says where the bore sits in that
 * distribution. A percentile is the honest form of the claim: "tall" only means
 * anything relative to the rest of the stage.
 *
 * Also grabs the exit aperture, because whether the arch is framed by it is a
 * question about a picture.
 *
 *   node tools/qtterr.mjs [--seeds 22,1,40] [--shots 1]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',').map(Number);
const SHOTS = args.includes('--shots');

for (const seed of SEEDS) {
  await run({ width: 1024, height: 576, hash: `manual&tier=high&seed=${seed}&cap=60&hud=0` },
    async ({ page }) => {
      const r = await page.evaluate(() => {
        const g = window.__game;
        g.setPaused(true);
        const track = g.track, coast = g.coast;
        const env = g.scene.getObjectByName('environment');
        const field = env.userData.field;
        const tun = env.userData.tunnel;
        const rows = [];
        for (let s = 20; s < track.length; s += 20) {
          const inland = -coast.seaSideAt(s);
          const p = field.profile(s, inland);
          rows.push({
            s, wall: +p.wallHeightBare.toFixed(1),
            dist: +p.wallDist.toFixed(1),
            drop: +field.profile(s, -inland).cliffDrop.toFixed(1),
            y: +track.frameAt(s).pos.y.toFixed(1),
          });
        }
        return { seed: track.seed, L: track.length, tunnel: tun, rows };
      });

      const walls = r.rows.map(x => x.wall).sort((a, b) => a - b);
      const pct = v => (100 * walls.filter(w => w < v).length / walls.length);
      const at = s => r.rows.reduce((b, x) => (Math.abs(x.s - s) < Math.abs(b.s - s) ? x : b));
      const t = r.tunnel;
      console.log(`\n─── seed ${r.seed}   bore ${t.s0.toFixed(0)}–${t.s1.toFixed(0)}`);
      console.log(`  inland wall along the lap: median ${walls[Math.floor(walls.length / 2)].toFixed(1)} m,`
        + ` p90 ${walls[Math.floor(walls.length * 0.9)].toFixed(1)} m, max ${walls[walls.length - 1].toFixed(1)} m`);
      console.log('\n  station    wall m   pct of lap   note');
      for (const s of [t.s0 - 300, t.s0 - 200, t.s0 - 120, t.s0 - 60, t.s0 - 20,
        t.s0, (t.s0 + t.s1) / 2, t.s1, t.s1 + 20, t.s1 + 60, t.s1 + 120, t.s1 + 200]) {
        if (s < 20 || s > r.L) continue;
        const row = at(s);
        const tag = s < t.s0 - 1 ? 'before' : s > t.s1 + 1 ? 'after' : 'IN BORE';
        console.log(`  ${String(row.s).padStart(6)}   ${row.wall.toFixed(1).padStart(7)}`
          + `   ${pct(row.wall).toFixed(0).padStart(9)}%   ${tag}`);
      }
      /* The step at the mouth, which is what "lands on a terrain change" has to
         mean if it means anything measurable. */
      const before = at(t.s0 - 120).wall, mouth = at(t.s0 + 10).wall;
      console.log(`\n  wall 120 m before the portal ${before.toFixed(1)} m`
        + ` → 10 m inside ${mouth.toFixed(1)} m   (step ${(mouth - before).toFixed(1)} m,`
        + ` ${(mouth / Math.max(1, before)).toFixed(2)}x)`);
      console.log(`  the bore sits at the ${pct(at((t.s0 + t.s1) / 2).wall).toFixed(0)}th percentile`
        + ' of inland wall height for this stage');

      if (SHOTS && seed === 22) {
        for (const s of [t.s1 - 25, t.s1 - 5, t.s1 + 10, t.s1 + 45]) {
          await page.evaluate(async t2 => {
            const g = window.__game;
            g.driveTo(t2);
            g.setPaused(true);
            g.renderOnce();
          }, s / r.L);
          await capture(page, path.join(ROOT, 'shots', 'qt-aperture', `s${Math.round(s)}.png`));
        }
        console.log('  → shots/qt-aperture');
      }
    });
}
finish(process.exitCode || 0);
