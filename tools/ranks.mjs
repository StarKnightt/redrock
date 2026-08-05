/* Where the vegetation instances actually come from.
 *
 * budget.mjs names the meshes, but every ridge-tree rank in the stage merges
 * into the same two instanced meshes, so a two-minute browser run says "six
 * thousand trees" and nothing about which of the nine loops made them. This
 * builds the world in node and tallies by call site, which is the number
 * needed to decide what to thin.
 *
 *   node tools/ranks.mjs
 */
import { Track } from '../src/world/track.js';
import { buildEnvironment } from '../src/world/environment.js';

const t = new Track(22);
const env = buildEnvironment(t, { seed: 22 });

const rows = [];
let total = 0;
env.traverse(o => {
  if (!o.isMesh) return;
  const g = o.geometry;
  const per = (g.index ? g.index.count : g.attributes.position.count) / 3;
  const n = o.isInstancedMesh ? o.count : 1;
  rows.push([o.name || '(unnamed)', per * n, n, per]);
  total += per * n;
});
rows.sort((a, b) => b[1] - a[1]);
for (const [name, tris, n, per] of rows) {
  if (tris < 400) continue;
  console.log(`  ${name.padEnd(28)}${String(Math.round(tris)).padStart(7)}`
    + `   ${n > 1 ? `${n} x ${per}` : ''}`);
}
console.log(`\n  stage total ${Math.round(total)} triangles`);
if (env.userData.schedule) {
  console.log(`  ${env.userData.schedule.length} landmark events over `
    + `${env.userData.lapTime.toFixed(0)} s`);
}
