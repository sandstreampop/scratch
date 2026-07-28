// Movement and collision measurement suite.
//
// Everything here is measured through the running simulation at a fixed dt.
// Nothing asserts on a tuning constant as if it were a fact about the game:
// TUNING is read in exactly two roles, both of them as the *claim under test* —
// "does the body respect the cap it declares" and "does the body respect the
// step height it declares" — and in both cases the verdict comes from an
// observed trajectory. That distinction is the whole point: SPEC.adsTime sat at
// 0.19 for months while the real ADS transition was an exponential damp, and
// any test that read the constant would have reported a correct number for a
// behaviour that did not exist.
//
// What this file establishes, in order:
//
//   0  a test site, chosen at runtime, and proof that the instruments used to
//      judge collision can see a violation when one is present
//   1  top speed per stance, the ratio of each to walk, and whether each
//      overshoots the cap it declares for itself
//   2  the cap is enforced on the wish axis, not on speed — turning at full
//      sprint exceeds the sprint cap
//   3  acceleration and deceleration times (90% / 99% both ways)
//   4  jump height, airtime, apex consistency
//   5  air control, in m/s and as a fraction of ground strafe speed
//   6  frame-rate independence across dt = 1/30 .. 1/240
//   7  collision: pass-through, step-up, and a long randomised walk
//   8  slide — detected behaviourally, currently absent
//   9  mantle — detected behaviourally, currently absent
//
// Sections 8 and 9 are written to fail today. They are not placeholders: they
// describe the mechanic behaviourally (a speed above walk that decays over a
// bounded window; getting on top of a chest-high ledge without a jump) so that
// whatever implementation lands, these checks judge it rather than its naming.

let TARGETS = null, inside = null;
try { ({ TARGETS, inside } = await import('./targets.mjs')); } catch { /* research workflow has not written it yet */ }

export const NAME = 'movement';

/* ------------------------------------------------------------- plumbing -- */

const KEYS = ['forward', 'back', 'left', 'right', 'sprint', 'crouch', 'ads', 'fire'];

/**
 * Builds an input patch that names EVERY key.
 *
 * drive() Object.assigns the returned patch onto g.input, so a patch that omits
 * a key leaves whatever was there. `return {}` after `return {forward:true}`
 * does not release forward — it holds it. This has already produced one silent
 * measurement of "deceleration" in which the player never stopped accelerating,
 * so every input body in this file goes through here and states all eight.
 */
const hold = (...on) => `return {${KEYS.map((k) => `${k}:${on.includes(k)}`).join(',')}};`;

/**
 * yaw that makes a given key combination travel along world heading `deg`.
 *
 * The controller builds its wish vector from forward = (-sin y, -cos y) and
 * right = (cos y, -sin y), so a combination (f forward, r right) travels at
 * heading yaw + PI + atan2(-r, f). Inverting that is what lets the strafe and
 * backpedal runs use the same cleared corridor as the forward runs — measuring
 * strafe top speed by strafing sideways into a hut measures the hut.
 */
const yawFor = (deg, f, r) => deg * Math.PI / 180 - Math.PI - Math.atan2(-r, f);

const dirOf = (deg) => [Math.sin(deg * Math.PI / 180), Math.cos(deg * Math.PI / 180)];

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const spreadPct = (a) => {
  const lo = Math.min(...a), hi = Math.max(...a), mid = (lo + hi) / 2;
  return mid === 0 ? 0 : (hi - lo) / mid * 100;
};

/** Steady state: the mean over the last `secs` of a trace, not its final tick. */
const steadyOf = (rows, dt, secs = 0.5) => {
  const n = Math.max(2, Math.round(secs / dt));
  return mean(rows.slice(-n).map((r) => r.speed));
};

/** First time (relative to trace start) at which `pred` holds, or null. */
const firstAt = (rows, pred) => {
  const t0 = rows[0].t;
  const r = rows.find(pred);
  return r ? r.t - t0 : null;
};

/**
 * Sourced-target lookup.
 *
 * targets.mjs is written by a separate research workflow and its shape is not
 * fixed yet, so this walks whatever object it exports looking for a key that
 * matches one of `names` and yields a number. When nothing matches, the caller
 * still reports the measurement — a missing target must show up as a gap in
 * coverage, not as a quantity nobody measured. Inventing a Call of Duty number
 * here is the one failure mode this project has already been burned by, so
 * there is deliberately no default value anywhere in this file.
 */
function findTarget(...names) {
  if (!TARGETS) return null;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = names.map(norm);
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 5 || seen.has(node)) return null;
    seen.add(node);
    for (const [k, v] of Object.entries(node)) {
      if (want.includes(norm(k))) {
        if (typeof v === 'number') return { value: v, source: node.source ?? null, unit: null };
        if (v && typeof v === 'object') {
          const value = [v.value, v.target, v.median, v.metres, v.mps].find((x) => typeof x === 'number');
          if (typeof value === 'number') {
            return { value, source: v.source ?? v.cite ?? null, unit: v.unit ?? null, tol: v.tol ?? null,
              min: typeof v.min === 'number' ? v.min : null, max: typeof v.max === 'number' ? v.max : null };
          }
        }
      }
      const deeper = walk(v, depth + 1);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(TARGETS, 0);
}

/**
 * Reports a measurement, comparing it to a sourced target when one exists.
 *
 * With no target the number is still printed and the check passes — the point
 * is that the value is on the record and the missing reference is visible.
 */
function measured(report, name, value, unit, names, fallbackTol = { pct: 0.15 }) {
  const t = names ? findTarget(...names) : null;
  if (!t) {
    report.check(name, true,
      `measured ${Number(value).toFixed(4)}${unit} — no sourced target yet (targets.mjs ${TARGETS ? 'has no entry' : 'not written'})`);
    return null;
  }
  const tol = (t.min != null && t.max != null) ? { min: t.min, max: t.max } : (t.tol ?? fallbackTol);
  let ok;
  if (typeof inside === 'function') {
    // targets.mjs may ship its own comparator; prefer it, but never let a
    // surprise in its signature turn into a suite that throws.
    try { ok = inside(value, t); } catch { ok = undefined; }
  }
  const res = report.against(name, value, t.value, tol, unit);
  if (t.source) console.log(`        source: ${t.source}`);
  if (ok !== undefined && ok !== res) {
    console.log(`        note: targets.inside() disagrees with the tolerance band (${ok} vs ${res})`);
  }
  return res;
}

