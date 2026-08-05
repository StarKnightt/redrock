/* The balance table, in one instrument, before and after a grid change.
 *
 * tools/churn.mjs already reports lead changes and where they happen, and it
 * stays the reference for those. What it cannot answer is the set of questions
 * a REVERSED grid raises, because every one of them is about the player rather
 * than about the leader:
 *
 *   - can the player still win, and how often
 *   - how many positions the player actually gains, which is the whole point
 *     of starting at the back and is invisible to a leader-change count
 *   - how much of the race the player spends within 60 m of a rival, measured
 *     from the PLAYER and not as "the field is within 60 m of itself" — with
 *     the player 20 m off the back of a three-car pack those two numbers are
 *     not close to each other
 *   - whether the last minute has anybody in it. The complaint that motivated
 *     the change is that on seed 22 the player ran the closing 59 seconds with
 *     no rival inside 150 m, so that exact quantity is reported: the length of
 *     the lonely tail at the end of the player's own race.
 *
 * Plus the numbers the change is allowed to move but not allowed to break:
 * finish spread, finish rate per car, contact depth and impact episodes.
 *
 * THE CAR IS PUT BACK ON THE GRID WITH g.restart(). Not placeAt: a probe that
 * steps from wherever the page's own rAF loop had carried the car inherits the
 * browser's start-up time as a hidden parameter, and a census on this project
 * disagreed with itself by a factor of ten because of exactly that. restart()
 * is the one call that puts the player, the field, the simulation accumulator,
 * the effects and the camera all back to the top together.
 *
 * A seed here is a FIELD seed, not a track seed — the same convention
 * tools/churn.mjs and tools/race.mjs use. The stage is whatever the page was
 * booted with, so 32 seeds is 32 different fields down one road, which is what
 * isolates a balance change from layout variance.
 *
 * --jitter is the noise floor, and it is not optional reading. A four-minute
 * four-car race is chaotic: the same field run from initial conditions that
 * differ by one part in a billion decorrelates completely, so a single seed's
 * finishing times carry no information at all about a change this size. Running
 * the sweep twice with a 1e-9 perturbation on the player's own boost says how
 * much of any before/after delta is the change and how much is the weather.
 *
 * --grid pole|reversed overrides the formation WITHOUT editing the source, so
 * both grids can be measured from one build and one boot. `Race` copies GRID
 * into each entry as `e.grid` in its constructor and `reset()` reads it back
 * from there, so writing the slots onto the entries and resetting is the same
 * code path the module takes on its own — nothing here reaches around the
 * thing being measured. Verified by reproducing the shipped grid's sweep
 * exactly through the override.
 *
 *   node tools/kwgrid.mjs [--seeds 1..32] [--secs 420] [--skill 0.85]
 *                         [--json out.json] [--tag before] [--jitter]
 *                         [--grid pole|reversed]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const parseSeeds = (spec) => {
  const m = /^(\d+)\.\.(\d+)$/.exec(spec);
  if (!m) return spec.split(',').map(Number);
  const out = [];
  for (let i = +m[1]; i <= +m[2]; i++) out.push(i);
  return out;
};
const SEEDS = parseSeeds(flag('seeds', '1..32'));
const SECS = +flag('secs', 420);
const SKILL = +flag('skill', 0.85);
const TAG = flag('tag', 'kwgrid');
const JSON_OUT = flag('json', null);
/* One part in a billion on the player's speed plan. See the header. */
const JITTER = args.includes('--jitter') ? 1e-9 : 0;
/* null leaves whatever GRID the module ships with. */
const GRIDS = {
  pole: [[-7, 2.3], [-13.5, -2.3], [-20, 2.3]],
  reversed: [[20, 2.3], [13.5, -2.3], [7, 2.3]],
  /* Same 6.5 m rows, but seven more metres between the player and the back of
     the field: the test of whether the reversed grid's cost is the shunt the
     player arrives with, or the fact of not starting in front. */
  roomy: [[27, 2.3], [20.5, -2.3], [14, 2.3]],
  /* Halfway between the two, because `reversed` owns the grid shot and `roomy`
     owns the racing and the question is whether anything owns both. Ten metres
     is still over four car lengths of clear air in front of the player. */
  mid: [[23, 2.3], [16.5, -2.3], [10, 2.3]],
  /* And the same question asked by opening the whole formation out. */
  wide: [[27, 2.3], [18, -2.3], [9, 2.3]],
  /* Conventional order inverted: the QUICKEST rival at the back, so the first
     car the player meets is the one it closes on slowest. */
  slowfront: [[7, 2.3], [13.5, -2.3], [20, 2.3]],
};
const GRID = flag('grid', null);
if (GRID && !GRIDS[GRID]) throw new Error(`--grid must be one of ${Object.keys(GRIDS)}`);

