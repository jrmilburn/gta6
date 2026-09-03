// Officers on foot (refinement pass): at three stars and up, a cruiser that
// stops near a player on foot lets an officer out. They run to a dozen metres,
// take a sight picture, and fire -- each shot a roll against distance, each hit
// a bite out of the player's health. The player can knock them down like
// anyone else; nobody dies, and an officer who is left behind walks back to
// the car.
//
// Officers are the hero's own rig in a navy uniform with the pistol in hand,
// six of them at most. Without a supplied character there are no officers:
// the procedural humanoid has no aim clip, and a box shooting at you is not
// a threat, it is a bug.
import * as THREE from 'three';
import type { EventName, System, Vec2 } from '../types';
import { CFG } from '../config';
import { Rng } from '../core/rng';
import { findBone, type CharacterSource } from '../core/character';
import { CharacterRig } from './characterRig';
import { buildPaletteMaterials, buildUniformPalette } from './pedVariants';
import { buildPistol, fitPistolToHand, ShotEffects, type PistolParts } from './pistol';
import type { PedTarget } from './pedKnockdown';
import type { Vehicle } from './vehicle';

const P = CFG.police;
const RUN_SPEED = 4.6;
const WALK_SPEED = 1.6;
/** Where they stop to shoot from. */
const ENGAGE_NEAR = 9;
const ENGAGE_FAR = 14;
/** Beyond this, or out of sight this long, they give up and go back. */
const GIVE_UP_DIST = 50;
const GIVE_UP_HIDDEN = 6;
/** A hit is this likely point blank, fading with range. */
const HIT_MAX = 0.85;
const HIT_MIN = 0.25;
const HIT_RANGE = 40;
/** Seconds down after a punch or a shot, then they get up and carry on. */
const DOWN_SECONDS = 30;
const STRAFE_SECONDS = 1.6;
const TURN_RATE = 5;
const OFFICER_HEIGHT = 1.8;

type State = 'out' | 'approach' | 'engage' | 'return' | 'down';

interface Officer {
  rig: CharacterRig;
  pistol: PistolParts;
  state: State;
  pos: Vec2;
  y: number;
  heading: number;
  speed: number;
  car: Vehicle | null;
  fireIn: number;
  hidden: number;
  downT: number;
  fallClip: string | null;
  strafeDir: number;
  strafeIn: number;
  active: boolean;
}

export interface OfficerHost {
  scene: THREE.Scene;
  time: number;
  events: { emit(evt: EventName, payload?: unknown): void };
  audio: { gunshot(): void };
}

export interface OfficerDeps {
  player: { pos: Vec2; y: number; onFoot: boolean; health: number; damage(amount: number): void };
  /** Cruisers that have just stopped beside the player, from police.ts. */
  requests: () => readonly Vehicle[];
  stars: () => number;
  clearLine: (a: Vec2, b: Vec2) => boolean;
  groundAt: (x: number, z: number) => number;
  /** A full-screen state owns the frame: no shooting under a BUSTED card. */
  blocked: () => boolean;
}

const V = new THREE.Vector3();
const HIT = new THREE.Vector3();

export class OfficerSystem implements System {
  readonly group = new THREE.Group();
  private readonly officers: Officer[] = [];
  private readonly effects: ShotEffects;
  private readonly rng = new Rng(777);
  private readonly falls: string[];
  /** Shots fired at the player, for the tests. */
  shots = 0;

  constructor(
    private readonly host: OfficerHost,
    source: CharacterSource,
    private readonly deps: OfficerDeps,
  ) {
    this.group.name = 'officers';
    host.scene.add(this.group);
    this.effects = new ShotEffects();
    this.group.add(this.effects.group);
    this.falls = source.byRole('many').filter((n) => n.startsWith('fall'));

    // The uniform: everything that is not skin or hair pushed to navy.
    const uniform = buildUniformPalette(source.albedo, 0.62, 0.45, 0.55);
    const materials = uniform ? buildPaletteMaterials(source, [uniform])[0] : undefined;

    for (let i = 0; i < P.officers; i++) {
      const rig = new CharacterRig(source, { materials, phaseOffset: (i * 0.37) % 1, castShadow: true });
      rig.group.visible = false;
      this.group.add(rig.group);
      const pistol = buildPistol();
      const hand = findBone(rig.root, 'RightHand');
      if (hand) {
        hand.add(pistol.group);
        fitPistolToHand(pistol.group, hand, findBone(rig.root, 'RightForeArm'), findBone(rig.root, 'RightHandMiddle1'));
      }
      pistol.group.visible = true;
      this.officers.push({
        rig, pistol, state: 'out', pos: { x: 0, z: 0 }, y: 0, heading: 0, speed: 0, car: null,
        fireIn: 1, hidden: 0, downT: 0, fallClip: null, strafeDir: 1, strafeIn: 0, active: false,
      });
    }
  }

