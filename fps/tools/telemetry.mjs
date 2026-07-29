// telemetry.mjs — record four gameplay traces, generate four reference traces,
// and write them out blinded for judging.
//
// WHY THIS EXISTS. The five measurement suites assert scalars: an ADS time, a
// TTK, a reaction median, a jump apex. They are green. What a scalar cannot say
// is whether the SHAPE is right — whether a recoil path climbs the way a
// shipped shooter's climbs, whether a sprint ramp has the same knees, whether a
// TTK distribution has the same tails, whether an AI engagement has the same
// rhythm. A clone can hit 119 numbers and still read wrong. So: record the
// shapes, generate reference shapes, strip the labels, and let independent
// judges say which is which.
//
// ==========================================================================
// THE HONESTY CONSTRAINT. READ THIS BEFORE READING ANY NUMBER BELOW.
// ==========================================================================
//
// There is NO real telemetry from a shipped Call of Duty anywhere in this file
// or in anything it writes. There is no network access in this environment
// (every host 403s through the proxy), no game binary and no capture. A file
// claiming to be a recording from a shipped title would be a fabrication, and
// this project has already been damaged once by plausible-looking invented
// numbers.
//
// What the reference traces ARE: analytic traces generated from the sourced
// values in tools/targets.mjs. Each generator names, in its own metadata, the
// exact targets.mjs keys it consumed and the formula it applied. Every
// reference file carries
//
//   "provenance": "synthesised from targets.mjs keys [...] — NOT a recording
//                  from a shipped title"
//
// and the judges are told the same thing. The comparison is still meaningful:
// if our recordings are indistinguishable from traces generated from the
// documented model, we match that model in shape as well as in scalar value.
// Where a judge can reliably tell them apart, the difference is a bug list.
//
// WHERE THE DOCUMENTED MODEL RUNS OUT. targets.mjs is deliberately thin where
// the research was thin, and three of the four metrics need a parameter it does
// not have:
//
//   recoil    recoil.per_shot_vertical_kick_degrees, .per_shot_horizontal_kick
//             _degrees and .total_vertical_climb_after_n_rounds_degrees are all
//             `value: null` — "would be; none published". So the MAGNITUDE of
//             the reference recoil path cannot be sourced. Its STRUCTURE can:
//             recoil.recoil_determinism (one random vertical and one random
//             horizontal draw per shot inside authored bounds) and
//             recoil.recoil_recentering_behaviour (recentre toward the PREVIOUS
//             aim point at a per-weapon centre speed, immediately on firing,
//             never fully between rounds — "sustained climb is emergent").
//             The two bound-magnitudes and the centre speed are therefore taken
//             from the codebase (weapon.js SPEC) and declared as borrowed. This
//             metric tests SHAPE ONLY: curvature of the climb, growth of the
//             envelope, the statistics of the horizontal walk. It cannot and
//             does not test magnitude.
//
//   velocity  Speeds are sourced; the ACCELERATION that reaches them is not.
//             No key in targets.mjs describes a ground-acceleration rate or a
//             friction rate. The reference uses the textbook accelerate-and-
//             friction ground move with the codebase's own rates, declared as
//             borrowed. Sourced and therefore real in this metric: the plateau
//             speeds, the jump ballistics, the slide envelope, near-zero air
//             control, and the 60 Hz grid.
//
//   ai        Only the reaction band is sourced (ai.ai_reaction_delay_base,
//             ai.ai_reaction_delay_range). Burst length, intra-burst spacing,
//             inter-burst interval, AI per-round damage and AI aim error have
//             no published figure in any title; all five are borrowed from
//             ai.js CONFIG and declared.
//
//   ttk       This one is almost entirely sourced: damage bands, both range
//             stops, shots-to-kill, health, rpm, muzzle velocity, the 20 Hz
//             instant-hit radius, the torso multiplier. Borrowed: the torso and
//             head box geometry a missed round has to miss (no title publishes
//             hitbox extents) and, for the uncompensated shooter, the same
//             borrowed recoil magnitudes as above.
//
// A borrowed parameter makes that axis of the comparison weaker, not dishonest,
// as long as it is declared. All of them are, per file, per key.
//
// ==========================================================================
// SANITY-CHECKING THE INSTRUMENT — the tells that were removed on purpose
// ==========================================================================
//
// A judge who wins on a formatting artifact has told us nothing about the game.
// So, deliberately:
//
//   ONE TIME GRID. The simulation advances in fixed 1/60 s ticks and nothing
//   observable happens between two of them, so every recording is driven at
//   dt = 1/60 (exactly one tick per call) and every reference is integrated on
//   the same grid, from tick 0, with the same number of ticks. Reference event
//   times are quantised to that grid too — which is not a concession to us but
//   the documented model: physics.multiplayer_server_tick_rate is 60 Hz, so a
//   60 Hz authority is what the reference is supposed to have.
//
//   ONE SHOT SCHEDULE RULE. A round fires on the first tick at or after the
//   nominal cadence time, and the nominal accumulator keeps its phase rather
//   than being reset to the tick. Both sides. That is what makes a 682 rpm
//   weapon on a 60 Hz tick alternate 5- and 6-tick gaps on BOTH sides instead
//   of one side showing 87.9 ms intervals no 60 Hz game can produce.
//
//   ONE SERIALISER. Row objects for both sides are built by the same function
//   per metric (see METRICS below), so key names, key order, column count and
//   decimal precision cannot diverge. Every numeric field is rounded to the
//   same number of decimals on both sides.
//
//   MATCHED SAMPLE COUNTS. The generators are handed the recorded shape —
//   magazine count, tick counts, engagements per range — and produce exactly
//   that many rows. Never the measured VALUES, only the counts and the event
//   schedule.
//
//   MATCHED MISSING DATA. An engagement that does not produce a kill writes
//   null, not Infinity and not a silently dropped row, on both sides.
//
// Tells that remain are documented in the report and are properties of the
// GAME, not of this file: they are findings, not formatting.
//
// ==========================================================================
// USAGE
// ==========================================================================
//
//   node tools/telemetry.mjs                  record, generate, blind, write
//   node tools/telemetry.mjs --only=recoil    one metric (comma-separated)
//   node tools/telemetry.mjs --selfcheck      grid/shape checks, no recording
//
// Output: fps/tools/traces/<metric>-A.json, <metric>-B.json, README.md, and the
// answer key at fps/tools/.trace-key.json — deliberately OUTSIDE traces/.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openSim } from './_sim.mjs';
import { TARGETS } from './targets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRACES = path.join(HERE, 'traces');
const KEYFILE = path.join(TRACES, '..', '.trace-key.json');

/** The simulation's own tick. Everything on both sides lives on this grid. */
const TICK = 1 / 60;
const DT = TICK;
const DEG = 180 / Math.PI;

/* ------------------------------------------------------------- targets -- */

/**
 * Reads a sourced value by key, and throws if the key is absent or qualitative.
 *
 * The same discipline report.against() enforces in the suites, for the same
 * reason: a generator that could fall back to a literal would drift away from
 * the research silently, and "which key produced this trace" is the only claim
 * the reference files make about themselves.
 */
function T(domain, key) {
  const e = TARGETS[domain]?.[key];
  if (!e) throw new Error(`telemetry: no ${domain}.${key} in targets.mjs`);
  if (e.value === null || typeof e.value !== 'number') {
    throw new Error(`telemetry: ${domain}.${key} has no numeric value (${JSON.stringify(e.value)}) — `
      + 'it cannot generate anything. Use band() for a min/max entry or quote the note.');
  }
  return e.value;
}
/** The min/max band of an entry whose tolerance IS the reference (value: null). */
function band(domain, key) {
  const e = TARGETS[domain]?.[key];
  if (!e) throw new Error(`telemetry: no ${domain}.${key} in targets.mjs`);
  const tol = e.tol ?? {};
  if (tol.min === undefined || tol.max === undefined) {
    throw new Error(`telemetry: ${domain}.${key} has no min/max band`);
  }
  return [tol.min, tol.max];
}
/**
 * Quotes the qualitative keys a generator's STRUCTURE comes from.
 *
 * The numeric keys are checked by T() and appear in the formula; the qualitative
 * ones are the reason the model has the shape it has, and a claim to have
 * followed them is only checkable if the text comes out of targets.mjs rather
 * than out of a paraphrase. Throws on an unknown key, exactly like T().
 */
function quotes(pairs) {
  const out = {};
  for (const [domain, key] of pairs) {
    const e = TARGETS[domain]?.[key];
    if (!e) throw new Error(`telemetry: no ${domain}.${key} in targets.mjs to quote`);
    out[`${domain}.${key}`] = String(e.note ?? e.value).slice(0, 260);
  }
  return out;
}

/* ------------------------------------------------------ borrowed values -- */
//
// Every number here is a parameter the reference generators need and targets.mjs
// does not have. They are read from the running game where possible (so they
// cannot drift from the code) and named here with the key that WOULD have
// supplied them if the research had found one. Nothing in this block is a Call
// of Duty figure and no reference file claims otherwise.

