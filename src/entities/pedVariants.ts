// Turning one supplied character into a crowd (integration pass, section 5).
//
// Joe's raw/ folder has exactly one person in it, so every pedestrian is that
// person. Two things stop that reading as a city of clones: six recoloured
// copies of the texture, and three heights. Both are built here at boot.
//
// This file also bakes the far-distance pedestrian: one mid-stride frame of the
// walk, skinned on the CPU into a plain BufferGeometry and welded down to
// something an InstancedMesh can afford sixty-four of.
import * as THREE from 'three';
import { CFG } from '../config';
import type { CharacterSource } from '../core/character';

const A = CFG.anim;

/** Palette size for the recolour. See the note in `buildPalettes`. */
const PALETTE_SIZE = 512;

/**
 * Hue offsets in degrees, one per pedestrian variant. The first is the hero's
 * own colours, unshifted, so the player and the crowd share a baseline.
 */
const HUE_SHIFTS = [0, 47, 96, 152, 208, 275];
/** Paired lightness nudges, so two variants never differ by hue alone. */
const LIGHT_SHIFTS = [0, -0.06, 0.05, -0.03, 0.07, -0.08];

export const PED_VARIANT_COUNT = HUE_SHIFTS.length;
export const PED_SCALES: readonly number[] = [0.92, 1.0, 1.06];

function rgbToHsl(r: number, g: number, b: number, out: number[]): void {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0, s = 0;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  out[0] = h; out[1] = s; out[2] = l;
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number, out: number[]): void {
  if (s < 1e-6) { out[0] = out[1] = out[2] = l * 255; return; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  out[0] = hue2rgb(p, q, h + 1 / 3) * 255;
  out[1] = hue2rgb(p, q, h) * 255;
  out[2] = hue2rgb(p, q, h - 1 / 3) * 255;
}

/**
 * Is this pixel skin or hair rather than clothing?
 *
 * DECISION: the brief's first choice is to recolour "the clothing regions in
 * the texture", and its fallback is a whole-texture lightness shift if the
 * regions cannot be separated. Neither is quite right here. The Ch06 atlas
 * packs face, arms, hair and shirt into one 2K sheet with no mask and no
 * documented layout, so the regions cannot be separated *by UV* -- but they can
 * be separated by colour, which is what the regions were going to be used for
 * anyway. Anything in the skin hue band or dark enough to be hair keeps its
 * hue and only takes the lightness nudge; everything else is clothing and gets
 * the full shift. A crowd where four people share a skin tone and nobody shares
 * a shirt beats six people who differ by 10% brightness.
 */
function isSkinOrHair(h: number, s: number, l: number): boolean {
  if (l < 0.18) return true;                        // hair, and the shoe soles
  if (l > 0.94 || s < 0.10) return false;           // whites and greys are cloth
  const deg = h * 360;
  return deg >= 8 && deg <= 52 && s <= 0.78;        // the skin-tone wedge
}

/**
 * Six recoloured copies of the character's albedo.
 *
 * Downsampled to 512 first: a pedestrian is read between 10 and 50 m where 512
 * is already more texture than the silhouette can show, and six full 2K passes
 * in JavaScript is 25 million pixels of boot time for detail nobody sees.
 */
export function buildPalettes(albedo: THREE.Texture | null): THREE.Texture[] {
  const image = albedo?.image as CanvasImageSource | undefined;
  if (!image || typeof document === 'undefined') return [];
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PALETTE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(image, 0, 0, PALETTE_SIZE, PALETTE_SIZE);
  const base = ctx.getImageData(0, 0, PALETTE_SIZE, PALETTE_SIZE);

  const out: THREE.Texture[] = [];
  const hsl = [0, 0, 0], rgb = [0, 0, 0];
  for (let v = 0; v < PED_VARIANT_COUNT; v++) {
    const shift = HUE_SHIFTS[v] / 360;
    const light = LIGHT_SHIFTS[v];
    const img = new ImageData(new Uint8ClampedArray(base.data), PALETTE_SIZE, PALETTE_SIZE);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      rgbToHsl(d[i], d[i + 1], d[i + 2], hsl);
      const skin = isSkinOrHair(hsl[0], hsl[1], hsl[2]);
      const h = skin ? hsl[0] : (hsl[0] + shift) % 1;
      const l = THREE.MathUtils.clamp(hsl[2] + light * (skin ? 0.4 : 1), 0.02, 0.98);
      hslToRgb(h, hsl[1], l, rgb);
      d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2];
    }
    const c = document.createElement('canvas');
    c.width = c.height = PALETTE_SIZE;
    c.getContext('2d')?.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    // glTF UVs are top-left origin, so the loader leaves flipY off; a canvas
    // texture defaults to on and would render the crowd's faces upside down.
    tex.flipY = false;
    tex.needsUpdate = true;
    out.push(tex);
  }
  return out;
}

/**
 * One recoloured copy of the albedo in a uniform: everything that is not skin
 * or hair pushed to `hue` at `sat`, and darkened by `light`. The police wear
 * this; the hue shifts above would only ever make a colourful civilian.
 */
