/* The chapter arc along the whole lap, and whether the finish gate is inside
 * the tunnel's exit aperture.
 *
 * Two measurements, taken at the same stations in the same pass so they cannot
 * disagree about where they were:
 *
 *   LUMA  mean frame luma through the real pipeline, driven in rather than
 *         parked (tools/tunnelshot.mjs's method, widened from the 90 m either
 *         side of the bore to the whole stage). This is the curve that "0.54 on
 *         open coast down to 0.275 in the bore" is a claim about, and it can
 *         only be checked at stage scale.
 *
 *   GATE  how much of the finish arch is on screen, by rendering the frame
 *         twice with `gate-finish` shown and hidden and counting the pixels
 *         that change. A projection test answers "is the arch in the frustum",
 *         which is a different and much weaker question than "can it be seen" —
 *         on this stage the thing in the way is usually a mountain.
 *
 * Render-differencing discipline, all of it required here rather than
 * decorative: `performance.now` is pinned for the pair, because the grass
 * shader sways on it and two renders of a static scene differ without it; the
 * first render after arriving is discarded; and the pair is rendered back to
 * back so nothing between them can move.
 *
 *   node tools/qtgate.mjs [--seed 22] [--step 100]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = Number(flag('seed', '22'));
const STEP = Number(flag('step', '100'));

await run({ width: 1024, height: 576, hash: `manual&tier=high&seed=${SEED}&cap=60&hud=0` },
  async ({ page }) => {
    const info = await page.evaluate(() => {
      const g = window.__game;
      g.setPaused(true);
      const env = g.scene.getObjectByName('environment');
      const tun = env?.userData?.tunnel ?? null;
      return {
        L: g.track.length, finishS: g.track.finishS, gateS: g.track.gateS,
        tunnel: tun && { s0: tun.s0, s1: tun.s1 },
        hasGate: !!g.scene.getObjectByName('gate-finish'),
      };
    });
    if (!info.hasGate) { console.log('  no gate-finish in the scene'); return; }
    console.log(`\n  seed ${SEED}   L ${info.L.toFixed(0)}   finish ${info.finishS.toFixed(0)}`
      + `   gate ${info.gateS.toFixed(0)}   bore ${info.tunnel
        ? info.tunnel.s0.toFixed(0) + '–' + info.tunnel.s1.toFixed(0) : 'none'}`);

    /* Even coverage for the arc, plus every 10 m from a hundred metres before
       the bore to a hundred past the flag, because the gate question lives
       there and 100 m steps would step straight over the aperture. */
    const stations = new Set();
    for (let s = 60; s < info.L - 20; s += STEP) stations.add(Math.round(s));
    if (info.tunnel) {
      for (let s = info.tunnel.s0 - 100; s <= info.L - 20; s += 10) stations.add(Math.round(s));
    }
    const list = [...stations].sort((a, b) => a - b);

    const rows = [];
    for (const s of list) {
      rows.push(await page.evaluate(async ([t, station]) => {
        const g = window.__game;
        g.driveTo(t);
        g.setPaused(true);
        const gate = g.scene.getObjectByName('gate-finish');

        /* Pinned for the whole pair. environment.js's grass sways on
           performance.now(), so an unpinned second render differs from the
           first everywhere there is grass and the diff is meaningless. */
        const real = performance.now.bind(performance);
        const frozen = real();
        performance.now = () => frozen;

        const cv = g.renderer.domElement, w = cv.width, h = cv.height;
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const ctx = tmp.getContext('2d', { willReadFrequently: true });
        const grab = () => {
          g.renderOnce();
          ctx.drawImage(cv, 0, 0);
          return ctx.getImageData(0, 0, w, h).data;
        };

        gate.visible = true;
        grab();                       // discarded — first render after arriving
        const A = grab();
        gate.visible = false;
        grab();                       // discarded, symmetrically
        const B = grab();
        gate.visible = true;
        performance.now = real;

        let sum = 0, diff = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
        for (let i = 0, px = 0; i < A.length; i += 4, px++) {
          sum += 0.2126 * A[i] + 0.7152 * A[i + 1] + 0.0722 * A[i + 2];
          if (Math.abs(A[i] - B[i]) > 2 || Math.abs(A[i + 1] - B[i + 1]) > 2
            || Math.abs(A[i + 2] - B[i + 2]) > 2) {
            diff++;
            const x = px % w, y = (px / w) | 0;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
        return {
          want: station, s: +g.player.s.toFixed(0),
          luma: +(sum / (A.length / 4) / 255).toFixed(3),
          gatePx: diff,
          box: diff ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null,
          w, h,
        };
      }, [Math.max(0.0005, s / info.L), s]));
    }

    console.log('\n  station   luma   gate px   gate bbox (x,y,w,h)   note');
    const inBore = r => info.tunnel && r.s >= info.tunnel.s0 && r.s <= info.tunnel.s1;
    for (const r of rows) {
      const note = inBore(r) ? 'INSIDE BORE'
        : info.tunnel && Math.abs(r.s - info.tunnel.s0) < 12 ? 'entry portal'
          : info.tunnel && Math.abs(r.s - info.tunnel.s1) < 12 ? 'exit portal'
            : r.s > info.finishS ? 'past the flag' : '';
      console.log(`  ${String(r.s).padStart(6)}  ${r.luma.toFixed(3)}`
        + `  ${String(r.gatePx).padStart(8)}   ${(r.box ? r.box.join(',') : '—').padEnd(20)}  ${note}`);
    }

    const lum = rows.map(r => r.luma).sort((a, b) => a - b);
    const bore = rows.filter(inBore);
    const open = rows.filter(r => !inBore(r) && r.s < (info.tunnel?.s0 ?? info.L) - 200);
    const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
    console.log(`\n  lap luma      min ${lum[0].toFixed(3)}  median ${lum[Math.floor(lum.length / 2)].toFixed(3)}`
      + `  max ${lum[lum.length - 1].toFixed(3)}   over ${rows.length} stations`);
    if (bore.length) {
      console.log(`  inside bore   mean ${mean(bore.map(r => r.luma)).toFixed(3)}`
        + `  min ${Math.min(...bore.map(r => r.luma)).toFixed(3)}`);
      console.log(`  open stage    mean ${mean(open.map(r => r.luma)).toFixed(3)}`
        + `  max ${Math.max(...open.map(r => r.luma)).toFixed(3)}`);
    }
    const firstGate = rows.find(r => r.gatePx >= 8);
    const gateInBore = bore.filter(r => r.gatePx >= 8);
    console.log(`\n  gate first reads >=8 px at s ${firstGate ? firstGate.s : 'never'}`
      + `  (${firstGate ? (info.gateS - firstGate.s).toFixed(0) : '—'} m before the arch)`);
    console.log(`  stations inside the bore with the gate on screen: ${gateInBore.length}`
      + (gateInBore.length ? '  → ' + gateInBore.map(r => `${r.s}:${r.gatePx}px`).join(' ') : ''));
    console.log('\n' + JSON.stringify(rows));
  });

finish(process.exitCode || 0);
