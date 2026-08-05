/* Does the pause menu actually pause, and does resuming cost nothing?
 *
 * The brief for the shell asked for four things and every one of them is a
 * claim about a number, so every one of them is measured here rather than
 * argued from the source.
 *
 *   FROZEN. With the menu up, nothing moves: the car's distance, lateral
 *   offset, speed and race clock are sampled on all 300 paused frames and the
 *   spread across them is reported. Anything but a flat zero means something
 *   below the early return in Game.step is still running.
 *
 *   NO TIME DUMPED, twice over, because there are two clocks that could dump
 *   and they fail differently.
 *
 *     The FIXED-STEP accumulator, measured by determinism. One run of 900
 *     steps, and a second run of 900 steps with a 300-frame pause cut into the
 *     middle of it. If a single banked second arrives on the resume frame the
 *     two runs end in different places, and this compares them to the last
 *     digit. This is the strong form: it does not ask whether the dump is
 *     small, it asks whether there is one.
 *
 *     The WALL clock, measured against the real requestAnimationFrame loop —
 *     the one a player runs and the one no other tool in this directory ever
 *     starts, because every harness run passes `manual`. A tool stepping by
 *     hand cannot see this failure at all: `Game.frame` takes dt off
 *     THREE.Clock, and a clock left alone for the two seconds a menu is up
 *     hands the next caller two seconds. So this one runs the loop, holds a
 *     real pause for two real seconds, and reads the race clock across the
 *     resume.
 *
 *   AUDIO SILENT, AND RESUMING CLEANLY. The context's own state and its
 *   currentTime, before, during and after. A suspended AudioContext processes
 *   no audio by definition and its currentTime does not advance, which is
 *   both halves of the claim in one reading: silent while up, and — since
 *   every parameter in src/audio is written against currentTime — resuming at
 *   the phase it stopped at instead of fast-forwarding through the menu.
 *
 *   THE PICTURE FROZEN. three.js counts its own draws, so
 *   renderer.info.render.frame across a two-second pause is an exact answer
 *   to "was the world redrawn". It has to be zero, and not for performance:
 *   the ocean, the grass and the turbines take their uTime from
 *   performance.now() inside onBeforeRender, so they animate on any frame that
 *   is drawn at all, whatever the simulation is doing. A pause that kept
 *   rendering would say PAUSED over a rolling sea.
 *
 *   node tools/shfreeze.mjs
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const SEED = 22;
const HZ = 1 / 60;
const LEAD = 450, TAIL = 450, HELD = 300;

/* Every say() below sits inside a run() callback, and run() does not invoke its
   callback at all when the page throws during boot: it catches its own error,
   raises process.exitCode and returns. So a totally dead tree used to run zero
   checks, leave `bad` at 0 and print "every check passed". The tally alone
   cannot see that, because the thing it counts never happened.
   Hence the constant expected count, the same guard tools/check.mjs uses: a run
   that did not ask all 13 questions has not answered them either. */
const EXPECT = 13;
let bad = 0, asked = 0;
const say = (ok, line) => { asked++; if (!ok) bad++; console.log(`  ${ok ? '✓' : '✗'} ${line}`); };

/* ---------------------------------------------------------------------------
   Part one: stepped. Fixed-step determinism across a pause.
   --------------------------------------------------------------------------- */

