import { test, expect, type Page } from '@playwright/test';

// The crowd behaving itself: nobody inside a building, nobody teleporting, and
// nothing planted on the line they walk along.
//
// All three were reported from play rather than caught by a test, which is the
// point of writing them down here. Simulated seconds throughout.

test.use({ viewport: { width: 480, height: 270 } });

const QUERY = '?nohud=1&peds=60&traffic=20&post=0&shadows=0';

async function boot(page: Page): Promise<void> {
  await page.goto(`/${QUERY}`);
  await page.waitForFunction(
    () => (window as unknown as { __game?: { ready: boolean } }).__game?.ready === true,
    null, { timeout: 90_000 },
  );
  await page.keyboard.press('Enter');
}

test('the crowd stays out of the walls, off the palms, and never teleports', async ({ page }) => {
  // Thirty simulated seconds. The loop caps how many steps a frame may take, so
  // on a machine that falls back to software rendering that is minutes of wall
  // clock -- well past the 7-minute default. Same reasoning as traffic.spec.
  test.setTimeout(1_200_000);
  await boot(page);

  const r = await page.evaluate(async () => {
    const w = window as unknown as {
      __game: { game: { time: number } };
      __session: {
        city: {
          colliders: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }>;
          props: { palms: Array<{ pos: { x: number; z: number } }> };
        };
        peds: { list(): Array<{ x: number; z: number; mode: string }> };
        player: { pos: { x: number; z: number } };
      };
    };
    const wait = async (secs: number): Promise<void> => {
      const t = w.__game.game.time + secs;
      while (w.__game.game.time < t) await new Promise((r) => setTimeout(r, 16));
    };
    const boxes = w.__session.city.colliders;
    const inside = (x: number, z: number): boolean =>
      boxes.some((b) => x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ);

    await wait(2);
    let worstInside = 0;
    let visibleJump = 0;
    let recycles = 0;
    const snap = (): Array<{ x: number; z: number; far: number }> => {
      const p = w.__session.player.pos;
      return w.__session.peds.list().map((q) => ({
        x: q.x, z: q.z, far: Math.hypot(q.x - p.x, q.z - p.z),
      }));
    };
    let prev = snap();
    for (let i = 0; i < 60; i++) {
      await wait(0.5);
      const now = snap();
      worstInside = Math.max(
        worstInside, w.__session.peds.list().filter((q) => inside(q.x, q.z)).length,
      );
      for (let k = 0; k < now.length; k++) {
        const d = Math.hypot(now[k].x - prev[k].x, now[k].z - prev[k].z);
        if (d <= 4) continue;
        // Recycling moves somebody on purpose, and only ever once they have
        // wandered past 250 m -- far outside anything the player can see. Every
        // other jump is one the player would have watched happen.
        if (prev[k].far >= 249) recycles++;
        else visibleJump = Math.max(visibleJump, d);
      }
      prev = now;
    }

    let closestPalm = Infinity;
    for (const palm of w.__session.city.props.palms) {
      for (const q of w.__session.peds.list()) {
        closestPalm = Math.min(closestPalm, Math.hypot(palm.pos.x - q.x, palm.pos.z - q.z));
      }
    }
    return {
      worstInside, visibleJump, recycles, closestPalm,
      palms: w.__session.city.props.palms.length,
    };
  });

  console.log(`over 30 simulated seconds: ${r.worstInside} pedestrians inside a building, `
    + `largest visible jump ${r.visibleJump.toFixed(2)} m (${r.recycles} off-screen recycles `
    + `ignored), nearest of ${r.palms} palms to anyone ${r.closestPalm.toFixed(2)} m`);

  // Fleeing used to be a straight line for three seconds with no collision test.
  expect(r.worstInside, 'pedestrians should not walk through buildings').toBe(0);
  // Half a second of a 5 m/s sprint is 2.5 m, so nothing the player can see
  // should move further than that between samples. Snapping to the nearest
  // corner moved them half a block; snapping to the nearest point on the
  // perimeter still moved them 18 m; recycling could drop one twenty metres in
  // front of the player.
  expect(r.visibleJump, 'pedestrians should not teleport in view').toBe(0);
  // Palms and the walking line used to sit on the same 1.5 m inset.
  expect(r.closestPalm, 'palms should not stand on the pavement').toBeGreaterThan(0.9);
});
