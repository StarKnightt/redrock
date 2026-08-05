/* What is that? Name the object under a point in the frame.
 *
 * A capture shows something wrong and the next question is always which
 * builder made it. Everything else here measures aggregates; this answers the
 * single question a screenshot actually raises.
 *
 *   node tools/poke.mjs --at 0.172 --px 61 --py 20
 *
 * --px/--py are per cent across and down the frame, which is how you read a
 * position off an image without counting pixels.
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const AT = Number(flag('at', '0.5'));
const PX = Number(flag('px', '50'));
const PY = Number(flag('py', '50'));

await run({
  width: 960, height: 540,
  hash: `manual&tier=high&seed=${SEED}&cap=60&hud=0&ink=1`,
}, async ({ page }) => {
  const out = await page.evaluate(({ at, px, py }) => {
    const g = window.__game, THREE = g.THREE;
    g.driveTo(at);
    g.setPaused(true);
    g.renderOnce();
    const ray = new THREE.Raycaster();
    ray.far = 8000;
    ray.setFromCamera(new THREE.Vector2((px / 100) * 2 - 1, 1 - (py / 100) * 2), g.camera);
    const hits = ray.intersectObjects(g.scene.children, true)
      .filter(h => h.object.visible)
      .slice(0, 6);
    /* Everything distinct within a few per cent of the aim point. A spire is a
       couple of pixels wide and a single ray walks straight past it. */
    const around = {};
    for (let a = -4; a <= 4; a += 0.5) {
      for (let b = -6; b <= 6; b += 0.5) {
        ray.setFromCamera(
          new THREE.Vector2(((px + a) / 100) * 2 - 1, 1 - ((py + b) / 100) * 2), g.camera);
        const h = ray.intersectObjects(g.scene.children, true).find(q => q.object.visible);
        if (!h) continue;
        const k = h.object.name || '(unnamed)';
        const rec = around[k] || (around[k] = { n: 0, d: Infinity, top: -Infinity });
        rec.n++;
        rec.d = Math.min(rec.d, h.distance);
        rec.top = Math.max(rec.top, h.point.y);
      }
    }
    return {
      around,
      s: g.player.s,
      lens: [g.camera.position.x, g.camera.position.y, g.camera.position.z],
      hits: hits.map(h => {
        const o = h.object;
        const b = o.geometry && o.geometry.boundingBox;
        return {
          name: o.name || '(unnamed)',
          parent: o.parent && o.parent.name,
          d: h.distance,
          point: [h.point.x, h.point.y, h.point.z],
          instanceId: h.instanceId,
          size: b ? [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z] : null,
        };
      }),
    };
  }, { at: AT, px: PX, py: PY });

  console.log(`\n  t=${AT} s=${out.s.toFixed(0)}  lens y=${out.lens[1].toFixed(1)}`
    + `  ray through ${PX}%,${PY}% of the frame\n`);
  for (const h of out.hits) {
    console.log(`    ${h.name.padEnd(26)}${h.instanceId !== undefined && h.instanceId !== null ? '#' + h.instanceId : ''}`
      + `  ${h.d.toFixed(1).padStart(7)} m`
      + `  at y=${h.point[1].toFixed(1)} (${(h.point[1] - out.lens[1]).toFixed(1)} above the lens)`
      + (h.parent && h.parent !== h.name ? `  in ${h.parent}` : '')
      + (h.size ? `  geom ${h.size.map(v => v.toFixed(1)).join(' x ')}` : ''));
  }
  console.log('\n  everything within a few per cent of that point:');
  for (const [k, v] of Object.entries(out.around).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`    ${k.padEnd(26)} ${String(v.n).padStart(4)} rays`
      + `  nearest ${v.d.toFixed(0)} m  highest y=${v.top.toFixed(0)}`);
  }
  console.log();
});
finish(process.exitCode || 0);
