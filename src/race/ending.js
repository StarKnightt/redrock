/* The finish: stop, hold, classify, race again.
 *
 * One state machine and nothing else, on the same terms as race/countdown.js.
 * It owns no meshes, no audio nodes and no canvas — it counts, and it reports
 * what the caller needs:
 *
 *   running      the sequence is on
 *   camera       0..1, how far from the chase pose to the held pose
 *   lensPush     degrees to take off the field of view, for the slow push in
 *   display()    what the HUD should draw, or null
 *   takeTone()   a one-shot audio event, consumed once
 *   canRestart   R is live
 *
 * TWO CLOCKS, AND NEITHER OF THEM IS AMBIGUOUS.
 *
 * The presentation — the camera glide, the card, the prompt — runs on
 * WALL-CLOCK seconds and every constant says so, for the reason countdown.js
 * documents: `Game.step(dt)` is handed wall time and multiplies by
 * `timeScale()` to get simulation time, and a sequence authored in one and
 * consumed in the other is how a 0.72 s window became 1.37 s of somebody's
 * life.
 *
 * The stop is almost entirely off the clock. It is authored in METRES — where
 * the car should come to rest, how far past the line the brakes come in — and
 * read back from where the car actually is, which is the cheapest available
 * answer to the bug class that has cost this project six rounds: a distance
 * cannot be in the wrong time unit, so there is no partner to pin.
 *
 * The two exceptions are both in StopServo and both say their unit out loud:
 * the observer's time constant and the deadline that stops a car whose `s`
 * has stopped advancing are in SIMULATION seconds, because one is smoothing
 * an acceleration and the other is bounding one. Neither has a partner in
 * metres.
 *
 * What the stop does NOT do is guarantee where the car ends up. It aims at a
 * mark and it is honest about missing: measured across eight seeds the car
 * comes to rest anywhere from 4 m to 33.5 m past the line, because arrival
 * speed spans 91 to 164 km/h against 34 m of road and because a seed where
 * the car reaches the line already in the scenery is stopped by the scenery.
 * That is why the held camera in main.js hangs off the car rather than off a
 * station — the composition is a relationship, not a pair of coordinates.
 *
 * Nothing here reads `performance.now()`. The clock is advanced by the caller,
 * so a paused frame is genuinely still and two renders of it are the same
 * image.
 */
import { clamp, smoothstep } from '../core/util.js';

/* How long the lens takes to stop following.
 *
 * The move is not a cut and it is not a crane: the chase camera simply stops
 * travelling, at the line, and lets the car run away from it under the arch.
 * A cut on the crossing frame throws away the best frame in the game — the
 * photo finish under the bunting — and a cut after it lands on a shot the
 * player has had no way to anticipate. Decelerating the lens keeps the whole
 * ending in one take, which is what the crossing deserves.
 *
 * Sized against the car rather than chosen: at the fastest measured arrival
 * (121 km/h, tools/finstop.mjs) the car reaches the arch 0.72 s after the
 * line, so the glide has to be most of the way home by then or the arch
 * passes through a lens that is still moving. */
const CAMERA_WALL = 1.15;

/* Then the classification. Late enough that the card is not competing with
   the car going under the bunting, early enough that it is up while the car
   is still rolling — the two overlapping is what makes it one moment instead
   of two. */
const CARD_WAIT_WALL = 1.45;
const CARD_IN_WALL = 0.42;
/* The pop, on the countdown's argument: a plate that appears is a slide, one
   that lands is an event. Smaller than the countdown's 1.20 because this
   plate is three times the area and the same proportional overshoot on it
   sweeps across most of the frame. */
const CARD_POP = 1.09;

/* And the prompt, after the result has been read. A restart offered in the
   same breath as the classification is a restart pressed before anyone has
   seen where they came. */
const PROMPT_WAIT_WALL = 1.35;
const PROMPT_IN_WALL = 0.5;

/* Below this speed the player's car counts as arrived, m/s, and the prompt stops
 * waiting for it. See `_held` in update() for what the waiting is and why the
 * CARD does not do it.
 *
 * Not a new threshold: it is CREEP_MS, the speed at which stopControl hands the
 * foot brake over to the handbrake. Above it the car is stopping; below it the
 * car is parking, and the difference between 9 km/h and nought is a detail of
 * the camber rather than of the stop. Reusing the boundary the stop already has
 * means there is no second opinion about when a car has arrived. */
const PROMPT_SETTLED_MS = 2.5;

/* How far the rest of the HUD gets out of the way. Not all the way out: the
   timer plate is showing the final time and the badge the final position, and
   both are the answer to the question the card is also answering, so they
   should still be legible behind it rather than deleted. */
const DIM_MAX = 0.72;

/* The lens push. Four degrees over five seconds is under a pixel a frame at
   900 — invisible as a move, and the difference between a held shot and a
   screenshot. Nothing but the field of view moves, so it cannot put the lens
   anywhere the blend did not already prove clear. */
const PUSH_DEG = 4;
const PUSH_WALL = 5.0;

/* ---- the stop, in metres ------------------------------------------------ */

/* Where the car comes to rest, as metres past the line.
 *
 * THIS IS THE NUMBER THAT WAS DOING THE FAKING, and not SCRUB_MAX below.
 *
 * It used to be 28, because the road used to end 34 m past the line: 28 put the
 * car six metres beyond the arch with six metres of pavement left under it, and
 * there was nowhere else to put it. Everything else in this section followed
 * from that. A car arriving at 190 km/h and asked to stop in 28 m needs
 * 52.8²/(2×28) = 50 m/s², the brakes are worth 10.3, and the difference is what
 * the scrub was for. The scripted retardation was never a statement about the
 * car; it was a statement about the length of the road.
 *
 * There are now 154 m past the line (world/track.js appends 120 to the 34), so
 * the number can be chosen on the physics instead. tools/zystop.mjs measures,
 * on the fastest arrival of the fourteen seeds:
 *
 *   arrival at the flag, seed 16      190 km/h = 52.8 m/s
 *   full pedal, Driver steering       stops in 115.5 m, peak slip 1°
 *   implied mean retardation          52.8²/(2×115.5) = 12.1 m/s²
 *   of which the brakes are           10.3
 *   so drag, engine braking and grade  1.7
 *
 * 120 m leaves 34 m of road under and ahead of the parked car — the same margin
 * the old 28 left, which is not a coincidence: it is the old geometry translated
 * 120 m down the new road. At 120 m the fastest arrival needs 11.6 m/s², which
 * is more than the brakes alone at the pedal this file is willing to use, so a
 * small trim remains; see SCRUB_MAX. Every other seed arrives at 98–137 km/h and
 * needs 3.1–6.0 m/s², which the brakes cover with the pedal part-applied.
 *
 * What this costs is the composition, and it is a real cost rather than a
 * rounding one: the arch is at 22 m past the line, so the car now rests 98 m
 * beyond it instead of 6 m short of it, and the held camera's clamp — which
 * exists to keep the arch between the lens and the car — cannot be satisfied at
 * that separation. That is written up in the report rather than papered over
 * here, because the alternative is choosing the shot over the physics, which is
 * how this file came to have 3.8 g in it.
 *
 * ---- and then it stopped being a constant at all ---------------------------
 *
 * A fixed 120 was measured and rejected. The distance law asks for v²/2d, so a
 * fixed d asks a slow arrival for very little: seed 23 arrives at 90 km/h and
 * 25²/(2×120) is 2.6 m/s², a quarter of a g, which takes 9.6 s to cover the
 * 120 m. What tools/zystop.mjs actually measured was worse than slow — the
 * 3.4 s deadline below arrived first and stopped the car wherever it had got to,
 * which was 7 to 19 m past the line with the trim saturated and 26–87° of slip.
 * Every seed became a deadline stop, which is the crudest mechanism in the file
 * doing all of the work.
 *
 * The mistake is asking a car to stop at a place. What a driver does past a flag
 * is brake FIRMLY, and where they end up is wherever that puts them. So the
 * station is derived from the arrival speed at a fixed, honest retardation, and
 * clamped to the road that exists. See stopStation, below BRAKE_PEDAL_MAX —
 * which it is derived from, so it has to be declared after it. */

