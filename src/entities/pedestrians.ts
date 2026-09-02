// Sidewalk wanderers, flee behaviour and tumble-on-hit (plan section 6).
// Pedestrians walk the inset perimeter of each city block (the sidewalk),
// occasionally crossing at an intersection corner, and always render through
// the shared PedMeshPool (InstancedMesh, see pedMesh.ts) so `peds.count` stays
// cheap on draw calls regardless of count.
import * as THREE from 'three';
import type { EventName, System, Vec2 } from '../types';
import { CFG } from '../config';
import { Rng } from '../core/rng';
import { blockBounds, HALF_X, HALF_Z, PITCH } from '../world/cityGen';
import { PedMeshPool, PED_SCALES, PED_VARIANT_COUNT } from './pedMesh';

// DECISION: the OBB half-extents below are duplicated from vehicle.ts (module
// -private there, and that file is outside this phase's ownership) -- they
// must match the plan's stated vehicle OBB (length 4.4, width 2.0).
const V_HALF_LEN = 2.2;
const V_HALF_WID = 1.0;
const HIT_MARGIN = 0.35; // ped capsule radius, approximated as a point + margin
const HIT_SPEED_MIN = 1.5;

const INSET = 1.5; // plan: sidewalk polylines inset 1.5 m from the block edge
const EDGE_LEN = CFG.city.blockSize - 2 * INSET;
const RECYCLE_DIST = 250;
const CROSS_PROB = 0.1;
const CROSS_CHECK_RADIUS = 15;
const TUMBLE_TOSS = 0.9;   // rise + spin + land, combined into one arc
const TUMBLE_LIE = 2.0;    // lie flat afterwards
const TUMBLE_GETUP = 0.3;

type PedMode = 'wander' | 'cross' | 'flee' | 'tumble';

/** The subset of Vehicle pedestrians react to: any moving box in the world. */
export interface PedVehicleLike {
  pos: Vec2;
  speed: number;
  wrecked: boolean;
  forwardX: number;
  forwardZ: number;
}

export interface PedHost {
  scene: THREE.Scene;
  events: { emit(evt: EventName, payload?: unknown): void };
  time: number;
}

interface Ped {
  variant: number;
  slot: number;
  /** Uniform body scale from PED_SCALES; fixed for the pedestrian's lifetime. */
  scale: number;
  pos: Vec2;
  y: number;
  heading: number;
  mode: PedMode;
  speed: number;
  phase: number;
  // wander: walking the inset perimeter of block (ix, iz) from corner to
  // corner (+1 for clockwise, -1 counter-clockwise), edgeT 0..1 along the edge.
  ix: number;
  iz: number;
  corner: number;
  dir: 1 | -1;
  edgeT: number;
  // cross: a straight walk from one block's corner to the neighbour's.
  crossFrom: Vec2;
  crossTo: Vec2;
  crossT: number;
  crossDur: number;
  crossIx: number;
  crossIz: number;
  crossCorner: number;
  // flee: run directly away from the threat for 3 s.
  fleeUntil: number;
  fleeX: number;
  fleeZ: number;
  // tumble: tossed by a hit, see stepTumble().
  tumbleT: number;
  tumbleAxis: THREE.Vector3;
  tumbleFrom: Vec2;
  tumbleTo: Vec2;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function insetCorners(b: { minX: number; maxX: number; minZ: number; maxZ: number }): Vec2[] {
  return [
    { x: b.minX + INSET, z: b.minZ + INSET },
    { x: b.maxX - INSET, z: b.minZ + INSET },
    { x: b.maxX - INSET, z: b.maxZ - INSET },
    { x: b.minX + INSET, z: b.maxZ - INSET },
  ];
}

/** Which side of the block an edge between two corner indices runs along. */
function sideBetween(a: number, b: number): number {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  if (lo === 0 && hi === 1) return 0; // south (z = minZ)
  if (lo === 1 && hi === 2) return 1; // east  (x = maxX)
  if (lo === 2 && hi === 3) return 2; // north (z = maxZ)
  return 3;                           // west  (x = minX)
}
const SIDE_DELTA: ReadonlyArray<readonly [number, number]> = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const SIDE_AXIS: readonly ('x' | 'z')[] = ['z', 'x', 'z', 'x'];
const SIDE_SIGN: readonly number[] = [-1, 1, 1, -1];

function nearestCornerIndex(corners: Vec2[], p: Vec2): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < corners.length; i++) {
    const d = Math.hypot(corners[i].x - p.x, corners[i].z - p.z);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function obbContainsPoint(v: PedVehicleLike, px: number, pz: number): boolean {
  const dx = px - v.pos.x, dz = pz - v.pos.z;
  const fx = v.forwardX, fz = v.forwardZ, rx = fz, rz = -fx;
  const along = dx * fx + dz * fz;
  const across = dx * rx + dz * rz;
  return Math.abs(along) < V_HALF_LEN + HIT_MARGIN && Math.abs(across) < V_HALF_WID + HIT_MARGIN;
}

const M_BASE = new THREE.Matrix4();
const V_POS = new THREE.Vector3();
const V_SCALE = new THREE.Vector3(1, 1, 1);
const Q_YAW = new THREE.Quaternion();
const Q_TUMBLE = new THREE.Quaternion();
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);

