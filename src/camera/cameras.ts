// Camera rig. Phase 2 ships the chase camera only, but modes live in a registry
// so Phase 8 can add hood/orbit/drone/free-fly with `registerCameraMode` instead
// of rewriting this file.
import * as THREE from 'three';
import type { AABB, System, Vec2 } from '../types';
import { CFG } from '../config';
import { SpatialHash } from '../core/spatial';
import { segmentVsAabb } from '../entities/collision';
import type { VehicleHitPayload } from '../entities/vehicle';

export type CameraModeName = 'chase' | 'hood' | 'orbit' | 'drone' | 'free';

/** What a camera mode is allowed to know about what it is following. */
export interface CameraSubject {
  pos: Vec2;
  y: number;
  heading: number;
  speed: number;
  /** Direction of travel including slip, so a drift slides the car across frame. */
  velocityHeading: number;
  /** |speed| / maxSpeed, 0..1. */
  speedFrac: number;
}

export interface CameraFrame {
  eye: THREE.Vector3;
  look: THREE.Vector3;
  fov: number;
  /** Lerp rate for the eye position; 0 snaps. */
  lag: number;
  /** Whether to pull the camera in through world colliders. */
  occlude: boolean;
}

export type CameraModeImpl = (s: CameraSubject, f: CameraFrame, dt: number) => void;

/**
 * Chase: sit `chaseDist` behind and `chaseHeight` above, along the velocity
 * heading once moving, so the body angle reads as a slide (plan section 4).
 */
const chase: CameraModeImpl = (s, f) => {
  const dir = s.speed > 3 ? s.velocityHeading : s.heading;
  const fx = Math.sin(dir), fz = Math.cos(dir);
  f.eye.set(
    s.pos.x - fx * CFG.camera.chaseDist,
    s.y + CFG.camera.chaseHeight,
    s.pos.z - fz * CFG.camera.chaseDist,
  );
  const bx = Math.sin(s.heading), bz = Math.cos(s.heading);
  f.look.set(s.pos.x + bx * 2, s.y + 1, s.pos.z + bz * 2);
  f.fov = THREE.MathUtils.lerp(CFG.camera.fovBase, CFG.camera.fovAtMaxSpeed, s.speedFrac);
  f.lag = CFG.camera.lag;
};

const MODES: Partial<Record<CameraModeName, CameraModeImpl>> = { chase };

export function registerCameraMode(name: CameraModeName, impl: CameraModeImpl): void {
  MODES[name] = impl;
}

export function cameraModeNames(): CameraModeName[] {
  return Object.keys(MODES) as CameraModeName[];
}

interface RigHost {
  camera: THREE.PerspectiveCamera;
  events: { on(evt: 'vehicleHit', fn: (p?: unknown) => void): void };
}

const SHAKE_TIME = 0.3;

export class CameraRig implements System {
  mode: CameraModeName = 'chase';
  subject: CameraSubject | null = null;

  private readonly cam: THREE.PerspectiveCamera;
  private readonly frame: CameraFrame = {
    eye: new THREE.Vector3(), look: new THREE.Vector3(),
    fov: CFG.camera.fovBase, lag: CFG.camera.lag, occlude: true,
  };
  private readonly smoothed = new THREE.Vector3();
  private readonly final = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private hash = new SpatialHash<AABB>(20);
  private nearby: AABB[] = [];
  private shake = 0;
  private shakeT = 0;
  private primed = false;

  constructor(host: RigHost, colliders: readonly AABB[] = []) {
    this.cam = host.camera;
    this.setColliders(colliders);
    // Shake on impacts, damped by how far away the crash was.
    host.events.on('vehicleHit', (p?: unknown) => {
      const hit = p as VehicleHitPayload | undefined;
      if (!hit) return;
      const s = this.subject;
      const dist = s ? Math.hypot(hit.x - s.pos.x, hit.z - s.pos.z) : 0;
      const falloff = Math.max(0, 1 - dist / 30);
      this.kick(Math.min(1, (hit.impact / 25) * falloff));
    });
  }

  setSubject(s: CameraSubject | null): void {
    this.subject = s;
    this.primed = false;
  }

  setColliders(colliders: readonly AABB[]): void {
    this.hash = new SpatialHash<AABB>(20);
    for (const c of colliders) this.hash.insertAABB(c, c);
  }

  setMode(m: CameraModeName): void { this.mode = m; this.primed = false; }

  cycle(): void {
    const names = cameraModeNames();
    const i = names.indexOf(this.mode);
    this.setMode(names[(i + 1) % names.length]);
  }

  /** Screen shake, 0..1, decaying over 0.3 s. */
  kick(amount: number): void {
    this.shake = Math.max(this.shake, amount);
    this.shakeT = SHAKE_TIME;
  }

  update(dt: number): void {
    const s = this.subject;
    if (!s) return;

    const f = this.frame;
    f.occlude = true;
    (MODES[this.mode] ?? chase)(s, f, dt);

    if (!this.primed) { this.smoothed.copy(f.eye); this.primed = true; }
    else this.smoothed.lerp(f.eye, f.lag <= 0 ? 1 : 1 - Math.exp(-f.lag * dt));

    // Occlusion is applied to the rendered position only, so the smoothed track
    // is not permanently dragged towards the wall.
    this.final.copy(this.smoothed);
    if (f.occlude) this.pullIn(f.look, this.final);

    if (this.shakeT > 0) {
      this.shakeT = Math.max(0, this.shakeT - dt);
      const k = this.shake * (this.shakeT / SHAKE_TIME) ** 2 * 0.7;
      this.offset.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(k);
      if (this.shakeT === 0) this.shake = 0;
    } else {
      this.offset.set(0, 0, 0);
    }

    this.cam.position.copy(this.final).add(this.offset);
    this.cam.lookAt(f.look);
    if (Math.abs(this.cam.fov - f.fov) > 0.01) {
      this.cam.fov = f.fov;
      this.cam.updateProjectionMatrix();
    }
  }

  /**
   * If a collider sits between the subject and the eye, walk the eye forward to
   * the hit point minus 0.5 m. Colliders are AABBs with no height, so this is a
   * 2D test in XZ. // DECISION: good enough for buildings, which are tall.
   */
  private pullIn(look: THREE.Vector3, eye: THREE.Vector3): void {
    const mid: Vec2 = { x: (look.x + eye.x) * 0.5, z: (look.z + eye.z) * 0.5 };
    const dx = eye.x - look.x, dz = eye.z - look.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) return;
    this.nearby = this.hash.query(mid, len * 0.5 + 4, this.nearby);
    let best = 1;
    for (const b of this.nearby) {
      const t = segmentVsAabb(look.x, look.z, eye.x, eye.z, b);
      if (t >= 0 && t < best) best = t;
    }
    if (best >= 1) return;
    const t = Math.max(0.15, best - 0.5 / len);
    eye.x = look.x + dx * t;
    eye.z = look.z + dz * t;
    eye.y = look.y + (eye.y - look.y) * Math.max(t, 0.4);
  }
}
