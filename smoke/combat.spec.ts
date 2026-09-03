import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Section 10's acceptance, minus the parts that need a human eye.
//
// A light world with no post chain or shadow pass: nothing asserted here
// involves either, and simulated time advances at most a twelfth of a second
// per rendered frame, so on a software rasteriser the frame rate is the clock.
const QUERY = '?peds=16&traffic=4&post=0&shadows=0';
const SCREENS = path.resolve('screens/after-combat');

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENS, { recursive: true });
  const file = path.join(SCREENS, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`screenshot: ${file}`);
}

async function boot(page: Page): Promise<void> {
  await page.goto(`/${QUERY}&intro=0`);
  await page.waitForFunction(
    () => (window as unknown as { __game?: { ready: boolean } }).__game?.ready === true,
    null, { timeout: 60_000 },
  );
  await page.keyboard.press('Enter');
  // The smoke suite cannot take a real pointer lock, so the flag is set
  // directly; everything downstream of it is the same code the browser drives.
  await page.evaluate(() => (window as unknown as {
    __input: { lock(v: boolean): void };
  }).__input.lock(true));
}

/** Advance `seconds` of SIMULATED time. */
async function sim(page: Page, seconds: number): Promise<void> {
  await page.evaluate(async (secs: number) => {
    const w = window as unknown as { __game: { game: { time: number } } };
    const end = w.__game.game.time + secs;
    while (w.__game.game.time < end) await new Promise((r) => setTimeout(r, 16));
  }, seconds);
}

const inject = (page: Page, fn: string) => page.evaluate(fn);

