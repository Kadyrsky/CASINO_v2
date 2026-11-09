/**
 * A/B experiments. Each new visitor gets one variant of every experiment at random and keeps it; they can switch to
 * another variant under Appearance at any time. The core stores what each visitor was assigned, what they are on
 * now, their switches and the goals they reach (see AbController), and the admin dashboard sums it up by the
 * assigned variant, so the comparison stays fair while the switches show which version people prefer.
 *
 * To add an experiment: add it to EXPERIMENTS, read it with variant('key') where the UI differs, and call
 * expose('key') where people actually see it (see Slots.tsx).
 *
 * Testers can force variants with ?ab=theme:archmother,slot_icons:classic. Forced variants stay for the browser tab and
 * are not reported, so Lighthouse runs and QA don't count as visitors.
 */
import { createEffect, createRenderEffect, createRoot, createSignal, on } from 'solid-js';
import { get, post } from '../api/client';
import { auth } from './auth';

export interface Experiment {
  key: string;
  title: string;
  description: string;
  /**
   * The first variant is the control. A pickOnly variant is never given at random; people can only choose it
   * under Customize (e.g. the old look, for those who prefer it).
   */
  variants: { id: string; label: string; pickOnly?: boolean }[];
  /** Shown under Appearance so people can pick it themselves. */
  switchable: boolean;
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
  },
];

/** Goals counted per variant on the admin dashboard. */
export type Goal = 'registered' | 'bet_placed' | 'slot_spin' | 'poker_sit';

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

function byKey(key: string): Experiment {
  const exp = EXPERIMENTS.find((e) => e.key === key);
  if (!exp) throw new Error(`Unknown experiment ${key}`);
  return exp;
}

export const ab = createRoot(() => {
  const [visitorId, setVisitorId] = createSignal(loadVisitorId());
  const [choices, setChoices] = createSignal<Record<string, string>>(read(local, CHOICES_KEY, {}));
  const overrides = loadOverrides();
  const testing = Object.keys(overrides).length > 0;
  const exposed = new Set<string>();
  let pending = new Set<string>();

  const assigned = (key: string) => {
    const pool = byKey(key).variants.filter((v) => !v.pickOnly);
    return pool[hash(`${visitorId()}:${key}`) % pool.length]!.id;
  };

  const variant = (key: string) => {
    const exp = byKey(key);
    const pick = overrides[key] ?? choices()[key];
    return pick && exp.variants.some((v) => v.id === pick) ? pick : assigned(key);
  };

  const send = (path: string, body: object) => {
    if (testing) return;
    post(path, { visitorId: visitorId(), ...body }).catch(() => {
      // analytics must never break the site
    });
  };

  const flush = () => {
    const keys = [...pending];
    pending = new Set();
    if (keys.length) send('/api/ab/assignments', { assignments: keys.map((k) => ({ experiment: k, assigned: assigned(k), current: variant(k) })) });
  };

  /** Records that the visitor saw this experiment (once per page load; calls in the same tick go in one request). */
  const expose = (key: string) => {
    if (exposed.has(key)) return;
    exposed.add(key);
    if (pending.size === 0) queueMicrotask(flush);
    pending.add(key);
  };

  /** Switches to another variant by hand. Picking the assigned one clears the choice. */
  const choose = (key: string, to: string) => {
    const from = variant(key);
    if (from === to) return;
    const next = { ...choices() };
    if (to === assigned(key)) delete next[key];
    else next[key] = to;
    setChoices(next);
    write(local, CHOICES_KEY, next);
    send('/api/ab/switches', { experiment: key, assigned: assigned(key), from, to });
  };

  /** Counts a goal, at most once per tab (the core keeps only the first one per visitor anyway). */
  const track = (goal: Goal) => {
    const done = read<string[]>(session, GOALS_KEY, []);
    if (done.includes(goal)) return;
    write(session, GOALS_KEY, [...done, goal]);
    send('/api/ab/goals', { goal });
  };

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
    assigned,
    /** True when the visitor picked this experiment's variant themself. */
    chosen: (key: string) => variant(key) !== assigned(key),
    /** Forced with ?ab= for testing; nothing is reported. */
    testing,
    expose,
    choose,
    track,
    /** Every experiment's current variant, attached to feedback. */
    snapshot: () => Object.fromEntries(EXPERIMENTS.map((e) => [e.key, variant(e.key)])),
  };
});
