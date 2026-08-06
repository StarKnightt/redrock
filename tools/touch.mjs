/* Does the phone build actually work, on a phone?
 *
 *   node tools/touch.mjs                    the gate
 *   node tools/touch.mjs --break=sign       break one behaviour, expect red
 *   node tools/touch.mjs --breaks           run every break in turn, expect red each
 *
 * Everything in src/ui/touch.js had been written and never driven, because
 * driving it needs a phone and this machine does not have one. So this injects
 * one: a Playwright context with `hasTouch`, CDP `Input.dispatchTouchEvent` for
 * real multi-touch, and `DeviceOrientationEvent`s constructed and dispatched in
 * the page — every reading taken through the real `Game.step` and the real
 * `Hud.draw`, off the same code path a player would use.
 *
 * WHY THIS DOES NOT USE tools/harness.mjs's `run`. `run` calls
 * `browser.newPage({ viewport, deviceScaleFactor })`, and `hasTouch` is a
 * CONTEXT option — there is no hook to pass it. Rather than edit a file the
 * whole suite depends on (and which another agent is working in this round),
 * this owns its own launch and reuses `serve`, `settleBoot` and `checkAsync`
 * unchanged. The four Chromium flags are harness's GPU_ARGS verbatim, and the
 * process pinning is tools/tame.mjs's, imported for its side effects exactly as
 * harness does.
 *
 * FOUR CONTEXTS, because four different machines have to be measured and a
 * capability is fixed at context creation:
 *
 *   phone     844x390, hasTouch          the shipping case
 *   portrait  390x844, hasTouch          the rotate gate
 *   tierq     844x390, hasTouch, ?tier=  the override
 *   desktop   1600x900, NO hasTouch      the parity control
 *
 * The desktop context is not decoration. It is the negative control that makes
 * every other section mean something: if the touch controls are not INERT
 * there, then `tools/hudparity.mjs` passing is luck.
 *
 * FAILURE IS THE DEFAULT. Every section is entered into `results` pre-failed
 * before a browser exists, and only the bottom of a clean path clears it; a
 * probe that throws leaves the pre-set reason standing, and a section that
 * returns no rows is a failure rather than a vacuous pass. The exit code is
 * raised and never lowered, and `finish(process.exitCode || 0)` is never
 * `finish(0)`.
 *
 * READING THE EXIT CODE: do not pipe through tee, which reports its own status.
 * Redirect — `node tools/touch.mjs > log.txt 2>&1 ; echo $?`.
 *
 * ---- PROVING THE GATE CAN FAIL ----------------------------------------------
 *
 * `--breaks` is not a convenience, it is the point. This project has thrown
 * away ten probes for confidently reporting numbers they were structurally
 * incapable of seeing, so every behaviour below has a named lesion that is
 * applied in the page after boot, and the tool is expected to go RED for each.
 * The list is in BREAKS; each entry names the section it must kill. A break
 * that leaves the gate green is a check that was measuring nothing, and
 * `--breaks` reports that as its own failure.
 */
import { chromium } from 'playwright';
import './tame.mjs';
import { finish, guard } from './tame.mjs';
import { serve, settleBoot } from './harness.mjs';
import { checkAsync } from './check.mjs';

const GPU_ARGS = [
  '--autoplay-policy=no-user-gesture-required',
  '--disable-dev-shm-usage',
  '--disable-features=CalculateNativeWinOcclusion,site-per-process',
  '--disable-background-timer-throttling',
  '--renderer-process-limit=1',
  '--use-angle=d3d11',
  '--enable-gpu-rasterization',
  '--ignore-gpu-blocklist',
  '--enable-zero-copy',
];

/* The simulated notch.
 *
 * APPLE'S PUBLISHED CONSTANTS, and labelled as such rather than measured, for
 * the reason .fix/FINDINGS-mobile.md gives: headless Chromium reports zero for
 * all four insets and there is no device here. An iPhone 14 Pro in landscape
 * reports left/right 59, bottom 21, top 0 — the sensor housing eats one full
 * side and the home indicator a strip off the foot. Both sides are inset here
 * because the housing is on the left in one landscape orientation and the right
 * in the other, and a layout that only clears one of them is a layout that
 * fails for half the players who rotate the other way.
 *
 * The point of driving the layout with these rather than reasoning about them
 * is that the HUD can be PHOTOGRAPHED against them. See S_INSETS. */
const NOTCH = { top: 0, right: 59, bottom: 21, left: 59 };

/* ---- the kit, installed in the page ------------------------------------- */

/* Serialised into the page by page.evaluate, so it has no imports and closes
   over nothing — tools/padkit.mjs's contract, for the same reason. */
const KIT = () => {
  const g = window.__game;
  /* The rAF loop must not step behind a probe. */
  g.setPaused(true);

  const k = {
    rows: [],
    row(name, ok, got, want) {
      k.rows.push({ name, ok: !!ok, got: String(got), want: String(want) });
    },
    near(a, b, tol) { return Math.abs(a - b) <= tol; },
    take() { const r = k.rows; k.rows = []; return { rows: r }; },

    step(n = 1) { for (let j = 0; j < n; j++) g.step(1 / 60); },

    /* Back to a car that can move, and to a touch object with no history:
       restart() arms the countdown unconditionally, so a probe that wants the
       car to drive has to put the lights out itself. */
    grid() {
      g.autopilot(false);
      g.botInput = null;
      g.title.skip();
      g.restart();
      g.countdown.skip();
      g.ending.skip();
      g.pause.close();
      k.tiltOff();
      g.touch._clear();
      k.step(1);
    },

    /* ---- tilt ---------------------------------------------------------- */

    /* One orientation reading, as the hardware would deliver it. `beta` is
       pitch (nose up), `gamma` is roll (right side down); `alpha` is set to a
       nonsense heading on purpose, because a compass bearing must not reach the
       steering — see the derivation in src/ui/touch.js. */
    orient(beta, gamma, alpha = 217) {
      dispatchEvent(new DeviceOrientationEvent('deviceorientation', {
        alpha, beta, gamma, absolute: true,
      }));
    },
    /* Hold an attitude for long enough to fill the calibration ring. */
    hold(beta, gamma, n = 25) { for (let i = 0; i < n; i++) k.orient(beta, gamma); },
    tiltOn() {
      g.touch.tiltAsked = false;
      g.touch.tiltDenied = false;
      g.touch.requestTilt();
    },
    tiltOff() {
      const t = g.touch;
      removeEventListener('deviceorientation', t._onOrient);
      t.tiltLive = false; t.tiltAsked = false; t.tiltDenied = false;
      t._roll = 0; t._neutral = 0; t._ring.length = 0; t._calibrated = false;
      t._reduce();
    },
    /* The screen's own rotation, which the transform has to divide out. There
       is no way to make headless Chromium report 90 without `isMobile`, and
       `isMobile` changes viewport handling as well, so this overrides the one
       property that is read. */
    setScreenAngle(a) {
      Object.defineProperty(screen, 'orientation', {
        configurable: true, value: { angle: a, type: a ? 'landscape-primary' : 'portrait-primary' },
      });
    },

    /* ---- what the game thinks ------------------------------------------ */

    read() {
      const i = g.input, t = g.touch;
      return {
        steer: i.steer, throttle: i.throttle, brake: i.brake,
        tSteer: t.steer, tThrottle: t.throttle, tBrake: t.brake,
        tilt: t.tiltLive, denied: t.tiltDenied, live: t.live, rotate: t.rotate,
        display: t.display(),
      };
    },
    /* The pedal rectangles, so the driver can aim CDP touches at them without
       duplicating the layout. Centre of the detent zone: three quarters down,
       which commands 1.0. */
    pedals() {
      const L = g.touch.L;
      const mid = r => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h * 0.78) });
      return {
        throttle: mid(L.throttle), brake: mid(L.brake),
        feather: {
          x: Math.round(L.throttle.x + L.throttle.w / 2),
          y: Math.round(L.throttle.y + L.throttle.h * 0.06),
        },
        offThrottle: { x: Math.round(L.throttle.x + L.throttle.w / 2), y: Math.round(L.throttle.y - 60) },
        rects: { throttle: { ...L.throttle }, brake: { ...L.brake }, bar: { ...L.bar }, pill: { ...L.pill } },
        empty: { x: Math.round(g.touch.w / 2), y: Math.round(g.touch.h * 0.35) },
      };
    },

    /* ---- the notch ------------------------------------------------------ */

    setInsets(o) {
      const s = document.documentElement.style;
      for (const [ke, v] of Object.entries(o)) s.setProperty('--sai-' + ke, v + 'px');
      g.resize();
    },
    clearInsets() {
      const s = document.documentElement.style;
      for (const ke of ['top', 'right', 'bottom', 'left']) s.removeProperty('--sai-' + ke);
      g.resize();
    },

    /* ---- what is on the glass ------------------------------------------ */

    /* The bounding box of every non-transparent pixel on the HUD canvas, plus
       the count. This is the only honest way to ask whether the layout cleared
       the notch: the alternative is to read the layout object back, which is
       asking the code under test to grade itself. */
    /* A REAL FRAME, and then the shutter. The step is not decoration: the touch
       geometry reaches the HUD on the `display()` payload that `Game.step`
       hands it, so a draw taken straight after a resize paints the rectangles
       from before it. That is one frame of staleness the player never sees —
       the rAF callback steps and draws in the same task, and a resize event
       cannot land between them — but a probe that skipped the step photographed
       it, and spent a while looking like a layout bug. */
    inkBox(guardIns) {
      k.step(1);
      g.hud.draw();
      const c = document.getElementById('hud');
      const W = c.width, H = c.height;
      const d = c.getContext('2d').getImageData(0, 0, W, H).data;
      const s = g.hud.dpr;
      const I = guardIns
        ? { t: guardIns.top * s, r: guardIns.right * s, b: guardIns.bottom * s, l: guardIns.left * s }
        : null;
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
      /* Not just the box: WHERE it broke out, so a failure names the element
         rather than leaving the next reader to guess. */
      const out = [];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (d[(y * W + x) * 4 + 3] <= 8) continue;
          n++;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
          if (I && out.length < 400
            && (x < I.l || x > W - 1 - I.r || y < I.t || y > H - 1 - I.b)) out.push([x, y]);
        }
      }
      return { n, x0, y0, x1, y1, W, H, dpr: s, out: out.slice(0, 400), outN: out.length };
    },
    /* Opacity of the whole canvas, for the rotate screen, which claims to be an
       opaque field rather than a wash. Sampled on a coarse grid: a full read of
       a 390x844 canvas is 1.3 M pixels and this is asked for several times. */
    coverage() {
      g.hud.draw();
      const c = document.getElementById('hud');
      const W = c.width, H = c.height;
      const d = c.getContext('2d').getImageData(0, 0, W, H).data;
      let opaque = 0, any = 0, total = 0;
      for (let y = 0; y < H; y += 4) {
        for (let x = 0; x < W; x += 4) {
          const a = d[(y * W + x) * 4 + 3];
          total++;
          if (a > 8) any++;
          if (a > 250) opaque++;
        }
      }
      return { opaque: opaque / total, any: any / total, W, H };
    },
  };
  window.__tk = k;
  return true;
};