test('mouse look turns the camera and steers the movement basis', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  await sim(page, 1);

  const turn = await page.evaluate(async () => {
    const w = window as unknown as {
      __session: { look: { yaw: number; pitch: number } };
      __input: { mouse(dx: number, dy: number): void };
      __game: { game: { time: number } };
    };
    const before = w.__session.look.yaw;
    // A full circle, a bit at a time, the way a hand moves a mouse.
    let travelled = 0;
    for (let i = 0; i < 24; i++) {
      w.__input.mouse(-120, 0);
      const t = w.__game.game.time + 0.05;
      while (w.__game.game.time < t) await new Promise((r) => setTimeout(r, 16));
      travelled += 120 * 0.0022;
    }
    const pitchBefore = w.__session.look.pitch;
    // And far further up and down than the clamp allows, to prove it clamps.
    w.__input.mouse(0, -4000);
    const t2 = w.__game.game.time + 0.1;
    while (w.__game.game.time < t2) await new Promise((r) => setTimeout(r, 16));
    const pitchMin = w.__session.look.pitch;
    w.__input.mouse(0, 9000);
    const t3 = w.__game.game.time + 0.1;
    while (w.__game.game.time < t3) await new Promise((r) => setTimeout(r, 16));
    return { before, after: w.__session.look.yaw, travelled, pitchBefore, pitchMin, pitchMax: w.__session.look.pitch };
  });

  const deg = (r: number) => ((r * 180) / Math.PI).toFixed(1);
  console.log(`mouse look: yaw travelled ${deg(turn.travelled)} deg (a full circle), `
    + `pitch clamped to ${deg(turn.pitchMin)} .. ${deg(turn.pitchMax)} deg`);
  // A full revolution of input, and the yaw is still a valid wrapped angle.
  expect(turn.travelled).toBeGreaterThan(Math.PI * 2);
  expect(Math.abs(turn.after)).toBeLessThanOrEqual(Math.PI + 1e-6);
  expect((turn.pitchMin * 180) / Math.PI).toBeGreaterThan(-35.5);
  expect((turn.pitchMax * 180) / Math.PI).toBeLessThan(60.5);

  // Movement is measured against the look, so walking forward with the camera
  // turned must travel along the camera's yaw and not along the world's +Z.
  const walk = await page.evaluate(async () => {
    const w = window as unknown as {
      __session: { look: { yaw: number }; player: { pos: { x: number; z: number } } };
      __input: { set(c: string, d: boolean): void };
      __game: { game: { time: number } };
    };
    const yaw = w.__session.look.yaw;
    const from = { ...w.__session.player.pos };
    w.__input.set('KeyW', true);
    const t = w.__game.game.time + 2;
    while (w.__game.game.time < t) await new Promise((r) => setTimeout(r, 16));
    w.__input.set('KeyW', false);
    const to = w.__session.player.pos;
    return { yaw, moved: Math.hypot(to.x - from.x, to.z - from.z), travelYaw: Math.atan2(to.x - from.x, to.z - from.z) };
  });
  let off = walk.travelYaw - walk.yaw;
  while (off > Math.PI) off -= Math.PI * 2;
  while (off < -Math.PI) off += Math.PI * 2;
  console.log(`walked ${walk.moved.toFixed(2)} m, ${deg(Math.abs(off))} deg off the look direction`);
  expect(walk.moved).toBeGreaterThan(3);
  expect(Math.abs(off), 'forward should mean away from the camera').toBeLessThan(0.25);

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

test('P swaps the jog for the goofy one without dropping the stride match', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);

  const r = await page.evaluate(async () => {
    const w = window as unknown as {
      __session: {
        player: { speed: number };
        heroRig: {
          locomotion: { goofy: boolean; goofyReplaces: string[] };
          footSpeed: number;
          debug(): Record<string, { weight: number; timeScale: number }>;
        } | null;
      };
      __input: { set(c: string, d: boolean): void; tap(c: string): void };
      __game: { game: { time: number } };
    };
    const wait = async (secs: number): Promise<void> => {
      const t = w.__game.game.time + secs;
      while (w.__game.game.time < t) await new Promise((r) => setTimeout(r, 16));
    };
    const sample = (): { speed: number; foot: number; clips: Record<string, number> } => {
      const clips: Record<string, number> = {};
      for (const [k, v] of Object.entries(w.__session.heroRig!.debug())) {
        if (v.weight > 0.02) clips[k] = v.weight;
      }
      return { speed: w.__session.player.speed, foot: w.__session.heroRig!.footSpeed, clips };
    };

    // Hold a jog: the goofy clip stands in for whichever rung it was authored
    // closest to, so the test drives to that rung's own speed.
    w.__input.set('KeyW', true);
    await wait(3);
    const normal = sample();
    w.__input.tap('KeyP');
    await wait(1.5);
    const goofy = sample();
    w.__input.set('KeyW', false);
    return { replaces: w.__session.heroRig!.locomotion.goofyReplaces, normal, goofy };
  });

  const show = (s: { speed: number; foot: number; clips: Record<string, number> }): string =>
    `body ${s.speed.toFixed(2)} m/s, feet ${s.foot.toFixed(2)} m/s [`
    + Object.entries(s.clips).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ') + ']';
  console.log(`goofy replaces [${r.replaces.join(', ')}]`);
  console.log(`  before P: ${show(r.normal)}`);
  console.log(`  after  P: ${show(r.goofy)}`);

  expect(r.replaces.length).toBeGreaterThan(0);
  expect(r.goofy.clips.jogGoofy ?? 0, 'the goofy clip should be playing').toBeGreaterThan(0.1);
  expect(r.normal.clips.jogGoofy ?? 0, 'and not before P was pressed').toBeLessThan(0.02);
  // The foot-slide rule still applies: the goofy clip has its own authored
  // speed and therefore its own timeScale.
  const slip = Math.abs(r.goofy.foot - r.goofy.speed) / Math.max(r.goofy.speed, 0.01);
  console.log(`  goofy foot slip ${(slip * 100).toFixed(1)}%`);
  expect(slip, 'goofy jog should not skate').toBeLessThan(0.25);

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

