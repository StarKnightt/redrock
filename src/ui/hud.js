/* Race HUD, drawn onto a 2D canvas sitting over the GL frame.
 *
 * Everything here is procedural geometry — every digit, letter and symbol is
 * a hand-built polyline skeleton stroked twice, ink pass under a fill pass,
 * so the type carries the same heavy comic outline as the world behind it.
 * fillText is never used: it would pull in whatever font the OS feels like,
 * which is both off-style and non-deterministic across machines.
 *
 * The needle is not the speed. It is a spring chasing the speed, slightly
 * underdamped, so it overshoots on a hard launch and shivers on a landing —
 * an analogue gauge that moves like an instrument rather than a variable.
 *
 * Cost model: this redraws every frame over a 60 fps scene, so anything with
 * more than a handful of path segments — the dial face with its 23 ticks, the
 * elevation silhouette with its 160 samples, the plates — is rendered once
 * into an offscreen layer at device resolution and blitted. The per-frame
 * work is three blits, one needle polygon, and a few dozen glyph strokes.
 */
import { clamp, lerp } from '../core/util.js';

/* Warm print palette. INK is a brown-black, not pure black, so the HUD sits
   in the same light as the cel shader's shadow tones. */
const INK = '#241812';
const INK_SOFT = '#7d6650';           // demoted type: readable, never shouting
const CREAM = '#f4e6c5';
const CREAM_DIM = '#e0c99e';
const RPM_TRACK = '#d2b78b';          // empty rpm lane, a step below the face
const RED = '#d8462a';
const YELLOW = '#f0b429';
const GREEN = '#6f8f38';
const SHADOW = 'rgba(36,24,18,0.30)';

/* The field's liveries, printed — the one palette group this file has gained,
 * used in exactly one place: the traffic strip's car markers, indexed by
 * `Car.palette` so a marker is the colour of the car it stands for.
 *
 * A marker's colour is the whole of its identity and it needs no legend,
 * because the legend is the car: the player has been looking at the blue one
 * for four minutes. What that buys is the only fact about a rival the HUD
 * cannot otherwise reach — WHICH rival — and the race system goes to real
 * trouble to make that worth knowing (see TRAITS in race/index.js: one of them
 * is good in the tight stuff, one backs off over the drops). Position, by
 * contrast, is already derivable from the strip: the standings sort on arc
 * length, so left-to-right along the strip IS last-to-first in the
 * classification, anchored by the player's own badge. Printing a numeral on
 * each marker would restate that at the cost of a plate three times the disc's
 * width, which measurably merges markers — see tools/zraxis.mjs, where going
 * from a 15u mark to a 20u one drops racing-band separability from 100% to 92%
 * and puts two markers on top of each other on 64% of frames instead of 54%.
 *
 * Two of the five are not the livery as painted, and it is a value problem
 * rather than a taste one. OCHRE's body is an acid yellow at nearly the value
 * of CREAM and BONE's is a pale warm grey a shade under it, so on this plate
 * both were a shape with no colour in it; each is dropped a rung and keeps its
 * hue. The other three are the body colours from car/mesh.js unchanged. */
const LIVERY = [
  '#ff5a24',    // 0 player  — rally orange-red, as painted
  '#2f7fbd',    // 1 COBALT  — as painted
  '#c4b02e',    // 2 OCHRE   — a rung down from 0xe0d24a, which sat on the cream
  '#63b562',    // 3 SAGE    — as painted
  '#8a827a',    // 4 BONE    — a rung down from 0xb9b4ad, same reason as OCHRE
];

/* ------------------------------------------------------------------------ */
/* Vector type. Each glyph lives on a 4 x 6 grid (y down), as a list of
 * strokes; a stroke is [closedFlag, x0,y0, x1,y1, ...]. Round caps and joins
 * plus a heavy line width turn these skeletons into bold poster letterforms.
 * Every alphanumeric shares one advance width, which is what keeps the timer
 * from jittering as digits roll — monospacing falls out of the grid for free.
 */
const GLYPHS = {
  '0': [[1, 1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6, 0, 5, 0, 1]],
  '1': [[0, 0.7, 1.1, 2.4, 0, 2.4, 6], [0, 0.9, 6, 3.9, 6]],
  '2': [[0, 0, 1.1, 1, 0, 3, 0, 4, 1, 4, 2.3, 0, 6, 4, 6]],
  '3': [[0, 0, 0.9, 1, 0, 3, 0, 4, 1, 4, 2, 3, 2.9, 1.7, 2.9],
        [0, 3, 2.9, 4, 3.8, 4, 5, 3, 6, 1, 6, 0, 5.1]],
  '4': [[0, 3.1, 6, 3.1, 0, 0, 4.3, 4, 4.3]],
  '5': [[0, 3.8, 0, 0.7, 0, 0.5, 2.6, 2.7, 2.6, 3.9, 3.5, 3.9, 5, 3, 6, 1, 6, 0, 5.1]],
  '6': [[0, 3.3, 0, 2.2, 0, 0.8, 1.5, 0.2, 3.2, 0.2, 5, 1.1, 6, 3, 6, 3.9, 5.1,
         3.9, 3.9, 3, 3, 1.2, 3, 0.3, 3.8]],
  '7': [[0, 0, 1, 0, 0, 4, 0, 1.7, 6]],
  '8': [[1, 1, 0, 3, 0, 3.8, 0.8, 3.8, 2.1, 3, 2.9, 1, 2.9, 0.2, 2.1, 0.2, 0.8],
        [1, 1, 2.9, 3, 2.9, 4, 3.8, 4, 5.1, 3, 6, 1, 6, 0, 5.1, 0, 3.8]],
  '9': [[0, 0.7, 6, 1.8, 6, 3.2, 4.5, 3.8, 2.8, 3.8, 1, 2.9, 0, 1, 0, 0.1, 0.9,
         0.1, 2.1, 1, 3, 2.8, 3, 3.7, 2.2]],
  'A': [[0, 0, 6, 1.6, 0, 2.4, 0, 4, 6], [0, 0.8, 4.1, 3.2, 4.1]],
  /* B and Y arrived with the results card, which is the first thing in the
     game that has to spell COBALT, BONE and PLAYER. Built on the same
     skeletons as their neighbours — B is P's bowl over the 8's, Y is V's
     shoulders on T's stem — so the classification is set in the same
     letterform as the rest of the poster. */
  'B': [[0, 0, 6, 0, 0, 3, 0, 4, 1, 4, 2.1, 3, 2.9, 0, 2.9],
        [0, 0, 2.9, 3.2, 2.9, 4, 3.8, 4, 5.1, 3.2, 6, 0, 6]],
  'C': [[0, 4, 1, 3, 0, 1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 4, 5]],
  'D': [[1, 0, 0, 2.6, 0, 4, 1.4, 4, 4.6, 2.6, 6, 0, 6]],
  'E': [[0, 4, 0, 0, 0, 0, 6, 4, 6], [0, 0, 3, 3, 3]],
  'F': [[0, 4, 0, 0, 0, 0, 6], [0, 0, 3, 3, 3]],
  'G': [[0, 3.9, 0.9, 3, 0, 1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 3.9, 5.1, 3.9, 3.3, 2.1, 3.3]],
  'H': [[0, 0, 0, 0, 6], [0, 4, 0, 4, 6], [0, 0, 3, 4, 3]],
  'I': [[0, 1, 0, 3, 0], [0, 2, 0, 2, 6], [0, 1, 6, 3, 6]],
  'K': [[0, 0, 0, 0, 6], [0, 4, 0, 0.4, 3.3], [0, 1.5, 2.6, 4, 6]],
  'L': [[0, 0, 0, 0, 6, 4, 6]],
  'M': [[0, 0, 6, 0.2, 0, 2, 3.4, 3.8, 0, 4, 6]],
  'N': [[0, 0, 6, 0, 0, 4, 6, 4, 0]],
  'O': [[1, 1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6, 0, 5, 0, 1]],
  'P': [[0, 0, 6, 0, 0, 3, 0, 4, 1, 4, 2.4, 3, 3.4, 0, 3.4]],
  'R': [[0, 0, 6, 0, 0, 3, 0, 4, 1, 4, 2.4, 3, 3.4, 0, 3.4], [0, 1.8, 3.4, 4, 6]],
  'S': [[0, 3.8, 0.9, 3, 0, 1, 0, 0.2, 0.8, 0.2, 2.1, 1, 2.9, 3, 3.1, 3.8, 3.9,
         3.8, 5.1, 3, 6, 1, 6, 0.2, 5.1]],
  'T': [[0, 0, 0, 4, 0], [0, 2, 0, 2, 6]],
  'U': [[0, 0, 0, 0, 5, 1, 6, 3, 6, 4, 5, 4, 0]],
  'V': [[0, 0, 0, 2, 6, 4, 0]],
  'W': [[0, 0, 0, 0.9, 6, 2, 2.8, 3.1, 6, 4, 0]],
  'Y': [[0, 0, 0, 2, 3, 4, 0], [0, 2, 3, 2, 6]],
  '/': [[0, 0.7, 6, 3.3, 0]],
  /* Punctuation is narrower than the letter cell, so its marks sit at the
     centre of the reduced advance rather than the full grid's. */
  ':': [[0, 1.6, 1.5, 1.6, 1.9], [0, 1.6, 4.1, 1.6, 4.5]],
  '.': [[0, 1.6, 5.5, 1.6, 5.9]],
  '-': [[0, 0.9, 3, 3.1, 3]],
  '+': [[0, 2, 1.8, 2, 4.2], [0, 0.9, 3, 3.1, 3]],
  ' ': [],
};
const ADV_DEFAULT = 5.5;
const ADV = { ':': 3.2, '.': 3.2, ' ': 3.4, '-': 4.4, '+': 5.0 };
const advOf = ch => ADV[ch] !== undefined ? ADV[ch] : ADV_DEFAULT;

function textWidth(str, size, tracking = 0.5) {
  const sc = size / 6;
  let w = 0;
  for (const ch of str) w += (advOf(ch) + tracking) * sc;
  return Math.max(0, w - tracking * sc);
}

function tracePath(g, str, x, y, sc, slant, tracking) {
  let cx = x;
  for (const ch of str) {
    const strokes = GLYPHS[ch] || [];
    for (const s of strokes) {
      // Shear leans the glyph forward: taller points shift further right.
      const px = i => cx + s[i] * sc + (6 - s[i + 1]) * sc * slant;
      const py = i => y + s[i + 1] * sc;
      g.moveTo(px(1), py(1));
      for (let i = 3; i < s.length; i += 2) g.lineTo(px(i), py(i));
      if (s[0]) g.closePath();
    }
    cx += (advOf(ch) + tracking) * sc;
  }
}

/**
 * Stroke a string of vector glyphs. `y` is the top of the glyph cell.
 * Options: color, outline (px each side), outlineColor, weight (grid units),
 * align, slant, tracking (grid units).
 */
function drawText(g, str, x, y, size, o = {}) {
  const sc = size / 6;
  const tracking = o.tracking !== undefined ? o.tracking : 0.5;
  const slant = o.slant || 0;
  const weight = (o.weight !== undefined ? o.weight : 1.25) * sc;
  if (o.align === 'center') x -= textWidth(str, size, tracking) / 2;
  else if (o.align === 'right') x -= textWidth(str, size, tracking);

  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (o.outline) {
    g.beginPath();
    tracePath(g, str, x, y, sc, slant, tracking);
    g.lineWidth = weight + o.outline * 2;
    g.strokeStyle = o.outlineColor || INK;
    g.stroke();
  }
  g.beginPath();
  tracePath(g, str, x, y, sc, slant, tracking);
  g.lineWidth = weight;
  g.strokeStyle = o.color || INK;
  g.stroke();
}

