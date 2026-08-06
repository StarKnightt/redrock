/* Touch controls: tilt to steer, on-screen throttle and brake.
 *
 * One object, on the terms race/countdown.js, race/ending.js and ui/title.js
 * already set. It owns no meshes, no canvas and no game state. It listens to
 * the device, and it reports three things to whoever is driving it:
 *
 *   live       there is a touchscreen and the controls are wanted
 *   rotate     the viewport is portrait and the game must not be played
 *   display()  what the HUD should draw, or null
 *
 * plus four analogue-ish values — `steer`, `throttle`, `brake` and a `tap`
 * edge — which src/core/input.js merges alongside the keyboard and the pad.
 *
 * IT DOES NO SMOOTHING, and that is the input layer's rule rather than this
 * file's preference. src/core/input.js's header carries the measurement: this
 * layer is polled once per rendered frame and the car runs at 120 Hz
 * substeps, so a rate limit here hands the car a staircase and its steering
 * rate changes 1.8 times as much at a frame boundary as it does inside one.
 * Every number below is therefore a POSITION read off the hardware — the angle
 * the phone is held at, or where on a pedal the thumb is sitting — never a
 * value ramped toward a target. The car decides how fast the wheel follows.
 *
 * WHY THE CLOCK IS THE EVENT'S OWN. `e.timeStamp` and nothing else. Every
 * drawn thing in this game is forbidden from reading `performance.now()` (see
 * ui/title.js and race/countdown.js), and the reason is that a tool must be
 * able to photograph two identical frames. Nothing here is time-varying in a
 * way the HUD can see: the tap test below needs a duration, but a tap is an
 * edge consumed by the input layer and never drawn.
 */

/* ---- how the device is found -------------------------------------------- */

/**
 * Is the PRIMARY pointer a finger?
 *
 * Three signals, all three required, and the combination is the whole
 * argument. `navigator.maxTouchPoints > 0` says a touchscreen exists;
 * `(pointer: coarse)` says the primary pointing device is imprecise; and
 * `(hover: none)` says the primary pointing device cannot hover.
 *
 * WHAT EACH ONE REJECTS. A touchscreen laptop with a trackpad has a
 * touchscreen and therefore fails on `maxTouchPoints` alone — that is the
 * misdetection the brief names, and it is `(hover: none)` that catches it: the
 * primary pointer there is the trackpad, which hovers, so the media query is
 * false while `(any-pointer: coarse)` is true. `any-pointer` is deliberately
 * NOT used for that reason. Conversely a phone with a Bluetooth mouse paired
 * reports `hover: hover` and loses the touch controls; that is the right
 * answer for the wrong reason and it is recoverable by unpairing, which is
 * more than can be said for a phone with no controls at all.
 *
 * Measured in the emulated context (.fix/tprobe2.mjs): a plain 1600x900
 * Chromium reports 0 / false / false, and a `hasTouch` context reports
 * 1 / true / true. So the test separates the two cases the byte-parity
 * constraint cares about, which are "desktop, draw nothing" and "phone".
 */
export function touchPrimary() {
  if (typeof navigator === 'undefined' || typeof matchMedia !== 'function') return false;
  if (!(navigator.maxTouchPoints > 0)) return false;
  return matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches;
}

/* The short side of the PANEL, in CSS pixels, below which a coarse-pointer
 * device is called a phone.
 *
 * `screen`, not `innerWidth`, and that is the whole of why this is not fooled
 * by a narrow browser window: `screen.width/height` describe the panel and do
 * not change when a window is resized or when the device is rotated.
 *
 * 500 separates the two populations with a lot of room on both sides. Phones
 * run 320 (an SE) to 440 (a Pro Max) on the short side; the smallest tablet
 * this could be confused with is an iPad mini at 744, and the smallest laptop
 * panel in circulation is 600. There is no device at 500.
 */
const PHONE_SHORT_SIDE = 500;

