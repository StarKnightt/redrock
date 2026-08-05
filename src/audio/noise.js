/* Raw material.
 *
 * Nothing in this game is loaded from disk, and sound is no exception: every
 * grain of noise below is written into a Float32Array by the same seeded
 * mulberry32 that scatters the rocks. Two consequences worth knowing. Buffers
 * are built once at start() and shared by every layer that needs them, because
 * a second of stereo noise is a megabyte and the layers only differ by what
 * they filter out of it. And the seed is fixed, so a render of the same
 * scenario twice gives bit-identical output — which is the only reason the
 * offline harness can assert on numbers at all.
 */
import { rng, rand } from '../core/rng.js';

const SEAM = 0.05;      // seconds of overlap folded across the loop point

/**
 * A seamless looping noise buffer.
 *
 * `pink` runs Paul Kellet's three-pole economy filter, which is within a
 * quarter of a dB of -3 dB/octave across the audible band. White is right for
 * anything that will be band-passed hard afterwards; pink is right for the
 * broadband layers (wind, gravel) because white through a gentle low-pass
 * still sounds like hiss with the top taken off rather than like air.
 */
export function noiseBuffer(ctx, seconds, seed, { pink = false } = {}) {
  const sr = ctx.sampleRate;
  const n = Math.floor(seconds * sr);
  const seam = Math.min(Math.floor(SEAM * sr), n >> 2);
  const r = rand(rng(seed));

  /* Generate past the end of the buffer, then fold that tail back over the
     head. A looped buffer whose last sample does not meet its first clicks
     once per period, and a click at 2 Hz is the most conspicuous thing in any
     mix — it reads as a fault in the game, not a fault in the sound. */
  const tmp = new Float32Array(n + seam);
  if (pink) {
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < tmp.length; i++) {
      const w = r.f(-1, 1);
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      tmp[i] = (b0 + b1 + b2 + w * 0.1848) * 0.33;
    }
  } else {
    for (let i = 0; i < tmp.length; i++) tmp[i] = r.f(-1, 1);
  }

  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  d.set(tmp.subarray(0, n));
  for (let i = 0; i < seam; i++) {
    const t = i / seam;
    // Equal power, so the crossfade does not dip in level at its midpoint.
    d[i] = tmp[i] * Math.sin(t * Math.PI * 0.5) + tmp[n + i] * Math.cos(t * Math.PI * 0.5);
  }
  return buf;
}

/**
 * A looping source already wired to `dest`, started and left running.
 *
 * Everything that makes noise in this engine is one of these plus a filter and
 * a gain. Creating and destroying buffer sources per frame is the classic way
 * to make Web Audio stutter, so the sources run forever and the gains do the
 * work. `rate` and `offset` exist to decorrelate layers that share a buffer:
 * two sources reading the same samples in lockstep sum to one louder source,
 * not to two independent ones.
 */
export function noiseSource(ctx, buf, dest, { rate = 1, offset = 0, when = 0 } = {}) {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.playbackRate.value = rate;
  src.connect(dest);
  src.start(when, offset % buf.duration);
  return src;
}

/**
 * Odd-symmetric tanh curve for a WaveShaperNode.
 *
 * Odd symmetry matters more than the exact shape: an asymmetric curve fed the
 * engine's lopsided pulse train produces a DC offset, which costs headroom on
 * the master bus and shows up in the harness as a failed measurement long
 * before anyone hears it.
 */
export function saturationCurve(drive = 2.0, { ceiling = 1, n = 2048 } = {}) {
  const c = new Float32Array(n);
  const norm = Math.tanh(drive) / ceiling;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * drive) / norm;
  }
  return c;
}

/**
 * Harmonic stack as a PeriodicWave.
 *
 * `tilt` is the exponent of the 1/nᵗ rolloff — low is bright and buzzy, high
 * is soft. `spread` is how far the partial phases are randomised: at 0 every
 * partial peaks together and the result is an impulse train, which is what a
 * cylinder firing actually sounds like; wound up past a radian the energy
 * smears across the period and it turns into a drone. The engine layers pick
 * different points on that axis and crossfade between them.
 */
