/* Headless capture plumbing.
 *
 * Two backends, and which one runs matters on this machine:
 *
 *   gpu (default) — headless Chromium on the real adapter through ANGLE/D3D11.
 *                   A frame costs the 4060 a millisecond and almost no CPU.
 *   cpu (--cpu)    — SwiftShader. Correct everywhere, but a software rasteriser
 *                   takes every thread it can reach. Only when GPU init fails.
 *
 * Either way node and every Chromium child is pinned low — see tools/tame.mjs,
 * which also installs teardown before anything is started.
 */
import { chromium } from 'playwright';
import './tame.mjs';
import { exec } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAsync } from './check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AFFINITY = 0xF00;   // top four of twelve logical cores

const PIN = 'powershell -NoProfile -Command "' +
  "Get-Process chrome-headless-shell,chrome,headless_shell -ErrorAction SilentlyContinue | " +
  `ForEach-Object { try { $_.PriorityClass = 'Idle'; $_.ProcessorAffinity = ${AFFINITY} } catch {} }"`;

function pinChildren() {
  const go = () => exec(PIN, () => {});
  go();
  const t = setInterval(go, 2500);
  t.unref();
  return () => clearInterval(t);
}

const COMMON = [
  '--autoplay-policy=no-user-gesture-required',
  '--disable-dev-shm-usage',
  '--disable-features=CalculateNativeWinOcclusion,site-per-process',
  '--disable-background-timer-throttling',
  '--renderer-process-limit=1',
];

const GPU_ARGS = [
  ...COMMON,
  // Headless Chromium defaults to SwiftShader even with a GPU present; each of
  // these is needed to get it onto the real adapter.
  '--use-angle=d3d11',
  '--enable-gpu-rasterization',
  '--ignore-gpu-blocklist',
  '--enable-zero-copy',
];

const CPU_ARGS = [
  ...COMMON,
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--enable-webgl', '--disable-lcd-text',
  '--js-flags=--single-threaded-gc',
];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png',
};

