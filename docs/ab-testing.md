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

With 100 visitors and four themes, each theme gets about 25 people, so only huge differences would show. Combinations
are worse: 4 themes × 10 music packs × 4 sound packs × 2 symbol sets is 320 combinations, far fewer than one person
each. And
a feedback button in the corner is used by a few percent of visitors at best, so with 100 people we'd get a handful of
ratings, none saying *which* part (theme or music) they were rating.

## What we do instead: three layers

### 1. The taste test (the main evidence)

A small card asks "which do you like more?" with **two versions side by side**, one question per experiment (theme,
music, sound effects, slot symbols), plus, after the music, which version of the music pack just picked (see *Music
packs and their versions* below): four or five taps in about half a minute. People try both, by switching the page to it or
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
  to the same loudness (EBU R128, measured by ffmpeg at build time), and each music preview (12 seconds) starts at a
  stretch of typical loudness, not its loudest moment; the versions of the hideout loop, which are layers of one track,
  are all previewed from the same moment.
* **"No preference" is an answer**, so nobody is forced into a coin toss.
* **Only real candidates.** A version marked `pickOnly` can be chosen under Customize but isn't in the test (it isn't
  going to be the default). None is at the moment: the old Classic look, which was one, has been taken out.
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
| Music (the pack, and the version within each pack) | Turned the music off (or muted everything) while it played | lower |
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

The dashboard counts the reasons. With small numbers, "8 people said the music is annoying, all on Teleporter" says more
than an average.

**Asking without annoying** (`frontend/src/lib/prompts.ts`): prompts appear only while someone is actively using the
site, never on forms (login, register, wallet, verification), never two at once or one right after another, each at
most once per visitor, always with a "Not now". Nothing is asked in a tab opened with `?ab=`.

## Music packs and their versions

The music is tested at two levels. `music_pack` is the pack: ten groups of Deadlock's music, as the
[Deadlock Wiki](https://deadlock.wiki/Music) groups it (`frontend/src/lib/musicPacks.ts`). Six packs have several
versions of their track, and each of those is an experiment of its own, `music_<pack>`:

| Experiment | Versions |
|---|---|
| `music_hideout` | the main hideout loop: Base, Low Tempo, High Tempo |
| `music_matchmaking` | Wait (the search loop), Retired (the old "Connecting to Match") |
| `music_hotel` | the Baroness Hotel's record, Near or Far |
| `music_curio` | the Curiosity Shop, Standard or Alternate |
| `music_seasonal` | the winter event: Main menu, Standard shop, Secret shop |
| `music_teleporter` | the unused teleporter music: Music 01, Comp, Melody |

The other four packs (Deadlock's title screen, the Ambient Waltz and Choir, and Paying the Price) are one track each.

* **Every visitor is given a version of every pack**, at random like everything else, so whichever pack they end up
  on (given, picked, or picked in the taste test) they hear a fairly drawn version of it. A version experiment counts
  someone only once they have heard that pack.
* **The taste test asks about the version right after the music**: "which version of the Hideout do you like
  more?", for the pack the person just picked (or the one they're on, if they had no preference). Asking about the
  pack people chose keeps the question about music they like, and it keeps the test short.
* **Under Customize > Sound** the pack's versions are buttons under the packs; switching one switches the music.
* **On the dashboard** the packs are ranked bars (ten are too many for a pie), and each pack's versions have their own
  small chart, in the taste test and in "Who is on which version now".

The first music test, four "stations" (`music`: Lounge, Hideout, Gothic, Rift Fight), ended when the packs replaced
them. The packs are a new experiment key, so the two tests' numbers don't mix; the stations' results stay in the
database and on the dashboard, marked *ended*.

## Adding a version to a running test

The Christmas theme and the Christmas sounds were added to experiments that already had visitors. Giving everyone a
new draw would have changed the theme under returning visitors (and the dashboard counts each visitor under the
version they were first given, so their numbers would be wrong). So the draw has rounds (`frontend/src/lib/abAssign.ts`):

* every visitor belongs to the round in which they first came (stored in their browser);
* a version added later says which round it joined (`since: 2`), and a visitor is only drawn from the versions of
  their round: visitors from before keep exactly the version they had, and new visitors are drawn from all of them;
* after logging in on another device, the site takes the versions the account was given from the core, so they
  follow the player even where the draw would differ.

Read the new versions' numbers with that in mind: Christmas has only visitors from after it was added, so it is
compared with the others over a shorter, later stretch. The taste test is not affected (everyone can be asked about
every pair). A version taken out (Classic) moves to `retired`: anyone still on it goes back to the version they were
given, and the dashboard shows its old numbers as *removed*.

## Which combination is best?

Each experiment is judged on its own, and **the best combination is the best of each**. Measuring which theme goes
best with which music would need each combination to be tested, which a hundred visitors can't do. Effects like that
are usually small next to the main ones. If the team suspects one (say, the Seasonal music only works with the
Christmas theme), test that pair directly next time.

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

* Check <https://poker.naebka.win/music/manifest.json> lists 40 files (the music is built into the image; without
  it the music experiments have nothing to compare).
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
| Experiments, primary metrics, taste-test questions | `frontend/src/lib/experimentRegistry.ts` |
| Giving versions, choices, reporting | `frontend/src/lib/experiments.ts`, the draw and its rounds in `abAssign.ts` |
| The music packs and their versions | `frontend/src/lib/musicPacks.ts` (files: `frontend/scripts/wiki_music.py`) |
| Taste test, invitation | `frontend/src/components/TasteTest.tsx` |
| One-tap rating, reason chips | `frontend/src/components/QuickRating.tsx` |
| When prompts appear | `frontend/src/lib/prompts.ts` |
| Statistics (Bradley–Terry, bootstrap, Wilson, Beta) | `frontend/src/lib/stats.ts`, `stats.test.ts` |
| Dashboard cards and CSV export | `frontend/src/components/adminAb.tsx` |
| Storage and endpoints | `core/.../ab/AbController.java`, `V8__experiments.sql`, `V9__taste_test.sql`, `AbIT` |
