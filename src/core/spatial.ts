// Uniform-grid spatial hash. Shared by city colliders (Phase 1) and the vehicle
// broad phase (Phase 2) so both use one implementation.
import type { AABB, Vec2 } from '../types';

export class SpatialHash<T> {
  private cells = new Map<number, T[]>();
  constructor(readonly cell: number = 20) {}

  private key(cx: number, cz: number): number {
    // 16-bit signed cell coords packed into one number.
    return ((cx + 32768) << 16) | (cz + 32768);
  }

  insertAABB(box: AABB, item: T): void {
    const x0 = Math.floor(box.minX / this.cell), x1 = Math.floor(box.maxX / this.cell);
    const z0 = Math.floor(box.minZ / this.cell), z1 = Math.floor(box.maxZ / this.cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = this.key(cx, cz);
        const list = this.cells.get(k);
        if (list) list.push(item);
        else this.cells.set(k, [item]);
      }
    }
  }

  insertPoint(p: Vec2, item: T): void {
    const k = this.key(Math.floor(p.x / this.cell), Math.floor(p.z / this.cell));
    const list = this.cells.get(k);
    if (list) list.push(item);
    else this.cells.set(k, [item]);
  }

  /** Unique items whose cells overlap the radius around p. Allocates one array. */
  query(p: Vec2, radius: number, out: T[] = []): T[] {
    out.length = 0;
    const x0 = Math.floor((p.x - radius) / this.cell), x1 = Math.floor((p.x + radius) / this.cell);
    const z0 = Math.floor((p.z - radius) / this.cell), z1 = Math.floor((p.z + radius) / this.cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const list = this.cells.get(this.key(cx, cz));
        if (!list) continue;
        for (const it of list) if (!out.includes(it)) out.push(it);
      }
    }
    return out;
  }

  clear(): void { this.cells.clear(); }
}

export function aabbContains(b: AABB, x: number, z: number): boolean {
  return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
}

export function aabbExpand(b: AABB, m: number): AABB {
  return { minX: b.minX - m, minZ: b.minZ - m, maxX: b.maxX + m, maxZ: b.maxZ + m };
}
