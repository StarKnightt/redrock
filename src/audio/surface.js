/* Everything the car makes that is not the engine: tyres, dirt and air.
 *
 * All three are the same construction — one permanently running noise source
 * into a filter into a gain — and all three live or die on their gating rather
 * than on their timbre. A screech that switches on at a slip threshold reads
 * as a bug even when the sample is perfect, because the ear hears the edge and
 * not the sound. So every amount here goes through a smoothstep with a wide
 * band and then through an asymmetric approach: quick to come in, slow to let
 * go, the way a tyre that has started sliding keeps howling for a moment after
 * it hooks up again.
 */
import { clamp, lerp, approach, smoothstep } from '../core/util.js';
import { rng, rand } from '../core/rng.js';
import { noiseSource } from './noise.js';

const TAU = 0.04;

export class SurfaceVoices {
  constructor(ctx, dest, buffers, seed = 404) {
    this.ctx = ctx;
    this.rand = rand(rng(seed));
    this.nodes = [];
    this.sources = [];
    const node = (n) => { this.nodes.push(n); return n; };

    /* Tyres. Two filters in series, not one: the band-pass sets where the
       energy is and the narrow peak on top is the squeal itself. A single
       resonant band-pass either whistles like a test tone at high Q or sounds
       like a hiss at low Q, and a sliding tyre is neither. */
    this.tyreBand = node(ctx.createBiquadFilter());
    this.tyreBand.type = 'bandpass';
    this.tyreBand.frequency.value = 1500;
    this.tyreBand.Q.value = 1.4;

    this.tyrePeak = node(ctx.createBiquadFilter());
    this.tyrePeak.type = 'peaking';
    this.tyrePeak.frequency.value = 2400;
    this.tyrePeak.Q.value = 9;
    this.tyrePeak.gain.value = 14;

    /* A band-pass has 6 dB/octave skirts whatever its Q, and noise above the
       band loses level slower than the band widens — so a band-passed screech
       measures, and sounds, like hiss with a resonance in it. The low-pass on
       the end doubles the slope and puts the energy back where a tyre actually
       squeals, around two to three kilohertz. */
    this.tyreLo = node(ctx.createBiquadFilter());
    this.tyreLo.type = 'lowpass';
    this.tyreLo.frequency.value = 3600;
    this.tyreLo.Q.value = 0.8;

    /* A squealing tyre has more than one mode. The tread blocks and the
       carcass resonate at different frequencies and the pair of them is most
       of what distinguishes a tyre from a kettle: one resonance is a whistle,
       two beating against each other is a squeal. Placed at a deliberately
       inharmonic ratio, because a harmonic pair fuses into a single pitched
       note and undoes the point. */
    this.tyrePeak2 = node(ctx.createBiquadFilter());
    this.tyrePeak2.type = 'peaking';
    this.tyrePeak2.frequency.value = 3900;
    this.tyrePeak2.Q.value = 11;
    this.tyrePeak2.gain.value = 8;

    /* Stick-slip.
     *
     * This is the single thing that decides whether the layer reads as rubber
     * or as a noise generator with a filter on it. A sliding tyre does not
     * slide smoothly: the contact patch grabs, stretches, releases and grabs
     * again, tens to a couple of hundred times a second, and that is an
     * amplitude modulation deep enough to put audible sidebands either side of
     * every resonance. Filtered noise on its own has none of that structure —
     * it is smooth, and smooth is why so much game screech sounds like escaping
     * steam. Modulating with an oscillator rather than a per-frame value keeps
     * it at audio rate, which is the only rate at which it does anything.
     *
     * The gain's intrinsic value is the floor and the oscillator sums on top,
     * so at full depth the layer swings between roughly a quarter and full
     * rather than gating shut. */
    this.tyreAM = node(ctx.createGain());
    this.tyreAM.gain.value = 1;
    this.slipOsc = ctx.createOscillator();
    this.slipOsc.type = 'triangle';
    this.slipOsc.frequency.value = 70;
    this.slipDepth = node(ctx.createGain());
    this.slipDepth.gain.value = 0;
    this.slipOsc.connect(this.slipDepth);
    this.slipDepth.connect(this.tyreAM.gain);
    this.slipOsc.start(0);
    this.sources.push(this.slipOsc);

    this.tyre = node(ctx.createGain());
    this.tyre.gain.value = 0.0001;
    /* Panned, so a car that is sideways puts its howling tyres where they
       are. Panning is applied after the layer gain rather than before, so the
       measurement harness can solo the layer and still see the image. */
    this.tyrePan = node(ctx.createStereoPanner());
    this.sources.push(noiseSource(ctx, buffers.pink, this.tyreBand, { offset: 0.31 }));
    this.tyreBand.connect(this.tyrePeak);
    this.tyrePeak.connect(this.tyrePeak2);
    this.tyrePeak2.connect(this.tyreLo);
    this.tyreLo.connect(this.tyreAM);
    this.tyreAM.connect(this.tyre);
    this.tyre.connect(this.tyrePan);
    this.tyrePan.connect(dest);

    /* Gravel. Pink rather than white: loose stone thrown at an arch has most
       of its energy low, and white noise rolled off sounds like a tape hiss
       gate instead of like rocks. The peak adds the rattle. */
    this.gravelLo = node(ctx.createBiquadFilter());
    this.gravelLo.type = 'lowpass';
    this.gravelLo.frequency.value = 700;
    this.gravelLo.Q.value = 0.9;
    this.gravelPeak = node(ctx.createBiquadFilter());
    this.gravelPeak.type = 'peaking';
    this.gravelPeak.frequency.value = 320;
    this.gravelPeak.Q.value = 1.2;
    this.gravelPeak.gain.value = 7;
    /* Scatter.
     *
     * Low-passed pink noise is a rumble, and a rumble is what dirt under a car
     * sounded like: correct in the spectrum and wrong in the texture, because
     * the actual sound is thousands of discrete stones striking the arch
     * liners. The rate they arrive at is proportional to road speed, which is
     * a real and audible cue — dirt at walking pace and dirt at a hundred are
     * different sounds, not the same sound at two volumes.
     *
     * Same construction as the tyre stick-slip: modulate at audio rate and let
     * the sidebands do the work. It does not need to be fast enough to hear as
     * individual stones, only fast enough to stop the band being smooth. */
    this.gravelAM = node(ctx.createGain());
    this.gravelAM.gain.value = 1;
    this.scatterOsc = ctx.createOscillator();
    this.scatterOsc.type = 'sawtooth';
    this.scatterOsc.frequency.value = 40;
    this.scatterDepth = node(ctx.createGain());
    this.scatterDepth.gain.value = 0;
    this.scatterOsc.connect(this.scatterDepth);
    this.scatterDepth.connect(this.gravelAM.gain);
    this.scatterOsc.start(0);
    this.sources.push(this.scatterOsc);

    this.gravel = node(ctx.createGain());
    this.gravel.gain.value = 0.0001;
    this.gravelPan = node(ctx.createStereoPanner());
    this.sources.push(noiseSource(ctx, buffers.pink, this.gravelLo, { rate: 1.11, offset: 0.63 }));
    this.gravelLo.connect(this.gravelPeak);
    this.gravelPeak.connect(this.gravelAM);
    this.gravelAM.connect(this.gravel);
    this.gravel.connect(this.gravelPan);
    this.gravelPan.connect(dest);

    /* Wind — the car's own, not the weather's; the weather is in ambience.js.
     *
     * Two bands rather than one, and the split is what changed when the game
     * moved from a canyon to a coast. Dry canyon air is thin and whistles: one
     * band-limited hiss with the top rolled off is a fair likeness of it. Sea
     * air is heavy — it is damp and it is moving in bulk — and what you hear
     * from an open car near the water is as much low-frequency buffeting as
     * hiss. So the hiss band stays, narrower and less brittle than it was, and
     * a separate buffet band underneath carries the weight.
     *
     * They are also modulated in opposition. A steady gust makes the buffet
     * swell while the hiss stays put, which is what a gust of onshore wind
     * across a windscreen actually does, and it stops the layer from being a
     * static wall the moment the car holds a constant speed. */
    this.windHi = node(ctx.createBiquadFilter());
    this.windHi.type = 'highpass';
    this.windHi.frequency.value = 240;
    this.windLo = node(ctx.createBiquadFilter());
    this.windLo.type = 'lowpass';
    this.windLo.frequency.value = 900;
    this.windLo.Q.value = 0.6;
    this.hiss = node(ctx.createGain());
    this.hiss.gain.value = 0.62;
    this.sources.push(noiseSource(ctx, buffers.pink, this.windHi, { rate: 0.87, offset: 1.29 }));
    this.windHi.connect(this.windLo);
    this.windLo.connect(this.hiss);

    this.buffetHi = node(ctx.createBiquadFilter());
    this.buffetHi.type = 'highpass';
    this.buffetHi.frequency.value = 55;
    this.buffetLo = node(ctx.createBiquadFilter());
    this.buffetLo.type = 'lowpass';
    this.buffetLo.frequency.value = 210;
    this.buffetLo.Q.value = 1.1;
    this.buffet = node(ctx.createGain());
    this.buffet.gain.value = 0.55;
    this.sources.push(noiseSource(ctx, buffers.pink, this.buffetHi, { rate: 1.03, offset: 0.41 }));
    this.buffetHi.connect(this.buffetLo);
    this.buffetLo.connect(this.buffet);

    /* Gust. Sub-hertz and audio-rate for the same reason the swell in
       ambience.js is: a level nudged once per frame on a signal this broad is
       a staircase, and the ear finds staircases on noise instantly. */
    this.gustOsc = ctx.createOscillator();
    this.gustOsc.frequency.value = 0.23;
    this.gustOsc.start(0);
    this.sources.push(this.gustOsc);
    const gustTo = (param, amt) => {
      const g = node(ctx.createGain());
      g.gain.value = amt;
      this.gustOsc.connect(g);
      g.connect(param);
    };
    gustTo(this.buffet.gain, 0.30);
    gustTo(this.hiss.gain, -0.16);

    this.wind = node(ctx.createGain());
    this.wind.gain.value = 0.0001;
    this.hiss.connect(this.wind);
    this.buffet.connect(this.wind);
    this.wind.connect(dest);

    this.screech = 0;
    this.grit = 0;
    this.chirp = 0;
    this.pan = 0;
  }

