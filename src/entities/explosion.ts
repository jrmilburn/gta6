// Explosions: what a rocket does when it arrives, and what a car does when it
// goes up.
//
// One pool of visuals -- a flash, a fireball of sprites, a shockwave ring on
// the ground -- and one blast rule applied to whatever is inside the radius:
// cars take damage and are shoved (and go up themselves a beat later, so a
// chain reads as a sequence rather than one frame), pedestrians drop, the
// player on foot is hurt, and everyone within earshot runs. The system listens
// for `exploded`, which a vehicle emits when it detonates, so a car blown up
// by a rocket and a car blown up by the car next to it look and behave the
// same way.
import * as THREE from 'three';
import { CFG } from '../config';
import type { EventName, Vec2 } from '../types';
import type { PedTarget } from './pedKnockdown';
import { puffTexture } from './vehicleSmoke';

const X = CFG.combat.explosion;
const FIREBALL = 28;
const LIFE = 0.9;
const POOL = 6;

/** A car as the blast sees it. */
export interface BlastVehicle {
  pos: Vec2;
  wrecked: boolean;
  /** Already gone up; a second blast does nothing more to it. */
  exploded: boolean;
  explode(delay: number): void;
  shove(x: number, z: number): void;
}

export interface BlastDeps {
  vehicles: () => readonly BlastVehicle[];
  targets: () => PedTarget[];
  /** Everyone within `radius` of a point runs from it. */
  alarm: (from: Vec2, radius: number) => void;
  player: { pos: Vec2; y: number; onFoot: boolean; damage(amount: number): void };
  /** Camera shake, 0..1. */
  shake: (amount: number) => void;
  audio: { explosion(distance: number): void };
  events: { emit(evt: EventName, payload?: unknown): void; on(evt: EventName, fn: (p: unknown) => void): void };
}

interface Burst {
  t: number;
  life: number;
  radius: number;
  origin: THREE.Vector3;
  flash: THREE.Mesh;
  ring: THREE.Mesh;
  fire: THREE.Points;
  vel: Float32Array;
}

