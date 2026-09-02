// Visual shell for one vehicle. The physics writes group.position/rotation.y;
// everything in here is cosmetic (suspension, wheel spin, lights).
//
// Bodies come from the Kenney Car Kit when it loaded and from the procedural
// shapes in vehicleShapes.ts when it did not; the rest of this file does not
// care which. Both paths expose the same wheel pivots and light anchors, so the
// suspension, steering and brake lights below are written once.
import * as THREE from 'three';
import type { VehicleKind } from '../types';
import { CFG } from '../config';
import { Spring, smoothNoise } from '../core/smooth';
import { WHEEL_RADIUS, bake, box, specFor, type Spec } from './vehicleShapes';
import { carModelFor, paintable, type CarModelData } from './carModels';

export { BODY_COLORS, pickBodyColor } from './vehicleShapes';

const V = CFG.feel.vehicle;

export interface MeshFrame {
  dt: number;
  time: number;
  speed: number;
  steer: number;
  /** Outward (centrifugal) lateral acceleration felt by the body, m/s^2. */
  lateralAccel: number;
  longAccel: number;
  braking: boolean;
  sirenActive: boolean;
}

/** Where the head and tail lights sit, in the body's own space. */
interface Lights {
  head: { x: number; y: number; z: number };
  tail: { x: number; y: number; z: number };
}

/** Wheel pivot, radius and light anchors, however the body was built. */
interface Chassis {
  bodyGeo: THREE.BufferGeometry;
  bodyMaterial: THREE.Material;
  /** Set the paint colour on a model body; null for the procedural one, whose
   *  colour is baked into its vertices. */
  paint: { value: THREE.Color } | null;
  wheelGeo: THREE.BufferGeometry;
  wheelMaterial: THREE.Material;
  wheelRadius: number;
  wheels: Array<{ x: number; y: number; z: number; front: boolean }>;
  lights: Lights;
  lightBar: boolean;
}

/**
 * Car paint: metalness 0.6 / roughness 0.35 so the environment map reads as a
 * reflection on the panels rather than a flat wash. The player's car gets a
 * clearcoat on top -- it is the one vehicle on screen every second, so it is the
 * only one worth a MeshPhysicalMaterial.
 *
 * The colour is NOT set here: the paint is applied per-vertex by `paintable`, so
 * the glass, tyres and trim baked into the same mesh keep their own colours.
 */
function paintMaterial(hero: boolean): THREE.Material {
  const opts = { vertexColors: true, roughness: 0.35, metalness: 0.6 };
  return hero
    ? new THREE.MeshPhysicalMaterial({ ...opts, clearcoat: 0.85, clearcoatRoughness: 0.12 })
    : new THREE.MeshStandardMaterial(opts);
}

/** Chassis from a loaded kit model. */
function modelChassis(data: CarModelData, kind: VehicleKind, color: number, hero: boolean): Chassis {
  const bodyMaterial = paintMaterial(hero);
  const paint = paintable(bodyMaterial, new THREE.Color(color).convertSRGBToLinear());

  data.body.computeBoundingBox();
  const box3 = data.body.boundingBox ?? new THREE.Box3();
  const halfW = (box3.max.x - box3.min.x) / 2;
  const height = box3.max.y - box3.min.y;
  // Sunk a few centimetres into the panel rather than proud of it: the kit's
  // bumpers are chamfered, and a light box sitting on the bounding plane hangs
  // in the air at the corners.
  const lights: Lights = {
    head: { x: halfW * 0.58, y: box3.min.y + height * 0.40, z: box3.max.z - 0.06 },
    tail: { x: halfW * 0.62, y: box3.min.y + height * 0.44, z: box3.min.z + 0.06 },
  };

  return {
    bodyGeo: data.body,
    bodyMaterial,
    paint,
    wheelGeo: data.wheel,
    wheelMaterial: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }),
    wheelRadius: data.wheelRadius,
    wheels: data.wheels,
    lights,
    lightBar: kind === 'police',
  };
}

