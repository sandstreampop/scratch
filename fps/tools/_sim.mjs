// Fixed-timestep gameplay simulation driver.
//
// Every gameplay number in this project is measured through this file, and it
// exists because the alternative — reading the tuning constants out of the
// source and asserting on them — measures the author's intent rather than the
// game. Constants lie: SPEC.adsTime was 0.19 for months while the actual ADS
// transition ran on an unrelated damping rate, and nothing that read the
// constant could have noticed.
//
// So this boots the real page in a real engine, refuses to start the render
// loop, and calls game.step(dt) itself at a fixed dt. What comes back is what
// the simulation does.
//
// Three properties matter and are each load-bearing:
//
//   Fixed dt.  The shipping loop runs on clock.getDelta(), so any measurement
//   taken through it is a measurement of the runner's frame pacing. Driving
//   step() directly removes the runner from the result.
//
//   Seeded randomness.  Math.random is replaced before any module evaluates,
//   so spread cones, AI reaction rolls and procedural generation all replay
//   identically. A distribution measured over 400 seeded shots is a property
//   of the game; the same measurement over unseeded shots is a property of the
//   afternoon.
//
//   No render.  step() is separable from render(), and the post stack costs
//   ~200 ms/frame on a software rasteriser. Skipping it is the difference
//   between a suite that runs in the loop and one that never gets run.
//
// Self-check: `node tools/_sim.mjs --selfcheck` asserts the driver can detect
// change at all — that seeding is real, that dt is honoured, and that a
// deliberately wrong expectation fails. A harness whose silence has never been
// tested is not evidence of anything.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT = path.resolve(HERE, '..');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.map': 'application/json',
};

function serve(root) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * The page-side driver, installed once per boot.
 *
 * It is one big evaluate rather than a call per tick because a round trip per
 * tick puts the harness's own latency inside the measurement: 3000 ticks of a
 * 2 ms round trip is six seconds of wall clock spent measuring Playwright.
 */
