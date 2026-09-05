// The rocket. Unguided, a little heavy, a smoke trail behind it, and it goes
// off on the first thing it touches or at the end of its range.
//
// Swept, not sampled: each step the rocket's path is a segment, and the same
// hit tests the hitscan guns use are run along it, so a fast rocket cannot
// skip through a car between two frames.
import * as THREE from 'three';
import { CFG } from '../config';
import type { PedTarget } from './pedKnockdown';
import { aimRay, rayHitPed, rayHitVehicle, rayHitWorld, type CombatVehicle } from './combatHits';
import { VehicleSmoke } from './vehicleSmoke';
import type { Explosions } from './explosion';

const R = CFG.combat.weapons.rpg.projectile;
const POOL = 3;

interface Rocket {
  live: boolean;
  age: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  mesh: THREE.Group;
  smoke: VehicleSmoke;
}

export interface RocketDeps {
  targets: () => PedTarget[];
  vehicles: () => readonly (CombatVehicle & { explode(delay: number): void })[];
  colliders: readonly { minX: number; minZ: number; maxX: number; maxZ: number }[];
  explosions: Explosions;
}

const DIR = new THREE.Vector3();
const NORMAL = new THREE.Vector3();

export class Rockets {
  readonly group = new THREE.Group();
  private readonly pool: Rocket[] = [];
  private readonly body = new THREE.MeshStandardMaterial({ color: 0x4b5a3a, roughness: 0.7, metalness: 0.3 });
  private readonly head = new THREE.MeshStandardMaterial({ color: 0x7a2a1e, roughness: 0.6, metalness: 0.3 });
  private readonly glow = new THREE.MeshBasicMaterial({ color: 0xffb060 });

  constructor(scene: THREE.Scene, private readonly deps: RocketDeps) {
    this.group.name = 'rockets';
    scene.add(this.group);
    for (let i = 0; i < POOL; i++) {
      const mesh = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.5, 10), this.body);
      shaft.rotation.x = Math.PI / 2;
      const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.036, 0.16, 10), this.head);
      cone.rotation.x = Math.PI / 2;
      cone.position.z = 0.33;
      const flame = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), this.glow);
      flame.position.z = -0.28;
      mesh.add(shaft, cone, flame);
      mesh.visible = false;
      this.group.add(mesh);
      this.pool.push({
        live: false, age: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), mesh,
        smoke: new VehicleSmoke(scene),
      });
    }
  }

  /** Any rocket in flight? The tube shows empty until the next one is loaded. */
  get inFlight(): boolean { return this.pool.some((r) => r.live); }

  /** Fire from `origin` along the camera's aim. */
  launch(origin: THREE.Vector3, camera: THREE.Camera): void {
    const r = this.pool.find((p) => !p.live) ?? this.pool[0];
    aimRay(camera, DIR);
    r.live = true;
    r.age = 0;
    r.pos.copy(origin);
    r.vel.copy(DIR).multiplyScalar(R.speed);
    r.mesh.visible = true;
    r.mesh.position.copy(origin);
    r.mesh.lookAt(origin.x + DIR.x, origin.y + DIR.y, origin.z + DIR.z);
  }

  update(dt: number): void {
    for (const r of this.pool) {
      if (!r.live) { r.smoke.update(dt, 0, r.pos.x, r.pos.y, r.pos.z, false); continue; }
      r.age += dt;
      r.vel.y -= R.gravity * dt;
      const step = r.vel.length() * dt;
      DIR.copy(r.vel).normalize();

      // Sweep the step: nearest of a pedestrian, a car, a wall, the ground.
      let best = step;
      let car: (CombatVehicle & { explode(delay: number): void }) | null = null;
      for (const t of this.deps.targets()) {
        if (t.down) continue;
        const d = rayHitPed(r.pos, DIR, t);
        if (d !== null && d < best) { best = d; car = null; }
      }
      for (const v of this.deps.vehicles()) {
        const d = rayHitVehicle(r.pos, DIR, v);
        if (d !== null && d < best) { best = d; car = v; }
      }
      const world = rayHitWorld(r.pos, DIR, this.deps.colliders, best, NORMAL);
      if (world !== null && world < best) { best = world; car = null; }
      const groundIn = DIR.y < -1e-4 ? (r.pos.y - 0.1) / -DIR.y : Infinity;
      if (groundIn < best) { best = groundIn; car = null; }

      const hit = best < step || r.age * R.speed > CFG.combat.weapons.rpg.range;
      r.pos.addScaledVector(DIR, best);
      r.mesh.position.copy(r.pos);
      r.mesh.lookAt(r.pos.x + DIR.x, r.pos.y + DIR.y, r.pos.z + DIR.z);
      r.smoke.update(dt, 40, r.pos.x - DIR.x * 0.3, r.pos.y - DIR.y * 0.3, r.pos.z - DIR.z * 0.3, false);

      if (hit) {
        r.live = false;
        r.mesh.visible = false;
        // A direct hit on a car is the car's explosion, so it carries the car's
        // own event and scorching; anything else is a blast at the point.
        if (car) car.explode(0);
        else this.deps.explosions.spawn(r.pos.x, Math.max(0.3, r.pos.y), r.pos.z, R.radius);
      }
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const r of this.pool) {
      r.smoke.dispose();
      r.mesh.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    }
    this.body.dispose(); this.head.dispose(); this.glow.dispose();
  }
}
