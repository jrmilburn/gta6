// Sidewalk wanderers, flee behaviour and tumble-on-hit (plan section 6).
// Pedestrians walk the inset perimeter of each city block (the sidewalk),
// crossing at the corners on the walk phase, and always render through the
// shared PedMeshPool (InstancedMesh, see pedMesh.ts) so `peds.count` stays
// cheap on draw calls regardless of count.
//
// What makes them read as people rather than tokens on a track, all cheap:
// a walking speed of their own, a heading that turns rather than snaps, an
// occasional stop to look at something, a wait at the kerb for the light,
// stepping round each other and round the player -- and never, ever an
// about-face in the middle of a street for no reason.
import * as THREE from 'three';
import type { AABB, EventName, System, Vec2 } from '../types';
import { CFG } from '../config';
import { Rng } from '../core/rng';
import { blockBounds, HALF_X, HALF_Z, PIER, PITCH } from '../world/cityGen';
import { PED_SCALES } from './pedMesh';
import { ProceduralPedRenderer, type PedRenderer } from './pedRenderer';
import { cornerNode, type SignalSystem } from '../world/signals';

const HIT_SPEED_MIN = 1.5;
// Driving over somebody already on the ground. A jolt through the suspension
// and a nudge off line -- not a second knockdown, and not a kill: they are
// already down, and they get up again exactly as they would have.
const BUMP_SHOVE = 1.6;
const BUMP_IMPACT = 5;
const BUMP_COOLDOWN = 0.8;
/** Pedestrian body radius for the building push-out, and the hash query range. */
const PED_RADIUS = 0.35;
const PUSH_QUERY = 8;

const EDGE_LEN = CFG.city.blockSize - 2 * INSET;
/**
 * Beyond this from the focus a pedestrian may be recycled -- but only out of
 * the camera's view. Somebody who vanishes while you are looking at them is
 * the one thing this file must never do, however far away they are.
 */
const RECYCLE_DIST = 320;
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
/**
 * How often a pedestrian arriving at a corner wants to go over the road.
 * With signals this is the share who WAIT for the walk phase rather than
 * turning the corner; without them, the old one-in-ten, crossing at once.
 */
const CROSS_PROB = 0.1;
const CROSS_WANT_PROB = 0.35;
const CROSS_CHECK_RADIUS = 15;
/** A car this close while crossing makes them hurry. */
const CROSS_HURRY_RADIUS = 9;
/** Longest anyone waits at a kerb before giving up and turning the corner. */
const WAIT_MAX = 16;
/** Speed of their own: a stroll to a brisk walk. */
const WALK_MIN = 1.1;
const WALK_MAX = 1.7;
const ACCEL = 2.2;
/** How fast a heading may swing, rad/s. A person turns a corner in a stride. */
const TURN_RATE = 4;
/** Idle stops: chance per corner, and how long they stand. */
const IDLE_PROB = 0.15;
const IDLE_MIN = 2, IDLE_MAX = 6;
/** Separation: from each other, and the wider berth given to the player. */
const SEP_PED = 0.7;
const SEP_PLAYER = 1.2;
const SEP_MAX_LATERAL = 0.9;
/** Gunfire is heard, and fled from, within this. */
const GUNFIRE_RADIUS = 25;
const FLEE_SECONDS = 3;
const GUNFIRE_FLEE_SECONDS = 4;
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

export type PedMode = 'wander' | 'cross' | 'flee' | 'tumble' | 'down' | 'return' | 'idle' | 'wait' | 'ride';

/**
 * The pier is walked like a block: a loop inset from its rails. It is block
 * index -1 -- the one place the block grid does not cover -- and `corners()`
 * knows to hand back the pier's loop for it. Nobody crosses off it; they walk
 * the loop until they are recycled or flee, and a flee ends on land.
 */
const PIER_BLOCK = -1;
/** Share of recycles that land on the pier while the player is near the beach. */
const PIER_RECYCLE_PROB = 0.25;
const PIER_NEAR = 260;

/** A seat somewhere that moves, for a pedestrian riding the wheel. */
export interface RiderSeat { x: number; y: number; z: number; heading: number }