/* ---- the lesions -------------------------------------------------------- */

/* Applied in the page after boot, one at a time, to prove each section is
   measuring something. Each is the smallest edit that removes the BEHAVIOUR
   rather than the check — a break that only moves a number would prove nothing.
 *
 * Written as a switch inside one serialisable function for the same reason KIT
 * is: page.evaluate takes a function, not a closure. */
const LESION = (name) => {
  const g = window.__game, t = g.touch;
  switch (name) {
    /* Steering that answers the wrong way. The classic sign error, and the one
       failure a player notices in the first corner. */
    case 'sign':
      t.tiltSteer = function () {
        const deg = (this._roll - this._neutral) / (Math.PI / 180);
        const mag = Math.abs(deg);
        if (mag <= this.deadDeg) return 0;
        const span = Math.max(1e-6, this.fullDeg - this.deadDeg);
        const u = Math.min(1, (mag - this.deadDeg) / span);
        return -Math.sign(deg) * Math.pow(u, this.exp);
      };
      return true;
    // No deadzone at all — hand tremor becomes steering.
    case 'dead': t.deadDeg = 0; return true;
    // Full lock unreachable: 50 degrees is past where a phone can be read.
    case 'full': t.fullDeg = 50; return true;
    // Never calibrate. The "steers left forever" bug.
    case 'nocal':
      t.calibrate = () => false;
      t.recentre = () => false;
      return true;
    /* The pitch-dependent signal: raw gamma, which is what everyone reaches for
       first and which changes with how the phone is held. */
    case 'pitch':
      t._orient = function (e) {
        if (e.gamma === null || e.gamma === undefined) return;
        this._roll = e.gamma * (Math.PI / 180);
        this._ring.push(this._roll);
        if (this._ring.length > 20) this._ring.shift();
        if (!this.tiltLive) { this.tiltLive = true; this._neutral = this._roll; }
      };
      return true;
    // A thumb that slides off the pedal latches it open.
    case 'latch':
      t._move = function (e) {
        if (!this.live) return;
        for (const tt of e.changedTouches) {
          const p = this._points.get(tt.identifier);
          if (!p) continue;
          p.x = tt.clientX; p.y = tt.clientY;
        }
        this._reduce();
      };
      return true;
    // One control at a time: the last touch wins and the other is dropped.
    case 'multi':
      t._reduce = function () {
        let last = null;
        for (const p of this._points.values()) if (p.rect) last = p;
        this.throttle = last && last.role === 'throttle' ? 1 : 0;
        this.brake = last && last.role === 'brake' ? 1 : 0;
        const tilt = this.tiltSteer();
        this.steer = tilt === null ? 0 : tilt;
      };
      return true;
    // Portrait plays anyway.
    case 'rotate':
      Object.defineProperty(t, 'rotate', { configurable: true, get: () => false });
      return true;
    /* The bug this round is fixing, restored: the HUD is laid out from the glass
       and not from the safe area. */
    case 'insets':
      g.resize = function () {
        const w = innerWidth, h = innerHeight;
        this.renderer.setSize(w, h, false);
        this.pipeline.setSize(w, h);
        this.touch.resize(w, h, { top: 0, right: 0, bottom: 0, left: 0 });
        this.hud.resize(w, h, devicePixelRatio, { touch: this.touch.live });
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
      };
      g.resize();
      return true;
    // A phone that renders at desktop quality.
    case 'tier': g.tier = 'high'; return true;
    // And the other half: an explicit ?tier= that the auto-selection overrules.
    case 'override': g.tier = 'low'; return true;
    /* Tilt claimed when there is none, which is what would strand a player
       whose permission was refused: they get a TILT label, a CENTRE control and
       no steering at all, instead of the drag fallback. */
    case 'faketilt':
      Object.defineProperty(t, 'tiltLive', { configurable: true, get: () => true, set() {} });
      return true;
    // The rotate screen over a perfectly good landscape frame.
    case 'alwaysrotate':
      Object.defineProperty(t, 'rotate', { configurable: true, get: () => true });
      return true;
    /* Touch targets scaled like HUD furniture instead of in absolute pixels —
       the mistake PED_W exists to prevent. 30 px is what 55u comes to on a
       phone in landscape. */
    case 'tinypedals': {
      const orig = t._layout.bind(t);
      t._layout = function () {
        orig();
        for (const r of [this.L.throttle, this.L.brake]) { r.w = 30; r.h = 30; }
      };
      t._layout();
      return true;
    }
    // No way off the title screen or off the results card.
    case 'tap': t.takeTap = () => false; return true;
    /* Dormancy broken: the controls draw even where they are not wanted, which
       is what would put tools/hudparity.mjs off zero. */
    case 'dormant':
      Object.defineProperty(t, 'live', { configurable: true, get: () => true });
      t.wanted = true;
      return true;
    default: return 'unknown lesion: ' + name;
  }
};

/* Which section(s) each lesion must kill. A break that leaves its section green
   is a check that was measuring nothing.
 *
 * Between them these cover all twelve sections, which is deliberate: a section
 * with no lesion aimed at it has never been shown to be capable of failing, and
 * this project has thrown away ten probes that could not fail. */
const BREAKS = [
  ['sign', ['tilt', 'drive']],
  ['dead', ['tilt']],
  ['full', ['tilt']],
  ['nocal', ['tilt']],
  ['pitch', ['tilt']],
  ['latch', ['pedals']],
  ['multi', ['pedals']],
  ['faketilt', ['drag']],
  ['tinypedals', ['device']],
  ['rotate', ['portrait']],
  ['alwaysrotate', ['landscape']],
  ['insets', ['insets']],
  ['tier', ['tier']],
  ['override', ['tierq']],
  ['tap', ['tap']],
  ['dormant', ['desktop']],
];

/* ---- sections ---------------------------------------------------------- */

/* The instrument's own liveness. If this does not hold, everything below is
   measuring a device the game cannot see. */