/**
 * Is this a phone — as opposed to merely something with a touchscreen?
 *
 * Used for ONE decision, the render tier, and deliberately not for the
 * control scheme: an iPad should get touch controls and should not be dropped
 * to `low`, because it outruns most laptops. See .fix/FINDINGS-mobile.md §8,
 * which argues at length that no available signal measures performance and
 * that the input signals must not be used to guess at it.
 *
 * WHAT THIS GETS WRONG, stated rather than discovered later:
 *
 *   - A cheap 10-inch Android tablet with a weak GPU is 800+ CSS px on the
 *     short side, so it stays on `high` and will suffer. This is the biggest
 *     known miss and it is accepted: a tablet is as likely to be an iPad Pro
 *     as a bargain slab, and `?tier=low` is one query parameter away.
 *   - A folding phone opened out (Pixel Fold inner panel, 840 px) is called a
 *     tablet. It is also roughly tablet-class hardware, so the answer is
 *     defensible by accident rather than by design.
 *   - Chrome for Android's "Desktop site" switch changes the reported
 *     viewport but not `screen`, so a phone in desktop mode is still
 *     correctly a phone. That is why the test is on `screen`.
 *   - A phone with a mouse paired fails `touchPrimary` and therefore stays on
 *     `high`.
 */
export function isPhone() {
  if (!touchPrimary()) return false;
  if (typeof screen === 'undefined') return false;
  return Math.min(screen.width || 0, screen.height || 0) <= PHONE_SHORT_SIDE;
}

/* ---- the notch ---------------------------------------------------------- */

/* Where `env(safe-area-inset-*)` is read from, and why it goes through CSS
 * custom properties rather than being queried directly.
 *
 * `env()` is a substitution function: it can only appear inside a declaration,
 * so there is no `CSS.env('safe-area-inset-top')` to call. index.html declares
 * the four insets as custom properties on `:root`, and this reads them back —
 * measured working in .fix/tprobe2.mjs, where `getComputedStyle` on the root
 * element resolves the `env()` and returns `0px` on hardware with no notch.
 *
 * Going through a named property rather than a hidden probe element buys the
 * one thing this round could not otherwise have: a SIMULATION HOOK. Headless
 * Chromium reports zero for all four insets and there is no device here, so
 * the only way to know the layout responds to a notch is to give it one —
 * `documentElement.style.setProperty('--sai-left', '59px')` overrides the
 * declaration, which is exactly what tools/touch.mjs does.
 */
const SAFE_VARS = ['--sai-top', '--sai-right', '--sai-bottom', '--sai-left'];
const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

/** @returns {{top:number,right:number,bottom:number,left:number}} CSS px. */
export function safeInsets() {
  if (typeof document === 'undefined' || !document.documentElement) return { ...ZERO_INSETS };
  const cs = getComputedStyle(document.documentElement);
  const out = {};
  const keys = ['top', 'right', 'bottom', 'left'];
  for (let i = 0; i < 4; i++) {
    const v = parseFloat(cs.getPropertyValue(SAFE_VARS[i]));
    out[keys[i]] = Number.isFinite(v) && v > 0 ? v : 0;
  }
  return out;
}

/* ---- tilt --------------------------------------------------------------- */

const DEG = Math.PI / 180;

/* Full lock, in degrees of roll away from the calibrated neutral.
 *
 * Chosen against a gamepad rather than out of the air. A thumbstick reaches
 * its mechanical stop at roughly 20-25 degrees of travel, and every steering
 * constant in car/physics.js was tuned against a player holding one — so
 * making the phone's wheel the same ANGULAR gesture size as the stick the car
 * was balanced for is the change that alters the least. It also lands inside
 * the two limits the gesture actually has: below about 15 degrees a hand
 * tremor is a steering input, and past about 35 degrees the screen is turned
 * far enough off the eye line that the ink outlines and the HUD are being read
 * at a glancing angle, which is the point at which a player stops tilting
 * further and starts turning their head.
 *
 * NOT MEASURED. There is no phone in this round and no honest way to measure
 * an ergonomic constant without a hand. It is a query parameter — `?tiltdeg=`
 * — precisely so the first person with a real device can settle it in a
 * minute instead of arguing about it.
 */
const TILT_FULL_DEG = 25;

/* The deadzone, in degrees.
 *
 * NOT the pad's 0.14, and the pad's number could not be borrowed even in
 * principle: 0.14 is a fraction of a stick's travel and this axis is measured
 * in degrees of a wrist. What it has to clear is the two sources of zero-point
 * error a tilt has and a stick does not — a hand that is never quite still,
 * which is one to two degrees, and a phone that creeps in the palm as the arms
 * tire, which the calibration below cannot see because it happens after it.
 * Three degrees is a little over twice the tremor and small enough that the
 * car still answers a deliberate nudge.
 */
const TILT_DEAD_DEG = 3;

