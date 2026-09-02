// Phase 1 dev scene: generate the city, build every world mesh and park the
// camera. `?cam=drone` (default) or `?cam=street`.
import * as THREE from 'three';
import type { Game } from '../core/game';
import { Rng, SEED, param } from '../core/rng';
import { generateCity, type CityLayout } from '../world/cityGen';
import { buildGround } from '../world/ground';
import { buildBuildings } from '../world/buildings';
import { buildProps } from '../world/props';
import { buildWater } from '../world/water';

/**
 * The sky rig is tuned for street level. A drone sitting 350 m up sees far past
 * the fog wall built for a windscreen, so the aerial view thins it out.
 * Phase 8's drone camera mode will want the same.
 */
function tuneForDrone(game: Game): void {
  if (game.scene.fog instanceof THREE.FogExp2) game.scene.fog.density = 0.0006;
}

/** Cheap order-sensitive signature over the generated layout. */
function signature(city: CityLayout): number {
  let h = 2166136261;
  const mix = (v: number): void => { h = Math.imul(h ^ (v | 0), 16777619) >>> 0; };
  for (const b of city.blocks) {
    for (const d of b.buildings) {
      mix(d.bounds.minX * 100); mix(d.bounds.minZ * 100);
      mix(d.height * 100); mix(d.colorIdx);
    }
  }
  mix(city.colliders.length);
  mix(city.roads.lanes.length);
  mix(city.spawns.policeStation.x * 100);
  return h;
}

export function setup(game: Game): void {
  const t0 = performance.now();
  const city = generateCity(new Rng(SEED));
  const genMs = performance.now() - t0;

  const t1 = performance.now();
  game.scene.add(buildGround(city));
  game.scene.add(buildBuildings(city));
  game.scene.add(buildProps(city));

  const water = buildWater(game.sky.sunDir);
  game.scene.add(water.mesh);
  let t = 0;
  game.add({ update: (dt: number) => { t += dt; water.update(t); } });
  const meshMs = performance.now() - t1;

  const mode = param('cam') === 'street' ? 'street' : 'drone';
  if (mode === 'street') {
    // Eye height 1.7 m on the boardwalk deck, looking down the beach avenue.
    const s = city.spawns.player;
    if (game.scene.fog instanceof THREE.FogExp2) game.scene.fog.density = 0.0021;
    game.camera.fov = 62;
    game.camera.position.set(s.x, 1.7 + 0.32, s.z);
    game.camera.lookAt(s.x, 3.4, s.z + 90);
  } else {
    // Sun sits toward (-X,-Z), so its shadows fall toward (+X,+Z). Standing the
    // drone off to the side of that axis rather than along it is what makes the
    // long shadows read as length instead of foreshortening to nothing.
    tuneForDrone(game);
    game.camera.fov = 62;
    if (param('lanes') === '1') {
      game.camera.position.set(-330, 95, -300);
      game.camera.lookAt(-380, 0, -380);
    } else {
      game.camera.position.set(880, 330, -560);
      game.camera.lookAt(-90, 20, 120);
    }
  }
  game.camera.updateProjectionMatrix();

  // One-shot diagnostics. console.log only: the smoke test fails on errors.
  const t2 = performance.now();
  const same = signature(generateCity(new Rng(SEED))) === signature(city);
  const regenMs = performance.now() - t2;

  const from = city.roads.nearestLane(city.spawns.player);
  const to = city.roads.nearestLane(city.spawns.missions[0]);
  const t3 = performance.now();
  const route = city.roads.path(from.lane.id, to.lane.id);
  const pathMs = performance.now() - t3;
  const routeLen = route.reduce((a, l) => a + l.length, 0);

  // `?lanes=1` overlays the lane graph (one extra draw call) so later phases can
  // eyeball what traffic will actually be following.
  if (param('lanes') === '1') {
    const pts: number[] = [];
    for (const lane of city.roads.lanes) {
      for (let i = 1; i < lane.points.length; i++) {
        pts.push(lane.points[i - 1].x, 0.6, lane.points[i - 1].z, lane.points[i].x, 0.6, lane.points[i].z);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    game.scene.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x00ff88, fog: false })));
  }

  const summary = {
    seed: SEED,
    cam: mode,
    genMs: +genMs.toFixed(1),
    meshMs: +meshMs.toFixed(1),
    blocks: city.blocks.length,
    parks: city.parks.length,
    buildings: city.buildingCount,
    colliders: city.colliders.length,
    nodes: city.roads.nodes.length,
    lanes: city.roads.lanes.length,
    props: city.props.palms.length + city.props.streetlights.length + city.props.trafficLights.length,
    beachEdge: city.beachEdge,
    deterministic: same,
    regenMs: +regenMs.toFixed(1),
    nearestLane: from.lane.id,
    nearestT: +from.t.toFixed(3),
    routeLanes: route.length,
    routeMetres: Math.round(routeLen),
    pathMs: +pathMs.toFixed(2),
  };
  console.log('[phase1] city', JSON.stringify(summary));
  window.setTimeout(() => {
    const info = game.renderer.info.render;
    console.log(`[phase1] drawCalls=${info.calls} triangles=${info.triangles} fps=${game.fps.toFixed(1)}`);
  }, 2500);
}
