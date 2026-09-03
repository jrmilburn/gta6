import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// A body on the ground stays on the ground. Reported from play: "sometimes
// pedestrians start moving around while still down".
test.use({ viewport: { width: 480, height: 270 } });

async function boot(page: Page): Promise<void> {
  await page.goto('/?nohud=1&peds=40&traffic=8&intro=0');
  await page.waitForFunction(
    () => (window as unknown as { __game?: { ready: boolean } }).__game?.ready === true,
    null, { timeout: 90_000 },
  );
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => (window as unknown as { __session?: { peds: unknown } }).__session?.peds != null,
    null, { timeout: 30_000 },
  );
}

test('a body on the ground stays on the ground', async ({ page }) => {
  test.setTimeout(900_000);
  await boot(page);

  const r = await page.evaluate(async () => {
    const w = window as unknown as {
      __game: { game: { time: number } };
      __session: {
        player: { pos: { x: number; z: number } };
        peds: {
          list(): Array<{ x: number; z: number; mode: string }>;
          targets(): Array<{ x: number; z: number; down: boolean; knockDown(x: number, z: number): void }>;
        };
      };
    };
    const wait = async (secs: number): Promise<void> => {
      const t = w.__game.game.time + secs;
      while (w.__game.game.time < t) await new Promise((r) => setTimeout(r, 16));
    };
    await wait(1.5);

    // Knock over everybody within reach of the player, so the sample is a
    // crowd of bodies rather than one.
    const me = w.__session.player.pos;
    const hit: number[] = [];
    const all = w.__session.peds.list();
    const targets = w.__session.peds.targets();
    // The nearest dozen, wherever they are: at this crowd size over a 912 m
    // city there may be nobody at all within a block of the spawn.
    const order = targets
      .map((t, i) => ({ i, t, d: Math.hypot(t.x - me.x, t.z - me.z) }))
      .filter((e) => !e.t.down)
      .sort((a, b) => a.d - b.d)
      .slice(0, 12);
    for (const e of order) {
      e.t.knockDown(me.x, me.z);
      hit.push(e.i);
    }
    await wait(0.6);

    // Index into list() is stable (a fixed pool), so track by index.
    const downNow = (): number[] => {
      const l = w.__session.peds.list();
      const out: number[] = [];
      for (let i = 0; i < l.length; i++) if (l[i].mode === 'down') out.push(i);
      return out;
    };
    const watched = downNow();
    const prev = new Map<number, { x: number; z: number }>();
    for (const i of watched) prev.set(i, { x: all[i].x, z: all[i].z });

    let worstStep = 0;
    let worstTotal = 0;
    let worstIdx = -1;
    const start = new Map(prev);
    const modesSeen = new Set<string>();
    let samples = 0;

    for (let n = 0; n < 80; n++) {
      await wait(0.25);
      const l = w.__session.peds.list();
      samples++;
      for (const i of watched) {
        const now = l[i];
        modesSeen.add(now.mode);
        // Only judge them while they are still ON the ground. Once the mode
        // leaves 'down' they have stood up and are allowed to walk.
        if (now.mode !== 'down') continue;
        const p = prev.get(i);
        if (p) {
          const step = Math.hypot(now.x - p.x, now.z - p.z);
          if (step > worstStep) { worstStep = step; worstIdx = i; }
        }
        const s = start.get(i);
        if (s) worstTotal = Math.max(worstTotal, Math.hypot(now.x - s.x, now.z - s.z));
        prev.set(i, { x: now.x, z: now.z });
      }
    }
    return {
      knocked: hit.length,
      watched: watched.length,
      samples,
      worstStep,
      worstTotal,
      worstIdx,
      modesSeen: [...modesSeen],
    };
  });

  console.log(`knocked ${r.knocked} down, watched ${r.watched} over ${r.samples} samples`);
  console.log(`  worst single step while down: ${r.worstStep.toFixed(3)} m (ped ${r.worstIdx})`);
  console.log(`  worst total drift while down: ${r.worstTotal.toFixed(3)} m`);
  console.log(`  modes seen among them: ${r.modesSeen.join(', ')}`);

  expect(r.watched, 'the test needs bodies to watch').toBeGreaterThan(3);
  // The fall clip carries its own root motion, so the body travels as it goes
  // down -- but that is over within the fall. Once down, it should not walk.
  expect(r.worstTotal, 'a body on the ground should not travel').toBeLessThan(1.5);
});

