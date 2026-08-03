/* JK.Bots — stormtroopers + sith with scripted, readable, FUN AI.
 * Owner: bots agent (80_bots.js). Runs in 90_main's SYSTEMS slot 'Bots'
 * (after Powers, before Blaster/Hero/Fx), so a bot that fires this frame has
 * its bolt stepped the same frame and its damage resolved before Fx draws.
 *
 * ============================ WHAT A BOT IS ================================
 * Every bot IS its JK.Combat entity — one object, registered with team
 * 'enemy'. It carries the contract fields (pos/radius/height/hp/team/onHit)
 * plus onForce per the ITERATION 3+4 entity-force contract, plus its own
 * animation rig (JK.Rig.create — meshes are shared internally, instances are
 * cheap) and its AI scratch. Bot objects and their rigs are POOLED and
 * recycled on respawn, so after warm-up the module allocates nothing.
 *
 * ============================ STATE MACHINES ===============================
 * Shared (both archetypes):
 *   SPOT     0.5 s "he's here" beat. Troopers bark, sith IGNITE (saberOn).
 *   STAGGER  0.28 s recoil from lightning / a heavy hit.
 *   KNOCKED  1.8 s flat on their back (Force Push) -> GETUP.
 *   STUMBLE  0.9 s comedic face-plant (they trip while repositioning) -> GETUP.
 *   GETUP    0.5-0.7 s push back to their feet -> back to combat.
 *   LIFTED   Force Grip: gravity suspended, floats + thrashes, takes gripHold
 *            damage; gripRelease throws them.
 *   DEAD     2.0 s corpse: crumples, then sinks into the sand, then recycles.
 *
 * STORMTROOPER (hp 40, r 0.5, h 1.8, white plastoid over a black undersuit,
 *               saber off, rifle drawn here)
 *   IDLE ---player within 46 m---> SPOT ---> ADVANCE
 *   ADVANCE  run to 14 m --> FIRE.  Player > 85 m --> IDLE.
 *   FIRE     stand, raise rifle, bursts of 3 @ 0.13 s on a 1.5 s PERIOD (see
 *            BURST_GAP), per-burst lateral aim bias + per-shot spread (~4 deg)
 *            so they MISS a lot. Between bursts: dist > 18 --> ADVANCE,
 *            dist < 6.5 or a 42% roll --> REPOSITION.
 *   REPOSITION strafe around the player 0.9-1.6 s, STILL FIRING (the burst clock
 *            is shared, with 1.7x the aim error because he is moving); 18% of
 *            the time they trip --> STUMBLE. Ends --> FIRE mid-rest.
 *   FLEE     hp < 30% or 2 squadmates died within 6 s: sprint away, fire
 *            wildly backwards every ~0.45 s. After 5 s they find their nerve
 *            --> ADVANCE.
 *   DISARMED Force Pull: rifle is yanked out of their hands (it lies on the
 *            sand), they panic-run in a zig-zag for 2.5 s, then re-arm.
 *
 * SITH (hp 120, r 0.55, h 1.85, slate robe + crimson sash, red blade; one elite
 *       carries a staff)
 *   IDLE ---player within 55 m---> SPOT (ignite) ---> STALK
 *   STALK    circle-strafe the ring at 4.2 m, saber in guard. Timers fire:
 *            charge (1.4-2.4 s, needs the duel token) --> CHARGE,
 *            leap (6.5-10 s, 6-18 m) --> LEAP, push (9-15 s, 3.5-9.5 m) --> FPUSH.
 *   CHARGE   close to 2.2 m --> COMBO (2.5 s timeout --> STALK).
 *   COMBO    2-3 chained rig.playSwing arcs; the hero takes JK.Hero.hurt
 *            during each swing's active window (phase 0.25..0.72) if he is
 *            inside reach and in front. --> RECOVER.
 *   LEAP     force-jump arc toward the player (own gravity). Landing near -->
 *            COMBO, else --> CHARGE.
 *   FPUSH    0.45 s telegraph (arm out), then a Force Push on the hero.
 *   RECOVER  give up ~1.1 m + taunt flourish 0.85-1.25 s --> STALK.
 *
 * ============================ THE TWO FUN DIALS =============================
 * THE DUEL TOKEN. Only ONE sith may be closing or swinging at any moment; the
 * rest circle at sabre distance, taunt and throw the occasional Force Push.
 * Three sith attacking at once did 54 dps to a standing hero (dead in under
 * two seconds and unreadable); with the token it is 4.6 dps of saber damage from
 * a lone sith and 6.1 dps from the whole boot wave (measured against a hero who
 * never moves: 95 hp in 20.5 s, and 87 hp in 14.3 s), so the fight reads as a
 * duel with an audience, which is the JK2 feel.
 * The token is also why FPUSH_DMG matters so much: the sith who does NOT hold
 * the token has nothing to do but shove, and a shove the player cannot answer
 * was 30% of all damage taken in a measured session. It is a shove now, not an
 * attack — 5 damage, and the knockback is the point.
 *
 * THE MISS MODEL. A stormtrooper's per-burst aim error is a LATERAL DISTANCE
 * at the target (3 m), not an angle, and it is applied un-eased so it is
 * already full-strength on the first shot of the burst. Both details matter:
 * an angular error collapses at close range (76% accuracy measured at ~8 m),
 * and easing the error let the opening shot fly true while the aim converged.
 * With the lateral model a trooper is equally hopeless at every range: measured
 * over 60 s against a hero who never moves, 16 of 123 bolts landed (13%) and 12
 * more were deflected back at him by the hero's idle blade.
 *
 * ============================ API ==========================================
 *   JK.Bots.list        array of bot objects (live + corpses). Stable identity.
 *   JK.Bots.count()     number of LIVE bots (corpses excluded).
 *   JK.Bots.countKind(k) live count of 'trooper' | 'sith'.
 *   JK.Bots.wave        current target population (5 -> 9 as kills climb).
 *   JK.Bots.pending     reinforcements currently on their respawn timer.
 *   JK.Bots.spawn(kind, x, z) -> bot|null   ('trooper'|'sith'|'elite'; xz
 *                       optional — omit for a fresh point on the spawn ring)
 *   JK.Bots.clear()     unregister + recycle everything (tests).
 *   init() / update(dt,t) / draw()
 *
 * Budget: full AI + rig animation within 60 m of the player; beyond that a
 * cheap walk-toward-the-player step with a 10 Hz animation tick out to 110 m
 * and no animation at all past that. Past 55 m the whole figure is drawn as
 * ONE merged impostor mesh (1 call instead of ~20); past 175 m, or behind the
 * camera, nothing is drawn. Measured with nine bots in a brawl: 188 draw calls
 * and 0.13 ms of JS per frame. Zero per-frame allocations — pools, scratch
 * vectors, matrices and draw-option objects all live at module scope, and
 * JK.GL.mesh() is called five times total (rifle, muzzle flash, 3 impostors)
 * at init.
 */
