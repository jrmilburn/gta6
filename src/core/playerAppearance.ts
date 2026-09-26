import * as THREE from 'three';

/** Restore the original PBR textures; the animated export replaced them with emissive colour. */
export function preparePlayerAppearance(scene: THREE.Object3D, original: THREE.Object3D, anisotropy: number): void {
  let material: THREE.MeshStandardMaterial | undefined;
  original.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if ((source as THREE.MeshStandardMaterial).isMeshStandardMaterial) material = source as THREE.MeshStandardMaterial;
    mesh.geometry.dispose();
  });
  if (!material) throw new Error('Original character has no PBR material');
  const detailed = material.clone();
  detailed.emissive.set(0);
  detailed.emissiveMap = null;
  detailed.metalness = 0;
  detailed.roughness = 0.9;
  detailed.normalScale.setScalar(0.8);
  detailed.side = THREE.FrontSide;
  for (const texture of [detailed.map, detailed.normalMap, detailed.roughnessMap]) {
    if (!texture) continue;
    texture.anisotropy = Math.max(1, Math.min(8, anisotropy));
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
  }
  const discarded = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  scene.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const old of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      discarded.add(old);
      for (const value of Object.values(old)) if (value instanceof THREE.Texture) textures.add(value);
    }
    mesh.material = detailed;
  });
  discarded.forEach(m => m.dispose());
  textures.forEach(t => t.dispose());
  material.dispose();
}
