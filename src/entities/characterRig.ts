// One skinned character on screen: the player, or any pedestrian near enough to
// deserve its own skeleton (integration pass, sections 3-5).
//
// The rig owns an AnimationMixer and one action per rung of the locomotion
// ladder. Which rungs play, and how fast, comes from ground speed alone -- never
// from input -- so releasing the key eases run -> jog -> walk -> idle the same
// way the procedural humanoid it replaces did.
//
// Everything the mixer cannot express is layered on afterwards, in the same
// place a real rig would put an additive track: the spine lean, the breath and
// weight shift that stand in for the idle clip Joe's set does not include, and
// the frozen airborne pose.
import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CFG } from '../config';
import { smoothDamp } from '../core/smooth';
import { buildLadder, findBone, type CharacterSource, type Rung } from '../core/character';

const A = CFG.anim;
const F = CFG.feel.foot;
const LEAN_ACCEL = (F.leanAccelDeg * Math.PI) / 180;
const LEAN_TURN = (F.leanTurnDeg * Math.PI) / 180;
const AIR_LEAN = (A.airLeanDeg * Math.PI) / 180;
const SWAY = (A.swayDeg * Math.PI) / 180;
/** Target standing height; the rig only rescales if the source is outside the band. */
const HEIGHT_MIN = 1.75, HEIGHT_MAX = 1.85, HEIGHT_TARGET = 1.8;

export interface CharacterFrame {
  dt: number;
  /** Seconds since boot, for the breath and sway phases. */
  time: number;
  /** Actual ground speed, m/s. The only thing that picks a clip. */
  speed: number;
  /** Signed yaw rate, rad/s; the body banks into it. */
  turnRate: number;
  grounded: boolean;
  airborne: boolean;
  /** -1 crouched .. +1 stretched, from the jump phases. */
  crouch: number;
  /** 1 solid, 0 invisible; the 0.2 s dissolve at a car door. */
  opacity: number;
}

export interface RigOptions {
  /** Replacement materials by source material name (pedestrian palettes). */
  materials?: Map<string, THREE.Material>;
  /** Uniform body scale on top of the height normalisation. */
  scale?: number;
  /** Start every clip this far into its cycle, so a crowd is not in lockstep. */
  phaseOffset?: number;
  castShadow?: boolean;
}

interface Track {
  name: string;
  action: THREE.AnimationAction;
  /** Metres per second the clip covers at timeScale 1. 0 for the idle pose. */
  speed: number;
  weight: number;
}

export class CharacterRig {
  readonly group = new THREE.Group();
  readonly root: THREE.Object3D;

  private readonly mixer: THREE.AnimationMixer;
  private readonly tracks: Track[] = [];
  private readonly air: THREE.AnimationAction | null;
  private readonly dance: THREE.AnimationAction | null;
  private readonly ladder: Rung[];
  private readonly spine: THREE.Bone | null;
  private readonly chest: THREE.Bone | null;
  private readonly hips: THREE.Bone | null;
  private readonly chestRest = new THREE.Vector3(1, 1, 1);
  private readonly materials: THREE.Material[] = [];

  private lean = 0;
  private leanVel = [0];
  private bank = 0;
  private bankVel = [0];
  private squash = 0;
  private lastSpeed = 0;
  private danceWeight = 0;
  private airWeight = 0;
  private dancing = false;
  private opacity = 1;

  /**
   * Hold the current pose without advancing it. A tumbling pedestrian is thrown
   * by the root transform, and a run cycle playing on a body mid-somersault
   * looks like a glitch rather than a knockdown.
   */
  frozen = false;

