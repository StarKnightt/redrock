/* Where does a race car stop making progress, and what is holding it?
 *
 * A DNF in tools/race.mjs says only that a car did not reach the finish. This
 * says where it stopped and what it was touching at the time — the wall, the
 * berm, a rival, or nothing at all.
 *
 *   node tools/stall.mjs [--seed 2] [--skill 0.85] [--secs 420]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', 2);
const SKILL = +flag('skill', 0.85);
const SECS = +flag('secs', 420);

await run({ width: 640, height: 360, hash: 'manual' }, async ({ page }) => {
  const out = await page.evaluate(async ([seed, skill, secs]) => {
    const { Race } = await import('/src/race/index.js');
    const g = window.__game;
    const p = g.player;
    /* Set up exactly as tools/race.mjs does, or the field lines up differently
       and the run diverges from the one being explained. */
    g.setPaused(true);
    if (g.race) g.race.dispose();
    const race = new Race(g.track, g.scene, { seed });
    g.race = race;
    g.botInput = { steer: 0, throttle: 0, brake: 1, handbrake: 0 };
    g.step(1 / 60);
    const wired = race._clock > 0;
    race.reset();
    g.botInput = null;
    g.autopilot(true, skill);
    g.bot.wobble = 5;
    g.bot.boost = 1;
    p.placeAt(34, 0); p.vx = 0; p.vy = 0; p.r = 0;
    p.raceTime = 0; p.finished = false;
    p.rpm = 1050; p.gear = 0;

    const rows = [];
    let recoveries = 0;
    for (let i = 0; i < secs * 60; i++) {
      g.step(1 / 60);
      if (p.strandedFor > 2.5) { p.recover(); recoveries++; }
      if (!wired) race.step(1 / 60, p);
      if (i % 30) continue;
      let near = null;
      for (const e of g.race.entries) {
        const ds = e.car.s - p.s, dl = e.car.lat - p.lat;
        if (!near || Math.abs(ds) < Math.abs(near.ds)) near = { ds, dl };
      }
      rows.push({
        t: +(i / 60).toFixed(1), s: +p.s.toFixed(0), kmh: +p.kmh.toFixed(0),
        lat: +p.lat.toFixed(1), hw: +(g.track.frameAt(p.s).width / 2).toFixed(1),
        air: p.airborne ? 1 : 0, h: +p.height.toFixed(2),
        wall: p._contact ? 1 : 0, climb: p._climbing ? 1 : 0,
        stranded: +p.strandedFor.toFixed(1),
        slip: +(p.slipAngle * 180 / Math.PI).toFixed(0),
        nds: near ? +near.ds.toFixed(1) : 99, ndl: near ? +near.dl.toFixed(1) : 99,
      });
      if (p.finished) break;
    }

    /* The stall: the longest stretch where the car advanced least. */
    let worst = null;
    for (let i = 0; i + 20 < rows.length; i++) {
      const adv = rows[i + 20].s - rows[i].s;   // 10 s of progress
      if (!worst || adv < worst.adv) worst = { adv: +adv.toFixed(0), i, t: rows[i].t, s: rows[i].s };
    }
    return {
      seed, finished: p.finished, recoveries,
      endS: +p.s.toFixed(0), endT: +p.raceTime.toFixed(1),
      worst, rows,
    };
  }, [SEED, SKILL, SECS]);

  console.log(`\n  seed ${out.seed}: finished=${out.finished}, ended at ${out.endS} m, ${out.recoveries} recoveries`);
  console.log(`  worst 10 s of progress: ${out.worst.adv} m, starting t=${out.worst.t}s at s=${out.worst.s} m\n`);
  const from = Math.max(0, out.worst.i - 4);
  console.log('      t      s   km/h    lat/hw   air     h  wall climb  stranded  slip   rival ds/dlat');
  for (const r of out.rows.slice(from, from + 40)) {
    console.log(`  ${String(r.t).padStart(5)} ${String(r.s).padStart(6)} ${String(r.kmh).padStart(6)}`
      + `  ${r.lat.toFixed(1).padStart(5)}/${r.hw.toFixed(1).padStart(4)}  ${r.air}  ${r.h.toFixed(2).padStart(5)}`
      + `     ${r.wall}     ${r.climb}     ${r.stranded.toFixed(1).padStart(5)}  ${String(r.slip).padStart(4)}`
      + `   ${String(r.nds).padStart(6)} ${String(r.ndl).padStart(6)}`);
  }
});

finish(process.exitCode || 0);
