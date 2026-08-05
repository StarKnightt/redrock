/* An AI driver, and the only honest way to tune the physics.
 *
 * Handling cannot be judged from a screenshot and cannot be judged from a
 * single burst of throttle in a straight line. It needs something that drives
 * the whole stage the same way every time, so a change to the tyre curve shows
 * up as a different stage time rather than as a different opinion.
 *
 * Three parts:
 *
 *   A racing line — an offset from the centre that leans out on entry, cuts
 *   the apex and drifts out on exit, derived from the curvature the stage
 *   already knows about rather than from an optimiser.
 *
 *   Pure pursuit steering onto that line, at a lookahead that grows with
 *   speed, plus an explicit countersteer term. Without the countersteer the
 *   bot cannot hold a slide: pure pursuit alone chases the line, notices the
 *   car is not on it, and adds more lock in the direction that is already
 *   spinning it.
 *
 *   Speed from the corner radius ahead, backed off far enough to brake for it.
 *   This is what makes the bot arrive at a hairpin at a plausible speed rather
 *   than understeering into the berm at full throttle.
 */
import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../core/util.js';
import { rng } from '../core/rng.js';
import { steerLockAt } from './physics.js';
import { CAR } from './mesh.js';

const WHEELBASE = CAR.wheelBase;

const _p = new THREE.Vector3();
const _to = new THREE.Vector3();

/* How much grip the bot believes it has, as a fraction of g. The car can do
   about 1.08 g on a perfect line; a bot that plans for all of it arrives at
   every corner with nothing in hand, runs wide on the first one, and puts
   itself in the berm. Planning for 0.86 leaves room for its own imprecision. */
const AIR_STEER = 0.25;      // how much of the wheel survives being airborne
const PAD_PLAN = 6.0;        // m/s the pad is worth, so the bot plans for it
/* Lowered from 0.86 when the friction circle stopped charging the tyres for
   gravity and the brake split started following the load. The bots trail-brake
   into every corner, so they were the biggest victims of both faults and the
   biggest beneficiaries of fixing them: across eight seeds their spins and
   recoveries went from 44 to 1 and their mean stage time fell 9.5 s, which is
   rival pace the race was not tuned for. Handing the planner a smaller share of
   the grip gives that time back and keeps what is worth keeping — the field now
   runs the pace it always ran without falling over to do it. */
const GRIP = 0.82;
const G = 9.81;

/* Turning the car around.
 *
 * Entry and exit are deliberately different numbers. With one threshold the
 * manoeuvre handed back the moment the nose crossed it — at 75° off the road,
 * with the car still going sideways — and pure pursuit finished the job,
 * badly: the arc through a lookahead point 30 m away and 90° off to the side
 * has a radius of 15 m, so the bot asks for under a third of the lock it has
 * and sweeps round in a slow lazy curve. Handing back inside 32° means the
 * turn is over before pure pursuit sees it.
 *
 * REC_SPEED is a manoeuvring pace, not a creep. Turning at walking speed is
 * most of what made the old recovery take twenty seconds; a full-lock arc at
 * 7 m/s is about 3.6 m of radius and comes round in a couple of seconds.
 *
 * REC_ROOM is the space the nose needs to sweep through before the car is in
 * the guardrail. A car with less than that ahead of it reverses instead,
 * which is what a driver would do and what the road width forces: the turning
 * circle is 7.3 m across and the road is under 10 m wide, so a car that has
 * spun into the outside wall — which is where nearly all of them end up —
 * cannot come round in one go.
 */
const REC_ENTER = 0.25;      // cos of heading error at which recovery takes over
const REC_EXIT = 0.85;       // and hands back
const REC_SPEED = 7.0;       // m/s the manoeuvre is driven at
const REC_ROOM = 8.0;        // metres of road the nose needs to swing through
const REC_DWELL = 0.6;       // s minimum in a leg, so a three-point turn is one

/* Cos of the heading error inside which the manoeuvre stops shuffling and
   drives out of the turn. Between REC_ENTER and REC_EXIT on purpose: it is
   not a hand-back, it is the last leg of the turn-around, and it exists
   because the car has to leave the manoeuvre pointing down the road AND
   travelling down it. See the comment on the leg selection below for what
   was happening without it. */
