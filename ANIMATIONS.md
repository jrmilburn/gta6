# Animation shopping list

What to download next, in the order that will make the most visible difference,
and why each one matters. Every number here is measured from the clips actually
in `public/assets/raw/` — see `ASSETS.md` for the full inventory.

Drop new files anywhere under `public/assets/raw/` and run `pnpm
assets:character`. The converter reads the role from the file name **or its
folder**, measures each clip's duration, root travel and direction, and writes
`public/assets/character/manifest.json`. Nothing needs wiring by hand.

---

## How the engine uses a clip

Four jobs, and a clip is only as useful as the job it fits.

**Ladder** — forward locomotion, ordered by the speed it was authored at. A
ground speed brackets two rungs and both play, each at `speed / authoredSpeed`,
so the stride covers the ground actually covered. **This part is already
perfect**: at 4 m/s and at 8 m/s the feet describe the body's speed to within
0.0%.

**Directions** — a ring of anchors around the character's facing for movement
that is not straight ahead. Forward is the ladder; everything else sits at its
own measured angle. Gaps in the ring are filled by interpolating between
neighbours, which is why a missing 90° strafe shows up as a diagonal shuffle.

**Overlays** — additive, upper body only, so the legs keep walking underneath.
Punches and the pistol stance.

**One-shots** — full body, taking the character over: the jump, the knockdowns.

Playback is clamped to 0.6–1.6× its authored rate. Push a clip past that and the
feet skate by exactly the difference, which is what most of the list below is
about.

---

## Done

**The pistol set** — `Pistol Run` (2.89 m/s, measured at 0 degrees) is the armed
forward clip that was missing, `Pistol Run Backward` (3.16) and a second
`Pistol Strafe` (2.31, measured at -90) give the armed ring a fast rung in every
direction, `Pistol Aim` (7.1 s) replaces the frozen frame of `Shooting`, and
`Pistol Jump` plays instead of the unarmed jump whenever the gun is out.

Taking them needed two engine changes. The direction ring used to pick between
clips by ANGLE alone, so a walk backward and a run backward -- both 180 degree
clips -- were two anchors at the same angle and one of them silently never
played; it now brackets the current SPEED within each direction, exactly as the
forward ladder does. And the forward anchor hands back to the ladder above the
armed clip's authored speed, because a 2.89 m/s clip cannot carry an 8 m/s
sprint. Measured after: **0.0% foot slip** forward, backward, both strafes, and
sprinting with the gun out. `smoke/armed.spec.ts` keeps it that way.

The aim speed cap moved with them, from 2 m/s to **3.5**: that is the fastest
figure every armed direction can still carry inside the playback clamp.

**Idle** — `Breathing Idle.fbx`, 9.93 s, in place. Picked up as the ladder's
bottom rung at 0 m/s, so a drift of 0.1 m/s resolves to almost pure idle with no
threshold to step across. The synthesised stand-in is gone.

**Turn in place** — `Turning.fbx`, 3.67 s, 0.12 m of travel and its root yaw
deliberately preserved. The converter now recognises it as its own `turn` role
and loads it. **Nothing drives it yet** — the controller still rotates by
sliding the feet at up to 720°/s, and wiring a turn-in-place state is engine
work, not an asset.

---

## Priority 1 — fixes something visibly wrong today

### A genuinely faster sprint — still outstanding
**Mixamo: "Fast Run" with the Overdrive slider raised, or "Sprint"**

`new fast ru n/Fast Run.fbx` is byte-different from the original but the *motion
is identical*: 0.533 s, 2.76 m of travel, **5.17 m/s** — the same three numbers
as `Fast Run.fbx`. It looks like the same download rather than a faster export,
so this one did not land. Delete one of the two (they currently occupy two
ladder rungs at the same speed, as `run` and `run-2`).

What is needed is a clip authored at **7–8 m/s**. The player sprints at 8, so
the current fastest rung runs at 1.55× against a 1.6 clamp — it plants, but with
no headroom at all.

On Mixamo, `Fast Run` has an **Overdrive** slider; pushing it up is what changes
the authored speed. The converter measures whatever you give it, so any value
above about 6 m/s helps.

### A goofy run at a usable speed
**Whatever silly run you like, at jogging pace or faster**

`Goofy Running` is authored at 1.63 m/s and has to carry 4 m/s, which pins the
clamp. Measured foot slip with `P` on: **17.5%**, against 0.0% for every other
locomotion state in the game. A goofy run authored around 4 m/s would fix it
outright.

---

## Priority 2 — what the pistol set still lacks

### A walk-speed armed set
**Mixamo: "Pistol Walk", "Pistol Walk Forward"**

