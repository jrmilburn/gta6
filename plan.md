# Build Plan: "Sunbelt City" (open-world driving game, browser)

Instagram series episode: "I asked AI to build GTA VI in a day."
Working title inside the codebase: **Sunbelt City**. Never use any Rockstar name, logo, font, character, radio station, map name or the letters "GTA" anywhere in code, assets, UI or copy. Everything on screen must be original and procedurally generated. This is not negotiable.

Read this whole document before touching code. Section 0 is for every agent. Sections 2 to 10 are the phase specs. Section 11 is the cut list for when time runs out.

---

## 0. Operating rules for agents

1. **Timebox.** Total agent build time is ~8 hours wall clock. Each phase has a budget. If you are 30% over budget, stop adding, make it pass acceptance, commit, and move on. Do not gold-plate.
2. **Do not ask the human questions.** Every decision you would normally ask about has a default in this document. If something is missing, pick the simplest option, write it as a one-line comment `// DECISION: ...` at the top of the file, and continue.
3. **Contracts are fixed.** `src/types.ts` and `src/config.ts` are written in Phase 0 and are the interface between phases. You may add to them; you may not rename or remove anything without updating every consumer in the same commit.
4. **Zero external assets.** No model downloads, no texture downloads, no fonts from CDNs, no audio files, no network requests at runtime. Every mesh is built from Three.js primitives or `BufferGeometry`. Every texture is drawn to a canvas at boot. Every sound is synthesized with Web Audio.
5. **Dependencies allowed:** `three`, `vite`, `typescript`. Dev only: `@playwright/test`. Nothing else. No physics engine (custom arcade physics is faster to get right and to tune).
6. **Performance budget:** 60 fps at 1920x1080 on an Apple M-series laptop in Chrome. Draw calls under 300. Use `InstancedMesh` for buildings, props, traffic and pedestrians. Frustum culling stays on. No shadow-casting on instanced props except buildings.
7. **File size limit:** no source file over 400 lines. Split by responsibility.
8. **Commit cadence:** commit after every acceptance criterion passes, message format `phase-N: <what>`. Never leave the main branch in a state that fails `pnpm build`.
9. **Verification is mandatory.** Every phase ends by running `pnpm build` and `pnpm smoke` (Phase 0 sets this up). Attach the screenshot path from `screens/` in the commit body. If the smoke test cannot pass, the phase is not done.
10. **No violence beyond arcade collisions.** Cars crash, pedestrians tumble and get back up, police ram you. No weapons, no blood, no gore, no death animations. Fail states are "WRECKED" (car destroyed) and "BUSTED" (caught by police).
11. **Model assignment.**
    - Opus 5: Phases 0, 1, 2, 5 (architecture, city generation, vehicle physics, police AI). These are the phases where a wrong early decision costs hours.
    - Sonnet 5: Phases 3, 4, 6, 7, 8 (on-foot player, traffic and pedestrians, missions, HUD and audio, capture mode and polish).
12. **Parallelism.** Phases 1 and 2 are independent and run in parallel worktrees after Phase 0 merges. Phase 7 (HUD/audio) can start once Phase 2 merges. Everything else is sequential on main. Each phase maps 1:1 to a GitHub issue so `/orchestrate` can drive it.

---

## 1. Stack, repo layout, and the game loop

