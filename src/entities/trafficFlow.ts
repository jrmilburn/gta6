// Right of way for the AI traffic: who may enter an intersection, and how fast
// a car may go given everyone it is about to meet.
//
// traffic.ts steers along the lane graph; this decides the speed. Two ideas:
//
// *Node reservations.* A car approaching an intersection asks for it, naming
// the way it comes in and the way it will leave. It is let in when every car
// already holding the node is doing something compatible -- going straight on
// the same axis, or following it in from the same approach toward the same
// exit -- and otherwise waits at the line and asks again next frame. Holders
// let go once their wheels are on the far segment, or after a timeout so a
// wreck cannot lock a junction forever. The player's car is a holder with an
// unknown movement, which is compatible with nothing.
//
// *Path prediction.* Instead of a 30 degree cone in front of the bonnet -- which
// cannot see a car on the cross street until it is a collision -- each car is
// sampled a little way ahead along its OWN lane and the samples are compared.
// Two cars that will be within a car length of each other in the next second
// slow the one behind to the speed of the one in front.
import type { Lane, Vec2 } from '../types';
import { CFG } from '../config';
import type { CityLayout } from '../world/cityGen';
import type { Vehicle } from './vehicle';
import { laneNodeId, pointAtArc } from './laneDriver';

/** Where a car is on the graph, as traffic.ts keeps it. */
export interface FlowCar {
  car: Vehicle;
  laneId: number;
  arc: number;
  nextLaneId: number;
}

interface Hold {
  car: Vehicle;
  /** Approach direction 0..3, or -1 for "unknown, yields to nobody". */
  entry: number;
  exit: number;
  since: number;
}

/** A holder that has not moved on in this long is released regardless. */
const HOLD_TIMEOUT = 4;
/** Cars this far apart cannot meet within the prediction horizon. */
const NEIGHBOUR_RANGE = 40;
/** Moments ahead the paths are compared at, seconds. */
const HORIZON = [0.5, 1.0];
/** Predicted centres closer than this are a meeting. A car is 4.4 m long. */
const MEET = 5.4;
/** Following distance: this plus `GAP_PER_MS` for every m/s of speed. */
const GAP_MIN = 4;
const GAP_PER_MS = 0.6;
/** Closer than this behind a leader the target speed is zero. */
const GAP_STOP = 5.2;
const INTERSECTION_RADIUS = CFG.city.roadWidth * 0.8;

/** Which of the four compass directions a lane's last stretch runs in. */
function exitDir(lane: Lane): number {
  const a = lane.points[lane.points.length - 2] ?? lane.points[0];
  const b = lane.points[lane.points.length - 1];
  return quantise(b.x - a.x, b.z - a.z);
}

function quantise(dx: number, dz: number): number {
  if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? 0 : 2;
  return dz >= 0 ? 1 : 3;
}

export class TrafficFlow {
  private readonly holds = new Map<number, Hold[]>();
  private readonly out: Vec2 = { x: 0, z: 0 };
  private readonly mine: Vec2 = { x: 0, z: 0 };

  constructor(private readonly city: CityLayout) {}

  /**
   * Once per frame, before any car is steered: drop the holders who have left
   * or timed out, and register the player's car wherever it is inside a box.
   */
  begin(cars: readonly FlowCar[], player: Vehicle | null, time: number): void {
    const lanes = this.city.roads.lanes;
    for (const [node, list] of this.holds) {
      for (let i = list.length - 1; i >= 0; i--) {
        const h = list[i];
        if (h.entry === -1) { list.splice(i, 1); continue; } // the player, re-registered below
        const a = cars.find((c) => c.car === h.car);
        const stillInside = a !== undefined && !a.car.wrecked
          && (laneNodeId(lanes[a.laneId]) === node
            || (laneNodeId(lanes[a.nextLaneId]) === node && lanes[a.laneId].length - a.arc < 1));
        if (!stillInside || time - h.since > HOLD_TIMEOUT) list.splice(i, 1);
      }
      if (list.length === 0) this.holds.delete(node);
    }
    if (player) {
      for (const node of this.city.roads.nodes) {
        if (Math.hypot(player.pos.x - node.pos.x, player.pos.z - node.pos.z) > INTERSECTION_RADIUS) continue;
        this.list(node.id).push({ car: player, entry: -1, exit: -1, since: time });
      }
    }
  }

