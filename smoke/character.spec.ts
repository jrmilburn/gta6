import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Everything here is measured in SIMULATED seconds (window.__game.game.time),
// never in wall clock. The fixed-step loop clamps how much time one frame may
// simulate, so on a slow renderer a wall-clock window covers a fraction of the
// motion it would cover on a fast one, and every assertion below would be
// measuring the machine rather than the game.

const SCREENS = path.resolve('screens/after-character');

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENS, { recursive: true });
  const file = path.join(SCREENS, `${name}-${stamp()}.png`);
  await page.screenshot({ path: file });
  console.log(`screenshot: ${file}`);
}

async function boot(page: Page, query = ''): Promise<void> {
  await page.goto(`/${query}`);
  await page.waitForFunction(
    () => (window as unknown as { __game?: { ready: boolean } }).__game?.ready === true,
    null, { timeout: 60_000 },
  );
  // The title splash counts as a screen owning the frame, and the dance is
  // gated on that. It clears on a real keydown, not on the injected input the
  // rest of this file uses, so dismiss it the way a player would.
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => (window as unknown as { __session?: { ui: unknown } }).__session !== undefined,
    null, { timeout: 30_000 },
  );
}

/** Hold a key for `seconds` of SIMULATED time, sampling as we go. */
async function hold(page: Page, keys: string[], seconds: number): Promise<void> {
  await page.evaluate(async ([codes, secs]) => {
    const w = window as unknown as {
      __input: { set(c: string, d: boolean): void };
      __game: { game: { time: number } };
    };
    for (const c of codes as string[]) w.__input.set(c, true);
    const end = w.__game.game.time + (secs as number);
    while (w.__game.game.time < end) await new Promise((r) => setTimeout(r, 30));
    for (const c of codes as string[]) w.__input.set(c, false);
  }, [keys, seconds] as [string[], number]);
}

async function settle(page: Page, seconds: number): Promise<void> {
  await page.evaluate(async (secs: number) => {
    const w = window as unknown as { __game: { game: { time: number } } };
    const end = w.__game.game.time + secs;
    while (w.__game.game.time < end) await new Promise((r) => setTimeout(r, 30));
  }, seconds);
}

interface Sample { speed: number; foot: number; clips: Record<string, { weight: number; timeScale: number }> }

async function sample(page: Page): Promise<Sample | null> {
  return page.evaluate(() => {
    const s = (window as unknown as { __session: {
      player: { speed: number };
      heroRig: { footSpeed: number; debug(): Record<string, { weight: number; timeScale: number }> } | null;
    } }).__session;
    if (!s.heroRig) return null;
    return { speed: s.player.speed, foot: s.heroRig.footSpeed, clips: s.heroRig.debug() };
  });
}

test('the supplied character loads, and its stride matches the ground it covers', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page, '?nohud=1');

  const info = await page.evaluate(() => {
    const w = window as unknown as {
      __session: { heroRig: { group: unknown } | null };
      __game: { THREE: unknown };
    };
    const rig = w.__session.heroRig as
      ({ group: { position: { y: number } } } & { group: unknown }) | null;
    if (!rig) return null;
    const g = rig.group as { traverse(f: (o: { isSkinnedMesh?: boolean; frustumCulled?: boolean }) => void): void };
    let skinned = 0, culled = 0, bones = 0;
    g.traverse((o) => {
      const any = o as { isSkinnedMesh?: boolean; frustumCulled?: boolean; isBone?: boolean;
        skeleton?: { bones: unknown[] } };
      if (any.isBone) bones++;
      if (!any.isSkinnedMesh) return;
      skinned++;
      if (any.frustumCulled) culled++;
    });
    const box = new (w.__game.THREE as { Box3: new () => {
      setFromObject(o: unknown): { min: { y: number }; max: { y: number } };
    } }).Box3().setFromObject(rig.group);
    // The box is in world space and the character may be standing on the
    // boardwalk, so the feet are measured against the rig's own origin.
    const origin = (rig.group as { position: { y: number } }).position.y;
    return { skinned, culled, bones, height: box.max.y - box.min.y, floor: box.min.y - origin };
  });

  // If the raw drop is missing the game still runs, but this spec has nothing
  // to say about it -- that path is covered by the procedural fallback spec.
  test.skip(info === null, 'no character bundle; running procedural');
  if (!info) return;

  console.log(`character: ${info.skinned} skinned meshes, ${info.bones} bones, `
    + `height ${info.height.toFixed(3)} m, feet at ${info.floor.toFixed(3)} m`);
  expect(info.skinned).toBeGreaterThan(0);
  // Skinned bounds are computed from the bind pose and go stale; a culled
  // SkinnedMesh vanishes at the frame edge (section 2).
  expect(info.culled, 'every SkinnedMesh must have frustumCulled off').toBe(0);
  expect(info.height).toBeGreaterThan(1.7);
  expect(info.height).toBeLessThan(1.9);
  expect(Math.abs(info.floor)).toBeLessThan(0.06);

  // --- walk, jog, run, stop -------------------------------------------------
  // Two speeds the ladder handles differently: 4 m/s sits between two clips and
  // has to blend them, 8 m/s is past the fastest clip and has to stretch it.
  await hold(page, ['KeyW'], 2.5);
  await page.evaluate(() => {
    (window as unknown as { __input: { set(c: string, d: boolean): void } }).__input.set('KeyW', true);
  });
  await settle(page, 1.5);
  const walking = await sample(page);

  await page.evaluate(() => {
    (window as unknown as { __input: { set(c: string, d: boolean): void } }).__input.set('ShiftLeft', true);
  });
  await settle(page, 2.5);
  const running = await sample(page);
  await shoot(page, 'run');

  await page.evaluate(() => {
    const i = (window as unknown as { __input: { set(c: string, d: boolean): void } }).__input;
    i.set('KeyW', false); i.set('ShiftLeft', false);
  });
  await settle(page, 1.5);
  const stopped = await sample(page);

  for (const [name, s] of [['walk', walking], ['run', running]] as Array<[string, Sample | null]>) {
    expect(s).not.toBeNull();
    if (!s) continue;
    const slip = Math.abs(s.foot - s.speed) / Math.max(s.speed, 0.01);
    const active = Object.entries(s.clips)
      .filter(([, c]) => c.weight > 0.02)
      .map(([n, c]) => `${n} w=${c.weight} x=${c.timeScale}`).join(', ');
    console.log(`${name}: body ${s.speed.toFixed(2)} m/s, feet ${s.foot.toFixed(2)} m/s `
      + `(${(slip * 100).toFixed(1)}% slip) [${active}]`);
    expect(s.speed).toBeGreaterThan(1);
    // The whole point of stride matching: what the feet describe is what the
    // body does. 10% is well below the threshold a skate reads at.
    expect(slip, `${name} foot slip`).toBeLessThan(0.1);
  }

  expect(running!.speed).toBeGreaterThan(walking!.speed + 1);
  console.log(`stopped: body ${stopped!.speed.toFixed(3)} m/s, idle weight ${stopped!.clips.idle?.weight}`);
  expect(stopped!.speed).toBeLessThan(0.2);
  // Coming to rest lands on the idle pose rather than freezing mid-stride.
  expect(stopped!.clips.idle?.weight ?? 0).toBeGreaterThan(0.8);

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

