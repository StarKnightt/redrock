/* SUPERSEDED 5 Aug — DO NOT TRUST ANY NUMBER THIS TOOL PRINTS.
 *
 * It carries its own hand-copy of the BAND/PACK constants, which is now a
 * third divergent copy, and it reproduces neither the gate's scenario nor its
 * reading. The band is no longer measured as a mean of a sum at all: `_rubber`
 * publishes `bandPlayer` and `bandPack` separately and tools/race.mjs gates
 * them as two independently named checks. Read those fields instead.
 *
 * The premise below is also wrong. The 1.008-vs-1.03 one-sided failure it sets
 * out to explain was instrument error — a gap commanded in metres against a
 * curve authored in seconds, sampled before a 0.45/s filter had converged. The
 * band was a deterministic function of gap the whole time.
 *
 * Delete this once nothing references it.
 *
 * ---- original header, retained for provenance ----
 *
 * Why the rubber band stopped responding, in the terms the band is built from.
 *
 * tools/race.mjs fails one half of one gate: with the player dropped 260 m
 * behind, the field's mean `band` reads 1.008 against a threshold of 1.03. The
 * other direction passes comfortably at 0.774. A one-sided failure is a clue,
 * because the two directions are computed from the same two terms.
 *
 * `_rubber` builds its target from exactly two things:
 *
 *   the PLAYER term, 0.05 x smoothstep(0.6, 8, gapT), where gapT is the gap in
 *   metres divided by the faster of the two speeds. Capped at +0.05, so it can
 *   never on its own carry the mean past 1.05.
 *
 *   the PACK term, which compares each rival to the mean of the rival field:
 *   +0.13 for a car off the back, -0.34 for one running away. Asymmetric by a
 *   factor of 2.6, so a field that is strung out has a NEGATIVE mean pack term
 *   even though the term is meant to be a reshuffle.
 *
 * That second property is the suspect, and it is a driver problem if it is
 * true: a field where one car spends 675 m in the scenery is a field spread
 * over hundreds of metres, and the spread alone would then be enough to cancel
 * the player term and fail the gate. This prints both terms per car so the
 * question is answered rather than argued.
 *
 * Mirrors tools/race.mjs's probe step for step — same 45 s settle, same parked
 * player, same 8 s windows — so the numbers are comparable to the gate's.
 *
 *   node tools/rlband.mjs [--seed 32] [--tag NAME]
 */
import { run } from './harness.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
/* Mirrors tools/race.mjs's own configuration and not a tidier one. That tool
   runs at `hash: 'manual'` with NO seed in the URL, so the stage is the default
   one, and builds its Race with SEEDS[0], which defaults to 1 — a different
   stage AND a different race from the seed-32 pair this probe reached for
   first. Measured both ways the answers differ by 0.07 of band, which is twice
   the margin the gate is decided by, so a decomposition run on any other
   configuration is not a decomposition of the gate. */
const SEED = +flag('seed', 1);
const HASH = flag('hash', 'manual');
const TAG = flag('tag', 'run');

