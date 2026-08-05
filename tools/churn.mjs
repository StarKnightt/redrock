/* Where the order actually changes, and why.
 *
 * A lead-change count is a single number and it can be right for bad reasons.
 * What matters for feel is which cars are trading places, whether the player
 * earned or lost the position, and whether the changes are spread down the
 * stage or all happening at the same two corners. So this records every swap
 * with its station and its cause:
 *
 *   - player-involved vs rival-only. Rivals swapping among themselves is what
 *     makes the pack look alive from behind; the player being passed is the
 *     part that has to feel earned.
 *   - whether the player had made a mistake in the seconds before being
 *     passed — a recovery, a real impact, a trip off the road, or a big speed
 *     loss. A pass that follows a mistake is the racing working. A pass out of
 *     clear air is the elastic showing.
 *   - where in the stage, in tenths, and how much of the total lands in the
 *     single busiest tenth.
 *
 * It also reports the two things that bound how many changes are even
 * possible: how long the field spends close enough to swap, and how much of
 * the time each car's boost is pinned against its clamp, because a car whose
 * help is saturated cannot be helped any further.
 *
 *   node tools/churn.mjs [--seeds 1,4,20] [--secs 260]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '1,4,17,20,24').split(',').map(Number);
const SECS = +flag('secs', 300);

const SIM = async ([seed, secs]) => {
  const { Race } = await import('/src/race/index.js');
  const g = window.__game;
  const p = g.player;
  const track = g.track;
  const L = track.length;

  g.botInput = null;
  g.autopilot(true, 0.85);
  g.bot.wobble = 5;
  g.bot.boost = 1;
  p.placeAt(34, 0); p.vx = 0; p.vy = 0; p.r = 0;
  p.raceTime = 0; p.finished = false; p.rpm = 1050; p.gear = 0;
  if (g.race) g.race.dispose();
  const race = new Race(track, g.scene, { seed });
  g.race = race;
  g.botInput = { steer: 0, throttle: 0, brake: 1, handbrake: 0 };
  g.step(1 / 60);
  const wired = race._clock > 0;
  race.reset();
  g.botInput = null;
  p.placeAt(34, 0); p.vx = 0; p.vy = 0; p.r = 0;
  p.raceTime = 0; p.finished = false; p.rpm = 1050; p.gear = 0;

  const HYST = 1.0;
  const cars = [p, ...race.entries.map(e => e.car)];
  const names = ['PLAYER', ...race.entries.map(e => e.name)];

  let lastLeader = null, changes = [];
  let rivalSwaps = 0, lastRivalOrder = '';
  const bucket = new Array(10).fill(0);
  const playerBucket = new Array(10).fill(0);
  /* A mistake is anything the player would recognise as having gone wrong.
     lastImpact decays, so sample it rather than integrate. Being stranded
     counts from the moment it is obvious, not from the rescue: the player
     knows the run is ruined well before the game steps in, and since the
     driver learned to turn itself around most of them no longer reach a
     rescue at all. */
  let lastMistake = -99, stranded = false;
  let closeFrames = 0, frames = 0;
  let topGapSum = 0, topGapN = 0, topGapMin = 9e9;
  const boostPinned = race.entries.map(() => 0);
  const boostSum = race.entries.map(() => 0);
  const bandSum = race.entries.map(() => 0);
  let prevKmh = 0, recoveries = 0;
  const passRunLen = [];       // seconds a car holds the lead
  let leaderSince = 0;

  for (let i = 0; i < secs * 60 && !cars.every(c => c.finished); i++) {
    /* No rescue here: main.js already recovers the player at 4 s, and the
       2.5 s one this used to run pre-empted it — which both cost the player
       less time than the game really does, and let the player skip the
       turn-around the rivals now have to drive. */
    g.step(1 / 60);
    if (!wired) race.step(1 / 60, p);
    frames++;
    const t = race._clock;

    if (p.strandedFor > 1) { if (!stranded) recoveries++; stranded = true; lastMistake = t; }
    else if (p.strandedFor === 0) stranded = false;
    if (p.lastImpact > 0.25 || p.offRoad > 0.5 || (prevKmh - p.kmh) > 22) lastMistake = t;
    prevKmh = p.kmh;

    const st = race.standings();
    const leader = st[0].car;
    if (lastLeader && leader !== lastLeader) {
      const s = leader.s;
      const b = Math.min(9, Math.floor(s / L * 10));
      bucket[b]++;
      const from = cars.indexOf(lastLeader), to = cars.indexOf(leader);
      const involvesPlayer = from === 0 || to === 0;
      if (involvesPlayer) playerBucket[b]++;
      changes.push({
        t: +t.toFixed(1), s: +s.toFixed(0),
        from: names[from], to: names[to],
        player: involvesPlayer,
        afterMistake: involvesPlayer && to !== 0 && (t - lastMistake) < 4,
        held: +(t - leaderSince).toFixed(1),
      });
      passRunLen.push(t - leaderSince);
      leaderSince = t;
    }
    lastLeader = leader;

    // Rival-only order, to see whether the AI pack itself ever reshuffles.
    const ro = race.entries
      .map((e, k) => [e.car.s, k]).sort((a, b) => b[0] - a[0]).map(x => x[1]).join('');
    if (lastRivalOrder && ro !== lastRivalOrder) rivalSwaps++;
    lastRivalOrder = ro;

    const ss = cars.map(c => c.s).sort((a, b) => b - a);
    const gap = ss[0] - ss[1];
    topGapSum += gap; topGapN++; topGapMin = Math.min(topGapMin, gap);
    if (ss[0] - ss[ss.length - 1] < 60) closeFrames++;

    race.entries.forEach((e, k) => {
      boostSum[k] += e.driver.boost;
      bandSum[k] += e.band;
      if (e.driver.boost > 1.0499 || e.driver.boost < 0.7501) boostPinned[k]++;
    });
  }

  const st = race.standings();
  const spread = Math.max(...st.map(x => x.time || 9999)) - Math.min(...st.map(x => x.time || 0));
  return {
    seed, frames, secs: +(frames / 60).toFixed(0), recoveries,
    finished: cars.every(c => c.finished),
    order: st.map(x => `${names[cars.indexOf(x.car)]} ${(x.time || 0).toFixed(1)}`),
    changes: changes.length,
    playerChanges: changes.filter(c => c.player).length,
    earned: changes.filter(c => c.afterMistake).length,
    passedInClearAir: changes.filter(c => c.player && !c.afterMistake
      && c.to !== 'PLAYER').length,
    rivalSwaps,
    bucket, playerBucket,
    busiestTenth: Math.max(...bucket),
    closePct: +(closeFrames / frames * 100).toFixed(0),
    topGapAvg: +(topGapSum / topGapN).toFixed(1),
    topGapMin: +topGapMin.toFixed(1),
    holdMedian: +(passRunLen.length
      ? passRunLen.slice().sort((a, b) => a - b)[passRunLen.length >> 1] : 0).toFixed(1),
    holdUnder2: passRunLen.filter(x => x < 2).length,
    cars: race.entries.map((e, k) => ({
      name: e.name,
      pace: +e.pace.toFixed(3),
      boost: +(boostSum[k] / frames).toFixed(3),
      band: +(bandSum[k] / frames).toFixed(3),
      pinnedPct: +(boostPinned[k] / frames * 100).toFixed(0),
    })),
    log: changes.slice(0, 40),
  };
};