/** The subset of Vehicle pedestrians react to: any moving box in the world. */
export interface PedVehicleLike {
  pos: Vec2;
  speed: number;
  wrecked: boolean;
  forwardX: number;
  forwardZ: number;
  /** Optional, so the pedestrian tests can pass a plain object. */
  shove?(x: number, z: number): void;
}

export interface PedHost {
  scene: THREE.Scene;
  events: {
    emit(evt: EventName, payload?: unknown): void;
    /** Optional so the unit-style tests can pass a bare emitter. */
    on?(evt: EventName, fn: (payload?: unknown) => void): void;
  };
  time: number;
  /** The rendering camera, for the "never vanish on screen" test. Optional. */
  camera?: THREE.Camera;
}

interface Ped {
  variant: number;
  slot: number;
  /** Uniform body scale from PED_SCALES; fixed for the pedestrian's lifetime. */
  scale: number;
  pos: Vec2;
  y: number;
  heading: number;
  /** Where the navigation wants them to face; `heading` turns toward it. */
  headingTarget: number;
  /** Angular velocity of the heading this frame, rad/s, for the turn clip. */
  turnRate: number;
  mode: PedMode;
  speed: number;
  /** Their own walking pace, m/s. */
  walkSpeed: number;
  phase: number;
  // wander: walking the inset perimeter of block (ix, iz) from corner to
  // corner (+1 for clockwise, -1 counter-clockwise), edgeT 0..1 along the edge.
  ix: number;
  iz: number;
  corner: number;
  dir: 1 | -1;
  edgeT: number;
  /** Sideways offset from the walking line, metres to the right; stepping round people. */
  lateral: number;
  // cross: a straight walk from one block's corner to the neighbour's.
  crossFrom: Vec2;
  crossTo: Vec2;
  crossT: number;
  crossDur: number;
  crossIx: number;
  crossIz: number;
  crossCorner: number;
  // wait: standing at a kerb for the walk phase; `waitCorner` is the corner
  // they will cross from, `waitUntil` when they give up.
  waitCorner: number;
  waitUntil: number;
  // idle: standing still for a moment.
  idleUntil: number;
  // flee: run directly away from the threat for a few seconds.
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
  /** Seconds before this body can bump a car again. */
  bumpCooldown: number;
  fallClip: string | null;
  fallRate: number;
  // tumble: tossed by a hit, see stepTumble().
  tumbleT: number;
  tumbleAxis: THREE.Vector3;
  tumbleFrom: Vec2;
  tumbleTo: Vec2;
}

