// The supplied props: Joe's palm, streetlight and traffic light.
//
// Two things are checked, and the second is the one that matters. That the
// models loaded at all -- otherwise the game is quietly on its procedural
// fallbacks and every screenshot below is of the wrong thing. And that they
// FACE THE RIGHT WAY relative to the road: a lamp arm that reaches over the
// pavement instead of the carriageway, or a signal whose lenses look at the
// building behind it, is a placement bug the eye reads instantly and a
// bounding box never will. So the arm's reach and the lens normal are
// computed from the placement yaw and tested against the road geometry.
//
// Screenshots land in screens/props/ for the human check that follows.
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('screens', 'props');
type V3 = [number, number, number];

interface Spot { pos: { x: number; z: number }; rot: number }
interface SignalSpotT extends Spot { node: number; axis: 'x' | 'z' }

declare global {
  interface Window {
    __session: {
      city: {
        props: { streetlights: Spot[]; trafficLights: SignalSpotT[]; palms: Spot[] };
        roads: { nodes: Array<{ id: number; pos: { x: number; z: number } }> };
        blocks: Array<{ zone: string; bounds: { minX: number; maxX: number; minZ: number; maxZ: number } }>;
      };
      props: { supplied: { streetlight: boolean; trafficLight: boolean }; lampReach: number };
    };
  }
}

async function ready(page: Page, query = ''): Promise<void> {
  await page.goto(`/?nohud=1&intro=0&peds=0&traffic=0${query}`);
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => typeof window.__shots !== 'undefined', null, { timeout: 60_000 });
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousedown')));
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.__shots.detach());
}

async function shoot(page: Page, name: string, eye: V3, target: V3, fov = 45): Promise<void> {
  await page.evaluate(([e, t, f]) => window.__shots.look(e as V3, t as V3, f as number), [eye, target, fov] as const);
  await page.waitForTimeout(600);
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`screenshot: ${file}`);
}

/** Yaw `rot` applied to local +Z: where a prop's business end points. */
const forward = (rot: number): { x: number; z: number } => ({ x: Math.sin(rot), z: Math.cos(rot) });

