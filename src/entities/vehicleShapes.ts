// Procedural vehicle bodies, built from boxes and cylinders only.
//
// This is the documented fallback for the Kenney Car Kit (see ASSETS.md): if the
// models are missing, every car in the world still has a body, wheels and lights
// and the game plays identically. It is also where the light anchors, the wheel
// radius and the body colours live, which the model path reads too.
import * as THREE from 'three';
import type { VehicleKind } from '../types';

/** 10 saturated body colours plus black, white and silver (plan section 4). */
export const BODY_COLORS: readonly number[] = [
  0xe23b2e, 0xf2761b, 0xf5c518, 0x54b948, 0x1fb3a6, 0x2f7fe0, 0x6b46d6,
  0xe0479e, 0xa8e02f, 0x0f5f8f, 0x16181c, 0xf1f1ee, 0xb9bdc3,
];
const GLASS = 0x1d232c;
const TRIM = 0x1a1a1d;
export const WHEEL_RADIUS = 0.35;

export function pickBodyColor(kind: VehicleKind, idx: number): number {
  if (kind === 'police') return 0xf3f3f0;
  return BODY_COLORS[((idx % BODY_COLORS.length) + BODY_COLORS.length) % BODY_COLORS.length];
}

export interface Part { geo: THREE.BufferGeometry; color: number; x?: number; y?: number; z?: number }

export function box(w: number, h: number, d: number, color: number, x: number, y: number, z: number): Part {
  return { geo: new THREE.BoxGeometry(w, h, d), color, x, y, z };
}

/** Bake parts into one non-indexed vertex-coloured geometry. */
export function bake(parts: Part[]): THREE.BufferGeometry {
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

export interface Spec {
  parts: Part[];
  head: { y: number; z: number; x: number };
  tail: { y: number; z: number; x: number };
  axleZ: number;
  trackX: number;
  lightBar: boolean;
}

export function specFor(kind: VehicleKind, body: number): Spec {
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

