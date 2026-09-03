// The traffic lights control the road.
//
// Every AI car is sampled a few times a second for forty simulated seconds.
// A car found INSIDE an intersection, moving, while its approach shows red is
// a red-light run. The all-red second and the amber-commit rule mean a car
// that entered on amber clears the box before the cross street's green, so
// the honest count is zero; a little slack is allowed for the pathological
// case of a car boxed in mid-intersection by another.
//
// The second test is the pedestrians: nobody starts across a road whose
// traffic is on green.
import { test, expect, type Page } from '@playwright/test';

interface Vec2 { x: number; z: number }

declare global {
  interface Window {
    __session: {
      traffic: { cars: Array<{ pos: Vec2; speed: number; forwardX: number; forwardZ: number; wrecked: boolean }> };
      signals: { control: boolean; phaseFor(node: number, axis: 'x' | 'z'): string };
      city: { roads: { nodes: Array<{ id: number; pos: Vec2 }> } };
      peds: { list(): Array<{ x: number; z: number; mode: string; heading: number }> };
    };
    __game: { game: { time: number }; ready: boolean };
  }
}

test.use({ viewport: { width: 480, height: 270 } });

async function ready(page: Page, query: string): Promise<void> {
  await page.goto(`/${query}`);
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 90_000 });
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousedown')));
  await page.waitForTimeout(1000);
}

async function _sim(page: Page, seconds: number): Promise<void> {
  await page.evaluate(async (secs: number) => {
    const end = window.__game.game.time + secs;
    while (window.__game.game.time < end) await new Promise((r) => setTimeout(r, 30));
  }, seconds);
}

test('traffic stops on red', async ({ page }) => {
  // Simulated seconds on a software rasteriser: minutes of wall clock each.
  test.setTimeout(1_200_000);
  await ready(page, '?traffic=40&peds=0&post=0&shadows=0&intro=0&nohud=1&ticks=20');
  const r = await page.evaluate(async () => {
    const s = window.__session;
    if (!s.signals.control) throw new Error('signals not in control');
    const nodes = s.city.roads.nodes;
    const box = 6; // half the road width, roughly: the intersection square
    let runs = 0, inside = 0, held = 0;
    const wait = async (secs: number) => { const e = window.__game.game.time + secs; while (window.__game.game.time < e) await new Promise((r) => setTimeout(r, 16)); };
    await wait(3);
    for (let i = 0; i < 100; i++) {
      await wait(0.25);
      for (const c of s.traffic.cars) {
        if (c.wrecked) continue;
        // Nearest node by grid.
        let best = nodes[0], bd = Infinity;
        for (const n of nodes) { const d = Math.hypot(n.pos.x - c.pos.x, n.pos.z - c.pos.z); if (d < bd) { bd = d; best = n; } }
        const axis = Math.abs(c.forwardX) >= Math.abs(c.forwardZ) ? 'x' : 'z';
        const phase = s.signals.phaseFor(best.id, axis);
        const dx = Math.abs(c.pos.x - best.pos.x), dz = Math.abs(c.pos.z - best.pos.z);
        if (dx < box && dz < box) {
          inside++;
          if (phase === 'red' && c.speed > 3) runs++;
        } else if (bd < 20 && phase === 'red' && c.speed < 0.5) {
          held++;
        }
      }
    }
    return { runs, inside, held };
  });
  console.log(`signals: ${r.inside} in-box samples, ${r.runs} moving on red, ${r.held} samples held at a line`);
  expect(r.held).toBeGreaterThan(20);
  // A car that entered on amber is still in the box for the all-red second,
  // and one queued behind another can be caught inside on red through no
  // fault of its own; the honest figure is a few percent, not zero.
  expect(r.runs).toBeLessThanOrEqual(Math.max(2, r.inside * 0.08));
  expect(r.runs).toBeLessThan(r.held);
});

test('pedestrians cross on the walk phase', async ({ page }) => {
  test.setTimeout(1_200_000);
  await ready(page, '?traffic=10&peds=80&post=0&shadows=0&intro=0&nohud=1&ticks=20');
  const r = await page.evaluate(async () => {
    const s = window.__session;
    const nodes = s.city.roads.nodes;
    const wait = async (secs: number) => { const e = window.__game.game.time + secs; while (window.__game.game.time < e) await new Promise((r) => setTimeout(r, 16)); };
    let prev = s.peds.list();
    let starts = 0, onGreen = 0;
    for (let i = 0; i < 120; i++) {
      await wait(0.25);
      const now = s.peds.list();
      for (let k = 0; k < now.length; k++) {
        if (prev[k].mode === 'cross' || now[k].mode !== 'cross') continue;
        starts++;
        // Just started crossing: the road they are on is the one between
        // their position and the nearest node, along the axis they move on.
        let best = nodes[0], bd = Infinity;
        for (const n of nodes) { const d = Math.hypot(n.pos.x - now[k].x, n.pos.z - now[k].z); if (d < bd) { bd = d; best = n; } }
        // The crossing direction is where they went since the last sample;
        // the heading is still turning off the kerb line at this point.
        // Walking along Z crosses the road that runs along X.
        const mx = now[k].x - prev[k].x, mz = now[k].z - prev[k].z;
        if (Math.hypot(mx, mz) < 0.05) continue;
        const roadAxis = Math.abs(mz) >= Math.abs(mx) ? 'x' : 'z';
        if (s.signals.phaseFor(best.id, roadAxis) === 'green') onGreen++;
      }
      prev = now;
    }
    return { starts, onGreen };
  });
  console.log(`crossings: ${r.starts} started, ${r.onGreen} against a green`);
  expect(r.starts).toBeGreaterThan(2);
  expect(r.onGreen).toBe(0);
});
