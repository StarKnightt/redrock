/* Can a player actually open the pause menu?
 *
 *   node tools/pausekey.mjs
 *
 * WHY THIS EXISTS, which is the same shape as the bug it caught.
 *
 * tools/shell.mjs opens the menu with `Game.openPause()` and says so in a
 * comment that reasons the input flag is unforgeable and treats that as the
 * finding. The flag IS unforgeable — `Input.update` recomputes every edge from
 * the key set and the pad before `Game.step` looks at anything, so a tool that
 * writes `input.pausePressed = true` has it overwritten on the next line. What
 * the comment does not notice is that this makes `openPause()` a path NO
 * PLAYER CAN REACH, so a suite built entirely on it photographs a menu that
 * the shipped game could not put on screen: `Game.step` opened it and then
 * called `stepPause(0)` on the same frame, where the still-true flag was read
 * as Escape-to-resume and closed it again. Zero visible frames, every device,
 * every platform, and eight tools' worth of green.
 *
 * So this file presses the key. Every open in it comes from a REAL Playwright
 * `page.keyboard` event or from a real rising edge on a synthetic pad's
 * button, and every verdict is read off `pause.active` SAMPLED PER FRAME. No
 * section calls `openPause`.
 *
 * TWO INSTRUMENT PROPERTIES THAT MAKE THE VERDICTS WORTH READING.
 *
 * 1. The keys are trusted. The `instrument` section asserts `isTrusted` and
 *    `repeat` on the events as the page received them. `new KeyboardEvent(...)`
 *    reports `isTrusted: false`, so a future refactor that quietly swaps the
 *    real keyboard for a synthesised one fails here rather than passing
 *    quietly — which is exactly the substitution that produced the defect.
 * 2. Opens and closes are counted by WRAPPING `Pause.open`/`Pause.close`, not
 *    inferred from `pause.active` between frames. The defect opens and closes
 *    inside ONE `Game.step`, so a between-frames sampler sees a flat line of
 *    `false` and can only report "it never opened". The wrappers report
 *    "opened once, closed once, same frame", which names the mechanism instead
 *    of describing the symptom.
 *
 * FAILURE IS THE DEFAULT. Every section is entered into `results` pre-failed
 * before the browser starts; only the bottom of a clean path clears it. A
 * section that throws leaves its reason standing, and a section that produces
 * no rows is a failure rather than a vacuous pass. Verified by reverting the
 * one-line fix in main.js and re-running — see .fix/FINDINGS-pause.md, which
 * records the output.
 *
 * READING THE EXIT CODE: `node tools/pausekey.mjs | tee log.txt` reports tee's
 * status. Redirect — `node tools/pausekey.mjs > log.txt 2>&1 ; echo $?`.
 *
 * No `page.screenshot()` anywhere in here, so `settleBoot` is not needed and
 * the boot-veil trap cannot apply: this tool reads game state, not pixels.
 * tools/shell.mjs and tools/hudparity.mjs own the pixels.
 *
 * The synthetic pad is tools/padkit.mjs — the one tools/pad.mjs uses, moved
 * there rather than copied, because two fakes drift.
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';
import { B, KIT } from './padkit.mjs';

/* Escape and Start, written out rather than imported from src/core/input.js:
   a gate that reads its expectations out of the file under test cannot notice
   that file changing. `B.start` is 9 and Escape is Escape. */
const PAUSE_KEY = 'Escape';

/* ---- in-page probe ------------------------------------------------------ */

