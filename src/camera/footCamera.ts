// The on-foot camera mode, registered into the rig's mode registry.
//
// DECISION: CameraModeName is a closed union owned by camera/cameras.ts, so a
// new mode name cannot be added to that type from outside it. The mode is
// registered through the existing `registerCameraMode` API instead, and the
// name is cast through the closed union rather than edited into it.
//
// This lives next to the rig rather than in player.ts because it is a camera,
// not a controller -- and because player.ts has no business importing the mode
// registry just to describe where a camera should stand.
//
// Since section 3 it is a true orbit: the eye sits on a sphere around the
// character at the mouse's yaw and pitch, and the same yaw is what the movement
// keys are measured against, so "forward" is always away from the camera.
import * as THREE from 'three';
import { CFG } from '../config';
import { registerCameraMode, type CameraFrame, type CameraModeName, type CameraSubject } from './cameras';

export const FOOT_CAMERA = 'foot' as unknown as CameraModeName;

const FOOT_DIST = 4;
/** Height of the point the camera orbits and looks at: roughly the chest. */
const FOCUS_HEIGHT = 1.4;
const FOOT_LOOK_AHEAD = 0.6;

/**
 * Over-the-shoulder aim framing (section 7), or null when not aiming.
 *
 * Set from combat.ts. It lives here rather than in a fourth camera mode because
 * aiming is the same orbit at a different radius -- registering a mode for it
 * would duplicate the pitch handling and then have to blend between the two.
 */
export const AIM = {
  /** 0 hip-fire, 1 fully aimed. combat.ts eases this. */
  amount: 0,
};

/** Register the mode. Idempotent; called from session.ts's module side effect. */
registerCameraMode(FOOT_CAMERA, (s: CameraSubject, f: CameraFrame) => {
  const P = CFG.combat.pistol;
  const t = THREE.MathUtils.clamp(AIM.amount, 0, 1);
  const dist = THREE.MathUtils.lerp(FOOT_DIST, P.aimDistance, t);
  const height = THREE.MathUtils.lerp(FOCUS_HEIGHT, P.aimHeight, t);
  const shoulder = P.aimShoulder * t;

  const yaw = f.lookYaw;
  const pitch = f.lookPitch;
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  // Screen-right, for the over-the-shoulder offset.
  const rx = -fz, rz = fx;

  // Orbit: back along the look yaw, lifted by the pitch. Cosine keeps the eye
  // at a constant distance as it rises, so looking up does not also zoom out.
  const flat = Math.cos(pitch) * dist;
  const rise = Math.sin(pitch) * dist;
  const cx = s.pos.x + rx * shoulder;
  const cz = s.pos.z + rz * shoulder;
  f.eye.set(cx - fx * flat, s.y + height + rise, cz - fz * flat);
  // Look slightly ahead of the focus point along the same yaw, so the character
  // sits low in frame and the street ahead of them is what fills it.
  f.look.set(cx + fx * FOOT_LOOK_AHEAD, s.y + height - rise * 0.25, cz + fz * FOOT_LOOK_AHEAD);
  f.fov = THREE.MathUtils.lerp(CFG.camera.fovBase, P.aimFov, t);
  f.posSmooth = CFG.feel.camera.footPos;
  // The look target follows the mouse on a much shorter time than the eye
  // does, so the aim feels attached to the hand while the body still swings.
  f.lookSmooth = CFG.feel.mouse.lookSmooth;
});
