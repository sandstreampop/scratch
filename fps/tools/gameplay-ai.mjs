// AI behaviour and hitbox fidelity.
//
// This suite measures the enemy from the outside — the way the player meets it:
// how long it takes to shoot back, how often it connects at each range, how it
// paces a firefight, and whether the parts of the soldier a player can see are
// the parts the game will register a hit on.
//
// It exists because every one of those quantities used to be described in ai.js
// by a constant that did not describe it. CONFIG.reactionTime was [0.28, 0.62]
// s and nothing fired at 0.28 s: the reaction roll only moved IDLE -> ALERT ->
// ENGAGE, entering ENGAGE rolled a fresh 0.12-0.34 s fireTimer, and the branch
// that armed the burst did not fire on the tick it armed it. The player
// experiences the sum, so the sum is what this file reports.
//
// THREE CONVENTIONS, all load-bearing:
//
//   Rounds are enemy.shoot() calls. Unlike the player's weapon there is no rate
//   limiter to see through: Enemy.shoot() is called once per round and always
//   fires one, so the tap on Enemy.prototype.shoot IS the round count. It is
//   installed on the prototype, not on an instance, because every sim.setup()
//   throws the roster away and spawns fresh soldiers.
//
//   Hits are Player.prototype.damage() calls, attributed to a specific round:
//   main.enemyShoot() resolves the shot synchronously inside enemy.shoot(), so a
//   damage call arriving while a shoot() is on the stack belongs to that round.
//   That is what makes "missed" distinguishable from "never fired" — the two
//   live in different arrays, and a range reporting 0% says which it was.
//
//   Every engagement checks its own preconditions before its numbers are
//   quoted: that the enemy could see the player at t=0, that the AI's firing
//   lane is not a wall, and that a strafe actually moved. The four null AI
//   timings this project reported two sessions ago were all probes that measured
//   nothing and said nothing about it.
//
// WHAT IS ASSERTED AND WHAT IS ONLY MEASURED. Reaction and the visible-mesh
// invariant have sourced targets and go through report.against(). AI accuracy
// does not — targets.mjs lists ai_accuracy in its own missing() set and its
// note explains that no publisher documents one — so the curve is measured with
// report.measure() and what is ASSERTED about it is only what must be true of
// any accuracy curve whatever its level: that it decreases with range, that no
// engagement range is a certainty, and that adjacent ranges are a step apart
// rather than a cliff. Those three floors are this file's own structural
// statements and every detail string says so. Everything else with no reference
// value is a MEAS row, which cannot pass and cannot inflate a pass rate.
//
// Two rows are red on purpose and belong to files this suite does not own; both
// name the owner in their detail. See the report.


// 1/240 for anything whose answer is a timestamp (reaction, TTK): the AI's own
// line-of-sight schedule costs up to two ticks of latency by construction, and
// at 1/240 that is 8 ms of the answer instead of 33. 1/120 for the long accuracy
// and pacing runs, where the quantity is a ratio over ~100 rounds and halving
// the tick count is worth more than 4 ms of edge resolution.
const DT_FINE = 1 / 240;
const DT_LONG = 1 / 120;

export const NAME = 'ai';

// Only missing() is imported. Sourced values reach this file exclusively through
// report.against(domain, key), which throws on an unknown key — the fuzzy local
// lookups every first-generation suite wrote resolved 0 of 10 keys here and
// printed each miss as "no sourced target yet", which was a false claim about
// the research rather than a bug report about the lookup.
let missing = null;
try { ({ missing } = await import('./targets.mjs')); } catch { /* runner will have failed first */ }

/* ------------------------------------------------------------ plumbing -- */

const BASE_INPUT = {
  forward: false, back: false, left: false, right: false,
  sprint: false, crouch: false, ads: false, fire: false,
};
// drive() Object.assign's the patch, so an omitted key keeps its last value.
// Everything here goes through IN_DYN so a key nobody mentioned is false.
const IN_DYN = (expr) => `return Object.assign(${JSON.stringify(BASE_INPUT)}, (${expr}));`;

// What the pacing and reaction traces need out of the agent itself. State is a
// string, which survives the evaluate boundary fine.
const SAMPLE_AI = `
  const e = g.director.enemies[0];
  return e ? { est: e.state, aim: e._aimBlend, sees: e._sawPlayer ? 1 : 0, ex: e.position.x, ez: e.position.z }
           : { est: 'none', aim: 0, sees: 0, ex: 0, ez: 0 };`;

const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : String(v));
const ms = (v) => (Number.isFinite(v) ? `${(v * 1000).toFixed(0)} ms` : String(v));
const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : String(v));

/** Linear-interpolated quantile. NaN on an empty sample, never 0. */
function quant(arr, p) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const i = (a.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}
const median = (a) => quant(a, 0.5);
const mean = (a) => {
  const f = a.filter(Number.isFinite);
  return f.length ? f.reduce((s, x) => s + x, 0) / f.length : NaN;
};

/** median [p10..p90] over n samples — the standard way this file prints a distribution. */
function dist(a, unit = 's', scale = 1) {
  const n = a.filter(Number.isFinite).length;
  if (!n) return 'no samples';
  const g = (p) => (unit === 'ms' ? ms(quant(a, p)) : `${f3(quant(a, p) * scale)}${unit}`);
  return `median ${g(0.5)} [p10 ${g(0.1)} .. p90 ${g(0.9)}] over ${n} trials`;
}

