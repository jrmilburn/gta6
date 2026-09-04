// Punching and the pistol (sections 6 and 7).
//
// Both are the same shape: a state machine that decides whether the player may
// act, an overlay clip on the upper body so the legs keep walking, and a hit
// test fired at a measured moment. What they do to a civilian is identical and
// deliberately mild -- a knockdown, and no blood, gore or death anywhere.
import * as THREE from 'three';
import { CFG } from '../config';
import type { System } from '../types';
import { findBone } from '../core/character';
import type { CharacterRig } from './characterRig';
import type { PedTarget } from './pedestrians';
import { AIM } from '../camera/footCamera';
import { buildPistol, fitPistolToHand, ShotEffects, type PistolParts } from './pistol';
import { aimRay, rayHitPed, rayHitVehicle, rayHitWorld, type CombatVehicle } from './combatHits';
import type { CombatDeps, CombatHost, CombatState } from './combatTypes';

export type { CombatDeps, CombatHost, CombatState } from './combatTypes';

const C = CFG.combat;

const V = new THREE.Vector3();
const HIT = new THREE.Vector3();
const NORMAL = new THREE.Vector3();
const MUZZLE = new THREE.Vector3();
const FIST = new THREE.Vector3();

export class CombatSystem implements System, CombatState {
  armed = false;
  aiming = false;
  draw = 0;
  shots = 0;

  private readonly effects = new ShotEffects();
  private pistol: PistolParts | null = null;
  private attachedTo: CharacterRig | null = null;
  private punchCooldown = 0;
  private lastPunch = '';
  /** Set when a punch is thrown, cleared when its impact frame has been tested. */
  private punchImpactAt = -1;
  /** End of the window in which that punch can still connect. */
  private punchUntil = -1;
  private fistBone: THREE.Object3D | null = null;
  private fistOf: CharacterRig | null = null;
  private fireCooldown = 0;
  private flashLeft = 0;
  /** True while the aim pose is loaded into the overlay layer. */
  private poseHeld = false;
  /** True from a trigger pull until the firing clip has run its course. */
  private firing = false;
  private readonly impacts = new Map<string, number>();

  constructor(private readonly host: CombatHost, private readonly deps: CombatDeps) {
    host.scene.add(this.effects.group);
  }

  /** True while a punch is mid-swing; the controller holds the player to a walk. */
  get punching(): boolean { return this.punchImpactAt >= 0 && this.host.time <= this.punchUntil; }

  /**
   * How much of the gun stance the character's own speed has taken back, 0..1.
   *
   * A sprint breaks the stance: the arms come down and the body turns into the
   * stride. Aiming pins it at 0 -- if the player is holding the right button
   * they mean to be aiming, and the speed cap keeps them slow enough for it.
   */
  private get sprinting(): number {
    if (this.aiming || this.draw <= 0.02) return 0;
    const over = this.deps.player.speed - C.pistol.sprintSpeed;
    return THREE.MathUtils.clamp(over / Math.max(CFG.player.runSpeed - C.pistol.sprintSpeed, 0.1), 0, 1);
  }

  update(dt: number): void {
    const rig = this.deps.rig();
    this.effects.update(dt);
    this.punchCooldown = Math.max(0, this.punchCooldown - dt);
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    if (this.flashLeft > 0) {
      this.flashLeft -= dt;
      if (this.flashLeft <= 0 && this.pistol) this.pistol.flash.visible = false;
    }

    const onFoot = this.deps.player.onFoot && !this.deps.inVehicle() && !this.deps.blocked();
    if (!onFoot) {
      // Holstered on entering a car, and neither button does anything there.
      this.armed = false;
      this.aiming = false;
    } else if (this.host.input.justPressed('arm')) {
      this.armed = !this.armed;
      // Ammo is infinite, so the readout counts what this magazine has fired
      // and starts again when the gun goes away (section 7).
      if (!this.armed) { this.aiming = false; this.shots = 0; }
      this.host.events.emit('armedChanged', { armed: this.armed });
    }

    this.stepDraw(dt, rig);
    this.stepAim(dt, onFoot);
    if (onFoot && rig) {
      if (this.armed) this.stepFiring(rig);
      else this.stepPunching(rig);
    }
    this.stepPunchImpact(rig);
    this.applyStance(rig);
  }

