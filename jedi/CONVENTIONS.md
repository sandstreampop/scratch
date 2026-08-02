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
