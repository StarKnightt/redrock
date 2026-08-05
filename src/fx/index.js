import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../core/util.js';
import { rng, rand } from '../core/rng.js';
import { CAR } from '../car/mesh.js';
import { EDGE_DROP, Frame } from '../world/track.js';
import { ParticlePool } from './particles.js';
import { SkidMarks } from './skids.js';
import { AirMark } from './airmark.js';

const ROAD_LIFT = 0.065;

/* How far from the camera a car other than the player still throws dust, and
   where it starts thinning out. Beyond the far figure a car is a fistful of
   fogged pixels — the race module stops drawing it at 450 m — and dust it
   cannot be seen to disturb is dust spent on nothing. */
const FOLLOW_NEAR = 70;
const FOLLOW_FAR = 150;
/* What one followed car may ask for, against the player's own rate. The pool
   is one budget of 384 shared by the whole field, and the player is the
   subject of every frame. */
const FOLLOW_SHARE = 0.62;
/* Air time at which a landing nobody described is treated as a jump rather
   than a bump, and where the automatic reading tops out. No berm, kerb or
   crest on this stage keeps the car up for eight tenths of a second — so
   below that the burst is exactly what it always was — and two and a bit
   seconds is a very large ramp. A ramp that knows its own size should say so
   with armLanding() rather than leave it to be inferred from the flight. */
const AIR_SMALL = 0.80;
const AIR_LARGE = 2.20;
const SCALE_MAX = 3.4;

/* Per-car emission state. The player has had one of these all along, spread
   across a dozen fields on Effects; a car the system merely follows needs the
   same clocks kept separately or two cars share one timer and emit in
   lockstep, which is the one thing a field of cars must not do. Each carries
   its own random stream as well, so adding a rival cannot shift a single draw
   in the player's own dust. */
class CarEmission {
  constructor(car, seed) {
    this.car = car;
    this.random = rand(rng((seed | 0) + 4451));
    this.dustTimers = new Float32Array(4);
    this.smokeTimer = 0;
    this.started = false;
    this.wasAirborne = false;
    this.airTime = 0;
    for (let i = 0; i < 4; i++) this.dustTimers[i] = this.random.f(0.01, 0.09);
    this.smokeTimer = this.random.f(0.01, 0.05);
  }
}

export class Effects {
  constructor(scene, track, opts = {}) {
    this.scene = scene;
    this.track = track;
    this.seed = (opts.seed ?? ((track.seed || 1) * 977 + 53)) | 0;
    this.time = 0;
    this.disposed = false;
    this.dustScale = opts.dustScale ?? 1;
    this.driftScale = opts.driftScale ?? 1;

    this.root = new THREE.Group();
    this.root.name = 'effects';
    scene.add(this.root);

    this._sun = null;
    scene.traverse(object => {
      if (!this._sun && object.isDirectionalLight) this._sun = object;
    });
    this.particles = new ParticlePool(this.root, {
      max: opts.maxParticles ?? 384,
      seed: this.seed,
      sun: this._sun,
    });
    this.skids = new SkidMarks(this.root, {
      max: opts.maxSkids ?? 720,
      lifetime: opts.skidLifetime ?? 14,
      seed: this.seed,
    });
    /* The player's plumb shadow. Not a particle and not governed: it is one
       mesh whose size and value are functions of the car's height, so it costs
       the pool nothing and there is no rate for the governor to admit. See
       src/fx/airmark.js for why the sun's own shadow could not do this job. */
    this.airMark = new AirMark(this.root);

    this._baseFrame = new Frame();
    this._wheelFrames = [new Frame(), new Frame(), new Frame(), new Frame()];
    this._patches = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this._patchSides = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this._skidLast = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this._skidLastSide = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this._wheelLat = new Float32Array(4);
    this._wheelHalfWidth = new Float32Array(4);
    this._dustTimers = new Float32Array(4);
    this._smokeTimer = 0;
    this._heroTimer = 0;
    this._brakeTimer = 0;
    this._brakeWheel = 0;
    this._speedTimer = 0;
    this._speedWheel = 0;
    this._speedDustTimer = 0;
    this._speedDustWheel = 0;
    this._skidClock = new Float32Array(4);
    this._skidValid = new Uint8Array(4);
    this._wheelWorld = new THREE.Vector3();
    this._delta = new THREE.Vector3();
    this._impactPoint = new THREE.Vector3();
    this._smokePoint = new THREE.Vector3();
    this._lastCarPos = new THREE.Vector3();
    this._lastS = 0;
    this._started = false;
    this._wasAirborne = false;
    this._airTime = 0;
    this._impactCooldown = 0;
    this._armedScale = 0;
    this._followers = [];
    this._followSeed = 0;
    /* One plumb mark per followed car, held by position in the follower list
       rather than on the CarEmission, so the per-car emission state keeps the
       lifecycle it already had — reset() rebuilds those and would otherwise
       orphan a mesh every time it ran. Grown on demand and never destroyed
       until dispose, so a rival re-entering the follow list costs no shader
       compile. */
    this._followMarks = [];
    this._eventPoint = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._hasCam = false;
    this._resetEmissionRandom();

    this.stats = {
      liveParticles: 0,
      liveClouds: 0,
      liveBursts: 0,
      liveGroundSlaps: 0,
      skidSegments: 0,
      speedLines: 0,
      drawCalls: 0,
      triangles: 0,
      driftStrength: 0,
      brakeStrength: 0,
      dustRate: 0,
    };
  }