const REC_OUT = 0.50;

/* The brake stops being a brake below half a metre a second: physics.js
   selects reverse at a standstill and holds it until something asks for
   throttle, so a brake held against a car that is already rolling backwards
   slowly is reverse thrust, and carries it to REVERSE_MAX. Only a car being
   taken backwards faster than the reverse gear could ever drive it is
   genuinely running away, and only that case wants the pedal. Just above
   REVERSE_MAX, which is 7.0. */
const REC_RUNAWAY = 7.5;     // m/s of backwards travel that is a runaway, not a gear

/* Cross-track damping and containment, re-expressed so that neither term can
   ask for more wheel than the car has.
 *
 * `steerLockAt` is lerp(0.62, 0.16, smoothstep(4, 46, speed)): the road wheels
 * have 0.62 rad at walking pace and 0.16 rad above 46 m/s, and the driver's
 * command is `angle / steerLockAt(speed)` clamped to ±1. So a corrective term
 * bounded by a fixed number of radians means two completely different things at
 * the two ends of the stage. The two bounds this replaces were ±0.20 rad of
 * damping and 0.34 rad of containment, which at 46 m/s are 125% and 213% of the
 * entire wheel. Above that speed either term on its own saturated the command,
 * and a proportional controller whose output is permanently on its stop is not
 * a proportional controller, it is a relay.
 *
 * DAMP_GAIN is the old metres-per-second gain re-expressed at the speed it was
 * tuned at — 0.030 rad per m/s at 25 m/s is 0.75 rad per radian of cross-road
 * drift — so nothing changes at corner speed. */
const DAMP_GAIN = 0.75;
const DAMP_SHARE = 0.35;     // most of the wheel the damping term may ever ask for
const CONT_SHARE = 0.65;     // and the containment term, which outranks it
const CONT_LEAD = 0.45;      // s of cross-track lead the containment term reads

/* Lifting when the car is off the road.
 *
 * The steering already does everything it can out there — measured over a lap,
 * the containment term is saturated at its share of the lock on 4587 of the 4870
 * frames the car spends past the edge, holding 0.90-0.96 of command back toward
 * the road. It still took 313 m and 16.5 s to come back from one excursion,
 * because for 87% of those frames the car was AIRBORNE: it skips along the berm
 * rather than sliding on it, and a car in the air keeps a quarter of the wheel
 * and has no tyre to use it with. Every one of those touchdowns is also an
 * impact — that single excursion logged 21 of the lap's 56.
 *
 * The thing holding it out there is the throttle. `targetSpeed` reads corner
 * radius and nothing else, and the berm in question runs alongside a straight,
 * so the target sat at the 62 m/s ceiling — 223 km/h — while the car bounced
 * along at 73, and the pedal stayed pinned at 0.92 mean. Speed climbed back from
 * 67 to 99 km/h while off the road.
 *
 * So: cap the pace by how far past the edge the car actually is. This is not a
 * penalty, it is the lever that gives the steering something to work with —
 * below the speed at which the berm launches the car, the tyres are on the
 * ground and the containment term that was already asking for full correction
 * finally gets to apply it.
 *
 * A ramp and not a switch, and EXC_TOP sits high enough that the shallow end of
 * it is inert: clipping a verge on the exit of a fast corner is ordinary
 * rallying and must not be punished, and this car does not reach 198 km/h. The
 * term only starts asking for anything around 0.4 m out and only bites hard when
 * the car is properly gone.
 *
 * That is measured and not assumed. Swept over twelve settings on the fourteen
 * seeds tools/boot.mjs uses — 168 laps, `.fix/excsweep-wide14.txt` — every one of
 * the eleven capped settings beat the uncapped control on impacts (833) and on
 * off-road distance (20.9%), and total lap time across all fourteen moved by
 * under 1.6% in either direction. Which setting is best is much less clear than
 * that having one is: a single lap's impact count is chaotic in the setting, so
 * the ranking inside the eleven is worth little. These are the totals:
 *
 *      top 55, deep 14   646 impacts   15.0% off road   2586.0 s      ← this
 *      top 28, deep 14   702           15.2            2582.6
 *      top 40, deep 14   809           18.9            2628.4
 *      control           833           20.9            2586.6
 *
 * so the shallow end being nearly inert is, if anything, better than making it
 * bite early, which is the outcome the reasoning above would predict.
 */
