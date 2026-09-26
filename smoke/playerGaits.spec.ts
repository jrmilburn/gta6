import { test, expect } from '@playwright/test';
test.use({ viewport: { width: 800, height: 700 } });

test('player gait contact and transition visual review', async ({ page }) => {
  await page.goto('/?peds=0&traffic=0&intro=0&post=0');
  await page.waitForFunction(() => (window as any).__game?.ready, null, { timeout: 90000 });
  await page.keyboard.press('Enter');
  await page.getByText('SUNBELT CITY', { exact: true }).waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    const w = window as any, g = w.__game.game;
    g.paused = true; g.renderables = [];
    const p = w.__session.player, cam = g.camera;
    cam.position.set(p.pos.x + 3, p.y + 1.5, p.pos.z + 1);
    cam.lookAt(p.pos.x, p.y + 0.9, p.pos.z); cam.fov = 40; cam.updateProjectionMatrix();
  });
  for (const [name, speed, angle, armed] of [
    ['idle', 0, 0, false], ['walk', 1.5, 0, false], ['run', 8, 0, false],
    ['strafe', 3.5, Math.PI / 2, true], ['backward', 3.5, Math.PI, true],
    ['diagonal', 3.5, -Math.PI / 4, true],
    ['diagonal-right', 3.5, Math.PI / 4, true],
    ['back-diagonal-left', 3.5, -3 * Math.PI / 4, true],
    ['back-diagonal-right', 3.5, 3 * Math.PI / 4, true],
  ] as const) {
    const stats = await page.evaluate(({ speed, angle, armed }) => {
      const w = window as any, r = w.__session.heroRig, T = w.__game.THREE;
      r.locomotion.moveAngle = angle; r.locomotion.armed = armed;
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < 120; i++) {
        r.update({ dt: 1 / 60, time: i / 60, speed, turnRate: 0, grounded: true, airborne: false, crouch: 0, opacity: 1 });
        r.root.updateWorldMatrix(true, true);
        r.root.updateMatrixWorld(true);
        if (i < 60) continue;
        r.root.traverse((mesh: any) => {
          if (!mesh.isSkinnedMesh) return;
          mesh.computeBoundingBox();
          const b = mesh.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
          const floor = b.min.y - r.group.position.y;
          min = Math.min(min, floor); max = Math.max(max, floor);
        });
      }
      const materials: any[] = [];
      r.root.traverse((m: any) => { if (m.isSkinnedMesh) materials.push({ normal: !!m.material.normalMap,
        roughness: !!m.material.roughnessMap, emissive: m.material.emissive.getHex(), anisotropy: m.material.map.anisotropy }); });
      return { min, max, footSpeed: r.footSpeed, materials, debug: r.debug() };
    }, { speed, angle, armed });
    console.log(name, JSON.stringify(stats));
    await page.screenshot({ path: `test-results/player-gait-${name}.png` });
    expect(stats.min).toBeGreaterThan(-0.01);
    expect(stats.max).toBeLessThan(0.3);
    for (const material of stats.materials) {
      expect(material.normal && material.roughness).toBe(true);
      expect(material.emissive).toBe(0);
      expect(material.anisotropy).toBeGreaterThan(1);
    }
  }
});
