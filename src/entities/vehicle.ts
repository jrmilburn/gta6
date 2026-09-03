// Arcade vehicle model (plan section 4). No physics engine: a scalar forward
// speed plus a lateral slip vector, integrated at the fixed 60 Hz step.
import * as THREE from 'three';
import type { AABB, EventName, Renderable, System, Vec2, VehicleKind, VehicleState } from '../types';
import { CFG } from '../config';
import { SpatialHash } from '../core/spatial';
import { InputSmoother, shortestAngle } from '../core/smooth';
import { obbVsAabb } from './collision';
import { VehicleMesh, pickBodyColor } from './vehicleMesh';
import { VehicleSmoke } from './vehicleSmoke';

const WHEELBASE = 2.8;
const HALF_LEN = 2.2;   // OBB length 4.4
const HALF_WID = 1.0;   // OBB width 2.0
const CAR_RADIUS = 2.2; // vehicle-vs-vehicle circle
const RESTITUTION = 0.3;
const QUERY_RADIUS = 30;
const DAMAGE_PER_IMPACT = 2;
const IMPACT_FLOOR = 2.5; // below this a scrape is free
const SMOKE_HEALTH = 40;
/** Beyond this a vehicle renders as a bare body; 8 m of hysteresis on the way back. */
const DETAIL_DIST = 70;

export interface VehicleControls {
  /** -1 (brake/reverse) .. 1 (throttle). */
  throttle: number;
  /**
   * -1 (full left) .. 1 (full right), from the driver's seat.
   *
   * Worth stating, because the heading runs the other way: forward is
   * (sin h, cos h), so a rising heading swings the nose toward +X, and +X is
   * screen-LEFT with the chase camera sitting behind the car. `integrate`
   * negates once on the way in so that everything above this line -- the player,
   * the traffic AI, the wheels -- can use the obvious sense.
   */
  steer: number;
  handbrake: boolean;
}

/** Everything Vehicle needs from Game. `Game` satisfies this structurally. */
export interface VehicleHost {
  scene: THREE.Scene;
  /** Optional: enables the distance-based detail drop in renderSync. */
  camera?: { position: THREE.Vector3 };
  events: { emit(evt: EventName, payload?: unknown): void };
  audio: { thud(impact: number): void };
  time: number;
}

export interface VehicleHitPayload {
  vehicle: Vehicle;
  other: Vehicle | null;
  impact: number;
  x: number;
  z: number;
}

export interface VehicleOptions {
  kind?: VehicleKind;
  pos?: Vec2;
  heading?: number;
  colorIdx?: number;
  colliders?: AABB[];
}

let nextId = 1;

export class Vehicle implements VehicleState, System, Renderable {
  readonly id = nextId++;
  readonly kind: VehicleKind;
  readonly pos: Vec2;
  y = 0;
  heading: number;
  speed = 0;
  steer = 0;
  health = 100;
  occupied = false;
  wrecked = false;

  /** Lateral momentum the tyres have not yet scrubbed off. */
  readonly slipVel: Vec2 = { x: 0, z: 0 };
  readonly controls: VehicleControls = { throttle: 0, steer: 0, handbrake: false };
  /** Police light bar / siren state; read by the mesh. */
  sirenOn = false;
  /** Other vehicles to collide against. Phase 4 points this at the shared list. */
  peers: readonly Vehicle[] = [];

  readonly mesh: VehicleMesh;
  readonly group: THREE.Group;

  private readonly host: VehicleHost;
  private readonly smoke: VehicleSmoke;
  private hash = new SpatialHash<AABB>(20);
  private nearby: AABB[] = [];
  private lateralAccel = 0;
  private longAccel = 0;
  /** Previous physics state, for render interpolation (1.1). */
  private prev = { x: 0, y: 0, z: 0, heading: 0 };
  private detailed = true;

  constructor(host: VehicleHost, opts: VehicleOptions = {}) {
    this.host = host;
    this.kind = opts.kind ?? 'sedan';
    this.pos = { x: opts.pos?.x ?? 0, z: opts.pos?.z ?? 0 };
    this.heading = opts.heading ?? 0;
    this.sirenOn = this.kind === 'police';

    this.mesh = new VehicleMesh(this.kind, pickBodyColor(this.kind, opts.colorIdx ?? this.id * 5));
    this.group = this.mesh.group;
    this.group.position.set(this.pos.x, 0, this.pos.z);
    this.group.rotation.y = this.heading;
    this.snapshot();
    host.scene.add(this.group);
    this.smoke = new VehicleSmoke(host.scene);
    if (opts.colliders) this.setColliders(opts.colliders);
  }

