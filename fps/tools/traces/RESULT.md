# Blind telemetry comparison — scored result and bug list

Three judges compared four blinded trace pairs. The answer key
(`fps/tools/.trace-key.json`) assigns:

| metric | clone (recorded) | reference (synthesised) |
| --- | --- | --- |
| recoil | **A** | B |
| velocity | **B** | A |
| ttk | **A** | B |
| ai | **B** | A |

Traces judged: `fps/tools/traces/{recoil,velocity,ttk,ai}-{A,B}.json`
(on disk only at `/home/user/scratch/.claude/worktrees/wf_b63886a8-a88-2/fps/tools/traces/`).
All three judges stated they read nothing outside that directory, and nothing in
their reasoning contradicts that.

---

## 1. Scorecard

| metric | correct IDs | confidence | verdict |
| --- | --- | --- | --- |
| **recoil** | 0/3 — all three said *cannot tell* | none / none / none | **PASS** |
| **velocity** | 3/3 | likely / likely / certain | **DEFECT** (5 items survive) |
| **ttk** | 3/3 identified the sides correctly, but 2/3 then scored the **clone as the better trace** and listed the *reference's* shortcomings as the defects | likely / likely / likely | **SPLIT** (2 items survive, both low-confidence) |
| **ai** | 3/3 | certain / likely / likely | **DEFECT** (4 items survive) |

No judge guessed wrong on any metric. So there is no "won by being indistinguishable
from noise" pass — recoil is a clean three-way *cannot tell*.

### recoil — pass

Nothing separated the pair. What all three measured as identical: fire cadence
bit-for-bit (the same 5,5,6-tick gap pattern in every magazine of both files —
400 gaps of 0.08333 s and 180 of 0.1 s, ~678 rpm); linear pitch climb with the
same slope (ADS 0.111 vs 0.115 °/round, hip 0.169 vs 0.173); the same ADS/hip
climb ratio (0.656 vs 0.665); the same recentring signature (the per-round
increment shrinks on the 0.1 s interval relative to the 0.0833 s one, in both);
the same uniform ±20% per-shot jitter (kurtosis 1.64–2.01 against 1.8 for
uniform); and the same zero-mean yaw random walk.

Round-30 totals, measured: clone 3.198° ADS / 4.880° hip; reference 3.323° /
5.005°. The clone runs 3.8% and 2.5% *below* the reference — inside the
magazine-to-magazine spread (sd 0.058–0.069° over 10 magazines) and consistent
with the residual `player.js` recoil spring nudging the read aim down on the tick
the round leaves.

All three judges chased the one asymmetric statistic — ADS lateral endpoint sd,
clone 0.256° vs reference 0.180° — and all three correctly dismissed it because
the ranking reverses in hipfire (0.275 vs 0.374). They were right to, and for a
better reason than they knew: see §3, "the lateral-sd trap".

### velocity — defect

Decided by sourced scalars plus two integrator artifacts. The judges agreed
on: the sprint plateau (6.825 vs 7.245 m/s), airborne momentum (clone bleeds
10.3%, reference holds exactly), the landing restore (clone dips *below* its own
airborne minimum then takes two ticks to recover), and the slide exit
(clone steps −0.586 m/s in two ticks, reference lands on the crouch speed on its
own). Judge 3 called it *certain*.

### ttk — split

All three correctly named B as the reference, all three on the same tell: B's
120 engagements have **zero** variance (ttk sd = 0.0000 in every one of the 12
cells) and its uncompensated column is byte-identical to its compensated one out
to 60 m before failing 10/10 at 80 m. The clone instead degrades gradually
(survivors 0, 0, 1, 4, 10, 10 at 10/25/45/60/80/120 m) with a bimodal 45 m cell.

Judges 2 and 3 then argued the clone's behaviour is the *correct* one and wrote
their defect lists against the reference. Judge 3: "the clone's
recoil-to-hitbox coupling is genuinely working and should not be 'fixed' toward
the reference's step function." Those two defect lists are discarded from the
bug list — they describe the reference. Only judge 1's clone-directed items
survive, and only the coherence one is defensible (§2, T1/T2).

