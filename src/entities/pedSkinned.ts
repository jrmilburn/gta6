// Pedestrians on the hero's own rig (integration pass, section 5).
//
// A crowd of eighty full skeletons is not affordable, and a crowd of eighty
// frozen statues is not alive, so the pool runs both: the sixteen nearest the
// camera get a real SkinnedMesh and their own mixer, and everyone else is a
// baked mid-stride pose in an InstancedMesh. The swap has a hysteresis band
// around it, so a pedestrian walking the boundary does not flicker between
// representations.
import * as THREE from 'three';
import type { Vec2 } from '../types';
import { CFG } from '../config';
import type { CharacterSource } from '../core/character';
import { CharacterRig } from './characterRig';
import { tumbleQuat, bodyQuat, type PosablePed } from './pedPose';
import type { PedRenderer } from './pedRenderer';
import {
  bakeStaticPose, buildPalettes, buildPaletteMaterials,
  PED_VARIANT_COUNT, type BakedPart,
} from './pedVariants';

const A = CFG.anim;
/** Longest a pedestrian waits before joining the player's dance. */
const JOIN_DELAY = 1;

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const V = new THREE.Vector3();
const S = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

interface Slot {
  rig: CharacterRig;
  /** Which fall clip this rig is currently playing, if any. */
  falling: string | null;
  /** Which pedestrian owns this rig, as variant * 1000 + slot. Null if free. */
  owner: number | null;
  variant: number;
  /** Seconds left before this pedestrian joins a dance already in progress. */
  joinIn: number;
  dancing: boolean;
}

/** Everything the pool needs from outside: where the camera is, and the clock. */
export interface SkinnedPedHost {
  cameraPosition: THREE.Vector3;
  time: number;
}

export class SkinnedPedRenderer implements PedRenderer {
  readonly group = new THREE.Group();

  private readonly slots: Slot[] = [];
  private readonly statics: THREE.InstancedMesh[][] = [];
  private readonly counts: number[] = [];
  private readonly palettes: Array<Map<string, THREE.Material>>;
  private readonly parts: BakedPart[];
  private readonly owned: Array<{ dispose(): void }> = [];
  private readonly host: SkinnedPedHost;
  private readonly source: CharacterSource;
  /** Every clip tagged as a knockdown by the converter. */
  private readonly falls: string[];
  private readonly capacity: number;
  /** This frame's pedestrians, buffered so commit() can rank them by distance. */
  private frame: Array<{ p: PosablePed; dist: number }> = [];
  private dt = 1 / 60;
  private danceCentre: Vec2 | null = null;
  private danceRadius = 0;

  constructor(source: CharacterSource, count: number, host: SkinnedPedHost) {
    this.host = host;
    this.source = source;
    this.falls = source.byRole('many').filter((n) => n.startsWith('fall'));
    this.group.name = 'pedestrians';
    this.capacity = Math.ceil(count / PED_VARIANT_COUNT);

    const textures = buildPalettes(source.albedo);
    // A tainted canvas or a missing albedo leaves no palettes at all. One empty
    // map keeps the modulo arithmetic below meaningful: the crowd is then every
    // pedestrian in the hero's own colours, which is worse-looking and still
    // correct, rather than a NaN variant index.
    const built = buildPaletteMaterials(source, textures);
    this.palettes = built.length > 0 ? built : [new Map<string, THREE.Material>()];
    for (const t of textures) this.owned.push(t);
    for (const p of this.palettes) for (const m of p.values()) this.owned.push(m);

    this.parts = bakeStaticPose(source);
    for (const part of this.parts) this.owned.push(part.geometry);

    for (let v = 0; v < PED_VARIANT_COUNT; v++) {
      const row: THREE.InstancedMesh[] = [];
      for (const part of this.parts) {
        const material = this.palettes[v]?.get(part.material);
        if (!material) continue;
        const mesh = new THREE.InstancedMesh(part.geometry, material, this.capacity);
        mesh.count = this.capacity;
        // Plan section 0.6: no shadow casting from instanced crowd geometry.
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        for (let i = 0; i < this.capacity; i++) mesh.setMatrixAt(i, HIDDEN);
        this.group.add(mesh);
        row.push(mesh);
      }
      this.statics.push(row);
      this.counts.push(0);
    }

    for (let i = 0; i < A.skinnedPeds; i++) {
      const rig = new CharacterRig(source, {
        materials: this.palettes[i % this.palettes.length],
        // Staggered clip offsets: sixteen people stepping off on the same foot
        // at the same instant is the one thing a crowd never does.
        phaseOffset: (i * 0.618) % 1,
        castShadow: false,
      });
      rig.group.visible = false;
      this.group.add(rig.group);
      this.slots.push({
        rig, owner: null, variant: i % this.palettes.length, joinIn: 0, dancing: false,
        falling: null,
      });
    }
  }

