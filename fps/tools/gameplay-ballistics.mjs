// Ballistics, damage and time-to-kill.
//
// This is the suite for what happens between the trigger and the corpse: how
// long the round takes to arrive, where it arrives, what it goes through, how
// much it takes off, and how many of them a kill costs at range.
//
// Five conventions run through the file and every one of them was arrived at by
// getting the measurement wrong first.
//
//   Rounds are ammo decrements; damage is an applyDamage call. weapon.fire() is
//   polled every tick the trigger is held and returns null on most of them, so
//   `weapon.fire` events count polls. The muzzle instant used here is the
//   audio.gunshot tap, which playerShoot() reaches only after fire() has
//   actually produced a shot, and every such event is cross-checked against the
//   ammo trace before any timing derived from it is quoted.
//
//   The applyDamage tap carries the numbers. _sim.mjs records string and number
//   arguments, and applyDamage(amount, zone, direction) is called with the
//   post-falloff damage and the hit zone. That is the whole damage model
//   visible from outside: `amount` is what range did to the round and
//   health-delta / amount is what the zone did. Nothing in this file infers a
//   zone from a health delta, because that inference is circular.
//
//   Aim is forced, not hoped for. Recoil, bloom and flinch all pull rounds off
//   a distant chest, and a damage-versus-range curve measured through them is a
//   curve of luck. Where a section is about range it re-points the player at
//   the target every tick and zeroes the recoil spring, which is the limit of
//   what a player re-aiming between rounds could do; where a section is about
//   whether the gun can be fought, it does not, and says which condition it
//   ran. Both numbers are reported side by side.
//
//   Spread is neutralised by patching the SPEC spread terms to zero, not by
//   assuming. currentSpread() then still floors at 0.0004 rad — 0.08 m of
//   scatter radius at 200 m — so every quantity measured that way is a median
//   over many rounds and the residual scatter is printed beside it. A single
//   round is not a measurement of anything here.
//
//   Every probe proves it can see the effect before its silence is quoted. The
//   penetration section fires the same shot with the collider removed; the
//   falloff section perturbs SPEC.falloffScale and confirms the curve follows;
//   the travel-time section confirms it counted the right number of rounds.
//   "No penetration" and "I measured nothing" are the same reading otherwise,
//   and last session the second one was reported as the first.
//
// Sourced targets come from targets.mjs and nowhere else. Every assertion
// against a Call of Duty figure names the key it used, the verdict comes from
// that file's own inside() so the tolerance maths is not reimplemented here, and
// the last check in the suite prints the whole manifest — key, value, tolerance,
// confidence and URL — together with the two thresholds this suite owns that are
// NOT sourced. A reviewer looking for an invented CoD number should be able to
// find every candidate in that one line.
//
// What the game does today, for the reader of a red line: it is pure hitscan.
// resolveBullet() is one Raycaster call, so travel time is exactly zero at
// every range, drop is exactly zero, and a 4 cm collider stops 100% of the
// round. Those checks are red by construction and are supposed to be — they are
// the specification of the projectile system that does not exist yet. Each of
// them has been confirmed to go green: the suite was run against a page-level
// projectile shim (750 m/s, the game's own gravity, a thickness gate with a flat
// damage penalty) and all 22 ballistics-domain rows flipped, while the damage
// rows the shim does not touch stayed red.

const DEG = 180 / Math.PI;

// 1/240 everywhere except travel time. The shot interval is 79 ms, so 1/240
// puts ~19 ticks between rounds: enough that a per-round quantity is never
// aliased by the sampling. Travel time gets 1/480 because the quantity under
// test may be smaller than a tick — 10 m at a rifle muzzle velocity is 11 ms —
// and the instrument's floor has to be well under the thing it is looking for.
const DT = 1 / 240;
const DT_TRAVEL = 1 / 480;

// FALLBACK ONLY. When targets.mjs is present the travel-time band comes from
// ballistics.ar_muzzle_velocity_design_band (590..850 m/s, sourced across MW2
// 2022 / MW3 / BO6) and this constant is not used. It exists so a checkout
// without the research file still discriminates a projectile from hitscan: 200
// m/s is slower than a service pistol and 1500 m/s faster than any rifle
// cartridge, so it is a physics envelope and NOT a Call of Duty figure. The
// detail string says which of the two produced the verdict, every time.
const V_PLAUSIBLE = { min: 200, max: 1500 };

export const NAME = 'ballistics';

/* ------------------------------------------------------------- targets -- */
//
// targets.mjs is written by a separate research workflow and may not exist yet.
// The import is defensive and the lookup is forgiving about shape, because this
// file does not own that schema. What it must never do is substitute a number
// of its own on a miss: a missing target reports as a measurement with the
// coverage gap named, so the absence is visible instead of papered over.
let TARGETS = null, inside = null, describe = null, missing = null;
try { ({ TARGETS, inside, describe, missing } = await import('./targets.mjs')); } catch { /* not written yet */ }

/** The target node behind a 'domain.key' reference, or null if the file lacks it. */
const targetFor = (ref) => {
  if (!TARGETS) return null;
  const [domain, key] = ref.split('.');
  return TARGETS[domain]?.[key] ?? null;
};

/* ------------------------------------------------------------ plumbing -- */

const BASE_INPUT = {
  forward: false, back: false, left: false, right: false,
  sprint: false, crouch: false, ads: false, fire: false,
};

/**
 * Input body with every key written explicitly.
 *
 * sim.drive Object.assign's the patch onto g.input, so a key omitted on tick 2
 * keeps whatever tick 1 left there. A trigger that is never released turns a
 * single-shot measurement into a burst measurement without saying so.
 */
const IN = (over = {}) => `return ${JSON.stringify({ ...BASE_INPUT, ...over })};`;

/**
 * Input body that re-points the player at a mark on enemy 0 every tick.
 *
 * `compensate` zeroes the recoil spring's state before player.update() runs.
 * That is not cheating around a bug, it is the isolation the recoil defect
 * requires: main.js integrates recoil in player.update() and only then calls
 * playerShoot(), and addRecoil() writes the *velocity* term, so a spring zeroed
 * on the tick boundary leaves aim = pitch exactly at the instant the round is
 * resolved. It is the limit of a player re-aiming between rounds, and the
 * uncompensated condition is measured separately in section 6.
 *
 * Nothing here declares t/i/g/sim: those are the compiled body's parameters and
 * shadowing them is a SyntaxError inside the page, which surfaces as a suite
 * that throws rather than a check that fails.
 */
function aimBody({ mark = 'chest', compensate = true, fire = true, fireWhile = null, elevate = 0 } = {}) {
  const marker = mark === 'head' ? 'eyePosition' : 'chestPosition';
  // `elevate` is holdover, in radians, added to the pitch that points at the
  // mark. Under hitscan it is always 0 and changes nothing. It exists because a
  // projectile build's rounds arrive below the point of aim, and a sweep that
  // aimed dead at the chest at 200 m then measured the *ground* — the shim run
  // that proved this file can go green reported 1 body hit in 6 at 200 m purely
  // because nothing was holding over.
  const hold = elevate ? ` + (${elevate})` : '';
  // `fireWhile` is an expression evaluated in the page each tick, used where a
  // section needs a counted burst followed by silence rather than a held
  // trigger. Counted off ammo, which is the only reliable round counter.
  const patch = fireWhile
    ? `Object.assign(${JSON.stringify({ ...BASE_INPUT, ads: true })}, { fire: !!(${fireWhile}) })`
    : JSON.stringify({ ...BASE_INPUT, fire, ads: true });
  return `
    const pl = g.player, en = g.director.enemies[0];
    if (en && en.alive) {
      const V = g.camera.position.constructor;
      const at = en.${marker}(new V());
      const eye = g.camera.position;
      const ax = at.x - eye.x, ay = at.y - eye.y, az = at.z - eye.z;
      pl.yaw = Math.atan2(-ax, -az);
      pl.pitch = Math.atan2(ay, Math.hypot(ax, az))${hold};
      ${compensate ? 'pl.recoilPitch = 0; pl.recoilYaw = 0; pl._recoilPitchVel = 0; pl._recoilYawVel = 0;' : ''}
    }
    return ${patch};
  `;
}

/** Sample body: enemy health, pose state and drift from the spawn point. */
const SAMPLE_ENEMY = `
  const en = g.director.enemies[0];
  if (!en) return { ehp: null, edrift: null };
  return {
    ehp: en.health,
    ealive: en.alive ? 1 : 0,
    edrift: Math.hypot(en.position.x - window.__BALL_EX, en.position.z - window.__BALL_EZ),
  };
`;

const sortNum = (a) => a.slice().sort((x, y) => x - y);
/** Median that keeps Infinity, so a "never killed" trial biases the result up. */
function median(a) {
  if (!a.length) return NaN;
  const s = sortNum(a);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}
function quantile(a, q) {
  if (!a.length) return NaN;
  const s = sortNum(a);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : String(v));
const f4 = (v) => (Number.isFinite(v) ? v.toFixed(4) : String(v));
const ms = (v) => (Number.isFinite(v) ? `${(v * 1000).toFixed(1)} ms` : String(v));

/* --------------------------------------------------------------- suite -- */

