/* Keyboard and gamepad, reduced to four analogue axes.
 *
 * This layer reports what the driver is asking for and nothing else. The
 * smoothing that turns a key press into a steering angle lives in Car.step,
 * for two reasons.
 *
 * The first reason is that this method runs once per rendered frame and the
 * car runs at 120 Hz substeps. A rate limit here therefore hands the car a
 * staircase, not a ramp: the command sits still for two substeps and then
 * jumps, sixty times a second, and the car's steering velocity jumps with it
 * every time. Measured at the substep, the old chain's steering rate changed
 * 1.8 times as much at a frame boundary as it did between the two substeps
 * inside a frame, which is a 60 Hz buzz laid over every turn-in and every
 * release. That is the jerk in "turns feel jerky", and no amount of extra
 * smoothing at this layer removes it, because this layer is where it comes
 * from.
 *
 * The second is that the two stages fought. A linear ramp here feeding an
 * exponential in the car took 400 ms to reach 90% of lock, which is a long
 * time to hold a key before the car does what you asked.
 */
const KEYS = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  throttle: ['ArrowUp', 'KeyW'],
  brake: ['ArrowDown', 'KeyS'],
  handbrake: ['Space'],
  /* And the gamepad's north button below. */
  look: ['KeyC'],
  /* And the gamepad's select button below, which is the only way a player
     holding a pad can leave the results card. */
  reset: ['KeyR'],
  /* Past the start countdown. Pressed by someone who has already watched the
     sequence a hundred times.
     Escape USED TO BE ON THIS LIST and is not any more, because Escape is now
     the pause key and one key cannot be both. What that costs is a player who
     reaches for Escape to shorten a three-second countdown and gets a pause
     menu instead, which is recoverable in one more press; what it buys is the
     binding every player on every platform already expects for pause, on the
     screen the whole title-and-pause pass exists to make recordable. Enter
     still skips, and so does anything that drives the car programmatically,
     and so does the gamepad's west button below. */
  skip: ['Enter', 'NumpadEnter'],

  /* ---- the shell: title screen and pause menu ---------------------------- */

  /* Escape, and the gamepad's Start button below. Deliberately NOT sharing a
     binding with anything the car uses, so a pause can never be a driving
     input that arrived at the wrong moment. */
  pause: ['Escape'],
  /* Menu navigation reuses the driving keys, which is not laziness: the hand
     is already on them, and they are only ever read while the simulation is
     stopped and the car cannot see them. */
  menuUp: ['ArrowUp', 'KeyW'],
  menuDown: ['ArrowDown', 'KeyS'],
  /* Enter for the keyboard, Space because the thumb is already there. Enter
     is also the countdown's skip; the two are read in states that cannot
     coexist — nothing may be stepped while a menu is up, so there is no
     countdown running to skip. */
  confirm: ['Enter', 'NumpadEnter', 'Space'],
};

/* Standard-mapping gamepad buttons, by name rather than by index, because
   `buttons[9]` at a call site is unreadable and this file already had two of
   them. https://w3c.github.io/gamepad/#remapping

   The four added below are the driving controls, which were reading raw
   indices two lines apart from the named ones, and the three new bindings:

     west    the countdown's skip. NOT south, which is the confirm, and the
             reason is the one the `pause` key list gives below — a shell
             input must not share a binding with anything the car uses. That
             rule bites harder here than it does on pause: the skip is read on
             the frame IMMEDIATELY BEFORE the field is released, so a skip on
             south would hand the car a handbrake at the green light for as
             long as the thumb stayed down. Measured (tools/pad.mjs, the
             `double` section), one second off the line at half throttle:
             south held through the release reads handbrake 1 and covers
             1.7 m, against handbrake 0 and 3.1 m for a car whose driver let
             go. West is free, it is next to south under the same thumb, and
             it is not a driving control.
     north   look back. A LEVEL, not an edge, like the C key. Both index
             fingers are already on the triggers — they are the throttle and
             the brake — so a shoulder button would mean lifting off one of
             them to glance behind, which is the moment you would want to. The
             right thumb has nothing to do at all: this game binds no right
             stick. Rejected: l1/r1 for the reason just given.
     select  restart. Destructive — mid-race it puts the car twelve metres
             back up the road, and on the results card it throws the result
             away and starts again — so it goes on the one button no thumb
             ever rests on. Rejected: north, which is a fingertip away from
             east and would be pressed by somebody aiming to back out. */
