// Kenney Car Kit bodies and wheels, prepared once and shared by every vehicle
// (realism pass 2.5). Falls back to the procedural boxes in vehicleMesh.ts when
// the models are missing.
//
// The kit paints every car from one 512 px palette texture: each surface samples
// a solid patch, and the body's paint is one of them. That makes per-car colour
// awkward -- tinting the material would tint the glass and the tyres with it.
// So the palette lookup is baked into vertex colours at load, the paint patch is
// found as the modal colour of the body's own vertices, and a `paint` attribute
// marks it. One uniform per car then repaints just those faces, with the shared
// geometry untouched.
import * as THREE from 'three';
import type { Assets, CarModel } from '../core/assets';
import type { VehicleKind } from '../types';
import { flattenModel } from '../world/modelInstancing';
import { prepareSupplied } from './suppliedCars';
import { SUPPLIED_CARS, type SuppliedCar } from '../core/assets';

/** Which kit model each of the game's four kinds uses. */
export const KIND_MODEL: Record<VehicleKind, CarModel> = {
  sedan: 'sedan',
  sports: 'sedan-sports',
  pickup: 'truck',
  police: 'police',
};

/** Target OBB from config: length 4.4, width 2.0. Models are scaled to fit. */
const TARGET_LENGTH = 4.4;

export interface WheelSlot {
  x: number;
  y: number;
  z: number;
  front: boolean;
}

export interface CarModelData {
  /** Body geometry with baked vertex colours and a `paint` mask attribute. */
  body: THREE.BufferGeometry;
  /** Wheel geometry, origin at the axle. Null when the wheels are part of the
   *  body and cannot be driven separately (see suppliedCars.ts). */
  wheel: THREE.BufferGeometry | null;
  /** Where the artist put the wheels, in the scaled model's own space. */
  wheels: WheelSlot[];
  /** Radius of the wheel after scaling, so the body sits at the right height. */
  wheelRadius: number;
  /** A supplied car's own PBR material; null for the vertex-coloured kit path. */
  texturedMaterial?: THREE.MeshStandardMaterial | null;
  /** The colour the supplied model was painted, for the per-car HSV remap. */
  basePaint?: THREE.Color | null;
  /** True when the model paints its own head and tail lights into its texture. */
  bakedLights?: boolean;
}

/** Read a loaded texture's pixels once, for baking. */
function readPixels(texture: THREE.Texture): { data: Uint8ClampedArray; w: number; h: number } | null {
  const img = texture.image as HTMLImageElement | HTMLCanvasElement | ImageBitmap | undefined;
  if (!img) return null;
  const w = (img as HTMLImageElement).width;
  const h = (img as HTMLImageElement).height;
  if (!w || !h) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img as CanvasImageSource, 0, 0);
  try {
    return { data: ctx.getImageData(0, 0, w, h).data, w, h };
  } catch {
    return null; // tainted canvas; caller falls back
  }
}

/**
 * Replace the texture lookup with a per-vertex colour, and mark the vertices
 * that share the mesh's most common colour as `paint`.
 *
 * Modal colour is the right test here because a car body IS mostly its paint:
 * the glass, the grille and the trim are each a handful of faces next to it.
 */