/* The response curve.
 *
 * DELIBERATELY NOT the pad's square, and this is the one place where copying
 * the pad would have been wrong rather than merely unjustified. A stick self
 * centres and the thumb can feel where zero is, so a square costs nothing near
 * the middle — the player knows they are at rest. A tilt has neither: the
 * neutral is an invisible number in this file, and the only way to find it is
 * to make a small correction and see what the car does. A square makes the
 * first 40% of the tilt range worth 16% of lock, so those small corrections
 * are nearly dead and the player over-rotates hunting for the response.
 *
 * Straight linear is the other extreme and it is worse in the other
 * direction, because it multiplies whatever residual the calibration left
 * behind at full gain for the whole run.
 *
 * 1.5 sits between them by a factor of two at each end: at a quarter of the
 * range it gives 0.125 of lock, against linear's 0.250 and the square's
 * 0.0625. Reasoned, not measured; `?tiltexp=` exists so it can be.
 */
const TILT_EXP = 1.5;

/* How many samples the neutral is averaged over — about a third of a second
   at the 60 Hz most devices report orientation at. Long enough to reject the
   jolt of the tap that started the race, short enough that `recentre()` feels
   immediate. */
const CAL_SAMPLES = 20;

/* ---- the pedals --------------------------------------------------------- */

/* A pedal's drawn size, and its touch target.
 *
 * Authored in CSS PIXELS and not in the HUD's `u = min(w,h)/720`, which is the
 * one place this file refuses to follow the house style. `u` is 0.542 on a
 * phone in landscape (.fix/FINDINGS-mobile.md §6), so every piece of HUD
 * furniture is 43% of its authored size there — that is fine for something
 * being read and fatal for something being hit. A touch target is a physical
 * quantity: Apple's own floor is 44 CSS px, which is about 9 mm on every
 * phone ever made, and a control that scaled with `u` would be 31 px on a
 * phone and 61 px on a desktop that has no fingers.
 *
 * So: a floor in absolute pixels, a proportional term so a tablet gets a
 * larger control than a phone, and a ceiling so a 4K panel with a touchscreen
 * does not get a pedal the size of a hand.
 */
const PED_W = [72, 0.17, 120];      // [min px, fraction of the short side, max px]
const PED_H = [120, 0.34, 210];
/* How far outside the paint a touch still counts. The drawn capsule is the
   affordance; the target is bigger, because a thumb is 20 mm wide and lands
   where it feels right rather than where the ink is. */
const PED_GROW = 14;
/* Where the pedals sit, as an inset from the safe-area edge.
 *
 * Not the extreme corner. A phone held in landscape with two hands puts the
 * BASE of each thumb at the corner and the TIP an inch inboard and up, so the
 * corner itself is under the palm — a control there is pressed by the hand
 * holding the device rather than by the thumb aiming at it. These offsets put
 * the centre of each capsule roughly 60 px in and 85 px up on a 844x390
 * viewport, which is inside the thumb's resting arc rather than at the edge of
 * its reach. Unmeasured, for want of a hand; see §9 of the findings. */
const PED_INSET_X = 26;
const PED_INSET_Y = 18;

/* The analogue travel, and why the pedals are analogue at all.
 *
 * The physics rewards it and the brief carries the measurement: an earlier
 * round found keyboard braking leaving 0.264 of rear grip against 0.804 on an
 * analogue pedal. So a binary pedal is not a simplification here, it is a
 * different and worse car.
 *
 * WHICH ANALOGUE CHANNEL, which is the part that had to be chosen. A thumb on
 * glass has no travel and no portable force reading — `Touch.force` is a
 * WebKit extension that reports 0 on most Android hardware — so the only
 * channel available is WHERE on the control the thumb is sitting. That is a
 * genuine position, which is also what lets it obey the no-smoothing rule
 * above: it is read, not ramped.
 *
 * The lower part of the capsule is a FULL DETENT rather than the bottom of a
 * ramp, and that is the whole ergonomic argument. Full throttle is what a
 * player wants for most of a downhill stage, and a control whose default
 * demands precision to hold at maximum is a control that is never at maximum.
 * So: the bottom 55% commands 1.0 however sloppily it is hit, and the top 45%
 * feathers down to a floor. Feathering becomes an explicit, learnable gesture
 * — slide the thumb up — and the fill level the HUD draws is the command, so
 * it can be learnt by looking.
 *
 * The floor is not zero. A pedal that can be held at 0.0 while still being
 * touched is indistinguishable from a pedal that has stopped working, and
 * lifting the thumb is already how you ask for nothing.
 */
