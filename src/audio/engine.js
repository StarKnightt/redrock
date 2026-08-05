/* Engine.
 *
 * The naive build is one sawtooth whose frequency tracks rpm, and it is why so
 * much browser racing sounds like a vacuum cleaner: a sawtooth's harmonics are
 * locked in a fixed ratio, so the only thing that changes across the rev range
 * is pitch. A real engine changes character. It is lumpy at idle because you
 * can hear the individual cylinders arrive, it hardens and goes brassy under
 * load because the exhaust pulses get sharper and the whole thing distorts,
 * and it softens on a trailing throttle. None of that is pitch.
 *
 * So this is built the way the noise is actually made:
 *
 *   1. Firing pulses. A four-cylinder four-stroke fires twice per crank
 *      revolution — 35 Hz at idle, 247 Hz at the limiter. The `pulse` layer is
 *      a PeriodicWave with nearly-aligned partial phases, which in the time
 *      domain is an impulse train: you hear discrete events, not a tone.
 *   2. Half-order lope. One oscillator at crank rate rather than firing rate,
 *      odd-weighted, so the four pulses in a cycle are not identical. That
 *      unevenness is most of what makes an idle sound mechanical.
 *   3. A brassy layer that grows with LOAD, not rpm. Forty partials with a
 *      shallow rolloff, detuned a few cents against the body layer so the two
 *      beat against each other instead of sitting perfectly in tune.
 *   4. Saturation. The summed layers run into a tanh whose drive rises with
 *      load, which generates new harmonics exactly when the engine is working
 *      — brighter under throttle rather than merely louder, and the reason
 *      overrun sounds different from acceleration at the same rpm.
 *   5. Exhaust noise amplitude-modulated by the firing oscillator, so the
 *      broadband roar chuffs in time with the cylinders rather than sitting
 *      underneath as a static hiss.
 *
 * Every node here is built once. update() only writes AudioParams.
 */
import { clamp, lerp, approach, smoothstep } from '../core/util.js';
import { rng, rand } from '../core/rng.js';
import { noiseSource, saturationCurve, harmonicWave } from './noise.js';

const REV_MAX = 7400;            // matches car/physics.js, for rpm → Hz
const REV_IDLE = 1050;
const FIRINGS_PER_REV = 2;       // four cylinders, four stroke
const TAU = 0.03;                // parameter smoothing, seconds

