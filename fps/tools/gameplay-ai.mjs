// AI behaviour and hitbox fidelity.
//
// This suite measures the enemy from the outside — the way the player meets it:
// how long it takes to shoot back, how often it connects at each range, how it
// paces a firefight, and whether the parts of the soldier a player can see are
// the parts the game will register a hit on.
//
// It exists because every one of those quantities is described somewhere in
// ai.js by a constant that does not describe it:
//
//   CONFIG.reactionTime is [0.28, 0.62] s, but nothing fires at 0.28 s. The
//   reaction roll only moves IDLE -> ALERT -> ENGAGE; entering ENGAGE then rolls
//   a fresh fireTimer of 0.12-0.34 s, and the ENGAGE branch that arms the burst
//   does not shoot on the tick it arms it. The player's experience is the sum,
//   and the sum is what this file reports.
//
//   applyDamage() multiplies head damage by 2.6 while SPEC.headshotMultiplier
//   is 2.4 and read by nobody. So zone multipliers here are measured out of
//   enemy health deltas, and the dead constant is proved dead by changing it and
//   watching nothing happen.
//
//   The hit zones are tagged per mesh in buildSoldier(). Anything the author
//   forgot to tag is still rendered, still lit, still part of the silhouette the
//   player aims at, and completely absent from director.raycast(). That is not a
//   number anyone can read off the source — it is a coverage question about two
//   sets of meshes, and the only honest way to ask it is to fire a lot of rays
//   at the model and count.
//
// THREE CONVENTIONS, all load-bearing:
//
//   Rounds are enemy.shoot() calls. Unlike the player's weapon there is no rate
//   limiter to see through: Enemy.shoot() is called once per round and always
//   fires one, so the tap on Enemy.prototype.shoot IS the round count. It is
//   installed on the prototype, not on an instance, because every sim.setup()
//   throws the roster away and spawns fresh soldiers.
//
//   Hits are Player.prototype.damage() calls, and they are attributed to a
//   specific round: main.enemyShoot() resolves the shot synchronously inside
//   enemy.shoot(), so a damage call arriving while a shoot() is on the stack
//   belongs to that round. That is what makes "missed" distinguishable from
//   "never fired" — the two live in different arrays, and a range that reports
//   0% accuracy says whether the AI shot and missed or never pulled the
//   trigger.
//
//   Every engagement checks its own preconditions before its numbers are
//   quoted: that the enemy could see the player at t=0, that the AI's firing
//   lane is not a wall, and that a strafe actually moved. The four null AI
//   timings this project reported last session were all probes that measured
//   nothing and said nothing about it.
//
// Where a threshold is not a sourced Call of Duty figure it is a STRUCTURAL
// floor — "the quantity is nonzero", "the AI leads at all", "the silhouette the
// game registers is the silhouette the player sees" — and the detail string says
// so. targets.mjs lists ai_reaction, ai_accuracy and hitbox_fidelity in its own
// missing() set, so most of this file is measurement without an external target,
// and it prints that gap rather than inventing a number to close it.

const DEG = 180 / Math.PI;

// 1/240 for anything whose answer is a timestamp (reaction, TTK): the ENGAGE
// branch costs one tick of latency by construction, and at 1/240 that tick is
// 4 ms of the answer instead of 17. 1/120 for the long accuracy and pacing
// runs, where the quantity is a ratio over ~100 rounds and halving the tick
// count is worth more than 4 ms of edge resolution.
const DT_FINE = 1 / 240;
const DT_LONG = 1 / 120;

export const NAME = 'ai';

/* ------------------------------------------------------------- targets -- */
//
// Same defensive shape as gameplay-weapon.mjs: this file does not own
// targets.mjs and must not dictate its schema, and must never substitute a
// number of its own when a lookup misses.
let TARGETS = null, missing = null;
try { ({ TARGETS, missing } = await import('./targets.mjs')); } catch { /* not written yet */ }

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

/**
 * A target that is a BAND rather than a value.
 *
 * targets.mjs deliberately carries entries with `value: null` and a
 * `tol: {min, max}` where the evidence supports a range but no central figure —
 * ai.ai_reaction_delay_range is 0.2..0.4 s on exactly that basis. Reading those
 * through targetFor() would silently skip them, which would leave a sourced
 * constraint unasserted, so they get their own lookup.
 */
function bandFor(paths) {
  if (!TARGETS) return null;
  for (const p of [].concat(paths)) {
    let node = TARGETS;
    for (const k of p.split('.')) { if (node == null) break; node = node[k]; }
    if (node == null || !node.tol || node.tol.min == null) continue;
    return { min: node.tol.min, max: node.tol.max, unit: node.unit ?? '', source: node.source ?? `targets.mjs:${p}` };
  }
  return null;
}

/* ------------------------------------------------------------ plumbing -- */

const BASE_INPUT = {
  forward: false, back: false, left: false, right: false,
  sprint: false, crouch: false, ads: false, fire: false,
};
// drive() Object.assign's the patch, so an omitted key keeps its last value.
// Everything here goes through IN/IN_DYN so a key nobody mentioned is false.
const IN = (over = {}) => `return ${JSON.stringify({ ...BASE_INPUT, ...over })};`;
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
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

