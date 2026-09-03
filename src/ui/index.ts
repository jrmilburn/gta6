// Single entry point for phase 7: wires the HUD, minimap and screens into one
// System and hooks the event bus so phases 4-6 (traffic/police/missions, none
// of which exist yet) can drive it purely through events, no direct coupling.
// Integration only needs: `game.add(createUi(game, session));` -- see the
// call site note in this phase's final report.
import type { Game } from '../core/game';
import type { Session } from '../core/session';
import type { System, Vec2 } from '../types';
import { param } from '../core/rng';
import { createHud } from './hud';
import { createScreens, type ScreensApi } from './screens';

export interface Ui extends System {
  setStars(n: number): void;
  setCash(n: number): void;
  setMissionText(text: string | null): void;
  setTimer(seconds: number | null): void;
  setMinimapPolice(list: readonly Vec2[]): void;
  setMinimapMissions(list: readonly Vec2[]): void;
  setMinimapCheckpoint(pos: Vec2 | null): void;
  showTitle(): void;
  /** Brief centred message, e.g. "Dance!". */
  toast(text: string, seconds: number): void;
  setArmed(armed: boolean, aiming: boolean, shots: number): void;
  setGoofy(on: boolean): void;
  setPrompt(text: string | null): void;
  setLookHint(show: boolean): void;
  showWrecked(): void;
  showBusted(): void;
  showMissionPassed(reward?: number): void;
}

function numField(payload: unknown, keys: readonly string[]): number | null {
  if (typeof payload === 'number') return payload;
  if (payload && typeof payload === 'object') {
    for (const k of keys) {
      const v = (payload as Record<string, unknown>)[k];
      if (typeof v === 'number') return v;
    }
  }
  return null;
}

function strField(payload: unknown, keys: readonly string[]): string | null {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    for (const k of keys) {
      const v = (payload as Record<string, unknown>)[k];
      if (typeof v === 'string') return v;
    }
  }
  return null;
}

/**
 * `existingScreens` lets boot put the title card and its loading bar on screen
 * before the world exists, then hand the same instance to the UI rather than
 * stacking a second overlay on top of it.
 */
export function createUi(game: Game, session: Session, existingScreens?: ScreensApi): Ui {
  const uiRoot = document.getElementById('ui');
  if (!uiRoot) throw new Error('#ui overlay root missing');

  const hud = createHud(uiRoot, session.city);
  const screens = existingScreens ?? createScreens(uiRoot, game.audio);

  let hudVisible = param('nohud') !== '1';
  hud.setVisible(hudVisible);

  let police: readonly Vec2[] = [];
  let missions: readonly Vec2[] = [];
  let checkpoint: Vec2 | null = null;

  // Phases 4-6 don't exist yet; these events are never emitted today, but the
  // HUD must degrade gracefully (no stars, no cash, no mission text) and pick
  // them up for free once they arrive.
  game.events.on('wantedChanged', (payload) => {
    const n = numField(payload, ['stars', 'wanted', 'count']);
    if (n !== null) hud.setStars(n);
  });
  game.events.on('cashChanged', (payload) => {
    const n = numField(payload, ['cash', 'total', 'amount', 'value']);
    if (n !== null) hud.setCash(n);
  });
  game.events.on('missionStart', (payload) => {
    hud.setMission(strField(payload, ['text', 'name', 'title']));
    hud.setTimer(numField(payload, ['timer', 'seconds', 'duration']));
  });
  game.events.on('missionPassed', (payload) => {
    const reward = numField(payload, ['reward', 'cash', 'amount']);
    screens.showMissionPassed(reward ?? undefined);
    hud.setMission(null);
    hud.setTimer(null);
  });
  game.events.on('missionFailed', () => {
    hud.setMission(null);
    hud.setTimer(null);
    game.audio.blip(220);
  });
  game.events.on('busted', () => screens.showBusted());
  game.events.on('wrecked', (payload) => {
    // `wrecked` fires per-vehicle (traffic wrecks too, once phase 4 exists);
    // only the player's own car earns the full-screen state.
    const v = payload && typeof payload === 'object' ? (payload as { vehicle?: unknown }).vehicle : undefined;
    if (v === session.playerVehicle) screens.showWrecked();
  });

  return {
    setStars: (n) => hud.setStars(n),
    setCash: (n) => hud.setCash(n),
    setMissionText: (t) => hud.setMission(t),
    setTimer: (s) => hud.setTimer(s),
    setMinimapPolice: (list) => { police = list; },
    setMinimapMissions: (list) => { missions = list; },
    setMinimapCheckpoint: (pos) => { checkpoint = pos; },
    showTitle: () => screens.showTitle(),
    toast: (text, seconds) => hud.toast(text, seconds),
    setArmed: (armed, aiming, shots) => hud.setArmed(armed, aiming, shots),
    setGoofy: (on) => hud.setGoofy(on),
    setPrompt: (text) => hud.setPrompt(text),
    setLookHint: (show) => hud.setLookHint(show),
    showWrecked: () => screens.showWrecked(),
    showBusted: () => screens.showBusted(),
    showMissionPassed: (reward) => screens.showMissionPassed(reward),
    update(dt: number): void {
      if (game.input.justPressed('hud')) {
        hudVisible = !hudVisible;
        hud.setVisible(hudVisible);
      }
      // Driving or on foot, whichever is current -- playerVehicle is null on foot.
      // The boot splash reads as a title card, not a paused game: keep the
      // empty HUD out from behind it.
      hud.setVisible(hudVisible && !screens.titleActive);

      const v = session.playerVehicle;
      const speedMs = v ? Math.abs(v.speed) : session.player.speed;
      const healthFrac = (v ? v.health : session.player.health) / 100;
      const pos = v ? v.pos : session.player.pos;
      const heading = v ? v.heading : session.player.heading;
      hud.tick(dt, speedMs * 3.6, healthFrac, pos, heading, { police, missions, checkpoint });
      screens.tick(dt);
    },
  };
}