const EXC_START = 0.15;      // m past the road edge before any lift
const EXC_FULL = 0.95;       // and where the cap is fully down
const EXC_TOP = 55;          // m/s cap at EXC_START — inert on a verge clip
const EXC_DEEP = 14;         // m/s cap once the car is properly out there

export class Driver {
  /**
   * @param {object} opts
   *  - skill 0..1: lifts cornering speed and tightens the line
   *  - lane: metres right of the racing line this driver prefers to sit
   */
  constructor(track, { skill = 0.8, lane = 0, seed = 1 } = {}) {
    this.track = track;
    this.skill = skill;
    this.lane = lane;
    this.seed = seed;
    this.steerSmooth = 0;
    this.throttleSmooth = 0;
    /* Phase of the wander, from the seed rather than from Math.random. The
       race re-seeds this itself, so the only driver that ever saw the random
       value was the solo bot the telemetry tools run — which is precisely the
       one whose stage time is supposed to be a regression gate, and was not,
       because the same build gave a different answer every run. */
    this.wobble = rng((seed * 2654435761) >>> 0)() * 10;
    this.stuckFor = 0;
    this.prevLat = 0;
    this.rec = null;            // live turn-around manoeuvre, or null
    // Cross-track containment and damping gains, exposed so they can be swept.
    this.contGain = 0.13;
    this.latGain = 0.030;
    // Off-road pace cap, exposed for the same reason: so it can be swept.
    this.excTop = EXC_TOP;
    this.excDeep = EXC_DEEP;
    this.excStart = EXC_START;
    this.excFull = EXC_FULL;
    this.boost = 1;             // rubber-band multiplier, driven from outside
    /* Steering telemetry, allocated once and overwritten in place. Four drivers
       at 60 Hz is 240 short-lived objects a second if this is a literal, which
       is garbage for a diagnostic nothing in the car reads. Consumers take the
       fields they want on the frame they read them. */
    this._dbg = {
      pursuit: 0, slipTerm: 0, yawTerm: 0, contTerm: 0, dampTerm: 0,
      angle: 0, lock: 0, steer: 0, excess: 0,
    };
  }

  /** Mean curvature over a window ahead, which is what a corner really is. */
  curvatureAhead(s, from, to) {
    let sum = 0, n = 0, peak = 0;
    for (let d = from; d < to; d += 6) {
      const f = this.track.frameAt(Math.min(s + d, this.track.roadEnd));
      sum += f.curv; n++;
      if (Math.abs(f.curv) > Math.abs(peak)) peak = f.curv;
    }
    return { mean: n ? sum / n : 0, peak };
  }

  /**
   * Where on the road this driver wants to be.
   *
   * Out on entry, in at the apex, out on exit — approximated by comparing the
   * curvature just behind with the curvature just ahead, which is cheap and
   * reads correctly through every corner shape the stage generator makes.
   */
  targetLat(s) {
    const f = this.track.frameAt(s);
    const hw = f.width * 0.5;
    const usable = hw - 2.6;
    const ahead = this.curvatureAhead(s, 10, 70).mean;
    const here = f.curv;
    const behind = this.track.frameAt(Math.max(0, s - 45)).curv;

    // Sit toward the outside before the corner, hug the inside through it.
    const entry = clamp((Math.abs(ahead) - Math.abs(here)) * 260, 0, 1);
    const exit = clamp((Math.abs(behind) - Math.abs(here)) * 260, 0, 1);
    const apex = clamp(Math.abs(here) * 190, 0, 1);
    const hand = Math.sign(here || ahead || 1);

    let lat = -hand * apex * usable * (0.55 + 0.35 * this.skill);
    lat += hand * Math.max(entry, exit) * usable * 0.5;
    return clamp(lat + this.lane, -usable, usable);
  }