const PAD = {
  south: 0, east: 1, west: 2, north: 3,
  l2: 6, r2: 7, select: 8, start: 9,
  dpadUp: 12, dpadDown: 13,
};
/* How far the left stick has to be pushed before it counts as a menu
   keystroke, and how far it has to come back before it can count again. The
   gap between the two is the hysteresis that stops a stick resting near the
   threshold from scrolling the menu at 60 Hz. */
const PAD_MENU_ON = 0.6;
const PAD_MENU_OFF = 0.35;

/**
 * Which pad, when more than one is plugged in.
 *
 * This used to be `find(p => p && p.connected)`, which takes whichever slot
 * the browser happened to enumerate first. Every index in PAD above is a
 * STANDARD-mapping index, so a pad reporting any other mapping has arbitrary
 * meanings for all of them — `buttons[7]` on a flight stick is not a throttle
 * trigger, and `axes[0]` on a dance mat is not a steering wheel. A player with
 * a controller AND anything else attached could therefore find the game
 * steering itself with no way to stop it, which is what the old line allowed:
 * measured with a synthetic non-standard pad in slot 0 and a standard one in
 * slot 1, the old line read throttle 1 and steer 1 from the wrong device.
 *
 * PREFER standard rather than REQUIRE it, and the rejected alternative is the
 * interesting half. Requiring it is the tidier rule and it is wrong here:
 * `mapping` is '' for any pad the browser has no remapping table for, which
 * includes plenty of ordinary controllers on Firefox and on Linux, and a
 * player holding one of those would get NO input at all instead of
 * approximately the right input. Approximately-right is recoverable by
 * unplugging one device; nothing is not.
 *
 * So: exactly today's behaviour when one pad is attached, and the right pad
 * rather than the first one when several are.
 */
function pickPad() {
  const list = navigator.getGamepads?.() || [];
  let fallback = null;
  for (const p of list) {
    if (!p || !p.connected) continue;
    if (p.mapping === 'standard') return p;
    if (!fallback) fallback = p;
  }
  return fallback;
}

export class Input {
  constructor(target = window) {
    this.down = new Set();
    this.steer = 0; this.throttle = 0; this.brake = 0; this.handbrake = 0;
    this.lookBack = false;
    this.resetPressed = false;
    this.skipPressed = false;
    /* The shell's four edges. Every one of them is an EDGE and not a level:
       a menu driven by a level scrolls three items on one press. */
    this.pausePressed = false;
    this.menuUpPressed = false;
    this.menuDownPressed = false;
    this.confirmPressed = false;
    this._pressedThisFrame = new Set();
    /* A gamepad is polled and not evented, so its edges have to be
       differenced here. `skipPressed` used the raw level and got away with it
       because skipping a countdown twice is skipping it once; a pause toggle
       driven by a level opens and closes the menu sixty times a second for as
       long as the button is held. */
    this._padWas = [];
    this._padMenu = 0;           // -1 up, +1 down, 0 centred — latched

    this._onDown = e => {
      if (e.repeat) return;
      this.down.add(e.code);
      this._pressedThisFrame.add(e.code);
      if (Object.values(KEYS).some(list => list.includes(e.code))) e.preventDefault();
    };
    this._onUp = e => this.down.delete(e.code);
    this._onBlur = () => this.down.clear();

    target.addEventListener('keydown', this._onDown, { passive: false });
    target.addEventListener('keyup', this._onUp);
    target.addEventListener('blur', this._onBlur);
    this._target = target;
  }

  dispose() {
    this._target.removeEventListener('keydown', this._onDown);
    this._target.removeEventListener('keyup', this._onUp);
    this._target.removeEventListener('blur', this._onBlur);
  }

  held(name) { return KEYS[name].some(k => this.down.has(k)); }
  pressed(name) { return KEYS[name].some(k => this._pressedThisFrame.has(k)); }

