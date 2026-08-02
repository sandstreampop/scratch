# DUNE RAIDER (working title) — module conventions

A Jedi-Knight-Outcast-style third-person saber game. One global namespace `JK`.
All modules are plain ES5-ish scripts (no imports/exports, no modules, no async/await
needed) concatenated in filename order into a single index.html by build.js.
Target: iOS Safari (WebGL1 only, touch first) + desktop keyboard/mouse fallback.

## Hard rules
- WebGL1 ONLY. No extensions may be required (OES_element_index_uint optional w/ fallback).
- No external network requests, no CDN, no fonts, no images. Everything procedural.
- No `let`/`const` at top-level that collide: wrap every module in an IIFE and only
  export via `JK.<Name> = {...}`.
- Never touch modules you don't own. Each file has ONE owner.
- 2000s id-tech look: low-poly, vertex-lit, fog, muted palette, chunky HUD.
- All angles radians. Y is up. Units: meters. Coordinate system right-handed, -Z forward.
- 60fps budget on an iPhone: keep per-frame allocations near zero (reuse scratch arrays).

## Namespace map (owner in brackets)
- `JK.M`    (00_math.js)   [core] mat4/vec3 helpers, scratch-friendly.
- `JK.GL`   (05_gl.js)     [core] context, standard shader, mesh create/draw, camera.
- `JK.Geo`  (05_gl.js)     [core] CPU geometry builders: box, merge, transform.
- `JK.Terrain` (10_terrain.js) [terrain agent] heightfield desert + rocks + sky.
- `JK.Input`   (20_input.js)   [input agent] touch sticks/buttons + keyboard/mouse.
- `JK.Player`  (30_player.js)  [player agent] movement physics + 3rd person camera.
- `JK.Rig`     (40_character.js) [character agent] humanoid rig, animation, saber blade.
- `JK.main`    (90_main.js) [core] boot + game loop.

## Module lifecycle
Each gameplay module exposes:
```js
JK.Foo = {
  init: function(){},          // called once after GL ready, in file order
  update: function(dt, t){},   // dt seconds (clamped <= 0.05), t seconds since boot
  draw: function(){},          // issue JK.GL draw calls
};
```
90_main.js calls init/update/draw on: Terrain, Input, Player, Rig (in that order for
update; draw order Terrain, Rig). Missing methods are skipped.

## JK.GL API (already implemented — do not modify)
- `JK.GL.init(canvas)` -> bool
- `JK.GL.beginFrame(r,g,b)` clears + sets viewport
- `JK.GL.setCamera(eye, target, fovYdeg)` builds proj+view, stores `JK.GL.eye`
- `JK.GL.mesh(geo)` -> mesh handle. geo = {pos:Float32Array, nrm:Float32Array,
   col:Float32Array (rgb per vertex), idx:Uint16Array}
- `JK.GL.draw(mesh, model /*mat4 or null*/, opts /*{emissive:0..1, tint:[r,g,b] or null, additive:bool}*/)`
- `JK.GL.fog(color3, density)` — exp2 fog
- `JK.GL.sun(dir3, color3, ambient3)` — one directional light, gouraud
- Standard shader does: gouraud diffuse + ambient, vertex color * tint, exp2 fog,
  emissive lerps toward pure vertex color (for saber glow).

## JK.Geo API (already implemented)
- `JK.Geo.box(sx,sy,sz, r,g,b)` -> geo centered at origin
- `JK.Geo.tf(geo, mat4)` -> transformed copy
- `JK.Geo.merge([geo,geo,...])` -> single geo (16-bit index safe check included)

## Cross-module contracts (keep stable!)
- `JK.Terrain.height(x,z)` -> ground height (world y) at any x,z. MUST be defined,
  fast, and continuous. Also `JK.Terrain.SIZE` (playable half-extent, meters).
- `JK.Input.state` -> read-only-by-convention object:
  `{ moveX, moveY /* -1..1 stick */, lookDX, lookDY /* pixels this frame */,
     jump, attack, force, run /* booleans (pressed this frame or held, see comments) */,
     stance, forceSel /* ints, cycle taps */ }`
- `JK.Player.pos` [x,y,z] (feet), `JK.Player.yaw`, `JK.Player.vel`,
  `JK.Player.onGround`, `JK.Player.speed2D` (m/s), `JK.Player.anim` (string hint:
  'idle'|'run'|'sprint'|'jump'|'fall'), `JK.Player.camEye`/`camTarget` (vec3s).
