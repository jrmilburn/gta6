// Camera rig. Modes live in a registry so extra modes can be added with
// `registerCameraMode` instead of rewriting this file.
//
// The rig runs on *rendered* frames, not the fixed physics step (feel pass 1.5).
// Every follower is a critically damped spring expressed as a smooth-time, so
// the same tuning holds at 30, 60 or 144 fps, and the chase yaw is rate-limited
// so a handbrake turn swings the camera around rather than teleporting it.
import * as THREE from 'three';
import type { AABB, Renderable, Vec2 } from '../types';
import { CFG } from '../config';
import { SpatialHash } from '../core/spatial';
import { segmentVsAabb } from '../entities/collision';
import { Vec3Damp, smoothDamp, smoothDampAngle, smoothNoise } from '../core/smooth';
import type { VehicleHitPayload } from '../entities/vehicle';

export type CameraModeName = 'chase' | 'hood' | 'orbit' | 'drone' | 'free';

const C = CFG.feel.camera;
const YAW_RATE = (C.yawRateDeg * Math.PI) / 180;

/** What a camera mode is allowed to know about what it is following. */
export interface CameraSubject {
  pos: Vec2;
  y: number;
  heading: number;
  /** Direction of travel including slip, so a drift slides the car across frame. */
  velocityHeading: number;
  speed: number;
  /** |speed| / maxSpeed, 0..1. */
  speedFrac: number;
}

export interface CameraFrame {
  eye: THREE.Vector3;
  look: THREE.Vector3;
  fov: number;
  /** SmoothDamp time for the eye position, seconds. 0 snaps. */
  posSmooth: number;
  /** SmoothDamp time for the look target, seconds. */
  lookSmooth: number;
  /** Whether to pull the camera in through world colliders. */
  occlude: boolean;
  /**
   * Rate-limited heading the rig maintains behind the subject. Chase-style modes
   * place the eye along this instead of the subject's instantaneous heading, so
   * a handbrake turn swings the camera rather than snapping it (1.5).
   */
  yaw: number;
}

export type CameraModeImpl = (s: CameraSubject, f: CameraFrame, dt: number) => void;

/**
 * Chase: sit `chaseDist` behind and `chaseHeight` above along the rig's
 * rate-limited follow yaw, so the body angle reads as a slide (plan section 4).
 */
