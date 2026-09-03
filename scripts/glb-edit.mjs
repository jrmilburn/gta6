// glTF surgery used by convert-character.mjs.
//
// FBX2glTF emits one GLB per source file, and every Mixamo animation export
// carries a full copy of the character mesh and its 45 MB of 4K textures. The
// two operations here are what turn six 50 MB dumps into a 5 MB character and
// five clips of a few hundred KB each.
import { readAccessor } from './glb.mjs';

const align4 = (n) => n + ((4 - (n % 4)) % 4);

/**
 * Rewrite the binary chunk, optionally substituting whole bufferViews.
 *
 * `replace` maps a bufferView index to a replacement Buffer (a re-encoded
 * image). Accessor byteOffsets are relative to their view, so moving views
 * around is safe as long as each one stays 4-byte aligned and contiguous.
 */
export function rebuildBuffer(json, bin, replace = new Map()) {
  const chunks = [];
  let offset = 0;
  for (let i = 0; i < json.bufferViews.length; i++) {
    const view = json.bufferViews[i];
    const sub = replace.get(i)
      ?? bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    const start = align4(offset);
    if (start > offset) chunks.push(Buffer.alloc(start - offset));
    chunks.push(sub);
    view.byteOffset = start;
    view.byteLength = sub.length;
    offset = start + sub.length;
  }
  const out = Buffer.concat(chunks);
  json.buffers = [{ byteLength: out.length }];
  for (const v of json.bufferViews) v.buffer = 0;
  return out;
}

/**
 * Keep the node hierarchy and the animation; throw everything else away.
 *
 * The skeleton has to survive because three.js binds a clip by node NAME, and
 * the names only exist as nodes. Meshes, skins, materials and images do not:
 * the clip is replayed on the hero's own skeleton, which shares this one's
 * bone names because both came out of the same Mixamo character.
 */
export function stripToAnimation(json, bin) {
  const anim = (json.animations ?? []).find((a) => (a.channels ?? []).length > 0);
  if (!anim) throw new Error('no animation with channels');

  // Collect the accessors the samplers reference, and map them to new indices.
  const keep = [];
  const remap = new Map();
  const claim = (idx) => {
    if (remap.has(idx)) return remap.get(idx);
    const next = keep.length;
    remap.set(idx, next);
    keep.push(json.accessors[idx]);
    return next;
  };
  for (const s of anim.samplers) {
    s.input = claim(s.input);
    s.output = claim(s.output);
  }

  // Views, in the order their accessors now appear.
  const views = [];
  const viewData = [];
  for (const a of keep) {
    const src = json.bufferViews[a.bufferView];
    const start = (src.byteOffset ?? 0) + (a.byteOffset ?? 0);
    // Accessor data is tightly packed here (FBX2glTF never interleaves
    // animation output), so the slice is exactly the accessor's own bytes.
    const bytes = accessorBytes(a);
    viewData.push(bin.subarray(start, start + bytes));
    a.bufferView = views.length;
    a.byteOffset = 0;
    views.push({ buffer: 0, byteOffset: 0, byteLength: bytes });
  }

  const out = { asset: json.asset, scene: 0, scenes: json.scenes, nodes: json.nodes };
  for (const n of out.nodes) { delete n.mesh; delete n.skin; }
  out.accessors = keep;
  out.bufferViews = views;
  out.animations = [anim];

  const replace = new Map(viewData.map((d, i) => [i, d]));
  const newBin = rebuildBuffer(out, Buffer.alloc(0), replace);
  return { json: out, bin: newBin };
}

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function accessorBytes(a) {
  return a.count * TYPE_COUNT[a.type] * COMPONENT_BYTES[a.componentType];
}

/** Node index -> name, for reporting which bones a clip actually drives. */
export function channelReport(json, bin) {
  const anim = (json.animations ?? []).find((a) => (a.channels ?? []).length > 0);
  if (!anim) return null;
  const dur = Math.max(...anim.samplers.map((s) => json.accessors[s.input].max[0]));
  let root = null;
  let yaw = 0;
  // Net yaw baked into the hips over the clip. A locomotion clip that turns as
  // it goes is fighting a controller that also owns the facing, and a punch or
  // an idle that turns is the reason a character spins on the spot.
  for (const c of anim.channels) {
    const name = json.nodes[c.target.node].name ?? '';
    if (c.target.path !== 'rotation' || !/Hips$/.test(name)) continue;
    const { data, count } = readAccessor(json, bin, anim.samplers[c.sampler].output);
    const yawAt = (i) => {
      const x = data[i * 4], y = data[i * 4 + 1], z = data[i * 4 + 2], w = data[i * 4 + 3];
      return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
    };
    let acc = 0, prev = yawAt(0);
    for (let i = 1; i < count; i++) {
      const cur = yawAt(i);
      let d = cur - prev;
      // Unwrap, or a clip that passes through +/-180 reads as a full turn.
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      acc += d;
      prev = cur;
    }
    yaw = acc;
  }
  for (const c of anim.channels) {
    const name = json.nodes[c.target.node].name ?? '';
    if (c.target.path !== 'translation' || !/Hips$/.test(name)) continue;
    const { data, count } = readAccessor(json, bin, anim.samplers[c.sampler].output);
    const span = (o) => {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < count; i++) { const v = data[i * 3 + o]; if (v < lo) lo = v; if (v > hi) hi = v; }
      return hi - lo;
    };
    // Net travel, not extent: a dance that returns to its mark has a big X
    // range and zero net displacement, and only net travel is a stride.
    const netX = data[(count - 1) * 3] - data[0];
    const netZ = data[(count - 1) * 3 + 2] - data[2];
    root = {
      node: name,
      rangeX: span(0), rangeY: span(1), rangeZ: span(2),
      travel: Math.hypot(netX, netZ),
      restY: data[1],
      yaw,
    };
  }
  return { name: anim.name, duration: dur, channels: anim.channels.length, root };
}
