# Refinement plan 2: sitting, the far crowd, traffic that drives, four weapons

Follows the operating rules in `plan.md` section 0 (timebox, `// DECISION:`
comments instead of questions, 400-line file cap, `pnpm build` + `pnpm smoke`
green before every commit, screenshots under `screens/`). One exception is
already in force since the character pass: downloaded Mixamo clips and the
Meshy car models are allowed, converted at build time by `scripts/convert-*.mjs`.
Nothing is fetched at runtime.

Five items, in the order they should be built. Each one has the root cause as
far as it is known from reading the code, the design, the files it touches and
what "done" means. Budgets are wall clock for one agent.

| # | Item | Budget |
|---|------|--------|
| 1 | Sitting on the bench and in the gondola: legs behind the body | 1.5 h |
| 2 | Far pedestrians stand in a T-pose; they should animate | 2 h |
| 3 | Traffic drives into itself | 3 h |
| 4 | Weapon selector: pistol, machine gun, sniper with scope, RPG | 6 h |
| 5 | RPG hit on a car: the car explodes | 2 h |

---

## 0. Assets already dropped in `public/assets/raw/`

Two new clips are newer than `public/assets/character/manifest.json`, so the
converter has not seen them:

- `Sitting Idle.fbx` (11.5 MB) -- for item 1.
- `Gunplay.fbx` (11.5 MB) -- for item 4.

Also new and unconverted: five character models in `raw/characters/` (kate,
prisoner, racer, remy, woman). They are not part of this plan, but they will
bite the moment `pnpm assets:character` runs: the converter's `HERO` regex
(`/character|hero|main|t-?pose/i`, `scripts/convert-character.mjs:72`) matches
on the *path*, so every one of them would be read as the hero model. **First
step of item 1: skip `raw/characters/` in the converter** (add it to the
directory skip list next to `CAR_DIRS`), or the first conversion run replaces
the main character.

Both new clips need a rule in `CLIP_NAMES` (`convert-character.mjs:38`),
*above* the rules that would otherwise claim them:

```js
[/sitting|^sit\b/i,   'sit',       'once'],   // before /idle|breath/ takes "Sitting Idle"
[/gunplay|rifle/i,    'rifleFire', 'once'],   // before /shoot|pistol|fire/ takes it as a pistol shot
```

Then `pnpm assets:character`, check the two new entries in the manifest
(duration, root motion ~0), and commit the GLBs with the manifest.

---

## 1. Sitting: legs appear behind the character

**Where.** Bench and gondola both go through `p.pose = 'sit'` / `'ride'`
(`src/gameplay/pier.ts:168`, `startRide`), which the rig hands to
`characterFlourish.ts:81`: the sit is *procedural* -- both thighs rotated
`-1.45 rad` about X, shins `+1.5`, plus a 0.42 m hips drop from
`characterRig.ts:34`. There is no clip.

**Why it looks wrong.** A Mixamo thigh bone's local X axis is not the world
pitch axis, and its sign differs from the shin's; rotating both thighs -83° about
local X folds the legs *backward* at the hip, which is what "legs behind the
character" is. The shins then bend the right way relative to the wrong thighs,
so the feet end up under the bench.

**Fix.** Stop posing the sit by hand and play the clip.

1. `CharacterRig.playOneShot` gets a `loop` option (the `Layer` already
   supports `loop` and `hold`; only the rig's option type omits it,
   `characterRig.ts:209`).
2. `CharacterRig.update`: when `f.pose === 'sit' | 'ride'` and the rig
   `has('sit')`, play `sit` as a held, looping one-shot (`blendIn 0.25`,
   `blendOut 0.3`). Stop it when the pose clears. The one-shot layer already
   takes the whole body from the locomotion blend, so the idle underneath
   disappears cleanly.
3. `characterFlourish.ts` `stepPose`: the `sit`/`ride` case does nothing when
   the clip is present (keep the offsets as the fallback when it is not, so a
   build without the clip still sits, badly).