```
sunbelt-city/
  index.html
  package.json            pnpm, scripts: dev, build, preview, smoke
  vite.config.ts
  tsconfig.json
  playwright.config.ts
  smoke/
    smoke.spec.ts         loads the game, waits 4 s, asserts no console errors,
                          samples fps for 3 s (must average >= 50), screenshots
                          to screens/<phase>-<timestamp>.png
  src/
    main.ts               boot: create Game, start loop
    config.ts             every tunable number lives here (see 1.2)
    types.ts              shared interfaces (see 1.3)
    core/
      game.ts             owns scene, renderer, fixed-timestep loop, systems list
      input.ts            keyboard state, edge-triggered key presses
      rng.ts              seeded PRNG (mulberry32), seed from ?seed= URL param, default 1337
      textures.ts         canvas-drawn textures: road, windows, sidewalk, signs
      audio.ts            Web Audio synth: punch, gunshot, dance beat
    world/
      cityGen.ts          block/zone layout -> CityData
      roadGraph.ts        nodes, lanes, pathfinding (A*), nearest lane query
      buildings.ts        instanced building meshes from CityData
      props.ts            palms, streetlights, traffic lights, benches, neon signs
      water.ts            animated water plane on the beach edge
      sky.ts              gradient sky dome, fog, lighting rig
    entities/
      vehicle.ts          Vehicle class: state, arcade physics step, collision response
      vehicleMesh.ts      low-poly car body builders per VehicleKind
      player.ts           on-foot controller, enter/exit vehicle
      playerMesh.ts       blocky humanoid with procedural walk cycle
      traffic.ts          AI cars on the lane graph
      pedestrians.ts      sidewalk wanderers, flee behaviour, tumble
      police.ts           wanted system, pursuit AI, spawning, roadblocks, helicopter
    gameplay/
      missions.ts         mission state machine + the three mission types
      markers.ts          glowing mission markers and checkpoints
    ui/
      hud.ts              DOM overlay: stars, cash, health, speed, mission text
      minimap.ts          canvas 2D minimap drawn from RoadGraph
      screens.ts          title splash, WRECKED, BUSTED, MISSION PASSED
    camera/
      cameras.ts          chase, hood, orbit, drone, free-fly; cycling and smoothing
    capture/
      showcase.ts         scripted demo sequence for filming (Phase 8)
```

### 1.1 Loop
- Fixed timestep physics at 60 Hz with accumulator; render every animation frame with interpolation alpha passed to meshes.
- `Game` holds an ordered `systems: System[]` where `System { update(dt: number): void }`. Order: input, player, vehicles, traffic, pedestrians, police, missions, cameras, hud, minimap.
- Renderer: `WebGLRenderer({ antialias: true })`, `outputColorSpace = SRGBColorSpace`, `toneMapping = ACESFilmicToneMapping`, `shadowMap.enabled = true`, `shadowMap.type = PCFSoftShadowMap`. Pixel ratio capped at 1.5.

### 1.2 config.ts (initial values, tune freely, keep them here)
```ts
export const CFG = {
  city: { blocksX: 12, blocksZ: 12, blockSize: 60, roadWidth: 16, sidewalkWidth: 3, laneWidth: 3.5 },
  vehicle: {
    sedan:  { accel: 12, brake: 25, maxSpeed: 40, reverseMax: 10, steerMax: 0.55, grip: 8,  mass: 1 },
    sports: { accel: 18, brake: 28, maxSpeed: 58, reverseMax: 10, steerMax: 0.6,  grip: 10, mass: 0.9 },
    pickup: { accel: 10, brake: 22, maxSpeed: 36, reverseMax: 10, steerMax: 0.5,  grip: 7,  mass: 1.3 },
    police: { accel: 16, brake: 28, maxSpeed: 52, reverseMax: 10, steerMax: 0.6,  grip: 9,  mass: 1.1 },
  },
  player: { walkSpeed: 4, runSpeed: 8, enterRadius: 3.5, health: 100 },
  traffic: { count: 40, cruiseSpeed: 14, followGap: 8, intersectionPause: 1.2 },
  peds: { count: 80, walkSpeed: 1.4, fleeSpeed: 5, fleeRadius: 10 },
  police: { maxStars: 5, decaySeconds: 15, bustSeconds: 3, spawnPerStar: [0, 1, 2, 3, 4, 5] },
  camera: { chaseDist: 8, chaseHeight: 3.2, fovBase: 60, fovAtMaxSpeed: 78, lag: 6 },
  colors: { skyTop: 0x5b3fa0, skyHorizon: 0xffa66b, fog: 0xf5b592, sun: 0xffd9a0, water: 0x2ec4b6 },
};
```

