/* The title screen: the game's own coast, held, with the name on it.
 *
 * One state machine and nothing else, on the terms race/countdown.js and
 * race/ending.js already set. It owns no meshes, no audio nodes and no canvas.
 * It counts, and it reports three things to whoever is driving it:
 *
 *   active     the game is on the title and nothing may be stepped
 *   station()  where the lens should stand, as offsets on the ROAD FRAME
 *   display()  what the HUD should draw, or null
 *
 * EVERY TIME IN THIS FILE IS WALL-CLOCK SECONDS, and the suffix says so, for
 * the reason countdown.js documents at length: `Game.step(dt)` is handed wall
 * time and multiplies by `timeScale()` to get simulation time, and a sequence
 * authored in one unit and consumed in the other is how a 0.72 s window became
 * 1.37 s of somebody's life. Nothing on a title screen is in simulation
 * seconds even in principle — the simulation is not running.
 *
 * Nothing here reads `performance.now()`. The clock is advanced by the caller,
 * so a paused frame is genuinely still and two renders of it are the same
 * image — the same rule the countdown, the ending and the crowd already keep.
 *
 * WHY THERE IS A CAMERA MOVE AT ALL, and why it is this one.
 *
 * The best asset this game has is the road it generates, and a title over
 * black would be a menu for some other game. But a fixed camera on a stopped
 * car is a screenshot, and a screenshot with a button on it is the thing this
 * screen exists to stop the build looking like. So the lens moves, and it
 * moves as little as it can get away with: a 26-second sinusoid, seamless
 * because a sinusoid has no seam, worth 6.4 m of lateral travel and 1.8 m of
 * height over the whole cycle. At 58 degrees and 900 px that is under a pixel
 * a frame — invisible as a move, and the difference between a held shot and a
 * screenshot, which is the same argument race/ending.js makes for its lens
 * push and the same size of move.
 *
 * WHY EVERY STATION IS AN OFFSET ON THE ROAD FRAME. Copied from main.js's
 * held finish shot, which owns the long version: the ground either side of the
 * road is wildly different from one seed to the next — on seed 1 it falls
 * fourteen metres away ten metres to the left, on seed 7 it does the same on
 * the right — so a lens at a fixed world offset stands in mid-air on one stage
 * and inside a hillside on the next. A station on the road frame is above
 * tarmac on every stage this game can generate, and the lateral swing below is
 * inside the road's own width, so it needs no occlusion test to prove it.
 */
import { smoothstep } from '../core/util.js';

/* How far behind the car the lens stands.
 *
 * Not the chase camera's ten. The chase is a driving camera and frames the
 * road; this has to frame the CAR and the road, which are different shots.
 * At fifteen metres on a 58-degree lens the car is 17% of the frame width —
 * large enough to be the subject, small enough that the descent behind it is
 * the reason the shot exists. */
const CAM_BACK = 15;
/* And how high. Above the ending's 5.5 and well above the chase's 2.5,
   because the whole point of this composition is to see the road run away
   downhill past the car, and from a driving height it runs away behind it. */
const CAM_HIGH = 6.2;

/* The move. Lateral first, because a sideways drift is the one camera move
   that reveals depth — the near road slides against the far headland — and it
   is also the one that cannot put the lens anywhere new vertically.
   ±3.2 m is inside the road's own half-width on every seed (the narrowest
   stage this game builds is 8.4 m across), so the lens stays over tarmac and
   inherits the road frame's guarantee rather than needing one of its own. */
const CAM_SWING = 3.2;
/* A little height with it, a quarter-cycle out of phase, so the move is an
   arc rather than a slide. Small: 0.9 m against a 6.2 m stand is a 15%
   change in the angle onto the car's roof, which reads as the shot breathing
   and not as a crane. */
const CAM_RISE = 0.9;
/* One cycle. Long enough that no single frame of a recording contains a
   visible move, short enough that a player who sits on the title for a minute
   sees it as alive rather than as broken. */
const CAM_PERIOD_WALL = 26;

/* What the lens looks at: a point down the road, not the car.
 *
 * Aiming at the car puts the car in the middle of the frame and the descent
 * off the top of it. Aiming thirty metres down the road tips the horizon up,
 * drops the car into the lower third where a subject belongs, and gives the
 * road, the coast and the sky the two thirds above it.
 *
 * Measured at 1600x900, the car's projected top lands at 0.579–0.666 of the
 * height over seeds 22/1/40 and the whole 26-second lens cycle — NOT the 0.72
 * this comment claimed for its first eight hours, which was one seed at one
 * phase read off the wrong thing. The spread is mostly CAM_RISE below: at
 * phase π the lens stands at 5.30 m rather than 6.2, and every metre it drops
 * lifts the car 3.1% of the frame height. The poster is placed against the
 * top of that range and not against a single sample, in ui/hud.js's
 * `_drawTitle`, and tools/shell.mjs checks the gap per seed. */
