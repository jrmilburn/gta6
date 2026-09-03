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
import type { CharacterSource } from '../core/character';
import { BoneOffsets } from './boneOffsets';
import { Locomotion } from './characterLocomotion';
import { Layer, measureImpact, measureTakeOff, upperBodyAdditive } from './characterActions';
import { RigMaterials } from './characterMaterials';
import { Flourish } from './characterFlourish';

const A = CFG.anim;
/** Target standing height; the rig only rescales if the source is outside the band. */
const HEIGHT_MIN = 1.75, HEIGHT_MAX = 1.85, HEIGHT_TARGET = 1.8;
/**
 * How long the character is actually off the ground, from playerJump.ts's own
 * constants: rise and fall for a 1.2 m jump under 22 m/s^2, plus the apex hang.
 * The jump clip is fitted to this rather than the other way round -- the arc is
 * tuned and the clip is not.
 */
const AIR_TIME = 2 * Math.sqrt((2 * 1.2) / 22) + CFG.feel.foot.hangTime;

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

export class CharacterRig {
  readonly group = new THREE.Group();
  readonly root: THREE.Object3D;

  /** The speed-driven blend. Public so callers can toggle goofy mode. */
  readonly locomotion: Locomotion;
  /** Full-body one-shots: the jump, a knockdown. */
  readonly oneShot = new Layer();
  /** Additive upper-body overlays: a punch, a shot, a held aim pose. */
  readonly overlay = new Layer();

  private readonly mixer: THREE.AnimationMixer;
  private readonly source: CharacterSource;
  private readonly air: THREE.AnimationAction | null;
  private readonly dance: THREE.AnimationAction | null;
  /** Additive upper-body copies, built on first use and cached. */
  private readonly additive = new Map<string, THREE.AnimationAction>();
  /** Owns the per-rig material copies, the palette swap and the door fade. */
  private readonly skins: RigMaterials;
  /** Reversible procedural pose adjustments; see boneOffsets.ts. */
  private readonly offsets = new BoneOffsets();
  /** Lean, breath, weight shift and the aim arm; see characterFlourish.ts. */
  private readonly flourish: Flourish;

  /** Extra pitch applied to the gun arm so it tracks the camera (section 7). */
  /** Cached measurement of the jump clip's take-off frame; -1 until measured. */
  private jumpTakeOff = -1;
  private aimPitch = 0;
  private aimAmount = 0;
  private danceWeight = 0;
  private airWeight = 0;
  private dancing = false;

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

    this.skins = new RigMaterials(this.root, opts.materials);

    this.source = source;
    this.mixer = new THREE.AnimationMixer(this.root);
    this.locomotion = new Locomotion(this.mixer, source, opts.phaseOffset ?? 0);
    this.air = this.makeAirPose(source);
    const danceClip = source.clips.get('dance');
    this.dance = danceClip ? this.mixer.clipAction(danceClip) : null;
    if (this.dance) {
      this.dance.setLoop(THREE.LoopRepeat, Infinity);
      this.dance.play();
      this.dance.enabled = true;
      this.dance.setEffectiveWeight(0);
    }

    this.flourish = new Flourish(this.root, this.offsets);

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

  /** Re-dress this rig in another palette's materials (pedestrian LOD swap). */
  setPalette(materials: Map<string, THREE.Material>): void { this.skins.setPalette(materials); }

  /** True while the dance clip is the one driving the body. */
  get isDancing(): boolean { return this.dancing; }

  /**
   * The ground speed the feet are currently describing.
   *
   * The honest measure of foot sliding: if it matches the speed the controller
   * is actually moving at, the contact point is planted; if it does not, the
   * character is skating by exactly the difference. The smoke suite asserts on
   * it rather than on eyeballed video.
   */
  get footSpeed(): number { return this.locomotion.footSpeed; }

  /** Per-clip weights and playback rates, for the smoke suite. */
  debug(): Record<string, { weight: number; timeScale: number }> {
    const out: Record<string, { weight: number; timeScale: number }> = {};
    this.locomotion.debug(out);
    out.dance = { weight: +this.danceWeight.toFixed(3), timeScale: 1 };
    out.air = { weight: +this.airWeight.toFixed(3), timeScale: 1 };
    out.oneShot = { weight: +this.oneShot.weight.toFixed(3), timeScale: 1 };
    out.overlay = { weight: +this.overlay.weight.toFixed(3), timeScale: 1 };
    return out;
  }

  /** Names of every clip carrying `role`, for callers that pick at random. */
  clipsWithRole(role: 'many' | 'once'): string[] { return this.source.byRole(role); }

  /** True when a clip of that name was supplied. */
  has(name: string): boolean { return this.source.clips.has(name); }

  /** Seconds `name` runs for, or 0 if it was not supplied. */
  durationOf(name: string): number { return this.source.info.get(name)?.duration ?? 0; }

  /**
   * Play a full-body one-shot: the jump, a knockdown. It takes the character
   * over for its duration, and the locomotion blend fades down by exactly how
   * much of it is showing rather than stopping, so the landing eases back into
   * whatever the legs were doing.
   */
  playOneShot(
    name: string,
    opts: { blendIn?: number; blendOut?: number; timeScale?: number; hold?: boolean; from?: number } = {},
  ): boolean {
    const clip = this.source.clips.get(name);
    if (!clip) return false;
    this.oneShot.play(this.mixer.clipAction(clip), name, opts);
    return true;
  }

  /**
   * Play an additive upper-body overlay: a punch, a shot, a held aim pose.
   * The legs keep the locomotion blend untouched (see characterActions.ts).
   */
  playOverlay(
    name: string,
    opts: {
      blendIn?: number; blendOut?: number; timeScale?: number;
      hold?: boolean; from?: number; loop?: boolean;
    } = {},
  ): boolean {
    const action = this.additiveAction(name);
    if (!action) return false;
    this.overlay.play(action, name, opts);
    return true;
  }