const chase: CameraModeImpl = (s, f) => {
  const fx = Math.sin(f.yaw), fz = Math.cos(f.yaw);
  f.eye.set(
    s.pos.x - fx * CFG.camera.chaseDist,
    s.y + CFG.camera.chaseHeight,
    s.pos.z - fz * CFG.camera.chaseDist,
  );
  const bx = Math.sin(s.heading), bz = Math.cos(s.heading);
  f.look.set(s.pos.x + bx * 2, s.y + 1, s.pos.z + bz * 2);
  f.fov = THREE.MathUtils.lerp(CFG.camera.fovBase, CFG.camera.fovAtMaxSpeed, s.speedFrac);
  f.posSmooth = C.chasePos;
  f.lookSmooth = C.chaseLook;
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

export class CameraRig implements Renderable {
  mode: CameraModeName = 'chase';
  subject: CameraSubject | null = null;
  /** Rate-limited heading the chase modes place the eye along. */
  followYaw = 0;

  private readonly cam: THREE.PerspectiveCamera;
  private readonly frame: CameraFrame = {
    eye: new THREE.Vector3(), look: new THREE.Vector3(),
    fov: CFG.camera.fovBase, posSmooth: C.chasePos, lookSmooth: C.chaseLook,
    occlude: true, yaw: 0,
  };
  private readonly eyeDamp = new Vec3Damp();
  private readonly lookDamp = new Vec3Damp();
  private readonly final = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly blendEye = new THREE.Vector3();
  private readonly blendLook = new THREE.Vector3();
  /** Scratch: the damper's own vector must never be mutated by the blend. */
  private readonly lookFinal = new THREE.Vector3();
  private hash = new SpatialHash<AABB>(20);
  private nearby: AABB[] = [];
  private fovVel = [0];
  private yawVel = [0];
  /** Smoothed occlusion factor, 1 = free, <1 = pulled in toward the subject. */
  private occlusion = 1;
  private occlusionVel = [0];
  private shake = 0;
  private shakeT = 0;
  private shakeClock = 0;
  private primed = false;
  /** Enter/exit blend: 1 -> 0 over `transition`, from a frozen old viewpoint. */
  private transition = 0;

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

  /**
   * Swap subject without cutting: the current eye/look are kept and the rig
   * blends from them to the new subject's frame over `transition` seconds (1.4).
   */
  blendToSubject(s: CameraSubject | null, mode: CameraModeName): void {
    if (this.primed) {
      this.blendEye.copy(this.eyeDamp.value);
      this.blendLook.copy(this.lookDamp.value);
      this.transition = 1;
    }
    this.subject = s;
    this.mode = mode;
    if (s) this.followYaw = s.heading;
    this.yawVel[0] = 0;
    // Keep the damped state so the blend has somewhere to start from.
    if (!this.eyeDamp.isPrimed) this.primed = false;
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

  /** Screen shake, 0..1. */
  kick(amount: number): void {
    this.shake = Math.max(this.shake, amount);
    this.shakeT = C.shakeTime;
  }

  renderSync(_alpha: number, dt: number): void {
    const s = this.subject;
    if (!s || dt <= 0) return;

    this.stepFollowYaw(s, dt);

    const f = this.frame;
    f.occlude = true;
    f.posSmooth = C.chasePos;
    f.lookSmooth = C.chaseLook;
    f.yaw = this.followYaw;
    (MODES[this.mode] ?? chase)(s, f, dt);

    if (!this.primed) {
      this.eyeDamp.set(f.eye);
      this.lookDamp.set(f.look);
      this.occlusion = 1;
      this.occlusionVel[0] = 0;
      this.fovVel[0] = 0;
      this.cam.fov = f.fov;
      this.cam.updateProjectionMatrix();
      this.primed = true;
    }

    const eye = this.eyeDamp.step(f.eye, f.posSmooth, dt);
    const look = this.lookFinal.copy(this.lookDamp.step(f.look, f.lookSmooth, dt));

    this.final.copy(eye);
    if (f.occlude) this.applyOcclusion(look, this.final, dt);

    // Enter/exit: ease the whole viewpoint out of where it was.
    if (this.transition > 0) {
      this.transition = Math.max(0, this.transition - dt / C.transition);
      const t = this.transition * this.transition * (3 - 2 * this.transition); // smoothstep
      this.final.lerp(this.blendEye, t);
      look.lerp(this.blendLook, t);
    }

    this.applyShake(dt);
    this.cam.position.copy(this.final).add(this.offset);
    this.cam.lookAt(look);

    const fov = smoothDamp(this.cam.fov, f.fov, this.fovVel, C.fov, dt);
    if (Math.abs(this.cam.fov - fov) > 0.005) {
      this.cam.fov = fov;
      this.cam.updateProjectionMatrix();
    }
  }

  /**
   * The heading the chase camera sits behind. It follows the subject's direction
   * of travel, but no faster than `yawRateDeg` per second, so a handbrake turn
   * swings the camera around the car instead of snapping behind the new heading.
   */
  private stepFollowYaw(s: CameraSubject, dt: number): void {
    const want = Math.abs(s.speed) > 3 ? s.velocityHeading : s.heading;
    if (!this.primed) { this.followYaw = want; this.yawVel[0] = 0; return; }
    this.followYaw = smoothDampAngle(this.followYaw, want, this.yawVel, C.chasePos, dt, YAW_RATE);
  }

  /**
   * If a collider sits between the subject and the eye, pull the eye in toward
   * the look target. The pull-in factor is itself smoothed -- fast on the way in
   * so the camera never ends up inside a wall, slow on the way back out so
   * clearing a corner does not fling it (1.5).
   *
   * Colliders are AABBs with no height, so this is a 2D test in XZ.
   * // DECISION: good enough for buildings, which are tall.
   */
  private applyOcclusion(look: THREE.Vector3, eye: THREE.Vector3, dt: number): void {
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
    const want = best >= 1 ? 1 : Math.max(0.15, best - 0.5 / len);
    const time = want < this.occlusion ? C.occludeIn : C.occludeOut;
    this.occlusion = smoothDamp(this.occlusion, want, this.occlusionVel, time, dt);
    if (this.occlusion >= 0.999) return;
    const t = this.occlusion;
    eye.x = look.x + dx * t;
    eye.z = look.z + dz * t;
    eye.y = look.y + (eye.y - look.y) * Math.max(t, 0.4);
  }

  /**
   * Shake sampled from smooth value noise on three separate lines. Sampling
   * Math.random() per frame produces per-pixel static whose apparent violence
   * scales with frame rate; noise gives a physical wobble that does not.
   */
  private applyShake(dt: number): void {
    if (this.shakeT <= 0) { this.offset.set(0, 0, 0); this.shake = 0; return; }
    this.shakeT = Math.max(0, this.shakeT - dt);
    this.shakeClock += dt * C.shakeFreq;
    const k = this.shake * (this.shakeT / C.shakeTime) ** 2 * 0.7;
    this.offset.set(
      smoothNoise(this.shakeClock, 1),
      smoothNoise(this.shakeClock, 2),
      smoothNoise(this.shakeClock, 3),
    ).multiplyScalar(k);
  }
}
