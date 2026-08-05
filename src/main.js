/* REDROCK — entry point.
 *
 * Boots the renderer, builds the stage once and runs a fixed-cap loop. The
 * headless harness in tools/ drives this file through `window.__game`, so the
 * control surface at the bottom (pause, render one frame, teleport, warm up)
 * is load-bearing rather than debug convenience.
 */
import * as THREE from 'three';
import {
  Track, buildRoad, buildBerms, buildGuardRail, buildGate, pickRamps,
  buildRampPaint, buildRampSigns,
} from './world/track.js';
import { buildCar, CAR } from './car/mesh.js';
import { Car, MAX_RPM } from './car/physics.js';
import { ChaseCamera } from './car/camera.js';
import { SolidWorld } from './car/camcollide.js';
import { Driver } from './car/driver.js';
import { Input } from './core/input.js';
import { celMaterial, unlitCelMaterial } from './render/cel.js';
import { CelPipeline } from './render/outline.js';
import { clamp, lerp, smoothstep } from './core/util.js';
import {
  buildEnvironment, buildCrowd, appendEarlyRamps, paintSecondBore,
} from './world/environment.js';
import { Effects } from './fx/index.js';
import { Race } from './race/index.js';
import { Countdown } from './race/countdown.js';
import { Ending, stopControl, scrubSpeed } from './race/ending.js';
import { Hud } from './ui/hud.js';
import { Title } from './ui/title.js';
import { Pause } from './ui/pause.js';
import { Audio } from './audio/index.js';

/* Low and raking, from behind the driver's left shoulder for most of the
   descent — long shadows across the road are most of what sells a desert
   afternoon, and a sun overhead gives none. */
const SUN_OFFSET = new THREE.Vector3(-150, 125, 165);

/* The shadow-side modelling light: the sun's azimuth reversed, and much lower,
   so it rakes vertical faces and all but misses horizontal ones. */
const FILL_OFFSET = new THREE.Vector3(150, 56, -165);

/* shadowDist is a half-extent, so the frustum spans twice this. It is sized
   for texel density, not reach: shadows only matter near the car — the frustum
   follows it — and the fog owns the far field anyway.

   Texel size in the map is not texel size on the ground. The sun sits at 29°
   of elevation, so a texel lands on a horizontal surface stretched by
   1/sin(29°) — a little over double — along the sun's azimuth. At 92 m across
   2048 that is 4.5 cm in the map but 9.2 cm on the road, and a car is
   photographed from nine metres: measured against the composed frame
   (tools/inkprobe.mjs, shadow section) one texel came out about fourteen
   screen pixels across, which is coarse enough to see as a staircase however
   the term is filtered. 4096 halves it in both axes and costs the 4060 about
   a third of a millisecond, which is the cheapest fix available here — the
   alternative levers all trade away shadow reach.

   High went to 8192 when the coast landed. The sun did not move, but the
   casters did: a tall cliff standing right beside the road throws a shadow
   that crosses it at a very shallow angle, and a shallow edge is the case
   where a texel staircase is most visible — the boundary runs nearly along
   the grid instead of across it. Verified by elimination: dropping normalBias
   back to 0.018 changed nothing, doubling the map halved the tread. Measured
   at 0.15 ms a frame on the 4060 against a 16.6 ms budget. Low and medium are
   left alone deliberately; they exist for hardware that cannot afford this,
   and the staircase is the right thing for them to trade away. */
/* The simulation's own clock. Fixed, and the only thing allowed to advance
   the car. Eight substeps is 67 ms of catch-up per frame, comfortably past the
   50 ms the frame time is already clamped to. */
const SUBSTEP = 1 / 120;
const MAX_SUBSTEPS = 8;

/* The launch moment. Deep enough to read as an effect rather than a stutter,
   short enough that the car is back at speed before it lands. The speed floor
   keeps it off a car that dribbled over a lip at walking pace.

   The window is authored in wall-clock seconds and converted, which is the
   whole reason it was five times too long. The envelope below is a function of
   `sinceLaunch`, and that clock runs in *simulation* seconds — so at x0.45 a
   window written as 0.5 s of simulation is 1.1 s of the player's time, and the
   0.50-0.72 s ease-out that shipped came to 1.38 s of it. The brief asks for
   half a second, and the flight is 2.4-2.9 s of simulation, so the dip has to
   end while the car is still climbing; that is intended. Slow motion here is
   the punctuation on the launch, not a mode the flight is played in.

   HOLD and EASE are wall-clock; SIM_HOLD and SIM_EASE are what the envelope
   needs, divided by the scale actually in force across each phase. */
const SLOWMO_DEPTH = 0.55;
const SLOWMO_MIN_SPEED = 26;
const SLOWMO_IN = 0.06;                 // simulation seconds, the ease in
const SLOWMO_HOLD = 0.5;                // wall-clock seconds at full depth
const SLOWMO_EASE = 0.2;                // wall-clock seconds coming back out
const SLOWMO_FLOOR = 1 - SLOWMO_DEPTH;  // x0.45
/* The hold runs entirely at the floor, so its simulation length is the wall
   length times the floor. The ease-out averages the floor and 1 over a
   smoothstep, which is the floor plus 0.5 of the gap. */
const SLOWMO_OUT0 = SLOWMO_IN + SLOWMO_HOLD * SLOWMO_FLOOR;
const SLOWMO_OUT1 = SLOWMO_OUT0 + SLOWMO_EASE * (SLOWMO_FLOOR + (1 - SLOWMO_FLOOR) * 0.5);

/* What a full ramp is worth on the effects' own amplitude axis, where 1 is
   the berm drop the stage already produced and the axis is clamped at 3.6.
   Taken to the top of it with the lip: the car now arrives at the road at
   9-11 m/s of vertical speed instead of 4.4-4.9, which is more than twice the
   energy the old value was chosen against. */
const RAMP_FX_SCALE = 3.6;

const TIERS = {
  low: { dpr: 0.75, shadow: 1536, shadowDist: 30 },
  medium: { dpr: 1.0, shadow: 2048, shadowDist: 38 },
  high: { dpr: 1.0, shadow: 8192, shadowDist: 46 },
};

/* The held finish shot.
 *
 * The lens does not cut and it does not crane. It stops chasing, settles onto
 * a station behind the car and lets the car brake away from it through the
 * arch — so the crossing, the pass under the bunting and the roll to a halt
 * are one unbroken take, which is what the best frame in the game deserves.
 *
 * Every station is on the ROAD FRAME, which is the only reason this is safe
 * on every seed. Measured (tools/finstop.mjs), the ground either side of the
 * gate is wildly different from one stage to the next — on seed 22 it is a
 * gentle metre down on both sides, on seed 1 it falls fourteen metres away
 * ten metres to the left, on seed 7 it does the same on the right. A lens
 * placed at a fixed lateral offset would be standing in mid-air on one seed
 * and inside a hillside on the next. A station on the road frame is above
 * tarmac the car drove over a second ago, on every stage this game can
 * generate, and it needs no occlusion test to prove it — which matters,
 * because the chase camera's occlusion test is in a file this pass may not
 * touch. tools/finish.mjs casts six axes from the held pose anyway and the
 * worst clearance measured on any seed is 17.6 m.
 *
 * How far behind the car the lens stands, and the fence it stands inside.
 *
 * The first version of this was a fixed station, ten metres past the line,
 * aimed at a fixed point at twenty-eight — the mark the servo drives the car
 * to. That is the right shot when the car hits the mark, and measuring it
 * across eight seeds showed how often it does not: 22 m on seed 1, 28 on seed
 * 22, 31.9 on seed 29, 33.5 on seed 34, and 4 on seed 15, where the harness
 * autopilot arrives at the line already in contact with the scenery and the
 * car is stopped by the impact rather than by the servo. A fixed aim would
 * have composed a careful frame of empty tarmac with the car somewhere off
 * the bottom of it.
 *
 * So both stations hang off the car instead, and the composition is stated as
 * a relationship rather than as two numbers: stand this far back from
 * wherever it came to rest and look over it.
 *
 * The distance is set by the field and not by the car. Race parks the
 * arrivals six metres apart in `s`, later arrivals shorter, so with four cars
 * the group is eighteen metres long behind the winner — and the first version
 * of this stood at exactly eighteen, which put the lens in the middle of its
 * own subject. The capture is unambiguous: two rivals cropped by the bottom
 * corners of the frame, a gate pillar filling the left third, and the winner
 * hidden behind the results card. Twenty-six clears the whole group with
 * eight metres to spare and turns the parked field from an obstruction into
 * the foreground.
 *
 * The near limit stops the lens backing through the crowd on a seed where the
 * car stopped early; the finish crowd stands between 26 and 98 m before the
 * line depending on the seed (tools/kfrunin.mjs), so −10 is clear of the
 * nearest of them.
 *
 * ---- and the far limit had to go, because its premise did -------------------
 *
 * It was +6, and it was there to keep the arch in the picture: the gate is 22 m
 * past the line, so a lens at or before +6 has the arch, its chequered soffit
 * and its bunting standing between it and a car that stopped beyond them. That
 * worked because the car could not stop more than 34 m past the line — there was
 * no more road — so "26 m back from the car" was never more than about +8 and
 * the clamp barely bound.
 *
 * `world/track.js` appends 154 m of run-off now and the ending brakes the car
 * down its own stopping distance, so cars come to rest 7 to 134 m past the line.
 * At +6 the lens then stays at the arch while the car recedes: measured on seed
 * 34, the car parks 112.6 m past the line, the lens is pinned 106 m behind it,
 * and the held frame is a carefully composed arch with the entire field a
 * hundred metres away through it. The classification card comes up over an empty
 * road. The capture is unambiguous and it is in shots/finish/34-field.png.
 *
 * The two requirements are now incompatible and one of them has to give: at
 * +134 there is no lens station that is both 26 m off the car and behind a gate
 * at +22. The car wins. A shot of the parked field is the shot — the arch is the
 * frame's foreground when the stop is short enough to allow it, which is still
 * most seeds, and it is in the crossing frame on all of them, which is the
 * moment it was really for. What replaces the clamp is a bound with a reason
 * that cannot expire: the lens stays on the authored road.
 *
 * The composition therefore reads as one relationship and no exceptions —
 * stand 26 m back from wherever it came to rest and look over it — which is
 * what the paragraph above says this shot is, and now it is that on every
 * seed rather than on the ones where the road happened to be short. */
const END_CAM_BEHIND = 26;
const END_CAM_MIN_PAST_LINE = -10;
/* How much road the lens leaves under and behind itself. The held frame is the
   lens looking forward, so nothing behind it is in shot; this is only so the
   lens is standing on pavement rather than hanging off the last row of the
   mesh, which is what `frameAt` clamping would otherwise give it. */
