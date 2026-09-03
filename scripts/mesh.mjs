// Mesh handling for the car conversion: flatten a glTF into one interleaved
// vertex set, orient it, weld it down, and write a fresh minimal GLB.
//
// Rebuilding rather than editing in place. A Meshy export is one mesh in one
// material, and once it has been re-oriented and decimated there is nothing
// left of the original accessor layout worth preserving -- so the output is
// authored from scratch, which is far easier to get right than patching
// bufferViews around a changing vertex count.
import { readAccessor } from './glb.mjs';

/** 4x4 matrix helpers, row-major, applied as m * v. */
export function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = s;
    }
  }
  return out;
}

/** glTF stores node matrices column-major; this converts one to row-major. */
export function fromColumnMajor(m) {
  const out = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[r * 4 + c] = m[c * 4 + r];
  return out;
}

export function fromTrs(node) {
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  const [x, y, z, w] = r;
  const rot = [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0,
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0,
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1,
  ];
  for (let c = 0; c < 3; c++) for (let r2 = 0; r2 < 3; r2++) rot[r2 * 4 + c] *= s[c];
  rot[3] = t[0]; rot[7] = t[1]; rot[11] = t[2];
  return rot;
}

function nodeMatrix(node) {
  return node.matrix ? fromColumnMajor(node.matrix) : fromTrs(node);
}

/**
 * Walk the scene and collect every primitive's vertices in world space.
 *
 * Returns one flat set of positions, normals, UVs and triangle indices --
 * whatever the file's node hierarchy was, it is baked in here and gone.
 */
export function flatten(json, bin, keep = null) {
  const pos = [], nrm = [], uv = [], idx = [];
  const walk = (nodeIndex, parent) => {
    const node = json.nodes[nodeIndex];
    const world = multiply(parent, nodeMatrix(node));
    // `keep` selects which nodes matter. Poly Haven ships several props as a
    // showcase -- two finishes of the same bin side by side, a bench as a flat
    // pack of parts -- and taking the whole scene gives a prop that is two
    // metres wide and made of spares.
    if (node.mesh !== undefined && (!keep || keep(node.name ?? ''))) {
      for (const prim of json.meshes[node.mesh].primitives) {
        const base = pos.length / 3;
        const p = readAccessor(json, bin, prim.attributes.POSITION);
        const n = prim.attributes.NORMAL !== undefined
          ? readAccessor(json, bin, prim.attributes.NORMAL) : null;
        const t = prim.attributes.TEXCOORD_0 !== undefined
          ? readAccessor(json, bin, prim.attributes.TEXCOORD_0) : null;
        for (let i = 0; i < p.count; i++) {
          const x = p.data[i * 3], y = p.data[i * 3 + 1], z = p.data[i * 3 + 2];
          pos.push(
            world[0] * x + world[1] * y + world[2] * z + world[3],
            world[4] * x + world[5] * y + world[6] * z + world[7],
            world[8] * x + world[9] * y + world[10] * z + world[11],
          );
          // Normals take the rotation only; these transforms carry no shear, so
          // the upper 3x3 is orthogonal up to the uniform scale a normalise
          // undoes anyway.
          const nx = n ? n.data[i * 3] : 0, ny = n ? n.data[i * 3 + 1] : 1, nz = n ? n.data[i * 3 + 2] : 0;
          nrm.push(
            world[0] * nx + world[1] * ny + world[2] * nz,
            world[4] * nx + world[5] * ny + world[6] * nz,
            world[8] * nx + world[9] * ny + world[10] * nz,
          );
          uv.push(t ? t.data[i * 2] : 0, t ? t.data[i * 2 + 1] : 0);
        }
        if (prim.indices !== undefined) {
          const ind = readAccessor(json, bin, prim.indices);
          for (let i = 0; i < ind.count; i++) idx.push(base + ind.data[i]);
        } else {
          for (let i = 0; i < p.count; i++) idx.push(base + i);
        }
      }
    }
    for (const child of node.children ?? []) walk(child, world);
  };
  for (const root of json.scenes[json.scene ?? 0].nodes) walk(root, identity());
  return { pos, nrm, uv, idx };
}

