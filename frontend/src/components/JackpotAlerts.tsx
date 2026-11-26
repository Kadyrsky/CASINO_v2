import { A, useLocation } from '@solidjs/router';
import { Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { tokens } from '../lib/format';
import { jackpot } from '../lib/jackpot';

/**
 * Someone hit the casino-wide jackpot: a short note at the top of every page (the slots page shows it on the meter
 * instead, components/jackpot.tsx). It goes away by itself (jackpot.ts, MOMENT_MS).
 */
export function JackpotAlerts() {
  jackpot.use();
  const location = useLocation();
  const moment = () => (location.pathname.startsWith('/slots') ? null : jackpot.moment());
  return (
    <Show when={moment()}>
      {(m) => (
        <Portal>
          <div class="pointer-events-none fixed inset-x-0 top-20 z-[55] flex justify-center px-4">
            <A
              href="/slots"
              role="status"
              class="pointer-events-auto flex max-w-full animate-pop items-center gap-3 rounded-full border border-gold-400/60 bg-ink-900/95 py-2 pl-2 pr-4 text-sm shadow-[0_8px_40px_-8px_color-mix(in_oklab,var(--color-gold-500)_55%,transparent)] backdrop-blur"
            >
              <span class="grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-gold-300 to-gold-600 font-black text-ink-950" aria-hidden="true">
                ✦
              </span>
              <span class="min-w-0">
                <b class="text-gold-300">{`${m().win?.winner ?? 'Someone'} hit the jackpot!`}</b>{' '}
                <span class="tabular text-ink-100">{tokens(m().win?.amount ?? m().previous.amount)} NTK</span>
                <span class="text-ink-400"> · Soul Reels</span>
              </span>
            </A>
          </div>
        </Portal>
      )}
    </Show>
  );
}
