// The opening flight: a drone shot high over the city, three hard cuts pushing
// in, then one smooth blend into the live player camera.
//
// It runs as a Renderable added AFTER the camera rig, and simply overwrites
// what the rig wrote. That ordering is the whole design: the rig keeps running
// underneath the entire flight, fully primed and following the player, so the
// final blend has a real, live, correct camera to arrive at. Nothing has to be
// handed over, suspended or re-primed -- the flight just stops overwriting.
//
// Timing is wall clock, not simulated time. A cut that lands on a different
// beat because the physics fell behind is a bug you can see.
import * as THREE from 'three';
import { CFG } from '../config';
import type { Renderable, Vec2 } from '../types';

const I = CFG.feel.intro;
const DEG = Math.PI / 180;

// Scratch. A straight-down view cannot be aimed with lookAt and the default up
// vector -- the two are parallel and the roll is undefined -- so orientation is
// built as a matrix with an explicit up and read out as a quaternion. That also
// makes the handover a slerp, which is the right way to rotate a camera anyway.
const M = new THREE.Matrix4();
const AT = new THREE.Vector3();
const UP = new THREE.Vector3();

export interface IntroSubject {
  pos: Vec2;
  y: number;
  heading: number;
}

interface IntroHost {
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
}

/** Smootherstep: zero velocity at both ends, so a drift has no visible kick. */
function ease(t: number): number {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** A camera pose, in the polar terms the shot list is written in. */
interface Pose {
  az: number;
  dist: number;
  h: number;
  look: number;
  fov: number;
}

const lerpPose = (a: Pose, b: Pose, t: number): Pose => ({
  az: THREE.MathUtils.lerp(a.az, b.az, t),
  dist: THREE.MathUtils.lerp(a.dist, b.dist, t),
  h: THREE.MathUtils.lerp(a.h, b.h, t),
  look: THREE.MathUtils.lerp(a.look, b.look, t),
  fov: THREE.MathUtils.lerp(a.fov, b.fov, t),
});

export class IntroFlight implements Renderable {
  /** True from the first frame of the flight until the blend completes. */
  active = false;
  /** Seconds since the flight started, wall clock. */
  private t = 0;
  /** Whether a keypress has already cut us to the handover. */
  private skipped = false;
  private readonly shots = I.shots.map((s) => ({
    dur: s.dur,
    /** True to orbit the city centre on a world azimuth, not the player. */
    world: 'world' in s && s.world === true,
    /** True to sit directly overhead pointing straight down. */
    topDown: 'topDown' in s && s.topDown === true,
    from: { az: s.az[0], dist: s.dist[0], h: s.h[0], look: s.look[0], fov: s.fov[0] } as Pose,
    to: { az: s.az[1], dist: s.dist[1], h: s.h[1], look: s.look[1], fov: s.fov[1] } as Pose,
  }));
  private readonly flightTime = I.shots.reduce((a, s) => a + s.dur, 0);
  private readonly total = this.flightTime + I.handover.dur;

  /** Where the camera sat when the handover began, in world space. */
  private readonly fromEye = new THREE.Vector3();
  private readonly fromQuat = new THREE.Quaternion();
  private fromFov = I.handover.fov;
  private handoverPrimed = false;

  /** Fog is lifted for the flight and put back exactly as it was. */
  private fog: THREE.FogExp2 | null = null;
  private fogDensity = 0;

  private readonly eye = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly liveEye = new THREE.Vector3();
  private readonly liveQuat = new THREE.Quaternion();
  private detach: (() => void) | null = null;

  constructor(
    private readonly host: IntroHost,
    private readonly subject: IntroSubject,
    /** What the world-framed shots orbit; the middle of the city. */
    private readonly focus: Vec2 = { x: 0, z: 0 },
  ) {}

  /**
   * Which shot is on screen: 0..n-1 during the cuts, n during the handover
   * blend, -1 when the flight is not running. The smoke suite reads this to
   * check the cuts happened rather than inferring them from camera jumps, which
   * a slow frame makes ambiguous.
   */
  get shot(): number {
    if (!this.active) return -1;
    if (this.t >= this.flightTime) return this.shots.length;
    let t = this.t;
    for (let i = 0; i < this.shots.length; i++) {
      if (t < this.shots[i].dur) return i;
      t -= this.shots[i].dur;
    }
    return this.shots.length - 1;
  }

  /**
   * Begin. The subject's heading is sampled once, so the whole flight is
   * composed around where the player is facing at the moment they start.
   */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.t = 0;
    this.skipped = false;
    this.handoverPrimed = false;
    const fog = this.host.scene.fog;
    if (fog instanceof THREE.FogExp2) {
      this.fog = fog;
      this.fogDensity = fog.density;
    }
    const onSkip = (): void => this.skip();
    window.addEventListener('keydown', onSkip);
    window.addEventListener('mousedown', onSkip);
    this.detach = () => {
      window.removeEventListener('keydown', onSkip);
      window.removeEventListener('mousedown', onSkip);
    };
  }

  /**
   * Cut to the handover blend. Not to the end: skipping should still arrive in
   * the game rather than snapping there, and the blend is under two seconds.
   */
  skip(): void {
    if (!this.active || this.skipped || this.t < I.skipGuard) return;
    this.skipped = true;
    this.t = this.flightTime;
  }

  /** Put the fog back and stop overwriting the rig. */
  private finish(): void {
    if (this.fog) this.fog.density = this.fogDensity;
    this.fog = null;
    this.active = false;
    this.detach?.();
    this.detach = null;
  }

  /** Polar pose -> a world eye position and the orientation to hold there. */
  private place(
    p: Pose, world: boolean, topDown: boolean,
    into: THREE.Vector3, quat: THREE.Quaternion,
  ): void {
    const c = world ? this.focus : this.subject.pos;
    const y = world ? 0 : this.subject.y;

    if (topDown) {
      // Directly above, pointing at the ground. `az` and `dist` slide the camera
      // across the map without tilting it, and `az` also picks which bearing
      // runs up the screen -- straight down has no other way to define roll.
      const a = p.az * DEG;
      into.set(c.x + Math.sin(a) * p.dist, y + p.h, c.z + Math.cos(a) * p.dist);
      AT.set(into.x, into.y - 10, into.z);
      UP.set(Math.sin(a), 0, Math.cos(a));
    } else {
      // Player-framed: az 0 is BEHIND the subject, where the chase camera
      // already sits, so the handover is a short move rather than a swing across
      // the map. World-framed: az is a compass bearing around the city.
      const a = world ? p.az * DEG : this.subject.heading + Math.PI + p.az * DEG;
      into.set(c.x + Math.sin(a) * p.dist, y + p.h, c.z + Math.cos(a) * p.dist);
      AT.set(c.x, y + p.look, c.z);
      UP.set(0, 1, 0);
    }
    M.lookAt(into, AT, UP);
    quat.setFromRotationMatrix(M);
  }

  renderSync(_alpha: number, dt: number): void {
    if (!this.active || dt <= 0) return;
    this.t += Math.min(dt, I.maxStep);
    if (this.t >= this.total) { this.finish(); return; }

    const cam = this.host.camera;

    // --- the handover: blend from wherever shot 3 left us to the live rig ----
    if (this.t >= this.flightTime) {
      if (!this.handoverPrimed) {
        // The final shot is the one angled behind the player -- a cut from the
        // last top-down, and the frame the blend runs FROM.
        const h = I.handover;
        this.place({ az: 0, dist: h.dist, h: h.h, look: h.look, fov: h.fov }, false, false,
          this.fromEye, this.fromQuat);
        this.fromFov = h.fov;
        this.handoverPrimed = true;
      }
      const k = ease((this.t - this.flightTime) / I.handover.dur);
      // The rig has already written this frame's camera, so where it wants to be
      // is sitting right there to be read. Taking its orientation as a
      // quaternion rather than recomputing a look target means this works for
      // every camera mode without knowing anything about any of them.
      this.liveEye.copy(cam.position);
      this.liveQuat.copy(cam.quaternion);
      cam.position.copy(this.fromEye).lerp(this.liveEye, k);
      cam.quaternion.copy(this.fromQuat).slerp(this.liveQuat, k);
      cam.fov = THREE.MathUtils.lerp(this.fromFov, cam.fov, k);
      cam.updateProjectionMatrix();
      if (this.fog) {
        this.fog.density = THREE.MathUtils.lerp(
          this.fogDensity * I.fogLift, this.fogDensity, k,
        );
      }
      return;
    }

    // --- shots 1..3: drift within the shot, hard cut between them ------------
    let t = this.t;
    let shot = this.shots[0];
    for (const s of this.shots) {
      if (t < s.dur) { shot = s; break; }
      t -= s.dur;
      shot = s;
    }
    const p = lerpPose(shot.from, shot.to, ease(t / shot.dur));
    this.place(p, shot.world, shot.topDown, this.eye, this.quat);
    cam.position.copy(this.eye);
    cam.quaternion.copy(this.quat);
    cam.fov = p.fov;
    cam.updateProjectionMatrix();

    // Lift the fog for the altitude, easing it back as the flight descends, so
    // the last shot already sits in the game's own air.
    if (this.fog) {
      const k = ease(this.t / this.flightTime);
      this.fog.density = THREE.MathUtils.lerp(this.fogDensity * I.fogLift, this.fogDensity, k);
    }
  }
}