const PROBE = () => {
  const g = window.__game;
  const p = g.pause;

  const open = p.open.bind(p);
  const close = p.close.bind(p);
  p.__opens = 0;
  p.__closes = 0;
  /* Instance properties shadowing the prototype's. `restart`, `goTo` and
     `autopilot` all call `close()` too, so every section resets the counters
     after its setup and before its measurement. */
  p.open = function () { const r = open(); if (r) p.__opens++; return r; };
  p.close = function () { const was = p.armed; close(); if (was) p.__closes++; };

  const keys = [];
  window.addEventListener('keydown', e => {
    keys.push({ code: e.code, trusted: e.isTrusted, repeat: e.repeat });
  }, true);

  window.__pk = {
    keys,
    takeKeys() { const k = keys.slice(); keys.length = 0; return k; },
    /* A car on the road, the lights out, the menu down and the player's gate
       ARMED. `pause.enabled` is false under `manual` (main.js:387) and this
       tool runs under `manual`, so arming it by hand is the only way to
       measure what a player gets — and it is what makes the fourth row of the
       instrument section a real negative control rather than a formality. */
    arm(enabled = true) {
      const k = window.__padkit;
      k.uninstall();
      k.grid();
      g.player.placeAt(120, 0);
      g.player.vx = 18;
      g.pause.enabled = enabled;
      p.__opens = 0;
      p.__closes = 0;
      keys.length = 0;
      return { s: g.player.s, raceTime: g.player.raceTime, active: g.pause.active };
    },
    reset() { p.__opens = 0; p.__closes = 0; },
    /**
     * Step n frames, sampling `pause.active` AFTER each one.
     *
     * The pad's timestamp is advanced per frame whether or not a button
     * moved, because a real pad's is and because a consumer is entitled to
     * ignore one whose is not.
     */
    sample(n) {
      const k = window.__padkit;
      const active = [];
      for (let i = 0; i < n; i++) {
        k.stamp();
        g.step(1 / 60);
        active.push(g.pause.active);
      }
      let lead = 0;
      for (const a of active) { if (!a) break; lead++; }
      return {
        n,
        opens: p.__opens,
        closes: p.__closes,
        /* Consecutive from the first sampled frame. A menu that flickers has
           a high `activeFrames` and a low `leadingTrue`; the defect has zero
           of both and one open and one close. */
        leadingTrue: lead,
        activeFrames: active.filter(Boolean).length,
        final: g.pause.active,
        index: g.pause.index,
        s: +g.player.s.toFixed(4),
        raceTime: +g.player.raceTime.toFixed(6),
        title: g.title.active,
      };
    },
    state() {
      return {
        active: g.pause.active, index: g.pause.index,
        s: +g.player.s.toFixed(4), raceTime: +g.player.raceTime.toFixed(6),
        title: g.title.active, opens: p.__opens, closes: p.__closes,
      };
    },
    pad: {
      install() { window.__padkit.install(); },
      uninstall() { window.__padkit.uninstall(); },
      btn(i, v) { window.__padkit.btn(i, v); },
      clear() { window.__padkit.clear(); },
    },
  };
  return true;
};

/* ---- sections ----------------------------------------------------------- */

/* The tool's own liveness, and the four rows that make everything below
   readable. Two negative controls, two positives; if the negatives do not hold
   the sections below are measuring nothing, and if the positives do not hold
   they are measuring a keyboard the page cannot see. */
async function sInstrument({ page, row }) {
  await page.evaluate(() => window.__pk.arm(true));

  const quiet = await page.evaluate(() => window.__pk.sample(60));
  row('negative control — 60 frames with nothing pressed opens nothing',
    quiet.activeFrames === 0 && quiet.opens === 0,
    `${quiet.activeFrames}/60 paused frames, ${quiet.opens} open(s)`, '0/60, 0 opens');

  await page.keyboard.down(PAUSE_KEY);
  const seen = await page.evaluate(() => ({
    keys: window.__pk.takeKeys(),
    inSet: window.__game.input.down.has('Escape'),
  }));
  const esc = seen.keys.find(k => k.code === 'Escape');
  row('a real page.keyboard Escape reaches the window and is TRUSTED',
    !!esc && esc.trusted === true && esc.repeat === false,
    esc ? `code ${esc.code} trusted ${esc.trusted} repeat ${esc.repeat}` : 'NO KEYDOWN SEEN',
    'Escape trusted true repeat false');
  row('and Input itself has it in the key set it reads edges from',
    seen.inSet === true, seen.inSet, true);

  await page.keyboard.up(PAUSE_KEY);
  await page.evaluate(() => window.__pk.sample(2));

  /* And that the shipped gate is a real gate. `pausemenu=0`/`manual` turns the
     menu off for tools; a real key must do nothing at all through it. If this
     row passes for the wrong reason — because the key is not arriving — the
     two rows above have already failed. */
  await page.evaluate(() => window.__pk.arm(false));
  await page.keyboard.press(PAUSE_KEY);
  const gated = await page.evaluate(() => window.__pk.sample(30));
  row('negative control — with pause.enabled false a real Escape opens nothing',
    gated.opens === 0 && gated.activeFrames === 0,
    `${gated.opens} open(s), ${gated.activeFrames}/30 paused frames`, '0 opens, 0/30');
}

