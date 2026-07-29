// Movement, air control, slide, mantle and collision measurement suite.
//
// Everything here is measured through the running simulation at a fixed dt, and
// every reference value is reached through report.against(domain, key) so that
// the tolerance and the unit come out of tools/targets.mjs rather than out of
// this file. There is no import from ../src/ anywhere below: the previous
// generation of this suite read TUNING to build six "does it respect its own
// cap" expectations, and raising walkSpeed by 32% left the failure set
// byte-identical because both sides of the comparison moved together.
//
// Two consequences of that rule change how the checks are written, not just
// where the numbers come from:
//
//   The cap-overshoot claim is now structural. "Sprint must not exceed
//   sprintSpeed" is unwritable without reading sprintSpeed, so the claim is
//   instead "the peak of a run may not exceed its own steady state by more than
//   epsilon, and a direction change taken at that steady state may not raise it"
//   — which is the actual bug (the acceleration clamp projects velocity onto the
//   wish axis, so a turn adds a full step at right angles to what is already
//   there) and which no constant can silence. The absolute speed is asserted
//   separately against the sourced target — and against the right RUN, which
//   took a while to get right: the sourced tac-sprint figures are forward
//   speeds, so the sourced anchor belongs on the camera-swing turn (forward held
//   throughout) and not on the forward+strafe run, whose 45 deg heading carries
//   the elliptical strafe penalty and is 0.883x by construction. See section 2.
//
//   Flat ground is built, not searched for. The previous version asserted
//   contact stability "on flat ground" while running on a 3.63% gradient behind
//   a gate of 5%, with a comment claiming 0.04 m of rise over 26 m against a
//   measured 0.467 m. Rather than loosen the claim, section 0 pushes a synthetic
//   axis-aligned platform above the height field and runs on its top face, whose
//   gradient is zero by construction; the check then proves the body's y is
//   constant to the micrometre while it runs. A claim about flat ground now
//   rests on a surface that is flat for a reason, not on the flattest corridor a
//   search happened to find.
//
// Sections, in order:
//   0  the platform, and proof that the collision instrument can see a fault
//   1  stance speeds and their ratios, against sourced targets
//   2  the overshoot invariant: peak vs steady, straight and through a turn
//   3  acceleration and deceleration timings (no sourced reference: measured)
//   4  jump apex, apex time, airtime, gravity, repeat consistency
//   5  air control, against the qualitative movement.air_control spec
//   6  frame-rate independence (RED on purpose — the fix is in main.js)
//   7  collision: pass-through, step-up, and a long randomised walk
//   8  slide
//   9  mantle

export const NAME = 'movement';

/* ------------------------------------------------------------- plumbing -- */

const KEYS = ['forward', 'back', 'left', 'right', 'sprint', 'crouch', 'ads', 'fire'];

/**
 * Builds an input patch that names EVERY key.
 *
 * drive() Object.assigns the returned patch onto g.input, so a patch that omits
 * a key leaves whatever was there. `return {}` after `return {forward:true}`
 * does not release forward — it holds it. That produced one silent measurement
 * of "deceleration" in which the player never stopped accelerating, so every
 * input body in this file goes through here and states all eight.
 */
const hold = (...on) => `return {${KEYS.map((k) => `${k}:${on.includes(k)}`).join(',')}};`;

/**
 * yaw that makes a given key combination travel along world heading `deg`.
 *
 * The controller builds its wish vector from forward = (-sin y, -cos y) and
 * right = (cos y, -sin y), so a combination (f forward, r right) travels at
 * heading yaw + PI + atan2(-r, f). Inverting that is what lets the strafe and
 * backpedal runs use the same platform, in the same direction, as the forward
 * runs — measuring strafe top speed by strafing off the side of the platform
 * measures the fall.
 */
const yawFor = (deg, f, r) => deg * Math.PI / 180 - Math.PI - Math.atan2(-r, f);

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
 * Episodes during which `pred` holds, as {start, end, dur} in trace time.
 *
 * Used for slide detection, which is why the slide is not detected by method
 * name: an episode is a stretch of trace whose *observable state* satisfies a
 * predicate, so any implementation that produces the behaviour is measured and
 * any implementation that only produces the name is not.
 */
const episodes = (rows, pred, dt) => {
  const out = [];
  let cur = null;
  for (const r of rows) {
    if (pred(r)) { if (!cur) cur = { start: r.t, end: r.t }; cur.end = r.t; }
    else if (cur) { out.push({ ...cur, dur: cur.end - cur.start + dt }); cur = null; }
  }
  if (cur) out.push({ ...cur, dur: cur.end - cur.start + dt });
  return out;
};

/* ------------------------------------------------------------- the suite -- */

export default async function run(sim, report) {
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
      addBox(min, max) {
        g.level.colliders.push(new THREE.Box3(
          new THREE.Vector3(min[0], min[1], min[2]), new THREE.Vector3(max[0], max[1], max[2])));
        return g.level.colliders.length;
      },
      /** Restores the collider list. This sim may be shared with other suites. */
      trim(n) { g.level.colliders.length = n; },
      /**
       * Clears the state setup() does not know about.
       *
       * setup() resets `crouching` but not the damped `height`, so a run that
       * follows the crouch measurement would start 0.67 m short and collide with
       * a different body than the one under test. Any in-progress slide or
       * mantle is cleared for the same reason — a trace that begins halfway
       * through a movement lockout is a trace of the previous test.
       */
      reset() {
        const p = g.player;
        p.crouching = false; p.height = p.targetHeight = 1.82;
        p.ads = p.adsTarget = 0;
        p._mantle = null; p._sliding = false;
        p._slideEnd = -99; p._prevCrouch = false;
      },
    };
    return g.level.colliders.length;
  });

  try {
    await sections(sim, report, baseColliders);
  } finally {
    // Synthetic geometry must not outlive this suite: the runner hands a fresh
    // sim to each suite by default, but --share reuses one, and a leftover 36 m
    // platform would silently corrupt someone else's numbers.
    const left = await sim.eval((n) => {
      window.__MOVE.trim(n); window.__MOVE.reset();
      return window.__GAME.level.colliders.length;
    }, baseColliders);
    if (left !== baseColliders) {
      report.check('synthetic colliders removed', left === baseColliders,
        `collider list left at ${left}, expected ${baseColliders}`);
    }
  }
}

