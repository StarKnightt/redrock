/* The race: three AI opponents, standings, the split clock and car contact.
 *
 * Owns everything about the field that is not the player: the opponent cars
 * and their views, the drivers, the rubber band that keeps the pack close,
 * and the shared accounting — positions, the split delta, car-to-car contact.
 * main.js constructs one of these, calls step() once per frame after the
 * player's own substeps, and reads positionOf / deltaFor / standings for the
 * HUD.
 *
 * The drivers are the existing Driver, not a new one. It already finishes the
 * stage reliably and exposes the two knobs a field needs: `skill` for
 * character and `boost` for the rubber band. Character beyond that comes from
 * outside the driver — a per-car preferred lane and two slow seeded noise
 * streams that wander the lane and the pace along the stage, so three cars
 * take three different lines into the same corner and brake at three slightly
 * different points, and do it the same way every run of the same seed.
 */
import * as THREE from 'three';
import { clamp, approach, smoothstep } from '../core/util.js';
import { rng, noise1 } from '../core/rng.js';
import { Car } from '../car/physics.js';
import { Driver } from '../car/driver.js';
import { buildCar } from '../car/mesh.js';
import { celMaterial } from '../render/cel.js';
import { Frame } from '../world/track.js';
import { StopServo, scrubSpeed, stopStation, stopFloor } from './ending.js';

/* Callsigns by palette index, for standings debug output. Palette 0 is the
   player's and never assigned to an opponent. */
const NAMES = [null, 'COBALT', 'OCHRE', 'SAGE', 'BONE'];

/* Grid slots as (Δs from the player's start, lat), front row first.
 *
 * The player starts LAST and the three rivals are AHEAD of it. Staggered two
 * abreast so nobody launches through anyone: 6.5 m between rows is more than a
 * car length, and alternating sides keeps the first braking zone from being a
 * queue. The rows themselves are the same 6.5 m they were when the field
 * gridded BEHIND the player; what is new is the 10 m from the player to the
 * back row, and that gap is the whole tuning story below.
 *
 * Ahead and not behind, and the reason is the start itself rather than the
 * racing. The chase lens sits about ten metres behind the player and looks up
 * the road, so a field gridded behind it is a field behind the camera: the
 * whole start ceremony — three seconds of countdown, the cheer squad the
 * environment puts at s=46, the revs against the limiter, the crowd — was
 * staged around one car on an empty piece of tarmac. Ablating each rival out of
 * the countdown frame and re-rendering (tools/kwshot.mjs) put the old number at
 * zero: 0 of 3 rivals in frame, 0 pixels, on all of seeds 22, 1 and 40. This
 * formation puts 3 of 3 in frame for about 20 k pixels, the nearest car ~110
 * high, receding up the road in the zigzag the stagger makes.
 *
 * The order is conventional as well: the quickest rival starts at the front —
 * see PACE, whose index this shares — so the field the player climbs through
 * is sorted slowest first and each pass is harder than the last.
 *
 * STALE NUMBERS, READ THIS FIRST: every figure quoted below was measured before
 * the car-physics fix of 2026-08-05 (friction circle charged against net rather
 * than contact-patch longitudinal force; brake split made load-sensitive). That
 * fix moved rival pace ~1.9%, took rival spin recoveries from 44 to 0 across 32
 * cars and retightened field spread on its own author's measurement, so the
 * absolute values here no longer describe this build. What they still support is
 * the CHOICE of 10 m, because all four formations below were swept on one
 * identical build and the comparison between them is internally consistent. The
 * re-measurement against the fixed physics was not finished. Do not quote these
 * as current, and re-run tools/kwgrid.mjs for all four formations before
 * changing the spacing on the strength of them.
 *
 * The 10 m is measured, not styled. Reversing the grid at the original 7 m
 * spacing lands the player in the back of the field before the race is a race,
 * and the sweep says that costs the thing the change was asked to buy: over 32
 * seeds it took lead changes from 8.7 a race to 6.3 (a real loss against the
 * noise floor, and almost exactly the 26% an earlier fix cost and a rubber-band
 * retune was spent winning back), dropped the last-70% lead changes from 4.2 to
 * 3.3, lengthened the lonely tail from 3.5 s to 5.1 s and — the tell — RAISED
 * the player's win rate from 50% to 63% and its share of the race spent leading
 * from 31% to 36%. Punting three cars off the line is not a climb through the
 * field, it is a head start. Opening the gap to 14 m over-corrected the other
 * way (win rate 47%, but lead changes still a real loss at 7.1 and rival spin
 * recoveries up by a quarter). At 10 m nothing regresses: against the pole grid
 * every balance metric is inside the noise floor except passes made, which goes
 * UP by 2.0 a race, and the two numbers that decide whether winning is earned
 * land on the pole values to the decimal — 31% of the race led, 16 of 32 won.
 *
 * What this is NOT is a fix for the aggregate racing, and that is worth
 * stating here because it is the ground the change was asked for on. Over the
 * same sweep the pole grid was already delivering the arc: the player led only
 * 31% of the race, won 16 of 32, and had a rival inside 60 m for 71% of the
 * running. The grid shot is the real win here; the racing is held level, which
 * on this metric set is the most a formation can honestly claim, because a grid
 * is twenty metres of a five-and-a-half kilometre stage.
 *
 * The single-seed evidence that motivated it does not survive contact with the
 * noise floor. A four-minute four-car race is chaotic: the same field run from
 * initial conditions one part in a billion apart flips the win on 13 seeds out
 * of 32, moves a seed's finish spread by up to 14.8 s, and moves the fraction
 * of the race the player leads by up to 62 points. "Led 87%, and ran the last
 * 59 s with nobody inside 150 m" reproduces on the POLE grid on seeds 6, 18,
 * 20, 27 and 31 depending on nothing but that noise. Read the sweep, never a
 * seed. */
