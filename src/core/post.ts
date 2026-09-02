// Post-processing chain (realism pass 2.1): render -> ambient occlusion ->
// bloom -> output.
//
// `?post=0` skips the whole thing and renders straight to the canvas, which is
// the fps fallback and also the honest A/B for judging whether the chain is
// earning its cost.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';

/** Sun-bleached, not neon: enough bloom to bloom a sunset, not to smear it. */
const BLOOM_STRENGTH = 0.25;
const BLOOM_RADIUS = 0.5;
const BLOOM_THRESHOLD = 0.9;

export interface PostChain {
  readonly enabled: boolean;
  /**
   * Draw calls in the *scene* pass alone.
   *
   * The chain re-renders the scene for its depth/normal prepass, so
   * renderer.info counts the world's geometry more than once per frame. That
   * total is the honest cost and is reported separately; this is the number the
   * world-complexity budget is about.
   */
  readonly sceneCalls: number;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  setSize(w: number, h: number): void;
  dispose(): void;
}

/** Straight-to-canvas fallback with the same interface. */
function plain(renderer: THREE.WebGLRenderer): PostChain {
  let calls = 0;
  return {
    enabled: false,
    get sceneCalls() { return calls; },
    render(scene, camera) {
      renderer.render(scene, camera);
      calls = renderer.info.render.calls;
    },
    setSize: (w, h) => renderer.setSize(w, h),
    dispose: () => {},
  };
}

/**
 * A no-op composer pass that reads renderer.info as the chain runs past it.
 * Placed straight after the RenderPass, it captures the scene's own draw-call
 * count before any prepass has had a chance to inflate it.
 */
function probePass(renderer: THREE.WebGLRenderer, onSample: (calls: number) => void): {
  enabled: boolean; needsSwap: boolean;
  setSize(w: number, h: number): void;
  render(): void;
  dispose(): void;
} {
  return {
    enabled: true,
    needsSwap: false,
    setSize(): void {},
    render(): void { onSample(renderer.info.render.calls); },
    dispose(): void {},
  };
}

export function createPost(
  renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera,
  enabled: boolean,
): PostChain {
  if (!enabled) return plain(renderer);

  const size = new THREE.Vector2();
  renderer.getSize(size);
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(size.x, size.y);

  composer.addPass(new RenderPass(scene, camera));

  let sceneCalls = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal Pass shape
  composer.addPass(probePass(renderer, (c) => { sceneCalls = c; }) as any);

  // DECISION: GTAOPass over SSAOPass. Both need the scene's depth and normals,
  // but SSAOPass renders the scene three times to get them (beauty, depth,
  // normal) and pushed the frame from 243 draw calls to 744. GTAO gets both out
  // of one prepass, and its horizon-search AO is the better-looking of the two
  // into the bargain. The radius is short (0.5 m) so it darkens kerbs, doorways
  // and the ground under parked cars instead of haloing whole towers.
  const gtao = new GTAOPass(scene, camera, size.x, size.y);
  gtao.updateGtaoMaterial({
    radius: 0.5,
    distanceExponent: 1.2,
    thickness: 1.0,
    scale: 1.0,
    samples: 12,
  });
  gtao.blendIntensity = 0.85;
  composer.addPass(gtao);

  composer.addPass(new UnrealBloomPass(
    new THREE.Vector2(size.x, size.y), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD,
  ));

  // OutputPass owns the tone mapping and sRGB conversion once the chain is on;
  // leaving it to the renderer would tone-map before the bloom instead of after.
  composer.addPass(new OutputPass());

  return {
    enabled: true,
    get sceneCalls() { return sceneCalls; },
    render: () => composer.render(),
    setSize(w: number, h: number): void {
      renderer.setSize(w, h);
      composer.setSize(w, h);
    },
    dispose(): void { composer.dispose(); },
  };
}
