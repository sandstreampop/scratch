// Audio-to-event latency.
//
// This suite answers one question in seven places: when the simulation decides
// something happened, WHEN does the sound for it start? Not "is a sound played"
// — that is what a coverage test asks and it is already green — but how far the
// onset of the sound sits from the event that caused it, on both clocks that
// exist in this program.
//
// THERE ARE TWO CLOCKS AND THEY ARE NOT THE SAME CLOCK. `g.elapsed` is the
// simulated clock, advanced by exactly dt per driven tick. `ctx.currentTime` is
// the AudioContext clock, advanced by the audio device in real time and
// quantised to 128-sample render blocks. Every timestamp below says which one it
// is on, because the interesting failures are precisely the ones where a
// quantity is correct on one clock and wrong on the other: a sound scheduled
// "immediately" is on time in simulated time and still arrives 42 ms late out of
// the speakers, and a sound whose distance delay was forgotten is on time on
// both clocks and still physically wrong.
//
// WHY THE SUITE MEASURES THE SCHEDULED ONSET AND NOT THE CALL SITE. Calling
// audio.gunshot() is not the same as a gunshot being heard: audio.js builds a
// node graph and writes an envelope with setValueAtTime(v, T), and T is the real
// onset. A test that only recorded when the *method* was called would report
// zero latency for both the correct impact() (which delays by distance/343) and
// the broken gunshot() (which does not), because both are called at the same
// instant. So this file installs a recorder on AudioParam.prototype and reads
// the minimum scheduled time out of every audio call — that number is the sound
// as the listener receives it, and it is the only number that can tell those two
// functions apart.
//
// WHAT IT FOUND, in one place, because the rest of the file is the evidence:
//   - THE BRIEF FOR THIS SUITE WAS WRONG ABOUT DISTANT GUNFIRE. It stated that
//     gunshot(distance) "uses distance only for level and filtering, so an
//     enemy's report at 80 m arrives instantly", and that the check for it must
//     fail. It does not fail. src/audio.js line ~105 computes
//     `const delay = distance / 343` and schedules every element at T = t +
//     delay; measured onset lead is 233.24 ms at 80 m against 233.24 ms
//     required, on an unmodified working tree (git diff on audio.js is empty).
//     No failure was manufactured to match the brief. Instead the checks are
//     backed by a NEGATIVE CONTROL that rebuilds the broken gunshot the brief
//     described and requires the same assertions to reject it, so their green is
//     evidence rather than an untested silence.
//   - WHAT IS BROKEN AT DISTANCE INSTEAD: the delay is applied to the envelope
//     and not to the source lifetimes. noise() stops each buffer source at
//     ctx.currentTime + duration + 0.05, computed from NOW rather than from the
//     delayed onset, so past 343 * 0.11 = 38 m the crack element's envelope is
//     written after the source carrying it has been stopped, and past ~120 m the
//     body goes the same way. A distant report loses its transient, which is the
//     part that makes it locatable. Same defect in impact(): beyond ~93 m the
//     single source is stopped before the envelope starts and the impact is
//     entirely silent, inside SPEC.range of 220 m.
//   - nothing is scheduled with any lead at all, not even the 128-sample render
//     quantum, so every attack transient starts in the audio thread's past.
//   - the magazine-seat click plays ~190 ms (tactical) / ~240 ms (empty) after
//     the magazine visually seats, past the ITU-R BT.1359-1 detectability
//     threshold for audio lagging video.
//   - the reload track documents a bolt-release phase and audio.js defines a
//     'bolt' sound, and nothing ever plays it.
//
// A NOTE ON WHAT IS THE GAME AND WHAT IS THE MACHINE. sampleRate, baseLatency
// and outputLatency are properties of the device and the browser, not of this
// codebase, and a check on them fails on a laptop and passes on a workstation.
// They are measured and reported because they set the floor every other number
// in this file sits on top of, and the checks that assert on them say in their
// detail string that they are environmental. The checks that a critic should be
// able to move by perturbing the game are the ones about leads, counts, phases
// and ordering.

const DT = 1 / 240;      // four samples inside the 79 ms shot interval
const DT_RELOAD = 1 / 240; // 2.18 s of reload is 523 ticks; 4 ms on a 2180 ms phase is 0.2%
const SOS = 343;         // only used to FORM an expectation; asserted against targets.mjs below

export const NAME = 'audio';

/* ------------------------------------------------------------- targets -- */
//
// Defensive because targets.mjs is owned by a separate research workflow. The
// rule this file follows: when a sourced target exists, assert against it and
// print the source; when it does not, still measure the quantity and print the
// number with the gap named. No Call of Duty figure is invented here — and note
// that most of the audio domain is explicitly non-CoD general engineering
// literature, which the detail strings repeat rather than quietly launder.

let TARGETS = null, inside = null, describe = null;
try { ({ TARGETS, inside, describe } = await import('./targets.mjs')); } catch { /* not written yet */ }

/** Raw target record, or null. Never falls back to a number of our own. */
function T(key) { return TARGETS?.audio?.[key] ?? null; }

/** Source line for a detail string, or an explicit statement that there is none. */
function src(key) {
  const t = T(key);
  if (!t) return 'NO SOURCED TARGET for this quantity';
  if (describe) return describe('audio', key);
  return `${t.title} — ${t.source}`;
}

/**
 * Bracket check against a target whose tolerance is a real bracket (a band or a
 * +/-). Used for speed of sound, baseLatency, outputLatency.
 */
function bracket(report, name, key, measured, unit = ' s') {
  const t = T(key);
  if (!t || !inside) {
    report.check(name, true, `measured ${fx(measured)}${unit} — no sourced target yet`);
    return null;
  }
  const v = inside('audio', key, measured);
  report.check(name, v.ok,
    `measured ${fx(measured)}${unit}, target ${t.value === null ? `band ${t.tol.min}..${t.tol.max}` : t.value}`
    + `${t.value === null ? '' : ` ${tolStr(t.tol)}`}${v.reason ? ` (${v.reason})` : ''} — ${src(key)}`);
  return v.ok;
}

function tolStr(tol) {
  if (!tol) return '(no tolerance)';
  if (tol.min !== undefined) return `[${tol.min}..${tol.max}]`;
  if (tol.abs !== undefined) return `+/-${tol.abs}`;
  return `+/-${(tol.pct * 100).toFixed(0)}%`;
}

/**
 * One-sided bound check. The perceptual targets (20 ms imperceptible, 40 ms
 * ceiling, 125 ms A/V detectability) are THRESHOLDS, not brackets: a measured
 * 5 ms is excellent and would fail inside(), which brackets 0.020 +/-0.005.
 * Calling inside() on them would have inverted the meaning of four checks, so
 * they go through here and the bound is read off the target's value.
 */
