/* kb* probe — is there DRAWN geometry directly under every spectator?
 *
 * Independent of tools/wfeet.mjs and tools/zqdrawn.mjs (neither read, neither
 * trusted). Construction:
 *
 *   For every instance origin in the crowd's aPlace attribute, drop a ray from
 *   300 m above it, straight down, against every mesh in g.stage except the
 *   sky dome, the sun disc, the ocean bands, the shore foam, the cloud blocks,
 *   the two bird flocks and the crowd itself. The TOPMOST hit is the surface a
 *   viewer from above would see. gap = originY - topmostHitY; positive means
 *   the figure's feet are above the mesh, i.e. standing on air.
 *
 * aPlace.y IS the foot height: crowdFigureGeometry builds the figure in unit
 * space with y = 0 at the soles and the vertex shader places it at aPlace.xyz
 * scaled by aPlace.w. Standers are sunk 0.06 m by construction; sitters get
 * drawnY + 0.74 - 0.44*height, which for the shipped height range is 0.02 m
 * above to 0.13 m below the ground, so no pose needs special casing.
 *
 * Reported twice: against everything (which can legitimately hit a boulder or
 * a tree canopy the figure is standing under) and against terrain and road
 * only, so a hit on scenery cannot be mistaken for a hit on ground.
 *
 *   node tools/kbray.mjs [--seeds 22,1,40] [--bar 0.6]
 */
import fs from 'node:fs';
import path from 'node:path';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');
const BAR = Number(flag('bar', '0.6'));

