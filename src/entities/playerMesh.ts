// Visual shell for the on-foot player: an anatomically proportioned humanoid
// assembled from the shared geometry in humanoid.ts. Physics (player.ts) writes
// group.position / group.rotation.y; everything in here is cosmetic.
import * as THREE from 'three';
import {
  buildHumanoidGeometry, walkPose, idlePose, emptyPose,
  L, type HumanoidGeometry, type Palette, type Pose,
} from './humanoid';

// DECISION: the player reads as a local in a sun-bleached coastal city rather
// than the plan's literal "teal shirt, white shorts, sun hat" -- the hat was a
// box on top of a box, and with a real skull it looked like a bucket.
const PLAYER_PALETTE: Palette = {
  skin: 0xc98d63,
  hair: 0x2e2018,
  shirt: 0x1f9c8a,
  trousers: 0xe8e2d4,
  shoes: 0xf2f0eb,
};

export interface PlayerMeshFrame {
  dt: number;
  time: number;
  speed: number;
  runSpeed: number;
}

/** One articulated limb: pivot at the joint, child pivot for the second bone. */
interface Limb {
  root: THREE.Group;
  joint: THREE.Group;
}

export class PlayerMesh {
  readonly group = new THREE.Group();

  private readonly geo: HumanoidGeometry;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly torso = new THREE.Group();
  private readonly head: THREE.Mesh;
  private readonly legL: Limb;
  private readonly legR: Limb;
  private readonly armL: Limb;
  private readonly armR: Limb;
  private readonly pose: Pose = emptyPose();
  private phase = 0;

  constructor(palette: Palette = PLAYER_PALETTE) {
    this.geo = buildHumanoidGeometry(palette);
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72 });

    // Torso pivots at the hip so leaning and the breathing bob move the upper
    // body, not the legs.
    this.torso.position.set(0, L.hipY, 0);
    this.torso.add(this.mesh(this.geo.torso));
    this.group.add(this.torso);

    this.head = this.mesh(this.geo.head);
    this.head.position.set(0, L.headY - L.hipY, 0);
    this.torso.add(this.head);

    this.legL = this.limb(this.geo.thigh, this.geo.shin, -L.hipHalfX, L.hipY, -L.thighLen, this.group);
    this.legR = this.limb(this.geo.thigh, this.geo.shin, L.hipHalfX, L.hipY, -L.thighLen, this.group);

    // Arms hang off the torso so they follow its lean.
    const shoulderY = L.shoulderY - L.hipY - 0.03;
    this.armL = this.limb(this.geo.upperArm, this.geo.forearm, -L.shoulderHalfX, shoulderY, -L.upperArmLen, this.torso);
    this.armR = this.limb(this.geo.upperArm, this.geo.forearm, L.shoulderHalfX, shoulderY, -L.upperArmLen, this.torso);
    // Let the arms fall in toward the ribs rather than straight off the deltoid.
    this.armL.root.rotation.z = 0.10;
    this.armR.root.rotation.z = -0.10;
  }

  private mesh(geo: THREE.BufferGeometry): THREE.Mesh {
    const m = new THREE.Mesh(geo, this.material);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  /** Two-bone limb: `root` rotates at the top joint, `joint` at the middle. */
  private limb(
    upper: THREE.BufferGeometry, lower: THREE.BufferGeometry,
    x: number, y: number, jointY: number, parent: THREE.Object3D,
  ): Limb {
    const root = new THREE.Group();
    root.position.set(x, y, 0);
    root.add(this.mesh(upper));

    const joint = new THREE.Group();
    joint.position.set(0, jointY, 0);
    joint.add(this.mesh(lower));
    root.add(joint);

    parent.add(root);
    return { root, joint };
  }

  update(f: PlayerMeshFrame): void {
    const moving = f.speed > 0.05;
    const speedFrac = f.runSpeed > 0 ? THREE.MathUtils.clamp(f.speed / f.runSpeed, 0, 1) : 0;

    if (moving) {
      // Stride frequency rises with speed; the 2.2 keeps footfalls roughly in
      // step with ground speed instead of skating.
      this.phase += f.dt * (2.2 + speedFrac * 6.5);
      walkPose(this.phase, speedFrac, this.pose);
    } else {
      idlePose(f.time, this.pose);
    }

    const p = this.pose;
    this.legL.root.rotation.x = p.hipL;
    this.legR.root.rotation.x = p.hipR;
    this.legL.joint.rotation.x = -p.kneeL;
    this.legR.joint.rotation.x = -p.kneeR;

    this.armL.root.rotation.x = p.shoulderL;
    this.armR.root.rotation.x = p.shoulderR;
    this.armL.joint.rotation.x = -p.elbowL;
    this.armR.joint.rotation.x = -p.elbowR;

    this.torso.rotation.x = p.torsoLean;
    this.torso.position.y = L.hipY + p.bob;
    // Counter-rotate the head so the character keeps looking where it walks.
    this.head.rotation.x = -p.torsoLean * 0.7;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}