  // --- state ---------------------------------------------------------------

  private stepDraw(dt: number, rig: CharacterRig | null): void {
    const want = this.armed ? 1 : 0;
    const time = this.armed ? C.pistol.drawTime : C.pistol.holsterTime;
    const rate = dt / Math.max(time, 1e-3);
    this.draw = want > this.draw ? Math.min(want, this.draw + rate) : Math.max(want, this.draw - rate);
    if (rig) this.attach(rig);
    if (this.pistol) this.pistol.group.visible = this.draw > 0.05;
    if (rig) this.stepAimPose(rig);
  }

  /**
   * The ready and aim poses, held as additive upper-body overlays.
   *
   * The one procedural piece left is the elevation, applied to the arm by
   * `setAim`: every supplied pistol clip holds the gun level, and level is
   * wrong the moment the player looks up or down.
   */
  private stepAimPose(rig: CharacterRig): void {
    if (this.draw <= 0.02) {
      if (this.poseHeld) { rig.overlay.stop(); this.poseHeld = false; this.firing = false; }
      return;
    }
    // Two poses, one per clip, each used for what it actually is.
    //
    // `Pistol Idle` is a relaxed hold -- gun out, arms down -- and is the right
    // shape for walking around armed. It is the wrong shape for aiming, and
    // holding it at full weight while aiming was why the character looked like
    // it was cradling something at its chest.
    //
    // Aiming prefers `Pistol Aim`, an authored 7.1 s sight picture that can
    // simply loop. Before it was supplied the aim pose was the first frame of
    // the Shooting clip held frozen, which is a real sight picture too and is
    // still the fallback -- but a firing clip doing double duty as a stance
    // means the stance cannot breathe and firing has nowhere to return to.
    const idle = rig.has('pistolIdle') ? 'pistolIdle' : 'pistolFire';
    const aim = rig.has('pistolAim') ? 'pistolAim'
      : rig.has('pistolFire') ? 'pistolFire' : idle;
    const pose = this.aiming ? aim : idle;

    // A shot in flight owns the overlay; the pose comes back when it finishes.
    const loop = pose !== 'pistolFire';
    if (this.firing && !rig.overlay.running) {
      this.firing = false;
      // The frozen-frame fallback fires by letting its own clip run, so the
      // finished shot IS the pose clip and the swap below never happens; wind
      // it back to the top by hand.
      if (!loop && rig.overlay.clip === pose) rig.freezeOverlay(0);
    }
    if (!this.firing && rig.overlay.clip !== pose) {
      rig.playOverlay(pose, {
        blendIn: this.poseHeld ? C.pistol.aimIn : C.pistol.drawTime * 0.6,
        blendOut: C.pistol.holsterTime,
        hold: true,
        loop,
      });
      // The aim pose is one frame of a firing clip, held. Letting it run is
      // exactly what firing does, so it starts frozen at the top.
      if (!loop) rig.freezeOverlay(0);
      this.poseHeld = true;
    }
    // Fade the stance out as the character breaks into a run.
    rig.setOverlayWeight(this.draw * (1 - this.sprinting * (1 - C.pistol.sprintPose)));
  }

  private stepAim(dt: number, onFoot: boolean): void {
    this.aiming = onFoot && this.armed && this.draw > 0.95 && this.host.input.mouse.right;
    const time = this.aiming ? C.pistol.aimIn : C.pistol.aimOut;
    const rate = dt / Math.max(time, 1e-3);
    AIM.amount = this.aiming
      ? Math.min(1, AIM.amount + rate)
      : Math.max(0, AIM.amount - rate);
  }

