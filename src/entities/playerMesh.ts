// Visual shell for the on-foot player: an anatomically proportioned humanoid
// assembled from the shared geometry in humanoid.ts. Physics (player.ts) writes
// group.position / group.rotation.y; everything in here is cosmetic.
//
// Locomotion is a three-clip blend (feel pass 1.3). Idle, walk and run are
// crossfaded by *actual ground speed*, not by input, so letting go of the key
// eases the character down through run -> walk -> idle instead of cutting. The
// cycle rate is derived from speed / stride length, which is what stops the feet
// sliding at every speed in between.
import * as THREE from 'three';
import { CFG } from '../config';
import { smoothDamp } from '../core/smooth';
import {
  buildHumanoidGeometry, walkPose, runPose, idlePose, emptyPose, zeroPose, addPose,
  L, type HumanoidGeometry, type Palette, type Pose,
} from './humanoid';

const F = CFG.feel.foot;
const LEAN_ACCEL = (F.leanAccelDeg * Math.PI) / 180;
const LEAN_TURN = (F.leanTurnDeg * Math.PI) / 180;

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
  /** Actual ground speed, m/s. Drives both the blend weights and the cycle rate. */
  speed: number;
  walkSpeed: number;
  runSpeed: number;
  /** Signed yaw rate, rad/s; the body banks into it. */
  turnRate: number;
  grounded: boolean;
  airborne: boolean;
  /** -1 crouched .. +1 stretched, from the jump phases. */
  crouch: number;
  /** 1 solid, 0 invisible; used for the 0.2 s fade at a car door (1.4). */
  opacity: number;
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
  /** Pelvis: carries hip drop and the pelvis twist. */
  private readonly pelvis = new THREE.Group();
  /** Spine: the lean and counter-rotation live here, above the legs. */
  private readonly spine = new THREE.Group();
  private readonly head: THREE.Mesh;
  private readonly legL: Limb;
  private readonly legR: Limb;
  private readonly armL: Limb;
  private readonly armR: Limb;

  private readonly pose: Pose = emptyPose();
  private readonly clip: Pose = emptyPose();
  private phase = 0;
  private wIdle = 1;
  private wWalk = 0;
  private wRun = 0;
  private lastSpeed = 0;
  private lean = 0;
  private leanVel = [0];
  private bank = 0;
  private bankVel = [0];
  private squash = 0;

  constructor(palette: Palette = PLAYER_PALETTE) {
    this.geo = buildHumanoidGeometry(palette);
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72 });

    // pelvis -> spine -> (head, arms); legs hang off the pelvis so the spine
    // lean bends the upper body without dragging the feet with it.
    this.pelvis.position.set(0, L.hipY, 0);
    this.group.add(this.pelvis);
    this.pelvis.add(this.spine);
    this.spine.add(this.mesh(this.geo.torso));

    this.head = this.mesh(this.geo.head);
    this.head.position.set(0, L.headY - L.hipY, 0);
    this.spine.add(this.head);

    this.legL = this.limb(this.geo.thigh, this.geo.shin, -L.hipHalfX, 0, -L.thighLen, this.pelvis);
    this.legR = this.limb(this.geo.thigh, this.geo.shin, L.hipHalfX, 0, -L.thighLen, this.pelvis);

    const shoulderY = L.shoulderY - L.hipY - 0.03;
    this.armL = this.limb(this.geo.upperArm, this.geo.forearm, -L.shoulderHalfX, shoulderY, -L.upperArmLen, this.spine);
    this.armR = this.limb(this.geo.upperArm, this.geo.forearm, L.shoulderHalfX, shoulderY, -L.upperArmLen, this.spine);
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
    const dt = Math.max(f.dt, 1e-4);
    this.advanceBlend(f, dt);
    this.advancePhase(f, dt);
    this.composePose(f);
    this.advanceLean(f, dt);
    this.applyPose();
    this.applyOpacity(f.opacity);
  }

  /**
   * Target clip weights from ground speed, eased toward over `blendTime`. Idle
   * gives way to walk below `walkSpeed`, walk to run above it.
   */
  private advanceBlend(f: PlayerMeshFrame, dt: number): void {
    let ti: number, tw: number, tr: number;
    if (f.speed <= f.walkSpeed) {
      const k = THREE.MathUtils.clamp(f.speed / Math.max(f.walkSpeed, 1e-3), 0, 1);
      // The idle->walk handover finishes well before walkSpeed so a slow drift
      // still shows a proper gait rather than a shuffling statue.
      ti = 1 - THREE.MathUtils.smoothstep(k, 0.02, 0.35);
      tw = 1 - ti;
      tr = 0;
    } else {
      const k = THREE.MathUtils.clamp(
        (f.speed - f.walkSpeed) / Math.max(f.runSpeed - f.walkSpeed, 1e-3), 0, 1,
      );
      ti = 0;
      tr = k;
      tw = 1 - k;
    }
    const rate = dt / Math.max(F.blendTime, 1e-3);
    const toward = (cur: number, target: number): number => {
      const d = target - cur;
      return Math.abs(d) <= rate ? target : cur + Math.sign(d) * rate;
    };
    this.wIdle = toward(this.wIdle, ti);
    this.wWalk = toward(this.wWalk, tw);
    this.wRun = toward(this.wRun, tr);
    const total = this.wIdle + this.wWalk + this.wRun;
    if (total > 1e-4) { this.wIdle /= total; this.wWalk /= total; this.wRun /= total; }
  }

  /**
   * Cycle rate from stride length: one 2*PI cycle must cover `stride` metres of
   * ground, so rate = speed / stride. The stride blends between the walk and run
   * clips by their weights, which is what keeps the contact point planted right
   * through the walk-to-run transition.
   */
  private advancePhase(f: PlayerMeshFrame, dt: number): void {
    const gait = this.wWalk + this.wRun;
    if (gait < 1e-3 || f.speed < 0.05) return;
    const stride = (F.walkStride * this.wWalk + F.runStride * this.wRun) / gait;
    this.phase += (f.speed / stride) * Math.PI * 2 * dt;
    if (this.phase > Math.PI * 4) this.phase -= Math.PI * 4;
  }

  private composePose(f: PlayerMeshFrame): void {
    zeroPose(this.pose);
    if (this.wIdle > 1e-3) addPose(this.pose, idlePose(f.time, this.clip), this.wIdle);
    if (this.wWalk > 1e-3) addPose(this.pose, walkPose(this.phase, this.clip), this.wWalk);
    if (this.wRun > 1e-3) addPose(this.pose, runPose(this.phase, this.clip), this.wRun);

    if (f.airborne) {
      // Tuck: front knee up, back leg trailing, arms out for balance.
      const p = this.pose;
      p.hipL = 0.9; p.hipR = -0.35;
      p.kneeL = 1.3; p.kneeR = 0.35;
      p.shoulderL = -0.7; p.shoulderR = -0.7;
      p.elbowL = 0.5; p.elbowR = 0.5;
      p.bob = 0; p.hipDrop = 0; p.pelvisTwist = 0;
    }
  }

  /**
   * Spine lean: forward with acceleration (up to 6 degrees), sideways into turns
   * (up to 4 degrees). Applied on top of the blended pose, which is the same
   * place an additive spine track would go on a real rig.
   */
  private advanceLean(f: PlayerMeshFrame, dt: number): void {
    const accel = (f.speed - this.lastSpeed) / dt;
    this.lastSpeed = f.speed;
    const wantLean = THREE.MathUtils.clamp(accel / 10, -1, 1) * LEAN_ACCEL;
    const wantBank = THREE.MathUtils.clamp(f.turnRate / 4, -1, 1) * LEAN_TURN;
    this.lean = smoothDamp(this.lean, wantLean, this.leanVel, F.leanSmooth, dt);
    this.bank = smoothDamp(this.bank, wantBank, this.bankVel, F.leanSmooth, dt);
    // Jump squash is a fast follower, not a spring, so the pop lands on frame.
    this.squash += (f.crouch - this.squash) * Math.min(1, dt * 26);
  }

  private applyPose(): void {
    const p = this.pose;
    this.legL.root.rotation.x = p.hipL;
    this.legR.root.rotation.x = p.hipR;
    this.legL.joint.rotation.x = -p.kneeL;
    this.legR.joint.rotation.x = -p.kneeR;

    this.armL.root.rotation.x = p.shoulderL;
    this.armR.root.rotation.x = p.shoulderR;
    this.armL.joint.rotation.x = -p.elbowL;
    this.armR.joint.rotation.x = -p.elbowR;

    // Squash: a crouch shortens the stance and dips the pelvis; a stretch does
    // the opposite. Legs bend with it so the feet stay on the floor.
    const dip = this.squash < 0 ? this.squash * 0.22 : this.squash * 0.06;
    const bend = Math.max(0, -this.squash);
    this.legL.root.rotation.x += bend * 0.5;
    this.legR.root.rotation.x += bend * 0.5;
    this.legL.joint.rotation.x -= bend * 0.95;
    this.legR.joint.rotation.x -= bend * 0.95;

    this.pelvis.position.set(0, L.hipY + p.bob + dip, 0);
    this.pelvis.rotation.set(0, p.pelvisTwist, p.hipDrop * 4);

    this.spine.rotation.set(p.torsoLean + this.lean + bend * 0.35, -p.pelvisTwist, this.bank);
    // Counter-rotate the head so the character keeps looking where it walks.
    this.head.rotation.set(-(p.torsoLean + this.lean) * 0.7, 0, -this.bank * 0.5);
  }

  private applyOpacity(opacity: number): void {
    const solid = opacity >= 0.999;
    if (this.material.transparent === !solid) {
      this.material.opacity = opacity;
      return;
    }
    this.material.transparent = !solid;
    this.material.opacity = opacity;
    this.material.depthWrite = solid;
    this.material.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}
