/* Scratch: chase camera boom length through the tunnel, with and without it. */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

await run({ width: 320, height: 200, hash: 'manual&tier=high&seed=22&cap=60&hud=0' }, async ({ page }) => {
  const out = await page.evaluate(() => {
    const g = window.__game;
    g.setPaused(true);
    const span = g.field.tunnel;
    const rows = [];
    for (const show of [true, false]) {
      g.scene.traverse(o => { if (o.name === 'tunnel') o.visible = show; });
      for (let s = span.s0 - 90; s < span.s1 + 60; s += 20) {
        g.driveTo(Math.max(0.001, s / g.track.length));
        g.renderOnce();
        const c = g.camera.position, p = g.player;
        rows.push({
          show, s: Math.round(p.s),
          boom: +c.distanceTo(p.pos).toFixed(2),
          rise: +(c.y - p.pos.y).toFixed(2),
        });
      }
    }
    return rows;
  });
  const on = out.filter(r => r.show), off = out.filter(r => !r.show);
  console.log('        s    boom(on)  rise(on)   boom(off)  rise(off)');
  for (let i = 0; i < on.length; i++) {
    console.log(`   ${String(on[i].s).padStart(6)} ${String(on[i].boom).padStart(10)}`
      + ` ${String(on[i].rise).padStart(9)} ${String(off[i].boom).padStart(11)}`
      + ` ${String(off[i].rise).padStart(10)}`);
  }
});
finish(process.exitCode || 0);
