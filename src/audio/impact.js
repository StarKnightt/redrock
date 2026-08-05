/* Collisions and landings.
 *
 * Three things happen at once when a car hits something and all three have to
 * be there or it reads as a sound effect rather than as contact: a click, from
 * the panel deflecting; a broadband crunch, from everything loose in the car
 * moving at once; and a low thud with pitch in it, which is the body shell
 * ringing. Drop the click and it feels distant, drop the thud and it feels
 * like paper.
 *
 * This is the one place that allocates. A one-shot needs its own envelope and
 * the envelope has to be able to overlap the previous one, so the source and
 * gain per hit are unavoidable — but the filters they run into are permanent,
 * and the rate limit below caps the damage when the car is scraping a berm and
 * the physics reports contact every single frame.
 */
import { clamp, lerp } from '../core/util.js';
import { rng, rand } from '../core/rng.js';

const MIN_GAP = 0.055;      // seconds between hits
const BUDGET = 5;           // hits in flight before new ones are refused
const RECHARGE = 7;         // budget restored per second

export class Impacts {
  constructor(ctx, dest, buffers, seed = 7331) {
    this.ctx = ctx;
    this.buf = buffers.white;
    this.rand = rand(rng(seed));
    this.nodes = [];
    this.last = -1e9;
    this.charged = -1e9;
    this.budget = BUDGET;
    const node = (n) => { this.nodes.push(n); return n; };

    this.out = node(ctx.createGain());
    this.out.gain.value = 1;
    this.out.connect(dest);

    this.clickIn = node(ctx.createBiquadFilter());
    this.clickIn.type = 'highpass';
    this.clickIn.frequency.value = 2400;
    this.clickIn.Q.value = 0.8;
    this.clickIn.connect(this.out);

    this.crunchIn = node(ctx.createBiquadFilter());
    this.crunchIn.type = 'bandpass';
    this.crunchIn.frequency.value = 620;
    this.crunchIn.Q.value = 0.7;
    this.crunchIn.connect(this.out);

    this.bodyIn = node(ctx.createBiquadFilter());
    this.bodyIn.type = 'lowpass';
    this.bodyIn.frequency.value = 210;
    this.bodyIn.Q.value = 1.3;
    this.bodyIn.connect(this.out);

    /* Called with (t, strength) just before a hit is synthesised.
     *
     * An impact is not loud enough to be an impact. It is loud enough relative
     * to what was there a moment before, and what was there is a full-throttle
     * engine occupying the same band. Pushing the hit up until it wins is how
     * you end up clipping; pulling the engine down for a fifth of a second is
     * what an engineer would do, and it is what makes contact land. The owner
     * of the bus wires this up — see index.js. */
    this.onFire = null;
  }

