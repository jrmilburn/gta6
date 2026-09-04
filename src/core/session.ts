// Builds the actual game world: city meshes, the player's vehicle, parked cars
// and the camera rig, wired into Game's ordered system list.
//
// Systems run in the plan's order: player input -> vehicles -> cameras. Later
// phases splice traffic, pedestrians, police, missions and HUD into the gaps.
import type { Game } from './game';
import type { Vec2 } from '../types';
import { Rng, SEED, param, paramNum } from './rng';
import { generateCity, type CityLayout } from '../world/cityGen';
import { buildGround } from '../world/ground';
import { buildBuildings } from '../world/buildings';
import { buildProps, type PropsBuild } from '../world/props';
import { SignalSystem } from '../world/signals';
import { buildVegetation } from '../world/vegetation';
import { buildStreetProps } from '../world/streetProps';
import { buildWater } from '../world/water';
import { Vehicle, PlayerDriver } from '../entities/vehicle';
import { spawnVehicles, headingAt } from '../world/spawnVehicles';
import { initCarModels } from '../entities/carModels';
import { Player, findEnterable, exitPointFor } from '../entities/player';
import { FOOT_CAMERA } from '../camera/footCamera';
import { MouseLook, installPointerLock } from '../camera/mouseLook';
import '../camera/orbitCamera';
import { CharacterRig } from '../entities/characterRig';
import { SkinnedPedRenderer } from '../entities/pedSkinned';
import { DanceSystem } from '../entities/dance';
import { CombatSystem } from '../entities/combat';
import { WantedSystem } from '../gameplay/wanted';
import { segmentVsAabb } from '../entities/collision';
import { TrafficSystem } from '../entities/traffic';
import { PedestrianSystem } from '../entities/pedestrians';
import { CameraRig, cameraModeNames, type CameraModeName } from '../camera/cameras';
import { PoliceSystem } from '../entities/police';
import { IntroFlight } from '../camera/introCamera';
import { createUi, type Ui } from '../ui/index';
import type { ScreensApi } from '../ui/screens';
import type { Assets } from './assets';
import { installEnvironment } from '../world/envMap';
import { matchSkyToEnvironment } from '../world/sky';
import { CFG } from '../config';
import { makeGroundSampler, waterAt } from '../world/groundHeight';
import { buildPier, type PierBuild } from '../world/pier';
import { PIER_WHEEL } from '../world/cityGen';
import { PierSystem } from '../gameplay/pier';
import { OfficerSystem } from '../entities/policeFoot';
import { CutsceneDirector, at, type Shot } from '../camera/cutscene';


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
  /** The opening drone flight. Inert once it has handed over to the rig. */
  intro: IntroFlight;
  /** Police response, sized by the wanted level. */
  police: PoliceSystem;
  /** Officers on foot; null without a supplied character. */
  officers: OfficerSystem | null;
  /** Street furniture, and the traffic-light lenses the signal system drives. */
  props: PropsBuild;
  /** The traffic lights' clock. */
  signals: SignalSystem;
  /** The pier itself, and its interactions: the wheel, the benches, the dive. */
  pier: PierBuild;
  pierPlay: PierSystem;
  /** Short held-camera scenes on the moments that earn one. */
  cutscene: CutsceneDirector;
  /** `G`: eight seconds of the dance clip, orbit camera and a crowd. */
  dance: DanceSystem;
  /** The player's skinned rig, or null when running on the procedural humanoid. */
  heroRig: CharacterRig | null;
  /** Punching and the pistol (sections 6-7). */
  combat: CombatSystem;
  /** Heat and stars (section 9). */
  wanted: WantedSystem;
  /** Where the player is looking (section 3). */
  look: MouseLook;
}

/** Release a vehicle's controls so it decelerates naturally once the player steps out. */
function releaseControls(v: Vehicle): void {
  v.controls.throttle = 0;
  v.controls.steer = 0;
  v.controls.handbrake = false;
}

