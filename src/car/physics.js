/* Car physics.
 *
 * A two-axle bicycle model with a saturating tyre curve, solved in the car's
 * own frame and then mapped onto the road surface. The obvious cheaper option
 * — steer the velocity vector directly and fake a slide when the handbrake is
 * down — gives a car that cannot be caught once it is sideways, because
 * nothing in it knows what a slip angle is. With real slip angles, opposite
 * lock does what opposite lock is supposed to do, and a drift becomes
 * something you hold rather than something that happens to you.
 *
 * The surface is not flat and that matters more here than in most racing
 * games: the whole stage is a 9% descent, so the in-plane component of gravity
 * is a permanent forward force worth roughly 0.9 m/s². Braking zones exist
 * because of it.
 *
 * Vertical motion is not simulated as a rigid body. Each wheel gets a spring
 * against the surface height beneath it, which drives the visual lean and the
 * load transfer the tyres read — enough for the car to squat, dive and roll
 * without the instability a full 6-DOF solver brings to a 60 Hz arcade loop.
 */
import * as THREE from 'three';
import { clamp, lerp, approach, smoothstep } from '../core/util.js';
import { EDGE_DROP, Frame, RAMP_LIP_SLOPE } from '../world/track.js';
import { CAR } from './mesh.js';

const G = 9.81;

/* Mass properties. Front-heavy, as a transverse-engined rally car is. */
const MASS = 1180;
const IZZ = 1500;                    // yaw inertia, kg m²
const WB = CAR.wheelBase;
const A = WB * 0.46;                 // CG to front axle
const B = WB * 0.54;                 // CG to rear axle
const CG_H = 0.52;

/* Tyre. A simplified magic formula: F = μ·Fz·sin(C·atan(B·α)). The peak sits
   near 0.14 rad of slip and it falls away past that, which is the part that
   makes a slide recoverable — grip returns as the slip angle comes back. */
const TYRE_B = 7.4, TYRE_C = 1.5;
const MU_BASE = 1.28;                // dry graded dirt
const tyreForce = (slip, load, mu) =>
  mu * load * Math.sin(TYRE_C * Math.atan(TYRE_B * slip));

const ENGINE = [
  // rpm fraction, torque multiplier — a flat, torquey curve with a top-end drop
  [0.0, 0.55], [0.2, 0.85], [0.45, 1.0], [0.7, 1.0], [0.88, 0.9], [1.0, 0.62],
];
const GEARS = [3.35, 2.15, 1.52, 1.15, 0.92, 0.78];
const FINAL = 3.9;
export const MAX_RPM = 7400;
const IDLE_RPM = 1050;
const DRIVE_TORQUE = 305;            // Nm at the peak of the curve
const REVERSE_MAX = 7.0;             // m/s the brake-as-reverse will carry
/* Where the line is: `track.finishS`, an absolute station published by the
   Track itself. It used to be spelled `track.length - FINISH_BACK_M` here and
   at ten other call sites, and the offset lived in this file — which made the
   station a property of the END OF THE ROAD rather than of the road, so
   appending run-off past the flag slid the flag along with it. The offset is
   now authored where the road is, in world/track.js, and nothing outside that
   file re-derives a station from it. */
/* Metres per second the surface may lift the car as it moves across the road.
   Re-measured against the real berm profile: a fast lateral entry onto a high
   berm asks for up to 19 m/s, and the same driving on the old 0.7 m physics
   berm asked for 38. So the mesh halved the demand but did not remove it, and
   this is still the thing that stops a car being flung — at 9 m/s the keyboard
   probe leaves berms 4.7 to 6.3 m in the air, which is the "it goes up in
   turns" report, and at 4.5 the biggest jump on the stage is 1.1 m. */
const MAX_LIFT = 4.5;

/* And the other direction: how far the ground may fall away from under the car
   before the wheels are actually off it, and how fast the suspension pulls the
   body back down onto it. Five centimetres is well inside the 17 cm of travel
   the springs already model, and 1.8 m/s is faster than the road descends
   under the car in any corner but slower than a crest, so jumps are still
   jumps. */
const DROOP = 0.05;
const DROOP_RATE = 1.8;

/* Ceiling on the launch. Nothing on the stage reaches it — the lips run
   43–56 m/s against an exit slope of 0.199, which is 8.6–11.2 — but the
   impulse is proportional to speed and speed is not bounded by anything in
   this file. Raised with the lip: at the old 8.0 the ceiling would have been
   the thing setting the size of the jump on the faster half of the sites,
   which is a profile that silently stops being the profile. */
const LAUNCH_MAX = 13.0;
const AIR_YAW_DAMP = 2.5;
/* Slip the wheel is allowed to hold the car at while airborne, and how briskly
   the car settles onto it. 8° is inside what the tyres can take at touchdown;
   the 2.0 closes a heading error in about half a second, so a 3.4 s flight
   lands settled however it left the ground. */
const AIR_SLIP_AIM = 0.14;
const AIR_ALIGN = 2.0;
/* Front brake bias over and above each axle's share of the load. Small on
   purpose: enough that the front runs out first and the car washes wide, not
   enough to throw away front grip the driver needs to trail-brake with. */
const BRAKE_FRONT_BIAS = 0.06;

/* How fast a tyre's grip coefficient falls as load is piled onto it, per unit
   of load relative to what that axle carries at rest. See the long note at the
   friction circle: this is what stops braking from moving the whole balance of
   the car onto whichever axle the load lands on. */
const LOAD_SENS = 0.25;

/* The boost pad, as newtons and seconds. Comparable to the 4,140 N the engine
   makes in fourth, which is the point: it is a second engine for a second. */
const BOOST_N = 5400;
const BOOST_SEC = 1.2;

/* Airborne attitude, and the landing squash. The pitch gain is well short of
   the flight path angle: a car matched exactly to its trajectory reads as a
   dart, and this is meant to read as a car being thrown. */
const AIR_PITCH_GAIN = 0.55;
const AIR_PITCH_MAX = 0.30;
const SQUASH_W = 13;        // rad/s
const SQUASH_ZETA = 0.50;   // about 16% overshoot, two visible bounces
const SQUASH_KICK = 4.6;    // m/s of compression per unit of landing force
const SQUASH_MAX = 0.28;

/* The berm cross-section the car drives on, as [metres past the road edge,
   height]. This is a copy of BERM in world/track.js, which builds the rock
   the player can actually see and is the source of truth; the mesh carries
   per-sample rubble noise on top and cannot be queried at 120 Hz, so physics
   keeps the base profile.
   Two copies of a shape is exactly the bug it caused last time — physics
   reached the 0.95 m shelf in 0.7 m where the mesh takes 1.5, so on the
   outside of a high berm the car sat up to 1.25 m above the rock it was drawn
   grinding along, an invisible ramp at every fast corner. `tools/turns.mjs
   --pass 1` walks the stage comparing the two and is the gate that catches
   them drifting apart again. */
const BERM = [[0.0, EDGE_DROP], [1.5, 0.95], [2.6, 1.35], [3.9, 0.4], [5.0, -0.75]];

/** Berm height at an offset past the road edge, for a berm of the given
    scale. Interpolating from EDGE_DROP means a scale of 0 leaves a flat apron
    continuous with the road, as the mesh does. */
function bermHeight(off, scale) {
  const last = BERM.length - 1;
  let hh;
  if (off <= 0) hh = BERM[0][1];
  else if (off >= BERM[last][0]) hh = BERM[last][1];
  else {
    let k = 1;
    while (BERM[k][0] < off) k++;
    hh = lerp(BERM[k - 1][1], BERM[k][1],
      (off - BERM[k - 1][0]) / (BERM[k][0] - BERM[k - 1][0]));
  }
  return EDGE_DROP + (hh - EDGE_DROP) * scale;
}

/**
 * Maximum road-wheel angle at a given speed.
 *
 * Exported because the AI driver has to convert the steering angle it wants
 * into the normalised −1..1 command the car takes. When it did that conversion
 * with its own guess, the bot asked for four percent of the lock it meant and
 * drove straight off the first corner at full throttle — a failure that looks
 * exactly like a broken racing line.
 */
export const steerLockAt = speed => lerp(0.62, 0.16, smoothstep(4, 46, speed));

