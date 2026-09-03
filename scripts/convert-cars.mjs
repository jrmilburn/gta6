#!/usr/bin/env node
// Build step: public/assets/raw/<kind>/**.fbx -> public/assets/models/supplied/<kind>.glb
//
// The brief's rule 7b: any car Joe drops into raw/ takes priority over anything
// fetched. He dropped two, exported from Meshy with their PBR maps as loose
// sibling PNGs the FBX never references -- which is why they arrive untextured.
// This wires the maps on, turns the car onto the game's axes, fits it to the
// collision box the physics already uses, and welds it down to a triangle count
// forty traffic cars can afford.
//
// Run: node scripts/convert-cars.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readGlb, writeGlb } from './glb.mjs';
import {
  flatten, orientAndFit, packGlb, simplify, uvFragmentation, bakeVertexColors, weldByPosition,
} from './mesh.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'public/assets/raw');
const OUT = path.join(ROOT, 'public/assets/models/supplied');
const TMP = path.join(os.tmpdir(), 'sunbelt-cars');
const FBX2GLTF = path.join(
  ROOT, 'node_modules/fbx2gltf/bin', os.type(), os.type() === 'Windows_NT' ? 'FBX2glTF.exe' : 'FBX2glTF',
);

/** Directory name in raw/ -> the game's vehicle kind. */
const KINDS = [
  [/sports?car|sports/i, 'sports'],
  [/sedan|saloon/i, 'sedan'],
  [/pickup|truck/i, 'pickup'],
  [/police|cop/i, 'police'],
];

/** The collision OBB from config.ts. Models are fitted to it, never the reverse. */
const TARGET_LENGTH = 4.4;
const TEX_SIZE = 1024;
/**
 * DECISION: 24k triangles a car. Traffic instances the same body up to forty
 * times, so the budget is really a million triangles of moving car; the sports
 * export arrives at 551k, which is a sculpting artefact rather than detail
 * anyone sees from a chase camera. The sedan's 65k is welded to the same figure
 * so the two do not shade differently side by side.
 */
const MAX_TRIS = 24_000;
/**
 * DECISION: a car whose atlas is a chart per triangle is baked to vertex colour.
 *
 * The sports export is 551k triangles with its albedo cut into a hundred
 * thousand postage stamps -- every triangle its own island. Simplify that to a
 * drivable count and each surviving triangle spans dozens of islands, so the
 * texture becomes orange-and-black confetti no matter how good the
 * simplification is. Sampling the albedo at every one of the half-million
 * vertices first, then simplifying, keeps the colour where it was on the
 * surface: a vertex every three centimetres on a four-metre car is finer than
 * anyone sees from the chase camera. The normal and roughness maps go with the
 * atlas; the paint material's own metalness and roughness stand in. A properly
 * unwrapped export (the sedan) keeps its maps.
 */
const FRAGMENTED_ATLAS = 0.3;
/** The baked car spends its budget on shape rather than on a map. */
const MAX_TRIS_BAKED = 36_000;

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

function kindFor(dir) {
  for (const [re, kind] of KINDS) if (re.test(dir)) return kind;
  return null;
}

