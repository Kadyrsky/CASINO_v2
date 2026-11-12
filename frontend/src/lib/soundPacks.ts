/**
 * Sound packs: what each event on the site sounds like. A pack is a set of small synth recipes (tones and filtered
 * noise, drawn by audio.ts), so it needs no files and plays without delay. The Deadlock pack also uses the game's
 * own stingers for the big moments, once they have loaded (the recipe plays until then). Which pack a visitor hears
 * is the `sfx_pack` experiment (experiments.ts); they can switch under Customize.
 *
 * To add a pack: add it to PACKS and as a variant of `sfx_pack` in experiments.ts, then calibrate it (below).
 *
 * The mix: LEVELS says how loud each event is, the same for every pack, so packs differ in character, not volume
 * (in the taste test the louder of two options tends to win). Each pack's `trim` brings its recipes to those
 * levels, and the Deadlock stingers are set to the level of the event they stand for. After changing a recipe,
 * recalibrate in the browser console of `vp dev`:
 *   (await import('/src/lib/soundPacks.ts')).suggestTrims('arcade').then(console.log)
 */
import { audio, hz, type ToneOptions, type Voice } from './audio';

export type SoundEvent =
  | 'click' // main (primary) buttons
  | 'tap' // other buttons, links and tabs
  | 'select' // picking one of several options
  | 'toggle' // switches and checkboxes
  | 'open'
  | 'close'
  | 'success'
  | 'error'
  | 'notify'
  | 'bet' // a bet placed
  | 'betWon' // a live bet settled
  | 'betLost'
  | 'spin' // slots
  | 'reelStop'
  | 'win'
  | 'streak' // a win straight after a win (n = how many in a row)
  | 'firstWin' // the first win of the visit
  | 'bigWin'
  | 'jackpot'
  | 'freeSpins'
  | 'bonus'
  | 'bonusPick'
  | 'bonusEnd'
  | 'lose'
  | 'deal' // poker
  | 'chips'
  | 'check'
  | 'fold'
  | 'yourTurn'
  | 'potWon'
  | 'patron'; // picking a Patron theme (n = 0 Hidden King, 1 Archmother)

export type Recipe = (v: Voice, n: number) => void;

/**
 * How loud each event is, in dB (RMS of its loudest 400 ms, before the volume slider): quiet ticks for navigation,
 * clear clicks for actions, wins louder the bigger they are.
 */
export const LEVELS: Record<SoundEvent, number> = {
  click: -34, tap: -42, select: -35, toggle: -41, open: -39, close: -39,
  success: -33, error: -33, notify: -31,
  bet: -33, betWon: -28, betLost: -31,
  spin: -39, reelStop: -36, win: -30, streak: -29, firstWin: -29, bigWin: -26, jackpot: -24,
  freeSpins: -27, bonus: -27, bonusPick: -35, bonusEnd: -28, lose: -46,
  deal: -41, chips: -38, check: -36, fold: -42, yourTurn: -31, potWon: -27, patron: -32,
};

export interface SoundPack {
  sounds: Record<SoundEvent, Recipe>;
  /** dB added to each recipe to reach LEVELS (from suggestTrims). */
  trim?: Partial<Record<SoundEvent, number>>;
  /** Events played from a stinger file (its slug in musicCatalog.ts) when it is loaded. */
  stingers?: Partial<Record<SoundEvent, (n: number) => string>>;
  /** Stingers cut short, in seconds (long intros). */
  stingerMax?: Partial<Record<SoundEvent, number>>;
  /** What the Customize panel and the taste test play: [event, seconds from the start]. */
  demo: [SoundEvent, number][];
}

type Arp = Partial<ToneOptions> & { step: number; dur: number; shift?: number };

const arp = (v: Voice, notes: string[], o: Arp) =>
  notes.forEach((n, i) => v.tone({ ...o, f: hz(n, o.shift ?? 0), at: (o.at ?? 0) + i * o.step }));

const chord = (v: Voice, notes: string[], o: Partial<ToneOptions> & { dur: number }) =>
  notes.forEach((n) => v.tone({ ...o, f: hz(n) }));

const silent: Recipe = () => {};

// ---- Soft: quiet, rounded sine tones, like a modern app ----