export class PedestrianSystem implements System {
  readonly mesh: PedMeshPool;
  private readonly peds: Ped[] = [];
  private readonly rng: Rng;
  private vehicles: readonly PedVehicleLike[] = [];

  constructor(
    private readonly host: PedHost,
    private readonly playerPos: () => Vec2,
    seed = 424242,
  ) {
    this.rng = new Rng(seed);
    const count = CFG.peds.count;
    this.mesh = new PedMeshPool(Math.ceil(count / PED_VARIANT_COUNT));
    host.scene.add(this.mesh.group);
    for (let i = 0; i < count; i++) this.peds.push(this.spawnPed(i));
  }

  /** Vehicles to flee from and be hit by. Reassignable once traffic exists. */
  setVehicles(vehicles: readonly PedVehicleLike[]): void { this.vehicles = vehicles; }

  /** Read-only snapshot for the smoke suite / debug hooks. */
  list(): Array<{ x: number; z: number; mode: PedMode; speed: number }> {
    return this.peds.map((p) => ({ x: p.pos.x, z: p.pos.z, mode: p.mode, speed: p.speed }));
  }

  private corners(ix: number, iz: number): Vec2[] { return insetCorners(blockBounds(ix, iz)); }

  private spawnPed(i: number): Ped {
    const ix = this.rng.int(0, CFG.city.blocksX - 1);
    const iz = this.rng.int(0, CFG.city.blocksZ - 1);
    const p: Ped = {
      variant: this.mesh.variantFor(i), slot: this.mesh.slotFor(i),
      scale: PED_SCALES[this.rng.int(0, PED_SCALES.length - 1)],
      pos: { x: 0, z: 0 }, y: 0, heading: 0, mode: 'wander', speed: 0,
      phase: this.rng.range(0, 10),
      ix, iz, corner: this.rng.int(0, 3), dir: this.rng.chance(0.5) ? 1 : -1, edgeT: this.rng.next(),
      crossFrom: { x: 0, z: 0 }, crossTo: { x: 0, z: 0 }, crossT: 0, crossDur: 1,
      crossIx: 0, crossIz: 0, crossCorner: 0,
      fleeUntil: 0, fleeX: 0, fleeZ: 1,
      tumbleT: 0, tumbleAxis: new THREE.Vector3(0, 1, 0), tumbleFrom: { x: 0, z: 0 }, tumbleTo: { x: 0, z: 0 },
    };
    this.syncEdgePos(p);
    return p;
  }

  private syncEdgePos(p: Ped): void {
    const cs = this.corners(p.ix, p.iz);
    const a = cs[p.corner], b = cs[(p.corner + p.dir + 4) % 4];
    p.pos.x = a.x + (b.x - a.x) * p.edgeT;
    p.pos.z = a.z + (b.z - a.z) * p.edgeT;
    const hx = b.x - a.x, hz = b.z - a.z;
    if (Math.hypot(hx, hz) > 1e-4) p.heading = Math.atan2(hx, hz);
  }

  update(dt: number): void {
    const player = this.playerPos();
    for (const p of this.peds) {
      if (Math.hypot(p.pos.x - player.x, p.pos.z - player.z) > RECYCLE_DIST) this.recycle(p);

      if (p.mode === 'tumble') this.stepTumble(p, dt);
      else if (p.mode === 'flee') this.stepFlee(p, dt);
      else if (p.mode === 'cross') this.stepCross(p, dt);
      else this.stepWander(p, dt);

      if (p.mode !== 'tumble') {
        if (!this.checkHit(p)) this.checkFleeTrigger(p);
      }
      this.updatePose(p, dt);
    }
    this.mesh.commit();
  }

