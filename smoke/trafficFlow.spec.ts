import { test, expect, type Page } from '@playwright/test';

// Traffic should not drive into itself. Twenty-four cars, twenty seconds of
// simulated time, the player parked on foot out of the way: count every
// vehicleHit where both parties are AI. The old pursuit-and-cone controller
// produced pile-ups at every busy junction; the flow layer (trafficFlow.ts)
// is meant to keep this at a couple of glancing touches at most.
async function sim(page: Page, seconds: number): Promise<void> {
  await page.evaluate(async (secs: number) => {
    const w = window as unknown as { __game: { game: { time: number } } };
    const end = w.__game.game.time + secs;
    while (w.__game.game.time < end) await new Promise((r) => setTimeout(r, 30));
  }, seconds);
}

test.use({ viewport: { width: 480, height: 300 } });

test('AI traffic does not collide with itself', async ({ page }) => {
  // Twenty simulated seconds is several minutes on the software rasteriser.
  test.setTimeout(900_000);
  await page.goto('/?peds=0&traffic=24&post=0&shadows=0&intro=0');
  await page.waitForFunction(() => (window as unknown as { __game?: { ready: boolean } }).__game?.ready === true, null, { timeout: 90_000 });
  await page.keyboard.press('Enter');
  await page.evaluate(`(() => {
    const s = window.__session;
    window.__aiHits = []; window.__aiHitCount = 0;
    window.__game.game.events.on('vehicleHit', (p) => {
      if (!p || !p.other) return;
      const cars = s.traffic.cars;
      if (!cars.includes(p.vehicle) || !cars.includes(p.other)) return;
      // One crash fires from both cars; count the pair once per half second.
      const t = window.__game.game.time;
      const key = [p.vehicle.id, p.other.id].sort().join('-');
      const last = window.__aiHits.find((h) => h.key === key && t - h.t < 0.5);
      if (last) return;
      window.__aiHits.push({ key, t, impact: p.impact });
      window.__aiHitCount++;
    });
  })()`);
  await sim(page, 20);
  const r = await page.evaluate(`(() => {
    const s = window.__session;
    const cars = s.traffic.cars;
    const moving = cars.filter((c) => Math.abs(c.speed) > 1).length;
    const wrecked = cars.filter((c) => c.wrecked).length;
    const avg = cars.reduce((a, c) => a + Math.abs(c.speed), 0) / cars.length;
    return { hits: window.__aiHitCount, sample: window.__aiHits.slice(0, 6), moving, wrecked, avg: +avg.toFixed(2), count: cars.length };
  })()`) as { hits: number; sample: unknown[]; moving: number; wrecked: number; avg: number; count: number };
  console.log(`AI-vs-AI hits in 20 s: ${r.hits}; ${r.moving}/${r.count} moving at the end, ${r.wrecked} wrecked, mean speed ${r.avg} m/s`);
  console.log(JSON.stringify(r.sample));
  expect(r.hits, 'AI cars should not crash into each other').toBeLessThanOrEqual(1);
  expect(r.wrecked).toBe(0);
  // And they have to actually be driving, not all parked at a deadlock.
  expect(r.moving, 'most of the traffic should be moving').toBeGreaterThan(r.count * 0.4);
});
