/* The traffic strip in the frame it ships in, at native resolution.
 *
 * Everything the strip claims is a claim about one race, so this drives one:
 * restart, autopilot, fixed 1/60 steps, and a capture on the first frame that
 * satisfies each condition it is looking for. No frame is synthesised and no
 * gap is dialled in — the Δs values printed beside each crop are whatever the
 * field was doing when the predicate fired, read off Race.standings(), which is
 * the same array the HUD is drawing from.
 *
 * Three things this is careful about:
 *
 *   restart() first. A probe that steps from wherever the page's own loop left
 *   the car inherits the browser's start time as a hidden parameter, which is
 *   the leak tools/zjdet.mjs was written to catch. The player is on the grid on
 *   frame 0 of every run of this.
 *
 *   The clock is pinned around each capture and frame 0 is discarded, because
 *   environment.js drives a shader uniform from performance.now() and two
 *   renders of one paused state are otherwise two different images.
 *
 *   Crops are cut out of the composited frame at 1:1, no resampling, from the
 *   HUD's own layout numbers — g.hud.L.map and g.hud.L.strip — so what lands on
 *   disk is the device pixels the panel gets. A 3x nearest-neighbour blow-up is
 *   written alongside each, for looking at, and is labelled as one.
 *
 *   node tools/zrshot.mjs [--seed 22] [--skill 0.85] [--secs 260]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const SKILL = +flag('skill', '0.85');
const SECS = +flag('secs', '300');
const outDir = path.join(ROOT, 'shots', 'zrshot');
fs.mkdirSync(outDir, { recursive: true });

let res = null;
await run({
  width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(900_000);

  res = await page.evaluate(([skill, secs]) => {
    const g = window.__game;
    const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
    const gl = g.renderer.getContext();
    g.setPaused(true);
    g.restart();
    /* autopilot() skips the countdown and the ending, so frame 0 is the grid
       with the field released — the state the strip has to be right in from the
       first frame, since the player now starts last and all three rivals are up
       the road. */
    g.autopilot(true, skill);

    const shots = [];
    const trace = [];

    const grab = () => {
      const px = new Uint8Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };

    /* One capture: the GL buffer with the HUD composited over it, plus two
       crops cut from it at 1:1. Bottom-up readback is flipped by drawing the
       renderer's canvas rather than the pixel array — the array is only used
       for the ablation below, where orientation does not matter. */
    const shoot = (label) => {
      const real = performance.now.bind(performance);
      const pinned = real();
      performance.now = () => pinned;
      g.renderOnce();                       // frame 0, discarded
      g.renderOnce();
      g.hud.draw();
      performance.now = real;

      const full = document.createElement('canvas');
      full.width = W; full.height = H;
      const fx = full.getContext('2d');
      fx.drawImage(g.renderer.domElement, 0, 0);
      fx.drawImage(g.hud.canvas, 0, 0, W, H);

      /* The HUD is laid out in CSS px at its own dpr and composited to W x H,
         so one HUD unit is this many frame pixels. At 1600x900 dpr 1 it is 1. */
      const k = W / g.hud.w;
      const L = g.hud.L, u = L.u;
      const cut = (x0, y0, x1, y1) => {
        const sx = Math.round(x0 * k), sy = Math.round(y0 * k);
        const sw = Math.round(x1 * k) - sx, sh = Math.round(y1 * k) - sy;
        const c = document.createElement('canvas');
        c.width = sw; c.height = sh;
        c.getContext('2d').drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
        const z = document.createElement('canvas');
        z.width = sw * 3; z.height = sh * 3;
        const zx = z.getContext('2d');
        zx.imageSmoothingEnabled = false;
        zx.drawImage(c, 0, 0, sw * 3, sh * 3);
        return { png: c.toDataURL('image/png'), zoom: z.toDataURL('image/png'), w: sw, h: sh };
      };
      const card = cut(L.map.x - 6 * u, L.map.y - 6 * u,
        L.map.x + L.map.w + 10 * u, L.strip.y + L.strip.h + 10 * u);
      const strip = cut(L.strip.x - 6 * u, L.strip.y - 6 * u,
        L.strip.x + L.strip.w + 10 * u, L.strip.y + L.strip.h + 10 * u);

      /* Where the marks actually are, measured, not computed: the HUD is drawn
         again with the field withheld and the two canvases differenced, then
         once per rival with that one car withheld. This is the same ablation
         hudparity.mjs runs on synthetic states, done here on the real one. */
      const hc = g.hud.canvas, hw = hc.width, hh = hc.height;
      const hx = hc.getContext('2d');
      const snap = () => hx.getImageData(0, 0, hw, hh).data;
      const rows = g.hud.state.rivals;
      const A = snap();
      const box = (a, b) => {
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
        for (let i = 0, p = 0; i < a.length; i += 4, p++) {
          if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i + 1] - b[i + 1]) > 6
            || Math.abs(a[i + 2] - b[i + 2]) > 6 || Math.abs(a[i + 3] - b[i + 3]) > 6) {
            n++;
            const x = p % hw, y = (p / hw) | 0;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
        return n ? { n, x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null;
      };
      const st = { ...g.hud.state };
      g.hud.update(0, { ...st, rivals: null }); g.hud.draw();
      const none = snap();
      const plate = box(A, none);
      const each = [];
      for (const r of rows) {
        if (r.isPlayer) continue;
        g.hud.update(0, { ...st, rivals: rows.filter(x => x !== r) });
        g.hud.draw();
        const b = box(A, snap());
        each.push({
          name: r.name, pal: r.car ? r.car.palette : -1,
          ds: +(r.s - g.player.s).toFixed(1),
          px: b ? b.n : 0, w: b ? b.w : 0, h: b ? b.h : 0, x: b ? b.x0 : null,
        });
      }
      g.hud.update(0, st); g.hud.draw();

      shots.push({
        label, card, strip, plate, each,
        t: +g.player.raceTime.toFixed(2),
        s: +g.player.s.toFixed(1),
        left: +(g.track.length - g.player.s).toFixed(1),
        pos: g.race.positionOf(g.player), field: g.race.fieldSize,
        kmh: Math.round(g.player.speed * 3.6),
        full: label === 'behind' || label === 'spread' ? full.toDataURL('image/png') : null,
      });
    };

    /* What to look for. Each fires once, on the first frame it is true, and the
       gaps are read from the sim rather than chosen. `d` is signed metres: > 0
       is a rival up the road. */
    const want = [
      ['grid', () => true],
      ['launch', (t) => t > 2.5],
      ['spread', (t, d) => t > 30 && Math.max(...d.map(Math.abs)) > 300],
      ['wide', (t, d) => t > 30 && Math.max(...d.map(Math.abs)) > 600],
      ['behind', (t, d) => t > 15 && d.some(v => v < 0 && v > -22)],
      ['sandwich', (t, d) => t > 15 && d.some(v => v > 0 && v < 60) && d.some(v => v < 0 && v > -60)],
      /* Two shots of the closing run: one with the line still outside the range
         the relative axis can say anything useful about, one inside it. */
      ['runin', (t, d, left) => left < 900],
      ['flag', (t, d, left) => left < 260],
    ];
    const done = new Set();

    /* An overtake, caught as it happens: the frame a rival's gap changes sign,
       then one second and two and a half seconds later. Three frames is enough
       to say whether the disc crossing the datum reads as a pass. */
    let prev = null, seq = null;

    const gaps = () => {
      const rows = g.race.standings();
      return rows.filter(r => !r.isPlayer).map(r => r.s - g.player.s);
    };

    const N = Math.round(secs * 60);
    for (let f = 0; f < N; f++) {
      /* Stepped first, always. The HUD's state is written by the game's own
         update inside step(), so a capture taken before the first step would be
         of a HUD that has never been told anything — including that there is a
         field. `grid` is therefore one frame off the line, not zero, which is
         the first frame that exists as far as the HUD is concerned. */
      g.step(1 / 60);
      const t = g.player.raceTime;
      const d = gaps();
      const left = g.track.length - g.player.s;
      if (f % 30 === 0) {
        trace.push([+t.toFixed(1), +left.toFixed(1), ...d.map(v => +v.toFixed(1))]);
      }
      for (const [label, ok] of want) {
        if (done.has(label)) continue;
        if (ok(t, d, left)) { done.add(label); shoot(label); }
      }
      /* The pass itself. Only the first one, and only a rival the player goes
         past — a rival passing the player is the same event mirrored and the
         crop would say the same thing. */
      if (seq) {
        if (f >= seq.at[0]) { shoot(seq.names[0]); seq.at.shift(); seq.names.shift(); }
        if (!seq.at.length) seq = null;
      } else if (prev && !done.has('pass')) {
        for (let i = 0; i < d.length; i++) {
          if (prev[i] > 0 && d[i] <= 0) {
            done.add('pass');
            shoot('pass-0');
            seq = { at: [f + 60, f + 150], names: ['pass-1s', 'pass-2.5s'] };
            break;
          }
        }
      }
      prev = d;
      if (g.player.finished) break;
    }

    return {
      shots, trace,
      finishedAt: +g.player.raceTime.toFixed(2),
      pos: g.race.positionOf(g.player),
      standings: g.race.standings().map(r => ({
        p: r.position, name: r.name, s: +r.s.toFixed(1),
      })),
      layout: {
        u: g.hud.L.u, dpr: g.hud.dpr, k: W / g.hud.w,
        strip: Object.fromEntries(Object.entries(g.hud.L.strip)
          .map(([a, b]) => [a, +(+b).toFixed(2)])),
      },
    };
  }, [SKILL, SECS]);
});

