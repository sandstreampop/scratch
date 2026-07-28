// Weapon feel: recoil, ADS, spread, cadence, reload.
//
// This file measures the five things a player's hands actually learn about a
// gun, and it exists because every one of them is currently described somewhere
// in the source by a constant that does not describe it. SPEC.adsTime is 0.19
// and is read by nothing; SPEC.rpm is 780 and the gun fires 720 at the frame
// rate it ships at; SPEC.recoilPitch feeds a spring that cancels its own
// accumulation. A suite that read those numbers would report a weapon nobody
// has ever fired.
//
// Two conventions run through the whole file, both load-bearing:
//
//   Rounds are ammo decrements. weapon.fire() is called on every tick the
//   trigger is held and returns null on most of them, so `weapon.fire` events
//   count trigger polls, not shots. Ammo is the only witness that a round left
//   the gun.
//
//   Aim is aimPitch/aimYaw, never recoilPitch alone and never pitch alone.
//   aimPitch = pitch + recoilPitch is where the bullet goes, which is the only
//   recoil quantity a player can perceive. Measuring recoilPitch in isolation
//   would miss a game that fed recoil back into pitch, and measuring pitch
//   alone misses this one, which does not.
//
// Where a threshold is not a sourced Call of Duty value it is a *structural*
// floor — "the quantity is nonzero", "the pattern accumulates", "the rate does
// not depend on the frame rate" — and the detail string says so. No CoD number
// is invented here. Quantities with no sourced target are still measured and
// still printed, so the coverage gap is visible rather than silent.

const DEG = 180 / Math.PI;

// Default step. 1/240 puts four samples inside the 79 ms shot interval, which
// is the resolution the recoil envelope and the ADS knee both need. Reload
// durations are measured at 1/120 instead: two seconds of 1/240 is 480 ticks
// per reload and 8 ms of quantisation on a 2180 ms number is 0.4%, well under
// any tolerance worth asserting.
const DT = 1 / 240;
const DT_RELOAD = 1 / 120;

export const NAME = 'weapon';

/* ------------------------------------------------------------- targets -- */
//
// targets.mjs is written by a separate research workflow and may not exist. The
// import is defensive, and the lookup is deliberately forgiving about shape
// (number, {value|target|median, tol|pct|min|max, unit, source}) because this
// file cannot dictate the schema of a file it does not own. What it must never
// do is substitute a number of its own when the lookup misses — a missing
// target reports as a measurement with the gap named.
let TARGETS = null, inside = null;
try { ({ TARGETS, inside } = await import('./targets.mjs')); } catch { /* not written yet */ }

function targetFor(paths) {
  if (!TARGETS) return null;
  for (const path of [].concat(paths)) {
    let node = TARGETS;
    for (const k of path.split('.')) { if (node == null) break; node = node[k]; }
    if (node == null) continue;
    if (typeof node === 'number') return { value: node, tol: { pct: 0.15 }, source: `targets.mjs:${path}` };
    const value = node.value ?? node.target ?? node.median ?? null;
    if (typeof value !== 'number') continue;
    const tol = node.tol
      ?? (node.pct != null ? { pct: node.pct } : null)
      ?? (node.min != null || node.max != null ? { min: node.min, max: node.max } : null)
      ?? { pct: 0.15 };
    return { value, tol, unit: node.unit ?? '', source: node.source ?? `targets.mjs:${path}` };
  }
  return null;
}

/* ------------------------------------------------------------ plumbing -- */

const BASE_INPUT = {
  forward: false, back: false, left: false, right: false,
  sprint: false, crouch: false, ads: false, fire: false,
};

/**
 * Builds an input body with every key written explicitly.
 *
 * sim.drive Object.assign's the returned patch onto g.input, so a key omitted
 * on tick 2 keeps whatever tick 1 left there. Every input in this file goes
 * through here so a released trigger is actually released.
 */
const IN = (over = {}) => `return ${JSON.stringify({ ...BASE_INPUT, ...over })};`;

/** Same, for a patch that has to be computed per tick from live game state. */
const IN_DYN = (expr) => `return Object.assign(${JSON.stringify(BASE_INPUT)}, (${expr}));`;

/** Marks the simulation clock so an input body can measure its own elapsed. */
const mark = (sim) => sim.eval(() => { window.__T0 = window.__GAME.elapsed; return window.__GAME.elapsed; });

/**
 * Ticks on which a round left the gun, as {n, t, i}.
 *
 * Stops at the first ammo *increase*: that is the reload returning rounds, and
 * everything after it belongs to a different magazine.
 */
function roundsOf(rows, start = 30) {
  const out = [];
  let prev = start;
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i].ammo;
    if (a < prev) { out.push({ n: start - a, t: rows[i].t, i }); prev = a; }
    else if (a > prev) break;
  }
  return out;
}

const maxOf = (rows, from, to, key) => {
  let m = -Infinity;
  for (let i = from; i <= to && i < rows.length; i++) m = Math.max(m, rows[i][key]);
  return m;
};

const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : String(v));
const ms = (v) => (Number.isFinite(v) ? `${(v * 1000).toFixed(1)} ms` : String(v));

/* --------------------------------------------------------------- suite -- */

