/* Which version of the tunnel scan puts the bore where a given report says it is.
 *
 * `pickTunnel` grew four terms in sequence — approach sightline, brow, the
 * terrain occlusion pass, and the downhill bonus — and each of them is
 * documented in `environment.js` as having MOVED the chosen site. A station
 * quoted in an old report is therefore not evidence that the site has since
 * moved; it may be evidence of which scan was running when the report was
 * written. This re-runs the scan over today's world under each ablation and
 * prints the winner, so the two hypotheses can be told apart.
 *
 * The full variant is the control: it has to reproduce the shipped station to
 * within the +-6 m jitter `pickTunnel` applies after choosing, or this probe is
 * measuring itself and nothing it prints means anything.
 *
 *   node tools/qtabl.mjs [--seeds 22,1,40]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',').map(Number);

/* A transcription of pickTunnel with each term behind a switch. Deliberately a
   copy: the real one is not exported, and a probe that monkey-patched the
   module would change the world it is trying to measure. The control run is
   what keeps the copy honest. */
const PROBE = () => {
  const g = window.__game;
  g.setPaused(true);
  const track = g.track, coast = g.coast;
  const env = g.scene.getObjectByName('environment');
  const field = env.userData.field;
  const shipped = env.userData.tunnel;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  const length = clamp(track.length * 0.024, 105, 150);

  const swing = (p, q) => {
    const cx = q.pos.x - p.pos.x, cz = q.pos.z - p.pos.z;
    const chord = Math.hypot(cx, cz) || 1;
    let worst = 0;
    for (let n = 1; n < 8; n++) {
      const t = track.frameAt(p.s + ((q.s - p.s) * n) / 8);
      worst = Math.max(worst,
        Math.abs((t.pos.x - p.pos.x) * cz - (t.pos.z - p.pos.z) * cx) / chord);
    }
    return worst;
  };

  /* One pass over the stations, collecting every term. The variants then
     re-weight the same rows, so a difference between them is a difference of
     scoring and cannot be a difference of sampling. */
  const rows = [];
  for (let s = 450; s < track.length - 220 - length; s += 8) {
    let wall = Infinity;
    for (let k = 0; k <= 8; k++) {
      const t = s + (length * k) / 8;
      wall = Math.min(wall, field.profile(t, -coast.seaSideAt(t)).wallHeightBare);
    }
    if (wall < 34) continue;
    const a = track.frameAt(s), b = track.frameAt(s + length);
    const bend = swing(a, b);
    if (bend > 11) continue;
    const approach = Math.max(0, s - 170);
    const pa = track.frameAt(approach);
    const sight = swing(pa, a);
    let crest = 0;
    for (let n = 1; n < 8; n++) {
      const u = n / 8;
      const t = track.frameAt(approach + (s - approach) * u);
      crest = Math.max(crest, t.pos.y - (pa.pos.y + (a.pos.y - pa.pos.y) * u));
    }
    rows.push({
      s0: s, s1: s + length, wall, bend, sight, crest,
      brow: Math.max(0, crest - 1.6),
      drop: a.pos.y - b.pos.y, approach,
    });
  }

  /* The expensive occlusion pass, from `root.userData.landformPoint` so it is
     the same ladder the mesh is built from rather than a second copy. */
  const LANDFORM_STATIONS = 16;
  const lp = env.userData.landformPoint;
  const _p = new g.THREE.Vector3();
  const hiddenCount = (cand) => {
    const a = track.frameAt(cand.s0);
    const pa = track.frameAt(cand.approach);
    const ex = pa.pos.x - pa.tan.x * 9, ez = pa.pos.z - pa.tan.z * 9;
    const eyeY = a.pos.y + 4.2;
    let hidden = 0;
    for (let n = 1; n < 10; n++) {
      const u = n / 10;
      const rx = ex + (a.pos.x - ex) * u, rz = ez + (a.pos.z - ez) * u;
      const ry = eyeY + (a.pos.y + 4.0 - eyeY) * u;
      let f = null, bd = Infinity;
      for (const q of track.frames) {
        const e = (q.pos.x - rx) ** 2 + (q.pos.z - rz) ** 2;
        if (e < bd) { bd = e; f = q; }
      }
      const lat = (rx - f.pos.x) * f.flatRight.x + (rz - f.pos.z) * f.flatRight.z;
      const off = Math.abs(lat) - f.width * 0.5;
      if (off <= 0) continue;
      const dir = lat >= 0 ? 1 : -1;
      let above = -1e9;
      for (let c = 0; c < LANDFORM_STATIONS; c++) {
        lp(f.s, dir, c, _p);
        const cLat = Math.abs((_p.x - f.pos.x) * f.flatRight.x
          + (_p.z - f.pos.z) * f.flatRight.z);
        if (cLat > Math.abs(lat) + 6) break;
        if (cLat >= Math.abs(lat) - 6) above = Math.max(above, _p.y);
      }
      if (above > ry) hidden++;
    }
    return hidden;
  };

  const VARIANTS = {
    full:        { sight: 3.4, brow: 4.5, hidden: 11, drop: 0.35 },
    'no-hidden': { sight: 3.4, brow: 4.5, hidden: 0,  drop: 0.35 },
    'no-brow':   { sight: 3.4, brow: 0,   hidden: 11, drop: 0.35 },
    'no-sight':  { sight: 0,   brow: 4.5, hidden: 11, drop: 0.35 },
    'no-drop':   { sight: 3.4, brow: 4.5, hidden: 11, drop: 0 },
    'wall+bend': { sight: 0,   brow: 0,   hidden: 0,  drop: 0 },
  };

  const out = {};
  for (const [name, w] of Object.entries(VARIANTS)) {
    const list = rows.map(r => ({
      ...r,
      score: Math.min(r.wall, 70) - r.bend * 2.2 - r.sight * w.sight
        - r.brow * w.brow + r.drop * w.drop,
    })).sort((p, q) => q.score - p.score);
    let best = null;
    for (const cand of list.slice(0, 14)) {
      const h = w.hidden ? hiddenCount(cand) : 0;
      const sc = cand.score - h * w.hidden;
      if (!best || sc > best.sc) best = { ...cand, h, sc };
    }
    out[name] = best && {
      s0: Math.round(best.s0), s1: Math.round(best.s1),
      wall: +best.wall.toFixed(1), bend: +best.bend.toFixed(2),
      sight: +best.sight.toFixed(2), brow: +best.brow.toFixed(2),
      hidden: best.h, score: +best.sc.toFixed(2),
    };
  }
  return {
    seed: track.seed, length: +track.length.toFixed(0), boreLen: +length.toFixed(1),
    shipped: { s0: +shipped.s0.toFixed(1), s1: +shipped.s1.toFixed(1) },
    variants: out,
  };
};