export class Explosions {
  readonly group = new THREE.Group();
  private readonly pool: Burst[] = [];
  private readonly flashMat = new THREE.MeshBasicMaterial({
    color: 0xfff1c0, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  private readonly ringMat = new THREE.MeshBasicMaterial({
    color: 0xffb060, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  private readonly fireMat: THREE.PointsMaterial;
  private readonly sphere = new THREE.SphereGeometry(1, 16, 12);
  private readonly ringGeo = new THREE.RingGeometry(0.7, 1, 32);

  constructor(private readonly deps: BlastDeps) {
    this.group.name = 'explosions';
    this.fireMat = new THREE.PointsMaterial({
      map: puffTexture(), color: 0xffa040, size: 2.6, sizeAttenuation: true, transparent: true,
      opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
    });
    for (let i = 0; i < POOL; i++) this.pool.push(this.make());
    deps.events.on('exploded', (p) => {
      const e = p as { x?: number; z?: number; y?: number; radius?: number } | undefined;
      if (e?.x === undefined || e?.z === undefined) return;
      this.spawn(e.x, e.y ?? 0.8, e.z, e.radius ?? CFG.combat.weapons.rpg.projectile.radius);
    });
  }

  private make(): Burst {
    const flash = new THREE.Mesh(this.sphere, this.flashMat);
    flash.visible = false;
    const ring = new THREE.Mesh(this.ringGeo, this.ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(FIREBALL * 3), 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(FIREBALL * 3), 3));
    const fire = new THREE.Points(geo, this.fireMat);
    fire.visible = false;
    fire.frustumCulled = false;
    this.group.add(flash, ring, fire);
    return { t: 0, life: 0, radius: 0, origin: new THREE.Vector3(), flash, ring, fire, vel: new Float32Array(FIREBALL * 3) };
  }

  /** Detonate at a point: the visuals here, the consequences in `blast`. */
  spawn(x: number, y: number, z: number, radius: number): void {
    const b = this.pool.find((p) => p.life <= 0) ?? this.pool.reduce((a, p) => (p.t > a.t ? p : a));
    b.t = 0;
    b.life = LIFE;
    b.radius = radius;
    b.origin.set(x, y, z);
    b.flash.visible = true;
    b.flash.position.set(x, y + 0.5, z);
    b.flash.scale.setScalar(0.5);
    b.ring.visible = true;
    b.ring.position.set(x, 0.08, z);
    b.ring.scale.setScalar(0.5);
    b.fire.visible = true;
    const pos = b.fire.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = b.fire.geometry.getAttribute('color') as THREE.BufferAttribute;
    for (let i = 0; i < FIREBALL; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = 0.3 + Math.random() * 0.7;
      const r = Math.sqrt(1 - up * up) * (0.6 + Math.random() * 0.4);
      const s = 4 + Math.random() * 6;
      b.vel[i * 3] = Math.cos(a) * r * s;
      b.vel[i * 3 + 1] = up * s;
      b.vel[i * 3 + 2] = Math.sin(a) * r * s;
      pos.setXYZ(i, x + Math.cos(a) * r * 0.4, y + up * 0.4, z + Math.sin(a) * r * 0.4);
      col.setXYZ(i, 1, 0.55 + Math.random() * 0.3, 0.15);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.blast(x, y, z, radius);
  }

  private blast(x: number, _y: number, z: number, radius: number): void {
    const d = this.deps;
    const at = { x, z };
    let n = 0;
    for (const v of d.vehicles()) {
      if (v.exploded) continue;
      const dx = v.pos.x - x, dz = v.pos.z - z;
      const dist = Math.hypot(dx, dz);
      if (dist > radius) continue;
      const k = 1 - dist / radius;
      const nx = dist > 0.01 ? dx / dist : 1, nz = dist > 0.01 ? dz / dist : 0;
      v.shove(nx * X.shove * k, nz * X.shove * k);
      // Staggered so a row of cars goes up one after another.
      v.explode(X.chainDelay * (1 + n * 0.6 + Math.random() * 0.4));
      n++;
    }
    for (const t of d.targets()) {
      if (t.down) continue;
      if (Math.hypot(t.x - x, t.z - z) > radius) continue;
      t.knockDown(x, z);
    }
    const p = d.player;
    const pd = Math.hypot(p.pos.x - x, p.pos.z - z);
    if (p.onFoot && pd < X.playerRadius) p.damage(X.playerDamage * (1 - pd / X.playerRadius));
    d.alarm(at, X.alarmRadius);
    d.shake(Math.min(1, 14 / Math.max(3, pd)));
    d.audio.explosion(pd);
    d.events.emit('shotHit', { kind: 'explosion', x, z });
  }

  update(dt: number): void {
    for (const b of this.pool) {
      if (b.life <= 0) continue;
      b.t += dt;
      const u = b.t / LIFE;
      if (u >= 1) {
        b.life = 0;
        b.flash.visible = b.ring.visible = b.fire.visible = false;
        continue;
      }
      // The flash is over in the first sixth; the ring runs out over half.
      const fl = Math.max(0, 1 - u * 6);
      b.flash.visible = fl > 0;
      b.flash.scale.setScalar(b.radius * 0.35 * (1 + (1 - fl) * 2));
      (b.flash.material as THREE.MeshBasicMaterial).opacity = fl * 0.9;
      const rg = Math.min(1, u * 2);
      b.ring.visible = rg < 1;
      b.ring.scale.setScalar(0.5 + b.radius * 1.4 * rg);
      (b.ring.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - rg);
      // Fireball: up and out, slowing, fading from orange to grey.
      const pos = b.fire.geometry.getAttribute('position') as THREE.BufferAttribute;
      const col = b.fire.geometry.getAttribute('color') as THREE.BufferAttribute;
      const drag = Math.max(0, 1 - dt * 2.2);
      for (let i = 0; i < FIREBALL; i++) {
        b.vel[i * 3] *= drag; b.vel[i * 3 + 2] *= drag;
        b.vel[i * 3 + 1] = b.vel[i * 3 + 1] * drag + 1.5 * dt;
        pos.setXYZ(i,
          pos.getX(i) + b.vel[i * 3] * dt,
          pos.getY(i) + b.vel[i * 3 + 1] * dt,
          pos.getZ(i) + b.vel[i * 3 + 2] * dt);
        const g = 0.25 + u * 0.3;
        col.setXYZ(i, (1 - u) * 1 + u * g, (1 - u) * 0.6 + u * g, (1 - u) * 0.15 + u * g);
      }
      pos.needsUpdate = true;
      col.needsUpdate = true;
      this.fireMat.opacity = 0.95 * (1 - u * u);
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const b of this.pool) b.fire.geometry.dispose();
    this.flashMat.dispose(); this.ringMat.dispose(); this.fireMat.dispose();
    this.sphere.dispose(); this.ringGeo.dispose();
  }
}