async function sections(sim, report, baseColliders) {
  const DT = 1 / 240;
  const eps = 1e-3;

  /* ==== 0. a provably flat platform, and a self-proof of the detector ====== */

  // The support surface is the top face of an axis-aligned box, so its gradient
  // is exactly zero — there is nothing to measure and nothing to gate. What has
  // to be established instead is that the body is standing on it and not on the
  // height field underneath, which is what the +2 m lift and the "no collider
  // anywhere in the slab" search below are for.
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
    window.__MOVE.addBox([best.cx - hx, best.tmin - 4, best.cz - hz], [best.cx + hx, top, best.cz + hz]);
    return { ...best, top, hx, hz, n: g.level.colliders.length };
  }, { hx: 18, hz: 7 });

  if (!site) {
    throw new Error('movement: no 36x14 m patch of this level is free of colliders — the flat platform '
      + 'every speed measurement below stands on cannot be built');
  }

  // Heading +x along the long axis of the platform.
  const DEG = 90, DX = 1, DZ = 0;
  const fwdYaw = yawFor(DEG, 1, 0);
  const startX = site.cx - site.hx + 2;
  const pos = [startX, site.top + 0.01, site.cz];
  const along = (r) => (r.px - startX) * DX + (r.pz - site.cz) * DZ;

  /** Puts the body at rest on the platform, settled, facing `yaw`. */
  const stand = async (yaw = fwdYaw) => {
    await sim.setup({ position: pos, yaw, ads: 0 });
    await sim.eval(() => window.__MOVE.reset());
    // 0.25 s of nothing: spawning 10 mm clear means the first few ticks are a
    // fall, and a fall inside a measurement window is airAccel where the reader
    // expects groundAccel.
    await sim.drive({ seconds: 0.25, dt: DT, input: hold() });
  };

  await stand();
  const flat = await sim.drive({ seconds: 3, dt: DT, input: hold('forward', 'sprint') });
  const flatY = flat.map((r) => r.py);
  const yVar = Math.max(...flatY) - Math.min(...flatY);
  const airborne = flat.filter((r) => !r.onGround).length;
  report.check('the test surface is flat and the body stays in contact with it',
    yVar < 1e-4 && airborne === 0,
    `36.0 x 14.0 m platform at x=${site.cx} z=${site.cz}, top face y=${site.top.toFixed(4)} m, `
    + `${(site.top - site.tmax).toFixed(2)} m above the highest ground under it (the height field spans `
    + `${site.tmin.toFixed(3)}..${site.tmax.toFixed(3)} m there and no collider intersects the slab); `
    + `over a 3 s sprint the body's y moved ${(yVar * 1e6).toFixed(1)} um and ${airborne} of ${flat.length} `
    + 'ticks were airborne — the gradient of a box top face is 0 by construction, so this is a contact '
    + 'measurement rather than a terrain one');

  // The instrument that judges the randomised walk must be able to return
  // "inside". Teleporting the body into the middle of a real collider and
  // confirming a positive depth is what separates a clean walk from a dead probe
  // reporting silence.
  const probe = await sim.eval(() => {
    const g = window.__GAME;
    const p = g.player;
    const keep = p.position.clone();
    const c = g.level.colliders.find((b) => (b.max.y - b.min.y) > 1.6 && (b.max.x - b.min.x) > 0.8
      && (b.max.x - b.min.x) < 8);
    if (!c) return { ok: false, why: 'no collider 0.8-8 m wide and over 1.6 m tall in this level (0 found)' };
    p.position.set((c.min.x + c.max.x) / 2, c.min.y + 0.1, (c.min.z + c.max.z) / 2);
    const insideDepth = window.__MOVE.pen().depth;
    p.position.copy(keep);
    const outsideDepth = window.__MOVE.pen().depth;
    return { ok: true, insideDepth, outsideDepth };
  });
  report.check('penetration detector reports depth for a body inside geometry',
    probe.ok === true && probe.insideDepth > 0.1 && probe.outsideDepth === 0,
    probe.ok
      ? `the centre of a collider read ${probe.insideDepth.toFixed(3)} m deep, the platform top read `
        + `${probe.outsideDepth.toFixed(3)} m`
      : probe.why);

  /* ==== 1. stance speeds and their ratios ================================== */

  // Each stance is driven along the same platform by rotating the player rather
  // than the platform, so strafe and backpedal are measured over the same
  // surface as walk. 3 s is over ten times the observed rise time, so the tail
  // of each trace is genuinely steady.
  const STANCES = [
    { key: 'walk', keys: ['forward'], f: 1, r: 0 },
    { key: 'sprint', keys: ['forward', 'sprint'], f: 1, r: 0 },
    { key: 'crouch', keys: ['forward', 'crouch'], f: 1, r: 0 },
    { key: 'ads', keys: ['forward', 'ads'], f: 1, r: 0 },
    { key: 'strafe', keys: ['right'], f: 0, r: 1 },
    { key: 'backpedal', keys: ['back'], f: -1, r: 0 },
  ];

  const S = {};
  for (const st of STANCES) {
    await stand(yawFor(DEG, st.f, st.r));
    const rows = await sim.drive({ seconds: 3, dt: DT, input: hold(...st.keys) });
    const peak = Math.max(...rows.map((r) => r.speed));
    S[st.key] = {
      peak,
      steady: steadyOf(rows, DT),
      peakT: rows.find((r) => r.speed === peak).t - rows[0].t,
      airFrac: rows.filter((r) => !r.onGround).length / rows.length,
      rows,
    };
  }

  report.against('walk top speed', S.walk.steady, 'movement', 'base_walk_speed_legacy_iw');
  // The AR-class sprint figure rather than the disputed general one: this game
  // ships a single M4-pattern rifle, and targets.mjs says in as many words that
  // the BP50 line is the better key to test an AR against.
  report.against('sprint top speed', S.sprint.steady, 'movement', 'tactical_sprint_speed_ar_bp50_mw3');
  report.against('crouch top speed', S.crouch.steady, 'movement', 'crouch_speed_mw3');
  report.against('ADS top speed', S.ads.steady, 'movement', 'ads_movement_speed_mw3');

  // The +/-12% band on movement.crouch_speed_mw3 is a TITLE band, not a precision
  // band, and the blind telemetry comparison walked straight through it: 2.35 m/s
  // reads as -2.1%, passes the assertion above, and is still slower than every
  // crouch speed the source has ever published. The key's own note is why the
  // lower half of that band is not sourced slack — it records the published
  // change as "Decreased crouch movement speed from 2.6m/s to 2.4m/s (-8%)",
  // reproduced twice inside the same patch notes, and calls it "THE MOST SOLID
  // VALUE IN THIS BATCH". The ambiguity the band absorbs is which title/season is
  // being modelled, and every title in the note's history is at or ABOVE the
  // key's value (2.6 before Season 4). So the sourced range is one-sided
  // downwards, and this asserts that side of it.
  //
  // The bound is read out of targets.mjs through report.targets rather than
  // written here, so it cannot drift from the research and cannot be satisfied
  // by editing this file. It is emphatically NOT read from src/ — that is the
  // tautology the linter exists to stop.
  const crouchKey = report.targets.TARGETS.movement.crouch_speed_mw3;
  report.check('crouch speed is not below the slowest figure its key publishes',
    S.crouch.steady >= crouchKey.value * (1 - 1e-9),
    `crouch steady state ${S.crouch.steady.toFixed(4)} m/s against movement.crouch_speed_mw3 = `
    + `${crouchKey.value} ${crouchKey.unit} (${((S.crouch.steady / crouchKey.value - 1) * 100).toFixed(2)}%). `
    + `The key's +/-${(crouchKey.tol.pct * 100).toFixed(0)}% band covers title ambiguity, which can only put `
    + 'crouch higher (2.6 m/s pre-Season-4), so nothing sourced permits a value below '
    + `${crouchKey.value} ${crouchKey.unit} — quoted from ${crouchKey.title}`);

  // The ratios are what the model is actually built out of: nobody perceives
  // 2.35 m/s, they perceive "crouch is half speed". They are also the only form
  // in which the strafe and backpedal penalties are published.
  report.against('strafe speed as a fraction of forward walk',
    S.strafe.steady / S.walk.steady, 'movement', 'strafe_speed_scale');
  report.against('backpedal speed as a fraction of forward walk',
    S.backpedal.steady / S.walk.steady, 'movement', 'backpedal_speed_scale');
  report.against('sprint speed as a multiple of forward walk',
    S.sprint.steady / S.walk.steady, 'movement', 'sprint_speed_scale');

  // Ordering, which no reference value expresses and which is the part a player
  // notices first. Backpedal measured 4.986 m/s against a 4.547 m/s walk in the
  // baseline: the wish vector was scaled by backpedalScale and then normalize()d,
  // which throws the scale away exactly.
  report.check('walking backwards is slower than walking forwards',
    S.backpedal.steady < S.walk.steady,
    `backpedal ${S.backpedal.steady.toFixed(4)} m/s vs walk ${S.walk.steady.toFixed(4)} m/s `
    + `= ${(S.backpedal.steady / S.walk.steady).toFixed(4)}x`);
  report.check('strafing is slower than walking forwards',
    S.strafe.steady < S.walk.steady,
    `strafe ${S.strafe.steady.toFixed(4)} m/s vs walk ${S.walk.steady.toFixed(4)} m/s `
    + `= ${(S.strafe.steady / S.walk.steady).toFixed(4)}x`);
  report.check('sprint is faster than walk, and crouch and ADS are slower',
    S.sprint.steady > S.walk.steady && S.crouch.steady < S.walk.steady && S.ads.steady < S.walk.steady,
    `sprint ${S.sprint.steady.toFixed(3)} > walk ${S.walk.steady.toFixed(3)} > `
    + `ads ${S.ads.steady.toFixed(3)} > crouch ${S.crouch.steady.toFixed(3)} m/s`);

  /* ==== 2. the overshoot invariant ========================================= */

  // Written structurally on purpose. "Sprint must not exceed sprintSpeed" cannot
  // be written without reading sprintSpeed, and the critic's perturbation showed
  // what that costs: raising the constant silences the check without touching the
  // bug. The invariant below holds for any cap value — a run that accelerates to
  // a steady state must not pass through a higher speed on the way, and a
  // direction change taken at that steady state must not raise it either.
  for (const key of ['walk', 'sprint', 'crouch', 'strafe', 'backpedal']) {
    const m = S[key];
    report.check(`${key} does not overshoot its own steady state`,
      m.peak <= m.steady * (1 + eps),
      `peak ${m.peak.toFixed(4)} m/s at t+${m.peakT.toFixed(3)} s vs steady state `
      + `${m.steady.toFixed(4)} m/s = ${((m.peak / m.steady - 1) * 100).toFixed(3)}% over `
      + `(tolerance ${(eps * 100).toFixed(1)}%)`);
  }

  const SETTLE = Math.round(1.2 / DT);
  await stand();
  const turn = await sim.drive({
    seconds: 2.0, dt: DT,
    input: `if (i < ${SETTLE}) { ${hold('forward', 'sprint')} } ${hold('forward', 'right', 'sprint')}`,
  });
  const turnPeak = Math.max(...turn.slice(SETTLE).map((r) => r.speed));
  await stand();
  const swing = await sim.drive({
    seconds: 2.0, dt: DT,
    // A 110 deg/s mouse turn, which is an ordinary corner-taking rate.
    input: `if (i >= ${SETTLE}) g.player.yaw += 1.92 * ${DT}; ${hold('forward', 'sprint')}`,
  });
  const swingPeak = Math.max(...swing.slice(SETTLE).map((r) => r.speed));

  report.check('adding strafe at full sprint does not raise the top speed',
    turnPeak <= S.sprint.steady * (1 + eps),
    `sprinting straight settles at ${S.sprint.steady.toFixed(4)} m/s; adding a strafe key after `
    + `${(SETTLE * DT).toFixed(2)} s peaks at ${turnPeak.toFixed(4)} m/s `
    + `(${((turnPeak / S.sprint.steady - 1) * 100).toFixed(3)}% over) — the failure this guards is the `
    + 'acceleration clamp projecting velocity onto the wish axis, which lets a new wish direction add a full '
    + 'step at right angles to what is already there; a negative number here is the diagonal heading penalty, '
    + 'which the ellipse check below accounts for separately');
  report.check('turning the camera at full sprint does not raise the top speed',
    swingPeak <= S.sprint.steady * (1 + eps),
    `a 110 deg/s turn while sprinting peaks at ${swingPeak.toFixed(4)} m/s vs ${S.sprint.steady.toFixed(4)} `
    + `m/s straight (${((swingPeak / S.sprint.steady - 1) * 100).toFixed(3)}% over)`);

  // The absolute number against the sourced target, so that "no overshoot"
  // cannot be satisfied by a game that sprints at 20 m/s.
  //
  // ATTRIBUTION FIX. This used to be fed `turnPeak` — the forward+strafe run —
  // and read 6.02956 m/s against the 6.8 m/s tac-sprint target, 11.3% low. The
  // shortfall is not the turn and it is not the acceleration clamp: 6.02956 is
  // the DIAGONAL heading cap, tac sprint times the elliptical heading penalty,
  // and the strafe run is not a turn at all — the yaw never moves, the body
  // settles onto a new straight line 45 deg off the old one and stays there. So
  // the run was measuring the cost of a heading, while the target
  // (movement.tactical_sprint_speed_ar_bp50_mw3, "the BP50's tactical sprint
  // speed was decreased from 7m/s to 6.8m/s") is a FORWARD speed, published for
  // a player running where he is looking. The two are different quantities and
  // the diagonal one is 0.883x the other by construction.
  //
  // What a player means by "sprinting through a turn" is the camera swing: yaw
  // sweeping while forward stays held, so the wish direction is forward
  // throughout and the cap is the forward cap. That is the run measured here,
  // over a window that starts 0.2 s after the yaw begins to move — long enough
  // for the lag angle between velocity and wish to reach its fixed point, short
  // enough that the curving path is still on the platform (checked below, not
  // assumed). Ruled out: measuring the last 0.5 s of the swing trace, which is
  // 88 deg of accumulated turn later and can leave the 36 x 14 m platform, so a
  // fall would be inside the window.
  const TW0 = SETTLE + Math.round(0.2 / DT);
  const TW1 = SETTLE + Math.round(0.5 / DT);
  const swingWin = swing.slice(TW0, TW1);
  const swingSpeeds = swingWin.map((r) => r.speed);
  const swingSteady = mean(swingSpeeds);
  const swingMin = Math.min(...swingSpeeds);
  const swingSwept = Math.abs(swing[TW1 - 1].yaw - swing[SETTLE - 1].yaw) * 180 / Math.PI;
  const swingGrounded = swingWin.every((r) => r.onGround);

  report.check('the sustained-turn window is a real turn, taken on the ground',
    swingGrounded && swingSwept > 40 && swingWin.length > 50,
    `${swingWin.length} ticks from 0.2 s to 0.5 s after the yaw starts moving; ${swingSwept.toFixed(1)} deg `
    + `of yaw swept by the end of it, ${swingWin.filter((r) => r.onGround).length}/${swingWin.length} ticks `
    + 'in ground contact — a window that left the platform would be measuring a fall');
  report.check('sprint speed does not sag through a sustained turn',
    swingMin >= swingSteady * (1 - eps),
    `through the turn the speed stays within [${swingMin.toFixed(4)}, ${Math.max(...swingSpeeds).toFixed(4)}] `
    + `m/s of a ${swingSteady.toFixed(4)} m/s mean (worst dip `
    + `${((swingMin / swingSteady - 1) * 100).toFixed(3)}%, tolerance ${(eps * 100).toFixed(1)}%) — the point `
    + 'of asserting the mean below is only worth anything if the mean is not hiding a trough');
  report.against('sprint speed through a direction change', swingSteady,
    'movement', 'tactical_sprint_speed_ar_bp50_mw3');

  // The diagonal number still gets reported, and it still gets a claim made
  // about it — just not that claim. No sourced value exists for a diagonal
  // sprint on either research pass, so the assertion available is a consistency
  // one, and it is a strong one: the elliptical limit says a 45 deg wish should
  // be capped at sqrt(2) / hypot(1, 1/k) of the forward cap, where k is the
  // pure-lateral penalty. Every term on both sides here is measured through the
  // simulation — k comes from the strafe and walk runs in section 1, the
  // forward cap from the sprint run, the diagonal from the strafe-key run — so
  // nothing is read out of TUNING and a change to strafeScale moves both sides
  // together only if the ellipse is genuinely what the controller implements.
  // If the diagonal were instead capped per-axis, or the penalty dropped while
  // sprinting, this disagrees.
  const k = S.strafe.steady / S.walk.steady;
  const ellipse = Math.SQRT2 / Math.hypot(1, 1 / k);
  const diagRatio = turnPeak / S.sprint.steady;
  report.measure('sprint speed on a diagonal heading (forward + strafe held)', turnPeak, 'm/s',
    'no sourced reference: the CoD tac-sprint figures are forward speeds, and no diagonal-heading sprint '
    + 'speed was found for any title — the ellipse check below is what constrains this number');
  report.check('a diagonal sprint is capped by the elliptical heading limit the measured strafe penalty implies',
    Math.abs(diagRatio / ellipse - 1) < 5e-3,
    `forward+strafe sprint ${turnPeak.toFixed(5)} m/s is ${diagRatio.toFixed(5)}x the `
    + `${S.sprint.steady.toFixed(4)} m/s forward sprint; the measured pure-lateral penalty is `
    + `${k.toFixed(4)} (strafe ${S.strafe.steady.toFixed(4)} / walk ${S.walk.steady.toFixed(4)}), for which an `
    + `ellipse predicts ${ellipse.toFixed(5)}x — off by ${((diagRatio / ellipse - 1) * 100).toFixed(3)}% `
    + '(tolerance 0.5%). This is why the diagonal is 11% below the forward tac-sprint target and why that is '
    + 'a heading penalty rather than a defect in the turn');

  /* ==== 3. acceleration and deceleration =================================== */

  // No sourced reference exists for either, on either research pass, so these are
  // measured and not asserted. reached() in front of each is the guard the old
  // suite lacked: firstAt() returns null when the threshold is never crossed, and
  // Number(null) is 0, which is how "decelerated in 0.0000 ms" printed twice as a
  // PASS on a build whose friction had been broken.
  for (const key of ['walk', 'sprint']) {
    const rows = S[key].rows;
    const target = S[key].steady;
    const t90 = firstAt(rows, (r) => r.speed >= 0.90 * target);
    const t99 = firstAt(rows, (r) => r.speed >= 0.99 * target);
    if (report.reached(`${key} reaches 90% of its steady state`, t90,
      t90 === null ? `never reached 90% of ${target.toFixed(3)} m/s in 3 s`
        : `at t+${(t90 * 1000).toFixed(1)} ms`)) {
      report.measure(`${key} acceleration to 90% of top speed`, t90 * 1000, 'ms', 'no sourced reference');
    }
    if (report.reached(`${key} reaches 99% of its steady state`, t99,
      t99 === null ? `never reached 99% of ${target.toFixed(3)} m/s in 3 s`
        : `at t+${(t99 * 1000).toFixed(1)} ms`)) {
      report.measure(`${key} acceleration to 99% of top speed`, t99 * 1000, 'ms', 'no sourced reference');
    }
  }

  await stand();
  const dec = await sim.drive({
    seconds: 2.4, dt: DT,
    input: `if (i < ${SETTLE}) { ${hold('forward', 'sprint')} } ${hold()}`,
  });
  const rel = dec[SETTLE - 1];
  const after = dec.slice(SETTLE);
  const decAt = (frac) => {
    const r = after.find((x) => x.speed <= frac * rel.speed);
    return r ? (r.t - rel.t) * 1000 : null;
  };
  report.check('deceleration is measured from a real release', rel.speed > S.walk.steady,
    `speed at release ${rel.speed.toFixed(3)} m/s after ${(SETTLE * DT).toFixed(2)} s of sprint, above the `
    + `${S.walk.steady.toFixed(3)} m/s walk steady state (a release branch that failed to name every key `
    + 'would read at or below it)');
  for (const [frac, label] of [[0.10, '90% stopped'], [0.01, '99% stopped']]) {
    const ms = decAt(frac);
    if (report.reached(`release decays to ${(frac * 100).toFixed(0)}% of release speed`, ms,
      ms === null ? `never fell to ${(frac * rel.speed).toFixed(4)} m/s within 1.2 s of release`
        : `at ${ms.toFixed(1)} ms after release`)) {
      report.measure(`deceleration to ${(frac * 100).toFixed(0)}% of release speed (${label})`, ms, 'ms',
        'no sourced reference');
    }
  }
  const stopped = after.find((x) => x.speed <= 0.01);
  report.check('the body comes to a full stop after release', !!stopped,
    stopped
      ? `speed <= 0.01 m/s ${((stopped.t - rel.t) * 1000).toFixed(0)} ms after release, coasting `
        + `${Math.hypot(stopped.px - rel.px, stopped.pz - rel.pz).toFixed(3)} m`
      : `still moving at ${after[after.length - 1].speed.toFixed(4)} m/s `
        + `${((after[after.length - 1].t - rel.t) * 1000).toFixed(0)} ms after release`);

  /* ==== 3b. the shape of the standing-start ramp =========================== */

  // Every trace above is driven at 1/240, but the simulation does NOT tick at
  // 1/240: Game.step banks the time it is handed and integrates in fixed 1/60
  // slices, so four drive calls of 1/240 produce one tick and three duplicate
  // samples of it. That is harmless for a steady state or a threshold crossing
  // and fatal for anything phrased per tick — the differences of a 1/240 trace
  // are 0, 0, 0, delta. So the ramp is driven at one call per simulation tick,
  // which is the only grid on which "the increment this tick" is a quantity.
  //
  // The claim is structural and it is the whole claim available: nothing sourced
  // publishes a CoD ground acceleration (targets.mjs still lists
  // movement_acceleration as uncovered), so the magnitude of the ramp cannot be
  // asserted. Its SHAPE can. A ramp built from a friction term that falls with
  // speed and an acceleration term that does not produces strictly shrinking
  // increments; two equal increments mean the friction term went constant, which
  // is a tick of dead input the player feels at the start of every sprint.
  const TICK60 = 1 / 60;
  const IDLE = 6;
  await stand();
  const rampRows = await sim.drive({
    ticks: IDLE + 40, dt: TICK60,
    input: `if (i < ${IDLE}) { ${hold()} } ${hold('forward', 'sprint')}`,
  });
  const rampFrom = rampRows[IDLE - 1];
  const rampSpeeds = rampRows.slice(IDLE - 1).map((r) => r.speed);
  // The ramp ends at the first sample that has arrived at the steady state: past
  // that the increments are legitimately 0 and "strictly decreasing" would be a
  // claim about the plateau rather than about the ramp.
  const arriveIdx = rampSpeeds.findIndex((v, k) => k > 0 && v >= S.sprint.steady - 1e-9);
  report.check('the standing-start ramp starts from rest and arrives at the sprint steady state',
    rampFrom.speed < 1e-9 && arriveIdx > 3,
    `${IDLE} ticks of no input left the body at ${rampFrom.speed.toExponential(2)} m/s; holding `
    + `forward+sprint reached the ${S.sprint.steady.toFixed(4)} m/s steady state `
    + `${arriveIdx > 0 ? `${arriveIdx} ticks later` : 'never within 40 ticks'}`);
  if (arriveIdx > 3) {
    const inc = [];
    for (let k = 1; k <= arriveIdx; k++) inc.push(rampSpeeds[k] - rampSpeeds[k - 1]);
    // Strict, with no epsilon: consecutive increments of a real ramp differ by
    // percent, and the defect this catches is two increments that are equal to
    // the last bit.
    const flat = inc.findIndex((d, k) => k > 0 && d >= inc[k - 1]);
    report.check('the standing-start ramp has no flat spot: per-tick increments strictly decrease',
      flat === -1,
      `increments over the ${inc.length} ticks from rest to the steady state: `
      + `${inc.map((d) => d.toFixed(4)).join(', ')} m/s`
      + (flat === -1
        ? ` — strictly decreasing, ratios ${inc.slice(1).map((d, k) => (d / inc[k]).toFixed(3)).join(', ')}`
        : ` — increment ${flat + 1} (${inc[flat].toFixed(4)}) is not smaller than increment ${flat} `
          + `(${inc[flat - 1].toFixed(4)}), i.e. ${(TICK60 * 1000).toFixed(1)} ms in which holding the key `
          + 'bought nothing extra. A friction term that goes CONSTANT below a speed floor is what makes two '
          + 'increments equal — the acceleration term is constant too, so their difference stops moving'));
  }

  /* ==== 4. jump and gravity ================================================ */

  const jumpRun = async (dt) => {
    await sim.setup({ position: pos, yaw: fwdYaw, ads: 0 });
    await sim.eval(() => window.__MOVE.reset());
    await sim.drive({ seconds: 0.25, dt, input: hold() });
    const rows = await sim.drive({
      seconds: 1.6, dt,
      // requestJump timestamps against g.elapsed, which is what player.update is
      // handed as `now`; input.js passes performance.now()/1000 instead, so the
      // shipping buffer window is not the one measured here.
      input: `if (i === 4) g.player.requestJump(g.elapsed); ${hold()}`,
    });
    const y0 = rows[0].py;
    const air = rows.filter((r) => !r.onGround);
    const top = Math.max(...rows.map((r) => r.py));
    const apexRow = rows.find((r) => r.py === top);
    return {
      apex: top - y0,
      apexTime: air.length ? apexRow.t - air[0].t + dt : null,
      airtime: air.length ? air[air.length - 1].t - air[0].t + dt : null,
      launch: air.length ? air[0].vy : null,
      rows,
    };
  };
  const J = await jumpRun(DT);
  report.check('the jump leaves the ground and returns to it',
    J.airtime !== null && J.apex > 0.1,
    `apex ${J.apex.toFixed(4)} m above the platform, airtime ${((J.airtime ?? 0) * 1000).toFixed(0)} ms, `
    + `first airborne vy ${(J.launch ?? 0).toFixed(3)} m/s`);
  report.against('jump apex height', J.apex, 'physics', 'jump_height');
  if (report.reached('jump apex time is observable', J.apexTime)) {
    report.against('time from leaving the ground to apex', J.apexTime, 'physics', 'jump_apex_time');
  }
  if (report.reached('jump airtime is observable', J.airtime)) {
    report.against('jump airtime, ground to ground', J.airtime, 'physics', 'jump_airtime');
  }

  // Gravity from free fall rather than from the jump: dv/dt is exact under
  // semi-implicit Euler, so this is the one constant here that can be read off a
  // trace without an integration-error term.
  await sim.setup({ position: [startX, site.top + 12, site.cz], yaw: fwdYaw, ads: 0 });
  await sim.eval(() => window.__MOVE.reset());
  const fall = await sim.drive({ seconds: 0.6, dt: DT, input: hold() });
  const fa = fall[20], fb = fall[fall.length - 5];
  report.against('gravity, from free fall', (fa.vy - fb.vy) / (fb.t - fa.t), 'physics', 'gravity');

  await stand();
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
  report.check('repeated jumps do not accumulate or lose height',
    apexes.length >= 4 && spreadPct(apexes) < 2,
    apexes.length >= 4
      ? `${apexes.length} jumps, apex ${Math.min(...apexes).toFixed(4)}..${Math.max(...apexes).toFixed(4)} m `
        + `(mean ${mean(apexes).toFixed(4)}, spread ${spreadPct(apexes).toFixed(2)}%)`
      : `only ${apexes.length} jumps completed in 6 s — cannot judge consistency`);

  /* ==== 5. air control ===================================================== */

  // movement.air_control is qualitative (tol: null), so against() refuses it and
  // the two halves of its spec are asserted here with the note quoted:
  //
  //   "While airborne a CoD player can yaw the camera freely but CANNOT gain
  //    speed by strafing into the turn — no strafe-jump or bunnyhop speed gain —
  //    and lateral velocity authority mid-air is a small fraction of ground
  //    authority: target well under 10% of ground acceleration per tick."
  //
  // So: (a) lateral acceleration under 10% of the ground figure, and (b) no |v|
  // gain from an airborne strafe-plus-turn sequence. The 10% is quoted from the
  // target, not chosen here.
  const AIR_NOTE = 'movement.air_control: "a CoD player can yaw the camera freely but CANNOT gain speed by '
    + 'strafing into the turn ... lateral velocity authority mid-air is a small fraction of ground authority: '
    + 'target well under 10% of ground acceleration per tick"';

  const latAccel = async (kind) => {
    // Right-hand axis of the standing yaw, so "lateral" means the same thing on
    // the ground and in the air.
    const rx = Math.cos(fwdYaw), rz = -Math.sin(fwdYaw);
    const K = 60;                                   // 0.25 s in before the key
    const n = 8;                                    // 33 ms: short enough to be the initial slope
    await stand(fwdYaw);
    const rows = await sim.drive({
      seconds: 0.7, dt: DT,
      input: kind === 'air'
        ? `if (i === 0) g.player.requestJump(g.elapsed); if (i < ${K}) { ${hold()} } ${hold('right')}`
        : `if (i < ${K}) { ${hold()} } ${hold('right')}`,
    });
    const lat = rows.map((r) => r.vx * rx + r.vz * rz);
    const win = rows.slice(K, K + n + 1);
    const ok = kind === 'air' ? win.every((r) => !r.onGround) : win.every((r) => r.onGround);
    return { accel: (lat[K + n] - lat[K]) / (n * DT), ok, n };
  };
  const gLat = await latAccel('ground');
  const aLat = await latAccel('air');
  report.check('the lateral-acceleration windows are on the ground and in the air respectively',
    gLat.ok === true && aLat.ok === true,
    `${gLat.n} ticks (${(gLat.n * DT * 1000).toFixed(0)} ms) after the strafe key: the ground window is `
    + `${gLat.ok ? 'entirely' : 'NOT'} in contact and the air window is ${aLat.ok ? 'entirely' : 'NOT'} airborne`);
  report.measure('ground lateral acceleration from standstill', gLat.accel, 'm/s^2', 'no sourced reference');
  report.measure('mid-air lateral acceleration', aLat.accel, 'm/s^2', 'no sourced reference');
  report.check('mid-air lateral authority is under 10% of ground authority',
    Math.abs(aLat.accel) < 0.10 * Math.abs(gLat.accel),
    `air ${aLat.accel.toFixed(3)} m/s^2 vs ground ${gLat.accel.toFixed(3)} m/s^2 = `
    + `${(Math.abs(aLat.accel / gLat.accel) * 100).toFixed(1)}% (bound 10%, quoted from ${AIR_NOTE})`);

  // (b) The strafe-jump input the spec names, driven for a whole airtime. |v| may
  //     fall (drag, redirection) but it may not rise above what the takeoff had.
  await stand();
  const sj = await sim.drive({
    seconds: 1.4, dt: DT,
    input: `if (i === ${SETTLE}) g.player.requestJump(g.elapsed); `
      + `if (i < ${SETTLE}) { ${hold('forward', 'sprint')} } `
      + `g.player.yaw += 2.6 * ${DT}; ${hold('forward', 'right')}`,
  });
  const lift = sj.findIndex((r, k) => k >= SETTLE && !r.onGround);
  const airRows = lift >= 0 ? sj.slice(lift).filter((r) => !r.onGround) : [];
  if (report.reached('the strafe-jump trace actually left the ground', airRows.length ? lift : null,
    airRows.length ? `airborne from tick ${lift} for ${airRows.length} ticks` : 'never left the ground (0 ticks)')) {
    const take = sj[lift].speed;
    const best = Math.max(...airRows.map((r) => r.speed));
    report.check('strafing into a mid-air turn cannot gain speed', best <= take * (1 + eps),
      `took off at ${take.toFixed(4)} m/s; holding forward+right through a 149 deg/s turn for `
      + `${airRows.length} airborne ticks peaked at ${best.toFixed(4)} m/s `
      + `(${((best / take - 1) * 100).toFixed(3)}%, tolerance ${(eps * 100).toFixed(1)}%) — ${AIR_NOTE}`);
    report.measure('speed change over an airborne strafe-turn', best - take, 'm/s',
      'positive would be a strafe-jump gain');
  }

  /* ==== 5b. airborne momentum and the landing ============================== */

  // Two structural claims, both on one trace, both driven at one call per
  // simulation tick for the reason given in section 3b.
  //
  // (a) Horizontal momentum is CONSERVED in the air. This is not a tolerance and
  //     not a magnitude: movement.air_control records an explicit negative result
  //     — no CoD sv_airaccelerate / g_airAccelerate figure exists in anything
  //     either research pass could reach, and Counter-Strike's must not be
  //     borrowed — so there is no sourced drag coefficient to assert and the only
  //     honest expectation is zero. The spec's positive half (a small steering
  //     nudge, "well under 10% of ground authority") is asserted in section 5 and
  //     is not what this measures: forward is held with the yaw fixed, so the
  //     wish axis IS the velocity axis and the steering term is identically zero
  //     by construction. Anything that moves the speed here is drag.
  //
  // (b) Speed through the landing is monotone non-decreasing and never dips below
  //     the airborne minimum. The takeoff speed and the ground steady state are
  //     the same speed (sprint, held throughout, onto the same flat platform), so
  //     the tick that regains contact has nothing legitimate to subtract: a
  //     trough there is the controller charging ground friction on a tick it did
  //     not also accelerate on. This is the one shape in the whole velocity trace
  //     that a player feels as a hitch rather than as a number.
  const LAND_SETTLE = 72;                 // 1.2 s of sprint at the fixed 1/60 tick
  await stand();
  const jr = await sim.drive({
    ticks: LAND_SETTLE + 60, dt: TICK60,
    input: `if (i === ${LAND_SETTLE}) g.player.requestJump(g.elapsed); ${hold('forward', 'sprint')}`,
  });
  const liftIdx = jr.findIndex((r, k) => k >= LAND_SETTLE && !r.onGround);
  const landIdx = liftIdx < 0 ? -1 : jr.findIndex((r, k) => k > liftIdx && r.onGround);
  const airRun = liftIdx < 0 ? [] : jr.slice(liftIdx, landIdx < 0 ? jr.length : landIdx);
  if (report.reached('the sprinting jump left the ground and came back to it',
    airRun.length >= 20 && landIdx > 0 ? airRun.length : null,
    airRun.length >= 20 && landIdx > 0
      ? `airborne for ${airRun.length} ticks (${(airRun.length * TICK60 * 1000).toFixed(0)} ms) from tick `
        + `${liftIdx}, back in contact at tick ${landIdx}`
      : `only ${airRun.length} airborne ticks and ${landIdx > 0 ? 'a' : 'no'} landing — nothing to measure`)) {
    const airSpeeds = airRun.map((r) => r.speed);
    const airMax = Math.max(...airSpeeds);
    const airMin = Math.min(...airSpeeds);
    // 1e-6 relative is float dust, not a tolerance: with no drag term the
    // airborne branch multiplies the horizontal velocity by exactly 1.
    report.check('horizontal momentum is conserved through the whole airborne phase',
      (airMax - airMin) <= airMax * 1e-6,
      `${airRun.length} air ticks span [${airMin.toFixed(4)}, ${airMax.toFixed(4)}] m/s — a `
      + `${((airMin / airMax - 1) * 100).toFixed(2)}% change, i.e. `
      + `${((airMax - airMin) / (airRun.length * TICK60)).toFixed(3)} m/s^2 of drag over the arc. Expected 0: `
      + 'movement.air_control records that no CoD air-acceleration figure exists to borrow, so no drag '
      + 'magnitude is sourced and any is invented; the sanctioned steering nudge is zero here because the '
      + 'wish axis is the velocity axis (forward held, yaw fixed)');

    const win = jr.slice(landIdx - 1, landIdx + 6);
    const dips = win.filter((r) => r.speed < airMin - 1e-9).length;
    let mono = -1;
    for (let k = 1; k < win.length; k++) if (win[k].speed < win[k - 1].speed - 1e-9) { mono = k; break; }
    report.check('speed through the landing is monotone non-decreasing',
      mono === -1,
      `last air tick then ${win.length - 1} ticks from contact: `
      + `${win.map((r) => r.speed.toFixed(4)).join(', ')} m/s`
      + (mono === -1 ? ' — no tick loses speed'
        : ` — tick ${mono} of the window drops ${(win[mono - 1].speed - win[mono].speed).toFixed(4)} m/s `
          + `(${((win[mono - 1].speed - win[mono].speed) / TICK60).toFixed(1)} m/s^2) and has to be won back, `
          + 'which is a hitch on every landing rather than a number on a chart'));
    report.check('no tick of the landing reads below the airborne minimum',
      dips === 0,
      `airborne minimum ${airMin.toFixed(4)} m/s; the contact tick reads `
      + `${jr[landIdx].speed.toFixed(4)} m/s and ${dips} of ${win.length} ticks in the landing window are `
      + 'below the airborne minimum — the tick that regains contact cannot be slower than the air phase it '
      + 'ends, because ground contact only ever adds authority');
  }

  /* ==== 6. frame-rate independence (expected RED) ========================== */

  // These are RED and they are meant to be. The physics integrates at whatever dt
  // Game.step is handed, and the fix — a fixed-tick accumulator in
  // Game.step/Game.loop — lives in src/main.js, which this agent does not own.
  // Nothing in player.js can close the gap: the controller is handed a dt and has
  // no way to know it is the wrong one. Once the accumulator lands these go green
  // without a line changing here, which is the point of leaving them in.
  const DTS = [1 / 30, 1 / 60, 1 / 144, 1 / 240];
  const sweep = [];
  for (const dt of DTS) {
    const j = await jumpRun(dt);
    await sim.setup({ position: pos, yaw: fwdYaw, ads: 0 });
    await sim.eval(() => window.__MOVE.reset());
    await sim.drive({ seconds: 0.25, dt, input: hold() });
    // 2.0 s is a whole number of ticks at every dt tested, so the comparison is
    // not of different sampling instants.
    const runRows = await sim.drive({ seconds: 2.0, dt, input: hold('forward', 'sprint') });
    const dist = Math.hypot(runRows[runRows.length - 1].px - runRows[0].px,
      runRows[runRows.length - 1].pz - runRows[0].pz);
    sweep.push({ dt, apex: j.apex, dist, top: steadyOf(runRows, dt, 0.4) });
  }
  const col = (k) => sweep.map((s) => s[k]);
  const shown = (k, n = 4) => sweep.map((s) => `${(1 / s.dt).toFixed(0)}Hz ${s[k].toFixed(n)}`).join(', ');
  const CORE = 'the fix is a fixed-tick accumulator in Game.step/Game.loop in src/main.js, owned by the core '
    + 'agent — player.js is handed a dt and cannot tell that it is the wrong one';

  // Sampling a smooth maximum on a dt grid costs at most g*(dt/2)^2/2 = 2.8 mm at
  // 1/30, which is 0.3% of a 1 m apex, so a 0.5% band is honest and anything
  // above it is the integrator rather than the instrument.
  report.check('frame-rate independence: jump apex', spreadPct(col('apex')) < 0.5,
    `${shown('apex')} m — spread ${spreadPct(col('apex')).toFixed(2)}%, of which at most 0.3% is dt-grid `
    + `sampling of the maximum; ${CORE}`);
  report.check('frame-rate independence: distance covered in 2.00 s of sprint',
    spreadPct(col('dist')) < 0.5,
    `${shown('dist')} m — spread ${spreadPct(col('dist')).toFixed(2)}%: the steady speed is dt-exact, so this `
    + `is entirely the acceleration ramp; ${CORE}`);
  report.check('frame-rate independence: steady top speed', spreadPct(col('top')) < 0.2,
    `${shown('top')} m/s — spread ${spreadPct(col('top')).toFixed(3)}%; the friction/acceleration fixed point `
    + 'is dt-exact, which is why only the transients above disagree');

  /* ==== 7. collision ======================================================= */

  // (a) Pass-through, against real level geometry. The wall has to be over 2 m
  //     tall so that neither step-up nor mantle is entitled to take it — a
  //     pass-through test on a 1.3 m parapet measures the mantle instead.
  const wall = await sim.eval(() => {
    const g = window.__GAME, L = g.level, THREE = window.__THREE;
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
      if (c.max.y - gh < 2.0) continue;              // could be mantled or stepped
      if (c.max.z - c.min.z < 1.2) continue;         // too narrow to hit square
      if (c.min.y > gh + 0.5) continue;              // floats above the body
      let ok = true;
      for (let d = 0.5; d <= 4.5 && ok; d += 0.5) ok = free(c.max.x + d, cz);
      if (!ok) continue;
      return { x: c.max.x, z: cz, top: c.max.y, ground: gh, start: [c.max.x + 4, null, cz] };
    }
    return null;
  });
  if (!wall) {
    report.check('a wall over 2 m tall could be found to drive into', wall !== null,
      `none of the ${baseColliders} colliders in this level is tall, wide and approachable enough`);
  } else {
    await sim.setup({ position: wall.start, yaw: Math.PI / 2, ads: 0 });   // forward = -x
    await sim.eval(() => window.__MOVE.reset());
    const rows = await sim.drive({ seconds: 3, dt: DT, input: hold('forward', 'sprint') });
    const last = rows[rows.length - 1];
    const travelled = wall.start[0] - last.px;
    const clearance = (last.px - 0.32) - wall.x;    // >= 0 means the body is outside
    const worst = await sim.eval(() => window.__MOVE.pen());
    report.check('the body cannot pass through or climb a wall over 2 m tall',
      clearance > -0.002 && worst.depth < 0.002 && travelled > 1.5 && last.py < wall.top - 0.5,
      `drove ${travelled.toFixed(3)} m into a ${(wall.top - wall.ground).toFixed(2)} m wall at `
      + `x=${wall.x.toFixed(2)}; stopped with the near face of the body ${(clearance * 1000).toFixed(1)} mm `
      + `outside it, penetration ${worst.depth.toFixed(5)} m, ended ${(wall.top - last.py).toFixed(2)} m below `
      + `its top, final speed ${last.speed.toFixed(3)} m/s`);
  }

  // Synthetic obstacles on the platform, because the level's real obstacles do
  // not come in known heights and a step-up test whose obstacle height is unknown
  // cannot tell "climbed a 0.3 m kerb" from "walked round a hut".
  const obstacle = async (height, depth = 1.0, at = 6.0) => {
    const x0 = startX + at, x1 = x0 + depth;
    const n = await sim.eval((a) => window.__MOVE.addBox(a.min, a.max), {
      min: [x0, site.top - 1.0, site.cz - 3], max: [x1, site.top + height, site.cz + 3],
    });
    return { n, height, top: site.top + height, face: at, far: at + depth };
  };

  {
    const kerb = await obstacle(0.30);
    await stand();
    const rows = await sim.drive({ seconds: 2.5, dt: DT, input: hold('forward') });
    const last = rows[rows.length - 1];
    // The maximum, not the final value: past the far face the body steps back
    // DOWN onto the platform, so the end-of-trace height is 0 whether it climbed
    // the kerb or teleported through it.
    const rise = Math.max(...rows.map((r) => r.py)) - rows[0].py;
    report.check('step-up carries the body over a 0.30 m kerb',
      along(last) > kerb.far + 0.32 && rise > 0.25,
      `walked ${along(last).toFixed(3)} m along the platform past a 0.30 m kerb whose far face is at `
      + `${kerb.far.toFixed(2)} m, rising ${rise.toFixed(3)} m at the highest (the kerb top is +0.300 m)`);
    await sim.eval((n) => window.__MOVE.trim(n - 1), kerb.n);
  }

  // A long randomised walk that must never end a frame inside geometry. Driven by
  // its own LCG rather than Math.random so it cannot shift the seeded draws the
  // AI and spread suites depend on, and leashed to a 30 m circle so it stays
  // inside the built compound instead of wandering onto the empty edge of the
  // height field where there is nothing to collide with. Started from the game's
  // own spawn: the platform was built for being empty, which is the opposite of
  // what a penetration walk wants.
  await sim.setup({ yaw: fwdYaw, ads: 0 });
  await sim.eval(() => window.__MOVE.reset());
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
      const d = Math.hypot(p.position.x, p.position.z);
      if (d > 30) p.yaw = Math.atan2(p.position.x, p.position.z);
      else p.yaw += (rnd() - 0.5) * 2.4 * ${WALK_DT};
      return st.keys;`,
    sample: 'const q = window.__MOVE.pen(); return { pen: q.depth, contact: q.contact, which: q.which };',
  });
  const bad = walk.filter((r) => r.pen > 0.001);
  const contacts = walk.filter((r) => r.contact).length;
  const pathLen = walk.reduce((a, r, k) => (k ? a + Math.hypot(r.px - walk[k - 1].px, r.pz - walk[k - 1].pz) : 0), 0);
  const worstPen = Math.max(...walk.map((r) => r.pen));
  report.check('the body never ends a frame inside level geometry', bad.length === 0,
    `${walk.length} frames over ${WALK_S} s at ${(1 / WALK_DT).toFixed(0)} Hz, ${pathLen.toFixed(1)} m walked, `
    + `${contacts} frames within 0.30 m of a collider; ${bad.length} frames penetrating, worst `
    + `${worstPen.toFixed(4)} m`
    + (bad.length ? ` (first at t+${(bad[0].t - walk[0].t).toFixed(2)} s, collider #${bad[0].which} at `
      + `x=${bad[0].px.toFixed(2)} z=${bad[0].pz.toFixed(2)})` : ''));
  report.check('the randomised walk actually met geometry', contacts > 200 && pathLen > 40,
    `${contacts} of ${walk.length} frames in contact range over ${pathLen.toFixed(1)} m from the game's own `
    + 'spawn — a zero-penetration result from a walk that touched nothing would prove nothing');

  /* ==== 8. slide =========================================================== */

  // Detected behaviourally: a slide is a stretch of trace during which the body
  // is crouched and moving faster than a crouch can move. No method name is
  // consulted, so any implementation that produces the behaviour is measured.
  const crouchFloor = S.crouch.steady * 1.02;
  await stand();
  const slide = await sim.drive({
    seconds: 3.5, dt: DT,
    input: `if (i < ${SETTLE}) { ${hold('forward', 'sprint')} } ${hold('forward', 'sprint', 'crouch')}`,
  });
  const entry = slide[SETTLE - 1];
  const post = slide.slice(SETTLE);
  const bursts = episodes(post, (r) => r.crouching && r.speed > crouchFloor, DT);
  const peak = Math.max(...post.map((r) => r.speed));

  report.check('crouching at full sprint produces a burst above the speed it started from',
    bursts.length > 0 && peak > entry.speed,
    `entered the crouch at ${entry.speed.toFixed(4)} m/s (sprint steady state `
    + `${S.sprint.steady.toFixed(4)} m/s); peak afterwards ${peak.toFixed(4)} m/s = `
    + `${((peak / entry.speed - 1) * 100).toFixed(2)}% above entry, over ${bursts.length} crouched `
    + `episode(s) faster than ${crouchFloor.toFixed(3)} m/s (the crouch steady state x1.02)`);

  const slideDur = bursts.length ? Math.max(...bursts.map((b) => b.dur)) : null;
  if (report.reached('a slide episode was observed', slideDur,
    slideDur === null
      ? 'no crouched episode above crouch speed occurred in 2.3 s of held crouch at sprint speed (0 found)'
      : `${bursts.length} episode(s), longest ${(slideDur * 1000).toFixed(0)} ms`)) {
    report.against('slide duration, crouch press to back at crouch speed', slideDur,
      'physics', 'slide_max_duration');
    // targets.mjs keeps the ambiguity deliberately: the BO6 notes do not say
    // WHICH speed 1.55 multiplies. This implementation states its choice — base
    // WALK speed — so the measurement is the ratio to the measured walk steady
    // state. Read as a multiple of sprint it would be 10.6 m/s, half again as
    // fast as tactical sprint, which nothing in the sourced material supports.
    report.against('slide peak speed as a multiple of walk speed', peak / S.walk.steady,
      'physics', 'slide_max_speed_scale');
    report.check('the slide decays back to crouch speed rather than persisting',
      post[post.length - 1].speed <= crouchFloor,
      `2.3 s after the crouch press the body is at ${post[post.length - 1].speed.toFixed(4)} m/s against a `
      + `crouch steady state of ${S.crouch.steady.toFixed(4)} m/s`);
    report.check('holding crouch yields exactly one slide, not a repeating one',
      bursts.length === 1,
      `${bursts.length} episode(s) above ${crouchFloor.toFixed(3)} m/s during 2.3 s of continuously held `
      + 'crouch at sprint speed');
  }

  // Re-triggering. Mashing crouch must not be a faster way to move than
  // sprinting: the invariant is that no episode of a mashed run exceeds the peak
  // of a single slide, which is what a boost proportional to entry speed buys and
  // what a fixed impulse would not.
  await stand();
  const MASH = Math.round(0.30 / DT);
  const mash = await sim.drive({
    seconds: 6.0, dt: DT,
    input: `if (i < ${SETTLE}) { ${hold('forward', 'sprint')} } `
      + `if (Math.floor((i - ${SETTLE}) / ${MASH}) % 2 === 0) { ${hold('forward', 'sprint', 'crouch')} } `
      + hold('forward', 'sprint'),
  });
  const mashPost = mash.slice(SETTLE);
  // Crouched rows only, on both sides of the comparison: the uncrouched stretches
  // of a mashed run are ordinary sprinting, and including them would turn this
  // into "is sprint slower than a slide" rather than "does chaining pay".
  const crouchedPeak = (rowsIn) => {
    const c = rowsIn.filter((r) => r.crouching);
    return c.length ? Math.max(...c.map((r) => r.speed)) : 0;
  };
  const mashPeak = crouchedPeak(mashPost);
  const mashBursts = episodes(mashPost, (r) => r.crouching && r.speed > crouchFloor, DT);
  report.check('mashing crouch cannot manufacture speed', mashPeak <= crouchedPeak(post) * (1 + eps),
    `crouch toggled every ${(MASH * DT * 1000).toFixed(0)} ms for 4.8 s: ${mashBursts.length} boosted `
    + `episodes, crouched peak ${mashPeak.toFixed(4)} m/s against a single slide's `
    + `${crouchedPeak(post).toFixed(4)} m/s (${((mashPeak / crouchedPeak(post) - 1) * 100).toFixed(3)}%), `
    + 'mean speed over the run '
    + `${mean(mashPost.map((r) => r.speed)).toFixed(4)} m/s vs ${S.sprint.steady.toFixed(4)} sprinting`);
  if (slideDur !== null) {
    report.check('a mashed slide is bounded by the same duration as a held one',
      mashBursts.length > 0 && Math.max(...mashBursts.map((b) => b.dur)) <= slideDur * (1 + eps),
      mashBursts.length
        ? `longest mashed episode ${(Math.max(...mashBursts.map((b) => b.dur)) * 1000).toFixed(0)} ms vs `
          + `${(slideDur * 1000).toFixed(0)} ms held`
        : '0 boosted episodes in the mashed run, so there is nothing to bound');
  }

  // The SHAPE of the slide's exit, on its own trace at one call per simulation
  // tick (section 3b). physics.slide_max_speed_scale (1.55) and
  // physics.slide_max_duration (0.65 s) are two halves of one envelope and they
  // jointly determine the decay: a slide that starts at 1.55x walk and is allowed
  // to last 0.65 s has to have arrived at the crouch cap by the time the cap
  // fires, or the cap is not what ends it — the clip is. Nothing invented is
  // needed to see that, because the failure is a discontinuity: the per-tick
  // decrement of a decay that is one curve never grows, and a brake tacked onto
  // the end of it makes the decrement jump. The window runs from the slide's peak
  // to the first tick at or below the crouch steady state measured in section 1,
  // so any braking that happens ABOVE the crouch cap is inside it and any
  // re-acceleration afterwards is outside it.
  await stand();
  const sdRows = await sim.drive({
    ticks: LAND_SETTLE + 150, dt: TICK60,
    input: `if (i < ${LAND_SETTLE}) { ${hold('forward', 'sprint')} } ${hold('forward', 'sprint', 'crouch')}`,
  });
  const sdPost = sdRows.slice(LAND_SETTLE);
  const sdPeak = Math.max(...sdPost.map((r) => r.speed));
  const sdPeakIdx = sdPost.findIndex((r) => r.speed === sdPeak);
  const sdArrive = sdPost.findIndex((r, k) => k > sdPeakIdx && r.speed <= S.crouch.steady + 1e-9);
  if (report.reached('the slide decays all the way to the crouch cap within the trace', sdArrive > 0 ? sdArrive : null,
    sdArrive > 0
      ? `peak ${sdPeak.toFixed(4)} m/s at tick ${sdPeakIdx}, first at or below the ${S.crouch.steady.toFixed(4)} `
        + `m/s crouch steady state ${sdArrive - sdPeakIdx} ticks later`
      : `never reached the ${S.crouch.steady.toFixed(4)} m/s crouch steady state in 2.5 s of held crouch`)) {
    const drops = [];
    for (let k = sdPeakIdx + 1; k <= sdArrive; k++) drops.push(sdPost[k - 1].speed - sdPost[k].speed);
    const step = drops.findIndex((d, k) => k > 0 && d > drops[k - 1] + 1e-9);
    report.check('the slide decays continuously into the crouch cap, with no step at the duration cap',
      step === -1,
      `${drops.length} ticks from the ${sdPeak.toFixed(4)} m/s peak down to `
      + `${sdPost[sdArrive].speed.toFixed(4)} m/s; per-tick decrement `
      + `${drops[0].toFixed(4)} -> ${drops[drops.length - 1].toFixed(4)} m/s`
      + (step === -1
        ? ' — never grows, so the decay is one curve and the crouch cap is where it lands rather than where '
          + 'it is clipped'
        : ` — decrement ${step} jumps from ${drops[step - 1].toFixed(4)} to ${drops[step].toFixed(4)} m/s `
          + `(${(drops[step] / TICK60).toFixed(1)} m/s^2) at ${sdPost[step + sdPeakIdx].speed.toFixed(4)} m/s, `
          + `which is ${(sdPost[step + sdPeakIdx].speed - S.crouch.steady).toFixed(4)} m/s above the crouch cap: `
          + 'the slide is still fast when its duration runs out and the remainder is taken away in two ticks'));
    // A second, independent measurement of the same sourced key: the speed a
    // slide settles into, reached through the slide rather than by walking
    // crouched. The two must be the same number and it must be the published one.
    const sdFloor = mean(sdPost.slice(-30).map((r) => r.speed));
    report.against('the speed a slide settles into', sdFloor, 'movement', 'crouch_speed_mw3');
    report.check('the slide floor and the crouched walk are the same speed',
      Math.abs(sdFloor - S.crouch.steady) < 1e-3,
      `slide floor ${sdFloor.toFixed(4)} m/s over the last 0.5 s of held crouch vs a crouched-walk steady `
      + `state of ${S.crouch.steady.toFixed(4)} m/s (differ by `
      + `${Math.abs(sdFloor - S.crouch.steady).toFixed(5)} m/s) — one cap, reached two ways`);
  }

  /* ==== 9. mantle ========================================================== */

  // physics.mantle_duration is an explicit negative result: value null, tol null,
  // "DO NOT write an acceptance criterion against a CoD mantle duration yet". So
  // the duration is measure()d, and the two bounds it is checked against are
  // other MEASURED quantities from this same run rather than taste:
  //
  //   upper — the mantle lockout must be no longer than the slide, which is the
  //           longest movement lockout anything sourced sanctions (0.65 s).
  //   lower — the low bracket must be quicker than the ballistic rise a jump
  //           would cost (physics.jump_apex_time, 0.312 s), or vaulting a
  //           knee-high wall is strictly worse than jumping it.
  //
  // targets.mjs also states the structural claim: MULTIPLE FIXED-LENGTH
  // ANIMATIONS SELECTED BY LEDGE-HEIGHT BRACKET, not a smooth function of height.
  // That is what the three ledges below test — two in one bracket must agree, and
  // one in another must not.
  const mantleRun = async (height, depth = 1.6) => {
    const led = await obstacle(height, depth);
    await stand();
    const rows = await sim.drive({ seconds: 3.0, dt: DT, input: hold('forward') });
    await sim.eval((n) => window.__MOVE.trim(n - 1), led.n);
    const y0 = rows[0].py;
    const liftIdx = rows.findIndex((r) => r.py > y0 + 0.01);
    const doneIdx = liftIdx < 0 ? -1
      : rows.findIndex((r, k) => k > liftIdx && r.py >= led.top - 0.01 && r.onGround);
    const last = rows[rows.length - 1];
    return {
      led,
      onTop: liftIdx >= 0 && doneIdx > liftIdx && along(last) > led.face,
      // From the last tick still on the platform to the first tick standing on
      // the ledge: the lockout a player feels, start to actionable again.
      dur: liftIdx >= 0 && doneIdx > liftIdx ? rows[doneIdx].t - rows[Math.max(0, liftIdx - 1)].t : null,
      // Highest, not final: a 1.6 m deep ledge is walked off the far side inside
      // the 3 s window, so the final height is 0 whether it was climbed or not.
      rise: Math.max(...rows.map((r) => r.py)) - y0,
      along: along(last),
    };
  };

  const M = { low: await mantleRun(0.70), mid: await mantleRun(1.15), high: await mantleRun(1.45) };
  for (const [k, m] of Object.entries(M)) {
    report.check(`a ${m.led.height.toFixed(2)} m ledge is climbed without a jump (${k} bracket)`,
      m.onTop === true,
      `pressed forward into a ledge whose top is +${m.led.height.toFixed(2)} m for 3.0 s with no jump input: `
      + `rose ${m.rise.toFixed(3)} m, advanced ${m.along.toFixed(3)} m along the platform against a face at `
      + `${m.led.face.toFixed(2)} m, `
      + `${m.dur === null ? 'never reached the top' : `on top after ${(m.dur * 1000).toFixed(0)} ms`}`);
  }
  const allMantled = M.low.dur !== null && M.mid.dur !== null && M.high.dur !== null;
  if (report.reached('every ledge produced a completed mantle', allMantled ? M.mid.dur : null,
    `0.70 m ledge: ${M.low.dur === null ? 'never topped' : `${(M.low.dur * 1000).toFixed(0)} ms`}; `
    + `1.15 m: ${M.mid.dur === null ? 'never topped' : `${(M.mid.dur * 1000).toFixed(0)} ms`}; `
    + `1.45 m: ${M.high.dur === null ? 'never topped' : `${(M.high.dur * 1000).toFixed(0)} ms`}`)) {
    report.measure('mantle lockout, 0.70 m ledge (low bracket)', M.low.dur * 1000, 'ms',
      'targets.mjs records an explicit negative result for CoD mantle duration');
    report.measure('mantle lockout, 1.15 m ledge (high bracket)', M.mid.dur * 1000, 'ms',
      'targets.mjs records an explicit negative result for CoD mantle duration');
    report.measure('mantle lockout, 1.45 m ledge (high bracket)', M.high.dur * 1000, 'ms',
      'targets.mjs records an explicit negative result for CoD mantle duration');

    report.check('the mantle lockout is no longer than the slide lockout',
      slideDur !== null && Math.max(M.mid.dur, M.high.dur) <= slideDur,
      `longest mantle ${(Math.max(M.mid.dur, M.high.dur) * 1000).toFixed(0)} ms vs the measured slide `
      + `${slideDur === null ? 'none' : `${(slideDur * 1000).toFixed(0)} ms`}, which is itself asserted `
      + 'against physics.slide_max_duration — the longest movement lockout anything sourced sanctions');
    report.check('the low vault is quicker than the ballistic rise a jump would cost',
      M.low.dur < (J.apexTime ?? Infinity),
      `low vault ${(M.low.dur * 1000).toFixed(0)} ms vs a measured jump apex time of `
      + `${((J.apexTime ?? 0) * 1000).toFixed(0)} ms (physics.jump_apex_time) — a vault slower than that makes `
      + 'jumping the knee-high wall strictly better');
    report.check('mantle duration is a fixed length per height bracket, not a function of height',
      Math.abs(M.mid.dur - M.high.dur) <= 2 * DT && M.low.dur < M.mid.dur - 2 * DT,
      `the 1.15 m and 1.45 m ledges took ${(M.mid.dur * 1000).toFixed(1)} and `
      + `${(M.high.dur * 1000).toFixed(1)} ms (differ by `
      + `${(Math.abs(M.mid.dur - M.high.dur) / DT).toFixed(1)} ticks, tolerance 2) while the 0.70 m ledge took `
      + `${(M.low.dur * 1000).toFixed(1)} ms — physics.mantle_duration: "MULTIPLE FIXED-LENGTH ANIMATIONS `
      + 'SELECTED BY LEDGE-HEIGHT BRACKET, not a single length and not a smooth function of height"');
  }

  // A mantle that puts the body inside geometry is worse than no mantle.
  {
    const led = await obstacle(1.15, 1.6);
    await stand();
    const rows = await sim.drive({
      seconds: 3.0, dt: DT, input: hold('forward'),
      sample: 'const q = window.__MOVE.pen(); return { pen: q.depth };',
    });
    await sim.eval((n) => window.__MOVE.trim(n - 1), led.n);
    const worst = Math.max(...rows.map((r) => r.pen));
    report.check('the mantle never puts the body inside the ledge it climbs', worst <= 0.001,
      `worst penetration over ${rows.length} frames of a 1.15 m mantle: ${worst.toFixed(5)} m (tolerance `
      + `0.001 m), rising ${(Math.max(...rows.map((r) => r.py)) - rows[0].py).toFixed(3)} m at the highest`);
  }
}