  get tuning() { return CFG.vehicle[this.kind]; }
  get mass(): number { return this.tuning.mass; }
  get forwardX(): number { return Math.sin(this.heading); }
  get forwardZ(): number { return Math.cos(this.heading); }
  get speedFrac(): number { return Math.min(1, Math.abs(this.speed) / this.tuning.maxSpeed); }
  /** World velocity including slip. */
  get velocity(): Vec2 {
    return { x: this.forwardX * this.speed + this.slipVel.x, z: this.forwardZ * this.speed + this.slipVel.z };
  }
  /** Direction the car is actually travelling; the chase camera follows this. */
  get velocityHeading(): number {
    const v = this.velocity;
    return Math.atan2(v.x, v.z);
  }
  get braking(): boolean {
    return this.controls.handbrake || (this.controls.throttle < 0 && this.speed > 0.5);
  }

  /** World colliders, injectable so Phase 1's city can be plugged in later. */
  setColliders(colliders: readonly AABB[]): void {
    this.hash = new SpatialHash<AABB>(20);
    for (const c of colliders) this.hash.insertAABB(c, c);
  }

  setPeers(peers: readonly Vehicle[]): void { this.peers = peers; }

  /** Teleport and zero all momentum (respawn, tests, mission setup). */
  reset(x: number, z: number, heading = 0, health = 100): void {
    this.pos.x = x; this.pos.z = z;
    this.heading = heading;
    this.speed = 0; this.steer = 0;
    this.slipVel.x = 0; this.slipVel.z = 0;
    this.health = health;
    this.wrecked = health <= 0;
    this.snapshot();
    this.writeMesh(this.pos.x, this.y, this.pos.z, this.heading);
  }

  /** Record the state the next render frame interpolates *from*. */
  private snapshot(): void {
    this.prev.x = this.pos.x;
    this.prev.y = this.y;
    this.prev.z = this.pos.z;
    this.prev.heading = this.heading;
  }

  /**
   * Walkable-surface height, shared by every vehicle: the boardwalk and the
   * pier are decks 0.32 m up, and a car on them used to sit axle-deep in the
   * planks. Set once from the session; the flat world is the default.
   */
  static groundAt: (x: number, z: number) => number = () => 0;

  update(dt: number): void {
    const prevSpeed = this.speed;
    this.snapshot();
    this.integrate(dt);
    // Onto the deck and off it again: a kerb-height step, blended.
    const groundY = Vehicle.groundAt(this.pos.x, this.pos.z);
    this.y += (groundY - this.y) * Math.min(1, dt * 10);
    this.resolveWorld();
    this.resolvePeers();
    this.longAccel = (this.speed - prevSpeed) / dt;

    const rate = this.wrecked ? 14 : this.health < SMOKE_HEALTH ? 4 + (SMOKE_HEALTH - this.health) * 0.2 : 0;
    this.smoke.update(dt, rate, this.pos.x + this.forwardX * 1.5, 0.95, this.pos.z + this.forwardZ * 1.5, this.wrecked);
  }

  /**
   * Mesh transform once per rendered frame, interpolated between the last two
   * physics states. The cosmetic body motion runs on wall time so the suspension
   * settles smoothly however many physics steps the frame happened to contain.
   */
  renderSync(alpha: number, dt: number): void {
    const cam = this.host.camera;
    if (cam) {
      const dx = cam.position.x - this.pos.x, dz = cam.position.z - this.pos.z;
      const d2 = dx * dx + dz * dz;
      const edge = this.detailed ? DETAIL_DIST + 8 : DETAIL_DIST;
      this.detailed = d2 < edge * edge;
      this.mesh.setDetail(this.detailed);
    }
    this.writeMesh(
      this.prev.x + (this.pos.x - this.prev.x) * alpha,
      this.prev.y + (this.y - this.prev.y) * alpha,
      this.prev.z + (this.pos.z - this.prev.z) * alpha,
      this.prev.heading + shortestAngle(this.prev.heading, this.heading) * alpha,
    );
    this.mesh.update({
      dt, time: this.host.time, speed: this.speed, steer: this.steer,
      lateralAccel: this.lateralAccel, longAccel: this.longAccel,
      braking: this.braking, sirenActive: this.sirenOn && !this.wrecked,
    });
  }

  // --- physics -------------------------------------------------------------

