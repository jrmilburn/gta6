// The pier: ride the wheel, dive off the end, drive through the bollards, and
// find people on it. Screenshots to screens/pier/.
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('screens', 'pier');
type V3 = [number, number, number];

declare global {
  interface Window {
    __session: {
      player: {
        pos: { x: number; z: number }; y: number; swimming: boolean; carry: unknown;
        placeAt(x: number, z: number, heading: number): void;
      };
      pierPlay: { prompt: string | null; rides: number; active: boolean };
      pier: { wheel: { loadZone: { x: number; z: number } }; bollards: Array<{ standing: boolean }>; dive: { pos: { x: number; z: number } } };
      peds: { list(): Array<{ x: number; z: number; mode: string }> };
      vehicles: Array<{ pos: { x: number; z: number }; y: number; controls: { throttle: number; steer: number }; reset(x: number, z: number, h: number): void }>;
      city: unknown;
    };
    __input: { set(code: string, down: boolean): void; tap(code: string): void };
    __game: { game: { time: number }; ready: boolean };
    __shots: { detach(): void; attach(): void; look(eye: V3, target: V3, fov: number): void };
  }
}

test.use({ viewport: { width: 960, height: 540 } });

async function ready(page: Page, query: string): Promise<void> {
  await page.goto(`/${query}`);
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 90_000 });
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousedown')));
  await page.waitForTimeout(2500);
}

async function sim(page: Page, seconds: number): Promise<void> {
  await page.evaluate(async (secs: number) => {
    const end = window.__game.game.time + secs;
    while (window.__game.game.time < end) await new Promise((r) => setTimeout(r, 30));
  }, seconds);
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`screenshot: ${file}`);
}

const PIER = { minX: -8, maxX: 8, minZ: -652, maxZ: -502 };

test('the wheel, the dive, the bollards and the crowd', async ({ page }) => {
  test.setTimeout(1_200_000);
  await ready(page, '?peds=48&traffic=0&post=0&shadows=0&intro=0&nohud=1&ticks=20');

  // --- people on the pier from the start -----------------------------------------
  await sim(page, 2);
  const onPier = await page.evaluate((P) => window.__session.peds.list()
    .filter((q) => q.x > P.minX && q.x < P.maxX && q.z > P.minZ && q.z < P.maxZ).length, PIER);
  console.log(`pier: ${onPier} pedestrians on it`);
  expect(onPier).toBeGreaterThanOrEqual(3);

  // --- a wide from the beach, and the wheel ------------------------------------------
  await page.evaluate(() => window.__shots.detach());
  await page.evaluate(() => window.__shots.look([-60, 9, -470], [0, 8, -600], 50));
  await page.waitForTimeout(600);
  await shot(page, 'wide');
  await page.evaluate(() => window.__shots.look([22, 6, -600], [0, 12, -630], 55));
  await page.waitForTimeout(600);
  await shot(page, 'wheel');
  await page.evaluate(() => window.__shots.attach());

  // --- ride ---------------------------------------------------------------------------
  const zone = await page.evaluate(() => window.__session.pier.wheel.loadZone);
  await page.evaluate((z) => window.__session.player.placeAt(z.x, z.z + 0.3, Math.PI), zone);
  await sim(page, 0.5);
  // Wait for a gondola to come round to the bottom, then board.
  await page.waitForFunction(() => window.__session.pierPlay.prompt === 'E   RIDE THE WHEEL', null, { timeout: 300_000 });
  await page.evaluate(() => window.__input.tap('KeyE'));
  await sim(page, 1);
  expect(await page.evaluate(() => window.__session.player.carry !== null), 'riding').toBe(true);
  await sim(page, 16);
  const yUp = await page.evaluate(() => window.__session.player.y);
  console.log(`ride: ${yUp.toFixed(1)} m up after 16 s`);
  expect(yUp).toBeGreaterThan(6);
  await shot(page, 'ride');
  await sim(page, 20);
  await shot(page, 'ride-top');
  await page.waitForFunction(() => window.__session.pierPlay.rides >= 1, null, { timeout: 600_000 });
  expect(await page.evaluate(() => window.__session.player.carry === null), 'back on the deck').toBe(true);

  // --- dive ---------------------------------------------------------------------------
  const dive = await page.evaluate(() => window.__session.pier.dive.pos);
  await page.evaluate((d) => window.__session.player.placeAt(d.x, d.z + 0.5, Math.PI), dive);
  await sim(page, 0.5);
  await page.waitForFunction(() => window.__session.pierPlay.prompt === 'E   DIVE', null, { timeout: 30_000 });
  await page.evaluate(() => window.__input.tap('KeyE'));
  await sim(page, 0.6);
  await shot(page, 'dive');
  await sim(page, 3);
  const swim = await page.evaluate(() => ({ swimming: window.__session.player.swimming, y: window.__session.player.y, z: window.__session.player.pos.z }));
  console.log(`dive: swimming=${swim.swimming} y=${swim.y.toFixed(2)} z=${swim.z.toFixed(1)}`);
  expect(swim.swimming).toBe(true);
  expect(swim.y).toBeLessThan(-0.8);
  expect(swim.z).toBeLessThan(PIER.minZ);
  await shot(page, 'swim');

  // --- a car through the bollards ------------------------------------------------------
  await page.evaluate((P) => {
    const v = window.__session.vehicles[0];
    v.reset(0, P.maxZ + 14, Math.PI);
    v.controls.throttle = 1;
    v.controls.steer = 0;
  }, PIER);
  await sim(page, 5);
  const car = await page.evaluate(() => {
    const v = window.__session.vehicles[0];
    v.controls.throttle = 0;
    return { z: v.pos.z, y: v.y, down: window.__session.pier.bollards.filter((b) => !b.standing).length };
  });
  console.log(`car: z=${car.z.toFixed(1)} y=${car.y.toFixed(2)}, ${car.down} bollards down`);
  expect(car.z).toBeLessThan(PIER.maxZ - 8);
  expect(car.y).toBeGreaterThan(0.2);
  expect(car.down).toBeGreaterThanOrEqual(1);
});
