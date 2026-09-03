// Up-front asset load, behind the title screen's progress bar.
//
// Nothing in the game blocks on a download: every load is wrapped so a failure
// resolves to null, is reported once, and leaves the caller on its procedural
// fallback (see ASSETS.md). The bundle is deliberately small -- 7.4 MB total --
// so this is a couple of seconds cold and instant warm.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { loadCharacter, type CharacterSource } from './character';

const BASE = 'assets/';

/** Every material folder under public/assets/textures. */
export const MATERIALS = [
  'concrete', 'stucco-a', 'stucco-b', 'brick',
  'asphalt', 'pavement', 'sand', 'roof-metal',
] as const;
export type MaterialName = (typeof MATERIALS)[number];

/** Car bodies, keyed by the game's vehicle kinds plus traffic-only extras. */
export const CAR_MODELS = [
  'sedan', 'sedan-sports', 'hatchback-sports', 'truck', 'police', 'van', 'suv',
  'wheel-default',
] as const;
export type CarModel = (typeof CAR_MODELS)[number];

/**
 * Cars Joe supplied in raw/ and scripts/convert-cars.mjs converted. Any that
 * are absent simply fall through to the kit body for that kind.
 */
export const SUPPLIED_CARS = ['sedan', 'sports', 'pickup', 'police'] as const;
export type SuppliedCar = (typeof SUPPLIED_CARS)[number];

export const NATURE_MODELS = [
  'tree_palmDetailedTall', 'tree_palmDetailedShort', 'tree_palmBend', 'tree_palmTall',
  'tree_oak', 'tree_detailed', 'tree_default', 'tree_fat', 'tree_small',
  'plant_bush', 'plant_bushDetailed', 'plant_bushLarge',
  'grass', 'grass_large', 'rock_smallA',
] as const;
export type NatureModel = (typeof NATURE_MODELS)[number];

export const PROP_MODELS = ['fence', 'fence-low', 'planter', 'tree-small'] as const;
export type PropModel = (typeof PROP_MODELS)[number];

/** Poly Haven street furniture, fetched and converted by scripts/fetch-props.mjs. */
export const STREET_MODELS = ['bin', 'hydrant'] as const;
export type StreetModel = (typeof STREET_MODELS)[number];

/**
 * Files the character load fetches, for the progress bar's denominator: the
 * manifest plus the hero plus one per clip. Off by a clip either way only
 * changes how smoothly the bar moves, never whether it reaches 1.
 */
const CHARACTER_FILES = 7;

/** A loaded PBR material set. Any map may be absent if that file failed. */
export interface PbrMaps {
  color: THREE.Texture | null;
  normal: THREE.Texture | null;
  rough: THREE.Texture | null;
}

export interface Assets {
  /** True when at least the environment map loaded; false = fully procedural. */
  readonly ok: boolean;
  env: THREE.DataTexture | null;
  material(name: MaterialName): PbrMaps | null;
  car(name: CarModel): THREE.Object3D | null;
  /** A car supplied in raw/, which outranks the kit body for its kind. */
  supplied(name: SuppliedCar): THREE.Object3D | null;
  /** The skinned hero and its clips, or null when running procedural. */
  character: CharacterSource | null;
  nature(name: NatureModel): THREE.Object3D | null;
  prop(name: PropModel): THREE.Object3D | null;
  street(name: StreetModel): THREE.Object3D | null;
  /** Names that failed to load, for the console report and ASSETS.md parity. */
  readonly failed: readonly string[];
}

export type ProgressFn = (fraction: number, label: string) => void;

/** Number of individual files `loadAssets` will fetch, for the progress bar. */
function fileCount(): number {
  return 1 + MATERIALS.length * 3 + CAR_MODELS.length + SUPPLIED_CARS.length
    + NATURE_MODELS.length + PROP_MODELS.length + STREET_MODELS.length + CHARACTER_FILES;
}

function makeGltfLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  // Kenney's kits are not Draco-compressed today, but wiring the decoder costs
  // nothing until a .glb actually declares the extension, and a kit re-release
  // that turns it on would otherwise fail to load with no obvious cause.
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
  loader.setDRACOLoader(draco);
  return loader;
}

