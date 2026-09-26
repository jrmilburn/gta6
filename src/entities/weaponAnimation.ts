import * as THREE from 'three';
import { findBone } from '../core/character';
import type { WeaponId } from './weaponMesh';

export const WEAPON_GRIPS: Record<WeaponId, { primary: [number, number, number]; support: [number, number, number] | null; recoil: number }> = {
  pistol: { primary: [-0.030, 0.030, 0.022], support: null, recoil: 0.045 },
  mg: { primary: [-0.030, 0.035, 0.022], support: [0, 0.005, 0.18], recoil: 0.025 },
  sniper: { primary: [-0.040, 0.045, 0.022], support: [0, 0.005, 0.28], recoil: 0.075 },
  rpg: { primary: [-0.020, 0.065, 0.022], support: [0, -0.025, 0.16], recoil: 0.055 },
};

export function fitPlayerWeapon(gun: THREE.Object3D, id: WeaponId): void {
  // Fingers point down the grip; the palm sits beside it and curls across its width.
  gun.quaternion.set(Math.SQRT1_2, 0, -Math.SQRT1_2, 0);
  gun.position.fromArray(WEAPON_GRIPS[id].primary);
}

/** Cached analytic two-bone IK after the mixer, with a downward elbow pole. */
export class WeaponAnimation {
  private readonly right: THREE.Bone[];
  private readonly left: THREE.Bone[];
  private readonly saved: Array<{ bone: THREE.Bone; q: THREE.Quaternion }>;
  private applied = false;
  private gun: THREE.Object3D | null = null;
  private camera: THREE.Camera | null = null;
  private id: WeaponId = 'pistol';
  private amount = 0;
  private weight = 0;
  private aiming = false;
  private aimWeight = 0;
  private readonly chest: THREE.Bone | null;
  private readonly grips: THREE.SkinnedMesh[] = [];
  private kick = 0;
  private readonly socket = new THREE.Quaternion();
  private readonly supportRotation = new THREE.Quaternion(0, Math.SQRT1_2, Math.SQRT1_2, 0);
  private readonly p = new THREE.Vector3();
  private readonly end = new THREE.Vector3();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly support = new THREE.Vector3();
  private readonly joint = new THREE.Vector3();
  private readonly elbowTarget = new THREE.Vector3();
  private readonly reach = new THREE.Vector3();
  private readonly pole = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly parentQ = new THREE.Quaternion();
  private readonly inverse = new THREE.Quaternion();
  private readonly desired = new THREE.Quaternion();
  private readonly matrix = new THREE.Matrix4();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(private readonly root: THREE.Object3D) {
    const chain = (side: string) => ['Arm', 'ForeArm', 'Hand'].map(n => findBone(root, side + n)).filter((b): b is THREE.Bone => !!b);
    this.right = chain('Right'); this.left = chain('Left');
    this.chest = findBone(root, 'Spine2');
    this.saved = [...this.right, ...this.left, ...(this.chest ? [this.chest] : [])].map(bone => ({ bone, q: new THREE.Quaternion() }));
    root.traverse(o => { const mesh = o as THREE.SkinnedMesh; if (mesh.isSkinnedMesh && mesh.morphTargetDictionary?.gripRight !== undefined) this.grips.push(mesh); });
  }
  configure(gun: THREE.Object3D, id: WeaponId, camera: THREE.Camera, amount: number, aiming: boolean): void {
    if (gun !== this.gun) this.socket.copy(gun.quaternion);
    this.gun = gun; this.id = id; this.camera = camera; this.amount = amount;
    this.aiming = aiming;
  }
  recoil(id: WeaponId): void { this.kick = Math.min(0.12, this.kick + WEAPON_GRIPS[id].recoil); }
  restore(): void {
    if (this.applied) for (const s of this.saved) s.bone.quaternion.copy(s.q);
    this.applied = false;
  }
  private solve(chain: THREE.Bone[], target: THREE.Vector3, weight: number): void {
    if (chain.length !== 3) return;
    chain[0].getWorldPosition(this.p);
    chain[1].getWorldPosition(this.joint);
    chain[2].getWorldPosition(this.end);
    const upper = this.p.distanceTo(this.joint), lower = this.joint.distanceTo(this.end);
    if (upper < 0.001 || lower < 0.001) return;
    this.reach.copy(target).sub(this.p);
    const distance = THREE.MathUtils.clamp(this.reach.length(), Math.abs(upper - lower) + 0.001, upper + lower - 0.001);
    this.reach.normalize();
    const along = (upper * upper - lower * lower + distance * distance) / (2 * distance);
    const bend = Math.sqrt(Math.max(0, upper * upper - along * along));
    this.pole.set(0, -1, 0).addScaledVector(this.reach, this.reach.y);
    if (this.pole.lengthSq() < 0.01) this.pole.set(1, 0, 0).addScaledVector(this.reach, -this.reach.x);
    this.pole.normalize();
    this.elbowTarget.copy(this.p).addScaledVector(this.reach, along).addScaledVector(this.pole, bend);
    this.rotateToward(chain[0], chain[1], this.elbowTarget, weight);
    this.rotateToward(chain[1], chain[2], target, weight);
  }
  private rotateToward(bone: THREE.Bone, end: THREE.Bone, target: THREE.Vector3, weight: number): void {
    bone.getWorldPosition(this.p); end.getWorldPosition(this.end);
    this.a.copy(this.end).sub(this.p).normalize();
    this.b.copy(target).sub(this.p).normalize();
    this.q.setFromUnitVectors(this.a, this.b);
    bone.parent!.getWorldQuaternion(this.parentQ);
    this.q.premultiply(this.inverse.copy(this.parentQ).invert()).multiply(this.parentQ);
    this.desired.copy(bone.quaternion).premultiply(this.q);
    bone.quaternion.slerp(this.desired, weight);
    bone.updateWorldMatrix(false, false);
  }
  update(dt: number, suppress: boolean): void {
    this.weight = THREE.MathUtils.damp(this.weight, suppress ? 0 : this.amount, 18, dt);
    this.aimWeight = THREE.MathUtils.damp(this.aimWeight, this.aiming ? 1 : 0, 18, dt);
    this.kick *= Math.exp(-22 * dt);
    for (const mesh of this.grips) {
      mesh.morphTargetInfluences![mesh.morphTargetDictionary!.gripRight] = this.weight;
      mesh.morphTargetInfluences![mesh.morphTargetDictionary!.gripLeft] = WEAPON_GRIPS[this.id].support ? this.weight : 0;
    }
    if (!this.gun || !this.camera || this.right.length !== 3 || this.weight < 0.001) return;
    for (const s of this.saved) s.q.copy(s.bone.quaternion);
    this.applied = true;
    this.root.updateWorldMatrix(true, true);
    // Same camera centre ray as hitscan; converge at its distant aim point.
    this.camera.getWorldDirection(this.direction);
    this.root.getWorldQuaternion(this.q);
    this.b.set(0, -0.4, 1).normalize().applyQuaternion(this.q);
    this.direction.lerpVectors(this.b, this.direction, this.aimWeight).normalize();
    this.aim.copy(this.camera.position).addScaledVector(this.direction, 100);
    if (this.chest) {
      this.a.copy(this.direction).applyQuaternion(this.q.invert());
      const yaw = THREE.MathUtils.clamp(Math.atan2(this.a.x, this.a.z), -0.7, 0.7) * 0.5 * this.weight;
      this.q.setFromAxisAngle(this.up, yaw);
      this.chest.quaternion.multiply(this.q);
      this.q.setFromAxisAngle(this.a.set(1, 0, 0), -this.kick * 0.5);
      this.chest.quaternion.multiply(this.q);
      this.chest.updateWorldMatrix(false, true);
    }
    this.right[0].getWorldPosition(this.target);
    const twoHanded = WEAPON_GRIPS[this.id].support !== null;
    if (twoHanded && this.left.length === 3) {
      this.left[0].getWorldPosition(this.b);
      this.target.lerp(this.b, 0.45);
    }
    this.target.addScaledVector(this.direction, (twoHanded ? 0.16 : 0.34) - this.kick);
    this.target.y -= THREE.MathUtils.lerp(twoHanded ? 0.12 : 0.22, 0.08, this.aimWeight);
    this.solve(this.right, this.target, this.weight);
    const hand = this.right[2];
    this.orientPrimaryHand(hand);
    const grip = WEAPON_GRIPS[this.id].support;
    if (grip && this.left.length === 3) {
      // Fit the shared weapon target inside both arms' reach, including short rigs.
      for (let pass = 0; pass < 2; pass++) {
        this.supportTarget(grip);
        this.left[0].getWorldPosition(this.p);
        this.left[1].getWorldPosition(this.joint);
        this.left[2].getWorldPosition(this.end);
        const reach = this.p.distanceTo(this.joint) + this.joint.distanceTo(this.end) - 0.012;
        this.b.copy(this.p).sub(this.support);
        const distance = this.b.length();
        if (distance <= reach) break;
        this.target.addScaledVector(this.b, (distance - reach) / distance);
        this.solve(this.right, this.target, this.weight);
        this.orientPrimaryHand(hand);
      }
      this.supportTarget(grip);
      this.solve(this.left, this.support, this.weight);
      const leftHand = this.left[2];
      this.gun.getWorldQuaternion(this.desired);
      this.desired.multiply(this.supportRotation);
      leftHand.parent!.getWorldQuaternion(this.parentQ).invert();
      this.desired.premultiply(this.parentQ);
      leftHand.quaternion.slerp(this.desired, this.weight);
      leftHand.updateWorldMatrix(false, true);
    } else if (this.left.length === 3) {
      this.left[0].getWorldPosition(this.support);
      this.support.y -= 0.40;
      this.support.addScaledVector(this.direction, 0.04);
      this.solve(this.left, this.support, this.weight);
    }
  }
  private supportTarget(grip: [number, number, number]): void {
    this.support.fromArray(grip); this.gun!.localToWorld(this.support);
    this.left[2].getWorldScale(this.b);
    this.support.addScaledVector(this.direction, -0.075 * this.b.y);
  }
  private orientPrimaryHand(hand: THREE.Bone): void {
    hand.getWorldPosition(this.p);
    this.direction.copy(this.aim).sub(this.p).normalize();
    this.direction.y += this.kick * 0.6;
    this.direction.normalize();
    this.matrix.lookAt(this.direction, this.end.set(0, 0, 0), this.up);
    this.desired.setFromRotationMatrix(this.matrix).multiply(this.q.copy(this.socket).invert());
    hand.parent!.getWorldQuaternion(this.parentQ).invert();
    this.desired.premultiply(this.parentQ);
    hand.quaternion.slerp(this.desired, this.weight);
    hand.updateWorldMatrix(false, true);
  }
}