/** Chassis from the procedural boxes. */
function proceduralChassis(kind: VehicleKind, color: number, hero: boolean): Chassis {
  const spec: Spec = specFor(kind, color);
  const tyre = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.26, 14);
  tyre.rotateZ(Math.PI / 2);
  const hub = new THREE.CylinderGeometry(0.19, 0.19, 0.28, 10);
  hub.rotateZ(Math.PI / 2);

  const bodyMaterial = hero
    ? new THREE.MeshPhysicalMaterial({
      vertexColors: true, roughness: 0.35, metalness: 0.6, clearcoat: 0.85, clearcoatRoughness: 0.12,
    })
    : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.12 });

  return {
    bodyGeo: bake(spec.parts),
    bodyMaterial,
    paint: null,
    wheelGeo: bake([{ geo: tyre, color: 0x1c1c1f }, { geo: hub, color: 0x9aa0a6 }]),
    wheelMaterial: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }),
    wheelRadius: WHEEL_RADIUS,
    wheels: [0, 1, 2, 3].map((i) => ({
      x: i % 2 === 0 ? -spec.trackX : spec.trackX,
      y: WHEEL_RADIUS,
      z: i < 2 ? spec.axleZ : -spec.axleZ,
      front: i < 2,
    })),
    lights: { head: spec.head, tail: spec.tail },
    lightBar: spec.lightBar,
  };
}

export class VehicleMesh {
  readonly group = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly yaws: THREE.Group[] = [];
  /** Authored axle height per wheel; the wobble is added on top of this. */
  private readonly axleY: number[] = [];
  private readonly spins: THREE.Group[] = [];
  private readonly tailMat: THREE.MeshStandardMaterial;
  private readonly barMats: THREE.MeshStandardMaterial[] = [];
  private readonly owned: Array<{ dispose(): void }> = [];
  private readonly wheelRadius: number;
  /** How many of the leading wheel groups steer. */
  private readonly steerCount: number;
  /**
   * Cosmetic suspension (feel pass 1.4): three critically-ish damped springs fed
   * by the accelerations the physics already computes. Heave is the body
   * squatting and diving on its springs; pitch and roll are what the driver
   * actually reads as weight transfer.
   */
  private readonly heave = new Spring(V.suspensionStiffness, V.suspensionDamping);
  private readonly pitchSpring = new Spring(V.suspensionStiffness, V.suspensionDamping);
  private readonly rollSpring = new Spring(V.suspensionStiffness, V.suspensionDamping);
  private spin = 0;
  private wobbleClock = 0;

  constructor(kind: VehicleKind, bodyColor: number, hero = false) {
    const data = carModelFor(kind);
    const chassis = data
      ? modelChassis(data, kind, bodyColor, hero)
      : proceduralChassis(kind, bodyColor, hero);

    this.wheelRadius = chassis.wheelRadius;
    this.group.add(this.body);

    const shell = new THREE.Mesh(chassis.bodyGeo, this.own(chassis.bodyMaterial));
    shell.castShadow = true;
    shell.receiveShadow = true;
    this.body.add(shell);
    // The kit geometry is shared between every car of this kind, so only the
    // procedural one is this mesh's to dispose.
    if (!data) this.owned.push(chassis.bodyGeo);

    // Head and tail lights: one merged emissive mesh each, kept from the
    // procedural build because the kit has no separate light meshes to drive.
    const headMat = this.own(new THREE.MeshStandardMaterial({
      color: 0xfff3d2, emissive: 0xfff0c8, emissiveIntensity: 1.4, roughness: 0.3,
    }));
    const h = chassis.lights.head;
    const headGeo = bake([
      box(0.34, 0.14, 0.08, 0xffffff, -h.x, h.y, h.z),
      box(0.34, 0.14, 0.08, 0xffffff, h.x, h.y, h.z),
    ]);
    this.owned.push(headGeo);
    this.body.add(new THREE.Mesh(headGeo, headMat));

    this.tailMat = this.own(new THREE.MeshStandardMaterial({
      color: 0xc01818, emissive: 0xff2a1a, emissiveIntensity: 1.0, roughness: 0.35,
    }));
    const t = chassis.lights.tail;
    const tailGeo = bake([
      box(0.30, 0.12, 0.07, 0xffffff, -t.x, t.y, t.z),
      box(0.30, 0.12, 0.07, 0xffffff, t.x, t.y, t.z),
    ]);
    this.owned.push(tailGeo);
    this.body.add(new THREE.Mesh(tailGeo, this.tailMat));

    if (chassis.lightBar) {
      const barY = (chassis.bodyGeo.boundingBox?.max.y ?? 1.5) + 0.09;
      for (const [x, col] of [[-0.24, 0xff2418], [0.24, 0x2a5cff]] as const) {
        const mat = this.own(new THREE.MeshStandardMaterial({
          color: col, emissive: col, emissiveIntensity: 2, roughness: 0.4,
        }));
        const geo = new THREE.BoxGeometry(0.40, 0.16, 0.26);
        this.owned.push(geo);
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, barY, 0.10);
        this.body.add(m);
        this.barMats.push(mat);
      }
    }

