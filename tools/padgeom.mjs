/* Where the boost pad's own mesh actually puts its quads, in the running page.
 *
 * The pad moved onto a self-lit mesh of its own and its chevrons appeared in
 * frame while its ground rectangle did not, which is a claim about geometry
 * that no screenshot can settle. This reads the mesh out of the live scene:
 * every quad, its centre, its size, its colour, and how far it sits above the
 * road surface directly under it.
 *
 *   node tools/padgeom.mjs [--seed 22]
 */
import { run } from './harness.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', 22);

await run({ seed: SEED, width: 480, height: 270 }, async ({ page }) => {
  const out = await page.evaluate(() => {
    const g = window.__game;
    const found = [];
    g.scene.traverse(o => { if (o.name === 'ramp-pad' || o.name === 'ramp-signs') found.push(o); });
    const report = {};
    for (const mesh of found) {
      const pos = mesh.geometry.getAttribute('position');
      const col = mesh.geometry.getAttribute('color');
      const quads = [];
      for (let i = 0; i + 3 < pos.count; i += 4) {
        let cx = 0, cy = 0, cz = 0, minY = 1e9, maxY = -1e9, span = 0;
        const pts = [];
        for (let k = 0; k < 4; k++) {
          const x = pos.getX(i + k), y = pos.getY(i + k), z = pos.getZ(i + k);
          pts.push([x, y, z]);
          cx += x / 4; cy += y / 4; cz += z / 4;
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
        for (const a of pts) for (const b of pts) {
          span = Math.max(span, Math.hypot(a[0] - b[0], a[2] - b[2]));
        }
        const r = col.getX(i), gg = col.getY(i), b = col.getZ(i);
        const hex = '#' + [r, gg, b].map(v =>
          Math.round(v * 255).toString(16).padStart(2, '0')).join('');
        /* Winding: the up component of the first triangle's normal. Negative
           means the quad is facing into the ground and a single-sided material
           will not draw it. */
        const [p0, p1, p2] = pts;
        const ux = p2[0] - p0[0], uy = p2[1] - p0[1], uz = p2[2] - p0[2];
        const vx = p1[0] - p0[0], vy = p1[1] - p0[1], vz = p1[2] - p0[2];
        const ny = uz * vx - ux * vz;
        quads.push({
          x: +cx.toFixed(1), y: +cy.toFixed(2), z: +cz.toFixed(1),
          span: +span.toFixed(2), drop: +(maxY - minY).toFixed(2), hex,
          up: +Math.sign(ny), ny: +ny.toFixed(2),
        });
      }
      report[mesh.name] = {
        tris: mesh.geometry.index.count / 3, quads,
        visible: mesh.visible, side: mesh.material.side,
      };
    }
    return report;
  });
  for (const [name, r] of Object.entries(out)) {
    console.log(`\n  ${name}  ${r.tris} tris  visible=${r.visible} side=${r.side}`);
    console.log('      centre x,y,z            span  drop  colour     facing');
    for (const q of r.quads.slice(0, 14)) {
      console.log(`     ${String(q.x).padStart(8)} ${String(q.y).padStart(7)} ${String(q.z).padStart(8)}`
        + `  ${String(q.span).padStart(5)} ${String(q.drop).padStart(5)}  ${q.hex}`
        + `   ${q.up > 0 ? 'up' : 'DOWN'}  ${q.ny}`);
    }
    if (r.quads.length > 14) console.log(`     ... ${r.quads.length - 14} more`);
  }
});