The compensated column is a genuine, fully-sourced pass on both sides: 266.7 ms
/ 4 STK at 10 and 25 m, 366.7 ms / 5 STK from 45 m out, 10/10 kills at every
range, against sourced targets of 264 ± 25 ms and 352 ± 30 ms.

### ai — defect

Decided on one thing, unanimously and correctly: the clone's burst scheduler
goes dormant. Everything the two files share — 0.100 s intra-burst spacing, 1–5
round bursts, reaction-time means 0.290 vs 0.294 s, and the entire body of the
inter-burst gap distribution (min 0.433, p50 ~0.76, p90 ~1.09 s) — is shared
because the reference borrowed it from `ai.js CONFIG`. The difference is the tail.

---

## 2. Bug list

Ranked by player-visible severity × strength of the identification. Every item
below is attached to a **correct** identification of the clone and a named
numeric feature. Six defects the judges named are excluded; they are listed at
the end with the reason.

### 1. AI stops shooting for up to 9.4 s with line of sight open
- **Quantity:** longest inter-burst gap, line of sight open and verified.
- **Clone:** 9.367 s. Also 8.967, 4.667, 3.333, 1.917 — 5 of 98 gaps over 1.15 s.
- **Expected:** ≤ 1.15 s. The clone's own `CONFIG.fireInterval` is `[0.42, 1.15]`;
  the reference's 156 gaps max out at exactly 1.150 s.
- **Direction:** 8.1× too long. The enemy is idle for up to 67% of a 14 s engagement.
- **Judges:** all three (judge 1 *certain*, and this was his single
  highest-value fix; judge 3 called it 8× the bound).
- **Fix:** `fps/src/ai.js` — `STATE.REPOSITION`. The trigger is
  `stateTimer > 3.2 + Math.random() * 3 && Math.random() < CONFIG.repositionChance`
  (0.55) inside `STATE.ENGAGE`, and the `REPOSITION` case contains no firing path
  at all, with a 6 s timeout and no bound on re-entry — so two chained
  repositions produce the 9 s silences. Either fire while repositioning, or cap
  the non-firing window at the `fireInterval` ceiling.

### 2. AI volume of fire and lethality collapse at mid range
- **Quantity:** rounds delivered and kills in the 14 s window, by range.
- **Clone:** 28 m — 96 rounds over 6 engagements (16.0 each), 1/6 kills. Overall
  14/24 kills, 427 rounds.
- **Expected:** 28 m — 167 rounds (27.8 each), 5/6 kills; overall 22/24, 595 rounds.
- **Direction:** ~1/3 less pressure; at 28 m the enemy kills a stationary,
  non-returning-fire player in 17% of engagements where it should be ~83%.
- **Judges:** all three.
- **Fix:** same site as #1. This is the dormancy measured from the ammunition and
  outcome side, not a second bug — do not tune `aimError*` to chase it.

### 3. Horizontal momentum is destroyed in the air
- **Quantity:** horizontal speed across the airborne phase of a sprinting jump.
- **Clone:** 6.825 → 6.1253 m/s over 37 air ticks (0.617 s): −10.3%, ~1.14 m/s².
- **Expected:** zero loss. The reference holds 7.245 m/s on all 36 air ticks;
  the sourced `movement.air_control` key is explicit that lateral authority is
  well under 10% of ground and that no CoD `sv_airaccelerate` figure exists to
  borrow.
- **Direction:** drag applied where there should be none.
- **Judges:** all three.
- **Fix:** `fps/src/player.js` — `TUNING.airDrag: 0.18` (line 67), applied as
  `const d = 1 - TUNING.airDrag * dt` in the airborne branch of `update()`
  (~line 541). Set to 0; `airAccel: 1.0` already supplies the small steering
  nudge the key sanctions.

### 4. Landing stutter, non-monotone through the contact tick
- **Quantity:** speed on and after the landing tick.
- **Clone:** 6.1253 (last air tick) → **6.1069** → 6.690 → 6.825 m/s across
  t = 1.617–1.667 s. The contact tick reads *lower than the airborne minimum*,
  then +0.583 m/s in one tick (~35 m/s²) to recover.
