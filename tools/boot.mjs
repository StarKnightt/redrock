/* Does the stage build without throwing, on every seed?
 *
 * Placement code refuses, walks and retries, and a seed where a builder finds
 * no candidate at all takes a branch no capture ever exercises. This boots the
 * game headless on each seed, fails on any console error or page exception,
 * and reports the landmark schedule so a seed that silently places nothing is
 * as visible as one that crashes.
 *
 *   node tools/boot.mjs [--seeds 22,1,26,...]
 *
 * FAILURE IS THE DEFAULT AND SUCCESS IS EARNED. Read that before editing
 * anything below, because this tool spent a day unable to fail. Two faults
 * compounded, and both were faults of control flow rather than of arithmetic:
 *
 *   1. The failure tally lived inside the success path. A seed whose page threw
 *      during boot never reached `body()` at all — the harness detects the
 *      pageerror while waiting for `__game`, throws, catches its own throw and
 *      returns — so the line that incremented the count was unreachable exactly
 *      when it was needed. Fourteen seeds died and the tally read zero. A gate
 *      that counts failures only where it already succeeded cannot fail.
 *   2. `finish(bad ? 1 : 0)` then threw away the exit code. `run()` sets
 *      `process.exitCode = 1` when a page throws; passing a literal 0 to
 *      `finish()` — which calls `process.exit(code)` — overwrote it. The one
 *      channel that had the truth was the one being discarded.
 *
 * So: every seed is entered into `results` PRE-FAILED with a reason, before
 * any browser starts. Only the bottom of the clean path clears it. Every early
 * exit — harness throw, probe throw, page error, missing probe result — leaves
 * the pre-set reason standing or replaces it with a sharper one. And the exit
 * code is the MAXIMUM of this tool's verdict and whatever the harness already
 * set; it is never assigned downwards.
 *
 * Two guards enforce that the loop actually ran, in the spirit of the constant
 * expected-count guard in tools/check.mjs: an empty seed list is a failure
 * rather than a vacuous pass, and a `visited` counter that does not match the
 * seed count fails the run even if every seed it did reach was clean.
 *
 * NOTE ON READING THE EXIT CODE: `node tools/boot.mjs | tee log.txt` reports
 * tee's status, not this tool's, and will show 0 over a red failure. Redirect
 * instead — `node tools/boot.mjs > log.txt 2>&1 ; echo $?`.
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = String(flag('seeds', '22,1,7,12,14,16,20,23,26,27,28,34,36,40'))
  .split(',').map(s => s.trim()).filter(Boolean);

const oneline = e => String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 110);

/* A gate with nothing to check has not passed. `--seeds ""` used to boot no
   browser, tally no failure and print `all seeds clean`. */
if (!SEEDS.length) {
  console.log('\n  FAIL no seeds given — nothing was booted, so nothing is clean');
  process.exitCode = 1;
  finish(1);
}

/* Pre-failed, one record per seed, indexed by position so a repeated seed on
   the command line still gets its own verdict. `fail` is a string until
   something earns the right to set it null. */
const results = SEEDS.map(seed => ({ seed, fail: 'seed never reported a verdict' }));
let visited = 0;

const row = (seed, body, status) =>
  console.log(`  seed ${String(seed).padStart(3)}  ${body}${status}`);

