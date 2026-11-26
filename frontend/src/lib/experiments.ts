/**
 * A/B experiments. Each new visitor gets one variant of every experiment at random and keeps it; they can switch to
 * another variant under Customize at any time. The core stores what each visitor was assigned, what they are on
 * now, their switches and the goals they reach (see AbController), and the admin dashboard sums it up by the
 * assigned variant, so the comparison stays fair while the switches show which version people prefer.
 *
 * With about a hundred visitors that between-visitors comparison can only spot big differences, so the experiments
 * that are a matter of taste are also asked about directly in the taste test (TasteTest.tsx): two versions side by
 * side, "which do you prefer?". Each answer compares two versions for the same person, which tells far more per
 * visitor (see docs/ab-testing.md).
 *
 * The music is two levels: `music_pack` picks the pack (musicPacks.ts), and each pack with several versions of its
 * track has its own experiment, `music_<pack>`, for the version (its `parent` is the pack). Every visitor is given a
 * version of every pack, so whichever pack they end up on, they hear a fairly drawn version of it.
 *
 * To add an experiment: add it to EXPERIMENTS, read it with variant('key') where the UI differs, and call
 * expose('key') where people actually see or hear it (see Slots.tsx, sounds.ts). To add a version to a running
 * experiment, give it `since` (abAssign.ts) so the visitors already in the test keep theirs. To take a version out,
 * move it to `retired`: the dashboard still names it in the data it has, and anyone on it goes back to the version
 * they were given.
 *
 * Testers can force variants with ?ab=theme:archmother,slot_icons:classic. Forced variants stay for the browser tab and
 * are not reported, so Lighthouse runs and QA don't count as visitors.
 */
import { createEffect, createRenderEffect, createRoot, createSignal, on } from 'solid-js';
import { get, post } from '../api/client';
import { draw, ROUND, roundOf } from './abAssign';
import { auth } from './auth';
import { EXPERIMENTS, experiment, type Goal } from './experimentRegistry';

export { EXPERIMENTS, RETIRED_EXPERIMENTS, experiment, variantLabel, type Experiment, type Goal } from './experimentRegistry';

/** Where a switch came from: the Customize panel or a taste-test answer. */
export type SwitchSource = 'customize' | 'taste_test';

export interface Vote {
  experiment: string;
  /** The version shown on the left and on the right (the dashboard checks people don't just pick a side). */
  left: string;
  right: string;
  /** null: "no preference". */
  winner: string | null;
  /** Both versions were tried (seen on the page or listened to) before answering. */
  previewedBoth: boolean;
  decisionMs: number;
}

const VISITOR_KEY = 'naebka.visitor';
const ROUND_KEY = 'naebka.ab.round';
const CHOICES_KEY = 'naebka.ab.choices';
const ASSIGNED_KEY = 'naebka.ab.assigned';
const OVERRIDES_KEY = 'naebka.ab.overrides';
const GOALS_KEY = 'naebka.ab.goals';
/** Switches made under Customize within this many ms are reported as one (from the first to the last). */
const SWITCH_SETTLE_MS = 1500;

function read<T>(storage: Storage | undefined, key: string, fallback: T): T {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(storage: Storage | undefined, key: string, value: unknown) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked (private mode): choices just won't survive a reload
  }
}

const local = typeof localStorage === 'undefined' ? undefined : localStorage;
const session = typeof sessionStorage === 'undefined' ? undefined : sessionStorage;

/** Whether `id` is a variant of the experiment people can be on now. */
const isVariant = (key: string, id: unknown) => typeof id === 'string' && !!EXPERIMENTS.find((e) => e.key === key)?.variants.some((v) => v.id === id);

/** Only the entries that are variants people can be on now (old experiments and retired variants dropped). */
function valid(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).filter(([k, v]) => isVariant(k, v)));
}

/** ?ab=theme:archmother,slot_icons:classic forces variants for this tab. */
function loadOverrides(): Record<string, string> {
  const saved = valid(read<Record<string, string>>(session, OVERRIDES_KEY, {}));
  const param = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('ab');
  if (param == null) return saved;
  const forced: Record<string, string> = {};
  for (const pair of param.split(',')) {
    const [key, value] = pair.split(':');
    if (isVariant(key!, value)) forced[key!] = value!;
  }
  write(session, OVERRIDES_KEY, forced);
  return forced;
}