const GRID = [[23, 2.3], [16.5, -2.3], [10, 2.3]];

/* Character. Skill is deliberately NOT the pace knob: measured solo, the
   Driver's stage time is flat within ±2 s from skill 0.55 to 0.85 and gets
   WORSE above that — the extra planned corner speed is spent on mistakes.
   What skill does buy is line character (apex commitment, wobble), so the
   three cars get skills inside the stable band and their actual pace
   hierarchy comes from PACE, a static multiplier folded into boost.

   Boost has the same shape and it took much longer to notice, because unlike
   skill it looks like a throttle. It is not. Measured on the solo bot over
   five stages (tools/boostcurve.mjs), against boost 1.00:

       0.86   +20.4 s        1.03    +6.5 s
       0.92    +9.4 s        1.06    +9.3 s
       0.96    +7.2 s        1.09   +27.2 s
       1.00      —           1.13   +50.2 s

   1.00 is the optimum and every departure from it costs time, in BOTH
   directions. Above it the mechanism is plain: time spent off the road goes
   from 14.6% at 1.00 to 27.1% at 1.13, and mean speed FALLS above 1.06,
   because the plan has outrun the grip and the car is in the scenery. There
   is no setting at which boost makes a car quicker.

   So the multiplier is a handicap, only ever a handicap, and the ceiling is
   1.0. "Catching up" means having the handicap taken off; it can never mean
   being given something the car did not already have. PACE therefore sits
   below 1 across the board, to leave the band that room to give back. */
const SKILLS = [0.82, 0.75, 0.68];
const PACE = [0.995, 0.975, 0.955];

/* Character, so that when the order changes it changes for a reason the
   player can watch happening. Each rival is genuinely better on one kind of
   road and worse on another, over the two axes this stage actually varies:
   how tight the corner is and how steeply the road is dropping. A single pace
   number can only ever string the field out in the same order; this makes the
   same three cars trade places at the same kinds of corner, so a rival coming
   back at you through the hairpins reads as that rival being good at hairpins
   rather than as the game deciding you were too far ahead.

   The three vectors are deliberately not opposites of each other — a
   rock/paper/scissors field has no stable order anywhere, which is its own
   kind of noise. Each car is strong in one thing, weak in one thing, and
   neutral about the rest. */
const TRAITS = [
  { tight: -0.85, steep: 0.35 },   // carries speed where the road opens out
  { tight: 0.25, steep: -0.90 },   // technical, but backs off over the drops
  { tight: 0.90, steep: 0.30 },    // lives in the tight stuff
];
/* Sized against the static pace spread rather than under it, so terrain can
   invert the order rather than merely narrow it, and slewed over about a
   second so a car is strong through a section instead of gaining a step at
   the apex. Half what it was, because it is now measured against the
   best-suited car rather than the field mean, so the whole of it lands as a
   penalty on the other two instead of being split either side of zero.
   Narrowing PACE to let the traits dominate was tried and was worse on every
   measure: with no hierarchy to overturn there is nothing for the terrain to
   overturn it against. */
const TRAIT_AMP = 0.03;
const TRAIT_RATE = 0.9;
/* Lanes are character, not strategy, and they have to stay small: a constant
   ±1.8 m offset was worth ±10 s over the stage, because whichever side the
   layout favours turns a "preferred line" into a permanent shortcut. At this
   size the cars still approach a corner abreast of different kerbs without
   any of them owning a faster road. */
const LANES = [0.8, -0.8, 0.25];

/* Rubber band shape.
 *
 * The response is deliberately soft: a dead zone around parity, so cars
 * genuinely racing the player wheel-to-wheel are not being pushed and pulled
 * by an invisible hand, then a smoothstep out to the full effect over several
 * seconds of gap, and a slew limit so the multiplier takes a couple of
 * seconds to arrive rather than snapping the moment the player spins.
 *
 * Both directions are cuts, because boost cannot do anything else — see the
 * curve above PACE. A car behind the player has its handicap lifted toward
 * the 1.0 ceiling and drives at its own best; a car ahead has more handicap
 * piled on. There is no setting at which a rival is given more than it came
 * with, which is what makes this safe to have at all.
 *
 * The two directions are still shaped differently, because they are felt
 * differently. Catch is small because it is the only half the player can
 * see, and a rival that closes hard for no visible reason reads as the game
 * reaching in. It was measured: raising catch from 0.05 to 0.07 bought 6
 * more player-involved lead changes across eight stages and took passes of
 * the player following no player mistake from 2 to 8. Drop comes in two
 * stages because a small cut saturates — on the straights the plan already
 * exceeds what drag allows, so −10% barely registers. The gentle stage is
 * all a nearby rival ever feels; the deep stage only engages at gaps where
 * the car is beyond the horizon anyway, which is exactly where slowing down
 * cannot be seen to be slowing down. */
const BAND = {
  dead: 0.6,        // seconds of gap inside which nobody is touched
  catch: 0.05,      // handicap lifted, up to the ceiling, when behind
  catchAt: 8,       // seconds behind at which the full lift applies
  drop: 0.10,       // visible-range speed-plan cut when ahead
  dropAt: 7,
  dropFar: 0.12,    // additional cut, phased in from dropAt to dropFarAt
  dropFarAt: 22,
  rate: 0.45,       // per-second approach toward the target multiplier
};

