// Block/zone layout -> CityData. Pure data: no Three.js in this file.
// DECISION: beachEdge is 'north' (-Z) so sky.ts's default beachAzimuth of -PI/2
// already brings the low sun in off the water without touching that file.
// DECISION: buildings are placed by partitioning the buildable rect into a small
// grid and filling a random subset of cells, which guarantees no overlaps.
import { CFG } from '../config';
import type { AABB, Block, BuildingDef, CityData, Vec2, Zone } from '../types';
import type { Rng } from '../core/rng';
import { buildRoadGraph, type CityRoadGraph } from './roadGraph';

const C = CFG.city;

export const PITCH = C.blockSize + C.roadWidth;
export const HALF_X = (C.blocksX * PITCH) / 2;
export const HALF_Z = (C.blocksZ * PITCH) / 2;

/** Outer edge of the perimeter road: the paved footprint of the city. */
export const PAVED: AABB = {
  minX: -HALF_X - C.roadWidth / 2, maxX: HALF_X + C.roadWidth / 2,
  minZ: -HALF_Z - C.roadWidth / 2, maxZ: HALF_Z + C.roadWidth / 2,
};

/** Timber deck between the beach road and the sand. */
export const BOARDWALK: AABB = { minX: -HALF_X, maxX: HALF_X, minZ: -HALF_Z - 46, maxZ: -HALF_Z - 14 };
/** Sand runs from the paved edge out to here; water starts a little inside it. */
export const SAND_EDGE = -HALF_Z - 96;
export const WATER_EDGE = -HALF_Z - 74;

export const PASTELS = [0xa9e5cd, 0xffd0b0, 0xff9a9e, 0xa6d5ea, 0xc7b4e3, 0xfaefd6, 0x79d3ba, 0xefece0];
export const COOL = [0xc9dcee, 0xa9c6de, 0xdfeaf4, 0x93b4cf, 0xeaf2f8];
export const NEON_WORDS = ['Zephyr', 'Lumo', 'Cabana', 'Nightfall', 'Mirage', 'Tidewater', 'Solstice', 'Palma', 'Verano', 'Sundial'] as const;
export const NEON_COLORS = ['#ff5fa2', '#4fe3ff', '#ffc766', '#7dffb4', '#c08bff'] as const;

export interface BuildingPart { bounds: AABB; y0: number; y1: number }
export interface NeonSign { word: string; colorIdx: number; face: number; y: number }

/** BuildingDef plus everything buildings.ts needs to build the mesh. */
export interface CityBuilding extends BuildingDef {
  zone: Zone;
  parts: BuildingPart[];
  roof: 'flat' | 'pitch' | 'plant';
  antenna: boolean;
  neon?: NeonSign;
  policeStation: boolean;
}

export interface PropSpot { pos: Vec2; rot: number; scale: number }
export interface PropSpots {
  streetlights: PropSpot[];
  trafficLights: PropSpot[];
  palms: PropSpot[];
  benches: PropSpot[];
  bins: PropSpot[];
  trees: PropSpot[];
}

/** CityData plus layout extras. Assignable to CityData for the fixed contract. */
export interface CityLayout extends CityData {
  roads: CityRoadGraph;
  parks: Block[];
  props: PropSpots;
  buildingCount: number;
}

export function nodeX(nx: number): number { return -HALF_X + nx * PITCH; }
export function nodeZ(nz: number): number { return -HALF_Z + nz * PITCH; }

export function blockBounds(ix: number, iz: number): AABB {
  const cx = nodeX(ix) + PITCH / 2, cz = nodeZ(iz) + PITCH / 2;
  const h = C.blockSize / 2;
  return { minX: cx - h, maxX: cx + h, minZ: cz - h, maxZ: cz + h };
}

export function zoneFor(ix: number, iz: number): Zone {
  if (iz === 0) return 'beach';
  const d = Math.max(Math.abs(ix - (C.blocksX - 1) / 2), Math.abs(iz - (C.blocksZ - 1) / 2));
  if (d <= 1.5) return 'downtown';
  if (d <= 3.5) return 'midtown';
  return 'residential';
}

function inset(b: AABB, m: number): AABB {
  return { minX: b.minX + m, maxX: b.maxX - m, minZ: b.minZ + m, maxZ: b.maxZ - m };
}