const PED_DETENT = 0.55;
const PED_FLOOR = 0.25;

/* ---- the drag fallback -------------------------------------------------- */

/* How far a thumb drags for full lock, and the deadzone at the anchor.
 *
 * Anchored rather than absolute: the touch-down point is zero and the command
 * is the offset from it, so the player does not have to find a strip on the
 * glass they cannot feel. Linear, unlike the tilt, because a drag HAS a
 * visible reference — the thumb is where the player put it — so there is no
 * hidden zero for a curve to protect. */
const DRAG_FULL = [64, 0.20, 140];
const DRAG_DEAD = 6;

/* A tap: short, and it did not go anywhere. The one gesture that is not a
   control, used for TAP TO START and TAP TO RACE AGAIN — the two moments a
   phone player would otherwise be stranded, since both prompts name a key and
   a gamepad button and a phone has neither. */
const TAP_MS = 400;
const TAP_PX = 16;

const band = ([lo, k, hi], short) => Math.max(lo, Math.min(hi, short * k));

export class Touch {
  /**
   * @param {{enabled?:boolean, fullDeg?:number, deadDeg?:number, exp?:number}} opts
   *   `enabled` is the `manual` gate the countdown, the title and the ending
   *   all have — see main.js. The three angles are query overrides so the
   *   first real device can settle constants this round could only reason
   *   about.
   */
  constructor(opts = {}) {
    this.supported = touchPrimary();
    /* Wanted at all. False for every tool run, exactly as the title screen is
       false for every tool run, and for the same reason: a drawn control that
       varies with the hardware is the one thing a byte-parity gate cannot
       tolerate. */
    this.wanted = opts.enabled !== false;

    this.fullDeg = opts.fullDeg > 0 ? opts.fullDeg : TILT_FULL_DEG;
    this.deadDeg = opts.deadDeg >= 0 ? opts.deadDeg : TILT_DEAD_DEG;
    this.exp = opts.exp > 0 ? opts.exp : TILT_EXP;

    /* What the input layer reads. */
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;

    /* Tilt state. `tiltLive` goes true on the first orientation event that
       carries a usable attitude and never on the strength of a permission
       promise alone: a granted permission that then delivers no events is
       indistinguishable from a device with no gyroscope, and both have to fall
       back. */
    this.tiltLive = false;
    this.tiltAsked = false;
    this.tiltDenied = false;
    this._roll = 0;                 // latest measured roll, radians
    this._neutral = 0;              // the calibrated resting roll
    this._ring = [];                // recent rolls, for the calibration mean
    this._calibrated = false;

    this.w = 1; this.h = 1;
    this.insets = { ...ZERO_INSETS };
    this.L = null;
    this._layout();

    /* Live touches by identifier. A role is assigned at touchstart and never
       changes: a thumb that starts on the throttle and slides into the
       steering region must not become a steering input, or letting go of the
       throttle would swerve the car. */
    this._points = new Map();
    this._tap = false;

    this._onOrient = e => this._orient(e);
    this._onStart = e => this._start(e);
    this._onMove = e => this._move(e);
    this._onEnd = e => this._end(e);
    this._onGone = () => this._clear();

    if (this.live) this._attach();
  }

  /** There is a touchscreen and the controls are wanted. */
  get live() { return this.supported && this.wanted; }

  /**
   * The viewport is portrait and the game must not be played in it.
   *
   * Not a preference. `PerspectiveCamera` fixes the VERTICAL field of view, so
   * a tall viewport crops the sides away rather than adding sky: measured in
   * .fix/FINDINGS-mobile.md §6, portrait 390x844 leaves a 32.8 degree
   * horizontal cone against desktop's 96.9, and there is no lateral vision to
   * see a corner arriving. No tier constant and no HUD change reaches it.
   *
   * Gated on `live`, so a desktop player who makes their window tall gets the
   * narrow lens and no interruption — desktop behaviour is unchanged by
   * construction rather than by care.
   */
  get rotate() { return this.live && this.h > this.w; }

  dispose() {
    if (!this._attached) return;
    this._attached = false;
    removeEventListener('deviceorientation', this._onOrient);
    for (const [t, f] of [['touchstart', this._onStart], ['touchmove', this._onMove],
      ['touchend', this._onEnd], ['touchcancel', this._onEnd]]) {
      removeEventListener(t, f);
    }
    removeEventListener('blur', this._onGone);
    document.removeEventListener('visibilitychange', this._onGone);
  }

