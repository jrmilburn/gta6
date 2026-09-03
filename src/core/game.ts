// Owns scene, renderer, the fixed-timestep loop and the ordered systems list.
import * as THREE from 'three';
import type { Renderable, System } from '../types';
import { CFG } from '../config';
import { Input } from './input';
import { Audio } from './audio';
import { EventBus } from './events';
import { param } from './rng';
import { buildSky, updateSky, type SkyRig, type TimeOfDay } from '../world/sky';
import { createPost, type PostChain } from './post';

const STEP = CFG.feel.loop.step;
const MAX_STEPS = CFG.feel.loop.maxSteps;
/**
 * Hard cap on how much wall time one frame is allowed to simulate. A tab switch
 * hands back a multi-second delta; without this the world jumps forward on the
 * first frame back (1.1).
 */
const MAX_FRAME = CFG.feel.loop.maxFrame;

const FORWARD = new THREE.Vector3();
const FOCUS = new THREE.Vector3();

export class Game {
  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly input = new Input();
  readonly audio = new Audio();
  readonly events = new EventBus();
  readonly systems: System[] = [];
  /**
   * Objects that write their meshes once per *rendered* frame, interpolating
   * between the previous and current physics state with `alpha`. Physics runs at
   * a fixed 60 Hz; writing a mesh straight from physics state inside step() is
   * what makes movement look stepped on any display that is not exactly 60 Hz.
   */
  readonly renderables: Renderable[] = [];
  readonly sky: SkyRig;
  readonly timeOfDay: TimeOfDay;
  /** Post chain; `?post=0` makes this a straight render to the canvas. */
  readonly post: PostChain;
  /** Interpolation alpha for the current render frame (0..1 between physics steps). */
  alpha = 0;
  time = 0;
  paused = false;
  /** Rolling fps sample the smoke test reads off window.__game. */
  fps = 0;

  private accumulator = 0;
  private last = 0;
  private frames = 0;
  private fpsClock = 0;

  constructor(mount: HTMLElement) {
    this.timeOfDay = param('time') === 'dusk' ? 'dusk' : 'day';

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    // The post chain renders the scene through several passes, and
    // WebGLRenderer.info resets itself on every one of them -- so the default
    // accounting reports the final fullscreen quad (1 draw call) instead of the
    // frame. Manual reset once per frame makes info.render.calls the honest
    // per-frame total, post passes included.
    this.renderer.info.autoReset = false;
    // `?shadows=0` drops the shadow pass. It re-renders every caster in the
    // world from the sun's point of view, which on a software rasteriser is
    // most of the frame -- and a test measuring the player's facing has no use
    // for it. Never a gameplay switch; a throughput one.
    this.renderer.shadowMap.enabled = param('shadows') !== '0';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(this.renderer.domElement);

    // Far plane has to reach the horizon from a 350 m drone shot; near stays as
    // tight as depth precision allows so kerbs and road markings don't z-fight.
    this.camera = new THREE.PerspectiveCamera(CFG.camera.fovBase, window.innerWidth / window.innerHeight, 0.4, 5000);
    this.camera.position.set(0, 12, 24);
    this.camera.lookAt(0, 1, 0);

    this.sky = buildSky(this.scene, this.timeOfDay);
    this.post = createPost(this.renderer, this.scene, this.camera, param('post') !== '0');

    this.input.onFirstKey = () => this.audio.resume();
    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('click', () => this.audio.resume(), { once: true });
  }

  add(system: System): void { this.systems.push(system); }

  addRenderable(r: Renderable): void { this.renderables.push(r); }

  removeRenderable(r: Renderable): void {
    const i = this.renderables.indexOf(r);
    if (i >= 0) this.renderables.splice(i, 1);
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.post.setSize(window.innerWidth, window.innerHeight);
  }

  start(): void {
    this.last = performance.now();
    const frame = (now: number) => {
      requestAnimationFrame(frame);
      // Two deltas. `elapsed` is how long the frame really took and is what the
      // fps counter must use: accumulating the CLAMPED delta makes the counter
      // saturate at 1 / MAX_FRAME (20) and report 20 fps for anything slower,
      // which is worse than useless. `wall` is the clamped one the simulation
      // and the smoothers see.
      const elapsed = (now - this.last) / 1000;
      const wall = Math.min(elapsed, MAX_FRAME);
      this.last = now;

      this.frames++;
      this.fpsClock += elapsed;
      if (this.fpsClock >= 0.5) {
        this.fps = this.frames / this.fpsClock;
        this.frames = 0;
        this.fpsClock = 0;
      }

      this.renderer.info.reset();
      if (this.input.justPressed('pause')) this.paused = !this.paused;

      if (!this.paused) {
        this.accumulator += wall;
        let steps = 0;
        while (this.accumulator >= STEP && steps < MAX_STEPS) {
          this.step(STEP);
          this.accumulator -= STEP;
          steps++;
        }
        if (steps === MAX_STEPS) this.accumulator = 0; // Don't spiral after a stall.
      }

      this.alpha = this.paused ? 1 : this.accumulator / STEP;
      // Interpolated render transforms, then anything that reads them (the
      // camera rig) -- both driven by wall time, not the fixed step.
      for (const r of this.renderables) r.renderSync(this.alpha, wall);
      // Spend the shadow map on the ground the camera is actually looking at.
      // Centring on the camera itself leaves half a drone shot unshadowed.
      this.camera.getWorldDirection(FORWARD);
      const drop = FORWARD.y < -0.05
        ? Math.min(-this.camera.position.y / FORWARD.y, 1400)
        : this.sky.extent * 0.45;
      FOCUS.copy(this.camera.position).addScaledVector(FORWARD, drop);
      FOCUS.y = 0;
      updateSky(this.sky, FOCUS, this.camera.position.y);
      this.post.render(this.scene, this.camera);
      this.input.endFrame();
    };
    requestAnimationFrame(frame);
  }

  private step(dt: number): void {
    this.time += dt;
    for (const s of this.systems) s.update(dt);
    this.input.endStep();
  }
}
