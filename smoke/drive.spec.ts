// Phase 2 driving assertions. Runs against the ?phase=2 dev scene, which exposes
// window.__vehicle and drives input through window.__input.
import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

/**
 * Wait until the fixed-step simulation has advanced `seconds`.
 *
 * Every window that measures how far the car got has to be phrased in simulated
 * time: the loop clamps how much wall time one frame may simulate, so on the
 * software rasteriser 900 ms of wall clock can be 90 ms of driving, and a
 * handbrake turn measured that way reads as 5 degrees instead of 90.
 */
async function advanceSim(page: Page, seconds: number): Promise<void> {
  await page.waitForFunction(
    (s) => {
      const w = window as unknown as { __simT0?: number; __game: { game: { time: number } } };
      const now = w.__game.game.time;
      if (w.__simT0 === undefined) w.__simT0 = now;
      if (now - w.__simT0 < (s as number)) return false;
      w.__simT0 = undefined;
      return true;
    },
    seconds,
    { timeout: 300_000, polling: 100 },
  );
}
import fs from 'node:fs';
import path from 'node:path';

const SCREENS = path.resolve('screens');

interface VehicleProbe {
  speed: number; x: number; z: number; health: number; heading: number; wrecked: boolean;
  reset(x: number, z: number, heading?: number): void;
  vehicle: { health: number };
}

declare global {
  interface Window {
    __vehicle: VehicleProbe;
    __input: { set(code: string, down: boolean): void; tap(code: string): void };
    __game: { ready: boolean; fps: number; calls: number };
  }
}

type Snapshot = Omit<VehicleProbe, 'reset' | 'vehicle'>;

function probe(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const v = window.__vehicle;
    return { speed: v.speed, x: v.x, z: v.z, health: v.health, heading: v.heading, wrecked: v.wrecked };
  });
}

const key = (page: Page, code: string, down: boolean) =>
  page.evaluate(([c, d]) => window.__input.set(c as string, d as boolean), [code, down] as const);

const reset = (page: Page, x: number, z: number, h = 0) =>
  page.evaluate(([px, pz, ph]) => window.__vehicle.reset(px, pz, ph), [x, z, h] as const);

async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENS, { recursive: true });
  const file = path.join(SCREENS, `phase2-${name}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`);
  await page.screenshot({ path: file });
  console.log(`screenshot: ${file}`);
}

test('drives, drifts and crashes', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/?phase=2');
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 30_000 });
  await page.waitForFunction(() => typeof window.__vehicle?.speed === 'number', null, { timeout: 10_000 });

  // --- 1. accelerate ------------------------------------------------------
  const start = await probe(page);
  await key(page, 'KeyW', true);
  // Headless SwiftShader steps the fixed-timestep loop far slower than wall
  // clock, so poll for the threshold rather than trusting a wall-time window --
  // and give it room, because how much slower depends on what else the machine
  // is doing and has ranged over an order of magnitude within one session.
  await page.waitForFunction(() => window.__vehicle.speed > 20, null, { timeout: 180_000 });
  await advanceSim(page, 1.0);
  const moving = await probe(page);
  console.log(`accel: speed=${moving.speed.toFixed(1)} dz=${(moving.z - start.z).toFixed(1)}`);
  expect(moving.speed).toBeGreaterThan(20);
  expect(Math.hypot(moving.x - start.x, moving.z - start.z)).toBeGreaterThan(20);
  await shoot(page, 'driving');

  // --- 2. handbrake turn --------------------------------------------------
  await key(page, 'KeyW', false);
  await reset(page, 0, -80, 0);
  await key(page, 'KeyW', true);
  await page.waitForFunction(() => window.__vehicle.speed > 24, null, { timeout: 180_000 });
  const beforeTurn = await probe(page);
  await key(page, 'KeyD', true);
  await key(page, 'Space', true);
  await advanceSim(page, 0.9);
  const afterTurn = await probe(page);
  await key(page, 'Space', false);
  await key(page, 'KeyD', false);
  await key(page, 'KeyW', false);
  const turned = Math.abs(afterTurn.heading - beforeTurn.heading);
  console.log(`handbrake turn: ${(turned * 180 / Math.PI).toFixed(0)} deg`);
  expect(turned).toBeGreaterThan(1.0);  // > 57 deg: the tail has come round
  expect(turned).toBeLessThan(2.6);     // < 149 deg: it is a turn, not a spin
  await shoot(page, 'drift');

  // --- 3. wall crash ------------------------------------------------------
  await reset(page, 0, 30, 0); // wall spans z = 84..88
  await key(page, 'KeyW', true);
  await page.waitForFunction(() => window.__vehicle.health < 100, null, { timeout: 180_000 });
  await key(page, 'KeyW', false);
  await advanceSim(page, 0.6);
  const crashed = await probe(page);
  console.log(`crash: health=${crashed.health.toFixed(0)} speed=${crashed.speed.toFixed(1)} z=${crashed.z.toFixed(1)}`);
  expect(crashed.health).toBeLessThan(100);
  expect(Math.abs(crashed.speed)).toBeLessThan(12);
  await shoot(page, 'crash');

  // --- 4. damage smoke below 40 health ------------------------------------
  await reset(page, 0, 30, 0);
  // Second crash on a car that is already banged up drops it under the smoke
  // threshold without wrecking it outright.
  await page.evaluate(() => { window.__vehicle.vehicle.health = 70; });
  await key(page, 'KeyW', true);
  await page.waitForFunction(() => window.__vehicle.health < 69, null, { timeout: 180_000 });
  await key(page, 'KeyW', false);
  await advanceSim(page, 0.5);
  const smoking = await probe(page);
  console.log(`smoke test: health=${smoking.health.toFixed(0)} wrecked=${smoking.wrecked}`);
  expect(smoking.health).toBeLessThan(40);
  await advanceSim(page, 1.2);
  await shoot(page, 'smoke');

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});
