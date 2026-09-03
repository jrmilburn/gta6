# Sunbelt City

An original open-world driving game that runs in the browser: a low coastal sun,
a grid city, traffic, pedestrians and a car you can steal.

The world is still generated procedurally at boot — the layout, the buildings,
the roads and every sound. What it is *dressed* in comes from a small bundle in
`public/assets/` (11.6 MB): a skinned character with four animations, two cars,
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

```
public/assets/raw/
  main-character.fbx        # a Mixamo export "with skin"
  Strut Walking.fbx         # animations; the file name becomes the clip name
  Slow Run.fbx              #   walk / jog / run / dance / shoot are recognised
  Fast Run.fbx
  Gangnam Style.fbx
  sedan/                    # one directory per vehicle kind, with its textures
  sportscar/
```

## Commands

```
pnpm dev       # dev server on http://localhost:5173
pnpm build     # typecheck + production build to dist/
pnpm smoke     # Playwright smoke suite; screenshots land in screens/

pnpm assets:fetch       # re-download the CC0 world assets from source
pnpm assets:character   # convert raw/*.fbx to a skinned hero and its clips
pnpm assets:cars        # convert raw/<kind>/*.fbx to game-ready car bodies
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
| W A S D / Arrows | Drive / walk |
| Space | Handbrake (in car) / jump (on foot) |
| Shift | Sprint |
| E | Enter / exit vehicle |
| C | Cycle camera (chase, hood, orbit, drone, free-fly) |
| H | Toggle HUD |
| R | Respawn |
| G | Dance for 8 seconds — orbit camera, a beat, and nearby pedestrians join in |
| K | Play the showcase sequence |
| Esc | Pause |

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
