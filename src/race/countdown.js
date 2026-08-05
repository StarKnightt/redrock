/* The start line: three, two, one, GO.
 *
 * One state machine and nothing else. It owns no meshes, no audio nodes and
 * no canvas — it counts, and it reports four things to whoever is driving it:
 *
 *   holding   the field is on the line and nothing may be stepped
 *   display   what the HUD should draw, or null
 *   hype      0..1 for the crowd's excitement uniform
 *   takeTone()  a one-shot audio event, consumed once
 *
 * EVERY TIME IN THIS FILE IS WALL-CLOCK SECONDS, and the suffix says so.
 * `Game.step(dt)` is handed wall time and multiplies by `timeScale()` to get
 * simulation time; the slow-motion envelope was authored in one unit and
 * consumed in the other and a 0.72 s window became 1.37 s of it. A countdown
 * cannot be in simulation seconds even in principle — the only time dilation
 * on this stage is the ramp launch, which cannot happen from a standstill, but
 * "three seconds" means three seconds of the player's life whatever the
 * simulation is doing, so `update` is fed the raw frame dt and never `ran`.
 *
 * Nothing here reads `performance.now()`. The clock is advanced by the caller,
 * so a paused frame is genuinely still and two renders of it are the same
 * image — the rule the crowd already follows and the grass famously does not.
 */
import { clamp, smoothstep } from '../core/util.js';

/* One second a count. Measured against the alternatives rather than assumed:
   at 0.8 s the three digits read as a stutter and the engine has no time to
   come up on the limiter between them; at 1.2 s the third one is dead air.
   Three counts of one second is also the only spacing a player can predict
   accurately enough to time a launch against, which is the entire point of
   holding them here. */
const COUNT_WALL = 1.0;
const COUNTS = 3;
/* When the field is released. Three counts exactly — the GO frame is the
   release frame, not a fourth beat after it. */
const LIGHTS_WALL = COUNTS * COUNT_WALL;
/* How long GO stays up after the release. Long enough to be seen in
   peripheral vision while the driver is looking at the road, short enough
   that it is gone before the first corner. */
const GO_WALL = 0.85;
/* And how long the crowd keeps going afterwards. They do not stop dead on the
   frame the numerals leave the screen. */
const TAIL_WALL = 2.6;

/* The pop. A numeral that simply appears is a slide; one that lands is an
   event. Scale runs from POP_SCALE to 1 over this, on a smoothstep. */
const POP_WALL = 0.24;
/* Measured, not chosen. GO is the widest and tallest thing the HUD ever
   draws, and at 1600x900 its plate is 582 x 335 device pixels centred at 0.35
   of the height — so anything above about 1.22 puts the top edge of the pop
   through the timer plate, which is at y = 103 and is not this task's to
   move. 1.20 puts the top of the worst frame at y = 120, which is seventeen
   pixels clear of it (tools/hudparity.mjs). */
const POP_SCALE = 1.20;
/* And the fade, at the tail of each numeral's own second. */
const FADE_WALL = 0.22;

/* Engine revs on the line, as a fraction of the limiter.
 *
 * The car's own rpm is derived from road speed — see car/physics.js — so a
 * stationary car idles however hard the throttle is held, and the physics is
 * not ours to change. This is the rev counter the *audio and the HUD* are
 * shown while the field is held, and it is a display quantity only: nothing
 * here reaches the car, and the moment the countdown releases, both go back
 * to reading the car directly.
 *
 * The flutter is what makes it a limiter rather than a held note. Driven from
 * this object's own clock, in wall seconds, like everything else here. */
const REV_IDLE = 0.14;
const REV_LIMIT = 0.985;
const REV_RATE = 6.5;            // per second, toward the target
const REV_FLUTTER = 0.022;
const REV_FLUTTER_HZ = 18;

export class Countdown {
  constructor() {
    this.armed = false;
    this.t = 0;                  // wall seconds since arm
    this.rev = REV_IDLE;
    this.throttle = 0;
    this._count = -1;            // which count has been announced
    this._tone = null;
    this._done = false;
  }

  /**
   * Put the field on the line, from the top, whatever state this was in.
   *
   * Unconditional on purpose. The obvious guard — return early if one is
   * already running — reads as harmless and is not: a caller that asks for a
   * start line has asked for a start line, and "already armed but two
   * seconds in" is precisely the state in which silently doing nothing hands
   * back an object that reports `holding === false`. That cost a capture
   * round: every frame of it was taken after a countdown that had never
   * restarted.
   */
  arm() {
    this.armed = true;
    this.t = 0;
    this.rev = REV_IDLE;
    this.throttle = 0;
    this._count = -1;
    this._tone = null;
    this._done = false;
  }

