// AI cars on the lane graph (plan section 6). Traffic vehicles are ordinary
// `Vehicle` instances -- same class, same arcade physics -- so the player can
// crash into and steal them; only the pure-pursuit control layer here is new.
import type { Lane, System, Vec2, VehicleKind } from '../types';
import type { Game } from '../core/game';
import { CFG } from '../config';
import { Rng } from '../core/rng';
import type { CityLayout } from '../world/cityGen';
import type { SignalSystem } from '../world/signals';
import { Vehicle } from './vehicle';
import { TrafficFlow } from './trafficFlow';

const KINDS: VehicleKind[] = ['sedan', 'sports', 'pickup'];
const MIN_SPAWN_DIST = 60;
const RECYCLE_DIST = 250;
const LOOKAHEAD = 6;
const STEER_GAIN = 2.4;
/** Stopped with the throttle down this long, and nothing to wait for: stuck. */
const STUCK_AFTER = 1.5;
const REVERSE_FOR = 0.8;
const THREE_CLAMP = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
/**
 * Where a car starts braking for a red, metres before the end of its lane
 * (the lane ends at the kerb line of the intersection, which is the stop
 * line). Cruise is 14 m/s and the arcade brake stops that in about ten metres.
 */
const STOP_ZONE = 13;
/** Inside this, an amber is driven through rather than braked for. */
const AMBER_COMMIT = 7;

interface AiCar {
  car: Vehicle;
  laneId: number;
  arc: number;         // metres travelled along the current lane
  nextLaneId: number;  // chosen at the previous intersection, via successors()
  blockedFor: number;  // seconds continuously stopped behind the player
  stuckFor: number;    // seconds stopped with the throttle down and nothing to wait for
  reverseUntil: number; // > game.time while backing out of whatever it is stuck on
  wasOccupied: boolean;
}

/** Connector lanes have from === to === the intersection node id (plan note). */
function laneNodeId(lane: Lane): number | null {
  return lane.from === lane.to ? lane.from : null;
}

function pointAtArc(lane: Lane, arc: number): Vec2 {
  const s = Math.max(0, Math.min(lane.length, arc));
  const pts = lane.points;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    if (s <= acc + segLen || i === pts.length - 1) {
      const t = segLen > 0 ? Math.min(1, Math.max(0, (s - acc) / segLen)) : 0;
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    }
    acc += segLen;
  }
  return pts[pts.length - 1];
}

/** Which road axis a straight segment lane runs along. */
function laneAxis(lane: Lane): 'x' | 'z' {
  const a = lane.points[0], b = lane.points[lane.points.length - 1];
  return Math.abs(b.x - a.x) >= Math.abs(b.z - a.z) ? 'x' : 'z';
}

function headingAlong(lane: Lane, arc: number): number {
  const p = pointAtArc(lane, arc);
  const ahead = pointAtArc(lane, Math.min(lane.length, arc + 1));
  const dx = ahead.x - p.x, dz = ahead.z - p.z;
  return Math.hypot(dx, dz) > 1e-4 ? Math.atan2(dx, dz) : 0;
}

export class TrafficSystem implements System {
  readonly cars: Vehicle[] = [];
  private readonly ai: AiCar[] = [];
  private readonly rng: Rng;
  private readonly flow: TrafficFlow;
  private signals: SignalSystem | null = null;

  constructor(
    private readonly game: Game,
    private readonly city: CityLayout,
    private readonly playerPos: () => Vec2,
    private readonly getPlayerVehicle: () => Vehicle | null,
    seed = 90210,
  ) {
    this.rng = new Rng(seed);
    this.flow = new TrafficFlow(city);
    for (let i = 0; i < CFG.traffic.count; i++) this.spawnOne(i);
  }

  /** The traffic lights to obey. Without them every intersection is a green. */
  setSignals(signals: SignalSystem | null): void { this.signals = signals; }

  /**
   * Should this car be braking for the signal at the end of its lane? Only a
   * segment lane has a signal ahead (connectors are already inside the box),
   * and only inside the stop zone; an amber close in is driven through.
   */
  private heldBySignal(a: AiCar, lane: Lane): boolean {
    if (!this.signals || lane.from === lane.to) return false;
    const enteringNode = laneNodeId(this.city.roads.lanes[a.nextLaneId]);
    if (enteringNode === null) return false;
    const remaining = lane.length - a.arc;
    if (remaining > STOP_ZONE) return false;
    const phase = this.signals.phaseFor(enteringNode, laneAxis(lane));
    if (phase === 'green') return false;
    if (phase === 'amber' && remaining < AMBER_COMMIT) return false;
    return true;
  }

