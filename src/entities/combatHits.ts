// Ray tests for the pistol (section 7).
//
// Three kinds of thing stop a bullet, and each is the cheapest shape that is
// honest about what it represents: a pedestrian is an upright capsule, a car is
// the oriented box the physics already uses, and the world is the same axis-
// aligned building footprints the camera checks for occlusion.
import * as THREE from 'three';
import type { PedTarget } from './pedestrians';
import type { VehicleKind } from '../types';

/** What a bullet needs to know about a car. */
export interface CombatVehicle {
  pos: { x: number; z: number };
  heading: number;
  wrecked: boolean;
  kind: VehicleKind;
  damage(amount: number): void;
  /** Nudge, for a punch. */
  shove(x: number, z: number): void;
}

/** The vehicle OBB the physics uses: 4.4 long, 2.0 wide, and about 1.5 tall. */
const HALF_LEN = 2.2;
const HALF_WID = 1.0;
const CAR_TOP = 1.5;
/** A pedestrian is a vertical cylinder about this wide. */
const PED_RADIUS = 0.35;

/**
 * The direction the crosshair points.
 *
 * Straight down the camera's forward axis, because the crosshair is drawn at
 * the centre of the frame -- so what the player sees under it is exactly what
 * this hits, whatever the field of view is doing during an aim transition.
 */
export function aimRay(camera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
  return camera.getWorldDirection(out).normalize();
}

/**
 * Distance along `dir` at which the ray enters a pedestrian's capsule, or null.
 *
 * Solved in the horizontal plane against a circle and then checked for height,
 * which is a cylinder rather than a true capsule. The difference is the rounded
 * cap at the head, and a bullet that clips the top of someone's skull instead
 * of missing by two centimetres is not a distinction worth the arithmetic.
 */
export function rayHitPed(
  from: THREE.Vector3, dir: THREE.Vector3, target: PedTarget,
): number | null {
  if (target.height <= 0) return null;
  const ox = from.x - target.x, oz = from.z - target.z;
  const a = dir.x * dir.x + dir.z * dir.z;
  if (a < 1e-6) return null;
  const b = 2 * (ox * dir.x + oz * dir.z);
  const c = ox * ox + oz * oz - PED_RADIUS * PED_RADIUS;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t <= 0) return null;
  const y = from.y + dir.y * t;
  if (y < target.y || y > target.y + target.height) return null;
  return t;
}

/** Distance at which the ray enters a car's oriented box, or null. */
export function rayHitVehicle(
  from: THREE.Vector3, dir: THREE.Vector3, v: CombatVehicle,
): number | null {
  // Into the car's own frame, where the box is axis-aligned.
  const fx = Math.sin(v.heading), fz = Math.cos(v.heading);
  const dx = from.x - v.pos.x, dz = from.z - v.pos.z;
  const ox = dx * fz - dz * fx;
  const oz = dx * fx + dz * fz;
  const rx = dir.x * fz - dir.z * fx;
  const rz = dir.x * fx + dir.z * fz;
  return slab(
    [ox, from.y, oz], [rx, dir.y, rz],
    [-HALF_WID, 0, -HALF_LEN], [HALF_WID, CAR_TOP, HALF_LEN],
  );
}

/**
 * Distance at which the ray meets a building, and the face it met, or null.
 *
 * The colliders have no height -- they are footprints -- so they are treated as
 * walls from the ground to `WALL_TOP`. Downtown towers are far taller than
 * that; a bullet fired at a fortieth floor from street level travels past the
 * range limit long before it gets there.
 */
const WALL_TOP = 40;

export function rayHitWorld(
  from: THREE.Vector3, dir: THREE.Vector3,
  boxes: readonly { minX: number; minZ: number; maxX: number; maxZ: number }[],
  maxDist: number, normalOut: THREE.Vector3,
): number | null {
  let best: number | null = null;
  for (const b of boxes) {
    const t = slab(
      [from.x, from.y, from.z], [dir.x, dir.y, dir.z],
      [b.minX, 0, b.minZ], [b.maxX, WALL_TOP, b.maxZ],
    );
    if (t === null || t <= 0 || t >= maxDist || (best !== null && t >= best)) continue;
    best = t;
    faceNormal(from, dir, t, b, normalOut);
  }
  // The ground, if the shot is angled down and nothing solid came first.
  if (dir.y < -1e-4) {
    const t = -from.y / dir.y;
    if (t > 0 && t < maxDist && (best === null || t < best)) {
      best = t;
      normalOut.set(0, 1, 0);
    }
  }
  return best;
}

/** Slab test against an axis-aligned box; returns the near hit distance. */
function slab(
  o: [number, number, number], d: [number, number, number],
  lo: [number, number, number], hi: [number, number, number],
): number | null {
  let near = -Infinity, far = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null;
      continue;
    }
    const inv = 1 / d[i];
    let t0 = (lo[i] - o[i]) * inv;
    let t1 = (hi[i] - o[i]) * inv;
    if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
    near = Math.max(near, t0);
    far = Math.min(far, t1);
    if (near > far) return null;
  }
  return far < 0 ? null : Math.max(near, 0);
}

/** Which wall of `b` the hit point sits on, for laying the decal flat. */
function faceNormal(
  from: THREE.Vector3, dir: THREE.Vector3, t: number,
  b: { minX: number; minZ: number; maxX: number; maxZ: number },
  out: THREE.Vector3,
): void {
  const x = from.x + dir.x * t;
  const z = from.z + dir.z * t;
  const dxMin = Math.abs(x - b.minX), dxMax = Math.abs(x - b.maxX);
  const dzMin = Math.abs(z - b.minZ), dzMax = Math.abs(z - b.maxZ);
  const m = Math.min(dxMin, dxMax, dzMin, dzMax);
  if (m === dxMin) out.set(-1, 0, 0);
  else if (m === dxMax) out.set(1, 0, 0);
  else if (m === dzMin) out.set(0, 0, -1);
  else out.set(0, 0, 1);
}
