// The pier: a timber deck off the boardwalk at the spawn, 150 m out over the
// water, with railings, lamps, kiosks, benches, a row of bollards at the
// entrance and a ferris wheel near the end. The shape is Del Perro's; the
// materials are the boardwalk's own planks so the two read as one structure.
//
// Everything static is built here. gameplay/pier.ts owns what the player can
// do with it (ride, sit, lean, dive) and drives the two things that move: the
// wheel, and a bollard once a car has hit it.
import * as THREE from 'three';
import type { Assets } from '../core/assets';
import { getTextures } from '../core/textures';
import type { Vec2 } from '../types';
import { NEON_COLORS, PIER, PIER_KIOSKS, PIER_LAMP_SPACING, PIER_WHEEL, type CityLayout } from './cityGen';
import { boxAt, cylAt, mergeGeos, MeshBuilder } from './geomUtil';
import { DECK } from './groundHeight';
import { flattenModel } from './modelInstancing';
import { applyGroundAoTree } from './groundAo';

/** One revolution in seventy seconds: slow enough to look out from. */
const WHEEL_RATE = (Math.PI * 2) / 70;
/** How far below the wheel's hub-plane the gondola floor hangs. */
const GONDOLA_DROP = 0.9;
const BOLLARD_TIP_SECONDS = 0.45;

export interface SeatPose { x: number; y: number; z: number; heading: number }

/** A spot the player can use, and which way they face while using it. */
export interface PierSpot { pos: Vec2; heading: number }

export class FerrisWheel {
  readonly group = new THREE.Group();
  /** Rotation of the wheel, radians. Gondola i hangs at angle0(i) + this. */
  angle = 0;
  private readonly rim = new THREE.Group();
  private readonly gondolas: THREE.Group[] = [];
  private readonly pivots: THREE.Group[] = [];

