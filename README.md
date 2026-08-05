# redrock

A cel-shaded downhill racing game built in Three.js, with every asset generated procedurally at runtime.

**[Play it in the browser](https://starknightt.github.io/redrock/)** — no install, keyboard required.

There are no models, textures, audio files or fonts in this repository. The road, the terrain, the sea, the vegetation, the cars, the crowd, the user interface and the entire sound design are produced in code at load time. The only runtime dependency is Three.js.

## Overview

You descend a coastal mountain road against three AI rivals. A stage is roughly 5.6 km long with about 468 m of vertical drop, and the layout is generated from a seed, so every seed number produces a different course. Fourteen seeds ship as the verified set.

The visual target is a comic-book look: thick black ink outlines, flat colour quantised into bands rather than smooth gradients, hand-placed lighting, and heavily exaggerated dust.

## Running it

The hosted build at [starknightt.github.io/redrock](https://starknightt.github.io/redrock/) is deployed from `main` by `.github/workflows/pages.yml`, which vendors Three.js into a `dist/` and rewrites the import map to a relative specifier. To run it locally instead, Node.js 18 or newer is required.

```bash
npm install
npm run serve
```

Then open `http://localhost:8123/`.

To load a specific stage, append a seed fragment:

```
http://localhost:8123/#seed=22
```

## Controls

| Input | Action |
| --- | --- |
| Arrow keys or WASD | Steer, accelerate, brake |
| Escape | Pause menu |
| R | Restart, and recover the car if it becomes stranded |

## What is in the game

**World.** A spline-based track carrying a real physical surface with crown, camber, ripple and raised berms. Terrain is built outward from the road in layers, with a deliberate lighting arc across the stage so the descent darkens as it progresses. Populated with layered vegetation, swaying grass, wildflowers, guardrails, chevrons, marker boards, lighthouses with sweeping beams, wind turbines, bridges, hay bales, tyre barriers, a road tunnel, and flocks of birds that circle on paths fitted to the terrain they fly over.

**Driving.** Arcade handling built on a real structure: a friction circle per axle, longitudinal and lateral load transfer, load-sensitive tyre grip, and a suspension model that dives under braking and squats under power. Simulation runs at a fixed 120 Hz beneath a variable render rate, and is verified to behave identically at 30, 60, 144 and 200 frames per second.

**Racing.** Three AI rivals using pure-pursuit steering with corner-radius speed planning, off-road pace limiting, and recovery behaviour. A rubber-band system decomposed into a player-fairness term and a pack-cohesion term, each gated independently.

**Jumps.** Ramps are sited by a scan that scores candidate locations on approach straightness, runout, sun exposure and camera clearance, using real ray tests against the built world. Launches trigger a brief slow-motion window, a camera pullback, and a ground mark beneath the car that keeps the height readable against the terrain.

**Presentation.** Title screen, a three-two-one starting procedure with the field held against the rev limiter, pause menu, and a full ending sequence that brakes the field to rest, settles the camera on the parked cars and presents a results card.

**Interface.** An elevation card showing progress and total drop, a traffic strip mapping rival positions onto a player-centred hyperbolic axis, position badge, timer and speedometer. Drawn entirely in canvas with procedurally constructed letterforms.

**Audio.** Synthesised in the Web Audio graph: engine tone driven by speed and load, tyre scrub, wind, impacts, and event cues, with a sidechain so one-shots cut through the engine.

## Rendering

A custom cel-shading pipeline. Lighting is quantised into discrete bands rather than interpolated. Outlines come from a screen-space edge detection pass over depth, normals and an object class buffer written during a prepass, which allows different classes of object to take different pen weights, and allows volumetric elements such as dust to occlude other outlines without drawing their own.

## Development approach

The `tools/` directory contains roughly 240 command-line programs that drive the game in a headless browser and measure it: capturing frames, counting pixels, tracing physics substeps, and running full races across the seed set. Changes are evaluated against these rather than by eye.

Two principles carry most of the weight, both learned the hard way:

**An instrument must be shown capable of detecting the fault before a clean result from it is believed.** Roughly ten probes were discarded during development for confidently measuring the wrong thing, including one that returned an identical answer for every input, and one that computed a slip angle from a stationary car.

**A gate must be able to fail.** A test that reports success unconditionally is worse than no test, because it produces confidence rather than merely lacking it.

## Repository layout

```
src/
  car/          Vehicle physics and AI driver
  world/        Track generation, terrain, environment, props
  render/       Cel shading, outline pass, post-processing
  fx/           Particle systems, dust, ground marks
  race/         Standings, rubber band, ending sequence
  ui/           HUD, pause menu, title screen
  audio/        Procedural audio graph
  core/         Shared utilities and seeded RNG
tools/          Headless measurement and capture suite
```

## Origin

Built from a single prompt, iterated over several days. The original brief is preserved in [PROMPT.md](PROMPT.md).

## Licence

ISC