/**
 * How fast the road wheels chase the angle the driver is asking for, as the
 * natural frequency of a critically damped system, in rad/s.
 *
 * A keyboard hands the car a square wave, and everything that used to stand
 * between the two was first order: a per-frame rate limit in the input layer
 * feeding an exponential in here. Both stages have a velocity step at every
 * change in their input, and the first of them changed its output in equal
 * jumps once per rendered frame, so what arrived here was a staircase and what
 * left was a steering angle whose rate jerked at 60 Hz for the whole of every
 * turn-in — measured at the substep, 1.8 times as much movement at a frame
 * boundary as inside a frame. It was slow with it: 400 ms to 90% of lock.
 *
 * A critically damped second-order filter fixes both halves. Its velocity is
 * continuous through any change of target, so the angle eases into a turn and
 * eases back out of it with nothing to catch on; sampled at the substep it is
 * the same curve at 30, 60 or 144 fps, because it no longer inherits the shape
 * of the frame clock. And because it carries its own velocity, letting go
 * mid-turn-in continues smoothly rather than reversing on the spot. Critically
 * damped rather than merely damped: any overshoot at all here is a car that
 * steers past where it was asked to.
 *
 * The two rates are the asymmetry a real wheel has. Turn-in is a deliberate
 * act and can afford to be shaped; centring is the driver getting out of
 * trouble and a wheel self-centres faster than a driver turns it, so the
 * return is a little over half again as quick.
 *
 * 90% of a step lands at 3.89/ω: 195 ms turning in, 125 ms coming back, against
 * 400 and 283 before. Faster, deliberately — the old chain was slow as well as
 * angular, and half a corner spent waiting for the wheels is not a thing any
 * arcade racer should ask for. It is still a good deal slower than the three
 * or four frames the report asked for, which at 60 fps is close enough to
 * instant that the smoothing would not be doing anything.
 *
 * No second speed sensitivity here. steerLockAt already shrinks the available
 * lock by a factor of four between a hairpin and a straight, and the same ω
 * applied to a quarter of the travel is a quarter of the angular rate, so the
 * wheels are already calmer at speed without another term to tune.
 */
const STEER_IN = 20.0;
const STEER_BACK = 31.0;

function torqueAt(frac) {
  for (let i = 0; i < ENGINE.length - 1; i++) {
    const [x0, y0] = ENGINE[i], [x1, y1] = ENGINE[i + 1];
    if (frac >= x0 && frac <= x1) return lerp(y0, y1, (frac - x0) / (x1 - x0));
  }
  return ENGINE[ENGINE.length - 1][1];
}

export class Car {
  constructor(track, { palette = 0, ai = false } = {}) {
    this.track = track;
    this.ai = ai;
    this.palette = palette;

    this.pos = new THREE.Vector3();
    /* Where the car was one substep ago, and where it is drawn.
     *
     * The simulation advances in whole 1/120 substeps and the display does
     * not: a frame is 16.7 ms on one panel, 20.8 ms on another and never
     * exactly either, so the number of substeps a frame runs alternates and
     * the leftover sits in the caller's accumulator. Drawing `pos` draws the
     * simulation clock, which ticks unevenly against the wall clock the eye
     * is using — see `applyTo`. `renderPos` is the same car sampled at the
     * wall clock instead, and it is the only position anything visual should
     * read. It equals `pos` exactly whenever the accumulator is empty, which
     * is every frame of every tool. */
    this._prevPos = new THREE.Vector3();
    this.renderPos = new THREE.Vector3();
    this.yaw = 0;
    this.vx = 0;              // forward speed, m/s (car frame)
    this.vy = 0;              // lateral speed, m/s (+ = sliding right)
    this.r = 0;               // yaw rate, rad/s

    this.steer = 0;           // current road-wheel angle, rad
    this.steerCmd = 0;        // the same input before the speed-sensitive lock
    this._rAir = 0;
    this.steerVel = 0;        // and how fast it is moving, rad/s
    this.throttle = 0; this.brake = 0; this.handbrake = 0;
    this.gear = 0; this.rpm = IDLE_RPM;

    this.s = 0;               // arc length along the stage
    this.lat = 0;
    this.airborne = false;
    this.airTime = 0;
    this.vertVel = 0;
    this.height = 0;          // metres above the surface
    this.landingForce = 0;    // raised on the frame a jump touches down
    /* The ramp this car last launched off, and how long ago in simulation
       time. Read by the slow-motion envelope, the camera and the landing
       effects, all of which need to know a landing came off a ramp rather
       than off a berm. */
    this.launched = null;
    this.launchSpeed = 0;
    this.sinceLaunch = 0;
    this.launchId = 0;        // ticks once per launch, so one flight is one event
    /* Whether the last launch was this car's first off that particular lip.
       Which lips it has already jumped is the car's own history, so it is
       kept here and cleared by placeAt with everything else — the slow-motion
       envelope fires once per ramp per run and needs somewhere honest to read
       that from. A copy on the game object outlives a restart and makes the
       second run of a seed differ from the first. */
    this.launchFirst = false;
    this._lips = new Set();
    this.boostTimer = 0;      // seconds of pad thrust left
    this._lastS = -1;

    /* Suspension state, per wheel: FL, FR, RL, RR. */
    this.susp = [0, 0, 0, 0];
    this.suspVel = [0, 0, 0, 0];
    this.wheelSpin = [0, 0, 0, 0];
    this.wheelSlip = [0, 0, 0, 0];    // 0..1, how hard each corner is sliding

    this.loadF = MASS * G * (B / WB) * 0.5;
    this.loadR = MASS * G * (A / WB) * 0.5;
    this.roll = 0; this.pitch = 0;
    this.airPitch = 0;        // nose attitude in the air, applied at the root
    this.squash = 0;          // landing compression of the whole car, metres
    this.squashVel = 0;
    this._rollLoad = 0;       // smoothed lateral load, −1..1, drives the lean

    this.up = new THREE.Vector3(0, 1, 0);
    this.forward = new THREE.Vector3(0, 0, 1);
    this.right = new THREE.Vector3(1, 0, 0);

    this.lastImpact = 0;       // impact strength this frame, for fx and sound
    this.offRoad = 0;          // 0..1, how far onto the loose stuff
    this.finished = false;
    this.raceTime = 0;
    this.strandedFor = 0;
    this._advancedAt = 0;      // furthest s that counted as progress
    this._sinceAdvance = 0;    // seconds since the car last got there
  }

  /** Drop the car onto the stage at arc length `s`, `lat` metres right of centre. */
  placeAt(s, lat = 0) {
    const f = this.track.frameAt(s);
    this.s = s; this.lat = lat;
    this.pos.copy(f.pos).addScaledVector(f.right, lat).addScaledVector(f.up, CAR.rideHeight);
    /* A placement is not motion. Collapsing both onto the new position is
       what stops the first frame after a teleport extrapolating across the
       whole jump. */
    this._prevPos.copy(this.pos);
    this.renderPos.copy(this.pos);
    // Heading is the tangent flattened into the horizontal plane.
    this.yaw = Math.atan2(f.tan.z, f.tan.x);
    this.vx = 0; this.vy = 0; this.r = 0;
    /* Everything else that carries momentum across a placement. Leaving these
       made the same test input give 41° of slip on one run and 31° on the
       next, because the wheels were still turned and the springs still loaded
       from whatever happened before. */
    this.steer = 0; this.steerVel = 0; this.steerCmd = 0; this._rAir = 0;
    /* The drivetrain carries state too. rpm feeds the engine note and the
       torque curve, and a stale gear changes how the next second of
       acceleration integrates, so a placement that skipped them left the same
       seed producing different races. */
    this.rpm = IDLE_RPM; this.gear = 0;
    this.height = 0; this.vertVel = 0;
    this.airborne = false; this.airTime = 0; this.landingForce = 0;
    this.launched = null; this.launchSpeed = 0; this.sinceLaunch = 0;
    this.boostTimer = 0;   // launchId is not reset: it counts events, not state
    this.launchFirst = false; this._lips.clear();
    this._lastS = -1;
    this.throttle = 0; this.brake = 0; this.handbrake = 0;
    this.roll = 0; this.pitch = 0; this._rollLoad = 0;
    this.airPitch = 0; this.squash = 0; this.squashVel = 0;
    this.susp.fill(0); this.suspVel.fill(0); this.wheelSlip.fill(0);
    this.loadF = MASS * G * (B / WB) * 0.5;
    this.loadR = MASS * G * (A / WB) * 0.5;
    this._lastFy = 0; this._slipF = 0; this._slipR = 0;
    this._circleF = 1; this._circleR = 1;
    this.lastImpact = 0; this.offRoad = 0; this.strandedFor = 0;
    this._advancedAt = s; this._sinceAdvance = 0;
    this._reverse = false;
    this._climbing = false;
    this._hasHint = false;
    this.up.copy(f.up);
    this._orient(f);
  }

