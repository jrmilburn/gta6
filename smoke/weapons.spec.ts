import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// The weapon selector: each of the four fires with its own readout, the sniper
// scopes, and a rocket into a car blows the car up.
const DIR = path.resolve('screens/weapons');
test.use({ viewport: { width: 900, height: 620 } });

async function sim(page: Page, seconds: number): Promise<void> {
  await page.evaluate(async (secs: number) => {
    const w = window as unknown as { __game: { game: { time: number } } };
    const end = w.__game.game.time + secs;
    while (w.__game.game.time < end) await new Promise((r) => setTimeout(r, 16));
  }, seconds);
}
const run = (page: Page, code: string) => page.evaluate(code);
async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(DIR, { recursive: true });
  await page.screenshot({ path: path.join(DIR, `${name}.png`) });
}
async function frame(page: Page, azimuth: number, dist: number, height: number): Promise<void> {
  await page.evaluate(([az, d, h]) => {
    const w = window as unknown as {
      __session: { rig: { setSubject(s: null): void }; player: { pos: { x: number; z: number }; y: number; heading: number } };
      __game: { game: { camera: { position: { set(x: number, y: number, z: number): void };
        lookAt(x: number, y: number, z: number): void; fov: number; updateProjectionMatrix(): void } } };
    };
    w.__session.rig.setSubject(null);
    const p = w.__session.player;
    const a = p.heading + (az as number);
    const cam = w.__game.game.camera;
    cam.position.set(p.pos.x + Math.sin(a) * (d as number), p.y + (h as number), p.pos.z + Math.cos(a) * (d as number));
    cam.lookAt(p.pos.x, p.y + 1.1, p.pos.z);
    cam.fov = 40;
    cam.updateProjectionMatrix();
  }, [azimuth, dist, height] as [number, number, number]);
  await sim(page, 0.05);
}
const restore = (page: Page) => run(page, `window.__session.rig.setSubject(window.__session.player)`);

test('four weapons, a scope, and a rocket into a car', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?peds=0&traffic=0&intro=0');
  await page.waitForFunction(() => (window as unknown as { __game?: { ready: boolean } }).__game?.ready === true, null, { timeout: 90_000 });
  await page.keyboard.press('Enter');
  await run(page, `window.__input.lock(true)`);
  await sim(page, 1);
  await run(page, `(() => { window.__hits = []; window.__game.game.events.on('shotHit', (p) => window.__hits.push(p.kind));
    window.__exploded = 0; window.__game.game.events.on('exploded', () => window.__exploded++); })()`);

  // Draw, then step through the four weapons with the number keys.
  await run(page, `window.__input.tap('KeyH')`);
  await sim(page, 0.8);
  const names: string[] = [];
  for (const [key, id] of [['Digit1', 'pistol'], ['Digit2', 'mg'], ['Digit3', 'sniper'], ['Digit4', 'rpg']] as const) {
    await run(page, `window.__input.tap('${key}')`);
    await sim(page, 0.5);
    const w = await page.evaluate(`window.__session.combat.weapon`);
    expect(w).toBe(id);
    names.push(w as string);
    await frame(page, Math.PI * 0.72, 2.6, 1.35);
    await shoot(page, `hold-${id}`);
    await restore(page);
  }
  // The wheel cycles.
  await run(page, `window.__input.wheel(1)`);
  await sim(page, 0.1);
  expect(await page.evaluate(`window.__session.combat.weapon`)).toBe('pistol');

  // Fire each hitscan weapon once at the world ahead.
  const fired: Record<string, number> = {};
  for (const [key, id] of [['Digit1', 'pistol'], ['Digit2', 'mg'], ['Digit3', 'sniper']] as const) {
    await run(page, `window.__input.tap('${key}')`);
    await sim(page, 0.4);
    await run(page, `window.__hits.length = 0`);
    await run(page, `window.__input.button('left', true)`);
    await sim(page, id === 'mg' ? 0.5 : 0.1);
    await run(page, `window.__input.button('left', false)`);
    await sim(page, 0.2);
    fired[id] = await page.evaluate(`window.__hits.length`) as number;
    console.log(`${id}: ${fired[id]} shots registered`);
  }
  expect(fired.pistol).toBeGreaterThanOrEqual(1);
  expect(fired.mg, 'the SMG fires while held').toBeGreaterThanOrEqual(4);
  expect(fired.sniper).toBe(1);

  // The sniper scopes: right-click narrows the field of view to the scope.
  await run(page, `window.__input.tap('Digit3')`);
  await sim(page, 0.3);
  await run(page, `window.__input.button('right', true)`);
  await sim(page, 1.0);
  const fov = await page.evaluate(`window.__game.game.camera.fov`) as number;
  const scoped = await page.evaluate(`window.__session.combat.scoped`);
  console.log(`scoped: ${scoped}, fov ${fov.toFixed(1)}`);
  await shoot(page, 'scope');
  expect(scoped).toBe(true);
  expect(fov).toBeLessThan(16);
  await run(page, `window.__input.button('right', false)`);
  await sim(page, 0.5);

  // A rocket into a parked car: it goes up, wrecked and scorched.
  await run(page, `(() => { const s = window.__session; const p = s.player; const car = s.vehicles[0];
    car.reset(p.pos.x + Math.sin(p.heading) * 18, p.pos.z + Math.cos(p.heading) * 18, p.heading + Math.PI / 2);
    s.look.pitch = 0.02; s.look.yaw = p.heading; })()`);
  await sim(page, 0.3);
  await run(page, `window.__input.tap('Digit4')`);
  await sim(page, 0.4);
  await run(page, `window.__input.button('left', true)`);
  await sim(page, 0.1);
  await run(page, `window.__input.button('left', false)`);
  await sim(page, 0.25);
  await shoot(page, 'rocket-flight');
  await sim(page, 0.6);
  const car = await page.evaluate(`(() => { const c = window.__session.vehicles[0]; return { wrecked: c.wrecked, exploded: c.exploded, health: c.health }; })()`) as { wrecked: boolean; exploded: boolean; health: number };
  const exploded = await page.evaluate(`window.__exploded`) as number;
  console.log(`car after rocket: ${JSON.stringify(car)}, exploded events ${exploded}`);
  await shoot(page, 'rocket-hit');
  await sim(page, 1.2);
  await shoot(page, 'rocket-after');
  expect(exploded).toBeGreaterThanOrEqual(1);
  expect(car.exploded).toBe(true);
  expect(car.wrecked).toBe(true);
  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
});