function bakeVertexColors(
  geo: THREE.BufferGeometry, pixels: { data: Uint8ClampedArray; w: number; h: number },
  markPaint: boolean,
): void {
  const uv = geo.getAttribute('uv');
  const pos = geo.getAttribute('position');
  if (!uv || !pos) return;

  const n = pos.count;
  const colors = new Float32Array(n * 3);
  const keys = new Int32Array(n);
  const counts = new Map<number, number>();
  const c = new THREE.Color();

  for (let i = 0; i < n; i++) {
    // glTF UVs have v = 0 at the top of the image, which is where a canvas
    // starts too, so no flip.
    const px = Math.min(pixels.w - 1, Math.max(0, Math.round(uv.getX(i) * (pixels.w - 1))));
    const py = Math.min(pixels.h - 1, Math.max(0, Math.round(uv.getY(i) * (pixels.h - 1))));
    const o = (py * pixels.w + px) * 4;
    const r = pixels.data[o], g = pixels.data[o + 1], b = pixels.data[o + 2];
    c.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    const key = (r << 16) | (g << 8) | b;
    keys[i] = key;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const paint = new Float32Array(n);
  if (markPaint) {
    let best = -1, bestCount = -1;
    for (const [key, count] of counts) if (count > bestCount) { bestCount = count; best = key; }
    for (let i = 0; i < n; i++) paint[i] = keys[i] === best ? 1 : 0;
  }
  geo.setAttribute('paint', new THREE.BufferAttribute(paint, 1));
  geo.deleteAttribute('uv');
}

/** First material's map found under `root`, for the palette bake. */
function findMap(root: THREE.Object3D): THREE.Texture | null {
  let map: THREE.Texture | null = null;
  root.traverse((o) => {
    if (map) return;
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
      THREE.MeshStandardMaterial | undefined;
    if (mat?.map) map = mat.map;
  });
  return map;
}

/**
 * Split a kit car into a body and one wheel, both baked and scaled so the body
 * matches the collision OBB the physics already uses.
 *
 * // DECISION: the model is fitted to the OBB, never the other way round. The
 * handling in config.ts is tuned against a 4.4 x 2.0 box and every collision in
 * the game assumes it; a model that changed those numbers would silently retune
 * the whole vehicle model.
 */
export function prepareCar(assets: Assets, model: CarModel): CarModelData | null {
  const src = assets.car(model);
  if (!src) return null;

  const map = findMap(src);
  const pixels = map ? readPixels(map) : null;
  if (!pixels) return null;

  // Split the kit car into "everything that is not a wheel node" and the wheel
  // nodes. Using the car's OWN wheels rather than the kit's generic
  // wheel-default.glb matters: a sedan's wheels are not a truck's, and a wheel
  // that does not match its arches is the first thing the eye picks up.
  const bodyRoot = new THREE.Group();
  const wheelNodes: THREE.Object3D[] = [];
  src.updateWorldMatrix(true, true);
  for (const child of src.children) {
    if (/wheel/i.test(child.name)) wheelNodes.push(child);
    else bodyRoot.add(child.clone(true));
  }
  if (bodyRoot.children.length === 0 || wheelNodes.length !== 4) return null;

  // Scale from the WHOLE car's length, not the body's: the physics OBB is 4.4 m
  // bumper to bumper, and on most kit cars the wheel arches reach further than
  // the panels do.
  const whole = new THREE.Box3().setFromObject(src);
  const scale = TARGET_LENGTH / Math.max(whole.max.z - whole.min.z, 1e-3);

  // keepY: the body's underside sits above the axle line by design. Dropping it
  // to y = 0 the way vegetation is re-origined would bury the wheels in it.
  const bodyFlat = flattenModel(bodyRoot, { keepY: true, keepXZ: true });
  if (!bodyFlat) return null;
  bodyFlat.geometry.scale(scale, scale, scale);
  bakeVertexColors(bodyFlat.geometry, pixels, true);
  bodyFlat.geometry.computeBoundingBox();
  bodyFlat.geometry.computeBoundingSphere();

  // One wheel, re-origined on its own axle so spin and steer rotate about the
  // right point; the other three are the same mesh at mirrored positions.
  //
  // flattenModel resolves geometry into the root it is GIVEN, so passing the
  // wheel node yields geometry already local to that node -- no un-shifting by
  // the node's world position, only a nudge so the axle sits at the origin.
  const sample = wheelNodes[0];
  const wheelFlat = flattenModel(sample, { keepY: true, keepXZ: true });
  if (!wheelFlat) return null;
  wheelFlat.geometry.scale(scale, scale, scale);
  wheelFlat.geometry.computeBoundingBox();
  const wb = wheelFlat.geometry.boundingBox ?? new THREE.Box3();
  const radius = (wb.max.y - wb.min.y) / 2;
  wheelFlat.geometry.translate(0, -(wb.min.y + wb.max.y) / 2, 0);
  bakeVertexColors(wheelFlat.geometry, pixels, false);
  wheelFlat.geometry.computeBoundingBox();
  wheelFlat.geometry.computeBoundingSphere();

  const slots: WheelSlot[] = wheelNodes.map((node) => {
    const p = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld);
    return { x: p.x * scale, y: p.y * scale, z: p.z * scale, front: p.z > 0 };
  });

  return { body: bodyFlat.geometry, wheel: wheelFlat.geometry, wheels: slots, wheelRadius: radius };
}

// --- registry ---------------------------------------------------------------
//
// Prepared once at world build and shared by every vehicle: the geometry for a
// kind is identical, only the paint uniform differs.
const PREPARED = new Map<VehicleKind, CarModelData>();

/** Prepare every kind's model. Safe to call with an Assets that loaded nothing. */
export function initCarModels(assets: Assets): void {
  PREPARED.clear();
  for (const kind of Object.keys(KIND_MODEL) as VehicleKind[]) {
    // A car supplied in raw/ outranks the kit body for its kind (brief 7b).
    const data = (SUPPLIED_CARS.includes(kind as SuppliedCar)
      ? prepareSupplied(assets, kind as SuppliedCar) : null)
      ?? prepareCar(assets, KIND_MODEL[kind]);
    if (data) PREPARED.set(kind, data);
  }
}

/** Which kinds ended up on a supplied body, for ASSETS.md parity and the smoke suite. */
export function carModelSources(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [kind, data] of PREPARED) out[kind] = data.texturedMaterial ? 'supplied' : 'kit';
  return out;
}

/** Prepared model for `kind`, or null when the procedural body should be used. */
export function carModelFor(kind: VehicleKind): CarModelData | null {
  return PREPARED.get(kind) ?? null;
}

/**
 * Patch a material so `paint`-marked vertices take a uniform colour instead of
 * their baked one. Returns the uniform the caller sets per vehicle.
 */
export function paintable(material: THREE.Material, color: THREE.Color): { value: THREE.Color } {
  const uniform = { value: color };
  const prev = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.carPaint = uniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float paint;
        varying float vPaint;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vPaint = paint;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vPaint;
        uniform vec3 carPaint;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb = mix( diffuseColor.rgb, carPaint, vPaint );`);
  };
  material.needsUpdate = true;
  return uniform;
}
