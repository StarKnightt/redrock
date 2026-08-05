/* Scratch: where did the bore ring actually land, relative to the road? */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

await run({ width: 320, height: 200, hash: 'manual&tier=high&seed=22&cap=60&hud=0' }, async ({ page }) => {
  const out = await page.evaluate(() => {
    const g = window.__game;
    const span = g.field.tunnel;
    const s = (span.s0 + span.s1) / 2;
    const f = g.track.frameAt(s);
    let bore = null;
    g.scene.traverse(o => { if (o.name === 'tunnel-bore') bore = o; });
    const p = bore.geometry.attributes.position;
    const rows = [];
    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < p.count; i++) {
      const d = Math.hypot(p.getX(i) - f.pos.x, p.getZ(i) - f.pos.z);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    const start = Math.max(0, bestI - 4);
    for (let i = start; i < start + 12 && i < p.count; i++) {
      const dx = p.getX(i) - f.pos.x, dy = p.getY(i) - f.pos.y, dz = p.getZ(i) - f.pos.z;
      rows.push(`v${i}  lat ${(dx * f.right.x + dz * f.right.z).toFixed(2)}`
        + `  up ${(dx * f.up.x + dy * f.up.y + dz * f.up.z).toFixed(2)}`
        + `  dy ${dy.toFixed(2)}`);
    }
    return {
      rows,
      width: f.width,
      right: f.right.toArray().map(v => +v.toFixed(3)),
      up: f.up.toArray().map(v => +v.toFixed(3)),
      rightLen: +f.right.length().toFixed(4),
      upLen: +f.up.length().toFixed(4),
    };
  });
  console.log('  road width', out.width, ' right', out.right, `|${out.rightLen}|`,
    ' up', out.up, `|${out.upLen}|`);
  out.rows.forEach(r => console.log('  ' + r));
});
finish(process.exitCode || 0);
