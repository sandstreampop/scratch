// Ballistics, damage, penetration and time-to-kill.
//
// This is the suite for what happens between the trigger and the corpse: how
// long the round takes to arrive, where it arrives, what it goes through, how
// much it takes off, and how many of them a kill costs at range.
//
// Six conventions run through the file and every one of them was arrived at by
// getting the measurement wrong first.
//
//   Rounds are ammo decrements; damage is an applyDamage call. weapon.fire() is
//   polled every tick the trigger is held and returns null on most of them, so
//   `weapon.fire` events count polls, not rounds. The muzzle instant used here
//   is the audio.gunshot tap, which playerShoot() reaches only after fire() has
//   actually produced a shot, and every timing derived from it is cross-checked
//   against the ammo trace before it is quoted.
//
//   The applyDamage tap carries the numbers. _sim.mjs records string and number
//   arguments, and main.js calls applyDamage(amount, zone, direction, zoneMult)
//   with the post-falloff, post-penetration damage, the zone, and the zone
//   multiplier it wants applied. So `amount` is what range and cover did to the
//   round, args[3] is what the shooter asked the zone to be worth, and
//   healthDelta/amount is what the target actually applied. Those last two being
//   different numbers is a finding, not a rounding error, and it has its own
//   check.
//
//   Aim is forced, not hoped for. Recoil, bloom and flinch all pull rounds off a
//   distant chest, and a damage-versus-range curve measured through them is a
//   curve of luck. Where a section is about range it re-points the player at the
//   target every tick and zeroes the recoil spring, which is the limit of what a
//   player re-aiming between rounds could do; where a section is about whether
//   the gun can be fought, it does not, and says which condition it ran.
//
//   Rounds have travel time, so every burst is followed by a second of quiet
//   trace. A window that closes with the trigger reports the rounds still in the
//   air as misses, which reads as a range the gun cannot hurt rather than a range
//   the instrument failed to wait for.
//
//   Spread is neutralised by patching the SPEC spread terms to zero, not by
//   assuming. currentSpread() then still floors at 0.0004 rad — 0.08 m of
//   scatter radius at 200 m — so every quantity measured that way is a median
//   over many rounds and the residual scatter is printed beside it. A single
//   round is not a measurement of anything here.
//
//   Every probe proves it can see the effect before its silence is quoted. The
//   penetration section fires the same burst through open air; the drop section
//   confirms the plate caught the rounds; the travel-time section confirms it
//   counted the right number of rounds. "Nothing got through" and "I measured
//   nothing" are the same reading otherwise, and last session the second one was
//   reported as the first.
//
// Sourced targets reach this file through report.against(name, measured, domain,
// key) and nowhere else, so the target, its unit and its tolerance all come from
// targets.mjs and an unknown key throws instead of degrading into a cheerful "no
// target yet". Quantities with no published reference are report.measure(), which
// prints and is counted separately from the pass rate.
//
// THE THRESHOLDS THIS SUITE OWNS, none of them a Call of Duty figure:
//   - 0.02 m of drop at 150 m as the floor for "drop exists". Any projectile
//     under ~2300 m/s drops further than that under the game's own gravity, and
//     it is about 4x the instrument's own standard error, so a pass cannot be
//     manufactured by scatter. Scaled by range^2 for the shorter shots.
//   - half a tick as the cut between "instant" and "flown". The quantity is
//     quantised to the tick by construction, so this is the only honest cut.
//   - 2% as the agreement band for two readings of one physical quantity
//     (applied damage against health delta; flat penetration across path
//     lengths).

const DEG = 180 / Math.PI;

// 1/120 everywhere. The simulation advances in fixed 1/60 s ticks, so nothing
// measurable happens between two of them and a finer dt only buys duplicate
// rows; 1/120 samples every tick twice, which is enough to see the boundary a
// timing is quantised to without doubling the wall clock of the suite.
const DT = 1 / 120;

export const NAME = 'ballistics';

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
 * That is not cheating around a bug, it is the isolation a range measurement
 * requires: main.js integrates recoil in player.update() and only then calls
 * playerShoot(), so a spring zeroed on the tick boundary leaves aim = pitch
 * exactly at the instant the round leaves. It is the limit of a player re-aiming
 * between rounds, and the uncompensated condition is measured separately.
 *
 * `elevate` is holdover, in radians, added to the pitch that points at the mark.
 * Rounds fall, so a sweep that aimed dead at the chest at 200 m would be
 * measuring the ground.
 *
 * `fireWhile` is an expression evaluated in the page each tick, used where a
 * section needs a counted burst followed by silence rather than a held trigger.
 * Counted off ammo, which is the only reliable round counter.
 *
 * Nothing here declares t/i/g/sim: those are the compiled body's parameters and
 * shadowing them is a SyntaxError inside the page, which surfaces as a suite
 * that throws rather than a check that fails.
 */
function aimBody({ mark = 'chest', compensate = true, fire = true, fireWhile = null, elevate = 0 } = {}) {
  const marker = mark === 'head' ? 'eyePosition' : 'chestPosition';
  const hold = elevate ? ` + (${elevate})` : '';
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
const finite = (a) => a.filter(Number.isFinite);

const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : String(v));
const f4 = (v) => (Number.isFinite(v) ? v.toFixed(4) : String(v));
const ms = (v) => (Number.isFinite(v) ? `${(v * 1000).toFixed(1)} ms` : String(v));

/** Least-squares fit of y on x: slope, intercept and RMS residual. */
function fitLine(xs, ys) {
  const mx = mean(xs), my = mean(ys);
  const sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const resid = Math.sqrt(mean(ys.map((y, i) => (y - (intercept + slope * xs[i])) ** 2)));
  return { slope, intercept, resid };
}

/* --------------------------------------------------------------- suite -- */

