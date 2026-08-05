/* Does the gamepad path actually work, on a pad?
 *
 * Everything in src/core/input.js's pad branch had been written and never
 * driven, because driving it needs a pad and CI does not have hands. So this
 * injects one: a synthetic standard-mapping gamepad whose axes, buttons and
 * timestamp are mutated from the probe between frames, stepped through the
 * real `Game.step` so every reading is taken off the same code path a player
 * would use.
 *
 *   node tools/pad.mjs
 *
 * WHY NOT page.addInitScript, which is the obvious way to do this.
 * `harness.run()` owns `page.goto` and hands the body a page that has already
 * loaded, so there is no hook to install anything ahead of it. That turns out
 * not to matter, and the tool proves it rather than assuming it: `Input.update`
 * calls `navigator.getGamepads()` fresh on every frame and nothing captures the
 * function at module load or in the constructor, so an override installed after
 * boot is read on the very next frame. See the INSTALL section, whose first two
 * rows are a negative control — a frame stepped with the stick at full lock and
 * NO pad installed, which must read a steer of exactly zero.
 *
 * FAILURE IS THE DEFAULT. Every section is entered into `results` pre-failed
 * before the browser starts, and only the bottom of a clean path clears it; a
 * probe that throws leaves the pre-set reason standing, and a section that
 * returns no rows at all is a failure rather than a vacuous pass. The exit code
 * is the maximum of this tool's verdict and whatever the harness already set —
 * it is never assigned downwards, and `finish(0)` is never called. Both of
 * those are the bugs tools/boot.mjs's header documents, and they are repeated
 * here because they are repeatable.
 *
 * READING THE EXIT CODE: `node tools/pad.mjs | tee log.txt` reports tee's
 * status. Redirect — `node tools/pad.mjs > log.txt 2>&1 ; echo $?`.
 *
 * The fake is honest. 17 buttons each `{pressed, touched, value}`, four axes,
 * `mapping: 'standard'`, `connected: true`, `index: 0`, and a timestamp that
 * advances on every mutation AND on every frame, because a real pad's does and
 * because a consumer is entitled to ignore one whose does not.
 *
 * The button indices below are written out rather than imported from
 * src/core/input.js, deliberately: a gate that reads its expectations out of
 * the file under test cannot notice that file changing.
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const B = {
  south: 0, east: 1, west: 2, north: 3,
  l1: 4, r1: 5, l2: 6, r2: 7,
  select: 8, start: 9,
  dpadUp: 12, dpadDown: 13,
};

/* The steering table, computed by hand from the two constants in input.js —
   a 0.14 deadzone rescaled over the remaining 0.86, then squared, sign kept:
   steer = sign(d) * d^2 where d = (|ax| - 0.14) / 0.86. Written out as
   literals rather than as the expression, for the reason above. */
const STEER_TABLE = [
  [-1.00, -1.0000000000],
  [-0.75, -0.5031097891],
  [-0.50, -0.1752298540],
  [-0.15, -0.0001352082],
  [-0.14, 0],
  [-0.13, 0],
  [0.00, 0],
  [0.13, 0],
  [0.14, 0],
  [0.15, 0.0001352082],
  [0.50, 0.1752298540],
  [0.75, 0.5031097891],
  [1.00, 1.0000000000],
];

/* ---- in-page kit ------------------------------------------------------- */

