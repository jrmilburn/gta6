// Heat, and the stars it buys (section 9, finished in the refinement pass).
//
// One accumulator. Crimes add heat; stars are heat / perStar. Heat never
// bleeds while a unit can see the player. Once nobody can, the plan's rule
// applies: stay out of sight for `decaySeconds` and a star drops, the timer
// resets, and the next star needs the same again. Being busted is the other
// way down.
//
// What counts as a crime, and what it is worth, is CFG.combat.heat: knocking
// somebody down with a fist, a shot, or a car; shooting at all where a unit
// can see or hear it; shooting a cruiser; ramming one; and a hard crash in
// view of one. At zero stars a patrol car that WITNESSES any of it lights the
// first star at once.
import { CFG } from '../config';
import type { EventName, System, Vec2 } from '../types';

const H = CFG.combat.heat;
const P = CFG.police;
/** A crash worth reporting, impact in m/s. */
const CRASH_IMPACT = 10;
/** How far a patrol car sees a crime from. */
const WITNESS_RANGE = 40;
/**
 * A collision counts as the player's only if it happened at the player. The
 * pedestrian and vehicle systems report every impact in the city, and the
 * traffic has accidents of its own -- which used to be charged to the player,
 * so the stars climbed with nobody at the wheel.
 */
const MINE_RANGE = 6;

export interface WantedHost {
  events: {
    on(evt: EventName, fn: (payload?: unknown) => void): void;
    emit(evt: EventName, payload?: unknown): void;
  };
}

export interface WantedDeps {
  player: { pos: Vec2 };
  /** Every police vehicle in the world, and whether it is on the street. */
  police: () => Array<{ pos: Vec2; wrecked: boolean; occupied: boolean }>;
  /** True when a straight line from `a` to `b` is not blocked by a building. */
  clearLine: (a: Vec2, b: Vec2) => boolean;
  /** Where the player effectively is (the car, or the feet). */
  focus?: () => Vec2;
}

interface Payload { kind?: string; x?: number; z?: number; police?: boolean; knockdown?: boolean; impact?: number }

export class WantedSystem implements System {
  /** Raw heat. Stars are heat / perStar, capped by CFG.police.maxStars. */
  heat = 0;
  /** Where the last shot was heard, for police to drive to. Null once answered. */
  investigate: Vec2 | null = null;

  /**
   * True while a police unit has eyes on the player. Heat does not bleed off
   * while they do: a chase you are losing should not time itself out.
   */
  contact = false;

  /** Seconds out of every unit's sight, toward the next star dropping. */
  hidden = 0;

  private stars = 0;

  /** Stars, 0..maxStars. What the HUD draws and what police.ts sizes itself to. */
  get level(): number { return this.stars; }

  /** Seconds left until the next star drops, or null while in contact. */
  get untilDrop(): number | null {
    if (this.stars === 0 || this.contact) return null;
    return Math.max(0, P.decaySeconds - this.hidden);
  }

  constructor(private readonly host: WantedHost, private readonly deps: WantedDeps) {
    host.events.on('punchHit', (p) => {
      if ((p as Payload)?.kind === 'pedestrian') this.crime(H.punchKnockdown, p as Payload);
    });
    host.events.on('shotHit', (p) => this.onShot(p as Payload));
    // Running somebody over. The knockdown flag marks the punch/shot path,
    // which has already been counted through its own event.
    host.events.on('pedHit', (p) => {
      if ((p as Payload)?.knockdown) return;
      if (!this.mine(p as Payload)) return;
      this.crime(H.runOver, p as Payload);
    });
    host.events.on('policeHit', (p) => { if (this.mine(p as Payload)) this.crime(H.ramPolice, p as Payload); });
    host.events.on('vehicleHit', (p) => {
      const impact = (p as Payload)?.impact ?? 0;
      if (impact < CRASH_IMPACT || !this.mine(p as Payload)) return;
      // Only a crash a unit can see is a crime; a fender-bender behind a
      // building is nobody's business.
      if (this.seenBy(this.where(p as Payload))) this.crime(H.crashInView, p as Payload);
    });
  }

  /** Did this happen at the player's own position (their car, or their feet)? */
  private mine(p: Payload): boolean {
    if (p?.x === undefined || p?.z === undefined) return true;
    const me = this.deps.focus?.() ?? this.deps.player.pos;
    return Math.hypot(p.x - me.x, p.z - me.z) < MINE_RANGE;
  }

  private where(p: Payload): Vec2 {
    const me = this.deps.focus?.() ?? this.deps.player.pos;
    return { x: p?.x ?? me.x, z: p?.z ?? me.z };
  }

  /** Any unit on the street with a clear line to `at`. */
  private seenBy(at: Vec2): boolean {
    for (const car of this.deps.police()) {
      if (car.wrecked || car.occupied) continue;
      if (Math.hypot(car.pos.x - at.x, car.pos.z - at.z) > WITNESS_RANGE) continue;
      if (this.deps.clearLine(car.pos, at)) return true;
    }
    return false;
  }

  /**
   * A crime worth `amount`. At zero stars it only counts if a patrol saw it;
   * once there are stars, everything counts, seen or not -- the police are
   * already looking.
   */
  private crime(amount: number, p: Payload): void {
    const at = this.where(p);
    if (this.stars === 0) {
      if (!this.seenBy(at)) return;
      this.add(Math.max(amount, H.perStar));
      return;
    }
    this.add(amount);
  }

  private onShot(p: Payload): void {
    if (p?.kind === 'pedestrian') this.crime(H.shotKnockdown, p);
    if (p?.police) this.add(H.shootPolice);

    // Firing where a police car can see you is worth as much as being seen
    // doing it to somebody.
    const me = this.deps.focus?.() ?? this.deps.player.pos;
    let heard = false;
    for (const car of this.deps.police()) {
      if (car.wrecked || car.occupied) continue;
      if (Math.hypot(car.pos.x - me.x, car.pos.z - me.z) > H.policeHearing) continue;
      heard = true;
      if (this.deps.clearLine(car.pos, me)) { this.add(H.gunfireNearPolice); break; }
    }
    // Heard but not seen: they come and look (section 9). A later shot moves
    // the point of interest; the units clear it when they get there.
    if (heard) this.investigate = { x: p?.x ?? me.x, z: p?.z ?? me.z };
  }

  add(amount: number): void {
    if (amount <= 0) return;
    this.heat = Math.min(this.heat + amount, P.maxStars * H.perStar);
    this.hidden = 0;
    this.sync();
  }

  /** Straight to a star count: `?stars=N`, the showcase, a mission. */
  setStars(n: number): void {
    const stars = Math.max(0, Math.min(P.maxStars, Math.floor(n)));
    this.heat = stars * H.perStar;
    this.hidden = 0;
    this.sync();
  }

  clear(): void {
    this.heat = 0;
    this.investigate = null;
    this.hidden = 0;
    this.sync();
  }

  update(dt: number): void {
    if (this.heat <= 0) return;
    if (this.contact) { this.hidden = 0; return; }
    this.hidden += dt;
    if (this.hidden < P.decaySeconds) return;
    // A star drops: heat falls to the top of the star below, so the next
    // crime is a whole star's worth from lighting it again.
    this.hidden = 0;
    this.heat = Math.max(0, (this.stars - 1) * H.perStar);
    if (this.heat === 0) this.investigate = null;
    this.sync();
  }

  private sync(): void {
    const stars = Math.min(P.maxStars, Math.floor(this.heat / H.perStar));
    if (stars === this.stars) return;
    this.stars = stars;
    this.host.events.emit('wantedChanged', { stars });
  }
}
