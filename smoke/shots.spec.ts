// Deterministic before/after screenshot set for the realism + movement pass.
//
//   SHOT_TAG=before pnpm exec playwright test smoke/shots.spec.ts
//
// Files land in screens/<tag>/<view>.png. The camera rig is detached
// (`rig.setSubject(null)`) so each view is a fixed eye/target pair and the pairs
// line up pixel-for-pixel across runs.
import { test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const TAG = process.env.SHOT_TAG ?? 'shot';
const DIR = path.resolve('screens', TAG);

type V3 = [number, number, number];

declare global {
  interface Window {
    __shots: {
      detach(): void;
      attach(): void;
      toCrowd(): void;
      danceTime(): number;
      dancers(): number;
      look(eye: V3, target: V3, fov: number): void;
      player(): { x: number; y: number; z: number; heading: number };
      spot(kind: 'palm' | 'tree' | 'downtown' | 'residential' | 'beach'): { x: number; z: number } | null;
      carTo(x: number, z: number, heading: number): void;
    };
    __input: { set(code: string, down: boolean): void; tap(code: string): void };
    __game: { game: { time: number } };
  }
}

/** Wait `seconds` of SIMULATED time; the wall clock is not the game's clock. */
async function sim(page: Page, seconds: number): Promise<void> {
  await page.evaluate(async (secs: number) => {
    const end = window.__game.game.time + secs;
    while (window.__game.game.time < end) await new Promise((r) => setTimeout(r, 30));
  }, seconds);
}

/** A screenshot through the game's own camera, mid-motion. */
async function live(page: Page, name: string): Promise<void> {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`screenshot: ${file}`);
}

async function ready(page: Page, query: string): Promise<void> {
  const q = query ? `${query}&nohud=1` : '?nohud=1';
  await page.goto(`/${q}`);
  await page.waitForFunction(
    () => (window as unknown as { __game?: { ready: boolean } }).__game?.ready === true,
    null,
    { timeout: 60_000 },
  );
  await page.waitForFunction(() => typeof window.__shots !== 'undefined', null, { timeout: 60_000 });
  // Dismiss the title splash without touching game input, then let assets,
  // PMREM and the first shadow pass settle.
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousedown')));
  await page.waitForTimeout(3500);
  await page.evaluate(() => window.__shots.detach());
}

async function shoot(page: Page, name: string, eye: V3, target: V3, fov = 45): Promise<void> {
  await page.evaluate(([e, t, f]) => window.__shots.look(e as V3, t as V3, f as number), [eye, target, fov] as const);
  await page.waitForTimeout(700);
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`screenshot: ${file}`);
}

/** Eye placed `dist` back along `az` from a point, `h` above it. */
function orbit(x: number, z: number, y: number, az: number, dist: number, h: number): { eye: V3; target: V3 } {
  return {
    eye: [x + Math.sin(az) * dist, y + h, z + Math.cos(az) * dist],
    target: [x, y, z],
  };
}

async function suite(page: Page, query: string, suffix: string): Promise<void> {
  await ready(page, query);
  const n = (base: string): string => base + suffix;

  const p = await page.evaluate(() => window.__shots.player());
  const close = orbit(p.x, p.z, p.y + 1.05, p.heading + Math.PI * 0.78, 2.6, 0.35);
  await shoot(page, n('character-closeup'), close.eye, close.target, 38);

  for (const kind of ['palm', 'tree'] as const) {
    const s = await page.evaluate((k) => window.__shots.spot(k as 'palm'), kind);
    if (!s) { console.log(`no ${kind} spot`); continue; }
    // 5 m out as the brief asks, but aimed at mid-canopy with a wide lens so
    // the whole plant is in frame rather than a wall of trunk.
    const v = orbit(s.x, s.z, 3.2, Math.PI * 0.25, 7, 0.6);
    await shoot(page, n(`${kind}-5m`), v.eye, v.target, 58);
  }

  const dt = await page.evaluate(() => window.__shots.spot('downtown'));
  if (dt) await shoot(page, n('downtown-street'), [dt.x, 1.7, dt.z], [dt.x + 40, 9, dt.z + 6], 55);

  const res = await page.evaluate(() => window.__shots.spot('residential'));
  if (res) await shoot(page, n('residential-street'), [res.x, 1.7, res.z], [res.x + 40, 4, res.z + 4], 55);

  const beach = await page.evaluate(() => window.__shots.spot('beach'));
  if (beach) {
    await page.evaluate((b) => window.__shots.carTo(b!.x, b!.z, Math.PI * 0.35), beach);
    await page.waitForTimeout(500);
    const v = orbit(beach.x, beach.z, 0.9, Math.PI * 0.95, 7.5, 1.9);
    await shoot(page, n('car-beach'), v.eye, v.target, 45);
  }

  await moving(page, n);
}

/**
 * The shots that only exist while the game is running: a walk, a run, and the
 * dance. The camera goes back to the rig for these -- the point of them is what
 * the player actually sees, and half of it is the camera's own behaviour.
 */
async function moving(page: Page, n: (base: string) => string): Promise<void> {
  await page.evaluate(() => window.__shots.attach());
  await sim(page, 0.5);

  await page.evaluate(() => window.__input.set('KeyW', true));
  await sim(page, 2.5);
  await live(page, n('character-walk'));

  await page.evaluate(() => window.__input.set('ShiftLeft', true));
  await sim(page, 2.5);
  await live(page, n('character-run'));
  await page.evaluate(() => {
    window.__input.set('KeyW', false);
    window.__input.set('ShiftLeft', false);
  });
  await sim(page, 1.5);

  // Dance, among as many people as the city put in one place.
  await page.evaluate(() => window.__shots.toCrowd());
  await sim(page, 1);
  await page.evaluate(() => window.__input.tap('KeyG'));
  // Two frames of the orbit: a quarter and a half of the way round, so at least
  // one of them has the crowd between the camera and the street furniture.
  await sim(page, 2.2);
  console.log(`dancers at 2.2s: ${await page.evaluate(() => window.__shots.dancers())}`);
  await live(page, n('dance'));
  await sim(page, 2);
  console.log(`dancers at 4.2s: ${await page.evaluate(() => window.__shots.dancers())}`);
  await live(page, n('dance-b'));

  // One wide frame from outside the orbit. The dance camera sits 4.5 m out and
  // frames the player alone by design, which is right for playing and wrong for
  // showing that the crowd joined in.
  const me = await page.evaluate(() => window.__shots.player());
  await page.evaluate(() => window.__shots.detach());
  const wide = orbit(me.x, me.z, me.y + 1, Math.PI * 0.15, 11, 2.6);
  await shoot(page, n('dance-wide'), wide.eye, wide.target, 52);
}

test('day shots', async ({ page }) => { await suite(page, '', ''); });
test('dusk shots', async ({ page }) => { await suite(page, '?time=dusk', '-dusk'); });
