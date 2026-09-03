import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Police response (section 9). Until now the wanted system was a scoreboard:
// heat accumulated, stars lit up, and nothing in the world answered them,
// because police.ts was a two-line stub and traffic only ever spawned sedans,
// sports cars and pickups. There was no police vehicle anywhere in the game.
//
// Nobody is hurt and nobody dies here. A bust is a fade and a respawn.
// Small for the measurements, but the acceptance still is worth looking at.
const DIR = path.resolve('screens/police');

async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`screenshot: ${file}`);
}

test.use({ viewport: { width: 900, height: 620 } });

/** CFG.police.bustSeconds, repeated so the spec does not import the game. */
const BUST_SECONDS = 3;

async function boot(page: Page): Promise<void> {
  await page.goto('/?nohud=1&peds=10&traffic=6&intro=0');
  await page.waitForFunction(
    () => (window as unknown as { __game?: { ready: boolean } }).__game?.ready === true,
    null, { timeout: 90_000 },
  );
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => (window as unknown as { __session?: { police: unknown } }).__session?.police != null,
    null, { timeout: 30_000 },
  );
  // Let the splash finish: while a screen owns the frame, input is discarded.
  await sim(page, 1.5);
}

async function sim(page: Page, seconds: number): Promise<void> {
  await page.evaluate(async (secs: number) => {
    const w = window as unknown as { __game: { game: { time: number } } };
    const end = w.__game.game.time + secs;
    while (w.__game.game.time < end) await new Promise((r) => setTimeout(r, 16));
  }, seconds);
}

const run = (page: Page, code: string): Promise<unknown> => page.evaluate(code);

interface State {
  stars: number;
  heat: number;
  live: number;
  nearest: number;
  contact: boolean;
}

async function state(page: Page): Promise<State> {
  return page.evaluate(() => {
    const s = (window as unknown as {
      __session: {
        player: { pos: { x: number; z: number } };
        wanted: { level: number; heat: number; contact: boolean };
        police: { cars: Array<{ pos: { x: number; z: number }; group: { visible: boolean } }> };
      };
    }).__session;
    const me = s.player.pos;
    let live = 0, nearest = Infinity;
    for (const c of s.police.cars) {
      if (!c.group.visible) continue;
      live++;
      nearest = Math.min(nearest, Math.hypot(c.pos.x - me.x, c.pos.z - me.z));
    }
    return { stars: s.wanted.level, heat: s.wanted.heat, live, nearest, contact: s.wanted.contact };
  });
}

test('police answer the wanted level, close in, and can bust the player', async ({ page }) => {
  test.setTimeout(900_000);
  await boot(page);

  // Nothing on the street with a clean sheet.
  const calm = await state(page);
  console.log(`clean: ${calm.stars} stars, ${calm.live} units on the street`);
  expect(calm.stars, 'no heat to start with').toBe(0);
  expect(calm.live, 'and nobody looking for you').toBe(0);

  // Watch for a bust from the very start: standing still is the bust condition,
  // so anything that stops moving near a cruiser will be picked up.
  await run(page, `(() => {
    window.__busted = 0;
    window.__game.game.events.on('busted', () => { window.__busted++; });
  })()`);
  const bustCount = (): Promise<number> => page.evaluate(
    () => (window as unknown as { __busted: number }).__busted,
  );

  // --- heat brings units out ------------------------------------------------
  await run(page, `window.__session.wanted.add(1000)`);
  await sim(page, 2);
  const hot = await state(page);
  console.log(`after heat: ${hot.stars} stars, ${hot.live} units, nearest ${hot.nearest.toFixed(0)} m`);
  expect(hot.stars, 'the heat should light the stars').toBeGreaterThanOrEqual(3);
  expect(hot.live, 'and units should be dispatched').toBeGreaterThanOrEqual(3);
  // Dropped in at a distance, not on top of the player.
  expect(hot.nearest, 'units should arrive from a distance').toBeGreaterThan(25);

  // --- they close in --------------------------------------------------------
  // Keep walking. A walk is 4 m/s, above the 3.5 m/s a bust needs, so this
  // measures the chase rather than ending it.
  const before = hot.nearest;
  const closed = await page.evaluate(async () => {
    const w = window as unknown as {
      __input: { set(c: string, d: boolean): void };
      __game: { game: { time: number } };
      __session: {
        player: { pos: { x: number; z: number } };
        police: { cars: Array<{ pos: { x: number; z: number }; group: { visible: boolean } }> };
      };
    };
    w.__input.set('KeyW', true);
    const end = w.__game.game.time + 14;
    let best = Infinity;
    while (w.__game.game.time < end) {
      await new Promise((r) => setTimeout(r, 16));
      const me = w.__session.player.pos;
      for (const c of w.__session.police.cars) {
        if (!c.group.visible) continue;
        best = Math.min(best, Math.hypot(c.pos.x - me.x, c.pos.z - me.z));
      }
    }
    w.__input.set('KeyW', false);
    return best;
  });
  const chasing = await state(page);
  console.log(`chase: spawned at ${before.toFixed(0)} m, closed to ${closed.toFixed(0)} m; `
    + `${chasing.live} still out, contact=${chasing.contact}, busts so far ${await bustCount()}`);
  await shoot(page, 'chase');
  expect(chasing.live, 'they should still be out there').toBeGreaterThanOrEqual(2);
  expect(closed, 'and they should close on a player on foot').toBeLessThan(before * 0.6);

  // --- heat holds while they can see you ------------------------------------
  // Nose to nose, so line of sight is certain.
  await run(page, `(() => {
    const s = window.__session;
    const me = s.player.pos;
    s.police.cars[0].reset(me.x + 6, me.z, Math.PI);
  })()`);
  await sim(page, 1.5);
  const seen = await state(page);
  console.log(`in contact: ${seen.contact}, heat ${seen.heat.toFixed(0)}`);
  expect(seen.contact, 'a cruiser alongside should be in contact').toBe(true);
  const heldFrom = seen.heat;
  await sim(page, 3);
  const held = await state(page);
  console.log(`heat over 3 s of contact: ${heldFrom.toFixed(0)} -> ${held.heat.toFixed(0)}`);
  expect(held.heat, 'heat should not bleed off while they have eyes on you')
    .toBeGreaterThanOrEqual(heldFrom - 1);

  // --- and they can bust you ------------------------------------------------
  expect(await bustCount(), 'walking away should not have been bustable').toBe(0);
  await run(page, `(() => {
    const s = window.__session;
    const me = s.player.pos;
    s.police.cars[0].reset(me.x + 2.5, me.z, Math.PI);
  })()`);
  await sim(page, BUST_SECONDS + 2);
  const busted = await page.evaluate(() => ({
    count: (window as unknown as { __busted: number }).__busted,
    heat: (window as unknown as { __session: { wanted: { heat: number } } }).__session.wanted.heat,
    live: (window as unknown as { __session: { police: { cars: Array<{ group: { visible: boolean } }> } } })
      .__session.police.cars.filter((c) => c.group.visible).length,
  }));
  await shoot(page, 'after-bust');
  console.log(`bust: fired ${busted.count} time(s), heat now ${busted.heat.toFixed(0)}, `
    + `${busted.live} units left on the street`);
  expect(busted.count, 'standing still next to a cruiser should end in a bust').toBe(1);
  expect(busted.heat, 'a bust clears the heat').toBe(0);
  expect(busted.live, 'and sends everybody home').toBe(0);
});