const BORROWED_NOTES = {
  recoilVerticalMin: 'weapon.js SPEC.recoilVerticalMin — recoil.per_shot_vertical_kick_degrees is null',
  recoilVerticalMax: 'weapon.js SPEC.recoilVerticalMax — recoil.per_shot_vertical_kick_degrees is null',
  recoilHorizontalMin: 'weapon.js SPEC.recoilHorizontalMin — recoil.per_shot_horizontal_kick_degrees is null',
  recoilHorizontalMax: 'weapon.js SPEC.recoilHorizontalMax — recoil.per_shot_horizontal_kick_degrees is null',
  recoilCenterSpeed: 'weapon.js SPEC.recoilCenterSpeed — recoil.recoil_recentering_behaviour names a '
    + '"per-weapon centre speed" but publishes no rate',
  recoilAdsScale: 'weapon.js SPEC.recoilAdsScale — recoil.ads_vs_hipfire_recoil_multiplier is null '
    + '("none exists")',
  groundAccel: 'player.js TUNING.groundAccel — no acceleration rate is published in any domain',
  friction: 'player.js TUNING.friction — no ground friction rate is published',
  airDrag: 'player.js TUNING.airDrag — movement.air_control is qualitative only',
  torsoHalfWidth: 'player.js TUNING.radius as the torso half-width; no title publishes hitbox extents',
  torsoHeight: 'player.js TUNING.standHeight as the body height; no title publishes hitbox extents',
  aiBurstCount: 'ai.js CONFIG.burstCount — no published AI burst length',
  aiBurstDelay: 'ai.js CONFIG.burstDelay — no published intra-burst spacing',
  aiFireInterval: 'ai.js CONFIG.fireInterval — no published inter-burst interval',
  aiDamage: 'ai.js CONFIG.damage / main.js hitPlayer 11-16 HP — no published AI per-round damage',
  aiAimErrorMetres: 'ai.js CONFIG.aimErrorMetres — no published AI aim error',
  aiAimErrorAngle: 'ai.js CONFIG.aimErrorAngle — no published AI aim error',
  aiAimErrorFloorRange: 'ai.js CONFIG.aimErrorFloorRange — no published AI aim error',
};

/** Pulls the borrowed parameters out of the running page, so they cannot drift. */
async function readBorrowed(sim) {
  const b = await sim.eval(async () => {
    const w = await import('/src/weapon.js');
    const p = await import('/src/player.js');
    const S = w.SPEC, U = p.TUNING;
    return {
      recoilVerticalMin: S.recoilVerticalMin,
      recoilVerticalMax: S.recoilVerticalMax,
      recoilHorizontalMin: S.recoilHorizontalMin,
      recoilHorizontalMax: S.recoilHorizontalMax,
      recoilCenterSpeed: S.recoilCenterSpeed,
      recoilAdsScale: S.recoilAdsScale,
      groundAccel: U.groundAccel,
      friction: U.friction,
      airDrag: U.airDrag,
      torsoHalfWidth: U.radius,
      torsoHeight: U.standHeight,
    };
  });
  // ai.js does not export CONFIG, so these four are written here and checked
  // against the behaviour they are supposed to describe by the ai suite, not by
  // a read. They are borrowed either way; a literal that says so beats a read
  // that pretends to be sourced.
  return {
    ...b,
    aiBurstCount: [2, 5],
    aiBurstDelay: 0.098,
    aiFireInterval: [0.42, 1.15],
    aiDamage: [11, 16],
    aiAimErrorMetres: 0.18,
    aiAimErrorAngle: 0.030,
    aiAimErrorFloorRange: 4,
  };
}

/* ----------------------------------------------------------------- rng --- */

/**
 * The generators' randomness, seeded and explicit.
 *
 * Fixed seed so a reference trace is reproducible from the file that made it —
 * a reference nobody can regenerate is as unfalsifiable as an invented one.
 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const REF_SEED = 0x51ED7ACE;

/* -------------------------------------------------------------- helpers -- */

