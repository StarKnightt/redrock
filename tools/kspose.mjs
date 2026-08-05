/* MEASUREMENT PROBE (round-2 audit) — poses and clones, per site.
 *
 * Reads the pose id out of aBody and the five clothing colours out of aTone
 * and aHairTone for every instance, attributes each instance to the site that
 * built it by build order (see tools/ksinv.mjs), and asks three things of each
 * group: how many poses it has, how many of its people share one pose, and how
 * many of them are wearing the same clothes. Four in identical clothes reads as
 * one asset repeated whatever their arms are doing, so shirt alone and the
 * (shirt, legs, hair) triple are both counted.
 *
 * Then evidence: for the three sites with the least pose variety, a native
 * 1600x900 frame taken 25 m before the group on the approach with the car
 * running, and a native-resolution crop of exactly those pixels around the
 * group — drawn 1:1 into a canvas of the crop's own size, no filtering and no
 * scaling.
 *
 *   node tools/kspose.mjs [--seed 22] [--approach 25] [--top 3]
 *
 * Writes .meas/r2/kspose-<seed>.json and shots/r2s-<seed>/pose*.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { run } from './harness.mjs';
import { freeze } from './kssnap.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const APPROACH = Number(flag('approach', '25'));
const TOP = Number(flag('top', '3'));
const MINPX = Number(flag('minpx', '12'));

const OUT = path.resolve('.meas/r2');
const SHOTS = path.resolve(`shots/r2s-${SEED}`);
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

function install() {
  const g = window.__game;
  const T = g.THREE;
  const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
  const gl = g.renderer.getContext();
  const mesh = g.scene.getObjectByName('crowd-figures');
  const rails = g.scene.getObjectByName('crowd-barriers');
  const A = mesh.geometry.attributes;
  const P = A.aPlace.array;
  const N = A.aPlace.count;
  const cam = g.camera;
  const hex = v => '#' + Math.round(v).toString(16).padStart(6, '0');

  const sites = g.crowd.sites.map((p, i) => ({
    i, kind: p.kind, s: p.s, side: p.side, cheer: !!p.cheer,
    nGroups: (p.groups || []).length,
    groups: (p.groups || []).map(x => ({ cheer: x.cheer, n: x.n, s: x.s })),
    declared: (p.groups || []).reduce((a, b) => a + b.n, 0),
  }));
  const owner = new Int32Array(N).fill(-2);
  {
    const ordered = sites.filter(p => p.kind !== 'start line');
    const start = sites.find(p => p.kind === 'start line');
    let at = 0;
    for (const p of ordered) for (let k = 0; k < p.declared; k++) owner[at++] = p.i;
    if (start) for (let k = 0; k < start.declared; k++) owner[at++] = start.i;
    if (at !== N) owner.fill(-2);
  }

  const figs = [];
  const V = new T.Vector3();
  for (let i = 0; i < N; i++) {
    const site = sites.find(p => p.i === owner[i]);
    V.set(P[i * 4], P[i * 4 + 1], P[i * 4 + 2]);
    const pr = g.track.project(V, site ? site.s : -1);
    figs.push({
      i, site: owner[i],
      s: +pr.s.toFixed(1), roadDist: +pr.dist.toFixed(2),
      height: +P[i * 4 + 3].toFixed(3),
      pose: Math.round(A.aBody.array[i * 4 + 1]),
      skin: hex(A.aTone.array[i * 4]),
      shirt: hex(A.aTone.array[i * 4 + 1]),
      legs: hex(A.aTone.array[i * 4 + 2]),
      item: hex(A.aTone.array[i * 4 + 3]),
      hair: hex(A.aHairTone.array[i]),
    });
  }

  const R = 2.6, TOP2 = 3.9, BOT = 0.35;
  const v = new T.Vector3(), v4 = new T.Vector4();
  const boxOf = (i) => {
    const x = P[i * 4], y = P[i * 4 + 1], z = P[i * 4 + 2];
    if (y < -1000) return null;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, front = 0, behind = 0;
    for (const dx of [-R, R]) for (const dz of [-R, R]) for (const dy of [-BOT, TOP2]) {
      v.set(x + dx, y + dy, z + dz).applyMatrix4(cam.matrixWorldInverse);
      if (-v.z < 0.5) { behind++; continue; }
      front++;
      v4.set(v.x, v.y, v.z, 1).applyMatrix4(cam.projectionMatrix);
      const sx = (v4.x / v4.w * 0.5 + 0.5) * W, sy = (v4.y / v4.w * 0.5 + 0.5) * H;
      if (sx < x0) x0 = sx; if (sx > x1) x1 = sx;
      if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
    }
    if (!front) return null;
    if (behind) { x0 = 0; x1 = W; y0 = 0; y1 = H; }
    const PAD = 4;
    x0 = Math.max(0, Math.floor(x0) - PAD); x1 = Math.min(W - 1, Math.ceil(x1) + PAD);
    y0 = Math.max(0, Math.floor(y0) - PAD); y1 = Math.min(H - 1, Math.ceil(y1) + PAD);
    if (x1 < x0 || y1 < y0) return null;
    return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  };
  const full = () => {
    const px = new Uint8Array(W * H * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const diff = (a, i, b, j) => Math.abs(a[i] - b[j]) > 6
    || Math.abs(a[i + 1] - b[j + 1]) > 6 || Math.abs(a[i + 2] - b[j + 2]) > 6;
  let threw = 0;
  const step = dt => { try { g.step(dt); } catch (e) { threw++; } };

  window.__ks = {
    W, H, N, sites, figs, owner: Array.from(owner), threw: () => threw,
    /* One lap, stopping at each wanted station in turn: 25 m before a group,
       car running, camera where the chase puts it. */
    shoot(list, minpx) {
      g.setPaused(true);
      g.goTo(0.0005);
      g.autopilot(true, 0.85);
      g.warp(0.5);
      const out = [];
      for (const tg of list) {
        let guard = 0;
        while (g.player.s < tg.at && guard++ < 60 * 60 * 8) step(1 / 60);
        const real = performance.now.bind(performance);
        const pinned = real();
        performance.now = () => pinned;
        cam.updateMatrixWorld();
        cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
        mesh.visible = true; if (rails) rails.visible = true;
        g.renderOnce(); g.renderOnce();
        const frame = g.renderer.domElement.toDataURL('image/png');
        const base = full();

        /* Where the group lands, as the union of its figures' boxes. */
        let bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9, seen = 0;
        for (const i of tg.figs) {
          const b = boxOf(i);
          if (!b) continue;
          seen++;
          bx0 = Math.min(bx0, b.x0); bx1 = Math.max(bx1, b.x0 + b.w - 1);
          by0 = Math.min(by0, b.y0); by1 = Math.max(by1, b.y0 + b.h - 1);
        }
        let crop = null;
        if (seen) {
          const PAD = 14;
          bx0 = Math.max(0, bx0 - PAD); bx1 = Math.min(W - 1, bx1 + PAD);
          by0 = Math.max(0, by0 - PAD); by1 = Math.min(H - 1, by1 + PAD);
          const cw = bx1 - bx0 + 1, ch = by1 - by0 + 1;
          const c = document.createElement('canvas');
          c.width = cw; c.height = ch;
          const ctx = c.getContext('2d');
          ctx.imageSmoothingEnabled = false;
          // boxOf works in GL coordinates (origin bottom left); drawImage does not.
          ctx.drawImage(g.renderer.domElement, bx0, H - 1 - by1, cw, ch, 0, 0, cw, ch);
          crop = { x0: bx0, y0: by0, w: cw, h: ch, url: c.toDataURL('image/png') };
        }

        /* And what each of the group's figures is worth in pixels here. */
        const heights = [];
        for (const i of tg.figs) {
          const b = boxOf(i);
          if (!b) { heights.push({ i, px: 0, h: 0 }); continue; }
          const y = P[i * 4 + 1];
          P[i * 4 + 1] = -1e5; A.aPlace.needsUpdate = true;
          g.renderOnce();
          const sub = new Uint8Array(b.w * b.h * 4);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.readPixels(b.x0, b.y0, b.w, b.h, gl.RGBA, gl.UNSIGNED_BYTE, sub);
          P[i * 4 + 1] = y; A.aPlace.needsUpdate = true;
          let n = 0, top = -1, bot = -1;
          for (let yy = 0; yy < b.h; yy++) {
            for (let xx = 0; xx < b.w; xx++) {
              const j = (yy * b.w + xx) * 4;
              const i2 = (((b.y0 + yy) * W) + (b.x0 + xx)) * 4;
              if (diff(base, i2, sub, j)) { n++; if (top < 0) top = yy; bot = yy; }
            }
          }
          heights.push({ i, px: n, h: n ? bot - top + 1 : 0 });
        }
        g.renderOnce();
        performance.now = real;
        out.push({
          site: tg.site, at: tg.at, s: +g.player.s.toFixed(1),
          kmh: +g.player.kmh.toFixed(1), frame, crop, heights,
          legible: heights.filter(h => h.h >= minpx).length,
        });
      }
      return out;
    },
  };
  return { W, H, N, ok: owner[0] !== -2 };
}

