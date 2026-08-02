/* JK.Audio — 100% procedural WebAudio (no samples, no network). Owner: audio agent.
 *
 * Every sound is synthesised from oscillators + three noise buffers built once at
 * init(). init() runs inside the ENTER-THE-DUNES tap, so the iOS AudioContext is
 * created and unlocked by a real user gesture; a self-removing touchend/mousedown
 * listener resumes it again if iOS suspends it later.
 *
 * API (CONVENTIONS.md "ITERATION 3+4 CONTRACTS"):
 *   JK.Audio.play(name, opt)   opt = {pos:[x,y,z], vol, rate}
 *       pos  -> distance attenuation (silent past 55 m) + stereo pan derived from
 *               JK.GL.eye and JK.Player.camYaw (StereoPannerNode, graceful
 *               fallback to plain gain on old iOS).
 *       vol  -> 0..1 multiplier on the sound's authored level.
 *       rate -> pitch/speed multiplier (used by 'swing' for the doppler whoosh).
 *       Unknown names, muted, or no-WebAudio => silent no-op, never throws.
 *   JK.Audio.hum(on, intensity)  the ONE persistent saber drone voice.
 *   JK.Audio.setMute(b) / toggle() / .muted / .enabled / .ctx / .stopAll()
 *
 * Names implemented: saberOn saberOff swing clash hit blaster boltHit deflect
 *   jump land hurt die botDie push pull lightning grip speed forceFail select
 *
 * SELF-DRIVEN (the frozen iteration-1/2 modules predate audio and never call us,
 * so we read their public state instead of editing them): saber ignite/extinguish,
 * swing whooshes (JK.Sabers.attackId), saber hits (JK.Combat.lastHit + hitPos),
 * jump/land (JK.Player.jumped / onGround edge), hurt/die (JK.game.hp, JK.Hero.dead),
 * stance blips, and the hum intensity (swing phase + ground speed). Powers / Blaster
 * / Bots call play() themselves; a per-sound retrigger gap dedupes any overlap.
 *
 * Budget: ONE persistent hum graph + 16 persistent voice slots (gain[+panner]).
 * One-shots create only their own short-lived source/filter/env nodes, are reaped
 * by time in update(), and the quietest voice is dropped when the pool is full.
 */