/* ------------------------------------------------------------------------ */

function chamfer(g, x, y, w, h, c) {
  g.beginPath();
  g.moveTo(x + c, y);
  g.lineTo(x + w - c, y);
  g.lineTo(x + w, y + c);
  g.lineTo(x + w, y + h - c);
  g.lineTo(x + w - c, y + h);
  g.lineTo(x + c, y + h);
  g.lineTo(x, y + h - c);
  g.lineTo(x, y + c);
  g.closePath();
}

/* Offscreen layer at device resolution, drawn in CSS units, blitted at CSS
   size — this is the whole dpr story and it lives in exactly one place. */
function makeLayer(w, h, dpr, paint) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  paint(g);
  return { c, w, h };
}
const blit = (ctx, l, x, y) => ctx.drawImage(l.c, x, y, l.w, l.h);

const ordinal = n => {
  const t = n % 10, h = n % 100;
  if (h >= 11 && h <= 13) return 'TH';
  return t === 1 ? 'ST' : t === 2 ? 'ND' : t === 3 ? 'RD' : 'TH';
};

/* A race time for the results card. Hundredths, not the timer's thousandths:
   the plate sets four of these one under another at two thirds the timer's
   size, and a third decimal there is a column of texture that pushes the
   column that matters — the gap — off the edge of the card. */
const clockText = t => {
  const s = Math.max(0, t);
  const mm = Math.floor(s / 60);
  const ss = String(Math.floor(s % 60)).padStart(2, '0');
  const cs = String(Math.floor((s % 1) * 100)).padStart(2, '0');
  return `${mm}:${ss}.${cs}`;
};

/* Dial calibration. Terminal velocity is around 195 km/h, so 220 puts the
   needle near — but never against — the end stop at full chat. */
const VMAX = 220;
const ANG0 = Math.PI * 0.75;          // 0 km/h: needle points down-left
const ANG_SWEEP = Math.PI * 1.5;      // 270 degrees of dial
const angleOf = v => ANG0 + (clamp(v, 0, VMAX) / VMAX) * ANG_SWEEP;

/* Needle spring. omega sets how fast it closes on the target, zeta below 1
   is what buys the overshoot; 0.45 gives one visible bounce and a settle. */
const N_OMEGA = 9.0, N_ZETA = 0.45;

/* ---- the traffic strip's axis -------------------------------------------- */

/* The gap, in metres of arc, that lands exactly halfway from the datum to the
 * rim. It is the strip's whole calibration and there is nothing else to tune.
 *
 * The axis is x = H · Δ / (|Δ| + K), where Δ is the rival's arc-length offset
 * from the player and H is half the strip's drawable width. Three properties
 * earned it, and each of them was measured against 19,117 sampled frames of
 * sixteen full races (tools/zrspread.mjs feeds tools/zraxis.mjs, which scores
 * fifteen candidate axes):
 *
 *   BOUNDED BY CONSTRUCTION. |x| < H for every Δ, including a rival stranded
 *   three kilometres up the road, so nothing is ever clamped against the rim
 *   and no marker's distance stops being reported. Every finite-window
 *   candidate fails here and not marginally: a linear ±150 m window pins 36%
 *   of samples, ±300 m pins 18%, tanh K=120 pins 14%. A pinned marker is a
 *   marker that has stopped answering the question.
 *
 *   LINEAR THROUGH THE DATUM, with slope H/K. This is what sqrt does not have
 *   — its slope at zero is infinite — and it is why sqrt scored best on paper
 *   and lost anyway: two cars trading paint at half a metre would send their
 *   marker skating across several units on gap noise alone, and 65% of samples
 *   with the cars INSIDE ONE CAR LENGTH of each other came out as a marker
 *   standing clear of the datum, claiming daylight that does not exist.
 *
 *   K SETS WHERE THE RESOLUTION GOES, and 90 m is where the racing is. Over
 *   the sixteen fields the median player-to-rival gap is 94 m, so K = 90 spends
 *   half the strip on the near half of the gap distribution. Scored against the
 *   marker's own 14u width, that separates 100% of samples in the 10–150 m band
 *   from the datum, 5% of the under-10 m band (correct: those cars are touching,
 *   and the markers should overlap), and moves at 4.45 device px/s median where
 *   there is something to watch. K=60 buys nothing and starts claiming daylight
 *   at a car length; K=150 drops the racing band to 88%.
 *
 * For scale, the axis this replaced — the elevation card's own, which is what
 * "put the rivals on the map" means before it is measured — separates 0% of
 * that band and moves at 0.40 px/s, one pixel every two and a half seconds.
 *
 *     node tools/zraxis.mjs --sep 4,7,14 */
const RIV_K = 90;

/* The lit band: how many metres either side of the player are painted a rung
   brighter than the rest of the strip. 60 m is not chosen here — it is the
   project's own existing definition of a rival being NEAR, from
   tools/kwgrid.mjs's NEAR_M, and reusing it means the boundary on the strip
   means the same thing as the boundary in the balance table. It also gives the
   strip the only absolute scale reference it has apart from the flag. */
const RIV_NEAR = 60;

/* How close the line has to be before the strip draws it.
 *
 * The chequered bar belongs here — where the finish sits relative to the cars is
 * the question the last kilometre is about, and it is a question about gaps, not
 * about the stage. But an asymptotic axis sends everything far away to the same
 * place, so drawn unconditionally the bar spends four minutes pinned to the rim
 * with any rival more than a few hundred metres up the road pinned beside it.
 * tools/zrshot.mjs caught what that looks like: a frame with rivals 332 and
 * 600 m ahead parked against the bar while the line was 3.6 km away, which reads
 * as two cars about to finish and is a lie. A mark that has stopped reporting its
 * own distance should not be on screen.
 *
 * 400 m is measured, not picked (tools/zraxis.mjs, sixteen recorded fields,
 * ~19,000 frames). Counting a bar that lands within one marker width of a rival
 * more than 150 m from the line as a false reading:
 *
 *     drawn always     7.0% of frames false, 2.3% true
 *     from 600 m       0.3% false (50 frames), 94% of the true cases kept
 *     from 400 m       0.03% false (6 frames), 72% of the true cases kept
 *     from 300 m       0% false, 57% kept
 *
 * 400 m takes the knee: six frames in nineteen thousand, and at racing pace it
 * is a ten-second run-in, which is long enough for "can I get him before the
 * line" to be a live question and short enough that the bar is visibly moving
 * inward the whole time — 34u off the rim when it appears. */
const RIV_FLAG = 400;

/* Position punctuation. The clock exists only while an explicitly enabled
 * event is alive; see setFeedbackEnabled(), which is the dormancy rule that
 * keeps instrument frames clock-free. */
const POSITION_ACCENT_SEC = 0.68;

/* A car marker: flat livery over an ink ring, exactly the mark the elevation
   card already uses for the player, at exactly its size. Fill under stroke and
   a 3u line, so half the ink sits outside the disc and half over the colour —
   copied from _drawMap rather than re-derived, because a car should be the
   same object in both places. */
function carDot(g, x, y, r, col, ink) {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = col;
  g.fill();
  g.lineWidth = ink;
  g.strokeStyle = INK;
  g.stroke();
}

