/* One race, start to finish, without stopping.
 *
 * Every capture tool here teleports to a station and shoots it. That is the
 * right way to compare two builds, and it is the wrong way to answer "does
 * this hang together as a race", because it destroys the two things a race is
 * made of: a clock that runs once, and a field whose order is a consequence
 * of what happened earlier.
 *
 * So this drives one continuous race from the grid, through the lights, to
 * the flag and past it, at a fixed 1/60 so the frame index IS the wall clock,
 * and records every frame. The pictures come out of the same run — baseline
 * frames on a fixed cadence for the rhythm read, and bursts around the
 * moments (each launch, the tunnel mouths, the flag) because a moment that
 * only works in motion cannot be judged from one still.
 *
 * The countdown is run properly: no bot on the wheel through the lights,
 * because Game.step skips the count for anything mechanical, and the count is
 * half of what a start line is. The AI takes over on the release frame.
 *
 *   node tools/zzrun.mjs [--seed 22] [--tag run22] [--skill 0.85] [--every 180]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const TAG = flag('tag', `run${SEED}`);
const SKILL = +flag('skill', 0.85);
const EVERY = +flag('every', 180);
const MAXF = +flag('max', 20000);

const outDir = path.join(ROOT, 'shots', TAG);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=1`,
}, async ({ page }) => {
  const meta = await page.evaluate(() => {
    const g = window.__game;
    g.setPaused(true);
    return {
      ...g.stageStats(),
      ramps: (g.track.ramps || []).map(r => ({
        lip: +r.lip.toFixed(0), pad0: +r.pad0.toFixed(0), land: +r.land.toFixed(0),
      })),
      tunnel: g.field?.tunnel
        ? { s0: +g.field.tunnel.s0.toFixed(0), s1: +g.field.tunnel.s1.toFixed(0) } : null,
    };
  });
  console.log(`\n  seed ${SEED} — ${meta.len} m, ${meta.drop} m drop`);

  /* The grid, set up the way the game itself starts. */
  await page.evaluate(() => {
    const g = window.__game;
    g.autopilot(false); g.botInput = null;
    g.player.placeAt(34, 0);
    g.player.raceTime = 0;
    g.player.finished = false;
    g.race.reset(34);
    g.resetSimClock();
    g.effects.reset();
    g.chase.started = false;
    g.countdown.arm();
    g.input.down.add('KeyW');
  });

  const shoot = async (name) => {
    const url = await page.evaluate(() => {
      const g = window.__game;
      g.renderOnce();
      g.hud.draw();
      const gl = g.renderer.domElement;
      const c = document.createElement('canvas');
      c.width = gl.width; c.height = gl.height;
      const x = c.getContext('2d');
      x.drawImage(gl, 0, 0);
      x.drawImage(g.hud.canvas, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    });
    fs.writeFileSync(path.join(outDir, name + '.png'),
      Buffer.from(url.split(',')[1], 'base64'));
  };

  /* Run a block of frames in the page and hand back one telemetry row per
     frame, stopping early on anything worth a burst of pictures. Batched so
     the round trip to node is not paid 12,000 times. */
  const block = (n) => page.evaluate(([n, skill, tunnel]) => {
    const g = window.__game, p = g.player;
    const rows = [];
    let stop = null;
    for (let i = 0; i < n; i++) {
      /* The lights are run by a human on the throttle; the AI takes the
         wheel on the frame the hold ends, because anything mechanical skips
         the count and the count is the thing being watched. */
      if (!g.countdown.alive && !g.bot) {
        g.input.down.delete('KeyW');
        g.autopilot(true, skill);
      }
      const wasAir = p.airborne, wasLaunch = p.launchId, wasFin = p.finished;
      const wasIn = tunnel && p.s >= tunnel.s0 && p.s <= tunnel.s1;
      g.step(1 / 60);

      const cars = g.race.entries.map(e => e.car);
      let nearAhead = Infinity, nearAny = Infinity;
      for (const c of cars) {
        const d = c.s - p.s;
        if (d > 0 && d < nearAhead) nearAhead = d;
        if (Math.abs(d) < nearAny) nearAny = Math.abs(d);
      }
      const d = g.countdown.display();
      rows.push({
        s: +p.s.toFixed(1), kmh: +p.kmh.toFixed(1), gear: p.gear + 1,
        pos: g.race.positionOf(p) ?? 1,
        delta: g.race.deltaFor(p) === null ? null : +g.race.deltaFor(p).toFixed(2),
        air: +p.height.toFixed(2), airborne: p.airborne,
        off: +p.offRoad.toFixed(2), hit: +p.lastImpact.toFixed(3),
        slip: +(p.slipAngle * 180 / Math.PI).toFixed(1),
        ts: +g.timeScale().toFixed(3),
        rt: +p.raceTime.toFixed(2),
        near: Number.isFinite(nearAny) ? +nearAny.toFixed(0) : null,
        ahead: Number.isFinite(nearAhead) ? +nearAhead.toFixed(0) : null,
        cd: d ? d.text : null,
        fin: p.finished,
      });
      const isIn = tunnel && p.s >= tunnel.s0 && p.s <= tunnel.s1;
      if (p.launchId !== wasLaunch) { stop = 'launch'; break; }
      if (wasAir && !p.airborne && p.launched) { stop = 'land'; break; }
      if (!wasIn && isIn) { stop = 'tunnel-in'; break; }
      if (wasIn && !isIn) { stop = 'tunnel-out'; break; }
      if (!wasFin && p.finished) { stop = 'flag'; break; }
    }
    return { rows, stop };
  }, [n, SKILL, meta.tunnel]);

  const log = [];
  const events = [];
  let f = 0, shots = 0, nextBase = 0;
  /* Frames still owed to a burst, as absolute indices. */
  const burst = new Set();

  const schedule = (from, offsets) => { for (const o of offsets) burst.add(from + o); };

  while (f < MAXF) {
    /* Never step past a frame something is owed a picture on. */
    const owed = [...burst].filter(i => i > f).sort((a, b) => a - b)[0];
    const nextStop = Math.min(owed ?? Infinity, nextBase > f ? nextBase : f + 1);
    const n = Math.max(1, Math.min(240, nextStop - f));
    const { rows, stop } = await block(n);
    for (const r of rows) log.push(r);
    f += rows.length;
    const cur = log[log.length - 1];

    if (stop) {
      events.push({ f, t: +(f / 60).toFixed(2), kind: stop, s: cur.s, kmh: cur.kmh });
      if (stop === 'launch') schedule(f, [0, 5, 10, 16, 24, 34, 46, 60, 78, 96, 120]);
      if (stop === 'land') schedule(f, [0, 3, 7, 12, 20, 32]);
      if (stop === 'tunnel-in') schedule(f, [0, 10, 25, 45, 70]);
      if (stop === 'tunnel-out') schedule(f, [0, 6, 14, 26, 45]);
      if (stop === 'flag') schedule(f, [0, 8, 20, 40, 70, 110, 170, 260, 400]);
    }

    const want = burst.has(f) || f >= nextBase;
    if (want) {
      const tag = burst.has(f) ? 'x' : 'b';
      await shoot(`${String(f).padStart(5, '0')}-${tag}-s${Math.round(cur.s)}`);
      shots++;
      burst.delete(f);
      if (f >= nextBase) nextBase = f + EVERY;
    }
    /* Keep running a little past the flag: what the game does after the line
       is part of what the player experiences and nothing else here looks. */
    if (cur.fin && f > (events.find(e => e.kind === 'flag')?.f ?? 0) + 420) break;
    if (cur.fin && burst.size === 0 && f > (events.find(e => e.kind === 'flag')?.f ?? 0) + 400) break;
  }

  const flagAt = events.find(e => e.kind === 'flag');
  const standings = await page.evaluate(() => window.__game.race.standings().map(x => ({
    position: x.position, name: x.name, isPlayer: x.isPlayer,
    finished: x.finished, time: +x.time.toFixed(2), s: +x.s.toFixed(0),
    recoveries: x.recoveries,
  })));

  /* ---- what the run says ------------------------------------------------ */
  const raced = log.slice(0, flagAt ? flagAt.f : log.length);
  const lap = flagAt ? raced[raced.length - 1].rt : null;
  console.log(`\n  lights out to flag: ${lap ? lap.toFixed(2) + ' s' : 'NEVER FINISHED'}`
    + `   ${f} frames, ${shots} captures`);

  console.log('\n  events');
  for (const e of events) {
    console.log(`    ${e.t.toFixed(2).padStart(7)} s  ${e.kind.padEnd(11)}`
      + ` s ${String(e.s).padStart(6)}  ${String(e.kmh).padStart(5)} km/h`);
  }

  console.log('\n  final standings');
  for (const s of standings) {
    console.log(`    ${s.position}  ${(s.isPlayer ? 'PLAYER' : s.name).padEnd(7)}`
      + ` ${s.finished ? s.time.toFixed(2) + ' s' : 'still running, s ' + s.s}`
      + `  ${s.recoveries} recoveries`);
  }

  /* Pacing. Where the speed actually sits over a lap is the difference
     between a racer and a drive, and the shape of it over time is the
     rhythm. */
  const kmh = raced.map(r => r.kmh);
  const band = (lo, hi) => +(100 * kmh.filter(v => v >= lo && v < hi).length / kmh.length).toFixed(1);
  console.log('\n  time by speed band');
  console.log(`    under 60   ${band(0, 60)}%      60-100  ${band(60, 100)}%`
    + `      100-140 ${band(100, 140)}%      over 140 ${band(140, 999)}%`);

  /* Position over the lap. An arcade race with one order from lights to flag
     has no story in it, whatever the corners look like. */
  let changes = 0;
  for (let i = 1; i < raced.length; i++) if (raced[i].pos !== raced[i - 1].pos) changes++;
  const held = {};
  for (const r of raced) held[r.pos] = (held[r.pos] || 0) + 1;
  console.log(`\n  position changed ${changes} times`);
  console.log('    time in each place  '
    + Object.keys(held).sort().map(k => `${k}: ${(100 * held[k] / raced.length).toFixed(0)}%`).join('   '));

  /* Company. The single most telling whole-lap number: how much of the race
     the player spends with another car near enough to matter. */
  const withCo = +(100 * raced.filter(r => r.near !== null && r.near < 60).length / raced.length).toFixed(1);
  const alone = +(100 * raced.filter(r => r.near !== null && r.near > 150).length / raced.length).toFixed(1);
  console.log(`\n  a rival inside 60 m   ${withCo}% of the race`);
  console.log(`  nearest rival past 150 m  ${alone}%`);
  /* And the longest single stretch of it. */
  let best = 0, cur2 = 0, bestAt = 0;
  for (let i = 0; i < raced.length; i++) {
    if (raced[i].near !== null && raced[i].near > 150) {
      cur2++;
      if (cur2 > best) { best = cur2; bestAt = i; }
    } else cur2 = 0;
  }
  console.log(`  longest stretch alone     ${(best / 60).toFixed(1)} s`
    + `  (${((bestAt - best) / 60).toFixed(0)}-${(bestAt / 60).toFixed(0)} s, `
    + `s ${raced[Math.max(0, bestAt - best)]?.s} to ${raced[bestAt]?.s})`);

  const offR = +(100 * raced.filter(r => r.off > 0.35).length / raced.length).toFixed(1);
  const hits = raced.filter(r => r.hit > 0.02).length;
  console.log(`\n  off the road ${offR}% of the lap, ${hits} frames of contact`);

  fs.writeFileSync(path.join(outDir, 'run.json'),
    JSON.stringify({ seed: +SEED, meta, lap, events, standings, log }, null, 0));
  console.log(`\n  → shots/${TAG}`);
});

finish(process.exitCode || 0);
