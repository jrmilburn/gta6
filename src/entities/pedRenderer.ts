// How a pedestrian gets drawn, separated from how it decides where to walk.
//
// There are two implementations. The procedural one (below) is the blocky
// humanoid the game shipped with, instanced five parts to a variant. The
// skinned one (pedSkinned.ts) is the real character on the real skeleton, for
// as long as a character was supplied. pedestrians.ts talks to this interface
// and does not know which it got.
import * as THREE from 'three';
import type { Vec2 } from '../types';
import { PedMeshPool, PED_VARIANT_COUNT } from './pedMesh';
import { posePed, type PosablePed } from './pedPose';

export interface PedRenderer {
  readonly group: THREE.Object3D;
  /** Which visual variant pedestrian `i` wears, and which slot it occupies. */
  variantFor(i: number): number;
  slotFor(i: number): number;
  /** Once per frame, before any pose(). */
  begin(): void;
  pose(p: PosablePed, dt: number): void;
  /** Once per frame, after every pose(). */
  commit(): void;
  /**
   * Start or stop a crowd dance centred on `centre`. Pedestrians further than
   * `radius`, or not currently detailed enough to have their own skeleton,
   * ignore it entirely.
   */
  setDance(centre: Vec2 | null, radius: number): void;
  /** How many pedestrians are dancing right now. Zero for the procedural crowd. */
  readonly dancing: number;
  /**
   * Pick a knockdown clip at random, or null if this renderer has none. The
   * procedural crowd has no clips at all, so a knocked-down pedestrian there
   * simply lies still on the spot.
   */
  pickFall?(): string | null;
  /** How long a clip runs, for timing the get-up. */
  clipDuration?(name: string): number;
  dispose(): void;
}

/** The original instanced-humanoid crowd, unchanged behind the new interface. */
export class ProceduralPedRenderer implements PedRenderer {
  readonly group: THREE.Object3D;
  private readonly pool: PedMeshPool;

  constructor(count: number) {
    this.pool = new PedMeshPool(Math.ceil(count / PED_VARIANT_COUNT));
    this.group = this.pool.group;
  }

  variantFor(i: number): number { return this.pool.variantFor(i); }
  slotFor(i: number): number { return this.pool.slotFor(i); }
  begin(): void { /* nothing to prepare */ }
  pose(p: PosablePed, dt: number): void { posePed(this.pool, p, dt); }
  commit(): void { this.pool.commit(); }
  setDance(): void { /* a box with arms has no dance clip to play */ }
  get dancing(): number { return 0; }
  dispose(): void { this.pool.dispose(); }
}