function shrinkTo(b: AABB, s: number): AABB {
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const hx = ((b.maxX - b.minX) / 2) * s, hz = ((b.maxZ - b.minZ) / 2) * s;
  return { minX: cx - hx, maxX: cx + hx, minZ: cz - hz, maxZ: cz + hz };
}

function shuffle<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

interface ZoneRule { cols: number; rows: number; min: number; max: number; hMin: number; hMax: number; fill: [number, number] }

const RULES: Record<Zone, ZoneRule> = {
  downtown:    { cols: 2, rows: 2, min: 1, max: 3, hMin: 40, hMax: 120, fill: [0.74, 0.94] },
  midtown:     { cols: 2, rows: 3, min: 3, max: 5, hMin: 12, hMax: 35,  fill: [0.70, 0.94] },
  residential: { cols: 3, rows: 3, min: 4, max: 8, hMin: 4,  hMax: 10,  fill: [0.64, 0.90] },
  beach:       { cols: 2, rows: 2, min: 1, max: 3, hMin: 6,  hMax: 14,  fill: [0.68, 0.90] },
};

/** Stacked boxes shrinking by 15-25% at each setback. */
function stack(rng: Rng, base: AABB, height: number, setbacks: number): BuildingPart[] {
  const parts: BuildingPart[] = [];
  let cur = base, y = 0, left = height;
  for (let i = 0; i <= setbacks; i++) {
    const h = i === setbacks ? left : left * rng.range(0.45, 0.64);
    parts.push({ bounds: cur, y0: y, y1: y + h });
    y += h; left -= h;
    cur = shrinkTo(cur, rng.range(0.75, 0.85));
  }
  return parts;
}

/**
 * How a block edge is laid out, measured inward from the block bounds.
 *
 * Everything used to sit in the same 1.3-to-1.6 m band -- streetlights, traffic
 * lights, palms, benches, bins AND the line the pedestrians walk along -- which
 * is why palms grew out of the middle of the pavement and people walked through
 * them. Three lanes now, with real gaps between them.
 *
 *   0.0        kerb
 *   0.9  VERGE       streetlights, traffic lights, palms
 *   2.4  WALK        pedestrians, and nothing else
 *   3.5  FRONTAGE    benches, bins, hydrants
 *   4.5        building line
 */
export const VERGE_INSET = 0.9;
export const WALK_INSET = 2.4;
export const FRONTAGE_INSET = 3.5;

function genBuildings(rng: Rng, block: AABB, zone: Zone): CityBuilding[] {
  const r = RULES[zone];
  const area = inset(block, C.sidewalkWidth + 1.5);
  let count = rng.int(r.min, r.max);
  let cols = r.cols, rows = r.rows;
  if (zone === 'downtown') { cols = count >= 2 ? 2 : 1; rows = count >= 3 ? 2 : 1; }
  count = Math.min(count, cols * rows);

  const cellW = (area.maxX - area.minX) / cols;
  const cellD = (area.maxZ - area.minZ) / rows;
  const cells: number[] = [];
  for (let i = 0; i < cols * rows; i++) cells.push(i);
  shuffle(cells, rng);

  const out: CityBuilding[] = [];
  for (let i = 0; i < count; i++) {
    const cx = cells[i] % cols, cz = Math.floor(cells[i] / cols);
    const cell: AABB = {
      minX: area.minX + cx * cellW, maxX: area.minX + (cx + 1) * cellW,
      minZ: area.minZ + cz * cellD, maxZ: area.minZ + (cz + 1) * cellD,
    };
    const foot = shrinkTo(cell, rng.range(r.fill[0], r.fill[1]));
    const height = rng.range(r.hMin, r.hMax);
    const cool = zone === 'downtown';
    const setbacks = cool ? rng.int(1, 2) : 0;
    const roof: CityBuilding['roof'] =
      cool && rng.chance(0.3) ? 'plant' : zone === 'residential' && rng.chance(0.5) ? 'pitch' : 'flat';

    const b: CityBuilding = {
      bounds: foot,
      height,
      colorIdx: cool ? rng.int(0, COOL.length - 1) : rng.int(0, PASTELS.length - 1),
      hasNeon: (cool || zone === 'midtown') && rng.chance(0.25),
      zone,
      parts: stack(rng, foot, height, setbacks),
      roof,
      antenna: roof === 'plant',
      policeStation: false,
    };
    if (b.hasNeon) {
      // Face the nearest street: pick the axis the building sits furthest along.
      const bcx = (block.minX + block.maxX) / 2, bcz = (block.minZ + block.maxZ) / 2;
      const dx = (foot.minX + foot.maxX) / 2 - bcx, dz = (foot.minZ + foot.maxZ) / 2 - bcz;
      const face = Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? 0 : 2) : (dz >= 0 ? 1 : 3);
      b.neon = {
        word: NEON_WORDS[rng.int(0, NEON_WORDS.length - 1)],
        colorIdx: rng.int(0, 4),
        face,
        y: Math.min(height - 2.2, rng.range(height * 0.55, height * 0.85)),
      };
    }
    out.push(b);
  }
  return out;
}