const KIT = () => {
  const g = window.__game;
  /* The rAF loop must not step behind a probe. Every section re-asserts this
     because a section that forgets it measures frames it did not ask for. */
  g.setPaused(true);

  const pad = {
    index: 0,
    id: 'redrock synthetic pad (standard mapping)',
    mapping: 'standard',
    connected: true,
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 },
      () => ({ pressed: false, touched: false, value: 0 })),
  };
  const real = navigator.getGamepads ? navigator.getGamepads.bind(navigator) : null;

  const k = {
    pad,
    rows: [],
    install() { navigator.getGamepads = () => [pad, null, null, null]; },
    uninstall() { navigator.getGamepads = real || (() => []); },
    /* Every poll of a live pad returns a fresher timestamp, whether or not
       anything on it moved. */
    stamp() { pad.timestamp += 1000 / 60; },
    axis(i, v) { pad.axes[i] = v; k.stamp(); },
    /* A digital button, as a well-behaved pad reports one. */
    btn(i, v) {
      const b = pad.buttons[i];
      b.value = v; b.pressed = v > 0.1; b.touched = b.pressed;
      k.stamp();
    },
    /* A badly-behaved one, field by field. */
    raw(i, o) { Object.assign(pad.buttons[i], o); k.stamp(); },
    clear() {
      pad.axes.fill(0);
      for (const b of pad.buttons) { b.pressed = false; b.touched = false; b.value = 0; }
      pad.connected = true;
      pad.mapping = 'standard';
      k.stamp();
    },
    step(n = 1) { for (let j = 0; j < n; j++) { k.stamp(); g.step(1 / 60); } },
    read() {
      const i = g.input;
      return {
        steer: i.steer, throttle: i.throttle, brake: i.brake, handbrake: i.handbrake,
        lookBack: i.lookBack, reset: i.resetPressed, skip: i.skipPressed,
        pause: i.pausePressed, confirm: i.confirmPressed,
        up: i.menuUpPressed, down: i.menuDownPressed,
      };
    },
    frame() { k.step(1); return k.read(); },
    /* On `window`, which is exactly the target Input attaches to. */
    key(code, down) {
      window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup',
        { code, bubbles: true, cancelable: true }));
    },
    /* Back to a car that can move: restart() arms the countdown
       unconditionally (main.js:1523), so a probe that wants the car to drive
       has to put the lights out itself. */
    grid() {
      g.autopilot(false);
      g.botInput = null;
      g.restart();
      g.countdown.skip();
      g.ending.skip();
      g.pause.close();
      k.clear();
    },
    row(name, ok, got, want) { k.rows.push({ name, ok: !!ok, got: String(got), want: String(want) }); },
    near(a, b, tol) { return Math.abs(a - b) <= tol; },
    take() { const r = k.rows; k.rows = []; return { rows: r }; },
  };
  window.__padkit = k;
  return true;
};

/* ---- sections ---------------------------------------------------------- */

/* The instrument's own liveness. Two negative controls and one positive: if
   the first two do not hold, everything below is measuring a pad the game
   cannot see, and if the third does not, it is measuring nothing at all. */
const S_INSTALL = () => {
  const k = window.__padkit;
  k.grid();
  k.uninstall();
  k.axis(0, 1);
  let r = k.frame();
  k.row('negative control — no pad installed, full lock reads steer 0',
    r.steer === 0, r.steer, 0);
  const seen = (navigator.getGamepads() || []).filter(p => p && p.connected).length;
  k.row('negative control — the browser itself reports no connected pad',
    seen === 0, seen, 0);
  k.install();
  r = k.frame();
  k.row('the injected pad is read on the very next frame',
    r.steer > 0.99, r.steer.toFixed(6), '> 0.99');
  const p = (navigator.getGamepads() || []).find(x => x && x.connected);
  k.row('and it is honest: 17 buttons, 4 axes, standard mapping, live timestamp',
    !!p && p.buttons.length === 17 && p.axes.length === 4
    && p.mapping === 'standard' && p.timestamp > 0
    && p.buttons.every(b => typeof b.pressed === 'boolean'
      && typeof b.touched === 'boolean' && typeof b.value === 'number'),
    p ? `${p.buttons.length}b ${p.axes.length}ax ${p.mapping} t=${p.timestamp.toFixed(0)}` : 'NO PAD',
    '17b 4ax standard t>0');
  return k.take();
};

const S_STEER = ([table]) => {
  const k = window.__padkit;
  k.grid();
  k.install();
  for (const [ax, want] of table) {
    k.clear();
    k.axis(0, ax);
    const r = k.frame();
    k.row(`stick ${(ax >= 0 ? '+' : '') + ax.toFixed(2)}`,
      k.near(r.steer, want, 1e-7), r.steer.toFixed(10), want.toFixed(10));
  }
  /* The squaring, stated as a ratio against full lock rather than by
     recomputing the formula the table already pins. */
  k.clear(); k.axis(0, 1);
  const full = k.frame().steer;
  k.clear(); k.axis(0, 0.5);
  const half = k.frame().steer;
  const linear = (0.5 - 0.14) / 0.86;
  k.row('half stick is about a quarter of the command, not half',
    half / full > 0.12 && half / full < 0.26,
    `${(half / full).toFixed(4)} of full lock (linear would be ${linear.toFixed(4)})`,
    '0.12 .. 0.26');
  /* And that the deadzone is where it says it is, either side of it. */
  k.clear(); k.axis(0, 0.13);
  const under = k.frame().steer;
  k.clear(); k.axis(0, 0.15);
  const over = k.frame().steer;
  k.row('the 0.14 deadzone rejects 0.13 and passes 0.15',
    under === 0 && over > 0, `0.13 -> ${under}, 0.15 -> ${over.toExponential(4)}`,
    '0 and non-zero');
  return k.take();
};

