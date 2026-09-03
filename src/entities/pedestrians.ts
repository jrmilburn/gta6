// Sidewalk wanderers, flee behaviour and tumble-on-hit (plan section 6).
// Pedestrians walk the inset perimeter of each city block (the sidewalk),
// occasionally crossing at an intersection corner, and always render through
// the shared PedMeshPool (InstancedMesh, see pedMesh.ts) so `peds.count` stays
// cheap on draw calls regardless of count.
import * as THREE from 'three';
import type { AABB, EventName, System, Vec2 } from '../types';
import { CFG } from '../config';
import { Rng } from '../core/rng';
import { blockBounds, HALF_X, HALF_Z, PITCH } from '../world/cityGen';
import { PED_SCALES } from './pedMesh';
import { ProceduralPedRenderer, type PedRenderer } from './pedRenderer';

const HIT_SPEED_MIN = 1.5;
/** Pedestrian body radius for the building push-out, and the hash query range. */
const PED_RADIUS = 0.35;
const PUSH_QUERY = 8;

const EDGE_LEN = CFG.city.blockSize - 2 * INSET;
const RECYCLE_DIST = 250;
/**
 * How far from the player a recycled pedestrian must reappear.
 *
 * Recycling used to pick any block within three of the player's, which is
 * anywhere from zero to a couple of hundred metres -- so somebody who walked out
 * of the world 250 m behind you could reappear twenty metres in front, out of
 * nothing. Past this distance they are a handful of pixels and the swap is
 * invisible; the crowd LOD already turns them into a static figure at 55 m.
 */
const RESPAWN_MIN_DIST = 110;
const CROSS_PROB = 0.1;
const CROSS_CHECK_RADIUS = 15;
import { TUMBLE_TOSS, TUMBLE_LIE, TUMBLE_GETUP } from './pedPose';
import { makeTarget, stepDown, type PedTarget } from './pedKnockdown';
import {
  clampInt, insetCorners, nearestCornerIndex, obbContainsPoint, sideBetween,
  SIDE_AXIS, SIDE_DELTA, SIDE_SIGN, INSET, nearestEdge,
} from './pedGeometry';
import { circleVsAabb } from './playerCollision';
import { SpatialHash } from '../core/spatial';

export type { PedTarget } from './pedKnockdown';

const K = CFG.combat.knockdown;

type PedMode = 'wander' | 'cross' | 'flee' | 'tumble' | 'down' | 'return';

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
  // return: walking back to the pavement after a flee or a knockdown, rather
  // than being teleported onto it.
  returnTo: Vec2;
  returnCorner: number;
  returnT: number;
  // down: knocked over by a punch or a shot (section 8). No blood, no gore and
  // no death -- they lie still, then get up, or are recycled if the player has
  // long since walked away.
  downT: number;
  fallClip: string | null;
  fallRate: number;
  // tumble: tossed by a hit, see stepTumble().
  tumbleT: number;
  tumbleAxis: THREE.Vector3;
  tumbleFrom: Vec2;
  tumbleTo: Vec2;
}

export class PedestrianSystem implements System {
  /**
   * How the crowd is drawn. Either the procedural humanoid or the skinned
   * character rig (see pedRenderer.ts); nothing below this line knows which.
   */
  readonly mesh: PedRenderer;
  private readonly peds: Ped[] = [];
  private readonly rng: Rng;
  private vehicles: readonly PedVehicleLike[] = [];
  private hash = new SpatialHash<AABB>(20);
  private nearby: AABB[] = [];

  constructor(
    private readonly host: PedHost,
    private readonly playerPos: () => Vec2,
    seed = 424242,
    renderer?: PedRenderer,
  ) {
    this.rng = new Rng(seed);
    const count = CFG.peds.count;
    this.mesh = renderer ?? new ProceduralPedRenderer(count);
    host.scene.add(this.mesh.group);
    for (let i = 0; i < count; i++) this.peds.push(this.spawnPed(i));
  }

