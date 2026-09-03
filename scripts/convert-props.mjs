#!/usr/bin/env node
// Build step: the props Joe dropped in public/assets/raw/ -> public/assets/models/supplied/
//
//   tropical-palm-tree/          -> palm.glb, palm-far.glb
//   psx-style-street-light-kit/  -> streetlight.glb, streetlight-double.glb
//   traffic-light/               -> traffic-light.glb
//
// Same shape as convert-cars.mjs -- fbx2gltf, flatten, fit, weld, pack, WebP
// maps -- with two differences that matter. These are fitted on HEIGHT and
// stood on their own base (a palm is tallest, not longest, and a lamp's foot is
// nowhere near its bounding-box centre), and the material split is kept, so
// the game can tint fronds, light a lamp head, and switch one traffic-light
// lens at a time.
//
// Orientation contract, shared with src/world/props.ts: every prop stands on
// y = 0 at its base and reaches along local +Z -- a lamp's arm hangs out over
// the road along +Z, a traffic light's lenses FACE +Z. The script prints the
// measured reach so a wrong turn is visible here before it is visible in-game.
//
// Run: node scripts/convert-props.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readGlb, writeGlb } from './glb.mjs';
import { flattenByMaterial, fitUpright, decimate, simplify, weldByPosition, packGlbMulti } from './mesh.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'public/assets/raw');
const OUT = path.join(ROOT, 'public/assets/models/supplied');
const TMP = path.join(os.tmpdir(), 'sunbelt-props-supplied');
const FBX2GLTF = path.join(
  ROOT, 'node_modules/fbx2gltf/bin', os.type(), os.type() === 'Windows_NT' ? 'FBX2glTF.exe' : 'FBX2glTF',
);

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...opts });

function findFiles(dir, test) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findFiles(full, test));
    else if (test(entry.name)) out.push(full);
  }
  return out;
}

const findOne = (dir, re) => findFiles(dir, (n) => re.test(n))[0] ?? null;

/**
 * Minimal zip extraction (stored and deflate entries), so the street-light
 * kit's zip unpacks the same on every platform without shelling out to
 * whichever of `unzip` / `Expand-Archive` the machine happens to have.
 */
