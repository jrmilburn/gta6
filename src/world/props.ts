// Palms, streetlights, traffic lights, benches, bins and park trees.
// Every prop is an InstancedMesh. Instanced props never cast shadows (plan 0.6).
import * as THREE from 'three';
import type { PropSpot, CityLayout } from './cityGen';
import { boxAt, cylAt, mergeGeos } from './geomUtil';

function place(
  geo: THREE.BufferGeometry, mat: THREE.Material, spots: PropSpot[],
  y: number, tilt = 0,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  for (let i = 0; i < spots.length; i++) {
    const spot = spots[i];
    e.set(tilt ? Math.sin(spot.rot) * tilt : 0, spot.rot, tilt ? Math.cos(spot.rot) * tilt : 0);
    q.setFromEuler(e);
    p.set(spot.pos.x, y, spot.pos.z);
    s.setScalar(spot.scale);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

/** Tapered, slightly curved frond built from four segments. */
function frondGeo(): THREE.BufferGeometry {
  const segs = 4, len = 3.6;
  const pos: number[] = [], nrm: number[] = [], idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const x = t * len;
    const droop = -Math.pow(t, 2) * 1.9;
    const halfW = 0.42 * (1 - t * 0.85) + 0.05;
    pos.push(x, droop, -halfW, x, droop, halfW);
    nrm.push(0, 1, 0, 0, 1, 0);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3 * 2), 2));
  g.setIndex(idx);
  return g;
}

/** Crown of 7 fronds arranged radially, merged into one instanced geometry. */
function crownGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 7; i++) {
    const g = frondGeo();
    g.rotateZ(0.32);
    g.rotateY((i / 7) * Math.PI * 2);
    parts.push(g);
  }
  // A small nut cluster hides the join at the trunk top.
  parts.push(cylAt(0.3, 0.3, 0.4, 6, 0, -0.15, 0));
  return mergeGeos(parts);
}

export function buildProps(layout: CityLayout): THREE.Group {
  const group = new THREE.Group();
  group.name = 'props';
  const p = layout.props;

  // --- palms -------------------------------------------------------------------
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0xa98b63, roughness: 0.95 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x4f9b46, roughness: 0.8, side: THREE.DoubleSide });
  const trunk = cylAt(0.17, 0.32, 6.4, 6, 0, 3.2, 0);
  group.add(place(trunk, trunkMat, p.palms, 0.16, 0.06));
  group.add(place(crownGeo(), leafMat, p.palms, 6.5, 0.06));

  // --- streetlights ------------------------------------------------------------
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x54585e, roughness: 0.55, metalness: 0.5 });
  group.add(place(cylAt(0.08, 0.13, 7, 6, 0, 3.5, 0), poleMat, p.streetlights, 0.16));
  const head = mergeGeos([
    boxAt(0.14, 0.14, 1.9, 0, 6.95, 0.95),
    boxAt(0.5, 0.18, 0.9, 0, 6.82, 1.85),
  ]);
  group.add(place(head, new THREE.MeshStandardMaterial({
    color: 0x2a2c30, emissive: 0xffd9a0, emissiveIntensity: 0.55, roughness: 0.6,
  }), p.streetlights, 0.16));

  // --- traffic lights ----------------------------------------------------------
  group.add(place(cylAt(0.09, 0.11, 4.6, 6, 0, 2.3, 0), poleMat, p.trafficLights, 0.16));
  const tlHead = mergeGeos([
    boxAt(0.1, 0.1, 1.1, 0, 4.5, 0.55),
    boxAt(0.34, 0.95, 0.3, 0, 4.28, 1.1),
  ]);
  group.add(place(tlHead, new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.7 }), p.trafficLights, 0.16));
  group.add(place(boxAt(0.16, 0.16, 0.06, 0, 4.55, 1.28), new THREE.MeshStandardMaterial({
    color: 0x300000, emissive: 0xff2b1f, emissiveIntensity: 1.8,
  }), p.trafficLights, 0.16));

  // --- benches and bins ---------------------------------------------------------
  if (p.benches.length) {
    const bench = mergeGeos([
      boxAt(1.9, 0.1, 0.55, 0, 0.45, 0),
      boxAt(1.9, 0.55, 0.09, 0, 0.72, -0.24),
      boxAt(0.12, 0.45, 0.5, -0.85, 0.22, 0),
      boxAt(0.12, 0.45, 0.5, 0.85, 0.22, 0),
    ]);
    group.add(place(bench, new THREE.MeshStandardMaterial({ color: 0xb98a55, roughness: 0.9 }), p.benches, 0.16));
  }
  if (p.bins.length) {
    group.add(place(cylAt(0.3, 0.26, 0.85, 8, 0, 0.42, 0),
      new THREE.MeshStandardMaterial({ color: 0x35604a, roughness: 0.8 }), p.bins, 0.16));
  }

  // --- park trees ---------------------------------------------------------------
  if (p.trees.length) {
    group.add(place(cylAt(0.22, 0.32, 3, 6, 0, 1.5, 0),
      new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.95 }), p.trees, 0.16));
    const foliage = mergeGeos([
      new THREE.IcosahedronGeometry(1.7, 0).translate(0, 4.1, 0),
      new THREE.IcosahedronGeometry(1.2, 0).translate(0.9, 3.2, 0.5),
    ]);
    group.add(place(foliage, new THREE.MeshStandardMaterial({ color: 0x4d8c40, roughness: 0.9, flatShading: true }), p.trees, 0.16));
  }

  return group;
}
