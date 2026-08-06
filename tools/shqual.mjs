/* What the shadow map size costs the PICTURE, frame-wide and where the eye is.
 *
 *   node tools/shqual.mjs [--seed 22] [--sizes 1536,2048,4096,8192]
 *
 * The cost half of the shadow-map decision is in tools/shcost.mjs. This is the
 * other half, and it exists because a whole-frame pixel percentage is close to
 * useless on its own: the mobile round measured 8192 -> 1536 as changing "0.41%
 * of pixels", which is true and tells you nothing about whether the shadow
 * under the car fell apart, because the shadow is a small part of the frame.
 *
 * So three things are measured rather than one.
 *
 * 1. FRAME-WIDE difference against the shipped 8192, as a control on the
 *    others.
 *
 * 2. THE SAME DIFFERENCE INSIDE THE SHADOWED REGION ONLY. The region is not
 *    guessed: `sun.shadow.intensity = 0` removes the shadow term through a
 *    uniform three already has, and the pixels that move ARE the shadow's
 *    footprint. A second mask does the same for the car's own casters alone,
 *    which is the contact shadow the whole "car is sitting on the road"
 *    reading depends on. Intensity rather than `castShadow`, because toggling
 *    castShadow changes three's shadow count and recompiles every program in
 *    the scene — a different picture for a second reason.
 *
 * 3. MOTION, which a still comparison cannot see and which matters more here
 *    than either of the above. A cel frame is banded flat colour and thick
 *    ink; a shadow edge that crawls or shimmers as the car moves is a worse
 *    outcome than a slow frame.
 *
 *    HOW THE MOTION TEST WORKS, AND WHY IT IS NOT "DRIVE AND DIFF FRAMES".
 *    Driving changes every pixel legitimately, so a frame difference measures
 *    the drive, not the shadow. Instead the car, the camera and the clock are
 *    all frozen and ONLY the sun's shadow frustum is nudged along the road, in
 *    steps small compared to a shadow texel. The frustum tracks the car with
 *    no texel snapping (src/main.js:1177), so this reproduces exactly the
 *    sliding a player sees — and because everything else is frozen, THE
 *    CORRECT IMAGE IS UNCHANGED AND EVERY CHANGED PIXEL IS CRAWL.
 *
 *    The number that matters is not how many pixels move but how EVENLY.
 *    A fine map slides the edge a little on every step. A coarse map holds the
 *    edge still for two or three steps and then jumps a whole texel's width at
 *    once, which is the staircase visibly crawling. So the tool reports the
 *    per-step churn and its peak-to-mean ratio: 1.0 is a smooth slide, and the
 *    larger it gets the more the edge is snapping between texels.
 *
 * Conventions, all of them load-bearing and all of them established by earlier
 * rounds in this tree: settleBoot() before anything, performance.now() pinned
 * (environment.js drives the ocean, the shore foam and the grass from the wall
 * clock inside onBeforeRender, so two renders of a "paused" scene are two
 * different pictures), frame 0 discarded, and a control pair that must come
 * back bit-identical or the run is void.
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
const SIZES = flag('sizes', '1536,2048,4096,8192').split(',').map(Number);
const REF = +flag('ref', 8192);
const STEPS = +flag('steps', 8);
const STEP_M = +flag('stepm', 0.05);      // metres of frustum travel per step

const outDir = path.join(ROOT, 'shots', 'shadow-qual');
fs.mkdirSync(outDir, { recursive: true });

await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=60&hud=0` },
  async ({ page }) => {
    await settleBoot(page);

    const out = await page.evaluate(async ({ sizes, ref, steps, stepM }) => {
      const g = window.__game;
      const r = g.renderer, p = g.pipeline;
      const gl = r.getContext();
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      const N = W * H;

      const readFrame = () => {
        p.render();
        const b = new Uint8Array(N * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, b);
        return b;
      };

      /* three allocates the shadow map lazily and only replaces it when the
         requested size exceeds the hardware limit, so the old target has to be
         thrown away by hand or every "size" measures the same texture. */
      const setSize = (n) => {
        const c = Math.min(n, r.capabilities.maxTextureSize);
        if (g.sun.shadow.map) { g.sun.shadow.map.dispose(); g.sun.shadow.map = null; }
        g.sun.shadow.mapSize.set(c, c);
        g.sun.shadow.needsUpdate = true;
        for (let i = 0; i < 3; i++) p.render();
        return c;
      };

      /* Any channel off by more than `th`. 2/255 is the threshold the mobile
         round used and is kept so the two documents' figures compare. */
      const diff = (a, b, mask, th) => {
        let n = 0, sum = 0, worst = 0, tested = 0;
        for (let i = 0, q = 0; i < a.length; i += 4, q++) {
          if (mask && !mask[q]) continue;
          tested++;
          const dr = Math.abs(a[i] - b[i]), dg = Math.abs(a[i + 1] - b[i + 1]),
            db = Math.abs(a[i + 2] - b[i + 2]);
          const m = Math.max(dr, dg, db);
          if (m > worst) worst = m;
          const dy = Math.abs((0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2])
            - (0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2]));
          sum += dy;
          if (m > th) n++;
        }
        return {
          tested,
          pct: tested ? (100 * n) / tested : 0,
          meanLuma: tested ? sum / tested : 0,
          worst,
        };
      };

      const bytesEqual = (a, b) => {
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
        return -1;
      };

      /* A boolean mask of the pixels a term is responsible for, built by
         removing the term and seeing what moves. */
      const maskFrom = (base, off, th) => {
        const m = new Uint8Array(N);
        let n = 0;
        for (let i = 0, q = 0; i < base.length; i += 4, q++) {
          const d = Math.max(Math.abs(base[i] - off[i]), Math.abs(base[i + 1] - off[i + 1]),
            Math.abs(base[i + 2] - off[i + 2]));
          if (d > th) { m[q] = 1; n++; }
        }
        return { mask: m, count: n, pct: (100 * n) / N };
      };

      const carMeshes = [];
      g.playerView.root.traverse(o => { if (o.isMesh && o.castShadow) carMeshes.push(o); });

      /* The road tangent at the car, so the frustum is nudged along the
         direction the car is actually travelling. */
      const roadDir = () => {
        const a = g.track.pointAt(Math.max(0, g.player.s - 5));
        const b = g.track.pointAt(g.player.s + 5);
        const dx = b.x - a.x, dz = b.z - a.z;
        const L = Math.hypot(dx, dz) || 1;
        return { x: dx / L, z: dz / L };
      };

      /* The bore is at s ~5064-5199, i.e. t ~0.90-0.93. An earlier note in
         .fix/FINDINGS-shadow.md called t=0.44 "the tunnel"; it is not, it is
         open road at s=2463. Taken off g.field.tunnel here so it cannot be got
         wrong again. Both the middle of the bore and the approach to the
         portal are sampled: the middle turns out to have no shadow EDGE in
         frame at all, which is a real result but would be a silent zero if it
         were the only tunnel station measured. */
      const tun = g.field?.tunnel;
      const L = g.track.length;
      const STATIONS = [
        ['open', 0.30],
        ['coast', 0.62],
        ['mid-stage', 0.46],
        ...(tun ? [
          ['tunnel-portal', (tun.s0 - 25) / L],
          ['tunnel-mid', ((tun.s0 + tun.s1) / 2) / L],
        ] : []),
      ];

      const shots = {};
      const results = [];
      let controlFail = null;

      for (const [name, t] of STATIONS) {
        g.driveTo(t);
        g.setPaused(true);
        const realNow = performance.now.bind(performance);
        const frozen = realNow();
        performance.now = () => frozen;

        setSize(ref);
        readFrame();                       // frame 0, discarded
        const base = readFrame();
        const control = readFrame();
        const cf = bytesEqual(base, control);
        if (cf !== -1 && controlFail === null) controlFail = { station: name, index: cf };

        /* Masks. Uniform-only changes, so nothing recompiles and nothing but
           the shadow term moves. */
        const i0 = g.sun.shadow.intensity;
        g.sun.shadow.intensity = 0;
        const noShadow = readFrame();
        g.sun.shadow.intensity = i0;
        const sun = maskFrom(base, noShadow, 2);

        const was = carMeshes.map(m => m.castShadow);
        carMeshes.forEach(m => { m.castShadow = false; });
        g.sun.shadow.needsUpdate = true;
        const noCar = readFrame();
        carMeshes.forEach((m, i) => { m.castShadow = was[i]; });
        g.sun.shadow.needsUpdate = true;
        readFrame();
        const car = maskFrom(base, noCar, 2);

        const row = { name, t, s: g.player.s, sunMaskPct: sun.pct, carMaskPct: car.pct, sizes: [] };

        /* ── stills ── */
        const frames = {};
        for (const n of sizes) {
          const got = setSize(n);
          readFrame();
          frames[got] = readFrame();
        }
        const refFrame = frames[Math.min(ref, 16384)];
        for (const n of sizes) {
          const got = Math.min(n, 16384);
          const f = frames[got];
          row.sizes.push({
            size: got,
            frame: diff(f, refFrame, null, 2),
            inSun: diff(f, refFrame, sun.mask, 2),
            inCar: car.count > 50 ? diff(f, refFrame, car.mask, 2) : null,
            frameHard: diff(f, refFrame, null, 8),
            inSunHard: diff(f, refFrame, sun.mask, 8),
          });
        }

        /* ── motion: nudge only the shadow frustum ── */
        const dir = roadDir();
        const sunPos0 = g.sun.position.clone();
        const tgt0 = g.sun.target.position.clone();
        for (const entry of row.sizes) {
          setSize(entry.size);
          const seq = [];
          for (let k = 0; k <= steps; k++) {
            const d = k * stepM;
            g.sun.position.set(sunPos0.x + dir.x * d, sunPos0.y, sunPos0.z + dir.z * d);
            g.sun.target.position.set(tgt0.x + dir.x * d, tgt0.y, tgt0.z + dir.z * d);
            g.sun.target.updateMatrixWorld();
            g.sun.updateMatrixWorld();
            g.sun.shadow.needsUpdate = true;
            readFrame();                   // settle the new frustum
            seq.push(readFrame());
          }
          g.sun.position.copy(sunPos0);
          g.sun.target.position.copy(tgt0);
          g.sun.target.updateMatrixWorld();
          g.sun.updateMatrixWorld();

          /* Per-step churn inside the shadow's own footprint, and how many
             pixels the whole sequence ever touched. */
          const per = [];
          const touched = new Uint8Array(N);
          for (let k = 1; k < seq.length; k++) {
            let n = 0;
            const a = seq[k - 1], b = seq[k];
            for (let i = 0, q = 0; i < a.length; i += 4, q++) {
              if (!sun.mask[q]) continue;
              const m = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]),
                Math.abs(a[i + 2] - b[i + 2]));
              if (m > 2) { n++; touched[q] = 1; }
            }
            per.push(n);
          }
          let touchedN = 0;
          for (let q = 0; q < N; q++) if (touched[q]) touchedN++;
          const mean = per.reduce((s, v) => s + v, 0) / Math.max(1, per.length);
          const max = Math.max(...per);
          entry.motion = {
            perStep: per,
            meanPerStep: mean,
            maxPerStep: max,
            /* Churn as a FRACTION OF THE SHADOWED REGION, which is the form
               that compares across stations — the raw pixel count is mostly a
               statement about how much of the frame is in shadow. This is the
               headline motion number: the share of the shadow that flickers
               per step of travel with everything else frozen. */
            churnPct: sun.count ? (100 * mean) / sun.count : 0,
            /* Peak-to-mean. MEASURED AND IT DOES NOT DISCRIMINATE — it comes
               back at 1.0-1.1 for every size (see FINDINGS-shadow.md), because
               the churn is not confined to the boundary staircase: a nudged
               frustum re-quantises the whole shadow footprint, not just its
               edge. Kept because a reading that refuses to separate the cases
               is worth recording as such rather than quietly dropping. */
            jerk: mean > 0 ? max / mean : 0,
            touchedPct: (100 * touchedN) / Math.max(1, sun.count),
          };
        }

        setSize(ref);
        readFrame();
        shots[name] = {};
        for (const n of sizes) {
          setSize(n);
          readFrame(); readFrame();
          shots[name][n] = r.domElement.toDataURL('image/png');
        }

        performance.now = realNow;
        results.push(row);
      }

      return { W, H, controlFail, results, shots, maxTex: r.capabilities.maxTextureSize };
    }, { sizes: SIZES, ref: REF, steps: STEPS, stepM: STEP_M });

    for (const [station, byN] of Object.entries(out.shots)) {
      for (const [n, url] of Object.entries(byN)) {
        fs.writeFileSync(path.join(outDir, `${station}-${n}.png`),
          Buffer.from(url.split(',')[1], 'base64'));
      }
    }

    console.log(`\n  ${out.W}x${out.H}  reference ${REF}  maxTexture ${out.maxTex}`);
    if (out.controlFail) {
      console.log(`  ✗ CONTROL PAIR DIFFERS at ${out.controlFail.station},`
        + ` byte ${out.controlFail.index} — the frame is not reproducible and no`
        + ' figure below can be trusted');
      process.exitCode = 1;
    } else {
      console.log('  ✓ control pair bit-identical at every station');
    }

    /* A comparator that cannot see the shadow at all would report an empty
       mask and silently divide by nothing. */
    const blind = out.results.filter(r => r.sunMaskPct < 0.5);
    if (blind.length) {
      console.log(`  ✗ shadow mask under 0.5% of the frame at: ${blind.map(r => r.name).join(', ')}`
        + ' — the shadow term is not reaching the picture, so nothing is being measured');
      process.exitCode = 1;
    }

    for (const row of out.results) {
      console.log(`\n  ── ${row.name}  t=${row.t.toFixed(3)}  s=${row.s.toFixed(0)} m`
        + `   shadow ${row.sunMaskPct.toFixed(2)}% of frame`
        + `   car's own shadow ${row.carMaskPct.toFixed(3)}% ──`);
      console.log('  map    frame >2   in-shadow >2   in-shadow >8   mean dY   worst'
        + '   car shadow >2    crawl %shadow   px/step   jerk');
      for (const s of row.sizes) {
        const m = s.motion;
        console.log(`  ${String(s.size).padStart(4)}`
          + ` ${s.frame.pct.toFixed(3).padStart(9)}%`
          + ` ${s.inSun.pct.toFixed(2).padStart(13)}%`
          + ` ${s.inSunHard.pct.toFixed(2).padStart(14)}%`
          + ` ${s.inSun.meanLuma.toFixed(2).padStart(9)}`
          + ` ${String(s.inSun.worst).padStart(7)}`
          + ` ${(s.inCar ? s.inCar.pct.toFixed(2) + '%' : '   n/a').padStart(14)}`
          + ` ${m.churnPct.toFixed(2).padStart(15)}%`
          + ` ${m.meanPerStep.toFixed(0).padStart(9)}`
          + ` ${m.jerk.toFixed(2).padStart(6)}`);
      }
    }

    console.log('\n  "in-shadow" is restricted to the pixels the shadow term is'
      + '\n  responsible for, found by zeroing shadow.intensity and differencing.'
      + `\n  "crawl %shadow" is the share of the shadowed region that changes per`
      + `\n  ${STEP_M * 100} cm of shadow-frustum travel with the car, camera and clock ALL`
      + '\n  frozen — so the correct picture is unchanged and every one of those'
      + '\n  pixels is crawl. THIS IS THE MOTION NUMBER. "jerk" (peak/mean churn)'
      + '\n  was meant to separate a sliding edge from a snapping one and does not:'
      + '\n  it reads 1.0-1.1 at every size, because a nudged frustum re-quantises'
      + '\n  the whole footprint rather than only its boundary.');

    const file = path.join(ROOT, '.fix', 'sh-qual.json');
    const slim = { ...out, shots: undefined };
    fs.writeFileSync(file, JSON.stringify(slim, null, 1));
    console.log(`\n  → ${path.relative(ROOT, file)}  and shots/shadow-qual/`);
  });

finish(process.exitCode || 0);
