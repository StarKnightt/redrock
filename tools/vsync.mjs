/* What frame rate does the cap actually deliver, on which panel?
 *
 * A capped loop on a vsynced display cannot deliver an arbitrary rate. rAF
 * fires once per vsync, so every frame the loop chooses to draw is some whole
 * number of vsyncs after the last one, and the delivered rate is refresh/k.
 * All the cap does is pick k — and picking it badly is invisible in every
 * other instrument here, because none of them go through the display loop.
 *
 * So this drives `Game.frame` itself, with the real gate in it, from a
 * synthetic vsync clock: timestamps exactly 1000/refresh apart, which is what
 * a compositor hands a page that is keeping up. Nothing about the pacing
 * decision is reimplemented — the only things stubbed out are rAF, so the
 * loop does not schedule itself, and the render call, which costs a
 * millisecond a frame and has no say in when a frame happens.
 *
 * The old rule is reimplemented, and is labelled as such: it is the two lines
 * this replaced, and it is here to put a number on the before. It is checked
 * against reality rather than trusted — it has to reproduce the 50 fps the
 * 200 Hz panel was actually delivering, and the 48 fps that tools/shimmy.mjs
 * independently measured on a 144 Hz one.
 *
 *   node tools/vsync.mjs [--cap 60] [--frames 600]
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const CAP = +flag('cap', '60');
const FRAMES = +flag('frames', '600');

/* Refresh rates worth testing. 200 is the machine this was reported from; the
   two non-integer entries are there because nothing guarantees a panel's
   refresh is a whole number — 143.98 and 59.94 are both real. */
const PANELS = [60, 59.94, 75, 100, 120, 143.98, 144, 165, 200, 240, 360];

const out = {};

await run({
  width: 640, height: 360,
  hash: `manual&tier=low&cap=${CAP}&hud=0`,
  begin: false,
}, async ({ page }) => {
  const res = await page.evaluate(([panels, cap, frames]) => {
    const g = window.__game;

    /* rAF must not schedule anything: this test supplies the clock. The
       render call is stubbed because it is a millisecond of GPU per frame and
       contributes nothing to the decision under test. `step` is left alone
       and is the thing counted — it runs exactly on the frames the gate
       admits, which is the definition of a delivered frame. */
    const realRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = () => 0;
    const realRender = g.pipeline.render;
    g.pipeline.render = () => {};
    g.hudOn = false;
    g.setPaused(true);         // no simulation; only the gate is under test

    const Game = g.constructor;
    let admitted = 0, at = [];
    const realFrame = Game.prototype.frame;

    /* The rule this replaced, verbatim, for the before column.
         const min = 1000 / this.fpsCap - 1.2;
         if (now - this._lastFrame < min) return;
         this._lastFrame = now;                                            */
    const legacy = (now, st, capHz) => {
      const min = 1000 / capHz - 1.2;
      if (now - st.last < min) return false;
      st.last = now;
      return true;
    };

    /* The two candidate rules, both driven through the real Game.frame by
       substituting the one expression that differs. `nearest` is what ships;
       `floor` is the literal "hold while one more vsync still fits", kept
       here so the reason it does not ship is a measurement and not a claim. */
    const shippedK = Game.prototype._paceK;
    const RULES = {
      nearest: shippedK,
      floor(period, vsync) {
        if (!(vsync > 0) || !Number.isFinite(vsync)) return 1;
        return Math.max(1, Math.floor(period / vsync + 1e-9));
      },
    };

    const drive = (hz, V, rule, frames) => {
      Game.prototype._paceK = RULES[rule];
      g.running = false;
      g.begin();                        // resets the pacing state, as it must
      admitted = 0; at = [];
      Game.prototype.frame = function (now) {
        const before = this._lastFrame;
        realFrame.call(this, now);
        if (this._lastFrame !== before || this.fpsCap <= 0) { admitted++; at.push(now); }
      };
      for (let i = 1; i <= frames; i++) g.frame(i * V);
      Game.prototype.frame = realFrame;
      Game.prototype._paceK = shippedK;
      return { fps: admitted / (frames * V / 1000), at: at.slice(), vsync: g._vsync };
    };

    const results = [];
    for (const hz of panels) {
      const V = 1000 / hz;

      const now = drive(hz, V, 'nearest', frames);
      const flr = drive(hz, V, 'floor', frames);
      const span = frames * V / 1000;

      /* ---- before: the rule it replaced, same clock ------------------- */
      const st = { last: 0 };
      let oldN = 0; const oldAt = [];
      for (let i = 1; i <= frames; i++) {
        if (legacy(i * V, st, cap)) { oldN++; oldAt.push(i * V); }
      }

      /* Pacing evenness: the gap between admitted frames, in whole vsyncs.
         One value means a perfectly even cadence, which is what a display
         loop should produce; two means it alternates. */
      const cadence = list => {
        const c = {};
        for (let i = 1; i < list.length; i++) {
          const k = Math.round((list[i] - list[i - 1]) / V);
          c[k] = (c[k] || 0) + 1;
        }
        return c;
      };

      results.push({
        hz, vsync: +V.toFixed(4),
        oldFps: +(oldN / span).toFixed(2), oldCadence: cadence(oldAt),
        newFps: +(now.fps).toFixed(2), newCadence: cadence(now.at),
        floorFps: +(flr.fps).toFixed(2), floorCadence: cadence(flr.at),
        vsyncSeen: +now.vsync.toFixed(4),
      });
    }

    window.requestAnimationFrame = realRaf;
    g.pipeline.render = realRender;
    g.setPaused(false);
    return results;
  }, [PANELS, CAP, FRAMES]);

  for (const r of res) out[r.hz] = r;

  const cad = c => Object.entries(c).map(([k, v]) => `${k}v x${v}`).join(' ') || '—';
  console.log(`\n  Delivered frame rate with cap=${CAP}, driven through the real Game.frame`
    + `\n  over ${FRAMES} synthetic vsyncs per panel.\n`);
  const head = '  panel Hz   vsync   V seen |  BEFORE  cadence  |  AFTER (nearest)  cadence'
    + '  |  floor variant  cadence';
  console.log(head);
  console.log('  ' + '─'.repeat(head.length - 2));
  for (const r of res) {
    console.log('  ' + String(r.hz).padStart(8)
      + r.vsync.toFixed(3).padStart(8) + r.vsyncSeen.toFixed(3).padStart(9)
      + ' |' + r.oldFps.toFixed(1).padStart(8) + '  ' + cad(r.oldCadence).padEnd(9)
      + ' |' + r.newFps.toFixed(1).padStart(17) + '  ' + cad(r.newCadence).padEnd(9)
      + ' |' + r.floorFps.toFixed(1).padStart(15) + '  ' + cad(r.floorCadence));
  }

  const uneven = k => res.filter(r => Object.keys(r[k]).length > 1).map(r => r.hz);
  console.log(`\n  evenly paced — before: ${uneven('oldCadence').length ? uneven('oldCadence').join(',') : 'all'}`
    + `   after: ${uneven('newCadence').length ? 'NO: ' + uneven('newCadence').join(',') : 'all'}`);
  const worst = k => res.reduce((a, r) => Math.min(a, r[k]), 1e9);
  const overBy = k => Math.max(...res.map(r => r[k])) / CAP - 1;
  console.log(`  slowest panel      before ${worst('oldFps').toFixed(1)} fps`
    + `   after ${worst('newFps').toFixed(1)} fps   floor ${worst('floorFps').toFixed(1)} fps`);
  console.log(`  worst overshoot of the ${CAP} cap`
    + `   before ${(overBy('oldFps') * 100).toFixed(0)}%`
    + `   after ${(overBy('newFps') * 100).toFixed(0)}%`
    + `   floor ${(overBy('floorFps') * 100).toFixed(0)}%`);
  const over = res.filter(r => r.newFps > CAP + 0.5);
  console.log(`  panels above the cap after: `
    + (over.length ? over.map(r => `${r.hz}Hz->${r.newFps.toFixed(1)}`).join(' ') : 'none'));
});

