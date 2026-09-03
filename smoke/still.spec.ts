import { test, expect, type Page } from '@playwright/test';

// Section 2's acceptance, and the instrument that diagnosed it: stand still for
// 30 simulated seconds in three different places and measure whether anything
// moves.
//
// It measures the RENDERED body, not just the controller, and that distinction
// is the whole story. The controller was innocent -- `player.heading` held
// 0.000 degrees for thirty seconds at all three spots throughout, before any
// fix. What was moving was the pose: the head wandered 53 cm and swung nearly
// five degrees while the character stood perfectly still, because the
// procedural breath and weight shift were compounding on bones three had
// stopped rewriting (see boneOffsets.ts). A test that only watched the
// controller would have passed the bug.
//
// Simulated seconds throughout. The fixed-step loop clamps how much time one
// frame may simulate, so a wall-clock window measures the machine.

// Nothing here is looked at, only measured, so the frame is as small as the
// renderer will take it. On a software rasteriser that is most of the budget.
test.use({ viewport: { width: 480, height: 270 } });

interface Still {
  spot: string;
  yawDrift: number;
  yawSwing: number;
  drift: number;
  /** How far the head actually wandered in world space, centimetres. */
  headMoveCm: number;
  /** Total facing the head swung through, degrees. */
  headSwingDeg: number;
  samples: number;
  clips: Record<string, number>;
}

/**
 * A light world, no post chain, no shadow pass.
 *
 * This spec measures the player's own facing and blend, and nothing it asserts
 * involves a crowd, a bloom pass or a shadow map. It does need thirty simulated
 * seconds -- and simulated time advances at most one twelfth of a second per
 * rendered frame, so on a software rasteriser the frame rate IS the clock.
 * Stripping what the test does not use is what makes the window affordable.
 */
const QUERY = '?nohud=1&peds=12&traffic=4&post=0&shadows=0';

async function boot(page: Page): Promise<void> {
  await page.goto(`/${QUERY}&intro=0`);
  await page.waitForFunction(
    () => (window as unknown as { __game?: { ready: boolean } }).__game?.ready === true,
    null, { timeout: 60_000 },
  );
  await page.keyboard.press('Enter');
}

/**
 * Stand at `spot` and watch. Returns the total yaw travelled (not the net
 * change: a character oscillating between two angles has zero net change and is
 * still visibly twitching) and the distance the feet moved.
 */
