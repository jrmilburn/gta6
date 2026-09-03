// `G` dances (integration pass, section 4).
//
// Eight seconds of the supplied dance clip, with the camera making exactly one
// slow circuit, a synthesised kick-and-hat under it, and any pedestrian close
// enough joining in a beat or so later. It is the shot the whole character
// integration exists to make, so it owns its own file rather than being three
// scattered conditions in session.ts.
//
// Anything that looks like the player wanting control back cancels it: a
// movement key, a jump, or E. G again restarts from the top.
import type { CameraModeName, CameraRig } from '../camera/cameras';
import { ORBIT } from '../camera/orbitCamera';
import { CFG } from '../config';
import type { EventName, System, Vec2 } from '../types';
import type { CharacterRig } from './characterRig';

const A = CFG.anim;
const DURATION = CFG.feel.danceSeconds;

type DanceAction = 'forward' | 'back' | 'left' | 'right' | 'handbrake' | 'interact' | 'dance';

export interface DanceHost {
  input: {
    isDown(a: DanceAction): boolean;
    justPressed(a: DanceAction): boolean;
  };
  events: { emit(evt: EventName, payload?: unknown): void };
  audio: { startBeat(bpm: number, gain: number): void; stopBeat(): void };
}

export interface DanceDeps {
  /** The player's skinned rig, or null when running on the procedural humanoid. */
  rig: () => CharacterRig | null;
  /** Where the player is, and whether they are in a state that permits dancing. */
  player: { pos: Vec2; onFoot: boolean; onGround: boolean };
  /** Non-null while driving; dancing is on foot only. */
  inVehicle: () => boolean;
  /** True while a full-screen state (wrecked / busted / passed) owns the frame. */
  blocked: () => boolean;
  cameraRig: CameraRig;
  /** Crowd hook: pedestrians within `radius` of `centre` join in. */
  crowd: (centre: Vec2 | null, radius: number) => void;
  toast: (text: string, seconds: number) => void;
}

export class DanceSystem implements System {
  /** Seconds elapsed into the current dance; 0 when not dancing. */
  elapsed = 0;
  active = false;

  private previousMode: CameraModeName = 'chase';

  constructor(private readonly host: DanceHost, private readonly deps: DanceDeps) {}

  update(dt: number): void {
    if (this.host.input.justPressed('dance')) {
      // Restart rather than toggle: pressing G mid-dance is a request for
      // another eight seconds from the top, not a request to stop.
      if (this.canStart()) this.start();
      return;
    }
    if (!this.active) return;

    this.elapsed += dt;
    // One full revolution over the whole dance, driven from here so the camera
    // and the clip cannot drift apart.
    ORBIT.angle = (this.elapsed / DURATION) * Math.PI * 2;
    this.deps.crowd(this.deps.player.pos, A.danceJoinRadius);

    if (this.elapsed >= DURATION || this.cancelled()) this.stop();
  }

  private canStart(): boolean {
    const rig = this.deps.rig();
    if (!rig || !rig.canDance) return false;
    const p = this.deps.player;
    return p.onFoot && p.onGround && !this.deps.inVehicle() && !this.deps.blocked();
  }

  /** Any bid for control ends it early. */
  private cancelled(): boolean {
    const i = this.host.input;
    return i.isDown('forward') || i.isDown('back') || i.isDown('left') || i.isDown('right')
      || i.isDown('handbrake') || i.justPressed('interact');
  }

  private start(): void {
    const rig = this.deps.rig();
    if (!rig) return;
    if (!this.active) this.previousMode = this.deps.cameraRig.mode;
    this.active = true;
    this.elapsed = 0;
    ORBIT.angle = 0;
    rig.startDance();
    this.deps.cameraRig.blendToSubject(this.deps.cameraRig.subject, 'orbit');
    this.host.audio.startBeat(A.danceBpm, A.danceGain);
    this.deps.toast('Dance!', 1);
    this.host.events.emit('danceStart', { pos: { ...this.deps.player.pos } });
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.elapsed = 0;
    this.deps.rig()?.stopDance();
    this.deps.crowd(null, 0);
    this.host.audio.stopBeat();
    this.deps.cameraRig.blendToSubject(this.deps.cameraRig.subject, this.previousMode);
    this.host.events.emit('danceEnd');
  }
}