const S_DEVICE = () => {
  const k = window.__tk, g = window.__game, t = g.touch;
  k.row('the context reports a touchscreen',
    navigator.maxTouchPoints > 0, `maxTouchPoints ${navigator.maxTouchPoints}`, '> 0');
  k.row('and the primary pointer is coarse and cannot hover',
    matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches,
    `coarse ${matchMedia('(pointer: coarse)').matches}, hover:none ${matchMedia('(hover: none)').matches}`,
    'true, true');
  k.row('so touchPrimary() says the primary pointer is a finger',
    t.supported, t.supported, true);
  k.row('the controls are live (?touch=1 past the manual gate)',
    t.live && t.wanted, `live ${t.live} wanted ${t.wanted}`, 'true true');
  const d = t.display();
  k.row('and display() hands the HUD a payload with two pedals and a bar',
    !!d && Array.isArray(d.pedals) && d.pedals.length === 2 && !!d.bar,
    d ? `${d.pedals.length} pedals, bar ${d.bar.w.toFixed(0)}x${d.bar.h.toFixed(0)}` : 'NULL',
    '2 pedals and a bar');
  /* The 44 px floor, which is why the pedals are authored in CSS pixels rather
     than in the HUD's u. See PED_W in src/ui/touch.js. */
  const L = t.L;
  const small = Math.min(L.throttle.w, L.throttle.h, L.brake.w, L.brake.h);
  k.row('every pedal clears the 44 CSS px touch-target floor on both axes',
    small >= 44,
    `smallest side ${small.toFixed(1)} px (${L.throttle.w.toFixed(0)}x${L.throttle.h.toFixed(0)})`,
    '>= 44');
  return k.take();
};

/* Tilt: the maths, the sign, the deadzone, the curve, the calibration, and the
 * invariance the signal was chosen for. All by injecting real
 * DeviceOrientationEvents, which .fix/tprobe2.mjs proved Chromium accepts. */
