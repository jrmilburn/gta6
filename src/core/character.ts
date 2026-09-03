// Loading and preparing the skinned hero (integration pass, sections 1-2).
//
// Joe supplies Mixamo FBX exports in public/assets/raw/;
// scripts/convert-character.mjs turns them into hero.glb, one anim-*.glb per
// clip and a manifest describing what each clip actually contains. Nothing at
// runtime has to guess: the manifest carries the ground speed each clip was
// authored at, measured from the hips' own root motion.
//
// Everything here is preparation, not playback -- see entities/characterRig.ts
// for the thing that puts a character on screen.
import * as THREE from 'three';
import { CFG } from '../config';

const A = CFG.anim;

/**
 * Clips that play while the character is standing still and being aimed by the
 * player. Any yaw baked into these fights the controller for the facing, so it
 * is removed (see `stripRootYaw`).
 */
const STANDING = /^(idle|punch|pistol)/;

/**
 * What the game does with a clip, assigned by scripts/convert-character.mjs
 * from the file and folder name.
 *
 * `ladder` clips are rungs of the speed-driven locomotion blend. `dir` clips
 * cover a direction of travel other than straight ahead -- a diagonal, a
 * strafe, a backward jog -- and carry the angle they represent. `goofy` stands
 * in for the whole gait on demand. `many` is a role the game picks at random
 * from: five punches, two falls. `once` is everything triggered explicitly.
 */
export type ClipRole = 'ladder' | 'goofy' | 'dir' | 'many' | 'once';

export interface ClipInfo {
  name: string;
  role: ClipRole;
  duration: number;
  /** Metres per second the clip's own root motion covers. 0 for in-place clips. */
  groundSpeed: number;
  inPlace: boolean;
  /** Net yaw baked into the hips over the clip, radians. */
  rootYaw: number;
  /** For a `dir` clip: the travel direction it covers, degrees off forward. */
  angle: number;
  /** True for clips that only play while the pistol is drawn. */
  armed: boolean;
}

export interface CharacterSource {
  /** The hero root, ready for SkeletonUtils.clone(). Never added to a scene itself. */
  scene: THREE.Object3D;
  clips: Map<string, THREE.AnimationClip>;
  info: Map<string, ClipInfo>;
  /** Standing height in world units, straight off the mesh bounds. */
  height: number;
  /** Base colour map, kept for the pedestrian palette recolour (section 5). */
  albedo: THREE.Texture | null;
  /** True when the idle pose was built here rather than supplied as a clip. */
  syntheticIdle: boolean;
  /** Every clip name carrying `role`, in manifest order. */
  byRole(role: ClipRole): string[];
}

interface Manifest {
  hero: { file: string; height: number };
  clips: Array<{
    name: string; file: string; role?: ClipRole; duration: number;
    groundSpeed: number; inPlace: boolean; rootYawDeg?: number;
    angle?: number; armed?: boolean;
  }>;
}

export type GltfLoad = (url: string) => Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }>;

/**
 * Mixamo bone names arrive as `mixamorig9:Hips`; GLTFLoader strips the colon
 * when it sanitises node names, and the track names it builds are sanitised the
 * same way. Matching on the suffix works either side of that, and survives the
 * export-index prefix changing between one Mixamo download and the next.
 */
export function findBone(root: THREE.Object3D, suffix: string): THREE.Bone | null {
  let found: THREE.Bone | null = null;
  root.traverse((o) => {
    if (found || !(o as THREE.Bone).isBone) return;
    if (o.name.endsWith(suffix)) found = o as THREE.Bone;
  });
  return found;
}

/**
 * Remove the horizontal component of the hips translation.
 *
 * The controller owns where the character is; the clip must only say what the
 * body does on the spot. Y is left alone so the run still drops and lifts.
 *
 * In-place clips are skipped: the dance's hips wander 1.36 m sideways and come
 * back to the mark, and that side-step *is* the dance. Only a clip with net
 * travel is trying to move the character.
 *
 * The falls are skipped too, by role. A knockdown is 0.74 m of the body
 * pitching forward onto the ground, and the pedestrian's AI is stopped for the
 * whole of it -- there is nothing for the travel to fight, and stripping it
 * would drop the body straight down on the spot.
 */
