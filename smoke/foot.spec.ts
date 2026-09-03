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
    __game: { ready: boolean; fps: number; calls: number; game: { time: number } };
  }
}

async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENS, { recursive: true });
  const file = path.join(SCREENS, `foot-${name}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`);
  await page.screenshot({ path: file });
  console.log(`screenshot: ${file}`);
}

/**
 * Wait until the fixed-step simulation has advanced `seconds`.
 *
 * Wall-clock waits are not a proxy for simulated time: the loop clamps how much
 * wall time one frame may simulate (CFG.feel.loop.maxFrame), so on a slow
 * software renderer the world advances slower than the clock. Assertions about
 * how far the player moved have to be phrased in simulated seconds.
 */
async function advanceSim(page: Page, seconds: number): Promise<void> {
  await page.waitForFunction(
    (s) => {
      const w = window as unknown as { __t0?: number };
      const now = window.__game.game.time;
      if (w.__t0 === undefined) w.__t0 = now;
      if (now - w.__t0 < (s as number)) return false;
      w.__t0 = undefined;
      return true;
    },
    seconds,
    { timeout: 30_000, polling: 50 },
  );
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

/** Index into __session.vehicles of the parked car nearest the player. */
function nearestVehicleIndex(page: Page): Promise<number> {
  return page.evaluate(() => {
    const s = window.__session;
    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < s.vehicles.length; i++) {
      const v = s.vehicles[i];
      const d = Math.hypot(v.pos.x - s.player.pos.x, v.pos.z - s.player.pos.z);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    return bestI;
  });
}

/**
 * Steer on foot towards a world point using only the WASD keys, re-aiming
 * every tick from the player's current camera-follow heading (movement is
 * camera-relative, plan section 5) since there is no direct "walk to" API.
 * Reads state and sets keys in one round trip per tick to keep this fast.
 */
async function walkToward(page: Page, carIndex: number, stopDist: number, maxMs: number): Promise<number> {
  const t0 = Date.now();
  let dist = Infinity;
  for (;;) {
    // Aim at the car's LIVE position and (when close enough) release, in ONE
    // round trip. The player now carries momentum, so releasing across five
    // sequential evaluates lets them sprint metres past the car with the keys
    // still down; and traffic can nudge a parked car while we walk to it.
    const r = await page.evaluate(([idx, stop]) => {
      const s = window.__session;
      const car = s.vehicles[idx as number].pos;
      const dx = car.x - s.player.pos.x, dz = car.z - s.player.pos.z;
      const d = Math.hypot(dx, dz);
      const keys = window.__input;
      if (d <= (stop as number)) {
        for (const c of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ShiftLeft']) keys.set(c, false);
        return { d, arrived: true };
      }
      const worldAngle = Math.atan2(dx, dz);
      let local = worldAngle - s.player.velocityHeading;
      local = Math.atan2(Math.sin(local), Math.cos(local)); // wrap to [-PI, PI]
      // Screen-right is d x up = (-sin(h), cos(h)), so a target at a LARGER
      // heading than the player sits to the screen-left. Hence the negation:
      // positive `local` means press A, not D.
      const ix = -Math.sin(local), iz = Math.cos(local);
      // Walk, don't sprint, for the last stretch: 8 m/s of momentum overshoots
      // the enter radius before the keys can come back up.
      keys.set('ShiftLeft', d > 12);
      keys.set('KeyW', iz > 0.3);
      keys.set('KeyS', iz < -0.3);
      keys.set('KeyD', ix > 0.3);
      keys.set('KeyA', ix < -0.3);
      return { d, arrived: false };
    }, [carIndex, stopDist] as const);
    dist = r.d;
    if (r.arrived || Date.now() - t0 > maxMs) break;
    await page.waitForTimeout(60);
  }
  await releaseAll(page);
  // Let the deceleration ramp finish before anything reads the position.
  await advanceSim(page, 0.3);
  return page.evaluate((idx) => {
    const s = window.__session;
    const car = s.vehicles[idx as number].pos;
    return Math.hypot(car.x - s.player.pos.x, car.z - s.player.pos.z);
  }, carIndex);
}

test('walks on foot, enters a car, drives it, and exits beside it', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/?intro=0');
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 30_000 });
  await page.waitForFunction(() => typeof window.__session?.player?.pos?.x === 'number', null, { timeout: 10_000 });
  // Let the shader-compilation frames go by before anything is timed.
  await advanceSim(page, 1.0);

  // --- 1. spawns on foot, walking moves the player ------------------------
  const start = await state(page);
  expect(start.onFoot).toBe(true);
  await shoot(page, 'spawn');

  await setKey(page, 'KeyW', true);
  await advanceSim(page, 1.2);
  await setKey(page, 'KeyW', false);
  const walked = await state(page);
  const walkedDist = Math.hypot(walked.px - start.px, walked.pz - start.pz);
  console.log(`walk: moved ${walkedDist.toFixed(2)} m`);
  expect(walkedDist).toBeGreaterThan(1.5);
  await shoot(page, 'walking');

  // --- 2. walk to the nearest parked car and enter it ----------------------
  const carIndex = await nearestVehicleIndex(page);
  // The generated city can place the nearest car well over a hundred metres
  // from the boardwalk spawn; teleport to a clear approach 6 m out so this
  // spec stays fast and isn't a fragile cross-city obstacle walk. The final
  // steps into enter range, and the enter/drive/exit sequence, are all real
  // window.__input-driven simulation.
  await page.evaluate((idx) => {
    const s = window.__session;
    const car = s.vehicles[idx as number].pos;
    s.player.pos.x = car.x - 6;
    s.player.pos.z = car.z;
  }, carIndex);
  const distToCar = await walkToward(page, carIndex, 2.6, 15_000);
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
  await advanceSim(page, 0.4);
  await setKey(page, 'KeyW', false);
  const afterDrive = await page.evaluate(() => window.__session.playerVehicle!.pos);
  const drove = Math.hypot(afterDrive.x - beforeDrive.x, afterDrive.z - beforeDrive.z);
  console.log(`drive: moved ${drove.toFixed(2)} m`);
  expect(drove).toBeGreaterThan(2);
  await shoot(page, 'driving');

  // --- 4. exit puts the player back on foot beside the car ------------------
  await advanceSim(page, 0.6); // let it coast down before stepping out
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
