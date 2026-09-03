#!/usr/bin/env node
// Build step: public/assets/raw/*.fbx  ->  public/assets/character/*.glb
//
// Joe drops Mixamo FBX exports into raw/ (gitignored: ~55 MB each, 314 MB the
// set). This turns them into one skinned hero and one clip per animation, and
// writes a manifest of what each clip actually contains so the runtime does not
// have to guess at stride lengths.
//
// Run: node scripts/convert-character.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readGlb, writeGlb } from './glb.mjs';
import { stripToAnimation, channelReport, rebuildBuffer } from './glb-edit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'public/assets/raw');
const OUT = path.join(ROOT, 'public/assets/character');
const TMP = path.join(os.tmpdir(), 'sunbelt-character');
const FBX2GLTF = path.join(
  ROOT, 'node_modules/fbx2gltf/bin', os.type(), os.type() === 'Windows_NT' ? 'FBX2glTF.exe' : 'FBX2glTF',
);

/**
 * Mixamo names its downloads after the animation, so the clip name is the file
 * name. First pattern wins, so the specific ones come before the general: a
 * file called "Jog Backward" is a backward jog, not a jog.
 *
 * `role` is what the runtime does with the clip, and it matters more than the
 * name. `ladder` clips are rungs of the speed-driven locomotion blend; `goofy`
 * and `back` are alternates that replace a rung on demand; `once` clips are
 * one-shots the game triggers. `many` marks a role the game picks at random
 * from, so five punches keep their own names and arrive as one array.
 */
const CLIP_NAMES = [
  // Pistol clips first: "Pistol Walk Backward" is a pistol clip, and the
  // backward rule further down would otherwise claim it as an ordinary jog.
  [/pistol ?idle/i, 'pistolIdle', 'once'],
  [/pistol.*strafe/i, 'pistolStrafe', 'dir', 90, true],
  [/pistol.*back/i, 'pistolBack', 'dir', 180, true],
  [/pistol.*(walk|forward|run)/i, 'pistolWalk', 'dir', 0, true],
  [/pistol ?aim|aiming/i, 'pistolAim', 'once'],
  [/shoot|pistol|fire/i, 'pistolFire', 'once'],

  [/goofy/i, 'jogGoofy', 'goofy'],
  // Diagonals before the plain directions, for the same reason.
  [/back ?ward.*diagonal|diagonal.*back/i, 'jogBackDiag', 'dir', 135],
  [/forward.*diagonal|diagonal.*forward/i, 'jogFwdDiag', 'dir', 45],
  [/back ?ward|jog ?back/i, 'jogBack', 'dir', 180],
  [/strafe|side ?step/i, 'jogStrafe', 'dir', 90],

  [/strut|walk/i, 'walk', 'ladder'],
  [/jog/i, 'jog', 'ladder'],
  [/slow ?run/i, 'slowRun', 'ladder'],
  [/fast ?run|sprint|^run/i, 'run', 'ladder'],
  [/gangnam|dance/i, 'dance', 'once'],
  [/jump|leap/i, 'jump', 'once'],
  [/punch|hook|elbow|jab|combo/i, 'punch', 'many'],
  [/fall|knock|stagger/i, 'fall', 'many'],
  [/idle|breath/i, 'idle', 'ladder'],
];
const HERO = /character|hero|main|t-?pose/i;
/**
 * Directories under raw/ that hold vehicles rather than animation. They are
 * scripts/convert-cars.mjs's business, and a car FBX has no animation channels
 * anyway -- but skipping them saves a 20 MB conversion to find that out.
 */
const CAR_DIRS = /^(sedan|sports?car|pickup|truck|police|van|suv|saloon|cop)/i;

// DECISION: the diffuse maps stay at 2K and the normals drop to 1K. The
// character is the one asset the camera gets within two metres of, and its skin
// and shirt print are the only place a 2K albedo earns its bytes; a 1K normal
// on a 54k-triangle mesh is already finer than the geometry it perturbs.
const ENCODE = {
  color: ['-vf', 'scale=2048:-1', '-q:v', '84'],
  normal: ['-vf', 'scale=1024:-1', '-q:v', '90'],
  other: ['-vf', 'scale=1024:-1', '-q:v', '78'],
};

