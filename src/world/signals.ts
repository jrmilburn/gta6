// Traffic signals: one phase cycle per intersection, driving the lenses on the
// supplied traffic-light model, the AI traffic's stop lines, and when the
// pedestrians may cross.
//
// The cycle at every node is the same shape -- X green, amber, all red, Z
// green, amber, all red -- started at a random offset, so the grid is not in
// lock-step and a drive down any street meets a mix of reds and greens the way
// a real one does. Nothing here reads the traffic: it is a clock, and the
// traffic reads it.
import type { System } from '../types';
import { CFG } from '../config';
import { Rng } from '../core/rng';
import type { CityLayout } from './cityGen';
import type { SignalLenses, SignalPhase } from './props';

export type { SignalPhase } from './props';

/** Seconds. A short cycle: blocks are 56 m and nobody wants to wait. */
const GREEN = 9;
const AMBER = 2;
const ALL_RED = 1;
const HALF_CYCLE = GREEN + AMBER + ALL_RED;
const CYCLE = HALF_CYCLE * 2;
/** How much red must remain for a pedestrian to be allowed to start across. */
const WALK_MIN_REMAINING = 4;

const NX = CFG.city.blocksX + 1;

/**
 * The road-graph node at a block's inset corner. Corner indices follow
 * pedGeometry.insetCorners: 0 (minX, minZ), 1 (maxX, minZ), 2 (maxX, maxZ),
 * 3 (minX, maxZ).
 */
export function cornerNode(ix: number, iz: number, corner: number): number {
  const nx = ix + (corner === 1 || corner === 2 ? 1 : 0);
  const nz = iz + (corner === 2 || corner === 3 ? 1 : 0);
  return nz * NX + nx;
}

export class SignalSystem implements System {
  private readonly offsets: Float32Array;
  private time = 0;

  /**
   * `control` false keeps the lenses cycling but tells every caller the light
   * is green: `?signals=0`, for tests that need the traffic to flow regardless.
   */
  constructor(
    private readonly city: CityLayout,
    private readonly lenses: SignalLenses | null,
    readonly control = true,
    seed = 7331,
  ) {
    const rng = new Rng(seed);
    this.offsets = new Float32Array(city.roads.nodes.length);
    for (let i = 0; i < this.offsets.length; i++) this.offsets[i] = rng.range(0, CYCLE);
    this.writeLenses();
  }

  /** Where in its cycle a node is, 0..CYCLE. */
  private local(nodeId: number): number {
    const t = (this.time + (this.offsets[nodeId] ?? 0)) % CYCLE;
    return t < 0 ? t + CYCLE : t;
  }

  /** The signal shown to traffic travelling along `axis` through `nodeId`. */
  phaseFor(nodeId: number, axis: 'x' | 'z'): SignalPhase {
    if (!this.control) return 'green';
    return this.rawPhase(nodeId, axis);
  }

  private rawPhase(nodeId: number, axis: 'x' | 'z'): SignalPhase {
    let t = this.local(nodeId);
    if (axis === 'z') t = (t + HALF_CYCLE) % CYCLE;
    if (t < GREEN) return 'green';
    if (t < GREEN + AMBER) return 'amber';
    return 'red';
  }

  /** Seconds until the light for `axis` next turns green. 0 while it is green. */
  untilGreen(nodeId: number, axis: 'x' | 'z'): number {
    let t = this.local(nodeId);
    if (axis === 'z') t = (t + HALF_CYCLE) % CYCLE;
    return t < GREEN ? 0 : CYCLE - t;
  }

  /**
   * May a pedestrian start across the road that runs along `roadAxis` at this
   * node? Yes while that road's traffic is held on red with enough of the red
   * left to get to the other side.
   */
  walkAcross(nodeId: number, roadAxis: 'x' | 'z'): boolean {
    if (!this.control) return true;
    if (this.rawPhase(nodeId, roadAxis) !== 'red') return false;
    return this.untilGreen(nodeId, roadAxis) >= WALK_MIN_REMAINING;
  }

  update(dt: number): void {
    this.time += dt;
    this.writeLenses();
  }

  private writeLenses(): void {
    if (!this.lenses) return;
    const spots = this.city.props.trafficLights;
    const n = Math.min(spots.length, this.lenses.count);
    for (let i = 0; i < n; i++) {
      const s = spots[i];
      this.lenses.setPhase(i, this.rawPhase(s.node, s.axis));
    }
    this.lenses.commit();
  }
}
