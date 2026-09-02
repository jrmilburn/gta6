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
  /** Current shadow-frustum half-width in metres. */
  extent: number;
}

/**
 * Azimuth the sun sits in. Straight down -Z (the beach side) hides every shadow
 * directly behind its own building when you look at the city from the water, so
 * the sun is skewed 30 degrees off to rake the shadows diagonally across the
 * street grid instead.
 */
export const SUN_AZIMUTH = -Math.PI * 2 / 3;

/** How far up the light rig sits. Also sets the shadow camera's depth range. */
const SUN_DIST = 600;

/**
 * three.js's DirectionalLightShadow never calls updateProjectionMatrix() itself,
 * so assigning left/right/top/bottom silently leaves the default 10 m frustum in
 * place and nothing larger than a car ever casts a shadow. The explicit call is
 * the whole point of this helper -- do not inline it away.
 */
function setShadowExtent(sun: THREE.DirectionalLight, half: number): void {
  const c = sun.shadow.camera;
  c.left = -half; c.right = half;
  c.top = half; c.bottom = -half;
  c.near = 1;
  c.far = SUN_DIST * 2 + half * 2;
  c.updateProjectionMatrix();
}

interface Palette { top: number; horizon: number; fog: number; sun: number; sunIntensity: number; hemiIntensity: number; elevation: number }

const PALETTES: Record<TimeOfDay, Palette> = {
  // Fill is deliberately low: at an 18 degree sun the ground only receives
  // sin(18) of it, so a bright hemisphere washes every cast shadow flat.
  day:  { top: CFG.colors.skyTop, horizon: CFG.colors.skyHorizon, fog: CFG.colors.fog, sun: CFG.colors.sun, sunIntensity: 2.8, hemiIntensity: 0.8, elevation: 18 },
  dusk: { top: 0x2a1a5e, horizon: 0xff7a4d, fog: 0xd98a76, sun: 0xffb070, sunIntensity: 1.9, hemiIntensity: 0.55, elevation: 7 },
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
export function buildSky(scene: THREE.Scene, time: TimeOfDay, beachAzimuth = SUN_AZIMUTH): SkyRig {
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
  sun.position.copy(sunDir).multiplyScalar(SUN_DIST);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.05;
  setShadowExtent(sun, 160);
  scene.add(sun);
  scene.add(sun.target);

  // Sky fill is warm-blue rather than the violet zenith, so shadowed faces stay
  // readable instead of going muddy under ACES tone mapping.
  const hemi = new THREE.HemisphereLight(0x9fc7ff, 0xd9c39a, p.hemiIntensity);
  scene.add(hemi);

  const ambient = new THREE.AmbientLight(horizon.getHex(), time === 'dusk' ? 0.18 : 0.25);
  scene.add(ambient);

  return { dome, sun, hemi, ambient, sunDir, extent: 160 };
}

/**
 * Keep the shadow frustum and sky dome on the action.
 *
 * `focus` is where the shadow detail is spent; `height` is how far the viewer is
 * above the ground. A street-level camera gets a tight, crisp frustum; a drone
 * at 350 m gets one wide enough to cover the skyline it can actually see.
 */
export function updateSky(rig: SkyRig, focus: THREE.Vector3, height = focus.y): void {
  rig.dome.position.set(focus.x, 0, focus.z);

  const want = THREE.MathUtils.clamp(90 + height * 2.2, 90, 900);
  // Snap so the extent only changes in steps; recompiling the projection every
  // frame would also make the shadow edges crawl as the camera moves.
  const stepped = Math.round(want / 60) * 60;
  if (stepped !== rig.extent) {
    setShadowExtent(rig.sun, stepped);
    rig.extent = stepped;
  }

  // Texel snapping: quantise the frustum centre to whole shadow-map texels so
  // shadow edges stop shimmering as the camera moves.
  const texel = (rig.extent * 2) / rig.sun.shadow.mapSize.x;
  const cx = Math.round(focus.x / texel) * texel;
  const cz = Math.round(focus.z / texel) * texel;

  rig.sun.target.position.set(cx, 0, cz);
  rig.sun.target.updateMatrixWorld();
  rig.sun.position.set(cx, 0, cz).addScaledVector(rig.sunDir, SUN_DIST);
  rig.sun.updateMatrixWorld();
}
