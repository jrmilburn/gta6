// What the combat system needs from the rest of the game, and what it hands
// back to the HUD.
//
// Split out of combat.ts purely for size. Keeping the shapes here also makes
// the coupling easy to audit at a glance: combat reaches for input, a rig, a
// list of pedestrians, a list of cars and the world's footprints, and nothing
// else.
import type * as THREE from 'three';
import type { EventName, Vec2 } from '../types';
import type { CharacterRig } from './characterRig';
import type { PedTarget } from './pedestrians';
import type { CombatVehicle } from './combatHits';

type CombatAction = 'forward' | 'back' | 'left' | 'right' | 'sprint' | 'arm';

export interface CombatHost {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  input: {
    isDown(a: CombatAction): boolean;
    justPressed(a: CombatAction): boolean;
    mouse: { left: boolean; right: boolean; leftPressed: boolean; locked: boolean };
  };
  events: { emit(evt: EventName, payload?: unknown): void };
  audio: { thud(impact: number): void; whoosh(): void; gunshot(): void };
  time: number;
}

export interface CombatDeps {
  player: {
    pos: Vec2; y: number; heading: number; speed: number;
    onFoot: boolean; onGround: boolean;
    faceCamera: boolean; speedCap: number;
  };
  rig: () => CharacterRig | null;
  look: { yaw: number; pitch: number };
  inVehicle: () => boolean;
  blocked: () => boolean;
  /** Live pedestrian handles, rebuilt each time it is called. */
  targets: () => PedTarget[];
  vehicles: readonly CombatVehicle[];
  /** World colliders, for stopping a bullet at a wall. */
  colliders: readonly { minX: number; minZ: number; maxX: number; maxZ: number }[];
  /** Camera pitch kick, applied by the rig. */
  kick: (radians: number) => void;
}

/** What the HUD needs to draw. */
export interface CombatState {
  armed: boolean;
  aiming: boolean;
  /** 0 holstered, 1 fully drawn; the draw and holster ease across it. */
  draw: number;
  shots: number;
}