function findFiles(dir, test) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findFiles(full, test));
    else if (test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Meshy names its maps after the mesh: `<base>.png` is the albedo and
 * `<base>_normal|_roughness|_metallic.png` are the rest. Matching on the suffix
 * means any exporter following the same convention just works.
 */
function findMaps(dir) {
  const pngs = findFiles(dir, (n) => /\.png$/i.test(n));
  const pick = (re) => pngs.find((f) => re.test(path.basename(f))) ?? null;
  const normal = pick(/_normal\.png$/i);
  const rough = pick(/_rough(ness)?\.png$/i);
  const metal = pick(/_metal(lic|ness)?\.png$/i);
  const suffixed = new Set([normal, rough, metal].filter(Boolean));
  return { color: pngs.find((f) => !suffixed.has(f)) ?? null, normal, rough, metal };
}

function encode(src, dst) {
  sh('ffmpeg', ['-y', '-i', src, '-vf', `scale=${TEX_SIZE}:${TEX_SIZE}`, '-q:v', '82', dst]);
  return fs.readFileSync(dst);
}

/**
 * glTF wants roughness in green and metalness in blue of one texture. ffmpeg
 * has no channel-pack filter, so each source is mixed into the channel it
 * belongs in and the two are added together.
 */
function packMetalRough(rough, metal, dst) {
  const inputs = [], filters = [];
  const mix = (g, b) => `colorchannelmixer=rr=0:rg=0:rb=0:gr=${g}:gg=0:gb=0:br=${b}:bg=0:bb=0`;
  if (rough) {
    inputs.push('-i', rough);
    filters.push(`[${inputs.length / 2 - 1}:v]scale=${TEX_SIZE}:${TEX_SIZE},${mix(1, 0)}[r]`);
  }
  if (metal) {
    inputs.push('-i', metal);
    filters.push(`[${inputs.length / 2 - 1}:v]scale=${TEX_SIZE}:${TEX_SIZE},${mix(0, 1)}[m]`);
  }
  if (filters.length === 0) return null;
  const both = filters.length === 2;
  const graph = both ? `${filters.join(';')};[r][m]blend=all_mode=addition[out]` : filters[0];
  const label = both ? '[out]' : (rough ? '[r]' : '[m]');
  sh('ffmpeg', ['-y', ...inputs, '-filter_complex', graph, '-map', label, '-q:v', '80', dst]);
  return fs.readFileSync(dst);
}

/** Decode an image to a raw RGB grid, for sampling by UV. */
function rawRgb(src, size = 1024) {
  const bytes = execFileSync('ffmpeg', ['-v', 'error', '-i', src, '-vf', `scale=${size}:${size}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 });
  return {
    size,
    at(u, v) {
      const x = Math.min(size - 1, Math.max(0, Math.floor((u - Math.floor(u)) * size)));
      const y = Math.min(size - 1, Math.max(0, Math.floor((v - Math.floor(v)) * size)));
      const i = (y * size + x) * 3;
      return [bytes[i], bytes[i + 1], bytes[i + 2]];
    },
  };
}

async function convert(kind, dir) {
  const src = findFiles(dir, (n) => /\.(fbx|glb)$/i.test(n))[0];
  if (!src) { console.log(`${kind}: no model file in ${path.relative(ROOT, dir)}`); return null; }
  console.log(`${kind}: ${path.relative(RAW, src)}`);

  fs.mkdirSync(TMP, { recursive: true });
  let glb = path.join(TMP, `${kind}.glb`);
  if (/\.fbx$/i.test(src)) {
    sh(FBX2GLTF, ['-i', src, '-o', path.join(TMP, kind), '-b', '--compute-normals', 'missing']);
  } else {
    fs.copyFileSync(src, glb);
  }

  const read = readGlb(glb);
  const mesh = flatten(read.json, read.bin);
  const before = mesh.idx.length / 3;
  const fit = orientAndFit(mesh, TARGET_LENGTH);
  const maps = findMaps(dir);
  const fragmentation = uvFragmentation(mesh);
  const baked = fragmentation > FRAGMENTED_ATLAS && maps.color !== null;

  let images, result;
  if (baked) {
    bakeVertexColors(mesh, rawRgb(maps.color));
    weldByPosition(mesh);
    result = await simplify(mesh, MAX_TRIS_BAKED);
    images = { metalness: 0.6, roughness: 0.35 };
  } else {
    result = await simplify(mesh, MAX_TRIS);
    images = {
      color: maps.color ? encode(maps.color, path.join(TMP, `${kind}-c.webp`)) : null,
      normal: maps.normal ? encode(maps.normal, path.join(TMP, `${kind}-n.webp`)) : null,
      mr: packMetalRough(maps.rough, maps.metal, path.join(TMP, `${kind}-mr.webp`)),
      metalness: 0.6, roughness: 0.35,
    };
  }

  const packed = packGlb(mesh, images, `${kind}-body`);
  fs.mkdirSync(OUT, { recursive: true });
  const size = writeGlb(path.join(OUT, `${kind}.glb`), packed.json, packed.bin);

  const found = baked ? 'baked to vertex colour' : (Object.entries(maps).filter(([, v]) => v).map(([k]) => k).join('+') || 'none');
  console.log(`  ${(size / 1048576).toFixed(2)} MB, ${before} -> ${result.tris} tris`
    + ` (atlas ${(fragmentation * 100).toFixed(0)}% fragmented), maps ${found}`);
  console.log(`  fitted ${fit.length} long x ${fit.width} wide x ${fit.height} tall`
    + `${fit.rotated ? ', turned onto the game axes' : ''}`);
  return {
    kind, file: `${kind}.glb`, bytes: size, tris: result.tris, sourceTris: before, maps: found,
    atlasFragmentation: +fragmentation.toFixed(3), fit,
  };
}

async function main() {
  if (!fs.existsSync(RAW)) { console.log('no raw/; nothing to convert'); return; }
  const dirs = fs.readdirSync(RAW, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.endsWith('.fbm'))
    .map((e) => ({ kind: kindFor(e.name), dir: path.join(RAW, e.name) }))
    .filter((e) => e.kind !== null);

  if (dirs.length === 0) { console.log('no car directories in raw/'); return; }
  const built = [];
  for (const e of dirs) { const b = await convert(e.kind, e.dir); if (b) built.push(b); }
  const total = built.reduce((s, b) => s + b.bytes, 0);
  fs.writeFileSync(
    path.join(OUT, 'manifest.json'),
    `${JSON.stringify({ cars: built, generated: new Date().toISOString().slice(0, 10) }, null, 2)}\n`,
  );
  console.log(`\ntotal ${(total / 1048576).toFixed(2)} MB in public/assets/models/supplied/`);
}

await main();
