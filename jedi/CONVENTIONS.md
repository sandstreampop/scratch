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
