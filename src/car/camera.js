/* Chase camera.
 *
 * Tight behind the car, as asked — which is the hard version, because a tight
 * camera has no room to absorb anything. Four things make it survivable:
 *
 *   The camera follows the car's *velocity*, not its heading. In a drift the
 *   car points thirty degrees off its direction of travel, and a camera locked
 *   to the body swings that thirty degrees too, so the road appears to lurch
 *   sideways while the car sits still on screen. Following velocity keeps the
 *   road stable and lets the car visibly slide across the frame, which is the
 *   entire visual payoff of a drift.
 *
 *   Position is critically damped toward the target rather than lerped by a
 *   fixed factor, so behaviour does not change with frame rate.
 *
 *   The boom's yaw trails the car's rather than being welded to it. Welded,
 *   the car is a fixed sprite and the world rotates around it, which is the
 *   difference between a corner reading as the car turning and reading as the
 *   scenery being swung past. A trailing boom lets the car rotate first and
 *   arrive a beat later, so you see its flank through the turn.
 *
 *   Speed pushes the camera back and widens the lens. Both are old tricks and
 *   both work: the field of view opening from 62 to 82 degrees between a
 *   standstill and 200 km/h is most of what makes fast feel fast.
 */
import * as THREE from 'three';
import { clamp, lerp, approach, smoothstep } from '../core/util.js';

const _p = new THREE.Vector3();
const _look = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _right = new THREE.Vector3();
const _head = new THREE.Vector3();
const _boom = new THREE.Vector3();
const _side = new THREE.Vector3();
const _vert = new THREE.Vector3();
const _off = new THREE.Vector3();
const _boomDir = new THREE.Vector3();

const TAU = Math.PI * 2;
/** Signed difference folded into (-pi, pi]. The whole seam problem lives here
    and nowhere else: no other line in this file subtracts two absolute
    angles. */
const wrapPi = a => {
  const t = (a + Math.PI) % TAU;
  return (t < 0 ? t + TAU : t) - Math.PI;
};

/* The boom is a line, the camera is not. Four extra rays stand in for a sphere
   cast, aimed at points spread around the lens: side and vertical offset in
   metres, applied at the far end. */
const FATTEN = [[0.55, 0], [-0.55, 0], [0, 0.45], [0, -0.45]];

/* How close the lens is allowed to get to rock. The near plane is 0.4 m, so
   anything under that is a hole in the world; the rest is margin for five thin
   rays standing in for a camera that has width. */
const SKIN = 0.55;
/* Below this the camera is inside the car's own bodywork, which looks worse
   than a frame of wall. Some of this stage does get near it — a cut wall a
   metre behind the driver's head leaves nowhere shorter to go — which is what
   the sideways slide in `resolveOcclusion` exists to handle. */
const MIN_BOOM = 2.6;
/* And how short it may go when the wall leaves no better option. Below this the
   lens is through the windscreen and the frame is all bonnet; at this length it
   is around the rear deck, which is a look every racing game shows you when you
   put a car into a barrier. */
const CRAMP_BOOM = 1.35;
/* How far above the ground directly beneath it the lens is kept. */
const GROUND_CLEAR = 0.9;
/* Rate the boom eases back out once the way is clear, 1/s. Fast enough that a
   150 km/h clip is forgotten within a car length or two — at 2.6 the shot
   fifty metres past the obstruction was still on the bumper — slow enough
   that the return is a move rather than a cut. */
const RECOVER = 6.0;
/* Rate the sideways slide eases away, 1/s. Slower than the boom's recovery on
   purpose: the slide is a lateral shift of the lens, so unwinding it swings the
   whole picture, and that reads far worse in a hurry than the boom's purely
   fore-and-aft return does. */
const SLIDE_RECOVER = 3.0;
/* Clearance the slide aims for beyond the surface. Smaller than SKIN: by the
   time this runs the lens is genuinely inside rock and the job is to get the
   near plane out, not to re-establish a comfortable margin the geometry has
   already proven it does not have room for. */
