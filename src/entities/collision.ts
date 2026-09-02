// 2D collision primitives for the arcade vehicle model (plan section 4).
// Everything is XZ-plane only: colliders are AABBs with no height, so a wall is
// treated as infinitely tall. // DECISION: AABB in types.ts carries no height,
// so vertical clearance is out of scope for this phase.
import type { AABB } from '../types';

export interface Hit {
  /** Unit separation normal pointing from the box towards the vehicle. */
  nx: number;
  nz: number;
  /** Penetration depth along the normal, in metres. */
  depth: number;
}

/**
 * Separating-axis test between an oriented box (centre `cx,cz`, half-length `hl`
 * along `f`, half-width `hw` along right(f)) and an axis-aligned box.
 * Returns the minimum-penetration axis, or null when they are disjoint.
 */
export function obbVsAabb(
  cx: number, cz: number, hl: number, hw: number,
  fx: number, fz: number, b: AABB,
): Hit | null {
  const rx = fz, rz = -fx; // right(heading)
  const bx = (b.minX + b.maxX) * 0.5, bz = (b.minZ + b.maxZ) * 0.5;
  const ex = (b.maxX - b.minX) * 0.5, ez = (b.maxZ - b.minZ) * 0.5;
  const dx = cx - bx, dz = cz - bz;

  let best = Infinity, nx = 0, nz = 0;
  // Four candidate axes: the two world axes and the two box axes.
  for (let i = 0; i < 4; i++) {
    const ax = i === 0 ? 1 : i === 1 ? 0 : i === 2 ? fx : rx;
    const az = i === 0 ? 0 : i === 1 ? 1 : i === 2 ? fz : rz;
    const rObb = Math.abs(fx * ax + fz * az) * hl + Math.abs(rx * ax + rz * az) * hw;
    const rBox = ex * Math.abs(ax) + ez * Math.abs(az);
    const d = dx * ax + dz * az;
    const overlap = rObb + rBox - Math.abs(d);
    if (overlap <= 0) return null;
    if (overlap < best) {
      best = overlap;
      const s = d < 0 ? -1 : 1;
      nx = ax * s; nz = az * s;
    }
  }
  return { nx, nz, depth: best };
}

/**
 * Distance along the segment a->b at which it first enters an AABB, or -1.
 * Slab method; used by the chase camera to pull in through buildings.
 */
export function segmentVsAabb(
  ax: number, az: number, bx: number, bz: number, box: AABB,
): number {
  const dx = bx - ax, dz = bz - az;
  let tmin = 0, tmax = 1;
  for (let axis = 0; axis < 2; axis++) {
    const o = axis === 0 ? ax : az;
    const d = axis === 0 ? dx : dz;
    const lo = axis === 0 ? box.minX : box.minZ;
    const hi = axis === 0 ? box.maxX : box.maxZ;
    if (Math.abs(d) < 1e-6) {
      if (o < lo || o > hi) return -1;
      continue;
    }
    let t1 = (lo - o) / d, t2 = (hi - o) / d;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}
