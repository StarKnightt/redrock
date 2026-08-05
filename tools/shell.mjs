/* The two shell screens, photographed and measured.
 *
 * `capture` in tools/harness.mjs reads the GL canvas back on its own, which is
 * the right instrument for the world and the wrong one for these two: a title
 * screen is a composition of the world AND the 2D overlay over it, and half of
 * it would be missing. So this uses page.screenshot(), which takes what the
 * compositor has — both canvases, as the player sees them.
 *
 * What is measured, and why each number is here:
 *
 *   INKED BOX, in device pixels, off the HUD canvas alone. Screen-space size
 *   is the thing this project keeps getting wrong — a mechanism that is
 *   correct in simulation and three pixels tall in frame — so both screens
 *   state their own size before anybody admires them.
 *
 *   THE SAME BOX DIVIDED BY u, at five size and DPR combinations. Everything
 *   in ui/hud.js is authored in u = min(w,h)/720 so that the furniture is the
 *   same size at 720p, 1440p and dpr 2; a layout that is not actually in u
 *   reports a different quotient at each size, and that is the only way to
 *   catch it apart from looking at five screenshots side by side.
 *
 *   DETERMINISM. Both screens drawn twice from the same state and hashed. A
 *   HUD that does not hash the same twice cannot be photographed by anything.
 *
 *   node tools/shell.mjs [--seeds 22,1,40]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, settleBoot } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'shots', 'shell');
fs.mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');

/* Where in the title's own 26-second cycle to stand. Three phases of the lens
   move: the start of it, a quarter in where the lateral swing is at full
   deflection, and half way. If the move can put the camera anywhere it should
   not be, it is at one of these. */
/* Every one of these is past the poster's own 0.55 s arrival, so what is
   photographed is the settled card and the only thing changing between them
   is the lens. A phase of zero would report a card at alpha zero, which is
   nothing at all — the first run of this tool did exactly that and reported
   the racing HUD's bounding box for the title screen. */
const PHASES = [['t1', 1.0], ['t7', 7.5], ['t14', 14]];

const SIZES = [[1600, 900], [1920, 1080], [1280, 720], [2560, 1080]];

/* Everything the HUD canvas has ink on, in device pixels. The HUD is cleared
   to transparent every frame, so alpha alone is the mask and there is nothing
   to difference against. */
const INKBOX = () => {
  const c = window.__game.hud.canvas;
  const g = c.getContext('2d');
  const { data } = g.getImageData(0, 0, c.width, c.height);
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, px = 0;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (data[(y * c.width + x) * 4 + 3] < 8) continue;
      px++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return { W: c.width, H: c.height, px,
    box: px ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null };
};

/* FNV over the HUD canvas, twice, from one state. The same function
   tools/hudparity.html uses, so the two tools agree about what "identical"
   means. */
const TWICE = () => {
  const hud = window.__game.hud;
  const c = hud.canvas, g = c.getContext('2d');
  const fnv = a => {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < a.length; i++) {
      h1 ^= a[i]; h1 = Math.imul(h1, 0x01000193);
      h2 = Math.imul(h2 ^ a[i], 0x85ebca6b);
    }
    return (h1 >>> 0).toString(16).padStart(8, '0')
      + (h2 >>> 0).toString(16).padStart(8, '0');
  };
  hud.draw();
  const a = fnv(g.getImageData(0, 0, c.width, c.height).data);
  hud.draw();
  const b = fnv(g.getImageData(0, 0, c.width, c.height).data);
  return { a, b, same: a === b };
};

/** Put the title up and step it to an exact phase, from a known start. */
const TITLE_AT = ([sec]) => {
  const g = window.__game;
  g.setPaused(true);
  /* From the top, and not from wherever the loop got to between begin() and
     this call. How far the browser took to boot is not a property of the
     title screen, and a probe that inherits it measures a different frame
     every run — the defect tools/zjdet.mjs was written to chase down. */
  g.restart();
  g.toTitle();
  for (let i = 0; i < Math.round(sec * 60); i++) g.step(1 / 60);
  g.renderOnce();
  g.hud.draw();
  return { t: +g.title.t.toFixed(4), u: Math.min(innerWidth, innerHeight) / 720 };
};

