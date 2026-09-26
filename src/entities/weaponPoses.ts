// Hold and aim poses for the SMG, the sniper and the RPG, synthesised.
//
// No clips were supplied for them, so each is authored here as a set of
// per-bone rotations on top of a base frame -- the two-handed rifle hold from
// Gunplay for the guns, the pistol grip for the tube -- and written out as a
// real AnimationClip the overlay machinery plays like any downloaded pose. A
// slow three-second sway on the spine and the leading arm keeps a held pose
// from freezing solid.
//
// The numbers are degrees about each bone's own local axes, tuned against
// screenshots (smoke/weaponPoses.spec.ts). They are not derived from anything;
// they are what looked right for a character read from two metres behind the
// shoulder.
import * as THREE from 'three';
import type { ClipInfo } from '../core/character';

/** Degrees about the bone's local X, Y, Z, applied after the base pose. */
type Euler3 = [number, number, number];

export interface PoseSpec {
  /** Clip whose first frame is the starting point; the first that exists wins. */
  base: string[];
  bones: Record<string, Euler3>;
  /** Sway amplitude in degrees; 0 for a pose that has to hold dead still. */
  sway: number;
}

export const WEAPON_POSES: Record<string, PoseSpec> = {
  // Every pose starts from the pistol aim: both arms extended forward, level.
  // Measured axes on this rig: on either arm, +X lowers the limb, +Z swings
  // it across the body, Y twists it; on a forearm, +X bends the elbow so the
  // hand drops (so -X brings the hand back up); Head +X nods; Spine2 +Y turns
  // the torso. The barrel follows the forearm (see fitToHand), so a level
  // forearm is a level gun.

  // SMG at low ready: upper arms down, the gun at the hip pointing forward and
  // down about thirty degrees, left hand forward under the magazine.
  holdMg: {
    base: ['pistolAim', 'rifleFire', 'pistolIdle'],
    bones: {
      RightArm: [55, 0, 0], RightForeArm: [-25, 0, 0],
      LeftArm: [40, 0, 0], LeftForeArm: [-12, 0, 0], Spine2: [3, 0, 0],
    },
    sway: 1.2,
  },
  // SMG shouldered: elbows tucked, the gun level at the chest, cheek down.
  aimMg: {
    base: ['pistolAim', 'rifleFire'],
    bones: {
      RightArm: [45, 0, 0], RightForeArm: [-50, 0, 0],
      LeftArm: [18, 0, 0], LeftForeArm: [-18, 0, 0], Head: [6, 0, 6], Spine2: [0, 4, 0],
    },
    sway: 0.5,
  },
  // Sniper carried: rifle low across the body, muzzle down and a little
  // across, left hand out under the forestock, torso turned a touch.
  holdSniper: {
    base: ['pistolAim', 'rifleFire', 'pistolIdle'],
    bones: {
      RightArm: [50, 0, 0], RightForeArm: [-20, 0, 15],
      LeftArm: [42, 0, 0], LeftForeArm: [-8, 0, 0], Spine2: [2, 6, 0],
    },
    sway: 1.5,
  },
  // Sniper shouldered: right hand back at the shoulder, left arm long along the
  // stock, head down and over onto the scope, torso turned into the line.
  aimSniper: {
    base: ['pistolAim', 'rifleFire'],
    bones: {
      RightArm: [50, 0, 0], RightForeArm: [-55, 0, 0],
      LeftArm: [8, 0, 0], LeftForeArm: [-10, 0, 0], Head: [8, 0, 10], Spine2: [-2, 8, 0],
    },
    sway: 0.3,
  },
  // RPG carried: the tube level at chest height, right hand back at the grip,
  // left hand forward on the handle, leaned back a touch under the weight.
  holdRpg: {
    base: ['pistolAim', 'rifleFire', 'pistolIdle'],
    bones: {
      RightArm: [70, 0, 0], RightForeArm: [-70, 0, 0],
      LeftArm: [30, 0, 0], LeftForeArm: [-25, 0, 0], Spine2: [-5, 0, 0], Head: [-3, 0, 0],
    },
    sway: 1.0,
  },
  // RPG up: the tube raised toward the shoulder, head tipped to the sight.
  aimRpg: {
    base: ['pistolAim', 'rifleFire'],
    bones: {
      RightArm: [40, 0, 0], RightForeArm: [-40, 0, 0],
      LeftArm: [20, 0, 0], LeftForeArm: [-22, 0, 0], Head: [4, 0, 8], Spine2: [0, 4, 0],
    },
    sway: 0.6,
  },
};