/* One press. The menu has to still be there a second later. */
async function sOpen({ page, row }) {
  await page.evaluate(() => window.__pk.arm(true));
  /* Half a second of actual racing first, so the "nothing moved" row below
     compares two live numbers rather than two zeroes. */
  const before = await page.evaluate(() => window.__pk.sample(30));
  await page.keyboard.press(PAUSE_KEY);
  const r = await page.evaluate(() => window.__pk.sample(60));

  row('one real Escape press opens the menu and it STAYS open for 60 frames',
    r.leadingTrue === 60 && r.opens === 1 && r.closes === 0,
    `paused on ${r.leadingTrue} consecutive of 60 frames, ${r.opens} open(s), ${r.closes} close(s)`,
    '60 consecutive, 1 open, 0 closes');
  row('the cursor is on RESUME, as it is on every open',
    r.index === 0, `index ${r.index}`, 0);
  /* The menu is only worth opening if it stops the world. shfreeze owns the
     bit-identity argument; this is the cheap version, on the frames this tool
     already has, so a menu that draws over a running race fails HERE too. */
  row('and nothing moved behind it — the race clock is where the press left it',
    before.raceTime > 0 && r.raceTime === before.raceTime && r.s === before.s,
    `after 30 racing frames s ${before.s} m / raceTime ${before.raceTime} s,`
    + ` after 60 paused frames s ${r.s} m / raceTime ${r.raceTime} s`,
    'a running clock, then the same numbers');
}

/* Exactly one toggle per press, not sixty. */
async function sToggle({ page, row }) {
  await page.evaluate(() => window.__pk.arm(true));
  await page.keyboard.press(PAUSE_KEY);
  const up = await page.evaluate(() => window.__pk.sample(10));
  row('setup — the menu is up', up.final === true && up.opens === 1,
    `active ${up.final}, ${up.opens} open(s)`, 'active, 1 open');

  await page.evaluate(() => window.__pk.reset());
  await page.keyboard.press(PAUSE_KEY);
  const down = await page.evaluate(() => window.__pk.sample(60));
  row('a second real Escape press closes it, on the frame of the press',
    down.closes === 1 && down.activeFrames === 0,
    `${down.closes} close(s), still paused on ${down.activeFrames}/60 frames after`,
    '1 close, 0/60');
  row('and it is exactly one toggle — the menu does not come back on its own',
    down.opens === 0 && down.final === false,
    `${down.opens} re-open(s), active ${down.final}`, '0 re-opens, inactive');

  /* Toggle again, so the round trip is proved rather than the two halves. */
  await page.evaluate(() => window.__pk.reset());
  await page.keyboard.press(PAUSE_KEY);
  const again = await page.evaluate(() => window.__pk.sample(30));
  row('and it re-arms: a third press opens it again and it stays open',
    again.opens === 1 && again.leadingTrue === 30,
    `${again.opens} open(s), paused on ${again.leadingTrue} consecutive of 30`,
    '1 open, 30 consecutive');
}

/* A key held down, with the OS auto-repeat a real held key produces. */
async function sHeld({ page, row }) {
  await page.evaluate(() => window.__pk.arm(true));

  /* Playwright marks a second `down` on an already-down key as autoRepeat,
     which is what an OS key repeat looks like to the page. Interleaved with
     the frames rather than fired all at once, because a repeat that arrives
     between two `Input.update` calls is the case that can produce a second
     edge. */
  await page.keyboard.down(PAUSE_KEY);
  const parts = [];
  for (let i = 0; i < 3; i++) {
    parts.push(await page.evaluate(() => window.__pk.sample(20)));
    await page.keyboard.down(PAUSE_KEY);           // auto-repeat
  }
  const seen = await page.evaluate(() => window.__pk.takeKeys());
  const repeats = seen.filter(k => k.code === 'Escape' && k.repeat).length;
  const last = parts[parts.length - 1];
  /* Consecutive across the concatenation of the three 20-frame slices: stop
     counting at the first slice that broke, so a flicker in the middle cannot
     be summed away by the slices either side of it. */
  let lead = 0;
  for (const p of parts) { lead += p.leadingTrue; if (p.leadingTrue < p.n) break; }

  row('the held key really did auto-repeat — otherwise this section proves nothing',
    repeats >= 3, `${repeats} repeat keydown(s) delivered`, '>= 3');
  row('Escape held for 60 frames is exactly ONE open, not an open/close flicker',
    last.opens === 1 && last.closes === 0,
    `${last.opens} open(s), ${last.closes} close(s) over 60 held frames`, '1 open, 0 closes');
  row('and the menu was up on all 60 of them',
    lead === 60, `${lead}/60 consecutive paused frames`, '60/60');

  await page.keyboard.up(PAUSE_KEY);
  const after = await page.evaluate(() => window.__pk.sample(10));
  row('releasing the key changes nothing — a release is not an edge',
    after.opens === 1 && after.closes === 0 && after.final === true,
    `${after.opens} open(s), ${after.closes} close(s), active ${after.final}`,
    '1 open, 0 closes, still up');
}

