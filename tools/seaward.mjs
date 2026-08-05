/* What is actually standing on the seaward shoulder.
   The review's headline defect is that the outer third of the frame is empty
   water in every coastal capture, and a frame grab cannot tell you whether the
   rank is not being placed, is being placed and culled, or is being placed and
   hidden behind the guardrail. This counts instances by object within a window
   of a station, split by side of the road and by height above the kerb. */
import { run } from './harness.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const TS = flag('t', '0.60').split(',').map(Number);
const WINDOW = Number(flag('window', 110));

await run({ width: 320, height: 200 }, async ({ page }) => {
  for (const t of TS) {
    const out = await page.evaluate(async ([t, win]) => {
      const g = window.__game;
      const THREE = g.THREE;
      const field = g.scene.getObjectByName('environment').userData.field;
      const s = t * field.track.length;
      const side = field.coast.seaSideAt(s);
      const p = field.profile(s, side);
      const rows = {};
      const m = new THREE.Matrix4(), v = new THREE.Vector3(), sc = new THREE.Vector3();
      g.scene.traverse((o) => {
        if (!o.isInstancedMesh) return;
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, m);
          v.setFromMatrixPosition(m);
          if (v.distanceTo(p.f.pos) > win) continue;
          const dx = v.x - p.f.pos.x, dz = v.z - p.f.pos.z;
          const lat = dx * p.f.flatRight.x + dz * p.f.flatRight.z;
          if (Math.sign(lat) !== side) continue;
          sc.setFromMatrixScale(m);
          const row = rows[o.name] || (rows[o.name] = { n: 0, tall: 0, lat: 0, drop: 0 });
          row.n++;
          /* Height of the instance in metres, against the 1.15 m rail. */
          const h = sc.y * (o.geometry.boundingBox
            ? o.geometry.boundingBox.max.y : 1);
          if (h > 1.6) row.tall++;
          row.lat += Math.abs(lat) - p.f.width * 0.5;
          row.drop += v.y - p.f.pos.y;
        }
      });
      /* And how fast the ground actually falls away, because a rank placed by
         corridor fraction is only as good as the fraction it picks. */
      const fall = [];
      for (const u of [0, 0.08, 0.12, 0.16, 0.2, 0.24, 0.28, 0.36, 0.5, 0.76, 1]) {
        const q = field.point(s, side, u, new THREE.Vector3());
        fall.push([u, q.y - p.f.pos.y, (field.profile(s, side).wallDist * u)]);
      }
      return {
        s, side, coastness: p.coastness, wallDist: p.wallDist,
        constrained: p.constrained, rows, fall,
      };
    }, [t, WINDOW]);

    console.log(`\n  t=${t}  s=${out.s.toFixed(0)}  seaSide=${out.side}`
      + `  coastness=${out.coastness.toFixed(2)}  wallDist=${out.wallDist.toFixed(1)}`
      + `  constrained=${out.constrained}`);
    console.log('    fall  ' + out.fall
      .map(([u, dy, m]) => `u${u}:${dy.toFixed(1)}m@${m.toFixed(0)}`).join('  '));
    const names = Object.keys(out.rows).sort((a, b) => out.rows[b].n - out.rows[a].n);
    if (!names.length) console.log('    nothing on the seaward side');
    for (const name of names) {
      const row = out.rows[name];
      console.log(`    ${name.padEnd(26)} ${String(row.n).padStart(4)}`
        + `  ${String(row.tall).padStart(4)} over 1.6 m`
        + `  mean ${(row.lat / row.n).toFixed(1)} m out`
        + `  ${(row.drop / row.n).toFixed(1)} m below kerb`);
    }
  }
});