export class Hud {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts;
    this.profile = null;
    this.state = {
      speed: 0, rpm: 0, gear: 0, position: 1, fieldSize: 1,
      time: 0, progress: 0, delta: null, finished: false,
      /* The start countdown, or null, which it is for the whole of every race
         except the first three and a bit seconds of it. See _drawCountdown. */
      countdown: null,
      /* And the finish, or null, which it is for the whole of every race up
         to the line. See _drawResults. */
      ending: null,
      /* The classification — Race.standings(), player row included — or null
         for a build, a tool or a page that has no field. Null and a field of
         one both draw nothing at all: see _drawStrip. */
      rivals: null,
      /* The shell. Both null for every frame of every race, and both are the
         only two things in this file that suppress or cover the running
         furniture rather than adding to it — see draw(), which owns the two
         branches, and _drawTitle / _drawPause, which own everything else. */
      title: null,
      pause: null,
    };
    this.needle = 0;                   // displayed km/h, chases state.speed
    this.needleVel = 0;
    this.w = 0; this.h = 0; this.dpr = 1;
    this.L = null;                     // layout metrics, rebuilt on resize
    this._face = null;                 // dial face layer
    this._map = null;                  // elevation card layer
    this._ridge = null;                // silhouette points for the marker
    this._plate = null;                // timer plate layer
    this._badge = null;                // position badge layer
    this._badgeKey = '';
    /* Opt-in, unlike the continuous furniture. main.js enables it only for a
       human race; a bare Hud (including hudparity) therefore has no event
       clock at all. */
    this.feedbackEnabled = opts.feedbackEnabled === true;
    this._positionAccent = null;
    /* The shell's two layers. Keyed on the size they were built at rather
       than rebuilt from resize(), which is why nothing in this pass had to
       touch resize() or `this.L` — see the section at the bottom of the file.
       Both stay null for the whole of every race. */
    this._title = null; this._titleKey = '';
    this._pause = null; this._pauseL = null; this._pauseKey = '';
  }

  /**
   * `profile`: { length, finishS, points: [{s, y}, ...] } elevation along the
   * stage.
   *
   * `length` is the extent of the ridge — the whole ROAD, which since the
   * run-off landed is 154 m longer than the race. `finishS` is where the flag
   * actually is. They used to be the same number and this file used it for both
   * jobs, which put the chequered bar on the card and the chequered bar on the
   * traffic strip at the end of the road rather than at the line. `finishS`
   * falls back to `length` so a caller that predates it — every tool with its
   * own HUD page — draws exactly what it drew before.
   */
  setCourse(profile) {
    this.profile = profile;
    this.finishS = profile && profile.finishS != null
      ? profile.finishS : (profile ? profile.length : 0);
    this._map = null;
    if (this.L) this._buildMap();
  }

  /**
   * Arm or make dormant every time-varying race accent.
   *
   * Disabling is sticky until explicitly reversed and clears an in-flight
   * cue. That is stronger than merely refusing new events: autopilot may take
   * the wheel halfway through the 0.68 second pulse, and a capture on its next
   * frame must still get the settled HUD.
   */
  setFeedbackEnabled(enabled) {
    this.feedbackEnabled = !!enabled;
    if (!this.feedbackEnabled) this.clearFeedback();
  }

  clearFeedback() {
    this._positionAccent = null;
  }

  /** A settled Race.takePositionChange() payload. */
  positionChange(change) {
    if (!this.feedbackEnabled || !change
      || (change.direction !== 'gained' && change.direction !== 'lost')) return false;
    this._positionAccent = {
      direction: change.direction,
      from: change.from,
      to: change.to,
      t: 0,
    };
    return true;
  }

  resize(w, h, dpr = 1) {
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';

    /* Everything scales off the short side so 16:9 and ultrawide get the
       same-sized furniture; the wide screen just gets more sky between it. */
    const u = Math.min(w, h) / 720;
    const m = 30 * u;
    const dialR = 98 * u;
    /* Hoisted out of the literal below because the traffic strip is measured
       off them: it takes the card's width and the card's 16u ridge inset, so
       the two objects share one column and one horizontal axis width. */
    const mapW = Math.min(330 * u, w * 0.30);
    const mapH = 118 * u;
    this.L = {
      u, m,
      dial: { r: dialR, cx: w - m - dialR, cy: h - m - dialR },
      map: { x: m, y: m, w: mapW, h: mapH },
      /* The field, under the stage card. See _drawStrip for why it is a second
         object rather than three more marks on the card. */
      strip: {
        x: m, y: m + mapH + 8 * u, w: mapW, h: 34 * u,
        pad: 16 * u, half: (mapW - 32 * u) / 2, r: 5.5 * u, ink: 3 * u,
      },
      timer: { size: 30 * u, y: m },
      pos: { numSize: 66 * u, sufSize: 26 * u },
      /* The classification card. Sized off the widest thing it has to set —
         a four-column row of position, name, time and gap at 22 grid units —
         rather than picked and then discovered to be too small, which is the
         mistake this project keeps paying for in screen-space size. At
         1600x900 the plate is 700 x 264 device pixels, twice the area of the
         countdown's GO and a fifth of the frame; hudparity.mjs measures it. */
      card: {
        w: 560 * u, rowH: 38 * u, headH: 40 * u, pad: 16 * u,
        size: 22 * u, cy: 0.53,
      },
    };
    this._buildFace();
    this._buildPlate();
    this._badge = null; this._badgeKey = '';
    /* Lazily, like the badge, and for the same reason: the header changes
       colour with the result and the plate is not worth building twice on
       every resize when most runs never see it at all. */
    this._card = null; this._cardKey = '';
    /* And the traffic strip, lazily for a third reason: a build with no field
       — every tool with its own HUD page, and the parity harness — must not
       pay for a canvas it will never blit, and resize() must not draw anything
       a no-rivals frame did not draw before. */
    this._strip = null;
    if (this.profile) this._buildMap();
  }

  update(dt, state) {
    Object.assign(this.state, state);
    const frameDt = clamp(dt, 0, 0.1);
    /* This is the HUD's only event clock. It advances from the caller's dt,
       never performance.now(), and does not exist on the ordinary draw path. */
    if (this._positionAccent) {
      if (!this.feedbackEnabled) this._positionAccent = null;
      else {
        this._positionAccent.t += frameDt;
        if (this._positionAccent.t >= POSITION_ACCENT_SEC) this._positionAccent = null;
      }
    }
    /* Substep the spring: at tab-switch dt a single Euler step of an
       underdamped oscillator gains energy instead of losing it. */
    let t = frameDt;
    const target = this.state.speed * 3.6;
    while (t > 0) {
      const h = Math.min(t, 1 / 240);
      const acc = (target - this.needle) * N_OMEGA * N_OMEGA
        - this.needleVel * 2 * N_ZETA * N_OMEGA;
      this.needleVel += acc * h;
      this.needle += this.needleVel * h;
      t -= h;
    }
    if (this.needle < 0) { this.needle = 0; this.needleVel *= -0.3; }
  }

  draw() {
    if (!this.L) return;
    const { ctx, w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    /* The title screen REPLACES the HUD rather than sitting over it, and this
       return is the whole of that. A speedometer reading zero, a stage clock
       reading zero and a badge reading 1ST/1 are all true on a title screen
       and all of them are furniture for a race that has not started; drawn
       there they say the game is already running and the player has stalled
       it. Null for every frame of every race, so this branch costs the
       running game one comparison. */
    const ti = this.state.title;
    if (ti) return this._drawTitle(ctx, ti);
    /* The running furniture steps back while the classification is up, and
       only then. It is not deleted: the timer plate is showing the final time
       and the badge the final position, both of which are the answer the card
       is also giving, and a frame that throws them away loses the thing that
       ties the card to the race it came from.
       Written as two branches on a value that is null for every frame of
       every race up to the line, so with no ending running this method is the
       one it was — byte for byte, all four million of them, at four HUD
       states and five sizes (tools/hudparity.mjs). */
    const e = this.state.ending;
    if (e) ctx.globalAlpha = clamp(1 - e.dim, 0, 1);
    this._drawMap(ctx);
    /* Under the card and inside the ending's dim, because it is the same kind
       of object as the card and steps back with it. Returns on its first line
       when there is no field, so a frame without rivals is the frame it was —
       byte for byte, four HUD states at five sizes (tools/hudparity.mjs). */
    this._drawStrip(ctx);
    this._drawTimer(ctx);
    this._drawPosition(ctx);
    this._drawDial(ctx);
    if (e) ctx.globalAlpha = 1;
    if (this.state.countdown) this._drawCountdown(ctx);
    if (e) this._drawResults(ctx, e);
    /* Last, and over everything including the countdown and the card, because
       a pause is a statement about the whole frame and not another instrument
       in it. Null for every frame of every race. */
    const pz = this.state.pause;
    if (pz) this._drawPause(ctx, pz);
  }

  /* ---- the classification ------------------------------------------------ */

  /**
   * Final positions, times and gaps, over the held finish shot.
   *
   * Four columns and nothing else: where you came, who it was, the time, and
   * the gap. The leader's own row carries the absolute time and everyone
   * else's carries a gap to it, which is how every timing screen in the sport
   * reads and is the only arrangement in which the number a player looks for
   * first — how close it was — is a single glance rather than a subtraction.
   *
   * Rows for cars still on the road carry the metres they have left instead
   * of a time, and that is deliberate: when the player wins, three cars are
   * still coming, and the alternative to a live table is a card that either
   * lies about them or waits half a minute for them. A distance is a fact.
   * A projected finishing time is a forecast, and a results table is the one
   * screen in this game with no business forecasting anything.
   */
  _drawResults(ctx, e) {
    const { u } = this.L, C = this.L.card;
    const rows = e.rows || [];
    const key = (e.won ? 'w' : 'l') + rows.length;
    if (key !== this._cardKey) { this._buildCard(rows.length, e.won); this._cardKey = key; }

    const ch = C.headH + rows.length * C.rowH + C.pad;
    const cx = this.w / 2, cy = this.h * C.cy;

    ctx.save();
    ctx.globalAlpha = clamp(e.alpha, 0, 1);
    ctx.translate(cx, cy);
    ctx.scale(e.scale, e.scale);
    const x0 = -C.w / 2, y0 = -ch / 2;
    blit(ctx, this._card, x0 - 5 * u, y0 - 5 * u);

    /* Column rails, measured from the plate's own edges so the row and the
       furniture behind it cannot drift apart at another size. */
    const padX = 22 * u;
    const sz = C.size;
    /* The gap column is sized to the widest gap the classification actually
       carries. It was a flat 108u, which is exactly +9.45 and five units of
       paper, so every gap from +10.00 up physically overlapped the time on its
       own row — 11 device px at +16.11 and 38 at +180.55, at 1600x900 — and a
       lapped or spun rival finishes minutes down, which over a four-minute
       race is the ordinary case rather than an edge of it.
       Two limits, because widening this column walks the TIME left and the
       time has a name to its own left. The floor is the authored width, so a
       card whose gaps are all inside ten seconds is the card it was, pixel for
       pixel. The ceiling is the name: the time may walk left only to the
       longest name on the plate, and 13u covers that name's slant, the two
       half-strokes facing each other and six units of clear paper. Between
       them the plate seats +999.99 — three digits, which is every gap 5.6 km
       can produce. A fourth digit would need a wider plate, and the ceiling
       spends what is left on the gap instead of taking it off a name. */
    const nib = 1.3 * sz / 6;             // the stroke both right columns carry
    let gapCol = 108 * u, timeW = 0, nameW = 0;
    for (const r of rows) {
      nameW = Math.max(nameW, textWidth(r.name, sz));
      if (!r.finished) continue;
      timeW = Math.max(timeW, textWidth(clockText(r.time), sz));
      if (r.gap !== null) {
        gapCol = Math.max(gapCol,
          textWidth('+' + r.gap.toFixed(2), sz) + nib + 5 * u);
      }
    }
    gapCol = Math.min(gapCol, Math.max(108 * u,
      C.w - 2 * padX - 82 * u - nameW - timeW - 13 * u));
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const ry = y0 + C.headH + i * C.rowH;
      const ty = ry + (C.rowH - sz) / 2;
      if (r.isPlayer) {
        /* The player's row is the one the eye has to find, and it finds it by
           value rather than by hue — a cream row on a cream plate separated
           by colour alone disappears at this size. */
        ctx.fillStyle = YELLOW;
        ctx.fillRect(x0 + 4 * u, ry + 1 * u, C.w - 8 * u, C.rowH - 2 * u);
      }
      /* Everything on the plate is ink; only the gap column is demoted, and
         not on the player's row — INK_SOFT is a brown, and a brown on the hot
         yellow is the one pairing on this palette with nothing between it and
         the ground. */
      const fg = INK;
      const dim = r.isPlayer ? INK : INK_SOFT;
      drawText(ctx, String(r.pos) + ordinal(r.pos), x0 + padX, ty, sz,
        { color: fg, weight: 1.45, slant: 0.06, tracking: 0.4 });
      drawText(ctx, r.name, x0 + padX + 82 * u, ty, sz,
        { color: fg, weight: 1.35, slant: 0.06 });
      if (r.finished) {
        drawText(ctx, clockText(r.time), x0 + C.w - padX - gapCol, ty, sz,
          { align: 'right', color: fg, weight: 1.3 });
        drawText(ctx, r.gap === null ? '' : '+' + r.gap.toFixed(2),
          x0 + C.w - padX, ty, sz,
          { align: 'right', color: r.gap === null ? fg : dim, weight: 1.3 });
      } else {
        drawText(ctx, Math.round(r.behind || 0) + 'M', x0 + C.w - padX, ty, sz,
          { align: 'right', color: dim, weight: 1.3 });
      }
    }
    ctx.restore();

    /* The way out. Below the plate, on the delta chip's furniture, because it
       is the same kind of object — a small statement pinned to a bigger one —
       and because a player who has just been reading a table finds the next
       instruction directly under it.
       BOTH inputs are named because both work: restart is R on the keyboard
       and select on a pad (src/core/input.js `reset`), and a controller player
       told to reach for a keyboard had no way off this card at all until the
       pad binding landed. Static rather than switched on whether a pad is
       plugged in — see _buildTitle, which carries the measurement.
       The verb went, and that was forced rather than chosen. This slab is
       sized to its own text and hangs under a 560u plate, and "PRESS R OR
       SELECT TO RACE AGAIN" measures 592.5u — 105.8% of the plate, so the
       small statement would be wider than the big one it is pinned to.
       Dropping PRESS brings it to 481.4u, 86.0%, against 73.1% today; the
       title's prompt lost the same word for the same reason, so the two
       screens that bracket a run still speak in one voice. .fix/pk/slabfit.mjs
       has the table, and every quantity in it is proportional to u on both
       sides, so that ratio is the same at all five parity sizes. */
    if (e.prompt > 0.01) {
      ctx.save();
      ctx.globalAlpha = clamp(e.alpha * e.prompt, 0, 1);
      const txt = 'R OR SELECT TO RACE AGAIN';
      const ps = 19 * u;
      const pw = textWidth(txt, ps, 0.7) + 26 * u, ph = ps + 14 * u;
      const px = cx - pw / 2, py = cy + ch / 2 + 16 * u;
      ctx.fillStyle = SHADOW;
      chamfer(ctx, px + 3 * u, py + 4 * u, pw, ph, 6 * u); ctx.fill();
      ctx.fillStyle = INK;
      chamfer(ctx, px, py, pw, ph, 6 * u); ctx.fill();
      drawText(ctx, txt, cx, py + 7 * u, ps,
        { align: 'center', color: CREAM, weight: 1.35, tracking: 0.7 });
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  _buildCard(nRows, won) {
    const { u } = this.L, C = this.L.card;
    const ch = C.headH + nRows * C.rowH + C.pad;
    const cw = C.w;
    this._card = makeLayer(cw + 10 * u, ch + 10 * u, this.dpr, g => {
      g.translate(5 * u, 5 * u);
      g.fillStyle = SHADOW;
      chamfer(g, 4 * u, 5 * u, cw, ch, 10 * u); g.fill();
      g.fillStyle = CREAM;
      chamfer(g, 0, 0, cw, ch, 10 * u); g.fill();

      /* Header band, clipped to the plate so its square corners cannot poke
         out through the chamfer. Green for a win and red otherwise — the
         same two colours, meaning the same two things, as the countdown
         plate the race opened with. */
      g.save();
      chamfer(g, 0, 0, cw, ch, 10 * u); g.clip();
      g.fillStyle = won ? GREEN : RED;
      g.fillRect(0, 0, cw, C.headH);
      // And the timer plate's yellow spine, so the card is the same object.
      g.fillStyle = YELLOW;
      g.fillRect(0, C.headH, 9 * u, ch - C.headH);
      /* One quantised step across the lower half of the plate, exactly as the
         dial face carries one. Flat cream over this area reads as paper, not
         as a printed card in this light. */
      g.fillStyle = CREAM_DIM;
      g.fillRect(0, ch - C.pad, cw, C.pad);
      g.restore();

      g.lineWidth = 4 * u; g.strokeStyle = INK;
      chamfer(g, 0, 0, cw, ch, 10 * u); g.stroke();
      g.lineWidth = 3 * u;
      g.beginPath(); g.moveTo(0, C.headH); g.lineTo(cw, C.headH); g.stroke();

      const padX = 22 * u, hs = 22 * u;
      drawText(g, 'FINISH', padX, (C.headH - hs) / 2, hs,
        { color: CREAM, outline: 2.4 * u, weight: 1.5, slant: 0.06, tracking: 1.4 });
      const kmTxt = this.profile
        ? (this.finishS / 1000).toFixed(1) + 'KM' : '';
      if (kmTxt) {
        drawText(g, kmTxt, cw - padX, (C.headH - hs * 0.72) / 2, hs * 0.72,
          { align: 'right', color: CREAM, weight: 1.3, tracking: 0.9 });
      }

      // Hairlines between rows, a step below the ink so they separate without
      // becoming a grid the eye has to read past.
      g.lineWidth = 1.6 * u; g.strokeStyle = CREAM_DIM;
      for (let i = 1; i < nRows; i++) {
        const y = C.headH + i * C.rowH;
        g.beginPath(); g.moveTo(12 * u, y); g.lineTo(cw - 12 * u, y); g.stroke();
      }
    });
  }

  /* ---- start countdown ---------------------------------------------------- */

  /**
   * Three, two, one, GO, over the middle of the frame.
   *
   * Numerals rather than a gantry of lights, and the reason is screen-space
   * size. The start gate this stage already has stands at s = 10, and the car
   * is set down at s = 34 with the chase lens ten metres behind it — the gate
   * is fourteen metres BEHIND the camera, so nothing hung on it is in the
   * frame at all. A new gantry would have to go down the road past the grid,
   * where a 0.4 m lamp at 26 m subtends 0.015 rad, and at 900 px over a 62°
   * vertical field that is thirteen pixels: a coloured dot. The numeral cell
   * below is 190/720 of the short side, so 238 px at 900 and 285 at 1080 —
   * eighteen times the mechanism, for no triangles and no change to the
   * world. (Both numbers are the SHORT SIDE in device-independent pixels.
   * hudparity.mjs measures what is actually inked, plate included: 344 x 335
   * at 1600x900.)
   *
   * Everything is drawn with the same vector type as the rest of the HUD, at
   * the same weight ratio, so it is the same poster and not an overlay.
   *
   * Nothing in this method runs when `state.countdown` is null, and nothing
   * outside it was touched: with no countdown the frame is the frame it was.
   */
  _drawCountdown(ctx) {
    const c = this.state.countdown;
    const u = this.L.u;
    const size = 190 * u;                 // u is min(w,h)/720, so 0.26 of it
    const weight = 1.3;                   // grid units, as everywhere else here
    /* Above centre, not on it. Measured against the grid frame at 1600x900:
       the horizon sits at about 0.33 of the height and the car's roof at
       0.38, so a plate centred on the canvas is a plate on the car. This
       straddles the horizon and leaves the car in shot under it. */
    const cx = this.w / 2, cy = this.h * 0.35;

    ctx.save();
    ctx.globalAlpha = clamp(c.alpha, 0, 1);
    ctx.translate(cx, cy);
    ctx.scale(c.scale, c.scale);

    /* A slab behind it, angled like the position badge, so the type has
       something to sit on wherever the road happens to be pale. Sized off the
       glyphs rather than fixed, since GO is three times the width of a digit. */
    /* The plate is sized off the glyphs, and off the STROKE and not the cell:
       the type is drawn with round caps at `weight` grid units and an ink
       outline outside that, so the mark is most of a third of a cell taller
       and wider than textWidth reports. Sized off the cell alone, the first
       build had the G and the O hanging over both edges of their own plate. */
    const tw = textWidth(c.text, size, 0.5);
    const bleed = (weight * size) / 12 + 4 * u;
    const padX = bleed + 16 * u, padY = bleed + 10 * u, skew = 12 * u;
    const bw = tw + padX * 2, bh = size + padY * 2;
    const x0 = -bw / 2, y0 = -bh / 2;
    const slab = (ox, oy, fill) => {
      ctx.beginPath();
      ctx.moveTo(x0 + ox + skew, y0 + oy);
      ctx.lineTo(x0 + ox + bw + skew, y0 + oy);
      ctx.lineTo(x0 + ox + bw, y0 + oy + bh);
      ctx.lineTo(x0 + ox, y0 + oy + bh);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };
    slab(5 * u, 6 * u, SHADOW);
    // Red through the count, and the release turns the whole plate green.
    slab(0, 0, c.go ? GREEN : RED);
    ctx.lineWidth = 5 * u; ctx.lineJoin = 'round'; ctx.strokeStyle = INK;
    ctx.stroke();

    drawText(ctx, c.text, 0, y0 + padY, size,
      { align: 'center', color: CREAM, outline: 4 * u, weight, slant: 0.06 });
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /* ---- speedometer ------------------------------------------------------ */

  _buildFace() {
    const { u, dial } = this.L;
    const r = dial.r, pad = 10 * u, S = (r + pad) * 2;
    this._face = makeLayer(S, S, this.dpr, g => {
      const c = S / 2;
      // Flat offset shadow — a print misregistration, not a soft blur.
      g.fillStyle = SHADOW;
      g.beginPath(); g.arc(c + 4 * u, c + 5 * u, r, 0, Math.PI * 2); g.fill();

      g.fillStyle = INK;
      g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.fill();
      const rIn = r - 6.5 * u;
      g.fillStyle = CREAM;
      g.beginPath(); g.arc(c, c, rIn, 0, Math.PI * 2); g.fill();
      // One quantised shade step across the lower face keeps it cel, not flat.
      g.fillStyle = CREAM_DIM;
      g.beginPath(); g.arc(c, c, rIn, Math.PI * 0.12, Math.PI * 0.68); g.closePath(); g.fill();

      /* Radial lanes, rim inward: the rpm arc's track, then a zone band the
         ticks cross, then the tick marks, then three anchor numerals. The
         needle lives inside the tick band and reaches none of the others —
         the old face packed all of this into two radii and the needle cut
         through the numbers. */
      g.lineCap = 'round';
      g.strokeStyle = RPM_TRACK;
      g.lineWidth = 7 * u;
      g.beginPath();
      g.arc(c, c, rIn - 5 * u, ANG0, ANG0 + ANG_SWEEP);
      g.stroke();

      const zone = (v0, v1, col) => {
        g.strokeStyle = col;
        g.lineWidth = 13 * u;
        g.beginPath();
        g.arc(c, c, rIn - 19 * u, angleOf(v0), angleOf(v1));
        g.stroke();
      };
      zone(120, 160, YELLOW);
      zone(160, VMAX, RED);

      g.strokeStyle = INK;
      for (let v = 0; v <= VMAX; v += 10) {
        const a = angleOf(v), major = v % 20 === 0;
        const r0 = rIn - 12 * u, r1 = r0 - (major ? 15 : 9) * u;
        g.lineWidth = (major ? 4 : 2.4) * u;
        g.beginPath();
        g.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
        g.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
        g.stroke();
      }
      /* Three anchors are enough to calibrate a sweep; six numerals were
         decoration competing with the reading. The end stops and the top —
         not round hundreds — because those land in the dial's dead corners,
         off the horizontal row the big digits and KM/H own. */
      for (const v of [0, 100, VMAX]) {
        const a = angleOf(v), rn = rIn - 40 * u, sz = 13 * u;
        drawText(g, String(v), c + Math.cos(a) * rn, c + Math.sin(a) * rn - sz / 2,
          sz, { align: 'center', weight: 1.2, tracking: 0.8 });
      }
      drawText(g, 'KM/H', c, c + 12 * u, 11 * u,
        { align: 'center', weight: 1.3, tracking: 1.2 });
    });
  }

  _drawDial(ctx) {
    const { u, dial } = this.L;
    const { r, cx, cy } = dial;
    const st = this.state;
    blit(ctx, this._face, cx - r - 10 * u, cy - r - 10 * u);

    const rIn = r - 6.5 * u;

    /* RPM as one continuous arc filling its rim track — the earlier row of
       outlined cells read as a string of tiny zeros at 720p. The whole arc
       goes hot near the limiter, which is the only rpm fact a driver needs. */
    const rpm = clamp(st.rpm, 0, 1);
    if (rpm > 0.01) {
      ctx.strokeStyle = rpm > 0.85 ? RED : YELLOW;
      ctx.lineWidth = 7 * u;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(cx, cy, rIn - 5 * u, ANG0, ANG0 + rpm * ANG_SWEEP);
      ctx.stroke();
    }

    /* Gear chip, pinned onto the rim like a badge rather than crowded into
       the face — the inside of the dial is already spoken for. Car.gear is a
       0-based index into the ratio table, so the display adds one. */
    const gs = 32 * u, ga = Math.PI * 1.14;
    const gx = cx + Math.cos(ga) * r - gs / 2, gy = cy + Math.sin(ga) * r - gs / 2;
    ctx.fillStyle = YELLOW;
    chamfer(ctx, gx, gy, gs, gs, 5 * u);
    ctx.fill();
    ctx.lineWidth = 3 * u; ctx.strokeStyle = INK; ctx.stroke();
    drawText(ctx, String((st.gear | 0) + 1), gx + gs / 2,
      gy + 6 * u, gs * 0.62, { align: 'center', weight: 1.5 });

    /* The exact speed is the reading that matters at 180 km/h in peripheral
       vision, so it owns the centre of the dial at poster size; the sweep
       around it is context, not the message. True speed, not the needle's
       sprung opinion of it. */
    drawText(ctx, String(Math.round(st.speed * 3.6)), cx, cy - 33 * u, 38 * u,
      { align: 'center', weight: 1.45, slant: 0.06 });

    /* A short pointer riding the tick band: long enough to indicate, short
       enough that it never enters the numeral lane or the rpm track. The
       cream halo goes down first so the red wedge still separates when it
       is sitting on the red zone band at the top of the dial. */
    const a = angleOf(this.needle);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(rIn - 28 * u, 5.5 * u);
    ctx.lineTo(rIn - 13 * u, 2 * u);
    ctx.lineTo(rIn - 10 * u, 0);
    ctx.lineTo(rIn - 13 * u, -2 * u);
    ctx.lineTo(rIn - 28 * u, -5.5 * u);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 9 * u;
    ctx.strokeStyle = CREAM;
    ctx.stroke();
    ctx.fillStyle = RED;
    ctx.fill();
    ctx.lineWidth = 2.6 * u;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.restore();
  }

  /* ---- elevation profile ------------------------------------------------ */

  _buildMap() {
    const { u, map } = this.L;
    const pts = this.profile.points;
    let yMin = Infinity, yMax = -Infinity;
    for (const p of pts) { yMin = Math.min(yMin, p.y); yMax = Math.max(yMax, p.y); }
    const drop = Math.max(1, yMax - yMin);

    /* The header row owns the top band; the ridge starts below it so the
       start marker and the distance label never share pixels. */
    const padX = 16 * u, padT = 36 * u, padB = 12 * u;
    const iw = map.w - padX * 2, ih = map.h - padT - padB;
    /* The ridge is kept in card-local CSS units so the per-frame marker can
       interpolate along it without touching the profile again. */
    this._ridge = pts.map(p => ({
      s: p.s,
      x: padX + (p.s / this.profile.length) * iw,
      y: padT + ((yMax - p.y) / drop) * ih,
    }));
    const ridge = this._ridge;
    /* Where a station sits on the drawn ridge. The finish is no longer the last
       sample, so it has to be found rather than indexed. */
    const ridgeAt = (s) => {
      for (let i = 1; i < ridge.length; i++) {
        if (ridge[i].s < s) continue;
        const a = ridge[i - 1], b = ridge[i];
        const t = clamp((s - a.s) / Math.max(1e-6, b.s - a.s), 0, 1);
        return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
      }
      return ridge[ridge.length - 1];
    };

    this._map = makeLayer(map.w + 8 * u, map.h + 8 * u, this.dpr, g => {
      g.fillStyle = SHADOW;
      chamfer(g, 4 * u, 5 * u, map.w, map.h, 8 * u); g.fill();
      g.fillStyle = CREAM;
      chamfer(g, 0, 0, map.w, map.h, 8 * u); g.fill();
      g.lineWidth = 3.5 * u; g.strokeStyle = INK; g.stroke();

      // Mountain cross-section: silhouette filled to the card floor.
      g.beginPath();
      g.moveTo(ridge[0].x, ridge[0].y);
      for (const p of ridge) g.lineTo(p.x, p.y);
      g.lineTo(ridge[ridge.length - 1].x, map.h - padB + 6 * u);
      g.lineTo(ridge[0].x, map.h - padB + 6 * u);
      g.closePath();
      g.fillStyle = RED;
      g.fill();
      g.beginPath();
      g.moveTo(ridge[0].x, ridge[0].y);
      for (const p of ridge) g.lineTo(p.x, p.y);
      g.lineWidth = 3.5 * u;
      g.lineJoin = 'round';
      g.strokeStyle = INK;
      g.stroke();

      /* Start tick, and a full chequered bar standing over the finish — the
         one symbol nobody misreads, and tall enough that the progress dot
         approaching along the ridge never merges with it.
         Over `finishS` and not over the right-hand end of the ridge, which is
         now the end of the RUN-OFF and 154 m past the flag. The bar therefore
         stands a little inside the card and the ridge runs on behind it, which
         is the truth: the road does not stop at the flag. */
      const s0 = ridge[0], s1 = ridgeAt(this.finishS);
      g.strokeStyle = INK; g.lineCap = 'round';
      g.lineWidth = 3.5 * u;
      g.beginPath(); g.moveTo(s0.x, s0.y - 8 * u); g.lineTo(s0.x, s0.y + 8 * u); g.stroke();
      const q = 4.5 * u, rows = 5;
      const fx = s1.x - q, fy = s1.y - rows * q - 5 * u;
      for (let i = 0; i < 2; i++) for (let j = 0; j < rows; j++) {
        g.fillStyle = (i + j) % 2 ? CREAM : INK;
        g.fillRect(fx + i * q, fy + j * q, q, q);
      }
      g.lineWidth = 2.5 * u;
      g.strokeRect(fx, fy, 2 * q, rows * q);

      /* Stage card header: distance left, total drop right. The RACE distance,
         which is the flag's station — the run-off is drawn on the ridge but it
         is not stage length and quoting it as such would lengthen every stage in
         the game by 120 m without a metre of it being raced. */
      const km = (this.finishS / 1000).toFixed(1);
      drawText(g, km + 'KM', padX, 9 * u, 12 * u, { weight: 1.3, tracking: 0.9 });
      const dTxt = Math.round(drop) + 'M';
      const dw = textWidth(dTxt, 12 * u, 0.9);
      drawText(g, dTxt, map.w - padX, 9 * u, 12 * u,
        { align: 'right', color: RED, weight: 1.3, tracking: 0.9 });
      g.fillStyle = RED;
      g.beginPath();
      g.moveTo(map.w - padX - dw - 12 * u, 11 * u);
      g.lineTo(map.w - padX - dw - 4 * u, 11 * u);
      g.lineTo(map.w - padX - dw - 8 * u, 19 * u);
      g.closePath();
      g.fill();
    });
  }

  _drawMap(ctx) {
    if (!this._map) return;
    const { u, map } = this.L;
    blit(ctx, this._map, map.x, map.y);
    const ridge = this._ridge;
    const st = this.state;
    const sAt = clamp(st.progress, 0, 1) * this.profile.length;

    // Walk the ridge to the marker, painting the ground already covered.
    ctx.beginPath();
    ctx.moveTo(map.x + ridge[0].x, map.y + ridge[0].y);
    let mx = ridge[0].x, my = ridge[0].y;
    for (let i = 1; i < ridge.length; i++) {
      if (ridge[i].s >= sAt) {
        const a = ridge[i - 1], b = ridge[i];
        const t = (sAt - a.s) / Math.max(1e-6, b.s - a.s);
        mx = lerp(a.x, b.x, t); my = lerp(a.y, b.y, t);
        ctx.lineTo(map.x + mx, map.y + my);
        break;
      }
      ctx.lineTo(map.x + ridge[i].x, map.y + ridge[i].y);
      mx = ridge[i].x; my = ridge[i].y;
    }
    ctx.lineWidth = 3.5 * u;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = YELLOW;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(map.x + mx, map.y + my, 5.5 * u, 0, Math.PI * 2);
    /* The player's car in the player's paint, which is the same colour at the
       same size through the same ink ring as the datum on the traffic strip
       directly under this card — carDot was copied off this mark, and now it
       agrees with it. It was YELLOW: ΔE 19 from the rival ochre and ΔE 54 from
       the car it stands for, so the card marked you in nearer a rival's livery
       than your own while the strip below marked you correctly.
       The trail behind it stays YELLOW, and that is not an oversight. It is
       not the car, it is the ground already covered, and it is the one line
       here that has to read across both the cream sky and the red silhouette —
       LIVERY[0] is ΔE 17.5 from that silhouette and would lose the half of the
       ridge it runs below. The disc can afford the same 17.5 because it is the
       only one of the two carrying a 3u ink ring. */
    ctx.fillStyle = LIVERY[0];
    ctx.fill();
    ctx.lineWidth = 3 * u;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }

  /* ---- the field --------------------------------------------------------- */

  /**
   * The three rivals, on a strip whose axis is the road ahead of and behind the
   * player rather than the stage.
   *
   * WHY THIS IS NOT THREE MORE MARKS ON THE ELEVATION CARD, which is the
   * obvious thing to build and the thing that was asked for. The card's axis is
   * the whole stage: 5598 m across 298u of drawable ridge, which is 18.8 m per
   * device pixel at 1280x720. Sixteen full races were sampled at 5 Hz
   * (tools/zrspread.mjs, 19,117 frames) and the median player-to-rival gap is
   * 94 m — five pixels. The median NEAREST rival is 29 m, which is one and a
   * half. Against the 16u a pair of these markers needs to read as two marks,
   * a rival sits inside the player's own marker on 82% of frames and ALL THREE
   * do on 65% of them.
   *
   * And that is not a resolution problem, which is the part worth stating
   * plainly, because the instinct is to say it will be fine on a bigger
   * monitor. Both the card and the marker are authored in u = min(w,h)/720, so
   * the ratio between them is a constant: 82% and 65% are the numbers at
   * 1280x720, at 2560x1440 and at dpr 2, identically. The card is 18 marker
   * widths wide and the stage is 5.6 km, so a mark on it is worth 300 m however
   * many pixels the panel has. There is no size at which putting the field on
   * the stage axis works.
   *
   * Nor is the answer to make the card a window onto the road nearby. The card
   * is the only thing in the HUD that answers "how far through the descent am
   * I", it carries the chequered bar at the end of the ridge and a header
   * stating the stage's length and its total drop, and all three of those are
   * whole-track statements. Zooming it would trade a settled reading for a new
   * one; adding a second object trades nothing.
   *
   * So: the stage card keeps the stage, and the field gets a strip under it on
   * a relative axis — same left edge, same width, same chamfer, same ink, so
   * the column reads as one instrument in two rows. The player is the fixed
   * datum at the centre, which is the whole reason the axis has the resolution
   * the card cannot: it only ever has to draw the neighbourhood.
   *
   * What is on it, and nothing else is:
   *   - the datum, an ink post carrying the player's own car
   *   - three cars, in their liveries, ahead to the right and behind to the
   *     left, drawn farthest first so the one that matters is never covered
   *   - a lit band, ±60 m, the project's own definition of a rival being near
   *   - the flag, in the card's own chequered bar, once it is close enough to
   *     leave the rim
   *
   * A POSITION CHANGE IS AN EVENT ON THIS OBJECT AND COSTS NOTHING TO GET.
   * Overtaking a rival is its marker crossing the datum, in the direction you
   * passed it, at a rate the axis makes visible. The slope at the datum is H/K,
   * which at 1600x900 is 2.07 px per metre of gap, so a pass completed at 3 m/s
   * of closing speed drags the disc six pixels a second and a disc-width of
   * travel takes under two seconds; the captured passes run 9–20 px/s
   * (tools/zrshot.mjs) against a racing-band median of 4.45 and the stage axis's
   * 0.40. That is why the position badge's number no longer changes for no
   * visible reason. It remains the location channel, not the event channel:
   * the brief punctuation now lives on the position badge and in audio, where
   * it can arrive once without distorting this measured axis.
   *
   * Nothing here keeps state. Every mark is a pure function of the standings
   * and the player's progress, so two renders of a paused frame are the same
   * image, which is what the capture suite requires.
   */
  _drawStrip(ctx) {
    const rows = this.state.rivals;
    if (!rows) return;
    /* A field of one draws nothing — not an empty strip. `main.js` hands over
       the classification unconditionally, so this is the branch that keeps a
       build with no opponents, and every tool that composites the HUD without
       a race, looking exactly as it did. */
    let n = 0;
    for (const r of rows) if (!r.isPlayer) n++;
    if (!n) return;

    const { u } = this.L, S = this.L.strip;
    if (!this._strip) this._buildStrip();
    blit(ctx, this._strip, S.x, S.y);

    const cx = S.x + S.pad + S.half, cy = S.y + S.h / 2;
    /* The axis, with the marker's own half-width taken off the travel so a mark
       is always wholly inside the plate. The clamp is unreachable in practice
       and is here for the stranded-rival case: the bare axis asymptotes at
       S.half, so with a 8.5u mark it only bites past about 1900 m of gap, and
       the worst gap in sixteen races was 1111 m. */
    const axis = (d, half) => cx + clamp(S.half * d / (Math.abs(d) + RIV_K),
      -(S.half - half), S.half - half);

    /* The player's station from `progress`, not from the classification's own
       player row, so the datum on this strip and the dot on the card above it
       are the same car at the same instant off one number. */
    const len = this.profile ? this.profile.length : 0;
    const sMe = clamp(this.state.progress, 0, 1) * len;

    /* The flag, once it has something to say — see RIV_FLAG for the cut-off and
       what drawing it earlier costs. Drawn before the cars and in the card's own
       symbol at the card's own proportions, so it is the same mark meaning the
       same thing on a second axis: where the finish IS, up there; how far away
       it is, down here.
       Measured to `finishS`, which is the line. It used to be measured to the
       end of the ridge, and the two were 34 m apart — inside a pixel, so it read
       as correct. They are now 154 m apart, and this axis is calibrated on RIV_K
       to make tens of metres legible, so the bar would have sat well past the
       datum with the car already stopped. `left` is allowed to go negative and
       the axis is odd in `d`, so the flag slides behind the player as the car
       runs off past it — which is where it is. */
    const left = this.finishS - sMe;
    if (len > 0 && left <= RIV_FLAG) {
      const q = 4 * u, rowsN = 5;
      const fx = axis(left, q) - q;
      const fy = cy - (rowsN * q) / 2;
      for (let i = 0; i < 2; i++) for (let j = 0; j < rowsN; j++) {
        ctx.fillStyle = (i + j) % 2 ? CREAM : INK;
        ctx.fillRect(fx + i * q, fy + j * q, q, q);
      }
      ctx.lineWidth = 2.5 * u;
      ctx.strokeStyle = INK;
      ctx.strokeRect(fx, fy, 2 * q, rowsN * q);
    }

    /* Farthest first, so the nearest rival — the one being raced — is the mark
       on top when two of them land together, which over sixteen races is 24% of
       frames inside 4u. That is most of the overlap handling: a stack of
       ink-ringed discs reads as cars in a queue, and when two of them are that
       close the median distance between the actual cars is 9 m. Displacing a
       mark further than it takes to keep that stack visible at all would be
       lying about a gap — see the floor below, which is the whole of the rest;
       stacking them into rows would buy the last few per cent for another row
       of plate height. */
    const list = [];
    for (const r of rows) {
      if (r.isPlayer) continue;
      const d = (r.s ?? 0) - sMe;
      list.push({
        d,
        x: axis(d, S.r + S.ink * 0.5),
        /* The car's own livery, by palette index, straight off the Car the
           classification already carries. RED for a field whose cars do not
           report one, which no field in this game does. */
        col: LIVERY[r.car ? r.car.palette : -1] || RED,
      });
    }
    list.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));

    /* The one case farthest-first cannot carry, and only that one.
     *
     * A mark's paint is a 4u core inside a 3u ink ring, so two marks within 3u
     * of each other leave the lower one with none of it: measured at 1600x900
     * the covered car keeps 0 of its 63 paint pixels, and the 60-odd an
     * ablation still credits it with are the antialiased rim it laid down
     * before the other composited over it. Drawing order decides WHICH car
     * disappears; it cannot stop one disappearing. And that is the elevation
     * card's 82% failure walking back in through the object built to escape it
     * — the strip does not distort the gap, it deletes the car.
     *
     * So marks closer than one mark radius are spread to exactly one mark
     * radius, which leaves the covered car half its paint: a crescent, which
     * is what it is — a car partly behind another car, exactly the queue the
     * note above claims a stack of ink-ringed discs already reads as. Nothing
     * else moves. Any pair further apart than 7u is untouched, so every gap
     * this strip draws wider than half a mark is the gap it drew before, and
     * the four cases in tools/hudparity.mjs land on the same pixels as they
     * did. Two properties keep the displacement honest: the mark NEAREST the
     * datum is the anchor and never moves, so the gap being raced stays exact;
     * and every push is outward from it, so a mark is only ever drawn further
     * from the player than it is. The strip cannot flatter a gap. At the datum
     * 7u is 3.4 m, and out where this fires it is the difference between a car
     * and nothing. */
    const MIN = S.r + S.ink * 0.5;
    const byX = list.slice().sort((a, b) => a.x - b.x);
    let anchor = 0;
    for (let i = 1; i < byX.length; i++) {
      if (Math.abs(byX[i].x - cx) < Math.abs(byX[anchor].x - cx)) anchor = i;
    }
    for (let i = anchor + 1; i < byX.length; i++) {
      byX[i].x = Math.max(byX[i].x, byX[i - 1].x + MIN);
    }
    for (let i = anchor - 1; i >= 0; i--) {
      byX[i].x = Math.min(byX[i].x, byX[i + 1].x - MIN);
    }
    for (const r of byX) r.x = clamp(r.x, cx - (S.half - MIN), cx + (S.half - MIN));

    for (const r of list) carDot(ctx, r.x, cy, S.r, r.col, S.ink);
  }

  _buildStrip() {
    const { u } = this.L, S = this.L.strip;
    const c = S.pad + S.half;
    this._strip = makeLayer(S.w + 8 * u, S.h + 8 * u, this.dpr, g => {
      g.fillStyle = SHADOW;
      chamfer(g, 4 * u, 5 * u, S.w, S.h, 8 * u); g.fill();
      g.fillStyle = CREAM;
      chamfer(g, 0, 0, S.w, S.h, 8 * u); g.fill();

      /* One quantised step, and it is doing a job rather than describing light:
         the bright band is ±RIV_NEAR metres, so the edge of the lit ground is a
         stated distance and the strip has a scale without carrying a single
         numeral. Clipped to the plate so the square ends cannot poke out
         through the chamfer, exactly as the results card's header is. */
      g.save();
      chamfer(g, 0, 0, S.w, S.h, 8 * u); g.clip();
      g.fillStyle = CREAM_DIM;
      const nx = S.half * RIV_NEAR / (RIV_NEAR + RIV_K);
      g.fillRect(0, 0, c - nx, S.h);
      g.fillRect(c + nx, 0, S.w - c - nx, S.h);
      g.restore();

      g.lineWidth = 3.5 * u; g.strokeStyle = INK;
      chamfer(g, 0, 0, S.w, S.h, 8 * u); g.stroke();

      /* The datum. A post narrower than the disc's own ink ring, so what stands
         above and below the player's car is a stem — the mark reads as a pin
         driven into the strip, and it survives a rival parking on top of it. */
      g.fillStyle = INK;
      g.fillRect(c - 2.5 * u, 7 * u, 5 * u, S.h - 14 * u);
      carDot(g, c, S.h / 2, S.r, LIVERY[0], S.ink);
    });
  }

  /* ---- timer and delta --------------------------------------------------- */

  _buildPlate() {
    const { u, timer } = this.L;
    timer.msSize = timer.size * 0.68;
    const tw = textWidth('88:88.', timer.size, 0.5) + textWidth('888', timer.msSize, 0.5);
    const pw = tw + 30 * u, ph = timer.size + 22 * u;
    this.L.timer.w = pw; this.L.timer.h = ph;
    this._plate = makeLayer(pw + 10 * u, ph + 10 * u, this.dpr, g => {
      g.fillStyle = SHADOW;
      chamfer(g, 4 * u, 5 * u, pw, ph, 9 * u); g.fill();
      g.fillStyle = CREAM;
      chamfer(g, 0, 0, pw, ph, 9 * u); g.fill();
      g.lineWidth = 3.5 * u; g.strokeStyle = INK; g.stroke();
      // A yellow spine on the left edge, so the plate is a tab and not a box.
      g.save();
      chamfer(g, 0, 0, pw, ph, 9 * u); g.clip();
      g.fillStyle = YELLOW;
      g.fillRect(0, 0, 9 * u, ph);
      g.restore();
      g.lineWidth = 3 * u;
      g.beginPath(); g.moveTo(9 * u, 2 * u); g.lineTo(9 * u, ph - 2 * u); g.stroke();
    });
  }

  _drawTimer(ctx) {
    const { u, w } = this, T = this.L.timer;
    const st = this.state;
    const x = (w - T.w) / 2, y = T.y;
    blit(ctx, this._plate, x, y);

    const t = Math.max(0, st.time);
    const mm = String(Math.floor(t / 60)).padStart(2, '0');
    const ss = String(Math.floor(t % 60)).padStart(2, '0');
    const ms = String(Math.floor((t % 1) * 1000)).padStart(3, '0');
    /* Milliseconds ride the same baseline but smaller and in a neutral tone:
       they are texture, not information, and red on this screen has to mean
       "behind" and nothing else. Fixed advances keep the seam still. */
    const head = mm + ':' + ss + '.';
    const tx = x + 20 * this.L.u, ty = y + 11 * this.L.u;
    drawText(ctx, head, tx, ty, T.size, { weight: 1.35 });
    drawText(ctx, ms, tx + textWidth(head, T.size), ty + (T.size - T.msSize), T.msSize,
      { color: INK_SOFT, weight: 1.3 });

    // Split. Positive means behind, and it stays honest about the sign.
    const showDelta = st.finished || (st.delta !== null && st.delta !== undefined);
    if (!showDelta) return;
    const uu = this.L.u;
    let txt, col, fg;
    if (st.finished) { txt = 'FINISH'; col = YELLOW; fg = INK; }
    else {
      const ahead = st.delta <= 0;
      txt = (ahead ? '-' : '+') + Math.abs(st.delta).toFixed(2);
      col = ahead ? GREEN : RED;
      fg = CREAM;
    }
    const ds = 19 * uu;
    const dw = textWidth(txt, ds, 0.7) + 24 * uu, dh = ds + 13 * uu;
    const dx = (this.w - dw) / 2, dy = y + T.h + 8 * uu;
    ctx.fillStyle = SHADOW;
    chamfer(ctx, dx + 3 * uu, dy + 4 * uu, dw, dh, 6 * uu); ctx.fill();
    ctx.fillStyle = col;
    chamfer(ctx, dx, dy, dw, dh, 6 * uu); ctx.fill();
    ctx.lineWidth = 3 * uu; ctx.strokeStyle = INK; ctx.stroke();
    drawText(ctx, txt, this.w / 2, dy + 6.5 * uu, ds,
      { align: 'center', color: fg, weight: 1.4, tracking: 0.7 });
  }

  /* ---- race position ------------------------------------------------------ */

  _drawPosition(ctx) {
    const st = this.state;
    const key = st.position + '/' + st.fieldSize;
    if (key !== this._badgeKey) { this._buildBadge(); this._badgeKey = key; }
    const { m, u } = this.L;
    const x = m, y = this.h - m - this._badge.h;
    const cue = this._positionAccent;
    /* The exact old path. Keeping it as an early return is what makes a
       dormant accent byte-identical instead of merely visually equivalent. */
    if (!cue) {
      blit(ctx, this._badge, x, y);
      return;
    }

    const gained = cue.direction === 'gained';
    const dir = gained ? -1 : 1;
    const attack = clamp(cue.t / 0.075, 0, 1);
    const fade = clamp((POSITION_ACCENT_SEC - cue.t) / 0.32, 0, 1);
    const alpha = attack * fade;
    const pop = Math.sin(Math.PI * clamp(cue.t / 0.27, 0, 1)) * fade;
    const baseAlpha = ctx.globalAlpha;

    /* Two small directional ticks, not a flash. The traffic strip already
       shows which car crossed which way; these only punctuate the badge whose
       numeral just changed. */
    ctx.save();
    ctx.globalAlpha = baseAlpha * alpha;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const cx = x + this._badge.w + 10 * u;
    const drift = dir * (1 - alpha) * 7 * u;
    for (let i = 0; i < 2; i++) {
      const cy = y + this._badge.h * 0.5 + drift - dir * i * 13 * u;
      const sx = 7 * u, sy = 5.5 * u;
      ctx.beginPath();
      ctx.moveTo(cx - sx, cy - dir * sy);
      ctx.lineTo(cx, cy + dir * sy);
      ctx.lineTo(cx + sx, cy - dir * sy);
      ctx.lineWidth = 5.5 * u;
      ctx.strokeStyle = INK;
      ctx.stroke();
      ctx.lineWidth = 2.4 * u;
      ctx.strokeStyle = gained ? YELLOW : RED;
      ctx.stroke();
    }
    ctx.restore();

    /* Reward lifts and pops; losing a place settles downward with half the
       scale. Both stay attached to the badge instead of moving the road. */
    ctx.save();
    const bx = x + this._badge.w * 0.5;
    const by = y + this._badge.h * 0.5;
    const scale = 1 + pop * (gained ? 0.065 : 0.032);
    ctx.translate(bx, by + dir * pop * (gained ? 3 : 2) * u);
    ctx.scale(scale, scale);
    blit(ctx, this._badge, -this._badge.w * 0.5, -this._badge.h * 0.5);
    ctx.restore();
  }

  _buildBadge() {
    const { u, pos } = this.L;
    const st = this.state;
    const num = String(st.position), suf = ordinal(st.position);
    const fld = '/' + st.fieldSize;
    const first = st.position === 1;

    /* One slab, two columns: the numeral, then suffix over field size. The
       field shares the numeral's baseline instead of dangling off the
       shoulder on its own tab, so the badge reads as a single mark. */
    const numW = textWidth(num, pos.numSize, 0.5);
    const fldS = 22 * u;
    const colW = Math.max(textWidth(suf, pos.sufSize, 0.6), textWidth(fld, fldS, 0.6));
    const H = pos.numSize + 26 * u;
    const W = 20 * u + numW + 9 * u + colW + 17 * u;
    const skew = 10 * u;

    this._badge = makeLayer(W + skew + 8 * u, H + 8 * u, this.dpr, g => {
      const slab = (ox, oy, fill) => {
        g.beginPath();
        g.moveTo(ox + skew, oy);
        g.lineTo(ox + W + skew, oy);
        g.lineTo(ox + W, oy + H);
        g.lineTo(ox, oy + H);
        g.closePath();
        g.fillStyle = fill;
        g.fill();
      };
      slab(4 * u, 5 * u, SHADOW);
      slab(0, 0, first ? YELLOW : RED);
      g.lineWidth = 4 * u; g.lineJoin = 'round'; g.strokeStyle = INK; g.stroke();

      // First place flips to the hot yellow, where cream digits would vanish.
      const fg = first ? INK : CREAM;
      const ol = first ? 0 : 2.6 * u;
      const colX = 20 * u + numW + 9 * u;
      drawText(g, num, 20 * u, 13 * u, pos.numSize,
        { color: fg, outline: ol, weight: 1.5, slant: 0.06 });
      drawText(g, suf, colX, 17 * u, pos.sufSize,
        { color: fg, outline: ol ? 2 * u : 0, weight: 1.4, slant: 0.06 });
      drawText(g, fld, colX, 13 * u + pos.numSize - fldS, fldS,
        { color: first ? INK : CREAM_DIM, weight: 1.3, slant: 0.06 });
    });
  }

  /* ---- the shell: title screen and pause menu ---------------------------- */

  /* Everything from here down is self-contained.
   *
   * It reads `this.L.u`, `this.w/h/dpr`, `this.profile` and `this.finishS`,
   * and it writes only its own two cached layers. It adds nothing to
   * `this.L`, so resize() is untouched and the layout metrics of the dial,
   * the elevation card, the traffic strip, the timer plate, the badge and the
   * results card cannot be reached from here at all — the layers below are
   * keyed on the size they were built at and rebuilt when it changes, exactly
   * as the position badge already keys itself on its own text.
   *
   * NO NEW COLOUR AND NO NEW LETTERFORM. Every fill on both screens is one of
   * the seven constants at the top of this file, every string is set in the
   * same vector type at the same weight ratios, and every plate is the same
   * chamfer, the same 3.5-5u ink and the same offset print shadow. Two things
   * on this HUD were recently caught saying the same thing in two colours, so
   * the reuse below is deliberate down to the individual mark: the title's
   * distance-and-drop chip is the elevation card's own header row, the pause
   * menu's selected item is the results card's own player row, and both
   * screens' instruction slabs are the results card's own PRESS R prompt.
   */

  /**
   * The title screen, over the game's own coast.
   *
   * A poster and not a menu, which is the whole argument for it. The game has
   * one asset worth putting on a title screen and it is the stage it
   * generates; anything drawn here competes with that, so what is drawn is
   * the four things a title screen owes the player and nothing else — what
   * the game is called, what kind of game it is, which stage this is, and how
   * to start. The camera move behind it is src/ui/title.js's.
   *
   * Set as ONE composition on ONE cached layer rather than three objects
   * placed near each other. The HUD's furniture is deliberately scattered to
   * the corners because a driver reads it in peripheral vision; a title is
   * read straight on, and the same scattering there is a screen with holes in
   * it. So the name, the stage chip and the prompt sit on one vertical axis
   * with the block's own margins, and the whole thing pops in as one object.
   */
  _drawTitle(ctx, t) {
    const key = `${this.w}x${this.h}@${this.dpr}|${t.seed}|${this.finishS}`;
    if (key !== this._titleKey) { this._buildTitle(t.seed); this._titleKey = key; }
    const L = this._title;
    /* Above centre for the countdown's reason: the horizon sits at about a
       third of the height, and a block centred on the canvas is a block on
       the car. How far above centre is measured rather than chosen, and the
       measurement is the whole story here. The earlier 0.40 was derived from
       a claimed car roof at 0.72 under this lens; the car's projected top is
       really 0.579–0.666 across seeds 22/1/40 over the title's whole 26 s
       lens cycle, because the cycle's height term stands the camera as low as
       5.30 m and a low lens lifts the car up the frame. 0.35 puts the
       poster's lower edge at 0.549, which clears the worst of those by 3.0%
       of the frame height — more than the 1.4% POP adds while the card is
       still landing — and straddles the horizon more nearly than 0.40 did. */
    ctx.save();
    ctx.globalAlpha = clamp(t.alpha, 0, 1);
    ctx.translate(this.w / 2, this.h * 0.35);
    ctx.scale(t.scale, t.scale);
    blit(ctx, L, -L.w / 2, -L.h / 2);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  _buildTitle(seed) {
    const u = this.L.u;
    /* Sized off the name, which is the widest thing here, rather than picked
       and then discovered to be wrong — the mistake this project keeps paying
       for in screen-space size. 96u is 0.133 of the short side, so the word
       is 830 device px across at 1600x900 and 664 at 1280x720, or a little
       over half the frame width at both. */
    const NAME = 'REDROCK';
    const nameSize = 84 * u;
    const weight = 1.35;
    const nameW = textWidth(NAME, nameSize, 0.5);
    /* The stroke, not the cell. Round caps at `weight` grid units plus an ink
       outline outside that put the mark most of a third of a cell past what
       textWidth reports; the countdown's plate had the G and the O hanging
       over both its edges before this was worked out. */
    const bleed = (weight * nameSize) / 12 + 5 * u;

    /* The eyebrow, and the gap under it is `bleed` and not a number.
       At a fixed 12u the first build had the R and the K of the name eating
       the bottom of DOWNHILL: the name's round caps and its 4.5u ink outline
       stand about fourteen grid units above the top of its own cell, which is
       more than the gap was. Deriving the gap from the same quantity that
       sizes the plate's own padding means the two cannot disagree again at
       another size or another weight. */
    const eyeSize = 20 * u, eyeGap = bleed + 5 * u;
    const padX = bleed + 26 * u, padY = bleed + 14 * u;
    const skew = 14 * u;                        // the badge's angle, scaled up
    const bw = nameW + padX * 2;
    const bh = eyeSize + eyeGap + nameSize + padY * 2;

    const chipH = 40 * u, chipGap = 15 * u;
    const promptSize = 21 * u;
    const promptH = promptSize + 16 * u, promptGap = 17 * u;

    /* The layer is the slab's own box plus the skew, the print shadow and the
       two objects hanging below it. Drawn from a local origin at the slab's
       top-left so every offset below reads as a position on the poster. */
    const W = bw + skew + 10 * u;
    const H = bh + chipGap + chipH + promptGap + promptH + 10 * u;

    const km = this.profile ? (this.finishS / 1000).toFixed(1) + 'KM' : '';
    let drop = 0;
    if (this.profile && this.profile.points && this.profile.points.length) {
      let lo = Infinity, hi = -Infinity;
      for (const p of this.profile.points) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); }
      drop = Math.max(0, hi - lo);
    }

    this._title = makeLayer(W, H, this.dpr, g => {
      /* The name, on the position badge's angled slab: the same parallelogram,
         the same offset print shadow, the same 4u ink, the same red. Red
         because the badge is red for every position but first and the
         countdown is red while it counts — on this palette red is the plate
         colour that carries a statement rather than a result, and the game is
         called REDROCK, so it is also the only colour the word can sit on
         without arguing with itself. */
      const slab = (ox, oy, fill) => {
        g.beginPath();
        g.moveTo(ox + skew, oy);
        g.lineTo(ox + bw + skew, oy);
        g.lineTo(ox + bw, oy + bh);
        g.lineTo(ox, oy + bh);
        g.closePath();
        g.fillStyle = fill;
        g.fill();
      };
      slab(4 * u, 5 * u, SHADOW);
      slab(0, 0, RED);
      g.lineWidth = 4 * u; g.lineJoin = 'round'; g.strokeStyle = INK; g.stroke();

      /* The eyebrow. Widely tracked small caps, which is the voice this HUD
         already uses for every label it has — KM/H on the dial face, 5.6KM on
         the stage card, FINISH on the results header. It says what kind of
         game this is in one word, and one word is all a title screen can
         spend on that. */
      drawText(g, 'DOWNHILL', skew * 0.5 + padX, padY, eyeSize,
        { color: CREAM, weight: 1.3, tracking: 2.2, slant: 0.06 });
      drawText(g, NAME, skew * 0.5 + padX, padY + eyeSize + eyeGap, nameSize,
        { color: CREAM, outline: 4.5 * u, weight, slant: 0.06 });

      /* The stage, on the elevation card's own header row.
         This is a quotation and not a lookalike: distance on the left in ink,
         total drop on the right in red behind the same red descent triangle,
         at the same 12u the card sets them at, on a plate with the card's
         chamfer and the card's 3.5u ink. A player who reaches the grid sees
         the same two numbers in the same two colours in the top-left corner,
         which is the point — the title is telling them what they are about to
         drive in the language the game will keep using. */
      const cy0 = bh + chipGap;
      const cw = bw;
      g.fillStyle = SHADOW;
      chamfer(g, 4 * u, cy0 + 5 * u, cw, chipH, 8 * u); g.fill();
      g.fillStyle = CREAM;
      chamfer(g, 0, cy0, cw, chipH, 8 * u); g.fill();
      g.lineWidth = 3.5 * u; g.strokeStyle = INK; g.stroke();

      const lab = 15 * u, labY = cy0 + (chipH - lab) / 2;
      const cpad = 18 * u;
      if (km) drawText(g, km, cpad, labY, lab, { weight: 1.3, tracking: 0.9 });
      const dTxt = Math.round(drop) + 'M';
      const dw = textWidth(dTxt, lab, 0.9);
      drawText(g, dTxt, cw - cpad, labY, lab,
        { align: 'right', color: RED, weight: 1.3, tracking: 0.9 });
      g.fillStyle = RED;
      g.beginPath();
      g.moveTo(cw - cpad - dw - 15 * u, labY + 2 * u);
      g.lineTo(cw - cpad - dw - 5 * u, labY + 2 * u);
      g.lineTo(cw - cpad - dw - 10 * u, labY + 12 * u);
      g.closePath();
      g.fill();
      /* Demoted, and centred between the two facts that are not. The stage is
         generated and the number is the only thing on the screen that says
         so; it is also the number a player quotes when they want this stage
         again, which is why it is here at all and why it is the quietest
         thing on the poster. INK_SOFT is the file's own demoted type, used
         for the timer's milliseconds and the results card's gap column. */
      drawText(g, 'SEED ' + seed, cw / 2, labY + (lab - lab * 0.82) / 2, lab * 0.82,
        { align: 'center', color: INK_SOFT, weight: 1.25, tracking: 1.1 });

      /* And the way in, on the results card's own furniture: an ink chamfer
         with cream tracked caps. Same object, same job — a small instruction
         pinned under a bigger statement — so the two screens that bracket a
         run are telling the player what to press in one voice.
         Both inputs, for the reason the card gives: the title is confirmed
         with Enter on the keyboard and south on a pad, and naming only the
         keyboard told a controller player to go and find one.
         STATIC, and not switched on whether a pad is connected, which is the
         nicer-sounding option. It was rejected on a measurement rather than
         on taste: the only thing hardware-dependent text buys is width, and
         width is not short here — this slab is 410.4u inside a 661.9u band
         (62.0%, against 66.4% for the shorter string it replaces) and the
         card's is 481.4u inside 560u (86.0%). Both ratios are constant across
         every size and dpr because slab, padding and type are all
         proportional to u. So the whole benefit is empty, and the cost is
         real: it would make what the HUD draws depend on what is plugged into
         the machine, which is the one thing a byte-parity gate cannot
         tolerate, and would oblige this element to go inert under
         Game.autopilot(true) the way the countdown, the ending and the
         overtake accents do. Paying that for nothing is the wrong trade.
         .fix/pk/slabfit.mjs has the table. */
      const py = cy0 + chipH + promptGap;
      const txt = 'ENTER OR A TO START';
      const pw = textWidth(txt, promptSize, 0.7) + 30 * u;
      const px = (cw - pw) / 2;
      g.fillStyle = SHADOW;
      chamfer(g, px + 3 * u, py + 4 * u, pw, promptH, 6 * u); g.fill();
      g.fillStyle = INK;
      chamfer(g, px, py, pw, promptH, 6 * u); g.fill();
      drawText(g, txt, cw / 2, py + 8 * u, promptSize,
        { align: 'center', color: CREAM, weight: 1.35, tracking: 0.7 });
    });
  }

  /**
   * The pause menu, over a frozen frame.
   *
   * Two objects: a flat ink wash over the whole canvas, and one plate.
   *
   * The wash is drawn HERE rather than by dropping the scene's exposure,
   * because while this is up the scene is not being rendered at all — see
   * Game.frame, and src/ui/pause.js, which owns the reason. So the only thing
   * that can hold the frozen frame back is the 2D layer over it, and a flat
   * wash is also the right mark for this look: the ink pass cannot find an
   * edge in a gradient and the quantised bands cannot resolve one, which is
   * the same argument main.js makes for PCF over PCFSoft.
   *
   * The plate is the results card with three rows and no columns, and the
   * selected row is the results card's highlighted player row — a yellow band
   * with ink type, chosen there because "a cream row on a cream plate
   * separated by colour alone disappears at this size", which is exactly as
   * true of a menu cursor. There is no separate cursor mark for the same
   * reason there is no numeral on a traffic-strip marker: it would restate
   * what the band already says at the cost of another object.
   */
  _drawPause(ctx, p) {
    const u = this.L.u;
    const items = p.items || [];
    const key = `${this.w}x${this.h}@${this.dpr}|${items.length}`;
    if (key !== this._pauseKey) { this._buildPause(items.length); this._pauseKey = key; }

    /* The wash, at full canvas and under everything else this method draws.
       INK and not black: this HUD's darkest value is a brown-black that sits
       in the same light as the cel shader's shadow tones, and a neutral black
       over a golden-hour frame reads as a screenshot with a filter on it. */
    ctx.save();
    ctx.globalAlpha = clamp(p.dim, 0, 1);
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.restore();

    const P = this._pauseL;
    const cx = this.w / 2, cy = this.h * 0.5;
    ctx.save();
    ctx.globalAlpha = clamp(p.alpha, 0, 1);
    ctx.translate(cx, cy);
    ctx.scale(p.scale, p.scale);
    const x0 = -P.w / 2, y0 = -P.h / 2;
    blit(ctx, this._pause, x0 - 5 * u, y0 - 5 * u);

    for (let i = 0; i < items.length; i++) {
      const ry = y0 + P.headH + i * P.rowH;
      const on = i === p.index;
      if (on) {
        ctx.fillStyle = YELLOW;
        ctx.fillRect(x0 + 4 * u, ry + 1 * u, P.w - 8 * u, P.rowH - 2 * u);
      }
      drawText(ctx, items[i], 0, ry + (P.rowH - P.size) / 2, P.size,
        { align: 'center', color: INK, weight: on ? 1.5 : 1.35, slant: 0.06,
          tracking: 1.1 });
    }
    ctx.restore();

    /* The key, under the plate on the prompt furniture, exactly as the results
       card puts PRESS R under the classification. Only Enter: this line used
       to carry Escape as well and came out 438u wide under a 320u plate — a
       hint wider than the thing it explains, which is not what the card does
       and reads as a caption that outgrew its picture. Escape needs no hint
       anyway. It is the key the player just pressed to get here, RESUME is
       what the cursor is already on, and a menu whose default action is the
       one the player wants nine times out of ten does not have to be read. */
    const txt = 'ENTER SELECT';
    const ps = 17 * u;
    const pw = textWidth(txt, ps, 0.7) + 26 * u, ph = ps + 13 * u;
    const px = cx - pw / 2, py = cy + P.h / 2 + 16 * u;
    ctx.save();
    ctx.globalAlpha = clamp(p.alpha, 0, 1);
    ctx.fillStyle = SHADOW;
    chamfer(ctx, px + 3 * u, py + 4 * u, pw, ph, 6 * u); ctx.fill();
    ctx.fillStyle = INK;
    chamfer(ctx, px, py, pw, ph, 6 * u); ctx.fill();
    drawText(ctx, txt, cx, py + 6.5 * u, ps,
      { align: 'center', color: CREAM, weight: 1.3, tracking: 0.7 });
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  _buildPause(nRows) {
    const u = this.L.u;
    /* Narrower than the results card's 560u because there is one column here
       and four there, and a plate sized for text it does not have is a plate
       with a hole in it. 360u sets the longest item — TO TITLE at 26u — with
       room to spare either side, and leaves the prompt slab below it inset by
       the same proportion the card's prompt is inset. */
    const P = { w: 360 * u, rowH: 46 * u, headH: 44 * u, pad: 16 * u, size: 26 * u };
    P.h = P.headH + nRows * P.rowH + P.pad;
    this._pauseL = P;
    const cw = P.w, ch = P.h;
    this._pause = makeLayer(cw + 10 * u, ch + 10 * u, this.dpr, g => {
      g.translate(5 * u, 5 * u);
      g.fillStyle = SHADOW;
      chamfer(g, 4 * u, 5 * u, cw, ch, 10 * u); g.fill();
      g.fillStyle = CREAM;
      chamfer(g, 0, 0, cw, ch, 10 * u); g.fill();

      g.save();
      chamfer(g, 0, 0, cw, ch, 10 * u); g.clip();
      /* INK and not the results card's green-or-red, because those two mean
         won and lost and a pause means neither. Cream on ink is this file's
         existing voice for an instruction rather than a result — it is the
         delta chip's structure and the PRESS R slab's exactly — so the header
         says what kind of object this is before a word of it is read. */
      g.fillStyle = INK;
      g.fillRect(0, 0, cw, P.headH);
      // The timer plate's yellow spine, so this is the same family of object.
      g.fillStyle = YELLOW;
      g.fillRect(0, P.headH, 9 * u, ch - P.headH);
      // One quantised step across the foot, exactly as the dial face and the
      // results card each carry one. Flat cream reads as paper, not as print.
      g.fillStyle = CREAM_DIM;
      g.fillRect(0, ch - P.pad, cw, P.pad);
      g.restore();

      g.lineWidth = 4 * u; g.strokeStyle = INK;
      chamfer(g, 0, 0, cw, ch, 10 * u); g.stroke();
      g.lineWidth = 3 * u;
      g.beginPath(); g.moveTo(0, P.headH); g.lineTo(cw, P.headH); g.stroke();

      const hs = 22 * u;
      drawText(g, 'PAUSED', cw / 2, (P.headH - hs) / 2, hs,
        { align: 'center', color: CREAM, weight: 1.5, slant: 0.06, tracking: 1.4 });

      // Hairlines between rows, a step below the ink, as on the results card.
      g.lineWidth = 1.6 * u; g.strokeStyle = CREAM_DIM;
      for (let i = 1; i < nRows; i++) {
        const y = P.headH + i * P.rowH;
        g.beginPath(); g.moveTo(12 * u, y); g.lineTo(cw - 12 * u, y); g.stroke();
      }
    });
  }
}
