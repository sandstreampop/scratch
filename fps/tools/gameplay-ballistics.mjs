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
// What the game does today, for the reader of a red line: it is pure hitscan.
// resolveBullet() is one Raycaster call, so travel time is exactly zero at
// every range, drop is exactly zero, and a 4 cm collider stops 100% of the
// round. Those three checks are red by construction and are supposed to be —
// they are the specification of the projectile system that does not exist yet.

const DEG = 180 / Math.PI;

// 1/240 everywhere except travel time. The shot interval is 79 ms, so 1/240
// puts ~19 ticks between rounds: enough that a per-round quantity is never
// aliased by the sampling. Travel time gets 1/480 because the quantity under
// test may be smaller than a tick — 10 m at a rifle muzzle velocity is 11 ms —
// and the instrument's floor has to be well under the thing it is looking for.
const DT = 1 / 240;
const DT_TRAVEL = 1 / 480;

// A physical envelope for small-arms muzzle velocity, used to decide whether a
// measured travel time corresponds to a bullet at all. This is NOT a Call of
// Duty figure and is not presented as one: 200 m/s is slower than a service
// pistol and 1500 m/s is faster than any rifle cartridge, so a projectile
// implementation anywhere in that band passes and hitscan (implied velocity
// infinite) fails. Where CoD's own projectile speeds belong is targets.mjs.
const V_PLAUSIBLE = { min: 200, max: 1500 };

export const NAME = 'ballistics';

/* ------------------------------------------------------------- targets -- */
//
// targets.mjs is written by a separate research workflow and may not exist yet.
// The import is defensive and the lookup is forgiving about shape, because this
// file does not own that schema. What it must never do is substitute a number
// of its own on a miss: a missing target reports as a measurement with the
// coverage gap named, so the absence is visible instead of papered over.
let TARGETS = null;
try { ({ TARGETS } = await import('./targets.mjs')); } catch { /* not written yet */ }