  /** How many officers are out of their cars. */
  get active(): number { return this.officers.filter((o) => o.active).length; }

  /** Positions, for the crowd to flee and the minimap. */
  positions(): Vec2[] {
    return this.officers.filter((o) => o.active).map((o) => o.pos);
  }

  /** Targets for the player's fists and pistol. */
  targets(): PedTarget[] {
    return this.officers.filter((o) => o.active).map((o) => ({
      x: o.pos.x, y: o.y, z: o.pos.z,
      height: o.state === 'down' ? 0 : OFFICER_HEIGHT,
      down: o.state === 'down',
      knockDown: (fromX: number, fromZ: number) => this.knockDown(o, fromX, fromZ),
    }));
  }

  /** Everyone back in the cars: a bust, a respawn, the heat gone. */
  standDown(): void {
    for (const o of this.officers) this.retire(o);
  }

  private retire(o: Officer): void {
    o.active = false;
    o.car = null;
    o.rig.group.visible = false;
    o.rig.overlay.stop();
    o.rig.oneShot.stop();
    o.state = 'out';
  }

  private knockDown(o: Officer, fromX: number, fromZ: number): void {
    if (o.state === 'down') return;
    o.heading = Math.atan2(o.pos.x - fromX, o.pos.z - fromZ);
    o.state = 'down';
    o.downT = 0;
    o.speed = 0;
    o.fallClip = this.falls.length ? this.falls[this.rng.int(0, this.falls.length - 1)] : null;
    o.rig.overlay.stop();
    if (o.fallClip) o.rig.playOneShot(o.fallClip, { blendIn: 0.12, blendOut: 0.2, hold: true });
  }

  update(dt: number): void {
    this.effects.update(dt);
    const stars = this.deps.stars();
    if (stars < P.officerStars) {
      for (const o of this.officers) if (o.active && o.state !== 'down') this.retire(o);
    } else {
      this.deploy();
    }
    for (const o of this.officers) {
      if (!o.active) continue;
      this.step(o, dt);
      this.draw(o, dt);
    }
  }

  /** One officer per stopped cruiser that has none yet. */
  private deploy(): void {
    if (!this.deps.player.onFoot) return;
    for (const car of this.deps.requests()) {
      if (this.officers.some((o) => o.active && o.car === car)) continue;
      const free = this.officers.find((o) => !o.active);
      if (!free) return;
      free.active = true;
      free.car = car;
      free.state = 'approach';
      // Out of the driver's door: left of the car's nose.
      free.pos.x = car.pos.x - car.forwardZ * 1.6;
      free.pos.z = car.pos.z + car.forwardX * 1.6;
      free.y = this.deps.groundAt(free.pos.x, free.pos.z);
      free.heading = car.heading;
      free.speed = 0;
      free.fireIn = 1.2;
      free.hidden = 0;
      free.rig.group.visible = true;
      free.rig.locomotion.armed = true;
    }
  }

