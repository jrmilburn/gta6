// The arsenal: which weapon is out, its mesh in the hand, and what a trigger
// pull does with it.
//
// Split out of combat.ts, which keeps the stance, the aim and the punch. This
// file owns the weapon table's consequences: the hitscan shot with its spread
// and tracer, the rocket launch, the muzzle flash, the reload of the tube, and
// the 1-4 / wheel selection. It knows nothing about poses; combat.ts asks it
// which hold set the current weapon wants and does the rest.
import * as THREE from 'three';
import { CFG } from '../config';
import type { EventName } from '../types';
import { findBone } from '../core/character';
import type { CharacterRig } from './characterRig';
import type { PedTarget } from './pedKnockdown';
import { ShotEffects } from './pistol';
import { aimRay, rayHitPed, rayHitVehicle, rayHitWorld, type CombatVehicle } from './combatHits';
import { buildWeapon, fitToHand, type WeaponId, type WeaponParts } from './weaponMesh';
import type { Rockets } from './projectile';
import { fitPlayerWeapon } from './weaponAnimation';

export type { WeaponId } from './weaponMesh';

const W = CFG.combat.weapons;
export const WEAPON_ORDER: WeaponId[] = ['pistol', 'mg', 'sniper', 'rpg'];
export type WeaponDef = (typeof W)[WeaponId];

export interface ArsenalHost {
  camera: THREE.PerspectiveCamera;
  input: {
    justPressed(a: 'weapon1' | 'weapon2' | 'weapon3' | 'weapon4'): boolean;
    mouse: { left: boolean; leftPressed: boolean };
    wheel: number;
  };
  events: { emit(evt: EventName, payload?: unknown): void };
  audio: { gunshot(kind: WeaponId): void };
  time: number;
}

export interface ArsenalDeps {
  player: { pos: { x: number; z: number }; y: number; heading: number };
  targets: () => PedTarget[];
  vehicles: readonly CombatVehicle[];
  colliders: readonly { minX: number; minZ: number; maxX: number; maxZ: number }[];
  kick: (radians: number) => void;
  rockets: Rockets;
}

const V = new THREE.Vector3();
const HIT = new THREE.Vector3();
const NORMAL = new THREE.Vector3();
const MUZZLE = new THREE.Vector3();
const RIGHT = new THREE.Vector3();
const UP = new THREE.Vector3();

export class Arsenal {
  current: WeaponId = 'pistol';
  /** When the selection last changed, for the HUD's wheel flash. */
  changedAt = -10;
  shots = 0;
  /** Seconds of continuous SMG fire, for the climbing kick. */
  private burst = 0;
  private fireCooldown = 0;
  private flashLeft = 0;
  private readonly effects = new ShotEffects();
  private readonly meshes = new Map<WeaponId, WeaponParts>();
  private attachedTo: CharacterRig | null = null;

  constructor(private readonly host: ArsenalHost, private readonly deps: ArsenalDeps, scene: THREE.Scene) {
    scene.add(this.effects.group);
  }

  get def(): WeaponDef { return W[this.current]; }
  get parts(): WeaponParts | null { return this.meshes.get(this.current) ?? null; }
  /** Seconds until the weapon can fire again, 0..1 of its interval; the HUD shows the RPG reload. */
  get reload(): number { return this.def.fireInterval > 0 ? this.fireCooldown / this.def.fireInterval : 0; }

  /** Read the 1-4 keys and the wheel. Returns true when the weapon changed. */
  select(): boolean {
    const keys: Array<'weapon1' | 'weapon2' | 'weapon3' | 'weapon4'> = ['weapon1', 'weapon2', 'weapon3', 'weapon4'];
    let next = this.current;
    keys.forEach((k, i) => { if (this.host.input.justPressed(k)) next = WEAPON_ORDER[i]; });
    if (this.host.input.wheel !== 0) {
      const i = WEAPON_ORDER.indexOf(this.current);
      const n = WEAPON_ORDER.length;
      next = WEAPON_ORDER[(i + Math.sign(this.host.input.wheel) + n) % n];
    }
    if (next === this.current) return false;
    this.current = next;
    this.changedAt = this.host.time;
    this.shots = 0;
    this.fireCooldown = Math.min(this.fireCooldown, 0.25);
    this.host.events.emit('weaponChanged', { weapon: next });
    return true;
  }

  /** Per frame: cooldowns, the flash, and which mesh is showing. */
  update(dt: number, rig: CharacterRig | null, draw: number, firing: boolean): void {
    this.effects.update(dt);
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.burst = firing ? this.burst + dt : Math.max(0, this.burst - dt * 3);
    if (this.flashLeft > 0) {
      this.flashLeft -= dt;
      if (this.flashLeft <= 0) for (const m of this.meshes.values()) m.flash.visible = false;
    }
    if (rig) this.attach(rig);
    for (const [id, m] of this.meshes) {
      m.group.visible = id === this.current && draw > 0.05;
      // The tube shows empty while the last rocket is in the air or reloading.
      if (m.warhead) m.warhead.visible = !(this.deps.rockets.inFlight || this.fireCooldown > 0.2);
    }
  }

