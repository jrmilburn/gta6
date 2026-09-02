// Instanced building meshes from CityData. Boxes are bucketed by palette and by
// height so each bucket can carry a window texture tiled at the right scale.
import * as THREE from 'three';
import { emptyAssets, type Assets } from '../core/assets';
import { applyGroundAoTree } from './groundAo';
import { attachWallRelief, facadeAlbedo, wallFor } from './surfaces';
import { getTextures } from '../core/textures';
import { COOL, NEON_COLORS, NEON_WORDS, PASTELS, type CityBuilding, type CityLayout } from './cityGen';
import { MeshBuilder, cylAt } from './geomUtil';
import { Rng } from '../core/rng';

const HEIGHT_BUCKETS = [9, 18, 34, 60, Infinity];

/** Unit box whose top and bottom faces sample the flat part of the window
 *  texture, so roofs are not covered in windows. */
function windowBox(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 8; i < 16; i++) uv.setXY(i, 0.004, 0.004); // +Y then -Y faces
  uv.needsUpdate = true;
  return g;
}

/** Triangular prism: 1x1 footprint, ridge running along X at y = 1. */
function prismGeo(): THREE.BufferGeometry {
  const s = 0.5;
  const v: number[] = [];
  const n: number[] = [];
  const push = (p: number[][], nrm: number[]): void => {
    for (const q of p) { v.push(q[0], q[1], q[2]); n.push(nrm[0], nrm[1], nrm[2]); }
  };
  const k = Math.SQRT1_2;
  // +Z slope
  push([[-s, 0, s], [s, 0, s], [s, 1, 0], [-s, 0, s], [s, 1, 0], [-s, 1, 0]], [0, k, k]);
  // -Z slope
  push([[s, 0, -s], [-s, 0, -s], [-s, 1, 0], [s, 0, -s], [-s, 1, 0], [s, 1, 0]], [0, k, -k]);
  // gable ends
  push([[s, 0, s], [s, 0, -s], [s, 1, 0]], [1, 0, 0]);
  push([[-s, 0, -s], [-s, 0, s], [-s, 1, 0]], [-1, 0, 0]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((v.length / 3) * 2), 2));
  g.computeBoundingSphere();
  return g;
}

interface Slot { x: number; y: number; z: number; w: number; h: number; d: number; color: number }

function makeInstanced(
  geo: THREE.BufferGeometry, mat: THREE.Material, slots: Slot[], shadows: boolean,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geo, mat, slots.length);
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    m.makeScale(s.w, s.h, s.d);
    m.setPosition(s.x, s.y, s.z);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, c.setHex(s.color));
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  return mesh;
}

