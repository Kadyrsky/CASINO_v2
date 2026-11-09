/**
 * The "Customize" button in the header: a drop-down where anyone can switch the A/B experiments they can see (the
 * theme, the slot symbols), with the page staying visible underneath so they see the change straight away. On the
 * first visit a hint points at it.
 */
import { For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { ab, EXPERIMENTS } from '../lib/experiments';
import { customize, feedbackPanel } from '../lib/panels';

/** What each option looks like, so people can pick without trying each one. */
const PREVIEWS: Record<string, Record<string, { bg: string; ring: string; art: () => JSX.Element; note: string }>> = {
  theme: {
    hidden_king: {
      bg: 'bg-[linear-gradient(135deg,#f7bb5c,#c97c22_55%,#3a250f)]',
      ring: 'ring-[#f0a24a]',
      art: () => <img src="/icons/objectives/patron-0.webp" alt="" class="size-9 drop-shadow-[0_2px_4px_rgb(0_0_0/0.6)]" />,
      note: 'Amber Hand',
    },
    archmother: {
      bg: 'bg-[linear-gradient(135deg,#84a8ff,#3a68df_55%,#0c1a45)]',
      ring: 'ring-[#5b8cff]',
      art: () => <img src="/icons/objectives/patron-1.webp" alt="" class="size-9 drop-shadow-[0_2px_4px_rgb(0_0_0/0.6)]" />,
      note: 'Sapphire Flame',
    },
    deadlock: {
      bg: 'bg-[linear-gradient(135deg,#d9f891,#5f7a3a_55%,#171c18)]',
      ring: 'ring-[#d9f891]',
      art: () => <img src="/images/deadlock-icon.webp" alt="" class="size-9 rounded-full" />,
      note: 'Sewer green',
    },
    classic: {
      bg: 'bg-[linear-gradient(135deg,#f3cd87,#c4862a_55%,#1d1a28)]',
      ring: 'ring-[#e2a443]',
      art: () => <span class="font-sans text-2xl font-black text-[#0b0a10]">N</span>,
      note: 'The old look',
    },
  },
  slot_icons: {
    deadlock: {
      bg: 'bg-ink-800',
      ring: 'ring-gold-400',
      art: () => (
        <span class="flex gap-0.5">
          <For each={['items/extended-magazine', 'items/extra-health', 'objectives/walker']}>
            {(src) => <img src={`/icons/${src}.webp`} alt="" class="size-6 rounded" />}
          </For>
        </span>
      ),
      note: 'Shop items & objectives',
    },
    classic: {
      bg: 'bg-ink-800',
      ring: 'ring-gold-400',
      art: () => <span class="text-xl leading-none">🍒🍋💎</span>,
      note: 'Fruit machine',
    },
  },
};

function CustomizePanel() {
  const label = (key: string, id: string) => EXPERIMENTS.find((e) => e.key === key)?.variants.find((v) => v.id === id)?.label ?? id;
  return (
    <div
      role="dialog"
      aria-label="Customize the look"
      class="fixed inset-x-4 top-16 z-50 max-h-[calc(100vh-5rem)] animate-pop overflow-y-auto rounded-2xl border border-ink-600 bg-ink-900/97 p-4 shadow-2xl backdrop-blur sm:absolute sm:inset-x-auto sm:right-0 sm:top-12 sm:w-80"
    >
      <div class="flex items-start justify-between gap-2">
        <div>
          <h3 class="font-semibold">Customize the look</h3>
          <p class="mt-0.5 text-xs text-ink-400">You got one look at random. Switch any time — the page updates right away.</p>
        </div>
        <button class="rounded-md p-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100" onClick={customize.close} aria-label="Close">
          ✕
        </button>
      </div>
      <Show when={ab.testing}>
        <p class="mt-3 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
          Versions are forced by <code>?ab=</code> in this tab, so changes here won't show.
        </p>
      </Show>
      <div class="mt-4 flex flex-col gap-4">
        <For each={EXPERIMENTS.filter((e) => e.switchable)}>
          {(exp) => (
            <section>
              <h4 class="text-xs font-semibold uppercase tracking-wider text-ink-400">{exp.title}</h4>
              <div class={`mt-2 grid gap-2 ${exp.variants.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`} role="radiogroup" aria-label={exp.title}>
                <For each={exp.variants}>
                  {(v) => {
                    const p = PREVIEWS[exp.key]?.[v.id];
                    const selected = () => ab.variant(exp.key) === v.id;
                    return (
                      <button
                        role="radio"
                        aria-checked={selected()}
                        onClick={() => ab.choose(exp.key, v.id)}
                        class={`flex flex-col items-start gap-2 rounded-xl p-2.5 text-left transition-all ${
                          selected() ? `ring-2 ${p?.ring ?? 'ring-gold-400'}` : 'opacity-75 ring-1 ring-ink-700 hover:opacity-100'
                        } bg-ink-850`}
                      >
                        <span class={`grid h-12 w-full place-items-center rounded-lg ${p?.bg ?? 'bg-ink-800'}`}>{p?.art()}</span>
                        <span class="leading-tight">
                          <span class="block text-sm font-semibold text-ink-100">{v.label}</span>
                          <Show when={p?.note}>
                            <span class="block text-[11px] text-ink-400">{p!.note}</span>
                          </Show>
                        </span>
                      </button>
                    );
                  }}
                </For>
              </div>
              <Show when={ab.chosen(exp.key) && !ab.testing}>
                <button class="mt-1.5 text-xs text-ink-400 hover:text-gold-300" onClick={() => ab.choose(exp.key, ab.assigned(exp.key))}>
                  Back to the one picked for me ({label(exp.key, ab.assigned(exp.key))})
                </button>
              </Show>
            </section>
          )}
        </For>
      </div>
      <div class="mt-4 border-t border-ink-700 pt-3 text-xs text-ink-400">
        Like one better?{' '}
        <button
          class="font-semibold text-gold-300 hover:underline"
          onClick={() => {
            customize.close();
            feedbackPanel.show();
          }}
        >
          Tell us why
        </button>
      </div>
    </div>
  );
}

/** First-visit callout under the button. */
function Hint() {
  return (
    <div
      role="status"
      class="fixed inset-x-4 top-16 z-50 animate-pop rounded-xl border border-gold-500/60 bg-ink-900 p-3.5 shadow-2xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-12 sm:w-72"
    >
      <span class="absolute -top-1.5 right-5 hidden size-3 rotate-45 border-l border-t border-gold-500/60 bg-ink-900 sm:block" aria-hidden="true" />
      <p class="text-sm font-semibold text-ink-100">Hey! 👋 Make it yours</p>
      <p class="mt-1 text-xs text-ink-300">
        You can change the look of the site here at any time — pick the Hidden King, the Archmother, Deadlock or the classic look, and the slot symbols you like.
      </p>
      <div class="mt-3 flex justify-end gap-2">
        <button class="rounded-lg px-3 py-1.5 text-xs font-semibold text-ink-300 hover:bg-ink-800" onClick={customize.dismissHint}>
          Got it
        </button>
        <button class="btn-dl dl-type rounded-lg bg-gold-500 px-3 py-1.5 text-xs font-semibold text-ink-950 hover:bg-gold-400" onClick={customize.show}>
          Show me
        </button>
      </div>
    </div>
  );
}

export function CustomizeButton() {
  let wrapper!: HTMLDivElement;
  onMount(() => {
    const timer = window.setTimeout(customize.maybeHint, 700);
    const onDown = (e: PointerEvent) => {
      if (customize.open() && !wrapper.contains(e.target as Node)) customize.close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && customize.close();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    onCleanup(() => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    });
  });
  return (
    <div ref={wrapper} class="relative shrink-0">
      <button
        onClick={customize.toggle}
        aria-haspopup="dialog"
        aria-expanded={customize.open()}
        aria-label="Customize the look"
        title="Customize the look"
        class={`dl-type flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold ring-1 transition-colors ${
          customize.open() || customize.hint() ? 'bg-gold-500/15 text-gold-300 ring-gold-500/60' : 'text-ink-200 ring-ink-700 hover:bg-ink-850 hover:text-gold-300'
        }`}
      >
        <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.8-1.9 0-.5-.2-.9-.5-1.3-.3-.3-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3z" />
          <circle cx="7.5" cy="11" r="1.2" fill="currentColor" />
          <circle cx="10.5" cy="7" r="1.2" fill="currentColor" />
          <circle cx="15.5" cy="7.5" r="1.2" fill="currentColor" />
        </svg>
        <span class="hidden lg:inline">Customize</span>
        <Show when={customize.hint()}>
          <span class="absolute -right-1 -top-1 size-2.5 animate-pulse-soft rounded-full bg-gold-400" aria-hidden="true" />
        </Show>
      </button>
      <Show when={customize.open()}>
        <CustomizePanel />
      </Show>
      <Show when={customize.hint() && !customize.open()}>
        <Hint />
      </Show>
    </div>
  );
}
