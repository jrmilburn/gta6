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
      look(eye: V3, target: V3, fov: number): void;
      player(): { x: number; y: number; z: number; heading: number };
      spot(kind: 'palm' | 'tree' | 'downtown' | 'residential' | 'beach'): { x: number; z: number } | null;
      carTo(x: number, z: number, heading: number): void;
    };
  }
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
  const close = orbit(p.x, p.z, 1.05, p.heading + Math.PI * 0.78, 2.6, 0.35);
  await shoot(page, n('character-closeup'), close.eye, close.target, 38);

  for (const kind of ['palm', 'tree'] as const) {
    const s = await page.evaluate((k) => window.__shots.spot(k as 'palm'), kind);
    if (!s) { console.log(`no ${kind} spot`); continue; }
    const v = orbit(s.x, s.z, 3.2, Math.PI * 0.25, 5, 1.6);
    await shoot(page, n(`${kind}-5m`), v.eye, v.target, 50);
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
}

test('day shots', async ({ page }) => { await suite(page, '', ''); });
test('dusk shots', async ({ page }) => { await suite(page, '?time=dusk', '-dusk'); });