/* Pack cohesion, which is a different job from the band above.
 *
 * The band only ever compares a rival to the player, so the AI field's own
 * order is set by PACE at the start line and never revisited. Measured over
 * five stages that showed up exactly as you would expect: the leader spent
 * the race an average of 37 to 196 m clear of second, the field was within
 * 60 m of itself for only 13–19% of the running, and every lead change in
 * every race happened in the first third, before the pack had strung out.
 * There was nothing at the front to fight over for the last two thirds.
 *
 * So: a second band that pulls a rival back toward the rival field. It is
 * referenced to the rival field and NOT to the player, which is the whole
 * point — a term that pulled rivals toward the player would drag them onto
 * the player's bumper however well the player drove, and that is the elastic
 * feeling worth more than a few lead changes. This one can be stronger than
 * the player band precisely because the player is outside it: nothing it
 * does is aimed at the player, so none of it can be felt as the game
 * reaching in. Measured in metres rather than seconds because it is about
 * the shape of the pack, not a gap the HUD will ever show anyone.
 *
 * The reference is the field's own mean, and both directions are live. Two
 * variations on that were tried once the AI learned to recover from a spin
 * by driving out of it rather than being teleported, on the theory that a
 * spin now costs real time and the car that spun is the one that needs the
 * help. Referencing the leading rival instead, and dropping the hold-back so
 * cohesion only ever caught up, both made the racing worse — the same eight
 * stages went from 40 player-involved lead changes to 20. The reason is that
 * the hold-back is what stops the front rival escaping in the first place.
 * The player band only trims a rival that is ahead of the PLAYER, so when
 * the player is leading there is nothing else in the system that keeps the
 * quickest rival attached to the other two, and the race at the front turns
 * into a procession while the pack churns away behind it, out of sight.
 *
 * What the spin fix did change is the balance between the two directions —
 * and not the way round the sentence that used to sit here claimed. It said
 * catching up was worth roughly twice the hold-back. The constants say the
 * reverse, and have since they were last tuned: catch is 0.13 and hold is
 * 0.34, so the HOLD-BACK is worth about two and a half times the catch. That
 * is consistent with the paragraph above rather than with the old sentence —
 * the hold-back is the term that stops the quickest rival escaping the other
 * two, which is the whole reason the front of the race stays a race, while
 * the catch only has to reel in a car that has already lost time doing
 * something the player watched it do.
 *
 * The dead zone earns its keep too: shrinking it to 12 m made the racing worse
 * on every count, because rivals genuinely side by side were being trimmed
 * against each other instead of left to fight.
 *
 * Reversing the grid did not require retuning any of this, and that was checked
 * rather than assumed. The worry was structural: with the player starting last,
 * every rival begins the race on the side of the band that CUTS it, for a
 * reason the player did nothing to earn. Instrumenting the band per rival over
 * the 32-seed sweep (tools/kwgrid.mjs, tools/kwstat.mjs) says the exposure
 * barely moves — rivals spend 39.8% of the race ahead of the player against
 * 39.0% on the pole grid — and what the chain actually delivers to the driver
 * is flat to two decimals: mean band 0.97 both ways, mean boost 0.94 against
 * 0.95. Both differences are inside the run-to-run noise floor. The band is
 * neither fighting the new grid nor propping it up, so it was left alone. */
const PACK = {
  dead: 25,       // metres of gap inside which the pack is left to race
  full: 320,      // and at which cohesion is at full strength
  catch: 0.13,    // lift for a car that has dropped off the back
  hold: 0.34,     // trim for one running away from the other two
};

/* Exported so a gate can state its bars against the ceiling the shape actually
 * has — the player band can never contribute more than BAND.catch, and a bar
 * quoted without that number is a bar nobody can size.
 *
 * These are the live objects the game reads, so a tool that writes to them is
 * building a different game and not adjusting a probe. That is deliberate and
 * it is what makes a gate demonstrable: tools/race.mjs --teeth breaks the band
 * here, on purpose, to show that the gate goes red when it should. Nothing in
 * the shipped path writes to them. */
export { BAND, PACK };

/* Contact envelope, slightly inside the true body so a near miss stays a
   near miss. Everything is done in (s, lat) space: both cars already carry
   an accurate road-relative position, and at these speeds "alongside" and
   "nose to tail" are road-relative ideas anyway. */
const C_LEN = 3.9;
const C_WID = 1.85;

/* Metres of air that mean one car is over another rather than alongside it.
   About a car's body height; below it the two are still trading paint. */
const AIR_CLEAR = 0.5;

/* Two cars trading a position cross each other's s several times a second.
   Ranks only swap once the challenger is a full metre clear, so the HUD
   badge holds steady through a side-by-side battle instead of strobing. */
const HYST = 1.0;

/* Where a car that has finished parks.
 *
 * Every car in the race gets one, the player included, and Race owns the
 * assignment because Race is the only thing that knows what order they
 * arrived in. That ordering is the whole mechanism: the Nth car to cross
 * stops six metres SHORTER than the one before it, so a later arrival never
 * has to drive through something already stopped. Doing it the other way
 * round — a fixed station per car, or the later arrivals going further —
 * puts a parked car in the braking zone of the one behind, which on this
 * stage is 34 metres long and has an arch in the middle of it.
 *
 * The stagger is in `s` ONLY, and the lane is whatever lane the car crossed
 * the line in. That is not laziness; it is the second thing this mechanism
 * was, and the first thing did not survive measurement.
 *
 * The first version parked the field on alternating lanes — centre, +3, −3 —
 * for the perfectly good reason that a field strung nose to tail down the
 * middle of the road reads as a queue and an off-centre one reads as a
 * finish. What it actually produced was a spin, every time, on every seed.
 * The trace in tools/finish.mjs has it: a car crossing at 94 km/h is handed a
 * lane target three metres from where it is at the same instant the servo
 * puts it on 100% brake, and a tyre at the limit longitudinally has nothing
 * left to turn with. Slip angle went 14° at a quarter second, 29° at a half,
 * 49° at three quarters; `s` stopped advancing entirely while the car still
 * read 24 km/h, because by then it was travelling sideways; and the field
 * came to rest ten metres off the road with the held camera pointing at an
 * empty piece of tarmac.
 *
 * Six metres of stagger is two metres of daylight between one 3.9 m car and
 * the next, which is enough on its own, and cars that raced each other to the
 * line are rarely in the same lane anyway. A slow-down lap in real racing
 * looks exactly like this.
 *
 * IT IS A SPACING AND IT IS NOT A STATION. How near the line any car may rest
 * is ending.js's STOP_MIN_M, because that is a fact about where the arch is;
 * this number only says how far apart two of them sit. `_assignPark` used to
 * floor the whole stack on this constant, which is the two-lengths-are-not-the-
 * same-thing bug: it reads fine, it type-checks, and it parked the field under
 * the bunting. See stopFloor, which this now feeds rather than overrides. */
