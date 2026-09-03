// Knocking a civilian over, and getting them back up (section 8).
//
// Split out of pedestrians.ts, which is otherwise a wander/cross/flee state
// machine. Everything here is about the one mode that is not navigation.
//
// No blood, no gore, nothing dies. A pedestrian who is hit falls over, lies
// still for a minute, retraces the fall backwards to stand, and walks off.
import { CFG } from '../config';
import type { Vec2 } from '../types';
import type { PedRenderer } from './pedRenderer';

const K = CFG.combat.knockdown;
/** Standing height of a pedestrian at scale 1, for the shot hit test. */
const PED_HEIGHT = 1.8;

/** The subset of a pedestrian a knockdown touches. */
export interface Downable {
  pos: Vec2;
  y: number;
  scale: number;
  heading: number;
  speed: number;
  mode: string;
  downT: number;
  fallClip: string | null;
  fallRate: number;
}

/** What combat.ts is allowed to know about a pedestrian. */
export interface PedTarget {
  x: number;
  y: number;
  z: number;
  /** Standing height. Zero once they are down, so they stop being a target. */
  height: number;
  down: boolean;
  knockDown(fromX: number, fromZ: number): void;
}

export function makeTarget(p: Downable, onDown: () => void): PedTarget {
  return {
    x: p.pos.x,
    y: p.y,
    z: p.pos.z,
    height: p.mode === 'down' ? 0 : PED_HEIGHT * p.scale,
    down: p.mode === 'down',
    knockDown: (fromX: number, fromZ: number) => knockDownPed(p, fromX, fromZ, onDown),
  };
}

/**
 * Put one pedestrian on the ground, facing away from whoever hit them.
 *
 * The fall clips carry their own travel, so the body pitches forward as it goes
 * down rather than folding on the spot -- which is why `stepDown` leaves the
 * position alone and lets the animation own it.
 */
export function knockDownPed(
  p: Downable, fromX: number, fromZ: number, onDown: () => void,
): void {
  if (p.mode === 'down') return;
  const away = Math.atan2(p.pos.x - fromX, p.pos.z - fromZ);
  p.heading = Number.isFinite(away) ? away : p.heading;
  p.mode = 'down';
  p.speed = 0;
  p.downT = 0;
  p.fallRate = 1;
  p.fallClip = null;
  onDown();
}

/**
 * Lie still, then get up -- or be recycled, if the player is long gone.
 *
 * The get-up is the fall clip run backwards at double speed, which stands
 * better than anything in the set and needs no extra download: the body
 * retraces exactly the way it went down.
 */
export function stepDown(
  p: Downable, dt: number, player: Vec2,
  canDespawn: () => boolean, recycle: () => void, resume: () => void, renderer: PedRenderer,
): void {
  p.downT += dt;
  p.speed = 0;
  // The renderer owns which clip; asking it here keeps the choice with the
  // thing that knows whether there are any clips at all.
  if (p.fallClip === null && p.fallRate > 0 && renderer.pickFall) {
    p.fallClip = renderer.pickFall();
  }
  if (p.fallRate > 0 && p.downT >= K.downSeconds) {
    // Far away AND off screen: the body may leave. In view, it gets up.
    if (Math.hypot(p.pos.x - player.x, p.pos.z - player.z) > K.despawnDistance && canDespawn()) {
      recycle();
      return;
    }
    p.fallRate = -K.getUpRate;
  }
  const duration = p.fallClip && renderer.clipDuration ? renderer.clipDuration(p.fallClip) : 2;
  if (p.fallRate < 0 && p.downT >= K.downSeconds + duration / K.getUpRate) {
    p.fallClip = null;
    p.fallRate = 1;
    resume();
  }
}