export const ab = createRoot(() => {
  const hadVisitor = /^[0-9a-f-]{36}$/.test(String(read<string | null>(local, VISITOR_KEY, null)));
  const [visitorId, setVisitorId] = createSignal(hadVisitor ? read<string>(local, VISITOR_KEY, '') : crypto.randomUUID());
  if (!hadVisitor) write(local, VISITOR_KEY, visitorId());
  // The round of the random draw this visitor is in (abAssign.ts): visitors from before keep their versions.
  let round = roundOf(read<unknown>(local, ROUND_KEY, null), hadVisitor);
  write(local, ROUND_KEY, round);
  // Old choices (a retired theme, the old music stations) are dropped: those visitors go back to what they were given.
  const [choices, setChoices] = createSignal<Record<string, string>>(valid(read(local, CHOICES_KEY, {})));
  write(local, CHOICES_KEY, choices());
  // What the core says this visitor was given (after logging in on another device), which wins over the draw.
  const [known, setKnown] = createSignal<Record<string, string>>(valid(read(local, ASSIGNED_KEY, {})));
  // Shown for a moment by the taste test, without being chosen or reported.
  const [previews, setPreviews] = createSignal<Record<string, string>>({});
  const overrides = loadOverrides();
  const testing = Object.keys(overrides).length > 0;
  const exposed = new Set<string>();
  let pending = new Set<string>();

  const assigned = (key: string) => known()[key] ?? draw(experiment(key), visitorId(), round);

  /** The version the visitor is on: forced, chosen, or the one they were given. */
  const committed = (key: string) => {
    const pick = overrides[key] ?? choices()[key];
    return pick && isVariant(key, pick) ? pick : assigned(key);
  };

  /** What to show now: a taste-test preview if there is one, otherwise the committed version. */
  const variant = (key: string) => previews()[key] ?? committed(key);

  const send = (path: string, body: object) => {
    if (testing) return;
    post(path, { visitorId: visitorId(), ...body }).catch(() => {
      // analytics must never break the site
    });
  };

  const flush = () => {
    const keys = [...pending];
    pending = new Set();
    if (keys.length) send('/api/ab/assignments', { assignments: keys.map((k) => ({ experiment: k, assigned: assigned(k), current: committed(k) })) });
  };

  /** Records that the visitor saw (or heard) this experiment (once per page load; calls in one tick share a request). */
  const expose = (key: string) => {
    if (exposed.has(key)) return;
    exposed.add(key);
    if (pending.size === 0) queueMicrotask(flush);
    pending.add(key);
  };

  // Switching back and forth under Customize (trying the themes, say) is reported once it settles, as one switch from
  // where the visitor started to where they ended (none if they came back).
  const settling = new Map<string, { from: string; timer: number }>();
  const report = (key: string) => {
    const s = settling.get(key);
    if (!s) return;
    window.clearTimeout(s.timer);
    settling.delete(key);
    const to = committed(key);
    if (s.from !== to) send('/api/ab/switches', { experiment: key, assigned: assigned(key), from: s.from, to, source: 'customize' });
  };
  if (typeof window !== 'undefined') window.addEventListener('pagehide', () => [...settling.keys()].forEach(report));

  /** Switches to another variant. Picking the assigned one clears the choice. */
  const choose = (key: string, to: string, source: SwitchSource = 'customize') => {
    if (!isVariant(key, to)) return;
    // A taste-test answer is reported at once; a Customize switch still settling goes first, as it was.
    if (source === 'taste_test') report(key);
    const from = committed(key);
    if (from === to) return;
    const next = { ...choices() };
    if (to === assigned(key)) delete next[key];
    else next[key] = to;
    setChoices(next);
    write(local, CHOICES_KEY, next);
    if (source === 'taste_test') {
      send('/api/ab/switches', { experiment: key, assigned: assigned(key), from, to, source });
      return;
    }
    const s = settling.get(key);
    if (s) window.clearTimeout(s.timer);
    settling.set(key, { from: s?.from ?? from, timer: window.setTimeout(() => report(key), SWITCH_SETTLE_MS) });
  };

  /** Shows a version without choosing it (the taste test's "try it"); null ends the preview. */
  const preview = (key: string, to: string | null) => {
    const next = { ...previews() };
    if (to == null) delete next[key];
    else next[key] = to;
    setPreviews(next);
  };

  /** Counts a goal, at most once per tab (the core keeps only the first one per visitor anyway). */
  const track = (goal: Goal) => {
    const done = read<string[]>(session, GOALS_KEY, []);
    if (done.includes(goal)) return;
    write(session, GOALS_KEY, [...done, goal]);
    send('/api/ab/goals', { goal });
  };

  /** One taste-test answer. */
  const vote = (v: Vote) => send('/api/ab/votes', v);

  // After logging in on another device, take over that device's visitor id, what it was given and its choices, so
  // the player keeps the versions they had and isn't counted twice. Then (re)send what this page has shown, linked to
  // the account.
  createEffect(
    on(
      () => auth.user()?.id,
      (userId) => {
        if (!userId || testing) return;
        get<{ visitorId: string | null; choices: Record<string, string>; assigned?: Record<string, string> }>('/api/ab/mine')
          .then((mine) => {
            if (mine.visitorId && mine.visitorId !== visitorId()) {
              [...settling.keys()].forEach(report);
              setVisitorId(mine.visitorId);
              write(local, VISITOR_KEY, mine.visitorId);
              // Experiments that visitor never saw are drawn as for someone new.
              round = ROUND;
              write(local, ROUND_KEY, round);
              setKnown(valid(mine.assigned ?? {}));
              write(local, ASSIGNED_KEY, known());
              setChoices(valid(mine.choices));
              write(local, CHOICES_KEY, choices());
            }
          })
          .catch(() => {})
          .finally(() => {
            pending = new Set(exposed);
            flush();
          });
      },
      { defer: true },
    ),
  );

  // Themes are applied with a data attribute on <html>; styles.css has the variables for each one, and the Deadlock
  // style (font, moving background, wobbling buttons) they all share. A render effect runs straight away, so the page
  // never flashes another theme.
  if (typeof document !== 'undefined') {
    createRenderEffect(() => {
      document.documentElement.dataset.abTheme = variant('theme');
      document.documentElement.dataset.abStyle = 'deadlock';
    });
  }

  return {
    visitorId,
    variant,
    committed,
    assigned,
    /** True when the visitor picked this experiment's variant themself. */
    chosen: (key: string) => committed(key) !== assigned(key),
    /** Forced with ?ab= for testing; nothing is reported. */
    testing,
    expose,
    choose,
    preview,
    track,
    vote,
    /** Every experiment's version, attached to feedback. */
    snapshot: () => Object.fromEntries(EXPERIMENTS.map((e) => [e.key, committed(e.key)])),
  };
});