  private pickLane(minDist: number, maxDist: number, behindOnly: boolean): { lane: Lane; arc: number } {
    const lanes = this.city.roads.segmentLanes;
    const player = this.playerPos();
    const pv = this.getPlayerVehicle();
    const fx = pv ? pv.forwardX : 0, fz = pv ? pv.forwardZ : 1;
    for (let guard = 0; guard < 80; guard++) {
      const id = lanes[this.rng.int(0, lanes.length - 1)];
      const lane = this.city.roads.lanes[id];
      const arc = this.rng.range(0, Math.max(1, lane.length));
      const p = pointAtArc(lane, arc);
      const dx = p.x - player.x, dz = p.z - player.z;
      const d = Math.hypot(dx, dz);
      if (d < minDist || d > maxDist) continue;
      if (behindOnly && dx * fx + dz * fz > 0) continue; // stay out of the windscreen
      return { lane, arc };
    }
    const id = lanes[this.rng.int(0, lanes.length - 1)];
    const lane = this.city.roads.lanes[id];
    return { lane, arc: lane.length * 0.5 };
  }

  private spawnOne(i: number): void {
    const { lane, arc } = this.pickLane(MIN_SPAWN_DIST, Infinity, false);
    const p = pointAtArc(lane, arc);
    const car = new Vehicle(this.game, {
      kind: KINDS[i % KINDS.length],
      pos: p,
      heading: headingAlong(lane, arc),
      colorIdx: this.rng.int(0, 12),
      colliders: this.city.colliders,
    });
    this.cars.push(car);
    this.ai.push(this.freshAi(car, lane, arc));
  }

  private freshAi(car: Vehicle, lane: Lane, arc: number): AiCar {
    const succ = this.city.roads.successors(lane.id);
    const nextLaneId = succ.length ? succ[this.rng.int(0, succ.length - 1)].id : lane.id;
    return { car, laneId: lane.id, arc, nextLaneId, blockedFor: 0, stuckFor: 0, reverseUntil: 0, wasOccupied: false };
  }

  /** Re-anchor an AI car onto the lane graph from wherever it physically is --
   * needed after the player steals and then abandons it (plan section 3's "AI
   * is ejected"), since its old lane/arc state is meaningless by then. */
  private resync(a: AiCar): void {
    const { lane, t } = this.city.roads.nearestLane(a.car.pos);
    const fresh = this.freshAi(a.car, lane, t * lane.length);
    a.laneId = fresh.laneId; a.arc = fresh.arc; a.nextLaneId = fresh.nextLaneId;
    a.blockedFor = 0; a.stuckFor = 0; a.reverseUntil = 0;
  }

  private respawnNearPlayer(a: AiCar): void {
    // DECISION: "out of view" is approximated as behind the player's current
    // heading rather than a real frustum test, to avoid coupling this file to
    // camera/cameras.ts (outside this phase's ownership).
    const { lane, arc } = this.pickLane(70, 160, true);
    const p = pointAtArc(lane, arc);
    a.car.reset(p.x, p.z, headingAlong(lane, arc));
    const fresh = this.freshAi(a.car, lane, arc);
    a.laneId = fresh.laneId; a.arc = fresh.arc; a.nextLaneId = fresh.nextLaneId;
    a.blockedFor = 0; a.stuckFor = 0; a.reverseUntil = 0;
  }

  update(_dt: number): void {
    const playerVehicle = this.getPlayerVehicle();
    const player = this.playerPos();
    this.flow.begin(this.ai, playerVehicle, this.game.time);
    for (const a of this.ai) {
      const car = a.car;
      // Stolen: the player is driving this car now, so PlayerDriver owns its
      // controls -- the AI must not fight it (plan section 3's "AI is ejected").
      if (car.occupied) { a.blockedFor = 0; a.wasOccupied = true; continue; }
      if (a.wasOccupied) { this.resync(a); a.wasOccupied = false; }
      if (Math.hypot(car.pos.x - player.x, car.pos.z - player.z) > RECYCLE_DIST) {
        this.respawnNearPlayer(a);
        continue;
      }
      if (car.wrecked) continue; // sits where it crashed, like debris
      this.steer(a, _dt, playerVehicle);
    }
  }

