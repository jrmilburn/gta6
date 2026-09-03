// The cars that are already parked when the world loads.
//
// Split out of session.ts, which is otherwise wiring rather than construction.
// One drivable car per garage plus a spare by the police station, all with real
// physics from the first frame, so any of them can be crashed into or stolen.
import type { Game } from '../core/game';
import { param } from '../core/rng';
import { Vehicle } from '../entities/vehicle';
import type { CityLayout } from './cityGen';
import type { AABB, VehicleKind } from '../types';

const KINDS: VehicleKind[] = ['sedan', 'sports', 'pickup'];

function pickKind(): VehicleKind {
  const want = param('car');
  return KINDS.includes(want as VehicleKind) ? (want as VehicleKind) : 'sedan';
}

/** Face a car down the road it is parked on rather than into the kerb. */
export function headingAt(city: CityLayout, x: number, z: number): number {
  const { lane } = city.roads.nearestLane({ x, z });
  const a = lane.points[0];
  const b = lane.points[lane.points.length - 1];
  return Math.atan2(b.x - a.x, b.z - a.z);
}

export interface ParkedCars {
  vehicles: Vehicle[];
  /** The one by the police station, which `R` resets along with the player. */
  spareCar: Vehicle;
  spareSpawn: { x: number; z: number };
}

export function spawnVehicles(game: Game, city: CityLayout): ParkedCars {
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

  // A fresh sedan by the police station, for `R`'s "respawn with a fresh sedan
  // nearby" without relocating a garage car.
  const station = city.spawns.policeStation;
  const spareSpawn = { x: station.x + 3, z: station.z };
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
  return { vehicles, spareCar, spareSpawn };
}
