// Boot: create the Game, build the world, start the loop.
// `?phase=N` loads an isolated development scene from src/dev/ instead of the
// full game. Phases build and verify against those before integration.
import * as THREE from 'three';
import { Game } from './core/game';
import { param } from './core/rng';
import { buildDevScene } from './dev/index';
import { createSession } from './core/session';

const mount = document.getElementById('app');
if (!mount) throw new Error('#app missing');

const game = new Game(mount);

// Test/debug hook: the smoke suite reads fps and draw calls from here.
(window as unknown as { __game: unknown }).__game = {
  get fps() { return game.fps; },
  get calls() { return game.renderer.info.render.calls; },
  get tris() { return game.renderer.info.render.triangles; },
  get ready() { return game.time > 0; },
  game,
  THREE,
};

async function boot(): Promise<void> {
  const phase = param('phase');
  if (phase) {
    // Isolated per-phase development scenes; see src/dev/index.ts.
    await buildDevScene(phase, game);
  } else {
    const session = createSession(game);
    (window as unknown as { __session: unknown }).__session = session;
  }
  game.start();
}

void boot();
