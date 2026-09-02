// Road surface, lane markings, kerbs/sidewalks, beach sand and the boardwalk.
// Everything here is merged into a handful of BufferGeometries.
import * as THREE from 'three';
import { emptyAssets, type Assets } from '../core/assets';
import { CFG } from '../config';
import { getTextures } from '../core/textures';
import { MeshBuilder } from './geomUtil';
import { BOARDWALK, PAVED, PITCH, SAND_EDGE, nodeX, nodeZ, type CityLayout } from './cityGen';

const C = CFG.city;
const HALF = C.roadWidth / 2;
const KERB = 0.15;
// The land runs far enough out that fog swallows its edge long before the far
// plane does, so the drone shot never shows a floating slab.
const OUTER = 5000;

/** Markings sit a hair above the asphalt and are pulled forward in depth so they
 *  never z-fight, even from the drone camera where depth precision is coarse. */
const MARK_Y = 0.035;

function markMaterial(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color, roughness: 0.85, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
  });
}

/** Dashed strip along one axis. `fixed` is the coordinate of the other axis. */
function dashes(
  mb: MeshBuilder, along: 'x' | 'z', fixed: number, a: number, b: number,
  width: number, dash: number, gap: number,
): void {
  const w = width / 2;
  for (let t = a; t < b - 0.2; t += dash + gap) {
    const e = Math.min(t + dash, b);
    if (along === 'x') mb.top(t, fixed - w, e, fixed + w, MARK_Y, 4);
    else mb.top(fixed - w, t, fixed + w, e, MARK_Y, 4);
  }
}

function roadMarkings(): { yellow: THREE.BufferGeometry; white: THREE.BufferGeometry } {
  const y = new MeshBuilder();
  const w = new MeshBuilder();
  const lw = C.laneWidth;

  const line = (along: 'x' | 'z', fixed: number, i: number, count: number): void => {
    const s = (along === 'x' ? nodeX(i) : nodeZ(i)) + HALF;
    const e = (along === 'x' ? nodeX(i + 1) : nodeZ(i + 1)) - HALF;
    if (i + 1 > count) return;
    // Dashed yellow centre line, white dashed dividers between the two lanes
    // of each direction.
    dashes(y, along, fixed, s, e, 0.32, 4, 4);
    dashes(w, along, fixed - lw, s, e, 0.16, 3, 5);
    dashes(w, along, fixed + lw, s, e, 0.16, 3, 5);
  };

  for (let nz = 0; nz <= C.blocksZ; nz++) {
    for (let ix = 0; ix < C.blocksX; ix++) line('x', nodeZ(nz), ix, C.blocksX);
  }
  for (let nx = 0; nx <= C.blocksX; nx++) {
    for (let iz = 0; iz < C.blocksZ; iz++) line('z', nodeX(nx), iz, C.blocksZ);
  }

  // Crosswalk stripes on every intersection approach.
  for (let nz = 0; nz <= C.blocksZ; nz++) {
    for (let nx = 0; nx <= C.blocksX; nx++) {
      const cx = nodeX(nx), cz = nodeZ(nz);
      const approaches: Array<[number, number]> = [];
      if (nx < C.blocksX) approaches.push([1, 0]);
      if (nx > 0) approaches.push([-1, 0]);
      if (nz < C.blocksZ) approaches.push([0, 1]);
      if (nz > 0) approaches.push([0, -1]);
      for (const [dx, dz] of approaches) {
        const b0 = HALF + 0.7, b1 = HALF + 3.7;
        for (let o = -HALF + 0.5; o < HALF - 1; o += 1.7) {
          if (dx !== 0) {
            const x0 = cx + dx * (dx > 0 ? b0 : b1), x1 = cx + dx * (dx > 0 ? b1 : b0);
            w.top(x0, cz + o, x1, cz + o + 0.75, MARK_Y, 4);
          } else {
            const z0 = cz + dz * (dz > 0 ? b0 : b1), z1 = cz + dz * (dz > 0 ? b1 : b0);
            w.top(cx + o, z0, cx + o + 0.75, z1, MARK_Y, 4);
          }
        }
      }
    }
  }
  return { yellow: y.build(), white: w.build() };
}