const S_TILT = () => {
  const k = window.__tk, g = window.__game, t = g.touch;
  k.grid();

  /* Negative control FIRST: with no orientation event ever delivered, tilt must
     not be claimed. A device with no gyroscope is indistinguishable from one
     whose permission was refused, and both have to fall back. */
  k.row('negative control — no orientation event yet, so tilt is not live',
    !t.tiltLive && t.tiltSteer() === null,
    `tiltLive ${t.tiltLive}, tiltSteer ${t.tiltSteer()}`, 'false, null');

  k.tiltOn();
  /* An empty event, which some browsers fire before the sensor is up and which
     one gyroscope-less device fires exclusively. It must not count. */
  dispatchEvent(new DeviceOrientationEvent('deviceorientation',
    { alpha: null, beta: null, gamma: null }));
  k.row('negative control — an empty reading does not make tilt live',
    !t.tiltLive, `tiltLive ${t.tiltLive}`, false);

  // Flat and level, held long enough to calibrate against.
  k.hold(0, 0);
  t.calibrate();
  k.row('a real reading makes tilt live, and flat-and-level is zero steer',
    t.tiltLive && t.tiltSteer() === 0,
    `tiltLive ${t.tiltLive}, steer ${t.tiltSteer()}`, 'true, 0');

  /* The sign. `gamma` positive is the device's right side going DOWN, which is
     the gesture for turning right. */
  k.orient(0, 20);
  const right = t.tiltSteer();
  k.orient(0, -20);
  const left = t.tiltSteer();
  k.row('rolling the right side down steers right, and the left side down steers left',
    right > 0.5 && left < -0.5,
    `+20 deg -> ${right.toFixed(4)}, -20 deg -> ${left.toFixed(4)}`,
    '> +0.5 and < -0.5');

  // The deadzone, either side of 3 degrees.
  k.orient(0, 2.5);
  const under = t.tiltSteer();
  k.orient(0, 3.5);
  const over = t.tiltSteer();
  k.row('the 3 degree deadzone rejects 2.5 and passes 3.5',
    under === 0 && over > 0,
    `2.5 deg -> ${under}, 3.5 deg -> ${over.toExponential(3)}`, '0 and non-zero');

  // Full lock at the authored angle, and not before.
  k.orient(0, t.fullDeg);
  const atFull = t.tiltSteer();
  k.orient(0, t.fullDeg + 15);
  const past = t.tiltSteer();
  k.orient(0, t.fullDeg * 0.6);
  const before = t.tiltSteer();
  k.row(`full lock arrives at ${t.fullDeg} degrees, is clamped past it, and is not reached before`,
    k.near(atFull, 1, 1e-9) && past === 1 && before < 0.95,
    `${t.fullDeg} -> ${atFull.toFixed(6)}, ${t.fullDeg + 15} -> ${past}, ${(t.fullDeg * 0.6).toFixed(0)} -> ${before.toFixed(4)}`,
    '1, 1, and under 0.95');

  /* The curve. Half of the usable range must give more than a square would and
     less than linear — the whole argument for 1.5 (see TILT_EXP). Computed from
     the angle rather than from the exponent, so changing the exponent moves this
     row rather than hiding behind it. */
  const half = t.deadDeg + (t.fullDeg - t.deadDeg) * 0.5;
  k.orient(0, half);
  const mid = t.tiltSteer();
  k.row('at half the usable range the command sits between a square and linear',
    mid > 0.26 && mid < 0.48,
    `${half.toFixed(1)} deg -> ${mid.toFixed(4)} (square 0.25, linear 0.50)`,
    '0.26 .. 0.48');

  /* THE SIGNAL AGAINST AN INDEPENDENT CONSTRUCTION.
   *
   * src/ui/touch.js uses the closed form of the third row of Rz(a)Rx(b)Ry(g).
   * This multiplies the three matrices out numerically and takes the same row,
   * which is a genuinely separate derivation rather than the same expression
   * written twice — a transcription error in either one shows up here. */
  const mul = (A, B) => A.map((r, i) => [0, 1, 2].map(j =>
    r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  const D = Math.PI / 180;
  const Rz = a => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
  const Rx = a => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const Ry = a => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
  /* R maps device coordinates to earth. Earth's down is (0,0,-1), so down in
     device coordinates is -R^T's third column, i.e. minus R's third ROW. */
  const gravity = (a, b, g) => {
    const R = mul(mul(Rz(a * D), Rx(b * D)), Ry(g * D));
    return [-R[2][0], -R[2][1], -R[2][2]];
  };
  const GRID = [[0, 0, 0], [217, 0, 20], [40, 25, 12], [-95, -35, -18],
    [180, 55, 44], [12, -60, 30], [300, 15, -75]];
  let worst = 0, worstAt = '';
  k.setScreenAngle(0);
  for (const [a, b, g] of GRID) {
    const want = Math.asin(Math.max(-1, Math.min(1, gravity(a, b, g)[0])));
    k.tiltOff(); k.tiltOn();
    k.orient(b, g, a);
    const got = t._roll;
    const e = Math.abs(got - want);
    if (e > worst) { worst = e; worstAt = `a${a} b${b} g${g}`; }
  }
  k.row('the roll matches a gravity vector built by multiplying the three rotations out',
    worst < 1e-9 && GRID.length === 7,
    `worst error ${worst.toExponential(3)} rad over ${GRID.length} attitudes (at ${worstAt})`,
    '< 1e-9 rad');

  /* THE POSE SWEEP, which is what replaced a pitch-invariance check that was
   * claiming something false. See §2 of .fix/FINDINGS-touch.md.
   *
   * A phone is held somewhere between flat and vertical, and the steering
   * gesture is different at the two ends: near flat you roll it about the
   * screen's own vertical axis, near vertical you turn it like a wheel, about
   * the screen's normal. Those two put `sin t cos p` and `sin t sin p` into the
   * signal respectively, so neither is available at both ends — but at least
   * one of `cos p` and `sin p` is always above 0.707, so the BETTER of the two
   * always retains most of the authority. That is the claim, and it is what is
   * gated: at every pitch from flat to nearly vertical, one of the two natural
   * gestures achieves at least 70.7% of what it would achieve on a table.
   *
   * Both poses are constructed as rotation matrices and inverted back to Euler
   * angles, so the events injected are the ones the hardware would send for a
   * player actually doing that. */
  const eulerOf = (R) => {
    const b = Math.asin(Math.max(-1, Math.min(1, R[2][1])));
    return {
      beta: b / D,
      gamma: Math.atan2(-R[2][0], R[2][2]) / D,
      alpha: Math.atan2(-R[0][1], R[1][1]) / D,
    };
  };
  k.setScreenAngle(0);
  const GEST = 20;
  const floor = Math.asin(Math.SQRT1_2 * Math.sin(GEST * D)) / D;
  const sweep = [];
  for (const p of [0, 15, 30, 45, 60, 75, 85]) {
    const base = Rx(p * D);
    const rest = eulerOf(base);
    const poses = {
      // Roll about the screen's vertical axis: the flat-phone gesture.
      wrist: eulerOf(mul(base, Ry(GEST * D))),
      // Turn it like a steering wheel: the upright-phone gesture.
      wheel: eulerOf(mul(base, Rz(-GEST * D))),
    };
    const out = { p };
    for (const [kind, e] of Object.entries(poses)) {
      k.tiltOff(); k.tiltOn();
      for (let i = 0; i < 25; i++) k.orient(rest.beta, rest.gamma, rest.alpha);
      t.calibrate();
      k.orient(e.beta, e.gamma, e.alpha);
      out[kind] = (t._roll - t._neutral) / D;
    }
    out.best = Math.max(out.wrist, out.wheel);
    sweep.push(out);
  }
  k.row(`at every pitch from flat to 85 degrees, one natural gesture keeps most of the authority`,
    sweep.every(s => s.best >= floor - 0.05),
    sweep.map(s => `${s.p}deg:${s.best.toFixed(1)}`).join(' '),
    `every one >= ${floor.toFixed(1)} degrees of signal for a ${GEST} degree gesture`);
  k.row('and neither gesture ever answers the WRONG way at any pitch',
    sweep.every(s => s.wrist >= -0.001 && s.wheel >= -0.001),
    sweep.map(s => `${s.p}:${s.wrist.toFixed(1)}/${s.wheel.toFixed(1)}`).join(' '),
    'all non-negative');
  k.row('MEASUREMENT — how the two gestures trade off across the pose range',
    true,
    sweep.map(s => `p${s.p} wrist ${s.wrist.toFixed(1)} wheel ${s.wheel.toFixed(1)}`).join(' | '),
    '(reported, not gated — see FINDINGS §2)');
  k.tiltOff(); k.tiltOn();
  k.hold(0, 0);
  t.calibrate();

  /* And that a compass heading is not a steering input. */
  k.hold(10, 0);
  t.calibrate();
  const headA = t.tiltSteer();
  for (const a of [0, 90, 180, 270, 355]) k.orient(10, 0, a);
  const headB = t.tiltSteer();
  k.row('turning round on the spot does not steer — alpha is ignored',
    k.near(headA, headB, 1e-9) && headB === 0,
    `heading swept 0..355 deg, steer ${headA} -> ${headB}`, '0 -> 0');

  /* CALIBRATION. Nobody holds a phone flat: held at 15 degrees and calibrated,
     the command must be zero there and full lock must still be reachable
     relative to it. */
  k.hold(0, 15);
  const beforeCal = t.tiltSteer();
  const ok = t.calibrate();
  const afterCal = t.tiltSteer();
  k.orient(0, 15 + t.fullDeg);
  const fromTilted = t.tiltSteer();
  k.orient(0, 15 - t.fullDeg);
  const otherWay = t.tiltSteer();
  k.row('held at 15 degrees, calibration makes THAT zero and keeps both locks reachable',
    ok && beforeCal > 0.3 && afterCal === 0
    && k.near(fromTilted, 1, 1e-6) && k.near(otherWay, -1, 1e-6),
    `before ${beforeCal.toFixed(4)}, after ${afterCal}, +lock ${fromTilted.toFixed(4)}, -lock ${otherWay.toFixed(4)}`,
    'was steering, now 0, and +/-1 reachable');

  /* The re-centre control snaps to the LATEST reading rather than the mean, so
     a player who has drifted gets an immediate answer. */
  k.hold(0, 0);
  t.calibrate();
  k.orient(0, 9);
  const drifted = t.tiltSteer();
  t.recentre();
  const centred = t.tiltSteer();
  k.row('the CENTRE control zeroes wherever the phone is being held now',
    drifted > 0.1 && centred === 0,
    `drifted ${drifted.toFixed(4)} -> ${centred}`, 'non-zero -> 0');

  /* The orientation transform. The same wrist gesture must mean the same thing
     in both landscape orientations, which is the whole reason the signal is in
     the SCREEN frame and not the device's. */
  const byAngle = {};
  for (const ang of [0, 90, 270]) {
    k.setScreenAngle(ang);
    k.tiltOff(); k.tiltOn();
    k.hold(0, 0);
    t.calibrate();
    /* The same physical tilt of the SCREEN's left-right axis, reported in the
       device's frame — which is a different pair of Euler angles at each screen
       angle, because at 90 and 270 the screen's x axis is the device's y. If the
       transform were missing, two of these three would read zero. */
    if (ang === 0) k.orient(0, 20);
    else if (ang === 90) k.orient(-20, 0);
    else k.orient(20, 0);
    byAngle[ang] = t.tiltSteer();
  }
  k.setScreenAngle(0);
  k.row('the same physical roll steers the same way at screen angles 0, 90 and 270',
    byAngle[0] > 0.5 && byAngle[90] > 0.5 && byAngle[270] > 0.5,
    Object.entries(byAngle).map(([a, v]) => `${a}deg -> ${v.toFixed(4)}`).join(', '),
    'all > +0.5');

  /* And the permission path. Chromium has no requestPermission (see
     .fix/tprobe2.mjs), so both branches are exercised by injecting one. */
  k.tiltOff();
  const DOE = DeviceOrientationEvent;
  DOE.requestPermission = () => Promise.resolve('denied');
  t.tiltAsked = false;
  t.requestTilt();
  const askedDenied = t.tiltAsked;
  delete DOE.requestPermission;
  k.row('a refused permission is asked for exactly once and does not claim tilt',
    askedDenied && !t.tiltLive,
    `asked ${askedDenied}, tiltLive ${t.tiltLive}`, 'asked, not live');
  return k.take();
};

/* The permission refusal has to be a fallback and not a dead end, so this is
 * its own section: drag steering, with no orientation event ever delivered. */
const S_DRAG = () => {
  const k = window.__tk, g = window.__game, t = g.touch;
  k.grid();
  k.tiltOff();
  k.row('with tilt unavailable the HUD is told to print DRAG, not TILT',
    t.display() && t.display().tilt === false,
    `display().tilt ${t.display() ? t.display().tilt : 'NO PAYLOAD'}`, false);
  k.row('and there is no re-centre control to press, because there is nothing to centre',
    t.display() && t.display().pill === null,
    `display().pill ${t.display() && t.display().pill ? 'present' : 'null'}`, 'null');
  return k.take();
};

/* Portrait. */
const S_PORTRAIT = () => {
  const k = window.__tk, g = window.__game, t = g.touch;
  k.grid();
  k.row('a portrait viewport on a phone raises the rotate gate',
    t.rotate && innerHeight > innerWidth,
    `${innerWidth}x${innerHeight}, rotate ${t.rotate}`, 'taller than wide, rotate true');
  const d = t.display();
  k.row('and the payload says so, so the HUD draws it rather than the game',
    !!d && d.rotate === true, d ? `display().rotate ${d.rotate}` : 'NO PAYLOAD', true);

  /* The screen is an OPAQUE field, not a wash: the refused frame must not show
     through under the message. Measured off the canvas rather than asserted. */
  const cov = k.coverage();
  k.row('the rotate screen covers the whole canvas opaquely',
    cov.opaque > 0.97,
    `${(cov.opaque * 100).toFixed(1)}% of sampled pixels at alpha > 250`, '> 97%');

  /* And it is a composition rather than a bare line of text: three marks, so
     there has to be substantially more ink than a caption. Counted as pixels
     that are neither the ink field nor fully transparent. */
  const c = document.getElementById('hud');
  const W = c.width, H = c.height;
  const d2 = c.getContext('2d').getImageData(0, 0, W, H).data;
  let marks = 0;
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4;
      // Anything lighter than the ink field (#241812) is a drawn mark.
      if (d2[i] > 80 || d2[i + 1] > 70) marks++;
    }
  }
  const frac = marks / ((W / 2) * (H / 2));
  k.row('and it is a composition, not a line of text — the pictogram and the slab are there',
    frac > 0.02 && frac < 0.5,
    `${(frac * 100).toFixed(2)}% of the field is drawn marks`, '2% .. 50%');

  /* Nothing is stepped behind it: the countdown must not run out while the
     player is turning the phone round. */
  g.countdown.arm();
  const before = g.countdown.t;
  const armed = g.countdown.alive;
  k.step(120);                                // two seconds of frames
  k.row('nothing advances behind it — two seconds of frames do not move the lights',
    armed && g.countdown.alive && k.near(g.countdown.t, before, 1e-9),
    `armed ${armed}, t ${before.toFixed(3)} -> ${g.countdown.t.toFixed(3)}, still alive ${g.countdown.alive}`,
    'armed, t unchanged, still alive');
  g.countdown.skip();
  return k.take();
};

