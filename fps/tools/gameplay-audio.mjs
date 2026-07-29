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
// a broken gunshot() (which would not), because both are called at the same
// instant. So this file installs a recorder on AudioParam.prototype and reads
// the minimum scheduled time out of every audio call — that number is the sound
// as the listener receives it, and it is the only number that can tell those two
// functions apart.
//
// WHAT IS THE GAME AND WHAT IS THE MACHINE — the division this file is built
// around, because it is the difference between an instrument and a wall of red.
// sampleRate, baseLatency and outputLatency are properties of the device and the
// browser. On this headless Chromium they sum to ~42 ms, which is over the 20 ms
// imperceptible tier and at the 40 ms ceiling from the same literature, and NO
// change to this codebase can move them by a microsecond. An earlier revision of
// this suite asserted on them anyway and produced five reds that were true
// statements about the container and zero statements about the game — which is
// how a reader learns to skip the output. They are now report.measure()d: the
// platform floor is printed, kept, quoted in the notes of the checks it bounds,
// and counted separately from any pass.
//
// What IS asserted is what the engine decides: the scheduling lead it adds, the
// ordering of cues, one sound per round, and the propagation delay it applies to
// distance. Perturb any of those in src/ and this suite goes red; perturb the
// machine and it reports a different number in the same green shape.
//
// WHAT IT FOUND, in one place, because the rest of the file is the evidence:
//   - THE BRIEF FOR THIS SUITE WAS WRONG ABOUT DISTANT GUNFIRE. It stated that
//     gunshot(distance) "uses distance only for level and filtering, so an
//     enemy's report at 80 m arrives instantly", and that the check for it must
//     fail. src/audio.js has computed `distance / SPEED_OF_SOUND` and scheduled
//     every element at T = now + delay since the file was first committed
//     (git log -p -- src/audio.js: the line arrives in the initial revision),
//     and the measured onset lead at 80 m is 233 ms against 233 ms required. No
//     failure was manufactured to match the brief. Instead the delay checks are
//     backed by a NEGATIVE CONTROL that rebuilds the broken gunshot the brief
//     described and requires the same assertions to reject it, so their green is
//     evidence rather than an untested silence.
//   - WHAT WAS ACTUALLY BROKEN AT DISTANCE: the delay was applied to the
//     envelope and not to the source lifetimes. noise() stopped each buffer
//     source at ctx.currentTime + duration + 0.05, computed from NOW rather than
//     from the delayed onset, so past 343 * 0.11 = 38 m the crack element's
//     envelope was written after the source carrying it had been stopped, and
//     past ~120 m the body went the same way. A distant report lost its
//     transient, which is the part that makes it locatable. Same defect in
//     impact(): beyond ~93 m the single source was stopped before the envelope
//     started and the impact was entirely silent, well inside SPEC.range of
//     220 m. Fixed by scheduling the lifetime from the onset it belongs to.
//   - nothing was scheduled with any lead at all, not even the 128-sample render
//     quantum, so every attack transient started in the audio thread's past and
//     was clamped forward to the next block boundary — the crack's 1.2 ms attack
//     is 0.41 of a quantum long, so the transient this game is proudest of was
//     the part being quantised away. Fixed by scheduling one quantum ahead.
//   - the magazine-seat click played 183 ms (tactical) / 233 ms (empty) after
//     the magazine visually seats, 1.5x and 1.9x the ITU-R BT.1359-1
//     detectability threshold for audio lagging video. weapon.js gated the click
//     at reload phase 0.80 while the insert stroke lands the magazine at 0.72,
//     and the error cost MORE on the longer empty track because eight
//     hundredths of a reload is eight hundredths of a longer reload. Fixed in
//     weapon.js by gating the cue on the phase the animation lands on; both
//     tracks now measure one 16.67 ms tick, which is the tick grid.
//   - the reload track documented a bolt-release phase and audio.js defined a
//     full 'bolt' voice, and nothing ever played it. Fixed in weapon.js, on the
//     empty reload only: a tactical reload does not cycle the bolt.
//   - WHAT THIS SUITE HAD WRONG. "trigger press to round is one simulated tick"
//     compared the measured interval against the harness's own dt, which became
//     unsatisfiable the moment main.js moved to a fixed 60 Hz tick — a round
//     cannot be quantised finer than the grid it is fired on, so no change to
//     the game could have made 4.17 ms of it. The expectation is now in TICKS,
//     with the tick length measured off the trace's own timestamps.

const DT = 1 / 240;      // four samples inside the 79 ms shot interval
const DT_RELOAD = 1 / 240; // 2.18 s of reload is 523 ticks; 4 ms on a 2180 ms phase is 0.2%

export const NAME = 'audio';

/* ------------------------------------------------------------- targets -- */
//
// report.against() is the only way a target VALUE reaches an assertion in this
// file: it takes a domain and a key, throws on an unknown one, and fixes the
// tolerance at the source. Two things it deliberately cannot do, and how they
// are handled here:
//
//   A ONE-SIDED BOUND. against() brackets, and competitive_audio_latency_target
//   is 0.020 +/-0.005 — so a 7 ms engine budget would FAIL it for being too
//   good. The threshold checks ("no worse than") read the sourced value through
//   sourcedAudio() below and compare one-sidedly, printing the title and the URL
//   in the detail. The number still comes from targets.mjs and nowhere else.
//
//   AN EXPECTATION TO FORM RATHER THAN COMPARE. distance/343 has to be computed
//   before a residual against it can be measured. 343 is read out of
//   audio.speed_of_sound_air together with its +/-2, so the suite and the
//   research cannot drift apart. An earlier revision had `const SOS = 343` at
//   the top of this file and a hand-written `<= 2` next to it, which was not an
//   invented number but was a duplicated one, and duplicated expectations are
//   how a suite ends up quietly asserting last quarter's research.
const { TARGETS } = await import('./targets.mjs');