/**
 * Drive into the stage, then open the menu and settle it.
 *
 * Opened through `Game.openPause`, which is the method the key edge calls,
 * and NOT by setting `input.pausePressed` — that was the first version of
 * this and it silently did nothing, which is worth writing down because it is
 * the dormancy argument arriving as a measurement. `Game.step` calls
 * `Input.update` before it looks at anything, and `Input.update` recomputes
 * every edge flag from the key set and the pad; the flags are derived, not
 * stored, so a caller that writes one has it overwritten on the next line.
 * A tool cannot forge its way into this menu even deliberately.
 */
const PAUSE_AT = ([index]) => {
  const g = window.__game;
  g.setPaused(true);
  g.restart();
  g.autopilot(true, 0.85);
  for (let i = 0; i < 60 * 22; i++) g.step(1 / 60);
  g.autopilot(false);
  g.pause.enabled = true;
  g.openPause();
  for (let i = 0; i < index; i++) g.pause.move(1);
  // Settled: past the 0.12 s arrival, so this is the steady plate.
  for (let i = 0; i < 30; i++) g.step(1 / 60);
  g.renderOnce();
  g.hud.draw();
  return { active: g.pause.active, index: g.pause.index,
    u: Math.min(innerWidth, innerHeight) / 720 };
};

/**
 * The pause plate and its prompt alone, with the wash held equal on both
 * sides.
 *
 * The same trick tools/hudparity.html's `ending()` uses and for the same
 * reason: the menu also washes the whole canvas, so a naive difference
 * reports every pixel on the screen — which is true and useless. Holding
 * `dim` and differencing only `alpha` leaves the plate.
 */
const PLATE_BOX = () => {
  const g = window.__game, hud = g.hud;
  const c = hud.canvas, ctx = c.getContext('2d');
  const p = g.pause.display();
  hud.update(0, { pause: { ...p, alpha: 0 } });
  hud.draw();
  const off = ctx.getImageData(0, 0, c.width, c.height).data;
  hud.update(0, { pause: p });
  hud.draw();
  const on = ctx.getImageData(0, 0, c.width, c.height).data;

  /* Histograms rather than a running min/max. A bounding box takes its four
     numbers from four single pixels, so one stray pixel anywhere moves it —
     and there is a stray: compositing the plate flips one antialiased pixel
     on the speedometer's left tangent by 21/1020, far outside the menu.
     Requiring two changed pixels in a row or column before that row or column
     counts discards isolated rasteriser wobble and keeps every real edge,
     which is ink hundreds of pixels long. `stray` reports what was dropped so
     this can never quietly hide a second, larger thing. */
  const rowN = new Int32Array(c.height), colN = new Int32Array(c.width);
  let px = 0;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      let d = 0;
      for (let k = 0; k < 4; k++) d += Math.abs(off[i + k] - on[i + k]);
      if (d < 8) continue;
      px++; rowN[y]++; colN[x]++;
    }
  }
  const span = (a) => {
    let lo = -1, hi = -1;
    for (let i = 0; i < a.length; i++) if (a[i] >= 2) { if (lo < 0) lo = i; hi = i; }
    return [lo, hi];
  };
  const [x0, x1] = span(colN), [y0, y1] = span(rowN);
  let kept = 0;
  for (let y = y0; y <= y1 && y0 >= 0; y++) kept += rowN[y];
  return { W: c.width, H: c.height, px, stray: px - kept,
    box: x0 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1] };
};

let bad = 0;
const rows = [];

