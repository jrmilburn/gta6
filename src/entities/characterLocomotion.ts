// The locomotion blend: how fast, and which way.
//
// Two axes, kept separate because they answer different questions.
//
// *Speed* is a ladder -- one rung per clip that moves the character forward,
// ordered by the speed it was authored at. A ground speed brackets two rungs;
// both play, each at the playback rate that makes its own stride cover the
// ground actually covered, so the contact point stays planted through the
// handover.
//
// *Direction* is a ring of anchors around the character's own facing: forward
// is the ladder itself, and the diagonals, the strafe and the backward jogs sit
// at their own angles around it. Movement that is not straight ahead blends
// between the two nearest anchors. It only comes into play when the facing and
// the direction of travel disagree -- while the pistol is out and the character
// strafes, and for the moment either side of a sharp turn.
//
// Two more clips stand outside both: the goofy jog (P) stands in for the
// ordinary gait, and every one-sided directional clip is mirrored, so one
// download covers the left diagonal and the right.
import * as THREE from 'three';
import { CFG } from '../config';
import { buildLadder, type CharacterSource, type Rung } from '../core/character';
import { mirrorClip } from './clipMirror';

const A = CFG.anim;

interface Track {
  name: string;
  action: THREE.AnimationAction;
  /** Metres per second the clip covers at timeScale 1. 0 for the idle pose. */
  speed: number;
  weight: number;
}

/** A clip that stands in for the ladder when the character is not going forward. */
interface Directional extends Track {
  /** Movement direction it represents, relative to facing. 0 is straight ahead. */
  angle: number;
  /** True for the pistol clips, which only play while the gun is out. */
  armed: boolean;
}

/**
 * One direction on the ring, and every clip that travels in it ordered by the
 * speed it was authored at. `dir: null` is the speed ladder itself, which is
 * what "straight ahead" means when no armed forward clip is loaded.
 */
interface Anchor {
  angle: number;
  rungs: Array<{ dir: Directional | null; speed: number }>;
}

/** The goofy jog: a whole-gait substitute rather than a direction. */
interface Substitute extends Track {
  replaces: string[];
}

export class Locomotion {
  /** Swap the goofy jog in for the ordinary gait (P). */
  goofy = false;
  /**
   * Direction of travel relative to the character's own facing, radians.
   * 0 is straight ahead, +/-PI is straight back, positive is to the right.
   */
  moveAngle = 0;
  /** True while the pistol is drawn, which selects the aimed clip set. */
  armed = false;

  private readonly tracks: Track[] = [];
  private readonly ladder: Rung[];
  private readonly directions: Directional[] = [];
  private readonly substitutes: Substitute[] = [];

  constructor(mixer: THREE.AnimationMixer, source: CharacterSource, phaseOffset: number) {
    const start = (action: THREE.AnimationAction, clip: THREE.AnimationClip): void => {
      action.play();
      action.enabled = true;
      action.setEffectiveWeight(0);
      action.time = (phaseOffset * clip.duration) % Math.max(clip.duration, 1e-3);
    };

    this.ladder = buildLadder(source.info);
    for (const rung of this.ladder) {
      const clip = source.clips.get(rung.name);
      if (!clip) continue;
      const action = mixer.clipAction(clip);
      start(action, clip);
      this.tracks.push({ name: rung.name, action, speed: rung.speed, weight: 0 });
    }

    for (const name of source.byRole('dir')) {
      const clip = source.clips.get(name);
      const meta = source.info.get(name);
      if (!clip || !meta) continue;
      const angle = (meta.angle * Math.PI) / 180;
      const add = (c: THREE.AnimationClip, n: string, a: number): void => {
        const action = mixer.clipAction(c);
        start(action, c);
        this.directions.push({
          name: n, action, speed: meta.groundSpeed, weight: 0, angle: a, armed: meta.armed,
        });
      };
      add(clip, name, angle);
      // One download covers both sides. Straight ahead and straight back are
      // their own mirror image, so only the off-axis clips get a twin.
      const offAxis = Math.abs(angle) > 1e-3 && Math.abs(Math.abs(angle) - Math.PI) > 1e-3;
      if (offAxis) add(mirrorClip(clip), `${name}:mirror`, -angle);
    }

    for (const name of source.byRole('goofy')) {
      const clip = source.clips.get(name);
      const meta = source.info.get(name);
      if (!clip || !meta) continue;
      const action = mixer.clipAction(clip);
      start(action, clip);
      this.substitutes.push({
        name, action, speed: meta.groundSpeed, weight: 0, replaces: this.gaitRungs(),
      });
    }
  }