  /** Hold an overlay frozen on one frame -- an aim pose from a firing clip. */
  freezeOverlay(at: number): void { this.overlay.freeze(at); }

  /** Drive the overlay's weight directly, for a pose held part-way in. */
  setOverlayWeight(w: number): void { this.overlay.setTarget(w); }

  private additiveAction(name: string): THREE.AnimationAction | null {
    const cached = this.additive.get(name);
    if (cached) return cached;
    const clip = this.source.clips.get(name);
    if (!clip) return null;
    // A pistol clip is a pose and is measured against the idle; a punch is a
    // motion and is measured against its own start. See upperBodyAdditive.
    const reference = name.startsWith('pistol') ? this.source.clips.get('idle') : undefined;
    const action = this.mixer.clipAction(upperBodyAdditive(clip, reference));
    action.blendMode = THREE.AdditiveAnimationBlendMode;
    action.setEffectiveWeight(0);
    this.additive.set(name, action);
    return action;
  }

  /** Where in `name` the fist arrives, as a fraction of its duration. */
  impactOf(name: string): number {
    const clip = this.source.clips.get(name);
    return clip ? measureImpact(this.source, clip) : 0.45;
  }

  /** Where in `name` the feet leave the ground, in seconds. */
  takeOffOf(name: string): number {
    const clip = this.source.clips.get(name);
    return clip ? measureTakeOff(clip) : 0;
  }

  /**
   * Play the jump clip and report its wind-up, so the controller can hold the
   * impulse until the animation's own take-off frame (section 4).
   *
   * The clip is stretched or squeezed to fit the airborne time the physics will
   * actually produce, within the clamp the brief sets; past that it is simply
   * cut short by the landing crossfade.
   */
  jump(): number | null {
    if (!this.has('jump')) return null;
    if (this.jumpTakeOff < 0) this.jumpTakeOff = this.takeOffOf('jump');
    const air = Math.max(0.1, this.durationOf('jump') - this.jumpTakeOff);
    const rate = THREE.MathUtils.clamp(air / Math.max(AIR_TIME, 0.1), 1, 1.5);
    this.playOneShot('jump', { blendIn: 0.1, blendOut: 0.15, timeScale: rate });
    return this.jumpTakeOff;
  }

  /** The feet are down: hand the body back to the locomotion blend. */
  land(): void {
    if (this.oneShot.clip === 'jump') this.oneShot.stop();
  }

  /**
   * Point the gun arm along the camera's pitch (section 7).
   *
   * `amount` fades it in with the draw; `pitch` is the camera's elevation. The
   * supplied Shooting clip holds the pistol level, and level is wrong the
   * moment the player looks up or down -- so the elevation is added to the arm
   * procedurally while the clip keeps the pose and the grip.
   */
  setAim(amount: number, pitch: number): void {
    this.aimAmount = THREE.MathUtils.clamp(amount, 0, 1);
    this.aimPitch = pitch;
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
    // Undo before the mixer, apply after it. three stops writing a bone whose
    // mixed value has not changed -- which is every bone of a static idle pose --
    // so without the undo the additions below compound instead of replacing.
    this.offsets.clear();
    this.oneShot.update(dt);
    this.overlay.update(dt);
    this.stepWeights(f, dt);
    this.mixer.update(this.frozen ? 0 : dt);
    this.flourish.step(f, dt, this.dancing, this.aimAmount, this.aimPitch);
    this.skins.setOpacity(f.opacity);
  }

  /**
   * Hand the body out between the locomotion blend, the dance, the airborne
   * pose and a full-body one-shot.
   *
   * Everything but the overlay competes for the same 1.0 of weight; the overlay
   * is additive and sits on top of whatever this produces.
   */
  private stepWeights(f: CharacterFrame, dt: number): void {
    let wantDance = 0, wantAir = 0;
    if (this.dancing && this.dance) wantDance = 1;
    else if (f.airborne && this.air && !this.oneShot.active) wantAir = 1;

    // The dance gets its own crossfade times: it is a deliberate flourish, and
    // it should arrive a little slower than a gait change and leave slower
    // still, rather than snapping back to a walk the instant a key is touched.
    const danceRate = dt / (wantDance > this.danceWeight ? A.danceIn : A.danceOut);
    this.danceWeight = approach(this.danceWeight, wantDance, danceRate);
    const rate = dt / Math.max(A.blend, 1e-3);
    this.airWeight = approach(this.airWeight, wantAir, rate);

    // Anything that takes the whole body over takes it from the locomotion
    // blend, in this order of precedence.
    const taken = THREE.MathUtils.clamp(
      this.danceWeight + this.airWeight + this.oneShot.weight, 0, 1,
    );
    const locomotion = this.locomotion.step(f.speed, dt, taken);

    // Normalise against what the blend actually produced, so the total across
    // every non-additive action stays at one and the pose never washes out.
    const total = locomotion + this.danceWeight + this.airWeight + this.oneShot.weight;
    const norm = total > 1e-4 ? 1 / total : 0;
    if (this.dance) this.dance.setEffectiveWeight(this.danceWeight * norm);
    if (this.air) this.air.setEffectiveWeight(this.airWeight * norm);
    if (this.oneShot.action) this.oneShot.action.setEffectiveWeight(this.oneShot.weight * norm);
  }

  dispose(): void {
    this.offsets.dispose();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.group.removeFromParent();
    this.skins.dispose();
  }
}

function approach(cur: number, target: number, rate: number): number {
  const d = target - cur;
  return Math.abs(d) <= rate ? target : cur + Math.sign(d) * rate;
}
