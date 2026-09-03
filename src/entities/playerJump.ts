// Vertical motion for the on-foot player (feel pass 1.3).
//
// A jump is not just "set yVel, subtract gravity": it reads as weightless
// without a wind-up and lands like a dropped brick without a recovery. This
// runs four phases -- anticipation, rise, apex hang, land -- and exposes the
// crouch/stretch amount separately so the mesh can squash without the collision
// capsule moving.
import { CFG } from '../config';

const F = CFG.feel.foot;
const JUMP_HEIGHT = 1.2;
const GRAVITY = 22;
const JUMP_SPEED = Math.sqrt(2 * GRAVITY * JUMP_HEIGHT);
/** Vertical speed band around the apex where gravity is softened. */
const HANG_BAND = 2.2;

type Phase = 'ground' | 'anticipate' | 'air' | 'land';

export class Legs {
  /**
   * Seconds of wind-up before the impulse. Defaults to the tuned value and is
   * overwritten by the jump clip's own measured take-off time when one exists,
   * so the clip and the physics leave the ground together (section 4).
   */
  anticipation = F.jumpAnticipation;

  /** Height of the hips above the ground surface, metres. Feeds player.y. */
  height = 0;
  /** True whenever the feet are on the ground (including the wind-up crouch). */
  grounded = true;
  /** Set for one step on the frame the feet touch down again. */
  justLanded = false;
  /** True only while actually off the ground; the mesh tucks the legs then. */
  airborne = false;
  /**
   * -1 fully crouched (wind-up or landing squash) .. +1 fully stretched (rise).
   * Purely cosmetic; the mesh scales and bends from it.
   */
  crouch = 0;

  private phase: Phase = 'ground';
  private timer = 0;
  private vel = 0;
  private hangLeft = 0;

  reset(): void {
    this.height = 0;
    this.grounded = true;
    this.airborne = false;
    this.crouch = 0;
    this.justLanded = false;
    this.phase = 'ground';
    this.timer = 0;
    this.vel = 0;
    this.hangLeft = 0;
  }

  /** Leave the ground now at `upSpeed`, no wind-up: a dive, a shove. */
  launch(upSpeed: number): void {
    this.phase = 'air';
    this.grounded = false;
    this.airborne = true;
    this.vel = upSpeed;
    this.hangLeft = 0;
    this.crouch = 0;
  }

  step(dt: number, jumpPressed: boolean): void {
    this.justLanded = false;
    if (this.phase === 'ground' && jumpPressed) {
      this.phase = 'anticipate';
      this.timer = 0;
    }

    switch (this.phase) {
      case 'anticipate': return this.stepAnticipate(dt);
      case 'air': return this.stepAir(dt);
      case 'land': return this.stepLand(dt);
      default:
        this.crouch += (0 - this.crouch) * Math.min(1, dt * 12);
        this.height = 0;
    }
  }

  /** 0.1 s of dipping into the jump, so the launch has somewhere to come from. */
  private stepAnticipate(dt: number): void {
    this.timer += dt;
    const t = Math.min(1, this.timer / Math.max(this.anticipation, 1e-3));
    this.crouch = -Math.sin(t * Math.PI * 0.5);
    this.height = 0;
    if (this.timer < this.anticipation) return;
    this.phase = 'air';
    this.grounded = false;
    this.airborne = true;
    this.vel = JUMP_SPEED;
    this.hangLeft = F.hangTime;
  }

  private stepAir(dt: number): void {
    // Apex hang: gravity drops to 0.6x for `hangTime` while the vertical speed
    // is near zero, which is what makes a jump feel floaty at the top and
    // decisive on the way down.
    let g = GRAVITY;
    if (this.hangLeft > 0 && Math.abs(this.vel) < HANG_BAND) {
      g *= F.hangGravity;
      this.hangLeft -= dt;
    }
    this.vel -= g * dt;
    this.height += this.vel * dt;
    // Stretch on the way up, neutral on the way down.
    this.crouch = Math.max(0, Math.min(1, this.vel / JUMP_SPEED));
    if (this.height > 0) return;
    this.height = 0;
    this.phase = 'land';
    this.timer = 0;
    this.grounded = true;
    this.airborne = false;
    this.justLanded = true;
  }

  /** Absorb the landing over 0.15 s instead of stopping dead. */
  private stepLand(dt: number): void {
    this.timer += dt;
    const t = Math.min(1, this.timer / F.landSquashTime);
    // One squash-and-recover arc: down fast, back up over the rest of the window.
    this.crouch = -Math.sin(t * Math.PI) * (1 - t * 0.35);
    this.height = 0;
    if (this.timer >= F.landSquashTime) { this.phase = 'ground'; this.crouch = 0; }
  }
}