for (const seed of SEEDS) {
  for (const [w, h] of (seed === SEEDS[0] ? SIZES : [SIZES[0]])) {
    await run({ width: w, height: h, hash: `manual&tier=high&seed=${seed}&cap=0` },
      async ({ page }) => {
        const wide = w === 1600 && seed === SEEDS[0];
        for (const [name, sec] of PHASES) {
          // Only the first phase at the extra sizes and seeds; the question
          // there is the layout's scaling, not the camera's path.
          if (!wide && name !== PHASES[0][0]) continue;
          const info = await page.evaluate(TITLE_AT, [sec]);
          const box = await page.evaluate(INKBOX);
          const det = await page.evaluate(TWICE);
          if (!det.same) bad++;
          rows.push({ what: 'title', seed, w, h, name, ...info, ...box, det });
          /* At the shutter, not at the top of the page, and that placement is
             the whole economy of it. Every shot here is composited, so the boot
             veil is in frame until it has faded (see harness.settleBoot) — but
             INKBOX and TWICE above have just walked several million pixels, so
             by here the fade has almost always finished on its own and this
             costs one round trip. Asked for at the top of the body it waits the
             full 1.3–1.6 s on all six pages instead. Cheap, and no longer luck. */
          await settleBoot(page);
          await page.screenshot({
            path: path.join(OUT, `title-s${seed}-${w}x${h}-${name}.png`) });
        }
        const info = await page.evaluate(PAUSE_AT, [wide ? 0 : 1]);
        const det = await page.evaluate(TWICE);
        if (!det.same) bad++;
        await settleBoot(page);
        await page.screenshot({ path: path.join(OUT, `pause-s${seed}-${w}x${h}.png`) });
        /* The whole canvas first — which for a menu with a full-frame wash on
           it is the whole canvas, and that is the correct answer to "how much
           of the screen does a pause take". Then the plate on its own. */
        const all = await page.evaluate(INKBOX);
        rows.push({ what: 'wash', seed, w, h, name: 'i' + info.index, ...info, ...all, det });
        const plate = await page.evaluate(PLATE_BOX);
        rows.push({ what: 'pause', seed, w, h, name: 'i' + info.index, ...info, ...plate, det });
      });
  }
}

console.log('\n  what   seed  size          phase   inked px    bounding box (device px)'
  + '        box / u        same twice');
for (const r of rows) {
  const b = r.box;
  const perU = b ? `${(b[2] / r.u).toFixed(0)} x ${(b[3] / r.u).toFixed(0)}` : '-';
  console.log(`  ${r.what.padEnd(6)} ${String(r.seed).padStart(3)}   `
    + `${`${r.w}x${r.h}`.padEnd(12)} ${r.name.padEnd(6)} ${String(r.px).padStart(9)}   `
    + (b ? `x${String(b[0]).padStart(4)} y${String(b[1]).padStart(4)}  `
      + `${String(b[2]).padStart(4)} x ${String(b[3]).padStart(4)}` : 'NOTHING DRAWN'.padEnd(24))
    + `   ${perU.padStart(11)}u   ${r.det.same ? 'yes' : 'NO ✗'}`);
}

/* The u check, stated as a verdict rather than left for the reader to do in
   their head. Every row of one screen should report the same box/u to within
   a rounding pixel; a screen whose layout is not really in u drifts. */
console.log('');
for (const what of ['title', 'pause']) {
  const set = rows.filter(r => r.what === what && r.box && r.seed === SEEDS[0]);
  if (set.length < 2) continue;
  const ws = set.map(r => r.box[2] / r.u), hs = set.map(r => r.box[3] / r.u);
  const spread = a => Math.max(...a) - Math.min(...a);
  const ok = spread(ws) < 2 && spread(hs) < 2;
  if (!ok) bad++;
  console.log(`  ${what} layout across ${set.length} sizes: `
    + `width ${Math.min(...ws).toFixed(1)}–${Math.max(...ws).toFixed(1)}u, `
    + `height ${Math.min(...hs).toFixed(1)}–${Math.max(...hs).toFixed(1)}u  `
    + `${ok ? '✓ one layout' : '✗ NOT scale-invariant'}`);
}

/* And what the two screens cost the triangle budget, which the brief asked for
   with a ceiling of 260,000 and a build sitting near it.
 *
 * Both are Canvas 2D on the overlay and neither constructs a THREE object, so
 * the expected answer is a flat zero — but "a 2D overlay costs nothing" is
 * exactly the kind of claim this project asks to see measured rather than
 * asserted, and there is a real way it could have been false: the title needed
 * a camera somewhere the game never otherwise puts one, and a lens pointed
 * across the bay pulls whatever is out there into the frustum. So the walk is
 * the whole scene graph, which culling cannot flatter.
 *
 * Each screen is compared against a control STEPPED THE SAME NUMBER OF FRAMES,
 * which took two goes to get right. The first version compared a paused world
 * against a freshly restarted one and duly reported the pause menu as adding
 * 588 triangles and three meshes; those three meshes are the effects pool,
 * which allocates lazily over the first second of any race whether or not
 * anybody opens a menu. The title needs no such control — stepTitle steps
 * nothing, so its world is bit-for-bit the one restart() left.
 *
 * renderer.info is deliberately not used. The pipeline is multi-pass and the
 * counter reports only what the last pass drew, which is a one-triangle
 * fullscreen composite; asked for the cost of a title screen it answers 1. */