/* Gaps are measured in arc length, which is the only gap the standings and the
   rubber band both use. NEAR is the brief's 60 m; LONELY is the 150 m the
   complaint about the climax was stated in. */
const NEAR_M = 60;
const LONELY_M = 150;

const SIM = async ([seed, secs, skill, nearM, lonelyM, jitter, gridSlots]) => {
  const { Race } = await import('/src/race/index.js');
  const g = window.__game;
  const p = g.player;
  const L = g.track.length;

  if (g.race) g.race.dispose();
  const race = new Race(g.track, g.scene, { seed });
  g.race = race;
  /* The formation override. Written before the restart below, which is the
     call that actually places the cars from `e.grid`. */
  if (gridSlots) race.entries.forEach((e, i) => { e.grid = gridSlots[i]; });

  /* Is main.js stepping the field, or must this tool? Stepping it twice gives
     every rival double time against the player — permanently "ahead", pinned
     at the band's floor, on a clock the standings cannot compare. Probe it,
     then restart to undo the probe. */
  g.botInput = { steer: 0, throttle: 0, brake: 1, handbrake: 0 };
  g.step(1 / 60);
  const wired = race._clock > 0;
  g.botInput = null;

  /* The whole reset, in one call. See the header. */
  g.restart();
  g.autopilot(true, skill);
  g.bot.wobble = 5;              // Driver seeds this from Math.random; pin it
  g.bot.boost = 1 + (jitter || 0);

  const cars = [p, ...race.entries.map(e => e.car)];
  const names = ['PLAYER', ...race.entries.map(e => e.name)];
  const N = cars.length;

  /* Every pair's relative order, so an overtake is a sign flip rather than a
     re-sort. Hysteresis matched to Race's own HYST, so a pair sitting door to
     door does not register a hundred passes a second. */
  const HYST = 1.0;
  const sign = new Map();
  const key = (a, b) => a * 8 + b;
  for (let a = 0; a < N - 1; a++) {
    for (let b = a + 1; b < N; b++) {
      sign.set(key(a, b), Math.sign(cars[a].s - cars[b].s) || 1);
    }
  }

  let overtakes = 0, playerOvertakes = 0, gained = 0, lost = 0;
  const bucket = new Array(10).fill(0);
  const playerBucket = new Array(10).fill(0);

  let leadChanges = 0, lastLeader = null, playerLeadChanges = 0;
  const leadBucket = new Array(10).fill(0);
  let raceFrames = 0, nearFrames = 0, ledFrames = 0;
  let posSum = 0, posBest = 9, posWorst = 0;
  /* The lonely tail: how long the player finished with nothing inside
     `lonelyM`. Reset every time a rival comes back inside it, so what is left
     at the flag is the length of the final stretch and not a total. */
  let lonelyFor = 0, lonelyTail = 0;
  let nearestAtEnd = 9e9;
  /* Contact, on the same envelope race/index.js uses. Read after the step, so
     this is what the resolver LEFT, which is the number that matters for
     whether two cars are ever seen inside each other. */
  const C_LEN = 3.9, C_WID = 1.85;
  let deepest = 0, deepAt = null, touchFrames = 0;
  const gapTrace = [];          // nearest rival gap at each tenth of the stage
  let nextTenth = 0;

  /* The band, conditioned on which side of the player the rival is, because
     that is the whole question a reversed grid raises: the player band cuts a
     rival that is AHEAD of the player, and on a reversed grid every rival is
     ahead of the player at the flag-drop for a structural reason rather than
     because the player made a mistake. `aheadN` over the race is therefore the
     exposure, and `bandAhead` is what it costs them. */
  const bandSum = race.entries.map(() => 0);
  const boostSum = race.entries.map(() => 0);
  const bandAhead = race.entries.map(() => 0), aheadN = race.entries.map(() => 0);
  const bandBehind = race.entries.map(() => 0), behindN = race.entries.map(() => 0);
  let bandFrames = 0;

  /* The opening, sampled. A reversed grid puts the player behind three cars it
     is quicker than, so the first thing it does is arrive in the back of them
     at whatever speed the difference allows — which is a different event from
     anything the pole grid ever produced, and it happens before the race has
     had time to be a race. Impacts, rival recoveries and the player's position
     are snapshotted at fixed times so the opening can be separated from the
     rest of the stage. */
  const marks = [5, 10, 20, 30, 45];
  const snaps = [];
  let nextMark = 0;

  const DT = 1 / 60;
  let frames = 0;
  for (let i = 0; i < secs * 60; i++) {
    g.step(DT);
    if (!wired) race.step(DT, p);
    frames++;
    const t = race._clock;

    // Order, by pair, with hysteresis.
    for (let a = 0; a < N - 1; a++) {
      for (let b = a + 1; b < N; b++) {
        const k = key(a, b);
        const d = cars[a].s - cars[b].s;
        const was = sign.get(k);
        if (Math.abs(d) < HYST) continue;
        const now = Math.sign(d);
        if (now !== was) {
          sign.set(k, now);
          overtakes++;
          // The car that went forward is the one whose sign now favours it.
          const passer = now > 0 ? a : b;
          const bk = Math.min(9, Math.max(0, Math.floor(cars[passer].s / L * 10)));
          bucket[bk]++;
          if (a === 0 || b === 0) {
            playerOvertakes++;
            playerBucket[bk]++;
            if (passer === 0) gained++; else lost++;
          }
        }
      }
    }

    const st = race.standings();
    const leader = st[0].car;
    if (lastLeader && leader !== lastLeader) {
      leadChanges++;
      leadBucket[Math.min(9, Math.max(0, Math.floor(leader.s / L * 10)))]++;
      if (leader === p || lastLeader === p) playerLeadChanges++;
    }
    lastLeader = leader;

    if (!p.finished) {
      raceFrames++;
      const pos = race.positionOf(p) ?? 1;
      posSum += pos;
      if (pos < posBest) posBest = pos;
      if (pos > posWorst) posWorst = pos;
      if (pos === 1) ledFrames++;

      let nearest = 9e9;
      for (const e of race.entries) {
        nearest = Math.min(nearest, Math.abs(e.car.s - p.s));
      }
      nearestAtEnd = nearest;
      if (nearest < nearM) nearFrames++;
      if (nearest > lonelyM) { lonelyFor += DT; lonelyTail = lonelyFor; }
      else { lonelyFor = 0; lonelyTail = 0; }

      while (nextTenth < 10 && p.s >= L * (nextTenth + 1) / 10) {
        gapTrace.push(Math.round(Math.min(nearest, 9999)));
        nextTenth++;
      }
    }

    if (!p.finished) {
      bandFrames++;
      race.entries.forEach((e, k) => {
        bandSum[k] += e.band;
        boostSum[k] += e.driver.boost;
        if (e.car.finished) return;
        if (e.car.s > p.s) { bandAhead[k] += e.band; aheadN[k]++; }
        else { bandBehind[k] += e.band; behindN[k]++; }
      });
    }

    for (let a = 0; a < N - 1; a++) {
      for (let b = a + 1; b < N; b++) {
        const overS = C_LEN - Math.abs(cars[a].s - cars[b].s);
        const overL = C_WID - Math.abs(cars[a].lat - cars[b].lat);
        if (overS <= 0 || overL <= 0) continue;
        touchFrames++;
        const depth = Math.min(overS, overL);
        if (depth > deepest) {
          deepest = depth;
          deepAt = { s: Math.round(cars[a].s), pair: `${names[a]}/${names[b]}`, t: +t.toFixed(1) };
        }
      }
    }

    while (nextMark < marks.length && t >= marks[nextMark]) {
      snaps.push({
        t: marks[nextMark],
        impacts: race.collisions,
        recoveries: race.entries.reduce((a, e) => a + e.recoveries, 0),
        pos: race.positionOf(p) ?? 1,
        /* Metres the player is behind the leader, which on this grid starts at
           20 and has to be worked off. */
        behind: Math.round(Math.max(...cars.map(c => c.s)) - p.s),
      });
      nextMark++;
    }

    if (cars.every(c => c.finished)) break;
  }
  g.autopilot(false);

  const st = race.standings();
  const rows = st.map(x => ({
    name: x.isPlayer ? 'PLAYER' : x.name,
    isPlayer: !!x.isPlayer,
    finished: x.finished,
    time: +x.time.toFixed(2),
    s: Math.round(x.s),
    recoveries: x.recoveries,
  }));
  const times = rows.filter(r => r.finished).map(r => r.time);
  const playerRow = rows.find(r => r.isPlayer);

  return {
    seed, wired, frames, secs: +(frames / 60).toFixed(0),
    rows,
    allFinished: rows.every(r => r.finished),
    finishers: times.length,
    spread: times.length >= 2 ? +(Math.max(...times) - Math.min(...times)).toFixed(2) : null,
    finalPos: rows.indexOf(playerRow) + 1,
    won: rows.indexOf(playerRow) === 0,
    leadChanges, playerLeadChanges, leadBucket,
    lateLead: leadBucket.slice(3).reduce((a, b) => a + b, 0),
    overtakes, playerOvertakes, gained, lost,
    bucket, playerBucket,
    lateSeventy: bucket.slice(3).reduce((a, b) => a + b, 0),
    nearPct: +(nearFrames / Math.max(1, raceFrames) * 100).toFixed(0),
    ledPct: +(ledFrames / Math.max(1, raceFrames) * 100).toFixed(0),
    meanPos: +(posSum / Math.max(1, raceFrames)).toFixed(2),
    posBest, posWorst,
    lonelyTail: +lonelyTail.toFixed(1),
    nearestAtEnd: Math.round(Math.min(nearestAtEnd, 9999)),
    gapTrace,
    collisions: race.collisions,
    snaps,
    deepest: +deepest.toFixed(3), deepAt,
    touchPct: +(touchFrames / Math.max(1, frames) * 100).toFixed(2),
    rivalRecoveries: rows.filter(r => !r.isPlayer).reduce((a, b) => a + b.recoveries, 0),
    bands: race.entries.map((e, k) => ({
      name: e.name,
      pace: +e.pace.toFixed(3),
      band: +(bandSum[k] / Math.max(1, bandFrames)).toFixed(3),
      boost: +(boostSum[k] / Math.max(1, bandFrames)).toFixed(3),
      aheadPct: +(aheadN[k] / Math.max(1, bandFrames) * 100).toFixed(0),
      bandAhead: aheadN[k] ? +(bandAhead[k] / aheadN[k]).toFixed(3) : null,
      bandBehind: behindN[k] ? +(bandBehind[k] / behindN[k]).toFixed(3) : null,
    })),
  };
};