  /**
   * Advance the road-wheel angle one step of a critically damped spring.
   *
   * Solved analytically rather than integrated. The physics runs at a fixed
   * 120 Hz so a numerical step would be stable anyway, but the closed form is
   * the same cost and it makes the response identical at any dt — which
   * matters because the tools drive this at 30, 60 and 144, and a filter that
   * behaves differently at each of them is a filter that cannot be tuned.
   *
   * x(t) = target + (d + b·t)·e^(−ωt), the standard critically damped
   * solution, with d the current offset from the target and b chosen so the
   * curve leaves at the velocity the wheel already has.
   */
  _steerToward(target, w, dt) {
    const d = this.steer - target;
    const b = this.steerVel + w * d;
    const e = Math.exp(-w * dt);
    const dampened = d + b * dt;
    this.steer = target + dampened * e;
    this.steerVel = (b - w * dampened) * e;
  }

  /** Surface height under a point given as (s, lat), in world space. */
  surfaceAt(s, lat, out = new THREE.Vector3()) {
    const f = this.track.frameAt(s, _fB);
    const hw = f.width * 0.5;
    const u = clamp(Math.abs(lat) / hw, 0, 1);
    /* Matches the road mesh's crown term exactly. If these two ever disagree
       the car floats or sinks by the difference, and it is invisible until
       someone notices the wheels are not touching. */
    let drop = -Math.pow(u, 3.0) * -EDGE_DROP;
    if (Math.abs(lat) > hw) {
      // Past the edge, up the berm — the same rock the player can see.
      drop = bermHeight(Math.abs(lat) - hw, lat > 0 ? f.bermR : f.bermL);
    }
    /* The one ramp profile, read from the track rather than copied here. The
       BERM constant above is the cautionary tale: two statements of the same
       cross-section put the car 1.25 m above the rock it was drawn grinding
       along, and it was invisible until someone measured it. */
    drop += this.track.rampHeight(s, Math.max(0, Math.abs(lat) - hw));
    return out.copy(f.pos).addScaledVector(f.right, lat).addScaledVector(f.up, drop);
  }

  _orient(f) {
    /* Forward is the heading projected onto the surface plane, so a car
       pointing down a 12% slope actually accelerates down it rather than
       skating along a horizontal plane pretending to. */
    _t.set(Math.cos(this.yaw), 0, Math.sin(this.yaw));
    _t.addScaledVector(this.up, -_t.dot(this.up)).normalize();
    this.forward.copy(_t);
    this.right.crossVectors(this.forward, this.up).normalize();
  }

  get speed() { return Math.hypot(this.vx, this.vy); }
  get kmh() { return this.speed * 3.6; }
  /** Signed slip angle of the whole car — what the drift scoring reads. */
  get slipAngle() { return Math.atan2(this.vy, Math.abs(this.vx) + 0.5); }

