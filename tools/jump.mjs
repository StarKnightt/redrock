/* Can the car still leave the ground on purpose?
 *
 * The contact fix in physics.js gives the car a little droop travel so that a
 * road falling away slowly does not count as a jump. The thing that must not
 * change is a road falling away quickly: running up a berm and dropping off
 * the inside of it is how this stage launches a car, and if the droop
 * swallowed that too the fix would have traded one bug for a worse one.
 *
 * Drives a deliberate berm launch at a spread of stations and speeds and
 * reports the air, then drops the car in from a set of heights to show where
 * the contact threshold sits: below the droop travel a gap is absorbed, above
 * it the car flies.
 *
 * The ramp section is the other half: every sited ramp on the seed, driven
 * into flat out, reporting the speed at the lip, the air, the distance, the
 * apex and where the car ended up. A ramp landing that ends in a strand is a
 * failure — the recovery is a five-second penalty and it would show up in the
 * race balance as the boost pad's fault.
 *
 *   node tools/jump.mjs [--seed 22] [--seeds all] [--ramps]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

/* The fourteen shipped stages, as everywhere else. */
const ALL = [22, 1, 7, 12, 14, 16, 20, 23, 26, 27, 28, 34, 36, 40];

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const RAMPS_ONLY = args.includes('--ramps');
const NO_KICK = args.includes('--nokick');
const seedArg = flag('seeds', null);
const SEED_LIST = seedArg === 'all' ? ALL
  : seedArg ? seedArg.split(',').map(Number) : [+flag('seed', 22)];

const strands = [];
const rampRows = [];

