import fs from 'node:fs';
import path from 'node:path';

// Read-only audit; does not instantiate a renderer or modify the assets.
function scan(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) scan(p);
    else if (p.endsWith('.glb')) {
      const b = fs.readFileSync(p);
      const j = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
      console.log(JSON.stringify({
        file: p,
        format: j.asset.version,
        joints: j.skins?.map(skin => skin.joints.map(index => {
          const node = j.nodes[index];
          const parent = j.nodes.find(n => n.children?.includes(index));
          return { name: node.name, parent: parent?.name, translation: node.translation };
        })) ?? [],
        materials: j.materials,
        images: j.images?.map(im => {
          const view = j.bufferViews[im.bufferView];
          const start = 28 + b.readUInt32LE(12) + (view.byteOffset ?? 0);
          return {
            mime: im.mimeType, bytes: view.byteLength,
            pngSize: im.mimeType === 'image/png' ? [b.readUInt32BE(start + 16), b.readUInt32BE(start + 20)] : null,
          };
        }),
        animations: j.animations?.map(a => ({
          name: a.name, channels: a.channels.length,
          duration: Math.max(...a.samplers.map(s => j.accessors[s.input].max?.[0] ?? 0)),
        })) ?? [],
        geometry: j.meshes?.map(m => m.primitives.map(primitive => ({
          vertices: j.accessors[primitive.attributes.POSITION].count,
          min: j.accessors[primitive.attributes.POSITION].min,
          max: j.accessors[primitive.attributes.POSITION].max,
          skinned: primitive.attributes.JOINTS_0 !== undefined && primitive.attributes.WEIGHTS_0 !== undefined,
        }))),
      }, null, 2));
    }
  }
}
scan(process.argv[2] ?? 'public/assets/models/new character model');
