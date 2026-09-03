// Where the player is looking (section 3).
//
// One yaw and one pitch, owned here and read by the camera modes and by the
// on-foot controller. Making this the single source of the look direction is
// also what removes the old feedback loop: the movement basis used to come from
// a camera heading that was itself chasing the character's velocity, so the two
// chased each other. Now the basis is a number the player sets.
//
// Pointer lock is requested on the first click of the canvas. Until it is
// granted the mouse contributes nothing, so an unlocked page -- or a smoke test,
// which cannot take a lock -- has a camera that simply holds still, rather than
// a second code path to keep working.
import * as THREE from 'three';
import { CFG } from '../config';
import type { System } from '../types';
import { shortestAngle, smoothDamp, smoothDampAngle } from '../core/smooth';

const M = CFG.feel.mouse;
const PITCH_MIN = (M.pitchMinDeg * Math.PI) / 180;
const PITCH_MAX = (M.pitchMaxDeg * Math.PI) / 180;

export interface MouseLookHost {
  input: { mouse: { dx: number; dy: number; locked: boolean } };
}

export class MouseLook implements System {
  /**
   * Absolute look direction on foot, in the game's heading convention. The
   * camera orbits the character along it and the movement keys are relative to
   * it.
   */
  yaw = 0;
  /**
   * Camera elevation, radians. Positive is above the subject looking down,
   * which is where a third-person camera lives.
   *
   * DECISION: the brief's "-35 to +60" is read as 35 degrees below the subject
   * to 60 above. A third-person camera that drops 35 degrees under a
   * character's feet is already further than most games allow, and the wider
   * half of the range is more use overhead.
   */
  pitch = M.restPitch;
  /**
   * Look-around offset for the chase camera, radians, relative to wherever the
   * rig is already pointing. Separate from `yaw` because a car's camera has its
   * own opinion about where it should sit and only wants to be nudged off it.
   */
  offset = 0;
  /** Seconds since the mouse last moved. */
  idle = Infinity;
  /** True once a pointer lock has been granted this session. */
  everLocked = false;

  private readonly host: MouseLookHost;
  private readonly recentreVel = [0];
  private readonly offsetVel = [0];

  constructor(host: MouseLookHost) { this.host = host; }

  get locked(): boolean { return this.host.input.mouse.locked; }

  /** Snap the look behind a subject, for a respawn or a camera hand-over. */
  reset(yaw: number): void {
    this.yaw = yaw;
    this.pitch = M.restPitch;
    this.offset = 0;
    this.recentreVel[0] = 0;
    this.offsetVel[0] = 0;
    this.idle = Infinity;
  }

  update(dt: number): void {
    const mouse = this.host.input.mouse;
    const dx = mouse.dx, dy = mouse.dy;
    // Consumed here rather than in Input.endFrame(): several physics steps can
    // run inside one rendered frame, and the same pixels must not be applied
    // twice.
    mouse.dx = 0;
    mouse.dy = 0;

    if (mouse.locked && (dx !== 0 || dy !== 0)) {
      this.everLocked = true;
      this.idle = 0;
      // Screen-right turns the camera right. The game measures yaw from +Z
      // toward +X, so a rightward mouse decreases it.
      this.yaw = wrap(this.yaw - dx * M.sensitivity);
      this.offset = wrap(this.offset - dx * M.sensitivity);
      this.pitch = THREE.MathUtils.clamp(
        this.pitch + (M.invertY ? -dy : dy) * M.sensitivity, PITCH_MIN, PITCH_MAX,
      );
    } else {
      this.idle += dt;
    }

    // The chase camera's look-around always falls back to centre; the on-foot
    // yaw does not, because there is nowhere for it to fall back to until the
    // character starts moving (see `recentre`).
    if (this.idle >= M.recentreDelay) {
      this.offset = smoothDamp(this.offset, 0, this.offsetVel, M.recentreTime, dt);
      if (Math.abs(this.offset) < 1e-4) { this.offset = 0; this.offsetVel[0] = 0; }
    }
  }

  /**
   * Drift the on-foot yaw back behind `heading` once the mouse has been idle.
   *
   * `strength` scales the pull, and the caller passes the character's own speed
   * through it: standing still means no pull at all, which is the point. A
   * camera that swings toward the character while the character is turning
   * toward the camera is the loop that made the old rig unstable, and it cannot
   * happen if nothing pulls while nothing moves.
   */
  recentre(heading: number, dt: number, strength: number): void {
    if (strength <= 0.01 || this.idle < M.recentreDelay) return;
    const target = this.yaw + shortestAngle(this.yaw, heading);
    this.yaw = smoothDampAngle(
      this.yaw, target, this.recentreVel, M.recentreTime / Math.min(strength, 1), dt,
    );
  }
}

function wrap(a: number): number {
  if (a > Math.PI) return a - Math.PI * 2;
  if (a < -Math.PI) return a + Math.PI * 2;
  return a;
}

/**
 * Ask for a pointer lock on the first click, and keep asking on later clicks
 * once the player has pressed Escape.
 *
 * Chrome throws if the lock is requested too soon after the previous one was
 * released, and Safari rejects one that is not inside a user gesture; both come
 * back as a rejected promise or a thrown error, and neither is worth breaking
 * a frame over -- the game is entirely playable unlocked.
 */
export function installPointerLock(canvas: HTMLElement): void {
  canvas.addEventListener('click', () => {
    if (document.pointerLockElement === canvas) return;
    try {
      const req = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (req && typeof req.catch === 'function') req.catch(() => {});
    } catch {
      /* locked out by the browser; the game plays fine without it */
    }
  });
}