/* Never nearer than this, whatever the arrival speed. The arch is at 22 m past
   the line, and a car that stops under it has stopped ON the finish rather than
   past it — and the rivals park behind the player at PARK_GAP intervals, which
   needs somewhere to put three of them.
   THIS CONSTANT OWNS THE NEAR LIMIT and every other file defers to it; see
   stopFloor below for the one that has to, and why it could not before. */
const STOP_MIN_M = 26;
/* And always this much authored road left beyond the parked car. The held camera
   sits 26 m back from the car, so the tail is not for the lens; it is so that the
   car's own nose, its shadow and the rivals still arriving behind it are all on
   pavement rather than on the last row of the mesh. */
const STOP_TAIL_M = 20;
/* The brakes come in over the first few metres rather than on one frame. A
   step to full pedal at 120 km/h is a stab; four metres is about a tenth of a
   second at that speed, which reads as a driver's foot rather than a switch.
   In metres, like everything else in this section. */
const LIFT_M = 4;

/* What the car's brakes are actually worth, m/s².
 *
 * 12200 N against 1180 kg, which is 10.3 — and it is a measured fact rather
 * than a tuning knob, so it is written as the quotient it is. It matters
 * because it is the whole reason the block below exists.
 *
 * The first version of this file did not have that block. tools/finstop.mjs
 * reported that full pedal stopped the car in 29.4 m from the fastest
 * arrival, comfortably inside the 34 m of road, so braking alone was declared
 * sufficient and nothing else was built. That measurement was wrong: the tool
 * broke its stop test on `vx`, which a car sliding sideways under a locked
 * wheel crosses long before it has stopped, and it measured ground distance
 * over an excursion that was still travelling at 40 km/h. The trace in
 * tools/finish.mjs caught it — full pedal took the car 122 km/h to 16 over
 * three seconds and 34 metres, straight off the end of the world, at
 * precisely the 1.0 g the numerator and denominator above predict.
 *
 * From 33.9 m/s at 1.0 g the car needs 58.6 m. There were 34. The brakes could
 * not do it and no arrangement of them could.
 *
 * ROUND 2, and both halves of that paragraph have since been overtaken.
 *
 * The 58.6 m is right for 33.9 m/s and was then quoted against the fastest
 * arrival, which it is not: 33.9 m/s is 122 km/h. tools/zystop.mjs measures the
 * fastest arrival across fourteen seeds at 190 km/h — faster than the 164 the
 * brief for this work carried, and 52.8 m/s needs 135 m at 1.0 g, not 58.6.
 * Sizing anything to 58.6 m would have left the fast seeds needing a servo.
 *
 * And there are now 154 m rather than 34, so the brakes CAN do it: measured,
 * full pedal takes the 190 km/h arrival to rest in 115.5 m with 1° of peak slip.
 * What is left below is not a substitute for the brakes; it is a trim on the one
 * seed whose arrival exceeds what the brakes are allowed to be asked for at a
 * pedal that keeps the car pointing down the road. */
const BRAKE_G = 12200 / 1180;