4. **Seat height.** Replace the fixed `SIT_DROP` with a measured figure: read the
   `Hips.position.y` of the sit clip's first frame against the idle clip's
   (same trick as `measureTakeOff`, `characterActions.ts:99`), and drop the
   root by that difference. Then the bench seat and the gondola bench in
   `src/world/pier.ts` are placed so the clip's hips land on them -- check the
   bench `pos` heights there rather than tuning the drop to the bench.
5. **Facing.** `Sitting Idle` sits facing +Z with the knees forward. The
   bench spot's `heading` (`PierSpot.heading`) must be the direction the sitter
   faces; verify in the screenshot that knees point away from the backrest. If
   the gondola has no backrest, face the sea.
6. Ride: same clip, no hips drop change (the gondola bench height is set in the
   wheel builder).

**Done when** `screens/sit/` has a side and a three-quarter frame of the bench
and the gondola with thighs horizontal, shins vertical, feet on the deck, and
`smoke/sit.spec.ts` asserts that the `LeftUpLeg` bone's world position is at
least 0.3 m ahead of `Hips` along the player's heading while seated.

---

## 2. Far pedestrians stand in a T-pose

**Where.** `pedSkinned.ts` runs 16 real skeletons for the nearest pedestrians
(`CFG.anim.skinnedPeds`, swap band 45/55 m) and everyone else as one baked
"mid-stride" pose in an `InstancedMesh` per variant and part
(`pedVariants.ts:203`, `bakeStaticPose`).

**What is and is not the cause.** The obvious suspect is the baked still, but
it checks out: photographed at 81 m (`screens/fire-jog/far-peds.png`) a static
pedestrian is mid-stride, legs apart, not a T-pose. `bakeStaticPose` reads the
posed bones' world matrices directly, so it needs no `skeleton.update()`. The
T-pose is therefore coming from a *skinned* rig that is visible but not being
stepped, or from a path that draws the character mesh without a mixer at all.
Reproduce first, then fix. Candidates, in the order to check:

1. A slot whose `rig.update` is skipped while its group is visible. `commit()`
   only steps rigs whose pedestrian is in `this.frame`; a pedestrian that
   drops out of the frame list (frustum margin, `pedestrians.ts:381`) while
   still on screen at the edge would keep its rig visible for a frame and be
   released the next -- a one-frame T-pose flicker, not a standing one.
2. Gondola riders (`pedestrians.ts:620`, `riders`): if they are drawn through
   a rig that is seated but not stepped, they would be T-posed in the wheel,
   which is "off in the distance" from most of the map.
3. Police on foot (`policeFoot.ts:316` steps its rigs; check the spawn path at
   line 201 makes the group visible only *after* the first update).
4. A freshly assigned slot (`assign()` sets `visible = true` before
   `drawSkinned` has run once): the rig shows its bind pose for one frame.
   Cheap guard: run `slot.rig.update` with `dt = 0` at assignment.

Whichever it is, the fix is the same shape: a rig is never visible without
having been stepped this frame. Add an assertion in dev builds
(`rig.group.visible && !rig.steppedThisFrame` -> `console.warn` once) so it
cannot come back.

**Animating them.** The user wants anyone visible to move. Two parts:

*A. The far crowd walks (cheap, no extra draw calls).* Bake `K = 8` frames of
the walk cycle instead of one and store frames 1..7 as **morph targets** on the
baked geometry, with frame 0 as the base. `InstancedMesh` in three r160+
supports per-instance morph influences (`setMorphAt(index, mesh)` /
`morphTexture`), so each far pedestrian can be shown at its own phase with no
change to draw-call count. Per frame, for each far pedestrian:
`phase = (distanceWalked / strideLength) mod 1`, pick the two nearest baked
frames and blend them with the fractional part -- two non-zero influences, so
the crowd does not step in 8-frame jerks. Stationary pedestrians (mode idle)
hold frame 0; fleeing ones run the phase at `fleeSpeed / walkSpeed`. The vertex
clustering in `cluster()` must reuse **one** index mapping for every frame, so
compute the cluster map on frame 0 and apply it to the others; otherwise the
morph targets do not line up vertex for vertex.