for (const SEED of SEED_LIST) {
await run({
  width: 640, height: 360,
  hash: `manual&tier=low&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  const out = await page.evaluate(([rampsOnly, noKick]) => {

    const g = window.__game;
    const p = g.player;
    const track = g.track;
    const L = track.length;
    g.setPaused(true);
    if (g.race?.entries) g.race.entries.length = 0;

    /* Stations with a berm worth hitting, spread down the stage. */
    const spots = [];
    for (let s = 200; s < L - 200; s += 40) {
      const f = track.frameAt(s);
      spots.push({ s, berm: Math.max(f.bermL, f.bermR), side: f.bermR >= f.bermL ? 1 : -1 });
    }
    spots.sort((a, b) => b.berm - a.berm);
    const picks = spots.slice(0, 10);

    /* The ramps. Approach from well before the pad so the car arrives at the
       lip at the speed the race would bring it, and hold the line straight —
       what is being measured is the ramp, not the driving. */
    const ramps = [];
    /* The control. Suppressing only the lip crossing leaves the ramp mesh and
       the physics surface exactly as they are and takes away nothing but the
       impulse, so a strand that survives it was never the jump's. */
    if (noKick) {
      track.rampCrossed = () => null;
      track.padCrossed = () => null;
      track.boostWindow = () => false;
    }
    g.autopilot(true, 0.85);
    for (const r of track.ramps) {
      /* Driven in by the AI, not by a held throttle. The approach is 260 m of
         real stage and a car with the wheel straight through it arrives at
         the lip 60 km/h slow, sideways, or on the berm — which measures the
         run-up rather than the ramp. */
      g.driveTo(r.pad0 / L, { runUp: 300, maxSec: 40 });
      const padSpeed = p.kmh;
      let lipSpeed = 0, air = 0, simAir = 0, apex = 0, liftAt = 0, landAt = 0, hitPad = 0;
      let wasAir = false, landing = 0, worstYaw = 0;
      for (let i = 0; i < 60 * 6; i++) {
        const before = p.s;
        g.step(1 / 60);
        if (p.boostTimer > 0) hitPad = 1;
        if (before < r.lip && p.s >= r.lip) lipSpeed = p.kmh;
        if (p.airborne && !wasAir && p.s > r.lip - 4) { wasAir = true; liftAt = p.s; }
        if (wasAir && p.airborne) {
          /* Two clocks, and they differ by nearly a factor of two. `air` is
             how long the moment lasts on screen; `simAir` is how long the car
             was actually off the ground, which is what the ballistics say and
             what the distance is consistent with. Slow motion is the gap. */
          air += 1 / 60;
          simAir = p.airTime;
          apex = Math.max(apex, p.height);
          worstYaw = Math.max(worstYaw, Math.abs(p.r));
        }
        if (wasAir && !p.airborne && !landAt) {
          landAt = p.s;
          landing = p.landingForce;
        }
        if (landAt && p.s > landAt + 140) break;
      }
      /* And then leave it alone for two and a half seconds. A landing that
         spins the car does not show up as a landing, it shows up as a car
         still pointing the wrong way afterwards. The window is short on
         purpose: six seconds is 250 m and most of a hairpin, and anything
         that goes wrong out there is the bot's driving, not the ramp. */
      let stranded = 0, offRoad = 0, why = null;
      for (let i = 0; i < 60 * 2.5; i++) {
        g.step(1 / 60);
        if (p.strandedFor > 0 && !why) {
          const fr = track.frameAt(p.s);
          why = {
            at: +(i / 60).toFixed(2), s: +p.s.toFixed(0),
            past: +(p.s - (landAt || r.lip)).toFixed(0),
            facing: +p.forward.dot(fr.tan).toFixed(2),
            kmh: +p.kmh.toFixed(0), lat: +p.lat.toFixed(1),
            hw: +(fr.width / 2).toFixed(1), slip: +p.slipAngle.toFixed(2),
          };
        }
        stranded = Math.max(stranded, p.strandedFor);
        offRoad = Math.max(offRoad, p.offRoad);
      }
      ramps.push({
        lip: r.lip, hitPad,
        padKmh: +padSpeed.toFixed(0), lipKmh: +lipSpeed.toFixed(0),
        air: +air.toFixed(2), simAir: +simAir.toFixed(2), apex: +apex.toFixed(2),
        dist: +(landAt - liftAt).toFixed(1), land: +landAt.toFixed(0),
        landing: +landing.toFixed(2), yaw: +worstYaw.toFixed(2),
        stranded: +stranded.toFixed(1), offRoad: +offRoad.toFixed(2), why,
      });
    }
    g.autopilot(false);
    if (rampsOnly) return { seed: track.seed, ramps, trials: [], ballistic: [] };

    const trials = [];
    for (const spot of picks) {
      for (const kmh of [90, 150]) {
        g.goTo(Math.max(20, spot.s - 130) / L);
        g.botInput = { steer: 0, throttle: 1, brake: 0, handbrake: 0 };
        let guard = 0;
        while (p.kmh < kmh && guard++ < 60 * 30) g.step(1 / 60);
        if (guard >= 60 * 30) continue;
        // Out onto the berm, then hard back in — the classic launch.
        let maxH = 0, air = 0, landing = 0, maxLat = 0, kmh0 = p.kmh;
        for (let i = 0; i < 150; i++) {
          const t = i / 60;
          g.botInput = {
            steer: t < 0.75 ? spot.side : -spot.side,
            throttle: 0.8, brake: 0, handbrake: 0,
          };
          g.step(1 / 60);
          maxH = Math.max(maxH, p.height);
          if (p.airborne) air++;
          landing = Math.max(landing, p.landingForce);
          maxLat = Math.max(maxLat, Math.abs(p.lat));
        }
        g.botInput = null;
        trials.push({
          s: spot.s, berm: +spot.berm.toFixed(2), kmh: +kmh0.toFixed(0),
          maxH: +maxH.toFixed(3), airFrames: air, airSec: +(air / 60).toFixed(2),
          landing: +landing.toFixed(2), maxLat: +maxLat.toFixed(1),
        });
      }
    }
    /* And a direct check that the airborne path still exists at all: drop the
       car in from a height and confirm it flies, falls and lands. The berm
       launches above are the game's own jumps; this is the mechanism. */
    const ballistic = [];
    for (const h0 of [0.04, 0.06, 0.12, 0.4, 1.2]) {
      g.goTo(0.3);
      g.botInput = { steer: 0, throttle: 1, brake: 0, handbrake: 0 };
      for (let i = 0; i < 180 && p.kmh < 120; i++) g.step(1 / 60);
      /* Lift the car itself, not its height field: the height is measured
         back off the position every substep, so setting it directly is
         overwritten before anything reads it. */
      p.pos.addScaledVector(track.frameAt(p.s).up, h0);
      p.vertVel = 0;
      /* Coast, and only watch the fall itself. Six centimetres is back on the
         ground in a ninth of a second; keep the throttle on for a second and a
         half more and the car simply drives off the next crest, which lands in
         the same counters and makes every row read as a jump. */
      g.botInput = { steer: 0, throttle: 0, brake: 0, handbrake: 0 };
      let air = 0, maxH = 0, landing = 0, air0 = 0;
      for (let i = 0; i < 24; i++) {
        g.step(1 / 60);
        if (p.airborne) { air++; if (i < 2) air0 = 1; }
        maxH = Math.max(maxH, p.height);
        landing = Math.max(landing, p.landingForce);
      }
      g.botInput = null;
      ballistic.push({ h0, air, air0, maxH: +maxH.toFixed(3), landing: +landing.toFixed(3) });
    }
    return { seed: track.seed, trials, ballistic, ramps };
  }, [RAMPS_ONLY, NO_KICK]);

  console.log(`\n  seed ${out.seed}  `);
  console.log('  ramps —  lip   pad   at lip    air    apex    dist  landing   yaw  stranded  land');
  for (const r of out.ramps) {
    /* A landing that ends in a strand is a strand at the landing. The bot
       also spins in ordinary corners at a background rate — measurable with
       --nokick, which turns the whole mechanic off and leaves the same rate
       behind — and a spin 200 m down the road in the next hairpin is that,
       not the jump. Sixty metres is under two seconds of runout. */
    const bad = r.stranded > 0 && r.why && r.why.past <= 60;
    if (bad) strands.push({ seed: out.seed, lip: r.lip, stranded: r.stranded, why: r.why });
    rampRows.push({ seed: out.seed, ...r });
    console.log(`  ${String(r.lip).padStart(11)} ${String(r.padKmh).padStart(5)} ${String(r.lipKmh).padStart(8)}`
      + ` ${r.air.toFixed(2).padStart(6)}s ${r.apex.toFixed(2).padStart(6)} ${r.dist.toFixed(1).padStart(7)}`
      + ` ${r.landing.toFixed(2).padStart(8)} ${r.yaw.toFixed(2).padStart(5)} ${r.stranded.toFixed(1).padStart(9)}`
      + ` ${String(r.land).padStart(5)}${r.hitPad ? '' : '   NO PAD'}${bad ? '   STRAND' : ''}`);
  }
  if (RAMPS_ONLY) return;
  console.log('       s   berm   entry   maxH   air s   landing   maxLat');
  for (const t of out.trials) {
    console.log(`  ${String(t.s).padStart(6)} ${t.berm.toFixed(2).padStart(6)} ${String(t.kmh).padStart(7)}`
      + ` ${t.maxH.toFixed(3).padStart(6)} ${t.airSec.toFixed(2).padStart(7)} ${t.landing.toFixed(2).padStart(9)} ${t.maxLat.toFixed(1).padStart(8)}`);
  }
  const air = out.trials.reduce((a, t) => a + t.airSec, 0);
  const h = Math.max(...out.trials.map(t => t.maxH));
  const n = out.trials.filter(t => t.airSec > 0).length;
  console.log(`\n  ${n}/${out.trials.length} launches got air, ${air.toFixed(2)}s total, highest ${h.toFixed(2)} m`);
  console.log('\n  dropped in from a height — does the airborne path still work?');
  console.log('    start h   left ground   air frames   peak h   landing');
  for (const b of out.ballistic) {
    console.log(`    ${b.h0.toFixed(2).padStart(7)} ${(b.air0 ? 'yes' : 'no').padStart(13)} ${String(b.air).padStart(12)}`
      + ` ${b.maxH.toFixed(3).padStart(8)} ${b.landing.toFixed(3).padStart(9)}`);
  }
});
}

if (rampRows.length) {
  const n = rampRows.length;
  const avg = k => rampRows.reduce((a, r) => a + r[k], 0) / n;
  const noPad = rampRows.filter(r => !r.hitPad).length;
  console.log(`\n  ${n} ramp launches over ${SEED_LIST.length} seed(s)`);
  console.log(`  air ${Math.min(...rampRows.map(r => r.simAir)).toFixed(2)}–${Math.max(...rampRows.map(r => r.simAir)).toFixed(2)} s`
    + `  (mean ${avg('simAir').toFixed(2)}, ${avg('air').toFixed(2)} s on screen through the slow motion)`
    + `   distance ${Math.min(...rampRows.map(r => r.dist)).toFixed(0)}–${Math.max(...rampRows.map(r => r.dist)).toFixed(0)} m`
    + `   apex ${Math.min(...rampRows.map(r => r.apex)).toFixed(2)}–${Math.max(...rampRows.map(r => r.apex)).toFixed(2)} m`);
  console.log(`  lip speed ${Math.min(...rampRows.map(r => r.lipKmh))}–${Math.max(...rampRows.map(r => r.lipKmh))} km/h`
    + `   pads missed ${noPad}`);
  const late = rampRows.filter(r => r.stranded > 0 && r.why && r.why.past > 60);
  if (late.length) {
    console.log(`
  ${late.length} spin(s) further down the corridor, past the landing's runout:`);
    for (const r of late) console.log(`    seed ${r.seed} lip ${r.lip} — ${r.why.past} m past the landing, ${r.why.kmh} km/h`);
  }
  if (strands.length) {
    console.log(`\n  ${strands.length} landing(s) ended in a strand:`);
    for (const s of strands) console.log(`    seed ${s.seed} lip ${s.lip} — stranded ${s.stranded.toFixed(1)}s  ${JSON.stringify(s.why)}`);
    process.exitCode = 1;
  } else {
    console.log('  no ramp landing ended in a strand');
  }
}

finish(process.exitCode || 0);
