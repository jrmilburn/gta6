import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// The bench and the gondola: the seated clip should put the thighs forward and
// the hips on the plank. Before the clip, hand-posed legs folded behind the
// body and the feet ended up under the bench.
const DIR = path.resolve('screens/sit');
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
/** Park the camera on the player from `azimuth` off their heading. */
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
    cam.lookAt(p.pos.x, p.y + 0.8, p.pos.z);
    cam.fov = 40;
    cam.updateProjectionMatrix();
  }, [azimuth, dist, height] as [number, number, number]);
  await sim(page, 0.05);
}
/** Knee ahead of the hips along the heading, and how high the hips are off the root. */
const legs = (page: Page) => page.evaluate(`(() => {
  const s = window.__session; const rig = s.heroRig; const p = s.player;
  const find = (n) => { let out = null; rig.root.traverse((o) => { if (!out && o.isBone && o.name.endsWith(n)) out = o; }); return out; };
  const w = (b) => { const v = b.getWorldPosition(new b.position.constructor()); return v; };
  const hips = w(find('Hips')), knee = w(find('LeftLeg')), foot = w(find('LeftFoot'));
  const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
  return JSON.stringify({
    kneeAhead: +((knee.x - hips.x) * fx + (knee.z - hips.z) * fz).toFixed(2),
    hipsUp: +(hips.y - p.y).toFixed(2), footUp: +(foot.y - p.y).toFixed(2),
    oneShot: rig.oneShot.clip, w: +rig.oneShot.weight.toFixed(2), sitHips: +rig.sitHips.toFixed(2), pose: s.player.pose, carry: !!s.player.carry,
  });
})()`);

test('sitting on the bench and in the gondola', async ({ page }) => {
  await page.goto('/?peds=0&traffic=0&intro=0');
  await page.waitForFunction(() => (window as unknown as { __game?: { ready: boolean } }).__game?.ready === true, null, { timeout: 90_000 });
  await page.keyboard.press('Enter');
  await run(page, `window.__input.lock(true)`);
  await sim(page, 1);

  // Bench: walk up to it by teleport, and press E.
  await run(page, `(() => { const s = window.__session; const b = s.pier.benches[0]; s.player.placeAt(b.pos.x - Math.sin(b.heading) * 0.6, b.pos.z - Math.cos(b.heading) * 0.6, b.heading); })()`);
  await sim(page, 0.5);
  await run(page, `window.__input.tap('KeyE')`);
  await sim(page, 1.5);
  const bench = JSON.parse(await legs(page)) as { kneeAhead: number; hipsUp: number; footUp: number; oneShot: string | null; pose: string };
  console.log('bench', JSON.stringify(bench));
  await frame(page, Math.PI / 2, 3.0, 1.0); await shoot(page, 'bench-side');
  await frame(page, Math.PI * 0.25, 3.2, 1.3); await shoot(page, 'bench-three-quarter');
  await run(page, `window.__session.rig.setSubject(window.__session.player)`);
  expect(bench.pose).toBe('sit');
  expect(bench.oneShot, 'the seated clip drives the body').toBe('sit');
  expect(bench.kneeAhead, 'knees in front of the hips').toBeGreaterThan(0.3);
  expect(bench.footUp, 'feet on the deck').toBeGreaterThan(-0.08);
  expect(bench.footUp).toBeLessThan(0.15);

  // Stand up, then ride.
  await run(page, `window.__input.set('KeyW', true)`); await sim(page, 0.3); await run(page, `window.__input.set('KeyW', false)`);
  await sim(page, 0.8);
  await run(page, `window.__session.pierPlay.startRide(window.__session.pier.wheel.lowest().index)`);
  await sim(page, 2.0);
  const ride = JSON.parse(await legs(page)) as { kneeAhead: number; footUp: number; oneShot: string | null; pose: string; carry: boolean };
  console.log('ride', JSON.stringify(ride));
  await frame(page, Math.PI / 2, 3.2, 1.0); await shoot(page, 'gondola-side');
  await frame(page, Math.PI * 0.2, 3.4, 1.4); await shoot(page, 'gondola-three-quarter');
  await run(page, `window.__session.rig.setSubject(window.__session.player)`);
  expect(ride.carry).toBe(true);
  expect(ride.oneShot).toBe('sit');
  expect(ride.kneeAhead).toBeGreaterThan(0.3);
  expect(ride.footUp).toBeGreaterThan(-0.08);
});