const GEOM = () => {
  const g = window.__game;
  const walk = () => {
    let tri = 0, meshes = 0;
    g.scene.traverse(o => {
      const geo = o.geometry;
      if (!geo || !o.isMesh) return;
      meshes++;
      const n = geo.index ? geo.index.count : (geo.attributes.position?.count || 0);
      tri += (n / 3) * (o.isInstancedMesh ? o.count : 1);
    });
    return { tri: Math.round(tri), meshes };
  };
  const step = n => { for (let i = 0; i < n; i++) g.step(1 / 60); };
  const LEAD = 60;

  g.restart();                          // the grid, no shell: the title's control
  const grid = walk();

  g.title.arm();
  step(60 * 7);
  const title = walk();
  g.title.skip();

  g.restart();                          // stepped but never paused: the menu's control
  step(LEAD);
  const running = walk();

  g.restart();
  step(LEAD);
  g.pause.enabled = true;
  g.openPause();
  step(30);
  const paused = walk();
  g.closePause();

  return { grid, title, running, paused };
};

/* Does the title's type ever land on the car?
 *
 * The composition the title camera was built for puts the poster in the top
 * third and the car in the lower one, and src/ui/title.js says so in a comment
 * with two numbers in it. A comment with numbers in it is a claim, so this
 * checks it: the car's roof is projected through the title's own camera to a
 * screen fraction, the poster's box comes off the HUD canvas, and the gap
 * between them is reported per seed. The road's pitch under the grid is
 * seed-dependent and the camera is a fixed offset on the road frame, so this
 * is the one thing in the title that a new stage could plausibly break.
 *
 * SAMPLE THE PHASE THAT MATTERS, NOT A CONVENIENT ONE. The first version of
 * this took one sample at t=7.5 s and passed a build whose poster overlapped
 * the car on two of the three seeds. The title lens is a 26-second cycle whose
 * height term swings CAM_RISE either side of CAM_HIGH, and a LOW lens lifts
 * the car UP the frame towards the poster — 3.1% of frame height per metre,
 * measured. At t=7.5 the lens happens to be near its nominal height, so the
 * sample flattered the layout by 1.8 points of frame height: it read -0.2% on
 * seed 40 where the truth over the whole cycle was -2.0%, and +0.3% on seed 22
 * where the truth was -1.5%. The caller below now finds the extremes of the
 * cycle first and measures at both. */
const COMPOSE = ([sec]) => {
  const g = window.__game, T = g.THREE;
  /* Loud, because the quiet version of this failure is a measurement of the
     PREVIOUS measurement. Everything below depends on the step loop having run:
     the camera pose comes from `titleCamera()` and the poster from the payload
     `Hud.update` is handed, and both are per-step. Asked for a phase that
     rounds to zero steps this function would return the last frame's numbers
     under the new phase's label, and a gate that reports a stale frame as a
     fresh one is worse than no gate. Also past the card's 0.55 s arrival. */
  if (!(sec >= 1)) throw new Error(`COMPOSE needs sec >= 1, got ${sec}`);
  g.restart();
  g.title.arm();
  for (let i = 0; i < Math.round(sec * 60); i++) g.step(1 / 60);

  /* Render and draw once before reading anything. Nothing in `manual` runs the
     rAF loop, so without this the HUD canvas is still empty and the camera's
     world matrix is whatever it was before titleCamera moved it — the first
     version of this read both and got an empty poster band and a car projected
     to a single degenerate point. */
  g.renderOnce();
  g.hud.draw();

  /* The car's own bounding box, in world space, through the live camera —
     not an estimate off its position. The roof is the top of the box. */
  g.scene.updateMatrixWorld(true);
  const box = new T.Box3().setFromObject(g.playerView.root);
  const cam = g.camera;
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  let top = 1, bottom = 0;
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        const v = new T.Vector3(x, y, z).project(cam);
        const f = (1 - v.y) / 2;               // 0 at the top of the frame
        top = Math.min(top, f); bottom = Math.max(bottom, f);
      }
    }
  }

  const c = g.hud.canvas, ctx = c.getContext('2d');
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let y0 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) {
    let n = 0;
    for (let x = 0; x < c.width; x++) if (data[(y * c.width + x) * 4 + 3] > 8) n++;
    if (n >= 2) { if (y0 < 0) y0 = y; y1 = y; }
  }
  return { carTop: top, carBottom: bottom, high: g.title.station().high,
    inkTop: y0 / c.height, inkBottom: y1 / c.height };
};