  private recycle(p: Ped): void {
    const player = this.playerPos();
    const cix = clampInt(Math.round((player.x + HALF_X) / PITCH - 0.5), 0, CFG.city.blocksX - 1);
    const ciz = clampInt(Math.round((player.z + HALF_Z) / PITCH - 0.5), 0, CFG.city.blocksZ - 1);
    p.ix = clampInt(cix + this.rng.int(-3, 3), 0, CFG.city.blocksX - 1);
    p.iz = clampInt(ciz + this.rng.int(-3, 3), 0, CFG.city.blocksZ - 1);
    p.corner = this.rng.int(0, 3);
    p.dir = this.rng.chance(0.5) ? 1 : -1;
    p.edgeT = this.rng.next();
    p.mode = 'wander';
    this.syncEdgePos(p);
  }

  // --- wander / cross ------------------------------------------------------

  private stepWander(p: Ped, dt: number): void {
    p.speed = CFG.peds.walkSpeed;
    p.edgeT += (CFG.peds.walkSpeed * dt) / EDGE_LEN;
    if (p.edgeT >= 1) {
      p.edgeT = 1;
      this.syncEdgePos(p);
      this.arriveAtCorner(p);
    } else {
      this.syncEdgePos(p);
    }
  }

  private arriveAtCorner(p: Ped): void {
    const bIdx = (p.corner + p.dir + 4) % 4;
    if (this.tryStartCrossing(p, bIdx)) return;
    p.corner = bIdx;
    if (this.rng.chance(0.5)) p.dir = (p.dir * -1) as 1 | -1;
    p.edgeT = 0;
    this.syncEdgePos(p);
  }

  private tryStartCrossing(p: Ped, cornerIdx: number): boolean {
    if (!this.rng.chance(CROSS_PROB)) return false;
    const side = sideBetween(p.corner, cornerIdx);
    const [dix, diz] = SIDE_DELTA[side];
    const nix = p.ix + dix, niz = p.iz + diz;
    if (nix < 0 || nix >= CFG.city.blocksX || niz < 0 || niz >= CFG.city.blocksZ) return false;

    const from = this.corners(p.ix, p.iz)[cornerIdx];
    const offset = CFG.city.roadWidth + 2 * INSET;
    const to: Vec2 = SIDE_AXIS[side] === 'x'
      ? { x: from.x + SIDE_SIGN[side] * offset, z: from.z }
      : { x: from.x, z: from.z + SIDE_SIGN[side] * offset };
    if (!this.crossingSafe(from, to)) return false;

    p.mode = 'cross';
    p.crossFrom = { ...from };
    p.crossTo = to;
    p.crossT = 0;
    p.crossDur = Math.max(0.3, Math.hypot(to.x - from.x, to.z - from.z) / CFG.peds.walkSpeed);
    p.crossIx = nix;
    p.crossIz = niz;
    p.crossCorner = nearestCornerIndex(this.corners(nix, niz), to);
    return true;
  }

  private crossingSafe(a: Vec2, b: Vec2): boolean {
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    for (const v of this.vehicles) {
      if (Math.hypot(v.pos.x - mx, v.pos.z - mz) < CROSS_CHECK_RADIUS) return false;
    }
    return true;
  }

  private stepCross(p: Ped, dt: number): void {
    p.speed = CFG.peds.walkSpeed;
    p.crossT += dt / p.crossDur;
    if (p.crossT >= 1) {
      p.pos.x = p.crossTo.x; p.pos.z = p.crossTo.z;
      p.ix = p.crossIx; p.iz = p.crossIz; p.corner = p.crossCorner;
      p.dir = this.rng.chance(0.5) ? 1 : -1;
      p.edgeT = 0;
      p.mode = 'wander';
      this.syncEdgePos(p);
    } else {
      p.pos.x = p.crossFrom.x + (p.crossTo.x - p.crossFrom.x) * p.crossT;
      p.pos.z = p.crossFrom.z + (p.crossTo.z - p.crossFrom.z) * p.crossT;
      const hx = p.crossTo.x - p.crossFrom.x, hz = p.crossTo.z - p.crossFrom.z;
      if (Math.hypot(hx, hz) > 1e-4) p.heading = Math.atan2(hx, hz);
    }
  }

  // --- flee ------------------------------------------------------------------

