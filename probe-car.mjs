import { chromium } from '@playwright/test';
const kind = process.argv[2] ?? 'sports';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('pageerror', String(e)));
await p.goto(`http://localhost:4173/?peds=0&traffic=0&shadows=0&intro=0&nohud=1&car=${kind}`);
await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 90000 });
await p.waitForFunction(() => typeof window.__shots !== 'undefined', null, { timeout: 60000 });
await p.evaluate(() => window.dispatchEvent(new MouseEvent('mousedown')));
await p.waitForTimeout(3000);
await p.evaluate(() => window.__shots.detach());
const car = await p.evaluate(() => {
  const v = window.__session.vehicles[0];
  return { x: v.pos.x, z: v.pos.z, h: v.heading };
});
const shots = [
  ['front-q', 0.7, 6, 1.6],
  ['side', Math.PI / 2, 6, 1.2],
  ['rear-q', Math.PI * 0.8, 6, 1.6],
  ['top', 0.3, 4.5, 5.5],
];
for (const [name, az, dist, h] of shots) {
  const a = car.h + az;
  await p.evaluate(([x, y, z, tx, ty, tz]) => window.__shots.look([x, y, z], [tx, ty, tz], 40), [car.x + Math.sin(a) * dist, h, car.z + Math.cos(a) * dist, car.x, 0.7, car.z]);
  await p.waitForTimeout(500);
  await p.screenshot({ path: `screens/car/${kind}-${name}.png` });
}
await b.close();
