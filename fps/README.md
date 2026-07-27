# DUST VIPER

A first-person shooter built in Three.js. Everything — every texture, every
model, every sound — is generated procedurally at load time. No external
assets.

## Running

    npx serve .        # or any static file server
    open http://localhost:3000

`index.html` uses an import map pointing at `vendor/three/`, so it needs to be
served over HTTP rather than opened from the filesystem.

## Controls

| Input | Action |
| --- | --- |
| `WASD` | Move |
| `Shift` | Sprint |
| `C` / `Ctrl` | Crouch |
| `Space` | Jump |
| Mouse | Look |
| LMB | Fire |
| RMB | Aim down sights |
| `R` | Reload |

## Layout

    src/textures.js   procedural PBR material authoring (albedo/normal/ORM)
    src/sky.js        Preetham atmosphere, sun, image-based lighting
    src/post.js       GTAO, volumetric shafts, bloom, grade, SMAA
    src/level.js      the outpost: geometry, colliders, cover, spawns
    src/player.js     movement, collision, camera springs
    src/weapon.js     viewmodel, pose blending, recoil, reload
    src/ai.js         soldier model, animation, behaviour, director
    src/vfx.js        particles, tracers, casings, decals, atmospherics
    src/hud.js        HUD driver and compass
    src/audio.js      procedural weapon and world audio
    src/main.js       bootstrap and game loop

## Screenshots

    node tools/shot.mjs            # renders every preset into shots/
    node tools/shot.mjs hero       # a single preset

Presets drive the camera to a fixed pose, place enemies deterministically and
warm the simulation up so captures are reproducible frame to frame.
