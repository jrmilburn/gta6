// Builds the actual game world: city meshes, the player's vehicle, parked cars
// and the camera rig, wired into Game's ordered system list.
//
// Systems run in the plan's order: player input -> vehicles -> cameras. Later
// phases splice traffic, pedestrians, police, missions and HUD into the gaps.
import type { Game } from './game';
import { Rng, SEED, param } from './rng';
import { generateCity, type CityLayout } from '../world/cityGen';
import { buildGround } from '../world/ground';
import { buildBuildings } from '../world/buildings';
import { buildProps } from '../world/props';
import { buildVegetation } from '../world/vegetation';
import { buildWater } from '../world/water';
import { Vehicle, PlayerDriver } from '../entities/vehicle';
import { initCarModels } from '../entities/carModels';
import { Player, findEnterable, exitPointFor, FOOT_CAMERA } from '../entities/player';
import { TrafficSystem } from '../entities/traffic';
import { PedestrianSystem } from '../entities/pedestrians';
import { CameraRig, cameraModeNames, type CameraModeName } from '../camera/cameras';
import { createUi, type Ui } from '../ui/index';
import type { ScreensApi } from '../ui/screens';
import type { Assets } from './assets';
import { installEnvironment } from '../world/envMap';
import { matchSkyToEnvironment } from '../world/sky';
import { CFG } from '../config';
import { makeGroundSampler } from '../world/groundHeight';
import type { AABB, VehicleKind } from '../types';

const KINDS: VehicleKind[] = ['sedan', 'sports', 'pickup'];
/** Seconds the character takes to dissolve at a car door (feel pass 1.4). */
const DOOR_FADE = 0.2;

export interface Session {
  ui: Ui;
  city: CityLayout;
  vehicles: Vehicle[];
  /** Traffic AI cars on the lane graph (plan section 6). Ordinary Vehicle
   * instances -- always included in `vehicles`-like peer/collision lists via
   * `allVehicles` below, so the player can crash into and steal them. */
  traffic: TrafficSystem;
  /** Sidewalk pedestrians (plan section 6). */
  peds: PedestrianSystem;
  /** The player's on-foot controller; hidden and inert while driving. */
  player: Player;
  /** The car the player is currently driving, or null while on foot. */
  playerVehicle: Vehicle | null;
  driver: PlayerDriver;
  rig: CameraRig;
}

/** Release a vehicle's controls so it decelerates naturally once the player steps out. */
function releaseControls(v: Vehicle): void {
  v.controls.throttle = 0;
  v.controls.steer = 0;
  v.controls.handbrake = false;
}

function pickKind(): VehicleKind {
  const want = param('car');
  return KINDS.includes(want as VehicleKind) ? (want as VehicleKind) : 'sedan';
}

/** Face the car down the road it is parked on rather than into the kerb. */
function headingAt(city: CityLayout, x: number, z: number): number {
  const { lane } = city.roads.nearestLane({ x, z });
  const a = lane.points[0];
  const b = lane.points[lane.points.length - 1];
  return Math.atan2(b.x - a.x, b.z - a.z);
}

