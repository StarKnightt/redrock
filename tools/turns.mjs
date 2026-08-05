/* Corner-by-corner diagnosis of turning trouble.
 *
 * Three passes, cheapest first.
 *
 *   1. Geometry audit. The physics reads the surface through Car.surfaceAt and
 *      the player reads it off the berm mesh. Those are two independent copies
 *      of the same cross-section, so they are compared here directly, per
 *      corner, at every lateral offset a car can legally reach.
 *   2. Instrumented lap. Car.prototype._climb and _walls are wrapped so every
 *      surface-lift charge and every wall strike is recorded with the state
 *      that produced it, then attributed to the element it happened in.
 *   3. Player-style corner entries. The bot never flicks to lock, so each
 *      corner is also driven with a synthetic step input at racing speed.
 *
 *   node tools/turns.mjs [--seeds 22,7,101] [--pass 1,2,3]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22').split(',').map(Number);
const PASSES = flag('pass', '1,2,3').split(',').map(Number);

const results = {};

for (const seed of SEEDS) {
  await run({
    width: 640, height: 360,
    hash: `manual&tier=low&seed=${seed}&cap=0&hud=0`,
  }, async ({ page }) => {
    const out = await page.evaluate(([passes]) => {
      const g = window.__game;
      const p = g.player;
      const track = g.track;
      const L = track.length;

      /* ---- elements, taken from the frames rather than the plan ---------
         plan entries carry a nominal length; the frames carry where the road
         actually is, including the elements generation ran out of stage
         before finishing. */
      const els = [];
      for (let i = 0; i < track.count; i++) {
        const f = track.frames[i];
        const last = els[els.length - 1];
        if (!last || last.el !== f.el) {
          els.push({ el: f.el, kind: f.el?.kind || 'straight', i0: i, i1: i });
        } else last.i1 = i;
      }
      for (const e of els) {
        e.s0 = track.frames[e.i0].s;
        e.s1 = track.frames[e.i1].s;
        let cmax = 0, bank = 0, grade = 0, wmin = 1e9, bermMax = 0;
        for (let i = e.i0; i <= e.i1; i++) {
          const f = track.frames[i];
          if (Math.abs(f.curv) > Math.abs(cmax)) cmax = f.curv;
          bank += f.bank; grade += f.grade;
          wmin = Math.min(wmin, f.width);
          bermMax = Math.max(bermMax, f.bermL, f.bermR);
        }
        const n = e.i1 - e.i0 + 1;
        e.curv = +cmax.toFixed(5);
        e.radius = cmax ? +Math.abs(1 / cmax).toFixed(1) : Infinity;
        e.bank = +(bank / n * 180 / Math.PI).toFixed(2);
        e.grade = +(grade / n * 100).toFixed(1);
        e.wmin = +wmin.toFixed(1);
        e.bermMax = +bermMax.toFixed(2);
        e.hand = cmax > 0 ? 'R' : cmax < 0 ? 'L' : '-';
        delete e.el;
      }

      const res = { seed: g.track.seed, length: +L.toFixed(0), els };

      /* ---- pass 1: does the physics surface agree with the berm mesh? --- */
      if (passes.includes(1)) {
        /* The mesh cross-section, copied from world/track.js. Not imported:
           this tool has to be able to say the two disagree, which means it
           needs its own statement of what the mesh says. */
        const EDGE_DROP = -0.5;
        const BERM = [[0.0, EDGE_DROP], [1.5, 0.95], [2.6, 1.35], [3.9, 0.4], [5.0, -0.75]];
        const meshHeight = (off, scale) => {
          const h = hh => EDGE_DROP + (hh - EDGE_DROP) * scale;
          for (let k = 0; k < BERM.length - 1; k++) {
            const [o0, h0] = BERM[k], [o1, h1] = BERM[k + 1];
            if (off >= o0 && off <= o1) {
              return h(h0 + (h1 - h0) * ((off - o0) / (o1 - o0)));
            }
          }
          return h(off < 0 ? BERM[0][1] : BERM[BERM.length - 1][1]);
        };
        /* And the ramp, restated here for the same reason as the berm: this
           tool exists to notice the physics and the mesh drifting apart, and
           it cannot do that by asking one of them what the other says. The
           control points are the mesh's, on the road's own 3 m grid. */
        const RAMP = [0, 0.007, 0.053, 0.178, 0.421, 0.822, 1.420, 0.710, 0];
        const RAMP_FULL = 1.5, RAMP_TOE = 5.0;
        const rampMesh = (s, off) => {
          for (const r of (track.ramps || [])) {
            const u = s - r.foot;
            if (u <= 0 || u >= (RAMP.length - 1) * 3) continue;
            const t2 = u / 3, i = Math.floor(t2);
            const hh = RAMP[i] + (RAMP[i + 1] - RAMP[i]) * (t2 - i);
            if (hh <= 0) return 0;
            if (off <= RAMP_FULL) return hh;
            if (off >= RAMP_TOE) return 0;
            return hh * (RAMP_TOE - off) / (RAMP_TOE - RAMP_FULL);
          }
          return 0;
        };

        const V = g.THREE.Vector3;
        const tmp = new V();
        const WALL = 1.05;      // how far past the edge Car._walls lets you go
        for (const e of els) {
          let worst = 0, worstAt = null;
          let physSlope = 0, meshSlope = 0;
          for (let s = e.s0; s <= e.s1; s += 3) {
            const f = track.frameAt(s);
            const hw = f.width * 0.5;
            for (const side of [-1, 1]) {
              const scale = side > 0 ? f.bermR : f.bermL;
              for (let off = 0; off <= WALL + 1e-9; off += 0.05) {
                const phys = p.surfaceAt(s, side * (hw + off), tmp)
                  .sub(f.pos).dot(f.up);
                const mesh = meshHeight(off, scale) + rampMesh(s, off);
                const d = phys - mesh;
                if (Math.abs(d) > Math.abs(worst)) {
                  worst = d;
                  worstAt = { s: +s.toFixed(0), side, off: +off.toFixed(2), scale: +scale.toFixed(2), phys: +phys.toFixed(3), mesh: +mesh.toFixed(3) };
                }
              }
              // Slope of each surface over the first metre out.
              const p0 = p.surfaceAt(s, side * hw, tmp).sub(f.pos).dot(f.up);
              const p1 = p.surfaceAt(s, side * (hw + 1), tmp).sub(f.pos).dot(f.up);
              physSlope = Math.max(physSlope, p1 - p0);
              meshSlope = Math.max(meshSlope, meshHeight(1, scale) - meshHeight(0, scale));
            }
          }
          e.geomWorst = +worst.toFixed(3);
          e.geomAt = worstAt;
          e.physRise1m = +physSlope.toFixed(2);
          e.meshRise1m = +meshSlope.toFixed(2);
        }

        /* The element sweep steps 3 m and starts at the element's own s0, so a
           24 m ramp can fall between its samples and report a clean 0.00 that
           means nothing. Sweep the ramps on their own grid, and report the
           height actually seen so the gate cannot pass by never looking. */
        res.ramps = (track.ramps || []).map(r => {
          let worst = 0, top = 0, at = null;
          for (let s = r.foot - 3; s <= r.foot + 27; s += 0.5) {
            const f = track.frameAt(s);
            const hw = f.width * 0.5;
            for (const side of [-1, 1]) {
              const scale = side > 0 ? f.bermR : f.bermL;
              for (let off = 0; off <= WALL + 1e-9; off += 0.05) {
                const phys = p.surfaceAt(s, side * (hw + off), tmp).sub(f.pos).dot(f.up);
                const rm = rampMesh(s, off);
                top = Math.max(top, rm);
                const d = phys - (meshHeight(off, scale) + rm);
                if (Math.abs(d) > Math.abs(worst)) {
                  worst = d;
                  at = { s: +s.toFixed(1), side, off: +off.toFixed(2) };
                }
              }
            }
          }
          return { lip: r.lip, top: +top.toFixed(3), worst: +worst.toFixed(3), at };
        });
      }

      /* ---- instrumentation shared by passes 2 and 3 --------------------- */
      const Car = p.constructor;
      const raw = { climb: Car.prototype._climb, walls: Car.prototype._walls };
      const log = { climb: [], walls: [], samples: [] };
      let capture = false;

      Car.prototype._climb = function (s, lat, f, dt) {
        const before = { vx: this.vx, vy: this.vy, lat: this.lat };
        const out = raw.climb.call(this, s, lat, f, dt);
        if (capture === this && out !== lat) {
          const yA = this.surfaceAt(s, before.lat, new g.THREE.Vector3()).y;
          const yB = this.surfaceAt(s, lat, new g.THREE.Vector3()).y;
          log.climb.push({
            s: +s.toFixed(1), lat: +lat.toFixed(2), held: +out.toFixed(2),
            blocked: +(lat - out).toFixed(3),
            wantRise: +((yB - yA) / dt).toFixed(1),      // m/s the ground asked for
            dv: +Math.hypot(this.vx - before.vx, this.vy - before.vy).toFixed(3),
            kmh: +(Math.hypot(before.vx, before.vy) * 3.6).toFixed(1),
          });
        }
        return out;
      };
      Car.prototype._walls = function (f, dt) {
        const before = { vx: this.vx, vy: this.vy, r: this.r, contact: this._contact };
        raw.walls.call(this, f, dt);
        if (capture === this && this._contact) {
          log.walls.push({
            s: +this.s.toFixed(1), lat: +this.lat.toFixed(2),
            fresh: !before.contact,
            dv: +Math.hypot(this.vx - before.vx, this.vy - before.vy).toFixed(3),
            dr: +(this.r - before.r).toFixed(4),
            kmh: +(Math.hypot(before.vx, before.vy) * 3.6).toFixed(1),
          });
        }
      };

      const elAt = s => els.find(e => s >= e.s0 && s <= e.s1) || els[els.length - 1];
      const blank = () => ({
        climbs: 0, climbDv: 0, climbWorstRise: 0,
        wallFresh: 0, wallScrub: 0, wallDv: 0,
        air: 0, maxHeight: 0, minKmh: 1e9, maxKmh: 0,
        steerSat: 0, yawCap: 0, frames: 0, worstDvDt: 0,
      });

      /* ---- pass 2: an instrumented lap --------------------------------- */
      if (passes.includes(2)) {
        g.setPaused(true);
        g.autopilot(true, 1.0);
        g.goTo(0.001);
        capture = p;
        const per = new Map();
        let prevV = 0, prevS = -1;
        const rows = [];
        const dt = 1 / 60;
        for (let i = 0; i < 60 * 400 && !p.finished; i++) {
          const beforeClimb = log.climb.length, beforeWall = log.walls.length;
          g.step(dt);
          const e = elAt(p.s);
          const key = e.s0;
          if (!per.has(key)) per.set(key, blank());
          const a = per.get(key);
          a.frames++;
          for (let k = beforeClimb; k < log.climb.length; k++) {
            a.climbs++; a.climbDv += log.climb[k].dv;
            a.climbWorstRise = Math.max(a.climbWorstRise, log.climb[k].wantRise);
          }
          for (let k = beforeWall; k < log.walls.length; k++) {
            if (log.walls[k].fresh) a.wallFresh++; else a.wallScrub++;
            a.wallDv += log.walls[k].dv;
          }
          if (p.airborne) a.air++;
          a.maxHeight = Math.max(a.maxHeight, p.height);
          a.minKmh = Math.min(a.minKmh, p.kmh);
          a.maxKmh = Math.max(a.maxKmh, p.kmh);
          const dv = Math.abs(p.speed - prevV) / dt;
          if (prevS >= 0) a.worstDvDt = Math.max(a.worstDvDt, dv);
          prevV = p.speed; prevS = p.s;
          rows.push({
            t: +(i * dt).toFixed(2), s: +p.s.toFixed(1), lat: +p.lat.toFixed(2),
            kmh: +p.kmh.toFixed(1), h: +p.height.toFixed(3),
            steer: +(p.steer * 180 / Math.PI).toFixed(1),
            r: +(p.r * 180 / Math.PI).toFixed(1),
            slip: +(p.slipAngle * 180 / Math.PI).toFixed(1),
          });
        }
        capture = false;
        g.autopilot(false);
        for (const e of els) {
          const a = per.get(e.s0);
          if (!a) continue;
          e.lap = {
            climbs: a.climbs, climbDv: +a.climbDv.toFixed(2),
            climbRise: +a.climbWorstRise.toFixed(1),
            wallFresh: a.wallFresh, wallScrub: a.wallScrub,
            wallDv: +a.wallDv.toFixed(2),
            airFrames: a.air, maxH: +a.maxHeight.toFixed(2),
            minKmh: +a.minKmh.toFixed(0), maxKmh: +a.maxKmh.toFixed(0),
            worstDvDt: +a.worstDvDt.toFixed(1),
          };
        }
        res.lapRows = rows;
        res.climbEvents = log.climb.length;
        res.wallEvents = log.walls.length;
        res.worstClimbs = log.climb.slice().sort((x, y) => y.dv - x.dv).slice(0, 25);
      }

      /* ---- pass 3: player-style entries -------------------------------- */
      if (passes.includes(3)) {
        g.setPaused(true);
        const trials = [];
        for (const e of els) {
          if (e.kind === 'straight') continue;
          /* Arrive at the corner at pace on the racing line the bot would
             use, then take over with a player's wheel: hold lock into the
             corner for a second and a half. Two runs, one each way, because
             a corner is not symmetric — the outside berm is the tall one. */
          for (const dir of [-1, 1]) {
            const entry = Math.max(20, e.s0 - 60);
            g.autopilot(true, 1.0);
            g.goTo(entry / L);
            for (let i = 0; i < 60 * 25 && p.s < e.s0 - 8; i++) g.step(1 / 60);
            g.autopilot(false);
            const kmh0 = p.kmh;
            const s0 = p.s;
            if (p.s < e.s0 - 30) { g.botInput = null; continue; }
            capture = p;
            const c0 = log.climb.length, w0 = log.walls.length;
            let maxH = 0, air = 0, minKmh = 1e9, worstJump = 0, prevPos = p.pos.clone();
            let stuck = 0;
            const dur = Math.min(200, Math.round((e.s1 - e.s0 + 40) / Math.max(8, p.speed) * 60));
            for (let i = 0; i < dur; i++) {
              g.botInput = { steer: dir, throttle: 0.55, brake: 0, handbrake: false };
              g.step(1 / 60);
              maxH = Math.max(maxH, p.height);
              if (p.airborne) air++;
              minKmh = Math.min(minKmh, p.kmh);
              const step = p.pos.distanceTo(prevPos);
              worstJump = Math.max(worstJump, step);
              prevPos.copy(p.pos);
              if (p.strandedFor > 0.5) stuck++;
            }
            g.botInput = null;
            capture = false;
            const climbs = log.climb.slice(c0);
            const walls = log.walls.slice(w0);
            trials.push({
              s0: e.s0, kind: e.kind, radius: e.radius, hand: e.hand,
              bank: e.bank, bermMax: e.bermMax, dir: dir > 0 ? 'R' : 'L',
              entryKmh: +kmh0.toFixed(0), exitKmh: +p.kmh.toFixed(0),
              minKmh: +minKmh.toFixed(0),
              maxH: +maxH.toFixed(2), airFrames: air,
              climbs: climbs.length,
              climbDv: +climbs.reduce((a, x) => a + x.dv, 0).toFixed(1),
              climbRise: +Math.max(0, ...climbs.map(x => x.wantRise)).toFixed(0),
              wallFresh: walls.filter(x => x.fresh).length,
              wallScrub: walls.filter(x => !x.fresh).length,
              stuckFrames: stuck,
              maxStepM: +worstJump.toFixed(2),
              advanced: +(p.s - s0).toFixed(0),
            });
          }
        }
        res.trials = trials;
      }

      Car.prototype._climb = raw.climb;
      Car.prototype._walls = raw.walls;
      g.setPaused(false);
      return res;
    }, [PASSES]);

    results[seed] = out;

    /* ---- report ---- */
    console.log(`\n═══ seed ${out.seed} — ${out.length} m, ${out.els.length} elements ═══`);

    if (PASSES.includes(1)) {
      console.log('\n  PASS 1 — physics surface vs berm mesh, per element');
      console.log('   s0     kind      R     berm   worst Δ  at off  scale   phys/mesh rise over 1 m');
      const bad = out.els.slice().sort((a, b) => Math.abs(b.geomWorst) - Math.abs(a.geomWorst));
      for (const e of bad.slice(0, 14)) {
        console.log(`  ${String(e.s0).padStart(5)}  ${e.kind.padEnd(8)} ${String(e.radius === null ? '-' : e.radius).padStart(6)}`
          + `  ${e.bermMax.toFixed(2).padStart(5)}   ${e.geomWorst.toFixed(2).padStart(6)} m`
          + `  ${String(e.geomAt?.off ?? '').padStart(5)}  ${String(e.geomAt?.scale ?? '').padStart(5)}`
          + `   ${e.physRise1m.toFixed(2)} / ${e.meshRise1m.toFixed(2)} m`);
      }
      const worst = Math.max(...out.els.map(e => Math.abs(e.geomWorst || 0)));
      console.log(`  worst disagreement anywhere on the stage: ${worst.toFixed(2)} m`);
      for (const r of (out.ramps || [])) {
        console.log(`  ramp lip ${String(r.lip).padStart(5)} — profile peak ${r.top.toFixed(2)} m,`
          + ` worst Δ ${r.worst.toFixed(2)} m`
          + (r.at ? `  at s ${r.at.s} off ${r.at.off}` : ''));
      }
    }

    if (PASSES.includes(2)) {
      console.log(`\n  PASS 2 — instrumented lap: ${out.climbEvents} climb charges, ${out.wallEvents} wall frames`);
      console.log('   s0     kind      R    bank   climbs  climbΔv  rise m/s  wall  air  maxH   min/max km/h');
      const rank = out.els.filter(e => e.lap)
        .sort((a, b) => (b.lap.climbDv + b.lap.wallDv) - (a.lap.climbDv + a.lap.wallDv));
      for (const e of rank.slice(0, 14)) {
        const l = e.lap;
        console.log(`  ${String(e.s0).padStart(5)}  ${e.kind.padEnd(8)} ${String(e.radius).padStart(6)} ${e.bank.toFixed(1).padStart(6)}`
          + `   ${String(l.climbs).padStart(5)}  ${l.climbDv.toFixed(1).padStart(7)}  ${l.climbRise.toFixed(0).padStart(7)}`
          + `  ${String(l.wallFresh + l.wallScrub).padStart(4)} ${String(l.airFrames).padStart(4)}  ${l.maxH.toFixed(2).padStart(5)}`
          + `   ${String(l.minKmh).padStart(3)}/${String(l.maxKmh).padStart(3)}`);
      }
    }

    if (PASSES.includes(3)) {
      console.log('\n  PASS 3 — player-style lock into each corner');
      console.log('   s0     kind      R   dir  entry  min  exit   climbs  climbΔv  rise  wall  air  maxH  stuck');
      const rank = out.trials.slice().sort((a, b) => (b.climbDv + b.wallFresh * 2) - (a.climbDv + a.wallFresh * 2));
      for (const t of rank.slice(0, 18)) {
        console.log(`  ${String(t.s0).padStart(5)}  ${t.kind.padEnd(8)} ${String(t.radius).padStart(5)}  ${t.dir}`
          + `  ${String(t.entryKmh).padStart(5)} ${String(t.minKmh).padStart(4)} ${String(t.exitKmh).padStart(5)}`
          + `   ${String(t.climbs).padStart(6)}  ${t.climbDv.toFixed(1).padStart(7)} ${String(t.climbRise).padStart(5)}`
          + `  ${String(t.wallFresh + t.wallScrub).padStart(4)} ${String(t.airFrames).padStart(4)} ${t.maxH.toFixed(2).padStart(5)}`
          + `  ${String(t.stuckFrames).padStart(5)}`);
      }
    }
  });
}

fs.mkdirSync(path.join(ROOT, 'shots', 'turns'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'shots', 'turns', 'turns.json'), JSON.stringify(results, null, 1));
console.log('\n  → shots/turns/turns.json');
finish(process.exitCode || 0);
