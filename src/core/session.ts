// Builds the actual game world: city meshes, the player's vehicle, parked cars
// and the camera rig, wired into Game's ordered system list.
//
// Systems run in the plan's order: player input -> vehicles -> cameras. Later
// phases splice traffic, pedestrians, police, missions and HUD into the gaps.
import type { Game } from './game';
import { Rng, SEED, param } from './rng';
import { generateCity, type CityLayout } from '../world/cityGen';
import { buildGround } from '../world/ground';
import { buildBuildings } from '../world/buildings';
import { buildProps } from '../world/props';
import { buildWater } from '../world/water';
import { Vehicle, PlayerDriver } from '../entities/vehicle';
import { Player, findEnterable, exitPointFor, FOOT_CAMERA } from '../entities/player';
import { CameraRig, cameraModeNames, type CameraModeName } from '../camera/cameras';
import { CFG } from '../config';
import type { AABB, VehicleKind } from '../types';

const KINDS: VehicleKind[] = ['sedan', 'sports', 'pickup'];

export interface Session {
  city: CityLayout;
  vehicles: Vehicle[];
  /** The player's on-foot controller; hidden and inert while driving. */
  player: Player;
  /** The car the player is currently driving, or null while on foot. */
  playerVehicle: Vehicle | null;
  driver: PlayerDriver;
  rig: CameraRig;
}

/** Release a vehicle's controls so it decelerates naturally once the player steps out. */
function releaseControls(v: Vehicle): void {
  v.controls.throttle = 0;
  v.controls.steer = 0;
  v.controls.handbrake = false;
}

function pickKind(): VehicleKind {
  const want = param('car');
  return KINDS.includes(want as VehicleKind) ? (want as VehicleKind) : 'sedan';
}

/** Face the car down the road it is parked on rather than into the kerb. */
function headingAt(city: CityLayout, x: number, z: number): number {
  const { lane } = city.roads.nearestLane({ x, z });
  const a = lane.points[0];
  const b = lane.points[lane.points.length - 1];
  return Math.atan2(b.x - a.x, b.z - a.z);
}

export function createSession(game: Game): Session {
  const city = generateCity(new Rng(SEED));

  game.scene.add(buildGround(city));
  game.scene.add(buildBuildings(city));
  game.scene.add(buildProps(city));

  const water = buildWater(game.sky.sunDir);
  game.scene.add(water.mesh);
  let waterT = 0;
  game.add({ update: (dt) => { waterT += dt; water.update(waterT); } });

  // One drivable car per garage, parked with real physics so they can be
  // crashed into or stolen. The player starts on foot (phase 3) and reaches
  // them by walking over and pressing E.
  const vehicles: Vehicle[] = [];
  const garages = city.spawns.garages;
  for (let i = 0; i < garages.length; i++) {
    const g = garages[i];
    vehicles.push(new Vehicle(game, {
      kind: i === 0 ? pickKind() : KINDS[i % KINDS.length],
      pos: { x: g.x, z: g.z },
      heading: headingAt(city, g.x, g.z),
      colorIdx: i * 3 + 1,
      colliders: city.colliders as AABB[],
    }));
  }
  // A fresh sedan parked by the police station, for `R`'s "respawn with a
  // fresh sedan nearby" (plan section 5) without relocating a garage car.
  const stationSpot = city.spawns.policeStation;
  const spareSpawn = { x: stationSpot.x + 3, z: stationSpot.z };
  const spareCar = new Vehicle(game, {
    kind: 'sedan',
    pos: spareSpawn,
    heading: headingAt(city, spareSpawn.x, spareSpawn.z),
    colorIdx: garages.length * 3 + 1,
    colliders: city.colliders as AABB[],
  });
  vehicles.push(spareCar);
  for (const v of vehicles) {
    v.setPeers(vehicles);
    game.scene.add(v.group);
  }

  const player = new Player(game, { pos: city.spawns.player, colliders: city.colliders });
  player.setVehicles(vehicles);
  player.setRespawnPoint(stationSpot);

  // The vehicle currently occupied by the player, or null while on foot.
  let current: Vehicle | null = null;
  const driver = new PlayerDriver(game, vehicles[0]);

  const rig = new CameraRig(game, city.colliders);
  rig.setSubject(player);
  rig.setMode(FOOT_CAMERA);

  const wantCam = param('cam') as CameraModeName | null;
  if (wantCam && cameraModeNames().includes(wantCam)) rig.setMode(wantCam);

  game.add(player);
  // The driver only feeds input to a vehicle while the player occupies it;
  // parked cars keep stepping their own physics via the loop below.
  game.add({ update: (dt) => { if (current) driver.update(dt); } });
  for (const v of vehicles) game.add(v);
  game.add(rig);
  game.add({ update: () => { if (game.input.justPressed('camera')) rig.cycle(); } });

  // Enter/exit (plan section 5): E toggles between walking and driving the
  // nearest unoccupied, non-wrecked car within CFG.player.enterRadius.
  // DECISION: Game.step() can run several fixed physics ticks inside one
  // rendered frame when catching up from a slow frame, but Input clears
  // `pressed` only once per rendered frame — so a System.update() keyed off
  // `justPressed` can see the same press several times in a row. A short
  // cooldown keeps one E tap from toggling enter/exit back and forth.
  let lastInteract = -Infinity;
  game.add({
    update: () => {
      if (!game.input.justPressed('interact') || game.time - lastInteract < 0.3) return;
      lastInteract = game.time;
      if (player.onFoot) {
        const target = findEnterable(vehicles, player.pos, CFG.player.enterRadius);
        if (!target) return;
        target.occupied = true;
        current = target;
        driver.vehicle = target;
        player.onFoot = false;
        rig.setSubject(target);
        rig.setMode('chase');
        game.events.emit('enteredVehicle', { vehicle: target });
      } else if (current) {
        const v = current;
        v.occupied = false;
        releaseControls(v); // let it decelerate naturally, no more driver input
        const exit = exitPointFor(v);
        player.pos.x = exit.x;
        player.pos.z = exit.z;
        player.heading = v.heading;
        player.velocityHeading = v.heading;
        player.onFoot = true;
        player.grantInvuln(1); // don't get clipped by the car you just left
        current = null;
        rig.setSubject(player);
        rig.setMode(FOOT_CAMERA);
        game.events.emit('exitedVehicle', { vehicle: v });
      }
    },
  });

  // Respawn (plan section 5): R always returns the player to the police
  // station on foot, forcing an exit first if they were mid-drive, and resets
  // the spare sedan parked there to full health.
  game.add({
    update: () => {
      if (!game.input.justPressed('respawn')) return;
      if (current) {
        releaseControls(current);
        current.occupied = false;
        current = null;
      }
      player.respawn();
      rig.setSubject(player);
      rig.setMode(FOOT_CAMERA);
      spareCar.reset(spareSpawn.x, spareSpawn.z, headingAt(city, spareSpawn.x, spareSpawn.z));
    },
  });

  return { city, vehicles, player, driver, rig, get playerVehicle() { return current; } };
}
