// One-shot clips and upper-body overlays for the character rig.
//
// Two kinds of thing play on top of the locomotion blend.
//
// A *one-shot* is full body -- a jump, a knockdown -- and takes the whole
// character over for its duration, so the locomotion weights are scaled down by
// however much of it is showing.
//
// An *overlay* is upper body only -- a punch, a shot -- and must leave the legs
// walking. DECISION: overlays are additive rather than the track-exclusion the
// brief describes. Excluding the leg tracks does stop a punch driving the legs,
// but three blends every action that shares a binding by weighted average, so a
// punch at weight 1 against a walk at weight 1 is a half-hearted punch, and
// getting a whole one means pushing the punch's weight to four or five and
// hoping. An additive action adds its delta to whatever the blend produced, so
// weight 1 means exactly one punch on top of exactly one walk. The leg and hip
// tracks are still excluded, so the additive delta cannot reach them.
import * as THREE from 'three';
import { findBone, type CharacterSource } from '../core/character';

/**
 * Bones an upper-body overlay is allowed to move. Everything from the spine up,
 * plus both arms; the hips and both legs are the locomotion blend's business.
 */
const UPPER = /(Spine\d?|Neck|Head|HeadTop_End|Shoulder|Arm|ForeArm|Hand\w*)$/;

/**
 * An additive, upper-body-only copy of `clip`.
 *
 * `reference` is what the delta is measured against, and choosing it wrongly is
 * the difference between a working overlay and one that does nothing at all.
 *
 * For a *motion* -- a punch -- the clip's own first frame is right: the delta is
 * "what this punch does, relative to standing ready to throw it", which
 * composes onto a walk, a jog or an idle without any of them agreeing on a rest
 * pose.
 *
 * For a *pose* -- standing holding a pistol -- it is exactly wrong. That clip's
 * first frame already has the arms up, so measuring against it subtracts the
 * arm raise and leaves nothing but the sway. Those clips pass the idle as the
 * reference instead, and the delta becomes "raise the pistol from where the
 * arms would otherwise be", which is the thing worth adding.
 */
export function upperBodyAdditive(
  clip: THREE.AnimationClip, reference?: THREE.AnimationClip,
): THREE.AnimationClip {
  const out = clip.clone();
  out.tracks = out.tracks.filter((t) => UPPER.test(t.name.split('.')[0]));
  THREE.AnimationUtils.makeClipAdditive(out, 0, reference ?? out);
  out.name = `${clip.name}:additive`;
  return out;
}

/**
 * When in the clip the fist actually arrives, as a fraction of its duration.
 *
 * Measured, not guessed: the clip is stepped through on the source skeleton and
 * the frame where the right hand reaches furthest from the hips along the
 * body's own forward axis is the impact. The brief's "roughly 40 to 50%" is a
 * good guess for a jab and wrong for a combo -- the five supplied punches land
 * anywhere from a third to four fifths of the way through.
 */
export function measureImpact(source: CharacterSource, clip: THREE.AnimationClip): number {
  const root = source.scene;
  const hand = findBone(root, 'RightHand');
  const hips = findBone(root, 'Hips');
  if (!hand || !hips) return 0.45;

  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.play();
  action.setEffectiveWeight(1);

  const handPos = new THREE.Vector3();
  const hipsPos = new THREE.Vector3();
  const SAMPLES = 40;
  let best = 0.45, bestReach = -Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i / (SAMPLES - 1)) * clip.duration;
    action.time = t;
    mixer.update(0);
    root.updateMatrixWorld(true);
    hand.getWorldPosition(handPos);
    hips.getWorldPosition(hipsPos);
    // Reach in the horizontal plane, which is what a punch is; the vertical
    // component would make an overhead swing look like the longest reach.
    const reach = Math.hypot(handPos.x - hipsPos.x, handPos.z - hipsPos.z);
    if (reach > bestReach) { bestReach = reach; best = i / (SAMPLES - 1); }
  }
  action.stop();
  mixer.uncacheAction(clip, root);
  mixer.uncacheRoot(root);
  return best;
}

/**
 * When in the jump clip the feet leave the ground, in seconds.
 *
 * Read straight off the hips height track: the first sample that rises more
 * than a centimetre above where the clip started is the take-off. Section 4
 * uses it to line the clip up with the physics impulse rather than letting the
 * character launch during its own crouch.
 */
export function measureTakeOff(clip: THREE.AnimationClip): number {
  for (const track of clip.tracks) {
    if (!/Hips\.position$/.test(track.name)) continue;
    const v = track.values;
    const base = v[1];
    for (let i = 0; i < track.times.length; i++) {
      if (v[i * 3 + 1] > base + 0.01) return track.times[i];
    }
  }
  return 0;
}