const DRIVER = () => {
  const g = window.__GAME;

  // Sound is synthesised on a real AudioContext, so calls are intercepted for
  // their timestamps rather than silenced — audio-to-event latency is one of
  // the things under test and cannot be measured through a muted stub.
  const events = [];
  window.__SIM = {
    events,
    simTime: () => g.elapsed,
    tap(obj, names, label) {
      for (const name of names) {
        const original = obj[name];
        if (typeof original !== 'function' || original.__tapped) continue;
        const wrapped = function (...args) {
          events.push({
            kind: `${label}.${name}`,
            sim: g.elapsed,
            audio: g.audio?.ctx ? g.audio.ctx.currentTime : null,
            wall: performance.now() / 1000,
            args: args.map((a) => (typeof a === 'number' || typeof a === 'string' ? a : null)),
          });
          return original.apply(this, args);
        };
        wrapped.__tapped = true;
        obj[name] = wrapped;
      }
    },
  };

  // Everything the tests need to observe, in one place so a test never reaches
  // into private state and silently starts passing when that state is renamed.
  window.__SIM.snapshot = () => {
    const p = g.player, w = g.weapon;
    return {
      t: g.elapsed,
      px: p.position.x, py: p.position.y, pz: p.position.z,
      vx: p.velocity.x, vy: p.velocity.y, vz: p.velocity.z,
      speed: Math.hypot(p.velocity.x, p.velocity.z),
      onGround: p.onGround ? 1 : 0,
      height: p.height,
      crouching: p.crouching ? 1 : 0,
      sprinting: p.sprinting ? 1 : 0,
      ads: p.ads,
      yaw: p.yaw, pitch: p.pitch,
      recoilPitch: p.recoilPitch, recoilYaw: p.recoilYaw,
      // Where the shot actually goes, which is the only recoil number that
      // matters to the player. Composed from the camera so it includes every
      // layer the view applies, not just the ones a test remembered to add.
      aimPitch: p.pitch + p.recoilPitch,
      aimYaw: p.yaw + p.recoilYaw,
      health: p.health,
      ammo: w.ammo, reserve: w.reserve,
      reloading: w.reloading ? 1 : 0,
      spread: w.currentSpread(p),
      fov: g.weapon.camera.fov,
      enemiesAlive: g.director.enemies.filter((e) => e.alive).length,
    };
  };

  // Distance to the first piece of world geometry along a ray, or `maxDist` if
  // nothing is in the way. Uses the game's own raycastables list, so "the lane
  // is clear" means clear to the same geometry a bullet is resolved against.
  window.__SIM.rayWorld = (from, dir, maxDist = 220) => {
    const THREE = window.__THREE;
    const o = new THREE.Vector3(from[0], from[1], from[2]);
    const d = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
    const ray = new THREE.Raycaster(o, d, 0.1, maxDist);
    const hits = ray.intersectObjects(window.__GAME.level.raycastables, false);
    return hits.length ? hits[0].distance : maxDist;
  };

  /** Aims the player at an enemy's chest and reports whether the shot can land. */
  window.__SIM.aimAt = (enemyIndex = 0) => {
    const g = window.__GAME;
    const THREE = window.__THREE;
    const e = g.director.enemies[enemyIndex];
    if (!e) return { error: 'no such enemy' };
    const aim = e.chestPosition(new THREE.Vector3());
    const eye = g.camera.position;
    const dx = aim.x - eye.x, dy = aim.y - eye.y, dz = aim.z - eye.z;
    g.player.yaw = Math.atan2(-dx, -dz);
    g.player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    // One SIMULATION step, not one 1/240 step. The game banks the time it is
    // handed and only integrates in fixed g.tickLength slices, so a 1/240 call
    // advances nothing at all: this used to leave the camera wherever the
    // previous section had left it and return an aim computed from a stale eye.
    g.step(g.tickLength ?? 1 / 240);
    const dir = g.player.aimDirection(new THREE.Vector3());
    const enemyHit = g.director.raycast(g.camera.position, dir, 260);
    const worldDist = window.__SIM.rayWorld(
      [g.camera.position.x, g.camera.position.y, g.camera.position.z], [dir.x, dir.y, dir.z], 260);
    return {
      distance: aim.distanceTo(eye),
      zone: enemyHit ? enemyHit.zone : null,
      enemyDist: enemyHit ? enemyHit.distance : null,
      worldDist,
      // The only thing a caller should branch on: can this shot reach the body?
      clear: !!enemyHit && enemyHit.distance < worldDist,
    };
  };

  window.__SIM.drive = ({ ticks, dt, inputBody, sampleBody, sampleEvery = 1 }) => {
    const input = inputBody ? new Function('t', 'i', 'g', 'sim', inputBody) : null;
    const sample = sampleBody ? new Function('t', 'i', 'g', 'sim', sampleBody) : null;
    const out = [];
    for (let i = 0; i < ticks; i++) {
      const t = g.elapsed;
      if (input) {
        const patch = input(t, i, g, window.__SIM);
        if (patch) Object.assign(g.input, patch);
      }
      g.step(dt);
      if (i % sampleEvery === 0) {
        const base = window.__SIM.snapshot();
        if (sample) {
          const extra = sample(g.elapsed, i, g, window.__SIM);
          if (extra) Object.assign(base, extra);
        }
        out.push(base);
      }
    }
    return out;
  };
};

/**
 * Boots the game and hands back a driver.
 *
 * `dist` selects the bundle users actually load. The source tree is the default
 * because it is what an implementer edits, and a suite that only tests the
 * bundle makes every iteration wait on a build.
 */
