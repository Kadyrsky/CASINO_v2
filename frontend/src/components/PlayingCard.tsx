import { Show } from 'solid-js';

const SUITS: Record<string, { glyph: string; red: boolean }> = {
  h: { glyph: '♥', red: true },
  d: { glyph: '♦', red: true },
  c: { glyph: '♣', red: false },
  s: { glyph: '♠', red: false },
};

/** A card like "As" / "Td", or "HIDDEN" for a face-down card (server-side masking). */
export function PlayingCard(props: { card: string; size?: 'sm' | 'md' | 'lg'; dim?: boolean }) {
  const size = () =>
    ({ sm: 'h-11 w-8 text-sm', md: 'h-16 w-11 text-lg', lg: 'h-20 w-14 text-xl' })[props.size ?? 'md'];
  const hidden = () => props.card === 'HIDDEN';
  const rank = () => (props.card[0] === 'T' ? '10' : props.card[0]);
  const suit = () => SUITS[props.card[1] ?? 's'] ?? SUITS.s!;
  return (
    <Show
      when={!hidden()}
      fallback={
        <div class={`${size()} rounded-md border border-gold-600/50 bg-[repeating-linear-gradient(45deg,#5a3b12_0_4px,#3d270b_4px_8px)] shadow-md`} aria-label="Face-down card" />
      }
    >
      <div
        class={`${size()} flex animate-pop flex-col items-center justify-center rounded-md bg-ink-100 font-bold leading-none shadow-md ${suit().red ? 'text-red-600' : 'text-ink-950'} ${props.dim ? 'opacity-40' : ''}`}
        aria-label={props.card}
      >
        <span>{rank()}</span>
        <span>{suit().glyph}</span>
      </div>
    </Show>
  );
}
