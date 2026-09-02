// Cheap contact darkening at ground level (realism pass 2.1).
//
// Buildings and props sit on the road like decals without it: every wall meets
// the pavement at the same brightness it has three storeys up, and the eye reads
// that as "pasted on". Darkening the bottom couple of metres is most of what a
// baked AO pass buys, for nothing.
//
// DECISION: a world-height gradient injected via onBeforeCompile, not baked
// vertex colours. Buildings are InstancedMesh boxes -- one shared unit-cube
// geometry scaled per instance from 4 m to 90 m tall -- so a vertex colour on
// that geometry would put the shadow at 3% of each building's height instead of
// at 3 metres. The gradient is computed from world Y in the fragment shader, so
// it lands in the right place on every instance and costs one extra varying.
//
// Concave corners are left to the SSAO pass, which is the thing that actually
// knows about them; see core/post.ts.
import * as THREE from 'three';

/** Height over which the darkening fades out, metres. */
const FADE = 3;
/** How dark it gets at ground level. 1 = unchanged. */
const FLOOR = 0.62;

const PATCHED = Symbol('groundAo');

type Patchable = THREE.Material & { [PATCHED]?: boolean };

/**
 * Multiply a material's diffuse by a ground-contact gradient.
 *
 * Safe to call twice on the same material: the second call is a no-op, so
 * callers sharing a material between meshes do not stack the effect.
 */
export function applyGroundAo(material: THREE.Material, fade = FADE, floor = FLOOR): void {
  const m = material as Patchable;
  if (m[PATCHED]) return;
  m[PATCHED] = true;

  const prev = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.aoFade = { value: fade };
    shader.uniforms.aoFloor = { value: floor };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vGroundY;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        #if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
          vGroundY = worldPosition.y;
        #else
          vec4 aoWorldPos = vec4( transformed, 1.0 );
          #ifdef USE_BATCHING
            aoWorldPos = batchingMatrix * aoWorldPos;
          #endif
          #ifdef USE_INSTANCING
            aoWorldPos = instanceMatrix * aoWorldPos;
          #endif
          aoWorldPos = modelMatrix * aoWorldPos;
          vGroundY = aoWorldPos.y;
        #endif`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vGroundY;
        uniform float aoFade;
        uniform float aoFloor;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float aoT = clamp( vGroundY / aoFade, 0.0, 1.0 );
          // Squared falloff: tight and dark at the kerb, gone by head height.
          diffuseColor.rgb *= mix( aoFloor, 1.0, aoT * aoT );
        }`,
      );
  };
  material.needsUpdate = true;
}

/** Apply to every material under `root`, including instanced meshes. */
export function applyGroundAoTree(root: THREE.Object3D, fade?: number, floor?: number): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) if (m) applyGroundAo(m, fade, floor);
  });
}