const S_TRIGGERS = ([b]) => {
  const k = window.__padkit;
  k.grid();
  k.install();
  const one = (label, mutate, field, want, tol) => {
    k.clear();
    mutate();
    const r = k.frame();
    k.row(label, k.near(r[field], want, tol === undefined ? 1e-9 : tol),
      r[field], want);
  };
  one('right trigger 0.25 -> throttle', () => k.btn(b.r2, 0.25), 'throttle', 0.25);
  one('right trigger 0.50 -> throttle', () => k.btn(b.r2, 0.50), 'throttle', 0.50);
  one('right trigger 1.00 -> throttle', () => k.btn(b.r2, 1.00), 'throttle', 1.00);
  one('left trigger 0.37 -> brake', () => k.btn(b.l2, 0.37), 'brake', 0.37);
  one('south (A) -> handbrake', () => k.btn(b.south, 1), 'handbrake', 1);

  /* The pads that report `pressed` and leave `value` at zero. */
  one('trigger reporting pressed with value 0 -> full throttle',
    () => k.raw(b.r2, { pressed: true, touched: true, value: 0 }), 'throttle', 1);
  one('the same on the brake',
    () => k.raw(b.l2, { pressed: true, touched: true, value: 0 }), 'brake', 1);
  one('and on the handbrake button',
    () => k.raw(b.south, { pressed: true, touched: true, value: 0 }), 'handbrake', 1);

  /* And that the fallback cannot make an analogue pad worse. A real trigger
     at rest reports pressed:false and value 0, and must stay at 0; one barely
     touched must pass its own small value through rather than being rounded
     up to a full press by either field. */
  one('analogue trigger at rest stays 0',
    () => k.raw(b.r2, { pressed: false, touched: false, value: 0 }), 'throttle', 0);
  one('analogue trigger barely touched passes 0.02 through',
    () => k.raw(b.r2, { pressed: false, touched: true, value: 0.02 }), 'throttle', 0.02);
  one('a pad that latches pressed early still reports its own 0.02',
    () => k.raw(b.r2, { pressed: true, touched: true, value: 0.02 }), 'throttle', 0.02);
  return k.take();
};

/* Does a synthetic pad drive the car? Three runs from an identical state, the
   only difference being the stick, so the track's own curvature cancels. */
const S_DRIVE = () => {
  const k = window.__padkit, g = window.__game, p = g.player;
  k.install();
  const out = {};
  for (const ax of [0, 1, -1]) {
    k.grid();
    p.placeAt(40, 0); p.vx = 20; p.vy = 0; p.r = 0;
    const s0 = p.s;
    k.axis(0, ax);
    k.btn(7, 0.5);                       // half throttle, off the analogue trigger
    k.step(90);                          // 1.5 s
    out[ax] = { lat: p.lat, ds: p.s - s0, kmh: p.kmh };
  }
  k.row('the pad drives the car down the road',
    out[0].ds > 20, `${out[0].ds.toFixed(1)} m in 1.5 s at ${out[0].kmh.toFixed(0)} km/h`,
    '> 20 m');
  k.row('full right moves the car right of the straight-ahead run',
    out[1].lat - out[0].lat > 1,
    `lat ${out[1].lat.toFixed(2)} m vs ${out[0].lat.toFixed(2)} m straight`,
    '> 1 m to the right');
  k.row('full left moves it left of the same run',
    out[0].lat - out[-1].lat > 1,
    `lat ${out[-1].lat.toFixed(2)} m vs ${out[0].lat.toFixed(2)} m straight`,
    '> 1 m to the left');
  return k.take();
};

/* Start, held. The whole reason `_padWas` exists.
 *
 * COUNTED AT THE INPUT LAYER, on `pausePressed`, and not on `pause.active`,
 * and that is a deliberate retreat from what this section measured first.
 * Counting menu toggles finds zero of them — but so does the KEYBOARD, because
 * `Game.step` opens the menu and then calls `stepPause(0)` on the same frame,
 * where the still-true `pausePressed` is read as RESUME and closes it again.
 * That defect is in main.js, predates this round, is identical on both input
 * devices, and is written up in .fix/FINDINGS-pad.md; it is not a pad gap and
 * fixing it would change what a keyboard player experiences, which this round
 * may not do. What IS this file's business is that the pad produces exactly
 * ONE edge per press however long the button is held, and that is what the
 * first three rows below pin — against the keyboard, whose edge is generated
 * by a completely different mechanism and must agree.
 */
