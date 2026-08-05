/* What is actually filling the top of the frame at a given stop?
 *
 * Casts rays through a grid of screen points and names the object hit, so the
 * "flat sage-grey void" can be attributed to a mesh rather than guessed at.
 *
 *   node tools/skyprobe.mjs [--t 0.76,0.995,0.60]
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const STOPS = flag('t', '0.60,0.76,0.995').split(',').map(Number);

await run({ width: 1024, height: 576, hash: 'manual&tier=high&seed=22&cap=60&hud=0' }, async ({ page }) => {
  const outDir = path.join(ROOT, 'shots', 'skyprobe');
  fs.mkdirSync(outDir, { recursive: true });

  for (const t of STOPS) {
    const r = await page.evaluate(t => {
      const g = window.__game;
      const THREE = g.THREE;
      g.setPaused(true);
      g.driveTo(t);
      g.renderOnce();

      const ray = new THREE.Raycaster();
      ray.far = 20000;
      const named = o => { let n = o.name, p = o.parent; while (!n && p) { n = p.name; p = p.parent; } return n || '(unnamed)'; };
      const rows = [];
      for (const sy of [-0.9, -0.7, -0.45, -0.2, 0.1]) {           // NDC y: +1 top
        const row = [];
        for (const sx of [-0.8, -0.4, 0, 0.4, 0.8]) {
          ray.setFromCamera(new THREE.Vector2(sx, -sy), g.camera);
          const hits = ray.intersectObject(g.scene, true)
            .filter(h => h.object.visible && h.object.material && h.object.material.visible);
          const h = hits[0];
          row.push(h ? `${named(h.object)}@${h.distance.toFixed(0)}` : 'SKY/none');
        }
        rows.push(row);
      }
      const cam = g.camera.position;
      return {
        rows,
        cam: [+cam.x.toFixed(0), +cam.y.toFixed(0), +cam.z.toFixed(0)],
        fov: +g.camera.fov.toFixed(1),
        s: +g.player.s.toFixed(0),
        fogNear: g.scene.fog?.near, fogFar: g.scene.fog?.far,
        fog: g.scene.fog ? '#' + g.scene.fog.color.getHexString() : null,
      };
    }, t);
    await capture(page, path.join(outDir, `${String(Math.round(t * 100)).padStart(3, '0')}.png`));
    console.log(`\nt=${t}  s=${r.s}  cam=${r.cam.join(',')}  fov=${r.fov}  fog ${r.fog} ${r.fogNear}-${r.fogFar}`);
    console.log('  screen rows, top of frame first:');
    for (const row of r.rows) console.log('    ' + row.map(c => c.padEnd(24)).join(''));
  }
});

finish(process.exitCode || 0);