export class EngineVoice {
  constructor(ctx, dest, buffers, seed = 91) {
    this.ctx = ctx;
    this.rand = rand(rng(seed));
    this.nodes = [];
    this.sources = [];

    const node = (n) => { this.nodes.push(n); return n; };

    this.out = node(ctx.createGain());
    this.out.gain.value = 0.0001;
    this.out.connect(dest);

    /* Tone stack ------------------------------------------------------- */
    this.drive = node(ctx.createGain());
    this.drive.gain.value = 1;

    const shaper = node(ctx.createWaveShaper());
    shaper.curve = saturationCurve(2.4);
    shaper.oversample = '2x';

    /* Saturating an asymmetric pulse train leaves a DC step that moves with
       load. It is inaudible on its own and it eats headroom on the master bus
       for the whole run, so it comes off here rather than being compressed. */
    const dcBlock = node(ctx.createBiquadFilter());
    dcBlock.type = 'highpass';
    dcBlock.frequency.value = 28;
    dcBlock.Q.value = 0.5;

    this.tone = node(ctx.createBiquadFilter());
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 500;
    this.tone.Q.value = 0.9;

    /* A resonant peak an octave or so above the firing rate is the exhaust
       pipe's own note. Tracking it with rpm is what gives the sweep a formant
       rather than a flat transposition. */
    this.formant = node(ctx.createBiquadFilter());
    this.formant.type = 'peaking';
    this.formant.frequency.value = 260;
    this.formant.Q.value = 1.6;
    this.formant.gain.value = 6;

    /* A second, higher formant, and the reason the engine had no bark.
     *
     * One resonance an octave over the firing rate gives the low end a note.
     * What it cannot give is the hard midrange edge — the 800 Hz to 2 kHz
     * region where a small engine at full throttle actually lives, and where a
     * mix full of tyre noise and wind either leaves room for the car or does
     * not. Without something occupying that band the engine can be measurably
     * loud and still sit behind everything else, which is exactly what
     * "sounds like a buzz" means: plenty of level, no presence. Tied to load
     * rather than to rpm, so it appears when the throttle is open and gets out
     * of the way on a trailing throttle. */
    this.formant2 = node(ctx.createBiquadFilter());
    this.formant2.type = 'peaking';
    this.formant2.frequency.value = 1100;
    this.formant2.Q.value = 1.1;
    this.formant2.gain.value = 0;

    this.drive.connect(shaper);
    shaper.connect(dcBlock);
    dcBlock.connect(this.tone);
    this.tone.connect(this.formant);
    this.formant.connect(this.formant2);
    this.formant2.connect(this.out);

    /* Oscillator layers ------------------------------------------------ */
    const layer = (wave, gain) => {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      const g = node(ctx.createGain());
      g.gain.value = gain;
      osc.connect(g);
      g.connect(this.drive);
      osc.start(0);
      this.sources.push(osc);
      return { osc, g };
    };

    this.pulse = layer(harmonicWave(ctx, seed + 1, 26, 0.55, { spread: 0.30 }), 0.5);
    this.lope = layer(harmonicWave(ctx, seed + 2, 12, 1.25, { spread: 1.1, evenCut: 0.5 }), 0.4);
    this.body = layer(harmonicWave(ctx, seed + 3, 18, 0.95, { spread: 1.7 }), 0.35);
    this.growl = layer(harmonicWave(ctx, seed + 4, 40, 0.40, { spread: 2.4 }), 0.05);
    this.growl.osc.detune.value = 9;
    this.body.osc.detune.value = -5;

    /* Exhaust: broadband, chuffed by the firing oscillator ------------- */
    this.exhaustBand = node(ctx.createBiquadFilter());
    this.exhaustBand.type = 'bandpass';
    this.exhaustBand.frequency.value = 180;
    this.exhaustBand.Q.value = 0.8;

    this.chuff = node(ctx.createGain());
    this.chuff.gain.value = 0.45;
    const chuffDepth = node(ctx.createGain());
    chuffDepth.gain.value = 0.40;
    this.pulse.osc.connect(chuffDepth);
    chuffDepth.connect(this.chuff.gain);

    this.exhaust = node(ctx.createGain());
    this.exhaust.gain.value = 0.2;
    this.sources.push(noiseSource(ctx, buffers.white, this.chuff, { offset: 0.11 }));
    this.chuff.connect(this.exhaustBand);
    this.exhaustBand.connect(this.exhaust);
    // Into the drive stage, so the roar saturates along with the tone.
    this.exhaust.connect(this.drive);

    /* Induction: the airbox, heard only when the throttle is open -------- */
    this.inductionHi = node(ctx.createBiquadFilter());
    this.inductionHi.type = 'highpass';
    this.inductionHi.frequency.value = 500;
    this.inductionLo = node(ctx.createBiquadFilter());
    this.inductionLo.type = 'lowpass';
    this.inductionLo.frequency.value = 2200;
    this.induction = node(ctx.createGain());
    this.induction.gain.value = 0.0001;
    this.sources.push(noiseSource(ctx, buffers.white, this.inductionHi, { rate: 0.93, offset: 0.53 }));
    this.inductionHi.connect(this.inductionLo);
    this.inductionLo.connect(this.induction);
    // Post-saturation: intake roar is air, not combustion, and squashing it
    // with the tone just makes the top end sound thin.
    this.induction.connect(this.out);

    /* Overrun: closed throttle at revs, gated hard and irregularly ------ */
    this.overrunBand = node(ctx.createBiquadFilter());
    this.overrunBand.type = 'bandpass';
    this.overrunBand.frequency.value = 1300;
    this.overrunBand.Q.value = 2.2;
    this.overrun = node(ctx.createGain());
    this.overrun.gain.value = 0.0001;
    this.sources.push(noiseSource(ctx, buffers.white, this.overrunBand, { rate: 1.07, offset: 0.77 }));
    this.overrunBand.connect(this.overrun);
    this.overrun.connect(this.out);

    /* The gearchange.
     *
     * A dip in level and a bend in pitch is a gearchange described rather than
     * heard. What is missing is the event: a real upshift closes the throttle
     * for a tenth of a second and the pressure that was going through the
     * engine has to go somewhere, so it barks out of the exhaust. That bark is
     * broadband and brief, and it is the whole reason a gearchange registers
     * as something that happened rather than as the note stepping.
     *
     * One-shot, so unlike everything else in this file it allocates — but a
     * gearchange happens a handful of times a lap, not sixty times a second,
     * and the filter it runs into is permanent. */
    this.buf = buffers.white;
    this.barkBand = node(ctx.createBiquadFilter());
    this.barkBand.type = 'bandpass';
    this.barkBand.frequency.value = 420;
    /* Wide. A narrow band on a noise burst is a hi-hat; the thing being
       modelled is a slug of gas leaving a pipe, which is broadband with a
       low-mid emphasis, and the emphasis is all the band should supply. */
    this.barkBand.Q.value = 0.55;
    /* Its own gain on the way into the output, purely so the harness has
       something to solo. A gearchange is a brief broadband event underneath a
       loud harmonic one, which means it barely moves the peak or the RMS of
       any window long enough to be worth measuring — measured on the engine
       bus it is invisible, and a sound that cannot be measured is a sound
       nobody will notice has broken. */
    this.barkOut = node(ctx.createGain());
    this.barkOut.gain.value = 1;
    this.barkBand.connect(this.barkOut);
    this.barkOut.connect(this.out);

    /* Smoothed state, so a frame-rate spike cannot step a parameter. */
    this.load = 0;
    this.jitter = 0;
    this.shift = 0;
    this.shiftDir = 1;
    this.gear = null;
    this.crackle = 0;
  }