const align4 = (n) => n + ((4 - (n % 4)) % 4);

/**
 * Author a minimal glTF from one flattened mesh: one node, one mesh, one
 * material, and whatever images are handed in. Everything that reaches here has
 * already been flattened, oriented and welded, so there is nothing left of the
 * source layout worth preserving.
 */
export function packGlb(mesh, images, name = 'Model') {
  const chunks = [];
  const bufferViews = [];
  let offset = 0;
  const push = (buf, extra = {}) => {
    const start = align4(offset);
    if (start > offset) chunks.push(Buffer.alloc(start - offset));
    chunks.push(buf);
    const index = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: start, byteLength: buf.length, ...extra });
    offset = start + buf.length;
    return index;
  };
  const floats = (arr) => push(Buffer.from(new Float32Array(arr).buffer), { target: 34962 });

  const count = mesh.pos.length / 3;
  const posView = floats(mesh.pos);
  const nrmView = floats(mesh.nrm);
  const uvView = floats(mesh.uv);
  const big = count > 65535;
  const indexArray = big ? new Uint32Array(mesh.idx) : new Uint16Array(mesh.idx);
  const idxView = push(Buffer.from(indexArray.buffer), { target: 34963 });
  const hasCol = Array.isArray(mesh.col);
  const colView = hasCol ? floats(mesh.col) : -1;
  const e = extents(mesh.pos);

  const json = {
    asset: { version: '2.0', generator: 'sunbelt-city' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name, mesh: 0 }],
    meshes: [{
      name,
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, ...(hasCol ? { COLOR_0: 4 } : {}) },
        indices: 3,
        material: 0,
      }],
    }],
    accessors: [
      { bufferView: posView, componentType: 5126, count, type: 'VEC3', min: e.min, max: e.max },
      { bufferView: nrmView, componentType: 5126, count, type: 'VEC3' },
      { bufferView: uvView, componentType: 5126, count, type: 'VEC2' },
      { bufferView: idxView, componentType: big ? 5125 : 5123, count: mesh.idx.length, type: 'SCALAR' },
      ...(hasCol ? [{ bufferView: colView, componentType: 5126, count, type: 'VEC3' }] : []),
    ],
    bufferViews,
    buffers: [{ byteLength: 0 }],
    samplers: [{ wrapS: 10497, wrapT: 10497 }],
    images: [],
    textures: [],
    materials: [{ name, pbrMetallicRoughness: {} }],
  };

  const pbr = json.materials[0].pbrMetallicRoughness;
  const addImage = (bytes) => {
    const view = push(bytes);
    json.images.push({ bufferView: view, mimeType: 'image/webp' });
    json.textures.push({ sampler: 0, source: json.images.length - 1 });
    return json.textures.length - 1;
  };
  if (images.color) pbr.baseColorTexture = { index: addImage(images.color) };
  if (images.normal) json.materials[0].normalTexture = { index: addImage(images.normal) };
  if (images.mr) {
    pbr.metallicRoughnessTexture = { index: addImage(images.mr) };
    pbr.roughnessFactor = 1;
    pbr.metallicFactor = 1;
  } else {
    pbr.metallicFactor = images.metalness ?? 0;
    pbr.roughnessFactor = images.roughness ?? 0.8;
  }

  const bin = Buffer.concat(chunks);
  json.buffers[0].byteLength = bin.length;
  return { json, bin };
}

