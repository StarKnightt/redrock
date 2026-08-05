/* kb* probe — what is under the boots, identified POSITIVELY.
 *
 * tools/zqboots.mjs labels the band under a figure's feet by elimination:
 * sea if the water ablation moved the pixel, sky if the prepass depth looks
 * unwritten, and GROUND OTHERWISE. "Otherwise" is doing all the work, and it
 * is the one branch that can never be wrong for the wrong reason — anything
 * the instrument fails to recognise lands in it. Worse, the prepass renders
 * the whole scene including the sky dome, so nothing in a frame has an
 * unwritten depth and the sky branch cannot fire at all (tools/kbdepth.mjs).
 *
 * So: ablate the GROUND. Hide the landform, the basin floor, the road, the
 * berms, the ramp pads and the pylons, and a pixel that moves was ground.
 * Ablate the sky dome and the sun disc and a pixel that moves was sky. Ablate
 * the ocean bands and the shore foam and a pixel that moves was sea. Every
 * label is then a positive identification, "other" is an explicit fourth
 * bucket rather than a silent default, and the instrument cannot pass a
 * figure by failing to recognise what it is standing over.
 *
 * Three classifiers run on the SAME frame so the reconciliation carries no
 * cross-run variance:
 *   kb   the ablation labelling above
 *   zq   zqboots' rule, reimplemented exactly (water ablation, then depth
 *        non-finite / <=0 / >4000 as sky, then ground)
 *   zz   zzfoot's rule, reimplemented exactly (median band depth over the
 *        figure's own view-space z, plus the worst single-row jump)
 *
 * Every figure with any ablation footprint at all is judged, at every stand-off
 * rather than only the one where it is biggest, and a 200x200 native crop of
 * the unmodified frame is saved under the boots for anything that fails or on
 * which two classifiers disagree.
 *
 * Discipline as elsewhere: performance.now() pinned for a whole station,
 * frame 0 discarded, 1600x900 through g.pipeline.render(), the car driven in.
 *
 *   node tools/kbfoot.mjs [--seeds 22,1,40] [--backs 20,12,6] [--minh 0]
 *                         [--shots shots/r2b] [--control]
 */
import fs from 'node:fs';
import path from 'node:path';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const has = k => args.includes('--' + k);
const SEEDS = flag('seeds', '22,1,40').split(',');
const BACKS = flag('backs', '20,12,6').split(',').map(Number);
const MINH = Number(flag('minh', '0'));
const SHOTS = flag('shots', 'shots/r2b');
const CONTROL = has('control');
const TAG = flag('tag', '');