const softWin: Recipe = (v) => arp(v, ['C6', 'E6', 'G6'], { step: 0.07, dur: 0.32, gain: 0.11 });
const softBig: Recipe = (v) => {
  arp(v, ['C5', 'E5', 'G5', 'C6', 'E6'], { step: 0.07, dur: 0.42, type: 'triangle', gain: 0.1 });
  chord(v, ['C6', 'E6', 'G6'], { at: 0.4, dur: 1.2, gain: 0.05, attack: 0.04 });
};
const softChips: Recipe = (v) =>
  [0, 0.045, 0.1].forEach((at, i) => v.noise({ at, dur: 0.025, band: 2800 + i * 600, q: 5, gain: 0.22 }));
const softSelect: Recipe = (v) => {
  v.tone({ f: hz('E6'), dur: 0.22, gain: 0.1 });
  v.tone({ f: hz('B6'), at: 0.01, dur: 0.18, gain: 0.04 });
};

const soft: SoundPack = {
  sounds: {
    click: (v) => {
      v.tone({ f: 1250, to: 950, dur: 0.07, gain: 0.2 });
      v.noise({ dur: 0.012, hp: 3500, gain: 0.04 });
    },
    tap: (v) => v.tone({ f: 1700, to: 1500, dur: 0.04, gain: 0.08 }),
    select: softSelect,
    toggle: (v) => {
      v.tone({ f: 990, dur: 0.04, gain: 0.08 });
      v.tone({ f: 1320, at: 0.05, dur: 0.05, gain: 0.08 });
    },
    open: (v) => v.tone({ f: 520, to: 860, dur: 0.14, gain: 0.1, attack: 0.02 }),
    close: (v) => v.tone({ f: 860, to: 520, dur: 0.14, gain: 0.08, attack: 0.02 }),
    success: (v) => arp(v, ['G5', 'C6'], { step: 0.08, dur: 0.26, type: 'triangle', gain: 0.14 }),
    error: (v) => arp(v, ['E4', 'C4'], { step: 0.11, dur: 0.3, type: 'triangle', gain: 0.18, lp: 1800 }),
    notify: (v) => {
      v.tone({ f: 880, dur: 0.6, gain: 0.12 });
      v.tone({ f: 880 * 2.76, dur: 0.3, gain: 0.03 });
    },
    bet: (v) => {
      v.noise({ dur: 0.03, band: 2800, q: 4, gain: 0.3 });
      v.noise({ at: 0.04, dur: 0.025, band: 4200, q: 4, gain: 0.2 });
      v.tone({ f: 190, to: 140, dur: 0.06, gain: 0.12 });
    },
    betWon: (v) => arp(v, ['C5', 'E5', 'G5', 'C6'], { step: 0.09, dur: 0.36, type: 'triangle', gain: 0.12 }),
    betLost: (v) => arp(v, ['G4', 'E4', 'C4'], { step: 0.12, dur: 0.32, type: 'triangle', gain: 0.1, lp: 1500 }),
    spin: (v) => v.noise({ dur: 0.55, band: 350, to: 1800, q: 1.4, gain: 0.12, attack: 0.18 }),
    reelStop: (v, n) => {
      v.tone({ f: 190 - n * 8, to: 120, dur: 0.08, gain: 0.16 });
      v.noise({ dur: 0.03, lp: 900, gain: 0.06 });
    },
    win: softWin,
    streak: (v, n) => arp(v, ['C6', 'E6', 'G6', 'C7'], { step: 0.06, dur: 0.3, gain: 0.1, shift: Math.min(n, 8) }),
    firstWin: (v) => arp(v, ['G5', 'C6', 'E6', 'G6'], { step: 0.07, dur: 0.36, gain: 0.11 }),
    bigWin: softBig,
    jackpot: (v) => {
      softBig(v, 0);
      for (let i = 0; i < 14; i++) v.tone({ f: 2000 + Math.random() * 2200, at: 0.5 + i * 0.09, dur: 0.18, gain: 0.035 });
    },
    freeSpins: (v) => {
      v.tone({ f: 400, to: 1600, dur: 0.6, gain: 0.07, attack: 0.1 });
      arp(v, ['C6', 'E6', 'G6', 'C7'], { at: 0.45, step: 0.07, dur: 0.3, gain: 0.09 });
    },
    bonus: (v) => arp(v, ['G5', 'D6', 'G6', 'B6'], { step: 0.1, dur: 0.5, gain: 0.09, vib: 5 }),
    bonusPick: (v) => v.tone({ f: 990, to: 1480, dur: 0.14, gain: 0.1 }),
    bonusEnd: (v) => arp(v, ['C5', 'G5', 'C6', 'E6', 'G6'], { step: 0.08, dur: 0.45, type: 'triangle', gain: 0.1 }),
    lose: silent,
    deal: (v) => v.noise({ dur: 0.045, hp: 2500, gain: 0.1 }),
    chips: softChips,
    check: (v) => [0, 0.1].forEach((at) => v.tone({ f: 230, at, dur: 0.06, gain: 0.14, lp: 900 })),
    fold: (v) => v.noise({ dur: 0.2, band: 1200, to: 300, gain: 0.08, attack: 0.04 }),
    yourTurn: (v) => {
      v.tone({ f: hz('A5'), dur: 0.5, gain: 0.1 });
      v.tone({ f: hz('E6'), at: 0.12, dur: 0.5, gain: 0.08 });
    },
    potWon: (v) => {
      softChips(v, 0);
      softWin(v, 0);
    },
    patron: softSelect,
  },
  trim: { click: 2.5, tap: 4, select: 1.5, toggle: 1.5, close: 2, error: -3.5, bet: 7.5, betWon: 1, betLost: 1, spin: 9.5, reelStop: 1.5,
    firstWin: -1, bigWin: 2.5, jackpot: 4.5, freeSpins: 3.5, bonus: 1.5, bonusPick: 4, bonusEnd: 1, deal: 4, chips: 14, fold: 11.5,
    potWon: 3, patron: 4.5 },
  demo: [['click', 0], ['tap', 0.3], ['select', 0.6], ['bet', 0.95], ['win', 1.35]],
};

