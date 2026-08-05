/* Static server for manual play. ES modules and importmaps need a real HTTP
   origin; file:// gives Chrome an opaque one and refuses the loads.
   node tools/serve.mjs [port]                                              */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.argv[2] || 8123);

const srv = serve(ROOT);
/* harness.serve unrefs the socket so a capture run can exit on its own; a
   foreground server has to hold the loop open itself. The re-ref has to happen
   inside the listen callback — the unref is hung off the 'listening' event,
   which fires after listen() returns, so ref()ing here immediately was undone
   a tick later and the server exited the moment it started. */
srv.listen(PORT, () => {
  // setImmediate, not a direct call: the unref is another 'listening' listener
  // and it is registered after this one, so re-ref'ing inline is undone again.
  setImmediate(() => srv.ref());
  console.log(`redrock → http://localhost:${PORT}/`);
});
process.on('SIGINT', () => { srv.close(); process.exit(130); });
