import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// The opening flight: a drone shot over the city, three hard cuts pushing in,
// then one smooth blend into the live player camera.
//
// Timed in WALL CLOCK, unlike every other spec here, because the flight itself
// is: a cut that lands on a different beat because the physics fell behind is a
// bug you can see. That also means this spec is honest on a software rasteriser
// -- the flight takes the same 8.2 seconds either way, it just draws fewer
// frames of it.
const DIR = path.resolve('screens/intro');

test.use({ viewport: { width: 900, height: 620 } });

interface Sample {
  t: number;
  shot: number;
  y: number;
  fov: number;
  active: boolean;
  fog: number;
  ex: number;
  ez: number;
  /** Degrees away from straight down. 0 is vertical. */
  pitch: number;
}

async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(DIR, { recursive: true });
  await page.screenshot({ path: path.join(DIR, `${name}.png`) });
}

test('the opening flight climbs, cuts three times and blends into the game', async ({ page }) => {
  test.setTimeout(300_000);

  await page.goto('/?peds=24&traffic=10&nohud=1');
  // The flight starts the moment the session exists -- there is no keypress to
  // wait for any more, and pressing one would SKIP it -- so pick the recorder up
  // as early as possible. It may still join the establishing shot a moment in.
  await page.waitForFunction(
    () => (window as unknown as { __session?: { intro: unknown } }).__session !== undefined,
    null, { timeout: 90_000 },
  );

  await page.evaluate(() => {
    const w = window as unknown as {
      __intro: Sample[];
      __game: { game: { camera: { position: { x: number; y: number; z: number }; fov: number;
        matrixWorld: { elements: number[] } };
        scene: { fog: { density?: number } | null } } };
      __session: { intro: { shot: number; active: boolean } };
    };
    w.__intro = [];
    const t0 = performance.now();
    const tick = (): void => {
      const g = w.__game.game;
      w.__intro.push({
        t: (performance.now() - t0) / 1000,
        shot: w.__session.intro.shot,
        y: g.camera.position.y,
        fov: g.camera.fov,
        active: w.__session.intro.active,
        fog: g.scene.fog?.density ?? 0,
        ex: g.camera.position.x,
        ez: g.camera.position.z,
        pitch: (() => {
          // The camera looks down its own -Z. Angle between that and straight
          // down, in degrees.
          const e = g.camera.matrixWorld.elements;
          const dy = -e[9];
          return Math.acos(Math.max(-1, Math.min(1, -dy))) * 180 / Math.PI;
        })(),
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // Wait on the flight's own state rather than a stopwatch. A screenshot stalls
  // the page for a second or more on a software rasteriser, which a fixed
  // schedule cannot absorb -- and the flight clamps its own step precisely so
  // that a stall stretches it instead of skipping a cut.
  const atShot = async (n: number): Promise<void> => {
    await page.waitForFunction(
      (want) => (window as unknown as { __session: { intro: { shot: number } } })
        .__session.intro.shot >= want,
      n, { timeout: 120_000 },
    );
  };
  const names = ['shot1-establishing', 'shot2-district', 'shot3-street', 'shot4-handover'];
  for (let i = 0; i < names.length; i++) {
    await atShot(i);
    await shoot(page, names[i]);
  }
  await page.waitForFunction(
    () => (window as unknown as { __session: { intro: { active: boolean } } })
      .__session.intro.active === false,
    null, { timeout: 120_000 },
  );
  await page.waitForTimeout(600);
  await shoot(page, 'shot5-gameplay');

  const s: Sample[] = await page.evaluate(
    () => (window as unknown as { __intro: Sample[] }).__intro,
  );
  const inShot = (n: number): Sample[] => s.filter((x) => x.shot === n);
  const peak = Math.max(...s.map((x) => x.y));
  const last = s[s.length - 1];
  const seen = [...new Set(s.map((x) => x.shot))].filter((n) => n >= 0);

  const hi = (n: number): string => {
    const f = inShot(n);
    return f.length ? `${Math.min(...f.map((x) => x.y)).toFixed(0)}-${Math.max(...f.map((x) => x.y)).toFixed(0)} m` : 'never seen';
  };
  console.log(`${s.length} frames over ${last.t.toFixed(1)} s; shots seen ${seen.join(',')}`);
  console.log(`  shot 1 ${hi(0)} | shot 2 ${hi(1)} | shot 3 ${hi(2)} | handover ${hi(3)}`);
  // The flight is already running by the time sampling starts, so the fog is
  // already lifted: the honest reference is what it is put BACK to.
  const fogRestored = last.fog;
  console.log(`  peak altitude ${peak.toFixed(0)} m, ended at ${last.y.toFixed(2)} m, `
    + `fog lifted to ${Math.min(...s.map((x) => x.fog)).toFixed(5)} `
    + `-> restored ${fogRestored.toFixed(5)}`);

  // Every shot in the list, plus the handover, actually reached the screen.
  expect(seen, 'all three cuts and the handover should play').toEqual([0, 1, 2, 3]);

  // It is a drone shot: high enough to see the city, which is 912 m across.
  expect(peak, 'the establishing shot should be high above the city').toBeGreaterThan(450);

  // The three opening shots point straight down. Anything else is a tilt.
  const tilt = Math.max(...s.filter((x) => x.shot >= 0 && x.shot <= 2).map((x) => x.pitch));
  console.log(`  worst deviation from straight down in shots 1-3: ${tilt.toFixed(2)} deg`);
  expect(tilt, 'the opening shots should look straight down').toBeLessThan(0.5);

  // Each cut is closer to the ground than the one before it. Compared on the
  // lowest point of each shot, since every shot descends as it drifts.
  const floorOf = (n: number): number => Math.min(...inShot(n).map((x) => x.y));
  expect(floorOf(0), 'shot 2 should be below shot 1').toBeGreaterThan(floorOf(1));
  expect(floorOf(1), 'shot 3 should be below shot 2').toBeGreaterThan(floorOf(2));
  expect(floorOf(2), 'the handover should be below shot 3').toBeGreaterThan(floorOf(3));

  // And it ends in the game: the flight releases the camera, and what is left
  // is the on-foot rig, which sits a few metres up rather than hundreds.
  expect(last.active, 'the flight should have handed over').toBe(false);
  expect(last.y, 'the camera should end at the player, not overhead').toBeLessThan(12);

  // The handover is the one transition that must NOT be a cut. Consecutive
  // samples inside it should never jump further than a fast camera could move.
  const blend = s.filter((x) => x.shot === 3);
  let worst = 0;
  for (let i = 1; i < blend.length; i++) {
    const gap = Math.max(blend[i].t - blend[i - 1].t, 1e-3);
    const d = Math.hypot(blend[i].ex - blend[i - 1].ex, blend[i].ez - blend[i - 1].ez,
      blend[i].y - blend[i - 1].y);
    worst = Math.max(worst, d / gap);
  }
  console.log(`  fastest handover movement ${worst.toFixed(1)} m/s`);
  expect(worst, 'the handover should be a blend, not a cut').toBeLessThan(120);

  // Fog is lifted for the altitude and put back. Exponential fog at the shipped
  // density leaves about 91% haze at 600 m, which is a white screen, not a city.
  expect(fogRestored, 'fog should be restored to the shipped density')
    .toBeGreaterThan(0.002);
  expect(Math.min(...s.map((x) => x.fog)), 'fog should be lifted for the flight')
    .toBeLessThan(fogRestored * 0.5);
});