  /**
   * Start or stop a crowd dance centred on `centre` (integration pass, 4).
   * Only pedestrians the renderer is currently drawing in full can join.
   */
  setDance(centre: Vec2 | null, radius: number): void {
    this.mesh.setDance(centre, radius);
  }

  /** Vehicles to flee from and be hit by. Reassignable once traffic exists. */
  setVehicles(vehicles: readonly PedVehicleLike[]): void { this.vehicles = vehicles; }

  /** Read-only snapshot for the smoke suite / debug hooks. */
  list(): Array<{ x: number; y: number; z: number; mode: PedMode; speed: number }> {
    return this.peds.map((p) => ({
      x: p.pos.x, y: p.y, z: p.pos.z, mode: p.mode, speed: p.speed,
    }));
  }

  private corners(ix: number, iz: number): Vec2[] { return insetCorners(blockBounds(ix, iz)); }

  /** Buildings to keep pedestrians out of. Reassignable, like the vehicles. */
  setColliders(colliders: readonly AABB[]): void {
    this.hash = new SpatialHash<AABB>(20);
    for (const c of colliders) this.hash.insertAABB(c, c);
  }

  /** Shove one pedestrian out of any wall they have ended up inside. */
  private pushOut(p: Ped): void {
    this.nearby = this.hash.query(p.pos, PUSH_QUERY, this.nearby);
    for (const box of this.nearby) {
      const hit = circleVsAabb(p.pos.x, p.pos.z, PED_RADIUS, box);
      if (!hit) continue;
      p.pos.x += hit.nx * hit.depth;
      p.pos.z += hit.nz * hit.depth;
      // Run along the wall rather than into it, so a fleeing pedestrian who
      // meets a building does not spend the rest of the panic grinding on it.
      const along = p.fleeX * -hit.nz + p.fleeZ * hit.nx;
      p.fleeX = -hit.nz * along;
      p.fleeZ = hit.nx * along;
    }
  }

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
      downT: 0, fallClip: null, fallRate: 1,
      returnTo: { x: 0, z: 0 }, returnCorner: 0, returnT: 0,
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
    this.mesh.begin();
    for (const p of this.peds) {
      if (Math.hypot(p.pos.x - player.x, p.pos.z - player.z) > RECYCLE_DIST) this.recycle(p);

      if (p.mode === 'return') this.stepReturn(p, dt);
      else if (p.mode === 'down') stepDown(p, dt, this.playerPos(), () => this.recycle(p), () => this.resumeWander(p), this.mesh);
      else if (p.mode === 'tumble') this.stepTumble(p, dt);
      else if (p.mode === 'flee') this.stepFlee(p, dt);
      else if (p.mode === 'cross') this.stepCross(p, dt);
      else this.stepWander(p, dt);

      if (p.mode !== 'tumble' && p.mode !== 'down') {
        if (!this.checkHit(p)) this.checkFleeTrigger(p);
      }
      if (p.mode === 'return') this.pushOut(p);
      // The wander and crossing paths are laid out clear of the buildings, but
      // a flee is a straight line for three seconds and a tumble is a shove, and
      // neither asked the world whether there was a wall there.
      if (p.mode === 'flee' || p.mode === 'tumble' || p.mode === 'down') this.pushOut(p);
      this.updatePose(p, dt);
    }
    this.mesh.commit();
  }

  /**
   * Live handles on every pedestrian, for the combat hit tests (sections 6-7).
   *
   * Deliberately not the whole `Ped`: a caller needs somewhere to aim and a way
   * to knock one down, and giving it the wander state machine as well is how
   * that state machine ends up being driven from three places.
   */
  targets(): PedTarget[] {
    return this.peds.map((p) => makeTarget(p, () => this.knockDown(p)));
  }

  /** See pedKnockdown.ts; the witnesses are this system's business. */
  private knockDown(p: Ped): void {
    this.host.events.emit('pedHit', { x: p.pos.x, z: p.pos.z, knockdown: true });
    for (const other of this.peds) {
      if (other === p || other.mode === 'down' || other.mode === 'tumble') continue;
      if (Math.hypot(other.pos.x - p.pos.x, other.pos.z - p.pos.z) > K.witnessRadius) continue;
      this.startFlee(other, p.pos);
    }
  }

  private recycle(p: Ped): void {
    p.mode = 'wander';
    p.fallClip = null;
    p.fallRate = 1;
    p.downT = 0;
    const player = this.playerPos();
    const cix = clampInt(Math.round((player.x + HALF_X) / PITCH - 0.5), 0, CFG.city.blocksX - 1);
    const ciz = clampInt(Math.round((player.z + HALF_Z) / PITCH - 0.5), 0, CFG.city.blocksZ - 1);
    // Take the furthest of a few candidate blocks, and stop as soon as one is
    // comfortably out of sight.
    let bestIx = cix, bestIz = ciz, bestD = -1;
    for (let tries = 0; tries < 6; tries++) {
      const ix = clampInt(cix + this.rng.int(-3, 3), 0, CFG.city.blocksX - 1);
      const iz = clampInt(ciz + this.rng.int(-3, 3), 0, CFG.city.blocksZ - 1);
      const b = blockBounds(ix, iz);
      const d = Math.hypot((b.minX + b.maxX) / 2 - player.x, (b.minZ + b.maxZ) / 2 - player.z);
      if (d > bestD) { bestD = d; bestIx = ix; bestIz = iz; }
      if (bestD >= RESPAWN_MIN_DIST) break;
    }
    p.ix = bestIx;
    p.iz = bestIz;
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

  /**
   * Send a pedestrian back to the pavement from wherever they finished running.
   *
   * They WALK back rather than being put back. The wander path is a position
   * computed from an edge parameter, so anyone standing off it has to be moved
   * onto it somehow -- and doing that in one frame is a teleport. Snapping to
   * the nearest corner moved them up to half a block; snapping to the nearest
   * point on the perimeter still moved them up to 18 m, measured, when they had
   * fled into the middle of one. So they aim for the nearest point and take the
   * time to get there, which is what a person would do.
   */
  private resumeWander(p: Ped): void {
    const ix = clampInt(Math.round((p.pos.x + HALF_X) / PITCH - 0.5), 0, CFG.city.blocksX - 1);
    const iz = clampInt(Math.round((p.pos.z + HALF_Z) / PITCH - 0.5), 0, CFG.city.blocksZ - 1);
    p.ix = ix; p.iz = iz;
    const cs = this.corners(ix, iz);
    const near = nearestEdge(cs, p.pos);
    const a = cs[near.corner], b = cs[(near.corner + 1) % 4];
    p.returnTo = { x: a.x + (b.x - a.x) * near.t, z: a.z + (b.z - a.z) * near.t };
    p.returnCorner = near.corner;
    p.returnT = near.t;
    // Already there, near enough: rejoin without the walk.
    if (Math.hypot(p.returnTo.x - p.pos.x, p.returnTo.z - p.pos.z) < 0.4) {
      this.joinPath(p);
      return;
    }
    p.mode = 'return';
  }

  /** Walk toward the pavement; rejoin the wander path on arrival. */
  private stepReturn(p: Ped, dt: number): void {
    p.speed = CFG.peds.walkSpeed;
    const dx = p.returnTo.x - p.pos.x, dz = p.returnTo.z - p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.25) { this.joinPath(p); return; }
    p.heading = Math.atan2(dx, dz);
    const step = Math.min(d, CFG.peds.walkSpeed * dt);
    p.pos.x += (dx / d) * step;
    p.pos.z += (dz / d) * step;
  }

  /** Adopt the edge they walked back to and carry on wandering. */
  private joinPath(p: Ped): void {
    p.corner = p.returnCorner;
    p.dir = 1;
    p.edgeT = p.returnT;
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
    this.mesh.pose(p, dt);
  }

  dispose(): void { this.mesh.dispose(); }
}
