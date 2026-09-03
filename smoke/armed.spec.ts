import { test, expect, type Page } from '@playwright/test';

// The armed clip set: forward, both strafes and backward, each measured for
// foot slip the same way the unarmed ladder is.
//
// This is the test the pistol animations were added for. Before them the only
// armed clips were a 1.34 m/s walk backward and a 2.06 m/s strafe, and the
// direction ring picked between clips by ANGLE alone -- so a walk backward and
// a run backward, both 180 degree clips, were two anchors at the same angle and
// one of them silently never played.
test.use({ viewport: { width: 480, height: 270 } });

async function boot(page: Page): Promise<void> {
  await page.goto('/?nohud=1&peds=8&traffic=4&intro=0');
  await page.waitForFunction(
    () => (window as unknown as { __game?: { ready: boolean } }).__game?.ready === true,
    null, { timeout: 90_000 },
  );
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => (window as unknown as { __session?: { heroRig: unknown } }).__session?.heroRig != null,
    null, { timeout: 30_000 },
  );
}

const run = (page: Page, code: string): Promise<unknown> => page.evaluate(code);

/** Hold keys for `secs` of simulated time, then average the last third. */
async function measure(page: Page, keys: string[], secs: number): Promise<{
  speed: number; foot: number; clips: string[];
}> {
  return page.evaluate(async ([codes, seconds]) => {
    const w = window as unknown as {
      __input: { set(c: string, d: boolean): void };
      __game: { game: { time: number } };
      __session: {
        player: { speed: number };
        heroRig: {
          footSpeed: number;
          debug(): Record<string, { weight: number; timeScale: number }>;
        } | null;
      };
    };
    for (const c of codes as string[]) w.__input.set(c, true);
    const end = w.__game.game.time + (seconds as number);
    // Only the last third counts: the blend takes a moment to arrive, and
    // averaging over the ramp measures the ramp.
    const from = end - (seconds as number) / 3;
    let speed = 0, foot = 0, n = 0;
    const weights = new Map<string, number>();
    while (w.__game.game.time < end) {
      await new Promise((r) => setTimeout(r, 16));
      const rig = w.__session.heroRig;
      if (!rig || w.__game.game.time < from) continue;
      speed += w.__session.player.speed;
      foot += rig.footSpeed;
      n++;
      for (const [k, v] of Object.entries(rig.debug())) {
        if (v.weight > 0.05) weights.set(k, Math.max(weights.get(k) ?? 0, v.weight));
      }
    }
    for (const c of codes as string[]) w.__input.set(c, false);
    return {
      speed: n ? speed / n : 0,
      foot: n ? foot / n : 0,
      clips: [...weights.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k),
    };
  }, [keys, secs] as [string[], number]);
}

test('the armed clips carry the speed the player actually moves at', async ({ page }) => {
  test.setTimeout(900_000);
  await boot(page);
  await run(page, `window.__input.lock(true)`);
  // Let the title splash finish fading. While a screen owns the frame the input
  // layer discards unconsumed presses, so a tap sent during the fade is lost.
  await page.evaluate(async () => {
    const w = window as unknown as { __game: { game: { time: number } } };
    const t = w.__game.game.time + 1.5;
    while (w.__game.game.time < t) await new Promise((r) => setTimeout(r, 16));
  });

  // Draw, and face a fixed direction so "forward" means the same thing every
  // time. Aiming holds the character facing the camera, which is what makes the
  // strafe and back clips the ones selected.
  await run(page, `window.__input.tap('KeyH')`);
  await run(page, `(() => {
    const s = window.__session;
    s.look.yaw = 0; s.look.pitch = 0;
    s.player.heading = 0;
  })()`);
  await run(page, `window.__input.button('right', true)`);
  await page.evaluate(async () => {
    const w = window as unknown as { __game: { game: { time: number } } };
    const t = w.__game.game.time + 1.5;
    while (w.__game.game.time < t) await new Promise((r) => setTimeout(r, 16));
  });

  const armed = await page.evaluate(() => (window as unknown as {
    __session: { combat: { armed: boolean; aiming: boolean } };
  }).__session.combat);
  expect(armed.armed, 'the pistol should be drawn').toBe(true);
  expect(armed.aiming, 'and aimed').toBe(true);

  const dirs: Array<[string, string[]]> = [
    ['forward', ['KeyW']],
    ['back', ['KeyS']],
    ['strafe right', ['KeyD']],
    ['strafe left', ['KeyA']],
  ];
  const slips: Array<[string, number]> = [];
  for (const [label, keys] of dirs) {
    const m = await measure(page, keys, 3);
    const slip = m.speed > 0.2 ? Math.abs(m.speed - m.foot) / m.speed : 0;
    slips.push([label, slip]);
    console.log(`${label.padEnd(13)} ${m.speed.toFixed(2)} m/s, feet ${m.foot.toFixed(2)} m/s`
      + ` -> ${(slip * 100).toFixed(1)}% slip   [${m.clips.join(', ')}]`);
    expect(m.speed, `${label}: the player should actually be moving`).toBeGreaterThan(0.5);
  }

  for (const [label, slip] of slips) {
    // The unarmed ladder plants to within a percent. The armed set is a handful
    // of clips rather than a full ladder, so it gets more room -- but a fifth of
    // a stride is the point at which sliding is what you notice.
    expect(slip, `${label} should not skate`).toBeLessThan(0.1);
  }

  // Sprinting with the gun down hands the legs back to the ordinary run: the
  // armed forward clip is authored at 2.89 m/s and cannot carry 8.
  await run(page, `window.__input.button('right', false)`);
  const sprint = await measure(page, ['KeyW', 'ShiftLeft'], 4);
  const sprintSlip = Math.abs(sprint.speed - sprint.foot) / Math.max(sprint.speed, 0.1);
  console.log(`sprint armed  ${sprint.speed.toFixed(2)} m/s, feet ${sprint.foot.toFixed(2)} m/s`
    + ` -> ${(sprintSlip * 100).toFixed(1)}% slip   [${sprint.clips.join(', ')}]`);
  expect(sprint.speed, 'sprinting should be faster than the aim cap').toBeGreaterThan(4);
  expect(sprintSlip, 'a sprint with the gun out should not skate').toBeLessThan(0.1);
});