function stripRootMotion(clip: THREE.AnimationClip): void {
  for (const track of clip.tracks) {
    if (!/Hips\.position$/.test(track.name)) continue;
    const v = track.values;
    const x = v[0], z = v[2];
    for (let i = 0; i < v.length; i += 3) { v[i] = x; v[i + 2] = z; }
  }
}

/**
 * Remove yaw baked into the hips, keeping pitch and roll.
 *
 * A clip that turns the body while the controller also owns the facing gives
 * two things authority over one number, and the character twitches. Measured on
 * the supplied set, only the falls carry any (39 degrees, which is the fall
 * itself and is left alone) -- but the brief calls for it on the clips that
 * play while standing, and a future download may well arrive with a drift.
 */
function stripRootYaw(clip: THREE.AnimationClip): void {
  for (const track of clip.tracks) {
    if (!/Hips\.quaternion$/.test(track.name)) continue;
    const v = track.values;
    for (let i = 0; i < v.length; i += 4) {
      const x = v[i], y = v[i + 1], z = v[i + 2], w = v[i + 3];
      const yaw = Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
      // Left-multiply by the inverse yaw, which cancels the turn about world up
      // and leaves the lean and the twist untouched.
      const s = Math.sin(-yaw / 2), c = Math.cos(-yaw / 2);
      v[i] = c * x + s * z;
      v[i + 1] = c * y + s * w;
      v[i + 2] = c * z - s * x;
      v[i + 3] = c * w - s * y;
    }
  }
}

/**
 * Build a static idle from frame 0 of another clip.
 *
 * Joe's set has no idle download, and a character that freezes solid the
 * instant it stops reads as a bug rather than as stillness. This gives the
 * mixer something to blend to; characterRig.ts layers the breath and the weight
 * shift on top, because a two-key constant clip cannot carry either.
 */
function synthesiseIdle(from: THREE.AnimationClip): THREE.AnimationClip {
  const tracks: THREE.KeyframeTrack[] = [];
  for (const track of from.tracks) {
    const stride = track.getValueSize();
    const first = Array.from(track.values.slice(0, stride));
    // Two identical keys, one second apart: a single key makes some three
    // interpolants divide by a zero-length span.
    tracks.push(new (track.constructor as new (
      n: string, t: number[], v: number[],
    ) => THREE.KeyframeTrack)(track.name, [0, 1], first.concat(first)));
  }
  return new THREE.AnimationClip('idle', 1, tracks);
}

/**
 * Materials: force a plain dielectric.
 *
 * DECISION: the packed metallic-roughness map is dropped. FBX2glTF builds it
 * from the FBX's *glossiness* channel, and glossiness is roughness inverted --
 * so keeping it is a coin flip between skin that looks damp and skin that looks
 * right, decided by which way round the exporter happened to read it. A flat
 * roughness under image-based lighting is the safe read, and it is what the
 * brief asks for anyway.
 */
function prepareMaterials(scene: THREE.Object3D): THREE.Texture | null {
  let albedo: THREE.Texture | null = null;
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh & { isSkinnedMesh?: boolean };
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Skinned bounds are computed from the bind pose and go stale the moment a
    // clip moves a limb outside it, which culls the character at frame edges.
    if (mesh.isSkinnedMesh) mesh.frustumCulled = false;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const std = m as THREE.MeshStandardMaterial;
      if (!std.isMeshStandardMaterial) continue;
      std.metalness = 0;
      std.metalnessMap = null;
      std.roughnessMap = null;
      // DECISION: 0.8 everywhere. The brief wants 0.5 on hair, but the mesh
      // splits into exactly two materials -- one atlas for the body and one for
      // the clothing -- and the hair shares the body atlas with the skin. There
      // is no hair material to give 0.5 to without giving it to the face too.
      std.roughness = 0.8;
      std.side = THREE.FrontSide;
      if (!albedo && std.map) albedo = std.map;
    }
  });
  return albedo;
}

function measureHeight(scene: THREE.Object3D): number {
  const box = new THREE.Box3();
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    if (mesh.geometry.boundingBox) box.union(mesh.geometry.boundingBox);
  });
  return box.isEmpty() ? 0 : box.max.y - Math.min(0, box.min.y);
}