    // Wheels: yaw group (steering) -> spin group (axle) -> tyre.
    const wheelMat = this.own(chassis.wheelMaterial);
    if (!data) this.owned.push(chassis.wheelGeo);
    // Front wheels first, so the steering loop in update() stays index-based
    // whichever order the model happened to list its wheel nodes in.
    const slots = [...chassis.wheels].sort((a, b) => Number(b.front) - Number(a.front));
    for (const slot of slots) {
      const yaw = new THREE.Group();
      yaw.position.set(slot.x, slot.y, slot.z);
      const spin = new THREE.Group();
      const wheel = new THREE.Mesh(chassis.wheelGeo, wheelMat);
      wheel.castShadow = true;
      spin.add(wheel);
      yaw.add(spin);
      this.group.add(yaw);
      this.yaws.push(yaw);
      this.spins.push(spin);
      this.axleY.push(slot.y);
    }
    this.steerCount = slots.filter((w) => w.front).length;
  }

  private own<T extends { dispose(): void }>(x: T): T { this.owned.push(x); return x; }

  update(f: MeshFrame): void {
    // The raw accelerations are clamped first: at 25 m/s a hard turn peaks near
    // 70 m/s^2, which would roll the body 80 degrees.
    // DECISION: clamp to a believable 1.5 g / 2 g.
    const lat = THREE.MathUtils.clamp(f.lateralAccel, -15, 15);
    const lon = THREE.MathUtils.clamp(f.longAccel, -20, 20);
    const dt = Math.min(f.dt, 0.05);

    // Springs, not lerps: a lerp toward a target can only ever ease in, so the
    // body never overshoots and never settles -- which is exactly what makes
    // arcade cars feel like they are sliding on a plate. These oscillate once
    // and settle, the way a real body on springs does.
    this.body.position.y = this.heave.step(-lon * V.heaveScale * V.suspensionStiffness, dt);
    this.body.rotation.x = this.pitchSpring.step(-lon * V.pitchScale * V.suspensionStiffness, dt);
    this.body.rotation.z = this.rollSpring.step(-lat * V.rollScale * V.suspensionStiffness, dt);

    this.spin += (f.speed * f.dt) / this.wheelRadius;
    // Each wheel gets its own noise line, so kerbs and rough asphalt make them
    // patter independently instead of moving as one rigid axle.
    this.wobbleClock += dt * V.wheelWobbleRate;
    const rough = Math.min(1, Math.abs(f.speed) / 12);
    for (let i = 0; i < this.yaws.length; i++) {
      this.spins[i].rotation.x = this.spin;
      this.yaws[i].position.y = this.axleY[i]
        + smoothNoise(this.wobbleClock, 10 + i) * V.wheelWobble * rough;
      if (i < this.steerCount) this.yaws[i].rotation.y = f.steer;
    }

    this.tailMat.emissiveIntensity = f.braking ? 3.2 : 0.9;
    if (this.barMats.length === 2) {
      // Alternating red/blue at 4 Hz.
      const on = f.sirenActive && Math.floor(f.time * 4) % 2 === 0;
      this.barMats[0].emissiveIntensity = f.sirenActive ? (on ? 4 : 0.15) : 0.1;
      this.barMats[1].emissiveIntensity = f.sirenActive ? (on ? 0.15 : 4) : 0.1;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const o of this.owned) o.dispose();
    this.owned.length = 0;
  }
}
