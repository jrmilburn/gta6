import { test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Stills of every weapon's hold and aim, from the side and from three-quarters
// behind, for tuning weaponPoses.ts. Not an assertion suite: the judge is a
// person looking at screens/weapon-poses/.
const DIR = path.resolve('screens/weapon-poses');
test.use({ viewport: { width: 700, height: 560 } });

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
  await page.screenshot({ path: path.join(DIR, `${name}.png`), clip: { x: 120, y: 40, width: 460, height: 480 } });
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
    cam.lookAt(p.pos.x, p.y + 1.2, p.pos.z);
    cam.fov = 32;
    cam.updateProjectionMatrix();
  }, [azimuth, dist, height] as [number, number, number]);
  await sim(page, 0.05);
}

test('weapon pose stills', async ({ page }) => {
  page.on('pageerror', (e) => console.log('PAGEERR', e.message.slice(0, 200)));
  await page.goto('/?peds=0&traffic=0&intro=0&hud=0');
  await page.waitForFunction(() => (window as unknown as { __game?: { ready: boolean } }).__game?.ready === true, null, { timeout: 90_000 });
  await page.keyboard.press('Enter');
  await run(page, `window.__input.lock(true)`);
  await sim(page, 1);
  await run(page, `window.__input.tap('Backquote')`);
  await run(page, `window.__input.tap('KeyH')`);
  await sim(page, 0.8);
  for (const [key, id] of [['Digit1', 'pistol'], ['Digit2', 'mg'], ['Digit3', 'sniper'], ['Digit4', 'rpg']] as const) {
    await run(page, `window.__input.tap('${key}')`);
    await sim(page, 0.6);
    console.log(id, await page.evaluate(`JSON.stringify({ ov: window.__session.heroRig.overlay.clip, w: +window.__session.heroRig.overlay.weight.toFixed(2) })`));
    await frame(page, Math.PI / 2, 3.0, 1.3); await shoot(page, `${id}-hold-side`);
    await frame(page, Math.PI * 0.78, 3.0, 1.5); await shoot(page, `${id}-hold-back`);
    await run(page, `window.__session.rig.setSubject(window.__session.player)`);
    await run(page, `window.__input.button('right', true)`);
    await sim(page, 0.7);
    console.log(id, 'aim', await page.evaluate(`JSON.stringify({ ov: window.__session.heroRig.overlay.clip })`));
    await frame(page, Math.PI / 2, 3.0, 1.3); await shoot(page, `${id}-aim-side`);
    await frame(page, Math.PI * 0.78, 3.0, 1.5); await shoot(page, `${id}-aim-back`);
    await run(page, `window.__input.button('right', false)`);
    await run(page, `window.__session.rig.setSubject(window.__session.player)`);
    await sim(page, 0.4);
  }
});
