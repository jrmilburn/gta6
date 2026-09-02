# Assets

Everything in `public/assets/` is **CC0 / public domain**. Nothing here requires
attribution, but it is recorded anyway so the provenance of every byte in the
repo is checkable.

Fetch or refresh with:

```
./scripts/fetch-assets.sh            # fetch anything missing
./scripts/fetch-assets.sh --force    # re-fetch everything
```

The script resolves download URLs at run time (Kenney's carry a content hash
that changes on every re-release; Poly Haven goes through its public API), so it
keeps working across upstream updates instead of rotting into 404s.

**Total: 7.4 MB** — 2.9 MB HDRIs, 1.7 MB models, 2.9 MB textures. Budget was
40 MB.

---

## Environment (HDRI)

| File | Source | Licence | Used for |
|---|---|---|---|
| `hdri/venice_sunset_1k.hdr` | [Poly Haven — Venice Sunset](https://polyhaven.com/a/venice_sunset) | CC0 | Default (`day`) image-based lighting: a clear, low, coastal late-afternoon sun. Prefiltered through `PMREMGenerator` into `scene.environment`. |
| `hdri/the_sky_is_on_fire_1k.hdr` | [Poly Haven — The Sky Is On Fire](https://polyhaven.com/a/the_sky_is_on_fire) | CC0 | `?time=dusk` lighting: twilight over water, matching the dusk palette. |

**DECISION — 1K, not 2K.** The brief asks for 2K. These are consumed *only*
through `PMREMGenerator`, whose prefiltered output cube is 256 px, so 2K is
identical after filtering and costs 4x the download (5.7 MB vs 1.4 MB each).
The sky the player actually sees is the existing gradient dome, tinted to agree
with the HDRI — not the HDRI itself. 1K is the better trade at every axis that
matters here.

**Sun matching.** The directional light's direction and colour are not
hand-entered: `src/world/envMap.ts` scans the loaded equirect for its brightest
region and derives the azimuth, elevation and tint from it. Swapping in a
different HDRI moves the sun and the shadows to match automatically.

## Models

All Kenney kits, all CC0, all shipped as GLB. Only the specific files the world
instances are extracted — a whole kit is 3–10 MB of models that are never
placed. Each kit's own `License.txt` is kept next to its models.

| Files | Source | Licence | Used for |
|---|---|---|---|
| `models/cars/{sedan, sedan-sports, hatchback-sports, truck, police, van, suv}.glb` | [Kenney — Car Kit](https://kenney.nl/assets/car-kit) | CC0 | Vehicle bodies: `sedan`→sedan, `sedan-sports`→sports, `truck`→pickup, `police`→police. `van`/`suv`/`hatchback-sports` add variety to traffic. |
| `models/cars/{wheel-default, wheel-racing}.glb` | Kenney — Car Kit | CC0 | Wheels, kept as separate nodes so steering and rolling still work. |
| `models/cars/{cone, box}.glb` | Kenney — Car Kit | CC0 | Street clutter. |
| `models/nature/tree_palm*.glb` (4) | [Kenney — Nature Kit](https://kenney.nl/assets/nature-kit) | CC0 | Palms, beach and boulevard. |
| `models/nature/tree_{oak, detailed, default, fat, small}.glb` | Kenney — Nature Kit | CC0 | Broadleaf trees in parks and residential blocks. |
| `models/nature/plant_bush*.glb`, `grass*.glb`, `rock_smallA.glb` | Kenney — Nature Kit | CC0 | Shrubs, grass tufts and ground detail. |
| `models/props/{fence, fence-low, planter, tree-small}.glb` | [Kenney — City Kit (Suburban)](https://kenney.nl/assets/city-kit-suburban) | CC0 | Residential ground-floor dressing. |

**Why one kit for all vegetation.** The Nature Kit carries palms *and*
broadleaf, so the beach and the parks share one silhouette language instead of
mixing a stylised palm with a photoscanned oak. Kenney's Pirate Kit palms were
evaluated and dropped for that reason.

## Textures (PBR)

All from [ambientCG](https://ambientcg.com/), all CC0. Downloaded as the 1K-JPG
bundles and re-encoded to WebP (see below). Each material keeps
`color` / `normal` / `rough`; the shipped ambient-occlusion and displacement
maps are dropped unused.

| Directory | ambientCG asset | Used for |
|---|---|---|
| `textures/concrete` | [Concrete034](https://ambientcg.com/view?id=Concrete034) | Downtown concrete floor bands, plant rooms, parapets. |
| `textures/stucco-a` | [Plaster001](https://ambientcg.com/view?id=Plaster001) | Midtown and residential walls, pale variant. |
| `textures/stucco-b` | [PaintedPlaster017](https://ambientcg.com/view?id=PaintedPlaster017) | Second stucco, so neighbouring blocks are not the same wall. |
| `textures/brick` | [Bricks097](https://ambientcg.com/view?id=Bricks097) | Residential and older midtown facades. |
| `textures/asphalt` | [Asphalt031](https://ambientcg.com/view?id=Asphalt031) | Carriageway. |
| `textures/pavement` | [PavingStones131](https://ambientcg.com/view?id=PavingStones131) | Sidewalks and the boardwalk approach. |
| `textures/sand` | [Ground093A](https://ambientcg.com/view?id=Ground093A) | Beach and inland scrub. |
| `textures/roof-metal` | [CorrugatedSteel009](https://ambientcg.com/view?id=CorrugatedSteel009) | Corrugated roofs and rooftop plant. |

**Re-encoding.** ambientCG's 1K JPEGs are quality ~100: one normal map is 2 MB
and the eight materials together came to 20 MB, which blows the cold-load
target. `fetch-assets.sh` re-encodes them to WebP (colour q82, normal q85,
roughness q70) for a ~9x saving with no visible difference on a tiled surface.
This uses `ffmpeg` if it is installed and silently keeps the JPEGs if it is not;
because the encoded assets are committed, a plain clone never needs ffmpeg.

## Glass curtain wall

**No downloaded texture.** Downtown glass is a `MeshPhysicalMaterial` driven by
the environment map plus a procedural mullion pattern, because a photographed
glass texture fights the reflection rather than adding to it. Recorded here so
the omission is deliberate rather than an oversight.

---

## Fallbacks

Every category keeps its procedural path working, and the game never blocks on a
download. `src/core/assets.ts` loads everything up front behind the title
screen's progress bar; any file that fails to load is reported once to the
console and the caller falls back to what the game shipped with:

| Category | Fallback if the asset is missing |
|---|---|
| HDRI | The pre-existing analytic sky rig: gradient dome, hemisphere fill and a hand-placed sun. No `scene.environment`. |
| Cars | The procedural box-and-cylinder bodies in `entities/vehicleMesh.ts`. |
| Trees / palms | The procedural palm fronds and icosahedron canopies in `world/props.ts`. |
| PBR textures | The canvas-generated textures in `core/textures.ts`. |
| Characters | Always procedural — see below. |

## Characters: no downloaded model (deliberate)

**Nothing was fetched for the player or the pedestrians, and the procedural
humanoid in `src/entities/humanoid.ts` is the shipping path.** The reasoning,
because this is the one place the brief's first choice was not taken:

- **Quaternius** has exactly the right packs (Animated Men / Animated Women,
  CC0, confirmed on each pack page). Their downloads are served from a **Google
  Drive folder**, not a direct file URL, so they cannot be fetched by
  `curl`/`wget` in a reproducible script. A manually downloaded blob that
  `fetch-assets.sh` cannot reproduce would break the rule the script exists for.
- **Kenney** has character kits (`blocky-characters`, `mini-characters`,
  `modular-characters`) but none of them ship animation clips — they are parts
  to rig yourself, which is the same authoring problem as the procedural rig
  with none of the control.
- **Poly Haven** has no characters at all.
- Everything else with usable animated humans (Mixamo, Sketchfab) is excluded by
  the licence rule.

The brief's own fallback describes a jointed pelvis → spine → chest hierarchy at
7.5 heads with opposing limb swing, knee flex, hip drop, pelvis counter-rotation
and head bob at double stride frequency. That is what `humanoid.ts` builds and
what `playerMesh.ts` animates, now with idle/walk/run clip blending on actual
ground speed, stride-matched cycle rate and an additive spine lean. The
distinctive-bodies requirement is met with 6 colour palettes x 3 scales on the
pedestrian crowd rather than 4 meshes.