function under(report, name, key, measured, unit = ' s') {
  const t = T(key);
  if (!t || typeof t.value !== 'number') {
    report.check(name, true, `measured ${fx(measured)}${unit} — no sourced numeric bound available`);
    return null;
  }
  const ok = measured <= t.value;
  report.check(name, ok,
    `measured ${fx(measured)}${unit} against a ${fx(t.value)}${unit} bound `
    + `(${((measured / t.value - 1) * 100).toFixed(1)}% ${measured > t.value ? 'over' : 'under'}) — ${src(key)}`);
  return ok;
}

/* ------------------------------------------------------------ plumbing -- */

const BASE_INPUT = {
  forward: false, back: false, left: false, right: false,
  sprint: false, crouch: false, ads: false, fire: false,
};
// sim.drive Object.assign's the patch onto g.input, so an omitted key keeps its
// previous value. Every input in this file names every key.
const IN = (over = {}) => `return ${JSON.stringify({ ...BASE_INPUT, ...over })};`;

const ms = (v) => (Number.isFinite(v) ? `${(v * 1000).toFixed(2)} ms` : 'n/a');
const fx = (v) => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')) : 'n/a');

/** Least-squares slope of y on x, through the data (not forced through zero). */
function slope(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den === 0 ? NaN : num / den;
}

/* ---------------------------------------------------------- the recorder -- */
//
// Installed once per boot, on top of whatever sim.tapEvents() already wrapped.
// Two layers:
//
//   AudioParam.prototype.setValueAtTime is patched to push its `time` argument
//   into a scratch list. Every element of every sound in audio.js opens with
//   setValueAtTime(near-zero, T) — that is the house style for an exponential
//   attack, because exponentialRampToValueAtTime cannot start from 0 — so the
//   MINIMUM recorded time across one call is that sound's onset. Ramps are
//   deliberately NOT recorded: their times are all later than the onset and
//   including them would only add noise to a min().
//
//   AudioScheduledSourceNode.prototype.stop is patched the same way, because a
//   scheduled onset means nothing if the source feeding it has already been
//   stopped. That is a real state in this codebase (see the impact() sweep) and
//   without the stop times the suite would report a correct delay for a sound
//   that is silent.
//
// Then each audio.* method is wrapped to snapshot the scratch lists around the
// call. The wrapper is marked __tapped so a later sim.tapEvents() will not wrap
// it a second time and double-count every event.
const INSTALL = () => {
  const g = window.__GAME;
  if (window.__AUD) return { installed: false, reason: 'already installed' };

  const scratch = { times: [], stops: [] };

  const AP = window.AudioParam?.prototype;
  if (!AP) return { installed: false, reason: 'no AudioParam in this browser' };
  if (!AP.setValueAtTime.__rec) {
    const orig = AP.setValueAtTime;
    const rec = function (value, time) { scratch.times.push(time); return orig.call(this, value, time); };
    rec.__rec = true;
    AP.setValueAtTime = rec;
  }

  // AudioScheduledSourceNode is where stop() lives in Chrome; the two concrete
  // subclasses are patched as a fallback so a browser that only exposes them
  // still reports source lifetimes rather than silently reporting none.
  const stopTargets = window.AudioScheduledSourceNode
    ? [window.AudioScheduledSourceNode.prototype]
    : [window.AudioBufferSourceNode?.prototype, window.OscillatorNode?.prototype].filter(Boolean);
  for (const proto of stopTargets) {
    if (!proto.stop || proto.stop.__rec) continue;
    const orig = proto.stop;
    const rec = function (when) { scratch.stops.push(when === undefined ? 0 : when); return orig.call(this, when); };
    rec.__rec = true;
    proto.stop = rec;
  }

  const calls = [];
  const NAMES = ['gunshot', 'impact', 'hitmarker', 'mechanical', 'hurt', 'snap', 'footstep'];
  for (const name of NAMES) {
    const orig = g.audio[name];
    if (typeof orig !== 'function') continue;
    const w = function (...args) {
      scratch.times.length = 0;
      scratch.stops.length = 0;
      const ctxBefore = g.audio.ctx ? g.audio.ctx.currentTime : null;
      const r = orig.apply(this, args);
      const ctxAfter = g.audio.ctx ? g.audio.ctx.currentTime : null;
      const times = scratch.times.slice(), stops = scratch.stops.slice();
      calls.push({
        name,
        args: args.map((a) => (typeof a === 'number' || typeof a === 'string' ? a : null)),
        sim: g.elapsed,
        ctxBefore, ctxAfter,
        onset: times.length ? Math.min(...times) : null,
        lastScheduled: times.length ? Math.max(...times) : null,
        nScheduled: times.length,
        firstStop: stops.length ? Math.min(...stops) : null,
        stops: stops.slice().sort((x, y) => x - y),
        nSources: stops.length,
      });
      return r;
    };
    w.__tapped = true; // keep sim.tapEvents() from wrapping this a second time
    g.audio[name] = w;
  }

  /**
   * NEGATIVE CONTROL for the propagation-delay checks.
   *
   * The brief for this suite asserted that gunshot(distance) ignored distance
   * for timing and that the distance check "must fail today". It does not: the
   * function computes `const delay = distance / 343` and adds it to T, on an
   * unmodified src/audio.js (git diff is empty), so the claim was simply wrong.
   * That leaves a real problem — a green check whose ability to go red has never
   * been demonstrated is exactly the silence this project has been burned by.
   *
   * So this builds the sound the brief DESCRIBED: the same three-element gunshot
   * envelope, scheduled at ctx.currentTime with the distance argument used for
   * level only, which is what a regression would look like. The suite runs the
   * identical slope and per-distance maths over it and requires every one of
   * those assertions to come out FALSE. If the control ever passes, the
   * distance checks are decorative and their green means nothing.
   */
  const noDelay = (distance) => {
    const ctx = g.audio.ctx;
    scratch.times.length = 0;
    scratch.stops.length = 0;
    const ctxBefore = ctx.currentTime;
    const T = ctxBefore; // the regression: distance never reaches the schedule
    const atten = 1 / (1 + distance * distance * 0.006);
    for (const [dur, peak] of [[0.06, 0.55], [0.30, 0.6], [0.9, 0.22]]) {
      const src2 = ctx.createBufferSource();
      src2.buffer = g.audio.noiseBuffer;
      src2.loop = true;
      const gn = ctx.createGain();
      gn.gain.value = 0;
      gn.gain.setValueAtTime(0.0001, T);
      gn.gain.exponentialRampToValueAtTime(Math.max(1e-4, peak * atten), T + 0.004);
      src2.connect(gn);
      gn.connect(g.audio.master);
      src2.start();
      src2.stop(ctxBefore + dur + 0.05);
    }
    const ctxAfter = ctx.currentTime;
    const times = scratch.times.slice(), stops = scratch.stops.slice();
    return {
      name: 'gunshot:no-delay-control', args: [distance], sim: g.elapsed, ctxBefore, ctxAfter,
      onset: times.length ? Math.min(...times) : null,
      nScheduled: times.length,
      firstStop: stops.length ? Math.min(...stops) : null,
      stops: stops.slice().sort((x, y) => x - y),
      nSources: stops.length,
      retries: 0,
    };
  };

  window.__AUD = {
    calls,
    reset() { calls.length = 0; },
    /** Retried on the same stability rule as probe(); see probe(). */
    control(distance, tries = 8) {
      let rec = null;
      for (let k = 0; k < tries; k++) {
        rec = noDelay(distance);
        rec.retries = k;
        if (rec.ctxBefore === rec.ctxAfter) return rec;
      }
      return rec;
    },
    info() {
      const c = g.audio.ctx;
      return {
        ready: !!g.audio.ready, enabled: !!g.audio.enabled, haveCtx: !!c,
        state: c ? c.state : null,
        sampleRate: c ? c.sampleRate : null,
        baseLatency: c ? c.baseLatency : null,
        outputLatency: c ? c.outputLatency : null,
        currentTime: c ? c.currentTime : null,
      };
    },
    /**
     * Calls one audio method directly and returns just that call's record.
     *
     * Retried until ctx.currentTime did not advance across the call. The lead
     * this suite reports is onset - (currentTime read by the wrapper), while
     * audio.js reads currentTime again a few microseconds later; if a 128-frame
     * render-quantum boundary falls in that gap the two reads differ and the
     * lead is out by ~2.7 ms. Requiring ctxBefore === ctxAfter proves no
     * boundary was crossed, which makes the sweep exact instead of exact-most-
     * of-the-time. The extra discarded calls are inaudible (--mute-audio) and
     * cost a handful of nodes.
     */
    probe(name, args, tries = 8) {
      let rec = null;
      for (let k = 0; k < tries; k++) {
        const n = calls.length;
        g.audio[name](...args);
        rec = calls.length > n ? calls[calls.length - 1] : null;
        if (!rec) return null;
        rec.retries = k;
        if (rec.ctxBefore === rec.ctxAfter) return rec;
      }
      return rec;
    },
  };
  return { installed: true, wrapped: NAMES.length };
};