const snap = await freeze();
console.log(`code snapshot ${snap.stamp}`);
const POSE = ['cheer', 'flag', 'sit', 'pom'];
const CLAIM = { cheer: 32, flag: 35, sit: 12, pom: 21 };

await run({
  width: 1600, height: 900,
  url: `${snap.base}/#manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(1_800_000);
  const boot = await page.evaluate(install);
  const data = await page.evaluate(() => ({
    sites: window.__ks.sites, figs: window.__ks.figs,
  }));
  console.log(`  ${boot.W}x${boot.H}, ${boot.N} instances,`
    + ` build-order attribution ${boot.ok ? 'exact' : 'FAILED'}`);

  const bySite = data.sites.map(p => {
    const fs2 = data.figs.filter(f => f.site === p.i);
    const hist = [0, 0, 0, 0];
    fs2.forEach(f => hist[f.pose]++);
    const distinct = hist.filter(v => v > 0).length;
    const maxSame = Math.max(...hist);
    const count = (key) => {
      const m = new Map();
      fs2.forEach(f => m.set(f[key], (m.get(f[key]) || 0) + 1));
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const kitM = new Map();
    fs2.forEach(f => {
      const k = `${f.shirt}/${f.legs}/${f.hair}`;
      kitM.set(k, (kitM.get(k) || 0) + 1);
    });
    const kit = [...kitM.entries()].sort((a, b) => b[1] - a[1]);
    return {
      ...p, n: fs2.length, hist, distinct, maxSame,
      d4: maxSame >= 4,
      variety: fs2.length ? +(distinct / fs2.length).toFixed(3) : 0,
      shirts: count('shirt'), maxShirt: count('shirt')[0] ? count('shirt')[0][1] : 0,
      kits: kit, maxKit: kit[0] ? kit[0][1] : 0,
      figIdx: fs2.map(f => f.i),
      heightsM: fs2.map(f => f.height),
    };
  });

  const total = data.figs.length;
  const mix = [0, 0, 0, 0];
  data.figs.forEach(f => mix[f.pose]++);

  /* Least pose variety: distinct poses per head, then the bigger group first —
     a group of six with two poses is a stronger claim about repetition than a
     squad of two with one, and the squads are uniform by design. */
  const ranked = [...bySite].sort((a, b) => a.variety - b.variety || b.n - a.n);
  const chosen = ranked.slice(0, TOP);

  const list = chosen.map(p => ({
    site: p.i, at: Math.max(6, p.s - APPROACH), figs: p.figIdx,
  })).sort((a, b) => a.at - b.at);
  const shot = await page.evaluate(([l, m]) => window.__ks.shoot(l, m), [list, MINPX]);

  const shots = [];
  for (const sh of shot) {
    const p = bySite.find(q => q.i === sh.site);
    const tag = `${p.kind.replace(/ /g, '')}-s${Math.round(p.s)}`;
    const f1 = path.join(SHOTS, `pose-site${p.i}-${tag}-approach${APPROACH}m.png`);
    fs.writeFileSync(f1, Buffer.from(sh.frame.split(',')[1], 'base64'));
    let f2 = null;
    if (sh.crop) {
      f2 = path.join(SHOTS, `pose-site${p.i}-${tag}-crop${sh.crop.w}x${sh.crop.h}.png`);
      fs.writeFileSync(f2, Buffer.from(sh.crop.url.split(',')[1], 'base64'));
    }
    shots.push({
      site: p.i, kind: p.kind, siteS: p.s, carS: sh.s, kmh: sh.kmh,
      frame: f1, crop: f2, cropBox: sh.crop ? { w: sh.crop.w, h: sh.crop.h } : null,
      heights: sh.heights, legible: sh.legible,
    });
    console.log(`   site ${p.i} ${p.kind}@${Math.round(p.s)}: car at s=${sh.s}`
      + ` (${sh.kmh} km/h), ${sh.legible}/${sh.heights.length} legible,`
      + ` heights ${sh.heights.map(h => h.h).join('/')} px`
      + `  crop ${sh.crop ? sh.crop.w + 'x' + sh.crop.h : 'none'}`);
  }

  const result = {
    seed: SEED, codeSnapshot: snap.stamp, approach: APPROACH, minpx: MINPX,
    figures: total, sites: bySite, mix,
    mixPct: mix.map(v => +(100 * v / total).toFixed(1)),
    claim: CLAIM, ranked: ranked.map(p => ({ i: p.i, kind: p.kind, s: p.s, variety: p.variety, n: p.n, hist: p.hist })),
    shots,
  };
  fs.writeFileSync(path.join(OUT, `kspose-${SEED}.json`), JSON.stringify(result, null, 1));

  console.log(`\n=== SEED ${SEED} — poses and clothes, ${total} figures ===`);
  console.log('\n   #  kind           s      n  poses c/f/s/p  distinct  most-of-one'
    + '  D4?  same-shirt  same shirt+legs+hair');
  bySite.forEach(p => console.log(`  ${String(p.i).padStart(2)}  ${p.kind.padEnd(13)}`
    + `${String(Math.round(p.s)).padStart(5)}${String(p.n).padStart(6)}`
    + `   ${p.hist.join('/').padEnd(12)}${String(p.distinct).padStart(6)}`
    + `${String(p.maxSame).padStart(12)}`
    + `  ${(p.d4 ? 'YES' : ' - ').padStart(3)}`
    + `${String(p.maxShirt).padStart(11)} of ${p.n}`
    + `${String(p.maxKit).padStart(14)} of ${p.n}`));

  const d4 = bySite.filter(p => p.d4);
  console.log(`\n  sites with 4 or more figures in ONE pose (round-1 defect D4):`
    + ` ${d4.length}${d4.length ? ' — ' + d4.map(p => `${p.i}:${p.kind}@${Math.round(p.s)}`
      + ` (${p.maxSame} x ${POSE[p.hist.indexOf(p.maxSame)]} of ${p.n})`).join(', ') : ''}`);
  const clone4 = bySite.filter(p => p.maxKit >= 4);
  console.log(`  sites with 4 or more figures in IDENTICAL shirt+legs+hair:`
    + ` ${clone4.length}${clone4.length ? ' — ' + clone4.map(p => `${p.i}:${p.kind}@${Math.round(p.s)}`
      + ` (${p.maxKit} of ${p.n}, ${p.kits[0][0]})`).join(', ') : ''}`);
  const shirt4 = bySite.filter(p => p.maxShirt >= 4);
  console.log(`  sites with 4 or more figures in the same SHIRT colour:`
    + ` ${shirt4.length}${shirt4.length ? ' — ' + shirt4.map(p => `${p.i}:${p.kind}@${Math.round(p.s)}`
      + ` (${p.maxShirt} of ${p.n}, ${p.shirts[0][0]})`).join(', ') : ''}`);

  console.log('\n  STAGE POSE MIX vs the claim (cheer 32 / flag 35 / sit 12 / pom 21):');
  POSE.forEach((k, i) => console.log(`    ${k.padEnd(6)} ${String(mix[i]).padStart(3)}`
    + `  ${String(result.mixPct[i]).padStart(5)}%   claimed ${String(CLAIM[k]).padStart(3)}%`
    + `   delta ${(result.mixPct[i] - CLAIM[k] >= 0 ? '+' : '')}${(result.mixPct[i] - CLAIM[k]).toFixed(1)} pt`));

  const hp = data.sites.filter(p => p.kind === 'hairpin exit');
  console.log('\n  HAIRPIN CHEERLEADER CHECK (pose 3 = pom-pom):');
  if (!hp.length) console.log('    no hairpin exit site on this seed');
  hp.forEach(p => {
    const fs2 = data.figs.filter(f => f.site === p.i);
    const poms = fs2.filter(f => f.pose === 3);
    console.log(`    site ${p.i} hairpin exit at s=${Math.round(p.s)}:`
      + ` ${poms.length} of ${fs2.length} in pose 3`
      + `  (cheer flag on the site: ${p.cheer})`
      + `  kit ${poms.length ? poms[0].shirt + '/' + poms[0].legs + '/' + poms[0].hair : '-'}`);
  });

  console.log(`\n  LEAST POSE VARIETY (distinct poses per head, then group size):`);
  ranked.slice(0, 6).forEach((p, k) => console.log(`    ${k + 1}. site ${p.i}`
    + ` ${p.kind}@${Math.round(p.s)}  n=${p.n}  poses ${p.hist.join('/')}`
    + `  variety ${p.variety}${k < TOP ? '   ◀ captured' : ''}`));
  console.log('\n  captures in ' + SHOTS);
  console.log();
});
snap.close();
finish(process.exitCode || 0);