export default async function run(sim, report) {
  /* ---- sourced assertions ---------------------------------------------- */
  //
  // Every target used here is cited by its targets.mjs key and collected into a
  // manifest printed at the end of the suite, so a reader can check that the
  // number a red line is failing against came from the research file and not
  // from this test's imagination — the single failure mode this project has
  // already been burned by.
  //
  // The verdict comes from targets.mjs's own inside(), because that file owns
  // the tolerance semantics and a second implementation of them here would
  // eventually disagree with it. report.against does the printing for numeric
  // targets so the gap is shown in the reporter's standard form; band-only
  // targets (value deliberately null, tol as min..max) cannot go through
  // report.against and get their band printed explicitly instead.
  const USED = [];
  function against(name, ref, measured, unit = '') {
    const t = targetFor(ref);
    if (!t) {
      report.check(name, true,
        `measured ${Number.isFinite(measured) ? f4(measured) : String(measured)}${unit} — targets.mjs `
        + `has no ${ref}, so this quantity has no sourced target yet`);
      return false;
    }
    USED.push(describe(...ref.split('.')));
    const numeric = typeof t.value === 'number' && Number.isFinite(t.value);
    if (numeric && t.tol) {
      return report.against(`${name} [${ref}]`, measured, t.value, t.tol, unit);
    }
    const v = inside(...ref.split('.'), measured);
    if (t.tol && typeof t.tol.min === 'number') {
      report.check(`${name} [${ref}]`, v.ok,
        `measured ${Number.isFinite(measured) ? f4(measured) : String(measured)}${unit} against the sourced `
        + `band ${t.tol.min}..${t.tol.max}${unit} — the target's own value is deliberately null `
        + `(${t.confidence}), so the band is the whole claim`);
      return v.ok;
    }
    // Qualitative target: no machine tolerance. Asserting it numerically would
    // be inventing a threshold, so the reference is recorded and the behaviour
    // is asserted by whichever check cites it.
    report.check(`${name} [${ref}]`, true,
      `no machine-usable tolerance on ${ref} (${t.confidence}) — recorded as context: `
      + `${String(t.value).slice(0, 110)}`);
    return true;
  }

  // SPEC is read out of the running page rather than imported here, so it is
  // the object the game is using — and so the deadness probes can mutate it and
  // watch whether the behaviour follows.
  let SPEC = null;
  try {
    SPEC = await sim.eval(async () => {
      const m = await import('/src/weapon.js');
      return JSON.parse(JSON.stringify(m.SPEC));
    });
  } catch { SPEC = null; }
  report.check('weapon SPEC is reachable through the running page', !!SPEC,
    SPEC ? `damage ${SPEC.damage}, range ${SPEC.range} m, falloff ${SPEC.falloffStart}..${SPEC.falloffEnd} m `
      + `to x${SPEC.falloffScale}, headshotMultiplier ${SPEC.headshotMultiplier}`
      : 'could not import /src/weapon.js from the page — the constant-vs-behaviour probes are skipped');

  // The game's own gravity, used only to turn a measured drop into an implied
  // muzzle velocity. Read live because 19.6 is twice standard gravity and a
  // reader comparing the drop-implied velocity to the travel-time-implied one
  // needs to know which constant went into the sum.
  const gravity = await sim.eval(async () => {
    try { return (await import('/src/player.js')).TUNING.gravity; } catch { return null; }
  });
  // Asserted rather than assumed: if this came back null, every drop-implied
  // velocity below would silently report "infinite" and read as "no drop" on a
  // game that had drop. That is the exact shape of the failure this project has
  // already been burned by, so it gets a line of its own.
  report.check('the gravity used to interpret drop was read from the game', gravity != null,
    gravity != null
      ? `TUNING.gravity = ${gravity} m/s^2 (twice standard gravity, so a drop-implied velocity computed `
        + 'with 9.81 would be out by a factor of sqrt(2))'
      : 'could not read TUNING.gravity from /src/player.js — a drop measured below could not be turned '
        + 'into a velocity, and would report as "no drop"');

  /* ---- page-side probes ------------------------------------------------- */
  //
  // Two things the sim API does not expose and this file needs: where a round
  // actually landed, and a collider that was not in the level. Both are
  // installed by hand and both are torn down in the finally block — the runner
  // boots one sim for every suite and this one sorts first alphabetically, so a
  // leaked collider would come back as a mystery miss in movement or weapon.
  await sim.eval(() => {
    const g = window.__GAME;
    if (window.__BALL) return;
    window.__BALL = { impacts: [], added: [] };
    // vfx.impact / vfx.bloodBurst are the only callers that see the resolved
    // world point. The tap in _sim.mjs records these calls but maps object
    // arguments to null, so the point has to be captured here.
    // __tapped is set so a later sim.tapEvents() does not wrap the wrapper and
    // double every vfx event in the shared log.
    const wrap = (obj, name, surfaceOf) => {
      const original = obj[name].bind(obj);
      const w = (point, ...rest) => {
        const cam = g.camera.position;
        window.__BALL.impacts.push({
          x: point.x, y: point.y, z: point.z, t: g.elapsed,
          ex: cam.x, ey: cam.y, ez: cam.z, surface: surfaceOf(rest),
        });
        return original(point, ...rest);
      };
      w.__tapped = true;
      obj[name] = w;
    };
    wrap(g.vfx, 'impact', (rest) => rest[1] ?? 'world');
    wrap(g.vfx, 'bloodBurst', () => 'flesh');

    /** Adds a collider to the same raycastables list resolveBullet uses. */
    window.__BALL.addPlate = (cfg) => {
      const THREE = window.__THREE;
      const p = g.camera.position;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(cfg.w, cfg.h, cfg.thick),
        new THREE.MeshStandardMaterial({ color: 0x777777, metalness: 0.1, roughness: 0.8 }),
      );
      mesh.position.set(p.x + cfg.dx * cfg.dist, p.y + (cfg.dy ?? 0), p.z + cfg.dz * cfg.dist);
      mesh.lookAt(p.x, p.y, p.z);   // +Z toward the shooter: the thin axis faces the round
      mesh.name = cfg.name;
      mesh.updateMatrixWorld(true);
      g.level.raycastables.push(mesh);
      window.__BALL.added.push(cfg.name);
      return { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z };
    };
    window.__BALL.dropPlates = () => {
      for (const name of window.__BALL.added) {
        const i = g.level.raycastables.findIndex((o) => o.name === name);
        if (i >= 0) g.level.raycastables.splice(i, 1);
      }
      window.__BALL.added.length = 0;
    };
  });

  const spreadKeys = ['spreadHip', 'spreadAds', 'spreadMoving', 'spreadPerShot', 'spreadMax'];
  const specPatches = [];
  async function patchSpec(patch) {
    const prev = await sim.eval(async (p) => {
      const m = await import('/src/weapon.js');
      const before = {};
      for (const k of Object.keys(p)) { before[k] = m.SPEC[k]; m.SPEC[k] = p[k]; }
      return before;
    }, patch);
    specPatches.push(prev);
    return prev;
  }
  /** Undoes the most recent patch. Patches nest, so this is LIFO. */
  async function popSpec() {
    const prev = specPatches.pop();
    if (!prev) return;
    await sim.eval(async (p) => {
      const m = await import('/src/weapon.js');
      for (const k of Object.keys(p)) m.SPEC[k] = p[k];
    }, prev);
  }
  async function restoreSpec() { while (specPatches.length) await popSpec(); }
  /** Every spread term to zero. currentSpread() still floors at 0.0004 rad. */
  const zeroSpread = () => patchSpec(Object.fromEntries(spreadKeys.map((k) => [k, 0])));

  // A lane long enough for a 200 m target. clearLane reports need+20 when
  // nothing is in the way, so 230 from a request of 210 means "open past the
  // measurement"; anything less and every long-range number below would be a
  // measurement of a wall. The heading is a world direction (sin, cos) and the
  // player's forward is (-sin yaw, -cos yaw), so the yaw down the lane is the
  // heading plus half a turn.
  const HOME = [-6, null, 17];
  const lane = await sim.clearLane(HOME, 210);
  const laneA = lane.deg * Math.PI / 180;
  const laneYaw = laneA + Math.PI;
  const LX = Math.sin(laneA), LZ = Math.cos(laneA);
  report.check('a firing lane long enough for a 200 m target exists',
    lane.clear > 205,
    `heading ${lane.deg} deg from [${HOME[0]}, ground, ${HOME[2]}] is unobstructed for `
    + `${f2(lane.clear)} m (the probe asked for 210 and caps at 230)`);

  const at = (R) => ({ x: HOME[0] + LX * R, z: HOME[2] + LZ * R });

  /**
   * Puts a stationary target at range R and points the player at its chest.
   *
   * Returns aimAt's verdict. Callers must branch on `.clear`: a shot that
   * cannot reach the body makes every miss below a wall rather than the game,
   * which is the failure the harness comment warns about.
   */
  async function placeTarget(R, { health = 100, ads = 1, ammo = 30 } = {}) {
    const p = at(R);
    await sim.setup({
      position: HOME, yaw: laneYaw, ads, ammo,
      enemies: [{ x: p.x, z: p.z, inert: true, health }],
    });
    await sim.eval((c) => { window.__BALL_EX = c.x; window.__BALL_EZ = c.z; }, p);
    // Re-tapped every time: setup() destroys and re-spawns the roster, so the
    // applyDamage tap from the previous target went with it.
    await sim.tapEvents();
    const aim = await sim.aimAt(0);
    await sim.clearEvents();
    await sim.eval(() => { window.__BALL.impacts.length = 0; });
    return aim;
  }

  /** applyDamage calls in order, with the post-falloff amount and the zone. */
  async function damageEvents() {
    const ev = await sim.events();
    return ev.filter((e) => e.kind === 'enemy.applyDamage')
      .map((e) => ({ t: e.sim, amount: e.args[0], zone: e.args[1] }));
  }
  async function gunshotTimes() {
    const ev = await sim.events();
    return ev.filter((e) => e.kind === 'audio.gunshot').map((e) => e.sim);
  }
  /** Health decrements read off the trace, in order. */
  function hpDrops(rows) {
    const out = [];
    let prev = null;
    for (const r of rows) {
      if (r.ehp == null) continue;
      if (prev != null && r.ehp < prev - 1e-9) out.push(prev - r.ehp);
      prev = r.ehp;
    }
    return out;
  }
  /**
   * Rounds that left the gun over a trace, counted as ammo decrements.
   *
   * Seeded from `start` rather than from rows[0], because the first round leaves
   * on the very first tick (sprint-to-fire is 0 ms in this game) and rows[0]
   * already shows 29. Counting only row-to-row differences lost that round and
   * made every section here report one more damage event than rounds fired,
   * which is what a broken pairing looks like. Stops at an ammo *increase*: that
   * is the reload, and rounds after it belong to a different magazine.
   */
  const roundCount = (rows, start = 30) => {
    let n = 0, prev = start;
    for (const r of rows) {
      if (r.ammo < prev) { n += prev - r.ammo; prev = r.ammo; } else if (r.ammo > prev) break;
    }
    return n;
  };

  try {
    /* ================================== 1. travel time and velocity ==== */
    //
    // The delay between the round leaving the gun and the damage landing, at
    // four ranges. Muzzle instant is the audio.gunshot tap, which playerShoot()
    // reaches only after weapon.fire() has produced a shot; impact instant is
    // the applyDamage tap. Both carry g.elapsed, so the difference is simulated
    // time and owes nothing to the harness's own latency.
    //
    // A projectile implementation puts N ticks between the two taps and this
    // reads N*dt. Hitscan resolves inside one playerShoot() call, so both taps
    // fire on the same tick and the difference is exactly 0.0 — not "small", 0,
    // which is why the check is written against the tick length rather than
    // against a tolerance.
    const travel = [];
    {
      await zeroSpread();
      for (const R of [10, 50, 100, 150]) {
        const aim = await placeTarget(R, { health: 1e6 });
        if (!aim.clear || aim.zone !== 'body') {
          travel.push({ R, ok: false, why: `lane blocked or zone ${aim.zone} (clear=${aim.clear})` });
          continue;
        }
        // Seven rounds, then the trigger comes up and the trace keeps running
        // for another second. The trailing time is what makes this measurement
        // able to see a slow bullet: at the bottom of the plausible band a
        // 150 m round is 0.75 s in the air, so a burst that ended when the
        // firing did would report the last rounds as misses and the whole range
        // as unpaired. Seven rather than one so a single stray zone does not
        // leave the range with no sample.
        const rows = await sim.drive({
          seconds: 1.4, dt: DT_TRAVEL, sample: SAMPLE_ENEMY,
          input: aimBody({ fireWhile: 'g.weapon.ammo > 23' }),
        });
        const shots = await gunshotTimes();
        const dmg = await damageEvents();
        const fired = roundCount(rows);
        // Pairing check first. If the number of muzzle events does not match the
        // number of ammo decrements, the muzzle instant is not the muzzle
        // instant and every delay below is measured between the wrong two
        // events. This is the check that lets the 0.0 ms result be believed.
        const paired = shots.length === fired && dmg.length >= fired;
        // Paired by index, not by "the first damage event after this shot".
        // Rounds leave at one velocity down one line, so impacts arrive in
        // firing order — but with a projectile in flight, round 2's muzzle
        // instant precedes round 1's impact, and a nearest-event search hands
        // round 2 round 1's arrival and reports a third of the true delay. That
        // is the one pairing error hitscan cannot expose, because with hitscan
        // both events share a tick and any pairing looks right.
        const delays = [];
        for (let k = 0; k < Math.min(shots.length, dmg.length); k++) delays.push(dmg[k].t - shots[k]);
        travel.push({
          R, ok: true, paired, fired, shots: shots.length, hits: dmg.length,
          delay: median(delays), delays,
          drift: Math.max(...rows.map((r) => r.edrift ?? 0)),
        });
      }
      await popSpec();

      const good = travel.filter((x) => x.ok);
      report.check('the travel-time probe paired every round with a muzzle event',
        good.length === 4 && good.every((x) => x.paired),
        good.map((x) => `${x.R} m: ${x.fired} rounds, ${x.shots} muzzle events, ${x.hits} damage events`)
          .join('; ') || 'no range produced a clear shot');

      // The pass band for a per-range travel time is the sourced AR muzzle
      // velocity design band (590..850 m/s across MW2 2022 / MW3 / BO6) when
      // targets.mjs is present. V_PLAUSIBLE is only the fallback for a checkout
      // without that file, and it is a physics envelope rather than a CoD
      // figure — which is why the detail says which of the two it used.
      const band = targetFor('ballistics.ar_muzzle_velocity_design_band');
      const lo = band?.tol?.min ?? V_PLAUSIBLE.min;
      const hi = band?.tol?.max ?? V_PLAUSIBLE.max;
      const bandNote = band
        ? `the sourced AR design band ${lo}..${hi} m/s (ballistics.ar_muzzle_velocity_design_band)`
        : `${lo}..${hi} m/s (a physical envelope for small arms — targets.mjs absent, so NOT a sourced `
          + 'CoD figure)';

      for (const x of good) {
        const v = x.R / x.delay;   // Infinity when the delay is exactly zero
        const ok = x.delay > 0.5 * DT_TRAVEL && v >= lo && v <= hi;
        report.check(`round travel time at ${x.R} m`, ok,
          `${ms(x.delay)} between the round leaving the gun and the damage landing `
          + `(${x.delays.length} rounds, one tick is ${ms(DT_TRAVEL)}), implied velocity `
          + `${Number.isFinite(v) ? `${f2(v)} m/s` : 'infinite — the round arrives on the tick it was fired'}; `
          + `a bullet lands in ${bandNote}`);
      }

      // The second half of the same statement: a projectile has *one* muzzle
      // velocity, so the four ranges must imply the same number. This is what
      // separates a real projectile from a fudge that delays impacts by a
      // constant, and it is reported as a spread so a partly-right
      // implementation shows up as a magnitude.
      const vs = good.map((x) => x.R / x.delay).filter(Number.isFinite);
      const vSpread = vs.length ? (Math.max(...vs) - Math.min(...vs)) / mean(vs) : NaN;
      report.check('travel time is consistent with a single muzzle velocity',
        vs.length === good.length && good.length > 0 && vSpread < 0.25,
        vs.length
          ? `implied velocities ${vs.map((v) => f2(v)).join(' / ')} m/s across `
            + `${good.map((x) => `${x.R}`).join('/')} m, spread ${(100 * vSpread).toFixed(1)}% of the mean`
          : `no finite velocity at any of ${good.map((x) => `${x.R} m`).join(', ')}: every delay was `
            + `${good.map((x) => ms(x.delay)).join(' / ')}, so the game is hitscan and has no muzzle velocity`);

      report.check('the target held still while travel time was measured',
        good.length > 0 && good.every((x) => x.drift < 0.05),
        `max drift from the spawn point ${f4(Math.max(0, ...good.map((x) => x.drift)))} m over `
        + `${good.length} ranges — a target that walked `
        + 'would put its own motion inside the delay');

      /* ---- against the research ---------------------------------------- */
      //
      // The bullet model itself is a sourced boolean: every CoD from MW2019
      // onward resolves rifle fire as a simulated projectile with travel time,
      // not a raycast. Measured as 1 if any range showed a nonzero delay.
      const isProjectile = good.length > 0 && good.every((x) => x.delay > 0.5 * DT_TRAVEL) ? 1 : 0;
      against('the bullet is a projectile rather than hitscan',
        'ballistics.bullet_model_is_projectile_not_hitscan', isProjectile, ' (1 = projectile)');
      // One velocity for the weapon, from all four ranges pooled.
      const vAll = median(good.map((x) => x.R / x.delay));
      against('muzzle velocity', 'ballistics.ar_muzzle_velocity_design_band', vAll, ' m/s');
      against('muzzle velocity against the MW3 MCW figure',
        'ballistics.ar_muzzle_velocity_mcw_mw3_2023', vAll, ' m/s');

      // The sourced rule that makes travel time a design decision rather than a
      // detail: Warzone servers tick at 20 Hz, so a round is effectively
      // instant out to velocity/20 metres and needs leading past it. Reported
      // rather than asserted — the divisor is the sourced quantity, the radius
      // it implies for THIS weapon is arithmetic on our own velocity.
      const divisor = targetFor('ballistics.instant_hit_range_formula_divisor');
      const percept = targetFor('ballistics.perceptible_travel_time_threshold');
      if (divisor) USED.push(describe('ballistics', 'instant_hit_range_formula_divisor'));
      if (percept) USED.push(describe('ballistics', 'perceptible_travel_time_threshold'));
      report.check('the range past which a round stops being effectively instant', true,
        `measured ${Number.isFinite(vAll) ? `${f2(vAll / (divisor?.value ?? 20))} m` : 'unbounded — every '
          + 'range is instant, because travel time is 0 at every range'}`
        + (divisor ? `, from velocity / ${divisor.value} Hz server tick` : '')
        + (percept ? `; sourced perceptibility onset ${percept.value} +/-${percept.tol.abs} m` : '')
        + ' — measured, no per-weapon sourced target for this derived radius');
    }

    /* ============================================== 2. bullet drop ===== */
    //
    // A level shot into a plate at 50, 100 and 150 m, measuring the impact
    // height against the eye. With pitch and the recoil spring both held at
    // zero, aimDirection() is exactly horizontal, so the aim point at any range
    // is the eye height and the vertical error *is* the drop.
    //
    // The plate is used instead of a soldier on purpose: a level shot at a
    // 1.28 m chest from a 1.65 m eye is not level with respect to the target,
    // and the first version of this measurement was reading the difference
    // between eye height and chest height as 37 cm of drop at every range.
    //
    // Averaged over a whole magazine, because the 0.0004 rad spread floor that
    // currentSpread() cannot be patched below puts +-0.06 m of scatter on a
    // single round at 150 m — the same order as the drop a plausible projectile
    // would have, so one round could not tell the two apart. 30 rounds pull the
    // standard error of the mean down to about 5 mm, which is a quarter of the
    // threshold; both numbers are printed so the reader can check that for
    // themselves rather than take it on trust.
    // Drop curvature k, in m per m^2, measured in this section and used by the
    // falloff sweep below to hold over. Zero under hitscan.
    let dropK = 0;
    const drop = [];
    {
      await zeroSpread();
      for (const R of [50, 100, 150]) {
        await sim.setup({ position: HOME, yaw: laneYaw, pitch: 0, ads: 1, ammo: 30 });
        await sim.eval((c) => { window.__BALL_EX = c.x; window.__BALL_EZ = c.z; }, at(R));
        await sim.eval(() => { window.__BALL.impacts.length = 0; });
        const plate = await sim.eval((c) => window.__BALL.addPlate(c), {
          w: 40, h: 40, thick: 0.2, dist: R, dx: LX, dz: LZ, name: `ball-drop-${R}`,
        });
        // pitch is re-zeroed every tick: view bob and the recoil spring would
        // otherwise both leak into a quantity that is only meaningful for a
        // perfectly level bore.
        const rows = await sim.drive({
          // 2.45 s empties the magazine: 30 samples per range rather than the
          // 20 a shorter burst gave, which is the difference between a standard
          // error of 7 mm and one of 5 mm against a 20 mm threshold.
          seconds: 2.45, dt: DT,
          input: 'const pl = g.player; pl.pitch = 0; pl.recoilPitch = 0; pl.recoilYaw = 0;'
            + ' pl._recoilPitchVel = 0; pl._recoilYawVel = 0;'
            + IN({ fire: true, ads: true }),
        });
        const imps = await sim.eval(() => window.__BALL.impacts.slice());
        await sim.eval(() => window.__BALL.dropPlates());
        const onPlate = imps.filter((h) => Math.abs(Math.hypot(h.x - h.ex, h.z - h.ez) - R) < 1.0);
        const dys = onPlate.map((h) => h.y - h.ey);
        // Mean, not median: the residual cone is symmetric about the bore, so
        // the mean is the lower-variance estimator of its centre, and the
        // standard error of that mean is what decides whether a small drop is
        // real. The 68% interval is carried too, as the per-round scatter.
        const m = mean(dys);
        const sd = dys.length > 2
          ? Math.sqrt(dys.reduce((s, y) => s + (y - m) ** 2, 0) / (dys.length - 1)) : NaN;
        drop.push({
          R, n: onPlate.length, rounds: roundCount(rows),
          dy: m, se: sd / Math.sqrt(dys.length),
          scatter: onPlate.length > 2 ? quantile(dys, 0.84) - quantile(dys, 0.16) : NaN,
          plateY: plate.y,
        });
      }
      await popSpec();

      // Liveness: if the plate caught no rounds, every zero below is the probe's
      // and not the game's.
      report.check('the drop probe caught its rounds on the plate',
        drop.every((d) => d.n >= 8),
        drop.map((d) => `${d.R} m: ${d.n} of ${d.rounds} rounds landed on the plate`).join('; '));

      // 0.02 m at 150 m is a structural floor, not a CoD figure. Two things put
      // it where it is: any projectile slower than about 2300 m/s drops at
      // least that far over 150 m under the game's own 19.6 m/s^2, so the
      // threshold admits every plausible bullet; and it is roughly 4x the
      // instrument's own standard error, so a pass cannot be manufactured by
      // scatter. Scaled by range^2 for the shorter shots because drop is
      // quadratic in time of flight.
      const dropFloor = (R) => 0.02 * (R / 150) ** 2;
      /** Drop-implied velocity, only defined once the drop clears the noise. */
      const vFromDrop = (d) => (d && -d.dy > dropFloor(d.R) && gravity
        ? d.R * Math.sqrt(gravity / (2 * -d.dy)) : Infinity);

      for (const d of drop) {
        const floor = dropFloor(d.R);
        const real = -d.dy > floor;
        report.check(`bullet drop at ${d.R} m`, real,
          `impact ${f4(d.dy)} m relative to a level aim point, mean of ${d.n} rounds, standard error `
          + `${f4(d.se)} m (per-round 68% interval ${f4(d.scatter)} m wide, from the 0.0004 rad spread `
          + `floor that currentSpread() will not go below); `
          + `${real
            ? `implied muzzle velocity ${f2(vFromDrop(d))} m/s at the game's ${gravity} m/s^2`
            : `the round lands level to within ${f4(Math.abs(d.dy))} m against a ${f4(floor)} m threshold `
              + '— nothing is integrating gravity on the round'}`
          // The research file records, explicitly, that no numeric
          // drop-in-metres-at-range figure could be corroborated for any CoD
          // title — only that drop exists and was kept deliberately small. So
          // there is nothing to assert this against, and the asserted form of
          // the claim is the boolean below.
          + '; no sourced drop-in-metres figure exists (see the note on '
          + 'ballistics.bullet_gravity_drop_present)');
      }

      // Drop is quadratic in range, so 150 m must drop about 9x as far as
      // 50 m. A model that drops the round linearly, or clamps it at some
      // maximum, fails here while passing every individual range.
      //
      // With no drop at all the ratio is a ratio of two noise samples, so it is
      // reported as meaningless rather than as a number the reader might chase.
      const d50 = drop.find((d) => d.R === 50), d150 = drop.find((d) => d.R === 150);
      const bothReal = d50 && d150 && -d50.dy > dropFloor(50) && -d150.dy > dropFloor(150);
      const ratio = bothReal ? d150.dy / d50.dy : NaN;
      report.check('drop grows with the square of range',
        bothReal && ratio > 5 && ratio < 15,
        bothReal
          ? `150 m drops ${f4(d150.dy)} m against ${f4(d50.dy)} m at 50 m, ratio ${f3(ratio)} `
            + '(gravity over a constant velocity gives 9.0)'
          : `not measurable: 50 m gave ${f4(d50?.dy)} m and 150 m gave ${f4(d150?.dy)} m, both inside the `
            + `${f4(dropFloor(150))} m noise threshold, so there is no drop to take a ratio of`);

      // Cross-check of the two independent velocity estimates. They measure the
      // same physical quantity through different mechanisms — time of flight
      // and gravitational fall — so a real projectile system makes them agree,
      // and a system that fakes one of them makes them disagree loudly.
      const vT = travel.find((x) => x.R === 150)?.delay;
      const vTravel = Number.isFinite(vT) && vT > 0 ? 150 / vT : Infinity;
      dropK = d150 && -d150.dy > dropFloor(150) ? -d150.dy / (150 * 150) : 0;
      const vDrop = vFromDrop(d150);
      const agree = Number.isFinite(vTravel) && Number.isFinite(vDrop)
        && Math.abs(vTravel - vDrop) / vTravel < 0.3;
      report.check('time-of-flight and drop imply the same muzzle velocity at 150 m', agree,
        `travel time implies ${Number.isFinite(vTravel) ? `${f2(vTravel)} m/s` : 'infinite (0.0 ms of flight)'}, `
        + `drop implies ${Number.isFinite(vDrop) ? `${f2(vDrop)} m/s` : 'infinite (no measurable drop)'} — `
        + `${agree ? 'the two mechanisms agree'
          : 'neither quantity exists, so the two mechanisms cannot be checked against each other'}`);

      // The sourced form of the claim: gravity acts on bullets at all.
      against('bullets are affected by gravity', 'ballistics.bullet_gravity_drop_present',
        bothReal ? 1 : 0, ' (1 = drop present)');
    }

    /* ============================================= 3. penetration ====== */
    //
    // A thin collider at 4 m, with a soldier at 20 m behind it, and the same
    // burst fired with and without the plate. The paired shot is the whole
    // point: it turns "0 HP transmitted" from an absence of evidence into a
    // measurement, because the identical burst through empty air is on the
    // record next to it.
    //
    // Four thicknesses, and the shape the research describes decides what they
    // are for. As of the current model, penetration is a per-material
    // MAX-THICKNESS GATE plus ONE flat damage percentage: a round either gets
    // through or it does not, and when it does the penalty is the same
    // regardless of how thick the obstruction was
    // (ballistics.penetration_damage_falloff_is_flat_not_thickness_scaled).
    // That is why this section does NOT assert that damage falls off with
    // thickness — an earlier draft did, and it would have been asserting the
    // pre-Season-01 model against the documented current one. What the
    // thicknesses buy instead is the gate: something thin must pass, something
    // thick must not, and everything that passes must retain the same fraction.
    //
    // The retained percentage itself is unpublished, so no number is asserted
    // for it. It is measured and printed.
    {
      await zeroSpread();
      const aim0 = await placeTarget(20, { health: 1e6 });
      // Six rounds then a trailing window, for the same reason as the falloff
      // sweep: the burst that is compared with and without the collider has to
      // give a slow round time to arrive, or "nothing got through" is the
      // instrument closing early.
      const BURST = { seconds: 1.0, dt: DT, sample: SAMPLE_ENEMY,
        input: aimBody({ fireWhile: 'g.weapon.ammo > 24' }) };
      const bare = await sim.drive(BURST);
      const bareDmg = await damageEvents();
      const bareDealt = bareDmg.reduce((s, d) => s + d.amount, 0);
      const bareRounds = roundCount(bare);

      const walls = [];
      for (const thick of [0.04, 0.08, 0.3, 1.0]) {
        const aimPre = await placeTarget(20, { health: 1e6 });
        await sim.eval((c) => window.__BALL.addPlate(c), {
          w: 6, h: 6, thick, dist: 4, dx: LX, dz: LZ, name: `ball-wall-${thick}` });
        const blocked = await sim.aimAt(0);
        const rows = await sim.drive(BURST);
        const dmg = await damageEvents();
        const imps = await sim.eval(() => window.__BALL.impacts.slice());
        await sim.eval(() => window.__BALL.dropPlates());
        walls.push({
          thick, aimPre, blocked,
          dealt: dmg.reduce((s, d) => s + d.amount, 0),
          events: dmg.length,
          hpLost: hpDrops(rows).reduce((s, d) => s + d, 0),
          rounds: roundCount(rows),
          surface: imps[0]?.surface ?? 'none',
          impacts: imps.length,
        });
      }
      await popSpec();
      const thin = walls[0], thick = walls[walls.length - 1];

      report.check('the penetration probe can see damage when nothing is in the way',
        bareDealt > 0 && bareRounds > 0 && aim0.clear,
        `${bareRounds} rounds through clear air at 20 m dealt ${f2(bareDealt)} HP `
        + `(${bareDmg.length} damage events, ${f2(bareDealt / Math.max(1, bareDmg.length))} HP each)`);
      report.check('the colliders are between the muzzle and the body',
        walls.every((w) => w.aimPre.clear === true && w.blocked.clear === false
          && Math.abs(w.blocked.worldDist - 4) < 0.5),
        walls.map((w) => `${w.thick} m plate: body reachable before it was added (clear=${w.aimPre.clear}), `
          + `first world hit then at ${f2(w.blocked.worldDist)} m against a body at `
          + `${f2(w.blocked.enemyDist)} m, ${w.impacts} impacts on it as "${w.surface}"`).join('; '));

      const frac = bareDealt > 0 ? thin.dealt / bareDealt : NaN;
      report.check('a thin collider transmits some damage', thin.dealt > 0,
        `${thin.rounds} rounds into a ${thin.thick * 100} cm collider transmitted ${f2(thin.dealt)} HP to the `
        + `body behind it (${thin.events} damage events, ${f2(thin.hpLost)} HP off the target's health) `
        + `against ${f2(bareDealt)} HP for the same burst with the collider removed — `
        + `${(100 * frac).toFixed(1)}% gets through; the retained percentage is unpublished in the research, `
        + 'so the number is reported and not asserted');

      // The gate. resolveBullet() compares the enemy hit against the first
      // world hit and returns on the world hit, so thickness is never
      // consulted: a 4 cm sheet and a 1 m block are the same object to it, and
      // there is no gate at all — everything blocks. This is the check that
      // says so with numbers rather than by reading the source.
      const passed = walls.filter((w) => w.dealt > 0);
      const stopped = walls.filter((w) => w.dealt <= 0);
      const orderOk = passed.every((p) => stopped.every((q) => p.thick < q.thick));
      report.check('thickness gates whether a round penetrates at all',
        passed.length > 0 && stopped.length > 0 && orderOk,
        walls.map((w) => `${w.thick} m -> ${f2(w.dealt)} HP through`).join(', ')
        + `, against ${f2(bareDealt)} HP through open air: `
        + `${passed.length} of ${walls.length} thicknesses penetrate`
        + (passed.length && stopped.length
          ? `, gate somewhere between ${Math.max(...passed.map((w) => w.thick))} and `
            + `${Math.min(...stopped.map((w) => w.thick))} m`
          : passed.length ? ' — nothing stops a round, so there is no gate either'
            : ' — nothing penetrates, so there is no gate, only a wall'));

      // And the sourced shape of the damage penalty: flat, not scaled by
      // thickness. Measurable only where at least two thicknesses penetrate;
      // where none do, inside() reports the non-finite measurement rather than
      // this file inventing a verdict.
      const fracs = passed.map((w) => w.dealt / w.rounds);
      const flat = fracs.length >= 2
        ? ((Math.max(...fracs) - Math.min(...fracs)) / mean(fracs) < 0.02 ? 1 : 0)
        : NaN;
      against('the penetration damage penalty is flat rather than thickness-scaled',
        'ballistics.penetration_damage_falloff_is_flat_not_thickness_scaled', flat, ' (1 = flat)');
      // Recorded, not assertable with one weapon: penetration strength is
      // assigned per weapon class, and FMJ moves both the gate and the penalty.
      // A single-weapon suite cannot see either, and saying so is the honest
      // form of the coverage gap.
      against('penetration strength is assigned by weapon class',
        'ballistics.penetration_class_hierarchy', NaN);
      const fmj = targetFor('ballistics.fmj_attachment_effect');
      if (fmj) USED.push(describe('ballistics', 'fmj_attachment_effect'));
      report.check('attachment control over penetration', true,
        `not measurable from one weapon with no attachment system: the sourced model requires `
        + `${fmj ? fmj.value : 2} separate FMJ effects (raise the thickness gate, soften the flat `
        + 'penalty) — reported as a coverage gap, not asserted');
    }

    /* ========================================== 4. damage falloff ====== */
    //
    // Damage actually applied per round across 10..200 m, spread neutralised
    // and aim forced, counting only rounds the applyDamage tap reports as
    // 'body'. Two independent readings per range: the post-falloff `amount`
    // argument, and the health delta off the trace. They must agree for a body
    // hit (zone multiplier 1.0) and the check says so, because if they diverge
    // one of the two is not what this file thinks it is.
    //
    // Six rounds and then a second of quiet, at every range, rather than a
    // continuous 0.45 s burst. Under hitscan the two are identical; under a
    // projectile at the slow end of the plausible band a 200 m round is half a
    // second in the air, and a window that closes with the trigger reported
    // "0 of 6 body hits at 200 m" — a range the instrument had failed to reach
    // dressed up as a range the gun cannot hurt.
    const curve = [];
    {
      await zeroSpread();
      for (let R = 10; R <= 200; R += 10) {
        const aim = await placeTarget(R, { health: 1e6 });
        if (!aim.clear) { curve.push({ R, blocked: true }); continue; }
        const rows = await sim.drive({
          seconds: 1.5, dt: DT, sample: SAMPLE_ENEMY,
          input: aimBody({ fireWhile: 'g.weapon.ammo > 24', elevate: Math.atan(dropK * R) }),
        });
        const dmg = await damageEvents();
        const body = dmg.filter((d) => d.zone === 'body');
        const drops = hpDrops(rows);
        curve.push({
          R,
          n: body.length, fired: roundCount(rows), zones: dmg.map((d) => d.zone),
          amount: median(body.map((d) => d.amount)),
          hp: median(drops),
          dist: aim.distance,
        });
      }
      await popSpec();

      const usable = curve.filter((c) => !c.blocked && c.n >= 3);
      report.check('the falloff sweep collected body hits at every range',
        usable.length === curve.length && curve.every((c) => !c.blocked),
        curve.map((c) => (c.blocked ? `${c.R} m BLOCKED` : `${c.R} m: ${c.n}/${c.fired} body`)).join(', ')
        + `; holdover from the measured drop curvature k=${dropK.toExponential(2)} m/m^2, `
        + `${(Math.atan(dropK * 200) * DEG * 60).toFixed(1)} arcmin at 200 m`);

      report.check('the applied damage and the health delta agree on a body hit',
        usable.every((c) => Math.abs(c.amount - c.hp) < 0.01),
        usable.map((c) => `${c.R} m ${f2(c.amount)}/${f2(c.hp)}`).slice(0, 6).join(', ')
        + ` ... max divergence ${f4(Math.max(...usable.map((c) => Math.abs(c.amount - c.hp))))} HP — `
        + 'the falloff is applied before the zone multiplier, so for a body hit the two are the same number');

      report.check('damage-versus-range curve', usable.length > 0,
        usable.map((c) => `${c.R}m ${f2(c.amount)}`).join(' | ')
        + ` HP per round (median of ${usable.map((c) => c.n).reduce((a, b) => a + b, 0)} body hits) `
        + '— measured, no sourced target yet');

      // Monotonic and bounded: a round must not hit harder further away, and
      // the curve must actually fall somewhere or "falloff" is not implemented.
      const steps = usable.slice(1).map((c, i) => c.amount - usable[i].amount);
      report.check('damage never increases with range',
        steps.every((s) => s <= 1e-6),
        `largest increase between adjacent ranges ${f4(Math.max(0, ...steps))} HP; `
        + `total fall ${f2(usable[0].amount - usable[usable.length - 1].amount)} HP from `
        + `${f2(usable[0].amount)} at ${usable[0].R} m to ${f2(usable[usable.length - 1].amount)} at `
        + `${usable[usable.length - 1].R} m`);

      // Banded or smooth. A banded model holds damage constant across a range
      // band and then steps; a lerp changes it at every range. Both are
      // measured the same way and told apart by two numbers: how many distinct
      // plateaus the curve has, and how uneven its steps are.
      //
      // The expectation of bands is not invented here: the research file records
      // a weapon whose falloff is explicitly stepwise — three discrete stops at
      // 22.5, 40 and 50 m — and the M4A1 entries describe a flat plateau, one
      // linear segment, then a flat floor, i.e. two stops and one ramp between
      // them. No numeric band count is asserted, because none is published as a
      // general figure; the assertion is about the SHAPE, and the citation is
      // damage.striker45_mw2019_falloff_range_stops.
      //
      // What bands buy is learnability: with them a player can hold "three shots
      // inside this range, four beyond it" and be right, and the shot count
      // changes at a small number of announced distances. Under a continuous
      // lerp the boundary lands wherever 100/damage crosses an integer, so it
      // moves by a metre or two per weapon tweak and nothing about it is
      // memorable. Both quantities are printed either way, so a reader who
      // disagrees with the expectation still gets the measurement.
      let plateaus = 1;
      for (let i = 1; i < usable.length; i++) {
        if (Math.abs(usable[i].amount - usable[i - 1].amount) > 0.005 * usable[0].amount) plateaus++;
      }
      const moving = steps.map(Math.abs).filter((s) => s > 0.005 * usable[0].amount);
      const evenness = moving.length ? Math.max(...moving) / mean(moving) : NaN;
      const banded = plateaus <= Math.max(4, usable.length / 4);
      const stepwise = targetFor('damage.striker45_mw2019_falloff_range_stops');
      if (stepwise) USED.push(describe('damage', 'striker45_mw2019_falloff_range_stops'));
      report.check('damage falls in discrete range bands rather than on a continuous ramp', banded,
        `${plateaus} distinct damage plateaus across ${usable.length} ranges 10 m apart; `
        + `${moving.length} of ${steps.length} adjacent pairs differ, steps `
        + `${moving.slice(0, 4).map((s) => f3(s)).join('/')}... with max/mean ${f3(evenness)} `
        + `(1.0 = perfectly even = a linear ramp) -> the curve is ${banded ? 'banded' : 'SMOOTH: one '
          + 'lerp from falloffStart to falloffEnd, so damage changes at every range and the shot-count '
          + 'boundary sits wherever 100/damage happens to cross an integer'}. Shape claim, cited to `
        + `${stepwise ? 'damage.striker45_mw2019_falloff_range_stops' : 'nothing — targets.mjs absent'}; `
        + 'no numeric band count is asserted because none is published');

      // The near plateau, the far floor and the two range stops between them,
      // all derived from the curve rather than read off SPEC — the point being
      // that these are the numbers the game has, whatever the constants say.
      //
      // The stops are FITTED rather than read off the sweep grid, because the
      // sweep steps 10 m and the sourced targets are +/-1 m and +/-1.5 m: "full
      // damage out to 40 m, first drop by 50 m" cannot be compared with 37.5 m
      // at all. So the ramp samples — everything strictly between the plateau
      // and the floor — get a least-squares line, and the stops are where that
      // line meets the plateau and the floor. The residual is printed, because
      // the fit is only meaningful if the ramp really is a line, and if a future
      // build makes it banded the residual is how the reader finds out the
      // fitted stops have become meaningless.
      const near = usable[0].amount;
      const far = usable[usable.length - 1].amount;
      const ramp = usable.filter((c) => c.amount < near - 1e-6 && c.amount > far + 1e-6);
      let nearStop = NaN, farStop = NaN, fitResid = NaN;
      if (ramp.length >= 2) {
        const mx = mean(ramp.map((c) => c.R)), my = mean(ramp.map((c) => c.amount));
        const sxy = ramp.reduce((a, c) => a + (c.R - mx) * (c.amount - my), 0);
        const sxx = ramp.reduce((a, c) => a + (c.R - mx) ** 2, 0);
        const slope = sxy / sxx, intercept = my - slope * mx;
        nearStop = (near - intercept) / slope;
        farStop = (far - intercept) / slope;
        fitResid = Math.sqrt(mean(ramp.map((c) => (c.amount - (intercept + slope * c.R)) ** 2)));
      }
      report.check('falloff range stops fitted from the curve', Number.isFinite(nearStop),
        `full ${f2(near)} HP out to a fitted ${f2(nearStop)} m, then ${f3(-(near - far) / (farStop - nearStop))} `
        + `HP/m to a ${f2(far)} HP floor (x${f3(far / near)} of point-blank) at a fitted ${f2(farStop)} m; `
        + `${ramp.length} ramp samples, RMS residual ${f4(fitResid)} HP about the fitted line`);

      // Against the research. Only the STOPS and the derived quantities are
      // asserted; the raw HP-per-bullet figures are reported beside their
      // sourced counterparts but NOT asserted, deliberately. 30 HP is the M4A1's
      // number at 682 rpm and 100 HP, and a port is entitled to its own damage
      // constant as long as the player-facing quantities — shots to kill and
      // time to kill — land where they should. Those are asserted in section 6.
      // Asserting damage-per-bullet on top would fail a build that was correct
      // and send whoever read it to tune the wrong number.
      against('falloff onset (near range stop)', 'damage.m4a1_mw2019_near_range_stop', nearStop, ' m');
      against('falloff end (far range stop)', 'damage.m4a1_mw2019_far_range_stop', farStop, ' m');
      const srcMax = targetFor('damage.m4a1_mw2019_max_damage');
      const srcMin = targetFor('damage.m4a1_mw2019_min_damage');
      const srcMcw = targetFor('damage.mcw_mw3_lower_torso_damage');
      if (srcMax) USED.push(describe('damage', 'm4a1_mw2019_max_damage'));
      if (srcMin) USED.push(describe('damage', 'm4a1_mw2019_min_damage'));
      if (srcMcw) USED.push(describe('damage', 'mcw_mw3_lower_torso_damage'));
      report.check('damage per bullet, against the sourced references', true,
        `measured ${f2(near)} HP inside the plateau and ${f2(far)} HP on the floor, a x${f3(far / near)} `
        + `retention. Sourced for comparison: M4A1 MW2019 ${srcMax?.value ?? '?'} -> `
        + `${srcMin?.value ?? '?'} HP (x${srcMax && srcMin ? f3(srcMin.value / srcMax.value) : '?'} `
        + `retention), MCW MW3 lower torso ${srcMcw?.value ?? '?'} HP. Reported and not asserted: the `
        + 'player-facing quantity is shots-to-kill, asserted in section 6');

      // Liveness. Halving falloffScale must move the far end of the curve; if
      // it does not, the whole section is measuring the instrument.
      if (SPEC) {
        await patchSpec({ falloffScale: SPEC.falloffScale * 0.5 });
        await zeroSpread();
        const aim = await placeTarget(200, { health: 1e6 });
        // Same burst shape and same holdover as the sweep it is validating, so
        // the comparison is of damage and not of two different measurements.
        await sim.drive({
          seconds: 1.5, dt: DT, sample: SAMPLE_ENEMY,
          input: aimBody({ fireWhile: 'g.weapon.ammo > 25', elevate: Math.atan(dropK * 200) }),
        });
        const body = (await damageEvents()).filter((d) => d.zone === 'body');
        await popSpec();      // spread
        await popSpec();      // falloffScale
        const quiet = median(body.map((d) => d.amount));
        report.check('the falloff probe responds to the falloff it is measuring',
          aim.clear && Number.isFinite(quiet) && Math.abs(quiet - far) > 1,
          `halving SPEC.falloffScale (${f3(SPEC.falloffScale)} -> ${f3(SPEC.falloffScale * 0.5)}) took the `
          + `200 m damage from ${f2(far)} to ${f2(quiet)} HP over ${body.length} body hits — the constant `
          + 'is live and the curve above is the game\'s');
      }
    }

    /* ====================================== 5. zone multipliers ======== */
    //
    // Measured from health deltas against the post-falloff amount the tap
    // reports, at one range, for the head and the body. amount is what range
    // did to the round; delta/amount is what the zone did. Both come from the
    // same call, so the ratio cannot pick up a falloff error.
    let headMult = NaN;
    {
      await zeroSpread();

      async function zoneRun(mark) {
        await placeTarget(20, { health: 1e6 });
        const rows = await sim.drive({
          seconds: 1.0, dt: DT, sample: SAMPLE_ENEMY,
          input: aimBody({ mark, fireWhile: 'g.weapon.ammo > 23' }),
        });
        const dmg = await damageEvents();
        const drops = hpDrops(rows);
        // Paired in order: the applyDamage tap and the health trace see the
        // same calls in the same sequence, so index k of one belongs to index k
        // of the other. Pairs are dropped rather than assumed when the counts
        // disagree.
        const pairs = [];
        for (let k = 0; k < Math.min(dmg.length, drops.length); k++) {
          pairs.push({ zone: dmg[k].zone, amount: dmg[k].amount, delta: drops[k] });
        }
        return pairs;
      }

      const headPairs = await zoneRun('head');
      const bodyPairs = await zoneRun('chest');
      await popSpec();

      const byZone = {};
      for (const p of [...headPairs, ...bodyPairs]) {
        (byZone[p.zone] ??= []).push(p.delta / p.amount);
      }
      const multOf = (z) => (byZone[z] ? median(byZone[z]) : NaN);
      headMult = multOf('head');
      const bodyMult = multOf('body');

      report.check('the zone probe hit the head and the body deliberately',
        (byZone.head?.length ?? 0) >= 3 && (byZone.body?.length ?? 0) >= 3,
        Object.entries(byZone).map(([z, v]) => `${z} x${f3(median(v))} over ${v.length} hits`).join(', ')
        || 'no zoned hits at all');

      report.check('zone damage multipliers', Number.isFinite(headMult) && Number.isFinite(bodyMult),
        Object.entries(byZone).map(([z, v]) => `${z} x${f4(median(v))} (n=${v.length}, `
          + `range ${f4(Math.min(...v))}..${f4(Math.max(...v))})`).join('; ')
        + ' — measured as health delta over the post-falloff amount');

      // Against the research. The headshot multiplier is one of the few damage
      // numbers CoD publishes consistently, and it is small: x1.4 on the M4A1
      // and most MW2019 weapons, x1.3 on the MW3 MCW, x1.5 even on snipers, x1.0
      // on shotguns. Both of this game's candidates — the 2.6 in ai.js and the
      // 2.4 in SPEC — are roughly double the largest sourced figure, which makes
      // a chest burst and a head burst two different weapons.
      against('headshot multiplier', 'damage.m4a1_mw2019_headshot_multiplier', headMult, 'x');
      against('headshot multiplier against the MW3 MCW figure',
        'damage.mcw_mw3_headshot_multiplier_launch', headMult, 'x');
      against('torso multiplier', 'damage.mcw_mw3_torso_multiplier_post_buff', bodyMult, 'x');
      const srcSniper = targetFor('damage.mw2019_headshot_multiplier_sniper_rifles');
      if (srcSniper) USED.push(describe('damage', 'mw2019_headshot_multiplier_sniper_rifles'));
      report.check('the headshot multiplier is not above the sourced ceiling for any weapon class',
        Number.isFinite(headMult) && srcSniper ? headMult <= srcSniper.value + srcSniper.tol.abs : true,
        `x${f4(headMult)} measured on an assault rifle against x${srcSniper?.value ?? '?'} for sniper `
        + 'rifles, the highest multiplier in the research file; shotguns are x1.0');

      // One number must govern it. SPEC.headshotMultiplier is 2.4; ai.js
      // applyDamage() hard-codes 2.6 and nothing reads the constant. Reported
      // as a number so the reader sees which one the game uses, and confirmed
      // by perturbation so the claim does not rest on reading the source.
      const specMult = SPEC?.headshotMultiplier ?? null;
      report.check('the headshot multiplier the game applies is the one in SPEC',
        specMult != null && Math.abs(headMult - specMult) < 0.02,
        `the game multiplies a headshot by x${f4(headMult)} (body x${f4(bodyMult)}); `
        + `SPEC.headshotMultiplier is ${specMult == null ? 'unreadable' : f3(specMult)}. `
        + `The applied value is the literal in ai.js applyDamage(); the constant is a second, `
        + `different number that nothing reads`);

      if (SPEC) {
        await patchSpec({ headshotMultiplier: 9.9 });
        await zeroSpread();
        const pairs = await zoneRun('head');
        await popSpec();
        await popSpec();
        const hs = pairs.filter((p) => p.zone === 'head').map((p) => p.delta / p.amount);
        const after = median(hs);
        report.check('SPEC.headshotMultiplier governs headshot damage',
          Number.isFinite(after) && Math.abs(after - headMult) > 0.1,
          `setting SPEC.headshotMultiplier to 9.9 left the measured multiplier at x${f4(after)} `
          + `(was x${f4(headMult)}, ${hs.length} headshots) — the constant is dead, so there is no single `
          + 'number governing headshot damage: the value lives as a literal in ai.js');
      }
    }

    /* ========================================= 6. shots-to-kill / TTK == */
    //
    // A distribution, not a run. TTK here is stochastic through exactly one
    // channel — the spread cone draw, which decides whether a round lands on
    // the body, clips a limb at x0.72, or finds the head at x2.6 — and one
    // sample of a lottery is not a measurement of it. Math.random is seeded
    // before any module loads and the stream advances across trials, so N
    // trials are N reproducible draws.
    //
    // Three conditions, because "the TTK" is not one number:
    //
    //   held      the shipping condition. Aim set once at the chest, trigger
    //             held. Recoil and bloom both push rounds off the target.
    //   tracked   recoil zeroed and the chest re-acquired every tick, spread
    //             live. What a player who perfectly compensates recoil gets.
    //             Monotonicity is asserted here.
    //   perfect   as tracked, with the spread terms patched to zero. Every
    //             round lands centre of mass, so this is the pure ballistic
    //             TTK: shot interval times (shots-to-kill - 1).
    //
    // The decomposition is the finding. The baseline attributed the far-range
    // failure to recoil climb; with recoil perfectly compensated the gun still
    // cannot kill at 80 m, because bloom alone opens the cone to ~0.03 rad of
    // sustained fire, which is 2.4 m of scatter radius at that range.
    //
    // 200 m is in the list only because the research has a target that needs it:
    // damage.m4a1_mw2019_stk_min_range and ttk_min_range are both stated for a
    // range PAST the minimum-damage stop, and this game's floor does not arrive
    // until 150 m. 120 m is still on the near side of it.
    const RANGES = [10, 25, 45, 80, 120, 200];
    const TTK = { held: {}, tracked: {}, perfect: {} };
    let maxDrift = 0;
    {
      /** One engagement. Returns TTK, rounds fired, rounds landed. */
      async function engage(R, cond) {
        const aim = await placeTarget(R, { health: 100 });
        if (!aim.clear) return { blocked: true };
        const rows = await sim.drive({
          // 2.6 s is one magazine plus a margin: 30 rounds at 79 ms is 2.37 s.
          // A kill that needs a reload is reported as "not within a magazine"
          // rather than folded into the median, because it is a different event.
          seconds: 2.6, dt: DT, sample: SAMPLE_ENEMY,
          // No holdover here, deliberately, unlike the falloff sweep: these
          // conditions model players, and "compensates recoil perfectly" is a
          // different claim from "knows the ballistic drop table". If a build
          // with travel time loses kills at 120 m to drop, that is a result
          // about the build, not a gap in the instrument.
          input: cond === 'held' ? IN({ fire: true, ads: true }) : aimBody({}),
        });
        const dmg = await damageEvents();
        const first = rows.findIndex((r) => r.ammo < 30);
        const dead = rows.findIndex((r) => r.ealive === 0);
        maxDrift = Math.max(maxDrift, ...rows.map((r) => r.edrift ?? 0));
        return {
          ttk: dead >= 0 && first >= 0 ? rows[dead].t - rows[first].t : Infinity,
          stk: dead >= 0 ? 30 - rows[dead].ammo : Infinity,
          landed: dead >= 0 ? dmg.filter((d) => d.t <= rows[dead].t).length : dmg.length,
          fired: roundCount(rows),
          hpLeft: dead >= 0 ? 0 : rows[rows.length - 1].ehp,
          zones: dmg.map((d) => d.zone),
          cone: rows[Math.min(rows.length - 1, first + 1)]?.spread ?? NaN,
          // Per-engagement body damage, so the shots-to-kill cross-check below
          // compares a count against the damage measured at exactly the same
          // range in exactly the same engagement, rather than interpolating the
          // 10 m-spaced sweep — 45 m is the falloff knee and reading it off the
          // 50 m sample turns a passing cross-check into a phantom failure.
          bodyAmount: median(dmg.filter((d) => d.zone === 'body').map((d) => d.amount)),
        };
      }

      // Trial counts chosen by cost: an engagement is ~0.6 s of wall clock.
      // 'tracked' carries the monotonicity assertion and gets the most samples;
      // 'perfect' is nearly deterministic (only the 0.0004 rad floor varies)
      // and needs few.
      const PLAN = [['tracked', 12], ['held', 6], ['perfect', 4]];
      for (const [cond, trials] of PLAN) {
        if (cond === 'perfect') await zeroSpread();
        for (const R of RANGES) {
          const runs = [];
          for (let k = 0; k < trials; k++) runs.push(await engage(R, cond === 'held' ? 'held' : 'tracked'));
          TTK[cond][R] = runs;
        }
        if (cond === 'perfect') await popSpec();
      }

      // Guards before any number is quoted.
      const allRuns = Object.values(TTK).flatMap((byR) => Object.values(byR).flat());
      report.check('every TTK engagement had a clear shot at the body',
        allRuns.every((r) => !r.blocked),
        `${allRuns.filter((r) => r.blocked).length} of ${allRuns.length} engagements were blocked by `
        + `geometry down a ${f2(lane.clear)} m lane`);
      report.check('the TTK targets held still',
        maxDrift < 0.25,
        `max drift from the spawn point across ${allRuns.length} engagements ${f4(maxDrift)} m — a target `
        + 'that repositioned would be an AI measurement wearing a ballistics label');

      const summarise = (runs) => {
        const ttks = runs.map((r) => r.ttk);
        const kills = runs.filter((r) => Number.isFinite(r.ttk));
        return {
          n: runs.length, kills: kills.length,
          med: median(ttks), p16: quantile(ttks, 0.16), p84: quantile(ttks, 0.84),
          stkMed: median(runs.map((r) => r.stk)),
          landedMed: median(runs.map((r) => r.landed)),
          firedMed: median(runs.map((r) => r.fired)),
          hpLeft: median(runs.filter((r) => !Number.isFinite(r.ttk)).map((r) => r.hpLeft)),
          heads: runs.reduce((s, r) => s + r.zones.filter((z) => z === 'head').length, 0),
          limbs: runs.reduce((s, r) => s + r.zones.filter((z) => z === 'limb').length, 0),
          cone: median(runs.map((r) => r.cone)),
          dmg: median(runs.map((r) => r.bodyAmount).filter(Number.isFinite)),
          best: Math.min(...ttks),
          bestStk: Math.min(...runs.map((r) => r.stk)),
          distinct: new Set(ttks.map((v) => v.toFixed(4))).size,
        };
      };
      const S = {};
      for (const cond of Object.keys(TTK)) {
        S[cond] = Object.fromEntries(RANGES.map((R) => [R, summarise(TTK[cond][R])]));
      }

      // The distribution has to be a distribution. If every trial at every
      // range returned the same value, the seeded stream is not advancing
      // between trials and the median/spread below are one sample wearing a
      // statistic's clothes.
      const distinctTotal = RANGES.reduce((s, R) => s + S.tracked[R].distinct, 0);
      report.check('the TTK measurement samples a distribution rather than one run',
        distinctTotal > RANGES.length,
        `${distinctTotal} distinct TTK values across ${RANGES.length} ranges x `
        + `${S.tracked[10].n} tracked trials (`
        + RANGES.map((R) => `${R}m:${S.tracked[R].distinct}`).join(' ') + ')');

      for (const cond of ['held', 'tracked', 'perfect']) {
        for (const R of RANGES) {
          const s = S[cond][R];
          // No per-range sourced TTK target exists: the research states TTK
          // inside the max-damage range and past the min-damage range, not a
          // curve, so those two are asserted at the end of the section against
          // the 'perfect' condition. These rows are the distribution itself.
          const detail =
            `median ${Number.isFinite(s.med) ? ms(s.med) : `no kill in a magazine (${f2(s.hpLeft)} HP left)`}, `
            + `16-84% ${Number.isFinite(s.p16) ? ms(s.p16) : 'inf'}..${Number.isFinite(s.p84) ? ms(s.p84) : 'inf'}, `
            + `${s.kills}/${s.n} engagements killed, median ${Number.isFinite(s.stkMed) ? s.stkMed : 'inf'} `
            + `rounds fired and ${s.landedMed} landed per kill, `
            + `${s.heads} head / ${s.limbs} limb hits across the set, cone at the first round `
            + `${f4(s.cone * DEG * 2)} deg`;
          // The assertion is on the median engagement resolving, not on every
          // one of them. Both statements are worth making but only this one is
          // stable: at 25 m with the trigger held the per-engagement kill
          // probability is around 0.85, so "all 6 killed" flips between runs of
          // the suite whenever anything upstream shifts the position of the
          // seeded random stream, and a check that flips teaches its reader to
          // ignore it. The strict "every engagement" version is made once,
          // below, over all of them, where it is red for a reason that does not
          // move. The rate is in the detail either way.
          report.check(`TTK ${cond} at ${R} m`, Number.isFinite(s.med), detail);
        }
      }

      // The strict statement, once. A gun that cannot reliably kill a
      // stationary, unaware target down an open lane inside one magazine has a
      // range at which it stops being a weapon, and this prints where.
      const rates = [];
      for (const cond of ['held', 'tracked', 'perfect']) {
        for (const R of RANGES) rates.push(`${cond} ${R}m ${S[cond][R].kills}/${S[cond][R].n}`);
      }
      const allKilled = ['held', 'tracked', 'perfect']
        .every((c) => RANGES.every((R) => S[c][R].kills === S[c][R].n));
      report.check('every engagement killed within one magazine', allKilled,
        `${rates.join(', ')} — a magazine is 30 rounds over ${ms(30 * 60 / (SPEC?.rpm ?? 780))}`);

      // Monotonicity, on the median of the tracked distribution. It currently
      // breaks between 25 m and 45 m: with the cone live, a 45 m burst has more
      // rounds in flight before the third one lands and one of them finds the
      // head at x2.6, killing in two. That is a real defect — a target further
      // away must not die sooner — and asserting it on a median rather than on
      // one run is what stops it being dismissed as a stray round.
      /** Indices where a series drops, for a monotonicity detail string. */
      const fallsIn = (series, fmt) => {
        const out = [];
        for (let i = 1; i < series.length; i++) {
          if (series[i] < series[i - 1] - 1e-9) {
            out.push(`${RANGES[i - 1]}->${RANGES[i]} m: ${fmt(series[i - 1])} -> ${fmt(series[i])}`);
          }
        }
        return out;
      };

      for (const cond of ['held', 'tracked', 'perfect']) {
        const meds = RANGES.map((R) => S[cond][R].med);
        const breaks = fallsIn(meds, ms);
        report.check(`median TTK never falls as range grows (${cond})`, breaks.length === 0,
          `medians ${RANGES.map((R, i) => `${R}m ${Number.isFinite(meds[i]) ? ms(meds[i]) : 'no kill'}`).join(' | ')}`
          + (breaks.length ? `; falls at ${breaks.join(', ')}` : '; non-decreasing'));

        const stks = RANGES.map((R) => S[cond][R].stkMed);
        const sBreaks = fallsIn(stks, (v) => String(v));
        report.check(`median shots-to-kill never falls as range grows (${cond})`, sBreaks.length === 0,
          `median rounds fired per kill ${RANGES.map((R, i) => `${R}m ${stks[i]}`).join(' | ')}`
          + (sBreaks.length ? `; falls at ${sBreaks.join(', ')}` : '; non-decreasing'));

        // The median is the right statistic for "is the gun monotone", but it
        // hides the lottery, and the lottery is what the baseline actually saw:
        // a single 45 m run killed in 79 ms / 2 rounds because one spread round
        // found the head at x2.6, which is faster than any 10 m body kill can
        // be. So the best case is asserted separately. A shooter where a longer
        // shot can resolve faster than a shorter one — for any reason other than
        // the player's own aim — is non-monotone whatever the median says.
        //
        // This one check is a sampled lottery and will go red or green depending
        // on whether a stray headshot landed in this run's draws — which also
        // move when a suite that sorts before this one consumes seeded random
        // numbers first. That is a property of the defect, not sloppiness in the
        // check: the printed table is the measurement, and a green line here
        // means "no stray headshot in N engagements", not "cannot happen".
        const bests = RANGES.map((R) => S[cond][R].best);
        const bBreaks = fallsIn(bests, ms);
        report.check(`best-case TTK never falls as range grows (${cond})`, bBreaks.length === 0,
          `fastest of ${S[cond][RANGES[0]].n} engagements per range `
          + `${RANGES.map((R, i) => `${R}m ${Number.isFinite(bests[i]) ? ms(bests[i]) : 'no kill'} `
            + `(${S[cond][R].bestStk} rounds)`).join(' | ')}`
          + (bBreaks.length
            ? `; falls at ${bBreaks.join(', ')} — a stray round into the x2.6 head zone beats a `
              + 'centre-mass kill at any shorter range'
            : '; non-decreasing'));
      }

      // Cross-check: the ballistic shots-to-kill implied by the measured damage
      // curve against the shots-to-kill measured in the 'perfect' condition.
      // Two independent instruments — the applyDamage amount and a counted
      // engagement — reading the same property. Agreement is what licenses the
      // rest of the section.
      //
      // Counted against rounds *landed*, not rounds fired. Under hitscan the two
      // are the same number, but the moment travel time exists the trigger has
      // already sent the next round or two downrange before the fatal one
      // arrives — a projectile shim made this check red at 80 m with 5 fired
      // against 4 landed, which is the gun working correctly and the instrument
      // counting the wrong thing. Rounds fired is still reported beside it,
      // because that is the number the player pays for.
      const implied = RANGES.map((R) => {
        const d = S.perfect[R].dmg;
        return Number.isFinite(d) ? Math.ceil(100 / d) : NaN;
      });
      const measuredStk = RANGES.map((R) => S.perfect[R].landedMed);
      const agree = implied.every((v, i) => Number.isFinite(v) && v === measuredStk[i]);
      report.check('counted shots-to-kill matches the damage curve', agree,
        RANGES.map((R, i) => `${R}m ${f2(S.perfect[R].dmg)} HP/round implies ${implied[i]}, counted `
          + `${measuredStk[i]}`).join('; ')
        + ' (implied = ceil(100 HP / measured body damage), counted = rounds that landed in the '
        + 'spread-neutralised engagement)');

      // What the two compensated conditions cost, as a single number: how much
      // of the far-range failure is recoil and how much is bloom. This is the
      // line that corrects the baseline's attribution.
      const hit80 = S.tracked[80], held80 = S.held[80], perf80 = S.perfect[80];
      report.check('recoil compensation alone makes 80 m winnable',
        hit80.kills === hit80.n,
        `at 80 m: trigger held ${held80.kills}/${held80.n} kills (${f2(held80.hpLeft)} HP left), `
        + `recoil compensated ${hit80.kills}/${hit80.n} (${f2(hit80.hpLeft)} HP left, `
        + `${hit80.landedMed} of ${hit80.firedMed} rounds landing), spread also neutralised `
        + `${perf80.kills}/${perf80.n} at ${ms(perf80.med)} — so the far-range failure survives `
        + `perfect recoil compensation and is bloom: the cone is already `
        + `${f4(hit80.cone * DEG * 2)} deg at the first round and keeps opening`);

      /* ---- against the research ---------------------------------------- */
      //
      // Everything here is asserted against the 'perfect' condition, because
      // that is the only one that measures the WEAPON: 'held' and 'tracked' both
      // fold in the spread and recoil systems, and a published CoD shots-to-kill
      // figure is a statement about damage per bullet against 100 HP, not about
      // how well the gun can be held on target. The recoil and bloom failures
      // are already red above on their own terms.
      //
      // Health first: every shots-to-kill figure in the research is against
      // 100 HP, so if this game's soldier had 150 the whole comparison would be
      // wrong in a way no TTK row would reveal.
      //
      // Read off a freshly spawned soldier with the health override deliberately
      // omitted — ai.js does not export CONFIG, and every other spawn in this
      // file passes an explicit health, so asking one of those would have made
      // the check assert this test's own argument back at itself.
      await placeTarget(10, { health: undefined });
      const enemyHealth = await sim.eval(() => window.__GAME.director.enemies[0]?.health ?? null);
      against('enemy health', 'damage.health_mw2019', enemyHealth, ' HP');

      const nearR = RANGES[0], farR = RANGES[RANGES.length - 1];
      against('shots to kill inside the max-damage range',
        'damage.m4a1_mw2019_stk_max_range', S.perfect[nearR].landedMed, ' shots');
      against('shots to kill past the min-damage range',
        'damage.m4a1_mw2019_stk_min_range', S.perfect[farR].landedMed, ' shots');
      against('TTK inside the max-damage range',
        'damage.m4a1_mw2019_ttk_max_range', S.perfect[nearR].med, ' s');
      against('TTK past the min-damage range',
        'damage.m4a1_mw2019_ttk_min_range', S.perfect[farR].med, ' s');
      // Two independent cross-title readings of the same close-range number, so
      // a reader cannot dismiss the gap as one wiki's arithmetic. The BO6 entry
      // is the FASTEST full-auto AR in that game — nothing in the sourced set
      // kills faster than it, so a measurement below it is a measurement below
      // the whole genre.
      against('TTK against the MW3 assault-rifle class average',
        'damage.ar_mw3_typical_ttk', S.perfect[nearR].med, ' s');
      against('TTK against the fastest full-auto AR in the sourced set',
        'damage.bo6_fastest_full_auto_assault_rifle_ttk', S.perfect[nearR].med, ' s');
      against('TTK against the BO6 assault-rifle class band',
        'damage.bo6_average_assault_rifle_ttk', S.perfect[nearR].med, ' s');
    }

    /* ============================================ sourcing manifest ==== */
    //
    // Printed as a check so it cannot be dropped from the output, and so a
    // reviewer auditing this suite for invented Call of Duty numbers can read
    // every target it used, with its key, tolerance, confidence and URL, without
    // opening the file. The two thresholds in this suite that are NOT sourced —
    // the 0.02 m drop floor and the plateau count that decides banded-vs-smooth —
    // are named here as well, because an unsourced threshold that hides is the
    // same problem as an invented target.
    {
      const uniq = [...new Set(USED)];
      report.check('every target asserted here comes from targets.mjs', uniq.length > 0,
        (TARGETS
          ? `${uniq.length} sourced targets used: ${uniq.join(' || ')}`
          : 'targets.mjs is absent, so no sourced target was used and every quantity above is reported '
            + 'as a bare measurement')
        + ` || UNSOURCED THRESHOLDS OWNED BY THIS SUITE: drop floor 0.02 m at 150 m (a physics bound — `
        + `any projectile under ~2300 m/s drops further than that, and it is ~4x the instrument's own `
        + `standard error); banded-vs-smooth cut at <= max(4, ranges/4) distinct plateaus (a shape `
        + `discriminator, not a magnitude)`);
      if (missing) {
        const mine = ['bullet_velocity', 'bullet_drop', 'penetration', 'damage_falloff', 'ttk_ranges'];
        const gaps = missing().filter((m) => mine.includes(m));
        report.check('this domain has no research blind spots', gaps.length === 0,
          gaps.length
            ? `no sourced target at all for: ${gaps.join(', ')}`
            : `all ${mine.length} scope items in this domain (${mine.join(', ')}) have at least one `
              + 'externally sourced target');
      }
    }
  } finally {
    // Whatever happened: no patched constant and no injected collider may
    // outlive this suite. It runs first of the three, so a leak here reads as a
    // bug in movement or weapon.
    await restoreSpec().catch(() => {});
    await sim.eval(() => window.__BALL?.dropPlates?.()).catch(() => {});
  }
}
