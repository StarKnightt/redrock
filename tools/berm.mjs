/* What the berm actually asks of the car, now that physics and mesh agree.
 *
 * `_climb` caps how fast the surface may lift the car as it moves across the
 * road, and a cap that never engages is dead code while one that engages
 * everywhere is the thing shaping berm handling rather than the rock.
 *
 * This wraps `_climb` and records, per substep the car spends past the road
 * edge, the vertical rate the geometry WANTS and the rate it is allowed. If
 * the two are the same almost everywhere the budget is a safety net; if the
 * budget bites constantly it is the thing shaping berm handling, not the rock.
 *
 * Driven by a keyboard on the bot's line, same as buzz.mjs — the AI's own
 * wheel is too slow to put the car on a berm the way a player does.
 *
 *   node tools/berm.mjs [--seeds 22,7,14]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,7,14').split(',').map(Number);

const pct = (v, q) => (v.length ? v[Math.min(v.length - 1, Math.floor(v.length * q))] : 0);
const all = {};

for (const seed of SEEDS) {
  await run({
    width: 640, height: 360,
    hash: `manual&tier=low&seed=${seed}&cap=0&hud=0`,
  }, async ({ page }) => {
    const out = await page.evaluate(() => {
      const g = window.__game;
      const p = g.player;
      const track = g.track;
      const Car = p.constructor;
      const rawClimb = Car.prototype._climb;
      const V = g.THREE.Vector3;
      const s1 = new V(), s2 = new V(), s3 = new V();

      const ev = [];
      let capture = null;

      Car.prototype._climb = function (s, lat, f, dt) {
        if (capture !== this) return rawClimb.call(this, s, lat, f, dt);
        const from = this.lat;
        const base = this.surfaceAt(s, from, s1).y;
        const wantY = this.surfaceAt(s, lat, s2).y;
        const got = rawClimb.call(this, s, lat, f, dt);
        const gotY = this.surfaceAt(s, got, s3).y;
        const hw = f.width * 0.5;
        const edge = Math.max(Math.abs(lat), Math.abs(from)) - hw;
        if (edge > -0.05 && dt > 1e-5) {
          ev.push({
            s, edge, dt,
            want: (wantY - base) / dt,
            got: (gotY - base) / dt,
            cut: Math.abs(lat - got),
            air: this.height > 0.35 ? 1 : 0,
          });
        }
        return got;
      };

      /* And the same question for the containment wall, which also moves the
         car across the road: how much air does the push itself invent? */
      const rawWalls = Car.prototype._walls;
      const w1 = new V(), w2 = new V();
      let wallN = 0, wallLift = 0, wallLiftMax = 0, wallPush = 0;
      const gap = (c) => {
        c.surfaceAt(c.s, c.lat, w1);
        return w2.copy(c.pos).sub(w1).dot(c.up);
      };
      Car.prototype._walls = function (f, dt) {
        if (capture !== this) return rawWalls.call(this, f, dt);
        const l0 = this.lat, g0 = gap(this);
        rawWalls.call(this, f, dt);
        if (this.lat !== l0) {
          wallN++;
          const d = gap(this) - g0;
          wallLift += Math.abs(d);
          if (d > wallLiftMax) wallLiftMax = d;
          wallPush = Math.max(wallPush, Math.abs(this.lat - l0));
        }
      };

      g.setPaused(true);
      g.autopilot(true, 1.0);
      g.bot.wobble = 5;              // Driver seeds this from Math.random; pin it
      g.goTo(0.0015);
      const bot = g.bot;
      capture = p;
      let frames = 0, recover = 0;
      for (let i = 0; i < 60 * 400 && !p.finished; i++) {
        const c = bot.drive(p, 1 / 60);
        g.botInput = {
          steer: c.steer > 0.15 ? 1 : c.steer < -0.15 ? -1 : 0,
          throttle: c.throttle > 0.3 ? 1 : 0,
          brake: c.brake > 0.25 ? 1 : 0,
          handbrake: c.handbrake,
        };
        g.step(1 / 60);
        if (p.strandedFor > 4) { p.recover(); recover++; }
        frames++;
      }
      capture = null;
      g.botInput = null;
      g.autopilot(false);
      Car.prototype._climb = rawClimb;
      Car.prototype._walls = rawWalls;

      const up = ev.filter(e => e.want > 0.25 && !e.air);
      const wants = up.map(e => e.want).sort((a, b) => a - b);
      const gots = up.map(e => e.got).sort((a, b) => a - b);
      const bit = up.filter(e => e.cut > 1e-4);
      const worst = [...up].sort((a, b) => b.want - a.want).slice(0, 6)
        .map(e => ({ s: +e.s.toFixed(0), edge: +e.edge.toFixed(2), want: +e.want.toFixed(1), got: +e.got.toFixed(1) }));

      return {
        seed: track.seed, frames, recover, finished: p.finished,
        pastEdge: ev.length, climbing: up.length,
        bitPct: up.length ? +(bit.length / up.length * 100).toFixed(1) : 0,
        cutMax: +Math.max(0, ...up.map(e => e.cut)).toFixed(3),
        want: [50, 90, 99, 100].map(q => +pctOf(wants, q).toFixed(2)),
        got: [50, 90, 99, 100].map(q => +pctOf(gots, q).toFixed(2)),
        maxGot: +Math.max(0, ...gots).toFixed(2),
        reached: +Math.max(0, ...ev.map(e => e.s)).toFixed(0),
        wallN, wallPush: +wallPush.toFixed(3),
        wallLiftMax: +wallLiftMax.toFixed(4),
        wallLiftAvg: +(wallLift / Math.max(1, wallN)).toFixed(4),
        worst,
      };

      function pctOf(v, q) {
        if (!v.length) return 0;
        return v[Math.min(v.length - 1, Math.floor(v.length * q / 100))];
      }
    });

    all[seed] = out;
    console.log(`\n═══ seed ${out.seed} — ${(out.frames / 60).toFixed(0)} s, ${out.recover} recoveries, finished=${out.finished} ═══`);
    console.log(`  substeps at/past the road edge: ${out.pastEdge}   of those climbing: ${out.climbing}`);
    console.log(`  rate the rock WANTS (m/s):     p50 ${out.want[0]}  p90 ${out.want[1]}  p99 ${out.want[2]}  max ${out.want[3]}`);
    console.log(`  rate the car is ALLOWED (m/s): p50 ${out.got[0]}  p90 ${out.got[1]}  p99 ${out.got[2]}  max ${out.got[3]}`);
    console.log(`  budget bites on ${out.bitPct}% of climbing substeps   worst lat held back ${out.cutMax} m`);
    console.log(`  wall pushes ${out.wallN}, biggest ${out.wallPush} m   air the push invented: worst ${out.wallLiftMax} m, mean |Δ| ${out.wallLiftAvg} m`);
    if (out.worst.length) {
      console.log('  steepest demands:');
      for (const w of out.worst) console.log(`    s=${String(w.s).padStart(4)}  ${w.edge.toFixed(2)} m past edge   want ${w.want} m/s → got ${w.got} m/s`);
    }
  });
}

fs.mkdirSync(path.join(ROOT, 'shots', 'turns'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'shots', 'turns', 'berm.json'), JSON.stringify(all, null, 1));
console.log('\n  → shots/turns/berm.json');
finish(process.exitCode || 0);
