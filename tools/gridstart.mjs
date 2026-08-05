/* The start line, measured.
 *
 * Four questions, and none of them can be answered by looking at a frame:
 *
 *  1. Is the field actually held? Every car's arc length is sampled on every
 *     frame of the sequence, so "held" is a number and not an impression, and
 *     the release frame is read off the first frame any of them moves. If the
 *     player and the three rivals do not all move on the SAME frame the race
 *     is decided before anyone touches anything.
 *  2. How long is it, in wall-clock seconds? The countdown is driven by the
 *     frame's own dt and this tool steps a fixed 1/60, so the frame index of
 *     each transition IS the wall clock. Time dilation is checked at the same
 *     time — timeScale() must read exactly 1 throughout, or the sequence is
 *     quietly in the other unit.
 *  3. Do the tools still work? The default under `manual` is asserted here
 *     rather than described, and driveTo is run against an ARMED countdown to
 *     show it is released rather than blocked.
 *  4. What does it look like, at native resolution, with the HUD composited
 *     over the frame — which is the only way the numerals appear in a capture
 *     at all, since they are drawn on a second canvas.
 *
 *   node tools/gridstart.mjs [--seed 22] [--tag countdown]
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
const TAG = flag('tag', 'countdown');
const outDir = path.join(ROOT, 'shots', TAG);

fs.mkdirSync(outDir, { recursive: true });

/* `manual`, deliberately: this is a tool, and the whole claim being tested is
   that a tool is never held. The countdown is then armed by hand below, which
   is also the only way to get a deterministic frame zero — the harness starts
   the loop before the first evaluate arrives. */