(function(){
'use strict';

/* ============================== tuning ================================= */
var MAXV      = 16;      /* hard cap on simultaneous one-shot voices */
var NMAX      = 16;      /* nodes tracked per voice */
var MASTER_V  = 0.85;
var ROLLOFF   = 55.0;    /* metres to silence */
var REF_D     = 12.0;    /* metres where the 1/(1+d) curve is half */
var PAN_W     = 0.85;    /* max |pan| */
var LOOKAHEAD = 0.004;   /* s — never schedule exactly at currentTime */

/* ============================== state ================================== */
var ctx = null, master = null, comp = null;
var ok = false, muted = false, hasPan = false;
var bufW = null, bufP = null, bufC = null;      /* white / pink / crackle */
var voices = [];
var btn = null;

/* hum graph (persistent) */
var humO1 = null, humO2 = null, humO3 = null, humLP = null, humWob = null, humG = null;
var humOn = false, humGain = -1, humFc = -1, humF0 = -1, humDet = -1;

/* self-drive edge trackers */
var lastAtkId = 0, wasLit = false, wasGround = true, prevVy = 0;
var lastHp = -1, wasDead = false, lastStance = -1, lastHitT = -1e9;
var resumeTry = 0;

/* ============================ tiny helpers ============================= */
function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }

function trk(v, n){ if (v.nc < NMAX) v.n[v.nc++] = n; return n; }

/* oscillator: lives `life` s, frequency f0 -> f1 over `ramp` s (exp by default) */
function osc(v, type, t0, life, f0, f1, ramp, lin){
  var o = ctx.createOscillator();
  try { o.type = type; } catch (e) { o.type = 'square'; }
  if (f0 < 1) f0 = 1;
  o.frequency.setValueAtTime(f0, t0);
  if (f1 !== undefined && f1 !== null && f1 !== f0){
    if (f1 < 1) f1 = 1;
    if (lin) o.frequency.linearRampToValueAtTime(f1, t0 + (ramp || life));
    else o.frequency.exponentialRampToValueAtTime(f1, t0 + (ramp || life));
  }
  o.start(t0);
  o.stop(t0 + life + 0.02);
  return trk(v, o);
}

/* looping noise source, random start offset so repeats never phase-lock */
function noz(v, buf, t0, life, rate){
  var s = ctx.createBufferSource();
  s.buffer = buf;
  s.loop = true;
  if (rate && rate !== 1) s.playbackRate.value = rate;
  var off = Math.random() * (buf.duration - 0.02);
  if (off < 0) off = 0;
  s.start(t0, off);
  s.stop(t0 + life + 0.02);
  return trk(v, s);
}

function flt(v, type, t0, ramp, f0, f1, q){
  var f = ctx.createBiquadFilter();
  f.type = type;
  if (q) f.Q.value = q;
  if (f0 < 20) f0 = 20;
  f.frequency.setValueAtTime(f0, t0);
  if (f1 !== undefined && f1 !== null && f1 !== f0){
    if (f1 < 20) f1 = 20;
    f.frequency.exponentialRampToValueAtTime(f1, t0 + ramp);
  }
  return trk(v, f);
}

/* attack / (hold) / exponential decay envelope */
function env(v, t0, peak, a, d, hold){
  var g = ctx.createGain(), p = g.gain;
  if (peak < 0.0004) peak = 0.0004;
  if (a < 0.001) a = 0.001;
  p.setValueAtTime(0.0001, t0);
  p.linearRampToValueAtTime(peak, t0 + a);
  var te = t0 + a;
  if (hold){ te += hold; p.setValueAtTime(peak, te); }
  p.exponentialRampToValueAtTime(0.0001, te + d);
  return trk(v, g);
}

/* ============================ noise buffers ============================ */
function mkWhite(sec){
  var n = Math.floor(ctx.sampleRate * sec) || 1;
  var b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0), i;
  for (i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
function mkPink(sec){                      /* Paul Kellet's economy pink filter */
  var n = Math.floor(ctx.sampleRate * sec) || 1;
  var b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
  var b0 = 0, b1 = 0, b2 = 0, i, w;
  for (i = 0; i < n; i++){
    w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.0990460;
    b1 = 0.96300 * b1 + w * 0.2965164;
    b2 = 0.57000 * b2 + w * 1.0526913;
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.28;
  }
  return b;
}
function mkCrackle(sec){                   /* sparse decaying impulses: electric */
  var n = Math.floor(ctx.sampleRate * sec) || 1;
  var b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
  var i, amp = 0, dec = 0;
  for (i = 0; i < n; i++){
    if (amp < 0.02 && Math.random() < 0.010){       /* strike */
      amp = 0.55 + Math.random() * 0.45;
      dec = 0.9985 - Math.random() * 0.0035;
    }
    d[i] = amp > 0.001 ? (Math.random() * 2 - 1) * amp : 0;
    amp *= dec;
  }
  return b;
}

/* ======================= sound generators (2002 flavour) ==============
 * Each returns its total duration in seconds. `v.out` is the voice output. */

function sSaberOn(v, t0){                  /* rising whoosh + ignition snap */
  noz(v, bufP, t0, 0.42, 1)
    .connect(flt(v, 'bandpass', t0, 0.30, 190, 1600, 1.4))
    .connect(env(v, t0, 0.50, 0.06, 0.40)).connect(v.out);
  osc(v, 'sawtooth', t0, 0.34, 70, 320, 0.28)
    .connect(flt(v, 'lowpass', t0, 0.28, 280, 1500, 2.0))
    .connect(env(v, t0, 0.30, 0.05, 0.36)).connect(v.out);
  var ts = t0 + 0.23;                      /* the SNAP */
  noz(v, bufW, ts, 0.06, 1)
    .connect(flt(v, 'highpass', ts, 0.05, 1200, 1200, 0.8))
    .connect(env(v, ts, 0.45, 0.003, 0.07)).connect(v.out);
  return 0.55;
}

function sSaberOff(v, t0){                 /* falling whoosh, power-down thud */
  noz(v, bufP, t0, 0.40, 1)
    .connect(flt(v, 'bandpass', t0, 0.32, 1500, 190, 1.4))
    .connect(env(v, t0, 0.42, 0.02, 0.40)).connect(v.out);
  osc(v, 'sawtooth', t0, 0.36, 300, 70, 0.30)
    .connect(flt(v, 'lowpass', t0, 0.30, 1400, 220, 2.0))
    .connect(env(v, t0, 0.26, 0.02, 0.34)).connect(v.out);
  osc(v, 'sine', t0 + 0.20, 0.22, 92, 44, 0.20)
    .connect(env(v, t0 + 0.20, 0.30, 0.01, 0.20)).connect(v.out);
  return 0.48;
}

function sSwing(v, t0, r){                 /* doppler whoosh; r = swing speed */
  var d = 0.30 / r;
  var f = flt(v, 'bandpass', t0, d * 0.45, 330 * r, 1500 * r, 2.4);
  f.frequency.exponentialRampToValueAtTime(390 * r, t0 + d);   /* pass-by fall */
  noz(v, bufW, t0, d, 1).connect(f)
    .connect(env(v, t0, 0.52, d * 0.34, d * 0.80)).connect(v.out);
  osc(v, 'sine', t0, d * 0.9, 150 * r, 88 * r, d * 0.9)
    .connect(env(v, t0, 0.13, d * 0.3, d * 0.6)).connect(v.out);
  return d + 0.10;
}

function sClash(v, t0, r){                 /* bright inharmonic metal ring */
  var f1 = 1150 * r, f2 = 1723 * r, f3 = 2490 * r;
  osc(v, 'triangle', t0, 0.38, f1, f1 * 0.94, 0.36)
    .connect(env(v, t0, 0.20, 0.003, 0.36)).connect(v.out);
  osc(v, 'square', t0, 0.28, f2, f2 * 0.95, 0.26)
    .connect(env(v, t0, 0.10, 0.003, 0.26)).connect(v.out);
  osc(v, 'sine', t0, 0.20, f3, f3 * 0.93, 0.18)
    .connect(env(v, t0, 0.09, 0.002, 0.18)).connect(v.out);
  noz(v, bufW, t0, 0.07, 1)                /* strike transient */
    .connect(flt(v, 'highpass', t0, 0.06, 2400, 2400, 0.8))
    .connect(env(v, t0, 0.50, 0.002, 0.07)).connect(v.out);
  return 0.42;
}

function sHit(v, t0){                      /* saber into a body: sizzle + crack */
  noz(v, bufW, t0, 0.20, 1)
    .connect(flt(v, 'lowpass', t0, 0.18, 950, 260, 1.0))
    .connect(env(v, t0, 0.45, 0.004, 0.22)).connect(v.out);
  osc(v, 'sawtooth', t0, 0.22, 330, 90, 0.20)
    .connect(flt(v, 'lowpass', t0, 0.18, 1300, 500, 1.2))
    .connect(env(v, t0, 0.24, 0.005, 0.20)).connect(v.out);
  noz(v, bufC, t0, 0.12, 1.2)
    .connect(flt(v, 'bandpass', t0, 0.10, 1800, 1800, 2.0))
    .connect(env(v, t0, 0.28, 0.002, 0.12)).connect(v.out);
  return 0.32;
}

function sBlaster(v, t0, r){               /* classic pew: fast square dive */
  osc(v, 'square', t0, 0.16, 1500 * r, 165 * r, 0.13)
    .connect(flt(v, 'lowpass', t0, 0.14, 3400, 900, 1.0))
    .connect(env(v, t0, 0.38, 0.003, 0.17)).connect(v.out);
  osc(v, 'square', t0, 0.14, 1490 * r * 1.006, 158 * r, 0.12)
    .connect(env(v, t0, 0.16, 0.004, 0.14)).connect(v.out);
  noz(v, bufW, t0, 0.03, 1)
    .connect(flt(v, 'highpass', t0, 0.02, 2000, 2000, 0.7))
    .connect(env(v, t0, 0.30, 0.001, 0.03)).connect(v.out);
  return 0.24;
}

function sBoltHit(v, t0){                  /* short crackle + scorch thud */
  noz(v, bufC, t0, 0.16, 1)
    .connect(flt(v, 'bandpass', t0, 0.14, 1100, 700, 2.5))
    .connect(env(v, t0, 0.45, 0.002, 0.16)).connect(v.out);
  osc(v, 'sine', t0, 0.20, 125, 48, 0.18)
    .connect(env(v, t0, 0.34, 0.004, 0.20)).connect(v.out);
  noz(v, bufW, t0, 0.09, 1)
    .connect(flt(v, 'highpass', t0, 0.08, 3000, 3000, 0.8))
    .connect(env(v, t0, 0.18, 0.002, 0.09)).connect(v.out);
  return 0.28;
}

function sDeflect(v, t0){                  /* zing: blade kicks the bolt away */
  var o = osc(v, 'square', t0, 0.20, 700, 2800, 0.07);
  o.frequency.exponentialRampToValueAtTime(1300, t0 + 0.18);
  o.connect(flt(v, 'bandpass', t0, 0.12, 1500, 2400, 3.0))
   .connect(env(v, t0, 0.30, 0.004, 0.18)).connect(v.out);
  osc(v, 'triangle', t0, 0.16, 1400, 3600, 0.09)
    .connect(env(v, t0, 0.12, 0.004, 0.14)).connect(v.out);
  noz(v, bufW, t0, 0.04, 1)
    .connect(flt(v, 'highpass', t0, 0.03, 2500, 2500, 0.8))
    .connect(env(v, t0, 0.24, 0.001, 0.04)).connect(v.out);
  return 0.24;
}

function sLightning(v, t0){                /* crackling noise + high electric buzz */
  noz(v, bufC, t0, 0.28, 1.4)
    .connect(flt(v, 'highpass', t0, 0.20, 1400, 1900, 0.9))
    .connect(env(v, t0, 0.42, 0.01, 0.26)).connect(v.out);
  osc(v, 'sawtooth', t0, 0.26, 118, 132, 0.24)
    .connect(flt(v, 'bandpass', t0, 0.24, 1900, 2600, 8.0))
    .connect(env(v, t0, 0.22, 0.02, 0.24)).connect(v.out);
  osc(v, 'square', t0, 0.24, 61, 58, 0.22)
    .connect(flt(v, 'highpass', t0, 0.20, 700, 700, 0.8))
    .connect(env(v, t0, 0.13, 0.02, 0.22)).connect(v.out);
  return 0.34;
}

function sPush(v, t0){                     /* low sub thump with a shove swell */
  osc(v, 'sine', t0, 0.46, 130, 40, 0.32)
    .connect(env(v, t0, 0.60, 0.05, 0.46)).connect(v.out);
  noz(v, bufP, t0, 0.44, 1)
    .connect(flt(v, 'lowpass', t0, 0.36, 900, 150, 1.2))
    .connect(env(v, t0, 0.38, 0.06, 0.42)).connect(v.out);
  noz(v, bufW, t0, 0.16, 1)                /* pre-swell air */
    .connect(flt(v, 'bandpass', t0, 0.13, 320, 1250, 1.6))
    .connect(env(v, t0, 0.16, 0.09, 0.12)).connect(v.out);
  return 0.60;
}

function sPull(v, t0){                     /* inhaled sub: everything rushes in */
  osc(v, 'sine', t0, 0.42, 45, 140, 0.32)
    .connect(env(v, t0, 0.48, 0.07, 0.40)).connect(v.out);
  noz(v, bufP, t0, 0.42, 1)
    .connect(flt(v, 'bandpass', t0, 0.34, 200, 1500, 2.0))
    .connect(env(v, t0, 0.30, 0.24, 0.28)).connect(v.out);
  osc(v, 'sine', t0 + 0.30, 0.24, 95, 55, 0.22)
    .connect(env(v, t0 + 0.30, 0.26, 0.01, 0.22)).connect(v.out);
  return 0.60;
}

function sGrip(v, t0){                     /* tense low drone stab (beating fifths) */
  var g = env(v, t0, 0.34, 0.12, 0.70, 0.06);
  var lp = flt(v, 'lowpass', t0, 0.55, 420, 900, 4.0);
  lp.connect(g).connect(v.out);
  osc(v, 'sawtooth', t0, 0.85, 74, 70, 0.80).connect(lp);
  osc(v, 'sawtooth', t0, 0.85, 78.5, 76, 0.80).connect(lp);
  osc(v, 'triangle', t0, 0.80, 111, 105, 0.75)
    .connect(env(v, t0, 0.12, 0.15, 0.62)).connect(v.out);
  osc(v, 'sine', t0, 0.80, 37, 34, 0.75)
    .connect(env(v, t0, 0.26, 0.08, 0.66)).connect(v.out);
  return 0.92;
}

function sSpeed(v, t0){                    /* airy rise, the world stretches out */
  noz(v, bufP, t0, 0.60, 1)
    .connect(flt(v, 'bandpass', t0, 0.45, 300, 2600, 1.6))
    .connect(env(v, t0, 0.34, 0.12, 0.52)).connect(v.out);
  osc(v, 'sine', t0, 0.58, 300, 900, 0.46)
    .connect(env(v, t0, 0.12, 0.15, 0.46)).connect(v.out);
  osc(v, 'triangle', t0, 0.50, 900, 1800, 0.42)
    .connect(env(v, t0, 0.06, 0.18, 0.34)).connect(v.out);
  return 0.72;
}

function sJump(v, t0){                     /* soft body thud + cloth */
  osc(v, 'sine', t0, 0.18, 170, 95, 0.16)
    .connect(env(v, t0, 0.34, 0.004, 0.16)).connect(v.out);
  noz(v, bufW, t0, 0.10, 1)
    .connect(flt(v, 'bandpass', t0, 0.09, 900, 600, 1.0))
    .connect(env(v, t0, 0.16, 0.01, 0.09)).connect(v.out);
  return 0.22;
}

function sLand(v, t0){                     /* heavier thud into sand */
  osc(v, 'sine', t0, 0.28, 120, 42, 0.24)
    .connect(env(v, t0, 0.50, 0.005, 0.26)).connect(v.out);
  noz(v, bufW, t0, 0.18, 1)
    .connect(flt(v, 'lowpass', t0, 0.16, 1200, 300, 1.0))
    .connect(env(v, t0, 0.28, 0.005, 0.18)).connect(v.out);
  noz(v, bufW, t0, 0.06, 1)                /* grit */
    .connect(flt(v, 'highpass', t0, 0.05, 2200, 2200, 0.8))
    .connect(env(v, t0, 0.11, 0.002, 0.06)).connect(v.out);
  return 0.34;
}

function sHurt(v, t0){                     /* short filtered grunt */
  noz(v, bufW, t0, 0.18, 1)
    .connect(flt(v, 'bandpass', t0, 0.16, 430, 250, 4.5))
    .connect(env(v, t0, 0.50, 0.01, 0.20)).connect(v.out);
  osc(v, 'sawtooth', t0, 0.20, 190, 138, 0.18)
    .connect(flt(v, 'lowpass', t0, 0.16, 750, 480, 1.4))
    .connect(env(v, t0, 0.28, 0.015, 0.18)).connect(v.out);
  return 0.30;
}

function sDie(v, t0){                      /* long descending fall + final thud */
  osc(v, 'sawtooth', t0, 0.86, 300, 70, 0.80)
    .connect(flt(v, 'lowpass', t0, 0.80, 1400, 260, 1.6))
    .connect(env(v, t0, 0.40, 0.03, 0.84)).connect(v.out);
  noz(v, bufP, t0, 0.84, 1)
    .connect(flt(v, 'bandpass', t0, 0.78, 700, 180, 1.2))
    .connect(env(v, t0, 0.24, 0.05, 0.78)).connect(v.out);
  osc(v, 'sine', t0 + 0.74, 0.30, 100, 38, 0.26)
    .connect(env(v, t0 + 0.74, 0.40, 0.01, 0.28)).connect(v.out);
  return 1.06;
}

function sBotDie(v, t0){                   /* electronic power-down + shrapnel */
  osc(v, 'square', t0, 0.58, 880, 70, 0.50)
    .connect(flt(v, 'lowpass', t0, 0.48, 2200, 300, 1.4))
    .connect(env(v, t0, 0.30, 0.005, 0.55)).connect(v.out);
  osc(v, 'square', t0, 0.52, 655, 52, 0.46)
    .connect(env(v, t0, 0.14, 0.008, 0.48)).connect(v.out);
  noz(v, bufC, t0 + 0.04, 0.34, 1.1)
    .connect(flt(v, 'bandpass', t0 + 0.04, 0.30, 1400, 900, 2.0))
    .connect(env(v, t0 + 0.04, 0.38, 0.005, 0.34)).connect(v.out);
  osc(v, 'sine', t0 + 0.40, 0.32, 92, 35, 0.28)
    .connect(env(v, t0 + 0.40, 0.30, 0.01, 0.30)).connect(v.out);
  return 0.80;
}

function sSelect(v, t0){                   /* two-tone UI blip */
  osc(v, 'square', t0, 0.06, 980, 980, 0.05)
    .connect(env(v, t0, 0.26, 0.003, 0.05)).connect(v.out);
  osc(v, 'square', t0 + 0.045, 0.06, 1480, 1480, 0.05)
    .connect(env(v, t0 + 0.045, 0.20, 0.003, 0.05)).connect(v.out);
  return 0.12;
}

function sForceFail(v, t0){                /* dull stuttering buzz — not enough Force */
  var g = ctx.createGain(), p = g.gain;
  p.setValueAtTime(0.0001, t0);
  p.linearRampToValueAtTime(0.30, t0 + 0.012);
  p.setValueAtTime(0.30, t0 + 0.06);
  p.linearRampToValueAtTime(0.10, t0 + 0.085);
  p.linearRampToValueAtTime(0.28, t0 + 0.105);
  p.exponentialRampToValueAtTime(0.0001, t0 + 0.26);
  trk(v, g).connect(v.out);
  osc(v, 'square', t0, 0.26, 118, 92, 0.24)
    .connect(flt(v, 'lowpass', t0, 0.20, 380, 300, 1.0)).connect(g);
  osc(v, 'sine', t0, 0.24, 59, 47, 0.22).connect(g);
  return 0.30;
}

/* ============================ sound table ============================== */
/* vol: authored level. gap: minimum retrigger interval (floods are dropped —
 * this also silently dedupes a sibling module playing what we self-drive).
 * pri: importance when the 16-voice pool has to shed something. */
function D(fn, vol, gap, pri){ return { fn: fn, vol: vol, gap: gap, pri: pri, last: -1e9 }; }
var DEFS = {
  saberOn:   D(sSaberOn,   0.90, 0.30, 1.00),
  saberOff:  D(sSaberOff,  0.85, 0.30, 1.00),
  swing:     D(sSwing,     0.80, 0.06, 0.80),
  clash:     D(sClash,     0.95, 0.05, 0.95),
  hit:       D(sHit,       0.90, 0.05, 0.90),
  blaster:   D(sBlaster,   0.70, 0.03, 0.60),
  boltHit:   D(sBoltHit,   0.70, 0.04, 0.55),
  deflect:   D(sDeflect,   0.95, 0.05, 0.95),
  jump:      D(sJump,      0.55, 0.12, 0.60),
  land:      D(sLand,      0.65, 0.12, 0.60),
  hurt:      D(sHurt,      0.85, 0.14, 0.85),
  die:       D(sDie,       1.00, 0.80, 1.00),
  botDie:    D(sBotDie,    0.85, 0.10, 0.90),
  push:      D(sPush,      0.95, 0.12, 0.95),
  pull:      D(sPull,      0.90, 0.12, 0.95),
  lightning: D(sLightning, 0.75, 0.09, 0.90),
  grip:      D(sGrip,      0.80, 0.35, 0.85),
  speed:     D(sSpeed,     0.75, 0.40, 0.80),
  forceFail: D(sForceFail, 0.70, 0.25, 0.50),
  select:    D(sSelect,    0.55, 0.05, 0.45)
};

/* ============================ voice pool =============================== */
function makeVoices(){
  for (var i = 0; i < MAXV; i++){
    var out = ctx.createGain();
    out.gain.value = 0;
    var pan = null;
    if (hasPan){
      pan = ctx.createStereoPanner();
      out.connect(pan); pan.connect(master);
    } else {
      out.connect(master);              /* graceful fallback: gain only, no pan */
    }
    voices.push({ out: out, pan: pan, busy: false, end: 0, score: 0,
                  n: new Array(NMAX), nc: 0 });
  }
}

function release(v){
  for (var i = 0; i < v.nc; i++){
    var n = v.n[i];
    if (n){
      if (typeof n.stop === 'function'){ try { n.stop(0); } catch (e){} }
      try { n.disconnect(); } catch (e2){}
      v.n[i] = null;
    }
  }
  v.nc = 0; v.busy = false; v.end = 0; v.score = 0;
  try { v.out.gain.cancelScheduledValues(0); } catch (e3){}
  v.out.gain.value = 0;
}

/* free slot, else steal the quietest/soonest-finished voice if we outrank it */
function alloc(score, now){
  var i, v, worst = null, ws = 1e9;
  for (i = 0; i < voices.length; i++){
    v = voices[i];
    if (!v.busy) return v;
    if (v.end <= now){ release(v); return v; }
    var s = v.score * ((v.end - now) < 0.16 ? 0.35 : 1);
    if (s < ws){ ws = s; worst = v; }
  }
  if (worst && score > ws){ release(worst); return worst; }
  return null;                            /* pool full of louder things: drop */
}

/* ========================= positional maths ============================ */
var SPG = 1, SPP = 0;
function spatial(pos){
  SPG = 1; SPP = 0;
  var eye = JK.GL && JK.GL.eye;
  if (!eye || !pos) return;
  var dx = pos[0] - eye[0], dy = pos[1] - eye[1], dz = pos[2] - eye[2];
  var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d >= ROLLOFF){ SPG = 0; return; }
  var fade = 1 - d / ROLLOFF;
  SPG = (REF_D / (REF_D + d)) * fade * fade * 1.25;
  if (SPG > 1) SPG = 1;
  var hl = Math.sqrt(dx * dx + dz * dz);
  if (hl < 0.001) return;
  var cy = (JK.Player && JK.Player.camYaw) || 0;
  /* camera right = fwd x up, fwd = (-sin cy, 0, -cos cy) => right = (cos, 0, -sin) */
  var p = (dx * Math.cos(cy) - dz * Math.sin(cy)) / hl;
  if (d < 2) p *= d * 0.5;                /* don't hard-pan things in your face */
  SPP = clamp(p, -1, 1) * PAN_W;
}

/* ============================== hum ==================================== */
function buildHum(){
  humG = ctx.createGain();   humG.gain.value = 0;
  humWob = ctx.createGain(); humWob.gain.value = 1;
  humLP = ctx.createBiquadFilter();
  humLP.type = 'lowpass'; humLP.frequency.value = 360; humLP.Q.value = 3.5;

  humO1 = ctx.createOscillator(); humO1.type = 'sawtooth'; humO1.frequency.value = 61;
  humO2 = ctx.createOscillator(); humO2.type = 'sawtooth'; humO2.frequency.value = 61;
  humO2.detune.value = 11;
  humO3 = ctx.createOscillator(); humO3.type = 'triangle'; humO3.frequency.value = 122;
  var g3 = ctx.createGain(); g3.gain.value = 0.35;

  humO1.connect(humLP); humO2.connect(humLP); humO3.connect(g3); g3.connect(humLP);
  humLP.connect(humWob); humWob.connect(humG); humG.connect(master);

  /* amplitude wobble rides on humWob so a zero humG is truly silent */
  var lfoA = ctx.createOscillator(); lfoA.type = 'sine'; lfoA.frequency.value = 5.3;
  var lfoAg = ctx.createGain(); lfoAg.gain.value = 0.11;
  lfoA.connect(lfoAg); lfoAg.connect(humWob.gain);
  /* slow filter drift keeps the drone alive */
  var lfoB = ctx.createOscillator(); lfoB.type = 'sine'; lfoB.frequency.value = 0.7;
  var lfoBg = ctx.createGain(); lfoBg.gain.value = 30;
  lfoB.connect(lfoBg); lfoBg.connect(humLP.detune);

  var t = ctx.currentTime;
  humO1.start(t); humO2.start(t); humO3.start(t); lfoA.start(t); lfoB.start(t);
}

function hum(on, intensity){
  if (!ok || !humG) return;
  var i = intensity;
  if (!(i >= 0)) i = 0; else if (i > 2) i = 2;
  humOn = !!on;
  var t = ctx.currentTime;
  var wantG = (humOn && !muted) ? (0.055 + 0.075 * i) : 0;
  var wantF = 320 + 640 * i;
  var wantP = 61 + 10 * i;
  var wantD = 9 + 26 * i;
  if (Math.abs(wantG - humGain) > 0.0035 || (wantG === 0) !== (humGain === 0)){
    humGain = wantG;
    humG.gain.setTargetAtTime(wantG, t, 0.055);
  }
  if (Math.abs(wantF - humFc) > 12){
    humFc = wantF;
    humLP.frequency.setTargetAtTime(wantF, t, 0.05);
  }
  if (Math.abs(wantP - humF0) > 0.4){
    humF0 = wantP;
    humO1.frequency.setTargetAtTime(wantP, t, 0.06);
    humO2.frequency.setTargetAtTime(wantP, t, 0.06);
    humO3.frequency.setTargetAtTime(wantP * 2, t, 0.06);
  }
  if (Math.abs(wantD - humDet) > 1.5){
    humDet = wantD;
    humO2.detune.setTargetAtTime(wantD, t, 0.06);
  }
}

/* ============================== play =================================== */
function play(name, opt){
  if (!ok || muted) return;
  var def = DEFS[name];
  if (!def) return;                        /* unknown name: silent no-op */
  var now = ctx.currentTime;
  if (now - def.last < def.gap) return;    /* flood guard / cross-module dedupe */

  var vol = def.vol, rate = 1, pan = 0;
  if (opt){
    if (opt.vol !== undefined && opt.vol !== null) vol *= opt.vol;
    if (opt.rate) rate = clamp(opt.rate, 0.35, 3);
    if (opt.pos){
      spatial(opt.pos);
      vol *= SPG; pan = SPP;
      if (vol < 0.004) return;             /* out of earshot */
    }
  }
  if (vol <= 0) return;
  if (vol > 1.4) vol = 1.4;

  var v = alloc(vol * def.pri, now);
  if (!v) return;
  def.last = now;
  v.busy = true; v.nc = 0; v.score = vol * def.pri;
  v.out.gain.cancelScheduledValues(now);
  v.out.gain.setValueAtTime(vol, now);
  if (v.pan) v.pan.pan.setValueAtTime(pan, now);

  var t0 = now + LOOKAHEAD, dur;
  try {
    dur = def.fn(v, t0, rate);
  } catch (e){
    release(v);
    return;
  }
  v.end = t0 + (dur || 0.3) + 0.08;
}

function reap(){
  var now = ctx.currentTime;
  for (var i = 0; i < voices.length; i++){
    var v = voices[i];
    if (v.busy && v.end <= now) release(v);
  }
}

/* ============================ mute button ============================== */
var CSS =
'#jkaBtn{position:absolute;z-index:6;width:44px;height:44px;border-radius:50%;' +
'right:calc(12px + env(safe-area-inset-right));top:calc(10px + env(safe-area-inset-top));' +
'border:2px solid rgba(200,210,170,.35);background:rgba(20,26,12,.35);' +
'color:rgba(220,228,190,.85);font:700 9px/40px "Trebuchet MS","Verdana",sans-serif;' +
'text-align:center;letter-spacing:.06em;pointer-events:auto;touch-action:none;' +
'text-shadow:1px 1px 0 #000;-webkit-user-select:none;user-select:none;}' +
'#jkaBtn.dn{transform:scale(.92);background:rgba(160,200,90,.25);' +
'border-color:rgba(200,240,140,.7);}' +
'#jkaBtn.off{color:#e08a6a;border-color:rgba(224,138,106,.45);' +
'background:rgba(42,16,10,.42);}';

function applyMute(){
  if (master){
    var t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setTargetAtTime(muted ? 0 : MASTER_V, t, 0.03);
  }
  if (muted && humG){ humGain = 0; humG.gain.setTargetAtTime(0, ctx.currentTime, 0.05); }
  if (btn){
    btn.textContent = muted ? 'MUTE' : 'SND';
    if (muted) btn.classList.add('off'); else btn.classList.remove('off');
  }
  Audio.muted = muted;
  try { window.localStorage.setItem('jk_mute', muted ? '1' : '0'); } catch (e){}
}

function setMute(m){
  m = !!m;
  if (m === muted){ applyMute(); return; }
  muted = m;
  if (muted) stopAll();
  applyMute();
}

function onDown(e){
  if (e.preventDefault) e.preventDefault();
  if (e.stopPropagation) e.stopPropagation();
  btn.classList.add('dn');
}
function onUp(e){
  if (e.preventDefault) e.preventDefault();
  if (e.stopPropagation) e.stopPropagation();
  btn.classList.remove('dn');
  setMute(!muted);
  if (!muted) play('select');
}
function onCancel(e){
  if (e.stopPropagation) e.stopPropagation();
  btn.classList.remove('dn');
}

function buildDom(){
  if (btn || !document.body) return;
  var st = document.createElement('style');
  st.id = 'jkaCss';
  st.appendChild(document.createTextNode(CSS));
  document.head.appendChild(st);
  btn = document.createElement('div');
  btn.id = 'jkaBtn';
  btn.textContent = 'SND';
  document.body.appendChild(btn);
  btn.addEventListener('touchstart', onDown, { passive: false });
  btn.addEventListener('touchend', onUp, { passive: false });
  btn.addEventListener('touchcancel', onCancel, { passive: false });
  btn.addEventListener('mousedown', function(e){ if (e.button === 0) onDown(e); });
  btn.addEventListener('mouseup', function(e){ if (e.button === 0) onUp(e); });
  btn.addEventListener('mouseleave', onCancel);
  btn.addEventListener('click', function(e){ e.stopPropagation(); e.preventDefault(); });
}

/* ======================= context unlock / lifecycle ==================== */
function tryResume(){
  if (!ctx) return;
  if (ctx.state === 'suspended'){ try { ctx.resume(); } catch (e){} }
}
function unlock(){
  tryResume();
  if (!ctx || ctx.state === 'running'){
    document.removeEventListener('touchend', unlock, true);
    document.removeEventListener('mousedown', unlock, true);
  }
}
function onVis(){
  if (!ctx) return;
  if (document.hidden){ try { ctx.suspend(); } catch (e){} }
  else tryResume();
}

function stopAll(){
  if (!ok) return;
  for (var i = 0; i < voices.length; i++) if (voices[i].busy) release(voices[i]);
  if (humG){ humGain = 0; humG.gain.setTargetAtTime(0, ctx.currentTime, 0.03); }
  humOn = false;
}

/* ============================== module ================================= */
var Audio = JK.Audio = {
  enabled: false,
  muted: false,
  ctx: null,
  play: play,
  hum: hum,
  setMute: setMute,
  toggle: function(){ setMute(!muted); },
  stopAll: stopAll,

  init: function(){
    if (ok) return;
    try { muted = window.localStorage.getItem('jk_mute') === '1'; } catch (e){}
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;                       /* no WebAudio: whole module no-ops */
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : MASTER_V;
      try {                                /* glue + clip guard, optional */
        comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 7;
        comp.attack.value = 0.004; comp.release.value = 0.20;
        master.connect(comp); comp.connect(ctx.destination);
      } catch (e2){
        master.connect(ctx.destination);
      }
      hasPan = typeof ctx.createStereoPanner === 'function';
      bufW = mkWhite(1.0);
      bufP = mkPink(1.5);
      bufC = mkCrackle(0.9);
      makeVoices();
      buildHum();
      /* iOS: a one-sample silent source inside the gesture finishes the unlock */
      try {
        var s = ctx.createBufferSource();
        s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        s.connect(ctx.destination);
        s.start(0);
      } catch (e3){}
      tryResume();
    } catch (err){
      ok = false; ctx = null;
      return;
    }
    ok = true;
    Audio.enabled = true;
    Audio.ctx = ctx;
    buildDom();
    applyMute();
    document.addEventListener('touchend', unlock, true);
    document.addEventListener('mousedown', unlock, true);
    document.addEventListener('visibilitychange', onVis);
    /* prime the edge trackers so boot doesn't fire a burst of stale events */
    var P = JK.Player;
    lastStance = P ? (P.stanceIdx | 0) : 1;
    wasGround = P ? !!P.onGround : true;
    prevVy = 0;
    lastHp = (JK.game && JK.game.hp) || -1;
    wasDead = !!(JK.Hero && JK.Hero.dead);
    lastAtkId = (JK.Sabers && JK.Sabers.attackId) || 0;
    lastHitT = (JK.Combat && JK.Combat.lastHit) ? JK.Combat.lastHit.t : -1e9;
    wasLit = false;                        /* => first frame ignites the saber */
  },

  /* Reads sibling state and fires the sounds the frozen modules never ask for.
   * Every read is feature-detected; every write is a play()/hum() call. */
  update: function(dt, t){
    if (!ok) return;
    if (ctx.state === 'suspended' && !document.hidden){
      resumeTry -= dt;
      if (resumeTry <= 0){ resumeTry = 1.0; tryResume(); }
    }
    reap();
    if (muted) return;

    var P = JK.Player, R = JK.Rig, rp = R && R.player;
    var G = JK.game, S = JK.Sabers, C = JK.Combat, H = JK.Hero;
    var i;

    /* ---- saber ignite / extinguish + the persistent hum ---- */
    var lit = rp ? !!rp.saberOn : false;
    if (lit !== wasLit){
      wasLit = lit;
      play(lit ? 'saberOn' : 'saberOff');
    }
    if (lit){
      var inten = 0.10 + Math.min(1, ((P && P.speed2D) || 0) / 9) * 0.34;
      var ph = (rp && rp.swingPhase) ? rp.swingPhase() : -1;
      if (ph >= 0) inten += Math.sin(Math.PI * ph) * 0.95;
      hum(true, inten);
    } else {
      hum(false, 0);
    }

    /* ---- swing whoosh, pitched by stance (LIGHT fast, STRONG heavy) ---- */
    if (S && typeof S.attackId === 'number' && S.attackId !== lastAtkId){
      lastAtkId = S.attackId;
      if (lastAtkId > 0){
        var si = P ? (P.stanceIdx | 0) : 1;
        var rate = si === 0 ? 1.30 : (si === 2 ? 0.72 : 1.0);
        play('swing', { rate: rate });
      }
    }

    /* ---- saber connecting with something ---- */
    if (C && C.lastHit && C.lastHit.t !== lastHitT){
      lastHitT = C.lastHit.t;
      play('hit', C.hitPos ? { pos: C.hitPos } : null);
    }

    /* ---- jump / land ---- */
    if (P){
      if (P.jumped) play('jump');
      var g = !!P.onGround;
      if (g && !wasGround){
        var iv = prevVy < 0 ? -prevVy : 0;
        play('land', { vol: clamp(0.25 + iv / 12, 0.25, 1) });
      }
      wasGround = g;
      prevVy = P.vel ? P.vel[1] : 0;

      var sc = P.stanceIdx | 0;
      if (sc !== lastStance){ lastStance = sc; play('select', { vol: 0.75 }); }
    }

    /* ---- hurt / die (Hero owns hp; it never calls us) ---- */
    if (G){
      if (lastHp < 0) lastHp = G.hp;
      if (G.hp < lastHp - 0.75) play('hurt', { vol: clamp(0.5 + (lastHp - G.hp) / 40, 0.5, 1) });
      lastHp = G.hp;
    }
    if (H){
      var dead = !!H.dead;
      if (dead && !wasDead) play('die');
      wasDead = dead;
    }
  }
};
})();