const SLIDE_SKIN = 0.45;

/* Rotational lag, 1/s. A first-order lag settles at yawRate / YAW_RATE, so
   this is "how many radians of yaw rate buy one radian of camera error" turned
   upside down: at 3.2, a 40 deg/s corner trails by about 12 degrees and a slow
   sweeper by three or four. Deliberately expressed as a rate rather than as a
   per-corner amount, because the car's steering response is being reworked
   underneath this file and a rate keeps its meaning when the yaw does not. */
const YAW_RATE = 3.2;
/* The furthest the boom is ever allowed to fall behind, radians. At the long
   boom this puts the lens 2.1 m off dead astern, which moves the car about a
   sixth of the frame — visible as a camera swinging through the corner, still
   nowhere near losing it. */
const MAX_YAW_LAG = 0.26;

/* Where the dutch stops being proportional, and what it approaches instead.
   It used to be a hard clamp at 0.075, sized back when `car.roll` was mostly
   road camber and the term's job was to keep noise off the horizon. The roll
   signal now tracks cornering load, and against a clean signal a hard clamp is
   the wrong shape: measured over a lap the expression asked for more than the
   clamp on 42% of the frames and stayed pinned for as long as 4.6 s at a
   stretch, so through most of every real corner the tilt was a constant and
   told the player nothing about how hard they were cornering.

   Below the knee the response is exactly what it always was, so ordinary
   driving is untouched; above it the curve bends over to the limit instead of
   stopping dead. Across the frames with real load on the car that spreads the
   tilt over 1.5 degrees where the clamp allowed 0.8, and it costs no extra
   shimmer — frame-to-frame jitter is 42.5 deg/s against the clamp's 43.0. */
const DUTCH_KNEE = 0.058;
const DUTCH_LIMIT = 0.098;

/** Linear to `knee`, then asymptotic to `limit`. Monotonic throughout, which
    is the point: a clamped signal has no gradient left to read. */
function softRoll(x) {
  const a = Math.abs(x);
  if (a <= DUTCH_KNEE) return x;
  const span = DUTCH_LIMIT - DUTCH_KNEE;
  return Math.sign(x) * (DUTCH_KNEE + span * (1 - Math.exp(-(a - DUTCH_KNEE) / span)));
}

