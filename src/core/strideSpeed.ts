import * as THREE from 'three';
import { findBone } from './character';

/** Ground native soles and measure stance speed once, never during gameplay. */
export function prepareNativeGait(scene: THREE.Object3D, clip: THREE.AnimationClip, scale: number): number {
  const feet = [findBone(scene, 'LeftToeBase'), findBone(scene, 'RightToeBase')];
  const hips = findBone(scene, 'Hips')!;
  const soles: Array<{ mesh: THREE.SkinnedMesh; vertices: number[] }> = [];
  scene.traverse(o => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const vertices: number[] = [];
    const position = mesh.geometry.getAttribute('position');
    // Bind-space shoe band on the normalized, metre-scale source.
    for (let i = 0; i < position.count; i++) if (position.getY(i) < 0.18) vertices.push(i);
    soles.push({ mesh, vertices });
  });
  const mixer = new THREE.AnimationMixer(scene);
  const action = mixer.clipAction(clip).play();
  const frames = 90, dt = clip.duration / frames;
  const p = new THREE.Vector3();
  const samples = feet.map(() => [] as Array<{ y: number; z: number }>);
  const times: number[] = [], positions: number[] = [];
  for (let i = 0; i <= frames; i++) {
    action.time = i * dt; mixer.update(0); scene.updateMatrixWorld(true);
    feet.forEach((foot, side) => {
      if (!foot) return;
      foot.getWorldPosition(p); samples[side].push({ y: p.y, z: p.z });
    });
    let floor = Infinity;
    for (const { mesh, vertices } of soles) {
      const position = mesh.geometry.getAttribute('position');
      for (const vertex of vertices) {
        p.fromBufferAttribute(position, vertex);
        mesh.applyBoneTransform(vertex, p);
        floor = Math.min(floor, p.y);
      }
    }
    times.push(i * dt);
    positions.push(hips.position.x, hips.position.y + Math.max(0, -floor + 0.002), hips.position.z);
  }
  action.stop(); mixer.uncacheRoot(scene);
  clip.tracks = clip.tracks.filter(track => !/Hips\.position$/.test(track.name));
  clip.tracks.push(new THREE.VectorKeyframeTrack(`${hips.name}.position`, times, positions));
  const speeds: number[] = [];
  for (const sample of samples) {
    const floor = Math.min(...sample.map(p => p.y));
    for (let i = 1; i < sample.length; i++) {
      const a = sample[i - 1], b = sample[i];
      const velocity = (a.z - b.z) / dt;
      if (a.y < floor + 0.045 && b.y < floor + 0.045 && velocity > 0.15) speeds.push(velocity * scale);
    }
  }
  speeds.sort((a, b) => a - b);
  if (!speeds.length) throw new Error(`Cannot measure stride for ${clip.name}`);
  return speeds[Math.floor(speeds.length / 2)];
}