export function serve(root = ROOT) {
  return http.createServer((rq, rs) => {
    const rel = decodeURI(rq.url.split('?')[0].split('#')[0]);
    const f = path.join(root, rel === '/' ? 'index.html' : rel);
    if (!f.startsWith(root)) { rs.writeHead(403); return rs.end(); }
    fs.readFile(f, (e, d) => {
      if (e) { rs.writeHead(404); return rs.end('not found'); }
      rs.writeHead(200, {
        'content-type': TYPES[path.extname(f)] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      rs.end(d);
    });
  });
}

/**
 * Capture one frame deterministically.
 *
 * page.screenshot() waits on the compositor and races the game loop for the GL
 * context. Pausing, rendering once and reading the canvas back inside a single
 * evaluate is faster and reproducible — and it has to be one evaluate, because
 * the drawing buffer is not preserved and is gone by the next task.
 */
export async function capture(page, file) {
  const url = await page.evaluate(() => {
    const g = window.__game;
    g.setPaused(true);
    g.renderOnce();
    const data = g.renderer.domElement.toDataURL('image/png');
    g.setPaused(false);
    return data;
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  return file;
}

/**
 * Wait out the boot splash. CALL THIS BEFORE ANY page.screenshot().
 *
 * `capture()` above is immune — it reads the GL canvas directly, and the splash
 * is a DOM element that is not in it. But a screen that is a composition of the
 * world AND the 2D overlay (the title screen, the pause menu) can only be
 * photographed with page.screenshot(), which takes what the COMPOSITOR has —
 * and that includes `#boot` in index.html, a full-inset div holding the wordmark
 * over `#1b1015`.
 *
 * It is never removed from the DOM. It is faded by adding `.gone`, which is a
 * `transition: opacity .5s ease`, and the trap is the timing rather than the
 * mechanism. MEASURED, three trials (.fix/tveil.mjs): when `run()` hands the
 * page over, `.gone` is ALREADY SET and the computed opacity is still exactly
 * 1 — the class is applied before the readiness signal but the transition has
 * not begun. It reaches 0 a further 1340, 1365 and 1640 ms later, well past its
 * declared 0.5 s, because the rest of the boot's work is still competing.
 *
 * So a tool that steps and then shoots gets a frame under a mostly opaque veil,
 * with the splash wordmark in the middle of it and every colour in the frame
 * dragged towards `#1b1015`. It does not look like an error; it looks like a
 * night scene, which is why this is worth a function rather than a comment.
 * tools/shell.mjs escaped it only by accident for its first several revisions:
 * its INKBOX and TWICE probes walk millions of pixels between the step loop and
 * the shutter and waited the fade out without meaning to. Reorder those and the
 * shots go dark.
 *
 * Waits on `transitionend` rather than sleeping a magic number, so it costs
 * whatever is left of the fade and no more, and stays correct if the 0.5 s in
 * index.html is ever retuned.
 *
 * @param {any} page
 * @param {number} timeout ms before giving up, so a splash that never
 *   transitions cannot hang a tool.
 * @returns {Promise<number>} ms actually waited.
 */
export async function settleBoot(page, timeout = 5000) {
  return page.evaluate((ms) => {
    const b = document.getElementById('boot');
    if (!b || +getComputedStyle(b).opacity === 0) return 0;
    const t0 = performance.now();
    return new Promise(res => {
      const done = () => res(+(performance.now() - t0).toFixed(0));
      b.addEventListener('transitionend', done, { once: true });
      setTimeout(done, ms);
    });
  }, timeout);
}

/**
 * Boot server + browser + page, run `body`, guarantee teardown.
 * @param {{width?:number,height?:number,hash?:string,cpu?:boolean,timeout?:number,url?:string}} opts
 * @param {(ctx:{page:any,url:string,errs:string[],gl:object}) => Promise<void>} body
 */
export async function run(opts, body) {
  const {
    width = 1600, height = 900, hash = 'manual',
    cpu = process.argv.includes('--cpu'),
    timeout = 120_000,
    url: externalUrl = process.env.REDROCK_URL || null,
    /* Which global says the page is up, and whether to start its loop. A tool
       with its own page (tools/hud.html, tools/gamut.html) has neither
       __game nor a game loop, and waiting for them burns the full timeout. */
    ready = '__game', begin = true,
  } = opts || {};

  const bad = await checkAsync();
  if (bad.length) {
    console.error('✗ parse errors — not launching a browser:\n' + bad.join('\n'));
    process.exitCode = 1;
    return { errs: bad, gl: null };
  }

  let srv = null;
  let url = externalUrl;
  if (!url) {
    srv = serve();
    await new Promise(r => srv.listen(0, r));
    url = `http://localhost:${srv.address().port}/#${hash}`;
  }

  const unpin = pinChildren();
  const browser = await chromium.launch({ headless: true, args: cpu ? CPU_ARGS : GPU_ARGS });

  const errs = [];
  let code = 0, gl = null;
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on('pageerror', e => errs.push('[pageerror] ' + (e.stack || e.message || e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
    page.on('requestfailed', r => errs.push('[netfail] ' + r.url().slice(0, 120)));
    page.on('crash', () => errs.push('[crash] renderer process died'));

    console.log(`→ ${url}  ${width}x${height}  backend=${cpu ? 'swiftshader' : 'gpu'}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    /* A module that throws on load never defines __game, so waiting for it
     * burns the full timeout to report an error the page already knew about.
     * Poll `errs` rather than listening for the next 'pageerror': a module that
     * fails to parse throws during goto(), so a listener attached afterwards
     * has already missed the only event. */
    await Promise.race([
      page.waitForFunction(k => !!window[k], ready, { timeout }),
      (async () => {
        for (let i = 0; i < timeout / 250; i++) {
          await new Promise(r => setTimeout(r, 250));
          const fatal = errs.find(e => e.startsWith('[pageerror]') || e.startsWith('[crash]'));
          if (fatal) throw new Error('page threw during boot: ' + fatal.slice(0, 400));
        }
      })(),
    ]);

    gl = await page.evaluate(() => {
      const c = document.createElement('canvas');
      const g2 = c.getContext('webgl2');
      const dbg = g2.getExtension('WEBGL_debug_renderer_info');
      return {
        renderer: dbg ? g2.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
        vendor: dbg ? g2.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'unknown',
      };
    });
    const soft = /swiftshader|software|llvmpipe/i.test(gl.renderer);
    console.log(`   adapter: ${gl.renderer}${soft ? '  (SOFTWARE — CPU bound)' : ''}`);

    if (begin) await page.evaluate(() => window.__game.begin());
    await body({ page, url, errs, gl });
  } catch (err) {
    console.error('\n✗ probe failed:', (err && err.message) || err);
    code = 1;
  } finally {
    await browser.close().catch(() => {});
    if (srv) srv.close();
    unpin();
  }

  if (errs.length) {
    console.log('\n─── page errors ───');
    [...new Set(errs)].slice(0, 15).forEach(e => console.log(' ', e));
  }

  /* A thrown exception or a dead renderer is a failed run even if the body
     completed. Console noise and failed requests are not — a missing favicon
     should not fail a capture. */
  if (errs.some(e => e.startsWith('[pageerror]') || e.startsWith('[crash]'))) code = 1;

  /* Raise, never lower. Suites report their own verdict through
     process.exitCode, and assigning it unconditionally here discarded that —
     a run could print a red failure and still exit 0, which is the single bug
     a test harness must not have. */
  if (code) process.exitCode = code;
  return { errs: [...new Set(errs)], gl };
}