const q = (v, dp) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(dp)));
const sortNum = (a) => a.slice().sort((x, y) => x - y);
function quantile(a, p) {
  const f = a.filter((v) => v !== null && Number.isFinite(v));
  if (!f.length) return null;
  const s = sortNum(f);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
const median = (a) => quantile(a, 0.5);
const f3 = (v) => (v === null || !Number.isFinite(v) ? 'none' : v.toFixed(3));
const ms = (v) => (v === null || !Number.isFinite(v) ? 'none' : `${(v * 1000).toFixed(1)} ms`);

/**
 * Shot schedule for a held trigger: the tick each round leaves on.
 *
 * The rule is weapon.js's and it is also the only rule a fixed-tick authority
 * can implement without changing the weapon's mean cadence: the nominal time
 * advances by exactly one interval per round (phase preserved) and the round
 * leaves on the first tick at or after it. Used by BOTH sides — the recorder
 * only observes it, the generator reproduces it — so neither side can be spotted
 * by its inter-shot intervals.
 */
function shotTicks(n, interval, tick = TICK) {
  const out = [];
  let nominal = 0;
  for (let i = 0; i < n; i++) {
    out.push(Math.ceil(nominal / tick - 1e-9));
    nominal += interval;
  }
  return out;
}

/* ============================================================= metrics == */
//
// One entry per metric. `row` is the ONLY place a row object is built, for
// either side, which is what makes key names and precision structurally
// identical. `columns` is what the judges' README documents.

const METRICS = {
  recoil: {
    columns: {
      mag: 'magazine index, 0-based',
      stance: '1 = aimed down sights, 0 = hipfire',
      round: 'round number within the magazine, 1-based',
      t: 'seconds since the first round of that magazine',
      dpitch: 'degrees of aim elevation relative to the first round of that magazine (up is positive)',
      dyaw: 'degrees of aim azimuth relative to the first round of that magazine (right is positive)',
    },
    row: (r) => ({
      mag: r.mag, stance: r.stance, round: r.round,
      t: q(r.t, 6), dpitch: q(r.dpitch, 4), dyaw: q(r.dyaw, 4),
    }),
  },
  velocity: {
    columns: {
      move: 'manoeuvre id: 0 standing start to full sprint, 1 sprint into a hard direction change, '
        + '2 slide from sprint, 3 jump from sprint',
      t: 'seconds since the start of the manoeuvre',
      speed: 'horizontal speed, m/s',
      vy: 'vertical velocity, m/s (up positive)',
      air: '1 while the body is airborne, 0 while it is in contact with the ground',
    },
    row: (r) => ({
      move: r.move, t: q(r.t, 6), speed: q(r.speed, 4), vy: q(r.vy, 4), air: r.air,
    }),
  },
  ttk: {
    columns: {
      range: 'engagement range, m',
      comp: '1 = the shooter compensates for recoil, 0 = the shooter holds the trigger and does not',
      eng: 'engagement index within that range and condition, 0-based',
      ttk: 'seconds from the first round landing to the fatal one, or null if the target survived '
        + 'the magazine (this is the convention the published figures use: it excludes the first '
        + "round's flight)",
      tkill: 'seconds from the trigger breaking to the fatal round landing, or null',
      stk: 'rounds that landed on the target up to and including the fatal one, or null',
      fired: 'rounds that left the barrel during the engagement',
    },
    row: (r) => ({
      range: r.range, comp: r.comp, eng: r.eng,
      ttk: q(r.ttk, 6), tkill: q(r.tkill, 6), stk: r.stk ?? null, fired: r.fired,
    }),
  },
  ai: {
    columns: {
      range: 'engagement range, m',
      eng: 'engagement index, 0-based',
      sight: 'seconds from the start of the engagement to the first instant the enemy can see the '
        + 'player — 0 by construction: every engagement begins with the line of sight already open '
        + 'and verified',
      shot: 'seconds from first sight to the first round leaving the enemy barrel',
      hit: 'seconds from first sight to the first round arriving on the player, or null if none did',
      kill: 'seconds from first sight to the player dying, or null if he survived the window',
      shots: 'array of seconds-from-first-sight at which each round left the barrel',
      bursts: 'array of [start, end] seconds-from-first-sight, one per burst, where a burst is a run '
        + 'of rounds with no gap longer than 0.25 s inside it',
      rounds: 'rounds fired in the window',
      hits: 'rounds that arrived on the player',
    },
    row: (r) => ({
      range: r.range, eng: r.eng,
      sight: q(r.sight, 6), shot: q(r.shot, 6), hit: q(r.hit, 6), kill: q(r.kill, 6),
      shots: r.shots.map((v) => q(v, 6)),
      bursts: r.bursts.map(([a, b]) => [q(a, 6), q(b, 6)]),
      rounds: r.rounds, hits: r.hits,
    }),
  },
};

/** Groups shot times into bursts. One definition, used by both sides. */
const BURST_GAP = 0.25;
function bursts(times) {
  const out = [];
  let cur = null;
  for (const t of times) {
    if (!cur) cur = [t, t];
    else if (t - cur[1] > BURST_GAP) { out.push(cur); cur = [t, t]; }
    else cur[1] = t;
  }
  if (cur) out.push(cur);
  return out;
}

/* ====================================================== the recordings == */

const BASE_INPUT = {
  forward: false, back: false, left: false, right: false,
  sprint: false, crouch: false, ads: false, fire: false,
};
const IN = (over = {}) => `return ${JSON.stringify({ ...BASE_INPUT, ...over })};`;

/* -------------------------------------------------------- 1. recoil ----- */

// Ten magazines per stance, not four. Four was enough to see the climb and not
// enough to see the ENVELOPE: the lateral walk's endpoint has a standard
// deviation of about 0.28 deg either side, so a four-sample draw can land four
// small same-signed values by luck — which it did, and one side of the pair then
// looked systematically tamer than the other for no reason that was in the model.
// A sampling accident that a judge could win on is a tell in the instrument.
const RECOIL_PLAN = { magazines: 10, rounds: 30, stances: [1, 0] };

/**
 * Per-round aim, for a full magazine, several magazines, ADS and hipfire.
 *
 * Recorded at the barrel rather than off the sample rows: the aim that matters
 * is the one the round leaves on, and a sampled trace can only say which tick it
 * happened in. weapon.fire() is wrapped, the aim is read BEFORE the original
 * runs, and the wrapper only records when a round was actually produced —
 * fire() is polled every tick the trigger is held and returns null on four of
 * every five.
 *
 * Reading the aim before the kick this round adds is not a convenience: a round
 * cannot be deflected by its own recoil, and the reference generator uses the
 * same convention.
 */
async function recordRecoil(sim) {
  await sim.eval(() => {
    const g = window.__GAME;
    window.__TEL = window.__TEL || {};
    if (window.__TEL.fireTapped) return;
    const original = g.weapon.fire.bind(g.weapon);
    window.__TEL.shots = [];
    g.weapon.fire = (now, player) => {
      const pitch = player.pitch + player.recoilPitch;
      const yaw = player.yaw + player.recoilYaw;
      const shot = original(now, player);
      if (shot) window.__TEL.shots.push({ t: g.elapsed, pitch, yaw, ads: player.ads });
      return shot;
    };
    window.__TEL.fireTapped = true;
  });

  const rows = [];
  const lane = await sim.clearLane([-6, null, 17], 60);
  const yaw = lane.deg * Math.PI / 180 + Math.PI;
  for (const stance of RECOIL_PLAN.stances) {
    for (let mag = 0; mag < RECOIL_PLAN.magazines; mag++) {
      await sim.setup({ position: [-6, null, 17], yaw, ads: stance });
      // The ADS blend has to be SETTLED before the first round, not merely
      // requested. setup() zeroes every boolean input, so the settling step it
      // takes runs one tick with ads released: weapon.update's own blend is at 0
      // and it overwrites player.ads with it, discarding the ads:1 setup was
      // asked for. Firing straight away therefore spent the first three rounds
      // of every "aimed" magazine climbing the 0.27 s ADS transition at hipfire
      // recoil scale, which is not the condition this trace claims to be.
      // Measured before the fix: round 1 of an aimed magazine kicked 0.00586 rad,
      // above the 0.00541 rad ADS ceiling, because the scale was still 1.0.
      await sim.drive({ seconds: 0.45, dt: DT, input: IN({ ads: !!stance }) });
      await sim.eval(() => { window.__TEL.shots.length = 0; });
      // 30 rounds at 88 ms is 2.64 s; 3.0 s of held trigger covers the magazine
      // with room for the tick-quantised tail and stops before the reload.
      await sim.drive({ seconds: 3.0, dt: DT, input: IN({ fire: true, ads: !!stance }) });
      const shots = await sim.eval(() => window.__TEL.shots.slice());
      if (shots.length !== RECOIL_PLAN.rounds) {
        throw new Error(`telemetry recoil: magazine ${mag} stance ${stance} produced ${shots.length} `
          + `rounds, expected ${RECOIL_PLAN.rounds} — the trace would not be a magazine`);
      }
      const t0 = shots[0].t, p0 = shots[0].pitch, y0 = shots[0].yaw;
      shots.forEach((s, i) => rows.push({
        mag, stance, round: i + 1,
        t: s.t - t0, dpitch: (s.pitch - p0) * DEG, dyaw: (s.yaw - y0) * DEG,
      }));
    }
  }
  return rows;
}

/* ------------------------------------------------------ 2. velocity ----- */
//
// The manoeuvre schedule, in TICKS, shared by the recorder and the generator so
// the two traces cannot differ in their time grid or their event times.

const MOVES = [
  { id: 0, name: 'standing start to full sprint', ticks: 180, events: {} },
  { id: 1, name: 'sprint into a hard direction change', ticks: 180, events: { turn: 60 } },
  { id: 2, name: 'slide from sprint', ticks: 180, events: { crouch: 72 } },
  { id: 3, name: 'jump from sprint', ticks: 180, events: { jump: 60 } },
];
/** The direction change, in radians. A 90 degree flick with forward still held. */
const TURN = Math.PI / 2;

async function recordVelocity(sim) {
  // A provably flat support surface. Measured on the terrain, a speed curve
  // carries the gradient of whatever the body ran over, and the reference has no
  // terrain to carry.
  const base = await sim.eval(() => {
    const g = window.__GAME, THREE = window.__THREE;
    window.__TEL = window.__TEL || {};
    window.__TEL.addBox = (min, max) => {
      g.level.colliders.push(new THREE.Box3(
        new THREE.Vector3(min[0], min[1], min[2]), new THREE.Vector3(max[0], max[1], max[2])));
      return g.level.colliders.length;
    };
    window.__TEL.trim = (n) => { g.level.colliders.length = n; };
    window.__TEL.reset = () => {
      const p = g.player;
      p.crouching = false; p.height = p.targetHeight = 1.82;
      p.ads = p.adsTarget = 0;
      p._mantle = null; p._sliding = false; p._slideEnd = -99; p._prevCrouch = false;
    };
    return g.level.colliders.length;
  });

  const site = await sim.eval((cfg) => {
    const g = window.__GAME, L = g.level, THREE = window.__THREE;
    const box = new THREE.Box3();
    const { hx, hz } = cfg;
    let best = null;
    for (let cx = -50; cx <= 50; cx += 2) {
      for (let cz = -50; cz <= 50; cz += 2) {
        let tmax = -1e9, tmin = 1e9;
        for (let x = cx - hx; x <= cx + hx; x += 1.5) {
          for (let z = cz - hz; z <= cz + hz; z += 1.5) {
            const h = L.groundHeight(x, z);
            if (h > tmax) tmax = h;
            if (h < tmin) tmin = h;
          }
        }
        box.min.set(cx - hx, tmin - 4, cz - hz);
        box.max.set(cx + hx, tmax + 4, cz + hz);
        let hits = 0;
        for (const c of L.colliders) if (box.intersectsBox(c)) hits++;
        if (hits) continue;
        const d = Math.hypot(cx, cz);
        if (!best || d < best.d) best = { cx, cz, tmax, tmin, d };
      }
    }
    if (!best) return null;
    const top = best.tmax + 2.0;
    window.__TEL.addBox([best.cx - hx, best.tmin - 4, best.cz - hz], [best.cx + hx, top, best.cz + hz]);
    return { ...best, top, hx, hz };
  }, { hx: 22, hz: 22 });
  if (!site) throw new Error('telemetry velocity: no collider-free patch to build a flat platform on');

  const rows = [];
  try {
    // Facing +x, starting on the -x edge so 3 s of sprint stays on the slab.
    const yaw = Math.atan2(-1, 0);   // forward = (-sin yaw, -cos yaw) = (+1, 0)
    const pos = [site.cx - site.hx + 3, site.top + 0.01, site.cz];
    for (const move of MOVES) {
      await sim.setup({ position: pos, yaw, ads: 0 });
      await sim.eval(() => window.__TEL.reset());
      // A quarter second of nothing first: spawning 10 mm clear means the first
      // ticks are a fall, and a fall inside the window is air acceleration where
      // the reader expects ground acceleration.
      await sim.drive({ seconds: 0.25, dt: DT, input: IN() });
      const ev = move.events;
      const input = `
        ${ev.turn !== undefined ? `if (i === ${ev.turn}) g.player.yaw += ${TURN};` : ''}
        ${ev.jump !== undefined ? `if (i === ${ev.jump}) g.player.requestJump(g.elapsed);` : ''}
        const crouch = ${ev.crouch !== undefined ? `i >= ${ev.crouch}` : 'false'};
        return Object.assign(${JSON.stringify(BASE_INPUT)},
          { forward: true, sprint: true, crouch });
      `;
      const trace = await sim.drive({ ticks: move.ticks, dt: DT, input });
      const t0 = trace[0].t - TICK;
      for (const r of trace) {
        rows.push({
          move: move.id, t: r.t - t0, speed: r.speed, vy: r.vy, air: r.onGround ? 0 : 1,
        });
      }
    }
  } finally {
    await sim.eval((n) => { window.__TEL.trim(n); window.__TEL.reset(); }, base);
  }
  return rows;
}

/* ----------------------------------------------------------- 3. TTK ----- */

const TTK_RANGES = [10, 25, 45, 60, 80, 120];
const TTK_TRIALS = 10;
const TTK_SECONDS = 3.2;

async function recordTtk(sim) {
  const HOME = [-6, null, 17];
  const lane = await sim.clearLane(HOME, 210);
  if (lane.clear < 205) {
    throw new Error(`telemetry ttk: longest clear lane is ${lane.clear.toFixed(1)} m; a 120 m `
      + 'engagement would be a measurement of a wall');
  }
  const a = lane.deg * Math.PI / 180;
  const laneYaw = a + Math.PI;
  const at = (R) => ({ x: HOME[0] + Math.sin(a) * R, z: HOME[2] + Math.cos(a) * R });

  // Holdover. Rounds fall, and a 120 m engagement aimed dead at the chest is a
  // measurement of the ground rather than of the damage model. The coefficient
  // is fitted once from the game's own gravity and muzzle velocity rather than
  // tuned: drop = g d^2 / 2v^2, so the elevation is g d / 2v^2.
  const dropK = await sim.eval(async () => {
    const p = await import('/src/player.js');
    return p.TUNING.gravity / (2 * 750 * 750);
  });

  const aimBody = (compensate) => `
    const pl = g.player, en = g.director.enemies[0];
    if (en && en.alive) {
      const V = g.camera.position.constructor;
      const at = en.chestPosition(new V());
      const eye = g.camera.position;
      const ax = at.x - eye.x, ay = at.y - eye.y, az = at.z - eye.z;
      const d = Math.hypot(ax, az);
      pl.yaw = Math.atan2(-ax, -az);
      pl.pitch = Math.atan2(ay, d) + ${dropK} * d;
      ${compensate ? 'pl.recoilPitch = 0; pl.recoilYaw = 0; pl._recoilPitchVel = 0; pl._recoilYawVel = 0;' : ''}
    }
    return ${JSON.stringify({ ...BASE_INPUT, fire: true, ads: true })};
  `;

  const rows = [];
  for (const comp of [1, 0]) {
    for (const R of TTK_RANGES) {
      for (let eng = 0; eng < TTK_TRIALS; eng++) {
        const p = at(R);
        await sim.setup({
          position: HOME, yaw: laneYaw, ads: 1, ammo: 30,
          enemies: [{ x: p.x, z: p.z, inert: true, health: 100 }],
        });
        await sim.tapEvents();
        const pre = await sim.aimAt(0);
        // Settle the sights before the trigger, for the reason recordRecoil
        // documents: an engagement that starts on tick zero spends its first
        // three rounds inside the ADS transition, at hipfire recoil scale and
        // hipfire cone, and those are exactly the rounds a TTK is made of.
        await sim.drive({ seconds: 0.45, dt: DT, input: IN({ ads: true }) });
        await sim.clearEvents();
        if (!pre.clear) {
          throw new Error(`telemetry ttk: no clear shot at ${R} m (zone ${pre.zone}, world `
            + `${pre.worldDist?.toFixed?.(1)} m) — every miss below would be a wall`);
        }
        // The uncompensated condition still re-points at the chest every tick;
        // what it does not do is undo the view kick. Both conditions therefore
        // differ in exactly one thing, which is what the metric is about.
        const trace = await sim.drive({
          seconds: TTK_SECONDS, dt: DT, input: aimBody(!!comp),
          sample: 'const e = g.director.enemies[0]; return { ealive: e && e.alive ? 1 : 0, ehp: e ? e.health : null };',
        });
        const ev = await sim.events();
        const dmg = ev.filter((e) => e.kind === 'enemy.applyDamage').map((e) => e.sim);
        const shots = ev.filter((e) => e.kind === 'audio.gunshot').map((e) => e.sim);
        const deadAt = trace.find((r) => r.ealive === 0)?.t ?? null;
        const landed = deadAt === null ? dmg : dmg.filter((t) => t <= deadAt + 1e-9);
        const killed = deadAt !== null && landed.length >= 1;
        let fired = 0, prev = 30;
        for (const r of trace) { if (r.ammo < prev) { fired += prev - r.ammo; prev = r.ammo; } else if (r.ammo > prev) break; }
        rows.push({
          range: R, comp, eng,
          ttk: killed && landed.length >= 2 ? landed[landed.length - 1] - landed[0] : null,
          tkill: killed && shots.length ? landed[landed.length - 1] - shots[0] : null,
          stk: killed ? landed.length : null,
          fired,
        });
      }
    }
  }
  return rows;
}

/* ------------------------------------------------------------ 4. AI ----- */

const AI_RANGES = [12, 20, 28, 36];
const AI_TRIALS = 6;
const AI_SECONDS = 14;

async function recordAi(sim) {
  await sim.eval(async () => {
    const g = window.__GAME;
    const ai = await import('/src/ai.js');
    window.__TEL = window.__TEL || {};
    if (window.__TEL.aiTapped) return;
    window.__TEL.fires = [];
    window.__TEL.hits = [];
    window.__TEL.death = null;
    const shoot0 = ai.Enemy.prototype.shoot;
    ai.Enemy.prototype.shoot = function (player, distance) {
      window.__TEL.fires.push({ t: g.elapsed, dist: distance });
      return shoot0.apply(this, arguments);
    };
    // The player's own damage entry point, on the prototype so setup()'s
    // instance stub cannot hide it and a vulnerable run cannot silently record
    // nothing.
    const P = Object.getPrototypeOf(g.player);
    const dmg0 = P.damage;
    P.damage = function (amount) {
      const before = this.health;
      const out = dmg0.apply(this, arguments);
      window.__TEL.hits.push({ t: g.elapsed, amount, before, after: this.health });
      if (before > 0 && this.health <= 0 && window.__TEL.death === null) window.__TEL.death = g.elapsed;
      return out;
    };
    window.__TEL.aiTapped = true;
    window.__TEL.armAi = () => {
      window.__TEL.fires.length = 0;
      window.__TEL.hits.length = 0;
      window.__TEL.death = null;
      // setup({invulnerable:false}) restores whatever it captured, which on the
      // first vulnerable run is the untapped function. Deleting the instance
      // property puts the prototype tap back in the call path.
      delete g.player.damage;
      g.player.__realDamage = undefined;
      g.player.health = 100;
      g.player.alive = true;
    };
  });

  const lane = await sim.clearLane([-6, null, 17], 60);
  const a = lane.deg * Math.PI / 180;
  const yaw = a + Math.PI;
  const origin = [-6, null, 17];
  const rows = [];
  for (const R of AI_RANGES) {
    for (let eng = 0; eng < AI_TRIALS; eng++) {
      const p = { x: origin[0] + Math.sin(a) * R, z: origin[2] + Math.cos(a) * R };
      await sim.setup({
        position: origin, yaw, pitch: 0, ads: 0, invulnerable: false, health: 100,
        // Facing the player: an enemy that has to turn first is being measured
        // for its turn rate, not its reaction.
        enemies: [{ x: p.x, z: p.z, facing: yaw }],
      });
      await sim.eval(() => window.__TEL.armAi());
      const pre = await sim.eval(() => {
        const g = window.__GAME;
        const e = g.director.enemies[0];
        const eye = e.eyePosition(new window.__THREE.Vector3());
        const cam = g.camera.position;
        const dir = cam.clone().sub(eye);
        const d = dir.length();
        dir.divideScalar(d);
        const world = window.__SIM.rayWorld([eye.x, eye.y, eye.z], [dir.x, dir.y, dir.z], 240);
        return { sees: e.canSee(cam, g.director.blockers), d, world, state: e.state };
      });
      if (!pre.sees || pre.world < pre.d - 0.4) {
        throw new Error(`telemetry ai: at ${R} m the enemy cannot see the player (sees ${pre.sees}, `
          + `world ${pre.world.toFixed(1)} m against ${pre.d.toFixed(1)} m) — the trace would be a wall`);
      }
      // The player stands still and does not shoot back: the metric is the AI's
      // engagement timeline, and a player who dodges is measuring himself.
      const trace = await sim.drive({ ticks: Math.round(AI_SECONDS / DT), dt: DT, input: IN() });
      const t0 = trace[0].t - TICK;
      const rec = await sim.eval(() => ({
        fires: window.__TEL.fires.map((f) => f.t),
        hits: window.__TEL.hits.map((h) => h.t),
        death: window.__TEL.death,
      }));
      const shots = rec.fires.map((t) => t - t0);
      const hits = rec.hits.map((t) => t - t0);
      rows.push({
        range: R, eng, sight: 0,
        shot: shots.length ? shots[0] : null,
        hit: hits.length ? hits[0] : null,
        kill: rec.death === null ? null : rec.death - t0,
        shots, bursts: bursts(shots), rounds: shots.length, hits: hits.length,
      });
    }
  }
  return rows;
}

/* ================================================= reference generators == */
//
// Each returns { rows, provenance } where provenance names every targets.mjs key
// consumed, the formula, and every borrowed parameter. The provenance goes into
// the answer key and into this run's report — never into the blinded files.

/* -------------------------------------------------------- 1. recoil ----- */

/**
 * The recoil path the documented model implies.
 *
 * FORMULA. Per round, one vertical and one horizontal value are drawn uniformly
 * inside authored bounds (recoil.recoil_determinism: "view kick draws one random
 * vertical and one random horizontal value per shot"; "the five authored numbers
 * per weapon are max horizontal, min horizontal, max vertical, min vertical, and
 * center speed"). Between rounds the view recentres toward the aim point the
 * ROUND BEFORE started from, not toward zero, at the authored centre speed
 * (recoil.recoil_recentering_behaviour), so the fraction the centre speed did
 * not recover before the next round lands is retained and thirty of those
 * retained fractions are the climb — "during fully automatic fire there is
 * usually too much recoil to fully re-center between shots, so sustained climb is
 * emergent".
 *
 * Discretely, on the 60 Hz grid (physics.multiplayer_server_tick_rate), each
 * tick: kick += (recentreTo - kick) * (1 - exp(-centreSpeed * dt)). That
 * composes exactly to a continuous exponential over any number of ticks, so the
 * grid changes WHEN a round leaves, never how far the view has recovered by
 * then.
 *
 * Cadence is damage.m4a1_mw2019_rpm (682 rpm), quantised by shotTicks().
 *
 * NOT SOURCED, borrowed and declared: the four bound magnitudes, the centre
 * speed, and the ADS scale. targets.mjs has recoil.per_shot_vertical_kick
 * _degrees, .per_shot_horizontal_kick_degrees, .total_vertical_climb_after_n
 * _rounds_degrees and .ads_vs_hipfire_recoil_multiplier all at value: null. This
 * trace therefore tests the SHAPE of the path and nothing about its size.
 */
function referenceRecoil(borrowed, plan = RECOIL_PLAN) {
  const rand = rng(REF_SEED ^ 0x1111);
  const interval = 60 / T('damage', 'm4a1_mw2019_rpm');
  const ticks = shotTicks(plan.rounds, interval);
  const decay = 1 - Math.exp(-borrowed.recoilCenterSpeed * TICK);
  const lastTick = ticks[ticks.length - 1];

  /** One magazine: the per-round aim path, in radians, on the tick grid. */
  function magazine(draw, scale) {
    let kick = { p: 0, y: 0 };
    let toward = { p: 0, y: 0 };
    const out = [];
    let round = 0;
    for (let k = 0; k <= lastTick; k++) {
      if (round < ticks.length && ticks[round] === k) {
        // The aim BEFORE this round's own kick: a round is not deflected by
        // its own recoil. The recorder reads the aim the same way.
        out.push({ t: k * TICK, p: kick.p, y: kick.y });
        toward = { ...kick };
        kick.p += (borrowed.recoilVerticalMin
          + (borrowed.recoilVerticalMax - borrowed.recoilVerticalMin) * draw()) * scale;
        kick.y += (borrowed.recoilHorizontalMin
          + (borrowed.recoilHorizontalMax - borrowed.recoilHorizontalMin) * draw()) * scale;
        round++;
      }
      kick.p += (toward.p - kick.p) * decay;
      kick.y += (toward.y - kick.y) * decay;
    }
    return out;
  }

  const sdOf = (a) => {
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1));
  };
  const lateral = (mags) => mags.map((m) => (m[m.length - 1].y - m[0].y) * DEG);

  // THE INSTRUMENT CHECK, and the one place this file second-guesses its own
  // randomness. The lateral walk's endpoint has a large spread relative to its
  // zero mean — about 0.42 deg of standard deviation per hipfire magazine — so a
  // ten-magazine draw can easily be an outlier of the model it came from. The
  // first draw of the chosen seed was: its hipfire sample deviation was 0.163
  // deg against the model's own 0.418, a 0.4% tail, and the reference side then
  // looked systematically tamer than ours for a reason that was in the dice
  // rather than in either model. A judge who wins on that has been told nothing.
  //
  // So the model's own sampling distribution is measured first, from a scratch
  // stream, and a candidate block is rejected if its sample deviation falls
  // outside the central 90% of it. This tunes the reference toward the
  // statistics of ITS OWN model — never toward our recording, which is not
  // consulted here and is a single honest draw either way. The count of rejected
  // blocks is reported.
  const REFERENCE_BLOCKS = 400;
  const modelSd = {};
  for (const stance of plan.stances) {
    const scratch = rng((REF_SEED ^ 0xA5A5A5) >>> 0);
    const scale = stance ? borrowed.recoilAdsScale : 1;
    const ends = [];
    for (let i = 0; i < REFERENCE_BLOCKS; i++) ends.push(...lateral([magazine(scratch, scale)]));
    modelSd[stance] = sdOf(ends);
  }

  const rows = [];
  const rejected = {};
  for (const stance of plan.stances) {
    const scale = stance ? borrowed.recoilAdsScale : 1;
    let block = null;
    rejected[stance] = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      const mags = [];
      for (let mag = 0; mag < plan.magazines; mag++) mags.push(magazine(rand, scale));
      const s = sdOf(lateral(mags));
      if (s >= 0.62 * modelSd[stance] && s <= 1.45 * modelSd[stance]) { block = mags; break; }
      rejected[stance]++;
    }
    if (!block) throw new Error('telemetry recoil: 40 candidate blocks all fell outside the central 90% '
      + 'of the model\'s own lateral spread — the acceptance band or the model is wrong');
    block.forEach((out, mag) => {
      const p0 = out[0].p, y0 = out[0].y, t0 = out[0].t;
      out.forEach((s, i) => rows.push({
        mag, stance, round: i + 1,
        t: s.t - t0, dpitch: (s.p - p0) * DEG, dyaw: (s.y - y0) * DEG,
      }));
    });
  }
  return {
    rows,
    provenance: {
      // Inside provenance, not beside it: the answer key and the labelled
      // reference file both record exactly `provenance`, and a sampling decision
      // kept outside it was silently dropped from both.
      sampling: {
        modelLateralSd: Object.fromEntries(Object.entries(modelSd)
          .map(([k, v]) => [k, Number(v.toFixed(4))])),
        blocksRejected: rejected,
        band: 'a candidate block is accepted only if its lateral sample deviation is within '
          + '0.62..1.45 x the model\'s own (the central 90% for this sample size)',
      },
      keys: ['damage.m4a1_mw2019_rpm', 'physics.multiplayer_server_tick_rate',
        'recoil.recoil_determinism', 'recoil.recoil_recentering_behaviour',
        'recoil.ads_bullet_spread_degrees'],
      quotes: quotes([['recoil', 'recoil_determinism'], ['recoil', 'recoil_recentering_behaviour'],
        ['recoil', 'ads_bullet_spread_degrees']]),
      nullKeys: ['recoil.per_shot_vertical_kick_degrees', 'recoil.per_shot_horizontal_kick_degrees',
        'recoil.total_vertical_climb_after_n_rounds_degrees',
        'recoil.ads_vs_hipfire_recoil_multiplier'],
      formula: 'per round: one uniform vertical draw in [vMin,vMax] and one uniform horizontal draw in '
        + '[hMin,hMax], both scaled by the ADS factor; per 1/60 s tick: kick += (previous aim point - '
        + 'kick) * (1 - exp(-centreSpeed/60)); rounds leave on the first tick at or after k * 60/682 s. '
        + 'Aim is read before the round\'s own kick. Spread contributes nothing: '
        + 'recoil.ads_bullet_spread_degrees is 0 with a tolerance of exactly 0.',
      borrowed: ['recoilVerticalMin', 'recoilVerticalMax', 'recoilHorizontalMin', 'recoilHorizontalMax',
        'recoilCenterSpeed', 'recoilAdsScale'].map((k) => `${k}: ${BORROWED_NOTES[k]}`),
      caveat: 'magnitude is NOT sourced — this trace tests shape only',
    },
  };
}