  /**
   * The rungs the goofy run stands in for: the gait between the walk and the
   * sprint.
   *
   * DECISION: the brief scopes this to "the jog speed band, 3.5 to 6.5 m/s" and
   * leaves walk and sprint alone. Taken literally against the supplied clips it
   * would almost never be seen -- the jog was authored at 1.81 m/s, and the
   * player's ordinary walk is 4 m/s, which sits between the slow run and the
   * sprint. So it replaces the middle of the ladder instead: pressing P changes
   * how the character gets about, which is plainly what it is for, while the
   * slowest rung and a held Shift are both left alone.
   *
   * The cost is worth naming: a clip authored at 1.63 m/s cannot carry 4 m/s
   * inside the playback clamp, so the goofy run slides by about a fifth. Every
   * other clip in the game plants to within a percent.
   */
  private gaitRungs(): string[] {
    const gait = this.ladder.filter((r) => r.speed > 0);
    return gait.length <= 2 ? gait.map((r) => r.name) : gait.slice(1, -1).map((r) => r.name);
  }

  /** The rungs the goofy clip stands in for, for the smoke suite. */
  get goofyReplaces(): string[] {
    return this.substitutes.find((s) => s.name.startsWith('jogGoofy'))?.replaces ?? [];
  }

  /** Every directional clip and the angle it covers, for the smoke suite. */
  get directionNames(): Array<{ name: string; deg: number; armed: boolean }> {
    return this.directions.map((d) => ({
      name: d.name, deg: Math.round((d.angle * 180) / Math.PI), armed: d.armed,
    }));
  }

  /** Per-clip weights and rates, for the smoke suite. */
  debug(into: Record<string, { weight: number; timeScale: number }>): void {
    for (const t of this.all()) {
      into[t.name] = {
        weight: +t.action.getEffectiveWeight().toFixed(3),
        timeScale: +t.action.timeScale.toFixed(3),
      };
    }
  }

  /**
   * What the feet are describing: every playing clip's authored speed, scaled
   * by its playback rate and weighted by how much of it is showing. The honest
   * measure of foot sliding.
   */
  get footSpeed(): number {
    let sum = 0;
    for (const t of this.all()) {
      if (t.speed > 0.05) sum += t.action.getEffectiveWeight() * t.action.timeScale * t.speed;
    }
    return sum;
  }

  private all(): Track[] {
    return [...this.tracks, ...this.directions, ...this.substitutes];
  }

  /**
   * Ease every weight toward what `speed` and `moveAngle` ask for, and return
   * the total for the rig to normalise against whatever else is playing.
   *
   * `suppress` is how much of the body a full-body one-shot has taken over. The
   * blend is scaled down by it rather than stopped, so a jump lands back into a
   * run without the legs snapping.
   */
  step(speed: number, dt: number, suppress: number): number {
    const targets = new Map<string, number>();
    const forwardShare = this.splitByDirection(targets, Math.max(0, speed));
    this.splitBySpeed(speed, forwardShare, targets);
    this.applySubstitutes(targets);

    const rate = dt / Math.max(A.blend, 1e-3);
    const give = (want: number, cur: number): number => {
      const d = want - cur;
      return Math.abs(d) <= rate ? want : cur + Math.sign(d) * rate;
    };

    let total = 0;
    const all = this.all();
    for (const t of all) {
      t.weight = give(targets.get(t.name) ?? 0, t.weight);
      total += t.weight;
    }

    const keep = 1 - THREE.MathUtils.clamp(suppress, 0, 1);
    const norm = total > 1e-4 ? keep / total : 0;
    const s = Math.max(0, speed);
    for (const t of all) {
      t.action.setEffectiveWeight(t.weight * norm);
      t.action.timeScale = rateFor(s, t.speed);
    }
    return total * norm;
  }

