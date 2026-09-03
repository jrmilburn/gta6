// Sidewalk geometry for the pedestrian navigator, split out of pedestrians.ts.
//
// Pure functions over plain numbers: which corners a block has once it is inset
// from the kerb, which side of it two corners span, and whether a point is
// inside a car. None of it needs the state machine that calls it, and that file
// is long enough without them.
import type { PedVehicleLike } from './pedestrians';
import type { Vec2 } from '../types';

/** The plan's sidewalk polylines are inset this far from the block edge. */
export const INSET = 1.5;
// DECISION: the OBB half-extents below are duplicated from vehicle.ts (they are
// module-private there) and must match the plan's stated vehicle OBB, 4.4 long
// by 2.0 wide.
const V_HALF_LEN = 2.2;
const V_HALF_WID = 1.0;
/** Pedestrian capsule radius, approximated as a point plus a margin. */
const HIT_MARGIN = 0.35;

export function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function insetCorners(b: { minX: number; maxX: number; minZ: number; maxZ: number }): Vec2[] {
  return [
    { x: b.minX + INSET, z: b.minZ + INSET },
    { x: b.maxX - INSET, z: b.minZ + INSET },
    { x: b.maxX - INSET, z: b.maxZ - INSET },
    { x: b.minX + INSET, z: b.maxZ - INSET },
  ];
}

/** Which side of the block an edge between two corner indices runs along. */
export function sideBetween(a: number, b: number): number {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  if (lo === 0 && hi === 1) return 0; // south (z = minZ)
  if (lo === 1 && hi === 2) return 1; // east  (x = maxX)
  if (lo === 2 && hi === 3) return 2; // north (z = maxZ)
  return 3;                           // west  (x = minX)
}
export const SIDE_DELTA: ReadonlyArray<readonly [number, number]> = [[0, -1], [1, 0], [0, 1], [-1, 0]];
export const SIDE_AXIS: readonly ('x' | 'z')[] = ['z', 'x', 'z', 'x'];
export const SIDE_SIGN: readonly number[] = [-1, 1, 1, -1];

export function nearestCornerIndex(corners: Vec2[], p: Vec2): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < corners.length; i++) {
    const d = Math.hypot(corners[i].x - p.x, corners[i].z - p.z);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export function obbContainsPoint(v: PedVehicleLike, px: number, pz: number): boolean {
  const dx = px - v.pos.x, dz = pz - v.pos.z;
  const fx = v.forwardX, fz = v.forwardZ, rx = fz, rz = -fx;
  const along = dx * fx + dz * fz;
  const across = dx * rx + dz * rz;
  return Math.abs(along) < V_HALF_LEN + HIT_MARGIN && Math.abs(across) < V_HALF_WID + HIT_MARGIN;
}