test('G dances for eight seconds, orbits the camera, pulls in a crowd, and cancels', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page, '?nohud=1');

  const has = await page.evaluate(
    () => (window as unknown as { __session: { heroRig: unknown } }).__session.heroRig !== null,
  );
  test.skip(!has, 'no character bundle; running procedural');

  // Stand where the crowd is thickest, so the shot the brief actually asks for
  // -- mid-dance with pedestrians joining -- has pedestrians in it.
  await page.evaluate(() => {
    const s = (window as unknown as { __session: {
      player: { placeAt(x: number, z: number, h: number): void };
      peds: { list(): Array<{ x: number; z: number }> };
    } }).__session;
    const list = s.peds.list();
    let best = list[0], bestN = -1;
    for (const a of list) {
      const n = list.filter((b) => Math.hypot(a.x - b.x, a.z - b.z) < 7).length;
      if (n > bestN) { bestN = n; best = a; }
    }
    s.player.placeAt(best.x, best.z, 0);
  });
  await settle(page, 1);

  const press = (code: string) => page.evaluate(
    (c: string) => (window as unknown as { __input: { tap(c: string): void } }).__input.tap(c), code,
  );
  const state = () => page.evaluate(() => {
    const w = window as unknown as { __session: {
      dance: { active: boolean; elapsed: number };
      rig: { mode: string };
      peds: { mesh: { dancing: number; skinned?: number } };
      heroRig: { isDancing: boolean } | null;
    } };
    return {
      active: w.__session.dance.active,
      elapsed: w.__session.dance.elapsed,
      mode: w.__session.rig.mode,
      dancingPeds: w.__session.peds.mesh.dancing,
      skinnedPeds: w.__session.peds.mesh.skinned ?? 0,
      rigDancing: w.__session.heroRig?.isDancing ?? false,
    };
  });

  await press('KeyG');
  await settle(page, 2);
  const early = await state();
  console.log(`dance @2s: mode=${early.mode} elapsed=${early.elapsed.toFixed(2)} `
    + `rig=${early.rigDancing} crowd=${early.dancingPeds}/${early.skinnedPeds} skinned`);
  expect(early.active).toBe(true);
  expect(early.rigDancing).toBe(true);
  expect(early.mode).toBe('orbit');

  await settle(page, 1.5);
  const mid = await state();
  await shoot(page, 'dance');
  // The brief's headline shot: at least two pedestrians dancing along.
  expect(mid.dancingPeds, 'pedestrians joining the dance').toBeGreaterThanOrEqual(2);

  // Runs out on its own at eight seconds and hands the camera back.
  await settle(page, 6);
  const after = await state();
  console.log(`after: active=${after.active} mode=${after.mode} crowd=${after.dancingPeds}`);
  expect(after.active).toBe(false);
  expect(after.mode).not.toBe('orbit');
  expect(after.dancingPeds).toBe(0);

  // --- cancels on movement --------------------------------------------------
  await press('KeyG');
  await settle(page, 1);
  expect((await state()).active).toBe(true);
  await hold(page, ['KeyW'], 0.5);
  const cancelled = await state();
  console.log(`cancel on W: active=${cancelled.active} at ${cancelled.elapsed.toFixed(2)}s`);
  expect(cancelled.active).toBe(false);

  // --- G again restarts -----------------------------------------------------
  await settle(page, 0.5);
  await press('KeyG');
  await settle(page, 2);
  const restarted = await state();
  await press('KeyG');
  await settle(page, 0.5);
  const again = await state();
  console.log(`restart: ${restarted.elapsed.toFixed(2)}s -> ${again.elapsed.toFixed(2)}s`);
  expect(restarted.active).toBe(true);
  expect(again.active).toBe(true);
  expect(again.elapsed).toBeLessThan(restarted.elapsed);

  await page.evaluate(() => (window as unknown as { __session: { dance: { stop(): void } } }).__session.dance.stop());
  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});
