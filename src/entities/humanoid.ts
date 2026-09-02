// Shared anatomical humanoid used by the player and the pedestrian crowd.
//
// Everything here is procedural (plan rule 0.4). The goal is a readable human
// silhouette rather than a photoreal one: correct 7.5-head proportions, tapered
// smooth-shaded limbs, and real elbow/knee joints so the walk cycle bends where
// a person does. Segments are separate meshes hanging off joint pivots, which
// is far cheaper than skinning and instances cleanly for 80 pedestrians.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Standing height in metres. Every landmark below is derived from it. */
export const HEIGHT = 1.8;

export const L = {
  ankleY: 0.09,
  kneeY: 0.50,
  hipY: 0.94,
  waistY: 1.14,
  shoulderY: 1.50,
  chinY: 1.58,
  headY: 1.655, // centre of the skull
  hipHalfX: 0.085,
  shoulderHalfX: 0.205,
  thighLen: 0.44,
  shinLen: 0.41,
  upperArmLen: 0.29,
  forearmLen: 0.26,
};

export interface Palette {
  skin: number;
  hair: number;
  shirt: number;
  trousers: number;
  shoes: number;
}

function colored(geo: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function place(geo: THREE.BufferGeometry, x: number, y: number, z: number, color: number): THREE.BufferGeometry {
  geo.translate(x, y, z);
  return colored(geo, color);
}

/** Tapered limb segment whose TOP sits at the origin, hanging down. */
function limb(rTop: number, rBot: number, len: number, color: number, flatten = 1): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, 12, 1);
  if (flatten !== 1) g.scale(1, 1, flatten);
  return place(g, 0, -len / 2, 0, color);
}

function ball(r: number, color: number, y = 0, squashY = 1, squashZ = 1): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 14, 10);
  g.scale(1, squashY, squashZ);
  return place(g, 0, y, 0, color);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!out) throw new Error('humanoid: geometry merge failed');
  out.computeVertexNormals();
  return out;
}

/**
 * One set of segment geometries. Each is authored so its JOINT is at the local
 * origin, so the caller just parents it to a pivot Group and rotates that.
 */
export interface HumanoidGeometry {
  head: THREE.BufferGeometry;
  torso: THREE.BufferGeometry;
  upperArm: THREE.BufferGeometry;
  forearm: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
  dispose(): void;
}

/** Skull, jaw, nose, ears and a hair cap. Origin at the centre of the head. */
function buildHead(p: Palette): THREE.BufferGeometry {
  const nose = new THREE.ConeGeometry(0.019, 0.05, 8);
  nose.rotateX(Math.PI / 2);
  const earL = new THREE.SphereGeometry(0.02, 8, 6);
  earL.scale(0.5, 1, 1);
  const earR = new THREE.SphereGeometry(0.02, 8, 6);
  earR.scale(0.5, 1, 1);

  const eye = (x: number): THREE.BufferGeometry => {
    const g = new THREE.SphereGeometry(0.016, 8, 6);
    g.scale(1, 0.8, 0.6);
    return place(g, x, 0.012, 0.088, 0x241a14);
  };

  const parts: THREE.BufferGeometry[] = [
    ball(0.105, p.skin, 0, 1.12, 0.98),
    place(new THREE.SphereGeometry(0.082, 12, 8), 0, -0.058, 0.014, p.skin),
    place(nose, 0, -0.024, 0.098, p.skin),
    place(earL, -0.105, -0.005, 0, p.skin),
    place(earR, 0.105, -0.005, 0, p.skin),
    eye(-0.038), eye(0.038),
  ];

  // Hair: a slightly larger half-sphere sitting over the cranium.
  const hair = new THREE.SphereGeometry(0.104, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.62);
  hair.scale(1, 1.12, 1.02);
  parts.push(place(hair, 0, 0.006, -0.006, p.hair));
  return merge(parts);
}

/** Neck, shoulders, chest tapering to the waist, and hips. Origin at the hip. */
function buildTorso(p: Palette): THREE.BufferGeometry {
  const chestH = L.shoulderY - L.waistY;
  const pelvisH = L.waistY - L.hipY + 0.10;

  const chest = new THREE.CylinderGeometry(L.shoulderHalfX * 0.80, 0.138, chestH, 14, 1);
  chest.scale(1, 1, 0.58);
  const pelvis = new THREE.CylinderGeometry(0.138, 0.150, pelvisH, 14, 1);
  pelvis.scale(1, 1, 0.62);

  const parts: THREE.BufferGeometry[] = [
    place(chest, 0, (L.waistY - L.hipY) + chestH / 2, 0, p.shirt),
    place(pelvis, 0, (L.waistY - L.hipY) - pelvisH / 2 + 0.10, 0, p.trousers),
    // Deltoids, so the arms do not spear straight out of a flat cylinder.
    place(new THREE.SphereGeometry(0.055, 12, 8), -L.shoulderHalfX, L.shoulderY - L.hipY - 0.03, 0, p.shirt),
    place(new THREE.SphereGeometry(0.055, 12, 8), L.shoulderHalfX, L.shoulderY - L.hipY - 0.03, 0, p.shirt),
    place(new THREE.CylinderGeometry(0.042, 0.05, 0.10, 10), 0, L.shoulderY - L.hipY + 0.045, 0, p.skin),
  ];
  return merge(parts);
}