const FRUSTUM = new THREE.Frustum();
const PROJ = new THREE.Matrix4();
const PT = new THREE.Vector3();

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export class PedestrianSystem implements System {
  /**
   * How the crowd is drawn. Either the procedural humanoid or the skinned
   * character rig (see pedRenderer.ts); nothing below this line knows which.
   */
  readonly mesh: PedRenderer;
  /** How many pedestrians have been recycled since the start. For the tests. */
  recycled = 0;
  private readonly peds: Ped[] = [];
  private readonly rng: Rng;
  private vehicles: readonly PedVehicleLike[] = [];
  private signals: SignalSystem | null = null;
  /** Where the police are, for the crowd to keep clear of once there is heat. */
  private threats: () => readonly Vec2[] = () => [];
  /** Walkable height, so the crowd stands on the kerbs and decks. */
  private groundAt: (x: number, z: number) => number = () => 0;
  /** Moving seats a few pedestrians are pinned to (the ferris wheel). */
  private riders: () => readonly RiderSeat[] = () => [];
  private hash = new SpatialHash<AABB>(20);
  private nearby: AABB[] = [];
  private crowd = new SpatialHash<Ped>(4);
  private near: Ped[] = [];
  private hasFrustum = false;

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
    // A shot is heard by everyone near it. The shooter is the player, so the
    // crowd runs from where the player stands rather than from the impact.
    host.events.on?.('shotHit', () => this.alarm(this.playerPos(), GUNFIRE_RADIUS, GUNFIRE_FLEE_SECONDS));
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

  /** The traffic lights: crossings wait for the walk phase once these exist. */
  setSignals(signals: SignalSystem | null): void { this.signals = signals; }

  /** Positions the crowd keeps away from -- active police units. */
  setThreats(fn: () => readonly Vec2[]): void { this.threats = fn; }

  /** Ground height, so pedestrians on the boardwalk and pier stand on it. */
  setGround(fn: (x: number, z: number) => number): void { this.groundAt = fn; }

  /**
   * Seats that carry pedestrians: as many pedestrians as there are seats are
   * taken out of the crowd and ride, for good.
   */
  setRiders(fn: () => readonly RiderSeat[]): void {
    this.riders = fn;
    const seats = fn().length;
    let n = 0;
    for (const p of this.peds) {
      if (n >= seats) break;
      if (p.mode !== 'wander') continue;
      p.mode = 'ride';

      n++;
    }
  }

  /** Everyone within `radius` of `from` runs from it. */
  alarm(from: Vec2, radius: number, seconds = FLEE_SECONDS): void {
    for (const p of this.peds) {
      if (p.mode === 'down' || p.mode === 'tumble') continue;
      if (Math.hypot(p.pos.x - from.x, p.pos.z - from.z) > radius) continue;
      this.startFlee(p, from, seconds);
    }
  }

  /** Read-only snapshot for the smoke suite / debug hooks. */
  list(): Array<{ x: number; y: number; z: number; mode: PedMode; speed: number; heading: number }> {
    return this.peds.map((p) => ({
      x: p.pos.x, y: p.y, z: p.pos.z, mode: p.mode, speed: p.speed, heading: p.heading,
    }));
  }

  private corners(ix: number, iz: number): Vec2[] {
    // The pier's loop runs between the lamp posts on the centreline and the
    // kiosks along the sides: 2.6 m either side of the middle.
    if (ix === PIER_BLOCK) return insetCorners({ minX: -2.6 - INSET, maxX: 2.6 + INSET, minZ: PIER.minZ + 4, maxZ: PIER.maxZ - 8 });
    return insetCorners(blockBounds(ix, iz));
  }

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
    // One in eight starts on the pier: the spawn is at its foot, and a pier
    // with nobody on it is a pier that is closed.
    const onPier = i % 8 === 0;
    const ix = onPier ? PIER_BLOCK : this.rng.int(0, CFG.city.blocksX - 1);
    const iz = onPier ? 0 : this.rng.int(0, CFG.city.blocksZ - 1);
    const p: Ped = {
      variant: this.mesh.variantFor(i), slot: this.mesh.slotFor(i),
      scale: PED_SCALES[this.rng.int(0, PED_SCALES.length - 1)],
      pos: { x: 0, z: 0 }, y: 0, heading: 0, headingTarget: 0, turnRate: 0,
      mode: 'wander', speed: 0, bumpCooldown: 0,
      walkSpeed: this.rng.range(WALK_MIN, WALK_MAX),
      phase: this.rng.range(0, 10),
      ix, iz, corner: this.rng.int(0, 3), dir: this.rng.chance(0.5) ? 1 : -1, edgeT: this.rng.next(),
      lateral: 0,
      crossFrom: { x: 0, z: 0 }, crossTo: { x: 0, z: 0 }, crossT: 0, crossDur: 1,
      crossIx: 0, crossIz: 0, crossCorner: 0,
      waitCorner: 0, waitUntil: 0, idleUntil: 0,
      fleeUntil: 0, fleeX: 0, fleeZ: 1,
      downT: 0, fallClip: null, fallRate: 1,
      returnTo: { x: 0, z: 0 }, returnCorner: 0, returnT: 0,
      tumbleT: 0, tumbleAxis: new THREE.Vector3(0, 1, 0), tumbleFrom: { x: 0, z: 0 }, tumbleTo: { x: 0, z: 0 },
    };
    this.syncEdgePos(p);
    p.heading = p.headingTarget;
    p.speed = p.walkSpeed;
    return p;
  }

  /** Place a wandering pedestrian from its edge parameter, plus its sidestep. */
  private syncEdgePos(p: Ped): void {
    const cs = this.corners(p.ix, p.iz);
    const a = cs[p.corner], b = cs[(p.corner + p.dir + 4) % 4];
    const hx = b.x - a.x, hz = b.z - a.z;
    const len = Math.hypot(hx, hz) || 1;
    // Right of the direction of travel is (hz, -hx).
    const rx = hz / len, rz = -hx / len;
    p.pos.x = a.x + hx * p.edgeT + rx * p.lateral;
    p.pos.z = a.z + hz * p.edgeT + rz * p.lateral;
    if (len > 1e-4) p.headingTarget = Math.atan2(hx, hz);
  }

  // --- the view test ---------------------------------------------------------

  private beginFrame(): void {
    const cam = this.host.camera;
    this.hasFrustum = false;
    if (!cam) return;
    cam.updateMatrixWorld();
    PROJ.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    FRUSTUM.setFromProjectionMatrix(PROJ);
    this.hasFrustum = true;
  }

  /** Is this point on screen? Without a camera, nothing is. */
  private inView(x: number, z: number, margin = 2): boolean {
    if (!this.hasFrustum) return false;
    for (const [dx, dz] of [[0, 0], [margin, 0], [-margin, 0], [0, margin], [0, -margin]]) {
      if (FRUSTUM.containsPoint(PT.set(x + dx, 1, z + dz))) return true;
    }
    return false;
  }

  update(dt: number): void {
    const player = this.playerPos();
    this.beginFrame();
    this.mesh.begin();

    this.crowd = new SpatialHash<Ped>(4);
    for (const p of this.peds) this.crowd.insertPoint(p.pos, p);

    for (const p of this.peds) {
      // Recycling: far away, on their feet, and off screen. Nobody is taken
      // mid-knockdown, and nobody is taken while the camera can see them.
      const onFeet = p.mode !== 'tumble' && p.mode !== 'down';
      if (onFeet && p.mode !== 'ride' && Math.hypot(p.pos.x - player.x, p.pos.z - player.z) > RECYCLE_DIST
        && !this.inView(p.pos.x, p.pos.z)) {
        this.recycle(p);
      }

      const prevHeading = p.heading;
      if (p.mode === 'return') this.stepReturn(p, dt);
      else if (p.mode === 'down') {
        stepDown(p, dt, player, () => this.canDespawn(p), () => this.recycle(p), () => this.resumeWander(p), this.mesh);
        this.bumpDowned(p, dt);
      }
      else if (p.mode === 'tumble') this.stepTumble(p, dt);
      else if (p.mode === 'flee') this.stepFlee(p, dt);
      else if (p.mode === 'cross') this.stepCross(p, dt);
      else if (p.mode === 'wait') this.stepWait(p, dt);
      else if (p.mode === 'idle') this.stepIdle(p, dt);
      else if (p.mode === 'ride') this.stepRide(p, dt);
      else this.stepWander(p, dt, player);

      if (onFeet && p.mode !== 'ride') {
        if (!this.checkHit(p)) this.checkFleeTrigger(p);
      }
      if (p.mode === 'return') this.pushOut(p);
      // The wander and crossing paths are laid out clear of the buildings, but
      // a flee is a straight line for three seconds and a tumble is a shove, and
      // neither asked the world whether there was a wall there.
      if (p.mode === 'flee' || p.mode === 'tumble' || p.mode === 'down') this.pushOut(p);

      if (p.mode !== 'tumble' && p.mode !== 'ride') p.y = this.groundAt(p.pos.x, p.pos.z);
      this.turnHeading(p, dt);
      p.turnRate = dt > 0 ? wrapAngle(p.heading - prevHeading) / dt : 0;
      this.updatePose(p, dt);
    }
    this.mesh.commit();
  }

  /** Swing the heading toward its target at a bounded rate. */
  private turnHeading(p: Ped, dt: number): void {
    const diff = wrapAngle(p.headingTarget - p.heading);
    const step = TURN_RATE * dt;
    p.heading = Math.abs(diff) <= step ? p.headingTarget : p.heading + Math.sign(diff) * step;
    p.heading = wrapAngle(p.heading);
  }

  /** Ease the speed toward what the mode wants. */
  private approachSpeed(p: Ped, target: number, dt: number): void {
    const diff = target - p.speed;
    const step = ACCEL * dt;
    p.speed = Math.abs(diff) <= step ? target : p.speed + Math.sign(diff) * step;
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

  /** A body may leave the world only once it is far away AND off screen. */
  private canDespawn(p: Ped): boolean {
    const player = this.playerPos();
    return Math.hypot(p.pos.x - player.x, p.pos.z - player.z) > K.despawnDistance
      && !this.inView(p.pos.x, p.pos.z, 4);
  }

  /**
   * Move a pedestrian to a fresh block near the player, out of sight.
   *
   * Candidates are tried until one is both far enough and off screen; if none
   * is, the pedestrian is left exactly where it is and the next frame tries
   * again. That "give up for now" is what keeps the crowd from ever popping in
   * front of the camera.
   */
  private recycle(p: Ped): void {
    const player = this.playerPos();
    const cix = clampInt(Math.round((player.x + HALF_X) / PITCH - 0.5), 0, CFG.city.blocksX - 1);
    const ciz = clampInt(Math.round((player.z + HALF_Z) / PITCH - 0.5), 0, CFG.city.blocksZ - 1);
    const pierNear = Math.hypot(player.x - (PIER.minX + PIER.maxX) / 2, player.z - PIER.maxZ) < PIER_NEAR;
    for (let tries = 0; tries < 12; tries++) {
      const onPier = pierNear && this.rng.chance(PIER_RECYCLE_PROB);
      const ix = onPier ? PIER_BLOCK : clampInt(cix + this.rng.int(-4, 4), 0, CFG.city.blocksX - 1);
      const iz = onPier ? 0 : clampInt(ciz + this.rng.int(-4, 4), 0, CFG.city.blocksZ - 1);
      const corner = this.rng.int(0, 3);
      const dir: 1 | -1 = this.rng.chance(0.5) ? 1 : -1;
      const edgeT = this.rng.next();
      const cs = this.corners(ix, iz);
      const a = cs[corner], b = cs[(corner + dir + 4) % 4];
      const x = a.x + (b.x - a.x) * edgeT, z = a.z + (b.z - a.z) * edgeT;
      const d = Math.hypot(x - player.x, z - player.z);
      // Not too near to be seen arriving, and not so far they are recycled
      // straight back next frame.
      if (d < RESPAWN_MIN_DIST || d > RECYCLE_DIST - 40) continue;
      if (this.inView(x, z, 6)) continue;
      p.ix = ix; p.iz = iz; p.corner = corner; p.dir = dir; p.edgeT = edgeT;
      p.lateral = 0;
      p.mode = 'wander';
      p.fallClip = null;
      p.fallRate = 1;
      p.downT = 0;
      p.walkSpeed = this.rng.range(WALK_MIN, WALK_MAX);
      this.syncEdgePos(p);
      p.heading = p.headingTarget;
      p.speed = p.walkSpeed;
      this.recycled++;
      return;
    }
  }

  // --- wander / cross ------------------------------------------------------

  /** Length of the edge a wanderer is on: a block side, or a pier side. */
  private edgeLength(p: Ped): number {
    if (p.ix !== PIER_BLOCK) return EDGE_LEN;
    const cs = this.corners(p.ix, p.iz);
    const a = cs[p.corner], b = cs[(p.corner + p.dir + 4) % 4];
    return Math.max(1, Math.hypot(b.x - a.x, b.z - a.z));
  }

  private stepWander(p: Ped, dt: number, player: Vec2): void {
    this.approachSpeed(p, p.walkSpeed, dt);
    this.sidestep(p, dt, player);
    p.edgeT += (p.speed * dt) / this.edgeLength(p);
    if (p.edgeT >= 1) {
      p.edgeT = 1;
      this.syncEdgePos(p);
      this.arriveAtCorner(p);
    } else {
      this.syncEdgePos(p);
    }
  }

  /**
   * Step round anyone in the way, along the walking line's own right-hand
   * side. The offset decays back to the line once the way is clear, so the
   * crowd flows past itself and past the player instead of walking through.
   */
  private sidestep(p: Ped, dt: number, player: Vec2): void {
    let push = 0;
    const rx = Math.cos(p.heading), rz = -Math.sin(p.heading); // right of heading
    this.near = this.crowd.query(p.pos, 2.5, this.near);
    for (const o of this.near) {
      if (o === p || o.mode === 'down' || o.mode === 'tumble') continue;
      const dx = o.pos.x - p.pos.x, dz = o.pos.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > SEP_PED || d < 1e-3) continue;
      const side = dx * rx + dz * rz; // positive: they are on my right
      push += (side >= 0 ? -1 : 1) * (1 - d / SEP_PED) * 2.4;
    }
    const pdx = player.x - p.pos.x, pdz = player.z - p.pos.z;
    const pd = Math.hypot(pdx, pdz);
    if (pd < SEP_PLAYER && pd > 1e-3) {
      const side = pdx * rx + pdz * rz;
      push += (side >= 0 ? -1 : 1) * (1 - pd / SEP_PLAYER) * 3.5;
    }
    p.lateral += push * dt;
    // Back to the line once clear.
    p.lateral -= p.lateral * Math.min(1, 1.4 * dt);
    p.lateral = Math.max(-SEP_MAX_LATERAL, Math.min(SEP_MAX_LATERAL, p.lateral));
  }

  private arriveAtCorner(p: Ped): void {
    const bIdx = (p.corner + p.dir + 4) % 4;
    if (this.signals) {
      // Some want to go over: they wait for the walk phase at this kerb.
      if (this.rng.chance(CROSS_WANT_PROB) && this.canCrossFrom(p, bIdx)) {
        if (this.tryStartCrossing(p, bIdx)) return;
        p.mode = 'wait';
        p.waitCorner = bIdx;
        p.waitUntil = this.host.time + WAIT_MAX;
        p.corner = bIdx;
        p.edgeT = 0;
        p.lateral = 0;
        this.syncEdgePos(p);
        // Face the road they mean to cross.
        const side = sideBetween((bIdx - p.dir + 4) % 4, bIdx);
        p.headingTarget = SIDE_AXIS[side] === 'x'
          ? Math.atan2(SIDE_SIGN[side], 0) : Math.atan2(0, SIDE_SIGN[side]);
        return;
      }
    } else if (this.rng.chance(CROSS_PROB) && this.tryStartCrossing(p, bIdx)) {
      return;
    }
    // Otherwise round the corner, the same way they were going. Never an
    // about-face: that was the one thing that made the old crowd read as
    // tokens on a track.
    p.corner = bIdx;
    p.edgeT = 0;
    this.syncEdgePos(p);
    if (this.rng.chance(IDLE_PROB)) {
      p.mode = 'idle';
      p.idleUntil = this.host.time + this.rng.range(IDLE_MIN, IDLE_MAX);
    }
  }

  /** Is there a block on the other side of this corner's road to cross to? */
  private canCrossFrom(p: Ped, cornerIdx: number): boolean {
    if (p.ix === PIER_BLOCK) return false;
    const side = sideBetween(p.corner, cornerIdx);
    const [dix, diz] = SIDE_DELTA[side];
    const nix = p.ix + dix, niz = p.iz + diz;
    return nix >= 0 && nix < CFG.city.blocksX && niz >= 0 && niz < CFG.city.blocksZ;
  }

  /** Pinned to a seat: the seat says where. */
  private stepRide(p: Ped, dt: number): void {
    const seats = this.riders();
    const mine = this.peds.filter((q) => q.mode === 'ride').indexOf(p);
    const seat = seats[mine];
    if (!seat) { p.mode = 'wander'; return; }
    this.approachSpeed(p, 0, dt);
    p.pos.x = seat.x; p.pos.z = seat.z; p.y = seat.y;
    p.heading = p.headingTarget = seat.heading;
  }

  private stepIdle(p: Ped, dt: number): void {
    this.approachSpeed(p, 0, dt);
    if (this.host.time >= p.idleUntil) p.mode = 'wander';
  }

  private stepWait(p: Ped, dt: number): void {
    this.approachSpeed(p, 0, dt);
    // The corner they are waiting at is `p.corner`; the crossing leaves from it
    // toward the neighbour across the road on the side they came along.
    const fromCorner = (p.corner - p.dir + 4) % 4;
    if (this.tryStartCrossing(p, p.corner, fromCorner)) return;
    if (this.host.time >= p.waitUntil) {
      // Light never came, or the road never cleared: carry on round the block.
      p.mode = 'wander';
      this.syncEdgePos(p);
    }
  }

  /**
   * Start across from `cornerIdx`, the corner the pedestrian is standing at or
   * arriving at, along the side they arrived by (`prevCorner`, the corner
   * behind them). With signals the road's traffic must be on red with time to
   * spare; always, no car may be near the middle of the crossing.
   */
  private tryStartCrossing(p: Ped, cornerIdx: number, prevCorner = p.corner): boolean {
    if (p.ix === PIER_BLOCK) return false;
    const side = sideBetween(prevCorner, cornerIdx);
    const [dix, diz] = SIDE_DELTA[side];
    const nix = p.ix + dix, niz = p.iz + diz;
    if (nix < 0 || nix >= CFG.city.blocksX || niz < 0 || niz >= CFG.city.blocksZ) return false;
    // The road being crossed runs across the crossing direction; its traffic
    // has to be on red.
    if (this.signals) {
      const roadAxis: 'x' | 'z' = SIDE_AXIS[side] === 'x' ? 'z' : 'x';
      if (!this.signals.walkAcross(cornerNode(p.ix, p.iz, cornerIdx), roadAxis)) return false;
    }

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
    p.crossDur = Math.max(0.3, Math.hypot(to.x - from.x, to.z - from.z) / p.walkSpeed);
    p.crossIx = nix;
    p.crossIz = niz;
    p.crossCorner = nearestCornerIndex(this.corners(nix, niz), to);
    p.lateral = 0;
    const hx = to.x - from.x, hz = to.z - from.z;
    p.headingTarget = Math.atan2(hx, hz);
    return true;
  }

  private crossingSafe(a: Vec2, b: Vec2): boolean {
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    for (const v of this.vehicles) {
      if (Math.hypot(v.pos.x - mx, v.pos.z - mz) < CROSS_CHECK_RADIUS) return false;
    }
    return true;
  }

  /** A moving car close to a crossing pedestrian makes them hurry. */
  private carNearWhileCrossing(p: Ped): boolean {
    for (const v of this.vehicles) {
      if (v.wrecked || Math.abs(v.speed) < 2) continue;
      if (Math.hypot(v.pos.x - p.pos.x, v.pos.z - p.pos.z) < CROSS_HURRY_RADIUS) return true;
    }
    return false;
  }

  private stepCross(p: Ped, dt: number): void {
    const hurry = this.carNearWhileCrossing(p);
    this.approachSpeed(p, hurry ? CFG.peds.fleeSpeed * 0.6 : p.walkSpeed, dt);
    const len = Math.hypot(p.crossTo.x - p.crossFrom.x, p.crossTo.z - p.crossFrom.z) || 1;
    p.crossT += (p.speed * dt) / len;
    if (p.crossT >= 1) {
      p.pos.x = p.crossTo.x; p.pos.z = p.crossTo.z;
      p.ix = p.crossIx; p.iz = p.crossIz; p.corner = p.crossCorner;
      // Carry on in the direction that keeps them walking away from the road
      // they just crossed: the corner they land on has two edges, and the one
      // that continues the walk is the one not running back along that road.
      p.dir = this.continueDir(p);
      p.edgeT = 0;
      p.mode = 'wander';
      this.syncEdgePos(p);
    } else {
      p.pos.x = p.crossFrom.x + (p.crossTo.x - p.crossFrom.x) * p.crossT;
      p.pos.z = p.crossFrom.z + (p.crossTo.z - p.crossFrom.z) * p.crossT;
      const hx = p.crossTo.x - p.crossFrom.x, hz = p.crossTo.z - p.crossFrom.z;
      if (Math.hypot(hx, hz) > 1e-4) p.headingTarget = Math.atan2(hx, hz);
    }
  }

  /** After a crossing, the edge direction that does not double back. */
  private continueDir(p: Ped): 1 | -1 {
    const cs = this.corners(p.ix, p.iz);
    const a = cs[p.corner];
    const walked = { x: p.crossTo.x - p.crossFrom.x, z: p.crossTo.z - p.crossFrom.z };
    let best: 1 | -1 = 1, bestDot = -Infinity;
    for (const dir of [1, -1] as const) {
      const b = cs[(p.corner + dir + 4) % 4];
      const ex = b.x - a.x, ez = b.z - a.z;
      const dot = ex * walked.x + ez * walked.z;
      // Prefer the edge that continues forward; a tie (both perpendicular) is
      // broken at random.
      const score = dot + this.rng.range(0, 1e-3);
      if (score > bestDot) { bestDot = score; best = dir; }
    }
    return best;
  }

  // --- flee ------------------------------------------------------------------

  private checkFleeTrigger(p: Ped): void {
    let bestD = CFG.peds.fleeRadius, threat: Vec2 | null = null;
    for (const v of this.vehicles) {
      if (v.wrecked || Math.abs(v.speed) <= 6) continue;
      const d = Math.hypot(v.pos.x - p.pos.x, v.pos.z - p.pos.z);
      if (d < bestD) { bestD = d; threat = v.pos; }
    }
    if (!threat && p.mode !== 'flee') {
      for (const t of this.threats()) {
        const d = Math.hypot(t.x - p.pos.x, t.z - p.pos.z);
        if (d < bestD) { bestD = d; threat = t; }
      }
    }
    if (!threat) return;
    this.startFlee(p, threat);
  }

  private startFlee(p: Ped, from: Vec2, seconds = FLEE_SECONDS): void {
    const dx = p.pos.x - from.x, dz = p.pos.z - from.z;
    const d = Math.hypot(dx, dz) || 1;
    p.fleeX = dx / d; p.fleeZ = dz / d;
    p.fleeUntil = Math.max(p.fleeUntil, this.host.time + seconds);
    p.mode = 'flee';
    p.lateral = 0;
  }

  private stepFlee(p: Ped, dt: number): void {
    this.approachSpeed(p, CFG.peds.fleeSpeed, dt);
    p.pos.x += p.fleeX * p.speed * dt;
    p.pos.z += p.fleeZ * p.speed * dt;
    p.headingTarget = Math.atan2(p.fleeX, p.fleeZ);
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
    p.lateral = 0;
    // Already there, near enough: rejoin without the walk.
    if (Math.hypot(p.returnTo.x - p.pos.x, p.returnTo.z - p.pos.z) < 0.4) {
      this.joinPath(p);
      return;
    }
    p.mode = 'return';
  }

  /** Walk toward the pavement; rejoin the wander path on arrival. */
  private stepReturn(p: Ped, dt: number): void {
    this.approachSpeed(p, p.walkSpeed, dt);
    const dx = p.returnTo.x - p.pos.x, dz = p.returnTo.z - p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.25) { this.joinPath(p); return; }
    p.headingTarget = Math.atan2(dx, dz);
    const step = Math.min(d, p.speed * dt);
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

  /**
   * A car driving over somebody already on the ground. The body stays put and
   * the car takes a small jolt: a person is not a kerb, and pretending they are
   * solid would launch the car. Nobody is hurt -- they are already down, and
   * they get back up on the same timer as before.
   */
  private bumpDowned(p: Ped, dt: number): void {
    p.bumpCooldown = Math.max(0, p.bumpCooldown - dt);
    if (p.bumpCooldown > 0) return;
    for (const v of this.vehicles) {
      if (v.wrecked || Math.abs(v.speed) < HIT_SPEED_MIN) continue;
      if (!obbContainsPoint(v, p.pos.x, p.pos.z)) continue;
      v.shove?.(-v.forwardX * BUMP_SHOVE, -v.forwardZ * BUMP_SHOVE);
      p.bumpCooldown = BUMP_COOLDOWN;
      this.host.events.emit('vehicleHit', { x: p.pos.x, z: p.pos.z, impact: BUMP_IMPACT });
      return;
    }
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
    p.lateral = 0;
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
      p.heading = p.headingTarget = Math.atan2(p.fleeX, p.fleeZ);
      p.mode = 'flee';
      p.fleeUntil = this.host.time + FLEE_SECONDS;
    }
  }

  // --- rendering ---------------------------------------------------------------

  private updatePose(p: Ped, dt: number): void {
    this.mesh.pose(p, dt);
  }

  dispose(): void { this.mesh.dispose(); }
}