const S_SHELL = ([b]) => {
  const k = window.__padkit, g = window.__game;
  k.grid();
  k.install();
  g.pause.enabled = true;

  const edges = (frames) => {
    let n = 0;
    for (let i = 0; i < frames; i++) { k.step(1); if (g.input.pausePressed) n++; }
    return n;
  };
  k.btn(b.start, 1);
  const held = edges(60);
  k.row('Start held for 60 frames is exactly one pause edge',
    held === 1, `${held} edge(s) in 60 frames`, 1);
  k.btn(b.start, 0);
  k.row('and releasing it is none', edges(10) === 0, 0, 0);
  k.btn(b.start, 1);
  const again = edges(30);
  k.row('a second press is one more — the edge re-arms', again === 1, again, 1);
  k.btn(b.start, 0); k.step(2);

  /* The keyboard's Escape, through the same counter, so the two mechanisms
     can be compared rather than each judged against a number in this file. */
  k.uninstall();
  k.key('Escape', true);
  const kbHeld = edges(60);
  k.key('Escape', false);
  k.step(2);
  k.install();
  k.row('and the keyboard agrees: Escape held is one edge too',
    kbHeld === held, `${kbHeld} edge(s) in 60 frames vs the pad's ${held}`, held);

  /* Now the menu itself, opened the way tools/shell.mjs opens it — through
     Game.openPause, which is what the edge above would call if main.js let it.
     Everything past this point IS driven through Game.step by the pad. */
  k.clear();
  g.openPause();
  k.step(1);
  k.row('the menu is up with the cursor at the top',
    g.pause.active && g.pause.index === 0, `active ${g.pause.active} index ${g.pause.index}`,
    'active index 0');
  k.axis(1, 1);
  k.step(60);
  const afterHold = g.pause.index;
  k.row('stick DOWN held at full deflection for 60 frames moves exactly one item',
    afterHold === 1, `index ${afterHold}`, 1);
  k.axis(1, 0.5);                        // above OFF, below ON — the hysteresis band
  k.step(30);
  k.row('easing back to 0.5 — inside the hysteresis band — moves nothing',
    g.pause.index === afterHold, `index ${g.pause.index}`, afterHold);
  k.axis(1, 0);
  k.step(2);
  k.axis(1, 1);
  k.step(1);
  k.row('centring and flicking again moves exactly one more',
    g.pause.index === 2, `index ${g.pause.index}`, 2);
  k.axis(1, 0); k.step(2);
  k.axis(1, -1); k.step(30);
  k.row('stick UP moves back one', g.pause.index === 1, `index ${g.pause.index}`, 1);
  k.axis(1, 0); k.step(2);

  /* A stick that never leaves the band cannot start a step either. */
  k.axis(1, 0.5); k.step(60);
  k.row('a stick resting at 0.5 for 60 frames never steps the menu',
    g.pause.index === 1, `index ${g.pause.index}`, 1);
  k.axis(1, 0); k.step(2);

  const before = g.pause.index;
  k.btn(b.dpadDown, 1); k.step(45); k.btn(b.dpadDown, 0); k.step(2);
  k.row('the d-pad is an edge too: down held 45 frames moves one item',
    g.pause.index === (before + 1) % 3, `index ${before} -> ${g.pause.index}`,
    (before + 1) % 3);
  k.btn(b.dpadUp, 1); k.step(45); k.btn(b.dpadUp, 0); k.step(2);
  k.row('and up moves back', g.pause.index === before, `index ${g.pause.index}`, before);

  /* East (B) is folded into the pause edge, which is what makes it back out. */
  const upBefore = g.pause.active;
  k.btn(b.east, 1); k.step(1); k.btn(b.east, 0); k.step(1);
  k.row('east (B) backs out of the menu', upBefore && !g.pause.active,
    `up ${upBefore} -> up ${g.pause.active}`, 'up -> down');

  /* South confirms. The cursor goes back to RESUME on every open, so this
     closes the menu — and it has to be a fresh open, because the last row
     closed it. */
  k.clear();
  g.openPause();
  k.step(1);
  const openForConfirm = g.pause.active && g.pause.index === 0;
  k.btn(b.south, 1); k.step(1); k.btn(b.south, 0); k.step(1);
  k.row('south (A) confirms the cursor\'s item',
    openForConfirm && !g.pause.active,
    `${openForConfirm ? 'opened on RESUME' : 'DID NOT OPEN'} -> menu ${g.pause.active ? 'up' : 'down'}`,
    'opened on RESUME -> down');

  /* And select is the pause menu's RESTART shortcut, on the same terms R is. */
  k.clear();
  g.openPause();
  k.step(1);
  k.btn(b.select, 1); k.step(1); k.btn(b.select, 0); k.step(1);
  k.row('select (Back) in the menu takes RESTART, like R does',
    !g.pause.active && Math.abs(g.player.s - 34) < 1,
    `menu ${g.pause.active ? 'up' : 'down'}, car at ${g.player.s.toFixed(1)} m`,
    'down, car at 34 m');
  k.clear(); k.step(1);
  return k.take();
};

