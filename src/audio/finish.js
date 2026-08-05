/* The chequered flag.
 *
 * Two sounds a race, on the same terms as audio/start.js: oscillators and
 * envelopes, no buffers, no samples, permanent nodes built once and the
 * per-shot voices allocated and disconnected on `ended`.
 *
 *   flag   the crossing. A chord, arpeggiated.
 *   card   the classification landing. A stamp.
 *
 * Why a chord and not another tone. The start lights are a single narrow
 * pitch with a hard attack, chosen to cut through an engine sitting on its
 * limiter — a signal, and it has to be unambiguous about which beat it is.
 * The finish has the opposite job. Nothing is being signalled, the engine is
 * shutting up rather than screaming, and the sound has to say the thing is
 * over. Three notes arriving a beat apart and then sustaining is the only
 * cheap gesture that resolves; one more tone would just be a fifth start
 * light.
 *
 * A fourth voice an octave up is added for a win, and the third is major
 * rather than minor. That is one ratio and one weight, and it is the whole
 * difference between finishing and winning — which is the only thing the
 * audio has to carry that the card is not already carrying in type.
 *
 * The stamp is deliberately not pitched with the chord. The card is a piece
 * of printed board landing on the frame, not a fourth note, and giving it a
 * pitch inside the chord makes it read as part of the flourish rather than as
 * something arriving.
 */
import { clamp } from '../core/util.js';

/* G4. Below the start lights on purpose — those live at 740 and 1110, up
   where an engine cannot reach, and this one has nothing to compete with. */
const ROOT_HZ = 392;
const MAJOR_3RD = 1.25;
const MINOR_3RD = 1.2;
const FIFTH = 1.5;
/* How far apart the notes arrive. Under about 40 ms three voices read as one
   struck chord and the gesture is gone; over about 90 ms it is a tune. */
const ARP = 0.062;
const CHORD_DUR = 1.75;

/* Peak of the envelope, before the bus gain the owner applies, and split
   across the voices below rather than applied to each. Set against the same
   bed audio/start.js is: the engine on its limiter measures 0.239 rms
   (tools/audio.mjs). Lower than the GO tone because by the time this fires
   the player has lifted and the mix has emptied out — the level a signal
   needs to cut through a full-throttle engine is, on a quiet frame, a
   shout. */
const CHORD_LEVEL = 0.52;

/* The stamp. A low body with a fast downward bend is a physical impact; the
   tick on the front of it is the edge of the board. */
const STAMP_HZ = 132;
const STAMP_DROP = 0.66;
const STAMP_DUR = 0.24;
const STAMP_LEVEL = 0.40;
const TICK_HZ = 1760;
const TICK_DUR = 0.05;
const TICK_LEVEL = 0.16;

export class FinishTones {
  constructor(ctx, dest) {
    this.ctx = ctx;
    this.nodes = [];
    const node = n => { this.nodes.push(n); return n; };

    this.out = node(ctx.createGain());
    this.out.gain.value = 1;
    this.out.connect(dest);

    /* A resonance around the chord, so it has a body rather than being three
       pure tones stacked. Wider and gentler than the start tone's, because
       this one has to flatter an interval rather than sharpen a single
       pitch: a narrow peak sitting on one note of a triad tunes that note
       forward and the chord stops being a chord. */
    this.body = node(ctx.createBiquadFilter());
    this.body.type = 'peaking';
    this.body.frequency.value = ROOT_HZ * FIFTH;
    this.body.Q.value = 0.8;
    this.body.gain.value = 4;
    this.body.connect(this.out);

    /* Nothing below the root belongs in the chord. The stamp does not go
       through this — it is nearly all bottom end and this would delete it. */
    this.cut = node(ctx.createBiquadFilter());
    this.cut.type = 'highpass';
    this.cut.frequency.value = ROOT_HZ * 0.75;
    this.cut.Q.value = 0.7;
    this.cut.connect(this.body);
  }

  /**
   * @param {number} t when, on the engine's clock
   * @param {'flag'|'card'} kind
   * @param {boolean} win the player came first
   */
  fire(t, kind = 'flag', win = false) {
    if (kind === 'card') return this._stamp(t);
    this._chord(t, win);
  }

  _chord(t, win) {
    const ctx = this.ctx;
    const third = win ? MAJOR_3RD : MINOR_3RD;
    /* Weights fall with pitch so the chord sits on its root instead of being
       led by its top note, and they sum to one so CHORD_LEVEL means the peak
       of the whole gesture rather than of whichever voice happens to be
       loudest. The octave only exists on a win and is taken out of the
       others' share, so a win is not simply a louder finish. */
    const voices = win
      ? [[1, 0.40, 0], [third, 0.24, 6], [FIFTH, 0.22, -5], [2, 0.14, 9]]
      : [[1, 0.46, 0], [third, 0.28, 6], [FIFTH, 0.26, -5]];

    voices.forEach(([mul, gain, detune], i) => {
      /* Each voice is a triangle with a sine an octave over it, which is the
         same pairing audio/start.js uses and for the same reason: the
         triangle carries a thin odd series and the sine fills what it leaves
         without the buzz a square would add. */
      const at = t + i * ARP;
      const dur = CHORD_DUR - i * ARP;
      this._voice('triangle', ROOT_HZ * mul, CHORD_LEVEL * gain, detune, at, dur, this.cut);
      this._voice('sine', ROOT_HZ * mul * 2, CHORD_LEVEL * gain * 0.22, detune + 3,
        at, dur * 0.8, this.cut);
    });
  }

  _stamp(t) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(STAMP_HZ, t);
    /* The bend is what makes it a landing rather than a note. Exponential,
       because a linear drop through the bottom two octaves is heard as a
       swoop and this has to be over before it is noticed. */
    osc.frequency.exponentialRampToValueAtTime(STAMP_HZ * STAMP_DROP, t + 0.075);
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(STAMP_LEVEL, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0004, t + STAMP_DUR);
    osc.connect(g);
    // Straight to the output: the highpass above exists to keep the chord out
    // of the engine's register and this sound is entirely in it.
    g.connect(this.out);
    osc.start(t);
    osc.stop(t + STAMP_DUR + 0.05);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };

    this._voice('sine', TICK_HZ, TICK_LEVEL, 0, t, TICK_DUR, this.body);
  }

  _voice(type, hz, level, detune, t, dur, dest) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.detune.value = detune;
    osc.frequency.setValueAtTime(hz, t);

    const g = ctx.createGain();
    /* Zeroed before anything is scheduled, for the reason impact.js
       documents at length: a GainNode is born at 1, and the window between
       the first render quantum and a sample-accurate start() is a full scale
       oscillator passing through unity. */
    g.gain.value = 0;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(clamp(level, 0, 1), t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0004, t + dur);

    osc.connect(g);
    g.connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.05);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
  }

  dispose() {
    for (const n of this.nodes) n.disconnect();
  }
}
