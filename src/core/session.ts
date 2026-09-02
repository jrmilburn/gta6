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
import { CameraRig, cameraModeNames, type CameraModeName } from '../camera/cameras';
import type { AABB, VehicleKind } from '../types';

const KINDS: VehicleKind[] = ['sedan', 'sports', 'pickup'];

export interface Session {
  city: CityLayout;
  vehicles: Vehicle[];
  /** The car the player is currently driving. Phase 3 reassigns this on enter. */
  playerVehicle: Vehicle;
  driver: PlayerDriver;
  rig: CameraRig;
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

  // One drivable car per garage. The player takes the first; the rest are parked
  // props with real physics, so they can be crashed into or stolen in phase 3.
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
  for (const v of vehicles) {
    v.setPeers(vehicles);
    game.scene.add(v.group);
  }

  const playerVehicle = vehicles[0];
  const driver = new PlayerDriver(game, playerVehicle);

  const rig = new CameraRig(game, city.colliders);
  rig.setSubject(playerVehicle);

  const wantCam = param('cam') as CameraModeName | null;
  if (wantCam && cameraModeNames().includes(wantCam)) rig.setMode(wantCam);

  game.add(driver);
  for (const v of vehicles) game.add(v);
  game.add(rig);
  game.add({ update: () => { if (game.input.justPressed('camera')) rig.cycle(); } });

  return { city, vehicles, playerVehicle, driver, rig };
}
