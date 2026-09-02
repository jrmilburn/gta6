// On-foot player controller (plan section 5): a capsule that walks/runs/jumps,
// collides with world colliders and vehicle circles by push-out, takes damage
// from moving vehicles, and satisfies CameraSubject so the chase camera's rig
// can drive an on-foot mode too.
import type { Scene } from 'three';
import type { AABB, EventName, System, Vec2 } from '../types';
import { CFG } from '../config';
import { SpatialHash } from '../core/spatial';
import { PlayerMesh } from './playerMesh';
import { registerCameraMode, type CameraFrame, type CameraModeName, type CameraSubject } from '../camera/cameras';

const RADIUS = 0.4;
const JUMP_HEIGHT = 1.2;
const GRAVITY = 22;
const JUMP_SPEED = Math.sqrt(2 * GRAVITY * JUMP_HEIGHT);
/** How fast the camera-follow heading catches up to the character's facing. */
const TURN_LAG = 6;
const QUERY_RADIUS = 12;
/** Player-vs-vehicle push/hit radius: player capsule radius + roughly a car's half-width. */
const HIT_RADIUS = 1.7;
const HIT_SPEED_MIN = 1.5;
const HIT_COOLDOWN = 1;

// DECISION: cityGen's colliders are flat 2D AABBs with no per-point ground
// height (plan section 1.3's AABB carries no height field), so there is no
// vertical data to "step up" over — the sidewalk kerb the plan describes has
// nothing to collide with vertically in this data model. Ground height is
// treated as a flat 0 everywhere; only XZ push-out collision applies.

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function shortestAngleDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

interface CircleHit { nx: number; nz: number; depth: number }

