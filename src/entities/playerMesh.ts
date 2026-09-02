// Blocky humanoid built from boxes only (plan section 5): head, torso, two
// arms, two legs, pivoted at shoulders and hips. Procedural walk cycle swings
// limbs with sin(t * stride), amplitude and frequency scaling with speed;
// idle plays a subtle breathing scale on the torso. Outfit: teal shirt, white
// shorts, sun hat.
//
// DECISION: vehicleMesh.ts already has a `box()`/`bake()` pair that does
// exactly what this file needs (merge boxes into one vertex-coloured
// geometry), but those helpers are module-private there and vehicleMesh.ts is
// outside this phase's file ownership, so they are duplicated here rather
// than exported from a file another agent might be touching.
import * as THREE from 'three';

const SKIN = 0xe3ad7c;
const SHIRT = 0x1f8f86;
const SHORTS = 0xf4f1e6;
const HAT = 0xe8c468;
const HAT_BAND = 0x2f7f7a;

interface Part { geo: THREE.BufferGeometry; color: number; x?: number; y?: number; z?: number }

function box(w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0): Part {
  return { geo: new THREE.BoxGeometry(w, h, d), color, x, y, z };
}

/** Bake parts into one non-indexed vertex-coloured geometry (one draw call). */
function bake(parts: Part[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], col: number[] = [];
  const c = new THREE.Color();
  const m = new THREE.Matrix4();
  for (const p of parts) {
    const g = p.geo.toNonIndexed();
    m.identity().setPosition(p.x ?? 0, p.y ?? 0, p.z ?? 0);
    g.applyMatrix4(m);
    const pa = g.getAttribute('position'), na = g.getAttribute('normal');
    c.set(p.color).convertSRGBToLinear();
    for (let i = 0; i < pa.count; i++) {
      pos.push(pa.getX(i), pa.getY(i), pa.getZ(i));
      nor.push(na.getX(i), na.getY(i), na.getZ(i));
      col.push(c.r, c.g, c.b);
    }
    g.dispose();
    p.geo.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

// Proportions in metres, feet at local y = 0 (plan: capsule height 1.8).
const HIP_Y = 0.86;
const SHOULDER_Y = 1.5;
const HEAD_Y = 1.72;
const LEG_LEN = HIP_Y;
const ARM_LEN = 0.58;
const HIP_X = 0.16;
const SHOULDER_X = 0.36;

export interface PlayerMeshFrame {
  dt: number;
  time: number;
  speed: number;
  runSpeed: number;
}

/**
 * Visual shell for the on-foot player. Physics (player.ts) writes
 * `group.position` / `group.rotation.y`; everything here is cosmetic.
 */
export class PlayerMesh {
  readonly group = new THREE.Group();

  private readonly torso = new THREE.Group();
  private readonly hipL = new THREE.Group();
  private readonly hipR = new THREE.Group();
  private readonly shoulderL = new THREE.Group();
  private readonly shoulderR = new THREE.Group();
  private readonly owned: Array<{ dispose(): void }> = [];
  private phase = 0;

  constructor() {
    const skinMat = this.own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }));

    // Torso + shorts, baked together; pivoted at the hips so the idle
    // breathing scale stretches the chest upward rather than the legs.
    this.torso.position.set(0, HIP_Y, 0);
    const torsoGeo = bake([
      box(0.64, 0.22, 0.34, SHORTS, 0, 0.03, 0),
      box(0.60, 0.60, 0.30, SHIRT, 0, 0.34, 0),
    ]);
    this.owned.push(torsoGeo);
    const torsoMesh = new THREE.Mesh(torsoGeo, skinMat);
    torsoMesh.castShadow = true;
    torsoMesh.receiveShadow = true;
    this.torso.add(torsoMesh);
    this.group.add(this.torso);

    // Head + sun hat, baked together, fixed relative to the group.
    const headGeo = bake([
      box(0.32, 0.34, 0.32, SKIN, 0, 0, 0),
      box(0.46, 0.05, 0.46, HAT, 0, 0.21, 0),     // brim
      box(0.30, 0.16, 0.30, HAT, 0, 0.31, 0),     // crown
      box(0.47, 0.04, 0.06, HAT_BAND, 0, 0.135, 0.235), // band, front face only
    ]);
    this.owned.push(headGeo);
    const headMesh = new THREE.Mesh(headGeo, skinMat);
    headMesh.position.set(0, HEAD_Y, 0);
    headMesh.castShadow = true;
    headMesh.receiveShadow = true;
    this.group.add(headMesh);

    // Legs: hip pivot -> leg box hanging down.
    const legGeo = bake([box(0.26, LEG_LEN, 0.26, SKIN, 0, -LEG_LEN / 2, 0)]);
    this.owned.push(legGeo);
    for (const [hip, x] of [[this.hipL, -HIP_X], [this.hipR, HIP_X]] as const) {
      hip.position.set(x, HIP_Y, 0);
      const leg = new THREE.Mesh(legGeo, skinMat);
      leg.castShadow = true;
      leg.receiveShadow = true;
      hip.add(leg);
      this.group.add(hip);
    }

    // Arms: shoulder pivot -> arm box hanging down.
    const armGeo = bake([box(0.20, ARM_LEN, 0.20, SHIRT, 0, -ARM_LEN / 2, 0)]);
    this.owned.push(armGeo);
    for (const [shoulder, x] of [[this.shoulderL, -SHOULDER_X], [this.shoulderR, SHOULDER_X]] as const) {
      shoulder.position.set(x, SHOULDER_Y - 0.06, 0);
      const arm = new THREE.Mesh(armGeo, skinMat);
      arm.castShadow = true;
      arm.receiveShadow = true;
      shoulder.add(arm);
      this.group.add(shoulder);
    }
  }

  private own<T extends { dispose(): void }>(x: T): T { this.owned.push(x); return x; }

  update(f: PlayerMeshFrame): void {
    this.phase += f.dt;
    const moving = f.speed > 0.05;
    const speedFrac = f.runSpeed > 0 ? THREE.MathUtils.clamp(f.speed / f.runSpeed, 0, 1) : 0;

    if (moving) {
      const amp = 0.25 + speedFrac * 0.65;
      const freq = 3.2 + speedFrac * 4.2; // stride scales with speed
      const swing = Math.sin(this.phase * freq) * amp;
      this.hipL.rotation.x = swing;
      this.hipR.rotation.x = -swing;
      this.shoulderL.rotation.x = -swing;
      this.shoulderR.rotation.x = swing;
      this.torso.scale.set(1, 1, 1);
    } else {
      // Idle: limbs settle, torso breathes gently.
      const k = Math.min(1, f.dt * 8);
      this.hipL.rotation.x += (0 - this.hipL.rotation.x) * k;
      this.hipR.rotation.x += (0 - this.hipR.rotation.x) * k;
      this.shoulderL.rotation.x += (0 - this.shoulderL.rotation.x) * k;
      this.shoulderR.rotation.x += (0 - this.shoulderR.rotation.x) * k;
      const breathe = 1 + Math.sin(f.time * 1.6) * 0.02;
      this.torso.scale.set(1, breathe, 1);
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const o of this.owned) o.dispose();
    this.owned.length = 0;
  }
}