const STEPPED = ([lead, held, tail, hz]) => {
  const g = window.__game;

  /* The fingerprint. Everything that integrates, at full precision, for the
     player and for all three rivals — a dumped step that moved only the AI
     would still be a dumped step. Race time is in here because it is the
     number the brief names, and it is counted in Car.step, which is below the
     early return. */
  const fp = () => {
    const one = c => [c.s, c.lat, c.speed, c.yaw, c.raceTime].map(v => (+v).toFixed(12)).join(',');
    return [one(g.player), ...g.race.cars.filter(c => c !== g.player).map(one)].join('|');
  };
  const sample = () => ({
    s: g.player.s, lat: g.player.lat, speed: g.player.speed,
    time: g.player.raceTime,
  });

  /* Both runs start from restart(), which the whole tools/ directory does for
     the reason zjdet.mjs exists: stepping from the grid without it inherits
     browser-start-dependent state. */
  const arm = () => { g.restart(); g.autopilot(true, 0.85); };

  arm();
  for (let i = 0; i < lead + tail; i++) g.step(hz);
  const control = fp();

  arm();
  for (let i = 0; i < lead; i++) g.step(hz);
  const atOpen = fp();
  g.pause.enabled = true;
  g.openPause();
  /* Every paused frame, not the first and last: a leak that ran for one frame
     and stopped would hide between two endpoints. */
  const during = [];
  for (let i = 0; i < held; i++) { g.step(hz); during.push(sample()); }
  const stillOpen = g.pause.active;
  const afterHeld = fp();
  g.closePause();
  for (let i = 0; i < tail; i++) g.step(hz);
  const test = fp();

  const spread = k => {
    const v = during.map(d => d[k]);
    return Math.max(...v) - Math.min(...v);
  };
  return {
    identical: control === test,
    frozen: afterHeld === atOpen,
    stillOpen, frames: during.length,
    ds: spread('s'), dlat: spread('lat'), dspeed: spread('speed'), dtime: spread('time'),
    heldTime: during.length ? during[0].time : null,
    control: control.slice(0, 78), test: test.slice(0, 78),
  };
};

console.log('\n─── stepped: does anything move, and does the resume dump a step? ───\n');
await run({ hash: `manual&tier=high&seed=${SEED}&cap=0` }, async ({ page }) => {
  const r = await page.evaluate(STEPPED, [LEAD, HELD, TAIL, HZ]);
  console.log(`  ${LEAD} steps, ${r.frames} paused frames, ${TAIL} steps`
    + `   (menu still up at the end of the hold: ${r.stillOpen ? 'yes' : 'NO'})`);
  console.log('');
  say(r.stillOpen, 'the menu stayed open for the whole hold');
  say(r.frozen, 'the world is bit-identical after the hold to before it');
  const flat = r.ds === 0 && r.dlat === 0 && r.dspeed === 0 && r.dtime === 0;
  say(flat, `nothing moved on any of ${r.frames} paused frames`
    + `   (spread: s ${r.ds}, lat ${r.dlat}, speed ${r.dspeed}, clock ${r.dtime})`);
  say(r.identical, 'a run with a pause cut into it ends where the run without one ends'
    + ' — no banked step');
  if (!r.identical) {
    console.log(`      control  ${r.control}`);
    console.log(`      test     ${r.test}`);
  }
  console.log(`\n    race clock while held: ${r.heldTime.toFixed(6)} s`);
});

/* ---------------------------------------------------------------------------
   Part two: the real loop. Wall clock, audio, and whether the world is drawn.
   --------------------------------------------------------------------------- */

/* No `manual`, so index.html calls begin() and the rAF loop is the player's.
   The countdown, the title and the ending are turned off by flag rather than
   by manual, because what is under test is the pause and two seconds spent
   watching a start light is two seconds not spent measuring. */
const LIVE = `tier=high&seed=${SEED}&cap=60&title=0&countdown=0&ending=0&pausemenu=1`;

const READ = () => {
  const g = window.__game;
  const ctx = g.audio && g.audio.ctx;
  return {
    time: g.player.raceTime, s: g.player.s,
    glFrames: g.renderer.info.render.frame,
    glCalls: g.renderer.info.render.calls,
    actx: ctx ? ctx.state : 'no context',
    aclock: ctx ? ctx.currentTime : 0,
    paused: g.pause.active,
    now: performance.now(),
  };
};