/* So the ending supplies the rest, and does it as what it is: a scripted stop
 * on a car whose race is over.
 *
 * The alternatives were all worse. Slow motion changes how long the player
 * watches the car travel and not one metre of how far it travels, so it
 * cannot help — the distance is a distance. Freezing the simulation the way
 * the countdown does is the hard stop the brief is right to warn against, and
 * on a car still doing 60 km/h it is a car turning to stone. Moving the line
 * is not this pass's to move and would rewrite every time the game has ever
 * recorded.
 *
 * What it costs is honesty about the number, and the number is set by the
 * road rather than by taste. Arrival speed was measured across eight seeds
 * and it is bimodal: the seeds whose last kilometre is technical arrive at
 * 91–122 km/h, and the four with a fast final straight arrive at 155–164.
 * Stopping 45.6 m/s in the 28 m below takes 37 m/s², which is 3.8 g.
 *
 * That is a large number and it is not negotiable at this cap. There are 34
 * metres of authored road past the line; the car cannot be stopped in them
 * from 164 km/h at any gentler rate, and no arrangement of this file changes
 * that. The first cap here was 20 m/s², chosen against a 122 km/h arrival
 * that turned out not to be the fastest one, and the four fast seeds all ran
 * out of road and stopped 0.2 m past the last frame of it — the exact defect
 * this whole sequence exists to remove, reintroduced by a constant tuned
 * against too few seeds.
 *
 * What makes it survivable is that it is brief and it is masked. The stop
 * takes 1.23 s from 164 km/h, and the held camera finishes its move at 1.2 s
 * — so the hardest part of the retardation happens while the shot is still
 * travelling, and the car arrives at rest as the composition lands. The
 * slower arrivals, which are most of them, never come near this cap: 122
 * km/h asks for 20 and 91 km/h asks for 11.
 *
 * The real fix is more road past the finish line. That is the track author's
 * to make and not this pass's, and it is written up in the report.
 *
 * ---- ROUND 2: the road arrived, and this is what is left ------------------
 *
 * `world/track.js` now appends 154 m of road past the flag, and the station moved
 * from a constant to stopStation — the arrival's own stopping distance at STOP_A,
 * which is the brakes plus the world and nothing invented. When that fits in the
 * road, the required retardation IS STOP_A and the trim's correct value is zero.
 * The servo is then only closing the loop, not supplying anything: it trims for
 * the grade the car happens to be on and for a bias observer that is a second
 * behind the truth, and tools/zystop.mjs measures the peak of that at 0.4 m/s².
 *
 * What is left for it to cover is the one case where the derived station does not
 * fit and stopStation clamps it:
 *
 *   fastest arrival, seed 16              52.8 m/s
 *   wants                                 52.8²/(2×7.4) = 188 m
 *   road allows (154 − STOP_TAIL_M)       134 m
 *   so needs                              52.8²/(2×134) = 10.4 m/s²
 *   brakes and world supply (STOP_A)       7.4
 *   trim                                   3.0 m/s², which is 0.31 g
 *
 * More than 3.0, and the headroom is deliberate: these arrivals are the
 * harness autopilot's and a human can be faster, and the clamp means a faster
 * arrival converts its extra speed directly into trim rather than into distance.
 * A cap that is generous costs a slightly harder stop on a seed already at the
 * end of the road; one that is tight costs a car that runs out of it.
 *
 * Thirteen of the fourteen seeds are inside the clamp and never come near this:
 * they arrive at 98–137 km/h, ask for 7.4, and get it from the pedal with the
 * trim reading a few tenths. It is a factor of 5.7 below what it replaced, and on
 * all but one seed what is actually used is a factor of 85 below.
 *
 * ---- ROUND 3: 6 → 5, and why not the 3.0 the arithmetic above asks for -----
 *
 * The arithmetic assumes the pedal is at BRAKE_PEDAL_MAX and therefore
 * delivering 0.55 × BRAKE_G. Measured, it is not: late in a stop the servo
 * commands 11.7 m/s² and the car achieves about 7.7, so the tyres plus world
 * are worth ~1.7 there rather than 5.7, and seven of the eight fast-seed cars
 * genuinely need 4.2–5.9 m/s² of scrub. A cap of 3 would clip real demand on
 * most of them; .fix/FINDINGS-bias.md measured what that costs, which is a mean
 * park error of 5.6 m against 1.8 and one car 27 m out.
 *
 * 5 is the demand of every car that is not clamped by the road. The single case
 * above it is seed 16 PLAYER at 189 km/h, whose station IS road-clamped, which
 * is the case this cap exists for — it is supposed to bind there. Held off
 * until now because the observer's wind-up was inflating the demand this is
 * measured against; with BIAS_TAU_UP_S in place the demand is the car's own.
 *
 * ---- ROUND 4: 5 → 6.5, because the demand moved and not the principle -------
 *
 * The principle is unchanged and it is the one above: the smallest value that
 * clips no healthy stop. What moved is the demand, and it moved because of two
 * physics fixes in other files — the `s` freeze (.fix/FINDINGS-pin.md) and the
 * AI no longer racing the berm at full throttle (.fix/FINDINGS-impacts.md).
 * Every arrival speed this cap was ever measured against predates both.
 *
 * The mechanism is specific. `Race._assignPark` stacks stations DOWNWARD in
 * arrival order, so on a fast seed the last car to arrive is given the nearest
 * station while arriving at the same speed as the first. Before the fixes seed 16
 * arrived 175–189 km/h across its four cars and the deepest-stacked car was the
 * SLOWEST one; now all four arrive at 186–189, so the car on the 116 m station is
 * doing 188 km/h instead of 175. Its demand is arithmetic:
 *
 *   52.2²/(2 × 116)             11.7 m/s²  ← and the trace reads 11.7
 *   pedal at BRAKE_PEDAL_MAX     5.7
 *   so the scrub must supply     6.0
 *
 * Measured with the cap lifted clear at 9 so nothing is clipped
 * (`node .fix/psum.mjs P4cap9`), that car peaks at **6.2** on a stop that is
 * healthy by every column the probe has: 0.5 m park error, `along` 1.00 for the
 * whole stop, never airborne, 2.9 m off a 19 m road. A cap of 6 clips it for
 * 0.22 s (`P4cap6`); 6.5 leaves seed 16 identical to the uncapped run, car for
 * car, to a tenth of a metre.
 *
 * The only car above 6.5 is seed 26 OCHRE at 9.0, and it is exactly what the cap
 * is for rather than a case against it: `node .fix/ptrace.mjs P4cap9 26 OCHRE`
 * shows it airborne for two seconds, `across` at 1.00 — pointing sideways — and
 * resting 10.1 m off the centreline, and its 9.0 arrives on the frames where it
 * has already overshot its station, so `d` floors at 0.5 m and `need` saturates
 * by construction. No cap that clips a healthy stop would spare it either.
 *
 * `~3`, still recommended by an older round, is now wrong by a wider margin than
 * when .fix/FINDINGS-bias.md rejected it: 14 of the 20 measured cars peak at or
 * above 3.0, including four on the SLOW seeds, which used to sit under 3.9 and
 * now reach 4.7. The figure assumed the pedal delivers 0.55 × BRAKE_G of actual
 * retardation; it does not, and that is why 3 was never the right shape of
 * answer. */
const SCRUB_MAX = 6.5;

/* How much of that retardation the tyres are allowed to be asked for.
 *
 * The rest goes to the scrub, and this cap is the difference between a car
 * that stops and a car that pirouettes. The first working version had no cap:
 * the servo asked the pedal for everything it had before spilling the
 * remainder into the scrub, so a car needing 2 g got 100% brake for the whole
 * stop. tools/finish.mjs measured the result as slip angle, and it only ever
 * went one way — 11° a quarter second after the line, 26° at a half, 43°,
 * 65°, 94°, and 158° by two seconds, which is a car facing back up the road.
 *
 * The mechanism is the friction circle plus the fact that the scrub does not
 * live in it. A tyre saturated longitudinally has no lateral force left, so
 * whatever yaw the car carried across the line has nothing to damp it, and
 * the scrub obligingly removes the car's speed while leaving its rotation
 * completely untouched. Every metre per second taken out of the velocity with
 * the yaw rate still running is another degree of slip.
 *
 * Capping the pedal fixes it at the root rather than damping the symptom: the
 * retardation that does not need grip is exactly the retardation that should
 * not be spending it. At 0.55 the tyres do 5.7 m/s² and keep something like
 * four fifths of their lateral authority, which is enough for the driver to
 * hold a line through a stop, and 0.55 of pedal is still a firm brake — the
 * nose dives, the discs glow, and the car is doing what it looks like it is
 * doing.
 *
 * ---- and why the constant said 0.3 while the paragraph above said 0.55 -----
 *
 * Because 0.55 was measured against a stop that needed 50 m/s², where the pedal
 * and a 34 m/s² scrub were running together and the scrub was the thing spinning
 * the car. Dropping the cap to 0.3 moved retardation OUT of the tyres and into
 * the scrub, which reduced the slip that the friction circle was causing and
 * increased the slip that scrubSpeed was causing, and 0.3 was where that trade
 * bottomed out. It was the right call for a 28 m stop and it is the wrong call
 * for a 120 m one: with the trim down to a few m/s² there is no longer a large
 * non-tyre retardation for the pedal to be protecting the car from, and holding
 * the pedal at 0.3 now just means a longer stop that needs a bigger trim — the
 * two constants were pushing against each other.
 *
 * Back to the 0.55 this comment always argued for, and the measurement that says
 * it is safe is stronger than the one that made it 0.3: tools/zystop.mjs runs the
 * stop with the ending's own Driver steering and reports peak slip. At FULL pedal
 * with the trim inactive the fourteen seeds peak at 1–9°. The 158° in the
 * paragraph above was never the pedal on its own. */