function sh(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function slug(file) {
  return path.basename(file, path.extname(file)).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/**
 * The clip's role, name and -- for a directional clip -- which way it moves
 * relative to the character's facing.
 *
 * Both the file name and its folder are matched, so dropping five files into
 * `punches/` is enough to make them all punches whatever they are individually
 * called. The full path is matched too, which is how a clip in
 * `gun/movement/while aimed/` is known to be a pistol clip.
 */
function roleFor(file) {
  const base = path.basename(file, path.extname(file));
  const rel = path.relative(RAW, file).split(path.sep).join('/');
  for (const [re, name, role, angle, armed] of CLIP_NAMES) {
    if (re.test(base) || re.test(rel)) {
      return { name, role, angle: angle ?? 0, armed: armed === true };
    }
  }
  return { name: slug(file), role: 'once', angle: 0, armed: false };
}

/** Recursive .fbx hunt, skipping the car directories and FBX texture dumps. */
function findFbx(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.fbm') || CAR_DIRS.test(entry.name)) continue;
      out.push(...findFbx(full));
    } else if (/\.fbx$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function convert(fbx, outBase) {
  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  sh(FBX2GLTF, [
    '-i', fbx, '-o', outBase, '-b',
    '--pbr-metallic-roughness', '--anim-framerate', 'bake30',
    '--compute-normals', 'missing',
  ]);
  return outBase + '.glb';
}

/** Which of the three encode profiles a texture belongs to, by how it is used. */
function textureRoles(json) {
  const roles = new Map(); // bufferView -> 'color' | 'normal' | 'other'
  const viewOf = (texIndex) => {
    if (texIndex === undefined) return undefined;
    const tex = json.textures ? json.textures[texIndex] : undefined;
    const img = tex && json.images ? json.images[tex.source] : undefined;
    return img ? img.bufferView : undefined;
  };
  const set = (view, role) => {
    if (view === undefined) return;
    // Colour wins: an sRGB albedo re-encoded on the linear profile looks washed
    // out, and a normal map that is also somebody's albedo does not exist.
    if (role === 'color' || !roles.has(view)) roles.set(view, role);
  };
  for (const m of json.materials || []) {
    const pbr = m.pbrMetallicRoughness || {};
    set(viewOf(pbr.baseColorTexture && pbr.baseColorTexture.index), 'color');
    set(viewOf(m.normalTexture && m.normalTexture.index), 'normal');
    set(viewOf(pbr.metallicRoughnessTexture && pbr.metallicRoughnessTexture.index), 'other');
    set(viewOf(m.occlusionTexture && m.occlusionTexture.index), 'other');
    set(viewOf(m.emissiveTexture && m.emissiveTexture.index), 'color');
  }
  return roles;
}

/** Re-encode every embedded image to WebP at the size its role deserves. */
function shrinkTextures(json, bin) {
  fs.mkdirSync(TMP, { recursive: true });
  const roles = textureRoles(json);
  const replace = new Map();
  let before = 0, after = 0;
  for (const [view, role] of roles) {
    const bv = json.bufferViews[view];
    const src = path.join(TMP, 'img' + view + '.bin');
    const dst = path.join(TMP, 'img' + view + '.webp');
    fs.writeFileSync(src, bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength));
    try {
      sh('ffmpeg', ['-y', '-i', src].concat(ENCODE[role], [dst]));
    } catch {
      console.log('  ! ffmpeg failed on bufferView ' + view + ', keeping the original');
      continue;
    }
    const out = fs.readFileSync(dst);
    before += bv.byteLength;
    after += out.length;
    replace.set(view, out);
  }
  // Every image sharing a re-encoded view is now WebP whatever it claimed.
  for (const img of json.images || []) {
    if (replace.has(img.bufferView)) img.mimeType = 'image/webp';
  }
  console.log('  textures ' + (before / 1048576).toFixed(1) + ' MB -> ' + (after / 1048576).toFixed(1) + ' MB');
  return replace;
}

/**
 * DECISION: the eyelash primitive is dropped. FBX2glTF reports "can't handle
 * texture for TransparentColor" on that material and falls back to a
 * baseColorFactor with alpha 0, so it renders as nothing at best and as a black
 * bar across the eyes if anything later forces it opaque. 704 triangles.
 */
function cleanMaterials(json) {
  const drop = new Set();
  (json.materials || []).forEach((m, i) => {
    if (/eyelash/i.test(m.name || '')) { drop.add(i); return; }
    // Everything else was authored opaque; FBX's Phong TransparentColor slot
    // makes FBX2glTF mark it BLEND, which only buys depth-sorting bugs.
    const pbr = m.pbrMetallicRoughness || {};
    const alpha = pbr.baseColorFactor ? pbr.baseColorFactor[3] : 1;
    if (m.alphaMode === 'BLEND' && alpha >= 1) m.alphaMode = 'OPAQUE';
  });
  let dropped = 0;
  for (const mesh of json.meshes || []) {
    const before = mesh.primitives.length;
    mesh.primitives = mesh.primitives.filter((p) => !drop.has(p.material));
    dropped += before - mesh.primitives.length;
  }
  if (dropped) console.log('  dropped ' + dropped + ' primitive(s) with an unusable material');
}

function buildHero(fbx) {
  console.log('hero: ' + path.basename(fbx));
  const glb = convert(fbx, path.join(TMP, 'hero'));
  const read = readGlb(glb);
  const json = read.json;
  delete json.animations; // the hero file's own take is empty; clips come separately
  cleanMaterials(json);
  const replace = shrinkTextures(json, read.bin);
  const newBin = rebuildBuffer(json, read.bin, replace);
  fs.mkdirSync(OUT, { recursive: true });
  const size = writeGlb(path.join(OUT, 'hero.glb'), json, newBin);

  const mesh = json.meshes[0];
  const tris = mesh.primitives.reduce((s, p) => s + json.accessors[p.indices].count / 3, 0);
  const pos = mesh.primitives.map((p) => json.accessors[p.attributes.POSITION]);
  const height = Math.max.apply(null, pos.map((a) => a.max[1]));
  const floor = Math.min.apply(null, pos.map((a) => a.min[1]));
  console.log('  ' + (size / 1048576).toFixed(2) + ' MB, ' + tris + ' tris, height '
    + height.toFixed(3) + ' m, feet ' + floor.toFixed(3) + ' m');
  return { file: 'hero.glb', bytes: size, tris, height, floor, nodes: json.nodes.length };
}

function buildClip(fbx, seen) {
  const { role, angle, armed } = roleFor(fbx);
  let { name } = roleFor(fbx);
  if (role === 'many') {
    // punch, punch-2, punch-3... The runtime picks from the set by role, so the
    // numbering only has to be stable, not meaningful.
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n > 1) name = name + '-' + n;
  }
  console.log('clip ' + name + ' [' + role + ']: ' + path.basename(fbx));
  const glb = convert(fbx, path.join(TMP, name));
  const src = readGlb(glb);
  const report = channelReport(src.json, src.bin);
  if (!report) {
    // Not a character export at all. raw/ is also where a car model gets
    // dropped (see scripts/convert-cars.mjs), so this is a skip, not an error.
    console.log('  no animation channels; not a character clip, skipping');
    return null;
  }
  const stripped = stripToAnimation(src.json, src.bin);
  stripped.json.animations[0].name = name;
  const size = writeGlb(path.join(OUT, 'anim-' + name + '.glb'), stripped.json, stripped.bin);

  const r = report.root;
  // Ground speed the clip was authored at: how far the hips actually travel,
  // over how long. This is what makes stride matching exact instead of tuned.
  const travel = r ? r.travel : 0;
  const groundSpeed = report.duration > 0 ? travel / report.duration : 0;
  console.log('  ' + (size / 1024).toFixed(0) + ' KB, ' + report.duration.toFixed(3) + ' s, '
    + report.channels + ' channels, root travel ' + travel.toFixed(3) + ' m -> '
    + groundSpeed.toFixed(3) + ' m/s');
  // A directional clip's angle is read off its own root motion where it has
  // any: the file name says a clip is a strafe, but only the motion says which
  // way it strafes, and getting that backwards puts the character sidestepping
  // into the thing it is trying to circle.
  const measured = role === 'dir' && travel > 0.05 ? Math.round(r.travelDeg) : angle;
  return {
    name, role, angle: measured, armed, file: 'anim-' + name + '.glb', bytes: size,
    source: path.relative(RAW, fbx).split(path.sep).join('/'),
    duration: report.duration, channels: report.channels, groundSpeed,
    rootMotion: r ? { x: r.rangeX, y: r.rangeY, z: r.rangeZ, travel: r.travel } : null,
    inPlace: travel < 0.05,
    /** Yaw baked into the hips, degrees. Anything but ~0 fights the controller. */
    rootYawDeg: r ? +(r.yaw * 180 / Math.PI).toFixed(2) : 0,
  };
}

function main() {
  if (!fs.existsSync(RAW)) {
    console.log('no ' + path.relative(ROOT, RAW) + '; nothing to convert');
    return;
  }
  const files = findFbx(RAW);
  if (files.length === 0) { console.log('no .fbx in raw/'); return; }

  const heroFile = files.find((f) => HERO.test(path.basename(f))) || files[0];
  const hero = buildHero(heroFile);
  const seen = new Map();
  const clips = files.filter((f) => f !== heroFile)
    .map((f) => buildClip(f, seen))
    .filter(Boolean);

  const manifest = { hero, clips, generated: new Date().toISOString().slice(0, 10) };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const total = hero.bytes + clips.reduce((s, c) => s + c.bytes, 0);
  console.log('\ntotal ' + (total / 1048576).toFixed(2) + ' MB in public/assets/character/');
  console.log('\n| clip | duration | channels | root motion | authored speed |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const c of clips) {
    const rm = c.inPlace ? 'in place' : c.rootMotion.travel.toFixed(2) + ' m';
    console.log('| ' + c.name + ' | ' + c.duration.toFixed(2) + ' s | ' + c.channels + ' | '
      + rm + ' | ' + c.groundSpeed.toFixed(2) + ' m/s |');
  }
}

main();
