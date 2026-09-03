// Palms, broadleaf trees, shrubs and grass from the Kenney Nature Kit
// (realism pass 2.3). Falls back to the procedural palms and icosahedron
// canopies in props.ts when the models are not available.
//
// Two levels of detail per species: the detailed model inside `LOD_NEAR`, a
// cheaper one beyond it. Both are InstancedMeshes, and a plant swaps between
// them by having its matrix written into one set and zeroed in the other -- with
// hysteresis, so a tree sitting exactly on the boundary does not flicker between
// them every frame.
import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { Assets, NatureModel, SuppliedProp } from '../core/assets';
import type { PropSpot, CityLayout } from './cityGen';
import { flattenModel, cloneMaterials, makeInstanced, type FlatModel } from './modelInstancing';
import { createWind, type WindHandle } from './wind';
import { applyGroundAo } from './groundAo';

/** Beyond this the cheap model is used. Hysteresis widens it by HYST. */
const LOD_NEAR = 60;
const HYST = 8;
/** Only this many plants are re-tested per frame; the rest keep last frame's LOD. */
const LOD_BUDGET = 120;

/**
 * Art direction over the kit's own palette.
 *
 * The Nature Kit's palms ship salmon trunks and teal fronds, which is a
 * perfectly good look -- for the Nature Kit. Dropped into a sun-bleached
 * coastal city they read as a different game's assets. Materials are re-tinted
 * by name to the colours props.ts already used for the procedural palms, so
 * whichever path runs, the city looks like one place.
 */
const TINTS: Record<string, number> = {
  woodBark: 0x9c7a55,
  leafsGreen: 0x4f9440,
  grass: 0x5c9c3e,   // shrubs and grass tufts share one material name
  dirt: 0x8a7358,
  _defaultMat: 0x6a9c4a,
};

interface Species {
  near: NatureModel;
  far: NatureModel;
  /**
   * A supplied model that outranks the kit pair when it loaded. Joe's palm is
   * a textured 3.5k-triangle tree with a welded 900-triangle twin for the far
   * set; the Kenney pair stays as the fallback, and props.ts's fronds behind it.
   */
  supplied?: { near: SuppliedProp; far: SuppliedProp };
  /** Optional per-species override of TINTS, keyed the same way. */
  tint?: Record<string, number>;
  /** Metres tall the instances should end up, before per-instance variation. */
  height: number;
  /** Wind amplitude as a fraction of height. Palms move most. */
  wind: number;
  /** Whether the near LOD casts a real shadow. Ground cover does not. */
  shadow: boolean;
}

// Palm fronds sit lighter and yellower than inland canopies, which is most of
// what separates a beach from a park at a glance.
const PALM_TINT = { woodBark: 0xa9855e, leafsGreen: 0x5f9e46 };

const SUPPLIED_PALM = { near: 'palm', far: 'palm-far' } as const;
const PALMS: Species[] = [
  { near: 'tree_palmDetailedTall', far: 'tree_palmTall', height: 7.4, wind: 0.030, shadow: true, tint: PALM_TINT, supplied: SUPPLIED_PALM },
  { near: 'tree_palmDetailedShort', far: 'tree_palmBend', height: 5.6, wind: 0.034, shadow: true, tint: PALM_TINT, supplied: SUPPLIED_PALM },
];
const TREES: Species[] = [
  { near: 'tree_detailed', far: 'tree_default', height: 5.8, wind: 0.016, shadow: true },
  { near: 'tree_oak', far: 'tree_fat', height: 6.4, wind: 0.014, shadow: true },
];
const SHRUBS: Species[] = [
  { near: 'plant_bushDetailed', far: 'plant_bush', height: 1.0, wind: 0.020, shadow: false },
  { near: 'plant_bushLarge', far: 'plant_bush', height: 1.4, wind: 0.018, shadow: false },
];
const GRASS: Species[] = [
  { near: 'grass_large', far: 'grass', height: 0.5, wind: 0.045, shadow: false },
];

interface Placement {
  x: number; z: number;
  /** Index into the pair of InstancedMeshes for this species. */
  species: number;
  matrix: THREE.Matrix4;
  color: THREE.Color;
  /** true = currently drawn by the near mesh. */
  near: boolean;
}

interface Pair {
  near: THREE.InstancedMesh;
  far: THREE.InstancedMesh;
}

const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const P = new THREE.Vector3();
const S = new THREE.Vector3();

