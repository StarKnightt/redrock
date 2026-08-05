/* Keep headless runs from taking the machine away from whoever is using it,
   and make sure they always let go afterwards.

   Node and every Chromium child is pinned to the top four of twelve logical
   cores at low priority, re-applied on a timer because Chromium spawns its
   workers late. Importing this module is the whole contract — a new harness
   cannot forget to opt in, and cannot leave a listening socket or a rendering
   browser resident after a throw. */
import { exec } from 'node:child_process';
import http from 'node:http';

const ps = c => exec('powershell -NoProfile -Command "' + c + '"', () => {});
const AFFINITY = '0xF00';          // top four logical cores of twelve

ps(`$p=Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue; ` +
   `if($p){ $p.PriorityClass='BelowNormal'; $p.ProcessorAffinity=${AFFINITY} }`);

const tameChildren = () => ps(
  "Get-Process chrome-headless-shell,headless_shell -ErrorAction SilentlyContinue | ForEach-Object " +
  `{ try { $_.PriorityClass = 'Idle'; $_.ProcessorAffinity = ${AFFINITY} } catch {} }`);
setTimeout(tameChildren, 1500).unref();
setInterval(tameChildren, 4000).unref();

/* A listening socket is a ref'd handle, so a script that throws before its
   close() calls stays resident forever instead of exiting with the error.
   Unref'ing on 'listening' — not immediately, or node can exit before the
   server is ready — removes that failure mode entirely. */
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...a) {
  const r = listen.apply(this, a);
  this.once('listening', () => this.unref());
  return r;
};

const closeables = [];
/** Register a browser or server to be closed however the script ends.
    Register the browser first so Chromium is gone before we stop serving. */
export function guard(...things) {
  for (const t of things) if (t) closeables.push(t);
  return things[0];
}

let closing = false;
async function teardown(code, why) {
  if (closing) return;
  closing = true;
  if (why) console.error('\n[teardown] ' + why);
  for (const t of closeables) { try { await t.close(); } catch (_) {} }
  process.exit(code);
}
/** Normal end of a script. */
export const finish = (code = 0) => teardown(code);

process.on('SIGINT', () => teardown(130, 'interrupted'));
process.on('SIGTERM', () => teardown(143, 'terminated'));
process.on('uncaughtException', e => teardown(1, (e && e.stack) || e));
process.on('unhandledRejection', e => teardown(1, (e && e.stack) || e));