  step(dt, input) {
    const track = this.track;
    /* One substep of travel is what the renderer extrapolates along, so this
       is taken per substep and not per frame. */
    this._prevPos.copy(this.pos);

    /* ---- where are we ------------------------------------------------ */
    const proj = track.project(this.pos, this._hasHint ? this.s : -1);
    this._hasHint = true;
    this.s = proj.s;
    this.lat = proj.lat;
    const f = track.frameAt(this.s, _fA);
    const hw = f.width * 0.5;

    /* ---- steering -----------------------------------------------------
       Lock falls off with speed. Without this, full lock at 160 km/h asks the
       front tyres for a slip angle they cannot make and the car simply
       understeers into the scenery — it feels broken rather than fast. This is
       the only speed sensitivity the steering has and it is enough; a second
       limit layered on top of it only makes the first one hard to reason
       about. */
    const speed = this.speed;
    const maxLock = steerLockAt(speed);
    const wantSteer = clamp(input.steer, -1, 1) * maxLock;
    /* Coming back toward centre — or across it, which is a driver catching
       something — gets the quicker of the two rates. Both act on the same
       angle and the same velocity, so the changeover itself is smooth: only
       the acceleration changes, and that is below the threshold of anything
       the car does with it. */
    const centring = Math.abs(wantSteer) < Math.abs(this.steer)
      || wantSteer * this.steer < 0;
    this._steerToward(wantSteer, centring ? STEER_BACK : STEER_IN, dt);
    /* Kept unscaled because the air needs it. `steer` is a road-wheel angle and
       steerLockAt has already taken three quarters of it away by 160 km/h,
       which is the speed every jump on this stage is taken at. */
    this.steerCmd = clamp(input.steer, -1, 1);

    this.throttle = clamp(input.throttle, 0, 1);
    this.brake = clamp(input.brake, 0, 1);
    this.handbrake = clamp(input.handbrake, 0, 1);

    /* ---- surface ------------------------------------------------------ */
    const onBerm = Math.abs(this.lat) > hw;
    this.offRoad = clamp((Math.abs(this.lat) - hw * 0.86) / (hw * 0.2), 0, 1);
    // Loose sand at the edges, rock on the berm: both cost grip.
    const mu = MU_BASE * lerp(1, 0.72, this.offRoad) * (onBerm ? 0.8 : 1);

    /* ---- the launch ----------------------------------------------------
     * Vertical position here is assigned, not integrated: the end of this
     * method puts the car on the surface plus whatever `height` it has, and
     * nothing in the model can push `height` up. So a ramp that is only a
     * shape produces exactly no air — the car is placed on the up-face,
     * placed on the lip, and placed on the road beyond it, at 174 km/h,
     * having gone nowhere. (`_walls` used to exploit the same fact in
     * reverse — translating in the frame plane instead of following the
     * surface invented air at every wall rub — and that was the incidental
     * "berm launch" the player reported as a defect. It now follows the
     * surface, so this impulse is the one deliberate way off the ground.)
     *
     * So the lip hands the car the vertical velocity it would have left with
     * had the up-face been integrated: forward speed along the road times the
     * slope of the last segment of the profile. That is 8.6–11.2 m/s at the
     * lip speeds these sites actually see, which is a shade over two seconds
     * of air. A slow arrival scales down to nothing on its own, and the clamp
     * is there for the arrival nobody has thought of yet. */
    if (this.launched) this.sinceLaunch += dt;
    const moved = this._lastS >= 0 && this.s > this._lastS && this.s - this._lastS < 30;
    if (moved && track.padCrossed(this._lastS, this.s)) this.boostTimer = BOOST_SEC;
    const crossed = moved ? track.rampCrossed(this._lastS, this.s) : null;
    if (crossed) {
      const along = this.vx * this.forward.dot(f.tan) + this.vy * this.right.dot(f.tan);
      const kick = Math.min(Math.max(along, 0) * RAMP_LIP_SLOPE, LAUNCH_MAX);
      if (kick > this.vertVel) {
        this.vertVel = kick;
        this.launched = crossed;
        this.launchSpeed = along;
        this.sinceLaunch = 0;
        this.launchId++;
        this.launchFirst = !this._lips.has(crossed.lip);
        this._lips.add(crossed.lip);
      }
    }
    this._lastS = this.s;

    /* ---- vertical: suspension and air --------------------------------- */
    const surf = this.surfaceAt(this.s, this.lat, _p);
    const groundY = surf.dot(f.up);
    const carY = this.pos.dot(f.up);
    this.height = carY - groundY - CAR.rideHeight;

    this.vertVel -= G * dt;
    let newHeight = this.height + this.vertVel * dt;
    if (newHeight <= 0.001) {
      /* Landing. Some of the descent's vertical speed becomes forward speed
         rather than vanishing, which is what stops a crest from scrubbing all
         the pace off the car. */
      if (this.vertVel < -2.2) this.lastImpact = Math.max(this.lastImpact, Math.min(1, -this.vertVel / 14));
      /* Separate from lastImpact, which is also raised by wall strikes and so
         cannot tell the audio whether the car landed or was hit. Scaled from a
         gentler floor than the impact threshold so that dropping off a kerb
         still registers as a small thump rather than as nothing at all. */
      if (this.airborne) {
        const force = Math.min(1, -this.vertVel / 11);
        this.landingForce = Math.max(this.landingForce, force);
        this.squashVel -= SQUASH_KICK * force;
      }
      newHeight = 0;
      this.vertVel = 0;
      this.airborne = false;
      this.airTime = 0;
    } else if (!this.airborne && newHeight < DROOP && this.vertVel <= 0) {
      /* Still on the ground, wheels extended.
       *
       * Nothing here pushes the car upward, so the only way it can leave the
       * ground is for the ground to fall away from under it — and the test for
       * that had no tolerance at all. A car sitting still has no downward
       * velocity to start with, so it falls a third of a millimetre in the
       * first substep, and any surface that dropped further than that in the
       * same substep took the car airborne. Crossing a crowned road at two
       * thirds of a metre a second is enough. So is a rival nudging you, a
       * kerb, a change of camber, or the road narrowing.
       *
       * That would be a cosmetic wobble if being airborne were cosmetic, but
       * the whole tyre model and the whole drivetrain sit inside `grounded`:
       * an airborne substep has no grip, no throttle and no brakes. Losing
       * them for a few substeps at a time, over and over, is a car that
       * ploughs wide, snaps when the grip comes back, buzzes while it does it
       * and stutters on the throttle throughout — which is the report.
       *
       * The suspension the car already carries is the missing piece: wheels on
       * springs hold the car down as well as up. Within its droop travel the
       * car stays in contact and the gap closes at the rate the dampers would
       * close it. A surface falling away faster than that still wins, and the
       * car still leaves the ground — which is what a crest is.
       *
       * The `vertVel <= 0` is the ramp. Everything above is about a gap the
       * car did not ask for, and the dampers closing it; a launch is a gap the
       * car was given on purpose, and the first five centimetres of it are
       * inside the droop travel. Without this the springs simply reel the
       * impulse back in and the ramp does nothing. Nothing else in the model
       * can hold a positive vertVel on the ground, so no other case moves. */
      newHeight = Math.max(0, newHeight - DROOP_RATE * dt);
      this.vertVel = 0;
    } else {
      this.airborne = true;
      this.airTime += dt;
    }
    this.height = newHeight;
    const grounded = !this.airborne;

    /* ---- longitudinal -------------------------------------------------- */
    const wheelRadius = CAR.wheelR;
    // Pick a gear from wheel speed; an automatic is right for an arcade rally.
    const gearFor = v => {
      for (let g = 0; g < GEARS.length; g++) {
        const rpm = (Math.abs(v) / wheelRadius) * GEARS[g] * FINAL * 60 / (2 * Math.PI);
        if (rpm < MAX_RPM * 0.94) return g;
      }
      return GEARS.length - 1;
    };
    this.gear = gearFor(this.vx);
    const rpmRaw = (Math.abs(this.vx) / wheelRadius) * GEARS[this.gear] * FINAL * 60 / (2 * Math.PI);
    /* Blip the needle toward the limiter when the throttle is open and the
       car is not accelerating — a sliding car should sound like it is
       working. */
    const spinBonus = clamp(Math.abs(this.vy) * 0.06, 0, 0.35) * this.throttle;
    this.rpm = approach(this.rpm,
      clamp(rpmRaw * (1 + spinBonus), IDLE_RPM, MAX_RPM), 9, dt);

    let Fx = 0;
    /* The part of Fx that is actually a tyre force.
     *
     * Fx ends up as the net longitudinal force on the car, and it has to: it
     * is what accelerates the body. But it is the wrong number to spend the
     * friction circle against, because three of its terms never pass through a
     * contact patch. Aerodynamic drag pushes on the shell. Gravity pulls on
     * the mass. Neither asks the tyre for anything, so neither should take
     * lateral grip away from it — and on an eighteen per cent descent gravity
     * in the road plane is 2.1 kN, a seventh of everything the tyres have.
     *
     * Charging them anyway did something worse than lose grip: it reversed the
     * brake pedal. Coasting at 40 m/s down the grade the net Fx is about
     * +1.2 kN, gravity minus drag. Brush the brake and the pedal cancels
     * gravity, net Fx passes through zero, and the friction circle reads the
     * car as doing no longitudinal work at all — so a touch of brake mid-
     * corner *added* lateral grip. Push further and Fx swings hard negative and
     * grip falls off a cliff. The pedal therefore bought more cornering up to
     * about a fifth of its travel and then took it away faster than it gave
     * it, which is a control whose sign changes in the middle of its range.
     * That is not something a driver can learn, and trail-braking into a turn
     * lands squarely on the reversal. */
    let FxTyre = 0;
    if (grounded) {
      const drive = torqueAt(this.rpm / MAX_RPM) * DRIVE_TORQUE
        * GEARS[this.gear] * FINAL / wheelRadius;
      const thrust = this.throttle * drive * (this.rpm > MAX_RPM * 0.985 ? 0.25 : 1);
      Fx += thrust; FxTyre += thrust;
      // Brakes act against motion; handbrake locks the rear only.
      const braking = this.brake * 12200 + this.handbrake * 3400;
      Fx -= Math.sign(this.vx || 1) * braking;
      FxTyre -= Math.sign(this.vx || 1) * braking;
      /* Reverse is a gear the car is in, not a velocity test.
       *
       * The test used to be `vx < 0.6`, and −30 m/s is also less than 0.6: a
       * car that had spun and was rolling back down the grade got full reverse
       * thrust for as long as the brake was held. Standing on the brake —
       * which is exactly what a driver does when the car is pointing the wrong
       * way — accelerated it backwards to 140 km/h, and since the same branch
       * ran at every speed nothing would ever slow it down again. The brake
       * was what made a spin unrecoverable, which is why it read as the car
       * being stuck rather than as the car reversing.
       *
       * Selecting the gear at a standstill and holding it until the driver
       * asks for something else keeps the pedal a brake whenever the car has
       * speed to lose, in either direction, and a reverse only once it has
       * none. */
      if (this.throttle > 0.05 || this.brake <= 0.2 || this.vx > 0.5) this._reverse = false;
      else if (Math.abs(this.vx) < 0.5) this._reverse = true;

      if (this._reverse) {
        /* Reverse has a rev limiter, and past it the pedal goes back to being
           a brake — otherwise a reverse selected at the top of an 18% descent
           is a car with no brakes at all, which is how the original runaway
           came back the second time. Tapering across the cap rather than
           switching at it leaves a single stable speed to settle on instead of
           two forces to chatter between. */
        const overCap = clamp((-this.vx - REVERSE_MAX) / 1.5, 0, 1);
        Fx = lerp(-this.brake * 5200, this.brake * 12200, overCap);
        FxTyre = Fx;
      }

      /* The pad. Six metres of strip is 0.12 s at racing speed and no strip
         that short can accelerate anything — it would need 35 m/s² to be
         worth 15 km/h — so crossing it arms a timer instead, and the thrust
         arrives over the next second and a bit. Roughly a second engine's
         worth: against the drag at 48 m/s it nets about 4.5 m/s by the lip.
         Inside `grounded` and above the friction circle on purpose, so a car
         that boosts mid-corner spends the same tyre everyone else does and
         loses the turn-in for it. */
      /* Cut by the brake, which is not a nicety. A pad fires for over a
         second and the car does not stop needing to slow down for that
         second; thrust that fights the brakes runs a car deep into whatever
         follows the runout, and a car that goes deep at 180 km/h either
         spins or loses several seconds sorting itself out. Measured over 32
         seeds, letting the pad fight the brake pedal was worth 3.4 s of
         field spread on its own. */
      if (this.boostTimer > 0) {
        const boost = BOOST_N * clamp(this.boostTimer / BOOST_SEC, 0, 1) * (1 - this.brake);
        Fx += boost; FxTyre += boost;
      }
    }
    this.boostTimer = Math.max(0, this.boostTimer - dt);
    // Drag and rolling resistance. Terminal speed lands around 195 km/h.
    Fx -= 0.42 * this.vx * Math.abs(this.vx);
    const rollRes = (grounded ? 240 : 30) * Math.sign(this.vx) * Math.min(1, Math.abs(this.vx));
    Fx -= rollRes;
    // Rolling resistance is the one body force that does come off the patch.
    if (grounded) FxTyre -= rollRes;

    /* ---- gravity in the road plane -------------------------------------
       The reason a downhill stage plays differently from a flat one. */
    _g.set(0, -G * MASS, 0);
    _g.addScaledVector(f.up, -_g.dot(f.up));
    Fx += _g.dot(this.forward);
    const Fy_g = _g.dot(this.right);

    /* ---- load transfer -------------------------------------------------- */
    const axTotal = Fx / MASS;
    const ayTotal = (this._lastFy || 0) / MASS;
    const staticF = MASS * G * (B / WB), staticR = MASS * G * (A / WB);
    const transferRaw = MASS * axTotal * CG_H / WB;
    const transferLong = clamp(transferRaw, -staticF * 0.8, staticR * 0.8);
    /* Telemetry only: the pre-clamp demand, so a probe can tell whether that
       clamp is doing anything. Measured, it is not — the hardest stop the car
       can produce asks for 2530 N against the 5001 N the clamp allows, so the
       clamp is a guard rail, not a tuning knob. Written, never read. */
    this._transferRaw = transferRaw;
    this.loadF = Math.max(150, (staticF - transferLong) * 0.5);
    this.loadR = Math.max(150, (staticR + transferLong) * 0.5);
    const transferLat = clamp(MASS * ayTotal * CG_H / CAR.track, -0.9, 0.9);

    /* ---- tyres ----------------------------------------------------------- */
    let Fyf = 0, Fyr = 0;
    if (grounded) {
      const vxSafe = Math.max(Math.abs(this.vx), 1.2) * Math.sign(this.vx || 1);
      const slipF = Math.atan2(this.vy + A * this.r, Math.abs(vxSafe)) - this.steer * Math.sign(vxSafe);
      const slipR = Math.atan2(this.vy - B * this.r, Math.abs(vxSafe));

      /* Longitudinal load eats lateral grip — the friction circle. This is why
         you cannot brake and turn at the same time and why lifting mid-corner
         tightens the line.
       *
       * How the longitudinal work divides between the axles used to be a flat
       * 60/40 under brakes, and dividing a fixed share of force by a load that
       * moves is what made braking into a corner snap. Braking throws load
       * forward: the front axle grows toward 9 kN and the rear falls toward
       * 2.9 kN, so a rear asked for a constant 40% of 12 kN was being asked for
       * more than it had. At full pedal the front kept 82% of its lateral grip
       * and the rear kept 31%. A car with four times more lateral grip at the
       * front than the rear does not understeer and wash wide, which a driver
       * can feel building and lift out of — it rotates, and by the time the
       * rotation is visible the rear is already gone.
       *
       * Brakes on a real car are sized so the axles saturate at about the same
       * time, which means the split has to follow the load rather than ignore
       * it. Following it with a small deliberate bias to the front keeps the
       * front limiting first, so overcooking the pedal runs wide instead of
       * spinning — recoverable, legible, and the same mistake every driver
       * already knows how to correct. */
      const shareF = FxTyre < 0
        ? clamp(this.loadF / (this.loadF + this.loadR) + BRAKE_FRONT_BIAS, 0.15, 0.9)
        : 0.15;                          // on power the drive goes to the rear

      /* Load sensitivity, and it is the term that decides which end of the car
       * runs out first under the brakes.
       *
       * The split above shares the longitudinal work in proportion to load, so
       * neither axle is asked for more of the circle than it can carry, and it
       * works: under a heavy pedal the front is measurably the more depleted
       * axle, circleF 0.764 against circleR 0.876. But the circle is a
       * percentage and the tyre force it scales is `mu · load`, so the LOADS
       * multiply straight through it — and they move the other way. At the same
       * moment the front is carrying 124% of its static load and the rear 72%,
       * which is 2.3x the effect the circle is being asked to counter. Net, the
       * front keeps 95% of its static lateral force and the rear 63%: the rear
       * is the axle that goes, so overcooking the pedal mid-corner spun the car
       * instead of washing it wide, which is the opposite of the intent above.
       *
       * The missing physics is that a tyre's grip is not proportional to the
       * load on it — mu falls as the load rises. A real axle therefore gains
       * less than proportionally from the load braking throws onto it and loses
       * less than proportionally when the load leaves, which is most of why
       * transferring load costs a car grip overall. This model cannot express
       * that as written: it lumps each axle into one tyre carrying both wheels,
       * so grip is exactly linear in load and braking moves the balance around
       * far harder than it should.
       *
       * Restoring the term costs the front some of the bite it was getting from
       * a load it would not really have kept, and leaves the rear some of what
       * it was losing. The pedal then runs the car wide instead of round — the
       * mistake a driver can feel building and lift out of.
       *
       * The coefficient is on the strong side of a real tyre, which loses
       * nearer 0.15 per unit of relative load, and it is sized by measurement
       * rather than theory: it is the lowest value that takes the spins to zero
       * over 270 trail-brake runs across three seeds. Note that it does NOT
       * work by making the front the weaker axle in the arithmetic — at the
       * frame the old build diverged the front still holds more than the rear
       * (0.84 against 0.68 of static, against 0.95/0.63 before). Narrowing the
       * gap is enough on its own: the yaw rate stops pinning against rMax
       * below, which is what used to hold the rate steady while slip piled up
       * underneath it and the driver never got the car back.
       *
       * Two things this is deliberately NOT:
       *
       * Not BRAKE_FRONT_BIAS. That knob does have the authority — at 0.50 the
       * spins go to zero — but it buys it by throwing the front away, and the
       * skidpad says that reopens the brake sign reversal: the pedal is then
       * worth up to a fifth of a g MORE grip than no pedal at all.
       *
       * Not the clamp two blocks up either. It reads as the obvious limiter of
       * this term and it is measurably inert: the hardest stop the car can
       * produce asks 2530 N of it against the 5001 N it allows, so it never
       * binds, and lowering it does nothing until it starts cutting — at which
       * point it is a corner in the response rather than a knob.
       *
       * The cost is real and it is the AI's. Only the half of this that weakens
       * the loaded front kills the last spins, and it is the same half that
       * costs the bot its lap: applied to the light axle alone the field gets
       * FASTER (214.9 s against 226.6 s) and only half the spins go. The bot's
       * pace is partly built on the brakes rotating the car for it, so a car
       * that washes wide instead needs its corner entry speeds re-planned in
       * driver.js. That is a separate round; this file is the wrong place. */
      const loadGrip = (load, ref) => 1 - LOAD_SENS * clamp(load / ref - 1, -0.8, 0.8);
      const muF = mu * loadGrip(this.loadF, staticF * 0.5);
      const muRload = mu * loadGrip(this.loadR, staticR * 0.5);

      const work = Math.abs(FxTyre);
      const usedF = clamp(work * shareF / (muF * this.loadF * 2), 0, 0.95);
      const usedR = clamp(work * (1 - shareF) / (muRload * this.loadR * 2), 0, 0.95);
      const circleF = Math.sqrt(1 - usedF * usedF);
      const circleR = Math.sqrt(1 - usedR * usedR);

      /* The handbrake takes the rear away, which is how a drift is started.
         It has to take away a lot: at a third of grip the rear still holds on
         and the car merely turns in slightly harder. Locked rear wheels also
         drag, which is what pivots the car rather than just sliding it. */
      const muR = muRload * lerp(1, 0.16, this.handbrake);

      /* Telemetry only. How much of each axle's lateral grip the longitudinal
         load has eaten is the single hardest thing to see from outside this
         method, and it is the term two rounds of turn diagnosis have had to
         guess at. Written, never read. */
      this._circleF = circleF; this._circleR = circleR;

      Fyf = tyreForce(-slipF, this.loadF * 2, muF * circleF);
      Fyr = tyreForce(-slipR, this.loadR * 2, muR * circleR);

      this.wheelSlip[0] = this.wheelSlip[1] = clamp(Math.abs(slipF) / 0.30, 0, 1);
      this.wheelSlip[2] = this.wheelSlip[3] = clamp(Math.abs(slipR) / 0.26, 0, 1)
        * lerp(1, 1.5, this.handbrake);
      this._slipF = slipF; this._slipR = slipR;
    } else {
      this.wheelSlip.fill(0);
      this._circleF = this._circleR = 0;
      /* Airborne.
       *
       * The old rule fed the road-wheel angle straight into yaw acceleration,
       * and that is a promise the model cannot keep. Nothing in the air can
       * change where the car is going — only gravity acts on it — so every
       * degree the wheel rotates the body is a degree of slip waiting at
       * touchdown, one for one. Measured over the three ramps on this stage:
       * holding the wheel for a flight rotates the car 38.7° and it lands 25°
       * across the road at 23° of slip, taking 0.9 s to gather up, and on one
       * ramp never gathering up at all inside three seconds. Let the wheel go
       * and the same jump lands 0.2° out and is done in 0.11 s.
       *
       * So the input the player reaches for during 4.2 s of hang time is the
       * one thing that ruins the landing, and the fix is not to take it away.
       * It is that the wheel should aim the car rather than spin it. Air time
       * here is 3.4 s of simulation — long enough for a first-order alignment
       * to settle three times over — so the car is flown toward its own flight
       * path and the wheel offsets it by a bounded amount either side. Held
       * lock now reads as the car cocked into the corner it is landing in,
       * which is what the input was always meant to mean, and it touches down
       * inside the slip the tyres can still work at.
       *
       * Curving the flight path instead was the other option and it does not
       * survive arithmetic: 153 m of travel at the rotation rate the car
       * already had is 55 m of lateral drift, on a road 10 m wide. */
      const beta = Math.atan2(this.vy, Math.abs(this.vx) + 1);
      const aim = this.steerCmd * AIR_SLIP_AIM;
      this._rAir = (beta - aim) * AIR_ALIGN;
    }

    /* Sideways scrub. A tyre dragged across dirt at a large slip angle plows a
       bow wave of loose material, and that drag is missing from a pure slip-
       angle tyre model — which is why a big slide here used to deepen after
       the driver caught it and then take three seconds to bleed off. Scaling
       with vy² makes it self-gating: at 3 m/s of slide it is a fifth of a m/s²
       and normal cornering does not notice, at 14 m/s it is most of half a g. */
    const scrub = grounded
      ? clamp(30 * this.vy * Math.abs(this.vy), -7000, 7000) * lerp(1, 0.45, this.offRoad)
      : 0;

    /* Two lateral numbers, because two different things want one.
       Fy is the net force the car is integrated with. FyLoad is the part of it
       that actually presses the car down onto its outside springs — the tyres
       and the in-plane component of gravity — and it is what the visual lean
       reads. Scrub is deliberately not in it: scrub opposes the slide, so in a
       big drift it points the other way from the cornering force and would
       roll the body into the corner at the exact moment it should be leaning
       hardest out of it. */
    const FyLoad = Fyf * Math.cos(this.steer) + Fyr + Fy_g;
    const Fy = FyLoad - scrub;
    this._lastFy = Fy;
    /* Telemetry only, and the reason it exists: the lateral budget is four
       terms that partly cancel, and no probe outside this method can see
       which of them a corner spent. Written, never read. */
    this._fyf = Fyf; this._fyr = Fyr; this._fyg = Fy_g; this._scrub = scrub;

    /* ---- integrate ------------------------------------------------------- */
    const ax = Fx / MASS + this.vy * this.r;
    const ay = Fy / MASS - this.vx * this.r;
    this.vx += ax * dt;
    this.vy += ay * dt;
    if (grounded) {
      const torque = A * Fyf * Math.cos(this.steer) - B * Fyr;
      this.r += (torque / IZZ) * dt;
      /* Yaw damping. Without it the model rings at low speed, because the
         tyre curve has no static friction and nothing else opposes rotation
         when the car is nearly stopped. */
      this.r -= this.r * clamp(2.6 - speed * 0.08, 0.4, 2.6) * dt;

      /* Ceiling on yaw rate.
       *
       * The tyre model is happy to spin the car: front gripping, rear lit up
       * under power, and the yaw moment runs away inside half a second. That
       * is physically reasonable and completely miserable to play, because
       * once the car is past about ninety degrees of slip no amount of
       * opposite lock brings it back and the run is over.
       *
       * v/R at the limit of grip is mu·g/v, so this allows most of twice that
       * — enough that a big deliberate drift still rotates freely, not enough
       * for the car to swap ends from a throttle mistake. The approach is
       * gradual rather than a clamp so it does not feel like hitting a wall. */
      const rMax = (mu * G / Math.max(speed, 5.0)) * 1.28 + 0.15;
      if (Math.abs(this.r) > rMax) {
        this.r = lerp(this.r, Math.sign(this.r) * rMax, clamp(dt * 7, 0, 1));
      }
    } else {
      /* Airborne yaw bleeds off, and it has to bleed off fast enough to be
         gone by touchdown. At 0.4/s it was not: a driver holding a third of a
         lock through a second of ramp flight arrives with a quarter of a
         radian a second still on the car, and landing at 48 m/s with that on
         is a slip step the tyres do not recover from — a spin, a strand, a
         five-second recovery, and a field spread that reads as the boost
         pad's fault. At 2.5/s the car still answers the stick in the air and
         still lands square. */
      /* Toward the rate the aim above asks for, on the same time constant the
         plain damping used, so a released wheel behaves as it always did. */
      this.r += ((this._rAir || 0) - this.r) * clamp(AIR_YAW_DAMP * dt, 0, 1);
    }
    if (Math.abs(this.vx) < 0.12 && this.throttle < 0.02) { this.vx *= 0.86; this.r *= 0.8; }

    this.yaw += this.r * dt;

    /* ---- move in the world ------------------------------------------------ */
    this._orient(f);
    _d.copy(this.forward).multiplyScalar(this.vx * dt)
      .addScaledVector(this.right, this.vy * dt);
    this.pos.add(_d);
    // Reproject onto the surface, keeping whatever air we have.
    const proj2 = track.project(this.pos, this.s);
    const f2 = track.frameAt(proj2.s, _fC);
    const lat2 = this._climb(proj2.s, proj2.lat, f2, dt);
    const surf2 = this.surfaceAt(proj2.s, lat2, _p);
    this.pos.copy(surf2).addScaledVector(f2.up, CAR.rideHeight + this.height);
    this.up.copy(f2.up);
    this.s = proj2.s; this.lat = lat2;

    this._walls(f2, dt);
    this._suspension(f2, dt, ax, Fy / MASS, FyLoad / MASS);

    if (!this.finished) this.raceTime += dt;
    if (this.s > track.finishS) this.finished = true;

    /* Beached. Facing back up the stage or wedged somewhere with no speed —
       recoverable by hand for the player, but an AI car that does this is
       simply gone for the rest of the race, and the field silently becomes
       three cars. Track it here; who acts on it is the caller's business.

       The third case is the one neither of those tests can see: a car pinned
       against the guardrail with its nose across the road, held there by the
       wall on one side and its own throttle on the other. It is doing sixty,
       so the speed test never fires, and it weaves enough that `facing` keeps
       flicking back over the threshold and clearing the count, so the heading
       test never fires either — while the stage goes nowhere underneath it.
       Progress is the test that cannot be gamed: five metres in six seconds
       is three kilometres an hour, which nothing that is still racing does. */
    if (this.s > this._advancedAt + 5) { this._advancedAt = this.s; this._sinceAdvance = 0; }
    else this._sinceAdvance += dt;

    const facing = this.forward.dot(f2.tan);
    const bad = facing < 0.15
      || (this.speed < 1.8 && !this.airborne)
      || this._sinceAdvance > 6;
    this.strandedFor = bad ? this.strandedFor + dt : 0;
  }

