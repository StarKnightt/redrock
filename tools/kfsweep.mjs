/* R2 / D1 (B)(C)(D) — the finish run-in as ONE continuous drive.
 *
 * Replaces the per-station teleport of tools/kfrunin.mjs, which re-ran a fresh
 * 230 m drive-in for every station and therefore arrived in a different state
 * each time — on seed 22 the 110 m station arrived broadside on the grass at
 * 69 km/h, which is a frame about a crash and not about a crowd.
 *
 * Here the autopilot is handed the car once, well before the finish, and the
 * car drives the whole run-in. The walk stops every STEP metres, and the
 * simulation seconds between stops are counted as they are spent, so the screen
 * time is measured rather than divided out of an average speed.
 *
 * At every stop: clock pinned, frame 0 discarded, a repeat render diffed as a
 * drift check, all finish-site instances dropped 5000 m and diffed (crowd
 * footprint), each instance dropped alone and diffed (tallest figure).
 * At the listed stations also: 'gate-finish' hidden and diffed, and a native
 * 1600x900 PNG of the un-ablated frame.
 *
 * Stations and marks are metres short of the FINISH LINE (s = L - back).
 *
 *   node tools/kfsweep.mjs [--seeds 22,1,40] [--from 150] [--step 5]
 *                          [--shots 110,90,80,70,60,50,40,30,20,12,6,0]
 *                          [--tag r2f] [--out kfsweep] [--root <repo>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');
const FROM = Number(flag('from', '150'));
const STEP = Number(flag('step', '5'));
const SHOTS = flag('shots', '110,90,80,70,60,50,40,30,20,12,6,0').split(',').map(Number);
const PRE = Number(flag('pre', '40'));      // where the drive-in ends, before the first mark
const RUNUP = Number(flag('runup', '460')); // how much road the autopilot gets to settle on
const SKILL = Number(flag('skill', '0.85'));
const PNG = flag('png', '1') !== '0';
const TAG = flag('tag', 'r2f');
const OUT = flag('out', 'kfsweep');
const OUTROOT = flag('outroot', HERE);

const measDir = path.join(OUTROOT, '.meas', 'r2');
fs.mkdirSync(measDir, { recursive: true });
const lines = [];
const say = s => { console.log(s); lines.push(s); };
const all = [];

async function snap(page, file) {
  const url = await page.evaluate(() => {
    const g = window.__game;
    g.renderOnce();
    return g.renderer.domElement.toDataURL('image/png');
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  return file;
}

for (const SEED of SEEDS) {
  const shotDir = path.join(OUTROOT, 'shots', `${TAG}-${SEED}`);
  fs.mkdirSync(shotDir, { recursive: true });

  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    const head = await page.evaluate(([from, pre, runup, skill]) => {
      const g = window.__game, t = g.track;
      if (!g.crowd) return { none: true, why: 'no crowd' };
      const site = g.crowd.sites.find(s => s.kind === 'finish');
      if (!site) return { none: true, why: 'no finish site' };
      const mesh = g.scene.getObjectByName('crowd-figures');
      const gate = g.stage.getObjectByName('gate-finish');
      if (!mesh || !gate) return { none: true, why: !gate ? 'no gate-finish' : 'no crowd mesh' };
      const place = mesh.geometry.getAttribute('aPlace');
      const mine = [];
      for (let i = 0; i < place.count; i++) {
        if (Math.hypot(place.getX(i) - site.at.x, place.getZ(i) - site.at.z) > 26) continue;
        mine.push(i);
      }
      window.__kf = { site, mesh, gate, place, mine };

      /* One drive-in, from far enough back that the car is on the line and up
         to speed by the first mark. */
      g.setPaused(true);
      g.autopilot(true, skill);
      const start = t.length - from - pre;
      g.driveTo(start / t.length, { runUp: runup, skill, maxSec: 70 });
      return {
        L: t.length, siteS: site.s, n: mine.length,
        W: g.renderer.domElement.width, H: g.renderer.domElement.height,
        startS: +g.player.s.toFixed(1), startKmh: +g.player.kmh.toFixed(1),
        wanted: +start.toFixed(1),
      };
    }, [FROM, PRE, RUNUP, SKILL]);
    if (head.none) { say(`  seed ${SEED}: ${head.why}`); return; }

    const set = new Set([0, ...SHOTS]);
    for (let b = FROM; b > 0; b -= STEP) set.add(b);
    const marks = [...set].filter(b => b <= FROM).sort((a, b) => b - a);

    say(`\n══ seed ${SEED} ══  L=${head.L.toFixed(0)} m,`
      + ` finish site s=${head.siteS.toFixed(0)} (${(head.L - head.siteS).toFixed(1)} m before the line),`
      + ` ${head.n} figures,  ${head.W}x${head.H}`);
    say(`   drive-in: asked for s=${head.wanted}, arrived s=${head.startS} at ${head.startKmh} km/h`);

    const rows = [];
    for (const back of marks) {
      const wantShot = SHOTS.includes(back);
      const m = await page.evaluate(([back, wantShot]) => {
        const g = window.__game, t = g.track;
        const { gate, place, mine } = window.__kf;
        /* `track.project` clamps the station to the stage length, so the car's
           reported s saturates at L and a walk asked for exactly L would spin
           until the stall guard fired. The last mark is therefore the last
           metre before the line, and the frame it takes is the car crossing. */
        const target = Math.min(t.length - back, t.length - 0.6);
        /* Walk, counting simulation frames. Stall = no progress at all over
           seven seconds, the same definition tools/crowdshot.mjs uses. */
        let steps = 0, sinceGain = 0, best = g.player.s;
        while (g.player.s < target && steps < 5400) {
          g.step(1 / 60); steps++;
          if (g.player.s > best + 1e-4) { best = g.player.s; sinceGain = 0; }
          else if (++sinceGain >= 420) break;
        }
        const reached = g.player.s >= target - 2;

        const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
        const gl = g.renderer.getContext();
        const grab = () => {
          const px = new Uint8Array(W * H * 4);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
          return px;
        };
        const diff = (a, b) => {
          let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
          for (let i = 0, p = 0; i < a.length; i += 4, p++) {
            if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i + 1] - b[i + 1]) > 6
              || Math.abs(a[i + 2] - b[i + 2]) > 6) {
              n++;
              const x = p % W, yy = H - 1 - ((p / W) | 0);
              if (x < x0) x0 = x; if (x > x1) x1 = x;
              if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
            }
          }
          return n ? { n, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { n: 0 };
        };

        window.__realNow = performance.now.bind(performance);
        const t0 = window.__realNow();
        performance.now = () => t0;

        g.renderOnce();                 // frame 0, discarded
        g.renderOnce();
        const base = grab();
        g.renderOnce();
        const drift = diff(base, grab()).n;

        const ys = mine.map(i => place.getY(i));
        mine.forEach((i, k) => place.setY(i, ys[k] - 5000));
        place.needsUpdate = true;
        g.renderOnce();
        const dAll = diff(base, grab());
        mine.forEach((i, k) => place.setY(i, ys[k]));
        place.needsUpdate = true;

        const per = [];
        for (let k = 0; k < mine.length; k++) {
          const i = mine[k];
          place.setY(i, ys[k] - 5000);
          place.needsUpdate = true;
          g.renderOnce();
          const d = diff(base, grab());
          place.setY(i, ys[k]);
          place.needsUpdate = true;
          per.push({ n: d.n, h: d.n ? d.h : 0 });
        }

        let dGate = { n: 0 };
        if (wantShot) {
          gate.visible = false;
          g.renderOnce();
          dGate = diff(base, grab());
          gate.visible = true;
        }
        g.renderOnce();

        const p = g.player;
        return {
          back, target: +target.toFixed(1), s: +p.s.toFixed(1), reached,
          kmh: +p.kmh.toFixed(1), lat: +p.lat.toFixed(2), offRoad: +p.offRoad.toFixed(2),
          dt: +(steps / 60).toFixed(3), steps, drift,
          crowd: dAll.n, crowdBox: dAll.n ? [dAll.x0, dAll.y0, dAll.x1, dAll.y1] : null,
          tallest: per.reduce((a, b) => Math.max(a, b.h), 0),
          visible: per.filter(x => x.n > 0).length,
          per,
          gate: dGate.n, gateBox: dGate.n ? [dGate.x0, dGate.y0, dGate.x1, dGate.y1] : null,
        };
      }, [back, wantShot]);

      let file = null;
      if (PNG && wantShot && m.reached) {
        file = path.join(shotDir, `s${SEED}-line-${String(back).padStart(3, '0')}m.png`);
        await snap(page, file);
      }
      await page.evaluate(() => { performance.now = window.__realNow; });
      m.file = file;
      rows.push(m);

      const cb = m.crowdBox, gb = m.gateBox;
      const mark = wantShot ? '*' : ' ';
      say(`   ${mark}${String(back).padStart(4)} m  s=${String(m.s).padStart(7)}`
        + ` ${String(m.kmh).padStart(6)} km/h ${m.reached ? '   ' : ' ✗ '}`
        + ` dt ${String(m.dt).padStart(6)} s`
        + `  crowd ${String(m.crowd).padStart(6)} px`
        + `  seen ${m.visible}/${head.n}`
        + `  tallest ${String(m.tallest).padStart(3)} px`
        + (wantShot ? `  gate ${String(m.gate).padStart(6)} px` : '                ')
        + `  cbox ${cb ? `x[${cb[0]}..${cb[2]}] y[${cb[1]}..${cb[3]}]` : '—'}`
        + (wantShot ? `  gbox ${gb ? `x[${gb[0]}..${gb[2]}] y[${gb[1]}..${gb[3]}]` : '—'}` : '')
        + `  drift ${m.drift}`);
    }

    /* Screen time, from the simulation seconds actually spent between marks.
       A mark's dt is the time taken to GET to it, so the time a threshold is
       held for is the sum of the dt of every mark after the first one that
       crosses it, up to and including the last one that holds it. */
    const span = (thr) => {
      const idx = rows.map((r, i) => r.tallest > thr ? i : -1).filter(i => i >= 0);
      if (!idx.length) return { sec: 0, secClean: 0, from: null, to: null, n: 0, gaps: 0, metres: 0 };
      const a = idx[0], b = idx[idx.length - 1];
      let sec = 0, clean = 0;
      for (let i = a + 1; i <= b; i++) {
        sec += rows[i].dt;
        /* The same span priced at the speed the car is doing at each mark
           rather than at the seconds it actually spent there. The two differ
           wherever the autopilot loses the car — a spin adds seconds of screen
           time nobody would call legible run-in. */
        const dm = rows[i - 1].back - rows[i].back;
        clean += rows[i].kmh > 1 ? dm / (rows[i].kmh / 3.6) : 0;
      }
      return {
        sec: +sec.toFixed(2), secClean: +clean.toFixed(2),
        from: rows[a].back, to: rows[b].back, metres: rows[a].back - rows[b].back,
        n: idx.length, gaps: b - a + 1 - idx.length,
      };
    };
    const s20 = span(20), s40 = span(40);
    say(`   tallest figure > 20 px: ${s20.sec} s measured / ${s20.secClean} s at the marks' own speeds`
      + `  (${s20.from} m → ${s20.to} m before the line = ${s20.metres} m,`
      + ` ${s20.n} of ${s20.gaps + s20.n} marks in that span)`);
    say(`   tallest figure > 40 px: ${s40.sec} s measured / ${s40.secClean} s at the marks' own speeds`
      + `  (${s40.from} m → ${s40.to} m before the line = ${s40.metres} m,`
      + ` ${s40.n} of ${s40.gaps + s40.n} marks in that span)`);
    const slow = rows.reduce((a, b) => a.kmh < b.kmh ? a : b);
    say(`   slowest mark on the run-in: ${slow.kmh} km/h at ${slow.back} m`
      + ` (dt ${slow.dt} s) — a spin here is the autopilot, not the placement`);
    const edge = rows.filter(r => r.crowdBox && (r.crowdBox[0] === 0 || r.crowdBox[2] >= head.W - 1));
    say(`   crowd box touching a frame edge at: `
      + (edge.length ? edge.map(r => `${r.back}m(${r.crowdBox[0] === 0 ? 'L' : 'R'})`).join(' ') : 'never'));
    const anyPx = rows.filter(r => r.crowd > 0);
    if (anyPx.length) {
      say(`   any crowd pixel at all: ${anyPx[0].back} m → ${anyPx[anyPx.length - 1].back} m before the line`);
    } else say('   any crowd pixel at all: NEVER');

    all.push({ seed: +SEED, L: head.L, siteS: head.siteS, n: head.n, head, rows, s20, s40 });
    say(`   → ${shotDir}`);
  });
}

fs.writeFileSync(path.join(measDir, `${OUT}.json`), JSON.stringify(all, null, 2));
fs.writeFileSync(path.join(measDir, `${OUT}.txt`), lines.join('\n') + '\n');
console.log(`\n  → ${path.join(measDir, OUT + '.txt')}`);
finish(process.exitCode || 0);