/* The same three, on a pad's Start button. */
async function sPad({ page, row }) {
  const b = B.start;

  const one = await page.evaluate(([start]) => {
    const pk = window.__pk, k = window.__padkit;
    pk.arm(true);
    k.install();
    pk.reset();
    k.btn(start, 1);                    // the rising edge
    const held = pk.sample(60);         // and never released
    k.btn(start, 0);
    const released = pk.sample(10);
    return { held, released };
  }, [b]);

  row('a real pad Start edge opens the menu and it STAYS open for 60 frames',
    one.held.leadingTrue === 60 && one.held.opens === 1 && one.held.closes === 0,
    `paused on ${one.held.leadingTrue} consecutive of 60, ${one.held.opens} open(s), ${one.held.closes} close(s)`,
    '60 consecutive, 1 open, 0 closes');
  row('Start HELD for those 60 frames is one open, not sixty toggles',
    one.held.opens === 1, `${one.held.opens} open(s) while held`, 1);
  row('and letting go of Start is not an edge',
    one.released.opens === 1 && one.released.closes === 0 && one.released.final === true,
    `${one.released.opens} open(s), ${one.released.closes} close(s), active ${one.released.final}`,
    'still up, nothing new');

  const two = await page.evaluate(([start]) => {
    const pk = window.__pk, k = window.__padkit;
    pk.reset();
    k.btn(start, 1);
    const closed = pk.sample(60);
    k.btn(start, 0);
    pk.sample(2);
    return closed;
  }, [b]);
  row('a second Start press closes it — exactly one toggle per press',
    two.closes === 1 && two.opens === 0 && two.activeFrames === 0,
    `${two.closes} close(s), ${two.opens} re-open(s), paused on ${two.activeFrames}/60 after`,
    '1 close, 0 re-opens, 0/60');

  await page.evaluate(() => { window.__padkit.uninstall(); window.__pk.arm(true); });
}

/* The three ways out, each reached by pressing keys rather than by calling a
 * method. Each one asserts WHERE THE CURSOR IS before confirming: without
 * that, a broken menuDown would silently confirm RESUME three times and this
 * section would report three passes.
 */
async function sActions({ page, row }) {
  /* RESUME. */
  let before = await page.evaluate(() => window.__pk.arm(true));
  await page.keyboard.press(PAUSE_KEY);
  let at = await page.evaluate(() => window.__pk.sample(5));
  await page.keyboard.press('Enter');
  let after = await page.evaluate(() => window.__pk.sample(5));
  row('RESUME — Escape then Enter on the top item puts the world back',
    at.index === 0 && at.final === true && after.final === false
    && !after.title && after.raceTime > before.raceTime,
    `cursor ${at.index} -> menu ${after.final ? 'up' : 'down'}, title ${after.title},`
    + ` raceTime ${before.raceTime} -> ${after.raceTime} s`,
    'cursor 0, down, no title, clock running again');

  /* RESTART. The car is at 120 m and has to end up back on the grid at 34. */
  before = await page.evaluate(() => window.__pk.arm(true));
  await page.keyboard.press(PAUSE_KEY);
  await page.evaluate(() => window.__pk.sample(3));
  await page.keyboard.press('ArrowDown');
  at = await page.evaluate(() => window.__pk.sample(1));
  await page.keyboard.press('Enter');
  after = await page.evaluate(() => window.__pk.sample(3));
  row('RESTART — Escape, down one, Enter puts the car back on the grid',
    at.index === 1 && after.final === false && !after.title
    && Math.abs(after.s - 34) < 2,
    `cursor ${at.index}, car ${before.s} -> ${after.s} m, menu ${after.final ? 'up' : 'down'}`,
    'cursor 1, car at 34 m, menu down');

  /* TO TITLE. */
  before = await page.evaluate(() => window.__pk.arm(true));
  await page.keyboard.press(PAUSE_KEY);
  await page.evaluate(() => window.__pk.sample(3));
  await page.keyboard.press('ArrowDown');
  await page.evaluate(() => window.__pk.sample(1));
  await page.keyboard.press('ArrowDown');
  at = await page.evaluate(() => window.__pk.sample(1));
  await page.keyboard.press('Enter');
  after = await page.evaluate(() => window.__pk.sample(3));
  row('TO TITLE — Escape, down twice, Enter goes to the poster',
    at.index === 2 && after.final === false && after.title === true,
    `cursor ${at.index}, menu ${after.final ? 'up' : 'down'}, title ${after.title}`,
    'cursor 2, menu down, title up');

  /* And the cursor wraps, which is how a player who overshoots gets back.
     `arm()` goes through `restart()`, which calls `title.skip()` — without
     that the poster left up by the row above owns the frame and Escape never
     reaches the pause branch at all (main.js:963 is above 965). */
  await page.evaluate(() => window.__pk.arm(true));
  await page.keyboard.press(PAUSE_KEY);
  await page.evaluate(() => window.__pk.sample(3));
  await page.keyboard.press('ArrowUp');
  at = await page.evaluate(() => window.__pk.sample(1));
  row('the cursor wraps: UP from RESUME is TO TITLE',
    at.index === 2 && at.final === true, `index ${at.index}, menu up ${at.final}`,
    'index 2, up');
  await page.keyboard.press(PAUSE_KEY);
  await page.evaluate(() => window.__pk.sample(2));
}

