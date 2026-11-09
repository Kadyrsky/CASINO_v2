/**
 * Soul Reels' Deadlock theme: cheap shop items are the low symbols, map objectives the high ones, the two Patrons
 * are the wilds, the Soul Urn the scatter and the Unstable Rift the bonus. The art is the game's, from the Deadlock
 * Wiki (see scripts/wiki_icons.py). The symbol ids are the machine's original ones.
 */
import { For, Show } from 'solid-js';
import type { SlotGame } from '../api/types';
import { ab } from '../lib/experiments';
import { tokens } from '../lib/format';

export interface SymbolArt {
  src: string;
  /** Shop items are square cards that fill the tile; objective glyphs sit on a tinted background. */
  card: boolean;
  /** Tile background, from the symbol's colour. */
  tone: string;
  /** What the symbol does, for special symbols. */
  tag?: string;
}

export const SYMBOL_ART: Record<string, SymbolArt> = {
  CHERRY: { src: '/icons/items/extended-magazine.webp', card: true, tone: 'from-orange-500/25' },
  LEMON: { src: '/icons/items/extra-health.webp', card: true, tone: 'from-lime-500/25' },
  BELL: { src: '/icons/items/extra-spirit.webp', card: true, tone: 'from-violet-500/25' },
  CLOVER: { src: '/icons/objectives/guardian.webp', card: true, tone: 'from-amber-700/30' },
  GEM: { src: '/icons/objectives/walker.webp', card: true, tone: 'from-amber-600/35' },
  SEVEN: { src: '/icons/objectives/midboss.webp', card: false, tone: 'from-yellow-400/35' },
  WILD: { src: '/icons/objectives/patron-0.webp', card: false, tone: 'from-amber-team/45', tag: 'Wild' },
  MULT: { src: '/icons/objectives/patron-1.webp', card: false, tone: 'from-sapphire-team/45', tag: 'Wild ×2' },
  SCATTER: { src: '/icons/objectives/urn.webp', card: false, tone: 'from-cyan-400/30', tag: 'Scatter' },
  BONUS: { src: '/icons/objectives/rift.webp', card: false, tone: 'from-teal-400/30', tag: 'Bonus' },
};

/** Line symbols, the cheapest first; used for the idle reels before the first spin. */
export const LINE_SYMBOLS = ['CHERRY', 'LEMON', 'BELL', 'CLOVER', 'GEM', 'SEVEN'];

/** The rift bonus hides these multiples of the total bet (PickAndClickBonus.REWARD_MULTIPLIERS). */
const RIFT_MIN = 1;
const RIFT_MAX = 25;

/** The A/B "slot_icons" classic variant: the machine's original fruit-machine symbols. */
const CLASSIC_ART: Record<string, string> = {
  CHERRY: '🍒',
  LEMON: '🍋',
  BELL: '🔔',
  CLOVER: '🍀',
  GEM: '💎',
  SEVEN: '7️⃣',
  WILD: '🃏',
  MULT: '🌟',
  SCATTER: '💰',
  BONUS: '🎁',
};

const CLASSIC_NAMES: Record<string, string> = {
  CHERRY: 'Cherry',
  LEMON: 'Lemon',
  BELL: 'Bell',
  CLOVER: 'Clover',
  GEM: 'Diamond',
  SEVEN: 'Lucky Seven',
  WILD: 'Joker',
  MULT: 'Star',
  SCATTER: 'Money Bag',
  BONUS: 'Gift Box',
};

/** A symbol's name: the server's Deadlock name, or the fruit-machine one in the classic variant. */
export function symbolName(game: SlotGame | undefined, id: string): string {
  if (ab.variant('slot_icons') === 'classic' && CLASSIC_NAMES[id]) return CLASSIC_NAMES[id]!;
  return game?.symbols[id]?.name ?? id;
}

export function SymbolIcon(props: { id: string; class?: string }) {
  const art = () => SYMBOL_ART[props.id];
  const classic = () => (ab.variant('slot_icons') === 'classic' ? CLASSIC_ART[props.id] : undefined);
  return (
    <Show
      when={!classic()}
      fallback={
        // An SVG so the emoji scales with whatever box the caller gives it, like the images do.
        <svg viewBox="0 0 100 100" class={props.class ?? 'size-7'} aria-hidden="true">
          <text x="50" y="54" font-size="78" text-anchor="middle" dominant-baseline="middle">{classic()}</text>
        </svg>
      }
    >
      <Show when={art()} fallback={<span class={props.class}>?</span>}>
        {(a) => (
          <img
            src={a().src}
            alt=""
            draggable={false}
            class={`${a().card ? 'rounded-md object-cover' : 'object-contain drop-shadow-[0_2px_6px_rgb(0_0_0/0.6)]'} ${props.class ?? 'size-7'}`}
          />
        )}
      </Show>
    </Show>
  );
}

/** One of the ten paylines as a 5 × 3 grid, highlighted when it won the last spin. */
function PaylineMap(props: { id: number; rows: number[]; won: boolean }) {
  return (
    <div class={`flex flex-col items-center gap-1 rounded-lg p-1.5 ${props.won ? 'bg-gold-500/15 ring-1 ring-gold-400' : 'bg-ink-850'}`} title={`Line ${props.id}`}>
      <div class="grid grid-cols-5 gap-px">
        <For each={[0, 1, 2]}>
          {(row) => (
            <For each={props.rows}>
              {(r) => <span class={`size-1.5 rounded-[1px] ${r === row ? (props.won ? 'bg-gold-300' : 'bg-ink-300') : 'bg-ink-700'}`} />}
            </For>
          )}
        </For>
      </div>
      <span class={`text-[9px] font-semibold ${props.won ? 'text-gold-300' : 'text-ink-500'}`}>{props.id}</span>
    </div>
  );
}