const all = {};
await run({ width: 640, height: 360, hash: 'manual' }, async ({ page }) => {
  page.setDefaultTimeout(900_000);
  for (const seed of SEEDS) {
    const o = await page.evaluate(SIM, [seed, SECS, SKILL, NEAR_M, LONELY_M, JITTER, GRID ? GRIDS[GRID] : null]);
    all[seed] = o;
    const order = o.rows
      .map(r => `${r.name}${r.finished ? ' ' + r.time.toFixed(1) : ' DNF@' + r.s}`)
      .join('   ');
    console.log(`\n═══ seed ${o.seed} — ${o.secs}s, all finished=${o.allFinished}`
      + `${o.wired ? '' : ' (field stepped by this tool)'} ═══`);
    console.log(`  ${order}`);
    console.log(`  player P${o.finalPos}${o.won ? ' — WON' : ''}`
      + `   spread ${o.spread === null ? '—' : o.spread.toFixed(1) + 's'}`
      + `   led ${o.ledPct}% of the race   mean position ${o.meanPos}`
      + ` (best P${o.posBest}, worst P${o.posWorst})`);
    console.log(`  overtakes ${o.overtakes} (player ${o.playerOvertakes}: ${o.gained} gained, ${o.lost} lost)`
      + `   lead changes ${o.leadChanges} (${o.playerLeadChanges} involving the player)`);
    console.log(`  lead changes by tenth  ${o.leadBucket.join(' ')}`);
    console.log(`  within ${NEAR_M} m of a rival ${o.nearPct}% of the race`
      + `   lonely tail ${o.lonelyTail}s   nearest at the flag ${o.nearestAtEnd} m`);
    console.log(`  overtakes by tenth  ${o.bucket.join(' ')}   (player ${o.playerBucket.join(' ')})`);
    console.log(`  nearest rival at each tenth  ${o.gapTrace.join(' ')} m`);
    console.log(`  impact episodes ${o.collisions}   deepest interpenetration ${o.deepest} m`
      + `${o.deepAt ? ` (${o.deepAt.pair} at s=${o.deepAt.s})` : ''}`
      + `   rival recoveries ${o.rivalRecoveries}`);
    console.log(`  opening   ${o.snaps.map(s => `t${s.t}s: P${s.pos} ${s.behind}m back,`
      + ` ${s.impacts} impacts, ${s.recoveries} rival recoveries`).join('   ')}`);
    for (const c of o.bands) {
      console.log(`    ${c.name.padEnd(7)} pace ${c.pace}  mean band ${c.band}`
        + `  mean boost ${c.boost}   ahead of the player ${String(c.aheadPct).padStart(3)}%`
        + ` of the race (band ${c.bandAhead ?? '—'} there, ${c.bandBehind ?? '—'} behind)`);
    }
  }

  // Same seed twice must give the same race. The module is specified as a pure
  // function of the seed, so any drift here is a bug and not noise.
  const again = await page.evaluate(SIM, [SEEDS[0], SECS, SKILL, NEAR_M, LONELY_M, JITTER, GRID ? GRIDS[GRID] : null]);
  const same = JSON.stringify(again.rows) === JSON.stringify(all[SEEDS[0]].rows);
  console.log(`\n  determinism (seed ${SEEDS[0]} re-run): ${same ? 'identical' : 'DIVERGED'}`);
  if (!same) process.exitCode = 1;
});