- **Expected:** 6.825 m/s on the landing tick, no trough and no step.
- **Direction:** too slow and non-monotone — a 33 ms hitch on every landing.
- **Judges:** all three (judge 3 correctly diagnosed the ordering).
- **Fix:** `fps/src/player.js` `update()`, the `if (this.onGround)` acceleration
  block (~lines 509–531): friction runs before the accelerate on the tick
  contact is regained, so the tick that lands is charged ground friction on a
  speed the air phase had already reduced. Fixing #3 removes the 0.72 m/s deficit;
  the one-tick trough is the ordering and needs the friction-before-input pass
  skipped on the contact tick.

### 5. Slide ends with a hard brake instead of arriving at crouch speed
- **Quantity:** speed through the end of a slide.
- **Clone:** decays to 2.9364 m/s at the 0.65 s cap, then 2.4614, then 2.35 —
  −0.586 m/s in two ticks, ~−35 m/s².
- **Expected:** a continuous arrival. The reference decays to 2.3597 and settles
  at 2.400 (+0.04 m/s). The sourced envelope — `slide_max_speed_scale` 1.55 and
  `slide_max_duration` 0.65 s — determines the decay rate:
  ln(7.05 / 2.35) / 0.65 = **1.690 /s**.
- **Direction:** decay 23% too slow, so the slide is still 0.59 m/s above the
  crouch cap when the duration cap fires and is then clipped. At t = 1.500 s the
  clone is at 4.755 m/s (69.7% of sprint) where the reference is at 4.394 (60.6%).
- **Judges:** all three.
- **Fix:** `fps/src/player.js` — `TUNING.slideFriction: 1.3` (line 101). Its own
  comment picks 1.3 *so that* the boost is still above crouch speed when the cap
  ends the slide; that is what produces the jolt. 1.690 makes the duration cap and
  the decay agree, which is what the two sourced keys jointly assert.

### 6. Crouch / slide-floor speed is off a directly sourced key
- **Quantity:** crouch speed.
- **Clone:** 2.35 m/s. **Expected:** 2.400 m/s (`movement.crouch_speed_mw3`).
- **Direction:** 2.1% too slow.
- **Judges:** all three.
- **Fix:** `fps/src/player.js` — `TUNING.crouchSpeed` (line 47). Unlike the sprint
  figure below, this key is published directly and the clone's value contradicts it.

### 7. Sprint top speed — disputed, not clearly a bug
- **Quantity:** sprint plateau.
- **Clone:** 6.825 m/s (= walkSpeed 4.55 × 1.5).
- **Reference:** 7.245 m/s (= `movement.base_walk_speed_legacy_iw` 4.83 ×
  `movement.sprint_speed_scale` 1.5 = 190 u/s × 1.5 at 0.0254 m/u).
- **Direction:** 5.8% slow *against the key the reference chose*. Reached at the
  same t = 0.1333 s in both, so it is the cap, not the acceleration.
- **Judges:** all three; judge 3 rested his *certain* verdict partly on it.
- **Fix:** `fps/src/player.js` — `TUNING.walkSpeed` (line 39). **But** the clone's
  comment defends 4.55/6.825 from a different published figure (the BP50 AR-class
  tactical sprint at 6.8 m/s) rather than the legacy IW base speed. This is a
  source-selection disagreement between the clone and the generator, and the
  generator does not get to win it by being the reference. Resolve it in
  `targets.mjs` first; do not change the constant just to close this row.

### 8. AI opening burst almost never lands
- **Quantity:** median time from the enemy's first shot to his first hit.
- **Clone:** 0.350 s after first shot (0.700 s from first sight). In 8 of 24
  engagements the first round to land arrives 1.0–3.8 s after the enemy opens
  fire; worst 3.817 s at 36 m.
- **Expected:** 0.100 s after first shot (0.417 s from sight).
- **Direction:** first-burst hit probability far too low, which removes the
  damage cue that tells the player he is being shot at.
- **Judges:** judge 1 (named with the per-engagement numbers).
- **Fix:** `fps/src/ai.js` `shoot()` (~line 789–805): the aim error
  (`aimErrorMetres / max(d, aimErrorFloorRange) + aimErrorAngle`) is applied to
  the opening burst exactly as to every later one. Partly inflated by #1 — re-measure
  after the scheduler fix before touching the error model.

