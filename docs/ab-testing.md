# Choosing the look and sound: A/B tests, the taste test and feedback

How Naebka finds out which **theme, slot symbols, music and sound effects** people like best, with about a hundred
visitors in one day who get nothing for answering. What to do on test day is [at the end](#test-day-checklist).

## Why plain A/B testing isn't enough here

A classic A/B test gives each visitor one version at random and compares what the groups do (register, bet, leave).
It is fair, but it needs a lot of people:

| To tell apart (per group) | Visitors needed per version (80% power, p < 0.05) |
|---|---|
| 10% vs 15% | 686 |
| 20% vs 40% | 81 |
| 30% vs 60% | 42 |

With 100 visitors and three themes, each theme gets about 33 people, so only huge differences would show. Combinations
are worse: 3 themes × 3 stations × 3 sound packs × 2 symbol sets is 54 combinations, fewer than two people each. And
a feedback button in the corner is used by a few percent of visitors at best, so with 100 people we'd get a handful of
ratings, none saying *which* part (theme or music) they were rating.

## What we do instead: three layers

### 1. The taste test (the main evidence)

A small card asks "which do you like more?" with **two versions side by side**, one question per experiment (theme,
music, sound effects, slot symbols): four taps in about half a minute. People try both, by switching the page to it or
listening to it, then pick one, **and they keep what they picked**. Answering is its own reward, which is what gets
people to take part when they aren't paid to.

Why this works with few people:

* **Each answer compares two versions for the same person.** Differences between people ("some like everything",
  "some hate music") cancel out, so one answer carries far more information than one visitor in a group.
* **Every participant answers every experiment**, so 40 participants give 40 answers per experiment, not 40 split
  three ways.
* The power of a paired preference (two-sided exact binomial test):

  | Answers | 60/40 | 65/35 | 70/30 | 75/25 | 80/20 |
  |---|---|---|---|---|---|
  | 20 | 13% | 25% | 42% | 62% | 80% |
  | 40 | 21% | 44% | 70% | 90% | 98% |
  | 60 | 26% | 56% | 84% | 97% | 100% |
  | 100 | 46% | 83% | 98% | 100% | 100% |

  With ~40 answers, a clear favourite (three out of four people) is found nine times in ten; a slight lean (60/40)
  is not, and the dashboard says "too close to call" rather than pretending.

Keeping the answers honest:

* **Random pairs, random sides.** Each experiment's pair is drawn at random among its candidates and the sides are
  shuffled, so no version is favoured by being first or on the left. The dashboard checks it: if the left side wins
  far more than half the time, people are clicking a side, not choosing.
* **Try both first.** The pick buttons only unlock after both versions have been tried (seen on the page or listened
  to); a theme the visitor is already on counts as seen. Slot symbols are pictures, so they're compared at a glance.
* **Equal loudness.** Deadlock's tracks differ in loudness by up to 25 dB (the hotel's record is mixed far quieter
  than the title theme), and in listening tests the louder option tends to win. Every track and stinger is evened out
  to the same loudness (EBU R128, measured by ffmpeg at build time), and each station's 12-second preview starts at a
  stretch of typical loudness, not its loudest moment.
* **"No preference" is an answer**, so nobody is forced into a coin toss.
* **Only real candidates.** Versions marked `pickOnly` (the old Classic look, the Rift Fight station) can be chosen
  under Customize but aren't in the test: they aren't going to be the default.
* Each answer is sent at once, so people who stop after one question still count. Answering the same pair again
  replaces the earlier answer.

How it's analysed (`frontend/src/lib/stats.ts`, unit-tested):

* A **Bradley–Terry model** ranks all versions of an experiment from all the head-to-heads at once (A beat B, B beat
  C → A is likely above C), giving each version a share of the preference.
* **Chance it's the favourite**: the test is re-run 1,000 times in simulation (answers drawn from the fitted model, as
  many per pair as were given, then the model re-fitted), counting how often each version comes out on top. This is
  the number decisions are made on. A single 1–0 answer gives about 70%, not a false 100%.
* **Win rate with a 95% range** (Wilson interval) for each version, and the raw head-to-head counts.

### 2. Random assignment (supporting evidence)

