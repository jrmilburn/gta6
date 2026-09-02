// Phase 3 on-foot assertions. Runs against the real integrated game (no
// ?phase=), which exposes window.__session (main.ts) built by createSession.
import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SCREENS = path.resolve('screens');

interface Vec2 { x: number; z: number }
interface VehicleProbe { pos: Vec2; speed: number; wrecked: boolean; occupied: boolean }
interface SessionProbe {
  player: { pos: Vec2; heading: number; velocityHeading: number; onFoot: boolean; health: number };
  vehicles: VehicleProbe[];
  playerVehicle: VehicleProbe | null;
}

declare global {
  interface Window {
    __session: SessionProbe;
    __input: { set(code: string, down: boolean): void; tap(code: string): void };
    __game: { ready: boolean; fps: number; calls: number };
  }
}

async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENS, { recursive: true });
  const file = path.join(SCREENS, `foot-${name}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`);
  await page.screenshot({ path: file });
  console.log(`screenshot: ${file}`);
}

const setKey = (page: Page, code: string, down: boolean) =>
  page.evaluate(([c, d]) => window.__input.set(c as string, d as boolean), [code, down] as const);

async function releaseAll(page: Page): Promise<void> {
  for (const c of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ShiftLeft']) await setKey(page, c, false);
}

function state(page: Page) {
  return page.evaluate(() => {
    const s = window.__session;
    return {
      px: s.player.pos.x, pz: s.player.pos.z,
      vh: s.player.velocityHeading, onFoot: s.player.onFoot, health: s.player.health,
    };
  });
}

function nearestVehicle(page: Page) {
  return page.evaluate(() => {
    const s = window.__session;
    let best = s.vehicles[0], bestD = Infinity;
    for (const v of s.vehicles) {
      const d = Math.hypot(v.pos.x - s.player.pos.x, v.pos.z - s.player.pos.z);
      if (d < bestD) { bestD = d; best = v; }
    }
    return { x: best.pos.x, z: best.pos.z };
  });
}

/**
 * Steer on foot towards a world point using only the WASD keys, re-aiming
 * every tick from the player's current camera-follow heading (movement is
 * camera-relative, plan section 5) since there is no direct "walk to" API.
 * Reads state and sets keys in one round trip per tick to keep this fast.
 */
async function walkToward(page: Page, target: Vec2, stopDist: number, maxMs: number): Promise<Vec2> {
  await setKey(page, 'ShiftLeft', true); // run
  const t0 = Date.now();
  let last: Vec2 = target;
  for (;;) {
    last = await page.evaluate(([tx, tz]) => {
      const s = window.__session;
      const dx = (tx as number) - s.player.pos.x, dz = (tz as number) - s.player.pos.z;
      const worldAngle = Math.atan2(dx, dz);
      let local = worldAngle - s.player.velocityHeading;
      local = Math.atan2(Math.sin(local), Math.cos(local)); // wrap to [-PI, PI]
      const ix = Math.sin(local), iz = Math.cos(local);
      window.__input.set('KeyW', iz > 0.3);
      window.__input.set('KeyS', iz < -0.3);
      window.__input.set('KeyD', ix > 0.3);
      window.__input.set('KeyA', ix < -0.3);
      return { x: s.player.pos.x, z: s.player.pos.z };
    }, [target.x, target.z] as const);
    const dist = Math.hypot(target.x - last.x, target.z - last.z);
    if (dist <= stopDist || Date.now() - t0 > maxMs) break;
    await page.waitForTimeout(100);
  }
  await releaseAll(page);
  return last;
}

test('walks on foot, enters a car, drives it, and exits beside it', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 30_000 });
  await page.waitForFunction(() => typeof window.__session?.player?.pos?.x === 'number', null, { timeout: 10_000 });

  // --- 1. spawns on foot, walking moves the player ------------------------
  const start = await state(page);
  expect(start.onFoot).toBe(true);
  await shoot(page, 'spawn');

  await setKey(page, 'KeyW', true);
  await page.waitForTimeout(1200);
  await setKey(page, 'KeyW', false);
  const walked = await state(page);
  const walkedDist = Math.hypot(walked.px - start.px, walked.pz - start.pz);
  console.log(`walk: moved ${walkedDist.toFixed(2)} m`);
  expect(walkedDist).toBeGreaterThan(1.5);
  await shoot(page, 'walking');

  // --- 2. walk to the nearest parked car and enter it ----------------------
  const target = await nearestVehicle(page);
  // The generated city can place the nearest car well over a hundred metres
  // from the boardwalk spawn; teleport to a clear approach 6 m out so this
  // spec stays fast and isn't a fragile cross-city obstacle walk. The final
  // steps into enter range, and the enter/drive/exit sequence, are all real
  // window.__input-driven simulation.
  await page.evaluate((t) => {
    const p = window.__session.player.pos;
    p.x = t.x - 6;
    p.z = t.z;
  }, target);
  const nearCar = await walkToward(page, target, 3.0, 15_000);
  const distToCar = Math.hypot(target.x - nearCar.x, target.z - nearCar.z);
  console.log(`approach: dist to car = ${distToCar.toFixed(2)} m`);
  expect(distToCar).toBeLessThan(3.5);

  await page.evaluate(() => window.__input.tap('KeyE'));
  await page.waitForFunction(() => window.__session.player.onFoot === false, null, { timeout: 5_000 });
  const entered = await page.evaluate(() => ({
    onFoot: window.__session.player.onFoot,
    hasVehicle: window.__session.playerVehicle !== null,
  }));
  expect(entered.onFoot).toBe(false);
  expect(entered.hasVehicle).toBe(true);
  await shoot(page, 'entered');

  // --- 3. driving moves the car --------------------------------------------
  const beforeDrive = await page.evaluate(() => window.__session.playerVehicle!.pos);
  await setKey(page, 'KeyW', true);
  await page.waitForFunction(() => (window.__session.playerVehicle?.speed ?? 0) > 5, null, { timeout: 15_000 });
  await page.waitForTimeout(400);
  await setKey(page, 'KeyW', false);
  const afterDrive = await page.evaluate(() => window.__session.playerVehicle!.pos);
  const drove = Math.hypot(afterDrive.x - beforeDrive.x, afterDrive.z - beforeDrive.z);
  console.log(`drive: moved ${drove.toFixed(2)} m`);
  expect(drove).toBeGreaterThan(2);
  await shoot(page, 'driving');

  // --- 4. exit puts the player back on foot beside the car ------------------
  await page.waitForTimeout(600); // let it coast down before stepping out
  const carAtExit = await page.evaluate(() => window.__session.playerVehicle!.pos);
  await page.evaluate(() => window.__input.tap('KeyE'));
  await page.waitForFunction(() => window.__session.player.onFoot === true, null, { timeout: 5_000 });
  const exited = await state(page);
  const distFromCar = Math.hypot(exited.px - carAtExit.x, exited.pz - carAtExit.z);
  console.log(`exit: dist from car = ${distFromCar.toFixed(2)} m`);
  expect(exited.onFoot).toBe(true);
  expect(distFromCar).toBeLessThan(4);
  const noLongerDriving = await page.evaluate(() => window.__session.playerVehicle === null);
  expect(noLongerDriving).toBe(true);
  await shoot(page, 'exited');

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});
