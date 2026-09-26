import * as THREE from 'three';
import { findBone, type CharacterSource, type GltfLoad } from './character';
import { prepareHandGrips } from './handGrip';
import { prepareNativeGait } from './strideSpeed';
import { preparePlayerAppearance } from './playerAppearance';

const DIRECTORY = 'assets/models/new character model/Meshy_AI_Schoolboy_Airplane_Po_biped/';
const FILE = 'Meshy_AI_Schoolboy_Airplane_Po_biped_Animation_';
export const PLAYER_ASSETS = {
  appearance: 'assets/models/new character model/Meshy_AI_Schoolboy_Airplane_Po_0904094652_texture.glb',
  walk: `${DIRECTORY}${FILE}Walking_withSkin.glb`,
  run: `${DIRECTORY}${FILE}Running_withSkin.glb`,
};
const NAMES: Record<string, string> = {
  Spine02: 'Spine', Spine01: 'Spine1', Spine: 'Spine2', neck: 'Neck', head_end: 'HeadTop_End',
};

/** Prepare once at load time. Keep the crowd's original source untouched. */
export async function loadPlayerCharacter(reference: CharacterSource, load: GltfLoad, anisotropy = 4): Promise<CharacterSource> {
  const [walking, running, appearance] = await Promise.all([load(PLAYER_ASSETS.walk), load(PLAYER_ASSETS.run), load(PLAYER_ASSETS.appearance)]);
  const scene = walking.scene;
  scene.userData.playerCharacter = true;
  preparePlayerAppearance(scene, appearance.scene, anisotropy);
  const armature = scene.getObjectByName('Armature');
  if (!armature) throw new Error('Player asset has no Armature');
  // Mesh/inverse binds are metres; exported node translations are centimetres.
  armature.scale.setScalar(1);
  scene.updateMatrixWorld(true);
  const meshes: THREE.SkinnedMesh[] = [];
  scene.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh); });
  if (!meshes.length) throw new Error('Player asset has no skin');
  for (const mesh of meshes) mesh.skeleton.pose();
  scene.updateMatrixWorld(true);
  reference.scene.updateMatrixWorld(true);
  const bones = meshes[0].skeleton.bones;
  const corrections = new Map<THREE.Bone, THREE.Quaternion>();
  const originalNames = new Map<THREE.Bone, string>();
  const worlds = new Map<THREE.Bone, THREE.Matrix4>();
  const unit = new THREE.Vector3(1, 1, 1);
  for (const bone of bones) {
    originalNames.set(bone, bone.name);
    const name = NAMES[bone.name] ?? bone.name;
    const donor = findBone(reference.scene, name);
    const old = bone.getWorldQuaternion(new THREE.Quaternion());
    const orientation = donor?.getWorldQuaternion(new THREE.Quaternion()) ?? old.clone();
    corrections.set(bone, old.clone().invert().multiply(orientation));
    worlds.set(bone, new THREE.Matrix4().compose(bone.getWorldPosition(new THREE.Vector3()), orientation, unit));
    bone.name = donor?.name ?? name;
  }
  // Change coordinate frames, not the bind shape or the skin weights.
  for (const bone of bones) {
    const parent = worlds.get(bone.parent as THREE.Bone) ?? bone.parent!.matrixWorld;
    new THREE.Matrix4().copy(parent).invert().multiply(worlds.get(bone)!)
      .decompose(bone.position, bone.quaternion, bone.scale);
  }
  scene.updateMatrixWorld(true);
  for (const mesh of meshes) {
    mesh.skeleton.calculateInverses();
    mesh.bind(mesh.skeleton, mesh.matrixWorld);
    mesh.frustumCulled = false;
    mesh.normalizeSkinWeights();
    prepareHandGrips(mesh);
  }
  const targetHips = findBone(scene, 'Hips')!;
  // Unweighted socket marker, not a fabricated finger joint in the skin.
  const hand = findBone(scene, 'RightHand');
  const donorKnuckle = findBone(reference.scene, 'RightHandMiddle1');
  if (hand && donorKnuckle) {
    const socket = new THREE.Bone();
    socket.name = donorKnuckle.name;
    socket.position.copy(donorKnuckle.position).multiplyScalar(0.85);
    hand.add(socket);
  }
  const donorHips = findBone(reference.scene, 'Hips')!;
  const ratio = targetHips.position.y / donorHips.position.y;
  const clips = new Map<string, THREE.AnimationClip>();
  for (const [name, clip] of reference.clips) {
    const tracks: THREE.KeyframeTrack[] = [];
    for (const track of clip.tracks) {
      const [node, property] = track.name.split('.');
      const bone = scene.getObjectByName(node);
      if (!bone || !bones.includes(bone as THREE.Bone) || (property !== 'quaternion' && !node.endsWith('Hips'))) continue;
      const copy = track.clone();
      if (property === 'position') {
        for (let i = 0; i < copy.values.length; i += 3) {
          copy.values[i] = targetHips.position.x + (copy.values[i] - donorHips.position.x) * ratio;
          copy.values[i + 1] *= ratio;
          copy.values[i + 2] = targetHips.position.z + (copy.values[i + 2] - donorHips.position.z) * ratio;
        }
      }
      tracks.push(copy);
    }
    clips.set(name, new THREE.AnimationClip(name, clip.duration, tracks));
  }
  const info = new Map([...reference.info].map(([key, value]) => [key, { ...value }]));
  // The native walk occupies this speed band; keep the old jog available for explicit actions.
  const jog = info.get('jog');
  if (jog) jog.role = 'once';
  for (const [name, asset] of [['walk', walking], ['run', running]] as const) {
    const native = asset.animations[0];
    if (!native) throw new Error(`Missing embedded ${name} clip`);
    const tracks: THREE.KeyframeTrack[] = [];
    for (const bone of bones) {
      const original = originalNames.get(bone)!;
      const rotation = native.tracks.find(t => t.name === `${original}.quaternion`);
      if (rotation) {
        const copy = rotation.clone(); copy.name = `${bone.name}.quaternion`;
        const parent = corrections.get(bone.parent as THREE.Bone)?.clone().invert() ?? new THREE.Quaternion();
        const q = new THREE.Quaternion();
        for (let i = 0; i < copy.values.length; i += 4) {
          q.fromArray(copy.values, i).premultiply(parent).multiply(corrections.get(bone)!).normalize().toArray(copy.values, i);
        }
        tracks.push(copy);
      }
      if (bone === targetHips) {
        const position = native.tracks.find(t => t.name === `${original}.position`);
        if (position) {
          const copy = position.clone(); copy.name = `${bone.name}.position`;
          for (let i = 0; i < copy.values.length; i += 3) {
            copy.values[i] = bone.position.x;
            copy.values[i + 1] *= 0.01;
            copy.values[i + 2] = bone.position.z;
          }
          tracks.push(copy);
        }
      }
    }
    const clip = new THREE.AnimationClip(name, native.duration, tracks);
    clips.set(name, clip);
    const groundSpeed = prepareNativeGait(scene, clip, 1.8 / 1.7);
    info.set(name, { ...info.get(name)!, duration: native.duration, groundSpeed });
  }
  // Dispose the second file's duplicate skin; retain only its animation data.
  const textures = new Set<THREE.Texture>();
  running.scene.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      material.dispose();
    }
  });
  textures.forEach(t => t.dispose());
  return { ...reference, scene, clips, info, height: 1.7, albedo: null,
    byRole: role => [...info.values()].filter(c => c.role === role).map(c => c.name) };
}