Everyone is still given one version of each experiment at random (and can switch under Customize). This shows what
people *do*, not just what they say. Each experiment is judged on **one number chosen in advance** (its primary metric,
in `frontend/src/lib/experiments.ts`), so nobody goes looking through twenty numbers for one that agrees:

| Experiment | Primary metric (between visitors) | Better |
|---|---|---|
| Theme, slot symbols | Switched away from it by hand under Customize | lower |
| Music | Turned the music off (or muted everything) while it played | lower |
| Sound effects | Turned the sounds off (or muted everything) | lower |
| Sign-up button | Registered | higher |

Instead of a p-value, the dashboard gives each version's **chance of truly being best** on that number (Beta
posteriors). Switches made by answering the taste test are counted separately, so they don't look like people
fleeing a version. The audio experiments are only counted once people actually *hear* them.

### 3. The one-tap rating (context)

Five faces, one tap. The rating is saved on the first tap; then a few reason chips ("Love the music", "Hard to read",
"Sounds are annoying"…) and an optional comment. It is asked at the end of the taste test, or for people who skipped
it, once, after about two and a half minutes of active use. The Feedback button in the corner stays for bug reports
and longer comments. Every rating carries the versions the person was on.

The dashboard counts the reasons. With small numbers, "8 people said the music is annoying, all on Gothic" says more
than an average.

**Asking without annoying** (`frontend/src/lib/prompts.ts`): prompts appear only while someone is actively using the
site, never on forms (login, register, wallet, verification), never two at once or one right after another, each at
most once per visitor, always with a "Not now". Nothing is asked in a tab opened with `?ab=`.

## Which combination is best?

Each experiment is judged on its own, and **the best combination is the best of each**. Measuring which theme goes
best with which music would need each combination to be tested, which a hundred visitors can't do. Effects like that
are usually small next to the main ones. If the team suspects one (say, the Gothic music only works with the
Archmother theme), test that pair directly next time.

## The decision rule (agree on it before test day)

For each experiment, on the dashboard's **Recommended combination** card:

1. **Clear winner** (95%+ chance it's the favourite): make it the default.
2. **Likely winner** (80–95%): make it the default, unless its between-visitors number is clearly worse (the other
   version is a likely winner there).
3. **Too close to call** (under 80%): people don't mind which. Keep the current default, or decide on other grounds
   (cost, consistency). This is a result too.
4. **Too early** (fewer than 10 answers): no decision; test again.

Don't stop early because a version leads after the first ten answers: early leads often vanish. Run the planned day,
then decide.

## Test-day checklist

Before:

* Check <https://poker.naebka.win/music/manifest.json> lists 36 files. Without music the music experiment has
  nothing to compare: upload it to the server once (deploy/README.md, "Music").
* Test everything with `?ab=` in the address (for example `?ab=theme:archmother`) so your own clicks aren't counted.
  The taste test opens from Customize or the footer link "Pick your style" (it doesn't pop up by itself with `?ab=`).
* Optional: start from empty tables, so earlier tries don't count (this deletes all A/B data and feedback):
  `docker compose exec postgres psql -U naebka -c "TRUNCATE ab_votes, ab_switches, ab_goals, ab_assignments, feedback"`.
* Rate limits are per visitor (with a generous per-address limit), so a whole classroom on one network is fine.

During: `/admin` shows everything live (it refreshes every 30 s): the recommendation, the taste test, the
between-visitors table and the feedback with its reasons.

After: download the three CSVs on `/admin` (taste-test answers, visitors, feedback) for the report, and apply the
rule above. The visitors CSV has one row per visitor: what they were given, what they ended on, which goals they
reached, how often they switched and how many taste-test questions they answered.

## Where it is in the code

| What | Where |
|---|---|
| Experiments, primary metrics, taste-test questions | `frontend/src/lib/experiments.ts` |
| Taste test, invitation | `frontend/src/components/TasteTest.tsx` |
| One-tap rating, reason chips | `frontend/src/components/QuickRating.tsx` |
| When prompts appear | `frontend/src/lib/prompts.ts` |
| Statistics (Bradley–Terry, bootstrap, Wilson, Beta) | `frontend/src/lib/stats.ts`, `stats.test.ts` |
| Dashboard cards and CSV export | `frontend/src/components/adminAb.tsx` |
| Storage and endpoints | `core/.../ab/AbController.java`, `V8__experiments.sql`, `V9__taste_test.sql`, `AbIT` |
