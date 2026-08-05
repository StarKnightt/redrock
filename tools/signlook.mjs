/* The vertical signage, on the same ladder rampjudge.mjs measures the pad on.
 *
 * The pad's projected area was the number that condemned the first pass: a
 * flat marking at a shallow angle cannot subtend area at range, whatever it is
 * painted. The boards exist to answer that with geometry, so they are measured
 * the same way — four corners of one board pushed through the live camera at
 * 130/100/75/50/34 m, area in pixels, against the pad's area at the same
 * station in the same frame.
 *
 * Height in pixels is reported alongside area because it is the half of the
 * measurement the pad can never win: a marking 1.5 px tall at 130 m is inside
 * the road's own noise however wide it is.
 *
 *   node tools/signlook.mjs [--seed 22] [--ramp 1]
 */
import { run } from './harness.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', 22);
const RAMP = +flag('ramp', 1);
const W = 1600, H = 900;

/* Has to match buildRampSigns. Read rather than duplicated where possible —
   PAD_LEN comes out of the page — but the board's own box is local to the
   builder, so these four are a copy and are marked as one. */
const BOARD_HALF = 1.0, BOARD_LOW = 1.4, BOARD_HIGH = 2.7;

await run({ width: W, height: H, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0` },
  async ({ page }) => {
  const sites = await page.evaluate(() => {
    const g = window.__game; g.setPaused(true);
    return g.track.ramps.map(r => ({ lip: r.lip, foot: r.foot, pad0: r.pad0, pad1: r.pad1 }));
  });
  const r = sites[Math.min(RAMP, sites.length - 1)];
  console.log(`  seed ${SEED} — judging ramp #${Math.min(RAMP, sites.length - 1)} at lip ${r.lip}`);
  console.log('    range   pad px^2   pad px tall   board px^2   board px tall');

  await page.evaluate((s) => {
    const g = window.__game;
    g.autopilot(true, 0.85);
    g.driveTo(s / g.track.length, { runUp: 320, maxSec: 45 });
  }, r.pad0 - 160);

  for (const d of [130, 100, 75, 50, 34]) {
    const at = await page.evaluate(([target, pad0, pad1, lip, W, H, box]) => {
      const g = window.__game, p = g.player, track = g.track;
      let n = 0;
      while (p.s < target && n++ < 900) g.step(1 / 60);
      const [BOARD_HALF, BOARD_LOW, BOARD_HIGH] = box;

      const proj = v => { const q = v.clone().project(g.camera);
        return { x: (q.x * 0.5 + 0.5) * W, y: (-q.y * 0.5 + 0.5) * H }; };
      const shoelace = c => {
        let a = 0;
        for (let i = 0; i < c.length; i++) {
          const u = c[i], v = c[(i + 1) % c.length];
          a += u.x * v.y - v.x * u.y;
        }
        return Math.abs(a) / 2;
      };
      const padPt = (s, lat) => {
        const f = track.frameAt(s);
        return proj(f.pos.clone().addScaledVector(f.right, lat * f.width * 0.5)
          .addScaledVector(f.up, 0.02));
      };
      const padArea = shoelace([padPt(pad0, -0.92), padPt(pad1, -0.92),
        padPt(pad1, 0.92), padPt(pad0, 0.92)]);

      /* The nearer of the two boards at the pad, on the side of the road the
         car is not on — the one a driver actually has in clear air. */
      const f = track.frameAt(pad0 + 3);
      const side = p.lat > 0 ? -1 : 1;
      const boardPt = (up, out) => proj(f.pos.clone()
        .addScaledVector(f.right, side * (f.width * 0.5 + out))
        .addScaledVector(f.up, up));
      const base = 1.6;   // approximate berm crest seat; the board is 1.3 m tall on it
      const c = [boardPt(base + BOARD_LOW, -1 + BOARD_HALF), boardPt(base + BOARD_LOW, -1 - BOARD_HALF),
        boardPt(base + BOARD_HIGH, -1 - BOARD_HALF), boardPt(base + BOARD_HIGH, -1 + BOARD_HALF)];
      const bArea = shoelace(c);
      const xs = c.map(v => v.x), ys = c.map(v => v.y);

      const padYs = [padPt(pad0, -0.92), padPt(pad1, -0.92),
        padPt(pad1, 0.92), padPt(pad0, 0.92)].map(v => v.y);
      return {
        padH: +(Math.max(...padYs) - Math.min(...padYs)).toFixed(1),
        s: +p.s.toFixed(0), kmh: +p.kmh.toFixed(0),
        pad: +padArea.toFixed(0), board: +bArea.toFixed(0),
        bw: +(Math.max(...xs) - Math.min(...xs)).toFixed(1),
        bh: +(Math.max(...ys) - Math.min(...ys)).toFixed(1),
      };
    }, [r.pad0 - d, r.pad0, r.pad1, r.lip, W, H, [BOARD_HALF, BOARD_LOW, BOARD_HIGH]]);
    console.log(`    ${String(d).padStart(4)} m ${String(at.pad).padStart(9)}`
      + `${String(at.padH).padStart(11)}${String(at.board).padStart(13)}`
      + `${String(at.bh).padStart(11)}`);
  }
});
