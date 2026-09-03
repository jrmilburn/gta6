# Sunbelt City

An original open-world driving game that runs in the browser: a low coastal sun,
a grid city, traffic, pedestrians and a car you can steal.

The world is still generated procedurally at boot — the layout, the buildings,
the roads and every sound. What it is *dressed* in comes from a small bundle in
`public/assets/` (15 MB): a skinned character with twenty-one animations, two cars,
two Poly Haven HDRIs for the lighting, Kenney kits for the vegetation, Poly
Haven street furniture, and ambientCG PBR textures for the walls and the ground.
Every one of those has a working procedural fallback, so the game runs, and
plays identically, with `public/assets/` deleted.

**Licences differ.** The world assets are CC0. The character and the two cars
were supplied and are not — see [ASSETS.md](ASSETS.md) for the full provenance,
the reasoning behind each choice, and one open question about redistributing the
character.

## Source art

Drop source files in `public/assets/raw/` and run the converters. The folder is
gitignored and excluded from the build; only the converted output ships.

For animation specifically, [ANIMATIONS.md](ANIMATIONS.md) lists what the clip
set is still missing, ranked by how visible the gap is, with the naming the
converter expects.

```
public/assets/raw/
  main-character.fbx        # a Mixamo export "with skin"
  Jump.fbx                  # the file name, or its folder, decides the role
  Gangnam Style.fbx
  Shooting.fbx
  running/                  # walk, jog, run, goofy, and the diagonals
  punches/                  # any number; one is picked at random per swing
  fall-over/                # knockdowns, likewise
  gun/                      # the pistol stance
  gun/movement/while aimed/  #   and how to move while holding it
  sedan/                    # one directory per vehicle kind, with its textures
  sportscar/
```

The converter recognises `walk`, `jog`, `run`, `goofy`, `diagonal`, `backward`,
`strafe`, `jump`, `punch`, `fall`, `pistol`, `shoot`, `idle` and `dance` in
either the file name or the path. Anything it does not recognise is still
converted and loaded, just unused. A clip that travels has its direction
**measured** from its own root motion rather than guessed from its name.

## Commands

```
pnpm dev       # dev server on http://localhost:5173
pnpm build     # typecheck + production build to dist/
pnpm smoke     # Playwright smoke suite; screenshots land in screens/

pnpm assets:fetch       # re-download the CC0 world assets from source
pnpm assets:character   # convert raw/*.fbx to a skinned hero and its clips
pnpm assets:cars        # convert raw/<kind>/*.fbx to game-ready car bodies
pnpm assets:props       # convert raw/{palm,streetlight,traffic-light}/ to instanced props
node scripts/fetch-props.mjs   # Poly Haven street furniture
```

Assets are committed, so a fresh clone needs nothing but `pnpm install`.

## Tuning

Every number that decides how the game *feels* — input smoothing, on-foot
acceleration and turn rate, gait blending, vehicle suspension, and every camera
smooth-time — lives in one place: `CFG.feel` in
[`src/config.ts`](src/config.ts). Everything about the skinned character's
animation — which clip plays at which speed, how fast clips crossfade, the
pedestrian level-of-detail distances, the dance — is `CFG.anim` alongside it.

**Stride matching is measured, not tuned.** `scripts/convert-character.mjs`
reads how far each clip's hips actually travel and writes it to
`public/assets/character/manifest.json`; the rig then plays every clip at
`speed / authoredSpeed`, so the feet plant. `smoke/character.spec.ts` asserts
the result: at 4 m/s and at 8 m/s the ground speed the feet describe matches the
body to within 0.1%.

## Keys

| Key | Action |
|---|---|
| Mouse | Look. Click the canvas to take the pointer lock; Esc releases it |
| E | Enter / exit a vehicle — a prompt appears when one is in reach |
| W A S D / Arrows | Drive / walk, relative to where you are looking |
| Space | Handbrake (in car) / jump (on foot) |
| Shift | Sprint |
| Left click | Punch (unarmed) / fire (pistol drawn, held to keep firing) |
| Right click | Aim down the pistol — over the shoulder, narrower lens |
| H | Draw / holster the pistol |
| P | Goofy run — swaps the jog clip for a sillier one |
| G | Dance for 8 seconds — orbit camera, a beat, and nearby pedestrians join in |
| C | Cycle camera (chase, hood, orbit, drone, free-fly) |
| R | Respawn |
| K | Play the showcase sequence |
| ` | Toggle HUD |
| Esc | Pause (and release the pointer lock) |

Punching or shooting a civilian knocks them down. They lie still for a minute,
then get back up. There is no blood, no gore and nothing dies.

**Police.** Two cruisers patrol at zero stars, and a crime they witness --
knocking somebody down, running them over, a shot, a hard crash -- lights the
first star. Heat then buys units in pursuit (`CFG.police.spawnPerStar`): they
route across the lane graph while you are far and come straight at you once
they can see you, siren on. Stand still beside one for three seconds, on foot
or boxed in, and you are BUSTED. At three stars roadblocks go down ahead of a
driving player and officers step out to shoot at one on foot; at five the
helicopter comes. Stay out of every unit's sight for `decaySeconds` and a star
drops. Nobody dies: the officers' fire wears your health down to a WRECKED
respawn at the station, the same as being run over.

**The pier.** Off the boardwalk at the spawn. Walk out to the ferris wheel and
press E under it to ride once round; E at a bench sits, E at the rail leans,
and E at the end rail is a dive, after which you swim back to the beach. A car
fits down the middle, and the bollards at the entrance are there to be knocked
over.

**Traffic lights** cycle at every intersection. Traffic stops on red;
pedestrians wait at the kerb for the walk phase, walk at their own pace, step
round each other and round you, stop to look at things, and never turn on the
spot. Nobody is recycled while the camera can see them.

**Cutscenes.** A few seconds of held camera on a bust, a wreck, three and five
stars, a roadblock, the first ride on the wheel, the dive and the first car.
Any movement key skips one after the first second.

## URL parameters

| Param | Effect |
|---|---|
| `?seed=1337` | World generation seed (default 1337) |
| `?cam=drone` | Initial camera mode |
| `?stars=5` | Start at a wanted level |
| `?car=sports` | Start in a vehicle |
| `?mission=C` | Auto-start a mission |
| `?nohud=1` | Hide the HUD |
| `?time=dusk` | Dusk lighting variant (swaps the HDRI, the sun and the palette) |
| `?post=0` | Disable ambient occlusion and bloom — the framerate fallback |
| `?assets=0` | Skip the asset load and run fully procedural, to exercise the fallbacks |
| `?peds=12&traffic=4` | Scale the crowd and the traffic. For measuring against a stated population, and for tests that need the simulation to outrun a software rasteriser |
| `?shadows=0` | Drop the shadow pass. A throughput switch for tests, never a gameplay one |
| `?signals=0` | Traffic lights keep cycling but stop controlling traffic and pedestrians |
| `?ticks=20` | Let one rendered frame simulate up to N fixed ticks. For the smoke suite on a software rasteriser, where a frame is most of a second; never for a player |