/**
 * The two phases of the lens cycle that bracket everything the cycle can do.
 *
 * SEARCHED, not written down. The obvious version of this is `[0, 13]` with a
 * comment saying 13 is half of the 26-second period — and it rots silently the
 * moment anyone retunes CAM_PERIOD_WALL, leaving a gate that still passes while
 * sampling the wrong two frames. `station()` is a pure function of the title's
 * own clock and costs nothing to call, so the extremes are found by asking it
 * rather than by reading title.js. Scanned to 60 s at 0.25 s, which covers any
 * period anybody would plausibly give a title screen.
 *
 * Height is the whole story and lateral swing is not: the two quarter-cycle
 * points where `lat` is at +CAM_SWING and -CAM_SWING report the same gap to a
 * tenth of a percent, because a metre sideways over tarmac does not change
 * where the car's roof lands but a metre of height does.
 *
 * THE SCAN STARTS AT 1 s AND NOT AT 0, and the first version of this did not,
 * which cost a run. The lens is highest at phase 0, so an unconstrained search
 * returns t=0 — and COMPOSE at t=0 steps the game zero times, which means
 * `titleCamera()` never runs and `Hud.update` is never called, so the frame
 * still holds the camera pose and the HUD payload of the PREVIOUS measurement.
 * The gate duly printed the low-lens row twice under two different labels and
 * one of them was a fabrication. A cycle repeats, so the same phase is
 * available a whole period later where there is something to step; asking for
 * t >= 1 finds it there and is also past the poster's own 0.55 s arrival, which
 * is the constraint PHASES above documents for exactly the same reason.
 */
const LENS_EXTREMES = () => {
  const t = window.__game.title;
  const keep = t.t;
  let lo = { t: 0, high: Infinity }, hi = { t: 0, high: -Infinity };
  for (let s = 1; s <= 60; s += 0.25) {
    t.t = s;
    const h = t.station().high;
    if (h < lo.high) lo = { t: s, high: h };
    if (h > hi.high) hi = { t: s, high: h };
  }
  t.t = keep;
  return { lo, hi };
};

/* A page per seed. The stage is built from the seed at construction, so a seed
   is a page load and not an assignment — the first version of this set
   `game.seed` between rows and surveyed one stage three times. */