  _resetEmissionRandom() {
    this.random = rand(rng(this.seed + 7919));
    for (let i = 0; i < 4; i++) this._dustTimers[i] = this.random.f(0.01, 0.09);
    this._smokeTimer = this.random.f(0.01, 0.05);
    this._heroTimer = this.random.f(0.01, 0.06);
    this._brakeTimer = this.random.f(0.01, 0.05);
    this._brakeWheel = 0;
    this._speedTimer = this.random.f(0.01, 0.06);
    this._speedWheel = 0;
    this._speedDustTimer = this.random.f(0.02, 0.10);
    this._speedDustWheel = 0;
  }

  /* Puffs arrive in clumps of one to three rather than one at a time. A
     constant rate with a jittered gap still lays them down at even average
     spacing, and even spacing is what the eye reads as cadence — clumping
     gives the trail the dense knots and thin stretches a real plume has. */
  _burst() {
    return this.random.chance(0.40) ? this.random.i(2, 3) : 1;
  }

  /* Long-tailed gap. Multiplying by the burst size upstream keeps the mean
     emission rate where it was, so this costs no extra particles. */
  _gap() {
    return this.random.chance(0.24) ? this.random.f(1.6, 3.0) : this.random.f(0.26, 1.0);
  }

  /* Seconds until the next puff, clamped. These timers are only ever
     decremented, so one interval scheduled from a rate barely above the
     cutoff parks the emitter minutes into the future and it never fires
     again: one slow corner during a run-up was enough to kill the dust for
     the rest of the descent. The ceiling is far longer than any interval at a
     rate you can actually see, so it changes nothing where it matters. */
  _interval(gap, rate) {
    return Math.min(gap / rate, 0.6);
  }

  /* Invariant 2, applied. Every continuous rate below is written for a clear
     frame and then asked for through here, so what the emitter wants and what
     the pool can afford stay separate quantities: the tuning above never has
     to know about the governor, and the governor never has to know what any
     of it is for. Rates this low produce nothing visible and would otherwise
     keep re-arming a timer for one puff a minute. */
  _govern(rate) {
    const allowed = this.particles.admit(rate);
    return allowed < 0.02 ? 0 : allowed;
  }

  _clearEmissionTimers() {
    this._dustTimers.fill(0);
    this._smokeTimer = 0;
    this._heroTimer = 0;
    this._brakeTimer = 0;
    this._speedTimer = 0;
    this._speedDustTimer = 0;
  }