/* -------------------------------------------------- the page-side probe -- */
//
// One install, reused by every section. Both taps are on prototypes so they
// survive the roster being rebuilt by setup(), and both record into one array
// so a round and its hit can be matched up by index.
async function install(sim) {
  return sim.eval(async () => {
    if (window.__AI) return 'already installed';
    const g = window.__GAME;
    const THREE = window.__THREE;
    const ai = await import('/src/ai.js');
    const pl = await import('/src/player.js');
    const wp = await import('/src/weapon.js');

    const rec = {
      fires: [], hits: [], cur: -1,
      SPEC: wp.SPEC,
      reset() { rec.fires.length = 0; rec.hits.length = 0; rec.cur = -1; },
    };
    window.__AI = rec;

    // Rounds. shoot() is the barrel event: no rate limiter, no early return —
    // one call, one round, with the distance the spread cone was computed from.
    const shoot0 = ai.Enemy.prototype.shoot;
    ai.Enemy.prototype.shoot = function (player, distance) {
      const idx = rec.fires.length;
      rec.fires.push({
        t: g.elapsed, id: this.id, dist: distance, state: this.state,
        hits: 0, amount: 0,
        speed: Math.hypot(g.player.velocity.x, g.player.velocity.z),
        // Rounds still owed on this burst, including this one. The only way to
        // tell a burst the agent meant to be short from one that was cut off by
        // losing sight of the player halfway through it.
        bl: this.burstLeft,
        // Filled in by the tracer tap below, which sees the post-spread ray.
        blocked: null, onTarget: null, missBy: null, lateral: null, geom: 0,
      });
      rec.cur = idx;
      try { return shoot0.apply(this, arguments); } finally { rec.cur = -1; }
    };

    // Hits. Attributed to whichever round is on the stack; a damage call with
    // no round on the stack (there is no such path today) would land in .hits
    // with fire:-1 rather than being silently credited to the last round.
    const dmg0 = pl.Player.prototype.damage;
    pl.Player.prototype.damage = function (amount) {
      rec.hits.push({ t: g.elapsed, amount, fire: rec.cur, health: this.health });
      if (rec.cur >= 0) { rec.fires[rec.cur].hits++; rec.fires[rec.cur].amount += amount; }
      return dmg0.apply(this, arguments);
    };

    // Geometry of the round that actually left the barrel. main.enemyShoot()
    // applies the spread cone and then hands the final ray to the tracer pool,
    // so this is the only place the post-spread direction is visible from
    // outside. Recomputing the hit test here duplicates enemyShoot()'s own
    // arithmetic on purpose: it gives an independent witness for the damage tap
    // (checked against each other below) and a third outcome the damage tap
    // cannot express — the round the world ate.
    const tr = g.vfx.tracers;
    const fire0 = tr.fire;
    tr.fire = function (origin, direction, distance, speed, width) {
      if (rec.cur >= 0) {
        const f = rec.fires[rec.cur];
        const o = origin.clone(), d = direction.clone().normalize();
        const box = g.player.aabb(new THREE.Box3());
        const hp = new THREE.Ray(o, d).intersectBox(box, new THREE.Vector3());
        const pd = hp ? o.distanceTo(hp) : Infinity;
        const wd = window.__SIM.rayWorld([o.x, o.y, o.z], [d.x, d.y, d.z], 200);
        f.geom = pd < wd ? 1 : 0;
        // "Blocked" is only meaningful for a round that was aimed well enough to
        // intersect the player's box in the first place. The first version of
        // this counted every round whose world hit came first — which is every
        // round that missed, since a miss has pd = Infinity — and reported 69%
        // of the AI's fire as eaten by walls. That was the probe, not the level.
        f.onTarget = Number.isFinite(pd) ? 1 : 0;
        f.blocked = Number.isFinite(pd) && pd >= wd ? 1 : 0;
        // Perpendicular miss distance to the eye, and the component of that
        // miss along the player's own direction of travel. A mean lateral of
        // zero across a strafing player is the whole leading measurement: a
        // shooter that led its target would bias this positive.
        const toP = g.camera.position.clone().sub(o);
        const along = Math.max(0, Math.min(toP.dot(d), Math.min(wd, 200)));
        const closest = o.clone().addScaledVector(d, along);
        f.missBy = closest.distanceTo(g.camera.position);
        // Where the aim point sits relative to the body it is shooting at.
        // enemyShoot() aims at g.camera.position — the EYE — while the hit test
        // is against the player's whole AABB, so the cone is centred near the top
        // of the target and everything above the head is guaranteed to miss.
        // Recorded as two numbers so a fix that re-centres the aim shows up.
        const cy = (box.min.y + box.max.y) * 0.5;
        f.aimAbove = g.camera.position.y - cy;
        f.dy = closest.y - cy;
        f.boxH = box.max.y - box.min.y;
        const v = g.player.velocity;
        const sp = Math.hypot(v.x, v.z);
        f.lateral = sp > 0.5
          ? (closest.x - g.camera.position.x) * (v.x / sp) + (closest.z - g.camera.position.z) * (v.z / sp)
          : null;
      }
      return fire0.apply(this, arguments);
    };

    /* ---- the soldier's visible surface vs its hittable surface --------- */
    //
    // "Part of the silhouette" is o.visible AND not an additive effect quad. The
    // muzzle flash is a Mesh with AdditiveBlending and depthWrite off whose
    // opacity is nonzero for ~45 ms per round; it is a light, not a surface, and
    // counting it as geometry would make the defect count depend on whether the
    // last round happened to be inside the decay window — which is exactly why
    // the untagged count read 7 on some runs and 8 on others. Both counts are
    // returned so the choice is auditable rather than buried here.
    rec.meshes = (enemy) => {
      const all = [], vis = [], tagged = [], untagged = [], effects = [];
      enemy.root.traverse((o) => {
        if (!o.isMesh) return;
        all.push(o);
        const m = o.material;
        const effect = !!m && (m.blending === THREE.AdditiveBlending || m.depthWrite === false);
        if (effect) { effects.push(o); return; }
        if (o.visible) vis.push(o);
        if (o.userData.zone) tagged.push(o);
        else if (o.visible) untagged.push(o);
      });
      return { all, vis, tagged, untagged, effects };
    };

    /**
     * Human-readable identity for a mesh nobody named.
     *
     * buildSoldier() never sets .name on anything, so a defect report has to be
     * reconstructed from geometry parameters, material and local offset — which
     * together map one-to-one onto the mk()/g() calls in ai.js. The "rifle:"
     * prefix is the one piece of semantics worth adding by hand, because every
     * untagged mesh on this model used to be part of the weapon and a list of
     * seven anonymous rounded boxes does not say that.
     */
    rec.describe = (o) => {
      const gm = o.geometry;
      const p = gm.parameters ?? {};
      let dims = '';
      if (p.width != null) dims = `${p.width.toFixed(3)}x${p.height.toFixed(3)}x${p.depth.toFixed(3)}`;
      else if (p.radiusTop != null) dims = `r${p.radiusTop.toFixed(3)}/${p.radiusBottom.toFixed(3)} h${p.height.toFixed(3)}`;
      else if (p.radius != null) dims = `r${p.radius.toFixed(3)}`;
      let rifle = false;
      for (const e of window.__GAME.director.enemies) {
        e.gun.traverse((x) => { if (x === o) rifle = true; });
      }
      const l = o.position;
      return `${rifle ? 'rifle:' : ''}${gm.type}[${dims}]`
        + ` mat#${o.material.color ? o.material.color.getHexString() : '??'}`
        + ` at(${l.x.toFixed(3)},${l.y.toFixed(3)},${l.z.toFixed(3)})`;
    };

    /**
     * A slab of the silhouette ray grid.
     *
     * Chunked by rows so no single evaluate can run long enough to look like a
     * hang. Rays start at the player's eye — the real one, wherever aimAt left
     * it — and cross a plane through the soldier's centre perpendicular to the
     * view, so the grid samples the silhouette as the player sees it.
     */
    rec.silhouette = ({ row0, rows, n, pad = 1.06 }) => {
      const e = g.director.enemies[0];
      const sets = rec.meshes(e);
      const box = new THREE.Box3();
      for (const m of sets.vis) box.expandByObject(m);
      const centre = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const o = g.camera.position.clone();
      const fwd = centre.clone().sub(o).normalize();
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
      const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
      const halfW = Math.max(size.x, size.z) * 0.5 * pad;
      const halfH = size.y * 0.5 * pad;

      const ray = new THREE.Raycaster();
      ray.far = 400;
      const out = {
        miss: 0, registered: 0, through: 0, shadowed: 0,
        zones: { head: 0, body: 0, limb: 0 },
        offenders: {}, shadowers: {},
        extent: [halfW * 2, halfH * 2], dist: o.distanceTo(centre),
      };
      const tmp = new THREE.Vector3();
      for (let iy = row0; iy < row0 + rows && iy < n; iy++) {
        const fy = n === 1 ? 0 : (iy / (n - 1)) * 2 - 1;
        for (let ix = 0; ix < n; ix++) {
          const fx = n === 1 ? 0 : (ix / (n - 1)) * 2 - 1;
          tmp.copy(centre).addScaledVector(right, fx * halfW).addScaledVector(up, fy * halfH);
          ray.set(o, tmp.sub(o).normalize());
          const hits = ray.intersectObjects(sets.vis, false);
          if (!hits.length) { out.miss++; continue; }
          const firstTagged = hits.find((h) => h.object.userData.zone);
          if (!firstTagged) {
            // Hit something the player can see, nothing the game will register.
            out.through++;
            const k = rec.describe(hits[0].object);
            out.offenders[k] = (out.offenders[k] ?? 0) + 1;
            continue;
          }
          out.registered++;
          out.zones[firstTagged.object.userData.zone] = (out.zones[firstTagged.object.userData.zone] ?? 0) + 1;
          if (!hits[0].object.userData.zone) {
            // Registers, but the surface the player aimed at is not the surface
            // that took the round. Milder than a pass-through, still a lie.
            out.shadowed++;
            const k = rec.describe(hits[0].object);
            out.shadowers[k] = (out.shadowers[k] ?? 0) + 1;
          }
        }
      }
      return out;
    };

    /**
     * Zone damage multipliers, measured out of enemy health.
     *
     * Each probe re-raycasts to learn which zone the ray really lands on, then
     * fires the game's own resolveBullet() and reads the health delta. The
     * expected unmultiplied damage is recomputed from the live SPEC and the
     * actual hit distance, so the multiplier is delta/raw and does not depend on
     * every ray landing at the same range.
     *
     * Health is topped back up before each shot: a 2.6x head hit kills a 100 HP
     * soldier in two rounds, and a dead enemy leaves director.raycast() with
     * nothing to hit.
     *
     * Rays the world would take first are skipped and counted. This is not
     * hygiene, it is the fix for a real wrong answer: the first version fired
     * every ray whose director.raycast() found a zone, and the low rays into the
     * boots reach the terrain before the leg, so resolveBullet() gave the round
     * to the ground and the health delta was zero. That reported a LIMB
     * MULTIPLIER OF 0.000 and the "a limb hit is worth less than a body shot"
     * check passed on it — a green line measuring dirt.
     */
    rec.zoneProbe = ({ n = 40 }) => {
      const e = g.director.enemies[0];
      const sets = rec.meshes(e);
      const box = new THREE.Box3();
      for (const m of sets.tagged) box.expandByObject(m);
      const centre = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const o = g.camera.position.clone();
      const fwd = centre.clone().sub(o).normalize();
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
      const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
      const S = rec.SPEC;
      const out = [];
      let eaten = 0;
      const tmp = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        const fy = (i / (n - 1)) * 2 - 1;
        for (const fx of [-0.35, -0.12, 0, 0.12, 0.35]) {
          tmp.copy(centre)
            .addScaledVector(right, fx * size.x * 0.5)
            .addScaledVector(up, fy * size.y * 0.5);
          const dir = tmp.sub(o).normalize();
          const hit = g.director.raycast(o, dir, S.range);
          if (!hit) continue;
          const wd = window.__SIM.rayWorld([o.x, o.y, o.z], [dir.x, dir.y, dir.z], S.range);
          if (hit.distance >= wd) { eaten++; continue; }
          const falloff = Math.max(0, Math.min(1,
            1 - (hit.distance - S.falloffStart) / (S.falloffEnd - S.falloffStart)));
          const raw = S.damage * (S.falloffScale + (1 - S.falloffScale) * falloff);
          e.health = 5000;
          const before = e.health;
          g.resolveBullet(o, dir, S.damage, true);
          out.push({ zone: hit.zone, delta: before - e.health, raw, d: hit.distance });
        }
      }
      e.health = 5000;
      e.alive = true;
      e.state = 'engage';
      return { probes: out, eaten };
    };

    return 'installed';
  });
}

/**
 * Re-points the taps after a setup(), and clears the record.
 *
 * setup() writes an *instance* damage stub for invulnerable:true and restores
 * whatever it captured for invulnerable:false. Either can shadow the prototype
 * tap — and on the very first vulnerable setup it restores the pre-tap function,
 * which is exactly the silent-zero failure this file is supposed to be immune
 * to. Deleting the instance property puts the tap back in the call path.
 */
async function arm(sim, vulnerable) {
  return sim.eval((v) => {
    const g = window.__GAME;
    if (v) { delete g.player.damage; g.player.__realDamage = undefined; }
    window.__AI.reset();
    return { own: Object.prototype.hasOwnProperty.call(g.player, 'damage'), health: g.player.health };
  }, vulnerable);
}