/* ---- driver ------------------------------------------------------------- */

const SECTIONS = [
  ['instrument', 'the instrument itself', sInstrument],
  ['open', 'a real Escape opens the menu', sOpen],
  ['toggle', 'one toggle per press', sToggle],
  ['held', 'Escape held down', sHeld],
  ['pad', 'a real Start edge on a pad', sPad],
  ['actions', 'the three items, reached by key', sActions],
];

/* Pre-failed, before a browser exists. */
const results = new Map(SECTIONS.map(([id]) =>
  [id, { fail: 'section never reported a verdict', rows: [] }]));

const out = await run({ width: 480, height: 270, hash: 'manual&seed=22' }, async ({ page }) => {
  await page.evaluate(KIT);
  await page.evaluate(PROBE);
  for (const [id, , fn] of SECTIONS) {
    const rec = results.get(id);
    const rows = [];
    const row = (name, ok, got, want) =>
      rows.push({ name, ok: !!ok, got: String(got), want: String(want) });
    try {
      await fn({ page, row });
    } catch (e) {
      rec.rows = rows;
      rec.fail = 'section threw: ' + String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 160);
      continue;
    }
    if (!rows.length) { rec.fail = 'section produced no rows — nothing was measured'; continue; }
    rec.rows = rows;
    const bad = rows.filter(r => !r.ok);
    rec.fail = bad.length ? `${bad.length} of ${rows.length} checks failed` : null;
  }
});

let total = 0, failed = 0;
for (const [id, title] of SECTIONS) {
  const rec = results.get(id);
  console.log(`\n  ${title}`);
  if (rec.fail && !rec.rows.length) console.log(`    ✗ ${rec.fail}`);
  for (const r of rec.rows) {
    total++;
    if (!r.ok) failed++;
    console.log(`    ${r.ok ? '✓' : '✗'} ${r.name}`);
    console.log(`        got ${r.got}${r.ok ? '' : `   want ${r.want}`}`);
  }
  if (rec.fail && rec.rows.length && rec.fail.startsWith('section threw')) {
    console.log(`    ✗ ${rec.fail}`);
  }
}

const dead = SECTIONS.filter(([id]) => results.get(id).fail);
console.log('');
if (dead.length) {
  console.log(`  ${dead.length} of ${SECTIONS.length} section(s) FAILED`);
  for (const [id] of dead) console.log(`    ${id.padEnd(11)} ${results.get(id).fail}`);
  console.log('');
  console.log('  If `open` reports 1 open and 1 close with 0 paused frames, the menu is being');
  console.log('  opened and closed inside one Game.step: the edge that opened it was read a');
  console.log('  second time as Escape-to-resume. See main.js — Game.step must pass the');
  console.log('  `opening` flag to stepPause, and stepPause must not take RESUME on it.');
} else {
  console.log(`  ✓ all ${total} checks passed across ${SECTIONS.length} sections`);
}

/* A gate with nothing in it has not passed. */
if (!total) {
  console.log('  FAIL no checks ran at all');
  process.exitCode = 1;
}
if (dead.length || failed) process.exitCode = 1;
if (out && out.errs && out.errs.some(e => e.startsWith('[pageerror]'))) process.exitCode = 1;
finish(process.exitCode || 0);
