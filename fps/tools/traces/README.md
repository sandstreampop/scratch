# Trace pairs — how to read them

Four metrics, two files each: `<metric>-A.json` and `<metric>-B.json`.

One file in each pair was **recorded from a running simulation**. The other was
**generated analytically from a written specification** — a set of documented
figures and the model they imply. It is *not* a recording of anything, and it
does not claim to be: nobody captured telemetry from a shipped game to make it.
Both files describe the same manoeuvres, the same ranges and the same round
counts, and both are quantised to the same 1/60 s tick, so the question is about
the *shape* of what is in them and not about their formatting.

Which of A and B is which was decided **independently per metric** by a coin, so
position carries no information: A being the recording for one metric says
nothing about the next. Four separate calls.

You are asked, per metric: which file is the recording, how confident are you,
and — this is the part that matters more than the verdict — **what exactly did
you key on**. A difference you can point at in a specific column, with the rows
that show it, is worth more than a correct guess with no reason attached; a
wrong guess with a precise reason is worth more than a right one without.

There is an answer key, and there is a labelled copy of the generated side. Both
are deliberately kept **outside this directory** so that reading either has to be
a decision rather than an accident. **Read nothing outside this directory** while
judging. If you have, say so; a contaminated judgement that admits it is still
useful, one that does not is worse than none.

## Common structure

Every file is one JSON object:

```
{
  "metric":  which metric this is
  "tick":    the simulation quantum, in seconds — every time in the file is a
             whole number of these
  "columns": one line per column, naming it and its unit
  "n":       number of rows
  "rows":    the data
}
```

Angles are **degrees**, distances **metres**, speeds **metres per second**, times
**seconds**. `null` means "this did not happen" — it is never a zero and never a
dropped row.

## recoil — where each round of a magazine went

One row per round. Ten magazines of thirty rounds aimed down the sights and ten
fired from the hip, trigger held throughout, no player aim input at any point:
every degree in these columns was put there by the weapon.

| column | meaning |
| --- | --- |
| `mag` | magazine index, 0-based. Magazines are independent: nothing carries over. |
| `stance` | 1 = aimed down sights, 0 = hipfire |
| `round` | round number within the magazine, 1..30 |
| `t` | seconds since the first round of that magazine |
| `dpitch` | degrees of aim **elevation** relative to the first round of the magazine; up is positive. Round 1 is 0 by definition. |
| `dyaw` | degrees of aim **azimuth** relative to the first round; right is positive. Round 1 is 0 by definition. |

This is the aim the round left on — not where it landed. No bullet spread is
included in these numbers on either side.

## velocity — horizontal speed through four manoeuvres

One row per simulation tick. Each manoeuvre starts from a standing rest on flat
level ground with forward and sprint held from the first tick.

| column | meaning |
| --- | --- |
| `move` | 0 = standing start to full sprint; 1 = sprint, then a 90-degree turn at t = 1.0 s with forward still held; 2 = sprint, then crouch pressed at t = 1.2 s and held (a slide); 3 = sprint, then a jump at t = 1.0 s |
| `t` | seconds since the start of the manoeuvre |
| `speed` | horizontal speed, m/s (the vertical component is not in it) |
| `vy` | vertical velocity, m/s, up positive |
| `air` | 1 while airborne, 0 while in contact with the ground |

## ttk — time to kill, as a distribution

One row per engagement. Six ranges, two shooters, ten engagements each. The
shooter aims at the centre of the target's chest and holds the trigger; the
target is stationary and has 100 HP. The window is 3.2 s, which is one thirty-round
magazine plus the flight time of the last round, so "survived" means "survived a
magazine" and not "survived until the instrument stopped looking".

| column | meaning |
| --- | --- |
| `range` | engagement range, m |
| `comp` | 1 = the shooter compensates for recoil (his aim returns to the chest between rounds); 0 = he does not, and the weapon walks off target |
| `eng` | engagement index within that range and condition, 0-based |
| `ttk` | seconds from the **first round landing** to the fatal one. `null` if the target survived the magazine. Note the convention: it excludes the flight time of the first round, which is how published time-to-kill figures are stated. |
| `tkill` | seconds from the trigger breaking to the fatal round landing. `null` if the target survived. |
| `stk` | rounds that landed, up to and including the fatal one. `null` if the target survived. |
| `fired` | rounds that left the barrel during the engagement |

## ai — one engagement timeline per row

One row per engagement. Four ranges, six engagements each. Every engagement
begins with the line of sight already open and verified, with the enemy already
facing the player, so `sight` is 0 by construction and every other time in the
row is measured from it. The player stands still and does not shoot back.

| column | meaning |
| --- | --- |
| `range` | engagement range, m |
| `eng` | engagement index, 0-based |
| `sight` | 0 — the instant the enemy could first see the player |
| `shot` | seconds from first sight to the first round leaving the enemy's barrel |
| `hit` | seconds from first sight to the first round arriving on the player, or `null` |
| `kill` | seconds from first sight to the player dying, or `null` if he survived the window |
| `shots` | array of times, one per round fired, seconds from first sight |
| `bursts` | array of `[start, end]` pairs, one per burst — a burst being a run of rounds with no internal gap longer than 0.25 s |
| `rounds` | rounds fired in the window |
| `hits` | rounds that arrived on the player |

The window is 14 s on both sides, so an engagement that produced no kill produced
none inside the same amount of time.
