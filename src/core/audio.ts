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
    this.sirenOsc.frequency.setTargetAtTime(two ? 700 : 900, t, 0.01);
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
