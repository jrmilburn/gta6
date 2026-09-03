import { chromium } from '@playwright/test';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 480, height: 270 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.goto('http://localhost:4173/?peds=60&traffic=20&post=0&shadows=0');
await p.waitForFunction(() => window.__game?.ready === true, null, {timeout: 90000});
await p.keyboard.press('Enter');
const r = await p.evaluate(async () => {
  const w = window, g = w.__game, s = w.__session;
  const wait = async (secs) => { const e = g.game.time + secs; while (g.game.time < e) await new Promise(r=>setTimeout(r,16)); };
  const boxes = s.city.colliders;
  const inside = (x, z) => boxes.some(b => x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ);
  await wait(2);
  // 1. Nobody inside a building, sampled over time while traffic scares them.
  let worstInside = 0, samples = 0;
  const jumps = [];
  const px = () => s.player.pos;
  let prev = s.peds.list().map(q => ({ x: q.x, z: q.z, mode: q.mode, dp: Math.hypot(q.x - px().x, q.z - px().z) }));
  for (let i = 0; i < 60; i++) {
    await wait(0.5);
    const now = s.peds.list();
    worstInside = Math.max(worstInside, now.filter(q => inside(q.x, q.z)).length);
    for (let k = 0; k < now.length; k++) {
      const d = Math.hypot(now[k].x - prev[k].x, now[k].z - prev[k].z);
      if (d > 4) jumps.push({ d: +d.toFixed(1), from: prev[k].mode, to: now[k].mode, wasFarM: +prev[k].dp.toFixed(0) });
    }
    prev = now.map(q => ({ x: q.x, z: q.z, mode: q.mode, dp: Math.hypot(q.x - px().x, q.z - px().z) }));
    samples++;
  }
  jumps.sort((a, b) => b.d - a.d);
  const nearJumps = jumps.filter(j => j.wasFarM < 250);
  // 2. How close the nearest palm comes to the walking line.
  const props = s.city.props;
  let minGap = 1e9;
  for (const palm of props.palms.slice(0, 400)) {
    for (const q of s.peds.list()) {
      minGap = Math.min(minGap, Math.hypot(palm.pos.x - q.x, palm.pos.z - q.z));
    }
  }
  return {
    worstInside, samples, palms: props.palms.length, closestPalmToAnyPed: +minGap.toFixed(2),
    totalJumps: jumps.length, biggest: jumps.slice(0, 6),
    jumpsWhileNearby: nearJumps.length, biggestNearby: nearJumps.slice(0, 6),
  };
});
console.log(JSON.stringify(r), 'errs', errs.slice(0,3));
await b.close();
