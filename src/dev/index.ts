// Dev-scene registry. Each phase owns exactly one file in this directory and
// registers it here, so parallel phases never edit the same source file.
import * as THREE from 'three';
import type { Game } from '../core/game';
import { getTextures } from '../core/textures';

/** Phase 0 placeholder: flat ground + one shadow-casting box. */
function phase0(game: Game): void {
  const tex = getTextures();
  const groundTex = tex.sand.clone();
  groundTex.needsUpdate = true;
  groundTex.repeat.set(40, 40);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: 0xd9c9a3, map: groundTex, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  game.scene.add(ground);

  const box = new THREE.Mesh(
    new THREE.BoxGeometry(6, 12, 6),
    new THREE.MeshStandardMaterial({ color: 0xffd9c0, roughness: 0.7 }),
  );
  box.position.set(0, 6, 0);
  box.castShadow = true;
  box.receiveShadow = true;
  game.scene.add(box);

  game.camera.position.set(-20, 9, 26);
  game.camera.lookAt(0, 4, 0);
}

export async function buildDevScene(phase: string | null, game: Game): Promise<void> {
  switch (phase) {
    case '1': {
      const m = await import('./phase1');
      m.setup(game);
      return;
    }
    case '2': {
      const m = await import('./phase2');
      m.setup(game);
      return;
    }
    case '3': {
      const m = await import('./phase3');
      m.setup(game);
      return;
    }
    case '7': {
      const m = await import('./phase7');
      m.setup(game);
      return;
    }
    default:
      phase0(game);
  }
}