const BRAKE_PEDAL_MAX = 0.55;

/* The retardation the whole stop is designed around, m/s².
 *
 * Not a taste value: it is what the car has when the pedal is at the cap above
 * and nothing is being faked. 0.55 × 10.34 = 5.7 from the tyres, plus the 1.7 of
 * drag, engine braking and grade that tools/zystop.mjs measures by differencing a
 * full-pedal stop against the brakes' own authority (see BRAKE_G). 0.75 g, which
 * is a firm road-car stop and reads as one.
 *
 * Everything else about the stop follows from this one number: where the car
 * parks, how long it is allowed to take, and how much trim is left over. */
const STOP_A = BRAKE_PEDAL_MAX * BRAKE_G + 1.7;

/**
 * Where a car arriving at `speed` should come to rest, as metres past the line.
 *
 * The distance a firm brake actually needs, clamped to the road there is. So a
 * 90 km/h arrival parks at 42 m and a 190 km/h arrival at as far out as the
 * pavement allows, and both of them get the same brake — which is the property
 * that a fixed station cannot have and the reason this is a function.
 *
 * @param {number} speed m/s at the crossing. Latched there and not re-read: the
 *   station is where the car is going, and a target recomputed from the current
 *   speed every frame is not a target, it is a receding horizon.
 * @param {number} roadPastLine metres of authored road past the line —
 *   `track.roadEnd - track.finishS`. Passed in rather than imported because this
 *   module knows about cars and not about tracks.
 */
export function stopStation(speed, roadPastLine) {
  const want = (speed * speed) / (2 * STOP_A);
  const room = Math.max(STOP_MIN_M, roadPastLine - STOP_TAIL_M);
  return clamp(want, STOP_MIN_M, room);
}

/**
 * The nearest station a car may be given, once the cars parking after it are
 * accounted for. Metres past the line.
 *
 * WHY THIS IS A FUNCTION AND NOT JUST STOP_MIN_M, which is the bug it exists to
 * close. `stopStation` above clamps its own answer to STOP_MIN_M, so a car asked
 * on its own merits is never put under the arch. But it is not asked on its own
 * merits: `Race._assignPark` hands the field its stations in ARRIVAL order and
 * stacks each new one PARK_GAP metres SHORT of the last, so nobody has to drive
 * through a car that has already stopped. That chain walked straight through 26
 * — it was floored at PARK_GAP, six, which is a spacing and was never a station
 * — and measured (.fix/parkscrub.mjs) it put 12 of 20 cars to rest under the
 * arch, the player among them at 7 m past the line on seed 15.
 *
 * Raising STOP_MIN_M would not have fixed it: the floor that was binding was the
 * 6, so the 26 could have been any number at all. What was missing is that the
 * FIRST car's station has to be far enough out for the whole stack below it to
 * clear the arch. So Race says how much room it needs to reserve and this
 * function, which is where 26 lives, is the only thing that decides what the
 * answer means.
 *
 * @param {number} reserve metres the caller still has to stack below this car —
 *   for Race, PARK_GAP times the number of cars yet to park.
 * @param {number} roadPastLine as for stopStation. The reserve is clamped to the
 *   road for the same reason the station is: a floor past the end of the
 *   pavement is a car parked in the scenery, and the arch is the lesser problem.
 */
export function stopFloor(reserve, roadPastLine) {
  const room = Math.max(STOP_MIN_M, roadPastLine - STOP_TAIL_M);
  return Math.min(STOP_MIN_M + Math.max(reserve, 0), room);
}

/* Below this the servo is asked for a deceleration it cannot usefully deliver
   — v²/2d goes to nothing as v does, so the last two metres would be a car
   creeping — and the handbrake takes over to park it.
   The handbrake and NOT the brake, which is not a stylistic choice: the brake
   pedal doubles as reverse. `Car.step` selects reverse whenever the pedal is
   down and there is no forward speed left, so a car parked on the foot brake
   drives back up the road at 7 m/s. That is not a hypothesis; it is what the
   first run of tools/finstop.mjs measured, as a stop that travelled −6 m. */
const CREEP_MS = 2.5;
const PARKED_MS = 0.6;

/**
 * Pedals for a car that has finished, given how fast it is going and how much
 * road it has left to the station it is parking on.
 *
 * A pure function of the car's state — no clock, no memory — so it is the same
 * for the player and for a rival, and a tool can ask it a question directly.
 *
 * Pedals ONLY, and no steer. Every caller already has something better placed
 * to steer with — a Driver that knows where the road goes — and a servo that
 * returned a steer of zero alongside them would either be ignored or, worse,
 * spread over the driver's output by an Object.assign and quietly straighten
 * the car out on a road that is still turning.
 *
 * @param {number} speed m/s
 * @param {number} metresLeft to the parking station; may be negative
 * @param {number} sincePassed metres travelled since the line, for the ramp
 * @param {number} bias m/s² of retardation arriving from somewhere else, which
 *   the demand is reduced by. Zero is a usable answer; see StopServo for who
 *   knows better and why it matters.
 * @param {number} secondsLeft until the car has to be stopped whatever the
 *   distance law thinks. Infinity disables it; see StopServo for why it is
 *   not optional in practice.
 */
export function stopControl(speed, metresLeft, sincePassed = 99, bias = 0,
                            secondsLeft = Infinity) {
  /* Floored rather than clamped at zero: a car that has overshot its station
     is asked for the deceleration that would stop it in the last half metre,
     which saturates the pedal, which is the right answer. */
  const d = Math.max(metresLeft, 0.5);
  /* The whole control law: the deceleration that stops the car exactly here,
     recomputed every frame from where it actually is. Closed on the state
     rather than scheduled, so it is right at any arrival speed and on any
     seed without a single number being tuned against one of them — which is
     what lets the held camera below be a fixed, composed frame. */
  const need = (speed * speed) / (2 * d);
  /* The same demand expressed against the clock instead of the road: the
     constant retardation that takes this speed to zero in the time left. It
     is normally far below `need` and does nothing at all. It exists for the
     case where `d` stops shrinking — see StopServo. */
  const byThen = speed / Math.max(secondsLeft, 0.25);
  const ask = Math.max(Math.max(need, byThen) - bias, 0);
  const ramp = smoothstep(0, LIFT_M, sincePassed);
  /* Handing over rather than switching. Over this band the foot brake bows
     out and the handbrake comes in, so there is no frame on which the car has
     neither and none on which the pedal is down at a standstill. */
  const parking = 1 - smoothstep(PARKED_MS, CREEP_MS, speed);
  const gate = ramp * (1 - parking);
  const brake = clamp(ask / BRAKE_G, 0, BRAKE_PEDAL_MAX) * gate;
  const scrub = clamp(ask - brake * BRAKE_G, 0, SCRUB_MAX) * gate;
  return {
    throttle: 0,
    brake,
    handbrake: parking * ramp,
    /* NOT an input. The car never sees this field; it is what the tyres
       cannot deliver, in m/s², for the caller to take off the velocity after
       the step — see scrubSpeed. It rides on this struct so that there is
       exactly one place where "how a finished car stops" is written down,
       and both the player and every rival read it. */
    scrub,
    /* Also not an input: the total retardation this output represents, for
       StopServo to compare against what actually turns up. Derived from the
       gated values rather than from `ask`, so the observer is not told the
       car was asked for 2 g on a frame where the ramp only let 30% of it
       through. */
    demand: brake * BRAKE_G + scrub,
  };
}

