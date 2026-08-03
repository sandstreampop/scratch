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