/** Points along a block perimeter, `d` metres in from the edge, spaced `step`. */
function perimeter(b: AABB, d: number, step: number, out: PropSpot[]): void {
  const a = inset(b, d);
  const w = a.maxX - a.minX, h = a.maxZ - a.minZ;
  const nx = Math.max(2, Math.round(w / step)), nz = Math.max(2, Math.round(h / step));
  for (let i = 0; i < nx; i++) {
    const x = a.minX + ((i + 0.5) * w) / nx;
    out.push({ pos: { x, z: a.minZ }, rot: Math.PI, scale: 1 });
    out.push({ pos: { x, z: a.maxZ }, rot: 0, scale: 1 });
  }
  for (let i = 0; i < nz; i++) {
    const z = a.minZ + ((i + 0.5) * h) / nz;
    out.push({ pos: { x: a.minX, z }, rot: -Math.PI / 2, scale: 1 });
    out.push({ pos: { x: a.maxX, z }, rot: Math.PI / 2, scale: 1 });
  }
}

/** A point in the road, just off the kerb of the given block. */
function kerbSpot(b: AABB, rng: Rng): Vec2 {
  const side = rng.int(0, 3);
  const t = rng.range(0.25, 0.75);
  const off = 4.5;
  if (side === 0) return { x: b.maxX + off, z: b.minZ + (b.maxZ - b.minZ) * t };
  if (side === 1) return { x: b.minX - off, z: b.minZ + (b.maxZ - b.minZ) * t };
  if (side === 2) return { x: b.minX + (b.maxX - b.minX) * t, z: b.maxZ + off };
  return { x: b.minX + (b.maxX - b.minX) * t, z: b.minZ - off };
}