for (let i = 0; i < SEEDS.length; i++) {
  const seed = SEEDS[i];
  const rec = results[i];
  visited++;

  /* `run()` raises process.exitCode and never lowers it, so compare across the
     call to attribute a harness-level failure to this seed. Once it is up it
     stays up; later seeds are judged on their own errors, and the final exit
     code takes the harness's word into account regardless. */
  const exitBefore = process.exitCode || 0;
  let probe = null;
  let out = null;

  try {
    out = await run({
      width: 320, height: 200,
      hash: `manual&tier=high&seed=${seed}&cap=60&hud=0`,
    }, async ({ page }) => {
      /* A probe that throws is NOT caught here. It propagates into the
         harness, which prints it, sets the exit code and returns — and leaves
         `probe` null, which is a failure by default below. Catching it here is
         what let a broken probe report a clean seed. */
      probe = await page.evaluate(() => {
        const g = window.__game;
        g.setPaused(true);
        g.driveTo(0.5);
        g.renderOnce();
        let schedule = null;
        g.scene.traverse(o => { if (o.userData && o.userData.schedule) schedule = o.userData.schedule; });
        const counts = {};
        for (const e of schedule || []) counts[e.kind] = (counts[e.kind] || 0) + 1;
        let gap = 0;
        const sorted = (schedule || []).slice().sort((a, b) => a.t - b.t);
        for (let i = 1; i < sorted.length; i++) gap = Math.max(gap, sorted[i].t - sorted[i - 1].t);
        /* NOT renderer.info. The cel pipeline is several render() calls and
           `info` is reset at the top of each of them, so whatever it holds when
           the frame ends describes the composite's fullscreen quad — one
           triangle, one call, on every seed, which is what this column printed
           for as long as it existed.

           pipeline.stats is snapshotted inside the pipeline immediately after
           the beauty pass and before the composite, so it is the stage's own
           cost. Holding info.autoReset off and accumulating instead would give
           the sum over the prepass, the opt-in prepass, the beauty pass and the
           quad — three times the scene, which is the figure tools/tperf.mjs
           reports and which has already been misread once as a budget breach. */
        const span = g.field && g.field.tunnel;
        const stats = g.pipeline.stats;
        return {
          tris: stats.triangles,
          calls: stats.calls,
          n: (schedule || []).length,
          gap: +gap.toFixed(1),
          counts,
          tunnel: span
            ? `${span.s0.toFixed(0)}+${(span.s1 - span.s0).toFixed(0)}m w${span.wall.toFixed(0)}`
            : 'NONE',
        };
      });
    });
  } catch (e) {
    /* `run()` swallows body throws, so reaching here means the plumbing itself
       came apart — a launch failure, a closed browser. Still a failed seed. */
    rec.fail = 'harness threw: ' + oneline(e);
    row(seed, '', `FAIL ${rec.fail}`);
    continue;
  }

  /* Judge on the harness's finished list, not on a snapshot taken part-way
     through the body: a page error raised by the probe's own renderOnce()
     lands in `errs` after the body has read it. `[netfail]` is not a failed
     seed — a missing favicon should not fail a boot. */
  const errs = ((out && out.errs) || []).filter(e => /^\[(pageerror|console|crash)\]/.test(e));
  const raised = (process.exitCode || 0) > exitBefore;

  if (!out) {
    rec.fail = 'harness returned nothing';
  } else if (errs.length) {
    rec.fail = errs[0].replace(/\s+/g, ' ').slice(0, 110);
  } else if (!probe) {
    rec.fail = raised
      ? 'probe never returned (harness raised the exit code)'
      : 'probe never returned';
  } else if (probe.tunnel === 'NONE') {
    rec.fail = 'no tunnel site found';
  } else if (raised) {
    rec.fail = 'harness raised the exit code without naming an error';
  } else {
    rec.fail = null;                     // the only place success is granted
  }

  const kinds = probe
    ? Object.entries(probe.counts)
      .filter(([k]) => /lighthouse|turbine|bridge|tyres|hay|flowers/.test(k))
      .map(([k, v]) => `${k[0]}${v}`).join(' ')
    : '';
  const body = probe
    ? `${String(probe.tris).padStart(7)} tri  ${String(probe.calls).padStart(4)} calls`
      + `  ${String(probe.n).padStart(3)} events  gap ${String(probe.gap).padStart(4)}s`
      + `  ${kinds.padEnd(26)} bore ${probe.tunnel.padEnd(16)} `
    : '';
  row(seed, body, rec.fail ? `FAIL ${rec.fail}` : 'ok');
}

const failed = results.filter(r => r.fail);

/* The count guard. If the loop was cut short, the seeds it never reached are
   still pre-failed above, but say so plainly rather than letting a short run
   look like a complete one. */
if (visited !== SEEDS.length) {
  console.log(`\n  FAIL booted ${visited} of ${SEEDS.length} seeds — the run was cut short`);
}

if (failed.length) {
  console.log(`\n  ${failed.length} of ${SEEDS.length} seed(s) FAILED: `
    + failed.map(r => r.seed).join(', '));
  for (const r of failed) console.log(`    seed ${String(r.seed).padStart(3)}  ${r.fail}`);
} else {
  console.log(`\n  all ${SEEDS.length} seeds clean`);
}

/* Raise, never lower. `process.exitCode` may already be 1 from the harness for
   a reason this tool did not classify; passing a bare 0 to finish() would
   discard it, which is the second half of the bug this file documents. */
const code = (failed.length || visited !== SEEDS.length) ? 1 : (process.exitCode || 0);
process.exitCode = code;
finish(code);