  constructor(dusk: boolean) {
    const W = PIER_WHEEL;
    this.group.position.set(W.x, DECK, W.z);

    const steel = new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.55, metalness: 0.4 });
    const accent = new THREE.MeshStandardMaterial({
      color: 0xff5fa2, roughness: 0.5, emissive: 0xff5fa2, emissiveIntensity: dusk ? 1.6 : 0.25,
    });

    // Two A-frame legs a side, meeting at the hub.
    const legLen = Math.hypot(5.2, W.hubY);
    for (const side of [-1, 1]) {
      for (const dz of [-1.2, 1.2]) {
        const leg = new THREE.Mesh(cylAt(0.16, 0.22, legLen, 8), steel);
        leg.position.set(side * 2.6, W.hubY / 2, dz);
        leg.rotation.z = -side * Math.atan2(5.2, W.hubY);
        leg.castShadow = true;
        this.group.add(leg);
      }
      const foot = new THREE.Mesh(boxAt(1.4, 0.4, 3.2, side * 5.2, 0.2, 0), steel);
      this.group.add(foot);
    }
    const hub = new THREE.Mesh(cylAt(0.55, 0.55, 3.2, 12), steel);
    hub.rotation.x = Math.PI / 2;
    hub.position.set(0, W.hubY, 0);
    this.group.add(hub);

    // The rim: two rings, spokes between them and the hub, gondolas hung from
    // the rim on pivots that are counter-rotated every frame to stay upright.
    this.rim.position.set(0, W.hubY, 0);
    this.group.add(this.rim);
    for (const dz of [-0.7, 0.7]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(W.radius, 0.13, 8, 48), accent);
      ring.position.z = dz;
      this.rim.add(ring);
      const inner = new THREE.Mesh(new THREE.TorusGeometry(W.radius * 0.55, 0.09, 6, 36), steel);
      inner.position.z = dz;
      this.rim.add(inner);
    }
    const spokes: THREE.BufferGeometry[] = [];
    for (let i = 0; i < W.gondolas; i++) {
      const a = (i / W.gondolas) * Math.PI * 2;
      for (const dz of [-0.7, 0.7]) {
        const g = boxAt(0.1, W.radius, 0.1, 0, W.radius / 2, dz);
        g.rotateZ(-a);
        spokes.push(g);
      }
    }
    this.rim.add(new THREE.Mesh(mergeGeos(spokes), steel));

    const cabin = new THREE.MeshStandardMaterial({ color: 0x4fe3ff, roughness: 0.6 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xffc766, roughness: 0.7 });
    for (let i = 0; i < W.gondolas; i++) {
      const a = (i / W.gondolas) * Math.PI * 2;
      const pivot = new THREE.Group();
      pivot.position.set(Math.cos(a) * W.radius, Math.sin(a) * W.radius, 0);
      this.rim.add(pivot);
      const gondola = new THREE.Group();
      // Hangs below the pivot: floor, low sides, four posts and a roof.
      gondola.add(
        new THREE.Mesh(boxAt(1.7, 0.1, 1.5, 0, -GONDOLA_DROP, 0), cabin),
        new THREE.Mesh(boxAt(1.7, 0.5, 0.06, 0, -GONDOLA_DROP + 0.3, 0.72), cabin),
        new THREE.Mesh(boxAt(1.7, 0.5, 0.06, 0, -GONDOLA_DROP + 0.3, -0.72), cabin),
        new THREE.Mesh(boxAt(0.06, 0.5, 1.5, -0.82, -GONDOLA_DROP + 0.3, 0), cabin),
        new THREE.Mesh(boxAt(0.06, 0.5, 1.5, 0.82, -GONDOLA_DROP + 0.3, 0), cabin),
        new THREE.Mesh(boxAt(0.06, GONDOLA_DROP + 1.1, 0.06, -0.8, -GONDOLA_DROP / 2 + 0.55, -0.7), steel),
        new THREE.Mesh(boxAt(0.06, GONDOLA_DROP + 1.1, 0.06, 0.8, -GONDOLA_DROP / 2 + 0.55, -0.7), steel),
        new THREE.Mesh(boxAt(0.06, GONDOLA_DROP + 1.1, 0.06, -0.8, -GONDOLA_DROP / 2 + 0.55, 0.7), steel),
        new THREE.Mesh(boxAt(0.06, GONDOLA_DROP + 1.1, 0.06, 0.8, -GONDOLA_DROP / 2 + 0.55, 0.7), steel),
        new THREE.Mesh(boxAt(1.9, 0.08, 1.7, 0, 1.15 - GONDOLA_DROP + 0.9, 0), roofMat),
      );
      pivot.add(gondola);
      this.pivots.push(pivot);
      this.gondolas.push(gondola);
    }
    this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.castShadow = true; });
  }

  update(dt: number): void {
    this.angle += WHEEL_RATE * dt;
    this.rim.rotation.z = this.angle;
    for (const g of this.gondolas) g.rotation.z = -this.angle;
  }

  /** Where gondola `i` is right now, and its angle round the wheel. */
  angleOf(i: number): number {
    return (i / PIER_WHEEL.gondolas) * Math.PI * 2 + this.angle;
  }

  /** The seat in gondola `i` in world space; the rider faces out to sea. */
  seat(i: number, out: SeatPose): SeatPose {
    const W = PIER_WHEEL;
    const a = this.angleOf(i);
    out.x = W.x + Math.cos(a) * W.radius;
    out.y = DECK + W.hubY + Math.sin(a) * W.radius - GONDOLA_DROP + 0.05;
    out.z = W.z;
    out.heading = Math.PI;
    return out;
  }

  /** The gondola nearest the bottom of the wheel, and how far off it is. */
  lowest(): { index: number; off: number } {
    let best = 0, bestOff = Infinity;
    for (let i = 0; i < PIER_WHEEL.gondolas; i++) {
      const a = this.angleOf(i);
      // Distance in angle from straight down (-PI/2), wrapped.
      let off = ((a + Math.PI / 2) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      if (off > Math.PI) off = Math.PI * 2 - off;
      if (off < bestOff) { bestOff = off; best = i; }
    }
    return { index: best, off: bestOff };
  }

  /** Where a rider boards: on the deck just inland of the wheel's bottom. */
  get loadZone(): Vec2 { return { x: PIER_WHEEL.x, z: PIER_WHEEL.z + 2.4 }; }
}

export class Bollard {
  /** 0 standing .. 1 flat on the deck. */
  tip = 0;
  private tipping = false;
  private axisX = 1;
  private axisZ = 0;

  constructor(readonly mesh: THREE.Object3D, readonly pos: Vec2) {}

  get standing(): boolean { return !this.tipping; }

  /** Knock it over, away from `fromX/fromZ` (the car's direction of travel). */
  knock(dirX: number, dirZ: number): void {
    if (this.tipping) return;
    this.tipping = true;
    const l = Math.hypot(dirX, dirZ) || 1;
    // Tipping toward the direction of travel means rotating about the axis
    // perpendicular to it in the ground plane.
    this.axisX = dirZ / l;
    this.axisZ = -dirX / l;
  }

  update(dt: number): void {
    if (!this.tipping || this.tip >= 1) return;
    this.tip = Math.min(1, this.tip + dt / BOLLARD_TIP_SECONDS);
    // Ease out: it falls, then stops dead on the deck.
    const t = Math.sin((this.tip * Math.PI) / 2);
    this.mesh.quaternion.setFromAxisAngle(new THREE.Vector3(this.axisX, 0, this.axisZ), (Math.PI / 2) * t);
  }
}