  /**
   * Split the blend between "straight ahead" and the directional clips either
   * side of the current heading. Returns the share the speed ladder keeps.
   *
   * Two axes, not one. Around the ring, the current heading is bracketed by the
   * two nearest directions. Within each of those, the current SPEED is bracketed
   * across every clip that travels that way -- because a walk backward and a run
   * backward are both 180 degree clips, and picking between them by angle alone
   * is picking arbitrarily. It is the same speed ladder logic as straight ahead,
   * applied per direction.
   */
  private splitByDirection(targets: Map<string, number>, speed: number): number {
    const usable = this.directions.filter((d) => d.armed === this.armed);
    if (usable.length === 0) return 1;

    const anchors = new Map<number, Anchor>();
    const bucket = (angle: number): Anchor => {
      // Whole degrees: clip directions are measured from root motion, so two
      // clips meant to travel the same way land a fraction of a degree apart.
      const key = Math.round((angle * 180) / Math.PI);
      let a = anchors.get(key);
      if (!a) { a = { angle: (key * Math.PI) / 180, rungs: [] }; anchors.set(key, a); }
      return a;
    };

    // The ladder is always a rung of the forward anchor, at 0 m/s, even when an
    // armed forward clip exists. Standing still should hold the idle, not drag
    // a run clip down to its slowest legal playback rate.
    bucket(0).rungs.push({ dir: null, speed: 0 });
    for (const d of usable) {
      bucket(d.angle).rungs.push({ dir: d, speed: d.speed });
      // A second copy of any backward clip at the far side, so a heading just
      // past 180 degrees blends the short way round instead of sweeping all the
      // way back through forward.
      if (Math.abs(Math.abs(d.angle) - Math.PI) < 1e-3) {
        bucket(-d.angle).rungs.push({ dir: d, speed: d.speed });
      }
    }
    // Above the fastest armed forward clip, hand the forward anchor BACK to the
    // ladder. An armed walk authored at 2.9 m/s cannot carry a 6.75 m/s run, and
    // at that speed the character is sprinting with the gun down anyway -- the
    // ordinary run is the honest clip. Without this the armed forward clip pins
    // the playback clamp and skates by about a third.
    const fwd = anchors.get(0);
    if (fwd && fwd.rungs.some((r) => r.dir !== null)) {
      const top = this.ladder.reduce((m, r) => Math.max(m, r.speed), 0);
      const fastestArmed = fwd.rungs.reduce((m, r) => Math.max(m, r.speed), 0);
      if (top > fastestArmed + 0.05) fwd.rungs.push({ dir: null, speed: top });
    }

    const ring = [...anchors.values()].sort((a, b) => a.angle - b.angle);
    for (const a of ring) a.rungs.sort((x, y) => x.speed - y.speed);

    const angle = THREE.MathUtils.clamp(this.moveAngle, -Math.PI, Math.PI);
    let lo = ring[0], hi = ring[ring.length - 1];
    for (let i = 0; i < ring.length - 1; i++) {
      if (angle >= ring[i].angle && angle <= ring[i + 1].angle) {
        lo = ring[i];
        hi = ring[i + 1];
        break;
      }
    }
    const span = hi.angle - lo.angle;
    const t = span > 1e-4 ? THREE.MathUtils.clamp((angle - lo.angle) / span, 0, 1) : 0;

    let forwardShare = 0;
    const give = (r: { dir: Directional | null }, w: number): void => {
      if (w <= 1e-4) return;
      if (r.dir === null) forwardShare += w;
      else targets.set(r.dir.name, (targets.get(r.dir.name) ?? 0) + w);
    };
    /** Hand one direction's share out across the clips that travel it, by speed. */
    const put = (a: Anchor, w: number): void => {
      if (w <= 1e-4) return;
      const r = a.rungs;
      let i = 0;
      while (i < r.length - 1 && r[i + 1].speed <= speed) i++;
      const a0 = r[i], a1 = r[Math.min(i + 1, r.length - 1)];
      const gap = a1.speed - a0.speed;
      // A zero gap means two clips authored at the same speed -- duplicates of
      // each other. The first wins rather than both playing at half weight.
      const k = gap > 1e-4 ? THREE.MathUtils.clamp((speed - a0.speed) / gap, 0, 1) : 0;
      give(a0, w * (1 - k));
      give(a1, w * k);
    };
    put(lo, 1 - t);
    put(hi, t);
    return forwardShare;
  }

  /** The speed ladder, scaled by whatever share the direction split left it. */
  private splitBySpeed(speed: number, share: number, targets: Map<string, number>): void {
    if (this.ladder.length === 0 || share <= 0) return;
    // No dead zone at the bottom: the ladder's own idle rung sits at 0 m/s, so
    // a drift of 0.1 m/s resolves to almost pure idle without a threshold to
    // step across.
    const s = Math.max(0, speed);
    let i = 0;
    while (i < this.ladder.length - 1 && this.ladder[i + 1].speed <= s) i++;
    const lo = this.ladder[i];
    const hi = this.ladder[Math.min(i + 1, this.ladder.length - 1)];
    const span = hi.speed - lo.speed;
    const t = span > 1e-3 ? THREE.MathUtils.clamp((s - lo.speed) / span, 0, 1) : 1;
    targets.set(lo.name, (targets.get(lo.name) ?? 0) + (1 - t) * share);
    targets.set(hi.name, (targets.get(hi.name) ?? 0) + t * share);
  }

  /**
   * Hand the gait's target weight to the goofy jog. Done on the target rather
   * than on the eased weight, so toggling P mid-stride crossfades from wherever
   * the two clips happen to be instead of cutting.
   */
  private applySubstitutes(targets: Map<string, number>): void {
    if (!this.goofy) return;
    for (const sub of this.substitutes) {
      let taken = 0;
      for (const rung of sub.replaces) {
        taken += targets.get(rung) ?? 0;
        targets.set(rung, 0);
      }
      if (taken > 0) targets.set(sub.name, (targets.get(sub.name) ?? 0) + taken);
    }
  }
}

/**
 * Playback rate: one cycle must cover the ground actually covered, so it is
 * speed divided by the speed the clip was authored at. Clamped, because a walk
 * stretched fourfold is a cartoon and a run at a third is a moonwalk.
 */
function rateFor(speed: number, authored: number): number {
  if (authored <= 0.05) return 1;
  return THREE.MathUtils.clamp(speed / authored, A.timeScaleMin, A.timeScaleMax);
}
