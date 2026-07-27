// Fully procedural audio — no samples to ship.
//
// A gunshot is synthesised as three layered elements the way a real one is
// recorded: the crack (a very short broadband transient), the body (filtered
// noise with a fast pitched decay), and the tail (a convolved reverb of the
// surrounding structures). Everything else is built the same way.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

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
    this.ready = true;
  }

  resume() { if (this.ctx?.state === 'suspended') this.ctx.resume(); }

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

  noise(duration, gainValue, filterType, freq, q = 1) {
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
    src.start();
    src.stop(this.ctx.currentTime + duration + 0.05);
    return { src, filter: f, gain: g };
  }

  /**
   * @param distance metres; drives volume, air absorption and the crack/tail mix
   */
  gunshot(distance = 0, { indoor = false } = {}) {
    if (!this.ready || !this.enabled) return;
    const t = this.ctx.currentTime;
    const near = distance < 3;
    const atten = 1 / (1 + distance * distance * 0.006);
    const delay = distance / 343;

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
      const { filter, gain } = this.noise(0.06, 0, 'highpass', near ? 900 : 500);
      gain.gain.setValueAtTime(0.0001, T);
      gain.gain.exponentialRampToValueAtTime(near ? 1.0 : 0.55, T + 0.0012);
      gain.gain.exponentialRampToValueAtTime(0.0008, T + 0.030);
      filter.frequency.setValueAtTime(near ? 3800 : 1800, T);
      filter.frequency.exponentialRampToValueAtTime(700, T + 0.05);
      gain.connect(out);
    }

    // --- body: pitched noise burst -----------------------------------------
    {
      const { filter, gain } = this.noise(0.30, 0, 'bandpass', 420, 1.1);
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
      const { filter, gain } = this.noise(0.9, 0, 'lowpass', 900, 0.8);
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
    const t = this.ctx.currentTime;
    const amp = clamp(1 - distance / 4.5, 0, 1);
    if (amp <= 0.01) return;
    const { filter, gain } = this.noise(0.05, 0, 'bandpass', 2600, 0.8);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.55 * amp, t + 0.0009);
    gain.gain.exponentialRampToValueAtTime(0.0006, t + 0.035);
    filter.frequency.setValueAtTime(4200, t);
    filter.frequency.exponentialRampToValueAtTime(1400, t + 0.04);
    gain.connect(this.master);
  }

  impact(surface = 'stone', distance = 0) {
    if (!this.ready || !this.enabled) return;
    const t = this.ctx.currentTime + distance / 343;
    const atten = 1 / (1 + distance * distance * 0.02);
    const profile = {
      stone: { freq: 1400, q: 1.4, dur: 0.12, amp: 0.42 },
      metal: { freq: 3200, q: 5.5, dur: 0.30, amp: 0.38 },
      sand: { freq: 520, q: 0.7, dur: 0.10, amp: 0.30 },
      flesh: { freq: 320, q: 1.0, dur: 0.09, amp: 0.44 },
    }[surface] ?? { freq: 1400, q: 1.4, dur: 0.12, amp: 0.4 };

    const { filter, gain } = this.noise(profile.dur + 0.1, 0, 'bandpass', profile.freq, profile.q);
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
    const t = this.ctx.currentTime;
    const { filter, gain } = this.noise(0.14, 0, 'bandpass', 260 + Math.random() * 180, 0.9);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.16 * strength, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0004, t + 0.11 + Math.random() * 0.05);
    filter.frequency.setValueAtTime(700, t);
    filter.frequency.exponentialRampToValueAtTime(180, t + 0.10);
    gain.connect(this.master);

    // Grit scatter on top.
    const { filter: f2, gain: g2 } = this.noise(0.10, 0, 'highpass', 3400);
    g2.gain.setValueAtTime(0.0001, t + 0.004);
    g2.gain.exponentialRampToValueAtTime(0.035 * strength, t + 0.012);
    g2.gain.exponentialRampToValueAtTime(0.0003, t + 0.09);
    void f2;
    g2.connect(this.master);
  }

  /** Short metallic click family used across the reload track. */
  mechanical(kind) {
    if (!this.ready || !this.enabled) return;
    const t = this.ctx.currentTime;
    const spec = {
      release: { f: 2600, amp: 0.20, dur: 0.05, q: 6 },
      insert: { f: 900, amp: 0.30, dur: 0.13, q: 2.2 },
      seat: { f: 1500, amp: 0.34, dur: 0.09, q: 4 },
      bolt: { f: 2100, amp: 0.40, dur: 0.16, q: 3 },
      dryfire: { f: 3000, amp: 0.22, dur: 0.05, q: 7 },
      casing: { f: 4200, amp: 0.10, dur: 0.10, q: 8 },
    }[kind];
    if (!spec) return;

    const { filter, gain } = this.noise(spec.dur + 0.05, 0, 'bandpass', spec.f, spec.q);
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
    const t = this.ctx.currentTime;
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
    const t = this.ctx.currentTime;
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
