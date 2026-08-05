/* The pause menu: stop, choose, carry on.
 *
 * One state machine and nothing else, on the terms race/countdown.js and
 * race/ending.js set. It owns no meshes, no audio nodes and no canvas. It
 * holds a cursor and a clock, and it reports what the caller needs:
 *
 *   active     the game is paused and nothing may be stepped
 *   move(d)    cursor up or down
 *   take()     the chosen action, consumed once
 *   display()  what the HUD should draw, or null
 *
 * EVERY TIME IN THIS FILE IS WALL-CLOCK SECONDS. There is no other clock
 * available while this is up — that is the whole point of it — and the plate's
 * arrival is in the player's seconds by definition. See countdown.js for the
 * long version of why the unit is written down.
 *
 * Nothing here reads `performance.now()`, so a paused frame is genuinely still
 * and two renders of it are the same image.
 *
 * WHY THIS IS NOT A DANGER TO THE CAPTURE SUITE, which is the question the
 * countdown and the ending both had to answer and which this one answers more
 * cheaply than either.
 *
 * A countdown fires on its own three seconds after a page loads, and an ending
 * fires on its own when a car crosses a line — so both of them had to be gated
 * on `manual` and given a sticky `skip()`, because a tool can arrive at the
 * trigger without meaning to. This cannot fire on its own at all. The only
 * thing that opens it is a rising edge on a key or a gamepad button, and no
 * tool in tools/ presses one: the harness drives the game through
 * `window.__game`, and the two tools that synthesise input at all
 * (tools/reelshoot.mjs, and any bot on the wheel) write the four analogue axes
 * after Input.update has run and clear the one-shot edge flags as they go.
 * `enabled` is still gated on `manual` on top of that, so a tool would have to
 * both clear the gate and forge a key event to see this object do anything.
 *
 * WHAT ACTUALLY FREEZES is not in this file and is worth naming here anyway,
 * because a menu that says PAUSED over a world that is still moving is worse
 * than no menu. See Game.step, which returns before the substep loop — so no
 * substep integrates, no race clock advances, no effect is stepped and no
 * accumulator fills — and Game.frame, which stops rendering the world
 * entirely while this is active. That last one is not an optimisation: three
 * of the environment's vertex animations are driven from `performance.now()`
 * inside their own onBeforeRender, so the only way to stop the ocean is to
 * stop asking it to draw.
 */
import { clamp, smoothstep } from '../core/util.js';

/* The three ways out, in the order a paused player wants them.
 *
 * RESUME first because it is what nine presses in ten are for and because the
 * cursor starts on it, so Esc-then-Enter is the whole interaction. TO TITLE
 * last because it is the one that throws a run away.
 *
 * Every letter here is in the HUD's own glyph table — see GLYPHS in
 * ui/hud.js, which has no J, Q, X or Z, and which renders a missing glyph as
 * an advance with nothing in it. That is why this says TO TITLE rather than
 * QUIT and RESTART rather than EXIT: a silent hole in a menu item is exactly
 * the kind of defect that survives to a recording. */
const ITEMS = ['RESUME', 'RESTART', 'TO TITLE'];

/* The plate arriving. Shorter than the title's 0.55 and shorter than the
   results card's 0.42, and deliberately: a results card is the end of
   something and can afford to land, but a pause menu is a response to a
   button and anything slower than about a tenth of a second reads as the game
   not having noticed. Long enough not to be a cut, and that is all. */
const IN_WALL = 0.12;
/* The pop, matched to the results card's 1.09 rather than the countdown's
   1.20, for the reason ending.js gives: this plate is a large fraction of the
   frame and the same proportional overshoot on it sweeps across most of it. */
const POP = 1.09;