export function extents(pos) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = pos[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/**
 * Rotate, scale and re-origin a car onto the game's axes.
 *
 * DECISION: the up axis is inferred from the shape, not read from the file.
 * FBX has an up-axis field and exporters lie about it constantly -- these two
 * arrive Z-up and claiming otherwise. A car is always longer than it is wide
 * and wider than it is tall, so sorting the three extents identifies all three
 * axes with no metadata at all, and is right for any car anyone drops in.
 */
export function orientAndFit(mesh, targetLength) {
  const e = extents(mesh.pos);
  const order = [0, 1, 2].sort((a, b) => e.size[b] - e.size[a]);
  const [iL, iW, iH] = order;                     // length, width, height
  const scale = targetLength / Math.max(e.size[iL], 1e-9);
  const cx = (e.min[iW] + e.max[iW]) / 2;
  const cz = (e.min[iL] + e.max[iL]) / 2;
  const floor = e.min[iH];

  const p = mesh.pos, n = mesh.nrm;
  for (let i = 0; i < p.length; i += 3) {
    const l = p[i + iL], w = p[i + iW], h = p[i + iH];
    p[i] = (w - cx) * scale;
    p[i + 1] = (h - floor) * scale;
    p[i + 2] = (l - cz) * scale;
    const nl = n[i + iL], nw = n[i + iW], nh = n[i + iH];
    n[i] = nw; n[i + 1] = nh; n[i + 2] = nl;
  }
  // Reordering three axes is a reflection when the permutation is odd; flipping
  // X back makes it a rotation again, so the mesh is not inside out.
  const odd = (iL === 0 && iW === 2) || (iL === 1 && iW === 0) || (iL === 2 && iW === 1);
  if (odd) {
    for (let i = 0; i < p.length; i += 3) { p[i] = -p[i]; n[i] = -n[i]; }
  }
  // DECISION: turn the car end for end. The extents identify which axis is the
  // car's length, but nothing about a bounding box says which end is the nose --
  // and both supplied exports point down -Z, so they drove away backwards.
  // Negating X and Z together is a half turn about Y, so this stays a rotation.
  // If a future drop faces the other way, this is the one line to change.
  for (let i = 0; i < p.length; i += 3) {
    p[i] = -p[i]; p[i + 2] = -p[i + 2];
    n[i] = -n[i]; n[i + 2] = -n[i + 2];
  }
  const after = extents(p);
  return {
    scale, rotated: iL !== 2 || iH !== 1,
    length: +after.size[2].toFixed(3),
    width: +after.size[0].toFixed(3),
    height: +after.size[1].toFixed(3),
  };
}

/**
 * Weld vertices onto a grid until the triangle count fits the budget.
 *
 * The same crude clustering the far-distance pedestrian uses. A 550k-triangle
 * generated car is a sculpting artefact rather than detail anyone will see at
 * driving distance, and a traffic system that instances it forty times cannot
 * afford the honesty. The cell size is found by bisection so the budget is met
 * with the least welding that meets it.
 */
export function decimate(mesh, maxTris) {
  if (mesh.idx.length / 3 <= maxTris) return { tris: mesh.idx.length / 3, cell: 0 };
  const e = extents(mesh.pos);
  // The ceiling is half the object's longest side: enough to collapse anything
  // to a handful of cells, so the bisection always has a solution to find.
  let lo = 0, hi = Math.max(...e.size) / 2, best = null;
  for (let step = 0; step < 14; step++) {
    const cell = (lo + hi) / 2;
    const out = weld(mesh, cell);
    if (out.idx.length / 3 > maxTris) lo = cell;
    else { hi = cell; best = { out, cell }; }
  }
  if (!best) return { tris: mesh.idx.length / 3, cell: 0 };
  mesh.pos = best.out.pos;
  mesh.nrm = best.out.nrm;
  mesh.uv = best.out.uv;
  mesh.idx = best.out.idx;
  return { tris: mesh.idx.length / 3, cell: +best.cell.toFixed(4) };
}

/** How finely UVs are compared when deciding whether two vertices may merge. */
const UV_CELLS = 48;

/**
 * Collapse a mesh onto a position grid, WITHOUT welding across a texture seam.
 *
 * Two things are tracked, and conflating them is what ruins a welded model. The
 * *cell* is purely positional and decides which triangles collapse to nothing.
 * The *vertex* is a cell plus a coarse UV, so two corners that sit at the same
 * point but sample opposite ends of the atlas stay separate vertices at the same
 * position. Merge them and the triangles between them stretch right across the
 * texture, which paints dark streaks along every seam -- a car covered in cracks
 * that are not in its albedo at all.
 */
function weld(mesh, cell) {
  const cells = new Map();
  const verts = new Map();
  const cellOf = new Int32Array(mesh.pos.length / 3);
  const remap = new Int32Array(mesh.pos.length / 3);
  const pos = [], nrm = [], uv = [];
  for (let i = 0; i < remap.length; i++) {
    const cx = Math.round(mesh.pos[i * 3] / cell);
    const cy = Math.round(mesh.pos[i * 3 + 1] / cell);
    const cz = Math.round(mesh.pos[i * 3 + 2] / cell);
    const cellKey = `${cx},${cy},${cz}`;
    let cellId = cells.get(cellKey);
    if (cellId === undefined) {
      // The first vertex in a cell fixes the position every copy of it uses, so
      // the UV-split duplicates sit exactly on top of each other and the surface
      // does not tear open along the seam.
      cellId = cells.size;
      cells.set(cellKey, cellId);
    }
    cellOf[i] = cellId;
    const key = `${cellKey}|${Math.round(mesh.uv[i * 2] * UV_CELLS)},`
      + `${Math.round(mesh.uv[i * 2 + 1] * UV_CELLS)}`;
    const hit = verts.get(key);
    if (hit !== undefined) { remap[i] = hit; continue; }
    remap[i] = pos.length / 3;
    verts.set(key, remap[i]);
    pos.push(mesh.pos[i * 3], mesh.pos[i * 3 + 1], mesh.pos[i * 3 + 2]);
    nrm.push(mesh.nrm[i * 3], mesh.nrm[i * 3 + 1], mesh.nrm[i * 3 + 2]);
    uv.push(mesh.uv[i * 2], mesh.uv[i * 2 + 1]);
  }
  const idx = [];
  for (let i = 0; i < mesh.idx.length; i += 3) {
    const ia = mesh.idx[i], ib = mesh.idx[i + 1], ic = mesh.idx[i + 2];
    // Collapsed by POSITION, not by vertex: a triangle whose corners all fell
    // into one cell has no area left, however many UV copies of that cell exist.
    const ca = cellOf[ia], cb = cellOf[ib], cc = cellOf[ic];
    if (ca === cb || cb === cc || ca === cc) continue;
    idx.push(remap[ia], remap[ib], remap[ic]);
  }
  // Every copy of a cell must sit at the same point, or the seam tears open.
  const anchor = new Map();
  for (let i = 0; i < remap.length; i++) {
    const v = remap[i], c = cellOf[i];
    if (!anchor.has(c)) anchor.set(c, v);
    const a = anchor.get(c);
    pos[v * 3] = pos[a * 3];
    pos[v * 3 + 1] = pos[a * 3 + 1];
    pos[v * 3 + 2] = pos[a * 3 + 2];
  }
  return { pos, nrm, uv, idx };
}

// --- multi-material props ------------------------------------------------------
// The car path above collapses a model to one material because a Meshy export
// has one. A palm has a trunk and fronds, a lamp has concrete, metal and a lit
// lens, and a traffic light needs each lens on its own material so the game can
// light one at a time -- so these keep the material split all the way through.

/**
 * Like `flatten`, but one mesh per glTF material, keyed by material name.
 * Returns `[{ name, mesh: { pos, nrm, uv, idx } }]` in first-seen order.
 */
export function flattenByMaterial(json, bin, keep = null) {
  const parts = new Map();
  const walk = (nodeIndex, parent) => {
    const node = json.nodes[nodeIndex];
    const world = multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined && (!keep || keep(node.name ?? ''))) {
      for (const prim of json.meshes[node.mesh].primitives) {
        const name = json.materials?.[prim.material]?.name ?? `material${prim.material ?? 0}`;
        let part = parts.get(name);
        if (!part) { part = { pos: [], nrm: [], uv: [], idx: [] }; parts.set(name, part); }
        const base = part.pos.length / 3;
        const p = readAccessor(json, bin, prim.attributes.POSITION);
        const n = prim.attributes.NORMAL !== undefined ? readAccessor(json, bin, prim.attributes.NORMAL) : null;
        const t = prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(json, bin, prim.attributes.TEXCOORD_0) : null;
        for (let i = 0; i < p.count; i++) {
          const x = p.data[i * 3], y = p.data[i * 3 + 1], z = p.data[i * 3 + 2];
          part.pos.push(
            world[0] * x + world[1] * y + world[2] * z + world[3],
            world[4] * x + world[5] * y + world[6] * z + world[7],
            world[8] * x + world[9] * y + world[10] * z + world[11],
          );
          const nx = n ? n.data[i * 3] : 0, ny = n ? n.data[i * 3 + 1] : 1, nz = n ? n.data[i * 3 + 2] : 0;
          part.nrm.push(
            world[0] * nx + world[1] * ny + world[2] * nz,
            world[4] * nx + world[5] * ny + world[6] * nz,
            world[8] * nx + world[9] * ny + world[10] * nz,
          );
          part.uv.push(t ? t.data[i * 2] : 0, t ? t.data[i * 2 + 1] : 0);
        }
        if (prim.indices !== undefined) {
          const ind = readAccessor(json, bin, prim.indices);
          for (let i = 0; i < ind.count; i++) part.idx.push(base + ind.data[i]);
        } else {
          for (let i = 0; i < p.count; i++) part.idx.push(base + i);
        }
      }
    }
    for (const child of node.children ?? []) walk(child, world);
  };
  for (const root of json.scenes[json.scene ?? 0].nodes) walk(root, identity());
  return [...parts].map(([name, mesh]) => ({ name, mesh }));
}

