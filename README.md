# Sunbelt City

An original open-world driving game that runs in the browser. Everything on screen —
every mesh, texture and sound — is generated procedurally at boot. No external assets,
no network requests at runtime.

## Commands

```
pnpm dev       # dev server on http://localhost:5173
pnpm build     # typecheck + production build to dist/
pnpm smoke     # Playwright smoke test; screenshots land in screens/
```

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
| `?time=dusk` | Dusk lighting variant |
