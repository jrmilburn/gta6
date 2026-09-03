// Canvas 2D minimap (plan section 9). 220x220, 25 m per 22 px, rotated so the
// player heading is always "up". Pure canvas, no DOM text here.
// DECISION: only straight road segments (`city.roads.segmentLanes`) are drawn,
// not the intersection turn connectors -- at this scale (220 px) the curves
// are indistinguishable from the straight lines they join, and skipping them
// cuts the per-frame line count roughly 4x on a 12x12 grid (~5k lanes total).
import type { AABB, Vec2 } from '../types';
import { BOARDWALK, PIER, type CityLayout } from '../world/cityGen';

const SIZE = 220;
const CENTER = SIZE / 2;
const PX_PER_M = 22 / 25;
const VIEW_RADIUS_M = (CENTER / PX_PER_M) * 1.05; // a hair past the disc edge
const CULL_RADIUS_M = VIEW_RADIUS_M + 40; // margin so lines don't pop at the edge

export interface MinimapDots {
  police?: readonly Vec2[];
  missions?: readonly Vec2[];
  checkpoint?: Vec2 | null;
}

export interface MinimapApi {
  canvas: HTMLCanvasElement;
  render(playerPos: Vec2, heading: number, dots: MinimapDots): void;
}

interface Seg { x1: number; z1: number; x2: number; z2: number }

function nearAabb(b: AABB, px: number, pz: number, r: number): boolean {
  return b.maxX >= px - r && b.minX <= px + r && b.maxZ >= pz - r && b.minZ <= pz + r;
}

export function createMinimap(city: CityLayout): MinimapApi {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  canvas.style.cssText = `width:${SIZE}px; height:${SIZE}px; border-radius:50%; display:block;
    box-shadow: 0 2px 10px rgba(0,0,0,0.5); border: 2px solid rgba(255,255,255,0.55);`;
  const maybeCtx = canvas.getContext('2d');
  if (!maybeCtx) throw new Error('2d context unavailable');
  // Explicit non-nullable annotation: narrowing the union above doesn't carry
  // into the nested `render` closure below, so without this every ctx.* call
  // in there is flagged "possibly null" even though it can't be.
  const ctx: CanvasRenderingContext2D = maybeCtx;

  // Precompute once: straight-segment road lines and building footprints.
  const segs: Seg[] = [];
  for (const id of city.roads.segmentLanes) {
    const lane = city.roads.lanes[id];
    const pts = lane.points;
    for (let i = 1; i < pts.length; i++) {
      segs.push({ x1: pts[i - 1].x, z1: pts[i - 1].z, x2: pts[i].x, z2: pts[i].z });
    }
  }
  const buildings: AABB[] = [];
  for (const b of city.blocks) for (const bld of b.buildings) buildings.push(bld.bounds);
  // Timber: the boardwalk and the pier, so the pier reads as somewhere to go.
  const decks: AABB[] = [BOARDWALK, PIER];

  function render(playerPos: Vec2, heading: number, dots: MinimapDots): void {
    const cos = Math.cos(-heading);
    const sin = Math.sin(-heading);
    // Rotate the world so the player's forward direction maps to canvas "up".
    const project = (wx: number, wz: number): [number, number] => {
      const dx = wx - playerPos.x, dz = wz - playerPos.z;
      const rx = dx * cos - dz * sin;
      const rz = dx * sin + dz * cos;
      return [CENTER + rx * PX_PER_M, CENTER - rz * PX_PER_M];
    };

    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, CENTER - 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(10,14,24,0.62)';
    ctx.fillRect(0, 0, SIZE, SIZE);

    // Decks: a warm timber tint under everything else.
    ctx.fillStyle = 'rgba(196,150,96,0.55)';
    for (const b of decks) {
      if (!nearAabb(b, playerPos.x, playerPos.z, CULL_RADIUS_M)) continue;
      const [x1, y1] = project(b.minX, b.minZ);
      const [x2, y2] = project(b.maxX, b.minZ);
      const [x3, y3] = project(b.maxX, b.maxZ);
      const [x4, y4] = project(b.minX, b.maxZ);
      ctx.beginPath();
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.lineTo(x4, y4);
      ctx.closePath();
      ctx.fill();
    }

    // Buildings: darker translucent blocks.
    ctx.fillStyle = 'rgba(20,24,36,0.85)';
    for (const b of buildings) {
      if (!nearAabb(b, playerPos.x, playerPos.z, CULL_RADIUS_M)) continue;
      const [x1, y1] = project(b.minX, b.minZ);
      const [x2, y2] = project(b.maxX, b.minZ);
      const [x3, y3] = project(b.maxX, b.maxZ);
      const [x4, y4] = project(b.minX, b.maxZ);
      ctx.beginPath();
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.lineTo(x4, y4);
      ctx.closePath();
      ctx.fill();
    }

    // Roads: light grey lines.
    ctx.strokeStyle = 'rgba(214,220,232,0.85)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    const rr2 = CULL_RADIUS_M * CULL_RADIUS_M;
    for (const s of segs) {
      const ddx = s.x1 - playerPos.x, ddz = s.z1 - playerPos.z;
      if (ddx * ddx + ddz * ddz > rr2) continue;
      const [ax, ay] = project(s.x1, s.z1);
      const [bx, by] = project(s.x2, s.z2);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();

    // Mission markers: yellow dots.
    if (dots.missions) {
      ctx.fillStyle = '#ffe14d';
      for (const m of dots.missions) drawDot(ctx, project(m.x, m.z), 4);
    }
    // Police: blue dots.
    if (dots.police) {
      ctx.fillStyle = '#4fa9ff';
      for (const p of dots.police) drawDot(ctx, project(p.x, p.z), 4);
    }
    // Active checkpoint: cyan dot, or a bearing tick at the disc edge if off-map.
    if (dots.checkpoint) {
      const [cx, cy] = project(dots.checkpoint.x, dots.checkpoint.z);
      const dx = cx - CENTER, dy = cy - CENTER;
      const dist = Math.hypot(dx, dy);
      const maxR = CENTER - 6;
      ctx.fillStyle = '#41f0e0';
      if (dist <= maxR) {
        drawDot(ctx, [cx, cy], 5);
      } else {
        const ex = CENTER + (dx / dist) * maxR;
        const ey = CENTER + (dy / dist) * maxR;
        drawDot(ctx, [ex, ey], 5);
      }
    }

    ctx.restore();

    // Player arrow: fixed at centre, always pointing up.
    ctx.save();
    ctx.translate(CENTER, CENTER);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-6, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Disc rim.
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, CENTER - 1, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  return { canvas, render };
}

function drawDot(ctx: CanvasRenderingContext2D, [x, y]: [number, number], r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}
