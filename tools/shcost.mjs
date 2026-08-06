/* What the sun's shadow map actually costs, per size, with a clock that can
 * see a GPU.
 *
 *   node tools/shcost.mjs [--seed 22] [--sizes 1024,1536,2048,4096,8192]
 *
 * THE SHADOW PASS CANNOT BE TIMED IN ISOLATION, and that was tried first.
 * `renderer.shadowMap.render(lights, scene, camera)` called directly throws
 * `Cannot read properties of null (reading 'state')` out of `setProgram` —
 * three's `_currentRenderState` only exists inside a `renderer.render()`, so
 * the shadow pass has no way to run on its own. The pass can only be measured
 * as a difference between whole frames that do and do not contain it.
 *
 * SO THE DIFFERENCE HAS TO BE PAIRED. An earlier revision measured the two
 * configurations one after the other and subtracted, and the frame-to-frame
 * drift on this rig (~0.2 ms over the seconds a size sweep takes) swamped
 * every cost below 4096 — it reported NEGATIVE costs for 1024 and 2048, which
 * is how you know a difference is being read out of noise. Here the two
 * configurations are INTERLEAVED, A B A B, and the median of the per-round
 * differences is taken. Drift that affects both members of a round equally
 * cancels; nothing else does.
 *
 * AND THE NOISE FLOOR IS MEASURED, NOT ASSUMED. A null round — the same
 * configuration paired against itself — is run at every station, and any cost
 * whose magnitude falls inside it is printed as "< floor" rather than as a
 * number. That is the guard that would have caught the negative figures.
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/main.js` recorded the 8192 map at "0.15 ms a frame on the 4060". 8192
 * squared is 67 Mpixel of depth rasterisation, so 0.15 ms would be 450
 * Gpixel/s and a 4060 does not have that. The figure is almost certainly a
 * non-synchronising timer, and it is the number that made 8192 look
 * affordable. This tool re-derives it.
 *
 * THE DRAIN, AND WHY IT IS A READBACK
 * -----------------------------------
 * A stopwatch around renderer.render() measures how long it took to QUEUE the
 * work. Chrome puts the real GL in another process behind a command buffer,
 * and — measured in the bake-off at .fix/mobdiag.mjs — neither `gl.flush()`,
 * nor `gl.fenceSync` + `gl.clientWaitSync` with the driver's own maximum
 * timeout, nor `gl.finish()` blocks on it. All three reported the same
 * plausible milliseconds for a fullscreen pass over sixteen times the pixels,
 * which is the one thing a fill-bound pass cannot honestly do.
 *
 * Only a one-pixel `readPixels` scales with pixel count, because the bytes
 * have to arrive in JavaScript and everything that could still change them has
 * to have retired first. That is the drain used here.
 *
 * PROVE THE CLOCK BEFORE BELIEVING IT — calibrate() below renders the same
 * fullscreen composite over 1x, 4x and 16x the pixels and demands the reading
 * track it, and separately renders it 1, 2 and 4 times per timed call. An
 * instrument that fails either is refusing to see work, and the tool prints no
 * timings and exits 1. Nothing in this file is trusted on the strength of
 * looking reasonable.
 *
 * The clock is also cold on a fresh context: measured, the first two timed
 * batches read ~6x their settled value on an idle discrete GPU, which is
 * enough to make a calibration conclude that more work is cheaper than less.
 * So there is a burn-in before anything is measured.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, settleBoot } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', 22);
const SIZES = flag('sizes', '1024,1536,2048,4096,8192').split(',').map(Number);

/* Sun geometry, duplicated from src/main.js SUN_OFFSET on purpose: a tool that
   imports the constant it is checking cannot notice the constant changing
   under it, and this is the number the texel arithmetic hangs on. */
const SUN = [-150, 125, 165];