/* Landscape, on the same context, so the only thing that changed is the shape
   of the viewport. */
const S_LANDSCAPE = () => {
  const k = window.__tk, g = window.__game, t = g.touch;
  k.grid();
  k.row('the same phone in landscape does NOT raise the rotate gate',
    !t.rotate && innerWidth > innerHeight,
    `${innerWidth}x${innerHeight}, rotate ${t.rotate}`, 'wider than tall, rotate false');
  const cov = k.coverage();
  k.row('and the HUD is furniture again rather than an opaque field',
    cov.opaque < 0.5 && cov.any > 0.01,
    `${(cov.opaque * 100).toFixed(1)}% opaque, ${(cov.any * 100).toFixed(1)}% drawn`,
    'under 50% opaque, something drawn');
  return k.take();
};

/* The safe area. Driven, not reasoned about: the insets are forced through the
 * custom properties index.html declares, and the HUD is then PHOTOGRAPHED. */
const S_INSETS = ([NOTCH]) => {
  const k = window.__tk, g = window.__game;
  k.grid();
  k.tiltOff();

  k.clearInsets();
  const zero = k.inkBox();
  k.row('control — with no notch the HUD uses the whole glass',
    zero.n > 0 && zero.x0 < 40,
    `ink from x${zero.x0} y${zero.y0} to x${zero.x1} y${zero.y1} of ${zero.W}x${zero.H}`,
    'starts near the left edge');

  k.setInsets(NOTCH);
  const got = g.hud.insets;
  k.row('the four env() insets are read back through the CSS custom properties',
    got.left === NOTCH.left && got.right === NOTCH.right && got.bottom === NOTCH.bottom,
    `top ${got.top} right ${got.right} bottom ${got.bottom} left ${got.left}`,
    `top ${NOTCH.top} right ${NOTCH.right} bottom ${NOTCH.bottom} left ${NOTCH.left}`);

  const box = k.inkBox(NOTCH);
  const s = box.dpr;
  const where = box.out.length
    ? ` — ${box.outN} stray px, e.g. ` + box.out.slice(0, 6).map(p => `(${p[0]},${p[1]})`).join(' ')
    : '';
  k.row('EVERY HUD pixel clears the notch, the home indicator and both corners',
    box.n > 0 && box.outN === 0,
    `ink x ${box.x0}..${box.x1} y ${box.y0}..${box.y1} of ${box.W}x${box.H}${where}`,
    `nothing outside x ${NOTCH.left * s}..${box.W - 1 - NOTCH.right * s},`
    + ` y ${NOTCH.top * s}..${box.H - 1 - NOTCH.bottom * s}`);
  k.row('and the layout actually MOVED — the row above is not passing on slack',
    box.x0 > zero.x0 + 20,
    `left edge of the ink ${zero.x0} -> ${box.x0}`, `moved right by > 20 px`);

  /* A control under hardware is worse than a readout under it, because the
     operating system eats the touch as well as the pixels. */
  const L = g.touch.L;
  const w = g.touch.w, h = g.touch.h;
  const clears = r => r.x >= NOTCH.left && r.x + r.w <= w - NOTCH.right
    && r.y >= NOTCH.top && r.y + r.h <= h - NOTCH.bottom;
  k.row('both pedals, the steering bar and the CENTRE pill are all inside the safe area',
    clears(L.brake) && clears(L.throttle) && clears(L.bar) && clears(L.pill),
    `brake x${L.brake.x.toFixed(0)} throttle right ${(L.throttle.x + L.throttle.w).toFixed(0)}`
    + ` of ${w}, bar bottom ${(L.bar.y + L.bar.h).toFixed(0)} of ${h}`,
    `x >= ${NOTCH.left}, right <= ${w - NOTCH.right}, bottom <= ${h - NOTCH.bottom}`);

  /* And the collision the touch layout exists to avoid: the speed dial must not
     be sitting under the throttle. */
  const D = g.hud.L.dial;
  const dial = { x: D.cx - D.r, y: D.cy - D.r, w: D.r * 2, h: D.r * 2 };
  const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  k.row('the speed dial has moved out from under the throttle pedal',
    !hits(dial, L.throttle) && !hits(dial, L.brake),
    `dial x${dial.x.toFixed(0)} y${dial.y.toFixed(0)} ${dial.w.toFixed(0)}px,`
    + ` throttle x${L.throttle.x.toFixed(0)} y${L.throttle.y.toFixed(0)}`,
    'no overlap');

  k.clearInsets();
  return k.take();
};

/* Tier auto-selection. */
const S_TIER = ([want]) => {
  const k = window.__tk, g = window.__game;
  k.row('isPhone() agrees this is a phone-sized panel',
    Math.min(screen.width, screen.height) <= 500,
    `screen ${screen.width}x${screen.height}, short side ${Math.min(screen.width, screen.height)}`,
    '<= 500');
  k.row(`the render tier is '${want}'`, g.tier === want, g.tier, want);
  k.row('and the tier actually reached the renderer',
    Math.abs(g.renderer.getPixelRatio() - Math.min(devicePixelRatio, want === 'low' ? 0.75 : 1)) < 1e-9,
    `pixelRatio ${g.renderer.getPixelRatio()}`,
    Math.min(devicePixelRatio, want === 'low' ? 0.75 : 1));
  return k.take();
};

/* The desktop control. This is the section that makes the rest mean something:
 * without a touchscreen NOTHING may be drawn, read or gated. */
const S_DESKTOP = () => {
  const k = window.__tk, g = window.__game, t = g.touch;
  k.row('no touchscreen, so the controls are not supported and not live',
    !t.supported && !t.live, `supported ${t.supported}, live ${t.live}`, 'false, false');
  k.row('display() is NULL, which is what keeps hudparity at zero differing bytes',
    t.display() === null, String(t.display()), 'null');
  k.row('the HUD was never told this is a touch build',
    g.hud.touchUi === false, g.hud.touchUi, false);
  k.row('and it read four zero insets',
    g.hud.insets.top === 0 && g.hud.insets.right === 0
    && g.hud.insets.bottom === 0 && g.hud.insets.left === 0,
    JSON.stringify(g.hud.insets), 'all zero');
  /* The margins are the numbers they always were, to the bit. */
  const L = g.hud.L;
  k.row('so pad.l, pad.t, pad.r and pad.b are all exactly the old margin `m`',
    L.pad.l === L.m && L.pad.t === L.m && L.pad.r === L.m && L.pad.b === L.m,
    `m ${L.m}, pad ${L.pad.t}/${L.pad.r}/${L.pad.b}/${L.pad.l}`, 'all === m');
  k.row('and the speed dial is in the bottom-right corner where it has always been',
    Math.abs(L.dial.cy - (innerHeight - L.m - L.dial.r)) < 1e-9,
    `cy ${L.dial.cy.toFixed(4)}`, (innerHeight - L.m - L.dial.r).toFixed(4));
  k.row('the title prompt still names the keyboard and the pad',
    g.hud.touchUi === false, 'touchUi false, so the string is ENTER OR A TO START',
    'ENTER OR A TO START');

  /* A tall desktop window is not a phone in portrait: a player who makes their
     browser narrow must get the narrow lens, not an interruption. */
  const wasW = innerWidth, wasH = innerHeight;
  k.row('a tall DESKTOP window does not raise the rotate gate',
    !t.rotate, `${wasW}x${wasH}, rotate ${t.rotate}`, 'false');

  /* Tilt must not be read at all. Even if the hardware had a gyroscope. */
  t.requestTilt();
  dispatchEvent(new DeviceOrientationEvent('deviceorientation',
    { alpha: 0, beta: 0, gamma: 30, absolute: true }));
  k.step(2);
  k.row('a 30 degree orientation event steers nothing on a machine with no touchscreen',
    g.input.steer === 0 && !t.tiltLive,
    `input.steer ${g.input.steer}, tiltLive ${t.tiltLive}`, '0, false');
  k.row('and no tap can be manufactured',
    g.input.tapPressed === false, g.input.tapPressed, false);
  return k.take();
};

/* ---- the driver ------------------------------------------------------- */