export default async function run(sim, report) {
  // SPEC is read through the running page rather than imported here, so it is
  // the object the game is actually using — and so the deadness probes below
  // can mutate it and watch whether the behaviour follows.
  let SPEC = null;
  try {
    SPEC = await sim.eval(async () => {
      const m = await import('/src/weapon.js');
      return JSON.parse(JSON.stringify(m.SPEC));
    });
  } catch { SPEC = null; }
  report.check('weapon SPEC is reachable through the running page',
    !!SPEC, SPEC ? `rpm ${SPEC.rpm}, magSize ${SPEC.magSize}, reloadTime ${SPEC.reloadTime} s`
      : 'could not import /src/weapon.js from the page — constant-vs-behaviour probes are skipped');

  const specPatches = [];
  async function patchSpec(key, value) {
    const prev = await sim.eval(async (a) => {
      const m = await import('/src/weapon.js');
      const before = m.SPEC[a.k];
      m.SPEC[a.k] = a.v;
      return before;
    }, { k: key, v: value });
    specPatches.push([key, prev]);
    return prev;
  }
  async function restoreSpec() {
    while (specPatches.length) {
      const [k, v] = specPatches.pop();
      await sim.eval(async (a) => { (await import('/src/weapon.js')).SPEC[a.k] = a.v; }, { k, v });
    }
  }

  // One clear lane, reused by every section that needs the player to actually
  // move. The default spawn faces geometry: the first version of the
  // moving-spread measurement walked into a wall for 1.4 s and reported a
  // motion multiplier of x1.02 at 0.11 m/s, which reads as "movement barely
  // affects the cone" and was entirely the probe's fault.
  const lane = await sim.clearLane([-6, null, 17], 40);
  // clearLane's heading is a world direction (sin, cos); the player's forward is
  // (-sin(yaw), -cos(yaw)), so the yaw that runs down that lane is the heading
  // plus half a turn.
  const laneYaw = lane.deg * Math.PI / 180 + Math.PI;

  try {
    /* ============================================ 1. recoil pattern ==== */
    //
    // A full magazine held down, in ADS and in hipfire, sampled every tick.
    //
    // "Climb at round N" is the peak aim displacement inside round N's own shot
    // interval — the highest the sights go while that round is the most recent
    // one. That is the number the player sees. The settled value at the end of
    // the interval is recorded too, because the difference between the two is
    // exactly what distinguishes a pattern that walks the gun up the target
    // from a per-shot shake that returns to where it started.

    async function magazine({ ads, dt = DT, seconds = 2.9 }) {
      await sim.setup({ ads: ads ? 1 : 0, ammo: 30, pitch: 0 });
      const zero = await sim.snapshot();
      const rows = await sim.drive({
        seconds, dt, input: IN({ fire: true, ads }),
      });
      return { rows, zero, rnds: roundsOf(rows, 30) };
    }

    /** Per-round peak and settled climb, in degrees, relative to point of aim. */
    function climbProfile({ rows, zero, rnds }) {
      const aim0 = zero.aimPitch;
      const peak = [], settled = [];
      // Every round's window is one shot interval long, including the last one.
      // Letting round 30's window run to the end of the trace instead made its
      // settled value -0.012 deg — the trailing decay, not the pattern — which
      // would have been read as the recoil ending up *below* the point of aim.
      const span = rnds.length > 1 ? rnds[1].i - rnds[0].i : 1;
      for (let k = 0; k < rnds.length; k++) {
        const from = rnds[k].i;
        const to = Math.min(
          (k + 1 < rnds.length ? rnds[k + 1].i - 1 : from + span - 1), rows.length - 1);
        peak[k + 1] = (maxOf(rows, from, to, 'aimPitch') - aim0) * DEG;
        settled[k + 1] = (rows[Math.min(to, rows.length - 1)].aimPitch - aim0) * DEG;
      }
      const last = rnds.length ? rnds[rnds.length - 1].i : rows.length - 1;
      let yawMin = Infinity, yawMax = -Infinity;
      for (let i = 0; i <= last; i++) {
        yawMin = Math.min(yawMin, rows[i].aimYaw);
        yawMax = Math.max(yawMax, rows[i].aimYaw);
      }
      return {
        peak, settled,
        peakAll: Math.max(...peak.filter(Number.isFinite)),
        yawEnvelope: (yawMax - yawMin) * DEG,
        pitchDrift: (rows[last].pitch - zero.pitch) * DEG,
      };
    }

    const adsMag = await magazine({ ads: true });
    const hipMag = await magazine({ ads: false });

    // If the magazine did not empty, every climb number below is measured over
    // the wrong window — say so loudly rather than reporting a short mag as a
    // gentle recoil pattern.
    report.check('a full magazine of 30 rounds leaves the gun (ADS)',
      adsMag.rnds.length === 30,
      `${adsMag.rnds.length} ammo decrements over ${f3(2.9)} s of held trigger`);
    report.check('a full magazine of 30 rounds leaves the gun (hipfire)',
      hipMag.rnds.length === 30,
      `${hipMag.rnds.length} ammo decrements over ${f3(2.9)} s of held trigger`);

    const A = climbProfile(adsMag);
    const H = climbProfile(hipMag);
    const AT = [1, 3, 5, 10, 15, 20, 25, 30];

    report.check('ADS recoil climb per round is measured',
      AT.every((n) => Number.isFinite(A.peak[n])),
      `climb deg at rounds ${AT.join('/')} = ${AT.map((n) => f3(A.peak[n])).join(' / ')}`);
    report.check('hipfire recoil climb per round is measured',
      AT.every((n) => Number.isFinite(H.peak[n])),
      `climb deg at rounds ${AT.join('/')} = ${AT.map((n) => f3(H.peak[n])).join(' / ')}`);
    report.check('ADS settled climb between shots is measured',
      Number.isFinite(A.settled[30]),
      `settled deg at rounds ${AT.join('/')} = ${AT.map((n) => f3(A.settled[n])).join(' / ')}`);

    // The check the pattern actually lives or dies on.
    //
    // Three quarters of a magazine after round 10 must move the sights
    // somewhere. The 1.25x floor is not a CoD magnitude — no sourced figure is
    // being claimed — it is the weakest statement that distinguishes a pattern
    // from a plateau: a gun whose 30th round sits where its 10th did has no
    // pattern to learn, and learnability is the entire reason CoD recoil is
    // shaped rather than random.
    const ratio3010 = A.peak[30] / A.peak[10];
    report.check('ADS recoil still accumulates between round 10 and round 30',
      ratio3010 > 1.25,
      `climb 1.65-style plateau test: round 10 ${f3(A.peak[10])} deg, round 30 ${f3(A.peak[30])} deg, `
      + `ratio ${f3(ratio3010)} (structural floor 1.25x, not a sourced CoD figure) — `
      + `rounds 15/20/25/30 settle at ${[15, 20, 25, 30].map((n) => A.settled[n].toFixed(4)).join('/')} deg`);
    const ratio3010h = H.peak[30] / H.peak[10];
    report.check('hipfire recoil still accumulates between round 10 and round 30',
      ratio3010h > 1.25,
      `round 10 ${f3(H.peak[10])} deg, round 30 ${f3(H.peak[30])} deg, ratio ${f3(ratio3010h)}`);

    // The mechanism behind the plateau, stated as its own measurement: recoil
    // lives entirely in recoilPitch, which springs back to zero on its own and
    // never touches pitch. So a magazine of sustained fire leaves the player's
    // actual aim exactly where it started and there is nothing to pull down
    // against. In a shooter with a learnable pattern the view is displaced and
    // stays displaced until the player corrects it.
    report.check('30 rounds of sustained fire displace the player aim persistently',
      Math.abs(A.pitchDrift) > 0.05,
      `pitch (the part the player must correct) drifted ${A.pitchDrift.toFixed(5)} deg over 30 rounds; `
      + `all ${f3(A.peakAll)} deg of climb is in the self-cancelling recoil spring`);

    const hEnv = targetFor(['weapon.recoil.horizontalEnvelope', 'weapon.horizontalEnvelope']);
    if (hEnv) {
      report.against('ADS horizontal recoil envelope', A.yawEnvelope, hEnv.value, hEnv.tol, ' deg');
      report.check('horizontal envelope target is sourced', true, `source: ${hEnv.source}`);
    } else {
      report.check('ADS horizontal recoil envelope', true,
        `measured ${f3(A.yawEnvelope)} deg total left-right range across the magazine `
        + `(hipfire ${f3(H.yawEnvelope)} deg) — no sourced target yet`);
    }

    // ADS is supposed to be the controllable stance. Ratio only — the 0.66
    // scale in fire() is a constant, and this measures the behaviour.
    const adsCalm = A.peakAll / H.peakAll;
    report.check('ADS recoil is calmer than hipfire',
      adsCalm < 0.95,
      `peak climb ADS ${f3(A.peakAll)} deg vs hip ${f3(H.peakAll)} deg, ratio ${f3(adsCalm)}`);

    /* ---- instrument liveness -------------------------------------------- */
    //
    // Before any of the above is quoted as evidence about the game, prove the
    // probe responds to the game. Doubling the recoil impulse must double the
    // measured climb; if it does not, every recoil number in this file is a
    // property of the harness. This is the check that makes the plateau result
    // above mean something.
    if (SPEC) {
      await patchSpec('recoilPitch', SPEC.recoilPitch * 2);
      const louder = climbProfile(await magazine({ ads: true, seconds: 0.5 }));
      await restoreSpec();
      const grew = louder.peak[1] / A.peak[1];
      report.check('the recoil probe responds to the recoil it is measuring',
        grew > 1.5,
        `doubling SPEC.recoilPitch took round-1 climb from ${f3(A.peak[1])} to ${f3(louder.peak[1])} deg `
        + `(${f3(grew)}x) — the probe is live, so the plateau above is the game's`);
    }

    /* ========================================= 2. recoil recovery ====== */
    //
    // Ten rounds in ADS, then the trigger is released and the aim path watched
    // home. Two numbers matter and they pull in opposite directions: how long
    // the sights take to come back, and how far past the point of aim they go.
    // A spring tuned only for a fast return overshoots, and an overshoot drags
    // the sights *below* the target at exactly the moment the player fires the
    // follow-up shot.
    //
    // "Within 5% of point of aim" is scaled by the pattern's own peak, because
    // 5% of an absolute degree figure would be a different test on a gun with
    // twice the recoil.
    {
      await sim.setup({ ads: 1, ammo: 30, pitch: 0 });
      const zero = await sim.snapshot();
      const rows = await sim.drive({
        seconds: 2.2, dt: DT,
        // Releases itself after exactly 10 rounds — counted off ammo, which is
        // the only reliable round counter.
        input: IN_DYN('{ fire: g.weapon.ammo > 20, ads: true }'),
      });
      const rel = rows.findIndex((r) => r.ammo === 20);
      const aim0 = zero.aimPitch;
      if (rel < 0) {
        report.check('recoil recovery could be measured', false,
          `the trigger never released: ammo reached ${rows[rows.length - 1].ammo} after 2.2 s`);
      } else {
        const peak = (maxOf(rows, 0, rel, 'aimPitch') - aim0) * DEG;
        const residual = (rows[rel].aimPitch - aim0) * DEG;
        const band = 0.05 * peak;
        let backIdx = -1, under = 0;
        for (let i = rel; i < rows.length; i++) {
          const d = (rows[i].aimPitch - aim0) * DEG;
          if (backIdx < 0 && Math.abs(d) <= band) backIdx = i;
          under = Math.min(under, d);
        }
        const backT = backIdx < 0 ? NaN : rows[backIdx].t - rows[rel].t;
        const overshoot = -under;

        const tgt = targetFor(['weapon.recoil.recoveryTime', 'weapon.recoilRecovery']);
        if (tgt) {
          report.against('recoil recovery to within 5% of point of aim', backT, tgt.value, tgt.tol, ' s');
          report.check('recoil recovery target is sourced', true, `source: ${tgt.source}`);
        } else {
          report.check('recoil recovery to within 5% of point of aim', Number.isFinite(backT),
            `${ms(backT)} after trigger release (5% of a ${f3(peak)} deg peak = ${f3(band)} deg) `
            + '— no sourced target yet');
        }

        // A gun the player has to fight has somewhere to recover *from*. Here
        // the aim is essentially home on the tick the trigger comes up, which
        // is the same plateau seen from the other side: the spring cancels each
        // impulse inside its own 79 ms shot interval.
        report.check('the aim is still displaced when the trigger is released',
          Math.abs(residual) > 0.2 * peak,
          `residual ${f3(residual)} deg against a ${f3(peak)} deg peak (${(100 * residual / peak).toFixed(1)}%) `
          + '— structural floor 20%, not a sourced CoD figure');

        // Overshoot is a defect at any magnitude the player can see, so this
        // one is a fraction of the pattern rather than an absolute.
        report.check('recovery does not overshoot below the point of aim',
          overshoot < 0.10 * peak,
          `overshoot ${f3(overshoot)} deg past point of aim, ${(100 * overshoot / peak).toFixed(1)}% of the `
          + `${f3(peak)} deg peak`);
      }
    }

    /* ============================================ 3. determinism ======= */
    //
    // CoD recoil is largely deterministic, and that is not a detail — it is why
    // the pattern is learnable at all. Two magazines fired from an identical
    // state must trace the same path. Divergence is reported in degrees so a
    // partially-random pattern shows up as a magnitude rather than a boolean.
    {
      const again = await magazine({ ads: true });
      const n = Math.min(adsMag.rnds.length, again.rnds.length);
      let dPitch = 0, dYaw = 0, dT = 0;
      for (let k = 0; k < n; k++) {
        const a = adsMag.rows[adsMag.rnds[k].i], b = again.rows[again.rnds[k].i];
        dPitch = Math.max(dPitch, Math.abs(a.aimPitch - b.aimPitch) * DEG);
        dYaw = Math.max(dYaw, Math.abs(a.aimYaw - b.aimYaw) * DEG);
        dT = Math.max(dT, Math.abs((adsMag.rnds[k].t - adsMag.rnds[0].t) - (again.rnds[k].t - again.rnds[0].t)));
      }
      report.check('the same magazine fired twice traces the same recoil pattern',
        n === 30 && dPitch < 1e-6 && dYaw < 1e-6,
        `${n} rounds compared, max divergence ${dPitch.toExponential(2)} deg vertical, `
        + `${dYaw.toExponential(2)} deg horizontal, ${ms(dT)} in shot timing`);

      // The horizontal component is generated from a shot-index sine, so it is
      // a fixed left-right sequence rather than a random walk. Counting sign
      // changes says whether there is a shape to learn or just alternation.
      const signs = adsMag.rnds.map((r, k) => Math.sign(
        adsMag.rows[r.i].aimYaw - (k ? adsMag.rows[adsMag.rnds[k - 1].i].aimYaw : adsMag.zero.aimYaw)));
      let flips = 0;
      for (let k = 1; k < signs.length; k++) if (signs[k] !== signs[k - 1]) flips++;
      report.check('horizontal recoil has a repeatable left-right shape', true,
        `${flips} direction changes across 30 rounds within a ${f3(A.yawEnvelope)} deg envelope `
        + '— measured, no sourced target for pattern shape');
    }

    /* ============================================ 4. ADS transition ==== */
    //
    // player.js runs `ads = damp(ads, target, 16, dt)`, which is an exponential
    // approach with no end. That is a different object from a timed transition:
    // it has no completion instant, so "ADS time" is not a property the weapon
    // has, and any HUD, sensitivity scale or spread value keyed to ads == 1
    // never gets the value it is waiting for.
    let adsIn95 = NaN;
    {
      await sim.setup({ ads: 0, pitch: 0 });
      const start = await sim.snapshot();
      const rows = await sim.drive({ seconds: 2.5, dt: DT, input: IN({ ads: true }) });
      const at = (frac) => {
        const r = rows.find((x) => x.ads >= frac);
        return r ? r.t - start.t : NaN;
      };
      const t63 = at(0.63), t95 = at(0.95), t99 = at(0.99);
      // The blend never equals 1 — it is 1 - e^(-16t) — so "does it reach 1" is
      // only answerable as "how long until it is indistinguishable from 1".
      // 1e-6 is the point past which nothing in the game could act on the
      // difference; it is a resolution choice, not a CoD figure.
      const tArrive = at(1 - 1e-6);
      adsIn95 = t95;
      const end = rows[rows.length - 1];

      report.check('ADS transition profile', Number.isFinite(t63) && Number.isFinite(t99),
        `63% at ${ms(t63)}, 95% at ${ms(t95)}, 99% at ${ms(t99)}; after 2.5 s of held ADS the blend is `
        + `${end.ads.toFixed(9)} — this is an exponential damp (player.js damp(ads, target, 16, dt)), `
        + 'not a timed transition');

      // The signature test. A timed ramp hits 63/95/99% at 0.63/0.95/0.99 of
      // its duration (ratios 1.51 and 1.57); an exponential damp hits them at
      // ln(1/0.37) : ln(20) : ln(100), i.e. ratios ~3.0 and ~4.6.
      const r95 = t95 / t63, r99 = t99 / t63;
      report.check('ADS blend is a timed transition rather than an asymptotic damp',
        r95 < 2.0,
        `t95/t63 = ${f3(r95)} and t99/t63 = ${f3(r99)}; a timed ramp gives 1.51 and 1.57, `
        + 'an exponential damp 3.0 and 4.6');
      // A transition with an end has an end. This one is still measurably short
      // of its target long after the player believes they are aimed in, so
      // anything gated on the blend being complete — sensitivity scale, spread
      // floor, a HUD state — is waiting on an event that is late by design.
      report.check('the ADS blend arrives at its endpoint promptly',
        tArrive < 0.3,
        `within 1e-6 of 1 only at ${ms(tArrive)} (95% at ${ms(t95)}); after 2.5 s of held ADS it is still `
        + `short of 1 by ${(1 - end.ads).toExponential(2)} and never equals it`);

      const tgt = targetFor(['weapon.ads.time', 'weapon.adsTime', 'handling.adsTime']);
      if (tgt) {
        report.against('ADS time (95% of the blend)', t95, tgt.value, tgt.tol, ' s');
        report.check('ADS time target is sourced', true, `source: ${tgt.source}`);
      } else {
        report.check('ADS time (95% of the blend)', true,
          `measured ${ms(t95)} to 95%, ${ms(t99)} to 99% — no sourced target yet`);
      }

      // ADS out, for the round trip.
      const back = await sim.drive({ seconds: 1.0, dt: DT, input: IN({ ads: false }) });
      const out5 = back.find((x) => x.ads <= 0.05);
      report.check('ADS out to 5% of the blend', !!out5,
        out5 ? `${ms(out5.t - rows[rows.length - 1].t)} from full ADS back to 5%`
          : `never fell below 5% in 1.0 s (ended at ${back[back.length - 1].ads.toFixed(4)})`);

      // FOV is the visible half of the same transition.
      report.check('ADS narrows the field of view', Math.abs(end.fov - start.fov) > 1,
        `viewmodel lens ${f3(start.fov)} deg hip -> ${f3(end.fov)} deg ADS`);

      // Deadness probe. SPEC.adsTime is asserted-on nowhere in this file; what
      // is asserted is that changing it changes nothing, which is a statement
      // about behaviour and cannot be made by reading the source.
      if (SPEC) {
        await patchSpec('adsTime', SPEC.adsTime * 4);
        await sim.setup({ ads: 0, pitch: 0 });
        const s2 = await sim.snapshot();
        const rows2 = await sim.drive({ seconds: 0.6, dt: DT, input: IN({ ads: true }) });
        await restoreSpec();
        const t95b = (rows2.find((x) => x.ads >= 0.95)?.t ?? NaN) - s2.t;
        report.check('SPEC.adsTime governs the ADS transition',
          Math.abs(t95b - t95) > 0.02,
          `quadrupling SPEC.adsTime (${f3(SPEC.adsTime)} -> ${f3(SPEC.adsTime * 4)} s) moved t95 from `
          + `${ms(t95)} to ${ms(t95b)}, a change of ${ms(Math.abs(t95b - t95))} — the constant is dead`);
      }
    }

    /* ================================= 5. sprint-out penalties ========= */
    //
    // Sprint-to-fire and sprint-to-ADS are the two costs of running in a
    // modern shooter, and they are what stop a sprint from being free. Measured
    // from the tick sprint is released, using ammo for the first and the blend
    // for the second.
    //
    // One tick is the floor of the instrument, so the detail prints the tick
    // length beside the result: "0 ms" and "one tick" are the same reading and
    // the reader must be able to tell.
    {
      await sim.setup({ position: [-6, null, 17], yaw: laneYaw, ads: 0, ammo: 30, pitch: 0 });
      const spin = await sim.drive({
        seconds: 1.8, dt: DT, input: IN({ forward: true, sprint: true }),
      });
      const steady = spin[spin.length - 1];

      // Guard: if the sprint never engaged, both numbers below are measuring a
      // walk and mean nothing. This is the failure mode that produced a page of
      // null timings last session.
      report.check('the sprint used for the sprint-out measurement actually engaged',
        steady.sprinting === 1 && steady.speed > 6,
        `sprinting=${steady.sprinting} at ${f3(steady.speed)} m/s down a ${f3(lane.clear)} m lane `
        + `(heading ${lane.deg} deg)`);

      const t0 = await mark(sim);
      const out = await sim.drive({
        seconds: 0.8, dt: DT, input: IN({ forward: true, ads: true, fire: true }),
      });
      const shot = out.find((r) => r.ammo < 30);
      const ads95 = out.find((r) => r.ads >= 0.95);
      const sprintToFire = shot ? shot.t - t0 : NaN;
      const sprintToAds = ads95 ? ads95.t - t0 : NaN;

      const tgtF = targetFor(['weapon.sprintToFire', 'handling.sprintToFire']);
      if (tgtF) {
        report.against('sprint-to-fire', sprintToFire, tgtF.value, tgtF.tol, ' s');
        report.check('sprint-to-fire target is sourced', true, `source: ${tgtF.source}`);
      } else {
        report.check('sprint-to-fire', Number.isFinite(sprintToFire),
          `${ms(sprintToFire)} from releasing sprint to a round leaving the gun — no sourced target yet`);
      }

      report.check('releasing sprint costs time before the first round',
        sprintToFire > 1.5 * DT,
        `${ms(sprintToFire)} measured, one tick is ${ms(DT)} — the round leaves on the first tick after `
        + 'release, so sprinting has no fire penalty at all');

      report.check('releasing sprint costs time before ADS completes',
        Number.isFinite(sprintToAds) && sprintToAds - adsIn95 > 1.5 * DT,
        `sprint-to-ADS-95% ${ms(sprintToAds)} against a standing ADS-95% of ${ms(adsIn95)}: `
        + `penalty ${ms(sprintToAds - adsIn95)}`);
    }

    /* ================================================== 6. spread ====== */
    //
    // Cone half-angles, reported as full cone angles in degrees because that is
    // what a player reads off a crosshair. Every value comes from
    // weapon.currentSpread(player) through the snapshot, so it includes every
    // term the game applies rather than the ones a test remembered.

    async function spreadAfter({ ads = false, over = {}, seconds = 1.4, jump = false }) {
      await sim.setup({ position: [-6, null, 17], yaw: laneYaw, ads: ads ? 1 : 0, ammo: 30, pitch: 0 });
      await mark(sim);
      const body = jump
        ? `if (g.elapsed - window.__T0 < 0.03) g.player.requestJump(g.elapsed); ${IN_DYN(JSON.stringify({ ...over, ads }))}`
        : IN({ ...over, ads });
      const rows = await sim.drive({ seconds, dt: DT, input: body });
      return rows;
    }

    const restHip = (await spreadAfter({ ads: false })).pop();
    const restAdsRows = await spreadAfter({ ads: true, seconds: 2.0 });
    const restAds = restAdsRows[restAdsRows.length - 1];
    const movingRows = await spreadAfter({ ads: false, over: { forward: true } });
    const moving = movingRows[movingRows.length - 1];
    const crouchRows = await spreadAfter({ ads: false, over: { crouch: true } });
    const crouch = crouchRows[crouchRows.length - 1];
    const airHip = (await spreadAfter({ ads: false, jump: true, seconds: 0.7 }))
      .filter((r) => r.onGround === 0);
    const airAds = (await spreadAfter({ ads: true, jump: true, seconds: 0.7 }))
      .filter((r) => r.onGround === 0);

    const coneHip = restHip.spread * DEG * 2;
    const coneAds = restAds.spread * DEG * 2;

    const tgtHip = targetFor(['weapon.spread.hip', 'weapon.spreadHip']);
    if (tgtHip) {
      report.against('rest hipfire cone', coneHip, tgtHip.value, tgtHip.tol, ' deg');
      report.check('hipfire cone target is sourced', true, `source: ${tgtHip.source}`);
    } else {
      report.check('rest hipfire cone', true,
        `measured ${f3(coneHip)} deg full cone (${f3(restHip.spread * DEG)} deg half-angle) `
        + '— no sourced target yet');
    }
    const tgtAds = targetFor(['weapon.spread.ads', 'weapon.spreadAds']);
    if (tgtAds) {
      report.against('rest ADS cone', coneAds, tgtAds.value, tgtAds.tol, ' deg');
      report.check('ADS cone target is sourced', true, `source: ${tgtAds.source}`);
    } else {
      report.check('rest ADS cone', true,
        `measured ${f3(coneAds)} deg full cone at a settled blend of ${restAds.ads.toFixed(4)} `
        + `(${f3(restAds.spread * DEG)} deg half-angle) — no sourced target yet`);
    }
    report.check('ADS tightens the cone', coneAds < coneHip * 0.5,
      `ADS ${f3(coneAds)} deg vs hip ${f3(coneHip)} deg, ratio ${f3(coneAds / coneHip)}`);

    const mMoving = moving.spread / restHip.spread;
    const mCrouch = crouch.spread / restHip.spread;
    const mAirHip = airHip.length ? airHip[0].spread / restHip.spread : NaN;
    const mAirAds = airAds.length ? airAds[0].spread / restAds.spread : NaN;

    // Guard before the multiplier is quoted: a player who never got moving
    // produces a multiplier of ~1.0 that looks like a game result.
    report.check('the walk used for the motion multiplier actually moved',
      moving.speed > 3,
      `${f3(moving.speed)} m/s reached down a ${f3(lane.clear)} m lane after 1.4 s of held forward`);
    report.check('moving-vs-standing spread multiplier', true,
      `x${f3(mMoving)} at ${f3(moving.speed)} m/s (${f3(moving.spread * DEG * 2)} deg cone) `
      + '— measured, no sourced target yet');
    report.check('crouch-vs-standing spread multiplier', mCrouch < 1,
      `x${f3(mCrouch)} crouched (${f3(crouch.spread * DEG * 2)} deg cone); a crouch that did not steady `
      + 'the gun would be >= 1');
    report.check('firing in the air widens the cone', mAirHip > 1.05,
      `x${f3(mAirHip)} airborne hipfire (${f3((airHip[0]?.spread ?? NaN) * DEG * 2)} deg cone), `
      + `sampled over ${airHip.length} airborne ticks`);
    // Found while measuring the above and not in the baseline: the airborne
    // penalty in currentSpread() is a flat additive term with no ADS scaling,
    // so it is the same 0.022 rad whether hipfiring or aiming — which makes it
    // proportionally an order of magnitude worse in ADS, where the whole cone
    // is a tenth of that. Jumping deletes the sight entirely.
    report.check('the airborne spread penalty is scaled for ADS', mAirAds < mAirHip * 2,
      `airborne multiplier x${f3(mAirAds)} in ADS against x${f3(mAirHip)} hipfire: the penalty is a flat `
      + `additive term, so the ADS cone goes ${f3((airAds[0]?.spread ?? NaN) * DEG * 2)} deg — `
      + `${f3((airAds[0]?.spread ?? NaN) / restHip.spread)}x the resting *hipfire* cone`);

    /* ---- bloom and its recovery ---------------------------------------- */
    {
      await sim.setup({ ads: 1, ammo: 30, pitch: 0 });
      const before = await sim.snapshot();
      const one = await sim.drive({
        seconds: 0.3, dt: DT, input: IN_DYN('{ fire: g.weapon.ammo > 29, ads: true }'),
      });
      const afterOne = Math.max(...one.map((r) => r.spread));
      const bloom = (afterOne - before.spread) * DEG * 2;
      report.check('bloom per shot', bloom > 0,
        `one round widened the cone by ${f3(bloom)} deg (from ${f3(before.spread * DEG * 2)} to `
        + `${f3(afterOne * DEG * 2)} deg) — measured, no sourced target yet`);

      // Ten rounds, then watch it come back. The recovery gate in weapon.js
      // only opens 0.12 s after the last shot, so the measured rate is taken
      // over the decay itself rather than from the moment of release.
      await sim.setup({ ads: 1, ammo: 30, pitch: 0 });
      const rest = (await sim.snapshot()).spread;
      const rows = await sim.drive({
        seconds: 3.0, dt: DT, input: IN_DYN('{ fire: g.weapon.ammo > 20, ads: true }'),
      });
      const relIdx = rows.findIndex((r) => r.ammo === 20);
      const peak = Math.max(...rows.map((r) => r.spread));
      const backIdx = rows.findIndex((r, i) => i > relIdx && r.spread <= rest * 1.01);
      const decay = backIdx > relIdx
        ? (peak - rows[backIdx].spread) * DEG / (rows[backIdx].t - rows[relIdx].t)
        : NaN;
      report.check('bloom recovers to the resting cone after firing stops',
        backIdx > relIdx,
        `peak ${f3(peak * DEG * 2)} deg after 10 rounds, back within 1% of the ${f3(rest * DEG * 2)} deg `
        + `rest cone in ${ms(backIdx > relIdx ? rows[backIdx].t - rows[relIdx].t : NaN)} `
        + `at ${f3(decay)} deg/s (half-angle) — measured, no sourced target yet`);
      report.check('bloom saturates below the cone ceiling',
        SPEC ? peak < SPEC.spreadMax : true,
        SPEC ? `peak half-angle ${f3(peak * DEG)} deg against the ${f3(SPEC.spreadMax * DEG)} deg ceiling`
          : `peak half-angle ${f3(peak * DEG)} deg, ceiling unknown (SPEC unreachable)`);
    }

    /* ================================================= 7. cadence ====== */
    //
    // Rate of fire from ammo decrements, at three step sizes.
    //
    // The three step sizes are the measurement, not paranoia. canFireAt() gates
    // on `now - lastShot >= 60/rpm` and fire() then stamps lastShot with the
    // *current* tick rather than the scheduled one, so the interval is rounded
    // up to a whole number of ticks and the error never repays itself. The
    // shipping loop runs on clock.getDelta() at roughly 1/60, which is the
    // worst of the three.
    {
      const measured = [];
      for (const dt of [1 / 60, 1 / 120, 1 / 240]) {
        await sim.setup({ ads: 0, ammo: 30, pitch: 0 });
        const rows = await sim.drive({ seconds: 3.2, dt, input: IN({ fire: true }) });
        const rnds = roundsOf(rows, 30);
        const rpm = rnds.length > 1
          ? 60 * (rnds.length - 1) / (rnds[rnds.length - 1].t - rnds[0].t) : NaN;
        const gaps = rnds.slice(1).map((r, i) => r.t - rnds[i].t);
        measured.push({
          dt, rpm, rounds: rnds.length,
          jitter: gaps.length ? Math.max(...gaps) - Math.min(...gaps) : NaN,
        });
      }
      const fine = measured.find((m) => m.dt === 1 / 240);
      const ship = measured.find((m) => m.dt === 1 / 60);

      report.check('cadence measured at three step sizes', measured.every((m) => m.rounds === 30),
        measured.map((m) => `1/${Math.round(1 / m.dt)}: ${m.rpm.toFixed(1)} rpm (${m.rounds} rounds, `
          + `jitter ${ms(m.jitter)})`).join('; '));

      const tgtRpm = targetFor(['weapon.rpm', 'weapon.cadence.rpm']);
      const specRpm = tgtRpm ? tgtRpm.value : (SPEC ? SPEC.rpm : null);
      if (specRpm) {
        // 5%, deliberately. verify.mjs accepts 900 rpm against a 780 spec — a
        // 15% error — and a 15% cadence error is a different gun: it is 4.5
        // rounds either way across a magazine.
        report.against('rate of fire at 1/240', fine.rpm, specRpm, { pct: 0.05 }, ' rpm');
        report.against('rate of fire at 1/60 (the shipping step)', ship.rpm, specRpm, { pct: 0.05 }, ' rpm');
        report.check('rate of fire target source', true,
          tgtRpm ? `source: ${tgtRpm.source}` : `SPEC.rpm = ${specRpm}, read live from the page`);
      } else {
        report.check('rate of fire', true,
          `${fine.rpm.toFixed(1)} rpm at 1/240, ${ship.rpm.toFixed(1)} rpm at 1/60 — no target available`);
      }

      const spread = Math.max(...measured.map((m) => m.rpm)) - Math.min(...measured.map((m) => m.rpm));
      report.check('rate of fire is independent of the step size',
        spread / fine.rpm < 0.02,
        `${spread.toFixed(1)} rpm between 1/60 (${ship.rpm.toFixed(1)}) and 1/240 (${fine.rpm.toFixed(1)}), `
        + `${(100 * spread / fine.rpm).toFixed(1)}% of the rate — the shot interval is rounded up to a whole `
        + 'tick, so the gun fires slower the coarser the frame');
    }

    /* ================================================== 8. reload ====== */
    //
    // Timed from the ammo actually coming back, not from the reloading flag
    // clearing and not from the animation track: those are the game's own
    // opinion of when it finished, and the round in the chamber is the player's.
    {
      // Tactical: one round short, so startReload() is allowed and the return
      // is a single round — which also exposes the reserve accounting.
      await sim.setup({ ads: 0, ammo: 29, pitch: 0 });
      const pre = await sim.snapshot();
      const t0 = await sim.eval(() => { window.__GAME.tryReload(); return window.__GAME.elapsed; });
      const started = await sim.snapshot();
      report.check('the tactical reload started',
        started.reloading === 1,
        `reloading=${started.reloading} with ${started.ammo} in the magazine and ${started.reserve} in reserve`);

      // The trigger is held down for the whole reload: a reload that can be
      // cancelled into a shot is the classic exploit, and holding fire is how
      // it would show up.
      const rows = await sim.drive({
        seconds: 3.4, dt: DT_RELOAD, input: IN({ fire: true }),
      });
      const doneIdx = rows.findIndex((r) => r.ammo > pre.ammo);
      const tactical = doneIdx < 0 ? NaN : rows[doneIdx].t - t0;
      let shotsDuring = 0;
      for (let i = 1; i < (doneIdx < 0 ? rows.length : doneIdx); i++) {
        if (rows[i].ammo < rows[i - 1].ammo) shotsDuring++;
      }

      const tgtT = targetFor(['weapon.reload.tactical', 'weapon.reloadTime']);
      if (tgtT) {
        report.against('tactical reload', tactical, tgtT.value, tgtT.tol, ' s');
        report.check('tactical reload target is sourced', true, `source: ${tgtT.source}`);
      } else if (SPEC) {
        report.against('tactical reload (against live SPEC.reloadTime)',
          tactical, SPEC.reloadTime, { pct: 0.05 }, ' s');
      } else {
        report.check('tactical reload', Number.isFinite(tactical),
          `${ms(tactical)} to the ammo returning — no target available`);
      }
      report.check('a reload cannot be cancelled into a shot',
        shotsDuring === 0,
        `${shotsDuring} rounds left the gun while the trigger was held through a ${ms(tactical)} reload`);
      const after = rows[doneIdx < 0 ? rows.length - 1 : doneIdx];
      report.check('the reload returns the magazine and debits the reserve',
        after.ammo === 30 && after.reserve === started.reserve - 1,
        `magazine ${started.ammo} -> ${after.ammo}, reserve ${started.reserve} -> ${after.reserve}`);

      // Empty reload.
      //
      // `setup({ ammo: 0 })` cannot be used to get here: _sim.mjs writes
      // `w.ammo = cfg.ammo ?? w.constructor.name ? (cfg.ammo ?? 30) : 30`, and
      // `??` binds tighter than the conditional, so a requested 0 is falsy,
      // takes the else branch and loads a full magazine. The first version of
      // this section measured an 8 ms "empty reload" on a full gun. Emptying it
      // afterwards, through the same page state, is unambiguous.
      //
      // step() then auto-starts the reload on the tick ammo is seen at zero, so
      // the start instant is the first sampled tick with reloading set — read
      // out of the trace rather than assumed, because the auto-reload is the
      // game's decision and not this test's.
      await sim.setup({ ads: 0, ammo: 30, pitch: 0 });
      await sim.eval(() => {
        const w = window.__GAME.weapon;
        w.ammo = 0; w.reserve = 180; w.reloading = false; w.lastShot = -99;
      });
      const erows = await sim.drive({ seconds: 3.6, dt: DT_RELOAD, input: IN({ fire: true }) });
      const eStart = erows.findIndex((r) => r.reloading === 1);
      const eIdx = erows.findIndex((r, i) => i > eStart && r.ammo > 0);
      const empty = (eStart < 0 || eIdx < 0) ? NaN : erows[eIdx].t - erows[eStart].t;
      report.check('an empty magazine starts its own reload',
        eStart >= 0,
        eStart >= 0
          ? `reloading went true ${ms(erows[eStart].t - erows[0].t + DT_RELOAD)} after the magazine ran dry`
          : `reloading never went true across ${f3(3.6)} s with 0 rounds loaded and 180 in reserve`);
      let eShots = 0;
      for (let i = 1; i < (eIdx < 0 ? erows.length : eIdx); i++) {
        if (erows[i].ammo < erows[i - 1].ammo) eShots++;
      }

      const tgtE = targetFor(['weapon.reload.empty', 'weapon.reloadEmptyTime']);
      if (tgtE) {
        report.against('empty reload', empty, tgtE.value, tgtE.tol, ' s');
        report.check('empty reload target is sourced', true, `source: ${tgtE.source}`);
      } else if (SPEC) {
        report.against('empty reload (against live SPEC.reloadEmptyTime)',
          empty, SPEC.reloadEmptyTime, { pct: 0.05 }, ' s');
      } else {
        report.check('empty reload', Number.isFinite(empty),
          `${ms(empty)} to the ammo returning — no target available`);
      }
      report.check('an empty reload penalises the player over a tactical one',
        empty > tactical + 0.05,
        `empty ${ms(empty)} vs tactical ${ms(tactical)}, penalty ${ms(empty - tactical)}`);
      report.check('an empty reload cannot be cancelled into a shot',
        eShots === 0 && erows[eIdx < 0 ? erows.length - 1 : eIdx].ammo === 30,
        `${eShots} rounds fired during the reload; magazine came back at `
        + `${erows[eIdx < 0 ? erows.length - 1 : eIdx].ammo}`);
    }
  } finally {
    // Any SPEC value this suite patched has to go back whatever happened: the
    // runner boots one sim for every suite, and a leaked mutation would show up
    // as a mystery failure in whichever file runs next.
    await restoreSpec().catch(() => {});
  }
}