export function generateCity(rng: Rng): CityLayout {
  const blocks: Block[] = [];
  const parks: Block[] = [];
  const colliders: AABB[] = [];
  const props: PropSpots = { streetlights: [], trafficLights: [], palms: [], benches: [], bins: [], trees: [] };

  const parkKeys = new Set<string>();
  const wanted = rng.int(2, 3);
  for (let guard = 0; parkKeys.size < wanted && guard < 60; guard++) {
    parkKeys.add(`${rng.int(1, C.blocksX - 2)},${rng.int(2, C.blocksZ - 2)}`);
  }

  let buildingCount = 0;
  for (let iz = 0; iz < C.blocksZ; iz++) {
    for (let ix = 0; ix < C.blocksX; ix++) {
      const bounds = blockBounds(ix, iz);
      const zone = zoneFor(ix, iz);
      const isPark = parkKeys.has(`${ix},${iz}`);
      const buildings = isPark ? [] : genBuildings(rng, bounds, zone);
      const block: Block = { ix, iz, zone, bounds, buildings };
      blocks.push(block);
      if (isPark) parks.push(block);

      for (const b of buildings) {
        colliders.push(b.bounds);
        buildingCount++;
      }

      // Streetlights and traffic-light poles ring every block, on the kerbside
      // verge where the lamp arm can reach out over the carriageway.
      perimeter(bounds, VERGE_INSET, 30, props.streetlights);
      const corner = inset(bounds, VERGE_INSET);
      for (const [x, z, rot] of [
        [corner.minX, corner.minZ, Math.PI * 0.75], [corner.maxX, corner.minZ, -Math.PI * 0.75],
        [corner.maxX, corner.maxZ, -Math.PI * 0.25], [corner.minX, corner.maxZ, Math.PI * 0.25],
      ] as const) {
        props.trafficLights.push({ pos: { x, z }, rot, scale: 1 });
      }

      if (isPark) {
        const a = inset(bounds, 6);
        for (let i = 0; i < 14; i++) {
          props.trees.push({ pos: { x: rng.range(a.minX, a.maxX), z: rng.range(a.minZ, a.maxZ) }, rot: rng.range(0, 6.28), scale: rng.range(0.85, 1.4) });
        }
      }

      // Palms: dense on the beach row, scattered elsewhere.
      const palmCount = zone === 'beach' ? rng.int(6, 9) : rng.int(2, 6);
      const edge = inset(bounds, VERGE_INSET);
      for (let i = 0; i < palmCount; i++) {
        const t = rng.next();
        const onX = rng.chance(0.5);
        const p: Vec2 = onX
          ? { x: edge.minX + (edge.maxX - edge.minX) * t, z: rng.chance(0.5) ? edge.minZ : edge.maxZ }
          : { x: rng.chance(0.5) ? edge.minX : edge.maxX, z: edge.minZ + (edge.maxZ - edge.minZ) * t };
        props.palms.push({ pos: p, rot: rng.range(0, 6.28), scale: rng.range(0.8, 1.3) });
      }

      if (zone === 'residential' || zone === 'beach' || isPark) {
        for (let i = 0; i < rng.int(1, 3); i++) {
          const spots: PropSpot[] = [];
          // Benches and bins go against the frontage, behind the walking line,
          // so a bench never stands in the way of the people using it.
          perimeter(bounds, FRONTAGE_INSET, 18, spots);
          const s = spots[rng.int(0, spots.length - 1)];
          props.benches.push({ pos: s.pos, rot: s.rot, scale: 1 });
        }
        for (let i = 0; i < rng.int(1, 2); i++) {
          const spots: PropSpot[] = [];
          perimeter(bounds, FRONTAGE_INSET, 22, spots);
          const s = spots[rng.int(0, spots.length - 1)];
          props.bins.push({ pos: s.pos, rot: 0, scale: 1 });
        }
      }
    }
  }

  // Boardwalk palms, both sides of the deck and staggered between the rows.
  for (let x = -HALF_X + 5; x <= HALF_X - 5; x += 6.5) {
    props.palms.push({ pos: { x, z: BOARDWALK.minZ - 3.5 }, rot: rng.range(0, 6.28), scale: rng.range(1.0, 1.45) });
    props.palms.push({ pos: { x: x + 3.25, z: BOARDWALK.maxZ + 3 }, rot: rng.range(0, 6.28), scale: rng.range(1.0, 1.45) });
  }

  // Poles are colliders too (0.3 m square, plan section 3).
  for (const list of [props.streetlights, props.trafficLights]) {
    for (const s of list) {
      colliders.push({ minX: s.pos.x - 0.15, maxX: s.pos.x + 0.15, minZ: s.pos.z - 0.15, maxZ: s.pos.z + 0.15 });
    }
  }

  // Mark a midtown building as the police station.
  const midtown = blocks.filter((b) => b.zone === 'midtown' && b.buildings.length > 0);
  const stationBlock = midtown[rng.int(0, midtown.length - 1)];
  const station = stationBlock.buildings[0] as CityBuilding;
  station.policeStation = true;
  station.hasNeon = false;
  station.neon = undefined;

  const pickBlock = (zone: Zone): Block => {
    const pool = blocks.filter((b) => b.zone === zone && b.buildings.length > 0);
    return pool[rng.int(0, pool.length - 1)];
  };

  const layout: CityLayout = {
    blocks,
    parks,
    props,
    buildingCount,
    colliders,
    roads: buildRoadGraph(),
    beachEdge: 'north',
    spawns: {
      // On the deck, at its city-facing edge, looking inland.
      player: { x: 0, z: BOARDWALK.maxZ - 9 },
      policeStation: kerbSpot(stationBlock.bounds, rng),
      garages: [pickBlock('downtown'), pickBlock('midtown'), pickBlock('residential'), pickBlock('beach')]
        .map((b) => kerbSpot(b.bounds, rng)),
      missions: [pickBlock('downtown'), pickBlock('residential'), pickBlock('beach')]
        .map((b) => kerbSpot(b.bounds, rng)),
    },
  };
  return layout;
}
