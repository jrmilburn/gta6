// Walkable surface height at a point.
//
// The city is built from flat slabs: the road at y=0, every block's sidewalk one
// kerb above it, and the boardwalk higher still. Nothing in CityData records
// that, so the on-foot controller used to treat the world as perfectly flat and
// the character walked *through* the side of every kerb. This reconstructs the
// height from the same grid the geometry was built on -- no raycast, no extra
// data, and O(1) per query because the block grid is regular.
import { CFG } from '../config';
import { BOARDWALK, PIER, PITCH, SAND_EDGE, SEA_LEVEL, nodeX, nodeZ, type CityLayout } from './cityGen';

const C = CFG.city;
/** Matches ground.ts: block slabs sit this far above the asphalt. */
export const KERB = 0.15;
/** Matches ground.ts: the boardwalk deck, and the pier's. */
export const DECK = 0.32;
/** Where the feet sit while swimming: a little under the surface. */
export const SWIM_HEIGHT = SEA_LEVEL - 0.55;

/** Is this point in the sea -- past the sand and not on the pier? */
export function waterAt(x: number, z: number): boolean {
  if (z >= SAND_EDGE) return false;
  return !(x >= PIER.minX && x <= PIER.maxX && z >= PIER.minZ && z <= PIER.maxZ);
}

const ORIGIN_X = nodeX(0);
const ORIGIN_Z = nodeZ(0);

export type GroundSampler = (x: number, z: number) => number;

export function makeGroundSampler(layout: CityLayout): GroundSampler {
  // Only blocks that actually exist get a slab; the grid is dense in this
  // generator but the lookup is written not to assume it.
  const present = new Set<number>();
  for (const b of layout.blocks) {
    const ix = Math.round((b.bounds.minX + b.bounds.maxX) / 2 - PITCH / 2 - ORIGIN_X) / PITCH;
    const iz = Math.round((b.bounds.minZ + b.bounds.maxZ) / 2 - PITCH / 2 - ORIGIN_Z) / PITCH;
    present.add(Math.round(iz) * 1000 + Math.round(ix));
  }
  const half = C.blockSize / 2;

  return (x: number, z: number): number => {
    if (x >= BOARDWALK.minX && x <= BOARDWALK.maxX && z >= BOARDWALK.minZ && z <= BOARDWALK.maxZ) {
      return DECK;
    }
    if (x >= PIER.minX && x <= PIER.maxX && z >= PIER.minZ && z <= PIER.maxZ) return DECK;
    if (z < SAND_EDGE) return SWIM_HEIGHT;
    const ix = Math.floor((x - ORIGIN_X) / PITCH);
    const iz = Math.floor((z - ORIGIN_Z) / PITCH);
    if (ix < 0 || iz < 0 || ix >= C.blocksX || iz >= C.blocksZ) return 0;
    if (!present.has(iz * 1000 + ix)) return 0;
    // Inside the block cell, but the slab is only the central blockSize square;
    // the rest of the pitch is carriageway.
    const cx = ORIGIN_X + ix * PITCH + PITCH / 2;
    const cz = ORIGIN_Z + iz * PITCH + PITCH / 2;
    return Math.abs(x - cx) <= half && Math.abs(z - cz) <= half ? KERB : 0;
  };
}