  /**
   * @param {number} dt
   * @param {number} rpm normalised 0..1
   * @param {number} throttle 0..1
   * @param {number} brake 0..1
   * @param {number} gear
   * @param {number} t when, on the engine's clock
   */
  update(dt, rpm, throttle, brake, gear, t) {
    const ctx = this.ctx;
    const r = this.rand;

    if (this.gear !== null && gear !== this.gear) {
      this.shift = 1;
      this.shiftDir = gear > this.gear ? 1 : -1;
      this.bark(t, rpm, throttle, this.shiftDir);
    }
    this.gear = gear;
    this.shift = approach(this.shift, 0, 11, dt);

    /* Load is not throttle. It is throttle filtered by how hard the engine is
       having to push, which is why the same pedal at 2000 rpm and at 6500 rpm
       does not sound the same. Brake folds in as negative load so a trailing
       throttle into a corner goes soft rather than staying brassy. */
    const want = clamp(throttle * lerp(1.0, 0.72, rpm) - brake * 0.25, 0, 1);
    this.load = approach(this.load, want, 7, dt);
    const load = this.load;
    const overrun = (1 - throttle) * smoothstep(0.22, 0.55, rpm) * (1 - this.shift);

    /* Frequency. A random walk rather than a fresh random per frame: white
       noise on a pitch parameter sounds like a fault, a slow wander sounds
       like a machine with reciprocating mass in it. Deeper at idle, where a
       real engine hunts, and shallow at the limiter where it does not. */
    this.jitter = approach(this.jitter, r.f(-1, 1), 9, dt);
    const wobble = 1 + this.jitter * lerp(0.014, 0.0025, smoothstep(0.15, 0.6, rpm)) * (1 + load * 0.5);

    /* The shift dip. An upshift drops the revs; a downshift blips them up.
       Both are brief enough to read as a gearchange rather than as a stall. */
    const shiftBend = 1 - this.shiftDir * this.shift * 0.11;

    const revs = Math.max(rpm, REV_IDLE / REV_MAX) * REV_MAX;
    const crank = (revs / 60) * wobble * shiftBend;
    const fire = crank * FIRINGS_PER_REV;

    const set = (p, v, tau = TAU) => p.setTargetAtTime(v, t, tau);

    set(this.pulse.osc.frequency, fire, 0.012);
    set(this.body.osc.frequency, fire, 0.012);
    set(this.growl.osc.frequency, fire, 0.012);
    set(this.lope.osc.frequency, crank, 0.012);

    /* The lope is the whole character at idle and turns to mush above about
       half revs, where the firings blur into a tone anyway. */
    set(this.lope.g.gain, 0.42 * lerp(1, 0.12, smoothstep(0.14, 0.55, rpm)));
    set(this.pulse.g.gain, 0.52 * lerp(1, 0.68, rpm) * lerp(0.85, 1.1, load));
    set(this.body.g.gain, 0.30 + 0.14 * rpm);
    set(this.growl.g.gain, 0.04 + 0.52 * load * lerp(0.30, 1.0, rpm));

    /* The throttle-cut goes on the drive stage rather than on the output.
       Both make the engine quieter for a moment; only this one also makes it
       duller, because less through the saturator is less distortion, which is
       what a closed throttle actually does. It also leaves the bark alone —
       the bark joins the signal after this stage, so the tone drops out from
       under it and the exhaust event is left exposed, which is the whole
       reason a gearchange is audible from outside a car. */
    set(this.drive.gain,
      lerp(1.05, 3.4, load) * lerp(0.9, 1.25, rpm) * (1 - 0.42 * this.shift));

    /* Brightness. Three terms, and they are separable on purpose: the engine
       has to get brighter with rpm (pulses arrive faster), brighter with load
       (harder combustion), and it must not do either when it is coasting. */
    set(this.tone.frequency, clamp(340 + fire * 4.2 + load * 3400 + rpm * 2400, 200, 14000), 0.05);
    set(this.formant.frequency, clamp(fire * 2.6 + 140, 80, 5000), 0.05);
    set(this.formant.gain, 3 + load * 5);
    /* Rides up with revs but stays inside the presence band at both ends, and
       lifts hard with load — this is the bark, and it has to be absent when
       the car is coasting or every corner entry sounds like a downshift. */
    set(this.formant2.frequency, clamp(760 + fire * 3.4 + load * 600, 500, 3600), 0.05);
    set(this.formant2.gain, 1.5 + load * 7.5 * lerp(0.55, 1, rpm));

    set(this.exhaustBand.frequency, clamp(95 + fire * 1.7 + load * 420, 60, 6000), 0.05);
    set(this.exhaust.gain, 0.14 + 0.34 * load + 0.10 * rpm);

    set(this.inductionHi.frequency, 380 + rpm * 900, 0.05);
    set(this.inductionLo.frequency, 1400 + rpm * 4200 + load * 1800, 0.05);
    set(this.induction.gain, 0.0001 + 0.085 * throttle * lerp(0.25, 1, rpm));

    /* Overrun crackle. The gate is a held random value rather than a smooth
       envelope because the real thing is discrete — unburnt fuel lighting in
       the pipe, a few times a second, not a swell. */
    this.crackle = approach(this.crackle, r.chance(0.22) ? r.f(0.4, 1) : 0.05, 24, dt);
    set(this.overrunBand.frequency, 700 + rpm * 1800 + this.crackle * 900, 0.02);
    set(this.overrun.gain, 0.0001 + 0.075 * overrun * this.crackle, 0.015);

    const level = (0.20 + 0.20 * load + 0.13 * rpm) * (1 - 0.18 * this.shift);
    set(this.out.gain, level, 0.02);
  }

