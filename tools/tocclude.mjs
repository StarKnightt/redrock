/* Does the mountain actually stand between the bore and the sun?
 *
 * Walks the road centreline through the tunnel and casts a ray at the sun from
 * each station, reporting what stops it. A station whose ray escapes is a
 * station lit through the rock, which is where the "tree shadows on the tunnel
 * floor" come from.
 *
 *   node tools/tocclude.mjs [--seed 22]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');

await run({ width: 320, height: 200, hash: `manual&tier=high&seed=${SEED}&cap=60&hud=0` }, async ({ page }) => {
  const out = await page.evaluate(() => {
    const g = window.__game, THREE = g.THREE;
    const span = g.field.tunnel;
    let sun = null;
    g.scene.traverse(o => { if (o.isDirectionalLight && o.castShadow) sun = o; });
    const dir = sun.position.clone().sub(sun.target.position).normalize();
    const ray = new THREE.Raycaster();
    ray.far = 900;
    const rows = [];
    /* Across the road as well as along it. A ray from the centreline can find
       rock while one from the shoulder on the sun's side walks straight out
       through the side of the shell, and the leak is exactly that shape. */
    const lats = [-0.9, -0.45, 0, 0.45, 0.9];
    for (let s = span.s0 - 12; s <= span.s1 + 12; s += 6) {
      const f = g.track.frameAt(Math.max(0, Math.min(g.track.length, s)));
      const cells = lats.map(u => {
        const origin = f.pos.clone()
          .addScaledVector(f.flatRight, u * f.width * 0.5)
          .addScaledVector(f.up, 0.6);
        ray.set(origin, dir);
        const hits = ray.intersectObjects(g.scene.children, true)
          .filter(q => q.object.visible && q.object.castShadow !== false
            && !/^(sky|ocean|foam|block-clouds|sun-|road$)/.test(q.object.name));
        return hits.length ? (hits[0].object.name || 'unnamed') : 'SKY';
      });
      rows.push({
        s: Math.round(s),
        inside: s >= span.s0 && s <= span.s1,
        cells,
        by: cells[2],
        d: 0,
      });
    }
    return {
      s0: span.s0, s1: span.s1, rows,
      sun: `${dir.x.toFixed(2)},${dir.y.toFixed(2)},${dir.z.toFixed(2)}`,
      elev: `${(Math.asin(dir.y) * 180 / Math.PI).toFixed(0)}°`,
    };
  });
  console.log(`\n  bore ${out.s0.toFixed(0)}-${out.s1.toFixed(0)}  sun ${out.sun}  elevation ${out.elev}\n`);
  const glyph = n => (n === 'SKY' ? '·' : n === 'tunnel-rock' ? '#' : n.startsWith('landform') ? '=' : '?');
  console.log('  across the road, left to right:  # tunnel rock  = hillside  · open sky\n');
  let lit = 0, cells = 0;
  for (const r of out.rows) {
    if (r.inside) { for (const c of r.cells) { cells++; if (c === 'SKY') lit++; } }
    console.log(`  s=${String(r.s).padStart(5)} ${r.inside ? 'IN ' : '   '} ${r.cells.map(glyph).join(' ')}`);
  }
  console.log(`\n  ${lit}/${cells} samples inside the bore see open sky (${(100 * lit / cells).toFixed(0)}%)\n`);
});
finish(process.exitCode || 0);