await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0` },
  async ({ page }) => {
    await settleBoot(page);

    const out = await page.evaluate(async ({ sizes }) => {
      const g = window.__game;
      const r = g.renderer, p = g.pipeline, THREE = g.THREE;
      const gl = r.getContext();
      const rawNow = performance.now.bind(performance);
      const px = new Uint8Array(4);

      /* A private 1x1 RGBA8 target. Reading RGBA/UNSIGNED_BYTE out of the
         beauty target — half-float and 4x multisampled — is an
         INVALID_OPERATION, which returns no bytes, performs no
         synchronisation, and quietly puts this back to timing the CPU. */
      const scratch = new THREE.WebGLRenderTarget(1, 1, {
        depthBuffer: false, stencilBuffer: false,
      });
      const drain = () => { r.setRenderTarget(scratch); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };

      /* performance.now() in a page that is not cross-origin isolated is
         clamped to about 100 us, so the batch GROWS until the reading is long
         enough for the clock to resolve. A fixed batch is how every pass in
         the frame once came back as exactly 0.100 ms. */
      const timeit = (fn, { batches = 9, warm = 3, target = 12, maxReps = 16384 } = {}) => {
        for (let i = 0; i < warm; i++) fn();
        drain();
        let reps = 1;
        for (;;) {
          const t0 = rawNow();
          for (let i = 0; i < reps; i++) fn();
          drain();
          const dt = rawNow() - t0;
          if (dt >= target || reps >= maxReps) break;
          reps = Math.min(maxReps, Math.max(reps * 2, Math.ceil(reps * target / Math.max(dt, 0.05))));
        }
        const o = [];
        for (let b = 0; b < batches; b++) {
          const t0 = rawNow();
          for (let i = 0; i < reps; i++) fn();
          drain();
          o.push((rawNow() - t0) / reps);
        }
        o.sort((a, b) => a - b);
        return { median: o[o.length >> 1], min: o[0], max: o[o.length - 1], reps };
      };

      /* Wall time of ONE drained call — what a frame actually costs, as
         opposed to its throughput back-to-back. Coarse (the tick is 0.1 ms)
         and reported alongside rather than instead of the batched figure. */
      const timeFrames = (fn, { n = 40, warm = 5 } = {}) => {
        for (let i = 0; i < warm; i++) fn();
        drain();
        const o = [];
        for (let i = 0; i < n; i++) { const t0 = rawNow(); fn(); drain(); o.push(rawNow() - t0); }
        o.sort((a, b) => a - b);
        return { median: o[n >> 1], p95: o[Math.min(n - 1, Math.floor(n * 0.95))], min: o[0], max: o[n - 1] };
      };

      /* Batched timing of one configuration, at a fixed rep count so both
         members of a pair do identical amounts of work. */
      const batchAt = (fn, reps) => {
        const t0 = rawNow();
        for (let i = 0; i < reps; i++) fn();
        drain();
        return (rawNow() - t0) / reps;
      };

      /* Find a rep count that puts a batch comfortably above the clock's
         100 us quantisation, using the more expensive member of the pair. */
      const repsFor = (fn, target = 8) => {
        let reps = 1;
        for (;;) {
          const dt = batchAt(fn, reps) * reps;
          if (dt >= target || reps >= 4096) return reps;
          reps = Math.min(4096, Math.max(reps * 2, Math.ceil(reps * target / Math.max(dt, 0.05))));
        }
      };

      /* PAIRED DIFFERENCE: median of (a - b) over interleaved rounds.
         Returns the quartiles too, because the spread is the only honest
         statement of what the number is worth. */
      const pairedDiff = (a, b, { rounds = 15, reps = null } = {}) => {
        const n = reps || repsFor(a);
        for (let i = 0; i < 3; i++) { batchAt(a, n); batchAt(b, n); }
        const d = [], av = [], bv = [];
        for (let i = 0; i < rounds; i++) {
          /* Order swapped every round so any within-round ramp cancels too. */
          const first = i % 2 === 0;
          const x = first ? batchAt(a, n) : batchAt(b, n);
          const y = first ? batchAt(b, n) : batchAt(a, n);
          const ai = first ? x : y, bi = first ? y : x;
          av.push(ai); bv.push(bi); d.push(ai - bi);
        }
        const q = (arr, p) => { const s = [...arr].sort((u, v) => u - v); return s[Math.floor(s.length * p)]; };
        return {
          median: q(d, 0.5), q25: q(d, 0.25), q75: q(d, 0.75),
          aMedian: q(av, 0.5), bMedian: q(bv, 0.5), reps: n, rounds,
        };
      };

      const burn = (ms) => {
        const t0 = rawNow();
        while (rawNow() - t0 < ms) { for (let i = 0; i < 8; i++) p.render(); drain(); }
      };

      /* PROOF THE CLOCK SEES WORK. Two tests, both must pass.
         CALLS catches a reading that does not depend on how much was
         submitted. PIXELS is the one that exposed three drains as blind:
         command submission is identical at 1x, 4x and 16x the area and only
         the GPU's share changes. */
      const calibrate = () => {
        const s = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false });
        const one = () => { r.setRenderTarget(s); r.render(p.quadScene, p.quadCam); };
        const dpr0 = r.getPixelRatio();
        const fit = () => s.setSize(gl.drawingBufferWidth, gl.drawingBufferHeight);
        fit();
        const n = (k) => timeit(() => { for (let i = 0; i < k; i++) one(); }, { batches: 7 });
        const t1 = n(1).median, t2 = n(2).median, t4 = n(4).median;
        const area = [];
        for (const sc of [0.5, 1, 2]) {
          r.setPixelRatio(sc);
          p.setSize(innerWidth, innerHeight);
          fit();
          area.push({ scale: sc, size: [s.width, s.height], ms: n(1).median });
        }
        r.setPixelRatio(dpr0);
        p.setSize(innerWidth, innerHeight);
        s.dispose();
        const rc2 = t2 / Math.max(t1, 1e-9), rc4 = t4 / Math.max(t1, 1e-9);
        const ra4 = area[1].ms / Math.max(area[0].ms, 1e-9);
        const ra16 = area[2].ms / Math.max(area[0].ms, 1e-9);
        return {
          t1, t2, t4, ratio2: rc2, ratio4: rc4, area, ratioArea4: ra4, ratioArea16: ra16,
          callsOk: rc2 > 1.6 && rc2 < 2.6 && rc4 > 3.0 && rc4 < 5.4,
          pixelsOk: ra4 > 2.5 && ra16 > 8,
        };
      };

      /* HOW MANY TIMES IS THE SHADOW MAP DRAWN PER FRAME?
         Counted at the source rather than inferred: three's WebGLShadowMap
         instance is reachable as renderer.shadowMap and its render() is a
         plain function property, so it can be wrapped. `lights` empty means
         three returns before doing anything, so those calls are separated out
         — pipeline.render() makes two of them over the lightless quad and
         prepass scenes and they cost nothing. */
      const countPasses = () => {
        const sm = r.shadowMap;
        const real = sm.render;
        let all = 0, withLights = 0, drawn = 0, shadowTris = 0, shadowCalls = 0;
        let seenLights = null;
        sm.render = function (lights, scene, camera) {
          all++;
          if (lights && lights.length) { withLights++; seenLights = lights.slice(); }
          const t0 = r.info.render.triangles, c0 = r.info.render.calls;
          const out = real.call(this, lights, scene, camera);
          /* DRAWS, not calls, and the distinction is the whole point of this
             tool now. three is CALLED once per renderer.render() regardless;
             whether it does anything depends on its autoUpdate/needsUpdate gate
             at three.module.js:22384. Reporting the call count as the number of
             times the map was built is exactly the misreading this change is
             meant to end. */
          if (r.info.render.calls > c0) drawn++;
          shadowTris += r.info.render.triangles - t0;
          shadowCalls += r.info.render.calls - c0;
          return out;
        };
        /* info.autoReset resets the counters at the top of every render(), and
           three's reset happens AFTER the shadow pass — which is exactly why
           the shadow map is invisible to every triangle report in the tree,
           tools/tperf.mjs included. Held off here so it can be counted. */
        const auto0 = r.info.autoReset;
        r.info.autoReset = false;
        p.render();                 // discard: warm the counters and the clock
        r.info.reset();
        all = 0; withLights = 0; drawn = 0; shadowTris = 0; shadowCalls = 0;
        p.render();
        const total = { tris: r.info.render.triangles, calls: r.info.render.calls };
        /* Put three's own function back BEFORE anything else renders. An
           earlier revision of this tool left the wrapper installed and its
           final warm-up render was counted too, which reported the map drawn
           four times per frame instead of twice — a probe that doubled the
           defect it was measuring. */
        sm.render = real;
        r.info.autoReset = auto0;
        r.info.reset();
        p.render();
        return {
          calls: all, callsWithLights: withLights, mapsDrawn: drawn,
          shadowTris, shadowCalls,
          allPassTris: total.tris, allPassCalls: total.calls,
          sceneTris: p.stats.triangles, sceneCalls: p.stats.calls,
          /* Only the NAMES of the shadow-casting lights three assembled. The
             lights themselves are scene-graph nodes and putting one in the
             returned object makes JSON.stringify throw on the parent/children
             cycle — which it duly did, after printing a full correct table. */
          lightNames: seenLights ? seenLights.map(l => l.name || l.type) : [],
        };
      };

      const sun = g.sun;
      const setSize = (n) => {
        const clamped = Math.min(n, r.capabilities.maxTextureSize);
        /* three allocates the map lazily and only disposes it when the size
           it is asked for exceeds the hardware limit, so the old target has to
           be thrown away by hand or the map stays at whatever it was first
           built at and every "size" measures the same texture. */
        if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
        sun.shadow.mapSize.set(clamped, clamped);
        sun.shadow.needsUpdate = true;
        for (let i = 0; i < 3; i++) p.render();
        return clamped;
      };

      const stations = [];
      const at = (name, t) => { g.driveTo(t); stations.push({ name, t }); };

      /* Frozen: environment.js drives the ocean, the grass and the turbines
         from performance.now() inside onBeforeRender, so two renders of a
         "paused" scene are two different pictures. */
      const realNow = rawNow;
      const results = [];

      g.setPaused(true);
      burn(500);
      const cal = calibrate();
      const passes = countPasses();
      const maxTex = r.capabilities.maxTextureSize;

      for (const [name, t] of [['open', 0.30], ['coast', 0.62], ['tunnel', 0.44]]) {
        g.driveTo(t);
        g.setPaused(true);
        const frozen = realNow();
        performance.now = () => frozen;
        for (let i = 0; i < 4; i++) p.render();
        /* Per-station burn-in as well as the global one. Without it the FIRST
           size measured at each station carries the clock ramp that follows a
           driveTo, and its null pair came back at 0.15-0.30 ms against the
           0.02-0.03 ms the same station settles to. The floor caught that
           honestly rather than hiding it, but a floor ten times the real one
           throws away the reading. */
        burn(200);

        const sm = r.shadowMap;

        /* THE PASS COUNT IS FORCED AT three's OWN ENTRY POINT, not through
           autoUpdate. CelPipeline.render() now saves and restores autoUpdate
           for the duration of the method, so an external assignment to it is
           overwritten at the top of every frame and does nothing — an earlier
           revision of this tool set autoUpdate from out here and measured three
           configurations that were all secretly the same one. Gating
           shadowMap.render itself cannot be overridden by the code under test.
           `none` returns without calling three at all; `twice` raises the flag
           on the way in so every lit pass renders, which is exactly what
           autoUpdate = true means; `once` is the shipped path untouched. */
        const real = sm.render;
        let mode = 'once', drawn = 0;
        sm.render = function (lights, scene, camera) {
          if (mode === 'none') return undefined;
          if (mode === 'twice') sm.needsUpdate = true;
          const c0 = r.info.render.calls;
          const out = real.call(this, lights, scene, camera);
          if (r.info.render.calls > c0) drawn++;
          return out;
        };
        const at = (m) => () => { mode = m; p.render(); };
        const twice = at('twice'), once = at('once'), none = at('none');

        /* Confirm each configuration really renders the map the number of
           times its name claims, before any of them is timed. */
        const passesIn = (m) => {
          const auto = r.info.autoReset;
          r.info.autoReset = false;
          mode = m; p.render();
          drawn = 0; p.render();
          const k = drawn;
          r.info.autoReset = auto; r.info.reset();
          return k;
        };

        const row = { name, t, s: g.player.s, sizes: [] };
        row.passes = { none: passesIn('none'), once: passesIn('once'), twice: passesIn('twice') };

        for (const n of sizes) {
          const clamped = setSize(n);
          /* THE NOISE FLOOR, per size, measured as a null pair: the same
             configuration against itself. Whatever this reads is what the
             instrument cannot distinguish from zero at this station. */
          const floor = pairedDiff(once, once);
          const onePass = pairedDiff(once, none);
          const twoPass = pairedDiff(twice, none);
          mode = 'once';
          p.render();

          const bytes = clamped * clamped * 5;  // RGBA8 colour + a depth buffer
          row.sizes.push({
            want: n, got: clamped,
            floorMs: Math.abs(floor.median),
            floorSpread: floor.q75 - floor.q25,
            onePassMs: onePass.median, onePassQ: [onePass.q25, onePass.q75],
            twoPassMs: twoPass.median, twoPassQ: [twoPass.q25, twoPass.q75],
            frameOnceMs: onePass.aMedian, frameTwiceMs: twoPass.aMedian,
            frameNoneMs: onePass.bMedian,
            reps: onePass.reps,
            megabytes: bytes / 1048576,
          });
        }
        sm.render = real;
        mode = 'once';
        p.render();
        performance.now = realNow;
        results.push(row);
      }

      scratch.dispose();
      return {
        cal, passes, maxTex,
        pixelRatio: r.getPixelRatio(),
        buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        shadowDist: Math.abs(g.sun.shadow.camera.left),
        tier: g.tier,
        results,
      };
    }, { sizes: SIZES });

    const c = out.cal;
    console.log(`\n  adapter buffer ${out.buffer.join('x')}  maxTexture ${out.maxTex}`
      + `  tier ${out.tier}  shadowDist ${out.shadowDist}`);
    console.log('\n  ── clock calibration (a blind clock prints nothing below) ──');
    console.log(`  composite x1/x2/x4 calls : ${c.t1.toFixed(4)} ${c.t2.toFixed(4)} ${c.t4.toFixed(4)} ms`
      + `   ratios ${c.ratio2.toFixed(2)} ${c.ratio4.toFixed(2)}  want ~2 ~4  ${c.callsOk ? 'PASS' : 'FAIL'}`);
    for (const a of c.area) console.log(`    area ${a.size.join('x').padStart(11)}  ${a.ms.toFixed(4)} ms`);
    console.log(`  area x4/x16 ratios       : ${c.ratioArea4.toFixed(2)} ${c.ratioArea16.toFixed(2)}`
      + `  want >2.5 >8  ${c.pixelsOk ? 'PASS' : 'FAIL'}`);
    if (!c.callsOk || !c.pixelsOk) {
      console.log('\n  ✗ the clock does not respond to work. No timing is reported.');
      process.exitCode = 1;
      return;
    }

    const ps = out.passes;
    console.log(`\n  shadow pass per pipeline.render(): ${ps.calls} calls,`
      + ` ${ps.callsWithLights} over a scene with lights,`
      + ` and the map is actually BUILT ${ps.mapsDrawn} time(s)`);
    if (ps.mapsDrawn > 1) {
      console.log(`  → ${ps.mapsDrawn} builds for one picture — the double render is present`);
    } else {
      console.log('  → one build per picture');
    }
    console.log(`  triangles: scene (beauty) ${ps.sceneTris} in ${ps.sceneCalls} calls;`
      + ` shadow ${ps.shadowTris} in ${ps.shadowCalls} calls;`
      + ` all passes ${ps.allPassTris} in ${ps.allPassCalls}`
      + ` (${(ps.allPassTris / Math.max(1, ps.sceneTris)).toFixed(2)}x the scene)`);

    const k = 1 / Math.sin(Math.atan2(SUN[1], Math.hypot(SUN[0], SUN[2])));
    const span = 2 * out.shadowDist;

    /* A figure smaller than the null pair at the same station is not a
       measurement, and printing it as one is how the negative costs got into
       the last revision's table. */
    const fmt = (v, floor) => (Math.abs(v) < floor ? `<${floor.toFixed(3)}` : v.toFixed(3));

    /* If a configuration does not render the map the number of times its
       column heading claims, every figure in that row is a measurement of
       something else. */
    for (const row of out.results) {
      const q = row.passes;
      if (q.none !== 0 || q.once !== 1 || q.twice !== 2) {
        console.log(`\n  ✗ ${row.name}: shadow passes measured as none=${q.none}`
          + ` once=${q.once} twice=${q.twice}, wanted 0/1/2 — the configurations are`
          + ' not what they claim and this station is not reported');
        process.exitCode = 1;
      }
    }

    for (const row of out.results) {
      console.log(`\n  ── ${row.name}  t=${row.t}  s=${row.s.toFixed(0)} m`
        + `   passes none/once/twice = ${row.passes.none}/${row.passes.once}/${row.passes.twice} ──`);
      console.log('  map    texel-map  texel-road   one pass    two pass    floor'
        + '   frame x2   frame x1   frame x0    memory');
      for (const s of row.sizes) {
        const tex = (span / s.got) * 100;
        const fl = Math.max(s.floorMs, s.floorSpread / 2);
        console.log(`  ${String(s.got).padStart(4)} ${tex.toFixed(2).padStart(9)} cm`
          + ` ${(tex * k).toFixed(2).padStart(8)} cm`
          + ` ${fmt(s.onePassMs, fl).padStart(10)} ${fmt(s.twoPassMs, fl).padStart(11)}`
          + ` ${fl.toFixed(3).padStart(8)}`
          + ` ${s.frameTwiceMs.toFixed(2).padStart(10)} ${s.frameOnceMs.toFixed(2).padStart(10)}`
          + ` ${s.frameNoneMs.toFixed(2).padStart(10)} ${s.megabytes.toFixed(1).padStart(7)} MB`);
      }
    }

    console.log('\n  "one pass" and "two pass" are PAIRED differences against the same frame'
      + '\n  with the shadow pass held — interleaved A B A B, median of the per-round'
      + '\n  gaps, so drift cancels. "floor" is the same configuration paired against'
      + '\n  ITSELF at that station: anything inside it is printed as "<floor" because'
      + '\n  it is not distinguishable from zero. "frame x2" is the frame as it ships.');

    const file = path.join(ROOT, '.fix', 'sh-cost.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 1));
    console.log(`\n  → ${path.relative(ROOT, file)}`);
  });

finish(process.exitCode || 0);
