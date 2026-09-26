import * as THREE from 'three';

/** The supplied skin has rigid open hands. Bake optional fist morphs once in bind space. */
export function prepareHandGrips(mesh: THREE.SkinnedMesh): void {
  const geometry = mesh.geometry.clone();
  mesh.geometry = geometry;
  const position = geometry.getAttribute('position');
  const indices = geometry.getAttribute('skinIndex');
  const weights = geometry.getAttribute('skinWeight');
  const p = new THREE.Vector3(), bent = new THREE.Vector3();
  const morphs: THREE.BufferAttribute[] = [];
  const normals: THREE.BufferAttribute[] = [];
  for (const side of ['Right', 'Left']) {
    const index = mesh.skeleton.bones.findIndex(b => b.name.endsWith(`${side}Hand`));
    if (index < 0) continue;
    const inverse = mesh.skeleton.boneInverses[index];
    const bind = inverse.clone().invert();
    const morph = new THREE.Float32BufferAttribute(position.array.slice(), 3);
    morph.name = `grip${side}`;
    for (let i = 0; i < position.count; i++) {
      let weight = 0;
      for (let k = 0; k < 4; k++) if (indices.array[i * 4 + k] === index) weight += weights.array[i * 4 + k];
      if (weight < 0.01) continue;
      p.fromBufferAttribute(position, i).applyMatrix4(inverse);
      // Preserve the wrist and palm. Bend distal tissue continuously around the grip.
      const length = Math.max(0, p.y - 0.075);
      if (!length) continue;
      const radius = side === 'Right' ? 0.025 : 0.037;
      const angle = Math.min(2.7, length / radius);
      bent.copy(p);
      bent.y = 0.075 + Math.sin(angle) * radius;
      bent.z += (1 - Math.cos(angle)) * radius;
      bent.lerp(p, 1 - weight).applyMatrix4(bind);
      morph.setXYZ(i, bent.x, bent.y, bent.z);
    }
    morphs.push(morph);
    const deformed = geometry.clone();
    deformed.setAttribute('position', morph);
    deformed.computeVertexNormals();
    normals.push(deformed.getAttribute('normal') as THREE.BufferAttribute);
    deformed.dispose();
  }
  geometry.morphAttributes.position = morphs;
  geometry.morphAttributes.normal = normals;
  geometry.morphTargetsRelative = false;
  mesh.updateMorphTargets();
}
