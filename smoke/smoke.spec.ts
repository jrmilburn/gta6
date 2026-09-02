import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const PHASE = process.env.PHASE ?? 'phase0';
const MIN_FPS = Number(process.env.MIN_FPS ?? 50);
const SCREENS = path.resolve('screens');

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function shoot(page: Page, name: string): Promise<string> {
  fs.mkdirSync(SCREENS, { recursive: true });
  const file = path.join(SCREENS, `${PHASE}-${name}-${stamp()}.png`);
  await page.screenshot({ path: file });
  console.log(`screenshot: ${file}`);
  return file;
}

async function sampleFps(page: Page, seconds: number): Promise<number> {
  return page.evaluate(async (s: number) => {
    const g = (window as unknown as { __game: { fps: number } }).__game;
    const samples: number[] = [];
    const t0 = performance.now();
    while (performance.now() - t0 < s * 1000) {
      await new Promise((r) => setTimeout(r, 100));
      if (g.fps > 0) samples.push(g.fps);
    }
    return samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
  }, seconds);
}

test('boots, renders, holds framerate, no console errors', async ({ page }) => {
  const errors = collectErrors(page);
  const query = process.env.QUERY ?? '';
  await page.goto(`/${query}`);
  await page.waitForFunction(() => (window as unknown as { __game?: { ready: boolean } }).__game?.ready === true, null, { timeout: 30_000 });
  await page.waitForTimeout(4000);

  const fps = await sampleFps(page, 3);
  const g = await page.evaluate(() => {
    const w = window as unknown as { __game: { calls: number; sceneCalls: number; post: boolean } };
    return { calls: w.__game.calls, sceneCalls: w.__game.sceneCalls, post: w.__game.post };
  });
  // Two numbers: the post chain re-renders the scene for its AO prepass, so
  // `calls` counts the world's geometry more than once. `sceneCalls` is the
  // world's own complexity, which is what the budget is about.
  console.log(`fps=${fps.toFixed(1)} sceneDrawCalls=${g.sceneCalls} totalDrawCalls=${g.calls} post=${g.post}`);

  await shoot(page, 'main');

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  // SwiftShader in CI is far slower than the target hardware; the fps gate is
  // enforced only when MIN_FPS is set explicitly for a real-GPU run.
  if (process.env.ENFORCE_FPS === '1') expect(fps).toBeGreaterThanOrEqual(MIN_FPS);
  expect(fps).toBeGreaterThan(0);
});

test('runs fully procedural with the asset bundle skipped', async ({ page }) => {
  // ASSETS.md promises every downloaded category degrades to what the game
  // shipped with. `?assets=0` takes that path without deleting the files, so
  // the promise is checked rather than asserted.
  const errors = collectErrors(page);
  await page.goto('/?assets=0&nohud=1');
  await page.waitForFunction(() => (window as unknown as { __game?: { ready: boolean } }).__game?.ready === true, null, { timeout: 60_000 });
  await page.waitForTimeout(4000);

  const state = await page.evaluate(() => {
    const w = window as unknown as {
      __game: { sceneCalls: number; tris: number };
      __session: { vehicles: unknown[]; player: { pos: { x: number } } };
    };
    return {
      calls: w.__game.sceneCalls,
      tris: w.__game.tris,
      vehicles: w.__session.vehicles.length,
      spawned: typeof w.__session.player.pos.x === 'number',
    };
  });
  console.log(`procedural fallback: sceneDrawCalls=${state.calls} tris=${state.tris} vehicles=${state.vehicles}`);
  await shoot(page, 'procedural-fallback');

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  // A world still got built: geometry, cars and a placed player.
  expect(state.tris).toBeGreaterThan(10_000);
  expect(state.vehicles).toBeGreaterThan(0);
  expect(state.spawned).toBe(true);
});