// ---- Arcade: bright square-wave chimes and coins, like a fruit machine ----

const sq = (v: Voice, note: string, at: number, dur: number, gain = 0.06, shift = 0) =>
  v.tone({ f: hz(note, shift), type: 'square', at, dur, gain, lp: 4200 });
const coin: Recipe = (v) => {
  sq(v, 'B5', 0, 0.07);
  sq(v, 'E6', 0.07, 0.32);
};
const arcadeWin = (v: Voice, shift: number) => {
  arp(v, ['C6', 'E6', 'G6'], { step: 0.06, dur: 0.1, type: 'square', gain: 0.055, lp: 4200, shift });
  sq(v, 'C7', 0.18, 0.28, 0.055, shift);
};
const arcadeBig: Recipe = (v) => {
  arp(v, ['C5', 'E5', 'G5', 'C6'], { step: 0.08, dur: 0.12, type: 'square', gain: 0.055, lp: 4200 });
  chord(v, ['C6', 'E6', 'G6'], { type: 'square', at: 0.34, dur: 0.75, gain: 0.035, lp: 3600 });
  v.tone({ f: hz('C3'), type: 'triangle', at: 0.34, dur: 0.75, gain: 0.12 });
};
const coinShower = (v: Voice, from: number, count: number) => {
  for (let i = 0; i < count; i++) {
    const at = from + i * 0.08 + Math.random() * 0.04;
    v.tone({ f: 1800 + Math.random() * 900, type: 'square', at, dur: 0.05, gain: 0.03, lp: 5000 });
    v.tone({ f: 2400 + Math.random() * 900, type: 'square', at: at + 0.05, dur: 0.12, gain: 0.03, lp: 5000 });
  }
};

