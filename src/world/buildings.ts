// Instanced building meshes from CityData. Boxes are bucketed by palette and by
// height so each bucket can carry a window texture tiled at the right scale.
import * as THREE from 'three';
import { emptyAssets, type Assets } from '../core/assets';
import { applyGroundAoTree } from './groundAo';
import { getTextures } from '../core/textures';
import { COOL, NEON_COLORS, NEON_WORDS, PASTELS, type CityBuilding, type CityLayout } from './cityGen';
import { MeshBuilder, cylAt } from './geomUtil';

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

export function buildBuildings(layout: CityLayout, _assets: Assets = emptyAssets()): THREE.Group {
  const tex = getTextures();
  const group = new THREE.Group();
  group.name = 'buildings';

  // bucket key: `${cool ? 1 : 0}:${heightBucket}`
  const buckets = new Map<string, Slot[]>();
  const plant: Slot[] = [];
  const antennas: Slot[] = [];
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

      if (b.roof === 'plant') {
        plant.push({ x: tx, y: top.y1 + 1.6, z: tz, w: tw * 0.45, h: 3.2, d: td * 0.45, color: 0xb9b4ab });
        if (b.antenna) {
          antennas.push({ x: tx, y: top.y1 + 3.2 + 5, z: tz, w: 1, h: 10, d: 1, color: 0xd8d4cc });
        }
      } else if (b.roof === 'pitch') {
        pitched.push({ x: tx, y: top.y1, z: tz, w: tw * 1.06, h: Math.min(3.2, tw * 0.35), d: td * 1.06, color: 0xb4614c });
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
  const boxGeo = windowBox();
  for (const [key, slots] of buckets) {
    const cool = key.startsWith('1');
    let mw = 0, mh = 0;
    for (const s of slots) { mw += (s.w + s.d) / 2; mh += s.h; }
    mw /= slots.length; mh /= slots.length;
    const map = (cool ? tex.windowsGlass : tex.windowsWarm).clone();
    map.needsUpdate = true;
    map.repeat.set(Math.max(1, Math.round(mw / 3)) / 8, Math.max(1, Math.round(mh / 3)) / 8);
    const mat = new THREE.MeshStandardMaterial({
      map, roughness: cool ? 0.22 : 0.78, metalness: cool ? 0.35 : 0.02,
    });
    if (cool) {
      // A touch of self-glow keeps glass towers from going to mud in shadow.
      mat.emissive = new THREE.Color(0x27466a);
      mat.emissiveMap = map;
      mat.emissiveIntensity = 0.4;
    }
    group.add(makeInstanced(boxGeo, mat, slots, true));
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