/* ---- tool identity ---------------------------------------------------------
 *
 * 76 of the 158 tools pass `cap=0` in their hash and never execute a line of
 * the gate — `if (this.fpsCap > 0)` is the whole of that argument. The other
 * 63 run at the default cap of 60, and for those the claim to prove is
 * stronger than "they drive g.step themselves": it is that the old rule and
 * the new one admit exactly the same frames.
 *
 * That is decidable rather than arguable. Both rules are pure functions of the
 * rAF timestamp stream, so this runs a real harness session at cap=60 with the
 * real loop driving, records every timestamp the browser actually delivers,
 * and asks both rules about each one. If they never disagree, every capped
 * tool run is frame-for-frame what it was, whatever the tool then measures.
 */
await run({
  width: 640, height: 360,
  hash: 'manual&tier=low&hud=0',        // no cap= : the 60 default, as most tools
}, async ({ page }) => {
  await new Promise(r => setTimeout(r, 500));
  const att = await page.evaluate(async () => {
    const g = window.__game;
    const Game = g.constructor;
    const realFrame = Game.prototype.frame;
    const seen = [];
    const st = { last: g._lastFrame };
    let agree = 0, disagree = 0;

    Game.prototype.frame = function (now) {
      const before = this._lastFrame;
      realFrame.call(this, now);
      const tookNew = this._lastFrame !== before;
      // The two lines this replaced, over the same timestamp.
      const min = 1000 / this.fpsCap - 1.2;
      let tookOld = false;
      if (now - st.last >= min) { st.last = now; tookOld = true; }
      if (tookNew === tookOld) agree++; else disagree++;
      seen.push(now);
    };
    await new Promise(r => setTimeout(r, 3000));
    Game.prototype.frame = realFrame;

    const gaps = [];
    for (let i = 1; i < seen.length; i++) gaps.push(seen[i] - seen[i - 1]);
    gaps.sort((a, b) => a - b);
    return {
      cap: g.fpsCap, callbacks: seen.length, agree, disagree,
      vsyncEstimate: +g._vsync.toFixed(3),
      gapMin: +(gaps[0] ?? 0).toFixed(3),
      gapMed: +(gaps[gaps.length >> 1] ?? 0).toFixed(3),
      gapMax: +(gaps[gaps.length - 1] ?? 0).toFixed(3),
    };
  });

  console.log('\n  ── tool identity: old rule vs new rule on a real harness session ──\n');
  console.log(`  cap in force                 ${att.cap}`);
  console.log(`  rAF callbacks observed       ${att.callbacks}`);
  console.log(`  callback gap  min/med/max    ${att.gapMin} / ${att.gapMed} / ${att.gapMax} ms`);
  console.log(`  vsync the gate measured      ${att.vsyncEstimate} ms`);
  console.log(`  frames both rules admitted   ${att.agree}`);
  console.log(`  frames they DISAGREED on     ${att.disagree}`);
  console.log(`\n  every capped tool frame-identical: ${att.disagree === 0 ? 'yes' : 'NO'}`);
  if (att.disagree) process.exitCode = 1;
  out.identity = att;
});

fs.mkdirSync(path.join(ROOT, 'shots'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'shots', 'vsync.json'), JSON.stringify(out, null, 1));
console.log('\n  → shots/vsync.json');
finish(process.exitCode || 0);