/** Extents over several parts at once. */
export function extentsOf(parts) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const { mesh } of parts) {
    if (mesh.pos.length === 0) continue;
    const e = extents(mesh.pos);
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], e.min[a]); max[a] = Math.max(max[a], e.max[a]); }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/** Centroid (x, z) of the vertices in a horizontal slice of the model. */
function sliceCentroid(parts, y0, y1) {
  let sx = 0, sz = 0, n = 0;
  for (const { mesh } of parts) {
    const p = mesh.pos;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i + 1] >= y0 && p[i + 1] <= y1) { sx += p[i]; sz += p[i + 2]; n++; }
    }
  }
  return n ? { x: sx / n, z: sz / n } : { x: 0, z: 0 };
}

/**
 * Stand a tall prop upright on the game's axes.
 *
 * Y is trusted as up (the three supplied props all convert Y-up; a model that
 * arrives Z-up is visibly on its side in the printed extents, which is the
 * check). The model is scaled so its height is `targetHeight`, its BASE -- the
 * bottom slice of the mesh, not the bounding box centre, so a leaning palm or
 * a cantilevered lamp still stands on its own foot -- goes to the origin, and
 * it is yawed so `forward` lands on +Z. `forward` is either an explicit unit
 * vector `{ x, z }` or `'head'`, meaning the direction from the base to the
 * centroid of the top of the model: for a lamp post that is the arm, and the
 * game hangs the arm out over the road along local +Z.
 */