/** Closest-point circle-vs-AABB push-out, with a fallback for a centre already inside the box. */
function circleVsAabb(px: number, pz: number, r: number, b: AABB): CircleHit | null {
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

export interface PlayerHost {
  scene: Scene;
  input: {
    isDown(a: 'forward' | 'back' | 'left' | 'right' | 'sprint' | 'handbrake'): boolean;
    justPressed(a: 'handbrake'): boolean;
  };
  events: { emit(evt: EventName, payload?: unknown): void };
  time: number;
}

export interface PlayerOptions {
  pos?: Vec2;
  colliders?: readonly AABB[];
}

export class Player implements System, CameraSubject {
  readonly pos: Vec2;
  y = 0;
  heading = 0;
  /** Lagged camera-follow heading; also the basis for camera-relative movement. */
  velocityHeading = 0;
  speed = 0;
  speedFrac = 0;
  health = CFG.player.health;
  /** False while driving; toggled by whoever wires up enter/exit (session.ts / dev scene). */
  onFoot = true;
  onGround = true;

  readonly mesh = new PlayerMesh();

  private readonly host: PlayerHost;
  private yVel = 0;
  private hash = new SpatialHash<AABB>(20);
  private nearby: AABB[] = [];
  private vehicles: readonly VehicleLike[] = [];
  private respawnPoint: Vec2;
  private invulnUntil = 0;

  constructor(host: PlayerHost, opts: PlayerOptions = {}) {
    this.host = host;
    this.pos = { x: opts.pos?.x ?? 0, z: opts.pos?.z ?? 0 };
    this.respawnPoint = { ...this.pos };
    host.scene.add(this.mesh.group);
    if (opts.colliders) this.setColliders(opts.colliders);
    this.syncMesh();
  }

  setColliders(colliders: readonly AABB[]): void {
    this.hash = new SpatialHash<AABB>(20);
    for (const c of colliders) this.hash.insertAABB(c, c);
  }

  /** Vehicles to push out of and take damage from. Reassignable (phase 4 can point it at a shared list). */
  setVehicles(vehicles: readonly VehicleLike[]): void { this.vehicles = vehicles; }

  setRespawnPoint(p: Vec2): void { this.respawnPoint = { ...p }; }

  grantInvuln(seconds: number): void {
    this.invulnUntil = Math.max(this.invulnUntil, this.host.time + seconds);
  }

  update(dt: number): void {
    this.mesh.group.visible = this.onFoot;
    if (!this.onFoot) return;

    this.applyMovement(dt);
    this.applyVertical(dt);
    this.resolveWorldCollisions();
    this.resolveVehicleCollisions();
    this.checkVehicleHits();

    this.speedFrac = CFG.player.runSpeed > 0 ? clamp(this.speed / CFG.player.runSpeed, 0, 1) : 0;
    this.mesh.update({ dt, time: this.host.time, speed: this.speed, runSpeed: CFG.player.runSpeed });
    this.syncMesh();
  }

  private applyMovement(dt: number): void {
    const input = this.host.input;
    const ix = (input.isDown('right') ? 1 : 0) - (input.isDown('left') ? 1 : 0);
    const iz = (input.isDown('forward') ? 1 : 0) - (input.isDown('back') ? 1 : 0);
    const mag = Math.hypot(ix, iz);

    if (mag > 0.001) {
      const nx = ix / mag, nz = iz / mag;
      // Camera-relative: transform the input by the lagged camera-follow
      // heading (not the character's own, instantly-snapped facing) so
      // "forward" always means "away from the camera" (plan section 5).
      const basis = this.velocityHeading;
      const fx = Math.sin(basis), fz = Math.cos(basis);
      // Screen-right is cross(cameraForward, worldUp) = (-Fz, Fx). The previous
      // (cos, -sin) was this negated, which swapped A and D on screen.
      const rx = -Math.cos(basis), rz = Math.sin(basis);
      const dirX = fx * nz + rx * nx;
      const dirZ = fz * nz + rz * nx;
      const dirLen = Math.hypot(dirX, dirZ) || 1;
      const ux = dirX / dirLen, uz = dirZ / dirLen;

      this.speed = input.isDown('sprint') ? CFG.player.runSpeed : CFG.player.walkSpeed;
      this.pos.x += ux * this.speed * dt;
      this.pos.z += uz * this.speed * dt;
      this.heading = Math.atan2(ux, uz);

      // The camera yaw is the basis this movement was just derived from, so
      // letting it chase the resulting heading is a feedback loop: holding A
      // would swing the camera left, which swings "left" further left, and the
      // character circles instead of strafing. Only the forward component of
      // the input is allowed to steer the camera. Pure strafe or reverse (nz
      // <= 0) leaves it parked, so A and D read as clean sidesteps.
      const follow = Math.max(0, nz);
      const diff = shortestAngleDiff(this.velocityHeading, this.heading);
      this.velocityHeading += diff * Math.min(1, dt * TURN_LAG * follow);
    } else {
      this.speed = 0;
    }
  }

  private applyVertical(dt: number): void {
    if (this.onGround && this.host.input.justPressed('handbrake')) {
      this.yVel = JUMP_SPEED;
      this.onGround = false;
    }
    if (!this.onGround) {
      this.yVel -= GRAVITY * dt;
      this.y += this.yVel * dt;
      if (this.y <= 0) { this.y = 0; this.yVel = 0; this.onGround = true; }
    }
  }

  private resolveWorldCollisions(): void {
    this.nearby = this.hash.query(this.pos, QUERY_RADIUS, this.nearby);
    for (const box of this.nearby) {
      const hit = circleVsAabb(this.pos.x, this.pos.z, RADIUS, box);
      if (!hit) continue;
      this.pos.x += hit.nx * hit.depth;
      this.pos.z += hit.nz * hit.depth;
    }
  }

  private resolveVehicleCollisions(): void {
    for (const v of this.vehicles) {
      if (v.wrecked) continue;
      const dx = this.pos.x - v.pos.x, dz = this.pos.z - v.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= HIT_RADIUS * HIT_RADIUS || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      this.pos.x += (dx / d) * (HIT_RADIUS - d);
      this.pos.z += (dz / d) * (HIT_RADIUS - d);
    }
  }

  private checkVehicleHits(): void {
    if (this.host.time < this.invulnUntil) return;
    for (const v of this.vehicles) {
      if (v.wrecked) continue;
      const speed = Math.abs(v.speed);
      if (speed < HIT_SPEED_MIN) continue;
      const dx = this.pos.x - v.pos.x, dz = this.pos.z - v.pos.z;
      if (dx * dx + dz * dz > HIT_RADIUS * HIT_RADIUS) continue;
      this.damage(speed * 3);
      this.grantInvuln(HIT_COOLDOWN);
      return;
    }
  }

  /** Being hit by a vehicle at speed s costs s * 3 (plan section 5). */
  damage(amount: number): void {
    if (this.health <= 0) return;
    this.health = Math.max(0, this.health - amount);
    if (this.health > 0) return;
    // console.error would fail the smoke test's zero-console-errors gate.
    console.log('WRECKED');
    this.host.events.emit('wrecked', { player: this });
    this.respawn();
  }

  /** Respawn at the last-set respawn point (spawns.policeStation) with full health. */
  respawn(): void {
    this.pos.x = this.respawnPoint.x;
    this.pos.z = this.respawnPoint.z;
    this.y = 0;
    this.yVel = 0;
    this.onGround = true;
    this.health = CFG.player.health;
    this.heading = 0;
    this.velocityHeading = 0;
    this.onFoot = true;
    this.invulnUntil = this.host.time + 1;
    this.syncMesh();
  }

  private syncMesh(): void {
    this.mesh.group.position.set(this.pos.x, this.y, this.pos.z);
    this.mesh.group.rotation.y = this.heading;
  }
}

// --- on-foot camera mode ---------------------------------------------------
//
// DECISION: CameraModeName is a closed union owned by camera/cameras.ts,
// which is outside this phase's file ownership, so a new mode name can't be
// added to that type. The plan explicitly allows registering an additional
// mode from this file via the existing `registerCameraMode` API; the name is
// cast through the closed union rather than edited into it.
export const FOOT_CAMERA = 'foot' as unknown as CameraModeName;

const FOOT_DIST = 4;
const FOOT_HEIGHT = 2;
const FOOT_LOOK_AHEAD = 1.4;
const FOOT_LAG = 6;

registerCameraMode(FOOT_CAMERA, (s: CameraSubject, f: CameraFrame) => {
  // Third-person over-shoulder: eye trails the lagged camera-follow heading,
  // look-at leads with the character's actual facing (plan section 5).
  const dir = s.velocityHeading;
  const fx = Math.sin(dir), fz = Math.cos(dir);
  f.eye.set(s.pos.x - fx * FOOT_DIST, s.y + FOOT_HEIGHT, s.pos.z - fz * FOOT_DIST);
  const bx = Math.sin(s.heading), bz = Math.cos(s.heading);
  f.look.set(s.pos.x + bx * FOOT_LOOK_AHEAD, s.y + 1.5, s.pos.z + bz * FOOT_LOOK_AHEAD);
  f.fov = CFG.camera.fovBase;
  f.lag = FOOT_LAG;
});
