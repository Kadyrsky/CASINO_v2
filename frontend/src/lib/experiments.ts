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
 * To add an experiment: add it to EXPERIMENTS, read it with variant('key') where the UI differs, and call
 * expose('key') where people actually see or hear it (see Slots.tsx, sounds.ts).
 *
 * Testers can force variants with ?ab=theme:archmother,slot_icons:classic. Forced variants stay for the browser tab and
 * are not reported, so Lighthouse runs and QA don't count as visitors.
 */
import { createEffect, createRenderEffect, createRoot, createSignal, on } from 'solid-js';
import { get, post } from '../api/client';
import { auth } from './auth';

/** Goals counted per variant on the admin dashboard. The last two are reactions to the audio. */
export type Goal = 'registered' | 'bet_placed' | 'slot_spin' | 'poker_sit' | 'music_off' | 'sounds_off';

export interface Experiment {
  key: string;
  title: string;
  description: string;
  /**
   * The first variant is the control. A pickOnly variant is never given at random and isn't in the taste test;
   * people can only choose it under Customize (e.g. the old look, for those who prefer it).
   */
  variants: { id: string; label: string; pickOnly?: boolean }[];
  /** Shown under Customize so people can pick it themselves. */
  switchable: boolean;
  /** The Customize tab it is on. */
  group: 'look' | 'sound' | 'text';
  /**
   * The one number the between-visitors comparison is judged on, chosen before the test so nobody goes fishing
   * among many numbers afterwards. 'changed' = switched away by hand under Customize.
   */
  primary: { metric: Goal | 'changed'; better: 'lower' | 'higher' };
  /** In the taste test: the question, and how people try both versions (switch the page, listen, or just look). */
  taste?: { question: string; tryBy: 'page' | 'listen' | 'look' };
}

export const EXPERIMENTS: Experiment[] = [
  {
    key: 'theme',
    title: 'Theme',
    description: 'The colours and style of the whole site.',
    variants: [
      { id: 'hidden_king', label: 'Hidden King' },
      { id: 'archmother', label: 'Archmother' },
      { id: 'deadlock', label: 'Deadlock' },
      { id: 'classic', label: 'Classic', pickOnly: true },
    ],
    switchable: true,
    group: 'look',
    primary: { metric: 'changed', better: 'lower' },
    taste: { question: 'Which look do you like more?', tryBy: 'page' },
  },
  {
    key: 'music',
    title: 'Music',
    description: 'Deadlock’s soundtrack, in stations.',
    variants: [
      { id: 'lounge', label: 'Lounge' },
      { id: 'hideout', label: 'Hideout' },
      { id: 'gothic', label: 'Gothic' },
      { id: 'rift', label: 'Rift Fight', pickOnly: true },
    ],
    switchable: true,
    group: 'sound',
    primary: { metric: 'music_off', better: 'lower' },
    taste: { question: 'Which music do you like more?', tryBy: 'listen' },
  },
  {
    key: 'sfx_pack',
    title: 'Sound effects',
    description: 'What buttons, spins and wins sound like.',
    variants: [
      { id: 'deadlock', label: 'Deadlock' },
      { id: 'arcade', label: 'Arcade' },
      { id: 'soft', label: 'Soft' },
    ],
    switchable: true,
    group: 'sound',
    primary: { metric: 'sounds_off', better: 'lower' },
    taste: { question: 'Which sounds do you like more?', tryBy: 'listen' },
  },
  {
    key: 'slot_icons',
    title: 'Slot symbols',
    description: 'The pictures on the Soul Reels slot machine.',
    variants: [
      { id: 'deadlock', label: 'Deadlock items' },
      { id: 'classic', label: 'Classic fruit' },
    ],
    switchable: true,
    group: 'look',
    primary: { metric: 'changed', better: 'lower' },
    taste: { question: 'Which slot symbols do you like more?', tryBy: 'look' },
  },
  {
    key: 'join_cta',
    title: 'Sign-up button',
    description: 'The text of the sign-up button in the header.',
    variants: [
      { id: 'join', label: 'Join' },
      { id: 'bonus', label: 'Get 1,000 free NTK' },
    ],
    switchable: false,
    group: 'text',
    primary: { metric: 'registered', better: 'higher' },
  },
];

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
const CHOICES_KEY = 'naebka.ab.choices';
const OVERRIDES_KEY = 'naebka.ab.overrides';
const GOALS_KEY = 'naebka.ab.goals';

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