  /**
   * The trigger. Auto weapons fire while held; the others once per press --
   * a rate a held trigger has, and one click is still one shot because the
   * interval is longer than a click. Returns true when a shot went off.
   */
  fire(draw: number): boolean {
    const def = this.def;
    const want = def.auto ? this.host.input.mouse.left : this.host.input.mouse.leftPressed;
    if (!want || draw < 0.95 || this.fireCooldown > 0) return false;
    this.fireCooldown = def.fireInterval;
    this.shots++;
    this.muzzle(MUZZLE);
    this.host.audio.gunshot(this.current);
    const parts = this.parts;
    if (parts) { parts.flash.visible = true; this.flashLeft = CFG.combat.pistol.flashTime; }

    // A held SMG burst climbs: every shot adds a little, to a cap of double.
    const climb = def.auto ? Math.min(2, 1 + this.burst * 10 * CFG.combat.burstClimb) : 1;
    this.deps.kick((def.kickDeg * climb * Math.PI) / 180);

    if (def.projectile) {
      this.deps.rockets.launch(MUZZLE, this.host.camera);
      return true;
    }
    this.hitscan(def);
    return true;
  }

  private hitscan(def: WeaponDef): void {
    // The shot comes from the camera through the crosshair, because that is
    // what the player aimed; the tracer starts at the barrel so it looks like
    // the gun fired it. Spread is a random offset inside the cone.
    const ray = aimRay(this.host.camera, V);
    if (def.spread > 0) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * (def.spread * Math.PI) / 180;
      RIGHT.set(1, 0, 0).applyQuaternion(this.host.camera.quaternion);
      UP.set(0, 1, 0).applyQuaternion(this.host.camera.quaternion);
      ray.addScaledVector(RIGHT, Math.cos(a) * r).addScaledVector(UP, Math.sin(a) * r).normalize();
    }
    const cam = this.host.camera.position;

    let best = def.range;
    let hitKind: 'ped' | 'vehicle' | 'world' | null = null;
    let hitPed: PedTarget | null = null;
    let hitVehicle: CombatVehicle | null = null;
    for (const t of this.deps.targets()) {
      if (t.down) continue;
      const d = rayHitPed(cam, ray, t);
      if (d !== null && d < best) { best = d; hitKind = 'ped'; hitPed = t; }
    }
    for (const v of this.deps.vehicles) {
      const d = rayHitVehicle(cam, ray, v);
      if (d !== null && d < best) { best = d; hitKind = 'vehicle'; hitVehicle = v; }
    }
    const world = rayHitWorld(cam, ray, this.deps.colliders, best, NORMAL);
    if (world !== null && world < best) { best = world; hitKind = 'world'; }

    HIT.copy(cam).addScaledVector(ray, best);
    this.effects.tracerTo(MUZZLE, HIT);
    const p = this.deps.player;
    if (hitKind === 'ped' && hitPed) {
      hitPed.knockDown(p.pos.x, p.pos.z);
      this.host.events.emit('shotHit', { kind: 'pedestrian', x: hitPed.x, z: hitPed.z });
    } else if (hitKind === 'vehicle' && hitVehicle) {
      hitVehicle.damage(def.damage, true);
      this.effects.spark(HIT, NORMAL.copy(ray).multiplyScalar(-1));
      this.host.events.emit('shotHit', {
        kind: 'vehicle', x: hitVehicle.pos.x, z: hitVehicle.pos.z, police: hitVehicle.kind === 'police',
      });
    } else if (hitKind === 'world') {
      this.effects.mark(HIT, NORMAL);
      this.host.events.emit('shotHit', { kind: 'world', x: HIT.x, z: HIT.z });
    } else {
      this.host.events.emit('shotHit', { kind: 'miss', x: HIT.x, z: HIT.z });
    }
  }

  /** Parent every gun to the hand once, the first time a rig exists. */
  private attach(rig: CharacterRig): void {
    if (this.attachedTo === rig) return;
    const hand = findBone(rig.root, 'RightHand');
    if (!hand) return;
    const forearm = findBone(rig.root, 'RightForeArm');
    const knuckle = findBone(rig.root, 'RightHandMiddle1');
    for (const id of WEAPON_ORDER) {
      let m = this.meshes.get(id);
      if (!m) { m = buildWeapon(id); this.meshes.set(id, m); }
      hand.add(m.group);
      if (rig.root.userData.playerCharacter) fitPlayerWeapon(m.group, id);
      else fitToHand(m.group, hand, forearm, knuckle);
    }
    this.attachedTo = rig;
  }

  /** World-space muzzle, falling back to a point in front of the chest. */
  muzzle(out: THREE.Vector3): THREE.Vector3 {
    const parts = this.parts;
    if (parts && parts.group.visible) {
      parts.muzzle.getWorldPosition(out);
      return out;
    }
    const p = this.deps.player;
    return out.set(
      p.pos.x + Math.sin(p.heading) * 0.4, p.y + 1.4, p.pos.z + Math.cos(p.heading) * 0.4,
    );
  }

  dispose(): void {
    this.effects.dispose();
    for (const m of this.meshes.values()) m.dispose();
  }
}