### 1.3 types.ts (contracts)
```ts
export type Vec2 = { x: number; z: number };
export type Zone = 'downtown' | 'midtown' | 'residential' | 'beach';
export interface AABB { minX: number; minZ: number; maxX: number; maxZ: number }
export interface Block { ix: number; iz: number; zone: Zone; bounds: AABB; buildings: BuildingDef[] }
export interface BuildingDef { bounds: AABB; height: number; colorIdx: number; hasNeon: boolean }
export interface RoadNode { id: number; pos: Vec2 }
export interface Lane { id: number; from: number; to: number; offset: number; points: Vec2[]; length: number }
export interface RoadGraph { nodes: RoadNode[]; lanes: Lane[]; nearestLane(p: Vec2): { lane: Lane; t: number }; path(fromLane: number, toLane: number): Lane[] }
export interface CityData { blocks: Block[]; roads: RoadGraph; colliders: AABB[]; spawns: { player: Vec2; policeStation: Vec2; garages: Vec2[]; missions: Vec2[] }; beachEdge: 'north' | 'south' | 'east' | 'west' }
export type VehicleKind = 'sedan' | 'sports' | 'pickup' | 'police';
export interface VehicleState { pos: Vec2; y: number; heading: number; speed: number; steer: number; health: number; kind: VehicleKind; occupied: boolean; wrecked: boolean }
export interface System { update(dt: number): void }
export interface GameEvents { on(evt: EventName, fn: (payload?: unknown) => void): void; emit(evt: EventName, payload?: unknown): void }
export type EventName = 'pedHit' | 'vehicleHit' | 'policeHit' | 'enteredVehicle' | 'exitedVehicle' | 'wantedChanged' | 'busted' | 'wrecked' | 'missionStart' | 'missionPassed' | 'missionFailed' | 'cashChanged';
```

---

## 2. Phase 0: Scaffold (Opus 5, 30 min)

**Deliverables**
- Repo initialised with the layout above, all files present as stubs that compile.
- `types.ts` and `config.ts` exactly as in 1.2 and 1.3.
- `game.ts` fixed-timestep loop rendering a 200x200 m flat ground plane, sky gradient, directional sun with shadows, fog. Ground colour `0xd9c9a3` (sand). Fog density matched so buildings 300 m away fade into the horizon colour.
- `input.ts`: WASD/arrows, Space (handbrake / jump), Shift (sprint), E (enter/exit), C (cycle camera), H (toggle HUD), R (respawn), K (showcase), Esc (pause). Expose `isDown(key)` and `justPressed(key)`.
- `rng.ts` seeded, seed from `?seed=`.
- `smoke/smoke.spec.ts` and `pnpm smoke` working, writing `screens/phase0-*.png`.
- `README.md` with the three commands and the key map.

**Acceptance**
- `pnpm build` clean, `pnpm smoke` passes, screenshot shows sky gradient, lit ground, and a visible shadow from a placeholder box.

---

## 3. Phase 1: City generation (Opus 5, 90 min)

**Goal:** a 12x12 block city that reads as a sunny coastal city from the air and from the street.

**Layout**
- Grid of `blocksX * blocksZ` blocks, each `blockSize` square, separated by roads of `roadWidth`. World origin at the city centre. Roads are axis-aligned only.
- Zones by distance from centre and from the beach edge: inner 4x4 = downtown, next ring = midtown, outer ring = residential, the full row of blocks along `beachEdge` = beach (sand, palms, a boardwalk, low buildings, water beyond).
- 2 to 3 random blocks become parks (grass colour, trees, no buildings, walkable).

**Buildings (per block)**
- Downtown: 1 to 3 towers per block, footprint 60 to 90% of block, height 40 to 120 m, with 1 or 2 setbacks (stacked boxes shrinking by 15 to 25% each step). 30% get a rooftop box (plant room) and an antenna.
- Midtown: 3 to 5 buildings per block, height 12 to 35 m.
- Residential: 4 to 8 small buildings per block, height 4 to 10 m, pitched-roof variant (box + triangular prism) for 50%.
- Beach: 1 to 3 low pastel buildings, height 6 to 14 m.
- Always leave a 1.5 m gap between a building's footprint and the sidewalk so the player can walk around.
- Colours: palette of 8 pastels (mint, peach, coral, sky, lilac, cream, teal, white) chosen per building. Downtown towers use a 5-colour cooler palette with glass-blue window texture.
- Window texture: canvas 256x256, grid of lit/unlit rectangles, tiled by building height. Use `MeshStandardMaterial` with `map` and low `roughness` on towers.
- Neon signs: on 25% of downtown and midtown street-facing faces, a thin emissive plane with an invented word drawn on canvas (word list: "Zephyr", "Lumo", "Cabana", "Nightfall", "Mirage", "Tidewater", "Solstice", "Palma", "Verano", "Sundial"). Emissive intensity 2.