export function buildUniformPalette(
  albedo: THREE.Texture | null, hue: number, sat: number, light: number,
): THREE.Texture | null {
  const image = albedo?.image as CanvasImageSource | undefined;
  if (!image || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PALETTE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, PALETTE_SIZE, PALETTE_SIZE);
  const img = ctx.getImageData(0, 0, PALETTE_SIZE, PALETTE_SIZE);
  const d = img.data;
  const hsl = [0, 0, 0], rgb = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) {
    rgbToHsl(d[i], d[i + 1], d[i + 2], hsl);
    if (isSkinOrHair(hsl[0], hsl[1], hsl[2])) continue;
    hslToRgb(hue, sat, THREE.MathUtils.clamp(hsl[2] * light, 0.03, 0.9), rgb);
    d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2];
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

/** One palette's material set, keyed by the source material name. */
export function buildPaletteMaterials(
  source: CharacterSource, palettes: THREE.Texture[],
): Array<Map<string, THREE.Material>> {
  const names: string[] = [];
  const originals = new Map<string, THREE.MeshStandardMaterial>();
  source.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const std = m as THREE.MeshStandardMaterial;
      if (originals.has(std.name)) continue;
      originals.set(std.name, std);
      names.push(std.name);
    }
  });

  return palettes.map((tex) => {
    const map = new Map<string, THREE.Material>();
    for (const name of names) {
      const src = originals.get(name);
      if (!src) continue;
      const copy = src.clone();
      // Only the sheet the base colour came from is recoloured; the normal map
      // is geometry, and hue-shifting it would light the crowd from six
      // different directions.
      if (copy.map) copy.map = tex;
      map.set(name, copy);
    }
    return map;
  });
}

/**
 * Skin one frame of the walk on the CPU and weld the result down.
 *
 * Returns one geometry per source primitive, in the same order, already
 * flattened into the character's own space with the feet at y = 0.
 */
export interface BakedPart { geometry: THREE.BufferGeometry; material: string }

export function bakeStaticPose(source: CharacterSource): BakedPart[] {
  const clip = source.clips.get('walk') ?? source.clips.get('jog');
  const root = source.scene;
  if (clip) {
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(clip);
    action.play();
    action.setEffectiveWeight(1);
    // A quarter through the cycle: one leg forward, one back, arms opposed --
    // the frame that reads as "walking" when nothing is moving.
    action.time = clip.duration * 0.25;
    mixer.update(0);
    mixer.uncacheRoot(root);
  }
  root.updateMatrixWorld(true);
  const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert();

  const out: BakedPart[] = [];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const src = mesh.geometry.getAttribute('position');
    const uv = mesh.geometry.getAttribute('uv');
    const index = mesh.geometry.getIndex();
    const local = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
    const posed = new Float32Array(src.count * 3);
    for (let i = 0; i < src.count; i++) {
      v.fromBufferAttribute(src, i);
      mesh.applyBoneTransform(i, v);
      v.applyMatrix4(local);
      posed[i * 3] = v.x; posed[i * 3 + 1] = v.y; posed[i * 3 + 2] = v.z;
    }
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    out.push({ geometry: cluster(posed, uv, index), material: mat.name });
  });
  return out;
}

/**
 * Vertex clustering: quantise every position onto a grid, keep one vertex per
 * occupied cell, and rewrite the triangles onto the survivors.
 *
 * Crude, and deliberately so. Beyond 45 m a pedestrian is about forty pixels
 * tall; what survives at that size is the silhouette and the shirt colour, and
 * both come through a 6 cm weld intact. It takes 53k triangles to under two.
 */
function cluster(
  positions: Float32Array, uv: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null,
  index: THREE.BufferAttribute | null,
): THREE.BufferGeometry {
  const cell = A.staticCluster;
  const key = new Map<string, number>();
  const remap = new Int32Array(positions.length / 3);
  const outPos: number[] = [];
  const outUv: number[] = [];
  for (let i = 0; i < remap.length; i++) {
    const k = `${Math.round(positions[i * 3] / cell)},`
      + `${Math.round(positions[i * 3 + 1] / cell)},`
      + `${Math.round(positions[i * 3 + 2] / cell)}`;
    const hit = key.get(k);
    if (hit !== undefined) { remap[i] = hit; continue; }
    const next = outPos.length / 3;
    key.set(k, next);
    remap[i] = next;
    outPos.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    outUv.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
  }

  const tris: number[] = [];
  const count = index ? index.count : remap.length;
  for (let i = 0; i < count; i += 3) {
    const a = remap[index ? index.getX(i) : i];
    const b = remap[index ? index.getX(i + 1) : i + 1];
    const c = remap[index ? index.getX(i + 2) : i + 2];
    // Two corners in the same cell is a triangle with no area left.
    if (a === b || b === c || a === c) continue;
    tris.push(a, b, c);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2));
  geo.setIndex(tris);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}