const PARK_GAP = 6;

const _s0 = new THREE.Vector3(), _s1 = new THREE.Vector3();
const _fT = new Frame();

/**
 * Move a car `ds` metres along the stage and `dlat` metres across it, keeping
 * it on the road.
 *
 * Translating in the road frame is not the same thing. The road is crowned —
 * half a metre of fall from the centre line to each edge, cubic — so near the
 * edge the surface drops about 13 cm for every metre travelled across it, and
 * the width and camber move with `s` as well. A car shoved a quarter of a
 * metre sideways along `right` therefore ends up hanging above the road it
 * was resting on — measured at up to 26 cm over a race — and its own step
 * reads that gap as the ground dropping away, which takes the tyres, the
 * drive and the brakes off it. Moving by the difference between two surface
 * points instead adds no air and takes none away: measured worst case zero.
 */
function slide(car, ds, dlat) {
  car.surfaceAt(car.s, car.lat, _s0);
  car.s += ds;
  car.lat += dlat;
  car.surfaceAt(car.s, car.lat, _s1);
  car.pos.add(_s1).sub(_s0);
  /* The renderer draws one substep of travel extrapolated past `pos`, and
     this is not travel — it is the separation that stops two cars occupying
     each other, applied once a frame and worth up to a quarter of a metre.
     Carrying the previous position along with the current one keeps it out
     of the extrapolated delta, so a rub does not read as a car being flicked
     sideways. */
  car._prevPos.add(_s1).sub(_s0);
}

export class Race {
  /**
   * @param {import('../world/track.js').Track} track
   * @param {THREE.Scene} scene
   * @param {{seed?:number, count?:number, playerS?:number, material?:THREE.Material, rubber?:boolean}} opts
   */
  constructor(track, scene, opts = {}) {
    this.track = track;
    this.scene = scene;
    this.seed = opts.seed ?? 1;
    this.playerS = opts.playerS ?? 34;
    this.rubber = opts.rubber !== false;

    this._ownMat = !opts.material;
    this.material = opts.material
      || celMaterial({ vertexColors: true, flatShading: true });

    const count = Math.min(opts.count ?? 3, GRID.length);
    const r = rng((this.seed ^ 0x9e3779b9) >>> 0);

    // Seeded palette draw, so the same seed always fields the same liveries.
    const palettes = [1, 2, 3, 4];
    for (let i = palettes.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [palettes[i], palettes[j]] = [palettes[j], palettes[i]];
    }

    this.entries = [];
    for (let i = 0; i < count; i++) {
      const palette = palettes[i];
      const view = buildCar(palette);
      view.root.traverse(o => {
        if (o.isMesh) { o.material = this.material; o.castShadow = true; }
      });
      scene.add(view.root);

      const skill = clamp(SKILLS[i] + (r() * 2 - 1) * 0.02, 0.5, 1);
      const lane = LANES[i] + (r() * 2 - 1) * 0.5;
      const driver = new Driver(track, { skill, lane, seed: this.seed * 8 + i });

      this.entries.push({
        car: new Car(track, { palette, ai: true }),
        view, driver,
        name: NAMES[palette],
        skill,
        pace: PACE[i] + (r() * 2 - 1) * 0.005,
        trait: TRAITS[i],
        baseLane: lane,
        grid: GRID[i],
        /* Driver seeds its wobble phase from Math.random; re-seeding it here
           is what makes the whole race a pure function of the seed. */
        wobble0: r() * 10,
        /* Slow noise over arc length, not time: the same corner gets the same
           slightly-early or slightly-late braking point on every lap of the
           same seed, which is what a driving style is. */
        lineNoise: noise1((this.seed * 131 + i * 17 + 3) >>> 0),
        paceNoise: noise1((this.seed * 197 + i * 29 + 7) >>> 0),
        /* `bandPlayer` and `bandPack` are the two halves `band` is the sum of,
           carried for instrumentation only — see `_rubber`. */
        band: 1, bandPlayer: 0, bandPack: 0, form: 1, _trait: 0,
        finished: false, time: 0, recoveries: 0, isPlayer: false,
        park: null, servo: new StopServo(),
      });
    }

    this._playerEntry = null;
    this._order = [...this.entries];
    this.collisions = 0;
    this._pairs = new Set();
    this._lastHit = new Map();
    this._clock = 0;
    this._crng = rng((this.seed ^ 0xc0111de5) >>> 0);
    this._delta = null;
    this._deltaMate = null;
    /* One consumed event slot, written only by a live settled rank change.
       Initial sorting and resets never become overtakes. */
    this._positionChange = null;
    this.reset();
  }