/* How much retardation the observer below is allowed to believe the world is
 * supplying, m/s², either sign.
 *
 * THIS IS THE BOUND THAT WAS MISSING, and the absence of it is what let the
 * servo hand back a stop with no brake in the middle of it.
 *
 * The observer's whole job is to notice retardation the pedal did not ask for
 * and stop double-counting it. It was bounded only by BRAKE_G — the brakes'
 * own authority, 10.3 — on the argument that the terms being observed are all
 * far smaller than that, which is true of the terms it was BUILT for and not
 * true of what it actually sees. Measured (.fix/parkscrub.mjs, seeds 16 and
 * 26 at 186 km/h), it saturates that clamp: bias reaches 10.1, which is more
 * retardation than the brakes have, credited to "somewhere else".
 *
 * What it is really seeing there is the car cornering and running wide at
 * 186 km/h. That retardation is real — the trace shows 11 m/s² arriving with
 * the pedal at zero — but it is TRANSIENT, and it ends on one frame: 109 to
 * 93 km/h over four tenths, then 93 to 92 over the next two. The observer
 * cannot tell the difference, subtracts the whole pedal for six tenths of a
 * second while it lasts, and the car coasts 20 km/h of its stopping distance
 * away. Then it has to be bought back, which is what SCRUB_MAX is being
 * pinned for 1–2.4 s to do.
 *
 * THIS BOUND IS THE BACKSTOP AND NOT THE FIX. What separates a grade from a
 * corner is not how big it is — the two overlap — it is how long it lasts, so
 * the discriminator is BIAS_TAU_UP_S below and this is only the ceiling that
 * stops a long transient from arriving at an absurd number anyway. Measured
 * that way round: at 3, with the same time constants, the observer under-
 * credits the genuinely persistent drag at 186 km/h and the fast seeds stop a
 * mean 5.6 m short of their stations instead of 1.8, one of them by 27.
 *
 * Five is what the persistent terms are worth at the top of the range this
 * has to cover. tools/zystop.mjs measures drag, engine braking and grade
 * together at 1.7 m/s² as a MEAN over a full-pedal stop (see BRAKE_G, and
 * STOP_A which is built on it); the dominant term in it goes as v², so at the
 * 52 m/s arrival it starts near three times its own mean, and a grade adds
 * g·sin θ on top — a metre per second squared for every ten percent of slope.
 *
 * That a constant bound has to cover a v² term at all is the one dishonest
 * thing left here, and it is deliberate: the alternative is a drag model in a
 * file that has no business having one, and the time constant already stops
 * the number being reached by anything that is not there for the whole stop.
 *
 * Symmetric because the negative side is a real case and was misbehaving in
 * the same way: on a descent the world genuinely takes retardation away, and
 * the observer must be able to say so. What it must NOT do is what the trace
 * shows it doing at the end of those same stops — reading −4.6 because the
 * tyres cannot deliver the 11.7 m/s² they were just asked for, and responding
 * by asking for more. A shortfall in the plant is not a grade. */
const BIAS_MAX = 5;

/* How fast the observer below comes to believe something, and how fast it
 * stops, in SIMULATION seconds — it is integrating an acceleration, so it
 * runs on the clock the car does and not the wall.
 *
 * ASYMMETRIC, AND THIS IS THE GATE. A single time constant cannot separate a
 * grade from a corner, because both are just retardation arriving and they
 * are the same size; the only thing that tells them apart is that one of them
 * is still there two seconds later. So: slow to credit, quick to withdraw. A
 * source has to persist to be believed at all, and the frame it stops, the
 * credit goes with it.
 *
 * The old 0.3 was symmetric and was chosen to "average out a single frame's
 * kerb strike", which it does. What the car actually meets past the line is
 * not a frame, it is six tenths of a second of cornering at 186 km/h, and at
 * 0.3 that is two time constants — long enough to arrive at the full value
 * and take the entire pedal with it. At 1.6 the same window reaches 31% of
 * it, while drag, which is there for the whole three seconds, still reaches
 * 84%. That ratio is the whole mechanism.
 *
 * Both halves were measured rather than reasoned into place: at 1.0 the fast
 * seeds park a mean 3.2 m from their stations, at 1.6 it is 1.8 m, and the
 * seconds spent pinned against SCRUB_MAX fall from 0.81 to 0.10 across the
 * same twenty stops (.fix/parkscrub.mjs, seeds 15/16/23/26/40).
 *
 * The cost is that a grade takes about a second and a half to be picked up.
 * The stop lasts 3.4 to 11 (see stopDeadline), so it is picked up well inside
 * one, and a trim that arrives late is the thing the observer was already
 * accepting when its comment said it was "a second behind the truth". */
const BIAS_TAU_UP_S = 1.6;
const BIAS_TAU_DOWN_S = 0.25;

/* By when a finished car must be stopped, in SIMULATION seconds from its own
 * crossing, whatever else is going on.
 *
 * The distance law is the whole controller and it has one blind spot: it
 * assumes the distance closes. `Car.s` is the projection of the car onto the
 * road's centre line, and a car that has left the road does not have one that
 * advances — it pins. tools/finish.mjs caught this on seed 7, where the road
 * turns immediately past the line: the car ran wide, `s` froze at 7 m past,
 * and from that moment the servo saw a constant 15 m still to run and a
 * modest speed, asked for the gentle 0.4 m/s² that implies, and would have
 * cruised across the hillside at 23 km/h until the heat death of the
 * universe. The run ended with the stop time reported as −1: never.
 *
 * So the demand is also expressed against the clock, and the servo takes
 * whichever of the two is larger. On a normal stop the distance law is
 * larger throughout and this term is not reachable; it is the floor under
 * the case where the geometry has stopped making sense.
 *
 * 3.4 is chosen against the presentation and not the physics: the results
 * card starts arriving at 1.9 s and the camera has finished settling at 1.2,
 * so a car still rolling at 3.4 is a car still rolling under a finished
 * composition.
 *
 * ---- ROUND 2: 3.4 s was a bound on a 28 m stop -----------------------------
 *
 * With the stop 42–134 m long it is no longer a backstop, it is the mechanism:
 * measured, it fired on all fourteen seeds and stopped the car wherever it had
 * got to, at 26–87° of slip. A backstop that always fires is not protecting
 * anything, it is the plan.
 *
 * So it scales with the arrival too, off the same firm retardation the station
 * does. A stop at STOP_A from v takes v/STOP_A seconds — 3.4 at 90 km/h, 7.1 at
 * 190 — and the margin above that is what keeps this from binding on a stop that
 * is merely having a hard time. It still bounds the pathological case it was
 * built for, which is a car whose `s` has pinned because it left the road: that
 * car gets its own arrival's worth of seconds and no more.
 *
 * The floor is the old 3.4, so nothing arriving slowly is given longer than it
 * used to be. The ceiling is because `s` pinning at high speed is exactly when a
 * bound is needed most. */
