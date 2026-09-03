// Turning one pedestrian's state into a pose for the instanced mesh pool.
//
// Split out of pedestrians.ts, which is otherwise entirely navigation: this is
// the only part of that file that knows about quaternions and limb angles, and
// keeping it here leaves the wander/cross/flee state machine readable.
import * as THREE from 'three';
import { CFG } from '../config';
import type { PedMeshPool } from './pedMesh';

const K = CFG.combat.knockdown;
/**
 * How long the get-up takes when there is no clip to measure. Matches the
 * fallback stepDown() uses for exactly the same reason: the instanced pool has
 * no animation to ask.
 */
const GETUP_SECONDS = 2 / K.getUpRate;

/** Tumble timings, shared with the pedestrian state machine. */
export const TUMBLE_TOSS = 0.9;   // rise + spin + land, combined into one arc
export const TUMBLE_LIE = 2.0;    // lie flat afterwards
export const TUMBLE_GETUP = 0.3;

const M_BASE = new THREE.Matrix4();
const V_POS = new THREE.Vector3();
const V_SCALE = new THREE.Vector3(1, 1, 1);
const Q_YAW = new THREE.Quaternion();
const Q_TUMBLE = new THREE.Quaternion();
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);

/** Everything posing a pedestrian needs to know about it. */
export interface PosablePed {
  variant: number;
  slot: number;
  scale: number;
  pos: { x: number; z: number };
  y: number;
  heading: number;
  speed: number;
  phase: number;
  mode: 'wander' | 'cross' | 'flee' | 'tumble' | 'down' | 'return' | 'idle' | 'wait' | 'ride';
  /** Their own walking pace, so the gait can be scaled to the speed actually made. */
  walkSpeed?: number;
  /** Heading change this frame, rad/s, for the turn clip. */
  turnRate?: number;
  /** Which fall clip a knocked-down pedestrian is playing, and how (section 8). */
  fallClip: string | null;
  /** Negative once they are getting back up, which plays the fall backwards. */
  fallRate: number;
  /** Seconds since the knockdown began, which is what times the get-up. */
  downT: number;
  tumbleT: number;
  tumbleAxis: THREE.Vector3;
}

/**
 * The body rotation for a tumbling pedestrian: a spin, a flat lie, and an arc
 * back up onto its feet. Returns false when `p` is not tumbling, in which case
 * `out` is left alone.
 *
 * Shared with the skinned crowd (pedSkinned.ts), which throws the whole rig
 * with this while its animation holds still.
 */
export function tumbleQuat(p: PosablePed, out: THREE.Quaternion): boolean {
  if (p.mode !== 'tumble') return false;
  const lieEnd = TUMBLE_TOSS + TUMBLE_LIE;
  if (p.tumbleT <= TUMBLE_TOSS) {
    out.setFromAxisAngle(p.tumbleAxis, (p.tumbleT / TUMBLE_TOSS) * Math.PI * 2);
  } else if (p.tumbleT <= lieEnd) {
    out.setFromAxisAngle(AXIS_X, Math.PI / 2); // lying flat
  } else {
    const u = 1 - Math.min(1, (p.tumbleT - lieEnd) / TUMBLE_GETUP);
    out.setFromAxisAngle(AXIS_X, (Math.PI / 2) * u); // getting up
  }
  return true;
}

/**
 * The body rotation for a knocked-down pedestrian: flat on the ground, then
 * arcing back upright as they get up. Returns false when `p` is not down.
 *
 * The skinned crowd plays a real fall clip for this and never calls it. The
 * instanced pool has no animation at all, so it gets the same 90 degree lie the
 * tumble uses -- which is the whole point: without it a body drawn by the
 * instanced pool stands bolt upright through the entire knockdown, and pops
 * between lying and standing as the skinned slot pool churns around the player.
 */
export function downQuat(p: PosablePed, out: THREE.Quaternion): boolean {
  if (p.mode !== 'down') return false;
  // fallRate goes negative the moment the get-up starts; before that they are
  // simply lying there, however long that is.
  const rising = p.fallRate < 0
    ? Math.min(1, Math.max(0, (p.downT - K.downSeconds) / GETUP_SECONDS))
    : 0;
  out.setFromAxisAngle(AXIS_X, (Math.PI / 2) * (1 - rising));
  return true;
}

/**
 * The body rotation for a pedestrian who is not on their feet -- mid-tumble or
 * knocked down. Returns false when they are upright, in which case `out` is
 * left alone and the caller should use the ordinary facing.
 *
 * Every path that draws a pedestrian WITHOUT animation goes through this, and
 * there are two: the far-LOD static instances in pedSkinned.ts and the fully
 * procedural pool in pedRenderer.ts. Having one helper is the point. The bug
 * this replaces was each of them growing its own idea of which modes are
 * horizontal, and both forgetting the knockdown -- so a body drawn by either
 * stood bolt upright, and popped between lying and standing as the skinned slot
 * pool churned around the player.
 *
 * The near-skinned path deliberately does NOT use this: it has a real fall clip
 * and poses itself.
 */
export function bodyQuat(p: PosablePed, out: THREE.Quaternion): boolean {
  return tumbleQuat(p, out) || downQuat(p, out);
}

/**
 * Advance `p`'s gait phase and write its pose into the pool.
 *
 * Walking and fleeing are the same curve at different amplitude and frequency;
 * a tumble replaces the facing quaternion entirely with a spin, a flat lie and a
 * get-up arc.
 */
export function posePed(pool: PedMeshPool, p: PosablePed, dt: number): void {
  p.phase += dt;
  let legSwing = 0, armSwing = 0, armsUp = false;
  let quat = Q_YAW;

  if (bodyQuat(p, Q_TUMBLE)) {
    quat = Q_TUMBLE;
  } else {
    Q_YAW.setFromAxisAngle(AXIS_Y, p.heading);
    if (p.speed > 0.05) {
      // The gait follows the speed actually made: a stroll swings slowly and
      // a run fast, and someone easing to a stop slows their stride first.
      const fleeing = p.mode === 'flee';
      const pace = p.speed / (p.walkSpeed ?? 1.4);
      const amp = fleeing ? 0.75 : Math.min(0.55, 0.45 * pace);
      const freq = fleeing ? 7.5 : 4.2 * pace;
      legSwing = Math.sin(p.phase * freq) * amp;
      armSwing = legSwing;
    }
    armsUp = p.mode === 'flee';
  }

  // The scale is per-pedestrian and fixed for its lifetime (2.2), so a short
  // pedestrian has short legs and a short stride rather than being a shrunken
  // adult floating above the pavement.
  M_BASE.compose(V_POS.set(p.pos.x, p.y, p.pos.z), quat, V_SCALE.setScalar(p.scale));
  pool.setPose(p.variant, p.slot, M_BASE, legSwing, armSwing, armsUp);
}
