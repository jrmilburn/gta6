// On-foot player controller (plan section 5): a capsule that walks/runs/jumps,
// collides with world colliders and vehicle circles by push-out, takes damage
// from moving vehicles, and satisfies CameraSubject so the chase camera's rig
// can drive an on-foot mode too.
//
// Movement is acceleration-based (feel pass 1.3): input is smoothed into
// continuous axes, the velocity chases a target rather than being assigned, and
// the facing turns at a capped rate. Nothing here writes a mesh -- renderSync()
// does that once per rendered frame from the interpolated state.
import type { Scene } from 'three';
import type { AABB, EventName, Renderable, System, Vec2 } from '../types';
import { CFG } from '../config';
import { SpatialHash } from '../core/spatial';
import { InputSmoother, shortestAngle, smoothDamp, smoothDampAngle } from '../core/smooth';
import { PlayerMesh, type PlayerVisual } from './playerMesh';
import { Legs } from './playerJump';
import type { CameraSubject } from '../camera/cameras';

const RADIUS = 0.4;
const QUERY_RADIUS = 12;
/** Player-vs-vehicle push/hit radius: player capsule radius + roughly a car's half-width. */
const HIT_RADIUS = 1.7;
const HIT_SPEED_MIN = 1.5;
const HIT_COOLDOWN = 1;

const F = CFG.feel.foot;
const TURN_RATE = (F.turnRateDeg * Math.PI) / 180;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
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
  /** Walkable surface height at a point (kerbs, boardwalk). Flat 0 if absent. */
  groundHeightAt?: (x: number, z: number) => number;
  /** The body to render. Falls back to the procedural humanoid. */
  visual?: PlayerVisual | null;
}

export class Player implements System, Renderable, CameraSubject {
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
  /** 0 while the character is fully solid, 1 while faded out for a car entry (1.4). */
  fade = 0;

  readonly mesh: PlayerVisual;
  readonly legs = new Legs();

  private readonly host: PlayerHost;
  private readonly smooth = new InputSmoother();
  /** World-space ground velocity; the thing acceleration acts on. */
  private velX = 0;
  private velZ = 0;
  private turnVel = [0];
  private camTurnVel = [0];
  private groundVel = [0];
  private groundY = 0;
  private hash = new SpatialHash<AABB>(20);
  private nearby: AABB[] = [];
  private vehicles: readonly VehicleLike[] = [];
  private respawnPoint: Vec2;
  private invulnUntil = 0;
  private groundHeightAt: (x: number, z: number) => number;
  /** Previous physics state, for render interpolation (1.1). */
  private prev = { x: 0, y: 0, z: 0, heading: 0 };

  constructor(host: PlayerHost, opts: PlayerOptions = {}) {
    this.host = host;
    this.pos = { x: opts.pos?.x ?? 0, z: opts.pos?.z ?? 0 };
    this.respawnPoint = { ...this.pos };
    this.groundHeightAt = opts.groundHeightAt ?? (() => 0);
    this.groundY = this.groundHeightAt(this.pos.x, this.pos.z);
    this.y = this.groundY;
    this.mesh = opts.visual ?? new PlayerMesh();
    host.scene.add(this.mesh.group);
    if (opts.colliders) this.setColliders(opts.colliders);
    this.snapshot();
    this.writeMesh(this.pos.x, this.y, this.pos.z, this.heading);
  }

  setColliders(colliders: readonly AABB[]): void {
    this.hash = new SpatialHash<AABB>(20);
    for (const c of colliders) this.hash.insertAABB(c, c);
  }

  setGroundSampler(fn: (x: number, z: number) => number): void {
    this.groundHeightAt = fn;
    this.groundY = fn(this.pos.x, this.pos.z);
  }

  /** Vehicles to push out of and take damage from. Reassignable (phase 4 can point it at a shared list). */
  setVehicles(vehicles: readonly VehicleLike[]): void { this.vehicles = vehicles; }

  setRespawnPoint(p: Vec2): void { this.respawnPoint = { ...p }; }

  grantInvuln(seconds: number): void {
    this.invulnUntil = Math.max(this.invulnUntil, this.host.time + seconds);
  }

