// Fences and planters along residential frontages (realism pass 2.4).
//
// The brief asks residential ground floors for "a door, two shuttered windows
// and a fence". The door and windows are painted into the facade albedo by
// surfaces.ts, because the texture tiles up the building and its bottom row is
// the ground floor of every instance at once. A fence cannot be: it stands clear
// of the wall and has to follow the block's outline, so it is geometry -- one
// InstancedMesh for the whole city.
import * as THREE from 'three';
import { Rng } from '../core/rng';
import { CFG } from '../config';
import type { Assets, PropModel } from '../core/assets';
import type { CityLayout } from './cityGen';
import { flattenModel, cloneMaterials, makeInstanced, type FlatModel } from './modelInstancing';
import { applyGroundAo } from './groundAo';
import { KERB } from './groundHeight';

/** A front fence is chest height, not a compound wall. */
const FENCE_HEIGHT = 1.15;
const PLANTER_HEIGHT = 0.75;
/** How far in from the block edge the fence line sits. */
const INSET = 1.1;

/**
 * Tint over the kit's palette.
 *
 * The suburban kit's fence samples a terracotta patch, which against pastel
 * stucco reads as a row of orange crash barriers. A multiply cannot change hue,
 * only knock channels down, so the tint is deliberately COOL: pulling red hard
 * and leaving blue alone lands on the muted render-and-clay garden wall the
 * street actually wants, rather than a paler orange.
 */
const TINT = 0x8e9aa2;

interface Prepared {
  model: FlatModel;
  /** World length one instance covers along its local X, after scaling. */
  span: number;
}

/**
 * Load a prop and scale it to a real-world HEIGHT.
 *
 * Height, not length: a kit fence panel is authored roughly as tall as it is
 * wide, so normalising on length gives a 2.4 m wall. Scaling by height and
 * reading the resulting length back is what makes panels the right size AND
 * tile without gaps.
 */
function prepare(assets: Assets, model: PropModel, height: number): Prepared | null {
  const src = assets.prop(model);
  if (!src) return null;
  const flat = flattenModel(src);
  if (!flat) return null;
  const scale = height / Math.max(flat.height, 1e-3);
  flat.geometry.scale(scale, scale, scale);
  flat.geometry.computeBoundingBox();
  flat.geometry.computeBoundingSphere();
  const box = flat.geometry.boundingBox ?? new THREE.Box3();
  return { model: flat, span: Math.max(box.max.x - box.min.x, 0.5) };
}

function instanceOf(prep: Prepared, matrices: THREE.Matrix4[]): THREE.InstancedMesh | null {
  if (matrices.length === 0) return null;
  const mats = cloneMaterials(prep.model, (m) => {
    (m as THREE.MeshStandardMaterial).color?.setHex(TINT);
  });
  for (const m of mats) applyGroundAo(m, 1.2, 0.74);
  const mesh = makeInstanced(prep.model, mats, matrices.length);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.count = matrices.length;
  for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

/**
 * Fence panels round the street-facing edges of residential blocks, with the
 * odd planter at a corner.
 *
 * Runs are broken deliberately: a continuous fence round a whole block reads as
 * a compound wall, and the gaps are where the driveways and paths would be.
 */
export function buildStreetProps(layout: CityLayout, assets: Assets): THREE.Group | null {
  const fence = prepare(assets, 'fence', FENCE_HEIGHT);
  const planter = prepare(assets, 'planter', PLANTER_HEIGHT);
  if (!fence && !planter) return null;

  const group = new THREE.Group();
  group.name = 'streetProps';

  const rng = new Rng(5150);
  const fences: THREE.Matrix4[] = [];
  const planters: THREE.Matrix4[] = [];
  const M = new THREE.Matrix4();
  const Q = new THREE.Quaternion();
  const P = new THREE.Vector3();
  const S = new THREE.Vector3(1, 1, 1);
  const UP = new THREE.Vector3(0, 1, 0);
  const panel = fence?.span ?? 2;

  for (const block of layout.blocks) {
    if (block.zone !== 'residential' || layout.parks.includes(block)) continue;
    const b = block.bounds;
    const pad = CFG.city.sidewalkWidth + INSET;
    const x0 = b.minX + pad, x1 = b.maxX - pad;
    const z0 = b.minZ + pad, z1 = b.maxZ - pad;

    // [runs along X, from, to, fixed coordinate, yaw]
    const edges: Array<[boolean, number, number, number, number]> = [
      [true, x0, x1, z0, 0],
      [true, x0, x1, z1, Math.PI],
      [false, z0, z1, x0, -Math.PI / 2],
      [false, z0, z1, x1, Math.PI / 2],
    ];

    if (fence) {
      for (const [alongX, from, to, fixed, yaw] of edges) {
        Q.setFromAxisAngle(UP, yaw);
        for (let t = from; t < to - panel; t += panel) {
          // Roughly a third of the frontage is left open for a path or a drive.
          if (rng.chance(0.34)) continue;
          const c = t + panel / 2;
          P.set(alongX ? c : fixed, KERB, alongX ? fixed : c);
          fences.push(M.compose(P, Q, S).clone());
        }
      }
    }

    if (planter && rng.chance(0.7)) {
      Q.setFromAxisAngle(UP, rng.range(0, Math.PI * 2));
      P.set(rng.chance(0.5) ? x0 : x1, KERB, rng.chance(0.5) ? z0 : z1);
      planters.push(M.compose(P, Q, S).clone());
    }
  }

  const fenceMesh = fence && instanceOf(fence, fences);
  if (fenceMesh) group.add(fenceMesh);
  const planterMesh = planter && instanceOf(planter, planters);
  if (planterMesh) group.add(planterMesh);

  return group.children.length > 0 ? group : null;
}