### 9. Uncompensated fire is sometimes *faster* than compensated fire
- **Quantity:** ttk and stk, comp = 0 at 45 m.
- **Clone:** 4 of 10 engagements kill in 0.2667 s with 4 landed rounds, against
  10/10 at 0.3667 s / 5 rounds for the compensated shooter — not compensating is
  27% faster 40% of the time. The comp = 0 stk column is also non-monotone in
  range: 4 at 10/25/45 m, 5 at 60 m.
- **Expected:** uncompensated ttk ≥ compensated ttk at every range, and stk
  monotone non-decreasing with range within a condition.
- **Direction:** the recoil climb (0.115 °/round ADS = 9.0 cm/round at 45 m)
  walks the aim onto the head multiplier for free instead of off the target.
- **Judges:** judge 1 only. Judges 2 and 3 examined the same rows and called the
  behaviour correct emergent hitbox physics.
- **Fix:** `fps/src/main.js` hit resolution against `player.js TUNING` hitbox
  extents (`radius` / `standHeight`) plus the headshot multiplier in
  `fps/src/weapon.js`. **Low confidence:** the reference's uncompensated column is
  not sourced — the key's own caveat says "the uncompensated half needs a recoil
  magnitude and a hitbox, neither of which any key supplies," and it borrowed
  `player.js TUNING.radius` as the torso half-width to produce its answer. Treat
  the *coherence* violation (spraying beats controlling) as the bug; do not treat
  the reference's numbers as the target.

### 10. AI reaction-time band too narrow
- **Quantity:** spread of first-shot delay.
- **Clone:** 0.250–0.350 s, sd 0.030 s (7 distinct tick values).
- **Expected:** ~0.20–0.40 s, sd ~0.041 (reference 0.233–0.383), from
  `ai.ai_reaction_delay_base` / `ai_reaction_delay_range`.
- **Direction:** too little spread at both ends — no fast reactions and no slow
  ones, so first-shot timing is more predictable than the sourced band allows.
  Means agree (0.290 vs 0.294 s), so this is shape only.
- **Judges:** judges 1 and 2; judge 1 flagged it himself as weak at n = 24, and
  judge 3 explicitly called reaction time indistinguishable.
- **Fix:** `fps/src/ai.js` — `CONFIG.reactionTime: [0.22, 0.32]` (~line 58).
  Widen to the sourced band. Lowest priority in this list.

### 11. Standing-start ramp has a flat spot
- **Quantity:** per-tick speed increments from rest.
- **Clone:** 1.550, 1.075, **1.075**, 0.964, 0.811, 0.683, 0.575 m/s — two equal
  increments, costing ~0.23 m/s of early speed over the first 3 ticks.
- **Expected:** a single smooth ramp (reference: 1.550, 1.305, 1.098, 0.924,
  0.778, 0.655, 0.551 — constant ratio 0.842).
- **Direction:** ~33 ms of dead input at sprint start.
- **Judges:** judges 1 and 2. Both mis-diagnosed the cause — judge 1 called it "a
  duplicated/stalled tick", judge 2 "a one-frame input/latch ordering slip". The
  actual cause is `Math.max(speed, 3.0) * TUNING.friction * dt` in
  `fps/src/player.js` (~line 519): below 3 m/s the friction term is a *constant*
  0.475 m/s per tick rather than proportional to speed, so ticks 2 and 3 come out
  identical. The floor is deliberate (it snaps a walk to a stop); the side effect
  is this flat spot.
- **Fix:** `fps/src/player.js` friction block, ~line 519.

### Named by judges, excluded from the bug list

- **Jump launch velocity / apex "too high" — excluded, instrument artifact.**
  All three judges said the clone's jump is 2.7% hot and its apex 5.5% too high,
  by back-extrapolating a *continuous-time* apex from the launch velocity
  (6.518²/2g = 1.045 m). The trace exposes `vy` but no position column, so that
  was the only apex available to them. Integrating the trace's own `vy` on its own
  1/60 s grid: **clone apex 0.9916 m, reference apex 0.9383 m**, against the
  sourced 39 units = 0.9906 m. The clone is right to 0.1% — `jumpVelocity: 6.518`
  is the solution of v0²/2g − v0·dt/2 = h and exists precisely to cancel the
  semi-implicit half-step — and the *reference* undershoots its own key by 5.3%
  by asserting the continuous 6.345 on a discrete grid. The airtime tell inverts
  the same way: the sourced arc lasts 0.6246 s, the clone 0.6167, the reference
  0.600. This is the clearest case in the set of a right answer being marked
  wrong by the trace's column set.
