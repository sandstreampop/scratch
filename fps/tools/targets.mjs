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
//
// SECOND VERIFICATION PASS (merged below the original four domains). A second pass was necessary
// because the FIRST pass's verifiers ran out of search budget and returned roughly fifty values as
// "unverified" WITHOUT ever testing them — an untested value was being reported as a failed value,
// which understated coverage badly. A second set of verifiers re-queried those values with their own
// independently-phrased searches and reproduced them. Everything in the `movement`, `physics`,
// `audio`, `ai` domains, the `integrity` domain, and the MW3/BO6/MW2-2022 additions to `damage`
// arrived on that second pass.
//   'reproduced' (recorded here as confidence: 'corroborated') STILL MEANS ONLY THAT TWO
//   INDEPENDENT SEARCHES AGREED. No primary source was read on either pass; hosts returned 403
//   throughout. Do not read 'corroborated' as "verified against the shipping game".
// Where the second pass produced a value that DUPLICATES an existing key from a different title, the
// existing key was kept untouched and the new one added under a distinct, title-qualified name (for
// example damage.health_mw2019 vs damage.health_mw2_2022 vs damage.health_mw3 vs damage.health_bo6,
// and handling.xm4_base_movement_speed vs movement.base_walk_speed_legacy_iw). Two titles disagreeing
// is DATA — both stay, each labelled with its title. Never resolve a cross-title disagreement by
// deleting one side.
//
// SOURCING CLASSES. New entries carry an explicit `sourced` field, absent on first-pass entries
// (undefined === 'external'):
//   'external'      — an outside source (search-corroborated) states the figure. May still be
//                     non-CoD general literature; the title says so when that is the case.
//   'proxy-non-cod' — a number from a DIFFERENT game, recorded only as a placeholder anchor. Must
//                     never be cited as a Call of Duty value and never counts as coverage.
//   'internal'      — an invariant of THIS codebase, not a published figure. No external source
//                     exists or can exist. Does not count as an external/sourced target and does not
//                     count as scope coverage from research.
// missing() and counts() both respect these classes, so a proxy or an internal invariant cannot
// silently inflate coverage.

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

    // ---- second verification pass: MW2019 hit-location multipliers ----
    m4a1_mw2019_headshot_multiplier: Object.freeze({
      value: 1.4,
      unit: 'x (dimensionless)',
      tol: Object.freeze({ abs: 0.05 }),
      sourced: 'external',
      title: 'Modern Warfare (2019) — M4A1, and most weapons',
      source: 'https://callofduty.fandom.com/wiki/Damage_Multiplier',
      confidence: 'corroborated',
      note: '1.4x, accept 1.35-1.45. Independently phrased query returned the CoD Wiki Headshot/Damage Multiplier '
        + 'pages stating the headshot modifier is 1.4x for most MW2019 weapons and specifically for the M4A1, '
        + '"typical for most assault rifles", letting it kill in one fewer bullet at some ranges. Dimensionless, no '
        + 'unit conversion. SAFE AS AN AR DEFAULT, NOT AS A GLOBAL: it must NOT be applied to shotguns (1.0x) or to '
        + 'snipers and the M14 (1.5x) — see the three sibling keys.',
    }),
    mw2019_headshot_multiplier_sniper_rifles: Object.freeze({
      value: 1.5,
      unit: 'x (dimensionless)',
      tol: Object.freeze({ abs: 0.05 }),
      sourced: 'external',
      title: 'Modern Warfare (2019) — sniper rifles',
      source: 'https://callofduty.fandom.com/wiki/Damage_Multiplier',
      confidence: 'corroborated',
      note: 'Surfaced alongside the 1.4x general figure: sniper rifles use 1.5x in MW2019. Recorded because it '
        + 'BOUNDS the 1.4x value as an assault-rifle/general default rather than a universal constant.',
    }),
    mw2019_headshot_multiplier_shotguns: Object.freeze({
      value: 1.0,
      unit: 'x (dimensionless)',
      tol: Object.freeze({ abs: 0 }),
      sourced: 'external',
      title: 'Modern Warfare (2019) — shotguns',
      source: 'https://callofduty.fandom.com/wiki/Damage_Multiplier',
      confidence: 'corroborated',
      note: 'Exact 1.0 — shotguns receive NO headshot bonus in MW2019. An implementation that applies 1.4x '
        + 'globally is wrong for shotguns, hence the zero tolerance: 1.0 means exactly 1.0.',
    }),
    mw2019_m14_headshot_multiplier: Object.freeze({
      value: 1.5,
      unit: 'x (dimensionless)',
      tol: Object.freeze({ abs: 0.05 }),
      sourced: 'external',
      title: 'Modern Warfare (2019) — M14 marksman rifle',
      source: 'https://callofduty.fandom.com/wiki/Damage_Multiplier',
      confidence: 'corroborated',
      note: 'Named exception in the same source: the M14 uses 1.5x rather than the 1.4x default. Kept as its own '
        + 'key so a test can assert the exception list rather than a single blanket multiplier.',
    }),
    striker45_mw2019_falloff_range_stops: Object.freeze({
      value: '3 stops, stepwise: first falloff at 22.5 m, further and more severe reductions at 40 m and 50 m',
      unit: 'm (three range stops)',
      tol: null,
      sourced: 'external',
      title: 'Modern Warfare (2019) — Striker 45 SMG',
      source: 'https://zekevirant.medium.com/a-comparison-of-damage-falloff-in-pvp-fpss-7be74fbb131',
      confidence: 'corroborated',
      note: 'The concrete counter-example that drove the first pass to mark a generic two-stop falloff model as '
        + 'CONTRADICTED: the Striker 45 has THREE stops, not two. Already in metres in the source, no conversion. '
        + 'TOLERANCE: tol is null because the value is a list, not a scalar; assert each stop within +/-2 m and '
        + 'assert that the number of stops is 3 and the reductions are monotonic. Structural lesson for the port: '
        + 'the falloff table must support an arbitrary number of stops per weapon.',
    }),

    // ---- second verification pass: MW3 (2023) MCW damage profile ----
    // MW3 expresses damage internally as a base value x a per-zone multiplier, so the absolute
    // 44/37/34 triple below is DERIVED in-engine, not primitive. Both representations are kept.
    mcw_mw3_head_damage: Object.freeze({
      value: 44,
      unit: 'HP per bullet',
      tol: Object.freeze({ pct: 0.15 }),
      sourced: 'external',
      title: 'Modern Warfare III (2023) — MCW, launch-era',
      source: 'https://codmunity.gg/weapon/mw3/mcw',
      confidence: 'corroborated',
      note: '44 HP (37.4-50.6). A non-leading query returned the triple together: "head, upper, and lower torso '
        + 'damage of 44, 37, and 34 with a damage range of 26.7m, and a fire rate of 714.3 rpm". Ratio 44/37 = '
        + '1.19x, consistent with the separately reported 1.3x headshot / 1.1x upper-torso multipliers (1.3/1.1 = '
        + '1.18) — head/upper ratio should hold at 1.19x +/-0.12. That arithmetic self-consistency across two '
        + 'unrelated sources is the strongest evidence in this batch.',
    }),
    mcw_mw3_upper_torso_damage: Object.freeze({
      value: 37,
      unit: 'HP per bullet',
      tol: Object.freeze({ pct: 0.15 }),
      sourced: 'external',
      title: 'Modern Warfare III (2023) — MCW, launch-era',
      source: 'https://codmunity.gg/weapon/mw3/mcw',
      confidence: 'corroborated',
      note: '37 HP (31.5-42.5), and it must be STRICTLY BETWEEN the lower-torso and head values — assert the '
        + 'ordering as well as the number. Reproduced independently in the 44/37/34 triple. CAVEAT: a later balance '
        + 'patch set MCW max damage to 38 with upper and lower torso multipliers flattened to 1.0x, so post-patch '
        + 'all three torso zones converge near 38 and the strict ordering collapses to two zones. 37 is correct for '
        + 'launch and within tolerance of the patched value either way.',
    }),
    mcw_mw3_lower_torso_damage: Object.freeze({
      value: 34,
      unit: 'HP per bullet',
      tol: Object.freeze({ pct: 0.15 }),
      sourced: 'external',
      title: 'Modern Warfare III (2023) — MCW, launch-era',
      source: 'https://codmunity.gg/weapon/mw3/mcw',
      confidence: 'corroborated',
      note: '34 HP (28.9-39.1); lower/upper ratio 0.92x +/-0.10. Three distinct zones with separate absolute '
        + 'figures is corroborated for launch. Because the later patch flattened both torso multipliers to 1x, an '
        + 'implementation with lower == upper torso is DEFENSIBLE for post-patch MW3 — pin the season before '
        + 'treating a two-zone implementation as a failure.',
    }),
    mcw_mw3_mid_damage: Object.freeze({
      value: 26,
      unit: 'HP per bullet',
      tol: Object.freeze({ pct: 0.15 }),
      sourced: 'external',
      title: 'Modern Warfare III (2023) — MCW, near-mid range tier',
      source: 'https://codmunity.gg/weapon/mw3/mcw',
      confidence: 'corroborated',
      note: 'Near-mid damage tier, buffed from 24 to 26. Establishes that the MCW has at least THREE range tiers '
        + '(max / near-mid / min), not merely a plateau and a floor — same structural point as the Striker 45 '
        + 'three-stop falloff.',
    }),
    mcw_mw3_min_damage: Object.freeze({
      value: 21.5,
      unit: 'HP per bullet',
      tol: Object.freeze({ min: 16.8, max: 26.4 }),
      sourced: 'external',
      title: 'Modern Warfare III (2023) — MCW, minimum-damage floor',
      source: 'https://codmunity.gg/weapon/mw3/mcw',
      confidence: 'single-source',
      note: 'Reported as "21-22"; 21.5 is the midpoint of that stated pair and the band is the stated +/-20% on it '
        + '(16.8-26.4). GENUINELY UNSTABLE — one source shows conflicting patch history in both directions: min '
        + 'damage increased 20 -> 22 in one patch and decreased 24 -> 21 (-13%) in another. Do NOT treat as a '
        + 'constant. The useful invariant to test is RELATIVE: min damage is roughly 55-60% of max damage.',
    }),
    mcw_mw3_max_damage_post_buff: Object.freeze({
      value: 38,
      unit: 'HP per bullet',
      tol: Object.freeze({ pct: 0.10 }),
      sourced: 'external',
      title: 'Modern Warfare III (2023) — MCW, post-buff (Season 6-era)',
      source: 'https://sportskeeda.com/call-of-duty-game/all-weapon-balancing-changes-mw3-season-6',
      confidence: 'corroborated',
      note: '38 HP (34.2-41.8). Patch text: "Max Damage increased from 28 to 38, with Max Range increased from '
        + '31.8m to 34.3m. The Headshot multiplier was decreased from 1.3x to 1.27x, while Upper & Lower Torso '
        + 'multipliers decreased from 1.1x to 1x." Deliberately a SEPARATE key from the launch-era zone damages '
        + 'rather than an overwrite: launch and post-buff MCW are two different guns and both are recorded.',
    }),
    mcw_mw3_headshot_multiplier_launch: Object.freeze({
      value: 1.3,
      unit: 'multiplier on base damage',
      tol: Object.freeze({ abs: 0.05 }),
      sourced: 'external',
      title: 'Modern Warfare III (2023) — MCW at launch',
      source: 'https://sportskeeda.com/call-of-duty-game/all-weapon-balancing-changes-mw3-season-6',
      confidence: 'corroborated',
      note: 'The multiplier form is MORE DIRECTLY IMPLEMENTABLE than absolute per-zone damage, because that is how '
        + 'the engine stores it. Cross-checks against the absolute triple: 1.3/1.1 = 1.18 vs 44/37 = 1.19.',
    }),
    mcw_mw3_headshot_multiplier_post_buff: Object.freeze({
      value: 1.27,
      unit: 'multiplier on base damage',
      tol: Object.freeze({ abs: 0.05 }),
      sourced: 'external',
      title: 'Modern Warfare III (2023) — MCW after the max-damage buff',
      source: 'https://sportskeeda.com/call-of-duty-game/all-weapon-balancing-changes-mw3-season-6',
      confidence: 'corroborated',
      note: 'Headshot multiplier decreased 1.3x -> 1.27x in the same patch that raised max damage 28 -> 38 — the '
        + 'multiplier was trimmed to partly offset the base-damage buff. Kept separate from the launch value.',
    }),
    mcw_mw3_torso_multiplier_launch: Object.freeze({
      value: 1.1,
      unit: 'multiplier on base damage',
      tol: Object.freeze({ abs: 0.05 }),
      sourced: 'external',
      title: 'Modern Warfare III (2023) — MCW at launch, upper and lower torso',
      source: 'https://sportskeeda.com/call-of-duty-game/all-weapon-balancing-changes-mw3-season-6',
      confidence: 'corroborated',
      note: 'Upper and lower torso shared a single 1.1x multiplier at launch. NOTE THE TENSION with the distinct '
        + '37/34 launch figures: a single 1.1x cannot produce two different zone damages, which suggests the zones '
        + 'actually carried slightly different multipliers (roughly 1.1x and 1.01x on a 33-34 base) before the '
        + 'change. Both readings are recorded rather than reconciled by deletion.',
    }),
    mcw_mw3_torso_multiplier_post_buff: Object.freeze({
      value: 1.0,
      unit: 'multiplier on base damage',
      tol: Object.freeze({ abs: 0.05 }),
      sourced: 'external',
      title: 'Modern Warfare III (2023) — MCW after the max-damage buff',
      source: 'https://sportskeeda.com/call-of-duty-game/all-weapon-balancing-changes-mw3-season-6',
      confidence: 'corroborated',
      note: 'Both torso multipliers reduced to 1.0x. Consequence worth testing explicitly: late-season MW3 has '
        + 'effectively TWO hit zones (head and body), not three.',
    }),
    mcw_mw3_rpm: Object.freeze({
      value: 714.3,
      unit: 'rounds per minute',
      tol: Object.freeze({ pct: 0.03 }),
      sourced: 'external',
      title: 'Modern Warfare III (2023) — MCW',
      source: 'https://codmunity.gg/weapon/mw3/mcw',
      confidence: 'corroborated',
      note: '714.3 RPM (693-736). Reproduced verbatim in two separate searches (boostingfactory and codmunity). '
        + 'RPM is a hard-coded weapon constant and was not patch-varied for the MCW in anything either pass '
        + 'surfaced, hence the tight 3% band.',
    }),
    mcw_mw3_shot_interval: Object.freeze({
      value: 0.08399,
      unit: 's',
      tol: Object.freeze({ abs: 0.003 }),
      sourced: 'external',
      title: 'Modern Warfare III (2023) — MCW',
      source: 'https://codmunity.gg/weapon/mw3/mcw',
      confidence: 'derived',
      note: '84.0 ms +/-3 ms between rounds. Arithmetic: 60000 / 714.3 = 83.99 ms; inherits the RPM band. This is '
        + 'the quantum every MCW TTK claim must be an integer multiple of — see mcw_mw3_ttk, which is not.',
    }),
    mcw_mw3_near_range_stop: Object.freeze({
      value: 26.7,
      unit: 'm',
      tol: Object.freeze({ pct: 0.10 }),
      sourced: 'external',
      title: 'Modern Warfare III (2023) — MCW, LAUNCH patch',
      source: 'https://codmunity.gg/weapon/mw3/mcw',
      confidence: 'corroborated',
      note: '26.7 m (24.0-29.4) FOR LAUNCH BEHAVIOUR ONLY. Reproduced as "damage range of 26.7m" and corroborated '
        + 'by patch text giving the exact pre-patch figure: "Max Damage Range increased to 30.48 meters, up from '
        + '26.67". Conversion check: 26.67 / 0.0254 = 1050 game units (inches). A later patch note quotes 34.3 m, '
        + 'so this key is GENUINELY VERSION-DEPENDENT — the value is right but the version must be stated. If '
        + 'modelling any season after the max-damage-range buff, widen the acceptance band to 26.7-30.5 m and see '
        + 'mcw_mw3_max_damage_range_mid_patch.',
    }),
    mcw_mw3_max_damage_range_mid_patch: Object.freeze({
      value: 30.48,
      unit: 'm',
      tol: Object.freeze({ pct: 0.10 }),
      sourced: 'external',
      title: 'Modern Warfare III (2023) — MCW, after the first range buff (later 34.3 m)',
      source: 'https://codmunity.gg/weapon/mw3/mcw',
      confidence: 'corroborated',
      note: 'Intermediate max-damage range: "increased to 30.48 meters, up from 26.67", later raised again to '
        + '34.3 m. 30.48 m is EXACTLY 1200 inches / 100 ft, which is strong independent support for the 1 game '
        + 'unit = 1 inch = 0.0254 m convention this whole file assumes: these ranges are round numbers in inches, '
        + 'not in metres.',
    }),
    mcw_mw3_ttk: Object.freeze({
      value: 0.290,
      unit: 's',
      tol: Object.freeze({ pct: 0.20 }),
      sourced: 'external',
      title: 'Modern Warfare III (2023) — MCW (published figure, NOT simulable)',
      source: 'https://game8.co/games/Modern-Warfare-3/archives/435289',
      confidence: 'single-source',
      note: '290 ms, band deliberately loose at +/-20% (232-348 ms) to span the published 290, the AR category '
        + 'average ~310 and the arithmetically exact 336. TREAT WITH LESS CONFIDENCE THAN THE REST OF THIS BATCH: '
        + 'the second pass CONFIRMED the first pass FLAGGED INCONSISTENCY rather than clearing it. The non-leading '
        + 'TTK query did not return a per-weapon 290 ms for the MCW; it returned "ARs in MW3 have a time to kill of '
        + 'roughly 310 milliseconds" at 150 HP with the MCW described as faster than average. Arithmetic: at 150 HP '
        + 'and 37 upper-torso damage, STK = ceil(150/37) = 5 and TTK = 4 x 83.99 = 336 ms; an all-head 4-shot kill '
        + 'gives 3 x 83.99 = 252 ms. 290 ms sits between these and is NOT an integer multiple of the 84 ms '
        + 'interval, so it is almost certainly a mixed-hit-location or averaged marketing figure. RECOMMENDATION: '
        + 'implement TTK as (STK - 1) x interval and validate against the 232-348 ms band; do not hard-code 290.',
    }),
    ar_mw3_typical_ttk: Object.freeze({
      value: 0.310,
      unit: 's',
      tol: Object.freeze({ pct: 0.25 }),
      sourced: 'external',
      title: 'Modern Warfare III (2023) — assault rifle class average, core MP at 150 HP',
      source: 'https://game8.co/games/Modern-Warfare-3/archives/435289',
      confidence: 'corroborated',
      note: '310 ms (232-388 ms): "ARs in MW3 have a time to kill of roughly 310 milliseconds." A CLASS MEAN, not a '
        + 'weapon value — useful as a sanity envelope for any AR the harness models, and as the reference point '
        + 'against which the MCW claim of 290 ms should be judged (the MCW is described as faster than the class '
        + 'average, so a sub-310 figure is at least directionally right).',
    }),

    // ---- second verification pass: per-title base health. FOUR keys on purpose. ----
    // health_mw2019 (first pass, above) is 100. These three are separate titles, not replacements.
    health_mw2_2022: Object.freeze({
      value: 100,
      unit: 'HP',
      tol: Object.freeze({ abs: 0 }),
      sourced: 'external',
      title: 'Modern Warfare II (2022) — core multiplayer',
      source: 'https://www.charlieintel.com/call-of-duty/modern-warfare-3-increases-health-for-slower-ttk-than-mw2-266568/',
      confidence: 'corroborated',
      note: 'Exact 100 HP, no tolerance. Stated implicitly but unambiguously as the baseline MW3 departed from '
        + '("up from the 100 seen in the previous installment"). Needed to make the M4 4-shot-kill and 221 ms TTK '
        + 'figures close arithmetically — and they do: ceil(100/28) = 4.',
    }),
    health_mw3: Object.freeze({
      value: 150,
      unit: 'HP',
      tol: Object.freeze({ abs: 0 }),
      sourced: 'external',
      title: 'Modern Warfare III (2023) — core multiplayer (hardcore and other modes excluded)',
      source: 'https://www.charlieintel.com/call-of-duty/modern-warfare-3-increases-health-for-slower-ttk-than-mw2-266568/',
      confidence: 'corroborated',
      note: 'Exact 150 HP, no tolerance. Directly reproduced: "Modern Warfare 3 raised the base health up to 150 in '
        + 'multiplayer matches, up from the 100 seen in the previous installment." The development-history caveat '
        + 'is also confirmed: "Sledgehammer landed on giving each player 150 health points, but it took trial and '
        + 'error - and at one point even an armor system - to get right." WARNING WORTH PRESERVING: 150 is an '
        + 'MW3-ONLY OUTLIER and is NOT the CoD norm — every other title in this file is 100. Any TTK computed here '
        + 'must use the health value of the matching title.',
    }),
    health_bo6: Object.freeze({
      value: 100,
      unit: 'HP',
      tol: Object.freeze({ abs: 0 }),
      sourced: 'external',
      title: 'Black Ops 6 — core multiplayer (hardcore modes excluded)',
      source: 'https://callofduty.fandom.com/wiki/Health_System',
      confidence: 'corroborated',
      note: 'Exact 100 HP, no tolerance: "In Call of Duty: Black Ops 6, the health system returns to its 100 health '
        + 'bar", explicitly framed as a reversion from MW3. The verifying query surfaced both 100 and 150 and the '
        + 'results assigned them unambiguously — 100 to BO6, 150 to MW3 — so the two are cleanly separated rather '
        + 'than conflated.',
    }),

    // ---- second verification pass: MW2 (2022) M4, the TTK-formula calibration case ----
    m4_mw2_max_damage: Object.freeze({
      value: 28,
      unit: 'HP per bullet',
      tol: Object.freeze({ pct: 0.10 }),
      sourced: 'external',
      title: 'Modern Warfare II (2022) — M4',
      source: 'https://zilliongamer.com/modern-warfare-2/c/modern-warfare-2/m4-loadout',
      confidence: 'corroborated',
      note: '28 HP (25.2-30.8), flat across the plateau out to ~26 m. Reproduced: "the M4 deals 28 damage with a '
        + 'fire rate of 811 RPM, is a 4-shot assault rifle with an average time to kill of 221ms up to 26 meters". '
        + 'Self-consistency check passes: at MW2 100 HP, 28 damage gives ceil(100/28) = 4 shots, exactly the '
        + '"4-shot" classification in the same sentence. That internal agreement is what makes the value '
        + 'trustworthy independent of the source authority.',
    }),
    m4_mw2_ttk_max_range: Object.freeze({
      value: 0.221,
      unit: 's',
      tol: Object.freeze({ abs: 0.030 }),
      sourced: 'external',
      title: 'Modern Warfare II (2022) — M4, inside max-damage range',
      source: 'https://zilliongamer.com/modern-warfare-2/c/modern-warfare-2/m4-loadout',
      confidence: 'corroborated',
      note: '221 ms +/-30 ms. Reproduced verbatim ("average time to kill of 221ms up to 26 meters") alongside the '
        + '811 RPM and 28 damage in the same result. The (STK-1) x interval convention validates it exactly: '
        + '3 x (60000/811) = 3 x 73.98 = 221.9 ms vs published 221 ms, a 0.4% match. USE THIS AS THE CALIBRATION '
        + 'CASE for the TTK formula, and judge the MW3 290 ms figure against the formula rather than the reverse.',
    }),

    // ---- second verification pass: BO6 / BO4 assault-rifle TTK envelope ----
    bo6_average_assault_rifle_ttk: Object.freeze({
      value: null,
      unit: 's',
      tol: Object.freeze({ min: 0.280, max: 0.350 }),
      sourced: 'external',
      title: 'Black Ops 6 — assault rifle class average',
      source: 'https://www.dexerto.com/call-of-duty/black-ops-6-will-have-one-of-slowest-ttks-in-call-of-duty-history-2828733/',
      confidence: 'corroborated',
      note: 'A BAND (300-320 ms), so value is null and the tolerance IS the band, widened to 280-350 ms per the '
        + 'stated +/-40 ms. Reproduced: BO6 has the "third-slowest average TTK for an assault rifle at just over '
        + '300 ms", "almost identical to Black Ops Cold War and marginally slower than Modern Warfare 3". The '
        + 'RELATIVE claim is testable too: slower than MW3, roughly equal to Black Ops Cold War. CLASS MEAN ONLY — '
        + 'per-weapon spread inside the class is large (260 ms to ~400 ms).',
    }),
    bo6_fastest_assault_rifle_ttk: Object.freeze({
      value: 0.260,
      unit: 's',
      tol: Object.freeze({ abs: 0.020 }),
      sourced: 'external',
      title: 'Black Ops 6 — Goblin Mk2 (semi-auto), fastest AR TTK',
      source: 'https://www.dexerto.com/call-of-duty/fastest-time-to-kill-weapons-in-black-ops-6-ranked-2968079/',
      confidence: 'corroborated',
      note: '260 ms +/-20 ms. "The Goblin Mk2 has the fastest TTK of any assault rifle at 260 ms". PATCH-SENSITIVE '
        + '— re-check after any weapon balance update. Caveat confirmed: the record holder is SEMI-AUTO, so for '
        + 'anything modelled on a full-auto M4A1-class AR use bo6_fastest_full_auto_assault_rifle_ttk instead.',
    }),
    bo6_fastest_full_auto_assault_rifle_ttk: Object.freeze({
      value: 0.268,
      unit: 's',
      tol: Object.freeze({ abs: 0.020 }),
      sourced: 'external',
      title: 'Black Ops 6 — AS VAL, fastest full-auto AR TTK',
      source: 'https://www.dexerto.com/call-of-duty/fastest-time-to-kill-weapons-in-black-ops-6-ranked-2968079/',
      confidence: 'corroborated',
      note: '268 ms +/-20 ms. The better analogue than the semi-auto Goblin Mk2 (260 ms) for an M4A1-style '
        + 'full-auto AR, which is what this port models. Patch-sensitive.',
    }),
    bo4_slowest_assault_rifle_ttk: Object.freeze({
      value: 0.350,
      unit: 's',
      tol: Object.freeze({ min: 0.320, max: 0.400 }),
      sourced: 'external',
      title: 'Black Ops 4 — assault rifle class average (slowest in CoD history)',
      source: 'https://www.dexerto.com/call-of-duty/black-ops-6-will-have-one-of-slowest-ttks-in-call-of-duty-history-2828733/',
      confidence: 'corroborated',
      note: 'Reported as ">350 ms" — a LOWER BOUND, not a point value, which is why 0.350 is recorded with an '
        + 'explicit 320-400 ms window rather than a symmetric tolerance. Black Ops 4 holds the slowest average AR '
        + 'TTK in CoD history. Recorded as the UPPER BOUND of the CoD AR TTK design space: with BO6 fastest at '
        + '260 ms, the whole genre-plausible AR TTK envelope is roughly 260-400 ms.',
    }),
  }),

  /**
   * MOVEMENT SPEEDS — second verification pass.
   * Two eras coexist here and must not be averaged. The LEGACY IW-engine values are dvars in game
   * units (1 unit = 1 inch = 0.0254 m) and are moddable defaults, not physical constants. The MODERN
   * values are m/s figures lifted from MW3/Warzone Season 4 patch notes and are mostly WEAPON- or
   * KIT-SCOPED, not global player constants — the key names say which.
   */
  movement: Object.freeze({
    base_walk_speed_legacy_iw: Object.freeze({
      value: 4.83,
      unit: 'm/s',
      tol: Object.freeze({ pct: 0.08 }),
      sourced: 'external',
      title: 'Legacy IW-engine Call of Duty (g_speed 190 units/s) — fast/base movement class',
      source: 'https://wiki.zeroy.com/index.php/Call_of_Duty_:_A_Study_on_FPS',
      confidence: 'corroborated',
      note: '4.83 m/s, +/-8% (4.44-5.21 m/s), i.e. 190 in/s +/-15 in/s. An independent query returned the zeroy '
        + 'CoD Modding & Mapping Wiki "A Study on FPS" page, which states max forward ground speed is 190 units/s '
        + 'and that strafe is 20% lower and backward 30% lower ("190*0.8=159"); the 190 was corroborated a second '
        + 'time in a zeroy-targeted follow-up. CoD unit = 1 inch, so 190 x 0.0254 = 4.826 m/s. IMPORTANT SCOPE '
        + 'CAVEAT: the same 190 appears as an SMG/Trench-Gun CLASS speed rating in the CoD Wiki, so 190 is the '
        + 'fast/base class value, NOT a single global constant across all loadouts. Compare '
        + 'base_movement_speed_ar_bp50_mw3 (5.1 m/s) and handling.xm4_base_movement_speed (4.37 m/s) — three '
        + 'titles, three numbers, all kept.',
    }),
    strafe_speed_scale: Object.freeze({
      value: 0.8,
      unit: 'multiplier of base walk speed',
      tol: Object.freeze({ abs: 0.05 }),
      sourced: 'external',
      title: 'Legacy IW-engine Call of Duty (player_strafeSpeedScale dvar)',
      source: 'https://wiki.zeroy.com/index.php/Call_of_Duty_:_A_Study_on_FPS',
      confidence: 'corroborated',
      note: '0.8 (0.75-0.85). Double-corroborated: (1) dvar lists give player_strafeSpeedScale = 0.8; (2) zeroy '
        + 'independently states "strafe speed is 20% lower than forward speed - 190*0.8=159". At g_speed 190 that '
        + 'is 159 in/s = 4.04 m/s. This is the GROUND (non-sprint) strafe scale; the sprint equivalent is the '
        + 'separate sprint_strafe_speed_scale = 0.667. Was not in the first pass batch at all but is needed '
        + 'alongside backpedal_speed_scale for a complete ground velocity model.',
    }),
    backpedal_speed_scale: Object.freeze({
      value: 0.7,
      unit: 'multiplier of base walk speed',
      tol: Object.freeze({ abs: 0.05 }),
      sourced: 'external',
      title: 'Legacy IW-engine Call of Duty (player_backSpeedScale dvar)',
      source: 'https://www.se7ensins.com/forums/threads/cod-dvar-master-list.82819/',
      confidence: 'corroborated',
      note: '0.7 (0.65-0.75), from two independent sources: (1) a dvar-list query returned player_backSpeedScale = '
        + '0.7; (2) the zeroy "Study on FPS" page states backwards speed is 30% lower than forward, which is '
        + 'exactly 0.7. The double corroboration upgrades this from the first pass single shaky hit to solid. At '
        + 'g_speed 190 that is 133 in/s = 3.38 m/s.',
    }),
    sprint_speed_scale: Object.freeze({
      value: 1.5,
      unit: 'multiplier of base walk speed',
      tol: Object.freeze({ abs: 0.10 }),
      sourced: 'external',
      title: 'Legacy IW-engine Call of Duty (player_sprintSpeedScale dvar)',
      source: 'https://www.se7ensins.com/forums/threads/cod-dvar-master-list.82819/',
      confidence: 'corroborated',
      note: '1.5 (1.4-1.6). player_sprintSpeedScale = 1.5 returned again in an independent dvar-list query, and '
        + 'the MODERN data cross-checks it: 7.1 m/s tac sprint / 4.83 m/s base walk = 1.47, and the pre-nerf '
        + '7.7 / 4.83 = 1.59 — both bracket 1.5. Legacy arithmetic: 190 x 1.5 = 285 in/s = 7.24 m/s. Two eras '
        + 'agreeing on a ratio while disagreeing on absolutes is the most useful kind of corroboration here.',
    }),
    sprint_strafe_speed_scale: Object.freeze({
      value: 0.667,
      unit: 'multiplier of SPRINT speed (not of base walk)',
      tol: Object.freeze({ abs: 0.05 }),
      sourced: 'external',
      title: 'Legacy IW-engine Call of Duty (player_sprintStrafeSpeedScale dvar, CoD4/MW2 era)',
      source: 'https://www.se7ensins.com/forums/threads/cod-dvar-master-list.82819/',
      confidence: 'corroborated',
      note: '0.667 (0.62-0.72). Reproduced with a differently-phrased dvar query. NOTE THE BASE: it multiplies the '
        + 'SPRINT speed, not base walk — lateral sprint is 2/3 of forward sprint. It is a legacy IW-engine dvar and '
        + 'is moddable, so treat 0.667 as the shipped default rather than a hard physical constant.',
    }),
    sprint_speed_ar_bp50_mw3: Object.freeze({
      value: 5.8,
      unit: 'm/s',
      tol: Object.freeze({ pct: 0.15 }),
      sourced: 'external',
      title: 'MWIII / Warzone Season 4 — BP50 assault rifle, post-nerf sprint speed',
      source: 'https://www.dexerto.com/call-of-duty/modern-warfare-3-season-4-patch-notes-2747955/',
      confidence: 'corroborated',
      note: '5.8 m/s (4.9-6.7). Reproduced exactly: "The BP50\'s sprint speed was decreased from 6.2m/s to 5.8m/s '
        + '(-6%)". ATTRIBUTION CORRECTION to the first pass: 5.8 m/s is the BP50 WEAPON-SPECIFIC post-nerf sprint '
        + 'speed, NOT a general player sprint speed — hence the weapon-scoped key name. The same entry also gives '
        + 'base movement 5.5 -> 5.1 m/s and crouch 2.6 -> 2.4 m/s for that weapon. Use 5.8 as an AR-class sprint '
        + 'speed; a generic player sprint is probably somewhat higher.',
    }),
    base_movement_speed_ar_bp50_mw3: Object.freeze({
      value: 5.1,
      unit: 'm/s',
      tol: Object.freeze({ pct: 0.12 }),
      sourced: 'external',
      title: 'MWIII / Warzone Season 4 — BP50 assault rifle, post-nerf base movement speed',
      source: 'https://www.dexerto.com/call-of-duty/modern-warfare-3-season-4-patch-notes-2747955/',
      confidence: 'corroborated',
      note: '5.1 m/s (4.5-5.7). Surfaced while verifying sprint speed: the BP50 entry lists movement speed '
        + 'decreased from 5.5 m/s to 5.1 m/s (-7%). Useful as a MODERN-TITLE CROSS-CHECK on '
        + 'base_walk_speed_legacy_iw: 5.1 vs the legacy g_speed-derived 4.83 m/s, i.e. modern CoD walk speed is '
        + 'roughly 5-6% higher than the CoD4-era 190 in/s. CORRECTION: the first pass quoted this pair as '
        + '"5.0 -> 4.8" inside its tactical_sprint note; the second pass returned 5.5 -> 5.1, so that sub-line was '
        + 'wrong even though the tac-sprint numbers in the same entry were right.',
    }),
    tactical_sprint_speed_mw3: Object.freeze({
      value: 7.1,
      unit: 'm/s',
      tol: Object.freeze({ pct: 0.12 }),
      sourced: 'external',
      title: 'MWIII / Warzone Season 4 — tactical sprint (attribution disputed, see note)',
      source: 'https://www.callofduty.com/ca/en/patchnotes/2024/05/call-of-duty-modern-warfare-iii-season-4-patch-notes',
      confidence: 'corroborated',
      note: '7.1 m/s (6.3-8.0); the pre-nerf 7.7 m/s is the upper anchor. The 7.7 -> 7.1 (-8%) pair reproduced '
        + 'verbatim. ATTRIBUTION CAVEAT, kept deliberately: the verifying search rendered that pair as a WEAPON-KIT '
        + 'entry (JAK Revenger Kit) rather than a global movement change, while it rendered 7.0 -> 6.8 as the '
        + 'broader tactical-sprint change; secondary aggregators disagree about which line is "general". So treat '
        + '6.8-7.7 m/s as the credible tac-sprint band and 7.1 as a defensible mid value. Ratio sanity check: '
        + '7.1 / 4.83 base walk = 1.47, essentially the legacy player_sprintSpeedScale of 1.5.',
    }),
    tactical_sprint_speed_ar_bp50_mw3: Object.freeze({
      value: 6.8,
      unit: 'm/s',
      tol: Object.freeze({ pct: 0.10 }),
      sourced: 'external',
      title: 'MWIII / Warzone Season 4 — BP50 assault rifle, post-nerf tactical sprint',
      source: 'https://www.dexerto.com/call-of-duty/modern-warfare-3-season-4-patch-notes-2747955/',
      confidence: 'corroborated',
      note: '6.8 m/s (6.1-7.5). Directly reproduced: "the BP50\'s tactical sprint speed was decreased from 7m/s to '
        + '6.8m/s (-3%)". Same numbers, same weapon, same direction as the first pass claim. The BP50 is an assault '
        + 'rifle, so this is a legitimate AR-CLASS tac-sprint anchor and the better key to test an AR against than '
        + 'the disputed general figure.',
    }),
    crouch_speed_mw3: Object.freeze({
      value: 2.4,
      unit: 'm/s',
      tol: Object.freeze({ pct: 0.12 }),
      sourced: 'external',
      title: 'MWIII / Warzone Season 4 — crouch movement speed (general change)',
      source: 'https://www.callofduty.com/ca/en/patchnotes/2024/05/call-of-duty-modern-warfare-iii-season-4-patch-notes',
      confidence: 'corroborated',
      note: '2.4 m/s (2.1-2.7). THE MOST SOLID VALUE IN THIS BATCH: reproduced twice within the Season 4 searches '
        + '— once as a GENERAL movement change ("Decreased crouch movement speed from 2.6m/s to 2.4m/s (-8%)") and '
        + 'once inside the BP50 weapon entry with identical 2.6 -> 2.4 numbers. Ratio check: 2.4 / 4.83 = 0.50, '
        + 'i.e. crouch is about half of base walk, a plausible engine-level scale.',
    }),
    ads_movement_speed_mw3: Object.freeze({
      value: 3.1,
      unit: 'm/s',
      tol: Object.freeze({ pct: 0.12 }),
      sourced: 'external',
      title: 'MWIII / Warzone Season 4 — ADS movement speed (rendered as the JAK Revenger Kit entry)',
      source: 'https://www.callofduty.com/ca/en/patchnotes/2024/05/call-of-duty-modern-warfare-iii-season-4-patch-notes',
      confidence: 'corroborated',
      note: '3.1 m/s (2.7-3.5). Reproduced exactly: "Decreased ADS movement speed from 3.3m/s to 3.1m/s (-6%)". '
        + 'The verifying result attributed it to the kit entry rather than a global change, so it is a weapon/kit '
        + 'level value; still a valid ADS-strafe anchor. It CONFIRMS discarding the stray "5.1 m/s" ADS reading '
        + 'from the first pass — nothing near 5.1 appeared for ADS on either pass (5.1 is a BASE movement figure, '
        + 'see base_movement_speed_ar_bp50_mw3, which is probably where the error came from). Ratio check: '
        + '3.1 / 4.83 = 0.64 of base walk, consistent with typical CoD ADS penalties and with the BO6-derived '
        + 'handling.ads_movement_speed_fraction band of 0.57-0.67.',
    }),
    air_control: Object.freeze({
      value: 'near-zero physics-based air acceleration: mid-air direction change is scripted/input-driven '
        + '(jump-slide, dive rotation, wall-jump redirect), NOT continuous strafe acceleration. While airborne a '
        + 'CoD player can yaw the camera freely but CANNOT gain speed by strafing into the turn — no strafe-jump '
        + 'or bunnyhop speed gain — and lateral velocity authority mid-air is a small fraction of ground '
        + 'authority: target well under 10% of ground acceleration per tick.',
      unit: 'qualitative',
      tol: null,
      sourced: 'external',
      title: 'Call of Duty movement model, contrasted with Quake III / Source / Titanfall air strafing',
      source: 'https://arenafps.fandom.com/wiki/Air_Strafing',
      confidence: 'corroborated',
      note: 'NO NUMERIC sv_airaccelerate / g_airAccelerate default exists for CoD in anything either pass could '
        + 'reach. A dedicated query returned only Counter-Strike values (sv_airaccelerate 10, CS:GO/CS2 12), which '
        + 'MUST NOT be borrowed for CoD — that borrowing is the specific failure mode this entry exists to '
        + 'prevent. What IS corroborated is the BEHAVIOURAL claim, from the Arena FPS Wiki air-strafing entry plus '
        + 'CoD movement guides: air strafing as a momentum-gaining mechanic is documented for Quake III, '
        + 'Titanfall/Apex and Source, and CoD is explicitly contrasted as using "simpler directional redirects tied '
        + 'to button inputs rather than continuous acceleration mechanics". tol is null because the claim is '
        + 'qualitative; the value string above IS the testable spec — assert (a) no speed gain from any '
        + 'strafe-plus-turn input sequence while airborne, and (b) mid-air lateral acceleration < 10% of ground.',
    }),
  }),

  /**
   * MOVEMENT PHYSICS — second verification pass. Jump/gravity figures are LEGACY IW-engine dvar
   * defaults in game units (1 unit = 1 inch); slide figures are BO6 Season 03 patch notes; the tick
   * rate is core 6v6 multiplayer, NOT Warzone.
   */
  physics: Object.freeze({
    gravity: Object.freeze({
      value: 20.32,
      unit: 'm/s^2',
      tol: Object.freeze({ pct: 0.02 }),
      sourced: 'external',
      title: 'IW-engine Call of Duty titles (g_gravity / phys_gravity 800 units/s^2)',
      source: 'https://wiki.zeroy.com/index.php/Call_of_Duty_7:_Dvars_List',
      confidence: 'corroborated',
      note: '20.32 m/s^2, +/-2% (19.9-20.7), i.e. 800 game units/s^2 +/-15 units. An independent dvar-list query '
        + 'returned the gravity default as 800 (surfaced as phys_gravity -800 / g_gravity 800) across CoD4, WaW, '
        + 'MW2 and BO dvar dumps. Conversion: 800 x 0.0254 = 20.32 m/s^2, about 2.07x real g. CoD is NOT '
        + 'earth-gravity: using 9.81 will make every jump arc twice as floaty as the reference.',
    }),
    jump_height: Object.freeze({
      value: 0.991,
      unit: 'm',
      tol: Object.freeze({ pct: 0.05 }),
      sourced: 'external',
      title: 'IW/Treyarch Call of Duty (jump_height dvar default 39 units)',
      source: 'https://www.se7ensins.com/forums/threads/jump-height-value.345866/',
      confidence: 'corroborated',
      note: '0.991 m, +/-5% (0.94-1.04 m), i.e. 39 units +/-2. Independent search of CoD dvar/modding sources '
        + 'returned "the usual value for jump_height is 39" as the stock default (Se7enSins jump-height threads, '
        + 'UGX modding, zeroy CoD7 dvar list). 39 x 0.0254 = 0.9906 m apex ABOVE THE FEET. Scope caveat: this is '
        + 'the engine dvar default for the IW/Treyarch line, not a measured BO6 value.',
    }),
    jump_initial_velocity: Object.freeze({
      value: 6.345,
      unit: 'm/s',
      tol: Object.freeze({ pct: 0.05 }),
      sourced: 'external',
      title: 'IW/Treyarch Call of Duty — derived from jump_height 39 and gravity 800',
      source: 'https://wiki.zeroy.com/index.php/Call_of_Duty_7:_Dvars_List',
      confidence: 'derived',
      note: '6.345 m/s, +/-5% (6.03-6.66), i.e. 250 units/s +/-12. NOT QUOTED ANYWHERE — pure arithmetic on the '
        + 'two dvars that did reproduce, re-derived independently: v0 = sqrt(2*g*h) = sqrt(2*800*39) = sqrt(62400) '
        + '= 249.80 units/s = 6.345 m/s. "Corroborated" would be the wrong label: both INPUTS reproduced and the '
        + 'derivation checks out, but no source states 6.35 m/s.',
    }),
    jump_airtime: Object.freeze({
      value: 0.625,
      unit: 's',
      tol: Object.freeze({ abs: 0.030 }),
      sourced: 'external',
      title: 'IW/Treyarch Call of Duty — ballistic phase only, ground to ground',
      source: 'https://wiki.zeroy.com/index.php/Call_of_Duty_:_A_Study_on_FPS',
      confidence: 'derived',
      note: '0.625 s +/-30 ms (0.595-0.655 s). Re-derived: t = 2*v0/g = 2*249.80/800 = 0.6245 s total. Independent '
        + 'of the unit conversion (units cancel), so it depends only on the reproduced 39/800 pair. CAVEAT: real '
        + 'CoD airtime is slightly LONGER than the point-mass value because landing is detected at a foot offset '
        + 'and there is a brief landing-recovery state — treat 0.625 s as the BALLISTIC PHASE ONLY and do not '
        + 'assert it against an input-to-input-ready measurement.',
    }),
    jump_apex_time: Object.freeze({
      value: 0.312,
      unit: 's',
      tol: Object.freeze({ abs: 0.015 }),
      sourced: 'external',
      title: 'IW/Treyarch Call of Duty — time from leaving ground to apex',
      source: 'https://wiki.zeroy.com/index.php/Call_of_Duty_:_A_Study_on_FPS',
      confidence: 'derived',
      note: '0.312 s +/-15 ms, exactly half of jump_airtime (v0/g = 249.80/800 = 0.3122 s). Recorded as its own '
        + 'key because a harness can measure apex far more reliably than ground-to-ground contact, which is '
        + 'contaminated by the landing-recovery state described in jump_airtime.',
    }),
    multiplayer_server_tick_rate: Object.freeze({
      value: 60,
      unit: 'Hz',
      tol: Object.freeze({ pct: 0.15 }),
      sourced: 'external',
      title: 'Call of Duty core 6v6 multiplayer, MW2019 through BO6 (NOT Warzone)',
      source: 'https://steamcommunity.com/app/1938090/discussions/0/5350867208715596167/',
      confidence: 'corroborated',
      note: '60 Hz, +/-15% (50-70 Hz): both the 60 Hz nominal and 62 Hz beta measurements pass. An independently '
        + 'phrased query returned "Warzone runs up to ~20Hz tick rate, multiplayer up to 60hz tick rate, with '
        + 'variable tick rate depending on population/server load", plus a separate report that BO6 beta servers '
        + 'measured 62. DO NOT ACCEPT 20-30 Hz FOR CORE MP — 20 Hz is the Warzone/BR figure and is a genuinely '
        + 'different mode, not a contradiction (see ballistics.instant_hit_range_formula_divisor, which is built on '
        + 'the Warzone 20 Hz and must keep using 20). Note the "up to / load-dependent" qualifier: 60 Hz is a '
        + 'ceiling, not a guarantee.',
    }),
    slide_max_speed_scale: Object.freeze({
      value: 1.55,
      unit: 'multiplier of movement speed',
      tol: Object.freeze({ abs: 0.05 }),
      sourced: 'external',
      title: 'Black Ops 6 Season 03 (pre-Season-3 value was 1.60)',
      source: 'https://www.callofduty.com/patchnotes/2025/03/call-of-duty-black-ops-6-season-03-patch-notes',
      confidence: 'corroborated',
      note: '1.55 (1.50-1.60). An independent query against the BO6 Season 03 notes returned the exact line: slide '
        + 'max speed scale reduced from 1.6 to 1.55, corroborated by MP1ST/Dexerto/GameSpot Season 3 coverage. '
        + 'Either 1.55 or 1.60 passes if the title/season is not pinned. AMBIGUITY WORTH KEEPING: the patch notes '
        + 'do NOT say WHICH speed it multiplies (base walk vs sprint), so an implementation must state its choice '
        + 'and a test must not assume.',
    }),
    slide_max_duration: Object.freeze({
      value: 0.65,
      unit: 's',
      tol: Object.freeze({ abs: 0.050 }),
      sourced: 'external',
      title: 'Black Ops 6 Season 03 (pre-Season-3 value was 0.70 s)',
      source: 'https://www.callofduty.com/patchnotes/2025/03/call-of-duty-black-ops-6-season-03-patch-notes',
      confidence: 'corroborated',
      note: '0.65 s +/-50 ms (0.60-0.70 s); 0.70 s is the pre-Season-3 value and also passes if the season is '
        + 'unpinned. The same independent search returned "slide max time reduced from 0.7 to 0.65". 650 ms is the '
        + 'CAP on an uninterrupted slide, not the typical slide length — slides can be cancelled earlier, so assert '
        + 'it as a maximum and never as an expected duration.',
    }),
    mantle_duration: Object.freeze({
      value: null,
      unit: 's (would be; none published)',
      tol: null,
      sourced: 'external',
      title: 'Call of Duty mantle/climb duration — NOT FOUND for any CoD title',
      source: 'https://www.callofduty.com/patchnotes/2024/11/call-of-duty-bo6-warzone-season-01-patch-notes',
      confidence: 'single-source',
      note: 'EXPLICIT NEGATIVE RESULT, recorded so the next pass does not re-spend budget here. Three separate '
        + 'queries (technical animation-duration phrasing, patch-note phrasing, community-measurement phrasing) '
        + 'found NO numeric mantle duration for any Call of Duty. DO NOT write an acceptance criterion against a '
        + 'CoD mantle duration yet — hence value null and tol null. What IS corroborated QUALITATIVELY: mantle '
        + 'duration is a tunable Treyarch has changed — the 25 Nov 2024 BO6/Warzone update states players "can now '
        + 'mantle over high ledges or walls at an increased speed", and a later update states "all mantle speeds '
        + 'have been increased" (PLURAL), which implies several discrete mantle classes (low vault / mid / high '
        + 'wall) each with its own fixed animation speed, rather than one continuous height-scaled duration. So the '
        + 'testable structural claim is: MULTIPLE FIXED-LENGTH ANIMATIONS SELECTED BY LEDGE-HEIGHT BRACKET, not a '
        + 'single length and not a smooth function of height. Getting an actual number requires frame-counting '
        + 'gameplay video, not search.',
    }),
    mantle_duration_genre_proxy: Object.freeze({
      value: 0.5,
      unit: 's',
      tol: Object.freeze({ abs: 0.200 }),
      sourced: 'proxy-non-cod',
      title: 'Valve Deadlock mantle — SAME-GENRE PROXY ONLY, NOT Call of Duty',
      source: 'https://deadlock.wiki/Mantling',
      confidence: 'single-source',
      note: '0.5 s, 300-700 ms if used as a placeholder. The only hard mantle number corroborable for ANY modern '
        + 'shooter: in Deadlock the character pulls up over the ledge for around half a second, during which the '
        + 'player is NOT ACTIONABLE (fully animation-locked). Offered strictly as a placeholder anchor and as an '
        + 'argument that the CoD figure is in the few-hundred-ms range with an action lockout. MUST NEVER BE CITED '
        + 'AS A CALL OF DUTY VALUE — different engine, different game. sourced: proxy-non-cod, so it does not count '
        + 'as coverage in missing() and is excluded from the external target count.',
    }),
  }),

  /**
   * AUDIO / LATENCY — second verification pass. ALL NON-COD: these are general game-audio
   * engineering guidance, Web Audio API spec facts, an ITU broadcast standard and a physical
   * constant. No publisher figure for CoD audio latency exists. Durations in SECONDS as everywhere
   * else; the millisecond figure is in the note.
   */
  audio: Object.freeze({
    competitive_audio_latency_target: Object.freeze({
      value: 0.020,
      unit: 's',
      tol: Object.freeze({ abs: 0.005 }),
      sourced: 'external',
      title: 'General game-audio engineering guidance (non-CoD) — "imperceptible" tier boundary',
      source: 'https://www.gameslearningsociety.org/wiki/how-many-ms-latency-is-noticeable/',
      confidence: 'corroborated',
      note: '20 ms +/-5 ms: accept any target in 15-25 ms as the imperceptible-tier boundary. An independently '
        + 'phrased query returned the same guidance verbatim from multiple sources ("under 20 ms the delay is '
        + 'imperceptible to most people", "ideal audio latency should be under 20ms"), corroborated beyond the '
        + 'original Medium article (Games Learning Society, ultimatepctools, JBL). A DESIGN TARGET for '
        + 'input-to-sound, not a measured CoD figure.',
    }),
    competitive_audio_latency_ceiling: Object.freeze({
      value: 0.040,
      unit: 's',
      tol: Object.freeze({ abs: 0.010 }),
      sourced: 'external',
      title: 'General game-audio engineering guidance (non-CoD) — hard ceiling',
      source: 'https://www.gameslearningsociety.org/wiki/how-many-ms-latency-is-noticeable/',
      confidence: 'corroborated',
      note: '40 ms +/-10 ms: a hard ceiling anywhere in 30-50 ms is consistent with the literature. Reproduced '
        + 'independently: "absolutely never above 40ms" and "above 40 ms many users notice a disconnect between '
        + 'visual events and sounds", with 20-40 ms stated as the optimal band. The claim that 50-100 ms is only '
        + 'tolerable for casual play is consistent with the returned "anything under 100ms is acceptable for '
        + 'gaming" framing. SOFT GUIDANCE, not a hard spec.',
    }),
    audio_latency_noticeable_casual_player: Object.freeze({
      value: 0.025,
      unit: 's',
      tol: Object.freeze({ abs: 0.005 }),
      sourced: 'external',
      title: 'General game-audio guidance (non-CoD) — casual-player detection',
      source: 'https://www.gameslearningsociety.org/wiki/how-many-ms-latency-is-noticeable/',
      confidence: 'corroborated',
      note: '25 ms +/-5 ms. Exact phrasing reproduced from an independent query: "if your audio latency hits the '
        + '25ms+ range, even more casual players may notice that something is off". A second source in the same '
        + 'result set independently gave "anything above 25 milliseconds being easily detectable by human '
        + 'perception in competitive gaming environments", so 25 ms is corroborated from two directions rather '
        + 'than being a re-quote of one article.',
    }),
    audio_latency_expert_detection_threshold: Object.freeze({
      value: null,
      unit: 's',
      tol: Object.freeze({ min: 0.020, max: 0.025 }),
      sourced: 'external',
      title: 'General game-audio guidance (non-CoD) — professional-player detection band',
      source: 'https://soundhub.io/blog/gaming-headset-vs-headphones-latency/',
      confidence: 'corroborated',
      note: 'A BAND (20-25 ms), so value is null and the tolerance IS the band. The band must overlap 15-30 ms; '
        + 'REJECT any single threshold below 10 ms or above 40 ms. NARROWED BY THE SECOND PASS: the query '
        + 'reproduced "professional players may detect differences down to 20-25ms, especially in rhythm or FPS '
        + 'games" and "experienced players detect audio delays above 19-40ms while casual gamers might not notice '
        + 'delays under 50ms", but the 15 ms lower bound claimed on the first pass was NOT reproduced by any '
        + 'source, so it was dropped. A competing figure appeared — esports pros "target under 10 ms total audio '
        + 'latency" — but that is a TARGET, not a detection threshold, so it does not contradict. Popular-press '
        + 'sourcing throughout; no peer-reviewed psychoacoustic study located.',
    }),
    web_audio_outputlatency_wired: Object.freeze({
      value: null,
      unit: 's',
      tol: Object.freeze({ min: 0, max: 0.040 }),
      sourced: 'external',
      title: 'Web Audio API AudioContext.outputLatency, wired output (Firefox / Chrome measurements)',
      source: 'https://www.jamieonkeys.dev/posts/web-audio-api-output-latency/',
      confidence: 'corroborated',
      note: 'Claimed band 10-30 ms; encoded as 0-40 s-scaled (0 to 0.040 s) because of the caveat below, which '
        + 'matters more than the band. Independently reproduced measurements: outputLatency ~0.0154 s (15.4 ms) in '
        + 'Firefox and ~0.024 s (24 ms) in Chrome, both inside 10-30 ms. CAVEAT THE FIRST PASS ONLY HEDGED AT: '
        + 'with built-in speakers or wired headphones some platforms return outputLatency of EXACTLY 0, so 10 ms is '
        + 'NOT A FLOOR and an implementation must not assume a nonzero one. Bluetooth is a different regime '
        + 'entirely (~0.178 s measured) — see bluetooth_audio_latency_penalty. Platform- and device-dependent, not '
        + 'a constant.',
    }),
    web_audio_baselatency_interactive: Object.freeze({
      value: null,
      unit: 's',
      tol: Object.freeze({ min: 0.002, max: 0.004 }),
      sourced: 'external',
      title: 'Web Audio API AudioContext.baseLatency with latencyHint "interactive"',
      source: 'https://docs.w3cub.com/dom/audiocontext/baselatency',
      confidence: 'derived',
      note: 'A BAND (2-4 ms, +/-1.5 ms) that MUST BRACKET 2.67 ms (48 kHz) and 2.90 ms (44.1 kHz). Now DERIVABLE '
        + 'rather than anecdotal: the Web Audio spec fixes the render quantum at 128 sample frames and baseLatency '
        + 'is 128 / sampleRate — 128/44100 = 2.90 ms, 128/48000 = 2.67 ms. Search returned exactly this ("128 '
        + 'sample-frames which corresponds to roughly 3ms at 44.1 kHz", "baseLatency ... calculated as '
        + '128 / sampleRate x 1000 ms"). TWO CAVEATS: MDN own doc example prints 0.00 s for interactive (rounding, '
        + 'and some backends report 0), and the "playback" hint jumps to ~0.15 s — so 2-4 ms is HINT-SPECIFIC. The '
        + 'first pass claim that latencyHint 0 is floored at the hardware buffer is consistent with the spec text.',
    }),
    web_audio_render_quantum: Object.freeze({
      value: 128,
      unit: 'sample frames',
      tol: Object.freeze({ abs: 0 }),
      sourced: 'external',
      title: 'Web Audio API specification — render quantum',
      source: 'https://www.w3.org/TR/2018/CR-webaudio-20180918/',
      confidence: 'corroborated',
      note: 'EXACT, spec-fixed, no tolerance. Block size is 128 sample frames per spec; every '
        + 'AudioWorkletProcessor.process() call handles exactly 128 samples. This is what makes baseLatency '
        + 'COMPUTABLE (128/sampleRate) rather than something to look up, and it is the QUANTISATION FLOOR on any '
        + 'audio scheduling done from the web audio graph — about 2.67 ms at 48 kHz. No gunshot can be scheduled '
        + 'more precisely than this, which bounds every other number in this domain.',
    }),
    windows_wired_headset_total_audio_latency: Object.freeze({
      value: null,
      unit: 's',
      tol: Object.freeze({ min: 0.020, max: 0.040 }),
      sourced: 'external',
      title: 'Typical Windows gaming PC with a wired headset — total end-to-end audio latency (non-CoD)',
      source: 'https://www.gameslearningsociety.org/wiki/how-many-ms-latency-is-noticeable/',
      confidence: 'single-source',
      note: 'A BAND (20-40 ms, +/-15 ms): "the average total audio latency on a typical Windows gaming PC with a '
        + 'wired headset is around 20-40 ms". THE IMPORTANT IMPLICATION: this measured real-world baseline already '
        + 'sits AT OR ABOVE the 20 ms target and TOUCHES the 40 ms ceiling from the same literature, so the '
        + 'engine own audio budget must be well under 20 ms for the end-to-end figure to land in the target tier. '
        + 'Popular-press source, not instrumented — treat as order-of-magnitude.',
    }),
    bluetooth_audio_latency_penalty: Object.freeze({
      value: null,
      unit: 's',
      tol: Object.freeze({ min: 0.100, max: 0.300 }),
      sourced: 'external',
      title: 'Bluetooth output path (non-CoD, general)',
      source: 'https://www.gameslearningsociety.org/wiki/how-many-ms-latency-is-noticeable/',
      confidence: 'corroborated',
      note: 'A BAND (100-300 ms, +/-100 ms); any value under 60 ms should be treated as SUSPECT for a generic '
        + 'Bluetooth path. Surfaced twice from independent angles: "Bluetooth headsets routinely add 100-300 ms, '
        + 'creating a noticeable audio-visual desync that can affect gameplay", independently corroborated by a Web '
        + 'Audio measurement of outputLatency = 0.178 s on Bluetooth headphones versus ~0-24 ms wired. Relevant '
        + 'because it sits FAR ABOVE the 125 ms ITU detectability threshold: a Bluetooth output path will read as '
        + 'desynchronised no matter what the engine does. THE ENGINE CANNOT BUDGET ITS WAY OUT OF IT — do not fail '
        + 'a latency test that was run over Bluetooth.',
    }),
    av_desync_detectability_audio_lagging: Object.freeze({
      value: 0.125,
      unit: 's',
      tol: Object.freeze({ abs: 0.015 }),
      sourced: 'external',
      title: 'ITU-R BT.1359-1 Threshold of Detectability — audio LAGGING video',
      source: 'https://en.wikipedia.org/wiki/Audio_to_video_synchronization',
      confidence: 'corroborated',
      note: '125 ms. The value itself is EXACT (a standardised figure); the +/-15 ms only covers implementation '
        + 'rounding. BT.1359-1 defines the Threshold of Detectability as +45 ms to -125 ms, positive meaning audio '
        + 'PRECEDES video — so sound lagging picture is detectable at 125 ms. CAVEAT FOR USE AS A '
        + 'GUNSHOT/MUZZLE-FLASH CRITERION: the BT.1359 experiments used newsreader clips (speech with visible lip '
        + 'movement); a transient gunshot with a bright flash is likely a HARSHER stimulus, so 125 ms is a generous '
        + 'upper bound, NOT a per-frame budget.',
    }),
    av_desync_detectability_audio_leading: Object.freeze({
      value: 0.045,
      unit: 's',
      tol: Object.freeze({ abs: 0.015 }),
      sourced: 'external',
      title: 'ITU-R BT.1359-1 Threshold of Detectability — audio LEADING video',
      source: 'https://en.wikipedia.org/wiki/Audio_to_video_synchronization',
      confidence: 'corroborated',
      note: '45 ms, the companion half of the +45/-125 ms detectability pair. NOTE THE ASYMMETRY and reproduce it: '
        + 'audio arriving EARLY is detectable roughly 2.8x sooner than audio arriving late, because early sound is '
        + 'physically impossible in the real world while late sound is not. So a scheduling implementation should '
        + 'err on the side of LATE, never early.',
    }),
    av_desync_acceptability_audio_leading: Object.freeze({
      value: 0.090,
      unit: 's',
      tol: Object.freeze({ abs: 0.020 }),
      sourced: 'external',
      title: 'ITU-R BT.1359-1 Threshold of Acceptability — audio LEADING video',
      source: 'https://en.wikipedia.org/wiki/Audio_to_video_synchronization',
      confidence: 'corroborated',
      note: '90 ms. BT.1359-1 gives Acceptability as +90 ms to -190 ms versus Detectability at +45/-125 ms, i.e. '
        + 'roughly 1.5x looser. Both pairs are recorded deliberately: DETECTABILITY is the right bar for a '
        + 'competitive shooter, ACCEPTABILITY is the broadcast-tolerable bar. Same newsreader-stimulus caveat.',
    }),
    av_desync_acceptability_audio_lagging: Object.freeze({
      value: 0.190,
      unit: 's',
      tol: Object.freeze({ abs: 0.020 }),
      sourced: 'external',
      title: 'ITU-R BT.1359-1 Threshold of Acceptability — audio LAGGING video',
      source: 'https://en.wikipedia.org/wiki/Audio_to_video_synchronization',
      confidence: 'corroborated',
      note: '190 ms, the lagging half of the acceptability pair. Do NOT use this as the shooter target — it is the '
        + 'broadcast bar. Its value here is as the outer sanity limit: past 190 ms even a passive viewer objects.',
    }),
    speed_of_sound_air: Object.freeze({
      value: 343,
      unit: 'm/s',
      tol: Object.freeze({ abs: 2 }),
      sourced: 'external',
      title: 'Dry air at 20 C, sea level (physical constant, non-CoD)',
      source: 'https://ccrma.stanford.edu/~jos/pasp/Speed_Sound_Air.html',
      confidence: 'corroborated',
      note: '343 m/s, accept 341-345; REJECT the 330 m/s rounding for scheduling maths (~4% error). Reproduced on a '
        + 'second differently-phrased attempt as 343.2 m/s in dry air at 20 C, corroborated by Stanford CCRMA and '
        + 'the Physics Factbook, matching 1125 ft/s. Temperature-dependent — 343 is the 20 C reference, not a '
        + 'universal constant. FOR COD-UNIT PROPAGATION SCHEDULING: game units are inches, so 343 m/s = 13504 '
        + 'units/s, i.e. sound travels roughly 13.5 game units per millisecond.',
    }),
  }),

  /**
   * AI BEHAVIOUR — second verification pass. ALL NON-COD: these are general game-AI conventions from
   * Game AI Pro 2 chapter 5 (Rabin, "Agent Reaction Time") plus human reaction-time literature. No
   * published CoD bot reaction figure exists. Durations in SECONDS.
   */
  ai: Object.freeze({
    ai_reaction_delay_base: Object.freeze({
      value: 0.25,
      unit: 's',
      tol: Object.freeze({ abs: 0.05 }),
      sourced: 'external',
      title: 'Game AI Pro 2 ch.5 (general game-AI convention, NOT a CoD-measured constant)',
      source: 'https://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter05_Agent_Reaction_Time_How_Fast_Should_An_AI_React.pdf',
      confidence: 'corroborated',
      note: '0.25 s (0.20-0.30). An independent query returned this guidance exactly: "If an enemy AI is aware of '
        + 'the player\'s location, use a base delay of 0.25 seconds (250 ms)", anchored to the ~250 ms average '
        + 'human visual reaction time. CONFIRMED AS GENERAL CONVENTION, NOT A COD NUMBER — the first pass caveat '
        + 'is correct and must be preserved in any report that cites this.',
    }),
    ai_reaction_delay_range: Object.freeze({
      value: null,
      unit: 's',
      tol: Object.freeze({ min: 0.20, max: 0.40 }),
      sourced: 'external',
      title: 'Game AI Pro 2 ch.5 — recommended reaction-time band (non-CoD)',
      source: 'https://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter05_Agent_Reaction_Time_How_Fast_Should_An_AI_React.pdf',
      confidence: 'corroborated',
      note: 'A BAND, so value is null and the tolerance IS the band: any implemented delay inside 0.20-0.40 s '
        + 'passes, outside 0.15-0.50 s fails. Reproduced near-verbatim: "a recommended AI reaction time is '
        + 'somewhere between 0.2 and 0.4 seconds, possibly longer depending on context". The "possibly longer" '
        + 'qualifier is why the fail band is wider than the pass band.',
    }),
    ai_friend_foe_identification_delay: Object.freeze({
      value: 0.4,
      unit: 's',
      tol: Object.freeze({ abs: 0.075 }),
      sourced: 'external',
      title: 'Game AI Pro 2 ch.5 — go/no-go reaction time (non-CoD)',
      source: 'https://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter05_Agent_Reaction_Time_How_Fast_Should_An_AI_React.pdf',
      confidence: 'corroborated',
      note: '0.4 s (0.325-0.475). Reproduced: "For go/no-go reaction time (making a decision based on additional '
        + 'information, such as whether to shoot an enemy), this can average around 0.4 seconds." Exactly the '
        + 'documented EXTENSION of the 0.25 s base when friend/foe identification is required — so the '
        + 'implementation should apply 0.25 s when target identity is already known and 0.4 s when it is not, '
        + 'rather than one blended constant.',
    }),
    human_reaction_time_average_visual: Object.freeze({
      value: 0.250,
      unit: 's',
      tol: Object.freeze({ abs: 0.050 }),
      sourced: 'external',
      title: 'Untrained adults, simple visual reaction-time tests (non-CoD)',
      source: 'https://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter05_Agent_Reaction_Time_How_Fast_Should_An_AI_React.pdf',
      confidence: 'corroborated',
      note: '250 ms (200-300). Corroborated inside the Game AI Pro result text: "the average human reaction time '
        + 'for visual stimuli is about 250 ms", explicitly the anchor for the 0.25 s AI base delay. SIMPLE-RT '
        + '(single stimulus, single response), NOT go/no-go — go/no-go is the ~400 ms figure in '
        + 'ai_friend_foe_identification_delay. The same result gave ~230 ms for pro fighting-game players, a '
        + 'consistent ordering.',
    }),
    fighting_game_pro_reaction_delay: Object.freeze({
      value: 0.230,
      unit: 's',
      tol: Object.freeze({ abs: 0.030 }),
      sourced: 'external',
      title: 'Professional fighting-game players, cited in Game AI Pro / fighting-game AI literature (non-CoD)',
      source: 'https://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter05_Agent_Reaction_Time_How_Fast_Should_An_AI_React.pdf',
      confidence: 'corroborated',
      note: '230 ms +/-30 ms. An imposed 230 ms action delay is used to make game AI match average PROFESSIONAL '
        + 'human reaction time. It sits between the 250 ms untrained baseline and the ~150-190 ms FPS elite tail, '
        + 'so it is a reasonable "skilled but fair" bot delay — a sensible upper difficulty tier, with 0.25 s as '
        + 'the default tier.',
    }),
  }),

  /**
   * INTERNAL INVARIANTS — not research. Nothing in this domain has or can have an external source,
   * and nothing here counts toward external/sourced coverage (sourced: 'internal').
   */
  integrity: Object.freeze({
    hitbox_visible_mesh_hittable: Object.freeze({
      value: 0,
      unit: 'defects (visible character meshes that cannot be hit)',
      tol: Object.freeze({ abs: 0 }),
      sourced: 'internal',
      title: 'This codebase — hitbox/mesh correspondence invariant',
      source: 'internal invariant — no external source exists or can exist',
      confidence: 'internal-invariant',
      note: 'THERE IS NO EXTERNAL CALL OF DUTY NUMBER FOR THIS AND THERE NEVER WILL BE: no publisher documents '
        + 'hitbox-to-mesh correspondence, so searching harder cannot help and any figure claiming to be one would '
        + 'be fabricated. This is therefore stated as an INVARIANT OF THIS CODEBASE instead of a reference value: '
        + 'every mesh the player can SEE on a character must be HITTABLE. Required defect rate is exactly 0 — a '
        + 'visible-but-unhittable mesh is a defect BY CONSTRUCTION, because the player aimed at something the '
        + 'renderer drew and the simulation disagreed; no tolerance is meaningful for that class of bug. Testable '
        + 'form: enumerate every visible submesh of the character rig, cast a ray at each from a direction where it '
        + 'is unoccluded, and require a hit registration attributed to that character for every one; count of '
        + 'failures must be 0. The CONVERSE is deliberately NOT asserted here — hitboxes larger than the visible '
        + 'mesh are a normal and often intentional netcode/feel choice in shooters, so this invariant covers only '
        + 'visible-implies-hittable, not hittable-implies-visible. Because sourced is "internal", missing() still '
        + 'reports hitbox_fidelity as a research blind spot and counts() excludes this from the external target '
        + 'count. Do not "fix" that by relabelling it external.',
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
  // Still empty after the second pass: no acceleration/ramp-up figure (time or distance to reach
  // full walk or sprint speed) was found for any CoD title on either pass. The speed TARGETS exist
  // (movement.*), but nothing describes how quickly a player REACHES them.
  movement_acceleration: Object.freeze([]),
  air_control: Object.freeze(['movement.air_control']),
  slide: Object.freeze([
    'physics.slide_max_speed_scale',
    'physics.slide_max_duration',
  ]),
  // Both refs are non-covering on purpose: mantle_duration is an explicit NEGATIVE RESULT (value
  // null) and mantle_duration_genre_proxy is a non-CoD proxy. missing() therefore still reports
  // 'mantle'. The refs are listed anyway so the recorded negative result is discoverable from the
  // scope item rather than lost in the physics domain.
  mantle: Object.freeze([
    'physics.mantle_duration',
    'physics.mantle_duration_genre_proxy',
  ]),
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
    'damage.striker45_mw2019_falloff_range_stops',
    'damage.mcw_mw3_head_damage',
    'damage.mcw_mw3_upper_torso_damage',
    'damage.mcw_mw3_lower_torso_damage',
    'damage.mcw_mw3_mid_damage',
    'damage.mcw_mw3_min_damage',
    'damage.mcw_mw3_max_damage_post_buff',
    'damage.mcw_mw3_near_range_stop',
    'damage.mcw_mw3_max_damage_range_mid_patch',
    'damage.m4_mw2_max_damage',
    'damage.m4a1_mw2019_headshot_multiplier',
    'damage.mw2019_headshot_multiplier_sniper_rifles',
    'damage.mw2019_headshot_multiplier_shotguns',
    'damage.mw2019_m14_headshot_multiplier',
    'damage.mcw_mw3_headshot_multiplier_launch',
    'damage.mcw_mw3_headshot_multiplier_post_buff',
    'damage.mcw_mw3_torso_multiplier_launch',
    'damage.mcw_mw3_torso_multiplier_post_buff',
  ]),
  // The ONLY ref here is an internal invariant (sourced: 'internal'), so missing() still reports
  // hitbox_fidelity as a research blind spot — correctly. No publisher documents hitbox-to-mesh
  // correspondence, so external coverage of this item is not achievable, ever.
  hitbox_fidelity: Object.freeze(['integrity.hitbox_visible_mesh_hittable']),
  ttk_ranges: Object.freeze([
    'damage.m4a1_mw2019_stk_max_range',
    'damage.m4a1_mw2019_stk_min_range',
    'damage.m4a1_mw2019_ttk_max_range',
    'damage.m4a1_mw2019_ttk_min_range',
    'damage.health_mw2019',
    'damage.health_mw2_2022',
    'damage.health_mw3',
    'damage.health_bo6',
    'damage.mcw_mw3_rpm',
    'damage.mcw_mw3_shot_interval',
    'damage.mcw_mw3_ttk',
    'damage.ar_mw3_typical_ttk',
    'damage.m4_mw2_ttk_max_range',
    'damage.bo6_average_assault_rifle_ttk',
    'damage.bo6_fastest_assault_rifle_ttk',
    'damage.bo6_fastest_full_auto_assault_rifle_ttk',
    'damage.bo4_slowest_assault_rifle_ttk',
  ]),
  // Non-CoD general game-AI convention (Game AI Pro 2 ch.5) plus human reaction-time literature.
  // Covered, but the titles say "non-CoD" and any report citing these must repeat that.
  ai_reaction: Object.freeze([
    'ai.ai_reaction_delay_base',
    'ai.ai_reaction_delay_range',
    'ai.ai_friend_foe_identification_delay',
    'ai.human_reaction_time_average_visual',
    'ai.fighting_game_pro_reaction_delay',
  ]),
  // Still empty after the second pass: nothing on bot aim error, spread cone, tracking accuracy or
  // difficulty-scaled hit probability was found for any CoD title. Reaction TIMING is covered above;
  // reaction ACCURACY is not, and the two must not be conflated.
  ai_accuracy: Object.freeze([]),
  audio_latency: Object.freeze([
    'audio.competitive_audio_latency_target',
    'audio.competitive_audio_latency_ceiling',
    'audio.audio_latency_noticeable_casual_player',
    'audio.audio_latency_expert_detection_threshold',
    'audio.web_audio_outputlatency_wired',
    'audio.web_audio_baselatency_interactive',
    'audio.web_audio_render_quantum',
    'audio.windows_wired_headset_total_audio_latency',
    'audio.bluetooth_audio_latency_penalty',
    'audio.av_desync_detectability_audio_lagging',
    'audio.av_desync_detectability_audio_leading',
    'audio.av_desync_acceptability_audio_leading',
    'audio.av_desync_acceptability_audio_lagging',
    'audio.speed_of_sound_air',
  ]),
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
  const cls = sourcingClass(t);
  const clsStr = cls === 'external' ? '' : ` [${cls.toUpperCase()} — NOT an external CoD target]`;
  return `${domain}.${key} = ${val} [${tolStr}] (${t.confidence})${clsStr} — ${t.title} — ${t.source}`;
}

/** Sourcing class of a target. First-pass entries carry no `sourced` field and are external. */
function sourcingClass(t) {
  return t.sourced ?? 'external';
}

/**
 * Does this target actually COVER a scope item? Only an external source with a value does. This is
 * the rule that stops the file overstating itself in three specific ways:
 *   - a recorded NEGATIVE RESULT (value null, e.g. physics.mantle_duration) is not coverage;
 *   - a NON-COD PROXY (physics.mantle_duration_genre_proxy) is not coverage;
 *   - an INTERNAL INVARIANT (integrity.hitbox_visible_mesh_hittable) is not coverage from research.
 * A qualitative string value (e.g. movement.air_control) DOES count — a behavioural spec precise
 * enough to test is real coverage even with tol: null.
 */
function covers(t) {
  return sourcingClass(t) === 'external' && t.value !== null;
}

/**
 * Scope items with NO externally-sourced target at all. Print this alongside results so the suite
 * states its own blind spots instead of implying full coverage. Throws if a SCOPE ref points at a
 * target that does not exist, so coverage cannot be faked by a typo.
 *
 * After the second verification pass the list is: movement_acceleration and ai_accuracy (genuinely
 * nothing found), mantle (searched three ways, confirmed no published CoD figure; only a negative
 * result and a non-CoD proxy are recorded), and hitbox_fidelity (an internal invariant only — no
 * external source exists or can exist, so this one can never leave the list).
 */
export function missing() {
  const out = [];
  for (const item of SCOPE_ITEMS) {
    const refs = SCOPE[item];
    let covered = 0;
    for (const ref of refs) {
      const [domain, key] = ref.split('.');
      const t = get(domain, key); // throws on a dangling ref
      if (covers(t)) covered += 1;
    }
    if (covered === 0) out.push(item);
  }
  return out;
}

/**
 * Per-domain target counts, broken down by sourcing class so an internal invariant or a non-CoD
 * proxy cannot be mistaken for external research coverage. Returns
 * { [domain]: { total, external, proxy, internal, noValue, qualitative } } where:
 *   external    — externally sourced AND carrying a value (the honest "sourced target" count);
 *   proxy       — non-CoD placeholder anchors (excluded from external);
 *   internal    — invariants of this codebase (excluded from external);
 *   noValue     — value === null: recorded absences and band-only targets;
 *   qualitative — tol === null: assert the behaviour, not a number.
 * NOTE: this used to return a plain integer per domain. Callers that want the old number should read
 * counts()[domain].external, which is the figure worth reporting.
 */
export function counts() {
  const out = {};
  for (const [domain, keys] of Object.entries(TARGETS)) {
    const row = { total: 0, external: 0, proxy: 0, internal: 0, noValue: 0, qualitative: 0 };
    for (const t of Object.values(keys)) {
      row.total += 1;
      const cls = sourcingClass(t);
      if (cls === 'proxy-non-cod') row.proxy += 1;
      else if (cls === 'internal') row.internal += 1;
      if (covers(t)) row.external += 1;
      if (t.value === null) row.noValue += 1;
      if (t.tol === null) row.qualitative += 1;
    }
    out[domain] = row;
  }
  return out;
}

export { DEG };
