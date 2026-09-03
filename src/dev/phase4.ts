// Phase 4 dev scene: the full generated city (needed for a real lane graph
// and sidewalks) plus traffic and pedestrians, no missions/police/HUD.
//
// DECISION: `src/dev/index.ts` does not yet have a `case '4'` (it is outside
// this phase's file ownership -- see the phase brief), so this scene is not
// reachable via `?phase=4` today. It is still built and kept here per this
// phase's file list; verification instead runs against the real game
// (`createSession`, no `?phase=`), which is the better target anyway since
// traffic needs the full city. Whoever wires up phase 5+ can add the missing
// `case '4'` importing `setup` from this file.
import type { Game } from '../core/game';
import { Rng, SEED } from '../core/rng';
import { generateCity } from '../world/cityGen';
import { buildGround } from '../world/ground';
import { buildBuildings } from '../world/buildings';
import { buildProps } from '../world/props';
import { Vehicle, PlayerDriver } from '../entities/vehicle';
import { Player, findEnterable, exitPointFor } from '../entities/player';
import { FOOT_CAMERA } from '../camera/footCamera';
import { TrafficSystem } from '../entities/traffic';
import { PedestrianSystem } from '../entities/pedestrians';
import { CameraRig } from '../camera/cameras';
import { CFG } from '../config';

export function setup(game: Game): void {
  const city = generateCity(new Rng(SEED));
  game.scene.add(buildGround(city));
  game.scene.add(buildBuildings(city));
  game.scene.add(buildProps(city).group);

  const spawn = city.spawns.player;
  const player = new Player(game, { pos: spawn, colliders: city.colliders });
  player.setRespawnPoint(spawn);

  let current: Vehicle | null = null;
  const spare = new Vehicle(game, {
    kind: 'sedan', pos: { x: spawn.x + 4, z: spawn.z }, heading: 0, colorIdx: 3, colliders: city.colliders,
  });
  const driver = new PlayerDriver(game, spare);

  const traffic = new TrafficSystem(game, city, () => player.pos, () => current);
  const allVehicles: Vehicle[] = [spare, ...traffic.cars];
  for (const v of allVehicles) v.setPeers(allVehicles);
  player.setVehicles(allVehicles);

  const peds = new PedestrianSystem(game, () => player.pos);
  peds.setVehicles(allVehicles);

  const rig = new CameraRig(game, city.colliders);
  rig.setSubject(player);
  rig.setMode(FOOT_CAMERA);

  game.add(player);
  game.add({ update: (dt) => { if (current) driver.update(dt); } });
  game.add(spare);
  for (const v of traffic.cars) game.add(v);
  game.add(traffic);
  game.add(peds);
  game.addRenderable(player);
  game.addRenderable(spare);
  for (const v of traffic.cars) game.addRenderable(v);
  game.addRenderable(rig);
  game.add({ update: () => { if (game.input.justPressed('camera')) rig.cycle(); } });

  game.add({
    update: () => {
      if (!game.input.justPressed('interact')) return;
      if (player.onFoot) {
        const target = findEnterable(allVehicles, player.pos, CFG.player.enterRadius);
        if (!target) return;
        target.occupied = true;
        current = target;
        driver.vehicle = target;
        player.onFoot = false;
        rig.setSubject(target);
        rig.setMode('chase');
        game.events.emit('enteredVehicle', { vehicle: target });
      } else if (current) {
        const v = current;
        v.occupied = false;
        v.controls.throttle = 0; v.controls.steer = 0; v.controls.handbrake = false;
        const exit = exitPointFor(v);
        player.pos.x = exit.x; player.pos.z = exit.z;
        player.heading = v.heading; player.velocityHeading = v.heading;
        player.onFoot = true;
        player.grantInvuln(1);
        current = null;
        rig.setSubject(player);
        rig.setMode(FOOT_CAMERA);
        game.events.emit('exitedVehicle', { vehicle: v });
      }
    },
  });

  // Test/debug hooks, following the window.__session / window.__player pattern.
  (window as unknown as { __traffic: unknown }).__traffic = {
    get cars() { return traffic.cars; },
  };
  (window as unknown as { __peds: unknown }).__peds = {
    get count() { return peds.list().length; },
  };
}