function unzip(file, into) {
  const buf = fs.readFileSync(file);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error(`${file}: not a zip`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`${file}: bad central directory`);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(local + 26), lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    const dest = path.join(into, path.basename(name));
    if (!name.endsWith('/')) { fs.writeFileSync(dest, data); names.push(dest); }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function fbxToGlb(src, name) {
  fs.mkdirSync(TMP, { recursive: true });
  const base = path.join(TMP, name);
  sh(FBX2GLTF, ['-i', src, '-o', base, '-b', '--compute-normals', 'missing']);
  return `${base}.glb`;
}

/** Re-encode a map to WebP at `size` square. Alpha survives for PNG sources. */
function encode(src, name, size) {
  const dst = path.join(TMP, `${name}.webp`);
  sh('ffmpeg', ['-y', '-i', src, '-vf', `scale=${size}:${size}`, '-q:v', '82', dst]);
  return fs.readFileSync(dst);
}

/** glTF wants roughness in G and metalness in B of one map. */
function packMetalRough(rough, metal, name, size) {
  const inputs = [], filters = [];
  const mix = (g, b) => `colorchannelmixer=rr=0:rg=0:rb=0:gr=${g}:gg=0:gb=0:br=${b}:bg=0:bb=0`;
  if (rough) { inputs.push('-i', rough); filters.push(`[${inputs.length / 2 - 1}:v]scale=${size}:${size},format=rgb24,${mix(1, 0)}[r]`); }
  if (metal) { inputs.push('-i', metal); filters.push(`[${inputs.length / 2 - 1}:v]scale=${size}:${size},format=rgb24,${mix(0, 1)}[m]`); }
  if (filters.length === 0) return null;
  const both = filters.length === 2;
  const graph = both ? `${filters.join(';')};[r][m]blend=all_mode=addition[out]` : filters[0];
  const label = both ? '[out]' : (rough ? '[r]' : '[m]');
  const dst = path.join(TMP, `${name}-mr.webp`);
  sh('ffmpeg', ['-y', ...inputs, '-filter_complex', graph, '-map', label, '-q:v', '80', dst]);
  return fs.readFileSync(dst);
}

/** Decode an image to a small raw RGB grid, for sampling by UV. */
function rawRgb(src, size = 256) {
  const bytes = sh('ffmpeg', ['-v', 'error', '-i', src, '-vf', `scale=${size}:${size}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return {
    size,
    at(u, v) {
      // glTF UV origin is top-left, matching the image rows as decoded.
      const x = Math.min(size - 1, Math.max(0, Math.floor((u - Math.floor(u)) * size)));
      const y = Math.min(size - 1, Math.max(0, Math.floor((v - Math.floor(v)) * size)));
      const i = (y * size + x) * 3;
      return [bytes[i], bytes[i + 1], bytes[i + 2]];
    },
  };
}

const tris = (parts) => parts.reduce((s, p) => s + p.mesh.idx.length / 3, 0);

function write(name, parts) {
  const packed = packGlbMulti(parts, name);
  fs.mkdirSync(OUT, { recursive: true });
  const size = writeGlb(path.join(OUT, `${name}.glb`), packed.json, packed.bin);
  console.log(`  -> ${name}.glb ${(size / 1024).toFixed(0)} KB, ${tris(parts)} tris, ${parts.length} materials`);
  return { file: `${name}.glb`, bytes: size, tris: tris(parts) };
}

/** Drop the vertices a part's triangles never reference. */
function compact(mesh) {
  const remap = new Map();
  const pos = [], nrm = [], uv = [], idx = [];
  for (const i of mesh.idx) {
    let j = remap.get(i);
    if (j === undefined) {
      j = pos.length / 3;
      remap.set(i, j);
      pos.push(mesh.pos[i * 3], mesh.pos[i * 3 + 1], mesh.pos[i * 3 + 2]);
      nrm.push(mesh.nrm[i * 3], mesh.nrm[i * 3 + 1], mesh.nrm[i * 3 + 2]);
      uv.push(mesh.uv[i * 2], mesh.uv[i * 2 + 1]);
    }
    idx.push(j);
  }
  return { pos, nrm, uv, idx };
}

function cloneParts(parts) {
  return parts.map((p) => ({ ...p, mesh: { pos: [...p.mesh.pos], nrm: [...p.mesh.nrm], uv: [...p.mesh.uv], idx: [...p.mesh.idx] } }));
}

// --- palm ------------------------------------------------------------------------
/** Metres tall. vegetation.ts rescales per species, so this is only the reference. */
const PALM_HEIGHT = 7.4;
/**
 * Triangle budgets. Nine hundred palms stand in the city and the near set is
 * fifty to a hundred of them at once, so the near model is a real cost too:
 * the export's 3.5k is edge-collapsed to 1.4k, which keeps every frond, and
 * the far twin is a green stroke at 160.
 */
const PALM_NEAR_TRIS = 1400;
const PALM_FAR_TRIS = 160;

async function convertPalm(dir) {
  const fbx = findOne(dir, /\.fbx$/i);
  if (!fbx) return null;
  console.log(`palm: ${path.relative(RAW, fbx)}`);
  const { json, bin } = readGlb(fbxToGlb(fbx, 'palm'));
  const parts = flattenByMaterial(json, bin);
  const fit = fitUpright(parts, PALM_HEIGHT, { x: 0, z: 1 });
  const total = tris(parts);
  for (const p of parts) await simplify(p.mesh, Math.max(60, Math.round(PALM_NEAR_TRIS * (p.mesh.idx.length / 3) / total)));
  console.log(`  ${fit.height} m tall, crown ${fit.width} x ${fit.depth}, leans (${fit.reach.x}, ${fit.reach.z}) at the top`);

  const tex = path.join(dir, 'textures');
  const trunkColor = findOne(tex, /^palm_\d+_diffuse\./i);
  const trunkRough = findOne(tex, /rou(gh)?ness/i);
  const leafColor = findOne(tex, /leaf_diffuse/i);
  const leafNormal = findOne(tex, /leaf_normal/i);
  for (const p of parts) {
    if (/leaf|leaves/i.test(p.name)) {
      p.material = {
        images: { color: leafColor && encode(leafColor, 'palm-leaf-c', 1024), normal: leafNormal && encode(leafNormal, 'palm-leaf-n', 1024) },
        roughness: 0.8, doubleSide: true,
      };
    } else {
      p.material = {
        images: { color: trunkColor && encode(trunkColor, 'palm-trunk-c', 1024), mr: packMetalRough(trunkRough, null, 'palm-trunk', 512) },
        roughness: 0.95,
      };
    }
  }
  const near = write('palm', parts);
  // Far level of detail: same materials, welded down. The fronds are what cost;
  // at sixty metres a frond is a green stroke and its 3k triangles are wasted.
  const far = cloneParts(parts);
  for (const p of far) {
    const share = p.mesh.idx.length / 3 / tris(parts);
    await simplify(p.mesh, Math.max(40, Math.round(PALM_FAR_TRIS * share)));
    // Quarter-size maps: beyond sixty metres a texel is smaller than a pixel.
    p.material = /leaf|leaves/i.test(p.name)
      ? { ...p.material, images: { color: leafColor && encode(leafColor, 'palm-far-leaf-c', 512), normal: leafNormal && encode(leafNormal, 'palm-far-leaf-n', 512) } }
      : { ...p.material, images: { color: trunkColor && encode(trunkColor, 'palm-far-trunk-c', 512), mr: packMetalRough(trunkRough, null, 'palm-far-trunk', 256) } };
  }
  write('palm-far', far);
  return { near, fit };
}

// --- street lights ------------------------------------------------------------------
const LAMP_HEIGHT = 7;

function convertStreetLights(dir) {
  const zip = findOne(dir, /\.zip$/i);
  let fbx = findOne(dir, /\.fbx$/i);
  const unpacked = path.join(TMP, 'streetlight-kit');
  fs.mkdirSync(unpacked, { recursive: true });
  let kitFiles = [];
  if (zip) kitFiles = unzip(zip, unpacked);
  if (!fbx) fbx = kitFiles.find((f) => /\.fbx$/i.test(f)) ?? null;
  if (!fbx) return null;
  console.log(`streetlight: ${path.relative(RAW, zip ?? fbx)}`);
  const { json, bin } = readGlb(fbxToGlb(fbx, 'streetlight'));

  // The kit's maps by material name. The zip carries several finishes; the
  // ones Joe picked out into textures/ win, the zip's own are the fallback.
  const tex = path.join(dir, 'textures');
  const find = (re) => findOne(tex, re) ?? kitFiles.find((f) => re.test(path.basename(f))) ?? null;
  const maps = {
    Concrete: find(/^Concrete2D\./i) ?? find(/^Concrete/i),
    Metal: find(/^SmallMetal/i) ?? find(/^MetalClean\./i),
    LightOn: find(/^StreetLightOn\./i),
  };
  const images = {};
  for (const [k, f] of Object.entries(maps)) images[k] = f ? encode(f, `sl-${k}`, 256) : null;

  const material = (name) => {
    if (/concrete/i.test(name)) return { images: { color: images.Concrete }, roughness: 0.9 };
    if (/lighton|lit|lamp/i.test(name)) return { images: { color: images.LightOn }, roughness: 0.5, emissive: [1, 0.85, 0.63] };
    return { images: { color: images.Metal }, roughness: 0.45, metalness: 0.6 };
  };

  const out = {};
  for (const [node, name] of [['StreetLightSingle', 'streetlight'], ['StreetLightDouble', 'streetlight-double']]) {
    // The kit's own light cone is left out: it is authored for one finish of one
    // arm and stops four metres off the ground. props.ts draws its own from the
    // measured reach, which lines up with any of these by construction.
    const parts = flattenByMaterial(json, bin, (n) => n === node).filter((p) => !/cone/i.test(p.name));
    if (tris(parts) === 0) { console.log(`  ${node}: not found in kit`); continue; }
    const fit = fitUpright(parts, LAMP_HEIGHT, 'head');
    console.log(`  ${node}: ${fit.height} m tall, head reaches (${fit.reach.x}, ${fit.reach.z}) from the base`
      + (Math.abs(fit.reach.z) > Math.abs(fit.reach.x) && fit.reach.z > 0.5 ? ' -- arm along +Z, correct' : ' -- arms balanced, or no arm'));
    for (const p of parts) p.material = material(p.name);
    out[name] = { ...write(name, parts), fit };
  }
  return out;
}

// --- traffic light -------------------------------------------------------------------
const SIGNAL_HEIGHT = 3.6;
const SIGNAL_MAX_TRIS = 320;
/** A lens is a disc; thirty triangles is a round one at any distance it is seen from. */
const LENS_MAX_TRIS = 30;

/**
 * Which lens a texel belongs to, or null for the housing.
 *
 * By hue and saturation rather than absolute brightness: the lenses on this
 * map are painted unlit (a red of 99/39/31), so a threshold on "bright red"
 * finds nothing. The housing is grey and brown, both far less saturated.
 */
function lensOf([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max < 30 || (max - min) / max < 0.45) return null;
  if (r === max && g < r * 0.55) return 'red';
  if (r === max && g >= r * 0.55) return 'amber';
  if (g === max && r < g * 0.75) return 'green';
  return null;
}

async function convertTrafficLight(dir) {
  const fbx = findOne(dir, /\.fbx$/i);
  if (!fbx) return null;
  console.log(`traffic-light: ${path.relative(RAW, fbx)}`);
  const { json, bin } = readGlb(fbxToGlb(fbx, 'traffic-light'));
  const tex = path.join(dir, 'textures');
  const color = findOne(tex, /_D\./i), normal = findOne(tex, /_N\./i);
  const rough = findOne(tex, /_R\./i), metal = findOne(tex, /_M\./i);
  if (!color) { console.log('  no diffuse map; skipped'); return null; }

  const [whole] = flattenByMaterial(json, bin);
  // Split the one material into housing + three lenses by what each triangle
  // samples from the albedo. The lenses are the only saturated texels on it.
  const img = rawRgb(color);
  const buckets = { body: [], red: [], amber: [], green: [] };
  const m = whole.mesh;
  for (let i = 0; i < m.idx.length; i += 3) {
    const a = m.idx[i], b = m.idx[i + 1], c = m.idx[i + 2];
    const u = (m.uv[a * 2] + m.uv[b * 2] + m.uv[c * 2]) / 3;
    const v = (m.uv[a * 2 + 1] + m.uv[b * 2 + 1] + m.uv[c * 2 + 1]) / 3;
    (buckets[lensOf(img.at(u, v)) ?? 'body']).push(a, b, c);
  }
  const parts = Object.entries(buckets).map(([name, idx]) => ({
    name: name === 'body' ? 'housing' : `lens-${name}`,
    mesh: compact({ pos: m.pos, nrm: m.nrm, uv: m.uv, idx }),
  }));
  console.log(`  lenses: red ${buckets.red.length / 3}, amber ${buckets.amber.length / 3}, green ${buckets.green.length / 3} tris`);

  // Which way the lenses look: the mean normal of the lens triangles.
  let fx = 0, fz = 0;
  for (const name of ['red', 'amber', 'green']) {
    for (const vi of buckets[name]) { fx += m.nrm[vi * 3]; fz += m.nrm[vi * 3 + 2]; }
  }
  const fl = Math.hypot(fx, fz);
  const forward = fl > 1e-6 ? { x: fx / fl, z: fz / fl } : { x: 0, z: 1 };
  const fit = fitUpright(parts, SIGNAL_HEIGHT, forward);
  console.log(`  ${fit.height} m tall; lenses face (${forward.x.toFixed(2)}, ${forward.z.toFixed(2)}) in the file, turned to +Z`);
  const before = tris(parts);
  // Instanced six hundred times, so every triangle here is six hundred. The
  // lenses are welded to a coarse disc each; the housing is edge-collapsed,
  // not grid-welded -- a grid weld at this budget took the pole with it.
  for (const p of parts) if (p.name !== 'housing') decimate(p.mesh, LENS_MAX_TRIS);
  if (before > SIGNAL_MAX_TRIS) {
    // The export's vertices are unshared, so the collapse must be given a
    // closed surface first: welded on position, first UV kept per vertex.
    weldByPosition(parts[0].mesh, 1e-3, true);
    await simplify(parts[0].mesh, Math.max(160, SIGNAL_MAX_TRIS - LENS_MAX_TRIS * 3));
  }

  const images = {
    // 512: the head is 0.4 m across and never nearer than a kerb's width.
    color: encode(color, 'tl-c', 512),
    normal: normal ? encode(normal, 'tl-n', 512) : null,
    mr: packMetalRough(rough, metal, 'tl', 512),
  };
  for (const p of parts) {
    p.material = p.name === 'housing'
      ? { images, roughness: 0.6 }
      // Lenses carry the albedo as their emissive map too, so lighting one is
      // a matter of emissiveIntensity at runtime and it glows its own colour.
      : { images: { color: images.color, emissive: images.color }, roughness: 0.3, emissive: [0, 0, 0] };
  }
  return { ...write('traffic-light', parts), fit, forward };
}

async function main() {
  if (!fs.existsSync(RAW)) { console.log('no raw/; nothing to convert'); return; }
  const dirs = fs.readdirSync(RAW, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const pick = (re) => { const d = dirs.find((n) => re.test(n)); return d ? path.join(RAW, d) : null; };
  const palmDir = pick(/palm/i), lampDir = pick(/street.?light/i), signalDir = pick(/traffic.?light/i);

  const built = {};
  if (palmDir) built.palm = await convertPalm(palmDir); else console.log('palm: no raw/*palm*/ directory');
  if (lampDir) Object.assign(built, convertStreetLights(lampDir)); else console.log('streetlight: no raw/*street*light*/ directory');
  if (signalDir) built['traffic-light'] = await convertTrafficLight(signalDir); else console.log('traffic-light: no raw/*traffic*light*/ directory');

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    path.join(OUT, 'props.json'),
    `${JSON.stringify({ props: built, generated: new Date().toISOString().slice(0, 10) }, null, 2)}\n`,
  );
}

await main();
