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
import { CFG } from '../config';
import { registerCameraMode, type CameraFrame, type CameraModeName, type CameraSubject } from './cameras';

export const FOOT_CAMERA = 'foot' as unknown as CameraModeName;

const FOOT_DIST = 4;
const FOOT_HEIGHT = 2;
const FOOT_LOOK_AHEAD = 1.4;

/** Register the mode. Idempotent; called from player.ts's module side effect. */
registerCameraMode(FOOT_CAMERA, (s: CameraSubject, f: CameraFrame) => {
  // Third-person over-shoulder: the eye trails the lagged camera-follow
  // heading, the look-at leads with the character's actual facing, so a
  // sidestep reads as a sidestep instead of swinging the whole frame.
  const dir = s.velocityHeading;
  const fx = Math.sin(dir), fz = Math.cos(dir);
  f.eye.set(s.pos.x - fx * FOOT_DIST, s.y + FOOT_HEIGHT, s.pos.z - fz * FOOT_DIST);
  const bx = Math.sin(s.heading), bz = Math.cos(s.heading);
  f.look.set(s.pos.x + bx * FOOT_LOOK_AHEAD, s.y + 1.5, s.pos.z + bz * FOOT_LOOK_AHEAD);
  f.fov = CFG.camera.fovBase;
  f.posSmooth = CFG.feel.camera.footPos;
  f.lookSmooth = CFG.feel.camera.footLook;
});
