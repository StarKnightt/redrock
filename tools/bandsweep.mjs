/* Try rubber-band settings against the churn metrics.
 *
 * The constants are module scope in race/index.js, which is where they belong
 * — they are not runtime settings and exposing them as such would be worse
 * code for the sake of a tuning session. So this edits the file, runs
 * tools/churn.mjs, and puts the file back, once per variant.
 *
 * THIS TOOL MODIFIES A SOURCE FILE WHILE IT RUNS. That was previously undone
 * by a `finally` alone, which covers a thrown exception and nothing else: a
 * Ctrl-C, a SIGTERM or a killed terminal left src/race/index.js sitting on
 * disk with a tuning variant in it, and two agents on this project were
 * killed mid-run in a single day. Three things now stand behind the
 * `finally`:
 *
 *   - a handler on every signal node can catch, and on uncaughtException and
 *     on 'exit', all funnelling into one idempotent restore;
 *   - the pristine copy is written to shots/race/bandsweep.bak BEFORE the
 *     first edit and removed only after a clean restore, so its mere
 *     existence at startup is proof that a previous run died. The next run
 *     puts the file back before doing anything else. That covers SIGKILL and
 *     a power cut, which no handler can;
 *   - every restore checks what is actually on disk first. Other agents edit
 *     this file. If the content is neither pristine nor one of this tool's
 *     own variants, somebody else wrote it while the sweep was running, and
 *     stamping the pristine copy over their work would destroy it — so the
 *     restore refuses, keeps its copy, and says so loudly.
 *
 *   node tools/bandsweep.mjs [--seeds 1,4,9,17,19,20,24,32]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'race', 'index.js');
const BAK = path.join(ROOT, 'shots', 'race', 'bandsweep.bak');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '1,4,9,17,19,20,24,32');

/* Recover from a previous run that was killed. FIRST, before a line of the
   source is read for anything else: the whole point is that what is on disk
   right now may be a half-finished variant, and a baseline read off that is
   a baseline read off the last run's rubbish. If the backup is still there,
   the last run never reached its restore. */
fs.mkdirSync(path.dirname(BAK), { recursive: true });
if (fs.existsSync(BAK)) {
  const saved = fs.readFileSync(BAK, 'utf8');
  const onDisk = fs.readFileSync(SRC, 'utf8');
  if (onDisk === saved) {
    console.log('  a previous run left its backup behind but the source is already clean');
  } else {
    fs.writeFileSync(SRC, saved);
    console.log(`  ⚠ a previous run of this tool died without restoring ${path.relative(ROOT, SRC)}`
      + `\n    — put back from ${path.relative(ROOT, BAK)} before starting`);
  }
  fs.rmSync(BAK, { force: true });
}

/* Each variant is a list of [regex, replacement] applied to the pristine
   source. Keep the regexes anchored on the constant NAME rather than on its
   current value: they were written against `hold: 0.11,` and `hold` has since
   landed at 0.34, so every one of them stopped matching and the whole sweep
   died on its first variant. Failing loudly there was right — testing the
   baseline six times and calling it six variants would have been far worse —
   but a tuning tool that cannot be run because the thing it tunes was tuned
   is not much of a tool. `at` reads whatever the constant currently holds and
   builds the pattern from that, so the sweep still refuses if the constant
   disappears and no longer cares what it is set to. */
const src0 = fs.readFileSync(SRC, 'utf8');
/* `dead` is the reason this insists on a unique match rather than taking the
   first one: race/index.js has two constants called `dead`, one in seconds
   and one in metres, and a first-match rule would have quietly retuned the
   wrong one and reported the result as a pack-cohesion experiment. */
const at = (name) => {
  const all = [...src0.matchAll(new RegExp(`\\b${name}:\\s*([-\\d.]+),`, 'g'))];
  if (!all.length) throw new Error(`bandsweep: no constant "${name}" in src/race/index.js`);
  if (all.length > 1) {
    throw new Error(`bandsweep: "${name}" appears ${all.length} times in src/race/index.js`
      + ` (${all.map(m => m[1]).join(', ')}) — anchor the variant by hand`);
  }
  return [new RegExp(`\\b${name}:\\s*${all[0][1].replace('.', '\\.')},`), all[0][1]];
};
const [HOLD, hold0] = at('hold');
console.log(`  baseline: hold ${hold0}`);
const VARIANTS = [
  ['hold .22', [[HOLD, 'hold: 0.22,']]],
  ['hold .28', [[HOLD, 'hold: 0.28,']]],
  ['hold .34', [[HOLD, 'hold: 0.34,']]],
  ['hold .28 dead 15', [[HOLD, 'hold: 0.28,'], [/dead: 25,/, 'dead: 15,']]],
  ['hold .28 + band drop .14', [[HOLD, 'hold: 0.28,'],
    [/drop: 0\.10,/, 'drop: 0.14,']]],
  ['hold .28 + pace flat .985', [[HOLD, 'hold: 0.28,'],
    [/const PACE = \[[^\]]*\];/, 'const PACE = [0.99, 0.985, 0.98];']]],
];

const pristine = src0;
fs.writeFileSync(BAK, pristine);