  variantFor(i: number): number { return i % PED_VARIANT_COUNT; }
  slotFor(i: number): number { return Math.floor(i / PED_VARIANT_COUNT); }

  begin(): void {
    this.frame.length = 0;
    for (let i = 0; i < this.counts.length; i++) this.counts[i] = 0;
  }

  pose(p: PosablePed, dt: number): void {
    this.dt = dt;
    p.phase += dt;
    const cam = this.host.cameraPosition;
    this.frame.push({ p, dist: Math.hypot(p.pos.x - cam.x, p.pos.z - cam.z) });
  }

  /** One of the supplied knockdown clips, at random. */
  pickFall(): string | null {
    if (this.falls.length === 0) return null;
    return this.falls[Math.floor(Math.random() * this.falls.length)];
  }

  clipDuration(name: string): number { return this.source.info.get(name)?.duration ?? 2; }

  get dancing(): number {
    return this.slots.reduce((n, s) => n + (s.dancing ? 1 : 0), 0);
  }

  /** How many pedestrians currently have a skeleton of their own. */
  get skinned(): number {
    return this.slots.reduce((n, s) => n + (s.owner !== null ? 1 : 0), 0);
  }

  setDance(centre: Vec2 | null, radius: number): void {
    // Re-roll the joining delays on the frame the dance starts, not when a rig
    // was handed out: a pedestrian who happened to be near the camera an hour
    // ago would otherwise have a stale delay of zero and join on the same frame
    // as the player, which is the one thing a crowd never does.
    if (centre !== null && this.danceCentre === null) {
      for (const slot of this.slots) slot.joinIn = Math.random() * JOIN_DELAY;
    }
    this.danceCentre = centre;
    this.danceRadius = radius;
  }

