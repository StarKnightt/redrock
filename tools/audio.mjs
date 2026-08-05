/* Does the sound engine actually work?
 *
 * Rendered offline, not played. An OfflineAudioContext runs the same graph the
 * game runs but faster than real time and without a sound card, and — because
 * every random number in src/audio comes from a seeded generator and the
 * engine drives its parameters off a virtual clock when offline — the same
 * scenario renders to the same samples every time. That is what makes it
 * possible to assert on numbers rather than on a listening opinion.
 *
 * Each scenario is a scripted state struct fed in at 60 Hz. Two kinds of
 * render come out of it. The full mix, which is what has to be clean: nothing
 * clipping, nothing silent, no DC. And one render per layer with everything
 * else muted, which is the only way to ask whether the tyres are screeching —
 * on the mixed bus the engine is broadband enough to swamp the answer.
 *
 * Renders are stereo, because two of the things being asserted are about the
 * image: the tyres pan with slip angle and the ocean is on one side of the
 * road. A mono render sums both away and reports that they work.
 *
 * Four of the columns carry most of the weight.
 *
 * The spectral centroid says whether the engine gets BRIGHTER with load and
 * revs or merely louder, which is the whole difference between an engine and a
 * synth sweep — and whether distance makes the surf duller as well as quieter.
 *
 * AM depth and rate are the amplitude spectrum of the envelope, and they
 * answer the one question the spectrum cannot: filtered noise and a squealing
 * tyre can measure identically, and what separates them is that the tyre's
 * level is being chopped at the stick-slip rate.
 *
 * `bal` and `corr` are balance and inter-channel correlation. Balance says
 * where a layer sits; correlation says whether it has any width at all, which
 * matters because a hard-panned mono source and a genuinely wide one have the
 * same balance and sound nothing alike.
 *
 * `maxstep` is the largest sample-to-sample jump, and it does double duty: it
 * is how an impact's attack is measured, and it is how clicks are caught.
 *
 *   node tools/audio.mjs
 */
import { chromium } from 'playwright';
import { serve } from './harness.mjs';
import { finish, guard } from './tame.mjs';

const SR = 44100;

/* This suite does not boot the game.
 *
 * It used to, through the shared harness, and that was a mistake worth naming:
 * src/audio has no dependency on the renderer, the track or the car, so making
 * its tests wait for window.__game meant a syntax error in a mesh builder took
 * the sound suite down with it. Every measurement below needs exactly two
 * things from a browser — an implementation of Web Audio and an ES module
 * loader — and both are available on a blank page.
 *
 * The page is fulfilled from memory rather than served from disk so that no
 * fixture file has to exist, but it is fulfilled at the server's origin, which
 * is what lets it import the real modules over HTTP.
 */
async function inPage(body) {
  const srv = serve();
  await new Promise(r => srv.listen(0, r));
  const origin = `http://localhost:${srv.address().port}`;

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--renderer-process-limit=1',
    ],
  });
  guard(browser, srv);

  const errs = [];
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
    page.on('pageerror', e => errs.push('[pageerror] ' + (e.stack || e.message || e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
    await page.route(origin + '/__audio', route => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><meta charset=utf-8><title>audio</title>',
    }));
    console.log(`→ ${origin}/__audio  (no game, Web Audio only)`);
    await page.goto(origin + '/__audio', { waitUntil: 'domcontentloaded' });
    return await body(page);
  } finally {
    await browser.close().catch(() => {});
    srv.close();
    if (errs.length) {
      console.log('\n─── page errors ───');
      [...new Set(errs)].slice(0, 15).forEach(e => console.log(' ', e));
    }
  }
}

let bad = 0;