/* ------------------------------------------------------------- the suite -- */

export default async function run(sim, report) {
  const T = await sim.eval(async () => {
    // The declared tuning, read once so sections 1 and 7 can test the body
    // against the bounds the body claims for itself. Never used as a stand-in
    // for a measurement.
    try { return (await import('/src/player.js')).TUNING; } catch { return null; }
  });
  if (!T) {
    report.check('player TUNING is readable for self-consistency checks', false,
      'import of /src/player.js failed — cap-overshoot checks would have nothing to compare against (0 caps read)');
  }

  // One page-side instrument, shared by every collision check below, so the
  // "body is inside geometry" question is answered by the same code in the
  // randomised walk and in the proof that the answer can be yes.
  const baseColliders = await sim.eval(() => {
    const g = window.__GAME, THREE = window.__THREE;
    window.__MOVE = {
      /** Deepest overlap between the player's own AABB and any world collider. */
      pen() {
        const p = g.player;
        const box = p.aabb(new THREE.Box3());
        const near = box.clone().expandByScalar(0.30);
        let depth = 0, which = -1, contact = 0;
        for (let k = 0; k < g.level.colliders.length; k++) {
          const c = g.level.colliders[k];
          if (near.intersectsBox(c)) contact = 1;
          if (!box.intersectsBox(c)) continue;
          const d = Math.min(
            box.max.x - c.min.x, c.max.x - box.min.x,
            box.max.y - c.min.y, c.max.y - box.min.y,
            box.max.z - c.min.z, c.max.z - box.min.z);
          if (d > depth) { depth = d; which = k; }
        }
        return { depth, which, contact };
      },
      /** Adds a synthetic collider. Sections 7-9 need obstacles of a known size. */
      addBox(min, max) {
        g.level.colliders.push(new THREE.Box3(
          new THREE.Vector3(min[0], min[1], min[2]), new THREE.Vector3(max[0], max[1], max[2])));
        return g.level.colliders.length;
      },
      /** Restores the collider list. This sim is shared with every other suite. */
      trim(n) { g.level.colliders.length = n; },
      standUp() {
        // setup() resets `crouching` but not the damped `height`, so a run that
        // follows the crouch measurement would start 0.67 m short and collide
        // with a different body than the one under test.
        const p = g.player;
        p.crouching = false; p.height = p.targetHeight = 1.82;
        p.ads = p.adsTarget = 0;
      },
    };
    return g.level.colliders.length;
  });

  try {
    await sections(sim, report, T, baseColliders);
  } finally {
    // Synthetic geometry must not outlive this suite: the runner hands the same
    // sim to every other suite, and a leftover 1.15 m wall in the middle of the
    // compound would silently corrupt someone else's numbers.
    const left = await sim.eval((n) => { window.__MOVE.trim(n); return window.__GAME.level.colliders.length; }, baseColliders);
    if (left !== baseColliders) {
      report.check('synthetic colliders removed', false, `collider list left at ${left}, expected ${baseColliders}`);
    }
  }
}