**Roads and sidewalks**
- Road surface: one large plane per road segment, texture with asphalt noise, a dashed yellow centre line and white lane dividers (2 lanes each direction). Crosswalk stripes at intersections.
- Sidewalks: raised 0.15 m, light grey, with a subtle tile texture, running the full block perimeter.
- Streetlights every 20 m on sidewalks, traffic light poles at every intersection (four, one per corner), benches and bins in residential and beach zones. All via `InstancedMesh`.
- Palms: trunk (tapered cylinder, slight lean) + 6 to 8 leaf planes arranged radially. Beach zone: dense (every 6 m along the boardwalk). Other zones: 2 to 6 per block edge.

**Water and sky**
- Water plane beyond the beach edge, 400 m deep, custom `ShaderMaterial` with two layered sine waves on vertex Y and a fresnel-ish tint. Cheap. Must not tank fps.
- Sky: inverted sphere with vertex-colour gradient `skyTop` at zenith to `skyHorizon` at the horizon. Sun low (elevation 18 degrees) from the beach side so shadows are long across the streets. This is the signature look; get it right.

**RoadGraph**
- Node at every intersection. Two lanes per direction per road segment, offset `laneWidth * 0.5` and `laneWidth * 1.5` from the centreline, right-hand traffic. Each lane is a directed polyline. At intersections, connect each incoming lane to straight, left, and right outgoing lanes with short curved connector lanes (quadratic Bezier, 6 points).
- `nearestLane(p)` via a spatial hash (cell 20 m). `path(a, b)` via A* on lane ids weighted by length.
- `colliders` = every building footprint AABB plus streetlight/traffic-light pole AABBs (0.3 m square).
- `spawns.player` on the beach boardwalk facing the city. `spawns.policeStation` a marked midtown building with a blue-stripe emissive band. `garages` = 4 sidewalk positions spread across zones with a parked car each. `missions` = 3 positions (one downtown, one residential, one beach).

**Acceptance**
- `pnpm smoke` with `?cam=drone` shows the whole city, zones visibly distinct, water visible, no z-fighting on roads.
- `pnpm smoke` with `?cam=street` at the player spawn shows a palm-lined boardwalk with towers behind.
- Draw calls under 150 for the world alone (log `renderer.info.render.calls` in dev).
- Generation deterministic for a given seed. Generation time under 500 ms.

---

## 4. Phase 2: Vehicle physics and chase camera (Opus 5, 90 min)

**Goal:** driving feels fast, grippy, slightly drifty, and the camera sells speed. Develop on the flat plane from Phase 0 with a few placeholder AABB boxes, then integrate with Phase 1 colliders when both merge.