/* How far the frozen world goes down behind the plate.
 *
 * A wash and not a blur: this look has nowhere to put a gradient — see the
 * shadow-map comment in main.js, which rejects PCFSoft on the same grounds —
 * and a Canvas 2D blur over a 1600x900 frame is not affordable per frame
 * anyway. One flat ink wash is what a printed page does to hold a panel back,
 * and it keeps the frozen frame legible as the game rather than deleting it.
 *
 * 0.55 is measured rather than chosen — tools/shell.mjs reads the actual
 * framebuffer at five points along the stage, takes the brightest pixel in
 * each frame, and composites this wash over it exactly. Worst case the plate's
 * cream ground stands at 3.23:1 against the washed world and its ink outline
 * at 4.13:1, which clears the 3:1 threshold for a non-text boundary.
 *
 * It does NOT clear 4.5:1, and that is the right answer to the wrong question:
 * 4.5:1 is the threshold for text against its own background, and no glyph on
 * this plate is ever drawn over the world. The type sits on the plate's own
 * cream, ink and yellow at 14:1, 14:1 and 9.3:1. The wash separates two
 * surfaces; the plate's own 4u ink outline and drop shadow do the rest, which
 * is why it can be light enough to leave the frozen frame reading as the game
 * rather than deleting it. */
const DIM = 0.55;

export class Pause {
  constructor() {
    /* Off under `manual` — see main.js. Belt and braces on top of the fact
       that nothing but a real key edge can open this at all. */
    this.enabled = true;
    this.armed = false;          // the menu is up
    this.t = 0;                  // WALL seconds since it opened
    this.index = 0;
    this._action = null;
  }

  /** The one question the game loop asks. Nothing may be stepped. */
  get active() { return this.armed; }

  get items() { return ITEMS; }

  /**
   * Up, from the top.
   *
   * The cursor goes back to RESUME on every open rather than remembering
   * where it was left. Remembering is the friendlier-sounding option and is
   * wrong here: the previous choice was almost always RESTART or TO TITLE —
   * those are the ones a player deliberately navigates to — so a remembered
   * cursor puts the destructive item under the Enter key of somebody who
   * pressed Esc to look at the map.
   */
  open() {
    if (!this.enabled || this.armed) return false;
    this.armed = true;
    this.t = 0;
    this.index = 0;
    this._action = null;
    return true;
  }

  /** Down. The caller is responsible for restarting the world's clocks. */
  close() {
    this.armed = false;
    this.t = 0;
    this._action = null;
  }

  /** @param {number} d -1 up, +1 down. Wraps, because three items do. */
  move(d) {
    if (!this.armed || !d) return;
    this.index = (this.index + d + ITEMS.length) % ITEMS.length;
  }

  /** Choose whatever the cursor is on. The action is read back with take(). */
  confirm() {
    if (!this.armed) return;
    this._action = ITEMS[this.index];
  }

  /** Choose a named item directly, for the shortcut keys. */
  choose(name) {
    if (!this.armed) return;
    const i = ITEMS.indexOf(name);
    if (i < 0) return;
    this.index = i;
    this._action = name;
  }

  /**
   * The chosen action, consumed. 'RESUME' | 'RESTART' | 'TO TITLE' | null.
   *
   * Consumed rather than tested, on the countdown's argument for takeTone():
   * an edge read once cannot be dropped by a long frame or acted on twice.
   */
  take() {
    const a = this._action;
    this._action = null;
    return a;
  }

  /**
   * Advance. `dt` is WALL seconds — the frame's own dt.
   * @param {number} dt
   */
  update(dt) {
    if (!this.armed) return;
    this.t += dt;
  }

  /**
   * What the HUD should draw, or null.
   *
   * Null is load-bearing: the HUD's draw path for "not paused" has to be the
   * one it had before this landed, pixel for pixel (tools/hudparity.mjs).
   *
   * `dim` rides on the payload rather than living in the HUD for the same
   * reason `Ending.display().dim` does — it is a property of how far through
   * the transition this is, and the HUD should be told a number rather than
   * own a rule.
   */
  display() {
    if (!this.armed) return null;
    const k = smoothstep(0, IN_WALL, this.t);
    return {
      items: ITEMS,
      index: this.index,
      alpha: k,
      scale: 1 + (POP - 1) * (1 - k),
      dim: DIM * clamp(k, 0, 1),
    };
  }
}

export const PAUSE_ITEMS = ITEMS;
