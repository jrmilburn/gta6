// Turn a loaded glTF scene into something that can be drawn as one InstancedMesh.
//
// A Kenney model arrives as a small tree of Meshes -- a palm is a trunk node
// plus two frond nodes, each with its own material -- and drawing 300 palms that
// way is 900 draw calls. This flattens the tree into a single geometry with one
// group per material, which an InstancedMesh renders in one call per material
// however many copies exist.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Attributes kept on the merged geometry. Anything else is dropped. */
const ATTRS = ['position', 'normal', 'uv'] as const;

export interface FlatModel {
  /** Merged geometry, with one group per entry in `materials`. */
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
  /** Local-space bounding box, for sizing and for the wind's height falloff. */
  box: THREE.Box3;
  /** Height in metres as authored. */
  height: number;
}

/**
 * mergeGeometries refuses geometries whose attribute sets differ, and Kenney's
 * kits are not consistent about shipping UVs. Normalising here is cheaper than
 * discovering it as a null return three models later.
 */
function normalise(src: THREE.BufferGeometry): THREE.BufferGeometry | null {
  const pos = src.getAttribute('position');
  if (!pos) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', pos.clone());
  const normal = src.getAttribute('normal');
  g.setAttribute('normal', normal ? normal.clone() : new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3));
  const uv = src.getAttribute('uv');
  g.setAttribute('uv', uv ? uv.clone() : new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
  if (src.index) g.setIndex(src.index.clone());
  if (!normal) g.computeVertexNormals();
  for (const a of ATTRS) if (!g.getAttribute(a)) return null;
  return g;
}

export interface FlattenOptions {
  /**
   * Keep the model's authored Y instead of dropping its base to y = 0.
   *
   * Vegetation wants the base on the ground whatever the artist did. A car body
   * does not: its underside sits above the axle line by design, and re-origining
   * it would bury the wheels.
   */
  keepY?: boolean;
  /** Keep the authored X/Z too, for models whose parts must stay aligned. */
  keepXZ?: boolean;
}

/**
 * Flatten `root` into one geometry per material, then one geometry with groups.
 *
 * Every mesh's own transform is baked in, and by default the result is
 * re-centred on X/Z with its base at y = 0, so a caller can place instances by
 * their footprint without knowing how the artist happened to origin the model.
 */
export function flattenModel(root: THREE.Object3D, opts: FlattenOptions = {}): FlatModel | null {
  root.updateWorldMatrix(true, true);
  const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert();

  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    // A multi-material mesh inside a kit model would need its groups split out;
    // none of the kits do that, so it is treated as single-material and the
    // extra materials are ignored rather than silently mis-assigned.
    const mat = mats[0];
    if (!mat) return;
    const g = normalise(mesh.geometry);
    if (!g) return;
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld));
    const list = byMaterial.get(mat);
    if (list) list.push(g); else byMaterial.set(mat, [g]);
  });

  if (byMaterial.size === 0) return null;

  const materials: THREE.Material[] = [];
  const perMaterial: THREE.BufferGeometry[] = [];
  for (const [mat, parts] of byMaterial) {
    const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
    if (parts.length > 1) for (const p of parts) p.dispose();
    if (!merged) continue;
    materials.push(mat);
    perMaterial.push(merged);
  }
  if (perMaterial.length === 0) return null;

  const geometry = perMaterial.length === 1
    ? perMaterial[0]
    : mergeGeometries(perMaterial, true);
  if (perMaterial.length > 1) for (const p of perMaterial) p.dispose();
  if (!geometry) return null;

  geometry.computeBoundingBox();
  const box = geometry.boundingBox ?? new THREE.Box3();
  // Re-origin: base on the ground, centred on its own footprint.
  geometry.translate(
    opts.keepXZ ? 0 : -(box.min.x + box.max.x) / 2,
    opts.keepY ? 0 : -box.min.y,
    opts.keepXZ ? 0 : -(box.min.z + box.max.z) / 2,
  );
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const finalBox = geometry.boundingBox ?? new THREE.Box3();

  return {
    geometry,
    materials,
    box: finalBox,
    height: finalBox.max.y - finalBox.min.y,
  };
}

/**
 * Clone a model's materials so per-use tweaks (roughness, wind, ground AO) do
 * not leak between every other model sharing the glTF's material instance.
 */
export function cloneMaterials(model: FlatModel, tune?: (m: THREE.Material) => void): THREE.Material[] {
  return model.materials.map((m) => {
    const c = m.clone();
    // Kit materials come in shiny by default, which under an environment map
    // makes tree bark look like painted plastic.
    if ((c as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
      const std = c as THREE.MeshStandardMaterial;
      std.roughness = 0.85;
      std.metalness = 0;
    }
    tune?.(c);
    return c;
  });
}

/** One InstancedMesh over a flattened model, sized for `capacity` copies. */
export function makeInstanced(
  model: FlatModel, materials: THREE.Material[], capacity: number,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(
    model.geometry,
    materials.length === 1 ? materials[0] : materials,
    Math.max(1, capacity),
  );
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false; // one mesh spans the whole city; its bounds are useless
  return mesh;
}
