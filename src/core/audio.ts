// All sound is synthesized with Web Audio. No audio files (plan section 0.4).
// Phase 7 extends this; Phase 0 provides the graph and the resume-on-first-key rule.
//
// DECISION: the engine drone, the horn, the siren, the helicopter rotor, the
// crash thud and the UI blips are gone. What is left is the sound of something
// the player did on purpose -- a punch, a shot, a dance -- which is the only
// kind that earns its place; everything else was noise the player could not
// turn off.

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambientDelay: DelayNode | null = null;
  private ambientOn = false;
  private ambientTimer: number | null = null;
  private ambientStep = 0;
  private beatBus: GainNode | null = null;
  private beatOn = false;
  private beatTimer: number | null = null;
  private beatStep = 0;
  enabled = true;

  /** Must be called from a user gesture (browser autoplay policy). */
  resume(): void {
    if (this.ctx) { void this.ctx.resume(); return; }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) { this.enabled = false; return; }
    const ctx = new Ctor();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(ctx.destination);
    this.master = master;

    // Ambient loop's shared delay, built once so start/stopAmbient can be cheap.
    const ambDelay = ctx.createDelay(1);
    ambDelay.delayTime.value = 0.28;
    const ambFeedback = ctx.createGain();
    ambFeedback.gain.value = 0.28;
    const ambWet = ctx.createGain();
    ambWet.gain.value = 0.5;
    ambDelay.connect(ambFeedback).connect(ambDelay);
    ambDelay.connect(ambWet).connect(master);
    this.ambientDelay = ambDelay;
  }

  /** Filtered noise burst; amplitude from impact speed. */
  thud(impact: number): void {
    if (!this.ctx || !this.master) return;
    const dur = 0.35;
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * dur, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 420;
    const g = this.ctx.createGain();
    g.gain.value = Math.min(0.5, impact / 40);
    src.connect(f).connect(g).connect(this.master);
    src.start();
  }

  /**
   * The air a punch moves: a short band-passed noise sweep. Every swing gets
   * one whether or not it connects, which is what makes a miss read as a miss
   * rather than as nothing happening.
   */
  whoosh(): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const dur = 0.12;
    const buf = this.ctx.createBuffer(1, Math.ceil(this.ctx.sampleRate * dur), this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.4;
    // Sweeping the band up is what turns a hiss into something travelling.
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(2600, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.14, t + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
  }

  /**
   * A pistol shot: a bright noise crack over a low thump, 0.1 s in total.
   * Synthesised like everything else -- no audio files anywhere in this project.
   */
  gunshot(): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const dur = 0.1;
    const buf = this.ctx.createBuffer(1, Math.ceil(this.ctx.sampleRate * dur), this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const k = 1 - i / d.length;
      d[i] = (Math.random() * 2 - 1) * k * k;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const crack = this.ctx.createGain();
    crack.gain.value = 0.35;
    src.connect(hp).connect(crack).connect(this.master);
    src.start(t);

    // The body of the report, which is what makes it a gun and not a hi-hat.
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.09);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.14);
  }

  /** Optional 4-bar ambient loop (plan 9, "if time allows"): two chords, a slow
   * arpeggio at 90 bpm, triangle oscillators through a shared delay. Safe to
   * call repeatedly; a second call while already running is a no-op. */
  startAmbient(): void {
    if (!this.ctx || !this.master || !this.ambientDelay || this.ambientOn) return;
    this.ambientOn = true;
    this.ambientStep = 0;
    const stepDur = 60 / 90 / 2; // eighth notes at 90 bpm
    const chordA = [220.0, 261.63, 329.63, 392.0];   // A minor 7
    const chordB = [174.61, 220.0, 261.63, 329.63];  // F major 7
    const playStep = (): void => {
      if (!this.ambientOn || !this.ctx || !this.master || !this.ambientDelay) return;
      const bar = Math.floor(this.ambientStep / 8) % 2;
      const chord = bar === 0 ? chordA : chordB;
      const note = chord[this.ambientStep % chord.length];
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = note;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.045, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, t + stepDur * 0.9);
      o.connect(g).connect(this.master);
      o.connect(this.ambientDelay);
      o.start(t); o.stop(t + stepDur);
      this.ambientStep = (this.ambientStep + 1) % 32; // 4 bars of 8 eighth-notes
      this.ambientTimer = window.setTimeout(playStep, stepDur * 1000);
    };
    playStep();
  }

  stopAmbient(): void {
    this.ambientOn = false;
    if (this.ambientTimer !== null) { window.clearTimeout(this.ambientTimer); this.ambientTimer = null; }
  }

  /**
   * Four-on-the-floor kick and hi-hat, for the duration of a dance.
   *
   * No song, no sample, no melody: the brief rules out real music outright, and
   * a synthesised kick on the beat is what makes eight seconds of dancing read
   * as dancing rather than as a bug. Kick on every quarter, hat on every
   * off-eighth, both built from the same primitives as the horn and the thud.
   *
   * DECISION: gain 0.4 is applied on this bus, not on the master. The brief
   * asks for "master gain 0.4", but turning the global master down to 0.4 for
   * the duration would dip the engine and the sirens with it -- clearly not the
   * intent, and audible as a duck every time you press G.
   */
  startBeat(bpm: number, gain: number): void {
    if (!this.ctx || !this.master || this.beatOn) return;
    this.beatOn = true;
    this.beatStep = 0;
    const eighth = 60 / bpm / 2;
    const bus = this.ctx.createGain();
    bus.gain.value = gain;
    bus.connect(this.master);
    this.beatBus = bus;

    const tick = (): void => {
      if (!this.beatOn || !this.ctx || !this.beatBus) return;
      const t = this.ctx.currentTime;
      if (this.beatStep % 2 === 0) this.kick(t, this.beatBus);
      else this.hat(t, this.beatBus);
      this.beatStep = (this.beatStep + 1) % 8;
      this.beatTimer = window.setTimeout(tick, eighth * 1000);
    };
    tick();
  }

  stopBeat(): void {
    this.beatOn = false;
    if (this.beatTimer !== null) { window.clearTimeout(this.beatTimer); this.beatTimer = null; }
    if (this.beatBus && this.ctx) {
      // Ride the bus down rather than cutting it: a gain node disconnected
      // mid-envelope clicks.
      this.beatBus.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
      const bus = this.beatBus;
      window.setTimeout(() => bus.disconnect(), 400);
      this.beatBus = null;
    }
  }

  /** Sine dropped from 120 Hz to 45 Hz in 120 ms: the whole of a kick drum. */
  private kick(t: number, out: GainNode): void {
    if (!this.ctx) return;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(g).connect(out);
    o.start(t); o.stop(t + 0.24);
  }

  private hat(t: number, out: GainNode): void {
    if (!this.ctx) return;
    const dur = 0.06;
    const buf = this.ctx.createBuffer(1, Math.ceil(this.ctx.sampleRate * dur), this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7000;
    const g = this.ctx.createGain();
    g.gain.value = 0.22;
    src.connect(f).connect(g).connect(out);
    src.start(t);
  }

}
