/* How high the corridor stands, station by station, without rendering a frame.
 *
 * tools/sky.mjs is the gate, but it costs four minutes a run because it
 * rasterises sixty frames and casts twenty thousand rays through them. Almost
 * every question asked while opening the corridors up is geometric — how tall
 * is the wall here, how far back does it stand, how many degrees of the frame
 * does its crest eat — and all of those come straight out of the generator.
 *
 * The elevation angle is the number that matters. A 42 mm-equivalent lens on a
 * 16:9 frame sees about 24 degrees above the horizon; a crest at 20 degrees
 * therefore leaves a sliver of sky at the very top of shot and nothing else,
 * and a crest at 10 leaves a little under half the upper frame. The chase
 * camera also looks slightly down, so the usable figure is lower still.
 *
 *   node tools/corridor.mjs [--seed 22] [--stops 60] [--full]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const has = k => args.includes('--' + k);
const SEED = flag('seed', '22');
const STOPS = Number(flag('stops', '60'));

/* Where the crest has to sit for the frame to hold sky. Above the first the
   station is a corridor; between them it is a shoulder; below the second it is
   open country and the silhouette stops doing any work. */
const SHUT = 16;
const OPEN = 9;

await run({
  width: 640, height: 360,
  hash: `manual&tier=high&seed=${SEED}&cap=60&hud=0&ink=1`,
}, async ({ page }) => {
  const out = await page.evaluate(({ stops }) => {
    const g = window.__game, THREE = g.THREE;
    const env = g.scene.getObjectByName('environment');
    const field = env.userData.field;
    const at = env.userData.landformPoint;
    const p = new THREE.Vector3();
    const rows = [];
    /* Half the horizontal field of view. The corridor is judged on what stands
       inside the frame, not on what is abeam the car and never seen. */
    const HALF_FOV = 32;
    for (let i = 0; i < stops; i++) {
      const t = (i + 0.5) / stops;
      const s = t * g.track.length;
      const f = g.track.frameAt(s);
      /* Driver's eyeline, which is what the enclosure is judged from. */
      const eye = f.pos.y + 1.5;
      const row = { t: +t.toFixed(3), s: Math.round(s), side: {} };
      for (const side of [-1, 1]) {
        const pr = field.profile(s, side);
        let deg = -90, dist = 0, at_s = s, at_station = 0;
        /* Every landform vertex the eye could see ahead, not only the ribbon
           abeam the car: on a descending course the wall two hundred metres
           down the road is the one filling the top of frame. */
        for (let ds = -40; ds <= 460; ds += 9) {
          const s2 = s + ds;
          if (s2 < 0 || s2 > g.track.length) continue;
          for (let station = 4; station <= 15; station++) {
            at(s2, side, station, p);
            const dx = p.x - f.pos.x, dz = p.z - f.pos.z;
            const run_ = Math.hypot(dx, dz);
            if (run_ < 4 || run_ > 900) continue;
            const az = Math.abs((Math.atan2(
              dx * f.flatRight.x + dz * f.flatRight.z,
              dx * f.tan.x + dz * f.tan.z,
            ) * 180) / Math.PI);
            if (az > HALF_FOV) continue;
            const e = (Math.atan2(p.y - eye, run_) * 180) / Math.PI;
            if (e > deg) { deg = e; dist = run_; at_s = s2; at_station = station; }
          }
        }
        /* The outer edge of the ribbon. Stations 14 and 15 are joined by one
           quad, so whatever height they differ by is a single unbroken face. */
        const a14 = at(s, side, 14, new THREE.Vector3());
        const a15 = at(s, side, 15, new THREE.Vector3());
        const skirtRun = Math.hypot(a15.x - a14.x, a15.z - a14.z);
        row.side[side] = {
          deg, out: dist, at: Math.round(at_s - s), station: at_station,
          skirtFall: a14.y - a15.y,
          skirtRun,
          skirtDeg: (Math.atan2(a14.y - a15.y, Math.max(0.5, skirtRun)) * 180) / Math.PI,
          wallHeight: pr.wallHeight,
          wallDist: pr.wallDist,
          chapter: pr.chapter,
          coastness: pr.coastness,
          constrained: pr.constrained,
          clear: pr.clear,
          nearDy: pr.nearDy,
        };
      }
      row.both = Math.min(row.side['-1'].deg, row.side['1'].deg);
      row.worst = Math.max(row.side['-1'].deg, row.side['1'].deg);
      rows.push(row);
    }
    return rows;
  }, { stops: STOPS });

  console.log('\n      t      s  ch          left                    right           lower');
  console.log('                        deg   out  +ds st     deg   out  +ds st    skyline');
  for (const r of out) {
    const L = r.side['-1'], R = r.side['1'];
    const mark = r.both >= SHUT ? '  <= SHUT' : r.both >= OPEN ? '  <- tight' : '';
    const col = q => `${q.deg.toFixed(1).padStart(6)} ${q.out.toFixed(0).padStart(5)}`
      + ` ${String(q.at).padStart(4)} ${String(q.station).padStart(2)}`;
    console.log(`  ${r.t.toFixed(3)} ${String(r.s).padStart(6)}  ${L.chapter}`
      + `  ${col(L)}  ${col(R)}  ${r.both.toFixed(1).padStart(7)}${mark}`);
  }

  const shut = out.filter(r => r.both >= SHUT);
  const tight = out.filter(r => r.both >= OPEN && r.both < SHUT);
  const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  console.log(`\n  ${out.length} stations, seed ${SEED}`);
  console.log(`  crest on BOTH sides >= ${SHUT}deg: ${shut.length}`
    + `   >= ${OPEN}deg: ${tight.length + shut.length}`);
  console.log(`  mean lower crest ${mean(out.map(r => r.both)).toFixed(1)}deg`
    + `   mean higher crest ${mean(out.map(r => r.worst)).toFixed(1)}deg`);
  for (const ch of [0, 1, 2, 3]) {
    const sub = out.filter(r => r.side['-1'].chapter === ch);
    if (!sub.length) continue;
    console.log(`    chapter ${ch}: ${String(sub.length).padStart(2)} stations`
      + `  mean lower crest ${mean(sub.map(r => r.both)).toFixed(1)}deg`
      + `  mean wall ${mean(sub.flatMap(r => [r.side['-1'].wallHeight, r.side['1'].wallHeight])).toFixed(0)} m`
      + `  mean setback ${mean(sub.flatMap(r => [r.side['-1'].out, r.side['1'].out])).toFixed(0)} m`);
  }
  const skirts = out.flatMap(r => [
    { t: r.t, side: 'L', ...r.side['-1'] }, { t: r.t, side: 'R', ...r.side['1'] },
  ]).sort((a, b) => b.skirtFall - a.skirtFall);
  const tall = skirts.filter(q => q.skirtFall > 60);
  console.log(`\n  outer edge (station 14 -> 15, one quad):`
    + ` ${tall.length} of ${skirts.length} fall more than 60 m`);
  for (const q of skirts.slice(0, 8)) {
    console.log(`    t=${q.t.toFixed(3)} ${q.side}  falls ${q.skirtFall.toFixed(0).padStart(4)} m`
      + ` over ${q.skirtRun.toFixed(0).padStart(3)} m  = ${q.skirtDeg.toFixed(0).padStart(3)}deg face`);
  }

  if (has('full')) {
    console.log('\n  shut stations');
    for (const r of shut) {
      console.log(`    t=${r.t.toFixed(3)} s=${String(r.s).padStart(5)}`
        + `  L ${r.side['-1'].deg.toFixed(1)}deg/${r.side['-1'].out.toFixed(0)}m`
        + `  R ${r.side['1'].deg.toFixed(1)}deg/${r.side['1'].out.toFixed(0)}m`
        + `  L clear ${r.side['-1'].clear.toFixed(0)}/dy ${r.side['-1'].nearDy.toFixed(0)}`
        + `  R clear ${r.side['1'].clear.toFixed(0)}/dy ${r.side['1'].nearDy.toFixed(0)}`);
    }
  }
  console.log();
});
finish(process.exitCode || 0);
