// Police response (section 9, finished in the refinement pass). Units are
// ordinary `Vehicle` instances of kind 'police' -- same class, same arcade
// physics, same collision -- so the player can ram them, wreck them and steal
// them. Only the pursuit layer here is new.
//
// What the wanted level buys, star by star:
//   0  two cruisers on patrol, driving the lane graph like traffic, lights off.
//      A crime they witness lights the first star (wanted.ts).
//   1+ `spawnPerStar` units in pursuit: routed across the lane graph while the
//      player is far, then straight at the player's predicted position, siren
//      on. A wrecked unit is replaced after a moment; a stolen one is written
//      off. Units bust a stopped player, on foot or boxed in a car.
//   3+ roadblocks ahead of a driving player; officers step out and shoot at
//      a player on foot (policeFoot.ts).
//   5  the helicopter (helicopter.ts).
//
// Nobody dies. A bust is a fade and a respawn at the station; a player shot
// to zero health is "wrecked" and respawns the same way.
import type { Lane, System, Vec2 } from '../types';
import type { Game } from '../core/game';
import { CFG } from '../config';
import { Rng } from '../core/rng';
import type { CityLayout } from '../world/cityGen';
import { Vehicle } from './vehicle';
import {
  advanceAlong, anchorOnLane, planRoute, pointAtArc, headingAlong, steerAlong, throttleFor,
  type LaneState,
} from './laneDriver';
import { Helicopter } from './helicopter';
import * as THREE from 'three';

const P = CFG.police;
const STEER_GAIN = 2.4;
/** Parking space for an off-duty unit: far outside the world, and hidden. */
const STOW = { x: 1e5, z: 1e5 };
/** How far ahead of the player's velocity a pursuing unit aims, seconds. */
const LEAD = 0.6;
/** Extra cruisers in the pool over the top star level, for replacements and roadblocks. */
const SPARE_UNITS = 4;
/** A roadblock wakes up and joins the chase when the player is this close. */
const ROADBLOCK_WAKE = 30;
const CONES_PER_BLOCK = 6;

export interface PolicePlayer {
  speed: number;
  onFoot: boolean;
  pos: Vec2;
  y: number;
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
  /** The player's velocity, for the intercept. */
  velocity: () => Vec2;
  /** The car the player is driving, or null on foot. */
  playerVehicle: () => Vehicle | null;
  /**
   * Resolved per update rather than held, because the wanted system and this
   * one each need the other and something has to be the late one.
   */
  wanted: () => {
    readonly level: number;
    heat: number;
    contact: boolean;
    investigate: Vec2 | null;
    clear(): void;
  };
  /** True when a straight line from `a` to `b` is not blocked by a building. */
  clearLine: (a: Vec2, b: Vec2) => boolean;
  /** A model for the roadblock cones, or null for a procedural cone. */
  cone?: () => THREE.Object3D | null;
}

type Role = 'stowed' | 'patrol' | 'pursuit' | 'roadblock' | 'wreck' | 'debris' | 'stolen';

interface Unit {
  car: Vehicle;
  role: Role;
  /** Seconds the car has been stopped while being told to drive. */
  stalled: number;
  /** > 0 while reversing out of whatever it got wedged on. */
  unstick: number;
  /** Seconds this unit has had the player cornered. */
  holding: number;
  /** Lane-following state while on patrol or routing. */
  lane: LaneState | null;
  /** Seconds since the route was last planned, and how long it was. */
  routeAge: number;
  routeLength: number;
  /** Seconds since this unit was wrecked. */
  wreckedFor: number;
  /** Seconds stopped near the player, for an officer to step out. */
  stoppedNear: number;
}

interface Roadblock {
  units: Unit[];
  at: Vec2;
  cones: THREE.InstancedMesh;
}

export class PoliceSystem implements System {
  /** Every unit's vehicle, on duty or not. Session puts these in allVehicles. */
  readonly cars: Vehicle[] = [];
  readonly helicopter = new Helicopter();
  /** The last roadblock placed, for the cutscene and the tests. */
  lastRoadblock: Vec2 | null = null;
  /** Units that have just stopped beside a player on foot, for officers to leave. */
  readonly officerRequests: Vehicle[] = [];