/* The three bindings that did not exist. */
const S_BINDINGS = ([b]) => {
  const k = window.__padkit, g = window.__game, p = g.player;
  k.install();

  /* Look back is a LEVEL, like the C key, and has to survive being held. */
  k.grid();
  k.btn(b.north, 1);
  let held = 0;
  for (let i = 0; i < 60; i++) { k.step(1); if (g.input.lookBack) held++; }
  k.row('north (Y) held for 60 frames is look-back on all 60',
    held === 60, `${held}/60 frames`, '60/60');
  k.btn(b.north, 0);
  k.step(1);
  k.row('and releasing it puts the camera back', !g.input.lookBack, g.input.lookBack, false);

  /* Countdown skip. */
  k.grid();
  g.countdown.arm();
  k.step(6);
  const alive = g.countdown.alive, holding = g.countdown.holding;
  k.btn(b.west, 1);
  k.step(1);
  k.row('west (X) skips the countdown',
    alive && holding && !g.countdown.alive,
    `lights ${alive ? 'were running' : 'WERE NOT RUNNING'} -> ${g.countdown.alive ? 'still running' : 'out'}`,
    'were running -> out');
  k.btn(b.west, 0);

  /* Restart, mid-race. main.js:981 case two — not restartable, not over, so
     this is the unstick, twelve metres back up the road. */
  k.grid();
  p.placeAt(120, 0); p.vx = 15;
  k.step(30);
  const sBefore = p.s;
  k.btn(b.select, 1);
  k.step(1);
  k.btn(b.select, 0);
  k.row('select (Back) mid-race respawns the car up the road',
    sBefore - p.s > 5 && sBefore - p.s < 20,
    `${sBefore.toFixed(1)} m -> ${p.s.toFixed(1)} m`, 'about 12 m back');
  return k.take();
};

/* The one that strands a controller player: the results card.
 *
 * Driven all the way to the flag with the ending armed, because `canRestart`
 * is a property of a running ending 1.45 s past the crossing and there is no
 * honest way to fake it. */
const S_RESULTS = ([b]) => {
  const k = window.__padkit, g = window.__game, p = g.player;
  k.install();
  k.grid();
  g.goTo(0.97);
  g.autopilot(true, 0.85);
  g.ending.enabled = true;
  g.ending.arm();
  k.clear();

  let crossed = false;
  for (let i = 0; i < 60 * 60 && !g.ending.canRestart; i++) {
    k.step(1);
    if (p.finished) crossed = true;
  }
  k.row('the car reached the flag and the results card is up',
    crossed && g.ending.canRestart,
    `finished ${p.finished}, canRestart ${g.ending.canRestart}, ending t ${g.ending.t.toFixed(2)}s`,
    'finished, canRestart');

  const sBefore = p.s, tBefore = p.raceTime;
  k.btn(b.select, 1);
  k.step(1);
  k.btn(b.select, 0);
  /* raceTime is checked against a frame rather than against zero: the bot is
     still on the wheel here, which puts the lights out that restart() just
     armed (main.js:1001), so the same frame that restarts also steps one
     sixtieth of the new race. */
  k.row('select (Back) on the card starts the next race',
    Math.abs(p.s - 34) < 1 && p.raceTime < 0.05 && !p.finished && !g.ending.running,
    `s ${sBefore.toFixed(0)} -> ${p.s.toFixed(1)} m, raceTime ${tBefore.toFixed(1)} -> ${p.raceTime.toFixed(1)} s,`
    + ` ending ${g.ending.running ? 'still running' : 'reset'}`,
    's 34, raceTime 0, ending reset');
  g.autopilot(false);
  return k.take();
};