/* ------------------------------------------------------ 2. velocity ----- */

/**
 * The velocity curves the documented speeds imply.
 *
 * FORMULA. A first-order ground move on the 60 Hz grid: friction first
 * (v *= max(0, 1 - friction*dt)), then acceleration toward the wish direction
 * capped at the documented target speed for the stance
 * (add = min(target - v.wish, accel*dt*target/walk)). Targets:
 *   walk   movement.base_walk_speed_legacy_iw
 *   sprint that x movement.sprint_speed_scale
 *   crouch movement.crouch_speed_mw3
 * The jump is the documented ballistic one: physics.jump_initial_velocity at the
 * jump tick, physics.gravity per tick semi-implicitly (so the first airborne
 * sample already shows v0 - g*dt, which is what any fixed-step integrator
 * produces and what the recorder sees), returning to the ground when the
 * integrated height crosses zero — which reproduces physics.jump_airtime and
 * physics.jump_height rather than asserting them. Airborne horizontal speed is
 * held constant: movement.air_control says a CoD player "CANNOT gain speed by
 * strafing into the turn" and that lateral authority is "well under 10% of
 * ground acceleration per tick".
 * The slide is the documented envelope: on entry the speed is set to
 * physics.slide_max_speed_scale x walk and decays exponentially for exactly
 * physics.slide_max_duration, at the rate that lands on movement.crouch_speed
 * _mw3 at the end of it — so both slide endpoints are sourced and the decay rate
 * between them is arithmetic on them rather than a free parameter.
 *
 * NOT SOURCED, borrowed and declared: the acceleration rate and the friction
 * rate. No key in targets.mjs describes either. The plateaux, the jump, the
 * slide envelope and the grid are sourced; the knees are not.
 */
