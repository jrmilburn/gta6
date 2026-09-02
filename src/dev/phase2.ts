// Phase 2 dev scene: flat sand plane, a handful of placeholder walls, one
// player-driven vehicle and the chase camera. The city arrives in integration;
// nothing here is imported by the game proper.
// DECISION: the ground texture is drawn locally rather than pulled from
// core/textures.ts so this dev scene stays independent of Phase 1's work.
import * as THREE from 'three';
import type { AABB, System, VehicleKind } from '../types';
import type { Game } from '../core/game';
import { param } from '../core/rng';
import { Vehicle, PlayerDriver } from '../entities/vehicle';
import { CameraRig } from '../camera/cameras';

const KINDS: VehicleKind[] = ['sedan', 'sports', 'pickup', 'police'];

function sandTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  ctx.fillStyle = '#d9c9a3';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1800; i++) {
    const v = 150 + Math.floor(Math.random() * 70);
    ctx.fillStyle = `rgba(${v},${v - 15},${v - 45},0.35)`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  ctx.strokeStyle = 'rgba(150,135,105,0.25)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, 254, 254);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(50, 50);
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Placeholder obstacles: [centreX, centreZ, sizeX, sizeZ, height]. */
const WALLS: Array<[number, number, number, number, number]> = [
  [0, 86, 64, 4, 7],      // crash wall straight ahead of the spawn
  [-26, -18, 10, 10, 9],
  [30, 6, 14, 8, 6],
  [-44, 34, 8, 26, 12],
  [38, -46, 16, 16, 8],
  [-8, 40, 4, 22, 5],
  [62, 58, 20, 6, 10],
];

function buildWalls(scene: THREE.Scene): AABB[] {
  const colliders: AABB[] = [];
  const mat = new THREE.MeshStandardMaterial({ color: 0xe6d6c2, roughness: 0.85 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xb08f76, roughness: 0.9 });
  for (const [x, z, sx, sz, h] of WALLS) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, h, sz), mat);
    m.position.set(x, h / 2, z);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(sx + 0.4, 0.4, sz + 0.4), trim);
    cap.position.set(x, h + 0.2, z);
    cap.castShadow = true;
    scene.add(cap);
    colliders.push({ minX: x - sx / 2, maxX: x + sx / 2, minZ: z - sz / 2, maxZ: z + sz / 2 });
  }
  return colliders;
}

export function setup(game: Game): void {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: 0xd9c9a3, map: sandTexture(), roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  game.scene.add(ground);

  const colliders = buildWalls(game.scene);

  const requested = param('car');
  const kind = (KINDS as string[]).includes(requested ?? '') ? (requested as VehicleKind) : 'sedan';
  const spawn = { x: 0, z: -80 };

  const vehicle = new Vehicle(game, { kind, pos: spawn, heading: 0, colliders, colorIdx: 5 });
  vehicle.occupied = true;

  const rig = new CameraRig(game, colliders);
  rig.setSubject(vehicle);

  const keys: System = {
    update: () => {
      if (game.input.justPressed('camera')) rig.cycle();
      if (game.input.justPressed('respawn')) vehicle.reset(spawn.x, spawn.z, 0);
    },
  };

  game.add(keys);
  game.add(new PlayerDriver(game, vehicle));
  game.add(vehicle);
  game.add(rig);

  // Test hook for smoke/drive.spec.ts.
  (window as unknown as { __vehicle: unknown }).__vehicle = {
    get speed() { return vehicle.speed; },
    get x() { return vehicle.pos.x; },
    get z() { return vehicle.pos.z; },
    get health() { return vehicle.health; },
    get heading() { return vehicle.heading; },
    get wrecked() { return vehicle.wrecked; },
    get kind() { return vehicle.kind; },
    reset: (x: number, z: number, heading = 0) => vehicle.reset(x, z, heading),
    vehicle,
  };
}
