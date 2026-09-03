// Debug hook the screenshot suite (smoke/shots.spec.ts) drives to place the
// camera at fixed, repeatable viewpoints so before/after pairs line up.
// Costs nothing at runtime: it only installs a few closures on `window`.
import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Session } from '../core/session';
import type { Vec2, Zone } from '../types';

type V3 = [number, number, number];
type SpotKind = 'palm' | 'tree' | 'downtown' | 'residential' | 'beach';

const TARGET = new THREE.Vector3();

/** Centre of the first block in `zone`, nudged onto the road in front of it. */
function streetSpot(session: Session, zone: Zone): Vec2 | null {
  for (const b of session.city.blocks) {
    if (b.zone !== zone) continue;
    return { x: (b.bounds.minX + b.bounds.maxX) / 2, z: b.bounds.minZ - 6 };
  }
  return null;
}

export function installShotHook(game: Game, session: Session): void {
  const api = {
    /** Detach the camera rig so look() owns the camera outright. */
    detach(): void {
      session.rig.setSubject(null);
    },
    /** Hand the camera back to the game, for shots of the game actually running. */
    attach(): void {
      session.rig.setSubject(session.player);
    },
    /** Stand the player where the crowd is thickest, for the dance shot. */
    toCrowd(): void {
      const list = session.peds.list();
      if (list.length === 0) return;
      let best = list[0], bestN = -1;
      for (const a of list) {
        const n = list.filter((b) => Math.hypot(a.x - b.x, a.z - b.z) < 7).length;
        if (n > bestN) { bestN = n; best = a; }
      }
      session.player.placeAt(best.x, best.z, 0);
    },
    /** How far through the current dance we are, 0 when not dancing. */
    danceTime(): number {
      return session.dance.active ? session.dance.elapsed : 0;
    },
    /** How many pedestrians are dancing along. */
    dancers(): number {
      return session.peds.mesh.dancing;
    },
    look(eye: V3, target: V3, fov: number): void {
      game.camera.position.set(eye[0], eye[1], eye[2]);
      TARGET.set(target[0], target[1], target[2]);
      game.camera.lookAt(TARGET);
      game.camera.fov = fov;
      game.camera.updateProjectionMatrix();
    },
    player(): { x: number; y: number; z: number; heading: number } {
      const p = session.player;
      return { x: p.pos.x, y: p.y, z: p.pos.z, heading: p.heading };
    },
    spot(kind: SpotKind): Vec2 | null {
      const props = session.city.props;
      if (kind === 'palm') return props.palms[0]?.pos ?? null;
      if (kind === 'tree') return props.trees[0]?.pos ?? props.palms[1]?.pos ?? null;
      if (kind === 'beach') return streetSpot(session, 'beach');
      if (kind === 'downtown') return streetSpot(session, 'downtown');
      return streetSpot(session, 'residential');
    },
    /** Park the player's first car at a spot so it can be framed. */
    carTo(x: number, z: number, heading: number): void {
      session.vehicles[0]?.reset(x, z, heading);
    },
  };
  (window as unknown as { __shots: typeof api }).__shots = api;
}