/* ================================================================ suite == */

export default async function run(sim, report) {
  // audio:true is not optional. The AudioContext is only constructed inside
  // Audio.init(), which the shipping game calls from a user gesture; without it
  // ready is false, every audio method returns on its first line, and every
  // timestamp in this file comes back null. The suite would then pass every
  // check by measuring nothing, which is the exact failure mode this project
  // has already been burned by, so the first two checks below exist to make
  // that state loud instead of silent.
  const spawn0 = await sim.setup({ audio: true, invulnerable: true, ammo: 30 });
  await sim.tapEvents();
  const install = await sim.eval(INSTALL);
  const info = await sim.eval(() => window.__AUD.info());

  report.check('AudioContext exists and the audio path is live', !!(info.haveCtx && info.ready && info.enabled),
    `haveCtx=${info.haveCtx} ready=${info.ready} enabled=${info.enabled} state=${info.state}, `
    + `ctx.currentTime ${fx(info.currentTime)} s at t=${fx(spawn0.t)} s sim `
    + `(recorder ${install.installed ? `installed over ${install.wrapped} methods` : `NOT installed: ${install.reason}`})`);

  // The instrument's own liveness check. If the recorder cannot see a scheduled
  // envelope on a sound we KNOW schedules one, every lead in this file would
  // read as null and the failure would look like "the game does nothing".
  const alive = await sim.eval(() => window.__AUD.probe('hitmarker', [false]));
  report.check('the onset recorder observes scheduled envelopes at all',
    !!alive && alive.nScheduled >= 2 && Number.isFinite(alive.onset),
    alive
      ? `hitmarker(false) scheduled ${alive.nScheduled} AudioParam events, earliest at `
        + `${fx(alive.onset)} s vs ctx.currentTime ${fx(alive.ctxBefore)} s`
      : 'probe returned nothing — the recorder is not wired and every latency below would be null');

  /* ------------------------------------------------- 1. the output path -- */
  //
  // ENVIRONMENTAL, not a property of this codebase. Reported because it is the
  // floor: the game cannot deliver a sound sooner than baseLatency +
  // outputLatency after it schedules one, whatever it does, so every latency
  // budget below is really this number plus the engine's contribution.
  const total = (info.baseLatency ?? NaN) + (info.outputLatency ?? NaN);
  const quantum = info.sampleRate ? 128 / info.sampleRate : NaN;

  report.check('AudioContext sample rate reported', Number.isFinite(info.sampleRate),
    `sampleRate ${info.sampleRate} Hz, so the Web Audio render quantum of 128 frames is `
    + `${ms(quantum)} — the quantisation floor on every scheduled onset in this file. ${src('web_audio_render_quantum')}`);

  bracket(report, 'baseLatency is at the render-quantum floor (128/sampleRate)',
    'web_audio_baselatency_interactive', info.baseLatency);
  report.check('baseLatency is at least one render quantum',
    info.baseLatency >= quantum - 1e-9,
    `baseLatency ${ms(info.baseLatency)} vs one 128-frame quantum ${ms(quantum)} — `
    + `${(info.baseLatency / quantum).toFixed(2)} quanta. audio.js constructs the AudioContext with `
    + 'no latencyHint, so this is whatever the platform default is rather than "interactive"');

  bracket(report, 'outputLatency is inside the wired-output band',
    'web_audio_outputlatency_wired', info.outputLatency);

  report.check('unavoidable output latency measured',
    Number.isFinite(total),
    `baseLatency ${ms(info.baseLatency)} + outputLatency ${ms(info.outputLatency)} = ${ms(total)} `
    + 'of latency the engine cannot remove — every sound below arrives this late at the ear '
    + 'even when its scheduled onset is exact');
  under(report, 'unavoidable output latency inside the imperceptible tier',
    'competitive_audio_latency_target', total);
  under(report, 'unavoidable output latency under the hard ceiling',
    'competitive_audio_latency_ceiling', total);

  /* --------------------------------------------- 2. the player's gunshot -- */
  //
  // Two clocks, two numbers, and the trap named in the harness comments.
  // playerShoot() calls weapon.fire() on EVERY tick the trigger is held and
  // most calls are rejected by the rate limiter, so `weapon.fire` events count
  // trigger polls. A round is an ammo decrement, and weapon.lastShot is the
  // simulated timestamp the game itself stamps when one leaves — that is the
  // "round left the gun" instant, and it is compared against the onset of the
  // sound scheduled for it.
  await sim.setup({ audio: true, invulnerable: true, ammo: 30 });
  await sim.tapEvents();
  await sim.eval(() => window.__AUD.reset());

  const preFire = await sim.snapshot();
  const burst = await sim.drive({
    seconds: 3.0, dt: DT, input: IN({ fire: true }),
    sample: 'return { lastShot: g.weapon.lastShot };',
  });
  const shotCalls = (await sim.eval(() => window.__AUD.calls.slice())).filter((c) => c.name === 'gunshot');
  const evs = await sim.events();

  // Rounds, two independent ways, so a disagreement is visible rather than
  // averaged: ammo decrements in the trace, and distinct values of lastShot.
  const decrements = [];
  let prevAmmo = preFire.ammo;
  for (const row of burst) { if (row.ammo < prevAmmo) decrements.push(row); prevAmmo = row.ammo; }
  const lastShots = [...new Set(burst.map((r) => r.lastShot))].filter((v) => v > preFire.t - 1).sort((a, b) => a - b);
  const firePolls = evs.filter((e) => e.kind === 'weapon.fire').length;

  report.check('rounds counted two independent ways agree',
    decrements.length === lastShots.length && decrements.length === 30,
    `${decrements.length} ammo decrements, ${lastShots.length} distinct weapon.lastShot stamps, `
    + `${firePolls} weapon.fire CALLS over 3.0 s — the fire-call count is ${(firePolls / Math.max(1, decrements.length)).toFixed(1)}x `
    + 'the round count, which is why fire events are not rounds');

  // ONE SHOT, ONE GUNSHOT. The whole point of comparing counts rather than
  // eyeballing a waveform: a double-trigger would show as 60 gunshots for 30
  // rounds and nothing else in the suite would notice.
  report.check('one round produces exactly one gunshot across a sustained burst',
    shotCalls.length === decrements.length && decrements.length > 0,
    `${decrements.length} rounds fired, ${shotCalls.length} audio.gunshot calls `
    + `(${shotCalls.length - decrements.length} extra), all with distance argument `
    + `${[...new Set(shotCalls.map((c) => c.args[0]))].join('/')}`);

  // No two gunshots in one tick, which is the shape a double-trigger takes when
  // the counts happen to come out even.
  const perTick = new Map();
  for (const c of shotCalls) perTick.set(c.sim, (perTick.get(c.sim) ?? 0) + 1);
  const worstTick = Math.max(0, ...perTick.values());
  const gaps = shotCalls.slice(1).map((c, i) => c.sim - shotCalls[i].sim);
  report.check('no simulated tick carries two gunshots',
    worstTick <= 1,
    `worst tick carried ${worstTick} gunshot(s); min gap between consecutive gunshots `
    + `${ms(Math.min(...gaps))}, median ${ms(gaps.slice().sort((a, b) => a - b)[gaps.length >> 1])} `
    + `over ${gaps.length} intervals`);

  // Round -> scheduling latency, on both clocks. The two events happen in the
  // same synchronous playerShoot() body, so simulated latency is structurally
  // zero and the AudioContext delta is whatever the audio thread advanced by
  // while the JS ran — which is the number that would grow if scheduling ever
  // moved to a deferred queue.
  const perRound = [];
  for (const t of lastShots) {
    const fireEv = evs.find((e) => e.kind === 'weapon.fire' && e.sim === t && e.audio !== null);
    const shot = shotCalls.find((c) => c.sim === t);
    if (!fireEv || !shot) continue;
    perRound.push({ t, dSim: shot.sim - t, dAudio: shot.ctxBefore - fireEv.audio, lead: shot.onset - shot.ctxBefore });
  }
  const maxSim = Math.max(...perRound.map((r) => Math.abs(r.dSim)));
  const maxAud = Math.max(...perRound.map((r) => Math.abs(r.dAudio)));
  report.check('gunshot is scheduled on the same simulated tick the round leaves',
    perRound.length === decrements.length && maxSim === 0,
    `${perRound.length}/${decrements.length} rounds matched to a gunshot; worst simulated gap `
    + `${ms(maxSim)} (zero by construction — fire() and gunshot() are in one synchronous body)`);
  report.check('gunshot scheduling costs nothing on the AudioContext clock',
    Number.isFinite(maxAud) && maxAud < 0.005,
    `worst ctx.currentTime advance between weapon.fire and audio.gunshot ${ms(maxAud)} over `
    + `${perRound.length} rounds, median ${ms(perRound.map((r) => r.dAudio).sort((a, b) => a - b)[perRound.length >> 1])}`);

  // Trigger press -> round. One tick, and that tick is the engine's entire
  // input-to-sound contribution, so the end-to-end figure is it plus the output
  // path measured in section 1.
  const press = preFire.t;
  const inputToRound = lastShots.length ? lastShots[0] - press : NaN;
  const endToEnd = inputToRound + total;
  report.check('trigger press to round is one simulated tick',
    Math.abs(inputToRound - DT) < 1e-9,
    `${ms(inputToRound)} at dt=${ms(DT)} — the round leaves on the first tick after the trigger goes down`);
  under(report, 'end-to-end trigger-to-sound inside the imperceptible tier',
    'competitive_audio_latency_target', endToEnd);
  under(report, 'end-to-end trigger-to-sound under the hard ceiling',
    'competitive_audio_latency_ceiling', endToEnd);
  report.check('engine-added scheduling lead measured',
    Number.isFinite(perRound[0]?.lead),
    `the player gunshot envelope is scheduled ${ms(perRound[0].lead)} ahead of ctx.currentTime `
    + `(max over the burst ${ms(Math.max(...perRound.map((r) => r.lead)))}) — audio.js writes T = ctx.currentTime, `
    + 'so the engine adds no lead of its own and the whole budget is the output path');

  // A zero lead is not free. The audio thread has already rendered up to
  // currentTime, so an envelope whose first setValueAtTime lands at exactly
  // currentTime starts in the past and is clamped to the next block boundary.
  // The gunshot crack's attack is 1.2 ms, which is under half a render quantum,
  // so the transient this game is proudest of is the part being quantised away.
  report.check('gunshot envelope is scheduled at least one render quantum ahead',
    perRound.every((r) => r.lead >= quantum - 1e-9),
    `lead ${ms(perRound[0].lead)} vs the 128-frame quantum ${ms(quantum)}: the 1.2 ms crack attack `
    + `is ${(0.0012 / quantum).toFixed(2)} quanta long and its start time is in the audio thread's past. `
    + src('web_audio_render_quantum'));

  /* ---------------------------------------- 3. impact() vs speed of sound -- */
  //
  // The control case. impact() computes ctx.currentTime + distance/343, so if
  // the recorder cannot see a slope here it is the recorder that is broken, not
  // the game — which is what makes section 4's flat line evidence instead of an
  // artefact. 'stone' is used throughout because it builds exactly one source,
  // so onset and source lifetime are unambiguous; 'metal' adds a ringing
  // oscillator and would make firstStop mean two different things.
  const DISTS = [0, 5, 10, 20, 40, 80, 120, 171.5, 220];
  const impacts = [];
  for (const d of DISTS) {
    // eslint-disable-next-line no-await-in-loop
    impacts.push({ d, ...(await sim.eval((dd) => window.__AUD.probe('impact', ['stone', dd]), d)) });
  }
  const impLead = impacts.map((r) => r.onset - r.ctxBefore);
  const impSlope = slope(impacts.map((r) => r.d), impLead);
  const impSpeed = 1 / impSlope;

  report.check('impact() delay grows with distance',
    impLead[impLead.length - 1] > impLead[0] + 0.1,
    `lead ${DISTS.map((d, i) => `${d}m:${(impLead[i] * 1000).toFixed(1)}`).join(' ')} ms `
    + `over ${DISTS.length} distances`);
  bracket(report, 'impact() implied speed of sound', 'speed_of_sound_air', impSpeed, ' m/s');
  const impErr = Math.max(...impacts.map((r, i) => Math.abs(impLead[i] - r.d / SOS)));
  // Tolerance is one render quantum, not zero: the lead is a difference between
  // two reads of ctx.currentTime a few microseconds apart, and probe() retries
  // until they agree, but a residual of a quantum is instrument noise rather
  // than a game defect. The signal being separated from noise here is 0 vs
  // 233 ms, so 3 ms of slack costs nothing.
  report.check('every impact distance matches distance/343 individually',
    impErr < Math.max(0.003, quantum),
    `worst residual against distance/${SOS} across ${DISTS.length} distances ${ms(impErr)} `
    + `(tolerance one ${ms(quantum)} render quantum); 80 m expected ${ms(80 / SOS)} measured `
    + `${ms(impLead[DISTS.indexOf(80)])}; probe retries ${impacts.map((r) => r.retries).join('')}`);

  // The bug the delay hides. noise() stops its buffer source at
  // ctx.currentTime + duration + 0.05 — computed from NOW, not from the delayed
  // onset T — so past a certain distance the entire envelope is written after
  // the source has already been stopped and the impact is silent. The cutoff is
  // measured rather than derived, because 'stone' duration is a constant and
  // constants lie.
  const dead = impacts.filter((r) => r.firstStop !== null && r.onset >= r.firstStop);
  const live = impacts.filter((r) => r.firstStop !== null && r.onset < r.firstStop);
  const cutoff = dead.length ? `${live.length ? live[live.length - 1].d : 0}..${dead[0].d} m` : `beyond ${DISTS[DISTS.length - 1]} m`;
  report.check('a delayed impact still has a live source at its own onset',
    dead.length === 0,
    `${dead.length}/${impacts.length} distances schedule the whole envelope after their noise source stopped `
    + `(${dead.map((r) => `${r.d}m: onset +${(1000 * (r.onset - r.ctxBefore)).toFixed(0)}ms vs stop +${(1000 * (r.firstStop - r.ctxBefore)).toFixed(0)}ms`).join(', ')}) `
    + `— silent impacts start somewhere in ${cutoff}, inside SPEC.range of 220 m`);

  /* ------------------------------- 4. distant gunfire — the required red -- */
  //
  // gunshot(distance) computes `const delay = distance / 343` and then uses
  // distance only for attenuation, filter cutoff and the slapback tail. The
  // delay IS applied to T inside the current source — read it and you would
  // conclude the bug does not exist. Only the scheduled onset shows that it
  // does, which is the entire reason this file measures onsets. Measured here
  // both by direct probe (clean, one variable) and end-to-end through a real
  // enemy engagement (slow, but it is the path a player is on).
  const shots = [];
  for (const d of DISTS) {
    // eslint-disable-next-line no-await-in-loop
    shots.push({ d, ...(await sim.eval((dd) => window.__AUD.probe('gunshot', [dd]), d)) });
  }
  const gunLead = shots.map((r) => r.onset - r.ctxBefore);
  const gunSlope = slope(shots.map((r) => r.d), gunLead);

  report.check('gunshot() onset is delayed by distance at all',
    gunSlope > 0.5 / SOS,
    `onset lead vs distance: ${DISTS.map((d, i) => `${d}m:${(gunLead[i] * 1000).toFixed(1)}`).join(' ')} ms. `
    + `Slope ${gunSlope.toExponential(3)} s/m against the ${(1 / SOS).toExponential(3)} s/m that `
    + `${SOS} m/s requires — a flat line would mean the report leaves the muzzle and arrives at the ear `
    + 'in the same instant, which is what the brief for this suite claimed and what the negative control below refutes');
  report.check('gunshot() implied speed of sound',
    Number.isFinite(1 / gunSlope) && Math.abs(1 / gunSlope - SOS) <= 2,
    `implied ${gunSlope === 0 ? 'infinite' : `${fx(1 / gunSlope)} m/s`} against ${SOS} m/s. ${src('speed_of_sound_air')}`);

  for (const d of [40, 80, 120]) {
    const i = DISTS.indexOf(d);
    report.check(`enemy report at ${d} m arrives ${(1000 * d / SOS).toFixed(0)} ms late`,
      Math.abs(gunLead[i] - d / SOS) < 0.005,
      `scheduled ${ms(gunLead[i])} after the shot, physics requires ${ms(d / SOS)}, error `
      + `${ms(gunLead[i] - d / SOS)}; scheduling it instantly instead would put the report `
      + `${((d / SOS) / 0.045).toFixed(1)}x past the 45 ms audio-leads-video detectability threshold. `
      + src('av_desync_detectability_audio_leading'));
  }
  // The asymmetry in BT.1359-1 is the reason the direction of any residual
  // matters: early sound is physically impossible, late sound is not, so an
  // engine that must be wrong should be late. Asserted with a one-quantum
  // allowance because the residual here is instrument noise, not design.
  report.check('distant gunfire errs late rather than early',
    gunLead[DISTS.indexOf(80)] - 80 / SOS >= -quantum,
    `at 80 m the residual is ${ms(gunLead[DISTS.indexOf(80)] - 80 / SOS)} (positive = late); detectability is `
    + `45 ms early vs 125 ms late, so early is the ${(0.125 / 0.045).toFixed(1)}x more sensitive direction. ${src('av_desync_detectability_audio_leading')}`);

  // THE DEFECT THAT IS ACTUALLY THERE. gunshot() delays its envelope correctly
  // and then kills the sources underneath it: noise() stops each buffer source
  // at ctx.currentTime + duration + 0.05, computed from NOW rather than from the
  // delayed onset T. The crack element runs 0.06 s, so its source is stopped
  // 0.11 s from now, and any shot further away than 343 * 0.11 = 38 m has its
  // crack envelope written entirely after the source that would have carried it.
  // The crack is the 1.2 ms broadband transient that makes a gunshot read as a
  // gunshot; past ~38 m the player hears the body and the tail without it. The
  // low thump escapes because it is an oscillator started at T.
  // This is measured, not derived: the stop times come off the recorder.
  const deadPer = shots.map((r) => r.stops.filter((s) => s < r.onset).length);
  const firstDead = shots.findIndex((r, i) => deadPer[i] > 0);
  report.check('a distant gunshot still has every source alive at its own onset',
    deadPer.every((n) => n === 0),
    `sources already stopped at the scheduled onset, by distance: `
    + `${DISTS.map((d, i) => `${d}m:${deadPer[i]}/${shots[i].nSources}`).join(' ')}. `
    + `The first element dies between ${firstDead > 0 ? DISTS[firstDead - 1] : 0} and `
    + `${firstDead >= 0 ? DISTS[firstDead] : '>' + DISTS[DISTS.length - 1]} m; at 80 m the earliest source `
    + `stops ${ms(shots[DISTS.indexOf(80)].firstStop - shots[DISTS.indexOf(80)].ctxBefore)} in while the `
    + `envelope starts ${ms(gunLead[DISTS.indexOf(80)])} in`);

  // Negative control. Runs the identical maths over a deliberately broken
  // gunshot so the green checks above are known to be capable of going red.
  const ctrl = [];
  for (const d of DISTS) {
    // eslint-disable-next-line no-await-in-loop
    ctrl.push({ d, ...(await sim.eval((dd) => window.__AUD.control(dd), d)) });
  }
  const ctrlLead = ctrl.map((r) => r.onset - r.ctxBefore);
  const ctrlSlope = slope(ctrl.map((r) => r.d), ctrlLead);
  const ctrlWouldPass = ctrlSlope > 0.5 / SOS
    || [40, 80, 120].some((d) => Math.abs(ctrlLead[DISTS.indexOf(d)] - d / SOS) < 0.005);
  report.check('the distance-delay checks can go red (negative control)',
    !ctrlWouldPass,
    `a gunshot rebuilt with distance used for level only measures slope `
    + `${ctrlSlope.toExponential(3)} s/m and leads ${DISTS.map((d, i) => `${d}m:${(ctrlLead[i] * 1000).toFixed(1)}`).join(' ')} ms, `
    + `so the checks above ${ctrlWouldPass ? 'WOULD STILL PASS and are decorative' : 'correctly reject it'}. `
    + 'The real gunshot() passes them because src/audio.js already applies distance/343 — the brief\'s '
    + 'claim that it does not is contradicted by an unmodified working tree');

  // End-to-end, through director.onFire -> enemyShoot -> audio.gunshot. Placed
  // down a lane cleared by the harness, because an enemy that cannot see the
  // player never fires and a suite that reported "0 enemy shots" would be
  // measuring a wall.
  const at = await sim.snapshot();
  const lane = await sim.clearLane([at.px, null, at.pz], 90);
  // Capped at 70 m because CONFIG.viewDistance is 78: an enemy placed past its
  // own sight range never acquires the player and never fires, and this section
  // would then report "no enemy shot" — an instrument failure dressed as a
  // finding. 70 m still costs 204 ms of propagation, which is the quantity
  // under test.
  const EN_D = Math.min(70, Math.max(30, lane.clear - 8));
  const a = lane.deg * Math.PI / 180;
  const ex = at.px + Math.sin(a) * EN_D, ez = at.pz + Math.cos(a) * EN_D;
  // forward is (sin(facing), cos(facing)) in ai.js, so facing back down the lane
  // is a + PI. Without it the enemy spends its first second turning around and
  // the 72-degree view cone may never contain the player inside the window.
  const enemyFacing = a + Math.PI;
  await sim.setup({
    audio: true, invulnerable: true, ammo: 30,
    enemies: [{ x: ex, z: ez, facing: enemyFacing, engage: true }],
  });
  await sim.tapEvents();
  await sim.eval(() => window.__AUD.reset());
  await sim.drive({ seconds: 4.0, dt: 1 / 120, input: IN() });
  const enemyShots = (await sim.eval(() => window.__AUD.calls.slice()))
    .filter((c) => c.name === 'gunshot' && c.args[0] > 1);

  if (!enemyShots.length) {
    report.check('an engaged enemy fired at all (end-to-end distant gunfire)', false,
      `0 audio.gunshot calls with a nonzero distance over 4.0 s with an enemy placed ${fx(EN_D)} m away `
      + `down a ${fx(lane.clear)} m lane at ${lane.deg} deg — with no enemy shot the end-to-end distance `
      + 'delay could not be measured, so treat this as an instrument failure rather than a passing game');
  } else {
    const e0 = enemyShots[0];
    const eLead = e0.onset - e0.ctxBefore;
    const eD = e0.args[0];
    report.check('end-to-end: a real enemy report carries its propagation delay',
      Math.abs(eLead - eD / SOS) < 0.005,
      `${enemyShots.length} enemy gunshots, first at ${fx(eD)} m scheduled with ${ms(eLead)} of lead against `
      + `${ms(eD / SOS)} required; mean lead over all of them ${ms(enemyShots.reduce((s, c) => s + c.onset - c.ctxBefore, 0) / enemyShots.length)} `
      + `at a mean distance of ${fx(enemyShots.reduce((s, c) => s + c.args[0], 0) / enemyShots.length)} m`);
    // A DIFFERENT observable with the same root cause, kept because it is the
    // one a player feels: enemyShoot resolves the round instantly (hitscan) AND
    // schedules the report instantly, so there is no interval at all between
    // being hit and hearing the shot. Real supersonic fire gives the target the
    // bullet first and the report a long time later, and that interval is the
    // cue a player uses to locate a shooter. Here it is exactly zero.
    const warning = eD / SOS - eD / 900; // 900 m/s is a generic 5.56 muzzle figure, used only to size the gap
    report.check('there is any interval between taking a distant round and hearing it',
      eLead > 0.010,
      `report lead ${ms(eLead)} at ${fx(eD)} m while the bullet resolves on the same tick, so the `
      + `crack-to-report interval a player would use to locate the shooter is ${ms(eLead)}; the geometry `
      + `implies about ${ms(warning)}. No sourced CoD figure for this interval — the 10 ms floor asserted `
      + 'here is a structural "nonzero", not a target');

    // Same source-lifetime defect as the sweep, on the path a player is on.
    const eDead = e0.stops.filter((s) => s < e0.onset).length;
    report.check('a real enemy report keeps every element it scheduled',
      eDead === 0,
      `${eDead} of ${e0.nSources} sources were already stopped when the ${ms(eLead)} delayed envelope `
      + `began, at ${fx(eD)} m; earliest source stop ${ms(e0.firstStop - e0.ctxBefore)} in. The crack `
      + 'transient is the element that dies, so the report is audible but hard to localise');
  }

  /* ----------------------------- 5. hitmarker and damage feedback latency -- */
  //
  // Measured against the damage actually being applied — enemy.applyDamage —
  // rather than against the trigger pull, because that is the event the player
  // is being given feedback about. Enemy health is set high on purpose: a kill
  // routes through director.onDeath and plays hitmarker(true) instead, and
  // mixing the two would average a kill cue into a hit cue.
  const hitLane = await sim.clearLane([at.px, null, at.pz], 40);
  const ha = hitLane.deg * Math.PI / 180;
  const HD = 18;
  await sim.setup({
    audio: true, invulnerable: true, ammo: 30,
    enemies: [{ x: at.px + Math.sin(ha) * HD, z: at.pz + Math.cos(ha) * HD, inert: true, health: 4000 }],
  });
  await sim.tapEvents();
  const aim = await sim.aimAt(0);
  await sim.eval(() => window.__AUD.reset());
  await sim.clearEvents();

  if (!aim.clear) {
    report.check('hitmarker latency measurable (a clear shot at an enemy)', false,
      `aimAt reported clear=false at ${fx(aim.distance)} m — world geometry at ${fx(aim.worldDist)} m is in `
      + `front of the body at ${fx(aim.enemyDist)} m, so no damage could be applied and the hitmarker `
      + 'latency below would be a measurement of a wall');
  } else {
    await sim.drive({ seconds: 0.6, dt: DT, input: IN({ fire: true, ads: true }) });
    const fbEvs = await sim.events();
    const fbCalls = await sim.eval(() => window.__AUD.calls.slice());
    const dmg = fbEvs.filter((e) => e.kind === 'enemy.applyDamage');
    const hm = fbCalls.filter((c) => c.name === 'hitmarker');
    const flesh = fbCalls.filter((c) => c.name === 'impact' && c.args[0] === 'flesh');

    report.check('every applied hit gets exactly one hitmarker',
      dmg.length > 0 && hm.length === dmg.length,
      `${dmg.length} enemy.applyDamage calls at ${fx(aim.distance)} m (zone ${aim.zone}), ${hm.length} `
      + `audio.hitmarker calls, ${flesh.length} flesh impacts`);

    if (dmg.length && hm.length) {
      const pairs = dmg.map((d) => {
        const cue = hm.find((c) => c.sim === d.sim);
        return cue ? { dSim: cue.sim - d.sim, dAudio: cue.ctxBefore - d.audio, lead: cue.onset - cue.ctxBefore } : null;
      }).filter(Boolean);
      const worstSim = Math.max(...pairs.map((p) => Math.abs(p.dSim)));
      const worstAud = Math.max(...pairs.map((p) => Math.abs(p.dAudio)));
      report.check('hitmarker is on the same tick as the damage it confirms',
        pairs.length === dmg.length && worstSim === 0,
        `${pairs.length}/${dmg.length} hits matched; worst simulated gap ${ms(worstSim)}, worst `
        + `AudioContext gap ${ms(worstAud)}, scheduling lead ${ms(pairs[0].lead)}`);
      under(report, 'hitmarker total latency (tick + output path) under the hard ceiling',
        'competitive_audio_latency_ceiling', worstSim + pairs[0].lead + total);

      // Ordering finding, not a defect claim: the hitmarker is a UI cue and is
      // right to be instant, but impact('flesh', d) is delayed by d/343, so the
      // confirmation beep arrives before the sound of the bullet landing. At
      // 18 m that is 52 ms of the two cues for one event being that far apart.
      if (flesh.length) {
        const fLead = flesh[0].onset - flesh[0].ctxBefore;
        report.check('hit feedback cues are ordered consistently with the geometry',
          true,
          `hitmarker lead ${ms(pairs[0].lead)} vs flesh-impact lead ${ms(fLead)} at ${fx(aim.distance)} m `
          + `— the UI beep precedes the sound of the round landing by ${ms(fLead - pairs[0].lead)}. `
          + 'No sourced target: an instant hit confirmation is a deliberate convention, '
          + 'the delayed flesh impact is physically correct, and both being true at once is the finding');
      }
    }
  }

  // Damage taken. player.damage() is the moment health leaves the player, and
  // audio.hurt() is the cue for it; both live in enemyShoot(), so this measures
  // whether feedback for being shot is on the same tick as being shot. Needs
  // invulnerable:false, or player.damage is a no-op stub and the tap records a
  // call to a function that changed nothing.
  //
  // Placed at 18 m rather than 70 m, and given 400 HP rather than 100: at long
  // range the AI's 0.052 rad cone misses almost everything, and with 100 HP the
  // player dies partway through and stops being shot at. Both would have turned
  // this into a zero-sample check that looked like a defect in the game.
  const DDIST = 18;
  await sim.setup({
    audio: true, invulnerable: false, health: 400, ammo: 30,
    enemies: [{
      x: at.px + Math.sin(ha) * DDIST, z: at.pz + Math.cos(ha) * DDIST,
      facing: ha + Math.PI, engage: true,
    }],
  });
  await sim.tapEvents();
  await sim.eval(() => window.__SIM.tap(window.__GAME.player, ['damage'], 'player'));
  await sim.eval(() => window.__AUD.reset());
  await sim.drive({ seconds: 6.0, dt: 1 / 120, input: IN() });
  const hurtEvs = await sim.events();
  const hurtCalls = (await sim.eval(() => window.__AUD.calls.slice())).filter((c) => c.name === 'hurt');
  const dmgTaken = hurtEvs.filter((e) => e.kind === 'player.damage');

  if (!dmgTaken.length) {
    report.check('damage-taken feedback latency measurable', false,
      `the player took 0 hits over 6.0 s from an enemy at ${fx(DDIST)} m, so hurt() latency could not be `
      + `measured; ${hurtCalls.length} hurt calls were recorded, which should also be 0 if this is real`);
  } else {
    const pairs = dmgTaken.map((d) => {
      const cue = hurtCalls.find((c) => c.sim === d.sim);
      return cue ? { dSim: cue.sim - d.sim, lead: cue.onset - cue.ctxBefore } : null;
    }).filter(Boolean);
    report.check('hurt cue is on the same tick as the damage the player takes',
      pairs.length === dmgTaken.length && pairs.every((p) => p.dSim === 0),
      `${dmgTaken.length} hits taken over 6.0 s at ${fx(DDIST)} m, ${hurtCalls.length} hurt cues, `
      + `${pairs.length} matched on the same tick; scheduling lead ${ms(pairs[0]?.lead)}`);
  }

  /* ------------------------------------------------ 6. the reload track -- */
  //
  // Two reloads, measured entirely from the event log and the observed
  // magazine animation. Nothing here reads SPEC.reloadTime or the 0.08/0.50/0.80
  // thresholds: the reload's duration is the interval over which `reloading` is
  // true, and the animation landmarks are read off magGroup.position.y as the
  // simulation actually moves it. That matters because the thresholds and the
  // animation comment in weapon.js DISAGREE — the comment describes seating
  // between 0.72 and 0.86 and the seat sound fires at 0.80 — and only the
  // observed animation can say which one the player sees.
  for (const kind of ['tactical', 'empty']) {
    const empty = kind === 'empty';
    // eslint-disable-next-line no-await-in-loop
    await sim.setup({ audio: true, invulnerable: true, ammo: empty ? 2 : 12 });
    // eslint-disable-next-line no-await-in-loop
    await sim.tapEvents();
    // eslint-disable-next-line no-await-in-loop
    await sim.eval(() => window.__AUD.reset());

    // An empty reload is started by the game itself once the magazine runs dry;
    // a tactical one goes through Game.tryReload(), which is exactly what the R
    // key calls. Both are driven from inside the tick loop so the reload's own
    // start timestamp is on the simulated clock.
    const input = empty
      ? IN({ fire: true })
      : `if (i === 6) g.tryReload(); ${IN()}`;
    // eslint-disable-next-line no-await-in-loop
    const rows = await sim.drive({
      seconds: 4.2, dt: DT_RELOAD, input,
      // reloadStart is a timestamp the game writes when the reload begins, not a
      // tuning constant — the phase maths needs an origin and this is the origin
      // the game itself used.
      sample: 'return { rs: g.weapon.reloading ? g.weapon.reloadStart : -1, magY: g.weapon.magGroup.position.y };',
    });
    // eslint-disable-next-line no-await-in-loop
    const calls = (await sim.eval(() => window.__AUD.calls.slice()))
      .filter((c) => c.name === 'mechanical');

    const iOn = rows.findIndex((r) => r.reloading === 1);
    const iOff = iOn < 0 ? -1 : rows.findIndex((r, i) => i > iOn && r.reloading === 0);
    if (iOn < 0 || iOff < 0) {
      report.check(`${kind} reload ran to completion`, false,
        `reloading went ${iOn < 0 ? 'never true' : 'true but never false'} across 4.2 s; `
        + `${calls.length} mechanical cues fired, so the phase measurements below are absent, not zero`);
      continue;
    }
    const start = rows[iOn].rs;
    const dur = rows[iOff].t - start;
    report.check(`${kind} reload start timestamp agrees with the reloading flag`,
      Math.abs(start - rows[iOn].t) <= DT_RELOAD + 1e-9,
      `game-stamped reloadStart ${fx(start)} s vs first tick with reloading=true ${fx(rows[iOn].t)} s, `
      + `gap ${ms(rows[iOn].t - start)}; measured duration ${ms(dur)} (+/-${ms(DT_RELOAD)} of tick quantisation)`);

    // Animation landmarks, read off the running simulation.
    const span = rows.slice(iOn, iOff + 1);
    const drop = span.find((r) => r.magY < -0.001);
    const bottom = span.reduce((b, r) => (r.magY < b.magY ? r : b), span[0]);
    const seated = span.find((r) => r.t > bottom.t && r.magY >= -0.0005);
    const ph = (t) => (t - start) / dur;

    const kinds = ['release', 'insert', 'seat'];
    const found = kinds.map((k) => calls.filter((c) => c.args[0] === k && c.sim >= start && c.sim <= rows[iOff].t));

    report.check(`${kind} reload fires each mechanical cue exactly once`,
      found.every((f) => f.length === 1),
      kinds.map((k, i) => `${k}x${found[i].length}`).join(' ')
      + ` over ${ms(dur)}; other mechanical cues in the window: `
      + `${calls.filter((c) => !kinds.includes(c.args[0])).map((c) => c.args[0]).join(',') || 'none'}`);

    if (found.every((f) => f.length === 1)) {
      const [rel, ins, seat] = found.map((f) => f[0]);
      report.check(`${kind} reload cues are ordered release < insert < seat`,
        rel.sim < ins.sim && ins.sim < seat.sim,
        `phases ${ph(rel.sim).toFixed(3)} / ${ph(ins.sim).toFixed(3)} / ${ph(seat.sim).toFixed(3)} of a `
        + `${ms(dur)} reload, i.e. ${ms(rel.sim - start)} / ${ms(ins.sim - start)} / ${ms(seat.sim - start)} in`);

      // Does each cue land in the part of the animation it names? The windows
      // are the observed magazine motion, so a re-timed animation moves the
      // window with it and only a genuine mismatch fails.
      report.check(`${kind} 'release' fires as the magazine starts to drop`,
        drop && Math.abs(rel.sim - drop.t) <= 0.05,
        `release at phase ${ph(rel.sim).toFixed(3)}, magazine first moves at phase `
        + `${drop ? ph(drop.t).toFixed(3) : 'n/a'} — cue is ${ms(rel.sim - (drop?.t ?? NaN))} `
        + `${rel.sim >= (drop?.t ?? 0) ? 'after' : 'before'} the visible motion`);

      report.check(`${kind} 'insert' fires while the magazine is travelling back in`,
        bottom && seated && ins.sim > bottom.t && ins.sim < seated.t,
        `insert at phase ${ph(ins.sim).toFixed(3)}, magazine bottoms out at ${ph(bottom.t).toFixed(3)} `
        + `(y ${fx(bottom.magY)} m) and is home by ${seated ? ph(seated.t).toFixed(3) : 'n/a'} — `
        + `${ms(ins.sim - bottom.t)} into a ${ms((seated?.t ?? NaN) - bottom.t)} insertion stroke`);

      // The A/V sync check with teeth. The magazine is visually home well
      // before the click that says it is, and the gap is measured against
      // ITU-R BT.1359-1 rather than against a number of our own.
      const seatLag = seated ? seat.sim - seated.t : NaN;
      report.check(`${kind} 'seat' click is within the A/V detectability window of the magazine seating`,
        Number.isFinite(seatLag) && seatLag <= (T('av_desync_detectability_audio_lagging')?.value ?? Infinity)
          && seatLag >= -(T('av_desync_detectability_audio_leading')?.value ?? Infinity),
        `magazine is visually home at phase ${seated ? ph(seated.t).toFixed(3) : 'n/a'} and the seat click `
        + `plays at ${ph(seat.sim).toFixed(3)}, ${ms(seatLag)} later on a ${ms(dur)} reload. `
        + src('av_desync_detectability_audio_lagging'));
    }

    // weapon.js documents "0.86-1.0 bolt release (empty reload only)" and
    // audio.js defines a 'bolt' entry in the mechanical() spec table with its
    // own frequency, amplitude and duration. Nothing calls it. This is not a
    // latency defect but it is the same instrument reading it: a mechanical
    // event that the reload track claims exists and never fires.
    if (empty) {
      const bolt = calls.filter((c) => c.args[0] === 'bolt');
      report.check('empty reload plays the bolt-release cue its own track documents',
        bolt.length === 1,
        `${bolt.length} 'bolt' cues over a ${ms(dur)} empty reload. weapon.js documents a bolt-release `
        + 'phase at 0.86-1.0 and audio.mechanical has a full \'bolt\' voice defined; onReloadEvent is '
        + 'never called with it, so the sound exists and is unreachable');
    }
  }

  /* ------------------------------------------------- 7. coverage honesty -- */
  const t = T('competitive_audio_latency_target');
  report.check('audio targets are sourced non-CoD engineering guidance, not CoD figures',
    !!t && /non-CoD/i.test(t.title ?? ''),
    t
      ? `audio_latency scope is covered by ${Object.keys(TARGETS.audio).length} targets, of which the `
        + `perceptual thresholds are labelled "${(t.title ?? '').slice(0, 60)}" — no published Call of Duty `
        + 'audio-latency figure exists, so every latency bound above is general game-audio literature'
      : 'targets.mjs has no audio domain — every bound above was reported as a bare measurement');
}