  /**
   * @param {number} t when, on the engine's clock
   * @param {number} strength 0..1
   * @param {number} tone 0..1 — 1 is metal on rock, 0 is a suspension landing
   */
  fire(t, strength, tone = 1) {
    const s = clamp(strength, 0, 1);
    if (s < 0.02) return;
    /* The budget recharges against its own clock, not against the last hit
       that was allowed. Measured from the last hit, a car scraping a berm —
       which reports contact on every single frame — refills the budget faster
       than it spends it, and the rate limit quietly does nothing. */
    this.budget = Math.min(BUDGET, this.budget + Math.max(0, t - this.charged) * RECHARGE);
    this.charged = t;
    if (t - this.last < MIN_GAP || this.budget < 1) return;
    this.last = t;
    this.budget -= 1;
    if (this.onFire) this.onFire(t, s, tone);

    const ctx = this.ctx;
    const r = this.rand;

    /* A burst is a slice of the shared noise buffer with an envelope on it.
       Starting each one at a different offset stops repeated hits sounding
       like the same recording played twice, which is what happens with a real
       sample and is exactly what this engine exists to avoid. */
    const burst = (dest, level, dur, rate) => {
      const src = ctx.createBufferSource();
      src.buffer = this.buf;
      src.playbackRate.value = rate;
      const g = ctx.createGain();
      /* Zeroed before anything is scheduled on it, and this is not belt and
         braces — it is a bug fix.
         
         A GainNode is born at 1. `setValueAtTime(level, t)` takes effect at
         the first render quantum boundary at or after t, and `src.start(t)`
         is sample accurate, so between the two there is a window of up to one
         block in which a full-scale noise buffer is passing through a gain of
         one. It lasts a single sample after filtering and it measures as a
         0.4 spike on a landing whose intended peak was 0.09 — a click, in
         other words, on every impact in the game, sitting underneath the
         sound it belongs to and reading as harshness rather than as a fault.
         Setting the value up front closes the window. */
      g.gain.value = 0;
      g.gain.setValueAtTime(level, t);
      g.gain.exponentialRampToValueAtTime(0.0006, t + dur);
      src.connect(g);
      g.connect(dest);
      src.start(t, r.f(0, this.buf.duration - dur * rate - 0.01));
      src.stop(t + dur + 0.02);
      src.onended = () => { src.disconnect(); g.disconnect(); };
    };

    const hard = lerp(0.35, 1, tone);
    burst(this.clickIn, 0.55 * s * s * hard, lerp(0.012, 0.03, s), lerp(1.3, 0.9, s));
    burst(this.crunchIn, 0.42 * s * hard, lerp(0.05, 0.16, s), 1);
    burst(this.bodyIn, 0.7 * s, lerp(0.09, 0.32, s), 1);

    /* The pitched part. Falling, because a shell that has just been hit rings
       lower as the energy leaves it — a fixed-pitch thud sounds like a drum
       machine. */
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const f0 = lerp(58, 96, s) * lerp(0.72, 1, tone);
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + 0.22);
    const og = ctx.createGain();
    og.gain.value = 0;
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(0.75 * s, t + 0.006);
    og.gain.exponentialRampToValueAtTime(0.0006, t + lerp(0.14, 0.34, s));
    osc.connect(og);
    og.connect(this.out);
    osc.start(t);
    osc.stop(t + 0.4);
    osc.onended = () => { osc.disconnect(); og.disconnect(); };

    /* Sub.
     *
     * The part above is the sound of the hit. This is the part you feel, and
     * without it a heavy landing and a light one differ only in level — which
     * is the specific complaint that impacts have no weight. An octave under
     * the shell note, slower to arrive and slower to leave, and scaled by s³
     * rather than s so it belongs to big hits only: a kerb strike that shakes
     * the room is worse than no sub at all.
     *
     * It is also where the headroom goes if it is not watched. A sine at 35 Hz
     * contributes almost nothing that a laptop speaker will reproduce and all
     * of its amplitude to the peak, so the master's high-pass earns its keep
     * here more than anywhere else in the graph. */
    const weight = s * s * s * lerp(1, 1.35, 1 - tone);
    if (weight > 0.02) {
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      const sf = f0 * lerp(0.52, 0.62, tone);
      sub.frequency.setValueAtTime(sf, t);
      sub.frequency.exponentialRampToValueAtTime(sf * 0.72, t + 0.3);
      const sg = ctx.createGain();
      sg.gain.value = 0;
      sg.gain.setValueAtTime(0.0001, t);
      sg.gain.linearRampToValueAtTime(0.62 * weight, t + 0.018);
      sg.gain.exponentialRampToValueAtTime(0.0006, t + lerp(0.22, 0.46, s));
      sub.connect(sg);
      sg.connect(this.out);
      sub.start(t);
      sub.stop(t + 0.55);
      sub.onended = () => { sub.disconnect(); sg.disconnect(); };
    }

    /* Suspension. Only on the dull hits, which is to say landings: springs
       compressing and rebounding is a short damped wobble in the 20–40 Hz
       region of the body, and it is the difference between a car landing and a
       crate being dropped. Modelled as a second, slower body burst rather than
       as an oscillator, because it is broadband — it is the whole car moving,
       not one part of it ringing. */
    if (tone < 0.4 && s > 0.15) {
      const spring = (1 - tone / 0.4) * s;
      burst(this.bodyIn, 0.34 * spring, lerp(0.16, 0.42, s), 0.72);
      burst(this.crunchIn, 0.10 * spring, lerp(0.09, 0.2, s), 0.8);
    }
  }

  dispose() {
    for (const n of this.nodes) n.disconnect();
  }
}
