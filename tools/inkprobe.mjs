/* Diagnostic: what does the ink pass actually see where the dust is, and how
 * coarse is a shadow-map texel once it reaches the screen?
 *
 * PREPASS. Renders a frame at a stop, then re-renders the same frame showing
 * the prepass distance buffer (the alpha channel of CelPipeline.normals) as
 * greyscale. If the plume is present in the beauty frame but absent from the
 * distance frame, the ink pass is drawing edges from geometry it believes is
 * unoccluded.
 *
 *   That comparison is only worth anything if the two pictures are the same
 *   frame, and until now they were not. The probe sampled pipe.normals in one
 *   evaluate, took the beauty shot in another, and visualised the buffer in a
 *   third, with the game LOOP RUNNING and a 140 ms and a 200 ms wait in
 *   between. By the time the distance frame was captured the car had driven
 *   several car-lengths and the camera had gone with it — the two PNGs in
 *   shots/ink-probe were of different corners of the stage. Worse, the
 *   per-particle distance samples were read out of a render target left over
 *   from some earlier frame and compared against particle positions read
 *   NOW, so "matched 15 of 40" was a comparison between two different
 *   moments and meant nothing either way. Everything now happens in one
 *   evaluate, on a paused game, against a render this tool has just made,
 *   with performance.now() pinned across the lot.
 *
 * SHADOW. src/main.js sizes the shadow map on a measurement it credits to
 * "tools/inkprobe.mjs, shadow section" — one map texel landing about fourteen
 * screen pixels across at 2048. There was no shadow section in this file, so
 * that figure has been uncheckable for as long as the comment has existed.
 * This is it, rebuilt: the sun's own shadow camera and the game's own render
 * camera are asked, by construction, how far apart two points one texel apart
 * on the road are on screen. It reads the live objects rather than repeating
 * the arithmetic in the comment, so it can disagree with it.
 *
 * Also traces spawn counts over a couple of seconds of driving, which is how
 * a stalled emission timer shows itself: a rate that reads high in the stats
 * while the cursor never moves.
 *
 *   node tools/inkprobe.mjs [--t 0.44]
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const T = +flag('t', 0.44);

const outDir = path.join(ROOT, 'shots', 'ink-probe');
fs.mkdirSync(outDir, { recursive: true });
const save = (f, url) => fs.writeFileSync(path.join(outDir, f), Buffer.from(url.split(',')[1], 'base64'));

await run({ width: 1600, height: 900, hash: 'manual&tier=high&seed=22&cap=60&ink=1' },
  async ({ page }) => {
    const out = await page.evaluate(t => {
      const g = window.__game;
      const THREE = g.THREE;
      const pipe = g.pipeline;
      const p = g.effects.particles;
      const cam = g.camera;
      const cv = g.renderer.domElement, W = cv.width, H = cv.height;

      /* ── drive in, then freeze. Nothing below may advance the game. ──── */
      g.setPaused(true);
      g.driveTo(t);
      const trace = { afterDrive: p.cursor, live0: p.live, samples: [] };
      g.autopilot(true, 0.85);
      for (let k = 0; k < 6; k++) {
        for (let i = 0; i < 20; i++) g.step(1 / 60);
        trace.samples.push({ cursor: p.cursor, live: p.live, kmh: +g.telemetry().kmh.toFixed(0) });
      }
      g.autopilot(false);

      const real = performance.now.bind(performance);
      const tPin = real(); performance.now = () => tPin;
      /* Frame 0 after a long driveTo carries an artifact. Throw the first
         render away before anything is read off one. */
      g.renderOnce();

      /* ── the beauty frame, and THEN the buffer it was drawn with ─────── */
      g.renderOnce();
      const beauty = cv.toDataURL('image/png');

      /* ── prepass distance under each live particle, same frame ───────── */
      const v = new THREE.Vector3();
      const samples = [];
      let inside = 0, dustDist = 0;
      for (let i = 0; i < p.max; i++) {
        if (!p.active[i]) continue;
        v.set(p.centers[i * 3], p.centers[i * 3 + 1], p.centers[i * 3 + 2]);
        const world = v.clone();
        v.project(cam);
        if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1 || v.z > 1) continue;
        const view = world.applyMatrix4(cam.matrixWorldInverse);
        inside++;
        dustDist += -view.z;
        samples.push({ x: (v.x * 0.5 + 0.5), y: (v.y * 0.5 + 0.5), d: -view.z });
      }
      let prepass = { inside, live: p.live, spawned: p.cursor, visible: p.mesh.visible };
      if (inside) {
        dustDist /= inside;
        const buf = new Float32Array(4);
        const r = g.renderer;
        const nw = pipe.normals.width, nh = pipe.normals.height;
        let matched = 0, behind = 0;
        const deltas = [];
        for (const s of samples.slice(0, 40)) {
          const px = Math.round(s.x * (nw - 1));
          const py = Math.round(s.y * (nh - 1));
          r.readRenderTargetPixels(pipe.normals, px, py, 1, 1, buf);
          const seen = buf[3];
          deltas.push(+(seen - s.d).toFixed(2));
          if (Math.abs(seen - s.d) < 0.6) matched++; else if (seen > s.d) behind++;
        }
        prepass = {
          inside, dustDist: +dustDist.toFixed(1), matched, behind,
          sampled: deltas.length, deltas: deltas.slice(0, 14),
          billowsInPrepass: p.mesh.userData.fxOverrideSkips,
        };
      }

      /* ── how big is one shadow-map texel on screen ───────────────────────
         Ground truth from the two cameras that exist, not from the arithmetic
         in main.js's comment. Take the road point under the car and its
         normal. Step one texel along each of the shadow camera's own screen
         axes, slide the stepped point back down the LIGHT direction until it
         is on the road plane again — which is where the shadow actually
         lands — and measure the two endpoints in screen pixels through the
         render camera. */
      let shadow = null;
      let sun = null;
      g.scene.traverse(o => { if (o.isDirectionalLight && o.castShadow && !sun) sun = o; });
      if (sun && sun.shadow && sun.shadow.camera) {
        const sc = sun.shadow.camera;
        sc.updateMatrixWorld();
        cam.updateMatrixWorld();
        const car = g.player;
        const f = g.track.frameAt(car.s);
        const ground = f.pos.clone();
        const n = f.up.clone().normalize();
        /* Light direction: from the light towards its target. */
        const lightPos = new THREE.Vector3().setFromMatrixPosition(sun.matrixWorld);
        const targetPos = new THREE.Vector3().setFromMatrixPosition(sun.target.matrixWorld);
        const dz = targetPos.clone().sub(lightPos).normalize();
        const elevation = Math.asin(Math.max(-1, Math.min(1, -dz.y)));
        const sx = new THREE.Vector3(1, 0, 0).transformDirection(sc.matrixWorld);
        const sy = new THREE.Vector3(0, 1, 0).transformDirection(sc.matrixWorld);
        const texW = (sc.right - sc.left) / sun.shadow.mapSize.width;
        const texH = (sc.top - sc.bottom) / sun.shadow.mapSize.height;

        const onScreen = (w) => {
          const q = w.clone().project(cam);
          return { x: (q.x * 0.5 + 0.5) * W, y: (-q.y * 0.5 + 0.5) * H };
        };
        /* Slide `step` back onto the plane along the light ray. */
        const land = (step) => {
          const q = ground.clone().add(step);
          const denom = dz.dot(n);
          if (Math.abs(denom) < 1e-6) return null;
          const k = -(q.clone().sub(ground).dot(n)) / denom;
          return q.addScaledVector(dz, k);
        };
        const a = land(sx.clone().multiplyScalar(texW));
        const b = land(sy.clone().multiplyScalar(texH));
        const o0 = onScreen(ground);
        const groundDist = ground.clone().sub(
          new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld)).length();
        shadow = {
          mapSize: sun.shadow.mapSize.width,
          spanM: +(sc.right - sc.left).toFixed(1),
          texelM: +texW.toFixed(4),
          elevationDeg: +(elevation * 180 / Math.PI).toFixed(1),
          groundTexelM: a && b
            ? [+a.clone().sub(ground).length().toFixed(3), +b.clone().sub(ground).length().toFixed(3)]
            : null,
          screenPx: a && b
            ? [+Math.hypot(onScreen(a).x - o0.x, onScreen(a).y - o0.y).toFixed(1),
              +Math.hypot(onScreen(b).x - o0.x, onScreen(b).y - o0.y).toFixed(1)]
            : null,
          lensM: +groundDist.toFixed(1),
          frame: [W, H],
        };
      }

      /* ── the distance buffer, drawn, from the SAME frame ─────────────── */
      const mat = new THREE.ShaderMaterial({
        uniforms: { tNormal: { value: pipe.normals.texture } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }',
        fragmentShader: `precision highp float; varying vec2 vUv; uniform sampler2D tNormal;
          void main(){ float d = texture2D(tNormal, vUv).a;
            float v = d <= 0.0 ? 1.0 : clamp(1.0 - d / 90.0, 0.0, 1.0);
            gl_FragColor = vec4(vec3(v), 1.0); }`,
        depthTest: false, depthWrite: false,
      });
      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
      const oc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      /* pipe.render() first so `normals` holds THIS frame, then the quad over
         the top of it — one render call after the other, no game step and no
         wait in between, which is the whole point. */
      pipe.render();
      g.renderer.setRenderTarget(null);
      g.renderer.render(scene, oc);
      const distance = cv.toDataURL('image/png');
      mat.dispose();

      performance.now = real;
      return { trace, prepass, shadow, beauty, distance };
    }, T);

    save('beauty.png', out.beauty);
    save('prepass-distance.png', out.distance);
    console.log('  trace:', JSON.stringify(out.trace));
    console.log('  prepass probe:', JSON.stringify(out.prepass));
    const s = out.shadow;
    if (!s) console.log('  shadow: no shadow-casting directional light in the scene');
    else {
      console.log(`\n  shadow map ${s.mapSize} over a ${s.spanM} m frustum`
        + ` — ${(s.texelM * 100).toFixed(1)} cm per texel in the map`);
      console.log(`  sun elevation ${s.elevationDeg}°, so on the road a texel covers`
        + ` ${s.groundTexelM[0]} x ${s.groundTexelM[1]} m`);
      console.log(`  at ${s.lensM} m from the lens, in a ${s.frame[0]}x${s.frame[1]} frame,`
        + ` that is ${s.screenPx[0]} x ${s.screenPx[1]} SCREEN PIXELS per texel`);
      console.log('  (src/main.js sizes the shadow map on this number; it cites ~14 px at 2048)');
    }
    console.log('\n  → shots/ink-probe   both PNGs are the same frame');
  });

finish(process.exitCode || 0);
