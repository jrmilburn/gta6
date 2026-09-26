import * as THREE from 'three';

/** Keep blended soles above the capsule floor using a small cached shoe sample. */
export class CharacterGrounding {
  private readonly soles: Array<{ mesh: THREE.SkinnedMesh; vertices: number[] }> = [];
  private readonly point = new THREE.Vector3();
  private readonly toGroup = new THREE.Matrix4();

  constructor(private readonly root: THREE.Object3D) {
    if (!root.userData.playerCharacter) return;
    root.traverse(o => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      const positions = mesh.geometry.getAttribute('position');
      const cells = new Map<string, number>();
      for (let i = 0; i < positions.count; i++) {
        if (positions.getY(i) > 0.12) continue;
        const key = `${Math.round(positions.getX(i) / 0.015)},${Math.round(positions.getZ(i) / 0.015)}`;
        const previous = cells.get(key);
        if (previous === undefined || positions.getY(i) < positions.getY(previous)) cells.set(key, i);
      }
      this.soles.push({ mesh, vertices: [...cells.values()] });
    });
  }

  update(): void {
    if (!this.soles.length || !this.root.parent) return;
    this.root.updateWorldMatrix(true, true);
    // SkinnedMesh refreshes its inverse bind transform in updateMatrixWorld,
    // not updateWorldMatrix. A stale inverse includes the previous frame's
    // correction and would feed that lift back into every subsequent frame.
    this.root.updateMatrixWorld(true);
    let floor = Infinity;
    for (const { mesh, vertices } of this.soles) {
      this.toGroup.copy(this.root.parent.matrixWorld).invert().multiply(mesh.matrixWorld);
      const positions = mesh.geometry.getAttribute('position');
      for (const vertex of vertices) {
        this.point.fromBufferAttribute(positions, vertex);
        mesh.applyBoneTransform(vertex, this.point).applyMatrix4(this.toGroup);
        floor = Math.min(floor, this.point.y);
      }
    }
    // Only remove penetration: retain authored flight phases and crouches.
    this.root.position.y += Math.max(0, 0.003 - floor);
  }
}
