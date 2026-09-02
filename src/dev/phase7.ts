// Phase 7 dev scene: full city + a drivable car (via the read-only createSession
// import) plus the HUD/minimap/screens under test. Phases 4-6 (traffic, police,
// missions) don't exist yet, so this scene fakes their inputs through the same
// setters/events a later phase will use, to prove the HUD degrades to and from
// "nothing to show" cleanly.
import type { Game } from '../core/game';
import { createSession } from '../core/session';
import { createUi } from '../ui/index';

export function setup(game: Game): void {
  const session = createSession(game);
  const ui = createUi(game, session);
  game.add(ui);

  // Demo dressing so a screenshot at any point shows a populated, readable HUD.
  ui.setStars(3);
  ui.setCash(12340);
  ui.setMissionText('DELIVER THE PACKAGE');
  ui.setTimer(95);
  ui.setMinimapMissions(session.city.spawns.missions);
  ui.setMinimapPolice([session.city.spawns.policeStation]);
  ui.setMinimapCheckpoint(session.city.spawns.garages[0] ?? null);

  ui.showTitle();

  // Driven off simulation time (game.time) rather than wall-clock setTimeout:
  // under the software-rendered swiftshader path fps can drop a long way
  // below 60, and wall-clock timers queued behind a backed-up main thread
  // drift; the fixed-step loop does not. No human is present for the
  // automated smoke run, so the title is dismissed with a real keydown (the
  // same path a player's key press would take) on Digit1 -- unbound in
  // input.ts's BINDINGS, so it can't leave e.g. the handbrake stuck on.
  const steps: Array<[number, () => void]> = [
    [1.0, () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' }))],
    [1.2, () => { game.input.scripted = { forward: 1, right: 0.18 }; game.audio.startAmbient(); }],
    // Well after the smoke screenshot lands (~7 s in) so it catches the plain
    // HUD; a human scrubbing a longer recording still sees all three states.
    [10, () => ui.showWrecked()],
    [13, () => ui.showBusted()],
    [16, () => ui.showMissionPassed(500)],
  ];
  let next = 0;
  game.add({
    update: () => {
      while (next < steps.length && game.time >= steps[next][0]) {
        steps[next][1]();
        next++;
      }
    },
  });

  // Test/debug hook, same pattern as window.__player / window.__session.
  (window as unknown as { __ui: unknown }).__ui = ui;
}
