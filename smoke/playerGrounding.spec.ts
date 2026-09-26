import { test, expect } from '@playwright/test';

test('forward movement cannot accumulate visual grounding height between rendered frames', async ({ page }) => {
  await page.goto('/?peds=0&traffic=0&intro=0&post=0&shadows=0');
  await page.waitForFunction(() => (window as any).__game?.ready, null, { timeout: 90000 });
  await page.keyboard.press('Enter');
  await page.getByText('SUNBELT CITY', { exact: true }).waitFor({ state: 'hidden' });
  const result = await page.evaluate(() => {
    const w = window as any, g = w.__game.game, p = w.__session.player, r = w.__session.heroRig;
    g.paused = true; w.__input.lock(true);
    p.setColliders([]); p.setVehicles([]);
    for (let frame = 0; frame < 60; frame++) g.step(1 / 60);
    let maxLift = 0, minFloor = Infinity, maxFloor = -Infinity, maxPhysicsRise = 0;
    const startY = p.y;
    w.__input.set('KeyW', true);
    for (let frame = 0; frame < 600; frame++) {
      if (frame === 180) w.__input.set('ShiftLeft', true);
      if (frame === 360) { w.__input.set('ShiftLeft', false); w.__input.set('KeyW', false); }
      g.step(1 / 60);
      for (const item of g.renderables) item.renderSync(1, 1 / 60);
      // WebGLRenderer performs this update each rendered frame. It refreshes
      // SkinnedMesh.bindMatrixInverse, unlike Object3D.updateWorldMatrix.
      g.scene.updateMatrixWorld(true);
      maxLift = Math.max(maxLift, r.root.position.y);
      maxPhysicsRise = Math.max(maxPhysicsRise, p.y - startY);
      if (frame % 30 === 0) r.root.traverse((mesh: any) => {
        if (!mesh.isSkinnedMesh) return;
        mesh.computeBoundingBox();
        const floor = mesh.boundingBox.clone().applyMatrix4(mesh.matrixWorld).min.y - p.y;
        minFloor = Math.min(minFloor, floor); maxFloor = Math.max(maxFloor, floor);
      });
    }
    return { maxLift, minFloor, maxFloor, maxPhysicsRise };
  });
  console.log('continuous grounding', result);
  expect(result.maxLift).toBeLessThan(0.2);
  expect(result.minFloor).toBeGreaterThan(-0.025);
  expect(result.maxFloor).toBeLessThan(0.3);
  expect(result.maxPhysicsRise).toBeLessThan(0.2);
});