export interface PierBuild {
  group: THREE.Group;
  wheel: FerrisWheel;
  bollards: Bollard[];
  /** Benches the player can sit on, facing out through the rail. */
  benches: PierSpot[];
  /** Points on the side rails to lean on. */
  leans: PierSpot[];
  /** The end rail, for diving off. */
  dive: PierSpot;
  update(dt: number): void;
}

export function buildPier(_layout: CityLayout, assets: Assets, dusk: boolean): PierBuild {
  const group = new THREE.Group();
  group.name = 'pier';
  const tex = getTextures();
  const plank = new THREE.MeshStandardMaterial({ map: tex.planks, color: 0xd9b98c, roughness: 0.85 });
  const timber = new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.9 });
  const paint = new THREE.MeshStandardMaterial({ color: 0xf3f0e6, roughness: 0.7 });

  // --- deck and pilings -----------------------------------------------------------
  const deck = new MeshBuilder();
  deck.slab(PIER.minX, PIER.minZ, PIER.maxX, PIER.maxZ, -0.4, DECK, 2.6);
  const deckMesh = new THREE.Mesh(deck.build(), plank);
  deckMesh.receiveShadow = true;
  group.add(deckMesh);

  const pilingSpots: THREE.Matrix4[] = [];
  for (let z = PIER.maxZ - 3; z > PIER.minZ; z -= 6) {
    for (const x of [PIER.minX + 1.2, 0, PIER.maxX - 1.2]) {
      pilingSpots.push(new THREE.Matrix4().makeTranslation(x, -3.4, z));
    }
  }
  const pilings = new THREE.InstancedMesh(cylAt(0.26, 0.3, 7.6, 8), timber, pilingSpots.length);
  pilingSpots.forEach((m, i) => pilings.setMatrixAt(i, m));
  pilings.instanceMatrix.needsUpdate = true;
  group.add(pilings);

  // --- railings -------------------------------------------------------------------
  const posts: THREE.BufferGeometry[] = [];
  const rails: THREE.BufferGeometry[] = [];
  const postAt = (x: number, z: number): void => { posts.push(boxAt(0.1, 1.1, 0.1, x, DECK + 0.55, z)); };
  for (let z = PIER.minZ; z <= PIER.maxZ - 1; z += 2) { postAt(PIER.minX, z); postAt(PIER.maxX, z); }
  for (let x = PIER.minX; x <= PIER.maxX; x += 2) postAt(x, PIER.minZ);
  const len = PIER.maxZ - 1 - PIER.minZ;
  for (const y of [DECK + 0.6, DECK + 1.05]) {
    rails.push(boxAt(0.06, 0.08, len, PIER.minX, y, PIER.minZ + len / 2));
    rails.push(boxAt(0.06, 0.08, len, PIER.maxX, y, PIER.minZ + len / 2));
    rails.push(boxAt(PIER.maxX - PIER.minX, 0.08, 0.06, 0, y, PIER.minZ));
  }
  const railMesh = new THREE.Mesh(mergeGeos([...posts, ...rails]), paint);
  railMesh.castShadow = true;
  group.add(railMesh);

  // --- lamps down the centreline ---------------------------------------------------
  const lampSpots: Vec2[] = [];
  for (let z = PIER.maxZ - 12; z > PIER_WHEEL.z + 14; z -= PIER_LAMP_SPACING) lampSpots.push({ x: 0, z });
  const lampSrc = assets.suppliedProp('streetlight-double');
  const flat = lampSrc ? flattenModel(lampSrc, { keepY: true, keepXZ: true }) : null;
  if (flat) {
    const mats = flat.materials.map((m) => m.clone());
    const lit = mats.find((m) => /lighton|lit|lamp/i.test(m.name)) as THREE.MeshStandardMaterial | undefined;
    if (lit?.isMeshStandardMaterial) { lit.emissive.setHex(0xffd9a0); lit.emissiveIntensity = dusk ? 2.2 : 0.55; }
    const lamps = new THREE.InstancedMesh(flat.geometry, mats, lampSpots.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    lampSpots.forEach((s, i) => { m.compose(new THREE.Vector3(s.x, DECK, s.z), q, new THREE.Vector3(1, 1, 1)); lamps.setMatrixAt(i, m); });
    lamps.instanceMatrix.needsUpdate = true;
    lamps.castShadow = true;
    group.add(lamps);
  } else {
    const poles: THREE.BufferGeometry[] = [];
    for (const s of lampSpots) {
      poles.push(cylAt(0.08, 0.12, 6.5, 6, s.x, DECK + 3.25, s.z));
      poles.push(boxAt(2.6, 0.14, 0.14, s.x, DECK + 6.4, s.z));
    }
    group.add(new THREE.Mesh(mergeGeos(poles), paint));
  }

  // --- kiosks: a box, an awning, a sign ---------------------------------------------
  const pastel = [0xa9e5cd, 0xffd0b0, 0xa6d5ea, 0xfaefd6, 0xc7b4e3, 0xff9a9e];
  PIER_KIOSKS.forEach((k, i) => {
    const body = new THREE.Mesh(boxAt(4, 3, 3, 0, DECK + 1.5, 0),
      new THREE.MeshStandardMaterial({ color: pastel[i % pastel.length], roughness: 0.85 }));
    body.castShadow = true;
    body.receiveShadow = true;
    const facing = k.x < 0 ? 1 : -1; // toward the centreline
    const awning = new THREE.Mesh(boxAt(4.4, 0.08, 1.4, facing * 2.2, DECK + 2.6, 0),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }));
    const stripe = new THREE.Mesh(boxAt(4.4, 0.12, 0.3, facing * 2.85, DECK + 2.55, 0),
      new THREE.MeshStandardMaterial({ color: 0xe23b2e, roughness: 0.8 }));
    const map = tex.neon(k.name, NEON_COLORS[i % NEON_COLORS.length]);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.9), new THREE.MeshStandardMaterial({
      color: 0x101014, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 2, roughness: 0.6, side: THREE.DoubleSide,
    }));
    sign.position.set(facing * 2.02, DECK + 3.3, 0);
    sign.rotation.y = facing > 0 ? Math.PI / 2 : -Math.PI / 2;
    const kiosk = new THREE.Group();
    kiosk.position.set(k.x, 0, k.z);
    kiosk.add(body, awning, stripe, sign);
    group.add(kiosk);
  });

  // --- benches against the rails, facing the sea --------------------------------------
  const benches: PierSpot[] = [];
  const benchGeo: THREE.BufferGeometry[] = [];
  for (let z = PIER.maxZ - 20; z > PIER_WHEEL.z + 10; z -= 24) {
    for (const side of [-1, 1]) {
      const x = side * (PIER.maxX - 1.0);
      const heading = side > 0 ? Math.PI / 2 : -Math.PI / 2; // facing outward
      const b = mergeGeos([
        boxAt(0.55, 0.1, 1.9, 0, DECK + 0.45, 0),
        boxAt(0.09, 0.55, 1.9, -0.24, DECK + 0.72, 0),
        boxAt(0.5, 0.45, 0.12, 0, DECK + 0.22, -0.85),
        boxAt(0.5, 0.45, 0.12, 0, DECK + 0.22, 0.85),
      ]);
      // Built facing +X; the -X side is mirrored.
      if (side < 0) b.rotateY(Math.PI);
      b.translate(x, 0, z);
      benchGeo.push(b);
      benches.push({ pos: { x: x + (side > 0 ? -0.05 : 0.05), z }, heading });
    }
  }
  const benchMesh = new THREE.Mesh(mergeGeos(benchGeo), new THREE.MeshStandardMaterial({ color: 0xb98a55, roughness: 0.9 }));
  benchMesh.castShadow = true;
  group.add(benchMesh);

  // --- lean spots on the rails ---------------------------------------------------------
  const leans: PierSpot[] = [];
  for (let z = PIER.maxZ - 32; z > PIER_WHEEL.z + 10; z -= 25) {
    leans.push({ pos: { x: PIER.maxX - 0.55, z }, heading: Math.PI / 2 });
    leans.push({ pos: { x: PIER.minX + 0.55, z }, heading: -Math.PI / 2 });
  }
  for (const x of [-4, 4]) leans.push({ pos: { x, z: PIER.minZ + 0.6 }, heading: Math.PI });

  // --- bollards at the entrance ----------------------------------------------------------
  const bollards: Bollard[] = [];
  const bollardMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.5, metalness: 0.5 });
  for (let x = -6.6; x <= 6.6; x += 2.2) {
    const mesh = new THREE.Mesh(cylAt(0.13, 0.15, 1.0, 10, 0, 0.5, 0), bollardMat);
    mesh.castShadow = true;
    mesh.position.set(x, DECK, PIER.maxZ - 4);
    group.add(mesh);
    bollards.push(new Bollard(mesh, { x, z: PIER.maxZ - 4 }));
  }

  const wheel = new FerrisWheel(dusk);
  group.add(wheel.group);

  // A small landing at the wheel's foot, so the gondola floor is a step up.
  const landing = new MeshBuilder();
  landing.slab(-1.6, PIER_WHEEL.z + 0.9, 1.6, PIER_WHEEL.z + 3.2, DECK, DECK + 0.3, 2);
  group.add(new THREE.Mesh(landing.build(), plank));

  applyGroundAoTree(group, 1.2, 0.8);

  return {
    group, wheel, bollards, benches, leans,
    dive: { pos: { x: 0, z: PIER.minZ + 0.9 }, heading: Math.PI },
    update(dt: number): void {
      wheel.update(dt);
      for (const b of bollards) b.update(dt);
    },
  };
}
