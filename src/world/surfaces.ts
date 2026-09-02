// Real PBR surfaces for the city's walls and ground (realism pass 2.4 / 2.6).
//
// The albedo is *composited*, not swapped: the procedural window grid in
// core/textures.ts is what makes a box read as a building, and throwing it away
// for a photographed wall would lose that. So the ambientCG albedo is multiplied
// underneath the windows, the weathering is painted on top, and the downloaded
// normal and roughness maps are attached alongside at their own tiling. The
// result has the window layout the city generator intended and the surface
// relief a photograph gives it.
import * as THREE from 'three';
import type { Assets, MaterialName, PbrMaps } from '../core/assets';
import { Rng } from '../core/rng';

/** Canvas size for a composited facade. 1024 is the source texture's own size. */
const FACADE_SIZE = 512;

export interface SurfaceOptions {
  /** Grime strength at the base, 0..1. */
  grime?: number;
  /** Streaks under the window rows. */
  streaks?: boolean;
  /**
   * 'wall' multiplies the material over the whole facade -- brick and stucco are
   * the wall. 'curtain' leaves the glass alone and lays concrete spandrel bands
   * across alternating storeys instead, which is how a glass tower is actually
   * built and what stops a photographed concrete smearing over the windows.
   */
  mode: 'wall' | 'curtain';
  /**
   * Paint a street-level shopfront band into the bottom row: awning, sign board
   * and a glazed frontage.
   *
   * // DECISION: painted into the albedo rather than built as instanced
   * geometry. The facade texture tiles up the building, so the bottom row of the
   * texture IS the ground floor for every instance regardless of height -- one
   * canvas gets shopfronts on every street-facing wall in the city for no draw
   * calls and no per-building placement pass. Real recessed frontages would need
   * geometry per building and a distance swap; that is the version to build if
   * the camera is ever expected to stand at a doorway.
   */
  shopfront?: boolean;
}

/** Awning, sign band and glazing across the bottom storey of the facade. */
function shopfront(ctx: CanvasRenderingContext2D, rng: Rng): void {
  const { width: w, height: h } = ctx.canvas;
  const row = h / 8;          // one storey
  const top = h - row;
  const units = 4;
  const uw = w / units;

  for (let i = 0; i < units; i++) {
    const x = i * uw;
    // Glazed frontage: darker and cooler than the wall above it.
    ctx.fillStyle = `rgba(38,44,54,${rng.range(0.55, 0.78)})`;
    ctx.fillRect(x + 3, top + row * 0.34, uw - 6, row * 0.56);
    // Door.
    ctx.fillStyle = 'rgba(24,26,32,0.85)';
    ctx.fillRect(x + uw * (rng.chance(0.5) ? 0.12 : 0.66), top + row * 0.4, uw * 0.2, row * 0.5);
    // Sign band above the glass.
    const hue = Math.floor(rng.range(0, 360));
    ctx.fillStyle = `hsl(${hue} 55% 52%)`;
    ctx.fillRect(x + 2, top + row * 0.14, uw - 4, row * 0.16);
    // Awning: a lighter strip with a scalloped lower edge.
    ctx.fillStyle = `hsl(${hue} 45% 68%)`;
    ctx.fillRect(x + 1, top + row * 0.30, uw - 2, row * 0.06);
    // Step.
    ctx.fillStyle = 'rgba(210,206,196,0.7)';
    ctx.fillRect(x + 2, top + row * 0.92, uw - 4, row * 0.06);
  }
}

/**
 * Clone a loaded PBR set with its own repeat, so two materials can tile the same
 * source at different scales without fighting over one Texture object.
 */
function tiled(maps: PbrMaps, repeatX: number, repeatY: number): PbrMaps {
  const clone = (t: THREE.Texture | null): THREE.Texture | null => {
    if (!t) return null;
    const c = t.clone();
    c.wrapS = c.wrapT = THREE.RepeatWrapping;
    c.repeat.set(repeatX, repeatY);
    c.needsUpdate = true;
    return c;
  };
  return { color: clone(maps.color), normal: clone(maps.normal), rough: clone(maps.rough) };
}