const summary = [];
for (const SEED of SEEDS) {
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    page.setDefaultTimeout(900_000);
    const out = await page.evaluate(([backs, minh, control]) => {
      const g = window.__game;
      const THREE = g.THREE;
      const t = g.track;
      if (!g.crowd) return { none: true };
      const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
      const gl = g.renderer.getContext();
      const mesh = g.scene.getObjectByName('crowd-figures');
      const place = mesh.geometry.getAttribute('aPlace');

      const pick = re => { const a = []; g.stage.traverse(o => { if (o.isMesh && re.test(o.name || '')) a.push(o); }); return a; };
      /* Ground is everything a spectator could credibly be standing on: the
         two landform ribbons, the basin floor under them, the road surface,
         its berms and painted pads, the pylons that carry it and the tunnel
         shell. Not trees, not boulders, not barriers — those get counted as
         "other" so that a figure whose contact is a shrub is visible as such
         rather than being quietly passed as grounded. */
      const GROUND = pick(/^landform-|^basin-floor$|^road$|^berm|^ramp-pad$|^road-supports$|^tunnel-bore$|^tunnel-rock$/);
      const WATER = pick(/^ocean-bands$|^shore-foam$/);
      const SKY = pick(/^sky-dome$|^sun-disc$|^block-clouds$/);

      const grab = () => {
        const px = new Uint8Array(W * H * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      const moved = (a, b, p) => Math.abs(a[p * 4] - b[p * 4]) > 6
        || Math.abs(a[p * 4 + 1] - b[p * 4 + 1]) > 6
        || Math.abs(a[p * 4 + 2] - b[p * 4 + 2]) > 6;
      // p indexes the bottom-up readPixels buffer; (x, yTop) is screen space.
      const at = (x, yTop) => (H - 1 - yTop) * W + x;
      const boxOf = (a, b) => {
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
        for (let p = 0; p < W * H; p++) {
          if (!moved(a, b, p)) continue;
          n++;
          const x = p % W, y = H - 1 - ((p / W) | 0);
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        return n ? { n, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null;
      };
      const ablate = list => {
        const was = list.map(o => o.visible);
        list.forEach(o => { o.visible = false; });
        g.renderOnce();
        const B = grab();
        list.forEach((o, i) => { o.visible = was[i]; });
        g.renderOnce();
        return B;
      };
      const cropPNG = (buf, cx, cy, S) => {
        const x0 = Math.max(0, Math.min(W - S, cx - (S >> 1)));
        const y0 = Math.max(0, Math.min(H - S, cy - (S >> 1)));
        const c = document.createElement('canvas');
        c.width = S; c.height = S;
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(S, S);
        for (let yy = 0; yy < S; yy++) {
          for (let xx = 0; xx < S; xx++) {
            const p = at(x0 + xx, y0 + yy) * 4;
            const q = (yy * S + xx) * 4;
            img.data[q] = buf[p]; img.data[q + 1] = buf[p + 1];
            img.data[q + 2] = buf[p + 2]; img.data[q + 3] = 255;
          }
        }
        ctx.putImageData(img, 0, 0);
        return { url: c.toDataURL('image/png'), x0, y0 };
      };
      const median = a => {
        if (!a.length) return null;
        const s = a.slice().sort((p, q) => p - q);
        return s[s.length >> 1];
      };

      const rows = [], crops = [], controls = [];
      g.setPaused(true);
      g.autopilot(true, 0.85);

      for (let si = 0; si < g.crowd.sites.length; si++) {
        const site = g.crowd.sites[si];
        let closest = Infinity, atS = site.s;
        for (let s = Math.max(0, site.s - 250); s <= Math.min(t.length, site.s + 250); s += 2) {
          const f = t.frameAt(s);
          const d = Math.hypot(site.at.x - f.pos.x, site.at.z - f.pos.z);
          if (d < closest) { closest = d; atS = s; }
        }
        const mine = [];
        for (let i = 0; i < place.count; i++) {
          if (Math.hypot(place.getX(i) - site.at.x, place.getZ(i) - site.at.z) > 26) continue;
          mine.push(i);
        }

        for (const back of backs) {
          g.goTo(Math.max(0, atS - back - 55) / t.length);
          g.warp(0.75);
          const stop = Math.max(1, atS - back);
          for (let k = 0; k < 260 && g.player.s < stop; k++) g.step(1 / 60);

          const real = performance.now.bind(performance);
          const pinned = real();
          performance.now = () => pinned;
          g.renderOnce();                    // frame 0, discarded
          g.renderOnce();
          const A = grab();

          const depth = new Float32Array(W * H * 4);
          g.renderer.readRenderTargetPixels(g.pipeline.normals, 0, 0, W, H, depth);
          const depthAt = (x, yTop) => depth[at(x, yTop) * 4 + 3];

          const noGround = ablate(GROUND);
          const noWater = WATER.length ? ablate(WATER) : null;
          const noSky = SKY.length ? ablate(SKY) : null;

          for (const i of mine) {
            const y0 = place.getY(i);
            place.setY(i, y0 - 5000); place.needsUpdate = true;
            g.renderOnce();
            const B = grab();
            place.setY(i, y0); place.needsUpdate = true;
            g.renderOnce();
            const bb = boxOf(A, B);
            if (!bb) { rows.push({ si, i, back, box: null }); continue; }

            /* The band, five columns wide at three depths below the box, the
               same geometry zqboots and zzfoot use so a disagreement can only
               come from the classification and not from where it looked. */
            const xs = [];
            for (let q = -2; q <= 2; q++) xs.push(Math.round(bb.x0 + bb.w * (0.5 + q * 0.12)));
            let ground = 0, sea = 0, sky = 0, other = 0, zqSea = 0, zqSky = 0, zqGround = 0;
            /* Does the sample band overlap the figure's own ink at all? By
               construction it cannot — bb.y1 is the LAST row the ablation
               moved, so everything belonging to the figure is above it — but
               the claim is cheap to check rather than assert. */
            let ownInk = 0;
            const under = [];
            for (const dy of [3, 5, 8]) {
              const y = bb.y1 + dy;
              for (const x of xs) {
                if (x < 0 || x >= W || y < 0 || y >= H) continue;
                const p = at(x, y);
                if (moved(A, B, p)) ownInk++;
                const d = depthAt(x, y);
                if (isFinite(d) && d > 0) under.push(d);
                // kb: positive identification, ground first because it is the
                // claim being tested and overlaps nothing else.
                if (moved(A, noGround, p)) ground++;
                else if (noWater && moved(A, noWater, p)) sea++;
                else if (noSky && moved(A, noSky, p)) sky++;
                else other++;
                // zq: zqboots' own order and thresholds.
                if (noWater && moved(A, noWater, p)) zqSea++;
                else if (!isFinite(d) || d <= 0 || d > 4000) zqSky++;
                else zqGround++;
              }
            }
            const nb = ground + sea + sky + other || 1;

            // zz: zzfoot's depth ratio and single-row jump.
            const vp = new THREE.Vector3(place.getX(i), place.getY(i), place.getZ(i))
              .applyMatrix4(g.camera.matrixWorldInverse);
            const zFig = -vp.z;
            const dOn = median(under);
            const ratio = dOn ? dOn / zFig : null;
            const walk = [];
            for (let dy = 1; dy <= 14; dy++) {
              const v = depthAt(Math.round(bb.x0 + bb.w * 0.5), bb.y1 + dy);
              if (isFinite(v) && v > 0) walk.push(v);
            }
            let jump = 0;
            for (let q = 1; q < walk.length; q++) {
              const d = walk[q] - walk[q - 1];
              if (Math.abs(d) > Math.abs(jump)) jump = d;
            }
            const jumpFrac = zFig ? Math.abs(jump) / zFig : 0;

            const kbBad = (sea + sky) > nb * 0.5;
            const zqBad = (zqSea + zqSky) > (zqSea + zqSky + zqGround || 1) * 0.5;
            const zzBad = !dOn || ratio > 1.10 || ratio < 0.80 || jumpFrac > 0.25;
            /* A crop of the SHIPPED frame — buffer A, before any ablation —
               for anything that fails, anything the three rules disagree
               about, anything with no positively identified ground under it,
               and every figure at the finish, which is asked for by name. */
            const disagree = !(kbBad === zqBad && zqBad === zzBad);
            if (kbBad || zqBad || zzBad || ground === 0 || site.kind === 'finish') {
              const cr = cropPNG(A, Math.round(bb.x0 + bb.w / 2), bb.y1, 200);
              crops.push({
                i, back, si, kind: site.kind, siteS: Math.round(site.s),
                disagree, kbBad, zqBad, zzBad, ground,
                file: `fig${i}-${site.kind.replace(/\s+/g, '')}-s${Math.round(site.s)}-back${back}`
                  + `-${kbBad ? 'kbBAD' : 'kbok'}-${zqBad ? 'zqBAD' : 'zqok'}-${zzBad ? 'zzBAD' : 'zzok'}`,
                url: cr.url, x0: cr.x0, y0: cr.y0,
              });
            }
            rows.push({
              si, kind: site.kind, siteS: Math.round(site.s), i, back,
              h: bb.h, w: bb.w, npx: bb.n, x0: bb.x0, y1: bb.y1,
              cx: Math.round(bb.x0 + bb.w / 2),
              ground, sea, sky, other, ownInk,
              kbBad, kbNoGround: ground === 0,
              zqSea, zqSky, zqGround, zqBad,
              dFig: +zFig.toFixed(1), dOn: dOn ? +dOn.toFixed(1) : null,
              ratio: ratio ? +ratio.toFixed(2) : null,
              jumpFrac: +(100 * jumpFrac).toFixed(0), zzBad,
              zzKind: !dOn ? 'nothing (sky/water)'
                : jumpFrac > 0.25 ? 'cliff edge under the feet'
                  : ratio > 1.10 ? 'far surface beyond the edge'
                    : ratio < 0.80 ? 'foreground occluder' : 'ground',
            });
          }

          /* Positive control: can this rig see a figure over water at all?
             Take a real figure, move it 40 m out along the camera ray through
             a pixel the water ablation says is ocean with more ocean under it,
             and classify it exactly as above. If that does not come back SEA
             the sea channel is not measuring anything. */
          if (control && noWater && mine.length) {
            let target = null;
            for (let y = 200; y < H - 120 && !target; y += 7) {
              for (let x = 240; x < W - 240; x += 11) {
                if (!moved(A, noWater, at(x, y))) continue;
                let run2 = 0;
                for (let k = 1; k <= 40; k++) if (moved(A, noWater, at(x, y + k))) run2++;
                if (run2 >= 38) { target = { x, y }; break; }
              }
            }
            if (target) {
              const i = mine[0];
              const ox = place.getX(i), oy = place.getY(i), oz = place.getZ(i);
              const ndc = new THREE.Vector3(target.x / W * 2 - 1, -(target.y / H * 2 - 1), 0.5)
                .unproject(g.camera);
              const dir = ndc.sub(g.camera.position).normalize();
              const at40 = g.camera.position.clone().addScaledVector(dir, 40);
              place.setX(i, at40.x); place.setY(i, at40.y); place.setZ(i, at40.z);
              place.needsUpdate = true;
              g.renderOnce();
              const C = grab();
              place.setY(i, at40.y - 5000); place.needsUpdate = true;
              g.renderOnce();
              const D = grab();
              place.setX(i, ox); place.setY(i, oy); place.setZ(i, oz);
              place.needsUpdate = true;
              g.renderOnce();
              const bb = boxOf(C, D);
              if (bb) {
                /* The water mask has to be retaken against C: the frame the
                   moved figure is in is not the frame the site was measured
                   in, and reusing the old one would compare two pictures. */
                place.setX(i, at40.x); place.setY(i, at40.y); place.setZ(i, at40.z);
                place.needsUpdate = true;
                g.renderOnce();
                const noW2 = ablate(WATER);
                const noG2 = ablate(GROUND);
                place.setX(i, ox); place.setY(i, oy); place.setZ(i, oz);
                place.needsUpdate = true;
                g.renderOnce();
                const xs = [];
                for (let q = -2; q <= 2; q++) xs.push(Math.round(bb.x0 + bb.w * (0.5 + q * 0.12)));
                let sea = 0, ground = 0, other = 0, zqSea = 0, zqSky = 0, zqGround = 0;
                for (const dy of [3, 5, 8]) {
                  for (const x of xs) {
                    const y = bb.y1 + dy;
                    if (x < 0 || x >= W || y < 0 || y >= H) continue;
                    const p = at(x, y);
                    const d = depthAt(x, y);
                    if (moved(C, noG2, p)) ground++;
                    else if (moved(C, noW2, p)) sea++;
                    else other++;
                    if (moved(C, noW2, p)) zqSea++;
                    else if (!isFinite(d) || d <= 0 || d > 4000) zqSky++;
                    else zqGround++;
                  }
                }
                const cr = cropPNG(C, Math.round(bb.x0 + bb.w / 2), bb.y1, 200);
                controls.push({
                  si, kind: site.kind, back, h: bb.h, sea, ground, other,
                  zqSea, zqSky, zqGround,
                  file: `control-s${Math.round(site.s)}-back${back}`, url: cr.url,
                });
              }
            }
          }
          performance.now = real;
        }
      }
      g.autopilot(false);
      return { rows, controls, crops, n: place.count, sites: g.crowd.sites.length };
    }, [BACKS, MINH, CONTROL]);

    if (out.none) { console.log(`seed ${SEED}: no crowd`); return; }
    const dir = path.resolve(`${SHOTS}-${SEED}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const c of out.controls) {
      const f = path.join(dir, `kbfoot-${c.file}.png`);
      fs.writeFileSync(f, Buffer.from(c.url.split(',')[1], 'base64'));
      console.log(`   CONTROL ${c.kind} back=${c.back} ${c.h}px  kb: sea ${c.sea} ground ${c.ground} other ${c.other}`
        + `   zq: sea ${c.zqSea} sky ${c.zqSky} ground ${c.zqGround}   ${f}`);
    }

    const saved = [];
    for (const c of out.crops) {
      const f = path.join(dir, `kbfoot-${c.file}.png`);
      fs.writeFileSync(f, Buffer.from(c.url.split(',')[1], 'base64'));
      saved.push({ ...c, url: undefined, path: f });
    }

    const withBox = out.rows.filter(r => r.h !== undefined);
    const tall = withBox.filter(r => r.h >= 10);
    const byFig = new Map();
    for (const r of withBox) {
      if (!byFig.has(r.i)) byFig.set(r.i, []);
      byFig.get(r.i).push(r);
    }
    const figsTall = new Set(tall.map(r => r.i));
    console.log(`\n══ seed ${SEED}   ${out.n} figures, ${out.sites} sites, ${out.rows.length} observations`
      + ` at backs ${BACKS.join('/')} m`);
    console.log(`   observations with any footprint: ${withBox.length}   with h>=10 px: ${tall.length}`);
    console.log(`   figures with >=1 observation of any size : ${byFig.size} of ${out.n}`);
    console.log(`   figures with >=1 observation h>=10 px    : ${figsTall.size} of ${out.n}`
      + `   (never judged by the 10 px floor: ${out.n - figsTall.size})`);
    const ownInk = withBox.reduce((a, b) => a + b.ownInk, 0);
    console.log(`   band samples landing on the figure's own footprint: ${ownInk} of ${withBox.length * 15}`
      + `   (dy=3 clearance check)`);

    // Per-figure verdicts. Tallest observation, and worst over all stand-offs.
    const verdict = [];
    for (const [i, obs] of byFig) {
      const t10 = obs.filter(o => o.h >= 10);
      const tallest = (t10.length ? t10 : obs).slice().sort((a, b) => b.h - a.h)[0];
      verdict.push({
        i, kind: tallest.kind, siteS: tallest.siteS, obs: obs.length, tallest,
        anyKb: obs.some(o => o.kbBad), anyZq: obs.some(o => o.zqBad), anyZz: obs.some(o => o.zzBad),
        anyNoGround: obs.some(o => o.ground === 0),
        tallKb: tallest.kbBad, tallZq: tallest.zqBad, tallZz: tallest.zzBad,
        maxH: Math.max(...obs.map(o => o.h)),
      });
    }
    const c = (f) => verdict.filter(f).length;
    console.log(`   kb  sea-or-sky under the boots  : tallest-only ${c(v => v.tallKb)}   any stand-off ${c(v => v.anyKb)}`);
    console.log(`   zq  (zqboots rule, same frames) : tallest-only ${c(v => v.tallZq)}   any stand-off ${c(v => v.anyZq)}`);
    console.log(`   zz  (zzfoot rule, same frames)  : tallest-only ${c(v => v.tallZz)}   any stand-off ${c(v => v.anyZz)}`);
    console.log(`   kb  NO ground pixel at all under the boots: tallest ${c(v => v.tallest.ground === 0)}`
      + `   any stand-off ${c(v => v.anyNoGround)}`);
    const dis = verdict.filter(v => !(v.tallKb === v.tallZq && v.tallZq === v.tallZz));
    console.log(`   figures the three rules disagree about (tallest observation): ${dis.length}`);
    for (const v of dis) {
      const o = v.tallest;
      console.log(`     i=${String(v.i).padStart(3)} ${v.kind}/${v.siteS} back=${o.back} ${o.h}px`
        + `  kb[g ${o.ground} sea ${o.sea} sky ${o.sky} other ${o.other}]=${o.kbBad ? 'BAD' : 'ok'}`
        + `  zq[sea ${o.zqSea} sky ${o.zqSky} g ${o.zqGround}]=${o.zqBad ? 'BAD' : 'ok'}`
        + `  zz[${o.ratio}x jump ${o.jumpFrac}% ${o.zzKind}]=${o.zzBad ? 'BAD' : 'ok'}`);
    }
    const flip = verdict.filter(v => {
      const small = v.obs > 1 && byFig.get(v.i).some(o => o.kbBad !== v.tallKb);
      return small;
    });
    console.log(`   figures whose kb verdict changes between stand-offs: ${flip.length}`);
    console.log(`   crops saved: ${saved.length} in ${dir}`);
    summary.push({ seed: SEED, rows: out.rows, n: out.n, dir, crops: saved, verdict });
    fs.mkdirSync(path.resolve('.meas/r2'), { recursive: true });
    fs.writeFileSync(path.resolve(`.meas/r2/kb-foot-${SEED}${TAG}.json`), JSON.stringify(out.rows, null, 0));
    console.log(`   json: ${path.resolve(`.meas/r2/kb-foot-${SEED}${TAG}.json`)}`);
  });
}
fs.writeFileSync(path.resolve(`.meas/r2/kb-foot-summary${TAG}.json`),
  JSON.stringify(summary.map(s => ({ seed: s.seed, n: s.n, dir: s.dir })), null, 1));
finish(process.exitCode || 0);
