// Movement-feel acceptance (feel pass, Part 1 item 1.6).
//
// "No visible snapping" is asserted as a property of the *simulation*, not of
// the frame stream: CI renders through SwiftShader at single-digit fps, so any
// per-frame continuity metric measures the software renderer's frame pacing
// rather than the game. Everything checked here is frame-rate independent --
// how long a ramp takes in simulated seconds, how fast the camera moves
// relative to what it is following, and how long the camera takes to settle
// after an enter/exit.
import { test, expect, type Page } from '@playwright/test';

interface Sample {
  /** Wall clock, seconds. Only ever used for rates, never for durations. */
  t: number;
  /** Simulated clock, seconds. The one durations are measured in. */
  st: number;
  cx: number; cy: number; cz: number;
  yaw: number;
  speed: number;
  /** Camera-to-subject distance; the enter/exit blend is measured on this. */
  dist: number;
}

declare global {
  interface Window {
    __feel: { start(): void; stop(): Sample[] };
  }
}

const KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'Space'] as const;

async function boot(page: Page, query = ''): Promise<void> {
  await page.goto(`/${query}${query ? '&' : '?'}nohud=1`);
  await page.waitForFunction(
    () => (window as unknown as { __game?: { ready: boolean } }).__game?.ready === true,
    null,
    { timeout: 60_000 },
  );
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousedown')));
  // Wait for the frame rate to settle, not a fixed delay. The first seconds
  // after boot are shader compilation -- every composited facade, every
  // vegetation material and every car paint patch compiles on its first draw --
  // and on CI's software renderer that is single-digit fps for a second or two.
  // Sampling through it measures the compiler, not the game.
  await page.waitForFunction(
    () => (window as unknown as { __game: { fps: number } }).__game.fps > 20,
    null,
    { timeout: 60_000, polling: 200 },
  );
  await page.waitForTimeout(500);
  await installSampler(page);
}

async function installSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = (window as unknown as { __game: { game: {
      time: number;
      camera: { position: { x: number; y: number; z: number }; rotation: { y: number } };
    } } }).__game.game;
    const s = window.__session;
    let out: Sample[] = [];
    let on = false;
    const tick = (): void => {
      requestAnimationFrame(tick);
      if (!on) return;
      const v = s.playerVehicle;
      const subject = v ? v.pos : s.player.pos;
      const c = g.camera.position;
      out.push({
        t: performance.now() / 1000,
        st: g.time,
        cx: c.x, cy: c.y, cz: c.z,
        yaw: g.camera.rotation.y,
        speed: v ? Math.abs(v.speed) : s.player.speed,
        dist: Math.hypot(c.x - subject.x, c.z - subject.z),
      });
    };
    requestAnimationFrame(tick);
    window.__feel = {
      start(): void { out = []; on = true; },
      stop(): Sample[] { on = false; return out; },
    };
  });
}

const setKey = (page: Page, code: string, down: boolean) =>
  page.evaluate(([c, d]) => window.__input.set(c as string, d as boolean), [code, down] as const);

async function release(page: Page): Promise<void> {
  await page.evaluate((codes) => {
    for (const c of codes as string[]) window.__input.set(c, false);
  }, KEYS as unknown as string[]);
}

/**
 * Simulated seconds from the first sample until `speed` reaches `target`.
 * Simulated, not wall: the loop caps how much wall time one frame may simulate,
 * so a wall measurement reports a ramp several times longer than it is.
 */
function timeToReach(samples: Sample[], target: number, below = false): number {
  const t0 = samples[0].st;
  for (const s of samples) {
    if (below ? s.speed <= target : s.speed >= target) return s.st - t0;
  }
  return Infinity;
}

/** Fastest the camera itself travelled, m/s. */
function peakCameraSpeed(samples: Sample[]): number {
  let peak = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const dt = b.t - a.t;
    if (dt <= 0) continue;
    peak = Math.max(peak, Math.hypot(b.cx - a.cx, b.cy - a.cy, b.cz - a.cz) / dt);
  }
  return peak;
}

/** Peak camera yaw rate, degrees per second, wrap-safe. */
function peakYawRate(samples: Sample[]): number {
  let peak = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    if (dt <= 0) continue;
    let d = samples[i].yaw - samples[i - 1].yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    peak = Math.max(peak, Math.abs(d) / dt);
  }
  return (peak * 180) / Math.PI;
}

/**
 * Simulated seconds until the camera-to-subject distance settles within
 * `tolerance` of its final value and stays there.
 *
 * This is the whole point of the blended enter/exit: cutting the subject over
 * puts the camera at its new standoff distance on the very next frame, so the
 * settle time is ~0. Blending it takes real time, whatever the frame rate.
 */
function settleTime(samples: Sample[], tolerance: number): number {
  const final = samples[samples.length - 1].dist;
  const t0 = samples[0].st;
  let last = t0;
  for (const s of samples) if (Math.abs(s.dist - final) > tolerance) last = s.st;
  return last - t0;
}