const arcade: SoundPack = {
  sounds: {
    click: (v) => {
      sq(v, 'A5', 0, 0.04, 0.07);
      sq(v, 'A6', 0.025, 0.035, 0.045);
    },
    tap: (v) => sq(v, 'E6', 0, 0.03, 0.04),
    select: coin,
    toggle: (v) => {
      sq(v, 'C6', 0, 0.04, 0.05);
      sq(v, 'G6', 0.05, 0.05, 0.05);
    },
    open: (v) => arp(v, ['E5', 'A5', 'E6'], { step: 0.035, dur: 0.06, type: 'square', gain: 0.05, lp: 4200 }),
    close: (v) => arp(v, ['E6', 'A5', 'E5'], { step: 0.035, dur: 0.06, type: 'square', gain: 0.045, lp: 4200 }),
    success: (v) => arp(v, ['C6', 'E6', 'G6', 'C7'], { step: 0.05, dur: 0.12, type: 'square', gain: 0.05, lp: 4200 }),
    error: (v) => {
      v.tone({ f: 220, to: 160, type: 'square', dur: 0.22, gain: 0.07, lp: 2000 });
      v.tone({ f: 110, type: 'square', at: 0.12, dur: 0.22, gain: 0.06, lp: 1500 });
    },
    notify: (v) => chord(v, ['E6', 'B6'], { type: 'triangle', dur: 0.25, gain: 0.08 }),
    bet: coin,
    betWon: (v) => {
      arp(v, ['G5', 'C6', 'E6', 'G6'], { step: 0.08, dur: 0.14, type: 'square', gain: 0.05, lp: 4200 });
      sq(v, 'C7', 0.32, 0.45, 0.05);
    },
    betLost: (v) => arp(v, ['G4', 'F#4', 'F4', 'E4'], { step: 0.18, dur: 0.2, type: 'square', gain: 0.06, lp: 1600 }),
    spin: (v) => arp(v, ['C5', 'D5', 'E5', 'G5', 'A5', 'C6', 'D6', 'E6', 'G6', 'A6', 'C7', 'D7'], {
      step: 0.035, dur: 0.04, type: 'square', gain: 0.035, lp: 4200,
    }),
    reelStop: (v, n) => {
      v.tone({ f: hz('G3', n), type: 'square', dur: 0.06, gain: 0.06, lp: 1800 });
      v.noise({ dur: 0.02, hp: 3000, gain: 0.03 });
    },
    win: (v) => arcadeWin(v, 0),
    streak: (v, n) => arcadeWin(v, Math.min(n, 7)),
    firstWin: (v) => {
      arcadeWin(v, 0);
      coinShower(v, 0.45, 4);
    },
    bigWin: arcadeBig,
    jackpot: (v) => {
      arcadeBig(v, 0);
      coinShower(v, 0.4, 16);
    },
    freeSpins: (v) =>
      arp(v, ['C5', 'C#5', 'D5', 'D#5', 'E5', 'F5', 'F#5', 'G5', 'G#5', 'A5', 'A#5', 'B5', 'C6', 'C#6', 'D6', 'D#6'], {
        step: 0.03, dur: 0.04, type: 'square', gain: 0.04, lp: 4200,
      }),
    bonus: (v) => arp(v, ['E6', 'G6', 'E7', 'C7', 'D7', 'G7'], { step: 0.08, dur: 0.09, type: 'square', gain: 0.05, lp: 4800 }),
    bonusPick: coin,
    bonusEnd: (v) => {
      arcadeWin(v, 0);
      coinShower(v, 0.4, 6);
    },
    lose: (v) => v.tone({ f: 150, to: 110, type: 'square', dur: 0.08, gain: 0.025, lp: 900 }),
    deal: (v) => v.noise({ dur: 0.03, hp: 3000, gain: 0.08 }),
    chips: (v) => {
      sq(v, 'B6', 0, 0.04, 0.045);
      sq(v, 'E7', 0.04, 0.12, 0.045);
    },
    check: (v) => [0, 0.08].forEach((at) => sq(v, 'A4', at, 0.04, 0.05)),
    fold: (v) => v.tone({ f: 330, to: 196, type: 'square', dur: 0.15, gain: 0.04, lp: 1500 }),
    yourTurn: (v) => arp(v, ['C6', 'G6'], { step: 0.1, dur: 0.18, type: 'triangle', gain: 0.1 }),
    potWon: arcadeBig,
    patron: coin,
  },
  trim: { click: 10, tap: 9.5, select: 2, toggle: 3.5, open: 2.5, close: 3.5, success: 4.5, error: 3, notify: 6, bet: 4, betWon: 6.5,
    betLost: 4, spin: 1.5, reelStop: 9, win: 6, streak: 6.5, firstWin: 7, bigWin: 3.5, jackpot: 5, freeSpins: 11.5, bonus: 10.5,
    bonusPick: 2, bonusEnd: 8, lose: 4.5, deal: 8.5, chips: 4.5, check: 9.5, fold: 2.5, yourTurn: 5.5, potWon: 2.5, patron: 5 },
  demo: [['click', 0], ['tap', 0.3], ['select', 0.55], ['spin', 1], ['win', 1.55]],
};