(function(){
'use strict';
var M = JK.M;

/* ============================== tuning ============================== */
var GRAV       = 22;        /* m/s^2, matches the player */
var FULL_R     = 60;        /* m: full AI + full-rate animation */
var CHEAP_ANIM = 110;       /* m: 10 Hz animation out to here */
var IMPOSTOR_R = 55;        /* m: one-draw-call figure past this */
var DRAW_R     = 175;       /* m: draw cull */
var SEP_R      = 1.6;       /* m: bot-bot separation (contract) */
var MAX_BOTS   = 9;
var BASE_POP   = 5;         /* 3 troopers + 2 sith on boot */
var KILLS_PER  = 8;         /* +1 bot per this many kills */
var SPAWN_MIN  = 40, SPAWN_MAX = 70, SPAWN_CLEAR = 25;
var RESP_MIN   = 6, RESP_MAX = 9;
var TWO_PI     = Math.PI * 2;
var HALF_PI    = Math.PI * 0.5;

/* shared reaction states */
var KNOCK_T    = 1.8, GETUP_T = 0.62, STUMBLE_T = 0.9, STAGGER_T = 0.28;
var LIFT_H     = 1.55;      /* m above ground while gripped */
var DIE_T      = 2.0;       /* corpse lifetime */
var SPOT_T     = 0.5;

/* stormtrooper */
var TR_HP = 40, TR_R = 0.50, TR_H = 1.80;
var TR_SPOT = 46, TR_LOSE = 85;
var TR_RANGE = 14, TR_MIN = 6.5, TR_FAR = 18;
var TR_WALK = 3.6, TR_RUN = 6.2, TR_PANIC = 7.0;
/* THE BURST RHYTHM (contract: bursts of 3, 0.13 s apart, 1.5 s between bursts).
 * BURST_GAP is the burst PERIOD — first shot of one burst to the first shot of
 * the next — so the rhythm you hear is a burst every 1.5 s, i.e. 2 bolts/s from
 * an engaged trooper. BURST_REST is what is left over once the burst has spent
 * its own 0.05 + 2*0.13 s, and is derived, never hand-tuned.
 *
 * MEASURED BEFORE THIS: 1.00 bolts/s and a 3.04 s gap between bursts, from a
 * trooper that was in FIRE 66% of the time. Two things ate the missing half:
 *   1. the gap was counted from the LAST shot of the burst, so the real period
 *      was 0.05 + 0.26 + 1.50 = 1.81 s, not 1.50;
 *   2. REPOSITION was completely silent, and the trooper rolled into it after
 *      about half his bursts, adding a mean 1.6 s of dead air. That is the whole
 *      deficit: 1.81 + 0.8 = 2.6 s per burst against the contract's 1.5.
 * Now the burst clock runs in REPOSITION too — a strafing trooper keeps firing,
 * which is both the contract's rate and what a 2002 trooper actually does — and
 * the rest is derived from the period. */
var BURST_N = 3, BURST_DT = 0.13, BURST_GAP = 1.5;
var BURST_LEAD = 0.05;      /* s from entering a burst to the first shot */
var BURST_REST = BURST_GAP - (BURST_N - 1) * BURST_DT - BURST_LEAD;
var REPOS_P = 0.42;         /* chance of sidestepping instead of re-bursting */
var REPOS_MIN = 0.9, REPOS_MAX = 1.6;
var REPOS_MISS = 1.7;       /* aim error multiplier while shooting on the move */
var SHOT_SPREAD = 0.070;    /* rad, ~4 deg per shot (contract) */
/* Per-BURST aim bias, in METRES OF LATERAL MISS at the target — not radians.
 * An angular bias collapses at close range: the probe measured 76% accuracy
 * with a 7 deg bias because the troopers ended up 6-8 m away, where 7 deg is
 * only 0.8 m and the hero's capsule is 0.65 m wide. A constant lateral scatter
 * keeps stormtroopers equally hopeless at every distance, which is the joke. */
var AIM_MISS = 3.0;         /* m of horizontal scatter at the target */
var AIM_MISS_Y = 0.9;       /* m of vertical scatter */
var AIM_LEAD = 0.50;        /* fraction of the true lead they actually apply */
/* 4, not 9 — because the fire rate DOUBLED. Fixing the rate in isolation would
 * have undone the sith rebalance: at 9 damage and the new 2 bolts/s, the measured
 * bolt share of a 30 s casual session went from 9-27 hp to 36-42.
 * BE HONEST ABOUT WHAT THIS BUYS, THOUGH: it holds the damage FIRED per second
 * roughly level (9 x 1.0 = 9.0 -> 4 x 2.05 = 8.2), not the damage LANDED. One
 * trooper against a hero who stands still for 60 s, measured end to end on both
 * builds: 57 bolts / 4 hits / 36 hp before, 123 bolts / 16 hits / 64 hp after —
 * 0.60 dps becomes 1.07. Twice the noise and twice the light show for ~1.8x the
 * incoming damage, which a lone trooper can afford to be (100 hp, 4 hp/s regen)
 * and which the sith cuts more than pay for: an idle hero survives the boot wave
 * 14.3 s instead of 9.3. A full burst of three is 12 hp. */
var BOLT_DMG = 4, BOLT_SPD = 58;
var DISARM_T = 2.5;
var FLEE_T = 5.0, FLEE_HP = 0.30, SQUAD_WINDOW = 6.0;
var RIFLE_MUZZLE = 0.60;    /* m from the grip to the barrel tip */

/* ---------------------------------- sith ----------------------------------
 * THE DUEL, REBALANCED FOR A PHONE. Measured before: a scripted casual player
 * (thumb-speed camera, 0.30 s reaction, +/-14 deg aim error) fighting the real
 * boot wave for 30 s finished on 42, 9 and 6 hp out of 100. The damage ledger
 * said exactly where it came from — saber 41/78/67, force 18/18/18, BOLTS ZERO —
 * so the fight was decided entirely by sith blades landing 5-8 times at 11-15
 * damage, plus two free 9-damage shoves from the sith who was NOT duelling.
 *
 * The asymmetry, not a global multiplier, is what got fixed:
 *   damage per hit   11 -> 8 (elite 15 -> 11). A 3-swing combo that fully
 *                    connects costs 24 hp instead of 33: a quarter of your
 *                    health for being caught flat-footed, not a third.
 *   hit cooldown     0.5 -> 0.8 s. This is not a rate limit in practice (a sith
 *                    only lands 0.2-0.3 hits/s) — it caps the COMBO burst at two
 *                    landed hits instead of three, which is what killed people.
 *   front cone       0.25 -> 0.42 (75 -> 65 deg half-angle). Circling behind a
 *                    sith mid-swing now actually works, so footwork is rewarded.
 *   FPUSH damage     9 -> 5, cooldown 7-12 -> 9-15 s. The shove's job is the
 *                    knockback; at 9 damage from up to 11.5 m, off-screen, from
 *                    a sith you were not fighting, it was 30% of all damage
 *                    taken for no counterplay.
 *   hp               STAYS 120. It was cut to 100 here and put back: the frozen
 *                    ITERATION 3+4 contract says "SITH ... hp 120", and the cut
 *                    bought nothing worth breaking it for. Measured with a
 *                    scripted player who closes to blade reach and swings
 *                    (MEDIUM, 22 dmg, 0.22 s reaction, +/-6 deg aim error), three
 *                    runs each: at 100 hp the duel lasted 3.6-4.2 s and cost the
 *                    player 8 hp; at 120 hp it lasts 3.6-4.7 s and costs 0-11.
 *                    One extra swing is the whole difference — the sith was never
 *                    winning that fight on hit points, so trimming them only
 *                    softened him. The real fix for "the duel kills you" was the
 *                    per-hit damage, the hit cooldown and the RECOVER window
 *                    below, all of which are ours to tune and all of which stay.
 *   RECOVER          used to retreat at 3.5 m/s for 1.0-1.6 s, i.e. 3.5-5.6 m,
 *                    which deleted the player's counter-attack window every time
 *                    the sith finished a combo. It is a TAUNT: it now steps back
 *                    ~1 m and shows off in place, so the opening is real. This
 *                    raises player dps without touching the player's numbers.
 *   ring / chargeCd  5.0 -> 4.2 m and 1.8-3.2 -> 1.4-2.4 s: the sith spent 35-45%
 *                    of the duel orbiting at 5 m, outside saber reach, where the
 *                    player can only whiff. Closer and more committed means more
 *                    of the fight happens where BOTH blades can land.
 */
var SI_HP = 120, SI_R = 0.55, SI_H = 1.85;   /* contract: hp 120 (do not trim) */
var SI_SPOT = 55, SI_LOSE = 95;
var SI_RING = 4.2, SI_CLOSE = 2.2;   /* contract: charge closes to 2.2 m */
var SI_WALK = 4.4, SI_RUN = 7.2;
var SI_DMG = 8, SI_DMG_ELITE = 11;
var SI_HIT_CD = 0.8;        /* s between two landed saber hits from one bot */
var SI_REACH = 2.4, SI_REACH_ELITE = 2.8;  /* contract: hit inside 2.4 m */
var SI_FRONT = 0.42;        /* cos of the half-angle the hero must be inside */
var ACT0 = 0.25, ACT1 = 0.72;   /* swing damage window (phase) */
var FPUSH_DMG = 5;
var FPUSH_MAX = 11.5;       /* m: the shove is re-checked against this on landing */
var RECOVER_MIN = 0.85, RECOVER_MAX = 1.25;
var RECOVER_BACK = 1.1;     /* m of ground given up while taunting */

/* movement */
var ACC_GND = 26, ACC_AIR = 7;
var FRIC_GND = 9, FRIC_AIR = 0.35;
var TURN_SLOW = 5, TURN_FAST = 9;

/* ============================== palettes ============================
 * PAINTED FOR VALUE, NOT FOR HUE. The scene light is fixed and known:
 * sun (1.00, 0.92, 0.74) from (0.71, 0.573, 0.409), ambient (0.42, 0.36, 0.30),
 * and the shader is `lit = (amb + sun*max(dot(n,L),0)) * base`. So a box face
 * only ever gets one of a handful of multipliers, and a base colour maps onto a
 * KNOWN on-screen range:
 *
 *   face        R mult   G mult   B mult   luma mult
 *   sunward      1.13     1.01     0.83      1.02
 *   top          0.99     0.89     0.72      0.90
 *   shadow       0.42     0.36     0.30      0.37
 *
 * i.e. every base colour spans a 2.75:1 value range across the figure for free,
 * and multiplying a base by k moves the whole figure by k. Lit sand measures
 * luma 129-142/255, so THAT is the value everything is read against.
 *
 * The old sith was tunic 0.11 / pants 0.09 / boots 0.06: 0.37*0.11 = RGB 12 on
 * the shadow side and 1.13*0.11 = RGB 32 on the sunward side. A 20-step range
 * at the very bottom of the ramp is not "dark", it is a HOLE — measured mean
 * luma 41 with p05/p50/p95 = 11/20/120, which is a black cut-out with a face
 * floating on it. Fixed by giving each archetype a deliberate 5-value ramp:
 *
 *   SITH     hood 6-17 | legs 22-60 | robe 33-90 | crimson sash | face+hands
 *            90-240. The robe is a cool slate so it separates from warm sand by
 *            hue as well as value; the pale hands are the eye's anchor for where
 *            the blade is, and the sash puts a saturated crimson band on the
 *            waist so the torso never reads as one flat mass.
 *   ELITE    the same ramp in oxblood with a BRONZE sash instead of crimson, so
 *            the staff-carrying lord is a different silhouette AND a different
 *            colour from his apprentices at 40 m.
 *   TROOPER  white plastoid armour 83-255 over a near-black undersuit 28-77.
 *            The old trooper was 0.83-0.88 head to toe: mean luma 140 against
 *            sand at 142, i.e. contrast 0.007 — invisible. Bright plates over a
 *            dark undersuit make him bimodal, so whichever half of him is not
 *            matching the sand still carries the silhouette.
 */
/* WHITE ARMOUR NEEDS A BASE BRIGHTER THAN WHITE. The light is warm (sun
 * 1.00/0.92/0.74, ambient 0.42/0.36/0.30), so the blue channel can never exceed
 * 0.826 of its base while red reaches 1.13. Feed that light a neutral base and
 * plastoid comes out the same warm cream as the dune it is standing on: rendered
 * at 0.94 base the trooper read as BARE TAN SKIN in a screenshot — a shirtless
 * man in black trousers. Nothing clamps the palette (it is the tint uniform, and
 * only gl_FragColor saturates), so the fix is to pre-compensate: base blue 1.41x
 * base red exactly cancels the sun's warmth, and the armour renders neutral grey
 * 93 in shadow through 251 in the sun. THAT reads as white plastic on tan sand;
 * a warm cream does not, at any brightness. Measured on the screenshots (sampled
 * pixels, not palette arithmetic): mean chroma across the whole figure fell from
 * 42-50 to 8-26, and the fraction of figure pixels carrying a >= 30 luma step
 * against the sand went from 0.19-0.50 to 0.58-0.98 at 5/15/40 m.
 * DO NOT PUSH THESE BASES HIGHER. The sun is fixed in world space, so a
 * turntable at 12 m already clips: on the two camera bearings that show the
 * sunward flank, 43-45% of the figure's pixels sit at 250-255 on all three
 * channels (every face with dot(n,L) >= ~0.62 saturates), which costs the lit
 * side some of its internal shading. It still reads — that bearing has the
 * STRONGEST contrast of the eight, mean step 88-89 against sand 131-149 — but
 * there is no headroom left to spend. */
var PAL_TROOPER = {
  skin:  [0.93, 1.08, 1.30],   /* helmet shell + gloves — the brightest note */
  tunic: [0.87, 1.02, 1.23],   /* chest / back / shoulder + arm plates */
  pants: [0.26, 0.27, 0.34],   /* black undersuit: thighs + shins = structure */
  boots: [0.10, 0.10, 0.14],
  belt:  [0.09, 0.09, 0.13],   /* the utility belt boxes */
  hair:  [0.07, 0.07, 0.11]    /* helmet brow / lens band */
};
var PAL_SITH = {
  skin:  [0.86, 0.78, 0.73],   /* ashen face + bare hands: the lightest value */
  tunic: [0.32, 0.31, 0.44],   /* robe body + sleeves — dark cool slate */
  pants: [0.20, 0.20, 0.28],   /* robe skirt + legs, a step darker */
  boots: [0.12, 0.11, 0.14],
  belt:  [0.76, 0.10, 0.10],   /* crimson sash — the villain's accent */
  hair:  [0.07, 0.06, 0.09]    /* hood/cowl: darkest, frames the pale face */
};
var PAL_ELITE = {
  skin:  [0.90, 0.83, 0.79],
  tunic: [0.44, 0.14, 0.16],   /* oxblood robe */
  pants: [0.22, 0.13, 0.15],
  boots: [0.13, 0.11, 0.12],
  belt:  [0.86, 0.58, 0.14],   /* bronze sash: rank, and a warm mid-tone */
  hair:  [0.06, 0.05, 0.07]
};
var SABER_RED = [1.0, 0.16, 0.10];
var COL_TROOPER_FX = [0.95, 0.95, 1.0];
var COL_SITH_FX = [1.0, 0.30, 0.20];
var COL_ZAP = [0.65, 0.85, 1.0];        /* force-lightning arc sparks */
var COL_CLASH = [1.0, 0.50, 0.25];      /* sith blade landing on the hero */
var COL_SPAWN = [0.80, 0.85, 0.95];     /* trooper reinforcement shimmer */

/* ============================== swing defs ==========================
 * Same shape 50_sabers.js authors (rig.playSwing contract): keyframed
 * shoulder/elbow/wrist/torso angles + a forward lunge. */
function K(t, sp, sy, sr, el, wr, ty, tp, lunge){
  return { t: t, sp: sp, sy: sy, sr: sr, el: el, wr: wr, ty: ty, tp: tp,
           lunge: lunge || 0 };
}
function guard(t){ return K(t, 0.45, 0, 0.15, 0.60, -0.60, 0, 0.04, 0); }

var SITH_DEFS = [
  { name: 'SITH CROSS', dur: 0.52, keys: [
      guard(0),
      K(0.20, 1.05, -0.75, 1.05, 0.80, -0.80,  0.50, -0.05, 0),
      K(0.46, 0.95,  0.00, 0.45, 0.15, -0.10,  0.00,  0.08, 0.22),
      K(0.70, 0.80,  0.85,-0.35, 0.25,  0.30, -0.55,  0.12, 0),
      guard(1)
    ] },
  { name: 'SITH CHOP', dur: 0.58, keys: [
      K(0.00, 0.55, 0.00, 0.25, 0.85, -0.75,  0.10, -0.08, 0),
      K(0.30, 2.55,-0.15, 0.35, 0.95, -0.90,  0.15, -0.26, 0),
      K(0.60, 0.50, 0.00, 0.20, 0.10,  0.50, -0.05,  0.40, 0.45),
      guard(1)
    ] },
  { name: 'SITH RIP', dur: 0.50, keys: [
      K(0.00, 0.10,-0.30, 0.60, 0.50, -0.40,  0.30,  0.10, 0),
      K(0.26,-0.45,-0.55, 0.95, 0.65, -0.60,  0.48,  0.16, 0),
      K(0.58, 1.70, 0.60,-0.30, 0.30,  0.25, -0.45, -0.10, 0.20),
      guard(1)
    ] },
  { name: 'SITH FALL', dur: 0.56, keys: [
      guard(0),
      K(0.28, 2.10, 0.70,-0.40, 0.85, -0.90, -0.50, -0.15, 0),
      K(0.60,-0.25,-0.55, 1.00, 0.20,  0.45,  0.50,  0.30, 0.18),
      guard(1)
    ] }
];
/* taunt: a showy, harmless flourish played on RECOVER */
var TAUNT_DEF = { name: 'TAUNT', dur: 0.75, keys: [
  guard(0),
  K(0.25, 1.40, 0.85, -0.55, 1.30, -0.30, -0.35, 0.05, 0),
  K(0.55, 0.70,-0.85,  0.95, 1.10,  0.55,  0.40, 0.02, 0),
  guard(1)
] };

/* ============================== scratch ============================= */
var MTX = M.make();
var PLAIN = {};                      /* shared empty draw opts (no alloc) */
var FLASH_O = { emissive: 1, nofog: true };
var SND3 = [0, 0, 0];
var SNDO = { pos: SND3, vol: 1, rate: 1 };
var FX3 = [0, 0, 0];
var AIM3 = [0, 0, 0];
var DIR3 = [0, 0, 0];
var MUZ3 = [0, 0, 0];
var EMPTY = [];

/* ============================== helpers ============================= */
function groundY(x, z){
  var T = JK.Terrain;
  return (T && T.height) ? T.height(x, z) : 0;
}
function mix(a, b, w){ return a + (b - a) * w; }
function clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); }
function wrapPi(a){
  while (a > Math.PI) a -= TWO_PI;
  while (a < -Math.PI) a += TWO_PI;
  return a;
}
/* seeded PRNG (mulberry32) — deterministic runs, no Math.random churn */
var rndS = 0x5EED17;
function rnd(){
  rndS = (rndS + 0x6D2B79F5) | 0;
  var t = Math.imul(rndS ^ (rndS >>> 15), 1 | rndS);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function rrange(a, b){ return a + (b - a) * rnd(); }

function snd(name, x, y, z, vol){
  var A = JK.Audio;
  if (!A || !A.play) return;
  SND3[0] = x; SND3[1] = y; SND3[2] = z;
  SNDO.vol = vol === undefined ? 1 : vol;
  SNDO.rate = 1;
  A.play(name, SNDO);
}
function sndR(name, x, y, z, vol, rate){
  var A = JK.Audio;
  if (!A || !A.play) return;
  SND3[0] = x; SND3[1] = y; SND3[2] = z;
  SNDO.vol = vol === undefined ? 1 : vol;
  SNDO.rate = rate || 1;
  A.play(name, SNDO);
}
function sparksAt(x, y, z, n, col){
  var F = JK.Fx;
  if (!F || !F.sparks) return;
  FX3[0] = x; FX3[1] = y; FX3[2] = z;
  F.sparks(FX3, n, col);
}
function burstAt(x, y, z, n, col){
  var F = JK.Fx;
  if (!F || !F.burst) return;
  FX3[0] = x; FX3[1] = y; FX3[2] = z;
  F.burst(FX3, n, col);
}

function heroPos(){ return (JK.Player && JK.Player.pos) ? JK.Player.pos : null; }
function heroAttackable(){
  if (!JK.Player || !JK.Player.pos) return false;
  var H = JK.Hero;
  if (H && (H.dead || (H.invuln > 0))) return false;
  return true;
}
function hurtHero(dmg, dx, dy, dz, kind){
  var H = JK.Hero;
  if (H && H.hurt){ H.hurt(dmg, dx, dy, dz, kind); return true; }
  /* degraded: the hero entity module is missing — shove the player anyway */
  if (JK.Player && JK.Player.impulse) JK.Player.impulse(dx * 5, 2, dz * 5);
  return false;
}

/* ============================== meshes ============================== */
var rifleMesh = null, flashMesh = null;
var impostor = { trooper: null, sith: null, elite: null };
var TB = M.make();
function bb(sx, sy, sz, r, g, b, x, y, z){
  M.ident(TB); M.tr(TB, x, y, z);
  return JK.Geo.tf(JK.Geo.box(sx, sy, sz, r, g, b), TB);
}
/* Distant-bot impostor: the whole figure as ONE mesh (1 draw call instead of
 * ~20). Silhouette matches the rig's proportions so the LOD swap at 55 m is
 * invisible under the desert haze — very 2002. */
function buildImpostor(pal, blade, rifle){
  var parts = [
    bb(0.30, 0.90, 0.24, pal.pants[0], pal.pants[1], pal.pants[2], 0, 0.47, 0),
    bb(0.34, 0.14, 0.30, pal.boots[0], pal.boots[1], pal.boots[2], 0, 0.07, -0.02),
    bb(0.42, 0.56, 0.26, pal.tunic[0], pal.tunic[1], pal.tunic[2], 0, 1.20, 0),
    bb(0.60, 0.16, 0.24, pal.tunic[0], pal.tunic[1], pal.tunic[2], 0, 1.40, 0),
    bb(0.13, 0.52, 0.14, pal.tunic[0], pal.tunic[1], pal.tunic[2],  0.27, 1.14, 0),
    bb(0.13, 0.52, 0.14, pal.tunic[0], pal.tunic[1], pal.tunic[2], -0.27, 1.14, 0),
    bb(0.24, 0.27, 0.24, pal.skin[0], pal.skin[1], pal.skin[2], 0, 1.63, 0.01),
    bb(0.25, 0.09, 0.26, pal.hair[0], pal.hair[1], pal.hair[2], 0, 1.79, 0)
  ];
  if (blade)   /* a red bar where the blade would be: still reads as a sith */
    parts.push(bb(0.09, 1.25, 0.09, 1.0, 0.30, 0.22, 0.36, 1.85, -0.12));
  if (rifle)   /* a dark bar across the chest: still reads as "armed" */
    parts.push(bb(0.09, 0.09, 0.80, 0.14, 0.14, 0.16, 0.24, 1.24, -0.24));
  return JK.GL.mesh(JK.Geo.merge(parts));
}
function buildMeshes(){
  if (rifleMesh || !JK.GL || !JK.GL.mesh || !JK.Geo) return;
  var G = JK.Geo;
  impostor.trooper = buildImpostor(PAL_TROOPER, false, true);
  impostor.sith = buildImpostor(PAL_SITH, true, false);
  impostor.elite = buildImpostor(PAL_ELITE, true, false);
  /* E-11-ish carbine: points along -Z (the rig/player forward convention),
     origin at the grip so it can be hung off the hand. */
  rifleMesh = JK.GL.mesh(G.merge([
    bb(0.075, 0.100, 0.42, 0.14, 0.14, 0.16,  0,  0.000, -0.10),  /* receiver */
    bb(0.048, 0.048, 0.34, 0.10, 0.10, 0.12,  0,  0.005, -0.42),  /* barrel */
    bb(0.056, 0.078, 0.18, 0.17, 0.17, 0.19,  0, -0.010,  0.16),  /* stock */
    bb(0.034, 0.034, 0.15, 0.32, 0.33, 0.36,  0,  0.076, -0.13),  /* scope */
    bb(0.090, 0.022, 0.11, 0.21, 0.21, 0.24,  0,  0.056,  0.02),  /* rail */
    bb(0.050, 0.110, 0.055, 0.11, 0.11, 0.13, 0, -0.086,  0.02),  /* grip */
    bb(0.030, 0.030, 0.07, 0.55, 0.57, 0.60,  0,  0.005, -0.58)   /* emitter */
  ]));
  /* chunky 2002 muzzle flash: an opaque emissive cross (no blend state churn) */
  flashMesh = JK.GL.mesh(G.merge([
    bb(0.34, 0.08, 0.08, 1.00, 0.82, 0.42, 0, 0, 0),
    bb(0.08, 0.34, 0.08, 1.00, 0.82, 0.42, 0, 0, 0),
    bb(0.10, 0.10, 0.40, 1.00, 0.55, 0.22, 0, 0, -0.10)
  ]));
}

/* ============================== bot factory ========================= */
var list = [];
var pools = { trooper: [], sith: [], elite: [] };
var deathT = [-99, -99, -99, -99, -99, -99, -99, -99];
var deathI = 0;
var now = 0;
var eliteAlive = false;
var nextId = 1;

function makeBot(variant){
  var sith = (variant !== 'trooper');
  var b = {
    /* --- JK.Combat entity contract --- */
    pos: [0, 0, 0],
    radius: sith ? SI_R : TR_R,
    height: sith ? SI_H : TR_H,
    hp: sith ? SI_HP : TR_HP,
    team: 'enemy',
    onHit: botHit,
    onForce: botForce,
    /* --- identity --- */
    id: nextId++,
    kind: sith ? 'sith' : 'trooper',
    variant: variant,
    elite: variant === 'elite',
    hpMax: sith ? SI_HP : TR_HP,
    rig: null,
    registered: false,
    /* --- physics --- */
    vel: [0, 0, 0],
    dvx: 0, dvz: 0, noSteer: false,
    onGround: false,
    yaw: 0,
    dist: 999,
    anim: 'idle', speed2D: 0,
    /* --- state machine --- */
    state: 'IDLE', stT: 0, nextState: '',
    /* --- reaction weights (pose overrides) --- */
    downW: 0, downDir: 1, liftW: 0, stagW: 0, flash: 0,
    /* --- trooper --- */
    hasRifle: true, dropX: 0, dropZ: 0, dropYaw: 0,
    burstN: 0, burstT: 0, cycleT: 0, fleeCd: 0, reposT: 1.2,
    errLat: 0, errUp: 0,
    aimBlend: 0, recoil: 0, flashT: 0,
    aimYaw: 0, aimPitch: 0, aimYaw0: 0, aimPitch0: 0,
    gunYaw: 0, gunPitch: 0,
    rifleX: 0, rifleY: 0, rifleZ: 0,
    muzX: 0, muzY: 0, muzZ: 0,
    drewAt: -99,
    /* --- sith --- */
    comboLeft: 0, swingHit: false, hitCd: 0, defIdx: 0,
    chargeCd: 0, leapCd: 0, pushCd: 0, orbit: 1, flipCd: 0,
    /* --- misc --- */
    cheapAcc: 0, avoidT: 0, avoidSide: 1, stuckT: 0, lastX: 0, lastZ: 0,
    sparkAt: -99, jitAt: -99, dieDir: 1
  };
  var pal = variant === 'trooper' ? PAL_TROOPER
          : (variant === 'elite' ? PAL_ELITE : PAL_SITH);
  if (JK.Rig && JK.Rig.create){
    b.rig = JK.Rig.create(pal);
    if (b.rig.setType) b.rig.setType(variant === 'elite' ? 'staff' : 'single');
    if (b.rig.setSaber) b.rig.setSaber(SABER_RED, false);
  }
  return b;
}

function resetBot(b, x, z){
  b.pos[0] = x; b.pos[2] = z; b.pos[1] = groundY(x, z);
  b.vel[0] = b.vel[1] = b.vel[2] = 0;
  b.dvx = b.dvz = 0; b.noSteer = false;
  b.hp = b.hpMax;
  b.onGround = true;
  b.state = 'IDLE'; b.stT = 0; b.nextState = '';
  b.downW = 0; b.downDir = 1; b.liftW = 0; b.stagW = 0; b.flash = 0;
  b.hasRifle = true; b.burstN = 0; b.burstT = 0; b.cycleT = 0; b.fleeCd = 0;
  b.reposT = rrange(REPOS_MIN, REPOS_MAX);
  b.errLat = 0; b.errUp = 0; b.aimBlend = 0; b.recoil = 0; b.flashT = 0;
  b.comboLeft = 0; b.swingHit = false; b.hitCd = 0; b.defIdx = 0;
  b.chargeCd = rrange(1.3, 2.4);
  b.leapCd = rrange(4.0, 8.0);
  b.pushCd = rrange(7.0, 13.0);
  b.orbit = rnd() < 0.5 ? -1 : 1;
  b.flipCd = rrange(1.5, 3.0);
  b.cheapAcc = 0; b.avoidT = 0; b.stuckT = 0;
  b.lastX = x; b.lastZ = z; b.sparkAt = -99; b.jitAt = -99;
  b.speed2D = 0; b.anim = 'idle'; b.dist = 999;
  /* A recycled record must never claim it is still in the registry: if the
   * unregister on its previous death could not run, spawnVariant would push a
   * second reference and the pooled bot would leak into JK.Combat.ents. */
  b.registered = false;
  b.drewAt = -99;
  var P = JK.Player;
  b.yaw = P && P.pos ? Math.atan2(-(P.pos[0] - x), -(P.pos[2] - z)) : 0;
  b.aimYaw = b.aimYaw0 = b.yaw; b.aimPitch = b.aimPitch0 = 0;
  b.gunYaw = b.yaw; b.gunPitch = 0;
  b.rifleX = x; b.rifleY = b.pos[1] + 1.2; b.rifleZ = z;
  b.muzX = b.rifleX; b.muzY = b.rifleY; b.muzZ = b.rifleZ;
  if (b.rig){
    if (b.rig.setType) b.rig.setType(b.variant === 'elite' ? 'staff' : 'single');
    if (b.rig.setSaber) b.rig.setSaber(SABER_RED, false);
  }
  return b;
}

function obtain(variant){
  var p = pools[variant] || pools.sith;
  var b = p.length ? p.pop() : makeBot(variant);
  return b;
}
function recycle(b){
  var p = pools[b.variant];
  if (p && p.length < 8) p.push(b);
}

/* ============================== damage ============================== */
function isDown(b){
  var s = b.state;
  return s === 'KNOCKED' || s === 'LIFTED' || s === 'STUMBLE' ||
         s === 'GETUP' || s === 'DEAD';
}

function setState(b, s){
  b.state = s; b.stT = 0;
}

function die(b){
  if (b.state === 'DEAD') return;
  setState(b, 'DEAD');
  b.hp = 0;
  b.downW = 0; b.liftW = 0; b.stagW = 0;
  b.dieDir = (b.vel[0] * -Math.sin(b.yaw) + b.vel[2] * -Math.cos(b.yaw)) > 0 ? -1 : 1;
  var cx = b.pos[0], cy = b.pos[1] + b.height * 0.55, cz = b.pos[2];
  burstAt(cx, cy, cz, b.kind === 'sith' ? 22 : 16,
          b.kind === 'sith' ? COL_SITH_FX : COL_TROOPER_FX);
  sparksAt(cx, cy, cz, 12, null);
  snd('botDie', cx, cy, cz, 1);
  if (b.rig && b.rig.setSaber) b.rig.setSaber(null, false);
  if (b.registered && JK.Combat && JK.Combat.unregister) JK.Combat.unregister(b);
  b.registered = false;
  if (b.elite) eliteAlive = false;
  if (JK.game) JK.game.kills = (JK.game.kills || 0) + 1;
  deathT[deathI & 7] = now; deathI++;
  if (JK.msg && b.kind === 'sith') JK.msg(b.elite ? 'SITH LORD SLAIN' : 'SITH SLAIN', 1.3);
}

function squadDeaths(){
  var n = 0;
  for (var i = 0; i < 8; i++) if (now - deathT[i] <= SQUAD_WINDOW) n++;
  return n;
}

/* JK.Combat entity contract: onHit(dmg, dir3, kind, hitPos3) */
function botHit(dmg, dir, kind, hitPos){
  var b = this;
  if (b.state === 'DEAD' || !(dmg > 0)) return;
  b.hp -= dmg;
  b.flash = 1;
  var hx = hitPos ? hitPos[0] : b.pos[0];
  var hy = hitPos ? hitPos[1] : b.pos[1] + b.height * 0.6;
  var hz = hitPos ? hitPos[2] : b.pos[2];
  sparksAt(hx, hy, hz, kind === 'saber' ? 14 : 8, null);
  snd('hit', hx, hy, hz, 0.8);

  var dx = dir ? dir[0] : 0, dz = dir ? dir[2] : 0;
  var dl = Math.sqrt(dx * dx + dz * dz);
  if (dl > 1e-4){ dx /= dl; dz /= dl; } else { dx = 0; dz = 0; }
  var knock = 0;
  if (kind === 'saber') knock = (JK.Combat && JK.Combat.hitKnock) || 3;
  else if (kind === 'bolt') knock = 1.2;
  if (b.state !== 'LIFTED'){
    b.vel[0] += dx * knock * 0.85;
    b.vel[2] += dz * knock * 0.85;
    if (knock > 3 && b.onGround) b.vel[1] += 1.6;
  }
  if (b.hp <= 0){ die(b); return; }
  /* readable flinch: heavy saber blows and any bolt jolt the pose briefly */
  if (!isDown(b) && b.state !== 'STAGGER' && (kind === 'saber' || dmg >= 8)){
    b.nextState = combatState(b);
    setState(b, 'STAGGER');
    b.stagW = 0;
  }
}

/* Entity force contract: onForce(kind, dir3, power).
 * dir3 = unit direction FROM the caster TO this entity (reused — copy it). */
function botForce(kind, dir, power){
  var b = this;
  if (b.state === 'DEAD') return;
  var dx = dir ? dir[0] : 0, dy = dir ? dir[1] : 0, dz = dir ? dir[2] : 0;
  var dl = Math.sqrt(dx * dx + dz * dz);
  if (dl > 1e-4){ dx /= dl; dz /= dl; } else { dx = 0; dz = 1; }
  var p = (typeof power === 'number' && power === power) ? power : 0;
  var cx = b.pos[0], cy = b.pos[1] + b.height * 0.6, cz = b.pos[2];

  if (kind === 'push'){
    if (p < 1) p = 9;
    b.vel[0] += dx * p; b.vel[2] += dz * p;
    b.vel[1] = 4.2 + p * 0.18;
    b.onGround = false;
    b.downDir = 1;                       /* blown onto their back */
    setState(b, 'KNOCKED');
    b.liftW = 0; b.stagW = 0;
    sparksAt(cx, cy, cz, 10, null);
    if (b.kind === 'trooper') sndR('hurt', cx, cy, cz, 0.9, 1.25);
    return;
  }
  if (kind === 'pull'){
    if (p < 1) p = 7;
    b.vel[0] -= dx * p; b.vel[2] -= dz * p;   /* yanked toward the caster */
    b.vel[1] = 2.6;
    b.onGround = false;
    b.liftW = 0;
    if (b.kind === 'trooper' && b.hasRifle){
      /* the rifle is torn out of his hands and he loses his mind */
      b.hasRifle = false;
      b.dropX = cx - dx * 1.4; b.dropZ = cz - dz * 1.4;
      b.dropYaw = rnd() * TWO_PI;
      b.aimBlend = 0;
      setState(b, 'DISARMED');
      sndR('hurt', cx, cy, cz, 1, 1.35);
    } else {
      b.nextState = combatState(b);
      setState(b, 'STAGGER');
      b.stagW = 0;
    }
    sparksAt(cx, cy, cz, 8, null);
    return;
  }
  if (kind === 'grip'){
    setState(b, 'LIFTED');
    b.liftW = 0; b.downW = 0; b.stagW = 0;
    b.vel[0] *= 0.2; b.vel[2] *= 0.2; b.vel[1] = 0.5;
    b.onGround = false;
    sndR('hurt', cx, cy, cz, 0.7, 0.8);
    return;
  }
  if (kind === 'gripHold'){
    if (b.state !== 'LIFTED'){ setState(b, 'LIFTED'); b.liftW = 0; b.downW = 0; }
    b.stT = 0;                              /* stay lifted while channelled */
    if (p > 0){
      b.hp -= p;
      b.flash = 0.6;
      /* WALL-CLOCK gate, not a per-call one. onForce carries no dt, so the old
       * `sparkT -= 0.016` was a frame counter: measured 7.5 choke sparks/s at
       * 60 fps against 2.5/s at 20 fps for the same channel. */
      if (now - b.sparkAt >= 0.12){ b.sparkAt = now; sparksAt(cx, cy, cz, 3, null); }
      if (b.hp <= 0){ die(b); return; }
    }
    return;
  }
  if (kind === 'gripRelease'){
    if (p < 1) p = 12;
    b.vel[0] = dx * p; b.vel[2] = dz * p;
    b.vel[1] = 5.0;
    b.onGround = false;
    b.downDir = 1;
    b.liftW = 0;
    setState(b, 'KNOCKED');
    sparksAt(cx, cy, cz, 10, null);
    sndR('hurt', cx, cy, cz, 1, 0.9);
    return;
  }
  if (kind === 'lightning'){
    if (p > 0){
      b.hp -= p;
      b.flash = 1;
      if (now - b.sparkAt >= 0.09){ b.sparkAt = now; sparksAt(cx, cy, cz, 3, COL_ZAP); }
      if (b.hp <= 0){ die(b); return; }
    }
    if (!isDown(b)){
      if (b.state !== 'STAGGER'){ b.nextState = combatState(b); b.stagW = 0; }
      setState(b, 'STAGGER');
      b.stT = -0.12;                        /* refreshed while channelled */
    }
    /* Jitter: they judder in place under the arc. Also wall-clock gated — as a
     * raw per-call impulse this was a random walk whose step count scaled with
     * the framerate: measured mean judder speed 1.14 m/s at 60 fps against
     * 0.24 m/s at 20 fps, i.e. the same power looked five times angrier on a
     * fast phone. */
    if (now - b.jitAt >= 0.05){
      b.jitAt = now;
      b.vel[0] += (rnd() - 0.5) * 1.6;
      b.vel[2] += (rnd() - 0.5) * 1.6;
    }
    return;
  }
}

/* what a bot goes back to after a stagger/getup */
function combatState(b){
  if (b.kind === 'trooper'){
    if (!b.hasRifle) return 'DISARMED';
    if (b.hp < b.hpMax * FLEE_HP) return 'FLEE';
    return b.dist > TR_FAR ? 'ADVANCE' : 'FIRE';
  }
  return b.dist > SI_CLOSE + 1.5 ? 'STALK' : 'COMBO';
}

/* ============================== physics ============================= */
function physics(b, dt){
  var i;
  if (b.state === 'LIFTED'){
    /* gravity suspended: float to LIFT_H above the sand, drift damps out */
    var gy = groundY(b.pos[0], b.pos[2]);
    var want = gy + LIFT_H;
    b.pos[1] += (want - b.pos[1]) * (1 - Math.exp(-4 * dt));
    b.vel[0] *= Math.exp(-3 * dt);
    b.vel[2] *= Math.exp(-3 * dt);
    b.vel[1] = 0;
    b.pos[0] += b.vel[0] * dt;
    b.pos[2] += b.vel[2] * dt;
    b.onGround = false;
  } else {
    /* steer toward the desired horizontal velocity, or bleed off speed */
    if (!b.noSteer){
      var acc = (b.onGround ? ACC_GND : ACC_AIR) * dt;
      var ax = b.dvx - b.vel[0], az = b.dvz - b.vel[2];
      var al = Math.sqrt(ax * ax + az * az);
      if (al > 1e-6){
        if (acc >= al){ b.vel[0] = b.dvx; b.vel[2] = b.dvz; }
        else { b.vel[0] += ax / al * acc; b.vel[2] += az / al * acc; }
      }
    } else {
      var f = (b.onGround ? FRIC_GND : FRIC_AIR) * dt;
      var sp = Math.sqrt(b.vel[0] * b.vel[0] + b.vel[2] * b.vel[2]);
      if (sp > 1e-5){
        var k = sp - f; if (k < 0) k = 0;
        b.vel[0] *= k / sp; b.vel[2] *= k / sp;
      }
    }
    b.vel[1] -= GRAV * dt;
    if (b.vel[1] < -60) b.vel[1] = -60;
    b.pos[0] += b.vel[0] * dt;
    b.pos[1] += b.vel[1] * dt;
    b.pos[2] += b.vel[2] * dt;
  }

  /* world border */
  var S = (JK.Terrain && JK.Terrain.SIZE) || 350;
  if (b.pos[0] > S){ b.pos[0] = S; if (b.vel[0] > 0) b.vel[0] = 0; }
  else if (b.pos[0] < -S){ b.pos[0] = -S; if (b.vel[0] < 0) b.vel[0] = 0; }
  if (b.pos[2] > S){ b.pos[2] = S; if (b.vel[2] > 0) b.vel[2] = 0; }
  else if (b.pos[2] < -S){ b.pos[2] = -S; if (b.vel[2] < 0) b.vel[2] = 0; }

  /* obstacle pushout (same circles the player collides with) */
  var obs = (JK.Terrain && JK.Terrain.obstacles) || EMPTY;
  for (i = 0; i < obs.length; i++){
    var o = obs[i];
    var dx = b.pos[0] - o.x, dz = b.pos[2] - o.z;
    var rr = o.r + b.radius;
    var d2 = dx * dx + dz * dz;
    if (d2 < rr * rr){
      var dl = Math.sqrt(d2);
      var nx, nz;
      if (dl < 1e-4){ nx = 1; nz = 0; } else { nx = dx / dl; nz = dz / dl; }
      b.pos[0] = o.x + nx * rr;
      b.pos[2] = o.z + nz * rr;
      var vn = b.vel[0] * nx + b.vel[2] * nz;
      if (vn < 0){ b.vel[0] -= vn * nx; b.vel[2] -= vn * nz; }
    }
  }

  /* ground follow */
  if (b.state !== 'LIFTED'){
    var g = groundY(b.pos[0], b.pos[2]);
    if (b.pos[1] <= g){
      b.pos[1] = g;
      if (b.vel[1] < 0){
        if (!b.onGround && b.vel[1] < -9) snd('land', b.pos[0], g, b.pos[2], 0.5);
        b.vel[1] = 0;
      }
      b.onGround = true;
    } else if (b.onGround && b.pos[1] - g < 0.55 && b.vel[1] <= 0){
      b.pos[1] = g;                      /* glue to downhill slopes */
      b.vel[1] = 0;
    } else {
      b.onGround = false;
    }
  }

  if (!(b.pos[0] === b.pos[0])) b.pos[0] = 0;   /* NaN guards: never leak one */
  if (!(b.pos[1] === b.pos[1])) b.pos[1] = groundY(b.pos[0], b.pos[2]);
  if (!(b.pos[2] === b.pos[2])) b.pos[2] = 0;
  if (!(b.vel[0] === b.vel[0])) b.vel[0] = 0;
  if (!(b.vel[1] === b.vel[1])) b.vel[1] = 0;
  if (!(b.vel[2] === b.vel[2])) b.vel[2] = 0;

  b.speed2D = Math.sqrt(b.vel[0] * b.vel[0] + b.vel[2] * b.vel[2]);
}

function separate(){
  var i, j;
  var P = JK.Player;
  for (i = 0; i < list.length; i++){
    var a = list[i];
    if (a.state === 'DEAD' || a.state === 'LIFTED') continue;
    for (j = i + 1; j < list.length; j++){
      var b = list[j];
      if (b.state === 'DEAD' || b.state === 'LIFTED') continue;
      var dx = b.pos[0] - a.pos[0], dz = b.pos[2] - a.pos[2];
      var d2 = dx * dx + dz * dz;
      if (d2 >= SEP_R * SEP_R || d2 < 1e-8){
        if (d2 < 1e-8){ b.pos[0] += 0.05; }   /* exact overlap: nudge */
        continue;
      }
      var d = Math.sqrt(d2);
      var push = (SEP_R - d) * 0.5;
      var nx = dx / d, nz = dz / d;
      a.pos[0] -= nx * push; a.pos[2] -= nz * push;
      b.pos[0] += nx * push; b.pos[2] += nz * push;
    }
    /* don't stand inside the player either */
    if (P && P.pos){
      var px = a.pos[0] - P.pos[0], pz = a.pos[2] - P.pos[2];
      var rr = a.radius + 0.55;
      var p2 = px * px + pz * pz;
      if (p2 < rr * rr && p2 > 1e-8){
        var pl = Math.sqrt(p2);
        a.pos[0] = P.pos[0] + px / pl * rr;
        a.pos[2] = P.pos[2] + pz / pl * rr;
      }
    }
  }
}

/* ============================== steering ============================ */
/* set the desired velocity toward (tx,tz) at spd; returns the distance */
function seek(b, tx, tz, spd){
  var dx = tx - b.pos[0], dz = tz - b.pos[2];
  var l = Math.sqrt(dx * dx + dz * dz);
  if (l < 1e-4){ b.dvx = 0; b.dvz = 0; return 0; }
  dx /= l; dz /= l;
  if (b.avoidT > 0){                    /* stuck on scenery: swing wide */
    var a = 0.95 * b.avoidSide;
    var c = Math.cos(a), s = Math.sin(a);
    var nx = dx * c - dz * s, nz = dx * s + dz * c;
    dx = nx; dz = nz;
  }
  b.dvx = dx * spd; b.dvz = dz * spd;
  return l;
}
function stand(b){ b.dvx = 0; b.dvz = 0; }

function faceYaw(b, want, rate, dt){
  var d = wrapPi(want - b.yaw);
  var m = rate * dt;
  if (d > m) d = m; else if (d < -m) d = -m;
  b.yaw = wrapPi(b.yaw + d);
}
function faceTo(b, x, z, rate, dt){
  var dx = x - b.pos[0], dz = z - b.pos[2];
  if (dx * dx + dz * dz < 1e-6) return;
  faceYaw(b, Math.atan2(-dx, -dz), rate, dt);
}
function faceMove(b, rate, dt){
  if (b.dvx * b.dvx + b.dvz * b.dvz < 0.04) return;
  faceYaw(b, Math.atan2(-b.dvx, -b.dvz), rate, dt);
}

/* anti-grind: if a bot wants to move but isn't, swing around the obstacle */
function stuckWatch(b, dt){
  if (b.avoidT > 0){ b.avoidT -= dt; return; }
  b.stuckT += dt;
  if (b.stuckT < 0.55) return;
  b.stuckT = 0;
  var dx = b.pos[0] - b.lastX, dz = b.pos[2] - b.lastZ;
  var moved = Math.sqrt(dx * dx + dz * dz);
  var wants = b.dvx * b.dvx + b.dvz * b.dvz > 1;
  b.lastX = b.pos[0]; b.lastZ = b.pos[2];
  if (wants && moved < 0.45){
    b.avoidT = 0.9;
    b.avoidSide = rnd() < 0.5 ? -1 : 1;
  }
}

/* ============================== trooper AI ========================== */
var FIRE_OPT = { spread: SHOT_SPREAD, dmg: BOLT_DMG, owner: null, speed: BOLT_SPD };

function trooperFire(b, wild){
  if (!b.hasRifle || !heroAttackable()) return;
  var B = JK.Blaster;
  b.recoil = 1;
  b.flashT = 0.055;
  if (!B || !B.fire){
    snd('blaster', b.muzX, b.muzY, b.muzZ, 0.8);
    return;
  }
  MUZ3[0] = b.muzX; MUZ3[1] = b.muzY; MUZ3[2] = b.muzZ;
  var cp = Math.cos(b.aimPitch);
  DIR3[0] = -Math.sin(b.aimYaw) * cp;
  DIR3[1] = Math.sin(b.aimPitch);
  DIR3[2] = -Math.cos(b.aimYaw) * cp;
  FIRE_OPT.spread = wild ? 0.30 : SHOT_SPREAD;
  FIRE_OPT.dmg = BOLT_DMG;
  FIRE_OPT.owner = b;
  B.fire(MUZ3, DIR3, 'enemy', FIRE_OPT);
}

/* `carry` is the (negative) overshoot of the timer that expired, folded into the
 * new one so the 1.5 s period survives any frame rate. Without it the rhythm is
 * quantised UP by one frame per leg: measured 1.70 s per burst at 38 fps against
 * the intended 1.50, i.e. the burst rate silently depended on the phone. */
function newBurst(b, carry){
  b.burstN = BURST_N;
  b.burstT = BURST_LEAD + (carry > 0 ? 0 : (carry || 0));
  /* shooting on the move is worse shooting — the lateral scatter widens while he
   * strafes, so keeping the rhythm alive during REPOSITION does not make him
   * measurably more lethal, only more present */
  var miss = AIM_MISS * (b.state === 'REPOSITION' ? REPOS_MISS : 1);
  b.errLat = (rnd() - 0.5) * 2 * miss;
  b.errUp = (rnd() - 0.5) * 2 * AIM_MISS_Y;
}
/* ONE burst clock, ticked by every state that is allowed to shoot. Returns true
 * while a burst is in flight, so the caller knows not to change state mid-burst.
 * `auto` restarts the next burst when the rest expires (FIRE and REPOSITION both
 * want that; the caller decides what to do at the seam). */
function burstTick(b, dt, auto){
  if (b.burstN > 0){
    b.burstT -= dt;
    if (b.burstT <= 0){
      trooperFire(b, false);
      b.burstN--;
      if (b.burstN === 0) b.cycleT = BURST_REST + b.burstT;
      else b.burstT += BURST_DT;
    }
    return true;
  }
  b.cycleT -= dt;
  if (b.cycleT <= 0 && auto){ newBurst(b, b.cycleT); return true; }
  return false;
}
/* Entering FIRE always opens with a burst. (Rolling for a burst on arrival
 * made them dither: the probe measured one burst per 3.5 s, so the desert was
 * quiet.) */
function enterFire(b){
  setState(b, 'FIRE');
  newBurst(b);
}
function enterRepos(b){
  var carry = b.cycleT;        /* we are at the seam: keep the period honest */
  setState(b, 'REPOSITION');
  b.reposT = rrange(REPOS_MIN, REPOS_MAX);
  b.orbit = rnd() < 0.5 ? -1 : 1;
  b.nextState = rnd() < 0.18 ? 'TRIP' : '';
  newBurst(b, carry);          /* strafe AND shoot: the rhythm never stops */
}
/* A trooper coming out of a stagger / knockdown / getup must re-enter FIRE
 * through enterFire, not through a bare setState: the old path resumed whatever
 * burstN and cycleT happened to be frozen on his record when he was hit, which
 * could be a full BURST_REST of silence he had already half-spent. */
function resume(b){
  var st = combatState(b);
  if (st === 'FIRE') enterFire(b); else setState(b, st);
}

function trooperAI(b, dt, t, hx, hy, hz){
  var s = b.state;
  var d = b.dist;
  if (b.fleeCd > 0) b.fleeCd -= dt;

  /* panic triggers beat everything except a downed state. fleeCd keeps a
   * wounded trooper from fleeing forever — he finds his nerve, comes back,
   * and can break again later. */
  if (s !== 'FLEE' && s !== 'DISARMED' && !isDown(b) && s !== 'STAGGER' &&
      s !== 'IDLE' && s !== 'SPOT' && b.fleeCd <= 0){
    if (b.hp < b.hpMax * FLEE_HP || squadDeaths() >= 2){
      setState(b, 'FLEE');
      s = 'FLEE';
      b.cycleT = 0.3;
      sndR('hurt', b.pos[0], b.pos[1] + 1.4, b.pos[2], 0.8, 1.3);
    }
  }

  if (s === 'IDLE'){
    /* unaware patrol — they trudge in from the dunes instead of standing
     * around forever out past their spotting range */
    if (d > 10){
      seek(b, hx, hz, TR_WALK * 0.75);
      faceMove(b, TURN_SLOW, dt);
    } else {
      stand(b);
      b.yaw = wrapPi(b.yaw + Math.sin(t * 0.5 + b.id) * 0.4 * dt);
    }
    if (d < TR_SPOT){
      setState(b, 'SPOT');
      snd('select', b.pos[0], b.pos[1] + 1.5, b.pos[2], 0.55);
    }
    return;
  }
  if (s === 'SPOT'){
    stand(b);
    faceTo(b, hx, hz, TURN_FAST, dt);
    if (b.stT > SPOT_T) setState(b, 'ADVANCE');
    return;
  }
  if (s === 'ADVANCE'){
    seek(b, hx, hz, TR_RUN);
    faceTo(b, hx, hz, TURN_FAST, dt);
    if (d < TR_RANGE) enterFire(b);
    else if (d > TR_LOSE) setState(b, 'IDLE');
    return;
  }
  if (s === 'FIRE'){
    stand(b);
    faceTo(b, hx, hz, TURN_FAST, dt);
    /* burstTick without auto-restart: the seam between two bursts is exactly
     * where a trooper is allowed to decide to move, so the decision happens
     * once per burst and never chops a burst in half. */
    if (burstTick(b, dt, false)) return;
    if (b.cycleT > 0) return;
    if (d > TR_FAR){ setState(b, 'ADVANCE'); return; }
    if (d < TR_MIN || rnd() < REPOS_P){ enterRepos(b); return; }
    newBurst(b, b.cycleT);
    return;
  }
  if (s === 'REPOSITION'){
    /* sidestep around the player, holding the firing ring — and keep shooting */
    var dx = b.pos[0] - hx, dz = b.pos[2] - hz;
    var l = Math.sqrt(dx * dx + dz * dz) || 1;
    dx /= l; dz /= l;
    var px = -dz * b.orbit, pz = dx * b.orbit;          /* tangent */
    var pull = (l - TR_RANGE) * 0.12;
    if (pull > 1) pull = 1; else if (pull < -1) pull = -1;
    var tx = hx + (dx * (l - pull * 4) + px * 6);
    var tz = hz + (dz * (l - pull * 4) + pz * 6);
    seek(b, tx, tz, TR_WALK);
    faceTo(b, hx, hz, TURN_FAST, dt);   /* muzzle stays on him while he strafes */
    burstTick(b, dt, true);
    if (b.nextState === 'TRIP' && b.stT > b.reposT - 0.55){
      b.nextState = '';
      b.downDir = -1;                                    /* face-plant */
      setState(b, 'STUMBLE');
      b.burstN = 0;                                      /* the burst dies with him */
      b.vel[0] = b.dvx * 0.8; b.vel[2] = b.dvz * 0.8;
      sndR('hurt', b.pos[0], b.pos[1] + 1.0, b.pos[2], 0.7, 1.5);
      return;
    }
    /* plain setState, NOT enterFire: cycleT is mid-rest and must stay that way,
     * or ending a reposition would skip the rest and beat the contract's period */
    if (b.stT > b.reposT && b.burstN === 0) setState(b, 'FIRE');
    return;
  }
  if (s === 'FLEE'){
    var ax = b.pos[0] + (b.pos[0] - hx), az = b.pos[2] + (b.pos[2] - hz);
    seek(b, ax, az, TR_PANIC);
    faceMove(b, TURN_SLOW, dt);
    b.cycleT -= dt;
    if (b.cycleT <= 0){
      b.cycleT = rrange(0.35, 0.6);
      b.errLat = (rnd() - 0.5) * 26;      /* firing blind over the shoulder */
      b.errUp = rrange(-0.5, 3.0);
      trooperFire(b, true);              /* wild shots over the shoulder */
    }
    if (b.stT > FLEE_T){
      b.fleeCd = 9;
      if (d > TR_FAR){ setState(b, 'ADVANCE'); b.burstN = 0; }
      else enterFire(b);
    }
    return;
  }
  if (s === 'DISARMED'){
    /* zig-zag panic run: no rifle, no dignity */
    var zx = Math.sin(b.stT * 6.5 + b.id) * 0.9;
    var fx = b.pos[0] - hx, fz = b.pos[2] - hz;
    var fl = Math.sqrt(fx * fx + fz * fz) || 1;
    fx /= fl; fz /= fl;
    seek(b, b.pos[0] + fx * 10 - fz * zx * 6, b.pos[2] + fz * 10 + fx * zx * 6, TR_PANIC);
    faceMove(b, TURN_FAST, dt);
    if (b.stT > DISARM_T){
      b.hasRifle = true;
      setState(b, 'ADVANCE');
    }
    return;
  }
  /* unknown state: get back in the fight */
  setState(b, 'ADVANCE');
}

/* ============================== sith AI ============================= */
function sithSwing(b){
  var rig = b.rig;
  if (!rig || !rig.playSwing) return false;
  b.defIdx = (b.defIdx + 1 + ((rnd() * 3) | 0)) % SITH_DEFS.length;
  if (rig.playSwing(SITH_DEFS[b.defIdx]) === false) return false;
  b.swingHit = false;
  snd('swing', b.pos[0], b.pos[1] + 1.3, b.pos[2], 0.7);
  return true;
}
function swingPhase(b){
  var rig = b.rig;
  return (rig && rig.swingPhase) ? rig.swingPhase() : -1;
}
/* back off and show off — the taunt is the "I'm done attacking" tell */
function enterRecover(b){
  setState(b, 'RECOVER');
  b.cycleT = rrange(RECOVER_MIN, RECOVER_MAX);
  if (b.rig && b.rig.playSwing){
    b.rig.playSwing(TAUNT_DEF);
    snd('swing', b.pos[0], b.pos[1] + 1.3, b.pos[2], 0.5);
  }
}

/* ---- the duel token ----------------------------------------------------
 * THE fix for "sith swarm instead of duel": only ONE sith may be closing or
 * swinging at a time. The others circle at sabre distance, taunt, and throw
 * the occasional Force Push, which is exactly how a JK2 fight reads. Measured:
 * three sith with no token did 54 dps to a standing hero (dead in under two
 * seconds); with the token a lone sith lands 4.6 dps and you get openings.
 * The token is validated every frame instead of being explicitly released, so
 * a bot that dies, is knocked flat or is gripped mid-charge cannot leak it. */
var token = null, tokenT = 0;
var TOKEN_MAX = 5.0;        /* s before an unproductive holder loses it */

function tokenTick(dt){
  if (!token) return;
  tokenT += dt;
  var s = token.state;
  if (tokenT > TOKEN_MAX || s === 'DEAD' ||
      (s !== 'CHARGE' && s !== 'COMBO' && s !== 'LEAP')){
    token = null; tokenT = 0;
  }
}
function claimToken(b){
  if (token === b) return true;
  if (token) return false;
  token = b; tokenT = 0;
  return true;
}

/* the signature JK force-jump: a high arc that lands on the player's head */
function canLeap(b, d){
  return b.leapCd <= 0 && d > 6 && d < 18 && b.onGround;
}
function startLeap(b, hx, hz){
  setState(b, 'LEAP');
  b.leapCd = rrange(6.5, 10.0);
  var fl = 0.86;                     /* ~time of flight for vy 9.5 at g 22 */
  var sx = (hx - b.pos[0]) / fl, sz = (hz - b.pos[2]) / fl;
  var sl = Math.sqrt(sx * sx + sz * sz);
  if (!(sl === sl)) return false;
  if (sl > 16){ sx = sx / sl * 16; sz = sz / sl * 16; }
  b.vel[0] = sx; b.vel[2] = sz; b.vel[1] = 9.5;
  b.onGround = false;
  snd('jump', b.pos[0], b.pos[1] + 1, b.pos[2], 0.9);
  return true;
}

function sithMelee(b, hx, hy, hz){
  if (b.swingHit || b.hitCd > 0 || !heroAttackable()) return;
  var ph = swingPhase(b);
  if (ph < ACT0 || ph > ACT1) return;
  var dx = hx - b.pos[0], dz = hz - b.pos[2];
  var l = Math.sqrt(dx * dx + dz * dz);
  var reach = b.elite ? SI_REACH_ELITE : SI_REACH;
  if (l > reach) return;
  var fx = -Math.sin(b.yaw), fz = -Math.cos(b.yaw);
  if (l > 1e-4 && (fx * dx + fz * dz) / l < SI_FRONT) return;  /* must be in front */
  b.swingHit = true;
  b.hitCd = SI_HIT_CD;
  var nx = l > 1e-4 ? dx / l : fx, nz = l > 1e-4 ? dz / l : fz;
  hurtHero(b.elite ? SI_DMG_ELITE : SI_DMG, nx, 0.35, nz, 'saber');
  sparksAt(hx, hy + 0.9, hz, 16, COL_CLASH);
  snd('clash', hx, hy + 1.0, hz, 0.9);
}

function sithAI(b, dt, t, hx, hy, hz){
  var s = b.state;
  var d = b.dist;

  if (b.hitCd > 0) b.hitCd -= dt;
  if (s !== 'IDLE' && s !== 'SPOT'){
    b.chargeCd -= dt; b.leapCd -= dt; b.pushCd -= dt; b.flipCd -= dt;
  }

  if (s === 'IDLE'){
    if (d > 10){
      seek(b, hx, hz, SI_WALK * 0.6);     /* an unhurried, ominous approach */
      faceMove(b, TURN_SLOW, dt);
    } else {
      stand(b);
      b.yaw = wrapPi(b.yaw + Math.sin(t * 0.4 + b.id) * 0.5 * dt);
    }
    if (d < SI_SPOT){
      setState(b, 'SPOT');
      if (b.rig && b.rig.setSaber) b.rig.setSaber(SABER_RED, true);
      snd('saberOn', b.pos[0], b.pos[1] + 1.3, b.pos[2], 1);
    }
    return;
  }
  if (s === 'SPOT'){
    stand(b);
    faceTo(b, hx, hz, TURN_FAST, dt);
    if (b.stT > SPOT_T) setState(b, 'STALK');
    return;
  }
  if (s === 'STALK'){
    var dx = b.pos[0] - hx, dz = b.pos[2] - hz;
    var l = Math.sqrt(dx * dx + dz * dz) || 1;
    dx /= l; dz /= l;
    var tx = -dz * b.orbit, tz = dx * b.orbit;
    var ring = SI_RING + Math.sin(t * 0.7 + b.id) * 0.8;
    var wx = hx + dx * ring + tx * 3.4;
    var wz = hz + dz * ring + tz * 3.4;
    seek(b, wx, wz, SI_WALK);
    faceTo(b, hx, hz, TURN_FAST, dt);
    if (b.flipCd <= 0){ b.orbit = -b.orbit; b.flipCd = rrange(1.5, 3.2); }
    if (d > SI_LOSE){ setState(b, 'IDLE'); return; }
    if (canLeap(b, d) && startLeap(b, hx, hz)) return;
    if (b.pushCd <= 0 && d > 3.5 && d < 9.5){
      setState(b, 'FPUSH');
      b.pushCd = rrange(9.0, 15.0);
      return;
    }
    if (b.chargeCd <= 0){
      if (claimToken(b)){
        setState(b, 'CHARGE');
        b.chargeCd = rrange(1.4, 2.4);
      } else {
        b.chargeCd = rrange(0.6, 1.2);      /* wait your turn, apprentice */
      }
      return;
    }
    return;
  }
  if (s === 'CHARGE'){
    seek(b, hx, hz, SI_RUN);
    faceTo(b, hx, hz, TURN_FAST, dt);
    if (d < SI_CLOSE + (b.elite ? 0.5 : 0)){
      setState(b, 'COMBO');
      b.comboLeft = 1 + ((rnd() * 2) | 0);    /* 2-3 swings total */
      sithSwing(b);
      return;
    }
    if (b.stT > 2.5 || d > SI_LOSE) setState(b, 'STALK');
    return;
  }
  if (s === 'COMBO'){
    /* drift in slowly so the blade actually reaches */
    if (d > SI_CLOSE) seek(b, hx, hz, 2.2); else stand(b);
    faceTo(b, hx, hz, TURN_FAST, dt);
    sithMelee(b, hx, hy, hz);
    var ph = swingPhase(b);
    if (ph < 0){
      if (b.comboLeft > 0){ b.comboLeft--; if (!sithSwing(b)) enterRecover(b); }
      else enterRecover(b);
    } else if (ph >= 0.62 && b.comboLeft > 0){
      b.comboLeft--;
      sithSwing(b);
    }
    if (b.stT > 3.2) enterRecover(b);
    return;
  }
  if (s === 'LEAP'){
    b.dvx = b.vel[0]; b.dvz = b.vel[2];        /* keep the arc, no air steering */
    faceTo(b, hx, hz, TURN_SLOW, dt);
    if (b.onGround && b.stT > 0.18){
      if (!claimToken(b)) setState(b, 'STALK');       /* someone else is on him */
      else if (d < SI_CLOSE + 1.4){
        setState(b, 'COMBO');
        b.comboLeft = 1 + ((rnd() * 2) | 0);
        sithSwing(b);
      } else setState(b, 'CHARGE');
    }
    if (b.stT > 3.0) setState(b, 'STALK');
    return;
  }
  if (s === 'FPUSH'){
    stand(b);
    faceTo(b, hx, hz, TURN_FAST, dt);
    if (b.stT >= 0.45){
      var px = hx - b.pos[0], pz = hz - b.pos[2];
      var pl = Math.sqrt(px * px + pz * pz) || 1;
      px /= pl; pz /= pl;
      /* RANGE IS RE-CHECKED HERE, at the moment of the shove — not only when
       * FPUSH was entered 0.45 s ago. Two ways the hero gets out of reach in
       * between: he sprints (Force Speed moves him ~7 m in the telegraph), or
       * he leaves the 60 m full-AI radius entirely, which FREEZES this bot
       * mid-telegraph until he comes back — and the push then landed from
       * wherever the bot happened to be. Measured in the real build: 9 damage
       * plus the full 'force' knockback delivered from 60.0 m through a dune,
       * off-screen. FPUSH_MAX gives the intended 9.5 m entry range a little
       * slack for an honest chase and nothing more. */
      if (b.dist > FPUSH_MAX){
        snd('forceFail', b.pos[0], b.pos[1] + 1.3, b.pos[2], 0.6);
        setState(b, 'STALK');
        return;
      }
      if (heroAttackable()){
        hurtHero(FPUSH_DMG, px, 0.6, pz, 'force');
        var F = JK.ForceFx;
        if (F && F.push){
          FX3[0] = b.pos[0] - px * 0.4;
          FX3[1] = b.pos[1] + 1.25;
          FX3[2] = b.pos[2] - pz * 0.4;
          DIR3[0] = px; DIR3[1] = 0; DIR3[2] = pz;
          F.push(FX3, DIR3);
        }
      }
      snd('push', b.pos[0], b.pos[1] + 1.3, b.pos[2], 1);
      setState(b, 'STALK');
    }
    return;
  }
  if (s === 'RECOVER'){
    /* A TAUNT, not a retreat: give up ~RECOVER_BACK metres and stand there
     * flourishing. The old version ran 3.5-5.6 m backwards at 3.5 m/s, which
     * erased the counter-attack window every single time the sith finished a
     * combo — the player's whole reward for surviving one. */
    var rdx = b.pos[0] - hx, rdz = b.pos[2] - hz;
    var rl = Math.sqrt(rdx * rdx + rdz * rdz) || 1;
    var bx = hx + rdx / rl * (rl + RECOVER_BACK);
    var bz = hz + rdz / rl * (rl + RECOVER_BACK);
    seek(b, bx, bz, SI_WALK * 0.45);
    faceTo(b, hx, hz, TURN_FAST, dt);
    if (b.stT > 0.5 && canLeap(b, d) && startLeap(b, hx, hz)) return;
    if (b.stT > b.cycleT) setState(b, 'STALK');
    return;
  }
  setState(b, 'STALK');
}

/* ============================== shared states ======================= */
function reactAI(b, dt, t){
  var s = b.state;
  if (s === 'KNOCKED'){
    b.noSteer = true;
    b.downW += (1 - b.downW) * (1 - Math.exp(-9 * dt));
    if (b.stT > KNOCK_T){ setState(b, 'GETUP'); }
    return true;
  }
  if (s === 'STUMBLE'){
    b.noSteer = true;
    b.downW += (1 - b.downW) * (1 - Math.exp(-11 * dt));
    if (b.stT > STUMBLE_T) setState(b, 'GETUP');
    return true;
  }
  if (s === 'GETUP'){
    b.noSteer = true;
    b.downW -= b.downW * (1 - Math.exp(-6 * dt));
    if (b.stT > GETUP_T){
      b.downW = 0;
      resume(b);
    }
    return true;
  }
  if (s === 'LIFTED'){
    b.noSteer = true;
    b.liftW += (1 - b.liftW) * (1 - Math.exp(-8 * dt));
    b.yaw = wrapPi(b.yaw + 1.3 * dt);
    /* Powers stops calling gripHold on release; drop out after a beat */
    if (b.stT > 0.4){
      b.liftW = 0;
      b.vel[1] = 0.5;
      setState(b, 'KNOCKED');
      b.downDir = 1;
    }
    return true;
  }
  if (s === 'STAGGER'){
    b.noSteer = true;
    b.stagW += (1 - b.stagW) * (1 - Math.exp(-16 * dt));
    if (b.stT > STAGGER_T){
      b.stagW = 0;
      var back = b.nextState || combatState(b);
      b.nextState = '';
      if (back === 'FIRE') enterFire(b); else setState(b, back);
    }
    return true;
  }
  if (b.stagW > 0.001) b.stagW -= b.stagW * (1 - Math.exp(-12 * dt));
  return false;
}

/* ============================== AI entry ============================ */
function fullAI(b, dt, t){
  b.stT += dt;
  if (b.flash > 0){ b.flash -= dt * 4; if (b.flash < 0) b.flash = 0; }
  if (reactAI(b, dt, t)) return;
  var P = heroPos();
  var hx = P ? P[0] : 0, hy = P ? P[1] : 0, hz = P ? P[2] : 0;
  if (!P){ stand(b); return; }
  if (b.kind === 'trooper') trooperAI(b, dt, t, hx, hy, hz);
  else sithAI(b, dt, t, hx, hy, hz);
  stuckWatch(b, dt);
}

function cheapAI(b, dt, t){
  b.stT += dt;
  if (b.flash > 0){ b.flash -= dt * 4; if (b.flash < 0) b.flash = 0; }
  if (reactAI(b, dt, t)) return;
  var P = heroPos();
  if (!P){ stand(b); return; }
  /* far away: just walk in, no firing, no orbiting, no rig work */
  seek(b, P[0], P[2], b.kind === 'sith' ? SI_WALK : TR_WALK);
  faceMove(b, TURN_SLOW, dt);
  if (b.state === 'IDLE' || b.state === 'SPOT'){
    if (b.dist < (b.kind === 'sith' ? SI_SPOT : TR_SPOT)) setState(b, 'SPOT');
  }
  stuckWatch(b, dt);
}

/* ============================== corpses ============================= */
function corpse(b, dt){
  b.stT += dt;
  b.vel[0] *= Math.exp(-5 * dt);
  b.vel[2] *= Math.exp(-5 * dt);
  b.pos[0] += b.vel[0] * dt;
  b.pos[2] += b.vel[2] * dt;
  var g = groundY(b.pos[0], b.pos[2]);
  var u = b.stT / DIE_T;
  var sink = u < 0.4 ? 0 : (u - 0.4) / 0.6;
  sink = sink * sink;
  var target = g - sink * 2.1;
  if (b.pos[1] > target + 0.02){        /* killed in mid-air / mid-grip: drop */
    b.vel[1] -= GRAV * dt;
    b.pos[1] += b.vel[1] * dt;
    if (b.pos[1] < target){ b.pos[1] = target; b.vel[1] = 0; }
  } else {
    b.pos[1] = target;
    b.vel[1] = 0;
  }
  b.speed2D = 0;
}

/* ============================== pose overrides ======================
 * The rig exposes its eased joint angles as rig.pose; we advance the rig
 * normally and then CLOBBER the fields a reaction owns, so a knocked-down
 * bot reads as knocked down from 20 m without touching 40_character.js. */
function poseDown(p, w, dir, slump){
  if (w < 0.002) return;
  p.lean  = mix(p.lean,   1.45 * dir, w);
  p.bob   = mix(p.bob,   -0.62, w);
  p.head  = mix(p.head,   0.30 * dir, w);
  p.twist = mix(p.twist,  0.25 * dir, w);
  p.lSwL  = mix(p.lSwL,   1.45 * dir, w);
  p.lSwR  = mix(p.lSwR,   1.25 * dir, w);
  p.kneeL = mix(p.kneeL, -0.55 - slump * 0.5, w);
  p.kneeR = mix(p.kneeR, -0.28 - slump * 0.4, w);
  p.aSwL  = mix(p.aSwL,   0.55 * dir - slump * 0.6, w);
  p.aSwR  = mix(p.aSwR,   0.75 * dir - slump * 0.6, w);
  p.sprL  = mix(p.sprL,   0.95 + slump * 0.25, w);
  p.sprR  = mix(p.sprR,   0.95 + slump * 0.25, w);
  p.elbL  = mix(p.elbL,   0.25, w);
  p.elbR  = mix(p.elbR,   0.20, w);
}
function poseLift(p, w, t, id){
  if (w < 0.002) return;
  var s1 = Math.sin(t * 11 + id), s2 = Math.sin(t * 13.7 + id * 1.7);
  p.lean  = mix(p.lean,  -0.30 + 0.30 * s1, w);
  p.bob   = mix(p.bob,    0.06, w);
  p.head  = mix(p.head,   0.38, w);
  p.twist = mix(p.twist,  0.30 * s2, w);
  p.aSwL  = mix(p.aSwL,  -1.35 + 0.45 * s2, w);
  p.aSwR  = mix(p.aSwR,  -1.30 + 0.45 * s1, w);
  p.sprL  = mix(p.sprL,   0.85 + 0.25 * s1, w);
  p.sprR  = mix(p.sprR,   0.85 - 0.25 * s2, w);
  p.elbL  = mix(p.elbL,   1.15, w);
  p.elbR  = mix(p.elbR,   1.10, w);
  p.lSwL  = mix(p.lSwL,   0.55 + 0.45 * s2, w);
  p.lSwR  = mix(p.lSwR,  -0.35 + 0.45 * s1, w);
  p.kneeL = mix(p.kneeL, -0.85 - 0.3 * s1, w);
  p.kneeR = mix(p.kneeR, -0.70 - 0.3 * s2, w);
}
function poseStagger(p, w){
  if (w < 0.002) return;
  p.lean = mix(p.lean,  0.45, w);
  p.head = mix(p.head,  0.25, w);
  p.aSwL = mix(p.aSwL, -0.55, w);
  p.aSwR = mix(p.aSwR, -0.45, w);
  p.sprL = mix(p.sprL,  0.55, w);
  p.sprR = mix(p.sprR,  0.55, w);
  p.bob  = mix(p.bob,  -0.10, w);
}

/* ============================== animation =========================== */
function pickAnim(b){
  if (b.state === 'LEAP' || (!b.onGround && b.state !== 'LIFTED'))
    return b.vel[1] > 0.5 ? 'jump' : 'fall';
  if (b.speed2D > 6.2) return 'sprint';
  if (b.speed2D > 0.6) return 'run';
  return 'idle';
}

function animate(b, dt, t){
  var rig = b.rig;
  if (!rig) return;
  var dead = b.state === 'DEAD';
  b.anim = dead ? 'fall' : pickAnim(b);

  if (b.dist < FULL_R){
    if (rig.advance) rig.advance(dt, t, b.anim, b.speed2D);
  } else if (b.dist < CHEAP_ANIM){
    b.cheapAcc += dt;
    if (b.cheapAcc >= 0.1){
      if (rig.advance) rig.advance(b.cheapAcc, t, b.anim, b.speed2D);
      b.cheapAcc = 0;
    }
  } else {
    return;                         /* far away: frozen pose, nobody can tell */
  }

  var p = rig.pose;
  if (!p) return;
  if (dead){
    var c = b.stT / 0.45; if (c > 1) c = 1;
    c = c * c * (3 - 2 * c);
    poseDown(p, c, b.dieDir, 1);
  } else {
    if (b.downW > 0.002) poseDown(p, b.downW, b.downDir, 0);
    if (b.liftW > 0.002) poseLift(p, b.liftW, t, b.id);
    if (b.stagW > 0.002) poseStagger(p, b.stagW);
    /* FPUSH telegraph: arm thrust out at the hero, unmistakable from range */
    if (b.state === 'FPUSH'){
      var w = b.stT / 0.30; if (w > 1) w = 1;
      p.aSwR = mix(p.aSwR, 1.55, w);
      p.elbR = mix(p.elbR, 0.10, w);
      p.sprR = mix(p.sprR, 0.25, w);
      p.lean = mix(p.lean, -0.18, w);
    }
  }
}

/* rifle anchor + aim, computed once per frame for both firing and drawing */
function updateRifle(b, dt, t){
  var wantAim = (b.state === 'FIRE' || b.state === 'FLEE' ||
                 b.state === 'REPOSITION' || b.state === 'ADVANCE') ? 1 : 0;
  if (!b.hasRifle || isDown(b) || b.state === 'STAGGER') wantAim = 0;
  b.aimBlend += (wantAim - b.aimBlend) * (1 - Math.exp(-7 * dt));
  if (b.recoil > 0){ b.recoil -= dt * 9; if (b.recoil < 0) b.recoil = 0; }
  if (b.flashT > 0){ b.flashT -= dt; if (b.flashT < 0) b.flashT = 0; }

  var fx = -Math.sin(b.yaw), fz = -Math.cos(b.yaw);
  var rx = -fz, rz = fx;                          /* right = fwd x up */

  /* hand point + hand FRAME: the rig publishes blades[0].base every draw (valid
   * even with the saber off) and blades[0].tip-base is the hand's own axis —
   * that pair is the hand frame the contract points at. Only trust it if this
   * bot's rig was actually drawn on the previous frame: distant bots go out as
   * one impostor mesh and off-camera bots are culled, and in both cases the
   * blade entry stops being refreshed, so a stale hand up to 1.5 m behind the
   * bot passed the old sanity box and dragged the muzzle with it. */
  var fresh = (now - b.drewAt) < 0.2;
  var hx = b.pos[0] + rx * 0.30 + fx * 0.10;
  var hy = b.pos[1] + 1.05;
  var hz = b.pos[2] + rz * 0.30 + fz * 0.10;
  var carryYaw = b.yaw, carryPitch = -0.10;
  var bl = fresh && b.rig && b.rig.blades && b.rig.blades[0];
  if (bl && bl.base){
    var qx = bl.base[0] - b.pos[0], qy = bl.base[1] - b.pos[1], qz = bl.base[2] - b.pos[2];
    if (qy > 0.15 && qy < 2.4 && qx * qx + qz * qz < 2.25){
      hx = bl.base[0]; hy = bl.base[1]; hz = bl.base[2];
      /* barrel along the hand's axis while NOT aiming. Without this the rifle
       * kept the world-space aim angles no matter what the body did, so a
       * trooper knocked flat on his back by a Force Push left his carbine
       * hovering dead level in the air above him — clearly visible from 5 m. */
      if (bl.tip){
        var ux = bl.tip[0] - bl.base[0], uy = bl.tip[1] - bl.base[1], uz = bl.tip[2] - bl.base[2];
        var ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
        if (ul > 1e-3){
          ux /= ul; uy /= ul; uz /= ul;
          if (ux * ux + uz * uz > 1e-6){
            carryYaw = Math.atan2(-ux, -uz);
            carryPitch = Math.asin(clamp(uy, -1, 1)) - 0.55;   /* muzzle down off the blade axis */
          }
        }
      }
    }
  }
  /* shouldered aiming pose */
  var ax = b.pos[0] + rx * 0.20 + fx * 0.14;
  var ay = b.pos[1] + 1.30;
  var az = b.pos[2] + rz * 0.20 + fz * 0.14;
  var w = b.aimBlend;
  b.rifleX = mix(hx, ax, w);
  b.rifleY = mix(hy, ay, w);
  b.rifleZ = mix(hz, az, w);

  /* aim: lead the hero, then add this burst's deliberate error */
  var yawWant = b.yaw, pitchWant = -0.06, errY = 0, errP = 0;
  var P = heroPos();
  if (P && w > 0.02){
    var dx = P[0] - b.rifleX, dz = P[2] - b.rifleZ;
    var dist = Math.sqrt(dx * dx + dz * dz);
    var lead = dist / BOLT_SPD * AIM_LEAD;
    if (lead > 0.45) lead = 0.45;
    var V = JK.Player && JK.Player.vel;
    var tx = P[0] + (V ? V[0] : 0) * lead;
    var tz = P[2] + (V ? V[2] : 0) * lead;
    var ty = P[1] + 1.05;
    dx = tx - b.rifleX; dz = tz - b.rifleZ;
    var dy = ty - b.rifleY;
    var l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (l > 1e-4){
      yawWant = Math.atan2(-dx, -dz);
      pitchWant = Math.asin(clamp(dy / l, -1, 1));
    }
    errY = (b.errLat / (dist < 3 ? 3 : dist)) * w;
    errP = (b.errUp / (dist < 3 ? 3 : dist)) * w;
  }
  pitchWant = clamp(pitchWant, -0.9, 0.9);
  /* Ease the TRUE aim so the barrel visibly tracks the hero (telegraph), then
   * add this burst's error on top un-eased. Easing the error too let the first
   * shot of every burst fly straight while the aim was still converging —
   * that alone put trooper accuracy 20 points too high in the probe. */
  var k = 1 - Math.exp(-14 * dt);
  b.aimYaw0 = wrapPi(b.aimYaw0 + wrapPi(yawWant - b.aimYaw0) * k);
  b.aimPitch0 += (pitchWant - b.aimPitch0) * k;
  b.aimYaw = wrapPi(b.aimYaw0 + errY);
  b.aimPitch = clamp(b.aimPitch0 + errP, -0.95, 0.95);

  var cp = Math.cos(b.aimPitch);
  b.muzX = b.rifleX - Math.sin(b.aimYaw) * cp * RIFLE_MUZZLE;
  b.muzY = b.rifleY + Math.sin(b.aimPitch) * RIFLE_MUZZLE;
  b.muzZ = b.rifleZ - Math.cos(b.aimYaw) * cp * RIFLE_MUZZLE;

  /* What the RIFLE MESH is drawn with: the shouldered aim when he is aiming,
   * the hand's own frame when he is not (running, tripped, choking in a grip,
   * flat on his back). aimBlend is already 1 in every firing state, so the
   * barrel and the bolt still leave along exactly the same line. */
  b.gunYaw = wrapPi(carryYaw + wrapPi(b.aimYaw - carryYaw) * w);
  b.gunPitch = carryPitch + (b.aimPitch - carryPitch) * w;
}

/* ============================== spawning ============================ */
function findSpawn(out){
  var P = heroPos();
  var px = P ? P[0] : 0, pz = P ? P[2] : 0;
  var S = ((JK.Terrain && JK.Terrain.SIZE) || 350) - 8;
  var obs = (JK.Terrain && JK.Terrain.obstacles) || EMPTY;
  var bestClear = -1e9, bx = px, bz = pz + SPAWN_MIN, got = false;
  for (var i = 0; i < 28; i++){
    var a = rnd() * TWO_PI;
    var r = SPAWN_MIN + rnd() * (SPAWN_MAX - SPAWN_MIN);
    var x = px + Math.sin(a) * r, z = pz + Math.cos(a) * r;
    if (x > S) x = S; else if (x < -S) x = -S;
    if (z > S) z = S; else if (z < -S) z = -S;
    var ddx = x - px, ddz = z - pz;
    if (ddx * ddx + ddz * ddz < SPAWN_CLEAR * SPAWN_CLEAR) continue;
    var clear = 1e9;
    for (var j = 0; j < obs.length; j++){
      var o = obs[j];
      var ox = x - o.x, oz = z - o.z;
      var c = Math.sqrt(ox * ox + oz * oz) - o.r;
      if (c < clear) clear = c;
    }
    if (clear > 2.5){ out[0] = x; out[1] = z; return true; }
    if (clear > bestClear){ bestClear = clear; bx = x; bz = z; got = true; }
  }
  out[0] = bx; out[1] = bz;
  return got;
}
var SPAWN_XZ = [0, 0];

function spawnVariant(variant, x, z){
  if (list.length >= MAX_BOTS + 4) return null;      /* corpses inflate list */
  var b = obtain(variant);
  resetBot(b, x, z);
  if (JK.Combat && JK.Combat.register){
    JK.Combat.register(b);
    b.registered = true;
  }
  if (b.elite) eliteAlive = true;
  list.push(b);
  var F = JK.Fx;
  if (F && F.shimmer){
    FX3[0] = x; FX3[1] = b.pos[1] + 1.0; FX3[2] = z;
    F.shimmer(FX3, 10, b.kind === 'sith' ? COL_SITH_FX : COL_SPAWN);
  }
  return b;
}

function liveCount(kind){
  var n = 0;
  for (var i = 0; i < list.length; i++){
    var b = list[i];
    if (b.state === 'DEAD') continue;
    if (!kind || b.kind === kind) n++;
  }
  return n;
}

function wantPop(){
  var kills = (JK.game && JK.game.kills) || 0;
  var w = BASE_POP + Math.floor(kills / KILLS_PER);
  if (w > MAX_BOTS) w = MAX_BOTS;
  return w;
}
function sithQuota(want){
  var q = want <= BASE_POP ? 2 : 3;
  if (q > want) q = want;
  return q;
}

function spawnNext(){
  var want = wantPop();
  var sq = sithQuota(want);
  var haveSith = liveCount('sith');
  var variant;
  if (haveSith < sq) variant = eliteAlive ? 'sith' : 'elite';
  else variant = 'trooper';
  findSpawn(SPAWN_XZ);                  /* always returns a usable spot */
  spawnVariant(variant, SPAWN_XZ[0], SPAWN_XZ[1]);
}

/* pending reinforcement timers (fixed slots, no allocation) */
var pendT = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
var pendN = 0;

function population(dt){
  /* forward scan with swap-remove: the element swapped into slot i has NOT
   * been ticked yet this frame, so we retest the slot instead of advancing */
  var i = 0;
  while (i < pendN){
    pendT[i] -= dt;
    if (pendT[i] <= 0){
      pendN--;
      pendT[i] = pendT[pendN];
      spawnNext();
    } else i++;
  }
  var want = wantPop();
  Bots.wave = want;
  var alive = liveCount(null);
  Bots.pending = pendN;
  if (alive + pendN < want && pendN < pendT.length){
    pendT[pendN++] = rrange(RESP_MIN, RESP_MAX);
  }
}

function reap(){
  for (var i = list.length - 1; i >= 0; i--){
    var b = list[i];
    if (b.state !== 'DEAD' || b.stT < DIE_T) continue;
    list[i] = list[list.length - 1];
    list.pop();
    recycle(b);
  }
}

/* ============================== draw ================================ */
function drawRifleAt(b){
  if (!rifleMesh) return;
  M.ident(MTX);
  M.tr(MTX, b.rifleX, b.rifleY, b.rifleZ);
  M.ry(MTX, b.gunYaw);
  M.rx(MTX, b.gunPitch);
  M.tr(MTX, 0, 0, b.recoil * 0.11);
  JK.GL.draw(rifleMesh, MTX, PLAIN);
  if (b.flashT > 0 && flashMesh){
    var s = 0.55 + b.flashT * 8;
    M.ident(MTX);
    M.tr(MTX, b.muzX, b.muzY, b.muzZ);
    M.ry(MTX, b.aimYaw);
    M.rx(MTX, b.aimPitch);
    M.sc(MTX, s, s, s);
    JK.GL.draw(flashMesh, MTX, FLASH_O);
  }
}
function drawDroppedRifle(b){
  if (!rifleMesh) return;
  var g = groundY(b.dropX, b.dropZ);
  M.ident(MTX);
  M.tr(MTX, b.dropX, g + 0.07, b.dropZ);
  M.ry(MTX, b.dropYaw);
  M.rz(MTX, 0.5);
  JK.GL.draw(rifleMesh, MTX, PLAIN);
}

/* ============================== module ============================== */
var Bots = JK.Bots = {
  list: list,
  wave: BASE_POP,
  pending: 0,
  MAX: MAX_BOTS,

  count: function(){ return liveCount(null); },
  countKind: function(kind){ return liveCount(kind); },

  spawn: function(kind, x, z){
    var variant = (kind === 'elite') ? 'elite' : (kind === 'sith' ? 'sith' : 'trooper');
    if (x === undefined || z === undefined){
      findSpawn(SPAWN_XZ);
      x = SPAWN_XZ[0]; z = SPAWN_XZ[1];
    }
    return spawnVariant(variant, x, z);
  },

  clear: function(){
    for (var i = list.length - 1; i >= 0; i--){
      var b = list[i];
      if (b.registered && JK.Combat && JK.Combat.unregister) JK.Combat.unregister(b);
      b.registered = false;
      list.pop();
      recycle(b);
    }
    eliteAlive = false;
    pendN = 0;
    token = null; tokenT = 0;
  },

  init: function(){
    buildMeshes();
    Bots.clear();
    for (var i = 0; i < 8; i++) deathT[i] = -99;
    deathI = 0;
    now = 0;
    /* boot wave: 3 stormtroopers + 2 sith (one of them the staff elite) */
    var v = ['elite', 'sith', 'trooper', 'trooper', 'trooper'];
    for (i = 0; i < v.length; i++){
      findSpawn(SPAWN_XZ);
      spawnVariant(v[i], SPAWN_XZ[0], SPAWN_XZ[1]);
    }
    Bots.wave = BASE_POP;
  },

  update: function(dt, t){
    if (!(dt > 0)) dt = 0.016;
    if (dt > 0.05) dt = 0.05;
    /* `now` drives the squad-morale window; never let a bad t poison it */
    now = (typeof t === 'number' && t === t) ? t : now + dt;
    tokenTick(dt);
    var P = heroPos();
    var px = P ? P[0] : 0, pz = P ? P[2] : 0;
    var i, b, dx, dz;

    for (i = 0; i < list.length; i++){
      b = list[i];
      dx = b.pos[0] - px; dz = b.pos[2] - pz;
      b.dist = Math.sqrt(dx * dx + dz * dz);
      if (b.state === 'DEAD'){ corpse(b, dt); continue; }
      b.dvx = 0; b.dvz = 0; b.noSteer = false;
      if (b.dist < FULL_R) fullAI(b, dt, t);
      else cheapAI(b, dt, t);
      physics(b, dt);
    }

    separate();

    for (i = 0; i < list.length; i++){
      b = list[i];
      animate(b, dt, t);
      if (b.kind === 'trooper' && b.state !== 'DEAD' && b.dist < DRAW_R)
        updateRifle(b, dt, t);
    }

    reap();
    population(dt);
  },

  draw: function(){
    if (!JK.GL || !JK.GL.draw) return;
    if (!rifleMesh) buildMeshes();      /* in case init ran before GL was up */
    var P = JK.Player;
    var cy = P ? (P.camYaw || 0) : 0;
    var cfx = -Math.sin(cy), cfz = -Math.cos(cy);
    var ex = JK.GL.eye ? JK.GL.eye[0] : 0, ez = JK.GL.eye ? JK.GL.eye[2] : 0;
    for (var i = 0; i < list.length; i++){
      var b = list[i];
      if (!b.rig || !b.rig.draw) continue;
      var dx = b.pos[0] - ex, dz = b.pos[2] - ez;
      var d2 = dx * dx + dz * dz;
      if (d2 > DRAW_R * DRAW_R) continue;
      if (d2 > 36){                       /* behind-the-camera cull */
        var d = Math.sqrt(d2);
        if ((dx * cfx + dz * cfz) / d < -0.42) continue;
      }
      if (d2 > IMPOSTOR_R * IMPOSTOR_R && b.state !== 'DEAD'){
        var im = impostor[b.variant];
        if (im){
          M.ident(MTX);
          M.tr(MTX, b.pos[0], b.pos[1], b.pos[2]);
          M.ry(MTX, b.yaw);
          JK.GL.draw(im, MTX, PLAIN);    /* one call for the whole figure */
          continue;
        }
      }
      b.rig.draw(b.pos, b.yaw);
      b.drewAt = now;            /* blades[0] is fresh for next frame's rifle */
      if (b.kind === 'trooper' && b.state !== 'DEAD'){
        if (b.hasRifle) drawRifleAt(b);
        else drawDroppedRifle(b);
      }
    }
  }
};
})();