test('on foot: starts and stops on a ramp, and the camera trails rather than cuts', async ({ page }) => {
  await boot(page);
  const walkSpeed = 4;

  // --- start ramp: ~0.25 s to full speed (CFG.feel.foot.accel) -------------
  await page.evaluate(() => window.__feel.start());
  await setKey(page, 'KeyW', true);
  await page.waitForTimeout(1500);
  let samples = await page.evaluate(() => window.__feel.stop());
  expect(samples.length).toBeGreaterThan(3);
  const rampIn = timeToReach(samples, walkSpeed * 0.9);
  console.log(`foot ramp-in to 90% walk speed: ${rampIn.toFixed(3)} simulated s`);
  // Acceleration-based, not assignment: it must take real time, but not so long
  // that the character feels like it is on ice.
  expect(rampIn).toBeGreaterThan(0.1);
  expect(rampIn).toBeLessThan(0.6);

  // --- stop ramp: ~0.2 s to a standstill (CFG.feel.foot.decel) -------------
  await page.evaluate(() => window.__feel.start());
  await release(page);
  await page.waitForTimeout(1500);
  samples = await page.evaluate(() => window.__feel.stop());
  expect(samples.length).toBeGreaterThan(3);
  const rampOut = timeToReach(samples, walkSpeed * 0.1, true);
  console.log(`foot ramp-out to 10% walk speed: ${rampOut.toFixed(3)} simulated s`);
  expect(rampOut).toBeGreaterThan(0.03);
  expect(rampOut).toBeLessThan(0.6);

  // --- 10 s of direction changes ------------------------------------------
  await page.evaluate(() => window.__feel.start());
  for (const k of ['KeyW', 'KeyD', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyW', 'KeyA']) {
    await setKey(page, k, true);
    await page.waitForTimeout(600);
    await release(page);
    await page.waitForTimeout(650);
  }
  samples = await page.evaluate(() => window.__feel.stop());
  const camPeak = peakCameraSpeed(samples);
  const subjPeak = Math.max(...samples.map((s) => s.speed));
  console.log(`foot: peak camera ${camPeak.toFixed(1)} m/s vs subject ${subjPeak.toFixed(1)} m/s over ${samples.length} frames`);
  expect(samples.length).toBeGreaterThan(15);
  // A trailing camera can briefly outrun its subject while catching up, but it
  // cannot teleport: a cut would put tens of metres into a single frame.
  expect(camPeak).toBeLessThan(subjPeak * 3 + 6);
});

test('driving: entering blends the camera across, and a handbrake turn swings it', async ({ page }) => {
  await boot(page, '?car=sports');

  // Stand next to the nearest parked car; no scripted walk needed.
  await page.evaluate(() => {
    const s = window.__session;
    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < s.vehicles.length; i++) {
      const v = s.vehicles[i];
      const d = Math.hypot(v.pos.x - s.player.pos.x, v.pos.z - s.player.pos.z);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    s.player.pos.x = s.vehicles[bestI].pos.x - 1.5;
    s.player.pos.z = s.vehicles[bestI].pos.z;
  });
  await page.waitForTimeout(500);

  // --- enter: the camera must take time to reach the chase standoff --------
  await page.evaluate(() => window.__feel.start());
  await page.evaluate(() => window.__input.tap('KeyE'));
  await page.waitForFunction(() => window.__session.playerVehicle !== null, null, { timeout: 10_000 });
  await page.waitForTimeout(2500);
  let samples = await page.evaluate(() => window.__feel.stop());
  expect(samples.length).toBeGreaterThan(4);
  const settle = settleTime(samples, 0.5);
  console.log(`enter: camera settled after ${settle.toFixed(3)} simulated s`);
  // A cut lands on the new standoff immediately; the 0.6 s blend cannot.
  expect(settle).toBeGreaterThan(0.15);
  expect(settle).toBeLessThan(2.5);

  // --- handbrake turn ------------------------------------------------------
  await page.evaluate(() => window.__feel.start());
  await setKey(page, 'KeyW', true);
  await page.waitForFunction(() => (window.__session.playerVehicle?.speed ?? 0) > 18, null, { timeout: 40_000 });
  await setKey(page, 'KeyD', true);
  await setKey(page, 'Space', true);
  await page.waitForTimeout(1800);
  await release(page);
  await page.waitForTimeout(1600);
  samples = await page.evaluate(() => window.__feel.stop());

  const yaw = peakYawRate(samples);
  const camPeak = peakCameraSpeed(samples);
  const subjPeak = Math.max(...samples.map((s) => s.speed));
  console.log(`drive: peak yaw ${yaw.toFixed(0)} deg/s, camera ${camPeak.toFixed(1)} m/s vs car ${subjPeak.toFixed(1)} m/s`);
  expect(samples.length).toBeGreaterThan(15);
  // CFG.feel.camera.yawRateDeg is 180. The rig's yaw is rate limited; the
  // look-at adds a little on top, so the gate is the limit plus a margin.
  expect(yaw).toBeLessThan(320);
  expect(camPeak).toBeLessThan(subjPeak * 3 + 6);
});
