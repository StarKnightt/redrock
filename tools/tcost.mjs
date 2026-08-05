/* What the tunnel costs, and what it paid for itself with.
 *
 * The bore's own triangles are only half the story: the keepout that stops
 * shrubs growing inside a mountain also deletes every scatter instance in a
 * cylinder around it, so the net figure can go either way. Builds the stage
 * with the tunnel and again without it and reports both.
 *
 *   node tools/tcost.mjs [--seed 22]
 */
import { Track } from '../src/world/track.js';
import { buildRoad, buildBerms } from '../src/world/track.js';
import { buildEnvironment } from '../src/world/environment.js';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', 22);

const track = new Track(SEED);
const env = buildEnvironment(track, { seed: SEED });
const span = env.userData.tunnel;

const tally = (root) => {
  let total = 0;
  const rows = [];
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    const per = (g.index ? g.index.count : g.attributes.position.count) / 3;
    const n = per * (o.isInstancedMesh ? o.count : 1);
    total += n;
    rows.push([o.name || 'unnamed', n]);
  });
  return { total, rows };
};

const withTunnel = tally(env);
const road = buildRoad(track, { bore: span });
const berms = [1, -1].map(side => buildBerms(track, { side, bore: span }));
const roadTris = (road.index ? road.index.count : road.attributes.position.count) / 3
  + berms.reduce((s, b) => s + (b.index ? b.index.count : b.attributes.position.count) / 3, 0);

console.log(`\n  seed ${SEED}  bore ${span ? `${span.s0.toFixed(0)}–${span.s1.toFixed(0)} m` : 'NONE'}`);
console.log(`  environment ${withTunnel.total.toFixed(0)} tris, road and berms ${roadTris.toFixed(0)}`);
console.log(`  stage total ${(withTunnel.total + roadTris).toFixed(0)}\n`);
for (const [name, n] of withTunnel.rows.filter(r => /tunnel/.test(r[0]))) {
  console.log(`  ${name.padEnd(24)} ${String(n).padStart(7)}`);
}
const tunnelTris = withTunnel.rows.filter(r => /tunnel/.test(r[0])).reduce((s, r) => s + r[1], 0);
console.log(`  ${'tunnel total'.padEnd(24)} ${String(tunnelTris).padStart(7)}\n`);
