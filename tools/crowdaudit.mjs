/* Does the driver actually pass the crowd, and how big is it when they do?
 *
 * Three questions, and the schedule cannot answer any of them on its own —
 * tools/cadence.mjs makes the same argument about the landmarks. A group is
 * only a group if the car comes near it, if it is more than a few pixels tall
 * when it does, and if the proximity reaction has started before it is behind
 * you.
 *
 *   reach     closest approach of the road to each group, by walking the
 *             centreline rather than trusting the station it was placed from.
 *   size      how tall a spectator is in pixels at the distances they are
 *             actually seen from, at the capture resolution the critic uses.
 *   reaction  where the car is when a group first stirs, and where it is when
 *             the group is at full height — both in metres and in the seconds
 *             those metres are worth at the speed the car is doing there.
 *
 *   node tools/crowdaudit.mjs [--seed 22] [--height 900]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const H = Number(flag('height', '900'));

await run({
  width: 1600, height: H,
  hash: `manual&tier=high&seed=${SEED}&cap=60&hud=0`,
}, async ({ page }) => {
  const out = await page.evaluate(() => {
    const g = window.__game;
    const t = g.track;
    const crowd = g.crowd;
    if (!crowd) return { none: true };

    /* A speed profile good enough to turn metres into seconds. The same
       point-mass model the landmark scheduler uses; see routeTiming. */
    const speedAt = (s) => {
      let peak = 0;
      for (let d = -20; d <= 40; d += 5) {
        const c = t.frameAt(Math.max(0, Math.min(t.length, s + d))).curv;
        if (Math.abs(c) > Math.abs(peak)) peak = c;
      }
      const R = 1 / Math.max(Math.abs(peak), 1e-4);
      return Math.min(Math.sqrt(0.86 * 9.81 * Math.min(R, 900)), 52);
    };

    const rows = crowd.sites.map(site => {
      const at = site.at;
      let closest = Infinity, atS = site.s, lateral = 0;
      /* Within a couple of hundred metres of where it was placed, not over the
         whole lap. The stage is a loop and the finish is a stone's throw from
         the grid in space while being five and a half kilometres from it along
         the road: a global search hands the finish crowd a "closest approach"
         taken from the start straight, and with it a sightline through half a
         mountain. */
      for (let s = Math.max(0, site.s - 250); s <= Math.min(t.length, site.s + 250); s += 2) {
        const f = t.frameAt(s);
        const d = Math.hypot(at.x - f.pos.x, at.z - f.pos.z);
        if (d < closest) { closest = d; atS = s; lateral = d - f.width * 0.5; }
      }
      return {
        kind: site.kind, s: +site.s.toFixed(0), side: site.side,
        u: +site.u.toFixed(2), rise: +site.rise.toFixed(1),
        closest: +closest.toFixed(1), kerb: +lateral.toFixed(1), atS: +atS.toFixed(0),
        at: { x: at.x, z: at.z },
        groups: site.groups.map(gr => `${gr.cheer ? 'cheer' : 'crowd'}x${gr.n}`).join(' + '),
        n: site.groups.reduce((a, b) => a + b.n, 0),
        speed: +speedAt(site.s).toFixed(1),
      };
    });

    /* Whether the driver can actually see them, which the closest-approach
       number cannot answer: a group can be eleven metres away and behind the
       bank it is standing under. Ground truth, through Three's own raycaster
       against the stage, from a chase lens ten metres back at the station of
       closest approach — the last chance the driver gets. */
    const THREE = g.THREE;
    const skip = /sky-dome|sun-disc|ocean-bands|shore-foam|block-clouds|bird|beam|foam|crowd/i;
    const targets = [];
    g.stage.updateMatrixWorld(true);
    g.stage.traverse(o => {
      if (!o.isMesh) return;
      let nm = o.name;
      for (let q = o.parent; !nm && q; q = q.parent) nm = q.name;
      if (skip.test(nm || '')) return;
      o.userData.__probeName = nm || '(unnamed)';
      targets.push(o);
    });
    const ray = new THREE.Raycaster();
    const dir = new THREE.Vector3(), head = new THREE.Vector3();
    g.autopilot(true, 0.85);
    const mesh = g.scene.getObjectByName('crowd-figures');
    const place = mesh.geometry.getAttribute('aPlace');
    for (const row of rows) {
      /* The real chase lens, not a guess at where it would be. Two earlier
         guesses — the centreline at 2.3 m, then the near kerb at 2.4 m —
         each reported a group blocked that the capture plainly shows, once by
         the camber of the road the ray flew over and once by the berm the
         lens actually sits above. The rig has a boom that lengthens, lifts and
         dodges; the only honest eye point is the one it computes. */
      const mine = [];
      for (let i = 0; i < place.count; i++) {
        const ox = place.getX(i), oy = place.getY(i), oz = place.getZ(i);
        if (Math.hypot(ox - row.at.x, oz - row.at.z) > 26) continue;
        // Mid-chest, so heads-over-the-grass does not read as visible.
        mine.push(new THREE.Vector3(ox, oy + place.getW(i) * 0.55, oz));
      }
      /* Sampled down the whole approach, not at the moment the car is abeam.
         Abeam is the one station where the answer does not matter: the group
         is out of the side window at ninety degrees and the driver is looking
         at the next corner. The frames that count are the two seconds before,
         and a group only fails if it is hidden through all of them. */
      const ever = mine.map(() => false);
      let worst = null, best = 0;
      for (const back of [80, 55, 35, 22, 12]) {
        g.goTo(Math.max(0, row.atS - back - 55) / t.length);
        g.warp(0.75);
        const stop = Math.max(1, row.atS - back);
        for (let k = 0; k < 260 && g.player.s < stop; k++) g.step(1 / 60);
        const eye = g.camera.position.clone();
        let n = 0;
        for (let i = 0; i < mine.length; i++) {
          dir.copy(mine[i]).sub(eye);
          const len = dir.length();
          ray.far = len - 0.35;
          ray.set(eye, dir.normalize());
          const hit = ray.intersectObjects(targets, false)[0];
          if (!hit) { ever[i] = true; n++; }
          else {
            worst = `${hit.object.userData.__probeName} at `
              + `${(100 * hit.distance / len).toFixed(0)}% of ${len.toFixed(0)} m`
              + ` (y ${hit.point.y.toFixed(1)} vs figure ${mine[i].y.toFixed(1)})`;
          }
        }
        if (n > best) { best = n; row.bestAt = back; }
        (row.trace ??= []).push(`${back}m:${n}/${mine.length}@s${g.player.s.toFixed(0)}`);
      }
      row.seen = ever.filter(Boolean).length;
      row.total = mine.length;
      row.blocker = worst;
    }

    const u = crowd.uniforms;
    /* Sample the figure heights straight off the instance buffer rather than
       off the constants — the constants are what was asked for and this is
       what was built. */
    const size = place;
    let hMin = 99, hMax = 0, hSum = 0;
    for (let i = 0; i < size.count; i++) {
      const h = size.getW(i);
      hMin = Math.min(hMin, h); hMax = Math.max(hMax, h); hSum += h;
    }
    return {
      rows,
      figures: crowd.figures,
      triangles: crowd.triangles,
      height: { min: +hMin.toFixed(2), max: +hMax.toFixed(2), mean: +(hSum / size.count).toFixed(2) },
      react: { far: u.uReactFar.value, near: u.uReactNear.value, stagger: u.uStagger.value },
      hop: u.uHop.value,
      fov: g.camera.fov,
      length: +t.length.toFixed(0),
      /* Every mesh the camera's collision proxy flattened, so "billboards are
         not in the proxy" is a measurement and not a claim. */
      proxy: g.solid.names.slice(),
      proxyPattern: String(g.solid.include),
    };
  });

  if (out.none) { console.log('  no crowd on this build'); return; }

  console.log(`\n  seed ${SEED} — ${out.rows.length} sites, ${out.figures} figures, `
    + `${out.triangles} triangles`);
  console.log(`  figure height ${out.height.min}–${out.height.max} m (mean ${out.height.mean})`);
  console.log('\n  site              s     side  u     rise   closest  off kerb   seen  groups');
  for (const r of out.rows) {
    console.log(`    ${r.kind.padEnd(14)} ${String(r.s).padStart(5)}`
      + `  ${String(r.side).padStart(4)}  ${r.u.toFixed(2)}`
      + `  ${(r.rise + ' m').padStart(6)}`
      + `  ${(r.closest + ' m').padStart(8)}`
      + `  ${(r.kerb + ' m').padStart(8)}`
      + `  ${(r.seen + '/' + r.total).padStart(5)}`
      + `  ${r.groups}${r.seen < r.total ? '   blocked by ' + r.blocker : ''}`
      + `\n        ${r.trace.join('  ')}`);
  }
  const worst = Math.max(...out.rows.map(r => r.kerb));
  console.log(`\n  furthest any group ever is from the kerb at closest approach: ${worst} m`);

  /* Screen-space. px per metre at distance d for a vertical fov f and a frame
     h pixels tall is h / (2 d tan(f/2)). */
  const tan = Math.tan((out.fov * Math.PI) / 360);
  const pxAt = (d, m) => (H * m) / (2 * d * tan);
  console.log(`\n  a ${out.height.mean} m spectator at ${1600}x${H}, fov ${out.fov}:`);
  for (const d of [12, 20, 30, 45, 70, 100]) {
    console.log(`    ${String(d).padStart(4)} m   ${pxAt(d, out.height.mean).toFixed(0).padStart(3)} px tall`
      + `   hop ${pxAt(d, out.height.mean * out.hop).toFixed(1).padStart(4)} px`);
  }

  /* What the reaction is actually worth in pixels on the way in. The smooth
     step the shader runs, sampled at the distances the group is passed at,
     with the hop it produces converted through the same lens the sizes above
     use. A reaction that is real in metres and two pixels in frame is the
     failure this project keeps finding. */
  console.log('\n  the reaction on the approach, at the resolution the critic captures:');
  console.log('       d     raised   hop px   figure px');
  for (const d of [90, 70, 50, 35, 24, 15]) {
    const t = (out.react.far - d) / (out.react.far - out.react.near);
    const ex = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
    const hop = pxAt(d, out.height.mean * out.hop * ex);
    console.log(`    ${String(d).padStart(4)} m  ${(100 * ex).toFixed(0).padStart(5)}%`
      + `  ${hop.toFixed(1).padStart(7)}  ${pxAt(d, out.height.mean).toFixed(0).padStart(8)}`);
  }

  console.log(`\n  reaction: stirs at ${out.react.far} m, full at ${out.react.near} m,`
    + ` ${out.react.stagger} m of stagger across a group`);
  for (const r of out.rows) {
    const t0 = (out.react.far - out.react.near) / r.speed;
    console.log(`    ${r.kind.padEnd(14)} at ${r.speed} m/s: stirs `
      + `${(out.react.far / r.speed).toFixed(2)} s out, fully up `
      + `${(out.react.near / r.speed).toFixed(2)} s out, ${t0.toFixed(2)} s of ramp`);
  }

  console.log(`\n  camera collision proxy pattern ${out.proxyPattern}`);
  const crowdInProxy = out.proxy.filter(n => /crowd/i.test(n));
  console.log(`  meshes in the proxy: ${out.proxy.length}`
    + `   of them crowd: ${crowdInProxy.length ? crowdInProxy.join(',') : 'none'}`);
  console.log();
});
finish(process.exitCode || 0);