export async function openSim({
  dist = false, seed = 0x9e3779b9, quality = 'low', desktop = true, verbose = false,
} = {}) {
  let pw;
  try { pw = await import('playwright'); } catch { pw = await import('playwright-core'); }

  const root = dist ? path.join(PROJECT, 'dist') : PROJECT;
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    throw new Error(`sim: no index.html in ${root}${dist ? ' — run `node build.mjs` first' : ''}`);
  }
  const { server, port } = await serve(root);

  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
      '--mute-audio'],
  };
  if (fs.existsSync('/opt/pw-browsers/chromium')) {
    launchOptions.executablePath = '/opt/pw-browsers/chromium';
  }
  const browser = await pw.chromium.launch(launchOptions);
  const context = await browser.newContext(
    desktop
      ? { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 }
      : { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  );
  const page = await context.newPage();

  // Before any module evaluates, so procedural generation is seeded too.
  await page.addInitScript(`(() => {
    let s = ${seed} >>> 0;
    Math.random = function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    Math.random.__seeded = ${seed};
    window.__SEED = ${seed};
  })()`);

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 400)));
  page.on('console', (m) => {
    // Chromium asks for a favicon nobody shipped. Recording that as a page
    // error makes every run come back dirty, which is how a harness teaches
    // its reader to ignore its own error channel.
    const from = m.location?.().url ?? '';
    const benign = m.type() === 'error' && /favicon/.test(from);
    if (m.type() === 'error' && !benign) errors.push(`${m.text().slice(0, 300)}${from ? ` @ ${from}` : ''}`);
    else if (verbose) console.log(`    [page] ${m.text().slice(0, 200)}`);
  });

  const url = `http://127.0.0.1:${port}/index.html?quality=${quality}`;
  await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction('!!(window.__GAME && window.__GAME.ready)', null,
    { timeout: 180000, polling: 250 });

  // Deliberately never taps start, so requestAnimationFrame never takes over
  // and step() is called only from here. If the render loop were running the
  // measurement would be of the loop plus the harness, interleaved.
  await page.evaluate(DRIVER);

  const seedOk = await page.evaluate(() => Math.random.__seeded ?? null);
  if (seedOk === null) throw new Error('sim: Math.random was not seeded — measurements would not replay');

  const sim = {
    page, browser, errors, seed,

    /** Raw escape hatch. Prefer the named helpers; they keep tests honest. */
    eval: (fn, arg) => page.evaluate(fn, arg),

    /**
     * Puts the world in a known state.
     *
     * Enemies are cleared and re-placed rather than reused: the director spawns
     * on its own schedule, so a test that does not own the roster is measuring
     * whatever happened to be alive.
     */
    async setup({
      position = [-6, null, 17], yaw = Math.PI * 0.86, pitch = 0, ads = null,
      enemies = [], audio = false, invulnerable = true, ammo = null, health = null,
      director = false,
    } = {}) {
      return page.evaluate((cfg) => {
        const g = window.__GAME;
        g.audio.enabled = cfg.audio;
        // The AudioContext is built in init(), which the game only calls from a
        // user gesture. Without this every audio timestamp comes back null and
        // the latency suite silently measures nothing.
        if (cfg.audio) { g.audio.init(); g.audio.resume?.(); }
        document.getElementById('start')?.classList.add('hidden');
        document.getElementById('loading')?.classList.add('hidden');

        for (const e of g.director.enemies) g.scene.remove(e.group);
        g.director.enemies.length = 0;
        g.director.maxAlive = cfg.director ? g.director.maxAlive : 0;

        const p = g.player;
        p.position.set(cfg.position[0], 0, cfg.position[2]);
        p.position.y = cfg.position[1] === null
          ? g.level.groundHeight(cfg.position[0], cfg.position[2])
          : cfg.position[1];
        p.velocity.set(0, 0, 0);
        p.yaw = cfg.yaw; p.pitch = cfg.pitch;
        p.recoilPitch = p.recoilYaw = 0;
        p._recoilPitchVel = p._recoilYawVel = 0;
        p.health = cfg.health ?? 100;
        p.alive = true;
        p.onGround = true;
        p.crouching = false;
        if (cfg.ads !== null) { p.ads = cfg.ads; p.adsTarget = cfg.ads; }

        // The default. A test about ballistics should not end because the
        // garrison shot the instrument.
        if (cfg.invulnerable) { if (!p.__realDamage) p.__realDamage = p.damage; p.damage = () => {}; }
        else if (p.__realDamage) { p.damage = p.__realDamage; }

        const w = g.weapon;
        // `cfg.ammo ?? w.constructor.name ? … : …` parsed as ((0 ?? name) ? …)
        // and 0 is falsy, so `ammo: 0` — the only way to ask for an empty
        // magazine, and the whole of the empty-reload measurement — silently
        // handed back a full one.
        w.ammo = cfg.ammo ?? 30;
        w.reserve = 180;
        w.reloading = false;
        w.spread = 0;
        w._shotCount = 0;
        w.lastShot = -99;

        for (const k of Object.keys(g.input)) {
          if (typeof g.input[k] === 'boolean') g.input[k] = false;
        }

        const spawned = [];
        for (const e of cfg.enemies) {
          const pos = new (g.player.position.constructor)(e.x, 0, e.z);
          const enemy = g.director.spawn(pos);
          enemy.facing = e.facing ?? 0;
          enemy.targetFacing = enemy.facing;
          if (e.engage) { enemy.state = 'engage'; enemy._aimBlend = 1; enemy.lastKnown = g.camera.position.clone(); }
          // A target dummy must still run update(): that is what refreshes the
          // soldier's world matrices, and director.raycast intersects the actual
          // meshes. Stubbing update() out — the obvious way to write "inert" —
          // leaves every bone at the origin, so the raycast finds nothing and
          // the whole TTK section reports misses on a shot that was dead centre.
          // Silencing shoot() gets the intended behaviour without that.
          //
          // But update() also NAVIGATES, and a dummy that walks is not a dummy.
          // playerShoot() calls director.alertAll(player.position, 55), so the
          // first round of any measurement wakes a target inside 55 m into ALERT
          // with the player's position as its lastKnown; a soldier facing 0 by
          // default cannot see the player, so the ALERT branch walks him toward
          // that point at CONFIG.walkSpeed. Measured drift was 0.42 m over the
          // five travel-time ranges and 0.41 m across 114 TTK engagements — a
          // target contributing its own motion to a travel-time measurement, and
          // 42 cm is 0.6 ms of flight at this muzzle velocity plus a moving
          // chest for the spread cone to miss.
          //
          // Neutralised at integrate(), which is the one place the body is
          // actually displaced, rather than by stubbing update() or by teleporting
          // the body back afterwards. The state machine still runs, the facing
          // still turns, animate() still poses the skeleton off a zero velocity,
          // and every hit mesh is where the spawn put it — which is all a target
          // dummy has ever been asked to be. Nothing rides on the velocity being
          // zeroed rather than the position being restored except honesty about
          // the pose: a body snapped back each tick would be walking on the spot
          // in every frame the raycast sees.
          if (e.inert) {
            enemy.shoot = () => {};
            const integrate0 = enemy.integrate.bind(enemy);
            enemy.integrate = (dt) => { enemy.velocity.set(0, 0, 0); integrate0(dt); };
          }
          if (e.health !== undefined) enemy.health = e.health;
          enemy.group.updateMatrixWorld(true);
          spawned.push({ id: enemy.id, x: enemy.position.x, y: enemy.position.y, z: enemy.position.z });
        }

        // A known world state includes what is already in the air and what the
        // loop still owes: a round from the previous burst arriving after the
        // roster was replaced is attributed to the new engagement, and a
        // fractional tick left in the accumulator shifts the tick grid of the
        // next trace, which is exactly the thing the frame-rate independence
        // measurements are trying to hold still.
        g.resetSimulation?.();

        // One SIMULATION step so the camera, view matrices and enemy poses match
        // the state just written. Without it the first sample of every trace is
        // stale, which reads as a one-tick lag in every timing measured off tick
        // zero. It has to be a whole g.tickLength: the game banks the time it is
        // handed and integrates only in fixed slices, so a 1/240 call advances
        // nothing whatsoever.
        g.step(g.tickLength ?? 1 / 240);
        window.__SIM.events.length = 0;
        return { spawned, t: g.elapsed };
      }, { position, yaw, pitch, ads, enemies, audio, invulnerable, ammo, health, director });
    },

    /** Installs timestamp taps on the systems whose latency is under test. */
    async tapEvents() {
      return page.evaluate(() => {
        const g = window.__GAME;
        window.__SIM.tap(g.audio, ['gunshot', 'impact', 'hitmarker', 'mechanical', 'hurt', 'snap', 'footstep'], 'audio');
        window.__SIM.tap(g.weapon, ['fire'], 'weapon');
        window.__SIM.tap(g.vfx, ['muzzleSmoke', 'impact', 'bloodBurst'], 'vfx');
        for (const e of g.director.enemies) window.__SIM.tap(e, ['applyDamage'], 'enemy');
        return Object.keys(g.audio).length;
      });
    },

    /**
     * Runs `ticks` fixed steps.
     *
     * `input` and `sample` are function bodies, not functions — they are
     * compiled inside the page, so they can close over nothing here and there
     * is no ambiguity about which side of the bridge they run on.
     */
    async drive({ seconds = null, ticks = null, dt = 1 / 120, input = null, sample = null, sampleEvery = 1 }) {
      const n = ticks ?? Math.round(seconds / dt);
      if (!Number.isFinite(n) || n <= 0) throw new Error('sim.drive: need positive seconds or ticks');
      // Chunked so a long run cannot trip the evaluate timeout, and so the page
      // gets to breathe between batches.
      const CHUNK = 900;
      const rows = [];
      let done = 0;
      while (done < n) {
        const take = Math.min(CHUNK, n - done);
        const part = await page.evaluate(
          (a) => window.__SIM.drive(a),
          { ticks: take, dt, inputBody: input, sampleBody: sample, sampleEvery },
        );
        rows.push(...part);
        done += take;
      }
      return rows;
    },

    /** Picks a heading from `from` with the most unobstructed distance. */
    async clearLane(from = [0, null, 0], need = 130) {
      return page.evaluate((cfg) => {
        const g = window.__GAME;
        const y = (cfg.from[1] === null ? g.level.groundHeight(cfg.from[0], cfg.from[2]) : cfg.from[1]) + 1.6;
        let best = { deg: 0, clear: -1 };
        for (let deg = 0; deg < 360; deg += 2) {
          const a = deg * Math.PI / 180;
          const d = window.__SIM.rayWorld([cfg.from[0], y, cfg.from[2]], [Math.sin(a), 0, Math.cos(a)], cfg.need + 20);
          if (d > best.clear) best = { deg, clear: d };
        }
        return best;
      }, { from, need });
    },

    async aimAt(enemyIndex = 0) { return page.evaluate((i) => window.__SIM.aimAt(i), enemyIndex); },

    async events() { return page.evaluate(() => window.__SIM.events.slice()); },
    async clearEvents() { return page.evaluate(() => { window.__SIM.events.length = 0; }); },
    async snapshot() { return page.evaluate(() => window.__SIM.snapshot()); },

    async close() {
      await browser.close().catch(() => {});
      server.close();
    },
  };
  return sim;
}

