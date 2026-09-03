// Cutscenes: a bust plays its two shots on wall time and hands the camera back
// to the rig; the letterbox goes up and comes down with it.
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('screens', 'cutscene');

declare global {
  interface Window {
    __session: {
      cutscene: { active: boolean; shot: number; name: string };
      wanted: { add(n: number): void };
      police: { cars: Array<{ reset(x: number, z: number, h: number): void; group: { visible: boolean } }> };
      player: { pos: { x: number; z: number } };
    };
    __game: { game: { time: number }; ready: boolean };
  }
}

test.use({ viewport: { width: 960, height: 540 } });

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

test('a bust is a cutscene, then the game again', async ({ page }) => {
  test.setTimeout(900_000);
  await page.goto('/?nohud=1&peds=0&traffic=0&intro=0&post=0&shadows=0&ticks=20');
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 90_000 });
  await page.keyboard.press('Enter');
  await sim(page, 1.5);

  await page.evaluate(() => {
    const s = window.__session;
    s.wanted.add(150);
  });
  await sim(page, 1);
  await page.evaluate(() => {
    const s = window.__session;
    const me = s.player.pos;
    const u = s.police.cars.find((c) => c.group.visible) ?? s.police.cars[0];
    u.reset(me.x + 2.5, me.z, Math.PI);
  });
  // The bust needs three still seconds; the scene starts on the event.
  await page.waitForFunction(() => window.__session.cutscene.active, null, { timeout: 300_000 });
  const first = await page.evaluate(() => ({ name: window.__session.cutscene.name, shot: window.__session.cutscene.shot }));
  console.log(`cutscene: ${first.name}, shot ${first.shot}`);
  expect(first.name).toBe('busted');
  await page.waitForTimeout(400);
  await shot(page, 'busted-1');
  // Wall clock: the second shot comes after 1.2 s.
  await page.waitForTimeout(1200);
  const second = await page.evaluate(() => window.__session.cutscene.shot);
  console.log(`after 1.6 s: shot ${second}`);
  expect(second).toBeGreaterThanOrEqual(1);
  await shot(page, 'busted-2');
  // And it hands back within four seconds of wall time.
  await page.waitForFunction(() => !window.__session.cutscene.active, null, { timeout: 6000 });
  expect(await page.evaluate(() => window.__session.cutscene.shot)).toBe(-1);
});