  _attach() {
    this._attached = true;
    /* `passive: false` because these have to be able to preventDefault: a
       touchmove that reaches the browser is a scroll, a pull-to-refresh or a
       pinch-zoom, and all three are worse than useless over a game. The canvas
       already carries `touch-action: none` in index.html, which handles the
       common cases; this is the belt under it for the ones it does not, and
       for anything the overlay draws outside the canvas. */
    addEventListener('touchstart', this._onStart, { passive: false });
    addEventListener('touchmove', this._onMove, { passive: false });
    addEventListener('touchend', this._onEnd, { passive: false });
    addEventListener('touchcancel', this._onEnd, { passive: false });
    /* A backgrounded tab and a lost focus both stop delivering touchend, so
       both would otherwise leave a pedal held down forever. */
    addEventListener('blur', this._onGone);
    document.addEventListener('visibilitychange', this._onGone);
  }

  /* ---- tilt ------------------------------------------------------------- */

  /**
   * Ask for the gyroscope. MUST BE CALLED FROM A REAL USER GESTURE.
   *
   * iOS 13 and later put `deviceorientation` behind
   * `DeviceOrientationEvent.requestPermission()`, and that call is only
   * honoured inside a user-activated task. Wired to the first touch (see
   * main.js, where the same gesture is the tap that starts the race) rather
   * than to load, because on load it resolves to 'denied' without ever showing
   * the sheet and tilt then silently never works on any iPhone — which is
   * exactly the failure a listener-only implementation cannot tell apart from
   * a device with no sensor.
   *
   * Chromium has no `requestPermission` at all (.fix/tprobe2.mjs), so on
   * Android and on the desktop this is the plain listener path. The promise is
   * deliberately not awaited by anything: nothing downstream is allowed to
   * wait on a permission sheet, and `tiltLive` is set by the arrival of an
   * event rather than by the resolution of this.
   */
  requestTilt() {
    if (!this.live || this.tiltAsked) return;
    this.tiltAsked = true;
    const DOE = typeof DeviceOrientationEvent !== 'undefined' ? DeviceOrientationEvent : null;
    if (!DOE) { this.tiltDenied = true; return; }
    const listen = () => addEventListener('deviceorientation', this._onOrient);
    if (typeof DOE.requestPermission === 'function') {
      let p = null;
      try { p = DOE.requestPermission(); } catch (_) { this.tiltDenied = true; return; }
      Promise.resolve(p).then(
        state => { if (state === 'granted') listen(); else this.tiltDenied = true; },
        () => { this.tiltDenied = true; });
    } else {
      listen();
    }
  }

