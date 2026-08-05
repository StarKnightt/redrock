/* Capture the showcase reel's frames.
 *
 * CAPTURE-ONLY. Nothing in src/ is touched. Everything this file does to the
 * world it does through the control surface main.js already publishes, plus
 * one runtime shim on `Input` that is described below and is the moral
 * equivalent of a gamepad.
 *
 * The five rules this project has been burned by, and how each is obeyed:
 *
 *  1. RENDER THROUGH THE PIPELINE. Every frame is `g.pipeline.render()`
 *     followed by `g.hud.draw()`, composited in one evaluate because the
 *     drawing buffer is not preserved. Same path as gridstart.mjs. No orbit
 *     camera, no parked car — the chase lens is on the car and the car is
 *     being driven.
 *
 *  2. restart() BEFORE ANYTHING IS STEPPED. The harness is also asked for
 *     `begin:false`, so the page's own rAF loop never starts and there is
 *     nothing to inherit in the first place. Both, not either.
 *
 *  3. FRAME 0 IS DISCARDED. Every shot steps one frame past its start index
 *     before the first grab, and the first grab after a long run-in is thrown
 *     away by construction because the run-in ends on a stepped frame.
 *
 *  4. THE CLOCK IS PINNED. `performance.now` is replaced with a virtual clock
 *     advanced by exactly 1000/60 ms per stepped frame. environment.js:1508
 *     reads it for the water and foliage uniforms, so without this the sea
 *     animates at whatever rate PNG encoding happens to run at — which is
 *     about 8 fps — and the encode is a lie. With it, the world animates at
 *     an honest 60.
 *
 *  5. ONE BROWSER AT A TIME. Shots are grouped by seed and each seed gets one
 *     browser, opened and closed by the harness. Nothing runs in parallel.
 *
 * Two drive modes:
 *
 *   'race'  — restart, autopilot, fixed 1/60 from the grid. Bit-identical to
 *             what tools/reelscout.mjs measured, so a frame index chosen from
 *             the scout telemetry lands on the frame it describes.
 *
 *   'start' — the 3-2-1, actually played. `driveTo`, `warp` and `autopilot`
 *             all call `countdown.skip()` explicitly, so none of them can be
 *             used to reach a countdown; and `Game.step` skips the countdown
 *             the moment `bot` or `botInput` is set. The only way in is
 *             through the human input path, so this wraps `Input.update` and
 *             writes the four axes after the real one has run: throttle
 *             pinned to the limiter while the lights hold — which is what the
 *             rev counter and the crowd hype are for — and the AI driver's
 *             own output once they go out. `g.bot` and `g.botInput` are never
 *             assigned, so the countdown runs to its natural end.
 *
 *   node tools/reelshoot.mjs --plan out/reel/plan.json [--contact] [--only id,id]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const has = k => args.includes('--' + k);

const PLAN = path.resolve(ROOT, flag('plan', 'out/reel/plan.json'));
const CONTACT = has('contact');
const ONLY = flag('only', null)?.split(',');
const W = +flag('w', 1920), H = +flag('h', 1080);
const TIER = flag('tier', 'high');

const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
let shots = plan.shots.filter(s => !ONLY || ONLY.includes(s.id));
if (!shots.length) { console.error('no shots selected'); process.exit(1); }

const FRAMES = path.join(ROOT, 'out', 'reel', CONTACT ? 'contact' : 'frames');
fs.mkdirSync(FRAMES, { recursive: true });

/* ── in-page ─────────────────────────────────────────────────────────── */

const SETUP = ([mode, skill]) => {
  const g = window.__game;
  g.setPaused(true);

  /* The virtual clock. Installed before anything is stepped so the very first
     frame already sees it, and monotonic so nothing that samples it can go
     backwards. `__vclock` is exported so the stepper can advance it. */
  if (!window.__vclock) {
    const base = performance.now();
    const st = { t: base };
    window.__vclock = st;
    const real = performance.now.bind(performance);
    performance.now = () => st.t;
    window.__realNow = real;
  }

  /* A Driver instance, borrowed before the countdown is armed. `autopilot`
     calls `countdown.skip()`, so it can never be used once the lights are on
     — but it can be used to obtain the object, and then put away. */
  g.autopilot(true, skill);
  const drv = g.bot;
  g.autopilot(false);

  /* Rule 2, unconditional and before a single step. */
  g.restart();

  if (mode === 'race') {
    g.autopilot(true, skill);
  } else {
    /* The gamepad shim. Wraps the real update rather than replacing the
       object, so key handling, the gamepad poll and the one-shot edge flags
       all still behave; only the four axes are overwritten, after. */
    const inp = g.input;
    if (!inp.__reelWrapped) {
      inp.__reelWrapped = true;
      const orig = inp.update.bind(inp);
      inp.update = dt => {
        orig(dt);
        if (g.countdown.holding) {
          /* Held on the line against the limiter. The car cannot move — no
             substep runs while `holding` — so this reaches the rev counter,
             the engine note and the crowd, and nothing else. */
          inp.steer = 0; inp.throttle = 1; inp.brake = 0; inp.handbrake = 0;
        } else {
          const c = drv.drive(g.player, 1 / 120);
          inp.steer = c.steer; inp.throttle = c.throttle;
          inp.brake = c.brake; inp.handbrake = c.handbrake || 0;
        }
        inp.skipPressed = false;
        inp.resetPressed = false;
      };
    }
  }
  return {
    length: +g.track.length.toFixed(1),
    holding: g.countdown.holding,
    field: g.race.fieldSize,
    w: g.renderer.domElement.width, h: g.renderer.domElement.height,
    hud: g.hudOn, hudW: g.hud.canvas.width, hudH: g.hud.canvas.height,
  };
};

