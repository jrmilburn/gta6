// Image-based lighting from a Poly Haven HDRI (realism pass 2.1).
//
// Two jobs. First, prefilter the equirect into an environment map so every
// MeshStandardMaterial in the world picks up real sky colour and real
// reflections instead of a flat hemisphere fill. Second -- and this is what
// stops the lighting and the backdrop disagreeing -- read the sun's *actual*
// position and colour back out of the HDRI and point the shadow-casting
// directional light at it.
//
// Reading the sun from the image rather than hand-entering an azimuth means
// swapping the HDRI moves the shadows to match, with nothing else to update.
import * as THREE from 'three';

export interface SunReading {
  /** Unit vector from the world origin toward the sun. */
  dir: THREE.Vector3;
  /** Sun colour, normalised so the brightest channel is 1. */
  color: THREE.Color;
  /** Mean sky radiance, for scaling the ambient fill. */
  skyLuminance: number;
  /** Horizon colour, for tinting the visible dome to agree with the lighting. */
  horizon: THREE.Color;
}

/** Downsample factor when scanning: 1K equirect -> ~128x64 samples. */
const SCAN_STEP = 8;

/** How much of the prefiltered environment reaches the scene. See below. */
const ENV_INTENSITY = 0.55;

function luminance(r: number, g: number, b: number): number {
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

/**
 * Find the brightest region of an equirectangular HDRI and read the sun off it.
 *
 * A single brightest texel is noisy and can land on a specular glint, so the
 * peak is used only to seed a weighted centroid over every sample above a share
 * of it -- the sun disc's centre of mass. Elevation is clamped above the horizon
 * because a sun read at or below 0 produces shadows that stretch to infinity.
 */
export function readSun(hdr: THREE.DataTexture): SunReading {
  const img = hdr.image as unknown as { width: number; height: number; data: Float32Array | Uint16Array };
  const { width, height, data } = img;
  const float = data instanceof Float32Array;

  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * width + x) * 4;
    if (float) return [data[i], data[i + 1], data[i + 2]];
    // Half-float fallback: decode enough for a relative brightness comparison.
    return [decodeHalf(data[i]), decodeHalf(data[i + 1]), decodeHalf(data[i + 2])];
  };

  let peak = 0;
  let skySum = 0, skyCount = 0;
  for (let y = 0; y < height; y += SCAN_STEP) {
    for (let x = 0; x < width; x += SCAN_STEP) {
      const [r, g, b] = at(x, y);
      const l = luminance(r, g, b);
      if (l > peak) peak = l;
      // Upper half only: the lower hemisphere of an outdoor HDRI is ground.
      if (y < height / 2) { skySum += l; skyCount++; }
    }
  }

  // Weighted centroid of everything within 25% of the peak.
  const cut = peak * 0.75;
  let wx = 0, wy = 0, wz = 0, wr = 0, wg = 0, wb = 0, wsum = 0;
  for (let y = 0; y < height; y += SCAN_STEP) {
    for (let x = 0; x < width; x += SCAN_STEP) {
      const [r, g, b] = at(x, y);
      const l = luminance(r, g, b);
      if (l < cut) continue;
      const u = (x + 0.5) / width;
      const v = (y + 0.5) / height;
      // three.js equirect convention: u wraps around Y, v runs top (+Y) to bottom.
      const phi = v * Math.PI;
      const theta = (u - 0.5) * Math.PI * 2;
      const sy = Math.cos(phi);
      const sr = Math.sin(phi);
      wx += -Math.sin(theta) * sr * l;
      wy += sy * l;
      wz += -Math.cos(theta) * sr * l;
      wr += r * l; wg += g * l; wb += b * l;
      wsum += l;
    }
  }

  const dir = new THREE.Vector3(0.4, 0.35, -0.85);
  if (wsum > 0) dir.set(wx / wsum, wy / wsum, wz / wsum);
  if (dir.lengthSq() < 1e-8) dir.set(0.4, 0.35, -0.85);
  dir.normalize();
  // Keep the sun a believable height above the horizon: a low sun is the look,
  // a sun at or below 0 is shadows of infinite length and no key light at all.
  if (dir.y < 0.12) { dir.y = 0.12; dir.normalize(); }

  const color = new THREE.Color(1, 0.92, 0.82);
  if (wsum > 0) {
    const m = Math.max(wr, wg, wb) || 1;
    color.setRGB(wr / m, wg / m, wb / m);
  }

  // Horizon tint: a band of samples either side of the equator, averaged.
  const horizon = new THREE.Color(0, 0, 0);
  let hr = 0, hg = 0, hb = 0, hc = 0;
  const band = Math.max(1, Math.round(height * 0.04));
  for (let y = Math.round(height / 2) - band; y < height / 2 + band; y += 2) {
    for (let x = 0; x < width; x += SCAN_STEP) {
      const [r, g, b] = at(x, y);
      // Clip the sun itself out so a low sun does not turn the whole dome white.
      if (luminance(r, g, b) > peak * 0.25) continue;
      hr += r; hg += g; hb += b; hc++;
    }
  }
  if (hc > 0) {
    const m = Math.max(hr, hg, hb) / hc || 1;
    horizon.setRGB(hr / hc / m, hg / hc / m, hb / hc / m);
  }

  return { dir, color, skyLuminance: skyCount ? skySum / skyCount : 1, horizon };
}

/** IEEE half-precision -> number, for HDRIs loaded as HalfFloatType. */
function decodeHalf(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  const v = e === 0
    ? (f / 1024) * Math.pow(2, -14)
    : e === 0x1f ? (f ? NaN : Infinity) : (1 + f / 1024) * Math.pow(2, e - 15);
  return s ? -v : v;
}

export interface EnvRig {
  texture: THREE.Texture;
  sun: SunReading;
  dispose(): void;
}

/**
 * Prefilter `hdr` and install it as `scene.environment`.
 *
 * The scene *background* is deliberately left alone: the visible sky stays the
 * hand-authored gradient dome, tinted from `sun.horizon` so the backdrop and the
 * lighting agree without giving up the stylised look.
 */
export function installEnvironment(
  renderer: THREE.WebGLRenderer, scene: THREE.Scene, hdr: THREE.DataTexture,
): EnvRig {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const target = pmrem.fromEquirectangular(hdr);
  const sun = readSun(hdr);
  scene.environment = target.texture;
  // DECISION: 0.55, not 1. A full-strength sunset environment lights the shadow
  // side of every wall nearly as brightly as the lit side, and the city goes
  // flat -- the exact thing the directional sun exists to prevent. Half strength
  // keeps the sky's colour and its reflections while leaving the key light room
  // to actually read as a key light.
  scene.environmentIntensity = ENV_INTENSITY;
  pmrem.dispose();
  hdr.dispose();
  return {
    texture: target.texture,
    sun,
    dispose(): void {
      scene.environment = null;
      target.dispose();
    },
  };
}