  get onGround(): boolean { return this.legs.grounded; }

  update(dt: number): void {
    if (!this.onFoot) return;
    this.snapshot();

    this.applyMovement(dt);
    this.legs.step(dt, this.host.input.justPressed('handbrake'));
    this.resolveWorldCollisions();
    this.resolveVehicleCollisions();
    this.checkVehicleHits();
    this.settleGround(dt);

    this.speed = Math.hypot(this.velX, this.velZ);
    this.speedFrac = CFG.player.runSpeed > 0 ? clamp(this.speed / CFG.player.runSpeed, 0, 1) : 0;
  }

  /** Record the state the next render frame interpolates *from*. */
  private snapshot(): void {
    this.prev.x = this.pos.x;
    this.prev.y = this.y;
    this.prev.z = this.pos.z;
    this.prev.heading = this.heading;
  }

  private applyMovement(dt: number): void {
    const input = this.host.input;
    const rawX = (input.isDown('right') ? 1 : 0) - (input.isDown('left') ? 1 : 0);
    const rawZ = (input.isDown('forward') ? 1 : 0) - (input.isDown('back') ? 1 : 0);
    // Smoothed axes (1.2): a tap ramps in over `attack`, a release falls over
    // `release`, so nothing in the chain below ever sees a step function.
    const ix = this.smooth.moveX.step(rawX, dt);
    const iz = this.smooth.moveZ.step(rawZ, dt);
    const len = Math.hypot(ix, iz);
    const mag = Math.min(1, len);

    let targetX = 0, targetZ = 0;
    if (len > 0.001) {
      const nx = ix / len, nz = iz / len;
      // Camera-relative: transform the input by the lagged camera-follow heading
      // (not the character's own facing) so "forward" always means "away from
      // the camera" (plan section 5).
      const basis = this.velocityHeading;
      const fx = Math.sin(basis), fz = Math.cos(basis);
      // Screen-right is cross(cameraForward, worldUp) = (-Fz, Fx).
      const rx = -Math.cos(basis), rz = Math.sin(basis);
      const dirX = fx * nz + rx * nx;
      const dirZ = fz * nz + rz * nx;
      const dirLen = Math.hypot(dirX, dirZ) || 1;
      const want = (input.isDown('sprint') ? CFG.player.runSpeed : CFG.player.walkSpeed) * mag;
      targetX = (dirX / dirLen) * want;
      targetZ = (dirZ / dirLen) * want;
    }

    // Acceleration, not assignment: ~0.25 s to full speed, ~0.2 s to a stop.
    const moving = targetX !== 0 || targetZ !== 0;
    const rate = this.legs.grounded ? (moving ? F.accel : F.decel) : F.airAccel;
    const k = Math.min(1, rate * dt);
    this.velX += (targetX - this.velX) * k;
    this.velZ += (targetZ - this.velZ) * k;

    this.pos.x += this.velX * dt;
    this.pos.z += this.velZ * dt;

    this.turnToward(dt, targetZ !== 0 || targetX !== 0 ? Math.max(0, iz) : 0);
  }

  /**
   * Face the direction of travel at a capped rate rather than snapping to it.
   * Below `facingMinSpeed` the last facing is held, so releasing the stick does
   * not spin the character on the spot as the residual velocity decays.
   */
  private turnToward(dt: number, forwardInput: number): void {
    const speed = Math.hypot(this.velX, this.velZ);
    if (speed > F.facingMinSpeed) {
      const want = Math.atan2(this.velX, this.velZ);
      this.heading = smoothDampAngle(this.heading, want, this.turnVel, F.turnSmooth, dt, TURN_RATE);
    }
    // The camera yaw is the basis the movement above was derived from, so
    // letting it chase the resulting heading is a feedback loop: holding A would
    // swing the camera left, which swings "left" further left, and the character
    // circles instead of strafing. Only the forward component of the input is
    // allowed to steer the camera.
    if (forwardInput > 0.01) {
      const target = this.velocityHeading + shortestAngle(this.velocityHeading, this.heading) * forwardInput;
      this.velocityHeading = smoothDampAngle(
        this.velocityHeading, target, this.camTurnVel, F.cameraTurnSmooth, dt, TURN_RATE,
      );
    }
  }

