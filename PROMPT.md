# Original prompt

This project was built from the brief below. It is reproduced as written, before any of the work started.

---

## Cel-Shaded Downhill Racing — Three.js

I want you to build a third-person cel-shaded car racing game. Not photorealistic — stylized like a comic book. Thick black outlines on everything, flat-shaded color with hand-painted lighting, exaggerated dust and drift clouds, and a camera that follows tight behind the car.

The track is a winding mountain descent. Red rock desert canyon with scattered boulders, dried brush, distant mesas, and a sky that looks painted. Think desert rally, not circuit racing.

3-4 AI opponents on the same track. Simple rubber-band AI — they speed up when behind, slow when ahead. No complex pathfinding needed, just spline-following with some randomness.

Do this in Three.js. Zero external assets. Every texture, every mesh, every sound must be generated procedurally in code. No PNG, no GLB, no WAV, no font files.

### Systems, in order

1. Cel-shaded rendering — quantized lighting, outlines
2. Track — winding mountain descent spline
3. Car — arcade physics, drift, suspension
4. Camera — tight third-person chase
5. Effects — dust, drift clouds, speed lines at high velocity, stylized skid marks on the road
6. AI opponents — 3 cars following the track spline with offset and rubber-banding
7. HUD — speedometer, position, track profile, timer, all procedural
8. Sound — engine revs (frequency-modulated oscillator tied to speed), tire screech, wind, impact bumps, all synthesized DSP
9. Post-processing and polish — color grading, vignette, subtle screen shake on impacts

For each system: build it, then spawn ONE separate sub-agent as a harsh visual critic. The critic should compare the result against cel-shaded racing games and rate whether it achieves a convincing stylized look. If it doesn't, keep iterating before moving to the next system.

The critic must never be the same agent that built the thing. It should only see the rendered output, not the code.

Loop on each system until the critic confirms it looks like a polished indie racing game, not a tech demo. Then move to the next system.

The final result should feel like a game someone would actually play — tight controls, satisfying drifts, and a visual style that makes people stop and look.

---

## Direction changes during development

Two significant redirections were made after the initial brief:

**The setting moved from desert to coast.** The red rock canyon was replaced with a coastal mountain road, described as "Outrun meets Studio Ghibli" — a world that reads as lived-in rather than empty, with a palette that pops.

**The player starts last.** Rather than beginning on pole, the player is placed at the back of a reversed grid, so the field is visible at the start and there is something to overtake.

## Note on the critic loop

The build-then-critique structure in the original brief was followed throughout and became the defining method of the project. Its most useful property turned out to be one the brief did not anticipate: because the critic could only see rendered output, it repeatedly found that a mechanism correct in simulation was invisible on screen. Several systems passed their own internal measurements while failing entirely as something a player could see.
