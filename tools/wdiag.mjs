/* Where the crowd schedule stands, and what is in front of the finish group.
 *
 * Two questions the existing probes leave open.
 *
 * One: the pacing pass in crowdSites reasons in modelled seconds off
 * crowdClock, and zzcadence reports measured seconds off the frame. When the
 * two disagree the schedule can believe it has closed a hole it has not. So
 * print the model's own view — site stations, their modelled times, the gaps
 * it thinks it left, and the placement log — next to the modelled lap, which
 * can be held against zzcadence's measured one.
 *
 * Two: zzseen says the finish group is behind `landform-1` and says nothing
 * about where. crowdSeen marches its sightline in the ROAD's coordinates, so
 * anything outside the road corridor is invisible to it by construction; if
 * the blocker is out there, no amount of tuning that function reaches it.
 * This reports the hit point of every blocked ray in track coordinates —
 * station, lateral offset, height — so the answer is a place and not a name.
 *
 *   node tools/wdiag.mjs [--seed 22] [--site finish]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const ONLY = flag('site', 'finish');
const BACKS = flag('backs', '80,55,35,22,12').split(',').map(Number);

await run({
  width: 640, height: 360,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(600_000);
  const out = await page.evaluate(([backs, only]) => {
    const g = window.__game;
    const THREE = g.THREE;
    const t = g.track;
    const crowd = g.crowd;
    const env = g.scene.getObjectByName('environment') || g.stage.getObjectByName('environment');
    const probe = env?.userData?.crowdProbe;
    if (!crowd || !probe) return { none: true };

    const clock = probe.clock;
    const sites = crowd.sites.map(p => ({
      kind: p.kind, s: +p.s.toFixed(0), side: p.side, t: +clock(p.s).toFixed(1),
      n: (p.groups || []).reduce((a, q) => a + q.n, 0),
    }));
    const marks = [
      { what: 'start squad', s: probe.startS, t: +clock(probe.startS).toFixed(1) },
      ...sites.map(p => ({ what: p.kind, s: p.s, t: p.t })),
      { what: 'the line', s: +t.length.toFixed(0), t: +clock.lap.toFixed(1) },
    ];
    const gaps = [];
    for (let i = 1; i < marks.length; i++) {
      gaps.push({
        dt: +(marks[i].t - marks[i - 1].t).toFixed(1),
        from: marks[i - 1].what, to: marks[i].what,
        s0: marks[i - 1].s, s1: marks[i].s,
      });
    }
    gaps.sort((a, b) => b.dt - a.dt);

    // ── what is in front of the finish group ────────────────────────────
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
    const dir = new THREE.Vector3();

    const mesh = g.scene.getObjectByName('crowd-figures');
    const place = mesh.geometry.getAttribute('aPlace');

    g.autopilot(true, 0.85);
    const rows = [];
    for (const site of crowd.sites) {
      if (only && !site.kind.includes(only)) continue;
      let closest = Infinity, atS = site.s;
      for (let s = Math.max(0, site.s - 250); s <= Math.min(t.length, site.s + 250); s += 2) {
        const f = t.frameAt(s);
        const d = Math.hypot(site.at.x - f.pos.x, site.at.z - f.pos.z);
        if (d < closest) { closest = d; atS = s; }
      }
      const mine = [];
      for (let i = 0; i < place.count; i++) {
        const ox = place.getX(i), oy = place.getY(i), oz = place.getZ(i);
        if (Math.hypot(ox - site.at.x, oz - site.at.z) > 26) continue;
        mine.push({ x: ox, y: oy, z: oz, h: place.getW(i) });
      }
      const stations = [];
      for (const back of backs) {
        g.setPaused(true);
        g.goTo(Math.max(0, atS - back - 55) / t.length);
        g.warp(0.75);
        const stop = Math.max(1, atS - back);
        for (let k = 0; k < 260 && g.player.s < stop; k++) g.step(1 / 60);
        const eye = g.camera.position.clone();
        const lens = t.project(eye);
        const hits = [];
        for (const m of mine) {
          const target = new THREE.Vector3(m.x, m.y + m.h * 0.55, m.z);
          dir.copy(target).sub(eye);
          const len = dir.length();
          ray.far = len - 0.35;
          ray.set(eye, dir.clone().normalize());
          const hit = ray.intersectObjects(targets, false)[0];
          if (!hit) { hits.push(null); continue; }
          const pr = t.project(hit.point);
          hits.push({
            what: hit.object.userData.__probeName,
            frac: +(hit.distance / len).toFixed(2),
            s: +pr.s.toFixed(0), lat: +pr.lat.toFixed(1), h: +pr.height.toFixed(1),
            y: +hit.point.y.toFixed(1),
          });
        }
        const tgt = t.project(new THREE.Vector3(mine[0].x, mine[0].y, mine[0].z));
        stations.push({
          back, playerS: +g.player.s.toFixed(0),
          lensS: +lens.s.toFixed(0), lensLat: +lens.lat.toFixed(1), lensH: +lens.height.toFixed(1),
          groupS: +tgt.s.toFixed(0), groupLat: +tgt.lat.toFixed(1), groupH: +tgt.height.toFixed(1),
          hits,
        });
      }
      rows.push({ kind: site.kind, s: Math.round(site.s), atS: Math.round(atS), n: mine.length, stations });
    }
    g.autopilot(false);
    return {
      L: +t.length.toFixed(0), modelLap: +clock.lap.toFixed(1),
      sites, gaps, plan: probe.plan(), rows,
    };
  }, [BACKS, ONLY]);

  if (out.none) { console.log('  no crowd / no crowdProbe'); return; }
  console.log(`\n══ seed ${SEED}   ${out.L} m,  modelled lap ${out.modelLap} s\n`);
  console.log('  SITES, in the schedule\'s own clock');
  for (const p of out.sites) {
    console.log(`    ${p.kind.padEnd(14)} s=${String(p.s).padStart(5)}  t=${String(p.t).padStart(6)} s`
      + `  side ${String(p.side).padStart(2)}  ${p.n} figures`);
  }
  console.log('\n  GAPS the model believes it left, worst first');
  for (const gp of out.gaps.slice(0, 6)) {
    console.log(`    ${String(gp.dt).padStart(6)} s   ${gp.from} (s=${gp.s0}) → ${gp.to} (s=${gp.s1})`);
  }
  console.log('\n  PLACEMENT LOG');
  for (const line of out.plan) console.log('    ' + line);

  for (const r of out.rows) {
    console.log(`\n  ${r.kind} s=${r.s}, ${r.n} figures — what the ray hits, in track coordinates`);
    for (const st of r.stations) {
      const clear = st.hits.filter(h => !h).length;
      console.log(`    ${String(st.back).padStart(3)} m back:  lens s=${st.lensS} lat=${st.lensLat} h=${st.lensH}`
        + `   group s=${st.groupS} lat=${st.groupLat} h=${st.groupH}   clear ${clear}/${st.hits.length}`);
      const seen = new Set();
      for (const h of st.hits) {
        if (!h) continue;
        const key = `${h.what}|${h.s}|${h.lat}`;
        if (seen.has(key)) continue;
        seen.add(key);
        console.log(`         blocked by ${h.what} at ${(100 * h.frac).toFixed(0)}% of the way,`
          + ` s=${h.s} lat=${h.lat} (${h.h} m over the road, y=${h.y})`);
      }
    }
  }
  console.log();
});
finish(process.exitCode || 0);