**Arcade model (per fixed step)**
```
input: throttle [-1, 1], steerInput [-1, 1], handbrake bool
targetSteer = steerInput * steerMax * steerFalloff(speed)      // falloff: 1 at 0 m/s, 0.35 at maxSpeed
steer += (targetSteer - steer) * min(1, dt * 10)
if throttle > 0: speed += accel * throttle * dt (capped at maxSpeed)
if throttle < 0 and speed > 0.5: speed -= brake * dt
if throttle < 0 and speed <= 0.5: speed = max(-reverseMax, speed + accel * throttle * dt)
if throttle == 0: speed -= sign(speed) * min(|speed|, 4 * dt)   // rolling drag
speed -= speed * 0.02 * |speed| * dt                            // aero drag
turnRate = (speed / wheelbase) * tan(steer), wheelbase = 2.8
heading += turnRate * dt
velocity = forward(heading) * speed
```
- **Drift / lateral slip:** maintain a `slipVel` vector. Each step, `lateral = velocity projected onto right(heading)`. Grip pulls lateral to zero at rate `grip` (or `grip * 0.25` while handbrake is held or when `|turnRate| * speed > 18`). Position integrates `velocity + slipVel`. This gives a satisfying slide on hard turns and a handbrake turn.
- **Visuals:** body yaw = heading; add cosmetic roll = `-lateralAccel * 0.02` rad and pitch = `-longAccel * 0.01` rad, both damped. Wheels: 4 cylinders, rotate on axle by `speed * dt / wheelRadius`, front wheels yaw by `steer`.
- **Collisions:** vehicle is an OBB (length 4.4, width 2.0). Test against world `colliders` in a 30 m radius each step (spatial hash from Phase 1). Resolve: push out along minimum penetration axis, reflect velocity component along the collision normal with restitution 0.3, apply damage `= impactSpeed * 2` health. Vehicle vs vehicle: circles of radius 2.2 with mass-weighted separation and velocity exchange. Emit `vehicleHit` with impact speed.
- **Health:** 100 down to 0. Below 40: grey smoke particles from the bonnet (sprite points, 20 max). At 0: `wrecked = true`, black smoke, car stops accepting input, emit `wrecked`.

**Meshes (vehicleMesh.ts)**
- Each kind is a group of boxes: chassis lower box, cabin box (set back and narrower), 4 wheel cylinders (dark grey, with a lighter hub disc), 2 headlight emissive boxes (front), 2 tail light emissive boxes (red). Sports: lower, longer cabin, rear spoiler. Pickup: short cabin, open tray. Police: white body, black bonnet and doors, a roof light bar with alternating red/blue emissive boxes that flash at 4 Hz when active.
- Body colours: 10 saturated colours plus black, white, silver.

**Chase camera (cameras.ts, chase mode only in this phase)**
- Target position = vehicle pos + back `chaseDist` + up `chaseHeight`, in the direction of the vehicle's velocity heading (not body heading) when speed > 3, so drifting shows the car sliding across the frame.
- Camera position lerps toward the target at rate `lag`. Look-at = vehicle pos + forward 2 m + up 1 m.
- FOV interpolates `fovBase` to `fovAtMaxSpeed` by `speed / maxSpeed`.
- Camera raycast against colliders: if a building is between camera and car, pull the camera forward to the hit point minus 0.5 m.
- Small screen shake on `vehicleHit` proportional to impact speed, decaying over 0.3 s.

**Acceptance**
- Smoke test drives forward for 3 s via injected input and asserts speed > 20 and position moved.
- Manual: a handbrake turn at 25 m/s rotates the car ~90 degrees with visible slide. Hitting a wall at 30 m/s stops the car, shakes the camera, and drops health. 60 fps holds.

---

## 5. Phase 3: On-foot player and enter/exit (Sonnet 5, 60 min)

- **Controller:** capsule (radius 0.4, height 1.8), moves in camera-relative direction, `walkSpeed`, `runSpeed` with Shift, small jump with Space (1.2 m, simple gravity). Collides with `colliders` and vehicle circles by push-out. Can walk on sidewalks (step up 0.15 m automatically) and roads.
- **Mesh (playerMesh.ts):** blocky humanoid: head box, torso box, two arm boxes, two leg boxes, pivoted at shoulders and hips. Procedural walk: legs and arms swing with `sin(t * stride)` where `stride` scales with speed; idle has a subtle breathing scale on the torso. Outfit colours: teal shirt, white shorts, sun hat.
- **Enter/exit:** when on foot and any vehicle with `wrecked = false` is within `enterRadius`, HUD shows "E: enter vehicle". On E: player mesh hides, `vehicle.occupied = true`, input routes to the vehicle, camera switches to chase, emit `enteredVehicle`. If the vehicle is a traffic car, its AI driver is ejected: the ped model appears beside the car and flees (Phase 4 hooks this; until then just remove the AI). On E in a vehicle: vehicle decelerates naturally, player appears on the left side 1.5 m out, camera switches to on-foot third-person, emit `exitedVehicle`.
- **On-foot camera:** third-person over-shoulder, distance 4, height 2, same collision pull-in as chase cam. Mouse look is optional; default is that camera heading follows movement heading with lag. Keep it simple.
- **Health:** player health 100. Being hit by a vehicle at speed s costs `s * 3`. At 0: WRECKED screen (Phase 7 draws it; until then `console.log`). Respawn at `spawns.policeStation` with a fresh sedan nearby on R.

