// Minimal GLB reader/writer used by the character conversion scripts.
// glTF is a JSON chunk followed by a binary chunk; nothing here needs three.js
// or a DOM, so the build step stays a plain Node script.
import fs from 'node:fs';

export function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`);
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));
    else if (type === 0x004e4942) bin = Buffer.from(body);
    off += 8 + len + ((4 - (len % 4)) % 4) * 0;
    off += (4 - (off % 4)) % 4;
  }
  return { json, bin };
}

const pad4 = (n) => (4 - (n % 4)) % 4;

export function writeGlb(file, json, bin) {
  const j = Buffer.from(JSON.stringify(json), 'utf8');
  const jp = Buffer.concat([j, Buffer.alloc(pad4(j.length), 0x20)]);
  const bp = Buffer.concat([bin, Buffer.alloc(pad4(bin.length), 0)]);
  const total = 12 + 8 + jp.length + (bp.length ? 8 + bp.length : 0);
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jp.length, 12); out.writeUInt32LE(0x4e4f534a, 16);
  jp.copy(out, 20);
  if (bp.length) {
    const o = 20 + jp.length;
    out.writeUInt32LE(bp.length, o); out.writeUInt32LE(0x004e4942, o + 4);
    bp.copy(out, o + 8);
  }
  fs.writeFileSync(file, out);
  return total;
}

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Read one accessor out of the binary chunk as a plain JS array of numbers. */
export function readAccessor(json, bin, index) {
  const a = json.accessors[index];
  const comps = TYPE_COUNT[a.type];
  const bytes = COMPONENT_BYTES[a.componentType];
  const view = json.bufferViews[a.bufferView];
  const base = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const stride = view.byteStride ?? comps * bytes;
  const out = new Array(a.count * comps);
  for (let i = 0; i < a.count; i++) {
    for (let c = 0; c < comps; c++) {
      const o = base + i * stride + c * bytes;
      out[i * comps + c] = a.componentType === 5126 ? bin.readFloatLE(o)
        : a.componentType === 5125 ? bin.readUInt32LE(o)
        : a.componentType === 5123 ? bin.readUInt16LE(o)
        : a.componentType === 5121 ? bin.readUInt8(o)
        : a.componentType === 5122 ? bin.readInt16LE(o)
        : bin.readInt8(o);
    }
  }
  return { data: out, comps, count: a.count, min: a.min, max: a.max };
}