  /** Back to the grid. The player is the caller's to re-place. */
  reset(atS = this.playerS) {
    for (const e of this.entries) {
      const [ds, lat] = e.grid;
      e.car.placeAt(Math.max(6, atS + ds), lat);
      e.car.finished = false;
      e.car.raceTime = 0;
      e.car.applyTo(e.view);
      e.view.root.visible = true;
      e.driver.steerSmooth = 0;
      e.driver.throttleSmooth = 0;
      e.driver.prevLat = lat;
      e.driver.stuckFor = 0;
      /* A turn-around in progress is state that outlives a reset otherwise,
         and the whole race is supposed to be a pure function of the seed. */
      e.driver.rec = null;
      e.driver.boost = 1;
      e.driver.wobble = e.wobble0;
      e.band = 1; e.bandPlayer = 0; e.bandPack = 0; e.form = 1; e._trait = 0;
      e.finished = false; e.time = 0; e.recoveries = 0;
      e.park = null; e.servo.reset();
    }
    if (this._playerEntry) {
      this._playerEntry.finished = false;
      this._playerEntry.time = 0;
      this._playerEntry.park = null;
    }
    this._parked = 0;
    this._lastPark = 0;
    /* Grid order, front to back: `entries` is in GRID order, GRID is front row
       first, and the player is on the back row. `_settle` would sort this out
       from any order, but the standings have to be right BEFORE anything is
       stepped — the HUD reads them for the whole of the countdown, which is
       the three seconds of the game that get looked at hardest. */
    this._order = [
      ...this.entries,
      ...(this._playerEntry ? [this._playerEntry] : []),
    ];
    this._settle(this._order.length);
    this.collisions = 0;
    this._pairs.clear();
    this._lastHit.clear();
    this._clock = 0;
    this._crng = rng((this.seed ^ 0xc0111de5) >>> 0);
    this._delta = null;
    this._deltaMate = null;
    this._positionChange = null;
  }

  /**
   * Advance the field one frame. Call after the player's own substeps so
   * contact this frame is against where the player actually is.
   */
  step(dt, player) {
    if (!(dt > 0)) return;
    this._ensurePlayer(player);
    const fromPosition = this._order.indexOf(this._playerEntry) + 1;
    this._clock += dt;

    const allCars = [player, ...this.entries.map(e => e.car)];
    this._field();
    for (const e of this.entries) {
      const car = e.car;
      car.lastImpact = 0;

      this._rubber(e, player, dt);

      /* Traffic awareness, as a lane bias rather than a control override: a
         car close ahead pushes the preferred line to the other side of the
         road, so a catch turns into a pass. Without it two pace-matched cars
         hold the same line and grind doors for the whole straight. */
      let avoid = 0;
      for (const other of allCars) {
        if (other === car) continue;
        const ds = other.s - car.s;
        if (ds < -3 || ds > 14) continue;
        const dl = other.lat - car.lat;
        if (Math.abs(dl) > 3.2) continue;
        avoid -= Math.sign(dl || 1) * (1 - Math.max(ds, 0) / 14) * 1.8;
      }
      /* Past the line a rival is not racing any more, so it stops steering
         for a racing line and steers for its parking slot instead. Left
         alone it drove off the end of the authored world at full throttle,
         exactly as the player used to — three times over, in the background
         of the shot the held camera is pointed at. */
      e.driver.lane = e.park ? e.park.lat
        : e.baseLane + e.lineNoise(car.s * 0.012) * 1.2 + clamp(avoid, -2.2, 2.2);

      /* One planning pass per frame, shared across substeps. The driver's
         terms are all smooth over a frame, and targetSpeed alone walks ~40
         track frames — at 120 Hz for three cars that is most of the module's
         budget for no behavioural difference. */
      const input = e.driver.drive(car, dt);
      /* Steering from the driver, pedals from the servo. The driver is what
         keeps the car on a crowned road that is still turning under it; the
         servo is the only thing that knows where the car is supposed to end
         up. Taking the whole control output from either one alone gets a car
         that stops in the right place off the side of the road, or one that
         stays on it and does not stop. */
      if (e.park) Object.assign(input, e.servo.control(
        car.speed, e.park.s - car.s, car.s - this.track.finishS, dt));

      /* Full 120 Hz for every opponent, near or far. Half rate for distant
         cars was measured, and rejected: it saved 0.025 ms a frame and made
         the physics integrate measurably faster — a car two corners up the
         road quietly gained seven seconds a stage, which is a pace change,
         not an optimisation. */
      const sub = Math.min(4, Math.max(1, Math.ceil(dt / (1 / 120))));
      const h = dt / sub;
      for (let i = 0; i < sub; i++) {
        car.step(h, input);
        if (input.scrub) scrubSpeed(car, input.scrub, h);
      }

      /* Same policy the telemetry runs use: a stranded AI car is a lost car.
         Except that a car in the middle of turning itself around is not lost,
         and the strand timer cannot tell the two apart — its heading test
         fires at 81° off the road, which every honest spin recovery spends
         longer than 2.5 s beyond. Measured across 12 seeds, that rescued 49%
         of recoveries out from under a driver that was going to finish the
         job, at 10 teleports a race with three rivals on the road. So the
         driver gets to ask for more time while it is still closing the angle
         with its tyres on the ground, and the hard cap catches the cases
         where it is not — a car wedged on the berm shoulder with no contact
         cannot steer, and no amount of patience helps it. */
      /* Not once it has parked. `strandedFor` counts a car that is stopped,
         which is precisely what a finished car is being asked to be, and the
         rescue would teleport it eight metres back up the road and charge it
         a recovery for standing still — a number the results card prints. */
      const grace = e.driver.recovering ? 8 : 2.5;
      if (!e.park && car.strandedFor > grace) { car.recover(); e.recoveries++; }

      if (car.finished && !e.finished) {
        e.finished = true; e.time = car.raceTime; this._assignPark(e);
      }
    }
    if (player.finished && this._playerEntry && !this._playerEntry.finished) {
      this._playerEntry.finished = true;
      this._playerEntry.time = player.raceTime;
      this._assignPark(this._playerEntry);
    }

    this._contacts(dt);
    this.applyViews(0, player);

    this._settle(1);
    const toPosition = this._order.indexOf(this._playerEntry) + 1;
    if (fromPosition > 0 && toPosition > 0 && fromPosition !== toPosition) {
      this._positionChange = {
        direction: toPosition < fromPosition ? 'gained' : 'lost',
        from: fromPosition,
        to: toPosition,
      };
    }
    this._updateDelta(dt, player);
  }