/* ----------------------------------------------------------- assertions -- */

/**
 * The reporter, rewritten to make the ways a suite lies structurally impossible
 * rather than merely discouraged.
 *
 * The first generation of suites was audited by a critic per suite, and four of
 * five came back as decoration. Every defect was something the old three-method
 * reporter permitted:
 *
 *   - 23 of 53 movement checks were `check(name, true, …)`: green by
 *     construction. Raising walkSpeed by 32% left the failure set byte-identical.
 *   - Expectations were read from the constant under test, so both sides of the
 *     comparison moved together and nothing constrained any speed at all.
 *   - Every suite wrote its own fuzzy target lookup, matching camelCase against
 *     targets.mjs's snake_case keys. Two of twenty resolved in movement, zero of
 *     ten in ai — and each miss printed "no sourced target yet", which was a
 *     false claim about the research rather than a bug report about the lookup.
 *   - `Number(null)` is 0, so a threshold that was never crossed printed as
 *     "measured 0.0000 ms" and passed.
 *   - An airtime in milliseconds was compared against a target in seconds and
 *     reported as "off by 81233%", which is a test that a 0.6 ms jump passes.
 *
 * So: there is no way to pass a target value by hand (`against` takes a
 * domain and a key and throws if the key is absent, which also fixes units and
 * tolerance at the source), no way to record an unverified quantity as a
 * passing check (`measure` prints but never counts as a pass), and no way for a
 * missing measurement to read as zero (non-finite input throws).
 */