export function fitUpright(parts, targetHeight, forward = 'head') {
  const e = extentsOf(parts);
  const scale = targetHeight / Math.max(e.size[1], 1e-9);
  const base = sliceCentroid(parts, e.min[1], e.min[1] + e.size[1] * 0.03);
  const head = sliceCentroid(parts, e.max[1] - e.size[1] * 0.12, e.max[1]);
  const fwd = forward === 'head' ? { x: head.x - base.x, z: head.z - base.z } : forward;
  const fl = Math.hypot(fwd.x, fwd.z);
  // Yaw taking `fwd` onto +Z: rotate by -atan2(fwd.x, fwd.z) about Y.
  const yaw = fl > 1e-6 ? -Math.atan2(fwd.x, fwd.z) : 0;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (const { mesh } of parts) {
    const p = mesh.pos, n = mesh.nrm;
    for (let i = 0; i < p.length; i += 3) {
      const x = (p[i] - base.x) * scale, y = (p[i + 1] - e.min[1]) * scale, z = (p[i + 2] - base.z) * scale;
      p[i] = c * x + s * z; p[i + 1] = y; p[i + 2] = -s * x + c * z;
      const nx = n[i], nz = n[i + 2];
      n[i] = c * nx + s * nz; n[i + 2] = -s * nx + c * nz;
    }
  }
  const after = extentsOf(parts);
  const headAfter = sliceCentroid(parts, after.max[1] - after.size[1] * 0.12, after.max[1]);
  return {
    scale: +scale.toFixed(4),
    height: +after.size[1].toFixed(2),
    width: +after.size[0].toFixed(2),
    depth: +after.size[2].toFixed(2),
    /** Where the top of the model sits relative to the base, after the yaw. */
    reach: { x: +headAfter.x.toFixed(2), z: +headAfter.z.toFixed(2) },
  };
}