// ---- Deadlock: brass and clockwork from the 1920s city, and the game's stingers ----

const brass = (v: Voice, notes: string[], at: number, dur: number, gain = 0.035, lp = 2200) =>
  notes.forEach((n) => v.tone({ f: hz(n), type: 'sawtooth', at, dur, gain, lp, lpTo: lp * 0.6, attack: 0.012 }));
const bell: Recipe = (v) => {
  v.tone({ f: 784, dur: 0.9, gain: 0.1 });
  v.tone({ f: 784 * 2.76, dur: 0.5, gain: 0.03 });
  v.tone({ f: 784 * 5.4, dur: 0.25, gain: 0.015 });
};
const clacks = (v: Voice) => [0, 0.04, 0.09].forEach((at) => v.noise({ at, dur: 0.02, band: 3200, q: 5, gain: 0.25 }));
/** Brass "ta-da", `shift` semitones up (a win streak climbs). */
const tada = (v: Voice, shift: number) => {
  const o = { step: 0, type: 'sawtooth' as const, gain: 0.035, attack: 0.012, shift };
  arp(v, ['D4', 'F#4', 'A4'], { ...o, dur: 0.16, lp: 2200, lpTo: 1300 });
  arp(v, ['D5', 'F#5', 'A5'], { ...o, at: 0.12, dur: 0.5, lp: 2400, lpTo: 1400 });
};
const brassSelect: Recipe = (v) => brass(v, ['D4', 'F#4', 'A4'], 0, 0.22, 0.04, 1800);