// The instanced crowd is the path that was wrong: it handled a tumble and had
// no case for a knockdown at all, so a body it drew stood bolt upright. It is
// also what the whole crowd falls back to with ?assets=0, which is the only way
// to get every pedestrian onto it at once.
test('the procedural crowd lies down too', async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 900, height: 620 });
  await page.goto('/?nohud=1&peds=40&traffic=0&intro=0&assets=0');
  await page.waitForFunction(
    () => (window as unknown as { __game?: { ready: boolean } }).__game?.ready === true,
    null, { timeout: 90_000 },
  );
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => (window as unknown as { __session?: { peds: unknown } }).__session?.peds != null,
    null, { timeout: 30_000 },
  );

  const down = await page.evaluate(async () => {
    const w = window as unknown as {
      __game: { game: { time: number; camera: { position: { set(x: number, y: number, z: number): void };
        lookAt(x: number, y: number, z: number): void; fov: number; updateProjectionMatrix(): void } } };
      __session: {
        rig: { setSubject(s: null): void };
        player: { pos: { x: number; z: number }; placeAt(x: number, z: number, h: number): void };
        peds2?: unknown;
        peds: {
          list(): Array<{ x: number; z: number; y: number; mode: string }>;
          targets(): Array<{ x: number; z: number; down: boolean; knockDown(x: number, z: number): void }>;
        };
      };
    };
    const wait = async (secs: number): Promise<void> => {
      const t = w.__game.game.time + secs;
      while (w.__game.game.time < t) await new Promise((r) => setTimeout(r, 16));
    };
    await wait(1.5);

    // Stand next to somebody FIRST, then knock that one over. Framing the
    // nearest of a scattered dozen just aims the camera at empty pavement, and
    // the crowd pool draws relative to the PLAYER rather than the camera, so a
    // body far from the player is not drawn at all however closely it is
    // watched.
    const me = w.__session.player.pos;
    const targets = w.__session.peds.targets();
    const pick = targets
      .map((t, i) => ({ i, t, d: Math.hypot(t.x - me.x, t.z - me.z) }))
      .filter((e) => !e.t.down)
      .sort((a, b) => a.d - b.d)[0];
    if (!pick) return null;
    w.__session.player.placeAt(pick.t.x + 2.5, pick.t.z, 0);
    await wait(0.8);

    // Re-read: targets are rebuilt each call, and this one is now under our nose.
    const fresh = w.__session.peds.targets()[pick.i];
    fresh.knockDown(w.__session.player.pos.x, w.__session.player.pos.z);
    await wait(2.5);

    const b = w.__session.peds.list()[pick.i];
    if (b.mode !== 'down') return null;
    const cam = w.__game.game.camera;
    w.__session.rig.setSubject(null);
    cam.position.set(b.x + 3.2, 1.4, b.z + 3.2);
    cam.lookAt(b.x, 0.3, b.z);
    cam.fov = 55;
    cam.updateProjectionMatrix();
    await wait(0.3);

    // Read what was actually DRAWN. Every instanced pedestrian mesh in the
    // scene is searched for an instance standing at the body's feet, and its
    // local up-axis is compared with world up: 0 degrees is bolt upright, 90 is
    // flat on the ground. This is the assertion the screenshots could not make.
    const THREE = (window as unknown as { __game: { THREE: typeof import('three') } }).__game.THREE;
    const M4 = new THREE.Matrix4();
    const UPV = new THREE.Vector3();
    const POS = new THREE.Vector3();
    const Qd = new THREE.Quaternion();
    const Sd = new THREE.Vector3();
    let found = false;
    let tilt = 0;
    let nearest = Infinity;
    w.__game.game.scene.traverse((o: unknown) => {
      const im = o as { isInstancedMesh?: boolean; count?: number;
        getMatrixAt(i: number, m: unknown): void; visible: boolean };
      if (!im.isInstancedMesh || !im.count) return;
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, M4);
        M4.decompose(POS, Qd, Sd);
        const d = Math.hypot(POS.x - b.x, POS.z - b.z);
        if (d > 0.6) continue;
        if (d < nearest) {
          nearest = d;
          found = true;
          UPV.set(0, 1, 0).applyQuaternion(Qd);
          tilt = Math.acos(Math.max(-1, Math.min(1, UPV.y))) * 180 / Math.PI;
        }
      }
    });

    return {
      body: { x: +b.x.toFixed(2), z: +b.z.toFixed(2) },
      player: { x: +w.__session.player.pos.x.toFixed(2), z: +w.__session.player.pos.z.toFixed(2) },
      mode: b.mode,
      drawn: found,
      nearest: +nearest.toFixed(2),
      tiltDeg: +tilt.toFixed(1),
    };
  });

  const dir = path.resolve('screens/police');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'downed-procedural.png');
  await page.screenshot({ path: file });
  console.log(`procedural body: ${JSON.stringify(down)}`);
  console.log(`screenshot: ${file}`);
  expect(down, 'a body should have been knocked down').not.toBeNull();
  const d = down as { drawn: boolean; tiltDeg: number };
  expect(d.drawn, 'the body should be drawn at all').toBe(true);
  // 0 degrees is bolt upright, which is what this whole spec exists to catch.
  expect(d.tiltDeg, 'and it should be lying down, not standing').toBeGreaterThan(60);
});

/**
 * The tilt of whatever instanced pedestrian is drawn standing at (x, z), in
 * degrees away from upright: 0 is bolt upright, 90 is flat on the ground.
 * Returns null when nothing is drawn there.
 */