/** Build one species pair, or null if either model is missing. */
function buildPair(
  assets: Assets, spec: Species, capacity: number, wind: WindHandle, shadows: boolean,
): { pair: Pair; models: [FlatModel, FlatModel] } | null {
  const suppliedNear = spec.supplied ? assets.suppliedProp(spec.supplied.near) : null;
  const nearSrc = suppliedNear ?? assets.nature(spec.near);
  const farSrc = suppliedNear
    ? (assets.suppliedProp(spec.supplied!.far) ?? suppliedNear)
    : (assets.nature(spec.far) ?? nearSrc);
  if (!nearSrc || !farSrc) return null;
  const nearModel = flattenModel(nearSrc);
  const farModel = flattenModel(farSrc);
  if (!nearModel || !farModel) return null;

  const tints = { ...TINTS, ...(spec.tint ?? {}) };
  const make = (model: FlatModel): THREE.InstancedMesh => {
    const mats = cloneMaterials(model, (m) => {
      const hex = tints[m.name];
      if (hex !== undefined) (m as THREE.MeshStandardMaterial).color?.setHex(hex);
    });
    for (const m of mats) {
      wind.add(m, spec.wind);
      applyGroundAo(m, 1.5, 0.7);
    }
    const mesh = makeInstanced(model, mats, capacity);
    mesh.receiveShadow = shadows;
    return mesh;
  };

  const near = make(nearModel);
  const far = make(farModel);
  // DECISION: real cast shadows on the NEAR level of detail only, rather than
  // the blob shadows the brief offers as the cheap option. The near set holds
  // only the plants inside 60 m -- tens of instances, one extra draw call per
  // species in the shadow pass -- and a real palm shadow raked across a sunlit
  // road is most of what sells the low sun. The far set stays out of the shadow
  // map entirely, which is where the saving actually is.
  //
  // A blob-shadow version was built first and thrown away: MultiplyBlending
  // ignores alpha, so the quad multiplies the ground to black out to its corners
  // unless the texture is written as a luminance ramp that reaches white before
  // the edge -- and once it does, it is too faint to be worth the draw call.
  near.castShadow = spec.shadow;
  far.castShadow = false;

  return { pair: { near, far }, models: [nearModel, farModel] };
}

export interface Vegetation {
  group: THREE.Group;
  /** True when models loaded; false means props.ts must draw its fallbacks. */
  readonly active: boolean;
  /** Call once per rendered frame with the camera position and elapsed time. */
  update(camera: THREE.Vector3, time: number): void;
  dispose(): void;
}

/** An inert Vegetation, for when the nature models are unavailable. */
function inactive(): Vegetation {
  return {
    group: new THREE.Group(),
    active: false,
    update: () => {},
    dispose: () => {},
  };
}