console.log('\n  the title\'s composition: does the type ever land on the car?');
console.log('   seed   lens phase        poster band      car in frame     gap');
{
  /* Both ends of the lens cycle per seed. The low one is the verdict; the high
     one is printed with it so the reader can see how much of the margin is the
     camera breathing, which is the fact a single sample hid. */
  const PER_SEED = 2;
  let worst = Infinity, got = 0;
  for (const seed of SEEDS) {
    await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${seed}&cap=0` },
      async ({ page }) => {
        const ex = await page.evaluate(LENS_EXTREMES);
        for (const [label, p] of [['lowest', ex.lo], ['highest', ex.hi]]) {
          const r = await page.evaluate(COMPOSE, [p.t]);
          got++;
          const gap = r.carTop - r.inkBottom;
          worst = Math.min(worst, gap);
          console.log(`   ${String(seed).padStart(4)}   ${label.padEnd(7)}`
            + `${r.high.toFixed(2)}m t${String(p.t).padEnd(5)} `
            + `${r.inkTop.toFixed(3)}–${r.inkBottom.toFixed(3)}    `
            + `${r.carTop.toFixed(3)}–${r.carBottom.toFixed(3)}    `
            + `${(gap >= 0 ? '+' : '') + (gap * 100).toFixed(1)}% of frame height`);
        }
      });
  }
  /* `got` is not decoration, and the expected count is a constant rather than
     something counted alongside it. The first run of this asked a Box3 for the
     bounds of a car VIEW rather than its root Object3D, threw on all three
     seeds, and then reported a pass — because the worst gap over an empty set
     is Infinity and Infinity is greater than zero. A probe that measured
     nothing has to say so louder than a probe that measured something bad. */
  const want = SEEDS.length * PER_SEED;
  const ok = got === want && got > 0 && worst > 0;
  if (!ok) bad++;
  console.log(`\n   ${ok ? '✓' : '✗'} ${got}/${want} frames measured`
    + ` across ${SEEDS.length} seeds and both ends of the lens cycle; `
    + (got ? `the poster clears the car by ${(worst * 100).toFixed(1)}%`
      + ` of the frame height at worst — they `
      + `${worst > 0 ? 'never share a pixel' : 'OVERLAP'}`
      : 'NOTHING MEASURED — the numbers below mean nothing'));
}

/* Is the wash dark enough, on the brightest frame the game can produce?
 *
 * The pause plate is cream type on a cream ground floating over a frozen
 * golden-hour frame, and the only thing separating the two is one flat ink
 * wash. That is a legibility claim with a number in it, so here is the number.
 *
 * The wash is an ordinary sRGB alpha composite of a known colour at a known
 * alpha, so the washed value of any pixel can be computed exactly rather than
 * screenshotted and guessed at: out = INK*a + px*(1-a). What cannot be guessed
 * is which pixel is the worst case, so this reads the actual framebuffer at
 * points along the stage — including the two that matter, a lens pointed up
 * into the sky dome and one pointed at the sun side of it — and takes the
 * BRIGHTEST pixel in the whole frame, which is a harder test than the plate
 * really faces since the plate only has to clear its own surroundings.
 *
 * Two thresholds, because there are two different jobs here and the first
 * version of this tool applied the wrong one to both and duly failed a wash
 * that is fine.
 *
 *   THE PLATE'S EDGE against the washed world is a non-text boundary, and the
 *   threshold for those is 3:1 (WCAG SC 1.4.11). It is what the wash is for.
 *
 *   THE TYPE inside the plate is text, and its threshold is 4.5:1 — but the
 *   wash has nothing to do with it. Every word on this plate sits on the
 *   plate's own cream, ink or yellow, so those ratios are properties of the
 *   palette and hold on every frame of every seed. They are reported anyway,
 *   because "cream type over a golden frame" is a fair thing to worry about
 *   and the answer is that it never happens: no glyph is ever drawn over the
 *   world. */
const WASH = ([alpha]) => {
  const g = window.__game;
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const INK = hex('#241812'), CREAM = hex('#f4e6c5'), YELLOW = hex('#f0b429');
  const lin = c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, gg, b]) => 0.2126 * lin(r) + 0.7152 * lin(gg) + 0.0722 * lin(b);
  const ratio = (a, b) => {
    const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
    return (hi + 0.05) / (lo + 0.05);
  };
  const wash = px => px.map((c, i) => INK[i] * alpha + c * (1 - alpha));

  const gl = g.renderer.domElement;
  const c2 = document.createElement('canvas');
  c2.width = gl.width; c2.height = gl.height;
  const ctx = c2.getContext('2d');

  const out = [];
  for (const at of [0.02, 0.25, 0.5, 0.75, 0.97]) {
    g.goTo(at);
    /* Read in the SAME task as the render: the drawing buffer is not
       preserved and is gone by the next one — see capture() in harness.mjs. */
    g.renderOnce();
    ctx.drawImage(gl, 0, 0);
    const d = ctx.getImageData(0, 0, c2.width, c2.height).data;
    let best = null, bl = -1;
    for (let i = 0; i < d.length; i += 4) {
      const px = [d[i], d[i + 1], d[i + 2]];
      const l = lum(px);
      if (l > bl) { bl = l; best = px; }
    }
    out.push({ at, bright: best, washed: wash(best).map(Math.round),
      edge: ratio(CREAM, wash(best)), ink: ratio(INK, wash(best)) });
  }
  return { out, type: {
    'header, cream on ink': ratio(CREAM, INK),
    'item, ink on cream': ratio(INK, CREAM),
    'selected item, ink on yellow': ratio(INK, YELLOW),
    'prompt, cream on ink': ratio(CREAM, INK),
  } };
};

console.log('\n  the pause wash, against the brightest pixel the game can produce');
await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEEDS[0]}&cap=0` },
  async ({ page }) => {
    const r = await page.evaluate(WASH, [0.55]);
    console.log('   along stage   brightest pixel   washed at 0.55'
      + '   plate edge   its ink outline');
    let worst = Infinity, worstInk = Infinity;
    for (const s of r.out) {
      worst = Math.min(worst, s.edge);
      worstInk = Math.min(worstInk, s.ink);
      const rgb = a => a.map(v => String(Math.round(v)).padStart(3)).join(',');
      console.log(`   ${(s.at * 100).toFixed(0).padStart(9)}%   ${rgb(s.bright)}`
        + `       ${rgb(s.washed)}      ${s.edge.toFixed(2)}:1`
        + `        ${s.ink.toFixed(2)}:1`);
    }
    const ok = worst >= 3;
    if (!ok) bad++;
    console.log(`\n   ${ok ? '✓' : '✗'} the plate's edge is worst case ${worst.toFixed(2)}:1 against`
      + ` the washed world, and its ink outline ${worstInk.toFixed(2)}:1 —`
      + ` ${ok ? 'clears' : 'FAILS'} the 3:1 non-text boundary threshold`);
    console.log('   and the type, which never touches the world at all:');
    let worstType = Infinity;
    for (const [k, v] of Object.entries(r.type)) {
      worstType = Math.min(worstType, v);
      console.log(`     ${k.padEnd(30)} ${v.toFixed(1)}:1`);
    }
    if (worstType < 4.5) bad++;
    console.log(`   ${worstType >= 4.5 ? '✓' : '✗'} worst ${worstType.toFixed(1)}:1`
      + ` against the 4.5:1 small-text threshold`);
  });

