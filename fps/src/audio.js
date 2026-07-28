// Fully procedural audio — no samples to ship.
//
// A gunshot is synthesised as three layered elements the way a real one is
// recorded: the crack (a very short broadband transient), the body (filtered
// noise with a fast pitched decay), and the tail (a convolved reverb of the
// surrounding structures). Everything else is built the same way.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Propagation speed for anything scheduled by distance, in one place.
//
// It used to be written out twice — once in gunshot(), once in impact() — and
// two literals that have to stay equal are a divergence waiting for whoever
// edits one of them. 343 m/s is dry air at 20 C; tools/targets.mjs
// audio.speed_of_sound_air carries the citation and the +/-2 m/s, and
// tools/gameplay-audio.mjs measures BOTH call paths against it and against each
// other, so a typo in either function is caught by a test rather than by a
// player wondering why an impact and a report disagree.
const SPEED_OF_SOUND = 343;

// The render quantum the Web Audio spec fixes at 128 sample frames. Used only to
// size the scheduling lead below; see the comment on `lead`.
const RENDER_QUANTUM_FRAMES = 128;

export class Audio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
  }

  /** Must be called from a user gesture. */
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;

    // Gentle bus compression keeps a full-auto burst from clipping.
    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -18;
    this.comp.knee.value = 22;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.002;
    this.comp.release.value = 0.16;

    this.master.connect(this.comp);
    this.comp.connect(this.ctx.destination);

    // Shared reverb send — the courtyard tail.
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this.buildImpulse(1.9, 2.6);
    this.reverbGain = this.ctx.createGain();
    this.reverbGain.gain.value = 0.34;
    this.reverb.connect(this.reverbGain);
    this.reverbGain.connect(this.master);

    this.noiseBuffer = this.buildNoise(2.0);

    // Everything is scheduled one render quantum into the future instead of at
    // ctx.currentTime.
    //
    // The audio thread has already rendered up to currentTime, so an envelope
    // whose first setValueAtTime lands exactly there starts in the past and is
    // clamped forward to the next 128-frame block boundary. Measured: the
    // gunshot crack's attack is 1.2 ms, which is 0.41 of a quantum at 44.1 kHz,
    // so the transient that makes a shot locatable was the part being quantised
    // away — and the hitmarker lost the first ~73% of its 4 ms attack the same
    // way. One quantum is the smallest lead that cannot be clamped, and it is
    // the granularity the spec offers, so a larger round number would only add
    // latency it cannot spend. It costs 2.90 ms at 44.1 kHz on top of a ~42 ms
    // platform output path, and BT.1359-1 says to err late rather than early,
    // so the direction is the safe one.
    this.lead = RENDER_QUANTUM_FRAMES / this.ctx.sampleRate;

    this.ready = true;
  }

  resume() { if (this.ctx?.state === 'suspended') this.ctx.resume(); }

  /** The earliest instant a scheduled event is guaranteed not to be clamped. */
  now() { return this.ctx.currentTime + this.lead; }

  buildNoise(seconds) {
    const n = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Slightly diffuse, slightly early-reflective — an open walled compound. */
  buildImpulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const n = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, n, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
      // A few discrete early reflections off the walls.
      for (const [ms, amp] of [[11, 0.5], [19, 0.38], [31, 0.28], [47, 0.2], [72, 0.14]]) {
        const idx = Math.floor(rate * ms / 1000) + (ch * 37);
        if (idx < n) d[idx] += amp * (Math.random() * 2 - 1);
      }
    }
    return buf;
  }

  /**
   * A filtered noise voice whose SOURCE LIFETIME is measured from the onset it
   * was built for, not from now.
   *
   * `when` is the time the caller's envelope opens at. The lifetime used to be
   * `ctx.currentTime + duration + 0.05` regardless, which is correct only for a
   * sound that starts immediately — and every sound scheduled by distance does
   * not. Measured through tools/gameplay-audio.mjs: at 220 m the onset is
   * 641 ms out while the source was stopped 270 ms out, so the whole envelope
   * was written onto a source that had already ended. An impact was ENTIRELY
   * silent past ~93 m and a gunshot lost its crack past ~38 m and its body past
   * ~120 m, all inside SPEC.range of 220 m. The delay maths was right the whole
   * time, which is why reading it could not find this — only the scheduled
   * onset against the recorded stop time can.
   */
  noise(duration, gainValue, filterType, freq, q = 1, when = null) {
    const t0 = when ?? this.now();
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.value = gainValue;
    src.connect(f); f.connect(g);
    src.start(t0);
    src.stop(t0 + duration + 0.05);
    return { src, filter: f, gain: g };
  }

  /**
   * @param distance metres; drives volume, air absorption and the crack/tail mix
   */
  gunshot(distance = 0, { indoor = false } = {}) {
    if (!this.ready || !this.enabled) return;
    const t = this.now();
    const near = distance < 3;
    const atten = 1 / (1 + distance * distance * 0.006);
    const delay = distance / SPEED_OF_SOUND;

    const out = this.ctx.createGain();
    out.gain.value = clamp(atten, 0, 1) * (near ? 1.0 : 0.85);
    out.connect(this.master);
    const send = this.ctx.createGain();
    send.gain.value = clamp(atten * (indoor ? 0.9 : 0.55), 0, 1);
    send.connect(this.reverb);
    out.connect(send);

    const T = t + delay;

    // --- crack: broadband transient, ~2 ms ---------------------------------
    {
      const { filter, gain } = this.noise(0.06, 0, 'highpass', near ? 900 : 500, 1, T);
      gain.gain.setValueAtTime(0.0001, T);
      gain.gain.exponentialRampToValueAtTime(near ? 1.0 : 0.55, T + 0.0012);
      gain.gain.exponentialRampToValueAtTime(0.0008, T + 0.030);
      filter.frequency.setValueAtTime(near ? 3800 : 1800, T);
      filter.frequency.exponentialRampToValueAtTime(700, T + 0.05);
      gain.connect(out);
    }

    // --- body: pitched noise burst -----------------------------------------
    {
      const { filter, gain } = this.noise(0.30, 0, 'bandpass', 420, 1.1, T);
      gain.gain.setValueAtTime(0.0001, T);
      gain.gain.exponentialRampToValueAtTime(0.85 * (near ? 1 : 0.7), T + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0008, T + 0.20);
      filter.frequency.setValueAtTime(760, T);
      filter.frequency.exponentialRampToValueAtTime(150, T + 0.18);
      gain.connect(out);
    }

    // --- low thump ----------------------------------------------------------
    {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(148, T);
      osc.frequency.exponentialRampToValueAtTime(42, T + 0.13);
      g.gain.setValueAtTime(0.0001, T);
      g.gain.exponentialRampToValueAtTime(0.62, T + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0008, T + 0.19);
      osc.connect(g); g.connect(out);
      osc.start(T); osc.stop(T + 0.25);
    }

    // --- distant shots gain a slapback tail and lose their high end ---------
    if (distance > 12) {
      const { filter, gain } = this.noise(0.9, 0, 'lowpass', 900, 0.8, T);
      gain.gain.setValueAtTime(0.0001, T + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.22 * atten, T + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0006, T + 0.85);
      filter.frequency.setValueAtTime(1100, T);
      filter.frequency.exponentialRampToValueAtTime(320, T + 0.7);
      gain.connect(out);
    }
  }

  /** Supersonic crack of a round passing close by. */
  snap(distance) {
    if (!this.ready || !this.enabled) return;
    const t = this.now();
    const amp = clamp(1 - distance / 4.5, 0, 1);
    if (amp <= 0.01) return;
    const { filter, gain } = this.noise(0.05, 0, 'bandpass', 2600, 0.8, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.55 * amp, t + 0.0009);
    gain.gain.exponentialRampToValueAtTime(0.0006, t + 0.035);
    filter.frequency.setValueAtTime(4200, t);
    filter.frequency.exponentialRampToValueAtTime(1400, t + 0.04);
    gain.connect(this.master);
  }

  impact(surface = 'stone', distance = 0) {
    if (!this.ready || !this.enabled) return;
    const t = this.now() + distance / SPEED_OF_SOUND;
    const atten = 1 / (1 + distance * distance * 0.02);
    const profile = {
      stone: { freq: 1400, q: 1.4, dur: 0.12, amp: 0.42 },
      metal: { freq: 3200, q: 5.5, dur: 0.30, amp: 0.38 },
      sand: { freq: 520, q: 0.7, dur: 0.10, amp: 0.30 },
      flesh: { freq: 320, q: 1.0, dur: 0.09, amp: 0.44 },
    }[surface] ?? { freq: 1400, q: 1.4, dur: 0.12, amp: 0.4 };

    const { filter, gain } = this.noise(profile.dur + 0.1, 0, 'bandpass', profile.freq, profile.q, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(profile.amp * atten, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0005, t + profile.dur);
    filter.frequency.setValueAtTime(profile.freq * 1.6, t);
    filter.frequency.exponentialRampToValueAtTime(profile.freq * 0.5, t + profile.dur);
    gain.connect(this.master);

    if (surface === 'metal') {
      // Ringing overtone.
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = 1800 + Math.random() * 1400;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.10 * atten, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0004, t + 0.42);
      osc.connect(g); g.connect(this.master);
      osc.start(t); osc.stop(t + 0.45);
    }
  }

  footstep(strength = 0.7) {
    if (!this.ready || !this.enabled) return;
    const t = this.now();
    const { filter, gain } = this.noise(0.14, 0, 'bandpass', 260 + Math.random() * 180, 0.9, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.16 * strength, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0004, t + 0.11 + Math.random() * 0.05);
    filter.frequency.setValueAtTime(700, t);
    filter.frequency.exponentialRampToValueAtTime(180, t + 0.10);
    gain.connect(this.master);

    // Grit scatter on top.
    const { filter: f2, gain: g2 } = this.noise(0.10, 0, 'highpass', 3400, 1, t);
    g2.gain.setValueAtTime(0.0001, t + 0.004);
    g2.gain.exponentialRampToValueAtTime(0.035 * strength, t + 0.012);
    g2.gain.exponentialRampToValueAtTime(0.0003, t + 0.09);
    void f2;
    g2.connect(this.master);
  }

  /** Short metallic click family used across the reload track. */
  mechanical(kind) {
    if (!this.ready || !this.enabled) return;
    const t = this.now();
    const spec = {
      release: { f: 2600, amp: 0.20, dur: 0.05, q: 6 },
      insert: { f: 900, amp: 0.30, dur: 0.13, q: 2.2 },
      seat: { f: 1500, amp: 0.34, dur: 0.09, q: 4 },
      bolt: { f: 2100, amp: 0.40, dur: 0.16, q: 3 },
      dryfire: { f: 3000, amp: 0.22, dur: 0.05, q: 7 },
      casing: { f: 4200, amp: 0.10, dur: 0.10, q: 8 },
    }[kind];
    if (!spec) return;

    const { filter, gain } = this.noise(spec.dur + 0.05, 0, 'bandpass', spec.f, spec.q, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(spec.amp, t + 0.0015);
    gain.gain.exponentialRampToValueAtTime(0.0004, t + spec.dur);
    filter.frequency.setValueAtTime(spec.f * 1.4, t);
    filter.frequency.exponentialRampToValueAtTime(spec.f * 0.6, t + spec.dur);
    gain.connect(this.master);

    const send = this.ctx.createGain();
    send.gain.value = 0.18;
    gain.connect(send);
    send.connect(this.reverb);
  }

  hurt() {
    if (!this.ready || !this.enabled) return;
    const t = this.now();
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.28);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 420;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.20, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.32);
    osc.connect(f); f.connect(g); g.connect(this.master);
    osc.start(t); osc.stop(t + 0.35);
  }

  hitmarker(kill) {
    if (!this.ready || !this.enabled) return;
    const t = this.now();
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(kill ? 1180 : 1560, t);
    if (kill) osc.frequency.setValueAtTime(880, t + 0.055);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(kill ? 0.10 : 0.062, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0004, t + (kill ? 0.16 : 0.06));
    osc.connect(g); g.connect(this.master);
    osc.start(t); osc.stop(t + 0.2);
  }

  /** Continuous wind bed. Started once. */
  startAmbience() {
    if (!this.ready || !this.enabled || this._ambience) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 340;
    f.Q.value = 0.5;
    const f2 = this.ctx.createBiquadFilter();
    f2.type = 'highpass';
    f2.frequency.value = 60;
    const g = this.ctx.createGain();
    g.gain.value = 0.035;
    src.connect(f); f.connect(f2); f2.connect(g); g.connect(this.master);
    src.start();

    // Slow gusting.
    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    lfo.frequency.value = 0.055;
    lfoGain.gain.value = 0.022;
    lfo.connect(lfoGain);
    lfoGain.connect(g.gain);
    lfo.start();

    this._ambience = { src, gain: g };
  }
}