Down / tumbling far pedestrians keep the current handling (they are hidden or
tumble-quat posed already in `pedSkinned.ts:316`).

*B. More real skeletons nearby, if the frame budget allows.* Try
`skinnedPeds: 24`, `skinnedIn: 60`, `skinnedOut: 72` and read the fps line in
`smoke.spec.ts` at 1280x720 with `peds=80`. Keep the raise only if it stays at
or above 55 in the software renderer's relative terms (compare against the
current baseline number, which the spec prints).

**Done when** a frame from 70 m away shows walking silhouettes with legs in
different phases, no T-poses anywhere at any distance, and `smoke.spec.ts` fps
is within 10% of today's.

---

## 3. Traffic drives into itself

**What the code does today** (`src/entities/traffic.ts`):

- Steering is pure pursuit along the lane graph, cruise 14 m/s
  (`CFG.traffic`), following gap 8 m in a 30° cone (`blockedAhead`, line 270).
- Intersections: only when a car *crosses into* a connector lane does it check
  `intersectionBusy` (any car within 0.8 road widths of the node), and if so it
  pauses 1.2 s once -- then goes regardless (`steer`, line 205).
- Signals hold cars at a red (`heldBySignal`) but nothing stops two greens on
  the same axis turning across each other, and unsignalled nodes have no
  right-of-way rule at all.
- Nothing predicts where another car will be. A car on a cross street 9 m away
  is outside the cone and invisible until it is a collision.

So the crashes are almost all at intersections: cars entering on green from
both sides of one axis, a turning car sweeping across an oncoming straight car,
and the 1.2 s pause expiring with the node still occupied.

**Design.** Keep the lane-follow layer; add a proper right-of-way layer and
path-based conflict prediction. All of it lives in a new `src/entities/trafficFlow.ts`
(under 400 lines) that `traffic.ts` calls; `laneDriver.ts` stays the shared
steering for police.

1. **Node reservations.** One `Map<nodeId, Reservation[]>`. A car approaching a
   node (within `STOP_ZONE` of its lane end) requests entry with its exit lane.
   Entry is granted when every current holder of that node has a *compatible*
   movement -- same axis, both straight; or the same connector; or one is
   already past the node centre. Otherwise the car waits at the line
   (`a.arc` clamped like the red-light hold) and re-requests every frame.
   Holders release when their arc on the connector passes its length, or
   after a 4 s hard timeout so a wrecked or stuck car cannot deadlock a node.
   Player vehicle counts as a holder with an unknown movement (incompatible
   with everything) while it is inside the node radius.
2. **Path-based lookahead instead of the cone.** For each AI car, sample the
   other AI cars' positions 0.5 s and 1.0 s ahead along *their* lanes
   (`pointAtArc(lane, arc + speed * t)`), and test those against this car's own
   sampled path at the same times. A predicted distance under `carLength + 1`
   means brake. This catches the turning-across case and the cross street the
   cone misses. Cost: 40 cars x 40 x 2 samples per frame is fine; skip pairs
   more than 40 m apart.
3. **Speed matching.** Following gap scales with speed:
   `gap = 4 + speed * 0.6` m. Target speed is `min(cruise, leader.speed)` when
   following; throttle eases toward the target instead of the current
   bang-bang (`throttle = 1` or `-0.4`), so queues do not concertina.
4. **Unstick.** If an AI car has been at `speed < 0.3` with throttle down for
   1.5 s and is not held by a reservation or a signal, reverse for 0.8 s with
   the wheel turned away from the nearest car, then re-anchor
   (`anchorOnLane`). The police already do this (`CFG.police.unstickAfter`);
   reuse the same shape.
