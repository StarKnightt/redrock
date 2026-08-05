/* Race punctuation.
 *
 * Two sounds that belong to events rather than to the continuous car:
 *
 *   position   a short, rising pair for a place gained; one muted fall for a
 *              place lost
 *   boost      an ignition transient followed by a second motor that tracks
 *              the physics' 1.2 second boost timer
 *
 * The position notes and the boost ignition go to the hit bus, downstream of
 * the engine duck. The sustained boost motor goes to the car bus: it is part
 * of the car for as long as the pad is pushing it, not a one-shot laid over
 * the mix. Every continuous node is built once; only the rare event attacks
 * allocate short-lived sources, on the same terms as start.js and finish.js.
 */
import { clamp, approach } from '../core/util.js';
import { harmonicWave, noiseSource } from './noise.js';

const BOOST_SEC = 1.2;           // matches car/physics.js

export class FeedbackVoices {
  constructor(ctx, carDest, hitDest, buffers, seed = 1207) {
    this.ctx = ctx;
    this.nodes = [];
    this.sources = [];
    this.buf = buffers.white;
    this.boost = 0;
    const node = n => { this.nodes.push(n); return n; };

    /* The pad's second engine ------------------------------------------ */
    this.boostOut = node(ctx.createGain());
    /* Exactly zero while dormant. Besides being silence, this keeps every
       existing offline-audio scenario sample-identical when it omits the new
       boostTimer field. */
    this.boostOut.gain.value = 0;
    this.boostOut.connect(carDest);

    this.boostLow = node(ctx.createBiquadFilter());
    this.boostLow.type = 'lowpass';
    this.boostLow.frequency.value = 1800;
    this.boostLow.Q.value = 0.8;
    this.boostLow.connect(this.boostOut);

    const motor = (wave, gain, detune) => {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      osc.detune.value = detune;
      const g = node(ctx.createGain());
      g.gain.value = gain;
      osc.connect(g);
      g.connect(this.boostLow);
      osc.start(0);
      this.sources.push(osc);
      return osc;
    };
    /* A coarser, higher firing order than the main four-cylinder voice. The
       detuned pair beats gently instead of summing into one synthetic note. */
    this.boostMotor = motor(
      harmonicWave(ctx, seed + 1, 18, 0.82, { spread: 0.9 }), 0.62, 0);
    this.boostHarmonic = motor(
      harmonicWave(ctx, seed + 2, 12, 1.15, { spread: 1.5 }), 0.24, 17);

    this.boostAirBand = node(ctx.createBiquadFilter());
    this.boostAirBand.type = 'bandpass';
    this.boostAirBand.frequency.value = 1700;
    this.boostAirBand.Q.value = 0.72;
    this.boostAir = node(ctx.createGain());
    this.boostAir.gain.value = 0.24;
    this.sources.push(noiseSource(ctx, buffers.white, this.boostAirBand,
      { rate: 1.13, offset: 1.17 }));
    this.boostAirBand.connect(this.boostAir);
    this.boostAir.connect(this.boostOut);

    /* Event bus -------------------------------------------------------- */
    this.positionOut = node(ctx.createGain());
    this.positionOut.gain.value = 1;
    this.positionOut.connect(hitDest);

    /* Shared colour for the pad's rare ignition burst. Sources and envelopes
       are per-shot; the filter is permanent because pads cannot overlap. */
    this.kickBand = node(ctx.createBiquadFilter());
    this.kickBand.type = 'bandpass';
    this.kickBand.frequency.value = 820;
    this.kickBand.Q.value = 0.7;
    this.kickBand.connect(this.positionOut);
  }

  /**
   * Keep the second motor on the same clock as the boost force.
   * @param {number} dt
   * @param {number} rpm normalised 0..1
   * @param {number} boostTimer seconds of pad force remaining
   * @param {number} t audio-context time
   */
  update(dt, rpm, boostTimer, t) {
    const raw = clamp((boostTimer || 0) / BOOST_SEC, 0, 1);
    this.boost = approach(this.boost, raw, raw > this.boost ? 24 : 7, dt);
    const b = this.boost;
    const rev = clamp(rpm || 0, 0, 1);
    const set = (p, v, tau = 0.03) => p.setTargetAtTime(v, t, tau);

    /* Above the engine rather than on top of it. The ratio is deliberately
       not an octave, so the pad reads as another mechanism joining the car
       instead of the existing engine merely getting louder. */
    const f = 150 + rev * 310;
    set(this.boostMotor.frequency, f, 0.018);
    set(this.boostHarmonic.frequency, f * 1.47, 0.018);
    set(this.boostLow.frequency, 1050 + rev * 2100 + b * 900, 0.045);
    set(this.boostAirBand.frequency, 1050 + rev * 1900 + b * 750, 0.04);
    /* A slightly concave fade keeps the voice present through most of the
       1.2 seconds while still following the force as it falls away. */
    set(this.boostOut.gain, b > 0.0005 ? 0.13 * Math.pow(b, 0.72) : 0,
      raw > 0 ? 0.018 : 0.055);
  }

  /**
   * The rank event. Rising and two-part is reward; falling and one-part is
   * information. Neither is a fanfare, and neither shares the start lights'
   * high signal pitches.
   */
  position(t, direction) {
    if (direction === 'gained') {
      this._tone(t, 494, 554, 0.16, 0.22, 'triangle');
      this._tone(t + 0.072, 622, 698, 0.18, 0.30, 'triangle');
      /* A quiet octave edge gives the two notes enough attack to survive the
         engine without turning the gesture into a coin pickup. */
      this._tone(t + 0.006, 988, 1108, 0.038, 0.13, 'sine');
    } else if (direction === 'lost') {
      this._tone(t, 349, 247, 0.13, 0.30, 'triangle');
      this._tone(t + 0.004, 698, 494, 0.028, 0.17, 'sine');
    }
  }

  /** The brief attack that says the pad fired before the motor carries on. */
  boostStart(t, rpm = 0.5) {
    const rev = clamp(rpm, 0, 1);
    const f0 = 210 + rev * 230;
    this._tone(t, f0, f0 * 1.82, 0.14, 0.24, 'triangle');

    const src = this.ctx.createBufferSource();
    src.buffer = this.buf;
    src.playbackRate.value = 1.35;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.11, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.18);
    src.connect(g);
    g.connect(this.kickBand);
    this.kickBand.frequency.cancelScheduledValues(t);
    this.kickBand.frequency.setValueAtTime(620 + rev * 500, t);
    this.kickBand.frequency.exponentialRampToValueAtTime(1900 + rev * 1100, t + 0.18);
    src.start(t, 0.37);
    src.stop(t + 0.21);
    src.onended = () => { src.disconnect(); g.disconnect(); };
  }

  _tone(t, f0, f1, level, dur, type) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, f0), t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(level, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
    osc.connect(g);
    g.connect(this.positionOut);
    osc.start(t);
    osc.stop(t + dur + 0.03);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
  }

  dispose() {
    for (const s of this.sources) { try { s.stop(); } catch (_) {} }
    for (const n of this.nodes) n.disconnect();
    for (const s of this.sources) s.disconnect();
  }
}