/* Letting the boom climb over the obstruction instead of shortening was tried
   here — four candidate elevations up to twelve metres, tested before giving
   up any length. On this stage it bought nothing: replayed over the same lap
   it left the deepest penetration and the worst clearance identical to the
   digit and saved three frames in fifteen thousand from a tight boom. Every
   place the boom is blocked, the car has run into the side of a cut whose
   wall is far taller than the camera can climb, so there is no top to get
   over. It is not in the code because it did not earn its rays. */

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.pos = new THREE.Vector3();
    /* Where the lens actually goes: `pos` after the occlusion test has had its
       say. They are the same vector everywhere the boom is clear. */
    this.camPos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.fov = 62;
    /* The solid-world proxy, installed by main.js once the stage is built.
       Absent means no occlusion test — the camera still works, it just goes
       back to being able to end up behind a wall. */
    this.world = null;
    this.collideEnabled = true;
    this.yawLagEnabled = true;
    /* False restores the old hard clamp on the dutch, so tools/camturn.mjs can
       shoot both sides of that change from one build. */
    this.softDutchEnabled = true;
    /* Boom yaw, and how far behind the car's it currently is. Absolute rather
       than an accumulated delta so it cannot drift; re-anchored every frame. */
    this.yaw = 0;
    this.yawLag = 0;
    /* Fraction of the boom actually in use: 1 is clear, less is pulled in.
       Held between frames because the recovery is a spring. */
    this.occl = 1;
    this.lift = 0;
    this.air = 0;              // 0..1, how far into the airborne pullback
    /* The three airborne terms, as knobs rather than constants, for the same
       reason setPosterize and setShadowFloor are knobs: the useful values sit
       close together and the only way to find one is to sweep it against a
       measured number on a live frame. The lift and the widen shipped at 2.4
       and 6, were measured subtracting from the read they existed to create,
       and are now zero — see the comment on `high` in update(). Kept
       addressable so that claim stays falsifiable from a tool rather than
       having to be taken on trust. tools/airlift.mjs is the sweep. */
    this.airBoom = 1.5;        // metres the boom lengthens by, at full air
    this.airLift = 0;          // metres the lens climbs by
    this.airFov = 0;           // degrees the lens widens by
    /* Lateral escape for the case the boom floor cannot solve, and the face
       normal it is taken from. Vectors rather than scalars because the
       direction changes with the wall. */
    this.slide = new THREE.Vector3();
    this._hitN = new THREE.Vector3(0, 1, 0);
    /* Distance from the lens to the surface ahead of it along the boom, for
       tools/camprobe.mjs. */
    this.boomHeadroom = Infinity;
    this.shake = 0;
    this.shakeAge = 1;
    this.shakeTime = 2.173;
    this.shakeSide = 0;
    this.shakeCooldown = 0;
    this.shakeEnabled = true;
    this.speedResponseEnabled = true;
    this.started = false;
    this.mode = 'chase';
  }

  addShake(v, side = 0) {
    if (!this.shakeEnabled) return;
    const kick = clamp((v - 0.025) / 0.975, 0, 1);
    if (kick < 0.02 || (this.shakeCooldown > 0 && kick < this.shake * 0.9)) return;
    /* Max-plus-a-little accumulation gives a new collision its own punch
       without turning a sustained wall scrape into permanent vibration. */
    this.shake = Math.min(1.2, Math.max(this.shake, kick * 0.95) + kick * 0.16);
    this.shakeAge = 0;
    this.shakeSide = Math.abs(side) > 0.1 ? Math.sign(side) : 0;
    this.shakeCooldown = 0.065;
  }

  /**
   * How much of the way from `_head` to `target` is free, as a fraction of
   * that distance. 1 is a clear boom.
   *
   * Five rays: one down the middle and four aimed at points spread around the
   * lens, standing in for a sphere cast. They all leave from the same origin
   * rather than running parallel, and that detail is load-bearing. Parallel
   * rays would start half a metre to the side of the driver's head, and on
   * exactly the stations that matter the car is scraping a bank half a metre
   * away — so those origins begin inside rock, report a hit immediately, and
   * yank the camera onto the bumper at a moment when it was still perfectly
   * clear. Measured, that was worse than doing nothing at all. Sharing the
   * centre ray's origin means a fattened ray can only report something the
   * centre ray could plausibly have hit.
   */
  _probe(target) {
    const world = this.world;
    _boom.copy(target).sub(_head);
    const len = _boom.length();
    if (len < 0.05) return 1;
    _boom.multiplyScalar(1 / len);

    _side.crossVectors(_boom, UP);
    if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0); else _side.normalize();
    _vert.crossVectors(_side, _boom);

    /* One plan-space cell of padding covers the whole fan, so every ray shares
       a candidate set and the grid lookup is effectively paid for once. */
    const d0 = world.raycast(_head.x, _head.y, _head.z, _boom.x, _boom.y, _boom.z, len + SKIN, 0.8);
    let free = (d0 - SKIN) / len;
    /* Two answers from the same rays. `free` carries the skin, and is what the
       boom is shortened against — a margin is exactly what you want there.
       `hitFree` is where the surface actually is, with no margin, and is what
       the sideways slide is measured against: a lens merely inside the margin
       is not inside anything, and sliding the picture a couple of metres to fix
       a fault that does not exist is a worse trade than the margin itself. */
    this._hitFree = d0 / len;
    this._hitN.set(world.hitNx, world.hitNy, world.hitNz);
    for (let i = 0; i < FATTEN.length; i++) {
      _off.copy(target)
        .addScaledVector(_side, FATTEN[i][0]).addScaledVector(_vert, FATTEN[i][1]).sub(_head);
      const rlen = _off.length();
      if (rlen < 0.05) continue;
      _off.multiplyScalar(1 / rlen);
      const d = world.raycast(_head.x, _head.y, _head.z, _off.x, _off.y, _off.z, rlen + SKIN, 0.8);
      const f = (d - SKIN) / rlen;
      /* The normal is kept from whichever ray is the binding one, since that is
         the surface the lens has to get out from behind. */
      if (f < free) { free = f; this._hitFree = d / rlen; this._hitN.set(world.hitNx, world.hitNy, world.hitNz); }
    }
    return free;
  }

  /**
   * Keep the lens out of the scenery.
   *
   * Cast back along the boom from a point inside the car — which is by
   * definition in free space, since the car is standing there — to where the
   * camera wants to be. Anything hit on the way is between the driver and the
   * lens, so the lens is behind it, so the boom gets shortened to stop just
   * short of the hit.
   *
   * Pulling in is immediate and easing out is a spring, which is the
   * asymmetry every third-person camera ends up with: one frame spent inside
   * a cliff is a visible failure, whereas a measured return costs nothing.
   *
   * This runs as a post-process on `pos` and writes `camPos`, rather than
   * editing `pos` in place. Editing in place made the collapsed position the
   * state the spring recovered *from*, so the ordinary damping spent the next
   * second dragging a corrupted position back out and the shot forty metres
   * later still had the lens inside the bodywork. Kept separate, `pos` never
   * knows this happened, the free-flight camera is bit-for-bit what it was,
   * and recovery is one well-defined blend.
   */
  resolveOcclusion(car, dt) {
    this.camPos.copy(this.pos);
    if (!this.world || !this.collideEnabled) {
      this.occl = 1; this.lift = 0; this.slide.set(0, 0, 0); this.boomHeadroom = Infinity;
      return;
    }
    /* The drawn car, not the simulated one — see the note in update(). */
    _head.copy(car.renderPos || car.pos).addScaledVector(car.up, 1.2);
    if (_head.distanceToSquared(this.pos) < 0.0025) return;

    const free = this._probe(this.pos);

    _boom.copy(this.pos).sub(_head);
    const len = _boom.length();
    _boom.multiplyScalar(1 / len);

    /* Two floors, and which one applies depends on whether the geometry leaves
       a choice. MIN_BOOM is the one that is wanted; where the wall is closer to
       the driver's head than that, the boom is allowed to cramp further, down
       to CRAMP_BOOM, before the sideways slide below is asked to make up the
       rest. That ordering is deliberate: shortening the boom moves the lens
       along the axis it already travels on, so it reads as the camera closing up
       on the car, which players see whenever they clout a barrier. Sliding moves
       it across that axis, so it reads as the picture jumping. Given a metre of
       correction to find it is much better spent on the first than the second —
       measured, spending it this way cut the worst single-frame slide from
       2.89 m to a third of that, at the cost of a boom briefly tighter than
       ideal at six stations of the lap.

       Whichever floor applies is applied after the spring as well as before it.
       Applying it only to the target let a smoothed value that was already
       below the floor stay there. */
    const floor = Math.min(1, Math.max(CRAMP_BOOM, Math.min(MIN_BOOM, this._hitFree * len)) / len);
    const want = clamp(free, floor, 1);
    this.occl = clamp(
      want < this.occl ? want : approach(this.occl, want, RECOVER, dt),
      floor, 1,
    );
    this.camPos.copy(_head).addScaledVector(_boom, len * this.occl);
    this.boomHeadroom = (free - this.occl) * len;

    /* Shortening the boom only works while there is somewhere shorter to go.
       Where the road runs through a cut whose wall is closer to the driver's
       head than the boom's own minimum length, the floor above wins, the lens
       stays inside the rock, and the frame is a flat void — measured 1.49 m
       inside `landform-1` a hundred metres from the line, at a station a
       coarser sample had called clean.
       Sideways is the way out. The boom keeps its length and the lens slides
       along the blocking face's normal until it is clear, which costs a little
       framing and no legibility at all — where shortening to the floor costs
       the entire frame. Taken immediately, eased away like the lift, and zero
       on every frame the boom test alone was enough. */
    _off.set(0, 0, 0);
    const over = (this.occl - this._hitFree) * len;
    if (over > 0) {
      /* Depth is measured perpendicular to the face, not along the boom: a
         glancing wall is barely penetrated even when the overshoot is large,
         and pushing by the overshoot would shove the lens metres into the
         open for a few centimetres of fault. */
      const depth = over * Math.max(0.15, -_boom.dot(this._hitN));
      _off.copy(this._hitN).multiplyScalar(depth + SLIDE_SKIN);
    }
    if (_off.lengthSq() > this.slide.lengthSq()) this.slide.copy(_off);
    else this.slide.lerp(_off, 1 - Math.exp(-SLIDE_RECOVER * dt));
    this.camPos.add(this.slide);

    /* Cheap safety net under the boom test: a shallow bank rising into the
       camera from below is grazed rather than crossed, so no ray along the
       boom ever hits it, and the lens skims through the top few centimetres
       of grass. A short cast straight down catches that case for the price of
       one more query. Raised immediately, lowered on a spring, same reason. */
    const drop = this.world.raycast(this.camPos.x, this.camPos.y, this.camPos.z, 0, -1, 0, GROUND_CLEAR + 0.5, 0.4);
    const wantLift = drop < GROUND_CLEAR ? Math.min(1.6, GROUND_CLEAR - drop) : 0;
    this.lift = wantLift > this.lift ? wantLift : approach(this.lift, wantLift, 3.2, dt);
    this.camPos.y += this.lift;
  }

  update(car, dt, { lookBack = false } = {}) {
    const speed = car.speed;
    const fast = smoothstep(6, 52, speed);

    /* Frame the car that is on the screen, not the one in the simulation.
     *
     * They are not the same position. The simulation advances in whole 1/120
     * substeps and a frame is never a whole number of them, so `car.pos`
     * jumps unevenly against the wall clock while this spring is integrated
     * on the wall clock — and Car.applyTo therefore draws the car at
     * `renderPos`, which is `pos` carried forward to where the frame
     * actually is. A camera chasing `pos` chases the uneven one and puts the
     * difference straight back on the screen as the car shimmering against
     * the road: measured at 98 mm RMS of camera-space judder at 48 fps with
     * the mesh already smoothed, against 43 mm of ordinary driving.
     *
     * `renderPos` equals `pos` exactly whenever the caller's accumulator is
     * empty, which is every frame of every tool, so nothing the suite
     * measures — the knee, the dutch, the boom, the occlusion sweep — moves. */
    const at = car.renderPos || car.pos;

    /* Aim direction: velocity when there is meaningful speed, heading when
       parked — a stopped car has no velocity to follow and the camera would
       drift wherever the last nudge left it. */
    _dir.copy(car.forward).multiplyScalar(car.vx).addScaledVector(car.right, car.vy);
    if (_dir.lengthSq() < 4) _dir.copy(car.forward); else _dir.normalize();
    /* Blend a little of the body heading back in, so the camera still leans
       into a slide instead of ignoring it completely. */
    _dir.lerp(car.forward, 0.22).normalize();
    if (lookBack) _dir.negate();

    /* Rotational lag. The boom's yaw chases the car's rather than being
       welded to it, so on turn-in the car rotates first and the camera arrives
       a beat later — which is the whole difference between the world snapping
       around the car and the camera swinging through the corner behind it.
       Only the boom lags; `_look` below still uses the true travel direction,
       so the camera ends up slightly outside the corner looking into it, and
       the road ahead is if anything better exposed than before. */
    _boomDir.copy(_dir);
    if (this.yawLagEnabled) {
      const wantYaw = Math.atan2(_dir.x, _dir.z);
      if (!this.started) this.yaw = wantYaw;
      /* Every piece of angle arithmetic here is done on a *wrapped
         difference*, never on absolute angles, which is what keeps the ±180°
         seam from sending the camera the long way round. `this.yaw` is free to
         wander outside (-pi, pi]; it is re-anchored to wantYaw every frame. */
      const decayed = wrapPi(this.yaw - wantYaw) * Math.exp(-YAW_RATE * dt);
      /* Capped, and the cap fades out with speed. Uncapped, a spin or a
         hairpin leaves the camera aimed somewhere unrelated to the car; and a
         three-point turn in the pits wants no lag at all, only a fast corner
         does. Past the cap the camera stops falling behind and starts keeping
         up, which also means the 180° flip into look-back mode is a snap
         rather than a whip. */
      const cap = MAX_YAW_LAG * smoothstep(4, 20, speed);
      this.yawLag = clamp(decayed, -cap, cap);
      this.yaw = wantYaw + this.yawLag;
      _boomDir.applyAxisAngle(UP, this.yawLag);
    } else this.yawLag = 0;

    /* Airborne, the boom goes long. A car several metres up with the road
       running away underneath it is the one shot on the stage worth standing
       back from, and at the normal 8.4 m the flight fills the frame and reads
       as a bump. Eased in rather than switched, and eased out faster than it
       came, so a kerb hop that clips `airborne` for a tenth of a second does
       not move the camera at all.
       Sim time drives the ramp in — airTime is the car's own clock, so the
       pullback keeps pace with the flight in slow motion — and real time
       drives the return, because a camera that eases on the sim clock stops
       moving whenever the sim does.
       Long, and no longer high. The lift used to be +2.4 m on top of the
       boom, and measured against the thing it was for it was a subtraction on
       both axes: the lens climbed roughly twice as fast as the car did, and
       raising the lens shortens the on-screen gap between a car and the road
       under it because the depression angle works against the vertical
       offset. Pinned off, the same jumps returned 50-54 px of separation per
       metre of height against 41-47 shipped, and the car itself drew 12-21%
       larger. The FOV widen that went with it cost the rest: it shrinks
       everything in frame at exactly the moment the subject is furthest away.
       So the pullback is now purely the boom — and half the boom it was.
       Standing back was worth it when the apex was 1.3 m and the flight
       genuinely did fill the frame; against the 3.5-5.5 m the lip now
       produces it is the same subtraction the lift was, just smaller. Swept
       at matched jumps with tools/airlift.mjs, averaged over nine launches on
       three sites: +5 m of boom draws 138 px of separation on a 27 px car,
       +2.5 draws 160 px on a 36 px car, +1.5 draws 171 px on a 41 px car, and
       no extension at all draws 190 px on a 51 px car. The brief asks for a
       camera that pulls back, so it pulls back — the boom still goes 8.4 m to
       9.9, and the step is legible in the frames — but it stops just short of
       where standing further off costs more than it buys. */
    this.air = car.airborne
      ? Math.max(this.air, smoothstep(0.12, 0.35, car.airTime))
      : approach(this.air, 0, 2.2, dt);
    const back = lerp(6.1, 8.4, fast) + this.airBoom * this.air;
    const high = lerp(2.5, 3.1, fast) + this.airLift * this.air;

    _up.copy(car.up).lerp(UP, 0.45).normalize();
    _p.copy(at).addScaledVector(_boomDir, -back).addScaledVector(_up, high);

    /* Never let the camera drop through the road on a crest. */
    const surfaceGuard = at.clone().addScaledVector(car.up, 1.1);
    if (_p.dot(car.up) < surfaceGuard.dot(car.up)) {
      _p.addScaledVector(car.up, surfaceGuard.dot(car.up) - _p.dot(car.up));
    }

    _look.copy(at).addScaledVector(_dir, lerp(9, 17, fast)).addScaledVector(_up, 1.5);

    if (!this.started) {
      this.pos.copy(_p); this.look.copy(_look); this.started = true;
      this.occl = 1; this.lift = 0; this.slide.set(0, 0, 0);
    }

    /* Position is chased hard enough to stay tight, the look-at target softly
       enough that a kerb strike does not whip the horizon. */
    const posRate = lerp(7.5, 12, fast);
    this.pos.x = approach(this.pos.x, _p.x, posRate, dt);
    this.pos.y = approach(this.pos.y, _p.y, posRate * 0.8, dt);
    this.pos.z = approach(this.pos.z, _p.z, posRate, dt);
    this.look.lerp(_look, 1 - Math.exp(-9 * dt));
    this.up.lerp(_up, 1 - Math.exp(-5 * dt)).normalize();

    /* After the damping, not before it. Colliding the *target* leaves the
       damped position free to lag several metres behind and sit inside the
       wall anyway; colliding the position the lens will actually occupy is
       the only version that cannot penetrate. The look-at target is left
       alone deliberately — the aim should not swing when the boom shortens,
       or a pull-in reads as a camera cut instead of a step closer. */
    this.resolveOcclusion(car, dt);

    /* The first lobe is a directed recoil, then a small deterministic rattle
       dies under it. Wall hits kick laterally away from contact; a directionless
       landing drives the camera down. Advancing from dt instead of wall-clock
       time keeps harness captures reproducible. */
    this.shakeCooldown = Math.max(0, this.shakeCooldown - dt);
    this.shakeAge += dt;
    this.shakeTime += dt;
    this.shake *= Math.exp(-6.8 * dt);
    if (this.shake < 0.001) this.shake = 0;
    const sh = this.shake * this.shake;
    const recoil = Math.cos(this.shakeAge * 39) * Math.exp(-this.shakeAge * 10.5);
    const rattleX = Math.sin(this.shakeTime * 53.1) * 0.075;
    const rattleY = Math.sin(this.shakeTime * 41.7 + 1.3) * 0.065;
    const rattleZ = Math.sin(this.shakeTime * 31.9 + 2.1) * 0.035;
    _right.crossVectors(_dir, _up).normalize();
    _tmp.set(0, 0, 0)
      .addScaledVector(_right, sh * (rattleX + this.shakeSide * recoil * 0.30))
      .addScaledVector(_up, sh * (rattleY - (this.shakeSide ? 0 : recoil * 0.24)))
      .addScaledVector(_dir, sh * rattleZ);

    this.camera.position.copy(this.camPos).add(_tmp);
    this.camera.up.copy(this.up);
    this.camera.lookAt(this.look);
    /* A little roll into the corner, from how fast the car is rotating and how
       hard the body is leaning. Both terms are kept: they agree on 84% of the
       lap, and although the body roll is now the better-conditioned signal of
       the two it is also the less discriminating one, because it is smoothed
       and saturates at the limit of grip. Shifting weight onto it was tried
       and measured, and it made the corners read *more* alike, not less. */
    const hitRoll = sh * (this.shakeSide ? -this.shakeSide * recoil * 0.028 : rattleX * 0.12);
    const dutch = -car.r * 0.11 - car.roll * 0.35;
    this.camera.rotateZ(
      (this.softDutchEnabled ? softRoll(dutch) : clamp(dutch, -0.075, 0.075)) + hitRoll,
    );

    const lensFast = this.speedResponseEnabled ? fast : 0;
    /* No airborne term. A wider lens at the apex made the car smaller in the
       frame just as the boom had already taken it further away — the two
       compounded, and between them they were the whole reason a 1.3 m jump
       drew 28 px of daylight. See the `high` term above. */
    const wantFov = lerp(62, 79, lensFast) + clamp(car.throttle * lensFast * 2.5, 0, 2.5)
      + this.airFov * this.air;
    this.fov = approach(this.fov, wantFov, wantFov > this.fov ? 5.0 : 2.6, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}

const UP = new THREE.Vector3(0, 1, 0);
