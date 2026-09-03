// Police response (section 9). Units are ordinary `Vehicle` instances of kind
// 'police' -- same class, same arcade physics, same collision -- so the player
// can ram them, wreck them and steal them. Only the pursuit layer here is new.
//
// The wanted system was already complete and already listening; what was missing
// was anybody to answer it. `spawnPerStar` decides how many units are on the
// street, they are dropped in off-screen on the lane graph, and they drive at
// the player until they either lose them or box them in.
//
// Nobody is hurt and nobody dies. A bust is a fade and a respawn at the station.
import type { System, Vec2 } from '../types';
import type { Game } from '../core/game';
import { CFG } from '../config';
import { Rng } from '../core/rng';
import type { CityLayout } from '../world/cityGen';
import { Vehicle } from './vehicle';

const P = CFG.police;
const STEER_GAIN = 2.4;
/** Parking space for an off-duty unit: far outside the world, and hidden. */
const STOW = { x: 1e5, z: 1e5 };

export interface PolicePlayer {
  speed: number;
  onFoot: boolean;
  respawn(): void;
  grantInvuln(seconds: number): void;
}

export interface PoliceDeps {
  player: PolicePlayer;
  /**
   * Where the player effectively is: the car they are driving, or their feet.
   * Not `player.pos` -- the on-foot controller stops updating while driving, so
   * that reads back wherever they got in and a chase would follow a ghost.
   */
  focus: () => Vec2;
  /** The car the player is driving, or null on foot. */
  playerVehicle: () => Vehicle | null;
  /**
   * Resolved per update rather than held, because the wanted system and this
   * one each need the other and something has to be the late one.
   */
  wanted: () => {
    readonly level: number;
    contact: boolean;
    investigate: Vec2 | null;
    clear(): void;
  };
  /** True when a straight line from `a` to `b` is not blocked by a building. */
  clearLine: (a: Vec2, b: Vec2) => boolean;
}

interface Unit {
  car: Vehicle;
  active: boolean;
  /** Seconds the car has been stopped while being told to drive. */
  stalled: number;
  /** > 0 while reversing out of whatever it got wedged on. */
  unstick: number;
  /** Seconds this unit has had the player cornered. */
  holding: number;
}

export class PoliceSystem implements System {
  /** Every unit's vehicle, on duty or not. Session puts these in allVehicles. */
  readonly cars: Vehicle[] = [];

  private readonly units: Unit[] = [];
  private readonly rng = new Rng(4242);
  private busting = false;

  constructor(
    private readonly game: Game,
    private readonly city: CityLayout,
    private readonly deps: PoliceDeps,
  ) {
    // One vehicle per unit the highest star level can ask for, built once and
    // reused. Building and disposing cars mid-chase would drop a frame exactly
    // when the game is busiest.
    const most = P.spawnPerStar.reduce((m, n) => Math.max(m, n), 0);
    for (let i = 0; i < most; i++) {
      const car = new Vehicle(this.game, {
        kind: 'police',
        pos: { ...STOW },
        heading: 0,
        colorIdx: 0,
        colliders: this.city.colliders,
      });
      car.group.visible = false;
      this.cars.push(car);
      this.units.push({ car, active: false, stalled: 0, unstick: 0, holding: 0 });
    }
  }

  /** Send everybody home: used by the respawn key and by a bust. */
  standDown(): void {
    for (const u of this.units) this.deactivate(u);
  }

  private deactivate(u: Unit): void {
    u.active = false;
    u.holding = 0;
    u.stalled = 0;
    u.unstick = 0;
    u.car.reset(STOW.x, STOW.z, 0);
    u.car.group.visible = false;
  }

  /**
   * Drop a unit onto the lane graph roughly `spawnDist` away. Direction is not
   * constrained to be out of shot: a cruiser appearing in the mirror is the
   * point, and at 110 m it is far enough that nobody watches it arrive.
   */
  private activate(u: Unit): void {
    const lanes = this.city.roads.segmentLanes;
    const me = this.deps.focus();
    let best: Vec2 | null = null;
    let bestErr = Infinity;
    for (let guard = 0; guard < 60; guard++) {
      const lane = this.city.roads.lanes[lanes[this.rng.int(0, lanes.length - 1)]];
      const pts = lane.points;
      const p = pts[this.rng.int(0, pts.length - 1)];
      const err = Math.abs(Math.hypot(p.x - me.x, p.z - me.z) - P.spawnDist);
      if (err < bestErr) { bestErr = err; best = p; }
      if (err < 15) break;
    }
    if (!best) return;
    // Point it at the player, so its first move is toward them rather than a
    // three-point turn in the middle of the road.
    const heading = Math.atan2(me.x - best.x, me.z - best.z);
    u.car.reset(best.x, best.z, heading);
    u.car.group.visible = true;
    u.active = true;
    u.stalled = 0;
    u.unstick = 0;
    u.holding = 0;
  }