function referenceVelocity(borrowed, moves = MOVES) {
  const walk = T('movement', 'base_walk_speed_legacy_iw');
  const sprint = walk * T('movement', 'sprint_speed_scale');
  const crouch = T('movement', 'crouch_speed_mw3');
  const slideCap = walk * T('physics', 'slide_max_speed_scale');
  const slideDur = T('physics', 'slide_max_duration');
  const slideK = Math.log(slideCap / crouch) / slideDur;
  const g = T('physics', 'gravity');
  const jumpV = T('physics', 'jump_initial_velocity');
  const rows = [];
  for (const move of moves) {
    // Velocity in the plane, in the world frame the recorder uses: forward is
    // +x, the flick turns 90 degrees toward +z.
    let vx = 0, vz = 0, vy = 0, y = 0, air = false;
    let sliding = false, slideStart = 0;
    let dir = { x: 1, z: 0 };
    for (let k = 0; k < move.ticks; k++) {
      const t = (k + 1) * TICK;
      const ev = move.events;
      if (ev.turn !== undefined && k === ev.turn) {
        dir = { x: Math.cos(TURN), z: Math.sin(TURN) };
      }
      const crouchHeld = ev.crouch !== undefined && k >= ev.crouch;
      const speed = Math.hypot(vx, vz);
      // Slide entry: crouch pressed at sprint speed on the ground.
      if (crouchHeld && !sliding && !air && speed > walk && (k === ev.crouch)) {
        sliding = true;
        slideStart = t;
        const to = Math.min(slideCap, speed * (slideCap / sprint));
        if (to > speed) { const s = to / speed; vx *= s; vz *= s; }
      }
      if (sliding && (t - slideStart >= slideDur - 1e-9 || speed <= crouch)) sliding = false;

      if (!air) {
        if (sliding) {
          // The documented envelope: exponential from the 1.55x entry to the
          // crouch speed over exactly the documented duration. No steering.
          const s = Math.max(0, 1 - slideK * TICK);
          vx *= s; vz *= s;
        } else {
          const fr = Math.max(0, 1 - borrowed.friction * TICK);
          vx *= fr; vz *= fr;
          const target = crouchHeld ? crouch : sprint;
          const along = vx * dir.x + vz * dir.z;
          const add = Math.min(target - along, borrowed.groundAccel * TICK * target / walk);
          if (add > 0) { vx += dir.x * add; vz += dir.z * add; }
          const now = Math.hypot(vx, vz);
          if (now > target) { const s = target / now; vx *= s; vz *= s; }
        }
      } else {
        // movement.air_control: no strafe gain. Horizontal speed is carried.
      }
      if (ev.jump !== undefined && k === ev.jump && !air) { vy = jumpV; air = true; }
      if (air) {
        vy -= g * TICK;
        y += vy * TICK;
        if (y <= 0) { y = 0; vy = 0; air = false; }
      }
      rows.push({ move: move.id, t, speed: Math.hypot(vx, vz), vy, air: air ? 1 : 0 });
    }
  }
  return {
    rows,
    provenance: {
      keys: ['movement.base_walk_speed_legacy_iw', 'movement.sprint_speed_scale',
        'movement.crouch_speed_mw3', 'movement.air_control', 'physics.gravity',
        'physics.jump_initial_velocity', 'physics.slide_max_speed_scale',
        'physics.slide_max_duration', 'physics.multiplayer_server_tick_rate'],
      formula: `walk ${walk} m/s, sprint ${walk} x ${T('movement', 'sprint_speed_scale')} = `
        + `${sprint.toFixed(3)} m/s, crouch ${crouch} m/s; slide entry `
        + `${walk} x ${T('physics', 'slide_max_speed_scale')} = ${slideCap.toFixed(3)} m/s decaying at `
        + `ln(${slideCap.toFixed(3)}/${crouch})/${slideDur} = ${slideK.toFixed(4)} /s so that it lands on `
        + `the crouch speed after exactly ${slideDur} s; jump v0 ${jumpV} m/s under ${g} m/s^2, `
        + 'semi-implicit on the 1/60 s grid; airborne horizontal speed constant; ground move is '
        + 'friction-then-accelerate capped at the stance target.',
      quotes: quotes([['movement', 'air_control']]),
      borrowed: ['groundAccel', 'friction'].map((k) => `${k}: ${BORROWED_NOTES[k]}`),
      caveat: 'plateaux, jump ballistics and slide envelope are sourced; the acceleration and friction '
        + 'rates that shape the knees are not',
    },
  };
}

