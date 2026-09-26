# Playable character integration

The player uses the supplied schoolboy skin. Pedestrians and police retain their existing character source. Movement physics, collisions, health, interactions, vehicle entry/exit, camera control, hitscan and rockets remain in their original systems.

## Asset audit

`public/assets/models/new character model` contains three glTF 2 binary files:

| File | Contents |
| --- | --- |
| `Meshy_AI_Schoolboy_Airplane_Po_0904094652_texture.glb` | Unskinned mesh, original colour/normal/metallic-roughness textures; no animations |
| `…Animation_Walking_withSkin.glb` | 46,157-vertex skin, 24 joints, `Armature\|walking_man\|baselayer` |
| `…Animation_Running_withSkin.glb` | Same skin and rig, `Armature\|running\|baselayer` |

The rig is Y-up, Z-forward. Its bind mesh is 1.7 m tall; the existing rig normalizer targets 1.8 m. The idle stance measures approximately 1.77 m, with the soles approximately 1 cm above the player origin. Joint node translations use centimetres but inverse bind matrices use metres. The loader restores the bind pose in metres before adapting joint coordinate frames and recalculating inverse binds. Merely renaming the bones would deform this skin.

Hierarchy: `Armature → Hips → Spine02 → Spine01 → Spine → neck → Head`; shoulders branch from the upper `Spine`. Each arm has Shoulder/Arm/ForeArm/Hand; each leg has UpLeg/Leg/Foot/ToeBase. `head_end` and `headfront` are terminal joints. There are **no finger joints**.

Spine names are mapped by hierarchy (`Spine02 → Spine`, `Spine01 → Spine1`, `Spine → Spine2`). Rest orientations are adapted to the existing Mixamo source while preserving the new bind shape, proportions, joint positions and skin weights. Native clips receive the inverse coordinate-frame conversion. Legacy clips reuse rotations and proportion-scaled hips translation; unavailable finger tracks are excluded. A separate unweighted palm marker provides the existing weapon socket contract.

## Modules and layers

- `src/core/playerCharacter.ts`: centralized paths, skin preparation, native clips and animation reuse. Source data is prepared once, separately from the crowd.
- `src/core/playerAppearance.ts`: restores original PBR textures, removes the animated export's full-strength emission, enables up to 8× anisotropic filtering and retains mipmaps. All 46,157 UV locations match the original mesh despite reordered vertices.
- `src/core/handGrip.ts`: optional bind-space finger-curl morphs and matching normals. This improves the open-hand skin without inventing independent finger joints.
- `src/core/strideSpeed.ts`: corrects native sole penetration and measures in-place gait speed from median backward toe velocity during stance, rather than guessing clip speeds. Positive foot clearance during the run's flight phase is preserved.
- `src/entities/characterGrounding.ts`: samples a cached sole grid on the player after blending to prevent diagonal poses penetrating the capsule floor. It adjusts only vertical visual placement, before weapon IK, without changing physics or removing running flight phases.
- `src/entities/characterLocomotion.ts`: cached speed ladders and angular blend anchors. Actual player velocity relative to facing drives direction, including deceleration and collision response. Idle hands over early to walking; action rates track speed. Native walk/run combine with existing intermediate-speed and directional clips.
- `src/entities/characterRig.ts`: existing mixer, additive overlays and full-body layers, plus cached emote actions. Procedural offsets and weapon corrections are restored before each mixer update so they cannot accumulate.
- `src/entities/weaponAnimation.ts`: centralized per-weapon support points/recoil and cached arm IK. The weapon remains parented to the right hand. Camera-centre aim, chest yaw correction, hand orientation and left-palm placement run after animation. Relaxed carry blends into aiming. Recoil impulses affect the hands, weapon and chest without restarting locomotion; automatic bursts do not rewind the held pose.
- `src/entities/combat.ts`, `weapons.ts`, `combatTypes.ts`: feeds gameplay state into the visual layers; semi-automatic guns fire once per press, automatic guns while held.
- `src/entities/player.ts`: exposes velocity and writes interpolated world transforms before visual IK.
- `src/entities/emotes.ts`, `dance.ts`: registry and cancellation rules. `G` retains the existing dance/camera/crowd behavior. Movement, jump, interaction, aiming and firing cancel incompatible emotes.
- `src/core/assets.ts`, `session.ts`: load and select the new player source without changing the crowd source.
- `src/entities/characterActions.ts`: completed clamped one-shots now fade out correctly.

Reused assets include breathing idle, intermediate runs, directional jogs, pistol forward/back/strafe variants, pistol idle/aim/fire, rifle fire, jump/pistol jump, sit, turn, dance, punches and falls. Existing synthesized SMG/sniper/RPG hold/aim poses are reused. There are no new duplicated animation files or dependencies.

## Controls and diagnostics

Existing controls remain: WASD movement, Shift sprint, Space jump, H draw/holster, 1–4 or wheel select pistol/SMG/sniper/RPG, right mouse aim, left mouse fire/punch, G dance, P alternate gait.

`node scripts/inspect-player.mjs` prints the file formats, hierarchy, clips, materials and geometry metadata. `window.__session.heroRig.debug()` reports weights/rates. `heroRig.playEmote('dance-short')`, `playEmote('dance-finish')` and `cancelEmote()` expose shorter sections of the supplied dance for testing. Add entries to `EMOTES` for future clips. These are dance variants, not additional authored gestures. Emotes use independent cached actions so they do not conflict with the normal dance action.

## Verification

`npm run build` includes TypeScript checking and the Vite production build. There is no configured lint script.

Browser suites:

```
npx playwright test smoke/playerIntegration.spec.ts smoke/playerVisual.spec.ts smoke/playerGaits.spec.ts
npx playwright test smoke/playerGrounding.spec.ts
npx playwright test smoke/foot.spec.ts
```

The integration matrix exercises all eight directions at idle/walk/run speeds, acceleration/deceleration, aiming up/down, all four weapon attachments, single and repeated shots while moving, and emote completion/cancellation. Visual tests capture stable front/side poses without changing the aiming camera during pose evaluation; they measure barrel alignment and support-palm error. Gait tests sample animated bounds and verify the restored material maps. Captures go to `test-results/player-*.png`.

The grounding regression simulates 600 consecutive frames with renderer matrix updates while walking, sprinting and stopping. It reproduced a stale skinned-mesh inverse transform accumulating more than 7 m of visual lift; refreshing that transform before sampling soles prevents the feedback.

## Asset limits

The skin has no separately weighted fingers. Its generated grip morphs are an approximation; precise trigger-finger motion and individually articulated grips require a finger-rigged asset. No unique wave, salute or other gesture clips were supplied; the emote registry is ready for them. The current arsenal has no shotgun, so no shotgun-specific pose is claimed.

Locomotion uses in-place animation and the existing capsule/ground sampler. It does not provide per-foot terrain IK. Extreme terrain, abrupt turns and speeds beyond a directional clip's playback range can still produce some sliding. Aiming retains the existing 3.5 m/s gameplay cap; unaimed sprinting turns toward travel. The visual barrel converges on the camera centre ray at 100 m; gameplay hit testing is unchanged, so close-range parallax remains possible.