  private checkFleeTrigger(p: Ped): void {
    let bestD = CFG.peds.fleeRadius, threat: PedVehicleLike | null = null;
    for (const v of this.vehicles) {
      if (v.wrecked || Math.abs(v.speed) <= 6) continue;
      const d = Math.hypot(v.pos.x - p.pos.x, v.pos.z - p.pos.z);
      if (d < bestD) { bestD = d; threat = v; }
    }
    if (!threat) return;
    this.startFlee(p, threat.pos);
  }

  private startFlee(p: Ped, from: Vec2): void {
    const dx = p.pos.x - from.x, dz = p.pos.z - from.z;
    const d = Math.hypot(dx, dz) || 1;
    p.fleeX = dx / d; p.fleeZ = dz / d;
    p.fleeUntil = this.host.time + 3;
    p.mode = 'flee';
  }

  private stepFlee(p: Ped, dt: number): void {
    p.speed = CFG.peds.fleeSpeed;
    p.pos.x += p.fleeX * CFG.peds.fleeSpeed * dt;
    p.pos.z += p.fleeZ * CFG.peds.fleeSpeed * dt;
    p.heading = Math.atan2(p.fleeX, p.fleeZ);
    if (this.host.time >= p.fleeUntil) this.resumeWander(p);
  }

  private resumeWander(p: Ped): void {
    const ix = clampInt(Math.round((p.pos.x + HALF_X) / PITCH - 0.5), 0, CFG.city.blocksX - 1);
    const iz = clampInt(Math.round((p.pos.z + HALF_Z) / PITCH - 0.5), 0, CFG.city.blocksZ - 1);
    p.ix = ix; p.iz = iz;
    p.corner = nearestCornerIndex(this.corners(ix, iz), p.pos);
    p.dir = this.rng.chance(0.5) ? 1 : -1;
    p.edgeT = 0;
    p.mode = 'wander';
    this.syncEdgePos(p);
  }

  // --- hit / tumble ------------------------------------------------------------

  private checkHit(p: Ped): boolean {
    for (const v of this.vehicles) {
      if (v.wrecked || Math.abs(v.speed) < HIT_SPEED_MIN) continue;
      if (!obbContainsPoint(v, p.pos.x, p.pos.z)) continue;
      this.startTumble(p, v);
      return true;
    }
    return false;
  }

  private startTumble(p: Ped, v: PedVehicleLike): void {
    p.tumbleT = 0;
    p.tumbleFrom = { ...p.pos };
    p.tumbleTo = { x: p.pos.x + v.forwardX * 3, z: p.pos.z + v.forwardZ * 3 };
    p.tumbleAxis.set(this.rng.range(-1, 1), this.rng.range(0.3, 1), this.rng.range(-1, 1)).normalize();
    const dx = p.pos.x - v.pos.x, dz = p.pos.z - v.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    p.fleeX = dx / d; p.fleeZ = dz / d; // where it runs once it gets back up
    p.mode = 'tumble';
    // No blood, no gore, no particles (plan section 0.10 / hard constraints):
    // the tween below is the entire "hit" reaction.
    this.host.events.emit('pedHit', { x: p.pos.x, z: p.pos.z });
  }

  private stepTumble(p: Ped, dt: number): void {
    p.tumbleT += dt;
    p.speed = 0;
    const lieEnd = TUMBLE_TOSS + TUMBLE_LIE, getupEnd = lieEnd + TUMBLE_GETUP;
    if (p.tumbleT <= TUMBLE_TOSS) {
      const u = p.tumbleT / TUMBLE_TOSS;
      p.pos.x = p.tumbleFrom.x + (p.tumbleTo.x - p.tumbleFrom.x) * u;
      p.pos.z = p.tumbleFrom.z + (p.tumbleTo.z - p.tumbleFrom.z) * u;
      p.y = Math.sin(Math.PI * u);
    } else if (p.tumbleT <= lieEnd) {
      p.y = 0;
    } else if (p.tumbleT <= getupEnd) {
      p.y = 0;
    } else {
      p.y = 0;
      p.heading = Math.atan2(p.fleeX, p.fleeZ);
      p.mode = 'flee';
      p.fleeUntil = this.host.time + 3;
    }
  }

  // --- rendering ---------------------------------------------------------------

  private updatePose(p: Ped, dt: number): void {
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

    M_BASE.compose(V_POS.set(p.pos.x, p.y, p.pos.z), quat, V_SCALE.setScalar(p.scale));
    this.mesh.setPose(p.variant, p.slot, M_BASE, legSwing, armSwing, armsUp);
  }

  dispose(): void { this.mesh.dispose(); }
}