/** median [p10..p90] over n samples — the standard way this file prints a distribution. */
function dist(a, unit = 's', scale = 1) {
  const n = a.filter(Number.isFinite).length;
  if (!n) return `no samples`;
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
      SPEC: wp.SPEC, TUNING: pl.TUNING, CONFIG: null,
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
    // "Visible" is o.visible AND not a fully transparent additive quad: the
    // muzzle-flash sprite is a mesh that exists at opacity 0 for all but ~45 ms
    // per round, and counting it as part of the silhouette would inflate the
    // defect rate with something the player almost never sees. Both counts are
    // reported so the choice is auditable rather than buried here.
    rec.meshes = (enemy) => {
      const all = [], vis = [], tagged = [], untagged = [];
      enemy.root.traverse((o) => {
        if (!o.isMesh) return;
        all.push(o);
        const m = o.material;
        const solid = !(m && m.transparent && (m.opacity ?? 1) <= 0.01);
        if (o.visible && solid) vis.push(o);
        if (o.userData.zone) tagged.push(o);
        else if (o.visible && solid) untagged.push(o);
      });
      return { all, vis, tagged, untagged };
    };

    /**
     * Human-readable identity for a mesh nobody named.
     *
     * buildSoldier() never sets .name on anything, so a defect report has to be
     * reconstructed from geometry parameters, material and local offset — which
     * together map one-to-one onto the mk()/g() calls in ai.js. The "rifle:"
     * prefix is the one piece of semantics worth adding by hand, because every
     * untagged mesh on this model turns out to be part of the weapon and a list
     * of seven anonymous rounded boxes does not say that.
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

    rec.CONFIG = { note: 'ai.js CONFIG is module-private; reaction bounds are quoted from source text only' };
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

/** Everything the recorder saw, plus the enemy's own view of the world. */
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
  return async function engage({
    d, seconds, dt = DT_LONG, health = 1e6, vulnerable = true, input = null,
    state = 'idle', sample = SAMPLE_AI,
  }) {
    const ex = origin[0] + Math.sin(a) * d, ez = origin[2] + Math.cos(a) * d;
    await sim.setup({
      position: origin, yaw, pitch: 0, ads: 0, invulnerable: !vulnerable, health,
      // facing back down the lane at the player: an enemy that has to turn
      // before it can see is measuring a turn rate, not a reaction.
      enemies: [{ x: ex, z: ez, facing: yaw, engage: state === 'engage' }],
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
  };
}

/* ---------------------------------------------------------------- suite -- */

export default async function run(sim, report) {
  const state = await install(sim);
  report.check('the AI probe installed its taps', state === 'installed' || state === 'already installed',
    `Enemy.prototype.shoot, Player.prototype.damage and vfx.tracers.fire wrapped (${state})`);

  // One long clear lane, reused by every engagement. 60 m of AI accuracy
  // measured across a courtyard wall would be a measurement of the wall.
  const lane = await sim.clearLane([-6, null, 17], 130);
  const engage = engagementFactory(sim, lane);
  report.check('a clear lane exists for the engagement ranges',
    lane.clear > 65,
    `${f2(lane.clear)} m unobstructed on heading ${lane.deg} deg from the spawn — the longest range `
    + 'measured below is 60 m');

  const SPEC = await sim.eval(() => ({
    damage: window.__AI.SPEC.damage, range: window.__AI.SPEC.range,
    falloffStart: window.__AI.SPEC.falloffStart, falloffEnd: window.__AI.SPEC.falloffEnd,
    falloffScale: window.__AI.SPEC.falloffScale,
    headshotMultiplier: window.__AI.SPEC.headshotMultiplier,
    maxHealth: window.__AI.TUNING.maxHealth,
  }));

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

    await sim.setup({
      position: [-6, null, 17], yaw: lane.deg * Math.PI / 180 + Math.PI, invulnerable: false, health: 1e6,
      enemies: [{ x: -6 + Math.sin(lane.deg * Math.PI / 180) * 18, z: 17 + Math.cos(lane.deg * Math.PI / 180) * 18,
        facing: lane.deg * Math.PI / 180 + Math.PI, engage: true, inert: true }],
    });
    await arm(sim, true);
    await sim.drive({ seconds: 4, dt: DT_LONG, sample: SAMPLE_AI });
    const silent = await records(sim);
    report.check('an inert enemy reads as zero rounds, not as misses',
      silent.fires.length === 0 && silent.hits.length === 0,
      `${silent.fires.length} rounds and ${silent.hits.length} hits with shoot() silenced, against `
      + `${live.fires.length} rounds from the same placement live — "never fired" and "fired and missed" `
      + 'are separate readings');

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
      const g = vul.fires.filter((f) => f.geom !== null);
      const agree = g.filter((f) => (f.hits > 0 ? 1 : 0) === f.geom).length;
      report.check('the hit tap agrees with the recomputed shot geometry',
        g.length > 0 && agree === g.length,
        `${agree}/${g.length} rounds classified identically by Player.damage() and by an independent `
        + 'ray-vs-player-AABB test');
    }

    // (d) the player's effective health, measured behaviourally: how much
    //     damage it takes to put him down, not what TUNING says.
    {
      const kill = await engage({ d: 12, seconds: 12, dt: DT_LONG, state: 'engage', vulnerable: true, health: 100 });
      const died = kill.rows.find((r) => r.health <= 0);
      // Health absorbed, not damage requested. Player.damage() clamps at zero, so
      // summing the raw amounts credits the killing round with its full 11-16 HP
      // of overkill and reports a 100 HP player as 108.6 HP. The recorded
      // pre-hit health makes the absorbed part exact.
      let dealt = 0;
      for (const h of kill.hits) dealt += Math.min(h.amount, Math.max(0, h.health));
      const tgtHp = targetFor(['damage.health_mw2019']);
      if (tgtHp) {
        report.against('player effective health (damage absorbed before death)',
          dealt, tgtHp.value, tgtHp.tol, ' HP');
        report.check('player health target is sourced', true, `source: ${tgtHp.source}`);
      } else {
        report.check('player effective health', died != null,
          `${f2(dealt)} HP absorbed over ${kill.hits.length} hits — no sourced target yet`);
      }
      // The reconstruction the TTK section relies on: cumulative recorded
      // damage crossing maxHealth must land on the tick health actually hit
      // zero. Verified once, here, so the TTK numbers below can be taken from
      // the accuracy runs instead of from a second set of dying players.
      let rc = 0, tCross = NaN;
      for (const h of kill.hits) { rc += h.amount; if (rc >= SPEC.maxHealth) { tCross = h.t; break; } }
      report.check('cumulative-damage TTK reconstruction matches an actual death',
        died != null && Number.isFinite(tCross) && Math.abs(tCross - died.t) < 3 * DT_LONG,
        died != null
          ? `death at t=${f3(died.t)} s, cumulative ${SPEC.maxHealth} HP crossed at t=${f3(tCross)} s, `
            + `difference ${ms(Math.abs(tCross - died.t))}`
          : `the player never died in 12.0 s at 12 m (${kill.hits.length} hits, `
            + `${f2(kill.hits.reduce((s, h) => s + h.amount, 0))} HP)`);
    }

    /* ================================ 1. reaction time ================= */
    //
    // From the first instant the enemy can see the player to the first round
    // leaving its barrel, over many engagements. Each trial is a fresh
    // engagement at a different range, so each one draws a fresh reaction roll
    // and a fresh fireTimer out of the seeded stream rather than replaying one
    // sample thirty times.
    //
    // The decomposition is the point. ai.js CONFIG.reactionTime is [0.28, 0.62]
    // s, and every one of those seconds is spent in ALERT; ENGAGE then rolls
    // fireTimer = 0.12 + rand*0.22, and the branch that arms the burst does not
    // shoot on the tick it arms it. Reporting only the total would show a slow
    // AI; reporting the three legs shows where the 0.28 s floor went.
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
      reactionMedian = median(total);

      report.check('every reaction trial produced a first round',
        unseen === 0 && noShot === 0 && total.length === RANGES.length * REPEATS,
        `${total.length}/${RANGES.length * REPEATS} trials usable — ${unseen} discarded for no line of `
        + `sight at t0, ${noShot} for no round inside 2.2 s`);

      const tgtR = targetFor(['ai.ai_reaction_delay_base', 'ai.reaction_time', 'ai.reactionTime']);
      if (tgtR) {
        report.against('AI reaction time (first sight -> first round)', reactionMedian, tgtR.value, tgtR.tol, ' s');
        report.check('AI reaction target is sourced', true,
          `source: ${tgtR.source} — measured ${dist(total, 'ms')} at ${f2(median(firstDist))} m median `
          + 'engagement range');
      } else {
        report.check('AI reaction time (first sight -> first round)', total.length > 0,
          `${dist(total, 'ms')} at ${f2(median(firstDist))} m median engagement range — no sourced target yet`);
      }
      // The sourced band, asserted separately from the sourced central value:
      // a reaction can be outside the 0.25 s figure and still inside the range
      // the literature supports, and those are different failures.
      const bandR = bandFor(['ai.ai_reaction_delay_range']);
      if (bandR) {
        report.check('AI reaction time falls inside the sourced reaction-delay band',
          reactionMedian >= bandR.min && reactionMedian <= bandR.max,
          `median ${ms(reactionMedian)} against ${ms(bandR.min)}..${ms(bandR.max)} `
          + `(p10 ${ms(quant(total, 0.1))}, p90 ${ms(quant(total, 0.9))}); source: ${bandR.source}`);
      }

      // The behaviour-vs-constant statement. CONFIG.reactionTime's upper bound
      // is 0.62 s; if the player's experienced reaction exceeds it, the constant
      // does not describe the enemy and tuning it will not fix the enemy.
      report.check('the experienced reaction time stays inside CONFIG.reactionTime [0.28, 0.62] s',
        reactionMedian <= 0.62,
        `median ${ms(reactionMedian)} against a configured ceiling of 620 ms — legs: `
        + `sight->ALERT ${ms(median(legAlert))}, ALERT->ENGAGE ${ms(median(legEngage))} (this is the `
        + `reaction roll), ENGAGE->round ${ms(median(legFire))} (fireTimer 0.12-0.34 s plus the tick the `
        + 'ENGAGE branch spends arming the burst without firing it)');

      // Spread matters as much as the median: a constant reaction is a robot,
      // and a reaction that varies by a second is a coin flip over who wins the
      // first exchange. Reported, no sourced target to assert against.
      const spread = quant(total, 0.9) - quant(total, 0.1);
      report.check('AI reaction time varies between engagements', spread > 0.05,
        `p90-p10 spread ${ms(spread)} (${ms(quant(total, 0.1))} .. ${ms(quant(total, 0.9))}) across `
        + `${total.length} engagements — measured, no sourced target for the spread`);
    }

    /* ============================ 2. accuracy vs range ================= */
    //
    // Hits landed / rounds fired against a stationary, vulnerable player with
    // 1e6 HP. The oversized health pool is deliberate: at 100 HP the player dies
    // nine hits in, the enemy stops seeing a corpse, and the sample ends
    // whenever the AI happens to be accurate. Regen never enters — health is
    // above TUNING.maxHealth, so the regen branch is closed — and hits are
    // counted as damage() calls regardless.
    //
    // Rounds are bucketed by the distance the AI itself used to compute its
    // spread cone, so a soldier that repositions mid-engagement lands in the
    // bucket it actually shot from rather than the one it spawned in.
    const RANGES = [10, 20, 40, 60];
    // 10 trials of 6.5 s. Sized off the first run rather than guessed: at 8x5 s
    // only one engagement at 10 m ever accumulated 100 HP, and a TTK "median"
    // over one sample is not a distribution.
    const TRIALS = 10;
    const WINDOW = 6.5;
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
          if (cum >= SPEC.maxHealth && !Number.isFinite(tCross)) tCross = f.t;
        }
        if (Number.isFinite(tCross)) ttks.push(tCross - tFirst);
        else ttks.push(Infinity);      // censored: did not kill inside the window
      }
      acc.set(d, rec);
      ttk.set(d, ttks);
    }

    // The curve, as one line, with the sample size beside every point — an
    // accuracy quoted without its round count is not auditable.
    const curve = RANGES.map((d) => {
      const r = acc.get(d);
      return `${d} m: ${r.fired ? pct(r.hit / r.fired) : 'no rounds'} (${r.hit}/${r.fired})`;
    }).join(', ');
    report.check('AI accuracy was measured at every range',
      RANGES.every((d) => acc.get(d).fired >= 20),
      `rounds fired per range: ${RANGES.map((d) => {
        const r = acc.get(d);
        return `${d} m ${r.fired} over ${r.trials} trials (${f2(r.fired / r.trials)}/trial, `
          + `${pct(r.engageTicks / r.ticks)} of the window in ENGAGE)`;
      }).join(', ')} `
      + `(${RANGES.map((d) => acc.get(d).unusable).reduce((a, b) => a + b)} trials discarded for no LOS or `
      + `a blocked lane, ${RANGES.map((d) => acc.get(d).drift).reduce((a, b) => a + b)} rounds discarded for `
      + 'repositioning out of the range bucket)');

    const tgtA = targetFor(['ai.accuracy', 'ai.ai_accuracy', 'ai.hit_rate']);
    if (tgtA) {
      report.against('AI accuracy at 20 m', acc.get(20).hit / acc.get(20).fired, tgtA.value, tgtA.tol, '');
      report.check('AI accuracy target is sourced', true, `source: ${tgtA.source}`);
    } else {
      report.check('AI accuracy vs range', RANGES.every((d) => acc.get(d).fired > 0),
        `${curve} — no sourced target yet (targets.mjs lists ai_accuracy in its own missing() set)`);
    }

    // The shape is the interesting half. CONFIG lerps the cone from 0.020 rad at
    // 6 m to 0.052 rad at 46 m, and a cone of fixed angle subtends a linearly
    // growing circle at range, so accuracy should fall steeply with distance. A
    // flat curve means distance does not protect the player, which is the single
    // most common complaint about hitscan AI.
    {
      const near = acc.get(10), far = acc.get(60);
      const rNear = near.hit / near.fired, rFar = far.hit / far.fired;
      report.check('AI accuracy falls off with range',
        Number.isFinite(rNear) && Number.isFinite(rFar) && rFar < rNear * 0.75,
        `${pct(rNear)} at 10 m -> ${pct(rFar)} at 60 m (ratio ${f2(rFar / rNear)}); structural floor: the far `
        + 'point must lose at least a quarter of the near hit rate, not a sourced CoD figure');
      // How badly it misses when it misses — a soldier missing by 20 cm and one
      // missing by 4 m are different opponents at the same hit rate. A range
      // with no misses at all prints as such rather than as a NaN.
      const missMed = RANGES.map((d) => median(acc.get(d).misses));
      report.check('AI miss distance grows with range',
        missMed.every((v, i) => i === 0 || !Number.isFinite(v) || !Number.isFinite(missMed[i - 1])
          || v >= missMed[i - 1]),
        RANGES.map((d, i) => `${d} m ${Number.isFinite(missMed[i]) ? `${f2(missMed[i])} m` : 'no misses'}`).join(', ')
        + ' median perpendicular miss at the eye — measured, no sourced target for the magnitude; the check '
        + 'is that the sequence does not decrease');
      // Where the AI is aiming on the body, which is the mechanism behind the
      // numbers above and is not in this project's baseline. enemyShoot() aims at
      // camera.position, and the camera is the player's eye: a stance 1.80 m tall
      // is tested as a single AABB, so an aim point 0.7-0.8 m above the box centre
      // throws away most of the upper half of every cone. The aim offset is the
      // finding; the distribution of where rounds actually passed is printed
      // beside it to show the consequence — its p90 is how far over the head the
      // top of the cone lands. A tolerance of 15% of the body height is structural —
      // an aim point inside the middle 30% of the target is "centre mass" in any
      // shooter — and is not a sourced CoD figure.
      {
        const aimAbove = RANGES.flatMap((d) => acc.get(d).aimAbove);
        const dys = RANGES.flatMap((d) => acc.get(d).dys);
        const h = median(RANGES.flatMap((d) => acc.get(d).boxH));
        report.check('the AI aims at the centre of the player it is shooting at',
          Math.abs(median(aimAbove)) < 0.15 * h,
          `aim point sits ${f2(median(aimAbove))} m above the centre of the player's ${f2(h)} m AABB `
          + `(${pct(median(aimAbove) / h)} of body height), and rounds pass the body a median `
          + `${f2(median(dys))} m above its centre [p10 ${f2(quant(dys, 0.1))} .. p90 ${f2(quant(dys, 0.9))}, `
          + `i.e. the top of the cone lands ${f2(quant(dys, 0.9) - h / 2)} m over the head] — `
          + 'enemyShoot() aims at camera.position, i.e. the eye, while the hit test is against the whole body '
          + 'box, so the upper half of every spread cone is thrown away over the head');
      }
      // Rounds the world ate on their way to a player they would otherwise have
      // hit. Only on-target rounds can be blocked: counting every round whose
      // world hit came first counts every miss, since a miss never intersects the
      // player's box at all. That mistake reported 69% of the AI's fire as eaten
      // by walls and would have condemned the level for the AI's cone.
      const blocked = RANGES.reduce((s, d) => s + acc.get(d).blocked, 0);
      const onT = RANGES.reduce((s, d) => s + acc.get(d).onTarget, 0);
      // Tested per range, not in aggregate. The aggregate is dominated by the
      // near ranges, where nothing is blocked, and a 7% total hid 6 of 10
      // on-target rounds being eaten by the ground at 40 m — which is exactly the
      // range whose accuracy figure the reader would most want to trust. 25% is
      // the point past which the number stops being an AI measurement and becomes
      // a joint measurement of the AI and the terrain it is shooting over; it is
      // a validity threshold for this instrument, not a CoD figure.
      const worst = Math.max(...RANGES.map((d) => {
        const r = acc.get(d);
        return r.onTarget ? r.blocked / r.onTarget : 0;
      }));
      report.check('the measured misses are misses and not walls',
        worst < 0.25,
        `${blocked}/${onT} on-target rounds (${pct(blocked / onT)}) overall were stopped by level geometry `
        + `before reaching the player, worst range ${pct(worst)}: `
        + `${RANGES.map((d) => `${d} m ${acc.get(d).blocked}/${acc.get(d).onTarget}`).join(', ')}. `
        + 'A round aimed at the eye that clips a rise in the ground short of the player is a real miss in the '
        + 'game, but it means the hit rate at that range understates the AI by this fraction');
    }

    /* =============================== 3. AI time to kill ================ */
    //
    // Against a stationary player, per range, as a distribution. Measured from
    // the AI's first round to the round that carries cumulative damage past
    // maxHealth — the reconstruction validated in section 0(d) — so the same
    // engagements that produced the accuracy curve produce the TTK, and the
    // censored trials ("never killed inside the window") are visible rather than being
    // dropped into a median that then looks fast.
    {
      // Projection for the ranges where 5 s of contact is not enough to kill.
      // Built only from measured quantities — hit rate, mean damage per hit, and
      // the rate of fire the agent sustained while in ENGAGE — and labelled as an
      // extrapolation everywhere it is printed. Reporting "never" alone would
      // hide the difference between an AI that is 20% slow and one that cannot
      // win at all.
      const project = (d) => {
        const r = acc.get(d);
        const engS = (r.engageTicks * DT_LONG);
        const rate = engS > 0 ? r.fired / engS : NaN;              // rounds/s in contact
        const hitRate = r.fired ? r.hit / r.fired : NaN;
        const dmg = mean(r.amounts);
        return { t: SPEC.maxHealth / (rate * hitRate * dmg), rate, hitRate, dmg };
      };
      for (const d of RANGES) {
        const all = ttk.get(d);
        const done = all.filter(Number.isFinite);
        const censored = all.length - done.length;
        const p = project(d);
        const tgtT = targetFor(['ai.ttk', `ai.ttk_${d}m`]);
        if (tgtT) {
          report.against(`AI time-to-kill at ${d} m`, median(done), tgtT.value, tgtT.tol, ' s');
        } else {
          report.check(`AI time-to-kill at ${d} m`, done.length > 0,
            done.length
              ? `${dist(done, 'ms')} from the AI's first round to the round carrying cumulative damage past `
                + `${SPEC.maxHealth} HP; ${censored}/${all.length} engagements never got there inside the `
                + `${f2(WINDOW)} s window, at a measured hit rate of ${pct(p.hitRate)}, ${f2(p.rate)} rounds/s `
                + `while in contact and ${f2(p.dmg)} HP per hit — no sourced target yet`
              : `no engagement at ${d} m dealt ${SPEC.maxHealth} HP inside ${f2(WINDOW)} s across `
                + `${all.length} trials — the AI cannot kill a stationary player at this range in the time it `
                + `stays in contact. Extrapolating the measured hit rate ${pct(p.hitRate)}, ${f2(p.rate)} `
                + `rounds/s in contact and ${f2(p.dmg)} HP per hit, ${ms(p.t)} of UNBROKEN contact would be `
                + 'needed; that is an extrapolation from measured quantities, not an observed kill '
                + '— no sourced target yet');
        }
      }
      // Monotonicity, which is a property of the design rather than of a
      // sourced number: killing must not get faster as the player backs away.
      const meds = RANGES.map((d) => median(ttk.get(d).filter(Number.isFinite)));
      const mono = meds.every((v, i) => i === 0 || !Number.isFinite(v) || !Number.isFinite(meds[i - 1])
        || v >= meds[i - 1] - 0.02);
      report.check('AI time-to-kill does not improve with range', mono,
        RANGES.map((d, i) => `${d} m ${Number.isFinite(meds[i]) ? ms(meds[i]) : 'never'}`).join(', '));
    }

    /* ============================= 4. engagement pacing ================ */
    //
    // Burst length, inter-burst delay, and where the enemy's time goes. One long
    // engagement rather than many short ones: the reposition roll only comes up
    // after 3.2-6.2 s in ENGAGE, so a suite built out of 5 s windows would
    // report an enemy that never moves.
    {
      // A burst is a run of rounds separated by roughly CONFIG.burstDelay
      // (0.098 s). The 3x gate is loose enough to survive a tick of jitter and
      // far tighter than the 0.42-1.15 s inter-burst interval, so the split is
      // unambiguous rather than a threshold to be tuned.
      const GAP = 3 * 0.098;
      const bursts = [];
      const split = (fires) => {
        let first = null;
        for (const f of fires) {
          const b = bursts[bursts.length - 1];
          if (b && b.run && f.t - b.end <= GAP) { b.end = f.t; b.n++; } else {
            if (b) b.run = false;
            // `intended` is burstLeft on the burst's first round, which is the
            // count the agent rolled out of CONFIG.burstCount. Delivered can come
            // out lower when the agent loses sight of the player mid-burst: the
            // ENGAGE branch only advances a burst while `sees`, so the remaining
            // rounds are simply never fired.
            bursts.push({ start: f.t, end: f.t, n: 1, intended: f.bl, run: true, first: first === null });
          }
          if (first === null) first = f.t;
        }
        if (bursts.length) bursts[bursts.length - 1].run = false;
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
        if (!bursts[i].first) gaps.push(bursts[i].start - bursts[i - 1].end);
      }
      const inBurst = bursts.reduce((s, b) => s + (b.end - b.start), 0);

      // The long run, for where an enemy's time actually goes.
      const e = await engage({ d: 18, seconds: 26, dt: DT_LONG, state: 'engage', vulnerable: true });
      const span = e.rows.length ? e.rows[e.rows.length - 1].t - e.rows[0].t : NaN;
      const frac = {};
      for (const r of e.rows) frac[r.est] = (frac[r.est] ?? 0) + 1;
      const fracStr = Object.entries(frac)
        .map(([k, v]) => `${k} ${pct(v / e.rows.length)}`).join(', ');

      report.check('engagement pacing was measured over enough bursts to have a shape',
        bursts.length >= 8,
        `${contactRounds} rounds in ${bursts.length} bursts across 6 engagements of 8.0 s at 18 m, `
        + `${f2(contactSpan)} s of that in contact; plus one ${f2(span)} s run for state occupancy`);
      // Burst length is reported as a distribution and then held to
      // CONFIG.burstCount, which is the one AI pacing quantity that has a stated
      // intent to be held to. Over-long bursts are not a splitter artefact so
      // much as a consequence of ENGAGE decrementing fireTimer *during* the
      // burst: fireInterval is timed from the moment the burst is armed, a burst
      // of five rounds at 0.098 s spacing takes 0.39 s of that interval, so a
      // 0.42 s roll leaves ~30 ms between one burst and the next and the player
      // hears one long burst. The gap distribution beside it is the evidence.
      // Two checks, one phenomenon each, so a single cause cannot light up two
      // red lines. The roll is what CONFIG.burstCount governs; whether the roll
      // survives to the barrel is a separate question and belongs below.
      const intended = bursts.map((b) => b.intended);
      const outside = intended.filter((n) => n < 2 || n > 5).length;
      report.check('the burst lengths the AI rolls stay inside CONFIG.burstCount [2, 5]',
        intended.length > 0 && outside === 0,
        `rolled ${intended.join('/')} — median ${f2(median(intended))} rounds [p10 `
        + `${f2(quant(intended, 0.1))} .. p90 ${f2(quant(intended, 0.9))}], ${outside}/${intended.length} `
        + 'outside [2, 5]');
      const cut = bursts.filter((b) => b.n < b.intended).length;
      const merged = bursts.filter((b) => b.n > b.intended).length;
      report.check('every burst the AI starts is the burst it delivers',
        cut === 0 && merged === 0,
        `delivered ${lens.join('/')} against ${intended.join('/')} rolled: ${cut} bursts cut short, `
        + `${merged} runs longer than the roll. The ENGAGE branch only advances a burst while it can see the `
        + 'player, so a burst interrupted by cover is abandoned rather than resumed; and fireTimer is '
        + 'decremented DURING the burst, so a 5-round burst spending 0.39 s of a 0.42 s interval can run '
        + `straight into the next one — shortest observed gap between bursts ${ms(Math.min(...gaps))} against a `
        + 'CONFIG.fireInterval floor of 420 ms');
      report.check('AI inter-burst delay', gaps.length > 0,
        `${dist(gaps, 'ms')} between the last round of a burst and the first of the next, against a `
        + 'CONFIG.fireInterval of [0.42, 1.15] s measured from the start of the previous burst — measured, no '
        + 'sourced target');
      report.check('AI firing duty cycle', Number.isFinite(inBurst / contactSpan),
        `${pct(inBurst / contactSpan)} of the time in contact is spent inside a burst, `
        + `${pct(1 - inBurst / contactSpan)} between bursts (${f2(contactRounds / contactSpan)} rounds/s while `
        + 'in contact) — measured, no sourced target');
      // The number that reframes every pacing figure above, and it is not in the
      // project's baseline: over a 26 s firefight this agent is out of contact
      // most of the time. It repositions to a cover point chosen by
      // pickCover() — which scores for cover, not for sight lines — loses LOS
      // there, decays out of ALERT into IDLE, and stops looking for the player
      // it was fighting five seconds earlier.
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
        (frac.reposition ?? 0) > 0,
        `${pct((frac.reposition ?? 0) / e.rows.length)} of ticks in REPOSITION, maximum displacement `
        + `${f2(moved)} m from the spawn point over ${f2(span)} s`);
    }

    /* ============================ 5. leading a mover =================== */
    //
    // Two questions that look like one. Does a strafing player get hit less than
    // a standing one, and does the AI's aim point sit ahead of the player at
    // all?
    //
    // The second is the mechanism and it is measured directly: the recorder
    // stores, for every round, the closest approach of the actual post-spread
    // ray to the eye, projected onto the player's own direction of travel. The
    // spread cone is symmetric and zero-mean, so the average of that projection
    // over a hundred rounds is the aim bias. Positive means the AI shoots where
    // the player is going.
    {
      const STRAFE = IN_DYN('{ left: Math.floor(t / 0.7) % 2 === 0, right: Math.floor(t / 0.7) % 2 === 1 }');
      const stand = { fired: 0, hit: 0, lat: [], atFire: [] };
      const move = { fired: 0, hit: 0, lat: [], atFire: [], speed: [], travel: [] };
      // Twelve pairs, not three. At ~30 rounds a side one standard error on the
      // difference of two hit rates is about 12 points, and the first run of this
      // section measured strafing 21 points WORSE than standing while the second,
      // after an unrelated change shifted where the shared seeded stream was,
      // measured it 15 points BETTER. Both were noise. The detail prints the
      // two-proportion standard error so the reader can see which it is.
      for (let i = 0; i < 12; i++) {
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
      // Two-proportion standard error, so a 20-point difference over 30 rounds a
      // side is not read as a design property. The mechanism note matters as much
      // as the number: main.enemyShoot() re-aims at camera.position on the tick it
      // fires and resolves the round on that same tick, so movement cannot open
      // any aim error at all — whatever difference survives here comes from the
      // eye being near the top of the player's AABB and from the view bob moving
      // it, not from the AI failing to track.
      const se = Math.sqrt(rS * (1 - rS) / stand.fired + rM * (1 - rM) / move.fired);
      report.check('strafing reduces the AI hit rate', rM < rS * 0.9,
        `standing ${pct(rS)} (${stand.hit}/${stand.fired}) vs strafing ${pct(rM)} (${move.hit}/${move.fired}) `
        + `at 20 m, ratio ${f2(rM / rS)}, difference ${pct(rS - rM)} +/- ${pct(se)} (1 s.e.), i.e. `
        + `${f2((rS - rM) / se)} standard errors; structural floor: a mover must be at least 10% harder to hit`);

      // The measurement that explains whichever way the above goes. The AI aims
      // at camera.position at the instant of firing and the round is a raycast
      // resolved on the same tick, so there is nothing for a lead to correct
      // and no flight time to correct for.
      const bias = mean(move.lat);
      report.check('the AI leads a moving player', bias > 0.10,
        `mean lateral aim offset along the player's direction of travel ${f3(bias)} m over ${move.lat.length} `
        + `rounds (p10 ${f3(quant(move.lat, 0.1))} m, p90 ${f3(quant(move.lat, 0.9))} m); 0.10 m is a `
        + 'structural floor — roughly a shoulder width of lead — not a sourced CoD figure');

      // Why there is no lead to measure: AI fire is hitscan. Established by
      // calling shoot() directly a dozen times at the engagement range — enough
      // that the spread cone connects on several of them whatever it rolls — and
      // comparing the tick each round left the barrel with the tick its damage
      // landed; a round that misses contributes no sample and costs nothing. A
      // projectile at any muzzle velocity would resolve later. This does have a
      // sourced target: "bullets are projectiles with travel time" is a
      // documented property of the shooter being cloned.
      const travel = await sim.eval(() => {
        const g = window.__GAME;
        const e = g.director.enemies[0];
        if (!e) return null;
        let fired = 0, resolved = 0, worst = 0;
        for (let i = 0; i < 12; i++) {
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
      // 1 if any round resolved on a later tick than it was fired on, 0 if every
      // one resolved instantly. Measured, not assumed from reading main.js.
      const isProjectile = travel && travel.resolved > 0 && travel.worst > 0 ? 1 : 0;
      const tgtP = targetFor(['ballistics.bullet_model_is_projectile_not_hitscan']);
      if (tgtP) {
        report.against('AI rounds are projectiles with travel time',
          isProjectile, tgtP.value, tgtP.tol, ' (1 = projectile)');
        report.check('AI ballistic model target is sourced', true,
          `source: ${tgtP.source} — ${travel ? travel.resolved : 0}/${travel ? travel.fired : 0} probe rounds `
          + `fired from ${travel ? f2(travel.dist) : '?'} m landed damage, and the largest gap between a round `
          + `leaving the barrel and its damage arriving was ${travel ? ms(travel.worst) : 'n/a'}: AI fire is a `
          + 'single Raycaster call inside main.enemyShoot(), resolved on the firing tick, so leading is not a '
          + 'question the AI can answer');
      } else {
        report.check('AI rounds have travel time', isProjectile === 1,
          `largest round-to-damage gap ${travel ? ms(travel.worst) : 'n/a'} over `
          + `${travel ? travel.resolved : 0} resolved rounds — no sourced target found`);
      }
    }

    /* ====================== 6. hitbox fidelity vs the mesh ============= */
    //
    // The defect this section exists for: buildSoldier() tags hit zones on the
    // meshes it remembers, and director.raycast() only ever intersects tagged
    // meshes. Anything untagged is rendered, lit, shadow-casting, part of the
    // silhouette the player puts the crosshair on — and invisible to every
    // bullet in the game.
    //
    // Counting untagged meshes is not the measurement. A mesh matters in
    // proportion to the solid angle it occupies from where the player is
    // standing, so the measurement is a dense grid of rays from a realistic
    // firing distance across the silhouette, each classified three ways:
    //
    //   registered — nearest visible hit resolves to a tagged mesh (or a tagged
    //                mesh lies behind an untagged one along the same ray)
    //   through    — hit something visible, no tagged mesh anywhere along the
    //                ray: the player sees a target, the game registers nothing
    //   miss       — did not touch the model
    //
    // "through / (registered + through)" is the defect rate: the fraction of the
    // silhouette that eats rounds without consequence.
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
          all: s.all.length, vis: s.vis.length, tagged: s.tagged.length,
          untagged: s.untagged.map((o) => window.__AI.describe(o)),
        };
      });
      const tgtI = targetFor(['integrity.hitbox_visible_mesh_hittable']);
      const untaggedDetail = `${counts.tagged}/${counts.vis} visible meshes tagged (${counts.all} meshes total `
        + `including the opacity-0 muzzle sprite); ${counts.untagged.length} visible and untagged: `
        + counts.untagged.join(' | ');
      if (tgtI) {
        report.against('visible soldier meshes that cannot be hit',
          counts.untagged.length, tgtI.value, tgtI.tol, ' meshes');
        report.check('the hittable-mesh invariant is sourced', true, `source: ${tgtI.source} — ${untaggedDetail}`);
      } else {
        report.check('every visible mesh on the soldier is zone-tagged',
          counts.untagged.length === 0, untaggedDetail);
      }

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
      const defect = agg.through / onModel;

      // Liveness before the number is quoted: a grid that hit nothing, or hit
      // everything, is a grid that was aimed wrong.
      report.check('the silhouette grid actually straddles the soldier',
        onModel > 300 && agg.miss > 300,
        `${N}x${N} = ${N * N} rays from ${f2(agg.dist)} m across a `
        + `${f2(agg.extent[0])} x ${f2(agg.extent[1])} m plane: ${onModel} hit the model, ${agg.miss} passed `
        + 'beside it');

      const tgtH = targetFor(['hitbox.fidelity', 'hitbox.untagged_fraction']);
      if (tgtH) {
        report.against('hitbox coverage defect rate', defect, tgtH.value, tgtH.tol, '');
        report.check('hitbox fidelity target is sourced', true, `source: ${tgtH.source}`);
      } else {
        report.check('no visible part of the soldier is unhittable',
          agg.through === 0,
          `${pct(defect)} of the silhouette (${agg.through}/${onModel} rays) hits geometry the player can see `
          + 'and nothing the game will register. Offenders: '
          + Object.entries(agg.offenders).sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${v} rays ${k}`).join(' | ')
          + ' — no sourced target yet (targets.mjs lists hitbox_fidelity in its own missing() set)');
      }

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
      report.check('per-zone share of the hittable silhouette', agg.zones.head / zSum > 0.01,
        `head ${pct(agg.zones.head / zSum)} (${agg.zones.head} rays), body ${pct(agg.zones.body / zSum)} `
        + `(${agg.zones.body}), limb ${pct(agg.zones.limb / zSum)} (${agg.zones.limb}) of ${zSum} registering `
        + 'rays — measured, no sourced target; the 1% head floor is structural');
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
      report.check('zone damage multipliers, measured from health deltas', true,
        `head x${f3(m.head)}, body x${f3(m.body)}, limb x${f3(m.limb)} against a base of ${SPEC.damage} HP `
        + '— measured, no sourced target for zone multipliers in targets.mjs');
      report.check('a body hit is the unmultiplied reference', Math.abs(m.body - 1) < 0.02,
        `body multiplier measured x${f3(m.body)}; anything else means falloff or the probe's own arithmetic `
        + 'is leaking into the ratio');
      report.check('a headshot is worth more than a body shot', m.head > m.body * 1.5,
        `head x${f3(m.head)} vs body x${f3(m.body)}, ratio ${f2(m.head / m.body)}`);
      report.check('a limb hit is worth less than a body shot', m.limb < m.body,
        `limb x${f3(m.limb)} vs body x${f3(m.body)}, ratio ${f2(m.limb / m.body)}`);

      // SPEC.headshotMultiplier is 2.4 and ai.js applies 2.6. The dead constant
      // is proved dead behaviourally: quadruple it and re-measure. A test that
      // read the constant would report a headshot multiplier this weapon has
      // never had.
      const prev = await sim.eval((v) => {
        const s = window.__AI.SPEC; const before = s.headshotMultiplier; s.headshotMultiplier = v; return before;
      }, 9.9);
      const again = await sim.eval((a) => window.__AI.zoneProbe(a), { n: 24 });
      await sim.eval((v) => { window.__AI.SPEC.headshotMultiplier = v; }, prev);
      const headAgain = median(again.probes.filter((p) => p.zone === 'head').map((p) => p.delta / p.raw));
      report.check('SPEC.headshotMultiplier governs headshot damage',
        Math.abs(headAgain - m.head) > 0.1,
        `SPEC.headshotMultiplier ${f2(prev)} -> 9.9 left the measured head multiplier at x${f3(headAgain)} `
        + `(was x${f3(m.head)}); the live multiplier is the 2.6 hard-coded in Enemy.applyDamage(), so the `
        + 'constant is dead');
    }

    /* ------------------------------------------------ coverage gaps ----- */
    //
    // What targets.mjs itself says it cannot check. Printing this is the point:
    // a suite that stays quiet about its blind spots implies coverage it does
    // not have, and three of this file's four domains have no external number
    // to be held to.
    if (missing) {
      const gaps = missing().filter((k) => ['ai_reaction', 'ai_accuracy', 'hitbox_fidelity'].includes(k));
      report.check('AI and hitbox targets exist in targets.mjs', gaps.length === 0,
        `${gaps.length} of this suite's domains have no sourced target: ${gaps.join(', ')} — every quantity `
        + 'above is measured and printed, but only the player-health and ballistic-model checks are held to '
        + 'an external figure');
    }
  } finally {
    // The runner boots one sim for every suite. A leaked SPEC mutation or a
    // player left invulnerable would surface as a mystery failure in whichever
    // file runs next.
    await sim.eval(() => {
      const g = window.__GAME;
      delete g.player.damage;
      g.player.__realDamage = undefined;
      g.player.health = window.__AI.TUNING.maxHealth;
      g.player.alive = true;
    }).catch(() => {});
  }
}
