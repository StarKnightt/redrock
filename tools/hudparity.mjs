/* No-op proof for the one approved edit to src/ui/hud.js.
 *
 * The HUD was fenced for this pass and the countdown was allowed through it.
 * The claim to be proved is the same one the render/outline.js exception had
 * to prove: with no countdown running, every pixel the HUD draws is the pixel
 * it drew before — not "looks the same", byte for byte.
 *
 * So the page (tools/hudparity.html) instantiates BOTH classes: the shipping
 * one and a copy of the file as it was, kept in .work/base/hud-before.js.
 * Both are handed the same course, resized identically, settled from a cold
 * needle spring by the same fixed number of fixed-length steps — the spring is
 * the only state in the HUD that remembers anything — and read back. Two
 * builds in one process, so there is nothing to line up between runs and no
 * clock anywhere in the comparison.
 *
 * The second half is each overlay itself, measured rather than admired: the
 * same frame with and without it, differenced, and the bounding box of what
 * changed reported in device pixels. Screen-space size is the thing this
 * project keeps getting wrong. The countdown, the results card, the traffic
 * strip and — since the shell landed — the title screen and the pause menu.
 *
 * The two shell screens also carry a dormancy column, which is the claim the
 * whole tools/ directory is downstream of: drawn twice from one state they are
 * byte-identical, so no tool here can photograph one of them mid-animation.
 *
 *   node tools/hudparity.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import './tame.mjs';
import { serve } from './harness.mjs';
import { guard, finish } from './tame.mjs';
import { checkAsync } from './check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'shots', 'countdown');

/* The baseline is a file, not a memory. Say so plainly if it is gone, rather
   than letting the page fail on a 404 for an import nobody will recognise.
 *
 * THE BASELINE HAS BEEN ROLLED FORWARD ONCE, and this is the only time it has
 * moved. It was hud.js as it stood before the countdown was added, and against
 * that reference the countdown, the traffic strip, the title screen and the
 * pause menu were each proved a pixel no-op — 0 differing bytes, which is the
 * whole reason this tool exists. The player-colour fix then changed the
 * elevation card's marker disc from #f0b429 to LIVERY[0] #ff5a24, and _drawMap
 * runs on every frame, so a visible change there MUST move all 20 racing-state
 * hashes. That is not a regression and it cannot be avoided: the gate and the
 * fix are structurally incompatible.
 *
 * Rather than leave a gate that reports 20 failures forever — which the next
 * reader would eventually "fix" by reverting the colour — the baseline is now
 * the tree as it stood after that change. The pre-countdown reference is kept
 * beside it as hud-pre-countdown.js and nothing else was rolled. The evidence
 * that the move was confined to the marker disc is in .fix/HUD-THREE-DEFECTS.md:
 * every changed pixel in all 20 states lies inside a box no larger than the
 * disc, and the harness's own worst byte of 90 is |0xb4 - 0x5a|, the green
 * channel of exactly that substitution.
 *
 * So 0 differing bytes means what it has always meant, and if you are reading
 * this because the gate is red, it is red about your edit. */
const BASE = path.join(ROOT, '.work', 'base', 'hud-before.js');
if (!fs.existsSync(BASE)) {
  console.error(`\n  no baseline at .work/base/hud-before.js\n`
    + `  It is src/ui/hud.js as it stood after the player-colour fix —\n`
    + `  the same arrangement as .work/base/outline.js.bak. Without it there\n`
    + `  is nothing to compare against and this tool cannot prove anything.\n`);
  process.exit(2);
}

/* Every state the HUD has a branch for: the grid, mid-race behind, leading,
   and the finish plate. If the edit could reach any of them it reaches one of
   these. */