- `JK.Rig.draw()` renders the player character at JK.Player.pos/yaw using
  JK.Player.anim + JK.Player.speed2D for animation phase.

## HUD / DOM
template.html owns the DOM: canvas#gl, #hud, #stickL zone (left half = move stick),
right half = look drag, buttons #btnJump #btnAtk #btnForce #btnStance. Input module
wires them. Desktop: WASD run, SPACE jump, mouse look w/ pointer lock on click,
LMB attack, E force. CSS is in template.html — input agent may add classes there ONLY
in the marked INPUT-CSS block.

## ITERATION 2 CONTRACTS (saber combat) — FROZEN, build against these exactly

New systems in 90_main.js order (already wired): Sabers (50_sabers.js), then later
Powers/Bots/Fx/Hud. Rig updates BEFORE Sabers each frame; all draws happen after all updates.

### JK.Rig instance extensions (owner: character agent, 40_character.js)
- `rig.setType(type)` — 'single' | 'dual' | 'staff'.
  single: right hand. dual: second hilt+blade mirrored in LEFT hand. staff: one hilt in right
  hand with blades BOTH directions. Shared meshes; per-instance type.
- `rig.blades` — array of `{base:[x,y,z], tip:[x,y,z]}` world-space, refreshed EVERY draw
  (1 entry single, 2 dual, 2 staff). `rig.tipPos/basePos` stay aliases of blades[0].
- `rig.playSwing(def)` — def:
  `{ dur /*s*/, keys:[{t /*0..1*/, sp,sy,sr /*shoulder pitch/yaw/roll rad*/, el /*elbow*/,
     wr /*wrist*/, ty,tp /*torso yaw/pitch*/, lunge /*m forward*/}...], mirror /*bool: also
     drive left arm mirrored (dual)*/ }`
  Interpolates smoothly (smoothstep between keys), overrides procedural arm/torso anim while
  active, returns to normal blending after. Returns true if accepted. Accepts a new swing when
  none active or current one >= 60% done (combo chaining).
- `rig.swingPhase()` -> 0..1 while swinging else -1.
- Rig's OLD auto-consume of JK.Player.attackQueued and startSwing() fallback: keep startSwing()
  but ONLY auto-consume attackQueued when `!JK.Sabers` (Sabers owns attacks now).

### JK.Sabers (owner: sabers agent, NEW file 50_sabers.js)
- Stances: 0=LIGHT (fast/weak), 1=MEDIUM, 2=STRONG (slow/heavy). Current = JK.Player.stanceIdx.
- 4 attacks per stance, selected AT PRESS by stick direction: neutral / forward / left / right
  (12 distinct swing defs total, different arcs & timings per stance).
- Consumes JK.Player.attackQueued in update(); calls JK.Rig's player-instance playSwing.
- `JK.Sabers.active()` -> true during damage-active frames (e.g. phase 0.25..0.75).
- `JK.Sabers.sweep` -> during active frames: `{pb,pt,cb,ct /*prev/cur base+tip vec3*/, dmg,
   knock /*m/s knockback*/, name}` else null. Uses JK.Rig.blades[…] positions captured each
   frame (all blades of dual/staff contribute — array `JK.Sabers.sweeps` list, `sweep` = [0]).
- `JK.Sabers.stanceName(i)`, `JK.Sabers.STANCES` table exposed for HUD.
- Updates #stanceTag on stance change (takes over from Player's basic text set — keep Player's
  code, last-writer-wins is fine since both write same frame).

### JK.Combat (owner: combat agent, NEW file 55_combat.js) — includes JK.Fx
- Entity registry: `JK.Combat.register(ent)` / `unregister(ent)`.
  ent contract: `{ pos:[x,y,z] /*feet*/, radius, height, hp, team /*'player'|'enemy'|'neutral'*/,
  onHit(dmg, dir3, kind) }`. Combat.update does segment-swept-vs-capsule tests of every active
  saber sweep (player's, later bots') against entities of OTHER teams; calls onHit once per
  entity per swing (not per frame — track swing ids).
- `JK.Combat.swingId` increments per new player swing (read JK.Sabers state).
- JK.Fx (same file, exported as JK.Fx): tiny particle pool (<=256, preallocated): sparks
  (impact), respawn shimmer. `JK.Fx.sparks(pos, n, color)`. Drawn additive, zero alloc/frame.