/**
 * One action slot with an eased weight.
 *
 * Used for both kinds of layer. `blendIn`/`blendOut` are seconds; `weight` is
 * what the rig reads to know how much of the locomotion blend to give up (for a
 * one-shot) or simply how loud the overlay is (for an additive one).
 */
export class Layer {
  weight = 0;
  action: THREE.AnimationAction | null = null;
  /** Name of the clip currently loaded, so a caller can avoid repeats. */
  clip: string | null = null;

  private target = 0;
  private blendIn = 0.1;
  private blendOut = 0.15;
  /**
   * Hold the last frame at full weight instead of fading out when the clip
   * ends. A knocked-down pedestrian lies on the ground; without this the fall
   * would play, fade, and hand the body back to the walk cycle.
   */
  private holding = false;

  /** True while the slot has anything to show. */
  get active(): boolean { return this.action !== null && (this.weight > 0.001 || this.target > 0); }

  /**
   * True while the clip is still travelling toward its end.
   *
   * A held clip that has arrived is finished, even though its weight stays: a
   * firing clip played with `hold` used to count as running for as long as it
   * was loaded, so the stance that should replace it when the shot was over
   * never came back and the arms stayed locked on the recoil frame -- most
   * visibly when the player jogged off afterwards with the gun still out.
   */
  get running(): boolean {
    return this.action !== null && this.target > 0 && !this.atEnd();
  }

  /**
   * Has the playhead reached the end it is travelling toward?
   *
   * Which end that is depends on the sign of the rate: a knockdown played in
   * reverse as a get-up starts at the last frame and finishes at the first, and
   * testing only the forward end would call it finished on the frame it began.
   */
  private atEnd(): boolean {
    if (!this.action) return true;
    const d = this.action.getClip().duration;
    if (d <= 0) return true;
    return this.action.timeScale < 0 ? this.action.time <= 1e-4 : this.action.time >= d - 1e-4;
  }

  /** Drive the weight directly, for a pose held at a fraction of full. */
  setTarget(weight: number): void { this.target = Math.max(0, Math.min(1, weight)); }

  /** Let a frozen pose play through, from the top. */
  resume(): void {
    if (!this.action) return;
    this.action.paused = false;
    this.action.time = 0;
  }

  /** True while a frozen pose is playing rather than being held. */
  get playing(): boolean { return this.action !== null && !this.action.paused; }

  /** How far through the clip, 0..1. */
  get progress(): number {
    if (!this.action) return 0;
    const d = this.action.getClip().duration;
    return d > 0 ? Math.min(1, this.action.time / d) : 1;
  }

  /**
   * Start `action` from the top. `hold` keeps it at full weight on its last
   * frame until stopped, which is what a body on the ground needs.
   */
  play(
    action: THREE.AnimationAction, name: string,
    opts: {
      blendIn?: number; blendOut?: number; timeScale?: number;
      hold?: boolean; from?: number; loop?: boolean;
    } = {},
  ): void {
    if (this.action && this.action !== action) {
      this.action.stop();
      this.action.setEffectiveWeight(0);
    }
    this.action = action;
    this.clip = name;
    this.blendIn = opts.blendIn ?? 0.1;
    this.blendOut = opts.blendOut ?? 0.15;
    this.holding = opts.hold === true;
    this.target = 1;
    action.reset();
    action.timeScale = opts.timeScale ?? 1;
    action.time = opts.from ?? 0;
    // Once and clamped unless a caller asks for a loop. `holding` decides
    // whether the weight fades when the clip ends, not whether the clip loops --
    // a knockdown that looped would fall over on the ground forever, while a
    // standing pistol idle has to keep breathing.
    const loop = opts.loop === true;
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    action.paused = false;
    action.enabled = true;
    action.play();
  }

  /** Freeze the current action on one frame, for a held pose from a moving clip. */
  freeze(at: number): void {
    if (!this.action) return;
    this.action.time = at;
    this.action.paused = true;
  }

  stop(): void { this.target = 0; this.holding = false; }

  update(dt: number): void {
    if (!this.action) return;
    // A one-shot that has reached its last frame starts fading out on its own.
    if (!this.holding && this.target > 0 && !this.action.paused
      && this.action.loop !== THREE.LoopRepeat && this.atEnd()) {
      this.target = 0;
    }
    const rate = dt / Math.max(this.target > this.weight ? this.blendIn : this.blendOut, 1e-3);
    const delta = this.target - this.weight;
    this.weight = Math.abs(delta) <= rate ? this.target : this.weight + Math.sign(delta) * rate;
    this.action.setEffectiveWeight(this.weight);
    if (this.weight <= 0.001 && this.target === 0) {
      this.action.stop();
      this.action = null;
      this.clip = null;
    }
  }
}
