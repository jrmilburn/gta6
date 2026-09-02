// Phase 3 dev scene: flat sand plane, a few placeholder walls, one on-foot
// player and one parked car, wired up for walking, jumping and enter/exit.
// Nothing here is imported by the game proper; integration lives in
// core/session.ts.
// DECISION: ground/walls are the same simple placeholder set phase2.ts built
// (drawn locally rather than pulled from core/textures.ts) so this dev scene
// stays independent of Phase 1's city.
import * as THREE from 'three';
import type { AABB, Vec2 } from '../types';
import type { Game } from '../core/game';
import { Vehicle, PlayerDriver } from '../entities/vehicle';
import { CameraRig } from '../camera/cameras';
import { Player, findEnterable, exitPointFor } from '../entities/player';
import { FOOT_CAMERA } from '../camera/footCamera';
import { CFG } from '../config';

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
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(50, 50);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Placeholder obstacles: [centreX, centreZ, sizeX, sizeZ, height]. */
const WALLS: Array<[number, number, number, number, number]> = [
  [-14, 0, 6, 6, 5],
  [16, -10, 8, 5, 4],
];

function buildWalls(scene: THREE.Scene): AABB[] {
  const colliders: AABB[] = [];
  const mat = new THREE.MeshStandardMaterial({ color: 0xe6d6c2, roughness: 0.85 });
  for (const [x, z, sx, sz, h] of WALLS) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, h, sz), mat);
    m.position.set(x, h / 2, z);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
    colliders.push({ minX: x - sx / 2, maxX: x + sx / 2, minZ: z - sz / 2, maxZ: z + sz / 2 });
  }
  return colliders;
}

export function setup(game: Game): void {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(160, 160),
    new THREE.MeshStandardMaterial({ color: 0xd9c9a3, map: sandTexture(), roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  game.scene.add(ground);

  const colliders = buildWalls(game.scene);

  const playerSpawn: Vec2 = { x: 0, z: -14 };
  const carSpawn: Vec2 = { x: 5, z: -14 };

  const player = new Player(game, { pos: playerSpawn, colliders });
  player.setRespawnPoint(playerSpawn);

  const vehicle = new Vehicle(game, { kind: 'sedan', pos: carSpawn, heading: 0, colliders, colorIdx: 3 });
  const vehicles = [vehicle];
  vehicle.setPeers(vehicles);
  player.setVehicles(vehicles);

  const driver = new PlayerDriver(game, vehicle);
  let driving = false;

  const rig = new CameraRig(game, colliders);
  rig.setSubject(player);
  rig.setMode(FOOT_CAMERA);

  game.add(player);
  game.add({ update: (dt) => { if (driving) driver.update(dt); } });
  game.add(vehicle);
  game.addRenderable(player);
  game.addRenderable(vehicle);
  game.addRenderable(rig);

  // DECISION: Game.step() can run several fixed physics ticks inside one
  // rendered frame when catching up, but Input clears `pressed` only once per
  // rendered frame, so a short cooldown keeps one E tap from immediately
  // toggling enter/exit back and forth (see session.ts for the same fix).
  game.add({
    update: () => {
      if (game.input.justPressed('camera')) rig.cycle();

      if (game.input.justPressed('respawn')) {
        if (driving) {
          vehicle.occupied = false;
          vehicle.controls.throttle = 0;
          vehicle.controls.steer = 0;
          vehicle.controls.handbrake = false;
          driving = false;
        }
        player.respawn();
        rig.setSubject(player);
        rig.setMode(FOOT_CAMERA);
        vehicle.reset(carSpawn.x, carSpawn.z, 0);
      }

      if (!game.input.justPressed('interact')) return;
      if (player.onFoot) {
        const target = findEnterable([vehicle], player.pos, CFG.player.enterRadius);
        if (!target) return;
        target.occupied = true;
        driving = true;
        driver.vehicle = target;
        player.onFoot = false;
        rig.setSubject(target);
        rig.setMode('chase');
        game.events.emit('enteredVehicle', { vehicle: target });
      } else if (driving) {
        vehicle.occupied = false;
        vehicle.controls.throttle = 0;
        vehicle.controls.steer = 0;
        vehicle.controls.handbrake = false;
        const exit = exitPointFor(vehicle);
        player.pos.x = exit.x;
        player.pos.z = exit.z;
        player.heading = vehicle.heading;
        player.velocityHeading = vehicle.heading;
        player.onFoot = true;
        player.grantInvuln(1);
        driving = false;
        rig.setSubject(player);
        rig.setMode(FOOT_CAMERA);
        game.events.emit('exitedVehicle', { vehicle });
      }
    },
  });

  // Test/debug hook (plan section 5 deliverable 5).
  (window as unknown as { __player: unknown }).__player = {
    get x() { return player.pos.x; },
    get z() { return player.pos.z; },
    get onFoot() { return player.onFoot; },
    get health() { return player.health; },
  };
}
