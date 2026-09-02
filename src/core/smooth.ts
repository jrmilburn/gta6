// Frame-rate independent smoothing primitives shared by input, the vehicle
// suspension and every camera mode (plan "feel" pass, items 1.2 / 1.4 / 1.5).
//
// Everything here is expressed as a *smooth time* -- roughly how long the value
// takes to cover the distance to its target -- rather than a per-frame lerp
// factor, because a lerp factor silently changes meaning when dt changes.
import * as THREE from 'three';
import { CFG } from '../config';

/**
 * Critically damped spring toward `target`, the Game Programming Gems
 * SmoothDamp. `velRef[0]` carries the spring velocity between calls.
 *
 * `smoothTime` is the approximate time to reach the target; 0 snaps.
 */
export function smoothDamp(
  current: number, target: number, velRef: number[], smoothTime: number, dt: number,
  maxSpeed = Infinity,
): number {
  if (smoothTime <= 0) { velRef[0] = 0; return target; }
  const omega = 2 / smoothTime;
  const x = omega * dt;
  // Padé approximation of exp(-x); cheaper and stable for the dt range we see.
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  let change = current - target;
  const maxChange = maxSpeed * smoothTime;
  change = THREE.MathUtils.clamp(change, -maxChange, maxChange);
  const temp = (velRef[0] + omega * change) * dt;
  velRef[0] = (velRef[0] - omega * temp) * exp;
  let out = current - change + (change + temp) * exp;
  // Never overshoot past the target on the way in.
  if (target - current > 0 === out > target) {
    out = target;
    velRef[0] = (out - target) / dt;
  }
  return out;
}

/** Same, on the shortest path around the circle. */
export function smoothDampAngle(
  current: number, target: number, velRef: number[], smoothTime: number, dt: number,
  maxSpeed = Infinity,
): number {
  return smoothDamp(current, current + shortestAngle(current, target), velRef, smoothTime, dt, maxSpeed);
}

/** Signed shortest rotation from `a` to `b`, in (-PI, PI]. */
export function shortestAngle(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Vector3 SmoothDamp with one velocity vector carried by the caller. */
export class Vec3Damp {
  readonly value = new THREE.Vector3();
  private readonly vx = [0];
  private readonly vy = [0];
  private readonly vz = [0];
  private primed = false;

  set(v: THREE.Vector3): void {
    this.value.copy(v);
    this.vx[0] = this.vy[0] = this.vz[0] = 0;
    this.primed = true;
  }

  /** Snaps on the first call so a mode switch does not fly the camera in. */
  step(target: THREE.Vector3, smoothTime: number, dt: number): THREE.Vector3 {
    if (!this.primed) { this.set(target); return this.value; }
    this.value.set(
      smoothDamp(this.value.x, target.x, this.vx, smoothTime, dt),
      smoothDamp(this.value.y, target.y, this.vy, smoothTime, dt),
      smoothDamp(this.value.z, target.z, this.vz, smoothTime, dt),
    );
    return this.value;
  }

  unprime(): void { this.primed = false; }
  get isPrimed(): boolean { return this.primed; }
}

/**
 * Second-order spring used for cosmetic suspension (1.4). Stiffness and damping
 * are the literal physical constants, so `stiffness 60 / damping 8` reads the
 * same here as in the tuning table.
 */
export class Spring {
  value = 0;
  vel = 0;

  constructor(private stiffness: number, private damping: number) {}

  /** `force` is an external acceleration added on top of the restoring force. */
  step(force: number, dt: number): number {
    // Sub-step so a stiff spring stays stable at the 60 Hz fixed step.
    const steps = Math.min(4, Math.max(1, Math.ceil(dt * 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const accel = force - this.stiffness * this.value - this.damping * this.vel;
      this.vel += accel * h;
      this.value += this.vel * h;
    }
    return this.value;
  }
}

/**
 * One smoothed axis. Raw key state is binary; this ramps toward it so a tap does
 * not slam the controller from 0 to 1 in a single step (1.2).
 *
 * Attack and release are separate: pressing in takes `attack` seconds to reach
 * full, letting go takes `release` seconds to fall back, and reversing counts as
 * an attack because the player is asking for the other direction now.
 */
export class SmoothAxis {
  value = 0;

  constructor(private attack: number, private release: number) {}

  step(target: number, dt: number): number {
    const towardZero = Math.abs(target) < Math.abs(this.value) && target * this.value >= 0;
    const time = towardZero ? this.release : this.attack;
    if (time <= 0) { this.value = target; return this.value; }
    // Constant-rate approach: reaching 1 from 0 takes exactly `time` seconds,
    // which is what the tuning numbers claim. An exponential never arrives.
    const rate = dt / time;
    const d = target - this.value;
    this.value += Math.abs(d) <= rate ? d : Math.sign(d) * rate;
    return this.value;
  }

  reset(v = 0): void { this.value = v; }
}

/** Move/steer/throttle axes, all smoothed with the `feel` rates from config. */
export class InputSmoother {
  readonly moveX: SmoothAxis;
  readonly moveZ: SmoothAxis;
  readonly throttle: SmoothAxis;
  readonly steer: SmoothAxis;

  constructor() {
    const f = CFG.feel.input;
    this.moveX = new SmoothAxis(f.attack, f.release);
    this.moveZ = new SmoothAxis(f.attack, f.release);
    this.throttle = new SmoothAxis(f.throttleAttack, f.release);
    this.steer = new SmoothAxis(f.steerAttack, f.steerRelease);
  }
}

/**
 * Value noise sampled on a continuous line. Screen shake driven by this reads as
 * a physical wobble; `Math.random()` per frame reads as static (1.5).
 */
export function smoothNoise(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const h = (n: number): number => {
    const s = Math.sin((n * 127.1 + seed * 311.7) * 43758.5453);
    return s - Math.floor(s);
  };
  const a = h(i) * 2 - 1;
  const b = h(i + 1) * 2 - 1;
  const u = f * f * (3 - 2 * f); // smoothstep
  return a + (b - a) * u;
}
