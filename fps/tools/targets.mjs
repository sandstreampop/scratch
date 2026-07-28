// targets.mjs — single source of truth for what this Three.js FPS is measured against.
//
// PROVENANCE AND ITS LIMITS. Every number in this file was corroborated through WebSearch by a
// researcher and then reproduced by an independent verifier running its own, differently-phrased
// queries. Direct page fetches were impossible in this environment — every host returned 403 — so
// "corroborated" means TWO OR MORE INDEPENDENT SEARCHES AGREED on the figure. It does NOT mean a
// primary source was read. Confidence levels used below:
//   'corroborated'  — two or more independent searches returned the same figure.
//   'derived'       — pure arithmetic on corroborated figures; inherits their tolerance.
//   'single-source' — surfaced once, or reproduced only from the same page; treat with suspicion.
// Numbers that could not be sourced were DELIBERATELY DROPPED rather than guessed: several recoil
// entries carry value: null on purpose. A target without a `source` is a bug — fix the target, do
// not fix the test.
//
// UNITS. Every duration in this file is in SECONDS and every angle is in RADIANS at the point of
// definition; the human-readable figure (ms, degrees, rpm) is preserved in the note. This is not
// cosmetic: a unit mismatch is exactly how a test suite goes green while measuring the wrong thing.
//
// SCOPE. This file is deliberately thin where the evidence is thin. Call missing() to get the scope
// items that have no target at all, and print it — a suite that stays quiet about its blind spots
// is implying coverage it does not have.

const DEG = Math.PI / 180;

/** @typedef {{pct:number}|{abs:number}|{min:number,max:number}|null} Tol */