export default async function run(sim, report) {
  /**
   * The note a qualitative target carries.
   *
   * report.against refuses a target with no machine tolerance, which is right —
   * asserting one numerically would mean inventing the threshold. The behaviour
   * such a target describes is asserted with check() instead, and the note is
   * quoted into the detail so a reader can see what the check stands in for.
   */
  const sourcedNote = (domain, key) => {
    const entry = report.targets?.TARGETS?.[domain]?.[key];
    if (!entry) throw new Error(`no ${domain}.${key} in targets.mjs to quote`);
    return String(entry.note ?? entry.value).slice(0, 240);
  };

  // SPEC is read out of the running page rather than imported here, so it is the
  // object the game is using — and so a liveness probe can mutate it and watch
  // whether the behaviour follows. Nothing in this file derives an expectation
  // from it.
  const SPEC = await sim.eval(async () => {
    const m = await import('/src/weapon.js');
    return JSON.parse(JSON.stringify(m.SPEC));
  });
  report.check('weapon SPEC is reachable through the running page', !!SPEC,
    `rpm ${SPEC.rpm}, range ${SPEC.range} m; the damage block it still carries (damage ${SPEC.damage}, `
    + `falloff ${SPEC.falloffStart}..${SPEC.falloffEnd} m to x${SPEC.falloffScale}, headshotMultiplier `
    + `${SPEC.headshotMultiplier}) is not what the game reads any more`);

  // The game's own gravity, used only to turn a measured drop into an implied
  // muzzle velocity. Read live because it is about twice standard gravity, and a
  // reader comparing the drop-implied velocity with the travel-time-implied one
  // needs to know which constant went into the sum.
  const gravity = await sim.eval(async () => (await import('/src/player.js')).TUNING.gravity);
  report.check('the gravity used to interpret drop was read from the game',
    Number.isFinite(gravity) && gravity > 0,
    `TUNING.gravity = ${gravity} m/s^2 (about twice standard gravity, so a drop-implied velocity `
    + 'computed with 9.81 would be out by a factor of sqrt(2))');

  /* ---- page-side probes ------------------------------------------------- */
  //
  // Two things the sim API does not expose and this file needs: where a round
  // actually landed, and a collider that was not in the level. Both are
  // installed by hand and both are torn down in the finally block — the impact
  // taps as well as the plates. A previous version of this file left those
  // wrappers installed, which silently changed what every later suite could see
  // in the shared event log, and a shared-state bug between instruments is the
  // hardest kind of wrong number to find.
  await sim.eval(() => {
    const g = window.__GAME;
    if (window.__BALL) return;
    window.__BALL = { impacts: [], added: [], originals: [] };
    // vfx.impact / vfx.bloodBurst are the only callers that see the resolved
    // world point. The tap in _sim.mjs records these calls but maps object
    // arguments to null, so the point has to be captured here. __tapped is set so
    // a later sim.tapEvents() does not wrap the wrapper and double every vfx
    // event in the shared log.
    const wrap = (obj, name, surfaceOf) => {
      const original = obj[name];
      const bound = original.bind(obj);
      const w = (point, ...rest) => {
        const cam = g.camera.position;
        window.__BALL.impacts.push({
          x: point.x, y: point.y, z: point.z, t: g.elapsed,
          ex: cam.x, ey: cam.y, ez: cam.z, surface: surfaceOf(rest),
        });
        return bound(point, ...rest);
      };
      w.__tapped = true;
      obj[name] = w;
      window.__BALL.originals.push([obj, name, original]);
    };
    wrap(g.vfx, 'impact', (rest) => rest[1] ?? 'world');
    wrap(g.vfx, 'bloodBurst', () => 'flesh');
    window.__BALL.untap = () => {
      for (const [obj, name, original] of window.__BALL.originals) obj[name] = original;
      window.__BALL.originals.length = 0;
    };

    /** Adds a collider to the list the rounds are actually resolved against. */
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

  const spreadKeys = ['spreadHip', 'spreadMoving', 'spreadPerShot', 'spreadMax'];
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

  // A lane long enough for a 200 m target. clearLane reports need+20 when nothing
  // is in the way, so 230 from a request of 210 means "open past the
  // measurement"; anything less and every long-range number below would be a
  // measurement of a wall. The heading is a world direction (sin, cos) and the
  // player's forward is (-sin yaw, -cos yaw), so the yaw down the lane is the
  // heading plus half a turn.
  const HOME = [-6, null, 17];
  const lane = await sim.clearLane(HOME, 210);
  const laneA = lane.deg * Math.PI / 180;
  const laneYaw = laneA + Math.PI;
  const LX = Math.sin(laneA), LZ = Math.cos(laneA);
  report.check('a firing lane long enough for a 200 m target exists', lane.clear > 205,
    `heading ${lane.deg} deg from [${HOME[0]}, ground, ${HOME[2]}] is unobstructed for `
    + `${f2(lane.clear)} m (the probe asked for 210 and caps at 230)`);

  const at = (R) => ({ x: HOME[0] + LX * R, z: HOME[2] + LZ * R });

  /**
   * Puts a stationary target at range R and points the player at its chest.
   *
   * Returns aimAt's verdict. Callers must branch on `.clear`: a shot that cannot
   * reach the body makes every miss below a wall rather than the game.
   *
   * `health: null` means "spawn it with whatever health the AI gives it", which
   * is how the health check reads CONFIG.health instead of reading back the
   * number this file just wrote. Passing `health: undefined` does NOT do that —
   * it triggers the destructuring default and the check then asserts this test's
   * own argument against the research, which is exactly what a critic caught it
   * doing.
   */
  async function placeTarget(R, { health = 100, ads = 1, ammo = 30 } = {}) {
    const p = at(R);
    await sim.setup({
      position: HOME, yaw: laneYaw, ads, ammo,
      enemies: [{ x: p.x, z: p.z, inert: true, ...(health === null ? {} : { health }) }],
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

  /** applyDamage calls in order: post-falloff amount, zone, passed multiplier. */
  async function damageEvents() {
    const ev = await sim.events();
    return ev.filter((e) => e.kind === 'enemy.applyDamage')
      .map((e) => ({ t: e.sim, amount: e.args[0], zone: e.args[1], passedMult: e.args[3] }));
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
   * on the very first tick and rows[0] already shows 29. Counting only row-to-row
   * differences lost that round and made every section report one more damage
   * event than rounds fired, which is what a broken pairing looks like. Stops at
   * an ammo increase: that is the reload, and rounds after it belong to a
   * different magazine.
   */
  const roundCount = (rows, start = 30) => {
    let n = 0, prev = start;
    for (const r of rows) {
      if (r.ammo < prev) { n += prev - r.ammo; prev = r.ammo; } else if (r.ammo > prev) break;
    }
    return n;
  };

  try {
    /* ============================================ 1. the fixed tick ==== */
    //
    // Everything else in this file is quantised by this, so it is measured first.
    // The simulation advances in fixed steps and banks the remainder, so
    // g.elapsed moves in one quantum whatever dt the harness hands step(). The
    // tick rate is read off that quantum and not off any constant.
    let tickLength = NaN;
    {
      await sim.setup({ position: HOME, yaw: laneYaw, ads: 1 });
      // Deliberately a dt that divides no plausible tick evenly, driven for a
      // whole second: a step size that fitted the tick could not tell a fixed
      // tick from an integrator that happened to agree with one.
      const rows = await sim.drive({ seconds: 1.0, dt: 1 / 237, input: IN() });
      const steps = [];
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].t > rows[i - 1].t + 1e-12) steps.push(rows[i].t - rows[i - 1].t);
      }
      const span = rows[rows.length - 1].t - rows[0].t;
      const hz = steps.length / span;
      tickLength = median(steps);
      report.check('simulated time advances in one fixed quantum',
        steps.length > 10 && Math.max(...steps) - Math.min(...steps) < 1e-9,
        `${steps.length} advances over ${f3(span)} s driven at 1/237 s per call, quantum `
        + `${ms(tickLength)} (spread ${(1e9 * (Math.max(...steps) - Math.min(...steps))).toFixed(1)} ns) — `
        + `a simulation stepped at the caller's dt would advance by ${ms(1 / 237)} on every call`);
      report.against('simulation tick rate', hz, 'physics', 'multiplayer_server_tick_rate');

      // And the consequence a player cares about, on this suite's own quantity:
      // the same engagement at 30 Hz and at 144 Hz has to resolve identically.
      // Movement asserts this for the jump and the sprint; a round has its own
      // integrator and could be frame-rate dependent while the legs are not.
      // Measured off the EVENT timestamps and not off the sample rows. A trace
      // driven at 1/30 samples every other tick, so the row a shot first shows up
      // in can be a tick later than the tick it left on, and comparing row times
      // across two dts measures the sampling grid rather than the simulation. The
      // taps carry g.elapsed at the instant of the call, which is the same clock
      // at every frame rate.
      const same = [];
      for (const dt of [1 / 30, 1 / 144]) {
        await zeroSpread();
        const aim = await placeTarget(80, { health: 100 });
        await sim.drive({
          seconds: 2.0, dt, sample: SAMPLE_ENEMY, input: aimBody({ elevate: 0.0014 }),
        });
        const dmg = await damageEvents();
        const shots = await gunshotTimes();
        await popSpec();
        same.push({
          hz: 1 / dt,
          clear: aim.clear,
          ttk: dmg.length && shots.length ? dmg[dmg.length - 1].t - shots[0] : Infinity,
          flight: dmg.length && shots.length ? dmg[0].t - shots[0] : Infinity,
          dealt: dmg.reduce((s, d) => s + d.amount, 0),
          hits: dmg.length,
        });
      }
      const [a, b] = same;
      report.check('the same engagement resolves identically at 30 and 144 fps',
        a.clear === true && b.clear === true && a.hits === b.hits
        && Math.abs(a.ttk - b.ttk) < 1e-9 && Math.abs(a.dealt - b.dealt) < 1e-9
        && Math.abs(a.flight - b.flight) < 1e-9,
        `80 m, spread neutralised: 30 Hz killed in ${ms(a.ttk)} with ${f2(a.dealt)} HP over ${a.hits} hits `
        + `and ${ms(a.flight)} of flight on the first round, 144 Hz ${ms(b.ttk)} with ${f2(b.dealt)} HP over `
        + `${b.hits} hits and ${ms(b.flight)} (kill time differs by ${ms(Math.abs(a.ttk - b.ttk))}, damage `
        + `by ${f4(Math.abs(a.dealt - b.dealt))} HP, flight by ${ms(Math.abs(a.flight - b.flight))})`);
    }
    const HALF_TICK = tickLength / 2;

    /* ================================== 2. travel time and velocity ==== */
    //
    // The delay between the round leaving the gun and the damage landing, at five
    // ranges. Muzzle instant is the audio.gunshot tap, which playerShoot()
    // reaches only after weapon.fire() has produced a shot; impact instant is the
    // applyDamage tap. Both carry g.elapsed, so the difference is simulated time
    // and owes nothing to the harness's own latency.
    //
    // 25 m is in the list to be instant and the rest to be flown. That is the
    // sourced shape and not a compromise: a 20 Hz authority resolves anything
    // inside velocity/20 metres within one tick, so inside that radius travel
    // time does not exist, and outside it the round has to be led.
    const travel = [];
    let velocityFit = null;
    {
      await zeroSpread();
      for (const R of [25, 50, 100, 150, 200]) {
        const aim = await placeTarget(R, { health: 1e6 });
        if (!aim.clear || aim.zone !== 'body') {
          travel.push({ R, ok: false, why: `lane blocked or zone ${aim.zone} (clear=${aim.clear})` });
          continue;
        }
        // Seven rounds, then the trigger comes up and the trace keeps running.
        // The trailing time is what makes this able to see a slow bullet: at the
        // bottom of the sourced band a 200 m round is a third of a second in the
        // air, and a burst that ended when the firing did would report the last
        // rounds as misses and the whole range as unpaired. Seven rather than one
        // so a single stray zone does not leave the range with no sample. The
        // holdover is a coarse figure from the sourced velocity and the game's
        // gravity, refined by measurement in the section below — without any at
        // all a 200 m round lands 70 cm low and this section measures the ground.
        const rows = await sim.drive({
          seconds: 1.4, dt: DT, sample: SAMPLE_ENEMY,
          input: aimBody({ fireWhile: 'g.weapon.ammo > 23', elevate: 1.75e-5 * R }),
        });
        const shots = await gunshotTimes();
        const dmg = await damageEvents();
        const fired = roundCount(rows);
        // Pairing check first. If the number of muzzle events does not match the
        // number of ammo decrements, the muzzle instant is not the muzzle instant
        // and every delay below is measured between the wrong two events. This is
        // the check that lets a 0.0 ms result be believed.
        const paired = shots.length === fired && dmg.length >= Math.min(3, fired);
        // Paired by index, not by "the first damage event after this shot".
        // Rounds leave at one velocity down one line, so impacts arrive in firing
        // order — but with a projectile in flight, round 2's muzzle instant
        // precedes round 1's impact, and a nearest-event search hands round 2
        // round 1's arrival and reports a third of the true delay.
        const delays = [];
        for (let k = 0; k < Math.min(shots.length, dmg.length); k++) delays.push(dmg[k].t - shots[k]);
        travel.push({
          R, ok: true, paired, fired, shots: shots.length, hits: dmg.length,
          delay: median(delays), delays, dist: aim.distance,
          drift: Math.max(...rows.map((r) => r.edrift ?? 0)),
        });
      }
      await popSpec();

      const good = travel.filter((x) => x.ok);
      report.check('the travel-time probe paired every round with a muzzle event',
        good.length === 5 && good.every((x) => x.paired),
        good.map((x) => `${x.R} m: ${x.fired} rounds, ${x.shots} muzzle events, ${x.hits} damage events`)
          .join('; ') || 'no range produced a clear shot');

      const near = good.find((x) => x.R === 25);
      const flown = good.filter((x) => x.R >= 50);

      // Inside the instant-hit radius the delay must be exactly zero, not merely
      // small: the round is resolved inside the playerShoot() call, on the tick
      // the trigger broke.
      if (report.reached('the 25 m probe produced a delay to measure', near?.delay)) {
        report.check('a round inside the instant-hit radius arrives with no travel time',
          near.delay < HALF_TICK,
          `${ms(near.delay)} between muzzle and damage over ${near.delays.length} rounds at a measured `
          + `${f2(near.dist)} m, against a tick of ${ms(tickLength)}. `
          + `ballistics.instant_hit_range_formula_divisor: `
          + `"${sourcedNote('ballistics', 'instant_hit_range_formula_divisor')}"`);
      }

      for (const x of flown) {
        const v = x.dist / x.delay;
        report.check(`round travel time at ${x.R} m`, x.delay > HALF_TICK,
          `${ms(x.delay)} between the round leaving the gun and the damage landing over `
          + `${x.delays.length} rounds at a measured ${f2(x.dist)} m, one tick is ${ms(tickLength)}; `
          + `implied velocity ${Number.isFinite(v) ? `${f2(v)} m/s` : 'infinite — the round arrives on the '
            + 'tick it was fired'}`);
      }

      // A projectile has ONE muzzle velocity, so the flown ranges must lie on a
      // straight line in range against delay. The slope is that velocity, and it
      // is what a fudge that delays impacts by a constant cannot produce; the
      // intercept is where flight time reaches zero, which is the instant-hit
      // radius seen from the other side. Slope rather than range/delay per range
      // because arrival is quantised to the tick, and a tick is 12.5 m of flight
      // — a per-range ratio carries all of that quantisation while a slope over
      // 150 m of baseline carries a fraction of it.
      velocityFit = flown.length >= 3
        ? fitLine(flown.map((x) => x.delay), flown.map((x) => x.dist)) : null;
      report.check('travel time is consistent with a single muzzle velocity',
        !!velocityFit && velocityFit.resid < 3,
        velocityFit
          ? `range against delay over ${flown.map((x) => x.R).join('/')} m fits a line of slope `
            + `${f2(velocityFit.slope)} m/s with an RMS residual of ${f3(velocityFit.resid)} m, intercept `
            + `${f2(velocityFit.intercept)} m (per-range ratios `
            + `${flown.map((x) => f2(x.dist / x.delay)).join(' / ')} m/s, which each carry the `
            + `${f2(tickLength * velocityFit.slope)} m of flight one tick buys)`
          : `only ${flown.length} flown ranges produced a delay, so there is no line to fit`);

      report.check('the target held still while travel time was measured',
        good.length > 0 && good.every((x) => x.drift < 0.05),
        `max drift from the spawn point ${f4(Math.max(0, ...good.map((x) => x.drift)))} m over `
        + `${good.length} ranges — a target that walked would put its own motion inside the delay`);

      // The bullet model itself is a sourced boolean: every CoD from MW2019 onward
      // resolves rifle fire as a simulated projectile with travel time, not a
      // raycast. Measured as 1 only if every flown range showed a delay longer
      // than half a tick.
      const isProjectile = flown.length >= 3 && flown.every((x) => x.delay > HALF_TICK) ? 1 : 0;
      report.against('the bullet is a projectile rather than hitscan', isProjectile,
        'ballistics', 'bullet_model_is_projectile_not_hitscan');
      if (report.reached('a muzzle velocity could be fitted', velocityFit?.slope)) {
        report.against('muzzle velocity', velocityFit.slope,
          'ballistics', 'ar_muzzle_velocity_design_band');
        report.against('muzzle velocity against the MW3 MCW figure', velocityFit.slope,
          'ballistics', 'ar_muzzle_velocity_mcw_mw3_2023');
      }

      /* ---- where the round stops being instant ------------------------- */
      //
      // Bisected rather than read off a constant: the boundary is a behaviour, and
      // the point of the sourced formula is that it is a consequence of the
      // authority's tick rate rather than a number somebody typed. Six halvings of
      // 30..46 m resolve it to a quarter of a metre, well inside the +/-15 m the
      // perceptibility target carries.
      let lo = 30, hi = 46;
      const probes = [];
      const instantAt = async (R) => {
        const aim = await placeTarget(R, { health: 1e6 });
        if (!aim.clear) return null;
        const rows = await sim.drive({
          seconds: 0.6, dt: DT, sample: SAMPLE_ENEMY,
          input: aimBody({ fireWhile: 'g.weapon.ammo > 26' }),
        });
        const shots = await gunshotTimes();
        const dmg = await damageEvents();
        if (!shots.length || !dmg.length) return null;
        const delays = [];
        for (let k = 0; k < Math.min(shots.length, dmg.length); k++) delays.push(dmg[k].t - shots[k]);
        const d = median(delays);
        probes.push({ R: aim.distance, d });
        return { instant: d < HALF_TICK, dist: aim.distance, rounds: delays.length };
      };
      await zeroSpread();
      const loProbe = await instantAt(lo);
      const hiProbe = await instantAt(hi);
      let bisected = null;
      if (loProbe?.instant && hiProbe && !hiProbe.instant) {
        for (let i = 0; i < 6; i++) {
          const mid = (lo + hi) / 2;
          const p = await instantAt(mid);
          if (!p) break;
          if (p.instant) lo = mid; else hi = mid;
        }
        bisected = (lo + hi) / 2;
      }
      await popSpec();
      report.check('the instant-hit boundary was bracketed before it was bisected',
        !!loProbe?.instant && !!hiProbe && !hiProbe.instant,
        `30 m ${loProbe ? (loProbe.instant ? 'instant' : `${ms(probes[0]?.d)} of flight`) : 'unreachable'}, `
        + `46 m ${hiProbe ? (hiProbe.instant ? 'instant' : `${ms(probes[1]?.d)} of flight`) : 'unreachable'} `
        + `over ${probes.length} probes — without a bracket the bisection would converge on its own `
        + 'starting point');
      if (report.reached('the instant-hit boundary was located', bisected)) {
        report.against('the range past which a round stops arriving instantly', bisected,
          'ballistics', 'perceptible_travel_time_threshold');
        // The formula itself, as a derived quantity: velocity over the boundary
        // should recover the sourced divisor. Measured and not asserted because
        // the sourced divisor is exact (tolerance 0) while both inputs here are
        // quantised measurements — a bisection to a quarter of a metre cannot land
        // on 20 to zero tolerance, and pretending otherwise would be a check that
        // fails for being honest.
        // Guarded on finiteness, not just on presence. With gravity reverted the
        // 200 m round misses — the holdover assumes drop — the fit degenerates to
        // NaN, and report.measure rightly refuses it by throwing. That took the
        // run down at 15 of 21 checks and silently skipped the drop, penetration,
        // damage, zone and TTK sections, so a red-green cycle on this suite could
        // report 21 checks instead of 107 and look like a pass. The file already
        // learned this lesson at the falloff probe; it needed learning twice.
        if (velocityFit && Number.isFinite(velocityFit.slope) && bisected > 0) {
          report.measure('instant-hit divisor implied by velocity and the measured boundary',
            velocityFit.slope / bisected, 'Hz',
            `${f2(velocityFit.slope)} m/s over ${f2(bisected)} m; the sourced divisor is exactly 20 `
            + '(ballistics.instant_hit_range_formula_divisor) and the boundary is bisected to 0.25 m');
        }
      }
    }

    /* ============================ 2b. incoming fire is a projectile ==== */
    //
    // The same property, measured on the other shooter.
    // ballistics.bullet_model_is_projectile_not_hitscan is a statement about the
    // GAME's bullet model, and a build where the player's rounds fly and the
    // garrison's teleport satisfies it for exactly half the bullets in the fight.
    // The gameplay-ai suite carries the same target and reads 0 for it; its probe
    // fires from 9 m, which is inside this model's instant-hit radius by design,
    // so the flight it is looking for cannot exist there whatever main.js does.
    // Measured here instead, past the radius, where a projectile and a raycast
    // give different answers.
    //
    // Aim error is neutralised by calling director.onFire with a spread of zero
    // rather than by going through enemy.shoot(): CONFIG.aimErrorAngle alone puts
    // a 3 m radius circle on the target at 100 m, so an honest cone lands about
    // 2% of its rounds on a 0.64 x 1.8 m box and the section would be measuring
    // the AI's aim instead of the round's flight. It is the same neutralisation
    // zeroSpread() performs for the player, applied at the one hook the AI uses to
    // fire, and the ai suite is where the cone itself is measured.
    //
    // One round at a time, with the air cleared between them: with several rounds
    // in flight at once a health decrement cannot be attributed to a particular
    // muzzle instant, and pairing by index would break on the first miss.
    //
    // The arrival instant is taken from inside player.damage(), not by polling
    // health after each step: polling puts one whole tick of the observer's own
    // latency into every delay, which read 16.7 ms for a 25 m round that is
    // resolved inside the firing call and made the instant-hit radius look as
    // though it had moved.
    //
    // 120 m is the far anchor and not 200 m. The AI applies no holdover — it aims
    // at the eye and lets the round fall — so past about 130 m a level shot from a
    // 1.4 m muzzle puts the round into the ground before it reaches the player.
    // Measured: 0 of 6 rounds arrived at 150 m. That is the drop model working on a
    // shooter that does not compensate for it, which is a finding for the ai suite
    // to make about the AI's aim; this section is about whether the round flies.
    {
      await sim.eval(() => {
        const g = window.__GAME;
        window.__BALL.enemyFlight = (opts) => {
          const e = g.director.enemies[0];
          if (!e) return null;
          const dist = e.position.distanceTo(g.camera.position);
          const out = { dist, fired: 0, landed: 0, delays: [], flying: 0, worldDist: null };
          // The arrival instant, read from inside the call that applies it. Polling
          // g.player.health after each step cannot see a hit that happened during
          // the firing call and reports it a whole tick late.
          const damage0 = g.player.damage.bind(g.player);
          let hitAt = null;
          g.player.damage = (a) => { if (hitAt === null) hitAt = g.elapsed; return damage0(a); };
          const muzzle = new window.__THREE.Vector3();
          e.muzzleAnchor.updateWorldMatrix(true, false);
          muzzle.setFromMatrixPosition(e.muzzleAnchor.matrixWorld);
          const to = new window.__THREE.Vector3().subVectors(g.camera.position, muzzle);
          out.worldDist = window.__SIM.rayWorld(
            [muzzle.x, muzzle.y, muzzle.z], [to.x, to.y, to.z], dist + 20);
          try {
            for (let k = 0; k < opts.rounds; k++) {
              g.resetSimulation();
              hitAt = null;
              const t0 = g.elapsed;
              // spread 0: what is under test is the flight, not the aim.
              g.director.onFire(e, 0, dist);
              out.fired++;
              out.flying = Math.max(out.flying, g.projectiles.length);
              for (let i = 0; i < opts.ticks && hitAt === null; i++) g.step(g.tickLength);
              if (hitAt !== null) { out.landed++; out.delays.push(hitAt - t0); }
              // Where a round that never arrived ended up: 0 means it was resolved
              // against the world or ran out of range, which distinguishes "the
              // shot missed" from "the probe did not wait long enough".
              else out.stillFlying = (out.stillFlying ?? 0) + (g.projectiles.length ? 1 : 0);
            }
          } finally {
            g.player.damage = damage0;
          }
          return out;
        };
      });

      const incoming = [];
      for (const R of [25, 60, 90, 120]) {
        const p = at(R);
        await sim.setup({
          position: HOME, yaw: laneYaw, ads: 1, invulnerable: false, health: 1e6,
          enemies: [{ x: p.x, z: p.z, inert: true }],
        });
        const probe = await sim.eval((o) => window.__BALL.enemyFlight(o), { rounds: 6, ticks: 40 });
        incoming.push({ R, ...(probe ?? {}) });
      }
      // Restore the stub the rest of the file runs under: every section after this
      // one places a target with the default invulnerable:true, but leaving the
      // player shootable through a section boundary is the kind of shared state
      // that turns a later red into a mystery.
      await sim.setup({ position: HOME, yaw: laneYaw, ads: 1 });

      const landed = incoming.filter((x) => x.landed > 0);
      report.check('the incoming-fire probe landed rounds on the player to time',
        landed.length === incoming.length,
        incoming.map((x) => `${x.R} m: ${x.landed}/${x.fired} of ${f2(x.dist ?? NaN)} m rounds landed, `
          + `world clear to ${f2(x.worldDist ?? NaN)} m, ${x.stillFlying ?? 0} still airborne when the `
          + 'probe stopped waiting').join('; ')
        + ' — a probe that connects with nothing cannot tell a projectile from a raycast');

      const near = incoming.find((x) => x.R === 25);
      const flown = incoming.filter((x) => x.R >= 60 && x.landed > 0);
      for (const x of flown) {
        const d = median(x.delays);
        const v = x.dist / d;
        report.check(`incoming round travel time at ${x.R} m`, d > HALF_TICK,
          `${ms(d)} between the enemy's muzzle and the player's health dropping, over ${x.landed} rounds `
          + `from a measured ${f2(x.dist)} m; one tick is ${ms(tickLength)}, implied velocity `
          + `${Number.isFinite(v) ? `${f2(v)} m/s` : 'infinite — the round arrives on the tick it was fired'}`);
      }
      if (near && report.reached('the 25 m incoming probe produced a delay', median(near.delays))) {
        report.check('incoming fire inside the instant-hit radius still arrives instantly',
          median(near.delays) < HALF_TICK,
          `${ms(median(near.delays))} over ${near.landed} rounds at ${f2(near.dist)} m, against a tick of `
          + `${ms(tickLength)} — the radius is a property of the model and applies to both shooters, which `
          + 'is why the ai suite\'s 9 m probe reads zero however this is implemented');
      }
      // The same fit the player's rounds get, on the enemy's. A constant delay
      // bolted onto incoming damage would pass the per-range rows above and fail
      // this one.
      const inFit = flown.length >= 3
        ? fitLine(flown.map((x) => median(x.delays)), flown.map((x) => x.dist)) : null;
      report.check('incoming travel time is consistent with a single muzzle velocity',
        !!inFit && inFit.resid < 4,
        inFit
          ? `range against delay over ${flown.map((x) => x.R).join('/')} m fits a line of slope `
            + `${f2(inFit.slope)} m/s, RMS residual ${f3(inFit.resid)} m, intercept ${f2(inFit.intercept)} m`
          : `only ${flown.length} ranges landed a round, so there is no line to fit`);
      const enemyProjectile = flown.length >= 3
        && flown.every((x) => median(x.delays) > HALF_TICK) ? 1 : 0;
      report.against('AI rounds are projectiles with travel time', enemyProjectile,
        'ballistics', 'bullet_model_is_projectile_not_hitscan');
    }

    /* ============================================== 3. bullet drop ===== */
    //
    // A level shot into a plate at 50, 100 and 150 m, measuring the impact height
    // against the eye. With pitch and the recoil spring both held at zero,
    // aimDirection() is exactly horizontal, so the aim point at any range is the
    // eye height and the vertical error IS the drop.
    //
    // A plate rather than a soldier on purpose: a level shot at a 1.28 m chest
    // from a 1.65 m eye is not level with respect to the target, and the first
    // version of this measurement read the difference between eye height and
    // chest height as 37 cm of drop at every range.
    //
    // Averaged over a whole magazine, because the 0.0004 rad spread floor that
    // currentSpread() will not go below puts +-0.06 m of scatter on a single
    // round at 150 m — the same order as the drop itself, so one round could not
    // tell the two apart. 30 rounds pull the standard error down to about 5 mm, a
    // quarter of the threshold, and both numbers are printed so a reader can check
    // that rather than take it on trust.
    let dropK = 0;
    const drop = [];
    {
      await zeroSpread();
      for (const R of [50, 100, 150]) {
        await sim.setup({ position: HOME, yaw: laneYaw, pitch: 0, ads: 1, ammo: 30 });
        await sim.eval((c) => { window.__BALL_EX = c.x; window.__BALL_EZ = c.z; }, at(R));
        await sim.eval(() => { window.__BALL.impacts.length = 0; });
        const plate = await sim.eval((c) => window.__BALL.addPlate(c), {
          w: 40, h: 40, thick: 0.6, dist: R, dx: LX, dz: LZ, name: `ball-drop-${R}`,
        });
        // 0.6 m thick, which is past every penetration gate in the game. A plate a
        // round could pass through would still be recorded at its entry face, but
        // a reader should not have to know that to trust the number.
        //
        // pitch is re-zeroed every tick: view bob and the recoil spring would
        // otherwise both leak into a quantity that is only meaningful for a
        // perfectly level bore. 3.0 s rather than 2.45 because the rounds now need
        // a fifth of a second to arrive.
        const rows = await sim.drive({
          seconds: 3.0, dt: DT,
          input: 'const pl = g.player; pl.pitch = 0; pl.recoilPitch = 0; pl.recoilYaw = 0;'
            + ' pl._recoilPitchVel = 0; pl._recoilYawVel = 0;'
            + IN({ fire: true, ads: true }),
        });
        const imps = await sim.eval(() => window.__BALL.impacts.slice());
        await sim.eval(() => window.__BALL.dropPlates());
        const onPlate = imps.filter((h) => Math.abs(Math.hypot(h.x - h.ex, h.z - h.ez) - R) < 1.0);
        const dys = onPlate.map((h) => h.y - h.ey);
        // Mean, not median: the residual cone is symmetric about the bore, so the
        // mean is the lower-variance estimator of its centre, and the standard
        // error of that mean is what decides whether a small drop is real. The 68%
        // interval is carried too, as the per-round scatter.
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
      report.check('the drop probe caught its rounds on the plate', drop.every((d) => d.n >= 8),
        drop.map((d) => `${d.R} m: ${d.n} of ${d.rounds} rounds landed on the plate`).join('; '));

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
              + '— nothing is integrating gravity on the round'}`);
        // No title publishes a drop-in-metres figure at any range — the research
        // records only that drop exists and was kept deliberately small — so the
        // magnitude is measured and only its presence is asserted.
        if (Number.isFinite(d.dy)) {
          report.measure(`drop at ${d.R} m`, -d.dy, 'm',
            'no sourced drop-in-metres figure exists for any title; see the note on '
            + 'ballistics.bullet_gravity_drop_present');
        }
      }

      // Drop is quadratic in range, so 150 m must drop about 9x as far as 50 m. A
      // model that drops the round linearly, or clamps it at some maximum, fails
      // here while passing every individual range.
      const d50 = drop.find((d) => d.R === 50), d150 = drop.find((d) => d.R === 150);
      const bothReal = d50 && d150 && -d50.dy > dropFloor(50) && -d150.dy > dropFloor(150);
      const ratio = bothReal ? d150.dy / d50.dy : NaN;
      report.check('drop grows with the square of range', bothReal && ratio > 5 && ratio < 15,
        bothReal
          ? `150 m drops ${f4(d150.dy)} m against ${f4(d50.dy)} m at 50 m, ratio ${f3(ratio)} (gravity `
            + 'over a constant velocity gives 9.0)'
          : `not measurable: 50 m gave ${f4(d50?.dy)} m and 150 m gave ${f4(d150?.dy)} m, both inside the `
            + `${f4(dropFloor(150))} m noise threshold, so there is no drop to take a ratio of`);

      // Cross-check of two independent velocity estimates. Time of flight and
      // gravitational fall measure the same physical quantity through different
      // mechanisms, so a real projectile makes them agree and a system that fakes
      // one of them makes them disagree loudly.
      const vT = travel.find((x) => x.R === 150)?.delay;
      const vTravel = Number.isFinite(vT) && vT > 0 ? 150 / vT : Infinity;
      dropK = d150 && -d150.dy > dropFloor(150) ? -d150.dy / (150 * 150) : 0;
      const vDrop = vFromDrop(d150);
      const agree = Number.isFinite(vTravel) && Number.isFinite(vDrop)
        && Math.abs(vTravel - vDrop) / vTravel < 0.3;
      report.check('time-of-flight and drop imply the same muzzle velocity at 150 m', agree,
        `travel time implies ${Number.isFinite(vTravel) ? `${f2(vTravel)} m/s` : 'infinite (0.0 ms of '
          + 'flight)'}, drop implies ${Number.isFinite(vDrop) ? `${f2(vDrop)} m/s` : 'infinite (no '
          + 'measurable drop)'}`);

      report.against('bullets are affected by gravity', bothReal ? 1 : 0,
        'ballistics', 'bullet_gravity_drop_present');
      report.measure('drop curvature used as holdover by the sections below', dropK * 1e6,
        'micro-radian per m', `${(Math.atan(dropK * 200) * DEG * 60).toFixed(1)} arcmin of holdover at 200 m`);
    }

    /* ============================================= 4. penetration ====== */
    //
    // A collider at 4 m with a soldier at 20 m behind it, and the same burst fired
    // with and without it. The paired shot is the whole point: it turns "0 HP
    // transmitted" from an absence of evidence into a measurement, because the
    // identical burst through empty air is on the record beside it.
    //
    // Four thicknesses, and the shape the research describes decides what they are
    // for. Penetration is a per-class MAX-THICKNESS GATE plus ONE flat damage
    // percentage: a round either gets through or it does not, and when it does the
    // penalty is the same regardless of how thick the obstruction was. So this
    // section does NOT assert that damage falls off with thickness — an earlier
    // draft did, and it would have been asserting the pre-Season-01 model against
    // the documented current one. What the thicknesses buy is the gate: something
    // thin must pass, something thick must not, and everything that passes must
    // retain the same fraction.
    //
    // The retained percentage itself is unpublished, so no number is asserted for
    // it. It is measured and printed.
    {
      await zeroSpread();
      const aim0 = await placeTarget(20, { health: 1e6 });
      const BURST = {
        seconds: 1.0, dt: DT, sample: SAMPLE_ENEMY,
        input: aimBody({ fireWhile: 'g.weapon.ammo > 24' }),
      };
      const bare = await sim.drive(BURST);
      const bareDmg = await damageEvents();
      const bareDealt = bareDmg.reduce((s, d) => s + d.amount, 0);
      const bareRounds = roundCount(bare);
      const barePer = median(bareDmg.map((d) => d.amount));

      const walls = [];
      for (const thick of [0.04, 0.15, 0.3, 1.0]) {
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
          per: median(dmg.map((d) => d.amount)),
          events: dmg.length,
          hpLost: hpDrops(rows).reduce((s, d) => s + d, 0),
          rounds: roundCount(rows),
          surface: imps[0]?.surface ?? 'none',
          impacts: imps.length,
        });
      }

      // The same thin plate again, hit at a slant. This is what separates a flat
      // percentage from a thickness-scaled one without needing two materials: the
      // path a round takes through a 4 cm plate met at 39 degrees is 5 cm, so a
      // thickness-scaled penalty has to charge more for it and a flat one cannot.
      const oblique = [];
      for (const dy of [0, 3.2]) {
        await placeTarget(20, { health: 1e6 });
        await sim.eval((c) => window.__BALL.addPlate(c), {
          w: 14, h: 14, thick: 0.04, dist: 4, dy, dx: LX, dz: LZ, name: `ball-slant-${dy}` });
        const rows = await sim.drive(BURST);
        const dmg = await damageEvents();
        await sim.eval(() => window.__BALL.dropPlates());
        oblique.push({
          dy, per: median(dmg.map((d) => d.amount)), events: dmg.length,
          rounds: roundCount(rows),
          // The angle the round meets the plate at, from the plate's offset: the
          // plate faces the eye, so raising it tilts its face away from a shot
          // aimed at the chest by the angle that offset subtends.
          slant: Math.atan2(dy, 4) * DEG,
        });
      }
      await popSpec();
      const thin = walls[0];

      report.check('the penetration probe can see damage when nothing is in the way',
        bareDealt > 0 && bareRounds > 0 && aim0.clear === true,
        `${bareRounds} rounds through clear air at 20 m dealt ${f2(bareDealt)} HP `
        + `(${bareDmg.length} damage events, ${f2(barePer)} HP each)`);
      report.check('the colliders are between the muzzle and the body',
        walls.every((w) => w.aimPre.clear === true && w.blocked.clear === false
          && Math.abs(w.blocked.worldDist - 4) < 0.5),
        walls.map((w) => `${w.thick} m plate: body reachable before it was added (clear=${w.aimPre.clear}), `
          + `first world hit then at ${f2(w.blocked.worldDist)} m against a body at `
          + `${f2(w.blocked.enemyDist)} m, ${w.impacts} impacts on it as "${w.surface}"`).join('; '));

      const frac = bareDealt > 0 && Number.isFinite(thin.per) ? thin.per / barePer : NaN;
      report.check('a thin collider transmits some damage', thin.dealt > 0,
        `${thin.rounds} rounds into a ${thin.thick * 100} cm collider transmitted ${f2(thin.dealt)} HP to `
        + `the body behind it (${thin.events} damage events, ${f2(thin.hpLost)} HP off the target's health) `
        + `against ${f2(bareDealt)} HP for the same burst with the collider removed — `
        + `${(100 * frac).toFixed(1)}% of the per-round damage gets through`);
      if (Number.isFinite(frac)) {
        report.measure('damage retained through a penetrable surface', 100 * frac, '%',
          'no title publishes the retained percentage — ballistics.'
          + 'penetration_damage_falloff_is_flat_not_thickness_scaled says only that it is flat');
      }

      // The gate: something must pass, something must not, and everything that
      // passes must be thinner than everything that does not.
      const passed = walls.filter((w) => w.dealt > 0);
      const stopped = walls.filter((w) => w.dealt <= 0);
      const orderOk = passed.every((p) => stopped.every((q) => p.thick < q.thick));
      report.check('thickness gates whether a round penetrates at all',
        passed.length > 0 && stopped.length > 0 && orderOk,
        walls.map((w) => `${w.thick} m -> ${f2(w.dealt)} HP through`).join(', ')
        + `, against ${f2(bareDealt)} HP through open air: ${passed.length} of ${walls.length} `
        + 'thicknesses penetrate'
        + (passed.length && stopped.length
          ? `, gate somewhere between ${Math.max(...passed.map((w) => w.thick))} and `
            + `${Math.min(...stopped.map((w) => w.thick))} m`
          : passed.length ? ' — nothing stops a round, so there is no gate either'
            : ' — nothing penetrates, so there is no gate, only a wall'));

      // Flat, not thickness-scaled, measured two ways: across the thicknesses that
      // passed, and across two path lengths through the SAME thickness.
      const perRound = passed.map((w) => w.per).filter(Number.isFinite);
      const acrossThickness = perRound.length >= 2
        ? (Math.max(...perRound) - Math.min(...perRound)) / mean(perRound) : NaN;
      const [square, slanted] = oblique;
      const pathRatio = Math.cos(square.slant * Math.PI / 180) / Math.cos(slanted.slant * Math.PI / 180);
      const acrossAngle = Number.isFinite(square.per) && Number.isFinite(slanted.per)
        ? Math.abs(slanted.per - square.per) / square.per : NaN;
      const flat = Number.isFinite(acrossAngle) && acrossAngle < 0.02
        && (!Number.isFinite(acrossThickness) || acrossThickness < 0.02) ? 1 : 0;
      report.against('the penetration damage penalty is flat rather than thickness-scaled', flat,
        'ballistics', 'penetration_damage_falloff_is_flat_not_thickness_scaled');
      report.check('the same surface costs the same whatever path length the round takes through it',
        Number.isFinite(acrossAngle) && acrossAngle < 0.02,
        `4 cm plate hit square (${f2(square.slant)} deg, ${square.events} hits, ${f2(square.per)} HP each) `
        + `and at a slant (${f2(slanted.slant)} deg, ${slanted.events} hits, ${f2(slanted.per)} HP each): `
        + `${(100 * acrossAngle).toFixed(2)}% apart while the path through the material is `
        + `${f2(pathRatio)}x longer — a thickness-scaled penalty could not do that`
        + (perRound.length >= 2
          ? `; across the ${perRound.length} thicknesses that passed the gate, `
            + `${(100 * acrossThickness).toFixed(2)}% apart`
          : ''));

      // Penetration strength is a CLASS property, ordered, and one weapon cannot
      // show that by firing. What can be checked without inventing a number is
      // that the game holds a class table at all and that its ordering is the
      // sourced one — a table with the SMG above the LMG is a defect this catches
      // and a prose paragraph does not.
      const table = await sim.eval(() => {
        const t = window.__GAME.penetration;
        return t ? Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.maxThickness])) : null;
      });
      const order = ['smg', 'ar', 'lmg', 'sniper'];
      const haveAll = !!table && order.every((k) => Number.isFinite(table[k]));
      const ascending = haveAll && order.every((k, i) => i === 0 || table[k] > table[order[i - 1]]);
      report.check('penetration strength is ordered by weapon class', ascending,
        // The failing branch has to carry a number too: with no table at all the
        // detail was pure prose and the reporter threw, which turned a red check
        // into a suite that stopped running — and took the four sections after it
        // with it. A check whose failure path cannot be printed is not a check.
        (table ? order.map((k) => `${k} ${table[k] ?? 'missing'} m`).join(' < ')
          : `the game exposes no penetration table, so 0 of ${order.length} tiers are ordered`)
        + ` — ballistics.penetration_class_hierarchy: `
        + `"${sourcedNote('ballistics', 'penetration_class_hierarchy')}"`);
      // FMJ needs an attachment system, which this game does not have. Recorded as
      // a measurement of zero rather than as a cheerful note, so the coverage gap
      // is counted as a gap instead of inflating the pass rate.
      report.measure('penetration-modifying attachments implemented', 0, 'of 2',
        'ballistics.fmj_attachment_effect asks for two effects (raise the thickness gate, soften the flat '
        + 'penalty); there is no attachment system, so neither exists');
    }

    /* ========================================== 5. damage falloff ====== */
    //
    // Damage actually applied per round across range, spread neutralised and aim
    // forced, counting only rounds the applyDamage tap reports as 'body'. Two
    // independent readings per range: the post-falloff `amount` argument and the
    // health delta off the trace.
    //
    // The grid is fine between 30 and 55 m and coarse outside it, because the
    // sourced shape is a plateau, ONE ramp and a floor, and the ramp is 12.5 m
    // wide. A 10 m sweep puts a single sample inside it, which cannot be fitted
    // and cannot tell that shape from a lerp across the whole range.
    const curve = [];
    const GRID = [10, 20, 30, 32.5, 35, 37.5, 40, 42.5, 45, 47.5, 50, 52.5, 55, 70, 100, 150, 200];
    {
      await zeroSpread();
      for (const R of GRID) {
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
          R, n: body.length, fired: roundCount(rows), zones: dmg.map((d) => d.zone),
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
        + `; holdover from the measured drop curvature, `
        + `${(Math.atan(dropK * 200) * DEG * 60).toFixed(1)} arcmin at 200 m`);

      report.check('the applied damage and the health delta agree on a body hit',
        usable.length > 0 && usable.every((c) => Math.abs(c.amount - c.hp) < 0.01),
        usable.map((c) => `${c.R} m ${f2(c.amount)}/${f2(c.hp)}`).slice(0, 6).join(', ')
        + ` ... max divergence ${f4(Math.max(...usable.map((c) => Math.abs(c.amount - c.hp))))} HP — `
        + 'falloff is applied before the zone multiplier, so for a body hit at x1.0 the two are the same '
        + 'number');

      // Monotonic and bounded: a round must not hit harder further away, and the
      // curve has to fall somewhere or "falloff" is not implemented.
      const steps = usable.slice(1).map((c, i) => c.amount - usable[i].amount);
      const fall = usable.length ? usable[0].amount - usable[usable.length - 1].amount : NaN;
      report.check('damage never increases with range',
        usable.length > 2 && steps.every((s) => s <= 1e-6) && fall > 1e-6,
        `largest increase between adjacent ranges ${f4(Math.max(0, ...steps))} HP; total fall ${f2(fall)} `
        + `HP from ${f2(usable[0]?.amount)} at ${usable[0]?.R} m to `
        + `${f2(usable[usable.length - 1]?.amount)} at ${usable[usable.length - 1]?.R} m`);

      // The two-range-stop shape, asserted structurally: a flat plateau, exactly
      // one falling stretch, and a flat floor that never moves again. That is what
      // makes the shot count learnable — "four inside this range, five beyond it"
      // — and it is the property a lerp from 45 m to 150 m does not have, since
      // that changes damage at every metre and puts the shot-count boundary
      // wherever 100/damage happens to cross an integer.
      const top = usable.length ? usable[0].amount : NaN;
      const floor = usable.length ? usable[usable.length - 1].amount : NaN;
      const plateau = usable.filter((c) => Math.abs(c.amount - top) < 1e-6);
      const bottom = usable.filter((c) => Math.abs(c.amount - floor) < 1e-6);
      const ramp = usable.filter((c) => c.amount < top - 1e-6 && c.amount > floor + 1e-6);
      // One falling stretch: the ramp samples must be contiguous in range, which
      // is what forbids a stepped curve with two knees.
      const rampIdx = ramp.map((c) => usable.indexOf(c));
      const contiguous = rampIdx.every((v, i) => i === 0 || v === rampIdx[i - 1] + 1);
      report.check('damage falls between exactly two range stops',
        plateau.length >= 3 && bottom.length >= 3 && ramp.length >= 2 && contiguous,
        `${plateau.length} ranges at a flat ${f2(top)} HP (${plateau.map((c) => c.R).join('/')} m), `
        + `${ramp.length} on one contiguous ramp (${ramp.map((c) => c.R).join('/')} m), `
        + `${bottom.length} at a flat ${f2(floor)} HP (${bottom.map((c) => c.R).join('/')} m); `
        + `contiguous=${contiguous}. damage.striker45_mw2019_falloff_range_stops is the stepwise `
        + `alternative: "${sourcedNote('damage', 'striker45_mw2019_falloff_range_stops')}"`);

      // The stops are FITTED rather than read off the sweep grid, because a sourced
      // stop of 37.5 +/- 1 m cannot be compared with a grid sample. The ramp
      // samples get a least-squares line and the stops are where that line meets
      // the plateau and the floor. The residual is printed because the fit only
      // means something if the ramp really is a line — and if a future build makes
      // it stepped, the residual is how a reader finds out the fitted stops have
      // stopped meaning anything.
      let nearStop = NaN, farStop = NaN, fitResid = NaN, slope = NaN;
      if (ramp.length >= 2) {
        const f = fitLine(ramp.map((c) => c.R), ramp.map((c) => c.amount));
        slope = f.slope;
        nearStop = (top - f.intercept) / f.slope;
        farStop = (floor - f.intercept) / f.slope;
        fitResid = f.resid;
      }
      report.check('falloff range stops fitted from the curve',
        Number.isFinite(nearStop) && Number.isFinite(farStop) && fitResid < 0.05,
        `full ${f2(top)} HP out to a fitted ${f2(nearStop)} m, then ${f3(slope)} HP/m to a ${f2(floor)} HP `
        + `floor (x${f3(floor / top)} of point-blank) at a fitted ${f2(farStop)} m; ${ramp.length} ramp `
        + `samples, RMS residual ${f4(fitResid)} HP about the fitted line`);

      if (report.reached('a near range stop could be fitted', nearStop)) {
        report.against('falloff onset (near range stop)', nearStop, 'damage', 'm4a1_mw2019_near_range_stop');
      }
      if (report.reached('a far range stop could be fitted', farStop)) {
        report.against('falloff end (far range stop)', farStop, 'damage', 'm4a1_mw2019_far_range_stop');
      }
      if (report.reached('a plateau damage figure was measured', top)) {
        report.against('damage per bullet inside the plateau', top, 'damage', 'm4a1_mw2019_max_damage');
      }
      if (report.reached('a floor damage figure was measured', floor)) {
        report.against('damage per bullet on the floor', floor, 'damage', 'm4a1_mw2019_min_damage');
      }

      // Liveness. The model is no longer read from any patchable SPEC constant, so
      // the probe perturbs the model itself: halving the plateau damage must halve
      // the damage measured inside the plateau.
      // Guarded rather than assumed: a build with no model table to perturb has
      // to make this check FAIL, not throw. It threw once, on exactly that build,
      // and took the two sections after it down with it — so the revert half of a
      // red/green/revert cycle reported nothing at all about zones or TTK.
      const before = top;
      const perturbed = await sim.eval(() => {
        const b = window.__GAME.ballistics;
        if (!b || typeof b.maxDamage !== 'number') return null;
        b.maxDamage /= 2;
        return b.maxDamage;
      });
      let halved = NaN;
      let aim = { clear: false };
      if (perturbed !== null) {
        await zeroSpread();
        aim = await placeTarget(20, { health: 1e6 });
        await sim.drive({
          seconds: 1.0, dt: DT, sample: SAMPLE_ENEMY,
          input: aimBody({ fireWhile: 'g.weapon.ammo > 25' }),
        });
        halved = median((await damageEvents()).filter((d) => d.zone === 'body').map((d) => d.amount));
        await popSpec();
        await sim.eval(() => { window.__GAME.ballistics.maxDamage *= 2; });
      }
      report.check('the falloff probe responds to the model it is measuring',
        aim.clear === true && Number.isFinite(halved) && Math.abs(halved - before / 2) < 0.01,
        perturbed === null
          ? `the game exposes no damage model to perturb, so 0 of 1 perturbations could be applied and the `
            + `${f2(before)} HP plateau above cannot be attributed to it`
          : `halving the plateau damage took the 20 m figure from ${f2(before)} to ${f2(halved)} HP `
            + `(expected ${f2(before / 2)}) — the curve above is the game's and not the instrument's`);
    }

    /* ====================================== 6. zone multipliers ======== */
    //
    // Measured from health deltas against the post-falloff amount the tap
    // reports, at one range, for the head and the body. `amount` is what range did
    // to the round; delta/amount is what the zone did. Both come from the same
    // call, so the ratio cannot pick up a falloff error.
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
        // Paired in order: the applyDamage tap and the health trace see the same
        // calls in the same sequence, so index k of one belongs to index k of the
        // other. Pairs are dropped rather than assumed when the counts disagree.
        const pairs = [];
        for (let k = 0; k < Math.min(dmg.length, drops.length); k++) {
          pairs.push({
            zone: dmg[k].zone, amount: dmg[k].amount, delta: drops[k], passed: dmg[k].passedMult,
          });
        }
        return pairs;
      }

      const headPairs = await zoneRun('head');
      const bodyPairs = await zoneRun('chest');
      await popSpec();

      const byZone = {};
      for (const p of [...headPairs, ...bodyPairs]) (byZone[p.zone] ??= []).push(p);
      const applied = (z) => (byZone[z] ? median(byZone[z].map((p) => p.delta / p.amount)) : NaN);
      const passedFor = (z) => (byZone[z] ? median(finite(byZone[z].map((p) => p.passed))) : NaN);
      headMult = applied('head');
      const bodyMult = applied('body');

      report.check('the zone probe hit the head and the body deliberately',
        (byZone.head?.length ?? 0) >= 3 && (byZone.body?.length ?? 0) >= 3,
        Object.entries(byZone).map(([z, v]) => `${z} x${f3(applied(z))} over ${v.length} hits`).join(', ')
        || 'no zoned hits at all');

      // The cross-file check. main.js passes the multiplier it wants as the fourth
      // argument to applyDamage precisely so that one sourced table governs it;
      // ai.js owns that method and still applies a literal of its own. These two
      // numbers being different is the whole finding, and both are measured — one
      // from the call, one from the health delta — rather than read out of either
      // file.
      const headPassed = passedFor('head'), bodyPassed = passedFor('body');
      report.check('the zone multiplier the shooter passes is the one the target applies',
        Number.isFinite(headPassed) && Number.isFinite(headMult)
        && Math.abs(headPassed - headMult) < 0.02 && Math.abs(bodyPassed - bodyMult) < 0.02,
        `head: shooter passed x${f3(headPassed)}, target applied x${f3(headMult)}; body: passed `
        + `x${f3(bodyPassed)}, applied x${f3(bodyMult)} — the applied value is the literal in ai.js `
        + 'applyDamage(), which does not read the argument');

      report.against('headshot multiplier', headMult, 'damage', 'm4a1_mw2019_headshot_multiplier');
      // The MCW's own figure, recorded and NOT asserted, for the same reason the
      // absolute per-zone pair below is not asserted: 1.3x is the Modern Warfare
      // III MCW at launch, and this port models the Modern Warfare 2019 M4A1,
      // whose documented multiplier is the 1.4x asserted on the line above with a
      // tolerance of +/-0.05. The two bands do not overlap, so a build cannot
      // satisfy both and asserting the pair guarantees one red whatever the game
      // does — and it sends whoever reads it to retune a number that is already
      // right for the weapon this game has committed to. This is the same category
      // error the 780 rpm was: borrowing one title's constant for another title's
      // gun. The comparison is kept because it is worth seeing how far apart the
      // two generations put it (1.4 against 1.3 is 7.7%), not because the M4A1
      // should be judged by it.
      if (report.reached('a headshot multiplier was measured to compare across titles', headMult)) {
        report.measure('headshot multiplier against the MW3 MCW figure', headMult, 'x',
          'damage.mcw_mw3_headshot_multiplier_launch is 1.3x, which is the MW3 MCW at launch and not the '
          + 'MW2019 M4A1 this game models; the M4A1\'s own 1.4x is asserted above');
      }
      report.against('torso multiplier', bodyMult, 'damage', 'mcw_mw3_torso_multiplier_post_buff');
      // 1.5x on snipers is the largest multiplier anywhere in the research, so an
      // assault rifle above it is above the whole sourced set rather than merely
      // off one figure.
      const ceiling = report.targets.TARGETS.damage.mw2019_headshot_multiplier_sniper_rifles;
      report.check('the headshot multiplier is not above the sourced ceiling for any weapon class',
        Number.isFinite(headMult) && headMult <= ceiling.value + ceiling.tol.abs,
        `x${f4(headMult)} measured on an assault rifle against x${ceiling.value} for sniper rifles, the `
        + 'highest multiplier in the research file; shotguns are x1.0 exactly');

      // Absolute per-zone damage, which is how MW3 publishes the MCW: 44 to the
      // head against 37 to the upper torso. Recorded and NOT asserted against
      // those two figures, deliberately: they are MW3 numbers against a 150 HP
      // player, this port models the MW2019 M4A1 against 100 HP, and
      // damage.m4a1_mw2019_max_damage is 30 HP with a tolerance of exactly zero.
      // A build cannot satisfy both, so asserting the pair would guarantee one
      // red whatever the game did and would send whoever read it to tune the
      // wrong number. What DOES transfer across titles is the ratio, and that is
      // asserted below.
      const headHp = median((byZone.head ?? []).map((p) => p.delta));
      const bodyHp = median((byZone.body ?? []).map((p) => p.delta));
      if (report.reached('a head figure in HP was measured', headHp)) {
        report.measure('head damage in HP', headHp, 'HP',
          'damage.mcw_mw3_head_damage is 44 HP, but against MW3\'s 150 HP player');
      }
      if (report.reached('a torso figure in HP was measured', bodyHp)) {
        report.measure('upper torso damage in HP', bodyHp, 'HP',
          'damage.mcw_mw3_upper_torso_damage is 37 HP, likewise against 150 HP');
      }
      report.check('a head hit takes more than a torso hit and not many times more',
        Number.isFinite(headHp) && Number.isFinite(bodyHp) && headHp > bodyHp && headHp / bodyHp < 1.6,
        `${f2(headHp)} HP to the head against ${f2(bodyHp)} to the body, ratio ${f3(headHp / bodyHp)} — the `
        + 'sourced MCW pair is 44/37 = 1.19x and nothing in the research exceeds 1.5x');

      // SPEC.headshotMultiplier is 2.4 and nothing reads it. Proved by
      // perturbation rather than by reading the source: if the constant were live,
      // moving it would move the measurement.
      await patchSpec({ headshotMultiplier: 9.9 });
      await zeroSpread();
      const pairs = await zoneRun('head');
      await popSpec();
      await popSpec();
      const after = median(pairs.filter((p) => p.zone === 'head').map((p) => p.delta / p.amount));
      report.check('SPEC.headshotMultiplier is dead rather than a second source of truth',
        Number.isFinite(after) && Math.abs(after - headMult) < 0.02,
        `setting SPEC.headshotMultiplier from ${SPEC.headshotMultiplier} to 9.9 left the measured `
        + `multiplier at x${f4(after)} (was x${f4(headMult)}, over ${pairs.length} pairs) — the constant is `
        + 'read by nothing, which is the only reason it is safe to leave in a file this agent does not own');
    }

    /* ========================================= 7. shots-to-kill / TTK == */
    //
    // A distribution, not a run. TTK here is stochastic through exactly one
    // channel — the spread cone draw, which decides whether a round lands on the
    // body, clips a limb, or finds the head — and one sample of a lottery is not a
    // measurement of it. Math.random is seeded before any module loads and the
    // stream advances across trials, so N trials are N reproducible draws.
    //
    // Three conditions, because "the TTK" is not one number:
    //
    //   held      the shipping condition. Aim set once at the chest, trigger
    //             held. Recoil and bloom both push rounds off the target.
    //   tracked   recoil zeroed and the chest re-acquired every tick, spread
    //             live. What a player who perfectly compensates recoil gets.
    //   perfect   as tracked, with the spread terms patched to zero and holdover
    //             applied. Every round lands centre of mass, so this is the pure
    //             ballistic TTK: the shot interval times (shots-to-kill - 1).
    //
    // The sourced STK and TTK figures are asserted against 'perfect', because that
    // is the only condition that measures the WEAPON: a published CoD
    // shots-to-kill is a statement about damage per bullet against 100 HP, not
    // about how well the gun can be held on target. Holdover is part of that —
    // "the weapon can reach 120 m" and "the player knows the drop table" are
    // different claims, and the second is measured by the other two conditions,
    // which get none.
    //
    // 80 m is the far anchor rather than 200 m: the sourced min-damage figures are
    // stated for any range past the far stop, which is 50 m, and a 200 m
    // engagement measures the spread cone against a 0.5 m chest rather than the
    // damage model.
    const RANGES = [10, 25, 45, 60, 80, 120];
    const TTK = { held: {}, tracked: {}, perfect: {} };
    let maxDrift = 0;
    {
      /** One engagement. Returns TTK, rounds fired, rounds landed. */
      async function engage(R, cond) {
        const aim = await placeTarget(R, { health: 100 });
        if (!aim.clear) return { blocked: true, ttk: Infinity, stk: Infinity, landed: 0, fired: 0, zones: [] };
        const rows = await sim.drive({
          // 3.0 s is one magazine plus the flight time of the last round: 30
          // rounds at 83 ms is 2.5 s. A kill that needs a reload is reported as
          // "not within a magazine" rather than folded into the median.
          seconds: 3.0, dt: DT, sample: SAMPLE_ENEMY,
          input: cond === 'held' ? IN({ fire: true, ads: true })
            : aimBody({ elevate: cond === 'perfect' ? Math.atan(dropK * R) : 0 }),
        });
        const dmg = await damageEvents();
        const first = rows.findIndex((r) => r.ammo < 30);
        const dead = rows.findIndex((r) => r.ealive === 0);
        maxDrift = Math.max(maxDrift, ...rows.map((r) => r.edrift ?? 0));
        // TTK is measured from the FIRST ROUND'S IMPACT to the fatal one's, which
        // is the convention every sourced figure uses: damage.m4a1_mw2019_ttk_max
        // _range's note says the published number "EXCLUDES the first bullet
        // travel/instant hit, so TTK = (STK - 1) x interval". Measuring from the
        // trigger instead adds one flight time — 67 ms at 80 m — to a figure the
        // research defines without it, which makes a correct gun read 20% slow at
        // range and sends whoever reads it to change the fire rate. The
        // trigger-to-corpse time is reported separately, because that is the one
        // the player experiences.
        const landedBy = dead >= 0 ? dmg.filter((d) => d.t <= rows[dead].t) : dmg;
        const fatal = landedBy.length ? landedBy[landedBy.length - 1].t : NaN;
        return {
          ttk: dead >= 0 && landedBy.length >= 2 ? fatal - landedBy[0].t : Infinity,
          trigger: dead >= 0 && first >= 0 && Number.isFinite(fatal) ? fatal - rows[first].t : Infinity,
          stk: dead >= 0 ? 30 - rows[dead].ammo : Infinity,
          landed: landedBy.length,
          fired: roundCount(rows),
          hpLeft: dead >= 0 ? 0 : rows[rows.length - 1].ehp,
          zones: dmg.map((d) => d.zone),
          // Only the rounds that were still killing him. dmg carries every
          // applyDamage call in the trace, including the ones that landed on a
          // corpse after the fatal round — counting those as head hits would
          // disqualify engagements that were decided entirely centre-mass.
          killZones: landedBy.map((d) => d.zone),
          cone: rows[Math.min(rows.length - 1, first + 1)]?.spread ?? NaN,
          // Per-engagement body damage, so the shots-to-kill cross-check compares a
          // count against the damage measured at exactly the same range in exactly
          // the same engagement rather than interpolating the sweep.
          bodyAmount: median(dmg.filter((d) => d.zone === 'body').map((d) => d.amount)),
        };
      }

      // Trial counts chosen by cost: an engagement is about a second of wall
      // clock. 'tracked' carries the monotonicity assertion and gets the most
      // samples; 'perfect' is nearly deterministic (only the 0.0004 rad floor
      // varies) and needs few.
      const PLAN = [['tracked', 9], ['held', 6], ['perfect', 4]];
      for (const [cond, trials] of PLAN) {
        if (cond === 'perfect') await zeroSpread();
        for (const R of RANGES) {
          const runs = [];
          for (let k = 0; k < trials; k++) runs.push(await engage(R, cond));
          TTK[cond][R] = runs;
        }
        if (cond === 'perfect') await popSpec();
      }

      const allRuns = Object.values(TTK).flatMap((byR) => Object.values(byR).flat());
      report.check('every TTK engagement had a clear shot at the body',
        allRuns.every((r) => !r.blocked),
        `${allRuns.filter((r) => r.blocked).length} of ${allRuns.length} engagements were blocked by `
        + `geometry down a ${f2(lane.clear)} m lane`);
      report.check('the TTK targets held still', maxDrift < 0.25,
        `max drift from the spawn point across ${allRuns.length} engagements ${f4(maxDrift)} m — a target `
        + 'that repositioned would be an AI measurement wearing a ballistics label');

      const summarise = (runs) => {
        const ttks = runs.map((r) => r.ttk);
        const kills = runs.filter((r) => Number.isFinite(r.ttk));
        return {
          n: runs.length, kills: kills.length,
          med: median(ttks), p16: quantile(ttks, 0.16), p84: quantile(ttks, 0.84),
          trigMed: median(runs.map((r) => r.trigger)),
          stkMed: median(runs.map((r) => r.stk)),
          landedMed: median(runs.map((r) => r.landed)),
          firedMed: median(runs.map((r) => r.fired)),
          // Health left on the ones that did NOT die. NaN when they all died,
          // which is the honest reading: there is no survivor to report.
          hpLeft: median(finite(runs.filter((r) => !Number.isFinite(r.ttk)).map((r) => r.hpLeft))),
          heads: runs.reduce((s, r) => s + r.zones.filter((z) => z === 'head').length, 0),
          limbs: runs.reduce((s, r) => s + r.zones.filter((z) => z === 'limb').length, 0),
          cone: median(finite(runs.map((r) => r.cone))),
          dmg: median(finite(runs.map((r) => r.bodyAmount))),
          best: Math.min(...ttks),
          bestStk: Math.min(...runs.map((r) => r.stk)),
          distinct: new Set(ttks.map((v) => v.toFixed(4))).size,
        };
      };
      const S = {};
      for (const cond of Object.keys(TTK)) {
        S[cond] = Object.fromEntries(RANGES.map((R) => [R, summarise(TTK[cond][R])]));
      }

      // The distribution has to be a distribution. If every trial at every range
      // returned the same value, the seeded stream is not advancing between trials
      // and the medians below are one sample wearing a statistic's clothes.
      const distinctTotal = RANGES.reduce((s, R) => s + S.tracked[R].distinct, 0);
      report.check('the TTK measurement samples a distribution rather than one run',
        distinctTotal > RANGES.length,
        `${distinctTotal} distinct TTK values across ${RANGES.length} ranges x ${S.tracked[10].n} tracked `
        + `trials (${RANGES.map((R) => `${R}m:${S.tracked[R].distinct}`).join(' ')})`);

      // The interval a kill has to be an integer multiple of, measured from the
      // muzzle events of one long burst rather than computed from SPEC.rpm: it is
      // the floor below which no TTK can be honest, and it is what stops a 5 ms
      // kill passing as a fast one.
      await zeroSpread();
      await placeTarget(25, { health: 1e6 });
      const burst = await sim.drive({
        seconds: 1.6, dt: DT, sample: SAMPLE_ENEMY, input: aimBody({}),
      });
      const shotTimes = await gunshotTimes();
      await popSpec();
      const gaps = shotTimes.slice(1).map((t, i) => t - shotTimes[i]);
      // The MEAN interval over the whole burst, not the median gap. The weapon
      // keeps the phase of the authored cadence and rounds each shot up to the
      // next tick, so individual gaps alternate between 4 and 5 ticks while the
      // mean stays on the authored figure. A median gap of 5 ticks would put the
      // floor for a 4-round kill at 250 ms when the fourth round demonstrably
      // leaves at 233 ms, and the floor would then be failing honest kills.
      const interval = shotTimes.length > 2
        ? (shotTimes[shotTimes.length - 1] - shotTimes[0]) / (shotTimes.length - 1) : NaN;
      report.check('the shot interval is measurable and steady',
        gaps.length >= 8 && Number.isFinite(interval) && interval > 0,
        `${gaps.length} intervals over ${roundCount(burst)} rounds, mean ${ms(interval)}, individual gaps `
        + `${ms(quantile(gaps, 0.16))}..${ms(quantile(gaps, 0.84))} — SPEC.rpm ${SPEC.rpm} asks for `
        + `${ms(60 / SPEC.rpm)} and the tick quantises each round to a multiple of ${ms(tickLength)}`);
      report.measure('rounds per minute, measured from the muzzle events', 60 / interval, 'rpm',
        `SPEC.rpm is ${SPEC.rpm}; damage.m4a1_mw2019_rpm is 682, which is the figure both sourced TTKs `
        + 'are arithmetic on');

      for (const cond of ['held', 'tracked', 'perfect']) {
        for (const R of RANGES) {
          const s = S[cond][R];
          // The per-range rows are the distribution, and what they assert is the
          // relation every kill has to satisfy whatever the reference figures say:
          // the fatal round cannot arrive before the rounds that killed could have
          // left, and a kill that needed N rounds cannot be quicker than N-1
          // intervals. A kill counted at 5 ms fails here. Magnitude against the
          // research is asserted separately, where there is a sourced number for
          // it.
          // Rounds LANDED, not rounds fired. With travel time the trigger has
          // already sent one or two more downrange before the fatal round
          // arrives, so at 120 m six rounds leave for a five-round kill; a floor
          // built on rounds fired then demands an interval that never happened
          // and fails a correct engagement. Impacts are what the span is between.
          const floorTtk = Number.isFinite(s.landedMed) && s.kills > 0
            ? (s.landedMed - 1) * interval : NaN;
          const ok = Number.isFinite(s.med) && Number.isFinite(floorTtk)
            && s.med >= floorTtk - 1e-9 && s.med <= floorTtk + 0.6;
          // A median that is not finite means most engagements did not end in a
          // kill, and then there is no interval relation to assert — the row has
          // nothing to say about the weapon and everything to say about whether the
          // trigger can be held. In the two COMPENSATED conditions that is a
          // defect and stays red: 'tracked' and 'perfect' model a player holding
          // the sights on the chest, and a rifle that cannot kill a stationary,
          // unaware man down an open lane inside one magazine under those
          // conditions has stopped being a weapon at that range.
          //
          // In 'held' it is the measurement. That condition sets the aim once and
          // holds the trigger through 3.8 degrees of recoil climb, and a rifle that
          // still killed at 120 m like that would be a rifle with no recoil —
          // which is the thing gameplay-weapon.mjs asserts it does have, and which
          // every Call of Duty makes the player fight. Requiring a kill here would
          // be requiring the recoil to be deleted. So the outcome is recorded
          // instead, and the claim that the failure is the aim rather than the gun
          // is asserted once, below, against the compensated conditions at the
          // same ranges. Recorded as HP left on the survivor, which is the number
          // that says HOW far short the spray fell.
          if (!ok && cond === 'held' && !Number.isFinite(s.med) && Number.isFinite(s.hpLeft)) {
            report.measure(`TTK held at ${R} m`, s.hpLeft, 'HP left on the survivor',
              `${s.kills}/${s.n} engagements killed, ${s.landedMed} rounds landed per kill, `
              + `${s.heads} head / ${s.limbs} limb hits across the set, cone at the first round `
              + `${f4(s.cone * DEG * 2)} deg — aim set once and the trigger held through the recoil climb`);
            continue;
          }
          report.check(`TTK ${cond} at ${R} m`, ok,
            `median ${Number.isFinite(s.med) ? ms(s.med) : `no kill in a magazine (${f2(s.hpLeft)} HP left)`} `
            + `first impact to last (${ms(s.trigMed)} from the trigger), `
            + `16-84% ${ms(s.p16)}..${ms(s.p84)}, ${s.kills}/${s.n} engagements killed, median ${s.stkMed} `
            + `rounds fired and ${s.landedMed} landed per kill, so the earliest the last of them could have `
            + `left is ${ms(floorTtk)}; ${s.heads} head / ${s.limbs} limb hits across the set, cone at the `
            + `first round ${f4(s.cone * DEG * 2)} deg`);
        }
      }

      // The strict statement, once, and asserted over the two conditions it can
      // honestly be asserted over.
      //
      // A gun that cannot reliably kill a stationary, unaware target down an open
      // lane inside one magazine has a range at which it stops being a weapon —
      // but that claim is about the WEAPON, so it has to be measured with the
      // weapon held on the target. 'tracked' and 'perfect' do that (recoil
      // compensated every tick, chest re-acquired) and both kill 100% at every
      // range out to 120 m, which is the statement asserted here.
      //
      // 'held' does not, and must not be folded in. It sets the aim once and holds
      // the trigger through the full recoil climb — 3.8 degrees of it at these
      // ranges — so it measures how far the muzzle walks off a 0.5 m chest, and
      // the answer degrading with range (6/6 at 10 m to 0/6 at 120 m) is the
      // recoil model working. The only way to turn that row green would be to
      // remove the recoil, which gameplay-weapon.mjs asserts exists and which is
      // what makes the compensated conditions worth measuring separately at all.
      // So the held rates are recorded, and the assertion that the failure is the
      // aim and not the gun is the row after this one: every range the held
      // trigger cannot win, a player who compensates wins outright.
      const rates = [];
      for (const cond of ['held', 'tracked', 'perfect']) {
        for (const R of RANGES) rates.push(`${cond} ${R}m ${S[cond][R].kills}/${S[cond][R].n}`);
      }
      const COMPENSATED = ['tracked', 'perfect'];
      const allKilled = COMPENSATED.every((c) => RANGES.every((R) => S[c][R].kills === S[c][R].n));
      report.check('every compensated engagement killed within one magazine', allKilled,
        `${rates.join(', ')} — a magazine is 30 rounds over ${ms(30 * interval)}; asserted over `
        + `${COMPENSATED.join(' and ')}, with held recorded beside them`);
      const heldTotal = RANGES.reduce((s2, R) => s2 + S.held[R].n, 0);
      const heldKills = RANGES.reduce((s2, R) => s2 + S.held[R].kills, 0);
      report.measure('kill rate with the aim set once and the trigger held', heldKills / heldTotal,
        'fraction', `${heldKills}/${heldTotal} engagements over ${RANGES.join('/')} m — `
        + `${RANGES.map((R) => `${R}m ${S.held[R].kills}/${S.held[R].n}`).join(' ')}`);
      // The claim that turns the row above from a narrower assertion into the same
      // finding: wherever the spray loses, compensation wins, at the same range in
      // the same lane against the same target. If a range ever appeared where
      // neither condition could kill, this goes red — which is the case the
      // must-kill row was really guarding. It also goes red from the other side, if
      // the held trigger were ever to win at every range: that would mean the
      // recoil climb had stopped moving the muzzle at all, and then the three
      // conditions are one condition and the whole section is measuring nothing.
      const lost = RANGES.filter((R) => S.held[R].kills < S.held[R].n);
      const rescued = lost.filter((R) => COMPENSATED.every((c) => S[c][R].kills === S[c][R].n));
      report.check('every range the held trigger loses is won by compensating recoil',
        lost.length > 0 && rescued.length === lost.length,
        `the held trigger fell short at ${lost.length ? `${lost.join('/')} m` : 'no range'}; of those, `
        + `${rescued.length} are 100% kills with recoil compensated `
        + `(${lost.map((R) => `${R}m tracked ${S.tracked[R].kills}/${S.tracked[R].n}, perfect `
          + `${S.perfect[R].kills}/${S.perfect[R].n}`).join('; ') || 'nothing to rescue'})`);

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
      /**
       * The same, over a subset of the ranges.
       *
       * A series that is undefined at some ranges — "the fastest kill that took no
       * head hit", which not every condition produces everywhere — has to be
       * compared between the ranges that HAVE a value, not through a NaN that makes
       * every comparison silently false. The labels come from the real ranges, so a
       * fall printed as 60->120 m means the 80 m step had nothing to compare.
       *
       * `slack` is a fall this comparison is not entitled to call a fall. It is only
       * ever the tick, and only on a BEST case: see the centre-mass row below for
       * why an extreme of a distribution carries a tick of phase that a median does
       * not.
       */
      const fallsInAt = (idxs, series, fmt, slack = 1e-9) => {
        const out = [];
        for (let k = 1; k < idxs.length; k++) {
          const a = idxs[k - 1], b = idxs[k];
          if (series[b] < series[a] - slack) {
            out.push(`${RANGES[a]}->${RANGES[b]} m: ${fmt(series[a])} -> ${fmt(series[b])} `
              + `(down ${fmt(series[a] - series[b])}, ${f3((series[a] - series[b]) / tickLength)} ticks)`);
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

        // The median is the right statistic for "is the gun monotone", but it hides
        // the lottery, and the lottery is what the baseline actually saw: a single
        // 45 m run killed in 79 ms because one spread round found the head at
        // x2.6, which is faster than any 10 m body kill can be. So the best case is
        // measured separately — but on CENTRE-MASS kills only, and that restriction
        // is the whole point of this row rather than a way round it.
        //
        // Unrestricted best-case monotonicity cannot be an assertion in a game with
        // a headshot multiplier at all. 1.4x is the sourced MW2019 figure
        // (damage.m4a1_mw2019_headshot_multiplier) and it means a five-round kill
        // becomes a four-round kill whenever one round of the burst finds the head:
        // 4 x 1.4 x 20 HP = 112 HP at the damage floor. A wider spread cone throws
        // more rounds off centre, so the CHANCE of that is higher at 120 m than at
        // 80 m, and the fastest of nine draws at 120 m can therefore beat the
        // fastest of nine at 80 m — 350 ms against 366.7 ms in the measured
        // baseline — with nothing wrong anywhere in the model. The row would be
        // asserting that a lucky headshot must not exist, and the only ways to make
        // it hold are to delete the multiplier or to make the cone stop opening.
        // That is the reason the old 2.6x literal DID show up here as a defect and
        // 1.4x does not: at 2.6x two rounds killed where four centred ones were
        // needed, which is a different claim (a head hit beating centre mass by more
        // than one round) and one this file still catches, at the sourced ceiling
        // row and at the 1.6x head/torso ratio row in the zone section.
        //
        // What survives as an assertion is monotonicity of the best CENTRE-MASS
        // kill, to one tick: with the head zone excluded there is no multiplier left
        // to buy a round back, so a longer shot resolving faster than a shorter one
        // by more than the tick grid can explain would be a real defect in the damage
        // curve or the cadence. Asserted over the ranges that produced such a kill,
        // which is all six under both compensated conditions; where the held trigger
        // produced too few to compare, the count says so and the unrestricted table
        // is recorded beside it.
        //
        // Worth recording what the measurement said about the 80->120 m fall this
        // row was rewritten around, because it was not a headshot after all: at
        // 1.4x, both extremes are five-round centre-mass kills and the 16.7 ms
        // between them is one tick of cadence phase (see the slack below). The
        // headshot argument above is still why the row cannot be a strict assertion
        // — it holds at every range for any multiplier above 1 — but the fall
        // actually observed in this build is the grid, and both had to be dealt with
        // for the row to mean anything.
        const bests = RANGES.map((R) => S[cond][R].best);
        const bBreaks = fallsIn(bests, ms);
        const bestTable = `${RANGES.map((R, i) => `${R}m ${Number.isFinite(bests[i]) ? ms(bests[i]) : 'no kill'} `
          + `(${S[cond][R].bestStk} rounds)`).join(' | ')}`;
        report.measure(`ranges where the best-case TTK falls as range grows (${cond})`,
          bBreaks.length, 'range steps',
          `fastest of ${S[cond][RANGES[0]].n} engagements per range ${bestTable}`
          + (bBreaks.length
            ? `; falls at ${bBreaks.join(', ')} — a stray round into the x1.4 head zone beats a centre-mass `
              + 'kill at a shorter range, which a headshot multiplier makes possible at every range'
            : '; non-decreasing in this run\'s draws'));

        // Centre-mass only: engagements whose killing rounds all landed on body or
        // limb. `killZones` stops at the fatal round, so a round that landed on the
        // corpse afterwards does not disqualify an engagement that was decided
        // without a head hit.
        const cleanBest = RANGES.map((R) => {
          const clean = TTK[cond][R].filter(
            (r) => Number.isFinite(r.ttk) && !r.killZones.includes('head'));
          return clean.length ? Math.min(...clean.map((r) => r.ttk)) : NaN;
        });
        const haveIdx = RANGES.map((R, i) => i).filter((i) => Number.isFinite(cleanBest[i]));
        // One tick of slack, and it is the tick rather than a fudge. The weapon keeps
        // the phase of its authored cadence and rounds each shot up to the next tick,
        // so a gap of 88.2 ms is delivered as 5 or 6 ticks depending on where in the
        // tick grid the first round of that engagement left: four gaps come to 21 or
        // 22 ticks, which is 350.0 ms or 366.7 ms for the SAME five-round kill. A
        // median over nine engagements averages that phase away; the fastest of nine
        // is by construction the draw that got the favourable phase, so comparing
        // two extremes across two ranges compares two phases. Measured: 80 m and
        // 120 m both best-case five landed rounds, both centre mass, 366.7 against
        // 350.0 — 16.7 ms apart, exactly one tick, with nothing between them but the
        // grid. A real non-monotonicity in the damage curve or the cadence costs a
        // whole shot interval, 88.2 ms, which is five times this slack.
        //
        // A tick and a half rather than a tick exactly: the two figures are sums of
        // tick-quantised intervals taken from different sub-tick origins — each is
        // measured from ITS OWN engagement's first impact — so the phase difference
        // lands at one tick plus float dust rather than on it, and a bound of exactly
        // one tick fails by 0.03 ms. The number of ticks a fall amounts to is printed
        // beside it, so the reader can see which side of the grid any future fall
        // sits on rather than taking the bound on trust.
        const cBreaks = fallsInAt(haveIdx, cleanBest, ms, tickLength * 1.5);
        const cleanTable = `fastest kill with no head hit before the corpse, per range `
          + `${RANGES.map((R, i) => `${R}m ${Number.isFinite(cleanBest[i]) ? ms(cleanBest[i]) : 'none'}`).join(' | ')}`;
        // 'held' stops producing centre-mass kills at 45 m: past that the spray only
        // wins when a stray round finds the head, so there are two ranges to compare
        // and a monotonicity claim over two points is not one. Recorded rather than
        // asserted, for the same reason the held per-range rows are. A shortage in
        // either COMPENSATED condition is not excused — that would be a gun whose
        // centre-mass kills had disappeared, which is the defect this row exists to
        // catch — so the degradation is spelled out by condition rather than by
        // whatever the sample happened to produce.
        if (cond === 'held' && haveIdx.length < 3) {
          report.measure(`ranges with a centre-mass kill to compare (${cond})`,
            haveIdx.length, `of ${RANGES.length}`,
            `${cleanTable}; three are needed for a monotonicity claim. With the aim set once, every kill `
            + 'past 25 m took a head hit, so there is no centre-mass series to test');
          continue;
        }
        report.check(`best-case centre-mass TTK never falls as range grows (${cond})`,
          haveIdx.length >= 3 && cBreaks.length === 0,
          `${cleanTable} `
          + `(${haveIdx.length}/${RANGES.length} ranges produced one; three are needed to compare, and a `
          + `fall has to exceed 1.5 ticks, ${ms(tickLength * 1.5)}, to count)`
          + (cBreaks.length ? `; falls at ${cBreaks.join(', ')}` : '; non-decreasing')
          + `. Unrestricted best case, for contrast: ${bestTable}`);
      }

      // Cross-check: the ballistic shots-to-kill implied by the measured damage
      // against the shots-to-kill counted in the 'perfect' condition. Two
      // independent instruments — the applyDamage amount and a counted engagement
      // — reading the same property.
      //
      // Counted against rounds LANDED, not rounds fired: the trigger has already
      // sent the next round or two downrange before the fatal one arrives, which is
      // the gun working correctly rather than the instrument counting the wrong
      // thing. Rounds fired is reported beside it, because that is what the player
      // pays for.
      const implied = RANGES.map((R) => {
        const d = S.perfect[R].dmg;
        return Number.isFinite(d) ? Math.ceil(100 / d) : NaN;
      });
      const counted = RANGES.map((R) => S.perfect[R].landedMed);
      const agree = implied.every((v, i) => Number.isFinite(v) && v === counted[i]);
      report.check('counted shots-to-kill matches the damage curve', agree,
        RANGES.map((R, i) => `${R}m ${f2(S.perfect[R].dmg)} HP/round implies ${implied[i]}, counted `
          + `${counted[i]} landed of ${S.perfect[R].firedMed} fired`).join('; ')
        + ' (implied = ceil(100 HP / measured body damage))');

      // What the two compensated conditions cost, as one number: how much of any
      // far-range failure is recoil and how much is bloom.
      const t80 = S.tracked[80], h80 = S.held[80], p80 = S.perfect[80];
      report.check('recoil compensation alone makes 80 m winnable', t80.kills === t80.n,
        `at 80 m: trigger held ${h80.kills}/${h80.n} kills (${f2(h80.hpLeft)} HP left), recoil compensated `
        + `${t80.kills}/${t80.n} (${f2(t80.hpLeft)} HP left, ${t80.landedMed} of ${t80.firedMed} rounds `
        + `landing), spread also neutralised ${p80.kills}/${p80.n} at ${ms(p80.med)} — the cone is `
        + `${f4(t80.cone * DEG * 2)} deg at the first round and keeps opening`);

      /* ---- against the research ---------------------------------------- */
      //
      // Health first: every shots-to-kill figure in the research is against
      // 100 HP, so if this game's soldier had 150 the whole comparison would be
      // wrong in a way no TTK row would reveal. Spawned with the health override
      // OMITTED — not passed as undefined, which triggers the helper's own default
      // and makes the check assert this file's own argument back at itself.
      await placeTarget(10, { health: null });
      const enemyHealth = await sim.eval(() => window.__GAME.director.enemies[0]?.health ?? null);
      if (report.reached('a freshly spawned soldier reported its own health', enemyHealth)) {
        report.against('enemy health', enemyHealth, 'damage', 'health_mw2019');
      }

      const nearR = RANGES[0], farR = 80;
      const nearS = S.perfect[nearR], farS = S.perfect[farR];
      if (report.reached(`shots to kill were counted at ${nearR} m`, nearS.landedMed)) {
        report.against('shots to kill inside the max-damage range', nearS.landedMed,
          'damage', 'm4a1_mw2019_stk_max_range');
      }
      if (report.reached(`shots to kill were counted at ${farR} m`, farS.landedMed)) {
        report.against('shots to kill past the min-damage range', farS.landedMed,
          'damage', 'm4a1_mw2019_stk_min_range');
      }
      // The player-facing number the sourced convention leaves out: how long the
      // corpse takes from the trigger, flight time included. No published figure
      // is defined this way, so it is measured rather than asserted, and it is
      // the one that answers "does the gun feel slow at range".
      for (const R of [nearR, farR]) {
        if (Number.isFinite(S.perfect[R].trigMed)) {
          report.measure(`trigger to corpse at ${R} m`, S.perfect[R].trigMed * 1000, 'ms',
            `${ms(S.perfect[R].med)} of it is the shot interval; the rest is the fatal round's flight`);
        }
      }
      if (report.reached(`a TTK was measured at ${nearR} m`, nearS.med)) {
        report.against('TTK inside the max-damage range', nearS.med,
          'damage', 'm4a1_mw2019_ttk_max_range');
        // Two more readings of the same close-range number from other titles, so a
        // reader cannot dismiss a gap as one wiki's arithmetic. The BO6 entry is
        // the FASTEST full-auto AR in that game: a measurement below it is below
        // everything in the sourced set.
        report.against('TTK against the MW3 assault-rifle class average', nearS.med,
          'damage', 'ar_mw3_typical_ttk');
        report.against('TTK against the fastest full-auto AR in the sourced set', nearS.med,
          'damage', 'bo6_fastest_full_auto_assault_rifle_ttk');
        // The BO6 class band, recorded and NOT asserted. 280-350 ms is the Black
        // Ops 6 assault-rifle CLASS MEAN, and its own note says so twice over: it
        // is "a class mean only — per-weapon spread inside the class is large
        // (260 ms to ~400 ms)", and the sibling key's note says in as many words
        // that "anything modelled on a full-auto M4A1-class AR" should use
        // bo6_fastest_full_auto_assault_rifle_ttk instead. That key is asserted on
        // the line above and passes at 267 ms. This game models one particular
        // weapon from a different title, whose own TTK — 264 ms, asserted first in
        // this block — sits 16 ms below the bottom of the BO6 band by arithmetic:
        // 4 shots to kill at 682 rpm IS 264 ms, and no build can be inside both
        // that figure and a band that starts at 280 ms. Asserting the class mean
        // would therefore be a permanent red that argues for changing the fire
        // rate away from the sourced 682 rpm — which is exactly the trade the
        // 780 rpm was, and the reason SPEC.rpm is what it is.
        report.measure('TTK against the BO6 assault-rifle class band', nearS.med * 1000, 'ms',
          'damage.bo6_average_assault_rifle_ttk is the BO6 assault-rifle class mean, band 280-350 ms; this '
          + 'is the MW2019 M4A1, whose own 264 ms is asserted above, as is the closest per-weapon BO6 '
          + 'analogue (AS VAL, 268 ms)');
      }
      if (report.reached(`a TTK was measured at ${farR} m`, farS.med)) {
        report.against('TTK past the min-damage range', farS.med,
          'damage', 'm4a1_mw2019_ttk_min_range');
      }
    }
  } finally {
    // Whatever happened: no patched constant, no injected collider and no wrapper
    // may outlive this suite.
    await restoreSpec().catch(() => {});
    await sim.eval(() => {
      window.__BALL?.dropPlates?.();
      window.__BALL?.untap?.();
    }).catch(() => {});
  }
}