const END_CAM_ROAD_TAIL = 8;
const END_CAM_LAT = 3.0;
const END_CAM_HIGH = 5.5;
/* What the lens looks at: the car's own station and lane, well above its roof.
 *
 * Above, and not at waist height, because the results card is drawn across
 * the middle of the frame and anything the lens is pointed at is behind it.
 * Aiming 7.6 m up tilts the shot enough to put the whole parked field into
 * the bottom third, below the card, and brings the arch beam and the sky in
 * across the top. Measured at 1600x900: the card occupies y343..y674, and
 * every car sits below it.
 *
 * Taken off the ROAD FRAME rather than off `car.pos` directly, which is not
 * fussiness: the car is on its springs, and pointing the lens at a body that
 * is still rocking puts that rock into a held frame with a table of results
 * over it. The road frame under the car has the car's position and none of
 * its suspension. */
const END_AIM_HIGH = 7.6;
/* Back to the base lens. The chase is out at 79 degrees at racing speed and
   the ending is not a racing shot; closing it is the push-in that says so. */
const END_FOV = 62;

const _endPos = new THREE.Vector3();
const _endAim = new THREE.Vector3();
const _endQuat = new THREE.Quaternion();
const _endMat = new THREE.Matrix4();
const _endUp = new THREE.Vector3(0, 1, 0);