export const TARGETS = Object.freeze({
  handling: Object.freeze({
    m4_ads_time: Object.freeze({
      value: 0.270,
      unit: 's',
      tol: Object.freeze({ pct: 0.20 }),
      title: 'Modern Warfare 3 (2023) / Warzone — M4 (MW2 2022 platform)',
      source: 'https://www.escapistmagazine.com/all-weapon-buffs-nerfs-in-mw3-warzone-season-2/',
      confidence: 'corroborated',
      note: '270 ms. Official Season 2 patch notes: M4 ADS time increased from 260 ms to 270 ms (+4%); '
        + 'both queries returned the 260->270 ms pair. CORRECTION to the starting brief: 232 ms was never '
        + 'surfaced by any query and appears wrong for the M4; documented MW3-era base is 260-270 ms (hip to '
        + 'fully aimed, no attachments). A separate result cited 240 ms in a Warzone 2 / MW2-launch context, '
        + 'so read 240 ms (MW2 2022 launch) -> 260 ms -> 270 ms (MW3 S2) as drift over time. The +/-20% band is '
        + 'deliberately wide (216-324 ms) to span the MWII-launch and MW3-patched values, and one query that '
        + 'returned 300 ms, rather than pretending any one of them is exact.',
    }),
    m4_fire_rate: Object.freeze({
      value: 811,
      unit: 'rpm',
      tol: Object.freeze({ pct: 0.05 }),
      title: 'Modern Warfare 2 (2022) / MW3 (2023) — M4',
      source: 'https://www.thegamer.com/call-of-duty-modern-warfare-2-assault-rifles-ranked-best/',
      confidence: 'corroborated',
      note: '811 rpm base, full-auto; same weapon platform carries into MW3/Warzone. Reproduced verbatim '
        + '("high rate of fire of 811 rpm") and it is a published integer stat rather than a patch delta, so the '
        + 'band is tight. Muzzle velocity 590 m/s was reported alongside it in one query only, so it is not '
        + 'listed as its own target (it survives as the low endpoint of ar_muzzle_velocity_design_band).',
    }),
    m4_shot_interval: Object.freeze({
      value: 0.0740,
      unit: 's',
      tol: Object.freeze({ pct: 0.05 }),
      title: 'Modern Warfare 2 (2022) / MW3 (2023) — M4',
      source: 'https://www.thegamer.com/call-of-duty-modern-warfare-2-assault-rifles-ranked-best/',
      confidence: 'derived',
      note: '74.0 ms between shots. Arithmetic: 60 / 811 rpm = 0.07398 s. Usable directly as a fixed-timestep '
        + 'fire cooldown; inherits the fire rate tolerance exactly. At 60 Hz this is 4.44 frames, so the '
        + 'implementation MUST accumulate fractional time rather than gate firing on whole frame counts.',
    }),
    mcw_ads_time: Object.freeze({
      value: 0.265,
      unit: 's',
      tol: Object.freeze({ abs: 0.025 }),
      title: 'Modern Warfare 3 (2023) — MCW (flagship M4A1-class AR)',
      source: 'https://www.dexerto.com/call-of-duty/mw3-season-2-patch-note-2520071/',
      confidence: 'corroborated',
      note: '265 ms. Official MW3 Season 2 change: 240 ms -> 265 ms (+10%), reproduced exactly and correctly '
        + 'attributed to the MCW. Second M4A1-class datapoint: 265 ms lands within 2% of the M4 270 ms, good '
        + 'mutual support for ~0.26-0.27 s as the MW3-era AR ADS target. The +/-25 ms band is roughly the size of '
        + 'that single patch step, so a clone tuned to the wrong side of the patch still fails.',
    }),
    mcw_sprint_to_fire_time: Object.freeze({
      value: 0.252,
      unit: 's',
      tol: Object.freeze({ abs: 0.025 }),
      title: 'Modern Warfare 3 (2023) — MCW',
      source: 'https://www.dexerto.com/call-of-duty/mw3-season-2-patch-note-2520071/',
      confidence: 'corroborated',
      note: '252 ms. Season 2: 241 ms -> 252 ms (+5%), reproduced exactly alongside the ADS change. Faster than '
        + 'the M4 320 ms; together they put the MW3 AR sprint-to-fire band at roughly 0.25-0.32 s. This is the '
        + 'only MW3 assault rifle in this set with a trustworthy sprint-to-fire number — both M4 sprint keys '
        + 'collapsed under verification.',
    }),
    m4a1_mw2019_fire_rate: Object.freeze({
      value: 682,
      unit: 'rpm',
      tol: Object.freeze({ pct: 0.15 }),
      title: 'Modern Warfare (2019) — M4A1',
      source: 'https://callofduty.fandom.com/wiki/M4A1',
      confidence: 'corroborated',
      note: '682 rpm, tied with the Kilo 141; both queries returned the figure and the tie, and one explicitly '
        + 'denied an 800 rpm figure. Derived shot interval 60/682 = 88.0 ms. Materially slower than the 2022 '
        + 'M4 811 rpm — the same nameplate weapon is not the same gun across titles, so pick ONE title as the '
        + 'target rather than averaging. Band loosened to +/-15% because cross-title contamination is easy here: '
        + 'unbiased queries also returned 830 rpm and 811 rpm for this weapon. No ADS or sprint-out time for the '
        + '2019 M4A1 could be corroborated and those are omitted.',
    }),
    xm4_ads_time: Object.freeze({
      value: 0.270,
      unit: 's',
      tol: Object.freeze({ abs: 0.025 }),
      title: 'Black Ops 6 — XM4 (M4-class AR)',
      source: 'https://callofduty.fandom.com/wiki/XM4',
      confidence: 'corroborated',
      note: '270 ms, described as below average for the BO6 AR class (tied with the Swordfish). Reproduced '
        + 'verbatim including that qualifier, which suggests a real stat table rather than a back-filled number. '
        + 'Identical to the MW3 M4 270 ms, so ~0.27 s is a stable cross-title ADS target for a mid-weight AR.',
    }),
    xm4_sprint_to_fire_time: Object.freeze({
      value: 0.162,
      unit: 's',
      tol: Object.freeze({ abs: 0.025 }),
      title: 'Black Ops 6 — XM4',
      source: 'https://callofduty.fandom.com/wiki/XM4',
      confidence: 'corroborated',
      note: '162 ms, "slightly below average in class", reproduced verbatim with that qualifier. Roughly half the '
        + 'MW3 M4 320 ms — BO6 tunes sprint-to-fire on a very different scale from MW2/MW3, so do not mix the two '
        + 'generations in one weapon. Caveat on the researcher claim that a 150 ms figure was a mis-attributed '
        + 'BO6 number: the verifier notes the MW3 M4 real value sits right next to 150 ms, which undercuts that.',
    }),
    xm4_fire_rate: Object.freeze({
      value: 750,
      unit: 'rpm',
      tol: Object.freeze({ pct: 0.05 }),
      title: 'Black Ops 6 — XM4',
      source: 'https://callofduty.fandom.com/wiki/XM4',
      confidence: 'corroborated',
      note: '750 rpm in multiplayer, tied with the S36, PDW-57 and Type 19 — the exact tie-list reproduced. '
        + 'Derived shot interval 60/750 = 80.0 ms. One result quoted 800 rpm but explicitly for Zombies mode; do '
        + 'not use that for MP targets. Published integer stat, so the band is tight.',
    }),
    xm4_base_movement_speed: Object.freeze({
      value: 4.37,
      unit: 'm/s',
      tol: Object.freeze({ pct: 0.15 }),
      title: 'Black Ops 6 — XM4',
      source: 'https://callofduty.fandom.com/wiki/XM4',
      confidence: 'corroborated',
      note: 'Base (non-ADS, non-sprint) movement speed while holding the XM4. Reproduced as the 4.37 / 2.49 pair '
        + 'on independently-phrased queries. CAVEAT: a competing loadout site lists 4.8 m/s movement / 2.5 m/s '
        + 'crouch / 3.2 m/s ADS; 4.37 is reported and the 4.8 set is a disagreeing secondary, which is what the '
        + '+/-15% band absorbs. Sprint was described as ~39% above base walk, implying ~6.1 m/s — not corroborated '
        + 'separately, so not listed as a target.',
    }),
    xm4_ads_movement_speed: Object.freeze({
      value: 2.49,
      unit: 'm/s',
      tol: Object.freeze({ pct: 0.15 }),
      title: 'Black Ops 6 — XM4',
      source: 'https://callofduty.fandom.com/wiki/XM4',
      confidence: 'corroborated',
      note: '"Aim walking movement speed" — speed while fully aimed down sights. Both queries returned the '
        + '4.37 / 2.49 pair together, with the corroborating detail that it trails every AR except the LAG 53 — a '
        + 'ranking claim a fabricated number would not carry.',
    }),
    ads_movement_speed_fraction: Object.freeze({
      value: 0.57,
      unit: 'fraction of base walk speed',
      tol: Object.freeze({ min: 0.57, max: 0.67 }),
      title: 'Black Ops 6 — XM4',
      source: 'https://callofduty.fandom.com/wiki/XM4',
      confidence: 'derived',
      note: 'Arithmetic: 2.49 m/s aim-walking / 4.37 m/s base = 0.5698, i.e. ADS costs ~43% of walk speed. The '
        + 'human tolerance was stated as "+/-0.10 (0.57-0.67 acceptable)" and is encoded one-sided-wide as '
        + '0.57-0.67 to reach the 0.667 implied by the competing 3.2 / 4.8 stat set, rather than pretending the '
        + 'ratio is pinned; 0.57 is the better-supported end. This is the only title for which an ADS movement '
        + 'penalty could be corroborated at all.',
    }),
  }),

  recoil: Object.freeze({
    per_shot_vertical_kick_degrees: Object.freeze({
      value: null,
      unit: 'rad (would be; none published)',
      tol: null,
      title: 'MW2019 / MW2 2022 / MW3 2023 / BO6 (M4A1 / M4 / TAQ-56 class AR)',
      source: 'https://www.thegamer.com/call-of-duty-black-ops-6-a-complete-guide-to-the-gunsmith/',
      confidence: 'single-source',
      note: 'OMITTED AS A NUMBER — no per-shot vertical kick figure for an M4-class AR could be corroborated. '
        + 'Four differently-angled searches (weapon-name, game-file, sym.gg, BO6) returned no numeric per-shot '
        + 'degree value; the verifier independently confirmed absence, the closest being a unitless BO6 XM4 '
        + '"vertical recoil 7.26" which is an in-engine scalar, not degrees. One search surfaced unattributed '
        + 'deg/s figures (vertical ~42-44.4 deg/s, horizontal ~10.6-15.6 deg/s, hipfire spread 2.2-2.4 deg min / '
        + '6.3-6.7 deg max) but the page was probably the FMG9, an SMG, so it is not reportable under the AR '
        + 'anchor. TOLERANCE: n/a — no published target. Measure empirically and assert only monotonic climb over '
        + 'a burst. What IS documented is the SHAPE (see recoil_determinism): min-vertical / max-vertical / '
        + 'min-horizontal / max-horizontal / center-speed, so an implementation needs four bounds plus a '
        + 'recentering rate, not a single per-shot constant.',
    }),
    per_shot_horizontal_kick_degrees: Object.freeze({
      value: null,
      unit: 'rad (would be; none published)',
      tol: null,
      title: 'MW2019 / MW2 2022 / MW3 2023 / BO6 (M4-class AR)',
      source: 'https://www.mmopixel.com/news/all-weapon-nerfs-and-buffs-in-black-ops-6-season-4-explained',
      confidence: 'single-source',
      note: 'OMITTED AS A NUMBER — same situation as vertical; no query on either pass surfaced a horizontal '
        + 'per-shot degree value for any weapon, and Gunsmith-derived horizontal figures are percentage '
        + 'attachment penalties (e.g. CHF barrel 20% -> 15%), not absolute angles. TOLERANCE: n/a — assert only '
        + 'that horizontal displacement is zero-mean and bounded. Structurally, horizontal kick is signed and '
        + 'drawn from a min/max band per shot, which is why CoD horizontal recoil reads as left-right wobble '
        + 'around a rising centreline rather than a fixed zigzag.',
    }),
    recoil_determinism: Object.freeze({
      value: 'randomised per shot within authored min/max bounds; view kick draws one random vertical and one '
        + 'random horizontal value per shot. The five authored numbers per weapon are max horizontal, min '
        + 'horizontal, max vertical, min vertical, and center speed.',
      unit: 'qualitative',
      tol: null,
      title: 'Call of Duty engine (Fandom Game Engine/Mechanics; sym.gg Warzone mechanics)',
      source: 'https://callofduty.fandom.com/wiki/Recoil',
      confidence: 'corroborated',
      note: 'The single most load-bearing finding for this port, and well corroborated from two independent '
        + 'angles. CoD recoil is NOT a fixed learnable spray pattern like CS:GO: it is bounded randomness with a '
        + 'repeatable central tendency. Implement as kick_v = rand(minV, maxV), kick_h = rand(minH, maxH) per '
        + 'shot; the max/min ratio controls how learnable the gun feels (narrow = near-deterministic, wide = the '
        + '"random recoil" complaint). No degree values for the bounds were obtainable. BEHAVIOURAL TOLERANCE '
        + '(not machine-encodable, hence tol: null): over 200 shots from a fixed origin, per-shot kick must be '
        + 'non-repeating with a bounded envelope — same-seed traces identical, different-seed traces differing, '
        + 'and no fixed learnable pattern within +/-100% of a single mean vector.',
    }),
    recoil_randomness_magnitude_mw2_wz2: Object.freeze({
      value: '4 magazines of the same weapon with identical attachments and tuning produced 4 entirely different '
        + 'recoil patterns (Warzone_Loadout test, MW2 2022 / Warzone 2.0)',
      unit: 'qualitative (magazine-to-magazine variance)',
      tol: null,
      title: 'MW2 2022 / Warzone 2.0',
      source: 'https://dotesports.com/call-of-duty/news/warzone-2-recoil-patterns-throwing-players-off-wild-inconsistency',
      confidence: 'corroborated',
      note: 'Quantifies how WIDE the min/max bands were set in the MW2-2022 era. Reproduced verbatim across '
        + 'Dexerto and dotesports independently, including attribution to Warzone_Loadout. This is a CAUTIONARY '
        + 'target, not an aspirational one: it is the high-randomness end of the design space and was received as '
        + 'a bug by the playerbase. Earlier titles (MW2019 and before) and BO6/BO7 are described as having '
        + 'recognisable, learnable tendencies. If this FPS is meant to feel good, tune the min/max band NARROW '
        + 'enough that a player can learn the pull. TOLERANCE: qualitative; if used as an anti-target, keep '
        + 'magazine-to-magazine trace divergence well under this — e.g. mean endpoint spread across 4 bursts '
        + 'within +/-20% of the mean climb.',
    }),
    view_kick_vs_gun_kick: Object.freeze({
      value: 'view kick moves the view away from the original aim point (camera rotates, so impacts shift); gun '
        + 'kick moves the weapon/sights relative to the screen and shots still hit where the sights point',
      unit: 'qualitative',
      tol: null,
      title: 'Call of Duty engine (all recent titles)',
      source: 'https://callofduty.fandom.com/wiki/Recoil',
      confidence: 'corroborated',
      note: 'Two separate recoil systems, each with its OWN horizontal, vertical and center-speed values. '
        + '(1) VIEW KICK — the most common type; rotates the camera, so point of aim moves and successive shots '
        + 'land higher/off-line. This is the one that must move the Three.js camera yaw/pitch. (2) GUN KICK — '
        + 'displaces the weapon model/sights relative to the screen; rounds still strike wherever the reticle or '
        + 'front sight post currently is, so it affects accuracy only indirectly. Correct port: gun kick = offset '
        + 'applied to the weapon mesh AND to the aim ray screen origin; view kick = offset applied to camera '
        + 'rotation. Confusing these is the classic mistake. Reproduced word-for-word from the Fandom Recoil page '
        + 'via a phrasing sharing no terms with the original queries, including the explicit "shots will still '
        + 'hit where your sights are aimed" clause. TOLERANCE: binary architectural check — gun-kick-only frames '
        + 'must show zero change in hit position for an ADS shot; view-kick frames must shift hit position by '
        + 'exactly the camera delta.',
    }),
    gun_kick_oscillation_overshoot: Object.freeze({
      value: 'gun kick is bi-directional: "if the gun moves to the right it will quickly move back to the left if '
        + 'the player keeps firing" — an oscillation crossing rest position, not a damped one-way return. No '
        + 'source supports view-kick overshoot.',
      unit: 'qualitative',
      tol: null,
      title: 'Call of Duty engine (all recent titles)',
      source: 'https://callofduty.fandom.com/wiki/Recoil',
      confidence: 'corroborated',
      note: 'Answers the overshoot question for GUN KICK specifically: the documented behaviour crosses back '
        + 'through the rest position, so implement gun kick as a spring/oscillator with enough energy to cross '
        + 'centre, not as an ease-out toward zero. The exact wiki sentence was reproduced independently. NOTE: no '
        + 'source describes VIEW kick as overshooting past point of aim — view-kick recentering is described only '
        + 'as returning toward the original aim point, so do not assume view-kick overshoot. TOLERANCE: gun-kick '
        + 'offset must cross the rest position at least once per sustained burst (sign change present); view kick '
        + 'must NOT overshoot past the original aim point by more than ~5% of accumulated displacement.',
    }),
    recoil_recentering_behaviour: Object.freeze({
      value: 'sights/view reset toward the previous aim point at a per-weapon "center speed" rate that takes '
        + 'effect immediately on firing; during fully automatic fire there is usually too much recoil to fully '
        + 're-center between shots, so sustained climb is emergent',
      unit: 'qualitative',
      tol: null,
      title: 'Call of Duty engine (all recent titles); sym.gg Warzone mechanics',
      source: 'https://callofduty.fandom.com/wiki/Game_Engine/Mechanics',
      confidence: 'corroborated',
      note: 'Answers "does the view return fully to point of aim" — yes, but only once firing stops, and it is a '
        + 'RATE not a timer. Center speed takes effect immediately on firing, so recentering competes with the '
        + 'next shot kick rather than waiting for trigger release. During fully automatic fire there is usually '
        + 'too much recoil to completely re-center between shots, which is exactly why sustained fire climbs — '
        + 'the climb is EMERGENT from kick-rate vs center-speed, not authored as a separate climb curve. '
        + 'Corollary confirmed from a fourth angle: tap-firing and letting the reticle re-center is the '
        + 'documented accuracy technique. Port as: apply kick impulse per shot, apply constant recentering '
        + 'velocity every frame toward origin. TOLERANCE: behavioural — a single tap must return to within '
        + '0.05 deg (8.727e-4 rad) of origin; sustained auto fire must show net accumulation (recentering rate < '
        + 'kick rate) rather than a flat plateau.',
    }),
    visual_recoil_vs_aim_deviation: Object.freeze({
      value: 'visual recoil (screen/camera shake plus firing animation) has no effect on where bullets land, but '
        + 'degrades the player ability to read and correct actual recoil; it is partly a client setting '
        + '(1st Person Camera Movement, FOV)',
      unit: 'qualitative (0 effect on impact point)',
      tol: null,
      title: 'MW2 2022 / MW3 2023 (community term, most discussed for MW2 2022)',
      source: 'https://www.oneesports.gg/call-of-duty/reduce-visual-recoil-warzone-2/',
      confidence: 'corroborated',
      note: '"Visual recoil" is a community term, not an engine parameter: the weapon firing animation plus screen '
        + 'shake. It provably does not move the impact point. Its real cost is second-order and worth reproducing '
        + 'carefully — heavy visual recoil obscures the target and misaligns the sight picture, so players cannot '
        + 'READ the actual recoil they need to counter, and many over-correct and miss more. MW2 2022 shipped with '
        + 'it high enough that even low-recoil weapons were hard to use; MW3 2023 explicitly cut it back and the '
        + 'response was positive. Reproduced across ONE Esports and VideoGamer independently; FOV and the 50% '
        + 'camera-movement slider modulate it, confirming presentation-layer only. DESIGN LESSON: keep camera/'
        + 'weapon shake well below the actual aim deviation or the recoil becomes unlearnable for reasons '
        + 'unrelated to its real magnitude. TOLERANCE: binary — impact point must be bit-identical with shake '
        + 'amplitude at 0% and 100%.',
    }),
    ads_bullet_spread_degrees: Object.freeze({
      value: 0,
      unit: 'rad',
      tol: Object.freeze({ abs: 0 }),
      title: 'Call of Duty (all recent titles), ADS with a non-shotgun weapon',
      source: 'https://www.gamesradar.com/call-of-duty-vanguard-bloom-bullet-spread/',
      confidence: 'corroborated',
      note: '0 degrees = 0 rad. Hard zero, corroborated three ways: almost all non-shotgun weapons have NO random '
        + 'spread while aiming down sights — shots land at precisely the point indicated by the sights. '
        + 'Documented exceptions: Vanguard and WWII shipped with ADS bloom, which is the norm they broke. All ADS '
        + 'inaccuracy in CoD therefore comes from recoil displacing the aim point, never from a random cone. '
        + 'Architecturally important: fire ADS shots as an exact centre-screen ray with zero randomisation and '
        + 'express all inaccuracy through the recoil state. Any nonzero ADS randomisation fails; hipfire spread '
        + 'must be clearly nonzero by contrast (hipfire has a real, large cone).',
    }),
    ads_vs_hipfire_recoil_multiplier: Object.freeze({
      value: null,
      unit: 'dimensionless multiplier (none exists)',
      tol: null,
      title: 'Call of Duty (all recent titles)',
      source: 'https://www.mmopixel.com/news/all-weapon-nerfs-and-buffs-in-black-ops-6-season-4-explained',
      confidence: 'corroborated',
      note: 'OMITTED AS A NUMBER, but the corroborated finding is that the number PROBABLY DOES NOT EXIST. There '
        + 'is no such scalar in the base mechanic: three queries agree the documented hipfire-vs-ADS difference is '
        + 'a SPREAD difference (high hipfire spread vs zero ADS spread), and that view kick and gun kick apply in '
        + 'both stances. The verifier likewise found no stance-level multiplier; the only percentages that exist '
        + 'are attachment-scoped focus modifiers (e.g. BO6 Marksman Foregrip: view kick -20%, gun kick -25% while '
        + 'focused), which are per-attachment, not per-stance. Caveat: sources describe ADS as "feeling tamer", '
        + 'which is partly the FOV/zoom effect — the same angular kick subtends more screen pixels when zoomed, so '
        + 'zoom makes identical recoil LOOK larger while the steadier sight picture makes it easier to correct. '
        + 'TOLERANCE: n/a as a matched target; treat any ADS recoil scalar as your own design knob and keep it at '
        + '1.0x (no free reduction) unless deliberately chosen.',
    }),
    total_vertical_climb_after_n_rounds_degrees: Object.freeze({
      value: null,
      unit: 'rad (would be; none published)',
      tol: null,
      title: 'MW2019 / MW2 2022 / MW3 2023 / BO6 (M4-class AR)',
      source: 'https://callofduty.fandom.com/wiki/Recoil',
      confidence: 'single-source',
      note: 'OMITTED AS A NUMBER — no measurement of total vertical climb in degrees (or metres at a stated range) '
        + 'over N rounds surfaced in any phrasing, on either pass. The community recoil testing that DOES exist is '
        + 'comparative and unitless: a widely-cited MW2019 test of all automatic weapons reported stance RATIOS '
        + '(one weapon roughly prone 1 : standing 3 : crouched 9 of travel distance) and found MW2019 stance '
        + 'modifiers were inverted/broken for several guns — Kilo, AK and M13 more accurate standing than '
        + 'crouched, MP5 stance-independent. That ratio is recorded here as CONTEXT ONLY, not as a value: it came '
        + 'from a single query and cannot be attributed to an M4-class AR. TOLERANCE: n/a — measure in the harness '
        + '(fire N rounds at a wall at fixed range, convert impact rise to radians via atan(rise/range)); no '
        + 'published figure exists to match.',
    }),
    ads_idle_sway_onset_delay: Object.freeze({
      value: 0.005,
      unit: 's',
      tol: Object.freeze({ abs: 0.003 }),
      title: 'MW3 2023 / Warzone, Season 2 (Feb 2024) sway rework — all weapons except sniper rifles',
      source: 'https://www.callofduty.com/patchnotes/2024/02/call-of-duty-modern-warfare-iii-season-2-patch-notes',
      confidence: 'corroborated',
      note: '5 ms. Adjacent to recoil but the same subsystem (authored aim deviation), and one of the few hard '
        + 'millisecond figures in this domain. ADS idle sway no longer starts the instant you aim: there is a '
        + 'delay before the sway curve begins, generally 5 ms though it VARIES BY WEAPON — beyond the +/-3 ms band '
        + 'encoded here, also accept per-weapon variation up to ~2x (i.e. ~10 ms) per the patch notes wording. '
        + 'Sniper rifles are excluded from the change. Stated purpose: fast, precise players should not be '
        + 'penalised at the moment of ADS. Reproduced verbatim from the official patch notes including the '
        + 'per-weapon-variance and sniper-exclusion qualifiers.',
    }),
    ads_idle_sway_rampup_to_peak: Object.freeze({
      value: 3,
      unit: 's',
      tol: Object.freeze({ pct: 0.15 }),
      title: 'MW3 2023 / Warzone, Season 2 (Feb 2024) sway rework — all weapons except sniper rifles',
      source: 'https://www.callofduty.com/patchnotes/2024/02/call-of-duty-modern-warfare-iii-season-2-patch-notes',
      confidence: 'corroborated',
      note: '3 s (2.55-3.45 s). After the ~5 ms onset delay, ADS idle sway ramps gradually over 3 s before '
        + 'reaching peak speed, instead of starting at full speed. The patch notes state a flat 3 s with no '
        + 'per-weapon caveat, so the band only absorbs frame-timing and measurement error. Two further '
        + 'corroborated qualitative points from the same rework: (a) sway intensity was decreased overall, and '
        + '(b) VARIANCE WAS REMOVED from ADS idle sway, giving a predictable, consistent motion curve, the stated '
        + 'rationale being that determinism raises the skill ceiling. Sway also now begins from the position of '
        + 'the hipfire crosshair rather than an arbitrary point on the sway curve. Note the contrast with view '
        + 'kick, which remains randomised within min/max bounds: CoD trend is a DETERMINISTIC slow aim-deviation '
        + 'channel and a STOCHASTIC per-shot kick channel.',
    }),
  }),

  ballistics: Object.freeze({
    bullet_model_is_projectile_not_hitscan: Object.freeze({
      value: 1,
      unit: 'boolean (1 = projectile with travel time)',
      tol: Object.freeze({ abs: 0 }),
      title: 'Modern Warfare 2019 onward (MW2019, MW2 2022, MW3 2023, BO6/Warzone)',
      source: 'https://callofduty.fandom.com/wiki/Hitscan',
      confidence: 'corroborated',
      note: 'Pre-2019 CoD used hitscan (instant registration, zero travel time). From MW2019 onward every bullet '
        + 'is a simulated projectile with muzzle velocity and mass; Warzone sources state explicitly that "all of '
        + 'the weapons in Warzone operate on a projectile system" and that weapons only APPEAR hitscan when '
        + 'velocity is high enough. Reproduced independently from the CoD Wiki hitscan page (MW2019 replaced '
        + 'hitscan with modeled projectiles plus bullet drop and velocity, forcing lead at range). For the port: '
        + 'spawn a moving projectile, do not raycast instantly. Tolerance is exact — this is a binary '
        + 'architectural fact, not a tuned number; a hitscan implementation is simply wrong for MW2019+.',
    }),
    ar_muzzle_velocity_mcw_mw3_2023: Object.freeze({
      value: 750,
      unit: 'm/s',
      tol: Object.freeze({ pct: 0.08 }),
      title: 'Modern Warfare III (2023) — MCW (the game M4-analogue AR)',
      source: 'https://codmunity.gg/weapon/mw3/mcw',
      confidence: 'corroborated',
      note: 'Post-buff value; the MCW was raised from 710 m/s to 750 m/s in an MW3/Warzone balance update, so '
        + '710-750 brackets the title lifetime and that is what the +/-8% band covers. Reproduced independently as '
        + '"750 m/s, up from 710 m/s", with the day-1 18% velocity boost corroborating direction. 8% is tight '
        + 'enough to reject an MW-era-vs-BO6-era mixup. The same listing gave Holger 556 and MTZ 556 at 720 m/s, '
        + 'i.e. MW3-era ARs cluster around 700-760 m/s.',
    }),
    ar_muzzle_velocity_xm4_bo6: Object.freeze({
      value: 800,
      unit: 'm/s',
      tol: Object.freeze({ min: 780, max: 860 }),
      title: 'Black Ops 6 — XM4 (M4-class AR)',
      source: 'https://codmunity.gg/weapon/bo6/xm4',
      confidence: 'corroborated',
      note: '800 m/s in BO6 MULTIPLAYER; 820-850 m/s in WARZONE — the value differs by mode, which the researcher '
        + 'framing omitted. Verified as "800 m/s (up from 750)" for BO6 MP and "increased from 820 m/s to 850 m/s" '
        + 'for Warzone; one stat listing also gave 830 m/s. The encoded 780-860 window (the "+/-8%" of the human '
        + 'string) spans the MP/WZ split without letting an MW-era 590-750 value pass. BO6-era ARs sit higher than '
        + 'MW-era ones: AMES 85 810, Krig C 815, Model L 820, GPR 91 780, AS VAL 790 m/s from the same listing.',
    }),
    ar_muzzle_velocity_design_band: Object.freeze({
      value: null,
      unit: 'm/s',
      tol: Object.freeze({ min: 590, max: 850 }),
      title: 'MW2 2022 / MW3 2023 / BO6 assault rifles',
      source: 'https://codmunity.gg/weapon-stats/warzone',
      confidence: 'derived',
      note: 'A BAND, not a point target, so value is deliberately null and the tolerance IS the band: 590-850 m/s. '
        + 'Envelope derived from the three corroborated AR numbers (M4 590, MCW 750, XM4 820-850); every endpoint '
        + 'the verifier independently reproduced falls inside it (M4 590 launch / 820 buffed, MCW 710-750, XM4 '
        + '800-850). A defensible single target for an M4A1-class AR is 700-800 m/s — the verifier prefers this '
        + 'mid-band to the researcher 600-750, since post-buff MW2 and all BO6 ARs sit above 750. Reject any AR '
        + 'under 500 or over 900 m/s base. These are gameplay values, not real ballistics (a real M4A1 muzzles '
        + '~880-900 m/s): CoD deliberately runs ARs slower than reality to make leading a skill.',
    }),
    velocity_attachment_gain_twist_barrel: Object.freeze({
      value: 1.40,
      unit: 'multiplier on base muzzle velocity',
      tol: Object.freeze({ min: 1.30, max: 1.45 }),
      title: 'Black Ops 6 — HDR sniper with Gain-Twist Barrel',
      source: 'https://www.pcgamer.com/games/call-of-duty/black-ops-6-barrels-barely-do-anything/',
      confidence: 'single-source',
      note: 'Concretely 648 m/s -> 900 m/s, described as ~+39%, i.e. a velocity barrel is worth roughly +40%. The '
        + 'REUSABLE figure is the multiplier (+30% to +45%), not the weapon-specific absolute pair, which is why '
        + 'the tolerance is expressed on the percentage. Flagged single-source by the researcher, but the verifier '
        + 'did reproduce the exact 648-to-900 figure and the "nearly 40%" framing from the same PC Gamer/YouTuber '
        + 'analysis, and it cross-checks against the XM4 build where Gain-Twist is described as +40%.',
    }),
    velocity_attachment_stacked_ceiling: Object.freeze({
      value: 1.65,
      unit: 'multiplier on base muzzle velocity',
      tol: Object.freeze({ pct: 0.15 }),
      title: 'Warzone (MW2/MW3/BO6 era) — velocity-stacked builds',
      source: 'https://www.dexerto.com/call-of-duty/warzone-expert-reveals-one-rifle-is-statistically-the-best-ranked-play-weapon-3018790/',
      confidence: 'corroborated',
      note: '~1.6-1.7x base velocity; concretely 1344 m/s on an XM4 (Gain-Twist +40% x Overpressured +20%). '
        + 'Tolerance is on the MULTIPLIER because the absolute ceiling scales with the weapon. Two differently '
        + 'phrased queries independently reported stacked builds far above base ("bullet travel speed can exceed '
        + 'over 1100 m/s on some LMGs with the right attachments"; the 1344 m/s XM4 build), and the verifier '
        + 'reproduced 1344 m/s with the exact stacking arithmetic — 1344 / 1.68 = 800, matching the '
        + 'independently verified XM4 MP base. Contributing slots are muzzle, barrel and ammunition; the trade is '
        + 'damage range or handling. Rapid-Fire style attachments REDUCE velocity in exchange for RPM.',
    }),
    bullet_gravity_drop_present: Object.freeze({
      value: 1,
      unit: 'boolean (1 = bullets affected by gravity)',
      tol: Object.freeze({ abs: 0 }),
      title: 'MW2019 and MW2 2022 (and successors)',
      source: 'https://callofduty.fandom.com/wiki/Hitscan',
      confidence: 'corroborated',
      note: 'Gravity acts on all projectiles, magnitude deliberately small. The CoD Wiki hitscan entry describes '
        + 'MW2019 as using "semi-realistic bullet drop and velocity mechanics", corroborating presence. Developer '
        + 'framing (Infinity Ward): drop was kept deliberately small because CoD is fast — at close and mid range '
        + 'players should get an effectively instantaneous hit, and drop only needs compensating with DMRs and '
        + 'snipers at extreme range. NO numeric drop-in-metres-at-range figure could be corroborated on either '
        + 'pass, so no magnitude is asserted: implement gravity as a small constant tuned so AR deviation inside '
        + '100 m is under ~10 cm (visually negligible). The exact-boolean tolerance applies to PRESENCE only.',
    }),
    instant_hit_range_formula_divisor: Object.freeze({
      value: 20,
      unit: 'Hz server tick (instant-hit range in m = velocity in m/s / 20)',
      tol: Object.freeze({ abs: 0 }),
      title: 'Warzone (MW2/MW3/BO6 era)',
      source: 'https://www.sportskeeda.com/call-of-duty-game/jgod-turns-any-weapon-hitscan-warzone-season-3-reloaded-update',
      confidence: 'corroborated',
      note: 'Warzone servers run a 20 Hz tick, so any target inside (velocity / 20) metres resolves within a '
        + 'single tick and the projectile is indistinguishable from hitscan. The divisor is EXACT (hence abs: 0); '
        + 'only the per-weapon derived instant-hit radius needs slack, and the human tolerance allows +/-15% on '
        + 'that derived radius. Strongest reproduction of the whole set: the verifier query independently returned '
        + '"Bullet Velocity / 20 = effective hitscan range" with three fresh worked examples (500 m/s -> 25 m, '
        + '900 -> 45 m, 1100 -> 55 m) on top of the original two (540 m/s -> 27 m; SVA 545 at 760 m/s -> 38 m). '
        + 'Most useful single rule for the port: velocity / tick_rate is the "feels like hitscan" radius.',
    }),
    perceptible_travel_time_threshold: Object.freeze({
      value: 40,
      unit: 'm',
      tol: Object.freeze({ abs: 15 }),
      title: 'MW2 2022 multiplayer and Black Ops 6 multiplayer',
      source: 'https://www.pcgamer.com/games/call-of-duty/black-ops-6-barrels-barely-do-anything/',
      confidence: 'corroborated',
      note: '30-60 m reported; 40 m used as the design number, +/-15 m spanning that disagreement without '
        + 'admitting a 100 m+ claim. Below this range travel time is imperceptible and velocity attachments '
        + 'measurably change nothing. Two independent framings, both reproduced under fresh phrasings: '
        + 'TheXclusiveAce MW2 testing found "no difference in time for bullets to land" with or without High '
        + 'Velocity ammo below 60 m (and most 6v6 sightlines are shorter than that), and a BO6 barrel analysis '
        + 'states "most guns are hitscan up to 30-40 meters ... ~90% of engagements". The 20 Hz formula '
        + 'independently predicts ~30-42 m for 590-850 m/s ARs, which is why the LOW end of the band is the safer '
        + 'design number.',
    }),
    penetration_class_hierarchy: Object.freeze({
      value: '3 tiers, ordered LMG > AR > SMG/pistol (snipers highest)',
      unit: 'ordered tiers',
      tol: null,
      title: 'Black Ops Cold War onward; same model in MW2 2022 / MW3 / BO6',
      source: 'https://callofduty.fandom.com/wiki/Surface_Penetration',
      confidence: 'corroborated',
      note: 'This is what "high/medium/low penetration" means mechanically: penetration strength is assigned by '
        + 'weapon CLASS, not tuned per gun. LMGs penetrate more than ARs, which penetrate more than SMGs. '
        + 'Reproduced from two directions — the Surface Penetration wiki ("penetration damage an LMG does through '
        + 'plywood is much higher than a pistol") and MW3 guidance recommending LMGs for penetration kills. One '
        + 'source claimed the system is "solely class-based"; the verifier found NO support for that stronger '
        + 'phrasing, so accept the hierarchy but not the absolute claim. An AR should sit mid-tier: through thin '
        + 'wood/drywall/glass/light props, stopped by brick, thick concrete and reinforced structures. TOLERANCE: '
        + 'the ordering must hold exactly; per-tier damage-retained values are unspecified, so any monotonic '
        + 'assignment passes — hence no machine tolerance.',
    }),
    penetration_damage_falloff_is_flat_not_thickness_scaled: Object.freeze({
      value: 1,
      unit: 'boolean (1 = flat percentage falloff, decoupled from thickness)',
      tol: Object.freeze({ abs: 0 }),
      title: 'Black Ops 7 Season 1 (current model; earlier titles scaled with penetrated distance)',
      source: 'https://insider-gaming.com/call-of-duty-black-ops-7-season-1-patch-notes-2025/',
      confidence: 'corroborated',
      note: 'As of Season 01, penetration damage and penetration distance are DECOUPLED. Each weapon still has a '
        + 'maximum thickness it can shoot through per surface type (a hard yes/no gate), but if the bullet gets '
        + 'through, the damage penalty is a single flat percentage regardless of thickness. Stated goals: '
        + 'consistency and predictability. Reproduced near-verbatim from the patch notes ("bullets that '
        + 'successfully penetrate now experience a flat percentage of damage falloff regardless of the distance '
        + 'penetrated"), explicitly contrasted with the old thickness-scaled behaviour. Implementation shape: '
        + 'per-material max-penetrable-thickness gate plus ONE flat damage multiplier, NOT per-centimetre '
        + 'attenuation — per-centimetre attenuation is a wrong implementation shape for the current model. The '
        + 'actual percentage is unpublished, so no damage-retained number is encoded.',
    }),
    fmj_attachment_effect: Object.freeze({
      value: 2,
      unit: 'count of required effects (raises max penetrable distance AND reduces penetration damage falloff)',
      tol: Object.freeze({ abs: 0 }),
      title: 'Black Ops 7 Season 1 (FMJ; earlier equivalent of the Deep Impact perk)',
      source: 'https://insider-gaming.com/call-of-duty-black-ops-7-season-1-patch-notes-2025/',
      confidence: 'corroborated',
      note: 'FMJ is the player-facing penetration modifier: it raises the thickness gate AND softens the flat '
        + 'damage penalty. Reproduced almost word-for-word ("FMJ will now increase distance penetrated as well as '
        + 'reduce the penetration damage falloff") and structurally consistent with the flat-falloff model in the '
        + 'adjacent key. Historically it filled the role of the Deep Impact perk plus cosmetic impact effects. '
        + 'TOLERANCE: both effects are required (hence the exact count of 2); magnitudes are unspecified, so any '
        + 'positive values pass.',
    }),
  }),

  damage: Object.freeze({
    m4a1_mw2019_max_damage: Object.freeze({
      value: 30,
      unit: 'HP per bullet',
      tol: Object.freeze({ abs: 0 }),
      title: 'Modern Warfare (2019)',
      source: 'https://callofduty.fandom.com/wiki/M4A1',
      confidence: 'corroborated',
      note: 'Flat 30 damage from 0 m to the near range stop. Exact integer, datamined value, no variation to '
        + 'absorb. Reproduced verbatim: "At any range short of 37.5 meters, the M4A1 will deal thirty damage per '
        + 'bullet." Sources report metres directly, no unit conversion needed. Caveat: both queries most likely '
        + 'surfaced the same Fandom M4A1 page, so this is two-query but arguably one-source corroboration.',
    }),
    m4a1_mw2019_near_range_stop: Object.freeze({
      value: 37.5,
      unit: 'm',
      tol: Object.freeze({ abs: 1 }),
      title: 'Modern Warfare (2019)',
      source: 'https://callofduty.fandom.com/wiki/M4A1',
      confidence: 'corroborated',
      note: 'End of the max-damage plateau. +/-1 m (~3%) absorbs unit-conversion rounding from game units, not a '
        + 'different value. 37.5 m = 1476 game units at CoD 1 unit = 1 inch (37.5 / 0.0254); the round-ish unit '
        + 'value supports a datamined range rather than an estimate. Independently reproduced twice as the end of '
        + 'the flat 30-damage plateau.',
    }),
    m4a1_mw2019_far_range_stop: Object.freeze({
      value: 50,
      unit: 'm',
      tol: Object.freeze({ abs: 1.5 }),
      title: 'Modern Warfare (2019)',
      source: 'https://callofduty.fandom.com/wiki/M4A1',
      confidence: 'corroborated',
      note: 'Start of the min-damage plateau; +/-1.5 m (~3%). Between 37.5 m and 50 m damage falls LINEARLY '
        + '30 -> 20. 50 m = 1969 game units at 1 unit = 1 inch. Independently reproduced: "Damage decreases '
        + 'linearly until fifty meters. At any range past fifty meters, the M4A1 deals twenty damage."',
    }),
    m4a1_mw2019_min_damage: Object.freeze({
      value: 20,
      unit: 'HP per bullet',
      tol: Object.freeze({ abs: 0 }),
      title: 'Modern Warfare (2019)',
      source: 'https://callofduty.fandom.com/wiki/M4A1',
      confidence: 'corroborated',
      note: 'Flat 20 damage from 50 m outward, unlimited range — there is no hard damage cutoff in CoD MP. Exact '
        + 'integer; reproduced in the same sentence as the 50 m stop.',
    }),
    m4a1_mw2019_stk_max_range: Object.freeze({
      value: 4,
      unit: 'shots',
      tol: Object.freeze({ abs: 0 }),
      title: 'Modern Warfare (2019)',
      source: 'https://callofduty.fandom.com/wiki/M4A1',
      confidence: 'corroborated',
      note: 'Body shots, 0 m to 37.5 m. Must be exactly 4 — any other STK inside 37.5 m is a failed '
        + 'implementation. Reproduced ("needing four shots to kill") and arithmetically closed by 4 x 30 = 120 '
        + '>= 100 HP while 3 x 30 = 90 < 100.',
    }),
    m4a1_mw2019_stk_min_range: Object.freeze({
      value: 5,
      unit: 'shots',
      tol: Object.freeze({ abs: 0 }),
      title: 'Modern Warfare (2019)',
      source: 'https://callofduty.fandom.com/wiki/M4A1',
      confidence: 'corroborated',
      note: 'Body shots beyond ~44 m and out to any range; must be exactly 5 beyond 50 m. Reproduced: past 50 m '
        + 'the M4A1 "deals twenty damage per bullet, needing five shots to kill." 5 x 20 = 100 exactly, so 5 STK '
        + 'holds forever.',
    }),
    m4a1_mw2019_rpm: Object.freeze({
      value: 682,
      unit: 'rounds per minute',
      tol: Object.freeze({ pct: 0.02 }),
      title: 'Modern Warfare (2019)',
      source: 'https://callofduty.fandom.com/wiki/M4A1',
      confidence: 'corroborated',
      note: '682 RPM = 87.98 ms between rounds. +/-2% is 13 RPM, equivalently about +/-2 ms on the 88.0 ms '
        + 'interval. Note the first query deliberately proposed 800 RPM and the results REJECTED it in favour of '
        + '682, and the verifier query explicitly rejected 700/900 and returned 682 tied with the Kilo 141 — '
        + 'stronger than a leading-question confirmation. See handling.m4a1_mw2019_fire_rate for the same figure '
        + 'with a looser cross-title-contamination band.',
    }),
    m4a1_mw2019_ttk_max_range: Object.freeze({
      value: 0.264,
      unit: 's',
      tol: Object.freeze({ abs: 0.025 }),
      title: 'Modern Warfare (2019)',
      source: 'https://callofduty.fandom.com/wiki/M4A1',
      confidence: 'derived',
      note: '264 ms, +/-25 ms (~10%), absorbing the first-bullet convention and the +/-2% RPM band. Arithmetic: '
        + '4 STK means 3 inter-shot gaps; 60000/682 = 87.98 ms per gap; 3 x 87.98 = 263.9 ms. The CoD TTK '
        + 'convention EXCLUDES the first bullet travel/instant hit, so TTK = (STK - 1) x interval. Cross-check: '
        + 'the same convention on the MW2 M4 (811 RPM, 4 STK) yields 3 x 73.98 = 222 ms against the '
        + 'independently published 221 ms, confirming the convention. Not published anywhere either pass found — '
        + 'it is the exact arithmetic consequence of two independently reproduced values.',
    }),
    m4a1_mw2019_ttk_min_range: Object.freeze({
      value: 0.352,
      unit: 's',
      tol: Object.freeze({ abs: 0.030 }),
      title: 'Modern Warfare (2019)',
      source: 'https://callofduty.fandom.com/wiki/M4A1',
      confidence: 'derived',
      note: '352 ms, +/-30 ms (~9%). Arithmetic: 5 STK = 4 gaps x 87.98 ms = 351.9 ms. So the TTK penalty for '
        + 'crossing the ~44 m STK edge is exactly one interval: +88 ms (+33%). Derived, not published — the '
        + 'kavogaming URL cited in the original research does not carry this number, which is why the Fandom '
        + 'M4A1 page (source of the 5 STK and 682 RPM inputs) is the source recorded here.',
    }),
    health_mw2019: Object.freeze({
      value: 100,
      unit: 'HP',
      tol: Object.freeze({ abs: 0 }),
      title: 'Modern Warfare (2019)',
      source: 'https://callofduty.fandom.com/wiki/M4A1',
      confidence: 'derived',
      note: 'Exact: 100 HP. Not stated directly for MW2019 in any single result, but pinned from two directions: '
        + '(a) MW3 coverage repeatedly frames 150 HP as "up from the 100 seen in previous installments", and '
        + '(b) the M4A1 profile only closes arithmetically at 100 HP — 4 x 30 = 120 >= 100 with 3 x 30 = 90 < 100 '
        + 'brackets it from above, and 5 x 20 = 100 is an exact fit that only works at 100.',
    }),
  }),
});