5. **Signals stay.** Reservations run *under* the signal: a green does not grant
   entry into an occupied node.
6. **Player still crashes.** None of this applies to the player's car; traffic
   yields to it via rule 2 and the existing `byPlayer` handling.

**Measure before and after.** Add `smoke/trafficFlow.spec.ts`: `traffic=40`,
`peds=0`, camera parked, 90 simulated seconds, count `vehicleHit` events where
both parties are AI (`other !== null && neither is the player`). Print the
baseline in the first commit, then require `<= 2` AI-vs-AI hits per 90 s.

**Done when** that spec passes and a 60 s screen recording shows queues at
lights, cars waiting for cross traffic and no pile-ups at any intersection.

---

## 4. Weapon selector

**Weapons.** Pistol (existing), machine gun, sniper rifle with scope, RPG.
Selection with keys `1`-`4` and the mouse wheel; `H` still draws/holsters the
*current* weapon. Everything about a weapon is data:

```ts
// src/config.ts
weapons: {
  pistol:  { name: 'PISTOL',  fireInterval: 0.2,  damage: 15,  range: 120, spread: 0.4, kickDeg: 1.6, auto: false, hold: 'pistol' },
  mg:      { name: 'SMG',     fireInterval: 0.08, damage: 6,   range: 90,  spread: 1.8, kickDeg: 0.7, auto: true,  hold: 'rifle' },
  sniper:  { name: 'SNIPER',  fireInterval: 1.4,  damage: 60,  range: 400, spread: 0.0, kickDeg: 3.5, auto: false, hold: 'rifle', scopeFov: 12 },
  rpg:     { name: 'RPG',     fireInterval: 2.5,  damage: 0,   range: 250, spread: 0.0, kickDeg: 5,   auto: false, hold: 'rifle', projectile: { speed: 45, radius: 6, gravity: 4 } },
}
```

`damage` is per hit on a vehicle (`vehicle.damage`); pedestrians are knocked
down by any hit, as today. Spread is a cone half-angle in degrees applied to
the aim ray. `hold` picks which pose set the rig uses.

**Files.**

- `src/entities/weapons.ts` (new): the weapon table type, current selection,
  input handling for `1`-`4` / wheel, and the per-weapon fire behaviour
  (hitscan vs projectile). `combat.ts` is already 417 lines and over the cap;
  move `stepFiring` and the pistol attach/muzzle code out into this file and
  leave `combat.ts` owning the punch, the stance and the aim state.
- `src/entities/weaponMesh.ts` (new): procedural meshes in the style of
  `pistol.ts` -- boxes and cylinders, one builder per weapon, each returning
  `{ group, muzzle, flash, dispose }` so `fitPistolToHand` works unchanged
  (rename it `fitToHand`). Machine gun: long receiver, magazine below, stock.
  Sniper: longer barrel, scope tube on top, bipod stubs. RPG: fat tube over
  the shoulder with a cone warhead visible at the front until fired.
- `src/entities/projectile.ts` (new): the rocket. Position, velocity, light
  gravity, a smoke trail (reuse `VehicleSmoke` with a higher rate), sweep test
  each step with `rayHitVehicle` / `rayHitPed` / `rayHitWorld` along the step
  segment. On hit or after `range / speed` seconds: explode (item 5).
- `src/core/input.ts`: add `weapon1..4` actions on `Digit1..Digit4`, and a
  `wheel` accumulator from the `wheel` event (already have the mouse plumbing).
- `src/ui/hud.ts`: the ammo readout becomes a weapon readout: name in the
  yellow key colour, `● ∞  N FIRED`, and a small wheel of four names with the
  current one lit, shown for 1.5 s after a change. Legend gains
  `1-4 / WHEEL  weapon`. Scope overlay: a full-screen black vignette with a
  circular hole and a fine crosshair, `opacity` driven by `AIM.amount` while
  the sniper is selected.