  /**
   * Put the field onto the scene graph at the given render phase.
   *
   * Separate from `step` and called every frame rather than every stepped
   * frame, because `alpha` moves even on a frame that ran no substep at all —
   * which on a 144 Hz panel is one frame in six. Leaving the rivals on the
   * pose `step` last wrote would hold them still through those frames while
   * the player kept moving, which is the judder this exists to remove,
   * reintroduced for three cars out of four. See Car.applyTo for what alpha
   * is; zero reproduces the old behaviour exactly.
   *
   * @param {number} alpha 0..1 through the current substep
   * @param {import('../car/physics.js').Car} player
   */
  applyViews(alpha, player) {
    for (const e of this.entries) {
      e.car.applyTo(e.view, alpha);
      /* Beyond this a car is a fistful of fogged pixels; dropping it saves
         its five draw calls in every pass. Straight-line distance, not arc —
         the stage folds back on itself and a car one switchback over is
         genuinely visible. */
      e.view.root.visible = e.car.pos.distanceToSquared(player.pos) < 450 * 450;
    }
  }

  /** Ordered first → last. Times are locked at the line for finished cars. */
  standings() {
    return this._order.map((e, i) => ({
      position: i + 1,
      car: e.car,
      name: e.name || 'PLAYER',
      isPlayer: !!e.isPlayer,
      finished: e.finished,
      time: e.finished ? e.time : e.car.raceTime,
      s: e.car.s,
      recoveries: e.recoveries || 0,
    }));
  }

  /**
   * Register the player before anything has been stepped.
   *
   * The HUD read `1ST /3` for the whole of the start countdown, which is the
   * three seconds of the game that get looked at hardest. `fieldSize` is
   * `_order.length`, the player is only ever added by `_ensurePlayer`, and
   * `_ensurePlayer` is called from `step` — which main.js gates on `ran > 0`.
   * Nothing steps while the field is held on the line, so the field was three
   * cars until the release frame. Registering the player at construction is
   * the whole fix; it is the same call `step` would have made, made earlier.
   */
  join(player) { this._ensurePlayer(player); }

  /** Where a finished car parks: { s, lat }, or null while it is racing. */
  parkFor(car) {
    const all = this._playerEntry ? [this._playerEntry, ...this.entries] : this.entries;
    const e = all.find(x => x.car === car);
    return e ? e.park : null;
  }

  /** 1-based, or null for a car the race has never seen. */
  positionOf(car) {
    const i = this._order.findIndex(e => e.car === car);
    return i < 0 ? null : i + 1;
  }

  /**
   * Consume the player's last settled position change.
   *
   * `_settle` already owns the one-metre hysteresis that turns side-by-side
   * motion into a rank, so this reports the event at the same instant the HUD
   * number changes rather than trying to infer a pass from raw distance.
   */
  takePositionChange() {
    const event = this._positionChange;
    this._positionChange = null;
    return event;
  }

  /**
   * Seconds to the car immediately ahead in the standings — or behind, when
   * the player leads. Positive = player behind, matching the HUD's sign.
   */
  deltaFor(player) {
    if (!this._playerEntry || this._playerEntry.car !== player) return null;
    return this._delta;
  }

  get cars() { return this.entries.map(e => e.car); }
  get fieldSize() { return this._order.length; }

  dispose() {
    for (const e of this.entries) {
      this.scene.remove(e.view.root);
      e.view.root.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
    }
    if (this._ownMat) this.material.dispose();
    this.entries.length = 0;
    this._order.length = 0;
    this._playerEntry = null;
  }

  /* ---- internals ---------------------------------------------------- */

  /* In arrival order, so nobody parks in front of a car still braking.
   *
   * The station is the car's OWN stopping distance now rather than a shared
   * constant minus a stagger, because a rival that crosses at 180 needs more
   * road to stop in than one that crosses at 100 and asking both for the same
   * mark is what a servo has to fake its way out of. Which means the stagger
   * can no longer come from the arrival index: two cars can want stations in
   * either order, so it is enforced against the last one handed out instead.
   *
   * The floor is ending.js's and not this file's, and the reserve is why it has
   * to be asked for rather than read: the stack descends, so the room the cars
   * still to come will need is room THIS car has to leave above the near limit.
   * Reserve and stagger step down together, one PARK_GAP per arrival, which is
   * what makes the two constraints consistent instead of competing — whichever
   * of them binds, the next car is still a full PARK_GAP clear of this one. */
  _assignPark(e) {
    const room = this.track.roadEnd - this.track.finishS;
    const want = stopStation(e.car.speed, room);
    const yetToPark = Math.max(0, this._order.length - 1 - this._parked);
    const floor = stopFloor(yetToPark * PARK_GAP, room);
    const behind = this._parked === 0 ? Infinity : this._lastPark - PARK_GAP;
    const s = Math.max(floor, Math.min(want, behind));
    this._parked++;
    this._lastPark = s;
    e.park = {
      s: this.track.finishS + s,
      /* Read off the car at the instant it crosses and then never moved. See
         PARK_GAP above for the spin this replaced. */
      lat: e.car.lat,
    };
  }

  _ensurePlayer(player) {
    if (this._playerEntry && this._playerEntry.car === player) return;
    this._order = this._order.filter(e => !e.isPlayer);
    this._playerEntry = {
      car: player, view: null, driver: null, name: null, isPlayer: true,
      band: 1, bandPlayer: 0, bandPack: 0,
      finished: player.finished, time: player.raceTime, recoveries: 0,
    };
    /* Onto the BACK of the order, because that is where the grid puts the
       player — see GRID. The settle below is what makes this right for a
       player registered mid-race, where position is a fact about `s` and not
       about the grid; on the grid itself the two agree. */
    this._order.push(this._playerEntry);
    this._settle(this._order.length);
  }