/**
 * Scope items this suite claims to care about, mapped to the targets that cover them.
 * An empty array means NO sourced target exists — see missing().
 * Refs are 'domain.key' and are validated by missing() so a typo cannot silently fake coverage.
 */
const SCOPE = Object.freeze({
  recoil_pattern: Object.freeze([
    'recoil.recoil_determinism',
    'recoil.recoil_randomness_magnitude_mw2_wz2',
    'recoil.view_kick_vs_gun_kick',
    'recoil.ads_bullet_spread_degrees',
  ]),
  recoil_recovery: Object.freeze([
    'recoil.recoil_recentering_behaviour',
    'recoil.gun_kick_oscillation_overshoot',
  ]),
  ads_transition: Object.freeze([
    'handling.m4_ads_time',
    'handling.mcw_ads_time',
    'handling.xm4_ads_time',
    'recoil.ads_idle_sway_onset_delay',
    'recoil.ads_idle_sway_rampup_to_peak',
  ]),
  sprint_to_fire: Object.freeze([
    'handling.mcw_sprint_to_fire_time',
    'handling.xm4_sprint_to_fire_time',
  ]),
  movement_acceleration: Object.freeze([]),
  air_control: Object.freeze([]),
  slide: Object.freeze([]),
  mantle: Object.freeze([]),
  bullet_velocity: Object.freeze([
    'ballistics.bullet_model_is_projectile_not_hitscan',
    'ballistics.ar_muzzle_velocity_mcw_mw3_2023',
    'ballistics.ar_muzzle_velocity_xm4_bo6',
    'ballistics.ar_muzzle_velocity_design_band',
    'ballistics.velocity_attachment_gain_twist_barrel',
    'ballistics.velocity_attachment_stacked_ceiling',
    'ballistics.instant_hit_range_formula_divisor',
    'ballistics.perceptible_travel_time_threshold',
  ]),
  bullet_drop: Object.freeze(['ballistics.bullet_gravity_drop_present']),
  penetration: Object.freeze([
    'ballistics.penetration_class_hierarchy',
    'ballistics.penetration_damage_falloff_is_flat_not_thickness_scaled',
    'ballistics.fmj_attachment_effect',
  ]),
  damage_falloff: Object.freeze([
    'damage.m4a1_mw2019_max_damage',
    'damage.m4a1_mw2019_near_range_stop',
    'damage.m4a1_mw2019_far_range_stop',
    'damage.m4a1_mw2019_min_damage',
  ]),
  hitbox_fidelity: Object.freeze([]),
  ttk_ranges: Object.freeze([
    'damage.m4a1_mw2019_stk_max_range',
    'damage.m4a1_mw2019_stk_min_range',
    'damage.m4a1_mw2019_ttk_max_range',
    'damage.m4a1_mw2019_ttk_min_range',
    'damage.health_mw2019',
  ]),
  ai_reaction: Object.freeze([]),
  ai_accuracy: Object.freeze([]),
  audio_latency: Object.freeze([]),
});

