// Instanced pedestrians (plan section 6), built from the same anatomical
// humanoid as the player (humanoid.ts) so the crowd and the character the
// camera follows are visibly the same species.
//
// DECISION: pedestrians merge thigh+shin and upperArm+forearm into single rigid
// segments, unlike the player's two-bone limbs. A crowd is read at 10-50 m
// where the knee bend is invisible but the silhouette is not, and merging keeps
// this at 5 parts x 4 variants = 20 draw calls however many pedestrians exist.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildHumanoidGeometry, L, type Palette } from './humanoid';

/** Ground-anchored landmarks, feet at local y = 0. */
export const HIP_Y = L.hipY;
export const SHOULDER_Y = L.shoulderY;
/** Fixed "hands up" flee angle, both arms rotate the same way (not mirrored). */
export const ARMS_UP_ANGLE = -2.5;

const HIP_X = L.hipHalfX;
const SHOULDER_X = L.shoulderHalfX;

// Six palettes (realism pass 2.2). Skin tones and hair are drawn from a real
// range rather than tinted from one base, because a crowd where everyone is the
// same person in a different shirt reads as a crowd of clones at any distance.
const VARIANTS: Palette[] = [
  { skin: 0xe3ad7c, hair: 0x2b1d14, shirt: 0x1f8f86, trousers: 0xf4f1e6, shoes: 0xdedbd2 },
  { skin: 0xa5713f, hair: 0x140f0c, shirt: 0xe0479e, trousers: 0x37506e, shoes: 0x2f2f33 },
  { skin: 0xf0c9a0, hair: 0x6b4423, shirt: 0xf5c518, trousers: 0x2a2a2e, shoes: 0xe8e4da },
  { skin: 0x8a5a3c, hair: 0x241a12, shirt: 0x2f7fe0, trousers: 0xf1efe6, shoes: 0x3a3a40 },
  { skin: 0xc98d63, hair: 0x4a3524, shirt: 0xf26a3d, trousers: 0x8e8b80, shoes: 0x1f1f22 },
  { skin: 0x6d452c, hair: 0x0f0b09, shirt: 0xeae6db, trousers: 0x2f6b52, shoes: 0xc9c4b8 },
];
export const PED_VARIANT_COUNT = VARIANTS.length;

/**
 * Three heights (2.2). Applied as a uniform scale on the whole rig, so a short
 * pedestrian has short legs and a short stride rather than a shrunken adult
 * floating above the pavement.
 */
export const PED_SCALES: readonly number[] = [0.92, 1.0, 1.06];

const M_TMP = new THREE.Matrix4();
const M_OFF = new THREE.Matrix4();
const M_ROT = new THREE.Matrix4();
const M_HIDE = new THREE.Matrix4().makeScale(0, 0, 0);

interface VariantMeshes {
  torsoHead: THREE.InstancedMesh;
  legL: THREE.InstancedMesh;
  legR: THREE.InstancedMesh;
  armL: THREE.InstancedMesh;
  armR: THREE.InstancedMesh;
}

/** Clone a source geometry, shift it, and hand back an owned copy. */
function shifted(src: THREE.BufferGeometry, y: number): THREE.BufferGeometry {
  const g = src.clone();
  if (y !== 0) g.translate(0, y, 0);
  return g;
}

function join(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!out) throw new Error('pedMesh: geometry merge failed');
  out.computeBoundingSphere();
  return out;
}

/**
 * A pool of `variants x 5` InstancedMeshes covering up to `capacityPerVariant`
 * pedestrians per variant. Callers own the pedestrian-to-(variant, slot)
 * assignment; this class only turns a pose into instance matrices.
 */
export class PedMeshPool {
  readonly group = new THREE.Group();
  readonly capacityPerVariant: number;
  private readonly variants: VariantMeshes[] = [];
  private readonly owned: Array<{ dispose(): void }> = [];