/* ----------------------------------------------------------- 3. TTK ----- */

/**
 * The TTK distribution the documented damage model implies.
 *
 * FORMULA. Damage at range r is damage.m4a1_mw2019_max_damage flat to
 * damage.m4a1_mw2019_near_range_stop, linear to damage.m4a1_mw2019_min_damage at
 * damage.m4a1_mw2019_far_range_stop, then flat for ever (CoD has no hard
 * cutoff). Health is damage.health_mw2019. Rounds leave on the schedule
 * damage.m4a1_mw2019_rpm implies, quantised to the 60 Hz tick. Flight is the
 * documented one: the first ballistics.ar_muzzle_velocity_mcw_mw3_2023 /
 * ballistics.instant_hit_range_formula_divisor = 37.5 m resolve on the tick the
 * trigger broke (ballistics.instant_hit_range_formula_divisor is exact), and only
 * the remainder is flown at the muzzle velocity, arriving on the first tick at or
 * after it. A landing round applies damage.mcw_mw3_torso_multiplier_post_buff on
 * the torso and damage.m4a1_mw2019_headshot_multiplier on the head. TTK is the
 * fatal arrival minus the first arrival, which is the convention the published
 * figures use (damage.m4a1_mw2019_ttk_max_range's note: "EXCLUDES the first
 * bullet travel/instant hit, so TTK = (STK - 1) x interval").
 *
 * The compensated shooter lands every round centre of mass, which is what a
 * published shots-to-kill means. The uncompensated shooter's rounds are
 * displaced by the recoil path of referenceRecoil() above and hit or miss on the
 * geometry of the body; targets.mjs has no accuracy-degradation figure of any
 * kind, so that half of this metric rests on the same borrowed recoil magnitudes
 * plus a borrowed hitbox, and is declared as such.
 */
function referenceTtk(borrowed, ranges = TTK_RANGES, trials = TTK_TRIALS, seconds = TTK_SECONDS) {
  const rand = rng(REF_SEED ^ 0x2222);
  const health = T('damage', 'health_mw2019');
  const maxD = T('damage', 'm4a1_mw2019_max_damage');
  const minD = T('damage', 'm4a1_mw2019_min_damage');
  const near = T('damage', 'm4a1_mw2019_near_range_stop');
  const far = T('damage', 'm4a1_mw2019_far_range_stop');
  const interval = 60 / T('damage', 'm4a1_mw2019_rpm');
  const muzzle = T('ballistics', 'ar_muzzle_velocity_mcw_mw3_2023');
  const instant = muzzle / T('ballistics', 'instant_hit_range_formula_divisor');
  const torsoMult = T('damage', 'mcw_mw3_torso_multiplier_post_buff');
  const headMult = T('damage', 'm4a1_mw2019_headshot_multiplier');
  const magSize = 30;
  const dmgAt = (r) => (r <= near ? maxD : r >= far ? minD
    : maxD + (minD - maxD) * ((r - near) / (far - near)));

  // The body a round has to miss. No title publishes hitbox extents, so this is
  // the player capsule from player.js: a torso half-width and a head sitting on
  // top of it. Declared borrowed.
  const halfW = borrowed.torsoHalfWidth;
  const torsoTop = 0.30, torsoBottom = -0.45, headTop = 0.55;

  const ticks = shotTicks(magSize, interval);
  const decay = 1 - Math.exp(-borrowed.recoilCenterSpeed * TICK);
  const rows = [];
  for (const comp of [1, 0]) {
    for (const R of ranges) {
      for (let eng = 0; eng < trials; eng++) {
        const perRound = dmgAt(R);
        const flight = Math.max(0, R - instant) / muzzle;
        let kick = { p: 0, y: 0 }, toward = { p: 0, y: 0 };
        let hp = health, fired = 0, landed = [];
        let round = 0;
        const lastTick = Math.round(seconds / TICK);
        // The magazine runs to the end of the window whether the target dies or
        // not, because the recorded side holds the trigger and does exactly that.
        // Stopping the reference at the kill made `fired` 4, 5 or 6 on one side
        // and 30 on the other, which is a formatting tell a judge wins on every
        // time without learning anything: it was a property of the generator's
        // loop, not of any model. Only the rounds up to the fatal one are counted
        // toward the kill, on both sides.
        for (let k = 0; k <= lastTick; k++) {
          if (round < ticks.length && ticks[round] === k) {
            fired++;
            // Where this round goes: the aim before its own kick, displaced by
            // whatever the view kick has accumulated, unless the shooter undoes
            // it.
            const dp = comp ? 0 : kick.p, dy = comp ? 0 : kick.y;
            const upM = Math.tan(dp) * R, sideM = Math.tan(dy) * R;
            let mult = null;
            if (Math.abs(sideM) <= halfW) {
              if (upM <= torsoTop && upM >= torsoBottom) mult = torsoMult;
              else if (upM > torsoTop && upM <= headTop) mult = headMult;
            }
            if (mult !== null) {
              const arrive = Math.ceil((k * TICK + flight) / TICK - 1e-9) * TICK;
              landed.push({ t: arrive, amount: perRound * mult });
            }
            toward = { ...kick };
            kick.p += (borrowed.recoilVerticalMin
              + (borrowed.recoilVerticalMax - borrowed.recoilVerticalMin) * rand())
              * borrowed.recoilAdsScale;
            kick.y += (borrowed.recoilHorizontalMin
              + (borrowed.recoilHorizontalMax - borrowed.recoilHorizontalMin) * rand())
              * borrowed.recoilAdsScale;
            round++;
          }
          kick.p += (toward.p - kick.p) * decay;
          kick.y += (toward.y - kick.y) * decay;
          // Arrivals resolved on the tick they land on, so a round already in the
          // air when the target dies still counts exactly as it does in a
          // simulation that flies it.
          const now = k * TICK;
          for (const l of landed) {
            if (l.applied || l.t > now + 1e-9) continue;
            // A round that arrives after the target is already down lands on a
            // corpse and is not part of the kill. The recorder discards those the
            // same way — it counts only the damage events at or before the tick
            // the target stopped being alive.
            if (hp <= 0) continue;
            l.applied = true;
            hp -= l.amount;
          }
        }
        const applied = landed.filter((l) => l.applied);
        const killed = hp <= 0 && applied.length >= 1;
        const first = applied.length ? applied[0].t : null;
        const fatal = killed ? applied[applied.length - 1].t : null;
        rows.push({
          range: R, comp, eng,
          ttk: killed && applied.length >= 2 ? fatal - first : null,
          tkill: killed ? fatal - ticks[0] * TICK : null,
          stk: killed ? applied.length : null,
          fired,
        });
      }
    }
  }
  return {
    rows,
    provenance: {
      keys: ['damage.health_mw2019', 'damage.m4a1_mw2019_max_damage', 'damage.m4a1_mw2019_min_damage',
        'damage.m4a1_mw2019_near_range_stop', 'damage.m4a1_mw2019_far_range_stop',
        'damage.m4a1_mw2019_rpm', 'damage.mcw_mw3_torso_multiplier_post_buff',
        'damage.m4a1_mw2019_headshot_multiplier', 'ballistics.ar_muzzle_velocity_mcw_mw3_2023',
        'ballistics.instant_hit_range_formula_divisor', 'physics.multiplayer_server_tick_rate',
        'recoil.recoil_determinism', 'recoil.recoil_recentering_behaviour'],
      crossChecks: ['damage.m4a1_mw2019_stk_max_range', 'damage.m4a1_mw2019_stk_min_range',
        'damage.m4a1_mw2019_ttk_max_range', 'damage.m4a1_mw2019_ttk_min_range'],
      quotes: quotes([['damage', 'm4a1_mw2019_ttk_max_range'],
        ['ballistics', 'instant_hit_range_formula_divisor']]),
      formula: `${maxD} HP flat to ${near} m, linear to ${minD} HP at ${far} m, flat beyond; `
        + `${health} HP target; rounds on the first tick at or after k * 60/${T('damage', 'm4a1_mw2019_rpm')} s; `
        + `the first ${instant} m (= ${muzzle}/${T('ballistics', 'instant_hit_range_formula_divisor')}) `
        + 'resolves on the trigger tick and the remainder flies at the muzzle velocity, arriving on the '
        + 'first tick at or after; TTK = fatal arrival - first arrival.',
      borrowed: ['recoilVerticalMin', 'recoilVerticalMax', 'recoilHorizontalMin', 'recoilHorizontalMax',
        'recoilCenterSpeed', 'recoilAdsScale', 'torsoHalfWidth']
        .map((k) => `${k}: ${BORROWED_NOTES[k]}`),
      caveat: 'the compensated half is sourced end to end; the uncompensated half needs a recoil '
        + 'magnitude and a hitbox, neither of which any key supplies',
    },
  };
}