  private integrate(dt: number): void {
    const t = this.tuning;
    const wreckedNow = this.wrecked;
    const throttle = wreckedNow ? 0 : THREE.MathUtils.clamp(this.controls.throttle, -1, 1);
    const steerIn = wreckedNow ? 0 : THREE.MathUtils.clamp(this.controls.steer, -1, 1);
    const handbrake = wreckedNow ? true : this.controls.handbrake;

    // Steering: authority falls from 1 at rest to 0.35 at top speed. This lerp
    // is the steering rack, not input shaping -- it applies to AI cars too. The
    // player's *input* is shaped upstream in PlayerDriver (1.2 / 1.4); doing it
    // here would put the same lag on the traffic AI's already-continuous
    // steering output and drive it into the parked cars.
    const falloff = 1 - 0.65 * Math.min(1, Math.abs(this.speed) / t.maxSpeed);
    // Negated, because `controls.steer` is positive to the DRIVER'S RIGHT while
    // the heading runs the other way: forward is (sin h, cos h), so a rising
    // heading swings the nose from +Z toward +X -- and +X is screen-left, since
    // the chase camera sits behind the car and its right is -X. Without this,
    // holding D turned the car the other way.
    const targetSteer = -steerIn * t.steerMax * falloff;
    this.steer += (targetSteer - this.steer) * Math.min(1, dt * 10);

    if (throttle > 0) {
      this.speed = Math.min(t.maxSpeed, this.speed + t.accel * throttle * dt);
    } else if (throttle < 0) {
      if (this.speed > 0.5) this.speed -= t.brake * dt;
      else this.speed = Math.max(-t.reverseMax, this.speed + t.accel * throttle * dt);
    } else {
      this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), 4 * dt); // rolling drag
    }
    // DECISION: the plan only ties the handbrake to grip, but a handbrake turn
    // needs the car to shed some speed or it just understeers away. Light brake.
    if (handbrake && Math.abs(this.speed) > 0.5) this.speed -= Math.sign(this.speed) * t.brake * 0.45 * dt;
    this.speed -= this.speed * 0.02 * Math.abs(this.speed) * dt; // aero drag

    // Carry the pre-rotation world velocity so momentum survives the yaw.
    const vx = this.forwardX * this.speed + this.slipVel.x;
    const vz = this.forwardZ * this.speed + this.slipVel.z;

    // While sliding the front tyres bite less, so the yaw builds more slowly:
    // a handbrake turn at 25 m/s lands near 90 degrees in ~0.8 s of input.
    const sliding = this.controlsSliding(handbrake);
    const turnRate = (this.speed / WHEELBASE) * Math.tan(this.steer) * (sliding ? 0.72 : 1);
    this.heading += turnRate * dt;
    // Outward force felt by the body; drives the cosmetic roll.
    this.lateralAccel = -turnRate * this.speed;

    // Re-project the old momentum into the new body frame: the forward part is
    // owned by the engine model, the lateral part becomes slip.
    const rx = this.forwardZ, rz = -this.forwardX;
    let lateral = vx * rx + vz * rz;
    const grip = t.grip * (sliding ? 0.25 : 1);
    lateral *= Math.exp(-grip * dt);
    this.slipVel.x = rx * lateral;
    this.slipVel.z = rz * lateral;

    // Scrubbing sideways costs a little forward speed.
    this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), Math.abs(lateral) * 0.35 * dt);

    this.pos.x += (this.forwardX * this.speed + this.slipVel.x) * dt;
    this.pos.z += (this.forwardZ * this.speed + this.slipVel.z) * dt;
  }

  /** True when the tyres have broken traction: handbrake, or a hard fast turn. */
  private controlsSliding(handbrake: boolean): boolean {
    const raw = (this.speed / WHEELBASE) * Math.tan(this.steer);
    return handbrake || Math.abs(raw * this.speed) > 18;
  }

  private setWorldVel(x: number, z: number): void {
    this.speed = x * this.forwardX + z * this.forwardZ;
    this.slipVel.x = x - this.forwardX * this.speed;
    this.slipVel.z = z - this.forwardZ * this.speed;
  }

  // --- collisions ----------------------------------------------------------

  private resolveWorld(): void {
    this.nearby = this.hash.query(this.pos, QUERY_RADIUS, this.nearby);
    if (this.nearby.length === 0) return;
    for (const box of this.nearby) {
      const hit = obbVsAabb(this.pos.x, this.pos.z, HALF_LEN, HALF_WID, this.forwardX, this.forwardZ, box);
      if (!hit) continue;
      this.pos.x += hit.nx * hit.depth;
      this.pos.z += hit.nz * hit.depth;
      const v = this.velocity;
      const vn = v.x * hit.nx + v.z * hit.nz;
      if (vn < 0) {
        this.setWorldVel(v.x - (1 + RESTITUTION) * vn * hit.nx, v.z - (1 + RESTITUTION) * vn * hit.nz);
        this.onImpact(-vn, null);
      }
    }
  }

  private resolvePeers(): void {
    for (const other of this.peers) {
      if (other === this || other.id < this.id) continue; // each pair once
      const dx = other.pos.x - this.pos.x;
      const dz = other.pos.z - this.pos.z;
      const d2 = dx * dx + dz * dz;
      const min = CAR_RADIUS * 2;
      if (d2 >= min * min || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d, nz = dz / d;
      const overlap = min - d;
      const m1 = this.mass, m2 = other.mass, tot = m1 + m2;
      this.pos.x -= nx * overlap * (m2 / tot);
      this.pos.z -= nz * overlap * (m2 / tot);
      other.pos.x += nx * overlap * (m1 / tot);
      other.pos.z += nz * overlap * (m1 / tot);

      const a = this.velocity, b = other.velocity;
      const vn = (b.x - a.x) * nx + (b.z - a.z) * nz;
      if (vn >= 0) continue;
      const j = (-(1 + RESTITUTION) * vn) / (1 / m1 + 1 / m2);
      this.setWorldVel(a.x - (nx * j) / m1, a.z - (nz * j) / m1);
      other.setWorldVel(b.x + (nx * j) / m2, b.z + (nz * j) / m2);
      const impact = -vn;
      this.onImpact(impact, other);
      other.onImpact(impact, this);
    }
  }

  private onImpact(impact: number, other: Vehicle | null): void {
    if (impact < IMPACT_FLOOR) return;
    this.host.audio.thud(impact);
    const payload: VehicleHitPayload = { vehicle: this, other, impact, x: this.pos.x, z: this.pos.z };
    this.host.events.emit('vehicleHit', payload);
    this.damage(impact * DAMAGE_PER_IMPACT);
  }

  /**
   * A shove from outside the physics -- a punch (section 6). Added to the slip
   * velocity rather than the forward speed, so a car parked across the street
   * rocks sideways instead of setting off down the road.
   */
  shove(x: number, z: number): void {
    if (this.wrecked) return;
    this.slipVel.x += x;
    this.slipVel.z += z;
  }

  damage(amount: number): void {
    if (this.wrecked) return;
    this.health = Math.max(0, this.health - amount);
    if (this.health > 0) return;
    this.wrecked = true;
    this.controls.throttle = 0;
    this.controls.steer = 0;
    this.host.events.emit('wrecked', { vehicle: this });
  }

  private writeMesh(x: number, y: number, z: number, heading: number): void {
    this.group.position.set(x, y, z);
    this.group.rotation.y = heading;
  }

  dispose(): void {
    this.mesh.dispose();
    this.smoke.dispose();
  }
}