- **AI accuracy non-monotone with range — excluded, not statistically present.**
  All three judges named the 28 m → 36 m rise (0.239/0.250 → 0.285/0.267) as a
  defect. It is 24/96 vs 43/161 hits: difference 0.017, SE 0.056, **z = 0.30**.
  There is no inversion at n = 6 engagements per cell. What is real is the round
  count behind it (96 vs 167), which is defect #2 — the same bug seen as a ratio.
- **AI hits-to-kill variance (8–11 within the 36 m band) — excluded.** Judge 2
  read the clone's range-dependent per-hit damage as a bug against the
  reference's flat 8-hits-everywhere. The reference's constant is
  `ai.js CONFIG.damage` borrowed wholesale (nothing publishes AI per-round
  damage), so it is not a target. The clone's falloff is a property, not a defect.
- **Uncompensated survivors at 60 m (clone 4/10, reference 0/10) — excluded.**
  Judge 1 called the clone's miss rate too high; judges 2 and 3 called the same
  rows the correct behaviour. The reference's 10/10 rests on a hitbox it borrowed
  from the clone. No defensible expected value exists.
- **Slide entry boost far too small — excluded, shared and non-attributable.**
  +1.1% over sprint in the clone, +0.3% in the reference, where
  `slide_max_speed_scale` 1.55 implies ~+15%. Judge 3 flagged it and correctly
  noted it is not a tell. It is a real coherence problem in **both**
  implementations of the slide envelope and belongs on the `targets.mjs` /
  generator side as much as in `player.js`.
- **TTK flight times imply 2700 → 1029 m/s — excluded, instrument convention.**
  Judge 3's own note: shared by both files. The 0 s at 10 and 25 m is the
  `instant_hit_range_formula_divisor` convention (everything inside 750/20 = 37.5 m
  resolves on the trigger tick); the varying apparent velocity is that radius plus
  tick quantisation, not a per-range muzzle velocity. Not a property of the game.
- **Recoil: everything.** No judge identified the clone, so by construction
  nothing here is attributable. The two shared observations all three made —
  the climb never plateaus (0.113 °/round at round 3 and still 0.113 at round 30,
  accumulating to 3.2–3.3° ADS with no asymptote) and the horizontal carries no
  learnable bias — are real and worth acting on, but see §3: the comparison
  cannot adjudicate them.

---

## 3. What this comparison can and cannot support

**It is not a comparison against Call of Duty.** The reference side was
synthesised from `targets.mjs` — published figures and the model they imply.
Every reference file says so in its own `provenance` field. A *cannot tell* here
means the clone reproduces the documented model in shape as well as in scalar
value. It does not mean the clone feels like Call of Duty, and no result in this
set is evidence about feel.

**Three of the four metrics were partly unwinnable, because the reference
borrowed the clone's own constants for the quantity under test.** The key's
`borrowed` lists are explicit:

- **recoil** — all four recoil magnitude keys are `null`, so the generator took
  `recoilVerticalMin/Max`, `recoilHorizontalMin/Max`, `recoilCenterSpeed` and
  `recoilAdsScale` straight out of `weapon.js`. The 3.8% agreement on round-30
  climb was therefore guaranteed before either trace was written. What the metric
  *did* test is real but narrow: cadence from `m4a1_mw2019_rpm` (682), recentring
  as a rate that competes with the next kick rather than a timer, zero ADS
  spread, and the ADS/hip ratio shape. The clone passes all of those. The
  key's own caveat states it: "magnitude is NOT sourced — this trace tests shape
  only."
- **ai** — the rhythm (`burstCount`, `burstDelay`, `fireInterval`), the damage
  and all three aim-error parameters are borrowed from `ai.js CONFIG`. The
  reference is, by construction, the clone's own numbers minus a state machine.
  That is exactly why the judges won on the state machine and on nothing else.
- **ttk** — the compensated half is sourced end to end and passes cleanly. The
  uncompensated half needed a recoil magnitude and a hitbox, and had neither, so
  it borrowed the clone's recoil constants and `player.js TUNING.radius`. The
  clone's graded survival curve and the reference's step function are two
  arbitrary hitbox models, and two of three judges preferred the clone's.

