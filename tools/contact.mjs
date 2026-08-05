/* How much of a race does the player spend with no tyres?
 *
 * Car.step gives the car no lateral or longitudinal force at all while
 * `airborne` is set — the whole tyre block and the whole engine block sit
 * inside `if (grounded)`. So a substep spent airborne is a substep with no
 * grip, no drive and no brakes, and if that happens while the car is on the
 * road it is not a jump, it is a fault.
 *
 * This counts them, separates the ones that follow an external displacement of
 * the car (a rival shoving it across the road) from the ones that follow the
 * car simply driving over something, and ranks the stage by where they happen.
 *
 * Run before and after a change to physics.js; the numbers to watch are
 * "airborne while on the road" and "contact toggles per second".
 *
 *   node tools/contact.mjs [--seeds 22,7,101] [--secs 120] [--rivals 1]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,7,101').split(',').map(Number);
const SECS = +flag('secs', 120);
const RIVALS = flag('rivals', '1') !== '0';

const all = {};

for (const seed of SEEDS) {
  await run({
    width: 640, height: 360,
    hash: `manual&tier=low&seed=${seed}&cap=0&hud=0`,
  }, async ({ page }) => {
    const out = await page.evaluate(([secs, rivals]) => {
      const g = window.__game;
      const p = g.player;
      const track = g.track;
      const L = track.length;
      const Car = p.constructor;
      const rawStep = Car.prototype.step;

      if (!rivals && g.race?.entries) g.race.entries.length = 0;

      const rows = [];
      let capture = false;
      let exitS = null, exitLat = null;
      Car.prototype.step = function (dt, input) {
        const entryS = this.s, entryLat = this.lat, wasAir = this.airborne;
        rawStep.call(this, dt, input);
        if (capture !== this) return;
        /* Displacement applied to the car by something other than its own
           velocity: the previous substep left it at (exitS, exitLat) and it
           started this one somewhere else. */
        const shoveLat = exitLat === null ? 0 : entryLat - exitLat;
        const shoveS = exitS === null ? 0 : entryS - exitS;
        exitS = this.s; exitLat = this.lat;
        const hw = track.frameAt(this.s).width * 0.5;
        rows.push({
          s: this.s, lat: this.lat, onRoad: Math.abs(this.lat) < hw,
          air: this.airborne, wasAir, h: this.height,
          shoveLat, shoveS, kmh: this.kmh,
          slipF: this._slipF || 0, slipR: this._slipR || 0,
        });
      };

      g.setPaused(true);
      g.autopilot(true, 1.0);
      g.bot.wobble = 5;              // Driver seeds this from Math.random; pin it
      g.goTo(0.0015);
      const bot = g.bot;
      capture = p;
      let recover = 0;
      for (let i = 0; i < 60 * secs && !p.finished; i++) {
        const c = bot.drive(p, 1 / 60);
        g.botInput = {
          steer: c.steer > 0.15 ? 1 : c.steer < -0.15 ? -1 : 0,
          throttle: c.throttle > 0.3 ? 1 : 0,
          brake: c.brake > 0.25 ? 1 : 0,
          handbrake: c.handbrake,
        };
        g.step(1 / 60);
        if (p.strandedFor > 4) { p.recover(); recover++; exitS = p.s; exitLat = p.lat; }
      }
      capture = false;
      g.botInput = null;
      g.autopilot(false);
      Car.prototype.step = rawStep;

      const SHOVE = 0.01;     // metres of lateral displacement that count as external
      let onRoad = 0, airOnRoad = 0, toggles = 0, onsets = 0, onsetsAfterShove = 0;
      let shoves = 0, shoveMax = 0, airTimeOnRoad = 0, hMaxOnRoad = 0;
      /* Jumps have to survive the fix, so they are counted separately: an
         episode of air that got more than 15 cm off the ground is a jump, not
         a contact glitch, and the count and the height of them should not
         move. */
      let jumps = 0, jumpAir = 0, jumpPeak = 0, airAll = 0, epPeak = 0, epLen = 0;
      const BUCKET = 20;
      const nb = Math.ceil(L / BUCKET) + 1;
      const bk = Array.from({ length: nb }, () => ({ n: 0, air: 0, tog: 0, shove: 0, h: 0, onRoad: 0, kmh: 0 }));
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i], q = rows[i - 1];
        const B = bk[Math.min(nb - 1, Math.floor(r.s / BUCKET))];
        B.n++;
        if (Math.abs(r.shoveLat) > SHOVE) { shoves++; B.shove++; shoveMax = Math.max(shoveMax, Math.abs(r.shoveLat)); }
        if (r.onRoad) {
          onRoad++; B.onRoad++;
          if (r.air) { airOnRoad++; airTimeOnRoad += 1 / 120; B.air++; hMaxOnRoad = Math.max(hMaxOnRoad, r.h); B.h = Math.max(B.h, r.h); }
          if (r.air !== q.air) { toggles++; B.tog++; }
          if (r.air && !q.air) {
            onsets++;
            if (Math.abs(r.shoveLat) > SHOVE) onsetsAfterShove++;
          }
        }
        B.kmh = Math.max(B.kmh, r.kmh);
        if (r.air) { airAll++; epPeak = Math.max(epPeak, r.h); epLen++; }
        else if (epLen) {
          if (epPeak > 0.15) { jumps++; jumpAir += epLen / 120; jumpPeak = Math.max(jumpPeak, epPeak); }
          epPeak = 0; epLen = 0;
        }
      }

      const list = [];
      for (let i = 0; i < nb; i++) {
        const B = bk[i];
        if (!B.n) continue;
        const f = track.frameAt(Math.min(L - 1, i * BUCKET + BUCKET / 2));
        list.push({
          s: i * BUCKET, n: B.n,
          radius: f.curv ? +Math.abs(1 / f.curv).toFixed(0) : 0,
          bank: +(f.bank * 180 / Math.PI).toFixed(1),
          width: +f.width.toFixed(1),
          airPct: +(B.air / B.n * 100).toFixed(0),
          togPerSec: +(B.tog / (B.n / 120)).toFixed(1),
          shovePerSec: +(B.shove / (B.n / 120)).toFixed(1),
          hMax: +B.h.toFixed(3), kmh: +B.kmh.toFixed(0),
        });
      }

      return {
        seed: track.seed, reached: +Math.max(...rows.map(r => r.s)).toFixed(0),
        finished: p.finished, recover, substeps: rows.length,
        onRoad, airOnRoad,
        airPctOnRoad: +(airOnRoad / Math.max(1, onRoad) * 100).toFixed(1),
        airTimeOnRoad: +airTimeOnRoad.toFixed(2),
        secs: +(rows.length / 120).toFixed(1),
        toggles, togPerSec: +(toggles / (rows.length / 120)).toFixed(2),
        onsets, onsetsAfterShove,
        shoves, shoveMax: +shoveMax.toFixed(3),
        hMaxOnRoad: +hMaxOnRoad.toFixed(3),
        jumps, jumpAir: +jumpAir.toFixed(2), jumpPeak: +jumpPeak.toFixed(2),
        airAll, airAllPct: +(airAll / rows.length * 100).toFixed(1),
        worst: list.filter(x => x.airPct > 0).sort((a, b) => b.airPct - a.airPct).slice(0, 15),
      };
    }, [SECS, RIVALS]);

    all[seed] = out;
    console.log(`\n═══ seed ${out.seed} — ${out.secs}s driven, reached ${out.reached} m, ${out.recover} recoveries ═══`);
    console.log(`  substeps on the road            ${out.onRoad}`);
    console.log(`  of those, AIRBORNE              ${out.airOnRoad}  (${out.airPctOnRoad}% — ${out.airTimeOnRoad}s with no tyres, no drive, no brakes)`);
    console.log(`  contact toggles                 ${out.toggles}  (${out.togPerSec}/s)`);
    console.log(`  airborne onsets on the road     ${out.onsets}, of which ${out.onsetsAfterShove} on the substep after an external shove`
      + `  (${(out.onsetsAfterShove / Math.max(1, out.onsets) * 100).toFixed(0)}%)`);
    console.log(`  external lateral shoves         ${out.shoves}, biggest ${out.shoveMax} m`);
    console.log(`  biggest on-road lift            ${out.hMaxOnRoad} m`);
    console.log(`  real jumps (peak over 15 cm)    ${out.jumps}, ${out.jumpAir}s of air, highest ${out.jumpPeak} m`
      + `   [all air, on and off road: ${out.airAllPct}%]`);
    if (out.worst.length) {
      console.log('\n  worst stations');
      console.log('       s      R   bank  width   air%  toggles/s  shoves/s   hMax   km/h');
      for (const x of out.worst) {
        console.log(`  ${String(x.s).padStart(6)} ${String(x.radius).padStart(6)} ${x.bank.toFixed(1).padStart(6)} ${x.width.toFixed(1).padStart(6)}`
          + `  ${String(x.airPct).padStart(5)} ${x.togPerSec.toFixed(1).padStart(10)} ${x.shovePerSec.toFixed(1).padStart(9)}`
          + ` ${x.hMax.toFixed(3).padStart(6)} ${String(x.kmh).padStart(6)}`);
      }
    }
  });
}

const tot = Object.values(all);
if (tot.length > 1) {
  const sum = k => tot.reduce((a, x) => a + x[k], 0);
  console.log(`\n═══ all seeds ═══`);
  console.log(`  airborne while on the road: ${(sum('airOnRoad') / sum('onRoad') * 100).toFixed(1)}%`
    + `  (${sum('airTimeOnRoad').toFixed(1)}s of ${(sum('onRoad') / 120).toFixed(0)}s)`);
  console.log(`  onsets ${sum('onsets')}, after a shove ${sum('onsetsAfterShove')}`
    + ` (${(sum('onsetsAfterShove') / Math.max(1, sum('onsets')) * 100).toFixed(0)}%)`);
}

fs.mkdirSync(path.join(ROOT, 'shots', 'turns'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'shots', 'turns', 'contact.json'), JSON.stringify(all, null, 1));
console.log('\n  → shots/turns/contact.json');
finish(process.exitCode || 0);