- `src/camera/footCamera.ts`: the aim FOV comes from the weapon (`scopeFov`
  for the sniper, `aimFov` otherwise). Look sensitivity scales by
  `fov / aimFov` so the scope is controllable.
- `src/core/audio.ts`: `gunshot(kind)` -- the SMG is the pistol crack shorter
  and quieter; the sniper is longer with a lower thump and a tail; the RPG
  launch is a whoosh (reuse `whoosh()` louder) and the explosion is item 5.

**Animation.** Two hold sets, both driven exactly the way the pistol is today
(overlay pose + armed locomotion ring + `overlay.scale` by `armedShare`).

- `pistol` set: unchanged.
- `rifle` set from `Gunplay.fbx`. Measure it first (`pnpm assets:character`
  prints duration and root motion). If it is a held two-handed stance with
  shots in it, use frame 0 held as `rifleAim` (the same frozen-frame trick the
  pistol used before `Pistol Aim` arrived, `combat.ts:138`) and the clip itself
  as `rifleFire`. If it is only a firing motion, it is the fire clip and the
  aim pose is its first frame regardless. Either way it is a two-handed rifle
  hold, which reads correctly for the SMG, the sniper and the RPG at the
  distance the camera sits.
- The armed movement ring stays the pistol ring for all four weapons; the
  legs are the same and the arms are a rifle hold either way once
  `overlay.scale` lets the overlay carry the arms. **If it looks wrong on the
  move**, download these Mixamo clips into `raw/rifle/` (the converter rule
  above already names them; add `'dir'` rules mirroring the pistol ones):
  `Rifle Idle`, `Rifle Aiming Idle`, `Firing Rifle`, `Rifle Run`,
  `Rifle Walk`, `Rifle Strafe` (left and right), `Rifle Walk Back`. About
  40 MB of FBX, twenty minutes of conversion.
- Reload / draw: no clip. The draw is the existing `drawTime` ease; the RPG
  reload is `fireInterval` with the warhead mesh hidden until reloaded.
- Recoil: `kickDeg` on the camera as today; the SMG accumulates kick while held
  (`kick *= 1 + shots * 0.05` up to 2x) so a held burst climbs.

**Done when** each weapon fires with its own sound, mesh and readout; the
sniper scopes to 12° with the overlay; the RPG rocket flies visibly with a
trail and detonates on the first thing it touches; switching weapons while
armed crossfades the hold poses (the `Layer` crossfade from the last commit);
`smoke/weapons.spec.ts` selects each weapon, fires, and asserts a `shotHit`
event of the right kind plus screenshots to `screens/weapons/`.

---

## 5. Explosions

**Trigger.** `Vehicle.damage()` already flips `wrecked` and emits `'wrecked'`.
Add `Vehicle.explode(fromX, fromZ)`: sets `wrecked`, adds an upward and
outward impulse (`slipVel` plus a new vertical hop that `writeMesh` applies
and decays), swaps the body material to a blackened tint
(`vehicleMesh.ts` -- add `setScorched()`), sets the smoke to the wrecked rate
with a darker colour, and emits `'exploded'` (add to `EventName` in
`types.ts`). Called from the RPG projectile on a vehicle hit, and from
`damage()` when a vehicle is destroyed by gunfire rather than a collision
(so a sniper can finish a smoking car).

**Blast.** `src/entities/explosion.ts` (new) owns a pool of explosions:

- Visual: a flash sphere (additive, 0.15 s), 24 fireball sprites rising and
  fading over 0.8 s from orange to dark grey, a ground shockwave ring scaling
  out over 0.5 s, and a burst of the existing spark particles. No textures --
  canvas-drawn soft disc as today's smoke does.
