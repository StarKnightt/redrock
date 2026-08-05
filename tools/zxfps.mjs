/* Frame-rate independence of the two things this round changed.
 *
 * The steering fix proved itself at 30/60/144 through `steerprobe.mjs`, but
 * that instrument watches the steering filter and nothing else. What changed
 * here is the friction circle — which now reads the brake force and the axle
 * loads rather than the net longitudinal force — and the airborne yaw, which is
 * now a first-order alignment onto the flight path instead of an integration of
 * the road-wheel angle. Both are state that evolves inside the substep, so both
 * have to be shown to be blind to how often the page hands work to the
 * accumulator.
 *
 * Physics runs at a fixed 120 Hz. At 1/30 and 1/60 the frame divides evenly
 * into four substeps and two; at 1/144 and 1/200 it does not, so the count per
 * frame alternates and bit-identity is not on offer. Closeness is, and
 * closeness is the whole question: the same manoeuvre from the same place has
 * to end in the same place.
 *
 * Both manoeuvres start from a placed car rather than a driven one, which is
 * normally the wrong way round — but here the approach is not the measurement
 * and driving it four times over is the difference between a probe that runs in
 * seconds and one that does not run at all. What matters is that all four frame
 * rates start from a bit-identical state, and `placeAt` gives that.
 *
 *   BRAKE AND TURN. Placed on the road at speed, then a fixed pedal and a fixed
 *     lock held for two seconds. This is the grounded branch and the new
 *     load-following brake split.
 *
 *   THROWN INTO THE AIR. Placed at the same station with an upward velocity and
 *     full lock held, so the car flies, aligns, and lands. This is the airborne
 *     branch and the new alignment onto the flight path.
 *
 *   node tools/zxfps.mjs [--seeds 22]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22').split(',').map(Number);
const RATES = [30, 60, 144, 200];

const PROBE = () => {
  const g = window.__game;
  const p = g.player;
  const t = g.track;
  const DEG = 180 / Math.PI;
  g.freeCam = true;
  g.setPaused(true);
  g.restart();
  g.countdown.skip(); g.ending.skip();
  g.autopilot(false);
  const res = { seed: t.seed, brake: [], air: [] };

  /* The tightest corner past the first few hundred metres, so a held lock and a
     held pedal are actually asking the car for something. */
  let bestS = 0, best = 0;
  for (let i = 0; i < t.count; i++) {
    const f = t.frames[i];
    if (f.s > 400 && Math.abs(f.curv) > best) { best = Math.abs(f.curv); bestS = f.s; }
  }
  res.station = +bestS.toFixed(0);
  res.grade = +(t.frameAt(bestS).grade * 100).toFixed(1);

  for (const hz of [30, 60, 144, 200]) {
    const dt = 1 / hz;

    /* ---- brake and turn, on the road ---- */
    p.placeAt(bestS, 0);
    p.vx = 30; p.vy = 0; p.r = 0;
    for (let el = 0; el < 2.0 - 1e-9; el += dt) {
      g.botInput = { steer: 1, throttle: 0, brake: 0.45, handbrake: 0 };
      g.step(dt);
    }
    res.brake.push({
      hz,
      kmh: +p.kmh.toFixed(3),
      s: +p.s.toFixed(3),
      lat: +p.lat.toFixed(4),
      slipDeg: +(Math.atan2(p.vy, Math.abs(p.vx) + 0.5) * DEG).toFixed(3),
      yawRate: +(p.r * DEG).toFixed(3),
      circF: +(p._circleF ?? 0).toFixed(4),
      circR: +(p._circleR ?? 0).toFixed(4),
    });

    /* ---- thrown into the air, wheel held ---- */
    p.placeAt(bestS, 0);
    p.vx = 44; p.vy = 0; p.r = 0;
    /* Straight up hard enough for a flight of about a second and a half, which
       is inside the shortest the ramps on this stage give. */
    p.pos.y += 0.6;
    if ('vv' in p) p.vv = 7.5; else if ('vUp' in p) p.vUp = 7.5;
    let air = 0, armed = false, landed = false, after = 0;
    let slipAtLand = 0, latAtLand = 0, sAtLand = 0, rAtLand = 0;
    for (let el = 0; el < 6.0 && after < 0.75; el += dt) {
      g.botInput = { steer: 1, throttle: 0, brake: 0, handbrake: 0 };
      g.step(dt);
      if (p.airborne) { armed = true; air += dt; }
      else if (armed && !landed) {
        landed = true;
        slipAtLand = Math.atan2(p.vy, Math.abs(p.vx) + 0.5) * DEG;
        latAtLand = p.lat; sAtLand = p.s; rAtLand = p.r * DEG;
      }
      if (landed) after += dt;
    }
    res.air.push({
      hz,
      airS: +air.toFixed(3),
      flew: armed && landed,
      sAtLand: +sAtLand.toFixed(3),
      latAtLand: +latAtLand.toFixed(4),
      slipAtLandDeg: +slipAtLand.toFixed(3),
      yawAtLand: +rAtLand.toFixed(3),
      slipAfterDeg: +(Math.atan2(p.vy, Math.abs(p.vx) + 0.5) * DEG).toFixed(3),
      /* The settled state, three quarters of a second past touchdown.
         Everything sampled ON the touchdown frame is sampled up to a frame late
         — a whole 33 ms at 30 fps — and the car is travelling 44 m/s through
         the one transient in the manoeuvre where the tyres are biting and yaw
         is changing fastest. That makes those columns a measure of when the
         probe looked, not of what the physics did. `s@land` spreads 1.2 m,
         which at this speed IS one 30 fps frame, so the two are the same
         number. Once the transient is over the sampling instant stops
         mattering and the comparison is about the model again. */
      yawAfter: +(p.r * DEG).toFixed(3),
      latAfter: +p.lat.toFixed(4),
    });
  }

  g.setPaused(false);
  return res;
};