/** Everything the recorder saw. */
async function records(sim) {
  return sim.eval(() => ({
    fires: window.__AI.fires.map((f) => ({ ...f })),
    hits: window.__AI.hits.map((h) => ({ ...h })),
  }));
}

/* ------------------------------------------------------ one engagement -- */

/**
 * Places the player and one enemy `d` metres apart down a lane that is clear to
 * the world raycast, arms the taps, verifies the enemy can see the player at
 * t=0, and drives.
 *
 * The preconditions are returned rather than asserted, so a caller can report a
 * range as unusable instead of reporting its zero as an accuracy.
 */
function engagementFactory(sim, lane) {
  const a = lane.deg * Math.PI / 180;
  const yaw = a + Math.PI;            // player looks up the lane
  const origin = [-6, null, 17];
  const at = (d) => ({ x: origin[0] + Math.sin(a) * d, z: origin[2] + Math.cos(a) * d, facing: yaw });
  async function engage({
    d, seconds, dt = DT_LONG, health = 1e6, vulnerable = true, input = null,
    state = 'idle', sample = SAMPLE_AI,
  }) {
    const p = at(d);
    await sim.setup({
      position: origin, yaw, pitch: 0, ads: 0, invulnerable: !vulnerable, health,
      // facing back down the lane at the player: an enemy that has to turn
      // before it can see is measuring a turn rate, not a reaction.
      enemies: [{ x: p.x, z: p.z, facing: yaw, engage: state === 'engage' }],
    });
    await arm(sim, vulnerable);
    // Can it see, and can its round reach? Both from the page, both using the
    // same geometry the game uses: canSee() with the director's own blocker set,
    // and rayWorld() against level.raycastables — which is what eats an AI
    // round that clips a wall.
    const pre = await sim.eval(() => {
      const g = window.__GAME;
      const e = g.director.enemies[0];
      if (!e) return { ok: false, why: 'no enemy spawned' };
      const eye = e.eyePosition(new window.__THREE.Vector3());
      const cam = g.camera.position;
      const dir = cam.clone().sub(eye);
      const dd = dir.length();
      dir.divideScalar(dd);
      const wd = window.__SIM.rayWorld([eye.x, eye.y, eye.z], [dir.x, dir.y, dir.z], 240);
      return {
        ok: true,
        sees: e.canSee(cam, g.director.blockers),
        dist: dd, world: wd, clearFire: wd > dd - 0.4,
        health: g.player.health, alive: g.player.alive, state: e.state,
      };
    });
    const rows = await sim.drive({ seconds, dt, input, sample });
    const rec = await records(sim);
    return { pre, rows, ...rec, t0: rows.length ? rows[0].t - dt : 0, d };
  }
  engage.at = at;
  engage.yaw = yaw;
  engage.origin = origin;
  return engage;
}

/* ---------------------------------------------------------------- suite -- */

