/* How much sky is in the frame, and how far apart are its values?
 *
 * The critic's finding that reframed the environment: the world is not short
 * of detail, it is short of sky. On twelve of sixty evenly spaced stations the
 * frame held 5% or less sky because landform walls stood 100–250 m out on both
 * sides, and 95% of the image sat below 0.09 luminance. Three rounds of adding
 * vegetation could not fix that, because in those frames there is nothing to
 * be dense against.
 *
 * This is the gate for the fix. At each station it reports the fraction of the
 * frame that is sky, the luminance percentiles, the modal bucket of the eight-
 * rung ladder, and how much of the frame sits in the bottom rung — and then
 * names the contiguous blocks that fail, so a change can be judged on whether
 * the blocks shrank rather than on whether a screenshot looks nicer.
 *
 * Sky is identified geometrically rather than by colour: a pixel is sky if a
 * ray through it hits the sky dome, the clouds or nothing, which does not
 * confuse a pale cliff for an opening the way a luminance threshold does.
 *
 * Stations inside the tunnel bore are reported but not counted. They have no
 * sky by construction and always will; leaving them in the count also bridged
 * the two real failures either side of the mountain into a four-station block
 * that was not one.
 *
 *   node tools/sky.mjs [--seed 22] [--stops 60] [--list] [--shots] [--who]
 *
 * --who names what the non-sky rays actually hit, and at what elevation above
 * the lens, which is the difference between "the crests are too high" and
 * "something is standing in front of the camera".
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const has = k => args.includes('--' + k);
const SEED = flag('seed', '22');
const STOPS = Number(flag('stops', '60'));
const SHOTS = has('shots');
const WHO = has('who');
/* A named list of stations instead of an even sweep. The full gate is four
   minutes; while chasing one block that is the whole iteration. */
const AT = (flag('at', '') || '').split(',').filter(Boolean).map(Number);
/* Take a named object out of the scene before measuring. The only reliable
   way to answer "what is behind that" when the thing in front is opaque. */
const HIDE = (flag('hide', '') || '').split(',').filter(Boolean);

/* What the critic measured the open coastal frames at, and the floor the
   corridors have to clear to stop being corridors. */
const SKY_FAIL = 0.05;
const SKY_WANT = 0.12;

