// Push-out collision and the "which car can I get into" query, split out of
// player.ts.
//
// All pure functions over plain data: no scene, no state, no three.js. The
// controller is long enough without them, and a shape test that cannot reach
// anything is a shape test that can be read on its own.
import type { AABB, Vec2 } from '../types';

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export interface CircleHit { nx: number; nz: number; depth: number }

/** Closest-point circle-vs-AABB push-out, with a fallback for a centre already inside the box. */
export function circleVsAabb(px: number, pz: number, r: number, b: AABB): CircleHit | null {
  const cx = clamp(px, b.minX, b.maxX);
  const cz = clamp(pz, b.minZ, b.maxZ);
  const dx = px - cx, dz = pz - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 > r * r) return null;
  if (d2 > 1e-6) {
    const d = Math.sqrt(d2);
    return { nx: dx / d, nz: dz / d, depth: r - d };
  }
  const left = px - b.minX, right = b.maxX - px, bottom = pz - b.minZ, top = b.maxZ - pz;
  const m = Math.min(left, right, bottom, top);
  if (m === left) return { nx: -1, nz: 0, depth: r + left };
  if (m === right) return { nx: 1, nz: 0, depth: r + right };
  if (m === bottom) return { nx: 0, nz: -1, depth: r + bottom };
  return { nx: 0, nz: 1, depth: r + top };
}

/** The subset of Vehicle a player needs to collide with and take damage from. */
export interface VehicleLike {
  pos: Vec2;
  speed: number;
  wrecked: boolean;
}

/** The subset of Vehicle needed to find and describe an enterable car. */
export interface EnterableVehicle extends VehicleLike {
  occupied: boolean;
  heading: number;
}

/** Nearest non-wrecked, unoccupied vehicle within `radius`, or null. */
export function findEnterable<T extends EnterableVehicle>(
  vehicles: readonly T[], p: Vec2, radius: number,
): T | null {
  let best: T | null = null, bestD = radius;
  for (const v of vehicles) {
    if (v.wrecked || v.occupied) continue;
    const d = Math.hypot(v.pos.x - p.x, v.pos.z - p.z);
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

/** Where the player appears when they step out of a vehicle: left side, 1.5 m out. */
export function exitPointFor(v: EnterableVehicle): Vec2 {
  return { x: v.pos.x - Math.cos(v.heading) * 1.5, z: v.pos.z + Math.sin(v.heading) * 1.5 };
}