/** Draw `img` tiled over the whole canvas at `tiles` repeats. */
function drawTiled(
  ctx: CanvasRenderingContext2D, img: CanvasImageSource, tiles: number, op: GlobalCompositeOperation,
): void {
  const step = ctx.canvas.width / tiles;
  ctx.globalCompositeOperation = op;
  for (let y = 0; y < tiles; y++) {
    for (let x = 0; x < tiles; x++) ctx.drawImage(img, x * step, y * step, step, step);
  }
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * Weathering: a grime gradient up the bottom of the facade and dirt streaks
 * running down from the window sills.
 *
 * Both are the same observation -- buildings are dirtiest where water runs off
 * them and where the street throws grit at them -- and both are what stop a
 * flat-coloured box reading as new-built.
 */
function weather(ctx: CanvasRenderingContext2D, strength: number, streaks: boolean, rng: Rng): void {
  const { width: w, height: h } = ctx.canvas;
  ctx.globalCompositeOperation = 'multiply';

  if (streaks) {
    // The window grid is 8x8 in the source texture; streaks fall from each row.
    for (let row = 0; row < 8; row++) {
      const y = ((row + 0.86) * h) / 8;
      for (let i = 0; i < 10; i++) {
        const x = rng.range(0, w);
        const len = rng.range(h * 0.02, h * 0.09);
        const wide = rng.range(1.5, 5);
        const g = ctx.createLinearGradient(0, y, 0, y + len);
        const a = rng.range(0.08, 0.22);
        g.addColorStop(0, `rgba(70,64,56,${a})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x, y, wide, len);
      }
    }
  }

  if (strength > 0) {
    // Bottom of the canvas is the bottom of the facade: the texture is tiled up
    // the building, so this reads as grime on the lowest storey.
    const g = ctx.createLinearGradient(0, h, 0, h * 0.72);
    g.addColorStop(0, `rgba(58,52,45,${0.5 * strength})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, h * 0.7, w, h * 0.3);
  }

  ctx.globalCompositeOperation = 'source-over';
}

/**
 * Composite a facade albedo: the wall material multiplied under the window grid,
 * then weathered.
 *
 * `seed` gives every bucket its own streak pattern, so two neighbouring
 * buildings that happen to share a height bucket are not the same wall twice.
 */
export function facadeAlbedo(
  windows: THREE.Texture, wall: PbrMaps | null, opts: SurfaceOptions, seed: number,
): THREE.CanvasTexture | null {
  const src = windows.image as CanvasImageSource | undefined;
  if (!src) return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = FACADE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.drawImage(src, 0, 0, FACADE_SIZE, FACADE_SIZE);
  const wallImg = wall?.color?.image as CanvasImageSource | undefined;

  if (wallImg && opts.mode === 'wall') {
    // Two tiles of wall per tile of windows: brick and stucco read at a finer
    // scale than a storey does. Partial alpha because a straight multiply of a
    // mid-grey scan pulls the whole palette two stops down.
    // 0.55 alpha, then a firm screen-lift. A full-strength multiply of a
    // photographed brick pulls the whole pastel palette two stops down and the
    // city stops being a sunbelt city; this keeps the grain and gives the
    // per-building instance colour room to still be the thing you read.
    ctx.globalAlpha = 0.55;
    drawTiled(ctx, wallImg, 2, 'multiply');
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = 'rgba(255,255,255,0.30)';
    ctx.fillRect(0, 0, FACADE_SIZE, FACADE_SIZE);
    ctx.globalCompositeOperation = 'source-over';
  } else if (wallImg) {
    // Curtain wall: concrete spandrels on alternating storeys, clipped to a
    // band so the glass rows between them stay glass.
    const rows = 8;
    const band = FACADE_SIZE / rows;
    for (let row = 0; row < rows; row += 2) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, row * band, FACADE_SIZE, band * 0.34);
      ctx.clip();
      ctx.globalAlpha = 0.72;
      ctx.drawImage(wallImg, 0, 0, FACADE_SIZE, FACADE_SIZE);
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }
  if (opts.shopfront) shopfront(ctx, new Rng(seed * 31 + 5));
  weather(ctx, opts.grime ?? 0, opts.streaks ?? false, new Rng(seed));

  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * A ground material: PBR albedo, normal and roughness at a world-metre tiling,
 * tinted to the palette the procedural version used so the look survives.
 */
/**
 * A ground material: PBR albedo, normal and roughness at a world-metre tiling,
 * tinted to the palette the procedural version used so the look survives.
 *
 * `geomTile` is the tile the MeshBuilder already divided world coordinates by:
 * ground UVs are world-space, so the repeat needed to land one texture tile per
 * `metres` is geomTile / metres, NOT the world size. Getting this wrong tiles a
 * 700 m road tens of thousands of times and it averages out to flat grey.
 */
export function groundMaterial(
  assets: Assets, name: MaterialName, geomTile: number, metres: number, tint: number,
  fallback: THREE.Texture | null,
): THREE.MeshStandardMaterial {
  const maps = assets.material(name);
  const repeat = geomTile / metres;
  if (!maps || !maps.color) {
    // Documented fallback (ASSETS.md): the canvas textures from core/textures.ts.
    return new THREE.MeshStandardMaterial({ map: fallback, color: tint, roughness: 1, metalness: 0 });
  }
  const t = tiled(maps, repeat, repeat);
  const mat = new THREE.MeshStandardMaterial({
    map: t.color,
    normalMap: t.normal,
    roughnessMap: t.rough,
    color: tint,
    roughness: 1,
    metalness: 0,
  });
  // The maps are 1 m-ish scans; at street scale the relief is far too strong.
  if (t.normal) mat.normalScale.set(0.6, 0.6);
  return mat;
}

/** Attach a wall material's normal and roughness to an already-built material. */
export function attachWallRelief(
  mat: THREE.MeshStandardMaterial, maps: PbrMaps | null, repeatX: number, repeatY: number,
  normalScale = 0.7,
): void {
  if (!maps) return;
  const t = tiled(maps, repeatX, repeatY);
  if (t.normal) {
    mat.normalMap = t.normal;
    mat.normalScale.set(normalScale, normalScale);
  }
  if (t.rough) mat.roughnessMap = t.rough;
  mat.needsUpdate = true;
}

/** Wall material each zone is faced in. */
export const ZONE_WALL: Record<string, MaterialName> = {
  downtown: 'concrete',
  midtown: 'stucco-a',
  residential: 'stucco-b',
  beach: 'stucco-a',
};

/** Which of the two stuccos a building uses, so neighbours differ. */
export function wallFor(colorIdx: number, cool: boolean): MaterialName {
  if (cool) return 'concrete';
  const pick = colorIdx % 3;
  return pick === 0 ? 'brick' : pick === 1 ? 'stucco-a' : 'stucco-b';
}