const SECTIONS = [
  ['device', 'the instrument itself', 'phone'],
  ['tilt', 'tilt steering', 'phone'],
  ['drag', 'the fallback when tilt is refused', 'phone'],
  ['pedals', 'the pedals, under real multi-touch', 'phone'],
  ['drive', 'driving the car with a thumb and a wrist', 'phone'],
  ['tap', 'reaching the game at all', 'phone'],
  ['insets', 'the safe area', 'phone'],
  ['landscape', 'landscape plays', 'phone'],
  ['portrait', 'portrait does not', 'portrait'],
  ['tier', 'the render tier', 'phone'],
  ['tierq', '?tier=high still overrides', 'tierq'],
  ['desktop', 'the desktop control — nothing may have changed', 'desktop'],
];

const results = new Map(SECTIONS.map(([id]) =>
  [id, { fail: 'section never reported a verdict', rows: [] }]));

const record = (id, got, err) => {
  const rec = results.get(id);
  if (err) {
    rec.fail = 'probe threw: ' + String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 160);
    return;
  }
  if (!got || !Array.isArray(got.rows)) { rec.fail = 'probe returned nothing'; return; }
  if (!got.rows.length) { rec.fail = 'probe returned no rows — nothing was measured'; return; }
  rec.rows = got.rows;
  const bad = got.rows.filter(r => !r.ok);
  rec.fail = bad.length ? `${bad.length} of ${got.rows.length} checks failed` : null;
};

const ev = async (id, page, fn, arg) => {
  try {
    record(id, arg === undefined ? await page.evaluate(fn) : await page.evaluate(fn, arg));
  } catch (e) { record(id, null, e); }
};

/* ---- CDP touch --------------------------------------------------------- */

/* Real touch points through the browser's own input pipeline, which is the only
 * way to get `touchstart`/`touchmove`/`touchend` with correct `identifier`s and
 * a correct `changedTouches`. Playwright's `page.touchscreen.tap` is one point
 * and cannot express two thumbs.
 *
 * `Input.dispatchTouchEvent` takes the FULL set of active points on every call
 * for move and start, and an empty set for the last end — that is the protocol,
 * and getting it wrong is how a probe ends up measuring one thumb while
 * believing it has two. */
class Thumbs {
  constructor(cdp) { this.cdp = cdp; this.pts = new Map(); }
  _list() {
    return [...this.pts.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id }));
  }
  async down(id, x, y) {
    this.pts.set(id, { x, y });
    await this.cdp.send('Input.dispatchTouchEvent',
      { type: 'touchStart', touchPoints: this._list() });
  }
  async move(id, x, y) {
    this.pts.set(id, { x, y });
    await this.cdp.send('Input.dispatchTouchEvent',
      { type: 'touchMove', touchPoints: this._list() });
  }
  /* MEASURED, not read off the protocol docs: `touchEnd` takes the points being
     RELEASED, not the ones that remain. The first draft of this class passed
     the remainder, which released the wrong thumb — the gate reported
     "throttle 0, brake 1" after lifting the brake, which is how the mistake was
     caught. Getting this backwards is exactly how a probe ends up measuring one
     thumb while believing it has two. */
  async up(id) {
    const p = this.pts.get(id);
    this.pts.delete(id);
    await this.cdp.send('Input.dispatchTouchEvent',
      { type: 'touchEnd', touchPoints: p ? [{ x: p.x, y: p.y, id }] : [] });
  }
  async cancel() {
    this.pts.clear();
    await this.cdp.send('Input.dispatchTouchEvent',
      { type: 'touchCancel', touchPoints: [] });
  }
}

/* ---- launch ----------------------------------------------------------- */

const argv = process.argv.slice(2);
const arg = n => {
  const hit = argv.find(a => a.startsWith('--' + n + '='));
  return hit ? hit.slice(n.length + 3) : null;
};
const BREAK = arg('break');
const ALL_BREAKS = argv.includes('--breaks');