export function makeReporter(label, { targets = null } = {}) {
  const rows = [];
  const fmt = (v, unit = '') => {
    if (v === null || v === undefined) return 'none';
    const a = Math.abs(v);
    const s = a >= 1000 ? v.toFixed(0) : a >= 100 ? v.toFixed(1)
      : v.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
    return `${s}${unit}`;
  };
  const finite = (name, v, what) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(
        `${what}("${name}") got ${JSON.stringify(v)}, which is not a finite number. `
        + 'A measurement that did not happen must not be reported as one — assert that it '
        + 'happened with report.reached() first, then measure it.',
      );
    }
  };

  const report = {
    rows,
    get targets() { return targets; },

    /**
     * A structural invariant: something that must hold regardless of any
     * reference value (a body never inside geometry, one sound per round, a
     * monotonic curve). `ok` must be a real boolean and `detail` must carry a
     * number, because a PASS with no number in it cannot be audited.
     */
    check(name, ok, detail) {
      if (typeof ok !== 'boolean') {
        throw new Error(`check("${name}") was given ${typeof ok} for ok — pass a comparison, not a value`);
      }
      if (!detail || !/\d/.test(String(detail))) {
        throw new Error(`check("${name}") has no number in its detail — that is not a measurement`);
      }
      rows.push({ kind: 'check', name, ok, detail });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`);
      return ok;
    },

    /**
     * Asserts a measurement against a sourced target, by key.
     *
     * The target, its unit and its tolerance all come from targets.mjs. A
     * caller cannot supply them, so a suite cannot invent a tolerance, cannot
     * drift out of sync with the research, and cannot compare milliseconds
     * against seconds. An unknown key throws rather than degrading into a
     * cheerful "no target yet".
     */
    against(name, measured, domain, key) {
      if (!targets) throw new Error(`against("${name}") needs targets.mjs — the runner passes it in`);
      const entry = targets.TARGETS?.[domain]?.[key];
      if (!entry) {
        throw new Error(
          `against("${name}") references ${domain}.${key}, which is not in targets.mjs. `
          + `Known keys in "${domain}": ${Object.keys(targets.TARGETS?.[domain] ?? {}).join(', ') || '(no such domain)'}`,
        );
      }
      if (entry.tol === null || entry.tol === undefined) {
        throw new Error(
          `against("${name}") references ${domain}.${key}, which is qualitative (tol: null). `
          + 'Assert the behaviour it describes with check() and quote the note.',
        );
      }
      finite(name, measured, 'against');
      const t = entry.value;
      const tol = entry.tol;
      const lo = tol.min ?? (tol.pct != null ? t * (1 - tol.pct) : t - tol.abs);
      const hi = tol.max ?? (tol.pct != null ? t * (1 + tol.pct) : t + tol.abs);
      const ok = measured >= lo && measured <= hi;
      const unit = entry.unit ? ` ${entry.unit}` : '';
      const off = (t !== 0 && t !== null) ? `, off by ${((measured / t - 1) * 100).toFixed(1)}%` : '';
      rows.push({
        kind: 'check', name, ok, target: `${domain}.${key}`,
        detail: `measured ${fmt(measured)}${unit}, target ${fmt(t)}${unit} `
          + `[${fmt(lo)}..${fmt(hi)}]${off}  <${domain}.${key}>`,
      });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${rows[rows.length - 1].detail}`);
      return ok;
    },

    /**
     * Records a quantity with no sourced target.
     *
     * Printed, kept, and counted separately — never as a passing check. This
     * exists so that "we measured it but nobody publishes a reference value" has
     * an honest home, instead of being laundered into `check(name, true, …)` and
     * inflating a pass rate.
     */
    measure(name, value, unit = '', note = '') {
      finite(name, value, 'measure');
      const detail = `${fmt(value, unit ? ` ${unit}` : '')}${note ? `  (${note})` : ''}`;
      rows.push({ kind: 'measure', name, ok: null, detail });
      console.log(`MEAS  ${name}  — ${detail}`);
      return value;
    },

    /**
     * Asserts that a measurement happened at all.
     *
     * The guard in front of measure()/against() for anything derived from "find
     * the first sample where X" — that returns null when X never happened, and
     * null must fail loudly rather than arrive downstream as zero.
     */
    reached(name, value, detail) {
      const ok = typeof value === 'number' && Number.isFinite(value);
      return report.check(name, ok,
        detail ?? (ok ? `reached at ${fmt(value)}` : 'never reached in the window measured (0 samples qualified)'));
    },

    finish() {
      const checks = rows.filter((r) => r.kind === 'check');
      const measures = rows.filter((r) => r.kind === 'measure');
      const failed = checks.filter((r) => !r.ok).length;
      console.log(`\n${label}: ${checks.length - failed}/${checks.length} checks passed`
        + `${measures.length ? `, ${measures.length} measurements without a sourced target` : ''}`);
      return failed === 0;
    },
  };
  return report;
}

