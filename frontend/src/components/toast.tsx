import { createRoot, createSignal, For } from 'solid-js';
import { Portal } from 'solid-js/web';
import { ApiError } from '../api/client';
import { sounds } from '../lib/sounds';

type Kind = 'info' | 'success' | 'error';

interface Toast {
  id: number;
  kind: Kind;
  text: string;
}

const store = createRoot(() => {
  const [items, setItems] = createSignal<Toast[]>([]);
  let next = 1;
  const push = (kind: Kind, text: string) => {
    const id = next++;
    setItems((t) => [...t.slice(-3), { id, kind, text }]);
    window.setTimeout(() => setItems((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3500);
  };
  return { items, push, dismiss: (id: number) => setItems((t) => t.filter((x) => x.id !== id)) };
});

// A toast that announces a game sound (a win, a bet) stays quiet, so the two don't stack.
export const toast = {
  info: (t: string) => {
    sounds.play('notify', 0, { quietFor: 500 });
    store.push('info', t);
  },
  success: (t: string) => {
    sounds.play('success', 0, { quietFor: 500 });
    store.push('success', t);
  },
  error: (e: unknown) => {
    sounds.play('error', 0, { quietFor: 500 });
    store.push('error', e instanceof ApiError || e instanceof Error ? e.message : String(e));
  },
};

const styles: Record<Kind, string> = {
  info: 'border-ink-600 bg-ink-800',
  success: 'border-win/40 bg-ink-800',
  error: 'border-loss/50 bg-ink-800',
};
const icons: Record<Kind, string> = { info: 'ℹ', success: '✓', error: '!' };
const iconStyles: Record<Kind, string> = { info: 'bg-ink-600', success: 'bg-win text-ink-950', error: 'bg-loss text-white' };

export function Toaster() {
  return (
    <Portal>
      <div class="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-auto sm:right-4 sm:top-20 sm:items-end">
        <For each={store.items()}>
          {(t) => (
            <div
              role="status"
              class={`pointer-events-auto flex w-full max-w-sm animate-pop items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-xl ${styles[t.kind]}`}
              onClick={() => store.dismiss(t.id)}
            >
              <span class={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-xs font-bold ${iconStyles[t.kind]}`}>
                {icons[t.kind]}
              </span>
              <span class="text-ink-100">{t.text}</span>
            </div>
          )}
        </For>
      </div>
    </Portal>
  );
}