  private step(o: Officer, dt: number): void {
    const p = this.deps.player;
    const dx = p.pos.x - o.pos.x, dz = p.pos.z - o.pos.z;
    const dist = Math.hypot(dx, dz);
    const seen = this.deps.clearLine(o.pos, p.pos);
    o.hidden = seen ? 0 : o.hidden + dt;

    if (o.state === 'down') {
      o.downT += dt;
      o.speed = 0;
      if (o.downT > DOWN_SECONDS) {
        o.rig.oneShot.stop();
        o.state = 'return';
      }
      return;
    }

    // Lost them, or the player drove off: back to the car.
    if (o.state !== 'return' && (dist > GIVE_UP_DIST || o.hidden > GIVE_UP_HIDDEN || !p.onFoot)) {
      o.state = 'return';
      o.rig.overlay.stop();
    }

    if (o.state === 'return') {
      const car = o.car;
      if (!car || car.wrecked) { this.retire(o); return; }
      const cx = car.pos.x - o.pos.x, cz = car.pos.z - o.pos.z;
      const cd = Math.hypot(cx, cz);
      if (cd < 2.2) { this.retire(o); return; }
      this.move(o, cx / cd, cz / cd, WALK_SPEED, dt);
      // Seeing the player again on the way back is enough to come back out.
      if (seen && dist < ENGAGE_FAR && p.onFoot) o.state = 'engage';
      return;
    }

    if (o.state === 'approach') {
      if (dist <= ENGAGE_FAR && seen) { o.state = 'engage'; o.strafeIn = 0; }
      else this.move(o, dx / dist, dz / dist, RUN_SPEED, dt);
      return;
    }

    // engage: hold the range, strafe a little, and shoot.
    this.turnTo(o, Math.atan2(dx, dz), dt);
    if (dist > ENGAGE_FAR + 2) { this.move(o, dx / dist, dz / dist, WALK_SPEED, dt); }
    else if (dist < ENGAGE_NEAR - 2) { this.move(o, -dx / dist, -dz / dist, WALK_SPEED, dt, false); }
    else {
      o.strafeIn -= dt;
      if (o.strafeIn <= 0) { o.strafeDir = this.rng.chance(0.5) ? 1 : -1; o.strafeIn = STRAFE_SECONDS + this.rng.range(0, 1.2); }
      const rx = dz / dist, rz = -dx / dist;
      this.move(o, rx * o.strafeDir, rz * o.strafeDir, WALK_SPEED * 0.6, dt, false);
    }
    o.fireIn -= dt;
    if (o.fireIn <= 0 && seen && !this.deps.blocked()) {
      o.fireIn = P.officerFireInterval + this.rng.range(-0.2, 0.3);
      this.fire(o, dist);
    }
  }

  private move(o: Officer, nx: number, nz: number, speed: number, dt: number, face = true): void {
    o.speed = speed;
    o.pos.x += nx * speed * dt;
    o.pos.z += nz * speed * dt;
    o.y = this.deps.groundAt(o.pos.x, o.pos.z);
    if (face) this.turnTo(o, Math.atan2(nx, nz), dt);
  }

  private turnTo(o: Officer, want: number, dt: number): void {
    let d = want - o.heading;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const step = TURN_RATE * dt;
    o.heading += Math.abs(d) <= step ? d : Math.sign(d) * step;
  }

  /** One shot at the player: a roll against range, a tracer either way. */
  private fire(o: Officer, dist: number): void {
    const p = this.deps.player;
    this.shots++;
    const chance = THREE.MathUtils.clamp(1 - dist / HIT_RANGE, HIT_MIN, HIT_MAX);
    const hit = this.rng.next() < chance;
    o.pistol.muzzle.getWorldPosition(V);
    HIT.set(p.pos.x, p.y + 1.1, p.pos.z);
    if (!hit) {
      // A miss goes past, a little wide.
      HIT.x += this.rng.range(-1.2, 1.2);
      HIT.y += this.rng.range(-0.4, 0.8);
      HIT.z += this.rng.range(-1.2, 1.2);
    }
    this.effects.tracerTo(V, HIT);
    o.pistol.flash.visible = true;
    o.fireIn = Math.max(o.fireIn, 0.08);
    this.host.audio.gunshot();
    if (o.rig.has('pistolFire')) o.rig.playOverlay('pistolFire', { blendIn: 0.04, blendOut: 0.1, hold: true });
    if (hit) p.damage(P.officerDamage);
    this.host.events.emit('officerShot', { hit, x: o.pos.x, z: o.pos.z });
  }

  private draw(o: Officer, dt: number): void {
    const g = o.rig.group;
    g.position.set(o.pos.x, o.y, o.pos.z);
    g.rotation.y = o.heading;
    // The muzzle flash is a few frames long.
    if (o.pistol.flash.visible && o.fireIn < P.officerFireInterval - 0.08) o.pistol.flash.visible = false;
    if (o.state === 'engage' && !o.rig.overlay.running) {
      const aim = o.rig.has('pistolAim') ? 'pistolAim' : o.rig.has('pistolIdle') ? 'pistolIdle' : null;
      if (aim && o.rig.overlay.clip !== aim) o.rig.playOverlay(aim, { blendIn: 0.2, blendOut: 0.2, hold: true, loop: true });
      o.rig.setAim(1, 0);
    } else if (o.state !== 'engage') {
      o.rig.setAim(0, 0);
    }
    o.rig.update({
      dt, time: this.host.time, speed: o.state === 'down' ? 0 : o.speed, turnRate: 0,
      grounded: true, airborne: false, crouch: 0, opacity: 1,
    });
  }

  dispose(): void {
    for (const o of this.officers) o.rig.dispose();
    this.effects.dispose();
    this.group.removeFromParent();
  }
}