const PROBE = async (seed) => {
  const { Race } = await import('/src/race/index.js');
  const g = window.__game;
  const p = g.player;
  g.botInput = null;
  g.autopilot(true, 0.85);
  g.bot.wobble = 5; g.bot.boost = 1;
  p.placeAt(34, 0); p.vx = 0; p.vy = 0; p.r = 0;
  p.raceTime = 0; p.finished = false; p.rpm = 1050; p.gear = 0;
  if (g.race) g.race.dispose();
  const race = new Race(g.track, g.scene, { seed });
  g.race = race;
  const wired = !!g.__raceDriven;
  const stepFor = secs => {
    for (let i = 0; i < secs * 60; i++) {
      g.step(1 / 60);
      if (p.strandedFor > 2.5) p.recover();
      if (!wired) race.step(1 / 60, p);
    }
  };

  /* The same shape as the constants in src/race/index.js. Duplicated rather
     than imported because the point is to attribute the number the gate reads
     to its parts, and an import would only re-run the sum. */
  const ss = (a, b, x) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const decompose = () => {
    const n = race.entries.length;
    const packS = race.entries.reduce((a, e) => a + e.car.s, 0) / n;
    const rows = race.entries.map(e => {
      const gapS = p.s - e.car.s;
      const ref = Math.max(p.speed, e.car.speed, 10);
      const gapT = gapS / ref;
      const playerTerm = gapT > 0
        ? 0.05 * ss(0.6, 8, gapT)
        : -0.10 * ss(0.6, 7, -gapT) - 0.12 * ss(7, 22, -gapT);
      const dPack = packS - e.car.s;
      const packTerm = (dPack > 0 ? 0.13 : -0.34) * ss(25, 320, Math.abs(dPack));
      return {
        s: +e.car.s.toFixed(0),
        kmh: +(e.car.speed * 3.6).toFixed(0),
        gapS: +gapS.toFixed(0),
        gapT: +gapT.toFixed(2),
        playerTerm: +playerTerm.toFixed(4),
        dPack: +dPack.toFixed(0),
        packTerm: +packTerm.toFixed(4),
        target: +(1 + playerTerm + packTerm).toFixed(4),
        band: +e.band.toFixed(4),
        boost: +e.driver.boost.toFixed(3),
      };
    });
    const spread = Math.max(...race.entries.map(e => e.car.s))
      - Math.min(...race.entries.map(e => e.car.s));
    return {
      rows,
      spread: +spread.toFixed(0),
      playerSpeed: +(p.speed * 3.6).toFixed(0),
      meanPlayer: +(rows.reduce((a, r) => a + r.playerTerm, 0) / n).toFixed(4),
      meanPack: +(rows.reduce((a, r) => a + r.packTerm, 0) / n).toFixed(4),
      meanTarget: +(rows.reduce((a, r) => a + r.target, 0) / n).toFixed(4),
      avgBand: +(race.entries.reduce((a, e) => a + e.band, 0) / n).toFixed(3),
    };
  };

  stepFor(45);
  const settled = decompose();
  const rear = Math.min(...race.cars.map(c => c.s));
  p.placeAt(Math.max(6, rear - 260), 0);
  g.botInput = { steer: 0, throttle: 0, brake: 1, handbrake: 0 };
  stepFor(8);
  const whenAllAhead = decompose();
  g.botInput = null;
  const lead = Math.max(...race.cars.map(c => c.s));
  const wanted = lead + 260;
  const capped = Math.min(g.track.length - 300, wanted);
  p.placeAt(capped, 0); p.vx = 30;
  stepFor(8);
  const whenAllBehind = decompose();
  return {
    settled, whenAllAhead, whenAllBehind,
    trackLength: +g.track.length.toFixed(0),
    leadAtPlace: +lead.toFixed(0),
    playerWanted: +wanted.toFixed(0),
    playerPlaced: +capped.toFixed(0),
    placeClipped: capped < wanted - 1,
  };
};

const show = (name, d) => {
  console.log(`\n  ── ${name} ──   field spread ${d.spread} m   player ${d.playerSpeed} km/h`);
  console.log('      s     kmh    gapS   gapT   player    dPack    pack   target    band  boost');
  for (const r of d.rows) {
    console.log(`  ${String(r.s).padStart(5)}  ${String(r.kmh).padStart(4)}`
      + `  ${String(r.gapS).padStart(6)} ${String(r.gapT).padStart(6)}`
      + ` ${String(r.playerTerm).padStart(8)} ${String(r.dPack).padStart(8)}`
      + ` ${String(r.packTerm).padStart(7)} ${String(r.target).padStart(8)}`
      + ` ${String(r.band).padStart(7)} ${String(r.boost).padStart(6)}`);
  }
  console.log(`  mean player ${d.meanPlayer}   mean pack ${d.meanPack}`
    + `   mean target ${d.meanTarget}   avgBand ${d.avgBand}`);
};

await run({ width: 640, height: 360, hash: HASH },
  async ({ page }) => {
    const r = await page.evaluate(PROBE, SEED);
    console.log(`\n═══ rubber band decomposition [${TAG}] seed ${SEED} ═══`);
    show('after 45 s settle', r.settled);
    show('player dropped BEHIND (gate wants avgBand < 0.93)', r.whenAllAhead);
    show('player CLEAR AHEAD (gate wants avgBand > 1.03)', r.whenAllBehind);
    console.log(`\n  track ${r.trackLength} m   leader at placement ${r.leadAtPlace} m`
      + `   player wanted ${r.playerWanted} m, placed ${r.playerPlaced} m`
      + `   ${r.placeClipped ? 'CLIPPED by track end' : 'not clipped'}`);
    const b = r.whenAllBehind;
    console.log(`\n  VERDICT  avgBand ${b.avgBand} vs 1.03 needed.`
      + `  Player term contributes ${b.meanPlayer} of the +0.05 available;`
      + ` the pack term takes ${b.meanPack} back at ${b.spread} m of field spread.`);
  });