  /**
   * Field-wide quantities the per-car band needs, computed once a frame.
   *
   * The trait term is centred on the field rather than on an absolute idea of
   * what an average corner is: the stage is procedural, so its mix of tight
   * and open road is different every seed, and a trait measured against a
   * fixed baseline would quietly hand one car a whole-stage advantage on some
   * layouts. Subtracting the field mean makes the term a pure reshuffle —
   * whatever the road is doing, the car it suits gains exactly what the cars
   * it does not suit lose.
   */
  _field() {
    const n = this.entries.length;
    if (!n) return;
    let sumS = 0, sumT = 0;
    for (const e of this.entries) {
      sumS += e.car.s;
      const f = this.track.frameAt(e.car.s, _fT);
      const tight = smoothstep(0.006, 0.030, Math.abs(f.curv));
      const steep = smoothstep(-0.03, -0.13, f.grade);
      e._trait = e.trait.tight * tight + e.trait.steep * steep;
      sumT += e._trait;
    }
    this._packS = sumS / n;
    /* Referenced to the best-suited car rather than to the field average, so
       the term is never positive. Everything here is a handicap — see PACE —
       and a trait that read above 1 would only be clipped by the ceiling,
       which would quietly delete the advantage half of the effect and leave
       the penalty half. Against the maximum, "good at this corner" correctly
       means losing the least time through it. */
    let maxT = -Infinity;
    for (const e of this.entries) if (e._trait > maxT) maxT = e._trait;
    for (const e of this.entries) e._trait -= maxT;
  }

  /**
   * The band, and — separately — the two independent things it is the sum of.
   *
   * `e.band` is computed exactly as it always was, in the same order, so this
   * is bit-for-bit the same multiplier reaching the same driver. What is new is
   * that the two halves are also carried, slewed on the same clock, because a
   * gate that reads only the sum cannot say which half moved and this project
   * shipped one that did.
   *
   * The halves are independent by construction and not by coincidence. The
   * player term is a function of the gap to the PLAYER; the pack term is a
   * function of the gap to the rival field's own mean, which the player is not
   * a member of. So nothing the player does can move the pack term, and — the
   * failure this exists to close — a rival detached off the back of the field
   * moves the sum by more than the player term can ever be worth (PACK.hold is
   * 0.34 against BAND.catch's 0.05). Read through the sum, that detachment is
   * indistinguishable from the band failing to respond to the player.
   *
   * `approach` is affine in its target, so slewing the halves separately and
   * summing them is the same filter as slewing the sum: `band` and
   * `1 + bandPlayer + bandPack` agree to float rounding, and a probe that
   * cares can check it (tools/race.mjs does, and prints the residual).
   *
   * INSTRUMENTATION ONLY. Nothing in src/ reads these two fields; if that ever
   * changes, the thing to preserve is that `band` is the only value with a vote
   * on how the car drives.
   */
  _rubber(e, player, dt) {
    let target = 1;
    let pTarget = 0, kTarget = 0;
    if (this.rubber && !e.car.finished && !player.finished) {
      const gapS = player.s - e.car.s;      // + = this car is behind
      const ref = Math.max(player.speed, e.car.speed, 10);
      const gapT = gapS / ref;
      if (gapT > 0) {
        pTarget = BAND.catch * smoothstep(BAND.dead, BAND.catchAt, gapT);
        target = 1 + pTarget;
      } else {
        target = 1 - BAND.drop * smoothstep(BAND.dead, BAND.dropAt, -gapT)
          - BAND.dropFar * smoothstep(BAND.dropAt, BAND.dropFarAt, -gapT);
        /* Differenced off the target rather than re-summed, so the half is the
           one the target actually used. Exact in binary: `target` is inside a
           factor of two of 1, so the subtraction is. */
        pTarget = target - 1;
      }
      const dPack = this._packS - e.car.s;  // + = behind the rival field
      kTarget = (dPack > 0 ? PACK.catch : -PACK.hold)
        * smoothstep(PACK.dead, PACK.full, Math.abs(dPack));
      target += kTarget;
    }
    e.band = approach(e.band, target, BAND.rate, dt);
    e.bandPlayer = approach(e.bandPlayer, pTarget, BAND.rate, dt);
    e.bandPack = approach(e.bandPack, kTarget, BAND.rate, dt);
    e.form = approach(e.form, 1 + e._trait * TRAIT_AMP, TRAIT_RATE, dt);
    /* Pace character rides on top of the band: the static hierarchy, then the
       terrain the car happens to be good at, then ±2% wandering over ~150 m
       wavelengths so braking points breathe from corner to corner instead of
       being identical every time the same gap comes around. The product is
       clamped where the driver stops converting speed plan into pace and
       starts converting it into crashes. */
    e.driver.boost = clamp(
      e.band * e.pace * e.form * (1 + e.paceNoise(e.car.s * 0.007) * 0.02),
      0.85, 1.0);
  }

