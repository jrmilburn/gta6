// Boot: title card, asset load, then create the Game world and start the loop.
// `?phase=N` loads an isolated development scene from src/dev/ instead of the
// full game. Phases build and verify against those before integration.
import * as THREE from 'three';
import { Game } from './core/game';
import { param } from './core/rng';
import { buildDevScene } from './dev/index';
import { createSession } from './core/session';
import { loadAssets, emptyAssets, type Assets } from './core/assets';
import { installShotHook } from './capture/shots';
import { createScreens } from './ui/screens';

const mount = document.getElementById('app');
if (!mount) throw new Error('#app missing');

const game = new Game(mount);

// Test/debug hook: the smoke suite reads fps and draw calls from here.
(window as unknown as { __game: unknown }).__game = {
  get fps() { return game.fps; },
  // Two numbers, because the post chain re-renders the scene for its AO
  // prepass: `calls` is the honest per-frame total, `sceneCalls` is the world's
  // own complexity, which is what the draw-call budget is about.
  get calls() { return game.renderer.info.render.calls; },
  get sceneCalls() { return game.post.sceneCalls; },
  get post() { return game.post.enabled; },
  get tris() { return game.renderer.info.render.triangles; },
  get ready() { return game.time > 0; },
  game,
  THREE,
};

const HDRI = { day: 'venice_sunset_1k.hdr', dusk: 'the_sky_is_on_fire_1k.hdr' };

/**
 * Human-readable stage names for the loading bar. The bar reports file counts,
 * not bytes, because a byte-accurate bar needs Content-Length on every request
 * and this bundle is small enough that file counts are already smooth.
 */
function stageFor(label: string): string {
  if (label === 'hdri') return 'sky';
  if (label === 'character') return 'character';
  if (label.startsWith('cars/') || label.startsWith('supplied/')) return 'vehicles';
  if (label.startsWith('nature/')) return 'vegetation';
  if (label.startsWith('props/') || label.startsWith('street/')) return 'street';
  return 'surfaces';
}

async function boot(): Promise<void> {
  const phase = param('phase');
  if (phase) {
    // Isolated per-phase development scenes; see src/dev/index.ts.
    await buildDevScene(phase, game);
    game.start();
    return;
  }

  const uiRoot = document.getElementById('ui');
  if (!uiRoot) throw new Error('#ui overlay root missing');
  const screens = createScreens(uiRoot, game.audio);
  screens.showTitle();

  // The game must not start before the assets are ready: the title card owns
  // the screen, its keypress handler is inert until the bar reaches 1, and the
  // world is not built until then either.
  let assets: Assets;
  if (param('assets') === '0') {
    // Exercise the fallback path without deleting the files: every category is
    // supposed to degrade to what the game shipped with (see ASSETS.md), and a
    // claim like that is worth being able to check.
    console.log('assets: skipped by ?assets=0, running fully procedural');
    assets = emptyAssets();
    const session = createSession(game, assets, screens);
    (window as unknown as { __session: unknown }).__session = session;
    installShotHook(game, session);
    screens.setProgress(1, 'ready');
    game.start();
    return;
  }
  try {
    assets = await loadAssets(game.renderer, HDRI[game.timeOfDay], (f, label) => {
      screens.setProgress(f * 0.98, stageFor(label));
    });
  } catch {
    // Nothing here should throw -- loadAssets swallows per-file failures -- but
    // a boot that dies on the loading screen is the one failure the player
    // cannot recover from, so it falls all the way back to procedural.
    console.log('assets: load failed outright, running fully procedural');
    assets = emptyAssets();
  }

  const session = createSession(game, assets, screens);
  (window as unknown as { __session: unknown }).__session = session;
  installShotHook(game, session);
  screens.setProgress(1, 'ready');
  game.start();
}

void boot();
