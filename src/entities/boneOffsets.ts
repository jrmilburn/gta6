// Applying procedural adjustments on top of an AnimationMixer, safely.
//
// This exists because of a measured bug. The rig layers a spine lean, a breath
// and a slow weight shift on top of whatever the mixer wrote, by adding to the
// bone each frame. That is fine while a clip is moving -- the mixer overwrites
// the bone every frame, so each addition starts from a clean base -- and it is
// wrong the moment the character stands still.
//
// three's PropertyMixer only writes a value back to the scene graph when the
// value it mixed differs from the value it mixed last time. A static idle pose
// mixes to the same numbers every frame, so after the first write it stops
// writing at all. Nothing then resets the bone, and the additions compound: the
// hips wandered 42 cm sideways and the head swung 4.8 degrees over eight
// seconds of standing perfectly still. That is the spinning bug.
//
// The fix is to make the additions exactly reversible and undo them before the
// mixer runs. If the mixer writes, the undo was harmless; if it skips, the undo
// is what restores the base. Both cases end up correct, and neither depends on
// knowing which happened.
//
// Rotations are applied as quaternion multiplications rather than by nudging
// `bone.rotation`, which was a second latent bug: reading a Euler back out of a
// mixer-written quaternion and adding to one of its three numbers rotates about
// whatever axis the decomposition happened to pick, and near a singularity that
// is not the axis you asked for.
import * as THREE from 'three';

const Q = new THREE.Quaternion();
const AXIS = new THREE.Vector3();

interface Offset {
  bone: THREE.Object3D;
  /** Rotation applied after the bone's own, so undo is a multiply by its inverse. */
  quat: THREE.Quaternion;
  /** Translation added in the bone's local space. */
  pos: THREE.Vector3;
  used: boolean;
}

/**
 * A set of reversible per-bone adjustments.
 *
 * Call `clear()` before `mixer.update()` and then `rotate()` / `translate()`
 * after it. Bones not touched this frame are returned to their mixed value and
 * dropped.
 */
export class BoneOffsets {
  private readonly offsets = new Map<THREE.Object3D, Offset>();

  /** Undo last frame's adjustments. Must run before the mixer writes. */
  clear(): void {
    for (const o of this.offsets.values()) {
      o.bone.quaternion.multiply(Q.copy(o.quat).invert());
      o.bone.position.sub(o.pos);
      o.quat.identity();
      o.pos.set(0, 0, 0);
      o.used = false;
    }
  }

  private slot(bone: THREE.Object3D): Offset {
    let o = this.offsets.get(bone);
    if (!o) {
      o = { bone, quat: new THREE.Quaternion(), pos: new THREE.Vector3(), used: false };
      this.offsets.set(bone, o);
    }
    o.used = true;
    return o;
  }

  /** Turn `bone` by `angle` about a local axis, on top of its animated pose. */
  rotate(bone: THREE.Object3D | null, x: number, y: number, z: number, angle: number): void {
    if (!bone || angle === 0) return;
    const o = this.slot(bone);
    Q.setFromAxisAngle(AXIS.set(x, y, z).normalize(), angle);
    bone.quaternion.multiply(Q);
    o.quat.multiply(Q);
  }

  /** Shift `bone` in its own local space, on top of its animated pose. */
  translate(bone: THREE.Object3D | null, x: number, y: number, z: number): void {
    if (!bone || (x === 0 && y === 0 && z === 0)) return;
    const o = this.slot(bone);
    bone.position.x += x; bone.position.y += y; bone.position.z += z;
    o.pos.x += x; o.pos.y += y; o.pos.z += z;
  }

  /** Forget everything, leaving the bones wherever they currently are. */
  dispose(): void {
    this.offsets.clear();
  }
}
