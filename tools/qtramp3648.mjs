/* The seed-22 ramp at 3648, frame by frame, on a real lap.
 *
 * `offRoad` saturates: it is `(|lat| - hw*0.86) / (hw*0.2)` clamped to 1, so a
 * reading of 1.00 means "outside the road edge" and says nothing about by how
 * much — and the physics containment wall is only `hw + 1.05` out, so the car
 * cannot in fact be in a field. Reporting 1.00 as "it arrives from the grass"
 * overstates it. This prints the lateral offset in metres beside the flag so
 * the two can be told apart.
 *
 *   node tools/qtramp3648.mjs [--seed 22] [--skill 0.75] [--from 3500] [--to 3800]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = Number(flag('seed', '22'));
const SKILL = Number(flag('skill', '0.75'));
const FROM = Number(flag('from', '3100'));
const TO = Number(flag('to', '3900'));

await run({ width: 320, height: 200, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0` },
  async ({ page }) => {
    const r = await page.evaluate(([skill, from, to]) => {
      const g = window.__game, t = g.track, p = g.player;
      g.restart(); g.resetSimClock(); g.setPaused(true);
      g.autopilot(true, skill);
      g.countdown.skip(); g.ending.skip();
      const rows = [];
      const all = [];
      let launches = [];
      let lastId = p.launchId;
      for (let i = 0; i < 300 * 60 && p.s < to + 60; i++) {
        g.step(1 / 60);
        all.push({ f: i, s: p.s, off: p.offRoad });
        if (p.launchId !== lastId) {
          lastId = p.launchId;
          launches.push({ s: +p.s.toFixed(1), speed: +p.launchSpeed.toFixed(1), lip: p.launched?.lip });
        }
        if (p.s < from) continue;
        const hw = t.frameAt(p.s).width * 0.5;
        rows.push({
          s: +p.s.toFixed(1), lat: +p.lat.toFixed(2), hw: +hw.toFixed(2),
          over: +(Math.abs(p.lat) - hw).toFixed(2),
          off: +p.offRoad.toFixed(2), air: p.airborne ? 1 : 0,
          h: +p.height.toFixed(2), kmh: +(Math.hypot(p.vx, p.vy) * 3.6).toFixed(0),
        });
      }
      /* Curvature and width through the section, which is what a driver has to
         cope with and what the siting scan scored. */
      const geo = [];
      for (let s = from - 200; s <= to; s += 20) {
        const f = t.frameAt(s);
        geo.push({ s, curv: +f.curv.toFixed(5), R: Math.abs(f.curv) > 1e-4 ? Math.round(1 / Math.abs(f.curv)) : 9999,
          w: +f.width.toFixed(1), grade: +f.grade.toFixed(3), bank: +(f.bank * 180 / Math.PI).toFixed(1) });
      }
      /* The same excursion arithmetic tools/qtoff.mjs runs, on the same trace,
         so the two probes cannot disagree about a lap they both drove. */
      const runs = [];
      let cur = null;
      for (const r of all) {
        if (r.off >= 0.99) { if (!cur) cur = { i0: r.f, s0: r.s, i1: r.f, s1: r.s }; else { cur.i1 = r.f; cur.s1 = r.s; } }
        else if (cur) { if (cur.i1 - cur.i0 >= 15) runs.push({ s0: +cur.s0.toFixed(0), s1: +cur.s1.toFixed(0), sec: +((cur.i1 - cur.i0) / 60).toFixed(1) }); cur = null; }
      }
      return { seed: t.seed, ramps: t.ramps.map(x => ({ lip: x.lip, pad0: x.pad0, land: x.land })), rows, geo, launches, runs };
    }, [SKILL, FROM, TO]);

    console.log(`\n─── seed ${r.seed} skill ${SKILL}   ramps ${r.ramps.map(x => x.lip).join('/')}`);
    console.log('  launches this run: ' + (r.launches.length
      ? r.launches.map(l => `lip ${l.lip} at s=${l.s} ${l.speed} m/s`).join('; ') : 'none'));

    console.log('  off-road excursions up to this point (same arithmetic as qtoff.mjs):');
    for (const e of r.runs.filter(x => x.s1 - x.s0 > 25)) {
      console.log(`     s ${String(e.s0).padStart(4)} → ${String(e.s1).padStart(4)}  ${String(e.s1 - e.s0).padStart(4)} m  ${e.sec} s`);
    }

    console.log('\n  road through the section (R = radius, m)');
    console.log('   station  radius  width  grade   bank');
    for (const gg of r.geo) {
      console.log(`  ${String(gg.s).padStart(7)}  ${String(gg.R).padStart(6)}  ${String(gg.w).padStart(5)}`
        + `  ${String(gg.grade).padStart(6)}  ${String(gg.bank).padStart(5)}`);
    }

    console.log('\n  car, every 10th frame  (over = metres of |lat| beyond the road edge;'
      + ' the containment wall is +1.05)');
    console.log('   station    lat     hw    over   offRoad  air   h    km/h');
    for (let i = 0; i < r.rows.length; i += 10) {
      const x = r.rows[i];
      console.log(`  ${String(x.s).padStart(7)}  ${String(x.lat).padStart(6)} ${String(x.hw).padStart(6)}`
        + `  ${String(x.over).padStart(6)}   ${String(x.off).padStart(5)}   ${x.air ? 'AIR' : '   '}`
        + `  ${String(x.h).padStart(5)} ${String(x.kmh).padStart(5)}`);
    }
    const over = r.rows.filter(x => x.off >= 0.99).map(x => x.over);
    if (over.length) {
      over.sort((a, b) => a - b);
      console.log(`\n  while offRoad == 1.00: |lat| beyond the road edge`
        + `  min ${over[0].toFixed(2)}  median ${over[Math.floor(over.length / 2)].toFixed(2)}`
        + `  max ${over[over.length - 1].toFixed(2)} m`);
    }
  });

finish(process.exitCode || 0);