export const SCOPE_ITEMS = Object.freeze(Object.keys(SCOPE));

function get(domain, key) {
  const d = TARGETS[domain];
  if (!d) throw new Error(`targets: unknown domain '${domain}'`);
  const t = d[key];
  if (!t) throw new Error(`targets: unknown key '${domain}.${key}'`);
  return t;
}

/**
 * Compare a measured value against a target. Every test should call this instead of
 * re-implementing the tolerance maths.
 * @returns {{ok:boolean, target:(number|string|null), tol:Tol, measured:number,
 *            delta:(number|null), deltaPct:(number|null), reason:(string|undefined)}}
 */
export function inside(domain, key, measured) {
  const t = get(domain, key);
  const tol = t.tol ?? null;
  const target = t.value;
  const numericTarget = typeof target === 'number' && Number.isFinite(target);
  const delta = numericTarget && Number.isFinite(measured) ? measured - target : null;
  const deltaPct = delta !== null && target !== 0 ? delta / target : null;

  const base = { target, tol, measured, delta, deltaPct };

  if (!Number.isFinite(measured)) {
    return { ...base, ok: false, reason: 'measured value is not a finite number' };
  }
  if (tol === null) {
    return {
      ...base,
      ok: false,
      reason: `no machine-usable tolerance for ${domain}.${key} — this target is qualitative or `
        + 'unsourced; assert its behaviour explicitly in the test and read the note',
    };
  }
  if (typeof tol.min === 'number' && typeof tol.max === 'number') {
    return { ...base, ok: measured >= tol.min && measured <= tol.max };
  }
  if (!numericTarget) {
    return { ...base, ok: false, reason: `target ${domain}.${key} has no numeric value to compare against` };
  }
  if (typeof tol.abs === 'number') {
    return { ...base, ok: Math.abs(measured - target) <= tol.abs };
  }
  if (typeof tol.pct === 'number') {
    return { ...base, ok: Math.abs(measured - target) <= Math.abs(target) * tol.pct };
  }
  return { ...base, ok: false, reason: `malformed tolerance on ${domain}.${key}` };
}

