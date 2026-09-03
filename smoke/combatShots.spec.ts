import { test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Section 10's acceptance stills, at a size worth looking at.
//
// Separate from combat.spec.ts, which asserts behaviour at a deliberately tiny
// viewport so thirty simulated seconds fits in a test timeout. These are the
// frames a person actually judges the work by, so they are full size, with the
// HUD, the post chain and the shadows all on.
const DIR = path.resolve('screens/after-combat');

test.use({ viewport: { width: 900, height: 620 } });

async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`screenshot: ${file}`);
}

async function sim(page: Page, seconds: number): Promise<void> {
  await page.evaluate(async (secs: number) => {
    const w = window as unknown as { __game: { game: { time: number } } };
    const end = w.__game.game.time + secs;
    while (w.__game.game.time < end) await new Promise((r) => setTimeout(r, 16));
  }, seconds);
}

const run = (page: Page, code: string) => page.evaluate(code);

/** Park the camera on the player from a fixed angle, for a repeatable frame. */
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
    cam.fov = 42;
    cam.updateProjectionMatrix();
  }, [azimuth, dist, height] as [number, number, number]);
  await sim(page, 0.4);
}

test('acceptance stills', async ({ page }) => {
  await page.goto('/?peds=18&traffic=6&intro=0');
  await page.waitForFunction(
    () => (window as unknown as { __game?: { ready: boolean } }).__game?.ready === true,
    null, { timeout: 90_000 },
  );
  await page.keyboard.press('Enter');
  await run(page, `window.__input.lock(true)`);
  await sim(page, 1.5);

  // --- the goofy run (section 5) -------------------------------------------
  await run(page, `window.__input.tap('KeyP')`);
  await run(page, `window.__input.set('KeyW', true)`);
  await sim(page, 2.5);
  await shoot(page, 'goofy-run');
  await run(page, `window.__input.set('KeyW', false)`);
  await run(page, `window.__input.tap('KeyP')`);
  await sim(page, 1);

  // --- the pistol, held and aimed (section 7) ------------------------------
  await run(page, `window.__input.tap('KeyH')`);
  await sim(page, 1.2);
  await frame(page, Math.PI * 0.75, 2.6, 1.35);
  await shoot(page, 'grip-idle');

  await run(page, `window.__session.rig.setSubject(window.__session.player)`);
  await run(page, `window.__input.button('right', true)`);
  await sim(page, 1.2);
  await frame(page, Math.PI * 0.72, 2.4, 1.4);
  await shoot(page, 'grip-aim');
  await run(page, `window.__input.button('right', false)`);
  await run(page, `window.__session.rig.setSubject(window.__session.player)`);
  await sim(page, 0.8);

  // --- strafing while armed (the new directional clips) ---------------------
  await run(page, `window.__input.set('KeyD', true)`);
  await sim(page, 1.6);
  await shoot(page, 'pistol-strafe');
  await run(page, `window.__input.set('KeyD', false)`);
  await run(page, `window.__input.tap('KeyH')`);
  await sim(page, 1);

  // --- the prompt, and driving (what the E key is for) ----------------------
  await run(page, `(() => {
    const s = window.__session;
    const cars = s.vehicles.filter((v) => !v.wrecked && !v.occupied);
    let best = cars[0], bd = 1e9;
    for (const v of cars) {
      const d = Math.hypot(v.pos.x - s.player.pos.x, v.pos.z - s.player.pos.z);
      if (d < bd) { bd = d; best = v; }
    }
    s.player.placeAt(best.pos.x - 2.4, best.pos.z, 0);
    s.look.yaw = Math.atan2(best.pos.x - s.player.pos.x, best.pos.z - s.player.pos.z);
  })()`);
  await sim(page, 0.8);
  await shoot(page, 'enter-prompt');

  await run(page, `window.__input.tap('KeyE')`);
  await sim(page, 1);
  await run(page, `window.__input.set('KeyW', true)`);
  await sim(page, 3);
  const speed = await page.evaluate(
    () => (window as unknown as { __session: { playerVehicle: { speed: number } | null } })
      .__session.playerVehicle?.speed ?? 0,
  );
  await shoot(page, 'driving');
  await run(page, `window.__input.set('KeyW', false)`);
  console.log(`driving at ${speed.toFixed(1)} m/s`);
});