if (!res) finish(1);

const write = (file, dataUrl) =>
  fs.writeFileSync(path.join(outDir, file), Buffer.from(dataUrl.split(',')[1], 'base64'));

const L = res.layout;
console.log(`\n  seed ${SEED}, skill ${SKILL}, 1600x900 dpr ${L.dpr}`
  + `  —  1 HUD unit = ${L.k} frame px`);
console.log(`  strip plate ${(L.strip.w * L.k).toFixed(0)} x ${(L.strip.h * L.k).toFixed(0)} px`
  + ` at (${(L.strip.x * L.k).toFixed(0)}, ${(L.strip.y * L.k).toFixed(0)})`
  + `,  half-axis ${(L.strip.half * L.k).toFixed(1)} px`
  + `,  disc r ${(L.strip.r * L.k).toFixed(2)} px + ${(L.strip.ink * L.k).toFixed(2)} px ink`);
console.log(`  player finished ${res.finishedAt}s in P${res.pos}`);

console.log('\n  captures — gaps are metres of arc, signed, + is up the road');
for (const s of res.shots) {
  write(`${s.label}.png`, s.card.png);
  write(`${s.label}-x3.png`, s.card.zoom);
  write(`${s.label}-strip.png`, s.strip.png);
  write(`${s.label}-strip-x3.png`, s.strip.zoom);
  if (s.full) write(`${s.label}-frame.png`, s.full);
  console.log(`\n   ${s.label.padEnd(10)} t=${String(s.t).padStart(6)}s`
    + `  s=${String(s.s).padStart(6)}m  ${String(s.left).padStart(6)}m to go`
    + `  P${s.pos}/${s.field}  ${String(s.kmh).padStart(3)} km/h`);
  console.log(`     crops  card ${s.card.w} x ${s.card.h} px`
    + `   strip ${s.strip.w} x ${s.strip.h} px`
    + `   plate footprint ${s.plate ? `${s.plate.w} x ${s.plate.h} px, ${s.plate.n} px changed` : 'NOTHING DRAWN'}`);
  for (const e of s.each) {
    console.log(`     ${e.name.padEnd(7)} pal ${e.pal}  Δs ${String(e.ds).padStart(7)} m`
      + `   ${String(e.px).padStart(4)} px   ${e.w} x ${e.h} px at x${e.x}`
      + (e.px ? '' : '   NOT DRAWN'));
  }
}

