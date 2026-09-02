// Lane graph: a node at every intersection, two lanes per direction per segment,
// right-hand traffic, quadratic-Bezier connectors through every intersection.
// Pure math, no Three.js.
import { CFG } from '../config';
import type { Lane, RoadGraph, RoadNode, Vec2 } from '../types';
import { SpatialHash } from '../core/spatial';

const C = CFG.city;
const PITCH = C.blockSize + C.roadWidth;
const HALF = C.roadWidth / 2;
const NX = C.blocksX + 1;
const NZ = C.blocksZ + 1;

/** 0:+X 1:+Z 2:-X 3:-Z. Right of d is (d+1)%4, left is (d+3)%4. */
const DIR: readonly Vec2[] = [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }];

export interface CityRoadGraph extends RoadGraph {
  /** Lane id -> ids of the lanes that continue from its end point. */
  succ: Map<number, number[]>;
  successors(laneId: number): Lane[];
  /** Lane ids that are straight road segments (not intersection connectors). */
  segmentLanes: number[];
}

function len(a: Vec2, b: Vec2): number { return Math.hypot(b.x - a.x, b.z - a.z); }

function polylineLength(pts: Vec2[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += len(pts[i - 1], pts[i]);
  return s;
}

/** Minimal binary heap keyed by f-score, enough for A* over ~5k lanes. */
class Heap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size(): number { return this.ids.length; }
  push(id: number, key: number): void {
    this.ids.push(id); this.keys.push(key);
    let i = this.ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p); i = p;
    }
  }
  pop(): number {
    const top = this.ids[0];
    const lastId = this.ids.pop() as number, lastKey = this.keys.pop() as number;
    if (this.ids.length) {
      this.ids[0] = lastId; this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.ids.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.ids.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    const i = this.ids[a]; this.ids[a] = this.ids[b]; this.ids[b] = i;
    const k = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = k;
  }
}