class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.clock = new THREE.Clock();
    this.paused = false;
    this.running = false;
    this.fps = 0;
    this._acc = 0; this._frames = 0;
    this._simAcc = 0;         // unspent simulation time, always under one substep
    this._slowmoId = -1; this._slowmoOn = false;
    this._fxLaunchId = 0; this._followed = -1;
    this.time = 0;

    const q = new URLSearchParams(location.hash.slice(1));
    this._manual = location.hash.includes('manual');
    this.tier = TIERS[q.get('tier')] ? q.get('tier') : 'high';
    /* Seed 22 out of a scored sweep of forty-eight (tools/seeds.mjs): no self
       crossing under 26 m of clearance, 5.6 km, 467 m of drop, corner radii
       from 24 m to 250 m, 30% of it straight, and a compact 945 x 1026 m
       basin with the switchback cluster and the fast loop in visibly
       different parts of the map. */
    this.seed = +(q.get('seed') || 22);
    /* A 200 Hz panel will happily let this run at 200 fps and heat the room.
       Cap by default; the cap is a query flag rather than a constant so a perf
       probe can lift it without editing source. */
    this.fpsCap = +(q.get('cap') || 60);
    this._lastFrame = 0;
    /* Frame pacing state — see frame(). `_vsync` is the panel's interval as
       measured, and Infinity until a second callback has arrived, which makes
       the very first frame render rather than be held for a panel nothing has
       measured yet. */
    this._lastRaf = -1;
    this._vsync = Infinity;
    this._vsyncMin = Infinity;
    this._vsyncSeen = 0;
    this._vsyncSum = 0;
    this._vsyncN = 0;
    this._pending = 0;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance', stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, TIERS[this.tier].dpr));
    this.renderer.shadowMap.enabled = true;
    /* PCF, not PCFSoft. A soft shadow edge is a gradient, and a gradient is the
       one thing this look has nowhere to put — the ink pass cannot find an edge
       in it and the quantised bands cannot resolve it, so it just reads as a
       smudge under the car. Comic shadows have a line around them. */
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x8cc8e8);
    /* Aerial perspective has to leave the far masses darker than the sky they
       sit against, or they stop being masses. The old #aec6cb resolved to
       within eight per cent of the sky dome's own value, so anything past
       about a kilometre — headlands, the far side of the basin, the ocean
       bands — was washed to a pale cutout with no silhouette left, and the
       banding painted into those landforms had nothing to show against. This
       colour is a clear step below the dome, and the haze starts far enough
       out that mid-distance hillsides keep their own value. */
    this.scene.fog = new THREE.Fog(0x8fa6b0, 620, 2800);

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.4, 4000);

    /* ?runoff=N overrides how much road is authored past the flag, in metres.
       An instrument, not a setting: 0 rebuilds the stage exactly as it was
       before the run-off landed, which is the control every measurement of
       "did the race change" is taken against. See Track's constructor. */
    const runoffQ = q.get('runoff');
    this.track = new Track(this.seed,
      runoffQ === null ? {} : { runoff: Number(runoffQ) });
    this.buildStage();
    this.buildCars();
    this.effects = new Effects(this.scene, this.track, { seed: this.seed });
    this.race = new Race(this.track, this.scene, { seed: this.seed, material: this.carMat });
    /* The player joins the field here rather than on the first stepped frame.
     *
     * This is the `1ST /3` fix. `Race.fieldSize` is `_order.length`; the
     * player was only ever added by `_ensurePlayer`, which is called from
     * `Race.step`, which the loop below gates on `ran > 0`. Nothing is
     * stepped while the countdown holds the field, so for the whole of the
     * three seconds the game is looked at hardest the HUD read a field of
     * three and the player's position came from `positionOf` returning null
     * and being defaulted to 1. Joining at construction costs nothing and is
     * the same call, made before anybody can see the answer. */
    this.race.join(this.player);

    this.input = new Input();
    this.chase = new ChaseCamera(this.camera);
    const speedFx = q.get('speedfx') !== '0';
    this.chase.shakeEnabled = q.get('shake') !== '0';
    this.chase.speedResponseEnabled = speedFx;
    /* Terrain the chase camera is not allowed behind. Built from the stage
       rather than declared, so it stays true as the environment changes.
       ?camcollide=0 turns it off, which is how the before/after numbers in
       tools/camprobe.mjs are taken from one build. */
    this.solid = new SolidWorld(this.stage);
    this.chase.world = this.solid;
    this.chase.collideEnabled = q.get('camcollide') !== '0';
    this.chase.yawLagEnabled = q.get('camlag') !== '0';
    this.chase.softDutchEnabled = q.get('camdutch') !== '0';
    /* 'chase' follows the car; the rest are capture views that ignore it. */
    this.viewMode = q.has('view') ? q.get('view') : 'chase';
    this.freeCam = this.viewMode !== 'chase';

    /* Each layer can be isolated without rebuilding shaders. post=0 is the
       hard bypass; the other flags retain the shared composite and its one
       linear-to-sRGB conversion. */
    this.pipeline = new CelPipeline(this.renderer, this.scene, this.camera, {
      enabled: q.get('post') !== '0',
      outlines: q.get('ink') !== '0',
      grade: q.get('grade') !== '0',
      vignette: q.get('vignette') !== '0',
      speed: speedFx,
      impact: q.get('impactfx') !== '0',
    });

    /* The start line.
     *
     * Off by default in `manual`, and that is the whole skip story for the
     * instrument suite rather than a special case bolted onto it. `manual` is
     * already the flag that says "a tool is driving this, do not start the
     * loop yourself" — every harness run passes it (tools/harness.mjs
     * defaults `hash` to exactly 'manual') — so a tool that calls driveTo,
     * warp or step has never been held and never will be. ?countdown=1 turns
     * it on for the capture tools that want it; ?countdown=0 turns it off for
     * a human who does not.
     *
     * Belt and braces on top of that: goTo, autopilot and a bot input each
     * end it, so even a tool that somehow enters without `manual` is released
     * on the frame it first asks the world for anything. */
    /* The title screen, on exactly the terms the ending is on.
     *
     * `manual` is already the flag that means "a tool is driving this", and
     * every harness run passes it (tools/harness.mjs defaults `hash` to
     * exactly 'manual'), so no tool ever sees one. ?title=1 turns it on for a
     * capture that wants it; ?title=0 turns it off for a human who does not.
     *
     * This gate matters more than the countdown's or the ending's, and the
     * asymmetry is worth stating. A countdown holds the field for three
     * seconds and an ending waits at the far end of the stage; a title screen
     * sits in front of the GRID, which is where every tool in tools/ begins.
     * A tool that saw one would not photograph a frame mid-animation — it
     * would photograph a car that never moved, for the whole run. So on top
     * of the gate, Title.skip() is sticky and is called by goTo, driveTo,
     * warp, autopilot and restart, which is every way into the world that
     * does not go through a key press. */
    this.title = new Title({ seed: this.seed });
    const wantTitle = q.has('title')
      ? q.get('title') !== '0'
      : !location.hash.includes('manual');
    if (wantTitle) this.title.arm();

    /* The pause menu. Cheaper to make safe than any of the three above,
       because nothing but a rising edge on a key or a gamepad button opens
       it and no tool presses one — see src/ui/pause.js, which owns the
       argument. `enabled` is the same `manual` gate anyway. */
    this.pause = new Pause();
    this.pause.enabled = q.has('pausemenu')
      ? q.get('pausemenu') !== '0'
      : !location.hash.includes('manual');

    this.countdown = new Countdown();
    this._hype = 0;
    const wantCountdown = q.has('countdown')
      ? q.get('countdown') !== '0'
      : !location.hash.includes('manual');
    /* Remembered, because the title has to arm the lights when the player
       finally presses start and the flag is decided here. */
    this._wantCountdown = wantCountdown;
    /* Not on the load frame if there is a title in front of it: the lights
       would count down behind the poster and the race would be released
       before anybody pressed anything. */
    if (wantCountdown && !this.title.active) this.countdown.arm();

    /* The finish, on exactly the same terms.
     *
     * `manual` is already the flag that means "a tool is driving this", and
     * every harness run passes it (tools/harness.mjs defaults `hash` to
     * exactly 'manual'), so no tool is ever stopped at the line unless it
     * asks to be with ?ending=1.
     *
     * The belt and braces underneath that is stickier than the countdown's
     * and has to be. A countdown is over three seconds after a tool starts,
     * so ending it once settles the matter; an ending sits waiting at the far
     * end of the stage for as long as the tool takes to drive there — and
     * dozens of them drive there. So `skip()` latches, goTo, driveTo, warp
     * and autopilot all call it, and only an explicit `arm()` undoes it. */
    this.ending = new Ending();
    this.ending.enabled = q.has('ending')
      ? q.get('ending') !== '0'
      : !location.hash.includes('manual');
    this._endDriver = null;

    /* Race punctuation is a sequence, not continuous furniture. It follows
       the countdown/title dormancy rule: every harness enters through manual,
       so the default tool frame has no accent clock. ?feedback=1 is the
       explicit capture escape hatch, on the same terms as ?countdown=1. */
    this._feedbackWanted = q.has('feedback')
      ? q.get('feedback') !== '0'
      : !this._manual;
    this.hud = new Hud(document.getElementById('hud'), {
      feedbackEnabled: this._feedbackWanted,
    });
    /* `length` here is the extent of the RIDGE the card draws, which is the
       road — run-off included, because the marker travels along it after the
       flag. `finishS` is where the chequered bar stands and what the traffic
       strip counts down to. Both are needed: before this pass the card had only
       one number and used it for both, so its flag sat at the end of the road,
       34 m past the line. With 154 m of road past the line that error is no
       longer a rounding difference. */
    this.hud.setCourse({
      length: this.track.roadEnd,
      finishS: this.track.finishS,
      points: this.track.profile,
    });
    // ?hud=0 for capture runs that want the world unobstructed.
    this.hudOn = q.get('hud') !== '0';
    /* The rivals on the HUD's traffic strip.
     *
     * NOT gated on `manual` the way the countdown and the ending are, and the
     * difference is what kind of thing it is. Those two are sequences that
     * seize the car and the camera, so a tool driving the world must never be
     * held by one. This is continuous furniture — the same kind of object as
     * the elevation card and the dial, both of which every capture in the suite
     * has always drawn. Gating it on `manual` would mean no tool could ever
     * photograph it, which is the hole the ending had to cut ?ending=1 to climb
     * back out of. So it follows ?hud instead: a flag, default on. */
    this.rivalsOn = q.get('rivals') !== '0';

    /* A browser will not let an AudioContext start without a gesture, and a
       context created before one is silently born suspended, so this is armed
       rather than started. Both listeners fire once and either is enough. */
    this.audio = new Audio();
    let woke = false;
    const wake = () => {
      this.audio.start();
      /* Both listeners are `once`, so both can still fire once each — a click
         and then a key. The restart below must not happen twice. */
      if (woke) return;
      woke = true;
      /* And run the lights again from the top, if they are still on.
       *
       * A page that has just loaded has no AudioContext — the browser will
       * not give it one without a gesture — so a countdown that begins on the
       * load frame counts silently, and the tones are half of what the
       * sequence is. This is the first moment there is any sound at all, so
       * it is the first moment the sequence can be what it is for. Guarded on
       * `holding`, so a gesture after the release cannot put the player back
       * on the line, and a gesture during the count costs at most the second
       * or two already spent. */
      if (this.countdown.holding) this.countdown.arm();
    };
    addEventListener('pointerdown', wake, { once: true });
    addEventListener('keydown', wake, { once: true });

    this.s = 30;            // capture-camera position along the stage, metres
    if (this.freeCam) this.placeCamera();
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  buildStage() {
    const t = this.track;
    const root = new THREE.Group();
    this.scene.add(root);
    this.stage = root;

    const roadMat = celMaterial({ vertexColors: true, flatShading: false });
    const rockMat = celMaterial({ vertexColors: true, flatShading: true });
    const timberMat = celMaterial({ color: 0x74522f, flatShading: true });

    /* Built before the road, which is the reverse of the obvious order and is
       deliberate: the terrain is what decides where the tunnel goes, and the
       road has to know, because the surface under a mountain is graded
       differently from the surface in the open. Nothing in the environment
       reads the road mesh, only the centreline, so the dependency runs one
       way. */
    const env = buildEnvironment(t, {
      seed: this.seed,
      sunDirection: SUN_OFFSET,
    });

    /* And the ramps before the road, for the same reason and one more: siting
       needs the terrain, because sun exposure and standing room for the
       pulled-back camera boom are both terrain questions, and the road, the
       berms and the rail all carry the ramp's height term. */
    /* A proxy over the terrain alone, which is all the ramp scan's two
       raycasts can be asked about anyway: the boom test and the sun test are
       both about landform, and the road and berms this excludes are the two
       things that do not exist yet. The stage's own SolidWorld is built from
       the finished stage further down and is the one the camera uses. */
    const envSolid = new SolidWorld(env);
    t.ramps = pickRamps(t, env.userData?.field ?? null, env.userData?.coast ?? null,
      this.seed, {
        bore: env.userData?.tunnel ?? null,
        sunDirection: SUN_OFFSET,
        solid: envSolid,
      });
    /* pickRamps knows only the main bore — its `bore` option is one span and
       track.js is not editable this round — so a ramp it sited inside the
       EARLY bore is dropped here with the veto's own margins, and the early
       scan below refills the opening. */
    const bore2 = env.userData?.tunnel2 ?? null;
    if (bore2) {
      const fade = bore2.fade ?? 16;
      t.ramps = t.ramps.filter(r =>
        !(r.lip > bore2.s0 - 90 - fade && r.foot < bore2.s1 + 40 + fade));
    }
    /* Jumps for the opening — the start is what every viewer sees and it was
       the emptiest stretch of the stage. Same rules as pickRamps with one
       documented relaxation; see appendEarlyRamps. */
    t.ramps = t.ramps.concat(appendEarlyRamps(
      t, env.userData?.field ?? null, env.userData?.coast ?? null, this.seed, {
        bores: [env.userData?.tunnel ?? null, bore2],
        sunDirection: SUN_OFFSET,
        solid: envSolid,
        want: 2,
        existing: t.ramps,
      }));
    t.ramps.sort((a, b) => a.lip - b.lip);
    t.ramps.forEach((r, k) => { r.index = k; });

    const road = new THREE.Mesh(buildRoad(t, { bore: env.userData?.tunnel ?? null }), roadMat);
    road.receiveShadow = true;
    road.name = 'road';
    root.add(road);

    const bermMeshes = [];
    for (const side of [-1, 1]) {
      const berm = new THREE.Mesh(buildBerms(t, { side, bore: env.userData?.tunnel ?? null }), rockMat);
      berm.castShadow = berm.receiveShadow = true;
      berm.name = 'berm' + side;
      root.add(berm);
      bermMeshes.push(berm);
    }
    /* The early bore's floor and gutter, as a colour post-pass over what the
       single-bore builders just made. See paintSecondBore for why this is not
       an edit to buildRoad/buildBerms. */
    if (bore2) {
      paintSecondBore(t, road.geometry, bermMeshes.map(b => b.geometry), bore2);
    }

    /* The pad and the signage, both self-lit, both on their own meshes.
       "A glowing strip" and "so the player sees them coming" are the two
       halves of the brief that a lit material cannot answer: whatever albedo
       it is given, a flat piece of road lands on the road's rung of the value
       ladder, and a board in a cutting lands on the cutting's. Unlit takes
       both off the ladder entirely, which is the only self-lit surface this
       pipeline has and needs nothing added to render/. */
    const padGeo = buildRampPaint(t);
    if (padGeo) {
      const pad = new THREE.Mesh(padGeo, unlitCelMaterial({
        vertexColors: true, flatShading: true,
      }));
      pad.name = 'ramp-pad';
      root.add(pad);
    }
    const signGeo = buildRampSigns(t);
    if (signGeo) {
      const signs = new THREE.Mesh(signGeo, unlitCelMaterial({
        vertexColors: true, flatShading: true, side: THREE.DoubleSide,
      }));
      /* Casting but not receiving: they are unlit, so a shadow landing on one
         would be discarded anyway, and the two thin posts under each board are
         exactly the geometry a shadow map renders as a flicker. */
      signs.castShadow = true;
      signs.name = 'ramp-signs';
      root.add(signs);
    }

    const rail = buildGuardRail(t);
    if (rail) {
      const m = new THREE.Mesh(rail, timberMat);
      m.castShadow = m.receiveShadow = true;
      m.name = 'guardrail';
      root.add(m);
    }

    root.add(buildGate(t, 10));
    /* Taller than the start gate on purpose. The start is looked at from a
       standstill, where 7.6 m frames well; the finish is driven under at speed
       with the chase lens 2.5 m off the road, and at that height the span was
       close enough overhead to fill the top of the frame with its own soffit.
       Another 1.8 m puts the beam above the frame edge on the approach and
       leaves the pylons doing the framing. */
    /* Twelve metres from the end, not thirty. The last canonical stop is at
       s=5570 of 5598, so a gate at 5568 sat two metres *behind* the car with
       the chase lens looking up at its soffit — the climax of the race was the
       underside of a beam. Moved down the road so the same stop has it
       twenty-odd metres ahead and reading as an arch. */
    root.add(buildGate(t, t.gateS, { height: 11.4, finish: true }));

    root.add(env);

    /* After the ramps, and that is the whole reason it is not inside
       buildEnvironment: two of the four places the crowd stands — the ramp
       landings and, through them, the biggest jump on the stage — are facts
       about `t.ramps`, which is chosen from the finished terrain a few lines
       above. Added to the stage rather than to the environment group so it
       sits beside the road and the gates, which is what it belongs with. */
    const crowd = buildCrowd(t, env, { seed: this.seed });
    if (crowd) {
      root.add(crowd);
      this.crowd = crowd.userData.crowd;
    }

    // Where the sea is, for the audio's surf placement. Optional by design:
    // the coast helpers are absent on any stage built without a shoreline.
    this.coast = env.userData?.coast ?? null;
    // Same reason as `coast`: the diagnostics need to ask the terrain what it
    // looks like at a station without rebuilding the stage to find out.
    this.field = env.userData?.field ?? null;

    this.sun = new THREE.DirectionalLight(0xffe6bd, 2.5);
    this.sun.position.copy(SUN_OFFSET);
    this.sun.castShadow = true;
    const sm = TIERS[this.tier];
    /* Clamped, because the high tier now asks for 8192 and that is above the
       floor WebGL2 guarantees. Silently dropping to what the driver can give
       costs a little edge quality; asking for more than it can give fails the
       whole shadow map. */
    const shadowSize = Math.min(sm.shadow, this.renderer.capabilities.maxTextureSize);
    this.sun.shadow.mapSize.set(shadowSize, shadowSize);
    const cam = this.sun.shadow.camera;
    cam.left = -sm.shadowDist; cam.right = sm.shadowDist;
    cam.top = sm.shadowDist; cam.bottom = -sm.shadowDist;
    cam.near = 40; cam.far = 520;
    /* Three does not recompute an orthographic shadow camera's projection for
       you; without this the frustum stays at its ±5 m default no matter what
       the tier asks for. */
    cam.updateProjectionMatrix();
    /* Bias budget follows texel size. At ~2 cm per texel the offsets that a
       ±170 m frustum needed are enormous: a 0.10 normalBias visibly slid the
       contact shadow out from under the tyres, which is most of why the car
       looked pasted onto the road. Small texels need — and tolerate — small
       biases, and cel.js now resolves the filtered coverage to a hard edge,
       which removes the soft margin that used to absorb a sloppy one. */
    /* Raised from 0.018 once the coast landed. A golden-hour sun rakes across
       the hillsides at a very shallow angle, which is the worst case for
       self-shadowing acne, and hardening the filtered coverage to a clean edge
       removed the soft margin that used to absorb it — so the acne stopped
       being a faint gradient and became hard stipple across the grass. This is
       the largest slope bias the contact shadow under the tyres still
       tolerates; above roughly 0.07 it starts to visibly detach. */
    /* Raised again, from 0.05, when the sky fill went up. Acne was always
       there on the coastal bluffs — a low sun raking a steep face is the worst
       case for it and the ink pass hardens the filtered coverage into a clean
       speckle rather than a smudge — but at the old fill level those faces
       were the same near-black as their own shadows and it had nothing to
       show against. Lifting the shaded side by a rung made it a stipple across
       half the frame. Checked against the thing this trades off: the contact
       shadow under the tyres at the 28% stop is still attached at 0.085. */
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.085;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    /* Modelling light for the shaded side, and nothing else.
       A hemisphere fill is a function of the surface normal's vertical
       component alone, so where the sun is occluded every vertical face in the
       frame receives the same light whichever way it points and a cliff has no
       modelling at all. This puts one cool, quantised light low on the
       opposite side of the sky, which is what separates a facet turned toward
       the water from one turned along the road.
       Low, deliberately: at this elevation a horizontal surface barely sees it
       — measured, the sunlit road at the 60% stop moves by under two per cent
       — so it buys azimuthal shape on walls without lifting the ground plane
       or flattening the frames that were already working. It casts no shadow,
       which is affordable only because it is this dim; a brighter one floods
       every cavity in the stage and costs the open frames their darkest
       anchor. */
    this.fill = new THREE.DirectionalLight(0x93a9e6, 0.45);
    this.fill.castShadow = false;
    /* Fixed at the origin rather than tracked to the car: with no shadow map
       there is no frustum to keep over anything, and a directional light is
       only ever a direction. */
    this.fill.position.copy(FILL_OFFSET);
    this.scene.add(this.fill);
    this.scene.add(this.fill.target);

    /* Skylight is deliberately close to neutral. At 0xbcd8ff and 1.15 the blue
       was strong enough to win wherever the albedo was pale and the surface
       tilted up and away from the sun — which is exactly the sand at the road's
       shoulder, so a saturated cyan line traced both edges of the road for the
       whole stage. Nothing in the geometry was ever teal; it was all fill. */
    /* Coastal sky and cliff-grass bounce. The warm sand bounce that used to sit
       here kept the distant headlands reading as desert haze under an otherwise
       blue sky. */
    /* Roughly doubled, and the ground half taken most of the way to black.
       This is the whole shadow-side exposure of the stage: where a cliff
       occludes the sun the direct term is exactly zero, so the sky fill is not
       "ambient", it is the key light, and at 0.9 it was putting every large
       surface in the frame — road, cliff, apron, supports — inside the gap
       between the value ladder's second and third rungs. That gap is a factor
       of 3.4 wide, so the whole shaded world snapped onto rung two and the
       frame became one flat green-black mass with the ink doing all the
       separating. Enough fill to clear rung three costs the open frames very
       little, because there the sun is ten times this and dominates.
       The ground half goes dark rather than up with it. A hemisphere light is
       the only term in this scene with any sense of enclosure — a downward
       facing surface sees the dull half — and that is what keeps the undersides
       of the road deck black while the sky-facing road in a cliff shadow lifts.
       Raising both halves together would have flooded every cavity in the
       stage and cost the open frames their darkest anchor.
       Cooler and less saturated than the old sky colour for the same reason a
       painter cools a shadow: the shaded side now carries most of the frame's
       area at these stops, and it has to sit at a different hue from the lit
       side rather than merely darker, or the picture is monochrome. */
    /* The lower half raised from 0x1b2a22. A hemisphere light gives a vertical
       surface the average of its two halves, so with the ground half at
       near-black every wall in the stage that the single azimuthal fill does
       not happen to rake sat at half of nothing. That is the 52% frame: a cut
       wall filling the left of shot at a value the outlines could not separate
       from. Still dark, still cool, and still well under the sky half — the
       thing this trades against is the cavities, and they only ever see the
       lower lobe. */
    this.scene.add(new THREE.HemisphereLight(0xa9d2ff, 0x3d5058, 2.4));

    /* A second rake, ninety degrees round from the first rather than opposite
       it. One directional fill can only ever model the walls that happen to
       face it, and a stage whose heading turns through a full circle has as
       many walls facing the other way — which is why lifting the 92% frame did
       nothing for the 52% one. Two fills a quarter turn apart cover the whole
       compass between them without the flattening that a directly opposed pair
       gives, and this one is dimmer than the first so the primary shadow-side
       direction still reads. */
    this.fillB = new THREE.DirectionalLight(0x8fb0cf, 0.26);
    this.fillB.castShadow = false;
    this.fillB.position.set(-165, 74, -150);
    this.scene.add(this.fillB);
    this.scene.add(this.fillB.target);
  }

  restoreOverview() {
    if (this._overviewHidden) {
      for (const object of this._overviewHidden) object.visible = true;
      this._overviewHidden = null;
    }
    if (!this._savedFog) return;
    this.scene.fog = this._savedFog;
    this._savedFog = null;
    this.camera.up.set(0, 1, 0);
    this.camera.far = 4000;
    this.camera.updateProjectionMatrix();
  }

  /** Chase view from arc length `this.s`, until a car exists to follow. */
  placeCamera() {
    this.restoreOverview();
    const t = this.track;
    const f = t.frameAt(this.s);

    if (this.viewMode === 'hero') {
      /* Three-quarter view from off the outside of the road, looking back
         across it. Banking, road width and the shape of a corner are all
         invisible from a chase camera and obvious from here. */
      const f2 = t.frameAt(Math.min(t.roadEnd, this.s + 55));
      this.camera.up.set(0, 1, 0);
      this.camera.position.copy(f.pos)
        .addScaledVector(f.flatRight, -(f.width * 0.5 + 26))
        .addScaledVector(f.tan, -22);
      this.camera.position.y += 13;
      this.camera.lookAt(f2.pos.x, f2.pos.y + 1, f2.pos.z);
    } else if (this.viewMode === 'top') {
      this.camera.position.copy(f.pos).addScaledVector(f.up, 34);
      this.camera.up.copy(f.tan);
      this.camera.lookAt(f.pos);
    } else {
      this.camera.up.set(0, 1, 0);
      const back = t.frameAt(Math.max(0, this.s - 10));
      this.camera.position.copy(back.pos)
        .addScaledVector(back.up, 3.6)
        .addScaledVector(back.tan, -1.5);
      /* Aim at the average of several points down the road, not one. A single
         target 26 m ahead swings 50 degrees through a hairpin and throws the
         road you are actually on out of frame; averaging keeps the near road
         planted while still leaning into the corner. */
      const aim = new THREE.Vector3();
      let wsum = 0;
      for (let d = 6; d <= 42; d += 6) {
        const w = 1 / (1 + d * 0.06);
        aim.addScaledVector(t.frameAt(Math.min(t.roadEnd, this.s + d)).pos, w);
        wsum += w;
      }
      aim.multiplyScalar(1 / wsum);
      this.camera.lookAt(aim.x, aim.y + 1.6, aim.z);
    }
    this.sun.target.position.copy(f.pos);
    this.sun.position.copy(f.pos).add(SUN_OFFSET);
    this.sun.target.updateMatrixWorld();
  }

  buildCars() {
    this.carMat = celMaterial({ vertexColors: true, flatShading: true });
    const view = buildCar(0);
    view.root.traverse(o => { if (o.isMesh) { o.material = this.carMat; o.castShadow = true; } });
    this.scene.add(view.root);
    this.playerView = view;

    this.player = new Car(this.track, { palette: 0 });
    this.player.placeAt(34, 0);
    this.player.applyTo(view);
    this.cars = [this.player];
  }

  /** 'chase' | 'top' — the top view is how road, berm and rail alignment gets
      checked, since an oblique shot hides a half-metre disagreement. */
  setView(mode) {
    this.viewMode = mode;
    this.freeCam = mode !== 'chase';
    if (this.freeCam) this.placeCamera();
    else this.chase.started = false;
  }

  overview(height = 0) {
    const t = this.track;
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const f of t.frames) {
      x0 = Math.min(x0, f.pos.x); x1 = Math.max(x1, f.pos.x);
      z0 = Math.min(z0, f.pos.z); z1 = Math.max(z1, f.pos.z);
    }
    const mid = new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2);
    if (!height) {
      // Frame the whole basin whatever size it came out, on the tighter axis.
      const vert = 2 * Math.tan((this.camera.fov * Math.PI) / 360);
      height = Math.max((z1 - z0) / vert, (x1 - x0) / (vert * this.camera.aspect)) * 1.12;
    }
    if (!this._overviewHidden) {
      this._overviewHidden = ['painted-sky', 'distant-mesas']
        .map(name => this.scene.getObjectByName(name))
        .filter(Boolean);
      for (const object of this._overviewHidden) object.visible = false;
    }
    this._savedFog = this._savedFog || this.scene.fog;
    this.scene.fog = null;
    this.paused = true;
    this.camera.position.set(mid.x, (t.startY + t.endY) / 2 + height, mid.z);
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(mid.x, (t.startY + t.endY) / 2, mid.z);
    this.camera.far = 12000;
    this.camera.updateProjectionMatrix();
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.pipeline.setSize(w, h);
    this.hud.resize(w, h, devicePixelRatio);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    /* The one case where the frozen frame has to be redrawn. `frame` stops
       rendering while the menu is up and relies on the compositor holding the
       last image; resizing the drawing buffer throws that image away, so
       without this a player who drags the window while paused gets a black
       screen with a menu on it. One frame of the ocean moving is the price. */
    if (this.pause?.active) this.pipeline.render();
  }

  /**
   * How fast simulation time runs against real time.
   *
   * The launch is the one moment on the stage where the player has nothing to
   * do and something to look at, and at 174 km/h it is over in under a
   * second. Slowing it to nearly half gives the pullback time to arrive and
   * the flight time to read as a flight.
   *
   * Measured in wall clock — see the constants — because that is the only unit
   * the brief's "0.5 seconds" can mean and it is not the unit `u` is in.
   *
   * A pure function of simulation state — time since the impulse fired, which
   * the car counts in its own scaled seconds — and never of the wall clock.
   * Anything else would make the physics depend on the frame rate, which is
   * what the accumulator above exists to prevent.
   *
   * Once per ramp per run: a second slow-motion off the same lip is a stutter
   * rather than a moment, and a car bouncing over a lip could otherwise
   * retrigger it several times in a row.
   */
  timeScale() {
    const p = this.player;
    if (!p.launched) return 1;
    if (p.launchId !== this._slowmoId) {
      this._slowmoId = p.launchId;
      this._slowmoOn = p.launchSpeed >= SLOWMO_MIN_SPEED && p.launchFirst;
    }
    if (!this._slowmoOn) return 1;
    const u = p.sinceLaunch;
    const w = Math.min(smoothstep(0, SLOWMO_IN, u),
      1 - smoothstep(SLOWMO_OUT0, SLOWMO_OUT1, u));
    return 1 - SLOWMO_DEPTH * w;
  }

  /**
   * Put the simulation clock back to a whole substep.
   *
   * The accumulator normally ends every frame on zero, because every caller
   * steps 1/60 and halving is exact. Slow motion breaks that on purpose — a
   * scaled frame is not a whole number of substeps — so a run can end with up
   * to 8 ms of unspent simulation time on the clock, and the next run then
   * starts from a different phase and plays out differently. Anything that
   * begins a run has to clear it, or "the same seed twice" is not the same
   * race.
   */
  resetSimClock() { this._simAcc = 0; this._slowmoId = -1; this._slowmoOn = false; }

  step(dt) {
    /* Input first, and before either shell state below, because both of them
       are driven by key EDGES and an edge exists only on the frame it
       happened. Nothing else in this method may run ahead of it. */
    this.input.update(dt);

    /* ---- the shell ------------------------------------------------------
     *
     * Two states that own the whole frame, and each of them is an ABSENCE
     * rather than a mechanism, which is the same shape as the countdown's
     * hold: no substep runs, so nothing integrates; the race clock cannot
     * advance because `Car.step` is where race time is counted and it is not
     * called; no effect, no crowd, no pipeline and no audio parameter is
     * stepped, because every one of those calls is below this line.
     *
     * And no time is banked. `this._simAcc` is only ever added to further
     * down, so a paused second cannot arrive as a step of simulation on the
     * frame after it; the frame's own `dt` has already been taken off the
     * wall clock by `Game.frame`, which calls `clock.getDelta()` before it
     * calls this and on every frame whether or not this method does anything
     * with the answer. That is the whole of the no-dump argument and it is
     * structural rather than a correction applied on resume.
     *
     * `Game.paused` is a DIFFERENT thing and both are load-bearing: that flag
     * is the harness's, meaning "a tool has the wheel and is stepping this by
     * hand", and it stops `frame` calling this method at all. `this.pause` is
     * the player's menu. A tool sets the first and can never open the second.
     */
    if (this.title.active) return this.stepTitle(dt);
    if (this.pause.active) return this.stepPause(dt);
    if (this.pause.enabled && this.input.pausePressed) {
      this.openPause();
      /* Stepped at zero on the opening frame so the HUD has the menu's
         payload immediately; without it the first drawn frame of a pause is
         the racing HUD with no plate on it.
         `true` is THE OPENING FRAME, and without it the menu could not be
         opened at all on any device: stepPause reads this same still-true
         edge as Escape-to-resume, takes RESUME on the line after, and closes
         the menu inside the frame that opened it. Zero visible frames, every
         press, every platform. Gated by tools/pausekey.mjs. */
      return this.stepPause(0, true);
    }

    this.time += dt;
    /* One key, THREE answers, and which one it gives depends on what owns the
       car. Mid-race R is the unstick it has always been; on the results card it
       is the way out, which until now did not exist at all — the only way to
       race again was to reload the page. Between those two it does nothing.
       See `raceOver`, which is where the third answer is argued; the short
       version is that `!canRestart` is not a synonym for "mid-race" and using
       it as one respawned the player in the middle of their own ending. */
    if (this.input.resetPressed) {
      if (this.ending.canRestart) this.restart();
      else if (!this.raceOver) this.respawn();
    }

    const p = this.player;
    p.lastImpact = 0;
    p.landingForce = 0;
    const boostBefore = p.boostTimer;

    /* The start line.
     *
     * Fed the frame's own dt, which is WALL time — see race/countdown.js.
     * Three seconds means three seconds however the simulation clock is
     * running, and this project has lost a round to exactly that distinction.
     *
     * A bot on the wheel releases it: every capture that drives itself in is
     * a tool, and a tool must never be held. */
    const cd = this.countdown;
    if (cd.alive) {
      if (this.input.skipPressed || this.bot || this.botInput) cd.skip();
      else cd.update(dt, this.input.throttle);
    }
    /* The whole of the hold, and it is an absence rather than a mechanism:
       no substep runs, so nothing integrates. The player and all three rivals
       are released on one frame because they are released by the same `if`,
       and neither the player's race clock nor anyone else's can advance,
       because `Car.step` is where race time is counted and it is not called. */
    const holding = cd.holding;
    /* Fixed 120 Hz substeps. The tyre model stiffens as slip grows, and at a
       variable 60 Hz a hard kerb strike can integrate into a slip angle the
       next frame cannot recover from — the car snaps. Substepping costs very
       little here and removes the class of bug entirely.
     *
     * An accumulator rather than `ceil(dt / H)` substeps of `dt / sub`. That
     * older form is not a fixed step at all — it is "at least 120 Hz", and
     * the step it actually uses is a function of the frame time. It has held
     * up only because every tool calls step(1/60) and gets exactly two
     * substeps of exactly 1/120. The moment anything asks for a scaled dt —
     * which is what the slow-motion envelope below is — the substep size
     * starts varying with it, and determinism, which several gates rest on,
     * goes with it. Here the substep is 1/120 and nothing changes that; what
     * varies is how many of them a frame runs.
     *
     * At the 1/60 every tool uses this is bit-for-bit what it replaces:
     * halving is exact in binary, so the accumulator lands on zero. */
    const simDt = holding ? 0 : dt * this.timeScale();
    this._simAcc += simDt;
    let n = 0;
    while (this._simAcc >= SUBSTEP && n < MAX_SUBSTEPS) {
      const input = this.driverInput();
      p.step(SUBSTEP, input);
      /* The ending's scripted retardation, and the only thing in this loop
         that is not the car simulating itself. Off — the field is absent —
         on every frame of every race up to the flag, so nothing before the
         line changes. See scrubSpeed for why the brakes need the help. */
      if (input.scrub) scrubSpeed(p, input.scrub, SUBSTEP);
      this._simAcc -= SUBSTEP;
      n++;
    }
    /* Fell behind — a stall, a tab restored, a breakpoint. Simulating the
       backlog would be a car teleporting through whatever it was about to
       hit; dropping it is a lost moment, which is what actually happened. */
    if (n >= MAX_SUBSTEPS) this._simAcc = 0;
    /* How much simulation time this frame was worth, which is what everything
       downstream of the car has to advance by. Not the frame's dt: in slow
       motion those differ by nearly half. */
    const ran = n * SUBSTEP;
    /* And how far past that last substep the wall clock has got. The
       simulation only moves in whole substeps; the display does not, and the
       difference between the two is what the eye reads as the whole field
       shimmering. Everything visual is drawn at this phase — see
       Car.applyTo, which owns the explanation. Zero at the 1/60 every tool
       drives, so nothing the suite measures moves. */
    const alpha = this._simAcc / SUBSTEP;

    /* Before the impact block below, deliberately: contact with another car
       raises p.lastImpact, so running the field first gets camera shake and
       impact audio out of a rival tapping you for free. */
    if (ran > 0) this.race.step(ran, p);
    /* Always consumed, including while a tool or bot has the wheel, so a rank
       change can never wait in Race and fire later when control is returned. */
    const positionChange = this.race.takePositionChange();
    const boostStarted = p.boostTimer > boostBefore + SUBSTEP;
    const feedbackEnabled = this._feedbackWanted
      && !this.bot && !this.botInput && !p.finished;
    if (this.hud.feedbackEnabled !== feedbackEnabled) {
      this.hud.setFeedbackEnabled(feedbackEnabled);
    }
    const feedbackLive = feedbackEnabled && !holding;
    /* Unconditional, unlike the step above: the render phase advances on
       every frame including the ones that ran no substep, and the field has
       to be drawn at the same phase as the player or it judders against him. */
    this.race?.applyViews(alpha, p);

    /* The finish.
     *
     * Fed the frame's own dt, which is WALL time — see race/ending.js. The
     * presentation is in the player's seconds however the simulation clock is
     * running, and this project has lost a round to exactly that distinction.
     * The stop itself is not on this clock or any other; it is authored in
     * metres and read back off the car.
     *
     * After the field has been stepped, not before, so the standings the card
     * reads and the parking station the servo aims at are both this frame's.
     * That costs the sequence one frame of latency at the crossing — about
     * half a metre at racing speed — against reading a table that is a frame
     * out of date for as long as it is up. */
    /* One classification a frame, shared. The ending reads it for the results
       card and the HUD reads it for the traffic strip; two calls would allocate
       the same four rows twice for the same answer. Taken here, after the field
       has been stepped, so both consumers see this frame's order. */
    const standings = this.race.standings();
    this.ending.update(dt, {
      finished: p.finished,
      standings,
      lineS: this.track.finishS,
    });
    const endTone = this.ending.takeTone();
    if (endTone) this.audio.finishTone(endTone, this.ending.won);

    /* Automatic unstick. The AI has had one since the race system landed —
       race/index.js recovers a stranded bot after 2.5 s — but the player had
       nothing except an R key they have no way of knowing about, so a spin
       that ended up facing the wrong way was simply the end of the run.
       Four seconds rather than the AI's 2.5: a human may be deliberately
       reversing out of something and should be allowed to try first.
       recover() rather than respawn() because it keeps part of the car's pace,
       which costs the player far less flow than being set down at a standstill.

       Not while the ending has the car. `strandedFor` counts a car that is
       stopped, and stopped is exactly what the ending has spent two seconds
       arranging — so left in, the rescue teleported the car eight metres back
       up the road four seconds into the results card, and reset the chase
       camera underneath a held shot while it was at it. */
    if (!this.ending.holding && p.strandedFor > 4) {
      p.recover();
      this.effects.reset();
      this.chase.started = false;
    }

    this.pipeline.update(dt, { speed: p.speed });
    if (p.lastImpact > 0.02) {
      const impactSide = p._contact ? Math.sign(p.vy || -p.lat) : 0;
      this.chase.addShake(p.lastImpact, impactSide);
      this.pipeline.addImpact(p.lastImpact, impactSide);
    }
    p.applyTo(this.playerView, alpha);

    /* Tell the effects how big the jump is, on the frame the lip is crossed
       and before they are stepped, because the take-off scuff is thrown on
       the same rising edge of `airborne` that the launch produced. Without
       this the landing is inferred from the flight, and the inference is
       deliberately conservative — the ramp knows its own size and the flight
       can only be measured after it is over. */
    if (p.launchId !== this._fxLaunchId) {
      this._fxLaunchId = p.launchId;
      this.effects.armLanding(1 + (RAMP_FX_SCALE - 1) * smoothstep(26, 48, p.launchSpeed));
    }
    /* Rivals throw dust too, and over a ramp that matters more than usual:
       the camera is pointed at a car that is not the player for most of the
       flight. Idempotent, so this is cheap to keep true as the field changes
       rather than wiring it once and hoping. */
    const field = this.race?.entries ?? [];
    if (field.length !== this._followed) {
      this._followed = field.length;
      this.effects.follow(field.map(e => e.car));
    }
    this.effects.update(ran, p, this.camera);

    /* Simulation time, not the wall clock: the crowd's loop then slows with
       the ramp slow-motion along with everything else, a paused frame is
       genuinely still, and two renders of it are the same image. The car's
       own position is what the proximity reaction keys off — not the
       camera's, which is ten metres adrift and points elsewhere entirely in
       the capture views. */
    /* On the line the simulation is stopped and the crowd is not: they are
       the only thing moving in the frame, which is most of why the wait is
       worth watching. `dt` is the right clock for those three seconds
       precisely because nothing else is running — there is no time dilation
       from a standstill, so wall and simulation agree — and the moment the
       lights go out it is back on `ran` with everything else. */
    this.crowd?.update(p.pos, holding ? dt : ran);
    /* One uniform, written only when it changes, so a build with no countdown
       never touches the crowd at all. */
    if (this._hype !== cd.hype) {
      this._hype = cd.hype;
      this.crowd?.setHype(this._hype);
    }

    // Keep the sun's shadow frustum over the car rather than over the origin.
    this.sun.position.copy(p.pos).add(SUN_OFFSET);
    this.sun.target.position.copy(p.pos);
    this.sun.target.updateMatrixWorld();

    if (!this.freeCam) {
      this.chase.update(p, dt, { lookBack: this.input.lookBack });
      this.holdCamera(this.ending.camera, this.ending.lensPush);
    }

    /* lastImpact is zeroed at the top of step and raised by each substep, so
       this reads the worst hit of the frame rather than whatever the final
       substep happened to see. */
    /* Revs on the line.
     *
     * `Car.rpm` is derived from road speed, so a stationary car idles however
     * hard the throttle is held and the physics is not this task's to change.
     * The countdown therefore keeps a display rev counter, and it is a
     * display quantity in the strict sense: it is handed to the audio and the
     * HUD and to nothing else, it exists only while `holding`, and on the
     * release frame both go straight back to reading the car. Holding the
     * throttle against the limiter for three seconds is half the pleasure of
     * a start line and it costs the simulation nothing. */
    const revs = cd.displayRev;
    const carRpm = p.rpm / MAX_RPM;
    const rpmOut = revs === null ? carRpm : Math.max(carRpm, revs);
    const throttleOut = holding ? cd.throttle : p.throttle;

    const tone = cd.takeTone();
    if (tone) this.audio.startTone(tone === 'go');

    this.audio.update(dt, {
      speed: p.speed, rpm: rpmOut, gear: p.gear,
      throttle: throttleOut, brake: p.brake, handbrake: p.handbrake,
      slipAngle: p.slipAngle, wheelSlip: Math.max(...p.wheelSlip),
      offRoad: p.offRoad, airborne: p.airborne, landingForce: p.landingForce,
      boostTimer: feedbackLive ? p.boostTimer : 0,
      ...this.coastState(p),
    });
    if (feedbackLive && boostStarted) this.audio.boostTone(rpmOut);
    if (feedbackLive && positionChange) this.audio.positionTone(positionChange.direction);
    if (p.lastImpact > 0.02) this.audio.impact(p.lastImpact);

    if (feedbackLive && positionChange) this.hud.positionChange(positionChange);
    this.hud.update(dt, {
      speed: p.speed, rpm: rpmOut, gear: p.gear,
      position: this.race.positionOf(p) ?? 1,
      fieldSize: this.race.fieldSize,
      /* Against `roadEnd`, because `progress` is where the marker goes on the
         card and the card's ridge is the road. The finish is a separate mark at
         a separate station; see setCourse. */
      time: p.raceTime, progress: p.s / this.track.roadEnd,
      delta: this.race.deltaFor(p), finished: p.finished,
      countdown: cd.display(),
      ending: this.ending.display(),
      /* The whole of the rivals wiring. `Race.standings()` is the accessor that
         already exists and already carries everything the strip needs — each
         car's arc length, whether it is the player, and the Car itself for its
         livery index — so nothing in race/ had to move. */
      rivals: this.rivalsOn ? standings : null,
      /* Both null for the whole of every race, which is what makes the HUD
         provably the HUD it was on every frame of one (tools/hudparity.mjs).
         Passed explicitly rather than left off the struct because `Hud.update`
         is an Object.assign onto persistent state: a field that is simply
         absent keeps whatever it was last given, so coming back from the
         title would leave the poster drawn over the grid forever. */
      title: null,
      pause: null,
    });
  }

  /* ---- the shell: title screen and pause menu ---------------------------- */

  /**
   * One frame of the title screen.
   *
   * The car is where the constructor set it down and the world is built; all
   * that happens here is the lens moving, the crowd breathing and the poster
   * arriving. Nothing is stepped.
   */
  stepTitle(dt) {
    this.title.update(dt);
    /* Enter starts. `skipPressed` is in the test as well because Enter is on
       both lists and a player who has come back to the title from a pause
       menu should not have to discover a second key. */
    if (this.input.confirmPressed || this.input.skipPressed) return this.startRace();
    this.titleCamera();
    /* The crowd is the only thing moving in the frame apart from the lens,
       and that is most of why the shot is worth looking at. `dt` is the right
       clock for exactly the reason it is during the countdown's hold: nothing
       else is running, so there is no time dilation and wall and simulation
       agree. The car's own position is what the proximity reaction keys off. */
    this.crowd?.update(this.player.pos, dt);
    /* Speed zero so the needle spring settles while the poster is up: the
       dial is not drawn here, but a player who comes back to the title from
       160 km/h and starts again should not launch with a sprung needle. */
    this.hud.update(dt, {
      speed: 0, countdown: null, ending: null, pause: null,
      title: this.title.display(),
    });
  }

  /**
   * Where the lens stands on the title screen.
   *
   * Every station is an offset on the ROAD FRAME, which is the only reason
   * this is safe on every seed — see src/ui/title.js and the held finish shot
   * above, which own the argument between them. The offsets themselves are a
   * pure function of the title's own clock, so this pans smoothly and two
   * calls at the same time give the same pose.
   *
   * The scratch vectors are the finish shot's. Nothing else can be using them:
   * `holdCamera` runs only while the ending is holding, and an ending cannot
   * be running on a title screen.
   */
  titleCamera() {
    const t = this.track, p = this.player;
    const st = this.title.station();
    const camS = clamp(p.s - st.back, 6, t.roadEnd - 10);
    const f = t.frameAt(camS);
    _endPos.copy(f.pos)
      .addScaledVector(f.flatRight, st.lat)
      .addScaledVector(f.up, st.high);
    const fa = t.frameAt(clamp(p.s + st.ahead, 0, t.roadEnd));
    _endAim.copy(fa.pos).addScaledVector(fa.up, st.aimHigh);
    _endMat.lookAt(_endPos, _endAim, _endUp);
    this.camera.up.set(0, 1, 0);
    this.camera.position.copy(_endPos);
    this.camera.quaternion.setFromRotationMatrix(_endMat);
    if (Math.abs(this.camera.fov - st.fov) > 0.01) {
      this.camera.fov = st.fov;
      this.camera.updateProjectionMatrix();
    }
    // The shadow frustum follows the car here too, or the title shot is lit
    // by a map centred on the origin a kilometre away.
    this.sun.position.copy(p.pos).add(SUN_OFFSET);
    this.sun.target.position.copy(p.pos);
    this.sun.target.updateMatrixWorld();
  }

  /** Off the title and onto the grid. */
  startRace() {
    this.title.skip();
    /* A full restart rather than "just arm the lights". The world is already
       fresh on the first pass, but this is also the path back from TO TITLE
       and from a title reached after a finished race, and a start that is
       subtly not the same start is the failure mode every determinism gate in
       tools/ exists to catch. restart() is the one place that knows the whole
       list. */
    this.restart();
    if (!this._wantCountdown) this.countdown.skip();
    /* The title lens is nowhere near the chase pose. Clearing `started` makes
       the chase snap to its own pose on the next frame instead of gliding out
       of a composed shot, and it is the same call restart() and every
       teleport already make. */
    this.chase.started = false;
  }

  /**
   * One frame of the pause menu.
   *
   * Reads edges, moves a cursor, and hands the HUD a payload. It does not
   * step anything, which is the point, and it is the only method in this file
   * that calls `Hud.update` with a dt of zero — the needle spring is the one
   * piece of state in the HUD that remembers anything, and a paused needle
   * that kept springing would be a moving instrument on a frozen frame.
   */
  stepPause(dt, opening = false) {
    this.pause.update(dt);
    const i = this.input;
    if (i.menuUpPressed) this.pause.move(-1);
    if (i.menuDownPressed) this.pause.move(1);
    /* Escape out, R to restart, Enter to take the cursor's item. The two
       shortcuts are here because they are the two a player already knows from
       everywhere else in this game — R has been the restart key since the
       results card landed — and because a menu that can only be operated one
       way is a menu you have to look at.
       `opening` is the frame the press ARRIVED on, where this same edge is
       what put the menu up a few lines ago in `step` and must not also take
       it down. Suppressed HERE, by the consumer, rather than by clearing
       `input.pausePressed` at the call site: that reads as the tidier
       one-liner and it silently breaks the input layer's contract, which is
       that an edge flag is what the DEVICE did this frame. tools/pad.mjs
       reads exactly that flag after Game.step to prove the pad emits one edge
       per press however long Start is held, and a consumed flag turned its
       measurement into a vacuous 0 == 0. Measured, both halves, in
       .fix/FINDINGS-pause.md. */
    if (i.pausePressed && !opening) this.pause.choose('RESUME');
    else if (i.resetPressed) this.pause.choose('RESTART');
    else if (i.confirmPressed) this.pause.confirm();

    const act = this.pause.take();
    if (act === 'RESUME') this.closePause();
    else if (act === 'RESTART') { this.closePause(); this.restart(); }
    else if (act === 'TO TITLE') { this.closePause(); this.toTitle(); }

    /* Zero, not `dt`: see above. The payload is null the moment the menu
       closed, so the frame after a resume is the racing HUD again. */
    this.hud.update(0, { pause: this.pause.display() });
  }

  /**
   * Stop.
   *
   * The simulation is stopped by `step` returning early and the world stops
   * being drawn by `frame` — see both. The only thing that needs doing here
   * is the audio, and it needs doing explicitly: every other subsystem in
   * this game advances because something calls it, but a Web Audio graph is
   * running on its own thread and will happily keep the engine droning over a
   * frozen picture.
   *
   * `Audio.stop()` suspends the context, which is the correct instrument and
   * not merely the cheap one. A suspended AudioContext does not advance
   * `currentTime`, and every parameter in this engine is written against
   * `ctx.currentTime` through setTargetAtTime — so nothing that was scheduled
   * lands while the menu is up, no envelope runs to its end unheard, and on
   * resume the graph picks up at exactly the phase it was suspended at rather
   * than fast-forwarding through however long the player was reading a menu.
   * That is the audio half of "no step of accumulated time dumped into the
   * first frame", and like the simulation half it is structural.
   */
  openPause() {
    if (!this.pause.open()) return;
    this.audio.stop();
  }

  /** Go. */
  closePause() {
    this.pause.close();
    /* Resume rather than rebuild: start() on an existing context only calls
       resume(), so the graph, its buffers and its scheduled ramps are the
       ones that were there. */
    this.audio.start();
  }

  /**
   * Back to the poster.
   *
   * A full restart first, so the stage behind the title is the grid and not
   * wherever the run got to — the title camera stands fifteen metres behind
   * the car, and behind a car that stopped in a ditch it is in the ditch. The
   * lights are then explicitly skipped: a countdown counting down behind a
   * title screen would release the field the moment the poster was dismissed.
   */
  toTitle() {
    this.restart();
    this.countdown.skip();
    this.title.arm();
  }

  /**
   * Blend the chase camera onto the held finish pose.
   *
   * A post-process on whatever ChaseCamera just produced, and never a
   * replacement for it — which is not only because that file is fenced this
   * pass. Overwriting position and calling lookAt would throw away the dutch
   * roll, the shake and the boom's occlusion state on the frame the blend
   * starts, so the ending would open with a jump cut of its own. Blending the
   * position and slerping the quaternion means `k = 0` is bit-for-bit the
   * chase, and every frame after it is a proportion of a move.
   *
   * `k` is an absolute blend and not a per-frame lerp rate, so this is frame
   * rate independent: the chase writes the camera fresh every frame and
   * nothing accumulates here.
   *
   * @param {number} k 0 at the chase pose, 1 at the held one
   * @param {number} push degrees off the held lens, for the slow push in
   */
  holdCamera(k, push = 0) {
    if (!(k > 0)) return;
    const t = this.track;
    const p = this.player;
    const line = t.finishS;
    /* Both stations off the car. Stateless and read fresh every frame, so
       this pans with the car as it rolls to a halt and is then perfectly
       still because the car is — no smoothing to tune, and two renders of a
       stopped car are the same image, which the capture tools require. */
    const camS = clamp(p.s - END_CAM_BEHIND,
      line + END_CAM_MIN_PAST_LINE, t.roadEnd - END_CAM_ROAD_TAIL);
    const f = t.frameAt(camS);
    _endPos.copy(f.pos)
      .addScaledVector(f.flatRight, END_CAM_LAT)
      .addScaledVector(f.up, END_CAM_HIGH);
    const fa = t.frameAt(p.s);
    _endAim.copy(fa.pos)
      .addScaledVector(fa.flatRight, p.lat)
      .addScaledVector(fa.up, END_AIM_HIGH);
    _endMat.lookAt(_endPos, _endAim, _endUp);
    _endQuat.setFromRotationMatrix(_endMat);

    this.camera.position.lerp(_endPos, k);
    this.camera.quaternion.slerp(_endQuat, k);
    const fov = lerp(this.chase.fov, END_FOV - push, k);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * What drives the car once the race is over.
   *
   * Steering from a Driver and pedals from the servo, which is the same
   * division of labour Race uses for a rival that has finished. Neither half
   * can do the other's job: the servo is the only thing that knows where the
   * car is supposed to stop, and the Driver is the only thing that knows the
   * road is still turning and still crowned underneath it.
   */
  endingInput() {
    const p = this.player;
    const park = this.race?.parkFor(p);
    const line = this.track.finishS;
    /* The station Race hands out, or the servo's own, for the one frame between
       the car crossing and the field being stepped. Both derive it the same way
       — from the speed the car crossed at against the road there is past the
       line — so the handover is not a step in the target. */
    const targetS = park
      ? park.s
      : line + this.ending.servo.station(this.track.roadEnd - line, p.speed);
    if (!this._endDriver) {
      this._endDriver = new Driver(this.track, { skill: 0.7, lane: 0, seed: 3 });
    }
    this._endDriver.lane = park ? park.lat : 0;
    const steer = this._endDriver.drive(p, SUBSTEP).steer;
    /* SUBSTEP and not the frame's dt: this is called once per substep from
       the loop in step(), so a substep is exactly the interval the servo's
       observer has to difference the speed over. */
    return { steer, ...this.ending.servo.control(p.speed, targetS - p.s, p.s - line, SUBSTEP) };
  }

  /**
   * Back to the grid, from the results card.
   *
   * Everything a fresh race needs put back, in one place, because the failure
   * mode of a restart is not a crash — it is a second race that is subtly not
   * the same race, which is the thing every determinism gate in tools/ exists
   * to catch. The simulation accumulator is cleared for the reason
   * resetSimClock documents; the car's own clock and finished flag are, since
   * placeAt deliberately does not touch either.
   */
  restart() {
    /* A restart is a race, not a menu. Sticky-off rather than untouched,
       because tools/zjdet.mjs and everything modelled on it call restart()
       as the first thing they do — "back to the grid, and this is the whole
       point of the tool" — and a restart that left a poster up would step
       sixty seconds of a car that never moved. `toTitle` arms it again
       afterwards, which is the only caller that wants one. */
    this.title.skip();
    this.pause.close();
    this.resetSimClock();
    const p = this.player;
    p.placeAt(34, 0);
    p.finished = false;
    p.raceTime = 0;
    p.vertVel = 0; p.height = 0;
    this.race.reset(34);
    this.race.join(p);
    this.hud.clearFeedback();
    this.effects.reset();
    this.chase.started = false;
    this._endDriver = null;
    this.ending.reset();
    this.countdown.arm();
  }

  /** Hand the player car to the AI driver — how the physics gets tuned. */
  autopilot(on, skill = 0.85) {
    // Nothing driven by a machine is ever held on the line, at it, in
    // front of it behind a title screen, or behind a pause menu.
    if (on) {
      this.countdown.skip(); this.ending.skip(); this.title.skip();
      this.pause.close();
    }
    this.bot = on ? new Driver(this.track, { skill }) : null;
    /* Clear, do not merely stop advancing: autopilot may take over halfway
       through a pulse and its very next frame is eligible for capture. */
    this.hud.setFeedbackEnabled(this._feedbackWanted && !on && !this.botInput);
  }

  /** Human input, the AI driver, or whatever a harness has installed. */
  driverInput() {
    if (this.botInput) return this.botInput;
    /* Ahead of the autopilot deliberately. A tool that wants to capture the
       ending has to drive itself to the line to get there, so `bot` is on the
       wheel when the flag falls, and the ending has to be able to take it
       off — otherwise the only run that can see this sequence is one nobody
       can reproduce. */
    if (this.ending.holding) return this.endingInput();
    if (this.bot) return this.bot.drive(this.player, 1 / 120);
    const i = this.input;
    return { steer: i.steer, throttle: i.throttle, brake: i.brake, handbrake: i.handbrake };
  }

  /**
   * The race is over and the ending owns the car — so nothing here may put the
   * car anywhere.
   *
   * This exists because the reset key used to be a two-way branch:
   *
   *     if (this.ending.canRestart) this.restart(); else this.respawn();
   *
   * and the `else` was read as "mid-race". It is not. `canRestart` goes live at
   * the card beat, 1.45 s after the crossing, so for that 1.45 s the ending IS
   * running and the answer is false, and a false answer did not mean "ignore R"
   * — it meant respawn. Measured (`.fix/rkey.mjs`, which presses the key and
   * looks at the car rather than reading this predicate): on every one of five
   * seeds, R pressed on the crossing frame took a finished car doing up to
   * 188 km/h and set it down stopped twelve metres back up the road, with the
   * ending still running and the held lens still gliding onto it. Written up in
   * .fix/FINDINGS-endgap.md §2.
   *
   * The state has three cases and the old branch only had two. During an ending
   * the race is neither in progress nor yet restartable, and the honest answer
   * for that window is to do nothing at all: the player has no wheel — see
   * `driverInput`, which hands the car to `endingInput` on this same condition —
   * so there is nothing to be unstuck from, and 1.45 s later R does what whoever
   * pressed it wanted anyway.
   *
   * `ending.holding` and not `player.finished`, and the difference is real. With
   * the ending disabled or skipped the player keeps the wheel past the line and
   * keeps driving, and R there is still the only unstick they have. What
   * disqualifies the respawn is not that the race is decided, it is that
   * something else is driving. That is the same test `strandedFor`'s automatic
   * rescue already makes in `step`, for the same reason and with the reasoning
   * already written down there.
   */
  get raceOver() { return this.ending.holding; }

  respawn() {
    this.resetSimClock();
    const p = this.player;
    p.placeAt(Math.max(6, p.s - 12), 0);
    p.vertVel = 0; p.height = 0;
    this.effects.reset();
    this.hud.clearFeedback();
  }

  /**
   * One display frame, capped.
   *
   * A capped loop on a vsynced display can only ever deliver refresh/k for a
   * whole number k, so the cap's only real job is to pick k. The rule used to
   * be a threshold on elapsed time — render once `1000/cap - 1.2` ms had
   * passed — which picks the FEWEST vsyncs that reach the budget, and that is
   * the wrong end of the choice on every panel whose refresh is not a
   * multiple of the cap. It also made the answer depend on a 1.2 ms constant
   * that had been tuned against one machine.
   *
   * Measured (tools/vsync.mjs) against a 60 fps cap, the old rule delivered:
   *
   *     60 Hz  60.0     144 Hz  48.0     200 Hz  50.0
   *    120 Hz  60.0     165 Hz  55.0     240 Hz  60.0
   *
   * A 200 Hz panel is the case that motivated this: three vsyncs is 15.0 ms,
   * a whisker under the 15.47 ms threshold, so the loop waited for a fourth
   * and shipped 50 fps — a sixth of the frames the panel was willing to
   * present, on hardware bought not to do that.
   *
   * So the choice is made from the other side — see `_paceK`, which owns it —
   * and the cap becomes a target the loop lands nearest to rather than a floor
   * the panel falls through.
   *
   * Counted in vsyncs rather than tested against a clock. Both are the same
   * rule, but rAF timestamps carry a few hundred microseconds of jitter and a
   * ratio like 240/60 sits exactly on a whole number, so a time comparison
   * decides some of those frames by noise. Counting cannot.
   *
   * The elapsed test that remains is a safety net and bounds the damage from
   * a mis-measured panel: however wrong k is, a frame is never held past the
   * budget, so the worst this can degrade to is the behaviour it replaced.
   */
  /**
   * How many vsyncs make one frame, for a given budget and panel.
   *
   * The whole pacing decision, in one expression, because it is the one thing
   * here worth being able to swap and measure (tools/vsync.mjs drives both
   * candidates through the real loop by substituting this).
   *
   * Nearest, not floor. Floor is the literal "hold a frame only while one more
   * vsync would still fit inside the budget", and it is the wrong half of the
   * rule on any panel between one and two multiples of the cap: it rounds the
   * delivered RATE up without bound, so a 100 Hz panel asked for 60 fps
   * delivers 100, and a 165 Hz one delivers 82.5. That is a two-thirds
   * overshoot of a budget somebody set on purpose, on a machine that is also
   * running something else. Nearest keeps the same shape — hold a frame only
   * while waiting gets you CLOSER to the budget — and bounds the error at half
   * a vsync in either direction. Measured over eleven panels
   * (tools/vsync.mjs), worst overshoot goes from +67% to +25%.
   *
   * On the 200 Hz panel this was reported from the two rules agree exactly, at
   * three vsyncs and 66.7 fps, so nothing about choosing the safer one costs
   * that machine a frame.
   *
   * Where refresh is a whole multiple of the cap — 60, 120, 240, 360 — every
   * candidate agrees and this returns exactly what the old threshold did.
   * Rounding rather than flooring also removes the need for an epsilon: a
   * ratio that comes out of the divide as 3.9999999 rounds to 4 where it would
   * have floored to 3.
   */
  _paceK(period, vsync) {
    if (!(vsync > 0) || !Number.isFinite(vsync)) return 1;
    return Math.max(1, Math.round(period / vsync));
  }

  frame(now) {
    this._raf = requestAnimationFrame(t => this.frame(t));

    /* The panel's interval, as the smallest gap between callbacks rather than
       the last one or the mean. rAF fires once a vsync whether or not this
       loop chose to draw, so the gaps are V while it keeps up and 2V, 3V…
       whenever it does not; every one of those errors is upward, so the
       minimum is the only estimator of the three that a stutter cannot drag
       off the true refresh. Biasing V low is also the safe direction: it can
       only make k larger, and a k that is too large is caught by the elapsed
       test below, where one too small would silently run over the cap.
       Re-taken over a window so that dragging the window to another monitor
       is picked up within about a second rather than never. */
    const prev = this._lastRaf;
    this._lastRaf = now;
    const gap = prev >= 0 ? now - prev : -1;
    if (gap > 0) {
      /* The 1 ms floor rejects a double callback inside one vsync, which would
         otherwise poison a minimum permanently. It cannot reject a real panel:
         a gap under a millisecond is a refresh above 1000 Hz. The window mean
         is carried as a fallback for the case where nothing at all clears the
         floor, so a frame source that fast leaves the cap slack rather than
         leaving `_vsync` unknown and the cap silently off. */
      if (gap >= 1 && gap < this._vsyncMin) this._vsyncMin = gap;
      this._vsyncSum += gap; this._vsyncN++;
    }
    if (++this._vsyncSeen >= 60) {
      if (this._vsyncMin < Infinity) this._vsync = this._vsyncMin;
      else if (this._vsyncN > 0) this._vsync = this._vsyncSum / this._vsyncN;
      this._vsyncMin = Infinity;
      this._vsyncSum = 0; this._vsyncN = 0;
      this._vsyncSeen = 0;
    } else if (this._vsync === Infinity && gap >= 1) {
      // First plausible gap seeds it, so the cap is honoured from frame two.
      this._vsync = gap;
    }

    if (this.fpsCap > 0) {
      const period = 1000 / this.fpsCap;
      const k = this._paceK(period, this._vsync);
      this._pending++;
      if (this._pending < k && now - this._lastFrame < period) return;
      this._pending = 0;
      this._lastFrame = now;
    }
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this._acc += dt; this._frames++;
    if (this._acc > 0.5) { this.fps = this._frames / this._acc; this._acc = 0; this._frames = 0; }
    if (!this.paused) this.step(dt);
    /* THE WORLD IS NOT REDRAWN WHILE THE PAUSE MENU IS UP, and that is not an
     * optimisation — it is the only way to freeze the picture.
     *
     * Three of the environment's vertex animations — the ocean, the grass and
     * the turbines — set their `uTime` uniform from `performance.now()` inside
     * their own `onBeforeRender` (see animateMaterialOnRender in
     * world/environment.js, a file this pass may not edit). Everything else in
     * the game is stepped by a caller and stops when the caller stops, but
     * those three advance on the wall clock every time they are asked to draw.
     * So a pause that kept rendering would show a menu saying PAUSED over an
     * ocean that was still rolling, which is worse than no menu; and the only
     * lever available from here that reaches all three is to stop asking.
     *
     * What the player sees is the last composited frame, which the browser
     * keeps on the canvas until something presents a new one. The HUD is a
     * separate 2D canvas and keeps drawing at full rate, so the menu's own
     * arrival, its cursor and its wash are live over a still picture.
     *
     * It also happens to cost nothing: a paused frame is one 2D redraw and no
     * GL work at all. */
    if (!this.pause.active) this.pipeline.render();
    if (this.hudOn) this.hud.draw();
  }

  /* ---- harness control surface ------------------------------------- */
  begin() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    /* The pacing measurement starts with the loop. A gap taken across the
       gulf between construction and begin() is not a vsync. */
    this._lastRaf = -1;
    this._vsync = Infinity; this._vsyncMin = Infinity; this._vsyncSeen = 0;
    this._vsyncSum = 0; this._vsyncN = 0; this._pending = 0;
    document.getElementById('boot')?.classList.add('gone');
    this._raf = requestAnimationFrame(t => this.frame(t));
  }
  setPaused(p) { this.paused = p; }
  renderOnce() { this.pipeline.render(); }
  /** Teleport to a normalised position along the stage. */
  goTo(t) {
    this.restoreOverview();
    this.resetSimClock();
    /* Teleporting is not a race start. Everything programmatic arrives here
       eventually — driveTo goes through it — so this is the single place that
       guarantees an instrument can never be stopped by the lights. */
    this.countdown.skip();
    this.ending.skip();
    /* And off the title, for the same reason and more urgently: a tool that
       teleports somewhere has asked to be somewhere, and a title screen would
       leave it holding a lens fifteen metres behind a car it just moved. */
    this.title.skip();
    this.pause.close();
    this.hud.clearFeedback();
    this.s = clamp(t, 0, 1) * this.track.length;
    this.player.placeAt(clamp(this.s, 6, this.track.length - 40), 0);
    this.player.applyTo(this.playerView);
    /* Teleporting leaves a trail of smoke and skid marks strung across the
       whole stage between where the car was and where it now is. */
    this.effects.reset();
    this.chase.started = false;
    if (this.freeCam) this.placeCamera();
    else this.chase.update(this.player, 1 / 60, {});
  }
  /* Where the sea is relative to the car, for the audio's surf placement.
     Returns nothing at all when the stage has no coastline or the query fails
     — the audio latches its last known values rather than snapping to a
     default, so an empty object is the correct way to say "no news". */
  coastState(p) {
    const c = this.coast;
    if (!c) return null;
    const shore = c.shoreDistanceAt(p.s);
    const water = c.waterDistanceAt(p.s);
    if (!Number.isFinite(shore) || !Number.isFinite(water)) return null;
    /* Car-relative, not track-relative: the road doubles back on itself at
       every switchback, so the side the sea is on flips even though the
       seaward side of the track has not changed. Projecting onto the car's
       own right vector is what makes the surf stay put in the stereo field
       through a hairpin. */
    const f = this.track.frameAt(p.s);
    const right = f.flatRight ?? f.right;
    const side = c.seaSideAt(p.s);
    return {
      shoreDistance: shore,
      // Pythagoras on the two distances the world exposes; there is no
      // separate sea-level query and this avoids adding one.
      shoreDrop: Math.sqrt(Math.max(0, water * water - shore * shore)),
      oceanSide: clamp(right.dot(p.right) * side, -1, 1),
    };
  }

  /** Advance simulation without rendering, so springs settle before a shot.
      Never against a held field: `warp` means "advance the simulation", and
      during the countdown there is no simulation to advance. */
  warp(sec) {
    this.countdown.skip();
    this.ending.skip();
    /* `warp` means "advance the simulation", and on a title screen or behind
       a pause menu there is no simulation to advance — the loop below would
       spin `sec` seconds of wall clock into a poster's camera move. */
    this.title.skip();
    this.pause.close();
    for (let i = 0; i < sec * 60; i++) this.step(1 / 60);
  }

  /* Arrive at a point on the stage at racing speed instead of parked on it.
     goTo + warp leaves the car stationary — placeAt zeroes velocity and an
     empty input never moves it — so every capture was a still life: no dust,
     no drift, no speed response, nothing the effects or grade work is for.
     Backing up and letting the AI drive in means the shot shows the game. */
  driveTo(t, { runUp = 180, skill = 0.85, maxSec = 30 } = {}) {
    const target = clamp(t, 0, 1) * this.track.length;
    const hadBot = this.bot;
    this.autopilot(true, skill);
    this.goTo(Math.max(6, target - runUp) / this.track.length);
    const limit = maxSec * 60;
    for (let i = 0; i < limit && this.player.s < target; i++) this.step(1 / 60);
    this.s = this.player.s;
    if (!hadBot) this.autopilot(false);
    return this.telemetry();
  }
  info() {
    // The pipeline's snapshot, because renderer.info now describes the
    // full-screen composite rather than the scene.
    const r = this.pipeline?.stats ?? this.renderer.info.render;
    return {
      calls: r.calls, triangles: r.triangles,
      programs: this.renderer.info.programs?.length ?? 0,
      textures: this.renderer.info.memory.textures,
      geometries: this.renderer.info.memory.geometries,
      s: +this.s.toFixed(1),
      ...this.stageStats(),
      car: this.telemetry(),
    };
  }

  telemetry() {
    const p = this.player;
    return {
      kmh: +p.kmh.toFixed(1),
      s: +p.s.toFixed(1),
      lat: +p.lat.toFixed(2),
      slipDeg: +((p.slipAngle * 180) / Math.PI).toFixed(1),
      yawRate: +p.r.toFixed(2),
      gear: p.gear + 1,
      rpm: Math.round(p.rpm),
      air: +p.height.toFixed(2),
      roll: +((p.roll * 180) / Math.PI).toFixed(1),
      pitch: +((p.pitch * 180) / Math.PI).toFixed(1),
      offRoad: +p.offRoad.toFixed(2),
    };
  }

  /** Layout quality, as numbers rather than opinions. */
  stageStats() {
    const t = this.track;
    let maxBank = 0, straightM = 0, minW = 99, maxW = 0;
    const radii = [];
    /* Over the RACE and not the pavement. These are layout metrics — how
       straight the stage is, how tight its tightest corner is — and 120 m of
       deliberately straight, deliberately flat, deliberately wide run-off is
       not layout. Counting it would have added two points to `straightPct` on
       every seed and narrowed `widthRange` for no change to a single corner. */
    for (let i = 0; i < t.courseCount; i++) {
      const f = t.frames[i];
      maxBank = Math.max(maxBank, Math.abs(f.bank));
      if (Math.abs(f.curv) < 0.0015) straightM += 3;
      minW = Math.min(minW, f.width); maxW = Math.max(maxW, f.width);
      if (Math.abs(f.curv) > 0.004) radii.push(1 / Math.abs(f.curv));
    }
    radii.sort((a, b) => a - b);
    return {
      len: +t.length.toFixed(0),
      roadEnd: +t.roadEnd.toFixed(0),
      finishS: +t.finishS.toFixed(0),
      gateS: +t.gateS.toFixed(0),
      runoff: +t.runoff.toFixed(0),
      drop: +(t.startY - t.endY).toFixed(0),
      grade: +(((t.startY - t.endY) / t.length) * 100).toFixed(1),
      knots: t.crossings.length,
      worstKnot: t.crossings.length ? Math.min(...t.crossings.map(c => c.dy)) : null,
      maxBankDeg: +((maxBank * 180) / Math.PI).toFixed(1),
      straightPct: +((straightM / t.length) * 100).toFixed(0),
      radiusP10: radii.length ? +radii[Math.floor(radii.length * 0.1)].toFixed(0) : 0,
      radiusP90: radii.length ? +radii[Math.floor(radii.length * 0.9)].toFixed(0) : 0,
      widthRange: [+minW.toFixed(1), +maxW.toFixed(1)],
    };
  }
}

const game = new Game(document.getElementById('view'));
game.THREE = THREE;
window.__game = game;
if (!location.hash.includes('manual')) game.begin();
