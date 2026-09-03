# Assets

Every file in `public/assets/` is recorded here with its source, its licence and
what it is used for.

**Licences are not all the same, and that matters.** The world (HDRIs, models,
textures) is CC0 throughout. The character and the two cars were supplied by Joe
in `public/assets/raw/` and are **not** CC0 — see [Supplied
assets](#supplied-assets-character-and-cars) below, including one open question
about redistributing them from this repo.

Fetch or refresh the CC0 world assets with:

```
pnpm assets:fetch              # fetch anything missing
pnpm assets:fetch --force      # re-fetch everything
```

Convert whatever Joe has dropped into `public/assets/raw/`:

```
pnpm assets:character          # raw/*.fbx        -> assets/character/*.glb
pnpm assets:cars               # raw/<kind>/*.fbx -> assets/models/supplied/*.glb
pnpm assets:props              # raw/{palm,street-light,traffic-light}/ -> assets/models/supplied/*.glb
```

`fetch-assets.sh` resolves download URLs at run time (Kenney's carry a content
hash that changes on every re-release; Poly Haven goes through its public API),
so it keeps working across upstream updates instead of rotting into 404s.

**Total shipped: 15 MB** — 4.4 MB character (21 clips), 4.3 MB models (2.1 MB
supplied cars, 1.7 MB Kenney kits, 0.4 MB Poly Haven street props), 2.9 MB
HDRIs, 2.9 MB textures. Budget was 60 MB. `public/assets/raw/` is 340 MB of source files;
it is gitignored, excluded from the Vite build (see `vite.config.ts`) and never
shipped.

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
| `models/cars/{sedan, sedan-sports, hatchback-sports, truck, police, van, suv}.glb` | [Kenney — Car Kit](https://kenney.nl/assets/car-kit) | CC0 | Vehicle bodies for the kinds with no supplied model: `truck`→pickup, `police`→police. The rest stay loaded as traffic variety and as the fallback if a supplied car is missing. |
| `models/cars/{wheel-default, wheel-racing}.glb` | Kenney — Car Kit | CC0 | Wheels, kept as separate nodes so steering and rolling still work. |
| `models/cars/{cone, box}.glb` | Kenney — Car Kit | CC0 | Street clutter. |
| `models/nature/tree_palm*.glb` (4) | [Kenney — Nature Kit](https://kenney.nl/assets/nature-kit) | CC0 | Palms, beach and boulevard — now the **fallback** behind the supplied palm (see [Props](#props-palm-streetlight-and-traffic-light)). |
| `models/nature/tree_{oak, detailed, default, fat, small}.glb` | Kenney — Nature Kit | CC0 | Broadleaf trees in parks and residential blocks. |
| `models/nature/plant_bush*.glb`, `grass*.glb`, `rock_smallA.glb` | Kenney — Nature Kit | CC0 | Shrubs, grass tufts and ground detail. |
| `models/props/{fence, fence-low, planter, tree-small}.glb` | [Kenney — City Kit (Suburban)](https://kenney.nl/assets/city-kit-suburban) | CC0 | Residential ground-floor dressing. |
| `models/street/{bin, hydrant}.glb` | [Poly Haven — Metal Trash Can](https://polyhaven.com/a/metal_trash_can), [Fire Hydrant](https://polyhaven.com/a/fire_hydrant) | CC0 | Sidewalk furniture, replacing the procedural green cylinder. Two thirds of the small-prop spots get a bin, one third a hydrant. |

### Poly Haven street props

`scripts/fetch-props.mjs` fetches these through the public API, welds them down
and packs them into a GLB with WebP maps. Poly Haven ships models as a loose
`.gltf` plus a `.bin` plus JPEGs — 2-7 MB and three round trips per prop before
anything is placed; the two shipped come to 0.4 MB together.

Both needed a node filter. The trash can asset is *two* cans side by side, clean
and rusted, each split into body, lid and handles; only the clean one is wanted.

Three of the brief's props were fetched, looked at, and **not** taken:

- **Streetlight.** `street_lamp_01` is a 4.2 m alley lamp — a plain column with
  the head straight on top. The procedural streetlight it would replace is a
  road lamp with a cantilever arm reaching over the carriageway, which is the
  correct object for a boulevard. Swapping a right-shaped lamp for a
  wrong-shaped photoscan is a downgrade whatever it is made of.
- **Bench.** `modular_street_seating` is a flat pack of parts — legs,
  connectors, armrests, crossbars — laid out for you to assemble, and its one
  pre-made piece is a 62 m extruded run meant to be cut to length. Assembling
  street furniture from a kit is a modelling job, not a fetch.
- **Planter.** `planter_box_02` is foliage cards that do not weld down; the
  Kenney planter already in use is a tenth of the triangles.

Poly Haven has **no traffic light, bollard, cone, sign, rooftop AC unit or water
tank** at all. Those stay procedural.

**Why one kit for all vegetation.** The Nature Kit carries palms *and*
broadleaf, so the beach and the parks share one silhouette language instead of
mixing a stylised palm with a photoscanned oak. Kenney's Pirate Kit palms were
evaluated and dropped for that reason.

**Poly Haven vegetation was evaluated and not taken.** It has `island_tree_01..03`,
`jacaranda_tree`, `shrub_01..04`, `grass_medium_01/02` and `tree_small_02`, all
CC0 — but **no palm of any kind**, and the beach is what the brief puts first.
Dropping a photoscanned jacaranda beside a stylised Kenney palm on the same
street looks worse than either alone, and a scanned tree is 10–50k triangles
against Kenney's few hundred, instanced thousands of times. Recorded here so the
omission is a decision rather than an oversight.

## Textures (PBR)

All from [ambientCG](https://ambientcg.com/), all CC0 — rule 7b's first
substitution for textures. Downloaded as the 1K-JPG bundles and re-encoded to
WebP (see below). Each material keeps `color` / `normal` / `rough`; the shipped
ambient-occlusion and displacement maps are dropped unused.

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

## Supplied assets (character and cars)

Joe placed these in `public/assets/raw/`. The build scripts convert them; the
sources stay out of the repo.

### Licence status

| Asset | Origin | Licence | Note |
|---|---|---|---|
| `character/*` | Mixamo (Adobe), character **Ch06** plus four animations | Adobe's Mixamo terms: royalty-free use, including commercially, by the account holder | **Not CC0, and not clearly redistributable as a standalone asset.** See the flag below. |
| `models/supplied/{sedan,sports}.glb` | Meshy AI generations, supplied with their PBR maps | Depends on Joe's Meshy plan — free-tier generations are CC BY 4.0, paid tiers grant broader rights | Needs confirming before the repo goes public. |
| `models/supplied/{palm,palm-far}.glb` | `raw/tropical-palm-tree/` (Sketchfab-style drop: `source/plalm_3.fbx` + four JPG maps), supplied by Joe | **Unknown** — no licence file came with it | Needs the Sketchfab page's licence recorded here before the repo goes public. |
| `models/supplied/streetlight{,-double}.glb` | `raw/psx-style-street-light-kit/` (`StreetLight.zip`), supplied by Joe | **Unknown** — no licence file in the zip | Same. |
| `models/supplied/traffic-light.glb` | `raw/traffic-light/` (`TrafficLight.fbx` + five 2K TGA-as-PNG maps), supplied by Joe | **Unknown** | Same. |

**Flag for Joe — Mixamo redistribution.** Adobe's terms let you *use* Mixamo
content in a project; they do not clearly permit republishing the character and
its clips as files someone else can download. `public/assets/character/*.glb`
are converted derivatives of exactly that, committed to this repo. If it is ever
made public, or the build is distributed as loose files, that is worth a look.
Nothing in the game depends on them being present — deleting the folder falls
straight back to the procedural humanoid.

The earlier pass excluded Mixamo on licence grounds and used a procedural
humanoid instead. This pass supersedes that: Joe supplied the files and asked
for them to be used, so the rule they broke was his to relax. The procedural
humanoid is still in the tree and still the fallback.

### Character

`scripts/convert-character.mjs` runs each FBX through `fbx2gltf` (a dev
dependency, allowed by the brief), then strips each animation file down to its
node hierarchy and animation — a Mixamo animation export carries a full copy of
the character and its 45 MB of 4K textures, so the five clips together go from
270 MB to 550 KB. The hero's own textures are re-encoded to WebP.

Twenty-one clips and one hero, 4.4 MB in total.

| File | Size | Contents |
|---|---|---|
| `character/hero.glb` | 2.8 MB | Skinned mesh, 53,167 triangles, 65 bones, 1.825 m tall with the feet at y = 0. Two materials (body atlas, clothing atlas); 2K albedo, 1K normal. |
| `character/anim-walk.glb` | 63 KB | see the clip table |
| `character/anim-jog.glb` | 45 KB | |
| `character/anim-run.glb` | 40 KB | |
| `character/anim-dance.glb` | 335 KB | |
| `character/anim-jump.glb`, `anim-punch*.glb` (5), `anim-fall*.glb` (2), `anim-pistolFire.glb`, `anim-jogGoofy.glb`, `anim-jogBack.glb`, `anim-slowRun.glb` | 40-90 KB each | the second drop; see the inventory below |
| `character/manifest.json` | 3 KB | what the runtime reads instead of guessing |

**Clip inventory** (measured at build time, written to `manifest.json`). `role`
is what the runtime does with the clip: `ladder` clips are rungs of the
speed-driven blend, `goofy` and `back` stand in for a rung on demand, `many` is
a set the game picks from at random, and `once` is triggered explicitly.

| source | clip | role | duration | root motion | authored speed | direction |
|---|---|---|---|---|---|---|
| `running/Strut Walking.fbx` | `walk` | ladder | 1.43 s | 1.27 m | **0.89 m/s** | forward |
| `running/Jogging.fbx` | `jog` | ladder | 2.57 s | 4.63 m | **1.81 m/s** | forward |
| `running/Slow Run.fbx` | `slowRun` | ladder | 0.73 s | 2.10 m | **2.86 m/s** | forward |
| `Fast Run.fbx` | `run` | ladder | 0.53 s | 2.76 m | **5.17 m/s** | forward |
| `running/Goofy Running.fbx` | `jogGoofy` | goofy | 0.63 s | 1.03 m | 1.63 m/s | forward |
| `running/Jog Forward Diagonal.fbx` | `jogFwdDiag` | dir | 0.83 s | 2.08 m | 2.49 m/s | **+45°** |
| `running/Jog Backward Diagonal.fbx` | `jogBackDiag` | dir | 0.73 s | 1.54 m | 2.09 m/s | **-134°** |
| `running/Jog Backward.fbx` | `jogBack` | dir | 0.80 s | 1.74 m | 2.17 m/s | **180°** |
| `gun/movement/while aimed/Pistol Strafe.fbx` | `pistolStrafe` | dir (armed) | 0.57 s | 1.17 m | 2.06 m/s | **+90°** |
| `gun/movement/while aimed/Pistol Walk Backward.fbx` | `pistolBack` | dir (armed) | 1.03 s | 1.39 m | 1.34 m/s | **180°** |
| `gun/Pistol Idle.fbx` | `pistolIdle` | once | 1.00 s | in place | — | — |
| `Jump.fbx` | `jump` | once | 0.93 s | 2.29 m | 2.46 m/s | — |
| `punches/Elbow Punching.fbx` | `punch` | many | 1.67 s | in place | — | — |
| `punches/Punch Combo.fbx` | `punch-2` | many | 2.20 s | in place | — | — |
| `punches/Punching (1).fbx` | `punch-3` | many | 1.00 s | in place | — | — |
| `punches/Punching.fbx` | `punch-4` | many | 1.27 s | in place | — | — |
| `punches/Right Hook.fbx` | `punch-5` | many | 1.10 s | in place | — | — |
| `fall-over/Fall Over.fbx` | `fall` | many | 2.00 s | 0.74 m | — | 39.5° of hips yaw |
| `fall-over/Falling Down.fbx` | `fall-2` | many | 2.27 s | 0.98 m | — | — |
| `Shooting.fbx` | `pistolFire` | once | 1.17 s | in place | — | — |
| `Gangnam Style.fbx` | `dance` | once | 12.37 s | in place | — | — |
| `main-character.fbx` | — | hero | — | — | — | the skinned mesh; its own take has no channels |

**A directional clip's angle is measured, not read off its file name.** The name
says a clip is a strafe; only its root motion says which way it strafes, and
getting that backwards puts the character sidestepping into whatever it was
trying to circle. The converter takes `atan2` of the hips' net travel: that is
how `Jog Backward Diagonal` turned out to be a **left** diagonal at -134°, where
the file name would have suggested either side with equal confidence.

**Each one-sided clip is mirrored at load** (`src/entities/clipMirror.ts`), so
one download covers both diagonals. Mirroring swaps the Left and Right bone
names, negates X on translation tracks and negates Y and Z on rotation tracks --
all three together, because doing any two of them is worse than doing none.

**Root motion is stripped from what the controller drives, and kept on what
drives itself.** The four ladder rungs, the two alternates and the jump all have
their hips' X and Z pinned, so the controller owns where the character is while
the body still drops and lifts. The two falls keep theirs: a knockdown is
three quarters of a metre of body pitching onto the ground, the pedestrian's AI
is stopped for the whole of it, and stripping the travel would fold them
straight down on the spot.

**Hips yaw is stripped from `idle`, `punch*` and `pistol*`.** The brief flags
baked yaw as a likely cause of the spinning bug, so it was measured rather than
assumed: it is zero on every clip in the set except `Fall Over`, whose 39.5° is
the body twisting as it goes down and is left alone. The strip is still applied,
because it costs nothing and the next download may not be so clean.

**The pistol stance is `Pistol Idle.fbx`,** held as an additive upper-body
overlay at full weight while aiming and at 0.6 while the gun is merely drawn,
which drops the arms into a ready stance. `Shooting.fbx` takes the overlay for
the duration of each shot and hands it straight back.

The one procedural piece left is the elevation: every supplied pistol clip holds
the gun level, and level is wrong the moment the player looks up or down, so the
right arm and forearm are pitched to follow the camera. Everything else -- the
grip, the two-handed hold, the recoil -- comes from the clips.

**DECISION on the additive reference.** An overlay is a delta from some pose,
and which pose decides whether it works at all. A punch is measured against its
own first frame, so the delta is the swing. A *stance* measured against its own
first frame is nothing at all -- that frame already has the arms up, so the
subtraction cancels exactly the thing worth adding. The pistol clips are
measured against the idle instead, and the delta becomes "raise the gun from
where the arms would otherwise be".

**No idle clip was supplied.** One is synthesised from frame 0 of the walk as a
static two-key pose, and `characterRig.ts` layers a breath (chest scale to 1.015
at 0.25 Hz) and a slow weight shift on top, both fading in only as the character
comes to rest. It reads as standing rather than as freezing, but a real idle
download would be better — that is the single biggest improvement available to
the character right now.

**What the measured speeds bought.** Because they are read off the clip rather
than guessed, playback rate is `speed / authoredSpeed` and the feet plant
exactly. `smoke/character.spec.ts` asserts it: at 4.00 m/s the blend is 50% jog
at 1.4x and 50% run at 0.77x, and the ground speed the feet describe is **4.00
m/s — 0.0% slip**. At 8.00 m/s it is the run clip alone at 1.55x, again 0.0%.
This is also why the brief's fixed speed bands are not used as written; see the
DECISION note on `CFG.anim` in `src/config.ts`.

### Cars

Poly Haven's model library was queried for the brief's vehicle terms
(`car|vehicle|truck|pickup|van`). **It has no drivable cars** — the only hits are
`covered_car` (a car under a tarpaulin, a static prop), `old_tyre` and two
rusted wheel rims. Without Joe's drop this section would have fallen all the way
down rule 7b to the stylised Kenney kit. He supplied two, and rule 7b puts a car
in `raw/` above everything else.

| File | Source | Used for | Triangles |
|---|---|---|---|
| `models/supplied/sedan.glb` | Meshy "Crimson City Compact" | `sedan` — the player's default car and most of the traffic | 65,416 → 23,999, edge collapse |
| `models/supplied/sports.glb` | Meshy "Orange Velocity" | `sports` | 551,067 → 23,999, edge collapse |

`pickup` and `police` have no supplied model and keep their Kenney kit bodies.

`scripts/convert-cars.mjs` does four things the raw export needs:

1. **Wires the maps on.** The FBX references none of its sibling PNGs, which is
   why the cars arrived grey. Albedo and normal go on at 1K; roughness and
   metalness are packed into the green and blue channels of one glTF
   metallic-roughness map with ffmpeg.
2. **Turns them onto the game's axes.** Both are Z-up with the length along X.
   The up axis is inferred from the shape rather than read from the file — a car
   is always longer than it is wide and wider than it is tall, and FBX up-axis
   metadata is unreliable. Which *end* is the nose cannot be inferred from a
   bounding box at all, so the converter turns the car end for end; both drops
   drove away backwards without it.
3. **Fits them to the collision box.** Uniform scale to the 4.4 m length the
   physics already uses. The sedan lands at 4.4 x 1.95 x 1.43 m and the sports
   car at 4.4 x 2.07 x 1.12 m, which are real cars.
4. **Simplifies them** to 24k triangles each with meshoptimizer's quadric edge
   collapse (`simplify` in `scripts/mesh.mjs`). Traffic instances a body up to
   forty times, so 551k triangles is a million triangles of moving car.

**Per-car paint.** Both models are one texture with the paint baked in, so the
Kenney kit's vertex-colour paint mask does not apply. The shader instead remaps
the whole albedo in HSV: hue rotated by the difference between the car's own
paint and the colour this car wants, saturation and value scaled by the same
ratio. Every crease, reflection and smear keeps its exact relative shading, and
the parts that were never painted look after themselves — glass, tyres and
chrome have no saturation to rotate, so a hue shift moves them not at all. The
car's own paint colour is the modal colour of its albedo, found once at load.

**DECISION — a soft paint mask.** Three versions. The first found the pixels
close to the car's paint with a hard threshold and recoloured those; it
mottled, because grime and baked reflections swing any threshold back and
forth across a panel. The second had no mask at all, which was smooth — and
turned every tyre, window and splitter maroon, because "black" on a generated
sheet is a very dark orange and a 4x saturation ratio makes that a colour. The
shipped version weights the remap by a wide smoothstep on hue distance from the
paint, saturation and value: 1 on the paint, 0 on chrome, glass and rubber, and
a band between too wide to see an edge in.

**The base paint is the modal SATURATED colour.** A generated albedo is mostly
filler — the dark grey between its islands, the near-black of tyres and vents —
and counted naively that grey wins. Keyed off grey, the hue rotation turned the
sports car's dark parts the target colour and its paint something else (the
"broken textures" Joe saw). The mode is now taken among pixels with real
saturation first, falling back to the plain mode only for a car that really is
white, grey or black.

**The sports car was crumpled, not just mis-painted.** The first decimation was
a grid weld — fine for a 65k-triangle export, but welding a 551k-triangle sculpt
onto a 9 cm grid does not simplify it so much as crumple it: every panel became
a field of facets, and the seams between them painted dark cracks across the
paint. Both cars now go through meshoptimizer's edge collapse, which keeps the
surface and treats shared positions as UV seams. `scripts/mesh.mjs` still has
the grid weld (`decimate`) for the props that suit it, plus `uvFragmentation`,
`bakeVertexColors` and `weldByPosition`: a future drop whose atlas is a chart
per triangle (over 30% of shared edges UV-split) is baked to vertex colour
instead, since no simplification can keep a texture like that readable. Neither
of the current two trips it (both are 6%).

**DECISION — the wheels do not turn.** Both exports are a single welded mesh
with no wheel nodes. The brief's instruction for that case (hide them, use the
procedural wheels from `config.ts`) cannot apply when the wheels are the same
triangles as the arch above them, so the car is drawn whole and its wheels
neither spin nor steer. Visible at a standstill if you look for it; invisible at
speed, and much less visible than four grey cylinders half-buried in the
bodywork. Fixed by an export with wheel nodes, not by code.

### Props: palm, streetlight and traffic light

Three more drops from Joe, converted by `scripts/convert-props.mjs`. Each
outranks what it replaces and falls back to it when absent: the palm to the
Nature Kit pair, the lamp and the signal to the procedural poles in
`src/world/props.ts`.

| File | Source | Used for | Triangles | Size |
|---|---|---|---|---|
| `models/supplied/palm.glb` | `raw/tropical-palm-tree/plalm_3.fbx` | Every palm — beach, boulevard, and the scatter on every block | 3,461 | 233 KB |
| `models/supplied/palm-far.glb` | same, welded | The same palms beyond 60 m | 919 | 113 KB |
| `models/supplied/streetlight.glb` | `raw/psx-style-street-light-kit/StreetLight.zip`, node `StreetLightSingle` | Every streetlight | 82 | 12 KB |
| `models/supplied/streetlight-double.glb` | same, node `StreetLightDouble` | Reserved for the pier's centreline | 98 | 13 KB |
| `models/supplied/traffic-light.glb` | `raw/traffic-light/TrafficLight.fbx` | Every signal, four to a block | 2,574 | 309 KB |

**Fitted on height, stood on their own base.** `orientAndFit` sorts the three
extents and calls the longest "length", which is right for a car and wrong for
everything here — a palm is tallest, not longest. `fitUpright` trusts Y as up
(all three arrive Y-up; a Z-up drop would show on its side in the printed
extents), scales to a target height, and puts the origin under the *bottom
slice of the mesh* rather than the bounding-box centre, so a leaning palm and a
cantilevered lamp both stand on their own foot.

**Orientation contract: local +Z is the business end.** A lamp's arm reaches
along +Z; a signal's lenses face +Z. The converter measures both (the arm as
the base-to-head offset, the lens normal as the mean normal of the lens
triangles), yaws the model so they land on +Z, and prints what it found:

```
StreetLightSingle: 7 m tall, head reaches (0, 2.1) from the base -- arm along +Z, correct
traffic-light: lenses face (1.00, -0.00) in the file, turned to +Z
```

`cityGen.ts` then only has to know which way the road is. Streetlights ring
each block with the arm pointing off the kerb; signals stand one per corner as
a near-side post on the driver's right, facing back along the approach they
control (right-hand traffic puts a car heading +X on the +Z side of its road,
so the corner at (maxX, minZ) is its signal, facing −X). `smoke/props.spec.ts`
checks every one of the 576 signals and a sample of the lamps against the road
grid, and screenshots to `screens/props/`.

**The traffic light is four materials, not one.** Its lens triangles are found
by what they sample from the albedo — the lenses are the only saturated texels
on it, and by hue, because they are painted unlit (a red of 99/39/31) — and
split onto `lens-red`, `lens-amber` and `lens-green`, each carrying the albedo
as its emissive map. One instance attribute then says which lens is lit and
each lens material multiplies its emissive by "is that me": three draw calls
for every signal in the city, and `world/signals.ts` drives the phases.

**The kit's own light cone is not used.** It is authored for one finish of one
arm and stops four metres off the ground. At dusk `props.ts` draws a cone of
its own from the measured reach — alpha-blended, not additive: forty additive
cones seen down a boulevard stack into one bright pyramid that fills the sky.

**Maps.** Palm: the two JPG diffuses and the leaf normal at 1K, the roughness
packed into a metal-rough map; the far LOD carries 512 px copies. Streetlight:
the three kit JPEGs (concrete, metal, lit lens) at 256 px — the sources are
32 × 64. Traffic light: albedo, normal and packed R+M at 512 px from the 2K
sources; the head is 0.4 m across.

### Pedestrians: one character, six of them

Only one character exists, so every pedestrian is that character. Two things
stop it reading as a city of clones, both built at boot:

- **Six palettes.** The albedo is downsampled to 512 and hue-shifted on a
  canvas. **DECISION:** the brief asks for the clothing regions to be recoloured
  and falls back to a whole-texture lightness shift if they cannot be separated.
  The Ch06 atlas has no mask and no documented layout, so the regions cannot be
  separated *by UV* — but they can be separated *by colour*, which is what the
  regions were for. Pixels in the skin-tone hue wedge, or dark enough to be
  hair, keep their hue and take only a small lightness nudge; everything else is
  clothing and takes the full shift. A crowd where four people share a skin tone
  and nobody shares a shirt beats six people who differ by 10% brightness.
- **Three heights** (0.92, 1.0, 1.06), applied as a uniform scale.

**Two levels of detail.** The sixteen nearest the camera are real `SkinnedMesh`
clones with their own mixers at staggered clip offsets, running the same
speed-driven locomotion blend as the player. Everyone else is one mid-stride
frame of the walk, skinned on the CPU at boot and welded from 53k triangles to
about 1.5k, drawn through six `InstancedMesh` sets. The swap is skinned inside
45 m, static beyond 55 m, so a pedestrian on the boundary does not flicker.

---

## Audio

**No audio files, ever — everything is synthesised** (`src/core/audio.ts`). The
dance's backing is a four-on-the-floor kick (a sine dropped 120 Hz → 45 Hz in
120 ms) and a hi-hat (a filtered noise burst) at 132 bpm, on their own gain bus
at 0.4. **DECISION:** the brief says "master gain 0.4", but turning the global
master down to 0.4 for the duration would duck the engine and the sirens with
it — audible as a dip every time you press `G` — so the 0.4 is applied to the
dance bus instead.

---

## What it costs

Measured in the browser on the shipped build, default `?time=day`, 80
pedestrians and 40 traffic cars:

| | Before this pass | After |
|---|---|---|
| Scene draw calls | 246 | **188** |
| Triangles | 1.38 M | **4.25 M** |

Draw calls went *down*, because a supplied car is one mesh where a kit car is
seven (body, two light clusters, four wheels).

Triangles went up threefold, and it is worth being clear about where: roughly
1.1 M is the forty-five cars at 24k each, 0.85 M is the sixteen skinned
pedestrians at 53k each, and the rest is the world as it was. The frame rate
target could not be verified here — this machine's browser falls back to a
software rasteriser under automation, so every figure it reports is about the
rasteriser rather than the code. **The triangle count is the honest number to
judge it by, and it is a real increase.** If it needs to come down, the two
levers in order of return are `MAX_TRIS` in `scripts/convert-cars.mjs` (24k a
car, and 12k would be hard to tell apart at driving distance) and
`CFG.anim.skinnedPeds` (16, and 8 would halve the crowd's cost).

---

## Fallbacks

Every category keeps its procedural path working, and the game never blocks on a
download. `src/core/assets.ts` loads everything up front behind the title
screen's progress bar; any file that fails to load is reported once to the
console and the caller falls back to what the game shipped with.

**Check it rather than trust it:** `?assets=0` skips the whole bundle and runs
fully procedural. `smoke/smoke.spec.ts` asserts that path boots with no console
errors and still builds a world, so the promise below cannot quietly rot.

| Category | Fallback if the asset is missing |
|---|---|
| HDRI | The pre-existing analytic sky rig: gradient dome, hemisphere fill and a hand-placed sun. No `scene.environment`. |
| Character | The procedural humanoid in `entities/humanoid.ts` / `playerMesh.ts`, which is what the game shipped with. `G` does nothing without a dance clip. |
| Pedestrians | The instanced blocky humanoid crowd in `entities/pedMesh.ts`. |
| Supplied cars | The Kenney kit body for that kind, then the procedural boxes. |
| Street props | The procedural bin in `world/props.ts` covers every spot. |
| Kit cars | The procedural box-and-cylinder bodies in `entities/vehicleMesh.ts`. |
| Trees / palms | The procedural palm fronds and icosahedron canopies in `world/props.ts`. |
| PBR textures | The canvas-generated textures in `core/textures.ts`. |

`?post=0` is the separate framerate fallback: it drops ambient occlusion and
bloom and renders straight to the canvas.