/* ------------------------------------------------------------ 4. AI ----- */

/**
 * The AI engagement timeline the documented reaction band implies.
 *
 * FORMULA. The reaction from first sight to the first round is drawn from a
 * triangular distribution with mode ai.ai_reaction_delay_base (0.25 s) on the
 * support ai.ai_reaction_delay_range (0.20..0.40 s) — the only distribution that
 * respects both keys at once, since a uniform draw over that band would have a
 * median of 0.30 s and contradict the 0.25 s base. Quantised up to the 60 Hz
 * tick. Rounds fly the documented ballistic path
 * (ballistics.ar_muzzle_velocity_mcw_mw3_2023 with the
 * ballistics.instant_hit_range_formula_divisor instant stretch). The player has
 * damage.health_mw2019 HP.
 *
 * NOT SOURCED, borrowed and declared: burst length, intra-burst spacing,
 * inter-burst interval, per-round damage and the aim-error model. targets.mjs has
 * no published figure for any of the five, in any title. So this trace's REACTION
 * is sourced and its RHYTHM is not.
 */
function referenceAi(borrowed, ranges = AI_RANGES, trials = AI_TRIALS, seconds = AI_SECONDS) {
  const rand = rng(REF_SEED ^ 0x3333);
  const mode = T('ai', 'ai_reaction_delay_base');
  const [lo, hi] = band('ai', 'ai_reaction_delay_range');
  const health = T('damage', 'health_mw2019');
  const muzzle = T('ballistics', 'ar_muzzle_velocity_mcw_mw3_2023');
  const instant = muzzle / T('ballistics', 'instant_hit_range_formula_divisor');
  /** Triangular(lo, mode, hi): mode is the sourced central figure, the band is the sourced support. */
  const triangular = () => {
    const u = rand();
    const c = (mode - lo) / (hi - lo);
    return u < c ? lo + Math.sqrt(u * (hi - lo) * (mode - lo))
      : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - mode));
  };
  const up = (t) => Math.ceil(t / TICK - 1e-9) * TICK;

  const rows = [];
  for (const R of ranges) {
    for (let eng = 0; eng < trials; eng++) {
      const react = up(triangular());
      const flight = Math.max(0, R - instant) / muzzle;
      // Borrowed aim error: a fixed positional error plus a residual angle, drawn
      // as a uniform disc, tested against the same body box the TTK reference
      // uses. Every term here is from ai.js, not from targets.mjs.
      const spread = borrowed.aiAimErrorMetres / Math.max(R, borrowed.aiAimErrorFloorRange)
        + borrowed.aiAimErrorAngle;
      const shots = [], hitsAt = [];
      let t = react, hp = health, burstLeft = 0, kill = null;
      while (t <= seconds) {
        if (burstLeft <= 0) {
          burstLeft = borrowed.aiBurstCount[0]
            + Math.floor(rand() * (borrowed.aiBurstCount[1] - borrowed.aiBurstCount[0] + 1));
        }
        const tick = up(t);
        shots.push(tick);
        // Where it goes: a uniform point in a disc of radius spread*R at the
        // player, aimed at the eye, against a body that hangs below it.
        const ang = rand() * Math.PI * 2;
        const rad = Math.sqrt(rand()) * spread * R;
        const sideM = Math.sin(ang) * rad, upM = Math.cos(ang) * rad;
        const hit = Math.abs(sideM) <= borrowed.torsoHalfWidth
          && upM <= 0.22 && upM >= -(borrowed.torsoHeight - 0.22);
        if (hit && hp > 0) {
          const arrive = up(tick + flight);
          hitsAt.push(arrive);
          hp -= borrowed.aiDamage[0] + rand() * (borrowed.aiDamage[1] - borrowed.aiDamage[0]);
          if (hp <= 0 && kill === null) kill = arrive;
        }
        burstLeft--;
        t = tick + (burstLeft > 0 ? borrowed.aiBurstDelay
          : borrowed.aiFireInterval[0]
            + rand() * (borrowed.aiFireInterval[1] - borrowed.aiFireInterval[0]));
        if (kill !== null) break;
      }
      const inWindow = (a) => a.filter((x) => x <= seconds + 1e-9);
      const sh = inWindow(shots), hh = inWindow(hitsAt);
      rows.push({
        range: R, eng, sight: 0,
        shot: sh.length ? sh[0] : null,
        hit: hh.length ? hh[0] : null,
        kill: kill !== null && kill <= seconds + 1e-9 ? kill : null,
        shots: sh, bursts: bursts(sh), rounds: sh.length, hits: hh.length,
      });
    }
  }
  return {
    rows,
    provenance: {
      keys: ['ai.ai_reaction_delay_base', 'ai.ai_reaction_delay_range', 'damage.health_mw2019',
        'ballistics.ar_muzzle_velocity_mcw_mw3_2023', 'ballistics.instant_hit_range_formula_divisor',
        'physics.multiplayer_server_tick_rate'],
      formula: `reaction ~ Triangular(${lo}, mode ${mode}, ${hi}) s, quantised up to the 1/60 s tick; `
        + `rounds fly ${muzzle} m/s past a ${instant} m instant-hit radius; player ${health} HP; a burst `
        + 'is fired at the borrowed intra-burst spacing and separated by the borrowed inter-burst '
        + 'interval.',
      borrowed: ['aiBurstCount', 'aiBurstDelay', 'aiFireInterval', 'aiDamage', 'aiAimErrorMetres',
        'aiAimErrorAngle', 'aiAimErrorFloorRange', 'torsoHalfWidth', 'torsoHeight']
        .map((k) => `${k}: ${BORROWED_NOTES[k]}`),
      caveat: 'the reaction band is sourced; the rhythm (burst length, spacing, interval), the damage '
        + 'and the accuracy are all borrowed — nothing publishes them',
    },
  };
}

/* ============================================================ blinding == */

/**
 * Writes one metric's pair, with which side is A decided by real randomness,
 * independently per metric.
 *
 * Both files go through METRICS[m].row, so key names, key order and decimal
 * precision are identical by construction rather than by care. Neither file
 * carries a provenance field, a "measured"/"reference" name, or anything else
 * that answers the question the judge is being asked.
 */
function writePair(metric, ours, reference) {
  const spec = METRICS[metric];
  const oursIsA = crypto.randomInt(2) === 0;
  const body = (rows) => JSON.stringify({
    metric,
    tick: Number(TICK.toFixed(9)),
    columns: spec.columns,
    n: rows.length,
    rows: rows.map(spec.row),
  }, null, 1);
  const A = oursIsA ? ours : reference;
  const B = oursIsA ? reference : ours;
  fs.writeFileSync(path.join(TRACES, `${metric}-A.json`), `${body(A)}\n`);
  fs.writeFileSync(path.join(TRACES, `${metric}-B.json`), `${body(B)}\n`);
  return oursIsA ? 'A' : 'B';
}

/* ============================================================== report == */

function summariseRecoil(rows, label) {
  const out = [];
  for (const stance of [1, 0]) {
    const s = rows.filter((r) => r.stance === stance);
    const at = (n) => s.filter((r) => r.round === n).map((r) => r.dpitch);
    const yaws = s.filter((r) => r.round === 30).map((r) => r.dyaw);
    out.push(`${label} ${stance ? 'ADS' : 'hip'}: climb at round 5 ${f3(median(at(5)))} deg, `
      + `10 ${f3(median(at(10)))}, 20 ${f3(median(at(20)))}, 30 ${f3(median(at(30)))} `
      + `[${f3(Math.min(...at(30)))}..${f3(Math.max(...at(30)))}]; `
      + `lateral at round 30 ${f3(median(yaws))} deg, |max| ${f3(Math.max(...yaws.map(Math.abs)))}`);
  }
  return out;
}
function summariseVelocity(rows, label) {
  const out = [];
  for (const m of MOVES) {
    const s = rows.filter((r) => r.move === m.id);
    const top = Math.max(...s.map((r) => r.speed));
    const airRows = s.filter((r) => r.air === 1);
    const t90 = s.find((r) => r.speed >= 0.9 * top)?.t ?? null;
    out.push(`${label} move ${m.id} (${m.name}): peak ${f3(top)} m/s, 90% of peak at ${f3(t90)} s`
      + (airRows.length ? `, airtime ${f3(airRows.length * TICK)} s, peak vy ${f3(Math.max(...s.map((r) => r.vy)))} m/s` : '')
      + (m.id === 1 ? `, dip to ${f3(Math.min(...s.slice(m.events.turn).map((r) => r.speed)))} m/s after the flick` : '')
      + (m.id === 2 ? `, slide peak ${f3(Math.max(...s.slice(m.events.crouch - 1).map((r) => r.speed)))} m/s` : ''));
  }
  return out;
}
function summariseTtk(rows, label) {
  const out = [];
  for (const comp of [1, 0]) {
    const parts = TTK_RANGES.map((R) => {
      const s = rows.filter((r) => r.comp === comp && r.range === R);
      const t = s.map((r) => r.ttk);
      const kills = t.filter((v) => v !== null).length;
      return `${R}m ${median(t) === null ? 'no kill' : ms(median(t))}${kills < s.length ? ` (${kills}/${s.length} killed)` : ''}`;
    });
    out.push(`${label} ${comp ? 'compensating' : 'uncompensated'}: ${parts.join(', ')}`);
  }
  return out;
}
function summariseAi(rows, label) {
  const react = rows.map((r) => r.shot);
  const hit = rows.map((r) => r.hit);
  const kill = rows.map((r) => r.kill);
  const bl = rows.flatMap((r) => r.bursts.map(([a, b], i) => (r.shots.filter((t) => t >= a && t <= b).length)));
  return [`${label}: first shot median ${ms(median(react))} [p10 ${ms(quantile(react, 0.1))} .. `
    + `p90 ${ms(quantile(react, 0.9))}], first hit median ${ms(median(hit))}, kill median ${ms(median(kill))} `
    + `(${kill.filter((v) => v !== null).length}/${rows.length} engagements ended in a kill), `
    + `${bl.length} bursts of median ${f3(median(bl))} rounds`];
}