Every armed clip except the backward walk is now authored between 2.3 and 3.2
m/s, so the ring is well covered at speed and thin below it. A walk-paced
forward clip would give the armed forward anchor a rung between the idle and
Pistol Run, which is the band you move in while actually aiming at something.

### Pistol diagonals
**Mixamo: "Pistol Walk Forward Left/Right", "Pistol Strafe Diagonal"**

Aimed diagonal movement blends the 90° strafe against the unarmed forward run,
which mixes an aimed upper body with an unaimed stride. Name these loosely — the
converter **measures** the travel direction, so the angle in the file name is
ignored and only one side of each pair is needed.

### Draw and holster
**Mixamo: "Drawing A Pistol", "Holster Pistol"**

Still a 0.3 s crossfade with the gun mesh appearing in the hand. The folder
`pistol/pistol draw/holster/` currently holds only `Pistol Aim.fbx`, so if a
draw and a holster were meant to be in there they did not make it across.

### Optional, once the above is in
- **Reload** — nothing tracks ammunition yet, so this needs a mag counter first.
- **Hit reaction / stagger** — the only shot response today is a full knockdown
  from the `fall` set. A stagger gives a lesser reaction without going anywhere
  near the no-gore line.
- **Turn while aiming** — only matters once turn-in-place exists.

---

## Priority 3 — fills a hole in the unarmed direction ring

The ring currently has, by measured travel direction:

| | unarmed | with the pistol out |
|---|---|---|
| 0° forward | `idle` / walk / jog / slowRun / run | **— missing**, borrows the unarmed ladder |
| ±45° diagonal | `Jog Forward Diagonal` (2.49 m/s) | **— missing** |
| ±90° strafe | **— missing** | `Pistol Strafe` (2.06 m/s) |
| ±134° back diagonal | `Jog Backward Diagonal` (2.09 m/s) | **— missing** |
| 180° backward | `Jog Backward` (2.17 m/s) | `Pistol Walk Backward` (1.34 m/s) |

Every one-sided clip is mirrored automatically, so you only ever need one side.

### Unarmed strafe, left/right
**Mixamo: "Strafe", "Left Strafe Walking", "Side Step"**

There is no unarmed 90° anchor, so sidestepping unarmed interpolates between a
45° diagonal and a 134° back-diagonal — neither of which is a sidestep. Mostly
visible during sharp turns today; it becomes important the moment anything else
makes the character strafe without a gun.

---

## Priority 4 — polish, and things the code still fakes

### Jump broken into three
**Mixamo: "Jump Up", "Falling Idle", "Hard Landing" / "Landing"**

`Jump` is one clip fitted to the physics arc — its take-off frame is measured at
0.100 s and lined up with the impulse, and it is stretched up to 1.5× to fit the
airborne time. A long fall has nothing to hold, so the airborne pose is
currently a frozen frame of the run. Take-off / loop / land would fix that and
make falls of any height work.

### Get up from the ground
**Mixamo: "Getting Up", "Stand Up"**

A knocked-down civilian stands by playing their fall clip backwards at 2×. It
reads better than it sounds — the body retraces exactly the way it went down —
but a real get-up would be better.

### Death
**No death animation.** Nothing in this game dies, by design, so a knockdown is
the whole of it.

---

## Naming

The converter matches these in the file name or the path, first match winning:

| pattern | role | what it becomes |
|---|---|---|
| `idle`, `breath` | ladder | the standing pose, the ladder's 0 m/s rung |
| `turn`, `pivot` | turn | turn in place — **loaded, not yet driven** |
| `strut`, `walk` / `jog` / `slow run` / `fast run`, `sprint`, `run` | ladder | a speed rung |
| `goofy` | goofy | the `P` toggle |
| `forward diagonal`, `backward diagonal`, `backward`, `strafe` | dir | a direction anchor, **angle measured from the clip** |
| `pistol idle` / `pistol aim` / `pistol strafe` / `pistol back` / `pistol walk` | once or dir | the armed set |
| `shoot`, `fire`, `pistol` | once | firing |
| `punch`, `hook`, `elbow`, `jab`, `combo` | many | picked at random per swing |
| `fall`, `knock`, `stagger` | many | picked at random per knockdown |
| `jump`, `leap` | once | the jump |
| `gangnam`, `dance` | once | the `G` emote |

Folders count too, so a file dropped in `punches/` is a punch whatever it is
called. Anything unrecognised is still converted and loaded, just unused — it
will show up in the manifest with its own name, and I can wire it to something.

**Export settings.** With skin only for the character itself; the animation
files can be either. In place or with root motion both work — the converter
measures the travel and strips what the controller needs to own. Do **not**
bother matching Mixamo's speed settings to anything; the whole point of
measuring each clip is that the game adapts to whatever you give it.
