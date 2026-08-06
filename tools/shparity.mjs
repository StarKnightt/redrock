/* Is rendering the shadow map ONCE per frame instead of twice a pixel no-op?
 *
 *   node tools/shparity.mjs [--seed 22]
 *
 * CelPipeline.render() makes two renderer.render() calls over a scene that has
 * lights, and three runs its shadow pass at the top of every one of them, so
 * the map was built twice for one picture. The fix sets
 * renderer.shadowMap.autoUpdate = false for the duration of the method and
 * raises needsUpdate once, immediately before the beauty pass. This tool has
 * to prove that changes nothing, not argue it.
 *
 * WHY THE A/B IS IN ONE PROCESS. The stage animates and two runs of the same
 * capture never agree to the byte, so a before/after across two processes
 * cannot answer this. Both halves are rendered from the same frozen frame in
 * the same process, and the old behaviour is restored simply by putting
 * autoUpdate back to true — under which the pipeline's needsUpdate line
 * becomes a no-op, because autoUpdate = true already renders the map on every
 * pass. So the two configurations really are the shipped code and the previous
 * code, not an approximation of either.
 *
 * FOUR CHECKS, and all four have to pass.
 *
 *   1. PASS COUNT. Two lit shadow passes before, one after. If this does not
 *      move, nothing else in the file matters.
 *   2. CONTROL. The same configuration rendered twice must be bit-identical,
 *      or the frame is not reproducible and no comparison means anything.
 *   3. PARITY. One-pass and two-pass frames, byte for byte, at five stations.
 *   4. THE WALL-CLOCK HAZARD, which is the only route by which the two passes
 *      could ever have produced different maps, and which the project's own
 *      pinned-clock convention HIDES.
 *
 * ABOUT CHECK 4. src/world/environment.js drives the ocean, the shore foam and
 * the roadside grass from performance.now() inside onBeforeRender. The shadow
 * pass calls onBeforeShadow, not onBeforeRender, so the first shadow pass of a
 * frame sees whatever uTime the PREVIOUS frame's beauty pass left, while the
 * second sees the value this frame's normals prepass just wrote. If any shadow
 * caster displaced its geometry from that uniform, the two maps would differ
 * and collapsing to one would change the picture. Pinning the clock — which
 * every other capture in this tree correctly does — makes both passes agree
 * trivially and proves nothing about it.
 *
 * So the shadow map's own bytes are read back at one clock value, the clock is
 * advanced by a frame, a scene pass is run so every onBeforeRender fires, and
 * the map is rendered and read back again. If those two readbacks are
 * identical, no shadow caster depends on the wall clock and the hazard is
 * closed for good. The map is an ordinary RGBA8 WebGLRenderTarget with
 * RGBADepthPacking, so it can be read directly.
 *
 * A tool that only ever compares things that are equal cannot fail, so check 3
 * carries a positive control: the same comparator is pointed at a frame with a
 * deliberately different shadow map size, and must report a difference.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, settleBoot, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', 22);

const outDir = path.join(ROOT, 'shots', 'shadow-parity');
fs.mkdirSync(outDir, { recursive: true });

await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=60&hud=0` },
  async ({ page }) => {
    await settleBoot(page);

    const out = await page.evaluate(async () => {
      const g = window.__game;
      const r = g.renderer, p = g.pipeline;
      const gl = r.getContext();
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;

      const read = () => {
        p.render();
        const b = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, b);
        return b;
      };

      const compare = (a, b) => {
        let first = -1, count = 0, worst = 0;
        for (let i = 0; i < a.length; i++) {
          if (a[i] === b[i]) continue;
          if (first < 0) first = i;
          count++;
          const d = Math.abs(a[i] - b[i]);
          if (d > worst) worst = d;
        }
        return { first, count, worst };
      };

      /* HOW THE OLD BEHAVIOUR IS REINSTATED, and why the obvious way does not
         work any more.
         The first version of this tool restored the double render by setting
         renderer.shadowMap.autoUpdate = true from outside. That WAS the old
         behaviour when autoUpdate was going to be set once at construction —
         but the change as shipped saves and restores autoUpdate inside
         CelPipeline.render(), so an external assignment is overwritten at the
         top of the method and has no effect at all. The tool duly reported
         every station "identical" while comparing the new path against itself.
         The pass count below is what caught it, which is the entire reason a
         parity tool is not allowed to consist only of comparisons that are
         expected to match.
         What reinstates it instead is forcing the flag back up on the way IN to
         every shadow pass, which makes each one render unconditionally — which
         is precisely what autoUpdate = true means. That works whatever the code
         under test does with autoUpdate.
         Draws are counted rather than calls: three returns early at
         `lights.length === 0` for the composite quad and the opt-in prepass,
         and at `autoUpdate === false && needsUpdate === false` for a pass it
         has been told to skip, so counting entries would report calls and not
         work. */
      const instrument = (force) => {
        const sm = r.shadowMap;
        const real = sm.render;
        let drawn = 0;
        sm.render = function (lights, scene, camera) {
          if (force) sm.needsUpdate = true;
          const c0 = r.info.render.calls;
          const out = real.call(this, lights, scene, camera);
          if (r.info.render.calls > c0) drawn++;
          return out;
        };
        return {
          zero: () => { drawn = 0; },
          drawn: () => drawn,
          restore: () => { sm.render = real; },
        };
      };

      const countLitPasses = (force) => {
        const inst = instrument(force);
        const auto = r.info.autoReset;
        r.info.autoReset = false;         // three resets AFTER the shadow pass
        p.render();                       // warm, discarded
        inst.zero();
        p.render();
        const n = inst.drawn();
        inst.restore();                   // three's own function back FIRST
        r.info.autoReset = auto;
        r.info.reset();
        return n;
      };

      const stations = [
        ['open', 0.30], ['coast', 0.62], ['mid-stage', 0.46],
        ['tunnel-portal', null], ['tunnel-mid', null],
      ];
      const tun = g.field?.tunnel, L = g.track.length;
      if (tun) {
        stations[3][1] = (tun.s0 - 25) / L;
        stations[4][1] = ((tun.s0 + tun.s1) / 2) / L;
      }

      const rows = [];
      let passesOnce = null, passesTwice = null, clockCheck = null, positive = null;

      for (const [name, t] of stations) {
        if (t === null) continue;
        g.driveTo(t);
        g.setPaused(true);

        const realNow = performance.now.bind(performance);
        const frozen = realNow();
        performance.now = () => frozen;

        for (let i = 0; i < 4; i++) p.render();   // frame 0 and the map settle

        /* ── 1. pass count, both ways ── */
        if (passesOnce === null) {
          passesOnce = countLitPasses(false);                   // shipped code
          passesTwice = countLitPasses(true);                   // previous code
        }

        /* ── 2 and 3. control, then parity ── */
        for (let i = 0; i < 2; i++) p.render();
        const once = read();
        const control = read();
        const inst = instrument(true);
        read();                                                 // discard first
        const twice = read();
        inst.restore();
        read();

        /* ── positive control: prove the comparator can see a shadow change ── */
        if (positive === null) {
          const s0 = g.sun.shadow.mapSize.x;
          if (g.sun.shadow.map) { g.sun.shadow.map.dispose(); g.sun.shadow.map = null; }
          g.sun.shadow.mapSize.set(1024, 1024);
          g.sun.shadow.needsUpdate = true;
          for (let i = 0; i < 3; i++) p.render();
          const coarse = read();
          if (g.sun.shadow.map) { g.sun.shadow.map.dispose(); g.sun.shadow.map = null; }
          g.sun.shadow.mapSize.set(s0, s0);
          g.sun.shadow.needsUpdate = true;
          for (let i = 0; i < 3; i++) p.render();
          positive = { station: name, ...compare(once, coarse) };
        }

        /* ── 4. does the shadow map depend on the wall clock? ── */
        if (clockCheck === null) {
          const map = g.sun.shadow.map;
          const mw = map.width, mh = map.height;
          const grab = () => {
            /* Sampled rather than read whole: an 8192 map is 268 megabytes of
               RGBA and reading it in one go is minutes of transfer. A regular
               stride over the middle of the map covers every caster in the
               frustum. */
            const step = Math.max(1, Math.floor(mh / 256));
            const rows2 = [];
            const buf = new Uint8Array(mw * 4);
            const prev = r.getRenderTarget();
            r.setRenderTarget(map);
            for (let y = 0; y < mh; y += step) {
              gl.readPixels(0, y, mw, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
              let h = 2166136261;
              for (let i = 0; i < buf.length; i++) { h ^= buf[i]; h = Math.imul(h, 16777619); }
              rows2.push(h >>> 0);
            }
            r.setRenderTarget(prev);
            return rows2;
          };
          r.shadowMap.needsUpdate = true;
          p.render();
          const atT0 = grab();
          /* Advance the clock a frame and run a full scene pass, so every
             onBeforeRender in the stage fires with the new value. */
          performance.now = () => frozen + 16.7;
          p.render();
          r.shadowMap.needsUpdate = true;
          p.render();
          const atT1 = grab();
          performance.now = () => frozen;
          let differing = 0;
          for (let i = 0; i < atT0.length; i++) if (atT0[i] !== atT1[i]) differing++;
          clockCheck = { rowsSampled: atT0.length, rowsDiffering: differing, mapSize: [mw, mh] };
        }

        performance.now = realNow;

        rows.push({
          name, t, s: g.player.s,
          control: compare(once, control),
          parity: compare(once, twice),
        });
      }

      return {
        W, H, pixels: W * H,
        passesOnce, passesTwice, positive, clockCheck, rows,
        mapSize: g.sun.shadow.mapSize.x, tier: g.tier,
      };
    });

    console.log(`\n  ${out.W}x${out.H}  tier ${out.tier}  shadow map ${out.mapSize}`);
    console.log(`\n  lit shadow passes per pipeline.render():`
      + `  as shipped ${out.passesOnce}   with autoUpdate forced back on ${out.passesTwice}`);

    let ok = true;
    if (out.passesOnce !== 1 || out.passesTwice !== 2) {
      console.log('  ✗ expected 1 and 2. The mechanism is not doing what it claims.');
      ok = false;
    } else {
      console.log('  ✓ the map is built once per frame instead of twice');
    }

    const pc = out.positive;
    console.log(`\n  positive control (${pc.station}, map forced to 1024):`
      + ` ${pc.count} bytes differ, worst ${pc.worst}`);
    if (pc.count === 0) {
      console.log('  ✗ the comparator cannot see a shadow map change. Every'
        + ' "identical" below is meaningless.');
      ok = false;
    } else {
      console.log('  ✓ the comparator responds to a shadow map change');
    }

    const cc = out.clockCheck;
    console.log(`\n  wall-clock dependence of the shadow map itself`
      + ` (${cc.mapSize.join('x')}, ${cc.rowsSampled} rows sampled):`
      + ` ${cc.rowsDiffering} rows change when the clock advances one frame`);
    if (cc.rowsDiffering !== 0) {
      console.log('  ✗ the shadow map DOES depend on the wall clock, so the two'
        + ' passes were producing different maps and this change is NOT a no-op.');
      ok = false;
    } else {
      console.log('  ✓ no shadow caster reads the wall clock — the two passes'
        + ' could only ever have produced the same map');
    }

    console.log('\n  station          s (m)   control        one-pass vs two-pass');
    for (const r of out.rows) {
      const c = r.control.count === 0 ? 'identical' : `${r.control.count} DIFFER`;
      const pr = r.parity.count === 0
        ? 'identical'
        : `${r.parity.count} bytes differ, worst ${r.parity.worst}, first at ${r.parity.first}`;
      console.log(`  ${r.name.padEnd(15)} ${r.s.toFixed(0).padStart(6)}   ${c.padEnd(14)} ${pr}`);
      if (r.control.count !== 0 || r.parity.count !== 0) ok = false;
    }

    console.log(ok
      ? `\n  PASS  ${out.pixels} pixels identical at every station, one shadow pass`
        + ' against two'
      : '\n  FAIL  see above');
    if (!ok) process.exitCode = 1;

    await capture(page, path.join(outDir, 'one-pass.png'));
    console.log('  → shots/shadow-parity');
  });

finish(process.exitCode || 0);