  update(dt, s, duck, t) {
    const r = this.rand;
    const set = (p, v, tau = TAU) => p.setTargetAtTime(v, t, tau);

    const rolling = smoothstep(1.5, 9, s.speed);

    /* Slip alone is not enough to howl: the fronts run a few degrees of slip
       through every corner and the tyres are silent. Requiring slip angle as
       well means the screech belongs to the slide rather than to cornering. */
    const angle = smoothstep(0.05, 0.34, Math.abs(s.slipAngle));
    const want = smoothstep(0.20, 0.80, s.wheelSlip)
      * lerp(0.25, 1, angle)
      * rolling
      * lerp(1, 0.35, s.offRoad)       // dirt scrubs quietly; tarmac squeals
      * (1 - duck);
    this.screech = approach(this.screech, want, want > this.screech ? 9 : 3.5, dt);

    /* A sliding tyre does not hold one note — the contact patch stick-slips
       and the pitch wanders with it. Without this the screech is a sine sweep
       with noise on top and sounds exactly like one. */
    this.chirp = approach(this.chirp, r.f(-1, 1), 13, dt);
    const slipPitch = 1150 + s.wheelSlip * 950 + Math.abs(s.slipAngle) * 700 + this.chirp * 130;
    set(this.tyreBand.frequency, clamp(slipPitch, 400, 9000), 0.03);
    set(this.tyrePeak.frequency, clamp(slipPitch * 1.45, 400, 12000), 0.03);
    set(this.tyrePeak2.frequency, clamp(slipPitch * 2.62, 400, 15000), 0.03);
    set(this.tyreLo.frequency, clamp(slipPitch * 2.1, 600, 14000), 0.03);
    set(this.tyrePeak.gain, 8 + this.screech * 9);
    set(this.tyrePeak2.gain, 4 + this.screech * 7);

    /* Stick-slip rate rises with how fast the patch is being dragged, and the
       modulation gets deeper as the slide gets worse: a tyre on the edge of
       grip flutters, a tyre fully alight chatters. Held above 40 Hz so the
       sidebands stay attached to the carrier — slower than that and the ear
       separates them out as a tremolo, which sounds like a broken speaker. */
    set(this.slipOsc.frequency,
      44 + s.wheelSlip * 105 + Math.abs(s.slipAngle) * 60 + this.chirp * 9, 0.05);
    set(this.slipDepth.gain, 0.34 + 0.34 * this.screech, 0.05);
    /* The floor drops as the depth rises so the peak stays put: without this
       the layer gets louder as it gets rougher and the roughness reads as a
       level change instead. */
    set(this.tyreAM.gain, 1 - (0.34 + 0.34 * this.screech) * 0.55, 0.05);
    set(this.tyre.gain, 0.0001 + 0.52 * this.screech * this.screech, 0.03);

    const gritWant = s.offRoad * lerp(0.35, 1, smoothstep(2, 26, s.speed))
      * lerp(1, 1.45, s.wheelSlip) * (1 - duck);
    this.grit = approach(this.grit, gritWant, gritWant > this.grit ? 8 : 4, dt);
    set(this.gravelLo.frequency, clamp(420 + s.speed * 26 + s.wheelSlip * 300, 200, 6000));
    set(this.gravelPeak.frequency, 260 + s.speed * 6);
    /* Stones per second goes with road speed; the depth comes up as the wheels
       start throwing them rather than just rolling over them. */
    const scatter = 0.22 + 0.26 * s.wheelSlip;
    set(this.scatterOsc.frequency, clamp(26 + s.speed * 2.4, 20, 190), 0.08);
    set(this.scatterDepth.gain, scatter * this.grit, 0.08);
    set(this.gravelAM.gain, 1 - scatter * this.grit * 0.5, 0.08);
    set(this.gravel.gain, 0.0001 + 0.24 * this.grit);

    /* Where the noise is coming from.
     *
     * With the car straight the tyres are ahead of the driver and the image is
     * centred. Sideways, they are not: a car at thirty degrees of slip has its
     * contact patches scrubbing off to one side of the direction of travel,
     * and putting that in the stereo field is a genuinely useful cue as well
     * as a nice one — it tells you which way you are going round before the
     * picture does. Only partway to the extremes, because a hard-panned
     * screech in one ear is a novelty rather than a car, and heavily smoothed,
     * because a pan that snaps is far more distracting than no pan at all. */
    /* Capped well short of hard. A StereoPannerNode uses an equal-power law,
       so a pan of 0.8 is already 16 dB between the channels — which on
       headphones is one ear, and one ear is a novelty rather than a car. Half
       of that is plenty to read the direction from. */
    const image = clamp(-(s.slipAngle || 0) * 1.4, -0.5, 0.5) * rolling;
    this.pan = approach(this.pan, image, 4.5, dt);
    set(this.tyrePan.pan, this.pan, 0.06);
    /* Dirt sprays from wherever the wheels are pointing too, but the sound is
       lower and lower frequencies localise poorly, so the same angle buys less
       image and claiming more of it just sounds wrong. */
    set(this.gravelPan.pan, this.pan * 0.55, 0.08);

    /* Squared in speed because the physical thing is: pressure on the shell
       goes with v². It is also what puts the audible knee where it belongs,
       around 100 km/h, instead of having wind at walking pace. */
    const v = clamp(s.speed / 52, 0, 1.25);
    set(this.windHi.frequency, 200 + v * 260);
    set(this.windLo.frequency, clamp(520 + s.speed * 42, 300, 9000));
    set(this.buffetLo.frequency, clamp(120 + s.speed * 3.4, 90, 420));
    set(this.wind.gain, 0.0001 + 0.40 * v * v * lerp(1, 1.3, s.airborne ? 1 : 0));
  }

  dispose() {
    for (const s of this.sources) { try { s.stop(); } catch (_) {} }
    for (const n of this.nodes) n.disconnect();
    for (const s of this.sources) s.disconnect();
  }
}