export function buildVegetation(layout: CityLayout, assets: Assets): Vegetation {
  const wind = createWind();
  const group = new THREE.Group();
  group.name = 'vegetation';

  const rng = new Rng(90210);
  const placements: Placement[] = [];
  const pairs: Pair[] = [];

  /** Scatter one group of spots across a species set. */
  const scatter = (
    spots: readonly PropSpot[], set: Species[], hueJitter: number, receiveShadow: boolean,
  ): void => {
    if (spots.length === 0) return;

    // Only species whose models actually loaded take part; a missing model is
    // skipped rather than leaving a hole in the distribution.
    const built: Array<{ index: number; scale: number }> = [];
    for (const spec of set) {
      const b = buildPair(assets, spec, spots.length, wind, receiveShadow);
      if (!b) continue;
      group.add(b.pair.near, b.pair.far);
      // Normalise to the intended height: kit models are authored at whatever
      // scale suited the kit, and mixing them raw gives a park of bonsai.
      const authored = b.models[0].height || 1;
      built.push({ index: pairs.length, scale: spec.height / authored });
      pairs.push(b.pair);
    }
    if (built.length === 0) return;

    for (const spot of spots) {
      const chosen = built[rng.int(0, built.length - 1)];

      // Per-instance variation (2.3): scale 0.8-1.3, free rotation, a trunk
      // lean, and a hue shift, so no two copies read as the same asset.
      const scale = chosen.scale * spot.scale * rng.range(0.8, 1.3);
      E.set(rng.range(-0.06, 0.06), spot.rot + rng.range(0, Math.PI * 2), rng.range(-0.05, 0.05));
      Q.setFromEuler(E);
      P.set(spot.pos.x, 0, spot.pos.z);
      S.setScalar(scale);
      const matrix = new THREE.Matrix4().compose(P, Q, S);

      // +/-8% hue, expressed as a near-white multiplier so the model's own
      // colours survive and only shift warm or cool.
      const hue = rng.range(-hueJitter, hueJitter);
      const color = new THREE.Color(1 + hue * 1.4, 1 - Math.abs(hue) * 0.4, 1 - hue * 1.4);

      // The first level of detail is decided here, from the spawn, rather
      // than everyone starting near and the per-frame budget sorting it out:
      // on a slow machine that first sort took long enough to watch, with
      // nine hundred full-detail palms in the frame meanwhile.
      const d0 = Math.hypot(spot.pos.x - layout.spawns.player.x, spot.pos.z - layout.spawns.player.z);
      placements.push({
        x: spot.pos.x, z: spot.pos.z, species: chosen.index, matrix, color, near: d0 < LOD_NEAR,
      });
    }
  };

  scatter(layout.props.palms, PALMS, 0.06, true);
  scatter(layout.props.trees, TREES, 0.08, true);

  // Shrubs and grass in the parks and along residential blocks. These are not in
  // CityData, so they are generated here from the same block bounds the parks
  // were laid out on, deterministically from a fixed seed.
  const ground: PropSpot[] = [];
  const tufts: PropSpot[] = [];
  for (const block of layout.blocks) {
    const park = layout.parks.includes(block);
    if (!park && block.zone !== 'residential') continue;
    const b = block.bounds;
    const pad = 5;
    const n = park ? 26 : 8;
    for (let i = 0; i < n; i++) {
      const spot: PropSpot = {
        pos: { x: rng.range(b.minX + pad, b.maxX - pad), z: rng.range(b.minZ + pad, b.maxZ - pad) },
        rot: rng.range(0, Math.PI * 2),
        scale: rng.range(0.8, 1.25),
      };
      (i % 3 === 0 ? ground : tufts).push(spot);
    }
  }
  scatter(ground, SHRUBS, 0.07, false);
  scatter(tufts, GRASS, 0.1, false);

  if (pairs.length === 0) return inactive();

  // --- LOD --------------------------------------------------------------------
  let cursor = 0;
  let firstPass = true;
  const counts = pairs.map(() => ({ near: 0, far: 0 }));

  /** Rewrite every instance matrix from the current near/far assignment. */
  const commit = (): void => {
    for (const c of counts) { c.near = 0; c.far = 0; }
    for (const p of placements) {
      const pair = pairs[p.species];
      const c = counts[p.species];
      const target = p.near ? pair.near : pair.far;
      const slot = p.near ? c.near++ : c.far++;
      target.setMatrixAt(slot, p.matrix);
      target.setColorAt(slot, p.color);
    }
    for (let i = 0; i < pairs.length; i++) {
      pairs[i].near.count = counts[i].near;
      pairs[i].far.count = counts[i].far;
      pairs[i].near.instanceMatrix.needsUpdate = true;
      pairs[i].far.instanceMatrix.needsUpdate = true;
      const nc = pairs[i].near.instanceColor;
      const fc = pairs[i].far.instanceColor;
      if (nc) nc.needsUpdate = true;
      if (fc) fc.needsUpdate = true;
    }
  };

  commit();

  return {
    group,
    active: true,
    update(camera: THREE.Vector3, time: number): void {
      wind.update(time);
      if (placements.length === 0) return;
      // Re-test a slice of the population per frame. A plant only ever moves
      // one LOD step, and the hysteresis band is 8 m wide, so spreading the
      // test over a few frames is invisible and keeps this off the hot path.
      let changed = false;
      // The first frame re-tests everyone: the camera is wherever the intro
      // put it, which is nowhere near the spawn the build assumed.
      const n = firstPass ? placements.length : Math.min(LOD_BUDGET, placements.length);
      firstPass = false;
      for (let k = 0; k < n; k++) {
        const p = placements[cursor];
        cursor = (cursor + 1) % placements.length;
        const d = Math.hypot(p.x - camera.x, p.z - camera.z);
        const want = p.near ? d < LOD_NEAR + HYST : d < LOD_NEAR - HYST;
        if (want !== p.near) { p.near = want; changed = true; }
      }
      if (changed) commit();
    },
    dispose(): void {
      group.removeFromParent();
      for (const pair of pairs) {
        for (const m of [pair.near, pair.far]) {
          m.geometry.dispose();
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const mat of mats) mat.dispose();
        }
      }
    },
  };
}