  /** Speed this driver is willing to carry, in m/s. */
  targetSpeed(s) {
    const near = this.curvatureAhead(s, 4, 46);
    const mid = this.curvatureAhead(s, 40, 120);
    const far = this.curvatureAhead(s, 110, 240);

    const limitFor = (curv) => {
      const R = 1 / Math.max(Math.abs(curv), 1e-4);
      return Math.sqrt(GRIP * G * Math.min(R, 900));
    };
    // Speed allowed here, and speed we must be down to by the time we arrive.
    let v = limitFor(near.peak);
    /* The pad is going to add about this much whether the driver plans for it
       or not; the only question is whether it spends the window fighting it.
       A driver that does not plan for the pad is over its own target the
       moment it crosses one, and brakes — so every rival loses time at every
       ramp while the player gains, and the pads become a silent handicap
       dressed up as a feature.
       Additive and in m/s, unlike `this.boost`, which is the rubber band's
       multiplier: different units, so the two cannot stack.
       It goes in *before* the lookahead, and that placement is the whole
       care in this. Added afterwards it also lifts the plan through the
       braking zone for whatever corner follows the runout, and the bot
       arrives at it six metres a second over the limit and spins — which is
       measurable, and looks exactly like the ramp's fault.
       Measured, it is currently inert: a ramp is only sited where the
       approach is near-straight, and on a straight the corner-limit plan is
       already against the 62 m/s ceiling below, so the six is clipped off.
       It is kept because it costs nothing and the day a ramp is sited
       somewhere slower is the day the pad silently becomes a handicap. */
    if (this.track.boostWindow(s)) v += PAD_PLAN;
    for (const [c, dist] of [[mid.peak, 70], [far.peak, 170]]) {
      const vAt = limitFor(c);
      /* v² = vAt² + 2·a·d. The car can brake at about 8.6 m/s² in a straight
         line; planning for that means arriving at the corner having spent all
         of it, with nothing left to turn with. 5.8 buys the margin. */
      v = Math.min(v, Math.sqrt(vAt * vAt + 2 * 5.8 * dist));
    }
    const f = this.track.frameAt(s);
    // Downhill wants a lower entry speed; the grade is doing some of the work.
    v *= lerp(0.93, 1.02, smoothstep(-0.16, -0.03, f.grade));
    v *= lerp(0.80, 1.06, this.skill) * this.boost;
    return clamp(v, 7, 62);
  }

  /**
   * A turn-around is under way and getting somewhere, so the race's strand
   * rescue should hold off. Early frames count regardless: the first second
   * or so is spent braking off the speed the spin left behind, during which
   * nothing rotates and there is nothing to show for it yet. Air does not
   * count at all — a car with no wheels on the ground has no throttle, no
   * brakes and no steering, and waiting longer buys it nothing.
   */
  get recovering() {
    const r = this.rec;
    return !!r && r.air < 0.6 && (r.t < 2.5 || r.stale < 1.5);
  }