const list = SEEDS.map(s => all[s]).filter(Boolean);
const sum = (k) => list.reduce((a, o) => a + (o[k] ?? 0), 0);
const mean = (k) => sum(k) / Math.max(1, list.length);
const med = (arr) => {
  const a = arr.slice().sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : 0;
};
const spreads = list.map(o => o.spread).filter(x => x !== null);
const carsFinished = list.reduce((a, o) => a + o.finishers, 0);

console.log(`\n═══ ${list.length} seeds ═══`);
console.log(`  finish rate            ${list.filter(o => o.allFinished).length}/${list.length} races`
  + `, ${carsFinished}/${list.length * 4} cars`);
console.log(`  finish spread          mean ${mean('spread').toFixed(1)}s`
  + `   median ${med(spreads).toFixed(1)}s`
  + `   range ${Math.min(...spreads).toFixed(1)}–${Math.max(...spreads).toFixed(1)}s`);
console.log(`  lead changes           ${sum('leadChanges')} total, ${mean('leadChanges').toFixed(1)} a race`
  + `   (player-involved ${sum('playerLeadChanges')}, last seven tenths ${sum('lateLead')})`);
console.log(`  overtakes              ${sum('overtakes')} total, ${mean('overtakes').toFixed(1)} a race`
  + `   (player ${sum('playerOvertakes')}, ${mean('playerOvertakes').toFixed(1)} a race)`);
