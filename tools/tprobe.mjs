/* Scratch: what did the tunnel meshes actually come out as? */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

await run({ width: 320, height: 200, hash: 'manual&tier=high&seed=22&cap=60&hud=0' }, async ({ page }) => {
  const out = await page.evaluate(() => {
    const g = window.__game, rows = [];
    let span = null;
    g.scene.traverse(o => { if (o.userData && o.userData.span) span = o.userData.span; });
    g.scene.traverse(o => {
      if (!/^tunnel/.test(o.name) || !o.geometry) return;
      const b = o.geometry.boundingBox;
      const p = o.geometry.attributes.position.array;
      let nan = 0;
      for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) nan++;
      rows.push(`${o.name}  tris ${o.geometry.index.count / 3}  verts ${p.length / 3}`
        + `  nan ${nan}  cast ${o.castShadow}`
        + `  box x[${b.min.x.toFixed(0)},${b.max.x.toFixed(0)}]`
        + ` y[${b.min.y.toFixed(0)},${b.max.y.toFixed(0)}]`
        + ` z[${b.min.z.toFixed(0)},${b.max.z.toFixed(0)}]`);
    });
    const sun = g.sun;
    const c = sun && sun.shadow ? sun.shadow.camera : null;
    return {
      rows, span,
      sun: sun ? `intensity ${sun.intensity} pos ${sun.position.toArray().map(v => v.toFixed(0))}` : 'none',
      shadow: c ? `l${c.left.toFixed(0)} r${c.right.toFixed(0)} t${c.top.toFixed(0)} b${c.bottom.toFixed(0)} n${c.near} f${c.far}` : 'none',
      mapSize: sun && sun.shadow ? sun.shadow.mapSize.toArray() : null,
    };
  });
  out.rows.forEach(r => console.log('  ' + r));
  console.log('  span', JSON.stringify(out.span));
  console.log('  sun', out.sun);
  console.log('  shadow cam', out.shadow, 'map', out.mapSize);
});
finish(process.exitCode || 0);