/**
 * Author a GLB with one node, one mesh and one primitive per part, each on its
 * own material. `parts[i].material` is `{ images: { color, normal, mr, emissive },
 * color, metalness, roughness, emissive: [r,g,b], doubleSide, alphaMode }`;
 * images are WebP buffers or null.
 */
export function packGlbMulti(parts, name = 'Model') {
  const chunks = [];
  const bufferViews = [];
  let offset = 0;
  const push = (buf, extra = {}) => {
    const start = align4(offset);
    if (start > offset) chunks.push(Buffer.alloc(start - offset));
    chunks.push(buf);
    const index = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: start, byteLength: buf.length, ...extra });
    offset = start + buf.length;
    return index;
  };
  const floats = (arr) => push(Buffer.from(new Float32Array(arr).buffer), { target: 34962 });

  const json = {
    asset: { version: '2.0', generator: 'sunbelt-city' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name, mesh: 0 }],
    meshes: [{ name, primitives: [] }],
    accessors: [],
    bufferViews,
    buffers: [{ byteLength: 0 }],
    samplers: [{ wrapS: 10497, wrapT: 10497 }],
    images: [],
    textures: [],
    materials: [],
  };
  const imageIndex = new Map();
  const addImage = (bytes) => {
    // The same buffer may serve several parts (one atlas, three lenses).
    if (imageIndex.has(bytes)) return imageIndex.get(bytes);
    const view = push(bytes);
    json.images.push({ bufferView: view, mimeType: 'image/webp' });
    json.textures.push({ sampler: 0, source: json.images.length - 1 });
    imageIndex.set(bytes, json.textures.length - 1);
    return json.textures.length - 1;
  };

  for (const part of parts) {
    const mesh = part.mesh;
    if (mesh.idx.length === 0) continue;
    const count = mesh.pos.length / 3;
    const e = extents(mesh.pos);
    const big = count > 65535;
    const indexArray = big ? new Uint32Array(mesh.idx) : new Uint16Array(mesh.idx);
    const a0 = json.accessors.length;
    json.accessors.push(
      { bufferView: floats(mesh.pos), componentType: 5126, count, type: 'VEC3', min: e.min, max: e.max },
      { bufferView: floats(mesh.nrm), componentType: 5126, count, type: 'VEC3' },
      { bufferView: floats(mesh.uv), componentType: 5126, count, type: 'VEC2' },
      { bufferView: push(Buffer.from(indexArray.buffer), { target: 34963 }), componentType: big ? 5125 : 5123, count: mesh.idx.length, type: 'SCALAR' },
    );
    const m = part.material ?? {};
    const images = m.images ?? {};
    const mat = { name: part.name, pbrMetallicRoughness: {} };
    const pbr = mat.pbrMetallicRoughness;
    if (images.color) pbr.baseColorTexture = { index: addImage(images.color) };
    if (m.color) pbr.baseColorFactor = [...m.color, m.alpha ?? 1];
    if (images.normal) mat.normalTexture = { index: addImage(images.normal) };
    if (images.mr) {
      pbr.metallicRoughnessTexture = { index: addImage(images.mr) };
      pbr.roughnessFactor = 1; pbr.metallicFactor = 1;
    } else {
      pbr.metallicFactor = m.metalness ?? 0;
      pbr.roughnessFactor = m.roughness ?? 0.8;
    }
    if (images.emissive) mat.emissiveTexture = { index: addImage(images.emissive) };
    if (m.emissive) mat.emissiveFactor = m.emissive;
    if (m.doubleSide) mat.doubleSided = true;
    if (m.alphaMode) mat.alphaMode = m.alphaMode;
    json.materials.push(mat);
    json.meshes[0].primitives.push({
      attributes: { POSITION: a0, NORMAL: a0 + 1, TEXCOORD_0: a0 + 2 },
      indices: a0 + 3,
      material: json.materials.length - 1,
    });
  }

  const bin = Buffer.concat(chunks);
  json.buffers[0].byteLength = bin.length;
  return { json, bin };
}