export function buildGround(layout: CityLayout, _assets: Assets = emptyAssets()): THREE.Group {
  const tex = getTextures();
  const group = new THREE.Group();
  group.name = 'ground';

  // --- asphalt: one plane over the whole paved footprint. Blocks sit 0.15 m
  // above it, so nothing is coplanar and there is nothing to z-fight.
  const road = new MeshBuilder();
  road.top(PAVED.minX, PAVED.minZ, PAVED.maxX, PAVED.maxZ, 0, 9);
  const roadMesh = new THREE.Mesh(road.build(), new THREE.MeshStandardMaterial({
    map: tex.asphalt, color: 0x9a9aa2, roughness: 0.96, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4,
  }));
  roadMesh.receiveShadow = true;
  group.add(roadMesh);

  // --- terrain: a ring around the paved rect, so it never overlaps the asphalt.
  // Bright sand on the beach side, dry olive scrub inland so the hinterland does
  // not read as one endless beach from the air.
  const beach = new MeshBuilder();
  beach.top(-OUTER, SAND_EDGE, OUTER, PAVED.minZ, 0, 14);
  const beachMesh = new THREE.Mesh(beach.build(), new THREE.MeshStandardMaterial({
    map: tex.sand, color: 0xf2e2b6, roughness: 1, metalness: 0,
  }));
  beachMesh.receiveShadow = true;
  group.add(beachMesh);

  const scrub = new MeshBuilder();
  scrub.top(-OUTER, PAVED.maxZ, OUTER, OUTER, 0, 20);
  scrub.top(-OUTER, PAVED.minZ, PAVED.minX, PAVED.maxZ, 0, 20);
  scrub.top(PAVED.maxX, PAVED.minZ, OUTER, PAVED.maxZ, 0, 20);
  const scrubMesh = new THREE.Mesh(scrub.build(), new THREE.MeshStandardMaterial({
    map: tex.sand, color: 0xcdc094, roughness: 1, metalness: 0,
  }));
  scrubMesh.receiveShadow = true;
  group.add(scrubMesh);

  // --- kerbs and sidewalks -----------------------------------------------------
  const walk = new MeshBuilder();
  const grass = new MeshBuilder();
  const sand = new MeshBuilder();
  const parkSet = new Set(layout.parks);
  for (const b of layout.blocks) {
    const bb = b.bounds;
    walk.walls(bb.minX, bb.minZ, bb.maxX, bb.maxZ, 0, KERB, 3);
    const soft = parkSet.has(b) ? grass : b.zone === 'beach' ? sand : null;
    if (soft) {
      walk.ring(bb, C.sidewalkWidth, KERB, 3);
      soft.top(bb.minX + C.sidewalkWidth, bb.minZ + C.sidewalkWidth, bb.maxX - C.sidewalkWidth, bb.maxZ - C.sidewalkWidth, KERB, parkSet.has(b) ? 6 : 9);
    } else {
      walk.top(bb.minX, bb.minZ, bb.maxX, bb.maxZ, KERB, 3);
    }
  }
  const walkMesh = new THREE.Mesh(walk.build(), new THREE.MeshStandardMaterial({
    map: tex.sidewalk, color: 0xf0ece1, roughness: 0.9, metalness: 0,
  }));
  walkMesh.receiveShadow = true;
  group.add(walkMesh);

  const grassMesh = new THREE.Mesh(grass.build(), new THREE.MeshStandardMaterial({ map: tex.grass, roughness: 1 }));
  grassMesh.receiveShadow = true;
  group.add(grassMesh);

  const sandMesh = new THREE.Mesh(sand.build(), new THREE.MeshStandardMaterial({ map: tex.sand, color: 0xf0e2bb, roughness: 1 }));
  sandMesh.receiveShadow = true;
  group.add(sandMesh);

  // --- lane markings ------------------------------------------------------------
  const marks = roadMarkings();
  const yellowMesh = new THREE.Mesh(marks.yellow, markMaterial(0xf3c445));
  const whiteMesh = new THREE.Mesh(marks.white, markMaterial(0xf1efe6));
  yellowMesh.receiveShadow = true;
  whiteMesh.receiveShadow = true;
  group.add(yellowMesh, whiteMesh);

  // --- boardwalk ----------------------------------------------------------------
  const deck = new MeshBuilder();
  deck.slab(BOARDWALK.minX, BOARDWALK.minZ, BOARDWALK.maxX, BOARDWALK.maxZ, 0, 0.32, 2.6);
  const deckMesh = new THREE.Mesh(deck.build(), new THREE.MeshStandardMaterial({
    map: tex.planks, color: 0xd9b98c, roughness: 0.85,
  }));
  deckMesh.receiveShadow = true;
  group.add(deckMesh);

  return group;
}

/** Half-width of a road, exported so props can sit clear of the carriageway. */
export const ROAD_HALF = HALF;
export const BLOCK_PITCH = PITCH;
