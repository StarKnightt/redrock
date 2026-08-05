/* Review probe (read-only): two of the brief's clauses that no existing tool
 * answers directly.
 *
 * SUSPENSION. "Compresses on landing with a bounce" is not one number, it is
 * a shape: the ride height has to go down, come back past its resting point,
 * and settle. A peak compression figure cannot tell a spring from a dashpot.
 * This logs the squash trace at 1/60 through touchdown and reports the sign
 * changes and the overshoot — how far past zero the rebound goes as a
 * fraction of the compression that produced it. Under about 5% there is no
 * bounce, there is a car sinking and quietly returning.
 *
 * RIVALS. rampshot puts a rival on the ramp by hand. That proves the physics
 * can launch an AI car; it does not prove the AI drives over the ramps of its
 * own accord in a race. This runs an actual race from the grid and counts, per
 * rival, how many ramp lips it crossed and how much air it got, with nothing
 * placed and nothing steered.
 *
 * Nothing under src/ is touched.
 *
 *   node tools/c2landai.mjs [--seeds 22,40] [--sec 200]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,40').split(',').map(Number);
const SEC = +flag('sec', 240);

for (const SEED of SEEDS) {
  await run({ width: 640, height: 360, hash: `manual&tier=low&seed=${SEED}&cap=0&hud=0` },
    async ({ page }) => {
      const out = await page.evaluate(([sec]) => {
        const g = window.__game, p = g.player;
        g.setPaused(true);

        /* ── the spring ── */
        const springs = [];
        g.autopilot(true, 0.85);
        for (const r of g.track.ramps) {
          g.driveTo((r.pad0 - 60) / g.track.length, { runUp: 320, maxSec: 45 });
          let n = 0, wasAir = false;
          while (n++ < 900) { g.step(1 / 60); if (p.airborne) wasAir = true; if (wasAir && !p.airborne) break; }
          const tr = [];
          for (let k = 0; k < 60; k++) { tr.push(+p.squash.toFixed(4)); g.step(1 / 60); }
          /* Sign convention is whatever it is; take the first excursion as the
             compression and anything of the other sign after it as rebound. */
          const peak = tr.reduce((a, v) => (Math.abs(v) > Math.abs(a) ? v : a), 0);
          const sgn = Math.sign(peak) || 1;
          const iPeak = tr.findIndex(v => v === peak);
          const after = tr.slice(iPeak);
          const over = after.reduce((a, v) => (v * sgn < a * sgn ? v : a), 0);
          let crossings = 0;
          for (let k = 1; k < tr.length; k++) {
            if (Math.abs(tr[k]) < 1e-4 || Math.abs(tr[k - 1]) < 1e-4) continue;
            if (Math.sign(tr[k]) !== Math.sign(tr[k - 1])) crossings++;
          }
          springs.push({
            lip: r.lip,
            compress: +peak.toFixed(4),
            rebound: +over.toFixed(4),
            overshoot: +(Math.abs(over) / Math.max(1e-6, Math.abs(peak)) * 100).toFixed(1),
            crossings,
            settle: after.findIndex(v => Math.abs(v) < Math.abs(peak) * 0.05),
            trace: tr.slice(0, 34),
          });
        }
        g.autopilot(false);

        /* ── the rivals, in a real race ── */
        g.reset ? g.reset() : null;
        g.startRace ? g.startRace() : null;
        const ents = (g.race && g.race.entries) || [];
        const seen = ents.map(() => ({ crossed: 0, flights: [], prevS: 0, air: 0, peak: 0, was: false }));
        const lips = g.track.ramps.map(r => r.lip);
        let t = 0;
        while (t < sec) {
          g.step(1 / 60); t += 1 / 60;
          for (let i = 0; i < ents.length; i++) {
            const c = ents[i].car, st = seen[i];
            for (const L of lips) if (st.prevS < L && c.s >= L) st.crossed++;
            st.prevS = c.s;
            if (c.airborne) {
              st.was = true; st.air += 1 / 60; st.peak = Math.max(st.peak, c.height);
            } else if (st.was) {
              if (st.peak > 0.8) st.flights.push({ h: +st.peak.toFixed(2), t: +st.air.toFixed(2) });
              st.was = false; st.air = 0; st.peak = 0;
            }
          }
          if (ents.every(e => e.finished)) break;
        }
        return {
          seed: g.track.seed, lips, springs,
          rivals: seen.map((s, i) => ({
            name: ents[i].name || ('rival ' + i),
            crossed: s.crossed,
            s: Math.round(s.prevS),
            big: s.flights.filter(f => f.h > 2.0),
            n: s.flights.length,
          })),
        };
      }, [SEC]);

      console.log(`\n─── seed ${out.seed} — suspension ───`);
      console.log('     lip   compress   rebound   overshoot   zero-crossings   settle f');
      for (const s of out.springs) {
        console.log(`  ${String(s.lip).padStart(6)} ${s.compress.toFixed(4).padStart(10)}`
          + ` ${s.rebound.toFixed(4).padStart(9)} ${(s.overshoot + '%').padStart(11)}`
          + ` ${String(s.crossings).padStart(16)} ${String(s.settle).padStart(10)}`);
      }
      console.log('  trace (first 34 frames of the first landing):');
      console.log('   ' + out.springs[0].trace.map(v => v.toFixed(3)).join(' '));

      console.log(`\n─── seed ${out.seed} — rivals in a real race, lips at ${out.lips.join(', ')} ───`);
      for (const r of out.rivals) {
        console.log(`  ${String(r.name).padEnd(14)} reached s ${String(r.s).padStart(5)}`
          + `   crossed ${r.crossed} lip(s)`
          + `   ${r.n} flights, ${r.big.length} over 2 m`
          + (r.big.length ? '  [' + r.big.slice(0, 6).map(f => `${f.h} m/${f.t}s`).join(', ') + ']' : ''));
      }
    });
}

finish(process.exitCode || 0);