/* Gap 4, measured rather than argued: A is the menu confirm AND the handbrake,
   so does a player who starts the race with it launch against a locked axle?
   Both halves of the transition — the countdown skip and the green light —
   with the button still down, against a control that let go. */
const S_DOUBLE = ([b]) => {
  const k = window.__padkit, g = window.__game, p = g.player;
  k.install();
  const runOne = (holdSouth) => {
    k.grid();
    p.placeAt(40, 0); p.vx = 0;
    g.countdown.arm();
    k.step(4);
    if (holdSouth) k.btn(b.south, 1);
    k.btn(b.west, 1); k.step(1); k.btn(b.west, 0);   // skip the lights
    const hbAtGreen = g.input.handbrake;
    k.btn(b.r2, 1);
    const s0 = p.s;
    k.step(60);                                       // one second off the line
    return { hb: hbAtGreen, m: p.s - s0, kmh: p.kmh };
  };
  const free = runOne(false);
  const stuck = runOne(true);
  k.row('MEASUREMENT — skipping the lights with X, nothing else held',
    true, `handbrake ${free.hb}, ${free.m.toFixed(1)} m in the first second, ${free.kmh.toFixed(0)} km/h`,
    '(reported, not gated)');
  k.row('MEASUREMENT — the same, with A also held down through the release',
    true, `handbrake ${stuck.hb}, ${stuck.m.toFixed(1)} m in the first second, ${stuck.kmh.toFixed(0)} km/h`,
    '(reported, not gated)');
  /* The gate is on the binding that was CHOSEN, not on the measurement: the
     countdown skip must not be able to leave a handbrake on behind it. The
     two rows above are why it is not on south. */
  k.row('the skip button is not also the handbrake',
    free.hb === 0 && free.m > 2.5 && free.m > stuck.m * 1.3,
    `X launched at handbrake ${free.hb} and ${free.m.toFixed(1)} m,`
    + ` against ${stuck.m.toFixed(1)} m for a car whose driver kept A down`,
    'handbrake 0, moving, and clear of the held-A run');

  /* And the transition this whole section is named after: A on the title
     screen starts the race, and A is also the handbrake. Reported rather than
     gated — it is the same shape the keyboard has had since Space was both
     the confirm and the handbrake, it lasts exactly as long as the player's
     own thumb, and the shipped configuration puts a three-second countdown
     between the press and the release. Worst case is measured here, which is
     `manual`'s no-countdown start: the car is free on the frame after the
     press. */
  const fromTitle = (hold) => {
    k.grid();
    g.player.placeAt(40, 0); g.player.vx = 0;
    g.title.arm();
    k.step(2);
    k.btn(b.south, 1);
    k.step(1);                                   // this frame is startRace()
    const started = !g.title.active;
    if (!hold) k.btn(b.south, 0);
    g.player.placeAt(40, 0); g.player.vx = 0;
    k.btn(b.r2, 1);
    const s0 = g.player.s;
    k.step(60);
    return { started, hb: g.input.handbrake, m: g.player.s - s0 };
  };
  const letGo = fromTitle(false);
  const kept = fromTitle(true);
  k.row('MEASUREMENT — A pressed on the title and released',
    true, `race started ${letGo.started}, handbrake ${letGo.hb}, ${letGo.m.toFixed(1)} m in the first second`,
    '(reported, not gated)');
  k.row('MEASUREMENT — A pressed on the title and never let go',
    true, `race started ${kept.started}, handbrake ${kept.hb}, ${kept.m.toFixed(1)} m in the first second`,
    '(reported, not gated)');
  k.row('starting from the title with A and letting go launches cleanly',
    letGo.started && letGo.hb === 0 && letGo.m > 2.5,
    `handbrake ${letGo.hb}, ${letGo.m.toFixed(1)} m`, 'handbrake 0 and moving');
  return k.take();
};

