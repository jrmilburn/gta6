// Driving the lane graph: the pure-pursuit steering traffic.ts uses, split
// out so a police cruiser on patrol, or one routing across town toward a
// chase, drives exactly like the traffic does. One controller, two callers.
import type { Lane, Vec2 } from '../types';
import type { CityLayout } from '../world/cityGen';
import type { Vehicle } from './vehicle';

const LOOKAHEAD = 6;
const STEER_GAIN = 2.4;

/** Connector lanes have from === to === the intersection node id. */
export function laneNodeId(lane: Lane): number | null {
  return lane.from === lane.to ? lane.from : null;
}

export function pointAtArc(lane: Lane, arc: number): Vec2 {
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

export function headingAlong(lane: Lane, arc: number): number {
  const p = pointAtArc(lane, arc);
  const ahead = pointAtArc(lane, Math.min(lane.length, arc + 1));
  const dx = ahead.x - p.x, dz = ahead.z - p.z;
  return Math.hypot(dx, dz) > 1e-4 ? Math.atan2(dx, dz) : 0;
}

/** Which road axis a straight segment lane runs along. */
export function laneAxis(lane: Lane): 'x' | 'z' {
  const a = lane.points[0], b = lane.points[lane.points.length - 1];
  return Math.abs(b.x - a.x) >= Math.abs(b.z - a.z) ? 'x' : 'z';
}

/** Where a car is along the graph, and where it is going next. */
export interface LaneState {
  laneId: number;
  /** Metres travelled along the current lane. */
  arc: number;
  nextLaneId: number;
  /** A route to follow, front first; empty means choose at random. */
  route: number[];
}

/**
 * Put a car onto the graph at its current position, with a fresh next lane.
 * `pick` chooses among the successors; random by default.
 */
export function anchorOnLane(
  city: CityLayout, pos: Vec2, pick: (options: Lane[]) => Lane | null = () => null,
): LaneState {
  const { lane, t } = city.roads.nearestLane(pos);
  const st: LaneState = { laneId: lane.id, arc: t * lane.length, nextLaneId: lane.id, route: [] };
  st.nextLaneId = chooseNext(city, st, pick);
  return st;
}

function chooseNext(city: CityLayout, st: LaneState, pick: (options: Lane[]) => Lane | null): number {
  if (st.route.length > 0) {
    // Follow the route while it is still consistent with where we are.
    while (st.route.length > 0 && st.route[0] === st.laneId) st.route.shift();
    const succ = city.roads.successors(st.laneId);
    const planned = st.route.length > 0 ? succ.find((l) => l.id === st.route[0]) : undefined;
    if (planned) return planned.id;
    st.route.length = 0;
  }
  const succ = city.roads.successors(st.laneId);
  if (succ.length === 0) return st.laneId;
  return (pick(succ) ?? succ[Math.floor(Math.random() * succ.length)]).id;
}

/**
 * Advance the arc by the car's speed and hand back the intersection node it
 * is about to enter, if any. `onNode` is asked whether to pause there; the
 * caller decides what that means (traffic waits, police do not).
 */
export function advanceAlong(
  city: CityLayout, st: LaneState, car: Vehicle, dt: number,
  pick: (options: Lane[]) => Lane | null = () => null,
  onNode?: (nodeId: number) => void,
): Lane {
  let lane = city.roads.lanes[st.laneId];
  st.arc += Math.max(0, car.speed) * dt;
  let guard = 0;
  while (st.arc >= lane.length && guard++ < 4) {
    st.arc -= lane.length;
    const entering = laneNodeId(city.roads.lanes[st.nextLaneId]);
    if (entering !== null) onNode?.(entering);
    st.laneId = st.nextLaneId;
    lane = city.roads.lanes[st.laneId];
    st.nextLaneId = chooseNext(city, st, pick);
  }
  return lane;
}

/** The pure-pursuit steer toward the look-ahead point, -1..1, positive = car's right. */
export function steerAlong(city: CityLayout, st: LaneState, car: Vehicle): number {
  const lane = city.roads.lanes[st.laneId];
  const target = st.arc + LOOKAHEAD;
  const look = target <= lane.length
    ? pointAtArc(lane, target)
    : pointAtArc(city.roads.lanes[st.nextLaneId], target - lane.length);
  const dx = look.x - car.pos.x, dz = look.z - car.pos.z;
  const localX = dx * car.forwardZ - dz * car.forwardX;
  const localZ = dx * car.forwardX + dz * car.forwardZ;
  const angle = Math.atan2(localX, Math.max(0.01, localZ));
  // `angle` is positive toward +X and `controls.steer` is positive to the
  // car's right, which is -X.
  return -Math.max(-1, Math.min(1, angle * STEER_GAIN));
}

/** Throttle to hold `cruise` m/s. */
export function throttleFor(car: Vehicle, cruise: number): number {
  if (car.speed < cruise) return 1;
  if (car.speed > cruise + 1) return -0.4;
  return 0.15;
}

/**
 * Plan a route to `to` and measure it, in one A*: the lane ids to follow and
 * the metres along them. `Infinity` when there is no path.
 */
export function planRoute(city: CityLayout, st: LaneState, to: Vec2): { ids: number[]; distance: number } {
  const lane = city.roads.lanes[st.laneId];
  const goal = city.roads.nearestLane(to);
  if (goal.lane.id === st.laneId) return { ids: [], distance: Math.abs(goal.t * lane.length - st.arc) };
  const path = city.roads.path(st.laneId, goal.lane.id);
  if (path.length === 0) return { ids: [], distance: Infinity };
  let d = lane.length - st.arc;
  for (let i = 1; i < path.length - 1; i++) d += path[i].length;
  d += goal.t * goal.lane.length;
  return { ids: path.map((l) => l.id), distance: d };
}
