/**
 * The A/B experiments: their versions, the number each is judged on and its taste-test question. Plain data (the
 * store that gives visitors their versions and reports what they do is experiments.ts), so the tests can read it.
 * How to add an experiment or a version is in experiments.ts.
 */
import { MUSIC_PACKS } from './musicPacks';

/** Goals counted per variant on the admin dashboard. The last two are reactions to the audio. */
export type Goal = 'registered' | 'bet_placed' | 'slot_spin' | 'poker_sit' | 'music_off' | 'sounds_off';

export interface Experiment {
  key: string;
  title: string;
  description: string;
  /**
   * The first variant is the control. A pickOnly variant is never given at random and isn't in the taste test;
   * people can only choose it under Customize. `since`: the round it joined the random draw (abAssign.ts).
   */
  variants: { id: string; label: string; pickOnly?: boolean; since?: number }[];
  /** Variants taken out: offered nowhere, but the dashboard still names them in the data they have. */
  retired?: { id: string; label: string }[];
  /** The round the experiment started in (abAssign.ts); 1 if not given. */
  since?: number;
  /** A music pack's versions: the pack they belong to (a variant of `music_pack`). */
  parent?: { key: string; variant: string };
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

/** A music pack's versions, one experiment per pack that has more than one. */
const musicVersions: Experiment[] = MUSIC_PACKS.filter((p) => p.versions.length > 1).map((p) => ({
  key: `music_${p.id}`,
  title: `${p.title} version`,
  description: `Which version of ${p.title} plays.`,
  variants: p.versions.map((v) => ({ id: v.id, label: v.label })),
  since: 2,
  parent: { key: 'music_pack', variant: p.id },
  switchable: true,
  group: 'sound',
  primary: { metric: 'music_off', better: 'lower' },
  taste: { question: `Which version of “${p.title}” do you like more?`, tryBy: 'listen' },
}));

export const EXPERIMENTS: Experiment[] = [
  {
    key: 'theme',
    title: 'Theme',
    description: 'The colours and style of the whole site.',
    variants: [
      { id: 'hidden_king', label: 'Hidden King' },
      { id: 'archmother', label: 'Archmother' },
      { id: 'deadlock', label: 'Deadlock' },
      { id: 'christmas', label: 'Christmas', since: 2 },
    ],
    retired: [{ id: 'classic', label: 'Classic' }],
    switchable: true,
    group: 'look',
    primary: { metric: 'changed', better: 'lower' },
    taste: { question: 'Which look do you like more?', tryBy: 'page' },
  },
  {
    key: 'music_pack',
    title: 'Music',
    description: 'Deadlock’s soundtrack, in packs.',
    variants: MUSIC_PACKS.map((p) => ({ id: p.id, label: p.title })),
    since: 2,
    switchable: true,
    group: 'sound',
    primary: { metric: 'music_off', better: 'lower' },
    taste: { question: 'Which music do you like more?', tryBy: 'listen' },
  },
  ...musicVersions,
  {
    key: 'sfx_pack',
    title: 'Sound effects',
    description: 'What buttons, spins and wins sound like.',
    variants: [
      { id: 'deadlock', label: 'Deadlock' },
      { id: 'arcade', label: 'Arcade' },
      { id: 'soft', label: 'Soft' },
      { id: 'christmas', label: 'Christmas', since: 2 },
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

/**
 * Experiments that have ended. Nothing on the site uses them; the dashboard still shows their data (the music
 * stations were replaced by the packs in November 2026, under a new key so their numbers don't mix).
 */
export const RETIRED_EXPERIMENTS: Experiment[] = [
  {
    key: 'music',
    title: 'Music stations (ended)',
    description: 'The first music test: four stations of Deadlock’s soundtrack.',
    variants: [
      { id: 'lounge', label: 'Lounge' },
      { id: 'hideout', label: 'Hideout' },
      { id: 'gothic', label: 'Gothic' },
      { id: 'rift', label: 'Rift Fight', pickOnly: true },
    ],
    switchable: false,
    group: 'sound',
    primary: { metric: 'music_off', better: 'lower' },
    taste: { question: 'Which music do you like more?', tryBy: 'listen' },
  },
];

export function experiment(key: string): Experiment {
  const exp = EXPERIMENTS.find((e) => e.key === key);
  if (!exp) throw new Error(`Unknown experiment ${key}`);
  return exp;
}

/** A variant's name, also for retired experiments and variants (the dashboard's older data). */
export function variantLabel(key: string, id: string): string {
  const exp = [...EXPERIMENTS, ...RETIRED_EXPERIMENTS].find((e) => e.key === key);
  return [...(exp?.variants ?? []), ...(exp?.retired ?? [])].find((v) => v.id === id)?.label ?? id;
}
