/* Is the mountain shadowing its own tunnel?
 *
 * The interior road came out with tree-shaped shadows on it, which can only
 * happen if the shell above is not reaching the shadow map. Renders the same
 * interior frame three ways — as built, with the shell hidden, and with the
 * sun's shadow off — and reports the mean road luma of each. If hiding the
 * shell changes nothing, the shell was never casting.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

await run({ width: 640, height: 360, hash: 'manual&tier=high&seed=22&cap=60&ink=0' }, async ({ page }) => {
  const out = await page.evaluate(() => {
    const g = window.__game, THREE = g.THREE;
    const span = g.field.tunnel;
    g.driveTo((span.s0 + (span.s1 - span.s0) * 0.5) / g.track.length);
    g.setPaused(true);

    let shell = null, sun = null;
    g.scene.traverse(o => {
      if (o.name === 'tunnel-rock') shell = o;
      if (o.isDirectionalLight && o.castShadow) sun = o;
    });

    /* Bottom third of the frame, which inside the bore is all road and kerb. */
    const luma = () => {
      g.renderOnce();
      const cv = g.renderer.domElement, w = cv.width, h = cv.height;
      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      const ctx = tmp.getContext('2d');
      ctx.drawImage(cv, 0, 0);
      const px = ctx.getImageData(0, Math.floor(h * 0.66), w, Math.floor(h * 0.34)).data;
      let sum = 0, n = 0, min = 1, max = 0;
      for (let i = 0; i < px.length; i += 4) {
        const v = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
        sum += v; n++;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      return { mean: sum / n, min, max };
    };

    const grab = () => {
      const cv = g.renderer.domElement;
      const tmp = document.createElement('canvas');
      tmp.width = cv.width; tmp.height = cv.height;
      tmp.getContext('2d').drawImage(cv, 0, 0);
      return tmp.toDataURL('image/png');
    };
    /* Every reading below is a difference between renders of one frozen
       frame, so the animation clock is pinned across the lot:
       src/world/environment.js sets a shader uniform from performance.now()
       inside onBeforeRender, and unpinned the swaying verge lands in the
       lit-versus-shadowed ratio as though the sun had moved. */
    const realNow = performance.now.bind(performance);
    const tPin = realNow(); performance.now = () => tPin;
    const shots = {};
    const asBuilt = luma(); shots.asBuilt = grab();
    shell.visible = false;
    const noShell = luma(); shots.noShell = grab();
    shell.visible = true;
    const wasCast = shell.castShadow;
    shell.castShadow = false;
    const noCast = luma();
    shell.castShadow = wasCast;
    /* Decisive test: per-pixel ratio between the shadowed and unshadowed
       renders, over the pixels a raycast says are road. A partial shadow shows
       up as a population sitting at 1.0 alongside the shadowed one. */
    const pixels = () => {
      g.renderOnce();
      const cv = g.renderer.domElement, w = cv.width, h = cv.height;
      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      tmp.getContext('2d').drawImage(cv, 0, 0);
      return { d: tmp.getContext('2d').getImageData(0, 0, w, h).data, w, h };
    };
    const lit = (() => { sun.castShadow = false; const p = pixels(); sun.castShadow = true; return p; })();
    const dark = pixels();
    const ray = new THREE.Raycaster();
    const ratios = [];
    for (let y = Math.floor(lit.h * 0.5); y < lit.h; y += 4) {
      for (let x = 0; x < lit.w; x += 4) {
        const i = (y * lit.w + x) * 4;
        ray.setFromCamera(new THREE.Vector2((x / lit.w) * 2 - 1, -((y / lit.h) * 2 - 1)), g.camera);
        const hit = ray.intersectObjects(g.scene.children, true).find(q => q.object.visible);
        if (!hit || hit.object.name !== 'road') continue;
        const a = 0.2126 * lit.d[i] + 0.7152 * lit.d[i + 1] + 0.0722 * lit.d[i + 2];
        const b = 0.2126 * dark.d[i] + 0.7152 * dark.d[i + 1] + 0.0722 * dark.d[i + 2];
        if (a > 4) ratios.push({ r: b / a, lit: a });
      }
    }
    /* Two populations, split by whether the shadow changed the pixel at all,
       compared by their *unshadowed* value. If the pixels the shadow failed to
       darken are the ones that were already sitting at a particular height on
       the value ladder, the shadow is not leaking — the posterise step is
       rounding it away. */
    const same = ratios.filter(v => v.r > 0.92), moved = ratios.filter(v => v.r <= 0.92);
    const avg = a => (a.length ? a.reduce((s, v) => s + v.lit, 0) / a.length / 255 : 0);
    const buckets = a => {
      const b = new Array(8).fill(0);
      for (const v of a) b[Math.min(7, Math.floor((v.lit / 255) * 8))]++;
      return b.map(n => ((100 * n) / Math.max(1, a.length)).toFixed(0)).join(' ');
    };
    const split = {
      same: { n: same.length, lit: avg(same), hist: buckets(same) },
      moved: { n: moved.length, lit: avg(moved), hist: buckets(moved) },
    };
    ratios.sort((a, b) => a.r - b.r);
    const unshadowed = same.length;

    const withSun = sun ? { on: sun.castShadow, w: sun.shadow.mapSize.width } : null;
    if (sun) sun.castShadow = false;
    const noSun = luma(); shots.noSun = grab();
    if (sun) sun.castShadow = true;
    performance.now = realNow;

    return {
      s: g.player.s, asBuilt, noShell, noCast, noSun, sun: withSun, shots,
      road: {
        n: ratios.length,
        unshadowed,
        median: ratios.length ? ratios[ratios.length >> 1].r : 0,
        p10: ratios.length ? ratios[Math.floor(ratios.length * 0.1)].r : 0,
        p90: ratios.length ? ratios[Math.floor(ratios.length * 0.9)].r : 0,
        split,
      },
      shellTris: shell.geometry.getAttribute('position').count / 3,
      bounds: (() => {
        shell.geometry.computeBoundingBox();
        const b = shell.geometry.boundingBox;
        return `y ${b.min.y.toFixed(1)}..${b.max.y.toFixed(1)}`;
      })(),
      camY: g.camera.position.y, carY: g.player.pos.y,
    };
  });
  await mkdir('shots/tshadow', { recursive: true });
  for (const [k, url] of Object.entries(out.shots)) {
    await writeFile(`shots/tshadow/${k}.png`, Buffer.from(url.split(',')[1], 'base64'));
  }
  const p = v => `mean ${v.mean.toFixed(3)}  ${v.min.toFixed(2)}-${v.max.toFixed(2)}`;
  console.log(`\n  s=${out.s.toFixed(0)}  shell ${out.shellTris} tris  ${out.bounds}`);
  console.log(`  sun shadow ${out.sun && out.sun.on ? 'on' : 'off'} map ${out.sun && out.sun.w}`);
  console.log(`  road band, as built    ${p(out.asBuilt)}`);
  console.log(`  road band, shell hidden ${p(out.noShell)}`);
  console.log(`  road band, shell !cast  ${p(out.noCast)}`);
  console.log(`  road band, sun !shadow  ${p(out.noSun)}`);
  const r = out.road;
  console.log(`\n  road pixels sampled ${r.n}: shadow ratio p10 ${r.p10.toFixed(2)}`
    + `  median ${r.median.toFixed(2)}  p90 ${r.p90.toFixed(2)}`);
  console.log(`  ${r.unshadowed} of ${r.n} (${(100 * r.unshadowed / Math.max(1, r.n)).toFixed(1)}%)`
    + ' are unchanged by the mountain');
  const s = r.split;
  console.log('\n  unshadowed luma of each population, and its spread over the 8 rungs');
  console.log(`    unchanged  n=${String(s.same.n).padStart(5)}  mean ${s.same.lit.toFixed(3)}   ${s.same.hist}`);
  console.log(`    darkened   n=${String(s.moved.n).padStart(5)}  mean ${s.moved.lit.toFixed(3)}   ${s.moved.hist}`);
});
finish(process.exitCode || 0);