Only **velocity** put sourced scalars against the clone across the board — sprint
plateau, crouch speed, jump ballistics, slide envelope, air-momentum conservation
— and only there did the acceleration/friction rates have to be borrowed
(`groundAccel`, `friction`, both unpublished), which is precisely where two
judges misread defect #11.

**The judges won ttk and ai on generator shape, not on fidelity.** "Zero variance
in all 120 engagements" and "no state machine, therefore no dormancy" identify
*how the reference was made*. They happen to have found a genuine and serious
clone bug in the AI case — a 9.4 s silent gap is the one difference in the whole
set a player would notice inside a single engagement — but the method was
generator archaeology, and it would have worked whatever the clone did.

**The lateral-sd trap.** All three judges reached for lateral yaw dispersion as a
recoil tell and all three dismissed it as sampling noise. They were right for the
wrong reason. The key records that the recoil generator *rejected candidate
blocks* — 2 of them for hipfire — to keep the reference's lateral sample deviation
inside 0.62–1.45× its own model, and the accepted ADS block sits at 0.63× of the
model's 0.3024, right on the lower edge. The reference's lateral dispersion is a
filtered sample, so any lateral-sd tell reads the acceptance band and not the
game. Had a judge trusted that statistic he would have been misled with high
confidence.

**One right answer was scored wrong by the trace format.** Defect #8 in the
excluded list: three of three judges marked the clone's jump too hot because the
`velocity` trace carries `vy` and not `y`, so the only apex they could compute was
the continuous-time one. Integrated on the trace's own grid the clone's apex is
0.9916 m against the sourced 0.9906, and the reference's is 0.9383. The clone's
discrete-arc correction is correct and the reference asserts a continuous
velocity on a discrete grid.

**What would make it winnable next time**

1. **Emit the quantity each key is stated in.** `jump_height` is a height; the
   trace must carry a position column, not just `vy`. This one omission cost three
   judges a correct call and would have cost the clone a real regression if
   someone had acted on it.
2. **Dither the reference the way a recording is dithered.** Sample per
   engagement, not per cell: the ttk reference's identical ten rows per cell, and
   its identical compensated/uncompensated columns, hand the verdict over before
   any physics is examined. Zero variance is the loudest signal in the set and it
   is pure provenance.
3. **Give the reference a state machine, or stop calling those metrics blind.**
   An AI reference that cannot reposition, reload or lose a target can only ever
   be distinguished from a real one by the presence of states. Either model the
   states, or label the AI pair up front as "rhythm and reaction only".
4. **Mark the borrowed quantities in the trace itself.** Where the key is `null`
   and the generator took the clone's constant, the metric tests shape only, and
   the judges should be told which columns are in that category — otherwise they
   spend their evidence on rows that agree by construction.
5. **Drop the acceptance/rejection band on the reference's lateral sd**, or
   publish it in the trace. It biases the exact statistic judges reach for.
6. **More samples per cell.** 10 magazines and 6 engagements per range are not
   enough to support the AI accuracy claim all three judges made (z = 0.30) or to
   separate a 3.8% recoil offset from magazine-to-magazine spread.

**Where the clone actually stands, stated conservatively**

- **Genuinely done:** the fully-sourced parts of the recoil model (cadence,
  recentring as a rate, zero ADS spread, ADS/hip ratio) and the compensated TTK
  table (266.7 / 366.7 ms, 4 / 5 STK, against sourced 264 ± 25 and 352 ± 30 ms).
  Also the jump arc, which is more accurate than the reference's.
- **Genuinely broken, and a player would feel all three inside a minute:** the AI
  burst scheduler falling out of its firing state (#1, #2), the air-drag /
  landing-stutter pair (#3, #4), and the slide-exit jolt (#5).
- **Unresolved by this exercise:** whether the recoil pattern should plateau. All
  three judges flagged the missing plateau, in *both* files — the sourced key
  describes recentring competing with the next kick, which implies a steady state,
  and neither implementation reaches one. The comparison cannot settle it because
  `recoil.total_vertical_climb_after_n_rounds_degrees` is `null` and the reference
  inherited the clone's own model. That needs a sourced climb figure, not another
  blind pair.
