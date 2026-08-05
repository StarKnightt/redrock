/* The whole lap, as a sequence.
 *
 * Every other capture tool here answers a question about one system. This one
 * asks the question a player asks, which is whether the thing hangs together
 * from the line to the flag — so it samples the stage densely and evenly, in
 * order, with the HUD composited over the frame because the HUD is part of
 * what the player is looking at.
 *
 * Two outputs:
 *   1. The frames, at native resolution, driven in by the AI at racing speed.
 *      Never a parked car — a still frame of a still car shows none of the
 *      dust, lean or speed response the sequence is being judged on.
 *   2. A signature per frame: mean colour, saturation, luma histogram, and a
 *      6x6 spatial grid. "Chapters feel samey" and "the palette drifts" are
 *      claims about the distance between consecutive signatures, and eleven
 *      stills eyeballed in a row cannot settle either.
 *
 *   node tools/zzlap.mjs [--seed 22] [--tag lap22] [--n 26] [--hud 1]
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
const TAG = flag('tag', `lap${SEED}`);
const N = +flag('n', 26);
const HUD = flag('hud', '1');
const W = +flag('w', 1600), H = +flag('h', 900);

const outDir = path.join(ROOT, 'shots', TAG);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

/* Evenly spaced, and deliberately so — an even walk is the only sampling that
   can show a dead stretch, because any scheme that seeks out the interesting
   stations has already decided the answer. The ends are pulled in a little:
   t=0 is behind the start gate and t=1 is past the flag. */
const STOPS = Array.from({ length: N }, (_, i) => 0.004 + (0.995 - 0.004) * (i / (N - 1)));

