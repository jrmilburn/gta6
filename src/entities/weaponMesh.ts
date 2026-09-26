// The four guns, as procedural meshes in the character's hand.
//
// Built the way pistol.ts builds the pistol: boxes and cylinders in a group
// whose +Z is the barrel, sized to be read from two metres behind the shoulder.
// Each returns the same parts the pistol does -- group, muzzle, flash -- so the
// hand fit, the tracer and the muzzle flash need no idea which gun is out.
import * as THREE from 'three';
import { buildPistol, fitPistolToHand, type PistolParts } from './pistol';

export type WeaponId = 'pistol' | 'mg' | 'sniper' | 'rpg';

export interface WeaponParts extends PistolParts {
  /** The RPG's warhead, hidden while the tube is empty; absent on the guns. */
  warhead: THREE.Object3D | null;
}

export const fitToHand = fitPistolToHand;

const BODY = () => new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.42, metalness: 0.75 });
const GRIP = () => new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.85, metalness: 0.1 });
const WOOD = () => new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.8, metalness: 0.05 });
const OLIVE = () => new THREE.MeshStandardMaterial({ color: 0x4b5a3a, roughness: 0.75, metalness: 0.2 });
const WARHEAD = () => new THREE.MeshStandardMaterial({ color: 0x7a2a1e, roughness: 0.6, metalness: 0.3 });

function box(w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  return mesh;
}

/** A cylinder along +Z. */
function tube(r: number, len: number, x: number, y: number, z: number, m: THREE.Material, r2 = r): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r2, r, len, 12), m);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(x, y, z);
  return mesh;
}

function flashCard(size: number, z: number, y: number): { flash: THREE.Mesh; mat: THREE.Material } {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffd9a0, transparent: true, opacity: 0.9, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const flash = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  flash.position.set(0, y, z);
  flash.visible = false;
  return { flash, mat };
}

function finish(group: THREE.Group, flash: THREE.Mesh, muzzle: THREE.Object3D, warhead: THREE.Object3D | null, mats: THREE.Material[]): WeaponParts {
  const owned: Array<{ dispose(): void }> = [...mats, flash.geometry];
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry && m !== flash) owned.push(m.geometry);
    if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
  });
  return { group, muzzle, flash, warhead, dispose(): void { for (const o of owned) o.dispose(); } };
}

/**
 * Submachine gun: a stubby receiver, a magazine hanging below, a folding stock
 * back over the wrist and a short barrel. Held at the grip, so the receiver
 * sits above and ahead of the hand.
 */
function buildMg(): WeaponParts {
  const group = new THREE.Group();
  group.name = 'mg';
  group.visible = false;
  const body = BODY(), grip = GRIP();
  group.add(box(0.034, 0.05, 0.30, 0, 0.045, 0.09, body));        // receiver
  group.add(tube(0.008, 0.14, 0, 0.055, 0.30, body));              // barrel
  group.add(box(0.02, 0.11, 0.028, 0, -0.02, 0.10, grip));         // magazine
  group.add(box(0.026, 0.08, 0.034, 0, -0.04, -0.03, grip).rotateX(-0.2)); // pistol grip
  group.add(box(0.02, 0.02, 0.18, 0, 0.04, -0.16, body));           // stock bar
  group.add(box(0.02, 0.06, 0.02, 0, 0.02, -0.25, grip));           // butt
  group.add(box(0.012, 0.02, 0.03, 0, 0.08, 0.02, body));           // rear sight
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.055, 0.37);
  group.add(muzzle);
  const { flash, mat } = flashCard(0.16, 0.39, 0.055);
  group.add(flash);
  return finish(group, flash, muzzle, null, [body, grip, mat]);
}

/**
 * Sniper rifle: a long barrel, a wooden stock, a scope tube on top and a bipod
 * folded under the forestock.
 */
function buildSniper(): WeaponParts {
  const group = new THREE.Group();
  group.name = 'sniper';
  group.visible = false;
  const body = BODY(), wood = WOOD(), grip = GRIP();
  group.add(box(0.03, 0.045, 0.26, 0, 0.04, 0.02, body));          // receiver
  group.add(tube(0.009, 0.62, 0, 0.05, 0.44, body));               // barrel
  group.add(box(0.034, 0.05, 0.30, 0, 0.025, 0.28, wood));         // forestock
  group.add(box(0.03, 0.09, 0.26, 0, -0.03, -0.20, wood).rotateX(0.12)); // stock
  group.add(box(0.026, 0.07, 0.03, 0, -0.03, -0.04, grip).rotateX(-0.25)); // grip
  group.add(tube(0.016, 0.20, 0, 0.095, 0.02, body));              // scope
  group.add(box(0.012, 0.03, 0.02, 0, 0.075, -0.05, body));         // scope mount
  group.add(box(0.012, 0.03, 0.02, 0, 0.075, 0.09, body));
  group.add(box(0.006, 0.09, 0.006, -0.02, -0.02, 0.36, body).rotateZ(0.5)); // bipod legs
  group.add(box(0.006, 0.09, 0.006, 0.02, -0.02, 0.36, body).rotateZ(-0.5));
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.05, 0.75);
  group.add(muzzle);
  const { flash, mat } = flashCard(0.22, 0.77, 0.05);
  group.add(flash);
  return finish(group, flash, muzzle, null, [body, wood, grip, mat]);
}

/**
 * Rocket launcher: a fat tube with a flared rear, a grip and a second handle
 * under it, a sight on top and the rocket's warhead showing at the front.
 */
function buildRpg(): WeaponParts {
  const group = new THREE.Group();
  group.name = 'rpg';
  group.visible = false;
  const olive = OLIVE(), grip = GRIP(), head = WARHEAD();
  group.add(tube(0.03, 0.70, 0, 0.06, 0.05, olive));               // tube
  group.add(tube(0.03, 0.12, 0, 0.06, -0.36, olive, 0.045));        // flared rear
  group.add(box(0.028, 0.08, 0.035, 0, -0.01, -0.02, grip).rotateX(-0.25)); // grip
  group.add(box(0.026, 0.06, 0.03, 0, 0.0, 0.16, grip));            // front handle
  group.add(box(0.012, 0.05, 0.04, 0, 0.11, -0.06, olive));         // sight
  const warhead = new THREE.Group();
  warhead.add(tube(0.036, 0.10, 0, 0, 0.0, head, 0.028));
  warhead.add(tube(0.028, 0.10, 0, 0, 0.10, head, 0.004));         // cone
  warhead.position.set(0, 0.06, 0.44);
  group.add(warhead);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.06, 0.42);
  group.add(muzzle);
  const { flash, mat } = flashCard(0.3, 0.46, 0.06);
  group.add(flash);
  return finish(group, flash, muzzle, warhead, [olive, grip, head, mat]);
}

export function buildWeapon(id: WeaponId): WeaponParts {
  switch (id) {
    case 'mg': return buildMg();
    case 'sniper': return buildSniper();
    case 'rpg': return buildRpg();
    default: return { ...buildPistol(), warhead: null };
  }
}
