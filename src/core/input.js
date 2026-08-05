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
  look: ['KeyC'],
  reset: ['KeyR'],
  /* Past the start countdown. Pressed by someone who has already watched the
     sequence a hundred times.
     Escape USED TO BE ON THIS LIST and is not any more, because Escape is now
     the pause key and one key cannot be both. What that costs is a player who
     reaches for Escape to shorten a three-second countdown and gets a pause
     menu instead, which is recoverable in one more press; what it buys is the
     binding every player on every platform already expects for pause, on the
     screen the whole title-and-pause pass exists to make recordable. Enter
     still skips, and so does anything that drives the car programmatically. */
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
   them. https://w3c.github.io/gamepad/#remapping */
const PAD = { south: 0, east: 1, start: 9, dpadUp: 12, dpadDown: 13 };
/* How far the left stick has to be pushed before it counts as a menu
   keystroke, and how far it has to come back before it can count again. The
   gap between the two is the hysteresis that stops a stick resting near the
   threshold from scrolling the menu at 60 Hz. */
const PAD_MENU_ON = 0.6;
const PAD_MENU_OFF = 0.35;

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
    const pad = navigator.getGamepads?.().find(p => p && p.connected);

    let steerWant = 0, thr = 0, brk = 0, hb = 0;
    if (this.held('left')) steerWant -= 1;
    if (this.held('right')) steerWant += 1;
    if (this.held('throttle')) thr = 1;
    if (this.held('brake')) brk = 1;
    if (this.held('handbrake')) hb = 1;

    if (pad) {
      const ax = pad.axes[0] || 0;
      // Deadzone, then squared response for fine control near centre.
      const dz = Math.abs(ax) < 0.14 ? 0 : (ax - Math.sign(ax) * 0.14) / 0.86;
      if (dz) steerWant = Math.sign(dz) * dz * dz;
      thr = Math.max(thr, pad.buttons[7]?.value || 0);
      brk = Math.max(brk, pad.buttons[6]?.value || 0);
      hb = Math.max(hb, pad.buttons[0]?.value || 0);
    }

    /* Raw. A stick is already a position and a key is already a request; the
       car decides how fast the wheel is allowed to follow either. */
    this.steer = steerWant;

    this.throttle = thr; this.brake = brk; this.handbrake = hb;
    this.lookBack = this.held('look');
    this.resetPressed = this.pressed('reset');
    this.skipPressed = this.pressed('skip');

    /* One rising edge per pad button per press. */
    const padEdge = i => !!pad?.buttons[i]?.pressed && !this._padWas[i];
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