/**
 * The paytable in plain words: what each symbol pays at the current bet (not just multipliers), what the special
 * symbols do, and which ten lines count.
 */
export function Paytable(props: { game?: SlotGame; betPerLine: number; totalBet: number; wonLines: Set<number> }) {
  const lineSymbols = () =>
    Object.entries(props.game?.symbols ?? {})
      .filter(([, s]) => Object.keys(s.pays).length)
      .sort(([, a], [, b]) => (b.pays['5'] ?? 0) - (a.pays['5'] ?? 0));
  const pay = (x: number | undefined) => (x == null ? '–' : tokens(x * props.betPerLine));
  const scatter = (n: number) => props.game?.scatterPays?.[String(n)];
  const name = (id: string) => symbolName(props.game, id);
  const special = [
    {
      id: 'WILD',
      text: () => <>Stands in for any line symbol. <b class="text-gold-300">5 on a line win the progressive jackpot.</b></>,
    },
    { id: 'MULT', text: () => <>A wild that also <b class="text-ink-100">doubles</b> the line it is on. Middle reel only.</> },
    {
      id: 'SCATTER',
      text: () => (
        <>
          Counts anywhere on the reels. <b class="text-ink-100">3 or more: {props.game?.freeSpinsPerTrigger ?? 10} free spins</b> plus{' '}
          {[3, 4, 5].map((n) => `${n} → ${tokens((scatter(n) ?? 0) * props.totalBet)}`).join(', ')}.
        </>
      ),
    },
    {
      id: 'BONUS',
      text: () => (
        <>
          On reels 1, 3 and 5 at once: <b class="text-ink-100">open 3 of 12 rifts</b>, each worth {tokens(RIFT_MIN * props.totalBet)}–
          {tokens(RIFT_MAX * props.totalBet)}.
        </>
      ),
    },
  ];
  return (
    <div class="flex flex-col">
      <p class="px-4 pt-3 text-xs text-ink-400">
        Get <b class="text-ink-200">3, 4 or 5 of a symbol in a row</b> on a line, starting from the <b class="text-ink-200">left reel</b>. Wins in
        NTK at your bet of {tokens(props.betPerLine)} per line:
      </p>
      <table class="mt-2 w-full text-sm">
        <thead>
          <tr class="text-[10px] uppercase tracking-wider text-ink-500">
            <th rowspan="2" class="px-4 align-bottom text-left font-semibold">Symbol</th>
            <th colspan="3" class="pr-4 text-right font-semibold">In a row</th>
          </tr>
          <tr class="text-xs text-ink-400">
            <For each={['3', '4', '5']}>{(n) => <th class="w-14 pb-1 pr-4 text-right font-bold">{n}</th>}</For>
          </tr>
        </thead>
        <tbody class="divide-y divide-ink-800">
          <For each={lineSymbols()}>
            {([id, s]) => (
              <tr>
                <td class="px-4 py-1.5">
                  <span class="flex items-center gap-2">
                    <SymbolIcon id={id} class="size-7" />
                    <span class="leading-tight">
                      <span class="block text-ink-100">{name(id)}</span>
                      <Show when={SYMBOL_ART[id]?.tag}>{(t) => <span class="block text-[10px] font-semibold uppercase text-gold-300">{t()}</span>}</Show>
                    </span>
                  </span>
                </td>
                <For each={['3', '4', '5']}>
                  {(n) => (
                    <td class="tabular py-1.5 pr-4 text-right text-ink-200" title={s.pays[n] != null ? `${s.pays[n]}× line bet` : undefined}>
                      {id === 'WILD' && n === '5' ? <span class="text-[11px] font-bold text-gold-300">Jackpot</span> : pay(s.pays[n])}
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <ul class="mt-2 flex flex-col gap-2 border-t border-ink-800 px-4 py-3">
        <For each={special}>
          {(sp) => (
            <li class="flex gap-2.5 text-xs text-ink-400">
              <span class={`grid size-9 shrink-0 place-items-center rounded-lg bg-gradient-to-b to-ink-900 ${SYMBOL_ART[sp.id]?.tone ?? ''}`}>
                <SymbolIcon id={sp.id} class="size-7" />
              </span>
              <span>
                <span class="font-semibold text-ink-200">{name(sp.id)}</span>
                <span class="ml-1 text-[10px] font-semibold uppercase text-gold-300">{SYMBOL_ART[sp.id]?.tag}</span>
                <br />
                {sp.text()}
              </span>
            </li>
          )}
        </For>
      </ul>
      <div class="border-t border-ink-800 px-4 py-3">
        <p class="mb-2 text-xs text-ink-400">
          The <b class="text-ink-200">10 lines</b> (each costs one line bet; the ones that won your last spin light up):
        </p>
        <div class="grid grid-cols-5 gap-1.5">
          <For each={props.game?.paylines ?? []}>{(rows, i) => <PaylineMap id={i() + 1} rows={rows} won={props.wonLines.has(i() + 1)} />}</For>
        </div>
      </div>
    </div>
  );
}