await run({
  width: 960, height: 540,
  hash: `manual&tier=high&seed=${SEED}&cap=60&hud=0&ink=1`,
}, async ({ page }) => {
  const out = await page.evaluate(async ({ stops, shots, who, at, hide }) => {
    const g = window.__game, THREE = g.THREE;
    if (hide.length) g.scene.traverse(o => { if (hide.includes(o.name)) o.visible = false; });
    const env = g.scene.getObjectByName('environment');
    const coastOf = env.userData.coast.signedDistanceXZ;
    /* Where the bore is, so a station under the mountain can be told apart from
       a station in a corridor. Both have no sky and only one of them is a
       defect. */
    const bore = env.userData.tunnel;
    const ray = new THREE.Raycaster();
    ray.far = 4000;
    const rows = [];
    const frames = {};
    /* Anything that is not solid world. A ray that reaches one of these, or
       reaches nothing at all, was looking at the sky. */
    const OPEN = /^(sky|block-clouds|sun-|ocean|foam)/;
    /* One canvas and one histogram for the whole sweep. Allocating a 960x540
       canvas plus its ImageData per station is a quarter of a gigabyte over
       sixty stations and killed the renderer before the run finished — which
       is why this gate had not been read at full resolution in a while. */
    const cv0 = g.renderer.domElement;
    const tmp = document.createElement('canvas');
    tmp.width = cv0.width; tmp.height = cv0.height;
    const ctx = tmp.getContext('2d', { willReadFrequently: true });
    const BINS = 2048;
    const hist = new Uint32Array(BINS);
    const ndc = new THREE.Vector2();
    const list = at.length ? at : Array.from({ length: stops }, (_, i) => (i + 0.5) / stops);
    for (const t of list) {
      g.driveTo(t);
      g.setPaused(true);
      g.renderOnce();
      const cv = g.renderer.domElement, w = cv.width, h = cv.height;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(cv, 0, 0);
      if (shots) frames[t.toFixed(3)] = tmp.toDataURL('image/png');
      const px = ctx.getImageData(0, 0, w, h).data;

      hist.fill(0);
      const rung = new Array(8).fill(0);
      const n0 = px.length / 4;
      for (let n = 0; n < px.length; n += 4) {
        const v = (0.2126 * px[n] + 0.7152 * px[n + 1] + 0.0722 * px[n + 2]) / 255;
        hist[Math.min(BINS - 1, (v * BINS) | 0)]++;
        rung[Math.min(7, (v * 8) | 0)]++;
      }
      /* Percentiles off the histogram rather than off a sorted list of half a
         million doubles. Half a bin of error is 0.0002 of luminance. */
      const pcts = [0.05, 0.5, 0.95];
      const vals = [];
      let seen = 0, k = 0;
      for (let b = 0; b < BINS && k < pcts.length; b++) {
        seen += hist[b];
        while (k < pcts.length && seen >= n0 * pcts[k]) vals[k++] = (b + 0.5) / BINS;
      }
      while (k < pcts.length) vals[k++] = 1;

      /* Sky by raycast, on a coarse grid — a few hundred rays is plenty for a
         fraction and a great deal cheaper than one per pixel. */
      let open = 0, total = 0;
      const tally = {};
      for (let y = 0; y < h; y += Math.floor(h / 15)) {
        for (let x = 0; x < w; x += Math.floor(w / 22)) {
          total++;
          ndc.set((x / w) * 2 - 1, -((y / h) * 2 - 1));
          ray.setFromCamera(ndc, g.camera);
          const hit = ray.intersectObjects(g.scene.children, true)
            .find(q => q.object.visible && !OPEN.test(q.object.name || ''));
          if (!hit) { open++; continue; }
          if (!who) continue;
          /* Only rays aimed at or above the lens can be costing sky; a ray
             into the road is not an enclosure problem. */
          if (ndc.y < 0) continue;
          const name = hit.object.name || hit.object.parent?.name || '(unnamed)';
          const rec = tally[name] || (tally[name] = { n: 0, d: 0, rise: 0, away: 0, over: 0, sea: 0 });
          rec.n++;
          rec.d += hit.distance;
          /* Which stretch of road this piece of scenery belongs to. A wall
             that belongs to the road you are on is a corridor; one that
             belongs to a section three hundred metres away has swung across
             the view and is a different defect with a different fix. */
          let best = Infinity, bs = 0, by = 0;
          for (let k = 0; k < g.track.count; k += 4) {
            const fr = g.track.frames[k];
            const d2 = (fr.pos.x - hit.point.x) ** 2 + (fr.pos.z - hit.point.z) ** 2;
            if (d2 < best) { best = d2; bs = fr.s; by = fr.pos.y; }
          }
          rec.away += Math.abs(bs - g.player.s);
          rec.over += hit.point.y - by;
          /* Positive means this piece of land is standing out past the
             shoreline, over water. */
          rec.sea += coastOf(hit.point.x, hit.point.z) > 0 ? 1 : 0;
          /* Elevation of the hit above the lens, in degrees. */
          rec.rise += (Math.atan2(hit.point.y - g.camera.position.y,
            Math.hypot(hit.point.x - g.camera.position.x,
              hit.point.z - g.camera.position.z)) * 180) / Math.PI;
        }
      }
      const modal = Math.max(...rung) / n0;
      rows.push({
        t: +t.toFixed(3),
        s: g.player.s,
        /* Inside the bore, with a margin for the chase lens trailing the car
           through the portal. */
        bore: !!bore && g.player.s > bore.s0 - 12 && g.player.s < bore.s1 + 12,
        sky: open / total,
        p05: vals[0], p50: vals[1], p95: vals[2],
        dark: rung[0] / n0,
        modal,
        rung: rung.map(n => (100 * n) / n0),
        tally,
      });
    }
    return { rows, frames, length: g.track.length };
  }, { stops: STOPS, shots: SHOTS, who: WHO, at: AT, hide: HIDE });

  if (SHOTS) {
    await mkdir('shots/sky', { recursive: true });
    for (const [t, url] of Object.entries(out.frames)) {
      await writeFile(`shots/sky/${t}.png`, Buffer.from(url.split(',')[1], 'base64'));
    }
  }

  /* A station under the mountain is not a corridor. The bore is authored
     enclosure — it is supposed to have no sky in it, it is a hundred and thirty
     metres long, and counting it here would both inflate the failure count and,
     worse, bridge the two genuine failures on either side of it into a
     contiguous block that does not exist. Reported separately rather than
     silently dropped. */
  const inBore = out.rows.filter(r => r.bore);
  const open = out.rows.filter(r => !r.bore);
  const fails = open.filter(r => r.sky <= SKY_FAIL);
  const thin = open.filter(r => r.sky > SKY_FAIL && r.sky < SKY_WANT);

  if (has('list')) {
    console.log('\n      t      s    sky    p05    p50    p95   bottom rung   modal');
    for (const r of out.rows) {
      const mark = r.bore ? ' -- in the bore'
        : r.sky <= SKY_FAIL ? ' <= FAIL' : r.sky < SKY_WANT ? ' <- thin' : '';
      console.log(`  ${r.t.toFixed(3)} ${String(Math.round(r.s)).padStart(6)}`
        + ` ${(100 * r.sky).toFixed(1).padStart(5)}%`
        + ` ${r.p05.toFixed(3)} ${r.p50.toFixed(3)} ${r.p95.toFixed(3)}`
        + ` ${(100 * r.dark).toFixed(1).padStart(10)}%`
        + ` ${(100 * r.modal).toFixed(1).padStart(7)}%${mark}`);
    }
  }

  /* Contiguous runs of failing stations, which is the shape the critic
     reported and the shape a fix has to change.
     The merge test used to run before the fail test, so once any block had
     opened every later station extended it whether it failed or not — which
     is how sixteen scattered failures were reported as one unbroken corridor
     of forty-one stations running to the end of the course. Only a failing
     station may open or extend a block. */
  const blocks = [];
  for (const r of open) {
    if (r.sky > SKY_FAIL) continue;
    const last = blocks[blocks.length - 1];
    if (last && r.t - last.end < 1.6 / STOPS) { last.end = r.t; last.n++; }
    else blocks.push({ start: r.t, end: r.t, n: 1 });
  }
  const real = blocks.filter(b => b.n >= 2);

  console.log(`\n  ${out.rows.length} stations, seed ${SEED}`
    + (inBore.length ? `  (${inBore.length} inside the bore, not counted: `
      + inBore.map(r => r.t.toFixed(3)).join(' ') + ')' : ''));
  console.log(`  sky <= ${(100 * SKY_FAIL).toFixed(0)}%: ${fails.length}/${open.length}`
    + `   thin (< ${(100 * SKY_WANT).toFixed(0)}%): ${thin.length}`);
  const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  console.log(`  worst station t=${open.reduce((a, b) => (a.sky < b.sky ? a : b)).t}`
    + ` at ${(100 * Math.min(...open.map(r => r.sky))).toFixed(1)}% sky`);
  console.log(`  median p50 luma across all stations ${mean(out.rows.map(r => r.p50)).toFixed(3)}`);
  console.log(`  worst modal bucket ${(100 * Math.max(...open.map(r => r.modal))).toFixed(1)}%`);
  if (fails.length) {
    console.log(`\n  failing blocks (2+ adjacent): ${real.length || 'none'}`);
    for (const b of real) {
      console.log(`    t ${b.start.toFixed(3)}–${b.end.toFixed(3)}  ${b.n} station(s)`);
    }
    console.log(`  isolated failing stations: `
      + fails.filter(r => !real.some(b => r.t >= b.start && r.t <= b.end))
        .map(r => r.t.toFixed(3)).join(' ') || '    none');
    console.log('\n  worst ten');
    for (const r of [...open].sort((a, b) => a.sky - b.sky).slice(0, 10)) {
      console.log(`    t=${r.t.toFixed(3)} s=${String(Math.round(r.s)).padStart(5)}`
        + `  sky ${(100 * r.sky).toFixed(1).padStart(5)}%`
        + `  p50 ${r.p50.toFixed(3)}  p95 ${r.p95.toFixed(3)}`
        + `  bottom rung ${(100 * r.dark).toFixed(1)}%  modal ${(100 * r.modal).toFixed(1)}%`);
    }
  }

  if (WHO) {
    /* What is standing above the lens, across every failing station at once —
       the question "which builder closed the sky" rather than "is it shut". */
    const all = {};
    for (const r of fails) {
      for (const [name, rec] of Object.entries(r.tally)) {
        const a = all[name] || (all[name] = { n: 0, d: 0, rise: 0 });
        a.n += rec.n; a.d += rec.d; a.rise += rec.rise;
      }
    }
    const rank = Object.entries(all).sort((a, b) => b[1].n - a[1].n);
    const tot = rank.reduce((s, [, v]) => s + v.n, 0) || 1;
    console.log('\n  what stands above the lens, station by station');
    for (const r of out.rows) {
      const rank = Object.entries(r.tally).sort((a, b) => b[1].n - a[1].n);
      const tot = rank.reduce((s, [, v]) => s + v[1] ?? 0, 0);
      const n = rank.reduce((s, [, v]) => s + v.n, 0) || 1;
      console.log(`    t=${r.t.toFixed(3)} sky ${(100 * r.sky).toFixed(1).padStart(5)}%  `
        + rank.slice(0, 3).map(([k, v]) => `${k} ${((100 * v.n) / n).toFixed(0)}%`
          + ` @${(v.d / v.n).toFixed(0)}m ${(v.rise / v.n).toFixed(0)}deg`
          + ` [s±${(v.away / v.n).toFixed(0)},`
          + ` ${(v.over / v.n).toFixed(0)}m over it,`
          + ` ${((100 * v.sea) / v.n).toFixed(0)}% past the shore]`).join('  ')
        + (tot ? '' : ''));
    }

    console.log('\n  what stands above the lens at the failing stations');
    for (const [name, v] of rank.slice(0, 14)) {
      console.log(`    ${name.padEnd(24)} ${((100 * v.n) / tot).toFixed(1).padStart(5)}%`
        + `  mean ${(v.d / v.n).toFixed(0).padStart(4)} m out`
        + `  ${(v.rise / v.n).toFixed(1).padStart(5)}° above lens`);
    }
  }
  console.log();
});
finish(process.exitCode || 0);
