// Palms, streetlights, traffic lights, benches, bins and park trees.
// Every prop is an InstancedMesh. Instanced props never cast shadows (plan 0.6).
import * as THREE from 'three';
import { emptyAssets, type Assets } from '../core/assets';
import { applyGroundAoTree } from './groundAo';
import type { PropSpot, CityLayout } from './cityGen';
import { boxAt, cylAt, mergeGeos } from './geomUtil';
import { flattenModel, type FlatModel } from './modelInstancing';
import type { StreetModel, SuppliedProp } from '../core/assets';

/** Signal lens phases, as the instance attribute encodes them. */
export type SignalPhase = 'red' | 'amber' | 'green';
const PHASE_INDEX: Record<SignalPhase, number> = { red: 0, amber: 1, green: 2 };

/**
 * The traffic lights, with one lens lit per instance. The signal system
 * (world/signals.ts) writes phases here; nothing in this file decides them.
 */
export interface SignalLenses {
  readonly count: number;
  setPhase(instance: number, phase: SignalPhase): void;
  /** Upload after a batch of setPhase calls; cheap when nothing changed. */
  commit(): void;
}

export interface PropsBuild {
  group: THREE.Group;
  /** Null when the supplied traffic light did not load (procedural red lens). */
  signals: SignalLenses | null;
  /** Which supplied models are on screen, for the smoke suite and the console report. */
  supplied: { streetlight: boolean; trafficLight: boolean };
  /** How far the lamp head reaches along local +Z from the pole, metres. */
  lampReach: number;
}

/** Warm sodium lamp head; the emissive is turned up at dusk. */
const LAMP_COLOR = 0xffd9a0;

/**
 * A supplied prop, flattened for instancing with its authored Y kept (the
 * converter already stood it on y = 0) and its materials cloned so the tuning
 * here does not leak into another use of the same glTF.
 */
function suppliedFlat(assets: Assets, name: SuppliedProp): FlatModel | null {
  const src = assets.suppliedProp(name);
  if (!src) return null;
  const flat = flattenModel(src, { keepY: true, keepXZ: true });
  if (!flat) return null;
  flat.materials = flat.materials.map((m) => m.clone());
  return flat;
}

/** The material of a flattened model whose glTF name matches. */
function materialNamed(flat: FlatModel, re: RegExp): THREE.MeshStandardMaterial | null {
  const m = flat.materials.find((x) => re.test(x.name)) as THREE.MeshStandardMaterial | undefined;
  return m && m.isMeshStandardMaterial ? m : null;
}

/**
 * A translucent cone of lamplight under each head, dusk only. Depth-read-only
 * so it never occludes; the fade to nothing at the rim is in the vertex alpha
 * rather than a texture.
 *
 * DECISION: ordinary alpha blending, not additive. Additive was tried first
 * and looked right for one lamp -- but a boulevard has forty in a row, and
 * seen down its length their faint cones stack into one bright pyramid that
 * fills the sky. Alpha blending saturates instead of summing, and the fog
 * takes the far ones out entirely.
 */
function lampConeGeo(headY: number, reach: number): THREE.BufferGeometry {
  const seg = 12, r = 2.6;
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
  pos.push(0, headY, reach); nrm.push(0, -1, 0); uv.push(0.5, 1); col.push(1, 1, 1, 0.55);
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pos.push(Math.sin(a) * r, 0.05, reach + Math.cos(a) * r);
    nrm.push(0, 1, 0); uv.push(i / seg, 0); col.push(1, 1, 1, 0);
  }
  for (let i = 1; i <= seg; i++) idx.push(0, i, i + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  return g;
}

/**
 * A Poly Haven street prop, instanced at `spots`.
 *
 * The models arrive from scripts/fetch-props.mjs already standing on y = 0 at
 * their real height, so nothing here rescales them: a 0.92 m bin is 0.92 m
 * because that is how tall a bin is, and the character walking past it is the
 * check on that.
 */
