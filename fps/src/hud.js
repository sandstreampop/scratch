// HUD driver. The layout lives in index.html; this file only animates it.
// Everything is DOM/canvas so it stays crisp at any resolution and costs no
// GPU time in the 3D pipeline.

import * as THREE from 'three';

const CARDINALS = [
  [0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'],
  [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW'],
];

export class HUD {
  constructor() {
    this.root = document.getElementById('hud');
    this.crosshair = document.getElementById('crosshair');
    this.lines = {
      t: this.crosshair.querySelector('.t'),
      b: this.crosshair.querySelector('.b'),
      l: this.crosshair.querySelector('.l'),
      r: this.crosshair.querySelector('.r'),
      dot: this.crosshair.querySelector('.dot'),
    };
    this.hitmarker = document.getElementById('hitmarker');
    this.magEl = document.querySelector('#ammo .mag');
    this.reserveEl = document.querySelector('#ammo .reserve');
    this.weaponEl = document.querySelector('#ammo .weapon');
    this.scoreEl = document.querySelector('#score .value');
    this.damageEl = document.getElementById('damage');
    this.killfeedEl = document.getElementById('killfeed');
    this.titleEl = document.getElementById('title');
    this.compass = document.getElementById('compass').querySelector('canvas');
    this.ctx = this.compass.getContext('2d');

    this._hitTimer = 0;
    this._hitKill = false;
    this._damageLevel = 0;
    this._feed = [];
    this._lastMag = -1;
    this._lastScore = -1;
    this._spread = 8;

    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.resizeCompass();
  }

  show() { this.root.classList.remove('hidden'); }

  resizeCompass() {
    const w = 460, h = 34;
    this.compass.width = w * this.dpr;
    this.compass.height = h * this.dpr;
    this.ctx.scale(this.dpr, this.dpr);
    this._cw = w;
    this._ch = h;
  }

  playTitle() {
    this.titleEl.style.opacity = '1';
    setTimeout(() => { this.titleEl.style.opacity = '0'; }, 4200);
  }

  hit(isKill) {
    this._hitTimer = isKill ? 0.34 : 0.22;
    this._hitKill = isKill;
    this.hitmarker.classList.toggle('kill', isKill);
  }

  killLine(text, byPlayer = true) {
    const el = document.createElement('div');
    el.className = 'entry';
    el.innerHTML = byPlayer
      ? `<span class="you">YOU</span> &nbsp;✖&nbsp; ${text}`
      : text;
    this.killfeedEl.prepend(el);
    this._feed.push({ el, life: 5.5 });
    while (this._feed.length > 5) {
      const old = this._feed.shift();
      old.el.remove();
    }
  }

  /**
   * @param spreadPixels crosshair gap, derived from the live weapon cone
   */
  update(dt, { ammo, reserve, spreadPixels, score, health, yaw, ads, sprinting, reloading }) {
    // --- crosshair --------------------------------------------------------
    const target = ads ? 2.5 : spreadPixels;
    this._spread = THREE.MathUtils.damp(this._spread, target, 18, dt);
    const s = this._spread;
    const len = ads ? 4 : 7;
    this.lines.t.style.transform = `translateY(${-s - len}px)`;
    this.lines.b.style.transform = `translateY(${s}px)`;
    this.lines.l.style.transform = `translateX(${-s - len}px)`;
    this.lines.r.style.transform = `translateX(${s}px)`;
    this.lines.t.style.height = this.lines.b.style.height = `${len}px`;
    this.lines.l.style.width = this.lines.r.style.width = `${len}px`;
    const chOpacity = ads ? 0 : sprinting ? 0.35 : 1;
    this.crosshair.style.opacity = String(chOpacity);
    this.lines.dot.style.opacity = ads ? '0' : '0.55';

    // --- hitmarker --------------------------------------------------------
    if (this._hitTimer > 0) {
      this._hitTimer -= dt;
      const k = Math.max(0, this._hitTimer / (this._hitKill ? 0.34 : 0.22));
      this.hitmarker.style.opacity = String(Math.min(1, k * 2.2));
      const spread = 1 + (1 - k) * 3.5;
      this.hitmarker.style.transform = `scale(${1 + (1 - k) * 0.35})`;
      void spread;
    } else {
      this.hitmarker.style.opacity = '0';
    }

    // --- ammo -------------------------------------------------------------
    const mag = Math.round(ammo);
    if (mag !== this._lastMag) {
      this._lastMag = mag;
      this.magEl.textContent = String(mag);
      this.magEl.style.color = mag === 0 ? '#ff3b30' : mag <= 7 ? '#ffb454' : '';
      this.reserveEl.textContent = `| ${reserve}`;
    }
    this.weaponEl.style.opacity = reloading ? '0.5' : '';

    // --- score ------------------------------------------------------------
    if (score !== this._lastScore) {
      this._lastScore = score;
      this.scoreEl.textContent = String(score);
    }

    // --- damage vignette --------------------------------------------------
    const hurt = 1 - THREE.MathUtils.clamp(health / 100, 0, 1);
    this._damageLevel = THREE.MathUtils.damp(this._damageLevel, hurt, 6, dt);
    this.damageEl.style.opacity = String(Math.pow(this._damageLevel, 0.7));

    // --- kill feed ageing ---------------------------------------------------
    for (let i = this._feed.length - 1; i >= 0; i--) {
      const f = this._feed[i];
      f.life -= dt;
      if (f.life <= 0) { f.el.remove(); this._feed.splice(i, 1); }
      else if (f.life < 1) f.el.style.opacity = String(f.life);
    }

    this.drawCompass(yaw);
  }

  drawCompass(yaw) {
    const g = this.ctx;
    const w = this._cw, h = this._ch;
    g.clearRect(0, 0, w, h);

    // Heading in degrees, 0 = north (-Z).
    const heading = ((THREE.MathUtils.radToDeg(-yaw) % 360) + 360) % 360;
    const span = 120;                       // degrees visible across the strip
    const pxPerDeg = w / span;

    g.font = '600 11px "Segoe UI", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    // Ticks every 5 degrees, taller every 15.
    for (let d = -span / 2 - 5; d <= span / 2 + 5; d += 5) {
      const abs = heading + d;
      const x = w / 2 + d * pxPerDeg;
      if (x < -10 || x > w + 10) continue;
      const rounded = ((Math.round(abs / 5) * 5) % 360 + 360) % 360;
      const major = rounded % 15 === 0;
      g.strokeStyle = major ? 'rgba(240,244,248,0.55)' : 'rgba(240,244,248,0.24)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, h - 8);
      g.lineTo(x, h - (major ? 15 : 11));
      g.stroke();
    }

    for (const [deg, label] of CARDINALS) {
      let delta = deg - heading;
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;
      if (Math.abs(delta) > span / 2 + 6) continue;
      const x = w / 2 + delta * pxPerDeg;
      const fade = 1 - Math.abs(delta) / (span / 2 + 6);
      g.fillStyle = `rgba(240,244,248,${0.35 + fade * 0.6})`;
      g.font = label.length === 1 ? '700 13px "Segoe UI", Arial, sans-serif'
        : '600 10px "Segoe UI", Arial, sans-serif';
      g.fillText(label, x, h - 24);
    }

    // Centre index.
    g.fillStyle = '#ffb454';
    g.beginPath();
    g.moveTo(w / 2, h - 4);
    g.lineTo(w / 2 - 4.5, h - 0.5);
    g.lineTo(w / 2 + 4.5, h - 0.5);
    g.closePath();
    g.fill();
  }
}