export function buildBuildings(layout: CityLayout, assets: Assets = emptyAssets()): THREE.Group {
  const tex = getTextures();
  const group = new THREE.Group();
  group.name = 'buildings';

  // bucket key: `${cool ? 1 : 0}:${heightBucket}`
  const buckets = new Map<string, Slot[]>();
  const plant: Slot[] = [];
  const antennas: Slot[] = [];
  /** Parapet ledge round the top of every flat roof (2.4). */
  const parapets: Slot[] = [];
  /** Tanks, vents and ducts on the roofs that get them. */
  const clutter: Slot[] = [];
  const clutterRng = new Rng(31337);
  const pitched: Slot[] = [];
  const neon = new Map<string, Slot[]>();
  const stripes = new MeshBuilder();

  for (const block of layout.blocks) {
    for (const raw of block.buildings) {
      const b = raw as CityBuilding;
      const cool = b.zone === 'downtown';
      const color = cool ? COOL[b.colorIdx % COOL.length] : PASTELS[b.colorIdx % PASTELS.length];
      for (const part of b.parts) {
        const w = part.bounds.maxX - part.bounds.minX;
        const d = part.bounds.maxZ - part.bounds.minZ;
        const h = part.y1 - part.y0;
        let bi = 0;
        while (h > HEIGHT_BUCKETS[bi]) bi++;
        const key = `${cool ? 1 : 0}:${bi}`;
        let list = buckets.get(key);
        if (!list) { list = []; buckets.set(key, list); }
        list.push({
          x: (part.bounds.minX + part.bounds.maxX) / 2, y: part.y0 + h / 2,
          z: (part.bounds.minZ + part.bounds.maxZ) / 2, w, h, d, color,
        });
      }

      const top = b.parts[b.parts.length - 1];
      const tw = top.bounds.maxX - top.bounds.minX;
      const td = top.bounds.maxZ - top.bounds.minZ;
      const tx = (top.bounds.minX + top.bounds.maxX) / 2;
      const tz = (top.bounds.minZ + top.bounds.maxZ) / 2;

      if (b.roof !== 'pitch') {
        // Parapet: a thin ledge standing proud of the wall all the way round.
        // Without it a flat roof is a cut edge, and a cut edge is the single
        // clearest tell that a building is a box (2.4).
        parapets.push({
          x: tx, y: top.y1 + 0.28, z: tz,
          w: tw + 0.34, h: 0.56, d: td + 0.34, color: 0xcfc9bd,
        });
      }

      if (b.roof === 'plant') {
        plant.push({ x: tx, y: top.y1 + 1.6, z: tz, w: tw * 0.45, h: 3.2, d: td * 0.45, color: 0xb9b4ab });
        if (b.antenna) {
          antennas.push({ x: tx, y: top.y1 + 3.2 + 5, z: tz, w: 1, h: 10, d: 1, color: 0xd8d4cc });
        }
      } else if (b.roof === 'pitch') {
        pitched.push({ x: tx, y: top.y1, z: tz, w: tw * 1.06, h: Math.min(3.2, tw * 0.35), d: td * 1.06, color: 0xb4614c });
      }

      // Rooftop clutter on 60% of the taller zones (2.4): water tanks, vents and
      // ducts, scattered inside the parapet so the skyline is not a row of
      // clean-topped slabs.
      if (b.roof !== 'pitch' && (b.zone === 'downtown' || b.zone === 'midtown')
        && clutterRng.chance(0.6)) {
        const inset = 2.2;
        const spanX = Math.max(0, tw / 2 - inset);
        const spanZ = Math.max(0, td / 2 - inset);
        const n = clutterRng.int(2, 5);
        for (let i = 0; i < n; i++) {
          const h = clutterRng.range(0.9, 2.6);
          clutter.push({
            x: tx + clutterRng.range(-spanX, spanX),
            y: top.y1 + h / 2,
            z: tz + clutterRng.range(-spanZ, spanZ),
            w: clutterRng.range(1.0, 2.6),
            h,
            d: clutterRng.range(1.0, 2.6),
            color: clutterRng.chance(0.4) ? 0x8f9298 : 0xb3aea3,
          });
        }
      }

      if (b.neon && b.hasNeon) {
        const faceW = b.neon.face === 0 || b.neon.face === 2 ? td : tw;
        const sw = Math.min(faceW * 0.8, 9);
        const sh = sw / 4;
        const off = 0.14;
        const base = b.parts[0].bounds;
        let x = (base.minX + base.maxX) / 2, z = (base.minZ + base.maxZ) / 2;
        if (b.neon.face === 0) x = base.maxX + off;
        else if (b.neon.face === 2) x = base.minX - off;
        else if (b.neon.face === 1) z = base.maxZ + off;
        else z = base.minZ - off;
        let list = neon.get(b.neon.word);
        if (!list) { list = []; neon.set(b.neon.word, list); }
        // `d` carries the face index; the plane is oriented from it below.
        list.push({ x, y: b.neon.y, z, w: sw, h: sh, d: b.neon.face, color: 0xffffff });
      }

      if (b.policeStation) {
        const p = b.parts[0].bounds;
        stripes.walls(p.minX - 0.12, p.minZ - 0.12, p.maxX + 0.12, p.maxZ + 0.12, 3.0, 4.3, 2);
      }
    }
  }

  // --- boxes -------------------------------------------------------------------
  //
  // One material per (palette, height) bucket. The albedo is the procedural
  // window grid composited over a real wall material and weathered (2.4); the
  // wall's normal and roughness maps ride alongside at a finer tiling, so the
  // relief reads at arm's length without smearing the window layout.
  const boxGeo = windowBox();
  let bucketSeed = 7000;
  for (const [key, slots] of buckets) {
    const cool = key.startsWith('1');
    let mw = 0, mh = 0;
    for (const s of slots) { mw += (s.w + s.d) / 2; mh += s.h; }
    mw /= slots.length; mh /= slots.length;
    const repeatX = Math.max(1, Math.round(mw / 3)) / 8;
    const repeatY = Math.max(1, Math.round(mh / 3)) / 8;

    const wallName = wallFor(bucketSeed, cool);
    const wall = assets.material(wallName);
    const source = cool ? tex.windowsGlass : tex.windowsWarm;
    const composited = facadeAlbedo(source, wall, {
      mode: cool ? 'curtain' : 'wall',
      // Downtown glass is cleaned; everything else is not.
      grime: cool ? 0.35 : 1,
      streaks: !cool,
      shopfront: !cool,
    }, bucketSeed++);

    const map = composited ?? source.clone();
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(repeatX, repeatY);
    map.needsUpdate = true;

    const mat = new THREE.MeshStandardMaterial({
      map,
      // Downtown curtain wall is a near-mirror so the environment map does the
      // work the brief asks of it; stucco and brick stay matte.
      roughness: cool ? 0.14 : 0.82,
      metalness: cool ? 0.55 : 0.02,
    });
    // Relief tiles finer than the storeys do -- a brick is 0.2 m, a floor is 3.
    attachWallRelief(mat, wall, repeatX * 3, repeatY * 3, cool ? 0.25 : 0.85);
    if (cool) {
      // A touch of self-glow keeps glass towers from going to mud in shadow,
      // and at dusk it is what lights the occupied floors.
      mat.emissive = new THREE.Color(0x27466a);
      mat.emissiveMap = map;
      mat.emissiveIntensity = 0.4;
    }
    group.add(makeInstanced(boxGeo, mat, slots, true));
  }

  if (parapets.length) {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.02 });
    attachWallRelief(mat, assets.material('concrete'), 3, 1, 0.5);
    group.add(makeInstanced(new THREE.BoxGeometry(1, 1, 1), mat, parapets, true));
  }
  if (clutter.length) {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.25 });
    attachWallRelief(mat, assets.material('roof-metal'), 2, 2, 0.8);
    group.add(makeInstanced(new THREE.BoxGeometry(1, 1, 1), mat, clutter, true));
  }
  if (plant.length) {
    group.add(makeInstanced(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ roughness: 0.85 }), plant, true));
  }
  if (antennas.length) {
    group.add(makeInstanced(cylAt(0.06, 0.16, 1, 5),
      new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.6 }), antennas, true));
  }
  if (pitched.length) {
    group.add(makeInstanced(prismGeo(),
      new THREE.MeshStandardMaterial({ roughness: 0.9 }), pitched, true));
  }

  // --- neon signs ---------------------------------------------------------------
  const plane = new THREE.PlaneGeometry(1, 1);
  const faceRot = [Math.PI / 2, 0, -Math.PI / 2, Math.PI];
  for (const [word, slots] of neon) {
    const color = NEON_COLORS[NEON_WORDS.indexOf(word as (typeof NEON_WORDS)[number]) % NEON_COLORS.length];
    const map = tex.neon(word, color);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x101014, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 2,
      roughness: 0.6, side: THREE.DoubleSide,
    });
    const mesh = new THREE.InstancedMesh(plane, mat, slots.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), faceRot[s.d]);
      pos.set(s.x, s.y, s.z);
      scl.set(s.w, s.h, 1);
      m.compose(pos, q, scl);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  }

  // --- police station identifier band -------------------------------------------
  const stripeMesh = new THREE.Mesh(stripes.build(), new THREE.MeshStandardMaterial({
    color: 0x0a2a6a, emissive: 0x2f6bff, emissiveIntensity: 1.6, roughness: 0.5,
  }));
  group.add(stripeMesh);

  // Ground contact: darken the bottom 3 m so walls meet the pavement instead of
  // floating on it (2.1). Neon and the police band opt out -- they are emissive
  // and dimming them at street level is exactly backwards.
  for (const child of group.children) {
    if (child === stripeMesh) continue;
    const mat = (child as THREE.Mesh).material as THREE.Material | undefined;
    if (mat && (mat as THREE.MeshStandardMaterial).emissiveMap) continue;
    applyGroundAoTree(child);
  }

  return group;
}
