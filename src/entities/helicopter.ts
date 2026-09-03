// The five-star helicopter (section 9). It never lands and never attacks: it
// hovers at 35 m, orbits the player at 25 m, and keeps a spotlight on them.
// It exists to look great on camera, and to make five stars feel like five.
//
// Procedural: a fuselage, a tail boom, a four-blade rotor at 20 rad/s and a
// tail rotor. One SpotLight, the only dynamic light in the game, and the
// rotor's whump is a pulsed noise in audio.ts.
import * as THREE from 'three';
import type { Vec2 } from '../types';
import { boxAt, cylAt, mergeGeos } from '../world/geomUtil';

const ALTITUDE = 35;
const ORBIT_RADIUS = 25;
/** Radians per second round the player. */
const ORBIT_RATE = 0.22;
const ROTOR_RATE = 20;
/** How quickly it closes on its orbit position, per second. */
const CHASE = 1.2;

export class Helicopter {
  readonly group = new THREE.Group();
  readonly light: THREE.SpotLight;
  active = false;

  private readonly rotor: THREE.Mesh;
  private readonly tailRotor: THREE.Mesh;
  private readonly target = new THREE.Object3D();
  private angle = 0;
  private readonly pos = new THREE.Vector3(0, ALTITUDE, 0);
  private heading = 0;

  constructor() {
    const dark = new THREE.MeshStandardMaterial({ color: 0x1c2733, roughness: 0.6, metalness: 0.3 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf3f3f0, roughness: 0.5, metalness: 0.2 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x2c3e50, roughness: 0.2, metalness: 0.6 });

    const body = new THREE.Mesh(mergeGeos([
      boxAt(2.2, 1.6, 4.2, 0, 0, 0.6),
      boxAt(1.4, 0.9, 1.3, 0, -0.1, 3.1),
    ]), white);
    const belly = new THREE.Mesh(boxAt(2.4, 0.5, 4.4, 0, -0.95, 0.6), dark);
    const canopy = new THREE.Mesh(boxAt(1.9, 0.9, 1.6, 0, 0.3, 2.4), glass);
    const boom = new THREE.Mesh(boxAt(0.5, 0.5, 5.5, 0, 0.3, -3.6), white);
    const fin = new THREE.Mesh(boxAt(0.1, 1.4, 1.1, 0, 0.9, -6.2), dark);
    const skids = new THREE.Mesh(mergeGeos([
      cylAt(0.06, 0.06, 4, 6, -0.9, -1.5, 0.4).rotateX(Math.PI / 2).translate(-0.9, -1.5, 0.4),
      cylAt(0.06, 0.06, 4, 6, 0.9, -1.5, 0.4).rotateX(Math.PI / 2).translate(0.9, -1.5, 0.4),
    ]), dark);
    // cylAt builds along Y; the rotateX turns it along Z, then it is re-placed.
    skids.geometry.computeBoundingBox();
    const mast = new THREE.Mesh(cylAt(0.12, 0.12, 0.6, 8, 0, 1.05, 0.4), dark);
    this.rotor = new THREE.Mesh(mergeGeos([
      boxAt(11, 0.06, 0.34, 0, 0, 0),
      boxAt(0.34, 0.06, 11, 0, 0, 0),
    ]), dark);
    this.rotor.position.set(0, 1.35, 0.4);
    this.tailRotor = new THREE.Mesh(boxAt(0.06, 1.7, 0.2, 0, 0, 0), dark);
    this.tailRotor.position.set(0.32, 0.9, -6.2);

    this.group.add(body, belly, canopy, boom, fin, skids, mast, this.rotor, this.tailRotor);
    this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.castShadow = true; });

    this.light = new THREE.SpotLight(0xfff1d0, 40, 120, 0.25, 0.5, 1.2);
    this.light.position.set(0, -0.9, 1.4);
    this.light.castShadow = false;
    this.group.add(this.light);
    this.group.add(this.target);
    this.light.target = this.target;

    this.group.visible = false;
  }

  /** Bring it in from over the sea, well away from the player. */
  arrive(near: Vec2): void {
    this.active = true;
    this.group.visible = true;
    this.angle = Math.random() * Math.PI * 2;
    this.pos.set(near.x + Math.cos(this.angle) * 220, ALTITUDE + 20, near.z + Math.sin(this.angle) * 220);
  }

  leave(): void {
    this.active = false;
    this.group.visible = false;
  }

  get position(): Vec2 { return { x: this.pos.x, z: this.pos.z }; }

  update(dt: number, player: Vec2, playerY: number): void {
    if (!this.active) return;
    this.angle += ORBIT_RATE * dt;
    const want = new THREE.Vector3(
      player.x + Math.cos(this.angle) * ORBIT_RADIUS, ALTITUDE, player.z + Math.sin(this.angle) * ORBIT_RADIUS,
    );
    this.pos.lerp(want, Math.min(1, CHASE * dt));
    // Nose along the orbit, banked a little into the turn.
    const tx = -Math.sin(this.angle), tz = Math.cos(this.angle);
    const wantHeading = Math.atan2(tx, tz);
    let d = wantHeading - this.heading;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.heading += d * Math.min(1, dt * 2);
    this.group.position.copy(this.pos);
    this.group.rotation.set(0.08, this.heading, -0.18);
    this.rotor.rotation.y += ROTOR_RATE * dt;
    this.tailRotor.rotation.x += ROTOR_RATE * 3 * dt;
    // The spotlight follows the player; the target is a child of the group so
    // it is set in the group's own space.
    this.target.position.copy(this.group.worldToLocal(new THREE.Vector3(player.x, playerY + 0.5, player.z)));
  }
}
