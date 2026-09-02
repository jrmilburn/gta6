// Vertex-shader wind for vegetation (realism pass 2.3).
//
// Static trees are the fastest way to make an outdoor scene read as a diorama.
// This sways each vertex by its height above the base, phased by the instance's
// world position so neighbouring trees are never in step -- the thing that makes
// a row of palms look like a row of copies rather than a row of trees.
import * as THREE from 'three';

export interface WindHandle {
  /** Advance every registered material's clock. Call once per rendered frame. */
  update(time: number): void;
  add(material: THREE.Material, amplitude: number): void;
}

interface Registered { uniform: { value: number } }

/** One clock shared by every wind material, so the whole city sways together. */
export function createWind(): WindHandle {
  const registered: Registered[] = [];

  return {
    update(time: number): void {
      for (const r of registered) r.uniform.value = time;
    },
    add(material: THREE.Material, amplitude: number): void {
      const prev = material.onBeforeCompile.bind(material);
      material.onBeforeCompile = (shader, renderer) => {
        prev(shader, renderer);
        const clock = { value: 0 };
        shader.uniforms.windTime = clock;
        shader.uniforms.windAmp = { value: amplitude };
        registered.push({ uniform: clock });

        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>
            uniform float windTime;
            uniform float windAmp;`)
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            {
              // Origin of THIS instance, so every copy gets its own phase.
              vec3 windOrigin = vec3( modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2] );
              #ifdef USE_INSTANCING
                vec4 windInst = modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
                windOrigin = windInst.xyz;
              #endif
              // Height above the model's own base drives the amplitude: trunks
              // barely move, canopies and fronds do all the work.
              float windH = max( transformed.y, 0.0 );
              float windPhase = windTime + windOrigin.x * 0.3 + windOrigin.z * 0.17;
              float windSway = windH * windAmp;
              transformed.x += sin( windPhase ) * windSway;
              transformed.z += cos( windPhase * 0.73 ) * windSway * 0.6;
              // A faster, smaller flutter on top, so fronds shiver rather than
              // only swinging as one rigid mass.
              transformed.x += sin( windPhase * 3.1 ) * windSway * 0.18;
            }`);
      };
      material.needsUpdate = true;
    },
  };
}