await (async () => {
  const out = await inPage(page => page.evaluate(async (sr) => {
    const { Audio } = await import('/src/audio/index.js');

    const IDLE = 1050 / 7400;
    const base = {
      speed: 0, rpm: IDLE, gear: 0, throttle: 0, brake: 0, handbrake: 0,
      slipAngle: 0, wheelSlip: 0, offRoad: 0, airborne: false,
      shoreDistance: 70, shoreDrop: 40, oceanSide: -1,
    };
    const at = (o) => Object.assign({}, base, o);
    const ramp = (t, t0, t1, a, b) => a + (b - a) * Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));

    const SCENARIOS = [
      {
        name: 'idle',
        dur: 3,
        state: () => at({}),
        windows: [['steady', 0.6, 3.0]],
      },
      {
        name: 'accel',
        dur: 6,
        /* Idle to the limiter with the gears stepping under it — the only
           scenario that exercises the shift dip. */
        state: t => at({
          throttle: 1,
          rpm: ramp(t, 0.2, 5.6, IDLE, 1.0),
          speed: ramp(t, 0.2, 5.6, 0, 50),
          gear: Math.min(5, Math.floor(t / 1.1)),
        }),
        windows: [['low rev', 0.6, 1.6], ['high rev', 4.6, 5.9]],
        solo: ['engine'],
      },
      {
        name: 'load off',
        dur: 3,
        state: () => at({ rpm: 0.6, speed: 30 }),
        windows: [['steady', 0.8, 3.0]],
        solo: ['engine', 'wind'],
      },
      {
        name: 'load on',
        dur: 3,
        state: () => at({ rpm: 0.6, speed: 30, throttle: 1 }),
        windows: [['steady', 0.8, 3.0]],
        solo: ['engine'],
      },
      {
        name: 'grip',
        dur: 3,
        state: () => at({ rpm: 0.75, speed: 25, throttle: 0.8, slipAngle: 0.04, wheelSlip: 0.1 }),
        windows: [['steady', 0.8, 3.0]],
        solo: ['tyre'],
      },
      {
        name: 'drift',
        dur: 3,
        state: t => at({
          rpm: 0.75, speed: 25, throttle: 0.8, handbrake: t < 0.4 ? 1 : 0,
          slipAngle: -ramp(t, 0.1, 0.9, 0.05, 0.55), wheelSlip: ramp(t, 0.1, 0.8, 0.1, 0.9),
        }),
        windows: [['sliding', 1.0, 3.0]],
        solo: ['tyre'],
      },
      {
        name: 'off road',
        dur: 3,
        state: () => at({ rpm: 0.6, speed: 30, throttle: 0.6, offRoad: 1, wheelSlip: 0.3, slipAngle: 0.1 }),
        windows: [['steady', 0.8, 3.0]],
        solo: ['gravel'],
      },
      {
        name: 'cruise',
        dur: 3,
        state: () => at({ rpm: 0.85, speed: 50, throttle: 0.35, gear: 5 }),
        windows: [['steady', 0.8, 3.0]],
        solo: ['wind', 'gravel'],
      },
      {
        name: 'impact',
        dur: 2.5,
        state: () => at({ rpm: 0.5, speed: 22, throttle: 0.4 }),
        hits: [[0.6, 0.85], [1.4, 0.25]],
        /* `bed` is the same car doing the same thing with nothing hitting it.
           It is the only reference against which "does an impact land" can be
           asked, because the question is about contrast and not about level. */
        windows: [['bed', 0.05, 0.55], ['hard', 0.55, 1.1], ['light', 1.35, 1.9]],
        solo: ['impact'],
      },
      {
        name: 'jump',
        dur: 3.5,
        /* Airborne mid-slide: the tyre layer has to disappear and come back
           with a landing thump, while the engine and the wind carry on. */
        state: t => at({
          rpm: 0.7, speed: 34, throttle: 0.9, wheelSlip: 0.8, slipAngle: 0.4,
          airborne: t > 1.0 && t < 2.0,
        }),
        windows: [['grounded', 0.5, 0.95], ['airborne', 1.4, 1.95], ['landed', 2.0, 2.4]],
        solo: ['tyre', 'impact', 'engine'],
      },

      /* ---- the coast ---------------------------------------------------
       *
       * Long renders, because that is the only way to see a swell: the LFO
       * bank's slowest member is 0.029 Hz and a three-second window catches a
       * tenth of one breath. Twelve seconds is still short of the full period
       * but it is enough to measure that the level moves. */
      {
        name: 'shore near',
        dur: 12,
        state: () => at({ shoreDistance: 10, shoreDrop: 7, oceanSide: -1 }),
        windows: [['early', 0.5, 6], ['late', 6, 12]],
        solo: ['surf', 'seaWind'],
      },
      {
        name: 'shore far',
        dur: 12,
        state: () => at({ shoreDistance: 380, shoreDrop: 140, oceanSide: -1 }),
        windows: [['steady', 0.5, 12]],
        solo: ['surf'],
      },
      {
        name: 'shore side',
        /* Same water, other side of the road. The only thing that should
           change is which channel it is in. */
        dur: 8,
        state: () => at({ shoreDistance: 14, shoreDrop: 9, oceanSide: 1 }),
        windows: [['steady', 0.5, 8]],
        solo: ['surf'],
      },
      {
        name: 'gulls',
        /* Forty seconds parked by the water. Long enough that a call rate set
           too high shows up as a continuous layer rather than as events. */
        dur: 40,
        state: () => at({ shoreDistance: 12, shoreDrop: 8 }),
        windows: [['whole', 0, 40]],
        solo: ['gull'],
      },
      {
        name: 'seaside pass',
        /* Driving past at speed with the water close: the case where the
           ambience has to get out of the way of the car. */
        dur: 6,
        state: () => at({
          rpm: 0.8, speed: 48, throttle: 0.7, gear: 5,
          shoreDistance: 12, shoreDrop: 9,
        }),
        windows: [['steady', 0.8, 6]],
        solo: ['surf', 'wind'],
      },

      /* ---- the follow-ups ----------------------------------------------- */
      {
        name: 'shift',
        dur: 4,
        /* Held revs with the gear stepping under it, so the bark is not
           tangled up with an rpm sweep. */
        state: t => at({
          throttle: 1, rpm: 0.8, speed: 40,
          gear: t < 1 ? 2 : t < 2 ? 3 : t < 3 ? 2 : 4,
        }),
        windows: [['before', 0.5, 0.95], ['upshift', 1.0, 1.25],
          ['downshift', 2.0, 2.3]],
        solo: ['engine', 'shift'],
      },
      {
        name: 'land soft',
        dur: 3,
        state: t => at({
          rpm: 0.6, speed: 24, throttle: 0.5,
          airborne: t > 0.6 && t < 1.2, landingForce: 0.12,
        }),
        windows: [['landed', 1.2, 1.9]],
        solo: ['impact'],
      },
      {
        name: 'land hard',
        dur: 3,
        state: t => at({
          rpm: 0.6, speed: 24, throttle: 0.5,
          airborne: t > 0.6 && t < 1.2, landingForce: 0.95,
        }),
        windows: [['landed', 1.2, 1.9]],
        solo: ['impact'],
      },

      {
        name: 'start lights',
        dur: 4.6,
        /* Held on the line with the throttle pinned, which is exactly the bed
           the count has to be heard over and the whole reason it is a narrow
           pitched tone rather than a klaxon: the engine owns everything
           broadband from a couple of hundred hertz up. `bed` is the same
           engine with no tone on it, so "does the count land" is a question
           about contrast and not about level — the same shape the impact
           scenario uses. */
        state: () => at({ rpm: 0.985, speed: 0, throttle: 1, gear: 0 }),
        tones: [[0.6, false], [1.6, false], [2.6, false], [3.6, true]],
        windows: [['bed', 0.1, 0.55], ['count', 0.6, 1.0], ['go', 3.6, 4.5]],
        solo: ['start'],
      },

      {
        name: 'finish flag',
        dur: 4.2,
        /* The mirror of the start, and deliberately the opposite problem. The
           count has to cut through a limiter-bound engine; the flag lands on a
           car that is braking to a standstill, so the bed falls away underneath
           it over the two seconds it plays. `bed` is that same decay with no
           chord on it, so the question this asks is whether the chord is
           audible as the engine leaves rather than whether it is loud. */
        state: t => at({
          rpm: Math.max(0.08, 0.7 - t * 0.3), speed: Math.max(0, 34 - t * 16),
          throttle: 0, brake: t < 2 ? 0.3 : 0, gear: 3,
        }),
        finishTones: [[0.35, 'flag', true], [1.9, 'card', true]],
        windows: [['bed', 0.05, 0.3], ['flag', 0.35, 1.6], ['card', 1.9, 2.6]],
        solo: ['finish'],
      },
      {
        name: 'finish lost',
        dur: 3,
        /* The same event on a losing race, which is a different chord. Worth
           its own row because the two are the only pair in this file that are
           meant to sound different from each other rather than merely clean. */
        state: t => at({
          rpm: Math.max(0.08, 0.7 - t * 0.3), speed: Math.max(0, 34 - t * 16),
          throttle: 0, brake: t < 2 ? 0.3 : 0, gear: 3,
        }),
        finishTones: [[0.35, 'flag', false]],
        windows: [['flag', 0.35, 1.6]],
        solo: ['finish'],
      },

      /* ---- worst case ----------------------------------------------------
       *
       * Everything at once, which is the only measurement in this file that
       * says anything about the mix as opposed to about a layer: limiter revs,
       * full throttle, a slide across a dirt cut, the water close enough to
       * hear and a wall being scraped the whole way through. If the summed
       * output has headroom here it has headroom anywhere. */
      {
        name: 'everything',
        dur: 5,
        state: t => at({
          rpm: 0.95, speed: 58, throttle: 1, gear: Math.min(5, 3 + Math.floor(t / 1.7)),
          handbrake: t > 1.5 && t < 2.2 ? 1 : 0,
          slipAngle: -0.45, wheelSlip: 0.85, offRoad: 0.8,
          shoreDistance: 9, shoreDrop: 6, oceanSide: -1,
        }),
        hits: [[1.0, 0.9], [1.9, 0.6], [2.6, 1.0], [3.4, 0.45], [4.1, 0.8]],
        windows: [['loud', 0.5, 5]],
      },
    ];

    /* ---- analysis ----------------------------------------------------- */
    function fft(re, im) {
      const n = re.length;
      for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
          let cr = 1, ci = 0;
          for (let j = 0; j < len / 2; j++) {
            const a = i + j, b = a + len / 2;
            const ur = re[a], ui = im[a];
            const vr = re[b] * cr - im[b] * ci;
            const vi = re[b] * ci + im[b] * cr;
            re[a] = ur + vr; im[a] = ui + vi;
            re[b] = ur - vr; im[b] = ui - vi;
            const nr = cr * wr - ci * wi;
            ci = cr * wi + ci * wr; cr = nr;
          }
        }
      }
    }

    const N = 2048;
    const hann = new Float32Array(N);
    for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

    /**
     * Amplitude-modulation depth and rate.
     *
     * The one question the spectrum cannot answer, and the one that decides
     * whether the tyre layer reads as rubber or as steam. Filtered noise and a
     * squealing tyre can have identical spectra; what separates them is that
     * the tyre's amplitude is being chopped at the stick-slip rate, tens of
     * times a second, and the noise's is not.
     *
     * So: rectify to an envelope at a low sample rate, then take the spectrum
     * of the envelope. A peak in it at 30–250 Hz is modulation, and its height
     * relative to the mean level is how deep. Reported as a fraction, where
     * 0 is a smooth wall of noise and 1 is being switched fully on and off.
     */
    function amDepth(data, t0, t1, loHz = 25, hiHz = 260) {
      const HOP = 64;
      const a = Math.max(0, Math.floor(t0 * sr));
      const b = Math.min(data.length, Math.floor(t1 * sr));
      const count = Math.floor((b - a - HOP) / HOP);
      if (count < 512) return { depth: 0, rate: 0 };
      const M = 1 << Math.floor(Math.log2(Math.min(count, 8192)));
      const env = new Float32Array(M);
      let mean = 0;
      for (let i = 0; i < M; i++) {
        let sq = 0;
        for (let j = 0; j < HOP; j++) {
          const v = data[a + i * HOP + j];
          sq += v * v;
        }
        env[i] = Math.sqrt(sq / HOP);
        mean += env[i];
      }
      mean /= M;
      if (mean < 1e-6) return { depth: 0, rate: 0 };
      const esr = sr / HOP;
      const re = new Float32Array(M), im = new Float32Array(M);
      for (let i = 0; i < M; i++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / M);
        re[i] = (env[i] - mean) * w;
      }
      fft(re, im);
      let best = 0, bestK = 0;
      const k0 = Math.max(1, Math.floor((loHz * M) / esr));
      const k1 = Math.min(M / 2 - 1, Math.ceil((hiHz * M) / esr));
      for (let k = k0; k <= k1; k++) {
        const m = Math.hypot(re[k], im[k]);
        if (m > best) { best = m; bestK = k; }
      }
      // 2|X|/(N/2) recovers the amplitude of a sinusoid under a Hann window.
      const amp = (2 * best) / (M * 0.5);
      return { depth: +(amp / mean).toFixed(3), rate: Math.round((bestK * esr) / M) };
    }

    function measure(L, R, t0, t1) {
      const a = Math.max(0, Math.floor(t0 * sr));
      const b = Math.min(L.length, Math.floor(t1 * sr));
      let peak = 0, sum = 0, sq = 0, clipped = 0, step = 0, peakAt = 0;
      let sqL = 0, sqR = 0, cross = 0;
      for (let i = a; i < b; i++) {
        const l = L[i], rr = R[i];
        sqL += l * l; sqR += rr * rr; cross += l * rr;
        for (const v of [l, rr]) {
          const m = v < 0 ? -v : v;
          if (m > peak) { peak = m; peakAt = i; }
          if (m > 1.0) clipped++;
        }
        /* Mono sum for the level and spectral figures: those are questions
           about the signal, not about the image, and asking them per channel
           only doubles the table. */
        const v = (l + rr) * 0.5;
        sum += v; sq += v * v;
        /* Largest sample-to-sample jump. A parameter stepped once per frame,
           or a noise buffer whose loop does not meet itself, shows up here as
           a discontinuity far larger than the band-limited signal around it —
           which is the measurable signature of a click. */
        const j = i - 1 >= a ? i - 1 : a;
        const d = Math.max(Math.abs(l - L[j]), Math.abs(rr - R[j]));
        if (d > step) step = d;
      }
      const n = Math.max(1, b - a);

      const mag = new Float32Array(N / 2);
      const re = new Float32Array(N), im = new Float32Array(N);
      let frames = 0;
      for (let s = a; s + N <= b; s += N / 2) {
        for (let i = 0; i < N; i++) { re[i] = (L[s + i] + R[s + i]) * 0.5 * hann[i]; im[i] = 0; }
        fft(re, im);
        for (let k = 0; k < N / 2; k++) mag[k] += Math.hypot(re[k], im[k]);
        frames++;
      }
      let num = 0, den = 0;
      for (let k = 1; frames && k < N / 2; k++) {
        const m = mag[k] / frames;
        num += ((k * sr) / N) * m; den += m;
      }
      const rms = Math.sqrt(sq / n);
      const rmsL = Math.sqrt(sqL / n), rmsR = Math.sqrt(sqR / n);
      const am = amDepth(L, t0, t1);
      return {
        peak: +peak.toFixed(4),
        rms: +rms.toFixed(5),
        dc: +(sum / n).toFixed(5),
        clipped,
        step: +step.toFixed(4),
        crest: +(rms > 0 ? peak / rms : 0).toFixed(2),
        centroid: den ? Math.round(num / den) : 0,
        /* Positive is to the right. Reported in dB because that is how it is
           heard: 6 dB is roughly halfway to one side. */
        bal: +(20 * Math.log10((rmsR + 1e-9) / (rmsL + 1e-9))).toFixed(2),
        /* 1 is mono, 0 is two unrelated signals. Anything much below zero is a
           layer that will vanish when the mix is folded down. */
        corr: +(cross / (Math.sqrt(sqL * sqR) + 1e-12)).toFixed(3),
        amDepth: am.depth,
        amRate: am.rate,
        peakAt: +(peakAt / sr).toFixed(4),
      };
    }

    /* ---- render -------------------------------------------------------- */
    async function render(sc, solo, vol = 0.5) {
      /* Stereo, since the tyres pan with slip angle and the ocean sits on one
         side of the road. A mono render sums them and reports that both
         features work perfectly while hearing neither. */
      const ctx = new OfflineAudioContext(2, Math.ceil(sc.dur * sr), sr);
      const audio = new Audio({ context: ctx });
      await audio.start();
      audio.setMasterVolume(vol);
      if (solo) {
        const buses = audio.buses();
        for (const [name, node] of Object.entries(buses)) {
          node.disconnect();
          if (name === solo) node.connect(audio.bus);
        }
      }
      const H = 1 / 60;
      const hits = (sc.hits || []).slice();
      const tones = (sc.tones || []).slice();
      const fin = (sc.finishTones || []).slice();
      for (let i = 0; i * H < sc.dur; i++) {
        const t = i * H;
        audio.update(H, sc.state(t));
        while (hits.length && hits[0][0] <= t) audio.impact(hits.shift()[1]);
        while (tones.length && tones[0][0] <= t) audio.startTone(tones.shift()[1]);
        while (fin.length && fin[0][0] <= t) {
          const [, kind, win] = fin.shift();
          audio.finishTone(kind, win);
        }
      }
      const buf = await ctx.startRendering();
      audio.dispose();
      return [buf.getChannelData(0), buf.getChannelData(1)];
    }

    const mix = [], layers = [];
    for (const sc of SCENARIOS) {
      const full = await render(sc, null);
      for (const [label, t0, t1] of sc.windows) {
        mix.push({ name: sc.name, window: label, ...measure(full[0], full[1], t0, t1) });
      }
      for (const which of sc.solo || []) {
        const d = await render(sc, which);
        for (const [label, t0, t1] of sc.windows) {
          layers.push({ name: sc.name, window: label, layer: which, ...measure(d[0], d[1], t0, t1) });
        }
      }
    }
    /* Everything above renders at the default half volume, which measures the
       mix and not the output stage. A player who drags the slider to the top
       is asking for twice that, and whether the samples reaching the device
       are still inside ±1 is a property of where the limiter sits in the
       chain — a question no amount of measuring at 0.5 can answer. */
    const hot = [];
    for (const name of ['accel', 'everything', 'impact']) {
      const sc = SCENARIOS.find(x => x.name === name);
      const d = await render(sc, null, 1.0);
      for (const [label, t0, t1] of sc.windows) {
        hot.push({ name, window: label, ...measure(d[0], d[1], t0, t1) });
      }
    }

    /* The offline path is the one that gets measured, so the live path — the
       one the game actually uses — needs its own proof that it boots, runs a
       frame loop and tears down without throwing. Headless Chromium has no
       audio device but does have a real AudioContext, and the harness launches
       with autoplay unrestricted so resume() succeeds without a gesture. */
    let live = 'ok';
    try {
      const a = new Audio();
      await a.start();
      await a.start();
      a.setMasterVolume(0.35);
      for (let i = 0; i < 20; i++) {
        a.update(1 / 60, at({
          rpm: 0.5, speed: 20, throttle: 1, gear: i > 10 ? 3 : 2,
          airborne: i > 4 && i < 12, landingForce: 0.7,
          shoreDistance: 30 - i, shoreDrop: 12, oceanSide: i > 10 ? 1 : -1,
          openness: 0.8,
        }));
      }
      a.impact(0.6);
      /* A struct with none of the optional fields, straight after one with all
         of them: the shore has to be latched rather than snapped back, and
         nothing may throw on a missing field. */
      a.update(1 / 60, { speed: 10, rpm: 0.3 });
      a.stop();
      await a.start();
      a.update(1 / 60, at({}));
      live = a.ctx.state;
      a.dispose();
    } catch (e) {
      live = 'threw: ' + (e && e.message);
    }

    return { mix, layers, hot, live };
  }, SR));

  const { mix, layers, hot, live } = out;
  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);
  const m = (n, w) => mix.find(r => r.name === n && (!w || r.window === w));
  const L = (n, l, w) => layers.find(r => r.name === n && r.layer === l && (!w || r.window === w));

  console.log('\n  full mix');
  console.log('  ' + pad('scenario', 13) + pad('window', 11) +
    num('peak', 7) + num('rms', 9) + num('dc', 9) + num('crest', 7) +
    num('centroid', 10) + num('bal dB', 9) + num('maxstep', 9) + num('clip', 7));
  console.log('  ' + '─'.repeat(91));
  for (const r of mix) {
    console.log('  ' + pad(r.name, 13) + pad(r.window, 11) +
      num(r.peak.toFixed(3), 7) + num(r.rms.toFixed(4), 9) +
      num(r.dc.toFixed(4), 9) + num(r.crest.toFixed(2), 7) + num(r.centroid, 10) +
      num(r.bal.toFixed(2), 9) +
      num(r.step.toFixed(4), 9) + num(r.clipped || '·', 7));
  }

  console.log('\n  soloed layers');
  console.log('  ' + pad('scenario', 13) + pad('window', 11) + pad('layer', 9) +
    num('peak', 7) + num('rms', 9) + num('centroid', 10) + num('bal dB', 9) +
    num('corr', 7) + num('AM', 7) + num('AM Hz', 7) + num('peak@s', 9));
  console.log('  ' + '─'.repeat(98));
  for (const r of layers) {
    console.log('  ' + pad(r.name, 13) + pad(r.window, 11) + pad(r.layer, 9) +
      num(r.peak.toFixed(3), 7) + num(r.rms.toFixed(5), 9) + num(r.centroid, 10) +
      num(r.bal.toFixed(2), 9) + num(r.corr.toFixed(2), 7) +
      num(r.amDepth.toFixed(2), 7) + num(r.amRate, 7) + num(r.peakAt.toFixed(3), 9));
  }

  /* Thresholds, and why each is where it is. "Silent" is quieter than a fader
     at the bottom of its useful travel. A DC offset past a percent of full
     scale costs audible headroom for the whole run. The brightness margins are
     wide on purpose: the assertion is that the trend exists, not that it has
     some particular slope. */
  const fails = [];
  const check = (ok, msg) => { if (!ok) fails.push(msg); };

  for (const r of mix) {
    check(!r.clipped, `${r.name}/${r.window}: ${r.clipped} samples past ±1 (peak ${r.peak})`);
    check(r.rms > 0.004, `${r.name}/${r.window}: silent (rms ${r.rms})`);
    check(Math.abs(r.dc) < 0.01, `${r.name}/${r.window}: DC offset ${r.dc}`);
    check(r.peak < 0.98, `${r.name}/${r.window}: no headroom (peak ${r.peak})`);
  }

  /* A discontinuity is only meaningful against the slew the signal is entitled
     to: band-limited noise at these levels legitimately moves a quarter of
     full scale between samples, so the loose bound only catches a jump of the
     order of the peak itself. Idle is the strict one — it is quiet, dull, and
     long enough to cross the 2 s seam in both noise buffers, so a loop that
     did not meet itself would be unmissable there. */
  check(m('idle').step < 0.06, `click at the noise loop seam: ${m('idle').step}`);
  for (const r of mix) {
    check(r.step < Math.max(0.45, r.peak * 0.9),
      `${r.name}/${r.window}: ${r.step} sample-to-sample jump — a click or zipper noise`);
  }

  /* A pure tone through this chain lands near 1.5 and band-limited noise near
     4. Idle sitting between the two is the pulse train doing its job: discrete
     firing events with gaps between them, not a drone. */
  check(m('idle').crest > 2.2, `idle is a tone, not a pulse train: crest ${m('idle').crest}`);

  const lo = L('accel', 'engine', 'low rev'), hi = L('accel', 'engine', 'high rev');
  check(hi.centroid > lo.centroid * 1.3,
    `engine does not brighten with rpm: ${lo.centroid} Hz → ${hi.centroid} Hz`);

  const off = L('load off', 'engine'), on = L('load on', 'engine');
  check(on.centroid > off.centroid * 1.25,
    `engine does not brighten with load: ${off.centroid} Hz → ${on.centroid} Hz`);
  check(on.rms > off.rms * 1.1, 'engine no louder on throttle than off it');

  const grip = L('grip', 'tyre'), drift = L('drift', 'tyre');
  check(drift.rms > grip.rms * 6,
    `screech not gated on slip: rms ${grip.rms} gripping vs ${drift.rms} sliding`);
  check(grip.rms < 0.012, `tyres audible while gripping: rms ${grip.rms}`);
  check(drift.centroid > 1400, `screech too dull to read as a squeal: ${drift.centroid} Hz`);

  const dry = L('cruise', 'gravel'), dirt = L('off road', 'gravel');
  check(dirt.rms > dry.rms * 20, `gravel not gated on surface: ${dry.rms} vs ${dirt.rms}`);
  /* Dirt is thousands of separate stones, not one continuous band. Without
     modulation it is a rumble that happens to be in the right place. */
  check(dirt.amDepth > 0.10, `gravel has no grain in it: AM depth ${dirt.amDepth}`);
  check(dirt.centroid < drift.centroid * 0.5,
    `gravel is not lower than the screech: ${dirt.centroid} Hz vs ${drift.centroid} Hz`);

  const slow = L('load off', 'wind'), fast = L('cruise', 'wind');
  check(fast.rms > slow.rms * 2, `wind does not rise with speed: ${slow.rms} → ${fast.rms}`);

  const air = L('jump', 'tyre', 'airborne'), planted = L('jump', 'tyre', 'grounded');
  check(air.rms < planted.rms * 0.15,
    `tyres not ducked in the air: rms ${planted.rms} → ${air.rms}`);
  check(L('jump', 'engine', 'airborne').rms > L('jump', 'engine', 'grounded').rms * 0.8,
    'engine ducked in the air, it should not be');
  check(L('jump', 'impact', 'landed').peak > 0.15,
    `no landing thump: peak ${L('jump', 'impact', 'landed').peak}`);

  const hard = L('impact', 'impact', 'hard'), light = L('impact', 'impact', 'light');
  check(hard.peak > 0.35, `impact too quiet: peak ${hard.peak}`);

  /* Contrast in the mix, which is the question the soloed measurement above
     cannot answer. An impact competes with a full engine in the same band, so
     what matters is whether it gets above the bed it lands on — and the
     sidechain dip is what buys that without asking the limiter for it. */
  const bed = m('impact', 'bed'), hit = m('impact', 'hard');
  check(hit.peak > bed.peak * 1.25,
    `impacts do not stand out of the mix: bed peak ${bed.peak} vs hit ${hit.peak}`);
  /* And it has to arrive with an edge on it. The largest sample-to-sample
     jump is the closest thing to "attack" that a single number can be: a hit
     that only raises the level is a swell, and a swell is what a
     transient-flattening compressor turns a collision into. */
  check(hit.step > bed.step * 2.5,
    `impact adds level but no attack: max slew ${bed.step} → ${hit.step}`);
  check(hard.peak > light.peak * 1.8,
    `impact does not scale with strength: ${light.peak} at 0.25 vs ${hard.peak} at 0.85`);

  /* ---- the coast ------------------------------------------------------ */
  const nearSurf = L('shore near', 'surf', 'early');
  const farSurf = L('shore far', 'surf');
  check(nearSurf.rms > 0.02, `surf inaudible at the roadside: rms ${nearSurf.rms}`);
  check(nearSurf.rms > farSurf.rms * 2.5,
    `surf does not fall off with distance: ${nearSurf.rms} at 10 m vs ${farSurf.rms} at 380 m`);
  /* Distance is a filter as well as a fader — air eats the foam first. */
  check(nearSurf.centroid > farSurf.centroid * 1.5,
    `distant surf no duller than close surf: ${farSurf.centroid} Hz vs ${nearSurf.centroid} Hz`);
  /* A swell that does not breathe is a fan. The bands are on sub-hertz LFOs,
     so consecutive six-second windows must not measure the same. */
  const early = L('shore near', 'surf', 'early'), late = L('shore near', 'surf', 'late');
  const breath = Math.abs(early.rms - late.rms) / Math.max(early.rms, late.rms);
  check(breath > 0.04, `surf is static: ${(breath * 100).toFixed(1)}% between halves`);
  /* Water off the left of the road has to arrive from the left, and it has to
     be wide — a hard-panned mono wash is worse than a centred one. */
  check(nearSurf.bal < -1.2, `surf not panned toward the water: ${nearSurf.bal} dB`);
  check(L('shore side', 'surf').bal > 1.2,
    `surf does not follow oceanSide: ${L('shore side', 'surf').bal} dB with water to starboard`);
  check(nearSurf.corr < 0.75, `surf is mono: channel correlation ${nearSurf.corr}`);

  const breeze = L('shore near', 'seaWind', 'early');
  check(breeze.rms > 0.004, `no sea air at a standstill: rms ${breeze.rms}`);
  check(breeze.corr < 0.6, `sea air is mono: correlation ${breeze.corr}`);

  const gulls = L('gulls', 'gull');
  check(gulls.peak > 0.02, `no gulls in forty seconds: peak ${gulls.peak}`);
  /* Sparse, and that is measurable: a handful of short calls in forty seconds
     has an enormous crest factor. A continuous layer does not, and a
     continuous gull is the fastest way to make a loop unbearable. */
  check(gulls.crest > 9, `gulls are continuous, not sparse: crest ${gulls.crest}`);
  check(gulls.rms < 0.01, `gulls too present in the bed: rms ${gulls.rms}`);

  /* At speed the ambience has to concede: same water, much less of it. */
  const passing = L('seaside pass', 'surf');
  check(passing.rms < L('shore near', 'surf', 'early').rms,
    'surf does not duck for the car at speed');

  /* ---- panning, barks and landings ------------------------------------ */
  const slid = L('drift', 'tyre');
  check(Math.abs(slid.bal) > 1.5,
    `tyres do not pan with slip angle: ${slid.bal} dB at 0.55 rad`);
  check(Math.abs(L('grip', 'tyre').bal) < Math.abs(slid.bal),
    'tyres pan as much gripping as sliding');

  /* Stick-slip. A screech with no amplitude modulation is filtered noise; the
     rate has to sit in the tens of hertz, where it reads as roughness rather
     than as a tremolo. */
  check(slid.amDepth > 0.12,
    `screech has no stick-slip modulation: depth ${slid.amDepth}`);
  check(slid.amRate > 30 && slid.amRate < 260,
    `stick-slip rate outside the useful band: ${slid.amRate} Hz`);

  const preShift = L('shift', 'shift', 'before');
  const up = L('shift', 'shift', 'upshift');
  const down = L('shift', 'shift', 'downshift');
  check(preShift.rms < 0.002, `exhaust barking between gears: rms ${preShift.rms}`);
  check(up.peak > 0.2, `no bark on the upshift: peak ${up.peak}`);
  check(down.peak > 0.2, `no bark on the downshift: peak ${down.peak}`);
  /* An upshift dumps pressure through a closing throttle and is dull; a
     downshift is a blip against a rising engine and is bright. Same two nodes,
     opposite airflow. */
  check(down.centroid > up.centroid * 1.15,
    `downshift no brighter than upshift: ${down.centroid} Hz vs ${up.centroid} Hz`);
  /* The bark has to arrive as the tone gets out of its way, not on top of it —
     the throttle-cut dip is what makes the event legible. */
  check(L('shift', 'engine', 'upshift').rms < L('shift', 'engine', 'before').rms * 0.97,
    'no throttle-cut dip under the gearchange');

  const soft = L('land soft', 'impact'), heavy = L('land hard', 'impact');
  check(heavy.peak > soft.peak * 2.5,
    `landings do not weigh anything: ${soft.peak} at force 0.12 vs ${heavy.peak} at 0.95`);
  /* A landing and a collision of the same violence are different sounds, and
     the difference is tone: suspension and shell against panel and rock. If a
     heavy landing measures as bright as a heavy hit, the tone parameter has
     stopped doing anything and every jump will read as hitting a wall. */
  /* A gentle landing has to actually be gentle. This is the regression guard
     for the one-sample envelope leak: every one-shot in the engine used to
     open with a full-scale click, and the place it was most visible was here,
     where the intended sound is quiet enough that the click was four times
     louder than it. */
  check(soft.peak < 0.2, `soft landing is a click, not a thump: peak ${soft.peak}`);
  check(heavy.centroid < L('impact', 'impact', 'hard').centroid * 0.8,
    `heavy landing as bright as a collision: ${heavy.centroid} Hz vs ` +
    `${L('impact', 'impact', 'hard').centroid} Hz`);

  /* ---- the whole thing at once ---------------------------------------- */
  const all = m('everything');
  check(all.peak < 0.95, `worst case has no headroom: peak ${all.peak}`);
  check(!all.clipped, `worst case clips: ${all.clipped} samples`);
  /* Crest is the mud detector. Everything on at once with five impacts in it
     should still have transients standing out of the bed; a mix that has
     compressed itself into a slab measures near 2. */
  check(all.crest > 2.6, `worst case is a slab — no transients left: crest ${all.crest}`);

  console.log('\n  master volume at 1.0');
  console.log('  ' + pad('scenario', 13) + pad('window', 11) +
    num('peak', 7) + num('rms', 9) + num('clip', 7));
  console.log('  ' + '─'.repeat(47));
  for (const r of hot) {
    console.log('  ' + pad(r.name, 13) + pad(r.window, 11) +
      num(r.peak.toFixed(3), 7) + num(r.rms.toFixed(4), 9) + num(r.clipped || '·', 7));
    check(!r.clipped, `${r.name}/${r.window} at full volume: ${r.clipped} samples past ±1`);
    check(r.peak <= 1.0, `${r.name}/${r.window} at full volume: peak ${r.peak}`);
  }

  check(live === 'running', `live AudioContext: ${live}`);
  console.log(`\n  live context after start/stop/start: ${live}`);

  console.log('');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    bad = fails.length;
  } else {
    console.log(`  ✓ ${mix.length} mix windows + ${layers.length} layer windows: ` +
      'no clipping, nothing silent, brightness tracks rpm and load,\n' +
      '    tyres and gravel gated on slip and surface, wind on speed, impacts scale\n' +
      '    and weigh, surf tracks distance and side, gulls stay sparse, worst case clean');
  }
})();

finish(bad ? 1 : (process.exitCode || 0));
