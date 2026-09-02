// Phase 2 driving assertions. Runs against the ?phase=2 dev scene, which exposes
// window.__vehicle and drives input through window.__input.
import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
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
  // Headless SwiftShader steps the fixed-timestep loop slower than wall clock,
  // so poll for the threshold instead of trusting exactly 3 s of wall time.
  await page.waitForFunction(() => window.__vehicle.speed > 20, null, { timeout: 20_000 });
  await page.waitForTimeout(1000);
  const moving = await probe(page);
  console.log(`accel: speed=${moving.speed.toFixed(1)} dz=${(moving.z - start.z).toFixed(1)}`);
  expect(moving.speed).toBeGreaterThan(20);
  expect(Math.hypot(moving.x - start.x, moving.z - start.z)).toBeGreaterThan(20);
  await shoot(page, 'driving');

  // --- 2. handbrake turn --------------------------------------------------
  await key(page, 'KeyW', false);
  await reset(page, 0, -80, 0);
  await key(page, 'KeyW', true);
  await page.waitForFunction(() => window.__vehicle.speed > 24, null, { timeout: 20_000 });
  const beforeTurn = await probe(page);
  await key(page, 'KeyD', true);
  await key(page, 'Space', true);
  await page.waitForTimeout(900);
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
  await page.waitForFunction(() => window.__vehicle.health < 100, null, { timeout: 20_000 });
  await key(page, 'KeyW', false);
  await page.waitForTimeout(600);
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
  await page.waitForFunction(() => window.__vehicle.health < 69, null, { timeout: 20_000 });
  await key(page, 'KeyW', false);
  await page.waitForTimeout(500);
  const smoking = await probe(page);
  console.log(`smoke test: health=${smoking.health.toFixed(0)} wrecked=${smoking.wrecked}`);
  expect(smoking.health).toBeLessThan(40);
  await page.waitForTimeout(1200);
  await shoot(page, 'smoke');

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});
