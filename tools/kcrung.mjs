/* AUDIT PROBE (round 2) — what is actually drawn where a site's figures stand.
 *
 * `drawnGroundY` claims to reproduce the shoulder the frame draws: it walks the
 * landform ladder at the mesh's own rows and rungs and interpolates the way the
 * quads do. This checks that claim at one site, three ways at the same point:
 *
 *   ladder    `landformPoint(field, s, side, c)` for every rung c, with the
 *             lateral offset of each rung from the road edge, so the spacing
 *             the interpolation is working across is visible;
 *   drawnY    what `crowdProbe.drawnY` returns for the figure's own u;
 *   rays      every intersection of a vertical line through the figure with
 *             every mesh in the stage, top down, with names — so an overhang or
 *             a double-sided backface cannot be mistaken for the ground.
 *
 * Also reported: the tunnel's own extent and whether the site is inside its
 * keep-out, and the same three answers at a spread of lateral offsets across
 * the corridor so the shape of the disagreement is visible rather than a single
 * number.
 *
 *   node tools/kcrung.mjs [--seed 40] [--s 4150]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '40');
const WANT_S = Number(flag('s', '4150'));

await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  const res = await page.evaluate(([wantS]) => {
    const g = window.__game;
    const THREE = g.THREE;
    const t = g.track;
    const env = g.scene.getObjectByName('environment');
    const probe = env.userData.crowdProbe;
    const lp = env.userData.landformPoint;
    const tun = env.userData.tunnel;

    let site = null, bd = Infinity;
    for (const p of g.crowd.sites) {
      const d = Math.abs(p.s - wantS);
      if (d < bd) { bd = d; site = p; }
    }
    const side = site.side;
    const wallDist = probe.wallDist(site.s, side);

    const skip = /sky-dome|sun-disc|ocean-bands|shore-foam|block-clouds|bird|crowd/i;
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
    const stack = (x, z) => {
      ray.far = 1200;
      ray.set(new THREE.Vector3(x, 500, z), new THREE.Vector3(0, -1, 0));
      return ray.intersectObjects(targets, false)
        .map(h => ({ y: +h.point.y.toFixed(2), what: h.object.userData.__probeName }));
    };

    const f = t.frameAt(site.s);
    const edgeY = f.pos.y + (site.at.y - site.rise - f.pos.y);   // pos.y + EDGE_DROP

    // the ladder, rung by rung
    const rungs = [];
    for (let c = 0; c < 10; c++) {
      const p = lp(site.s, side, c);
      const lat = Math.abs((p.x - f.pos.x) * f.flatRight.x + (p.z - f.pos.z) * f.flatRight.z);
      rungs.push({ c, lat: +lat.toFixed(2), y: +p.y.toFixed(2), at: [+p.x.toFixed(1), +p.z.toFixed(1)] });
    }

    // and the corridor swept laterally
    const sweep = [];
    for (let m = 0; m <= Math.min(wallDist, 60); m += 2) {
      const u = m / wallDist;
      const p = probe.point(site.s, side, u);
      const st = stack(p.x, p.z);
      sweep.push({
        m: +m.toFixed(1), u: +u.toFixed(3),
        modelY: +p.y.toFixed(2), drawnY: +probe.drawnY(site.s, side, u).toFixed(2),
        top: st[0] || null, bottom: st.length ? st[st.length - 1] : null,
        nHits: st.length,
        hits: st.slice(0, 6),
      });
    }

    // the figures themselves
    const mesh = g.scene.getObjectByName('crowd-figures');
    const place = mesh.geometry.getAttribute('aPlace');
    const figs = [];
    for (let i = 0; i < place.count; i++) {
      const x = place.getX(i), y = place.getY(i), z = place.getZ(i);
      if (Math.hypot(x - site.at.x, z - site.at.z) > 30) continue;
      const st = stack(x, z);
      const pr = t.project(new THREE.Vector3(x, y, z), site.s);
      figs.push({
        i, at: [+x.toFixed(2), +y.toFixed(2), +z.toFixed(2)], h: +place.getW(i).toFixed(2),
        projS: +pr.s.toFixed(1), projLat: +pr.lat.toFixed(2),
        drawnYHere: +probe.drawnY(pr.s, side, Math.abs(pr.lat) / probe.wallDist(pr.s, side)).toFixed(2),
        stack: st, nHits: st.length,
        buried: st.length ? +(st[0].y - y).toFixed(2) : null,
      });
    }

    return {
      site: {
        kind: site.kind, s: +site.s.toFixed(1), side, u: +site.u.toFixed(4),
        out: +(site.u * wallDist).toFixed(2), wallDist: +wallDist.toFixed(1),
        rise: +site.rise.toFixed(2), seen: site.seen,
        at: [+site.at.x.toFixed(2), +site.at.y.toFixed(2), +site.at.z.toFixed(2)],
      },
      roadY: +f.pos.y.toFixed(2), edgeY: +edgeY.toFixed(2),
      halfWidth: +(f.width / 2).toFixed(2),
      dropness: null,
      tunnel: tun ? {
        s0: tun.s0 ?? tun.from ?? null, s1: tun.s1 ?? tun.to ?? null,
        keys: Object.keys(tun),
      } : null,
      rungs, sweep, figs,
    };
  }, [WANT_S]);

  const s = res.site;
  console.log(`\n  seed ${SEED} — ${s.kind} s=${s.s} side ${s.side}: standing ${s.out} m out`
    + ` (u=${s.u}) of a ${s.wallDist} m corridor, rise ${s.rise} m`);
  console.log(`  road centreline y ${res.roadY}, road edge y ${res.edgeY},`
    + ` half width ${res.halfWidth} m`);
  if (res.tunnel) console.log(`  tunnel keys: ${res.tunnel.keys.join(',')}`);

  console.log(`\n  THE LANDFORM LADDER at s=${s.s}, side ${s.side}`
    + '  (the rungs drawnGroundY interpolates between):');
  console.log('     rung   lateral from centreline   y');
  for (const r of res.rungs) {
    console.log(`     ${String(r.c).padStart(4)}   ${String(r.lat).padStart(21)} m`
      + `   ${String(r.y).padStart(8)}`);
  }

  console.log('\n  ACROSS THE CORRIDOR — model surface, drawnGroundY, and every mesh'
    + ' a vertical ray hits:');
  console.log('      m out    field.point y   drawnGroundY   topmost mesh hit'
    + '            lowest hit          hits');
  for (const w of res.sweep) {
    console.log(`     ${String(w.m).padStart(6)}  ${String(w.modelY).padStart(14)}`
      + `  ${String(w.drawnY).padStart(13)}   ${String(w.top ? w.top.y : '—').padStart(8)}`
      + ` ${String(w.top ? w.top.what : '').padEnd(20)}`
      + ` ${String(w.bottom ? w.bottom.y : '—').padStart(8)} ${String(w.bottom ? w.bottom.what : '').padEnd(16)}`
      + ` ${w.nHits}`);
  }

  console.log(`\n  THE FIGURES (${res.figs.length}):`);
  for (const f of res.figs) {
    console.log(`    instance ${f.i}  origin ${JSON.stringify(f.at)}  height ${f.h} m`);
    console.log(`      projects to s=${f.projS}, ${f.projLat} m lateral;`
      + ` drawnGroundY there ${f.drawnYHere}`);
    console.log(`      vertical ray stack: ${f.stack.map(h => `${h.what}@${h.y}`).join('  ')}`);
    console.log(`      topmost drawn surface is ${f.buried} m ABOVE the figure's feet`
      + `  → ${f.buried > f.h ? 'THE FIGURE IS INSIDE THE TERRAIN' : 'clear'}`);
  }
  const jf = path.join(ROOT, '.meas', 'r2', `kcrung-${SEED}-${WANT_S}.json`);
  fs.mkdirSync(path.dirname(jf), { recursive: true });
  fs.writeFileSync(jf, JSON.stringify(res, null, 1));
  console.log('\n  json → ' + jf + '\n');
});
finish(process.exitCode || 0);