console.log('\n  what the shell costs the 260,000 triangle budget');
await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEEDS[0]}&cap=0` },
  async ({ page }) => {
    const r = await page.evaluate(GEOM);
    const AGAINST = { title: 'grid', paused: 'running' };
    console.log('   state      meshes   scene-graph tri     vs its control');
    for (const [k, v] of Object.entries(r)) {
      const base = r[AGAINST[k]];
      const d = base ? [v.tri - base.tri, v.meshes - base.meshes] : null;
      console.log(`   ${k.padEnd(10)} ${String(v.meshes).padStart(6)}   ${String(v.tri).padStart(14)}`
        + (d ? `     ${(d[0] >= 0 ? '+' : '') + d[0]} tri, ${(d[1] >= 0 ? '+' : '') + d[1]}`
          + ` meshes   (vs ${AGAINST[k]})` : '     —'));
    }
    const flat = r.title.tri === r.grid.tri && r.paused.tri === r.running.tri
      && r.title.meshes === r.grid.meshes && r.paused.meshes === r.running.meshes;
    if (!flat) bad++;
    console.log(`\n   ${flat ? '✓' : '✗'} the shell adds `
      + `${flat ? 'no geometry at all — 0 of the 260,000' : 'GEOMETRY — see the deltas above'}`
      + `; both screens are Canvas 2D on the overlay`);
  });

console.log(`\n  → shots/shell`);
/* Every `bad++` above except the got/want guard at the composition section sits
   inside a run() callback, and run() does not call its callback when the page
   throws during boot. `bad` therefore cannot see a page that never loaded — but
   run() raises process.exitCode when that happens, so carrying it here rather
   than passing a bare 0 closes the gap for the sections that have no count
   guard of their own. Raise, never lower. */
finish(bad ? 1 : (process.exitCode || 0));