  /**
   * While the pistol is out the character faces where the player is looking and
   * strafes, and sprinting is only allowed with the gun down (section 7).
   */
  private applyStance(rig: CharacterRig | null): void {
    const p = this.deps.player;
    // Facing the camera and strafing is right for a gun held ready and wrong
    // for a sprint: nobody runs flat out sideways.
    p.faceCamera = this.armed && p.onFoot && this.sprinting < 0.5;
    // Aiming is slower than punching, and both are slower than walking. The aim
    // figure comes from what the supplied clips can actually carry; see the note
    // on `aimMoveSpeed`.
    p.speedCap = this.aiming ? C.pistol.aimMoveSpeed
      : this.punching ? C.punch.moveSpeed
        : Infinity;
    if (!rig) return;
    rig.setAim(this.draw * (1 - this.sprinting), this.deps.look.pitch);
    // The aimed movement clips are strafes and back-steps; a sprint is neither,
    // so it hands the legs back to the ordinary run.
    rig.locomotion.armed = this.armed && this.draw > 0.5 && this.sprinting < 0.5;

    // Which way the character is travelling relative to where it is facing.
    // Straight ahead nearly always, because unarmed the character turns into
    // its direction of travel -- but not while the pistol is out and it strafes,
    // and not for the moment either side of a sharp turn, which is exactly when
    // the diagonal and backward clips should appear.
    const ix = (this.host.input.isDown('right') ? 1 : 0) - (this.host.input.isDown('left') ? 1 : 0);
    const iz = (this.host.input.isDown('forward') ? 1 : 0) - (this.host.input.isDown('back') ? 1 : 0);
    if (ix === 0 && iz === 0) { rig.locomotion.moveAngle = 0; return; }
    // Input is camera-relative, exactly as player.ts reads it.
    const yaw = this.deps.look.yaw;
    const wx = Math.sin(yaw) * iz - Math.cos(yaw) * ix;
    const wz = Math.cos(yaw) * iz + Math.sin(yaw) * ix;
    let angle = Math.atan2(wx, wz) - p.heading;
    while (angle > Math.PI) angle -= Math.PI * 2;
    while (angle < -Math.PI) angle += Math.PI * 2;
    rig.locomotion.moveAngle = angle;
  }

  /** Parent the gun to the hand once, the first time a rig exists. */
  private attach(rig: CharacterRig): void {
    if (this.attachedTo === rig) return;
    if (!this.pistol) this.pistol = buildPistol();
    const hand = findBone(rig.root, 'RightHand');
    if (!hand) return;
    hand.add(this.pistol.group);
    fitPistolToHand(
      this.pistol.group, hand,
      findBone(rig.root, 'RightForeArm'), findBone(rig.root, 'RightHandMiddle1'),
    );
    this.attachedTo = rig;
  }

  // --- punching (section 6) -------------------------------------------------

  private stepPunching(rig: CharacterRig): void {
    if (!this.host.input.mouse.leftPressed) return;
    if (this.punchCooldown > 0 || !this.deps.player.onGround) return;

    const clips = rig.clipsWithRole('many').filter((n) => n.startsWith('punch'));
    if (clips.length === 0) return;
    // Never the same clip twice running, which is what makes five clips read as
    // a repertoire rather than a loop.
    const pool = clips.length > 1 ? clips.filter((n) => n !== this.lastPunch) : clips;
    const name = pool[Math.floor(Math.random() * pool.length)];
    this.lastPunch = name;

    // Measured once per clip and cached: where the fist actually arrives varies
    // from a third of the way through a jab to four fifths through a combo.
    let impact = this.impacts.get(name);
    if (impact === undefined) { impact = rig.impactOf(name); this.impacts.set(name, impact); }
    const duration = rig.durationOf(name);
    // Long clips are sped up so the fist always lands promptly after the click.
    const rate = Math.max(1, (duration * impact) / C.punch.maxTimeToImpact);
    if (!rig.playOverlay(name, {
      blendIn: C.punch.blendIn, blendOut: C.punch.blendOut, timeScale: rate,
    })) return;
    this.punchCooldown = (duration / rate) * C.punch.cooldownFraction;
    this.punchImpactAt = this.host.time + (duration * impact) / rate;
    this.punchUntil = this.punchImpactAt + C.punch.activeAfter;
    this.punchImpactAt -= C.punch.activeBefore;
    this.host.audio.whoosh();
  }

