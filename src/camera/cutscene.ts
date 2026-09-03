// Cutscenes: a few seconds of held camera on the moments that earn one -- a
// bust, a wreck, the stars going up, a roadblock going down, the first ride
// on the wheel, the dive, the first time in a car.
//
// The design is the intro's (introCamera.ts): a Renderable added AFTER the
// camera rig that simply overwrites what the rig wrote, holds each shot
// still with a hard cut between them, then slerps back to whatever the live
// rig is showing. The rig keeps running underneath the whole time, so the
// handover always has a real camera to arrive at and nothing needs re-priming.
// Wall-clock timing, like the intro: a cut that lands late because the
// physics fell behind is a bug you can see.
import * as THREE from 'three';
import type { EventName, Renderable, Vec2 } from '../types';

const DEG = Math.PI / 180;
/** Seconds before any movement key may skip a scene. */
const SKIP_GUARD = 1;
/** The blend back to the live rig. */
const HANDOVER = 0.9;
/** Longest one rendered frame may advance a scene; a stall must not eat a shot. */
const MAX_STEP = 0.1;

const M = new THREE.Matrix4();
const AT = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function ease(t: number): number {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** Where a shot looks: a live point (a car, the player, the helicopter). */
export type Anchor = () => { x: number; y: number; z: number; heading?: number };

export interface Shot {
  /** Seconds this shot holds. */
  dur: number;
  /** What the shot is framed around. */
  at: Anchor;
  /** Bearing round the anchor, degrees; 0 is behind it (its heading + 180) when it has one, else +Z. */
  az: number;
  /** Metres out from the anchor, and up from it. */
  dist: number;
  h: number;
  /** Height above the anchor the camera looks at. */
  look?: number;
  fov?: number;
  /** Bearing drift over the shot, degrees: a slow orbit, or a push-in when `distTo` is set. */
  drift?: number;
  distTo?: number;
  /** A second anchor to look at instead of the first (eye on one, look at another). */
  lookAt?: Anchor;
}

export interface CutsceneHost {
  camera: THREE.PerspectiveCamera;
  events: { emit(evt: EventName, payload?: unknown): void };
  input: { isDown(a: 'forward' | 'back' | 'left' | 'right' | 'handbrake'): boolean; justPressed(a: 'interact'): boolean };
}

export class CutsceneDirector implements Renderable {
  active = false;
  /** Which shot is on screen, or the shot count during the handover, or -1. */
  shot = -1;
  /** A name for the running scene, for the tests and the HUD. */
  name = '';

  private shots: Shot[] = [];
  private t = 0;
  private total = 0;
  private readonly fromEye = new THREE.Vector3();
  private readonly fromQuat = new THREE.Quaternion();
  private fromFov = 55;
  private handoverPrimed = false;
  private readonly eye = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly liveEye = new THREE.Vector3();
  private readonly liveQuat = new THREE.Quaternion();
  private onDone: (() => void) | null = null;
  /** Seconds since each named scene last played, for the repeat guard. */
  private readonly lastPlayed = new Map<string, number>();
  private clock = 0;

  constructor(
    private readonly host: CutsceneHost,
    /** Letterbox bars on and off. */
    private readonly letterbox: (on: boolean) => void,
  ) {}

  /**
   * Play a scene. A scene already playing is not interrupted, and a scene by
   * the same name within `repeatGuard` seconds is skipped -- three stars twice
   * in a minute is one cutscene, not two.
   */
  play(name: string, shots: Shot[], opts: { repeatGuard?: number; onDone?: () => void } = {}): boolean {
    if (this.active || shots.length === 0) return false;
    const last = this.lastPlayed.get(name);
    if (last !== undefined && this.clock - last < (opts.repeatGuard ?? 30)) return false;
    this.lastPlayed.set(name, this.clock);
    this.name = name;
    this.shots = shots;
    this.t = 0;
    this.total = shots.reduce((a, s) => a + s.dur, 0);
    this.handoverPrimed = false;
    this.active = true;
    this.shot = 0;
    this.onDone = opts.onDone ?? null;
    this.letterbox(true);
    this.host.events.emit('cutsceneStart', { name });
    return true;
  }

  /** Cut to the handover. */
  skip(): void {
    if (!this.active || this.t >= this.total) return;
    this.t = this.total;
  }

  private finish(): void {
    this.active = false;
    this.shot = -1;
    this.letterbox(false);
    const done = this.onDone;
    this.onDone = null;
    this.host.events.emit('cutsceneEnd', { name: this.name });
    done?.();
  }

  private wantsSkip(): boolean {
    const i = this.host.input;
    return i.isDown('forward') || i.isDown('back') || i.isDown('left') || i.isDown('right')
      || i.isDown('handbrake') || i.justPressed('interact');
  }

  private place(s: Shot, k: number, into: THREE.Vector3, quat: THREE.Quaternion): number {
    const a = s.at();
    const base = a.heading !== undefined ? a.heading + Math.PI : 0;
    const az = base + (s.az + (s.drift ?? 0) * k) * DEG;
    const dist = s.distTo !== undefined ? THREE.MathUtils.lerp(s.dist, s.distTo, ease(k)) : s.dist;
    into.set(a.x + Math.sin(az) * dist, a.y + s.h, a.z + Math.cos(az) * dist);
    const l = s.lookAt ? s.lookAt() : a;
    AT.set(l.x, l.y + (s.look ?? 1.0), l.z);
    M.lookAt(into, AT, UP);
    quat.setFromRotationMatrix(M);
    return s.fov ?? 50;
  }

  renderSync(_alpha: number, dt: number): void {
    this.clock += dt;
    if (!this.active || dt <= 0) return;
    this.t += Math.min(dt, MAX_STEP);
    if (this.t > SKIP_GUARD && this.wantsSkip()) this.skip();
    if (this.t >= this.total + HANDOVER) { this.finish(); return; }

    const cam = this.host.camera;
    if (this.t >= this.total) {
      // The handover: from wherever the last shot left us to the live rig,
      // which has already written this frame's camera.
      this.shot = this.shots.length;
      if (!this.handoverPrimed) {
        this.fromEye.copy(this.eye);
        this.fromQuat.copy(this.quat);
        this.handoverPrimed = true;
      }
      const k = ease((this.t - this.total) / HANDOVER);
      this.liveEye.copy(cam.position);
      this.liveQuat.copy(cam.quaternion);
      cam.position.copy(this.fromEye).lerp(this.liveEye, k);
      cam.quaternion.copy(this.fromQuat).slerp(this.liveQuat, k);
      cam.fov = THREE.MathUtils.lerp(this.fromFov, cam.fov, k);
      cam.updateProjectionMatrix();
      return;
    }

    let t = this.t;
    let idx = 0;
    for (; idx < this.shots.length - 1; idx++) {
      if (t < this.shots[idx].dur) break;
      t -= this.shots[idx].dur;
    }
    this.shot = idx;
    const s = this.shots[idx];
    const k = s.dur > 0 ? t / s.dur : 1;
    this.fromFov = this.place(s, k, this.eye, this.quat);
    cam.position.copy(this.eye);
    cam.quaternion.copy(this.quat);
    cam.fov = this.fromFov;
    cam.updateProjectionMatrix();
  }
}

/** A fixed world point as an anchor. */
export const at = (p: Vec2, y = 0, heading?: number): Anchor => () => ({ x: p.x, y, z: p.z, heading });
