// Low-poly vehicle bodies, built from boxes and cylinders only (plan 0.4/4).
// All static body boxes are merged into one vertex-coloured geometry so a car is
// ~7 draw calls: body, headlights, tail lights, 4 wheels (+2 for the light bar).
import * as THREE from 'three';
import type { VehicleKind } from '../types';

/** 10 saturated body colours plus black, white and silver (plan section 4). */
export const BODY_COLORS: readonly number[] = [
  0xe23b2e, 0xf2761b, 0xf5c518, 0x54b948, 0x1fb3a6, 0x2f7fe0, 0x6b46d6,
  0xe0479e, 0xa8e02f, 0x0f5f8f, 0x16181c, 0xf1f1ee, 0xb9bdc3,
];
const GLASS = 0x1d232c;
const TRIM = 0x1a1a1d;
const WHEEL_RADIUS = 0.35;

export function pickBodyColor(kind: VehicleKind, idx: number): number {
  if (kind === 'police') return 0xf3f3f0;
  return BODY_COLORS[((idx % BODY_COLORS.length) + BODY_COLORS.length) % BODY_COLORS.length];
}

interface Part { geo: THREE.BufferGeometry; color: number; x?: number; y?: number; z?: number }

function box(w: number, h: number, d: number, color: number, x: number, y: number, z: number): Part {
  return { geo: new THREE.BoxGeometry(w, h, d), color, x, y, z };
}