// --- edge-collapse simplification and vertex-colour baking ------------------------
// The grid weld above is the right tool for a kit prop and the wrong one for a
// half-million-triangle sculpt: welding a sculpt onto a centimetre grid does not
// simplify it so much as crumple it. meshoptimizer's simplifier is a real
// quadric edge collapse, and it treats vertices that share a position as a seam,
// so a UV-split model keeps its texture layout while it loses its triangles.

/**
 * How badly the UV atlas is fragmented: the fraction of edges shared by two
 * triangles in 3D whose UVs do NOT match up. A hand-unwrapped car is a few
 * percent (its real seams); a Meshy export with a chart per triangle is
 * effectively 100%, and no amount of careful simplification can keep a texture
 * like that readable -- see `bakeVertexColors`.
 */
export function uvFragmentation(mesh) {
  const key = (i) => `${mesh.pos[i * 3].toFixed(5)},${mesh.pos[i * 3 + 1].toFixed(5)},${mesh.pos[i * 3 + 2].toFixed(5)}`;
  const edges = new Map();
  let shared = 0, split = 0;
  for (let t = 0; t < mesh.idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = mesh.idx[t + e], b = mesh.idx[t + ((e + 1) % 3)];
      const ka = key(a), kb = key(b);
      const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const prev = edges.get(ek);
      if (prev === undefined) { edges.set(ek, [a, b]); continue; }
      shared++;
      // Same edge seen from the other triangle: do the UVs agree at both ends?
      const [pa, pb] = prev;
      const match = (i, j) => Math.abs(mesh.uv[i * 2] - mesh.uv[j * 2]) < 1e-4 && Math.abs(mesh.uv[i * 2 + 1] - mesh.uv[j * 2 + 1]) < 1e-4;
      const ok = (key(pa) === ka) ? (match(pa, a) && match(pb, b)) : (match(pa, b) && match(pb, a));
      if (!ok) split++;
    }
  }
  return shared ? split / shared : 0;
}

/**
 * Sample the albedo at every vertex into `mesh.col` (linear RGB, as glTF wants
 * COLOR_0). `image` is `{ size, at(u, v) -> [r, g, b] }` in sRGB bytes.
 */
export function bakeVertexColors(mesh, image) {
  const toLinear = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const col = new Array(mesh.pos.length);
  for (let i = 0; i < mesh.pos.length / 3; i++) {
    const [r, g, b] = image.at(mesh.uv[i * 2], mesh.uv[i * 2 + 1]);
    col[i * 3] = toLinear(r); col[i * 3 + 1] = toLinear(g); col[i * 3 + 2] = toLinear(b);
  }
  mesh.col = col;
}

/**
 * Weld by position only, averaging normals and colours, and dropping the UVs.
 * For a model that has just been baked to vertex colours the UV seams are the
 * only thing keeping its vertices apart, and a closed surface simplifies far
 * better than a bag of loose charts.
 */