const STEP = ([k]) => {
  const g = window.__game;
  const st = window.__vclock;
  for (let i = 0; i < k; i++) {
    st.t += 1000 / 60;
    g.step(1 / 60);
  }
  const p = g.player;
  return [+p.s.toFixed(1), +p.kmh.toFixed(1), +p.offRoad.toFixed(2),
    +p.height.toFixed(2), +((p.slipAngle * 180) / Math.PI).toFixed(1)];
};

const GRAB = ([type, quality]) => {
  const g = window.__game;
  g.pipeline.render();
  if (g.hudOn) g.hud.draw();
  const gl = g.renderer.domElement;
  const c = document.createElement('canvas');
  c.width = gl.width; c.height = gl.height;
  const x = c.getContext('2d');
  x.drawImage(gl, 0, 0);
  if (g.hudOn) x.drawImage(g.hud.canvas, 0, 0, c.width, c.height);
  return c.toDataURL(type, quality);
};

/* ── driver ──────────────────────────────────────────────────────────── */

const bySeed = new Map();
for (const s of shots) {
  if (!bySeed.has(s.seed)) bySeed.set(s.seed, []);
  bySeed.get(s.seed).push(s);
}

const report = [];
let totalFrames = 0, totalBytes = 0;
const t00 = Date.now();

for (const [seed, list] of bySeed) {
  /* Two drive modes cannot share a page: 'start' plays the countdown from the
     grid and 'race' skips it, and they diverge from frame one. One browser
     per (seed, mode), still never more than one at a time. */
  for (const mode of ['start', 'race']) {
    const group = list.filter(s => (s.mode || 'race') === mode)
      .sort((a, b) => a.start - b.start);
    if (!group.length) continue;

    console.log(`\n═══ seed ${seed}  mode=${mode}  ${group.length} shot(s) ═══`);
    await run({
      width: W, height: H, begin: false,
      hash: `manual&tier=${TIER}&seed=${seed}&cap=0`,
    }, async ({ page }) => {
      const info = await page.evaluate(SETUP, [mode, plan.skill ?? 0.9]);
      console.log(`   canvas ${info.w}x${info.h}  hud ${info.hudW}x${info.hudH}`
        + `  field ${info.field}  holding=${info.holding}`);
      if (info.w !== W || info.h !== H) {
        throw new Error(`canvas is ${info.w}x${info.h}, wanted ${W}x${H}`);
      }
      if (!info.hud) throw new Error('HUD is off — the reel needs it on');

      let cur = 0;   // frames stepped so far
      for (const shot of group) {
        const dir = CONTACT ? FRAMES : path.join(FRAMES, shot.id);
        if (!CONTACT) {
          fs.rmSync(dir, { recursive: true, force: true });
          fs.mkdirSync(dir, { recursive: true });
        }
        /* Run in. Rule 3: the shot's own first captured frame is the one AFTER
           `start`, so a long run-in never ends on a grabbed frame. */
        const runIn = shot.start - cur;
        if (runIn < 0) throw new Error(`${shot.id}: shots must be in frame order`);
        if (runIn > 0) { await page.evaluate(STEP, [runIn]); cur = shot.start; }

        const picks = CONTACT
          ? [1, Math.round(shot.n * 0.25), Math.round(shot.n * 0.5),
            Math.round(shot.n * 0.75), shot.n].filter((v, i, a) => a.indexOf(v) === i)
          : null;

        const tel = [];
        const t0 = Date.now();
        let bytes = 0, k = 0;
        for (let j = 1; j <= shot.n; j++) {
          tel.push(await page.evaluate(STEP, [1]));
          cur++;
          if (CONTACT && !picks.includes(j)) continue;
          const url = await page.evaluate(GRAB, ['image/png', 1]);
          const buf = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
          const file = CONTACT
            ? path.join(dir, `${shot.id}-${String(j).padStart(4, '0')}.png`)
            : path.join(dir, `${String(++k).padStart(5, '0')}.png`);
          fs.writeFileSync(file, buf);
          bytes += buf.length;
        }
        totalFrames += CONTACT ? picks.length : shot.n;
        totalBytes += bytes;

        const col = i => tel.map(r => r[i]);
        const kmh = col(1), off = col(2), air = col(3), slip = col(4);
        const line = {
          id: shot.id, seed, mode, kind: shot.kind,
          start: shot.start, n: shot.n, sec: +(shot.n / 60).toFixed(2),
          s0: tel[0][0], s1: tel[tel.length - 1][0],
          kmh: [Math.min(...kmh), Math.max(...kmh)],
          maxOffRoad: Math.max(...off),
          maxAir: Math.max(...air),
          maxSlipDeg: Math.max(...slip.map(Math.abs)),
          note: shot.note || '',
          mb: +(bytes / 1e6).toFixed(1),
        };
        report.push(line);
        console.log(`   ${shot.id.padEnd(14)} s${line.s0}→${line.s1}`
          + `  ${line.kmh[0]}-${line.kmh[1]} km/h  off≤${line.maxOffRoad}`
          + `  air≤${line.maxAir}m  slip≤${line.maxSlipDeg}°`
          + `  ${line.sec}s  ${line.mb}MB  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
    });
  }
}

const out = path.join(ROOT, 'out', 'reel', CONTACT ? 'contact-report.json' : 'shot-report.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\n  ${totalFrames} frames, ${(totalBytes / 1e6).toFixed(0)} MB,`
  + ` ${((Date.now() - t00) / 1000).toFixed(0)}s wall  → ${path.relative(ROOT, out)}`);

finish(process.exitCode || 0);
