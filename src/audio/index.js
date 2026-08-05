/* REDROCK — sound.
 *
 * Zero assets, like everything else here: no files, no samples, no encoded
 * blobs. Every sound is built at runtime out of oscillators, Float32Arrays of
 * seeded noise, biquads and envelopes. See engine.js for the interesting part.
 *
 * The whole engine is one object with a five-call surface, and it is
 * deliberately ignorant of the game — it takes a plain state struct once per
 * frame and never touches the car, the track or the renderer:
 *
 *   const audio = new Audio();
 *   addEventListener('pointerdown', () => audio.start(), { once: true });
 *   // per frame:
 *   audio.update(dt, { speed, rpm, gear, throttle, brake, handbrake,
 *                      slipAngle, wheelSlip, offRoad, airborne,
 *                      landingForce, shoreDistance, shoreDrop, oceanSide,
 *                      openness });
 *   audio.impact(strength);
 *   audio.startTone(isGo);            // one start light, count or release
 *   audio.finishTone(kind, win);      // 'flag' at the line, 'card' after it
 *   audio.positionTone(direction);     // 'gained' or 'lost'
 *   audio.boostTone(rpm);              // pad ignition; boostTimer sustains it
 *
 * Every field is optional and the second line is the newer half:
 *
 *   landingForce   0..1, how hard the suspension took the landing. Read only
 *                  on the frame `airborne` goes false.
 *   shoreDistance  metres from the car to the waterline, horizontally.
 *   shoreDrop      metres the road sits above the water.
 *   oceanSide      -1 water to the left, +1 to the right, 0 unknown. Car
 *                  relative, so it flips when the road doubles back.
 *   openness       0..1, exposed headland to sheltered cutting. Optional even
 *                  among the optional ones — it is derived from the shore
 *                  distance if absent.
 *   boostTimer     seconds of boost-pad force left. Drives a second motor for
 *                  the same 1.2 seconds as the physics.
 *
 * The shore fields are latched: pass them when you have them and omit them
 * when you do not, and the last known value is held rather than snapping back
 * to a default.
 *
 * Two rules run through the implementation. Nothing is allocated per frame —
 * every source and filter is built once in start() and update() only writes
 * AudioParams, because churning nodes at 60 Hz is the standard way to make
 * Web Audio glitch. And every parameter write goes through setTargetAtTime
 * rather than assigning .value, because a parameter stepped once per frame is
 * a 60 Hz square wave riding on the signal, which is audible as a buzz long
 * before anyone works out where it came from.
 */
import { clamp, lerp, approach, smoothstep } from '../core/util.js';
import { noiseBuffer, saturationCurve, impulseResponse } from './noise.js';
import { EngineVoice } from './engine.js';
import { SurfaceVoices } from './surface.js';
import { Impacts } from './impact.js';
import { Ambience } from './ambience.js';
import { StartTones } from './start.js';
import { FinishTones } from './finish.js';
import { FeedbackVoices } from './feedback.js';

const SEED = 4711;

