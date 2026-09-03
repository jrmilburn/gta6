// The pistol: a procedural mesh in the character's hand, and the three things
// firing it puts on screen (section 7).
//
// No model was supplied and none is fetched. A pistol at arm's length is
// eighteen centimetres of dark plastic read from two metres behind the
// character's shoulder, so a handful of boxes carries every silhouette cue that
// matters -- slide, grip, trigger guard -- and costs nothing to load.
import * as THREE from 'three';
import { CFG } from '../config';

const P = CFG.combat.pistol;
/** Points in one spark burst, and how long they live. */
const SPARKS = 14;
const SPARK_TIME = 0.28;

/**
 * How far up the fist the gun sits, as a fraction of the wrist-to-knuckle
 * distance, and how far its origin is lifted so the grip ends up inside the
 * fingers rather than under them.
 */
const FIST_ALONG = 0.55;
const GRIP_RISE = 0.02;

function part(
  w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  return mesh;
}

export interface PistolParts {
  /** Parent this to the right hand bone. */
  group: THREE.Group;
  /** World-space muzzle, for the flash, the tracer and the shot ray's origin. */
  muzzle: THREE.Object3D;
  flash: THREE.Mesh;
  dispose(): void;
}

/**
 * Build the gun. It is added to the scene by the caller parenting `group` to a
 * hand bone -- which means it inherits the hand's animation for free, and no
 * code has to follow the hand around every frame.
 */
export function buildPistol(): PistolParts {
  const group = new THREE.Group();
  group.name = 'pistol';
  group.visible = false;

  const body = new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.42, metalness: 0.75 });
  const grip = new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.85, metalness: 0.1 });

  // Slide and frame along +Z, which is the way the hand points.
  group.add(part(0.026, 0.030, 0.180, 0, 0.030, 0.030, body));
  group.add(part(0.024, 0.026, 0.090, 0, 0.004, 0.010, body));
  // Grip, raked back the way a pistol grip is.
  const butt = part(0.026, 0.090, 0.036, 0, -0.045, -0.030, grip);
  butt.rotation.x = -0.22;
  group.add(butt);
  // Trigger guard, as a thin loop of two bars.
  group.add(part(0.014, 0.008, 0.040, 0, -0.014, -0.004, grip));
  group.add(part(0.014, 0.026, 0.008, 0, -0.004, -0.022, grip));

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.030, 0.122);
  group.add(muzzle);

  // Muzzle flash: an emissive card that is shown for a couple of frames. Not a
  // light -- one more shadow-casting light per shot is not worth the frame.
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffd9a0, transparent: true, opacity: 0.9, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const flash = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.14), flashMat);
  flash.position.set(0, 0.030, 0.150);
  flash.visible = false;
  group.add(flash);

  const owned: Array<{ dispose(): void }> = [body, grip, flashMat, flash.geometry];
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry && m !== flash) owned.push(m.geometry);
    if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
  });

  return {
    group,
    muzzle,
    flash,
    dispose(): void { for (const o of owned) o.dispose(); },
  };
}

/**
 * Sit the gun in the hand, using the hand's own bones to work out which way
 * that is.
 *
 * DECISION: the grip transform is derived, not authored. A hand bone's local
 * axes are whatever the rig's author felt like -- Mixamo's are undocumented and
 * differ between exports -- so a hand-tuned pair of Euler angles is a guess, and
 * it was the wrong guess: the pistol came out sideways at the hip. Two bones
 * answer it outright. The forearm says which way the arm points, and the
 * knuckle says which way the fingers close. A pistol held properly has its
 * barrel along the first and its grip along the second, and those two
 * directions are a complete basis.
 */
export function fitPistolToHand(
  gun: THREE.Object3D, hand: THREE.Object3D,
  forearm: THREE.Object3D | null, knuckle: THREE.Object3D | null,
): void {
  if (!forearm || !knuckle) return;
  hand.updateWorldMatrix(true, false);
  forearm.updateWorldMatrix(true, false);

  // The arm's direction, brought into the hand's own space.
  const handWorld = new THREE.Vector3();
  const foreWorld = new THREE.Vector3();
  hand.getWorldPosition(handWorld);
  forearm.getWorldPosition(foreWorld);
  const inv = hand.getWorldQuaternion(new THREE.Quaternion()).invert();
  const barrel = handWorld.clone().sub(foreWorld).normalize().applyQuaternion(inv);

  // The knuckle is a child of the hand, so its position is already hand-local.
  const fingers = knuckle.position.clone().normalize();
  const reach = knuckle.position.length();

  // Orthonormal basis: barrel forward along +Z, grip down along the fingers.
  const z = barrel.normalize();
  const down = fingers.clone().addScaledVector(z, -fingers.dot(z));
  if (down.lengthSq() < 1e-8) return;
  down.normalize();
  const y = down.negate();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  y.crossVectors(z, x).normalize();

  gun.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  gun.position.copy(fingers).multiplyScalar(reach * FIST_ALONG).addScaledVector(y, GRIP_RISE);
}

/**
 * Everything a shot leaves behind: the tracer line and the wall marks.
 *
 * One pooled line and a small ring of decal quads, because a shot is a
 * quarter-second of visuals fired up to five times a second and allocating
 * geometry per trigger pull is how a frame rate dies.
 */
export class ShotEffects {
  readonly group = new THREE.Group();

  private readonly tracer: THREE.Line;
  private readonly tracerPositions: THREE.BufferAttribute;
  private tracerLeft = 0;
  private readonly decals: THREE.Mesh[] = [];
  private readonly decalLife: number[] = [];
  /** A handful of additive points, thrown outward from a hit on metal. */
  private readonly sparks: THREE.Points;
  private readonly sparkPositions: THREE.BufferAttribute;
  private readonly sparkVel: Float32Array;
  private sparkLeft = 0;
  private next = 0;
  private readonly owned: Array<{ dispose(): void }> = [];

