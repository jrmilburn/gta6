// Phase 4 traffic/pedestrian assertions. Runs against the real integrated
// game (no ?phase=), which exposes window.__session.traffic and
// window.__session.peds (core/session.ts).
import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SCREENS = path.resolve('screens');

interface Vec2 { x: number; z: number }
interface CarProbe { pos: Vec2; speed: number; wrecked: boolean }
interface PedProbe { x: number; z: number; mode: string; speed: number }

async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENS, { recursive: true });
  const file = path.join(SCREENS, `traffic-${name}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`);
  await page.screenshot({ path: file });
  console.log(`screenshot: ${file}`);
}

function trafficCars(page: Page): Promise<CarProbe[]> {
  return page.evaluate(() => {
    const s = (window as unknown as { __session: { traffic: { cars: CarProbe[] } } }).__session;
    return s.traffic.cars.map((c) => ({ pos: { x: c.pos.x, z: c.pos.z }, speed: c.speed, wrecked: c.wrecked }));
  });
}

function pedList(page: Page): Promise<PedProbe[]> {
  return page.evaluate(() => {
    const s = (window as unknown as { __session: { peds: { list(): PedProbe[] } } }).__session;
    return s.peds.list();
  });
}

function simTime(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __game: { game: { time: number } } }).__game.game.time);
}