- 3 training droids on posts near spawn (~10-14 m out, distinct bearings), hp 60, they wobble,
  spark when hit, explode into boxes-parts fx at 0 hp, respawn after 3 s. Register as team
  'enemy'. Droids must NOT block movement (no obstacles entries).
- Damage numbers: floating "-12" style DOM-less — reuse #msg? NO: draw small emissive boxes is
  ugly; instead JK.Combat exposes `JK.Combat.lastHit = {dmg, t}` and Ui shows it. Keep simple.

### JK.Ui (owner: ui agent, NEW file 60_ui.js)
- Creates ALL its DOM + a <style> element at init() via JS (no template.html edits!).
- SABER menu: a small "SABER" tbtn-styled button top-left under stance tag opens a 2002-style
  panel (chunky borders, Trebuchet, tan/olive like the HUD): saber TYPE row (SINGLE/DUAL/STAFF),
  6 color presets (blue #2f7cf0, green #33e05a, red #f03428, purple #a04af0, yellow #f0d028,
  orange #f08a28) + three R/G/B sliders (0-255) with live preview swatch. Applies instantly:
  `JK.Rig.setType(t)`; `JK.Rig.setSaber([r,g,b] 0..1)`. Persists to localStorage
  ('jk_saber_type', 'jk_saber_rgb'), re-applies on boot. Game PAUSES while panel open?? NO —
  keep running (retro arcade), but panel blocks its own touches from reaching game controls
  (stopPropagation + it sits above #stickL).
- Shows attack name flashes (JK.Sabers last attack name) + damage feedback via
  JK.Combat.lastHit in a small line under #stanceTag. Updates #hpFill/#fpFill widths from
  JK.game.hp/force each frame (cheap: only when changed).
- Update #forceTag placeholder text "" for now (Powers iteration owns it).

## ITERATION 3+4 CONTRACTS (force powers, audio, blasters, bots) — FROZEN

90_main.js SYSTEMS order is now:
`['Terrain','Input','Player','Rig','Sabers','Powers','Bots','Blaster','Hero','Fx','ForceFx','Audio','Hud']`
(init/update/draw all run in this order; missing methods skipped.)

### Already provided by core (do NOT edit these files)
- `JK.Player.speedMul` (default 1) multiplies walk/sprint speed — Force Speed sets it.
- `JK.Player.jumped` true only on the frame the player jumped off the ground.
- `JK.Player.impulse(vx,vy,vz)` adds world velocity; upward impulse unsticks from ground.
- `JK.Input.state.forceHeld` — TRUE while #btnForce is touched or E is held (channelling).
  `state.force` remains the press EDGE; `state.forceTap` is the select-cycle edge (R/wheel).
- `JK.Hero` (58_playerent.js): registers the player as a JK.Combat entity, team 'player',
  `pos` aliases JK.Player.pos, radius 0.55, height 1.8, kind 'hero'. Bots damage the player by
  calling `ent.onHit(dmg, dir3, kind)` through JK.Combat, or directly via
  `JK.Hero.hurt(dmg, dx, dy, dz, kind)` where kind is 'bolt' | 'saber' | 'force'.
  `JK.Hero.dead` / `JK.Hero.invuln` (seconds) — bots must not shoot a dead/invulnerable hero.
- `JK.game` = {hp, hpMax, force, forceMax, kills}. Powers owns force/forceMax; Hero owns hp.

### Entity force contract (implemented by JK.Bots, consumed by JK.Powers)
Optional on any JK.Combat entity — ALWAYS feature-detect before calling:
```
ent.onForce(kind, dir3, power)
  kind: 'push' | 'pull' | 'grip' | 'gripHold' | 'gripRelease' | 'lightning'
  dir3: unit world direction FROM the caster TO the entity ([x,y,z], reused — copy if kept)
  power: scalar strength (push/pull ~ m/s of impulse; lightning/grip ~ damage this call)
```
Entities without onForce are simply skipped by heavy powers (droids just take lightning damage
through onHit). Bots must implement stagger/knockdown/lift states for these.

### JK.Audio (65_audio.js) [audio agent]
- WebAudio, entirely procedural (oscillators + noise buffers), created in init() — init runs
  inside the ENTER-THE-DUNES tap so iOS unlocks the context. Never throw if unavailable.
- `JK.Audio.play(name, opt)` opt = {pos:[x,y,z], vol, rate}. Positional = distance
  attenuation + stereo pan vs JK.GL.eye and the camera's facing (JK.Player.camYaw).
- Names other modules WILL call (implement every one, no-op safe):
  'saberOn','saberOff','swing','clash','hit','blaster','boltHit','deflect','jump','land',
  'hurt','die','botDie','push','pull','lightning','grip','speed','forceFail','select'.
- Saber hum: continuous low drone while a saber is lit, pitch/volume modulated by the player's
  swing phase + speed. `JK.Audio.hum(on, intensity)`.
- Master mute button: create your OWN small DOM button (top-right, below the safe area, sized
  like .tbtn, ~44px) labelled SND/MUTE. Persist to localStorage 'jk_mute' in try/catch.
- Budget: never allocate nodes per frame beyond one-shot voices; cap simultaneous voices (~16).

### JK.Powers (70_powers.js) [powers agent]
Force pool on JK.game: force/forceMax = 100, regen 14/s starting 0.8 s after the last spend.
FIVE powers, cycled by `state.forceTap` and by tapping the module's own selector UI; cast with
`state.force` (edge) / `state.forceHeld` (channel):
  0 PUSH      cost 25, instant. Cone: 10 m range, 75 deg half-angle around player facing.
              onForce('push', dir, 9) on entities; also `JK.Blaster.repel(pos, dir)` to blow
              incoming bolts away; knock droids via onHit(10,...).
  1 PULL      cost 20, instant. Same cone, onForce('pull', dir, 7) — yanks bots in and
              staggers them; also disarms troopers (bots decide) .
  2 SPEED     channelled, 10/s. JK.Player.speedMul = 1.75 while active + ForceFx.speed(true).
              Auto-ends at 0 force or on release.
  3 LIGHTNING channelled, 26/s. Targets up to 3 entities within 14 m inside a 45 deg cone;
              onForce('lightning', dir, 55*dt) or onHit(55*dt) fallback; ForceFx.lightning(...).
  4 GRIP      channelled, 20/s. Locks the NEAREST entity within 12 m in front that has onForce;
              onForce('grip', dir, 0) once, then onForce('gripHold', dir, 14*dt) each frame
              (bots lift + choke); on release onForce('gripRelease', dir, 12) throws them
              along the camera direction. ForceFx.grip(entity).
- Selector UI: your OWN DOM (no template.html edits, do not touch 60_ui.js). A vertical strip
  of 5 chunky 2000s-style slots on the RIGHT edge, above #btnForce (which sits at bottom
  right: right 20px, bottom 210px + safe area, 56px). Keep the strip clear of #btnJump
  (right 16, bottom 120) and #btnAtk (right 96, bottom 48). Highlight the selected slot; tap
  a slot to select. Also mirror the name + cost into #forceTag (id exists in template).
- Cooldowns: PUSH/PULL 0.55 s. Fail (not enough force) => JK.Audio.play('forceFail') + flash.
- Zero per-frame allocations; DOM writes only on change.

### JK.ForceFx (75_forcefx.js) [forcefx agent]
Pure visuals, driven by JK.Powers. NO gameplay logic, NO input reads.
- `JK.ForceFx.push(origin3, dir3)` expanding translucent shockwave ring (additive), 0.45 s.
- `JK.ForceFx.pull(origin3, dir3)` converging streaks, 0.45 s.
- `JK.ForceFx.lightning(from3, to3)` — call EVERY frame while channelling; render a jagged
  arc as a chain of ~10 short emissive boxes with per-frame model matrices (JK.GL.mesh is
  STATIC_DRAW only — do NOT rebuild geometry per frame; reuse ONE unit-segment mesh and place
  each link with a matrix built from a scratch pool). Deterministic jitter from a seeded PRNG
  advanced per frame is fine; must look alive but never allocate.
- `JK.ForceFx.grip(pos3, t)` swirling aura rings around a lifted target.
- `JK.ForceFx.speed(on)` — motion streaks trailing the player + a CSS vignette overlay div you
  create yourself (blue-white, pointer-events none, z-index below the touch buttons).
- All effects pooled and preallocated; update(dt,t) ages them; draw() renders additive last.

### JK.Blaster (78_blaster.js) [blaster agent]
- Pool of <=160 bolts, preallocated: {pos,vel,life,team,dmg,color,active}.
- `JK.Blaster.fire(origin3, dir3, team, opts)` opts = {speed=58, dmg=9, color, spread}.
  team 'enemy' (imperial red #ff3020) or 'player' (deflected, green #40ff60).
- Visual: elongated emissive core box + additive glow, oriented along velocity, ~0.9 m long.
- Per step: substep the segment (bolt travels ~1 m/frame at 58 m/s — still substep 2x) and test
  against JK.Combat.ents of OTHER teams (segment vs vertical capsule, same style as
  55_combat.js) => ent.onHit(dmg, dir3, 'bolt'); also test JK.Terrain.height for ground
  impacts. Impact => JK.Fx.sparks + JK.Audio.play('boltHit', {pos}).
- SABER DEFLECTION (the fun part): while the player's saber is lit, test each enemy bolt
  against the player's blade segments (JK.Rig.blades — refreshed every draw, world space).
  Within ~0.35 m of a blade segment => deflect: flip the bolt to team 'player', recolor green,
  and aim it at the nearest enemy entity (within 40 m) with a small random spread, else mirror
  it about the blade. JK.Audio.play('deflect'). Deflected bolts damage bots (dmg 14).
  Deflection must NOT trigger while JK.Hero.dead.
- `JK.Blaster.repel(pos3, dir3)` — Force Push blows every enemy bolt within 9 m in the cone
  back along dir (team flips to 'player').
- Zero per-frame allocations.

### JK.Bots (80_bots.js) [bots agent]
- `JK.Bots.list` array of bot objects (exposed for tests/HUD). `JK.Bots.count()`.
- TWO archetypes with FUN, readable, scripted AI (state machines, not physics sims):
  * STORMTROOPER — white/grey rig palette, saber off, carries a rifle you draw yourself
    (a couple of boxes) positioned from the rig's hand: `rig.blades[0].base` is the hand
    (blade base) and `tip-base` is the hand's up axis, so you can build a hand frame from
    those two points + the bot's yaw. hp 40, radius 0.5, height 1.8.
    States: IDLE -> SPOT (shout, JK.msg-free) -> ADVANCE (to 14 m) -> FIRE (bursts of 3,
    0.13 s apart, 1.5 s between bursts, ~4 deg spread; must MISS often — this is 2002 fun,
    not a shooter sim) -> REPOSITION (strafe/side-step, occasional comedic stumble) ->
    FLEE (when hp < 30% or 2 squadmates died within 6 s: run away, fire wildly backwards).
    On PULL: disarmed for ~2.5 s (rifle drops, they panic-run). On PUSH: knocked flat 1.8 s.
  * SITH — dark robe palette, red saber (rig.setSaber + setType 'single' or 'staff' for the
    elite one). hp 120, radius 0.55, height 1.85.
    States: STALK (circle-strafe at 4-6 m, saber guard) -> CHARGE (close to 2.2 m) ->
    COMBO (chain 2-3 swings from JK.Sabers.DEFS-style defs via rig.playSwing; damage the hero
    with JK.Hero.hurt(dmg, dir, 'saber') when the blade sweep is inside 2.4 m and in front) ->
    LEAP (JK-style force jump toward the player every ~7 s, arc via their own gravity)
    -> RECOVER (back off, taunt). Occasionally they Force-Push the hero (JK.Hero.hurt small +
    JK.Player.impulse). They should feel like duelling, not swarming.
- Bots use their OWN simple physics: gravity, JK.Terrain.height ground follow, obstacle
  pushout vs JK.Terrain.obstacles, separation from each other (min 1.6 m).
- Register every bot with JK.Combat.register (team 'enemy') and implement onHit AND onForce
  per the contract above. Death: fall over (rig anim 'fall' + a tipping matrix is fine),
  JK.Fx.burst, JK.Audio.play('botDie'), unregister, respawn a fresh bot after 6-9 s at a
  spawn ring 40-70 m from the player (never within 25 m). JK.game.kills++ on player kills.
- Population: 3 stormtroopers + 2 sith alive at a time on boot; the wave scales up by 1 every
  8 kills to a cap of 9 bots. Keep the cost sane: bots update fully within 60 m of the player,
  cheap-update (position only, no rig anim) beyond.
- Draw: one JK.Rig.create per bot (shared meshes internally, so this is cheap).