/**
 * The reference trace as a NAMED artifact, with its provenance inside it.
 *
 * The blinded copies in traces/ cannot carry provenance without answering the
 * question, but a generated trace that says nowhere what generated it is exactly
 * the kind of file this project has been burned by. So the labelled copy is
 * written next to the answer key, OUTSIDE traces/, carrying the keys, the
 * formula, every borrowed parameter and the flat statement that it is not a
 * recording. Same rows, same serialiser, so it is byte-comparable with whichever
 * of A/B it is.
 */
function writeReference(metric, rows, provenance) {
  const spec = METRICS[metric];
  fs.writeFileSync(path.join(HERE, `.reference-${metric}.json`), `${JSON.stringify({
    metric,
    provenance: `synthesised from targets.mjs keys [${provenance.keys.join(', ')}] — NOT a recording `
      + 'from a shipped title',
    generatedFrom: provenance,
    tick: Number(TICK.toFixed(9)),
    columns: spec.columns,
    n: rows.length,
    rows: rows.map(spec.row),
  }, null, 1)}\n`);
}

/**
 * Per-column comparison of the two sides, printed for every metric.
 *
 * This is the guard against the class of mistake that produced the worst tell in
 * this file's history: referenceTtk() stopped firing when the target died while
 * the recorder held the trigger to the end of the window, so `fired` was 4, 5 or
 * 6 on one side and 30 on the other. Every judge would have won on it, and none
 * of them would have learned anything about the game.
 *
 * It flags, per column: a column constant on one side and not the other, ranges
 * that do not overlap at all, and null counts that differ by more than half the
 * rows. None of those is automatically a defect — a real difference in the game
 * can produce all three — but each one has to be looked at and named in the
 * report rather than shipped unnoticed.
 */
function tellScan(metric, ours, reference) {
  const spec = METRICS[metric];
  const A = ours.map(spec.row), B = reference.map(spec.row);
  const cols = Object.keys(spec.columns);
  const out = [];
  for (const c of cols) {
    const a = A.map((r) => r[c]), b = B.map((r) => r[c]);
    if (Array.isArray(a[0])) continue;   // arrays are summarised by the metric's own report
    const nums = (v) => v.filter((x) => x !== null && Number.isFinite(x));
    const na = nums(a), nb = nums(b);
    const nullsA = a.length - na.length, nullsB = b.length - nb.length;
    const dA = new Set(na).size, dB = new Set(nb).size;
    const flags = [];
    if ((dA === 1) !== (dB === 1)) flags.push(`constant on one side only (${dA} vs ${dB} distinct values)`);
    if (na.length && nb.length) {
      const [aLo, aHi] = [Math.min(...na), Math.max(...na)];
      const [bLo, bHi] = [Math.min(...nb), Math.max(...nb)];
      if (aHi < bLo || bHi < aLo) flags.push(`disjoint ranges [${f3(aLo)}..${f3(aHi)}] vs [${f3(bLo)}..${f3(bHi)}]`);
    }
    if (Math.abs(nullsA - nullsB) > a.length / 2) flags.push(`${nullsA} nulls against ${nullsB}`);
    if (flags.length) out.push(`  TELL SCAN ${metric}.${c}: ${flags.join('; ')}`);
  }
  return out.length ? out : ['  TELL SCAN: no column is constant on one side only, none has disjoint '
    + 'ranges, and the null counts agree'];
}

/* ================================================================ main == */

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const wanted = only.length ? only : ['recoil', 'velocity', 'ttk', 'ai'];
for (const w of wanted) if (!METRICS[w]) throw new Error(`telemetry: no such metric "${w}"`);

if (args.includes('--selfcheck')) {
  // Grid and shape checks that need no browser: they are about the generators
  // and the serialiser, which are where a formatting tell would come from.
  const borrowed = {
    recoilVerticalMin: 0.0052, recoilVerticalMax: 0.0082,
    recoilHorizontalMin: -0.0055, recoilHorizontalMax: 0.0055,
    recoilCenterSpeed: 9, recoilAdsScale: 0.66,
    groundAccel: 62, friction: 9.5, airDrag: 0.18,
    torsoHalfWidth: 0.32, torsoHeight: 1.82,
    aiBurstCount: [2, 5], aiBurstDelay: 0.098, aiFireInterval: [0.42, 1.15],
    aiDamage: [11, 16], aiAimErrorMetres: 0.18, aiAimErrorAngle: 0.03, aiAimErrorFloorRange: 4,
  };
  const r = referenceRecoil(borrowed), v = referenceVelocity(borrowed);
  const k = referenceTtk(borrowed), a = referenceAi(borrowed);
  const onGrid = (rows, f) => rows.every((x) => {
    const t = f(x);
    return t === null || Math.abs(t / TICK - Math.round(t / TICK)) < 1e-6;
  });
  const checks = [
    ['recoil rows', r.rows.length === RECOIL_PLAN.magazines * RECOIL_PLAN.rounds * 2, r.rows.length],
    ['recoil on the tick grid', onGrid(r.rows, (x) => x.t), ''],
    ['recoil first round is the origin', r.rows[0].dpitch === 0 && r.rows[0].dyaw === 0, ''],
    ['velocity rows', v.rows.length === MOVES.reduce((s, m) => s + m.ticks, 0), v.rows.length],
    ['velocity on the tick grid', onGrid(v.rows, (x) => x.t), ''],
    ['ttk rows', k.rows.length === TTK_RANGES.length * TTK_TRIALS * 2, k.rows.length],
    ['ttk on the tick grid', onGrid(k.rows, (x) => x.ttk), ''],
    ['ai rows', a.rows.length === AI_RANGES.length * AI_TRIALS, a.rows.length],
    ['ai on the tick grid', onGrid(a.rows, (x) => x.shot), ''],
  ];
  let bad = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`);
  }
  console.log(summariseRecoil(r.rows, 'reference').join('\n'));
  console.log(summariseVelocity(v.rows, 'reference').join('\n'));
  console.log(summariseTtk(k.rows, 'reference').join('\n'));
  console.log(summariseAi(a.rows, 'reference').join('\n'));
  process.exit(bad ? 1 : 0);
}

fs.mkdirSync(TRACES, { recursive: true });
const sim = await openSim({});
const report = [];
const key = { generated: new Date().toISOString(), tick: TICK, note: 'JUDGES: DO NOT READ THIS FILE. It is kept outside traces/ for that reason.', metrics: {} };
try {
  const borrowed = await readBorrowed(sim);
  console.log(`borrowed parameters read from the running page: ${JSON.stringify(borrowed)}`);

  const RECORDERS = { recoil: recordRecoil, velocity: recordVelocity, ttk: recordTtk, ai: recordAi };
  const GENERATORS = {
    recoil: () => referenceRecoil(borrowed),
    velocity: () => referenceVelocity(borrowed),
    ttk: () => referenceTtk(borrowed),
    ai: () => referenceAi(borrowed),
  };
  const SUMMARIES = {
    recoil: summariseRecoil, velocity: summariseVelocity, ttk: summariseTtk, ai: summariseAi,
  };

  for (const metric of wanted) {
    console.log(`\n=== ${metric} ===`);
    const t0 = Date.now();
    const ours = await RECORDERS[metric](sim);
    const ref = GENERATORS[metric]();
    if (ours.length !== ref.rows.length) {
      throw new Error(`telemetry ${metric}: recorded ${ours.length} rows but generated `
        + `${ref.rows.length} — mismatched sample counts are a tell a judge would win on, and the `
        + 'generator is handed the recorded shape precisely so this cannot happen');
    }
    const side = writePair(metric, ours, ref.rows);
    writeReference(metric, ref.rows, ref.provenance);
    key.metrics[metric] = {
      ours: side,
      reference: side === 'A' ? 'B' : 'A',
      rows: ours.length,
      provenance: `synthesised from targets.mjs keys [${ref.provenance.keys.join(', ')}] — NOT a `
        + 'recording from a shipped title',
      ...ref.provenance,
    };
    const lines = [...SUMMARIES[metric](ours, 'ours'), ...SUMMARIES[metric](ref.rows, 'reference'),
      ...tellScan(metric, ours, ref.rows)];
    report.push(...lines);
    console.log(lines.join('\n'));
    console.log(`  ${ours.length} rows each side, ours is ${side}, ${(Date.now() - t0) / 1000}s`);
  }

  if (sim.errors.length) console.log(`\npage errors during recording: ${sim.errors.slice(0, 3).join(' | ')}`);
} finally {
  await sim.close();
}

// The answer key, deliberately outside traces/. Judges are instructed not to
// read it; nothing enforces that, and nothing can.
const prior = fs.existsSync(KEYFILE) ? JSON.parse(fs.readFileSync(KEYFILE, 'utf8')) : { metrics: {} };
key.metrics = { ...prior.metrics, ...key.metrics };
fs.writeFileSync(KEYFILE, `${JSON.stringify(key, null, 2)}\n`);
console.log(`\n${'-'.repeat(72)}\nEVERYTHING RECORDED AND EVERYTHING GENERATED, SIDE BY SIDE\n`);
console.log(report.join('\n'));
console.log(`\nkey written to ${KEYFILE} (outside traces/ on purpose)`);
console.log(`labelled reference traces at ${path.join(HERE, '.reference-<metric>.json')} (also outside)`);
console.log(`blinded pairs in ${TRACES}`);
