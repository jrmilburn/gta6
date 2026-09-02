// Boot: create the Game, build the world, start the loop.
import * as THREE from 'three';
import { Game } from './core/game';
import { getTextures } from './core/textures';

const mount = document.getElementById('app');
if (!mount) throw new Error('#app missing');

const game = new Game(mount);

// --- Phase 0 placeholder world: flat ground + one shadow-casting box. ---
// Replaced by the generated city in Phase 1.
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

// Test/debug hook: the smoke suite reads fps and draw calls from here.
(window as unknown as { __game: unknown }).__game = {
  get fps() { return game.fps; },
  get calls() { return game.renderer.info.render.calls; },
  get tris() { return game.renderer.info.render.triangles; },
  get ready() { return game.time > 0; },
  game,
};

game.start();