  /**
   * One orientation reading, reduced to a single roll angle.
   *
   * THE SIGNAL IS `asin` OF THE SCREEN-FRAME X COMPONENT OF GRAVITY, and
   * choosing that over the obvious alternatives is most of the maths here.
   *
   * `gamma` on its own is the first thing anyone reaches for and it is wrong
   * twice: it is an angle in the DEVICE's frame, so it means a different
   * gesture in each of the two landscape orientations, and it is undefined
   * either side of the vertical.
   *
   * The angle of in-plane gravity — `atan2` of the two screen components — is
   * the second, and it fails at the pose players actually adopt: a phone held
   * flat has almost no gravity in the plane of its screen, so the angle is
   * whatever the noise says.
   *
   * What the gesture actually is, in every pose, is MAKING ONE SIDE OF THE
   * SCREEN LOWER THAN THE OTHER, and the screen-frame x component of gravity
   * is exactly that: the sine of the angle by which the screen's own left-right
   * axis has been tilted out of horizontal. That is a direct geometric readout
   * of the thing the player is doing, it needs no reference attitude, and it is
   * well conditioned everywhere short of standing the phone on its end.
   *
   * WHAT IT IS NOT, stated because an earlier draft of this comment claimed it
   * and the claim is false. It is NOT invariant to how far back the phone is
   * tilted. Write pitch as `p` and the wrist's roll as `t`: rolling about the
   * screen's own vertical axis puts `sin t cos p` into this signal, and rolling
   * about the screen's normal — turning it like a steering wheel, which is what
   * a player does with a phone held up near vertical — puts `sin t sin p` in.
   * So the GAIN depends on the pose, by up to a factor of about 1.4 between the
   * two poses a phone is actually held in.
   *
   * There is no gravity-based signal without that property, and the two obvious
   * attempts to remove it are both worse. `atan2(g_x, -g_z)` recovers the roll
   * angle exactly and is genuinely pose-independent for the first gesture — and
   * divides by `cos p`, so it is pure noise for the second, at the pose where
   * the second is the only gesture available. Reading `gamma` after
   * re-deriving the Euler decomposition in the screen frame has the same defect
   * plus gimbal lock at the vertical.
   *
   * What makes the residual acceptable is that at least one of `sin p` and
   * `cos p` is always above 0.707, so SOME natural steering gesture always has
   * most of the available authority; the neutral is calibrated away rather than
   * assumed; and the full-lock angle is a query parameter. tools/touch.mjs
   * sweeps the pitch from -60 to +60 degrees, gates that the sign never flips
   * and the authority never collapses, and REPORTS the gain spread rather than
   * pretending it is zero.
   *
   * The derivation, so the next reader does not have to redo it. The W3C
   * convention is an intrinsic Z-X-Y rotation, R = Rz(a) Rx(b) Ry(g), and the
   * third row of R gives earth's down direction in device coordinates:
   *
   *     down_device = (cos b sin g, -sin b, -cos b cos g)
   *
   * `alpha` does not appear, which is the point — a compass heading is not a
   * steering input and a player who turns round should not turn the car.
   * Rotating the in-plane pair by the screen's own angle puts it in screen
   * coordinates, and the x component is the answer.
   */
  _orient(e) {
    const b = e.beta, g = e.gamma;
    /* Some browsers fire an empty event before the sensor is up, and one
       device with no gyroscope fires nothing but empty events. Neither may
       count as tilt being available. */
    if (b === null || g === null || b === undefined || g === undefined) return;
    if (!Number.isFinite(b) || !Number.isFinite(g)) return;

    const br = b * DEG, gr = g * DEG;
    const cb = Math.cos(br);
    const dx = cb * Math.sin(gr);
    const dy = -Math.sin(br);

    const th = (typeof screen !== 'undefined' && screen.orientation
      ? (screen.orientation.angle || 0) : 0) * DEG;
    const sx = dx * Math.cos(th) + dy * Math.sin(th);

    this._roll = Math.asin(Math.max(-1, Math.min(1, sx)));
    this._ring.push(this._roll);
    if (this._ring.length > CAL_SAMPLES) this._ring.shift();
    /* First usable reading also seeds the neutral, so a player who never sees
       a calibration call is steering against the attitude they were holding
       rather than against flat. */
    if (!this.tiltLive) {
      this.tiltLive = true;
      this._neutral = this._roll;
    }
    /* AND PUBLISH IT. Without this line `steer` only changed when a FINGER
       moved, because `_reduce` was reached from the four touch handlers and
       from nowhere else — so a player steering by wrist with both thumbs still
       on the pedals commanded whatever the last touch event had left behind,
       which for the common case of holding the throttle down is a locked
       wheel. Caught by tools/touch.mjs's `drive` section, which is there
       precisely because a unit-level reading of `tiltSteer()` cannot see it:
       every check of the maths passed while the car went straight on. */
    this._reduce();
  }

  /**
   * Take the attitude the phone is being held at as zero.
   *
   * NOBODY HOLDS A PHONE FLAT, and a game that assumes they do steers left for
   * the whole descent. The neutral is the mean of the last third of a second
   * rather than the latest sample, because the moment this is called is the
   * moment just after a tap, and a tap moves the phone.
   *
   * Called by main.js when a race begins and again when the lights go out —
   * the countdown's three seconds are the one window in the game where the
   * player is holding the phone still and steering has no consequence, which
   * makes it the calibration window for free.
   */
  calibrate() {
    if (!this.tiltLive) { this._calibrated = false; return false; }
    const n = this._ring.length;
    if (n > 0) {
      let s = 0;
      for (const v of this._ring) s += v;
      this._neutral = s / n;
    } else {
      this._neutral = this._roll;
    }
    this._calibrated = true;
    return true;
  }

  /** The re-centre control. Snaps to the latest reading, not to the mean: a
      player who presses this has just decided that where they are holding it
      NOW is straight ahead, and averaging in the previous third of a second
      would fold in the attitude they are complaining about. */
  recentre() {
    if (!this.tiltLive) return false;
    this._neutral = this._roll;
    this._ring.length = 0;
    this._ring.push(this._roll);
    this._calibrated = true;
    return true;
  }

