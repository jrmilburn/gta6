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
  await page.goto('/?nohud=1&peds=10&traffic=6&intro=0&ticks=20');
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

// --- the refinement pass: the rest of section 9 ----------------------------------

interface Full {
  stars: number; active: number; patrolling: number; heli: boolean; roadblock: boolean;
  officers: number; shots: number; health: number; onFoot: boolean;
}

async function full(page: Page): Promise<Full> {
  return page.evaluate(() => {
    const s = (window as unknown as {
      __session: {
        wanted: { level: number };
        police: { active: number; patrolling: number; helicopter: { active: boolean }; lastRoadblock: unknown };
        officers: { active: number; shots: number } | null;
        player: { health: number; onFoot: boolean };
      };
    }).__session;
    return {
      stars: s.wanted.level, active: s.police.active, patrolling: s.police.patrolling,
      heli: s.police.helicopter.active, roadblock: s.police.lastRoadblock !== null,
      officers: s.officers?.active ?? 0, shots: s.officers?.shots ?? 0,
      health: s.player.health, onFoot: s.player.onFoot,
    };
  });
}

test('patrols at zero stars, and a witnessed crime lights the first', async ({ page }) => {
  test.setTimeout(900_000);
  await boot(page);
  const calm = await full(page);
  console.log(`clean: ${calm.patrolling} on patrol, ${calm.active} chasing`);
  expect(calm.patrolling).toBe(2);
  expect(calm.active).toBe(0);

  // A crime nobody sees is nobody's business.
  await run(page, `window.__game.game.events.emit('pedHit', { x: window.__session.player.pos.x, z: window.__session.player.pos.z })`);
  await sim(page, 0.5);
  expect((await full(page)).stars, 'unseen: no stars').toBe(0);

  // The same crime with a patrol car nose to nose.
  await run(page, `(() => {
    const s = window.__session;
    const me = s.player.pos;
    const patrol = s.police.cars.find((c) => c.group.visible);
    patrol.reset(me.x + 8, me.z, Math.PI);
  })()`);
  await sim(page, 0.3);
  await run(page, `window.__game.game.events.emit('pedHit', { x: window.__session.player.pos.x, z: window.__session.player.pos.z })`);
  await sim(page, 1.5);
  const seen = await full(page);
  console.log(`witnessed: ${seen.stars} stars, ${seen.active} chasing, ${seen.patrolling} patrolling`);
  expect(seen.stars, 'witnessed: a star').toBeGreaterThanOrEqual(1);
  expect(seen.active, 'the patrol joins the chase').toBeGreaterThanOrEqual(1);
});

test('five stars: helicopter, roadblocks, and a wreck is replaced', async ({ page }) => {
  test.setTimeout(1_200_000);
  await page.goto('/?nohud=1&peds=0&traffic=0&intro=0&stars=5&car=sports&post=0&shadows=0&ticks=20');
  await page.waitForFunction(
    () => (window as unknown as { __game?: { ready: boolean } }).__game?.ready === true,
    null, { timeout: 90_000 },
  );
  await page.keyboard.press('Enter');
  await sim(page, 3);
  const hot = await full(page);
  console.log(`?stars=5: ${hot.stars} stars, ${hot.active} units, helicopter=${hot.heli}, driving=${!hot.onFoot}`);
  expect(hot.stars).toBe(5);
  expect(hot.heli, 'the helicopter is up').toBe(true);
  expect(hot.active).toBeGreaterThanOrEqual(4);
  expect(hot.onFoot, 'started in the car').toBe(false);

  // Drive: a roadblock goes down ahead within the interval.
  await page.evaluate(() => (window as unknown as { __input: { set(c: string, d: boolean): void } }).__input.set('KeyW', true));
  await sim(page, 26);
  await page.evaluate(() => (window as unknown as { __input: { set(c: string, d: boolean): void } }).__input.set('KeyW', false));
  const driven = await full(page);
  console.log(`after 26 s driving: roadblock=${driven.roadblock}, ${driven.active} units`);
  await shoot(page, 'five-stars');
  expect(driven.roadblock, 'a roadblock was placed').toBe(true);

  // Wreck a unit: its slot is refilled.
  await run(page, `(() => {
    const s = window.__session;
    const u = s.police.cars.find((c) => c.group.visible && !c.wrecked);
    u.damage(10000);
  })()`);
  await sim(page, 12);
  const after = await full(page);
  console.log(`12 s after a wreck: ${after.active} units chasing`);
  expect(after.active, 'the wreck was replaced').toBeGreaterThanOrEqual(4);
});

test('three stars on foot: an officer steps out and shoots', async ({ page }) => {
  test.setTimeout(1_200_000);
  await page.goto('/?nohud=1&peds=0&traffic=0&intro=0&stars=3&post=0&shadows=0&ticks=20');
  await page.waitForFunction(
    () => (window as unknown as { __game?: { ready: boolean } }).__game?.ready === true,
    null, { timeout: 90_000 },
  );
  await page.keyboard.press('Enter');
  await sim(page, 1.5);
  const hasOfficers = await page.evaluate(() => (window as unknown as { __session: { officers: unknown } }).__session.officers !== null);
  test.skip(!hasOfficers, 'no supplied character, so no officers');

  // Park a unit beside the player: an officer gets out.
  await run(page, `(() => {
    const s = window.__session;
    const me = s.player.pos;
    const u = s.police.cars.find((c) => c.group.visible && !c.wrecked);
    u.reset(me.x + 7, me.z, Math.PI);
  })()`);
  await page.waitForFunction(
    () => (window as unknown as { __session: { officers: { active: number } | null } }).__session.officers!.active > 0,
    null, { timeout: 600_000 },
  );
  await sim(page, 6);
  const out = await full(page);
  console.log(`officers out: ${out.officers}, shots ${out.shots}, health ${out.health.toFixed(0)}`);
  await shoot(page, 'officer');
  expect(out.officers).toBeGreaterThanOrEqual(1);
  expect(out.shots, 'they shoot').toBeGreaterThan(0);
  await sim(page, 14);
  const hurt = await full(page);
  console.log(`after 20 s under fire: health ${hurt.health.toFixed(0)}, shots ${hurt.shots}`);
  expect(hurt.health, 'and some of it lands').toBeLessThan(100);
});