  /**
   * Turn the car around, or return null if it is pointing down the road.
   *
   * This owns the whole control output while it runs. That is the point of it:
   * the version this replaces computed a full-lock command and then let the
   * ordinary steering filter keep running underneath, so both filters chased
   * their own targets on the same variable every frame and the wheel settled
   * at a weighted average of the two. At 12/s against 8/s the average is 57%
   * of the racing command and 43% of the turn-around command, and the racing
   * command during a spin is nearly all countersteer — which points the wrong
   * way by construction, because countersteer is for catching a slide, not for
   * completing one. Measured across 194 spins: full lock was asked for on 80%
   * of frames and delivered on 4%, with the wheel averaging 16° out of the 35°
   * available. The car was not slow to turn around. It was barely steering.
   */
  _recover(car, f, dt) {
    const facing = car.forward.dot(f.tan);
    const cross = car.right.dot(f.tan);
    const hw = f.width * 0.5;

    if (!this.rec) {
      if (facing > REC_ENTER) return null;
      /* Heading is the only entry test, and adding one on which way the car
         is travelling makes it worse: a spun car is normally still being
         carried down the road at 10 m/s or more, and waiting for that to bleed
         off doubled the teleports, because the seconds spent waiting are the
         seconds the manoeuvre needed.

         Commit to a way round, and hold it. Near 180° the shorter way is a
         coin toss decided by numerical noise, and a controller that re-reads
         it every frame dithers on the spot — which is what the old one did,
         for tens of seconds at a time. A car already at the road edge turns
         toward the middle instead, because the short way puts its nose in the
         rock — but only once the two are comparable. Letting the road width
         overrule a decisively short way was measured and was worse: a car 76°
         off at the edge got sent 284° round, against the yaw it already had. */
      const err = Math.atan2(cross, facing);
      const dir = Math.abs(err) > Math.PI / 2 && Math.abs(car.lat) > hw - 1.2
        ? -Math.sign(car.lat || 1) : Math.sign(err || 1);
      this.rec = { dir, gear: 1, dwell: REC_DWELL, best: 7, stale: 0, air: 0, t: 0 };
    } else if (facing > REC_EXIT) {
      this.rec = null;
      return null;
    }
    const r = this.rec;
    r.dwell += dt;

    /* Is the manoeuvre going anywhere? The race teleports a stranded car back
       onto the road, and it used to do that straight through the middle of a
       turn-around: the strand timer runs while the nose is more than 81° off
       the road, which a genuine spin recovery is beyond for longer than the
       2.5 s the timer allows. Half of every recovery ended in a rescue that
       the car did not need. So the driver publishes whether it is getting
       anywhere, and the race waits while it is.
       Two things count as getting somewhere, and it needs both because
       neither alone survives the start of a spin: rotation still owed the way
       round we committed, which is the real measure but which GROWS while the
       car is still spinning out under the controller's feet, and simply
       turning the committed way right now, which is what the manoeuvre looks
       like from the outside. Requiring the first alone marked every recovery
       stalled from the frame it started. */
    const togo = ((r.dir * Math.atan2(cross, facing)) + 2 * Math.PI) % (2 * Math.PI);
    if (togo < r.best - 0.05) { r.best = togo; r.stale = 0; }
    else if (r.dir * car.r > 0.12) r.stale = 0;
    else r.stale += dt;
    r.air = car.airborne ? r.air + dt : 0;
    r.t += dt;

    /* How far the nose can travel before it is in the guardrail, forward and
       backward. This is the whole of the AI's spatial awareness during a
       turn-around and it is enough, because the only decision it informs is
       which way to shuffle. */
    const lim = hw + 1.05;
    const fl = car.forward.dot(f.right);
    const gap = (d) => {
      const rate = fl * d;
      if (Math.abs(rate) < 0.02) return 99;
      return Math.max(0, ((rate > 0 ? lim : -lim) - car.lat) / rate);
    };
    /* Swap legs only when the other way is genuinely better, and never twice
       in quick succession — a shuffle at the frame rate is not a three-point
       turn, it is a car having a fit. */
    if (r.dwell > REC_DWELL && gap(r.gear) < REC_ROOM
      && gap(-r.gear) > gap(r.gear) + 2) {
      r.gear = -r.gear; r.dwell = 0;
    }

    /* And come out of it forwards.
     *
     * `gap` is derived from the nose's lateral component, so it only answers
     * the question it is being asked while the nose is still across the road.
     * Once the car has turned far enough for that component to vanish, both
     * directions read as 99 m clear, the swap above can never fire again, and
     * the manoeuvre finishes in whichever leg it committed to while it was
     * still sideways. Measured over 8 seeds that is the reverse leg for 88%
     * of every turn-around, and the reverse leg holds the brake down — which
     * below half a metre a second is the reverse gear. So the car came round,
     * kept reversing, and handed back to the racing controller pointing down
     * the road while travelling up it at up to 7 m/s, leaving the racing
     * controller to undo the reverse before it could start rebuilding pace.
     * That was most of the distance between facing the right way and being
     * back on the line: 3.2 s against 7.2 s on tools/recbench.mjs.
     *
     * Deliberately not folded into REC_EXIT. Handing back is a claim that the
     * racing controller can cope; driving out is what makes the claim true,
     * and it has to happen first. */
    if (facing > REC_OUT && gap(1) > REC_ROOM) r.gear = 1;

    /* Lock that rotates the car the way we chose. Which sign that is depends
       on which way the car is TRAVELLING, not on which way it is pointing:
       front wheels turned right steer the nose right going forwards and left
       going backwards. The old code ignored this, and a spun car spends about
       half its time rolling backwards down the grade, so for half of every
       recovery it was steering itself the wrong way round. */
    const travel = Math.abs(car.vx) > 0.6 ? Math.sign(car.vx) : r.gear;
    /* Past 90° the committed direction rules. Inside it, close the error the
       short way, which also means an overshoot is caught rather than carried
       all the way round again. */
    const err = Math.atan2(cross, facing);
    const turn = facing > 0 ? Math.sign(err || r.dir) : r.dir;
    const ease = facing > 0 ? clamp(Math.abs(err) / 0.9, 0.35, 1) : 1;
    const cmd = clamp(turn * travel * ease, -1, 1);

    /* Pace. A car sliding backwards down an 18% descent at 70 km/h cannot
       turn around and cannot be argued with; it has to be stopped first, and
       nothing in the old controller ever stopped it — it held 55% throttle
       against the hill and rode it out, for up to 650 m of road. */
    let throttle = 0, brake = 0;
    if (r.gear > 0) {
      /* Throttle is what arrests a slow backwards roll, not the brake. The
         brake is the reverse gear by then and holding it feeds the roll
         instead of killing it; throttle both clears the latch and drives the
         car the way the leg wants to go. The pedal is kept only for the case
         it was written for — a car being carried backwards down the grade
         faster than the reverse gear could ever take it, which is a runaway
         and not a gear. */
      if (car.vx < -REC_RUNAWAY) brake = 0.9;
      else throttle = clamp((REC_SPEED - car.vx) * 0.5, 0, 0.85);
    } else {
      // The brake pedal is the reverse gear once the car has stopped.
      brake = 0.85;
    }

    /* Quicker than the racing filter. A driver who has spun does not ease the
       wheel round, and this is the one place the bot is allowed to look
       hurried — it is still going to lose the time, in the manoeuvre rather
       than in the flailing. */
    this.steerSmooth += (cmd - this.steerSmooth) * Math.min(1, dt * 18);
    return {
      steer: this.steerSmooth,
      throttle, brake, handbrake: 0,
    };
  }