/**
 * Load the hero and its clips. Resolves to null if anything essential is
 * missing, and the caller falls back to the procedural humanoid.
 *
 * `onFile` ticks the loading bar once per file.
 */
export async function loadCharacter(
  base: string, load: GltfLoad, onFile: (label: string) => void,
): Promise<CharacterSource | null> {
  let manifest: Manifest;
  try {
    const res = await fetch(`${base}manifest.json`);
    if (!res.ok) throw new Error(String(res.status));
    manifest = (await res.json()) as Manifest;
  } catch {
    return null;
  }

  const hero = await load(`${base}${manifest.hero.file}`);
  onFile('character/hero');
  const albedo = prepareMaterials(hero.scene);
  const height = measureHeight(hero.scene) || manifest.hero.height;

  const clips = new Map<string, THREE.AnimationClip>();
  const info = new Map<string, ClipInfo>();
  for (const entry of manifest.clips) {
    let gltf;
    try {
      gltf = await load(`${base}${entry.file}`);
    } catch {
      onFile(`character/${entry.name}`);
      continue;
    }
    onFile(`character/${entry.name}`);
    const clip = gltf.animations[0];
    if (!clip) continue;
    clip.name = entry.name;
    const role: ClipRole = entry.role ?? 'once';
    // Root motion is stripped from everything the CONTROLLER drives, and left
    // on everything that drives itself. A knockdown travels; a jog must not.
    if (!entry.inPlace && role !== 'many') stripRootMotion(clip);
    if (STANDING.test(entry.name)) stripRootYaw(clip);
    clips.set(entry.name, clip);
    info.set(entry.name, {
      name: entry.name,
      role,
      duration: entry.duration,
      groundSpeed: entry.groundSpeed,
      inPlace: entry.inPlace,
      rootYaw: ((entry.rootYawDeg ?? 0) * Math.PI) / 180,
      angle: entry.angle ?? 0,
      armed: entry.armed === true,
    });
  }

  // The whole point of the rig is locomotion; without a single walk-like clip
  // there is nothing here the procedural humanoid does not do better.
  const locomotion = [...info.values()].filter((c) => c.role === 'ladder' && c.groundSpeed > 0.05);
  if (locomotion.length === 0) return null;

  const syntheticIdle = !clips.has('idle');
  if (syntheticIdle) {
    const base = clips.get('walk') ?? clips.get('jog') ?? clips.get([...clips.keys()][0]);
    if (base) {
      const idle = synthesiseIdle(base);
      stripRootYaw(idle);
      clips.set('idle', idle);
      info.set('idle', {
        name: 'idle', role: 'ladder', duration: 1, groundSpeed: 0, inPlace: true,
        rootYaw: 0, angle: 0, armed: false,
      });
    }
  }

  const byRole = (role: ClipRole): string[] =>
    [...info.values()].filter((c) => c.role === role).map((c) => c.name);

  return { scene: hero.scene, clips, info, height, albedo, syntheticIdle, byRole };
}

/**
 * The locomotion ladder: every clip that moves the character, ordered by the
 * speed it was authored at, with the idle pose pinned at zero.
 *
 * This is what replaces the brief's fixed speed bands -- see the DECISION note
 * on CFG.anim. A speed lands between two rungs, both play, and each plays at
 * its own rate, so the contact point stays planted across the handover.
 */
export interface Rung { name: string; speed: number }

export function buildLadder(info: Map<string, ClipInfo>): Rung[] {
  const rungs: Rung[] = [];
  if (info.has('idle')) rungs.push({ name: 'idle', speed: 0 });
  for (const c of info.values()) {
    // Role, not speed. A fall travels 0.74 m and a jump 2.29 m, and both would
    // otherwise land in the middle of the walk-to-jog blend as rungs of their
    // own -- which is how a knockdown clip ends up playing when you jog.
    if (c.role !== 'ladder' || c.name === 'idle') continue;
    if (c.groundSpeed > 0.05) rungs.push({ name: c.name, speed: c.groundSpeed });
  }
  rungs.sort((a, b) => a.speed - b.speed);
  return rungs;
}

export const TIME_SCALE_RANGE: readonly [number, number] = [A.timeScaleMin, A.timeScaleMax];