console.log('\n─── live: the player\'s own loop, a two-second pause, wall clock ───\n');
await run({ hash: LIVE }, async ({ page }) => {
  /* Audio is off until something asks for it. Autoplay is permitted in the
     harness (--autoplay-policy=no-user-gesture-required, harness.mjs), so
     this is the same call the first key press makes. */
  await page.evaluate(() => window.__game.audio.start());
  await page.waitForTimeout(1200);

  const before = await page.evaluate(READ);
  await page.evaluate(() => window.__game.openPause());
  /* One frame for the open to be seen by the loop, then read the baseline. */
  await page.waitForTimeout(120);
  const opened = await page.evaluate(READ);

  await page.waitForTimeout(2000);
  const held = await page.evaluate(READ);

  /* The resume, and the reading that matters: the race clock across the very
     first frames on the far side of it, which is where a banked pause would
     arrive.
   *
   * Taken inside one evaluate, over two rAF callbacks, and NOT by resuming and
   * then reading from Node. The first version of this did that and reported a
   * 0.0667 s advance, which it then failed against a one-frame threshold — but
   * a waitForTimeout plus an evaluate round-trip is a couple of hundred
   * milliseconds during which the loop is running normally, so what it had
   * actually measured was its own latency. The clock is expected to advance
   * here; the question is whether it advances by the frames that have really
   * elapsed or by the two seconds the menu was up, and only a window this
   * tight can tell those apart. `wall` is carried out with it so the answer is
   * a comparison rather than a threshold. */
  const across = await page.evaluate(() => new Promise(res => {
    const g = window.__game;
    const t0 = g.player.raceTime, w0 = performance.now();
    g.closePause();
    requestAnimationFrame(() => requestAnimationFrame(() => res({
      dt: g.player.raceTime - t0, wall: (performance.now() - w0) / 1000,
    })));
  }));
  const resumed = await page.evaluate(READ);
  await page.waitForTimeout(600);
  const later = await page.evaluate(READ);

  const wall = (held.now - opened.now) / 1000;
  const dumped = across.dt;

  console.log(`  paused for ${wall.toFixed(3)} s of wall clock\n`);
  console.log('              race clock    car s      GL frames    audio      audio clock');
  const row = (k, r) => console.log(`   ${k.padEnd(10)} ${r.time.toFixed(6).padStart(10)}`
    + ` ${r.s.toFixed(3).padStart(10)}   ${String(r.glFrames).padStart(9)}    `
    + `${r.actx.padEnd(10)} ${r.aclock.toFixed(4).padStart(8)}`);
  row('running', before);
  row('opened', opened);
  row('held 2s', held);
  row('resumed', resumed);
  row('+0.6s', later);
  console.log('');

  say(held.time === opened.time,
    `the race clock did not advance across ${wall.toFixed(2)} s of pause`
    + `   (${(held.time - opened.time).toFixed(9)} s)`);
  say(held.s === opened.s, 'the car did not move');
  say(held.glFrames === opened.glFrames,
    `the world was not redrawn once while paused   (${held.glFrames - opened.glFrames} draws)`);
  /* The one number the brief asks for by name. A dumped pause would put the
     whole 2 s here; a correct one puts the two frames that really ran, and
     Game.frame clamps a single dt to 0.05 s besides. */
  say(dumped <= 0.05 && dumped <= across.wall + HZ,
    `two frames across the resume advanced the clock by ${dumped.toFixed(6)} s`
    + ` in ${across.wall.toFixed(6)} s of wall clock — not the ${wall.toFixed(2)} s held`);
  say(later.time > resumed.time, 'and the clock is running again afterwards');
  say(held.actx === 'suspended',
    `the audio context was suspended while paused — no audio processed at all`);
  say(Math.abs(held.aclock - opened.aclock) < 0.02,
    `the audio clock did not advance either`
    + `   (${(held.aclock - opened.aclock).toFixed(4)} s over ${wall.toFixed(2)} s)`);
  say(later.actx === 'running' && later.aclock > held.aclock,
    'and it is running again after the resume, from the phase it stopped at');
  say(later.glFrames > resumed.glFrames, 'the world is being drawn again');
});

if (asked !== EXPECT) {
  console.log(`\n  ✗ only ${asked} of ${EXPECT} checks ran — the page did not survive`
    + ' long enough to be measured, so nothing below is a verdict\n');
} else if (bad) {
  console.log(`\n  ✗ ${bad} check(s) failed\n`);
} else {
  console.log('\n  ✓ every check passed: frozen while up, nothing banked, silent, clean resume\n');
}
/* `process.exitCode` and not 0: run() may have raised it for a page error this
   tool never classified, and a bare 0 would discard it. Raise, never lower. */
finish(bad || asked !== EXPECT ? 1 : (process.exitCode || 0));
