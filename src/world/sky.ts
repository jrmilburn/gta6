// Gradient sky dome, fog and the sun rig. This is the signature look (plan 3).
import * as THREE from 'three';
import { CFG } from '../config';

export type TimeOfDay = 'day' | 'dusk';

export interface SkyRig {
  dome: THREE.Mesh;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  ambient: THREE.AmbientLight;
  sunDir: THREE.Vector3;
}

interface Palette { top: number; horizon: number; fog: number; sun: number; sunIntensity: number; hemiIntensity: number; elevation: number }

const PALETTES: Record<TimeOfDay, Palette> = {
  day:  { top: CFG.colors.skyTop, horizon: CFG.colors.skyHorizon, fog: CFG.colors.fog, sun: CFG.colors.sun, sunIntensity: 2.8, hemiIntensity: 1.9, elevation: 18 },
  dusk: { top: 0x2a1a5e, horizon: 0xff7a4d, fog: 0xd98a76, sun: 0xffb070, sunIntensity: 1.9, hemiIntensity: 1.0, elevation: 7 },
};

/** Inverted sphere with a vertex-colour zenith-to-horizon gradient. */
function makeDome(top: THREE.Color, horizon: THREE.Color): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1200, 32, 20);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    // Bias the blend so the warm horizon band stays low and wide.
    const t = THREE.MathUtils.clamp(pos.getY(i) / 1200, -1, 1);
    const k = Math.pow(THREE.MathUtils.clamp(t, 0, 1), 0.55);
    c.copy(horizon).lerp(top, k);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Sun comes in low from the beach side so shadows run long across the streets.
 * `beachAzimuth` is the compass direction (radians) the beach lies in.
 */
export function buildSky(scene: THREE.Scene, time: TimeOfDay, beachAzimuth = -Math.PI / 2): SkyRig {
  const p = PALETTES[time];
  const top = new THREE.Color(p.top);
  const horizon = new THREE.Color(p.horizon);

  const dome = makeDome(top, horizon);
  scene.add(dome);

  scene.fog = new THREE.FogExp2(p.fog, time === 'dusk' ? 0.0032 : 0.0026);
  scene.background = null;

  const el = THREE.MathUtils.degToRad(p.elevation);
  const sunDir = new THREE.Vector3(Math.cos(el) * Math.cos(beachAzimuth), Math.sin(el), Math.cos(el) * Math.sin(beachAzimuth)).normalize();

  const sun = new THREE.DirectionalLight(p.sun, p.sunIntensity);
  sun.position.copy(sunDir).multiplyScalar(400);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 900;
  const s = 220;
  sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
  sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);

  // Sky fill is warm-blue rather than the violet zenith, so shadowed faces stay
  // readable instead of going muddy under ACES tone mapping.
  const hemi = new THREE.HemisphereLight(0x9fc7ff, 0xd9c39a, p.hemiIntensity);
  scene.add(hemi);

  const ambient = new THREE.AmbientLight(horizon.getHex(), time === 'dusk' ? 0.25 : 0.45);
  scene.add(ambient);

  return { dome, sun, hemi, ambient, sunDir };
}

/** Keep the shadow frustum and sky dome centred on the camera each frame. */
export function updateSky(rig: SkyRig, focus: THREE.Vector3): void {
  rig.dome.position.set(focus.x, 0, focus.z);
  rig.sun.position.copy(focus).addScaledVector(rig.sunDir, 400);
  rig.sun.target.position.copy(focus);
  rig.sun.target.updateMatrixWorld();
}
