// Weapon feel: recoil, ADS, spread, cadence, reload, sprint-to-fire.
//
// The six things a player's hands learn about a gun, measured through the
// running simulation. The previous generation of this file was audited and came
// back as half decoration: five of nine source perturbations left its PASS/FAIL
// set byte-identical, because every recoil assertion was a dimensionless ratio
// and every numeric assertion compared the behaviour against the constant that
// produced it. Both classes are gone. What replaced them:
//
//   Absolute magnitudes, sourced or measured.  A number with a reference value
//   in targets.mjs goes through report.against(domain, key) and cannot pick up a
//   tolerance of its own. A number with no published reference — reload
//   duration, sprint-to-ADS, per-shot climb — goes through report.measure() and
//   is never counted as a passing check. There is no third option here and no
//   invented threshold dressed as a target.
//
//   A liveness probe per section.  Cadence, sprint-to-fire, ADS duration, hip
//   cone, recoil magnitude and centre speed are each perturbed at their authored
//   constant mid-run, and the measurement is required to move. That is what a
//   ratio-only suite could not do: it is the difference between "the shape is
//   right" and "the numbers are wired to the shape".
//
//   Dispersion measured as dispersion.  Cone width used to be read off
//   currentSpread(), a deterministic scalar, so nothing verified that bullets
//   went where the cone said. resolveBullet() is tapped instead and the angle
//   between each bullet and the camera axis is the measurement — which is the
//   only way to assert recoil.ads_bullet_spread_degrees = 0 exactly, because
//   that target is about impacts and not about a parameter.
//
// Two conventions run throughout, both load-bearing:
//
//   Rounds are ammo decrements. weapon.fire() is called on every tick the
//   trigger is held and returns null on most of them, so `weapon.fire` events
//   count trigger polls, not shots.
//
//   Aim is aimPitch/aimYaw (pitch + recoil), never recoilPitch alone. The
//   weapon hands the residual view kick back to player.pitch when a burst ends,
//   so a suite reading recoilPitch would report that the climb had vanished when
//   in fact the gun is still pointing at the sky.

const DEG = 180 / Math.PI;

// 1/240 puts four samples inside the 77 ms shot interval, which is the
// resolution the recoil envelope and the ADS ramp both need. Cadence and reload
// are also taken at 1/120 — the step the game ships at — because a rate limiter
// quantised to the tick is exactly the defect that made a 780 rpm weapon fire
// 720 in the loop while measuring 758 at a finer step.
const DT = 1 / 240;
const DT_SHIP = 1 / 120;

export const NAME = 'weapon';

/* ------------------------------------------------------------ plumbing -- */

const BASE_INPUT = {
  forward: false, back: false, left: false, right: false,
  sprint: false, crouch: false, ads: false, fire: false,
};

/**
 * Builds an input body with every key written explicitly.
 *
 * sim.drive Object.assign's the returned patch onto g.input, so a key omitted
 * on tick 2 keeps whatever tick 1 left there. Every input here goes through this
 * so that a released trigger is actually released.
 */
const IN = (over = {}) => `return ${JSON.stringify({ ...BASE_INPUT, ...over })};`;

/** Same, with a statement run before the patch (reload keys, marks). */
const IN_PRE = (stmt, over = {}) => `${stmt}\nreturn ${JSON.stringify({ ...BASE_INPUT, ...over })};`;

