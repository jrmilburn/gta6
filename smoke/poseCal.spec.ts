import { test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Axis calibration for weaponPoses.ts: one rotation at a time on the aiming
// arm, from the level pistol aim, photographed from behind the shoulder.
const DIR = path.resolve('screens/weapon-poses/cal');
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

const CASES: Array<[string, Record<string, [number, number, number]>]> = [
  ['base', {}],
  ['rarm-x45', { RightArm: [45, 0, 0] }], ['rarm-y45', { RightArm: [0, 45, 0] }], ['rarm-z45', { RightArm: [0, 0, 45] }],
  ['rfore-x45', { RightForeArm: [45, 0, 0] }], ['rfore-y45', { RightForeArm: [0, 45, 0] }], ['rfore-z45', { RightForeArm: [0, 0, 45] }],
  ['larm-x45', { LeftArm: [45, 0, 0] }], ['larm-z45', { LeftArm: [0, 0, 45] }],
  ['spine2-y20', { Spine2: [0, 20, 0] }], ['head-x20', { Head: [20, 0, 0] }],
];

test('pose axis calibration', async ({ page }) => {
  page.on('pageerror', (e) => console.log('PAGEERR', e.message.slice(0, 200)));
  await page.goto('/?peds=0&traffic=0&intro=0');
  await page.waitForFunction(() => (window as unknown as { __game?: { ready: boolean } }).__game?.ready === true, null, { timeout: 90_000 });
  await page.keyboard.press('Enter');
  await run(page, `window.__input.lock(true)`);
  await sim(page, 1);
  await run(page, `window.__input.tap('Backquote')`);
  await run(page, `window.__input.tap('KeyH')`);
  await sim(page, 0.5);
  await run(page, `window.__input.tap('Digit2')`);
  await run(page, `window.__input.button('right', true)`);
  await sim(page, 0.6);
  for (const [name, bones] of CASES) {
    await run(page, `window.__poses.apply('aimMg', { base: ['pistolAim'], bones: ${JSON.stringify(bones)}, sway: 0 })`);
    await sim(page, 0.5);
    await frame(page, Math.PI * 0.78, 3.0, 1.5); await shoot(page, `${name}-back`);
    await frame(page, Math.PI / 2, 3.0, 1.3); await shoot(page, `${name}-side`);
    await run(page, `window.__session.rig.setSubject(window.__session.player)`);
  }
});
