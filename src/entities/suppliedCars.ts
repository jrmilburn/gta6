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
  return modalColor(src.data, 4, false);
}

/**
 * The same, read off a vertex-colour attribute for a car whose albedo was
 * baked at conversion (see scripts/convert-cars.mjs). COLOR_0 is linear;
 * the mode is taken in sRGB so the same 5-bit bins mean the same thing.
 */
export function basePaintFromVertices(geometry: THREE.BufferGeometry): THREE.Color | null {
  const attr = geometry.getAttribute('color');
  if (!attr) return null;
  return modalColor(attr.array as ArrayLike<number>, attr.itemSize, true);
}

const SRGB = new THREE.Color();
/**
 * The modal colour of a sheet of pixels, preferring a SATURATED mode.
 *
 * A generated albedo is mostly filler: the dark grey between its islands, the
 * near-black of tyres, sills and vents. Counted naively, that grey wins, and a
 * hue rotation keyed off grey turns every dark part of the car the target
 * colour and the actual paint something else. So the mode is taken among the
 * pixels with real saturation first, and the plain mode is only the fallback
 * for a car that genuinely is white, grey or black.
 */
function modalColor(data: ArrayLike<number>, stride: number, linearUnit: boolean): THREE.Color | null {
  const all = new Map<number, number>();
  const vivid = new Map<number, number>();
  let samples = 0;
  for (let i = 0; i < data.length; i += stride) {
    let r = data[i], g = data[i + 1], b = data[i + 2];
    if (linearUnit) {
      SRGB.setRGB(r, g, b).convertLinearToSRGB();
      r = SRGB.r * 255; g = SRGB.g * 255; b = SRGB.b * 255;
    }
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const lum = (r + g + b) / 765;
    if (lum < 0.08 || lum > 0.95) continue;
    samples++;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    all.set(key, (all.get(key) ?? 0) + 1);
    if (max > 0 && (max - min) / max > 0.35) vivid.set(key, (vivid.get(key) ?? 0) + 1);
  }
  const mode = (bins: Map<number, number>): [number, number] => {
    let best = -1, bestCount = 0;
    for (const [key, count] of bins) if (count > bestCount) { bestCount = count; best = key; }
    return [best, bestCount];
  };
  let vividTotal = 0;
  for (const c of vivid.values()) vividTotal += c;
  // Saturated paint has to be a real share of the sheet to count as the paint.
  const [vKey] = mode(vivid);
  const [aKey] = mode(all);
  const best = samples > 0 && vividTotal / samples > 0.08 && vKey >= 0 ? vKey : aKey;
  if (best < 0) return null;
  return new THREE.Color(((best >> 10) & 31) / 31, ((best >> 5) & 31) / 31, (best & 31) / 31);
}

/**
 * Repaint a textured car by remapping its albedo in HSV.
 *
 * Hue is rotated by the difference between the car's own paint and the colour
 * this car wants, and saturation and lightness are scaled by the same ratio,
 * so every crease, reflection and smear keeps its exact relative shading.
 *
 * DECISION: a SOFT mask on hue and saturation, not a hard one and not none.
 * The first version had a hard per-pixel test and mottled, because a generated
 * albedo carries grime and baked reflections that swing any threshold back and
 * forth across the bodywork. The second had no mask at all, which was smooth --
 * and turned every tyre, window and splitter maroon, because "black" on a
 * generated sheet is a very dark orange, and a 4x saturation ratio makes that
 * a colour. The weight below is 1 for a pixel that is clearly the paint (near
 * its hue, reasonably saturated), 0 for chrome, glass and rubber, and ramps
 * between over a wide enough band that no edge of it is visible.
 */
export function repaint(
  material: THREE.Material, base: THREE.Color, target: THREE.Color,
): { value: THREE.Vector3 } {
  // A baked car carries its albedo in COLOR_0, which the shader multiplies in
  // one include later than the map. The remap goes wherever the colour is.
  const std = material as THREE.MeshStandardMaterial;
  const hook = std.map ? '#include <map_fragment>' : '#include <color_fragment>';
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
  // The paint's own hue in the shader's linear space, for the mask. The base
  // was read in sRGB; hue barely moves between the two, saturation does, so
  // only the hue is used from here.
  const linearBase = base.clone().convertSRGBToLinear();
  const lb = { h: 0, s: 0, l: 0 };
  linearBase.getHSL(lb);
  const baseHsv = { value: new THREE.Vector3(lb.h, lb.s, lb.l) };
  const prev = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.carPaint = uniform;
    shader.uniforms.carBase = baseHsv;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 carPaint;
        uniform vec3 carBase;
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
      .replace(hook, `${hook}
        vec3 carHsv = carRgb2Hsv( diffuseColor.rgb );
        float carHueD = abs( carHsv.x - carBase.x );
        carHueD = min( carHueD, 1.0 - carHueD );
        float carW = ( 1.0 - smoothstep( 0.06, 0.16, carHueD ) )
          * smoothstep( 0.12, 0.35, carHsv.y )
          * smoothstep( 0.04, 0.12, carHsv.z );
        vec3 carNew = carHsv;
        carNew.x = fract( carNew.x + carPaint.x );
        carNew.y = clamp( carNew.y * carPaint.y, 0.0, 1.0 );
        carNew.z = clamp( carNew.z * carPaint.z, 0.0, 1.0 );
        diffuseColor.rgb = mix( diffuseColor.rgb, carHsv2Rgb( carNew ), carW );`);
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
    basePaint: material.map ? basePaintColor(material.map) : basePaintFromVertices(geometry),
    // The model's own texture already has headlights and tail lights painted
    // into it; the emissive boxes the kit cars need would sit proud of the
    // bodywork here. Only the brake glow is kept, and only because it is
    // gameplay feedback rather than decoration.
    bakedLights: true,
  };
}