  /** The tilt command, -1..1, or null when tilt is not the active scheme. */
  tiltSteer() {
    if (!this.tiltLive) return null;
    const deg = (this._roll - this._neutral) / DEG;
    const mag = Math.abs(deg);
    if (mag <= this.deadDeg) return 0;
    const span = Math.max(1e-6, this.fullDeg - this.deadDeg);
    const u = Math.min(1, (mag - this.deadDeg) / span);
    return Math.sign(deg) * Math.pow(u, this.exp);
  }

  /* ---- layout ----------------------------------------------------------- */

  /**
   * @param {number} w CSS px
   * @param {number} h CSS px
   * @param {{top:number,right:number,bottom:number,left:number}} [insets]
   */
  resize(w, h, insets) {
    this.w = w; this.h = h;
    this.insets = insets ? { ...ZERO_INSETS, ...insets } : { ...ZERO_INSETS };
    this._layout();
    /* A rotation invalidates every touch in flight: the pedal the thumb was on
       is somewhere else now, and the roll axis has moved with the screen. */
    this._clear();
  }

  _layout() {
    const { w, h } = this;
    const I = this.insets;
    const short = Math.min(w, h);
    const pw = band(PED_W, short), ph = band(PED_H, short);
    /* Inside the notch and the home indicator, always. The predecessor round
       measured the HUD sitting under hardware because nothing in the tree read
       an inset; a CONTROL under hardware is worse than a readout under
       hardware, because the operating system eats the touch as well as the
       pixels. */
    const bottom = h - I.bottom - PED_INSET_Y;
    const left = I.left + PED_INSET_X;
    const right = w - I.right - PED_INSET_X;

    const brake = { x: left, y: bottom - ph, w: pw, h: ph, kind: 'brake' };
    const throttle = { x: right - pw, y: bottom - ph, w: pw, h: ph, kind: 'throttle' };

    /* The steering readout, bottom centre — between the pedals, where nothing
       else in the HUD's touch layout goes and where no thumb rests. */
    const barW = Math.max(120, Math.min(260, short * 0.42));
    const barH = 18;
    const bar = { x: (w - barW) / 2, y: bottom - barH, w: barW, h: barH };
    /* And the re-centre pill directly above it. Deliberately a reach rather
       than a rest: it is destructive in the small way a mis-calibration is,
       so it must not be somewhere a hand can lean on it. */
    const pillW = 92, pillH = 30;
    const pill = { x: (w - pillW) / 2, y: bar.y - 8 - pillH, w: pillW, h: pillH };

    this.L = { brake, throttle, bar, pill, dragFull: band(DRAG_FULL, short) };
  }

  /* ---- touches ---------------------------------------------------------- */

  _hit(r, x, y) {
    return x >= r.x - PED_GROW && x <= r.x + r.w + PED_GROW
      && y >= r.y - PED_GROW && y <= r.y + r.h + PED_GROW;
  }

  /** Where on a pedal the thumb is, as a command. See PED_DETENT. */
  _pedalAmount(r, y) {
    const into = (y - r.y) / r.h;                 // 0 at the top, 1 at the foot
    if (into >= 1 - PED_DETENT) return 1;
    const u = Math.max(0, into) / Math.max(1e-6, 1 - PED_DETENT);
    return PED_FLOOR + (1 - PED_FLOOR) * u;
  }

  _start(e) {
    if (!this.live) return;
    if (e.cancelable) e.preventDefault();
    /* The gesture the iOS permission sheet has to be asked for from. First
       touch anywhere, whatever it turns out to be for. */
    this.requestTilt();
    const L = this.L;
    for (const t of e.changedTouches) {
      const x = t.clientX, y = t.clientY;
      let role = 'drag', rect = null;
      if (this._hit(L.throttle, x, y)) { role = 'throttle'; rect = L.throttle; }
      else if (this._hit(L.brake, x, y)) { role = 'brake'; rect = L.brake; }
      else if (this.tiltLive && this._hit(L.pill, x, y)) role = 'pill';
      this._points.set(t.identifier, {
        role, rect, x, y, x0: x, y0: y, t0: e.timeStamp, moved: 0, off: false,
      });
      if (role === 'pill') this.recentre();
    }
    this._reduce();
  }

