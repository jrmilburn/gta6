# Sunbelt City

An original open-world driving game that runs in the browser: a low coastal sun,
a grid city, traffic, pedestrians and a car you can steal.

The world is still generated procedurally at boot — the layout, the buildings,
the roads and every sound. What it is *dressed* in comes from a small bundle of
CC0 assets in `public/assets/` (7.4 MB): two Poly Haven HDRIs for the lighting,
Kenney kits for the cars and vegetation, and ambientCG PBR textures for the
walls and the ground. Every one of those has a working procedural fallback, so
the game runs, and plays identically, with `public/assets/` deleted.

See [ASSETS.md](ASSETS.md) for the full provenance and the reasoning behind each
choice.

## Commands

```
pnpm dev       # dev server on http://localhost:5173
pnpm build     # typecheck + production build to dist/
pnpm smoke     # Playwright smoke suite; screenshots land in screens/

./scripts/fetch-assets.sh   # re-download public/assets from source (CC0 only)
```

Assets are committed, so a fresh clone needs nothing but `pnpm install`.

## Tuning

Every number that decides how the game *feels* — input smoothing, on-foot
acceleration and turn rate, gait blending and stride length, vehicle suspension,
and every camera smooth-time — lives in one place: `CFG.feel` in
[`src/config.ts`](src/config.ts).

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