  constructor(capacityPerVariant: number) {
    this.capacityPerVariant = capacityPerVariant;
    // Roughness 0.85 and no map: the palette is flat colour, so the only thing
    // that can give these forms any shading beyond the key light is the
    // environment map, and a rough dielectric is what picks that up (2.2).
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    this.owned.push(material);

    for (const v of VARIANTS) {
      const h = buildHumanoidGeometry(v);

      // Torso is authored with its origin at the hip and the head centred on
      // its own origin, so both are lifted to standing height here.
      const torsoHeadGeo = join([
        shifted(h.torso, HIP_Y),
        shifted(h.head, L.headY),
      ]);
      const legGeo = join([
        shifted(h.thigh, 0),
        shifted(h.shin, -L.thighLen),
      ]);
      const armGeo = join([
        shifted(h.upperArm, 0),
        shifted(h.forearm, -L.upperArmLen),
      ]);
      h.dispose();
      this.owned.push(torsoHeadGeo, legGeo, armGeo);

      const make = (geo: THREE.BufferGeometry): THREE.InstancedMesh => {
        const mesh = new THREE.InstancedMesh(geo, material, capacityPerVariant);
        // One mesh spans the whole city and its bounding sphere is never
        // recomputed as instances move, so the culling test is meaningless.
        mesh.frustumCulled = false;
        mesh.count = capacityPerVariant;
        // Plan section 0.6: no shadow-casting on instanced props except buildings.
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        for (let i = 0; i < capacityPerVariant; i++) mesh.setMatrixAt(i, M_HIDE);
        this.group.add(mesh);
        return mesh;
      };
      this.variants.push({
        torsoHead: make(torsoHeadGeo),
        legL: make(legGeo),
        legR: make(legGeo),
        armL: make(armGeo),
        armR: make(armGeo),
      });
    }
  }

  variantFor(i: number): number { return i % VARIANTS.length; }
  slotFor(i: number): number { return Math.floor(i / VARIANTS.length); }

  hide(variant: number, slot: number): void {
    const vm = this.variants[variant];
    vm.torsoHead.setMatrixAt(slot, M_HIDE);
    vm.legL.setMatrixAt(slot, M_HIDE);
    vm.legR.setMatrixAt(slot, M_HIDE);
    vm.armL.setMatrixAt(slot, M_HIDE);
    vm.armR.setMatrixAt(slot, M_HIDE);
  }

  /**
   * `base` is the ground-anchored world transform (position + facing quaternion).
   * `legSwing` mirrors like the player (hipL = +swing, hipR = -swing).
   * `armSwing` mirrors the same way unless `armsUp`, in which case both arms
   * rotate together to the fixed flee angle instead.
   */
  setPose(
    variant: number, slot: number, base: THREE.Matrix4,
    legSwing: number, armSwing: number, armsUp: boolean,
  ): void {
    const vm = this.variants[variant];
    vm.torsoHead.setMatrixAt(slot, base);

    M_OFF.makeTranslation(-HIP_X, HIP_Y, 0);
    M_ROT.makeRotationX(legSwing);
    M_TMP.copy(base).multiply(M_OFF).multiply(M_ROT);
    vm.legL.setMatrixAt(slot, M_TMP);

    M_OFF.makeTranslation(HIP_X, HIP_Y, 0);
    M_ROT.makeRotationX(-legSwing);
    M_TMP.copy(base).multiply(M_OFF).multiply(M_ROT);
    vm.legR.setMatrixAt(slot, M_TMP);

    const armL = armsUp ? ARMS_UP_ANGLE : -armSwing;
    const armR = armsUp ? ARMS_UP_ANGLE : armSwing;
    M_OFF.makeTranslation(-SHOULDER_X, SHOULDER_Y - 0.03, 0);
    M_ROT.makeRotationX(armL);
    M_TMP.copy(base).multiply(M_OFF).multiply(M_ROT);
    vm.armL.setMatrixAt(slot, M_TMP);

    M_OFF.makeTranslation(SHOULDER_X, SHOULDER_Y - 0.03, 0);
    M_ROT.makeRotationX(armR);
    M_TMP.copy(base).multiply(M_OFF).multiply(M_ROT);
    vm.armR.setMatrixAt(slot, M_TMP);
  }

  /** Call once per frame after every setPose()/hide() for this frame. */
  commit(): void {
    for (const vm of this.variants) {
      for (const m of [vm.torsoHead, vm.legL, vm.legR, vm.armL, vm.armR]) {
        m.instanceMatrix.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const o of this.owned) o.dispose();
    this.owned.length = 0;
  }
}