  /**
   * Test the fist against the world while it is swinging through.
   *
   * A window rather than an instant, and centred on the hand's own world
   * position when there is a rig to ask. Both matter for the same reason: a
   * pedestrian walks a metre and a half a second, so a single test at one
   * moment against a point computed from the player's heading misses anybody
   * who has taken a step since the swing began.
   */
  private stepPunchImpact(rig: CharacterRig | null): void {
    if (this.punchImpactAt < 0 || this.host.time < this.punchImpactAt) return;
    if (this.host.time > this.punchUntil) { this.punchImpactAt = -1; return; }
    if (!rig) return;

    const p = this.deps.player;
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    // Two spheres, and a hit against either counts. The brief's is a fixed
    // point 0.9 m in front, which is the reach a punch has; the hand's own
    // world position is where the fist actually is, which is what catches
    // somebody standing off to one side. Neither alone is enough: the fixed
    // point ignores the swing, and the hand at full extension sits closer to
    // the body than the reach, so on its own it lets people walk out of range.
    const hand = this.fist(rig);
    const spheres: Array<[number, number, number]> = [
      [p.pos.x + fx * C.punch.reach, p.y + C.punch.height, p.pos.z + fz * C.punch.reach],
    ];
    if (hand) spheres.push([hand.x, hand.y, hand.z]);
    const reaches = (x: number, y: number, z: number, r: number): boolean => spheres.some(
      ([sx, sy, sz]) => Math.hypot(x - sx, z - sz) <= r && Math.abs(y - sy) <= r + 0.5,
    );

    for (const t of this.deps.targets()) {
      if (t.down) continue;
      if (!reaches(t.x, t.y + t.height * 0.5, t.z, C.punch.radius)) continue;
      t.knockDown(p.pos.x, p.pos.z);
      this.punchImpactAt = -1;
      this.host.audio.thud(6);
      this.host.events.emit('punchHit', { kind: 'pedestrian', x: t.x, z: t.z });
      return;
    }
    for (const v of this.deps.vehicles) {
      if (v.wrecked) continue;
      // A car is 4.4 m long, so its centre is further away than its bodywork.
      if (!reaches(v.pos.x, p.y + C.punch.height, v.pos.z, C.punch.radius + 1.4)) continue;
      v.damage(C.punch.vehicleDamage);
      v.shove(fx * C.punch.vehicleImpulse, fz * C.punch.vehicleImpulse);
      this.punchImpactAt = -1;
      this.host.audio.thud(10);
      this.host.events.emit('punchHit', { kind: 'vehicle', x: v.pos.x, z: v.pos.z });
      return;
    }
  }

  // --- the pistol (section 7) ----------------------------------------------