  /**
   * May `a` drive into the intersection at the end of its lane? Grants and
   * records the hold when it may. Connector-to-connector moves are always
   * allowed: the car is already inside.
   */
  mayEnter(a: FlowCar, time: number): boolean {
    const lanes = this.city.roads.lanes;
    const connector = lanes[a.nextLaneId];
    const node = laneNodeId(connector);
    if (node === null) return true;
    const entry = exitDir(lanes[a.laneId]);
    const exit = exitDir(connector);
    const list = this.list(node);
    const held = list.find((h) => h.car === a.car);
    if (held) return true;
    for (const h of list) {
      if (!compatible(entry, exit, h.entry, h.exit)) return false;
    }
    list.push({ car: a.car, entry, exit, since: time });
    return true;
  }

  /**
   * The speed `a` should be doing given the cars around it, m/s. `cruise` when
   * the road is clear; the leader's speed when following; zero right behind
   * one. Never negative.
   */
  targetSpeed(a: FlowCar, cars: readonly FlowCar[], player: Vehicle | null, cruise: number): number {
    const car = a.car;
    let target = cruise;
    const gap = GAP_MIN + Math.max(0, car.speed) * GAP_PER_MS;

    const consider = (other: Vehicle, ahead: (t: number) => Vec2 | null): void => {
      if (other === car || other.wrecked) return;
      const dx = other.pos.x - car.pos.x, dz = other.pos.z - car.pos.z;
      const d0 = Math.hypot(dx, dz);
      if (d0 > NEIGHBOUR_RANGE || d0 < 0.01) return;
      const forward = (dx * car.forwardX + dz * car.forwardZ) / d0;
      // Following: inside the gap and broadly in front.
      if (forward > 0.5 && d0 < gap) {
        const lead = Math.max(0, other.speed);
        target = Math.min(target, d0 < GAP_STOP ? 0 : lead * ((d0 - GAP_STOP) / Math.max(gap - GAP_STOP, 0.1)) + lead * 0.2);
      }
      // Meeting: where the two of us are about to be, along our own lanes.
      for (const t of HORIZON) {
        const theirs = ahead(t);
        if (!theirs) break;
        this.predict(a, t, this.mine);
        const dist = Math.hypot(theirs.x - this.mine.x, theirs.z - this.mine.z);
        if (dist > MEET) continue;
        // The one that is further from the meeting point yields; a tie goes to
        // whoever is on the right, which is the same rule people use.
        const myDist = Math.hypot(this.mine.x - car.pos.x, this.mine.z - car.pos.z);
        const theirDist = Math.hypot(theirs.x - other.pos.x, theirs.z - other.pos.z);
        const onMyRight = (dx * car.forwardZ - dz * car.forwardX) < 0;
        if (myDist > theirDist + 0.5 || (Math.abs(myDist - theirDist) <= 0.5 && onMyRight)) {
          target = Math.min(target, Math.max(0, other.speed) * 0.6, forward > 0 ? Math.max(0, d0 - GAP_STOP) : cruise);
        }
        break;
      }
    };

    for (const o of cars) consider(o.car, (t) => this.predict(o, t, this.out));
    if (player) {
      consider(player, (t) => {
        // The player follows no lane; extrapolate along their velocity.
        this.out.x = player.pos.x + player.forwardX * player.speed * t;
        this.out.z = player.pos.z + player.forwardZ * player.speed * t;
        return this.out;
      });
    }
    return Math.max(0, target);
  }

  /** Where `a` will be in `t` seconds at its current speed, along its lanes. */
  private predict(a: FlowCar, t: number, out: Vec2): Vec2 {
    const lanes = this.city.roads.lanes;
    let lane = lanes[a.laneId];
    let arc = a.arc + Math.max(0, a.car.speed) * t;
    if (arc > lane.length) {
      arc -= lane.length;
      lane = lanes[a.nextLaneId];
      if (arc > lane.length) {
        const succ = this.city.roads.successors(lane.id);
        if (succ.length > 0) { arc -= lane.length; lane = succ[0]; }
      }
    }
    const p = pointAtArc(lane, arc);
    out.x = p.x; out.z = p.z;
    return out;
  }

  private list(node: number): Hold[] {
    let l = this.holds.get(node);
    if (!l) { l = []; this.holds.set(node, l); }
    return l;
  }
}

/**
 * Can two movements through one intersection happen at the same time?
 * Straight on along the same axis, either way: yes. The same approach and the
 * same exit: yes, that is a queue. Anything involving a turn, or an unknown
 * movement (the player): no.
 */
function compatible(entry: number, exit: number, hEntry: number, hExit: number): boolean {
  if (hEntry === -1 || entry === -1) return false;
  if (entry === hEntry && exit === hExit) return true;
  const straight = entry === exit, hStraight = hEntry === hExit;
  if (straight && hStraight && (entry % 2) === (hEntry % 2)) return true;
  return false;
}