for (const seed of SEEDS) {
  await run({ width: 320, height: 200, hash: `manual&tier=high&seed=${seed}&cap=0&hud=0` },
    async ({ page }) => {
      const r = await page.evaluate(PROBE);
      const ctl = r.variants.full;
      const drift = Math.abs(ctl.s0 - r.shipped.s0);
      console.log(`\n  seed ${r.seed}   track.length ${r.length}   bore length ${r.boreLen} m`);
      console.log(`  shipped  s0 ${r.shipped.s0}  s1 ${r.shipped.s1}`);
      console.log(`  CONTROL  full-scan winner s0 ${ctl.s0}  (|drift| ${drift.toFixed(1)} m — `
        + `${drift <= 6.5 ? 'within the +-6 m post-pick jitter, probe trusted'
          : 'OUTSIDE the jitter, PROBE IS WRONG'})`);
      console.log('\n  variant        s0     s1    wall   bend  sight   brow  hid    score');
      for (const [k, v] of Object.entries(r.variants)) {
        console.log(`  ${k.padEnd(12)} ${String(v.s0).padStart(5)}  ${String(v.s1).padStart(5)}`
          + `  ${String(v.wall).padStart(5)}  ${String(v.bend).padStart(5)}`
          + `  ${String(v.sight).padStart(5)}  ${String(v.brow).padStart(5)}`
          + `  ${String(v.hidden).padStart(3)}  ${String(v.score).padStart(7)}`);
      }
    });
}

finish(process.exitCode || 0);