  commit(): void {
    this.assign();
    for (const slot of this.slots) if (slot.owner === null) slot.rig.group.visible = false;

    const taken = new Set(this.slots.map((s) => s.owner).filter((o) => o !== null));
    for (const entry of this.frame) {
      const id = key(entry.p);
      if (taken.has(id)) this.drawSkinned(entry.p, id);
      else this.drawStatic(entry.p);
    }

    for (let v = 0; v < this.statics.length; v++) {
      for (const mesh of this.statics[v]) {
        // Everything past this frame's count is left hidden rather than
        // reallocated: count is capped at capacity, and a stale matrix on an
        // unused slot would draw last frame's pedestrian at full size.
        for (let i = this.counts[v]; i < this.capacity; i++) mesh.setMatrixAt(i, HIDDEN);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /**
   * Hand the rigs to the nearest pedestrians.
   *
   * A rig is only taken away when its pedestrian passes `skinnedOut`; a free rig
   * is only given out inside `skinnedIn`. The gap between the two is what stops
   * a pedestrian on the boundary swapping representation every frame.
   */
  private assign(): void {
    const byId = new Map<number, number>(); // pedestrian id -> distance
    for (const e of this.frame) byId.set(key(e.p), e.dist);

    // A pedestrian on the ground keeps its rig however far away it is: the fall
    // clip is the only thing holding it in that pose, and taking the skeleton
    // away mid-knockdown would stand it back up as a static walking statue.
    const downed = new Set(this.frame.filter((e) => e.p.mode === 'down').map((e) => key(e.p)));
    for (const slot of this.slots) {
      if (slot.owner === null) continue;
      const d = byId.get(slot.owner);
      const keep = downed.has(slot.owner) && d !== undefined;
      if (!keep && (d === undefined || d > A.skinnedOut)) this.release(slot);
    }

    const held = new Set(this.slots.map((s) => s.owner));
    const free = this.slots.filter((s) => s.owner === null);
    if (free.length === 0) return;

    // Section 8: a static pedestrian that gets shot is promoted rather than
    // ignored, so it sorts ahead of everyone by distance.
    const candidates = this.frame
      .filter((e) => (e.p.mode === 'down' || e.dist < A.skinnedIn) && !held.has(key(e.p)))
      .sort((a, b) => (Number(b.p.mode === 'down') - Number(a.p.mode === 'down')) || (a.dist - b.dist))
      .slice(0, free.length);

    candidates.forEach((e, i) => {
      const slot = free[i];
      const variant = e.p.variant % this.palettes.length;
      if (variant !== slot.variant) {
        slot.rig.setPalette(this.palettes[variant]);
        slot.variant = variant;
      }
      slot.owner = key(e.p);
      slot.joinIn = this.danceCentre ? Math.random() * JOIN_DELAY : 0;
      slot.dancing = false;
      slot.rig.group.visible = true;
    });
  }

  private release(slot: Slot): void {
    slot.owner = null;
    slot.dancing = false;
    slot.falling = null;
    slot.rig.stopDance();
    slot.rig.group.visible = false;
  }

  private drawSkinned(p: PosablePed, id: number): void {
    const slot = this.slots.find((s) => s.owner === id);
    if (!slot) return;
    const g = slot.rig.group;

    this.stepFall(slot, p);
    const tumbling = tumbleQuat(p, Q);
    slot.rig.frozen = tumbling;
    let heading = p.heading;
    if (this.stepDance(slot, p)) {
      // Face the player while dancing, so the crowd plays to the camera.
      const c = this.danceCentre as Vec2;
      heading = Math.atan2(c.x - p.pos.x, c.z - p.pos.z);
    }
    if (!tumbling) Q.setFromAxisAngle(UP, heading);

    g.position.set(p.pos.x, p.y, p.pos.z);
    g.quaternion.copy(Q);
    g.scale.setScalar(p.scale);
    slot.rig.update({
      dt: this.dt,
      time: this.host.time + p.phase,
      speed: p.speed,
      turnRate: p.turnRate ?? 0,
      grounded: true,
      airborne: false,
      crouch: 0,
      opacity: 1,
    });
  }

  /**
   * Start, reverse or end the knockdown clip on this rig.
   *
   * The fall plays once and clamps on its last frame, which is the body lying
   * still. The get-up is the same clip at a negative rate: the body retraces
   * exactly the way it went down, which stands better than anything in the set
   * and needs no extra download.
   */
  private stepFall(slot: Slot, p: PosablePed): void {
    const want = p.mode === 'down' ? p.fallClip : null;
    if (want === null) {
      if (slot.falling) { slot.rig.oneShot.stop(); slot.falling = null; }
      return;
    }
    if (slot.falling === want && Math.sign(slot.rig.oneShot.action?.timeScale ?? 1) === Math.sign(p.fallRate)) {
      return;
    }
    const reversing = p.fallRate < 0;
    slot.rig.playOneShot(want, {
      blendIn: reversing ? 0.1 : 0.12,
      blendOut: 0.2,
      timeScale: p.fallRate,
      // Held: the body stays on the last frame, face down, until it is told to
      // get up. Without this the clip would fade out and the pedestrian would
      // stand back into the walk cycle after two seconds.
      hold: !reversing,
      // Reversed, the clip has to start at its end or there is nothing behind
      // the playhead to play.
      from: reversing ? slot.rig.durationOf(want) - 1e-3 : 0,
    });
    slot.falling = want;
  }

  /** Returns true while this pedestrian is dancing along with the player. */
  private stepDance(slot: Slot, p: PosablePed): boolean {
    const centre = this.danceCentre;
    // Nobody dances off the floor: a knocked-down or tumbling pedestrian keeps
    // its own animation until it has stood back up.
    const near = centre !== null && p.mode !== 'tumble' && p.mode !== 'down'
      && Math.hypot(p.pos.x - centre.x, p.pos.z - centre.z) <= this.danceRadius;
    if (!near) {
      if (slot.dancing) { slot.rig.stopDance(); slot.dancing = false; }
      return false;
    }
    if (slot.dancing) return true;
    slot.joinIn -= this.dt;
    if (slot.joinIn > 0) return false;
    slot.rig.startDance();
    slot.dancing = true;
    return true;
  }

  private drawStatic(p: PosablePed): void {
    const v = p.variant % this.statics.length;
    const i = this.counts[v];
    if (i >= this.capacity) return;
    this.counts[v] = i + 1;
    // This is where a body ends up the moment it drops out of the slot pool:
    // walk a little way from someone you knocked over and they used to stand
    // straight back up, then lie down again when you walked back.
    if (!bodyQuat(p, Q)) Q.setFromAxisAngle(UP, p.heading);
    M.compose(V.set(p.pos.x, p.y, p.pos.z), Q, S.setScalar(p.scale));
    for (const mesh of this.statics[v]) mesh.setMatrixAt(i, M);
  }

  dispose(): void {
    for (const slot of this.slots) slot.rig.dispose();
    this.group.removeFromParent();
    for (const o of this.owned) o.dispose();
    this.owned.length = 0;
  }
}

/** A stable identity for a pedestrian across frames. */
function key(p: PosablePed): number {
  return p.variant * 1000 + p.slot;
}
