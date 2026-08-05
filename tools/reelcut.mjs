/* Cut the captured frames into the deliverable.
 *
 * Two ffmpeg stages and no third: each shot is encoded once from its PNG
 * sequence with identical encoder settings, then the segments are joined with
 * `-c copy`. Concatenating streams rather than re-encoding a concatenation is
 * what keeps this a single generation — every segment starts on an IDR and
 * carries the same SPS/PPS, which is the condition the concat demuxer needs.
 *
 * The frame rate is asserted, not assumed. The capture stepped a fixed 1/60
 * and pinned `performance.now` to the same 1/60, so `-framerate 60` here is
 * an honest statement about the source and not a resample.
 *
 * Twitter's constraints, which are the reason for the flag soup:
 *   H.264 High, yuv420p (4:2:0 8-bit), 1920x1080, <= 60 fps, <= 25 Mbit/s,
 *   moov atom at the front (`+faststart`), and an audio track — the upload
 *   path is happier with a silent AAC stream than with no stream at all.
 *
 *   node tools/reelcut.mjs [--plan out/reel/plan.json] [--crf 15]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const PLAN = path.resolve(ROOT, flag('plan', 'out/reel/plan.json'));
const CRF = flag('crf', '15');
const FPS = 60;
const REEL = path.join(ROOT, 'out', 'reel');
const FRAMES = path.join(REEL, 'frames');
const SEG = path.join(REEL, 'segments');
const OUT = path.join(REEL, 'redrock.mp4');

const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
fs.mkdirSync(SEG, { recursive: true });

const ff = (...a) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...a],
  { stdio: ['ignore', 'inherit', 'inherit'] });

const ENC = [
  '-c:v', 'libx264', '-preset', 'slow', '-crf', CRF,
  '-profile:v', 'high', '-level', '4.2',
  '-pix_fmt', 'yuv420p',
  /* A keyframe every two seconds and one at every segment start. Without a
     forced IDR on frame zero of each segment the copy-concat below produces a
     stream whose first frame references a picture that is not in it. */
  '-x264-params', 'keyint=120:min-keyint=1:scenecut=0:open-gop=0',
  '-maxrate', '22M', '-bufsize', '44M',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
  '-movflags', '+faststart',
];

const list = [];
let totalFrames = 0;

for (const shot of plan.shots) {
  const dir = path.join(FRAMES, shot.id);
  const n = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.png')).length : 0;
  if (!n) { console.error(`  ✗ ${shot.id}: no frames in ${path.relative(ROOT, dir)}`); process.exit(1); }
  if (n !== shot.n) console.log(`  ! ${shot.id}: ${n} frames on disk, plan says ${shot.n}`);
  const seg = path.join(SEG, `${shot.id}.mp4`);
  ff('-framerate', String(FPS), '-start_number', '1', '-i', path.join(dir, '%05d.png'),
    ...ENC, '-an', seg);
  const bytes = fs.statSync(seg).size;
  console.log(`  ${shot.id.padEnd(15)} ${String(n).padStart(4)} frames`
    + `  ${(n / FPS).toFixed(2)}s  ${(bytes / 1e6).toFixed(1)} MB`);
  list.push(seg);
  totalFrames += n;
}

const listFile = path.join(SEG, 'concat.txt');
fs.writeFileSync(listFile, list.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n') + '\n');

/* Video copied, audio synthesised. Copying keeps the single generation; the
   silent track is 2-channel 48 kHz AAC because that is what every consumer of
   an MP4 expects to find if it finds anything. */
const silent = path.join(SEG, '_silent.m4a');
ff('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
  '-t', String(totalFrames / FPS), '-c:a', 'aac', '-b:a', '128k', silent);

ff('-f', 'concat', '-safe', '0', '-i', listFile, '-i', silent,
  '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-shortest',
  '-movflags', '+faststart', OUT);

const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries',
  'format=duration,bit_rate,size:stream=index,codec_name,profile,width,height,'
  + 'r_frame_rate,pix_fmt,nb_frames', '-of', 'default=nw=1', OUT]).toString();

console.log(`\n  ${totalFrames} frames  ${(totalFrames / FPS).toFixed(2)} s`
  + `  → ${path.relative(ROOT, OUT)}\n`);
console.log(probe.split('\n').filter(Boolean).map(l => '    ' + l).join('\n'));
