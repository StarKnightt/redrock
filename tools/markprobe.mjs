/* What colour is the marking, and how far is that from the road it is on?
 *
 * Projects the centre of each painted feature at a ramp site — the pad strip,
 * the four pad chevrons, the five ramp-face chevrons — through the live camera
 * from a car approaching at racing speed, then reads the finished pixel there
 * and the road pixel 2.5 m to the side of it. Contrast is reported as the
 * difference in luma, which is what a cel frame separates shapes with.
 *
 *   node tools/markprobe.mjs [--seed 22] [--ramp 1] [--from 40]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', 22);
const RAMP = +flag('ramp', 1);
const FROM = +flag('from', 40);

await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
  async ({ page }) => {
  const out = await page.evaluate(([idx, from]) => {
    const g = window.__game, p = g.player, track = g.track;
    g.setPaused(true);
    if (g.race?.entries) g.race.entries.length = 0;
    const r = track.ramps[Math.min(idx, track.ramps.length - 1)];
    g.autopilot(true, 0.85);
    g.driveTo((r.pad0 - from - 60) / track.length, { runUp: 300, maxSec: 45 });
    let n = 0;
    while (p.s < r.pad0 - from && n++ < 600) g.step(1 / 60);
    g.setPaused(true);
    g.renderOnce();
    const cv = g.renderer.domElement;
    const tmp = document.createElement('canvas');
    tmp.width = cv.width; tmp.height = cv.height;
    const tc = tmp.getContext('2d');
    tc.drawImage(cv, 0, 0);
    const px = tc.getImageData(0, 0, cv.width, cv.height).data;

    const read = (x, y) => {
      if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) return null;
      const i = (y * cv.width + x) * 4;
      return { x, y, r: px[i], g: px[i + 1], b: px[i + 2],
        lum: (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255 };
    };
    /* Project the marking at its own paint height, then take the brightest
       pixel in a small window around it. A flat marking at 60 m is two pixels
       tall, so a sample that lands one pixel off lands on the road and reports
       a contrast of zero that is an artefact of the probe rather than of the
       paint. The window removes that failure mode in the marking's favour. */
    const at = (s, lat, win = 3) => {
      const f = track.frameAt(s);
      const v = f.pos.clone().addScaledVector(f.right, lat)
        .addScaledVector(f.up, 0.034 + track.rampHeight(s, 0));
      const q = v.clone().project(g.camera);
      const x = Math.round((q.x * 0.5 + 0.5) * cv.width);
      const y = Math.round((-q.y * 0.5 + 0.5) * cv.height);
      let best = null;
      for (let dy = -win; dy <= win; dy++) for (let dx = -win; dx <= win; dx++) {
        const c = read(x + dx, y + dy);
        if (c && (!best || c.lum > best.lum)) best = c;
      }
      return best;
    };
    /* The road reference is the median of samples either side, so a lane dash
       or the car's own shadow cannot stand in for tarmac. */
    const road = (s) => {
      const l = [-3.2, -2.6, 2.6, 3.2].map(o => at(s, o, 1)).filter(Boolean)
        .map(c => c.lum).sort((a, b) => a - b);
      return l.length ? (l[(l.length >> 1) - 1] + l[l.length >> 1]) / 2 : null;
    };

    const feature = (name, s, lat) => {
      const a = at(s, lat), b = road(s);
      if (!a || b == null) return { name, off: true };
      const hex = c => '#' + [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('');
      const mx = Math.max(a.r, a.g, a.b), mn = Math.min(a.r, a.g, a.b);
      return {
        name, dist: +(s - p.s).toFixed(0), at: `${a.x},${a.y}`,
        mark: hex(a), road: '(median)',
        contrast: +Math.abs(a.lum - b).toFixed(3),
        sat: +((mx - mn) / (mx || 1)).toFixed(2),
        hue: a.r > a.b + 12 ? 'warm' : (a.b > a.r + 12 ? 'cool' : 'neutral'),
      };
    };

    const rows = [feature('pad strip', (r.pad0 + r.pad1) / 2, 0)];
    for (let k = 0; k < 4; k++) rows.push(feature(`pad chevron ${k + 1}`, r.pad0 + 0.7 + k * 1.35, 0));
    for (let k = 0; k < 5; k++) rows.push(feature(`face chevron ${k + 1}`, r.foot + 2.5 + k * 3.2, 0));
    rows.push(feature('lip', r.lip, 0));
    g.autopilot(false);
    return { s: +p.s.toFixed(0), kmh: +p.kmh.toFixed(0), rows };
  }, [RAMP, FROM]);

  console.log(`\n  seed ${SEED}, ramp ${RAMP}, read from s ${out.s} at ${out.kmh} km/h`);
  console.log('    feature           m ahead   marking    road       luma contrast   saturation   hue');
  for (const r of out.rows) {
    if (r.off) { console.log(`    ${r.name.padEnd(17)} off screen`); continue; }
    console.log(`    ${r.name.padEnd(17)} ${String(r.dist).padStart(7)}   ${r.mark}    ${r.road}`
      + ` ${r.contrast.toFixed(3).padStart(15)} ${r.sat.toFixed(2).padStart(12)}   ${r.hue}`);
  }
});
finish(process.exitCode || 0);