/* A pad pulled out of its socket must not leave an input latched. */
const S_DISCONNECT = ([b]) => {
  const k = window.__padkit, g = window.__game, p = g.player;
  k.install();
  k.grid();
  p.placeAt(40, 0); p.vx = 20;
  k.btn(b.r2, 1);
  k.axis(0, 1);
  k.btn(b.north, 1);
  k.step(30);
  const live = k.read();
  k.row('driving with the pad: throttle, steer and look-back all live',
    live.throttle === 1 && live.steer > 0.99 && live.lookBack,
    `throttle ${live.throttle}, steer ${live.steer.toFixed(3)}, lookBack ${live.lookBack}`,
    '1, 1, true');
  k.pad.connected = false;
  k.stamp();
  const gone = k.frame();
  k.row('unplugged mid-corner, nothing latches',
    gone.throttle === 0 && gone.steer === 0 && gone.brake === 0
    && gone.handbrake === 0 && !gone.lookBack,
    `throttle ${gone.throttle}, steer ${gone.steer}, brake ${gone.brake},`
    + ` handbrake ${gone.handbrake}, lookBack ${gone.lookBack}`,
    'all zero');
  k.pad.connected = true;
  k.stamp();
  const back = k.frame();
  k.row('plugged back in, it picks up again',
    back.throttle === 1 && back.steer > 0.99,
    `throttle ${back.throttle}, steer ${back.steer.toFixed(3)}`, '1, 1');

  /* And a pad that reports a non-standard mapping, whose indices mean nothing
     the code can rely on. */
  k.clear();
  k.pad.mapping = '';
  k.btn(b.r2, 1);
  const nonstd = k.frame();
  k.row('a lone non-standard pad is still read — no input is better than wrong input only if there is another pad',
    nonstd.throttle === 1, `throttle ${nonstd.throttle}`, 1);
  k.clear();
  return k.take();
};

/* Two pads, one of them not standard. The standard one has to win, whichever
   order the browser hands them over in. */
const S_TWOPADS = ([b]) => {
  const k = window.__padkit, g = window.__game;
  k.grid();
  const odd = {
    index: 0, id: 'a wheel, a dance mat, a flight stick', mapping: '',
    connected: true, timestamp: 1,
    axes: [1, 0, 0, 0],                  // hard left, on an axis that means nothing
    buttons: Array.from({ length: 20 },
      () => ({ pressed: true, touched: true, value: 1 })),
  };
  navigator.getGamepads = () => [odd, k.pad];
  k.clear();
  k.btn(b.r2, 0.5);
  const r = k.frame();
  k.row('with a non-standard pad at index 0, the standard one is the one read',
    r.throttle === 0.5 && r.steer === 0,
    `throttle ${r.throttle}, steer ${r.steer}`, '0.5, 0');
  navigator.getGamepads = () => [odd];
  k.clear();
  const only = k.frame();
  k.row('but with only the odd one plugged in it is still used rather than ignored',
    only.throttle === 1, `throttle ${only.throttle}`, 1);
  k.install();
  k.clear();
  return k.take();
};

/* Nothing above may have moved the keyboard. Every expectation here was taken
   off the tree BEFORE the pad work started, and the whole point of the section
   is that these numbers are the ones a keyboard player already had. Two frames
   per key: the first has the edges on it, the second must have dropped them
   while the levels stay. */