export default async function run(sim, report) {
  const state = await install(sim);
  report.check('the AI probe installed its taps', state === 'installed' || state === 'already installed',
    `3 prototype/instance taps wrapped — Enemy.shoot, Player.damage, vfx.tracers.fire (${state})`);

  // One long clear lane, reused by every engagement. 60 m of AI accuracy
  // measured across a courtyard wall would be a measurement of the wall. The
  // sweep is horizontal at eye height, which is not the line an AI round takes —
  // the muzzle is lower and the terrain in between is not flat — so the share of
  // the AI's fire that the ground eats is measured per range below rather than
  // assumed away here.
  const lane = await sim.clearLane([-6, null, 17], 130);
  const engage = engagementFactory(sim, lane);
  report.check('a clear lane exists for the engagement ranges',
    lane.clear > 65,
    `${f2(lane.clear)} m unobstructed on heading ${lane.deg} deg from the spawn — the longest range `
    + 'measured below is 60 m');

  try {
    /* ============================== 0. instrument liveness ============== */
    //
    // Before a single AI number is quoted, prove the three channels are
    // independent and that each one can read both of its states. A suite whose
    // taps are dead reports a perfectly quiet, perfectly accurate enemy.

    // (a) rounds are counted, and silence is distinguishable from misses.
    const live = await engage({ d: 18, seconds: 4, dt: DT_LONG, state: 'engage' });
    report.check('the enemy fires and the round tap counts rounds',
      live.fires.length > 0,
      `${live.fires.length} rounds in 4.0 s at ${f2(live.d)} m (state at t0: ${live.pre.state}, `
      + `sees=${live.pre.sees})`);

    {
      const p = engage.at(18);
      await sim.setup({
        position: engage.origin, yaw: engage.yaw, invulnerable: false, health: 1e6,
        enemies: [{ x: p.x, z: p.z, facing: p.facing, engage: true, inert: true }],
      });
      await arm(sim, true);
      await sim.drive({ seconds: 4, dt: DT_LONG, sample: SAMPLE_AI });
      const silent = await records(sim);
      report.check('an inert enemy reads as zero rounds, not as misses',
        silent.fires.length === 0 && silent.hits.length === 0,
        `${silent.fires.length} rounds and ${silent.hits.length} hits with shoot() silenced, against `
        + `${live.fires.length} rounds from the same placement live — "never fired" and "fired and missed" `
        + 'are separate readings');
    }

    // (b) hits are counted, and the invulnerable path is visibly a separate
    //     channel: same engagement, same rounds, zero damage.
    const inv = await engage({ d: 12, seconds: 4, dt: DT_LONG, state: 'engage', vulnerable: false });
    const vul = await engage({ d: 12, seconds: 4, dt: DT_LONG, state: 'engage', vulnerable: true });
    report.check('the hit tap reads hits only when the player is vulnerable',
      inv.hits.length === 0 && vul.hits.length > 0,
      `invulnerable: ${inv.fires.length} rounds / ${inv.hits.length} hits; vulnerable: `
      + `${vul.fires.length} rounds / ${vul.hits.length} hits at 12 m`);

    // (c) the damage tap and the independently recomputed ray geometry must
    //     agree round for round. If they do not, one of them is wrong and every
    //     accuracy figure below is suspect — so this is the check that makes the
    //     accuracy curve mean anything.
    {
      const gg = vul.fires.filter((f) => f.geom !== null);
      const agree = gg.filter((f) => (f.hits > 0 ? 1 : 0) === f.geom).length;
      report.check('the hit tap agrees with the recomputed shot geometry',
        gg.length > 0 && agree === gg.length,
        `${agree}/${gg.length} rounds classified identically by Player.damage() and by an independent `
        + 'ray-vs-player-AABB test');
    }

    // (d) the player's health pool, measured behaviourally and WITHOUT the test
    //     writing it.
    //
    //     The previous version of this check called setup({health: 100}) and then
    //     asserted that 100 HP was absorbed before death. It measured the number
    //     it had just written: raising TUNING.maxHealth to 175 left it green at
    //     "measured 100.0 HP, off by 0.0%". So the pool is read off the
    //     regeneration ceiling instead — the game's own regen clamps at
    //     maxHealth, so a player left alone long enough saturates at the pool
    //     size, and nothing in this file chose that number. The kill trial then
    //     starts from that saturated state, with the enemy spawned in on top of
    //     it rather than through another setup().
    let healthPool = NaN;
    {
      await sim.setup({ position: engage.origin, yaw: engage.yaw, invulnerable: false, health: 22, enemies: [] });
      await arm(sim, true);
      const heal = await sim.drive({ seconds: 16, dt: DT_LONG, sample: 'return {}' });
      const start = heal[0].health;
      healthPool = heal[heal.length - 1].health;
      report.check('the player regenerates to a ceiling, so the pool can be read off it',
        healthPool > start && healthPool === heal[heal.length - 40].health,
        `health rose from ${f2(start)} HP to ${f2(healthPool)} HP over 16.0 s and was flat for the last `
        + '0.33 s — the ceiling is the pool, and no line of this suite wrote it');
      report.against('player health pool (regeneration ceiling)', healthPool, 'damage', 'health_mw2019');
      // Then how much of it can be taken away, through the game's own
      // Player.damage(), with no sim step between calls so regeneration cannot
      // interfere.
      //
      // Driving this with a real enemy was tried twice and is the wrong
      // instrument. At 12 m the fight lasts longer than TUNING.regenDelay
      // between bursts, so the player absorbed 142.7 HP against a 100 HP
      // ceiling — a correct reading of a fight with healing in it and a useless
      // reading of a health pool. Moved to 8 m to beat the regen delay, the
      // soldier repositioned out to its preferred 16 m and never finished. The
      // pool is not an AI quantity; the AI is measured everywhere else here.
      const pool = await sim.eval((step) => {
        const g = window.__GAME;
        let absorbed = 0, requested = 0, calls = 0, deathCall = -1;
        while (g.player.alive && calls < 400) {
          const before = g.player.health;
          calls++;
          g.player.damage(step);
          absorbed += before - g.player.health;
          requested += step;
          if (deathCall < 0 && !g.player.alive) deathCall = calls;
        }
        return { absorbed, requested, calls, deathCall };
      }, 7);
      report.check('the health the player can regenerate to is the health he can lose',
        Math.abs(pool.absorbed - healthPool) < 1.5,
        `${f2(pool.absorbed)} HP absorbed over ${pool.calls} calls of 7 HP through the game's own `
        + `Player.damage() before it stopped counting the player alive, against the ${f2(healthPool)} HP `
        + 'regeneration ceiling measured above. Nothing in this suite wrote either number');
      // The reconstruction the TTK section relies on: cumulative REQUESTED damage
      // crossing the pool must land on the same round that kills. Not the same
      // statement as the one above — Player.damage() clamps at zero, so the
      // killing round is credited with its full overkill and the two sums differ
      // by exactly that much.
      report.check('cumulative-damage TTK reconstruction lands on the killing round',
        pool.deathCall === Math.ceil(healthPool / 7),
        `death on call ${pool.deathCall} of 7 HP; cumulative ${f2(healthPool)} HP is crossed on call `
        + `${Math.ceil(healthPool / 7)}, and ${f2(pool.requested)} HP was requested to absorb `
        + `${f2(pool.absorbed)} HP`);
    }

    /* ================================ 1. reaction time ================= */
    //
    // From the first instant the enemy can see the player to the first round
    // leaving its barrel, over many engagements. Each trial is a fresh
    // engagement at a different range, so each one draws a fresh reaction roll
    // out of the seeded stream rather than replaying one sample thirty times.
    //
    // The decomposition is the point, and it is why this section is three
    // assertions rather than one. Whether the median lands on the sourced 0.25 s
    // and whether the tails stay inside the sourced 0.20-0.40 s band are
    // different failures: a bot can be centred correctly and still have a p90
    // that reads as a hesitation, and a bot with no spread at all is a robot
    // whatever its median.
    let reactionMedian = NaN;
    {
      const RANGES = [12, 16, 20, 24, 28, 32];
      const REPEATS = 4;
      const total = [], legAlert = [], legEngage = [], legFire = [], firstDist = [];
      let unseen = 0, noShot = 0;
      for (let r = 0; r < REPEATS; r++) {
        for (const d of RANGES) {
          const e = await engage({ d, seconds: 2.2, dt: DT_FINE, state: 'idle', vulnerable: false });
          if (!e.pre.sees) { unseen++; continue; }
          // t0 is the instant before the first driven tick, i.e. the instant the
          // precondition above was true. Reaction is measured from there.
          const tAlert = e.rows.find((x) => x.est === 'alert')?.t ?? NaN;
          const tEng = e.rows.find((x) => x.est === 'engage')?.t ?? NaN;
          const first = e.fires[0];
          if (!first) { noShot++; continue; }
          total.push(first.t - e.t0);
          legAlert.push(tAlert - e.t0);
          legEngage.push(tEng - tAlert);
          legFire.push(first.t - tEng);
          firstDist.push(first.dist);
        }
      }
      report.check('every reaction trial produced a first round',
        unseen === 0 && noShot === 0 && total.length === RANGES.length * REPEATS,
        `${total.length}/${RANGES.length * REPEATS} trials usable — ${unseen} discarded for no line of `
        + `sight at t0, ${noShot} for no round inside 2.2 s`);
      report.reached('the reaction distribution has a median to report', median(total),
        `${dist(total, 'ms')} at ${f2(median(firstDist))} m median engagement range`);
      reactionMedian = median(total);

      report.against('AI reaction time, median (first sight -> first round)',
        reactionMedian, 'ai', 'ai_reaction_delay_base');
      // The tails against the sourced band, which is the entry whose tolerance
      // IS the band (value: null, tol {min, max}). A median inside 0.25 s with a
      // p90 outside 0.40 s is a bot that is usually fair and occasionally asleep,
      // and that is the failure a median alone cannot see.
      report.against('AI reaction time, p10', quant(total, 0.1), 'ai', 'ai_reaction_delay_range');
      report.against('AI reaction time, p90', quant(total, 0.9), 'ai', 'ai_reaction_delay_range');
      report.check('the reaction distribution is ordered and has spread',
        quant(total, 0.1) < reactionMedian && reactionMedian < quant(total, 0.9)
        && quant(total, 0.9) - quant(total, 0.1) > 0.03,
        `p10 ${ms(quant(total, 0.1))} < median ${ms(reactionMedian)} < p90 ${ms(quant(total, 0.9))}, `
        + `spread ${ms(quant(total, 0.9) - quant(total, 0.1))} across ${total.length} engagements. A constant `
        + 'reaction is a robot; the 30 ms floor is structural, not a sourced figure');
      // Where the time goes, so a regression can be attributed without a
      // bisect. ALERT->ENGAGE is the reaction roll itself; ENGAGE->round should
      // now be one tick, because ENGAGE arms and fires the burst on the same
      // tick and fireTimer is armed at zero on the transition.
      report.measure('reaction leg: first sight -> ALERT', median(legAlert), 's',
        'the line-of-sight schedule re-tests one agent in three ticks, so up to 2 ticks land here');
      report.measure('reaction leg: ALERT -> ENGAGE', median(legEngage), 's',
        'the CONFIG.reactionTime roll, which is now the whole of the reaction');
      report.measure('reaction leg: ENGAGE -> first round', median(legFire), 's',
        'was 0.12-0.34 s of fresh fireTimer plus a tick spent arming the burst without firing it');
    }

    /* ============================ 2. accuracy vs range ================= */
    //
    // Hits landed / rounds fired against a stationary, vulnerable player with
    // 1e6 HP. The oversized health pool is deliberate: at 100 HP the player dies
    // nine hits in, the enemy stops seeing a corpse, and the sample ends
    // whenever the AI happens to be accurate. Regen never enters — health is
    // above the pool measured in section 0(d), so the regen branch is closed —
    // and hits are counted as damage() calls regardless.
    //
    // Rounds are bucketed by the distance the AI itself used to compute its
    // spread cone, so a soldier that repositions mid-engagement lands in the
    // bucket it actually shot from rather than the one it spawned in.
    //
    // There is no sourced accuracy figure and there is not going to be one, so
    // the numbers are MEAS rows and the assertions are three structural
    // statements about the shape. Six ranges rather than four: the structural
    // floor on adjacent ranges only means something if the ranges are close
    // enough together that a 10 m step is a small ask.
    const RANGES = [10, 20, 30, 40, 50, 60];
    const TRIALS = 12;
    const WINDOW = 8;
    const acc = new Map();
    const ttk = new Map();
    for (const d of RANGES) {
      const rec = {
        d, fired: 0, hit: 0, blocked: 0, onTarget: 0, misses: [], dists: [], amounts: [],
        aimAbove: [], dys: [], boxH: [],
        unusable: 0, drift: 0, trials: 0, engageTicks: 0, ticks: 0,
      };
      const ttks = [];
      for (let i = 0; i < TRIALS; i++) {
        const e = await engage({ d, seconds: WINDOW, dt: DT_LONG, state: 'engage', vulnerable: true });
        if (!e.pre.sees || !e.pre.clearFire) { rec.unusable++; continue; }
        rec.trials++;
        rec.ticks += e.rows.length;
        // How much of the window the agent spent in contact at all. Without this
        // the round count per range is a mystery: at 10 m pickCover() scores
        // cover points by |distToPlayer - 16|, so a soldier that starts inside
        // that band immediately wants to back out of it and stops shooting.
        rec.engageTicks += e.rows.filter((r) => r.est === 'engage').length;
        let cum = 0, tCross = NaN, tFirst = NaN;
        for (const f of e.fires) {
          // A round fired from a range far off the nominal one belongs to a
          // different measurement; count it and drop it rather than smearing
          // the curve.
          if (Math.abs(f.dist - d) > 0.15 * d + 1) { rec.drift++; continue; }
          rec.fired++;
          rec.dists.push(f.dist);
          if (f.onTarget) rec.onTarget++;
          if (f.blocked) rec.blocked++;
          if (f.hits > 0) { rec.hit++; rec.amounts.push(f.amount); }
          if (Number.isFinite(f.missBy) && !f.hits) rec.misses.push(f.missBy);
          if (Number.isFinite(f.aimAbove)) { rec.aimAbove.push(f.aimAbove); rec.boxH.push(f.boxH); }
          if (Number.isFinite(f.dy)) rec.dys.push(f.dy);
          if (!Number.isFinite(tFirst)) tFirst = f.t;
          cum += f.amount;
          if (cum >= healthPool && !Number.isFinite(tCross)) tCross = f.t;
        }
        if (Number.isFinite(tCross)) ttks.push(tCross - tFirst);
        else ttks.push(Infinity);      // censored: did not kill inside the window
      }
      acc.set(d, rec);
      ttk.set(d, ttks);
    }
    const rate = (d) => acc.get(d).hit / acc.get(d).fired;

    report.check('AI accuracy was measured at every range',
      RANGES.every((d) => acc.get(d).fired >= 20),
      `rounds fired per range: ${RANGES.map((d) => {
        const r = acc.get(d);
        return `${d} m ${r.fired}/${r.trials} trials (${pct(r.engageTicks / r.ticks)} of the window in ENGAGE)`;
      }).join(', ')} `
      + `(${RANGES.reduce((s, d) => s + acc.get(d).unusable, 0)} trials discarded for no LOS or a blocked `
      + `lane, ${RANGES.reduce((s, d) => s + acc.get(d).drift, 0)} rounds discarded for repositioning out of `
      + 'the range bucket)');

    for (const d of RANGES) {
      const r = acc.get(d);
      report.measure(`AI accuracy at ${d} m`, rate(d), '',
        `${r.hit}/${r.fired} rounds over ${r.trials} engagements — no sourced target exists `
        + '(targets.mjs lists ai_accuracy in its own missing() set and says why)');
    }

    // The three structural statements. Each is one property, so one cause
    // cannot light up all three, and none of them constrains the LEVEL of the
    // curve — only its shape.
    {
      const ratios = RANGES.slice(1).map((d, i) => rate(d) / rate(RANGES[i]));
      const curve = RANGES.map((d) => `${d} m ${pct(rate(d))}`).join(', ');
      // Two-proportion standard error per step, and the step has to be
      // non-increasing WITHIN THE NOISE rather than exactly non-increasing. A
      // hit rate over ~70 rounds carries about 4 points of standard error, so at
      // 40 m and 50 m — 3 points apart in truth — a strict test is a coin flip
      // that reports the AI red on the toss. The critic of the previous version
      // of this file found exactly that failure mode in a hard 10% gate on the
      // strafing difference, and flipped its colour by editing an unrelated
      // constant. 2 s.e. is the allowance; the failure it can still catch is a
      // step that rises by more than sampling can explain.
      const se = RANGES.slice(1).map((d, i) => {
        const a = acc.get(RANGES[i]), b = acc.get(d);
        const pa = rate(RANGES[i]), pb = rate(d);
        return Math.sqrt(pa * (1 - pa) / a.fired + pb * (1 - pb) / b.fired);
      });
      report.check('AI accuracy decreases monotonically with range',
        RANGES.slice(1).every((d, i) => Number.isFinite(rate(d))
          && rate(d) <= rate(RANGES[i]) + 2 * se[i]),
        `${curve}; step changes ${RANGES.slice(1).map((d, i) => `${RANGES[i]}->${d} m `
          + `${pct(rate(d) - rate(RANGES[i]))} +/- ${pct(se[i])}`).join(', ')} — no step may RISE by more `
        + 'than two standard errors, or distance does not protect the player, which is the single most common '
        + 'complaint about hitscan AI');
      const best = Math.max(...RANGES.map(rate));
      report.check('no engagement range is a certainty for the AI',
        best <= 0.90,
        `best measured hit rate ${pct(best)} at ${RANGES[RANGES.map(rate).indexOf(best)]} m over `
        + `${acc.get(RANGES[RANGES.map(rate).indexOf(best)]).fired} rounds. Structural: at least one round in `
        + 'ten must miss somewhere in the 10-60 m band measured here, because a bot that cannot miss is not a '
        + 'fight. Not a sourced CoD figure — no accuracy figure is published');
      // The exponent of the whole curve, not one adjacent step.
      //
      // The bound is mechanical rather than chosen. A shooter whose error is a
      // fixed angular cone puts a circle of radius proportional to range on a
      // target of fixed size, so its hit rate falls as range^-2 once the circle
      // is larger than the target — that IS the cliff, and it is what the
      // measured baseline does: fitting ln(hit rate) against ln(range) over
      // 10-60 m on the unmodified game gives an exponent of -2.0 with hit rates
      // of 98.0% at 10 m and 9.1% at 40 m. So "a curve rather than a step" has a
      // precise meaning available: the falloff must be measurably shallower than
      // the inverse square a pure cone produces for free. -1.8 is that statement
      // with room for sampling error; the second bound, -0.5, is the other
      // failure — a curve too flat to make backing away worth anything.
      //
      // Fitted over all six ranges rather than compared step to step because a
      // single 10 m step is a ratio of two hit rates carrying ~3 points of
      // standard error each, and the step-to-step figure swung between 0.40 and
      // 0.96 across runs that differed only in where the seeded stream had got
      // to. The variation is which patch of ground each trial was fought over,
      // not the cone; a fit over six points is not moved by it.
      const xs = RANGES.map((d) => Math.log(d));
      const ys = RANGES.map((d) => Math.log(rate(d)));
      const mx = mean(xs), my = mean(ys);
      const slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0)
        / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
      report.check('the falloff is a curve, not a step',
        Number.isFinite(slope) && slope > -1.8 && slope < -0.5,
        `hit rate falls as range^${f2(slope)} fitted over ${RANGES.length} ranges, required inside `
        + '(-1.8, -0.5). A fixed angular cone gives range^-2 mechanically, and the measured baseline gave '
        + `range^-2.01. Adjacent-step ratios for reference: ${ratios.map(f2).join(', ')}`);
    }

    // How badly it misses when it misses — a soldier missing by 20 cm and one
    // missing by 4 m are different opponents at the same hit rate. Guarded
    // first: the previous version's monotonicity predicate skipped non-finite
    // entries, so "no misses at any range" passed it vacuously.
    {
      const counts = RANGES.map((d) => acc.get(d).misses.length);
      report.check('every range produced enough misses to measure a miss distance',
        counts.every((n) => n >= 5),
        `misses per range: ${RANGES.map((d, i) => `${d} m ${counts[i]}`).join(', ')} — the monotonicity `
        + 'check below is vacuous without this, which is how it passed on four ranges with zero misses each');
      const missMed = RANGES.map((d) => median(acc.get(d).misses));
      report.check('AI miss distance grows with range',
        missMed.every((v) => Number.isFinite(v))
        && missMed.every((v, i) => i === 0 || v >= missMed[i - 1]),
        RANGES.map((d, i) => `${d} m ${f2(missMed[i])} m`).join(', ')
        + ' median perpendicular miss at the eye');
    }

    // Where the AI is aiming on the body. This is a finding about
    // main.enemyShoot(), which is not this suite's file to fix: it aims at
    // g.camera.position — the eye — while the hit test is against the player's
    // whole AABB, so the cone is centred 0.75 m above the middle of the target
    // and its entire upper half is thrown away over the head. Measured, not
    // asserted, because the owner of the fix is another agent's file; the
    // consequence is in the second and third numbers.
    {
      const aimAbove = RANGES.flatMap((d) => acc.get(d).aimAbove);
      const dys = RANGES.flatMap((d) => acc.get(d).dys);
      const h = median(RANGES.flatMap((d) => acc.get(d).boxH));
      report.measure('AI aim point above the centre of the player AABB', median(aimAbove), 'm',
        `${pct(median(aimAbove) / h)} of the ${f2(h)} m body box, over ${aimAbove.length} rounds — `
        + 'main.enemyShoot() aims at camera.position, i.e. the eye');
      report.measure('height of the AI round above the player centre, p90', quant(dys, 0.9), 'm',
        `median ${f2(median(dys))} m, so the top of the cone lands ${f2(quant(dys, 0.9) - h / 2)} m over `
        + 'the head; every one of those rounds is a guaranteed miss whatever the spread is tuned to');
    }

    // Rounds the world ate on their way to a player they would otherwise have
    // hit. Only on-target rounds can be blocked: counting every round whose
    // world hit came first counts every miss, since a miss never intersects the
    // player's box at all. That mistake reported 69% of the AI's fire as eaten
    // by walls and would have condemned the level for the AI's cone.
    {
      const blocked = RANGES.reduce((s, d) => s + acc.get(d).blocked, 0);
      const onT = RANGES.reduce((s, d) => s + acc.get(d).onTarget, 0);
      // Expressed against ROUNDS FIRED, not against on-target rounds, and tested
      // per range rather than in aggregate. Against on-target rounds the figure
      // answers a question nobody asked — at 60 m a wide cone puts only 10 of 63
      // rounds on the player's box at all, so 7 of those 10 clipping the ground
      // reads as 70% and sounds catastrophic while costing the hit rate 11
      // points. Against rounds fired it is exactly the amount by which the
      // measured hit rate understates the AI's aim, which is the thing a reader
      // of the curve needs to know. 25% is the point past which the curve stops
      // being an AI measurement and becomes a joint measurement of the AI and the
      // terrain; it is a validity threshold for this instrument, not a CoD figure.
      const worst = Math.max(...RANGES.map((d) => {
        const r = acc.get(d);
        return r.fired ? r.blocked / r.fired : 0;
      }));
      report.check('the measured misses are misses and not walls',
        worst < 0.25,
        `${blocked}/${onT} on-target rounds were stopped by level geometry before reaching the player, which `
        + `is ${pct(worst)} of rounds fired at the worst range: `
        + `${RANGES.map((d) => `${d} m ${acc.get(d).blocked}/${acc.get(d).fired}`).join(', ')}. `
        + 'A round aimed at the eye that clips a rise in the ground short of the player is a real miss in the '
        + 'game, but it means the hit rate at that range understates the AI by this fraction');
    }

    /* =============================== 3. AI time to kill ================ */
    //
    // Against a stationary player, per range, as a distribution. Measured from
    // the AI's first round to the round that carries cumulative damage past the
    // health pool measured in 0(d) — the reconstruction validated there — so the
    // same engagements that produced the accuracy curve produce the TTK, and the
    // censored trials ("never killed inside the window") are visible rather than
    // being dropped into a median that then looks fast. No sourced target: the
    // damage.* TTK entries are the PLAYER's weapon against a player, not a bot's.
    {
      const meds = RANGES.map((d) => median(ttk.get(d).filter(Number.isFinite)));
      const series = [];
      for (const [i, d] of RANGES.entries()) {
        const all = ttk.get(d);
        const done = all.filter(Number.isFinite);
        const r = acc.get(d);
        const engS = r.engageTicks * DT_LONG;
        const proj = healthPool / ((engS ? r.fired / engS : NaN) * rate(d) * mean(r.amounts));
        series.push({ d, t: proj, observed: done.length > 0 });
        if (done.length) {
          report.measure(`AI time-to-kill at ${d} m`, meds[i], 's',
            `${dist(done, 'ms')}; ${all.length - done.length}/${all.length} engagements never dealt `
            + `${f2(healthPool)} HP inside the ${f2(WINDOW)} s window`);
        } else {
          // Censored, not defective, and reported as a projection built only out
          // of measured quantities — hit rate, rounds per second sustained while
          // in contact, and mean damage per hit. A red row here would say the AI
          // is broken at 40 m when what it actually says is that 6.5 s is not
          // long enough to kill through a 17% hit rate, which is the design.
          report.measure(`AI time-to-kill at ${d} m, projected`, proj, 's',
            `no engagement killed inside the ${f2(WINDOW)} s window across ${all.length} trials, so this is `
            + `${f2(healthPool)} HP divided by ${pct(rate(d))} of ${f2(engS ? r.fired / engS : NaN)} rounds/s `
            + `at ${f2(mean(r.amounts))} HP per hit — an extrapolation from measured quantities that assumes `
            + 'unbroken contact, not an observed kill');
        }
      }
      report.check('the AI can kill a stationary player somewhere in the measured band',
        meds.some(Number.isFinite),
        `observed kills at ${RANGES.filter((d, i) => Number.isFinite(meds[i])).join(', ') || 'no'} m of `
        + `${RANGES.join(', ')} m — an enemy that cannot finish a target that never moves is not an `
        + 'opponent at any range');
      // Monotonicity, which is a property of the design rather than of a sourced
      // number: killing must not get faster as the player backs away. Asserted on
      // the PROJECTED series at every range, including the ranges where a kill
      // was observed, because that is the only basis on which the six numbers are
      // comparable: an observed median includes whatever time the agent spent out
      // of contact in that particular window, so mixing observed and projected
      // values produced a series that fell from 7.2 s at 10 m to 4.8 s at 30 m
      // and failed a check about the AI on a property of pickCover's preferred
      // engagement range. Observed medians are reported above.
      // Asserted end to end rather than step by step. Every step of this series
      // inherits the sampling noise of the hit rate it is built from, so six
      // pairwise comparisons at ~4 points of standard error each is six chances
      // to fail on a toss; the 10-to-60 m comparison is far outside that noise
      // and is the statement that matters — backing away has to buy the player
      // time.
      const near = series[0].t, far = series[series.length - 1].t;
      report.check('AI time-to-kill does not improve with range',
        Number.isFinite(near) && Number.isFinite(far) && far >= 2 * near,
        series.map((s) => `${s.d} m ${ms(s.t)}${s.observed ? ' (also observed)' : ''}`).join(', ')
        + ` — all six projected from measured hit rate, rounds/s in contact and HP per hit; `
        + `${RANGES[RANGES.length - 1]} m is ${f2(far / near)}x the ${RANGES[0]} m figure against a `
        + 'structural floor of 2x');
    }

    /* ============================= 4. engagement pacing ================ */
    //
    // Burst length, inter-burst delay, and where the enemy's time goes.
    {
      // Bursts are split on the agent's own burstLeft counter, not on the gap
      // between rounds. burstLeft is rolled once out of CONFIG.burstCount and
      // then counts down one per round, so a round whose burstLeft is not
      // exactly one less than the previous round's begins a new roll — and that
      // is true however long the pause in the middle was. Splitting on timing
      // instead reported a "rolled burst length of 1", outside CONFIG.burstCount
      // [2, 5], for a five-round burst the agent paused halfway through because
      // it lost the sight line: the resumed remainder looked like a fresh burst
      // that had rolled 1. That is a splitter artefact and it would have been
      // read as a tuning violation.
      const bursts = [];
      const split = (fires) => {
        let prev = null;
        for (const f of fires) {
          const cont = prev !== null && f.bl === prev - 1;
          if (cont) {
            const b = bursts[bursts.length - 1];
            b.end = f.t; b.n++;
          } else {
            // `intended` is burstLeft on the burst's first round, which is the
            // count the agent rolled out of CONFIG.burstCount.
            bursts.push({ start: f.t, end: f.t, n: 1, intended: f.bl, first: false });
          }
          prev = f.bl;
        }
      };
      // Burst shape comes from several short engagements rather than one long
      // one. It has to: in a 26 s firefight this agent leaves ENGAGE for cover
      // early and spends most of the rest of the run out of contact (see the
      // occupancy figure below), so one long run yields two bursts and a median
      // burst length measured on a sample of two.
      let contactSpan = 0, contactRounds = 0;
      for (let i = 0; i < 6; i++) {
        const s = await engage({ d: 18, seconds: 8, dt: DT_LONG, state: 'engage', vulnerable: true });
        const before = bursts.length;
        split(s.fires);
        // Inter-burst gaps must not be taken across the seam between two
        // engagements, so each run's first burst is marked and the gap before it
        // is dropped.
        if (bursts.length > before) bursts[before].first = true;
        contactSpan += s.rows.filter((r) => r.est === 'engage').length * DT_LONG;
        contactRounds += s.fires.length;
      }
      const lens = bursts.map((b) => b.n);
      const gaps = [];
      for (let i = 1; i < bursts.length; i++) {
        // Not across the seam between two engagements, and not after a burst the
        // agent abandoned: fireInterval is armed when a burst SPENDS its roll, so
        // a burst cut short by losing contact leaves the old timer already
        // expired and the next burst legitimately starts the moment contact
        // resumes. Counting those would put a 0 ms gap in the distribution and
        // make the floor below unassertable.
        if (!bursts[i].first && bursts[i - 1].n === bursts[i - 1].intended) {
          gaps.push(bursts[i].start - bursts[i - 1].end);
        }
      }
      const inBurst = bursts.reduce((s, b) => s + (b.end - b.start), 0);

      // The long run, for where an enemy's time actually goes.
      const e = await engage({ d: 18, seconds: 26, dt: DT_LONG, state: 'engage', vulnerable: true });
      const span = e.rows.length ? e.rows[e.rows.length - 1].t - e.rows[0].t : NaN;
      const frac = {};
      for (const r of e.rows) frac[r.est] = (frac[r.est] ?? 0) + 1;
      const fracStr = Object.entries(frac).map(([k, v]) => `${k} ${pct(v / e.rows.length)}`).join(', ');

      report.check('engagement pacing was measured over enough bursts to have a shape',
        bursts.length >= 8,
        `${contactRounds} rounds in ${bursts.length} bursts across 6 engagements of 8.0 s at 18 m, `
        + `${f2(contactSpan)} s of that in contact; plus one ${f2(span)} s run for state occupancy`);
      // Burst length is held to CONFIG.burstCount, which is the one AI pacing
      // quantity with a stated intent to be held to. The bounds are duplicated
      // here as literals on purpose: reading them from ai.js would make both
      // sides of the comparison move together, and the point of this row is that
      // it goes red when someone retunes the roll.
      const intended = bursts.map((b) => b.intended);
      const outside = intended.filter((n) => n < 2 || n > 5).length;
      report.check('the burst lengths the AI rolls stay inside CONFIG.burstCount [2, 5]',
        intended.length > 0 && outside === 0,
        `rolled ${intended.join('/')} — median ${f2(median(intended))} rounds [p10 `
        + `${f2(quant(intended, 0.1))} .. p90 ${f2(quant(intended, 0.9))}], ${outside}/${intended.length} `
        + 'outside [2, 5]');
      const cut = bursts.filter((b) => b.n < b.intended).length;
      const merged = bursts.filter((b) => b.n > b.intended).length;
      // Two directions, two rows, because they have different causes and only
      // one of them is a defect. A run LONGER than its roll is bursts merging:
      // fireTimer used to be decremented during the burst, so five rounds at
      // 0.098 s spacing ate 0.39 s of a 0.42 s interval and the next burst began
      // ~30 ms after the last ended — the player heard one long burst and the
      // rolled burstCount was fiction. A run SHORTER than its roll is the ENGAGE
      // branch declining to advance a burst it cannot see the target through,
      // which is correct behaviour and is measured rather than asserted.
      report.check('no burst runs longer than the count the AI rolled',
        merged === 0,
        `delivered ${lens.join('/')} against ${intended.join('/')} rolled: ${merged} runs longer than the `
        + `roll; shortest observed gap between bursts ${ms(Math.min(...gaps))} against a CONFIG.fireInterval `
        + 'floor of 420 ms, which is now timed from the end of the burst rather than its start');
      report.measure('bursts abandoned before the roll was spent', cut / bursts.length, 'fraction',
        `${cut}/${bursts.length} bursts delivered fewer rounds than rolled. The ENGAGE branch only advances a `
        + 'burst while it can see the player, so a burst the agent leaves contact in the middle of is never '
        + 'finished — and because the split is on burstLeft rather than on timing, a burst that merely PAUSED '
        + 'and resumed does not count here');
      report.measure('AI inter-burst delay', median(gaps), 's',
        `${dist(gaps, 'ms')} between the last round of a burst and the first of the next, against a `
        + 'CONFIG.fireInterval of [0.42, 1.15] s now timed from the end of the burst');
      // The pacing defect, asserted. fireTimer used to be decremented DURING the
      // burst, so a five-round burst at 0.098 s spacing consumed 0.39 s of a
      // 0.42 s interval and the next burst opened ~30 ms after the last one
      // closed: the player heard one long burst and the 420 ms floor in
      // CONFIG.fireInterval described nothing. Measured baseline p10 was 227 ms.
      // The bound is CONFIG's own floor, duplicated as a literal on purpose —
      // reading it from ai.js would make both sides of the comparison move
      // together — with one tick of slack for the interval being consumed in
      // whole ticks.
      report.check('the gap between bursts respects the CONFIG.fireInterval floor of 420 ms',
        gaps.length > 0 && Math.min(...gaps) >= 0.42 - DT_LONG,
        `shortest gap ${ms(Math.min(...gaps))} over ${gaps.length} completed-burst transitions, `
        + `distribution ${dist(gaps, 'ms')}`);
      report.measure('AI firing duty cycle', inBurst / contactSpan, 'fraction of contact inside a burst',
        `${f2(contactRounds / contactSpan)} rounds/s while in contact`);
      // The number that reframes every pacing figure above: over a 26 s firefight
      // this agent is out of contact much of the time. It repositions to a cover
      // point chosen by pickCover() — which scores for cover, not for sight
      // lines — loses LOS there, decays out of ALERT into IDLE, and stops looking
      // for the player it was fighting five seconds earlier.
      report.check('the enemy stays in contact through a long firefight',
        (frac.idle ?? 0) / e.rows.length < 0.10,
        `state occupancy over ${f2(span)} s: ${fracStr} across ${e.rows.length} ticks; `
        + `${pct((frac.idle ?? 0) / e.rows.length)} of it in IDLE — a soldier that has forgotten the player `
        + 'entirely. Structural floor of 10%, not a sourced CoD figure');

      // Does it move at all? A soldier that stands in the open for 26 s of
      // sustained fire is a target, not an opponent — and this is a structural
      // statement, not a CoD figure.
      const moved = Math.max(...e.rows.map((r) => Math.hypot(r.ex - e.rows[0].ex, r.ez - e.rows[0].ez)));
      report.check('the enemy repositions during a long engagement',
        (frac.reposition ?? 0) > 0 && moved > 1,
        `${pct((frac.reposition ?? 0) / e.rows.length)} of ticks in REPOSITION, maximum displacement `
        + `${f2(moved)} m from the spawn point over ${f2(span)} s. Both halves are asserted: a state machine `
        + 'that enters REPOSITION and gets nowhere was measured at 60% of a 26 s engagement with 0.00 m of '
        + 'displacement, because the cover point it chose was on the far side of a wall');
    }

    /* ============================= 5. a moving target ================== */
    //
    // Does a strafing player get hit less than a standing one, and does the AI's
    // aim point sit ahead of the player at all?
    //
    // Both are MEAS rows, and that is a correction rather than a retreat. The
    // hit-rate difference between standing and strafing was a hard gate at 10%
    // in the previous version of this file, and an independent critic flipped it
    // green by changing CONFIG.reactionTime and red again by changing the spread
    // cone: at ~100 rounds a side one standard error on the difference of two
    // proportions is around 7 points, so a 10-point gate is a coin flip that
    // changes colour on unrelated edits. The standard error is printed beside
    // the difference so the reader can see that for themselves.
    {
      const STRAFE = IN_DYN('{ left: Math.floor(t / 0.7) % 2 === 0, right: Math.floor(t / 0.7) % 2 === 1 }');
      const stand = { fired: 0, hit: 0, lat: [], atFire: [] };
      const move = { fired: 0, hit: 0, lat: [], atFire: [], speed: [], travel: [] };
      for (let i = 0; i < 10; i++) {
        for (const [tag, rec2, input] of [['stand', stand, null], ['strafe', move, STRAFE]]) {
          const e = await engage({ d: 20, seconds: 5, dt: DT_LONG, state: 'engage', vulnerable: true, input });
          if (!e.pre.sees) continue;
          for (const f of e.fires) {
            rec2.fired++;
            if (f.hits > 0) rec2.hit++;
            rec2.atFire.push(f.speed);
            if (Number.isFinite(f.lateral)) rec2.lat.push(f.lateral);
          }
          if (tag === 'strafe') {
            rec2.speed.push(...e.rows.map((r) => r.speed));
            const x0 = e.rows[0].px, z0 = e.rows[0].pz;
            rec2.travel.push(Math.max(...e.rows.map((r) => Math.hypot(r.px - x0, r.pz - z0))));
          }
        }
      }
      const topSpeed = Math.max(...move.speed);
      // Guard first: a "moving" player who never moved makes the two hit rates
      // trivially equal and the leading question unanswerable. The speed AT THE
      // MOMENT OF FIRE is the one that matters — a player who strafes between
      // bursts and stands still during them is a standing target.
      report.check('the strafing player used for the leading test actually moved',
        topSpeed > 3 && median(move.atFire) > 3 && move.lat.length > 10,
        `peak strafe speed ${f2(topSpeed)} m/s, median speed at the instant a round was fired `
        + `${f2(median(move.atFire))} m/s (standing case ${f2(median(stand.atFire))} m/s), lateral excursion `
        + `${f2(median(move.travel))} m, ${move.lat.length} rounds fired while above 0.5 m/s`);

      const rS = stand.hit / stand.fired, rM = move.hit / move.fired;
      const se = Math.sqrt(rS * (1 - rS) / stand.fired + rM * (1 - rM) / move.fired);
      report.measure('AI hit rate, standing player at 20 m', rS, '', `${stand.hit}/${stand.fired} rounds`);
      report.measure('AI hit rate, strafing player at 20 m', rM, '', `${move.hit}/${move.fired} rounds`);
      report.measure('strafing advantage in standard errors', (rS - rM) / se, 's.e.',
        `difference ${pct(rS - rM)} +/- ${pct(se)} (1 s.e.). main.enemyShoot() re-aims at camera.position on `
        + 'the tick it fires and resolves the round on that same tick, so movement can open no aim error at '
        + 'all; whatever difference survives comes from the eye sitting near the top of the AABB and the view '
        + 'bob moving it');
      report.measure('AI lead along the player direction of travel', mean(move.lat), 'm',
        `p10 ${f3(quant(move.lat, 0.1))} m .. p90 ${f3(quant(move.lat, 0.9))} m over ${move.lat.length} `
        + 'rounds; a hitscan round resolved on the firing tick has nothing to lead');

      // Why there is no lead to measure: AI fire is hitscan. Established by
      // calling shoot() directly at close range — where the measured hit rate is
      // highest, so rounds actually connect — and comparing the tick each round
      // left the barrel with the tick its damage landed. The previous version
      // fired 12 rounds from 25.7 m, none of them connected, and it reported
      // "hitscan" from zero samples: `resolved > 0 && worst > 0 ? 1 : 0` makes an
      // empty measurement byte-identical to a measured hitscan. Hence reached()
      // in front of it.
      await engage({ d: 9, seconds: 0.5, dt: DT_LONG, state: 'engage', vulnerable: true });
      const travel = await sim.eval(() => {
        const g = window.__GAME;
        const e = g.director.enemies[0];
        if (!e) return null;
        let fired = 0, resolved = 0, worst = 0;
        for (let i = 0; i < 60; i++) {
          const t = g.elapsed;
          const before = window.__AI.hits.length;
          fired++;
          e.shoot(g.player, e.position.distanceTo(g.camera.position));
          for (let k = before; k < window.__AI.hits.length; k++) {
            resolved++;
            worst = Math.max(worst, window.__AI.hits[k].t - t);
          }
          g.step(1 / 240);
        }
        return { fired, resolved, worst, dist: e.position.distanceTo(g.camera.position) };
      });
      const resolved = travel ? travel.resolved : 0;
      if (report.reached('the travel-time probe landed rounds to time', resolved > 0 ? resolved : NaN,
        `${resolved}/${travel ? travel.fired : 0} probe rounds fired from ${travel ? f2(travel.dist) : '?'} m `
        + 'landed damage; a probe that connects with nothing cannot distinguish hitscan from a projectile')) {
        report.against('AI rounds are projectiles with travel time',
          travel.worst > 0 ? 1 : 0, 'ballistics', 'bullet_model_is_projectile_not_hitscan');
        report.measure('largest gap between an AI round leaving the barrel and its damage arriving',
          travel.worst, 's',
          `over ${resolved} resolved rounds — AI fire is a single Raycaster call inside main.enemyShoot(), `
          + 'resolved on the firing tick. Fixing that is main.js/ballistics work, not ai.js');
      }
    }

    /* ====================== 6. hitbox fidelity vs the mesh ============= */
    //
    // buildSoldier() tags hit zones on the meshes it remembers, and
    // director.raycast() only ever intersects tagged meshes. Anything untagged is
    // rendered, lit, shadow-casting, part of the silhouette the player puts the
    // crosshair on — and invisible to every bullet in the game.
    //
    // Counting untagged meshes is not the whole measurement. A mesh matters in
    // proportion to the solid angle it occupies from where the player is
    // standing, so the measurement is a dense grid of rays from a realistic
    // firing distance across the silhouette, each classified three ways:
    //
    //   registered — nearest visible hit resolves to a tagged mesh (or a tagged
    //                mesh lies behind an untagged one along the same ray)
    //   through    — hit something visible, no tagged mesh anywhere along the
    //                ray: the player sees a target, the game registers nothing
    //   miss       — did not touch the model
    {
      // The pose matters. An engaged soldier has the rifle up across its chest,
      // which is exactly when the untagged geometry is in front of the tagged
      // geometry, so the measurement is taken in the pose the player fights.
      await engage({ d: 20, seconds: 1.2, dt: DT_LONG, state: 'engage', vulnerable: false });
      const aim = await sim.aimAt(0);
      report.check('the hitbox grid is cast at a soldier the player can actually shoot',
        aim.clear === true,
        `aim at chest from ${f2(aim.distance)} m: enemy at ${f2(aim.enemyDist)} m, world at `
        + `${f2(aim.worldDist)} m, zone ${aim.zone}`);

      const counts = await sim.eval(() => {
        const e = window.__GAME.director.enemies[0];
        const s = window.__AI.meshes(e);
        return {
          all: s.all.length, vis: s.vis.length, tagged: s.tagged.length, effects: s.effects.length,
          untagged: s.untagged.map((o) => window.__AI.describe(o)),
        };
      });
      report.against('visible soldier meshes that cannot be hit',
        counts.untagged.length, 'integrity', 'hitbox_visible_mesh_hittable');
      report.measure('zone-tagged share of the visible silhouette meshes',
        counts.tagged / counts.vis, 'fraction',
        `${counts.tagged}/${counts.vis} visible meshes tagged, ${counts.all} meshes in the hierarchy, `
        + `${counts.effects} additive effect quads excluded (the muzzle flash is a light, not a surface)`
        + (counts.untagged.length ? `; untagged: ${counts.untagged.join(' | ')}` : ''));

      // 61x61 = 3721 rays. Chunked by rows: intersectObjects against ~50
      // rounded boxes per ray is real work, and one evaluate long enough to look
      // like a hang is how a suite stops being run.
      const N = 61;
      const agg = {
        miss: 0, registered: 0, through: 0, shadowed: 0,
        zones: { head: 0, body: 0, limb: 0 }, offenders: {}, shadowers: {}, extent: null, dist: null,
      };
      for (let row = 0; row < N; row += 10) {
        const part = await sim.eval((a) => window.__AI.silhouette(a), { row0: row, rows: 10, n: N });
        agg.miss += part.miss; agg.registered += part.registered;
        agg.through += part.through; agg.shadowed += part.shadowed;
        for (const z of Object.keys(part.zones)) agg.zones[z] += part.zones[z];
        for (const [k, v] of Object.entries(part.offenders)) agg.offenders[k] = (agg.offenders[k] ?? 0) + v;
        for (const [k, v] of Object.entries(part.shadowers)) agg.shadowers[k] = (agg.shadowers[k] ?? 0) + v;
        agg.extent = part.extent; agg.dist = part.dist;
      }
      const onModel = agg.registered + agg.through;

      // Liveness before the number is quoted: a grid that hit nothing, or hit
      // everything, is a grid that was aimed wrong.
      report.check('the silhouette grid actually straddles the soldier',
        onModel > 300 && agg.miss > 300,
        `${N}x${N} = ${N * N} rays from ${f2(agg.dist)} m across a `
        + `${f2(agg.extent[0])} x ${f2(agg.extent[1])} m plane: ${onModel} hit the model, ${agg.miss} passed `
        + 'beside it');
      report.check('no visible part of the soldier is unhittable',
        agg.through === 0,
        `${pct(agg.through / onModel)} of the silhouette (${agg.through}/${onModel} rays) hits geometry the `
        + 'player can see and nothing the game will register. Offenders: '
        + (Object.entries(agg.offenders).sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${v} rays ${k}`).join(' | ') || 'none'));
      // The milder cousin: the round registers, but on a zone behind the surface
      // the player was aiming at. Same cause, different symptom, and it moves
      // independently of the pass-through rate — a rifle held across the chest
      // shadows the torso without ever being the last thing on the ray.
      report.check('the surface the player aims at is the surface that takes the round',
        agg.shadowed === 0,
        `${pct(agg.shadowed / onModel)} of on-model rays (${agg.shadowed}/${onModel}) pass through an untagged `
        + 'visible mesh before reaching the zone that registers: '
        + (Object.entries(agg.shadowers).sort((a, b) => b[1] - a[1]).slice(0, 4)
          .map(([k, v]) => `${v} rays ${k}`).join(' | ') || 'none'));

      // Per-zone share of the hittable silhouette. This is the regression
      // tripwire: a later change that quietly shrinks the head box shows up here
      // as a share, and the 1% floor is a structural statement (a head that
      // occupies less than a hundredth of the silhouette is not a headshot
      // target) rather than a sourced figure.
      const zSum = agg.zones.head + agg.zones.body + agg.zones.limb;
      report.check('the head is a large enough share of the silhouette to be a target',
        agg.zones.head / zSum > 0.01,
        `head ${pct(agg.zones.head / zSum)} (${agg.zones.head} rays), body ${pct(agg.zones.body / zSum)} `
        + `(${agg.zones.body}), limb ${pct(agg.zones.limb / zSum)} (${agg.zones.limb}) of ${zSum} registering `
        + 'rays. The 1% head floor is structural, not a sourced figure');
    }

    /* ========================== 7. zone multipliers ==================== */
    //
    // Measured out of enemy health deltas through the game's own
    // resolveBullet(), never read from applyDamage(). The expected unmultiplied
    // damage is recomputed per ray from the live SPEC and the actual hit
    // distance, so the multiplier is a ratio and does not depend on every probe
    // ray landing at the same range.
    {
      const { probes, eaten } = await sim.eval((a) => window.__AI.zoneProbe(a), { n: 60 });
      const byZone = { head: [], body: [], limb: [] };
      for (const p of probes) if (byZone[p.zone]) byZone[p.zone].push(p.delta / p.raw);
      const m = { head: median(byZone.head), body: median(byZone.body), limb: median(byZone.limb) };

      report.check('every zone was hit often enough to measure its multiplier',
        byZone.head.length >= 3 && byZone.body.length >= 3 && byZone.limb.length >= 3,
        `${probes.length} probe rays resolved into the soldier: head ${byZone.head.length}, `
        + `body ${byZone.body.length}, limb ${byZone.limb.length}; ${eaten} further rays were dropped because `
        + 'the terrain was in front of the zone they found (the low rays into the boots), which is what made '
        + 'the first version of this probe report a limb multiplier of 0.000');
      for (const z of ['head', 'body', 'limb']) {
        report.measure(`${z} damage multiplier, from health deltas`, m[z], 'x',
          `${byZone[z].length} rays against a base of ${probes.length ? f2(median(probes.map((p) => p.raw))) : '?'}`
          + ' HP. No sourced zone-multiplier target exists for this weapon; the damage model belongs to '
          + 'weapon.js/SPEC, which this suite does not own');
      }
      report.check('a body hit is the unmultiplied reference', Math.abs(m.body - 1) < 0.02,
        `body multiplier measured x${f3(m.body)}; anything else means falloff or the probe's own arithmetic `
        + 'is leaking into the ratio');
      report.check('a headshot is worth more than a body shot', m.head > m.body * 1.5,
        `head x${f3(m.head)} vs body x${f3(m.body)}, ratio ${f2(m.head / m.body)}`);
      report.check('a limb hit is worth less than a body shot', m.limb < m.body,
        `limb x${f3(m.limb)} vs body x${f3(m.body)}, ratio ${f2(m.limb / m.body)}`);

      // SPEC.headshotMultiplier is 2.4 and Enemy.applyDamage() applies 2.6. The
      // dead constant is proved dead behaviourally: quadruple it and re-measure.
      // A test that read the constant would report a headshot multiplier this
      // weapon has never had. Resolving the duplication needs a multiplier ai.js
      // can import from the file that owns the damage model, so this row is
      // expected red until weapon.js exports one — see the report.
      const prev = await sim.eval((v) => {
        const s = window.__AI.SPEC; const before = s.headshotMultiplier; s.headshotMultiplier = v; return before;
      }, 9.9);
      const again = await sim.eval((a) => window.__AI.zoneProbe(a), { n: 24 });
      await sim.eval((v) => { window.__AI.SPEC.headshotMultiplier = v; }, prev);
      const headAgain = median(again.probes.filter((p) => p.zone === 'head').map((p) => p.delta / p.raw));
      report.check('SPEC.headshotMultiplier governs headshot damage',
        Math.abs(headAgain - m.head) > 0.1,
        `SPEC.headshotMultiplier ${f2(prev)} -> 9.9 left the measured head multiplier at x${f3(headAgain)} `
        + `(was x${f3(m.head)}); the live multiplier is the ${f2(m.head)} hard-coded in `
        + 'Enemy.applyDamage(), so the constant is dead');
    }

    /* ------------------------------------------------ coverage gaps ----- */
    //
    // What targets.mjs itself says it cannot check. Printed as a MEAS row rather
    // than as a check: a suite that stays quiet about its blind spots implies
    // coverage it does not have, but "nobody publishes an AI accuracy figure" is
    // not a defect anyone can close and a permanently red row for it would be
    // noise. What the suite does about the gap is the three structural checks in
    // section 2.
    if (missing) {
      const gaps = missing().filter((k) => ['ai_reaction', 'ai_accuracy', 'hitbox_fidelity'].includes(k));
      report.measure('domains in this suite with no external reference value', gaps.length, 'domains',
        gaps.length ? gaps.join(', ') : 'none');
    }
  } finally {
    // The runner boots one sim for every suite. A leaked SPEC mutation or a
    // player left invulnerable would surface as a mystery failure in whichever
    // file runs next.
    await sim.eval(() => {
      const g = window.__GAME;
      delete g.player.damage;
      g.player.__realDamage = undefined;
      g.player.alive = true;
    }).catch(() => {});
  }
}
