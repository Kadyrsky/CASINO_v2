/**
 * Notice that Naebka is a university project running on play money, not a real casino (when it shows: disclaimer.ts).
 * It can only be closed with the button (not by Esc or a click outside), so nobody starts playing without seeing it.
 */
import { onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { disclaimer } from '../lib/disclaimer';
import { Button } from './ui';

const POINTS: { title: string; text: string }[] = [
  {
    title: 'Not a real casino',
    text: 'Naebka is a university project for a Software Methodologies course. It is not a licensed casino or bookmaker, and nothing here is an offer to gamble.',
  },
  {
    title: 'Play money only',
    text: 'Tokens are free and have no cash value. They cannot be bought with real money or paid out. The optional MetaMask wallet uses Sepolia test ETH, which is worthless.',
  },
  {
    title: 'Real matches, not affiliated',
    text: 'Live betting follows real public Deadlock matches. Naebka is not affiliated with or endorsed by Valve.',
  },
];

function Notice() {
  let button: HTMLButtonElement | undefined;
  let dialog: HTMLDivElement | undefined;
  onMount(() => {
    button?.focus();
    // Keep keyboard focus inside the notice: Tab can't reach the page behind it.
    const keepFocus = (e: FocusEvent) => {
      if (dialog && !dialog.contains(e.target as Node)) button?.focus();
    };
    document.addEventListener('focusin', keepFocus);
    onCleanup(() => document.removeEventListener('focusin', keepFocus));
  });
  return (
    <Portal>
      {/* A click outside does nothing, and doesn't take focus off the button either. */}
      <div
        class="fixed inset-0 z-[60] flex items-end justify-center bg-black/75 p-4 backdrop-blur-sm sm:items-center"
        onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}
      >
        <div
          ref={(el) => (dialog = el)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="disclaimer-title"
          aria-describedby="disclaimer-body"
          class="w-full max-w-lg animate-pop rounded-2xl border border-ink-600 bg-ink-900 shadow-2xl"
        >
          <header class="flex items-center gap-3 border-b border-ink-700 px-5 py-4">
            <span class="grid size-9 shrink-0 place-items-center rounded-full border-2 border-loss text-xs font-black text-loss">18+</span>
            <h2 id="disclaimer-title" class="text-lg font-bold">Before you start</h2>
          </header>
          <div id="disclaimer-body" class="flex flex-col gap-4 px-5 py-4">
            {POINTS.map((p) => (
              <div>
                <p class="font-semibold text-gold-300">{p.title}</p>
                <p class="mt-0.5 text-sm text-ink-300">{p.text}</p>
              </div>
            ))}
            <p class="text-xs text-ink-400">
              Even with play money, gambling games can be habit-forming. If gambling is a problem for you, get support at{' '}
              <a href="https://www.begambleaware.org" target="_blank" rel="noreferrer" class="text-gold-300 hover:underline">
                BeGambleAware
              </a>
              .
            </p>
          </div>
          <footer class="flex justify-end border-t border-ink-700 px-5 py-3">
            <Button ref={(el) => (button = el)} onClick={disclaimer.accept}>
              I understand, continue
            </Button>
          </footer>
        </div>
      </div>
    </Portal>
  );
}

export function Disclaimer() {
  return (
    <Show when={disclaimer.open()}>
      <Notice />
    </Show>
  );
}