  /** How many units the current star level wants on the street. */
  private wanted(): number {
    const stars = Math.max(0, Math.min(P.maxStars, this.deps.wanted().level));
    return P.spawnPerStar[stars] ?? 0;
  }

  update(dt: number): void {
    const want = this.wanted();
    let live = 0;
    for (const u of this.units) if (u.active && !u.car.wrecked) live++;

    // Size the response to the heat. Wrecked units count as gone, so ramming
    // one buys a moment before its replacement arrives.
    for (const u of this.units) {
      if (live >= want) break;
      if (u.active && !u.car.wrecked) continue;
      if (u.active && u.car.wrecked) continue; // leave the wreck where it is
      this.activate(u);
      live++;
    }
    if (live > want) {
      for (const u of this.units) {
        if (live <= want) break;
        if (!u.active || u.car.wrecked) continue;
        this.deactivate(u);
        live--;
      }
    }

    // Wrecks stop being police the moment they are wrecked, but the car stays
    // on the street as debris until the heat drops.
    if (want === 0) {
      for (const u of this.units) if (u.active) this.deactivate(u);
      this.deps.wanted().contact = false;
      return;
    }

    const me = this.deps.focus();
    let contact = false;
    let nearestHold = 0;

    for (const u of this.units) {
      if (!u.active) continue;
      const car = u.car;
      if (car.wrecked || car.occupied) {
        // Stolen or destroyed: it is not chasing anybody.
        car.controls.throttle = 0;
        car.controls.steer = 0;
        continue;
      }
      const d = Math.hypot(car.pos.x - me.x, car.pos.z - me.z);
      if (d > P.recycleDist) { this.activate(u); continue; }

      const seen = this.deps.clearLine(car.pos, me);
      if (seen) contact = true;

      // Chase what they can see; otherwise head for where the noise came from,
      // and failing that keep closing on the player's last known position.
      const target = seen ? me : (this.deps.wanted().investigate ?? me);
      this.drive(u, target, d, dt);

      nearestHold = Math.max(nearestHold, this.stepBust(u, d, dt));
    }

    this.deps.wanted().contact = contact;
    if (nearestHold >= P.bustSeconds && !this.busting) this.bust();
  }

  /** Pure pursuit, in the same local-bearing terms traffic.ts steers by. */
  private drive(u: Unit, target: Vec2, dist: number, dt: number): void {
    const car = u.car;

    if (u.unstick > 0) {
      u.unstick -= dt;
      car.controls.throttle = -1;
      car.controls.steer = 0;
      car.controls.handbrake = false;
      return;
    }

    const dx = target.x - car.pos.x, dz = target.z - car.pos.z;
    const localX = dx * car.forwardZ - dz * car.forwardX;
    const localZ = dx * car.forwardX + dz * car.forwardZ;
    const angle = Math.atan2(localX, Math.max(0.01, localZ));
    const steer = Math.max(-1, Math.min(1, angle * STEER_GAIN));

    let throttle: number;
    if (dist < P.closeIn) {
      // Pull up alongside rather than shunting them down the street.
      throttle = car.speed > 2 ? -0.5 : 0;
    } else if (Math.abs(angle) > 1.9) {
      // It is behind us: back up and turn rather than driving a long arc.
      throttle = -0.7;
    } else if (car.speed < P.cruise) {
      throttle = 1;
    } else {
      throttle = -0.2;
    }

    // Reversing steers the other way round, exactly as it does for the player.
    car.controls.throttle = throttle;
    car.controls.steer = throttle < 0 ? steer : -steer;
    car.controls.handbrake = false;

    // Wedged on a kerb or a corner: the arcade physics has no reverse gear of
    // its own, so back off deliberately for a moment.
    const trying = throttle > 0.1;
    u.stalled = trying && Math.abs(car.speed) < 0.6 ? u.stalled + dt : 0;
    if (u.stalled > P.unstickAfter) {
      u.unstick = P.unstickFor;
      u.stalled = 0;
    }
  }

  /**
   * A bust needs the player out of a car, close, and both of them slow, held
   * for `bustSeconds`. Getting back in a car or simply outrunning it breaks it.
   */
  private stepBust(u: Unit, dist: number, dt: number): number {
    const p = this.deps.player;
    const cornered = p.onFoot
      && dist < P.bustRadius
      && p.speed < P.bustSpeed
      && Math.abs(u.car.speed) < P.bustSpeed;
    u.holding = cornered ? u.holding + dt : 0;
    return u.holding;
  }

  private bust(): void {
    this.busting = true;
    this.game.events.emit('busted');
    const w = this.deps.wanted();
    w.clear();
    w.contact = false;
    this.deps.player.respawn();
    // Long enough to walk away from the station without being re-arrested on
    // the spot, and it is also what stops the bust firing twice.
    this.deps.player.grantInvuln(3);
    this.standDown();
    this.busting = false;
  }
}