test('traffic flows without gridlock, pedestrians wander, and scatter when driven at', async ({ page }) => {
  // The plan's bar is "does not pile up for 60 s", so this spec simulates a full
  // minute. Game.step() caps at 5 fixed ticks per rendered frame, so on the
  // software rasteriser (~7 fps) simulated time runs at roughly half real time
  // and that minute costs ~120 s of wall clock.
  test.setTimeout(320_000);
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { __game?: { ready: boolean } }).__game?.ready === true, null, { timeout: 30_000 });
  await page.waitForFunction(
    () => Array.isArray((window as unknown as { __session?: { traffic?: { cars: unknown[] } } }).__session?.traffic?.cars),
    null, { timeout: 10_000 },
  );

  // --- 1. traffic cars exist, are spread across the city, and are moving -----
  const cars0 = await trafficCars(page);
  expect(cars0.length).toBeGreaterThan(0);
  const xs = cars0.map((c) => c.pos.x), zs = cars0.map((c) => c.pos.z);
  const spreadX = Math.max(...xs) - Math.min(...xs);
  const spreadZ = Math.max(...zs) - Math.min(...zs);
  console.log(`traffic count=${cars0.length} spread: x=${spreadX.toFixed(0)}m z=${spreadZ.toFixed(0)}m`);
  expect(spreadX).toBeGreaterThan(100);
  expect(spreadZ).toBeGreaterThan(100);

  await page.waitForTimeout(4000);
  const cars1 = await trafficCars(page);
  const moving1 = cars1.filter((c) => Math.abs(c.speed) > 1).length;
  console.log(`moving after ~4s: ${moving1}/${cars1.length}`);
  expect(moving1).toBeGreaterThan(cars1.length * 0.3);
  await shoot(page, 'flowing');

  // --- 2. hold for 60 simulated seconds: no gridlock, cars don't pile up -----
  const t0 = await simTime(page);
  await page.waitForFunction((target: number) => {
    const g = (window as unknown as { __game: { game: { time: number } } }).__game;
    return g.game.time - target >= 60;
    // Game.step() caps at 5 fixed ticks per rendered frame, so on the software
    // rasteriser (~7 fps) simulated time advances at roughly half real time.
    // 60 simulated seconds can therefore take ~120 s of wall clock.
  }, t0, { timeout: 260_000 });
  const cars2 = await trafficCars(page);
  const moving2 = cars2.filter((c) => Math.abs(c.speed) > 1).length;
  console.log(`moving after 60 simulated seconds: ${moving2}/${cars2.length}`);
  expect(moving2).toBeGreaterThan(cars2.length * 0.3);
  await shoot(page, 'held-60s');

  // --- 3. pedestrians exist and wander ----------------------------------------
  const peds0 = await pedList(page);
  expect(peds0.length).toBeGreaterThan(0);
  await page.waitForTimeout(3000);
  const peds1 = await pedList(page);
  let totalMoved = 0;
  for (let i = 0; i < peds0.length; i++) totalMoved += Math.hypot(peds1[i].x - peds0[i].x, peds1[i].z - peds0[i].z);
  const avgMoved = totalMoved / peds0.length;
  console.log(`pedestrian avg movement over 3s: ${avgMoved.toFixed(2)} m`);
  expect(avgMoved).toBeGreaterThan(0.5);

  // --- 4. drive a car straight at a pedestrian: the crowd scatters -----------
  const target = peds1[0];
  // Put the car on the road lane nearest the pedestrian, backed up along that
  // lane, so it has clear tarmac to accelerate down. Offsetting blindly in +X
  // parks it inside a building and it never gets above walking pace.
  await page.evaluate((t: Vec2) => {
    const w = window as unknown as {
      __session: {
        city: { roads: { nearestLane(p: Vec2): { lane: { points: Vec2[] } } } };
        player: { pos: Vec2 };
        vehicles: Array<{ reset(x: number, z: number, h?: number): void }>;
      };
    };
    const pts = w.__session.city.roads.nearestLane(t).lane.points;
    // Closest vertex to the pedestrian, then walk back ~25 m up the polyline.
    let ci = 0, cd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - t.x, pts[i].z - t.z);
      if (d < cd) { cd = d; ci = i; }
    }
    let bi = ci, back = 0;
    while (bi > 0 && back < 25) {
      back += Math.hypot(pts[bi].x - pts[bi - 1].x, pts[bi].z - pts[bi - 1].z);
      bi--;
    }
    const from = pts[bi], to = pts[Math.min(bi + 1, pts.length - 1)];
    const heading = Math.atan2(to.x - from.x, to.z - from.z);
    w.__session.vehicles[0].reset(from.x, from.z, heading);
    w.__session.player.pos.x = from.x;
    w.__session.player.pos.z = from.z + 2; // within enterRadius
  }, target);
  await page.evaluate(() => (window as unknown as { __input: { tap(c: string): void } }).__input.tap('KeyE'));
  await page.waitForFunction(
    () => (window as unknown as { __session: { player: { onFoot: boolean } } }).__session.player.onFoot === false,
    null, { timeout: 5_000 },
  );

  // 40 traffic cars are already scaring pedestrians all over the city, so a
  // global flee count says nothing about OUR car. Measure only pedestrians
  // close to the player's car, sampled across the drive, since the ones it
  // frightens are left behind as it passes them.
  const carState = (): Promise<{ x: number; z: number; speed: number }> => page.evaluate(() => {
    const v = (window as unknown as { __session: { playerVehicle: { pos: Vec2; speed: number } } }).__session.playerVehicle;
    return { x: v.pos.x, z: v.pos.z, speed: v.speed };
  });

  const nearFleeing = async (): Promise<number> => {
    const [car, peds] = await Promise.all([carState(), pedList(page)]);
    return peds.filter((q) => (q.mode === 'flee' || q.mode === 'tumble')
      && Math.hypot(q.x - car.x, q.z - car.z) < 15).length;
  };

  const before = await nearFleeing();
  await page.evaluate(() => (window as unknown as { __input: { set(c: string, d: boolean): void } }).__input.set('KeyW', true));
  let peak = 0;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(500);
    peak = Math.max(peak, await nearFleeing());
  }
  await page.evaluate(() => (window as unknown as { __input: { set(c: string, d: boolean): void } }).__input.set('KeyW', false));
  const drove = await carState();
  console.log(`scatter: before=${before} peak-near-car=${peak} carSpeed=${drove.speed.toFixed(1)}`);
  expect(drove.speed).toBeGreaterThan(6);
  expect(peak).toBeGreaterThan(0);
  await shoot(page, 'scatter');

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});
