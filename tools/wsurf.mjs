/* Is the surface crowdSeen marches over the surface that is actually there?
 *
 * crowdSeen models the ground as `field.point(s, side, u)` — the road
 * corridor, interpolated out to the wall — plus the berm and the guard rail.
 * The landform ribbons are a separate surface with their own station ladder,
 * built by landformPoint, and nothing stops the two interpenetrating. If they
 * do, every sightline gate in the crowd build is reasoning about a ground
 * plane that the frame does not have.
 *
 * So drop a ray straight down from well above the stage onto whatever is
 * really there, and print it beside what the model says, over a lateral sweep
 * at each station asked for. Column `gap` is the model's error in metres:
 * positive means there is mass the model does not know about.
 *
 *   node tools/wsurf.mjs --seed 22 --at 5520,5533,5547 --side 1
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const AT = flag('at', '5533').split(',').map(Number);
const SIDE = Number(flag('side', '1'));
const OUTS = flag('outs', '0,2,4,6,8,10,12,14,16,20,24').split(',').map(Number);

await run({
  width: 640, height: 360,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  const out = await page.evaluate(([at, side, outs]) => {
    const g = window.__game;
    const THREE = g.THREE;
    const t = g.track;
    const env = g.scene.getObjectByName('environment') || g.stage.getObjectByName('environment');
    const probe = env?.userData?.crowdProbe;
    if (!probe) return { none: true };

    const skip = /sky-dome|sun-disc|ocean-bands|shore-foam|block-clouds|bird|beam|foam|crowd/i;
    const targets = [];
    g.stage.updateMatrixWorld(true);
    g.stage.traverse(o => {
      if (!o.isMesh) return;
      let nm = o.name;
      for (let q = o.parent; !nm && q; q = q.parent) nm = q.name;
      if (skip.test(nm || '')) return;
      o.userData.__probeName = nm || '(unnamed)';
      targets.push(o);
    });
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);

    const rows = [];
    for (const s of at) {
      const wall = probe.wallDist(s, side);
      const f = t.frameAt(s);
      const cells = [];
      for (const o of outs) {
        const p = probe.point(s, side, Math.min(o / wall, 1));
        ray.far = 4000;
        ray.set(new THREE.Vector3(p.x, p.y + 300, p.z), down);
        const hits = ray.intersectObjects(targets, false);
        const top = hits[0];
        cells.push({
          out: o,
          model: +p.y.toFixed(2),
          real: top ? +top.point.y.toFixed(2) : null,
          what: top ? top.object.userData.__probeName : '—',
        });
      }
      rows.push({ s, wall: +wall.toFixed(0), edge: +(f.pos.y).toFixed(2), cells });
    }
    return { rows };
  }, [AT, SIDE, OUTS]);

  if (out.none) { console.log('  no crowdProbe'); return; }
  console.log(`\n  seed ${SEED}, side ${SIDE} — model surface vs the mesh that is really there\n`);
  for (const r of out.rows) {
    console.log(`  s=${r.s}   wallDist ${r.wall} m   centreline y ${r.edge}`);
    console.log('      out     model      real       gap   topmost mesh');
    for (const c of r.cells) {
      const gap = c.real === null ? null : +(c.real - c.model).toFixed(2);
      console.log(`    ${String(c.out).padStart(5)} m  ${String(c.model).padStart(8)}`
        + `  ${String(c.real ?? '—').padStart(8)}  ${String(gap ?? '—').padStart(8)}`
        + `   ${c.what}`);
    }
    console.log();
  }
});
finish(process.exitCode || 0);