**Acceptance**
- Spawn on foot at the boardwalk, walk to the parked garage car, press E, drive away, press E, walk off. Smoke screenshot of the on-foot view with the humanoid visible.

---

## 6. Phase 4: Traffic and pedestrians (Sonnet 5, 60 min)

**Traffic (traffic.ts)**
- `traffic.count` AI vehicles spawned on random lanes at least 60 m from the player, evenly across kinds (no police). Each has a target lane path of 6 lanes ahead chosen randomly at each intersection.
- Follow the lane polyline with a look-ahead point 6 m ahead (pure pursuit) feeding `steerInput`. Throttle toward `cruiseSpeed`. Brake to zero if any vehicle (AI or player) is within `followGap` ahead in a 30-degree cone. Pause `intersectionPause` seconds when arriving at an intersection node if another vehicle is inside the intersection box; otherwise proceed.
- Recycle: if further than 250 m from the player, despawn and respawn near the player's current road, out of view.
- Traffic vehicles use the same `Vehicle` class and physics, so the player can crash into them and steal them. Honk (audio hook) when the player is stopped in front of them for > 2 s.

**Pedestrians (pedestrians.ts)**
- `peds.count` instances of a simplified humanoid (`InstancedMesh` per limb group, or one merged low-poly figure with 4 shape variants). Walk cycles as in Phase 3 but computed per instance via a time offset.
- Wander along sidewalk polylines (derived from block perimeters, inset 1.5 m), pick a random direction at corners, cross at crosswalks with 10% probability when no car is within 15 m.
- **Flee:** if any vehicle with speed > 6 comes within `fleeRadius`, run directly away at `fleeSpeed` for 3 s, arms up, then resume wandering. Peds near a police chase also flee.
- **Hit:** vehicle OBB intersects a ped: ped tumbles (tween: rise 1 m, spin 360 degrees around a random axis, land 3 m away, lie flat 2 s, get up and flee). Emit `pedHit`. No blood, no particles.
- Recycle out of range like traffic.

**Acceptance**
- Stand at a downtown intersection: traffic flows in both directions, stops for each other, and does not pile up for 60 s. Drive at a crowd: they scatter. 60 fps holds with all counts at default.

---

## 7. Phase 5: Police and wanted system (Opus 5, 60 min)

**Wanted level (0 to 5 stars)**
- Heat accumulator `heat` (0 to 100 per star). `pedHit` +60, `policeHit` +100, `vehicleHit` with impact > 10 while a police car can see the player +30, being within 30 m of a police car while stars >= 1 +5 per second.
- Stars = `floor(totalHeat / 100)` capped at `maxStars`. Emit `wantedChanged` on change.
- **Decay:** if no police car has line of sight to the player (raycast against colliders, 120 m range) for `decaySeconds`, drop one star and reset the timer. At 0 stars, all police despawn or return to patrol.

**Police units**
- Active unit count = `spawnPerStar[stars]`. Spawn on a lane 80 to 120 m from the player, preferably behind a building (not visible). Light bar and siren on.
- **Pursuit AI:** if path distance to the player's nearest lane is > 40 m, drive the lane graph via `path()` with the same pure pursuit as traffic but at `police.maxSpeed` and ignoring intersection pauses. If closer than 40 m and line of sight, leave the lanes and steer directly at the player's predicted position (pos + velocity * 0.6). Ram. Reverse and retry if stuck (speed < 1 for 2 s while throttle > 0).
- **Bust:** if a police car is within 5 m of the player and the player's speed is < 2 m/s (in a car or on foot) for `bustSeconds`, emit `busted`. BUSTED screen, respawn at `policeStation`, stars 0, cash minus 10%.
- **Roadblocks (3+ stars):** every 20 s, place two police cars nose-to-nose across the road on the player's current lane 100 m ahead, with 6 orange cones (small cones as instanced props). They join the pursuit when the player passes.
- **Helicopter (5 stars):** one helicopter mesh (fuselage box, tail box, 4-blade rotor spinning at 20 rad/s, tail rotor) hovers at 35 m altitude, orbits the player at 25 m radius, and points a `SpotLight` (angle 0.25, intensity 40) at the player. Siren-like whump sound. It never lands or attacks; it exists to look great on camera. Despawns when stars fall below 5.
- **Patrol:** at 0 stars, 2 police cars drive the lane graph like traffic. If the player commits a crime within their sight, +1 star immediately.