console.log(`  player passes          ${sum('gained')} made, ${sum('lost')} suffered`);
console.log(`  within ${NEAR_M} m of a rival  ${mean('nearPct').toFixed(0)}% of the race (mean over seeds)`);
console.log(`  player led             ${mean('ledPct').toFixed(0)}% of the race (mean over seeds)`);
console.log(`  player wins            ${list.filter(o => o.won).length}/${list.length}`
  + `   mean finishing position ${(list.reduce((a, o) => a + o.finalPos, 0) / list.length).toFixed(2)}`);
const pos = [1, 2, 3, 4].map(k => list.filter(o => o.finalPos === k).length);
console.log(`  finishing positions    P1 ${pos[0]}  P2 ${pos[1]}  P3 ${pos[2]}  P4 ${pos[3]}`);
console.log(`  lonely tail            mean ${mean('lonelyTail').toFixed(1)}s`
  + `   median ${med(list.map(o => o.lonelyTail)).toFixed(1)}s`
  + `   worst ${Math.max(...list.map(o => o.lonelyTail)).toFixed(1)}s`);
console.log(`  impact episodes        ${sum('collisions')} total, ${mean('collisions').toFixed(1)} a race`);
console.log(`  deepest interpenetration ${Math.max(...list.map(o => o.deepest)).toFixed(3)} m`
  + `   contact ${mean('touchPct').toFixed(2)}% of frames`);
console.log(`  rival recoveries       ${sum('rivalRecoveries')} total, ${mean('rivalRecoveries').toFixed(1)} a race`);
console.log(`  overtakes in the last seven tenths  ${sum('lateSeventy')}`);
for (const m of [5, 10, 20, 30, 45]) {
  const at = list.map(o => o.snaps.find(s => s.t === m)).filter(Boolean);
  if (!at.length) continue;
  const av = (k) => (at.reduce((a, s) => a + s[k], 0) / at.length).toFixed(2);
  console.log(`  by t=${String(m).padStart(2)}s   ${av('impacts')} impacts`
    + `   ${av('recoveries')} rival recoveries`
    + `   player mean position ${av('pos')}, ${av('behind')} m off the lead`);
}

const out = JSON_OUT || path.join(ROOT, '.meas', `${TAG}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ tag: TAG, seeds: SEEDS, secs: SECS, skill: SKILL, all }, null, 1));
console.log(`\n  → ${path.relative(ROOT, out)}`);
finish(process.exitCode || 0);