  /**
   * One bubble pass with hysteresis. A car moves at most a few metres per
   * frame, so one pass per step keeps the order current; reset and player
   * registration run enough passes to settle from scratch.
   */
  _settle(passes) {
    const beats = (b, a) => {
      if (b.finished && a.finished) return b.time < a.time;
      if (b.finished !== a.finished) return b.finished;
      return b.car.s > a.car.s + HYST;
    };
    for (let p = 0; p < passes; p++) {
      let moved = false;
      for (let i = 0; i < this._order.length - 1; i++) {
        if (beats(this._order[i + 1], this._order[i])) {
          const t = this._order[i];
          this._order[i] = this._order[i + 1];
          this._order[i + 1] = t;
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  _contacts(dt) {
    const all = this._playerEntry
      ? [this._playerEntry, ...this.entries] : this.entries;
    for (let i = 0; i < all.length - 1; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i].car, b = all[j].car;
        const key = i * 8 + j;
        const ds = a.s - b.s, dl = a.lat - b.lat;
        const overS = C_LEN - Math.abs(ds);
        const overL = C_WID - Math.abs(dl);
        /* The pair stays "in contact" until it is clear by a margin, not the
           instant the boxes separate. Resolution pushes cars just barely
           apart, so without the margin every sustained rub re-arms on
           alternate frames and each re-arm lands another impact's worth of
           kick — one door-to-door straight read as two hundred collisions. */
        if (overS <= -0.35 || overL <= -0.35) {
          this._pairs.delete(key);
          continue;
        }
        if (overS <= 0 || overL <= 0) continue;
        /* The overlap test is flat, so a car with real air under it reads as
           being beside the other one when it is in fact above it. Skip those.
           What this must NOT do is forget the pair, which is what the old
           airborne test did: with the pair cleared, the moment the car came
           down again counted as a fresh touch and landed another impact's
           worth of kick and yaw. That closed a loop — the shove below used to
           lift a car a few centimetres off the crown, the lift cleared the
           pair, the landing re-armed it, and one sustained rub became a
           hammer running at the frame rate. */
        /* Their difference, not their heights. Two cars over the same ramp
           are both two metres up at the same instant and the absolute test
           called that "one is above the other" and switched contact off
           entirely — at the exact moment the camera has pulled back to watch
           them fly side by side, and they interpenetrate. What the test is
           for is one car passing over another, which is a gap between them. */
        if (Math.abs(a.height - b.height) > AIR_CLEAR) continue;
        const fresh = !this._pairs.has(key);
        this._pairs.add(key);
        /* The public count is episodes, not touches: door-to-door racing
           re-establishes geometric contact several times over one exchange,
           and counting each one made a single squabble read as twenty hits. */
        if (fresh && this._clock - (this._lastHit.get(key) ?? -9) > 1.0) {
          this.collisions++;
          this._lastHit.set(key, this._clock);
        }
        this._resolve(a, b, ds, dl, overS, overL, fresh);
      }
    }
  }

  /**
   * Stylised contact, not a physics sim.
   *
   * Position is separated every frame along whichever axis has the smaller
   * overlap, so cars cannot occupy each other. Velocity is treated the way
   * the wall code treats it: the first touch is an impact — restitution and
   * a yaw kick, once — and everything after is a scrub, or a leaning car
   * would collect an impact's worth of impulse on every one of 60 frames.
   */
  _resolve(a, b, ds, dl, overS, overL, fresh) {
    if (overL <= overS) {
      // Side by side: shove apart across the road.
      const side = dl !== 0 ? Math.sign(dl) : (this._crng() < 0.5 ? -1 : 1);
      const push = Math.min(overL, 0.5) * 0.5;
      slide(a, 0, side * push);
      slide(b, 0, -side * push);

      const closing = -(a.vy - b.vy) * side;
      if (closing > 0) {
        const k = closing * (fresh ? 0.85 : 0.5);
        a.vy += side * k;
        b.vy -= side * k;
      }
      if (fresh) {
        const kick = clamp(Math.max(closing, 0) * 0.06 + 0.03, 0.03, 0.2);
        a.r += side * kick;
        b.r -= side * kick;
        const hit = clamp(Math.max(closing, 0) / 8, 0.05, 0.6);
        a.lastImpact = Math.max(a.lastImpact, hit);
        b.lastImpact = Math.max(b.lastImpact, hit);
      }
    } else {
      // Nose to tail: the rear car eats most of the closing speed.
      const rear = ds < 0 ? a : b;
      const front = ds < 0 ? b : a;
      const push = Math.min(overS, 0.5) * 0.5;
      slide(rear, -push, 0);
      slide(front, push, 0);

      const closing = rear.vx - front.vx;
      if (closing > 0) {
        rear.vx -= closing * (fresh ? 0.60 : 0.50);
        front.vx += closing * (fresh ? 0.50 : 0.45);
      }
      if (fresh) {
        // A punt is never square; the glance sends both noses wide.
        const side = dl !== 0 ? Math.sign(dl) : (this._crng() < 0.5 ? -1 : 1);
        rear.r += side * clamp(Math.max(closing, 0) * 0.03 + 0.02, 0.02, 0.22);
        front.r -= side * clamp(Math.max(closing, 0) * 0.02, 0, 0.15);
        const hit = clamp(Math.max(closing, 0) / 9, 0.05, 0.7);
        rear.lastImpact = Math.max(rear.lastImpact, hit);
        front.lastImpact = Math.max(front.lastImpact, hit);
      }
    }
  }

  _updateDelta(dt, player) {
    const i = this._order.indexOf(this._playerEntry);
    const mate = i === 0 ? this._order[1] : this._order[i - 1];
    if (i < 0 || !mate) { this._delta = null; this._deltaMate = null; return; }

    let raw;
    if (this._playerEntry.finished && mate.finished) {
      raw = this._playerEntry.time - mate.time;
    } else {
      /* Time for the chasing car to cover the arc gap at its current pace —
         which is what a split means. Raw distance divided by a constant
         reads nonsense through hairpins, where 30 m of gap is two seconds
         at apex speed and half a second on the straight after. */
      const gapS = mate.car.s - player.s;
      const chaser = gapS > 0 ? player : mate.car;
      raw = gapS / Math.max(chaser.speed, 6);
    }
    /* Snap when the reference car changes — smoothing across an overtake
       would sweep the readout through zero as if the gap collapsed. */
    if (mate !== this._deltaMate) { this._delta = raw; this._deltaMate = mate; }
    else this._delta = approach(this._delta, raw, 3, dt);
  }
}