**Acceptance**
- Ram three pedestrians: stars rise, a police car arrives within 10 s, pursues, and rams. Hide behind buildings for 15 s: a star drops. `?stars=5` URL param starts at 5 stars: helicopter present with spotlight, roadblocks appear. Stop the car with police adjacent: BUSTED within 3 s.

---

## 8. Phase 6: Missions (Sonnet 5, 60 min)

- **Markers (markers.ts):** at each `spawns.missions` position, a 3 m tall translucent yellow cylinder with a slow pulse and a floating icon above it (letter on a canvas sprite). Checkpoints are the same at 2 m, cyan. Walking or driving into a marker triggers it.
- **State machine:** `idle -> briefing (3 s HUD text) -> active -> passed | failed -> idle`. Only one mission active. `missionStart`, `missionPassed`, `missionFailed` events. Cash reward on pass; HUD counter. Missions reset and can be replayed.
- **Mission A, "Courier":** at the beach marker. Pick up a package (crate prop appears in the tray/boot) and deliver it to a downtown marker within 90 s. Crashing at > 15 m/s "damages the package": time penalty of 10 s each. Reward 500.
- **Mission B, "Coast Run":** at the residential marker. Checkpoint race: 8 cyan checkpoints along a route that goes through midtown, down the beach boardwalk road, and back. Timer on HUD. Under 75 s = reward 1000, otherwise 400.
- **Mission C, "Heat":** at the downtown marker. Spawn a sports car beside the marker. Objective: reach 3 stars, then lose the police completely. Reward 1500. This is the mission to film: it guarantees a chase.
- HUD text is short and punchy, e.g. "Deliver the package. 1:30." Use the invented brand names from Phase 1 for flavour ("Drop it at Lumo Records").

**Acceptance**
- Each mission can be started, passed, and failed, with the correct screens and cash changes. Markers visible from 150 m.

---

## 9. Phase 7: HUD, minimap, screens, audio (Sonnet 5, 45 min)

- **HUD (DOM overlay, hud.ts):** top right: 5 star outlines, filled ones bright; cash "$12,340" with a count-up animation on change; bottom right: speed in km/h in a large numeral, health bar (player or current vehicle) under it; bottom centre: mission text and timer; top left: minimap. Font: system sans, heavy weight, slight letter spacing, white with a dark drop shadow. No HUD element may cover the centre 60% of the screen. H toggles the whole overlay.
- **Minimap (minimap.ts):** 220x220 canvas, bottom-left, 25 m per 22 px, rotated so player heading is up, roads drawn from `RoadGraph` in light grey on a dark translucent disc, buildings as darker blocks, player as a white arrow, police as blue dots, mission markers as yellow dots, active checkpoint as a cyan dot with a bearing indicator at the disc edge if off-map.
- **Screens (screens.ts):** title splash on boot ("SUNBELT CITY" in large letters over a slow drone shot, "press any key"), and full-screen overlays for WRECKED (red-tinted, 2.5 s, then respawn), BUSTED (blue-tinted, 2.5 s), MISSION PASSED (gold, shows reward, 2.5 s). Fade in/out 0.3 s.
- **Audio (audio.ts, Web Audio, all synthesized):** engine = sawtooth + sub sine, pitch mapped from `speed / maxSpeed` to 60 to 220 Hz with a lowpass that opens with throttle; siren = two-tone square wave 700/900 Hz alternating at 1.5 Hz with slight pitch drift, spatialised by distance (gain falloff); horn = 350 Hz square with detune, 0.4 s; collision thud = filtered noise burst with amplitude from impact speed; UI blip for mission events. Master gain 0.6. Audio context resumes on the first key press (browser requirement). Optional if time allows: a 4-bar synth loop (two chords, slow arpeggio, 90 bpm) as ambient music, generated with oscillators and a delay node.

