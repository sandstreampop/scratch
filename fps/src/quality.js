// Device tiering and runtime quality scaling.
//
// The desktop build generates ~40 MB of procedural texture data and renders a
// 4096px shadow map through a five-pass composite. A phone will neither boot
// that in reasonable time nor sustain a frame rate on it, and iOS Safari will
// discard the WebGL context outright if the memory footprint gets too large.
//
// Tiers are picked up front from what the device tells us, then corrected
// downward from measured frame time — device hints are weak signals (iOS
// reports neither deviceMemory nor a useful renderer string), so the honest
// answer only arrives once frames are actually being drawn.

export const TIERS = {
  low: {
    name: 'low',
    pixelRatio: 1.0,
    textureScale: 0.25,        // 1024 -> 256
    anisotropy: 2,
    shadowMapSize: 1024,
    shadowRadius: 1.2,
    bloom: true,
    shafts: false,
    smaa: false,
    gtao: false,
    particleScale: 0.30,
    scatterScale: 0.30,
    maxEnemies: 4,
    fogDensityScale: 1.35,     // hides the shorter draw distance
  },
  medium: {
    name: 'medium',
    pixelRatio: 1.25,
    textureScale: 0.5,         // 1024 -> 512
    anisotropy: 4,
    shadowMapSize: 2048,
    shadowRadius: 1.8,
    bloom: true,
    shafts: true,
    smaa: false,
    gtao: false,
    particleScale: 0.6,
    scatterScale: 0.6,
    maxEnemies: 6,
    fogDensityScale: 1.1,
  },
  high: {
    name: 'high',
    pixelRatio: 1.75,
    textureScale: 1.0,
    anisotropy: 8,
    shadowMapSize: 3072,
    shadowRadius: 2.2,
    bloom: true,
    shafts: true,
    smaa: true,
    gtao: true,
    particleScale: 1.0,
    scatterScale: 1.0,
    maxEnemies: 7,
    fogDensityScale: 1.0,
  },
  ultra: {
    name: 'ultra',
    pixelRatio: 2.0,
    textureScale: 1.0,
    anisotropy: 16,
    shadowMapSize: 4096,
    shadowRadius: 2.4,
    bloom: true,
    shafts: true,
    smaa: true,
    gtao: true,
    particleScale: 1.0,
    scatterScale: 1.0,
    maxEnemies: 8,
    fogDensityScale: 1.0,
  },
};

const ORDER = ['low', 'medium', 'high', 'ultra'];

export const platform = (() => {
  if (typeof navigator === 'undefined') return { ios: false, mobile: false, safari: false };
  const ua = navigator.userAgent;
  // iPadOS 13+ reports as desktop Mac; the touch-point count gives it away.
  const ios = /iPad|iPhone|iPod/.test(ua)
    || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
  const android = /Android/.test(ua);
  const safari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua) || ios;
  return {
    ios,
    android,
    safari,
    mobile: ios || android || (navigator.maxTouchPoints || 0) > 0,
  };
})();

/** Best guess before a single frame has been drawn. */
export function detectTier() {
  if (typeof navigator === 'undefined') return 'high';

  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory || 0;         // absent on Safari
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const px = typeof window !== 'undefined'
    ? window.screen.width * window.screen.height * dpr * dpr
    : 0;

  if (platform.mobile) {
    // Not `cores >= 6`. WebKit clamps hardwareConcurrency, so current iPhones
    // routinely report 4 and every one of them was pinned to the lowest tier —
    // 256px textures, no sun shafts, no antialiasing — with no way back up,
    // because the governor below only ever moves down. Guessing high is the
    // cheap mistake here: a device that cannot hold medium drops out of it
    // within a few seconds of measured frame time, and the only part of the
    // tier fixed at boot is texture resolution, at 512px rather than 256px.
    // Guessing low is the expensive one, because it is permanent.
    if (platform.ios) return cores > 0 && cores <= 2 ? 'low' : 'medium';
    // Android's core and memory reporting is honest enough to use directly.
    if (cores >= 8 && memory >= 6) return 'medium';
    return 'low';
  }

  if (cores <= 2 || (memory && memory <= 2)) return 'low';
  if (cores <= 4) return 'medium';
  // A very high-resolution desktop display costs fill rate, not compute.
  if (px > 1920 * 1080 * 4) return 'high';
  return cores >= 8 ? 'ultra' : 'high';
}

export class Quality {
  constructor(requested) {
    const override = readOverride();
    this.locked = !!override;
    this.tierName = override || requested || detectTier();
    this.settings = { ...TIERS[this.tierName] };

    this._samples = [];
    this._lastAdjust = 0;
    this._listeners = [];
    this.targetFps = platform.mobile ? 30 : 55;
  }

  get(key) { return this.settings[key]; }

  onChange(fn) { this._listeners.push(fn); }

  /** Applies a tier and notifies listeners so live systems can reconfigure. */
  setTier(name) {
    if (!TIERS[name] || name === this.tierName) return false;
    this.tierName = name;
    this.settings = { ...TIERS[name] };
    for (const fn of this._listeners) fn(this.settings, name);
    return true;
  }

  /**
   * Feeds a frame time in seconds. Drops a tier when the running median can't
   * hold the target, and stops there — quality is never raised again, because
   * oscillating between tiers is far more objectionable than sitting one tier
   * below optimal.
   */
  sample(dt, now) {
    if (this.locked || this.tierName === 'low') return;
    if (dt <= 0 || dt > 0.5) return;                   // ignore stalls and tab-outs

    this._samples.push(dt);
    if (this._samples.length < 60) return;
    if (this._samples.length > 120) this._samples.shift();

    // Let the first couple of seconds settle before judging anything.
    if (now < 2.5 || now - this._lastAdjust < 4) return;

    const sorted = [...this._samples].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const fps = 1 / median;

    if (fps < this.targetFps * 0.8) {
      const idx = ORDER.indexOf(this.tierName);
      if (idx > 0) {
        this._lastAdjust = now;
        this._samples.length = 0;
        const next = ORDER[idx - 1];
        console.info(`quality: ${Math.round(fps)} fps sustained, dropping to ${next}`);
        this.setTier(next);
      }
    }
  }
}

/** `?quality=low` pins a tier, for testing and for users who know better. */
function readOverride() {
  if (typeof location === 'undefined') return null;
  const q = new URLSearchParams(location.search).get('quality');
  return q && TIERS[q] ? q : null;
}
