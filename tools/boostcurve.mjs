/* What is a percent of rubber band actually worth?
 *
 * `boost` multiplies the driver's PLANNED speed, and the plan is not what the
 * car does. On a straight the plan is already past what the engine and drag
 * will give, so lifting it buys nothing at all; in a corner it is the grip
 * that answers, and asking for more can cost time rather than save it. So the
 * multiplier and the stage time are not proportional and there is no reason
 * to assume the relationship is even monotonic.
 *
 * This drives the solo bot down the whole stage at a series of fixed boosts
 * and reports the stage time, so the band can be tuned against seconds
 * instead of against percentages. The last column is the one that matters:
 * seconds of stage time bought per 1% of boost, which is the exchange rate
 * between what the band asks for and what the race actually gets.
 *
 *   node tools/boostcurve.mjs [--skill 0.75] [--secs 320]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SKILL = +flag('skill', 0.75);
const SECS = +flag('secs', 320);
const TRACKS = flag('tracks', '3,11,17,22,26').split(',').map(Number);
const BOOSTS = [0.86, 0.92, 0.96, 1.0, 1.03, 1.06, 1.09, 1.13];

const SIM = async ([boost, skill, secs]) => {
  const g = window.__game;
  const p = g.player;
  /* Park the rivals rather than removing them: main.js steps g.race
     unconditionally. Off the road and far up the stage they cannot touch the
     car under test, and the race's own band never writes to g.bot. */
  if (g.race) {
    g.race.reset();
    for (const e of g.race.entries) { e.car.placeAt(g.track.length - 40, 40); e.view.root.visible = false; }
  }
  g.botInput = null;
  g.autopilot(true, skill);
  g.bot.wobble = 5;
  g.bot.boost = boost;
  g.bot.rec = null;
  g.bot.steerSmooth = 0; g.bot.throttleSmooth = 0; g.bot.stuckFor = 0;
  p.placeAt(34, 0); p.vx = 0; p.vy = 0; p.r = 0;
  p.raceTime = 0; p.finished = false; p.rpm = 1050; p.gear = 0;
  p.prevLat = 0;

  let strands = 0, wasStranded = false, offRoad = 0, impacts = 0, sumKmh = 0, n = 0;
  for (let i = 0; i < secs * 60 && !p.finished; i++) {
    g.bot.boost = boost;          // race/index.js is not driving it here
    g.step(1 / 60);
    if (p.strandedFor > 1) { if (!wasStranded) strands++; wasStranded = true; }
    else if (p.strandedFor === 0) wasStranded = false;
    if (p.offRoad > 0.5) offRoad++;
    if (p.lastImpact > 0.25) impacts++;
    sumKmh += p.kmh; n++;
  }
  return {
    boost, finished: p.finished,
    time: +p.raceTime.toFixed(2),
    s: +p.s.toFixed(0),
    kmh: +(sumKmh / n).toFixed(1),
    strands, offPct: +(offRoad / n * 100).toFixed(1), impacts,
  };
};

/* One stage is not enough to say anything: a single spin is worth six seconds
   and swamps the effect being measured. Several tracks, and report the spread
   as well as the mean so it is obvious when a difference is not real. */
const byBoost = new Map(BOOSTS.map(b => [b, []]));
for (const track of TRACKS) {
  await run({ width: 640, height: 360, hash: `manual&seed=${track}` }, async ({ page }) => {
    for (const b of BOOSTS) byBoost.get(b).push(await page.evaluate(SIM, [b, SKILL, SECS]));
  });
  console.log(`  track ${track} done`);
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const stats = BOOSTS.map(b => {
  const rs = byBoost.get(b);
  const ts = rs.map(r => r.finished ? r.time : NaN);
  return {
    boost: b,
    dnf: rs.filter(r => !r.finished).length,
    time: mean(ts),
    lo: Math.min(...ts), hi: Math.max(...ts),
    spins: mean(rs.map(r => r.strands)),
    off: mean(rs.map(r => r.offPct)),
    kmh: mean(rs.map(r => r.kmh)),
  };
});
const base = stats.find(r => r.boost === 1);

console.log(`\n  solo bot, skill ${SKILL}, whole stage, ${TRACKS.length} tracks\n`);
console.log('   boost   mean stage time   vs boost 1.0   range over tracks   spins   off-road   mean km/h');
for (const r of stats) {
  const d = r.time - base.time;
  console.log(
    `   ${r.boost.toFixed(2)}`.padEnd(9),
    (r.dnf ? `${r.dnf} DNF ` : '') + `${r.time.toFixed(1)}s`.padStart(11),
    ((d >= 0 ? '+' : '') + d.toFixed(1) + 's').padStart(14),
    `${r.lo.toFixed(0)}–${r.hi.toFixed(0)}s`.padStart(19),
    r.spins.toFixed(1).padStart(8),
    `${r.off.toFixed(1)}%`.padStart(10),
    r.kmh.toFixed(1).padStart(11),
  );
}
console.log('\n  Negative in the "vs boost 1.0" column means the band bought time,'
  + '\n  which is what it is for. Positive means it asked for corner speed the'
  + '\n  car could not carry and lost time trying.\n');
finish(process.exitCode || 0);