/**
 * Routes keyboard input into one vehicle and drives the engine audio.
 *
 * This is where raw key state becomes a continuous control signal (1.2 / 1.4):
 * the throttle ramps in over 0.3 s so pulling away is a squeeze rather than a
 * switch, and the wheel returns to centre (0.06 s) faster than it turns in
 * (0.12 s), which is what makes a correction feel crisp and a turn feel weighted.
 */
export class PlayerDriver implements System {
  private readonly smooth = new InputSmoother();

  constructor(
    private readonly game: {
      input: { steerAxis: number; throttleAxis: number; isDown(a: 'handbrake'): boolean };
      audio: { engine(speedFrac: number, throttle: number, active: boolean): void };
    },
    public vehicle: Vehicle,
  ) {}

  update(dt: number): void {
    const v = this.vehicle;
    const c = v.controls;
    const throttle = this.smooth.throttle.step(v.wrecked ? 0 : this.game.input.throttleAxis, dt);
    const steer = this.smooth.steer.step(v.wrecked ? 0 : this.game.input.steerAxis, dt);
    c.throttle = throttle;
    c.steer = steer;
    c.handbrake = !v.wrecked && this.game.input.isDown('handbrake');
    this.game.audio.engine(v.speedFrac, Math.max(0, throttle), !v.wrecked);
  }

  /** Drop the ramp state so stepping into a new car does not inherit the old one. */
  reset(): void {
    this.smooth.throttle.reset();
    this.smooth.steer.reset();
  }
}