const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : String(v));
const f4 = (v) => (Number.isFinite(v) ? v.toFixed(4) : String(v));
const ms = (v) => (Number.isFinite(v) ? `${(v * 1000).toFixed(1)} ms` : String(v));
const median = (a) => {
  const s = a.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Ticks on which a round left the gun, as {n, t, i}.
 *
 * Stops at the first ammo *increase*: that is a reload returning rounds, and
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

/** Highest value of `key` over rows [from..to]. */
const maxOf = (rows, from, to, key) => {
  let m = -Infinity;
  for (let i = Math.max(0, from); i <= to && i < rows.length; i++) m = Math.max(m, rows[i][key]);
  return m;
};

/* --------------------------------------------------------------- suite -- */

export default async function run(sim, report) {
  /**
   * Live SPEC access, for liveness probes only.
   *
   * Nothing in this file compares a measurement against a value read from here —
   * that is the tautology the audit found four times over. A patch is applied,
   * the measurement is required to *move*, and the patch is undone. LIFO, and
   * restored in a finally so a throw cannot leak a patched weapon into the
   * sections below or into another suite sharing the browser.
   */
  const patches = [];
  async function patchSpec(patch) {
    const prev = await sim.eval(async (p) => {
      const m = await import('/src/weapon.js');
      const before = {};
      for (const k of Object.keys(p)) { before[k] = m.SPEC[k]; m.SPEC[k] = p[k]; }
      return before;
    }, patch);
    patches.push(prev);
    return prev;
  }
  async function popSpec() {
    const prev = patches.pop();
    if (!prev) return;
    await sim.eval(async (p) => {
      const m = await import('/src/weapon.js');
      for (const k of Object.keys(p)) m.SPEC[k] = p[k];
    }, prev);
  }

  /**
   * Records the angle between every bullet and the camera axis it was fired
   * along.
   *
   * The cone is applied inside playerShoot() after aimDirection(), so the only
   * place the dispersion of an actual round is visible is the direction the round
   * is launched along. Camera direction and bullet direction are read at the same
   * instant, so view kick is common to both and cancels: what is left is the
   * cone and nothing else. Installed as an own property shadowing the prototype
   * method, so teardown is a delete and cannot leave a half-patched game behind
   * for the next suite.
   *
   * The seam is fireRound() and not resolveBullet(). It was resolveBullet until
   * rounds were given a flight: playerShoot() now launches a projectile and the
   * hit is resolved later, from inside the round walk, against a direction that
   * has already been rotated by penetration and pulled down by gravity. Tapping
   * there measured zero bullets outright — three dispersion checks reported "0
   * bullets recorded" while the weapon was firing normally, which is the
   * instrument going silent rather than the game going quiet, and is precisely
   * the failure this project keeps having to catch. It would also have been
   * worse if it had half-worked: a tap downstream of gravity measures drop as
   * dispersion.
   */
  async function tapBullets() {
    await sim.eval(() => {
      const g = window.__GAME;
      window.__SHOTS = [];
      const proto = Object.getPrototypeOf(g);
      if (typeof proto.fireRound !== 'function') {
        // Better a loud failure than a silent zero: the whole dispersion section
        // is meaningless if this seam has moved again.
        throw new Error('tapBullets: Game.fireRound is gone — the shot path moved, find the new seam');
      }
      g.fireRound = function (origin, dir, fromPlayer) {
        if (fromPlayer) {
          const cam = g.camera.getWorldDirection(new window.__THREE.Vector3());
          const d = Math.min(1, Math.max(-1, cam.dot(dir)));
          window.__SHOTS.push({ t: g.elapsed, dev: Math.acos(d), ammo: g.weapon.ammo });
        }
        return proto.fireRound.call(this, origin, dir, fromPlayer);
      };
    });
  }
  const untapBullets = () => sim.eval(() => { delete window.__GAME.fireRound; });
  const takeShots = () => sim.eval(() => {
    const s = window.__SHOTS ?? [];
    window.__SHOTS = [];
    return s;
  });

  const HOME = [-6, null, 17];
  // A heading with nothing in front of the muzzle. Bullets are resolved against
  // world geometry, and a shot that ends in a wall two metres out still counts as
  // a round but tells the dispersion tap nothing useful about anything else.
  const lane = await sim.clearLane(HOME, 120);
  const laneYaw = lane.deg * Math.PI / 180 + Math.PI;
  report.check('a clear firing lane exists to measure into',
    lane.clear > 100,
    `heading ${lane.deg} deg is unobstructed for ${f2(lane.clear)} m from `
    + `[${HOME[0]}, ground, ${HOME[2]}]`);

  const base = { position: HOME, yaw: laneYaw, pitch: 0 };

  try {
    /* ================================================== cadence ========= */
    //
    // The rate limiter compares (now - lastShot) against 60/rpm and is sampled
    // once a tick, so the naive form quantises the interval up to the next tick
    // boundary: 77 ms of specified interval becomes 83 ms at 1/120 and the gun
    // fires 720 rpm however the spec is authored. Both steps are measured and the
    // two are required to agree — a cadence that depends on the frame rate is a
    // different weapon on every machine.

    async function cadence(dt) {
      await sim.setup(base);
      const rows = await sim.drive({ seconds: 2.6, dt, input: IN({ fire: true }) });
      const r = roundsOf(rows);
      if (r.length < 3) return { rounds: r.length, rpm: null, interval: null, rows, r };
      const interval = (r[r.length - 1].t - r[0].t) / (r.length - 1);
      return { rounds: r.length, rpm: 60 / interval, interval, rows, r };
    }

    const cShip = await cadence(DT_SHIP);
    const cFine = await cadence(DT);
    report.check('a held trigger empties a magazine',
      cShip.rounds >= 28,
      `${cShip.rounds} rounds left the gun in 2.6 s at dt=1/${Math.round(1 / DT_SHIP)}`);
    report.reached('the cadence measurement has an interval to report', cShip.rpm,
      cShip.rpm === null ? 'fewer than 3 rounds fired — no interval exists'
        : `${cShip.rounds} rounds, mean interval ${ms(cShip.interval)}`);

    if (Number.isFinite(cShip.rpm)) {
      // The weapon is the MW2019 M4A1 throughout: main.js took that title's damage
      // profile and shots-to-kill, and SPEC.rpm now takes its 682 rpm, so cadence
      // is asserted against the same weapon rather than against the XM4 and the
      // MW2 M4 — two other guns whose figures the old 780 happened to sit between.
      report.against('sustained rate of fire', cShip.rpm, 'damage', 'm4a1_mw2019_rpm');
                }
    if (Number.isFinite(cFine.rpm) && Number.isFinite(cShip.rpm)) {
      const apart = Math.abs(cFine.rpm - cShip.rpm) / cShip.rpm;
      report.check('rate of fire does not depend on the simulation step',
        apart < 0.02,
        `${f2(cShip.rpm)} rpm at 1/120 vs ${f2(cFine.rpm)} rpm at 1/240 — ${(apart * 100).toFixed(2)}% apart `
        + '(structural: the same weapon on every machine, not a sourced figure)');
    }

    // Liveness. Nothing above may pass on a gun whose authored cadence has been
    // moved out from under it.
    await patchSpec({ rpm: 480 });
    const cSlow = await cadence(DT_SHIP);
    await popSpec();
    report.check('the cadence probe responds to the cadence it measures',
      Number.isFinite(cSlow.rpm) && Number.isFinite(cShip.rpm) && cSlow.rpm < cShip.rpm * 0.8,
      `SPEC.rpm -> 480 took the measured rate from ${f2(cShip.rpm)} to ${f2(cSlow.rpm)} rpm`);

    /* ============================================== sprint to fire ====== */
    //
    // A released sprint used to cost nothing: a round left the gun on the very
    // first tick, 4.2 ms against sourced figures of 252 ms (MCW) and 162 ms (XM4).
    // The two sourced weapons are 90 ms apart, so only one can be asserted. This
    // weapon is authored to the XM4 figure — the MCW figure is unreachable, because
    // tools/verify.mjs advances 0.2 s of simulation after a sprint before asserting
    // that the trigger consumed ammunition — and the MCW value is recorded beside
    // it so the gap is visible rather than argued away.

    /**
     * Sprints up to speed, releases sprint on the tick the trigger is pulled, and
     * returns the delay until a round actually leaves the gun.
     */
    async function sprintToFire() {
      await sim.setup(base);
      // Reach sprint speed first: player.sprinting needs > 1.2 m/s, so pulling the
      // trigger during the acceleration ramp would measure the ramp.
      //
      // t0 is the last tick on which the player was *actually* sprinting, not the
      // last tick of the drive. Sprinting across this terrain leaves the ground for
      // a tick here and there and player.sprinting requires onGround, so the final
      // row of a 0.9 s sprint is airborne about a third of the time — measuring
      // from it would report a delay 8 ms short at random.
      const spin = await sim.drive({ seconds: 0.9, dt: DT, input: IN({ forward: true, sprint: true }) });
      let iLast = -1;
      for (let i = 0; i < spin.length; i++) if (spin[i].sprinting === 1) iLast = i;
      const held = spin.filter((x) => x.sprinting === 1).length / spin.length;
      const last = iLast >= 0 ? spin[iLast] : spin[spin.length - 1];
      const rows = await sim.drive({ seconds: 0.9, dt: DT, input: IN({ fire: true }) });
      const r = roundsOf(rows);
      const tail = iLast >= 0 ? spin[spin.length - 1].t - last.t : Infinity;
      return {
        sprinting: held > 0.35 && tail < 0.12, held, tail, speed: last.speed, t0: last.t,
        delay: r.length ? r[0].t - last.t : null,
        // Also from the trigger pull, which is the quantity the structural check
        // wants: measured from the last sprinting tick it inherits the airborne
        // tail of the run-up and reads over 100 ms even with the carry removed
        // entirely, which is a check that cannot fail.
        fromPull: r.length ? r[0].t - rows[0].t : null,
        rounds: r.length,
      };
    }

    const s2f = await sprintToFire();
    report.check('the sprint the sprint-to-fire probe measures actually engaged',
      s2f.sprinting,
      `player.sprinting was last 1 at ${f2(s2f.speed)} m/s, ${ms(s2f.tail)} before the trigger pull, and held `
      + `for ${(s2f.held * 100).toFixed(0)}% of the 0.9 s run-up (it drops on the ticks the run leaves `
      + 'the ground, which is why the delay is measured from the last sprinting tick)');
    report.reached('a round leaves the gun after sprint is released', s2f.delay,
      s2f.delay === null ? 'no round left the gun in 0.9 s after releasing sprint'
        : `first round ${ms(s2f.delay)} after the release tick`);
    if (Number.isFinite(s2f.delay)) {
      report.against('sprint-to-fire time', s2f.delay, 'handling', 'xm4_sprint_to_fire_time');
      report.measure('sprint-to-fire time, against the MCW figure of 0.252 s', s2f.delay, 's',
        'the two sourced weapons are 90 ms apart and the MCW figure would take tools/verify.mjs to 12/14');
      report.check('no round leaves the gun on the tick the trigger is pulled',
        Number.isFinite(s2f.fromPull) && s2f.fromPull > DT * 1.5,
        `first round ${ms(s2f.fromPull)} after the pull, ${f2(s2f.fromPull / DT)} ticks of ${ms(DT)} `
        + '(structural: a sprint the player is coming out of must cost more than the tick it ended on)');
    }

    // The carry cannot be a lockout. player.sprinting is computed from held input,
    // so on a phone a thumb parked at full stick deflection is a permanent sprint:
    // if the readiness timer only cleared when the sprint ended, the trigger would
    // do nothing for as long as the player kept moving forward.
    await sim.setup(base);
    const lockUp = await sim.drive({ seconds: 0.9, dt: DT, input: IN({ forward: true, sprint: true }) });
    const lockT0 = lockUp[lockUp.length - 1].t;
    const lockRows = await sim.drive({
      seconds: 0.9, dt: DT, input: IN({ forward: true, sprint: true, fire: true }),
    });
    const lockR = roundsOf(lockRows);
    report.check('holding the trigger through a held sprint still fires',
      lockR.length > 0,
      `${lockR.length} rounds while sprint was held down throughout; first at `
      + `${ms(lockR.length ? lockR[0].t - lockT0 : NaN)} after the trigger pull`);
    if (lockR.length) {
      report.measure('sprint-to-fire with the sprint input never released', lockR[0].t - lockT0, 's',
        'no sourced figure for a trigger pull that interrupts a sprint rather than following it');
    }

    await patchSpec({ sprintToFireTime: 0.6 });
    const s2fSlow = await sprintToFire();
    await popSpec();
    report.check('the sprint-to-fire probe responds to the delay it measures',
      Number.isFinite(s2fSlow.delay) && Number.isFinite(s2f.delay) && s2fSlow.delay > s2f.delay * 1.8,
      `SPEC.sprintToFireTime -> 0.6 took the measured delay from ${ms(s2f.delay)} to ${ms(s2fSlow.delay)}`);

    /* ==================================================== ADS =========== */
    //
    // The blend used to be an exponential damp: 63% at 58 ms, 95% at 183 ms, 99%
    // at 288 ms, never arriving. "Never arriving" is not a pedantic point — ADS
    // bullet spread is required to be exactly zero, and a blend that only
    // approaches 1 leaves a residual cone forever. So the transition has to
    // complete, at a stated duration, and SPEC.adsTime has to be that duration
    // rather than the ornament it was for months.

    /** Time from the tick ADS is requested until the blend arrives exactly at 1. */
    async function adsIn(extra = {}) {
      await sim.setup(base);
      const pre = await sim.drive({ seconds: 0.25, dt: DT, input: IN(extra) });
      const t0 = pre[pre.length - 1].t;
      const rows = await sim.drive({ seconds: 1.4, dt: DT, input: IN({ ...extra, ads: true }) });
      const done = rows.find((x) => x.ads >= 1);
      const t63 = rows.find((x) => x.ads >= 0.63);
      return {
        t0, rows,
        complete: done ? done.t - t0 : null,
        t63: t63 ? t63.t - t0 : null,
        peak: Math.max(...rows.map((x) => x.ads)),
      };
    }

    const adsA = await adsIn();
    report.reached('the ADS blend reaches its endpoint', adsA.complete,
      adsA.complete === null
        ? `blend stalled at ${f4(adsA.peak)} after 1.4 s — it never arrives`
        : `arrived at 1.0 exactly, ${ms(adsA.complete)} after the request`);
    if (Number.isFinite(adsA.complete)) {
      report.against('ADS time (transition complete)', adsA.complete, 'handling', 'mcw_ads_time');
      report.against('ADS time against the M4 figure', adsA.complete, 'handling', 'm4_ads_time');
      report.against('ADS time against the XM4 figure', adsA.complete, 'handling', 'xm4_ads_time');
      report.check('the ADS blend arrives exactly at its endpoint',
        adsA.peak === 1,
        `peak blend ${adsA.peak.toFixed(12)}, gap to 1 is ${(1 - adsA.peak).toExponential(2)} `
        + '(structural: an ADS cone of exactly 0 is unreachable from an asymptote)');
      report.measure('ADS 63% of the blend', adsA.t63 ?? 0, 's',
        'an exponential damp reaches 63% in one time constant; a completing ramp reaches it at 63% of the duration');
    }

    // ADS out, and the endpoint on the way back.
    await sim.setup(base);
    const outPre = await sim.drive({ seconds: 0.7, dt: DT, input: IN({ ads: true }) });
    const outT0 = outPre[outPre.length - 1].t;
    const outRows = await sim.drive({ seconds: 0.9, dt: DT, input: IN() });
    const outDone = outRows.find((x) => x.ads <= 0);
    report.reached('the ADS blend returns to exactly 0', outDone ? outDone.t - outT0 : null,
      outDone ? `hip again ${ms(outDone.t - outT0)} after release`
        : `blend never reached 0; the floor was ${f4(Math.min(...outRows.map((x) => x.ads)))}`);
    if (outDone && Number.isFinite(adsA.complete)) {
      const outTime = outDone.t - outT0;
      report.measure('ADS out', outTime, 's', 'no sourced figure for the lower-to-hip transition');
      report.check('ADS out takes about as long as ADS in',
        Math.abs(outTime - adsA.complete) < 3 * DT,
        `in ${ms(adsA.complete)}, out ${ms(outTime)} — ${f2(Math.abs(outTime - adsA.complete) / DT)} ticks `
        + 'apart (structural: one authored duration governs both directions)');
    }

    // SPEC.adsTime was 0.19 and read by nothing. This is the check that it is now
    // the single number governing the transition.
    await patchSpec({ adsTime: 0.54 });
    const adsSlow = await adsIn();
    await popSpec();
    report.check('SPEC.adsTime governs the ADS transition',
      Number.isFinite(adsSlow.complete) && Number.isFinite(adsA.complete)
        && Math.abs(adsSlow.complete / adsA.complete - 2) < 0.15,
      `SPEC.adsTime -> 0.54 took the measured transition from ${ms(adsA.complete)} to `
      + `${ms(adsSlow.complete)}, a factor of ${f3(adsSlow.complete / adsA.complete)}`);

    // Sprint-to-ADS. No published figure, so the duration is measured and only the
    // ordering is asserted: releasing a sprint has to cost something on the way
    // into the sights, and it did not — 183 ms from a sprint was identical to
    // 183 ms from a stand.
    await sim.setup(base);
    const spUp = await sim.drive({ seconds: 0.9, dt: DT, input: IN({ forward: true, sprint: true }) });
    const spT0 = spUp[spUp.length - 1].t;
    const spRows = await sim.drive({ seconds: 1.6, dt: DT, input: IN({ forward: true, ads: true }) });
    const spDone = spRows.find((x) => x.ads >= 1);
    report.reached('ADS completes after a sprint', spDone ? spDone.t - spT0 : null,
      spDone ? `sighted ${ms(spDone.t - spT0)} after releasing sprint`
        : `blend stalled at ${f4(Math.max(...spRows.map((x) => x.ads)))}`);
    if (spDone && Number.isFinite(adsA.complete)) {
      const spTime = spDone.t - spT0;
      report.measure('sprint-to-ADS time', spTime, 's', 'no sourced figure; recorded, not asserted');
      report.check('coming out of a sprint costs time on the way into the sights',
        spTime > adsA.complete + 2 * DT,
        `${ms(spTime)} from a sprint vs ${ms(adsA.complete)} from a stand — ${ms(spTime - adsA.complete)} `
        + 'of sprint-out before the sights start to come up');
    }

    /* ================================================== dispersion ====== */
    //
    // Measured off the bullets, not off currentSpread().
    // recoil.ads_bullet_spread_degrees is 0 with tol {abs: 0}: a first shot in
    // ADS goes precisely to the reticle and recoil is the only thing that moves
    // impacts, which is what makes a pattern learnable at all.

    await tapBullets();

    // A held burst saturates the bloom at SPEC.spreadMax within about ten rounds,
    // and a saturated cone is the same cone standing, walking or crouched — the
    // stance term disappears under it, which is why the first attempt at the
    // ordering check reported crouched *wider* than standing. `singles` mode fires
    // one round every half second instead: SPEC.spreadRecover clears the bloom in
    // 0.37 s, so every round is a first round and the cone it flies in is the rest
    // cone plus the stance term plus exactly one increment of bloom.
    const SINGLE_PERIOD = Math.round(0.5 / DT);
    const SINGLES = (extra, ads) => `return Object.assign(${JSON.stringify({ ...BASE_INPUT, ...extra })}, `
      + `{ ads: ${!!ads}, fire: (i % ${SINGLE_PERIOD}) === 0 });`;

    /** Holds (or singly pulses) the trigger under `extra` input and returns bullet deviations. */
    async function disperse(extra, { ads = false, settle = 0.5, singles = false, seconds = 1.6 } = {}) {
      await sim.setup(base);
      await takeShots();
      if (settle > 0) await sim.drive({ seconds: settle, dt: DT, input: IN({ ...extra, ads }) });
      const rows = await sim.drive({
        seconds: singles ? 10 : seconds,
        dt: DT,
        input: singles ? SINGLES(extra, ads) : IN({ ...extra, ads, fire: true }),
      });
      const shots = await takeShots();
      const dev = shots.map((s) => s.dev);
      return {
        rows, shots, dev,
        // The widest bullet of a set of single rounds is the estimator of the cone
        // itself: r = sqrt(U) * cone, so 10% of rounds land in the outer 5% of it
        // and the maximum over twenty converges on the cone far tighter than the
        // median does — which matters, because the crouch term is only 28% of the
        // rest cone and a noisy estimator cannot see it.
        cone: dev.length ? Math.max(...dev) : null,
        adsBlend: rows.length ? rows[rows.length - 1].ads : 0,
        speed: rows.length ? rows[rows.length - 1].speed : 0,
        crouched: rows.filter((x) => x.crouching === 1).length / Math.max(1, rows.length),
        coneMax: maxOf(rows, 0, rows.length - 1, 'spread'),
      };
    }

    const dAds = await disperse({}, { ads: true });
    report.check('the ADS dispersion probe fired rounds at a completed blend',
      dAds.dev.length >= 10 && dAds.adsBlend >= 1,
      `${dAds.dev.length} bullets recorded at an ADS blend of ${f4(dAds.adsBlend)}`);
    if (dAds.dev.length) {
      report.against('ADS bullet spread at rest', Math.max(...dAds.dev), 'recoil', 'ads_bullet_spread_degrees');
      report.check('every ADS bullet went to the reticle, not just the median one',
        dAds.dev.every((d) => d === 0),
        `${dAds.dev.filter((d) => d === 0).length}/${dAds.dev.length} bullets at exactly 0 deviation; `
        + `worst ${(Math.max(...dAds.dev) * DEG).toExponential(2)} deg`);
    }

    const dAdsMove = await disperse({ forward: true }, { ads: true });
    if (dAdsMove.dev.length) {
      report.check('ADS bullet spread stays zero while walking',
        Math.max(...dAdsMove.dev) === 0,
        `${dAdsMove.dev.length} bullets at ${f2(dAdsMove.speed)} m/s, worst deviation `
        + `${(Math.max(...dAdsMove.dev) * DEG).toExponential(2)} deg`);
    }

    const dHip = await disperse({});
    const dRest = await disperse({}, { singles: true });
    const dHipMove = await disperse({ forward: true }, { singles: true });
    const dCrouch = await disperse({ crouch: true }, { singles: true });
    const mHip = median(dHip.dev);
    report.reached('the hipfire dispersion distribution exists', mHip,
      mHip === null ? '0 hipfire bullets recorded'
        : `${dHip.dev.length} bullets, median deviation ${f3(mHip * DEG)} deg`);
    if (mHip !== null) {
      report.check('hipfire disperses where ADS does not',
        mHip > 0 && median(dAds.dev) === 0,
        `hip median ${f3(mHip * DEG)} deg over ${dHip.dev.length} bullets, ADS median `
        + `${f3((median(dAds.dev) ?? 0) * DEG)} deg over ${dAds.dev.length}`);
      report.check('every hipfire bullet lands inside the cone the weapon reports',
        Math.max(...dHip.dev) <= dHip.coneMax + 1e-9,
        `worst deviation ${f4(Math.max(...dHip.dev) * DEG)} deg against a reported cone of `
        + `${f4(dHip.coneMax * DEG)} deg over ${dHip.dev.length} bullets`);
      report.measure('hipfire cone at rest, from the bullets', Math.max(...dHip.dev) * DEG, 'deg',
        'no sourced hipfire cone exists; the sourced cone is the ADS one, which is 0');
    }
    report.check('the crouch the stance-ordering probe measures actually engaged',
      dCrouch.crouched > 0.9,
      `player.crouching was 1 on ${(dCrouch.crouched * 100).toFixed(0)}% of the ticks of the crouched run`);
    if (dCrouch.cone !== null && dRest.cone !== null && dHipMove.cone !== null) {
      report.check('dispersion orders crouched < standing < moving',
        dCrouch.cone < dRest.cone && dRest.cone < dHipMove.cone,
        `crouched ${f3(dCrouch.cone * DEG)} deg < standing ${f3(dRest.cone * DEG)} deg < moving `
        + `${f3(dHipMove.cone * DEG)} deg (widest of ${dCrouch.dev.length}/${dRest.dev.length}/`
        + `${dHipMove.dev.length} single rounds, at ${f2(dHipMove.speed)} m/s for the moving set)`);
    }

    // Bloom: the cone opens under sustained hipfire, and the bullets have to show
    // it rather than the parameter alone.
    if (dHip.shots.length >= 20) {
      const early = median(dHip.shots.slice(0, 5).map((s) => s.dev));
      const late = median(dHip.shots.slice(-5).map((s) => s.dev));
      report.check('sustained hipfire opens the cone the bullets fly in',
        late > early,
        `median deviation ${f3(early * DEG)} deg over the first 5 rounds vs ${f3(late * DEG)} deg over `
        + 'the last 5 of the magazine');
    }

    await patchSpec({ spreadHip: 0.004 });
    const dTight = await disperse({}, { singles: true });
    await popSpec();
    report.check('the dispersion probe responds to the cone it measures',
      dTight.cone !== null && dRest.cone !== null && dTight.cone < dRest.cone * 0.5,
      `SPEC.spreadHip -> 0.004 took the measured single-round cone from ${f3(dRest.cone * DEG)} to `
      + `${f3(dTight.cone * DEG)} deg`);

    await untapBullets();

    /* ==================================================== recoil ======== */
    //
    // The measured gap this section exists for: climb was 0.383 deg after 1
    // round, 1.265 after 5, 1.650 after 10 — and 1.6496 after 15, 1.6495 after
    // 20. It stopped. A spring pulling the view to zero cancels accumulation as
    // fast as shots add it, so recoil was a per-shot shake rather than a pattern
    // that walks the gun off target. recoil.recoil_recentering_behaviour
    // describes the real model: the view recenters toward the *previous aim
    // point* at a per-weapon centre speed, and during automatic fire there is
    // usually too much recoil to fully recenter between shots, "so sustained
    // climb is emergent".

    /** Aim climb in degrees at each round of one magazine. */
    async function magazine({ ads = true, seconds = 3.4 } = {}) {
      await sim.setup(base);
      if (ads) await sim.drive({ seconds: 0.5, dt: DT, input: IN({ ads: true }) });
      const pre = await sim.snapshot();
      const rows = await sim.drive({ seconds, dt: DT, input: IN({ ads, fire: true }) });
      const r = roundsOf(rows);
      // Climb at round n is the highest aim pitch between round n and the tick
      // before round n+1 — the peak the player is fighting, not a sample that
      // happened to land between shots. The window stops one tick short of the
      // next round because the kick from round n+1 is already on the view by the
      // time that round's row is sampled, and including it would report the peak
      // after n+1 rounds under the label n.
      const climb = r.map((shot, k) => {
        const to = k + 1 < r.length ? r[k + 1].i - 1 : rows.length - 1;
        return (maxOf(rows, shot.i, to, 'aimPitch') - pre.aimPitch) * DEG;
      });
      const yawAt = r.map((shot) => (rows[shot.i].aimYaw - pre.aimYaw) * DEG);
      // The horizontal kick of each round, taken across the tick the round landed
      // on, which is the closest thing to the drawn value that is observable from
      // outside the weapon.
      //
      // Two weaker forms of this were tried and both were wrong. The cumulative
      // yaw is a random walk that can sit on one side of the aim line for a whole
      // magazine by chance — a reverted ADS fix produced exactly that, all 30
      // rounds negative. Differencing the cumulative value per round is worse than
      // it looks: the difference is the draw minus whatever recentered between the
      // rounds, so it goes negative on a small right-hand draw and a gun authored
      // with recoilHorizontalMin at 0 — one that can only kick right — passed the
      // check with 53/53.
      const yawKick = r.map((shot) => (shot.i > 0
        ? (rows[shot.i].aimYaw - rows[shot.i - 1].aimYaw) * DEG : 0));
      return { rows, r, climb, yawAt, yawKick, pre };
    }

    const magA = await magazine();
    report.check('a full magazine of 30 rounds leaves the gun in ADS',
      magA.r.length >= 30,
      `${magA.r.length} rounds in ${f2(magA.rows[magA.rows.length - 1].t - magA.rows[0].t)} s`);
    const at = (n) => magA.climb[n - 1];
    const marks = [1, 5, 10, 15, 20, 25, 30].filter((n) => n <= magA.climb.length);
    report.reached('climb is measurable at 30 rounds', at(30),
      Number.isFinite(at(30)) ? `climb after 30 rounds ${f3(at(30))} deg`
        : `only ${magA.climb.length} rounds available`);

    for (const n of marks) {
      report.measure(`aim climb after ${n} rounds`, at(n), 'deg',
        'recoil.total_vertical_climb_after_n_rounds_degrees has no published value');
    }

    report.check('climb keeps accumulating through the magazine and never plateaus',
      marks.length >= 5 && marks.every((n, k) => k === 0 || at(n) > at(marks[k - 1]) + 0.02),
      `${marks.map((n) => `${n}:${f3(at(n))}`).join(' ')} deg (structural: strictly rising by more than `
      + '0.02 deg per checkpoint; the old model returned 1.6502 at 10, 1.6496 at 15, 1.6495 at 20)');

    if (magA.climb.length >= 30) {
      const firstTen = (at(10) - at(1)) / 9;
      const lastTen = (at(30) - at(20)) / 10;
      report.check('the accumulation rate does not decay away over the magazine',
        lastTen > firstTen * 0.5,
        `${f4(firstTen)} deg per round over rounds 1-10 vs ${f4(lastTen)} over 20-30, a ratio of `
        + `${f3(lastTen / firstTen)} (structural floor of 0.5; a plateau reads as 0)`);
      report.measure('mean climb per round over a magazine', at(30) / 30, 'deg/round');
    }

    // The residual. A view kick that fully returns to the pre-fire aim point is a
    // shake; the sourced model recenters toward the previous aim point, so what is
    // left after the burst is the pattern the player has to correct.
    await sim.setup(base);
    await sim.drive({ seconds: 0.5, dt: DT, input: IN({ ads: true }) });
    const resPre = await sim.snapshot();
    const resFire = await sim.drive({ seconds: 1.4, dt: DT, input: IN({ ads: true, fire: true }) });
    const resPeak = (maxOf(resFire, 0, resFire.length - 1, 'aimPitch') - resPre.aimPitch) * DEG;
    const resRows = await sim.drive({ seconds: 1.2, dt: DT, input: IN({ ads: true }) });
    const resEnd = (resRows[resRows.length - 1].aimPitch - resPre.aimPitch) * DEG;
    report.check('the burst leaves the gun off the aim point it started from',
      resEnd > resPeak * 0.5,
      `peak ${f3(resPeak)} deg over ${roundsOf(resFire).length} rounds, still ${f3(resEnd)} deg high 1.2 s `
      + 'after the trigger was released (structural: recentering is toward the previous aim point, not zero)');
    report.check('the residual is handed to the pitch the player controls',
      Math.abs(resRows[resRows.length - 1].recoilPitch) < 1e-6,
      `recoilPitch settled to ${resRows[resRows.length - 1].recoilPitch.toExponential(2)} rad while the aim `
      + `stayed ${f3(resEnd)} deg high — the offset lives in player.pitch, where the pitch limit applies`);

    // Horizontal is authored as a min and a max, so both signs must appear inside
    // one magazine.
    const kickMin = Math.min(...magA.yawKick), kickMax = Math.max(...magA.yawKick);
    const yawMin = Math.min(...magA.yawAt), yawMax = Math.max(...magA.yawAt);
    // The floor is one tick of recentering, which is what a shot-tick measurement
    // cannot distinguish from a small draw of the opposite sign: at a centre speed
    // of 9/s and dt = 1/240 that is 3.7% of an offset that never exceeds a degree,
    // so 0.05 deg is comfortably outside it and 0 is not.
    report.check('horizontal kick goes both left and right within one magazine',
      kickMin < -0.05 && kickMax > 0.05,
      `per-round kick ran from ${f3(kickMin)} deg to ${f3(kickMax)} deg over ${magA.yawKick.length} rounds, `
      + `walking the aim between ${f3(yawMin)} and ${f3(yawMax)} deg of the aim line (structural: both `
      + 'signs by more than 0.05 deg, which is twice one tick of recentering)');
    report.measure('horizontal excursion over a magazine', yawMax - yawMin, 'deg',
      'recoil.per_shot_horizontal_kick_degrees has no published value');

    // ADS against hip. recoil.ads_vs_hipfire_recoil_multiplier records that no
    // published multiplier exists, so the ratio is measured and only the ordering
    // is asserted.
    const magHip = await magazine({ ads: false });
    if (magHip.climb.length >= 20 && magA.climb.length >= 20) {
      report.check('aiming reduces the climb the player has to fight',
        magHip.climb[19] > magA.climb[19],
        `hip ${f3(magHip.climb[19])} deg vs ADS ${f3(magA.climb[19])} deg after 20 rounds`);
    }
    if (magHip.climb.length >= 20 && magA.climb.length >= 20 && magHip.climb[19] > 0) {
      report.measure('ADS climb as a fraction of hip climb', magA.climb[19] / magHip.climb[19], 'x',
        'recoil.ads_vs_hipfire_recoil_multiplier records that no published multiplier exists');
    }

    // The envelope. recoil.recoil_determinism: CoD draws one random vertical and
    // one random horizontal value per shot within authored min/max bounds, and
    // recoil_randomness_magnitude_mw2_wz2 records four magazines of one weapon
    // producing four entirely different patterns. So equality across magazines is
    // the wrong assertion and a bounded, learnable envelope is the right one.
    const mags = [magA];
    for (let k = 0; k < 5; k++) mags.push(await magazine());
    const finals = mags.map((m) => m.climb[m.climb.length - 1]);
    const med = median(finals);
    report.reached('six magazines each produced a climb figure', med,
      `${finals.length} magazines, median final climb ${f3(med)} deg`);
    const worst = Math.max(...finals.map((v) => Math.abs(v / med - 1)));
    report.check('every magazine lands inside a learnable envelope',
      worst < 0.25,
      `final climb ${finals.map((v) => f3(v)).join(', ')} deg — median ${f3(med)}, worst deviation `
      + `${(worst * 100).toFixed(1)}% (structural: authored min/max bounds may vary the pattern but not `
      + 'by a quarter, or nothing is learnable)');
    report.check('the pattern is randomised per shot rather than a fixed sequence',
      !finals.every((v) => Math.abs(v - finals[0]) < 1e-9),
      `magazine-to-magazine divergence ${f4(Math.max(...finals) - Math.min(...finals))} deg over `
      + `${finals.length} magazines (recoil_determinism: "randomised per shot within authored min/max bounds")`);
    report.measure('magazine-to-magazine divergence at round 30',
      Math.max(...finals) - Math.min(...finals), 'deg',
      'four magazines in MW2/WZ2 produced four different patterns; the target is an envelope, not equality');

    await patchSpec({ recoilVerticalMin: 0.0013, recoilVerticalMax: 0.0021 });
    const magQuiet = await magazine();
    await popSpec();
    report.check('the recoil probe responds to the recoil magnitude it measures',
      magQuiet.climb.length >= 20 && magA.climb.length >= 20
        && magQuiet.climb[19] < magA.climb[19] * 0.5,
      `quartering the authored vertical bounds took climb after 20 rounds from ${f3(magA.climb[19])} to `
      + `${f3(magQuiet.climb[19])} deg`);

    await patchSpec({ recoilCenterSpeed: 90 });
    const magFast = await magazine();
    await popSpec();
    report.check('the centre speed is what decides whether the climb accumulates',
      magFast.climb.length >= 20 && magA.climb.length >= 20
        && magFast.climb[19] < magA.climb[19] * 0.6,
      `centre speed -> 90 /s (recentering all but complete between rounds) took climb after 20 rounds from `
      + `${f3(magA.climb[19])} to ${f3(magFast.climb[19])} deg — which is the plateau the old spring produced`);

    /* ==================================================== reload ======== */
    //
    // Measured from ammo actually returning, not from the animation track: the
    // track is what the player sees and the ammo is what the player can use.

    async function reload({ ammo, fireThrough = false }) {
      await sim.setup({ ...base, ammo });
      const rows = await sim.drive({
        seconds: 4.0,
        dt: DT_SHIP,
        input: IN_PRE('if (i === 0) g.weapon.startReload(g.elapsed);', fireThrough ? { fire: true } : {}),
      });
      const t0 = rows[0].t;
      const back = rows.find((x) => x.ammo > ammo);
      let fired = 0;
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].ammo > ammo) break;
        if (rows[i].ammo < rows[i - 1].ammo) fired++;
      }
      return {
        rows, t0,
        duration: back ? back.t - t0 : null,
        ammoAfter: back ? back.ammo : rows[rows.length - 1].ammo,
        reserveBefore: rows[0].reserve,
        reserveAfter: back ? back.reserve : rows[rows.length - 1].reserve,
        firedDuring: fired,
        everReloaded: rows.some((x) => x.reloading === 1),
      };
    }

    const tac = await reload({ ammo: 12 });
    const empty = await reload({ ammo: 0 });
    report.reached('a tactical reload returns rounds', tac.duration,
      tac.duration === null ? 'ammo never rose in 4 s' : `12 -> ${tac.ammoAfter} at ${ms(tac.duration)}`);
    report.reached('an empty reload returns rounds', empty.duration,
      empty.duration === null ? 'ammo never rose in 4 s' : `0 -> ${empty.ammoAfter} at ${ms(empty.duration)}`);
    if (Number.isFinite(tac.duration)) {
      report.measure('tactical reload', tac.duration, 's', 'no sourced reload figure for this weapon class');
    }
    if (Number.isFinite(empty.duration)) {
      report.measure('empty reload', empty.duration, 's', 'no sourced reload figure for this weapon class');
    }
    if (Number.isFinite(tac.duration) && Number.isFinite(empty.duration)) {
      report.check('an empty reload costs more than a tactical one',
        empty.duration > tac.duration + 0.1,
        `${ms(tac.duration)} tactical vs ${ms(empty.duration)} empty, ${ms(empty.duration - tac.duration)} apart`);
    }
    report.check('a reload fills the magazine and spends the reserve',
      tac.ammoAfter === 30 && tac.reserveBefore - tac.reserveAfter === 18,
      `ammo 12 -> ${tac.ammoAfter}, reserve ${tac.reserveBefore} -> ${tac.reserveAfter} `
      + `(${tac.reserveBefore - tac.reserveAfter} rounds taken for 18 needed)`);

    const held = await reload({ ammo: 12, fireThrough: true });
    report.check('a reload cannot be cancelled into a shot',
      held.everReloaded && held.firedDuring === 0,
      `the trigger was held for the whole ${ms(held.duration ?? 4)} reload and ${held.firedDuring} rounds `
      + `left the gun before ammo returned to ${held.ammoAfter}`);
  } finally {
    while (patches.length) await popSpec();
    await untapBullets().catch(() => {});
  }
}