  drive(car, dt) {
    const track = this.track;
    const s = car.s;
    const speed = car.speed;

    /* Cross-track rate, kept up to date even while the turn-around below has
       the controls: a recovery that skipped it handed back a metres-per-second
       figure measured across the whole manoeuvre, and the damping term spiked
       on the first frame of racing. */
    const latRate = (car.lat - this.prevLat) / Math.max(dt, 1e-4);
    this.prevLat = car.lat;
    // A little wander, so four AI cars are not one car drawn four times.
    this.wobble += dt * 0.7;

    /* ---- pointing the wrong way ---------------------------------------- */
    const rec = this._recover(car, track.frameAt(s), dt);
    if (rec) { this.stuckFor = 0; return rec; }

    /* ---- steering ------------------------------------------------------ */
    const look = clamp(7 + speed * 0.62, 9, 42);
    /* `roadEnd`: past the flag there are 154 m of road to steer along,
       and this Driver is the thing steering a finished car down it — see
       Game.endingInput. Clamped at `length` the aim point froze at the last
       frame of the RACE while the car was still travelling, which straightens
       the steering out on a run-off that is still gently turning. */
    const aheadS = Math.min(s + look, track.roadEnd - 2);
    const f = track.frameAt(aheadS);
    _p.copy(f.pos).addScaledVector(f.right, this.targetLat(aheadS));

    _to.subVectors(_p, car.pos);
    const fwd = _to.dot(car.forward);
    const side = _to.dot(car.right);
    /* Pure pursuit: the road-wheel angle that puts the car on an arc through
       the target point. Everything in this block is a real angle in radians,
       and only the last line converts to the normalised command the car
       takes — mixing the two is how the bot ended up steering at four percent
       of what it asked for. */
    const L2 = Math.max(fwd * fwd + side * side, 4);
    const pursuit = Math.atan2(2 * side * WHEELBASE, L2);
    let angle = pursuit;

    /* Countersteer, from the car's own slip angle, with a gain that only
       comes in once the slide is real — below a few degrees it would make the
       bot weave down every straight. */
    const slip = car.slipAngle;
    const slideness = smoothstep(0.06, 0.30, Math.abs(slip));
    angle -= slip * lerp(0, 0.85, slideness);
    angle -= car.r * 0.055;

    /* The wheel the car actually has at this speed. Every corrective term below
       is bounded by a share of it rather than by a fixed angle — see the note on
       DAMP_GAIN. It falls by a factor of four between a hairpin and a straight. */
    const lock = steerLockAt(speed);

    /* Edge containment. Pure pursuit corrects a cross-track error over the
       lookahead distance, which at 40 m and 120 km/h is a second and a half —
       long enough to be in the berm before the correction arrives. This is the
       term that actually keeps the bot on the road: it grows with how far past
       the usable width the car already is, and it does not care about the
       racing line at all. */
    const hwNow = track.frameAt(s).width * 0.5;
    /* Where the car will be, not where it is. There is about a quarter of a
       second of pure lag between asking for lock and the car changing direction
       — the command filter below, then the road wheels — and then the tyres have
       to build the force. Containment that reads the present is therefore late
       by construction: it fired at the edge, saturated, and threw the car at the
       opposite edge, which is the other half of the limit cycle the damping
       clamp above was driving. Reading a lead time ahead turns the same gain
       from lag into phase lead, so it starts easing the car off the edge while
       there is still room to do it gently rather than at full lock. */
    const latAhead = car.lat + latRate * CONT_LEAD;
    const excess = Math.abs(latAhead) - (hwNow - 2.2);
    /* Capped at the old 0.34 as well, so nothing changes at the corner speeds
       where this gain was originally tuned; the share only binds at pace. */
    const contTerm = excess > 0
      ? -Math.sign(latAhead) * clamp(excess * this.contGain, 0,
        Math.min(0.34, CONT_SHARE * lock))
      : 0;
    angle += contTerm;

    /* Damping on how fast the car is crossing the road, as an ANGLE.
     *
     * Metres per second across the road is not a steering error. Four metres a
     * second at 70 km/h is the car crossing the road at 12°, which wants most of
     * a corrective wheel; the same four metres a second at 170 km/h is 5°, which
     * wants a twelfth of one. Through a constant gain the term asked for the same
     * wheel in both cases — so it was right where it was tuned, at corner speed,
     * and roughly three times too strong on a straight, where it then met the
     * ±0.20 clamp that is 125% of the lock available. That is a relay with 80 ms
     * of filter lag behind it, and it is how the car left the road at the places
     * it lost the most time: not by arriving at a corner too fast, but by weaving
     * into a berm on the approach at 170 km/h. */
    const drift = Math.atan2(latRate, Math.max(speed, 8));
    const dampTerm = -clamp(drift * DAMP_GAIN, -DAMP_SHARE * lock, DAMP_SHARE * lock);
    angle += dampTerm;

    angle += Math.sin(this.wobble * 1.7) * 0.008 * (1 - this.skill);

    const steer = clamp(angle / lock, -1, 1);
    this.steerSmooth += (steer - this.steerSmooth) * Math.min(1, dt * 12);

    /* Telemetry only, written never read by the car. The command is a sum of
       four terms that routinely disagree, and from outside the class only the
       total is visible — which is how a car asking for full lock back toward the
       road looked identical to a car happily tracking a line along the wall.
       Read by tools/rlline.mjs and tools/rlgrind.mjs. */
    const dbg = this._dbg;
    dbg.pursuit = pursuit;
    dbg.slipTerm = -slip * lerp(0, 0.85, slideness);
    dbg.yawTerm = -car.r * 0.055;
    dbg.contTerm = contTerm;
    dbg.dampTerm = dampTerm;
    dbg.angle = angle;
    dbg.lock = lock;
    dbg.steer = steer;
    dbg.excess = excess;

    /* ---- pace ---------------------------------------------------------- */
    let want = this.targetSpeed(s);
    /* Two wheels in the dirt: lift. See the note on EXC_START. `excess` is the
       same quantity read a lead time ahead, which is right for steering and
       wrong here — the pedal should answer where the car IS. */
    const outBy = Math.abs(car.lat) - hwNow;
    if (outBy > this.excStart) {
      want = Math.min(want, lerp(this.excTop, this.excDeep,
        clamp((outBy - this.excStart) / Math.max(this.excFull - this.excStart, 1e-3), 0, 1)));
    }
    const err = want - speed;
    let throttle = clamp(err * 0.42, 0, 1);
    let brake = clamp(-err * 0.30, 0, 1);
    // Do not brake and steer hard at the same time; it just skates the front.
    brake *= lerp(1, 0.45, clamp(Math.abs(this.steerSmooth) * 1.4, 0, 1));
    // Ease off when already sideways, or the slide only gets worse.
    throttle *= lerp(1, 0.55, slideness);

    /* Handbrake for anything genuinely tight, at the moment of turn-in. This
       is what makes an AI car look like it is rallying rather than commuting. */
    const tight = this.curvatureAhead(s, 6, 34).peak;
    let handbrake = (Math.abs(tight) > 0.022 && speed > 16 && Math.abs(slip) < 0.25) ? 1 : 0;

    /* ---- unstick ------------------------------------------------------- */
    if (speed < 2.2) this.stuckFor += dt; else this.stuckFor = 0;
    if (this.stuckFor > 1.6) { throttle = 1; brake = 0; }

    /* ---- wedge escape ---------------------------------------------------
     *
     * A car that runs wide in a corner-entry slide arrives at the containment
     * wall travelling 30-40° sideways, and a car in that state is in a trap
     * the pace controller above cannot see: the engine cannot beat the wall.
     * The nose points partly INTO the wall, so the drive keeps feeding the
     * wall scrub; the tyres are past their slip peak, so the throttle's
     * slideness ease (rightly) holds the pedal at 0.55; and the crab bleeds
     * to a standstill over 5-6 seconds, sits out the 1.6 s stuck timer, and
     * only then powers away. Measured across the 14 boot seeds that was 21
     * wall-pinned near-stops of up to 9.4 s, bottoming at 0.1 m/s — which is
     * a rival visibly parked against a rock, and is the complaint.
     *
     * A driver in a gravel trap does not hold half throttle and wait. Two
     * legs, both only past the road edge with the car on the ground:
     *
     *   Crabbing and still carrying speed → brake. Killing the crab takes
     *   ~1.5 s against the 5-6 s the treadmill takes to do the same thing,
     *   and grip comes back the moment the slip angle does.
     *
     *   Near-stopped → full throttle immediately, not after the stuck
     *   timer's dwell. The steering is left alone: pure pursuit plus the
     *   containment term already point the car off the wall, and forcing
     *   full lock instead was measured worse (+72 impacts over 14 seeds).
     *
     * Swept over the 14 boot seeds against this build: sustained (≥6 s) slow
     * episodes 23 → 3, wall-pinned slow time 153 s → 65 s, strand teleports
     * 6 → 1, worst rival finish deficit 25.2 s → 18.5 s, impacts 776 → 784
     * (inside the noise). The off-road pace cap above is untouched and still
     * earns its keep — with it disabled the same sweep reads 812 impacts on
     * 39 rivals — this only removes the dying-against-the-wall tail. */
    if (!car.airborne && outBy > 0.5) {
      if (speed > 3 && speed < 10 && Math.abs(slip) > 0.35) {
        throttle = 0; brake = 1; handbrake = 0;
      } else if (speed <= 3) {
        throttle = 1; brake = 0; handbrake = 0;
      }
    }

    return {
      /* In the air the wheel does almost nothing useful and quite a lot of
         harm. The steering still feeds yaw rate while airborne, and a bot
         holding a quarter of a lock through a second of ramp flight lands
         rotated; nothing it is steering for — the line, the apex, the car
         ahead — can be acted on until the tyres are back down anyway. So it
         keeps a quarter of the input, enough to stay pointed, and collects
         the rest on landing. */
      steer: this.steerSmooth * (car.airborne ? AIR_STEER : 1),
      throttle: clamp(throttle, 0, 1),
      brake: clamp(brake, 0, 1),
      handbrake,
    };
  }
}