export function weldByPosition(mesh, tol = 1e-4) {
  const cells = new Map();
  const remap = new Int32Array(mesh.pos.length / 3);
  const pos = [], nrm = [], col = [], count = [];
  const hasCol = Array.isArray(mesh.col);
  for (let i = 0; i < remap.length; i++) {
    const k = `${Math.round(mesh.pos[i * 3] / tol)},${Math.round(mesh.pos[i * 3 + 1] / tol)},${Math.round(mesh.pos[i * 3 + 2] / tol)}`;
    let j = cells.get(k);
    if (j === undefined) {
      j = pos.length / 3;
      cells.set(k, j);
      pos.push(mesh.pos[i * 3], mesh.pos[i * 3 + 1], mesh.pos[i * 3 + 2]);
      nrm.push(0, 0, 0);
      col.push(0, 0, 0);
      count.push(0);
    }
    remap[i] = j;
    nrm[j * 3] += mesh.nrm[i * 3]; nrm[j * 3 + 1] += mesh.nrm[i * 3 + 1]; nrm[j * 3 + 2] += mesh.nrm[i * 3 + 2];
    if (hasCol) { col[j * 3] += mesh.col[i * 3]; col[j * 3 + 1] += mesh.col[i * 3 + 1]; col[j * 3 + 2] += mesh.col[i * 3 + 2]; }
    count[j]++;
  }
  for (let j = 0; j < count.length; j++) {
    const l = Math.hypot(nrm[j * 3], nrm[j * 3 + 1], nrm[j * 3 + 2]) || 1;
    nrm[j * 3] /= l; nrm[j * 3 + 1] /= l; nrm[j * 3 + 2] /= l;
    col[j * 3] /= count[j]; col[j * 3 + 1] /= count[j]; col[j * 3 + 2] /= count[j];
  }
  const idx = [];
  for (let t = 0; t < mesh.idx.length; t += 3) {
    const a = remap[mesh.idx[t]], b = remap[mesh.idx[t + 1]], c = remap[mesh.idx[t + 2]];
    if (a === b || b === c || a === c) continue;
    idx.push(a, b, c);
  }
  mesh.pos = pos; mesh.nrm = nrm; mesh.idx = idx;
  mesh.uv = new Array((pos.length / 3) * 2).fill(0);
  if (hasCol) mesh.col = col;
  return mesh;
}

/**
 * Quadric edge-collapse simplification down to `maxTris`, via meshoptimizer.
 * Surviving vertices are original vertices, so every attribute rides along
 * untouched; unused ones are dropped afterwards.
 */
export async function simplify(mesh, maxTris, { lockBorder = false } = {}) {
  const before = mesh.idx.length / 3;
  if (before <= maxTris) return { tris: before, error: 0 };
  const { MeshoptSimplifier } = await import('meshoptimizer');
  await MeshoptSimplifier.ready;
  const indices = new Uint32Array(mesh.idx);
  const positions = new Float32Array(mesh.pos);
  const flags = lockBorder ? ['LockBorder'] : [];
  const [out, error] = MeshoptSimplifier.simplify(indices, positions, 3, maxTris * 3, 0.5, flags);

  const remap = new Map();
  const pos = [], nrm = [], uv = [], col = [];
  const hasCol = Array.isArray(mesh.col);
  const idx = new Array(out.length);
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    let j = remap.get(v);
    if (j === undefined) {
      j = pos.length / 3;
      remap.set(v, j);
      pos.push(mesh.pos[v * 3], mesh.pos[v * 3 + 1], mesh.pos[v * 3 + 2]);
      nrm.push(mesh.nrm[v * 3], mesh.nrm[v * 3 + 1], mesh.nrm[v * 3 + 2]);
      uv.push(mesh.uv[v * 2], mesh.uv[v * 2 + 1]);
      if (hasCol) col.push(mesh.col[v * 3], mesh.col[v * 3 + 1], mesh.col[v * 3 + 2]);
    }
    idx[i] = j;
  }
  mesh.pos = pos; mesh.nrm = nrm; mesh.uv = uv; mesh.idx = idx;
  if (hasCol) mesh.col = col;
  return { tris: idx.length / 3, error: +error.toFixed(4) };
}
