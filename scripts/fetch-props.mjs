#!/usr/bin/env node
// Poly Haven street props -> public/assets/models/street/<name>.glb
//
// Poly Haven ships models as a loose .gltf with a separate .bin and JPEG
// textures, which is three round trips and 2-7 MB per prop before anything is
// placed. This fetches the set through the public API, flattens it, welds it to
// a triangle count the city can instance a few hundred times, re-encodes the
// maps to WebP, and packs the lot into one GLB.
//
// Run: node scripts/fetch-props.mjs [--force]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeGlb } from './glb.mjs';
import { flatten, decimate, packGlb, extents } from './mesh.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public/assets/models/street');
const TMP = path.join(os.tmpdir(), 'sunbelt-props');
const FORCE = process.argv.includes('--force');

/**
 * What to fetch, and how tall it should stand once it is in the world.
 *
 * Real heights, because these are photoscans of real objects and the world is
 * in metres: a 4 m lamp column, a 0.9 m bin, a bench you can sit on. Anything
 * scaled to "looks about right" reads wrong the moment a 1.8 m character walks
 * past it.
 */
const PROPS = [
  // DECISION: no streetlight from Poly Haven. `street_lamp_01` is a 4.2 m alley
  // lamp -- a plain column with the head straight on top. The procedural
  // streetlight this would replace is a road lamp with a cantilever arm that
  // reaches out over the carriageway, which is the correct object for a
  // boulevard. Swapping a right-shaped lamp for a wrong-shaped photoscan is a
  // downgrade whatever it is made of.
  // Poly Haven's bin scene is the clean can and a rusted one side by side, each
  // split into body, lid and two handles. Only the clean one is wanted.
  { id: 'metal_trash_can', name: 'bin', height: 0.92, tris: 600, keep: /^metal_trash_can(_lid|_handle_(left|right))?$/ },
  // DECISION: no bench from Poly Haven. `modular_street_seating` is a flat pack
  // of parts -- legs, connectors, armrests, crossbars -- laid out for you to
  // assemble, and its one pre-made piece, `seat_bench`, is a 62 m extruded run
  // meant to be cut to length. Assembling street furniture from a kit is a
  // modelling job, not a fetch, so the procedural bench stays.
  { id: 'fire_hydrant', name: 'hydrant', height: 0.78, tris: 500 },
];

/** Texture role, keyed by the suffix Poly Haven uses. */
const ROLE = [
  [/_diff_/, 'color'],
  [/_nor_gl_/, 'normal'],
  [/_arm_/, 'arm'],
];

const TEX_SIZE = 512;

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function encode(src, dst, extra = []) {
  sh('ffmpeg', ['-y', '-i', src, '-vf', `scale=${TEX_SIZE}:${TEX_SIZE}`, ...extra, '-q:v', '80', dst]);
  return fs.readFileSync(dst);
}

/**
 * Poly Haven packs ambient occlusion, roughness and metalness into one "arm"
 * texture -- which is glTF's own channel order, so it goes straight through.
 */
function armMap(src, dst) {
  return encode(src, dst);
}

/** Stand the prop on y = 0, centred in XZ, at its real height. */
function fit(mesh, height) {
  const e = extents(mesh.pos);
  const scale = height / Math.max(e.size[1], 1e-9);
  const cx = (e.min[0] + e.max[0]) / 2, cz = (e.min[2] + e.max[2]) / 2;
  const p = mesh.pos;
  for (let i = 0; i < p.length; i += 3) {
    p[i] = (p[i] - cx) * scale;
    p[i + 1] = (p[i + 1] - e.min[1]) * scale;
    p[i + 2] = (p[i + 2] - cz) * scale;
  }
  const after = extents(p);
  return { width: +after.size[0].toFixed(2), height: +after.size[1].toFixed(2) };
}

async function build(prop) {
  const dest = path.join(OUT, `${prop.name}.glb`);
  if (!FORCE && fs.existsSync(dest)) { console.log(`${prop.name} (cached)`); return null; }

  const meta = await (await fetch(`https://api.polyhaven.com/files/${prop.id}`)).json();
  const entry = meta?.gltf?.['1k']?.gltf;
  if (!entry) { console.log(`${prop.name}: no 1k gltf`); return null; }

  const dir = path.join(TMP, prop.id);
  fs.mkdirSync(dir, { recursive: true });
  const gltf = JSON.parse((await get(entry.url)).toString('utf8'));

  let bin = Buffer.alloc(0);
  const images = {};
  for (const [rel, file] of Object.entries(entry.include ?? {})) {
    const local = path.join(dir, path.basename(rel));
    fs.writeFileSync(local, await get(file.url));
    if (rel.endsWith('.bin')) { bin = fs.readFileSync(local); continue; }
    const role = ROLE.find(([re]) => re.test(path.basename(rel)))?.[1];
    if (role === 'color') images.color = encode(local, path.join(dir, 'c.webp'));
    else if (role === 'normal') images.normal = encode(local, path.join(dir, 'n.webp'));
    else if (role === 'arm') images.mr = armMap(local, path.join(dir, 'mr.webp'));
  }

  const mesh = flatten(gltf, bin, prop.keep ? (name) => prop.keep.test(name) : null);
  if (mesh.idx.length === 0) { console.log(`${prop.name}: node filter matched nothing`); return null; }
  const before = mesh.idx.length / 3;
  const size = fit(mesh, prop.height);
  const welded = decimate(mesh, prop.tris);

  const packed = packGlb(mesh, images, prop.name);
  fs.mkdirSync(OUT, { recursive: true });
  const bytes = writeGlb(dest, packed.json, packed.bin);
  console.log(`${prop.name}: ${(bytes / 1024).toFixed(0)} KB, ${before} -> ${welded.tris} tris, `
    + `${size.height} m tall x ${size.width} m wide`);
  return { name: prop.name, id: prop.id, bytes, tris: welded.tris, height: size.height };
}

async function main() {
  const built = [];
  for (const prop of PROPS) {
    try {
      const r = await build(prop);
      if (r) built.push(r);
    } catch (err) {
      // A prop that will not fetch is a prop the game keeps procedural. Never a
      // build failure.
      console.log(`${prop.name}: ${String(err)}`);
    }
  }
  if (built.length === 0) return;
  fs.writeFileSync(
    path.join(OUT, 'manifest.json'),
    `${JSON.stringify({ props: built, source: 'polyhaven', generated: new Date().toISOString().slice(0, 10) }, null, 2)}\n`,
  );
  const total = built.reduce((s, b) => s + b.bytes, 0);
  console.log(`\ntotal ${(total / 1048576).toFixed(2)} MB in public/assets/models/street/`);
}

await main();
