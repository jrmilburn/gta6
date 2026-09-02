// Animated water beyond the beach edge. Two layered sine waves displace the
// vertex Y; the same waves are evaluated per fragment to get a cheap analytic
// normal for a fresnel-ish tint and a broad sun glitter. One draw call, no
// render targets, no reflections.
import * as THREE from 'three';
import { CFG } from '../config';
import { WATER_EDGE } from './cityGen';

const WAVE = /* glsl */ `
float waveAt(vec2 p, float t) {
  return sin(p.x * 0.055 + t * 0.9) * 0.42
       + sin(p.y * 0.083 - t * 1.35) * 0.26;
}`;

const VERT = /* glsl */ `
uniform float uTime;
varying vec3 vWorld;
${WAVE}
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  wp.y += waveAt(wp.xz, uTime);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  #include <fog_vertex>
  gl_Position = projectionMatrix * mvPosition;
}`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uSky;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
varying vec3 vWorld;
${WAVE}
#include <fog_pars_fragment>
void main() {
  vec2 p = vWorld.xz;
  float w = waveAt(p, uTime);
  // Analytic gradient of waveAt, plus a finer ripple that only shows up in the
  // shading (too small to be worth extra vertices).
  float dx = 0.055 * 0.42 * cos(p.x * 0.055 + uTime * 0.9)
           + 0.35 * 0.06 * cos(p.x * 0.35 + p.y * 0.11 + uTime * 2.1);
  float dz = 0.083 * 0.26 * cos(p.y * 0.083 - uTime * 1.35)
           + 0.11 * 0.06 * cos(p.x * 0.35 + p.y * 0.11 + uTime * 2.1);
  vec3 n = normalize(vec3(-dx, 1.0, -dz));
  vec3 v = normalize(cameraPosition - vWorld);

  float fres = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 4.0);
  // Shallows lighten toward the beach; the swell only nudges the tint so the
  // coarse mesh never reads as blobs.
  float shore = smoothstep(-1300.0, -560.0, vWorld.z);
  vec3 col = mix(uDeep, uShallow, 0.35 + shore * 0.4 + w * 0.16);
  col = mix(col, uSky, clamp(fres, 0.0, 1.0) * 0.8);
  float spec = pow(max(dot(reflect(-v, n), uSunDir), 0.0), 34.0);
  col += uSunColor * spec * 1.4;

  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}`;

export interface Water {
  mesh: THREE.Mesh;
  update(t: number): void;
}

/** `sunDir` should be the sky rig's sun direction so the glitter lines up. */
export function buildWater(sunDir?: THREE.Vector3): Water {
  const geo = new THREE.PlaneGeometry(9000, 3400, 150, 60);
  geo.rotateX(-Math.PI / 2);

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uDeep: { value: new THREE.Color(0x0d6f84) },
        uShallow: { value: new THREE.Color(CFG.colors.water) },
        uSky: { value: new THREE.Color(CFG.colors.skyHorizon) },
        uSunDir: { value: (sunDir ?? new THREE.Vector3(0, 0.31, -0.95)).clone().normalize() },
        uSunColor: { value: new THREE.Color(CFG.colors.sun) },
      },
    ]),
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'water';
  // Sits just under the sand lip so the shoreline reads as a wet edge.
  // Low enough that no wave crest ever pokes through the sand it slides under.
  mesh.position.set(0, -1.1, WATER_EDGE - 1670);
  mesh.receiveShadow = false;
  mesh.castShadow = false;

  return {
    mesh,
    update(t: number) { mat.uniforms.uTime.value = t; },
  };
}