export function createSession(game: Game, assets: Assets, screens?: ScreensApi): Session {
  // Debug population overrides, applied once before anything reads them.
  // `?peds=20&traffic=6` builds a lighter world -- which is what makes a
  // 30-second standing-still measurement finish inside a test timeout on a
  // software rasteriser, and what lets the frame budget be measured against a
  // stated crowd size rather than against whatever happens to be nearby.
  CFG.peds.count = Math.max(0, Math.round(paramNum('peds', CFG.peds.count)));
  CFG.traffic.count = Math.max(0, Math.round(paramNum('traffic', CFG.traffic.count)));

  // Mouse look is created before anything that reads a heading, and stepped
  // first in the system order, so every consumer sees the same value all step.
  const look = new MouseLook(game);
  installPointerLock(game.renderer.domElement);
  game.add(look);

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
  const props = buildProps(city, assets, vegetation.active, game.timeOfDay === 'dusk');
  game.scene.add(props.group);
  const street = buildStreetProps(city, assets);
  if (street) game.scene.add(street);
  const pier = buildPier(city, assets, game.timeOfDay === 'dusk');
  game.scene.add(pier.group);
  const groundAt = makeGroundSampler(city);
  Vehicle.groundAt = groundAt;

  const water = buildWater(game.sky.sunDir);
  game.scene.add(water.mesh);
  let waterT = 0;
  game.add({ update: (dt) => { waterT += dt; water.update(waterT); } });

  const { vehicles, spareCar, spareSpawn } = spawnVehicles(game, city);

  // The supplied character, if it loaded. One rig for the player; the crowd
  // gets its own pool of them (section 5). Both fall back cleanly: without a
  // character the player is the procedural humanoid and the crowd is the
  // instanced one, exactly as before.
  const heroRig = assets.character ? new CharacterRig(assets.character) : null;

  const player = new Player(game, {
    pos: city.spawns.player,
    colliders: city.colliders,
    visual: heroRig,
    look,
    // Kerbs are real: the block slabs sit 0.15 m above the road, and the
    // boardwalk higher still. The player blends onto them (1.3) rather than
    // walking through the side of every sidewalk.
    groundHeightAt: groundAt,
    waterAt,
  });
  player.setRespawnPoint(city.spawns.policeStation);

  // The vehicle currently occupied by the player, or null while on foot.
  let current: Vehicle | null = null;

  /**
   * Where the player effectively is. The on-foot controller stops updating the
   * moment they get into a car -- `player.update` returns early when `onFoot` is
   * false -- so `player.pos` reads back wherever they climbed in. Anything that
   * spawns, recycles or chases relative to the player has to ask this instead,
   * or it works off a ghost as soon as anybody drives anywhere.
   */
  const focusPos = (): Vec2 => (current ? current.pos : player.pos);
  const driver = new PlayerDriver(game, vehicles[0]);

  // Traffic (plan section 6): AI cars on the lane graph, spawned at least
  // 60 m from the player. They are ordinary Vehicle instances, so they join
  // the same peer-collision list as the garage cars below -- the player can
  // crash into and steal them (session.ts is what makes "stealing" work: once
  // E sets `occupied = true` on one, TrafficSystem's update() skips it).
  const signals = new SignalSystem(city, props.signals, param('signals') !== '0');
  const traffic = new TrafficSystem(game, city, focusPos, () => current);
  traffic.setSignals(signals);

  // Police (section 9). Built before `allVehicles` so its cruisers join the
  // same peer-collision list as everything else: they are ordinary vehicles,
  // and the player can ram them, wreck them and steal them. `wanted` is
  // resolved lazily because the two systems each need the other.
  const clearLine = (a: Vec2, b: Vec2): boolean =>
    !city.colliders.some((c) => segmentVsAabb(a.x, a.z, b.x, b.z, c) >= 0);
  const police: PoliceSystem = new PoliceSystem(game, city, {
    player,
    focus: focusPos,
    velocity: () => (current ? current.velocity : { x: player.speed * Math.sin(player.heading), z: player.speed * Math.cos(player.heading) }),
    playerVehicle: () => current,
    wanted: () => wanted,
    clearLine,
    cone: () => assets.car('cone'),
  });
  // Officers on foot, when there is a character to be one.
  const officers = assets.character
    ? new OfficerSystem(game, assets.character, {
      player,
      requests: () => police.officerRequests,
      stars: () => wanted.level,
      clearLine,
      groundAt,
      blocked: () => screens?.active === true,
    })
    : null;

  // Every drivable body in the world (garage cars, the spare, traffic and the
  // police) collides with every other one, and is something the player can hit,
  // be hit by, or step into.
  const allVehicles: Vehicle[] = [...vehicles, ...traffic.cars, ...police.cars];
  for (const v of allVehicles) v.setPeers(allVehicles);
  player.setVehicles(allVehicles);

  // Pedestrians (plan section 6): sidewalk wanderers that flee and tumble
  // when hit by any of the same vehicles.
  const peds = new PedestrianSystem(
    game, focusPos, 424242,
    assets.character
      ? new SkinnedPedRenderer(assets.character, CFG.peds.count, {
        cameraPosition: game.camera.position,
        get time() { return game.time; },
      })
      : undefined,
  );
  peds.setVehicles(allVehicles);
  // Buildings are solid to pedestrians too. The wander path is laid out clear
  // of them, but a flee is a straight line for three seconds.
  peds.setColliders(city.colliders);
  peds.setSignals(signals);
  peds.setGround(groundAt);

  // The toast lands on the HUD, which does not exist until createUi() below;
  // the indirection is so the dance can be built with everything else it needs
  // and still reach the UI once there is one.
  let toastFn: (text: string, seconds: number) => void = () => {};

  const rig = new CameraRig(game, city.colliders);
  rig.setLook(look);
  rig.setSubject(player);
  rig.setMode(FOOT_CAMERA);

  const wantCam = param('cam') as CameraModeName | null;
  if (wantCam && cameraModeNames().includes(wantCam)) rig.setMode(wantCam);

  game.add(player);
  // Once the mouse has been idle a moment, the on-foot camera drifts back
  // behind the character -- but only while they are actually walking. Standing
  // still pulls not at all, which is what keeps the look and the facing from
  // steering each other (section 2).
  game.add({
    update: (dt) => {
      if (!player.onFoot || player.faceCamera) return;
      look.recentre(player.heading, dt, player.speed / CFG.player.walkSpeed);
    },
  });
  // The driver only feeds input to a vehicle while the player occupies it;
  // parked cars keep stepping their own physics via the loop below.
  game.add({
    update: (dt) => { if (current) driver.update(dt); },
  });
  for (const v of vehicles) game.add(v);
  // System order (plan section 1.1): input -> player -> vehicles -> traffic
  // -> pedestrians -> ... -> cameras.
  for (const v of traffic.cars) game.add(v);
  for (const v of police.cars) game.add(v);
  game.add(signals);
  game.add(traffic);
  game.add(peds);

  // Render pass (1.1): meshes are written once per *rendered* frame from the
  // interpolated physics state, and the camera reads those, so it must come
  // last. Nothing below writes simulation state.
  game.addRenderable(player);
  for (const v of allVehicles) game.addRenderable(v);
  game.addRenderable(rig);

  // Cutscenes (refinement pass): after the rig, so they overwrite what it
  // wrote and hand back to it. Short, and only on the moments that earn one.
  const cutscene = new CutsceneDirector(game, (on) => screens?.showLetterbox(on));
  game.addRenderable(cutscene);
  game.add({ update: () => { if (game.input.justPressed('camera')) rig.cycle(); } });

  // The opening flight, added AFTER the rig so it overwrites what the rig
  // wrote. The rig keeps following the player underneath the whole cinematic,
  // which is exactly what makes the final blend land on a live camera rather
  // than a reconstructed one.
  //
  // It starts immediately: the session is only built once the assets are in, so
  // "now" is the first moment there is a city to fly over. The splash goes with
  // it, because the flight is the way into the game and there is nothing left to
  // press a key for. With ?intro=0 the splash behaves exactly as it always did.
  const intro = new IntroFlight(game, player);
  if (CFG.feel.intro.enabled && param('intro') !== '0') {
    game.addRenderable(intro);
    screens?.hideTitle();
    intro.start();
  }

  // Heat first, so it is listening before anything can hit anyone.
  const wanted: WantedSystem = new WantedSystem(game, {
    player,
    police: () => police.cars,
    // Line of sight through the same footprints the camera checks.
    clearLine,
    focus: focusPos,
  });
  game.add(wanted);
  // After `wanted`, so a bust clears the heat that the same frame's decay would
  // otherwise put straight back.
  game.add(police);
  if (officers) game.add(officers);
  // The crowd keeps clear of the police once there is heat, and runs from
  // officers on foot at any level.
  peds.setThreats(() => (wanted.level > 0 ? [...police.positions(), ...(officers?.positions() ?? [])] : (officers?.positions() ?? [])));
  // `?stars=N`: straight to a chase, for filming and for the tests.
  const startStars = paramNum('stars', 0);
  if (startStars > 0) wanted.setStars(startStars);
  // Shot to zero, or run down, on foot: the heat goes with the respawn, the
  // same as a bust, or the player would wake up at the station still wanted.
  game.events.on('wrecked', (payload) => {
    const o = payload && typeof payload === 'object' ? (payload as { player?: unknown }) : {};
    if (o.player === undefined) return;
    wanted.clear();
    police.standDown();
    officers?.standDown();
  });
  game.events.on('busted', () => officers?.standDown());

  const combat = new CombatSystem(game, {
    player,
    rig: () => heroRig,
    look,
    inVehicle: () => current !== null,
    blocked: () => screens?.active === true,
    targets: () => (officers ? [...peds.targets(), ...officers.targets()] : peds.targets()),
    vehicles: allVehicles,
    colliders: city.colliders,
    kick: (radians) => rig.kickPitch(radians),
  });
  game.add(combat);

  // P toggles the goofy run (section 5). Session-scoped, as the brief asks.
  game.add({
    update: () => {
      if (!game.input.justPressed('goofy') || !heroRig) return;
      heroRig.locomotion.goofy = !heroRig.locomotion.goofy;
      game.events.emit('goofyChanged', { on: heroRig.locomotion.goofy });
    },
  });

  const dance = new DanceSystem(game, {
    rig: () => heroRig,
    player,
    inVehicle: () => current !== null,
    // A full-screen state owns the frame; dancing under a WRECKED card is not
    // the joke it sounds like.
    blocked: () => screens?.active === true,
    cameraRig: rig,
    crowd: (centre, radius) => peds.setDance(centre, radius),
    toast: (text, seconds) => toastFn(text, seconds),
  });
  game.add(dance);

  // The pier (refinement pass): ride the wheel, sit, lean, dive; cars knock
  // the bollards over. E goes to a car first, then to the pier.
  const pierPlay = new PierSystem(game, {
    player,
    pier,
    cameraRig: rig,
    inVehicle: () => current !== null,
    blocked: () => screens?.active === true,
    carNearby: () => findEnterable(allVehicles, player.pos, CFG.player.enterRadius) !== null,
    vehicles: () => allVehicles,
    toast: (text, seconds) => toastFn(text, seconds),
  });
  game.add(pierPlay);
  peds.setRiders(() => pierPlay.riderSeats());

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
      // The pier has E while it is doing something with the player.
      if (pierPlay.active) return;
      dance.stop();
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
      dance.stop();
      if (current) {
        releaseControls(current);
        current.occupied = false;
        current = null;
      }
      police.standDown();
      officers?.standDown();
      wanted.clear();
      player.respawn();
      player.fade = 0;
      doorFade = 0;
      rig.setSubject(player);
      rig.setMode(FOOT_CAMERA);
      spareCar.reset(spareSpawn.x, spareSpawn.z, headingAt(city, spareSpawn.x, spareSpawn.z));
    },
  });

  // --- cutscene triggers ------------------------------------------------------------
  const playerAnchor = () => ({ x: player.pos.x, y: player.y, z: player.pos.z, heading: player.heading });
  const focusAnchor = () => (current
    ? { x: current.pos.x, y: current.y, z: current.pos.z, heading: current.heading }
    : playerAnchor());
  const nearestUnit = (): Vehicle | null => {
    let best: Vehicle | null = null, bd = Infinity;
    const me = focusPos();
    for (const c of police.cars) {
      if (!c.group.visible || c.wrecked) continue;
      const d = Math.hypot(c.pos.x - me.x, c.pos.z - me.z);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  };
  const carAnchor = (v: Vehicle) => () => ({ x: v.pos.x, y: v.y, z: v.pos.z, heading: v.heading });

  game.events.on('busted', () => {
    const unit = nearestUnit();
    const where = at({ ...focusPos() }, player.y);
    const shots: Shot[] = [];
    if (unit) shots.push({ dur: 1.2, at: carAnchor(unit), az: 40, dist: 4.2, h: 0.5, look: 1.5, fov: 45 });
    shots.push({ dur: 1.5, at: where, az: 180, dist: 5.5, distTo: 2.8, h: 1.1, look: 1.2, fov: 42 });
    cutscene.play('busted', shots, { repeatGuard: 0 });
  });
  game.events.on('wrecked', (payload) => {
    const o = payload && typeof payload === 'object' ? (payload as { player?: unknown; vehicle?: unknown }) : {};
    const mine = o.player !== undefined || (o.vehicle !== undefined && o.vehicle === current);
    if (!mine) return;
    const where = at({ ...focusPos() }, current ? current.y : player.y);
    cutscene.play('wrecked', [{ dur: 2.5, at: where, az: 30, drift: 70, dist: 9, h: 5, look: 0.8, fov: 48 }], { repeatGuard: 0 });
  });
  let lastStars = 0;
  game.events.on('wantedChanged', (payload) => {
    const stars = (payload as { stars?: number })?.stars ?? 0;
    const rising = stars > lastStars;
    lastStars = stars;
    if (!rising) return;
    if (stars === CFG.police.helicopterStars) {
      const heli = police.helicopter;
      cutscene.play('heli', [{
        dur: 2.2, at: () => ({ x: heli.position.x, y: 35, z: heli.position.z }), az: 20, drift: 25, dist: 18, h: -6, lookAt: focusAnchor, look: 8, fov: 40,
      }]);
      toastFn('Heat: five stars', 1.5);
    } else if (stars === 3) {
      const unit = nearestUnit();
      if (!unit) return;
      cutscene.play('three', [{ dur: 2, at: carAnchor(unit), az: 200, drift: 30, dist: 6, h: 1.4, lookAt: focusAnchor, look: 1, fov: 42 }]);
      toastFn('Heat: three stars', 1.5);
    }
  });
  game.events.on('roadblock', (payload) => {
    const rb = payload as { x: number; z: number };
    if (!current) return;
    const car = current;
    cutscene.play('roadblock', [{ dur: 1.5, at: carAnchor(car), az: 180, dist: 3, h: 1.1, lookAt: at({ x: rb.x, z: rb.z }, 0.5), look: 0.8, fov: 40 }]);
  });
  game.events.on('enteredVehicle', (payload) => {
    const v = (payload as { vehicle?: Vehicle })?.vehicle;
    if (!v) return;
    const stolen = v.kind === 'police';
    if (stolen) toastFn('Stolen: a cruiser', 1.5);
    cutscene.play(stolen ? 'cruiser' : 'first-car', [{ dur: 1.5, at: carAnchor(v), az: 180, dist: 5, h: 1.0, look: 0.9, fov: 42 }],
      { repeatGuard: stolen ? 30 : 1e9 });
  });
  let pierWas: string = 'none';
  const wheelFoot = { x: PIER_WHEEL.x, z: PIER_WHEEL.z };
  game.add({
    update: () => {
      const now = pierPlay.activity;
      if (now !== pierWas) {
        if (now === 'ride') {
          cutscene.play('ride', [
            { dur: 3, at: at({ x: wheelFoot.x, z: wheelFoot.z + 16 }, 1.6), az: 0, dist: 0.01, h: 0, lookAt: playerAnchor, look: 0.8, fov: 55 },
            { dur: 4, at: playerAnchor, az: 180, dist: 5.5, h: 0.6, look: 1.0, fov: 60, drift: -25 },
          ], { repeatGuard: 1e9 });
        } else if (now === 'dive') {
          const spot = at({ ...player.pos }, player.y);
          cutscene.play('dive', [
            { dur: 1.5, at: spot, az: 90, dist: 9, h: 1.2, lookAt: playerAnchor, look: 0.8, fov: 50 },
            { dur: 1.5, at: spot, az: 180, dist: 7, h: -0.6, lookAt: playerAnchor, look: 0.4, fov: 50 },
          ], { repeatGuard: 20 });
        }
        pierWas = now;
      }
    },
  });

  const session: Session = {
    city, vehicles, traffic, peds, player, driver, rig, dance, heroRig, combat, wanted, look,
    intro, police, officers, props, signals, pier, pierPlay, cutscene,
    get playerVehicle() { return current; },
    // Assigned below: createUi needs the session it reads state from.
    ui: null as unknown as Ui,
  };

  // UI runs last in the system order (plan 1.1), so it renders the state every
  // other system has already settled this step.
  session.ui = createUi(game, session, screens);
  toastFn = (text, seconds) => session.ui.toast(text, seconds);
  // The HUD reads combat and look state every frame rather than being pushed
  // to, so nothing has to remember to tell it when a state changes.
  game.add({
    update: () => {
      session.ui.setArmed(combat.armed, combat.aiming, combat.shots);
      session.ui.setMinimapPolice(police.positions());
      session.ui.setGoofy(heroRig?.locomotion.goofy === true);
      session.ui.setLookHint(!look.locked);
      // Tell the player there is a car to get into. Everything else in the
      // game announces itself; a parked car three metres away did not, and a
      // control nobody knows about is a control that does not exist.
      session.ui.setPrompt(
        cutscene.active ? null : current !== null
          ? 'E   GET OUT'
          : (findEnterable(allVehicles, player.pos, CFG.player.enterRadius) ? 'E   GET IN' : pierPlay.prompt),
      );
    },
  });
  game.add(session.ui);
  session.ui.showTitle();

  return session;
}
