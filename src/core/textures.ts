// Every texture in the game is drawn to a canvas at boot. No external assets.
import * as THREE from 'three';
import { Rng } from './rng';

function makeCanvas(size: number, h = size): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  return ctx;
}

function toTexture(ctx: CanvasRenderingContext2D, repeat = 1, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(ctx.canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function noise(ctx: CanvasRenderingContext2D, rng: Rng, amount: number, alpha: number): void {
  const { width: w, height: h } = ctx.canvas;
  for (let i = 0; i < amount; i++) {
    const v = Math.floor(rng.range(0, 60));
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha})`;
    ctx.fillRect(rng.range(0, w), rng.range(0, h), rng.range(1, 4), rng.range(1, 4));
  }
}

let cache: Textures | null = null;

export interface Textures {
  asphalt: THREE.CanvasTexture;
  sidewalk: THREE.CanvasTexture;
  windowsWarm: THREE.CanvasTexture;
  windowsCool: THREE.CanvasTexture;
  sand: THREE.CanvasTexture;
  grass: THREE.CanvasTexture;
  neon(word: string, color: string): THREE.CanvasTexture;
}

/** Plain asphalt with speckle. Lane markings are drawn as separate thin quads. */
function asphaltTex(rng: Rng): THREE.CanvasTexture {
  const ctx = makeCanvas(256);
  ctx.fillStyle = '#3a3a40';
  ctx.fillRect(0, 0, 256, 256);
  noise(ctx, rng, 2400, 0.35);
  return toTexture(ctx, 1);
}

function sidewalkTex(rng: Rng): THREE.CanvasTexture {
  const ctx = makeCanvas(256);
  ctx.fillStyle = '#c9c6bd';
  ctx.fillRect(0, 0, 256, 256);
  noise(ctx, rng, 900, 0.18);
  ctx.strokeStyle = 'rgba(120,118,110,0.55)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    const p = (i * 256) / 4;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, 256); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(256, p); ctx.stroke();
  }
  return toTexture(ctx, 1);
}

/** Grid of lit/unlit window rectangles. `cool` gives glass-blue downtown towers. */
function windowsTex(rng: Rng, cool: boolean): THREE.CanvasTexture {
  const ctx = makeCanvas(256);
  ctx.fillStyle = cool ? '#2b3a52' : '#d8cdbd';
  ctx.fillRect(0, 0, 256, 256);
  const cols = 8, rows = 8, pad = 5;
  const cw = 256 / cols, ch = 256 / rows;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const lit = rng.chance(cool ? 0.42 : 0.3);
      if (lit) {
        const warm = rng.range(0.75, 1);
        ctx.fillStyle = cool
          ? `rgba(${Math.floor(150 * warm)},${Math.floor(200 * warm)},255,0.95)`
          : `rgba(255,${Math.floor(220 * warm)},${Math.floor(160 * warm)},0.95)`;
      } else {
        ctx.fillStyle = cool ? 'rgba(30,50,80,0.95)' : 'rgba(90,90,100,0.75)';
      }
      ctx.fillRect(x * cw + pad, y * ch + pad, cw - pad * 2, ch - pad * 2);
    }
  }
  return toTexture(ctx, 1);
}

function sandTex(rng: Rng): THREE.CanvasTexture {
  const ctx = makeCanvas(256);
  ctx.fillStyle = '#e3d3a8';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 3000; i++) {
    const v = rng.range(0, 1);
    ctx.fillStyle = `rgba(${200 + v * 40},${180 + v * 40},${140 + v * 40},0.5)`;
    ctx.fillRect(rng.range(0, 256), rng.range(0, 256), 2, 2);
  }
  return toTexture(ctx, 1);
}

function grassTex(rng: Rng): THREE.CanvasTexture {
  const ctx = makeCanvas(256);
  ctx.fillStyle = '#6ea24f';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2500; i++) {
    const v = rng.range(0, 1);
    ctx.fillStyle = `rgba(${70 + v * 60},${130 + v * 60},${60 + v * 40},0.5)`;
    ctx.fillRect(rng.range(0, 256), rng.range(0, 256), 2, 3);
  }
  return toTexture(ctx, 1);
}

/** Invented brand word on a dark plate, used as an emissive map for neon signs. */
function neonTex(word: string, color: string): THREE.CanvasTexture {
  const ctx = makeCanvas(512, 128);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 512, 128);
  ctx.font = 'bold 64px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = color;
  ctx.shadowBlur = 26;
  ctx.fillStyle = color;
  ctx.fillText(word, 256, 68);
  ctx.fillStyle = '#ffffff';
  ctx.shadowBlur = 12;
  ctx.fillText(word, 256, 68);
  const t = new THREE.CanvasTexture(ctx.canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function getTextures(): Textures {
  if (cache) return cache;
  const rng = new Rng(20260902);
  cache = {
    asphalt: asphaltTex(rng),
    sidewalk: sidewalkTex(rng),
    windowsWarm: windowsTex(rng, false),
    windowsCool: windowsTex(rng, true),
    sand: sandTex(rng),
    grass: grassTex(rng),
    neon: neonTex,
  };
  return cache;
}