  private readonly units: Unit[] = [];
  private readonly rng = new Rng(4242);
  private busting = false;
  private roadblocks: Roadblock[] = [];
  private roadblockTimer = 0;
  private readonly coneGroup = new THREE.Group();
  private readonly coneGeo: THREE.BufferGeometry;
  private readonly coneMat: THREE.Material;

  constructor(
    private readonly game: Game,
    private readonly city: CityLayout,
    private readonly deps: PoliceDeps,
  ) {
    // One vehicle per unit the highest star level can ask for, plus spares
    // for replacements and roadblocks, built once and reused. Building and
    // disposing cars mid-chase would drop a frame exactly when the game is
    // busiest.
    const most = P.spawnPerStar.reduce((m, n) => Math.max(m, n), 0) + SPARE_UNITS;
    for (let i = 0; i < most; i++) {
      const car = new Vehicle(this.game, {
        kind: 'police',
        pos: { ...STOW },
        heading: 0,
        colorIdx: 0,
        colliders: this.city.colliders,
      });
      car.group.visible = false;
      car.sirenOn = false;
      this.cars.push(car);
      this.units.push({
        car, role: 'stowed', stalled: 0, unstick: 0, holding: 0, lane: null, routeAge: 99, routeLength: Infinity, wreckedFor: 0, stoppedNear: 0,
      });
    }
    game.scene.add(this.helicopter.group);
    game.scene.add(this.coneGroup);
    const src = deps.cone?.();
    this.coneGeo = src ? coneGeometry(src) : new THREE.ConeGeometry(0.28, 0.7, 8).translate(0, 0.35, 0);
    this.coneMat = new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.7 });
  }

  /** Active pursuit units, for the minimap and the crowd. */
  positions(): Vec2[] {
    const out: Vec2[] = [];
    for (const u of this.units) {
      if (u.role === 'pursuit' || u.role === 'roadblock') out.push(u.car.pos);
    }
    if (this.helicopter.active) out.push(this.helicopter.position);
    return out;
  }

  /** How many units are out chasing right now. */
  get active(): number {
    return this.units.filter((u) => u.role === 'pursuit' || u.role === 'roadblock').length;
  }

  get patrolling(): number {
    return this.units.filter((u) => u.role === 'patrol').length;
  }

  /** Send everybody home: used by the respawn key and by a bust. */
  standDown(): void {
    for (const u of this.units) this.stow(u);
    this.clearRoadblocks();
    this.helicopter.leave();
  }

  private stow(u: Unit): void {
    u.role = 'stowed';
    u.holding = 0;
    u.stalled = 0;
    u.unstick = 0;
    u.lane = null;
    u.wreckedFor = 0;
    u.stoppedNear = 0;
    u.car.sirenOn = false;
    u.car.reset(STOW.x, STOW.z, 0);
    u.car.group.visible = false;
  }

  /**
   * Drop a unit onto the lane graph roughly `spawnDist` away, and set it
   * driving. Direction is not constrained to be out of shot: a cruiser
   * appearing in the mirror is the point, and at 110 m it is far enough that
   * nobody watches it arrive.
   */
  private dispatch(u: Unit, role: 'patrol' | 'pursuit', dist = P.spawnDist): void {
    const lanes = this.city.roads.segmentLanes;
    const me = this.deps.focus();
    let best: { lane: Lane; arc: number } | null = null;
    let bestErr = Infinity;
    for (let guard = 0; guard < 60; guard++) {
      const lane = this.city.roads.lanes[lanes[this.rng.int(0, lanes.length - 1)]];
      const arc = this.rng.range(0, Math.max(1, lane.length));
      const p = pointAtArc(lane, arc);
      const err = Math.abs(Math.hypot(p.x - me.x, p.z - me.z) - dist);
      if (err < bestErr) { bestErr = err; best = { lane, arc }; }
      if (err < 15) break;
    }
    if (!best) return;
    const p = pointAtArc(best.lane, best.arc);
    u.car.reset(p.x, p.z, headingAlong(best.lane, best.arc));
    u.car.group.visible = true;
    u.car.sirenOn = role === 'pursuit';
    u.role = role;
    u.stalled = 0;
    u.unstick = 0;
    u.holding = 0;
    u.stoppedNear = 0;
    u.wreckedFor = 0;
    u.lane = anchorOnLane(this.city, u.car.pos, (opts) => opts[this.rng.int(0, opts.length - 1)]);
    u.routeAge = 99;
  }

  /** How many pursuit units the current star level wants on the street. */
  private wantedUnits(): number {
    const w = this.deps.wanted();
    const stars = Math.max(0, Math.min(P.maxStars, w.level));
    const want = P.spawnPerStar[stars] ?? 0;
    // Hysteresis on the way down: a unit only leaves once the heat is well
    // under the line, so a star flickering at its boundary does not pull a
    // cruiser off the street and drop it back a frame later.
    const current = this.active;
    if (want < current && stars < P.maxStars) {
      const line = (stars + 1) * CFG.combat.heat.perStar;
      if (w.heat > line - P.hysteresis) return current;
    }
    return want;
  }

  private free(): Unit | undefined {
    return this.units.find((u) => u.role === 'stowed');
  }

  update(dt: number): void {
    const w = this.deps.wanted();
    const stars = w.level;
    const me = this.deps.focus();
    const pv = this.deps.playerVehicle();

    // --- bookkeeping: wrecks, thefts, the pool -------------------------------------
    for (const u of this.units) {
      if (u.role === 'stowed') continue;
      if (u.car.occupied && u.role !== 'stolen') {
        // Stolen: written off. It keeps being a car; it stops being a unit.
        u.role = 'stolen';
        u.car.sirenOn = false;
        continue;
      }
      if (u.role === 'stolen' && !u.car.occupied) {
        // Abandoned: it sits where it was left, lights off, until the heat
        // drops and everything goes home.
        u.car.controls.throttle = 0;
        u.car.controls.steer = 0;
        continue;
      }
      if (u.car.wrecked && u.role !== 'wreck') { u.role = 'wreck'; u.car.sirenOn = false; u.wreckedFor = 0; }
      if (u.role === 'wreck') {
        u.wreckedFor += dt;
        u.car.controls.throttle = 0;
        u.car.controls.steer = 0;
      }
    }

    // --- sizing -----------------------------------------------------------------------
    if (stars === 0) {
      // Everyone off the case; patrols out.
      for (const u of this.units) if (u.role === 'pursuit' || u.role === 'roadblock') this.stow(u);
      this.clearRoadblocks();
      this.helicopter.leave();
      let patrols = this.patrolling;
      for (const u of this.units) {
        if (patrols >= P.patrolUnits) break;
        if (u.role !== 'stowed') continue;
        this.dispatch(u, 'patrol', this.rng.range(80, 160));
        patrols++;
      }
      w.contact = false;
    } else {
      // Patrols become pursuers the moment there is heat; the rest come in.
      for (const u of this.units) {
        if (u.role === 'patrol') { u.role = 'pursuit'; u.car.sirenOn = true; u.routeAge = 99; }
      }
      const want = this.wantedUnits();
      let live = this.units.filter((u) => u.role === 'pursuit').length;
      // A wreck holds its slot for a moment, then is written off and replaced.
      for (const u of this.units) {
        if (u.role === 'wreck' && u.wreckedFor > P.replaceWreckAfter) u.role = 'debris';
      }
      for (const u of this.units) {
        if (live >= want) break;
        if (u.role !== 'stowed') continue;
        this.dispatch(u, 'pursuit');
        live++;
      }
      if (live > want) {
        for (const u of this.units) {
          if (live <= want) break;
          if (u.role !== 'pursuit') continue;
          this.stow(u);
          live--;
        }
      }
      this.stepRoadblocks(dt, stars, pv);
      if (stars >= P.helicopterStars && !this.helicopter.active) this.helicopter.arrive(me);
      if (stars < P.helicopterStars && this.helicopter.active) this.helicopter.leave();
    }

    // --- driving ----------------------------------------------------------------------
    let contact = false;
    let nearestHold = 0;
    this.officerRequests.length = 0;
    for (const u of this.units) {
      if (u.role === 'patrol') { this.patrol(u, dt); continue; }
      if (u.role === 'roadblock') {
        u.car.controls.throttle = 0;
        u.car.controls.steer = 0;
        u.car.controls.handbrake = true;
        continue;
      }
      if (u.role !== 'pursuit') continue;
      const car = u.car;
      const d = Math.hypot(car.pos.x - me.x, car.pos.z - me.z);
      if (d > P.recycleDist) { this.dispatch(u, 'pursuit'); continue; }

      const seen = this.deps.clearLine(car.pos, me);
      if (seen) contact = true;

      // Chase what they can see; otherwise head for where the noise came from,
      // and failing that keep closing on the player's last known position.
      const target = seen ? me : (w.investigate ?? me);
      if (!seen && w.investigate && Math.hypot(car.pos.x - w.investigate.x, car.pos.z - w.investigate.z) < 12) {
        w.investigate = null; // answered
      }
      this.pursue(u, target, d, seen, dt);

      nearestHold = Math.max(nearestHold, this.stepBust(u, d, dt));
      // Stopped beside a player on foot: somebody gets out.
      const stopped = Math.abs(car.speed) < 1.5 && d < P.officerExitRange;
      u.stoppedNear = stopped ? u.stoppedNear + dt : 0;
      if (u.stoppedNear > 0.6 && stars >= P.officerStars) this.officerRequests.push(car);
    }

    w.contact = contact || this.helicopter.active;
    if (nearestHold >= P.bustSeconds && !this.busting) this.bust();

    this.helicopter.update(dt, me, this.deps.player.y);
    const heli = this.helicopter.active ? Math.hypot(this.helicopter.position.x - me.x, this.helicopter.position.z - me.z) : Infinity;
    this.game.audio.rotor(heli);

    // The siren: as loud as the nearest unit with its lights on.
    let nearest = Infinity;
    for (const u of this.units) {
      if (!u.car.sirenOn) continue;
      nearest = Math.min(nearest, Math.hypot(u.car.pos.x - me.x, u.car.pos.z - me.z));
    }
    this.game.audio.siren(nearest, dt);
  }

  // --- patrol: drive like traffic --------------------------------------------------------

  private patrol(u: Unit, dt: number): void {
    const car = u.car;
    if (!u.lane) u.lane = anchorOnLane(this.city, car.pos);
    const me = this.deps.focus();
    if (Math.hypot(car.pos.x - me.x, car.pos.z - me.z) > P.recycleDist) {
      this.dispatch(u, 'patrol', this.rng.range(80, 160));
      return;
    }
    advanceAlong(this.city, u.lane, car, dt, (opts) => opts[this.rng.int(0, opts.length - 1)]);
    car.controls.steer = steerAlong(this.city, u.lane, car);
    car.controls.throttle = this.blockedAhead(car) ? (car.speed > 0.3 ? -1 : 0) : throttleFor(car, CFG.traffic.cruiseSpeed);
    car.controls.handbrake = false;
    this.unstickIf(u, car.controls.throttle, dt);
  }

  /** Anything in the cone ahead, close: another unit, traffic, the player. */
  private blockedAhead(car: Vehicle): boolean {
    for (const other of car.peers) {
      if (other === car || other.wrecked) continue;
      const dx = other.pos.x - car.pos.x, dz = other.pos.z - car.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > CFG.traffic.followGap || dist < 0.01) continue;
      if ((dx * car.forwardX + dz * car.forwardZ) / dist < Math.cos(Math.PI / 6)) continue;
      return true;
    }
    return false;
  }

  // --- pursuit --------------------------------------------------------------------------------

  /**
   * Far away: drive the lane graph toward the player, re-planned every couple
   * of seconds. Close, with a line of sight: leave the lanes and go straight
   * for where the player will be, and ram. The close-in brake applies only to
   * a player on foot -- a car is shunted, a person is boxed in.
   */
  private pursue(u: Unit, target: Vec2, dist: number, seen: boolean, dt: number): void {
    const car = u.car;
    if (u.unstick > 0) {
      u.unstick -= dt;
      car.controls.throttle = -1;
      car.controls.steer = 0;
      car.controls.handbrake = false;
      return;
    }

    if (!u.lane) u.lane = anchorOnLane(this.city, car.pos);
    // One A* per unit every half second, not one per frame: the route and
    // its length come from the same search.
    u.routeAge += dt;
    if (u.routeAge > 0.5) {
      const plan = planRoute(this.city, u.lane, target);
      u.lane.route = plan.ids;
      u.routeLength = plan.distance;
      u.routeAge = 0;
    }
    const routing = !(seen && dist < P.routeBeyond) && u.routeLength > P.routeBeyond;
    if (routing) {
      advanceAlong(this.city, u.lane, car, dt);
      car.controls.steer = steerAlong(this.city, u.lane, car);
      car.controls.throttle = throttleFor(car, P.cruise);
      car.controls.handbrake = false;
      this.unstickIf(u, car.controls.throttle, dt);
      return;
    }

    // Off the lanes: intercept.
    const v = this.deps.velocity();
    const onFoot = this.deps.player.onFoot;
    const aimX = target.x + (seen ? v.x * LEAD : 0), aimZ = target.z + (seen ? v.z * LEAD : 0);
    const dx = aimX - car.pos.x, dz = aimZ - car.pos.z;
    const localX = dx * car.forwardZ - dz * car.forwardX;
    const localZ = dx * car.forwardX + dz * car.forwardZ;
    const angle = Math.atan2(localX, Math.max(0.01, localZ));
    const steer = Math.max(-1, Math.min(1, angle * STEER_GAIN));

    let throttle: number;
    if (onFoot && dist < P.closeIn) {
      // Pull up beside a person rather than running them down.
      throttle = car.speed > 2 ? -0.5 : 0;
    } else if (Math.abs(angle) > 1.9) {
      // It is behind us: back up and turn rather than driving a long arc.
      throttle = -0.7;
    } else if (car.speed < P.cruise) {
      throttle = 1;
    } else {
      throttle = -0.2;
    }
    car.controls.throttle = throttle;
    car.controls.steer = throttle < 0 ? steer : -steer;
    car.controls.handbrake = false;
    // Re-anchor on the graph as we go, so the next routing leg starts from
    // where the car really is.
    if (u.routeAge === 0) u.lane = anchorOnLane(this.city, car.pos);
    this.unstickIf(u, throttle, dt);
  }

  /** Wedged on a kerb or a corner: back off deliberately for a moment. */
  private unstickIf(u: Unit, throttle: number, dt: number): void {
    const trying = throttle > 0.1;
    u.stalled = trying && Math.abs(u.car.speed) < 0.6 ? u.stalled + dt : 0;
    if (u.stalled > P.unstickAfter) {
      u.unstick = P.unstickFor;
      u.stalled = 0;
    }
  }

  // --- roadblocks ---------------------------------------------------------------------------------

  private stepRoadblocks(dt: number, stars: number, pv: Vehicle | null): void {
    // A block the player has reached, or passed, becomes two more pursuers.
    const me = this.deps.focus();
    this.roadblocks = this.roadblocks.filter((rb) => {
      if (Math.hypot(rb.at.x - me.x, rb.at.z - me.z) > ROADBLOCK_WAKE) return true;
      for (const u of rb.units) { u.role = 'pursuit'; u.car.sirenOn = true; u.routeAge = 99; u.car.controls.handbrake = false; }
      this.coneGroup.remove(rb.cones);
      return false;
    });
    if (stars < P.roadblockStars || !pv || Math.abs(pv.speed) < 4) { this.roadblockTimer = 0; return; }
    this.roadblockTimer += dt;
    if (this.roadblockTimer < P.roadblockInterval) return;
    this.roadblockTimer = 0;
    this.placeRoadblock(pv);
  }

  /**
   * Two cruisers nose to nose across the road `roadblockAhead` metres up the
   * player's lane, with cones in front. They sit still until the player is
   * nearly on them, then join in.
   */
  private placeRoadblock(pv: Vehicle): void {
    const a = this.free();
    const b = a ? this.units.find((u) => u.role === 'stowed' && u !== a) : undefined;
    if (!a || !b) return;
    // Walk the lane graph ahead of the player.
    const st = anchorOnLane(this.city, pv.pos, (opts) => {
      // Prefer straight on.
      let best = opts[0], bestDot = -Infinity;
      for (const o of opts) {
        const p0 = o.points[0], p1 = o.points[o.points.length - 1];
        const dot = (p1.x - p0.x) * pv.forwardX + (p1.z - p0.z) * pv.forwardZ;
        if (dot > bestDot) { bestDot = dot; best = o; }
      }
      return best;
    });
    let remaining = P.roadblockAhead;
    let lane = this.city.roads.lanes[st.laneId];
    let arc = st.arc;
    let guard = 0;
    while (remaining > 0 && guard++ < 12) {
      const left = lane.length - arc;
      if (remaining <= left) { arc += remaining; remaining = 0; break; }
      remaining -= left;
      st.laneId = st.nextLaneId;
      const succ = this.city.roads.successors(st.laneId);
      st.nextLaneId = succ.length ? succ[0].id : st.laneId;
      lane = this.city.roads.lanes[st.laneId];
      arc = 0;
    }
    // Only a straight segment is a road worth blocking.
    if (lane.from === lane.to) return;
    const at = pointAtArc(lane, arc);
    const heading = headingAlong(lane, arc);
    // Road centreline: the lane is offset from it by `lane.offset` to the right.
    const rx = Math.cos(heading), rz = -Math.sin(heading);
    const cx = at.x - rx * lane.offset, cz = at.z - rz * lane.offset;
    const halfRoad = CFG.city.roadWidth / 2;
    for (const [u, side] of [[a, -1], [b, 1]] as const) {
      const x = cx + rx * side * (halfRoad * 0.55), z = cz + rz * side * (halfRoad * 0.55);
      u.car.reset(x, z, heading + side * Math.PI / 2);
      u.car.group.visible = true;
      u.car.sirenOn = true;
      u.role = 'roadblock';
      u.holding = 0;
      u.stalled = 0;
      u.unstick = 0;
      u.stoppedNear = 0;
      u.lane = null;
    }
    // Cones across the approach, a few metres before the cars.
    const cones = new THREE.InstancedMesh(this.coneGeo, this.coneMat, CONES_PER_BLOCK);
    const m = new THREE.Matrix4();
    const fx = Math.sin(heading), fz = Math.cos(heading);
    for (let i = 0; i < CONES_PER_BLOCK; i++) {
      const t = (i / (CONES_PER_BLOCK - 1) - 0.5) * CFG.city.roadWidth * 0.9;
      m.makeTranslation(cx + rx * t - fx * 6, 0, cz + rz * t - fz * 6);
      cones.setMatrixAt(i, m);
    }
    cones.instanceMatrix.needsUpdate = true;
    cones.castShadow = true;
    this.coneGroup.add(cones);
    this.roadblocks.push({ units: [a, b], at: { x: cx, z: cz }, cones });
    this.lastRoadblock = { x: cx, z: cz };
    this.game.events.emit('roadblock', { x: cx, z: cz, heading });
  }

  private clearRoadblocks(): void {
    for (const rb of this.roadblocks) this.coneGroup.remove(rb.cones);
    this.roadblocks = [];
    this.roadblockTimer = 0;
  }

  // --- the bust -------------------------------------------------------------------------------------

  /**
   * A bust needs the player close to a unit and slow, held for `bustSeconds`:
   * on foot, or in a car that has been boxed to a stop. Outrunning it breaks
   * it off.
   */
  private stepBust(u: Unit, dist: number, dt: number): number {
    const p = this.deps.player;
    const cornered = dist < P.bustRadius
      && p.speed < P.bustSpeed
      && Math.abs(this.deps.playerVehicle()?.speed ?? 0) < P.bustSpeed
      && Math.abs(u.car.speed) < P.bustSpeed;
    u.holding = cornered ? u.holding + dt : 0;
    return u.holding;
  }

  private bust(): void {
    this.busting = true;
    this.game.events.emit('busted', { at: { ...this.deps.focus() } });
    const w = this.deps.wanted();
    w.clear();
    w.contact = false;
    this.deps.player.respawn();
    // Long enough to walk away from the station without being re-arrested on
    // the spot.
    this.deps.player.grantInvuln(3);
    this.standDown();
    this.busting = false;
  }
}

/** Flatten a kit cone model into one geometry, standing on y = 0. */
function coneGeometry(src: THREE.Object3D): THREE.BufferGeometry {
  let geo: THREE.BufferGeometry | null = null;
  src.updateWorldMatrix(true, true);
  src.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || geo) return;
    geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
  });
  const g = geo ?? new THREE.ConeGeometry(0.28, 0.7, 8);
  g.computeBoundingBox();
  const b = g.boundingBox as THREE.Box3;
  g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  return g;
}