export function createSession(game: Game, assets: Assets, screens?: ScreensApi): Session {
  const city = generateCity(new Rng(SEED));

  // Car bodies before any Vehicle is constructed: VehicleMesh asks the registry
  // for a prepared model and falls back to its procedural boxes if there is none.
  initCarModels(assets);

  // Image-based lighting first: buildGround/buildBuildings/buildProps all read
  // it when they choose between a PBR material and the procedural fallback.
  if (assets.env) {
    const env = installEnvironment(game.renderer, game.scene, assets.env);
    matchSkyToEnvironment(game.sky, env.sun.dir, env.sun.color, env.sun.horizon, game.timeOfDay);
  }

  // Vegetation first: props.ts drops its procedural palms and park trees when
  // the real models took, and keeps them when they did not.
  const vegetation = buildVegetation(city, assets);
  game.scene.add(vegetation.group);
  game.addRenderable({
    renderSync: () => vegetation.update(game.camera.position, game.time),
  });

  game.scene.add(buildGround(city, assets));
  game.scene.add(buildBuildings(city, assets));
  game.scene.add(buildProps(city, assets, vegetation.active));

  const water = buildWater(game.sky.sunDir);
  game.scene.add(water.mesh);
  let waterT = 0;
  game.add({ update: (dt) => { waterT += dt; water.update(waterT); } });

  // One drivable car per garage, parked with real physics so they can be
  // crashed into or stolen. The player starts on foot (phase 3) and reaches
  // them by walking over and pressing E.
  const vehicles: Vehicle[] = [];
  const garages = city.spawns.garages;
  for (let i = 0; i < garages.length; i++) {
    const g = garages[i];
    vehicles.push(new Vehicle(game, {
      kind: i === 0 ? pickKind() : KINDS[i % KINDS.length],
      pos: { x: g.x, z: g.z },
      heading: headingAt(city, g.x, g.z),
      colorIdx: i * 3 + 1,
      colliders: city.colliders as AABB[],
    }));
  }
  // A fresh sedan parked by the police station, for `R`'s "respawn with a
  // fresh sedan nearby" (plan section 5) without relocating a garage car.
  const stationSpot = city.spawns.policeStation;
  const spareSpawn = { x: stationSpot.x + 3, z: stationSpot.z };
  const spareCar = new Vehicle(game, {
    kind: 'sedan',
    pos: spareSpawn,
    heading: headingAt(city, spareSpawn.x, spareSpawn.z),
    colorIdx: garages.length * 3 + 1,
    colliders: city.colliders as AABB[],
  });
  vehicles.push(spareCar);
  for (const v of vehicles) {
    v.setPeers(vehicles);
    game.scene.add(v.group);
  }

  const player = new Player(game, {
    pos: city.spawns.player,
    colliders: city.colliders,
    // Kerbs are real: the block slabs sit 0.15 m above the road, and the
    // boardwalk higher still. The player blends onto them (1.3) rather than
    // walking through the side of every sidewalk.
    groundHeightAt: makeGroundSampler(city),
  });
  player.setRespawnPoint(stationSpot);

  // The vehicle currently occupied by the player, or null while on foot.
  let current: Vehicle | null = null;
  const driver = new PlayerDriver(game, vehicles[0]);

  // Traffic (plan section 6): AI cars on the lane graph, spawned at least
  // 60 m from the player. They are ordinary Vehicle instances, so they join
  // the same peer-collision list as the garage cars below -- the player can
  // crash into and steal them (session.ts is what makes "stealing" work: once
  // E sets `occupied = true` on one, TrafficSystem's update() skips it).
  const traffic = new TrafficSystem(game, city, () => player.pos, () => current);

  // Every drivable body in the world (garage cars, the spare, and traffic)
  // collides with every other one, and is something the player can hit, be
  // hit by, or step into.
  const allVehicles: Vehicle[] = [...vehicles, ...traffic.cars];
  for (const v of allVehicles) v.setPeers(allVehicles);
  player.setVehicles(allVehicles);

  // Pedestrians (plan section 6): sidewalk wanderers that flee and tumble
  // when hit by any of the same vehicles.
  const peds = new PedestrianSystem(game, () => player.pos);
  peds.setVehicles(allVehicles);

  const rig = new CameraRig(game, city.colliders);
  rig.setSubject(player);
  rig.setMode(FOOT_CAMERA);

  const wantCam = param('cam') as CameraModeName | null;
  if (wantCam && cameraModeNames().includes(wantCam)) rig.setMode(wantCam);

  game.add(player);
  // The driver only feeds input to a vehicle while the player occupies it;
  // parked cars keep stepping their own physics via the loop below.
  game.add({ update: (dt) => { if (current) driver.update(dt); } });
  for (const v of vehicles) game.add(v);
  // System order (plan section 1.1): input -> player -> vehicles -> traffic
  // -> pedestrians -> ... -> cameras.
  for (const v of traffic.cars) game.add(v);
  game.add(traffic);
  game.add(peds);

  // Render pass (1.1): meshes are written once per *rendered* frame from the
  // interpolated physics state, and the camera reads those, so it must come
  // last. Nothing below writes simulation state.
  game.addRenderable(player);
  for (const v of allVehicles) game.addRenderable(v);
  game.addRenderable(rig);
  game.add({ update: () => { if (game.input.justPressed('camera')) rig.cycle(); } });

  // Enter/exit (plan section 5): E toggles between walking and driving the
  // nearest unoccupied, non-wrecked car within CFG.player.enterRadius.
  //
  // `doorFade` is +1 while the character is dissolving into a car and -1 while
  // they are resolving back out of one; the 0.2 s ramp runs on wall time.
  let doorFade = 0;
  game.addRenderable({
    renderSync: (_alpha, dt) => {
      if (doorFade === 0) return;
      player.fade = Math.max(0, Math.min(1, player.fade + doorFade * dt / DOOR_FADE));
      if (player.fade === 0 || player.fade === 1) doorFade = 0;
    },
  });
  game.add({
    update: () => {
      if (!game.input.justPressed('interact')) return;
      if (player.onFoot) {
        const target = findEnterable(allVehicles, player.pos, CFG.player.enterRadius);
        if (!target) return;
        target.occupied = true;
        current = target;
        driver.vehicle = target;
        driver.reset();
        // Fade the character out at the door rather than deleting them on the
        // frame E is pressed (1.4); the camera blends across at the same time.
        doorFade = 1;
        player.onFoot = false;
        rig.blendToSubject(target, 'chase');
        game.events.emit('enteredVehicle', { vehicle: target });
      } else if (current) {
        const v = current;
        v.occupied = false;
        releaseControls(v); // let it decelerate naturally, no more driver input
        const exit = exitPointFor(v);
        player.placeAt(exit.x, exit.z, v.heading);
        player.onFoot = true;
        player.fade = 1;
        doorFade = -1;
        player.grantInvuln(1); // don't get clipped by the car you just left
        current = null;
        rig.blendToSubject(player, FOOT_CAMERA);
        game.events.emit('exitedVehicle', { vehicle: v });
      }
    },
  });

  // Respawn (plan section 5): R always returns the player to the police
  // station on foot, forcing an exit first if they were mid-drive, and resets
  // the spare sedan parked there to full health.
  game.add({
    update: () => {
      if (!game.input.justPressed('respawn')) return;
      if (current) {
        releaseControls(current);
        current.occupied = false;
        current = null;
      }
      player.respawn();
      player.fade = 0;
      doorFade = 0;
      rig.setSubject(player);
      rig.setMode(FOOT_CAMERA);
      spareCar.reset(spareSpawn.x, spareSpawn.z, headingAt(city, spareSpawn.x, spareSpawn.z));
    },
  });

  const session: Session = {
    city, vehicles, traffic, peds, player, driver, rig,
    get playerVehicle() { return current; },
    // Assigned below: createUi needs the session it reads state from.
    ui: null as unknown as Ui,
  };

  // UI runs last in the system order (plan 1.1), so it renders the state every
  // other system has already settled this step.
  session.ui = createUi(game, session, screens);
  game.add(session.ui);
  session.ui.showTitle();

  return session;
}
