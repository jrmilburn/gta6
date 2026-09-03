// Cars Joe dropped into public/assets/raw/ (integration pass, section 6).
//
// Rule 7b of the brief: a car supplied in raw/ outranks anything fetched. Poly
// Haven has no drivable cars at all -- one tarpaulin-covered prop -- so without
// these the whole section would have fallen back to the stylised Kenney kit.
// scripts/convert-cars.mjs has already turned them onto the game's axes, fitted
// them to the 4.4 m collision box and welded them down to a traffic-affordable
// triangle count; everything left is runtime.
//
// The wheels are part of the body mesh, so they cannot spin or steer -- see the
// DECISION on `prepareSupplied`.
import * as THREE from 'three';
import type { Assets, SuppliedCar } from '../core/assets';
import type { CarModelData } from './carModels';

/** Resolution the albedo is sampled at to find the car's own paint colour. */
const SAMPLE_SIZE = 128;

function readPixels(texture: THREE.Texture, size: number): ImageData | null {
  const img = texture.image as CanvasImageSource | undefined;
  if (!img || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(img, 0, 0, size, size);
    return ctx.getImageData(0, 0, size, size);
  } catch {
    return null;
  }
}

/**
 * The colour this car was painted, as the modal colour of its albedo.
 *
 * A car body IS mostly its paint -- the glass, the grille and the tyres are each
 * a fraction of the sheet next to it -- so the mode is the paint. Quantised to
 * 5 bits a channel first, because a generated texture has no flat colours and
 * the exact modal RGB of a noisy sheet is one pixel out of a million. Near-black
 * and near-white are skipped: they are shadow, glass and chrome.
 */
export function basePaintColor(map: THREE.Texture): THREE.Color | null {
  const src = readPixels(map, SAMPLE_SIZE);
  if (!src) return null;
  const bins = new Map<number, number>();
  const d = src.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i] + d[i + 1] + d[i + 2]) / 765;
    if (lum < 0.08 || lum > 0.95) continue;
    const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }
  let best = -1, bestCount = 0;
  for (const [key, count] of bins) if (count > bestCount) { bestCount = count; best = key; }
  if (best < 0) return null;
  return new THREE.Color(((best >> 10) & 31) / 31, ((best >> 5) & 31) / 31, (best & 31) / 31);
}

/**
 * Repaint a textured car by remapping the whole albedo in HSV.
 *
 * DECISION: no paint mask. The first version of this built one, by finding the
 * pixels close to the car's own paint and recolouring those -- and it mottled,
 * because a generated albedo carries grime, panel gaps and baked reflections
 * that swing any per-pixel colour test back and forth across its threshold, so
 * the "paint" crawled over the bodywork in patches.
 *
 * An HSV remap needs no test at all. Hue is rotated by the difference between
 * the car's own paint and the colour this car wants, and saturation and value
 * are scaled by the same ratio. Every crease, reflection and smear keeps its
 * exact relative shading, and the parts that were never painted look after
 * themselves: glass, tyres and chrome have no saturation to rotate, so a hue
 * shift moves them not at all.
 */
export function repaint(
  material: THREE.Material, base: THREE.Color, target: THREE.Color,
): { value: THREE.Vector3 } {
  const from = { h: 0, s: 0, l: 0 };
  const to = { h: 0, s: 0, l: 0 };
  base.getHSL(from);
  target.getHSL(to);
  // Hue as a rotation, saturation and lightness as ratios, all clamped so a
  // near-grey source cannot divide its way to an infinity.
  const uniform = {
    value: new THREE.Vector3(
      to.h - from.h,
      Math.min(4, to.s / Math.max(from.s, 0.05)),
      Math.min(3, to.l / Math.max(from.l, 0.05)),
    ),
  };
  const prev = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.carPaint = uniform;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 carPaint;
        vec3 carRgb2Hsv( vec3 c ) {
          vec4 K = vec4( 0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0 );
          vec4 p = mix( vec4( c.bg, K.wz ), vec4( c.gb, K.xy ), step( c.b, c.g ) );
          vec4 q = mix( vec4( p.xyw, c.r ), vec4( c.r, p.yzx ), step( p.x, c.r ) );
          float d = q.x - min( q.w, q.y );
          return vec3( abs( q.z + ( q.w - q.y ) / ( 6.0 * d + 1e-10 ) ),
                       d / ( q.x + 1e-10 ), q.x );
        }
        vec3 carHsv2Rgb( vec3 c ) {
          vec4 K = vec4( 1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0 );
          vec3 p = abs( fract( c.xxx + K.xyz ) * 6.0 - K.www );
          return c.z * mix( K.xxx, clamp( p - K.xxx, 0.0, 1.0 ), c.y );
        }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec3 carHsv = carRgb2Hsv( diffuseColor.rgb );
        carHsv.x = fract( carHsv.x + carPaint.x );
        carHsv.y = clamp( carHsv.y * carPaint.y, 0.0, 1.0 );
        carHsv.z = clamp( carHsv.z * carPaint.z, 0.0, 1.0 );
        diffuseColor.rgb = carHsv2Rgb( carHsv );`);
  };
  material.needsUpdate = true;
  return uniform;
}

/**
 * Prepare one supplied car.
 *
 * // DECISION: the wheels are not separated. Both models are a single welded
 * mesh with no wheel nodes, and the brief's instruction for that case -- hide
 * them and use the procedural wheels -- cannot apply when they are the same
 * triangles as the arch above them. So the car is drawn whole and its wheels
 * neither spin nor steer. Visible if you look for it at a standstill; invisible
 * at any speed, and much less visible than four grey cylinders half-buried in
 * the bodywork would be. Fixed by an export with wheel nodes, not by code.
 */
export function prepareSupplied(assets: Assets, model: SuppliedCar): CarModelData | null {
  const src = assets.supplied(model);
  if (!src) return null;

  let mesh: THREE.Mesh | null = null;
  src.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!mesh && m.isMesh) mesh = m;
  });
  if (!mesh) return null;
  const found = mesh as THREE.Mesh;

  const material = (Array.isArray(found.material) ? found.material[0] : found.material) as
    THREE.MeshStandardMaterial;
  const geometry = found.geometry;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const box = geometry.boundingBox ?? new THREE.Box3();
  // A car's wheels are a bit under a sixth of its length; only used to sit the
  // body at the right height, and this model's body is already sitting on its
  // own tyres, so it is reported rather than applied.
  const wheelRadius = (box.max.z - box.min.z) / 13;

  return {
    body: geometry,
    wheel: null,
    wheels: [],
    wheelRadius,
    texturedMaterial: material,
    basePaint: material.map ? basePaintColor(material.map) : null,
    // The model's own texture already has headlights and tail lights painted
    // into it; the emissive boxes the kit cars need would sit proud of the
    // bodywork here. Only the brake glow is kept, and only because it is
    // gameplay feedback rather than decoration.
    bakedLights: true,
  };
}