**Acceptance**
- HUD readable in the smoke screenshot; minimap tracks the player; all three screens display and dismiss; engine pitch rises with speed; siren audible when police are active.

---

## 10. Phase 8: Capture mode, showcase, polish (Sonnet 5, 45 min)

This phase exists for the Instagram video. Do not skip it.

- **Camera modes (C cycles):** chase (default), hood (fixed on bonnet, wide FOV 85), orbit (slow 360 around the vehicle at 12 m, height 4, 30 s per rotation), drone (150 m altitude, looks down at 60 degrees, follows the player at lag 1.5), free-fly (WASD + QE, mouse look, for b-roll). URL param `?cam=` selects the initial mode.
- **Showcase script (K, showcase.ts):** a 45 s scripted sequence for a single continuous take: fade in from title, drone shot descending over downtown (8 s), cut to chase cam on a sports car spawned at the beach boardwalk, AI drives it (uses the traffic controller) fast through midtown (10 s), a scripted ped-scatter at a crosswalk, stars set to 5 at 25 s so the helicopter and roadblocks appear (15 s of chase with orbit cam), then free-fly hands control back. Each cut also logs the timestamp so Joe can find them in the recording.
- **URL params:** `?seed=`, `?cam=`, `?stars=`, `?car=sports`, `?mission=C`, `?nohud=1`, `?time=` (see below). These let Joe jump straight to a filmable state.
- **Polish list (in priority order, stop when time runs out):**
  1. Tyre marks: a fading line strip laid down when slip is high or under handbrake.
  2. Speed lines / slight motion blur substitute: vignette that darkens with speed.
  3. `?time=dusk` variant: sun lower, sky deeper violet, windows and neon at full emissive, streetlights on with point lights near the player only (max 8). This is the money shot for the reel.
  4. Rooftop water towers and AC units on 40% of midtown buildings.
  5. Parked cars along residential kerbs (static instanced meshes, not `Vehicle` objects).
  6. Birds: 20 small V-shaped sprites circling over the beach.
  7. Sparks on hard collisions (10 orange points, 0.4 s).
- **Final checks:** README documents every key and URL param. `pnpm build` output under 2 MB. Runs from `pnpm preview` with no console errors for a 5 minute free-roam.

**Acceptance**
- K plays the full showcase without a hitch on three consecutive runs. `?time=dusk&cam=drone` screenshot looks like a poster.

---

## 11. Cut list (when behind schedule, cut from the top)

1. Polish items 4 to 7
2. Ambient music loop
3. Mission B (Coast Run)
4. Roadblocks
5. Pedestrian crossing behaviour (keep wander and flee)
6. Hood and free-fly cameras (keep chase, orbit, drone)
7. Mission A (keep Mission C, it films best)
8. Pitched-roof residential variant
9. Water shader animation (keep a flat tinted plane)

Never cut: the sky and lighting rig, drifting, the helicopter at 5 stars, the showcase script, the minimap. These are what make the reel.

---

## 12. Human checkpoints (for Joe, film these)

| After | What to record |
|---|---|
| Phase 1 | Drone flyover of the empty city, then a street-level walk on the boardwalk |
| Phase 2 | First drive, one handbrake turn, one wall crash |
| Phase 4 | Traffic at a downtown intersection, then driving into a crowd |
| Phase 5 | `?stars=5` with helicopter and roadblocks |
| Phase 8 | The K showcase at `?time=dusk`, one continuous take |

Suggested day timeline: Phase 0 done by 8:30, Phases 1 and 2 in parallel by 10:30, Phase 3 by 11:30, Phase 4 by 12:30, Phase 5 by 13:30, Phase 6 by 14:30, Phase 7 by 15:30, Phase 8 by 16:30, filming and recut 16:30 to 18:00.