await run({
  width: W, height: H,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=${HUD}`,
}, async ({ page }) => {
  await page.evaluate(() => window.__game.setPaused(true));

  const meta = await page.evaluate(() => {
    const g = window.__game;
    return {
      ...g.stageStats(),
      ramps: (g.track.ramps || []).map(r => ({
        lip: +r.lip.toFixed(0), pad0: +r.pad0.toFixed(0), land: +r.land.toFixed(0),
      })),
      tunnel: g.field?.tunnel
        ? { s0: +g.field.tunnel.s0.toFixed(0), s1: +g.field.tunnel.s1.toFixed(0) } : null,
    };
  });
  console.log(`\n  seed ${SEED} — ${meta.len} m, ${meta.drop} m drop, ${meta.straightPct}% straight`);
  console.log(`  ramps ${meta.ramps.map(r => r.lip).join(', ')}`
    + `   tunnel ${meta.tunnel ? `${meta.tunnel.s0}-${meta.tunnel.s1}` : 'none'}`);
  console.log('\n     t      s   km/h  gear  pos    calls    tris   luma   sat   sky%  dark%');

  const rows = [];
  for (const t of STOPS) {
    await page.evaluate(t => {
      const g = window.__game;
      /* Driven in, not teleported. 200 m of run-up is enough for the AI to be
         on the racing line and at the speed the corner allows. */
      g.driveTo(t, { runUp: 200, maxSec: 40 });
      g.autopilot(false);
    }, t);

    const st = await page.evaluate((wantHud) => {
      const g = window.__game;
      /* Discard the first read-back after a run of steps. */
      g.renderOnce();
      g.renderOnce();
      if (wantHud) g.hud.draw();
      const gl = g.renderer.domElement;
      const c = document.createElement('canvas');
      c.width = gl.width; c.height = gl.height;
      const x = c.getContext('2d');
      x.drawImage(gl, 0, 0);
      if (wantHud) x.drawImage(g.hud.canvas, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/png');

      /* Signature off the GL frame alone — the HUD is the same pixels every
         stop and would flatten every distance it appears in. */
      const s = document.createElement('canvas');
      s.width = gl.width; s.height = gl.height;
      const sc = s.getContext('2d');
      sc.drawImage(gl, 0, 0);
      const w = s.width, h = s.height;
      const px = sc.getImageData(0, 0, w, h).data;
      const hist = new Array(8).fill(0);
      const GX = 6, GY = 6;
      const grid = Array.from({ length: GX * GY }, () => [0, 0, 0, 0]);
      let R = 0, G = 0, B = 0, sat = 0, sky = 0, n = 0;
      for (let y = 0; y < h; y += 2) {
        for (let xx = 0; xx < w; xx += 2) {
          const i = (y * w + xx) * 4;
          const r = px[i], g2 = px[i + 1], b = px[i + 2];
          const L = (0.2126 * r + 0.7152 * g2 + 0.0722 * b) / 255;
          hist[Math.min(7, Math.floor(L * 8))]++;
          const mx = Math.max(r, g2, b), mn = Math.min(r, g2, b);
          sat += mx ? (mx - mn) / mx : 0;
          /* "Sky" as a pixel test rather than a raycast: pale, blue-dominant
             and unsaturated is the dome and nothing else in this palette. */
          if (b > r && b > 120 && (mx - mn) / (mx || 1) < 0.42 && L > 0.45) sky++;
          R += r; G += g2; B += b; n++;
          const cell = (Math.min(GY - 1, (y * GY / h) | 0) * GX)
            + Math.min(GX - 1, (xx * GX / w) | 0);
          const c4 = grid[cell];
          c4[0] += r; c4[1] += g2; c4[2] += b; c4[3]++;
        }
      }
      const dark = (hist[0] + hist[1]) / n;
      return {
        url,
        rgb: [R / n, G / n, B / n].map(v => +v.toFixed(1)),
        luma: +((0.2126 * R + 0.7152 * G + 0.0722 * B) / n / 255).toFixed(3),
        sat: +(sat / n).toFixed(3),
        sky: +(100 * sky / n).toFixed(1),
        dark: +(100 * dark).toFixed(1),
        hist: hist.map(v => +(100 * v / n).toFixed(1)),
        grid: grid.map(c => c.slice(0, 3).map(v => Math.round(v / c[3]))),
        fps: +g.fps.toFixed(1),
        pos: g.race.positionOf(g.player) ?? 1,
        ...g.info(),
      };
    }, HUD !== '0');

    const name = String(Math.round(t * 1000)).padStart(4, '0');
    fs.writeFileSync(path.join(outDir, `${name}.png`),
      Buffer.from(st.url.split(',')[1], 'base64'));
    delete st.url;
    rows.push({ t: +t.toFixed(4), file: `${name}.png`, ...st });
    console.log(`  ${t.toFixed(3)} ${String(st.car.s).padStart(6)} `
      + `${String(st.car.kmh).padStart(6)} ${String(st.car.gear).padStart(4)} `
      + `${String(st.pos).padStart(4)} ${String(st.calls).padStart(8)} `
      + `${String((st.triangles / 1000).toFixed(0) + 'k').padStart(7)} `
      + `${st.luma.toFixed(3).padStart(6)} ${st.sat.toFixed(3).padStart(5)} `
      + `${st.sky.toFixed(1).padStart(5)} ${st.dark.toFixed(1).padStart(6)}`);
  }

  /* Distance between consecutive frames, on the 6x6 grid. A run of small
     numbers is a stretch where nothing changed — which is the definition of
     the dead stretch this tool exists to find. Normalised so the numbers are
     comparable between seeds. */
  const dist = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) {
      for (let k = 0; k < 3; k++) s += (a[i][k] - b[i][k]) ** 2;
    }
    return Math.sqrt(s / (a.length * 3));
  };
  console.log('\n  frame-to-frame change (6x6 grid RMS, 0 = identical picture)');
  const deltas = [];
  for (let i = 1; i < rows.length; i++) {
    const d = dist(rows[i - 1].grid, rows[i].grid);
    deltas.push({ from: rows[i - 1].t, to: rows[i].t, d: +d.toFixed(1) });
  }
  console.log('   ' + deltas.map(d => d.d.toFixed(0).padStart(4)).join(''));
  const sorted = [...deltas].sort((a, b) => a.d - b.d);
  console.log('  quietest three transitions: '
    + sorted.slice(0, 3).map(d => `${d.from.toFixed(3)}→${d.to.toFixed(3)} (${d.d})`).join('  '));
  console.log('  loudest three transitions:  '
    + sorted.slice(-3).reverse().map(d => `${d.from.toFixed(3)}→${d.to.toFixed(3)} (${d.d})`).join('  '));

  /* And the far pairs: two stations a long way apart that look the same are
     repetition, which is a different fault from a dead stretch. */
  let worst = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 4; j < rows.length; j++) {
      worst.push({ a: rows[i].t, b: rows[j].t, d: +dist(rows[i].grid, rows[j].grid).toFixed(1) });
    }
  }
  worst.sort((x, y) => x.d - y.d);
  console.log('  most alike distant pairs:   '
    + worst.slice(0, 4).map(p => `${p.a.toFixed(2)}≈${p.b.toFixed(2)} (${p.d})`).join('  '));

  const lumas = rows.map(r => r.luma);
  const sats = rows.map(r => r.sat);
  console.log(`\n  luma across the lap  ${Math.min(...lumas).toFixed(3)} — `
    + `${Math.max(...lumas).toFixed(3)}  (mean ${(lumas.reduce((a, b) => a + b) / lumas.length).toFixed(3)})`);
  console.log(`  saturation           ${Math.min(...sats).toFixed(3)} — `
    + `${Math.max(...sats).toFixed(3)}  (mean ${(sats.reduce((a, b) => a + b) / sats.length).toFixed(3)})`);

  fs.writeFileSync(path.join(outDir, 'lap.json'),
    JSON.stringify({ seed: +SEED, meta, rows, deltas }, null, 1));
  console.log(`\n  → shots/${TAG}`);
});

finish(process.exitCode || 0);