/* Every text this tool is willing to overwrite: the pristine source and the
   variants it generates from it. Anything else on disk is somebody else's. */
const mine = new Set([pristine]);
let restored = false;

function restore(why) {
  if (restored) return;
  restored = true;
  try {
    const onDisk = fs.existsSync(SRC) ? fs.readFileSync(SRC, 'utf8') : '';
    if (onDisk === pristine) { fs.rmSync(BAK, { force: true }); return; }
    if (!mine.has(onDisk)) {
      console.error(`\n  ✗ ${path.relative(ROOT, SRC)} was changed by something other than this`
        + `\n    tool while the sweep was running. NOT overwriting it.`
        + `\n    The copy taken before the sweep is at ${path.relative(ROOT, BAK)};`
        + `\n    merge it by hand if the sweep clobbered anything. (${why})`);
      process.exitCode = 1;
      return;
    }
    fs.writeFileSync(SRC, pristine);
    fs.rmSync(BAK, { force: true });
  } catch (e) {
    console.error(`  ✗ could not restore ${path.relative(ROOT, SRC)}: ${e.message}`
      + `\n    the original is at ${path.relative(ROOT, BAK)}`);
    process.exitCode = 1;
  }
}

process.on('exit', () => restore('exit'));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'SIGQUIT']) {
  /* A process killed by a signal never reaches 'exit', so each handler has to
     restore for itself. SIGBREAK exists only on Windows and SIGQUIT only off
     it; registering the wrong one throws, and a tool must not fail to start
     over a signal it was never going to get. */
  try { process.on(sig, () => { restore(sig); process.exit(130); }); } catch { /* not here */ }
}
process.on('uncaughtException', (e) => {
  restore('uncaughtException');
  console.error(e);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  restore('unhandledRejection');
  console.error(e);
  process.exit(1);
});

const rows = [];

try {
  for (const [name, edits] of VARIANTS) {
    let s = pristine;
    for (const [re, to] of edits) {
      if (!re.test(s)) throw new Error(`variant "${name}": pattern ${re} did not match`);
      s = s.replace(re, to);
    }
    /* A variant that comes out identical to the source is the baseline under
       another name, and a row labelled "hold .34" that is in fact the current
       build is the sort of thing a sweep gets read off for a week. */
    if (s === pristine) console.log(`  ⚠ variant "${name}" IS the current baseline`);
    mine.add(s);
    fs.writeFileSync(SRC, s);
    /* Other agents are editing the fx, render and world modules, so a boot
       can fail for reasons that have nothing to do with the variant. Retry
       rather than abandoning a seven-minute sweep. */
    let out = '';
    for (let attempt = 0; ; attempt++) {
      try {
        out = execFileSync(process.execPath,
          [path.join(ROOT, 'tools', 'churn.mjs'), '--seeds', SEEDS],
          { encoding: 'utf8', cwd: ROOT, maxBuffer: 1 << 26 });
        if (/═══ seed/.test(out)) break;
      } catch (err) {
        out = '';
        if (attempt >= 3) throw err;
      }
      if (attempt >= 3) throw new Error(`variant "${name}": no seeds ran`);
      console.log(`  ${name}: boot failed, retrying`);
      await new Promise(r => setTimeout(r, 20000));
    }
    const grab = (re, d = 0) => { const m = re.exec(out); return m ? +m[1] : d; };
    const finished = (out.match(/finished=true/g) || []).length;
    const seeds = (out.match(/═══ seed/g) || []).length;
    rows.push({
      name,
      lead: grab(/lead changes (\d+)   player-involved/),
      player: grab(/player-involved (\d+)/),
      rival: grab(/rival reshuffles (\d+)/),
      earned: grab(/passes of the player: (\d+) after/),
      clearAir: grab(/(\d+) out of clear air/),
      strobe: grab(/lasted under 2 s: (\d+)/),
      finished: `${finished}/${seeds}`,
      close: Math.round((out.match(/field within 60 m (\d+)%/g) || [])
        .map(x => +/(\d+)%/.exec(x)[1]).reduce((a, b) => a + b, 0) / Math.max(1, seeds)),
      lateThirds: (out.match(/changes by tenth of stage +([\d ]+)/g) || [])
        .map(x => x.trim().split(/\s+/).slice(-7).map(Number).reduce((a, b) => a + b, 0))
        .reduce((a, b) => a + b, 0),
    });
    console.log(`  ${name} done`);
  }
} finally {
  restore('finally');
}

console.log('\n  variant'.padEnd(38), 'fin    lead  player  rival  earned  clearAir  strobe  close  late70%');
for (const r of rows) {
  console.log(`  ${r.name}`.padEnd(38),
    r.finished.padStart(5),
    String(r.lead).padStart(6),
    String(r.player).padStart(7),
    String(r.rival).padStart(6),
    String(r.earned).padStart(7),
    String(r.clearAir).padStart(9),
    String(r.strobe).padStart(7),
    `${r.close}%`.padStart(6),
    String(r.lateThirds).padStart(8));
}
console.log('\n  late70% = lead changes in the last seven tenths of the stage;'
  + '\n  the whole point is racing that is still alive after the grid has sorted itself out.\n');