test('supplied props load and face the road', async ({ page }) => {
  await ready(page);

  const info = await page.evaluate(() => {
    const s = window.__session;
    const p = s.city.props;
    return {
      supplied: s.props.supplied,
      lampReach: s.props.lampReach,
      streetlights: p.streetlights,
      trafficLights: p.trafficLights,
      palms: p.palms.length,
      nodes: s.city.roads.nodes,
      blocks: s.city.blocks,
    };
  });
  expect(info.supplied.streetlight, 'streetlight.glb loaded').toBe(true);
  expect(info.supplied.trafficLight, 'traffic-light.glb loaded').toBe(true);
  expect(info.lampReach).toBeGreaterThan(1.2);

  // Distance from a point to the nearest road centreline. Roads run along the
  // node grid, so it is the distance to the nearest grid line on either axis.
  const xs = [...new Set(info.nodes.map((n) => n.pos.x))];
  const zs = [...new Set(info.nodes.map((n) => n.pos.z))];
  const toRoad = (x: number, z: number): number =>
    Math.min(...xs.map((gx) => Math.abs(x - gx)), ...zs.map((gz) => Math.abs(z - gz)));

  // Streetlights: the head must be nearer the carriageway than the pole.
  let checked = 0, wrong = 0;
  for (let i = 0; i < info.streetlights.length; i += 7) {
    const s = info.streetlights[i];
    const f = forward(s.rot);
    const head = { x: s.pos.x + f.x * info.lampReach, z: s.pos.z + f.z * info.lampReach };
    checked++;
    if (toRoad(head.x, head.z) >= toRoad(s.pos.x, s.pos.z)) wrong++;
  }
  console.log(`streetlights: ${checked} checked, ${wrong} reaching away from the road`);
  expect(checked).toBeGreaterThan(20);
  expect(wrong).toBe(0);

  // Traffic lights: the lens normal must point back along the approach it
  // controls, i.e. at the cars coming toward the intersection node.
  let facingWrong = 0;
  for (const t of info.trafficLights) {
    const node = info.nodes[t.node];
    expect(node, `node ${t.node} exists`).toBeTruthy();
    // Cars arrive along `axis`, from the side of the node the signal is on.
    const dx = t.pos.x - node.pos.x, dz = t.pos.z - node.pos.z;
    const arriveFrom = t.axis === 'x' ? { x: Math.sign(dx), z: 0 } : { x: 0, z: Math.sign(dz) };
    const f = forward(t.rot);
    const dot = f.x * arriveFrom.x + f.z * arriveFrom.z;
    if (dot < 0.7) facingWrong++;
    // And it stands beside that approach lane, within a road's width of the node.
    expect(Math.hypot(dx, dz)).toBeLessThan(16);
  }
  console.log(`traffic lights: ${info.trafficLights.length} checked, ${facingWrong} facing the wrong way`);
  expect(facingWrong).toBe(0);
  expect(info.palms).toBeGreaterThan(100);

  // --- pictures ---------------------------------------------------------------
  const dt = info.blocks.find((b) => b.zone === 'downtown')!;
  // The intersection at this block's (minX, minZ) corner, from 22 m up.
  const ix = dt.bounds.minX - 6, iz = dt.bounds.minZ - 6;
  await shoot(page, 'intersection-top', [ix + 0.01, 26, iz], [ix, 0, iz], 60);
  await shoot(page, 'intersection-street', [ix - 14, 1.7, iz + 18], [ix + 6, 3.5, iz - 4], 50);

  // One signal close up, from the road it controls.
  const t = info.trafficLights.find((s) => Math.hypot(s.pos.x - ix, s.pos.z - iz) < 16)!;
  const f = forward(t.rot);
  await shoot(page, 'traffic-light', [t.pos.x + f.x * 5, 2.4, t.pos.z + f.z * 5], [t.pos.x, 3.0, t.pos.z], 40);

  const l = info.streetlights.find((s) => Math.hypot(s.pos.x - ix, s.pos.z - iz) < 40)!;
  const lf = forward(l.rot);
  const side = { x: lf.z, z: -lf.x };
  await shoot(page, 'streetlight', [l.pos.x + side.x * 9 + lf.x * 2, 3, l.pos.z + side.z * 9 + lf.z * 2], [l.pos.x + lf.x * 1.2, 4.5, l.pos.z + lf.z * 1.2], 45);

  const beach = info.blocks.find((b) => b.zone === 'beach')!;
  const bx = (beach.bounds.minX + beach.bounds.maxX) / 2, bz = beach.bounds.minZ - 6;
  await shoot(page, 'boulevard', [bx - 30, 2.2, bz + 1], [bx + 40, 8, bz - 4], 55);

  const palm = await page.evaluate(() => window.__shots.spot('palm'));
  if (palm) await shoot(page, 'palm', [palm.x + 5, 3.4, palm.z + 5], [palm.x, 4.2, palm.z], 58);
});

test('dusk: lamps lit', async ({ page }) => {
  await ready(page, '&time=dusk');
  const info = await page.evaluate(() => {
    const s = window.__session;
    return { lights: s.city.props.streetlights, blocks: s.city.blocks };
  });
  const dt = info.blocks.find((b) => b.zone === 'downtown')!;
  const ix = dt.bounds.minX - 6, iz = dt.bounds.minZ - 6;
  const l = info.lights.find((s) => Math.hypot(s.pos.x - ix, s.pos.z - iz) < 40)!;
  const f = forward(l.rot);
  await shoot(page, 'streetlight-dusk', [l.pos.x + f.z * 9 + f.x * 2, 3, l.pos.z - f.x * 9 + f.z * 2], [l.pos.x + f.x * 1.2, 4.5, l.pos.z + f.z * 1.2], 45);
  await shoot(page, 'intersection-dusk', [ix - 14, 1.7, iz + 18], [ix + 6, 3.5, iz - 4], 50);
});
