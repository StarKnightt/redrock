/* Start lights.
 *
 * Four sounds a race: three counts and a release. Procedural like everything
 * else here — two oscillators and an envelope, no buffers, no samples.
 *
 * Why a tone and not a klaxon. The count has to be heard over an engine
 * sitting on its limiter, which is broadband and loud from about 200 Hz up to
 * a couple of kilohertz. A noise-based marshal's horn lives in exactly that
 * band and loses; a narrow, pitched tone with a hard attack sits in a slot the
 * engine cannot fill however hard it is revved, which is why real start
 * systems use one.
 *
 * The count and the release are the same voice a fifth apart, and the release
 * is longer, louder and bends up. A fifth rather than an octave: an octave
 * reads as the same note again and the one thing this signal must never be is
 * ambiguous about which beat it is.
 *
 * Permanent nodes are built once, in the constructor. The per-shot oscillator
 * and its gain are allocated — an envelope has to be able to overlap the last
 * one and there is no way around that — and disconnected on ended, which is
 * the pattern impact.js already uses for the same reason.
 */
import { clamp } from '../core/util.js';

/* The count. A above the treble stave and a bit: high enough to clear the
   engine's formant, low enough not to be a smoke alarm. */
const COUNT_HZ = 740;
/* A perfect fifth above, which is 1.5x. Written as the ratio and not as
   1110 so the two cannot drift apart when either is retuned. */
const GO_RATIO = 1.5;
const COUNT_DUR = 0.30;
const GO_DUR = 0.95;
/* Peak of the envelope, before the bus gain the owner applies. Set against
   the impact layer rather than in isolation: a start tone that is louder than
   hitting a cliff is a mixing error, and these run through the same soft
   clipper. */
/* Levels are set against the thing they have to be heard over, which is the
 * engine sitting on its limiter — `tools/audio.mjs` puts that bed at 0.239
 * rms. At 0.30/0.42 the count was 0.7 dB of lift on the mix peak, which is
 * not a start signal, it is a notification. These are the loudest single
 * events in the game after a heavy impact, and they should be. */
const COUNT_LEVEL = 0.42;
const GO_LEVEL = 0.60;

export class StartTones {
  constructor(ctx, dest) {
    this.ctx = ctx;
    this.nodes = [];
    const node = n => { this.nodes.push(n); return n; };

    this.out = node(ctx.createGain());
    this.out.gain.value = 1;
    this.out.connect(dest);

    /* A resonance at the count's own pitch, so the tone has a body around it
       rather than being a pure sine with an edge. Everything goes through it,
       including the release a fifth up, which is therefore a shade darker
       than the counts relative to its own fundamental — which is what makes
       it read as a bigger, rounder sound and not merely a higher one. */
    this.body = node(ctx.createBiquadFilter());
    this.body.type = 'peaking';
    this.body.frequency.value = COUNT_HZ;
    this.body.Q.value = 1.4;
    this.body.gain.value = 5;
    this.body.connect(this.out);

    /* Nothing below the fundamental belongs in this signal, and the engine
       owns that region completely. */
    this.cut = node(ctx.createBiquadFilter());
    this.cut.type = 'highpass';
    this.cut.frequency.value = 380;
    this.cut.Q.value = 0.7;
    this.cut.connect(this.body);
  }

  /**
   * @param {number} t when, on the engine's clock
   * @param {boolean} go the release, rather than a count
   */
  fire(t, go = false) {
    const ctx = this.ctx;
    const f0 = go ? COUNT_HZ * GO_RATIO : COUNT_HZ;
    const dur = go ? GO_DUR : COUNT_DUR;
    const level = go ? GO_LEVEL : COUNT_LEVEL;

    /* Two partials, and the second is what makes it an instrument rather than
       a test tone: a triangle carries a thin odd-harmonic series of its own,
       and a sine an octave over it fills the gap the triangle leaves without
       adding the buzz a square would. */
    const voice = (type, mul, gain, detune) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.detune.value = detune;
      const f = f0 * mul;
      osc.frequency.setValueAtTime(f, t);
      /* The release bends up a few cents across its own length. A fixed pitch
         decays; a rising one accelerates, which is the thing the sound is
         being asked to mean. */
      if (go) osc.frequency.linearRampToValueAtTime(f * 1.045, t + dur * 0.55);

      const g = ctx.createGain();
      /* Zeroed before anything is scheduled, for the reason impact.js
         documents at length: a GainNode is born at 1, and the window between
         the first render quantum and a sample-accurate start() is a full
         scale oscillator passing through unity. */
      g.gain.value = 0;
      g.gain.setValueAtTime(0.0001, t);
      /* A few milliseconds of attack rather than a step. A step on a tone this
         narrow is a click with a note behind it, and the click is the part
         that gets heard. */
      g.gain.linearRampToValueAtTime(clamp(level * gain, 0, 1), t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0004, t + dur);

      osc.connect(g);
      g.connect(this.cut);
      osc.start(t);
      osc.stop(t + dur + 0.05);
      osc.onended = () => { osc.disconnect(); g.disconnect(); };
    };

    voice('triangle', 1, 1, 0);
    voice('sine', 2, go ? 0.34 : 0.26, 4);
  }

  dispose() {
    for (const n of this.nodes) n.disconnect();
  }
}
