import { test } from '@playwright/test';
async function probe(page: any, url: string, dismiss: boolean) {
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__game?.ready === true, null, { timeout: 60000 });
  if (dismiss) await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousedown')));
  const out: string[] = [];
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(1500);
    out.push(await page.evaluate(() => {
      const g = (window as any).__game;
      const G = g.game;
      const veg = G.scene.getObjectByName('vegetation');
      let vi = 0, vt = 0;
      if (veg) for (const c of veg.children) { vi += c.count || 0; vt += (c.count||0) * (c.geometry.index ? c.geometry.index.count/3 : 0); }
      return `${g.fps.toFixed(1)}fps ${g.sceneCalls}sc ${(g.tris/1000).toFixed(0)}kTri veg=${vi}i/${(vt/1000).toFixed(0)}kTri`;
    }));
  }
  console.log(`PROBE ${url} dismiss=${dismiss}: ${out.join(' ')}`);
}
test('fps probe', async ({ page }) => {
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
  for (const d of ['e', 'vgbc']) await probe(page, `/?post=0&dbg=${d}`, false);
});
