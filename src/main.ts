// Boot: create the Game, build the world, start the loop.
// `?phase=N` loads an isolated development scene from src/dev/ instead of the
// full game. Phases build and verify against those before integration.
import { Game } from './core/game';
import { param } from './core/rng';
import { buildDevScene } from './dev/index';

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
};

async function boot(): Promise<void> {
  await buildDevScene(param('phase'), game);
  game.start();
}

void boot();