  private steer(a: AiCar, dt: number, playerVehicle: Vehicle | null): void {
    const car = a.car;
    const roads = this.city.roads;
    let lane = roads.lanes[a.laneId];
    const now = this.game.time;

    car.controls.handbrake = false;
    // Backing out of whatever it is stuck on, wheel turned; then a fresh anchor.
    if (now < a.reverseUntil) {
      car.controls.throttle = -1;
      car.controls.steer = 0.6;
      if (now + dt >= a.reverseUntil) this.resync(a);
      return;
    }

    a.arc += Math.max(0, car.speed) * dt;
    // Held at the line -- by a red, or by somebody already in the box -- the arc
    // stops at the lane end, so the car cannot creep through on the brake's
    // last half metre per second.
    let waiting = false;
    if (a.arc >= lane.length) {
      const atLine = { ...a, arc: lane.length - 0.01 };
      if (this.heldBySignal(atLine, lane) || !this.flow.mayEnter(a, now)) {
        a.arc = lane.length - 0.01;
        waiting = true;
      }
    }
    let guard = 0;
    while (a.arc >= lane.length && guard++ < 4) {
      a.arc -= lane.length;
      a.laneId = a.nextLaneId;
      lane = roads.lanes[a.laneId];
      const succ = roads.successors(a.laneId);
      a.nextLaneId = succ.length ? succ[this.rng.int(0, succ.length - 1)].id : a.laneId;
    }

    const look = this.lookahead(lane, a.arc, a.nextLaneId);
    const dx = look.x - car.pos.x, dz = look.z - car.pos.z;
    const localX = dx * car.forwardZ - dz * car.forwardX;
    const localZ = dx * car.forwardX + dz * car.forwardZ;
    const angle = Math.atan2(localX, Math.max(0.01, localZ));
    let steer = Math.max(-1, Math.min(1, angle * STEER_GAIN));

    // How fast to go: the cruise, or whatever the cars around dictate, or
    // nothing at all while waiting at a line.
    const target = waiting || this.heldBySignal(a, lane)
      ? 0
      : this.flow.targetSpeed(a, this.ai, playerVehicle, CFG.traffic.cruiseSpeed);
    let throttle: number;
    if (target <= 0.05) {
      throttle = car.speed > 0.3 ? -1 : 0;
      steer *= 0.2;
    } else {
      // Eased toward the target rather than bang-bang, so a queue does not
      // concertina: full throttle only when well under, gentle brake when over.
      throttle = THREE_CLAMP((target - car.speed) * 0.5, -0.6, 1);
    }
    car.controls.throttle = throttle;
    // `angle` is positive toward +X and `controls.steer` is positive to the
    // car's right, which is -X. Negating here keeps the lane-following loop
    // pointing at its target rather than away from it.
    car.controls.steer = -steer;

    // Stopped behind the player: counted for the horn and the wanted system.
    const byPlayer = playerVehicle !== null && target <= 0.05 && car.speed < 0.5
      && Math.hypot(playerVehicle.pos.x - car.pos.x, playerVehicle.pos.z - car.pos.z) < CFG.traffic.followGap + 2;
    a.blockedFor = byPlayer ? a.blockedFor + dt : 0;

    // Stuck: throttle down, not moving, nothing in the way that the model knows
    // about. A car nosed into a kerb or another car's flank does this; a short
    // reverse and a fresh anchor gets it going again.
    const stuck = throttle > 0.5 && car.speed < 0.3 && !waiting;
    a.stuckFor = stuck ? a.stuckFor + dt : 0;
    if (a.stuckFor > STUCK_AFTER) {
      a.stuckFor = 0;
      a.reverseUntil = now + REVERSE_FOR;
    }
  }

  private lookahead(lane: Lane, arc: number, nextLaneId: number): Vec2 {
    const target = arc + LOOKAHEAD;
    if (target <= lane.length) return pointAtArc(lane, target);
    return pointAtArc(this.city.roads.lanes[nextLaneId], target - lane.length);
  }
}