  constructor(source: CharacterSource, opts: RigOptions = {}) {
    this.root = cloneSkeleton(source.scene);
    this.group.add(this.root);

    // DECISION: only rescale if the export is outside the human band. Mixamo
    // writes its FBX unit scale into the file and FBX2glTF honours it, so this
    // character already arrives at 1.825 m and multiplying by anything is a way
    // to introduce error, not remove it. The clamp is here for the next
    // download, which may not have been exported the same way.
    const h = source.height;
    const fit = h >= HEIGHT_MIN && h <= HEIGHT_MAX ? 1 : HEIGHT_TARGET / Math.max(h, 0.1);
    this.root.scale.setScalar(fit * (opts.scale ?? 1));

    this.applyMaterials(opts);

    this.mixer = new THREE.AnimationMixer(this.root);
    this.ladder = buildLadder(source.info);
    const offset = opts.phaseOffset ?? 0;
    for (const rung of this.ladder) {
      const clip = source.clips.get(rung.name);
      if (!clip) continue;
      const action = this.mixer.clipAction(clip);
      action.play();
      action.enabled = true;
      action.setEffectiveWeight(0);
      action.time = (offset * clip.duration) % Math.max(clip.duration, 1e-3);
      this.tracks.push({ name: rung.name, action, speed: rung.speed, weight: 0 });
    }

    this.air = this.makeAirPose(source);
    const danceClip = source.clips.get('dance');
    this.dance = danceClip ? this.mixer.clipAction(danceClip) : null;
    if (this.dance) {
      this.dance.setLoop(THREE.LoopRepeat, Infinity);
      this.dance.play();
      this.dance.enabled = true;
      this.dance.setEffectiveWeight(0);
    }

    this.spine = findBone(this.root, 'Spine');
    this.chest = findBone(this.root, 'Spine2');
    this.hips = findBone(this.root, 'Hips');
    if (this.chest) this.chestRest.copy(this.chest.scale);

    const cast = opts.castShadow !== false;
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.castShadow = cast; m.receiveShadow = true; }
    });
  }

  /**
   * The mixer writes absolute values, so the same clip cannot be both playing
   * and frozen. The airborne pose is a clone of the run clip, held at one frame.
   */
  private makeAirPose(source: CharacterSource): THREE.AnimationAction | null {
    const run = source.clips.get('run') ?? source.clips.get('jog');
    if (!run) return null;
    const frozen = run.clone();
    frozen.name = 'air';
    const action = this.mixer.clipAction(frozen);
    action.play();
    action.enabled = true;
    action.setEffectiveWeight(0);
    // DECISION: a quarter into the cycle is the flight phase of a run -- front
    // knee driven up, back leg trailing. Picking it by fraction rather than by
    // a frame number keeps it right if the clip is ever re-exported longer.
    action.time = run.duration * A.airPhase;
    action.paused = true;
    return action;
  }

  /**
   * Swap in palette materials, or take private copies so opacity is per-rig.
   *
   * Only the copies go in `materials`: a palette material is shared by every
   * pedestrian wearing it, so fading one out -- or disposing one rig -- must not
   * reach the others.
   */
  private applyMaterials(opts: RigOptions): void {
    const seen = new Set<string>();
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const out: THREE.Material[] = [];
      for (const m of src) {
        const shared = opts.materials?.get(m.name);
        if (shared) { out.push(shared); continue; }
        const copy = m.clone();
        out.push(copy);
        if (!seen.has(copy.uuid)) { seen.add(copy.uuid); this.materials.push(copy); }
      }
      mesh.material = out.length === 1 ? out[0] : out;
    });
  }

  /** Re-dress this rig in another palette's materials (pedestrian LOD swap). */
  setPalette(materials: Map<string, THREE.Material>): void {
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const out = src.map((m) => materials.get(m.name) ?? m);
      mesh.material = out.length === 1 ? out[0] : out;
    });
  }

  /** True while the dance clip is the one driving the body. */
  get isDancing(): boolean { return this.dancing; }

  /**
   * The ground speed the feet are currently describing: every playing
   * locomotion clip's authored speed, scaled by its playback rate and weighted
   * by how much of it is showing.
   *
   * This is the honest measure of foot sliding. If it matches the speed the
   * controller is actually moving at, the contact point is planted; if it does
   * not, the character is skating by exactly the difference. The smoke suite
   * asserts on it rather than on eyeballed video.
   */
  get footSpeed(): number {
    let sum = 0;
    for (const t of this.tracks) {
      if (t.speed <= 0.05) continue;
      sum += t.action.getEffectiveWeight() * t.action.timeScale * t.speed;
    }
    return sum;
  }

  /** Per-clip weights and playback rates, for the smoke suite. */
  debug(): Record<string, { weight: number; timeScale: number }> {
    const out: Record<string, { weight: number; timeScale: number }> = {};
    for (const t of this.tracks) {
      out[t.name] = {
        weight: +t.action.getEffectiveWeight().toFixed(3),
        timeScale: +t.action.timeScale.toFixed(3),
      };
    }
    out.dance = { weight: +this.danceWeight.toFixed(3), timeScale: 1 };
    out.air = { weight: +this.airWeight.toFixed(3), timeScale: 1 };
    return out;
  }
  /** True when a dance clip was actually supplied. */
  get canDance(): boolean { return this.dance !== null; }

  startDance(): void {
    if (!this.dance) return;
    this.dance.reset();
    this.dance.play();
    this.dancing = true;
  }

  stopDance(): void { this.dancing = false; }

  update(f: CharacterFrame): void {
    const dt = Math.max(f.dt, 1e-4);
    this.stepWeights(f, dt);
    this.mixer.update(this.frozen ? 0 : dt);
    this.stepFlourish(f, dt);
    this.applyOpacity(f.opacity);
  }

  /**
   * Target weights from the ladder, eased toward over `blend`.
   *
   * A speed sits between two rungs; both play, each at its own rate, and the
   * blend is linear in speed between them. Below the bottom locomotion rung the
   * idle pose takes over. Above the top one the fastest clip is pushed by
   * timeScale until it hits the clamp.
   */
  private stepWeights(f: CharacterFrame, dt: number): void {
    const targets = new Map<string, number>();
    let scale = new Map<string, number>();
    let wantDance = 0, wantAir = 0;

    if (this.dancing && this.dance) {
      wantDance = 1;
    } else if (f.airborne && this.air) {
      wantAir = 1;
    } else if (this.ladder.length > 0) {
      // Bracket the speed between two rungs. No dead zone at the bottom: the
      // ladder's own idle rung sits at 0 m/s, so a drift of 0.1 m/s already
      // resolves to almost pure idle without a threshold to step across.
      const speed = Math.max(0, f.speed);
      let i = 0;
      while (i < this.ladder.length - 1 && this.ladder[i + 1].speed <= speed) i++;
      const lo = this.ladder[i];
      const hi = this.ladder[Math.min(i + 1, this.ladder.length - 1)];
      const span = hi.speed - lo.speed;
      const t = span > 1e-3 ? THREE.MathUtils.clamp((speed - lo.speed) / span, 0, 1) : 1;
      targets.set(lo.name, (targets.get(lo.name) ?? 0) + (1 - t));
      targets.set(hi.name, (targets.get(hi.name) ?? 0) + t);
      scale = this.strideScales(speed);
    }

    const rate = dt / Math.max(A.blend, 1e-3);
    let total = 0;
    for (const t of this.tracks) {
      t.weight = approach(t.weight, targets.get(t.name) ?? 0, rate);
      total += t.weight;
    }
    // The dance gets its own crossfade times: it is a deliberate flourish, and
    // it should arrive a little slower than a gait change and leave slower
    // still, rather than snapping back to a walk the instant a key is touched.
    const danceRate = dt / (wantDance > this.danceWeight ? A.danceIn : A.danceOut);
    this.danceWeight = approach(this.danceWeight, wantDance, danceRate);
    this.airWeight = approach(this.airWeight, wantAir, rate);
    total += this.danceWeight + this.airWeight;

    const norm = total > 1e-4 ? 1 / total : 0;
    for (const t of this.tracks) {
      t.action.setEffectiveWeight(t.weight * norm);
      t.action.timeScale = scale.get(t.name) ?? 1;
    }
    if (this.dance) this.dance.setEffectiveWeight(this.danceWeight * norm);
    if (this.air) this.air.setEffectiveWeight(this.airWeight * norm);
  }

  /**
   * Playback rate per clip: one cycle must cover the ground the character
   * actually covered, so rate = speed / the speed the clip was authored at.
   * Clamped, because a walk stretched to 4x is a cartoon and a run slowed to a
   * third is a moonwalk.
   */
  private strideScales(speed: number): Map<string, number> {
    const out = new Map<string, number>();
    for (const t of this.tracks) {
      if (t.speed <= 0.05) continue;
      out.set(t.name, THREE.MathUtils.clamp(speed / t.speed, A.timeScaleMin, A.timeScaleMax));
    }
    return out;
  }

  /**
   * Everything additive, applied after the mixer has written its absolute pose.
   *
   * The lean is the brief's; the breath and the weight shift are standing in
   * for the idle clip that was not supplied, and only fade in as the character
   * comes to rest, so they never fight a walk cycle.
   */
  private stepFlourish(f: CharacterFrame, dt: number): void {
    const accel = (f.speed - this.lastSpeed) / dt;
    this.lastSpeed = f.speed;
    const wantLean = f.airborne
      ? -AIR_LEAN
      : THREE.MathUtils.clamp(accel / 10, -1, 1) * LEAN_ACCEL;
    const wantBank = THREE.MathUtils.clamp(f.turnRate / 4, -1, 1) * LEAN_TURN;
    this.lean = smoothDamp(this.lean, wantLean, this.leanVel, F.leanSmooth, dt);
    this.bank = smoothDamp(this.bank, wantBank, this.bankVel, F.leanSmooth, dt);
    this.squash += (f.crouch - this.squash) * Math.min(1, dt * 26);

    if (this.spine) {
      this.spine.rotation.x += this.lean + Math.max(0, -this.squash) * 0.2;
      this.spine.rotation.z += this.bank;
    }

    // Still-and-standing only: 1 at a dead stop, 0 by the time a walk reads.
    const still = this.dancing ? 0 : 1 - THREE.MathUtils.clamp(f.speed / A.idleSpeed, 0, 1);
    if (still > 0.01) {
      if (this.chest) {
        const breath = 1 + Math.sin(f.time * Math.PI * 2 * A.breathHz) * A.breathScale * still;
        this.chest.scale.set(this.chestRest.x, this.chestRest.y * breath, this.chestRest.z * breath);
      }
      if (this.hips) {
        const sway = Math.sin(f.time * Math.PI * 2 * A.swayHz) * SWAY * still;
        this.hips.rotation.z += sway;
        this.hips.position.x += sway * 0.4;
      }
    } else if (this.chest) {
      this.chest.scale.copy(this.chestRest);
    }
  }

  private applyOpacity(opacity: number): void {
    if (Math.abs(opacity - this.opacity) < 0.001) return;
    this.opacity = opacity;
    const solid = opacity >= 0.999;
    for (const m of this.materials) {
      const std = m as THREE.MeshStandardMaterial;
      const wasTransparent = std.transparent;
      std.opacity = opacity;
      std.transparent = !solid;
      std.depthWrite = solid;
      if (wasTransparent !== std.transparent) std.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.group.removeFromParent();
    for (const m of this.materials) m.dispose();
  }
}

function approach(cur: number, target: number, rate: number): number {
  const d = target - cur;
  return Math.abs(d) <= rate ? target : cur + Math.sign(d) * rate;
}