export class Audio {
  /**
   * No AudioContext is created here. Constructing one before a user gesture
   * gets it born suspended in every browser that matters, and a suspended
   * context that nobody resumes is indistinguishable from a broken one.
   *
   * @param {{context?:BaseAudioContext, volume?:number, seed?:number}} opts
   *   `context` is for the offline harness — pass an OfflineAudioContext and
   *   the whole engine renders deterministically off a virtual clock instead
   *   of wall time. Nothing in the game passes it.
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.ctx = null;
    this.offline = false;
    this.running = false;
    this.now = 0;
    this.volume = clamp(opts.volume ?? 0.5, 0, 1);
    this.seed = opts.seed ?? SEED;
    this._starting = null;
    this._ownsContext = false;
    this._airborne = false;
    this._duck = 0;
    this._speed = 0;
    /* Defaults chosen so the game sounds like a coast road before anything is
       wired: a road forty metres above the water with the sea somewhere off to
       the left is the setting, and a state struct that omits the new fields
       should get the setting rather than get silence. */
    this._shore = { distance: 70, drop: 40, side: -1 };
  }

  /** Create and resume the context, building the graph on first call. Safe to
      call every gesture; later calls only resume. */
  async start() {
    if (this._starting) return this._starting;
    this._starting = (async () => {
      if (!this.ctx) {
        const Ctor = this.opts.context ? null
          : (globalThis.AudioContext || globalThis.webkitAudioContext);
        if (!this.opts.context && !Ctor) return null;
        const ctx = this.opts.context || new Ctor({ latencyHint: 'interactive' });
        this.ctx = ctx;
        this.offline = typeof ctx.startRendering === 'function';
        this.now = this.offline ? 0 : ctx.currentTime;
        this._ownsContext = !this.opts.context;
        this._build(ctx);
      }
      if (!this.offline && this.ctx.state !== 'running') {
        await this.ctx.resume().catch(() => {});
      }
      this.running = true;
      return this.ctx;
    })();
    /* Cleared rather than cached, so a start() that failed because the gesture
       was not trusted can be retried by the next one. */
    const ctx = await this._starting;
    this._starting = null;
    return ctx;
  }

  _build(ctx) {
    const buffers = {
      white: noiseBuffer(ctx, 2.0, this.seed),
      pink: noiseBuffer(ctx, 2.0, this.seed + 17, { pink: true }),
    };
    this.buffers = buffers;

    /* Master chain, output end first.
     *
     * The soft clipper is last, and that ordering is the fix for a bug the
     * old chain had in writing: the comment said tanh is bounded so the
     * samples reaching the device cannot leave ±1, and then put the volume
     * fader after it. Everything above the limiter was multiplied by the
     * slider, so the guarantee held only at the volume the tests happened to
     * measure at. Dragged to the top, full throttle in first gear left the
     * device at 1.5 and a couple of thousand clipped samples a second.
     *
     * Now: compressor for the level of the continuous layers, high-pass to
     * throw away what cannot be reproduced, the fader, and then the clipper as
     * the last thing in the graph — which is the only position from which it
     * can promise anything. Turning the volume up now costs saturation rather
     * than fracture, which is the trade a loud setting should make. */
    this.limiter = ctx.createWaveShaper();
    /* Gentle. The old curve had a small-signal gain of 1.54 — a tanh
       normalised to reach 1 at 1 is not a limiter, it is 3.8 dB of makeup with
       a ceiling on it, and that gain was a large part of why there was no
       headroom left to give an impact. At this drive the curve is within 5% of
       a straight line for most of its travel and only bends near the rails. */
    /* The ceiling is not 1, and it needs to be a little under.
       A WaveShaper's output is bounded by its curve, but the resampling either
       side of an oversampled one is not: those filters ring, and the ring puts
       a percent or so back on top of whatever the curve produced. Measured at
       full volume it was enough to push the last stage in the graph past ±1,
       which is the one thing this stage exists to prevent. */
    this.limiter.curve = saturationCurve(0.9, { ceiling: 0.96 });
    /* 2x rather than 4x: the extra oversampling buys very little on a curve
       this gentle, and Chromium's resampling filters ring, which puts back
       some of the overshoot the stage exists to remove. */
    this.limiter.oversample = '2x';
    this.limiter.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.limiter);

    /* Rumble the speakers cannot reproduce still costs headroom, and the
       saturator below turns any of it into intermodulation across the whole
       spectrum. Cheaper to remove it than to compress it — and it belongs
       ahead of the saturator, not behind it, or the intermodulation has
       already happened by the time it is filtered. */
    this.dcBlock = ctx.createBiquadFilter();
    this.dcBlock.type = 'highpass';
    this.dcBlock.frequency.value = 24;
    this.dcBlock.Q.value = 0.6;
    this.dcBlock.connect(this.master);

    /* Gentler and slower than it was, and the two changes are the same change.
     *
     * A 4 ms attack at 6:1 does not compress a mix, it removes transients from
     * it: the engine bed sits above the threshold continuously, so the
     * compressor is always working, and anything with an edge on it gets a
     * sixth of its overshoot within four milliseconds of arriving. An impact
     * measured +0.4 dB above the bed it landed on — audible as a change in
     * texture and not at all as a hit.
     *
     * Backing the ratio off and letting the attack through means transients
     * reach the limiter instead, which is the right division of labour: the
     * compressor holds the level of the continuous layers, the tanh above
     * catches whatever spikes past it, and a collision is allowed to be
     * momentarily louder than the car. */
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -12;
    this.comp.knee.value = 10;
    this.comp.ratio.value = 4;
    this.comp.attack.value = 0.012;
    this.comp.release.value = 0.24;
    this.comp.connect(this.dcBlock);

    /* Everything sums here before the compressor, and it exists so an impact
       has something to duck. See _sidechain below. */
    this.duck = ctx.createGain();
    this.duck.gain.value = 1;
    this.duck.connect(this.comp);

    /* These three add up to a little over unity on purpose. The soft clipper
       below no longer has the 3.8 dB of small-signal makeup its old curve was
       smuggling in, so the level it used to add has to be put back somewhere
       honest — here, ahead of the compressor, where it is visible and where
       the balance between the car, the world and the hits can be set. */
    this.bus = ctx.createGain();
    this.bus.gain.value = 1.15;
    this.bus.connect(this.duck);

    /* The car and the world are separate buses, and not for tidiness. The
       reverb below is the sound of the cliff reflecting the car, which is a
       thing that happens to the car; the ocean is already several hundred
       metres of air away and arrives diffuse. Sending the surf to the same
       convolver smears a wash into a wider wash and costs a surprising amount
       of clarity in the low mids for no gain at all. */
    this.amb = ctx.createGain();
    this.amb.gain.value = 1.05;
    this.amb.connect(this.duck);

    /* Impacts join downstream of the duck.
     *
     * This is the whole reason the duck exists and it took a measurement to
     * notice it was wrong: with the hits on the ducked bus, an impact opened a
     * hole and then fell into it, so the loudest collision in the game arrived
     * a fraction of a decibel above the engine. Split out, the dip applies to
     * everything the impact has to be heard over and to nothing else. */
    this.hits = ctx.createGain();
    this.hits.gain.value = 1.3;
    this.hits.connect(this.comp);

    /* A short procedural coast tail. Not reverb for its own sake: without any
       early reflection the car sounds like it is in an anechoic chamber, and
       the stage is a road cut into a cliff with open water on the other side.
       Kept dry enough to be felt and not heard. */
    this.verb = ctx.createConvolver();
    /* Normalisation off, and this is not a preference.
     *
     * A ConvolverNode normalises by default: it scales the response so that
     * convolving with it does not change perceived loudness, and the scale it
     * computes is inversely related to the response's total energy. That is a
     * sensible default for a recorded hall and actively dangerous for a
     * procedural response, because the scale is a function of how the response
     * was generated. Shortening this one from a dense canyon tail to a sparse
     * coastal one cut its energy by most of an order of magnitude, and the
     * normaliser handed all of it back as gain — the isolated cliff slap came
     * out four times louder than the sound that caused it, arriving as a
     * bright click a few milliseconds behind every transient in the game.
     *
     * With it off — and the buffer scaled to unit energy by its builder — the
     * wet gain below means a fixed thing that does not move when the shape of
     * the space is edited. */
    this.verb.normalize = false;
    this.verb.buffer = impulseResponse(ctx, 0.34, this.seed + 33, 6.5, { slapSide: -1 });
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.30;
    this.verb.connect(this.wet);

    /* Which side the rock is on.
     *
     * The response has a hard early reflection skewed into one channel,
     * because a road cut into a cliff has exactly one thing to reflect off and
     * it is beside you rather than in front. Which side that is depends on
     * which way the road is running, and it is the opposite side from the
     * water — so it has to follow `oceanSide` rather than be baked in. Left
     * unwired, the first version had the cliff and the ocean both to port,
     * which sounds like a corridor.
     *
     * A convolver's buffer cannot be swapped per frame without a glitch, so
     * the image is crossfaded downstream instead: at w=0 the channels pass
     * through, at w=1 they are exchanged, and at the halfway point the tail is
     * momentarily centred — which is exactly what should happen as the road
     * turns through the corner where the water changes sides. */
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    this.wet.connect(split);
    this.wetThru = [ctx.createGain(), ctx.createGain()];
    this.wetSwap = [ctx.createGain(), ctx.createGain()];
    for (let ch = 0; ch < 2; ch++) {
      this.wetThru[ch].gain.value = 1;
      this.wetSwap[ch].gain.value = 0;
      split.connect(this.wetThru[ch], ch);
      split.connect(this.wetSwap[ch], ch);
      this.wetThru[ch].connect(merge, 0, ch);
      this.wetSwap[ch].connect(merge, 0, 1 - ch);
    }
    merge.connect(this.dcBlock);
    this.wetNet = [split, merge];

    this.send = ctx.createGain();
    this.send.gain.value = 0.5;
    this.send.connect(this.verb);
    this.bus.connect(this.send);
    /* Hits go to the cliff too — arguably more than anything else does, since
       a bang is the one signal short enough for a discrete reflection to be
       heard as a reflection rather than as a thickening. */
    this.hits.connect(this.send);

    this.engine = new EngineVoice(ctx, this.bus, buffers, this.seed + 91);
    this.surface = new SurfaceVoices(ctx, this.bus, buffers, this.seed + 404);
    this.impacts = new Impacts(ctx, this.hits, buffers, this.seed + 7331);
    this.ambience = new Ambience(ctx, this.amb, buffers, this.seed + 8123);
    /* On the impact bus, not the car bus, and for the same reason the impacts
       are: it is downstream of the duck, so the one signal in the game that
       must be heard over a revving engine is not itself pulled down by
       whatever ducks the engine. It shares the impacts' send to the cliff,
       which is free and correct — a marshal's tone in a rock cutting comes
       back off the wall a beat later. */
    this.startTones = new StartTones(ctx, this.hits);
    /* Same bus and the same argument: it is downstream of the duck, so the
       one signal that has to be heard over whatever else is playing is not
       itself pulled down by the dip it asks for, and it shares the impacts'
       send to the cliff — a chord let off in a rock cutting comes back off
       the wall a beat later, which is most of why the flag sounds like it
       happened somewhere. */
    this.finishTones = new FinishTones(ctx, this.hits);
    /* Rank punctuation shares the one-shot bus; the pad's sustained second
       motor joins the car bus instead. feedback.js owns why the split matters. */
    this.feedback = new FeedbackVoices(ctx, this.bus, this.hits, buffers, this.seed + 1207);

    /* Sidechain.
     *
     * An impact competes with a full-throttle engine for the same two hundred
     * hertz of spectrum, and the engine is continuous while the impact is
     * fifty milliseconds long — so on level alone the engine wins and the hit
     * reads as a bump in an already loud noise. Raising the impact until it
     * cuts through only moves the problem to the limiter.
     *
     * So the bus gets out of the way instead. The dip is scheduled rather than
     * envelope-followed because we know exactly when the hit is coming: we are
     * the ones scheduling it. Down fast enough to open the hole before the
     * transient arrives, back up slowly enough that the recovery is not itself
     * an event.
     *
     * Depth scales with the hit rather than being fixed, because a kerb
     * scrape that ducked the car as hard as a head-on would read as the mix
     * flinching. */
    this.impacts.onFire = (t, s) => {
      const depth = 1 - 0.5 * s;
      const g = this.duck.gain;
      /* cancelAndHoldAtTime, where it exists, is the only way to interrupt a
         running ramp without the parameter jumping back to whatever value was
         last set — which, with hits landing on top of each other, is an
         audible click on the second one. */
      if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
      else { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); }
      g.linearRampToValueAtTime(depth, t + 0.012);
      g.setTargetAtTime(1, t + 0.05, lerp(0.06, 0.16, s));
    };
  }

  /** Suspend. Cheap to reverse — start() picks the same graph back up. */
  stop() {
    this.running = false;
    if (this.ctx && !this.offline) this.ctx.suspend().catch(() => {});
  }

  setMasterVolume(v) {
    this.volume = clamp(v, 0, 1);
    if (this.master) this.master.gain.setTargetAtTime(this.volume, this.now, 0.03);
  }

  /**
   * One frame of the game's state, mapped onto the synthesis.
   * @param {number} dt seconds
   * @param {object} state see the header — every field optional
   */
  update(dt, state) {
    if (!this.ctx || !state) return;
    const step = clamp(dt || 0, 1 / 480, 0.1);

    /* Offline renders run on a virtual clock: currentTime does not advance
       until startRendering(), so everything would be scheduled at zero and
       arrive as one instantaneous smear. Live, the context's own clock is the
       only one that stays in step with the audio thread. */
    this.now = this.offline ? this.now + step : this.ctx.currentTime;
    const t = this.now;

    const speed = Math.max(0, state.speed || 0);
    const throttle = clamp(state.throttle || 0, 0, 1);
    const brake = clamp(state.brake || 0, 0, 1);
    const handbrake = clamp(state.handbrake || 0, 0, 1);
    const airborne = !!state.airborne;
    /* Tolerates being handed raw engine rpm instead of the 0..1 the docs ask
       for. Getting this wrong is silent — the engine simply sits on the
       limiter forever — and it is an easy wire-up mistake to make. */
    const rpmIn = state.rpm || 0;
    const rpm = clamp(rpmIn > 1.5 ? rpmIn / 7400 : rpmIn, 0, 1);

    const s = {
      speed,
      wheelSlip: clamp(Math.max(state.wheelSlip || 0, handbrake * 0.55), 0, 1),
      slipAngle: state.slipAngle || 0,
      offRoad: clamp(state.offRoad || 0, 0, 1),
      airborne,
    };

    /* Wheels off the ground make no noise, and the sudden absence of the tyre
       and gravel layers is most of what sells a jump. Ramped rather than
       gated, or a car skimming a crest strobes the mix. */
    this._duck = approach(this._duck, airborne ? 1 : 0, airborne ? 14 : 9, step);

    this.engine.update(step, rpm, throttle, brake, state.gear | 0, t);
    this.feedback.update(step, rpm, state.boostTimer || 0, t);
    this.surface.update(step, s, this._duck, t);

    /* Where the water is.
     *
     * Sticky rather than defaulted per frame: a game loop that supplies these
     * on some frames and not others — because the track query failed, because
     * the car is between segments — would otherwise teleport the ocean to the
     * default distance and back, and a surf bed that jumps in level is far
     * more conspicuous than one that is slightly wrong. */
    const sh = this._shore;
    if (state.shoreDistance != null) sh.distance = Math.max(0, state.shoreDistance);
    if (state.shoreDrop != null) sh.drop = Math.max(0, state.shoreDrop);
    if (state.oceanSide != null) sh.side = clamp(state.oceanSide, -1, 1);

    this.ambience.update(step, {
      speed,
      airborne,
      shoreDistance: sh.distance,
      shoreDrop: sh.drop,
      oceanSide: sh.side,
      openness: state.openness,
    }, t);

    /* Landing.
     *
     * `landingForce` is what the physics knows and the audio cannot work out:
     * how hard the suspension was asked to absorb, which is vertical velocity
     * against travel, not horizontal speed. Given it, the difference between
     * clipping a crest and coming off a jump is the difference it should be.
     *
     * Without it we fall back to the old horizontal-speed guess, which is
     * wrong in the specific way that a fast, flat landing sounds heavy and a
     * slow drop off a bank sounds like nothing. Keeping the fallback means the
     * field can be wired whenever it suits and nothing breaks in the meantime.
     *
     * Tone stays right down either way: a suspension bottoming out is a dull
     * thump, and the same sound with a click on the front of it reads as
     * hitting a wall. */
    if (this._airborne && !airborne) {
      const f = state.landingForce;
      /* Expanded rather than mapped straight through. A suspension is a
         spring and a damper, so the noise it makes rises faster than the
         velocity that caused it; a linear map spends most of its range making
         gentle landings audible and leaves nothing to distinguish a heavy one.
         The 1.5 exponent is what makes force 0.9 feel like an event and force
         0.1 feel like a kerb. */
      const strength = f != null
        ? clamp(0.09 + Math.pow(clamp(f, 0, 1), 1.5) * 0.87, 0, 0.96)
        : clamp(0.22 + this._speed * 0.014, 0, 0.85);
      /* Harder landings are duller, not brighter. A heavy one is all
         suspension and shell; a light one has a bit of tyre slap on the front
         of it, which is the only high end a landing legitimately has. */
      this.impacts.fire(t, strength, lerp(0.28, 0.06, strength));
    }
    this._airborne = airborne;
    this._speed = speed;

    /* Sends more of a loud, bright car to the cliff than a quiet one, which is
       the only cue that says there is rock on one side of the road. */
    this.send.gain.setTargetAtTime(
      0.3 + 0.4 * smoothstep(0, 40, speed) + 0.2 * throttle, t, 0.25);

    /* The rock is opposite the water. Slow, because the only thing that
       changes it is the road turning, and a reverb image that moves faster
       than the geometry does is more distracting than one that lags. */
    const swap = clamp((1 - sh.side) * 0.5, 0, 1);
    for (let ch = 0; ch < 2; ch++) {
      this.wetThru[ch].gain.setTargetAtTime(1 - swap, t, 0.5);
      this.wetSwap[ch].gain.setTargetAtTime(swap, t, 0.5);
    }
  }

  /** One-shot collision. Rate limited internally; safe to call every frame. */
  impact(strength) {
    if (!this.ctx || !this.impacts) return;
    const s = clamp(strength || 0, 0, 1);
    /* Scheduling in the past silently becomes "now" and loses the envelope's
       attack, which is the only part of an impact that carries the hit. Live,
       the clock may have moved since update() read it. */
    const t = this.offline ? this.now : Math.max(this.now, this.ctx.currentTime);
    this.impacts.fire(t, s, lerp(0.6, 1, s));
  }

  /** One start light. `go` is the release; anything else is a count. */
  startTone(go = false) {
    if (!this.ctx || !this.startTones) return;
    // Same clock discipline as impact(): scheduling in the past loses the
    // attack, which on a signal this short is most of the signal.
    const t = this.offline ? this.now : Math.max(this.now, this.ctx.currentTime);
    /* Through the same sidechain an impact uses, and for exactly the argument
       written above it: a start light competes with a full-throttle engine
       for the same spectrum, the engine is continuous and the tone is a third
       of a second, and on level alone the engine wins. Measured against the
       limiter bed (tools/audio.mjs, the 'start lights' scenario) the count
       lifts the mix peak by 0.6 dB on its own and the bus has to get out of
       the way for it to read as a signal rather than as a colour. Shallower
       than a collision: the tone is meant to cut through the car, not to
       flinch the whole mix. */
    if (this.impacts?.onFire) this.impacts.onFire(t, go ? 0.42 : 0.3);
    this.startTones.fire(t, !!go);
  }

  /**
   * The chequered flag, or the card landing on it.
   * @param {'flag'|'card'} kind
   * @param {boolean} win the player came first
   */
  finishTone(kind = 'flag', win = false) {
    if (!this.ctx || !this.finishTones) return;
    const t = this.offline ? this.now : Math.max(this.now, this.ctx.currentTime);
    /* Ducked like the start lights, and shallower than either of them. By
       this point the car is braking and the bus is emptying out on its own,
       so the dip is here to stop the chord's attack fighting whatever tyre
       noise is left rather than to make a hole for it. */
    if (this.impacts?.onFire) this.impacts.onFire(t, kind === 'card' ? 0.22 : 0.34);
    this.finishTones.fire(t, kind, !!win);
  }

  /** A settled change in the player's classification. */
  positionTone(direction = 'gained') {
    if (!this.ctx || !this.feedback
      || (direction !== 'gained' && direction !== 'lost')) return;
    const t = this.offline ? this.now : Math.max(this.now, this.ctx.currentTime);
    /* Reward gets a little more room than information. Both are shallower
       than a collision: the mix acknowledges a rank, it does not flinch. */
    if (this.impacts?.onFire) this.impacts.onFire(t, direction === 'gained' ? 0.30 : 0.17);
    this.feedback.position(t, direction);
  }

  /** The boost-pad ignition. The continuous motor is driven by boostTimer. */
  boostTone(rpm = 0.5) {
    if (!this.ctx || !this.feedback) return;
    const t = this.offline ? this.now : Math.max(this.now, this.ctx.currentTime);
    if (this.impacts?.onFire) this.impacts.onFire(t, 0.20);
    this.feedback.boostStart(t, rpm);
  }

  /**
   * The output gain of each layer, keyed by name.
   *
   * Not for the game. The offline harness solos one layer at a time to measure
   * it, and it cannot do that against the mixed bus: the engine is broadband
   * and drowns every question worth asking about the tyres.
   */
  buses() {
    return {
      engine: this.engine.out,
      /* Downstream of `engine` in the graph, but listed separately: soloing
         one excludes the other, which is what makes the gearchange bark
         measurable at all. */
      shift: this.engine.barkOut,
      /* The panners, not the gains behind them. Soloing by disconnecting the
         node named here and reconnecting it to the bus would otherwise drop
         the panner out of the chain, and the harness would measure a centred
         image for a layer that is not centred at all. */
      tyre: this.surface.tyrePan,
      gravel: this.surface.gravelPan,
      wind: this.surface.wind,
      impact: this.impacts.out,
      surf: this.ambience.surf,
      seaWind: this.ambience.seaWind,
      gull: this.ambience.gull,
      start: this.startTones.out,
      finish: this.finishTones.out,
      boost: this.feedback.boostOut,
      position: this.feedback.positionOut,
    };
  }

  dispose() {
    if (!this.ctx) return;
    this.engine.dispose();
    this.surface.dispose();
    this.impacts.dispose();
    this.ambience.dispose();
    this.startTones.dispose();
    this.finishTones.dispose();
    this.feedback.dispose();
    for (const n of [this.bus, this.amb, this.hits, this.duck, this.send, this.verb,
      this.wet, ...this.wetNet, ...this.wetThru, ...this.wetSwap,
      this.comp, this.limiter, this.dcBlock, this.master]) n.disconnect();
    if (this._ownsContext && this.ctx.close) this.ctx.close().catch(() => {});
    this.ctx = null;
    this.running = false;
  }
}