async function sections(sim, report, T, baseColliders) {
  /* ==== 0. test site, and proof the collision instrument can see a fault === */

  // Every number below is site-dependent, so the site is chosen by measurement
  // and reported. The requirement is a corridor: 26 m long and +/-3.5 m wide
  // clear of colliders, because the strafe, turning and air-control runs all
  // leave the centre line. Cardinal headings only, so that the synthetic
  // obstacles in sections 7-9 are square to the direction of travel and their
  // dimensions mean what they say.
  const site = await sim.eval((cfg) => {
    const g = window.__GAME, L = g.level, THREE = window.__THREE;
    const box = new THREE.Box3();
    const occupied = (x, z) => {
      const y = L.groundHeight(x, z);
      box.min.set(x - 0.45, y - 0.05, z - 0.45);
      box.max.set(x + 0.45, y + 1.95, z + 0.45);
      for (const c of L.colliders) if (box.intersectsBox(c)) return true;
      return false;
    };
    let best = null;
    for (let x = -34; x <= 34; x += 2) {
      for (let z = -34; z <= 34; z += 2) {
        for (const deg of [0, 90, 180, 270]) {
          const dx = Math.round(Math.sin(deg * Math.PI / 180)), dz = Math.round(Math.cos(deg * Math.PI / 180));
          const y0 = L.groundHeight(x, z);
          let slope = 0, grad = 0, ok = true;
          for (let d = 0; d <= cfg.len && ok; d += 1) {
            for (const off of [-cfg.half, 0, cfg.half]) {
              const px = x + dx * d - dz * off, pz = z + dz * d + dx * off;
              if (occupied(px, pz)) { ok = false; break; }
              slope = Math.max(slope, Math.abs(L.groundHeight(px, pz) - y0));
              if (off === 0) {
                // Gradient over half a metre along the centre line. This, not
                // the total rise, is what decides whether the body leaves the
                // ground while running (see the contact-stability check).
                const a = L.groundHeight(px, pz), b = L.groundHeight(px + dx * 0.5, pz + dz * 0.5);
                grad = Math.max(grad, Math.abs(b - a) / 0.5);
              }
            }
          }
          if (ok && (!best || grad < best.grad)) best = { x, z, deg, slope, grad, y0 };
        }
      }
    }
    return best;
  }, { len: 26, half: 3.5 });

  if (!site) throw new Error('movement: no clear 26 m corridor in the level — every measurement below would be of a wall');
  report.check('test site is a flat clear corridor', site.grad < 0.05,
    `x=${site.x} z=${site.z} heading ${site.deg} deg, 26 m long x +/-3.5 m wide, `
    + `ground ${site.y0.toFixed(3)} m, max rise/fall along it ${site.slope.toFixed(3)} m, `
    + `steepest gradient along the centre line ${(site.grad * 100).toFixed(2)}% `
    + '(this is the flattest cardinal corridor of that size in the level)');

  const pos = [site.x, null, site.z];
  const [DX, DZ] = dirOf(site.deg);
  const fwdYaw = yawFor(site.deg, 1, 0);
  const DT = 1 / 240;

  // The instrument that judges the randomised walk must be able to return
  // "inside". Teleporting the body into the middle of a real collider and
  // confirming a positive depth is what separates a clean walk from a dead
  // probe reporting silence, which is exactly how the last session's TTK
  // numbers all came back null.
  const probe = await sim.eval(() => {
    const g = window.__GAME;
    const p = g.player;
    const keep = p.position.clone();
    // A collider tall enough to swallow the body, so "no overlap" cannot be an
    // accident of the box being under our feet.
    const c = g.level.colliders.find((b) => (b.max.y - b.min.y) > 1.6 && (b.max.x - b.min.x) > 0.8);
    if (!c) return { ok: false, why: 'no collider taller than 1.6 m in the level' };
    p.position.set((c.min.x + c.max.x) / 2, c.min.y + 0.1, (c.min.z + c.max.z) / 2);
    const insideDepth = window.__MOVE.pen().depth;
    p.position.copy(keep);
    const outsideDepth = window.__MOVE.pen().depth;
    return { ok: true, insideDepth, outsideDepth };
  });
  report.check('penetration detector reports depth for a body inside geometry',
    probe.ok && probe.insideDepth > 0.1 && probe.outsideDepth === 0,
    probe.ok
      ? `centre of a collider read ${probe.insideDepth.toFixed(3)} m deep, spawn point read ${probe.outsideDepth.toFixed(3)} m`
      : probe.why);

  /* ==== 1. top speed per stance ============================================ */

  // Each stance is driven along the same corridor by rotating the player rather
  // than the corridor, so strafe and backpedal are measured over the same
  // ground and the same slope as walk. 3 s is ~10x the longest observed rise
  // time, so the tail of each trace is genuinely steady.
  const STANCES = [
    { key: 'walk', keys: ['forward'], f: 1, r: 0, cap: 'walkSpeed' },
    { key: 'sprint', keys: ['forward', 'sprint'], f: 1, r: 0, cap: 'sprintSpeed' },
    { key: 'crouch', keys: ['forward', 'crouch'], f: 1, r: 0, cap: 'crouchSpeed' },
    { key: 'ads', keys: ['forward', 'ads'], f: 1, r: 0, cap: 'adsSpeed' },
    { key: 'strafe', keys: ['right'], f: 0, r: 1, cap: 'walkSpeed' },
    { key: 'backpedal', keys: ['back'], f: -1, r: 0, cap: 'walkSpeed' },
  ];

  const S = {};
  for (const st of STANCES) {
    await sim.setup({ position: pos, yaw: yawFor(site.deg, st.f, st.r), ads: 0 });
    await sim.eval(() => window.__MOVE.standUp());
    const rows = await sim.drive({ seconds: 3, dt: DT, input: hold(...st.keys) });
    const peak = Math.max(...rows.map((r) => r.speed));
    const peakRow = rows.find((r) => r.speed === peak);
    S[st.key] = {
      peak,
      steady: steadyOf(rows, DT),
      peakT: peakRow.t - rows[0].t,
      airFrac: rows.filter((r) => !r.onGround).length / rows.length,
      sprintFrac: rows.filter((r) => r.sprinting).length / rows.length,
      rows,
    };
  }

  for (const st of STANCES) {
    const m = S[st.key];
    measured(report, `top speed ${st.key}`, m.steady, ' m/s',
      [`${st.key}Speed`, `${st.key}TopSpeed`, st.key]);
  }

  // Ratios to walk. These are the numbers a player feels: nobody perceives
  // 2.35 m/s, they perceive "crouch is half speed".
  for (const st of STANCES) {
    if (st.key === 'walk') continue;
    measured(report, `ratio ${st.key} / walk`, S[st.key].steady / S.walk.steady, 'x',
      [`${st.key}Ratio`, `${st.key}ToWalk`]);
  }

  // Behavioural invariants that need no external reference, only internal
  // consistency. The backpedal one is a real bug: wish is scaled by
  // backpedalScale and then normalised, which throws the scale away, so walking
  // backwards is FASTER than walking forwards (the extra comes from the
  // backpedal vector being the only contributor and the cap being walkSpeed).
  report.check('backpedal is slower than walking forward',
    S.backpedal.steady < S.walk.steady,
    `backpedal ${S.backpedal.steady.toFixed(3)} m/s vs walk ${S.walk.steady.toFixed(3)} m/s `
    + `= ${(S.backpedal.steady / S.walk.steady).toFixed(3)}x`
    + (T ? `, declared backpedalScale ${T.backpedalScale} (expected <= ${(T.backpedalScale * S.walk.steady).toFixed(3)} m/s)` : ''));

  report.check('sprint is faster than walk, crouch and ADS are slower',
    S.sprint.steady > S.walk.steady && S.crouch.steady < S.walk.steady && S.ads.steady < S.walk.steady,
    `sprint ${S.sprint.steady.toFixed(3)} > walk ${S.walk.steady.toFixed(3)} > `
    + `ads ${S.ads.steady.toFixed(3)} > crouch ${S.crouch.steady.toFixed(3)} m/s`);

  report.check('strafe speed is not faster than forward walk',
    S.strafe.steady <= S.walk.steady * 1.001,
    `strafe ${S.strafe.steady.toFixed(3)} m/s = ${(S.strafe.steady / S.walk.steady).toFixed(4)}x walk `
    + '— there is no separate strafe scale in the model, sideways is full speed');

  // Cap overshoot. The cap is the game's own declared bound, and the verdict is
  // the observed peak of the trace, so this is a self-consistency test rather
  // than a test of a constant. Both failures found here are transients: the
  // acceleration step can only be capped on the wish axis, and while a cap is
  // being *lowered* (the ADS blend) the body is above it for the duration.
  if (T) {
    for (const st of STANCES) {
      const cap = T[st.cap];
      const m = S[st.key];
      const over = (m.peak / cap - 1) * 100;
      report.check(`${st.key} respects its own ${st.cap} cap`, m.peak <= cap * 1.001,
        `peak ${m.peak.toFixed(4)} m/s vs declared ${cap} m/s (${over >= 0 ? '+' : ''}${over.toFixed(2)}%), `
        + `peak at t+${m.peakT.toFixed(3)} s, steady ${m.steady.toFixed(4)} m/s`);
    }
  }

  // Not in the baseline: on ground this gentle (max 0.04 m of rise over 26 m)
  // the controller still spends part of every straight run airborne. The
  // vertical step per tick is g*dt^2 = 0.34 mm at 1/240, so any downslope
  // steeper than g*dt/v (1.1% at sprint speed) drops the body off the ground for
  // that tick — and `wantSprint` requires onGround, so the sprint cap and the
  // sprint flag flicker with it. The threshold is dt-dependent, which makes
  // this a frame-rate artefact as well as a contact one.
  const flickerGrad = T ? T.gravity * DT / S.sprint.steady : NaN;
  report.check('ground contact is stable while running on flat ground',
    S.sprint.airFrac < 0.01,
    `${(S.sprint.airFrac * 100).toFixed(1)}% of ticks airborne during a straight 3 s sprint over a corridor whose `
    + `steepest gradient is ${(site.grad * 100).toFixed(2)}% (total rise/fall ${site.slope.toFixed(3)} m in 26 m); `
    + `the body falls only g*dt^2 per tick, so any downslope past g*dt/v = ${(flickerGrad * 100).toFixed(2)}% at `
    + `${S.sprint.steady.toFixed(2)} m/s drops it off the ground — sprinting flag held for only `
    + `${(S.sprint.sprintFrac * 100).toFixed(1)}% of ticks as a result, and the threshold scales with dt`);

  /* ==== 2. the cap is applied to the wish axis, not to speed ================ */

  // Reaching sprint speed straight ahead and then asking for a diagonal adds a
  // full acceleration step along the new wish direction while the old velocity
  // is only projected onto it, so the resulting magnitude exceeds the cap. This
  // is the mechanism behind the 7.295 m/s sprint figure in the baseline: it is
  // not the straight-line top speed (that settles on the cap exactly) but what
  // a turn does to it.
  const SETTLE = Math.round(1.2 / DT);
  await sim.setup({ position: pos, yaw: fwdYaw, ads: 0 });
  await sim.eval(() => window.__MOVE.standUp());
  const turn = await sim.drive({
    seconds: 2.0, dt: DT,
    input: `if (i < ${SETTLE}) { ${hold('forward', 'sprint')} } ${hold('forward', 'right', 'sprint')}`,
  });
  const turnPeak = Math.max(...turn.slice(SETTLE).map((r) => r.speed));
  await sim.setup({ position: pos, yaw: fwdYaw, ads: 0 });
  const swing = await sim.drive({
    seconds: 2.0, dt: DT,
    // A 110 deg/s mouse turn, which is an ordinary corner-taking rate.
    input: `if (i >= ${SETTLE}) g.player.yaw += 1.92 * ${DT}; ${hold('forward', 'sprint')}`,
  });
  const swingPeak = Math.max(...swing.slice(SETTLE).map((r) => r.speed));
  if (T) {
    report.check('sprint cap holds through a direction change', turnPeak <= T.sprintSpeed * 1.001,
      `hitting sprint speed then adding strafe peaks at ${turnPeak.toFixed(4)} m/s vs cap ${T.sprintSpeed} `
      + `(+${((turnPeak / T.sprintSpeed - 1) * 100).toFixed(2)}%); a 110 deg/s turn peaks at ${swingPeak.toFixed(4)} m/s `
      + `(+${((swingPeak / T.sprintSpeed - 1) * 100).toFixed(2)}%) — the cap is enforced on the wish axis, not on |v|`);
  }

  /* ==== 3. acceleration and deceleration =================================== */

  for (const key of ['walk', 'sprint']) {
    const rows = S[key].rows;
    const target = S[key].steady;
    const t90 = firstAt(rows, (r) => r.speed >= 0.90 * target);
    const t99 = firstAt(rows, (r) => r.speed >= 0.99 * target);
    measured(report, `${key} accel to 90% of top speed`, t90 * 1000, ' ms', [`${key}Accel90`, `${key}TimeTo90`]);
    measured(report, `${key} accel to 99% of top speed`, t99 * 1000, ' ms', [`${key}Accel99`, `${key}TimeTo99`]);
    // The ramp is not purely a ground measurement: on the flicker described in
    // section 1 the body spends part of it under airAccel (14) instead of
    // groundAccel (62), which lengthens it. Recorded so the ms figures above are
    // read with the right caveat rather than quoted as pure ground acceleration.
    // Reported, not asserted: the contact flicker is already one failing check
    // in section 1, and asserting it once per stance would triple one defect.
    report.check(`${key} acceleration ramp context (airborne fraction)`, true,
      `${(S[key].airFrac * 100).toFixed(1)}% of the 3 s ${key} trace was airborne (airAccel `
      + `${T ? T.airAccel : '?'} vs groundAccel ${T ? T.groundAccel : '?'}), so t90=${(t90 * 1000).toFixed(1)} ms `
      + `and t99=${(t99 * 1000).toFixed(1)} ms include that`);
  }

  // Deceleration. Releasing the keys is where the merge trap bites: the second
  // branch has to state forward:false explicitly or the trace is of a player
  // still accelerating. hold() with no arguments is that statement.
  await sim.setup({ position: pos, yaw: fwdYaw, ads: 0 });
  await sim.eval(() => window.__MOVE.standUp());
  const dec = await sim.drive({
    seconds: 2.4, dt: DT,
    input: `if (i < ${SETTLE}) { ${hold('forward', 'sprint')} } ${hold()}`,
  });
  const rel = dec[SETTLE - 1];
  const after = dec.slice(SETTLE);
  const vRel = rel.speed;
  const decAt = (frac) => {
    const r = after.find((x) => x.speed <= frac * vRel);
    return r ? (r.t - rel.t) * 1000 : null;
  };
  const stopped = after.find((x) => x.speed <= 0.01);
  report.check('deceleration is measured from a real release', vRel > 6,
    `speed at release ${vRel.toFixed(3)} m/s after ${(SETTLE * DT).toFixed(2)} s of sprint `
    + `(if this were ~0 the release branch had failed to name every key)`);
  measured(report, 'decel to 10% of release speed (90% stopped)', decAt(0.10), ' ms', ['decel90', 'stopTime90']);
  measured(report, 'decel to 1% of release speed (99% stopped)', decAt(0.01), ' ms', ['decel99', 'stopTime99']);
  report.check('the body comes to a full stop after release', !!stopped,
    stopped
      ? `speed <= 0.01 m/s ${((stopped.t - rel.t) * 1000).toFixed(0)} ms after release, `
        + `final ${after[after.length - 1].speed.toExponential(2)} m/s, coasted ${
          Math.hypot(after[after.length - 1].px - rel.px, after[after.length - 1].pz - rel.pz).toFixed(3)} m`
      : `still moving at ${after[after.length - 1].speed.toFixed(4)} m/s ${((after[after.length - 1].t - rel.t) * 1000).toFixed(0)} ms after release`);

  /* ==== 4. jump height, airtime, apex consistency ========================== */

  // Standing jumps, deliberately: a moving jump inherits the ground-contact
  // flicker measured in section 1, and airtime derived from an onGround trace
  // that flickers is airtime of the terrain sampler rather than of the jump.
  const jumpRun = async (dt) => {
    await sim.setup({ position: pos, yaw: fwdYaw, ads: 0 });
    await sim.eval(() => window.__MOVE.standUp());
    const rows = await sim.drive({
      seconds: 1.6, dt,
      // requestJump timestamps against g.elapsed, which is what player.update
      // is handed as `now`; input.js passes performance.now()/1000 instead, so
      // the shipping buffer window is not the one measured here.
      input: `if (i === 12) g.player.requestJump(g.elapsed); ${hold()}`,
    });
    const y0 = rows[10].py;
    const air = rows.filter((r) => !r.onGround);
    const apex = Math.max(...rows.map((r) => r.py)) - y0;
    const airtime = air.length ? air[air.length - 1].t - air[0].t + dt : 0;
    return { apex, airtime, rows, launch: rows.find((r) => !r.onGround)?.vy ?? 0 };
  };
  const J = await jumpRun(DT);
  measured(report, 'jump height', J.apex, ' m', ['jumpHeight', 'jumpApex']);
  measured(report, 'airtime', J.airtime * 1000, ' ms', ['airtime', 'jumpAirtime']);
  report.check('jump leaves the ground and returns to it', J.apex > 0.1 && J.airtime > 0.1,
    `apex ${J.apex.toFixed(4)} m, airtime ${(J.airtime * 1000).toFixed(0)} ms, `
    + `first airborne vy ${J.launch.toFixed(3)} m/s`);

  // Apex consistency across repeated jumps from the same spot: a spring-loaded
  // re-jump on the landing tick must not accumulate height (bunny-hopping) or
  // lose it. At a fixed dt this is deterministic, so any spread here is a phase
  // interaction with the landing resolution rather than noise.
  await sim.setup({ position: pos, yaw: fwdYaw, ads: 0 });
  await sim.eval(() => window.__MOVE.standUp());
  const hops = await sim.drive({
    seconds: 6, dt: DT,
    input: `if (i > 10 && g.player.onGround) g.player.requestJump(g.elapsed); ${hold()}`,
  });
  const apexes = [];
  let cur = null;
  for (const r of hops) {
    if (!r.onGround) { if (!cur) cur = { y0: r.py, top: r.py }; cur.top = Math.max(cur.top, r.py); }
    else if (cur) { apexes.push(cur.top - cur.y0); cur = null; }
  }
  report.check('jump apex is consistent across repeated jumps', apexes.length >= 4 && spreadPct(apexes) < 2,
    apexes.length >= 4
      ? `${apexes.length} jumps, apex ${Math.min(...apexes).toFixed(4)}..${Math.max(...apexes).toFixed(4)} m `
        + `(mean ${mean(apexes).toFixed(4)}, spread ${spreadPct(apexes).toFixed(2)}%)`
      : `only ${apexes.length} jumps completed in 6 s — cannot judge consistency`);

  /* ==== 5. air control ===================================================== */

  const groundStrafe = S.strafe.steady;

  // (a) From a standing jump: everything the body has when it lands was granted
  //     in mid-air, so this is the cleanest possible measure of air authority.
  await sim.setup({ position: pos, yaw: yawFor(site.deg, 0, 1), ads: 0 });
  await sim.eval(() => window.__MOVE.standUp());
  const airA = await sim.drive({
    seconds: 1.2, dt: DT,
    input: `if (i === 12) g.player.requestJump(g.elapsed); if (g.player.onGround) { ${hold()} } ${hold('right')}`,
  });
  const airRowsA = airA.filter((r) => !r.onGround);
  const gainedStanding = Math.max(...airRowsA.map((r) => r.speed));

  // (b) From a running jump, releasing forward and asking for pure strafe. The
  //     interesting number is the component perpendicular to the takeoff
  //     velocity: that is how far a player can shift a jump after committing to
  //     it, which is what "air control" means to someone being shot at.
  await sim.setup({ position: pos, yaw: fwdYaw, ads: 0 });
  await sim.eval(() => window.__MOVE.standUp());
  const airB = await sim.drive({
    seconds: 1.6, dt: DT,
    input: `if (i === ${SETTLE}) g.player.requestJump(g.elapsed); `
      + `if (i < ${SETTLE}) { ${hold('forward', 'sprint')} } else { ${hold('right')} }`,
  });
  const lift = airB.findIndex((r, k) => k >= SETTLE && !r.onGround);
  const take = airB[lift];
  const airRowsB = airB.slice(lift).filter((r) => !r.onGround);
  const ux = take.vx / Math.hypot(take.vx, take.vz), uz = take.vz / Math.hypot(take.vx, take.vz);
  // Perpendicular (right-hand) axis of the takeoff heading.
  const lat = airRowsB.map((r) => Math.abs(r.vx * -uz + r.vz * ux));
  const latGain = Math.max(...lat);
  const totalChange = Math.max(...airRowsB.map((r) => r.speed)) - take.speed;

  measured(report, 'air control: lateral velocity gained after leaving the ground', latGain, ' m/s',
    ['airControlLateral', 'airControl']);
  report.check('air control from a standing jump, in m/s and as a fraction of ground strafe', true,
    `standing jump reached ${gainedStanding.toFixed(3)} m/s from 0 while airborne `
    + `= ${(gainedStanding / groundStrafe).toFixed(3)}x ground strafe (${groundStrafe.toFixed(3)} m/s); `
    + `running jump gained ${latGain.toFixed(3)} m/s laterally = ${(latGain / groundStrafe).toFixed(3)}x, `
    + `peak |v| changed by ${totalChange >= 0 ? '+' : ''}${totalChange.toFixed(3)} m/s over ${airRowsB.length} airborne ticks`);

  // The failing assertion. 0.5 is a project-side discrimination threshold, not
  // a Call of Duty figure: it separates "a jump can be nudged" from "a jump can
  // be redirected as freely as a step". player.js's own header claims "real
  // inertia in the air"; a standing jump that reaches full ground strafe speed
  // by itself has none. Replace 0.5 with a sourced value when targets.mjs
  // carries one.
  const airFrac = gainedStanding / groundStrafe;
  report.check('air control is not total (< 0.5x ground strafe from a standing jump)',
    airFrac < 0.5,
    `standing jump reaches ${(airFrac * 100).toFixed(1)}% of ground strafe speed with no ground contact `
    + `(${gainedStanding.toFixed(3)} of ${groundStrafe.toFixed(3)} m/s); threshold 50% is a discrimination `
    + 'bound chosen here, not a sourced target');

  /* ==== 6. frame-rate independence ========================================= */

  // The shipping loop integrates at clock.getDelta(), so whatever these traces
  // disagree about is a difference between two players' games. The right answer
  // for every quantity in this block is zero spread; a sub-stepped integrator
  // would deliver that. The tolerances below are the tightest that the
  // instrument itself can honour (see the apex note) so a red line here is the
  // game, not the measurement.
  const DTS = [1 / 30, 1 / 60, 1 / 144, 1 / 240];
  const sweep = [];
  for (const dt of DTS) {
    const j = await jumpRun(dt);

    await sim.setup({ position: pos, yaw: fwdYaw, ads: 0 });
    await sim.eval(() => window.__MOVE.standUp());
    // 2.0 s is a whole number of ticks at every dt tested, so the comparison is
    // not of different sampling instants.
    const runRows = await sim.drive({ seconds: 2.0, dt, input: hold('forward', 'sprint') });
    const dist = Math.hypot(runRows[runRows.length - 1].px - runRows[0].px,
      runRows[runRows.length - 1].pz - runRows[0].pz);

    // Distance covered during a sprinting jump — the gap a player can clear.
    await sim.setup({ position: pos, yaw: fwdYaw, ads: 0 });
    await sim.eval(() => window.__MOVE.standUp());
    const nSettle = Math.round(1.2 / dt);
    const gapRows = await sim.drive({
      seconds: 2.2, dt,
      input: `if (i === ${nSettle}) g.player.requestJump(g.elapsed); ${hold('forward', 'sprint')}`,
    });
    const off = gapRows.findIndex((r, k) => k >= nSettle && !r.onGround);
    const back = gapRows.findIndex((r, k) => k > off + 0.2 / dt && r.onGround);
    const gap = off >= 0 && back > off
      ? Math.hypot(gapRows[back].px - gapRows[off].px, gapRows[back].pz - gapRows[off].pz) : NaN;

    sweep.push({ dt, apex: j.apex, airtime: j.airtime, dist, gap, top: steadyOf(runRows, dt, 0.4) });
  }
  const col = (k) => sweep.map((s) => s[k]);
  const fmt = (k, n = 4) => sweep.map((s) => `${(1 / s.dt).toFixed(0)}Hz ${s[k].toFixed(n)}`).join(', ');

  // Apex: sampling a smooth maximum on a dt grid costs at most g*(dt/2)^2/2 =
  // 3 mm at 1/30 (0.4%), so a 0.5% band is honest and anything above it is
  // physics. Measured spread is an order of magnitude larger than that.
  report.check('frame-rate independence: jump apex', spreadPct(col('apex')) < 0.5,
    `${fmt('apex')} m — spread ${spreadPct(col('apex')).toFixed(2)}% `
    + '(gravity is applied to the jump impulse before the first integration, so apex loses v*dt/2)');
  report.check('frame-rate independence: distance covered in 2.00 s of sprint', spreadPct(col('dist')) < 0.5,
    `${fmt('dist')} m — spread ${spreadPct(col('dist')).toFixed(2)}%: the top speed is dt-exact, so this is the `
    + 'acceleration ramp plus the dt-dependent ground-contact flicker');
  report.check('frame-rate independence: distance covered by a sprinting jump',
    Number.isFinite(spreadPct(col('gap'))) && spreadPct(col('gap')) < 1.0,
    `${fmt('gap')} m — spread ${spreadPct(col('gap')).toFixed(2)}% — a gap a 240 Hz player clears may not be clearable at 30 Hz`);
  report.check('frame-rate independence: steady top speed', spreadPct(col('top')) < 0.2,
    `${fmt('top')} m/s — spread ${spreadPct(col('top')).toFixed(3)}%; the friction/accel fixed point is dt-exact, `
    + 'which is why only the transients above disagree');
  // Airtime is quantised by dt itself (one tick is 6.7% of airtime at 1/30), so
  // it is reported rather than asserted tightly — a tight assertion here would
  // be measuring the sample grid.
  report.check('airtime across dt (reported, dt-quantised by construction)', true,
    `${fmt('airtime')} s — spread ${spreadPct(col('airtime')).toFixed(2)}%, of which up to `
    + `${(100 / 30 / mean(col('airtime'))).toFixed(1)}% is one tick of quantisation at 30 Hz`);

  /* ==== 7. collision ======================================================= */

  // (a) Pass-through, against real level geometry rather than a synthetic box:
  //     drive into a wall for 3 s and check where the body ends up.
  const wall = await sim.eval(() => {
    const g = window.__GAME, L = g.level;
    // Approached along -x from +x, so the target must be tall enough to rule
    // out step-up, wide enough in z to be hit square, and have 4 m of free
    // ground in front of it.
    const THREE = window.__THREE;
    const box = new THREE.Box3();
    const free = (x, z) => {
      const y = L.groundHeight(x, z);
      box.min.set(x - 0.4, y, z - 0.4); box.max.set(x + 0.4, y + 1.9, z + 0.4);
      for (const c of L.colliders) if (box.intersectsBox(c)) return false;
      return true;
    };
    for (const c of L.colliders) {
      const cz = (c.min.z + c.max.z) / 2;
      const gh = L.groundHeight(c.max.x + 0.6, cz);
      if (c.max.y - gh < 1.2) continue;              // steppable or low rubble
      if (c.max.z - c.min.z < 1.2) continue;         // too narrow to hit square
      if (c.min.y > gh + 0.5) continue;              // floats above the body
      let ok = true;
      for (let d = 0.5; d <= 4.5 && ok; d += 0.5) ok = free(c.max.x + d, cz);
      if (!ok) continue;
      return { x: c.max.x, z: cz, top: c.max.y, ground: L.groundHeight(c.max.x + 4, cz),
        start: [c.max.x + 4, null, cz] };
    }
    return null;
  });
  if (!wall) {
    report.check('a wall could be found to drive into', false,
      `no collider in the ${baseColliders} in this level is tall, wide and approachable enough to test pass-through`);
  } else {
    await sim.setup({ position: wall.start, yaw: Math.PI / 2, ads: 0 });  // forward = -x
    await sim.eval(() => window.__MOVE.standUp());
    const rows = await sim.drive({ seconds: 3, dt: DT, input: hold('forward', 'sprint') });
    const last = rows[rows.length - 1];
    const travelled = wall.start[0] - last.px;
    const clearance = (last.px - 0.32) - wall.x;   // >= 0 means the body is outside
    const worst = await sim.eval(() => window.__MOVE.pen());
    report.check('the body cannot pass through a collider',
      clearance > -0.002 && worst.depth < 0.002 && travelled > 1.5,
      `drove ${travelled.toFixed(3)} m into a ${(wall.top - wall.ground).toFixed(2)} m wall at x=${wall.x.toFixed(2)}; `
      + `stopped with the near face of the body ${(clearance * 1000).toFixed(1)} mm outside it, `
      + `penetration ${worst.depth.toFixed(5)} m, final speed ${last.speed.toFixed(3)} m/s`);
  }

  // (b) Step-up and (c) the same instrument against a ledge it must NOT climb.
  //     Synthetic boxes, because the level's real obstacles do not come in
  //     known heights and a step-up test whose obstacle height is unknown
  //     cannot tell "climbed a 0.3 m kerb" from "walked round a 2 m hut".
  //     Both are removed in the caller's finally.
  const obstacle = async (height, depth = 1.0) => {
    const D = 3.0;
    const corners = [[D, -3], [D + depth, 3]].map(([along, across]) => [
      site.x + DX * along - DZ * across, site.z + DZ * along + DX * across]);
    const xs = [corners[0][0], corners[1][0]].sort((a, b) => a - b);
    const zs = [corners[0][1], corners[1][1]].sort((a, b) => a - b);
    const ground = site.y0;
    const n = await sim.eval((a) => window.__MOVE.addBox(a.min, a.max), {
      min: [xs[0], ground - 1.0, zs[0]], max: [xs[1], ground + height, zs[1]],
    });
    return { n, top: ground + height, xs, zs, faceDist: D };
  };

  {
    const kerb = await obstacle(0.30);
    await sim.setup({ position: pos, yaw: fwdYaw, ads: 0 });
    await sim.eval(() => window.__MOVE.standUp());
    const rows = await sim.drive({ seconds: 2.5, dt: DT, input: hold('forward') });
    const last = rows[rows.length - 1];
    const along = (last.px - site.x) * DX + (last.pz - site.z) * DZ;
    const rise = Math.max(...rows.map((r) => r.py)) - rows[0].py;
    report.check(`step-up clears a ${(0.30).toFixed(2)} m kerb (declared stepHeight ${T ? T.stepHeight : '?'})`,
      along > kerb.faceDist + 1.0 + 0.32 && rise > 0.2,
      `walked ${along.toFixed(3)} m along the corridor past a kerb whose far face is at `
      + `${(kerb.faceDist + 1.0).toFixed(2)} m, rising ${rise.toFixed(3)} m (kerb top +0.300 m); `
      + `ended at y ${(last.py - rows[0].py).toFixed(3)} m relative to start`);
    await sim.eval((n) => window.__MOVE.trim(n - 1), kerb.n);
  }

  // (c) A long randomised walk that must never end a frame inside geometry.
  //     The walk is driven by its own LCG rather than Math.random so it cannot
  //     shift the seeded draws the AI and spread suites depend on, and it is
  //     leashed to a 30 m circle so it stays inside the built compound instead
  //     of wandering onto the unpopulated edge of the height field where there
  //     is nothing to collide with.
  // Started from the game's own spawn rather than the measurement corridor: the
  // corridor was chosen for being empty, which is the opposite of what a
  // penetration walk wants.
  const walkStart = await sim.setup({ yaw: fwdYaw, ads: 0 });
  await sim.eval(() => window.__MOVE.standUp());
  void walkStart;
  const WALK_S = 60, WALK_DT = 1 / 120;
  const walk = await sim.drive({
    seconds: WALK_S, dt: WALK_DT,
    input: `
      if (!sim.__rw || i === 0) sim.__rw = { s: 20260728, next: 0, keys: null };
      const st = sim.__rw;
      const rnd = () => { st.s = (st.s * 1103515245 + 12345) & 0x7fffffff; return st.s / 0x7fffffff; };
      const p = g.player;
      if (i >= st.next) {
        st.next = i + 12 + Math.floor(rnd() * 60);
        const r = rnd();
        st.keys = { forward: r < 0.72, back: r >= 0.72 && r < 0.82,
          left: rnd() < 0.3, right: rnd() < 0.3,
          sprint: rnd() < 0.5, crouch: rnd() < 0.18, ads: rnd() < 0.15, fire: false };
        if (rnd() < 0.22) p.requestJump(g.elapsed);
      }
      // Leash: steer back toward the compound when the walk drifts out of it,
      // otherwise turn by a bounded random amount.
      const d = Math.hypot(p.position.x, p.position.z);
      if (d > 30) p.yaw = Math.atan2(p.position.x, p.position.z);
      else p.yaw += (rnd() - 0.5) * 2.4 * ${WALK_DT};
      return st.keys;`,
    sample: 'const q = window.__MOVE.pen(); return { pen: q.depth, contact: q.contact, which: q.which };',
  });
  const bad = walk.filter((r) => r.pen > 0.001);
  const contacts = walk.filter((r) => r.contact).length;
  const pathLen = walk.reduce((a, r, k) => k ? a + Math.hypot(r.px - walk[k - 1].px, r.pz - walk[k - 1].pz) : 0, 0);
  const worstPen = Math.max(...walk.map((r) => r.pen));
  report.check('the body never ends a frame inside level geometry',
    bad.length === 0,
    `${walk.length} frames over ${WALK_S} s at ${(1 / WALK_DT).toFixed(0)} Hz, ${pathLen.toFixed(1)} m walked, `
    + `${contacts} frames within 0.30 m of a collider; ${bad.length} frames penetrating, `
    + `worst ${worstPen.toFixed(4)} m`
    + (bad.length ? ` (first at t+${(bad[0].t - walk[0].t).toFixed(2)} s, collider #${bad[0].which} at `
      + `x=${bad[0].px.toFixed(2)} z=${bad[0].pz.toFixed(2)})` : ''));
  // A clean walk is only evidence if the walk actually met geometry.
  report.check('the randomised walk actually met geometry', contacts > 200 && pathLen > 40,
    `${contacts} of ${walk.length} frames in contact range, ${pathLen.toFixed(1)} m covered from the game's own `
    + `spawn (a walk that grinds along walls covers less ground, which is why the bar is 40 m and not 200) `
    + '— a zero-penetration result from a walk that touched nothing would prove nothing');

  /* ==== 8. slide (absent) ================================================== */

  // Behavioural definition, so an implementation is judged on what it does:
  // crouch while sprinting should produce a speed above walk speed that lasts a
  // bounded time and then decays. The three thresholds below are presence
  // tests, not Call of Duty values — 1.05x walk to distinguish a boost from
  // noise, 0.4 s as the shortest window a player could use, 2.5 s as the bound
  // beyond which it would be a permanent speed buff rather than a slide.
  await sim.setup({ position: pos, yaw: fwdYaw, ads: 0 });
  await sim.eval(() => window.__MOVE.standUp());
  const slide = await sim.drive({
    seconds: 3.5, dt: DT,
    input: `if (i < ${SETTLE}) { ${hold('forward', 'sprint')} } ${hold('forward', 'sprint', 'crouch')}`,
  });
  const atCrouch = slide[SETTLE - 1];
  const post = slide.slice(SETTLE);
  const walkSpeed = S.walk.steady;
  const postPeak = Math.max(...post.map((r) => r.speed));
  const aboveIdx = post.map((r, k) => (r.speed > walkSpeed ? k : -1)).filter((k) => k >= 0);
  const aboveFor = aboveIdx.length ? (aboveIdx[aboveIdx.length - 1] + 1) * DT : 0;
  const decayed = post.find((r) => r.speed <= walkSpeed * 1.001);
  const dist1s = (() => {
    const r = post[Math.min(post.length - 1, Math.round(1.0 / DT))];
    return Math.hypot(r.px - atCrouch.px, r.pz - atCrouch.pz);
  })();
  const slideOk = postPeak > walkSpeed * 1.05 && aboveFor >= 0.4 && aboveFor <= 2.5 && !!decayed;
  report.check('slide exists: crouch while sprinting yields a bounded burst above walk speed', slideOk,
    `crouched at ${atCrouch.speed.toFixed(3)} m/s (sprint) — peak after crouch ${postPeak.toFixed(3)} m/s `
    + `(${(postPeak / walkSpeed).toFixed(2)}x walk, need > 1.05x), stayed above walk speed for `
    + `${(aboveFor * 1000).toFixed(0)} ms (need 400..2500 ms), covered ${dist1s.toFixed(2)} m in the first second `
    + `(a plain crouch covers ${(S.crouch.steady * 1.0).toFixed(2)} m) — no slide mechanic present, crouch simply `
    + 'drops the cap to crouch speed and friction removes the rest');

  /* ==== 9. mantle (absent) ================================================= */

  // A chest-high ledge: above stepHeight so the step-up path cannot take it,
  // below standHeight so it is the canonical thing a soldier climbs. Detected
  // behaviourally — did the body end up on top of it, having pressed into it
  // without a jump — so a mantle implemented by any mechanism will satisfy it.
  {
    const LEDGE = 1.15;
    const ledge = await obstacle(LEDGE, 1.4);
    await sim.setup({ position: pos, yaw: fwdYaw, ads: 0 });
    await sim.eval(() => window.__MOVE.standUp());
    const rows = await sim.drive({ seconds: 3.0, dt: DT, input: hold('forward', 'sprint') });
    const last = rows[rows.length - 1];
    const along = (last.px - site.x) * DX + (last.pz - site.z) * DZ;
    const rise = last.py - rows[0].py;
    const onTop = last.py >= ledge.top - 0.10 && along > ledge.faceDist + 0.2;
    report.check(`mantle exists: a ${LEDGE.toFixed(2)} m ledge can be climbed without a jump`, onTop,
      `pressed into a ledge whose top is +${LEDGE.toFixed(2)} m (declared stepHeight `
      + `${T ? T.stepHeight : '?'} m) for 3.0 s: rose ${rise.toFixed(3)} m, advanced ${along.toFixed(3)} m along the `
      + `corridor against a face at ${ledge.faceDist.toFixed(2)} m, final speed ${last.speed.toFixed(3)} m/s `
      + '— no mantle mechanic present');

    // Supporting measurement: not even a jump gets over it, so the absence is
    // not "the player should have jumped".
    await sim.setup({ position: pos, yaw: fwdYaw, ads: 0 });
    await sim.eval(() => window.__MOVE.standUp());
    const jrows = await sim.drive({
      seconds: 3.0, dt: DT,
      input: `if (i > 10 && g.player.onGround) g.player.requestJump(g.elapsed); ${hold('forward', 'sprint')}`,
    });
    const jlast = jrows[jrows.length - 1];
    const jalong = (jlast.px - site.x) * DX + (jlast.pz - site.z) * DZ;
    report.check('jumping at the same ledge is measured too (supporting)', true,
      `jumping into it repeatedly for 3.0 s reached y +${(Math.max(...jrows.map((r) => r.py)) - jrows[0].py).toFixed(3)} m `
      + `(ledge top +${LEDGE.toFixed(2)} m, jump apex ${J.apex.toFixed(3)} m) and advanced ${jalong.toFixed(3)} m `
      + `against a face at ${ledge.faceDist.toFixed(2)} m`);
    await sim.eval((n) => window.__MOVE.trim(n - 1), ledge.n);
  }
}