  constructor(decalCount = 16) {
    this.group.name = 'shots';

    const geo = new THREE.BufferGeometry();
    this.tracerPositions = new THREE.BufferAttribute(new Float32Array(6), 3);
    geo.setAttribute('position', this.tracerPositions);
    const mat = new THREE.LineBasicMaterial({
      color: 0xffe6b0, transparent: true, opacity: 0.85, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.tracer = new THREE.Line(geo, mat);
    this.tracer.frustumCulled = false;
    this.tracer.visible = false;
    this.group.add(this.tracer);
    this.owned.push(geo, mat);

    // Sparks: one small point cloud, reused. A bullet hitting bodywork throws
    // a few bright specks for a tenth of a second -- enough to say "that was
    // metal" and cheap enough to fire five times a second.
    const sparkGeo = new THREE.BufferGeometry();
    this.sparkPositions = new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3);
    sparkGeo.setAttribute('position', this.sparkPositions);
    this.sparkVel = new Float32Array(SPARKS * 3);
    const sparkMat = new THREE.PointsMaterial({
      color: 0xffd08a, size: 0.05, transparent: true, opacity: 1,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    this.sparks = new THREE.Points(sparkGeo, sparkMat);
    this.sparks.frustumCulled = false;
    this.sparks.visible = false;
    this.group.add(this.sparks);
    this.owned.push(sparkGeo, sparkMat);

    const decalGeo = new THREE.CircleGeometry(P.decalRadius, 8);
    const decalMat = new THREE.MeshBasicMaterial({
      color: 0x121212, transparent: true, opacity: 0.75, depthWrite: false,
    });
    this.owned.push(decalGeo, decalMat);
    for (let i = 0; i < decalCount; i++) {
      const m = new THREE.Mesh(decalGeo, decalMat.clone());
      m.visible = false;
      this.group.add(m);
      this.decals.push(m);
      this.decalLife.push(0);
      this.owned.push(m.material as THREE.Material);
    }
  }

  /** Draw the shot's path for a fraction of a second. */
  tracerTo(from: THREE.Vector3, to: THREE.Vector3): void {
    this.tracerPositions.setXYZ(0, from.x, from.y, from.z);
    this.tracerPositions.setXYZ(1, to.x, to.y, to.z);
    this.tracerPositions.needsUpdate = true;
    this.tracer.visible = true;
    this.tracerLeft = P.tracerTime;
  }

  /**
   * Mark a wall. `normal` is the surface the bullet met, so the quad lies flat
   * against it; lifted a centimetre clear to keep it out of a z-fight.
   */
  mark(at: THREE.Vector3, normal: THREE.Vector3): void {
    const m = this.decals[this.next];
    this.next = (this.next + 1) % this.decals.length;
    m.position.copy(at).addScaledVector(normal, 0.01);
    m.lookAt(at.clone().add(normal));
    m.visible = true;
    (m.material as THREE.MeshBasicMaterial).opacity = 0.75;
    this.decalLife[this.decals.indexOf(m)] = P.decalSeconds;
  }

  /** Throw a burst of sparks off a hit, scattered around `normal`. */
  spark(at: THREE.Vector3, normal: THREE.Vector3): void {
    for (let i = 0; i < SPARKS; i++) {
      this.sparkPositions.setXYZ(i, at.x, at.y, at.z);
      // Mostly back along the surface normal, with enough scatter that no two
      // bursts look like the same burst.
      this.sparkVel[i * 3] = normal.x * 2 + (Math.random() - 0.5) * 3;
      this.sparkVel[i * 3 + 1] = normal.y * 2 + Math.random() * 2.5;
      this.sparkVel[i * 3 + 2] = normal.z * 2 + (Math.random() - 0.5) * 3;
    }
    this.sparkPositions.needsUpdate = true;
    this.sparks.visible = true;
    this.sparkLeft = SPARK_TIME;
  }

  update(dt: number): void {
    if (this.sparkLeft > 0) {
      this.sparkLeft -= dt;
      const mat = this.sparks.material as THREE.PointsMaterial;
      mat.opacity = Math.max(0, this.sparkLeft / SPARK_TIME);
      for (let i = 0; i < SPARKS; i++) {
        this.sparkVel[i * 3 + 1] -= 9.8 * dt;
        this.sparkPositions.setXYZ(
          i,
          this.sparkPositions.getX(i) + this.sparkVel[i * 3] * dt,
          this.sparkPositions.getY(i) + this.sparkVel[i * 3 + 1] * dt,
          this.sparkPositions.getZ(i) + this.sparkVel[i * 3 + 2] * dt,
        );
      }
      this.sparkPositions.needsUpdate = true;
      if (this.sparkLeft <= 0) this.sparks.visible = false;
    }
    if (this.tracerLeft > 0) {
      this.tracerLeft -= dt;
      if (this.tracerLeft <= 0) this.tracer.visible = false;
    }
    for (let i = 0; i < this.decals.length; i++) {
      if (this.decalLife[i] <= 0) continue;
      this.decalLife[i] -= dt;
      const mat = this.decals[i].material as THREE.MeshBasicMaterial;
      // Fade over the last second rather than blinking out.
      mat.opacity = 0.75 * Math.min(1, this.decalLife[i]);
      if (this.decalLife[i] <= 0) this.decals[i].visible = false;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const o of this.owned) o.dispose();
  }
}
