import type { EventName, GameEvents } from '../types';

export class EventBus implements GameEvents {
  private map = new Map<EventName, Array<(p?: unknown) => void>>();

  on(evt: EventName, fn: (payload?: unknown) => void): void {
    const list = this.map.get(evt);
    if (list) list.push(fn);
    else this.map.set(evt, [fn]);
  }

  emit(evt: EventName, payload?: unknown): void {
    const list = this.map.get(evt);
    if (!list) return;
    for (const fn of list) fn(payload);
  }
}