  /**
   * Blend the feet onto whatever surface they are over. Stepping from road to
   * sidewalk is a 0.15 m jump in ground height; snapping it makes the camera
   * hiccup every kerb, so it is smoothed over `stepUpTime` (1.3).
   */
  private settleGround(dt: number): void {
    const want = this.groundHeightAt(this.pos.x, this.pos.z);
    if (this.legs.grounded) {
      this.groundY = smoothDamp(this.groundY, want, this.groundVel, F.stepUpTime, dt);
    } else {
      // Mid-air: land on whatever is under the feet now, no blending.
      this.groundY = want;
      this.groundVel[0] = 0;
    }
    this.y = this.groundY + this.legs.height;
  }

  private resolveWorldCollisions(): void {
    this.nearby = this.hash.query(this.pos, QUERY_RADIUS, this.nearby);
    for (const box of this.nearby) {
      const hit = circleVsAabb(this.pos.x, this.pos.z, RADIUS, box);
      if (!hit) continue;
      this.pos.x += hit.nx * hit.depth;
      this.pos.z += hit.nz * hit.depth;
      // Kill the velocity component going into the wall so the character slides
      // along it instead of buzzing against it.
      const vn = this.velX * hit.nx + this.velZ * hit.nz;
      if (vn < 0) { this.velX -= vn * hit.nx; this.velZ -= vn * hit.nz; }
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
    this.velX = 0; this.velZ = 0;
    this.turnVel[0] = 0; this.camTurnVel[0] = 0; this.groundVel[0] = 0;
    this.smooth.moveX.reset(); this.smooth.moveZ.reset();
    this.legs.reset();
    this.groundY = this.groundHeightAt(this.pos.x, this.pos.z);
    this.y = this.groundY;
    this.health = CFG.player.health;
    this.heading = 0;
    this.velocityHeading = 0;
    this.speed = 0;
    this.onFoot = true;
    this.invulnUntil = this.host.time + 1;
    this.snapshot();
    this.writeMesh(this.pos.x, this.y, this.pos.z, this.heading);
  }

  /** Teleport without clearing health or the respawn point (stepping out of a car). */
  placeAt(x: number, z: number, heading: number): void {
    this.pos.x = x; this.pos.z = z;
    this.velX = 0; this.velZ = 0;
    this.turnVel[0] = 0; this.camTurnVel[0] = 0; this.groundVel[0] = 0;
    this.smooth.moveX.reset(); this.smooth.moveZ.reset();
    this.legs.reset();
    this.heading = heading;
    this.velocityHeading = heading;
    this.speed = 0;
    this.groundY = this.groundHeightAt(x, z);
    this.y = this.groundY;
    this.snapshot();
    this.writeMesh(x, this.y, z, heading);
  }

  renderSync(alpha: number, dt: number): void {
    this.mesh.group.visible = this.onFoot && this.fade < 0.99;
    if (!this.onFoot) return;
    const x = this.prev.x + (this.pos.x - this.prev.x) * alpha;
    const y = this.prev.y + (this.y - this.prev.y) * alpha;
    const z = this.prev.z + (this.pos.z - this.prev.z) * alpha;
    const h = this.prev.heading + shortestAngle(this.prev.heading, this.heading) * alpha;
    this.mesh.update({
      dt,
      time: this.host.time,
      speed: this.speed,
      walkSpeed: CFG.player.walkSpeed,
      runSpeed: CFG.player.runSpeed,
      turnRate: this.turnVel[0],
      grounded: this.legs.grounded,
      crouch: this.legs.crouch,
      airborne: this.legs.airborne,
      opacity: 1 - this.fade,
    });
    this.writeMesh(x, y, z, h);
  }

  private writeMesh(x: number, y: number, z: number, heading: number): void {
    this.mesh.group.position.set(x, y, z);
    this.mesh.group.rotation.y = heading;
  }
}
