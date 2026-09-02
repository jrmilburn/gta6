// Damage smoke: a 20-point sprite cloud rising off the bonnet (plan section 4).
// The texture is drawn to a canvas at boot like every other texture in the game.
import * as THREE from 'three';

const MAX = 20;

let sprite: THREE.CanvasTexture | null = null;
function puffTexture(): THREE.CanvasTexture {
  if (sprite) return sprite;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(32, 32, 30, 0, Math.PI * 2);
  ctx.fill();
  sprite = new THREE.CanvasTexture(c);
  return sprite;
}

interface Puff { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number }

/** A small pool of rising puffs. Dead puffs park below the world. */
export class VehicleSmoke {
  readonly points: THREE.Points;
  private readonly mat: THREE.PointsMaterial;
  private readonly geo: THREE.BufferGeometry;
  private readonly pos: Float32Array;
  private readonly puffs: Puff[] = [];
  private cursor = 0;
  private clock = 0;

  constructor(scene: THREE.Scene) {
    this.pos = new Float32Array(MAX * 3);
    for (let i = 0; i < MAX; i++) {
      this.pos[i * 3 + 1] = -1000;
      this.puffs.push({ x: 0, y: -1000, z: 0, vx: 0, vy: 0, vz: 0, life: 0 });
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.mat = new THREE.PointsMaterial({
      map: puffTexture(), color: 0x8a8a8a, size: 2.2, sizeAttenuation: true,
      transparent: true, opacity: 0.55, depthWrite: false, fog: true,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    scene.add(this.points);
  }

  /** `rate` is puffs per second (0 = off). `dark` switches to wrecked-black. */
  update(dt: number, rate: number, x: number, y: number, z: number, dark: boolean): void {
    this.mat.color.setHex(dark ? 0x232326 : 0x9a9a97);
    this.mat.opacity = dark ? 0.72 : 0.5;

    if (rate > 0) {
      this.clock += dt * rate;
      while (this.clock >= 1) {
        this.clock -= 1;
        const p = this.puffs[this.cursor];
        this.cursor = (this.cursor + 1) % MAX;
        p.x = x + (Math.random() - 0.5) * 0.5;
        p.y = y;
        p.z = z + (Math.random() - 0.5) * 0.5;
        p.vx = (Math.random() - 0.5) * 0.8;
        p.vy = 1.4 + Math.random() * 0.9;
        p.vz = (Math.random() - 0.5) * 0.8;
        p.life = 1;
      }
    } else {
      this.clock = 0;
    }

    for (let i = 0; i < MAX; i++) {
      const p = this.puffs[i];
      if (p.life <= 0) continue;
      p.life -= dt * 0.55;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.vy *= 1 - dt * 0.6;
      if (p.life <= 0) { p.y = -1000; }
      this.pos[i * 3] = p.x;
      this.pos[i * 3 + 1] = p.y;
      this.pos[i * 3 + 2] = p.z;
    }
    this.geo.attributes.position.needsUpdate = true;
  }

  dispose(): void {
    this.points.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}
