/* Is Track.project continuous?
 *
 * Car.step derives everything from it: the frame, the surface height under the
 * car, and therefore whether the car is touching the ground at all. It is
 * called twice per substep, 240 times a second, and its result is differenced
 * implicitly — the car is placed on the surface at (s, lat) and the next
 * substep measures its height against the surface at whatever (s, lat) comes
 * back next. So an error in project() does not read as a wrong position, it
 * reads as the ground moving.
 *
 * Every call made during a drive is recorded here and re-solved by brute force
 * at 5 mm along the whole stage. The difference between the two is the error
 * the car is actually being driven with.
 *
 *   node tools/proj.mjs [--seed 22] [--secs 60]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', 22);
const SECS = +flag('secs', 60);

await run({
  width: 640, height: 360,
  hash: `manual&tier=low&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  const out = await page.evaluate(([secs]) => {
    const g = window.__game;
    const p = g.player;
    const track = g.track;
    const L = track.length;
    const V = g.THREE.Vector3;

    const rawProject = track.project.bind(track);
    const calls = [];
    let capture = false;
    track.project = function (pos, hint) {
      const r = rawProject(pos, hint);
      if (capture) calls.push({ x: pos.x, y: pos.y, z: pos.z, hint, s: r.s, lat: r.lat, dist: r.dist });
      return r;
    };

    /* Brute force, at 5 mm, over a wide window. Slow on purpose. */
    const probe = new V();
    const truth = (c) => {
      probe.set(c.x, c.y, c.z);
      const lo = Math.max(0, c.s - 12), hi = Math.min(L, c.s + 12);
      let best = c.s, bestD = Infinity;
      for (let s = lo; s <= hi; s += 0.005) {
        const d = track.frameAt(s).pos.distanceToSquared(probe);
        if (d < bestD) { bestD = d; best = s; }
      }
      const f = track.frameAt(best);
      const e = new V().subVectors(probe, f.pos);
      return { s: best, lat: e.dot(f.right), dist: Math.sqrt(bestD) };
    };

    /* Drive with a keyboard on the bot's line, same as tools/buzz.mjs. */
    g.setPaused(true);
    g.autopilot(true, 1.0);
    g.goTo(0.0015);
    const bot = g.bot;
    capture = true;
    for (let i = 0; i < 60 * secs && !p.finished; i++) {
      const c = bot.drive(p, 1 / 60);
      g.botInput = {
        steer: c.steer > 0.15 ? 1 : c.steer < -0.15 ? -1 : 0,
        throttle: c.throttle > 0.3 ? 1 : 0,
        brake: c.brake > 0.25 ? 1 : 0,
        handbrake: c.handbrake,
      };
      g.step(1 / 60);
      if (p.strandedFor > 4) p.recover();
    }
    capture = false;
    g.botInput = null;
    g.autopilot(false);
    track.project = rawProject;

    /* Compare a sample of the calls — brute force is expensive. */
    const stride = Math.max(1, Math.floor(calls.length / 6000));
    const errs = [];
    for (let i = 0; i < calls.length; i += stride) {
      const c = calls[i];
      const t = truth(c);
      errs.push({
        s: +c.s.toFixed(2), ds: +(c.s - t.s).toFixed(4),
        dlat: +(c.lat - t.lat).toFixed(4),
        ddist: +(c.dist - t.dist).toFixed(4),
        hint: +(+c.hint).toFixed(1), lat: +c.lat.toFixed(2),
        curv: +track.frameAt(c.s).curv.toFixed(5),
      });
    }

    /* Separately: how far does the fast path move for a tiny move of the
       input? A continuous projection changes smoothly; a quantised one
       staircases. Walk a point along the road and difference the result. */
    const walk = [];
    {
      const f0 = track.frameAt(400);
      const q = new V();
      let prev = null;
      for (let d = 0; d < 6; d += 0.01) {
        const f = track.frameAt(400 + d);
        q.copy(f.pos).addScaledVector(f.right, -3.1).addScaledVector(f.up, 0.1);
        const r = rawProject(q, 400 + d);
        if (prev) walk.push({ d: +d.toFixed(2), dS: +(r.s - prev.s).toFixed(4), dLat: +(r.lat - prev.lat).toFixed(4), lat: +r.lat.toFixed(4) });
        prev = r;
      }
    }

    const absMax = (a, k) => Math.max(...a.map(x => Math.abs(x[k])));
    return {
      seed: track.seed, nCalls: calls.length, nChecked: errs.length,
      maxDs: +absMax(errs, 'ds').toFixed(3),
      maxDlat: +absMax(errs, 'dlat').toFixed(3),
      maxDdist: +absMax(errs, 'ddist').toFixed(3),
      worst: errs.slice().sort((a, b) => Math.abs(b.dlat) - Math.abs(a.dlat)).slice(0, 15),
      worstS: errs.slice().sort((a, b) => Math.abs(b.ds) - Math.abs(a.ds)).slice(0, 10),
      walkMaxDlat: +Math.max(...walk.map(w => Math.abs(w.dLat))).toFixed(4),
      walkMaxDs: +Math.max(...walk.map(w => Math.abs(w.dS))).toFixed(4),
      walk: walk.filter(w => Math.abs(w.dLat) > 0.004).slice(0, 20),
    };
  }, [SECS]);

  console.log(`\n  seed ${out.seed}: ${out.nCalls} project() calls, ${out.nChecked} re-solved by brute force`);
  console.log(`  worst error vs truth —  s ${out.maxDs} m   lat ${out.maxDlat} m   dist ${out.maxDdist} m`);
  console.log('\n  worst lat errors');
  console.log('       s     lat     Δs      Δlat    Δdist    curv');
  for (const e of out.worst) {
    console.log(`  ${String(e.s).padStart(7)} ${e.lat.toFixed(2).padStart(7)} ${e.ds.toFixed(4).padStart(8)} ${e.dlat.toFixed(4).padStart(8)} ${e.ddist.toFixed(4).padStart(8)}  ${e.curv}`);
  }
  console.log('\n  worst s errors');
  for (const e of out.worstS) {
    console.log(`  ${String(e.s).padStart(7)} ${e.lat.toFixed(2).padStart(7)} ${e.ds.toFixed(4).padStart(8)} ${e.dlat.toFixed(4).padStart(8)} ${e.ddist.toFixed(4).padStart(8)}  ${e.curv}`);
  }
  console.log(`\n  walking a point 6 m along the road at 1 cm steps:`);
  console.log(`    biggest single-step jump in returned s   ${out.walkMaxDs} m  (1 cm expected)`);
  console.log(`    biggest single-step jump in returned lat ${out.walkMaxDlat} m  (0 expected)`);
  if (out.walk.length) {
    console.log('    jumps over 4 mm:');
    out.walk.forEach(w => console.log(`      at +${w.d} m:  Δs ${w.dS}   Δlat ${w.dLat}   lat ${w.lat}`));
  }
  fs.mkdirSync(path.join(ROOT, 'shots', 'turns'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'shots', 'turns', 'proj.json'), JSON.stringify(out, null, 1));
});

finish(process.exitCode || 0);