export function buildHumanoidGeometry(p: Palette): HumanoidGeometry {
  const shoe = new THREE.BoxGeometry(0.095, 0.075, 0.235);
  shoe.translate(0, 0, 0.05);

  const sleeveLen = L.upperArmLen * 0.45;
  const sleeve = new THREE.CylinderGeometry(0.049, 0.045, sleeveLen, 12, 1);
  const bicep = new THREE.CylinderGeometry(0.045, 0.040, L.upperArmLen - sleeveLen, 12, 1);
  const upperArm = merge([
    ball(0.052, p.shirt, 0),
    place(sleeve, 0, -sleeveLen / 2, 0, p.shirt),
    place(bicep, 0, -sleeveLen - (L.upperArmLen - sleeveLen) / 2, 0, p.skin),
  ]);
  const forearm = merge([
    ball(0.040, p.skin, 0),
    limb(0.038, 0.031, L.forearmLen, p.skin),
    ball(0.042, p.skin, -L.forearmLen - 0.02, 0.85, 0.7),
  ]);
  const shortLen = L.thighLen * 0.58;
  const shortGeo = new THREE.CylinderGeometry(0.082, 0.070, shortLen, 12, 1);
  const bareThigh = new THREE.CylinderGeometry(0.068, 0.062, L.thighLen - shortLen, 12, 1);
  const thigh = merge([
    ball(0.085, p.trousers, 0),
    place(shortGeo, 0, -shortLen / 2, 0, p.trousers),
    place(bareThigh, 0, -shortLen - (L.thighLen - shortLen) / 2, 0, p.skin),
  ]);
  const shin = merge([
    ball(0.061, p.skin, 0),
    limb(0.058, 0.042, L.shinLen, p.skin),
    place(shoe, 0, -L.shinLen - 0.03, 0, p.shoes),
  ]);

  const geo: HumanoidGeometry = {
    head: buildHead(p),
    torso: buildTorso(p),
    upperArm,
    forearm,
    thigh,
    shin,
    dispose(): void {
      for (const g of [geo.head, geo.torso, geo.upperArm, geo.forearm, geo.thigh, geo.shin]) g.dispose();
    },
  };
  return geo;
}

/** Joint angles for one animation frame. Radians. */
export interface Pose {
  hipL: number; hipR: number;
  kneeL: number; kneeR: number;
  shoulderL: number; shoulderR: number;
  elbowL: number; elbowR: number;
  torsoLean: number;
  bob: number;
  /** Sideways pelvis drop on the stance leg, metres. */
  hipDrop: number;
  /** Pelvis twist about Y; the chest counter-rotates by the same amount. */
  pelvisTwist: number;
}

export function emptyPose(): Pose {
  return {
    hipL: 0, hipR: 0, kneeL: 0, kneeR: 0, shoulderL: 0, shoulderR: 0,
    elbowL: 0, elbowR: 0, torsoLean: 0, bob: 0, hipDrop: 0, pelvisTwist: 0,
  };
}

const KEYS: Array<keyof Pose> = [
  'hipL', 'hipR', 'kneeL', 'kneeR', 'shoulderL', 'shoulderR',
  'elbowL', 'elbowR', 'torsoLean', 'bob', 'hipDrop', 'pelvisTwist',
];

export function zeroPose(out: Pose): Pose {
  for (const k of KEYS) out[k] = 0;
  return out;
}

/** Weighted accumulate, so several clips can be crossfaded into one pose. */
export function addPose(out: Pose, src: Pose, w: number): void {
  if (w === 0) return;
  for (const k of KEYS) out[k] += src[k] * w;
}

/**
 * One gait clip. `amp` is the hip swing amplitude in radians, which is what ties
 * the pose to a stride length: foot travel per step is about
 * 2 * (thigh + shin) * sin(amp).
 *
 * Knees only bend backwards and elbows only forwards, which is what stops it
 * looking like a puppet. The pelvis twists and the chest counter-rotates, the
 * hips drop onto the stance leg, and the head bobs at double stride frequency --
 * the four things that read as "a person walking" rather than "legs swinging".
 */
function gait(phase: number, amp: number, lean: number, out: Pose): Pose {
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  const drive = amp / 0.85; // 0 at a stroll, 1 at a sprint

  out.hipL = s * amp;
  out.hipR = -s * amp;
  out.kneeL = Math.max(0, -c * 0.5 - 0.1) * (0.6 + drive) + 0.06;
  out.kneeR = Math.max(0, c * 0.5 - 0.1) * (0.6 + drive) + 0.06;
  out.shoulderL = -s * amp * 0.75;
  out.shoulderR = s * amp * 0.75;
  out.elbowL = 0.25 + Math.max(0, s) * 0.5 * drive;
  out.elbowR = 0.25 + Math.max(0, -s) * 0.5 * drive;
  out.torsoLean = lean;
  // Head bob runs at 2x stride frequency: one dip per footfall, not per cycle.
  out.bob = -Math.abs(Math.cos(phase)) * 0.015 * (0.5 + drive) + 0.015;
  out.hipDrop = -s * 0.02;
  out.pelvisTwist = -s * 0.087; // ~5 degrees
  return out;
}

/** Walking clip: 2.0 m of ground per cycle at CFG.feel.foot.walkStride. */
export function walkPose(phase: number, out: Pose): Pose {
  return gait(phase, 0.6, 0.06, out);
}

/** Running clip: longer stride, more forward lean, tighter elbows. */
export function runPose(phase: number, out: Pose): Pose {
  const p = gait(phase, 0.92, 0.2, out);
  p.elbowL = 0.85 + Math.max(0, Math.sin(phase)) * 0.45;
  p.elbowR = 0.85 + Math.max(0, -Math.sin(phase)) * 0.45;
  return p;
}

/** Relaxed standing pose with a slow breathing bob. */
export function idlePose(t: number, out: Pose): Pose {
  zeroPose(out);
  const b = Math.sin(t * 1.6);
  out.kneeL = 0.04; out.kneeR = 0.04;
  out.shoulderL = 0.06; out.shoulderR = 0.06;
  out.elbowL = 0.18; out.elbowR = 0.18;
  out.bob = b * 0.006;
  return out;
}