const all = [];
for (const SEED of SEEDS) {
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    page.setDefaultTimeout(600_000);
    const out = await page.evaluate(([bar]) => {
      const g = window.__game;
      const THREE = g.THREE;
      const t = g.track;
      if (!g.crowd) return { none: true };
      const mesh = g.scene.getObjectByName('crowd-figures');
      const place = mesh.geometry.getAttribute('aPlace');
      const body = mesh.geometry.getAttribute('aBody');
      const n = place.count;

      const SKIP = /^sky-dome$|^sun-disc$|^ocean-bands$|^shore-foam$|^block-clouds$|bird|^crowd-figures$|^crowd-barriers$/i;
      const GROUND = /^landform-|^basin-floor$|^road$|^berm|^ramp-pad$|^tunnel-bore$|^tunnel-rock$|^road-supports$/;

      const targets = [], groundTargets = [], skipped = [];
      g.stage.traverse(o => {
        if (!o.isMesh || !o.visible) return;
        const nm = o.name || '(unnamed)';
        if (SKIP.test(nm)) { skipped.push(nm); return; }
        targets.push(o);
        if (GROUND.test(nm)) groundTargets.push(o);
      });
      g.scene.updateMatrixWorld(true);

      const rc = new THREE.Raycaster();
      rc.far = 2000;
      rc.firstHitOnly = false;
      const down = new THREE.Vector3(0, -1, 0);
      const from = new THREE.Vector3();

      /* Station lookup, searched only near the owning site. Unconstrained it
         is wrong wherever the road stacks: seed 22's site at s = 4342 sits
         directly under the ribbon at s = 180, and the global nearest
         centreline point is the one 288 m overhead. */
      const stationOf = (x, z, nearS) => {
        let bs = 0, bd = Infinity;
        const lo = nearS === null ? 0 : Math.max(0, nearS - 80);
        const hi = nearS === null ? t.length : Math.min(t.length, nearS + 80);
        for (let s = lo; s <= hi; s += 2) {
          const f = t.frameAt(s);
          const d = (f.pos.x - x) ** 2 + (f.pos.z - z) ** 2;
          if (d < bd) { bd = d; bs = s; }
        }
        for (let s = Math.max(0, bs - 3); s <= Math.min(t.length, bs + 3); s += 0.25) {
          const f = t.frameAt(s);
          const d = (f.pos.x - x) ** 2 + (f.pos.z - z) ** 2;
          if (d < bd) { bd = d; bs = s; }
        }
        const f = t.frameAt(bs);
        const right = f.flatRight ?? f.right;
        const lat = (x - f.pos.x) * right.x + (z - f.pos.z) * right.z;
        return { s: bs, lat, dist: Math.sqrt(bd) };
      };

      // Which site owns the figure (nearest site centre, for labelling only).
      const siteOf = (x, z) => {
        let best = null, bd = Infinity;
        for (const st of g.crowd.sites) {
          const d = Math.hypot(st.at.x - x, st.at.z - z);
          if (d < bd) { bd = d; best = st; }
        }
        return { kind: best?.kind, s: best ? +best.s.toFixed(0) : null, side: best?.side, d: +bd.toFixed(1) };
      };

      /* The surface a figure stands on is the hit CLOSEST to its soles, signed.
       *
       * Neither "topmost hit" nor "topmost hit at or below the soles" works
       * here. Topmost is wrong at a switchback, where the column also holds
       * the shoulder of the road stacked 288 m overhead (seed 22, s = 4342).
       * At-or-below is wrong everywhere, because the build deliberately sinks
       * every figure 0.06 m, so its own ground is ABOVE the origin and the
       * rule falls through to the basin floor four hundred metres down.
       *
       * Closest-by-|dy| gets both right, and its sign carries the verdict:
       *   dy < -0.6   feet that far above the nearest surface — standing on air
       *   dy > +0.6   that much drawn ground over the soles — buried
       */
      const contact = (hits, oy) => {
        let best = null, bd = Infinity;
        for (const hh of hits) {
          const d = Math.abs(hh.point.y - oy);
          if (d < bd) { bd = d; best = hh; }
        }
        return best;
      };

      const rows = [];
      for (let i = 0; i < n; i++) {
        const ox = place.getX(i), oy = place.getY(i), oz = place.getZ(i);
        from.set(ox, oy + 300, oz);
        rc.set(from, down);
        const hits = rc.intersectObjects(targets, false);
        const gh = rc.intersectObjects(groundTargets, false);
        const ca = contact(hits, oy), cb = contact(gh, oy);
        // Anything strictly under the soles, for describing a genuine floater.
        let underY = null, underName = null;
        for (const hh of hits) {
          if (hh.point.y < oy - 0.001 && (underY === null || hh.point.y > underY)) {
            underY = hh.point.y; underName = hh.object.name || '(unnamed)';
          }
        }
        const st = stationOf(ox, oz, (() => {
          let bd = Infinity, bs = null;
          for (const s2 of g.crowd.sites) {
            const d = Math.hypot(s2.at.x - ox, s2.at.z - oz);
            if (d < bd) { bd = d; bs = s2.s; }
          }
          return bs;
        })());
        rows.push({
          i, pose: body.getY(i),
          x: +ox.toFixed(2), y: +oy.toFixed(2), z: +oz.toFixed(2), h: +place.getW(i).toFixed(2),
          s: +st.s.toFixed(1), lat: +st.lat.toFixed(2),
          site: siteOf(ox, oz),
          /* dy of the contact surface: negative = feet above it (air),
             positive = it is over the soles (buried). Design intent +0.06. */
          dy: ca ? +(ca.point.y - oy).toFixed(2) : null,
          hitName: ca ? (ca.object.name || '(unnamed)') : null,
          gDy: cb ? +(cb.point.y - oy).toFixed(2) : null,
          gHitName: cb ? (cb.object.name || '(unnamed)') : null,
          // the first thing strictly beneath the soles, whatever it is
          underDrop: underY === null ? null : +(oy - underY).toFixed(2),
          underName,
          nHits: hits.length,
          stack: hits.map(hh => `${hh.object.name || '?'}@${hh.point.y.toFixed(2)}`).slice(0, 6),
        });
      }
      return {
        rows, n, length: +t.length.toFixed(1),
        targets: targets.map(o => o.name || '(unnamed)'),
        skipped: [...new Set(skipped)],
      };
    }, [BAR]);

    if (out.none) { console.log(`seed ${SEED}: no crowd`); return; }
    const air = out.rows.filter(r => r.dy === null || r.dy < -BAR);
    const gAir = out.rows.filter(r => r.gDy === null || r.gDy < -BAR);
    /* Burial counted on the same ray and the same bar, because a figure with
       drawn ground half a metre over its soles is as wrong as one with drawn
       ground half a metre under them, and neither pixel instrument looks. */
    const sunk = out.rows.filter(r => r.gDy !== null && r.gDy > BAR);
    const dys = out.rows.map(r => r.dy).filter(v => v !== null).sort((a, b) => a - b);
    console.log(`\n══ seed ${SEED}   ${out.n} figures   track ${out.length} m`);
    console.log(`   skipped meshes: ${out.skipped.join(', ')}`);
    console.log(`   contact dy (surface y minus sole y; design intent +0.06):`
      + ` min ${dys[0]} p05 ${dys[(dys.length * 0.05) | 0]} med ${dys[dys.length >> 1]}`
      + ` p95 ${dys[(dys.length * 0.95) | 0]} max ${dys[dys.length - 1]}`);
    console.log(`   ON AIR, any drawn mesh  : ${air.length} of ${out.n} feet more than ${BAR} m above the nearest surface`);
    console.log(`   ON AIR, terrain+road    : ${gAir.length} of ${out.n}`);
    console.log(`   BURIED, terrain+road    : ${sunk.length} of ${out.n} soles more than ${BAR} m under the terrain`);
    const sorted = out.rows.slice().sort((a, b) => (a.dy ?? -1e9) - (b.dy ?? -1e9));
    console.log('   worst 5 by air:');
    for (const r of sorted.slice(0, 5)) {
      console.log(`     i=${String(r.i).padStart(3)} s=${String(r.s).padStart(7)} lat=${String(r.lat).padStart(7)}`
        + ` pose=${r.pose} site=${r.site.kind}/${r.site.s}  dy=${r.dy} on ${r.hitName}`
        + `   nearest thing strictly under the soles: ${r.underDrop === null ? 'NOTHING' : r.underDrop + ' m down (' + r.underName + ')'}`);
    }
    console.log('   worst 5 by burial:');
    for (const r of sorted.slice(-5).reverse()) {
      console.log(`     i=${String(r.i).padStart(3)} s=${String(r.s).padStart(7)} lat=${String(r.lat).padStart(7)}`
        + ` pose=${r.pose} site=${r.site.kind}/${r.site.s} h=${r.h}  dy=${r.dy} on ${r.hitName}`);
    }
    for (const r of air) {
      console.log(`   ◀── AIR i=${r.i} seed ${SEED} s=${r.s} lat=${r.lat} site=${r.site.kind} s=${r.site.s} side=${r.site.side}`
        + `  origin y=${r.y}  dy=${r.dy} on ${r.hitName}   stack: ${r.stack.join(' | ')}`);
    }
    for (const r of sunk) {
      console.log(`   ◀── BURIED i=${r.i} seed ${SEED} s=${r.s} lat=${r.lat} site=${r.site.kind} s=${r.site.s} side=${r.site.side}`
        + `  origin y=${r.y} h=${r.h}  ${r.gDy} m of ${r.gHitName} above the soles`
        + ` (${(100 * r.gDy / r.h).toFixed(0)}% of the figure)`
        + `  nearest surface strictly under the soles: ${r.underDrop === null ? 'NOTHING' : r.underDrop + ' m down (' + r.underName + ')'}`
        + `   stack: ${r.stack.join(' | ')}`);
    }
    all.push({ seed: SEED, n: out.n, air: air.length, gAir: gAir.length, sunk: sunk.length, rows: out.rows });
  });
}

const dir = path.resolve('.meas/r2');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'kb-ray.json'), JSON.stringify(all, null, 1));
const tot = all.reduce((a, b) => a + b.n, 0), totAir = all.reduce((a, b) => a + b.air, 0);
const totG = all.reduce((a, b) => a + b.gAir, 0), totS = all.reduce((a, b) => a + b.sunk, 0);
console.log(`\n  TOTAL ON AIR: ${totAir} of ${tot} figures more than ${BAR} m above the nearest drawn mesh`);
console.log(`  TOTAL ON AIR (terrain+road only): ${totG} of ${tot}`);
console.log(`  TOTAL BURIED: ${totS} of ${tot} figures with more than ${BAR} m of terrain above their soles`);
console.log(`  json: ${path.join(dir, 'kb-ray.json')}`);
finish(process.exitCode || 0);
