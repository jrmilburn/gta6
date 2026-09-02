// Turning one pedestrian's state into a pose for the instanced mesh pool.
//
// Split out of pedestrians.ts, which is otherwise entirely navigation: this is
// the only part of that file that knows about quaternions and limb angles, and
// keeping it here leaves the wander/cross/flee state machine readable.
import * as THREE from 'three';
import type { PedMeshPool } from './pedMesh';

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
  mode: 'wander' | 'cross' | 'flee' | 'tumble';
  tumbleT: number;
  tumbleAxis: THREE.Vector3;
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

  if (p.mode === 'tumble') {
    const lieEnd = TUMBLE_TOSS + TUMBLE_LIE;
    if (p.tumbleT <= TUMBLE_TOSS) {
      Q_TUMBLE.setFromAxisAngle(p.tumbleAxis, (p.tumbleT / TUMBLE_TOSS) * Math.PI * 2);
    } else if (p.tumbleT <= lieEnd) {
      Q_TUMBLE.setFromAxisAngle(AXIS_X, Math.PI / 2); // lying flat
    } else {
      const u = 1 - Math.min(1, (p.tumbleT - lieEnd) / TUMBLE_GETUP);
      Q_TUMBLE.setFromAxisAngle(AXIS_X, (Math.PI / 2) * u); // getting up
    }
    quat = Q_TUMBLE;
  } else {
    Q_YAW.setFromAxisAngle(AXIS_Y, p.heading);
    if (p.speed > 0.05) {
      const fleeing = p.mode === 'flee';
      const amp = fleeing ? 0.75 : 0.45, freq = fleeing ? 7.5 : 4.2;
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
