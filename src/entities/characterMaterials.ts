// Materials for one character rig: private copies, palette swaps and the fade.
//
// Split out of characterRig.ts, which is otherwise entirely about motion. The
// ownership rule is the interesting part and it lives here: a rig either wears
// a palette shared with every other pedestrian of its colour, or its own copies
// of the source materials -- and only the copies may be faded or disposed,
// because doing either to a shared palette reaches every pedestrian wearing it.
import * as THREE from 'three';

export class RigMaterials {
  /** Copies this rig owns outright. Shared palette materials are not here. */
  private readonly owned: THREE.Material[] = [];
  private readonly root: THREE.Object3D;
  private opacity = 1;

  constructor(root: THREE.Object3D, palette?: Map<string, THREE.Material>) {
    this.root = root;
    const seen = new Set<string>();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const out: THREE.Material[] = [];
      for (const m of src) {
        const shared = palette?.get(m.name);
        if (shared) { out.push(shared); continue; }
        const copy = m.clone();
        out.push(copy);
        if (!seen.has(copy.uuid)) { seen.add(copy.uuid); this.owned.push(copy); }
      }
      mesh.material = out.length === 1 ? out[0] : out;
    });
  }

  /** Re-dress in another palette; the pedestrian LOD swap does this on reuse. */
  setPalette(materials: Map<string, THREE.Material>): void {
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const out = src.map((m) => materials.get(m.name) ?? m);
      mesh.material = out.length === 1 ? out[0] : out;
    });
  }

  /** The 0.2 s dissolve at a car door. Only ever touches materials we own. */
  setOpacity(opacity: number): void {
    if (Math.abs(opacity - this.opacity) < 0.001) return;
    this.opacity = opacity;
    const solid = opacity >= 0.999;
    for (const m of this.owned) {
      const std = m as THREE.MeshStandardMaterial;
      const was = std.transparent;
      std.opacity = opacity;
      std.transparent = !solid;
      std.depthWrite = solid;
      if (was !== std.transparent) std.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const m of this.owned) m.dispose();
    this.owned.length = 0;
  }
}
