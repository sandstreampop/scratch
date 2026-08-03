# Quality loop

Twenty measured iterations. Each loop: run the gate, pick the biggest real weakness,
fan out to fix it with independent adversarial review, verify by rendering and measuring,
then commit, push and redeploy.

Rule of the loop: **a number is not evidence unless something was also looked at.** The worst
bug in this project's history — a lightsaber that waved behind the character's head for an
entire swing — passed every contract review, because reviewers checked the spec and never
rendered a frame.

## The gate

```sh
node jedi/test/gate.js        # one scorecard for the whole game
node jedi/test/profile.js     # per-system CPU cost + draw calls
```

Headless runs use SwiftShader, which rasterizes on the CPU. Wall-clock frame time there is
fill-rate bound and says almost nothing about an iPhone GPU, so the gate reports it but never
fails on it. It fails on the two numbers that do transfer to a phone: **JavaScript cost per
frame** and **draw calls per frame**.

---

## Loop 1 — a yardstick, and finding out the old one lied

**Scorecard: 8/8 green.** Baseline established.

| Check | Result |
|---|---|
| boot / no console errors | clean, 5 bots alive |
| touch controls | 18.3 m travelled, sprint reached |
| 12 attacks / saber menu | 12/12 unique, dual + staff |
| camera auto-follow | aligns 10° in 1.12 s, heading drift 0 |
| 12 saber swing arcs | 12/12 pass |
| no runtime errors in combat | clean over 12 s |
| JS cost per frame | **1.32 ms** |
| draw calls per frame | **162** |

**What this loop actually learned.** The first version of the gate failed the game on
performance: mean 29.9 ms, p95 50 ms, worst 83 ms. That looked alarming and was nearly acted
on. Profiling per system first showed the whole of the game's JavaScript — every bot, every
particle, terrain, rig, audio — costs **0.99 ms per frame**. The frame time was software
rasterization, an artefact of the test environment, not a property of the game.

Optimising against that number would have been wasted effort aimed at a phantom. So the gate
now measures JS time and draw calls instead. The real number worth watching is **162 draw
calls per frame**, which is respectable but is the thing most likely to cost frames on an
actual iPhone, and is the standing candidate for a future loop.

Added `test/gate.js` (whole-game scorecard) and `test/profile.js` (per-system attribution).

---

## Loop 2 — the reviewer earns its keep

**Scorecard: 8/8 green.** 1.28 ms JS, 163 draw calls, camera drift 0°, 12/12 swings.

The 12 attacks became purpose-authored arcs (authored in *tip space* — where the blade tip
should travel — and converted to axis/angles at load, because authoring in blade-angle space
made half the arcs land ~20° short). Damage windows were re-aligned so nothing is lethal during
its own wind-up.

Then its adversarial reviewer found **five defects that every metric had already passed**:

- In 6 of 12 attacks the **wind-up was the fastest motion on screen** — the blade snapped into
  its coil faster than it cut, so the attacks read *backwards*. (SNAP CUT LEFT: 30.7 m/s
  wind-up vs 21.9 m/s strike.)
- **Stance character did not exist at the blade**: peak tip speed measured LIGHT 23.0,
  MEDIUM 23.9, STRONG 20.6 m/s — LIGHT was *slower* than MEDIUM.
- STRONG was MEDIUM slowed down rather than bigger; AVALANCHE was frame-for-frame identical to
  FALLING STAR.
- VIPER LUNGE did not read as a thrust and was gaming the probe.
- RISING TALON's dominant motion was a downward whip, not a rise.

This is the loop's rule paying for itself: the numbers were green and the animation was wrong.
Only rendering and *watching* found it.

Three reviews lost to a session limit were also recovered, and found real bugs: a sith
force-push landing **from 60 m through terrain, off-screen**; a stormtrooper's rifle hovering
level in mid-air over a corpse lying flat; a blaster parry whose outcome depended on where the
substep grid happened to fall (frame-rate dependent parries); damage applied to the first
entity in list order rather than the nearest; and Force Speed's after-images erasing the
character when standing still.

A full playtest graded it **B+ / 7.5** — "fun, playable on an iPhone right now, engineered
well; what holds it back is art legibility, not code" — and fixed a box shadow that read as a
hole cut in the sand, a dead-flat sky (now a one-draw-call gradient dome), a **colour picker
whose blue slider was physically unreachable on an iPhone in landscape**, and a GL
redundant-state cache that cut 2053 raw WebGL calls per frame.

---

## Loop 3 — art legibility, and one draw call per particle

**Scorecard: 8/8.** 1.22 ms JS, **draw calls 163 → 131** (worst frame was 348).

Acting on the playtester's ranked list rather than guessing:

- **The sith was a hole in the screen.** 85% of its pixels sat between RGB 11 and 29. The cause
  was the light, not the palette: with this sun and ambient, a face gets base×0.37 (shadow) or
  base×1.02 (lit), so a base of 0.11 *cannot* produce more than RGB 32. It now has a deliberate
  five-value ramp — hood 12, legs 21–35, robe 39–75, crimson sash, pale skin 153.
- **The stormtrooper was the same hue family as the dune** (Michelson contrast 0.025). The
  fraction of the figure carrying a ≥30-luma step against sand went 0.47 → 0.94 at 5 m.
  The agent's first attempt rendered as *a shirtless man in black trousers* — caught only by
  looking at it. Blue can never exceed 0.826× base while red reaches 1.13×, so neutral white
  armour needs pre-compensated blue.
- **Fire rate 1.00 → 1.99 bolts/s** while engaged, in real bursts of 3. Two causes: `BURST_GAP`
  was measured from the last shot rather than as a period, and REPOSITION was completely silent
  for half of every cycle.
- **Draw calls**: added a batched dynamic-geometry path to the core renderer. Particles were one
  draw call *each* — a spark burst added 150+. Proven bit-identical: 0 of 329160 pixels differ.
  Its reviewer found the batch had no overrun guard: one index past the end raised
  `GL_INVALID_OPERATION` and the whole batch silently rendered nothing.
- **Rig: three criticals.** The documented clearance fix was mis-measured by 0.20 m and had moved
  the collision to a different body part; the weapon *teleported* at a discontinuous clamp
  boundary; and the clearance test had never examined the hilt's pommel half.
- Deflection and Grip now read (0.08% → 0.40–0.88% and 0.9% → 0.73–2.12% of screen pixels).

## Loop 4 — closing the blind spot that hid loop 3's leftovers

**No feature work. Tooling only**, because two defects had escaped twice.

`swing_probe` only ever tested the **default single saber**. That is how *8 of 12 staff attacks*
stayed broken through a whole iteration with a green gate. It now takes a saber-type argument and
the gate runs all **36** combinations.

And "wind-up faster than the strike" had now been caught twice by human-style review and *never*
by a metric — so it became one: `strikeOverWindup >= 1.05`.

That second metric needed care, and my first version was wrong in the same way the old
performance check was wrong. Measured per *second* it was noise: headless frame times jitter from
6 ms to 60 ms, and the same swing reported peak speeds of both 73.9 and 25.3 m/s on consecutive
runs — it would have failed a correct animation. Measured per unit of swing **phase** the jitter
divides out, because each attack has a fixed duration. The same swing now reads 1.25 and 1.36
across runs.

The extended gate immediately paid for itself: it confirms loop 2's fix genuinely held for single
sabers, and independently reproduces the staff defect.

    single 12/12    dual 12/12    staff 4/12