/** Which pose set each weapon uses; the pistol keeps its downloaded clips. */
export const WEAPON_POSE_NAMES: Record<string, { hold: string; aim: string }> = {
  pistol: { hold: 'pistolIdle', aim: 'pistolAim' },
  mg: { hold: 'holdMg', aim: 'aimMg' },
  sniper: { hold: 'holdSniper', aim: 'aimSniper' },
  rpg: { hold: 'holdRpg', aim: 'aimRpg' },
};

const DURATION = 3;
const Q = new THREE.Quaternion();
const D = new THREE.Quaternion();
const E = new THREE.Euler();

function boneOf(trackName: string): string {
  // "mixamorigRightArm.quaternion" -> "RightArm"
  return trackName.replace(/\.quaternion$/, '').replace(/^mixamorig\d*:?/, '');
}

/** Build one pose clip from its spec, or null when no base clip exists. */
export function synthesisePose(name: string, spec: PoseSpec, clips: Map<string, THREE.AnimationClip>): THREE.AnimationClip | null {
  const base = spec.base.map((b) => clips.get(b)).find((c) => c !== undefined);
  if (!base) return null;
  const tracks: THREE.KeyframeTrack[] = [];
  const times = [0, DURATION / 2, DURATION];
  for (const track of base.tracks) {
    const stride = track.getValueSize();
    const first = Array.from(track.values.slice(0, stride));
    if (!(track instanceof THREE.QuaternionKeyframeTrack)) {
      tracks.push(new (track.constructor as new (n: string, t: number[], v: number[]) => THREE.KeyframeTrack)(
        track.name, times, first.concat(first, first),
      ));
      continue;
    }
    const bone = boneOf(track.name);
    const delta = spec.bones[bone];
    const keys: number[] = [];
    for (let k = 0; k < times.length; k++) {
      Q.set(first[0], first[1], first[2], first[3]);
      if (delta) {
        E.set(THREE.MathUtils.degToRad(delta[0]), THREE.MathUtils.degToRad(delta[1]), THREE.MathUtils.degToRad(delta[2]));
        D.setFromEuler(E);
        Q.multiply(D);
      }
      // The middle key carries the sway; the ends are the pose itself, so the
      // loop closes without a seam.
      if (k === 1 && spec.sway > 0 && (bone === 'Spine2' || bone === 'LeftArm' || bone === 'Head')) {
        const s = THREE.MathUtils.degToRad(spec.sway) * (bone === 'Head' ? 0.5 : 1);
        E.set(s, 0, bone === 'LeftArm' ? -s * 0.6 : 0);
        Q.multiply(D.setFromEuler(E));
      }
      keys.push(Q.x, Q.y, Q.z, Q.w);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(track.name, times, keys));
  }
  const clip = new THREE.AnimationClip(name, DURATION, tracks);
  return clip;
}

/** Register every weapon pose in the character's clip set. Idempotent. */
export function synthesiseWeaponPoses(
  clips: Map<string, THREE.AnimationClip>, info: Map<string, ClipInfo>, specs: Record<string, PoseSpec> = WEAPON_POSES,
): void {
  for (const [name, spec] of Object.entries(specs)) {
    const clip = synthesisePose(name, spec, clips);
    if (!clip) continue;
    clips.set(name, clip);
    info.set(name, {
      name, role: 'once', duration: DURATION, groundSpeed: 0, inPlace: true, rootYaw: 0, angle: 0, armed: false,
    });
  }
}