const deadlock: SoundPack = {
  sounds: {
    // A typewriter key: a click, a thump and a little metal.
    click: (v) => {
      v.noise({ dur: 0.02, band: 2200, q: 3, gain: 0.35 });
      v.tone({ f: 120, to: 70, dur: 0.05, gain: 0.22 });
      v.noise({ at: 0.012, dur: 0.01, hp: 6000, gain: 0.08 });
    },
    // A clock's tick.
    tap: (v) => v.noise({ dur: 0.012, band: 4500, q: 6, gain: 0.25 }),
    select: brassSelect,
    toggle: (v) => {
      v.noise({ dur: 0.012, band: 4500, q: 6, gain: 0.22 });
      v.noise({ at: 0.09, dur: 0.012, band: 3000, q: 6, gain: 0.2 });
    },
    open: (v) => ['D3', 'A3'].forEach((n) => v.tone({ f: hz(n), type: 'sawtooth', dur: 0.25, gain: 0.04, lp: 400, lpTo: 1800, attack: 0.06 })),
    close: (v) => ['A3', 'D3'].forEach((n) => v.tone({ f: hz(n), type: 'sawtooth', dur: 0.2, gain: 0.035, lp: 1600, lpTo: 350, attack: 0.03 })),
    success: (v) => {
      brass(v, ['D4', 'A4'], 0, 0.25);
      brass(v, ['D5'], 0.1, 0.35);
    },
    error: (v) => brass(v, ['D3', 'D#3'], 0, 0.35, 0.04, 900),
    notify: bell,
    bet: (v) => {
      v.noise({ dur: 0.025, band: 3000, q: 4, gain: 0.3 });
      v.tone({ f: hz('C7'), dur: 0.15, gain: 0.03 });
      v.tone({ f: hz('E7'), at: 0.01, dur: 0.12, gain: 0.02 });
      v.tone({ f: 110, to: 70, dur: 0.06, gain: 0.15 });
    },
    betWon: (v) => tada(v, 0),
    betLost: (v) => {
      brass(v, ['D4', 'F4'], 0, 0.3, 0.035, 1200);
      brass(v, ['C#4', 'E4'], 0.25, 0.5, 0.035, 1000);
    },
    // A ratchet winding up.
    spin: (v) => {
      let at = 0;
      for (let i = 0; i < 10; i++) {
        v.noise({ at, dur: 0.012, band: 3800, q: 5, gain: 0.22 });
        at += 0.07 - i * 0.004;
      }
    },
    reelStop: (v, n) => {
      v.tone({ f: 95 - n * 3, to: 60, dur: 0.1, gain: 0.3 });
      v.noise({ dur: 0.05, lp: 700, gain: 0.12 });
    },
    win: (v) => tada(v, 0),
    streak: (v, n) => tada(v, Math.min(n, 7)),
    firstWin: (v) => tada(v, 0),
    bigWin: (v) => {
      tada(v, 0);
      brass(v, ['D5', 'F#5', 'A5', 'D6'], 0.55, 0.8, 0.03, 2600);
    },
    jackpot: (v) => {
      tada(v, 0);
      brass(v, ['D5', 'F#5', 'A5', 'D6'], 0.55, 1.1, 0.03, 2800);
      bell(v, 0);
    },
    freeSpins: (v) => {
      ['D3', 'A3', 'D4'].forEach((n) => v.tone({ f: hz(n), type: 'sawtooth', dur: 0.7, gain: 0.03, lp: 300, lpTo: 2400, attack: 0.3 }));
      bell(v, 0);
    },
    bonus: (v) => {
      ['A2', 'E3', 'A3'].forEach((n) => v.tone({ f: hz(n), type: 'sawtooth', dur: 0.8, gain: 0.035, lp: 250, lpTo: 2000, attack: 0.35 }));
      v.tone({ f: hz('A5'), at: 0.5, dur: 0.6, gain: 0.06, vib: 6 });
    },
    bonusPick: brassSelect,
    bonusEnd: (v) => tada(v, 0),
    lose: silent,
    deal: (v) => v.noise({ dur: 0.04, hp: 2500, gain: 0.12 }),
    chips: clacks,
    check: (v) => [0, 0.11].forEach((at) => v.tone({ f: 150, at, dur: 0.06, gain: 0.2, lp: 600 })),
    fold: (v) => v.noise({ dur: 0.2, band: 1200, to: 300, gain: 0.08, attack: 0.03 }),
    yourTurn: bell,
    potWon: (v) => {
      clacks(v);
      tada(v, 0);
    },
    patron: brassSelect,
  },
  stingers: {
    firstWin: () => 'first-blood',
    // Deadlock's killstreak stingers rise with each kill, here with each win in a row.
    streak: (n) => `ks-${String(Math.min(Math.max(n, 1), 10)).padStart(2, '0')}`,
    bigWin: () => 'rift-secured',
    jackpot: () => 'victory',
    // The slot's scatter is the Soul Urn and its bonus the Unstable Rift: their in-game announcements.
    freeSpins: () => 'urn-arrived',
    bonus: () => 'rift-announce',
    bonusEnd: () => 'urn-delivered',
    betWon: () => 'rejuv-won',
    betLost: () => 'rejuv-lost',
    potWon: () => 'guardian-down',
    patron: (n) => (n === 1 ? 'mother-intro' : 'king-intro'),
  },
  trim: { click: 3.5, tap: 15.5, select: 7.5, toggle: 14.5, open: 5.5, close: 7.5, success: 10, error: 10, bet: 6, betWon: 10.5,
    betLost: 9, spin: 10.5, reelStop: -4, win: 8.5, streak: 9.5, firstWin: 9.5, bigWin: 11.5, jackpot: 6, freeSpins: 3, bonus: 8,
    bonusPick: 7.5, bonusEnd: 10.5, deal: 3.5, chips: 14, check: -2.5, fold: 12.5, potWon: 11.5, patron: 10.5 },
  stingerMax: { patron: 6 },
  demo: [['click', 0], ['tap', 0.3], ['select', 0.55], ['spin', 0.95], ['firstWin', 1.75]],
};

export const PACKS: Record<string, SoundPack> = { deadlock, arcade, soft };

/**
 * Calibration (a developer tool): renders each of the pack's recipes offline and returns the trim that brings it to
 * LEVELS, rounded to half a decibel. Paste the result into the pack's `trim`.
 */
export async function suggestTrims(id: string): Promise<Partial<Record<SoundEvent, number>>> {
  const pack = PACKS[id];
  if (!pack) throw new Error(`Unknown pack ${id}`);
  const trims: Partial<Record<SoundEvent, number>> = {};
  for (const event of Object.keys(LEVELS) as SoundEvent[]) {
    const { loudness } = await audio.measure((v) => pack.sounds[event](v, event === 'streak' ? 3 : 0), 3);
    if (loudness < -90) continue; // silent on purpose
    const trim = Math.round((LEVELS[event] - loudness) * 2) / 2;
    if (Math.abs(trim) >= 1) trims[event] = trim;
  }
  return trims;
}
