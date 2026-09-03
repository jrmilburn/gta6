// What the player can do on the pier: ride the wheel, sit on a bench, lean on
// the rail, dive off the end. And what a car can do: knock the bollards over.
//
// Same shape as the dance: the system watches for E near something, takes the
// player over for as long as the thing lasts, and any movement key ends it.
// The pose itself is the character rig's business (characterFlourish.ts); the
// camera is the orbit mode, turned slowly so the ride is a view and not a
// screensaver.
import type { System, Vec2 } from '../types';
import type { CameraModeName, CameraRig } from '../camera/cameras';
import { ORBIT } from '../camera/orbitCamera';
import type { Player } from '../entities/player';
import type { PierBuild, PierSpot, SeatPose } from '../world/pier';
import { PIER_WHEEL } from '../world/cityGen';

type Action = 'forward' | 'back' | 'left' | 'right' | 'handbrake' | 'interact';

export interface PierHost {
  input: { isDown(a: Action): boolean; justPressed(a: Action): boolean };
  time: number;
}

export interface PierDeps {
  player: Player;
  pier: PierBuild;
  cameraRig: CameraRig;
  /** Non-null while driving. Nothing here happens from a car. */
  inVehicle: () => boolean;
  /** A full-screen state owns the frame. */
  blocked: () => boolean;
  /** A car within reach takes E first. */
  carNearby: () => boolean;
  /** Everything that can hit a bollard. */
  vehicles: () => ReadonlyArray<{ pos: Vec2; speed: number; forwardX: number; forwardZ: number; wrecked: boolean }>;
  toast: (text: string, seconds: number) => void;
}

/** How close E works from, metres. */
const REACH = 2.2;
const RIDE_CAMERA_DISTANCE = 6.5;
const RIDE_CAMERA_HEIGHT = 1.6;
/** The camera drifts round the rider this fast, rad/s. A revolution a ride. */
const RIDE_ORBIT_RATE = (Math.PI * 2) / 70;
/** A gondola this close to the bottom can be boarded, radians off vertical. */
const BOARD_WINDOW = 0.28;

type State =
  | { kind: 'none' }
  | { kind: 'ride'; gondola: number; startAngle: number }
  | { kind: 'sit' | 'lean' }
  | { kind: 'dive'; since: number };

export class PierSystem implements System {
  private state: State = { kind: 'none' };
  private previousMode: CameraModeName = 'chase';
  private readonly seat: SeatPose = { x: 0, y: 0, z: 0, heading: 0 };
  /** What E would do right now, for the HUD. Null when nothing is in reach. */
  prompt: string | null = null;
  /** How many full rides have been taken, for the tests. */
  rides = 0;

  constructor(private readonly host: PierHost, private readonly deps: PierDeps) {}

  get active(): boolean { return this.state.kind !== 'none'; }
  /** What the player is doing on the pier right now. */
  get activity(): 'none' | 'ride' | 'sit' | 'lean' | 'dive' { return this.state.kind; }

  /** The seats pedestrians ride in: every third gondola. */
  riderSeats(): SeatPose[] {
    const out: SeatPose[] = [];
    for (let i = 1; i < PIER_WHEEL.gondolas; i += 3) {
      const s = this.deps.pier.wheel.seat(i, { x: 0, y: 0, z: 0, heading: 0 });
      out.push(s);
    }
    return out;
  }

  update(dt: number): void {
    this.deps.pier.update(dt);
    this.knockBollards();

    switch (this.state.kind) {
      case 'ride': return this.stepRide(dt);
      case 'sit':
      case 'lean': return this.stepHeld();
      case 'dive': return this.stepDive();
      default: return this.stepIdle();
    }
  }

  // --- looking for something to do -----------------------------------------------

  private stepIdle(): void {
    this.prompt = null;
    const p = this.deps.player;
    if (!p.onFoot || !p.onGround || p.swimming || this.deps.inVehicle() || this.deps.blocked()) return;
    if (this.deps.carNearby()) return;

    const near = (s: Vec2): boolean => Math.hypot(s.x - p.pos.x, s.z - p.pos.z) < REACH;
    const wheel = this.deps.pier.wheel;
    let action: (() => void) | null = null;

    if (near(wheel.loadZone)) {
      const low = wheel.lowest();
      this.prompt = low.off < BOARD_WINDOW ? 'E   RIDE THE WHEEL' : 'WAIT FOR A GONDOLA';
      if (low.off < BOARD_WINDOW) action = () => this.startRide(low.index);
    } else if (near(this.deps.pier.dive.pos)) {
      this.prompt = 'E   DIVE';
      action = () => this.startDive();
    } else {
      const bench = this.deps.pier.benches.find((s) => near(s.pos));
      const lean = bench ? null : this.deps.pier.leans.find((s) => near(s.pos));
      if (bench) { this.prompt = 'E   SIT'; action = () => this.startHeld('sit', bench); }
      else if (lean) { this.prompt = 'E   LEAN ON THE RAIL'; action = () => this.startHeld('lean', lean); }
    }
    if (action && this.host.input.justPressed('interact')) action();
  }

