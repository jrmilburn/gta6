// All sound is synthesized with Web Audio. No audio files (plan section 0.4).
// Phase 7 extends this; Phase 0 provides the graph and the resume-on-first-key rule.

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineOsc: OscillatorNode | null = null;
  private engineSub: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;
  private sirenOsc: OscillatorNode | null = null;
  private sirenGain: GainNode | null = null;
  private sirenT = 0;
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

    // Engine: sawtooth + sub sine through a lowpass that opens with throttle.
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 500;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    filter.connect(gain).connect(master);
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.value = 60;
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 30;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.6;
    saw.connect(filter);
    sub.connect(subGain).connect(filter);
    saw.start(); sub.start();
    this.engineOsc = saw; this.engineSub = sub; this.engineFilter = filter; this.engineGain = gain;

    // Siren: square wave, gain driven by distance.
    const siren = ctx.createOscillator();
    siren.type = 'square';
    siren.frequency.value = 700;
    const sg = ctx.createGain();
    sg.gain.value = 0;
    siren.connect(sg).connect(master);
    siren.start();
    this.sirenOsc = siren; this.sirenGain = sg;

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

  /** speedFrac 0..1, throttle 0..1, active=false silences the engine (on foot). */
  engine(speedFrac: number, throttle: number, active: boolean): void {
    if (!this.ctx || !this.engineOsc || !this.engineGain || !this.engineFilter || !this.engineSub) return;
    const t = this.ctx.currentTime;
    const hz = 60 + speedFrac * 160;
    this.engineOsc.frequency.setTargetAtTime(hz, t, 0.05);
    this.engineSub.frequency.setTargetAtTime(hz * 0.5, t, 0.05);
    this.engineFilter.frequency.setTargetAtTime(400 + throttle * 1800 + speedFrac * 900, t, 0.08);
    this.engineGain.gain.setTargetAtTime(active ? 0.09 + throttle * 0.05 : 0, t, 0.1);
  }

  /** distance in metres to the nearest active siren; Infinity for none. */
  siren(distance: number, dt: number): void {
    if (!this.ctx || !this.sirenOsc || !this.sirenGain) return;
    const t = this.ctx.currentTime;
    if (!Number.isFinite(distance) || distance > 140) {
      this.sirenGain.gain.setTargetAtTime(0, t, 0.2);
      return;
    }
    this.sirenT += dt;
    const two = Math.floor(this.sirenT * 1.5) % 2 === 0;
    const drift = Math.sin(this.sirenT * 0.6) * 10; // slight pitch drift, plan section 9
    this.sirenOsc.frequency.setTargetAtTime((two ? 700 : 900) + drift, t, 0.01);
    const g = Math.max(0, 1 - distance / 140) ** 2 * 0.16;
    this.sirenGain.gain.setTargetAtTime(g, t, 0.15);
  }

  horn(): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    for (const detune of [0, 7]) {
      const o = this.ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = 350;
      o.detune.value = detune;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.12, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      o.connect(g).connect(this.master);
      o.start(t); o.stop(t + 0.42);
    }
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

  blip(freq = 880): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(freq, t);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.14, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.2);
  }
}