const all = {};
await run({ width: 640, height: 360, hash: 'manual' }, async ({ page }) => {
  for (const seed of SEEDS) {
    const o = await page.evaluate(SIM, [seed, SECS]);
    all[seed] = o;
    console.log(`\n═══ seed ${o.seed} — ${o.secs}s, finished=${o.finished}, ${o.recoveries} player recoveries ═══`);
    console.log(`  ${o.order.join('   ')}`);
    console.log(`  lead changes ${o.changes}   involving the player ${o.playerChanges}`
      + `   rival-only reshuffles ${o.rivalSwaps}`);
    console.log(`  player passed after a mistake ${o.earned}, out of clear air ${o.passedInClearAir}`);
    console.log(`  leader held for ${o.holdMedian}s median, ${o.holdUnder2} swaps lasted under 2s`);
    console.log(`  field within 60 m ${o.closePct}% of the race   P1–P2 gap avg ${o.topGapAvg} m, closest ${o.topGapMin} m`);
    console.log(`  changes by tenth of stage  ${o.bucket.join(' ')}   (player ${o.playerBucket.join(' ')})`);
    for (const c of o.cars) {
      console.log(`    ${c.name.padEnd(7)} pace ${c.pace}  mean band ${c.band}  mean boost ${c.boost}  clamped ${c.pinnedPct}% of the race`);
    }
  }
});

const agg = (k) => SEEDS.reduce((a, s) => a + (all[s]?.[k] ?? 0), 0);
console.log(`\n═══ ${SEEDS.length} seeds ═══`);
console.log(`  lead changes ${agg('changes')}   player-involved ${agg('playerChanges')}`
  + `   rival reshuffles ${agg('rivalSwaps')}`);
console.log(`  passes of the player: ${agg('earned')} after a mistake, ${agg('passedInClearAir')} out of clear air`);
console.log(`  swaps that lasted under 2 s: ${agg('holdUnder2')}`);

fs.mkdirSync(path.join(ROOT, 'shots', 'race'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'shots', 'race', 'churn.json'), JSON.stringify(all, null, 1));
console.log('\n  → shots/race/churn.json');
finish(process.exitCode || 0);