/* ------------------------------------------------------------ self-check -- */
//
// Proves the driver can fail. Every claim this harness makes rests on the
// assumption that a wrong game would show up in it, and that assumption has to
// be tested rather than assumed — last session an instrument returned silence
// because it was broken, and the silence was quoted as evidence.

if (process.argv[1] && process.argv[1].endsWith('_sim.mjs') && process.argv.includes('--selfcheck')) {
  const r = makeReporter('sim self-check');
  const sim = await openSim({ dist: process.argv.includes('--dist') });
  try {
    await sim.setup({});

    // 1. dt is honoured: free-fall must match the analytic solution.
    //
    // Measured between two samples inside the trace rather than from the state
    // written by setup(), because setup() takes a settling step of its own and
    // an extra tick of fall is 4 cm at these speeds — enough to fail a 1%
    // tolerance and send the reader looking for a physics bug that is really a
    // bookkeeping one in the test. The dt term is the semi-implicit Euler
    // overshoot, which is a property of the integrator, not an error.
    const G = 19.6, DT = 1 / 240;
    await sim.setup({ position: [-6, 40, 17] });
    const fall = await sim.drive({ seconds: 0.5, dt: DT, sample: 'return {}' });
    const a0 = fall[10], a1 = fall[fall.length - 1];
    const T = a1.t - a0.t;
    const dropped = a0.py - a1.py;
    const expected = -a0.vy * T + 0.5 * G * T * T + 0.5 * G * DT * T;
    r.check('fixed dt integrates gravity as specified', Math.abs(dropped - expected) < 0.01 * expected,
      `fell ${dropped.toFixed(4)} m in ${T.toFixed(4)} s from v=${a0.vy.toFixed(3)} m/s, `
      + `analytic ${expected.toFixed(4)} m`);

    // 2. The driver's own bookkeeping must be dt-agnostic: N ticks of dt must
    //    advance simulated time by exactly N*dt whatever dt is. This is about
    //    the harness, not the game — whether the *physics* is frame-rate
    //    independent is a property of the game and is asserted in
    //    gameplay-movement.mjs, where a failure is a bug to fix rather than a
    //    reason to distrust the instrument.
    await sim.setup({ position: [-6, 40, 17] });
    const before = await sim.snapshot();
    await sim.drive({ ticks: 300, dt: 1 / 60, sample: 'return {}' });
    const after = await sim.snapshot();
    const advanced = after.t - before.t;
    r.check('driver advances simulated time exactly', Math.abs(advanced - 5) < 1e-9,
      `300 ticks of 1/60 advanced elapsed by ${advanced.toFixed(9)} s`);

    // 3. Seeding is real: two fresh boots on one seed must agree exactly.
    await sim.setup({ position: [-6, null, 17] });
    const a = await sim.drive({ ticks: 60, dt: 1 / 120, input: 'return { fire: true }' });
    const sim2 = await openSim({ dist: process.argv.includes('--dist'), seed: sim.seed });
    await sim2.setup({ position: [-6, null, 17] });
    const b = await sim2.drive({ ticks: 60, dt: 1 / 120, input: 'return { fire: true }' });
    const same = a.every((row, i) => Math.abs(row.recoilPitch - b[i].recoilPitch) < 1e-12);
    r.check('one seed replays identically across boots', same,
      `${a.length} ticks, max recoil delta `
      + `${Math.max(...a.map((row, i) => Math.abs(row.recoilPitch - b[i].recoilPitch))).toExponential(2)}`);
    await sim2.close();

    // 4. The driver observes change. If firing 20 rounds does not move the
    //    aim point, the tap is dead and every recoil test would pass on a
    //    game with no recoil at all.
    r.check('driver observes recoil at all', Math.abs(a[a.length - 1].aimPitch - a[0].aimPitch) > 1e-4,
      `aim pitch moved ${(a[a.length - 1].aimPitch - a[0].aimPitch).toFixed(5)} rad over 0.5 s of fire`);

    // 5. A deliberately wrong expectation must fail. This is the check that
    //    makes the other four mean something.
    const wrong = r.against('a knowingly wrong target fails (expected FAIL)',
      dropped, dropped * 3, { pct: 0.05 }, ' m');
    r.check('the reporter rejects wrong values', !wrong,
      `a 3x-off target was ${wrong ? 'ACCEPTED — the reporter is broken' : 'correctly rejected'}`);

    r.check('no page errors during self-check', sim.errors.length === 0,
      sim.errors.length ? sim.errors[0] : 'clean');
  } finally {
    await sim.close();
  }
  // The intentional-failure row is expected to be red; success is every other
  // row green.
  const realFailures = r.rows.filter((x) => !x.ok && !x.name.includes('expected FAIL'));
  console.log(`\nsim self-check: ${realFailures.length === 0 ? 'DRIVER TRUSTWORTHY' : 'DRIVER SUSPECT'}`);
  process.exit(realFailures.length === 0 ? 0 : 1);
}