const S_KEYBOARD = () => {
  const k = window.__padkit, g = window.__game;
  k.grid();
  /* No pad at all — a keyboard player does not have one, and the point is that
     this file's pad branch is unreachable for them. */
  k.uninstall();

  const CASES = [
    ['ArrowLeft', { steer: -1 }],
    ['KeyA', { steer: -1 }],
    ['ArrowRight', { steer: 1 }],
    ['KeyD', { steer: 1 }],
    /* W and S are on the menu lists as well as the driving ones — see KEYS in
       src/core/input.js, which argues for that deliberately — so a menu edge
       on the frame they go down is correct and not a leak. */
    ['KeyW', { throttle: 1, up: true }],
    ['ArrowUp', { throttle: 1, up: true }],
    ['KeyS', { brake: 1, down: true }],
    ['ArrowDown', { brake: 1, down: true }],
    ['Space', { handbrake: 1, confirm: true }],
    ['KeyC', { lookBack: true }],
    ['KeyR', { reset: true }],
    ['Enter', { skip: true, confirm: true }],
    ['Escape', { pause: true }],
  ];
  const EDGES = ['reset', 'skip', 'pause', 'confirm', 'up', 'down'];
  const ZERO = {
    steer: 0, throttle: 0, brake: 0, handbrake: 0, lookBack: false,
    reset: false, skip: false, pause: false, confirm: false, up: false, down: false,
  };

  for (const [code, want] of CASES) {
    k.key(code, true);
    const first = k.frame();
    const wantFirst = { ...ZERO, ...want };
    const badFirst = Object.keys(ZERO).filter(f => first[f] !== wantFirst[f]);
    k.row(`${code} down`, badFirst.length === 0,
      badFirst.length ? badFirst.map(f => `${f}=${first[f]}`).join(' ') : 'as expected',
      badFirst.length ? badFirst.map(f => `${f}=${wantFirst[f]}`).join(' ') : 'as expected');

    const second = k.frame();
    const wantSecond = { ...ZERO, ...want };
    for (const e of EDGES) wantSecond[e] = false;
    const badSecond = Object.keys(ZERO).filter(f => second[f] !== wantSecond[f]);
    k.row(`${code} still down — levels hold, edges have gone`, badSecond.length === 0,
      badSecond.length ? badSecond.map(f => `${f}=${second[f]}`).join(' ') : 'as expected',
      badSecond.length ? badSecond.map(f => `${f}=${wantSecond[f]}`).join(' ') : 'as expected');

    k.key(code, false);
    const up = k.frame();
    const badUp = Object.keys(ZERO).filter(f => up[f] !== ZERO[f]);
    k.row(`${code} released — everything back to rest`, badUp.length === 0,
      badUp.length ? badUp.map(f => `${f}=${up[f]}`).join(' ') : 'as expected', 'all at rest');
  }

  /* Both steering keys at once, which is the one combination with an answer
     that is not either key's. */
  k.key('ArrowLeft', true); k.key('ArrowRight', true);
  const both = k.frame();
  k.row('left and right together cancel', both.steer === 0, both.steer, 0);
  k.key('ArrowLeft', false); k.key('ArrowRight', false);
  k.frame();
  k.install();
  return k.take();
};

/* ---- driver ------------------------------------------------------------ */

const SECTIONS = [
  ['install', 'the instrument itself', S_INSTALL, null],
  ['steer', 'the stick', S_STEER, [STEER_TABLE]],
  ['triggers', 'the triggers', S_TRIGGERS, [B]],
  ['drive', 'driving the car', S_DRIVE, null],
  ['shell', 'the pause menu', S_SHELL, [B]],
  ['bindings', 'the new bindings', S_BINDINGS, [B]],
  ['results', 'restarting from the results card', S_RESULTS, [B]],
  ['double', 'A as confirm and handbrake', S_DOUBLE, [B]],
  ['unplug', 'losing the pad', S_DISCONNECT, [B]],
  ['twopads', 'two pads, one of them odd', S_TWOPADS, [B]],
  ['keyboard', 'the keyboard, which nothing here may have touched', S_KEYBOARD, null],
];

/* Pre-failed, before a browser exists. A section only earns `fail: null` at
   the bottom of a clean path. */
const results = new Map(SECTIONS.map(([id]) =>
  [id, { fail: 'section never reported a verdict', rows: [] }]));

const out = await run({ width: 480, height: 270, hash: 'manual&seed=22' }, async ({ page }) => {
  await page.evaluate(KIT);
  for (const [id, , fn, arg] of SECTIONS) {
    const rec = results.get(id);
    let got = null;
    try {
      got = arg === null ? await page.evaluate(fn) : await page.evaluate(fn, arg);
    } catch (e) {
      rec.fail = 'probe threw: ' + String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 140);
      continue;
    }
    if (!got || !Array.isArray(got.rows)) { rec.fail = 'probe returned nothing'; continue; }
    if (!got.rows.length) { rec.fail = 'probe returned no rows — nothing was measured'; continue; }
    rec.rows = got.rows;
    const bad = got.rows.filter(r => !r.ok);
    rec.fail = bad.length ? `${bad.length} of ${got.rows.length} checks failed` : null;
  }
});

let total = 0, failed = 0;
for (const [id, title] of SECTIONS) {
  const rec = results.get(id);
  console.log(`\n  ${title}`);
  if (!rec.rows.length) console.log(`    ✗ ${rec.fail}`);
  for (const r of rec.rows) {
    total++;
    if (!r.ok) failed++;
    console.log(`    ${r.ok ? '✓' : '✗'} ${r.name}`);
    console.log(`        got ${r.got}${r.ok ? '' : `   want ${r.want}`}`);
  }
}

const dead = SECTIONS.filter(([id]) => results.get(id).fail);
console.log('');
if (dead.length) {
  console.log(`  ${dead.length} of ${SECTIONS.length} section(s) FAILED`);
  for (const [id] of dead) console.log(`    ${id.padEnd(10)} ${results.get(id).fail}`);
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