  /**
   * The exhaust bark on a gearchange.
   *
   * An upshift is a chuff: the throttle shuts, the pressure dumps, and it is
   * dull and short. A downshift is the opposite event — the throttle blips and
   * the revs come up to meet the lower gear — so it is brighter, longer and
   * has a rising edge on it. Same two nodes either way; the difference is
   * entirely in the numbers, which is the honest way to model it because the
   * difference in the real thing is entirely in the airflow.
   *
   * @param {number} t
   * @param {number} rpm 0..1
   * @param {number} throttle 0..1
   * @param {number} dir +1 up, -1 down
   */
  bark(t, rpm, throttle, dir) {
    const ctx = this.ctx;
    const r = this.rand;
    const up = dir > 0;
    /* A shift at idle off the throttle should be near silent. There is no
       pressure in the system to release, and barking anyway is how a car ends
       up sounding like it is fighting itself in the pit lane. */
    const level = (0.14 + 0.62 * this.load + 0.26 * rpm) * lerp(0.3, 1, throttle);
    if (level < 0.03) return;

    const dur = up ? 0.085 : 0.16;
    const src = ctx.createBufferSource();
    src.buffer = this.buf;
    /* Resampling the noise is the cheapest tone control there is: played slow
       the whole burst moves down, which is most of the difference between a
       chuff and a bark before the filter does anything. */
    src.playbackRate.value = up ? 0.7 : 1.35;
    const g = ctx.createGain();
    /* Zero before scheduling — a GainNode starts at 1, and a buffer source
       that begins sample-accurately can beat the first automation event to
       the output by a sample. See the same note in impact.js. */
    g.gain.value = 0;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(level * (up ? 2.4 : 1.9), t + (up ? 0.004 : 0.03));
    g.gain.exponentialRampToValueAtTime(0.0006, t + dur);
    src.connect(g);
    g.connect(this.barkBand);
    src.start(t, r.f(0, this.buf.duration - dur * 1.5 - 0.01));
    src.stop(t + dur + 0.02);
    src.onended = () => { src.disconnect(); g.disconnect(); };

    /* The band sweeps with the burst rather than sitting still: a fixed-band
       noise burst is a hi-hat, a sweeping one is gas moving through a pipe. */
    const f0 = clamp(220 + rpm * 900, 200, 2400);
    this.barkBand.frequency.cancelScheduledValues(t);
    this.barkBand.frequency.setValueAtTime(up ? f0 * 0.75 : f0 * 0.95, t);
    this.barkBand.frequency.exponentialRampToValueAtTime(
      up ? f0 * 0.40 : f0 * 2.3, t + dur);
  }

  dispose() {
    for (const s of this.sources) { try { s.stop(); } catch (_) {} }
    for (const n of this.nodes) n.disconnect();
    for (const s of this.sources) s.disconnect();
  }
}