/* What the gaps did over the whole race, so the shots above can be read as
   samples of something rather than as four lucky frames. */
const all = res.trace.flatMap(r => r.slice(2).map(Math.abs));
all.sort((a, b) => a - b);
const q = p => all[Math.min(all.length - 1, Math.floor(p * all.length))];
console.log(`\n  gap census — ${res.trace.length} half-second samples x 3 rivals`);
console.log(`   |Δs| median ${q(0.5).toFixed(0)} m   p10 ${q(0.1).toFixed(0)} m`
  + `   p90 ${q(0.9).toFixed(0)} m   max ${all[all.length - 1].toFixed(0)} m`);
console.log(`   inside the lit ±60 m band: ${(100 * all.filter(v => v <= 60).length / all.length).toFixed(1)}%`);

/* The distance still to run is kept in the trace alongside the gaps so this race
   can be replayed against the finish-bar cut-off, but the cut-off itself is
   decided over sixteen recorded fields in tools/zraxis.mjs rather than over one
   race here — a single race whose player leads at the end never produces the
   failure at all, and a per-race table that prints zeroes would read as evidence
   that there is nothing to fix. */

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
  seed: SEED, skill: SKILL, layout: res.layout, finishedAt: res.finishedAt,
  standings: res.standings, trace: res.trace,
  shots: res.shots.map(s => ({
    label: s.label, t: s.t, s: s.s, left: s.left, pos: s.pos, kmh: s.kmh,
    plate: s.plate, each: s.each,
    card: { w: s.card.w, h: s.card.h }, strip: { w: s.strip.w, h: s.strip.h },
  })),
}, null, 1));
console.log(`\n  → shots/zrshot`);
finish(process.exitCode || 0);