/** Bake parts into one non-indexed vertex-coloured geometry. */
function bake(parts: Part[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], col: number[] = [];
  const c = new THREE.Color();
  const m = new THREE.Matrix4();
  for (const p of parts) {
    const g = p.geo.toNonIndexed();
    m.identity().setPosition(p.x ?? 0, p.y ?? 0, p.z ?? 0);
    g.applyMatrix4(m);
    const pa = g.getAttribute('position'), na = g.getAttribute('normal');
    c.set(p.color).convertSRGBToLinear();
    for (let i = 0; i < pa.count; i++) {
      pos.push(pa.getX(i), pa.getY(i), pa.getZ(i));
      nor.push(na.getX(i), na.getY(i), na.getZ(i));
      col.push(c.r, c.g, c.b);
    }
    g.dispose();
    p.geo.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

interface Spec {
  parts: Part[];
  head: { y: number; z: number; x: number };
  tail: { y: number; z: number; x: number };
  axleZ: number;
  trackX: number;
  lightBar: boolean;
}

function specFor(kind: VehicleKind, body: number): Spec {
  const P: Part[] = [];
  const common: Spec = {
    parts: P,
    head: { x: 0.62, y: 0.74, z: 2.08 },
    tail: { x: 0.66, y: 0.80, z: -2.08 },
    axleZ: 1.4, trackX: 0.96, lightBar: false,
  };

  if (kind === 'sports') {
    P.push(box(1.95, 0.50, 4.40, body, 0, 0.52, 0));
    P.push(box(1.88, 0.22, 4.10, TRIM, 0, 0.30, 0));
    P.push(box(1.62, 0.44, 2.46, body, 0, 0.97, -0.20));
    P.push(box(1.66, 0.22, 1.90, GLASS, 0, 0.98, -0.20));  // side windows
    P.push(box(1.44, 0.22, 2.50, GLASS, 0, 0.98, -0.20));  // screen + rear glass
    P.push(box(1.84, 0.18, 0.14, TRIM, 0, 0.36, 2.20));
    P.push(box(1.84, 0.18, 0.14, TRIM, 0, 0.36, -2.20));
    P.push(box(1.50, 0.07, 0.34, TRIM, 0, 1.08, -2.00));
    P.push(box(0.10, 0.26, 0.10, TRIM, -0.60, 0.94, -1.96));
    P.push(box(0.10, 0.26, 0.10, TRIM, 0.60, 0.94, -1.96));
    common.head = { x: 0.62, y: 0.62, z: 2.18 };
    common.tail = { x: 0.68, y: 0.64, z: -2.18 };
    common.axleZ = 1.45; common.trackX = 0.99;
    return common;
  }

  if (kind === 'pickup') {
    P.push(box(2.00, 0.52, 4.60, body, 0, 0.74, 0));
    P.push(box(1.90, 0.26, 4.30, TRIM, 0, 0.44, 0));
    P.push(box(1.86, 0.80, 1.60, body, 0, 1.32, 0.55));
    P.push(box(1.90, 0.34, 1.20, GLASS, 0, 1.46, 0.55));
    P.push(box(1.60, 0.34, 1.64, GLASS, 0, 1.46, 0.55));
    P.push(box(1.92, 0.20, 0.14, TRIM, 0, 0.60, 2.30));
    P.push(box(1.92, 0.20, 0.14, TRIM, 0, 0.60, -2.30));
    P.push(box(1.90, 0.10, 1.90, TRIM, 0, 1.03, -1.25));
    P.push(box(0.12, 0.44, 1.90, body, -0.90, 1.22, -1.25));
    P.push(box(0.12, 0.44, 1.90, body, 0.90, 1.22, -1.25));
    P.push(box(1.90, 0.44, 0.12, body, 0, 1.22, -2.18));
    common.head = { x: 0.66, y: 0.88, z: 2.28 };
    common.tail = { x: 0.70, y: 0.98, z: -2.26 };
    common.axleZ = 1.5; common.trackX = 1.0;
    return common;
  }

  // sedan and police share the saloon shell.
  P.push(box(1.90, 0.62, 4.20, body, 0, 0.60, 0));
  P.push(box(1.82, 0.22, 3.90, TRIM, 0, 0.34, 0));
  P.push(box(1.68, 0.56, 2.06, body, 0, 1.18, -0.15));
  P.push(box(1.72, 0.26, 1.62, GLASS, 0, 1.22, -0.15));   // side windows
  P.push(box(1.50, 0.26, 2.10, GLASS, 0, 1.22, -0.15));   // screen + rear glass
  P.push(box(1.82, 0.20, 0.14, TRIM, 0, 0.44, 2.12));
  P.push(box(1.82, 0.20, 0.14, TRIM, 0, 0.44, -2.12));
  if (kind === 'police') {
    P.push(box(1.74, 0.06, 1.50, 0x121215, 0, 0.92, 1.15));   // black bonnet
    P.push(box(0.06, 0.42, 1.90, 0x121215, -0.958, 0.62, -0.1)); // black doors
    P.push(box(0.06, 0.42, 1.90, 0x121215, 0.958, 0.62, -0.1));
    P.push(box(0.94, 0.08, 0.30, 0x121215, 0, 1.55, 0.10));    // light bar base
    common.lightBar = true;
  }
  return common;
}

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

/**
 * Visual shell for one vehicle. The physics writes `group.position/rotation.y`;
 * everything here is cosmetic (roll, pitch, wheel spin, lights).
 */
export class VehicleMesh {
  readonly group = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly yaws: THREE.Group[] = [];
  private readonly spins: THREE.Group[] = [];
  private readonly tailMat: THREE.MeshStandardMaterial;
  private readonly barMats: THREE.MeshStandardMaterial[] = [];
  private readonly owned: Array<{ dispose(): void }> = [];
  private roll = 0;
  private pitch = 0;
  private spin = 0;

  constructor(kind: VehicleKind, bodyColor: number) {
    const spec = specFor(kind, bodyColor);
    this.group.add(this.body);

    const shell = new THREE.Mesh(
      bake(spec.parts),
      this.own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.12 })),
    );
    shell.castShadow = true;
    shell.receiveShadow = true;
    this.body.add(shell);
    this.owned.push(shell.geometry);

    // Head and tail lights: one merged emissive mesh each.
    const headMat = this.own(new THREE.MeshStandardMaterial({
      color: 0xfff3d2, emissive: 0xfff0c8, emissiveIntensity: 1.4, roughness: 0.3,
    }));
    const h = spec.head;
    const headGeo = bake([
      box(0.34, 0.14, 0.08, 0xffffff, -h.x, h.y, h.z),
      box(0.34, 0.14, 0.08, 0xffffff, h.x, h.y, h.z),
    ]);
    this.owned.push(headGeo);
    this.body.add(new THREE.Mesh(headGeo, headMat));

    this.tailMat = this.own(new THREE.MeshStandardMaterial({
      color: 0xc01818, emissive: 0xff2a1a, emissiveIntensity: 1.0, roughness: 0.35,
    }));
    const t = spec.tail;
    const tailGeo = bake([
      box(0.30, 0.12, 0.07, 0xffffff, -t.x, t.y, t.z),
      box(0.30, 0.12, 0.07, 0xffffff, t.x, t.y, t.z),
    ]);
    this.owned.push(tailGeo);
    this.body.add(new THREE.Mesh(tailGeo, this.tailMat));

    if (spec.lightBar) {
      for (const [x, col] of [[-0.24, 0xff2418], [0.24, 0x2a5cff]] as const) {
        const mat = this.own(new THREE.MeshStandardMaterial({
          color: col, emissive: col, emissiveIntensity: 2, roughness: 0.4,
        }));
        const geo = new THREE.BoxGeometry(0.40, 0.16, 0.26);
        this.owned.push(geo);
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, 1.60, 0.10);
        this.body.add(m);
        this.barMats.push(mat);
      }
    }

    // Wheels: yaw group (steering) -> spin group (axle) -> tyre + hub.
    const tyre = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.26, 14);
    tyre.rotateZ(Math.PI / 2);
    const hub = new THREE.CylinderGeometry(0.19, 0.19, 0.28, 10);
    hub.rotateZ(Math.PI / 2);
    const wheelGeo = bake([
      { geo: tyre, color: 0x1c1c1f },
      { geo: hub, color: 0x9aa0a6 },
    ]);
    this.owned.push(wheelGeo);
    const wheelMat = this.own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const yaw = new THREE.Group();
      yaw.position.set(i % 2 === 0 ? -spec.trackX : spec.trackX, WHEEL_RADIUS, front ? spec.axleZ : -spec.axleZ);
      const spin = new THREE.Group();
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.castShadow = true;
      spin.add(wheel);
      yaw.add(spin);
      this.group.add(yaw);
      this.yaws.push(yaw);
      this.spins.push(spin);
    }
  }

  private own<T extends { dispose(): void }>(x: T): T { this.owned.push(x); return x; }

  update(f: MeshFrame): void {
    // Damped cosmetic roll and pitch (plan section 4). The raw accelerations are
    // clamped first: at 25 m/s a hard turn peaks near 70 m/s^2, which would roll
    // the body 80 degrees. // DECISION: clamp to a believable 1.5 g / 2 g.
    const lat = THREE.MathUtils.clamp(f.lateralAccel, -15, 15);
    const lon = THREE.MathUtils.clamp(f.longAccel, -20, 20);
    const k = Math.min(1, f.dt * 6);
    this.roll += (-lat * 0.02 - this.roll) * k;
    this.pitch += (-lon * 0.01 - this.pitch) * k;
    this.body.rotation.z = this.roll;
    this.body.rotation.x = this.pitch;

    this.spin += (f.speed * f.dt) / WHEEL_RADIUS;
    for (let i = 0; i < 4; i++) {
      this.spins[i].rotation.x = this.spin;
      if (i < 2) this.yaws[i].rotation.y = f.steer;
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
