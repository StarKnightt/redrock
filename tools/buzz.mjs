/* Per-SUBSTEP hunt for oscillation, contact flicker and on-road lift.
 *
 * The car runs at 120 Hz inside a 60 Hz frame, so anything that alternates
 * every substep is invisible to a per-frame capture — it aliases to a constant
 * or to noise. Everything here is recorded inside Car.prototype.step, one row
 * per substep, and the statistics that matter are the ones that only exist at
 * that rate: how often a signal reverses direction, and how often a state
 * toggles.
 *
 * Driven by a keyboard, not by the race AI. The bot moves its wheel at 77°/s
 * and smooths its own output; a key is down or it is not. So the bot supplies
 * the racing line and the pace, and its steering, throttle and brake are then
 * quantised to what a keyboard can actually send — a square wave into a filter
 * that can deliver 163°/s. That is the input the player produces and the only
 * one that exercises fast turn-in, and unlike a hand-written line follower it
 * gets round the whole stage, which is the part that matters when the
 * complaint is about specific corners.
 *
 *   node tools/buzz.mjs [--seeds 22] [--dead 0.15] [--rows 0] [--near S]
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
const DEAD = +flag('dead', 0.15);
const DUMP = +flag('rows', 0);
const NEAR = flag('near', '') === '' ? null : +flag('near', '');

const all = {};

for (const seed of SEEDS) {
  await run({
    width: 640, height: 360,
    hash: `manual&tier=low&seed=${seed}&cap=0&hud=0`,
  }, async ({ page }) => {
    const out = await page.evaluate(([dead, dump, near]) => {
      const g = window.__game;
      const p = g.player;
      const track = g.track;
      const L = track.length;
      const Car = p.constructor;
      const rawStep = Car.prototype.step;
      const V = g.THREE.Vector3;
      const scratch = new V();

      const rows = [];
      let capture = false;
      let prev = null;
      Car.prototype.step = function (dt, input) {
        const s0 = this.s, lat0 = this.lat;
        rawStep.call(this, dt, input);
        if (capture !== this) return;
        const surfY = this.surfaceAt(this.s, this.lat, scratch).y;
        const row = {
          s: this.s, lat: this.lat, h: this.height, air: this.airborne ? 1 : 0,
          vv: this.vertVel, vx: this.vx, vy: this.vy, r: this.r,
          steer: this.steer, cmd: input.steer, thr: this.throttle, brk: this.brake,
          slipF: this._slipF || 0, slipR: this._slipR || 0,
          climb: this._climbing ? 1 : 0, wall: this._contact ? 1 : 0,
          roll: this.roll, lift: this.bodyLift || 0, pitch: this.pitch,
          su0: this.susp[0], su1: this.susp[1], su2: this.susp[2], su3: this.susp[3],
          surfY, ds: this.s - s0, dlat: this.lat - lat0,
          hw: 0,
        };
        rows.push(row);
        prev = row;
      };

      /* ---- a keyboard on the bot's racing line -------------------------- */
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
          steer: c.steer > dead ? 1 : c.steer < -dead ? -1 : 0,
          throttle: c.throttle > 0.3 ? 1 : 0,
          brake: c.brake > 0.25 ? 1 : 0,
          handbrake: c.handbrake,
        };
        g.step(1 / 60);
        if (p.strandedFor > 4) { p.recover(); recover++; }
        frames++;
      }
      capture = false;
      g.botInput = null;
      g.autopilot(false);
      Car.prototype.step = rawStep;

      for (const row of rows) row.hw = track.frameAt(row.s, undefined).width * 0.5;

      /* ---- statistics, per 15 m of stage -------------------------------- */
      const BUCKET = 15;
      const nb = Math.ceil(L / BUCKET) + 1;
      const mk = () => ({
        n: 0, alt: {}, airToggle: 0, airN: 0, hMax: 0, hMaxOn: 0,
        kmhMin: 1e9, kmhMax: 0, slipMax: 0, understeer: 0,
        thrToggle: 0, climbN: 0, wallN: 0, liftMax: 0, rollMax: 0,
        dhMax: 0, latMin: 99, latMax: -99, curv: 0, onRoad: 0,
        dsMax: 0, dsMin: 9, surfJump: 0, dlatMax: 0,
      });
      const buckets = Array.from({ length: nb }, mk);
      const SIG = ['r', 'vy', 'h', 'steer', 'su0', 'roll', 'vx', 'lift'];

      for (let i = 2; i < rows.length; i++) {
        const a = rows[i - 2], b = rows[i - 1], c = rows[i];
        const bi = Math.min(nb - 1, Math.floor(c.s / BUCKET));
        const B = buckets[bi];
        B.n++;
        for (const k of SIG) {
          const d1 = b[k] - a[k], d2 = c[k] - b[k];
          if (d1 * d2 < 0) B.alt[k] = (B.alt[k] || 0) + 1;
        }
        if (c.air !== b.air) B.airToggle++;
        if (c.air) B.airN++;
        if (c.thr !== b.thr) B.thrToggle++;
        if (c.climb) B.climbN++;
        if (c.wall) B.wallN++;
        B.hMax = Math.max(B.hMax, c.h);
        const onRoad = Math.abs(c.lat) < c.hw;
        if (onRoad) { B.onRoad++; B.hMaxOn = Math.max(B.hMaxOn, c.h); }
        B.dhMax = Math.max(B.dhMax, Math.abs(c.h - b.h));
        B.liftMax = Math.max(B.liftMax, Math.abs(c.lift));
        B.rollMax = Math.max(B.rollMax, Math.abs(c.roll));
        B.latMin = Math.min(B.latMin, c.lat); B.latMax = Math.max(B.latMax, c.lat);
        B.dsMax = Math.max(B.dsMax, c.ds); B.dsMin = Math.min(B.dsMin, c.ds);
        B.dlatMax = Math.max(B.dlatMax, Math.abs(c.dlat));
        /* How much the ground under the car moved, beyond what travelling
           along it explains. A road is continuous; a query that is not shows
           up here and nowhere else. */
        const expect = Math.abs(c.ds) * 0.25 + Math.abs(c.dlat) * 1.2 + 0.02;
        B.surfJump = Math.max(B.surfJump, Math.abs(c.surfY - b.surfY) - expect);
        const kmh = Math.hypot(c.vx, c.vy) * 3.6;
        B.kmhMin = Math.min(B.kmhMin, kmh); B.kmhMax = Math.max(B.kmhMax, kmh);
        B.slipMax = Math.max(B.slipMax, Math.abs(Math.atan2(c.vy, Math.abs(c.vx) + 0.5)));
        B.understeer += Math.abs(c.slipF) - Math.abs(c.slipR);
      }
      for (let i = 0; i < nb; i++) {
        const f = track.frameAt(Math.min(L - 1, i * BUCKET + BUCKET / 2));
        buckets[i].curv = f.curv; buckets[i].width = f.width;
        buckets[i].bank = f.bank; buckets[i].grade = f.grade;
        buckets[i].kind = f.el?.kind || 'straight';
      }

      const list = [];
      for (let i = 0; i < nb; i++) {
        const B = buckets[i];
        if (!B.n) continue;
        const secs = B.n / 120;
        list.push({
          s: i * BUCKET, kind: B.kind,
          radius: B.curv ? +Math.abs(1 / B.curv).toFixed(0) : 0,
          bank: +(B.bank * 180 / Math.PI).toFixed(1),
          n: B.n, secs: +secs.toFixed(2),
          altR: +((B.alt.r || 0) / secs).toFixed(0),
          altVy: +((B.alt.vy || 0) / secs).toFixed(0),
          altH: +((B.alt.h || 0) / secs).toFixed(0),
          altSteer: +((B.alt.steer || 0) / secs).toFixed(0),
          altSusp: +((B.alt.su0 || 0) / secs).toFixed(0),
          altRoll: +((B.alt.roll || 0) / secs).toFixed(0),
          altLift: +((B.alt.lift || 0) / secs).toFixed(0),
          airTog: +(B.airToggle / secs).toFixed(0),
          airPct: +(B.airN / B.n * 100).toFixed(0),
          thrTog: +(B.thrToggle / secs).toFixed(0),
          climbPct: +(B.climbN / B.n * 100).toFixed(0),
          wallPct: +(B.wallN / B.n * 100).toFixed(0),
          onRoadPct: +(B.onRoad / B.n * 100).toFixed(0),
          hMax: +B.hMax.toFixed(3), hMaxOn: +B.hMaxOn.toFixed(3),
          dhMax: +B.dhMax.toFixed(3), surfJump: +B.surfJump.toFixed(3),
          dsMax: +B.dsMax.toFixed(3), dsMin: +B.dsMin.toFixed(3),
          dlatMax: +B.dlatMax.toFixed(3),
          liftMax: +B.liftMax.toFixed(3), rollMax: +(B.rollMax * 180 / Math.PI).toFixed(1),
          kmhMin: +B.kmhMin.toFixed(0), kmhMax: +B.kmhMax.toFixed(0),
          slipMax: +(B.slipMax * 180 / Math.PI).toFixed(0),
          balance: +(B.understeer / B.n * 180 / Math.PI).toFixed(1),
          latMin: +B.latMin.toFixed(1), latMax: +B.latMax.toFixed(1),
        });
      }

      const reached = Math.max(...rows.map(r => r.s));
      return {
        seed: track.seed, length: +L.toFixed(0), frames, substeps: rows.length,
        reached: +reached.toFixed(0), recover, finished: p.finished, list,
        rows: near === null ? undefined : rows
          .filter(r => Math.abs(r.s - near) < 25)
          .slice(0, dump || 400)
          .map(r => ({
            s: +r.s.toFixed(2), lat: +r.lat.toFixed(3), h: +r.h.toFixed(4),
            air: r.air, vv: +r.vv.toFixed(3), r: +(r.r * 180 / Math.PI).toFixed(2),
            vy: +r.vy.toFixed(3), vx: +r.vx.toFixed(2),
            steer: +(r.steer * 180 / Math.PI).toFixed(2), cmd: r.cmd,
            su: [r.su0, r.su1, r.su2, r.su3].map(x => +x.toFixed(3)),
            lift: +r.lift.toFixed(3), roll: +(r.roll * 180 / Math.PI).toFixed(2),
            surfY: +r.surfY.toFixed(3),
          })),
      };
    }, [DEAD, DUMP, NEAR]);

    all[seed] = out;

    console.log(`\n═══ seed ${out.seed} — ${out.length} m; keyboard reached ${out.reached} m`
      + ` in ${(out.frames / 60).toFixed(0)} s, ${out.recover} auto-recoveries, finished=${out.finished} ═══`);

    const head = '    s    kind      R   bank  | altR altVy  altH altSu altLf | airTog air% climb% wall% road% |  hMax hMaxOn  dhMax  jump | km/h     slip   bal    lat';
    const fmt = x => `  ${String(x.s).padStart(4)} ${x.kind.padEnd(8)} ${String(x.radius).padStart(5)} ${x.bank.toFixed(1).padStart(5)}  |`
      + ` ${String(x.altR).padStart(4)} ${String(x.altVy).padStart(5)} ${String(x.altH).padStart(5)} ${String(x.altSusp).padStart(5)} ${String(x.altLift).padStart(5)} |`
      + ` ${String(x.airTog).padStart(6)} ${String(x.airPct).padStart(4)} ${String(x.climbPct).padStart(6)} ${String(x.wallPct).padStart(5)} ${String(x.onRoadPct).padStart(5)} |`
      + ` ${x.hMax.toFixed(2).padStart(5)} ${x.hMaxOn.toFixed(2).padStart(6)} ${x.dhMax.toFixed(3).padStart(6)} ${x.surfJump.toFixed(2).padStart(5)} |`
      + ` ${String(x.kmhMin).padStart(3)}/${String(x.kmhMax).padStart(3)} ${String(x.slipMax).padStart(4)}° ${x.balance.toFixed(1).padStart(5)} ${x.latMin.toFixed(1).padStart(5)}/${x.latMax.toFixed(1).padStart(5)}`;

    const top = (label, key, filter = () => true) => {
      console.log(`\n  ── ${label} ──`);
      console.log(head);
      out.list.filter(filter).sort((a, b) => b[key] - a[key]).slice(0, 12).forEach(x => console.log(fmt(x)));
    };

    top('worst yaw-rate reversals per second (120 = every substep)', 'altR');
    top('worst airborne toggling per second', 'airTog');
    top('biggest lift while ON the road surface', 'hMaxOn');
    top('biggest surface-query discontinuity', 'surfJump');
    top('most body-lift reversals (visual bounce)', 'altLift');

    const med = k => {
      const v = out.list.map(x => x[k]).sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)];
    };
    console.log(`\n  medians — altR ${med('altR')}  altVy ${med('altVy')}  altH ${med('altH')}`
      + `  altSusp ${med('altSusp')}  altLift ${med('altLift')}  airTog ${med('airTog')}  hMaxOn ${med('hMaxOn')}`);
    if (out.rows) console.log(`\n  ${out.rows.length} substep rows near s=${NEAR} written to json`);
  });
}

fs.mkdirSync(path.join(ROOT, 'shots', 'turns'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'shots', 'turns', 'buzz.json'), JSON.stringify(all, null, 1));
console.log('\n  → shots/turns/buzz.json');
finish(process.exitCode || 0);
