import { test, expect } from '@playwright/test';
test.use({ viewport: { width: 800, height: 700 } });

test('player weapon grip and aim visual review', async ({ page }) => {
  await page.goto('/?peds=0&traffic=0&intro=0&post=0&hud=0');
  await page.waitForFunction(() => (window as any).__game?.ready, null, { timeout: 90000 });
  await page.keyboard.press('Enter');
  await page.getByText('SUNBELT CITY', { exact: true }).waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    const w = window as any, g = w.__game.game;
    g.paused = true; w.__input.lock(true);
    w.__reviewRenderables = g.renderables;
    w.__reviewStep = (seconds: number) => {
      for (let n = 0; n < seconds * 60; n++) {
        g.step(1 / 60);
        for (const r of w.__reviewRenderables) r.renderSync(1, 1 / 60);
        g.scene.updateMatrixWorld(true);
      }
    };
    w.__input.tap('KeyH'); w.__reviewStep(1);
    g.renderables = [];
  });
  for (const [key, id] of [['Digit1', 'pistol'], ['Digit2', 'mg'], ['Digit3', 'sniper'], ['Digit4', 'rpg']]) {
    if (process.env.REVIEW_WEAPON && id !== process.env.REVIEW_WEAPON) continue;
    for (const aimed of [false, true]) {
      const stats = await page.evaluate(({ key, aimed }) => {
        const w = window as any, s = w.__session, g = w.__game.game, T = w.__game.THREE;
        w.__input.tap(key); w.__input.button('right', aimed);
        s.look.pitch = 0; s.look.yaw = s.player.heading;
        s.rig.setSubject(s.player);
        w.__reviewStep(1);
        const gun = s.combat.arsenal.parts.group;
        const ray = g.camera.getWorldDirection(new T.Vector3());
        const barrel = new T.Vector3(0, 0, 1).applyQuaternion(gun.getWorldQuaternion(new T.Quaternion()));
        const lh = s.heroRig.root.getObjectByName('mixamorig9LeftHand');
        const grip = s.combat.weapon === 'mg' ? [0, 0.005, 0.18] : s.combat.weapon === 'sniper' ? [0, 0.005, 0.28] : [0, -0.025, 0.16];
        const target = gun.localToWorld(new T.Vector3(...grip));
        const supportError = lh.localToWorld(new T.Vector3(0, 0.075, 0)).distanceTo(target);
        const shoulder = s.heroRig.root.getObjectByName('mixamorig9LeftArm').getWorldPosition(new T.Vector3());
        return { alignment: ray.dot(barrel), supportError, visible: gun.visible, reach: shoulder.distanceTo(target),
          shoulder: shoulder.toArray(), hand: lh.getWorldPosition(new T.Vector3()).toArray(), target: target.toArray() };
      }, { key, aimed });
      console.log(id, aimed ? 'aim' : 'hold', stats);
      expect(stats.visible).toBe(true);
      if (aimed) expect(stats.alignment).toBeGreaterThan(0.98);
      for (const [view, angle] of [['front', 0.6], ['side', 1.57]] as const) {
        await page.evaluate(angle => {
          const w = window as any, p = w.__session.player, cam = w.__game.game.camera;
          const az = p.heading + angle;
          cam.position.set(p.pos.x + Math.sin(az) * 3, p.y + 1.5, p.pos.z + Math.cos(az) * 3);
          cam.lookAt(p.pos.x, p.y + 1, p.pos.z); cam.fov = 40; cam.updateProjectionMatrix();
        }, angle);
        await page.screenshot({ path: `test-results/player-${id}-${aimed ? 'aim' : 'hold'}-${view}.png` });
      }
      if (id !== 'pistol') expect(stats.supportError).toBeLessThan(0.02);
    }
  }
});