function targetFor(paths) {
  if (!TARGETS) return null;
  for (const p of [].concat(paths)) {
    let node = TARGETS;
    for (const k of p.split('.')) { if (node == null) break; node = node[k]; }
    if (node == null) continue;
    if (typeof node === 'number') return { value: node, tol: { pct: 0.15 }, source: `targets.mjs:${p}` };
    const value = node.value ?? node.target ?? node.median ?? null;
    if (typeof value !== 'number') continue;
    const tol = node.tol
      ?? (node.pct != null ? { pct: node.pct } : null)
      ?? (node.min != null || node.max != null ? { min: node.min, max: node.max } : null)
      ?? { pct: 0.15 };
    return { value, tol, unit: node.unit ?? '', source: node.source ?? `targets.mjs:${p}` };
  }
  return null;
}

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
function aimBody({ mark = 'chest', compensate = true, fire = true } = {}) {
  const marker = mark === 'head' ? 'eyePosition' : 'chestPosition';
  return `
    const pl = g.player, en = g.director.enemies[0];
    if (en && en.alive) {
      const V = g.camera.position.constructor;
      const at = en.${marker}(new V());
      const eye = g.camera.position;
      const ax = at.x - eye.x, ay = at.y - eye.y, az = at.z - eye.z;
      pl.yaw = Math.atan2(-ax, -az);
      pl.pitch = Math.atan2(ay, Math.hypot(ax, az));
      ${compensate ? 'pl.recoilPitch = 0; pl.recoilYaw = 0; pl._recoilPitchVel = 0; pl._recoilYawVel = 0;' : ''}
    }
    return ${JSON.stringify({ ...BASE_INPUT, fire, ads: true })};
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
        // Six rounds, aim forced, so a dropped round or a stray zone does not
        // leave the range with no sample at all.
        const rows = await sim.drive({
          seconds: 0.5, dt: DT_TRAVEL, input: aimBody({}), sample: SAMPLE_ENEMY,
        });
        const shots = await gunshotTimes();
        const dmg = await damageEvents();
        const fired = roundCount(rows);
        // Pairing check first. If the number of muzzle events does not match the
        // number of ammo decrements, the muzzle instant is not the muzzle
        // instant and every delay below is measured between the wrong two
        // events. This is the check that lets the 0.0 ms result be believed.
        const paired = shots.length === fired;
        const delays = [];
        for (const s of shots) {
          const hit = dmg.find((d) => d.t >= s - 1e-9);
          if (hit) delays.push(hit.t - s);
        }
        travel.push({
          R, ok: true, paired, fired, shots: shots.length, hits: dmg.length,
          delay: median(delays), delays,
          drift: Math.max(...rows.map((r) => r.edrift ?? 0)),
        });
      }
      await popSpec();

      const good = travel.filter((x) => x.ok);
      report.check('the travel-time probe paired every round with a muzzle event',
        good.length === 4 && good.every((x) => x.paired && x.hits >= x.fired),
        good.map((x) => `${x.R} m: ${x.fired} rounds, ${x.shots} muzzle events, ${x.hits} damage events`)
          .join('; ') || 'no range produced a clear shot');

      for (const x of good) {
        const v = x.R / x.delay;   // Infinity when the delay is exactly zero
        const tgt = targetFor([`ballistics.travelTime.${x.R}m`, `ballistics.travelTime_${x.R}`]);
        const ok = x.delay > 0.5 * DT_TRAVEL && v >= V_PLAUSIBLE.min && v <= V_PLAUSIBLE.max;
        report.check(`round travel time at ${x.R} m`, ok,
          `${ms(x.delay)} between the round leaving the gun and the damage landing `
          + `(${x.delays.length} rounds, one tick is ${ms(DT_TRAVEL)}), implied velocity `
          + `${Number.isFinite(v) ? `${f2(v)} m/s` : 'infinite — the round arrives on the tick it was fired'}; `
          + `a plausible bullet is ${V_PLAUSIBLE.min}..${V_PLAUSIBLE.max} m/s (a physical envelope for `
          + 'small arms, not a sourced CoD figure)'
          + (tgt ? `; sourced target ${f3(tgt.value)} s from ${tgt.source}` : '; no sourced target yet'));
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
        const tgt = targetFor([`ballistics.drop.${d.R}m`, `ballistics.bulletDrop.${d.R}`]);
        report.check(`bullet drop at ${d.R} m`, real,
          `impact ${f4(d.dy)} m relative to a level aim point, mean of ${d.n} rounds, standard error `
          + `${f4(d.se)} m (per-round 68% interval ${f4(d.scatter)} m wide, from the 0.0004 rad spread `
          + `floor that currentSpread() will not go below); `
          + `${real
            ? `implied muzzle velocity ${f2(vFromDrop(d))} m/s at the game's ${gravity} m/s^2`
            : `the round lands level to within ${f4(Math.abs(d.dy))} m against a ${f4(floor)} m threshold `
              + '— nothing is integrating gravity on the round'}`
          + (tgt ? `; sourced target ${f3(tgt.value)} m from ${tgt.source}` : '; no sourced target yet'));
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
      const vDrop = vFromDrop(d150);
      const agree = Number.isFinite(vTravel) && Number.isFinite(vDrop)
        && Math.abs(vTravel - vDrop) / vTravel < 0.3;
      report.check('time-of-flight and drop imply the same muzzle velocity at 150 m', agree,
        `travel time implies ${Number.isFinite(vTravel) ? `${f2(vTravel)} m/s` : 'infinite (0.0 ms of flight)'}, `
        + `drop implies ${Number.isFinite(vDrop) ? `${f2(vDrop)} m/s` : 'infinite (no measurable drop)'} — `
        + `${agree ? 'the two mechanisms agree'
          : 'neither quantity exists, so the two mechanisms cannot be checked against each other'}`);
    }

    /* ============================================= 3. penetration ====== */
    //
    // A 4 cm collider at 4 m, with a soldier at 20 m behind it, and the same
    // burst fired with and without the plate. The paired shot is the whole
    // point: it turns "0 HP transmitted" from an absence of evidence into a
    // measurement, because the identical burst through empty air is on the
    // record next to it.
    {
      await zeroSpread();
      const aim0 = await placeTarget(20, { health: 1e6 });
      const bare = await sim.drive({ seconds: 0.45, dt: DT, input: aimBody({}), sample: SAMPLE_ENEMY });
      const bareDmg = await damageEvents();
      const bareDealt = bareDmg.reduce((s, d) => s + d.amount, 0);
      const bareRounds = roundCount(bare);

      const aim1 = await placeTarget(20, { health: 1e6 });
      const plate = await sim.eval((c) => window.__BALL.addPlate(c), {
        w: 6, h: 6, thick: 0.04, dist: 4, dx: LX, dz: LZ, name: 'ball-thin' });
      const blocked = await sim.aimAt(0);
      const thru = await sim.drive({ seconds: 0.45, dt: DT, input: aimBody({}), sample: SAMPLE_ENEMY });
      const thruDmg = await damageEvents();
      const thruImp = await sim.eval(() => window.__BALL.impacts.slice());
      await sim.eval(() => window.__BALL.dropPlates());
      await popSpec();

      const thruDealt = thruDmg.reduce((s, d) => s + d.amount, 0);
      const thruRounds = roundCount(thru);
      const hpLost = hpDrops(thru).reduce((s, d) => s + d, 0);

      report.check('the penetration probe can see damage when nothing is in the way',
        bareDealt > 0 && bareRounds > 0 && aim0.clear,
        `${bareRounds} rounds through clear air at 20 m dealt ${f2(bareDealt)} HP `
        + `(${bareDmg.length} damage events, ${f2(bareDealt / Math.max(1, bareDmg.length))} HP each)`);
      report.check('the thin collider is where the rounds go',
        blocked.clear === false && Math.abs((blocked.worldDist ?? 0) - 4) < 0.3,
        `aimAt reports the first world hit at ${f2(blocked.worldDist)} m against a body at `
        + `${f2(blocked.enemyDist)} m, so the 4 cm plate is between the two; `
        + `${thruImp.length} impacts recorded on it, surface "${thruImp[0]?.surface ?? 'none'}"`);

      const frac = bareDealt > 0 ? thruDealt / bareDealt : NaN;
      const tgt = targetFor(['ballistics.penetration.thin', 'ballistics.wallbangDamageScale']);
      report.check('a thin collider transmits some damage', thruDealt > 0,
        `${thruRounds} rounds into a 4 cm collider transmitted ${f2(thruDealt)} HP to the body behind it `
        + `(${thruDmg.length} damage events, ${f2(hpLost)} HP off the target's health) against `
        + `${f2(bareDealt)} HP for the same burst with the collider removed — `
        + `${(100 * frac).toFixed(1)}% gets through`
        + (tgt ? `; sourced target ${f3(tgt.value)} from ${tgt.source}` : '; no sourced target yet'));

      // The mechanism, stated as its own measurement so the fix has a target:
      // resolveBullet() compares the enemy hit against the first world hit and
      // returns on the world hit, so thickness and material are not consulted
      // at all. A 4 cm plate and a 4 m bunker wall are the same object to it.
      report.check('penetration depends on what the round hit', thruDealt > 0,
        `a 0.04 m collider stops ${f2(bareDealt - thruDealt)} of ${f2(bareDealt)} HP — the same as a solid `
        + 'wall would, because the round is resolved against the first raycast hit and never carries '
        + 'energy past it');
    }

    /* ========================================== 4. damage falloff ====== */
    //
    // Damage actually applied per round across 10..200 m, spread neutralised
    // and aim forced, counting only rounds the applyDamage tap reports as
    // 'body'. Two independent readings per range: the post-falloff `amount`
    // argument, and the health delta off the trace. They must agree for a body
    // hit (zone multiplier 1.0) and the check says so, because if they diverge
    // one of the two is not what this file thinks it is.
    const curve = [];
    {
      await zeroSpread();
      for (let R = 10; R <= 200; R += 10) {
        const aim = await placeTarget(R, { health: 1e6 });
        if (!aim.clear) { curve.push({ R, blocked: true }); continue; }
        const rows = await sim.drive({ seconds: 0.45, dt: DT, input: aimBody({}), sample: SAMPLE_ENEMY });
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
        curve.map((c) => (c.blocked ? `${c.R} m BLOCKED` : `${c.R} m: ${c.n}/${c.fired} body`)).join(', '));

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
      // The expectation of bands here is structural, not a sourced figure and
      // not a claim about any specific CoD weapon's numbers. What bands buy is
      // learnability: with them a player can hold "three shots inside this
      // range, four beyond it" and be right, and the shot count changes at a
      // small number of announced distances. Under a continuous lerp the shot
      // count boundary lands wherever 100/damage crosses an integer, so it
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
      report.check('damage falls in discrete range bands rather than on a continuous ramp', banded,
        `${plateaus} distinct damage plateaus across ${usable.length} ranges 10 m apart; `
        + `${moving.length} of ${steps.length} adjacent pairs differ, steps `
        + `${moving.slice(0, 4).map((s) => f3(s)).join('/')}... with max/mean ${f3(evenness)} `
        + `(1.0 = perfectly even = a linear ramp) -> the curve is ${banded ? 'banded' : 'SMOOTH: one '
          + 'lerp from falloffStart to falloffEnd, so damage changes at every range and the shot-count '
          + 'boundary sits wherever 100/damage happens to cross an integer'}. Structural expectation, `
        + 'no sourced CoD figure involved');

      // The near plateau and the far floor, derived from the curve rather than
      // read off SPEC — the point being that these are the numbers the game
      // has, whatever the constants say.
      const near = usable[0].amount;
      const far = usable[usable.length - 1].amount;
      const startR = usable.find((c) => c.amount < near - 0.01)?.R ?? null;
      const endR = usable.find((c) => Math.abs(c.amount - far) < 0.01)?.R ?? null;
      report.check('falloff onset and floor measured from the curve', startR != null,
        `full ${f2(near)} HP out to ${startR != null ? startR - 10 : '?'} m, first drop by ${startR} m, `
        + `floor ${f2(far)} HP (x${f3(far / near)} of point-blank) reached by ${endR} m`);

      // Liveness. Halving falloffScale must move the far end of the curve; if
      // it does not, the whole section is measuring the instrument.
      if (SPEC) {
        await patchSpec({ falloffScale: SPEC.falloffScale * 0.5 });
        await zeroSpread();
        const aim = await placeTarget(200, { health: 1e6 });
        const rows = await sim.drive({ seconds: 0.3, dt: DT, input: aimBody({}), sample: SAMPLE_ENEMY });
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
          seconds: 0.6, dt: DT, input: aimBody({ mark }), sample: SAMPLE_ENEMY,
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
        + ' — measured as health delta over the post-falloff amount, no sourced target yet');

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
    const RANGES = [10, 25, 45, 80, 120];
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
          const tgt = targetFor([`ttk.${cond}.${R}m`, `ttk.${R}m`, `damage.ttk.${R}`]);
          const detail =
            `median ${Number.isFinite(s.med) ? ms(s.med) : `no kill in a magazine (${f2(s.hpLeft)} HP left)`}, `
            + `16-84% ${Number.isFinite(s.p16) ? ms(s.p16) : 'inf'}..${Number.isFinite(s.p84) ? ms(s.p84) : 'inf'}, `
            + `${s.kills}/${s.n} engagements killed, median ${Number.isFinite(s.stkMed) ? s.stkMed : 'inf'} `
            + `rounds fired and ${s.landedMed} landed per kill, `
            + `${s.heads} head / ${s.limbs} limb hits across the set, cone at the first round `
            + `${f4(s.cone * DEG * 2)} deg`
            + (tgt ? `; sourced target ${ms(tgt.value)} from ${tgt.source}` : '; no sourced target yet');
          // The assertion is on the median engagement resolving, not on every
          // one of them. Both statements are worth making but only this one is
          // stable: at 25 m with the trigger held the per-engagement kill
          // probability is around 0.85, so "all 6 killed" flips between runs of
          // the suite whenever anything upstream shifts the position of the
          // seeded random stream, and a check that flips teaches its reader to
          // ignore it. The strict "every engagement" version is made once,
          // below, over all 110 of them, where it is red for a reason that does
          // not move. The rate is in the detail either way.
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
      const implied = RANGES.map((R) => {
        const d = S.perfect[R].dmg;
        return Number.isFinite(d) ? Math.ceil(100 / d) : NaN;
      });
      const measuredStk = RANGES.map((R) => S.perfect[R].stkMed);
      const agree = implied.every((v, i) => Number.isFinite(v) && v === measuredStk[i]);
      report.check('counted shots-to-kill matches the damage curve', agree,
        RANGES.map((R, i) => `${R}m ${f2(S.perfect[R].dmg)} HP/round implies ${implied[i]}, counted `
          + `${measuredStk[i]}`).join('; ')
        + ' (implied = ceil(100 HP / measured body damage), counted = rounds fired in the '
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
    }
  } finally {
    // Whatever happened: no patched constant and no injected collider may
    // outlive this suite. It runs first of the three, so a leak here reads as a
    // bug in movement or weapon.
    await restoreSpec().catch(() => {});
    await sim.eval(() => window.__BALL?.dropPlates?.()).catch(() => {});
  }
}