export async function loadAssets(
  renderer: THREE.WebGLRenderer, hdri: string, onProgress: ProgressFn = () => {},
): Promise<Assets> {
  const failed: string[] = [];
  const total = fileCount();
  let done = 0;
  const tick = (label: string): void => {
    done++;
    onProgress(Math.min(1, done / total), label);
  };

  /** Never rejects: a failed asset becomes null and the caller falls back. */
  async function attempt<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      const v = await fn();
      tick(label);
      return v;
    } catch {
      failed.push(label);
      tick(label);
      return null;
    }
  }

  const gltf = makeGltfLoader();
  const tex = new THREE.TextureLoader();

  const loadTexture = (url: string, srgb: boolean): Promise<THREE.Texture> =>
    new Promise((resolve, reject) => {
      tex.load(url, (t) => {
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
        resolve(t);
      }, undefined, reject);
    });

  const loadModel = (url: string): Promise<THREE.Object3D> =>
    new Promise((resolve, reject) => {
      gltf.load(url, (g) => resolve(g.scene), undefined, reject);
    });

  // --- environment ----------------------------------------------------------
  const env = await attempt('hdri', () => new Promise<THREE.DataTexture>((resolve, reject) => {
    new RGBELoader().load(`${BASE}hdri/${hdri}`, resolve, undefined, reject);
  }));

  // --- textures -------------------------------------------------------------
  const materials = new Map<MaterialName, PbrMaps>();
  for (const name of MATERIALS) {
    const [color, normal, rough] = await Promise.all([
      attempt(`${name}/color`, () => loadTexture(`${BASE}textures/${name}/color.webp`, true)),
      attempt(`${name}/normal`, () => loadTexture(`${BASE}textures/${name}/normal.webp`, false)),
      attempt(`${name}/rough`, () => loadTexture(`${BASE}textures/${name}/rough.webp`, false)),
    ]);
    if (color || normal || rough) materials.set(name, { color, normal, rough });
  }

  // --- models ---------------------------------------------------------------
  const cars = new Map<string, THREE.Object3D>();
  const supplied = new Map<string, THREE.Object3D>();
  const nature = new Map<string, THREE.Object3D>();
  const props = new Map<string, THREE.Object3D>();
  const street = new Map<string, THREE.Object3D>();

  const group = async (
    names: readonly string[], dir: string, into: Map<string, THREE.Object3D>,
  ): Promise<void> => {
    const loaded = await Promise.all(
      names.map((n) => attempt(`${dir}/${n}`, () => loadModel(`${BASE}models/${dir}/${n}.glb`))),
    );
    names.forEach((n, i) => { const o = loaded[i]; if (o) into.set(n, o); });
  };

  // --- character -----------------------------------------------------------
  // Loaded before the props so the loading bar spends its longest single file
  // early; the hero is 2.8 MB against a few tens of KB for everything else.
  const character = await attempt('character', () => loadCharacter(
    `${BASE}character/`,
    (url) => new Promise((resolve, reject) => { gltf.load(url, resolve, undefined, reject); }),
    tick,
  ));

  await group(CAR_MODELS, 'cars', cars);
  await group(SUPPLIED_CARS, 'supplied', supplied);
  await group(NATURE_MODELS, 'nature', nature);
  await group(PROP_MODELS, 'props', props);
  await group(STREET_MODELS, 'street', street);

  if (failed.length) {
    // console.log, not console.error: the smoke suite gates on zero console
    // errors, and a missing asset is a documented fallback, not a failure.
    console.log(`assets: ${failed.length} missing, using procedural fallbacks (${failed.join(', ')})`);
  }

  return {
    ok: env !== null,
    env,
    character: character ?? null,
    failed,
    material: (n) => materials.get(n) ?? null,
    car: (n) => cars.get(n) ?? null,
    supplied: (n) => supplied.get(n) ?? null,
    nature: (n) => nature.get(n) ?? null,
    prop: (n) => props.get(n) ?? null,
    street: (n) => street.get(n) ?? null,
  };
}

/** An Assets with nothing in it, for dev scenes that skip the load. */
export function emptyAssets(): Assets {
  return {
    ok: false, env: null, character: null, failed: [],
    material: () => null, car: () => null, supplied: () => null,
    nature: () => null, prop: () => null, street: () => null,
  };
}
