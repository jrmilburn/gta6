// The dance camera: one slow circuit around the player (integration pass, 4).
//
// `orbit` is already a name in CameraModeName; this is the implementation.
// The angle is driven from outside -- entities/dance.ts advances it so exactly
// one revolution lands in exactly the eight seconds the dance lasts -- because
// a camera that owns its own clock and a dance that owns its own clock will
// drift apart on the one frame that matters.
import { CFG } from '../config';
import { registerCameraMode, type CameraFrame, type CameraSubject } from './cameras';

const C = CFG.feel.camera;

export const ORBIT = {
  /** Radians around the subject; 0 puts the camera in front of them. */
  angle: 0,
  distance: 4.5,
  height: 1.4,
};

registerCameraMode('orbit', (s: CameraSubject, f: CameraFrame) => {
  f.eye.set(
    s.pos.x + Math.sin(ORBIT.angle) * ORBIT.distance,
    s.y + ORBIT.height,
    s.pos.z + Math.cos(ORBIT.angle) * ORBIT.distance,
  );
  // Aimed at the chest from below it: the eye sits at 1.4 m and looks at 1.5 m,
  // so the character is very slightly up-shot and reads as taller than the
  // camera, which is what the brief's "slightly low angle" buys.
  f.look.set(s.pos.x, s.y + 1.5, s.pos.z);
  f.fov = CFG.camera.fovBase;
  f.posSmooth = C.footPos;
  f.lookSmooth = C.footLook;
  f.occlude = true;
});