test('punching and the pistol knock civilians down and raise the heat', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  await sim(page, 1);

  // Stand next to somebody and face them.
  await inject(page, `(() => {
    const s = window.__session;
    const list = s.peds.list();
    let best = list[0], bestN = -1;
    for (const a of list) {
      const n = list.filter((b) => Math.hypot(a.x - b.x, a.z - b.z) < 8).length;
      if (n > bestN) { bestN = n; best = a; }
    }
    s.player.placeAt(best.x - 1.1, best.z, 0);
  })()`);
  await sim(page, 1);
  await inject(page, `(() => {
    const s = window.__session;
    let best = null, bd = 1e9;
    for (const t of s.peds.targets()) {
      const d = Math.hypot(t.x - s.player.pos.x, t.z - s.player.pos.z);
      if (d < bd) { bd = d; best = t; }
    }
    s.player.heading = Math.atan2(best.x - s.player.pos.x, best.z - s.player.pos.z);
    s.look.yaw = s.player.heading;
  })()`);
  await sim(page, 0.3);

  // Three punches chaining. Each click is one punch; the cooldown is short
  // enough that they run together. The player is re-aimed before each swing,
  // because pedestrians walk and a player would turn to follow one.
  const aimAtNearest = `(() => {
    const s = window.__session;
    let best = null, bd = 1e9;
    for (const t of s.peds.targets()) {
      if (t.down) continue;
      const d = Math.hypot(t.x - s.player.pos.x, t.z - s.player.pos.z);
      if (d < bd) { bd = d; best = t; }
    }
    if (!best) return;
    // Step in and face them, the way a player closing on somebody would. No
    // pause afterwards: a pedestrian walks 1.4 m/s, and half a second of
    // hesitation is most of the punch's reach.
    s.player.placeAt(best.x, best.z - 0.8, 0);
    s.player.heading = 0;
    s.look.yaw = 0;
  })()`;
  // Heat bleeds off at about seven a second, so the peak is what says a
  // knockdown was scored -- sampling at the end measures the decay instead.
  let peakHeat = 0;
  const heatNow = async (): Promise<number> => page.evaluate(
    () => (window as unknown as { __session: { wanted: { heat: number } } }).__session.wanted.heat,
  );
  for (let i = 0; i < 3; i++) {
    await inject(page, aimAtNearest);
    await inject(page, `window.__input.button('left', true)`);
    await sim(page, 0.08);
    await inject(page, `window.__input.button('left', false)`);
    await sim(page, 0.4);
    peakHeat = Math.max(peakHeat, await heatNow());
    await sim(page, 0.4);
    peakHeat = Math.max(peakHeat, await heatNow());
  }
  await sim(page, 1.5);
  await shoot(page, 'punch-knockdown');

  const afterPunch = await page.evaluate(() => {
    const w = window as unknown as {
      __session: {
        peds: { list(): Array<{ mode: string }> };
        wanted: { heat: number };
      };
    };
    return {
      down: w.__session.peds.list().filter((p) => p.mode === 'down').length,
      fleeing: w.__session.peds.list().filter((p) => p.mode === 'flee').length,
      heat: w.__session.wanted.heat,
    };
  });
  console.log(`after 3 punches: ${afterPunch.down} down, ${afterPunch.fleeing} fleeing, `
    + `heat peaked at ${peakHeat.toFixed(0)} and had decayed to ${afterPunch.heat.toFixed(0)}`);
  expect(afterPunch.down, 'a punch should knock a civilian down').toBeGreaterThanOrEqual(1);
  // Section 8: witnesses run.
  expect(afterPunch.fleeing, 'witnesses should flee').toBeGreaterThanOrEqual(1);
  // Section 9: a punch knockdown is worth 40.
  expect(peakHeat, 'a knockdown should raise the heat').toBeGreaterThanOrEqual(35);

  // --- the pistol ---------------------------------------------------------
  await inject(page, `window.__input.tap('KeyH')`);
  await sim(page, 0.6);
  const drawn = await page.evaluate(() => {
    const c = (window as unknown as { __session: { combat: { armed: boolean; draw: number } } })
      .__session.combat;
    return { armed: c.armed, draw: c.draw };
  });
  console.log(`pistol drawn: armed=${drawn.armed} draw=${drawn.draw.toFixed(2)}`);
  expect(drawn.armed).toBe(true);
  expect(drawn.draw).toBeGreaterThan(0.95);
  await shoot(page, 'pistol-drawn');

  // Aim: the camera goes over the shoulder and the field of view narrows.
  const fovBefore = await page.evaluate(
    () => (window as unknown as { __game: { game: { camera: { fov: number } } } }).__game.game.camera.fov,
  );
  await inject(page, `window.__input.button('right', true)`);
  await sim(page, 1);
  const aim = await page.evaluate(() => {
    const w = window as unknown as {
      __session: { combat: { aiming: boolean } };
      __game: { game: { camera: { fov: number } } };
    };
    return { aiming: w.__session.combat.aiming, fov: w.__game.game.camera.fov };
  });
  console.log(`aiming: ${aim.aiming}, fov ${fovBefore.toFixed(1)} -> ${aim.fov.toFixed(1)}`);
  expect(aim.aiming).toBe(true);
  expect(aim.fov).toBeLessThan(fovBefore - 5);
  await shoot(page, 'pistol-aiming');

  // Fire at whoever is left standing.
  const before = await page.evaluate(
    () => (window as unknown as { __session: { peds: { list(): Array<{ mode: string }> } } })
      .__session.peds.list().filter((p) => p.mode === 'down').length,
  );
  // Aim the way a player does: nudge the look until the crosshair is on the
  // target, and check it got there.
  //
  // Turning the PLAYER toward somebody is not the same thing as aiming at them.
  // The over-the-shoulder camera sits 0.6 m to the right, and the shot goes
  // where the crosshair points -- so a target dead ahead of the character is
  // most of a metre to the left of the sight line. That is correct, and it is
  // why this closes the loop on the camera's own forward vector instead.
  const aimError = await page.evaluate(async () => {
    const w = window as unknown as {
      __session: { peds: { targets(): Array<{ x: number; y: number; z: number; down: boolean }> };
        player: { pos: { x: number; z: number } }; look: { yaw: number; pitch: number } };
      __game: { game: { time: number; camera: unknown }; THREE: { Vector3: new (x?: number, y?: number, z?: number) => never } };
    };
    const cam = w.__game.game.camera as {
      position: { x: number; y: number; z: number };
      getWorldDirection(v: unknown): { x: number; y: number; z: number };
    };
    const wait = async (secs: number): Promise<void> => {
      const t = w.__game.game.time + secs;
      while (w.__game.game.time < t) await new Promise((r) => setTimeout(r, 16));
    };
    const nearest = (): { x: number; y: number; z: number } | null => {
      let best = null, bd = 1e9;
      for (const t of w.__session.peds.targets()) {
        if (t.down) continue;
        const d = Math.hypot(t.x - w.__session.player.pos.x, t.z - w.__session.player.pos.z);
        if (d < bd) { bd = d; best = t; }
      }
      return best;
    };
    const fwd = new w.__game.THREE.Vector3() as unknown as { x: number; y: number; z: number };
    let err = Math.PI;
    for (let i = 0; i < 8; i++) {
      await wait(0.25);
      const t = nearest();
      if (!t) break;
      cam.getWorldDirection(fwd);
      const dx = t.x - cam.position.x;
      const dz = t.z - cam.position.z;
      // Chest height, which is the middle of the capsule the shot tests.
      const dy = t.y + 0.9 - cam.position.y;
      const flat = Math.hypot(dx, dz);
      let dyaw = Math.atan2(dx, dz) - Math.atan2(fwd.x, fwd.z);
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      const dpitch = Math.atan2(dy, flat) - Math.atan2(fwd.y, Math.hypot(fwd.x, fwd.z));
      w.__session.look.yaw += dyaw;
      // The look pitch raises the eye and drops the target, so correcting it
      // takes the opposite sign and a gentle gain.
      w.__session.look.pitch -= dpitch * 0.6;
      err = Math.hypot(dyaw, dpitch);
    }
    return (err * 180) / Math.PI;
  });
  console.log(`crosshair settled ${aimError.toFixed(2)} deg off the target`);
  expect(aimError, 'the aim loop should converge on the target').toBeLessThan(4);
  await sim(page, 0.3);
  let peakShotHeat = 0;
  for (let i = 0; i < 4; i++) {
    await inject(page, `window.__input.button('left', true)`);
    await sim(page, 0.1);
    await inject(page, `window.__input.button('left', false)`);
    await sim(page, 0.25);
    peakShotHeat = Math.max(peakShotHeat, await heatNow());
  }
  await sim(page, 1);
  peakShotHeat = Math.max(peakShotHeat, await heatNow());
  await inject(page, `window.__input.button('right', false)`);

  const afterShots = await page.evaluate(() => {
    const w = window as unknown as {
      __session: {
        peds: { list(): Array<{ mode: string }> };
        combat: { shots: number };
        wanted: { heat: number };
      };
    };
    return {
      shots: w.__session.combat.shots,
      down: w.__session.peds.list().filter((p) => p.mode === 'down').length,
      heat: w.__session.wanted.heat,
    };
  });
  console.log(`fired ${afterShots.shots} shots; ${afterShots.down} down (was ${before}), `
    + `heat peaked at ${peakShotHeat.toFixed(0)}`);
  expect(afterShots.shots).toBeGreaterThanOrEqual(3);
  expect(afterShots.down, 'a shot should knock a civilian down').toBeGreaterThan(before);
  // A shot knockdown is worth 100, which is a full star.
  expect(peakShotHeat, 'shooting somebody should raise the heat').toBeGreaterThanOrEqual(80);
  await shoot(page, 'shot-knockdown');

  // Holster, and the left button goes quiet again.
  await inject(page, `window.__input.tap('KeyH')`);
  await sim(page, 0.6);
  const holstered = await page.evaluate(
    () => (window as unknown as { __session: { combat: { armed: boolean; shots: number } } }).__session.combat,
  );
  const shotsAtHolster = holstered.shots;
  await inject(page, `window.__input.button('left', true)`);
  await sim(page, 0.4);
  await inject(page, `window.__input.button('left', false)`);
  const after = await page.evaluate(
    () => (window as unknown as { __session: { combat: { shots: number } } }).__session.combat.shots,
  );
  expect(holstered.armed).toBe(false);
  expect(after, 'holstered, the left button punches rather than firing').toBe(shotsAtHolster);

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

test('the directional clips cover the way the character is actually moving', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  await sim(page, 1);

  // Every direction the rig knows, and which way its own root motion travels.
  const anchors = await page.evaluate(
    () => (window as unknown as {
      __session: { heroRig: { locomotion: { directionNames: Array<{ name: string; deg: number; armed: boolean }> } } };
    }).__session.heroRig.locomotion.directionNames,
  );
  console.log('directions: ' + anchors.map((a) => `${a.name} @${a.deg}deg${a.armed ? ' (armed)' : ''}`).join(', '));
  // Each one-sided clip is mirrored, so both diagonals are covered by one file.
  expect(anchors.some((a) => a.name.endsWith(':mirror'))).toBe(true);
  for (const a of anchors) {
    if (!a.name.endsWith(':mirror')) continue;
    const source = a.name.replace(':mirror', '');
    const twin = anchors.find((b) => b.name === source);
    expect(twin, `${a.name} should mirror ${source}`).toBeDefined();
    expect(a.deg).toBe(-twin!.deg);
  }

  // Draw the pistol: the character now faces the camera and strafes, which is
  // the state the directional clips exist for.
  await inject(page, `window.__input.tap('KeyH')`);
  await sim(page, 0.8);

  const sample = async (keys: string[], label: string): Promise<{ clips: Record<string, number>; deg: number }> => {
    await page.evaluate((ks: string[]) => {
      const i = (window as unknown as { __input: { set(c: string, d: boolean): void } }).__input;
      for (const c of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) i.set(c, false);
      for (const c of ks) i.set(c, true);
    }, keys);
    await sim(page, 1.6);
    const r = await page.evaluate(() => {
      const w = window as unknown as {
        __session: {
          heroRig: {
            locomotion: { moveAngle: number };
            debug(): Record<string, { weight: number }>;
          };
        };
      };
      const clips: Record<string, number> = {};
      for (const [k, v] of Object.entries(w.__session.heroRig.debug())) {
        if (v.weight > 0.15) clips[k] = +v.weight.toFixed(2);
      }
      return { clips, deg: Math.round((w.__session.heroRig.locomotion.moveAngle * 180) / Math.PI) };
    });
    console.log(`  ${label}: ${r.deg} deg -> [`
      + Object.entries(r.clips).map(([k, v]) => `${k} ${v}`).join(', ') + ']');
    return r;
  };

  const right = await sample(['KeyD'], 'strafe right');
  const back = await sample(['KeyS'], 'straight back');
  const backLeft = await sample(['KeyS', 'KeyA'], 'back and left');
  await page.evaluate(() => {
    const i = (window as unknown as { __input: { set(c: string, d: boolean): void } }).__input;
    for (const c of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) i.set(c, false);
  });

  const playing = (r: { clips: Record<string, number> }, match: RegExp): boolean =>
    Object.keys(r.clips).some((k) => match.test(k));
  // Armed, so the pistol set is what should be playing -- and a sideways
  // heading must not be answered with a forward clip.
  expect(Math.abs(right.deg)).toBeGreaterThan(60);
  expect(playing(right, /pistolStrafe/), 'strafing should play the strafe clip').toBe(true);
  expect(Math.abs(back.deg)).toBeGreaterThan(150);
  expect(playing(back, /pistolBack/), 'backing up should play the backward clip').toBe(true);
  // Diagonally back is between the two, so both should be showing.
  expect(Math.abs(backLeft.deg)).toBeGreaterThan(100);
  expect(Math.abs(backLeft.deg)).toBeLessThan(170);
  expect(playing(backLeft, /pistolStrafe|pistolBack/)).toBe(true);

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('Space plays the jump clip, timed to the physics take-off', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  await sim(page, 1);

  const r = await page.evaluate(async () => {
    const w = window as unknown as {
      __session: {
        player: { y: number; onGround: boolean };
        heroRig: {
          has(n: string): boolean;
          durationOf(n: string): number;
          takeOffOf(n: string): number;
          oneShot: { clip: string | null; weight: number };
        } | null;
      };
      __input: { tap(c: string): void };
      __game: { game: { time: number } };
    };
    const rig = w.__session.heroRig!;
    const wait = async (secs: number): Promise<void> => {
      const t = w.__game.game.time + secs;
      while (w.__game.game.time < t) await new Promise((r) => setTimeout(r, 16));
    };
    const takeOff = rig.takeOffOf('jump');
    const duration = rig.durationOf('jump');
    w.__input.tap('Space');
    // Sample through the jump: the clip should be the one-shot on the layer,
    // and the character should actually leave the ground.
    let sawClip = false, peak = 0, sawAir = false;
    for (let i = 0; i < 40; i++) {
      await wait(0.05);
      if (rig.oneShot.clip === 'jump' && rig.oneShot.weight > 0.5) sawClip = true;
      if (!w.__session.player.onGround) sawAir = true;
      peak = Math.max(peak, w.__session.player.y);
    }
    await wait(1);
    return {
      has: rig.has('jump'), takeOff, duration, sawClip, sawAir, peak,
      landedClip: rig.oneShot.clip, landedWeight: rig.oneShot.weight,
    };
  });

  console.log(`jump: clip ${r.duration.toFixed(2)} s, take-off measured at `
    + `${r.takeOff.toFixed(3)} s; airborne=${r.sawAir}, peak y ${r.peak.toFixed(2)} m, `
    + `clip played=${r.sawClip}, after landing weight ${r.landedWeight.toFixed(2)}`);
  expect(r.has, 'a jump clip was supplied').toBe(true);
  // Measured, not assumed: the take-off has to be inside the clip and early.
  expect(r.takeOff).toBeGreaterThan(0);
  expect(r.takeOff).toBeLessThan(r.duration * 0.5);
  expect(r.sawClip, 'the jump clip should drive the body').toBe(true);
  expect(r.sawAir, 'the character should leave the ground').toBe(true);
  expect(r.peak).toBeGreaterThan(0.5);
  // And hand the body back once down.
  expect(r.landedWeight).toBeLessThan(0.05);

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('downed civilians stay down, then get up', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  await sim(page, 1);

  // Knock one down directly, so the test is about what happens next.
  await inject(page, `(() => {
    const s = window.__session;
    const t = s.peds.targets();
    s.player.placeAt(t[0].x - 1.5, t[0].z, 0);
    s.peds.targets()[0].knockDown(s.player.pos.x, s.player.pos.z);
  })()`);
  await sim(page, 2.5);

  const settled = await page.evaluate(() => {
    const w = window as unknown as {
      __session: { peds: { list(): Array<{ mode: string; y: number }> } };
    };
    const down = w.__session.peds.list().filter((p) => p.mode === 'down');
    return { count: down.length, lowestY: Math.min(...down.map((p) => p.y)) };
  });
  console.log(`knocked down: ${settled.count}, lowest y ${settled.lowestY.toFixed(3)} m`);
  expect(settled.count).toBe(1);
  // Never through the floor (section 10).
  expect(settled.lowestY).toBeGreaterThanOrEqual(-0.01);

  // Still down well before the 60 s timer. Twelve seconds proves it as well as
  // fifty would, and on a software rasteriser every simulated second is real
  // minutes of test.
  await sim(page, 10);
  const midway = await page.evaluate(
    () => (window as unknown as { __session: { peds: { list(): Array<{ mode: string }> } } })
      .__session.peds.list().filter((p) => p.mode === 'down').length,
  );
  console.log(`still down after 12 s: ${midway}`);
  expect(midway, 'nobody gets up early').toBe(1);

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});