  /** Put the car back on the road, pointing down it, with its pace intact. */
  recover() {
    /* `roadEnd`, so a car recovered in the run-off is put back where it was
       rather than teleported to forty metres short of the end of the RACE,
       which is upstream of the flag it has already crossed. */
    const s = clamp(this.s - 8, 6, this.track.roadEnd - 40);
    const keep = clamp(this.speed * 0.45, 0, 16);
    this.placeAt(s, clamp(this.lat, -3, 3));
    this.vx = keep;
    this.vertVel = 0; this.height = 0;
    this.strandedFor = 0;
    this.susp.fill(0); this.suspVel.fill(0);
  }

  /**
   * How fast the ground is allowed to lift the car.
   *
   * Vertical position is assigned, not integrated: the car is placed on the
   * surface every frame and keeps whatever air it had. That is fine while the
   * surface is a road, and it is not fine at the edge of one. The berm rises
   * 1.45 m over the 1.5 m of lateral travel it takes to reach its shelf, and
   * on the high berms that scale runs to 1.75, so the outside of a fast corner
   * is a slope steeper than 45° with a containment wall only 1.05 m out. A car
   * that runs wide is carried up it. Measured through a 25 m banked corner at
   * 95 km/h, running wide lifted the car 1.39 m in 0.067 seconds — a vertical
   * rate of 31 m/s, with vertVel and height both still exactly zero
   * throughout. Nothing in the model can push the car up, so it never read as
   * a jump; the car was simply somewhere else, a metre and a half higher, on
   * the next frame. That is the "it goes up in turns" the report describes,
   * and a car left perched up there is also most of the way to being stuck.
   * (That measurement predates the profile being synced to the mesh, which
   * halved the slope; the demand is now up to 19 m/s rather than 38, still
   * four times what the car is allowed.)
   *
   * A car cannot levitate up a rock face, so the honest constraint is on how
   * fast the surface may raise it. Anything the car cannot climb in the time
   * available it does not climb: it is held at the lat it could reach and the
   * velocity that was driving it up the slope is removed, which is what the
   * hillside would have done to it. Because the car is stopped rather than
   * lagged, it stays on the part of the berm the mesh agrees with — there is
   * no window where it is drawn buried in the rock.
   *
   * Only the across-the-road component is budgeted. The stage's own gradient
   * lifts and drops the car all day long and has nothing to do with this.
   */
  _climb(s, lat, f, dt) {
    /* Only the ground the car is on can refuse to lift it. A car in the air
       over the berm is not climbing anything, and holding it back because the
       rock it is flying above is steep would stop a jump in mid-flight. */
    if (lat === this.lat || this.height > 0.35) { this._climbing = false; return lat; }
    /* World Y, not height along f.up: the frame's up axis rotates with the
       bank, so resolving against it reports metres of movement on a car that
       is perfectly level. */
    const base = this.surfaceAt(s, this.lat, _p3).y;
    const budget = MAX_LIFT * dt;
    if (this.surfaceAt(s, lat, _p3).y - base <= budget) { this._climbing = false; return lat; }

    let lo = this.lat, hi = lat;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) * 0.5;
      if (this.surfaceAt(s, mid, _p3).y - base > budget) hi = mid; else lo = mid;
    }

    /* The lateral speed that could not happen, taken back out of the velocity
       it came from. Splitting it across both axes by how much each contributes
       to movement across the road matters: a car sliding into the berm sideways
       and a car driving at it nose-first are the same event to the hillside,
       and charging only vy would leave the second one untouched. */
    /* Not all of it. Removing the whole blocked component every frame makes
       the foot of the berm behave like a kerb that catches, and the residual
       is charged again on the next frame anyway, so the car still bleeds down
       to the climb rate — just over a few frames rather than in one. */
    const rate = (lat - lo) / Math.max(dt, 1e-4) * 0.6;
    const dotF = this.forward.dot(f.right);
    const dotR = this.right.dot(f.right);
    this.vx -= rate * dotF;
    this.vy -= rate * dotR;

    /* Same distinction the wall makes, for the same reason: arriving at the
       foot of the berm is one event, and grinding up it is a hundred and
       twenty a second. Reporting every frame as a strike gave the camera a
       permanent shake and the audio a permanent crash for as long as the car
       was against the kerb. */
    this.lastImpact = Math.max(this.lastImpact,
      this._climbing ? clamp(Math.abs(rate) / 90, 0, 0.10)
        : clamp(Math.abs(rate) / 26, 0, 0.55));
    this._climbing = true;
    return lo;
  }

  /**
   * Keep the car on the stage.
   *
   * The berm is climbable up to a point and a wall past it. Bleeding lateral
   * speed rather than zeroing it means a graze costs you time instead of
   * stopping you dead, which is the difference between a rally game and a
   * pinball table.
   */
  _walls(f, dt) {
    const limit = f.width * 0.5 + 1.05;
    const over = Math.abs(this.lat) - limit;
    if (over <= 0) { this._contact = false; return; }

    const side = Math.sign(this.lat);
    const push = Math.min(over, 0.6);
    /* Follow the surface across, do not translate in the frame plane.
     *
     * This used to be a translation along `right`, kept deliberately because
     * the air it invented was "the game's berm launch". The player's verdict
     * on that launch is that it is a defect — the car skips along the berm
     * instead of driving on it — and measurement agrees. A car ground along
     * the wall re-penetrates a few centimetres every substep (the road
     * narrows, the driver is still steering out), and each push moved it
     * that far down a ~44° rock face while keeping its world height. Three
     * centimetres of manufactured air 120 times a second is 3.6 m/s of lift,
     * which out-pulls gravity: the car ratcheted to ~0.85 m, hung there for
     * most of a second with no tyres, no drive and no brakes, landed for two
     * substeps and did it again. Off-road excursions were ~75% airborne.
     *
     * Re-deriving the position from the surface at the corrected lat keeps
     * `height` — whatever air the car legitimately has — and invents none.
     * The deliberate jumps live elsewhere entirely: the sited ramps launch
     * through the rampCrossed lip impulse in step(), which this does not
     * touch. */
    this.lat -= side * push;
    this.pos.copy(this.surfaceAt(this.s, this.lat, _p))
      .addScaledVector(f.up, CAR.rideHeight + this.height);

    /* How fast the car is actually moving into the wall — measured across the
       ROAD, not read off `vy`. The car frame's lateral axis is only the
       road's when the car is pointing down the road, and a car grinding a
       wall is usually not: at the 30-40° of slip a wall rub produces, most of
       the motion across the road comes through `vx`, and `vy * side` can
       read a car ploughing INTO the wall as leaving it. When it did, neither
       contact branch ever ran — no restitution, no scrub, no `_contact` — so
       the position clamp above put the car back on the line every substep
       while its velocity kept carrying it out. A position clamp against a
       kept velocity is an oscillator: the car re-penetrated ~3 cm per substep
       indefinitely, and `_climb` picked up the scraps as a ~9 Hz stick-slip
       buzz in the slip angle for as long as the car leaned on the wall. Same
       split across the axes as `_climb` uses, for the same reason. */
    const dotF = this.forward.dot(f.right);
    const dotR = this.right.dot(f.right);
    const into = (this.vx * dotF + this.vy * dotR) * side;   // + = into the wall
    if (into <= 0) return;

    /* Two different things happen at a wall and they need different maths.
     *
     * The first touch is an impact: an instantaneous change in velocity, and
     * it happens once. Everything after that is a scrub — the driver is still
     * steering into the wall, so the car re-penetrates on every substep, and
     * anything applied per substep at impact strength is applied 120 times a
     * second. The first version made that mistake with the yaw kick, and the
     * car span up to a radian per second while merely leaning on a berm.
     *
     * So: restitution once, on entry. Scrub drag and the yaw it induces are
     * rates, scaled by dt like any other force. */
    const fresh = !this._contact;
    this._contact = true;

    if (fresh) {
      this.lastImpact = Math.max(this.lastImpact, clamp(into / 15, 0, 1));
      const dv = into * 1.22;                    // bounce, losing most of it
      this.vx -= side * dv * dotF;
      this.vy -= side * dv * dotR;
      this.vx *= lerp(1, 0.84, clamp(into / 12, 0, 1));
      this.r -= side * clamp(into / 40, 0, 0.30);
    } else {
      // Sustained contact: kill the inward velocity, drag along the wall.
      const dv = into * clamp(dt * 26, 0, 1);
      this.vx -= side * dv * dotF;
      this.vy -= side * dv * dotR;
      this.vx -= Math.sign(this.vx) * Math.min(Math.abs(this.vx), 5.5 * dt * (0.4 + into));
      this.r -= side * clamp(into / 30, 0, 0.45) * dt * 6;
      this.lastImpact = Math.max(this.lastImpact, clamp(into / 60, 0, 0.25));
    }
  }

  /**
   * Per-wheel springs against the surface.
   *
   * Purely visual plus load transfer — but it is most of what "feel" means.
   * A car that does not dive under braking or drop a shoulder into a corner
   * looks like a sprite being slid around, whatever the physics underneath is
   * doing.
   */
  _suspension(f, dt, ax, ay, ayLoad = ay) {
    const hw = f.width * 0.5;
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const front = i < 2, left = i % 2 === 0;
      const lat = this.lat + (left ? -1 : 1) * CAR.track * 0.5;
      const ds = (front ? -1 : 1) * CAR.wheelBase * 0.5;
      const surf = this.surfaceAt(clamp(this.s + ds, 0, this.track.roadEnd), lat, _p);
      const local = surf.dot(f.up) - this.surfaceAt(this.s, this.lat, _p2).dot(f.up);

      /* Target compression, positive meaning that corner is squatting.
         Accelerating throws load rearward, so the front EXTENDS — hence the
         negation on the front term. Getting this backwards gives a car that
         wheelies under braking, which looks like a physics bug long before
         anyone works out it is a sign. */
      const target = -local
        + (front ? -1 : 1) * clamp(ax * 0.014, -0.09, 0.09)
        + (left ? 1 : -1) * clamp(ay * 0.008, -0.06, 0.06);

      const k = 62, c = 11;           // stiff and well damped: a rally car
      const acc = (target - this.susp[i]) * k - this.suspVel[i] * c;
      this.suspVel[i] += acc * dt;
      this.susp[i] = clamp(this.susp[i] + this.suspVel[i] * dt, -0.17, 0.17);
      sum += this.susp[i];

      // Wheel rotation: rolling speed, plus obvious spin-up when lit.
      const rolling = this.vx / CAR.wheelR;
      const spinning = !front && this.throttle > 0.5 && this.wheelSlip[i] > 0.5
        ? rolling * 1.5 + 12 * this.throttle : rolling;
      this.wheelSpin[i] += (this.airborne ? rolling : spinning) * dt;
    }
    /* Compression at a corner drops the body there. So the right side rising
       (positive roll about local +Z) means the LEFT corners compressed, and
       the nose dropping (negative pitch about local +X) means the FRONT
       corners compressed. Verified against a capture rather than reasoned
       about: a right-hand hairpin gives a positive yaw rate and, with these
       signs, positive roll — right side up, body leaning onto its left, which
       is the outside of the corner. */
    /* Gains chosen against measured poses rather than by feel. At 0.75 and 0.5
       a corner produced 14° of roll and a stop produced 11° of dive, which is
       two to three times what even a stylised rally car should show — it read
       as a broken suspension rather than as an exaggeration. A hard stop now
       lands near 4°, which is still theatrical without looking like the car is
       falling over. */

    /* Roll is two terms because it has two jobs, and running them both through
       the springs made each one worse.
     *
     * The springs know about the ground. Their compression carries the crown
     * of the road, the camber at the edge of it, kerbs, landings and the
     * shoulder of the berm — all of which the body should follow, and none of
     * which has anything to do with cornering. Driven at the old gain of
     * 0.315 that terrain signal was the larger of the two: measured over a
     * full stage the body leaned the wrong way — into the corner — for a
     * quarter of the time it was loaded up, peaked at 15° where the car
     * touched a berm, and its mean was flat at 5–7° from 0.3 g all the way
     * past 1 g. A lean that does not vary with load is not reading as weight
     * transfer to anybody; it is reading as the car wobbling.
     *
     * So the terrain keeps a share large enough to see a kerb through and no
     * larger, and the weight transfer gets its own term driven by the lateral
     * force the tyres are actually making. That term is monotonic in load by
     * construction, which is the whole point: how far the car is leaning is
     * how hard it is cornering, and the player can read the grip they have
     * left off the body of the car.
     *
     * The load term is deliberately short of what the geometry would give, and
     * the reference load is set a little past the grip the car actually has so
     * it does not saturate and go flat again through the fastest corners. A
     * hard corner comes out near 6° and a caught slide near 8°: this is a
     * cel-shaded car photographed from behind, the lean has to be legible in
     * silhouette in a frame that is 200 px of car, and past about 10° it stops
     * reading as attitude and starts reading as a puncture. */
    const TERRAIN_ROLL = 0.10;
    const LOAD_REF = 12.5;        // m/s², a shade past all the grip there is
    const ROLL_LOAD = 0.126;      // rad at that load — 7.2°

    /* Smoothed, and not only to take the noise out. Load transfer is a mass
       moving on springs, so it has to lag the force that moves it; stepping
       the lean straight from the tyre force would put the body at full lean on
       the same frame the front tyres bite, which is the snap this work is
       supposed to be removing, moved from the wheels to the shell. */
    this._rollLoad = approach(this._rollLoad, clamp(ayLoad / LOAD_REF, -1, 1), 9, dt);

    /* Suspension travel alone under-sells a drift: once the rear is loose the
       lateral force the tyres can still make has dropped, so load transfer
       drops with it and a 42-degree slide leans less than a tidy turn-in. That
       is true of the physics and wrong for the read — the sideways frame is
       the one that has to look the most committed. This term leans the body
       into the slide on top of the load transfer, and it is zero below about
       12 degrees of slip so ordinary cornering is untouched. */
    const lean = clamp((Math.abs(this.slipAngle) - 0.21) * 0.42, 0, 0.048)
      * -Math.sign(this.slipAngle);

    const terrain = (this.susp[0] + this.susp[2]) - (this.susp[1] + this.susp[3]);
    this.roll = terrain * TERRAIN_ROLL + this._rollLoad * ROLL_LOAD + lean;
    this.pitch = ((this.susp[2] + this.susp[3]) - (this.susp[0] + this.susp[1])) * 0.19;
    this.bodyLift = -sum * 0.22;

    /* Nose attitude in the air.
     *
     * The springs cannot supply this. `pitch` comes out of suspension travel,
     * and a car with all four wheels hanging has no travel to read — it flies
     * dead level, which at 40 m of flight is the single thing that makes a
     * jump look like a bug rather than a jump. So the attitude is taken from
     * the flight itself, as the angle of the velocity vector, and the car
     * noses over as it starts to come down.
     *
     * It goes on at the root rather than on the body, unlike `pitch`. A dive
     * under braking is the shell moving on its springs and the wheels stay
     * where the road is; a car pointing down at a landing is the whole car,
     * wheels included. Faded in over the first fifth of a second so a kerb
     * hop does not tilt anything, and collected quickly on touchdown. */
    const want = clamp(
      Math.atan2(this.vertVel, Math.max(Math.abs(this.vx), 1)) * AIR_PITCH_GAIN,
      -AIR_PITCH_MAX, AIR_PITCH_MAX) * smoothstep(0.20, 0.40, this.airTime);
    this.airPitch = approach(this.airPitch, this.airborne ? want : 0,
      this.airborne ? 6 : 14, dt);

    /* And the landing. The springs above are stiff and well damped on purpose
       — they have to hold a rally car through a berm — which makes them too
       tidy for the one impact the player is meant to feel. This is a second
       spring, softer and only half damped, so a landing gives about 16% of
       overshoot and two visible bounces. Kicked, not driven: it takes an
       impulse at touchdown and rings down on its own. */
    this.squashVel += (-SQUASH_W * SQUASH_W * this.squash
      - 2 * SQUASH_ZETA * SQUASH_W * this.squashVel) * dt;
    this.squash = clamp(this.squash + this.squashVel * dt, -SQUASH_MAX, SQUASH_MAX);
  }

  /**
   * Copy the simulation state onto the scene graph.
   *
   * `alpha` is how far past the last completed substep the wall clock has
   * reached, 0..1 — the caller's leftover accumulator over the substep size.
   *
   * The car is drawn one substep of travel ahead of where the simulation has
   * got to, scaled by that fraction, and the reason is that the two clocks
   * do not tick together. The simulation only ever advances in whole 1/120
   * substeps, so a 20.8 ms frame runs two of them and the next one runs
   * three; the car covers 16.7 ms of ground and then 25 ms of it while the
   * eye, and the chase camera, are advancing 20.8 ms each time. Measured on
   * the drawn pose that is 222 mm RMS of camera-space judder reversing sign
   * on 99% of frames at 48 fps, and 192 mm at an ordinary jittery 60 — the
   * whole field shimmering in unison against a rock-steady road, which is
   * exactly the report. It is not a physical oscillation: the car's own
   * trajectory, sampled per substep, is clean, and every instrument in
   * tools/ drives the loop at exactly 1/60 where two substeps fit a frame
   * with nothing left over, which is why none of them ever saw it.
   *
   * Extrapolated rather than interpolated, deliberately. Interpolating
   * between the last two substeps is the more usual answer and it is just as
   * smooth, but it draws the car up to one substep in the past — 8.3 ms of
   * input latency the game did not have before, and a shift in every capture
   * the suite hashes. Extrapolating puts the drawn pose at the wall clock
   * exactly, and `alpha` defaults to zero, so a caller with an empty
   * accumulator — which is every tool, and every frame that happens to land
   * on a substep boundary — gets bit-for-bit what it got before.
   *
   * Position only. Rotational judder was measured on the same runs at 0.03°
   * to 0.10° RMS against 0.2 to 0.6 m of linear, so orientation is left to
   * the simulation clock rather than carrying a second extrapolation for
   * something a tenth of a degree wide.
   */
  applyTo(view, alpha = 0) {
    const { root, body, wheels } = view;
    this.renderPos.copy(this.pos);
    if (alpha > 0) {
      this.renderPos.x += (this.pos.x - this._prevPos.x) * alpha;
      this.renderPos.y += (this.pos.y - this._prevPos.y) * alpha;
      this.renderPos.z += (this.pos.z - this._prevPos.z) * alpha;
    }
    root.position.copy(this.renderPos);

    /* Orientation from the surface frame, not from world up: on a 17-degree
       banked corner a car held level to the world looks like it is falling
       out of the road. */
    _m.makeBasis(this.right, this.up, _t.copy(this.forward).negate());
    root.quaternion.setFromRotationMatrix(_m);
    /* Local X is `right`, from the basis above, so this is pitch. At the root
       so the wheels come with it — see the note in _suspension. The sign was
       checked against a capture, not reasoned out, exactly as the roll and
       pitch signs below were. */
    if (this.airPitch) root.rotateX(this.airPitch);

    body.rotation.set(this.pitch, 0, this.roll);
    body.position.y = (this.bodyLift || 0) + this.squash;

    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      /* The root sits rideHeight above the surface, so a hub placed at wheelR
         puts the contact patch a whole ride height in the air — the car looked
         like it was hovering in every static shot. */
      w.position.y = CAR.wheelR - CAR.rideHeight + this.susp[i];
      if (w.userData.front) w.rotation.y = -this.steer;
      w.userData.spin.rotation.x = this.wheelSpin[i];
    }
  }
}

/* Scratch. Three separate Frames rather than one shared: step() holds a frame
   across calls to surfaceAt(), and surfaceAt() takes a frame of its own — with
   a single scratch the two alias and the car is silently resolved against the
   wrong part of the road. */
const _fA = new Frame(), _fB = new Frame(), _fC = new Frame();
const _t = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _p3 = new THREE.Vector3();
const _g = new THREE.Vector3();
const _m = new THREE.Matrix4();