- Radius 6 m: every vehicle inside takes `damage(200 * falloff)` and a shove
  away from the centre (chain reactions happen naturally with a 0.3 s fuse
  so they read as a sequence, not one frame); every pedestrian inside is
  knocked down via the existing `knockDown`; the player on foot inside 4 m is
  thrown (reuse the dive impulse) and loses health.
- Camera shake: `kick` on pitch plus a 0.4 s decaying yaw wobble scaled by
  `1 / distance`.
- Audio: `audio.explosion()` -- a low sine sweep 90 → 30 Hz over 0.6 s under a
  noise burst through a lowpass opening from 400 Hz to 3 kHz, with a 1.2 s
  tail. Synthesised like everything else.
- Wanted: `'exploded'` raises heat the way a `shotHit` on a police car does
  (`src/gameplay/wanted.ts`); blowing up a cruiser is an instant extra star.
- A traffic car that explodes stays where it is as debris, as wrecks do now
  (`traffic.ts:187`), and gets recycled by the existing distance rule.

**Done when** an RPG hit on a moving traffic car produces a fireball, the car
hops and comes down scorched and smoking, a car parked beside it goes up a
beat later, nearby pedestrians drop, the report is audible, and
`smoke/explosion.spec.ts` asserts an `'exploded'` event and `wrecked === true`
on the target within 0.5 s of the `shotHit`.

---

## 6. Order and commits

**Known red before any of this starts.** Three tests in `smoke/combat.spec.ts`
fail on `main` as of 2026-09-05, unrelated to the animation fixes committed
alongside this plan (they fail identically with those fixes stashed):

- `P swaps the jog for the goofy one` -- goofy foot slip 34.7% against a 25%
  limit. The clip cannot carry 4 m/s inside the playback clamp (its own
  comment says about a fifth; it is a third). Either widen the limit for the
  substitute or let the goofy clip take a wider `timeScaleMax`.
- `punching and the pistol knock civilians down` -- three punches, nobody
  down, heat never rose. Check the punch impact test in `combat.ts`
  (`stepPunchImpact`) against where pedestrians now stand; the test steps the
  player in to 0.8 m.
- `downed civilians stay down, then get up` -- the knocked-down pedestrian's
  `y` settles at -1.65 m. `pedKnockdown.ts` is putting a body below the ground
  it was standing on; look at what `groundAt` returns for that pedestrian.

Fix these first or the "full `pnpm smoke` before each commit" rule cannot be
followed.

1. Converter: skip `raw/characters/`, add the two clip rules, convert, commit
   the manifest and GLBs.
2. Item 2 first step (the one-line skeleton fix) -- it is the highest visible
   win per minute.
3. Item 1, sitting.
4. Item 2, morph-target walking crowd.
5. Item 3, traffic. Baseline spec first, then the flow layer.
6. Item 4, weapons: selector and HUD, then SMG, then sniper and scope, then
   RPG projectile.
7. Item 5, explosions, wired to the RPG last.

One commit per item (or per weapon), message `refinement-2: <what>`, with the
screenshot paths in the body. `pnpm build` and the full `pnpm smoke` before
each. The existing `armed.spec.ts` foot-slip assertions must stay at 0.0% --
none of this touches the ladder, but the rifle ring would if it is added.

## 7. Defaults chosen so nobody has to ask

- Weapon keys are `1`-`4`; the wheel cycles. `H` draws and holsters.
- Ammo stays infinite for every weapon; the RPG's limit is its reload.
- Sniper scope is right-click while the sniper is selected; there is no
  separate hip-aim for it.
- The rocket is not guided and has no arming distance: firing at your own feet
  is allowed and hurts.
- Cars destroyed by collision still just smoke; only gunfire and rockets
  produce a fireball. `// DECISION` this in `vehicle.ts` when written.
- The far crowd bakes 8 frames; the near pool stays at 16 unless the fps line
  says otherwise.
