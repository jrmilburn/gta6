import { test, expect } from '@playwright/test';

test('new player: skin, directional layers, weapons, recoil and emote cancellation', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'warning' && /PropertyBinding/.test(m.text())) errors.push(m.text()); });
  await page.goto('/?peds=0&traffic=0&intro=0&post=0');
  await page.waitForFunction(() => (window as any).__game?.ready, null, { timeout: 90000 });
  await page.keyboard.press('Enter');
  await page.getByText('SUNBELT CITY', { exact: true }).waitFor({ state: 'hidden' });
  await page.waitForFunction(() => (window as any).__session?.heroRig);
  const result = await page.evaluate(() => {
    const w = window as any, s = w.__session, g = w.__game.game, T = w.__game.THREE;
    const r = s.heroRig, p = s.player, input = w.__input;
    g.paused = true; input.lock(true);
    const step = (seconds: number) => {
      for (let n = 0; n < seconds * 60; n++) {
        g.step(1 / 60);
        for (const renderable of g.renderables) renderable.renderSync(1, 1 / 60);
        g.scene.updateMatrixWorld(true);
      }
    };
    step(0.5);
    let skin: any;
    r.root.traverse((o: any) => { if (o.isSkinnedMesh) skin = o; });
    skin.computeBoundingBox();
    const box = new T.Box3().setFromObject(r.group);
    const initial = { bones: skin.skeleton.bones.length, height: box.max.y - box.min.y, floor: box.min.y - p.y };
    const bad: string[] = [];
    const check = (label: string) => {
      r.root.traverse((o: any) => {
        if (o.isBone && ![...o.position.toArray(), ...o.quaternion.toArray()].every(Number.isFinite)) bad.push(label);
      });
      const weights = r.debug();
      if (Object.values(weights).some((v: any) => !Number.isFinite(v.weight))) bad.push(label);
    };
    // Exercise every local direction at walk/run speeds directly, independent of world obstacles.
    for (const armed of [false, true]) for (const speed of [0, 1.5, 4, 8]) for (let d = 0; d < 8; d++) {
      r.locomotion.armed = armed; r.locomotion.moveAngle = d * Math.PI / 4 - Math.PI;
      for (let i = 0; i < 35; i++) r.update({ dt: 1 / 60, time: i / 60, speed, turnRate: 0, grounded: true, airborne: false, crouch: 0, opacity: 1 });
      check(`${armed}/${speed}/${d}`);
    }
    p.setColliders([]); p.setVehicles([]);
    input.set('KeyW', true); step(0.8);
    const walk = p.speed;
    input.set('ShiftLeft', true); step(0.8);
    const run = p.speed;
    input.set('KeyW', false); input.set('ShiftLeft', false); step(1);
    input.tap('KeyH'); step(0.8);
    const weapons: any[] = [];
    let maxSupportError = 0, minAimAlignment = 1;
    for (const [key, id] of [['Digit1', 'pistol'], ['Digit2', 'mg'], ['Digit3', 'sniper'], ['Digit4', 'rpg']]) {
      input.tap(key); step(0.5);
      input.button('right', true); step(0.4);
      for (const pitch of [-0.6, 0, 0.6]) {
        s.look.pitch = pitch; step(0.4); check(`${id}/pitch/${pitch}`);
        const gun = s.combat.arsenal.parts.group;
        const ray = g.camera.getWorldDirection(new T.Vector3());
        const barrel = new T.Vector3(0, 0, 1).applyQuaternion(gun.getWorldQuaternion(new T.Quaternion()));
        minAimAlignment = Math.min(minAimAlignment, ray.dot(barrel));
        if (id !== 'pistol') {
          const grip = id === 'mg' ? [0, 0.005, 0.18] : id === 'sniper' ? [0, 0.005, 0.28] : [0, -0.025, 0.16];
          const palm = r.root.getObjectByName('mixamorig9LeftHand').localToWorld(new T.Vector3(0, 0.075, 0));
          maxSupportError = Math.max(maxSupportError, palm.distanceTo(gun.localToWorld(new T.Vector3(...grip))));
        }
      }
      input.set('KeyA', true); step(0.4);
      const before = s.combat.shots;
      input.button('left', true); step(0.8);
      input.button('left', false); input.set('KeyA', false);
      const parts = s.combat.arsenal.parts;
      const hand = skin.skeleton.bones.find((b: any) => b.name.endsWith('RightHand'));
      weapons.push({ id, shots: s.combat.shots - before, attached: parts.group.parent === hand, moving: p.speed });
      input.button('right', false); step(0.5);
    }
    input.tap('KeyH'); step(0.5);
    const emoteStarted = r.playEmote('dance-short'); step(3.5);
    const returned = r.emote === null;
    r.playEmote('dance'); input.set('KeyW', true); step(0.2); input.set('KeyW', false);
    const cancelled = r.emote === null;
    step(0.8);
    s.look.pitch = 0;
    s.rig.setSubject(null);
    g.camera.position.set(p.pos.x + 2.5, p.y + 1.4, p.pos.z + 3);
    g.camera.lookAt(p.pos.x, p.y + 0.9, p.pos.z); g.camera.fov = 40; g.camera.updateProjectionMatrix();
    return { initial, bad, walk, run, weapons, emoteStarted, returned, cancelled, maxSupportError, minAimAlignment };
  });
  console.log(JSON.stringify(result));
  await page.screenshot({ path: 'test-results/player-integration.png' });
  expect(result.initial.bones).toBe(24);
  expect(result.initial.height).toBeGreaterThan(1.65);
  expect(result.initial.height).toBeLessThan(1.95);
  expect(Math.abs(result.initial.floor)).toBeLessThan(0.1);
  expect(result.bad).toEqual([]);
  expect(result.maxSupportError).toBeLessThan(0.035);
  expect(result.minAimAlignment).toBeGreaterThan(0.98);
  expect(result.walk).toBeGreaterThan(3.5);
  expect(result.run).toBeGreaterThan(7);
  for (const weapon of result.weapons) {
    expect(weapon.attached).toBe(true);
    expect(weapon.shots).toBe(weapon.id === 'mg' ? weapon.shots : 1);
    if (weapon.id === 'mg') expect(weapon.shots).toBeGreaterThan(3);
  }
  expect(result.emoteStarted && result.returned && result.cancelled).toBe(true);
  expect(errors).toEqual([]);
});