  /** Any bid for control ends a held pose. */
  private moveKey(): boolean {
    const i = this.host.input;
    return i.isDown('forward') || i.isDown('back') || i.isDown('left') || i.isDown('right')
      || i.isDown('handbrake') || i.justPressed('interact');
  }

  // --- the ride ------------------------------------------------------------------------

  private startRide(gondola: number): void {
    const wheel = this.deps.pier.wheel;
    this.state = { kind: 'ride', gondola, startAngle: wheel.angle };
    this.previousMode = this.deps.cameraRig.mode;
    this.deps.player.carry = () => wheel.seat(gondola, this.seat);
    ORBIT.angle = Math.PI * 0.85;
    ORBIT.distance = RIDE_CAMERA_DISTANCE;
    ORBIT.height = RIDE_CAMERA_HEIGHT;
    this.deps.cameraRig.blendToSubject(this.deps.player, 'orbit');
    this.deps.toast('One time round', 1.5);
    this.prompt = 'E   GET OFF AT THE BOTTOM';
  }

  private stepRide(dt: number): void {
    if (this.state.kind !== 'ride') return;
    const wheel = this.deps.pier.wheel;
    ORBIT.angle += RIDE_ORBIT_RATE * dt;
    const turned = wheel.angle - this.state.startAngle;
    const atBottom = wheel.lowest().index === this.state.gondola && wheel.lowest().off < BOARD_WINDOW;
    const full = turned >= Math.PI * 2 - BOARD_WINDOW;
    // A press only counts at the bottom; nobody climbs out at the top.
    if ((full && atBottom) || (atBottom && turned > 1 && this.host.input.justPressed('interact'))) {
      this.endRide(full);
    }
  }

  private endRide(full: boolean): void {
    const p = this.deps.player;
    p.carry = null;
    const z = this.deps.pier.wheel.loadZone;
    p.placeAt(z.x, z.z + 0.6, 0);
    ORBIT.distance = 4.5;
    ORBIT.height = 1.4;
    this.deps.cameraRig.blendToSubject(p, this.previousMode);
    if (full) this.rides++;
    this.state = { kind: 'none' };
  }

  // --- sitting and leaning ----------------------------------------------------------------

  private startHeld(kind: 'sit' | 'lean', spot: PierSpot): void {
    const p = this.deps.player;
    this.state = { kind };
    this.previousMode = this.deps.cameraRig.mode;
    p.placeAt(spot.pos.x, spot.pos.z, spot.heading);
    p.pose = kind;
    ORBIT.angle = Math.PI * 0.75;
    ORBIT.distance = 4.5;
    ORBIT.height = 1.4;
    this.deps.cameraRig.blendToSubject(p, 'orbit');
    this.prompt = null;
  }

  private stepHeld(): void {
    ORBIT.angle += 0.06 * (1 / 60);
    if (!this.moveKey() && !this.deps.blocked() && !this.deps.inVehicle()) return;
    this.deps.player.pose = null;
    this.deps.cameraRig.blendToSubject(this.deps.player, this.previousMode);
    this.state = { kind: 'none' };
  }

  // --- the dive -----------------------------------------------------------------------------

  private startDive(): void {
    const p = this.deps.player;
    const spot = this.deps.pier.dive;
    p.placeAt(spot.pos.x, spot.pos.z, spot.heading);
    p.dive(Math.sin(spot.heading), Math.cos(spot.heading));
    this.state = { kind: 'dive', since: this.host.time };
    this.prompt = null;
  }

  private stepDive(): void {
    if (this.state.kind !== 'dive') return;
    const p = this.deps.player;
    if (p.swimming) {
      this.deps.toast('Swim back to the beach', 2.5);
      this.state = { kind: 'none' };
    } else if (this.host.time - this.state.since > 4) {
      this.state = { kind: 'none' };
    }
  }

  // --- bollards ------------------------------------------------------------------------------

  private knockBollards(): void {
    for (const b of this.deps.pier.bollards) {
      if (!b.standing) continue;
      for (const v of this.deps.vehicles()) {
        if (v.wrecked || Math.abs(v.speed) < 1) continue;
        const dx = b.pos.x - v.pos.x, dz = b.pos.z - v.pos.z;
        const along = dx * v.forwardX + dz * v.forwardZ;
        const across = dx * v.forwardZ - dz * v.forwardX;
        if (Math.abs(along) > 2.5 || Math.abs(across) > 1.15) continue;
        const dir = Math.sign(v.speed) || 1;
        b.knock(v.forwardX * dir, v.forwardZ * dir);
        break;
      }
    }
  }
}