const AIM_AHEAD = 30;
const AIM_HIGH = 2.4;

/* Tighter than the base lens and much tighter than the chase's 79 at speed,
   for the reason the ending closes to 62: this is a composed frame and not a
   racing one, and the wide angle that makes a corner readable at 170 km/h
   makes a parked car small. */
const CAM_FOV = 58;

/* The card arriving. One beat, and it is the only animation on the screen
   apart from the lens — long enough not to be a cut, short enough that a
   player who has seen it before is not waiting for it. */
const IN_WALL = 0.55;
/* The pop, on the countdown's argument: a plate that appears is a slide, one
   that lands is an event. Smaller than the countdown's 1.20 and matched to the
   results card's 1.09, because this plate is the same order of area as the
   card and the same proportional overshoot on it sweeps across the frame. */
const POP = 1.07;

export class Title {
  /**
   * @param {{seed?:number}} opts `seed` is passed straight back out through
   *   display() — see there for why the HUD cannot ask for it itself.
   */
  constructor(opts = {}) {
    /* Off unless the owner says otherwise — see main.js, where the flag is the
       same `manual` story the countdown and the ending already have. */
    this.armed = false;
    this.t = 0;                  // WALL seconds since arm
    this.seed = opts.seed ?? 0;
  }

  /**
   * Put the title up, from the top, whatever state this was in.
   *
   * Unconditional for the reason Countdown.arm() and Ending.arm() are: a
   * caller that asks for a title screen has asked for a title screen, and
   * silently declining because one is already up hands back an object in a
   * state the caller did not choose.
   */
  arm() {
    this.armed = true;
    this.t = 0;
  }

  /**
   * Never show it, and stop showing it.
   *
   * STICKY, like Ending.skip() and unlike Countdown.skip(), and the difference
   * matters more here than in either of them. A countdown is over three
   * seconds after a tool starts; an ending waits at the far end of the stage.
   * A title screen sits in front of the grid, which is where EVERY tool in
   * tools/ begins, so a tool that saw one would not be photographing a
   * mid-animation frame — it would be photographing a car that never moved.
   *
   * That is why the primary guard is not this method but the `manual` gate in
   * main.js: every harness run passes `manual` (tools/harness.mjs defaults
   * `hash` to exactly 'manual'), so the title is never armed in the first
   * place. This is the belt and braces underneath it, called by goTo, driveTo,
   * warp, autopilot, restart and a bot input — so a tool that somehow entered
   * without `manual` is released on the frame it first asks the world for
   * anything.
   */
  skip() {
    this.armed = false;
    this.t = 0;
  }

  /** The one question the game loop asks. Nothing may be stepped. */
  get active() { return this.armed; }

  /**
   * Advance. `dt` is WALL seconds — the frame's own dt, never `ran`.
   * @param {number} dt
   */
  update(dt) {
    if (!this.armed) return;
    this.t += dt;
  }

  /**
   * Where the lens should stand, as offsets on the road frame, and what focal
   * length to use. A pure function of this object's own clock: no memory, no
   * smoothing to tune, and two calls at the same `t` give the same answer.
   *
   * Returned as plain numbers rather than a Vector3 because this file owns no
   * THREE objects and does not import three — the caller has the track and the
   * frames and is the only thing that can turn an offset into a position.
   */
  station() {
    const phase = (this.t / CAM_PERIOD_WALL) * Math.PI * 2;
    return {
      back: CAM_BACK,
      lat: CAM_SWING * Math.sin(phase),
      high: CAM_HIGH + CAM_RISE * Math.sin(phase + Math.PI / 2),
      ahead: AIM_AHEAD,
      aimHigh: AIM_HIGH,
      fov: CAM_FOV,
    };
  }

  /**
   * What the HUD should draw, or null.
   *
   * Null is load-bearing, exactly as it is for the countdown and the ending:
   * the HUD's draw path for "no title" has to be the one it had before this
   * landed, pixel for pixel (tools/hudparity.mjs).
   *
   * `seed` rides on the payload because the HUD has no way to ask for it —
   * setCourse gives it the profile and nothing else — and because a stage
   * number is the one fact that makes "this course was generated" legible on
   * a screen whose whole job is to say what the game is.
   */
  display() {
    if (!this.armed) return null;
    const k = smoothstep(0, IN_WALL, this.t);
    return {
      alpha: k,
      scale: 1 + (POP - 1) * (1 - k),
      seed: this.seed,
    };
  }
}

export const TITLE_FOV = CAM_FOV;