  /** Alive at all: holding, or showing GO, or the crowd is still going. */
  get alive() { return this.armed && !this._done; }

  /** Nothing may be stepped. The one question the game loop asks. */
  get holding() { return this.armed && !this._done && this.t < LIGHTS_WALL; }

  /**
   * Over, whatever state it was in: the release happens on this frame, the
   * numerals go, and the crowd is left where it is. Everything that enters
   * the world programmatically — goTo, driveTo, autopilot, warp — calls this,
   * and so does the skip key.
   */
  skip() {
    if (!this.armed || this._done) return;
    this.armed = false;
    this._done = true;
    this._tone = null;
    this.rev = REV_IDLE;
  }

  /**
   * Advance. `dt` is WALL seconds — the frame's own dt, never `ran`.
   * @param {number} dt
   * @param {number} throttle what the driver is asking for, 0..1
   */
  update(dt, throttle = 0) {
    if (!this.alive) return;
    this.t += dt;
    this.throttle = clamp(throttle, 0, 1);

    const held = this.t < LIGHTS_WALL;
    /* Held against the limiter, and only while held: past the lights the car
       owns its own rev counter again on the very next frame. */
    const target = held ? REV_IDLE + (REV_LIMIT - REV_IDLE) * this.throttle : REV_IDLE;
    const k = 1 - Math.exp(-REV_RATE * dt);
    this.rev = this.rev + (target - this.rev) * k;

    /* One tone per count, and a different one on the release. Fired on the
       transition rather than tested per frame, so a long frame cannot drop a
       beat or double one. */
    const step = Math.min(COUNTS, Math.floor(this.t / COUNT_WALL));
    if (step > this._count) {
      this._count = step;
      this._tone = step >= COUNTS ? 'go' : 'count';
    }
    if (this.t >= LIGHTS_WALL + TAIL_WALL) this._done = true;
  }

  /**
   * The engine note to show, as a fraction of the limiter, or null once this
   * has nothing to say.
   *
   * It keeps talking past the release, and that is the point. Cut dead on the
   * GO frame, a driver holding the throttle sees the rev counter fall from
   * the limiter to idle in one frame and hears the same — the HUD arc goes
   * from a full red ring to a stub between two images. Left to decay, the
   * revs drop as the clutch takes up and are then overtaken by the car's own,
   * which is what launching a car sounds like; the caller takes the greater
   * of the two, so the handover happens wherever the curves cross rather than
   * at a time somebody had to pick.
   */
  get displayRev() {
    if (!this.armed || this._done) return null;
    const flutter = this.holding && this.rev > REV_LIMIT - 0.06
      ? REV_FLUTTER * Math.sin(this.t * REV_FLUTTER_HZ * Math.PI * 2)
      : 0;
    return clamp(this.rev + flutter, 0, 1);
  }

  /** The one-shot audio event, consumed. 'count' | 'go' | null. */
  takeTone() {
    const t = this._tone;
    this._tone = null;
    return t;
  }

  /**
   * How worked up the trackside crowd is, 0..1, for the crowd's own uniform.
   *
   * A step per count so the squad builds visibly through the sequence rather
   * than sliding up a ramp nobody can read, with a decaying kick on each beat
   * so the step lands on the tone; then everything at once on GO, decaying
   * over the tail.
   */
  get hype() {
    if (!this.armed || this._done) return 0;
    if (this.t < LIGHTS_WALL) {
      const step = Math.floor(this.t / COUNT_WALL);
      const into = this.t - step * COUNT_WALL;
      return clamp(0.16 + 0.16 * step + 0.24 * Math.exp(-into / 0.22), 0, 1);
    }
    return clamp(Math.exp(-(this.t - LIGHTS_WALL) / 0.95), 0, 1);
  }

  /**
   * What the HUD should draw, or null.
   *
   * Null is load-bearing: the HUD's draw path for "no countdown" has to be
   * the one it had before this landed, pixel for pixel.
   */
  display() {
    if (!this.armed || this._done) return null;
    const go = this.t >= LIGHTS_WALL;
    if (go && this.t >= LIGHTS_WALL + GO_WALL) return null;
    const step = Math.min(COUNTS, Math.floor(this.t / COUNT_WALL));
    const into = this.t - step * COUNT_WALL;
    const life = go ? GO_WALL : COUNT_WALL;
    return {
      text: go ? 'GO' : String(COUNTS - step),
      go,
      scale: 1 + (POP_SCALE - 1) * (1 - smoothstep(0, POP_WALL, into)),
      alpha: 1 - smoothstep(life - FADE_WALL, life, into),
    };
  }
}

export const COUNTDOWN_SECONDS_WALL = LIGHTS_WALL;
