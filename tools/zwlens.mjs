/* Where the chase lens actually is, relative to the road edge under it.
 *
 * `crowdSeen` marches its sightline from a modelled eye: CROWD_BOOM metres of
 * station behind the car, CROWD_EYE metres above the road edge. Both numbers
 * are quoted in environment.js as "the pessimistic end" of a measurement, and
 * the eye is the one that decides whether a spectator behind a berm can be
 * seen — so it is worth knowing to the decimetre rather than to the metre.
 *
 * One continuous autopilot lap per seed, from a real restart, sampling every
 * frame:
 *   - the lens's own station, by projecting the camera onto the centreline
 *   - its height above the road EDGE at that station (pos.y + EDGE_DROP)
 *   - the station lag behind the car, which is the boom
 *
 * Reported over the whole lap and over the finish run-in separately, because
 * the run-in is the only stretch D1 is about and the boom lengthens with speed.
 *
 *   node tools/zwlens.mjs [--seeds 22,1,40]
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

const lines = [];
const say = s => { console.log(s); lines.push(s); };
const all = [];

const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : NaN;

for (const SEED of SEEDS) {
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    const r = await page.evaluate(() => {
      const g = window.__game, t = g.track;
      g.setPaused(true);
      /* From the grid, deliberately: a probe that starts wherever the page's
         own loop left the car measures a different lap every run. */
      g.restart();
      g.autopilot(true, 0.85);
      const rows = [];
      let hint = -1;
      for (let i = 0; i < 60 * 400 && g.player.s < t.length - 36; i++) {
        g.step(1 / 60);
        if (i % 4) continue;
        const cam = g.camera.position;
        const pr = t.project(cam, hint);
        hint = pr.s;
        const f = t.frameAt(pr.s);
        rows.push({
          carS: +g.player.s.toFixed(1),
          kmh: +g.player.kmh.toFixed(1),
          camS: +pr.s.toFixed(1),
          boom: +(g.player.s - pr.s).toFixed(2),
          high: +(cam.y - (f.pos.y - 0.5)).toFixed(2),
        });
      }
      return { L: +t.length.toFixed(0), rows };
    });

    const band = (rows, label) => {
      if (!rows.length) return say(`    ${label}: no samples`);
      const h = rows.map(x => x.high).sort((a, b) => a - b);
      const b = rows.map(x => x.boom).sort((a, b) => a - b);
      say(`    ${label.padEnd(22)} n=${String(rows.length).padStart(5)}`
        + `   eye above road edge  min ${h[0].toFixed(2)}  p1 ${pct(h, 0.01).toFixed(2)}`
        + `  p5 ${pct(h, 0.05).toFixed(2)}  med ${pct(h, 0.5).toFixed(2)}`
        + `  p95 ${pct(h, 0.95).toFixed(2)}  max ${h[h.length - 1].toFixed(2)}`);
      say(`    ${''.padEnd(22)}          `
        + `   boom (station lag)   min ${b[0].toFixed(2)}  p5 ${pct(b, 0.05).toFixed(2)}`
        + `  med ${pct(b, 0.5).toFixed(2)}  p95 ${pct(b, 0.95).toFixed(2)}`
        + `  max ${b[b.length - 1].toFixed(2)}`);
    };

    say(`\n══ seed ${SEED} ══  L=${r.L}  ${r.rows.length} samples`);
    band(r.rows, 'whole lap');
    band(r.rows.filter(x => x.carS > r.L - 200), 'last 200 m');
    band(r.rows.filter(x => x.carS > r.L - 120 && x.carS < r.L - 20), 'finish run-in');
    band(r.rows.filter(x => x.kmh > 90), 'over 90 km/h');
    band(r.rows.filter(x => x.kmh < 60), 'under 60 km/h');
    all.push({ seed: +SEED, ...r });
  });
}

const dir = path.join(ROOT, '.meas', 'r3');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'zwlens.json'), JSON.stringify(all, null, 2));
fs.writeFileSync(path.join(dir, 'zwlens.txt'), lines.join('\n') + '\n');
console.log(`\n  → ${path.join(dir, 'zwlens.txt')}`);
finish(process.exitCode || 0);