const span = (rows, key) => {
  const v = rows.map(r => r[key]).filter(x => Number.isFinite(x));
  if (!v.length) return 0;
  return Math.max(...v) - Math.min(...v);
};

for (const seed of SEEDS) {
  await run({
    width: 480, height: 270, timeout: 300_000,
    hash: `manual&tier=low&seed=${seed}&cap=0&hud=0`,
  }, async ({ page }) => {
    const r = await page.evaluate(PROBE);

    console.log(`\n═══ seed ${r.seed} — station ${r.station} m, grade ${r.grade}% ═══`);

    const table = (rows, cols, title, note) => {
      console.log(`\n  ${title}`);
      if (note) console.log(`    ${note}`);
      console.log('    ' + 'fps'.padStart(5) + cols.map(c => c[0].padStart(11)).join(''));
      for (const row of rows) {
        console.log('    ' + String(row.hz).padStart(5)
          + cols.map(c => String(row[c[1]]).padStart(11)).join(''));
      }
      console.log('    ' + 'span'.padStart(5)
        + cols.map(c => span(rows, c[1]).toFixed(3).padStart(11)).join(''));
    };

    table(r.brake, [
      ['km/h', 'kmh'], ['s', 's'], ['lat', 'lat'], ['slip°', 'slipDeg'],
      ['yaw°/s', 'yawRate'], ['circF', 'circF'], ['circR', 'circR'],
    ], 'BRAKE AND TURN — 0.45 pedal, full lock, 2 s from 108 km/h',
      'the grounded branch: the new load-following brake split');

    table(r.air, [
      ['air s', 'airS'], ['s@land', 'sAtLand'], ['lat@land', 'latAtLand'],
      ['slip@land', 'slipAtLandDeg'], ['yaw@land', 'yawAtLand'],
      ['slip +.75', 'slipAfterDeg'], ['yaw +.75', 'yawAfter'], ['lat +.75', 'latAfter'],
    ], 'THROWN UP, WHEEL HELD — full lock across the flight and 0.75 s past it',
      'the airborne branch: the new alignment onto the flight path');

    /* A verdict, so this does not have to be read to be used. The tolerances
       are what a driver could not tell apart across a frame-rate change. */
    const checks = [
      ['brake speed', span(r.brake, 'kmh'), 0.5, ' km/h'],
      ['brake line', span(r.brake, 'lat'), 0.05, ' m'],
      ['brake slip', span(r.brake, 'slipDeg'), 0.5, '°'],
      ['brake front circle', span(r.brake, 'circF'), 0.02, ''],
      ['brake rear circle', span(r.brake, 'circR'), 0.02, ''],
      ['air time', span(r.air, 'airS'), 0.05, ' s'],
      ['slip at landing', span(r.air, 'slipAtLandDeg'), 0.5, '°'],
      ['slip once settled', span(r.air, 'slipAfterDeg'), 0.5, '°'],
      ['yaw once settled', span(r.air, 'yawAfter'), 1.5, '°/s'],
      ['line once settled', span(r.air, 'latAfter'), 0.30, ' m'],
    ];
    console.log('');
    let bad = 0;
    for (const [name, s, tol, unit] of checks) {
      const ok = s <= tol;
      if (!ok) bad++;
      console.log(`    ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(20)}`
        + `spread ${s.toFixed(3)}${unit} across 30–200 fps (allowed ${tol}${unit})`);
    }
    if (!r.air.every(a => a.flew)) console.log('    note: not every rate flew');
    console.log(`\n  ${bad ? `${bad} quantity(s) DEPEND on frame rate` : 'PASS — frame-rate independent'}`);
  });
}

finish(process.exitCode || 0);