  _move(e) {
    if (!this.live) return;
    if (e.cancelable) e.preventDefault();
    for (const t of e.changedTouches) {
      const p = this._points.get(t.identifier);
      if (!p) continue;
      p.x = t.clientX; p.y = t.clientY;
      p.moved = Math.max(p.moved, Math.hypot(p.x - p.x0, p.y - p.y0));
      /* A thumb that has slid off its pedal commands nothing WHILE IT IS OFF,
         and picks the same pedal up again if it slides back on. The latch this
         prevents is the one the brief names: without it a thumb that rolled
         over the edge of the throttle leaves it wide open until the hand is
         lifted, which on a downhill stage is the difference between a corner
         and a cliff. Re-acquisition is limited to the pedal the touch started
         on — see the note on `role`, which never changes. */
      if (p.rect) p.off = !this._hit(p.rect, p.x, p.y);
    }
    this._reduce();
  }

  _end(e) {
    if (!this.live) return;
    if (e.cancelable && e.type === 'touchend') e.preventDefault();
    for (const t of e.changedTouches) {
      const p = this._points.get(t.identifier);
      if (!p) continue;
      /* A tap is the release of a touch that was short, went nowhere and was
         not operating a control. `touchcancel` never produces one: a cancelled
         touch is the system taking the gesture away, not the player finishing
         it. */
      if (e.type === 'touchend' && p.role === 'drag'
        && e.timeStamp - p.t0 <= TAP_MS && p.moved <= TAP_PX) {
        this._tap = true;
      }
      this._points.delete(t.identifier);
    }
    this._reduce();
  }

  _clear() {
    this._points.clear();
    this._reduce();
  }

  /**
   * Every live touch, reduced to the three values the input layer reads.
   *
   * Run on every touch event rather than once a frame, so the values are
   * whatever the hardware last said. Multi-touch falls out of it: throttle and
   * brake are separate roles on separate identifiers, so holding both is two
   * entries in one map and needs no special case — which is the whole reason
   * the roles are keyed on `identifier` and not on a single "current touch".
   */
  _reduce() {
    let thr = 0, brk = 0, drag = null;
    for (const p of this._points.values()) {
      if (p.off) continue;
      if (p.role === 'throttle') thr = Math.max(thr, this._pedalAmount(p.rect, p.y));
      else if (p.role === 'brake') brk = Math.max(brk, this._pedalAmount(p.rect, p.y));
      else if (p.role === 'drag' && !drag) drag = p;
    }
    this.throttle = thr;
    this.brake = brk;

    const tilt = this.tiltSteer();
    if (tilt !== null) {
      this.steer = tilt;
      this._drag = null;
    } else if (drag) {
      const dx = drag.x - drag.x0;
      const mag = Math.abs(dx);
      this.steer = mag <= DRAG_DEAD ? 0
        : Math.sign(dx) * Math.min(1, (mag - DRAG_DEAD) / Math.max(1, this.L.dragFull));
      this._drag = drag;
    } else {
      /* Nothing is asking. Zero rather than the last value, for the reason the
         pad's disconnect case exists: a released control that keeps commanding
         is the worst failure an input layer has. */
      this.steer = 0;
      this._drag = null;
    }
  }

  /** The tap edge, consumed. Read once a frame by src/core/input.js. */
  takeTap() {
    const t = this._tap;
    this._tap = false;
    return t;
  }

  /**
   * What the HUD should draw, or null.
   *
   * Null is load-bearing, exactly as it is for the countdown, the ending and
   * the title: the HUD's draw path for "no touch controls" has to be the one
   * it had before this landed, byte for byte, and tools/hudparity.mjs gates
   * that at 0 differing bytes across 20 states.
   *
   * Geometry included, so ui/hud.js gains a draw method and no layout
   * knowledge — the pedals are hit-tested and drawn from the same rectangles,
   * which is what stops the paint and the target drifting apart.
   */
  display() {
    if (!this.live) return null;
    const L = this.L;
    return {
      rotate: this.h > this.w,
      tilt: this.tiltLive,
      denied: this.tiltDenied,
      calibrated: this._calibrated,
      steer: this.steer,
      pedals: [
        { ...L.brake, amount: this.brake },
        { ...L.throttle, amount: this.throttle },
      ],
      bar: L.bar,
      pill: this.tiltLive ? L.pill : null,
      /* So the HUD can mark where full begins. The detent is only learnable if
         it is visible; see PED_DETENT. */
      detent: PED_DETENT,
      insets: { ...this.insets },
    };
  }
}