  update(dt) {
    const pad = pickPad();

    let steerWant = 0, thr = 0, brk = 0, hb = 0;
    if (this.held('left')) steerWant -= 1;
    if (this.held('right')) steerWant += 1;
    if (this.held('throttle')) thr = 1;
    if (this.held('brake')) brk = 1;
    if (this.held('handbrake')) hb = 1;

    /* How hard a button is held, 0..1.
     *
     * `value` alone was the whole of this and it loses a class of pad
     * entirely: some controllers and some browsers report an analogue trigger
     * as `pressed: true, value: 0`, and a player on one of those had a car
     * that would not accelerate. The fallback cannot cost an analogue pad
     * anything, and the reason is that it is only ever reached when `value`
     * is already zero — a trigger at rest reports `pressed: false` and stays
     * at 0, a trigger barely touched reports its own 0.02 and keeps it, and a
     * pad that latches `pressed` early at 0.02 still reports 0.02 rather than
     * being rounded up to a full press. All three of those are gated in
     * tools/pad.mjs alongside the case this exists for. */
    const level = i => {
      const b = pad?.buttons[i];
      if (!b) return 0;
      return b.value || (b.pressed ? 1 : 0);
    };

    if (pad) {
      const ax = pad.axes[0] || 0;
      // Deadzone, then squared response for fine control near centre.
      const dz = Math.abs(ax) < 0.14 ? 0 : (ax - Math.sign(ax) * 0.14) / 0.86;
      if (dz) steerWant = Math.sign(dz) * dz * dz;
      thr = Math.max(thr, level(PAD.r2));
      brk = Math.max(brk, level(PAD.l2));
      hb = Math.max(hb, level(PAD.south));
    }

    /* Raw. A stick is already a position and a key is already a request; the
       car decides how fast the wheel is allowed to follow either. */
    this.steer = steerWant;

    this.throttle = thr; this.brake = brk; this.handbrake = hb;

    /* One rising edge per pad button per press. Declared above its first use
       rather than below it, which is the only thing that moved here: the three
       lines under it were keyboard-only and now each has a pad half. */
    const padEdge = i => !!pad?.buttons[i]?.pressed && !this._padWas[i];

    /* A LEVEL, on both halves. The camera is behind the car for exactly as
       long as the button is down and not one frame longer, so an edge here
       would be a toggle, which is a different control. */
    this.lookBack = this.held('look') || !!pad?.buttons[PAD.north]?.pressed;
    /* Edges, on both halves, because both of them do something once and
       destructively — see main.js, where this one key has three answers. */
    this.resetPressed = this.pressed('reset') || padEdge(PAD.select);
    this.skipPressed = this.pressed('skip') || padEdge(PAD.west);

    /* And one per flick of the left stick, with hysteresis — see the two
       thresholds above. The latch is cleared only when the stick comes most
       of the way back, so a stick held at full deflection produces exactly
       one menu step, like a key does. */
    const ay = pad ? (pad.axes[1] || 0) : 0;
    let stick = 0;
    if (Math.abs(ay) < PAD_MENU_OFF) this._padMenu = 0;
    else if (Math.abs(ay) > PAD_MENU_ON && this._padMenu !== Math.sign(ay)) {
      this._padMenu = Math.sign(ay);
      stick = this._padMenu;     // +1 is stick DOWN on every standard mapping
    }

    /* Start pauses. A player holding a pad has no Escape key within reach,
       and Start is the button every console has meant this with for thirty
       years. It used to be wired to the countdown's skip; pausing is the more
       valuable of the two and the countdown is three seconds long. */
    this.pausePressed = this.pressed('pause') || padEdge(PAD.start);
    this.menuUpPressed = this.pressed('menuUp') || padEdge(PAD.dpadUp) || stick < 0;
    this.menuDownPressed = this.pressed('menuDown') || padEdge(PAD.dpadDown) || stick > 0;
    this.confirmPressed = this.pressed('confirm') || padEdge(PAD.south);
    /* B backs out of a menu, which on this one means RESUME. Folded into the
       pause edge because that is exactly what pause means while a menu is
       already up: the caller toggles. */
    if (padEdge(PAD.east)) this.pausePressed = true;

    this._padWas.length = 0;
    if (pad) for (let i = 0; i < pad.buttons.length; i++) {
      this._padWas[i] = pad.buttons[i].pressed;
    }
    this._pressedThisFrame.clear();
  }
}
