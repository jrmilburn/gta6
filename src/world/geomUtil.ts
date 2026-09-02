// Small geometry helpers shared by the world builders. Everything here exists to
// collapse thousands of little quads into a handful of draw calls.
import * as THREE from 'three';

type P3 = readonly [number, number, number];

/**
 * Accumulates axis-aligned quads into one BufferGeometry. UVs are taken from
 * world coordinates divided by `tile`, so merged quads keep a continuous texture.
 */
export class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uvs: number[] = [];
  private idx: number[] = [];

  get quadCount(): number { return this.idx.length / 6; }

  private quad(a: P3, b: P3, c: P3, d: P3, n: P3, uv: readonly number[]): void {
    const base = this.pos.length / 3;
    const verts = [a, b, c, d];
    for (let i = 0; i < 4; i++) {
      this.pos.push(verts[i][0], verts[i][1], verts[i][2]);
      this.nrm.push(n[0], n[1], n[2]);
      this.uvs.push(uv[i * 2], uv[i * 2 + 1]);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Horizontal quad facing +Y. */
  top(minX: number, minZ: number, maxX: number, maxZ: number, y: number, tile = 4): void {
    const u0 = minX / tile, u1 = maxX / tile, v0 = minZ / tile, v1 = maxZ / tile;
    this.quad(
      [minX, y, minZ], [minX, y, maxZ], [maxX, y, maxZ], [maxX, y, minZ],
      [0, 1, 0], [u0, v0, u0, v1, u1, v1, u1, v0],
    );
  }

  /** The four vertical walls of a slab, used for kerbs. */
  walls(minX: number, minZ: number, maxX: number, maxZ: number, y0: number, y1: number, tile = 4): void {
    const v0 = y0 / tile, v1 = y1 / tile;
    // +X
    this.quad([maxX, y0, maxZ], [maxX, y0, minZ], [maxX, y1, minZ], [maxX, y1, maxZ],
      [1, 0, 0], [maxZ / tile, v0, minZ / tile, v0, minZ / tile, v1, maxZ / tile, v1]);
    // -X
    this.quad([minX, y0, minZ], [minX, y0, maxZ], [minX, y1, maxZ], [minX, y1, minZ],
      [-1, 0, 0], [minZ / tile, v0, maxZ / tile, v0, maxZ / tile, v1, minZ / tile, v1]);
    // +Z
    this.quad([minX, y0, maxZ], [maxX, y0, maxZ], [maxX, y1, maxZ], [minX, y1, maxZ],
      [0, 0, 1], [minX / tile, v0, maxX / tile, v0, maxX / tile, v1, minX / tile, v1]);
    // -Z
    this.quad([maxX, y0, minZ], [minX, y0, minZ], [minX, y1, minZ], [maxX, y1, minZ],
      [0, 0, -1], [maxX / tile, v0, minX / tile, v0, minX / tile, v1, maxX / tile, v1]);
  }

  slab(minX: number, minZ: number, maxX: number, maxZ: number, y0: number, y1: number, tile = 4): void {
    this.top(minX, minZ, maxX, maxZ, y1, tile);
    this.walls(minX, minZ, maxX, maxZ, y0, y1, tile);
  }

  /** A flat ring (four quads) between an outer and an inner rectangle. */
  ring(o: { minX: number; minZ: number; maxX: number; maxZ: number }, w: number, y: number, tile = 4): void {
    const i = { minX: o.minX + w, minZ: o.minZ + w, maxX: o.maxX - w, maxZ: o.maxZ - w };
    this.top(o.minX, o.minZ, o.maxX, i.minZ, y, tile);
    this.top(o.minX, i.maxZ, o.maxX, o.maxZ, y, tile);
    this.top(o.minX, i.minZ, i.minX, i.maxZ, y, tile);
    this.top(i.maxX, i.minZ, o.maxX, i.maxZ, y, tile);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Concatenate geometries that share position/normal/uv. Used to build one
 *  instanced prop from several primitives without pulling in examples/jsm. */
export function mergeGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of parts) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let o = 0;
  for (const g of parts) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    if (g.attributes.normal) nrm.set(g.attributes.normal.array as Float32Array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array as Float32Array, o * 2);
    o += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

/** Box translated so it can be merged into a compound prop. */
export function boxAt(w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** Cylinder translated the same way. */
export function cylAt(rTop: number, rBot: number, h: number, seg: number, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
  g.translate(x, y, z);
  return g;
}