/* 1.6 was tried and it still bound: a 90 km/h arrival is allowed 5.4 s and
   measures 5.5, so the last tenth of every slow seed's stop was under a
   deadline. Harmless there — 5 km/h and 4–6° of slip — but a backstop that is
   touched by a healthy stop is not a backstop. At 2.0 the slowest arrival gets
   6.8 s against a measured 5.6, and the fastest is bounded by STOP_BY_MAX_S
   either way. */
const STOP_BY_MARGIN = 2.0;
const STOP_BY_MIN_S = 3.4;
const STOP_BY_MAX_S = 11;

/** How long a car arriving at `speed` m/s has to be stopped in. */
export function stopDeadline(speed) {
  return clamp((STOP_BY_MARGIN * speed) / STOP_A, STOP_BY_MIN_S, STOP_BY_MAX_S);
}

/**
 * `stopControl` with a memory, which is what a car actually needs.
 *
 * The control law above computes the retardation that stops the car on its
 * mark and asks the plant for exactly that. It is right, and on its own it
 * stops the car short every time — measured at 6 m short on seed 1 and 15 m
 * on seed 7, against a camera that is framing a fixed patch of road. The
 * reason is that the demand is not the only retardation the car gets: drag,
 * rolling resistance and engine braking are all still there, worth 2–3 m/s²
 * at these speeds, and on a coastal DESCENT the grade term works the other
 * way and varies seed to seed and metre to metre. The servo can add
 * deceleration and cannot take any away, so every one of those is an
 * overshoot it can never correct, and they integrate into a car that halts
 * well before the arch.
 *
 * So: watch what the car actually does, subtract what was asked for, and the
 * difference is everything else the world is contributing. Feed it back as
 * `bias`. One first-order observer, no gains to tune beyond the time
 * constants, and it is indifferent to WHY the extra retardation is there —
 * which is the property that matters, because the list above is not
 * guaranteed complete and a future tyre model will not have to know this
 * file exists.
 *
 * IT IS NOT INDIFFERENT TO HOW LONG IT LASTS, and that distinction is the
 * whole of BIAS_MAX and BIAS_TAU_UP_S. Every item on the list above is there
 * for the length of the stop; the things that are not — a corner, a kerb, a
 * car it has just hit — are retardation the car will not still be getting
 * when it needs it, and crediting them is how the servo came to hand back a
 * stop with no brake in the middle of it. The observer still does not need to
 * know which is which. It only asks whether the source is still there.
 *
 * One of these per car. The player's lives on the Ending; each rival's lives
 * on its race entry.
 */
export class StopServo {
  constructor() { this.reset(); }

  reset() {
    this.bias = 0; this._wasMs = null; this._demand = 0; this.t = 0;
    /* Metres travelled since the crossing, dead-reckoned from the car's own
       speed. See `control` for what it is for; it is not a better odometer
       than `Car.s` and is not used as one. */
    this.ran = 0;
    /* The arrival speed, latched on the first call. Both the station and the
       deadline are functions of it, and both have to be functions of the speed
       the car CROSSED at rather than of its current one — a deadline recomputed
       from a decaying speed shrinks as the car slows and would guillotine every
       stop it was meant to allow. */
    this.v0 = null;
  }

  /**
   * @param {number} dt simulation seconds since the previous call. Callers
   *   that step a car several times per control update pass the whole
   *   interval, because that is the span the speed change was measured over.
   */
  /**
   * Where the car this servo is stopping should come to rest, metres past the
   * line, given `roadPastLine` of authored road there. The arrival speed is the
   * one it latched; `speed` is only read on the frame before its first control()
   * call, which is the one frame main.js can ask this before the crossing has
   * been observed.
   */
  station(roadPastLine, speed) {
    return stopStation(this.v0 === null ? speed : this.v0, roadPastLine);
  }

  control(speed, metresLeft, sincePassed, dt) {
    if (this.v0 === null) this.v0 = speed;
    if (this._wasMs !== null && dt > 1e-6) {
      const arrived = (this._wasMs - speed) / dt;
      /* Clamped to what a persistent source can be worth, and not to what any
         source can be worth: an impact, a recovery teleport, a kerb or a
         corner can all put an enormous number through here, and every one of
         them is over before the car has stopped. See BIAS_MAX. */
      const surprise = clamp(arrived - this._demand, -BIAS_MAX, BIAS_MAX);
      /* Away from zero is a grant of credit and toward it is a withdrawal, so
         the two run on different clocks. A surprise of the opposite sign is a
         withdrawal until the bias reaches zero and a grant after it, which
         this gets right frame by frame without a case for it: the sign
         product turns over on the frame the crossing happens.
         See BIAS_TAU_UP_S. */
      const granting = surprise * this.bias >= 0
        && Math.abs(surprise) > Math.abs(this.bias);
      const tau = granting ? BIAS_TAU_UP_S : BIAS_TAU_DOWN_S;
      this.bias += (surprise - this.bias) * clamp(dt / tau, 0, 1);
    }
    this.t += dt;
    this.ran += speed * dt;
    /* THE LIFT RAMP MAY NOT BE DRIVEN BY `Car.s` ALONE, and this is the whole
     * of the change.
     *
     * `sincePassed` is `car.s - track.finishS` at both call sites, and `Car.s`
     * is the projection onto the centre line, which pins — that is the failure
     * `stopDeadline` above exists for. What was missed is that the deadline
     * cannot do its job while the RAMP is reading the same pinned number: the
     * ramp multiplies the brake and the scrub alike, so a car whose `s` froze
     * at 1 m past the line gets smoothstep(0, 4, 1) = 16% of everything the
     * servo asks for, deadline included. Measured (.fix/parkscrub.mjs, seed 15
     * BONE, arriving 65 km/h): pedal 0.07–0.09 and 1.4–1.9 m/s² for nine and a
     * half seconds, against a deadline of 4.9 that had fired and was being
     * ignored. A backstop throttled by the defect it backstops is not one.
     *
     * Dead reckoning is what `sincePassed` always meant. The ramp is there so
     * the brake arrives over the first few metres rather than on one frame, and
     * "how far has this car come since it crossed" is a question the servo can
     * answer from the speed it is already differencing, without asking the road
     * where the car is.
     *
     * HANDICAPPED BY A WHOLE LIFT_M, and that is what keeps this from being a
     * change to every stop on the game. Dead reckoning is a path length and
     * `sincePassed` is a projection, so on a curve the first runs ahead of the
     * second by metres, and taking the plain larger of the two opened the ramp
     * a few frames early on stops that had nothing wrong with them. Harmless in
     * itself and not harmless in aggregate: a few frames of extra pedal at
     * 186 km/h is a different trajectory, and seed 26 COBALT parked 14 m
     * further short for it. Subtracting LIFT_M makes the fallback strictly
     * weaker than the ramp it is backing up, so within the only band where the
     * ramp is not already 1 — the first four metres — `ran - LIFT_M` is
     * negative and this term cannot bind. Healthy stops are unchanged, measured
     * and not argued: `node .fix/psum.mjs BASE RAMP6` — this change with
     * SCRUB_MAX held at its old value — puts all eight fast-seed cars on the
     * same rest position to a tenth of a metre. What it still catches is the
     * case it is for, because a pinned car's `ran` keeps climbing while its
     * `sincePassed` does not: seed 15 BONE stops in 4.25 s instead of 7.75.
     *
     * It does not un-pin the car — nothing in this file can, see
     * .fix/FINDINGS-stops.md — but it stops the ending from holding the brake
     * off one. */
    const out = stopControl(speed, metresLeft,
      Math.max(sincePassed, this.ran - LIFT_M),
      this.bias, stopDeadline(this.v0) - this.t);
    this._wasMs = speed;
    this._demand = out.demand;
    return out;
  }
}