async function stand(page: Page, spot: [number, number], name: string, seconds: number): Promise<Still> {
  return page.evaluate(async ([xz, label, secs]) => {
    const w = window as unknown as {
      __session: {
        player: { pos: { x: number; z: number }; heading: number; placeAt(x: number, z: number, h: number): void };
        heroRig: {
          root: { traverse(f: (o: { isBone?: boolean; name: string }) => void): void };
          debug(): Record<string, { weight: number }>;
        } | null;
      };
      __game: { game: { time: number }; THREE: { Quaternion: new () => never; Vector3: new () => never } };
    };
    const p = w.__session.player;
    const rig = w.__session.heroRig;
    const THREE = w.__game.THREE;
    let head: { getWorldPosition(v: unknown): unknown; getWorldQuaternion(q: unknown): unknown } | null = null;
    rig?.root.traverse((o: { isBone?: boolean; name: string }) => {
      if (o.isBone && o.name.endsWith('Head')) head = o as never;
    });
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    // Facing, not Euler yaw: pulling a yaw out of a quaternion that also
    // carries roll reports the roll.
    const headYaw = (): number => {
      if (!head) return 0;
      head.getWorldQuaternion(q);
      v.set(0, 0, 1).applyQuaternion(q);
      return Math.atan2(v.x, v.z);
    };
    const headPos = (): { x: number; z: number } => {
      if (!head) return { x: 0, z: 0 };
      head.getWorldPosition(v);
      return { x: v.x, z: v.z };
    };

    const [x, z] = xz as [number, number];
    p.placeAt(x, z, 0);
    // Let the camera and the blend settle before the window opens.
    let settle = w.__game.game.time + 1;
    while (w.__game.game.time < settle) await new Promise((r) => setTimeout(r, 20));

    const start = { x: p.pos.x, z: p.pos.z, h: p.heading };
    const head0 = headPos();
    let prev = p.heading, swing = 0, samples = 0;
    let headPrev = headYaw(), headSwing = 0, headMove = 0;
    const end = w.__game.game.time + (secs as number);
    while (w.__game.game.time < end) {
      await new Promise((r) => setTimeout(r, 20));
      let d = p.heading - prev;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      swing += Math.abs(d);
      prev = p.heading;

      const hy = headYaw();
      let hd = hy - headPrev;
      while (hd > Math.PI) hd -= Math.PI * 2;
      while (hd < -Math.PI) hd += Math.PI * 2;
      headSwing += Math.abs(hd);
      headPrev = hy;
      const hp = headPos();
      headMove = Math.max(headMove, Math.hypot(hp.x - head0.x, hp.z - head0.z));
      samples++;
    }
    let net = p.heading - start.h;
    while (net > Math.PI) net -= Math.PI * 2;
    while (net < -Math.PI) net += Math.PI * 2;

    const clips: Record<string, number> = {};
    const dbg = w.__session.heroRig?.debug() ?? {};
    for (const [k, v] of Object.entries(dbg)) if (v.weight > 0.001) clips[k] = v.weight;

    return {
      spot: label as string,
      yawDrift: (net * 180) / Math.PI,
      yawSwing: (swing * 180) / Math.PI,
      drift: Math.hypot(p.pos.x - start.x, p.pos.z - start.z),
      headMoveCm: headMove * 100,
      headSwingDeg: (headSwing * 180) / Math.PI,
      samples,
      clips,
    };
  }, [spot, name, seconds] as [[number, number], string, number]);
}

// Three spots, because the ground sampler behaves differently on each: the
// spawn on the boardwalk, the middle of a road, and up on a kerb. One test per
// spot, so each gets its own timeout rather than sharing one.
const SPOTS: Array<[string, [number, number]]> = [
  ['spawn', [0, 0]],
  ['road', [40, 40]],
  ['kerb', [-120, 85]],
];

for (const [name, xz] of SPOTS) {
  test(`standing still is standing still: ${name}`, async ({ page }) => {
    await boot(page);
    const r = await stand(page, xz, name, 30);

    const active = Object.entries(r.clips).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ');
    console.log(`${r.spot}: controller yaw net ${r.yawDrift.toFixed(3)} deg / swing `
      + `${r.yawSwing.toFixed(3)} deg, drift ${r.drift.toFixed(4)} m; head moved `
      + `${r.headMoveCm.toFixed(2)} cm and swung ${r.headSwingDeg.toFixed(2)} deg `
      + `over ${r.samples} samples [${active}]`);

    // A degree of total swing over 30 s is below what any eye reads as motion,
    // and a thousandth of the 720 deg/s the turn rate would allow if something
    // were actually driving it.
    expect(r.yawSwing, `${r.spot}: character rotated while standing still`).toBeLessThan(1);
    expect(r.drift, `${r.spot}: character drifted while standing still`).toBeLessThan(0.02);
    // Standing still means standing: the idle pose owns the body outright, so
    // no locomotion clip is left nudging it at a crawling timeScale.
    expect(r.clips.idle ?? 0, `${r.spot}: idle never reached full weight`).toBeGreaterThan(0.99);

    // The pose itself. The breath and the weight shift are meant to move the
    // body a little -- about a centimetre and a fifth of a degree -- so these
    // bound the intended motion rather than forbidding all of it. Before the
    // fix in boneOffsets.ts the same numbers were 53 cm and 13 deg.
    expect(r.headMoveCm, `${r.spot}: the head wandered while standing still`).toBeLessThan(4);
    expect(r.headSwingDeg, `${r.spot}: the head swung while standing still`).toBeLessThan(3);
  });
}