function loadVisitorId(): string {
  const id = read<string | null>(local, VISITOR_KEY, null);
  if (id && /^[0-9a-f-]{36}$/.test(id)) return id;
  const fresh = crypto.randomUUID();
  write(local, VISITOR_KEY, fresh);
  return fresh;
}

/** ?ab=theme:archmother,slot_icons:classic forces variants for this tab. */
function loadOverrides(): Record<string, string> {
  const saved = read<Record<string, string>>(session, OVERRIDES_KEY, {});
  const param = new URLSearchParams(location.search).get('ab');
  if (param == null) return saved;
  const forced: Record<string, string> = {};
  for (const pair of param.split(',')) {
    const [key, value] = pair.split(':');
    const exp = EXPERIMENTS.find((e) => e.key === key);
    if (exp && exp.variants.some((v) => v.id === value)) forced[key!] = value!;
  }
  write(session, OVERRIDES_KEY, forced);
  return forced;
}

/** FNV-1a: a stable number from the visitor id and the experiment, so assignment needs no server call. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function experiment(key: string): Experiment {
  const exp = EXPERIMENTS.find((e) => e.key === key);
  if (!exp) throw new Error(`Unknown experiment ${key}`);
  return exp;
}

export function variantLabel(key: string, id: string): string {
  return EXPERIMENTS.find((e) => e.key === key)?.variants.find((v) => v.id === id)?.label ?? id;
}

export const ab = createRoot(() => {
  const [visitorId, setVisitorId] = createSignal(loadVisitorId());
  const [choices, setChoices] = createSignal<Record<string, string>>(read(local, CHOICES_KEY, {}));
  // Shown for a moment by the taste test, without being chosen or reported.
  const [previews, setPreviews] = createSignal<Record<string, string>>({});
  const overrides = loadOverrides();
  const testing = Object.keys(overrides).length > 0;
  const exposed = new Set<string>();
  let pending = new Set<string>();

  const assigned = (key: string) => {
    const pool = experiment(key).variants.filter((v) => !v.pickOnly);
    return pool[hash(`${visitorId()}:${key}`) % pool.length]!.id;
  };

  /** The version the visitor is on: forced, chosen, or the one they were given. */
  const committed = (key: string) => {
    const exp = experiment(key);
    const pick = overrides[key] ?? choices()[key];
    return pick && exp.variants.some((v) => v.id === pick) ? pick : assigned(key);
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

  /** Switches to another variant. Picking the assigned one clears the choice. */
  const choose = (key: string, to: string, source: SwitchSource = 'customize') => {
    const from = committed(key);
    if (from === to) return;
    const next = { ...choices() };
    if (to === assigned(key)) delete next[key];
    else next[key] = to;
    setChoices(next);
    write(local, CHOICES_KEY, next);
    send('/api/ab/switches', { experiment: key, assigned: assigned(key), from, to, source });
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

  // After logging in on another device, take over that device's visitor id and choices, so the player keeps
  // the versions they had and isn't counted twice. Then (re)send what this page has shown, linked to the account.
  createEffect(
    on(
      () => auth.user()?.id,
      (userId) => {
        if (!userId || testing) return;
        get<{ visitorId: string | null; choices: Record<string, string> }>('/api/ab/mine')
          .then((mine) => {
            if (mine.visitorId && mine.visitorId !== visitorId()) {
              setVisitorId(mine.visitorId);
              write(local, VISITOR_KEY, mine.visitorId);
              setChoices(mine.choices);
              write(local, CHOICES_KEY, mine.choices);
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

  // Themes are applied with data attributes on <html>; styles.css has the variables for each one. The Deadlock
  // themes also switch on the Deadlock style (font, moving background, wobbling buttons); Classic is the old look.
  // A render effect runs straight away, so the page never flashes the other theme.
  createRenderEffect(() => {
    const theme = variant('theme');
    document.documentElement.dataset.abTheme = theme;
    if (theme === 'classic') delete document.documentElement.dataset.abStyle;
    else document.documentElement.dataset.abStyle = 'deadlock';
  });

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