  _updatePatches(car) {
    const track = this.track;
    /* `roadEnd`: the surface the wheels are on runs 120 m past the flag, and a
       car braking hard down the run-off is exactly where skids and dust are
       worth having. */
    const carS = clamp(car.s || 0, 0, track.roadEnd);
    const base = track.frameAt(carS, this._baseFrame);

    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const side = i % 2 === 0 ? -1 : 1;
      const longitudinal = front ? CAR.wheelBase * 0.5 : -CAR.wheelBase * 0.5;
      this._wheelWorld.copy(car.pos)
        .addScaledVector(car.forward, longitudinal)
        .addScaledVector(car.right, side * CAR.track * 0.5)
        .addScaledVector(car.up, -CAR.rideHeight);

      this._delta.subVectors(this._wheelWorld, base.pos);
      const s = clamp(carS + this._delta.dot(base.tan), 0, track.roadEnd);
      const frame = track.frameAt(s, this._wheelFrames[i]);
      this._delta.subVectors(this._wheelWorld, frame.pos);
      const lat = this._delta.dot(frame.right);
      const halfWidth = frame.width * 0.5;
      this._wheelLat[i] = lat;
      this._wheelHalfWidth[i] = halfWidth;

      const point = this._patches[i];
      if (Math.abs(lat) > halfWidth && typeof car.surfaceAt === 'function') {
        car.surfaceAt(s, lat, point);
        point.addScaledVector(frame.up, ROAD_LIFT);
      } else {
        const u = clamp(Math.abs(lat) / Math.max(halfWidth, 0.01), 0, 1);
        const height = EDGE_DROP * u * u * u + ROAD_LIFT;
        point.copy(frame.pos).addScaledVector(frame.right, lat).addScaledVector(frame.up, height);
      }

      const tyreSide = this._patchSides[i];
      tyreSide.copy(car.right).addScaledVector(frame.up, -car.right.dot(frame.up));
      if (tyreSide.lengthSq() < 1e-6) tyreSide.copy(frame.right);
      else tyreSide.normalize();
    }
  }

  _continuous(car, dt) {
    if (car.airborne) {
      this._clearEmissionTimers();
      this.stats.driftStrength = 0;
      this.stats.brakeStrength = 0;
      this.stats.dustRate = 0;
      return;
    }

    const speed = car.speed;
    const surface = clamp(car.offRoad || 0, 0, 1);
    const speedDust = smoothstep(2.5, 27, speed);
    let totalDustRate = 0;
    for (let i = 0; i < 4; i++) {
      const slip = clamp(car.wheelSlip[i] || 0, 0, 1);
      const axle = i < 2 ? 0.92 : 1.08;
      /* A fast car has to disturb something, so tarmac keeps a thin veil of
         grit and stirred air. It is deliberately an order of magnitude under
         the off-road rate and arrives only near the top of the speed range:
         the frame that read as boulders was on-road dust at volume, and the
         line between "the road is moving under you" and "there is an object
         in the lane" is drawn a long way below that. */
      /* Halved, with each puff correspondingly larger. Same amount of film on
         the road, made of a third as many pieces: at the old rate the veil was
         two dozen small torn shapes overlapping at close range, and a crowd of
         small torn shapes is froth however dark each one is. */
      const veil = smoothstep(19, 40, speed) * 9.0 * (1 - surface);
      const rate = this._govern(
        speedDust * (surface * 13 + slip * 2.1 + veil) * axle * this.dustScale);
      totalDustRate += rate;
      if (rate <= 0) {
        this._dustTimers[i] = 0;
        continue;
      }
      this._dustTimers[i] -= dt;
      const side = i % 2 === 0 ? -1 : 1;
      const strength = clamp(0.28 + surface * 0.62 + slip * 0.25, 0, 1);
      let emitted = 0;
      while (this._dustTimers[i] <= 0 && emitted < 4) {
        const burst = this._burst();
        for (let b = 0; b < burst && emitted < 4; b++) {
          emitted++;
          this.particles.emitDust(this._patches[i], car, side, strength, surface);
        }
        this._dustTimers[i] += this._interval(this._gap() * burst, rate);
      }
    }

    const braking = smoothstep(0.28, 0.88, car.brake || 0) * smoothstep(10, 32, speed);
    const brakeRate = this._govern(braking * 34);
    this.stats.brakeStrength = braking;
    if (brakeRate <= 0) {
      this._brakeTimer = 0;
    } else {
      this._brakeTimer -= dt;
      let emitted = 0;
      while (this._brakeTimer <= 0 && emitted++ < 3) {
        const wheel = this._brakeWheel++ & 3;
        this.particles.emitBraking(
          this._patches[wheel], car, wheel % 2 === 0 ? -1 : 1, braking, surface,
        );
        this._brakeTimer += this._interval(this.random.f(0.58, 1.42), brakeRate);
      }
    }

    const rearSlip = clamp(((car.wheelSlip[2] || 0) + (car.wheelSlip[3] || 0)) * 0.5, 0, 1);
    const angle = Math.abs(car.slipAngle || 0);
    const telemetryDrift = smoothstep(0.10, 0.36, angle) * smoothstep(0.28, 0.88, rearSlip);
    /* Slip angle is the authoritative fallback: during a handbrake rotation,
       tyre telemetry can briefly recover before the body has stopped sliding. */
    const angleDrift = smoothstep(0.30, 0.62, angle) * smoothstep(6, 15, speed);
    const movingDrift = Math.max(telemetryDrift, angleDrift * 0.92);
    const burnout = (1 - smoothstep(3.5, 8, speed))
      * smoothstep(0.68, 0.96, rearSlip)
      * smoothstep(0.48, 0.94, car.throttle || 0)
      * smoothstep(0.35, 0.9, car.handbrake || 0);
    const drift = clamp(Math.max(movingDrift, burnout * 0.88) * this.driftScale, 0, 1);
    this.stats.driftStrength = drift;

    const moving = smoothstep(5, 12, speed);
    /* Off the road the wheels are already throwing their own dust, and a
       drift out there ran both emitters at full rate into the same few cubic
       metres — enough to bury the car in its own plume at the 44% corner. */
    const smokeRate = this._govern(drift * lerp(12, 58, moving) * lerp(1, 0.45, surface));
    if (smokeRate <= 0) {
      this._smokeTimer = 0;
    } else {
      this._smokeTimer -= dt;
      let emitted = 0;
      while (this._smokeTimer <= 0 && emitted < 6) {
        const burst = this._burst();
        for (let b = 0; b < burst && emitted < 6; b++) {
          emitted++;
          const wheel = this.random.chance(0.5) ? 2 : 3;
          this.particles.emitDrift(this._patches[wheel], car, wheel === 2 ? -1 : 1, drift, surface);
        }
        this._smokeTimer += this._interval(this._gap() * burst, smokeRate);
      }
    }

    const heroRate = this._govern(drift * moving * 9);
    if (heroRate <= 0) {
      this._heroTimer = 0;
    } else {
      this._heroTimer -= dt;
      let emitted = 0;
      while (this._heroTimer <= 0 && emitted++ < 2) {
        this._smokePoint.copy(this._patches[2]).add(this._patches[3]).multiplyScalar(0.5);
        this.particles.emitHeroDrift(this._smokePoint, car, drift, surface);
        this._heroTimer += this._interval(this.random.f(0.58, 1.52), heroRate);
      }
    }

    const speedAmount = smoothstep(38, 50, speed);
    const streakRate = this._govern(speedAmount * (24 + speedAmount * 26));
    if (streakRate <= 0) {
      this._speedTimer = 0;
    } else {
      this._speedTimer -= dt;
      let emitted = 0;
      while (this._speedTimer <= 0 && emitted++ < 3) {
        const wheel = 2 + (this._speedWheel++ & 1);
        this.particles.emitSpeedWake(
          this._patches[wheel], car, wheel === 2 ? -1 : 1, speedAmount, surface,
        );
        this._speedTimer += this.random.f(0.58, 1.46) / streakRate;
      }
    }

    const groundWakeRate = this._govern(speedAmount * 30);
    if (groundWakeRate <= 0) {
      this._speedDustTimer = 0;
    } else {
      this._speedDustTimer -= dt;
      let emitted = 0;
      while (this._speedDustTimer <= 0 && emitted++ < 2) {
        const wheel = 2 + (this._speedDustWheel++ & 1);
        this.particles.emitSpeedDust(
          this._patches[wheel], car, wheel === 2 ? -1 : 1, speedAmount, surface,
        );
        this._speedDustTimer += this.random.f(0.68, 1.36) / groundWakeRate;
      }
    }
    this.stats.dustRate = totalDustRate + brakeRate + groundWakeRate;
  }

  _skidMarks(car, dt) {
    const interval = 1 / 30;
    const speed = car.speed;
    const angle = smoothstep(0.08, 0.42, Math.abs(car.slipAngle || 0));
    for (let i = 0; i < 4; i++) {
      const rawSlip = clamp(car.wheelSlip[i] || 0, 0, 1);
      const brakeSkid = smoothstep(0.72, 1, car.brake || 0)
        * smoothstep(18, 34, speed) * (i < 2 ? 0.56 : 0.44);
      const angleSkid = i >= 2 ? angle * 0.90 * smoothstep(8, 18, speed) : 0;
      const slip = Math.max(rawSlip, brakeSkid, angleSkid);
      const onRoad = Math.abs(this._wheelLat[i]) < this._wheelHalfWidth[i] - 0.14;
      const eligible = !car.airborne && speed > 2.2 && slip > 0.36 && onRoad;
      if (!eligible) {
        this._skidValid[i] = 0;
        this._skidClock[i] = 0;
        continue;
      }
      if (!this._skidValid[i]) {
        this._skidValid[i] = 1;
        this._skidLast[i].copy(this._patches[i]);
        this._skidLastSide[i].copy(this._patchSides[i]);
        this._skidClock[i] = 0;
        continue;
      }

      this._skidClock[i] += dt;
      if (this._skidClock[i] < interval) continue;
      this._skidClock[i] -= interval;
      const dist2 = this._skidLast[i].distanceToSquared(this._patches[i]);
      if (dist2 > 0.0064 && dist2 < 9) {
        const width = CAR.wheelW * lerp(1.08, 1.58, slip) * lerp(0.92, 1.12, angle);
        const strength = lerp(0.68, 1, smoothstep(0.36, 1, slip));
        this.skids.add(
          this._skidLast[i], this._patches[i],
          this._skidLastSide[i], this._patchSides[i],
          width, strength, this.time,
        );
      }
      this._skidLast[i].copy(this._patches[i]);
      this._skidLastSide[i].copy(this._patchSides[i]);
    }
  }

  _events(car, dt) {
    /* Events are emitted wherever the car happens to be, so they have to be
       told what they are standing on for the same reason the continuous
       emitters are: the value invariant is a lift on the ground, and a burst
       that assumed tarmac put tarmac-coloured dust on grass. */
    const surface = clamp(car.offRoad || 0, 0, 1);
    const launched = this._started && !this._wasAirborne && car.airborne;
    const landed = this._started && this._wasAirborne && !car.airborne;
    if (car.airborne) this._airTime += dt;
    if (launched) {
      /* Off the rear patches, which are the last two things touching the
         ramp, and only above a speed at which leaving the ground means
         anything — a car crawling over a crest lifts a wheel without
         disturbing the surface, and grit thrown at walking pace is litter. */
      const lift = clamp(smoothstep(9, 30, car.speed), 0, 1);
      if (lift > 0.02) {
        this._eventPoint.copy(this._patches[2]).add(this._patches[3]).multiplyScalar(0.5);
        this.particles.emitTakeoff(
          this._eventPoint, car, lift, surface,
          this.particles.admitEvent(this._armedScale > 0 ? this._armedScale : 1),
        );
      }
    }
    if (landed) {
      const strength = clamp(Math.max(car.lastImpact || 0, 0.28 + this._airTime * 0.5), 0.28, 1);
      /* One burst under the whole car rather than one per wheel. Four small
         bursts a metre apart are four events the eye can count, and anything
         countable at this range is a set of objects; the car hit the ground
         once, so the ground answers once. */
      this._impactPoint.copy(this._patches[0]).add(this._patches[1])
        .add(this._patches[2]).add(this._patches[3]).multiplyScalar(0.25);
      this.particles.emitLandingBurst(
        this._impactPoint, car, strength, surface,
        this.particles.admitEvent(this._takeScale(this._airTime)),
      );
      this._airTime = 0;
      this._impactCooldown = 0.18;
    }

    this._impactCooldown = Math.max(0, this._impactCooldown - dt);
    const impact = clamp(car.lastImpact || 0, 0, 1);
    if (!landed && impact > 0.04 && this._impactCooldown <= 0) {
      /* Invariant 2 on an event: the scrape is made smaller when the frame is
         already full rather than skipped. A collision that produces nothing
         reads as the car passing through the barrier. */
      let side = car.lat < 0 ? -1 : 1;
      if (Math.abs(car.lat) < 0.1) side = car.vy < 0 ? -1 : 1;
      this._impactPoint.copy(car.pos)
        .addScaledVector(car.forward, CAR.length * 0.42)
        .addScaledVector(car.right, side * CAR.width * 0.48)
        .addScaledVector(car.up, 0.30);
      this.particles.emitImpact(
        this._impactPoint, car, side, impact, surface, this.particles.admitEvent(1));
      this._impactCooldown = lerp(0.11, 0.22, impact);
    }
    this._wasAirborne = !!car.airborne;
  }

  /* How big this jump was, consumed as it is read. An armed number always
     wins: the thing that built the ramp knows its height and its exit angle
     and does not have to guess. Failing that it is inferred from the flight,
     which is deliberately conservative — a system that has not been told
     about a jump should draw the landing it has always drawn rather than
     invent a bigger one, so the inference is flat across everything the stage
     produces on its own and only rises for air no crest can give you. */
  _takeScale(airTime) {
    if (this._armedScale > 0) {
      const armed = this._armedScale;
      this._armedScale = 0;
      return armed;
    }
    return 1 + smoothstep(AIR_SMALL, AIR_LARGE, airTime) * (SCALE_MAX - 1);
  }

  /* ── The jump interface ────────────────────────────────────────────────────
   *
   * Written for System 2 to call and safe to not call: a car that goes
   * airborne and comes down produces a take-off scuff and a landing burst
   * whether or not anything told this module a ramp was involved, because the
   * airborne flag is all either event actually needs. What the calls below buy
   * is size. A ramp knows how big it is; the flight can only be measured after
   * the fact, and only roughly.
   *
   *   fx.armLanding(scale)   the jump about to happen is this big. Consumed by
   *                          the next take-off and landing pair on the player,
   *                          so arm it on the frame the car meets the lip.
   *   fx.launch(car, scale)  throw the take-off scuff now, for a boost pad or
   *                          a ramp that wants the grit before the physics has
   *                          left the ground. Optional — the rising edge of
   *                          `airborne` fires one on its own.
   *   fx.land(car, o)        force a landing burst now, at { strength, scale }.
   *                          Optional in the same way.
   *   fx.follow(cars)        cars other than the player whose dust the system
   *                          should also throw. See _follow() below.
   *
   * `scale` is one axis shared by both ends of a jump: 1 is the berm drop the
   * stage already produces, 3.4 is a full ramp — a 3.9 m curtain on a 4 m
   * ring — and it is clamped at 3.6. It is an amplitude, not a strength:
   * strength saturates at 1 and always did, which is why a ramp landing could
   * not be made to look bigger than a kerb hop before this existed.
   */
  armLanding(scale) {
    this._armedScale = clamp(Number.isFinite(scale) ? scale : 1, 0.35, 3.6);
  }

  launch(car, scale = 1) {
    if (this.disposed || !car) return;
    const lift = clamp(smoothstep(9, 30, car.speed), 0.15, 1);
    this._updatePatches(car);
    this._eventPoint.copy(this._patches[2]).add(this._patches[3]).multiplyScalar(0.5);
    this.particles.emitTakeoff(
      this._eventPoint, car, lift, clamp(car.offRoad || 0, 0, 1),
      this.particles.admitEvent(scale),
    );
  }

  land(car, { strength = 1, scale = 1 } = {}) {
    if (this.disposed || !car) return;
    this._updatePatches(car);
    this._impactPoint.copy(this._patches[0]).add(this._patches[1])
      .add(this._patches[2]).add(this._patches[3]).multiplyScalar(0.25);
    this.particles.emitLandingBurst(
      this._impactPoint, car, clamp(strength, 0.28, 1),
      clamp(car.offRoad || 0, 0, 1), this.particles.admitEvent(scale),
    );
    this._airTime = 0;
  }

  /**
   * Cars other than the player that should disturb the ground they are on.
   *
   * A rival going over a ramp in front of the camera and landing in silence,
   * with the road under it unmarked, does not read as a car that is heavy —
   * it reads as a bug, and it is the shot the jump section will spend most of
   * its time pointing at. Following one is deliberately not the same as being
   * the player: a rival gets wheel dust, slide smoke and both ends of a jump,
   * and does not get brake dust, speed streaks, the hero puff or skid marks.
   * Those four are read at the range you look at your own car from, cost the
   * shared pool the same as the player's, and nobody watches a rival's tyres.
   *
   * Idempotent, and safe to call every frame with the same array — the
   * per-car clocks survive as long as the car does.
   */
  follow(cars) {
    if (this.disposed) return;
    const list = Array.isArray(cars) ? cars : (cars ? [cars] : []);
    const kept = [];
    for (const car of list) {
      if (!car) continue;
      const existing = this._followers.find(f => f.car === car);
      kept.push(existing || new CarEmission(car, this.seed + (this._followSeed++) * 613));
    }
    this._followers = kept;
  }

  /* One followed car, at a rate discounted for how far away it is. The
     discount is a distance falloff and not a visibility test on purpose: a
     car that comes back into frame with no dust around it has more obviously
     just been switched on than one whose plume was always thin. */
  /* The mark for follower `index`, made if this is the first time that slot has
     been asked for. */
  _followMark(index) {
    let mark = this._followMarks[index];
    if (!mark) mark = this._followMarks[index] = new AirMark(this.root);
    return mark;
  }

  _followOne(entry, dt, index) {
    const car = entry.car;
    const distance = this._hasCam
      ? this._camPos.distanceTo(car.pos)
      : this._lastCarPos.distanceTo(car.pos);
    if (distance > FOLLOW_FAR) {
      entry.dustTimers.fill(0);
      entry.smokeTimer = 0;
      entry.wasAirborne = !!car.airborne;
      entry.started = true;
      this._followMarks[index]?.hide();
      return;
    }
    const share = FOLLOW_SHARE * (1 - smoothstep(FOLLOW_NEAR, FOLLOW_FAR, distance));
    const q = entry.random;
    this._updatePatches(car);

    /* A rival's jump has the same defect the player's had — a car several metres
       up with a camera that cannot show it is off the ground — and a race puts
       twenty-six rival flights over the three lips, so it is not a rare frame.
       Faded out over the same window the dust uses, which does two things: it
       costs nothing where a rival is a fistful of fogged pixels, and it keeps
       the mark from ever being the small dark patch on a distant road that this
       project's recurring failure is made of. Inside the near figure a rival is
       big enough that its shadow is legibly a shadow. */
    const mark = this._followMark(index);
    mark.strength = 1 - smoothstep(FOLLOW_NEAR, FOLLOW_FAR, distance);
    mark.update(car, this._patches, this._baseFrame.up);

    const surface = clamp(car.offRoad || 0, 0, 1);
    if (!car.airborne) {
      const speed = car.speed;
      const speedDust = smoothstep(2.5, 27, speed);
      for (let i = 0; i < 4; i++) {
        const slip = clamp(car.wheelSlip[i] || 0, 0, 1);
        const axle = i < 2 ? 0.92 : 1.08;
        const veil = smoothstep(19, 40, speed) * 9.0 * (1 - surface);
        const rate = this._govern(
          speedDust * (surface * 13 + slip * 2.1 + veil) * axle * this.dustScale * share);
        if (rate <= 0) { entry.dustTimers[i] = 0; continue; }
        entry.dustTimers[i] -= dt;
        const side = i % 2 === 0 ? -1 : 1;
        const strength = clamp(0.28 + surface * 0.62 + slip * 0.25, 0, 1);
        let emitted = 0;
        while (entry.dustTimers[i] <= 0 && emitted++ < 3) {
          this.particles.emitDust(this._patches[i], car, side, strength, surface);
          entry.dustTimers[i] += Math.min(q.f(0.26, 1.4) / rate, 0.6);
        }
      }

      const rearSlip = clamp(((car.wheelSlip[2] || 0) + (car.wheelSlip[3] || 0)) * 0.5, 0, 1);
      const angle = Math.abs(car.slipAngle || 0);
      const drift = clamp(smoothstep(0.10, 0.36, angle) * smoothstep(0.28, 0.88, rearSlip)
        * this.driftScale, 0, 1);
      const smokeRate = this._govern(
        drift * lerp(12, 58, smoothstep(5, 12, car.speed)) * lerp(1, 0.45, surface) * share);
      if (smokeRate <= 0) {
        entry.smokeTimer = 0;
      } else {
        entry.smokeTimer -= dt;
        let emitted = 0;
        while (entry.smokeTimer <= 0 && emitted++ < 4) {
          const wheel = q.chance(0.5) ? 2 : 3;
          this.particles.emitDrift(this._patches[wheel], car, wheel === 2 ? -1 : 1, drift, surface);
          entry.smokeTimer += Math.min(q.f(0.26, 1.0) / smokeRate, 0.6);
        }
      }
    }

    if (!entry.started) {
      entry.started = true;
      entry.wasAirborne = !!car.airborne;
      entry.airTime = 0;
      return;
    }
    if (car.airborne) entry.airTime += dt;
    if (!entry.wasAirborne && car.airborne) {
      const lift = clamp(smoothstep(9, 30, car.speed), 0, 1);
      if (lift > 0.02) {
        this._eventPoint.copy(this._patches[2]).add(this._patches[3]).multiplyScalar(0.5);
        this.particles.emitTakeoff(
          this._eventPoint, car, lift, surface, this.particles.admitEvent(share + 0.38));
      }
    } else if (entry.wasAirborne && !car.airborne) {
      const strength = clamp(Math.max(car.lastImpact || 0, 0.28 + entry.airTime * 0.5), 0.28, 1);
      const scale = 1 + smoothstep(AIR_SMALL, AIR_LARGE, entry.airTime) * (SCALE_MAX - 1);
      this._eventPoint.copy(this._patches[0]).add(this._patches[1])
        .add(this._patches[2]).add(this._patches[3]).multiplyScalar(0.25);
      this.particles.emitLandingBurst(
        this._eventPoint, car, strength, surface,
        this.particles.admitEvent(scale * (0.55 + share * 0.72)),
      );
      entry.airTime = 0;
    }
    entry.wasAirborne = !!car.airborne;
  }

  update(dt, car, _camera) {
    if (this.disposed || !car) return;
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.05);
    this.time += dt;

    if (!this._started) {
      this._started = true;
      this._wasAirborne = !!car.airborne;
      this._airTime = 0;
      this._lastCarPos.copy(car.pos);
      this._lastS = car.s || 0;
    } else {
      const teleported = this._lastCarPos.distanceToSquared(car.pos) > 400
        || Math.abs((car.s || 0) - this._lastS) > 25;
      if (teleported) {
        this._skidValid.fill(0);
        this._skidClock.fill(0);
        this._clearEmissionTimers();
      }
      this._lastCarPos.copy(car.pos);
      this._lastS = car.s || 0;
    }

    /* The pool is judged from the camera the frame will actually be rendered
       from. It also picks this up in onBeforeRender, but a tool that steps the
       simulation without drawing it would otherwise never measure anything,
       and an invariant that only holds while someone is looking is not one. */
    if (_camera?.isCamera) {
      this.particles.observe(_camera);
      this._camPos.setFromMatrixPosition(_camera.matrixWorld);
      this._hasCam = true;
    }

    this._updatePatches(car);
    /* Before anything else touches the patch scratch, and before the followers
       overwrite it: the mark is the player's four contact points dropped onto
       the surface, so it has to be placed while those are still the player's. */
    this.airMark.update(car, this._patches, this._baseFrame.up);
    this._continuous(car, dt);
    this._skidMarks(car, dt);
    this._events(car, dt);
    /* After the player and using the same patch scratch, which is why each
       followed car is taken to completion before the next one starts. */
    for (let i = 0; i < this._followers.length; i++) this._followOne(this._followers[i], dt, i);
    /* A field that shrank leaves marks behind on the road otherwise. */
    for (let i = this._followers.length; i < this._followMarks.length; i++) {
      this._followMarks[i]?.hide();
    }
    this.particles.update(dt);
    this.skids.update(this.time);

    this.stats.liveParticles = this.particles.live;
    this.stats.liveClouds = this.particles.live - this.particles.liveChunks;
    this.stats.liveBursts = this.particles.liveChunks;
    this.stats.liveGroundSlaps = this.particles.liveGroundSlaps;
    this.stats.skidSegments = this.skids.live;
    this.stats.speedLines = this.particles.liveSpeed;
    this.stats.drawCalls = (this.particles.mesh.visible ? 1 : 0)
      + (this.skids.mesh.visible ? 1 : 0);
    this.stats.triangles = (this.particles.mesh.visible ? this.particles.max * 2 : 0)
      + (this.skids.mesh.visible ? this.skids.max * 2 : 0);
  }

  reset() {
    if (this.disposed) return;
    this.time = 0;
    this.particles.reset();
    this.skids.reset();
    this.airMark.hide();
    /* Sparse: slots are filled the first time a follower at that index is close
       enough to be worth one, so a race where the second car has been in range
       and the first has not leaves a hole at zero. */
    for (const mark of this._followMarks) mark?.hide();
    this._resetEmissionRandom();
    this._skidClock.fill(0);
    this._skidValid.fill(0);
    this._started = false;
    this._wasAirborne = false;
    this._airTime = 0;
    this._impactCooldown = 0;
    this._armedScale = 0;
    this._followers = this._followers.map(
      (f, i) => new CarEmission(f.car, this.seed + i * 613));
    this._followSeed = this._followers.length;
    this.stats.liveParticles = 0;
    this.stats.liveClouds = 0;
    this.stats.liveBursts = 0;
    this.stats.liveGroundSlaps = 0;
    this.stats.skidSegments = 0;
    this.stats.speedLines = 0;
    this.stats.drawCalls = 0;
    this.stats.triangles = 0;
    this.stats.driftStrength = 0;
    this.stats.brakeStrength = 0;
    this.stats.dustRate = 0;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._followers = [];
    this.particles.dispose();
    this.skids.dispose();
    this.airMark.dispose();
    for (const mark of this._followMarks) mark?.dispose();
    this._followMarks = [];
    this.root.removeFromParent();
    this.root.clear();
  }
}