export function harmonicWave(ctx, seed, count, tilt, { spread = 0, evenCut = 0 } = {}) {
  const real = new Float32Array(count + 1);
  const imag = new Float32Array(count + 1);
  const r = rand(rng(seed));
  for (let k = 1; k <= count; k++) {
    let a = Math.pow(k, -tilt);
    if (evenCut && k % 2 === 0) a *= 1 - evenCut;
    const ph = r.f(-1, 1) * spread;
    real[k] = a * Math.cos(ph);
    imag[k] = a * Math.sin(ph);
  }
  return ctx.createPeriodicWave(real, imag);
}

/**
 * Procedural impulse response — a coast road, not a room and not a canyon.
 *
 * The geometry changed and the reverb has to change with it. A canyon is two
 * facing walls: reflections come back from both sides, they come back
 * repeatedly, and the tail is dense because the energy has nowhere to go. A
 * road cut into a sea cliff is half of that. There is one hard surface, on one
 * side, and on the other side is several kilometres of open water — which
 * reflects nothing back at you at all.
 *
 * So: one distinct early slap off the rock, arriving in one ear before the
 * other because the cliff is not in front of you; a couple of weaker
 * reflections off the road cut behind it; and then a thin, fast-decaying tail
 * rather than a dense one. The difference is audible immediately as openness —
 * a dense tail on a half-open space is the classic tell that a reverb was
 * chosen rather than built.
 *
 * @param {number} seconds
 * @param {number} seed
 * @param {number} decay tail exponent — higher is shorter and thinner
 * @param {{slapSide?:number}} opts slapSide -1 puts the cliff to the left
 */
export function impulseResponse(ctx, seconds, seed, decay = 6.5, { slapSide = -1 } = {}) {
  const sr = ctx.sampleRate;
  const n = Math.floor(seconds * sr);
  const buf = ctx.createBuffer(2, n, sr);
  const r = rand(rng(seed));

  /* An 8 ms inter-aural difference is far wider than a head, and that is the
     point: the reflector is tens of metres away and off to one side, so the
     two ears are hearing the same event at genuinely different distances. */
  const slapAt = 0.055 * sr;
  const skew = 0.008 * sr;

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const facing = (ch === 0 ? -1 : 1) === slapSide;
    for (let i = 0; i < n; i++) {
      /* Density, not just level. The tail is scaled down and thinned by
         dropping most of the samples, which is what a space with one
         reflecting surface actually sounds like — you can hear individual
         returns rather than a wash. */
      d[i] = (r.chance(0.55) ? r.f(-1, 1) : 0) * Math.pow(1 - i / n, decay) * 0.5;
    }
    const put = (at, amp) => {
      const i = Math.floor(at);
      if (i >= 0 && i < n) d[i] += r.sign() * amp;
    };
    put(slapAt + (facing ? 0 : skew), (facing ? 0.85 : 0.42) * r.f(0.9, 1.1));
    put(slapAt * 1.9 + (facing ? 0 : skew), (facing ? 0.34 : 0.18) * r.f(0.8, 1.2));
    put(slapAt * 3.1 + r.f(-40, 40), (facing ? 0.16 : 0.11) * r.f(0.8, 1.2));
  }

  /* Scaled to unit energy here rather than left to the ConvolverNode.
   *
   * A convolver normalises by default, and the scale it picks is a function of
   * the response's total energy — so every time the tail length or the decay
   * exponent is touched, the wet level silently moves and the send has to be
   * retuned to compensate. Worse, the relationship is inverse: making the
   * space smaller makes the reverb louder, which is precisely backwards from
   * what anyone editing these numbers expects.
   *
   * Doing it here, with `normalize = false` on the node, makes the wet gain
   * mean a fixed thing: convolution with this buffer preserves the RMS of a
   * broadband signal, and the send is the only control over how much space
   * there is. */
  let energy = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) energy += d[i] * d[i];
  }
  const scale = energy > 0 ? 1 / Math.sqrt(energy / 2) : 1;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) d[i] *= scale;
  }
  return buf;
}
