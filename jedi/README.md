# DUNE RAIDER

A third-person lightsaber game in the spirit of *Jedi Knight II: Jedi Outcast*, built to run
in iOS Safari. One self-contained HTML file, no dependencies, no network, no images — every
polygon, sound and animation is generated procedurally at load.

**Play:** open `index.html` on a phone, or serve the folder and visit it.

## Controls

**Touch (iPhone)**

| Control | Action |
|---|---|
| Left thumb, anywhere on the left of the screen | Move. Push to the edge to sprint. |
| Right side drag | Look. The camera also follows you on its own. |
| `ATK` | Swing the saber — the direction you push the stick picks the attack |
| `JUMP` | Jump |
| `FORCE` | Use the selected Force power (hold for channelled ones) |
| `STANCE` | Cycle Light / Medium / Strong stance |
| `SABER` | Saber type, colour presets and an RGB picker |

**Desktop:** WASD to move, Shift to sprint, Space to jump, drag to look, left click to attack,
E for Force, Q for stance, R or the mouse wheel to change Force power.

## Combat

Three stances, each with four attacks selected by the direction you are pushing when you
strike — twelve distinct swings in total.

| Stance | Feel | Attacks (neutral / forward / left / right) |
|---|---|---|
| Light | Fast, tight, chains quickly | Flurry Cross · Viper Lunge · Snap Cut Left · Snap Cut Right |
| Medium | The classic readable arcs | Horizon Arc · Skyfall Chop · Rising Talon · Falling Star |
| Strong | Slow, heavy, huge | Dune Cyclone · Meteor Smash · Sandstorm Sweep · Avalanche |

Three saber types — single, dual and staff — each with a full RGB colour picker that persists
between sessions.

## The world

An open desert of rolling dunes with rock outcrops, distant mesas and half-buried crashed
star cruisers. The terrain is analytic and seeded, so the map is identical every load, and the
visible ground is sampled from exactly the same function used for collision.

## Building

The game is written as separate modules in `src/`, concatenated into a single HTML file:

```sh
node build.js                      # -> index.html (and artifact.html)
node test/preview.js /tmp/x.html   # a throwaway build, for testing
```

`src/` files are loaded in filename order and each owns one namespace under the `JK` global.
`CONVENTIONS.md` documents the module contracts.

## Tests

Headless Chromium harnesses in `test/`. They assert behaviour rather than pixels, and several
of them write filmstrip PNGs meant to be looked at.

```sh
node test/smoke.js       out/   # boots, renders, no console errors
node test/interact.js    out/   # touch controls: run, jump, attack, stance
node test/combat_ui.js   out/   # 12 attacks, droid damage, saber menu, RGB picker
node test/swing_probe.js out/ 1 0   # saber arc quality + filmstrip
node test/camera_probe.js out/      # camera auto-follow behaviour
```

`swing_probe.js` and `camera_probe.js` are quality gates with pass/fail thresholds — a swing
has to actually sweep in front of the body, and the camera has to settle behind your direction
of travel without dragging your heading into a circle.
