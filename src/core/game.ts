// Owns scene, renderer, the fixed-timestep loop and the ordered systems list.
import * as THREE from 'three';
import type { System } from '../types';
import { CFG } from '../config';
import { Input } from './input';
import { Audio } from './audio';
import { EventBus } from './events';
import { param } from './rng';
import { buildSky, updateSky, type SkyRig, type TimeOfDay } from '../world/sky';

const STEP = 1 / 60;
const MAX_STEPS = 5;

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
  readonly sky: SkyRig;
  readonly timeOfDay: TimeOfDay;
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
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(this.renderer.domElement);

    // Far plane has to reach the horizon from a 350 m drone shot; near stays as
    // tight as depth precision allows so kerbs and road markings don't z-fight.
    this.camera = new THREE.PerspectiveCamera(CFG.camera.fovBase, window.innerWidth / window.innerHeight, 0.4, 5000);
    this.camera.position.set(0, 12, 24);
    this.camera.lookAt(0, 1, 0);

    this.sky = buildSky(this.scene, this.timeOfDay);

    this.input.onFirstKey = () => this.audio.resume();
    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('click', () => this.audio.resume(), { once: true });
  }

  add(system: System): void { this.systems.push(system); }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  start(): void {
    this.last = performance.now();
    const frame = (now: number) => {
      requestAnimationFrame(frame);
      const wall = Math.min((now - this.last) / 1000, 0.25);
      this.last = now;

      this.frames++;
      this.fpsClock += wall;
      if (this.fpsClock >= 0.5) {
        this.fps = this.frames / this.fpsClock;
        this.frames = 0;
        this.fpsClock = 0;
      }

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

      this.alpha = this.accumulator / STEP;
      // Spend the shadow map on the ground the camera is actually looking at.
      // Centring on the camera itself leaves half a drone shot unshadowed.
      this.camera.getWorldDirection(FORWARD);
      const drop = FORWARD.y < -0.05
        ? Math.min(-this.camera.position.y / FORWARD.y, 1400)
        : this.sky.extent * 0.45;
      FOCUS.copy(this.camera.position).addScaledVector(FORWARD, drop);
      FOCUS.y = 0;
      updateSky(this.sky, FOCUS, this.camera.position.y);
      this.renderer.render(this.scene, this.camera);
      this.input.endFrame();
    };
    requestAnimationFrame(frame);
  }

  private step(dt: number): void {
    this.time += dt;
    for (const s of this.systems) s.update(dt);
  }
}
