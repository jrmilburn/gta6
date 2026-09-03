// Heat, and the stars it buys (section 9).
//
// One accumulator, not two. The brief says to reuse the existing one -- there
// wasn't one: `wantedChanged` was in the event union and the HUD already drew
// stars for it, but nothing had ever emitted it and police.ts is still a stub.
// So this is the first and only heat system, wired to the events the rest of
// the game already fires, and the HUD lights up without changing a line of it.
import { CFG } from '../config';
import type { EventName, System, Vec2 } from '../types';

const H = CFG.combat.heat;

export interface WantedHost {
  events: {
    on(evt: EventName, fn: (payload?: unknown) => void): void;
    emit(evt: EventName, payload?: unknown): void;
  };
}

export interface WantedDeps {
  player: { pos: Vec2 };
  /** Every police vehicle in the world. Empty until police.ts is filled in. */
  police: () => Array<{ pos: Vec2; wrecked: boolean }>;
  /** True when a straight line from `a` to `b` is not blocked by a building. */
  clearLine: (a: Vec2, b: Vec2) => boolean;
}

interface Payload { kind?: string; x?: number; z?: number; police?: boolean }

export class WantedSystem implements System {
  /** Raw heat. Stars are heat / perStar, capped by CFG.police.maxStars. */
  heat = 0;
  /** Where the last shot was heard, for police to drive to. Null once answered. */
  investigate: Vec2 | null = null;

  private stars = 0;

  constructor(private readonly host: WantedHost, private readonly deps: WantedDeps) {
    host.events.on('punchHit', (p) => {
      if ((p as Payload)?.kind === 'pedestrian') this.add(H.punchKnockdown);
    });
    host.events.on('shotHit', (p) => this.onShot(p as Payload));
  }

  private onShot(p: Payload): void {
    if (p?.kind === 'pedestrian') this.add(H.shotKnockdown);
    if (p?.police) this.add(H.shootPolice);

    // Firing where a police car can see you is worth as much as being seen
    // doing it to somebody.
    const me = this.deps.player.pos;
    let heard = false;
    for (const car of this.deps.police()) {
      if (car.wrecked) continue;
      if (Math.hypot(car.pos.x - me.x, car.pos.z - me.z) > H.policeHearing) continue;
      heard = true;
      if (this.deps.clearLine(car.pos, me)) { this.add(H.gunfireNearPolice); break; }
    }
    // Heard but not seen: they come and look (section 9).
    if (!heard || this.investigate === null) {
      this.investigate = { x: p?.x ?? me.x, z: p?.z ?? me.z };
    }
  }

  add(amount: number): void {
    if (amount <= 0) return;
    this.heat = Math.min(this.heat + amount, CFG.police.maxStars * H.perStar);
    this.sync();
  }

  clear(): void {
    this.heat = 0;
    this.investigate = null;
    this.sync();
  }

  update(dt: number): void {
    if (this.heat <= 0) return;
    // Bleeds off on its own, which is the only way down for now: nothing in the
    // game arrests anybody yet.
    this.heat = Math.max(0, this.heat - H.decayPerSecond * dt);
    this.sync();
  }

  private sync(): void {
    const stars = Math.min(CFG.police.maxStars, Math.floor(this.heat / H.perStar));
    if (stars === this.stars) return;
    this.stars = stars;
    this.host.events.emit('wantedChanged', { stars });
  }
}