export function buildRoadGraph(): CityRoadGraph {
  const nodes: RoadNode[] = [];
  for (let nz = 0; nz < NZ; nz++) {
    for (let nx = 0; nx < NX; nx++) {
      nodes.push({ id: nz * NX + nx, pos: { x: -PITCH * C.blocksX / 2 + nx * PITCH, z: -PITCH * C.blocksZ / 2 + nz * PITCH } });
    }
  }

  const lanes: Lane[] = [];
  const succ = new Map<number, number[]>();
  const segmentLanes: number[] = [];
  // outLane[node][dir][k] and inLane[node][dir][k] (dir = travel direction).
  const outLane: number[][][] = nodes.map(() => [[], [], [], []]);
  const inLane: number[][][] = nodes.map(() => [[], [], [], []]);

  const addLane = (from: number, to: number, offset: number, points: Vec2[]): Lane => {
    const lane: Lane = { id: lanes.length, from, to, offset, points, length: polylineLength(points) };
    lanes.push(lane);
    return lane;
  };

  // --- straight segment lanes -------------------------------------------------
  for (let nz = 0; nz < NZ; nz++) {
    for (let nx = 0; nx < NX; nx++) {
      const a = nz * NX + nx;
      for (const d of [0, 1]) {
        const bx = nx + (d === 0 ? 1 : 0), bz = nz + (d === 1 ? 1 : 0);
        if (bx >= NX || bz >= NZ) continue;
        const b = bz * NX + bx;
        for (const [from, to, dir] of [[a, b, d], [b, a, (d + 2) % 4]] as const) {
          const f = DIR[dir];
          const r = { x: -f.z, z: f.x };
          const p0 = nodes[from].pos, p1 = nodes[to].pos;
          for (let k = 0; k < 2; k++) {
            const off = C.laneWidth * (0.5 + k);
            const s = { x: p0.x + f.x * HALF + r.x * off, z: p0.z + f.z * HALF + r.z * off };
            const e = { x: p1.x - f.x * HALF + r.x * off, z: p1.z - f.z * HALF + r.z * off };
            const pts: Vec2[] = [];
            for (let i = 0; i <= 4; i++) pts.push({ x: s.x + (e.x - s.x) * (i / 4), z: s.z + (e.z - s.z) * (i / 4) });
            const lane = addLane(from, to, off, pts);
            outLane[from][dir][k] = lane.id;
            inLane[to][dir][k] = lane.id;
            segmentLanes.push(lane.id);
          }
        }
      }
    }
  }

  // --- intersection connectors -----------------------------------------------
  const has = (arr: number[]): boolean => arr.length === 2;
  for (const node of nodes) {
    const n = node.id;
    for (let din = 0; din < 4; din++) {
      if (!has(inLane[n][din])) continue;
      for (let k = 0; k < 2; k++) {
        // Right-hand traffic: the inner lane goes straight or turns left, the
        // kerb lane goes straight or turns right. Both may also change lane
        // while crossing, which is what keeps the graph strongly connected --
        // without it a kerb lane on the perimeter can never leave the edge.
        const left = (din + 3) % 4, right = (din + 1) % 4;
        const moves: Array<[number, number]> = k === 0
          ? [[din, 0], [din, 1], [left, 0]]
          : [[din, 1], [din, 0], [right, 1]];
        const src = lanes[inLane[n][din][k]];
        const p0 = src.points[src.points.length - 1];
        const fin = DIR[din];
        const outs: number[] = [];
        // At a corner a lane can lose every legal move; then take any exit.
        const legal = moves.filter(([d]) => has(outLane[n][d]));
        const chosen: Array<[number, number]> = legal.length > 0 ? legal
          : ([0, 1, 2, 3] as number[])
            .filter((d) => d !== (din + 2) % 4 && has(outLane[n][d]))
            .flatMap((d): Array<[number, number]> => [[d, 0], [d, 1]]);
        for (const [dout, kOut] of chosen) {
          const dst = lanes[outLane[n][dout][kOut]];
          const p2 = dst.points[0];
          const fout = DIR[dout];
          // Control point: where the two tangents meet (midpoint when parallel).
          const cr = fin.x * fout.z - fin.z * fout.x;
          let p1: Vec2;
          if (Math.abs(cr) < 1e-6) {
            p1 = { x: (p0.x + p2.x) / 2, z: (p0.z + p2.z) / 2 };
          } else {
            const t = ((p2.x - p0.x) * fout.z - (p2.z - p0.z) * fout.x) / cr;
            p1 = { x: p0.x + fin.x * t, z: p0.z + fin.z * t };
          }
          const pts: Vec2[] = [];
          for (let i = 0; i < 6; i++) {
            const t = i / 5, u = 1 - t;
            pts.push({
              x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
              z: u * u * p0.z + 2 * u * t * p1.z + t * t * p2.z,
            });
          }
          const con = addLane(n, n, dst.offset, pts);
          succ.set(con.id, [dst.id]);
          outs.push(con.id);
        }
        succ.set(src.id, outs);
      }
    }
  }
  for (const lane of lanes) if (!succ.has(lane.id)) succ.set(lane.id, []);

  // --- nearest-lane index -----------------------------------------------------
  const hash = new SpatialHash<Lane>(20);
  for (const lane of lanes) {
    for (const p of lane.points) hash.insertPoint(p, lane);
    // Long segment lanes need mid-samples so a 20 m cell is never skipped.
    for (let i = 1; i < lane.points.length; i++) {
      const a = lane.points[i - 1], b = lane.points[i];
      const steps = Math.ceil(len(a, b) / 8);
      for (let s = 1; s < steps; s++) {
        hash.insertPoint({ x: a.x + (b.x - a.x) * (s / steps), z: a.z + (b.z - a.z) * (s / steps) }, lane);
      }
    }
  }

  function closestOn(lane: Lane, p: Vec2): { d2: number; t: number } {
    let best = Infinity, bestArc = 0, arc = 0;
    for (let i = 1; i < lane.points.length; i++) {
      const a = lane.points[i - 1], b = lane.points[i];
      const dx = b.x - a.x, dz = b.z - a.z;
      const seg = dx * dx + dz * dz;
      let u = seg > 0 ? ((p.x - a.x) * dx + (p.z - a.z) * dz) / seg : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const qx = a.x + dx * u, qz = a.z + dz * u;
      const d2 = (p.x - qx) * (p.x - qx) + (p.z - qz) * (p.z - qz);
      if (d2 < best) { best = d2; bestArc = arc + Math.sqrt(seg) * u; }
      arc += Math.sqrt(seg);
    }
    return { d2: best, t: arc > 0 ? bestArc / arc : 0 };
  }

  const scratch: Lane[] = [];
  function nearestLane(p: Vec2): { lane: Lane; t: number } {
    let cands = hash.query(p, 26, scratch);
    if (cands.length === 0) cands = hash.query(p, 90, scratch);
    const pool: readonly Lane[] = cands.length ? cands : lanes;
    let best = lanes[0], bestT = 0, bestD = Infinity;
    for (const lane of pool) {
      const r = closestOn(lane, p);
      if (r.d2 < bestD) { bestD = r.d2; best = lane; bestT = r.t; }
    }
    return { lane: best, t: bestT };
  }

  // --- A* ---------------------------------------------------------------------
  const endOf = (l: Lane): Vec2 => l.points[l.points.length - 1];
  function path(fromLane: number, toLane: number): Lane[] {
    if (fromLane === toLane) return [lanes[fromLane]];
    if (!lanes[fromLane] || !lanes[toLane]) return [];
    const goal = endOf(lanes[toLane]);
    const g = new Float64Array(lanes.length).fill(Infinity);
    const prev = new Int32Array(lanes.length).fill(-1);
    const done = new Uint8Array(lanes.length);
    const open = new Heap();
    g[fromLane] = 0;
    open.push(fromLane, len(endOf(lanes[fromLane]), goal));
    let guard = 0;
    while (open.size > 0 && guard++ < 200000) {
      const cur = open.pop();
      if (done[cur]) continue;
      done[cur] = 1;
      if (cur === toLane) break;
      for (const nxt of succ.get(cur) ?? []) {
        const cost = g[cur] + lanes[nxt].length;
        if (cost < g[nxt]) {
          g[nxt] = cost;
          prev[nxt] = cur;
          open.push(nxt, cost + len(endOf(lanes[nxt]), goal));
        }
      }
    }
    if (!done[toLane]) return [];
    const out: Lane[] = [];
    for (let id = toLane; id !== -1; id = prev[id]) out.push(lanes[id]);
    return out.reverse();
  }

  return {
    nodes,
    lanes,
    succ,
    segmentLanes,
    nearestLane,
    path,
    successors: (id: number) => (succ.get(id) ?? []).map((i) => lanes[i]),
  };
}
