// Everything the mixer cannot express, applied on top of the pose it wrote.
//
// The spine lean is the movement pass's; the breath and the weight shift stand
// in for the idle clip the supplied set does not include; the arm pitch points
// a drawn pistol where the camera is looking. All of it goes through
// BoneOffsets rather than straight onto the bones -- see the note there, which
// is the whole reason this file separates "what to add" from "how to add it".
import * as THREE from 'three';
import { CFG } from '../config';
import { smoothDamp } from '../core/smooth';
import { findBone } from '../core/character';
import type { BoneOffsets } from './boneOffsets';
import type { CharacterFrame } from './characterRig';

const A = CFG.anim;
const F = CFG.feel.foot;
const LEAN_ACCEL = (F.leanAccelDeg * Math.PI) / 180;
const LEAN_TURN = (F.leanTurnDeg * Math.PI) / 180;
const AIR_LEAN = (A.airLeanDeg * Math.PI) / 180;
const SWAY = (A.swayDeg * Math.PI) / 180;

export class Flourish {
  private readonly spine: THREE.Bone | null;
  private readonly chest: THREE.Bone | null;
  private readonly hips: THREE.Bone | null;
  /** Thighs then shins, for the sitting pose. */
  private readonly legs: Array<THREE.Bone | null>;
  /** 0..1 blend into the held pose, so it arrives over a few frames. */
  private poseAmount = 0;
  private pose: 'swim' | 'sit' | 'lean' | 'ride' | null = null;
  private readonly rightArm: THREE.Bone | null;
  private readonly rightForeArm: THREE.Bone | null;
  private readonly chestRest = new THREE.Vector3(1, 1, 1);

  private lean = 0;
  private leanVel = [0];
  private bank = 0;
  private bankVel = [0];
  private squash = 0;
  private lastSpeed = 0;

  constructor(root: THREE.Object3D, private readonly offsets: BoneOffsets) {
    this.spine = findBone(root, 'Spine');
    this.chest = findBone(root, 'Spine2');
    this.hips = findBone(root, 'Hips');
    this.legs = [
      findBone(root, 'LeftUpLeg'), findBone(root, 'RightUpLeg'),
      findBone(root, 'LeftLeg'), findBone(root, 'RightLeg'),
    ];
    this.rightArm = findBone(root, 'RightArm');
    this.rightForeArm = findBone(root, 'RightForeArm');
    if (this.chest) this.chestRest.copy(this.chest.scale);
  }

  /**
   * Held whole-body poses, without a clip for any of them.
   *
   * Swim: the body pitched forward onto the water with the legs trailing.
   * Sit: thighs forward and shins down, the hips lowered by the rig. Lean:
   * the spine forward over a rail. Ride: a light sit. All are bone offsets on
   * top of the idle, blended in over a quarter of a second.
   */
  private stepPose(f: CharacterFrame, dt: number): void {
    const want = f.pose ?? null;
    if (want !== this.pose) {
      // Switching directly between two poses passes through the standing pose,
      // which is what a person does too.
      if (this.poseAmount <= 0.02 || want === null) { this.pose = want ?? this.pose; }
    }
    const target = want === this.pose && want !== null ? 1 : 0;
    this.poseAmount += (target - this.poseAmount) * Math.min(1, dt * 7);
    if (this.poseAmount < 0.01) { if (want === null) this.pose = null; return; }
    const a = this.poseAmount;
    const [lThigh, rThigh, lShin, rShin] = this.legs;
    switch (this.pose) {
      case 'swim':
        this.offsets.rotate(this.hips, 1, 0, 0, 1.25 * a);
        this.offsets.rotate(lThigh, 1, 0, 0, -0.25 * a);
        this.offsets.rotate(rThigh, 1, 0, 0, -0.25 * a);
        break;
      case 'sit':
      case 'ride':
        this.offsets.rotate(lThigh, 1, 0, 0, -1.45 * a);
        this.offsets.rotate(rThigh, 1, 0, 0, -1.45 * a);
        this.offsets.rotate(lShin, 1, 0, 0, 1.5 * a);
        this.offsets.rotate(rShin, 1, 0, 0, 1.5 * a);
        this.offsets.rotate(this.spine, 1, 0, 0, 0.12 * a);
        break;
      case 'lean':
        this.offsets.rotate(this.spine, 1, 0, 0, 0.32 * a);
        this.offsets.rotate(this.hips, 1, 0, 0, 0.1 * a);
        break;
      default:
        break;
    }
  }

  step(f: CharacterFrame, dt: number, dancing: boolean, aim: number, aimPitch: number): void {
    const accel = (f.speed - this.lastSpeed) / dt;
    this.lastSpeed = f.speed;
    const wantLean = f.airborne
      ? -AIR_LEAN
      : THREE.MathUtils.clamp(accel / 10, -1, 1) * LEAN_ACCEL;
    const wantBank = THREE.MathUtils.clamp(f.turnRate / 4, -1, 1) * LEAN_TURN;
    this.lean = smoothDamp(this.lean, wantLean, this.leanVel, F.leanSmooth, dt);
    this.bank = smoothDamp(this.bank, wantBank, this.bankVel, F.leanSmooth, dt);
    this.squash += (f.crouch - this.squash) * Math.min(1, dt * 26);

    this.offsets.rotate(this.spine, 1, 0, 0, this.lean + Math.max(0, -this.squash) * 0.2);
    this.offsets.rotate(this.spine, 0, 0, 1, this.bank);
    this.stepPose(f, dt);

    // Still-and-standing only: 1 at a dead stop, 0 by the time a walk reads.
    const still = dancing ? 0 : 1 - THREE.MathUtils.clamp(f.speed / A.idleSpeed, 0, 1);
    if (still > 0.01) {
      if (this.chest) {
        // Scale is set absolutely rather than through the offsets, because no
        // clip in the set animates scale -- so there is no mixed value to
        // preserve here, and the bind pose is the whole base.
        const breath = 1 + Math.sin(f.time * Math.PI * 2 * A.breathHz) * A.breathScale * still;
        this.chest.scale.set(this.chestRest.x, this.chestRest.y * breath, this.chestRest.z * breath);
      }
      const sway = Math.sin(f.time * Math.PI * 2 * A.swayHz) * SWAY * still;
      this.offsets.rotate(this.hips, 0, 0, 1, sway);
      this.offsets.translate(this.hips, sway * 0.4, 0, 0);
    } else if (this.chest) {
      this.chest.scale.copy(this.chestRest);
    }

    // The gun arm follows the camera's elevation. Split between upper arm and
    // forearm so the elbow bends with it rather than the whole limb pivoting at
    // the shoulder. The supplied Shooting clip holds the pistol level, and
    // level is wrong the moment the player looks up or down.
    if (aim > 0.01) {
      const pitch = -aimPitch * aim;
      this.offsets.rotate(this.rightArm, 1, 0, 0, pitch * 0.65);
      this.offsets.rotate(this.rightForeArm, 1, 0, 0, pitch * 0.35);
    }
  }
}