const STATES = {
  grid: { speed: 0, rpm: 0.06, gear: 0, position: 1, fieldSize: 4, time: 0, progress: 0, delta: null, finished: false },
  behind: { speed: 143 / 3.6, rpm: 0.72, gear: 3, position: 2, fieldSize: 4, time: 154.327, progress: 0.5, delta: 1.2, finished: false },
  ahead: { speed: 186 / 3.6, rpm: 0.93, gear: 5, position: 1, fieldSize: 4, time: 297.481, progress: 0.94, delta: -0.85, finished: false },
  done: { speed: 12, rpm: 0.2, gear: 2, position: 3, fieldSize: 4, time: 331.02, progress: 1, delta: 0.4, finished: true },
};

const SIZES = [
  [1600, 900, 1], [1920, 1080, 1], [1280, 720, 1],
  [2560, 1080, 1], [1280, 720, 2],
];

const bad = await checkAsync();
if (bad.length) {
  console.error('✗ parse errors — not launching a browser:\n' + bad.join('\n'));
  finish(1);
}

fs.mkdirSync(outDir, { recursive: true });

const srv = serve();
await new Promise(r => srv.listen(0, r));
const url = `http://localhost:${srv.address().port}/tools/hudparity.html`;

const browser = guard(await chromium.launch({ headless: true }));
guard(srv);

const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
page.on('pageerror', e => errs.push('[pageerror] ' + (e.stack || e.message || e)));
page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });

console.log(`→ ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__parity, null, { timeout: 20_000 });

console.log('\n  HUD with no countdown running — shipping vs baseline copy');
console.log('   size            state    differing bytes   hash (both builds)');
let dirty = 0;
for (const [w, h, dpr] of SIZES) {
  for (const key of Object.keys(STATES)) {
    const r = await page.evaluate(([w, h, dpr, st]) => window.__parity.compare(w, h, dpr, st),
      [w, h, dpr, STATES[key]]);
    const same = r.diff === 0 && r.hash === r.hashBefore;
    if (!same) dirty++;
    console.log(`   ${`${w}x${h}@${dpr}`.padEnd(15)} ${key.padEnd(8)} `
      + `${String(r.diff).padStart(15)}   ${r.hash}`
      + `${same ? '' : '  ✗ ' + r.hashBefore + ` worst byte ${r.worst}`}`);
  }
}
console.log(dirty
  ? `\n  ✗ ${dirty} state(s) differ — the HUD is NOT unchanged`
  : '\n  ✓ every state identical, all four million bytes of each');

/* And the countdown, on. Sizes in device pixels, which is what the eye gets. */
console.log('\n  the countdown itself, differenced against the same frame without it');
console.log('   size            label   changed px       bounding box (device px)');
/* Sampled from the sequence itself: mid-count, the biggest frame of the GO
   pop, and GO settled. */
const SHOW = [['3-settled', 0.5], ['GO-pop', 3.05], ['GO', 3.4]];
for (const [w, h, dpr] of [[1600, 900, 1], [1280, 720, 1], [1280, 720, 2]]) {
  for (const [name, at] of SHOW) {
    const r = await page.evaluate(([w, h, dpr, st, at]) => {
      const cd = window.__parity.at(at);
      return window.__parity.countdown(w, h, dpr, st, cd);
    }, [w, h, dpr, STATES.grid, at]);
    console.log(`   ${`${w}x${h}@${dpr}`.padEnd(15)} ${name.padEnd(10)} ${String(r.px).padStart(9)}`
      + (r.box ? `   x${r.box[0]} y${r.box[1]}  ${r.box[2]} x ${r.box[3]} px`
        : '   NOTHING DRAWN'));
    if (w === 1600 && dpr === 1) {
      const file = path.join(outDir, `hud-${name}.png`);
      fs.writeFileSync(file, Buffer.from(r.png.split(',')[1], 'base64'));
    }
  }
}

/* And the results card. Same treatment, same reason: the project's standing
   complaint is mechanisms that are correct in simulation and three pixels tall
   in frame, so the card states its own size before anyone admires it. */
console.log('\n  the results card itself, differenced against the same frame with only the dim');
console.log('   size            label   changed px       bounding box (device px)');
/* A four-car classification with the player second — the common case, and the
   one with both a highlighted row and a gap column in play. */
const ROWS = [
  { pos: 1, name: 'COBALT', time: 190.14, gap: 0, isPlayer: false, finished: true },
  { pos: 2, name: 'PLAYER', time: 191.01, gap: 0.87, isPlayer: true, finished: true },
  { pos: 3, name: 'OCHRE', time: 191.52, gap: 1.38, isPlayer: false, finished: true },
  { pos: 4, name: 'SAGE', time: 191.74, gap: 1.61, isPlayer: false, finished: true },
];
const CARD_AT = [['card-in', 2.1], ['card', 3.2]];
for (const [w, h, dpr] of [[1600, 900, 1], [1280, 720, 1], [1280, 720, 2]]) {
  for (const [name, at] of CARD_AT) {
    const r = await page.evaluate(([w, h, dpr, st, at, rows]) => {
      const end = window.__parity.endingAt(at, rows, false);
      return window.__parity.ending(w, h, dpr, st, end);
    }, [w, h, dpr, STATES.done, at, ROWS]);
    console.log(`   ${`${w}x${h}@${dpr}`.padEnd(15)} ${name.padEnd(10)} ${String(r.px).padStart(9)}`
      + (r.box ? `   x${r.box[0]} y${r.box[1]}  ${r.box[2]} x ${r.box[3]} px`
        + `  = ${((r.box[2] * r.box[3]) / (r.W * r.H) * 100).toFixed(1)}% of frame`
        : '   NOTHING DRAWN'));
    if (w === 1600 && dpr === 1) {
      fs.writeFileSync(path.join(outDir, `hud-${name}.png`),
        Buffer.from(r.png.split(',')[1], 'base64'));
    }
  }
}

/* And the two shell screens, at every supported size.
 *
 * These are the states the countdown's dormancy rule exists for, so both are
 * asked at the only moment a tool ever sees them: settled, entrance finished,
 * nothing in motion. The `twice` column is the load-bearing one — it redraws
 * from the identical state and counts differing bytes, so a non-zero there
 * means the screen reads a clock and every capture tool in this directory is
 * downstream of it.
 *
 * Each is differenced against its own backdrop with the same state held at
 * alpha 0 — not against the racing HUD. Differencing the title against the
 * HUD measures the union of two screens, because draw() returns early on a
 * live title and the whole instrument cluster leaves at the same moment the
 * poster arrives; the box that comes out is the frame, which is true and
 * says nothing. Holding alpha at 0 leaves the backdrop identical in both
 * frames and isolates the thing being sized. */
console.log('\n  the shell screens, differenced against the same frame without them');
console.log('   size            state       changed px  stray    bounding box (device px)'
  + '        box / u   twice');
let shellBad = 0;
for (const [w, h, dpr] of SIZES) {
  const u = (Math.min(w, h) / 720) * dpr;
  for (const name of ['title', 'pause']) {
    const r = await page.evaluate(([w, h, dpr, st, name]) => {
      const P = window.__parity;
      /* 7 s in and 0.5 s in: both well past an entrance the player can see
         and neither anywhere near one, which is the point. */
      const key = name === 'title' ? 'title' : 'pause';
      const on = name === 'title' ? P.titleAt(7) : P.pauseAt(0.5, 1);
      return P.overlay(w, h, dpr, st,
        { [key]: { ...on, alpha: 0 } }, { [key]: on });
    }, [w, h, dpr, name === 'title' ? STATES.grid : STATES.behind, name]);
    if (r.repeat) shellBad++;
    const b = r.box;
    console.log(`   ${`${w}x${h}@${dpr}`.padEnd(15)} ${name.padEnd(11)} ${String(r.px).padStart(9)}`
      + `${String(r.stray).padStart(7)}   `
      + (b ? `x${String(b[0]).padStart(4)} y${String(b[1]).padStart(4)}  `
        + `${String(b[2]).padStart(4)} x ${String(b[3]).padStart(4)}` : 'NOTHING DRAWN'.padEnd(24))
      + (b ? `   ${`${(b[2] / u).toFixed(0)} x ${(b[3] / u).toFixed(0)}`.padStart(11)}u` : ''.padEnd(14))
      + `   ${r.repeat ? '✗ ' + r.repeat + ' bytes' : 'same'}`);
    if (w === 1600 && dpr === 1) {
      fs.writeFileSync(path.join(outDir, `hud-${name}.png`),
        Buffer.from(r.png.split(',')[1], 'base64'));
    }
  }
}
console.log(shellBad
  ? `\n  ✗ ${shellBad} shell state(s) redraw differently from one state — NOT dormant`
  : '\n  ✓ both shell screens redraw byte-identical from one state at all five sizes');

/* And the traffic strip. Same treatment, same reason. Four scenarios, each a
   real state the strip has to be legible in rather than a flattering one: the
   grid, where the reversed formation puts all three rivals ahead and inside
   twenty metres; a rival on the player's bumper with the other two gone; the
   field strung out over most of a kilometre; and the closing run, where the
   flag has left the rim. Gaps are the metres in the third column. */
const CAR = p => ({ palette: p });
const FIELD = {
  grid: [0.006073, [['COBALT', 1, 20], ['OCHRE', 2, 13.5], ['SAGE', 3, 7]]],
  chased: [0.5, [['COBALT', 1, 180], ['OCHRE', 2, 520], ['SAGE', 3, -14]]],
  spread: [0.5, [['COBALT', 1, 610], ['OCHRE', 2, 37], ['SAGE', 3, -260]]],
  flag: [0.965, [['COBALT', 1, 22], ['OCHRE', 2, -45], ['SAGE', 3, -330]]],
};
console.log('\n  the traffic strip itself, differenced against the same frame with rivals null');
console.log('   size            case      changed px       bounding box (device px)');
/* Every case at the capture resolution, and one case — `spread`, which has a
   rival in the near, middle and far field at once — at every other supported
   size, since the question there is only how big a marker is and not what it is
   doing. 2560x1440 is in for being the largest u the game ships at. */
const stripRows = [];
for (const [w, h, dpr] of [...SIZES, [2560, 1440, 1]]) {
  const only = w === 1600 && h === 900 && dpr === 1 ? null : 'spread';
  for (const key of Object.keys(FIELD)) {
    if (only && key !== only) continue;
    const [progress, cars] = FIELD[key];
    const rows = [
      ...cars.map(([name, pal, ds], i) => ({
        position: i + 1, name, isPlayer: false, finished: false,
        car: CAR(pal), s: progress * 5598 + ds,
      })),
      { position: 4, name: 'PLAYER', isPlayer: true, finished: false, car: CAR(0), s: progress * 5598 },
    ];
    const r = await page.evaluate(([w, h, dpr, st, rows]) =>
      window.__parity.rivals(w, h, dpr, st, rows),
      [w, h, dpr, { ...STATES.behind, progress }, rows]);
    console.log(`   ${`${w}x${h}@${dpr}`.padEnd(15)} ${key.padEnd(9)} ${String(r.px).padStart(9)}`
      + (r.box ? `   x${r.box[0]} y${r.box[1]}  ${r.box[2]} x ${r.box[3]} px` : '   NOTHING DRAWN'));
    for (const e of r.each) {
      console.log(`     ${e.name.padEnd(8)} Δs ${String(e.ds).padStart(5)} m`
        + `   ${String(e.px).padStart(5)} px   ${e.w} x ${e.h} px`
        + `   at x${e.x}`);
    }
    if (w === 1600 && dpr === 1) {
      fs.writeFileSync(path.join(outDir, `hud-rivals-${key}.png`),
        Buffer.from(r.png.split(',')[1], 'base64'));
    }
    stripRows.push({ size: `${w}x${h}@${dpr}`, key, ...r, png: undefined });
  }
}

/* And the chequered bar on the strip, which only exists inside the last 400 m
   (src/ui/hud.js RIV_FLAG). Measured at 399 m against 401 m with every gap held
   equal, so on the strip the bar is the only difference. `elsewhere` is what
   moved outside the strip's plate: the 2 m of progress also slides the
   elevation card's own dot, which is why the `outside` control row — both
   frames above the cut-off — is there. It reports the same count with no bar,
   so none of it is the bar. */
console.log('\n  the strip\'s finish bar, straddling its cut-off at 400 m');
console.log('   size            bar px    bounding box (device px)   elsewhere');
for (const [w, h, dpr] of [[1600, 900, 1], [1280, 720, 1], [1280, 720, 2]]) {
  for (const [name, left] of [['inside', 399], ['outside', 401]]) {
    const r = await page.evaluate(([w, h, dpr, st, gaps, left, len]) =>
      window.__parity.flagbar(w, h, dpr, st, gaps, left, len),
      [w, h, dpr, STATES.ahead, [['COBALT', 1, 22], ['OCHRE', 2, -45], ['SAGE', 3, -330]],
        left, 5598]);
    console.log(`   ${`${w}x${h}@${dpr}`.padEnd(15)} ${name.padEnd(8)} ${String(r.px).padStart(5)}`
      + (r.box ? `   x${r.box[0]} y${r.box[1]}  ${r.box[2]} x ${r.box[3]} px` : '   NOTHING DRAWN')
      + `${String(r.outside).padStart(12)}`);
  }
}

/* Cost. The HUD redraws over a 60 fps scene, so the question is what the extra
   branch costs on the 99.9% of frames where there is no countdown. */
const cost = await page.evaluate(() => {
  const hud = window.__parity.huds.now;
  const before = window.__parity.huds.before;
  const st = { speed: 40, rpm: 0.7, gear: 3, position: 2, fieldSize: 4, time: 154.327, progress: 0.5, delta: 1.2, finished: false };
  const cd = { ...st, countdown: { text: 'GO', go: true, scale: 1.2, alpha: 1 } };
  const rows = [
    { pos: 1, name: 'COBALT', time: 190.14, gap: 0, isPlayer: false, finished: true },
    { pos: 2, name: 'PLAYER', time: 191.01, gap: 0.87, isPlayer: true, finished: true },
    { pos: 3, name: 'OCHRE', time: 191.52, gap: 1.38, isPlayer: false, finished: true },
    { pos: 4, name: 'SAGE', time: 191.74, gap: 1.61, isPlayer: false, finished: true },
  ];
  const cardState = { ...st, ending: {
    rows, won: false, alpha: 1, scale: 1, dim: 0.55, prompt: 1 } };
  /* The MINIMUM over interleaved rounds, not the mean of one run.
   *
   * Everything Chromium is doing here is pinned to idle priority on four cores
   * (tools/harness.mjs), so a single 400-frame mean carries enough scheduler
   * noise to swamp what is being measured: consecutive runs of the identical
   * state came out at 0.017 and 0.097 ms, and the first version of this reported
   * the traffic strip as costing MINUS 0.020 ms, which is not a number. Every
   * error in a wall-clock timing is upward — a round can be interrupted, never
   * accelerated — so the minimum is the only estimator of the three that noise
   * cannot drag off the true cost. Rounds are interleaved across the states by
   * the caller so a thermal or scheduling drift cannot land on one of them. */
  const ROUNDS = 7, N = 250;
  const best = new Map();
  const round = (key, h, s) => {
    h.resize(1600, 900, 1);
    for (let i = 0; i < 40; i++) { h.update(1 / 60, s); h.draw(); }
    const t0 = performance.now();
    for (let i = 0; i < N; i++) { h.update(1 / 60, s); h.draw(); }
    const ms = (performance.now() - t0) / N;
    if (!(best.get(key) <= ms)) best.set(key, ms);
  };
  const field = [
    { position: 1, name: 'COBALT', isPlayer: false, finished: false, car: { palette: 1 }, s: 2799 + 180 },
    { position: 2, name: 'OCHRE', isPlayer: false, finished: false, car: { palette: 2 }, s: 2799 + 37 },
    { position: 3, name: 'PLAYER', isPlayer: true, finished: false, car: { palette: 0 }, s: 2799 },
    { position: 4, name: 'SAGE', isPlayer: false, finished: false, car: { palette: 3 }, s: 2799 - 260 },
  ];
  /* The strip is measured warm: the layer is built on the first frame that has a
     field and blitted on every one after, exactly like the elevation card, so
     the steady-state cost is one blit plus three discs and ten squares. Cold —
     the layer thrown away every frame — is the one-off a resize pays, once. */
  /* The two shell screens are here for the same reason the countdown is: they
     are the only two states in the file that draw a full-canvas fill, and a
     full-canvas fill is the one thing in Canvas 2D that costs real money.
   *
   * Every case below states the WHOLE slate, and that is a fix rather than a
   * flourish. Hud.update is an Object.assign, so an overlay left live by one
   * case was still live in the next: the rounds are interleaved, `carding`
   * ran straight after `counting`, and what used to be reported as the cost
   * of the results card was the cost of the card with GO still on top of it —
   * `rivals` carried both. Adding the title made that fatal instead of merely
   * wrong, because a live title makes draw() return before it draws anything
   * and the whole table collapsed to a microsecond a frame. */
  const CLEAR = { countdown: null, ending: null, title: null, pause: null, rivals: null };
  const only = extra => ({ ...st, ...CLEAR, ...extra });
  const cases = [
    ['before', before, st],
    ['now', hud, only({})],
    ['counting', hud, only({ countdown: cd.countdown })],
    ['carding', hud, only({ ending: cardState.ending })],
    ['rivals', hud, only({ rivals: field })],
    ['titling', hud, only({ title: window.__parity.titleAt(7) })],
    ['pausing', hud, only({ pause: window.__parity.pauseAt(0.5, 0) })],
  ];
  for (let r = 0; r < ROUNDS; r++) for (const [k, h, s] of cases) round(k, h, s);
  for (let r = 0; r < ROUNDS; r++) {
    hud.resize(1600, 900, 1);
    const s = { ...st, ...CLEAR, rivals: field };
    for (let i = 0; i < 40; i++) { hud.update(1 / 60, s); hud.draw(); }
    const t0 = performance.now();
    for (let i = 0; i < N; i++) { hud._strip = null; hud.update(1 / 60, s); hud.draw(); }
    const ms = (performance.now() - t0) / N;
    if (!(best.get('rivalsCold') <= ms)) best.set('rivalsCold', ms);
  }
  return Object.fromEntries(best);
});
console.log('\n  per-frame update+draw at 1600x900');
console.log(`    baseline build               ${cost.before.toFixed(3)} ms`);
console.log(`    shipping, nothing running    ${cost.now.toFixed(3)} ms`);
console.log(`    shipping, GO on screen       ${cost.counting.toFixed(3)} ms`);
console.log(`    shipping, results card up    ${cost.carding.toFixed(3)} ms`);
console.log(`    shipping, rivals on strip    ${cost.rivals.toFixed(3)} ms`
  + `   (+${(cost.rivals - cost.now).toFixed(3)} ms over no field)`);
console.log(`    ditto, strip layer rebuilt   ${cost.rivalsCold.toFixed(3)} ms`
  + `   (the one-off a resize pays, once)`);
console.log(`    shipping, title up           ${cost.titling.toFixed(3)} ms`);
console.log(`    shipping, pause menu up      ${cost.pausing.toFixed(3)} ms`);

if (errs.length) {
  console.log('\n─── page errors ───');
  [...new Set(errs)].forEach(e => console.log(' ', e));
}
console.log(`\n  → shots/countdown`);
if (dirty || shellBad || errs.length) process.exitCode = 1;
finish(process.exitCode || 0);