async function tiltAt(page: Page, x: number, z: number): Promise<number | null> {
  return page.evaluate(([bx, bz]) => {
    const w = window as unknown as {
      __game: { THREE: typeof import('three'); game: { scene: { traverse(f: (o: unknown) => void): void } } };
    };
    const THREE = w.__game.THREE;
    const M4 = new THREE.Matrix4();
    const UPV = new THREE.Vector3();
    const POS = new THREE.Vector3();
    const Q = new THREE.Quaternion();
    const S = new THREE.Vector3();
    let nearest = Infinity;
    let tilt: number | null = null;
    w.__game.game.scene.traverse((o: unknown) => {
      const im = o as { isInstancedMesh?: boolean; count?: number; getMatrixAt(i: number, m: unknown): void };
      if (!im.isInstancedMesh || !im.count) return;
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, M4);
        M4.decompose(POS, Q, S);
        const d = Math.hypot(POS.x - (bx as number), POS.z - (bz as number));
        if (d > 0.6 || d >= nearest) continue;
        nearest = d;
        UPV.set(0, 1, 0).applyQuaternion(Q);
        tilt = Math.acos(Math.max(-1, Math.min(1, UPV.y))) * 180 / Math.PI;
      }
    });
    return tilt;
  }, [x, z] as [number, number]);
}

// The path the report actually came from. A pedestrian near the player gets a
// skinned rig and a proper fall clip, and the slot allocator deliberately keeps
// a rig on anybody who is down. But there are only CFG.anim.skinnedPeds (16) of
// them: knock over more bodies than that and the overflow is drawn as a static
// instance instead -- which is where the knockdown used to be forgotten, so
// those bodies stood bolt upright. That is the "sometimes".
test('bodies past the skinned slot pool still lie down', async ({ page }) => {
  test.setTimeout(900_000);
  await boot(page);

  const r = await page.evaluate(async () => {
    const w = window as unknown as {
      __game: { THREE: typeof import('three');
        game: { time: number; scene: { traverse(f: (o: unknown) => void): void } } };
      __session: {
        player: { pos: { x: number; z: number } };
        peds: {
          list(): Array<{ x: number; z: number; mode: string }>;
          targets(): Array<{ x: number; z: number; down: boolean; knockDown(x: number, z: number): void }>;
        };
      };
    };
    const wait = async (secs: number): Promise<void> => {
      const t = w.__game.game.time + secs;
      while (w.__game.game.time < t) await new Promise((r) => setTimeout(r, 16));
    };
    await wait(1.5);

    // Well past the 16 available rigs. A knocked-down pedestrian is a slot
    // candidate however far away it is, so these need not be nearby.
    const me = w.__session.player.pos;
    const picks = w.__session.peds.targets()
      .map((t, i) => ({ i, d: Math.hypot(t.x - me.x, t.z - me.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 26);
    for (const e of picks) {
      const t = w.__session.peds.targets()[e.i];
      if (!t.down) t.knockDown(me.x, me.z);
    }
    await wait(3);

    const list = w.__session.peds.list();
    const down = picks.map((e) => e.i).filter((i) => list[i].mode === 'down');

    // Read every instanced pedestrian matrix once, then match bodies to it.
    const THREE = w.__game.THREE;
    const M4 = new THREE.Matrix4();
    const POS = new THREE.Vector3();
    const Q = new THREE.Quaternion();
    const S = new THREE.Vector3();
    const UPV = new THREE.Vector3();
    const drawn: Array<{ x: number; z: number; tilt: number }> = [];
    w.__game.game.scene.traverse((o: unknown) => {
      const im = o as { isInstancedMesh?: boolean; count?: number; getMatrixAt(i: number, m: unknown): void };
      if (!im.isInstancedMesh || !im.count) return;
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, M4);
        M4.decompose(POS, Q, S);
        UPV.set(0, 1, 0).applyQuaternion(Q);
        drawn.push({
          x: POS.x, z: POS.z,
          tilt: Math.acos(Math.max(-1, Math.min(1, UPV.y))) * 180 / Math.PI,
        });
      }
    });

    let asInstance = 0;
    let worstUpright = 0;
    for (const i of down) {
      const b = list[i];
      let best: { tilt: number } | null = null;
      let bd = 0.6;
      for (const d of drawn) {
        const dist = Math.hypot(d.x - b.x, d.z - b.z);
        if (dist < bd) { bd = dist; best = d; }
      }
      if (!best) continue; // still holding a skinned rig
      asInstance++;
      worstUpright = Math.max(worstUpright, 90 - best.tilt);
    }
    return { knocked: picks.length, down: down.length, asInstance, worstUpright: +worstUpright.toFixed(1) };
  });

  console.log(`${r.down} bodies down, ${r.asInstance} of them past the 16 skinned rigs `
    + `and drawn as static instances; worst deviation from flat ${r.worstUpright} deg`);
  expect(r.down, 'plenty of bodies').toBeGreaterThan(16);
  expect(r.asInstance, 'some should have overflowed the skinned pool').toBeGreaterThan(0);
  // 0 means flat on the ground. 90 would be standing bolt upright, which is the
  // bug: "sometimes pedestrians start moving around while still down".
  expect(r.worstUpright, 'every overflowed body should still be lying down').toBeLessThan(30);
});