await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0`,
}, async ({ page }) => {
  /* Composite: the GL frame with the 2D overlay drawn over it, read back in
     one evaluate because the drawing buffer is not preserved. */
  const shoot = async (name) => {
    const url = await page.evaluate(() => {
      const g = window.__game;
      g.renderOnce();
      g.hud.draw();
      const gl = g.renderer.domElement;
      const c = document.createElement('canvas');
      c.width = gl.width; c.height = gl.height;
      const x = c.getContext('2d');
      x.drawImage(gl, 0, 0);
      x.drawImage(g.hud.canvas, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    });
    const file = path.join(outDir, `s${SEED}-${name}.png`);
    fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
    return path.basename(file);
  };

  const defaults = await page.evaluate(() => {
    const g = window.__game;
    g.setPaused(true);
    return {
      hash: location.hash,
      armed: g.countdown.armed,
      holding: g.countdown.holding,
      display: g.countdown.display(),
      hype: g.crowd ? g.crowd.uniforms.uHype.value : null,
    };
  });
  console.log(`\n  under '${defaults.hash}' — the hash every tool in tools/ boots with`);
  console.log(`    countdown armed   ${defaults.armed}`);
  console.log(`    holding           ${defaults.holding}`);
  console.log(`    HUD payload       ${JSON.stringify(defaults.display)}`);
  console.log(`    crowd uHype       ${defaults.hype}`);
  const defaultsOk = defaults.armed === false && defaults.holding === false
    && defaults.display === null && defaults.hype === 0;

  /* driveTo against an ARMED countdown: the instrument path, with the lights
     deliberately on. If the hold could reach a tool this is where it would. */
  const drove = await page.evaluate(() => {
    const g = window.__game;
    g.countdown.arm();
    const before = { armed: g.countdown.armed, s: +g.player.s.toFixed(1) };
    const t = g.driveTo(0.25);
    return { before, armed: g.countdown.armed, s: t.s, kmh: t.kmh };
  });
  console.log('\n  driveTo(0.25) with the countdown armed');
  console.log(`    before   armed=${drove.before.armed}  s=${drove.before.s}`);
  console.log(`    after    armed=${drove.armed}  s=${drove.s} m  ${drove.kmh} km/h`);
  const driveOk = drove.before.armed === true && drove.armed === false && drove.s > 1300;

  /* The sequence itself, from a cold grid. */
  const seq = await page.evaluate(() => {
    const g = window.__game;
    g.autopilot(false);
    g.botInput = null;
    g.setPaused(true);
    /* Back to the grid the way the game itself starts: the race resets the
       field to its slots and the player is placed at the same station main.js
       uses. goTo would skip the countdown, which is the point of it. */
    g.player.placeAt(34, 0);
    g.player.raceTime = 0;
    g.race.reset(34);
    g.resetSimClock();
    g.effects.reset();
    g.chase.started = false;
    g.countdown.arm();

    /* Throttle pinned, which is what a driver does on the line, and pinned
       the way a driver pins it: Game.step recomputes the axes from the key
       set at the top of every frame, so setting the axis directly is written
       over before the countdown ever sees it. The rev column below is the
       thing this is here to produce. */
    g.input.down.add('KeyW');

    const rows = [];
    /* Race time, not arc length, is what says a car was stepped: a released
       car at a standstill takes a moment to actually go anywhere, and the
       rivals take different moments, so "the first frame s changes" answers a
       question about the drivers rather than about the hold. Car.step is the
       only thing that advances raceTime, so this is exactly "was this car
       integrated on this frame", for all four of them. */
    const clocks = () => [g.player.raceTime, ...g.race.entries.map(e => e.car.raceTime)];
    let prev = clocks();
    for (let i = 0; i <= 300; i++) {
      g.step(1 / 60);
      const now = clocks();
      const stepped = now.map((t, k) => t > prev[k] + 1e-12);
      prev = now;
      const d = g.countdown.display();
      rows.push({
        i,
        t: +((i + 1) / 60).toFixed(4),
        label: d ? d.text : null,
        holding: g.countdown.holding,
        scale: d ? +d.scale.toFixed(3) : null,
        alpha: d ? +d.alpha.toFixed(3) : null,
        hype: +g.countdown.hype.toFixed(3),
        rev: g.countdown.displayRev === null ? null : +g.countdown.displayRev.toFixed(3),
        carRpm: +(g.player.rpm / 7400).toFixed(3),
        timeScale: +g.timeScale().toFixed(4),
        raceTime: +g.player.raceTime.toFixed(4),
        uHype: g.crowd ? +g.crowd.uniforms.uHype.value.toFixed(3) : null,
        uTime: g.crowd ? +g.crowd.uniforms.uTime.value.toFixed(3) : null,
        stepped,
      });
    }
    g.input.down.delete('KeyW');
    return rows;
  });

  const firstOf = label => seq.find(r => r.label === label);
  const release = seq.find(r => r.stepped.some(Boolean));
  const allFour = release && release.stepped.every(Boolean);
  const lastHeld = seq.filter(r => r.holding).pop();

  console.log('\n  the sequence, stepped at a fixed 1/60 so frame index IS wall clock');
  console.log('    label   first frame   wall s    held   hype    rev     timeScale');
  for (const label of ['3', '2', '1', 'GO']) {
    const r = firstOf(label);
    if (!r) { console.log(`    ${label.padEnd(7)} NEVER SHOWN`); continue; }
    console.log(`    ${label.padEnd(7)} ${String(r.i).padStart(11)}   ${r.t.toFixed(3)}   `
      + `${String(r.holding).padEnd(6)} ${r.hype.toFixed(3)}   `
      + `${r.rev === null ? '  —  ' : r.rev.toFixed(3)}   ${r.timeScale.toFixed(3)}`);
  }
  const gone = seq.find(r => r.i > (firstOf('GO')?.i ?? 0) && r.label === null);
  console.log(`    numerals leave the screen at frame ${gone ? gone.i : '—'}`
    + ` (${gone ? gone.t.toFixed(3) : '—'} s)`);
  console.log(`    last held frame ${lastHeld ? lastHeld.i : '—'}`
    + `, first frame any car was integrated ${release ? release.i : '—'}`
    + ` (${release ? release.t.toFixed(3) : '—'} s)`);
  console.log(`    on that frame:  player ${release?.stepped[0]}   rivals `
    + `${release ? release.stepped.slice(1).join(' ') : '—'}`);

  const heldRows = seq.filter(r => r.holding);
  const anyEarly = heldRows.some(r => r.stepped.some(Boolean));
  const clockClean = seq.every(r => r.timeScale === 1);
  const raceClockAtGo = release ? seq[release.i - 1].raceTime : null;
  const crowdRan = heldRows.length > 1
    && heldRows[heldRows.length - 1].uTime > heldRows[0].uTime + 2;
  console.log(`\n    any car moved while held        ${anyEarly ? 'YES — BROKEN' : 'no'}`);
  console.log(`    all four released together      ${allFour ? 'yes' : 'NO — BROKEN'}`);
  console.log(`    timeScale() 1 for every frame   ${clockClean ? 'yes' : 'NO'}`);
  console.log(`    player race clock at release    ${raceClockAtGo} s`);
  console.log(`    crowd clock advanced on the line  ${crowdRan ? 'yes' : 'NO — frozen'}`
    + ` (uTime ${heldRows[0].uTime} → ${heldRows[heldRows.length - 1].uTime})`);
  const revPeak = Math.max(...heldRows.map(r => r.rev ?? 0));
  const revMin = Math.min(...heldRows.slice(30).map(r => r.rev ?? 1));
  console.log(`    revs against the limiter        ${revPeak.toFixed(3)} peak, `
    + `flutter floor ${revMin.toFixed(3)}`);
  /* The handover. What the HUD arc and the engine note are actually shown is
     the greater of the two columns, so the launch must never step down. */
  const shown = seq.map(r => Math.max(r.carRpm, r.rev ?? 0));
  let worstDrop = 0, dropAt = -1;
  for (let i = 1; i < shown.length; i++) {
    const d = shown[i - 1] - shown[i];
    if (d > worstDrop) { worstDrop = d; dropAt = i; }
  }
  console.log(`    rev handover at the release     `
    + [178, 180, 182, 186, 192, 200, 215].map(i => shown[i]?.toFixed(2)).join(' → '));
  console.log(`    worst single-frame step down    ${worstDrop.toFixed(3)} at frame ${dropAt}`);
  console.log(`    crowd uHype through the count   `
    + [0, 30, 60, 90, 120, 150, 179, 181, 210, 240].map(i => seq[i]?.uHype).join('  '));

  /* Captures. Re-run the sequence and stop on the frames worth looking at. */
  console.log('\n  captures at 1600x900, HUD composited over the GL frame');
  /* 181 is the pop frame — the biggest the plate ever gets, and the one that
     has to be checked against the timer plate it must not reach. */
  const shots = [[15, '3'], [75, '2'], [135, '1'], [181, 'GO-pop'], [195, 'GO'],
    [240, 'after-go']];
  await page.evaluate(() => {
    const g = window.__game;
    g.player.placeAt(34, 0);
    g.player.raceTime = 0;
    g.race.reset(34);
    g.resetSimClock();
    g.effects.reset();
    g.chase.started = false;
    g.countdown.arm();
    g.input.down.add('KeyW');
    /* One frame first, so the chase camera is where it will be for all of
       them: frame zero of a cold camera is not the frame the player sees. */
    g.step(1 / 60);
    /* Reported, not assumed: a capture round was lost to a re-arm that
       silently did nothing and a set of frames taken after the lights. */
    return {
      armed: g.countdown.armed, holding: g.countdown.holding,
      bot: !!g.bot, botInput: !!g.botInput,
      raceTime: +g.player.raceTime.toFixed(4),
    };
  }).then(d => console.log(`    re-armed: ${JSON.stringify(d)}`));
  let at = 1;
  for (const [frame, name] of shots) {
    await page.evaluate((n) => {
      const g = window.__game;
      for (let i = 0; i < n; i++) g.step(1 / 60);
    }, frame - at);
    at = frame;
    /* Discard the first read-back after a run of steps — the harness note on
       this has invented a critic round before now. */
    await page.evaluate(() => window.__game.renderOnce());
    const file = await shoot(name);
    console.log(`    frame ${String(frame).padStart(3)}  ${(frame / 60).toFixed(2)} s  ${file}`);
  }

  /* The cheerleaders. One uniform, so the proof is a render difference: the
     same frame, same clock, same camera, hype off and hype on. What changes
     has to be the squad and only the squad, and it has to be big enough on
     screen to see. */
  const squad = await page.evaluate(() => {
    const g = window.__game;
    g.setPaused(true);
    const cv = g.renderer.domElement, w = cv.width, h = cv.height;
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tc = tmp.getContext('2d');
    const grab = () => {
      g.renderOnce(); tc.drawImage(cv, 0, 0);
      return tc.getImageData(0, 0, w, h).data;
    };
    /* "Same clock" above was an assertion, not a fact, until this pin: the
       uniform src/world/environment.js sets from performance.now() inside
       onBeforeRender means two renders of an unchanged scene differ, and the
       whole verge behind the grid was landing in the squad's mask and
       stretching its bounding box to the width of the frame.

       Frame 0 of any render-differencing probe is discarded — the first
       read-back after a state change carries an artefact. */
    const realNow = performance.now.bind(performance);
    const tPin = realNow(); performance.now = () => tPin;
    g.crowd.setHype(0); grab();
    const cold = grab();
    g.crowd.setHype(1); grab();
    const hot = grab();
    g.crowd.setHype(0);
    performance.now = realNow;
    let px = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const d = Math.abs(cold[i] - hot[i]) + Math.abs(cold[i + 1] - hot[i + 1])
          + Math.abs(cold[i + 2] - hot[i + 2]);
        if (d <= 12) continue;
        px++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    /* Where the squad actually is in the frame, and how tall. A mechanism
       that is correct in simulation and three pixels tall has failed here
       before, so the answer is in pixels. */
    const site = (g.crowd.sites || []).find(s => s.kind === 'start line');
    let near = null;
    if (site) {
      const THREE = g.THREE;
      const p = new THREE.Vector3(site.at.x, site.at.y, site.at.z);
      const top = p.clone().setY(p.y + 1.7);
      const cam = g.camera;
      const a = p.clone().project(cam), b = top.clone().project(cam);
      const sx = (a.x * 0.5 + 0.5) * w, sy = (-a.y * 0.5 + 0.5) * h;
      const ty = (-b.y * 0.5 + 0.5) * h;
      let n = 0;
      const R = 220;
      for (let y = Math.max(0, sy - R) | 0; y < Math.min(h, sy + R); y++)
        for (let x = Math.max(0, sx - R) | 0; x < Math.min(w, sx + R); x++) {
          const i = (y * w + x) * 4;
          const d = Math.abs(cold[i] - hot[i]) + Math.abs(cold[i + 1] - hot[i + 1])
            + Math.abs(cold[i + 2] - hot[i + 2]);
          if (d > 12) n++;
        }
      near = { x: Math.round(sx), y: Math.round(sy), tall: Math.round(sy - ty), n };
    }
    return {
      px, box: px ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null,
      near,
      site: site ? { s: site.s, n: site.groups.reduce((a, b) => a + b.n, 0) } : null,
    };
  });
  console.log('\n  cheerleaders: the same frame with the hype uniform off and on');
  console.log(`    start-line squad   ${squad.site ? `${squad.site.n} figures at s=${squad.site.s}` : 'MISSING'}`);
  if (squad.near) console.log(`    in frame at        x${squad.near.x} y${squad.near.y}, `
    + `${squad.near.tall} px tall — ${squad.near.n} px changed within 220 of it`);
  console.log(`    pixels changed     ${squad.px}`
    + (squad.box ? `   in a ${squad.box[2]} x ${squad.box[3]} box at x${squad.box[0]} y${squad.box[1]}`
      : '   — NOTHING MOVED'));

  /* Cost. The countdown adds no geometry at all, so the only question is
     whether the crowd's extra uniform costs anything in the pass that reads
     it — measured on the same frame with hype on and hype off. */
  const cost = await page.evaluate(() => {
    const g = window.__game;
    g.setPaused(true);
    /* Median of alternating runs. A single pair of averages on this GPU
       moves by more between two identical measurements than the thing being
       measured could possibly cost. */
    const median = a => a.slice().sort((x, y) => x - y)[a.length >> 1];
    const bench = () => {
      for (let i = 0; i < 20; i++) g.pipeline.render();
      const N = 120, t0 = performance.now();
      for (let i = 0; i < N; i++) g.pipeline.render();
      return (performance.now() - t0) / N;
    };
    const pair = () => {
      const a = [], b = [];
      for (let k = 0; k < 5; k++) {
        g.crowd?.setHype(0); a.push(bench());
        g.crowd?.setHype(1); b.push(bench());
      }
      return [median(a), median(b)];
    };
    const stats = () => ({ tris: g.pipeline.stats.triangles, calls: g.pipeline.stats.calls });
    /* Warm first: the opening bench of a run carries the shader compile and
       the driver waking up, and attributing that to whichever setting went
       first is how a uniform gets blamed for two milliseconds. */
    bench();
    const [cold, hot] = pair();
    g.crowd?.setHype(1);
    g.pipeline.render();
    const hotS = stats();
    g.crowd?.setHype(0);
    g.pipeline.render();
    const coldS = stats();
    return { hot, cold, hotS, coldS };
  });
  console.log('\n  frame cost on the grid frame, 1600x900');
  console.log(`    crowd hype 0    ${cost.cold.toFixed(3)} ms   `
    + `${cost.coldS.tris} tri   ${cost.coldS.calls} calls`);
  console.log(`    crowd hype 1    ${cost.hot.toFixed(3)} ms   `
    + `${cost.hotS.tris} tri   ${cost.hotS.calls} calls`);
  console.log(`    triangles added by the countdown: `
    + `${cost.hotS.tris - cost.coldS.tris}`);

  const ok = defaultsOk && driveOk && !anyEarly && allFour && clockClean && crowdRan;
  console.log(`\n  ${ok ? '✓ start line behaves' : '✗ START LINE FAULT'}`);
  if (!ok) process.exitCode = 1;
});

/* And the other side of the default: a boot with no `manual` in it is a
   player opening the page, and that one IS held. Run as its own page because
   the flag is read once, at construction. */
for (const [hash, want] of [
  [`tier=high&seed=${SEED}&cap=0&hud=0`, true],
  [`tier=high&seed=${SEED}&cap=0&hud=0&countdown=0`, false],
  [`manual&tier=high&seed=${SEED}&cap=0&hud=0&countdown=1`, true],
]) {
  await run({ width: 480, height: 270, hash }, async ({ page }) => {
    const r = await page.evaluate(() => {
      const g = window.__game;
      g.setPaused(true);
      return { armed: g.countdown.armed, holding: g.countdown.holding };
    });
    const ok = r.armed === want;
    console.log(`\n  boot '#${hash}'`);
    console.log(`    armed ${r.armed}, holding ${r.holding}  `
      + `— expected armed ${want}  ${ok ? '✓' : '✗'}`);
    if (!ok) process.exitCode = 1;
  });
}

console.log(`\n  → shots/${TAG}`);
finish(process.exitCode || 0);