function placeStreet(
  assets: Assets, name: StreetModel, spots: PropSpot[], y: number,
): THREE.InstancedMesh | null {
  if (spots.length === 0) return null;
  const src = assets.street(name);
  if (!src) return null;
  const flat = flattenModel(src, { keepY: true, keepXZ: true });
  if (!flat) return null;
  return place(flat.geometry, flat.materials[0], spots, y);
}

function place(
  geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], spots: readonly PropSpot[],
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

/**
 * `skipVegetation` is set once world/vegetation.ts has taken over the palms and
 * park trees with real models; the procedural palm fronds and icosahedron
 * canopies below stay in the file as the documented fallback (ASSETS.md) and
 * are still what runs if the nature kit is missing.
 */
export function buildProps(
  layout: CityLayout, assets: Assets = emptyAssets(), skipVegetation = false, dusk = false,
): PropsBuild {
  const group = new THREE.Group();
  group.name = 'props';
  const p = layout.props;

  // --- palms -------------------------------------------------------------------
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0xa98b63, roughness: 0.95 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x4f9b46, roughness: 0.8, side: THREE.DoubleSide });
  if (!skipVegetation) {
    const trunk = cylAt(0.17, 0.32, 6.4, 6, 0, 3.2, 0);
    group.add(place(trunk, trunkMat, p.palms, 0.16, 0.06));
    group.add(place(crownGeo(), leafMat, p.palms, 6.5, 0.06));
  }

  // --- streetlights ------------------------------------------------------------
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x54585e, roughness: 0.55, metalness: 0.5 });
  const lamp = suppliedFlat(assets, 'streetlight');
  if (lamp) {
    const lit = materialNamed(lamp, /lighton|lit|lamp/i);
    if (lit) {
      lit.emissive.setHex(LAMP_COLOR);
      lit.emissiveIntensity = dusk ? 2.2 : 0.55;
    }
    group.add(place(lamp.geometry, lamp.materials, p.streetlights, 0.16));
    if (dusk) {
      // The head is at the far end of local +Z (the converter's reach line);
      // the cone hangs from the top of the model at that reach.
      const reach = lamp.box.max.z - 0.35;
      const cone = new THREE.MeshBasicMaterial({
        color: LAMP_COLOR, transparent: true, opacity: 0.42, vertexColors: true,
        depthWrite: false, side: THREE.DoubleSide, fog: true,
      });
      const cones = place(lampConeGeo(lamp.height - 0.4, reach), cone, p.streetlights, 0.16);
      cones.receiveShadow = false;
      cones.renderOrder = 2;
      group.add(cones);
    }
  } else {
    group.add(place(cylAt(0.08, 0.13, 7, 6, 0, 3.5, 0), poleMat, p.streetlights, 0.16));
    const head = mergeGeos([
      boxAt(0.14, 0.14, 1.9, 0, 6.95, 0.95),
      boxAt(0.5, 0.18, 0.9, 0, 6.82, 1.85),
    ]);
    group.add(place(head, new THREE.MeshStandardMaterial({
      color: 0x2a2c30, emissive: LAMP_COLOR, emissiveIntensity: dusk ? 1.6 : 0.55, roughness: 0.6,
    }), p.streetlights, 0.16));
  }

  // --- traffic lights ----------------------------------------------------------
  let signals: SignalLenses | null = null;
  const signal = suppliedFlat(assets, 'traffic-light');
  if (signal && p.trafficLights.length) {
    // One instance attribute holds which lens is lit; each lens material
    // multiplies its emissive by "is that me". Three materials, one draw call
    // each, however many hundred signals there are.
    const phases = new THREE.InstancedBufferAttribute(new Float32Array(p.trafficLights.length), 1);
    phases.setUsage(THREE.DynamicDrawUsage);
    signal.geometry.setAttribute('signalPhase', phases);
    for (const [name, index] of Object.entries(PHASE_INDEX) as Array<[SignalPhase, number]>) {
      const m = materialNamed(signal, new RegExp(`lens-${name}`));
      if (!m) continue;
      m.emissive.setHex(0xffffff);
      m.emissiveIntensity = 2.4;
      m.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float signalPhase;\nvarying float vSignalLit;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>\nvSignalLit = abs(signalPhase - ${index.toFixed(1)}) < 0.5 ? 1.0 : 0.0;`);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vSignalLit;')
          .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vSignalLit;');
      };
      m.needsUpdate = true;
    }
    const mesh = place(signal.geometry, signal.materials, p.trafficLights, 0.16);
    group.add(mesh);
    let dirty = true;
    signals = {
      count: p.trafficLights.length,
      setPhase(i, phase) {
        const v = PHASE_INDEX[phase];
        if (phases.getX(i) !== v) { phases.setX(i, v); dirty = true; }
      },
      commit() {
        if (!dirty) return;
        phases.needsUpdate = true;
        dirty = false;
      },
    };
  } else {
    group.add(place(cylAt(0.09, 0.11, 4.6, 6, 0, 2.3, 0), poleMat, p.trafficLights, 0.16));
    const tlHead = mergeGeos([
      boxAt(0.1, 0.1, 1.1, 0, 4.5, 0.55),
      boxAt(0.34, 0.95, 0.3, 0, 4.28, 1.1),
    ]);
    group.add(place(tlHead, new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.7 }), p.trafficLights, 0.16));
    group.add(place(boxAt(0.16, 0.16, 0.06, 0, 4.55, 1.28), new THREE.MeshStandardMaterial({
      color: 0x300000, emissive: 0xff2b1f, emissiveIntensity: 1.8,
    }), p.trafficLights, 0.16));
  }

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
    // Two thirds bins, one third fire hydrants: the city generator only has one
    // kind of small-sidewalk-prop spot, and a street with a hydrant on it reads
    // as an American city in a way a street of identical bins does not.
    const bins = p.bins.filter((_, i) => i % 3 !== 0);
    const hydrants = p.bins.filter((_, i) => i % 3 === 0);
    const binMesh = placeStreet(assets, 'bin', bins, 0.16);
    const hydrantMesh = placeStreet(assets, 'hydrant', hydrants, 0.16);
    if (binMesh) group.add(binMesh);
    if (hydrantMesh) group.add(hydrantMesh);
    // Fallback: the procedural bin covers every spot when the models are absent.
    if (!binMesh && !hydrantMesh) {
      group.add(place(cylAt(0.3, 0.26, 0.85, 8, 0, 0.42, 0),
        new THREE.MeshStandardMaterial({ color: 0x35604a, roughness: 0.8 }), p.bins, 0.16));
    } else if (!binMesh) {
      group.add(place(cylAt(0.3, 0.26, 0.85, 8, 0, 0.42, 0),
        new THREE.MeshStandardMaterial({ color: 0x35604a, roughness: 0.8 }), bins, 0.16));
    }
  }

  // --- park trees ---------------------------------------------------------------
  if (p.trees.length && !skipVegetation) {
    group.add(place(cylAt(0.22, 0.32, 3, 6, 0, 1.5, 0),
      new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.95 }), p.trees, 0.16));
    const foliage = mergeGeos([
      new THREE.IcosahedronGeometry(1.7, 0).translate(0, 4.1, 0),
      new THREE.IcosahedronGeometry(1.2, 0).translate(0.9, 3.2, 0.5),
    ]);
    group.add(place(foliage, new THREE.MeshStandardMaterial({ color: 0x4d8c40, roughness: 0.9, flatShading: true }), p.trees, 0.16));
  }

  // Ground contact (2.1). Props are short, so the fade is tighter than the
  // buildings' and the floor is lighter -- a 0.85 m bin should be shaded at its
  // base, not silhouetted.
  applyGroundAoTree(group, 1.4, 0.72);

  return {
    group, signals,
    supplied: { streetlight: lamp !== null, trafficLight: signal !== null },
    lampReach: lamp ? lamp.box.max.z : 1.9,
  };
}