  private stepFiring(rig: CharacterRig): void {
    // DECISION: the pistol fires while the button is held, at the stated rate;
    // the punch does not. The brief forbids auto-repeat for punches explicitly
    // and says only "rate 0.2 s" for the gun, and a rate is a thing a held
    // trigger has. One click still gives exactly one shot, because 0.2 s is
    // longer than a click.
    if (!this.host.input.mouse.left) return;
    if (this.draw < 0.95 || this.fireCooldown > 0) return;
    this.fireCooldown = C.pistol.fireInterval;
    this.shots++;

    // The shot comes from the camera through the crosshair, because that is
    // what the player aimed; the tracer starts at the barrel so it looks like
    // the gun fired it.
    const ray = aimRay(this.host.camera, V);
    this.pistolMuzzle(MUZZLE);

    let best = C.pistol.range;
    let hitKind: 'ped' | 'vehicle' | 'world' | null = null;
    let hitPed: PedTarget | null = null;
    let hitVehicle: CombatVehicle | null = null;

    for (const t of this.deps.targets()) {
      if (t.down) continue;
      const d = rayHitPed(this.host.camera.position, ray, t);
      if (d !== null && d < best) { best = d; hitKind = 'ped'; hitPed = t; }
    }
    for (const v of this.deps.vehicles) {
      const d = rayHitVehicle(this.host.camera.position, ray, v);
      if (d !== null && d < best) { best = d; hitKind = 'vehicle'; hitVehicle = v; }
    }
    const world = rayHitWorld(this.host.camera.position, ray, this.deps.colliders, best, NORMAL);
    if (world !== null && world < best) { best = world; hitKind = 'world'; }

    HIT.copy(this.host.camera.position).addScaledVector(ray, best);
    this.effects.tracerTo(MUZZLE, HIT);
    if (this.pistol) { this.pistol.flash.visible = true; this.flashLeft = C.pistol.flashTime; }
    this.host.audio.gunshot();
    this.deps.kick((C.pistol.kickDeg * Math.PI) / 180);

    if (hitKind === 'ped' && hitPed) {
      hitPed.knockDown(this.deps.player.pos.x, this.deps.player.pos.z);
      this.host.events.emit('shotHit', { kind: 'pedestrian', x: hitPed.x, z: hitPed.z });
    } else if (hitKind === 'vehicle' && hitVehicle) {
      hitVehicle.damage(C.pistol.vehicleDamage);
      // Sparks off the bodywork, thrown back toward the shooter.
      this.effects.spark(HIT, NORMAL.copy(ray).multiplyScalar(-1));
      this.host.events.emit('shotHit', {
        kind: 'vehicle', x: hitVehicle.pos.x, z: hitVehicle.pos.z, police: hitVehicle.kind === 'police',
      });
    } else if (hitKind === 'world') {
      this.effects.mark(HIT, NORMAL);
      this.host.events.emit('shotHit', { kind: 'world', x: HIT.x, z: HIT.z });
    } else {
      this.host.events.emit('shotHit', { kind: 'miss', x: HIT.x, z: HIT.z });
    }

    // The firing clip takes the overlay for its duration; stepAimPose puts the
    // standing pose back the moment it finishes.
    // Already aiming means the overlay is that same clip frozen at the top, so
    // firing is simply letting it run.
    if (rig.has('pistolFire')) {
      if (rig.overlay.clip === 'pistolFire') rig.overlay.resume();
      else rig.playOverlay('pistolFire', { blendIn: 0.04, blendOut: 0.1, hold: true });
      this.firing = true;
    }
  }

  /**
   * Where the right hand actually is, in world space. Cached per rig, because
   * the bone never moves in the hierarchy even though it moves in the world.
   */
  private fist(rig: CharacterRig): THREE.Vector3 | null {
    if (this.fistOf !== rig) {
      this.fistBone = findBone(rig.root, 'RightHand');
      this.fistOf = rig;
    }
    if (!this.fistBone) return null;
    return this.fistBone.getWorldPosition(FIST);
  }

  /** World-space muzzle, falling back to a point in front of the chest. */
  private pistolMuzzle(out: THREE.Vector3): THREE.Vector3 {
    if (this.pistol && this.pistol.group.visible) {
      this.pistol.muzzle.getWorldPosition(out);
      return out;
    }
    const p = this.deps.player;
    return out.set(
      p.pos.x + Math.sin(p.heading) * 0.4, p.y + 1.4, p.pos.z + Math.cos(p.heading) * 0.4,
    );
  }

  dispose(): void {
    this.effects.dispose();
    this.pistol?.dispose();
  }
}