/** Sourced audio record, by exact key. Throws like against() rather than degrading. */
function sourcedAudio(key) {
  const t = TARGETS?.audio?.[key];
  if (!t) {
    throw new Error(`sourcedAudio("${key}") is not in targets.mjs. `
      + `Known audio keys: ${Object.keys(TARGETS?.audio ?? {}).join(', ') || '(no audio domain)'}`);
  }
  return t;
}
/** "title — url", for a detail string that has to carry its own provenance. */
const cite = (key) => `${sourcedAudio(key).title} — ${sourcedAudio(key).source}`;

const SOS = sourcedAudio('speed_of_sound_air').value;       // 343 m/s
const SOS_TOL = sourcedAudio('speed_of_sound_air').tol.abs;  // +/-2 m/s
const QUANTUM_FRAMES = sourcedAudio('web_audio_render_quantum').value; // 128, spec-fixed

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
const med = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[xs.length >> 1] : NaN);

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
//   stopped. That was a real state in this codebase (see the impact() sweep) and
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
   * function has computed the delay and added it to T since the initial commit,
   * so the claim was simply wrong. That leaves a real problem — a green check
   * whose ability to go red has never been demonstrated is exactly the silence
   * this project has been burned by.
   *
   * So this builds the sound the brief DESCRIBED: the same three-element
   * gunshot envelope, scheduled at ctx.currentTime with the distance argument
   * used for level only, which is what a regression would look like. The suite
   * runs the identical slope and per-distance maths over it and requires every
   * one of those assertions to come out FALSE. If the control ever passes, the
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
     * lead is out by one quantum. Requiring ctxBefore === ctxAfter proves no
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

  if (!Number.isFinite(info.sampleRate)) {
    throw new Error('no AudioContext sampleRate — the render quantum is the unit every timing check '
      + 'below is expressed in, so there is nothing to measure against');
  }

  /* ------------------------------------------------- 1. the output path -- */
  //
  // ALL MEASUREMENTS, NO ASSERTIONS, on purpose. These are properties of the
  // device and the browser: the game cannot deliver a sound sooner than
  // baseLatency + outputLatency after it schedules one, whatever it does. On
  // this container that sum is ~42 ms — over the 20 ms imperceptible tier and at
  // the 40 ms ceiling — and no edit to src/ moves it, so asserting on it
  // manufactures reds that are true about the machine and silent about the game.
  // The numbers are printed because every engine budget below sits on top of
  // them, and they are quoted in the notes of the checks they bound.
  const quantum = QUANTUM_FRAMES / info.sampleRate;
  const platform = (info.baseLatency ?? 0) + (info.outputLatency ?? 0);
  const baseBand = sourcedAudio('web_audio_baselatency_interactive').tol;
  const outBand = sourcedAudio('web_audio_outputlatency_wired').tol;

  report.measure('platform sample rate', info.sampleRate, 'Hz',
    `so the spec-fixed ${QUANTUM_FRAMES}-frame render quantum is ${ms(quantum)} — the quantisation floor `
    + `on every scheduled onset in this file. ${cite('web_audio_render_quantum')}`);
  report.measure('platform baseLatency', info.baseLatency * 1000, 'ms',
    `${(info.baseLatency / quantum).toFixed(2)} render quanta; audio.js constructs the AudioContext with no `
    + `latencyHint, so this is the platform default rather than "interactive", whose reference band is `
    + `${baseBand.min * 1000}..${baseBand.max * 1000} ms. ${cite('web_audio_baselatency_interactive')}`);
  report.measure('platform outputLatency', info.outputLatency * 1000, 'ms',
    `reference band ${outBand.min * 1000}..${outBand.max * 1000} ms for a wired path, and the source notes `
    + `that some platforms return exactly 0, so there is no floor to assert against. ${cite('web_audio_outputlatency_wired')}`);
  report.measure('platform output path the engine cannot remove', platform * 1000, 'ms',
    `baseLatency + outputLatency, i.e. `
    + `${(platform / sourcedAudio('competitive_audio_latency_target').value).toFixed(2)}x the `
    + `${ms(sourcedAudio('competitive_audio_latency_target').value)} imperceptible-tier target and `
    + `${(platform / sourcedAudio('competitive_audio_latency_ceiling').value).toFixed(2)}x the `
    + `${ms(sourcedAudio('competitive_audio_latency_ceiling').value)} ceiling. HEADLESS CHROMIUM, not the `
    + `game: ${cite('windows_wired_headset_total_audio_latency')}`);

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
  const minGap = Math.min(...gaps);
  report.check('no simulated tick carries two gunshots',
    worstTick <= 1,
    `worst tick carried ${worstTick} gunshot(s); min gap between consecutive gunshots ${ms(minGap)}, `
    + `median ${ms(med(gaps))} over ${gaps.length} intervals`);

  // Round -> scheduling latency, on both clocks. The two events happen in the
  // same synchronous playerShoot() body, so simulated latency is structurally
  // zero and the AudioContext delta is whatever the audio thread advanced by
  // while the JS ran — which is the number that would grow if scheduling ever
  // moved to a deferred queue.
  //
  // PAIRED ON THE TICK, NOT ON weapon.lastShot. An earlier revision matched
  // rounds to gunshots by `lastShot === c.sim`, which silently collapsed to
  // 1/30 matches: weapon.js:1065 now advances lastShot by exactly one fire
  // interval while the trigger is held (`lastShot + interval`) rather than
  // stamping g.elapsed, so it is deliberately OFF the tick grid and equality
  // against a tick timestamp can only hold for the first round of a burst. The
  // round's tick is the tick its ammo decrement was sampled on, which is what
  // is used here — and 1/30 matching is exactly what a "0 samples reported as
  // fine" bug looks like from the outside, so the count is asserted.
  const perRound = [];
  for (let k = 0; k < Math.min(decrements.length, shotCalls.length); k++) {
    const shot = shotCalls[k];
    const fireEv = evs.filter((e) => e.kind === 'weapon.fire' && e.sim === shot.sim && e.audio !== null).pop();
    if (!fireEv) continue;
    perRound.push({
      t: decrements[k].t,
      dSim: shot.sim - decrements[k].t,
      dAudio: shot.ctxBefore - fireEv.audio,
      lead: shot.onset - shot.ctxBefore,
    });
  }
  const maxSim = Math.max(...perRound.map((r) => Math.abs(r.dSim)));
  const maxAud = Math.max(...perRound.map((r) => Math.abs(r.dAudio)));
  report.check('gunshot is scheduled on the same simulated tick the round leaves',
    perRound.length === decrements.length && maxSim === 0,
    `${perRound.length}/${decrements.length} rounds matched to a gunshot on the same tick; worst simulated `
    + `gap ${ms(maxSim)} (zero by construction — fire() and gunshot() are in one synchronous body, so a `
    + 'nonzero value here would mean the sound had been deferred to a later tick)');

  // Two bounds on the AudioContext-clock cost of scheduling, neither of them a
  // round number of milliseconds.
  //
  // An earlier revision asserted `maxAud < 0.005`. That is 1.72 render quanta,
  // and two clean baselines of the same quantity measured 5.80 ms and 2.90 ms —
  // exactly 2 and 1 quanta of jitter — so the threshold sat one boundary
  // crossing away from flipping for reasons that have nothing to do with the
  // game. Both reads of ctx.currentTime are independently quantised, so a
  // difference of a couple of quanta is the instrument and not a cost. What
  // would NOT be the instrument is scheduling work that grows with the burst (a
  // deferred queue filling up) or that costs more than the interval between
  // rounds; those are the two things asserted, and the magnitude is measured in
  // quanta rather than compared to a threshold nobody sourced.
  report.measure('worst ctx.currentTime advance from round to gunshot call',
    maxAud / quantum, 'render quanta',
    `${ms(maxAud)} worst and ${ms(med(perRound.map((r) => r.dAudio)))} median over ${perRound.length} rounds `
    + `against a ${ms(quantum)} quantum — a difference between two independently quantised clock reads`);
  const audDrift = slope(perRound.map((r, i) => i), perRound.map((r) => r.dAudio)) * perRound.length;
  report.check('gunshot scheduling does not accumulate lag across a burst',
    Number.isFinite(audDrift) && Math.abs(audDrift) <= quantum,
    `the round-to-schedule gap drifts ${ms(audDrift)} end to end over ${perRound.length} rounds, `
    + `${(audDrift / quantum).toFixed(2)} of one ${ms(quantum)} quantum — a deferred scheduling queue would `
    + 'show as a gap that grows with burst position');
  report.check('gunshot scheduling costs less than the interval between rounds',
    maxAud < minGap,
    `worst advance ${ms(maxAud)} against the ${ms(minGap)} minimum gap between rounds, `
    + `${(maxAud / minGap * 100).toFixed(1)}% of it; at 100% the scheduling itself would be the rate limiter`);

  // Trigger press -> round. One tick, and that tick plus the scheduling lead is
  // the engine's ENTIRE input-to-sound contribution. The end-to-end figure is
  // that plus the platform path from section 1, and it is measured rather than
  // asserted because the platform term dominates it and is not ours.
  //
  // ONE TICK, NOT ONE DRIVEN dt. This check compared inputToRound against DT and
  // was red at 16.67 ms against 4.17 ms. That red was the instrument, not the
  // game: main.js banks the time it is handed and integrates only in fixed
  // TICK-long slices, so the finest grain a round can be quantised to is one
  // simulation tick whatever dt the harness pushes, and no change to src/ could
  // ever have satisfied it. Driving at DT = 1/240 does not buy four times the
  // resolution on this quantity — it buys four samples per tick of the same
  // 60 Hz grid, which is what the rest of section 2 wants and why DT stays.
  //
  // The tick length is MEASURED, not read. g.elapsed advances by exactly one
  // tick on the ticking steps and by nothing on the others, so the set of
  // nonzero increments of the trace's own timestamps IS the tick grid. Reading
  // main.js's TICK is barred by the runner's lint for the right reason, and
  // g.tickLength — reachable through sim.eval — is the constant under test here:
  // an expectation built from it would move with it and the check could never
  // disagree. Deriving it from the trace means a tick that did not actually
  // advance by tickLength shows up as a spread in the increments, which is
  // asserted below rather than averaged away.
  const tSteps = burst.slice(1).map((r, i) => r.t - burst[i].t).filter((d) => d > 1e-9);
  const tickLen = tSteps.length ? Math.min(...tSteps) : NaN;
  const tickSpread = tSteps.length ? Math.max(...tSteps) - tickLen : NaN;
  report.check('the simulation advances on one fixed tick grid',
    tSteps.length > 0 && tickSpread < 1e-9,
    `${tSteps.length} advances of g.elapsed over ${burst.length} driven steps of ${ms(DT)}, all `
    + `${ms(tickLen)} to within ${ms(tickSpread)} — i.e. one step in `
    + `${(burst.length / Math.max(1, tSteps.length)).toFixed(2)} moved the simulation, and the grid is the `
    + 'game\'s own rather than the harness\'s. A variable-dt integrator would show a spread here');

  const press = preFire.t;
  const inputToRound = lastShots.length ? lastShots[0] - press : NaN;
  const roundTicks = inputToRound / tickLen;
  report.check('trigger press to round is one simulated tick',
    Number.isFinite(roundTicks) && Math.abs(roundTicks - 1) < 1e-6,
    `${ms(inputToRound)} = ${roundTicks.toFixed(4)} ticks of the measured ${ms(tickLen)} grid, driven at `
    + `dt=${ms(DT)} — the round leaves on the first tick after the trigger goes down. Two ticks would mean `
    + 'the trigger was polled a tick before the round it fired');

  const leads = perRound.map((r) => r.lead);
  const engineBudget = inputToRound + med(leads);
  const tierTarget = sourcedAudio('competitive_audio_latency_target').value;
  const ceiling = sourcedAudio('competitive_audio_latency_ceiling').value;
  report.check('the engine\'s own trigger-to-schedule budget is inside the imperceptible tier',
    engineBudget <= tierTarget,
    `one ${ms(inputToRound)} tick plus a ${ms(med(leads))} median scheduling lead = ${ms(engineBudget)}, `
    + `${(engineBudget / tierTarget * 100).toFixed(1)}% of the ${ms(tierTarget)} bound. This is the part of `
    + `the budget the engine decides; the ${ms(platform)} platform path is measured separately because no `
    + `change here can move it. ${cite('competitive_audio_latency_target')}`);
  report.measure('end-to-end trigger to sound at the ear', (engineBudget + platform) * 1000, 'ms',
    `${ms(engineBudget)} engine + ${ms(platform)} headless-Chromium output path, against a ${ms(tierTarget)} `
    + `target and a ${ms(ceiling)} ceiling. The platform term is `
    + `${(platform / (engineBudget + platform) * 100).toFixed(0)}% of the total, which is why this is a `
    + 'measurement and not a check');

  // A zero lead is not free, and it is the engine's decision. The audio thread
  // has already rendered up to currentTime, so an envelope whose first
  // setValueAtTime lands at exactly currentTime starts in the past and is
  // clamped forward to the next block boundary. The gunshot crack's attack is
  // 1.2 ms, under half a render quantum, so the transient this game is proudest
  // of was the part being quantised away. audio.js now schedules one quantum
  // ahead, which is also the direction BT.1359-1 says to err in.
  report.check('gunshot envelope is scheduled at least one render quantum ahead',
    perRound.length > 0 && perRound.every((r) => r.lead >= quantum - 1e-9),
    `lead median ${ms(med(leads))}, min ${ms(Math.min(...leads))}, max ${ms(Math.max(...leads))} over `
    + `${perRound.length} rounds vs the ${QUANTUM_FRAMES}-frame quantum ${ms(quantum)}: the crack's 1.2 ms `
    + `attack is ${(0.0012 / quantum).toFixed(2)} quanta long, so at zero lead its start time is in the `
    + `audio thread's past. ${cite('web_audio_render_quantum')}`);

  /* ---------------------------------------- 3. impact() vs speed of sound -- */
  //
  // The control case. impact() computes now + distance/SPEED_OF_SOUND, so if the
  // recorder cannot see a slope here it is the recorder that is broken, not the
  // game — which is what makes section 4's numbers evidence instead of an
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
    `lead ${DISTS.map((d, i) => `${d}m:${(impLead[i] * 1000).toFixed(1)}`).join(' ')} ms over `
    + `${DISTS.length} distances`);
  report.reached('impact() implied speed of sound is a finite number', impSpeed,
    `slope ${impSlope.toExponential(3)} s/m over ${DISTS.length} distances gives ${fx(impSpeed)} m/s; a flat `
    + 'line gives an infinite speed and must fail here rather than arrive downstream as one');
  report.against('impact() implied speed of sound', impSpeed, 'audio', 'speed_of_sound_air');

  // THE RESIDUAL TOLERANCE, and why it is two quanta rather than a round 3 or
  // 5 ms. The lead is onset - ctxBefore: two reads of ctx.currentTime, one by
  // the recorder and one inside audio.js, each independently snapped to a
  // 128-frame block. probe() retries until no boundary falls between them, but
  // the residual that survives is bounded by the quantisation of the two reads,
  // which is 2 * 128/sampleRate and nothing else. That number comes out of the
  // Web Audio spec rather than out of a preference for round numbers, and the
  // signal it has to separate is 0 ms from 233 ms.
  const RESID = 2 * quantum;
  const impErr = Math.max(...impacts.map((r, i) => Math.abs(impLead[i] - r.d / SOS)));
  report.check('every impact distance matches distance/speed-of-sound individually',
    impErr <= RESID,
    `worst residual against distance/${SOS} across ${DISTS.length} distances ${ms(impErr)}, tolerance `
    + `2 x ${ms(quantum)} = ${ms(RESID)}, one quantum per clock read; 80 m expected ${ms(80 / SOS)} measured `
    + `${ms(impLead[DISTS.indexOf(80)])}; probe retries ${impacts.map((r) => r.retries).join('')}. ${cite('speed_of_sound_air')}`);

  // The bug the delay used to hide. noise() stopped its buffer source at
  // ctx.currentTime + duration + 0.05 — computed from NOW, not from the delayed
  // onset — so past a certain distance the entire envelope was written after the
  // source had already been stopped and the impact was silent. The cutoff is
  // measured rather than derived, because 'stone' duration is a constant and
  // constants lie.
  const dead = impacts.filter((r) => r.firstStop !== null && r.onset >= r.firstStop);
  const live = impacts.filter((r) => r.firstStop !== null && r.onset < r.firstStop);
  const cutoff = dead.length ? `${live.length ? live[live.length - 1].d : 0}..${dead[0].d} m` : `beyond ${DISTS[DISTS.length - 1]} m`;
  const far = impacts[impacts.length - 1];
  report.check('a delayed impact still has a live source at its own onset',
    dead.length === 0,
    `${dead.length}/${impacts.length} distances schedule the whole envelope after their noise source stopped `
    + `(${dead.map((r) => `${r.d}m: onset +${(1000 * (r.onset - r.ctxBefore)).toFixed(0)}ms vs stop +${(1000 * (r.firstStop - r.ctxBefore)).toFixed(0)}ms`).join(', ') || 'none'}) `
    + `— silent impacts would begin somewhere in ${cutoff}, inside SPEC.range of 220 m. Margin between onset `
    + `and stop at ${far.d} m: ${ms(far.firstStop - far.onset)}`);

  /* ------------------------------------------------- 4. distant gunfire -- */
  //
  // gunshot(distance) computes `distance / SPEED_OF_SOUND` and schedules every
  // element at T = now + lead + delay. Reading the source would tell you that;
  // only the scheduled onset can tell you whether the sound the listener gets
  // agrees, which is the entire reason this file measures onsets. Measured both
  // by direct probe (clean, one variable) and end-to-end through a real enemy
  // engagement (slow, but it is the path a player is on).
  const shots = [];
  for (const d of DISTS) {
    // eslint-disable-next-line no-await-in-loop
    shots.push({ d, ...(await sim.eval((dd) => window.__AUD.probe('gunshot', [dd]), d)) });
  }
  const gunLead = shots.map((r) => r.onset - r.ctxBefore);
  const gunSlope = slope(shots.map((r) => r.d), gunLead);
  const gunSpeed = 1 / gunSlope;

  report.check('gunshot() onset is delayed by distance at all',
    gunSlope > 0.5 / SOS,
    `onset lead vs distance: ${DISTS.map((d, i) => `${d}m:${(gunLead[i] * 1000).toFixed(1)}`).join(' ')} ms. `
    + `Slope ${gunSlope.toExponential(3)} s/m against the ${(1 / SOS).toExponential(3)} s/m that ${SOS} m/s `
    + 'requires — a flat line would mean the report leaves the muzzle and arrives at the ear in the same '
    + 'instant, which is what the brief for this suite claimed and what the negative control below refutes');
  report.reached('gunshot() implied speed of sound is a finite number', gunSpeed,
    `slope ${gunSlope.toExponential(3)} s/m gives ${fx(gunSpeed)} m/s`);
  report.against('gunshot() implied speed of sound', gunSpeed, 'audio', 'speed_of_sound_air');

  // The two propagation paths must agree, because they are supposed to be one
  // constant. audio.js had `343` written out twice — once in gunshot(), once in
  // impact() — and two literals that must stay equal are a divergence waiting
  // for whoever edits one of them. They are now a single SPEED_OF_SOUND, and
  // this is the check that notices if they stop being one: the tolerance is the
  // sourced +/-2 m/s, so a typo in either function fails here even though each
  // function on its own might still look plausible.
  report.check('gunshot() and impact() propagate at the same speed',
    Number.isFinite(gunSpeed) && Number.isFinite(impSpeed) && Math.abs(gunSpeed - impSpeed) <= SOS_TOL,
    `gunshot ${fx(gunSpeed)} m/s vs impact ${fx(impSpeed)} m/s, difference `
    + `${fx(Math.abs(gunSpeed - impSpeed))} m/s against the sourced +/-${SOS_TOL} m/s on ${SOS} m/s — one `
    + `constant, asserted through two independent call paths. ${cite('speed_of_sound_air')}`);

  const leadThr = sourcedAudio('av_desync_detectability_audio_leading').value;
  const lagThr = sourcedAudio('av_desync_detectability_audio_lagging').value;
  for (const d of [40, 80, 120]) {
    const i = DISTS.indexOf(d);
    report.check(`enemy report at ${d} m arrives ${(1000 * d / SOS).toFixed(0)} ms late`,
      Math.abs(gunLead[i] - d / SOS) <= RESID,
      `scheduled ${ms(gunLead[i])} after the shot, physics requires ${ms(d / SOS)}, error `
      + `${ms(gunLead[i] - d / SOS)} against a ${ms(RESID)} two-quantum tolerance; scheduling it instantly `
      + `instead would put the report ${((d / SOS) / leadThr).toFixed(1)}x past the ${ms(leadThr)} `
      + `audio-leads-video detectability threshold. ${cite('av_desync_detectability_audio_leading')}`);
  }
  // The asymmetry in BT.1359-1 is why the DIRECTION of a residual matters: early
  // sound is physically impossible, late sound is not, so an engine that must be
  // wrong should be late. One quantum of allowance, because the residual here is
  // instrument quantisation rather than design.
  const lateResid = gunLead[DISTS.indexOf(80)] - 80 / SOS;
  report.check('distant gunfire errs late rather than early',
    lateResid >= -quantum,
    `at 80 m the residual is ${ms(lateResid)} (positive = late); detectability is ${ms(leadThr)} early vs `
    + `${ms(lagThr)} late, so early is the ${(lagThr / leadThr).toFixed(1)}x more sensitive direction. `
    + cite('av_desync_detectability_audio_leading'));

  // The defect that WAS there. gunshot() delayed its envelope correctly and then
  // killed the sources underneath it: noise() stopped each buffer source at
  // ctx.currentTime + duration + 0.05, computed from NOW rather than from the
  // delayed onset. The crack element runs 0.06 s, so its source was stopped
  // 0.11 s from now, and any shot further away than 343 * 0.11 = 38 m had its
  // crack envelope written entirely after the source that would have carried it.
  // The crack is the 1.2 ms broadband transient that makes a gunshot read as a
  // gunshot; past ~38 m the player heard the body and the tail without it. The
  // low thump escaped because it is an oscillator started at T.
  // Measured, not derived: the stop times come off the recorder.
  const deadPer = shots.map((r) => r.stops.filter((s) => s < r.onset).length);
  const firstDead = shots.findIndex((r, i) => deadPer[i] > 0);
  const farShot = shots[shots.length - 1];
  report.check('a distant gunshot still has every source alive at its own onset',
    deadPer.every((n) => n === 0),
    'sources already stopped at the scheduled onset, by distance: '
    + `${DISTS.map((d, i) => `${d}m:${deadPer[i]}/${shots[i].nSources}`).join(' ')}. First element to die: `
    + `${firstDead < 0 ? `none out to ${DISTS[DISTS.length - 1]} m` : `between ${firstDead > 0 ? DISTS[firstDead - 1] : 0} and ${DISTS[firstDead]} m`}; `
    + `at ${farShot.d} m the earliest source stops ${ms(farShot.firstStop - farShot.ctxBefore)} in while the `
    + `envelope starts ${ms(gunLead[shots.length - 1])} in`);

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
    || [40, 80, 120].some((d) => Math.abs(ctrlLead[DISTS.indexOf(d)] - d / SOS) <= RESID);
  report.check('the distance-delay checks can go red (negative control)',
    !ctrlWouldPass,
    'a gunshot rebuilt with distance used for level only measures slope '
    + `${ctrlSlope.toExponential(3)} s/m and leads ${DISTS.map((d, i) => `${d}m:${(ctrlLead[i] * 1000).toFixed(1)}`).join(' ')} ms, `
    + `so the checks above ${ctrlWouldPass ? 'WOULD STILL PASS and are decorative' : 'correctly reject it'}. `
    + 'The real gunshot() passes them because src/audio.js applies distance/343 and always has — the '
    + "brief's claim that it does not is contradicted by an unmodified working tree");

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

  const fired = enemyShots.length > 0;
  report.check('an engaged enemy fired at all (end-to-end distant gunfire)', fired,
    `${enemyShots.length} audio.gunshot calls with a nonzero distance over 4.0 s, enemy placed ${fx(EN_D)} m `
    + `away down a ${fx(lane.clear)} m lane at ${lane.deg} deg — with no enemy shot the end-to-end distance `
    + 'delay could not be measured, so a zero here is an instrument failure rather than a passing game');
  if (fired) {
    // A DISTRIBUTION, not enemyShots[0]. The residual is deterministic here, so
    // the first sample happened to be representative — but "happened to be" is
    // not a property of the test, and the worst case over every shot is.
    const eLeads = enemyShots.map((c) => c.onset - c.ctxBefore);
    const eDists = enemyShots.map((c) => c.args[0]);
    const eResid = enemyShots.map((c, i) => eLeads[i] - eDists[i] / SOS);
    const worstResid = Math.max(...eResid.map(Math.abs));
    report.check('end-to-end: every real enemy report carries its propagation delay',
      worstResid <= RESID,
      `${enemyShots.length} enemy gunshots from ${fx(Math.min(...eDists))} to ${fx(Math.max(...eDists))} m; `
      + `worst residual ${ms(worstResid)}, median ${ms(med(eResid))}, against a ${ms(RESID)} two-quantum `
      + `tolerance. Median lead ${ms(med(eLeads))} at a median ${fx(med(eDists))} m, which requires `
      + `${ms(med(eDists) / SOS)}`);

    // A different observable with the same root cause, kept because it is the
    // one a player feels: enemyShoot resolves the round on the tick it is fired,
    // so the report's propagation delay IS the crack-to-report interval a player
    // uses to locate a shooter. There is no sourced figure for how long that
    // should be, so the magnitude is measured and only its SIGN is asserted — a
    // report arriving with or before the bullet is physically impossible, and
    // that is a real invariant rather than a threshold somebody picked.
    const worstEarly = Math.min(...eLeads);
    report.check('a distant report always arrives after the round that caused it',
      worstEarly > 0,
      `earliest lead over ${enemyShots.length} shots ${ms(worstEarly)}, median ${ms(med(eLeads))}; the round `
      + 'resolves on the tick it is fired, so a non-positive lead would mean the sound of the shot reached '
      + 'the player no later than the bullet did');
    report.measure('crack-to-report interval at the measured engagement range',
      med(eLeads) * 1000, 'ms',
      `median over ${enemyShots.length} shots at a median ${fx(med(eDists))} m. No sourced CoD figure for `
      + `this interval; for scale, a generic 5.56 muzzle velocity of 900 m/s puts the bullet's own flight at `
      + `${ms(med(eDists) / 900)}, so the report trails it by roughly ${ms(med(eLeads) - med(eDists) / 900)}`);

    // Same source-lifetime defect as the sweep, on the path a player is on, and
    // over every shot rather than the first.
    const eDead = enemyShots.map((c) => c.stops.filter((s) => s < c.onset).length);
    report.check('a real enemy report keeps every element it scheduled',
      eDead.every((n) => n === 0),
      `${eDead.reduce((s, n) => s + n, 0)} dead sources across ${enemyShots.length} reports of `
      + `${enemyShots[0].nSources} sources each, at a median ${fx(med(eDists))} m; earliest source stop is `
      + `${ms(Math.min(...enemyShots.map((c) => c.firstStop - c.ctxBefore)))} in against a median onset at `
      + `${ms(med(eLeads))}. The crack transient is the element that dies first, so a broken report is `
      + 'audible but hard to localise');
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

  report.check('hitmarker latency is measurable (a clear shot at an enemy)', !!aim.clear,
    `aimAt reported clear=${aim.clear} at ${fx(aim.distance)} m: world geometry at ${fx(aim.worldDist)} m `
    + `against the body at ${fx(aim.enemyDist)} m. With the wall in front no damage is applied and the `
    + 'hitmarker latency below would be a measurement of geometry');
  if (aim.clear) {
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
      const hmLeads = pairs.map((p) => p.lead);
      report.check('hitmarker is on the same tick as the damage it confirms',
        pairs.length === dmg.length && worstSim === 0,
        `${pairs.length}/${dmg.length} hits matched; worst simulated gap ${ms(worstSim)}, worst `
        + `AudioContext gap ${ms(worstAud)} = ${(worstAud / quantum).toFixed(2)} quanta`);
      report.check('every hitmarker is scheduled at least one render quantum ahead',
        hmLeads.every((l) => l >= quantum - 1e-9),
        `lead median ${ms(med(hmLeads))}, min ${ms(Math.min(...hmLeads))} over ${pairs.length} hits against a `
        + `${ms(quantum)} quantum; the hitmarker's attack is 4 ms, so a zero-lead schedule loses the first `
        + `${(quantum / 0.004 * 100).toFixed(0)}% of it to block clamping`);
      report.measure('hitmarker total latency at the ear', (worstSim + med(hmLeads) + platform) * 1000, 'ms',
        `${ms(worstSim)} simulated + ${ms(med(hmLeads))} engine lead + ${ms(platform)} platform path against a `
        + `${ms(ceiling)} ceiling. The engine contributes ${ms(worstSim + med(hmLeads))} of it and headless `
        + `Chromium the rest, which is why the ceiling is quoted rather than asserted. ${cite('competitive_audio_latency_ceiling')}`);

      // Ordering, over every sample rather than the first of seven. The
      // hitmarker is a UI cue and is right to be instant; impact('flesh', d) is
      // delayed by d/343, so the confirmation beep necessarily precedes the
      // sound of the round landing. That is not a defect — but the ORDER is an
      // invariant, and if it ever inverted either the hitmarker had grown a
      // delay or the flesh impact had lost its propagation.
      if (flesh.length) {
        const fLeads = flesh.map((c) => c.onset - c.ctxBefore);
        const worstMargin = Math.min(...fLeads) - Math.max(...hmLeads);
        report.check('the UI hit confirmation precedes the sound of the round landing',
          worstMargin > 0,
          `${flesh.length} flesh impacts lead by ${ms(med(fLeads))} median (min ${ms(Math.min(...fLeads))}) `
          + `against ${pairs.length} hitmarkers at ${ms(med(hmLeads))} median (max ${ms(Math.max(...hmLeads))}); `
          + `worst-case margin ${ms(worstMargin)} at ${fx(aim.distance)} m, where geometry requires `
          + `${ms(aim.distance / SOS)} of propagation for the impact and none for a UI beep`);
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

  report.check('damage-taken feedback latency is measurable', dmgTaken.length > 0,
    `the player took ${dmgTaken.length} hits over 6.0 s from an enemy at ${fx(DDIST)} m and `
    + `${hurtCalls.length} hurt cues were recorded; zero hits means hurt() latency was not measured at all, `
    + 'and both counts have to be zero together or the instrument disagrees with itself');
  if (dmgTaken.length) {
    const pairs = dmgTaken.map((d) => {
      const cue = hurtCalls.find((c) => c.sim === d.sim);
      return cue ? { dSim: cue.sim - d.sim, lead: cue.onset - cue.ctxBefore } : null;
    }).filter(Boolean);
    report.check('hurt cue is on the same tick as the damage the player takes',
      pairs.length === dmgTaken.length && pairs.every((p) => p.dSim === 0),
      `${dmgTaken.length} hits taken over 6.0 s at ${fx(DDIST)} m, ${hurtCalls.length} hurt cues, `
      + `${pairs.length} matched on the same tick; scheduling lead median ${ms(med(pairs.map((p) => p.lead)))}`);
  }

  /* ------------------------------------------------ 6. the reload track -- */
  //
  // Two reloads, measured entirely from the event log and the observed magazine
  // animation. Nothing here reads SPEC.reloadTime or the 0.08/0.50/0.72/0.86 cue
  // thresholds: the reload's duration is the interval over which `reloading` is
  // true, and the animation landmarks are read off magGroup.position.y as the
  // simulation actually moves it. That matters because the thresholds and the
  // animation comment in weapon.js used to DISAGREE — the comment described the
  // insert stroke ending at 0.72 and the seat click fired at 0.80 — and only the
  // observed animation could say which one the player sees. It is what decided
  // the repair, and it is still what is measured, so a re-timed stroke moves the
  // window with it instead of being asserted against a remembered number.
  //
  // The cue-to-animation windows are ITU-R BT.1359-1's detectability pair
  // (45 ms early / 125 ms late), not a tolerance of this file's choosing. An
  // earlier revision allowed the release click +/-50 ms, which is a number with
  // no provenance that happens to sit between the two sourced bounds and erases
  // the asymmetry that is the whole point of them.
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
    // reached(), not check(): everything below is derived from these two indices
    // and a -1 would arrive downstream as a plausible-looking zero duration.
    const dur = iOn >= 0 && iOff >= 0 ? rows[iOff].t - rows[iOn].rs : null;
    const ran = report.reached(`${kind} reload ran to completion`, dur,
      iOn < 0 || iOff < 0
        ? `reloading went ${iOn < 0 ? 'never true' : 'true but never false'} across 4.2 s; `
          + `${calls.length} mechanical cues fired, so the phase measurements below are absent, not zero`
        : `reloading was true for ${ms(dur)} across ${iOff - iOn} ticks of ${ms(DT_RELOAD)}`);
    if (!ran) continue;
    const start = rows[iOn].rs;
    report.check(`${kind} reload start timestamp agrees with the reloading flag`,
      Math.abs(start - rows[iOn].t) <= DT_RELOAD + 1e-9,
      `game-stamped reloadStart ${fx(start)} s vs first tick with reloading=true ${fx(rows[iOn].t)} s, gap `
      + `${ms(rows[iOn].t - start)}; measured duration ${ms(dur)} (+/-${ms(DT_RELOAD)} of tick quantisation)`);

    // Animation landmarks, read off the running simulation.
    const span = rows.slice(iOn, iOff + 1);
    const drop = span.find((r) => r.magY < -0.001);
    const bottom = span.reduce((b, r) => (r.magY < b.magY ? r : b), span[0]);
    const seated = span.find((r) => r.t > bottom.t && r.magY >= -0.0005);
    const ph = (t) => (t - start) / dur;

    const kinds = ['release', 'insert', 'seat'];
    const found = kinds.map((k) => calls.filter((c) => c.args[0] === k && c.sim >= start && c.sim <= rows[iOff].t));

    const onceEach = found.every((f) => f.length === 1);
    report.check(`${kind} reload fires each mechanical cue exactly once`, onceEach,
      kinds.map((k, i) => `${k}x${found[i].length}`).join(' ')
      + ` over ${ms(dur)}; other mechanical cues in the window: `
      + `${calls.filter((c) => !kinds.includes(c.args[0])).map((c) => c.args[0]).join(',') || 'none'}`);

    if (onceEach) {
      const [rel, ins, seat] = found.map((f) => f[0]);
      report.check(`${kind} reload cues are ordered release < insert < seat`,
        rel.sim < ins.sim && ins.sim < seat.sim,
        `phases ${ph(rel.sim).toFixed(3)} / ${ph(ins.sim).toFixed(3)} / ${ph(seat.sim).toFixed(3)} of a `
        + `${ms(dur)} reload, i.e. ${ms(rel.sim - start)} / ${ms(ins.sim - start)} / ${ms(seat.sim - start)} in`);

      // Does each cue land in the part of the animation it names? The windows
      // are the observed magazine motion, so a re-timed animation moves the
      // window with it and only a genuine mismatch fails.
      report.reached(`${kind} magazine visibly starts to drop`, drop ? ph(drop.t) : null,
        drop
          ? `first movement at phase ${ph(drop.t).toFixed(3)}, y ${fx(drop.magY)} m`
          : 'magY never went below -0.001 m during the reload, so there is no visible drop for the release '
            + 'click to be compared against (0 samples qualified)');
      const dropLag = drop ? rel.sim - drop.t : NaN;
      report.check(`${kind} 'release' click is inside the A/V detectability window of the magazine dropping`,
        Number.isFinite(dropLag) && dropLag <= lagThr && dropLag >= -leadThr,
        `release at phase ${ph(rel.sim).toFixed(3)}, magazine first moves at phase `
        + `${drop ? ph(drop.t).toFixed(3) : 'n/a'} — cue is ${ms(dropLag)} `
        + `${dropLag >= 0 ? 'after' : 'before'} the visible motion, against a window of ${ms(leadThr)} early `
        + `to ${ms(lagThr)} late. ${cite('av_desync_detectability_audio_leading')}`);

      report.check(`${kind} 'insert' fires while the magazine is travelling back in`,
        !!(bottom && seated) && ins.sim > bottom.t && ins.sim < seated.t,
        `insert at phase ${ph(ins.sim).toFixed(3)}, magazine bottoms out at ${ph(bottom.t).toFixed(3)} `
        + `(y ${fx(bottom.magY)} m) and is home by ${seated ? ph(seated.t).toFixed(3) : 'n/a'} — `
        + `${ms(ins.sim - bottom.t)} into a ${ms((seated?.t ?? NaN) - bottom.t)} insertion stroke`);

      // The A/V sync check with teeth, and the one that found the seat click
      // 183 ms (tactical) / 233 ms (empty) behind the picture. The gap is
      // measured against ITU-R BT.1359-1 rather than against a number of our
      // own, and both sides of it come off the running simulation: the cue's own
      // timestamp against the tick magGroup.position.y first reads home. It is
      // still able to disagree — the cue is gated on a phase in weapon.js, not
      // on the seated tick, so moving that phase by two ticks moves this number.
      const seatLag = seated ? seat.sim - seated.t : NaN;
      report.check(`${kind} 'seat' click is inside the A/V detectability window of the magazine seating`,
        Number.isFinite(seatLag) && seatLag <= lagThr && seatLag >= -leadThr,
        `magazine is visually home at phase ${seated ? ph(seated.t).toFixed(3) : 'n/a'} and the seat click `
        + `plays at ${ph(seat.sim).toFixed(3)}, ${ms(seatLag)} later on a ${ms(dur)} reload — `
        + `${(seatLag / lagThr).toFixed(2)}x the ${ms(lagThr)} lagging bound. ${cite('av_desync_detectability_audio_lagging')}`);
    }

    // weapon.js documents "0.86-1.0 bolt release (empty reload only)" and
    // audio.js defines a 'bolt' entry in the mechanical() spec table with its own
    // frequency, amplitude and duration. Nothing called it, so the sound existed
    // and was unreachable. This is not a latency defect but it is the same
    // instrument reading it: a mechanical event the reload track claims exists.
    //
    // Both halves are asserted, because "fire it always" is the wrong repair and
    // is invisible from the empty side alone: the bolt is only locked back when
    // the magazine ran dry, so a tactical reload has nothing to release.
    const bolt = calls.filter((c) => c.args[0] === 'bolt' && c.sim >= start && c.sim <= rows[iOff].t);
    if (empty) {
      report.check('empty reload plays the bolt-release cue its own track documents',
        bolt.length === 1,
        `${bolt.length} 'bolt' cues over a ${ms(dur)} empty reload, at phase `
        + `${bolt.map((b) => ph(b.sim).toFixed(3)).join('/') || 'n/a'} against the 0.86-1.0 bolt-release `
        + 'phase weapon.js documents; audio.mechanical has a full \'bolt\' voice defined (2100 Hz, 0.16 s) '
        + 'and a count of zero means onReloadEvent is never called with it');
    } else {
      report.check('tactical reload does not cycle the bolt',
        bolt.length === 0,
        `${bolt.length} 'bolt' cues over a ${ms(dur)} tactical reload — the bolt is only held back by an `
        + 'empty magazine, so a cue here would be a sound with no mechanism behind it');
    }
  }

  /* ------------------------------------------------- 7. coverage honesty -- */
  const tierEntry = sourcedAudio('competitive_audio_latency_target');
  report.check('audio latency bounds are sourced non-CoD engineering guidance, not CoD figures',
    /non-CoD/i.test(tierEntry.title ?? ''),
    `the audio domain carries ${Object.keys(TARGETS.audio).length} targets and the perceptual thresholds are `
    + `labelled "${(tierEntry.title ?? '').slice(0, 60)}" — no published Call of Duty audio-latency figure `
    + 'exists, so every latency bound above is general game-audio literature and says so in its own detail');
}