/** One-line human string for test output, always including the source URL. */
export function describe(domain, key) {
  const t = get(domain, key);
  const tol = t.tol;
  let tolStr = 'no machine tolerance (qualitative)';
  if (tol && typeof tol.pct === 'number') tolStr = `+/-${(tol.pct * 100).toFixed(tol.pct * 100 % 1 ? 1 : 0)}%`;
  else if (tol && typeof tol.abs === 'number') tolStr = `+/-${tol.abs} ${t.unit}`;
  else if (tol && typeof tol.min === 'number') tolStr = `range ${tol.min}..${tol.max} ${t.unit}`;
  const val = t.value === null
    ? 'NO TARGET'
    : (typeof t.value === 'number' ? `${t.value} ${t.unit}` : String(t.value).slice(0, 80) + '...');
  return `${domain}.${key} = ${val} [${tolStr}] (${t.confidence}) — ${t.title} — ${t.source}`;
}

/**
 * Scope items with NO sourced target at all. Print this alongside results so the suite states its
 * own blind spots instead of implying full coverage. Throws if a SCOPE ref points at a target that
 * does not exist, so coverage cannot be faked by a typo.
 */
export function missing() {
  const out = [];
  for (const item of SCOPE_ITEMS) {
    const refs = SCOPE[item];
    for (const ref of refs) {
      const [domain, key] = ref.split('.');
      get(domain, key); // throws on a dangling ref
    }
    if (refs.length === 0) out.push(item);
  }
  return out;
}

/** Sourced-target count per domain, for coverage reporting. */
export function counts() {
  const out = {};
  for (const [domain, keys] of Object.entries(TARGETS)) out[domain] = Object.keys(keys).length;
  return out;
}

export { DEG };