/**
 * Take `decel` m/s² off a car, along whatever direction it is travelling.
 *
 * The partner to the `scrub` field above, and the only thing in the ending
 * that reaches into the car. Kept to one function so the player and the
 * rivals cannot drift apart, and applied per SUBSTEP by both callers — dt
 * here is simulation seconds, because it is being subtracted from a velocity.
 *
 * Scaling the velocity vector rather than subtracting along the heading is
 * what keeps a car that crossed the line sideways from having its slip angle
 * quietly straightened out by the stop.
 *
 * THE YAW RATE SCALES BY THE SAME FACTOR, and that line is not a refinement —
 * without it this function does not work. A scripted retardation that removes
 * a car's speed and leaves its rotation alone is the pinned-partner bug this
 * project keeps rediscovering, in its purest form: two halves of one rigid
 * body's state, one being scaled and one not, agreeing only where the
 * rotation happens to be zero.
 *
 * The failure is not subtle once the right column is in the trace. Slip angle
 * is atan2(vy, vx) and its rate is essentially −r whenever the tyres have no
 * lateral force left to argue with it, so a car crossing the line with any
 * yaw at all — which is every car, since the road is still turning — spins up
 * as it slows. tools/finish.mjs measured 50° of slip on seed 1 and 37° on
 * seed 7, and the giveaway was `moved` against `past`: 0.1 m of world travel
 * in a quarter second while the speedometer read 39 km/h, which is not a car
 * driving anywhere, it is a car rotating on the spot. Both seeds parked with
 * `s` frozen where the spin started, one of them 21 m short of its mark and
 * broadside to a camera composed down the road.
 *
 * Scaling r with v holds the slip angle roughly where it was at the line and
 * winds the rotation down in step with the speed, which is also just what
 * stopping is.
 */
export function scrubSpeed(car, decel, dt) {
  if (!(decel > 0)) return;
  const v = Math.hypot(car.vx, car.vy);
  if (v < 1e-4) return;
  const k = Math.max(0, (v - decel * dt) / v);
  car.vx *= k;
  car.vy *= k;
  car.r *= k;
}

export class Ending {
  constructor() {
    /* Off unless the owner says otherwise — see main.js, where the flag is
       the same `manual` story the countdown already has. */
    this.enabled = true;
    this.armed = true;          // will fire on the next crossing
    this.running = false;
    this.t = 0;                 // WALL seconds since the crossing
    this.rows = [];
    this.won = false;
    this._tone = null;
    this._toneAt = -1;
    /* WALL seconds the prompt has been held back waiting for the player's car,
       and whether it has stopped waiting. See update(). */
    this._held = 0;
    this._settled = false;
    /* The player's, and the reason it lives here rather than in main.js: it
       is state that has to be cleared when a race restarts, and this object
       is already the thing that gets cleared. */
    this.servo = new StopServo();
  }

  /**
   * Ready to fire on the next crossing, from the top, whatever state this was
   * in. Unconditional for the reason Countdown.arm() is: a caller that asks
   * for an ending has asked for an ending, and silently declining because one
   * is half-run hands back an object reporting `running === false`.
   */
  arm() {
    this.armed = true;
    this.running = false;
    this.t = 0;
    this.rows = [];
    this.won = false;
    this._tone = null;
    this._toneAt = -1;
    this._held = 0;
    this._settled = false;
    this.servo.reset();
  }

  /** Back to before the race. Same thing, plus the enable is untouched. */
  reset() { this.arm(); }

  /**
   * Never fire, and stop firing.
   *
   * Sticky, unlike the countdown's, and that difference is the whole reason
   * this is safe for the instrument suite. A countdown is over within three
   * seconds of a tool starting, so ending it once is enough; an ending is
   * waiting at the far end of the stage for however long a tool takes to
   * drive there. Everything that enters the world programmatically — goTo,
   * driveTo, warp, autopilot — calls this, and it stays called until
   * something explicitly arms it again.
   */
  skip() {
    this.armed = false;
    this.running = false;
    this.t = 0;
    this._tone = null;
  }

  get alive() { return this.running; }
  /** The caller should be driving the car and the camera. */
  get holding() { return this.running; }
  /* DELIBERATELY NOT ON THE HELD CLOCK, and the reason is no longer the one
   * this comment used to give. Read that first, because the hazard it described
   * is closed and a comment that keeps a resolved hazard alive is its own bug.
   *
   * It used to say: main.js's only reader was `if (canRestart) restart(); else
   * respawn();`, so a false answer here did not mean "ignore R", it meant
   * RESPAWN THE CAR — and putting this on the held clock would have stretched a
   * mid-ending respawn window from 1.45 s to 8.67 s. That was true, and it was
   * the right call at the time. It is no longer the situation: main.js now has a
   * `raceOver` predicate and refuses to respawn anything while this object is
   * holding, so `!canRestart` no longer means "put the car back on the road".
   * The window it protected against is 1.45 s wide on the old tree and zero on
   * this one, measured by pressing the key (.fix/rkey.mjs, .fix/FINDINGS-endgap.md).
   *
   * What is left is the plain version of the original recommendation, and it
   * still loses. Subtracting `_held` here would keep the restart from going live
   * before the prompt is drawn — a gap measured at 4.20–9.05 s across five seeds
   * (.fix/phold-P4held2.txt) — but with the respawn gone, the cost of that gap is
   * only that R works slightly before it is advertised, and the cost of closing
   * it is that R is SILENT for up to 9 s while the player presses it. A key that
   * quietly does the thing you asked for early is better than one that ignores
   * you until it is ready to say so. The hang risk the original flagged is not
   * real either: measured, the only reader in `src/` is main.js and no tool in
   * `tools/` mentions this getter at all.
   *
   * So the card beat stays the beat the restart goes live on, which is also
   * where it is easiest to argue: it is live from the moment the result is on
   * screen. */
  get canRestart() { return this.running && this.t >= CARD_WAIT_WALL; }