async function gate(lesion) {
  for (const [id] of SECTIONS) {
    results.set(id, { fail: 'section never reported a verdict', rows: [] });
  }

  const bad = await checkAsync();
  if (bad.length) {
    console.error('✗ parse errors — not launching a browser:\n' + bad.join('\n'));
    process.exitCode = 1;
    return;
  }

  const srv = serve();
  await new Promise(r => srv.listen(0, r));
  const base = `http://localhost:${srv.address().port}/`;
  let browser = await chromium.launch({ headless: true, args: GPU_ARGS });
  guard(browser, srv);

  const errs = [];
  const watch = page => {
    page.on('pageerror', e => errs.push('[pageerror] ' + (e.stack || e.message || e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
    page.on('crash', () => errs.push('[crash] renderer process died'));
  };

  /* One context at a time, closed before the next opens: the standing rule in
     this suite is one browser and no orphans, and four live contexts on a
     software-pinned machine is four WebGL contexts. */
  const boot1 = async (opts, hash) => {
    const ctx = await browser.newContext({
      viewport: { width: opts.w, height: opts.h },
      deviceScaleFactor: 1,
      hasTouch: !!opts.touch,
    });
    try {
      const page = await ctx.newPage();
      watch(page);
      const url = base + '#' + hash;
      console.log(`→ ${url}  ${opts.w}x${opts.h}  hasTouch=${!!opts.touch}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.waitForFunction(() => !!window.__game, null, { timeout: 120_000 });
      await settleBoot(page);
      await page.evaluate(KIT);
      if (lesion) {
        const r = await page.evaluate(LESION, lesion);
        if (r !== true) throw new Error(String(r));
      }
      return { ctx, page };
    } catch (e) {
      await ctx.close().catch(() => {});
      throw e;
    }
  };

  /* One retry, because a fresh WebGL context is not free. Under --breaks this
     launches a browser per lesion and boots four contexts in each; on the
     software-pinned Windows box the 13th launch lost its renderer during
     settleBoot once. That is the harness running out of room, not the game
     failing, and a silent retry keeps a 16-lesion sweep from throwing away
     seven minutes of work. A second failure is real and propagates. */
  const boot = async (opts, hash) => {
    try {
      return await boot1(opts, hash);
    } catch (e) {
      console.log(`  (boot failed: ${String(e && e.message || e).split('\n')[0]} — one retry)`);
      await new Promise(r => setTimeout(r, 2000));
      if (!browser.isConnected()) {
        browser = await chromium.launch({ headless: true, args: GPU_ARGS });
        guard(browser);
      }
      return await boot1(opts, hash);
    }
  };

  /* ---- the phone ----------------------------------------------------- */
  {
    const { ctx, page } = await boot({ w: 844, h: 390, touch: true }, 'manual&touch=1&seed=22');
    const cdp = await ctx.newCDPSession(page);
    const thumbs = new Thumbs(cdp);

    await ev('device', page, S_DEVICE);
    await ev('tilt', page, S_TILT);
    await ev('drag', page, S_DRAG);

    /* ---- the pedals, driven from here so the touches are real -------- */
    try {
      await page.evaluate(() => { window.__tk.grid(); window.__tk.tiltOff(); });
      const P = await page.evaluate(() => window.__tk.pedals());
      const rows = [];
      const say = (name, ok, got, want) => rows.push({ name, ok: !!ok, got: String(got), want: String(want) });
      const read = () => page.evaluate(() => window.__tk.read());

      // Negative control: nothing touched.
      let r = await read();
      say('negative control — no thumb on the glass, no pedal commanded',
        r.tThrottle === 0 && r.tBrake === 0,
        `throttle ${r.tThrottle}, brake ${r.tBrake}`, '0, 0');

      await thumbs.down(1, P.throttle.x, P.throttle.y);
      r = await read();
      say('a thumb in the throttle detent commands full throttle',
        r.tThrottle === 1, r.tThrottle, 1);

      // The second thumb, on the other pedal, at the same time.
      await thumbs.down(2, P.brake.x, P.brake.y);
      r = await read();
      say('MULTI-TOUCH — the second thumb brakes without releasing the throttle',
        r.tThrottle === 1 && r.tBrake === 1,
        `throttle ${r.tThrottle}, brake ${r.tBrake}`, '1, 1');

      await thumbs.up(2);
      r = await read();
      say('lifting the brake leaves the throttle alone',
        r.tThrottle === 1 && r.tBrake === 0,
        `throttle ${r.tThrottle}, brake ${r.tBrake}`, '1, 0');

      /* THE LATCH. A thumb that slides off the pedal must command nothing while
         it is off — on a downhill stage a latched throttle is the difference
         between a corner and a cliff. */
      await thumbs.move(1, P.offThrottle.x, P.offThrottle.y);
      r = await read();
      say('a thumb that slides off the throttle does NOT latch it open',
        r.tThrottle === 0, r.tThrottle, 0);

      await thumbs.move(1, P.throttle.x, P.throttle.y);
      r = await read();
      say('and sliding back on picks the same pedal up again',
        r.tThrottle === 1, r.tThrottle, 1);

      /* The analogue channel: the top of the capsule feathers. */
      await thumbs.move(1, P.feather.x, P.feather.y);
      r = await read();
      say('sliding up the capsule feathers the throttle instead of cutting it',
        r.tThrottle > 0.2 && r.tThrottle < 0.45,
        r.tThrottle.toFixed(4), '0.20 .. 0.45 (the PED_FLOOR end of the ramp)');

      await thumbs.cancel();
      r = await read();
      say('touchcancel — the system taking the gesture away releases everything',
        r.tThrottle === 0 && r.tBrake === 0,
        `throttle ${r.tThrottle}, brake ${r.tBrake}`, '0, 0');

      /* A pedal held while the tab goes away. Both listeners exist because a
         backgrounded tab stops delivering touchend. */
      await thumbs.down(3, P.throttle.x, P.throttle.y);
      r = await read();
      const held = r.tThrottle;
      await page.evaluate(() => dispatchEvent(new Event('blur')));
      r = await read();
      say('losing window focus with a pedal held releases it',
        held === 1 && r.tThrottle === 0, `${held} -> ${r.tThrottle}`, '1 -> 0');
      await thumbs.cancel();

      /* The drag fallback, with tilt off: a touch that is not on a pedal steers
         by its offset from where it went down. */
      await thumbs.down(4, P.empty.x, P.empty.y);
      r = await read();
      const anchored = r.tSteer;
      await thumbs.move(4, P.empty.x + 200, P.empty.y);
      r = await read();
      const dragged = r.tSteer;
      await thumbs.move(4, P.empty.x - 200, P.empty.y);
      r = await read();
      const back = r.tSteer;
      say('DRAG FALLBACK — the touch-down point is zero and the offset steers both ways',
        anchored === 0 && dragged === 1 && back === -1,
        `anchor ${anchored}, +200 px ${dragged}, -200 px ${back}`, '0, +1, -1');
      await thumbs.up(4);
      r = await read();
      say('and letting go of a drag returns the wheel to centre rather than holding it',
        r.tSteer === 0, r.tSteer, 0);

      record('pedals', { rows });
    } catch (e) { record('pedals', null, e); }

    /* ---- does any of it drive the car? ------------------------------- */
    try {
      const rows = [];
      const say = (name, ok, got, want) => rows.push({ name, ok: !!ok, got: String(got), want: String(want) });
      const P = await page.evaluate(() => window.__tk.pedals());

      /* Throttle. Same start, same road, the only difference being the thumb. */
      const runPedal = async (touch) => {
        await page.evaluate(() => {
          const k = window.__tk, g = window.__game;
          k.grid(); k.tiltOff();
          g.player.placeAt(40, 0); g.player.vx = 0; g.player.vy = 0; g.player.r = 0;
        });
        if (touch) await thumbs.down(9, P[touch].x, P[touch].y);
        /* Three seconds, not one and a half. From a standing start the car
           covers 7 m in the first 1.5 s, which is unambiguously more than the
           0.1 m it rolls with no thumb but is a thin margin to gate on. */
        const out = await page.evaluate(() => {
          const g = window.__game, s0 = g.player.s;
          window.__tk.step(180);
          return { ds: g.player.s - s0, kmh: g.player.kmh };
        });
        if (touch) await thumbs.cancel();
        return out;
      };
      const idle = await runPedal(null);
      const gas = await runPedal('throttle');
      say('the throttle pedal drives the car down the road',
        gas.ds > 20 && gas.ds > idle.ds + 10,
        `${gas.ds.toFixed(1)} m in 3 s at ${gas.kmh.toFixed(0)} km/h, against ${idle.ds.toFixed(1)} m with no thumb`,
        '> 20 m and clear of the no-thumb run');

      /* Brake, from speed. */
      const brakeRun = async (touch) => {
        await page.evaluate(() => {
          const k = window.__tk, g = window.__game;
          k.grid(); k.tiltOff();
          g.player.placeAt(40, 0); g.player.vx = 30; g.player.vy = 0; g.player.r = 0;
        });
        if (touch) await thumbs.down(9, P.brake.x, P.brake.y);
        const out = await page.evaluate(() => { window.__tk.step(60); return { kmh: window.__game.player.kmh }; });
        if (touch) await thumbs.cancel();
        return out;
      };
      const coast = await brakeRun(false);
      const braked = await brakeRun(true);
      say('the brake pedal slows it, and by much more than coasting does',
        braked.kmh < coast.kmh - 20,
        `${braked.kmh.toFixed(0)} km/h after 1 s on the brake, against ${coast.kmh.toFixed(0)} coasting`,
        '> 20 km/h slower than coasting');

      /* TILT STEERING, THROUGH THE CAR. Three runs from an identical state with
         the throttle held, the only difference being the wrist, so the track's
         own curvature cancels. This is the row that would catch a sign error
         that every unit-level check above somehow agreed on. */
      const steerRun = async (gamma) => {
        await page.evaluate(() => {
          const k = window.__tk, g = window.__game;
          k.grid();
          k.tiltOn(); k.hold(0, 0); g.touch.calibrate();
          g.player.placeAt(40, 0); g.player.vx = 22; g.player.vy = 0; g.player.r = 0;
        });
        await thumbs.down(9, P.throttle.x, P.throttle.y);
        const out = await page.evaluate((deg) => {
          const k = window.__tk, g = window.__game;
          for (let i = 0; i < 90; i++) { k.orient(0, deg); k.step(1); }
          return { lat: g.player.lat, steer: g.input.steer, kmh: g.player.kmh };
        }, gamma);
        await thumbs.cancel();
        return out;
      };
      const straight = await steerRun(0);
      const right = await steerRun(30);
      const left = await steerRun(-30);
      say('tilting right takes the car right of the straight-ahead run',
        right.lat - straight.lat > 1,
        `lat ${right.lat.toFixed(2)} m vs ${straight.lat.toFixed(2)} m straight (steer ${right.steer.toFixed(2)})`,
        '> 1 m to the right');
      say('and tilting left takes it left of the same run',
        straight.lat - left.lat > 1,
        `lat ${left.lat.toFixed(2)} m vs ${straight.lat.toFixed(2)} m straight (steer ${left.steer.toFixed(2)})`,
        '> 1 m to the left');
      say('the straight-ahead run really is straight — the calibration held',
        Math.abs(straight.steer) < 0.01,
        `steer ${straight.steer.toFixed(6)} after 1.5 s at the calibrated attitude`, 'about 0');

      /* NO SMOOTHING. The input layer must report the position it was handed,
         not a value ramping toward it: a rate limit here hands the 120 Hz car a
         60 Hz staircase, which is a measured bug this project has already
         fixed once (see src/core/input.js's header). */
      const jump = await page.evaluate(() => {
        const k = window.__tk, g = window.__game;
        k.grid(); k.tiltOn(); k.hold(0, 0); g.touch.calibrate();
        k.step(1);
        const at0 = g.input.steer;
        k.orient(0, 40);                        // straight to past full lock
        k.step(1);
        const at1 = g.input.steer;
        return { at0, at1 };
      });
      say('a wrist that snaps to full lock is reported at full lock on the NEXT frame',
        jump.at0 === 0 && jump.at1 === 1,
        `steer ${jump.at0} -> ${jump.at1} in one frame`, '0 -> 1');
      record('drive', { rows });
    } catch (e) { record('drive', null, e); }

    /* ---- the two screens a phone player would be stranded on --------- */
    try {
      const rows = [];
      const say = (name, ok, got, want) => rows.push({ name, ok: !!ok, got: String(got), want: String(want) });
      const P = await page.evaluate(() => window.__tk.pedals());

      // The title screen.
      await page.evaluate(() => {
        const g = window.__game;
        window.__tk.grid();
        g.title.arm();
        window.__tk.step(2);
      });
      let st = await page.evaluate(() => ({
        active: window.__game.title.active, touchUi: window.__game.hud.touchUi,
      }));
      say('the title screen is up and the HUD knows it is a touch build',
        st.active && st.touchUi === true,
        `title active ${st.active}, touchUi ${st.touchUi} (so the prompt reads TAP TO START)`,
        'active, touchUi true');

      // A short, still touch anywhere that is not a control.
      await thumbs.down(20, P.empty.x, P.empty.y);
      await thumbs.up(20);
      st = await page.evaluate(() => {
        const g = window.__game;
        const tap = g.touch._tap;
        window.__tk.step(1);
        return { tap, active: g.title.active, s: g.player.s };
      });
      say('a tap starts the race',
        st.tap === true && !st.active,
        `tap edge ${st.tap}, title active -> ${st.active}, car at ${st.s.toFixed(1)} m`,
        'tap true, title gone');

      /* A LONG press is not a tap, and neither is a drag. Both are steering
         gestures during a race and must not be confused with a menu press. */
      await page.evaluate(() => { window.__tk.grid(); window.__game.title.arm(); window.__tk.step(2); });
      await thumbs.down(21, P.empty.x, P.empty.y);
      await page.waitForTimeout(600);
      await thumbs.up(21);
      st = await page.evaluate(() => {
        const g = window.__game;
        window.__tk.step(1);
        return { active: g.title.active };
      });
      say('a 600 ms press is NOT a tap — it is a steering gesture',
        st.active === true, `title active ${st.active}`, 'still active');

      await page.evaluate(() => { window.__tk.grid(); window.__game.title.arm(); window.__tk.step(2); });
      await thumbs.down(22, P.empty.x, P.empty.y);
      await thumbs.move(22, P.empty.x + 90, P.empty.y);
      await thumbs.up(22);
      st = await page.evaluate(() => {
        window.__tk.step(1);
        return { active: window.__game.title.active };
      });
      say('and neither is a 90 px drag',
        st.active === true, `title active ${st.active}`, 'still active');

      /* Mid-race a tap must do NOTHING: `reset` respawns twelve metres back up
         the road and a thumb is on the glass for four minutes. */
      await page.evaluate(() => {
        const g = window.__game;
        window.__tk.grid();
        g.player.placeAt(200, 0); g.player.vx = 20;
        window.__tk.step(30);
      });
      const sBefore = await page.evaluate(() => window.__game.player.s);
      await thumbs.down(23, P.empty.x, P.empty.y);
      await thumbs.up(23);
      const sAfter = await page.evaluate(() => { window.__tk.step(1); return window.__game.player.s; });
      say('a tap MID-RACE does not respawn the car',
        sAfter > sBefore,
        `car at ${sBefore.toFixed(1)} m -> ${sAfter.toFixed(1)} m (a respawn would go backwards)`,
        'still going forwards');

      /* And the results card, which is where a phone run ended permanently
         before this landed. Driven all the way to the flag, because
         `canRestart` is a property of a running ending 1.45 s past the crossing
         and there is no honest way to fake it. */
      const reached = await page.evaluate(() => {
        const k = window.__tk, g = window.__game;
        k.grid();
        g.goTo(0.97);
        g.autopilot(true, 0.85);
        g.ending.enabled = true;
        g.ending.arm();
        for (let i = 0; i < 60 * 60 && !g.ending.canRestart; i++) k.step(1);
        return { canRestart: g.ending.canRestart, finished: g.player.finished, s: g.player.s };
      });
      say('the car reached the flag and the results card is up',
        reached.canRestart && reached.finished,
        `finished ${reached.finished}, canRestart ${reached.canRestart}`, 'both true');
      await thumbs.down(24, P.empty.x, P.empty.y);
      await thumbs.up(24);
      const after = await page.evaluate(() => {
        const g = window.__game;
        window.__tk.step(1);
        g.autopilot(false);
        return { s: g.player.s, t: g.player.raceTime, running: g.ending.running };
      });
      say('a tap on the results card starts the next race',
        Math.abs(after.s - 34) < 1 && after.t < 0.1 && !after.running,
        `car at ${after.s.toFixed(1)} m, raceTime ${after.t.toFixed(2)} s, ending ${after.running ? 'still running' : 'reset'}`,
        's 34, raceTime 0, ending reset');
      record('tap', { rows });
    } catch (e) { record('tap', null, e); }

    await ev('insets', page, S_INSETS, [NOTCH]);
    await ev('landscape', page, S_LANDSCAPE);
    await ev('tier', page, S_TIER, ['low']);
    await ctx.close();
  }

  /* ---- portrait ------------------------------------------------------ */
  {
    const { ctx, page } = await boot({ w: 390, h: 844, touch: true }, 'manual&touch=1&seed=22');
    await ev('portrait', page, S_PORTRAIT);
    await ctx.close();
  }

  /* ---- the explicit override ----------------------------------------- */
  {
    const { ctx, page } = await boot({ w: 844, h: 390, touch: true }, 'manual&touch=1&tier=high&seed=22');
    await ev('tierq', page, S_TIER, ['high']);
    await ctx.close();
  }

  /* ---- the desktop control ------------------------------------------- */
  {
    const { ctx, page } = await boot({ w: 1600, h: 900, touch: false }, 'manual&touch=1&seed=22');
    await ev('desktop', page, S_DESKTOP);
    await ctx.close();
  }

  await browser.close().catch(() => {});
  srv.close();

  if (errs.length) {
    console.log('\n─── page errors ───');
    [...new Set(errs)].slice(0, 15).forEach(e => console.log(' ', e));
  }
  return errs;
}

/* ---- report ----------------------------------------------------------- */

function report(quiet) {
  let total = 0, failed = 0;
  for (const [id, title] of SECTIONS) {
    const rec = results.get(id);
    if (!quiet) console.log(`\n  ${title}`);
    if (!rec.rows.length && !quiet) console.log(`    ✗ ${rec.fail}`);
    for (const r of rec.rows) {
      total++;
      if (!r.ok) failed++;
      if (quiet) continue;
      console.log(`    ${r.ok ? '✓' : '✗'} ${r.name}`);
      console.log(`        got ${r.got}${r.ok ? '' : `   want ${r.want}`}`);
    }
  }
  const dead = SECTIONS.filter(([id]) => results.get(id).fail);
  return { total, failed, dead };
}

if (ALL_BREAKS) {
  /* Every lesion in turn, and each must turn its own section red. A break that
     leaves the gate green means the check was measuring nothing, which is the
     failure this mode exists to find. */
  console.log('\n  PROVING THE GATE CAN FAIL — one deliberate lesion at a time\n');
  const table = [];
  for (const [name, mustKill] of BREAKS) {
    /* A lesion that crashes the harness must not take the sweep with it. Left
       uncaught it reaches tame.mjs's unhandledRejection hook, which calls
       process.exit and throws away every lesion still queued. */
    let crash = null;
    try { await gate(name); } catch (e) { crash = String((e && e.message) || e).split('\n')[0]; }
    const { total, failed } = report(true);
    if (crash) {
      console.log(`  ! --break=${name.padEnd(12)} harness error, verdict not trustworthy: ${crash}`);
      table.push({ name, mustKill, alive: mustKill, failed, total });
      process.exitCode = 1;
      continue;
    }
    const alive = mustKill.filter(id => {
      const rec = results.get(id);
      return !(rec && rec.fail);
    });
    table.push({ name, mustKill, alive, failed, total });
    console.log(`  ${alive.length ? '✗' : '✓'} --break=${name.padEnd(12)} ${mustKill.join('+').padEnd(14)}`
      + ` ${alive.length ? 'STAYED GREEN' : 'went red'}  (${failed}/${total} checks failed overall)`);
    for (const id of alive) console.log(`      ${id} did not fail`);
  }
  const survived = table.filter(t => t.alive.length);
  const covered = new Set(BREAKS.flatMap(b => b[1]));
  const uncovered = SECTIONS.filter(([id]) => !covered.has(id)).map(([id]) => id);
  console.log('');
  if (uncovered.length) {
    console.log(`  ✗ ${uncovered.length} section(s) have no lesion aimed at them: ${uncovered.join(' ')}`);
    process.exitCode = 1;
  }
  if (survived.length) {
    console.log(`  ✗ ${survived.length} of ${BREAKS.length} lesion(s) did NOT turn their section red:`);
    for (const s of survived) console.log(`      ${s.name} -> ${s.alive.join(' ')}`);
    process.exitCode = 1;
  } else if (!uncovered.length) {
    console.log(`  ✓ all ${BREAKS.length} lesions turned their own section red, and every one of`
      + ` the ${SECTIONS.length} sections has one aimed at it`);
  }
  finish(process.exitCode || 0);
}

const errs = await gate(BREAK);
const { total, failed, dead } = report(false);

console.log('');
if (BREAK) console.log(`  (running with --break=${BREAK}: red below is the expected result)`);
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
if (errs && errs.some(e => e.startsWith('[pageerror]') || e.startsWith('[crash]'))) process.exitCode = 1;
finish(process.exitCode || 0);