  /** 0 at the chase pose, 1 at the held one. */
  get camera() { return this.running ? smoothstep(0, CAMERA_WALL, this.t) : 0; }
  /** Degrees to take off the lens, for the slow push. */
  get lensPush() {
    if (!this.running) return 0;
    return PUSH_DEG * smoothstep(CAMERA_WALL, CAMERA_WALL + PUSH_WALL, this.t);
  }

  /**
   * Advance. `dt` is WALL seconds — the frame's own dt, never `ran`.
   *
   * @param {number} dt
   * @param {{finished:boolean, standings:Array}} ctx
   */
  update(dt, ctx) {
    if (!this.enabled) return;
    const finished = !!(ctx && ctx.finished);
    if (!this.running) {
      if (!this.armed || !finished) return;
      this.running = true;
      this.armed = false;
      this.t = 0;
      this._toneAt = -1;
    } else {
      this.t += dt;
    }

    /* The classification is read live rather than latched at the crossing,
       and that is the interesting half of the card. When the player wins,
       three cars are still on the road; a table frozen on the crossing frame
       would show them mid-stage forever, and there would be nothing to watch
       while the prompt waited. Read every frame, the rows fill in behind the
       player as the rivals arrive under the same arch the camera is pointed
       at. Times for finished cars are locked at the line by Race itself, so
       nothing already decided can move. */
    if (ctx && ctx.standings) this._rows(ctx.standings, ctx.lineS || 0);

    /* THE PROMPT WAITS FOR THE PLAYER'S CAR. THE CARD DOES NOT.
     *
     * The defect this closes is narrow and worth stating exactly, because the
     * obvious wider version of it is not a defect at all. Rivals arriving under
     * a finished card is the DESIGN — see the comment above `_rows`, and the
     * arithmetic that makes it unavoidable: the field's own arrival spread is
     * 2.1–2.4 s, the card is fully in 1.87 s after the player crosses, and even
     * a theoretically perfect `v/STOP_A` stop leaves the last car moving well
     * past the finished prompt. Nothing here can change that and nothing here
     * should try.
     *
     * What IS a defect is that the game offers the player the way out while the
     * player's own car is still travelling. Measured on the post-pin tree
     * (`node .fix/psum.mjs P4cap65`), at the instant the prompt is fully in the
     * player is doing 24, 56, 24, 43 and 0 km/h on seeds 15/16/23/26/40. The
     * card is the RESULT and should land over a rolling car — that is the whole
     * argument at CARD_WAIT_WALL and it is right. The prompt is the INVITATION
     * TO LEAVE, and offering it before the car has arrived is what makes the
     * composition read as finished ahead of the thing it is composed around.
     *
     * BOUNDED, and by a number this module already owns rather than a new one.
     * An indeterminate wait would have its own problem; `stopDeadline(v0)` is
     * the servo's own contract for when THIS car must be stopped — 3.4 to 7.1 s
     * — so a prompt that waits for the car but never past the moment the car is
     * guaranteed to be stopped is determinate, and it is bounded by the same
     * number the stop is scheduled against, so the two cannot drift apart.
     *
     * The clamp is on `_held` itself rather than on the servo's `t`, and that is
     * deliberate: `_held` offsets a WALL clock and the deadline is in SIMULATION
     * seconds, so gating on `servo.t < stopDeadline(...)` would let the bound be
     * exceeded in wall terms wherever `timeScale()` is not 1. Clamping the wall
     * accumulator to the number of seconds directly is the same bound in the
     * unit the quantity is actually in, which is the rule the header sets out.
     *
     * ONE-SHOT, via `_settled`. Seeds 15 and 40 have cars that come to rest and
     * then roll away down the camber — measured at up to 12 s of creep. Without
     * the latch, such a car would start the hold growing again and the prompt
     * would fade back OUT after the player had seen it. Once the car has
     * arrived, it has arrived.
     *
     * If the servo never runs — a tool driving the car itself, `manual` mode —
     * `v0` stays null, nothing is held, and the prompt keeps exactly the timing
     * it had before this landed. */
    const s = this.servo;
    if (!this._settled && s.v0 !== null) {
      if (s._wasMs !== null && s._wasMs <= PROMPT_SETTLED_MS) this._settled = true;
      else this._held = Math.min(this._held + dt, stopDeadline(s.v0));
    }

    /* One tone per beat, fired on the transition rather than tested per
       frame, so a long frame cannot drop one or double it. */
    const beat = this.t >= CARD_WAIT_WALL ? 1 : 0;
    if (beat > this._toneAt) {
      this._toneAt = beat;
      this._tone = beat === 0 ? 'flag' : 'card';
    }
  }

  _rows(standings, lineS) {
    const lead = standings.find(x => x.finished);
    const rows = [];
    for (const x of standings) {
      rows.push({
        pos: x.position,
        name: x.isPlayer ? 'PLAYER' : (x.name || 'CAR'),
        isPlayer: !!x.isPlayer,
        finished: !!x.finished,
        time: x.time,
        /* Gap to the winner, and only between cars that have both actually
           finished. A gap to a car still driving is not a gap, it is a
           forecast, and a results table is the one place in this game that
           has no business forecasting anything. */
        gap: x.finished && lead && x !== lead ? x.time - lead.time : null,
        /* What a car still on the road gets instead: the metres it has left.
           A distance is something that has happened. */
        behind: x.finished ? 0 : Math.max(0, lineS - x.s),
        recoveries: x.recoveries || 0,
      });
    }
    this.rows = rows;
    const me = rows.find(r => r.isPlayer);
    this.won = !!me && me.pos === 1;
  }

  /** The one-shot audio event, consumed. 'flag' | 'card' | null. */
  takeTone() {
    const t = this._tone;
    this._tone = null;
    return t;
  }

  /**
   * What the HUD should draw, or null.
   *
   * Null is load-bearing: the HUD's draw path for "no ending" has to be the
   * one it had before this landed, pixel for pixel (tools/hudparity.mjs).
   */
  display() {
    if (!this.running) return null;
    const into = this.t - CARD_WAIT_WALL;
    const k = smoothstep(0, CARD_IN_WALL, into);
    /* The card reads `into` and the prompt reads the held clock. That one
       difference is the whole of the change; see update(). A pure read — the
       accumulating is done where `dt` is. */
    const promptK = smoothstep(
      PROMPT_WAIT_WALL, PROMPT_WAIT_WALL + PROMPT_IN_WALL, into - this._held);
    return {
      rows: this.rows,
      won: this.won,
      alpha: k,
      scale: 1 + (CARD_POP - 1) * (1 - k),
      dim: DIM_MAX * k,
      prompt: promptK,
    };
  }
}

export const ENDING_CAMERA_WALL = CAMERA_WALL;
